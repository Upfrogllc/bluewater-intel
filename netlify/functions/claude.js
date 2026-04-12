const crypto = require('crypto');

// ═══════════════════════════════════════════════════════════════════
// BlueWater Intel — Netlify Serverless Function (Hardened)
// ═══════════════════════════════════════════════════════════════════

const ALLOWED_ORIGINS = [
  'https://bluewater-intel.netlify.app',
  'http://localhost:8888',
  'http://localhost:3000',
];

function getCORSHeaders(event) {
  const origin = event.headers['origin'] || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o))
    || origin.includes('netlify.app') // covers deploy previews + password-protected
    || origin === '';                 // server-to-server / curl with no origin
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed ? origin || '*' : 'https://bluewater-intel.netlify.app',
    'Access-Control-Allow-Headers': 'Content-Type, x-bw-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

// ── Helpers ──────────────────────────────────────────────────────

function ok(body, event) {
  return { statusCode: 200, headers: getCORSHeaders(event), body: JSON.stringify(body) };
}
function err(status, message, event) {
  return { statusCode: status, headers: getCORSHeaders(event || {}), body: JSON.stringify({ error: message }) };
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
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    const m = line.match(/^[\s]*(-?[0-9]+\.?[0-9]*(?:[eE][-+]?[0-9]+)?)[\s]*$/);
    if (m) return parseFloat(m[1]);
  }
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

// ── Rate limiting ────────────────────────────────────────────────
// Auth endpoint: strict (brute-force protection)
const authAttempts = new Map();
const AUTH_LIMIT  = 10;
const AUTH_WINDOW = 60_000;

// Global endpoint: per-IP across all routes
const globalCalls = new Map();
const GLOBAL_LIMIT  = 120;   // requests per window
const GLOBAL_WINDOW = 60_000; // 1 minute

// Analyze endpoint: tighter limit (costs money per call)
const analyzeCalls = new Map();
const ANALYZE_LIMIT  = 15;
const ANALYZE_WINDOW = 60_000;

function getIP(event) {
  return (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || event.headers['client-ip']
      || 'unknown';
}

function checkRate(map, ip, limit, window) {
  const now = Date.now();
  const entry = map.get(ip);
  if (!entry || now > entry.resetAt) {
    map.set(ip, { count: 1, resetAt: now + window });
    return true;
  }
  entry.count++;
  return entry.count <= limit;
}

// ── Origin + secret guard ────────────────────────────────────────
// Known bad actors — send them a personal message
const BLOCKED_NAMES = ['jeff', 'jeffrey'];

function isBlockedUser(payload) {
  const fields = [payload.name, payload.user, payload.username, payload.passcode]
    .filter(Boolean)
    .map(v => String(v).toLowerCase());
  return fields.some(f => BLOCKED_NAMES.some(b => f.includes(b)));
}

function checkOriginAndSecret(event, payload) {
  const origin    = (event.headers['origin'] || event.headers['referer'] || '').toLowerCase();
  const secret    = event.headers['x-bw-token'] || payload?.secret || '';
  const envSecret = process.env.BW_SECRET || '';

  // If BW_SECRET is configured in env, require it — ignores origin
  if (envSecret) return secret === envSecret;

  // No secret configured — fall back to origin check only
  return ALLOWED_ORIGINS.some(o => origin.startsWith(o));
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: getCORSHeaders(event), body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed', event);

  const ip = getIP(event);

  // ── Global rate limit (all endpoints) ───────────────────────────
  if (!checkRate(globalCalls, ip, GLOBAL_LIMIT, GLOBAL_WINDOW)) {
    return err(429, 'Too many requests — slow down.', event);
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return err(400, 'Invalid JSON body', event);
  }

  const type = payload.type;
  if (!type || typeof type !== 'string') return err(400, 'Missing request type', event);

  // ── Jeff check ──────────────────────────────────────────────────
  if (isBlockedUser(payload)) {
    return err(403, "Jeff — you fell right into the trap. I knew you couldn't help yourself... but checkmate! 🎣♟️", event);
  }

// ── Origin / secret guard (skip for ping) ───────────────────────
  if (type !== 'ping' && !checkOriginAndSecret(event, payload)) {
    const origin = event.headers['origin'] || event.headers['referer'] || 'unknown';
    // Looks like someone running a copy of the frontend from elsewhere
    console.warn(`[BLOCKED] Unauthorized access attempt from origin: ${origin} | IP: ${ip} | type: ${type}`);
    return err(403, "Nice try — but this API is locked to the real BlueWater Intel. If you're running a copy of the frontend, it won't work without the server secret. 🔒", event);
  }

  try {
    // ── PING ──────────────────────────────────────────────────────
    if (type === 'ping') return ok({ ok: true }, event);

    // ── AUTH — validate passcode, return HMAC token ──────────────
    if (type === 'auth') {
      if (!checkRate(authAttempts, ip, AUTH_LIMIT, AUTH_WINDOW)) {
        return err(429, 'Too many attempts — try again in 1 minute', event);
      }

      const { passcode } = payload;
      const correct = process.env.VITE_APP_PASSCODE || process.env.APP_PASSCODE || '';
      if (!correct) return err(500, 'Passcode not configured', event);
      if (typeof passcode !== 'string' || !passcode.trim()) return err(400, 'Passcode required', event);

      if (passcode === correct) {
        return ok({ ok: true, token: makeToken(correct) }, event);
      }
      return err(401, 'Wrong passcode', event);
    }

    // ── VERIFY — check stored session token ──────────────────────
    if (type === 'verify') {
      const { token } = payload;
      const correct = process.env.VITE_APP_PASSCODE || process.env.APP_PASSCODE || '';
      return ok({ ok: verifyToken(token, correct) }, event);
    }

    // ── ANALYZE — full server-side scoring + AI ──────────────────
    if (type === 'analyze') {
      if (!checkRate(analyzeCalls, ip, ANALYZE_LIMIT, ANALYZE_WINDOW)) {
        return err(429, 'Analysis rate limit reached — wait a minute.', event);
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return err(500, 'API key not configured', event);

      const { species, currentGrid, lat, lng, radiusMi } = payload;
      if (!species?.length)     return err(400, 'No species selected', event);
      if (!currentGrid?.length) return err(400, 'No current data', event);
      if (!lat || !lng)         return err(400, 'No pin location', event);

      // ── Species thresholds — server-side only, never sent to client ──
      const THRESHOLDS = {
        blue_marlin:  { label:'Blue Marlin',    sst_min:76, sst_max:86, depth_min:800,  depth_max:99999, chl_min:0.01, chl_max:0.30, tip:'Warm core eddies, deep blue water, Gulf Stream edge.' },
        white_marlin: { label:'White Marlin',   sst_min:72, sst_max:82, depth_min:400,  depth_max:99999, chl_min:0.05, chl_max:0.50, tip:'Canyon edges and 100-fathom curve. Current edges and weed lines.' },
        sailfish:     { label:'Sailfish',        sst_min:74, sst_max:84, depth_min:80,   depth_max:600,   chl_min:0.10, chl_max:0.80, tip:'Shallow thermocline, nearshore current edges, bait concentrations.' },
        swordfish:    { label:'Swordfish',       sst_min:65, sst_max:78, depth_min:1200, depth_max:99999, chl_min:0.05, chl_max:0.50, tip:'Deep water, night bite near surface. Cold upwelling edges.' },
        mahi:         { label:'Mahi-Mahi',       sst_min:75, sst_max:85, depth_min:80,   depth_max:800,   chl_min:0.15, chl_max:2.00, tip:'Weed lines, debris, floating objects. High chlorophyll edges.' },
        dolphin:      { label:'Mahi-Mahi',       sst_min:75, sst_max:85, depth_min:80,   depth_max:800,   chl_min:0.15, chl_max:2.00, tip:'Weed lines, debris, floating objects. High chlorophyll edges.' },
        wahoo:        { label:'Wahoo',           sst_min:74, sst_max:84, depth_min:200,  depth_max:1200,  chl_min:0.05, chl_max:0.40, tip:'Current edges at 100-200 fathoms. Warm clear blue water.' },
        yellowfin:    { label:'Yellowfin Tuna',  sst_min:72, sst_max:82, depth_min:400,  depth_max:99999, chl_min:0.10, chl_max:0.60, tip:'Temperature breaks, current edges, bait pods.' },
        blackfin:     { label:'Blackfin Tuna',   sst_min:70, sst_max:80, depth_min:150,  depth_max:600,   chl_min:0.10, chl_max:1.00, tip:'Nearshore humps, color changes, bait balls.' },
        kingfish:     { label:'Kingfish',         sst_min:68, sst_max:80, depth_min:40,   depth_max:200,   chl_min:0.20, chl_max:2.00, tip:'Nearshore reefs and humps, bait schools.' },
        cobia:        { label:'Cobia',            sst_min:68, sst_max:82, depth_min:40,   depth_max:300,   chl_min:0.15, chl_max:2.00, tip:'Structure, buoys, rays near surface.' },
        tripletail:   { label:'Tripletail',       sst_min:72, sst_max:84, depth_min:20,   depth_max:150,   chl_min:0.10, chl_max:1.50, tip:'Floating debris, crab trap buoys, channel markers.' },
      };

      // ── Scoring functions ──────────────────────────────────────
      const scoreDepth = (d, t) => {
        if (!d || d < 5 || d < t.depth_min || d > t.depth_max) return 0;
        const ideal = t.depth_min + (Math.min(t.depth_max, t.depth_min * 4) - t.depth_min) * 0.4;
        return 30 * Math.max(0, 1 - Math.abs(d - ideal) / Math.max(1, ideal));
      };
      const scoreSST = (f, t) => {
        if (f == null) return 8;
        if (f < t.sst_min || f > t.sst_max) return 0;
        return 35 * (1 - Math.abs(f - (t.sst_min + t.sst_max) / 2) / ((t.sst_max - t.sst_min) / 2));
      };
      const scoreChl = (c, t) => {
        if (c == null || c <= 0) return 8;
        if (c < t.chl_min || c > t.chl_max) return 0;
        return 25 * (1 - Math.abs(c - (t.chl_min + t.chl_max) / 2) / ((t.chl_max - t.chl_min) / 2));
      };
      const scoreCurrent = s => (s > 0.1 && s < 3.0) ? 10 * (1 - Math.abs(s - 1.0) / 2.0) : 0;

      // ── Score grid ────────────────────────────────────────────
      const thresholds = species.map(id => THRESHOLDS[id]).filter(Boolean);
      if (!thresholds.length) return err(400, 'No valid species', event);

      // Compute combined depth window across all selected species
      const depthMin = Math.min(...thresholds.map(t => t.depth_min));
      const depthMax = Math.max(...thresholds.map(t => t.depth_max === 99999 ? 99999 : t.depth_max));

      const DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

      const scored = currentGrid
        .filter(pt => {
          const d = pt.depth || 0;
          // HARD filter: must be within depth range of at least one selected species
          if (d < 5) return false;
          return thresholds.some(t => d >= t.depth_min && d <= t.depth_max);
        })
        .map(pt => {
          const sst = pt.sst_f ?? (pt.sst_c != null ? pt.sst_c * 9/5 + 32 : null);
          const chl = pt.chl ?? null;
          const depth = pt.depth ?? 0;
          let s = 0;
          for (const t of thresholds) {
            s += scoreDepth(depth, t) + scoreSST(sst, t) + scoreChl(chl, t) + scoreCurrent(pt.speed_kt || 0);
          }
          return { ...pt, sst, chl, depth, score: parseFloat((s / thresholds.length).toFixed(2)) };
        })
        .filter(pt => pt.score > 5)
        .sort((a, b) => b.score - a.score);

      if (!scored.length) {
        return err(422, 'No grid points match depth/SST requirements for selected species. Move pin to better habitat.', event);
      }

      // ── Build prompt (never leaves server) ────────────────────
      const top = scored.slice(0, 10);
      const month = ['January','February','March','April','May','June','July','August','September','October','November','December'][new Date().getMonth()];
      const spNames = [...new Set(thresholds.map(t => t.label))].join(', ');

      const candidateBlock = top.map((p, i) => {
        const dir = DIRS[Math.round((p.dir_deg || 0) / 22.5) % 16];
        return `#${i+1} [score:${p.score}] ${p.lat.toFixed(4)}°N, ${p.lng.toFixed(4)}°W | depth:${p.depth > 0 ? Math.round(p.depth)+'ft' : 'unknown'} | SST:${p.sst != null ? p.sst.toFixed(1)+'°F' : 'no data'} | chl:${p.chl != null ? p.chl.toFixed(3)+' mg/m³' : 'no data'} | current:${(p.speed_kt||0).toFixed(2)}kt ${dir}`;
      }).join('\n');

      const avgSpd = (top.reduce((s,p) => s + (p.speed_kt||0), 0) / top.length).toFixed(2);
      const aU = top.reduce((s,p) => s + (p.u||0), 0) / top.length;
      const aV = top.reduce((s,p) => s + (p.v||0), 0) / top.length;
      const domDir = DIRS[Math.round(((Math.atan2(aU, aV) * 180 / Math.PI + 360) % 360) / 22.5) % 16];

      const systemPrompt = `You are a marine biologist and offshore fishing expert. You receive pre-scored ocean grid data with real measured sensor values and identify the best fishing hotspots. Cite specific data values in your reasoning. Respond ONLY with valid JSON.`;

      // Build hard depth constraint string for the prompt
      const depthConstraintStr = thresholds.map(t =>
        `${t.label}: ONLY recommend spots between ${t.depth_min}ft and ${t.depth_max === 99999 ? '∞' : t.depth_max + 'ft'} depth. NEVER recommend spots outside this range.`
      ).join('\n');

      const userPrompt = `Select the 4 best fishing hotspots for ${spNames} from these pre-scored candidates.

Search center: ${parseFloat(lat).toFixed(4)}°N, ${Math.abs(parseFloat(lng)).toFixed(4)}°W — ${radiusMi || 50}mi radius. Month: ${month}.

SCORED GRID (depth=NOAA charts, SST=MUR L4 satellite, chl=VIIRS, currents=Open-Meteo):
${candidateBlock}

HARD DEPTH REQUIREMENTS — THESE ARE ABSOLUTE, NON-NEGOTIABLE:
${depthConstraintStr}
ANY candidate with depth outside the required range MUST be excluded. Do not recommend it under any circumstances.

SPECIES NOTES: ${thresholds.map(t => `${t.label}: ${t.tip}`).join(' | ')}

Pick 4 candidates using their EXACT lat/lng. Name each after its oceanographic feature (e.g. "78°F SST Break", "1.2kt NE Current Edge", "120ft Reef Ledge"). Cite actual depth/SST/chl/current values in the why field.

Respond ONLY with JSON:
{"overall":"...","conditions_rating":"Excellent|Good|Fair|Poor","avg_current_kt":"${avgSpd}","dominant_flow":"${domDir}","hotspots":[{"name":"feature name","location":"bearing and distance from center","lat":0.0000,"lng":0.0000,"why":"cite depth/SST/chl/current values","species":["${spNames}"],"primary_species":"primary species","technique":"specific method","confidence":"High|Medium|Low","depth_target":"depth range in feet"}],"pro_tip":"actionable insight from today's data"}`;

      // ── Call Claude with retry ────────────────────────────────
      let aiResponse, attempts = 0;
      while (attempts < 3) {
        aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1500, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
        });
        if (aiResponse.status !== 503) break;
        attempts++;
        await new Promise(r => setTimeout(r, 3000 * attempts));
      }

      if (!aiResponse.ok) {
        const e = await aiResponse.json().catch(() => ({}));
        return err(aiResponse.status, e.error?.message || `Anthropic error ${aiResponse.status}`, event);
      }

      const aiData  = await aiResponse.json();
      const rawText = aiData.content.map(i => i.text || '').join('').replace(/```json|```/g, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch(parseErr) {
        // Claude returned non-JSON — extract what we can or return error
        console.error('Claude JSON parse failed:', rawText.slice(0, 200));
        return err(500, 'AI returned malformed response — please retry', event);
      }

      (parsed.hotspots || []).forEach(hs => { if (hs.lon !== undefined && hs.lng === undefined) hs.lng = hs.lon; });

      // Hard post-filter: remove any hotspot Claude picked that's outside depth range
      // Match hotspot back to its scored grid point and verify depth
      if (parsed.hotspots) {
        parsed.hotspots = parsed.hotspots.filter(hs => {
          // Find the closest scored candidate to this hotspot
          const hsLat = parseFloat(hs.lat), hsLng = parseFloat(hs.lng);
          if (isNaN(hsLat) || isNaN(hsLng)) return false;
          let closest = null, closestDist = Infinity;
          for (const pt of scored) {
            const d = Math.abs(pt.lat - hsLat) + Math.abs(pt.lng - hsLng);
            if (d < closestDist) { closestDist = d; closest = pt; }
          }
          if (!closest) return false;
          const depth = closest.depth || 0;
          // Must be within depth range of at least one selected species
          return thresholds.some(t => depth >= t.depth_min && depth <= t.depth_max);
        });
      }

      return ok(parsed, event);
    }

    // ── MARINE BATCH — multiple Open-Meteo current points ────────
    if (type === 'marine_batch') {
      const { points } = payload;
      if (!Array.isArray(points) || points.length === 0) return err(400, 'Points array required', event);
      if (points.length > 100) return err(400, 'Max 100 points per batch', event);

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
      return ok({ results: results.filter(Boolean) }, event);
    }

    // ── MARINE SINGLE ────────────────────────────────────────────
    if (type === 'marine') {
      const la = parseFloat(payload.lat), ln = parseFloat(payload.lng);
      if (isNaN(la) || isNaN(ln)) return err(400, 'Invalid lat/lng', event);
      const base = `https://marine-api.open-meteo.com/v1/marine?latitude=${la}&longitude=${ln}&current=ocean_current_velocity,ocean_current_direction,sea_surface_temperature&wind_speed_unit=kn`;
      for (const url of [`${base}&models=meteofrance_currents`, base]) {
        try {
          const res = await fetch(url);
          const data = await res.json();
          if (!data.error && data.current?.ocean_current_velocity != null) return ok(data, event);
        } catch (e) {}
      }
      return err(502, 'No marine data available', event);
    }

    // ── GIBS — NASA satellite imagery proxy ──────────────────────
    if (type === 'gibs') {
      const { layer, date, width, height } = payload;
      const bounds = validateBounds(payload);
      if (!bounds) return err(400, 'Invalid bounds', event);
      if (!layer || !date) return err(400, 'Layer and date required', event);

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
          if (isXMLError(buf)) return err(400, `Layer not found: ${layer}`, event);
          if (!isValidPNG(buf)) continue;
          return ok({
            image: Buffer.from(buf).toString('base64'),
            contentType: 'image/png',
            date: tryDate,
            lag: tryDate !== date ? '~24hr processing lag — yesterday pass' : null,
          });
        } catch (e) { continue; }
      }
      return err(404, `No satellite pass for ${date} — cloud cover or not yet processed. Try an earlier date.`, event);
    }

    // ── CoastWatch ERDDAP WMS — 300m Sentinel-3 OLCI ────────────
    if (type === 'coastwatch') {
      const { dataset, variable, date, elevation } = payload;
      const bounds = validateBounds(payload);
      if (!bounds) return err(400, 'Invalid bounds', event);
      if (!dataset || !date) return err(400, 'Dataset and date required', event);

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
      return err(404, `No CoastWatch data for ${date} — cloud cover or not yet processed`, event);
    }

    // ── CMEMS Ocean Currents ─────────────────────────────────────
    if (type === 'cmems_currents') {
      const { dataset, date } = payload;
      const bounds = validateBounds(payload);
      if (!bounds) return err(400, 'Invalid bounds', event);

      const user = process.env.CMEMS_USER;
      const pass = process.env.CMEMS_PASS;
      if (!user || !pass) return err(500, 'CMEMS credentials not configured (CMEMS_USER, CMEMS_PASS)', event);

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

      if (!results.length) return err(502, 'CMEMS returned no data — try Open-Meteo instead', event);
      return ok({ points: results, count: results.length }, event);
    }

    // ── Unknown type ─────────────────────────────────────────────
    return err(400, `Unknown request type: ${type}`, event);

  } catch (e) {
    console.error('[BWI] Handler error:', e.stack || e.message || e);
    return err(500, `Server error: ${e.message || 'unknown'}`, event);
  }
};
