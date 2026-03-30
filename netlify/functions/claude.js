const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const payload = JSON.parse(event.body);
    const type = payload.type;

    // PING
    if (type === 'ping') {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
    }

    // ENV CHECK
    if (type === 'envcheck') {
      const key = process.env.ANTHROPIC_API_KEY || '';
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ keySet: key.length > 0, keyPrefix: key.slice(0, 10) }) };
    }

    // MARINE — proxy Open-Meteo currents
    if (type === 'marine') {
      const { lat, lng } = payload;
      const base = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lng}&current=ocean_current_velocity,ocean_current_direction,sea_surface_temperature&wind_speed_unit=kn`;
      const urls = [`${base}&models=meteofrance_currents`, base];
      let lastError = 'Unknown error';
      for (const url of urls) {
        try {
          const res = await fetch(url);
          const data = await res.json();
          if (data.error) { lastError = data.reason || JSON.stringify(data.error); continue; }
          if (data.current?.ocean_current_velocity == null) { lastError = 'No current value'; continue; }
          return { statusCode: 200, headers: CORS, body: JSON.stringify(data) };
        } catch (e) { lastError = e.message; }
      }
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: lastError }) };
    }

    // GIBS — proxy NASA satellite imagery tiles
    if (type === 'gibs') {
      const { layer, date, west, south, east, north, width, height } = payload;
      const url = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:4326&WIDTH=${width}&HEIGHT=${height}&BBOX=${west},${south},${east},${north}&TIME=${date}`;
      
      const res = await fetch(url, {
        headers: { 'User-Agent': 'BlueWaterIntel/1.0 (fishing dashboard; contact@example.com)' }
      });
      
      if (!res.ok) {
        return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: `GIBS HTTP ${res.status}` }) };
      }
      
      // Return as base64 so browser can draw it
      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      const contentType = res.headers.get('content-type') || 'image/png';
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ image: b64, contentType })
      };
    }

    // GEBCO — proxy bathymetry tiles
    if (type === 'gebco') {
      const { west, south, east, north, width, height } = payload;
      const url = `https://wms.gebco.net/mapserv?service=WMS&version=1.1.1&request=GetMap&layers=GEBCO_LATEST&bbox=${west},${south},${east},${north}&width=${width}&height=${height}&srs=EPSG:4326&format=image/png&styles=`;
      const res = await fetch(url);
      if (!res.ok) return { statusCode: res.status, headers: CORS, body: JSON.stringify({ error: `GEBCO ${res.status}` }) };
      const buf = await res.arrayBuffer();
      const b64 = Buffer.from(buf).toString('base64');
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ image: b64 }) };
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
