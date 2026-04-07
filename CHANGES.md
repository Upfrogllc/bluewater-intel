# BlueWater Intel — Improvement Changelog

## Summary of All Changes

This document details every fix, improvement, and architectural change made to the BlueWater Intel codebase.

---

## 🔒 Security Fixes

### 1. HMAC-SHA256 Auth Tokens (Critical)
**Before:** Token was `bwi_${YYYYMMDD}_${passcode.length}_${passcode.charCodeAt(0)}` — trivially guessable.
**After:** Token uses `crypto.createHmac('sha256', passcode).update('bwi:${date}').digest('hex')` — cryptographically secure.
**File:** `netlify/functions/claude.js`

### 2. AI Calls Routed Through Server (Critical)
**Before:** `runAnalysis()` called `api.anthropic.com` directly from the browser using a client-side API key stored in localStorage. Users had to obtain and manage their own key.
**After:** AI calls go to `/.netlify/functions/claude` with `type: 'analyze'`. The server-side function uses `process.env.ANTHROPIC_API_KEY`. No API key exposure to the client.
**Files:** `index.html` (runAnalysis), `netlify/functions/claude.js` (new 'analyze' route)

### 3. Brute-Force Protection on Auth
**Before:** No rate limiting — unlimited passcode attempts.
**After:** In-memory rate limiter: max 10 attempts per IP per minute. Returns 429 after limit.
**File:** `netlify/functions/claude.js`

### 4. Input Validation on All Endpoints
**Before:** No validation — raw user input passed to API calls.
**After:** All bounds, coordinates, dimensions are validated and clamped. Dataset names are URL-encoded. Dimensions capped at 2048px.
**File:** `netlify/functions/claude.js`

### 5. Removed Client API Key UI
**Before:** Header had an "API Key" button that opened a modal for entering `sk-ant-...` keys.
**After:** Removed entirely. The server handles API auth. No key management needed by users.
**File:** `index.html`

---

## 🐛 Bug Fixes

### 6. Duplicate Sidebar DOM (HTML Invalid)
**Before:** Two nested `<div id="sidebar">` elements — duplicate IDs cause undefined behavior.
**After:** Single `<div id="sidebar">` with all content properly nested.
**File:** `index.html`

### 7. Missing `#wx-body` Element (Weather Panel Broken)
**Before:** `renderWeather()` wrote to `document.getElementById('wx-body')` but no such element existed in the HTML. Weather tab showed nothing.
**After:** Added `<div id="wx-body">` inside `#wx-panel`.
**File:** `index.html`

### 8. Dead `applyImageFilter()` Function
**Before:** Referenced `satCtx` (old canvas renderer) which was removed during Leaflet migration. Would throw if called.
**After:** Removed the dead function. Image filtering logic consolidated into `imgToDataUrl()`.
**File:** `index.html`

### 9. Fragile CMEMS Value Parsing
**Before:** Used a simple regex that grabbed the first number from any text — including error messages.
**After:** New `parseCMEMSValue()` function that looks for standalone numeric values or "value = X" patterns, skipping error text.
**File:** `netlify/functions/claude.js`

### 10. JSON Parse Failure on AI Response
**Before:** `JSON.parse(rawText)` — fails if Claude includes any preamble text.
**After:** Extracts content between first `{` and last `}` before parsing. Falls back to a user-friendly error message.
**File:** `index.html` (runAnalysis)

---

## 🏗️ Architecture Improvements

### 11. BWI Namespace (Reduced Global Pollution)
**Before:** 50+ global functions and variables scattered across the window object.
**After:** All application logic wrapped in `window.BWI` IIFE. State centralized in `BWI.state`. Public functions exposed as `BWI.methodName()`. HTML onclick handlers use `BWI.toggleSat('chl')` etc.
**File:** `index.html`

### 12. Centralized State Object
**Before:** `currentGrid`, `detectedEddies`, `satLayers`, `selectedSpecies`, etc. were all independent global variables.
**After:** Single `BWI.state` object holds all mutable state. Makes it possible to reason about what changes when.
**File:** `index.html`

### 13. Netlify Function Restructured
**Before:** Single giant try/catch with nested if/else chains.
**After:** Clean helper functions (`ok()`, `err()`, `validateBounds()`, etc.). Each route is self-contained with early returns. Removed the catch-all Claude proxy at the bottom (was a security hole — would proxy any arbitrary Anthropic API call).
**File:** `netlify/functions/claude.js`

---

## ⚡ Performance Improvements

### 14. Satellite Bounds Caching
**Before:** Every map pan/zoom triggered a fresh satellite WMS fetch (600ms debounce, but still excessive).
**After:** `satCacheCoversView()` checks if the cached image still covers the viewport (with 20% margin). Only refetches when the user pans significantly outside the cached area or changes date.
**File:** `index.html`

### 15. Satellite Loading Indicator
**Before:** Satellite fetch (5-10 seconds) had no visible feedback on the map. Only a small text badge in the sidebar changed.
**After:** New `#sat-loading` overlay centered on the map with spinner and status message. Shows during fetch, hides on completion.
**File:** `index.html` (HTML + CSS + JS)

---

## 🎨 UI/UX Improvements

### 16. Cleaned CSS (Removed Duplicates)
**Before:** Multiple duplicate style blocks, dead canvas selectors (`#satCanvas`, `#mapCanvas`), redundant rules.
**After:** Single consolidated stylesheet. Removed all canvas-related display:none rules. Removed duplicate mobile media queries.
**File:** `index.html`

### 17. Mobile Panel Content
**Note:** The `mobileNav()` function using `cloneNode(true)` is still a known limitation — inline `onclick` attributes survive but JS-bound handlers don't. A proper fix would use event delegation on the mobile panel. This is flagged for future work.

---

## 📁 File Structure

```
bluewater-intel/
├── index.html                      # Main app (improved)
├── netlify/
│   └── functions/
│       └── claude.js               # Serverless function (hardened)
└── CHANGES.md                      # This file
```

## Future Recommendations

1. **Extract bathymetry data** to `bathy-data.js` (~60KB of JSON out of the main file)
2. **Extract CSS** to `styles.css` for cacheability
3. **Add event delegation** for mobile panel to fix cloned element interactivity
4. **Add service worker** for offline map tile caching
5. **Add WebSocket** for real-time current data instead of polling
6. **Consider React or Svelte** if the app continues growing — the single-file architecture is approaching its practical limit
