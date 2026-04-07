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

    // GIBS — proxy NASA satellite imagery, EXACT DATE ONLY
    // No silent fallback to old dates — fishing decisions require current data
    if (type === 'gibs') {
      const { layer, date, west, south, east, north, width, height } = payload;
      const base = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:4326&WIDTH=${width}&HEIGHT=${height}&BBOX=${west},${south},${east},${north}`;

      // PNG magic bytes check: 89 50 4E 47
      function isValidPNG(buf) {
        if (buf.byteLength < 200) return false;
        const b = new Uint8Array(buf.slice(0, 4));
        return b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47;
      }
      function isXMLError(buf) {
        if (buf.byteLength < 10) return true;
        const t = Buffer.from(buf.slice(0, 80)).toString('utf8');
        return t.includes('<?xml') || t.includes('ExceptionReport') || t.includes('<Service');
      }

      // Try the requested date. If satellite hasn't processed today yet,
      // also try yesterday — that's the maximum we'll silently try (1 day tolerance
      // for processing lag only, not stale data fallback).
      // The date picker defaults to 1 day ago anyway, so this handles edge cases
      // where the user manually selects today before the overpass is processed.
      const tryDates = [date];
      const reqDate = new Date(date + 'T12:00:00Z');
      const yesterday = new Date(reqDate); yesterday.setDate(yesterday.getDate() - 1);
      tryDates.push(yesterday.toISOString().split('T')[0]);

      for (const tryDate of tryDates) {
        const url = `${base}&TIME=${tryDate}`;
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'BlueWaterIntel/1.0' } });
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          if (isXMLError(buf)) {
            return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Layer not found: ${layer}` }) };
          }
          if (!isValidPNG(buf)) continue;
          // Flag if we had to use yesterday so UI can inform the user
          const usedYesterday = tryDate !== date;
          return {
            statusCode: 200, headers: CORS,
            body: JSON.stringify({
              image: Buffer.from(buf).toString('base64'),
              contentType: 'image/png',
              date: tryDate,
              lag: usedYesterday ? "~24hr processing lag — yesterday pass" : null
            })
          };
        } catch(e) { continue; }
      }
      // No data for requested date — tell the user clearly
      return {
        statusCode: 404, headers: CORS,
        body: JSON.stringify({ error: `No satellite pass for ${date} — cloud cover or not yet processed. Try an earlier date.` })
      };
    }

    // CoastWatch ERDDAP WMS — 300m native Sentinel-3 OLCI chlorophyll
    // Sector NH covers 14.88-30.26N (Florida + Gulf Stream) for both S-3A and S-3B
    // Dataset IDs: noaacwS3AOLCIchlaSectorNHDaily, noaacwS3BOLCIchlaSectorNHDaily
    if (type === 'coastwatch') {
      const { dataset, variable, date, west, south, east, north, width, height } = payload;
      // ERDDAP WMS endpoint for the dataset
      const wmsBase = `https://coastwatch.noaa.gov/erddap/wms/${dataset}/request`;

      function isValidPNG(buf) {
        if (buf.byteLength < 200) return false;
        const b = new Uint8Array(buf.slice(0, 4));
        return b[0]===0x89 && b[1]===0x50 && b[2]===0x4E && b[3]===0x47;
      }

      // CoastWatch ERDDAP WMS — S-3A/S-3B can have 1-3 day processing lag
      // Try requested date then up to 5 days back
      const tryDates = [date];
      for(let back=1; back<=5; back++){
        const d = new Date(date + 'T12:00:00Z');
        d.setDate(d.getDate() - back);
        tryDates.push(d.toISOString().split('T')[0]);
      }

      for (const tryDate of tryDates) {
        const timeStr = tryDate + 'T12:00:00Z';
        // ERDDAP WMS GetMap: layer name is "datasetID:variableName"
        const params = new URLSearchParams({
          service: 'WMS',
          version: '1.3.0',
          request: 'GetMap',
          layers: `${dataset}:${variable}`,
          styles: '',
          crs: 'EPSG:4326',
          bbox: `${south},${west},${north},${east}`,  // WMS 1.3 lat,lon order
          width: width,
          height: height,
          format: 'image/png',
          transparent: 'TRUE',
          time: timeStr,
          elevation: payload.elevation || '0.0'
        });
        const url = `${wmsBase}?${params}`;
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'BlueWaterIntel/1.0' } });
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          if (!isValidPNG(buf)) continue;
          const b64 = Buffer.from(buf).toString('base64');
          const usedYesterday = tryDate !== date;
          return {
            statusCode: 200, headers: CORS,
            body: JSON.stringify({
              image: b64, contentType: 'image/png', date: tryDate,
              lag: usedYesterday ? '~24hr processing lag' : null,
              source: 'CoastWatch ERDDAP · 300m native OLCI'
            })
          };
        } catch(e) { continue; }
      }
      return {
        statusCode: 404, headers: CORS,
        body: JSON.stringify({ error: `No CoastWatch data for ${date} — cloud cover or not yet processed` })
      };
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

    // ── CMEMS Ocean Currents ─────────────────────────────────────────────────
    if (type === 'cmems_currents') {
      const { dataset, west, south, east, north, date } = payload;
      const user = process.env.CMEMS_USER;
      const pass = process.env.CMEMS_PASS;
      if (!user || !pass) {
        return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'CMEMS credentials not set (add CMEMS_USER and CMEMS_PASS to Netlify env vars)' }) };
      }

      const auth = Buffer.from(`${user}:${pass}`).toString('base64');
      const latStep = 0.2, lngStep = 0.2;
      const lats = [], lngs = [];
      for (let la = parseFloat(south) + latStep/2; la < parseFloat(north); la += latStep) {
        if (lats.length < 10) lats.push(parseFloat(la.toFixed(3)));
      }
      for (let ln = parseFloat(west) + lngStep/2; ln < parseFloat(east); ln += lngStep) {
        if (lngs.length < 10) lngs.push(parseFloat(ln.toFixed(3)));
      }

      // Use CMEMS OPeNDAP to get u/v current components
      const results = [];
      const promises = [];
      for (const la of lats) {
        for (const ln of lngs) {
          promises.push((async () => {
            try {
              // CMEMS nrt product — use subset API
              const subsetUrl = `https://nrt.cmems-du.eu/motu-web/Motu?action=productdownload` +
                `&service=GLOBAL_ANALYSISFORECAST_PHY_001_024-TDS` +
                `&product=${dataset}` +
                `&x_lo=${(ln-0.1).toFixed(3)}&x_hi=${(ln+0.1).toFixed(3)}` +
                `&y_lo=${(la-0.1).toFixed(3)}&y_hi=${(la+0.1).toFixed(3)}` +
                `&t_lo=${date}%2000:00:00&t_hi=${date}%2023:59:59` +
                `&depth_lo=0.493&depth_hi=0.494` +
                `&variable=uo&variable=vo&out_fmt=json&mode=console`;

              // Simpler: use the CMEMS WMS GetFeatureInfo
              const wmsUrl = `https://nrt.cmems-du.eu/thredds/wms/${dataset}`;
              const pU = new URLSearchParams({
                SERVICE:'WMS', VERSION:'1.1.1', REQUEST:'GetFeatureInfo',
                LAYERS:'uo', QUERY_LAYERS:'uo', SRS:'EPSG:4326',
                FORMAT:'image/png', INFO_FORMAT:'text/plain',
                BBOX:`${ln-0.15},${la-0.15},${ln+0.15},${la+0.15}`,
                WIDTH:'10', HEIGHT:'10', X:'5', Y:'5',
                TIME:`${date}T00:00:00Z`, ELEVATION:'-0.5'
              });
              const pV = new URLSearchParams({...Object.fromEntries(pU.entries()), LAYERS:'vo', QUERY_LAYERS:'vo'});

              const [ru, rv] = await Promise.all([
                fetch(`${wmsUrl}?${pU}`, { headers:{ Authorization:`Basic ${auth}` } }),
                fetch(`${wmsUrl}?${pV}`, { headers:{ Authorization:`Basic ${auth}` } })
              ]);

              const [tu, tv] = await Promise.all([ru.text(), rv.text()]);
              const parseVal = t => { const m=t.match(/[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?/); return m?parseFloat(m[0]):null; };
              const u=parseVal(tu), v=parseVal(tv);

              if (u!==null && v!==null && !isNaN(u) && !isNaN(v)) {
                const spd = Math.sqrt(u*u+v*v)*1.944;
                const dir = (Math.atan2(u,v)*180/Math.PI+360)%360;
                results.push({ lat:la, lng:ln, speed_kt:spd, dir_deg:dir, u:u*1.944, v:v*1.944, sst_c:null });
              }
            } catch(e) {}
          })());
        }
      }
      await Promise.allSettled(promises);

      if (!results.length) {
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error:'CMEMS returned no data — check credentials or try Open-Meteo', points:[] }) };
      }
      return { statusCode:200, headers:CORS, body: JSON.stringify({ points:results, count:results.length }) };
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
