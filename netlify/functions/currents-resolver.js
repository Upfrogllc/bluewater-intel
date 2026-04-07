/**
 * currents-resolver.js
 * Netlify Function — Unified current waterfall orchestrator
 *
 * This is the single endpoint the frontend calls for current data.
 * It tries sources in priority order and returns the first successful result,
 * annotating the response with confidence metadata so the UI can show
 * data-trust labels (fresh / stale, obs / model, high / medium / low).
 *
 * Priority:
 *   1. CMEMS GLO12    — primary operational field (model, 6h analysis)
 *   2. CMEMS MULTIOBS — observation-fused validation field
 *   3. OSCAR          — satellite background field (5-day lag)
 *   4. Open-Meteo     — wind-proxy fallback (point-by-point, not a true current field)
 *
 * Query params:
 *   minLon, maxLon, minLat, maxLat  — bounding box
 *   date                            — ISO date (optional)
 *   source                          — force a specific source (optional, for UI source switcher)
 *
 * Returns:
 *   {
 *     source, confidence, dataType, staleDays,
 *     timestamp, bbox, resolution,
 *     grid: [ { lat, lon, u, v, speed, dir } ],
 *     fallbackChain: [ { source, reason } ]  // audit trail of skipped sources
 *   }
 */

const BASE_URL = process.env.URL || "https://your-site.netlify.app";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }

  const p = event.queryStringParameters || {};
  const bbox = {
    minLon: parseFloat(p.minLon),
    maxLon: parseFloat(p.maxLon),
    minLat: parseFloat(p.minLat),
    maxLat: parseFloat(p.maxLat),
  };
  const date = p.date || new Date().toISOString().slice(0, 10);
  const forcedSource = p.source || null;

  if (Object.values(bbox).some(isNaN)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "minLon, maxLon, minLat, maxLat required" }),
    };
  }

  const bboxQuery = `minLon=${bbox.minLon}&maxLon=${bbox.maxLon}&minLat=${bbox.minLat}&maxLat=${bbox.maxLat}&date=${date}`;

  // -------------------------------------------------------------------------
  // Source definitions — order is the priority waterfall
  // -------------------------------------------------------------------------
  const SOURCES = [
    {
      id: "CMEMS_GLO12",
      url: `${BASE_URL}/.netlify/functions/currents-cmems-glo12?${bboxQuery}`,
      confidence: "high",
      dataType: "model_analysis",
      description: "CMEMS GLO12 operational model (1/12°, 6h analysis)",
      maxStaleDays: 2,
    },
    {
      id: "CMEMS_MULTIOBS",
      url: `${BASE_URL}/.netlify/functions/currents-cmems-multiobs?${bboxQuery}`,
      confidence: "high",
      dataType: "observation_fused",
      description: "CMEMS MULTIOBS observation-fused surface currents",
      maxStaleDays: 3,
    },
    {
      id: "OSCAR",
      url: `${BASE_URL}/.netlify/functions/currents-oscar?${bboxQuery}`,
      confidence: "medium",
      dataType: "satellite_observation",
      description: "OSCAR satellite-derived currents (1°, 5-day lag)",
      maxStaleDays: 7,
    },
    {
      id: "OPEN_METEO",
      url: null, // handled inline — point fetch, not a real field
      confidence: "low",
      dataType: "wind_proxy",
      description: "Open-Meteo wind-driven surface proxy (fallback only)",
      maxStaleDays: 1,
    },
  ];

  // -------------------------------------------------------------------------
  // Waterfall logic
  // -------------------------------------------------------------------------
  const fallbackChain = [];
  const sources = forcedSource
    ? SOURCES.filter((s) => s.id === forcedSource)
    : SOURCES;

  for (const src of sources) {
    if (src.id === "OPEN_METEO") {
      // Last resort: build a sparse grid from Open-Meteo point fetches
      try {
        const grid = await fetchOpenMeteoGrid(bbox, date);
        return success(headers, {
          ...src,
          timestamp: date,
          bbox,
          resolution: 0.25,
          grid,
          fallbackChain,
          warning: "Open-Meteo is a wind proxy, not a true current observation. Use for rough direction only.",
        });
      } catch (err) {
        fallbackChain.push({ source: src.id, reason: err.message });
        break;
      }
    }

    try {
      const resp = await fetch(src.url, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (!data.grid || data.grid.length === 0) throw new Error("Empty grid returned");

      return success(headers, {
        ...src,
        timestamp: data.timestamp || date,
        bbox,
        resolution: data.resolution,
        grid: data.grid,
        fallbackChain,
      });
    } catch (err) {
      console.warn(`[currents-resolver] ${src.id} failed: ${err.message}`);
      fallbackChain.push({ source: src.id, reason: err.message });
    }
  }

  // All sources failed
  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({
      error: "All current sources failed",
      fallbackChain,
    }),
  };
};

// ---------------------------------------------------------------------------
// Open-Meteo fallback: sample a sparse grid of points
// Only used when all real current sources are down.
// Returns u/v derived from wind components (NOT a true ocean current).
// ---------------------------------------------------------------------------
async function fetchOpenMeteoGrid(bbox, date) {
  const GRID_STEP = 0.25; // ~25km sampling
  const points = [];

  for (let lat = bbox.minLat; lat <= bbox.maxLat + GRID_STEP * 0.5; lat += GRID_STEP) {
    for (let lon = bbox.minLon; lon <= bbox.maxLon + GRID_STEP * 0.5; lon += GRID_STEP) {
      points.push({ lat: parseFloat(lat.toFixed(2)), lon: parseFloat(lon.toFixed(2)) });
    }
  }

  // Batch fetch — Open-Meteo supports multi-point via ensemble API
  // For simplicity we fetch sequentially with a small concurrency limit
  const CONCURRENCY = 5;
  const results = [];

  for (let i = 0; i < points.length; i += CONCURRENCY) {
    const batch = points.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(batch.map((pt) => fetchOpenMeteoPoint(pt, date)));
    results.push(...fetched.filter(Boolean));
  }

  if (results.length === 0) throw new Error("Open-Meteo returned no data");
  return results;
}

async function fetchOpenMeteoPoint(pt, date) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?` +
      `latitude=${pt.lat}&longitude=${pt.lon}` +
      `&hourly=windspeed_10m,winddirection_10m` +
      `&wind_speed_unit=ms` +
      `&start_date=${date}&end_date=${date}` +
      `&timezone=UTC`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;
    const data = await resp.json();

    // Use the noon value as representative for the day
    const noonIdx = 12;
    const wspd = data.hourly?.windspeed_10m?.[noonIdx] ?? 0;
    const wdir = data.hourly?.winddirection_10m?.[noonIdx] ?? 0;

    // Surface current is very roughly 2-3% of 10m wind (Ekman approximation)
    // This is a coarse proxy — clearly flagged as low confidence
    const WIND_DRAG_RATIO = 0.025;
    const wdirRad = ((270 - wdir) * Math.PI) / 180; // met convention → oceanographic
    const u = wspd * WIND_DRAG_RATIO * Math.cos(wdirRad);
    const v = wspd * WIND_DRAG_RATIO * Math.sin(wdirRad);
    const speed = Math.sqrt(u * u + v * v);
    const dir = (Math.atan2(u, v) * 180) / Math.PI;

    return {
      lat: pt.lat,
      lon: pt.lon,
      u: parseFloat(u.toFixed(4)),
      v: parseFloat(v.toFixed(4)),
      speed: parseFloat(speed.toFixed(4)),
      dir: parseFloat(((dir + 360) % 360).toFixed(1)),
      windProxy: true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
function success(headers, body) {
  return {
    statusCode: 200,
    headers: { ...headers, "Cache-Control": "public, max-age=1800" },
    body: JSON.stringify(body),
  };
}
