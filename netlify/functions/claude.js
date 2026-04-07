const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// BlueWater Intel — Netlify Serverless Function (Hardened)
// ═══════════════════════════════════════════════════════════════════
// Changes from original:
//  1. Auth tokens use HMAC-SHA256 instead of predictable string
//  2. Added /analyze route so AI calls go through server (no client API key)
//  3. Input validation on all endpoints
//  4. In-memory rate limiting on auth endpoint (brute-force protection)
//  5. Removed duplicate/dead code paths
//  6. Consistent error handling
// ═══════════════════════════════════════════════════════════════════

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Helpers ──────────────────────────────────────────────────────

function ok(body) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(body) };
}
function err(status, message) {
  return { statusCode: status, headers: CORS, body: JSON.stringify({ error: message }) };
}

/** HMAC-SHA256 token — deterministic per day + secret */
function makeToken(passcode) {
  const day = new Date().toISOString().split('T')[0];
  return crypto.createHmac('sha256', passcode).update(`bwi:${day}`).digest('hex').slice(0, 32);
}

/** Validate a stored session token */
function verifyToken(token, passcode) {
  return token === makeToken(passcode);
}

/** Check PNG magic bytes */
function isValidPNG(buf) {
  if (buf.byteLength < 200) return false;
  const b = new Uint8Array(buf.slice(0, 4));
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

/** Check if buffer starts with XML (error response) */
function isXMLError(buf) {
  if (buf.byteLength < 10) return true;
  const t = Buffer.from(buf.slice(0, 80)).toString('utf8');
  return t.includes('<?xml') || t.includes('ExceptionReport') || t.includes('<Service');
}

/** Parse a numeric value from CMEMS plain-text response */
function parseCMEMSValue(text) {
  // Skip lines that look like error messages — only grab standalone numbers
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    const m = line.match(/^[\s]*(-?[0-9]+\.?[0-9]*(?:[eE][-+]?[0-9]+)?)[\s]*$/);
    if (m) return parseFloat(m[1]);
  }
  // Fallback: look for "value = X" pattern
  const valMatch = text.match(/value\s*[=:]\s*(-?[0-9]+\.?[0-9]*(?:[eE][-+]?[0-9]+)?)/i);
  if (valMatch) return parseFloat(valMatch[1]);
  return null;
}

/** Clamp a number to a range */
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

/** Validate lat/lng bounds */
function validateBounds(payload) {
  const { west, south, east, north } = payload;
  const w = parseFloat(west), s = parseFloat(south), e = parseFloat(east), n = parseFloat(north);
  if ([w, s, e, n].some(isNaN)) return null;
  return {
    west: clamp(w, -180, 180), south: clamp(s, -90, 90),
    east: clamp(e, -180, 180), north: clamp(n, -90, 90)
  };
}

// ── Simple in-memory rate limiter for auth ──────────────────────
const authAttempts = new Map(); // ip -> { count, resetAt }
const AUTH_LIMIT = 10;         // max attempts per window
const AUTH_WINDOW = 60_000;    // 1 minute window

function checkAuthRate(ip) {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW });
    return true;
  }
  entry.count++;
  if (entry.count > AUTH_LIMIT) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return err(400, 'Invalid JSON body');
  }

  const type = payload.type;
  if (!type || typeof type !== 'string') return err(400, 'Missing request type');

  try {
    // ── PING ──────────────────────────────────────────────────────
    if (type === 'ping') return ok({ ok: true });

    // ── AUTH — validate passcode, return HMAC token ──────────────
    if (type === 'auth') {
      const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
      if (!checkAuthRate(ip)) return err(429, 'Too many attempts — try again in 1 minute');

      const { passcode } = payload;
      const correct = process.env.VITE_APP_PASSCODE || process.env.APP_PASSCODE || '';
      if (!correct) return err(500, 'Passcode not configured');
      if (typeof passcode !== 'string' || !passcode.trim()) return err(400, 'Passcode required');

      if (passcode === correct) {
        return ok({ ok: true, token: makeToken(correct) });
      }
      return err(401, 'Wrong passcode');
    }

    // ── VERIFY — check stored session token ──────────────────────
    if (type === 'verify') {
      const { token } = payload;
      const correct = process.env.VITE_APP_PASSCODE || process.env.APP_PASSCODE || '';
      return ok({ ok: verifyToken(token, correct) });
    }

    // ── ANALYZE — AI fishing analysis (server-side API key) ──────
    // This is the NEW route: frontend sends data here instead of
    // calling Anthropic directly with a client-side key.
    if (type === 'analyze') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return err(500, 'Anthropic API key not configured on server');

      const { prompt, system } = payload;
      if (!prompt || typeof prompt !== 'string') return err(400, 'Missing analysis prompt');

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          system: system || 'Expert offshore fishing guide for Treasure Coast Florida. Respond only valid JSON.',
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        return err(response.status, errBody.error?.message || `Anthropic API error ${response.status}`);
      }

      const data = await response.json();
      return ok(data);
    }

    // ── MARINE BATCH — multiple Open-Meteo current points ────────
    if (type === 'marine_batch') {
      const { points } = payload;
      if (!Array.isArray(points) || points.length === 0) return err(400, 'Points array required');
      if (points.length > 100) return err(400, 'Max 100 points per batch');

      const base = 'https://marine-api.open-meteo.com/v1/marine';
      const results = await Promise.all(
        points.map(async ({ lat, lng }) => {
          const la = parseFloat(lat), ln = parseFloat(lng);
          if (isNaN(la) || isNaN(ln)) return null;
          const urls = [
            `${base}?latitude=${la}&longitude=${ln}&current=ocean_current_velocity,ocean_current_direction,sea_surface_temperature&wind_speed_unit=kn&models=meteofrance_currents`,
            `${base}?latitude=${la}&longitude=${ln}&current=ocean_current_velocity,ocean_current_direction,sea_surface_temperature&wind_speed_unit=kn`,
          ];
          for (const url of urls) {
            try {
              const res = await fetch(url);
              const data = await res.json();
              if (data.error || !data.current || data.current.ocean_current_velocity == null) continue;
              const c = data.current;
              const spd = c.ocean_current_velocity;
              const dir = c.ocean_current_direction ?? 0;
              return {
                lat: la, lng: ln, speed_kt: spd, dir_deg: dir,
                sst_c: c.sea_surface_temperature ?? null,
                u: spd * Math.sin((dir * Math.PI) / 180),
                v: spd * Math.cos((dir * Math.PI) / 180),
              };
            } catch (e) { continue; }
          }
          return null;
        })
      );
      return ok({ results: results.filter(Boolean) });
    }

    // ── MARINE SINGLE ────────────────────────────────────────────
    if (type === 'marine') {
      const la = parseFloat(payload.lat), ln = parseFloat(payload.lng);
      if (isNaN(la) || isNaN(ln)) return err(400, 'Invalid lat/lng');
      const base = `https://marine-api.open-meteo.com/v1/marine?latitude=${la}&longitude=${ln}&current=ocean_current_velocity,ocean_current_direction,sea_surface_temperature&wind_speed_unit=kn`;
      for (const url of [`${base}&models=meteofrance_currents`, base]) {
        try {
          const res = await fetch(url);
          const data = await res.json();
          if (!data.error && data.current?.ocean_current_velocity != null) return ok(data);
        } catch (e) {}
      }
      return err(502, 'No marine data available');
    }

    // ── GIBS — NASA satellite imagery proxy ──────────────────────
    if (type === 'gibs') {
      const { layer, date, width, height } = payload;
      const bounds = validateBounds(payload);
      if (!bounds) return err(400, 'Invalid bounds');
      if (!layer || !date) return err(400, 'Layer and date required');

      const w = clamp(parseInt(width) || 800, 64, 2048);
      const h = clamp(parseInt(height) || 600, 64, 2048);

      const baseUrl = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${encodeURIComponent(layer)}&STYLES=&FORMAT=image/png&TRANSPARENT=true&SRS=EPSG:4326&WIDTH=${w}&HEIGHT=${h}&BBOX=${bounds.west},${bounds.south},${bounds.east},${bounds.north}`;

      // Try requested date then yesterday (processing lag tolerance)
      const tryDates = [date];
      const reqDate = new Date(date + 'T12:00:00Z');
      const yday = new Date(reqDate);
      yday.setDate(yday.getDate() - 1);
      tryDates.push(yday.toISOString().split('T')[0]);

      for (const tryDate of tryDates) {
        const url = `${baseUrl}&TIME=${tryDate}`;
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'BlueWaterIntel/1.0' } });
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          if (isXMLError(buf)) return err(400, `Layer not found: ${layer}`);
          if (!isValidPNG(buf)) continue;
          return ok({
            image: Buffer.from(buf).toString('base64'),
            contentType: 'image/png',
            date: tryDate,
            lag: tryDate !== date ? '~24hr processing lag — yesterday pass' : null,
          });
        } catch (e) { continue; }
      }
      return err(404, `No satellite pass for ${date} — cloud cover or not yet processed. Try an earlier date.`);
    }

    // ── CoastWatch ERDDAP WMS — 300m Sentinel-3 OLCI ────────────
    if (type === 'coastwatch') {
      const { dataset, variable, date, elevation } = payload;
      const bounds = validateBounds(payload);
      if (!bounds) return err(400, 'Invalid bounds');
      if (!dataset || !date) return err(400, 'Dataset and date required');

      const w = clamp(parseInt(payload.width) || 800, 64, 2048);
      const h = clamp(parseInt(payload.height) || 600, 64, 2048);
      const wmsBase = `https://coastwatch.noaa.gov/erddap/wms/${encodeURIComponent(dataset)}/request`;

      // Try requested date then up to 5 days back (processing lag)
      const tryDates = [date];
      for (let back = 1; back <= 5; back++) {
        const d = new Date(date + 'T12:00:00Z');
        d.setDate(d.getDate() - back);
        tryDates.push(d.toISOString().split('T')[0]);
      }

      for (const tryDate of tryDates) {
        const params = new URLSearchParams({
          service: 'WMS', version: '1.3.0', request: 'GetMap',
          layers: `${dataset}:${variable || 'chlor_a'}`,
          styles: '', crs: 'EPSG:4326',
          bbox: `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`,
          width: w, height: h,
          format: 'image/png', transparent: 'TRUE',
          time: `${tryDate}T12:00:00Z`,
          elevation: elevation || '0.0',
        });
        const url = `${wmsBase}?${params}`;
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'BlueWaterIntel/1.0' } });
          if (!res.ok) continue;
          const buf = await res.arrayBuffer();
          if (!isValidPNG(buf)) continue;
          return ok({
            image: Buffer.from(buf).toString('base64'),
            contentType: 'image/png',
            date: tryDate,
            lag: tryDate !== date ? '~24hr processing lag' : null,
            source: 'CoastWatch ERDDAP',
          });
        } catch (e) { continue; }
      }
      return err(404, `No CoastWatch data for ${date} — cloud cover or not yet processed`);
    }

    // ── CMEMS Ocean Currents ─────────────────────────────────────
    if (type === 'cmems_currents') {
      const { dataset, date } = payload;
      const bounds = validateBounds(payload);
      if (!bounds) return err(400, 'Invalid bounds');

      const user = process.env.CMEMS_USER;
      const pass = process.env.CMEMS_PASS;
      if (!user || !pass) return err(500, 'CMEMS credentials not configured (CMEMS_USER, CMEMS_PASS)');

      const auth = Buffer.from(`${user}:${pass}`).toString('base64');
      const latStep = 0.2, lngStep = 0.2;
      const lats = [], lngs = [];
      for (let la = bounds.south + latStep / 2; la < bounds.north && lats.length < 12; la += latStep) {
        lats.push(parseFloat(la.toFixed(3)));
      }
      for (let ln = bounds.west + lngStep / 2; ln < bounds.east && lngs.length < 12; ln += lngStep) {
        lngs.push(parseFloat(ln.toFixed(3)));
      }

      const wmsUrl = `https://nrt.cmems-du.eu/thredds/wms/${encodeURIComponent(dataset || 'cmems_mod_glo_phy-cur_anfc_0.083deg_P1D-m')}`;
      const results = [];

      const promises = lats.flatMap(la =>
        lngs.map(ln =>
          (async () => {
            try {
              const common = {
                SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetFeatureInfo',
                SRS: 'EPSG:4326', FORMAT: 'image/png', INFO_FORMAT: 'text/plain',
                BBOX: `${ln - 0.15},${la - 0.15},${ln + 0.15},${la + 0.15}`,
                WIDTH: '10', HEIGHT: '10', X: '5', Y: '5',
                TIME: `${date || new Date().toISOString().split('T')[0]}T00:00:00Z`,
                ELEVATION: '-0.5',
              };
              const pU = new URLSearchParams({ ...common, LAYERS: 'uo', QUERY_LAYERS: 'uo' });
              const pV = new URLSearchParams({ ...common, LAYERS: 'vo', QUERY_LAYERS: 'vo' });

              const [ru, rv] = await Promise.all([
                fetch(`${wmsUrl}?${pU}`, { headers: { Authorization: `Basic ${auth}` } }),
                fetch(`${wmsUrl}?${pV}`, { headers: { Authorization: `Basic ${auth}` } }),
              ]);
              const [tu, tv] = await Promise.all([ru.text(), rv.text()]);
              const u = parseCMEMSValue(tu);
              const v = parseCMEMSValue(tv);

              if (u !== null && v !== null && !isNaN(u) && !isNaN(v)) {
                const spd = Math.sqrt(u * u + v * v) * 1.944;
                const dir = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
                results.push({ lat: la, lng: ln, speed_kt: spd, dir_deg: dir, u: u * 1.944, v: v * 1.944, sst_c: null });
              }
            } catch (e) {}
          })()
        )
      );

      await Promise.allSettled(promises);

      if (!results.length) return err(502, 'CMEMS returned no data — try Open-Meteo instead');
      return ok({ points: results, count: results.length });
    }

    // ── Unknown type ─────────────────────────────────────────────
    return err(400, `Unknown request type: ${type}`);

  } catch (e) {
    console.error('Handler error:', e);
    return err(500, e.message || 'Internal server error');
  }
};
