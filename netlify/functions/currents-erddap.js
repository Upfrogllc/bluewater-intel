// currents-erddap.js — Netlify function
// Geostrophic surface-current proxy over NOAA CoastWatch ERDDAP.
//
// WHY THIS EXISTS:
//   The old CMEMS GLO12 / MULTIOBS proxies pointed at nrt.cmems-du.eu/thredds,
//   which Copernicus retired in March 2024. The old OSCAR proxy requested DAP4
//   binary and parsed it as JSON. All three were dead. This replaces them with
//   ERDDAP datasets that speak the exact same .json dialect as ocean-grid.js /
//   sat-tiles.js — proven to work from Netlify.
//
// WHAT IT RETURNS:
//   Altimetry-derived GEOSTROPHIC surface currents (m/s). This is the dominant
//   current component at the Gulf Stream edge. It does NOT include wind-driven
//   (Ekman) or tidal components. Resolution ~0.2-0.25° (~20-25 km).
//
// RESILIENCE:
//   NOAA ERDDAP hosts throw transient 503s under load. Each logical dataset can
//   therefore list MULTIPLE mirror hosts; we try them in order, bail off a busy
//   host fast (one short retry, then next host) instead of spinning through
//   every date on a server that's already telling us it's overloaded. A 404 is
//   treated as "no data for that day" and walks the date back; a 5xx/timeout is
//   treated as "this host is down" and moves to the next host.
//
// DATASETS (all observation-driven geostrophic, all ERDDAP/JSON):
//   blended : noaacwBLENDEDNRTcurrentsDaily @ coastwatch.noaa.gov  (global 0.25°, daily NRT, best product)
//   miami   : miamicurrents @ coastwatch.pfeg.noaa.gov (PROVEN reliable host) -> cwcgom.aoml.noaa.gov (origin)
//
// Query params:
//   minLon, maxLon, minLat, maxLat  — bounding box (decimal degrees, -180/180)
//   date                            — ISO date (optional, defaults to today; we walk back for NRT lag)
//   dataset                         — "blended" (default) | "miami"

const DATASETS = {
  blended: {
    hosts: ['https://coastwatch.noaa.gov/erddap'],
    id: 'noaacwBLENDEDNRTcurrentsDaily',
    uVar: 'u_current',
    vVar: 'v_current',
    timeSuffix: 'T00:00:00Z',
    step: 0.25, // grid resolution in degrees (used only for stride math)
    label: 'NOAA CoastWatch Blended Altimetry Geostrophic',
    confidence: 'high',
    dataType: 'satellite_observation',
    latMin: -89.875, latMax: 89.875,
    lonMin: -179.875, lonMax: 179.875,
  },
  miami: {
    // pfeg FIRST — same host your SST/CHL functions use reliably. cwcgom is the origin mirror.
    hosts: ['https://coastwatch.pfeg.noaa.gov/erddap', 'https://cwcgom.aoml.noaa.gov/erddap'],
    id: 'miamicurrents',
    uVar: 'u_current',
    vVar: 'v_current',
    timeSuffix: 'T00:00:00Z',
    step: 0.2,
    label: 'NOAA AOML Near-Real-Time Geostrophic',
    confidence: 'medium',
    dataType: 'satellite_observation',
    latMin: -64.7, latMax: 64.7,
    lonMin: -179.9, lonMax: 179.9,
  },
};

const MAX_CELLS = 3000;   // cap returned grid size; frontend subsamples anyway
const LOOKBACK_DAYS = 7;  // how far back to walk for NRT availability
const PER_REQUEST_TIMEOUT_MS = 9000;
const RETRY_BACKOFF_MS = 400;

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

  let minLon = parseFloat(p.minLon);
  let maxLon = parseFloat(p.maxLon);
  let minLat = parseFloat(p.minLat);
  let maxLat = parseFloat(p.maxLat);
  if ([minLon, maxLon, minLat, maxLat].some(isNaN)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'minLon, maxLon, minLat, maxLat are required' }) };
  }

  // Normalise ordering and clamp to dataset coverage
  if (minLat > maxLat) [minLat, maxLat] = [maxLat, minLat];
  if (minLon > maxLon) [minLon, maxLon] = [maxLon, minLon];
  const south = clamp(minLat, ds.latMin, ds.latMax);
  const north = clamp(maxLat, ds.latMin, ds.latMax);
  const west  = clamp(minLon, ds.lonMin, ds.lonMax);
  const east  = clamp(maxLon, ds.lonMin, ds.lonMax);
  if (north <= south || east <= west) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Bounding box has no overlap with dataset coverage' }) };
  }

  // Stride so the returned grid stays under MAX_CELLS
  const nLat = Math.max(1, Math.round((north - south) / ds.step));
  const nLon = Math.max(1, Math.round((east - west) / ds.step));
  const stride = nLat * nLon > MAX_CELLS ? Math.ceil(Math.sqrt((nLat * nLon) / MAX_CELLS)) : 1;

  // Candidate dates: requested (or today) walking back for NRT lag
  const base = p.date ? new Date(p.date + 'T00:00:00Z') : new Date();
  const tryDates = [];
  for (let i = 0; i <= LOOKBACK_DAYS; i++) {
    tryDates.push(new Date(base.getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  const box = { south, north, west, east, stride };
  const hit = await fetchDataset(ds, box, tryDates);

  if (!hit) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: `No ${ds.label} data available (all hosts/dates exhausted)`,
        datasetId: ds.id,
        hostsTried: ds.hosts,
        datesTried: tryDates,
      }),
    };
  }

  const staleDays = tryDates.indexOf(hit.date);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      source: ds.label,
      datasetId: ds.id,
      host: hit.host,
      confidence: ds.confidence,
      dataType: ds.dataType,
      timestamp: hit.date,
      staleDays,
      resolution: ds.step * stride,
      stride,
      bbox: { minLon: west, maxLon: east, minLat: south, maxLat: north },
      points: hit.grid.length,
      grid: hit.grid,
    }),
  };
};

// ---------------------------------------------------------------------------
// Fetch one dataset, trying mirror hosts in order, dates within each host.
//  - 200 + data  -> success
//  - empty parse -> treat as no-data-for-date, walk date back
//  - 404         -> no data for that date, walk date back
//  - 5xx/timeout -> host is down; one short retry, then move to next host
// ---------------------------------------------------------------------------
async function fetchDataset(ds, box, tryDates) {
  for (const host of ds.hosts) {
    let retriedThisHost = false;

    for (let di = 0; di < tryDates.length; di++) {
      const d = tryDates[di];
      const t = `${d}${ds.timeSuffix}`;
      // raw brackets/parens — same un-encoded form as ocean-grid.js (proven on Netlify)
      const sub = `[(${t})][(${box.south.toFixed(3)}):${box.stride}:(${box.north.toFixed(3)})]` +
                  `[(${box.west.toFixed(3)}):${box.stride}:(${box.east.toFixed(3)})]`;
      const url = `${host}/griddap/${ds.id}.json?${ds.uVar}${sub},${ds.vVar}${sub}`;

      let status = 0, json = null, failed = false;
      try {
        const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS) });
        status = res.status;
        if (res.ok) json = await res.json();
        else failed = true;
      } catch (err) {
        failed = true; // timeout / network
        console.warn(`[currents-erddap:${ds.id}] ${host} ${d} threw: ${err.message}`);
      }

      if (json) {
        const parsed = parseErddapGrid(json, ds);
        if (parsed && parsed.length) return { host, date: d, grid: parsed };
        continue; // empty grid for this date -> try an earlier date
      }

      if (status === 404) continue; // genuine "no data this day" -> walk date back

      // 5xx / network / timeout = host availability problem
      if (failed && !retriedThisHost) {
        retriedThisHost = true;
        await sleep(RETRY_BACKOFF_MS);
        di--;            // retry the SAME date once
        continue;
      }
      if (failed) break; // already retried this host -> give up on it, try next host
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ERDDAP .json -> { table: { columnNames:[...], rows:[[...],...] } }
// For u_current + v_current the columns are: time, latitude, longitude, u_current, v_current.
function parseErddapGrid(json, ds) {
  const table = json && json.table;
  if (!table || !Array.isArray(table.rows)) return null;

  const cols = table.columnNames || [];
  const iLat = cols.indexOf('latitude');
  const iLon = cols.indexOf('longitude');
  const iU   = cols.indexOf(ds.uVar);
  const iV   = cols.indexOf(ds.vVar);
  if (iLat < 0 || iLon < 0 || iU < 0 || iV < 0) return null;

  const out = [];
  for (const r of table.rows) {
    const u = toNum(r[iU]);
    const v = toNum(r[iV]);
    if (u === null || v === null) continue; // ERDDAP fill values come back as null
    const lat = toNum(r[iLat]);
    const lon = toNum(r[iLon]);
    if (lat === null || lon === null) continue;

    const speed = Math.sqrt(u * u + v * v);
    const dir = (Math.atan2(u, v) * 180) / Math.PI; // compass bearing current flows TOWARD

    out.push({
      lat: round(lat, 3),
      lon: round(lon, 3),
      u: round(u, 4),
      v: round(v, 4),
      speed: round(speed, 4),
      dir: round((dir + 360) % 360, 1),
    });
  }
  return out;
}

function toNum(x) {
  if (x === null || x === undefined) return null;
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}
function round(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }
