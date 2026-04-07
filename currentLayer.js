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

    // Re-render arrows on zoom (spacing needs recalculating)
    this._map.on("zoomend", () => this._renderArrows());
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
    if (!this._currentData) return;

    // Remove old layer
    this._layer?.remove();
    this._layer = L.layerGroup().addTo(this._map);

    const grid = this._currentData;
    if (!grid.length) return;

    // Determine which grid points are visible at current zoom/spacing
    const visible = this._subsampleGrid(grid);
    const maxSpeed = Math.max(...visible.map((p) => p.speed), 0.01);

    visible.forEach((pt) => {
      const arrow = this._makeArrow(pt, maxSpeed);
      if (arrow) arrow.addTo(this._layer);
    });
  }

  /**
   * Subsample grid to avoid over-drawing at high zoom.
   * We want roughly one arrow per arrowSpacingPx screen pixels.
   */
  _subsampleGrid(grid) {
    const spacingPx = this._opts.arrowSpacingPx;
    const zoom = this._map.getZoom();

    // Degrees per pixel at current zoom (rough equator approximation)
    const degPerPx = 360 / (256 * Math.pow(2, zoom));
    const degSpacing = spacingPx * degPerPx;

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
  _makeArrow(pt, maxSpeed) {
    const { u, v, speed, dir, lat, lon } = pt;
    if (speed < 0.01) return null; // skip near-zero vectors

    const arrowScale = this._opts.arrowScale;
    const confidence = this._meta?.confidence || "low";

    // Arrow length in degrees (proportional to speed relative to max)
    const relSpeed = speed / maxSpeed;
    const arrowLenDeg = (speed * arrowScale) / 111000; // rough m/s → degrees

    // End point of arrow
    const endLat = lat + v * arrowLenDeg;
    const endLon = lon + u * arrowLenDeg;

    const color = {
      high:   "#1D9E75",
      medium: "#EF9F27",
      low:    "#E24B4A",
    }[confidence] || "#1D9E75";

    const opacity = 0.4 + relSpeed * 0.5; // faster = more opaque

    const polyline = L.polyline(
      [[lat, lon], [endLat, endLon]],
      { color, weight: 1.5 + relSpeed * 1.5, opacity }
    );

    // Arrowhead using a rotated marker
    const arrowIcon = L.divIcon({
      html: `<div style="
        width:0;height:0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-bottom: 8px solid ${color};
        transform: rotate(${dir}deg);
        opacity: ${opacity};
      "></div>`,
      iconSize: [8, 8],
      iconAnchor: [4, 4],
      className: "",
    });

    const marker = L.marker([endLat, endLon], { icon: arrowIcon, interactive: false });

    // Tooltip with vector info
    polyline.bindTooltip(formatTooltip(pt, this._meta), {
      sticky: true,
      direction: "top",
      className: "bw-current-tooltip",
    });

    return L.layerGroup([polyline, marker]);
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
