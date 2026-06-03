/**
 * currentLayer.js
 * BlueWater Intel V2 — Frontend current data module
 *
 * Replaces the V1 approach of point-fetching per arrow with a proper
 * field-based system. One call to the resolver returns the full grid
 * for the visible bbox, which we then render as a vector field overlay.
 *
 * Usage:
 *   import { CurrentLayer } from './currentLayer.js';
 *   const layer = new CurrentLayer(map, { onConfidenceChange: (meta) => updateBadge(meta) });
 *   layer.refresh(); // call on map move/zoom end
 *   layer.forceSource('OSCAR'); // optional: override the waterfall
 */

const RESOLVER_URL = "/.netlify/functions/currents-resolver";

// ─── Confidence badge labels ────────────────────────────────────────────────
const CONFIDENCE_LABELS = {
  high:   { label: "High confidence", color: "#1D9E75", textColor: "#fff" },
  medium: { label: "Obs-validated",   color: "#BA7517", textColor: "#fff" },
  low:    { label: "Wind proxy only", color: "#E24B4A", textColor: "#fff" },
};

const DATA_TYPE_LABELS = {
  model_analysis:    "Model analysis",
  observation_fused: "Observation-fused",
  satellite_observation: "Satellite obs",
  wind_proxy:        "Wind proxy (fallback)",
};

// ─── CurrentLayer class ──────────────────────────────────────────────────────
export class CurrentLayer {
  /**
   * @param {L.Map} map — Leaflet map instance
   * @param {Object} options
   * @param {Function} [options.onConfidenceChange] — called with metadata when source changes
   * @param {number}   [options.arrowSpacingPx=60]  — pixel spacing between arrows
   * @param {number}   [options.arrowScale=800]      — tuning factor for arrow length
   * @param {string}   [options.forcedSource=null]   — override source waterfall
   */
  constructor(map, options = {}) {
    this._map = map;
    this._opts = {
      arrowSpacingPx: 60,
      arrowScale: 800,
      forcedSource: null,
      onConfidenceChange: () => {},
      ...options,
    };

    this._layer = null;       // L.LayerGroup holding current arrows
    this._currentData = null; // raw grid from last fetch
    this._meta = null;        // source metadata from last fetch
    this._loading = false;
    this._abortController = null;

    // ── Color-by-speed range (knots). The spectrum stretches across [min,max]. ──
    this._colorMinKt = (options.colorMinKt != null) ? options.colorMinKt : 0.10;
    this._colorMaxKt = (options.colorMaxKt != null) ? options.colorMaxKt : 3.00;
    this._ctrl = null;
    try { window.__bwCurRange = { minKt: this._colorMinKt, maxKt: this._colorMaxKt }; } catch(e){}

    // Re-render arrows on zoom (spacing needs recalculating)
    this._map.on("zoomend", () => this._renderArrows());

    // Inject the speed legend + range filter control
    this._buildControl();
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /** Fetch current field for visible bbox, trigger render */
  async refresh() {
    if (this._loading) {
      // Cancel any in-flight request
      this._abortController?.abort();
    }

    const bounds = this._map.getBounds();
    const bbox = {
      minLon: bounds.getWest().toFixed(4),
      maxLon: bounds.getEast().toFixed(4),
      minLat: bounds.getSouth().toFixed(4),
      maxLat: bounds.getNorth().toFixed(4),
    };
    const today = new Date().toISOString().slice(0, 10);

    const params = new URLSearchParams({
      ...bbox,
      date: today,
      ...(this._opts.forcedSource ? { source: this._opts.forcedSource } : {}),
    });

    this._loading = true;
    this._abortController = new AbortController();

    try {
      const resp = await fetch(`${RESOLVER_URL}?${params}`, {
        signal: this._abortController.signal,
      });

      if (!resp.ok) throw new Error(`Resolver returned ${resp.status}`);
      const data = await resp.json();

      this._currentData = data.grid;
      this._meta = {
        source:      data.source,
        confidence:  data.confidence,
        dataType:    data.dataType,
        timestamp:   data.timestamp,
        resolution:  data.resolution,
        fallbackChain: data.fallbackChain || [],
        warning:     data.warning || null,
        staleDays:   computeStaleDays(data.timestamp),
      };

      this._opts.onConfidenceChange(this._meta);
      this._renderArrows();
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("[CurrentLayer] fetch failed:", err.message);
      }
    } finally {
      this._loading = false;
    }
  }

  /** Force a specific source and refresh */
  forceSource(sourceId) {
    this._opts.forcedSource = sourceId || null;
    this.refresh();
  }

  /** Remove current layer from map */
  remove() {
    this._layer?.remove();
    this._layer = null;
  }

  /** Get current metadata (source, confidence, etc.) */
  get metadata() {
    return this._meta;
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  _renderArrows() {
    // The dense canvas "Live Currents" layer (drawCurrentOverlay in the app) is the
    // visible vector field now. This module no longer draws its own sparse arrows —
    // it just supplies the speed legend/range control and the confidence badge.
    this._layer?.remove();
    this._layer = null;
  }

  /** Degrees-per-arrow at the current zoom (rough equator approximation) */
  _degSpacing() {
    const zoom = this._map.getZoom();
    const degPerPx = 360 / (256 * Math.pow(2, zoom));
    return this._opts.arrowSpacingPx * degPerPx;
  }

  /**
   * Subsample grid to avoid over-drawing at high zoom.
   * We want roughly one arrow per arrowSpacingPx screen pixels.
   */
  _subsampleGrid(grid, degSpacing) {
    // Build a set of snapped grid keys to deduplicate
    const seen = new Set();
    return grid.filter((pt) => {
      const latSnap = Math.round(pt.lat / degSpacing);
      const lonSnap = Math.round(pt.lon / degSpacing);
      const key = `${latSnap}_${lonSnap}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Create a Leaflet arrow marker for a current vector.
   * Arrow length scaled to speed, colour to confidence tier.
   */
  _makeArrow(pt, degSpacing) {
    const { u, v, speed, dir, lat, lon } = pt;
    if (speed < 0.001) return null;

    // Speed in knots — both the range filter and the color mapping work in knots
    const kt = speed * 1.94384;
    const min = this._colorMinKt, max = this._colorMaxKt;
    if (kt < min) return null;                          // FILTER: hide below-range water
    let pos = (max > min) ? (kt - min) / (max - min) : 1;
    if (pos < 0) pos = 0; if (pos > 1) pos = 1;         // clamp above-range to top color
    const color = speedColor(pos);

    // FIXED length (direction only) — color now carries speed, not size
    const arrowLenDeg = degSpacing * 0.62;
    const sp = speed || 1e-6;
    const ux = u / sp, uy = v / sp;
    const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
    const endLat = lat + uy * arrowLenDeg;
    const endLon = lon + (ux * arrowLenDeg) / cosLat;

    const polyline = L.polyline(
      [[lat, lon], [endLat, endLon]],
      { color, weight: 2.4, opacity: 0.95 }
    );

    const arrowIcon = L.divIcon({
      html: `<div style="
        width:0;height:0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-bottom: 9px solid ${color};
        transform: rotate(${dir}deg);
      "></div>`,
      iconSize: [8, 8],
      iconAnchor: [4, 4],
      className: "",
    });
    const marker = L.marker([endLat, endLon], { icon: arrowIcon, interactive: false });

    polyline.bindTooltip(formatTooltip(pt, this._meta), {
      sticky: true, direction: "top", className: "bw-current-tooltip",
    });

    return L.layerGroup([polyline, marker]);
  }

  // ─── Speed legend + 0.10–5.00 kt range filter control ────────────────────
  _buildControl() {
    if (this._ctrl || typeof document === "undefined") return;
    const wrap = document.createElement("div");
    wrap.id = "bw-cur-ctrl";
    wrap.innerHTML = `
      <style>
        #bw-cur-ctrl{position:absolute;left:12px;bottom:112px;z-index:600;width:210px;
          background:rgba(8,18,28,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
          border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:10px 11px;color:#eaf2f5;
          font-family:'Inter',system-ui,sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.4);user-select:none}
        #bw-cur-ctrl .t{font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:#16d6c3;
          font-weight:700;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center}
        #bw-cur-ctrl .bar{height:11px;border-radius:6px;margin:7px 0 3px;
          background:linear-gradient(90deg,#2b6cff,#00cfe5,#1fd86b,#ffd23f,#ff8c1a,#ff2d2d)}
        #bw-cur-ctrl .lab{display:flex;justify-content:space-between;font-size:10px;color:#9fb3bd;
          font-family:'Space Mono',monospace}
        #bw-cur-ctrl .row{display:flex;align-items:center;gap:7px;margin-top:8px;font-size:10px;color:#cfe0e6}
        #bw-cur-ctrl .row b{width:24px;font-weight:600;color:#9fb3bd}
        #bw-cur-ctrl .row span{width:30px;text-align:right;font-family:'Space Mono',monospace;color:#16d6c3}
        #bw-cur-ctrl input[type=range]{flex:1;height:3px;accent-color:#16d6c3;cursor:pointer}
        #bw-cur-ctrl .hint{font-size:9px;color:#7f97a2;margin-top:7px;line-height:1.35}
      </style>
      <div class="t"><span>Current speed</span><span style="color:#9fb3bd;font-weight:400">knots</span></div>
      <div class="bar"></div>
      <div class="lab"><span id="bw-cur-lmin">0.10</span><span id="bw-cur-lmid">—</span><span id="bw-cur-lmax">3.00</span></div>
      <div class="row"><b>min</b><input type="range" id="bw-cur-min" min="0.10" max="5.00" step="0.10" value="${this._colorMinKt.toFixed(2)}"><span id="bw-cur-vmin">${this._colorMinKt.toFixed(2)}</span></div>
      <div class="row"><b>max</b><input type="range" id="bw-cur-max" min="0.10" max="5.00" step="0.10" value="${this._colorMaxKt.toFixed(2)}"><span id="bw-cur-vmax">${this._colorMaxKt.toFixed(2)}</span></div>
      <div class="hint">Color = speed across your range. Arrows below min are hidden; above max show the top color.</div>
    `;
    const host = document.getElementById("mapwrap") || document.body;
    try { if (getComputedStyle(host).position === "static") host.style.position = "relative"; } catch(e){}
    host.appendChild(wrap);
    this._ctrl = wrap;

    const minEl = wrap.querySelector("#bw-cur-min");
    const maxEl = wrap.querySelector("#bw-cur-max");
    const sync = (changed) => {
      let lo = parseFloat(minEl.value), hi = parseFloat(maxEl.value);
      if (lo > hi) {
        if (changed === "min") { hi = lo; maxEl.value = hi.toFixed(2); }
        else { lo = hi; minEl.value = lo.toFixed(2); }
      }
      this._colorMinKt = lo; this._colorMaxKt = hi;
      this._updateLegend();
      try { window.__bwCurRange = { minKt: lo, maxKt: hi }; } catch(e){}
    };
    minEl.addEventListener("input", () => sync("min"));
    maxEl.addEventListener("input", () => sync("max"));
    this._updateLegend();
  }

  _updateLegend() {
    if (!this._ctrl) return;
    const lo = this._colorMinKt, hi = this._colorMaxKt, mid = (lo + hi) / 2;
    const set = (id, val) => { const e = this._ctrl.querySelector(id); if (e) e.textContent = val; };
    set("#bw-cur-vmin", lo.toFixed(2)); set("#bw-cur-vmax", hi.toFixed(2));
    set("#bw-cur-lmin", lo.toFixed(2)); set("#bw-cur-lmid", mid.toFixed(2)); set("#bw-cur-lmax", hi.toFixed(2));
  }
}

// ─── Confidence badge builder ────────────────────────────────────────────────

/**
 * Build an HTML badge element for the map UI.
 * Call this whenever onConfidenceChange fires.
 */
export function buildConfidenceBadge(meta) {
  if (!meta) return "";
  const conf = CONFIDENCE_LABELS[meta.confidence] || CONFIDENCE_LABELS.low;
  const dtLabel = DATA_TYPE_LABELS[meta.dataType] || meta.dataType;
  const staleText = meta.staleDays > 0 ? `${meta.staleDays}d old` : "current";
  const warningHtml = meta.warning
    ? `<div class="bw-badge-warning">⚠ ${meta.warning}</div>`
    : "";

  return `
    <div class="bw-confidence-badge" style="border-left: 3px solid ${conf.color}">
      <div class="bw-badge-source">${meta.source.replace("_", " ")}</div>
      <div class="bw-badge-conf" style="color:${conf.color}">${conf.label}</div>
      <div class="bw-badge-meta">${dtLabel} · ${staleText}</div>
      ${warningHtml}
    </div>
  `;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

// Speed → spectrum color. pos in [0,1] maps blue → cyan → green → yellow → orange → red.
function speedColor(pos){
  const stops = [
    [0.00,[43,108,255]],[0.20,[0,207,229]],[0.40,[31,216,107]],
    [0.60,[255,210,63]],[0.80,[255,140,26]],[1.00,[255,45,45]],
  ];
  if (pos <= 0) return rgbStr(stops[0][1]);
  if (pos >= 1) return rgbStr(stops[stops.length-1][1]);
  for (let i=1;i<stops.length;i++){
    if (pos <= stops[i][0]){
      const p0=stops[i-1][0], c0=stops[i-1][1], p1=stops[i][0], c1=stops[i][1];
      const t=(pos-p0)/(p1-p0);
      return rgbStr([
        Math.round(c0[0]+(c1[0]-c0[0])*t),
        Math.round(c0[1]+(c1[1]-c0[1])*t),
        Math.round(c0[2]+(c1[2]-c0[2])*t),
      ]);
    }
  }
  return rgbStr(stops[stops.length-1][1]);
}
function rgbStr(a){ return `rgb(${a[0]},${a[1]},${a[2]})`; }

function computeStaleDays(timestamp) {
  if (!timestamp) return 0;
  const then = new Date(timestamp);
  const now  = new Date();
  return Math.floor((now - then) / 86400000);
}

function formatTooltip(pt, meta) {
  const kts = (pt.speed * 1.944).toFixed(2); // m/s → knots
  const src  = meta?.source || "unknown";
  const conf = meta?.confidence || "?";
  return `
    <div class="bw-tooltip">
      <strong>${kts} kts</strong> · ${pt.dir.toFixed(0)}°<br>
      <small>${src} · ${conf} confidence</small>
    </div>
  `;
}
