// sat-pass.js — Netlify function (STEP 1: auth + structure probe)
//
// You stored NASA_EARTHDATA_USER / NASA_EARTHDATA_PASS in Netlify. This function
// exchanges those credentials for an Earthdata bearer token (reusing an existing
// one if you have a valid token, creating one only if needed — respecting the
// 2-token limit), caches it on the warm instance, then uses it to ask NASA's
// OPeNDAP server for one real SST overpass's internal structure (.dmr).
//
// Deploy, then open:
//   /.netlify/functions/sat-pass?diagnose=1&sample=1
// and paste me the JSON. It never returns your password or the token value —
// only var names, statuses, the token's expiry date, and the file structure.

const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const EDL = 'https://urs.earthdata.nasa.gov';

let _tokCache = null; // { access_token, expiration_date } reused across warm invocations

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, x-bw-token',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  const done = (code, body) => ({ statusCode: code, headers, body: JSON.stringify(body, null, 2) });

  const p = event.queryStringParameters || {};
  const short_name = p.short_name || 'VIIRS_N20-STAR-L3U-v2.80';
  const hours = Math.min(parseInt(p.hours || '48', 10) || 48, 336);
  const minLat = num(p.minLat, 33.5), maxLat = num(p.maxLat, 35.5);
  const minLon = num(p.minLon, -78.0), maxLon = num(p.maxLon, -74.0);
  const bbox = `${minLon},${minLat},${maxLon},${maxLat}`;
  const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const USER_VARS = ['NASA_EARTHDATA_USER', 'EARTHDATA_USER', 'EARTHDATA_USERNAME', 'EDL_USER', 'URS_USER'];
  const PASS_VARS = ['NASA_EARTHDATA_PASS', 'EARTHDATA_PASS', 'EARTHDATA_PASSWORD', 'EDL_PASS', 'URS_PASS'];
  const userVar = (p.uservar ? [p.uservar] : []).concat(USER_VARS).find(k => process.env[k]);
  const passVar = (p.passvar ? [p.passvar] : []).concat(PASS_VARS).find(k => process.env[k]);

  const out = { step: 'diagnostic', short_name, bbox, userVar: userVar || null, passVar: passVar || null };

  try {
    // 1) most recent overpass over the box (no auth)
    const cmrUrl = `${CMR}?short_name=${encodeURIComponent(short_name)}` +
      `&bounding_box=${encodeURIComponent(bbox)}&temporal=${encodeURIComponent(start + ',')}` +
      `&sort_key=-start_date&page_size=1`;
    const cr = await fetch(cmrUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    const cdata = await cr.json();
    const g = ((cdata.feed && cdata.feed.entry) || [])[0];
    if (!g) { out.cmr = 'no granules in window'; return done(200, out); }
    out.granule = { name: g.producer_granule_id, time_start: g.time_start, boxes: g.boxes };
    const opendap = (g.links || []).find(l => /opendap/i.test(l.href || '') && /service#/.test(l.rel || ''));
    if (!opendap) { out.opendap = 'no OPeNDAP link'; return done(200, out); }
    out.opendap_base = opendap.href;

    if (!userVar || !passVar) { out.note = 'Could not find Earthdata user/pass env vars. Pass ?uservar=NAME&passvar=NAME or check the names.'; return done(200, out); }

    // 2) credentials -> bearer token (reuse existing, create only if needed)
    let token;
    try { token = await getToken(process.env[userVar], process.env[passVar], out); }
    catch (e) { out.token_error = String(e.message || e); return done(200, out); }

    const auth = { Authorization: `Bearer ${token}` };

    // 3) DAP4 metadata for this granule — reveals variable + grid layout
    const dmrUrl = `${opendap.href}.dmr`;
    const d = await fetch(dmrUrl, { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(8000) });
    const dmrText = await d.text();
    out.dmr = {
      url: dmrUrl, status: d.status, content_type: d.headers.get('content-type'),
      variables: [...dmrText.matchAll(/<(Float32|Float64|Int16|Int32|Int8|Byte|UInt16|UInt8)\s+name="([^"]+)"/g)].map(m => m[2]).slice(0, 50),
      dimensions: [...dmrText.matchAll(/<Dimension\s+name="([^"]+)"\s+size="(\d+)"/g)].map(m => ({ name: m[1], size: +m[2] })),
      head: dmrText.slice(0, 1800),
    };

    // 4) optional: tiny read of the coordinate arrays to learn grid extent + order
    if (p.sample === '1') {
      const ascUrl = `${opendap.href}.ascii?latitude[0:1:3],longitude[0:1:3]`;
      try {
        const a = await fetch(ascUrl, { headers: auth, redirect: 'follow', signal: AbortSignal.timeout(8000) });
        out.sample = { url: ascUrl, status: a.status, body: (await a.text()).slice(0, 900) };
      } catch (e) { out.sample = { url: ascUrl, error: String(e.message || e) }; }
    }
    return done(200, out);
  } catch (e) {
    out.error = String(e.message || e);
    return done(200, out);
  }
};

async function getToken(user, pass, out) {
  const now = Date.now();
  if (_tokCache && new Date(_tokCache.expiration_date).getTime() > now + 86400000) {
    out.token = { source: 'cache', expires: _tokCache.expiration_date };
    return _tokCache.access_token;
  }
  const basic = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // reuse an existing valid token if present
  try {
    const r = await fetch(`${EDL}/api/users/tokens`, { headers: { Authorization: basic }, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const list = await r.json();
      const valid = Array.isArray(list) && list.find(t => t.access_token && new Date(t.expiration_date).getTime() > now + 86400000);
      if (valid) { _tokCache = valid; out.token = { source: 'reused', expires: valid.expiration_date }; return valid.access_token; }
    } else {
      out.token_list_status = r.status; // 401 here => bad credentials
    }
  } catch (e) { out.token_list_error = String(e.message || e); }

  // otherwise create one
  const c = await fetch(`${EDL}/api/users/token`, { method: 'POST', headers: { Authorization: basic }, signal: AbortSignal.timeout(6000) });
  const ctext = await c.text();
  if (!c.ok) throw new Error(`token create ${c.status}: ${ctext.slice(0, 200)}`);
  const tok = JSON.parse(ctext);
  _tokCache = tok;
  out.token = { source: 'created', expires: tok.expiration_date };
  return tok.access_token;
}

function num(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }
