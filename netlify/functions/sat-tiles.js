// sat-tiles.js — Satellite image renderer
// Uses exact same ERDDAP URL format as ocean-grid.js (proven to work)
// Fetches dense grid JSON, renders as PNG using pure-JS encoder

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, x-bw-token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { dataset = 'noaa20_sst', date, south = 25.0, north = 29.5, west = -82.0, east = -79.0 } = body;

  const DATASETS = {
    noaa20_sst:    { id: 'nesdisVHNnoaa20SSTasNRT',   var: 'analysed_sst', time: 'T12:00:00Z', label: 'NOAA-20 VIIRS SST',    type: 'sst', kelvin: true  },
    snpp_sst:      { id: 'nesdisVHNnoaaSNPPSSTasNRT', var: 'analysed_sst', time: 'T12:00:00Z', label: 'SNPP VIIRS SST',       type: 'sst', kelvin: true  },
    mur_sst:       { id: 'jplMURSST41',               var: 'analysed_sst', time: 'T09:00:00Z', label: 'MUR L4 SST (1km)',     type: 'sst', kelvin: true  },
    noaa20_chl:    { id: 'nesdisVHNnoaa20CHLasNRT',   var: 'chlor_a',      time: 'T12:00:00Z', label: 'NOAA-20 Chlorophyll',  type: 'chl', kelvin: false },
    snpp_chl:      { id: 'nesdisVHNnoaaSNPPCHLasNRT', var: 'chlor_a',      time: 'T12:00:00Z', label: 'SNPP Chlorophyll',     type: 'chl', kelvin: false },
    noaa20_chl_8d: { id: 'nesdisVHNnoaa20CHL8day',    var: 'chlor_a',      time: 'T12:00:00Z', label: 'NOAA-20 CHL 8-day',   type: 'chl', kelvin: false },
  };

  const ds = DATASETS[dataset];
  if (!ds) return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown dataset: ${dataset}` }) };

  const s = parseFloat(south), n = parseFloat(north);
  const w = parseFloat(west),  e = parseFloat(east);

  // Try dates going back 5 days (same pattern as ocean-grid.js)
  const tryDates = [];
  const base = date ? new Date(date + 'T12:00:00Z') : new Date(Date.now() - 86400000);
  for (let i = 0; i <= 5; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    tryDates.push(d.toISOString().slice(0, 10));
  }

  const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

  let rows = null, usedDate = null;

  for (const tryDate of tryDates) {
    // Exact same URL format as ocean-grid.js — proven to work from Netlify
    const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/${ds.id}.json` +
      `?${ds.var}[(${tryDate}${ds.time}):1:(${tryDate}${ds.time})]` +
      `[(${s.toFixed(3)}):1:(${n.toFixed(3)})]` +
      `[(${w.toFixed(3)}):1:(${e.toFixed(3)})]`;

    console.log(`Trying: ${url}`);

    try {
      const res = await Promise.race([
        fetch(url, { headers: { 'User-Agent': 'BlueWaterIntel/1.0' } }),
        timeout(12000)
      ]);

      console.log(`Response: ${res.status} for ${tryDate}`);
      if (!res.ok) continue;

      const data = await res.json();
      const tableRows = data?.table?.rows;
      if (!tableRows || tableRows.length < 4) continue;

      rows = tableRows;
      usedDate = tryDate;
      console.log(`Got ${rows.length} data points for ${tryDate}`);
      break;
    } catch(err) {
      console.log(`Error for ${tryDate}: ${err.message}`);
      continue;
    }
  }

  if (!rows || !usedDate) {
    return { statusCode: 404, headers, body: JSON.stringify({
      error: `No ${ds.label} data available for this area in the last 5 days`,
      dataset, tried: tryDates
    })};
  }

  // ── Parse data into 2D lookup ──────────────────────────────────
  // ERDDAP JSON rows: [time, lat, lng, value]
  const grid = {};
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  let validCount = 0;

  for (const row of rows) {
    const [, lat, lng, val] = row;
    if (val == null || isNaN(val)) continue;
    const laK = parseFloat(lat).toFixed(4);
    const lnK = parseFloat(lng).toFixed(4);
    if (!grid[laK]) grid[laK] = {};
    // Convert Kelvin to Celsius if needed
    grid[laK][lnK] = ds.kelvin && val > 200 ? val - 273.15 : val;
    const la = parseFloat(lat), ln = parseFloat(lng);
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln;
    validCount++;
  }

  // Get sorted unique lats/lngs from actual data
  const uniqLats = Object.keys(grid).map(Number).sort((a,b) => a-b);
  const uniqLngs = [...new Set(Object.values(grid).flatMap(r => Object.keys(r)))].map(Number).sort((a,b) => a-b);

  if (uniqLats.length < 2 || uniqLngs.length < 2) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Insufficient data points returned', validCount }) };
  }

  const H = uniqLats.length, W = uniqLngs.length;

  // ── Color palettes ─────────────────────────────────────────────
  function lerp(a, b, t) { return a + (b - a) * t; }

  function applyPalette(stops, t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < stops.length - 1; i++) {
      if (t <= stops[i+1][0]) {
        const f = (t - stops[i][0]) / (stops[i+1][0] - stops[i][0]);
        return stops[i][1].map((c, j) => Math.round(lerp(c, stops[i+1][1][j], f)));
      }
    }
    return stops[stops.length-1][1];
  }

  // KT_thermal: blue(cold) → cyan → green → yellow → red(warm)
  const SST_STOPS = [
    [0.00, [  0,   0, 160]],
    [0.18, [  0,  80, 220]],
    [0.35, [  0, 180, 200]],
    [0.50, [  0, 220,  80]],
    [0.65, [200, 230,   0]],
    [0.80, [255, 160,   0]],
    [1.00, [255,  20,  20]],
  ];

  // Viridis-style for chlorophyll
  const CHL_STOPS = [
    [0.00, [ 68,   1,  84]],
    [0.20, [ 59,  82, 139]],
    [0.40, [ 33, 145, 140]],
    [0.60, [ 94, 201,  98]],
    [0.80, [253, 231,  37]],
    [1.00, [255, 140,   0]],
  ];

  function sstColor(val_c) {
    const t = (val_c - 20) / 14; // 20-34°C range
    return applyPalette(SST_STOPS, t);
  }

  function chlColor(val) {
    if (val <= 0) return null;
    const t = (Math.log10(Math.max(val, 0.001)) - Math.log10(0.01)) / (Math.log10(20) - Math.log10(0.01));
    return applyPalette(CHL_STOPS, t);
  }

  // ── Build RGBA pixel buffer ─────────────────────────────────────
  const pixels = new Uint8Array(W * H * 4);

  for (let row = 0; row < H; row++) {
    const lat = uniqLats[H - 1 - row]; // flip: image top = north
    const laK = lat.toFixed(4);

    for (let col = 0; col < W; col++) {
      const lng = uniqLngs[col];
      const lnK = lng.toFixed(4);
      const val = grid[laK]?.[lnK];
      const idx = (row * W + col) * 4;

      if (val == null) {
        pixels[idx] = pixels[idx+1] = pixels[idx+2] = pixels[idx+3] = 0; // transparent
        continue;
      }

      const rgb = ds.type === 'sst' ? sstColor(val) : chlColor(val);
      if (!rgb) {
        pixels[idx] = pixels[idx+1] = pixels[idx+2] = pixels[idx+3] = 0;
        continue;
      }

      [pixels[idx], pixels[idx+1], pixels[idx+2]] = rgb;
      pixels[idx+3] = 210;
    }
  }

  // ── Encode PNG ──────────────────────────────────────────────────
  const png = encodePNG(W, H, pixels);
  const base64 = Buffer.from(png).toString('base64');

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      image: `data:image/png;base64,${base64}`,
      dataset, label: ds.label, type: ds.type,
      date: usedDate, requested_date: date || tryDates[0],
      stale_days: tryDates.indexOf(usedDate),
      bbox: { south: minLat, north: maxLat, west: minLng, east: maxLng },
      grid_size: { w: W, h: H },
      total_points: rows.length,
      valid_points: validCount,
      coverage_pct: Math.round(validCount / rows.length * 100),
      // Raw grid for client-side re-render when sliders change
      raw: { lats: uniqLats, lngs: uniqLngs, values: uniqLats.map(la => uniqLngs.map(ln => grid[la.toFixed(4)]?.[ln.toFixed(4)] ?? null)) },
    })
  };
};

// ── Pure JS PNG encoder (zlib from Node built-ins, no canvas needed) ──
function encodePNG(width, height, rgba) {
  const zlib = require('zlib');

  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function chunk(type, data) {
    const b = Buffer.alloc(4 + 4 + data.length + 4);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'ascii');
    data.copy(b, 8);
    b.writeUInt32BE(crc32(b.slice(4, 8 + data.length)), 8 + data.length);
    return b;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter=None
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (1 + width * 4) + 1 + x * 4;
      raw[di] = rgba[si]; raw[di+1] = rgba[si+1];
      raw[di+2] = rgba[si+2]; raw[di+3] = rgba[si+3];
    }
  }

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from(idat)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
