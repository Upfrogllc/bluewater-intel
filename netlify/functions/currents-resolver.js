/**
 * currents-resolver.js
 * Netlify Function — current waterfall orchestrator (V2, budget-hardened)
 *
 * Tries sources in priority order, returns the first good grid, annotates with
 * confidence metadata. Same external contract as before.
 *
 * NETLIFY 10s LIMIT: the whole chain runs under a hard ~9s wall-clock budget.
 * Each ERDDAP source gets a short timeout; time is always reserved for the
 * cheap Open-Meteo fallback so a slow/flaky NOAA host can't blow the budget
 * and trigger a 502.
 *
 * Waterfall:
 *   1. GEOSTROPHIC_BLENDED — NOAA CoastWatch blended altimetry geostrophic (0.25°)
 *   2. GEOSTROPHIC_MIAMI   — NOAA AOML geostrophic (independent host)
 *   3. OPEN_METEO          — wind proxy, single bounded request, last resort
 *
 * Query: minLon,maxLon,minLat,maxLat, date (optional), source (optional force)
 */

const BASE_URL = process.env.URL || process.env.DEPLOY_URL || 'https://bluewater-intel.netlify.app';

const BUDGET_MS = 9000;        // stay under Netlify's 10s
const ERDDAP_MAX_MS = 5000;    // cap per ERDDAP source
const OPENMETEO_RESERVE_MS = 3200; // keep this much for the fallback
const OPENMETEO_MAX_MS = 4500;
const MIN_ATTEMPT_MS = 1200;   // don't start a source with less budget than this

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const p = event.queryStringParameters || {};
  const bbox = {
    minLon: parseFloat(p.minLon), maxLon: parseFloat(p.maxLon),
    minLat: parseFloat(p.minLat), maxLat: parseFloat(p.maxLat),
  };
  const date = p.date || new Date().toISOString().slice(0, 10);
  const forcedSource = p.source || null;
  if (Object.values(bbox).some(isNaN)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'minLon, maxLon, minLat, maxLat required' }) };
  }

  const bboxQuery = `minLon=${bbox.minLon}&maxLon=${bbox.maxLon}&minLat=${bbox.minLat}&maxLat=${bbox.maxLat}&date=${date}`;

  const SOURCES = [
    { id: 'GEOSTROPHIC_BLENDED', url: `${BASE_URL}/.netlify/functions/currents-erddap?dataset=blended&${bboxQuery}`,
      confidence: 'high', dataType: 'satellite_observation',
      description: 'NOAA CoastWatch blended altimetry geostrophic (0.25°, daily NRT)' },
    { id: 'GEOSTROPHIC_MIAMI', url: `${BASE_URL}/.netlify/functions/currents-erddap?dataset=miami&${bboxQuery}`,
      confidence: 'medium', dataType: 'satellite_observation',
      description: 'NOAA AOML near-real-time geostrophic (independent host fallback)' },
    { id: 'OPEN_METEO', url: null, confidence: 'low', dataType: 'wind_proxy',
      description: 'Open-Meteo wind-driven proxy — NOT a real current. Last resort only.' },
  ];

  const fallbackChain = [];
  const sources = forcedSource ? SOURCES.filter((s) => s.id === forcedSource) : SOURCES;
  if (sources.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown source: ${forcedSource}` }) };
  }

  const T0 = Date.now();
  const left = () => BUDGET_MS - (Date.now() - T0);

  for (const src of sources) {
    if (src.id === 'OPEN_METEO') {
      const t = Math.min(OPENMETEO_MAX_MS, left() - 300);
      if (t < MIN_ATTEMPT_MS) { fallbackChain.push({ source: src.id, reason: 'budget exhausted' }); break; }
      try {
        const grid = await fetchOpenMeteoGrid(bbox, date, t);
        if (!grid.length) throw new Error('Open-Meteo returned no usable points');
        return success(headers, {
          source: src.id, confidence: src.confidence, dataType: src.dataType,
          timestamp: date, bbox, resolution: 0.5, grid, fallbackChain,
          warning: 'Wind-driven proxy, NOT a measured current. Direction approximate.',
        });
      } catch (err) { fallbackChain.push({ source: src.id, reason: err.message }); break; }
    }

    // ERDDAP source — reserve time for the fallback unless a single source was forced
    const reserve = forcedSource ? 0 : OPENMETEO_RESERVE_MS;
    const t = Math.min(ERDDAP_MAX_MS, left() - reserve);
    if (t < MIN_ATTEMPT_MS) { fallbackChain.push({ source: src.id, reason: 'skipped (budget)' }); continue; }
    try {
      const resp = await fetch(src.url, { signal: AbortSignal.timeout(t) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.grid || data.grid.length === 0) throw new Error('Empty grid returned');
      return success(headers, {
        source: src.id, confidence: data.confidence || src.confidence,
        dataType: data.dataType || src.dataType, datasetId: data.datasetId,
        sourceLabel: data.source, timestamp: data.timestamp || date, staleDays: data.staleDays,
        bbox, resolution: data.resolution, grid: data.grid, fallbackChain,
      });
    } catch (err) {
      console.warn(`[currents-resolver] ${src.id} failed: ${err.message}`);
      fallbackChain.push({ source: src.id, reason: err.message });
    }
  }

  return { statusCode: 502, headers, body: JSON.stringify({ error: 'All current sources failed', fallbackChain }) };
};

// ── Open-Meteo last resort: ONE multi-coordinate request, capped grid ────────
async function fetchOpenMeteoGrid(bbox, date, timeoutMs) {
  const MAX_PER_AXIS = 8;
  const lats = sampleAxis(bbox.minLat, bbox.maxLat, MAX_PER_AXIS);
  const lons = sampleAxis(bbox.minLon, bbox.maxLon, MAX_PER_AXIS);
  const pts = [];
  for (const la of lats) for (const lo of lons) pts.push({ lat: la, lon: lo });
  if (!pts.length) throw new Error('Empty sample grid');

  const latParam = pts.map((p) => p.lat.toFixed(3)).join(',');
  const lonParam = pts.map((p) => p.lon.toFixed(3)).join(',');
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${latParam}&longitude=${lonParam}` +
    '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=UTC';

  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs || 4000) });
  if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
  const data = await resp.json();
  const arr = Array.isArray(data) ? data : [data];

  const WIND_DRAG = 0.02;
  const out = [];
  for (const loc of arr) {
    const lat = num(loc.latitude), lon = num(loc.longitude);
    const wspd = num(loc.current && loc.current.wind_speed_10m);
    const wdir = num(loc.current && loc.current.wind_direction_10m);
    if (lat === null || lon === null || wspd === null || wdir === null) continue;
    const ang = ((270 - wdir) * Math.PI) / 180;
    const u = wspd * WIND_DRAG * Math.cos(ang);
    const v = wspd * WIND_DRAG * Math.sin(ang);
    const speed = Math.sqrt(u * u + v * v);
    const dir = (Math.atan2(u, v) * 180) / Math.PI;
    out.push({ lat: round(lat, 3), lon: round(lon, 3), u: round(u, 4), v: round(v, 4),
               speed: round(speed, 4), dir: round((dir + 360) % 360, 1), windProxy: true });
  }
  return out;
}

function sampleAxis(min, max, maxN) {
  if (max <= min) return [round(min, 3)];
  const span = max - min;
  const n = Math.min(maxN, Math.max(2, Math.round(span / 0.25) + 1));
  const step = span / (n - 1);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(round(min + i * step, 3));
  return pts;
}

function num(x) { if (x === null || x === undefined) return null; const n = parseFloat(x); return Number.isFinite(n) ? n : null; }
function round(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }
function success(headers, body) {
  return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=1800' }, body: JSON.stringify(body) };
}
