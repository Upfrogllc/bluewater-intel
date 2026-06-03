// currents-erddap.js — Netlify function
// Geostrophic surface-current proxy over NOAA CoastWatch ERDDAP.
//
// Replaces the dead CMEMS GLO12 / MULTIOBS proxies (nrt.cmems-du.eu retired
// March 2024) and the DAP4-parsed-as-JSON OSCAR proxy. These ERDDAP datasets
// speak the same .json dialect as ocean-grid.js / sat-tiles.js.
//
// Returns altimetry-derived GEOSTROPHIC surface currents (m/s) — the dominant
// component at the Gulf Stream edge. No wind-driven (Ekman) or tidal component.
//
// HARDENED FOR NETLIFY'S 10s LIMIT: short per-request timeout, an overall
// function deadline, and a small cell cap so even a huge bbox returns a
// (strided) grid fast instead of hanging.
//
// DATASETS (observation-driven geostrophic, ERDDAP/JSON):
//   blended : noaacwBLENDEDNRTcurrentsDaily @ coastwatch.noaa.gov  (global 0.25°, daily NRT)
//   miami   : miamicurrents @ coastwatch.pfeg.noaa.gov (proven-reliable host) -> cwcgom.aoml.noaa.gov
//
// Query params: minLon,maxLon,minLat,maxLat (bbox, -180/180), date (ISO, optional),
//               dataset ("blended" default | "miami")

const DATASETS = {
  blended: {
    hosts: ['https://coastwatch.noaa.gov/erddap'],
    id: 'noaacwBLENDEDNRTcurrentsDaily',
    uVar: 'u_current', vVar: 'v_current', timeSuffix: 'T00:00:00Z', step: 0.25,
    label: 'NOAA CoastWatch Blended Altimetry Geostrophic',
    confidence: 'high', dataType: 'satellite_observation',
    latMin: -89.875, latMax: 89.875, lonMin: -179.875, lonMax: 179.875,
  },
  miami: {
    hosts: ['https://coastwatch.pfeg.noaa.gov/erddap', 'https://cwcgom.aoml.noaa.gov/erddap'],
    id: 'miamicurrents',
    uVar: 'u_current', vVar: 'v_current', timeSuffix: 'T00:00:00Z', step: 0.2,
    label: 'NOAA AOML Near-Real-Time Geostrophic',
    confidence: 'medium', dataType: 'satellite_observation',
    latMin: -64.7, latMax: 64.7, lonMin: -179.9, lonMax: 179.9,
  },
};

const MAX_CELLS = 1000;            // cap returned grid; stride up on big boxes (keeps it fast)
const LOOKBACK_DAYS = 5;           // NRT availability walk-back
const PER_REQUEST_TIMEOUT_MS = 4000;
const FN_BUDGET_MS = 7500;         // self-terminate before Netlify's 10s kill

const FETCH_HEADERS = { 'User-Agent': 'BlueWaterIntel/2.0', Accept: 'application/json' };

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, x-bw-token',
    'Cache-Control': 'public, max-age=3600',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const p = event.queryStringParameters || {};
  const key = (p.dataset || 'blended').toLowerCase();
  const ds = DATASETS[key];
  if (!ds) return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown dataset: ${key}` }) };

  let minLon = parseFloat(p.minLon), maxLon = parseFloat(p.maxLon);
  let minLat = parseFloat(p.minLat), maxLat = parseFloat(p.maxLat);
  if ([minLon, maxLon, minLat, maxLat].some(isNaN)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'minLon, maxLon, minLat, maxLat are required' }) };
  }

  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];
  const south = clamp(minLat, ds.latMin, ds.latMax);
  const north = clamp(maxLat, ds.latMin, ds.latMax);
  const west  = clamp(minLon, ds.lonMin, ds.lonMax);
  const east  = clamp(maxLon, ds.lonMin, ds.lonMax);
  if (north <= south || east <= west) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bounding box has no overlap with dataset coverage' }) };
  }

  const nLat = Math.max(1, Math.round((north - south) / ds.step));
  const nLon = Math.max(1, Math.round((east - west) / ds.step));
  const stride = nLat * nLon > MAX_CELLS ? Math.ceil(Math.sqrt((nLat * nLon) / MAX_CELLS)) : 1;

  const base = p.date ? new Date(p.date + 'T00:00:00Z') : new Date();
  const tryDates = [];
  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    tryDates.push(new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  const box = { south, north, west, east, stride };
  const deadline = Date.now() + FN_BUDGET_MS;
  const hit = await fetchDataset(ds, box, tryDates, deadline);

  if (!hit) {
    return {
      statusCode: 502, headers,
      body: JSON.stringify({ error: `No ${ds.label} data available`, datasetId: ds.id, hostsTried: ds.hosts }),
    };
  }

  const staleDays = tryDates.indexOf(hit.date);
  return {
    statusCode: 200, headers,
    body: JSON.stringify({
      source: ds.label, datasetId: ds.id, host: hit.host,
      confidence: ds.confidence, dataType: ds.dataType,
      timestamp: hit.date, staleDays,
      resolution: ds.step * stride, stride,
      bbox: { minLon: west, maxLon: east, minLat: south, maxLat: north },
      points: hit.grid.length, grid: hit.grid,
    }),
  };
};

// Try mirror hosts in order; within each, walk dates back for NRT lag.
//  200+data -> success | empty/404 -> earlier date | 5xx/timeout -> next host.
// Bails immediately if the function deadline is exceeded.
async function fetchDataset(ds, box, tryDates, deadline) {
  for (const host of ds.hosts) {
    for (const d of tryDates) {
      if (Date.now() > deadline) return null;
      const t = `${d}${ds.timeSuffix}`;
      const sub = `[(${t})][(${box.south.toFixed(3)}):${box.stride}:(${box.north.toFixed(3)})]` +
                  `[(${box.west.toFixed(3)}):${box.stride}:(${box.east.toFixed(3)})]`;
      const url = `${host}/griddap/${ds.id}.json?${ds.uVar}${sub},${ds.vVar}${sub}`;

      let status = 0, json = null, failed = false;
      try {
        const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
        status = res.status;
        if (res.ok) json = await res.json(); else failed = true;
      } catch (err) {
        failed = true;
        console.warn(`[currents-erddap:${ds.id}] ${host} ${d}: ${err.message}`);
      }

      if (json) {
        const parsed = parseErddapGrid(json, ds);
        if (parsed && parsed.length) return { host, date: d, grid: parsed };
        continue;             // empty for this date -> try earlier date
      }
      if (status === 404) continue;   // no data this date -> earlier date
      if (failed) break;              // host down/slow -> next host
    }
  }
  return null;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ERDDAP .json -> { table:{ columnNames:[time,latitude,longitude,u_current,v_current], rows:[...] } }
function parseErddapGrid(json, ds) {
  const table = json && json.table;
  if (!table || !Array.isArray(table.rows)) return null;
  const cols = table.columnNames || [];
  const iLat = cols.indexOf('latitude'), iLon = cols.indexOf('longitude');
  const iU = cols.indexOf(ds.uVar), iV = cols.indexOf(ds.vVar);
  if (iLat < 0 || iLon < 0 || iU < 0 || iV < 0) return null;

  const out = [];
  for (const r of table.rows) {
    const u = toNum(r[iU]), v = toNum(r[iV]);
    if (u === null || v === null) continue;
    const lat = toNum(r[iLat]), lon = toNum(r[iLon]);
    if (lat === null || lon === null) continue;
    const speed = Math.sqrt(u * u + v * v);
    const dir = (Math.atan2(u, v) * 180) / Math.PI;
    out.push({ lat: round(lat, 3), lon: round(lon, 3), u: round(u, 4), v: round(v, 4),
               speed: round(speed, 4), dir: round((dir + 360) % 360, 1) });
  }
  return out;
}

function toNum(x) { if (x === null || x === undefined) return null; const n = parseFloat(x); return Number.isFinite(n) ? n : null; }
function round(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }
