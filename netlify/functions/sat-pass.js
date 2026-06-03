// sat-pass.js — Netlify function
// Per-overpass SST from NASA ACSPO VIIRS L3U granules, subset to a box.
//
// Auth: NASA_EARTHDATA_TOKEN (bearer) preferred; falls back to
//       NASA_EARTHDATA_USER/PASS only if &allowpass=1 (avoids lockouts).
//
// Modes:
//   (default) probe=data : find latest pass over the box, subset + decode SST,
//                          report clarity %, temp stats, and a small preview.
//   ?diagnose=1          : structural probe (DMR + coord order).
//
// Grid facts confirmed from the DMR (global 0.02°):
//   lat[0]=+89.99 -> lat[8999]=-89.99  (north->south)
//   lon[0]=-179.99 -> lon[17999]=+179.99 (west->east)
//   sea_surface_temperature: Int16, K = raw*0.01 + 273.15, fill = -32768

const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const EDL = 'https://urs.earthdata.nasa.gov';

const NLAT = 9000, NLON = 18000, DEG = 0.02, LAT0 = 89.99, LON0 = -179.99;
const SCALE = 0.009999999776, OFFSET = 273.1499939, FILL = -32768; // K = raw*SCALE+OFFSET

let _tokCache = null;

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Access-Control-Allow-Headers': 'Content-Type, x-bw-token' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const done = (c, b) => ({ statusCode: c, headers, body: JSON.stringify(b, null, 2) });

  const p = event.queryStringParameters || {};
  const short_name = p.short_name || 'VIIRS_N20-STAR-L3U-v2.80';
  const hours = Math.min(parseInt(p.hours || '48', 10) || 48, 336);
  const minLat = num(p.minLat, 33.5), maxLat = num(p.maxLat, 35.5);
  const minLon = num(p.minLon, -78.0), maxLon = num(p.maxLon, -74.0);
  const stride = Math.max(1, Math.min(parseInt(p.stride || '2', 10) || 2, 8));
  const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;
  const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const out = { version: 'pass-v4', short_name, bbox, stride };

  try {
    // token
    let token;
    try { token = await resolveToken(p, out); }
    catch (e) { out.token_error = String(e.message || e); return done(200, out); }
    if (!token) { out.note = 'No token. Set NASA_EARTHDATA_TOKEN (or &allowpass=1 with user/pass).'; return done(200, out); }
    const auth = { Authorization: `Bearer ${token}` };

    // latest granule over the box
    const g = await latestGranule(short_name, bbox, start);
    if (!g) { out.note = 'No granules over box in window'; return done(200, out); }
    out.granule = { name: g.name, time_start: g.time_start };
    const opendap = g.opendap;
    if (!opendap) { out.note = 'No OPeNDAP link'; return done(200, out); }

    if (p.diagnose === '1') { out.opendap = opendap; return done(200, out); }

    // index window for the box (lat is north->south, so maxLat -> smaller index)
    const iTop = clampi(Math.round((LAT0 - maxLat) / DEG), NLAT);
    const iBot = clampi(Math.round((LAT0 - minLat) / DEG), NLAT);
    const jL = clampi(Math.round((minLon - LON0) / DEG), NLON);
    const jR = clampi(Math.round((maxLon - LON0) / DEG), NLON);
    const nLat = Math.floor((iBot - iTop) / stride) + 1;
    const nLon = Math.floor((jR - jL) / stride) + 1;
    out.window = { iTop, iBot, jL, jR, nLat, nLon, cells: nLat * nLon };

    // fetch SST subset as DAP4 CSV
    const ce = `/sea_surface_temperature[0][${iTop}:${stride}:${iBot}][${jL}:${stride}:${jR}]`;
    const url = `${opendap}.dap.csv?dap4.ce=${encodeURIComponent(ce)}`;
    const r = await fetch(url, { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(9000) });
    const text = await r.text();
    out.fetch = { status: r.status, bytes: text.length };
    if (!r.ok) { out.fetch.body = text.slice(0, 300); return done(200, out); }

    if (p.raw === '1') {
      out.body_head = text.slice(0, 700);
      out.body_tail = text.slice(-300);
      const kk = text.indexOf('sea_surface_temperature');
      out.var_segment = kk >= 0 ? text.slice(kk, kk + 120) : '(name not found)';
      out.line_count = text.split('\n').length;
      return done(200, out);
    }

    // parse: one line per lat-row, each "/sea_surface_temperature[0][i], v, v, ..."
    // keep only values after each row's first comma (the row label holds stray ints)
    const raw = [];
    for (const ln of text.split('\n')) {
      if (ln.indexOf('sea_surface_temperature') === -1) continue;
      const c = ln.indexOf(',');
      if (c === -1) continue;
      for (const tok of ln.slice(c + 1).split(',')) {
        const t = tok.trim();
        if (t) raw.push(parseInt(t, 10));
      }
    }
    out.parsed = { values: raw.length, expected: nLat * nLon };

    // decode + clarity
    let valid = 0, sum = 0, mn = Infinity, mx = -Infinity;
    const cels = new Array(raw.length);
    for (let n = 0; n < raw.length; n++) {
      const v = raw[n];
      if (v === FILL) { cels[n] = null; continue; }
      const c = v * SCALE + OFFSET - 273.15;
      cels[n] = c; valid++; sum += c; if (c < mn) mn = c; if (c > mx) mx = c;
    }
    const total = raw.length || 1;
    out.clarity_pct = Math.round((valid / total) * 100);
    out.sst = valid ? {
      min_c: +mn.toFixed(2), max_c: +mx.toFixed(2), mean_c: +(sum / valid).toFixed(2),
      mean_f: +((sum / valid) * 9 / 5 + 32).toFixed(1),
    } : null;

    // tiny preview: a coarse ASCII grid (°F rounded, '..' = cloud) — sanity check only
    if (raw.length === nLat * nLon) {
      const rows = [];
      const rStep = Math.max(1, Math.floor(nLat / 8)), cStep = Math.max(1, Math.floor(nLon / 12));
      for (let i = 0; i < nLat; i += rStep) {
        let line = '';
        for (let j = 0; j < nLon; j += cStep) {
          const c = cels[i * nLon + j];
          line += (c == null) ? ' ..' : String(Math.round(c * 9 / 5 + 32)).padStart(3, ' ');
        }
        rows.push(line);
      }
      out.preview_F = rows;
    }
    return done(200, out);
  } catch (e) {
    out.error = String(e.message || e);
    return done(200, out);
  }
};

async function latestGranule(short_name, bbox, start) {
  const url = `${CMR}?short_name=${encodeURIComponent(short_name)}&bounding_box=${encodeURIComponent(bbox)}` +
    `&temporal=${encodeURIComponent(start + ',')}&sort_key=-start_date&page_size=1`;
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
  const d = await r.json();
  const g = ((d.feed && d.feed.entry) || [])[0];
  if (!g) return null;
  const od = (g.links || []).find(l => /opendap/i.test(l.href || '') && /service#/.test(l.rel || ''));
  return { name: g.producer_granule_id, time_start: g.time_start, opendap: od ? od.href : null };
}

async function resolveToken(p, out) {
  const TOKENS = ['NASA_EARTHDATA_TOKEN', 'EARTHDATA_TOKEN', 'EARTHDATA_LOGIN_TOKEN', 'EDL_TOKEN', 'NASA_TOKEN'];
  const tv = (p.tokenvar ? [p.tokenvar] : []).concat(TOKENS).find(k => process.env[k]);
  if (tv) { out.token = { source: `env:${tv}` }; return process.env[tv]; }
  if (p.allowpass !== '1') return null;
  const uv = ['NASA_EARTHDATA_USER', 'EARTHDATA_USER', 'EARTHDATA_USERNAME'].find(k => process.env[k]);
  const pv = ['NASA_EARTHDATA_PASS', 'EARTHDATA_PASS', 'EARTHDATA_PASSWORD'].find(k => process.env[k]);
  if (!uv || !pv) return null;
  const now = Date.now();
  if (_tokCache && new Date(_tokCache.expiration_date).getTime() > now + 86400000) { out.token = { source: 'cache' }; return _tokCache.access_token; }
  const basic = 'Basic ' + Buffer.from(`${process.env[uv]}:${process.env[pv]}`).toString('base64');
  const c = await fetch(`${EDL}/api/users/token`, { method: 'POST', headers: { Authorization: basic }, signal: AbortSignal.timeout(6000) });
  const t = await c.text();
  if (!c.ok) throw new Error(`token ${c.status}: ${t.slice(0, 150)}`);
  _tokCache = JSON.parse(t); out.token = { source: 'created' }; return _tokCache.access_token;
}

function clampi(v, n) { return Math.max(0, Math.min(n - 1, v)); }
function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
