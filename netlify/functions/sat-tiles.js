// sat-tiles.js — Satellite image renderer
// Fetches raw grid data from CoastWatch ERDDAP (JSON, proven to work)
// Renders it as a colored PNG image server-side using raw pixel manipulation
// Returns base64 PNG for display/overlay

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

  const { dataset, date, south = 25.0, north = 29.5, west = -82.0, east = -79.0 } = body;
  if (!dataset || !date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'dataset and date required' }) };

  const DATASETS = {
    noaa20_sst:    { erddap: 'nesdisVHNnoaa20SSTasNRT',   var: 'analysed_sst', label: 'NOAA-20 VIIRS SST',     type: 'sst', offset: 273.15 },
    snpp_sst:      { erddap: 'nesdisVHNnoaaSNPPSSTasNRT', var: 'analysed_sst', label: 'SNPP VIIRS SST',        type: 'sst', offset: 273.15 },
    mur_sst:       { erddap: 'jplMURSST41',                var: 'analysed_sst', label: 'MUR L4 SST (1km)',     type: 'sst', offset: 273.15 },
    noaa20_chl:    { erddap: 'nesdisVHNnoaa20CHLasNRT',   var: 'chlor_a',      label: 'NOAA-20 Chlorophyll',  type: 'chl', offset: 0 },
    snpp_chl:      { erddap: 'nesdisVHNnoaaSNPPCHLasNRT', var: 'chlor_a',      label: 'SNPP Chlorophyll',     type: 'chl', offset: 0 },
    noaa20_chl_8d: { erddap: 'nesdisVHNnoaa20CHL8day',    var: 'chlor_a',      label: 'NOAA-20 CHL 8-day',   type: 'chl', offset: 0 },
  };

  const ds = DATASETS[dataset];
  if (!ds) return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown dataset: ${dataset}` }) };

  const s = parseFloat(south), n = parseFloat(north);
  const w = parseFloat(west),  e = parseFloat(east);

  // Grid resolution — keep points manageable
  const step = ds.type === 'sst' ? 0.04 : 0.05; // ~4-5km
  const lats = [], lngs = [];
  for (let la = s; la <= n; la = Math.round((la + step) * 1000) / 1000) lats.push(la);
  for (let ln = w; ln <= e; ln = Math.round((ln + step) * 1000) / 1000) lngs.push(ln);

  if (lats.length < 2 || lngs.length < 2) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bbox too small' }) };
  }

  const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

  // Try dates going back up to 5 days
  const tryDates = [];
  const base = new Date(date + 'T12:00:00Z');
  for (let i = 0; i <= 5; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    tryDates.push(d.toISOString().slice(0, 10));
  }

  let grid = null, usedDate = null;

  for (const tryDate of tryDates) {
    const latStr = `(${s.toFixed(3)}):(${step.toFixed(3)}):(${n.toFixed(3)})`;
    const lngStr = `(${w.toFixed(3)}):(${step.toFixed(3)}):(${e.toFixed(3)})`;
    const timeStr = `${tryDate}T12:00:00Z`;

    const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/${ds.erddap}.json` +
      `?${ds.var}%5B(${timeStr})%5D%5B${latStr}%5D%5B${lngStr}%5D`;

    try {
      const res = await Promise.race([
        fetch(url, { headers: { 'User-Agent': 'BlueWaterIntel/1.0' } }),
        timeout(10000)
      ]);
      if (!res.ok) continue;

      const data = await res.json();
      const rows = data?.table?.rows;
      if (!rows || rows.length < 10) continue;

      // Build a 2D grid: rows are [time, lat, lng, value]
      grid = {};
      for (const row of rows) {
        const [, lat, lng, val] = row;
        if (val == null) continue;
        const la = parseFloat(lat).toFixed(3);
        const ln = parseFloat(lng).toFixed(3);
        if (!grid[la]) grid[la] = {};
        // Convert Kelvin to Celsius if needed
        grid[la][ln] = ds.offset > 0 ? val - ds.offset : val;
      }
      usedDate = tryDate;
      break;
    } catch(e) {
      continue;
    }
  }

  if (!grid || !usedDate) {
    return { statusCode: 404, headers, body: JSON.stringify({
      error: `No ${ds.label} data found in the last 5 days for this area`,
      dataset, tried: tryDates
    })};
  }

  // ── Render grid to PNG using raw pixel buffer ──────────────────
  const W = lngs.length, H = lats.length;

  // Color palettes
  function sstColor(val_c) {
    // KT_thermal: blue(cold) -> cyan -> green -> yellow -> red(warm)
    // Range: 18-32°C for SE Florida
    const t = Math.max(0, Math.min(1, (val_c - 18) / 14));
    const stops = [
      [0,   [  0,   0, 128]], // deep blue
      [0.2, [  0, 100, 220]], // blue
      [0.4, [  0, 200, 200]], // cyan
      [0.55,[  0, 200,  50]], // green
      [0.7, [200, 220,   0]], // yellow-green
      [0.82,[255, 180,   0]], // orange
      [1.0, [255,  20,  20]], // red
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t <= stops[i+1][0]) {
        const f = (t - stops[i][0]) / (stops[i+1][0] - stops[i][0]);
        return stops[i][1].map((c, j) => Math.round(c + f * (stops[i+1][1][j] - c)));
      }
    }
    return [255, 20, 20];
  }

  function chlColor(val) {
    // Log scale: 0.01 - 10 mg/m³
    // Blue(oligotrophic) -> green(moderate) -> yellow-green -> yellow(productive)
    if (val <= 0) return null; // transparent
    const t = Math.max(0, Math.min(1, (Math.log10(val) - Math.log10(0.01)) / (Math.log10(10) - Math.log10(0.01))));
    const stops = [
      [0,   [ 68,   1, 84]],  // dark purple (very low)
      [0.2, [ 59,  82, 139]], // blue
      [0.4, [ 33, 145, 140]], // teal
      [0.6, [ 94, 201,  98]], // green
      [0.8, [253, 231,  37]], // yellow
      [1.0, [255, 150,   0]], // orange (very high)
    ];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t <= stops[i+1][0]) {
        const f = (t - stops[i][0]) / (stops[i+1][0] - stops[i][0]);
        return stops[i][1].map((c, j) => Math.round(c + f * (stops[i+1][1][j] - c)));
      }
    }
    return [255, 150, 0];
  }

  // Build RGBA pixel buffer (4 bytes per pixel)
  const pixels = new Uint8Array(W * H * 4);

  for (let row = 0; row < H; row++) {
    const lat = lats[H - 1 - row]; // flip Y (image top = north)
    const laKey = lat.toFixed(3);

    for (let col = 0; col < W; col++) {
      const lng = lngs[col];
      const lnKey = lng.toFixed(3);
      const val = grid[laKey]?.[lnKey];
      const idx = (row * W + col) * 4;

      if (val == null || val < -100) {
        // No data — transparent black
        pixels[idx] = pixels[idx+1] = pixels[idx+2] = 0;
        pixels[idx+3] = 0;
      } else {
        const rgb = ds.type === 'sst' ? sstColor(val) : chlColor(val);
        if (!rgb) {
          pixels[idx] = pixels[idx+1] = pixels[idx+2] = 0;
          pixels[idx+3] = 0;
        } else {
          [pixels[idx], pixels[idx+1], pixels[idx+2]] = rgb;
          pixels[idx+3] = 220; // slight transparency
        }
      }
    }
  }

  // Encode as PNG using pure JS (no canvas dependency)
  const png = encodePNG(W, H, pixels);
  const base64 = Buffer.from(png).toString('base64');

  // Count valid pixels
  let validCount = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) validCount++;
  const coverage = Math.round(validCount / (W * H) * 100);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      image: `data:image/png;base64,${base64}`,
      dataset, label: ds.label, type: ds.type,
      date: usedDate, requested_date: date,
      stale_days: tryDates.indexOf(usedDate),
      bbox: { south: s, north: n, west: w, east: e },
      grid_size: { w: W, h: H },
      coverage_pct: coverage,
    })
  };
};

// ── Pure JS PNG encoder (no dependencies) ─────────────────────────
function encodePNG(width, height, rgba) {
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[i] = c;
      }
      return t;
    })());
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function adler32(buf) {
    let a = 1, b = 0;
    for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
    return (b << 16) | a;
  }

  function deflate(data) {
    // Use zlib deflate via Node.js built-in
    const zlib = require('zlib');
    return zlib.deflateSync(Buffer.from(data), { level: 6 });
  }

  function chunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(4 + 4 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 'ascii');
    data.copy(buf, 8);
    const crc = crc32(buf.slice(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = ihdr[11] = ihdr[12] = 0;

  // Raw image data with filter bytes
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // None filter
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = y * (1 + width * 4) + 1 + x * 4;
      raw[di]     = rgba[si];
      raw[di + 1] = rgba[si + 1];
      raw[di + 2] = rgba[si + 2];
      raw[di + 3] = rgba[si + 3];
    }
  }

  const idat = deflate(raw);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from(idat)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
