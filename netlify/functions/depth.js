// depth.js — Netlify function for accurate point depth lookup
// Queries NOAA's real bathymetry services in order of accuracy:
// 1. NOAA Nautical Charts WMS (ENC data — chart plotter quality)
// 2. NOAA Coastal Relief Model via NGDC (90m resolution)  
// 3. GEBCO 2023 via ERDDAP (450m, global)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, x-bw-token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { lat, lng } = body;
  if (lat == null || lng == null) return { statusCode: 400, headers, body: JSON.stringify({ error: 'lat/lng required' }) };

  const la = parseFloat(lat), ln = parseFloat(lng);
  const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

  // ── Source 1: NOAA NCEI Bathymetric Data Viewer (NOS Hydrographic Surveys) ──
  // This is the same data used in NOAA chart plotters
  try {
    const url = `https://gis.ngdc.noaa.gov/arcgis/rest/services/web_mercator/multibeam_mosaic/ImageServer/identify` +
      `?geometry=${ln},${la}&geometryType=esriGeometryPoint&returnGeometry=false&f=json`;
    const res = await Promise.race([fetch(url), timeout(4000)]);
    if (res.ok) {
      const data = await res.json();
      const val = parseFloat(data?.value);
      if (!isNaN(val) && val < 0) {
        return { statusCode: 200, headers, body: JSON.stringify({
          depth_ft: Math.round(Math.abs(val) * 3.28084),
          depth_m: Math.round(Math.abs(val)),
          source: 'NOAA Multibeam Mosaic',
          accuracy: 'high'
        })};
      }
    }
  } catch(e) { /* try next */ }

  // ── Source 2: NOAA NOS Bathymetric Attributed Grid (BAG) ──
  try {
    const url = `https://gis.ngdc.noaa.gov/arcgis/rest/services/bag_mosaic/ImageServer/identify` +
      `?geometry=${ln},${la}&geometryType=esriGeometryPoint&returnGeometry=false&f=json`;
    const res = await Promise.race([fetch(url), timeout(4000)]);
    if (res.ok) {
      const data = await res.json();
      const val = parseFloat(data?.value);
      if (!isNaN(val) && val < 0) {
        return { statusCode: 200, headers, body: JSON.stringify({
          depth_ft: Math.round(Math.abs(val) * 3.28084),
          depth_m: Math.round(Math.abs(val)),
          source: 'NOAA BAG Mosaic',
          accuracy: 'high'
        })};
      }
    }
  } catch(e) { /* try next */ }

  // ── Source 3: NOAA Coastal Relief Model (CRM) — 90m resolution ──
  // Best freely available US coastal bathymetry
  try {
    const url = `https://gis.ngdc.noaa.gov/arcgis/rest/services/DEM_global_mosaic_hillshade/ImageServer/identify` +
      `?geometry=%7B"x":${ln},"y":${la},"spatialReference":%7B"wkid":4326%7D%7D` +
      `&geometryType=esriGeometryPoint&returnGeometry=false&f=json`;
    const res = await Promise.race([fetch(url), timeout(5000)]);
    if (res.ok) {
      const data = await res.json();
      const val = parseFloat(data?.value);
      if (!isNaN(val) && val < 0) {
        return { statusCode: 200, headers, body: JSON.stringify({
          depth_ft: Math.round(Math.abs(val) * 3.28084),
          depth_m: Math.round(Math.abs(val)),
          source: 'NOAA CRM',
          accuracy: 'medium'
        })};
      }
    }
  } catch(e) { /* try next */ }

  // ── Source 4: GEBCO 2023 via CoastWatch ERDDAP — 450m, global ──
  try {
    const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/gebco_2022.json` +
      `?elevation%5B(${la.toFixed(4)})%5D%5B(${ln.toFixed(4)})%5D`;
    const res = await Promise.race([fetch(url), timeout(5000)]);
    if (res.ok) {
      const data = await res.json();
      const rows = data?.table?.rows;
      if (rows?.length > 0) {
        const elev = parseFloat(rows[0][rows[0].length - 1]);
        if (!isNaN(elev) && elev < 0) {
          return { statusCode: 200, headers, body: JSON.stringify({
            depth_ft: Math.round(Math.abs(elev) * 3.28084),
            depth_m: Math.round(Math.abs(elev)),
            source: 'GEBCO 2023',
            accuracy: 'low'
          })};
        }
      }
    }
  } catch(e) { /* try next */ }

  // ── Source 5: ETOPO1 via CoastWatch — 1.8km fallback ──
  try {
    const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json` +
      `?altitude%5B(${la.toFixed(4)})%5D%5B(${ln.toFixed(4)})%5D`;
    const res = await Promise.race([fetch(url), timeout(5000)]);
    if (res.ok) {
      const data = await res.json();
      const rows = data?.table?.rows;
      if (rows?.length > 0) {
        const elev = parseFloat(rows[0][rows[0].length - 1]);
        if (!isNaN(elev) && elev < 0) {
          return { statusCode: 200, headers, body: JSON.stringify({
            depth_ft: Math.round(Math.abs(elev) * 3.28084),
            depth_m: Math.round(Math.abs(elev)),
            source: 'ETOPO1',
            accuracy: 'very-low'
          })};
        }
      }
    }
  } catch(e) { /* exhausted all sources */ }

  return { statusCode: 404, headers, body: JSON.stringify({ error: 'No depth data available for this location' }) };
};
