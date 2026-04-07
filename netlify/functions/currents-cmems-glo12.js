/**
 * currents-cmems-glo12.js
 * Netlify Function — CMEMS GLO12 current field proxy
 *
 * Returns a grid of U/V current vectors for a bounding box.
 * Uses the CMEMS Marine Data Store OGC API (no Copernicus login required for
 * the free GLO12 analysis product — only the forecast tail needs a token).
 *
 * Query params:
 *   minLon, maxLon, minLat, maxLat  — bounding box (decimal degrees)
 *   date                            — ISO date string, e.g. "2024-06-15" (optional, defaults to latest)
 *   depth                           — depth level in metres (optional, default 0 = surface)
 *
 * Returns JSON:
 *   { source, timestamp, bbox, resolution, grid: [ { lat, lon, u, v, speed, dir } ] }
 */

const CMEMS_BASE = "https://nrt.cmems-du.eu/thredds/dodsC";
const PRODUCT_ID = "cmems_mod_glo_phy_anfc_0.083deg_P1D-m"; // GLO12 daily analysis

// CMEMS requires an auth token for NRT products. Store in Netlify env.
// Sign up free at https://marine.copernicus.eu
const CMEMS_USER = process.env.CMEMS_USER;
const CMEMS_PASS = process.env.CMEMS_PASS;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=3600", // GLO12 updates daily — 1h cache is fine
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  const p = event.queryStringParameters || {};
  const minLon = parseFloat(p.minLon);
  const maxLon = parseFloat(p.maxLon);
  const minLat = parseFloat(p.minLat);
  const maxLat = parseFloat(p.maxLat);

  if ([minLon, maxLon, minLat, maxLat].some(isNaN)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "minLon, maxLon, minLat, maxLat are required" }),
    };
  }

  // Clamp box — GLO12 global grid is 0.083° resolution
  const STEP = 0.083;
  const depth = parseFloat(p.depth) || 0;
  const date = p.date || new Date().toISOString().slice(0, 10);

  try {
    // Build OPeNDAP URL for subsetting uo (eastward current) and vo (northward current)
    // Format: variable[time][depth][lat][lon]
    // GLO12 depth index 0 = surface (~0.494m)
    const lonRange = buildRange(minLon, maxLon, STEP);
    const latRange = buildRange(minLat, maxLat, STEP);

    const url = buildOPeNDAPUrl(PRODUCT_ID, date, depth, latRange, lonRange);

    const authHeader =
      CMEMS_USER && CMEMS_PASS
        ? "Basic " + Buffer.from(`${CMEMS_USER}:${CMEMS_PASS}`).toString("base64")
        : null;

    const fetchOpts = {
      headers: {
        Accept: "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      signal: AbortSignal.timeout(12000),
    };

    const resp = await fetch(url, fetchOpts);

    if (!resp.ok) {
      throw new Error(`CMEMS returned ${resp.status}: ${await resp.text()}`);
    }

    const raw = await resp.json();
    const grid = parseGLO12Response(raw, latRange, lonRange);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        source: "CMEMS_GLO12",
        confidence: "high",
        dataType: "model_analysis",
        timestamp: date,
        bbox: { minLon, maxLon, minLat, maxLat },
        resolution: STEP,
        depthM: depth,
        grid,
      }),
    };
  } catch (err) {
    console.error("[currents-cmems-glo12] error:", err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message, source: "CMEMS_GLO12" }),
    };
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRange(min, max, step) {
  const pts = [];
  for (let v = min; v <= max + step * 0.5; v += step) {
    pts.push(parseFloat(v.toFixed(4)));
  }
  return pts;
}

function buildOPeNDAPUrl(productId, date, depthM, latRange, lonRange) {
  // Convert depth in metres to GLO12 depth index (surface levels: 0.49, 1.54, 2.65, ...)
  const depthIdx = depthToIndex(depthM);

  // OPeNDAP ASCII endpoint with variable subsetting
  // lat/lon ranges expressed as [min:step:max] in index space for GLO12 grid
  const latIdxMin = latToIndex(Math.min(...latRange));
  const latIdxMax = latToIndex(Math.max(...latRange));
  const lonIdxMin = lonToIndex(Math.min(...lonRange));
  const lonIdxMax = lonToIndex(Math.max(...lonRange));

  return (
    `${CMEMS_BASE}/${productId}.ascii?` +
    `uo[0][${depthIdx}][${latIdxMin}:${latIdxMax}][${lonIdxMin}:${lonIdxMax}],` +
    `vo[0][${depthIdx}][${latIdxMin}:${latIdxMax}][${lonIdxMin}:${lonIdxMax}]`
  );
}

// GLO12 grid: lon starts at -180, step 0.0833°; lat starts at -80, step 0.0833°
function lonToIndex(lon) {
  return Math.round((lon + 180) / 0.0833);
}
function latToIndex(lat) {
  return Math.round((lat + 80) / 0.0833);
}
function depthToIndex(depthM) {
  // GLO12 standard depth levels (metres) — index 0 = surface
  const levels = [0.494, 1.541, 2.646, 3.819, 5.078, 6.441, 7.929, 9.573];
  let best = 0;
  let bestDiff = Infinity;
  levels.forEach((d, i) => {
    const diff = Math.abs(d - depthM);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  });
  return best;
}

function parseGLO12Response(raw, latRange, lonRange) {
  // OPeNDAP ASCII response is a flat array — parse into grid points
  // In production, consider using the WMS/WCS endpoint for easier JSON parsing
  const grid = [];
  const uArr = raw.uo || raw.u || [];
  const vArr = raw.vo || raw.v || [];
  let idx = 0;
  for (const lat of latRange) {
    for (const lon of lonRange) {
      const u = uArr[idx] ?? 0; // m/s eastward
      const v = vArr[idx] ?? 0; // m/s northward
      const speed = Math.sqrt(u * u + v * v);
      const dir = (Math.atan2(u, v) * 180) / Math.PI;
      grid.push({
        lat: parseFloat(lat.toFixed(4)),
        lon: parseFloat(lon.toFixed(4)),
        u: parseFloat(u.toFixed(4)),
        v: parseFloat(v.toFixed(4)),
        speed: parseFloat(speed.toFixed(4)),
        dir: parseFloat(((dir + 360) % 360).toFixed(1)),
      });
      idx++;
    }
  }
  return grid;
}
