// ocean-grid.js — Netlify serverless function
// Fetches chlorophyll + SST from CoastWatch ERDDAP for a grid of points

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { points, date } = body;
  if (!points?.length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No points' }) };

  // Try yesterday first (NRT has ~12-24hr lag), fall back up to 4 days
  const tryDates = [];
  for (let i = 1; i <= 4; i++) {
    const d = new Date(Date.now() - i * 86400000);
    tryDates.push(d.toISOString().slice(0, 10));
  }

  // Bounding box with padding
  const lats = points.map(p => p[0]);
  const lngs = points.map(p => p[1]);
  const south = (Math.min(...lats) - 0.15).toFixed(3);
  const north = (Math.max(...lats) + 0.15).toFixed(3);
  const west  = (Math.min(...lngs) - 0.15).toFixed(3);
  const east  = (Math.max(...lngs) + 0.15).toFixed(3);

  const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

  // ── Chlorophyll datasets to try in order ──
  const CHL_DATASETS = [
    { id: 'nesdisVHNnoaa20CHLasNRT',   var: 'chlor_a', time: 'T12:00:00Z', label: 'NOAA-20 VIIRS NRT' },
    { id: 'nesdisVHNnoaaSNPPCHLasNRT', var: 'chlor_a', time: 'T12:00:00Z', label: 'SNPP VIIRS NRT' },
    { id: 'nesdisVHNnoaa20CHL8day',    var: 'chlor_a', time: 'T12:00:00Z', label: 'NOAA-20 8-day composite' },
  ];

  let chlGrid = null, chlSource = null;
  for (const ds of CHL_DATASETS) {
    if (chlGrid) break;
    for (const d of tryDates) {
      if (chlGrid) break;
      const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/${ds.id}.json` +
        `?${ds.var}[(${d}${ds.time}):1:(${d}${ds.time})][(${south}):1:(${north})][(${west}):1:(${east})]`;
      try {
        const res = await Promise.race([fetch(url), timeout(10000)]);
        if (!res.ok) continue;
        const json = await res.json();
        const parsed = json?.table?.rows ? parseSatTable(json.table, ds.var) : null;
        if (parsed?.length > 0) { chlGrid = parsed; chlSource = `${ds.label} (${d})`; }
      } catch(e) {}
    }
  }

  // ── SST datasets to try in order ──
  const SST_DATASETS = [
    { id: 'jplMURSST41', var: 'analysed_sst', time: 'T09:00:00Z', label: 'MUR L4 1km' },
  ];

  let sstGrid = null, sstSource = null;
  for (const ds of SST_DATASETS) {
    if (sstGrid) break;
    for (const d of tryDates.slice(0, 3)) {
      if (sstGrid) break;
      const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/${ds.id}.json` +
        `?${ds.var}[(${d}${ds.time}):1:(${d}${ds.time})][(${south}):1:(${north})][(${west}):1:(${east})]`;
      try {
        const res = await Promise.race([fetch(url), timeout(10000)]);
        if (!res.ok) continue;
        const json = await res.json();
        const parsed = json?.table?.rows ? parseSatTable(json.table, ds.var) : null;
        if (parsed?.length > 0) { sstGrid = parsed; sstSource = `${ds.label} (${d})`; }
      } catch(e) {}
    }
  }

  // Build per-point results
  const results = points.map(([lat, lng]) => {
    const pt = { lat, lng, chl_mg_m3: null, sst_c: null, sst_f: null };
    if (chlGrid?.length) {
      const v = nearestValue(chlGrid, lat, lng);
      if (v !== null && v > 0 && v < 100) pt.chl_mg_m3 = parseFloat(v.toFixed(4));
    }
    if (sstGrid?.length) {
      const v = nearestValue(sstGrid, lat, lng);
      if (v !== null && v > -2 && v < 40) {
        pt.sst_c = parseFloat(v.toFixed(2));
        pt.sst_f = parseFloat((v * 9/5 + 32).toFixed(1));
      }
    }
    return pt;
  });

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      chl_source: chlSource || null,
      sst_source: sstSource || null,
      chl_pts: chlGrid?.length || 0,
      sst_pts: sstGrid?.length || 0,
      points: results
    })
  };
};

function parseSatTable(table, varName) {
  const cols = table.columnNames;
  const iLat = cols.indexOf('latitude');
  const iLng = cols.indexOf('longitude');
  const iVal = cols.findIndex(c => c === varName || c.toLowerCase().includes(varName.split('_')[0]));
  if (iLat < 0 || iLng < 0 || iVal < 0) return null;
  return table.rows
    .filter(r => r[iVal] !== null && r[iVal] !== undefined && !isNaN(r[iVal]))
    .map(r => ({ lat: r[iLat], lng: r[iLng], val: parseFloat(r[iVal]) }))
    .filter(p => isFinite(p.val));
}

function nearestValue(grid, lat, lng) {
  if (!grid?.length) return null;
  const nearby = grid
    .map(p => ({ ...p, dist: Math.hypot(p.lat - lat, p.lng - lng) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);
  if (!nearby.length || nearby[0].dist > 0.75) return null;
  if (nearby[0].dist < 0.005) return nearby[0].val;
  const wSum = nearby.reduce((s, p) => s + 1/p.dist, 0);
  return nearby.reduce((s, p) => s + p.val/p.dist, 0) / wSum;
}
