// sat-tiles.js — Satellite image tile proxy
// Fetches satellite imagery from CoastWatch ERDDAP and returns as base64
// Supports SST and CHL datasets with date fallback chain

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, x-bw-token',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { dataset, date, south, north, west, east, width = 600, height = 400 } = body;
  if (!dataset || !date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'dataset and date required' }) };

  const DATASETS = {
    noaa20_sst:     { erddap: 'nesdisVHNnoaa20SSTasNRT',    var: 'analysed_sst', palette: 'KT_thermal', min: 22, max: 32, log: false, label: 'NOAA-20 VIIRS SST',    unit: '°C', type: 'sst' },
    snpp_sst:       { erddap: 'nesdisVHNnoaaSNPPSSTasNRT',  var: 'analysed_sst', palette: 'KT_thermal', min: 22, max: 32, log: false, label: 'SNPP VIIRS SST',       unit: '°C', type: 'sst' },
    mur_sst:        { erddap: 'jplMURSST41',                 var: 'analysed_sst', palette: 'KT_thermal', min: 22, max: 32, log: false, label: 'MUR L4 SST (1km)',    unit: '°C', type: 'sst' },
    noaa20_chl:     { erddap: 'nesdisVHNnoaa20CHLasNRT',    var: 'chlor_a',      palette: 'Rainbow2',   min: 0.01, max: 10, log: true,  label: 'NOAA-20 Chlorophyll', unit: 'mg/m³', type: 'chl' },
    snpp_chl:       { erddap: 'nesdisVHNnoaaSNPPCHLasNRT',  var: 'chlor_a',      palette: 'Rainbow2',   min: 0.01, max: 10, log: true,  label: 'SNPP Chlorophyll',    unit: 'mg/m³', type: 'chl' },
    noaa20_chl_8d:  { erddap: 'nesdisVHNnoaa20CHL8day',     var: 'chlor_a',      palette: 'Rainbow2',   min: 0.01, max: 10, log: true,  label: 'NOAA-20 CHL 8-day',  unit: 'mg/m³', type: 'chl' },
  };

  const ds = DATASETS[dataset];
  if (!ds) return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown dataset: ${dataset}` }) };

  // Bbox defaults to SE Florida + offshore if not specified
  const s = parseFloat(south ?? 24.0);
  const n = parseFloat(north ?? 31.0);
  const w = parseFloat(west ?? -83.0);
  const e = parseFloat(east ?? -78.0);

  const timeout = ms => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));

  // Try up to 5 days back (NRT has 1-2 day lag, some datasets 3+)
  const tryDates = [];
  const baseDate = new Date(date + 'T12:00:00Z');
  for (let i = 0; i <= 5; i++) {
    const d = new Date(baseDate.getTime() - i * 86400000);
    tryDates.push(d.toISOString().slice(0, 10));
  }

  for (const tryDate of tryDates) {
    const timeStr = `${tryDate}T12:00:00Z`;
    const logStr = ds.log ? 'Log' : '';
    
    const url = `https://coastwatch.pfeg.noaa.gov/erddap/griddap/${ds.erddap}.png` +
      `?${ds.var}%5B(${timeStr})%5D%5B(${s.toFixed(2)}):(${n.toFixed(2)})%5D%5B(${w.toFixed(2)}):(${e.toFixed(2)})%5D` +
      `&.draw=surface&.vars=longitude%7Clatitude%7C${ds.var}` +
      `&.colorBar=${ds.palette}%7C%7C${logStr}%7C${ds.min}%7C${ds.max}%7C` +
      `&.bgColor=0x000000FF&.size=${width}%7C${height}`;

    try {
      const res = await Promise.race([
        fetch(url, { headers: { 'User-Agent': 'BlueWaterIntel/1.0' } }),
        timeout(12000)
      ]);

      if (!res.ok) continue;
      
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('image') && !ct.includes('png')) continue;

      const buf = await res.arrayBuffer();
      if (buf.byteLength < 5000) continue; // Too small = likely error image

      // Netlify has a 6MB response limit — reject if image is too large
      if (buf.byteLength > 4 * 1024 * 1024) {
        console.warn(`Image too large: ${buf.byteLength} bytes for ${dataset}`);
        continue; // Try next date (different time = different extent)
      }

      const base64 = Buffer.from(buf).toString('base64');
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          image: `data:image/png;base64,${base64}`,
          dataset,
          label: ds.label,
          type: ds.type,
          date: tryDate,
          requested_date: date,
          stale_days: tryDates.indexOf(tryDate),
          bbox: { south: s, north: n, west: w, east: e },
          size: buf.byteLength,
        })
      };
    } catch(e) {
      continue;
    }
  }

  return {
    statusCode: 404,
    headers,
    body: JSON.stringify({ error: `No data available for ${dataset} in the last 5 days`, dataset })
  };
};
