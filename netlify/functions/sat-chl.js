// sat-chl.js — Netlify function
// Per-sensor CHLOROPHYLL from NASA OB.DAAC VIIRS L3M granules (NOAA-20 / SNPP / NOAA-21).
// Twin of sat-pass.js (SST). Same CMR + OPeNDAP DAP4-CSV machinery.
//
// Auth: NASA_EARTHDATA_TOKEN (bearer) preferred; user/pass only with &allowpass=1.
//
// Modes:
//   ?mode=list   -> enumerate recent chl passes over the box (no pixels). Fast.
//   ?mode=tile   -> one pass's chlor_a grid (mg/m^3) + clarity + bounds. needs &g=<opendap base>.
//   (default)    -> probe one granule.
//   ?diagnose=1  -> STRUCTURAL PROBE: dumps the OPeNDAP .dmr + lat/lon coordinate samples
//                   so we can lock the grid spec (size, origin, step, fill) against the live server.
//   &raw=1       -> dump head/tail of a chlor_a CSV body (debug).
//
// Overrides for verification:
//   &cc=<concept_id>   force a CMR collection_concept_id (e.g. C2340494567-OB_DAAC = NOAA-20 L3M CHL)
//   &sn=<short_name>   force a CMR short_name instead
//   &var=<name>        variable name (default chlor_a)
//   &t3d=1             treat variable as 3-D ([time][lat][lon]) instead of 2-D
//
// GRID SPEC BELOW IS A BEST-GUESS (4 km global mapped) AND MUST BE CONFIRMED VIA ?diagnose=1.
//   guess: lon 8640 (-180..+180), lat 4320 (+90..-90), pixel-center, ~0.041667 deg
//   chlor_a: float32 mg/m^3, _FillValue -32767.0   <-- confirm from .dmr

const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const EDL = 'https://urs.earthdata.nasa.gov';

// ---- CHL grid constants (CONFIRM with ?diagnose=1, then finalize) ----
let NLON = 8640, NLAT = 4320;
let DEG = 360 / NLON;                 // ~0.0416667
let LON0 = -180 + DEG / 2;            // pixel-center of first lon cell
let LAT0 = 90 - DEG / 2;             // pixel-center of first lat cell (north->south)
const FILL = -32767;                  // chlor_a fill (confirm)

// VIIRS L3M CHL collections. NOAA-20 concept_id is confirmed from CMR; others are
// best-guess short_names that ?diagnose / list will validate (counts show errors if wrong).
const COLLECTIONS = [
  { sensor: 'N20', concept_id: 'C2340494567-OB_DAAC' },                 // NOAA-20 L3M CHL (confirmed id)
  { sensor: 'NPP', short_name: 'SNPP_VIIRS_L3m_CHL_NRT' },              // TBD — validate
  { sensor: 'N21', short_name: 'NOAA21_VIIRS_L3m_CHL_NRT' },            // TBD — validate
];

let _tokCache = null;

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const done = (c, b, extra) => ({ statusCode: c, headers: { ...headers, ...(extra || {}) }, body: JSON.stringify(b, null, 2) });

  const p = event.queryStringParameters || {};
  const mode = p.mode || 'probe';
  const hours = Math.min(parseInt(p.hours || '96', 10) || 96, 336);
  const minLat = num(p.minLat, 33.5), maxLat = num(p.maxLat, 35.5);
  const minLon = num(p.minLon, -78.0), maxLon = num(p.maxLon, -74.0);
  const stride = Math.max(1, Math.min(parseInt(p.stride || '2', 10) || 2, 16));
  const VAR = p.var || 'chlor_a';
  const t3d = p.t3d === '1';
  const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;
  const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  // optional override collection for verification
  const overrideColl = p.cc ? { sensor: 'OVR', concept_id: p.cc } : (p.sn ? { sensor: 'OVR', short_name: p.sn } : null);
  const collForProbe = overrideColl || COLLECTIONS[0];

  try {
    let token;
    try { token = await resolveToken(p); }
    catch (e) { return done(200, { error: 'token', detail: String(e.message || e) }); }
    if (!token) return done(200, { error: 'no_token', note: 'Set NASA_EARTHDATA_TOKEN (or &allowpass=1 with user/pass).' });
    const auth = { Authorization: `Bearer ${token}` };

    const ceFor = (win) => t3d
      ? `/${VAR}[0][${win.iTop}:${stride}:${win.iBot}][${win.jL}:${stride}:${win.jR}]`
      : `/${VAR}[${win.iTop}:${stride}:${win.iBot}][${win.jL}:${stride}:${win.jR}]`;

    // -------- LIST --------
    if (mode === 'list') {
      const counts = {};
      const cols = overrideColl ? [overrideColl] : COLLECTIONS;
      const settled = await Promise.all(cols.map(async (col) => {
        try {
          const list = await listGranules(col, bbox, start, 50);
          counts[col.sensor] = list.length;
          return list.map((g) => ({ sensor: col.sensor, ...g }));
        } catch (e) { counts[col.sensor] = `err: ${String(e.message || e).slice(0, 60)}`; return []; }
      }));
      const passes = settled.flat()
        .filter((g) => g.opendap)
        .sort((a, b) => new Date(b.time_start) - new Date(a.time_start))
        .slice(0, parseInt(p.limit || '60', 10) || 60);
      return done(200, { version: 'chl-v1', mode: 'list', bbox, hours, counts, passes },
        { 'Cache-Control': 'public, max-age=900' });
    }

    // -------- TILE --------
    if (mode === 'tile') {
      let g = p.g || '';
      if (!g) {
        const g0 = (await listGranules(collForProbe, bbox, start, 1))[0];
        if (!g0 || !g0.opendap) return done(200, { error: 'no_granule' });
        g = g0.opendap;
      }
      if (!/opendap/i.test(g)) return done(400, { error: 'bad_g', note: 'g must be an OPeNDAP base URL' });
      const win = windowFor(minLat, maxLat, minLon, maxLon, stride);
      const url = `${g}.dap.csv?dap4.ce=${encodeURIComponent(ceFor(win))}`;
      const r = await fetch(url, { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(9000) });
      const text = await r.text();
      if (!r.ok) return done(200, { error: 'fetch', status: r.status, body: text.slice(0, 200) });
      const dec = decodeCsv(text, VAR);
      const grid = dec.cels.map((c) => (c == null ? null : Math.round(c * 1000) / 1000));
      return done(200, {
        version: 'chl-v1', mode: 'tile', stride, variable: VAR,
        bounds: win.bounds, nLat: win.nLat, nLon: win.nLon,
        clarity_pct: Math.round((dec.valid / (dec.cels.length || 1)) * 100),
        chl: dec.valid ? { min: r3(dec.mn), max: r3(dec.mx), mean: r3(dec.sum / dec.valid) } : null,
        grid,
      }, { 'Cache-Control': 'public, max-age=86400' });
    }

    // -------- default probe / diagnose --------
    const out = { version: 'chl-v1', mode: 'probe', collection: collForProbe, variable: VAR, bbox, stride, token: { ok: true } };
    const g0 = (await listGranules(collForProbe, bbox, start, 1))[0];
    if (!g0) { out.note = 'no granule over box in window (try a different &cc / &sn, or widen &hours)'; return done(200, out); }
    out.granule = { name: g0.granule, time_start: g0.time_start };
    if (!g0.opendap) { out.note = 'granule found but no opendap link in CMR'; out.links = g0._links; return done(200, out); }
    out.opendap = g0.opendap;

    if (p.diagnose === '1') {
      // 1) structure: the .dmr tells us dims (lat/lon sizes), variable rank, fill, scaling
      try {
        const dr = await fetch(`${g0.opendap}.dmr`, { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(9000) });
        const dt = await dr.text();
        out.dmr = { status: dr.status, head: dt.slice(0, 2500) };
      } catch (e) { out.dmr = { error: String(e.message || e) }; }
      // 2) coordinate samples: first few lat & lon values -> origin, step, orientation
      try {
        const cr = await fetch(`${g0.opendap}.dap.csv?dap4.ce=${encodeURIComponent('/lat[0:1:4];/lon[0:1:4]')}`,
          { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(9000) });
        out.coords = { status: cr.status, sample: (await cr.text()).slice(0, 600) };
      } catch (e) { out.coords = { error: String(e.message || e) }; }
      return done(200, out);
    }

    // value probe using current (guessed) grid constants
    const win = windowFor(minLat, maxLat, minLon, maxLon, stride);
    out.window = win;
    const url = `${g0.opendap}.dap.csv?dap4.ce=${encodeURIComponent(ceFor(win))}`;
    const r = await fetch(url, { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(9000) });
    const text = await r.text();
    out.fetch = { status: r.status, bytes: text.length };
    if (!r.ok) { out.fetch.body = text.slice(0, 300); return done(200, out); }
    if (p.raw === '1') { out.body_head = text.slice(0, 500); out.body_tail = text.slice(-200); return done(200, out); }
    const dec = decodeCsv(text, VAR);
    out.parsed = { values: dec.cels.length, expected: win.nLat * win.nLon };
    out.clarity_pct = Math.round((dec.valid / (dec.cels.length || 1)) * 100);
    out.chl = dec.valid ? { min: r3(dec.mn), max: r3(dec.mx), mean: r3(dec.sum / dec.valid) } : null;
    return done(200, out);
  } catch (e) {
    return done(200, { error: String(e.message || e) });
  }
};

// ---- helpers ----

function windowFor(minLat, maxLat, minLon, maxLon, stride) {
  const iTop = clampi(Math.round((LAT0 - maxLat) / DEG), NLAT);
  const iBot = clampi(Math.round((LAT0 - minLat) / DEG), NLAT);
  const jL = clampi(Math.round((minLon - LON0) / DEG), NLON);
  const jR = clampi(Math.round((maxLon - LON0) / DEG), NLON);
  const nLat = Math.floor((iBot - iTop) / stride) + 1;
  const nLon = Math.floor((jR - jL) / stride) + 1;
  const bounds = {
    north: r4(LAT0 - iTop * DEG), south: r4(LAT0 - (iTop + (nLat - 1) * stride) * DEG),
    west: r4(LON0 + jL * DEG), east: r4(LON0 + (jL + (nLon - 1) * stride) * DEG),
  };
  return { iTop, iBot, jL, jR, nLat, nLon, bounds };
}

// chlor_a comes back as floats (mg/m^3). Fill / non-finite -> null.
function decodeCsv(text, varName) {
  const cels = [];
  let valid = 0, sum = 0, mn = Infinity, mx = -Infinity;
  for (const ln of text.split('\n')) {
    if (ln.indexOf(varName) === -1) continue;
    const c = ln.indexOf(',');
    if (c === -1) continue;
    for (const tok of ln.slice(c + 1).split(',')) {
      const t = tok.trim(); if (!t) continue;
      const v = parseFloat(t);
      if (!Number.isFinite(v) || v <= -32000 || v === FILL) { cels.push(null); continue; }
      cels.push(v); valid++; sum += v; if (v < mn) mn = v; if (v > mx) mx = v;
    }
  }
  return { cels, valid, sum, mn, mx };
}

// listGranules accepts a collection by concept_id OR short_name
async function listGranules(col, bbox, start, n) {
  const sel = col.concept_id
    ? `collection_concept_id=${encodeURIComponent(col.concept_id)}`
    : `short_name=${encodeURIComponent(col.short_name)}`;
  const url = `${CMR}?${sel}&bounding_box=${encodeURIComponent(bbox)}` +
    `&temporal=${encodeURIComponent(start + ',')}&sort_key=-start_date&page_size=${n}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
  const d = await r.json();
  return ((d.feed && d.feed.entry) || []).map((g) => {
    const od = (g.links || []).find((l) => /opendap/i.test(l.href || '') && /service#/.test(l.rel || ''))
      || (g.links || []).find((l) => /opendap/i.test(l.href || ''));
    return {
      granule: g.producer_granule_id, time_start: g.time_start, day_night: g.day_night_flag || null,
      opendap: od ? od.href.replace(/\.(dap|dmr|html|nc4?)(\?.*)?$/i, '') : null,
      _links: od ? undefined : (g.links || []).map((l) => l.href).slice(0, 6),
    };
  });
}

async function resolveToken(p) {
  const TOKENS = ['NASA_EARTHDATA_TOKEN', 'EARTHDATA_TOKEN', 'EARTHDATA_LOGIN_TOKEN', 'EDL_TOKEN', 'NASA_TOKEN'];
  const tv = TOKENS.find((k) => process.env[k]);
  if (tv) return process.env[tv];
  if (p.allowpass !== '1') return null;
  const uv = ['NASA_EARTHDATA_USER', 'EARTHDATA_USER', 'EARTHDATA_USERNAME'].find((k) => process.env[k]);
  const pv = ['NASA_EARTHDATA_PASS', 'EARTHDATA_PASS', 'EARTHDATA_PASSWORD'].find((k) => process.env[k]);
  if (!uv || !pv) return null;
  if (_tokCache && new Date(_tokCache.expiration_date).getTime() > Date.now() + 86400000) return _tokCache.access_token;
  const basic = 'Basic ' + Buffer.from(`${process.env[uv]}:${process.env[pv]}`).toString('base64');
  const c = await fetch(`${EDL}/api/users/token`, { method: 'POST', headers: { Authorization: basic }, signal: AbortSignal.timeout(6000) });
  const t = await c.text();
  if (!c.ok) throw new Error(`token ${c.status}: ${t.slice(0, 120)}`);
  _tokCache = JSON.parse(t); return _tokCache.access_token;
}

function clampi(v, n) { return Math.max(0, Math.min(n - 1, v)); }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
function r3(x) { return Math.round(x * 1000) / 1000; }
function r4(x) { return Math.round(x * 1e4) / 1e4; }
