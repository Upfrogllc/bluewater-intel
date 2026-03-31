const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const payload = JSON.parse(event.body);
    const type = payload.type;

    if (type === 'ping') return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };

    if (type === 'envcheck') {
      const key = process.env.ANTHROPIC_API_KEY || '';
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ keySet: key.length > 0, keyPrefix: key.slice(0, 10) }) };
    }

    // MARINE BATCH — fetch multiple Open-Meteo current points
    if (type === 'marine_batch') {
      const { points } = payload;
      const base = 'https://marine-api.open-meteo.com/v1/marine';
      const results = await Promise.all(points.map(async ({ lat, lng }) => {
        const urls = [
          `${base}?latitude=${lat}&longitude=${lng}&current=ocean_current_velocity,ocean_current_direction,sea_surface_temperature&wind_speed_unit=kn&models=meteofrance_currents`,
          `${base}?latitude=${lat}&longitude=${lng}&current=ocean_current_velocity,ocean_current_direction,sea_surface_temperature&wind_speed_unit=kn`
        ];
        for (const url of urls) {
          try {
            const res = await fetch(url);
            const data = await res.json();
            if (data.error || !data.current || data.current.ocean_current_velocity == null) continue;
            const c = data.current;
            const spd = c.ocean_current_velocity;
            const dir = c.ocean_current_direction ?? 0;
            return { lat, lng, speed_kt: spd, dir_deg: dir, sst_c: c.sea_surface_temperature ?? null,
              u: spd * Math.sin(dir * Math.PI / 180), v: spd * Math.cos(dir * Math.PI / 180) };
          } catch(e) { continue; }
        }
        return null;
      }));
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ results: results.filter(Boolean) }) };
    }

    // MARINE SINGLE — fallback single point
    if (type === 'marine') {
      const { lat, lng } = payload;
      const base = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}&current=ocean_current_velocity,ocean_current_direction,sea_surface_temperature&wind_speed_unit=kn`;
      for (const url of [`${base}&models=meteofrance_currents`, base]) {
        try {
          const res = await fetch(url);
          const data = await res.json();
          if (!data.error && data.current?.ocean_current_velocity != null)
            return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
        } catch(e) {}
      }
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No data' }) };
    }

    // NOAA ENC Nautical Chart — NOAA Chart Display Service WMS
    if (type === 'noaa_chart') {
      const { west, south, east, north, width, height } = payload;
      const base = `?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&FORMAT=image/png&TRANSPARENT=true&CRS=CRS:84&WIDTH=${width}&HEIGHT=${height}&BBOX=${west},${south},${east},${north}`;

      // Try both NOAA WMS endpoints — ENCOnline is the current active service
      const urls = [
        'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/WMSServer'
          + base + '&LAYERS=0,1,2,3,4,5,6,7',
        'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer'
          + base + '&LAYERS=0,1,2,3,4,5,6,7',
      ];

      for (const url of urls) {
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': 'BlueWaterIntel/1.0' },
            signal: AbortSignal.timeout(20000)
          });
          if (!res.ok) { console.log('NOAA chart endpoint failed:', url, res.status); continue; }
          const ct = res.headers.get('content-type') || '';
          if (!ct.includes('image')) {
            const txt = await res.text();
            console.log('NOAA non-image response:', txt.slice(0, 200));
            continue;
          }
          const buf = await res.arrayBuffer();
          const b64 = Buffer.from(buf).toString('base64');
          return { statusCode: 200, headers: CORS, body: JSON.stringify({ image: b64, contentType: ct }) };
        } catch(e) {
          console.log('NOAA chart fetch error:', e.message);
          continue;
        }
      }
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'All NOAA chart endpoints failed' }) };
    }

    // GIBS — proxy NASA satellite imagery
    if (type === 'gibs') {
      const { layer, date, west, south, east, north, width, height } = payload;
      const url = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:4326&WIDTH=${width}&HEIGHT=${height}&BBOX=${west},${south},${east},${north}&TIME=${date}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'BlueWaterIntel/1.0' } });
      if (!res.ok) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: `GIBS ${res.status}` }) };
      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ image: b64, contentType: res.headers.get('content-type') || 'image/png' }) };
    }

    // CMEMS MLD — proxy Copernicus Marine Mixed Layer Depth WMS
    if (type === 'cmems_mld') {
      const { west, south, east, north, width, height } = payload;
      const user = process.env.CMEMS_USER;
      const pass = process.env.CMEMS_PASS;

      if (!user || !pass) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'CMEMS credentials not configured in Netlify env vars (CMEMS_USER, CMEMS_PASS)' }) };
      }

      // CMEMS WMS for Global Physics Analysis — mlotst (mixed layer thickness)
      // Product: GLOBAL_ANALYSISFORECAST_PHY_001_024
      // Dataset: cmems_mod_glo_phy_anfc_0.083deg_P1D-m
      const wmsUrl = `https://nrt.cmems-du.eu/thredds/wms/cmems_mod_glo_phy_anfc_0.083deg_P1D-m`
        + `?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap`
        + `&LAYERS=mlotst`
        + `&STYLES=boxfill/viridis`
        + `&FORMAT=image/png`
        + `&TRANSPARENT=true`
        + `&CRS=CRS:84`
        + `&WIDTH=${width}&HEIGHT=${height}`
        + `&BBOX=${west},${south},${east},${north}`
        + `&COLORSCALERANGE=0,200`
        + `&NUMCOLORBANDS=50`;

      const auth = Buffer.from(`${user}:${pass}`).toString('base64');
      const res = await fetch(wmsUrl, {
        headers: {
          'Authorization': `Basic ${auth}`,
          'User-Agent': 'BlueWaterIntel/1.0'
        }
      });

      if (!res.ok) {
        const txt = await res.text();
        return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: `CMEMS ${res.status}: ${txt.slice(0,200)}` }) };
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('image')) {
        const txt = await res.text();
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: `CMEMS returned non-image: ${txt.slice(0,200)}` }) };
      }

      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ image: b64, contentType }) };
    }

    // CLAUDE — proxy Anthropic AI
    const { type: _t, ...claudeBody } = payload;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(claudeBody),
    });
    const data = await response.json();
    return { statusCode: response.status, headers: CORS, body: JSON.stringify(data) };

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
