# Heatmap Refactor — Implementation Plan
**Date:** 2026-02-24

## Overview

Replace neighbourhood-based colouring with a grid-based heatmap. Each user submission stores two split polygons (east/west). To visualise results, we rasterise all stored polygons onto an 80×80 grid and render per-cell east/west percentages as a canvas overlay.

---

## Phase 1 — City Boundary + Mask

**Goal:** Load `data/toronto-boundary.geojson` and render the Toronto area with a mask outside.

### Steps

1. In `app.js`, replace `loadNeighbourhoods()` with `loadBoundary()`:
   ```js
   async function loadBoundary() {
     const res = await fetch('data/toronto-boundary.geojson');
     torontoPolygon = await res.json(); // store as GeoJSON Feature or FeatureCollection
     renderMask(torontoPolygon);
     hideLoading();
   }
   ```
2. Store `torontoPolygon` as a module-level variable (GeoJSON Feature with Polygon or MultiPolygon geometry).
3. Keep `renderMask()` as-is (it already accepts a GeoJSON object).
4. Remove all neighbourhood-related globals: `neighbourhoods`, `neighLayers`, `labelLayers`, `aggregates`.

**Files changed:** `app.js`

---

## Phase 2 — Grid Definition

**Goal:** Define an 80×80 grid of cells covering Toronto's bounding box, with each cell's centroid precomputed.

### Data structures

```js
const GRID_COLS = 80;
const GRID_ROWS = 80;

// Computed once after torontoPolygon loads:
let gridBbox;      // [minLng, minLat, maxLng, maxLat]
let cellCentroids; // Float64Array of length GRID_COLS * GRID_ROWS * 2  (lng, lat pairs)
let inTorontoMask; // Uint8Array — 1 if cell centroid is inside torontoPolygon, else 0
```

### `initGrid()`

```js
function initGrid() {
  gridBbox = turf.bbox(torontoPolygon);
  const [minLng, minLat, maxLng, maxLat] = gridBbox;
  const cellW = (maxLng - minLng) / GRID_COLS;
  const cellH = (maxLat - minLat) / GRID_ROWS;

  cellCentroids = new Float64Array(GRID_COLS * GRID_ROWS * 2);
  inTorontoMask = new Uint8Array(GRID_COLS * GRID_ROWS);

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const idx = r * GRID_COLS + c;
      const lng = minLng + (c + 0.5) * cellW;
      const lat = minLat + (r + 0.5) * cellH;
      cellCentroids[idx * 2]     = lng;
      cellCentroids[idx * 2 + 1] = lat;
      inTorontoMask[idx] = turf.booleanPointInPolygon(
        turf.point([lng, lat]), torontoPolygon
      ) ? 1 : 0;
    }
  }
}
```

Call `initGrid()` immediately after `loadBoundary()` resolves.

**Files changed:** `app.js`

---

## Phase 3 — Firestore Schema + Aggregation

### New schema

Each submission document:
```json
{
  "eastPolygon": [[lng, lat], ...],
  "westPolygon": [[lng, lat], ...],
  "ts": <Timestamp>
}
```

### `loadAggregates()` — reads all docs and posts to worker

```js
async function loadAggregates() {
  const snapshot = await getDocs(collection(db, COLLECTION));
  updateSubmissionCount(snapshot.size);

  const submissions = [];
  snapshot.forEach(doc => {
    const d = doc.data();
    if (d.eastPolygon && d.westPolygon) {
      submissions.push({ east: d.eastPolygon, west: d.westPolygon });
    }
  });

  if (submissions.length === 0) return;

  heatmapWorker.postMessage({
    type: 'compute',
    submissions,
    centroids: cellCentroids,
    inMask: inTorontoMask,
    cols: GRID_COLS,
    rows: GRID_ROWS,
  }, [cellCentroids.buffer, inTorontoMask.buffer]); // transfer ownership
}
```

### Worker response

```js
heatmapWorker.onmessage = ({ data }) => {
  if (data.type === 'result') {
    // Restore transferred buffers
    cellCentroids = new Float64Array(data.centroids);
    inTorontoMask = new Uint8Array(data.inMask);
    heatmapLayer.update(data.eastCounts, data.westCounts, GRID_COLS, GRID_ROWS);
  }
};
```

**Files changed:** `app.js`

---

## Phase 4 — Line Splitting Logic

### `extendLineBeyondBoundary(points)`

Extends the freehand line past the Toronto bounding box diagonal so `turf.lineSplit` always clips cleanly.

```js
function extendLineBeyondBoundary(points) {
  const [minLng, minLat, maxLng, maxLat] = gridBbox;
  const diag = Math.hypot(maxLng - minLng, maxLat - minLat) * 1.5;

  const first = points[0];
  const second = points[1];
  const last = points[points.length - 1];
  const prev = points[points.length - 2];

  function extend(from, towards, dist) {
    const dx = towards[1] - from[1];
    const dy = towards[0] - from[0];
    const len = Math.hypot(dx, dy);
    return [from[0] + (dy / len) * dist, from[1] + (dx / len) * dist];
  }

  const startExt = extend(first, second, -diag);  // backwards from start
  const endExt   = extend(last, prev, -diag);     // backwards from end

  return [startExt, ...points, endExt];
}
```

### `splitTorontoPolygon(drawnPoints)`

```js
function splitTorontoPolygon(drawnPoints) {
  const extended = extendLineBeyondBoundary(drawnPoints);
  const line = turf.lineString(extended.map(([lat, lng]) => [lng, lat]));

  const pieces = turf.lineSplit(torontoPolygon, line);
  if (!pieces || pieces.features.length < 2) return null;

  // Determine which piece is east (higher average longitude)
  const centroids = pieces.features.map(f => turf.centroid(f).geometry.coordinates[0]);
  const sortedByLng = pieces.features
    .map((f, i) => ({ f, lng: centroids[i] }))
    .sort((a, b) => b.lng - a.lng);

  const eastFeature = sortedByLng[0].f;
  const westFeature = turf.union(...sortedByLng.slice(1).map(x => x.f));

  return {
    east: eastFeature.geometry.coordinates[0],
    west: westFeature.geometry.coordinates[0],
  };
}
```

**Files changed:** `app.js`

---

## Phase 5 — Submit Handler

```js
async function submitAnswer() {
  if (!drawnPoints || drawnPoints.length < 2) return;

  const split = splitTorontoPolygon(drawnPoints);
  if (!split) {
    showToast('Line didn\'t split Toronto cleanly — try drawing all the way across.');
    return;
  }

  const uuid = getOrCreateUUID();
  await setDoc(doc(db, COLLECTION, uuid), {
    eastPolygon: split.east,
    westPolygon: split.west,
    ts: serverTimestamp(),
  });

  hasSubmitted = true;
  localStorage.setItem('eastwest_submitted', 'true');
  hideControls();
  showToast('Thanks! Your answer has been recorded.');
  loadAggregates(); // refresh heatmap
}
```

**Files changed:** `app.js`

---

## Phase 6 — Web Worker (`heatmap-worker.js`)

New file. Uses `importScripts` for Turf.

```js
// heatmap-worker.js
importScripts('https://unpkg.com/@turf/turf@6.5.0/turf.min.js');

self.onmessage = ({ data }) => {
  const { submissions, centroids, inMask, cols, rows } = data;
  const total = cols * rows;

  const eastCounts = new Int32Array(total);
  const westCounts = new Int32Array(total);

  for (const sub of submissions) {
    const eastPoly = turf.polygon([sub.east]);
    const westPoly = turf.polygon([sub.west]);

    for (let i = 0; i < total; i++) {
      if (!inMask[i]) continue;
      const pt = turf.point([centroids[i * 2], centroids[i * 2 + 1]]);
      if (turf.booleanPointInPolygon(pt, eastPoly)) eastCounts[i]++;
      else if (turf.booleanPointInPolygon(pt, westPoly)) westCounts[i]++;
    }
  }

  self.postMessage({
    type: 'result',
    eastCounts,
    westCounts,
    centroids: data.centroids,
    inMask: data.inMask,
  }, [eastCounts.buffer, westCounts.buffer, data.centroids.buffer, data.inMask.buffer]);
};
```

**Files changed:** `heatmap-worker.js` (new)

---

## Phase 7 — Canvas Heatmap Layer (`HeatmapCanvasLayer`)

Custom `L.Layer` subclass that renders a `<canvas>` onto the map's `overlayPane`.

```js
const HeatmapCanvasLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'heatmap-canvas');
    const pane = map.getPane('overlayPane');
    pane.appendChild(this._canvas);
    map.on('moveend zoomend', this._redraw, this);
    map.on('move zoom', this._reposition, this);
  },

  onRemove(map) {
    this._canvas.remove();
    map.off('moveend zoomend', this._redraw, this);
    map.off('move zoom', this._reposition, this);
  },

  update(eastCounts, westCounts, cols, rows) {
    this._eastCounts = eastCounts;
    this._westCounts = westCounts;
    this._cols = cols;
    this._rows = rows;
    this._redraw();
  },

  _redraw() {
    if (!this._eastCounts) return;
    const map = this._map;
    const [minLng, minLat, maxLng, maxLat] = gridBbox;
    const cols = this._cols, rows = this._rows;

    // Map geographic corners to pixel positions
    const topLeft     = map.latLngToLayerPoint([maxLat, minLng]);
    const bottomRight = map.latLngToLayerPoint([minLat, maxLng]);

    const width  = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;

    this._canvas.width  = width;
    this._canvas.height = height;
    L.DomUtil.setPosition(this._canvas, topLeft);

    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    const cellW = width  / cols;
    const cellH = height / rows;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (!inTorontoMask[idx]) continue;

        const e = this._eastCounts[idx];
        const w = this._westCounts[idx];
        const total = e + w;
        if (total === 0) continue;

        const eastPct = e / total;
        ctx.fillStyle = lerpColour(COLOUR_WEST_RGB, COLOUR_EAST_RGB, eastPct);
        ctx.globalAlpha = 0.65;
        ctx.fillRect(
          Math.round(c * cellW), Math.round(r * cellH),
          Math.ceil(cellW), Math.ceil(cellH)
        );
      }
    }
    ctx.globalAlpha = 1;
  },

  _reposition() {
    if (!this._canvas || !this._eastCounts) return;
    const [minLng, minLat] = gridBbox;
    const topLeft = this._map.latLngToLayerPoint([gridBbox[3], minLng]);
    L.DomUtil.setPosition(this._canvas, topLeft);
  },
});
```

### Colour helpers

```js
const COLOUR_WEST_RGB = { r: 74, g: 144, b: 217 };   // #4a90d9
const COLOUR_EAST_RGB = { r: 224, g: 123, b: 57 };   // #e07b39

function lerpColour(a, b, t) {
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}
```

**Files changed:** `app.js`

---

## What to Keep (unchanged)

- `getSideOfLine()` — still used by `splitTorontoPolygon` orientation check
- All drawing mechanics: `isDrawing`, `drawnPoints`, `drawnPolyline`, `handleMapClick`, mouse/touch handlers
- Edge pan code
- `hasSubmitted` + localStorage gate
- `renderMask()` — still renders the outside-Toronto fade
- Firebase config + `getOrCreateUUID()`
- `updateSubmissionCount()`
- `showControls()` / `hideControls()` / `showToast()`
- All UI structure in `index.html` and `style.css`

## What to Remove

| Symbol | Location |
|---|---|
| `loadNeighbourhoods()` | app.js |
| `renderNeighbourhoods()` | app.js |
| `styleForNeighbourhood()` | app.js |
| `highlightClassification()` | app.js |
| `buildLabel()` | app.js |
| `labelFits()` | app.js |
| `featurePixelSize()` | app.js |
| `refreshLabels()` | app.js |
| `updateLabelVisibility()` | app.js |
| `labelLayers`, `neighLayers`, `neighbourhoods`, `aggregates` globals | app.js |
| `.neighbourhood-label` CSS | style.css |
| `.neighbourhood-label span.label-inner` CSS | style.css |
| `.neighbourhood-label .label-inner .pct` CSS | style.css |
| `#map.labels-hidden .neighbourhood-label` CSS | style.css |
| `data/toronto-neighbourhoods.geojson` | repo root |

## What to Add

| Symbol / File | Notes |
|---|---|
| `data/toronto-boundary.geojson` | User provides; single polygon of Toronto city boundary |
| `heatmap-worker.js` | New file — see Phase 6 |
| `HeatmapCanvasLayer` | Defined in app.js |
| `initGrid()` | Defined in app.js |
| `extendLineBeyondBoundary()` | Defined in app.js |
| `splitTorontoPolygon()` | Defined in app.js |
| `lerpColour()` | Defined in app.js |
| `COLOUR_WEST_RGB`, `COLOUR_EAST_RGB` | Defined in app.js |

---

## Sequencing

1. User drops `data/toronto-boundary.geojson` into the repo
2. **Phase 1** — Boundary loading + mask
3. **Phase 2** — Grid init (runs after boundary loads)
4. **Phase 6** — Create `heatmap-worker.js`
5. **Phase 7** — `HeatmapCanvasLayer` + colour helpers
6. **Phase 3** — `loadAggregates()` wired to worker
7. **Phase 4** — `splitTorontoPolygon()` + `extendLineBeyondBoundary()`
8. **Phase 5** — Submit handler
9. Clean up removed code
10. Test: single submission, verify polygon stored; reload, verify heatmap renders
