// ocean-grid.js — Netlify serverless function
// Fetches chlorophyll + SST from CoastWatch ERDDAP for a grid of points
// Called by the client scoring engine with: { points: [[lat,lng],...], date: 'YYYY-MM-DD' }

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { points, date } = body;
  if (!points || !points.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No points provided' }) };

  // Use requested date or yesterday (satellite has ~1 day lag)
  const d = date ? new Date(date) : new Date(Date.now() - 86400000);
  const dateStr = d.toISOString().slice(0, 10);

  // Build bounding box from points
  const lats = points.map(p => p[0]);
  const lngs = points.map(p => p[1]);
  const south = (Math.min(...lats) - 0.1).toFixed(4);
  const north = (Math.max(...lats) + 0.1).toFixed(4);
  const west  = (Math.min(...lngs) - 0.1).toFixed(4);
  const east  = (Math.max(...lngs) + 0.1).toFixed(4);

  const results = [];

  // ── Fetch Chlorophyll from CoastWatch ERDDAP (NOAA-20 VIIRS, 750m) ──
  // Dataset: nesdisVHNnoaaSNPPCHLasNRT  (daily composite)
  const chlUrl = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/nesdisVHNnoaaSNPPCHLasNRT.json` +
    `?chlor_a[(${dateStr}T12:00:00Z):1:(${dateStr}T12:00:00Z)]` +
    `[(${south}):1:(${north})]` +
    `[(${west}):1:(${east})]`;

  // ── Fetch SST from MUR L4 GHRSST (1km, daily) ──
  const sstUrl = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/jplMURSST41.json` +
    `?analysed_sst[(${dateStr}T09:00:00Z):1:(${dateStr}T09:00:00Z)]` +
    `[(${south}):1:(${north})]` +
    `[(${west}):1:(${east})]`;

  let chlGrid = null, sstGrid = null;

  // Fetch both in parallel with timeout
  const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

  const [chlResult, sstResult] = await Promise.allSettled([
    Promise.race([fetch(chlUrl).then(r => r.json()), timeout(12000)]),
    Promise.race([fetch(sstUrl).then(r => r.json()), timeout(12000)])
  ]);

  // Parse chlorophyll grid
  if (chlResult.status === 'fulfilled' && chlResult.value?.table?.rows) {
    chlGrid = parseChlTable(chlResult.value.table);
  }

  // Parse SST grid
  if (sstResult.status === 'fulfilled' && sstResult.value?.table?.rows) {
    sstGrid = parseSSTTable(sstResult.value.table);
  }

  // For each requested point, find nearest satellite values
  for (const [lat, lng] of points) {
    const pt = { lat, lng, chl_mg_m3: null, sst_c: null, sst_f: null };

    if (chlGrid) {
      const nearest = nearestValue(chlGrid, lat, lng);
      if (nearest !== null) pt.chl_mg_m3 = parseFloat(nearest.toFixed(4));
    }

    if (sstGrid) {
      const nearest = nearestValue(sstGrid, lat, lng);
      if (nearest !== null) {
        pt.sst_c = parseFloat(nearest.toFixed(2));
        pt.sst_f = parseFloat((nearest * 9/5 + 32).toFixed(1));
      }
    }

    results.push(pt);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      date: dateStr,
      chl_source: chlGrid ? 'NOAA-20 VIIRS 750m daily' : null,
      sst_source: sstGrid ? 'MUR L4 GHRSST 1km daily' : null,
      points: results
    })
  };
};

// Parse ERDDAP JSON table into lat/lng/value lookup array
function parseChlTable(table) {
  const cols = table.columnNames;
  const iLat = cols.indexOf('latitude');
  const iLng = cols.indexOf('longitude');
  const iVal = cols.findIndex(c => c.includes('chlor'));
  if (iLat < 0 || iLng < 0 || iVal < 0) return null;
  return table.rows
    .filter(r => r[iVal] !== null && r[iVal] > 0)
    .map(r => ({ lat: r[iLat], lng: r[iLng], val: r[iVal] }));
}

function parseSSTTable(table) {
  const cols = table.columnNames;
  const iLat = cols.indexOf('latitude');
  const iLng = cols.indexOf('longitude');
  const iVal = cols.findIndex(c => c.includes('sst') || c.includes('analysed'));
  if (iLat < 0 || iLng < 0 || iVal < 0) return null;
  return table.rows
    .filter(r => r[iVal] !== null)
    .map(r => ({ lat: r[iLat], lng: r[iLng], val: r[iVal] }));
}

// Inverse-distance-weighted nearest value from a sparse grid
function nearestValue(grid, lat, lng) {
  if (!grid || !grid.length) return null;
  const nearby = grid
    .map(p => ({ ...p, dist: Math.hypot(p.lat - lat, p.lng - lng) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);
  if (!nearby.length || nearby[0].dist > 0.5) return null;
  if (nearby[0].dist < 0.005) return nearby[0].val;
  const w = nearby.reduce((s, p) => s + 1/p.dist, 0);
  return nearby.reduce((s, p) => s + p.val/p.dist, 0) / w;
}
