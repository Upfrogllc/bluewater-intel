/**
 * currents-cmems-multiobs.js
 * Netlify Function — CMEMS MULTIOBS observation-fused surface current proxy
 *
 * CMEMS MULTIOBS (CMEMS_OBS_MOC_GLO_012_014) fuses:
 *   - Altimetry-derived geostrophic currents
 *   - Argo float drift observations
 *   - Surface drifter data
 * into a 1/4° daily field that is more "observation-honest" than GLO12.
 *
 * Use this as the validation/cross-check layer alongside GLO12.
 *
 * Query params:
 *   minLon, maxLon, minLat, maxLat  — bounding box
 *   date                            — ISO date (optional)
 *
 * Returns: { source, timestamp, bbox, resolution, grid: [ { lat, lon, u, v, speed, dir } ] }
 */

const CMEMS_BASE   = "https://nrt.cmems-du.eu/thredds/dodsC";
const PRODUCT_ID   = "cmems_obs_mob_glo_phy-cur_my_0.25deg_P1D-m"; // MULTIOBS daily
const STEP         = 0.25; // 1/4° grid

const CMEMS_USER   = process.env.CMEMS_USER;
const CMEMS_PASS   = process.env.CMEMS_PASS;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=7200", // MULTIOBS updates daily
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

  const date = p.date || new Date().toISOString().slice(0, 10);

  try {
    const latRange = buildRange(minLat, maxLat, STEP);
    const lonRange = buildRange(minLon, maxLon, STEP);
    const url      = buildMultiobsUrl(date, latRange, lonRange);

    const fetchOpts = {
      signal: AbortSignal.timeout(12000),
      headers: {
        Accept: "application/json",
        ...(CMEMS_USER && CMEMS_PASS
          ? { Authorization: "Basic " + Buffer.from(`${CMEMS_USER}:${CMEMS_PASS}`).toString("base64") }
          : {}),
      },
    };

    const resp = await fetch(url, fetchOpts);
    if (!resp.ok) throw new Error(`CMEMS MULTIOBS returned ${resp.status}: ${await resp.text()}`);

    const raw  = await resp.json();
    const grid = parseMultiobsResponse(raw, latRange, lonRange);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        source: "CMEMS_MULTIOBS",
        confidence: "high",
        dataType: "observation_fused",
        timestamp: date,
        bbox: { minLon, maxLon, minLat, maxLat },
        resolution: STEP,
        grid,
      }),
    };
  } catch (err) {
    console.error("[currents-cmems-multiobs] error:", err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message, source: "CMEMS_MULTIOBS" }),
    };
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRange(min, max, step) {
  const pts = [];
  for (let v = min; v <= max + step * 0.5; v += step) {
    pts.push(parseFloat(v.toFixed(3)));
  }
  return pts;
}

function buildMultiobsUrl(date, latRange, lonRange) {
  // MULTIOBS uses uo (eastward) and vo (northward) at surface (depth index 0)
  const latIdxMin = Math.round((Math.min(...latRange) + 90) / STEP);
  const latIdxMax = Math.round((Math.max(...latRange) + 90) / STEP);
  const lonIdxMin = Math.round((Math.min(...lonRange) + 180) / STEP);
  const lonIdxMax = Math.round((Math.max(...lonRange) + 180) / STEP);

  return (
    `${CMEMS_BASE}/${PRODUCT_ID}.ascii?` +
    `uo[0][0][${latIdxMin}:${latIdxMax}][${lonIdxMin}:${lonIdxMax}],` +
    `vo[0][0][${latIdxMin}:${latIdxMax}][${lonIdxMin}:${lonIdxMax}]`
  );
}

function parseMultiobsResponse(raw, latRange, lonRange) {
  const grid = [];
  const uArr = raw.uo || raw.u || [];
  const vArr = raw.vo || raw.v || [];

  let idx = 0;
  for (const lat of latRange) {
    for (const lon of lonRange) {
      const u     = Array.isArray(uArr[idx]) ? uArr[idx][0] : (uArr[idx] ?? 0);
      const v     = Array.isArray(vArr[idx]) ? vArr[idx][0] : (vArr[idx] ?? 0);
      const speed = Math.sqrt(u * u + v * v);
      const dir   = (Math.atan2(u, v) * 180) / Math.PI;

      grid.push({
        lat: parseFloat(lat.toFixed(3)),
        lon: parseFloat(lon.toFixed(3)),
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
