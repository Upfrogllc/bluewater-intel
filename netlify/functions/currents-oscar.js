/**
 * currents-oscar.js
 * Netlify Function — OSCAR satellite-derived current field proxy
 *
 * OSCAR (Ocean Surface Current Analyses Real-time) is a NASA/PODAAC product
 * giving 1° resolution surface currents derived from altimetry + wind + SST.
 * It has ~5-day latency but is fully observation-driven (no model physics).
 *
 * Access via PODAAC OPeNDAP — no auth required for the public dataset.
 * Dataset: OSCAR_L4_OC_FINAL_V2.0  (or OSCAR_L4_OC_NRT_V2.0 for near-real-time)
 *
 * Query params:
 *   minLon, maxLon, minLat, maxLat  — bounding box
 *   date                            — ISO date (optional, snaps to nearest 5-day cycle)
 *
 * Returns: { source, timestamp, bbox, resolution, grid: [ { lat, lon, u, v, speed, dir } ] }
 */

const PODAAC_BASE = "https://opendap.earthdata.nasa.gov/providers/PODAAC/collections";
const OSCAR_FINAL = "OSCAR_L4_OC_FINAL_V2.0";
const OSCAR_NRT   = "OSCAR_L4_OC_NRT_V2.0";
const OSCAR_STEP  = 1.0; // 1° grid

// NASA Earthdata auth (free account at https://urs.earthdata.nasa.gov)
const NASA_USER = process.env.NASA_EARTHDATA_USER;
const NASA_PASS = process.env.NASA_EARTHDATA_PASS;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=14400", // OSCAR updates every 5 days — 4h cache fine
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

  const requestedDate = p.date ? new Date(p.date) : new Date();
  const oscarDate = snapToOSCARCycle(requestedDate);

  try {
    // OSCAR provides u (eastward) and v (northward) surface currents
    // Try NRT first (more recent), fall back to FINAL (more reliable)
    let grid = null;
    let usedProduct = null;

    for (const product of [OSCAR_NRT, OSCAR_FINAL]) {
      try {
        const url = buildOSCARUrl(product, oscarDate, minLat, maxLat, minLon, maxLon);
        const resp = await fetchWithAuth(url);
        if (resp.ok) {
          const raw = await resp.json();
          grid = parseOSCARResponse(raw, minLat, maxLat, minLon, maxLon);
          usedProduct = product;
          break;
        }
      } catch (innerErr) {
        console.warn(`[currents-oscar] ${product} failed:`, innerErr.message);
      }
    }

    if (!grid) throw new Error("Both OSCAR NRT and FINAL endpoints failed");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        source: "OSCAR",
        product: usedProduct,
        confidence: "medium",
        dataType: "satellite_observation",
        observationLagDays: 5,
        timestamp: oscarDate.toISOString().slice(0, 10),
        bbox: { minLon, maxLon, minLat, maxLat },
        resolution: OSCAR_STEP,
        grid,
      }),
    };
  } catch (err) {
    console.error("[currents-oscar] error:", err.message);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: err.message, source: "OSCAR" }),
    };
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * OSCAR is produced on a 5-day cycle. Snap the requested date to the most
 * recent available cycle day (days 1, 6, 11, 16, 21, 26 of each month).
 */
function snapToOSCARCycle(date) {
  const cycleDays = [1, 6, 11, 16, 21, 26];
  const d = date.getDate();
  let best = 1;
  for (const cd of cycleDays) {
    if (cd <= d) best = cd;
  }
  return new Date(date.getFullYear(), date.getMonth(), best);
}

function buildOSCARUrl(product, date, minLat, maxLat, minLon, maxLon) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");

  // OPeNDAP granule URL pattern for OSCAR
  const granule = `oscar_vel${y}${m}${d}.nc.nc4`;
  const base = `${PODAAC_BASE}/${product}/granules/${granule}.dap.nc4`;

  // Subset using CE (Constraint Expression)
  const ce = encodeURIComponent(
    `u[0][0][${latToIdx(minLat)}:${latToIdx(maxLat)}][${lonToIdx(minLon)}:${lonToIdx(maxLon)}]` +
    `,v[0][0][${latToIdx(minLat)}:${latToIdx(maxLat)}][${lonToIdx(minLon)}:${lonToIdx(maxLon)}]`
  );

  return `${base}?dap4.ce=${ce}`;
}

// OSCAR grid: lat 80S–80N step 1°, lon 0–360 step 1°
function latToIdx(lat) { return Math.round(lat + 80); }
function lonToIdx(lon) { return Math.round(((lon % 360) + 360) % 360); }

async function fetchWithAuth(url) {
  const opts = { signal: AbortSignal.timeout(15000) };
  if (NASA_USER && NASA_PASS) {
    opts.headers = {
      Authorization: "Basic " + Buffer.from(`${NASA_USER}:${NASA_PASS}`).toString("base64"),
    };
  }
  return fetch(url, opts);
}

function parseOSCARResponse(raw, minLat, maxLat, minLon, maxLon) {
  const grid = [];
  // OSCAR response is a NetCDF4/JSON structure with lat/lon dimension arrays
  const lats = raw.lat || generateRange(minLat, maxLat, OSCAR_STEP);
  const lons = raw.lon || generateRange(minLon, maxLon, OSCAR_STEP);
  const uArr = raw.u || [];
  const vArr = raw.v || [];

  lats.forEach((lat, i) => {
    lons.forEach((lon, j) => {
      const u = (uArr[i] && uArr[i][j]) ?? 0; // m/s
      const v = (vArr[i] && vArr[i][j]) ?? 0;
      const speed = Math.sqrt(u * u + v * v);
      const dir = (Math.atan2(u, v) * 180) / Math.PI;
      grid.push({
        lat: parseFloat(lat.toFixed(2)),
        lon: parseFloat(((lon + 180) % 360 - 180).toFixed(2)), // normalise to -180/180
        u: parseFloat(u.toFixed(4)),
        v: parseFloat(v.toFixed(4)),
        speed: parseFloat(speed.toFixed(4)),
        dir: parseFloat(((dir + 360) % 360).toFixed(1)),
      });
    });
  });
  return grid;
}

function generateRange(min, max, step) {
  const r = [];
  for (let v = min; v <= max + step * 0.01; v += step) r.push(parseFloat(v.toFixed(2)));
  return r;
}
