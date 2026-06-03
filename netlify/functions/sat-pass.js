// sat-pass.js — Netlify function
// Per-overpass SST from NASA ACSPO VIIRS L3U granules (NOAA-20 / NPP / NOAA-21).
//
// Auth: NASA_EARTHDATA_TOKEN (bearer) preferred; user/pass only with &allowpass=1.
//
// Modes:
//   ?mode=list   -> enumerate recent overpasses over the box (no pixels). Fast.
//                   returns passes[] newest-first + per-collection counts.
//   ?mode=tile   -> one pass's SST grid, decoded to degC, + clarity + bounds.
//                   requires &g=<opendap base>. cached (granules are immutable).
//   (default)    -> latest single pass probe (stats + ASCII preview).
//   ?diagnose=1  -> structural probe (granule + opendap only).
//   &raw=1       -> dump head/tail of the CSV body (debug).
//
// Grid (confirmed from DMR, global 0.02deg):
//   lat[0]=+89.99 -> lat[8999]=-89.99 (north->south)
//   lon[0]=-179.99 -> lon[17999]=+179.99 (west->east)
//   sea_surface_temperature: Int16, K = raw*0.01 + 273.15, fill = -32768

const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const EDL = 'https://urs.earthdata.nasa.gov';
const OPENDAP_PREFIX = 'https://opendap.earthdata.nasa.gov/collections/';

const NLAT = 9000, NLON = 18000, DEG = 0.02, LAT0 = 89.99, LON0 = -179.99;
const SCALE = 0.009999999776, OFFSET = 273.1499939, FILL = -32768;

// VIIRS ACSPO L3U v2.80 collections, one per satellite
const COLLECTIONS = [
  { sensor: 'N20', short_name: 'VIIRS_N20-STAR-L3U-v2.80' },
  { sensor: 'NPP', short_name: 'VIIRS_NPP-STAR-L3U-v2.80' },
  { sensor: 'N21', short_name: 'VIIRS_N21-STAR-L3U-v2.80' },
];

let _tokCache = null;

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const done = (c, b, extra) => ({ statusCode: c, headers: { ...headers, ...(extra || {}) }, body: JSON.stringify(b, null, 2) });

  const p = event.queryStringParameters || {};
  const mode = p.mode || 'probe';
  const hours = Math.min(parseInt(p.hours || '72', 10) || 72, 336);
  const minLat = num(p.minLat, 33.5), maxLat = num(p.maxLat, 35.5);
  const minLon = num(p.minLon, -78.0), maxLon = num(p.maxLon, -74.0);
  const stride = Math.max(1, Math.min(parseInt(p.stride || '2', 10) || 2, 16));
  const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;
  const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  try {
    let token;
    try { token = await resolveToken(p); }
    catch (e) { return done(200, { error: 'token', detail: String(e.message || e) }); }
    if (!token) return done(200, { error: 'no_token', note: 'Set NASA_EARTHDATA_TOKEN (or &allowpass=1 with user/pass).' });
    const auth = { Authorization: `Bearer ${token}` };

    // -------- LIST: enumerate passes across all collections --------
    if (mode === 'list') {
      const counts = {};
      const settled = await Promise.all(COLLECTIONS.map(async (col) => {
        try {
          const list = await listGranules(col.short_name, bbox, start, 50);
          counts[col.sensor] = list.length;
          return list.map((g) => ({ sensor: col.sensor, short_name: col.short_name, ...g }));
        } catch (e) { counts[col.sensor] = `err: ${String(e.message || e).slice(0, 60)}`; return []; }
      }));
      const passes = settled.flat()
        .filter((g) => g.opendap)
        .sort((a, b) => new Date(b.time_start) - new Date(a.time_start))
        .slice(0, parseInt(p.limit || '60', 10) || 60);
      return done(200, { version: 'pass-v5', mode: 'list', bbox, hours, counts, passes },
        { 'Cache-Control': 'public, max-age=900' }); // list refreshes ~15 min
    }

    // -------- TILE: one pass's grid --------
    if (mode === 'tile') {
      let g = p.g || '';
      if (!g) {
        const g0 = (await listGranules(COLLECTIONS[0].short_name, bbox, start, 1))[0];
        if (!g0 || !g0.opendap) return done(200, { error: 'no_granule' });
        g = g0.opendap;
      }
      if (!g.startsWith(OPENDAP_PREFIX)) return done(400, { error: 'bad_g', note: 'g must be an opendap.earthdata.nasa.gov collections URL' });
      const win = windowFor(minLat, maxLat, minLon, maxLon, stride);
      const ce = `/sea_surface_temperature[0][${win.iTop}:${stride}:${win.iBot}][${win.jL}:${stride}:${win.jR}]`;
      const url = `${g}.dap.csv?dap4.ce=${encodeURIComponent(ce)}`;
      const r = await fetch(url, { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(9000) });
      const text = await r.text();
      if (!r.ok) return done(200, { error: 'fetch', status: r.status, body: text.slice(0, 200) });
      const dec = decodeCsv(text, win.nLat, win.nLon);
      const grid = dec.cels.map((c) => (c == null ? null : Math.round(c * 10) / 10));
      return done(200, {
        version: 'pass-v5', mode: 'tile', stride,
        bounds: win.bounds, nLat: win.nLat, nLon: win.nLon,
        clarity_pct: Math.round((dec.valid / (dec.cels.length || 1)) * 100),
        sst: dec.valid ? { min_c: r1(dec.mn), max_c: r1(dec.mx), mean_c: r1(dec.sum / dec.valid) } : null,
        grid,
      }, { 'Cache-Control': 'public, max-age=86400' }); // granule data immutable
    }

    // -------- default probe / diagnose --------
    const out = { version: 'pass-v5', mode: 'probe', short_name: COLLECTIONS[0].short_name, bbox, stride, token: { ok: true } };
    const g0 = (await listGranules(COLLECTIONS[0].short_name, bbox, start, 1))[0];
    if (!g0) { out.note = 'no granule over box in window'; return done(200, out); }
    out.granule = { name: g0.granule, time_start: g0.time_start };
    if (!g0.opendap) { out.note = 'no opendap link'; return done(200, out); }
    if (p.diagnose === '1') { out.opendap = g0.opendap; return done(200, out); }

    const win = windowFor(minLat, maxLat, minLon, maxLon, stride);
    out.window = win;
    const ce = `/sea_surface_temperature[0][${win.iTop}:${stride}:${win.iBot}][${win.jL}:${stride}:${win.jR}]`;
    const url = `${g0.opendap}.dap.csv?dap4.ce=${encodeURIComponent(ce)}`;
    const r = await fetch(url, { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(9000) });
    const text = await r.text();
    out.fetch = { status: r.status, bytes: text.length };
    if (!r.ok) { out.fetch.body = text.slice(0, 300); return done(200, out); }
    if (p.raw === '1') { out.body_head = text.slice(0, 500); out.body_tail = text.slice(-200); return done(200, out); }

    const dec = decodeCsv(text, win.nLat, win.nLon);
    out.parsed = { values: dec.cels.length, expected: win.nLat * win.nLon };
    out.clarity_pct = Math.round((dec.valid / (dec.cels.length || 1)) * 100);
    out.sst = dec.valid ? { min_c: r1(dec.mn), max_c: r1(dec.mx), mean_c: r1(dec.sum / dec.valid), mean_f: r1((dec.sum / dec.valid) * 9 / 5 + 32) } : null;
    if (dec.cels.length === win.nLat * win.nLon) {
      const rows = []; const rStep = Math.max(1, Math.floor(win.nLat / 8)), cStep = Math.max(1, Math.floor(win.nLon / 12));
      for (let i = 0; i < win.nLat; i += rStep) {
        let line = '';
        for (let j = 0; j < win.nLon; j += cStep) { const c = dec.cels[i * win.nLon + j]; line += (c == null) ? ' ..' : String(Math.round(c * 9 / 5 + 32)).padStart(3, ' '); }
        rows.push(line);
      }
      out.preview_F = rows;
    }
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

function decodeCsv(text, nLat, nLon) {
  const cels = [];
  let valid = 0, sum = 0, mn = Infinity, mx = -Infinity;
  for (const ln of text.split('\n')) {
    if (ln.indexOf('sea_surface_temperature') === -1) continue;
    const c = ln.indexOf(',');
    if (c === -1) continue;
    for (const tok of ln.slice(c + 1).split(',')) {
      const t = tok.trim(); if (!t) continue;
      const v = parseInt(t, 10);
      if (v === FILL) { cels.push(null); continue; }
      const cc = v * SCALE + OFFSET - 273.15;
      cels.push(cc); valid++; sum += cc; if (cc < mn) mn = cc; if (cc > mx) mx = cc;
    }
  }
  return { cels, valid, sum, mn, mx };
}

async function listGranules(short_name, bbox, start, n) {
  const url = `${CMR}?short_name=${encodeURIComponent(short_name)}&bounding_box=${encodeURIComponent(bbox)}` +
    `&temporal=${encodeURIComponent(start + ',')}&sort_key=-start_date&page_size=${n}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
  const d = await r.json();
  return ((d.feed && d.feed.entry) || []).map((g) => {
    const od = (g.links || []).find((l) => /opendap/i.test(l.href || '') && /service#/.test(l.rel || ''));
    return { granule: g.producer_granule_id, time_start: g.time_start, day_night: g.day_night_flag || null, opendap: od ? od.href : null };
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
function r1(x) { return Math.round(x * 10) / 10; }
function r4(x) { return Math.round(x * 1e4) / 1e4; }
