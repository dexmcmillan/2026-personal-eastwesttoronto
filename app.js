import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, doc, setDoc, getDocs, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ── Firebase config ────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAcK57xZZFKlGNyNAXBTxrUPkkUKFFus68",
  authDomain: "eastwesttoronto.firebaseapp.com",
  projectId: "eastwesttoronto",
  storageBucket: "eastwesttoronto.firebasestorage.app",
  messagingSenderId: "340678587011",
  appId: "1:340678587011:web:e384b7f086cb56c4dfa1b6"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const COLLECTION = 'submissions';

// ── Constants ──────────────────────────────────────────────────────────────
const TORONTO_CENTER = [43.7181, -79.3762];
const TORONTO_ZOOM = 11;

const COLOUR_WEST_RGB = { r: 74,  g: 144, b: 217 };  // #4a90d9
const COLOUR_EAST_RGB = { r: 224, g: 123, b: 57  };  // #e07b39

const GRID_COLS = 80;
const GRID_ROWS = 80;

// ── Map setup ──────────────────────────────────────────────────────────────
const map = L.map('map', {
  zoomControl: true,
  minZoom: 10,
  tap: false,
}).setView(TORONTO_CENTER, TORONTO_ZOOM);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
  maxZoom: 19,
  opacity: 1,
}).addTo(map);

// Pane for heatmap canvas — above tiles (200) but below mask (300)
map.createPane('heatmapPane');
map.getPane('heatmapPane').style.zIndex = 250;
map.getPane('heatmapPane').style.pointerEvents = 'none';

// Pane for mask — sits above heatmap but below labels
map.createPane('maskPane');
map.getPane('maskPane').style.zIndex = 300;
map.getPane('maskPane').style.pointerEvents = 'none';

// Pane for street labels — sits above the mask so labels show through
map.createPane('labelsPane');
map.getPane('labelsPane').style.zIndex = 650;
map.getPane('labelsPane').style.pointerEvents = 'none';

L.tileLayer('https://{s}.basemaps.cartocdn.com/voyager_only_labels/{z}/{x}/{y}{r}.png', {
  maxZoom: 19,
  opacity: 1,
  pane: 'labelsPane',
}).addTo(map);

// ── State ──────────────────────────────────────────────────────────────────
let torontoFeature = null;   // GeoJSON Feature (Polygon) for city boundary
let gridBbox = null;         // [minLng, minLat, maxLng, maxLat]
let cellCentroids = null;    // Float64Array — lng,lat pairs for each cell
let inTorontoMask = null;    // Uint8Array — 1 if cell centroid is inside Toronto

let isDrawing = false;
let drawnPoints = [];
let drawnPolyline = null;
let _pendingStartPoint = null;
let splitResult = null;      // { east: coords[][], west: coords[][] } after drawing
let hasSubmitted = localStorage.getItem('eastwest_submitted') === 'true';

let heatmapLayer = null;
let heatmapWorker = null;

// ── UUID ───────────────────────────────────────────────────────────────────
function getUserId() {
  let id = localStorage.getItem('eastwest_uuid');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('eastwest_uuid', id);
  }
  return id;
}
const userId = getUserId();

// ── Colour helpers ─────────────────────────────────────────────────────────
function lerpColour(a, b, t) {
  const r  = Math.round(a.r + (b.r - a.r) * t);
  const g  = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}

// ── Heatmap canvas layer ───────────────────────────────────────────────────
const HeatmapCanvasLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'heatmap-canvas');
    this._canvas.style.position = 'absolute';
    this._canvas.style.pointerEvents = 'none';
    map.getPane('heatmapPane').appendChild(this._canvas);
    map.on('moveend zoomend move zoom', this._redraw, this);
  },

  onRemove(map) {
    this._canvas.remove();
    map.off('moveend zoomend move zoom', this._redraw, this);
  },

  update(eastCounts, westCounts) {
    this._eastCounts = eastCounts;
    this._westCounts = westCounts;
    this._redraw();
  },

  clear() {
    this._eastCounts = null;
    this._westCounts = null;
    if (this._canvas) {
      const ctx = this._canvas.getContext('2d');
      ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }
  },

  _redraw() {
    if (!this._eastCounts || !gridBbox) return;
    const [minLng, minLat, maxLng, maxLat] = gridBbox;

    const topLeft     = this._map.latLngToLayerPoint([maxLat, minLng]);
    const bottomRight = this._map.latLngToLayerPoint([minLat, maxLng]);

    const width  = Math.round(bottomRight.x - topLeft.x);
    const height = Math.round(bottomRight.y - topLeft.y);

    this._canvas.width  = width;
    this._canvas.height = height;
    L.DomUtil.setPosition(this._canvas, topLeft);

    const ctx = this._canvas.getContext('2d');
    ctx.clearRect(0, 0, width, height);

    const cellW = width  / GRID_COLS;
    const cellH = height / GRID_ROWS;

    for (let r = 0; r < GRID_ROWS; r++) {
      // Grid rows are built south→north (r=0 = minLat = bottom of map).
      // Canvas rows are top→bottom, so flip: canvasRow 0 = grid row (GRID_ROWS-1).
      const canvasRow = GRID_ROWS - 1 - r;
      for (let c = 0; c < GRID_COLS; c++) {
        const idx = r * GRID_COLS + c;
        if (!inTorontoMask[idx]) continue;

        const e = this._eastCounts[idx];
        const w = this._westCounts[idx];
        const total = e + w;
        if (total === 0) continue;

        const eastPct = e / total;
        ctx.fillStyle = lerpColour(COLOUR_WEST_RGB, COLOUR_EAST_RGB, eastPct);
        ctx.globalAlpha = 0.25;
        // Use floor for position and ceil+1 for size to ensure cells are flush
        const px = Math.floor(c * cellW);
        const py = Math.floor(canvasRow * cellH);
        const pw = Math.floor((c + 1) * cellW) - px + 1;
        const ph = Math.floor((canvasRow + 1) * cellH) - py + 1;
        ctx.fillRect(px, py, pw, ph);
      }
    }
    ctx.globalAlpha = 1;
  },
});

// ── Grid init ──────────────────────────────────────────────────────────────
function initGrid() {
  gridBbox = turf.bbox(torontoFeature);
  const [minLng, minLat, maxLng, maxLat] = gridBbox;
  const cellW = (maxLng - minLng) / GRID_COLS;
  const cellH = (maxLat - minLat) / GRID_ROWS;

  const total = GRID_COLS * GRID_ROWS;
  cellCentroids = new Float64Array(total * 2);
  inTorontoMask = new Uint8Array(total);

  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const idx = r * GRID_COLS + c;
      const lng = minLng + (c + 0.5) * cellW;
      const lat = minLat + (r + 0.5) * cellH;
      cellCentroids[idx * 2]     = lng;
      cellCentroids[idx * 2 + 1] = lat;
      inTorontoMask[idx] = turf.booleanPointInPolygon(
        turf.point([lng, lat]), torontoFeature
      ) ? 1 : 0;
    }
  }
}

// ── Mask: semi-opaque overlay outside Toronto ──────────────────────────────
function renderMask() {
  const world = turf.polygon([[
    [-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]
  ]]);
  const mask = turf.difference(world, torontoFeature);
  if (!mask) return;

  L.geoJSON(mask, {
    style: {
      fillColor: '#f0f0f0',
      fillOpacity: 0.45,
      color: '#888',
      weight: 1.5,
    },
    pane: 'maskPane',
    interactive: false,
  }).addTo(map);
}

// ── Load boundary ──────────────────────────────────────────────────────────
async function loadBoundary() {
  const res = await fetch('data/toronto-boundary.geojson');
  torontoFeature = await res.json();

  const bounds = L.geoJSON(torontoFeature).getBounds();
  map.fitBounds(bounds, { padding: [-40, -40] });
  map.setMaxBounds(bounds.pad(0.15));

  renderMask();
  initGrid();
  document.getElementById('loading').classList.add('hidden');
}

// ── Heatmap labels ─────────────────────────────────────────────────────────
let heatmapLabelMarkers = [];

function updateHeatmapLabels(eastCounts, westCounts) {
  heatmapLabelMarkers.forEach(m => map.removeLayer(m));
  heatmapLabelMarkers = [];

  // Group cells by their exact east-vote fraction (e.g. 0, 0.5, 1.0).
  // Each distinct fraction = one agreement band = one label.
  let totalEast = 0, totalWest = 0;
  const bands = new Map(); // key: "e/total" string → { e, total, sumLng, sumLat, count }

  const total = GRID_COLS * GRID_ROWS;
  for (let i = 0; i < total; i++) {
    if (!inTorontoMask[i]) continue;
    const e = eastCounts[i], w = westCounts[i];
    if (e + w === 0) continue;
    totalEast += e;
    totalWest += w;
    const key = `${e}/${e + w}`;
    if (!bands.has(key)) bands.set(key, { e, total: e + w, sumLng: 0, sumLat: 0, count: 0 });
    const b = bands.get(key);
    b.sumLng += cellCentroids[i * 2];
    b.sumLat += cellCentroids[i * 2 + 1];
    b.count++;
  }

  const grandTotal = totalEast + totalWest;
  if (grandTotal === 0) return;

  // ── Build chunked legend ───────────────────────────────────────────────
  // Sort bands west→east by east fraction, then render one chunk per band
  // sized proportionally by cell count.
  const sortedBands = [...bands.entries()]
    .map(([key, b]) => ({ key, eastFrac: b.e / b.total, count: b.count }))
    .sort((a, b) => a.eastFrac - b.eastFrac);

  const bar = document.getElementById('legend-gradient-bar');
  bar.innerHTML = '';
  bar.style.background = 'none';  // override the CSS gradient

  const pct = 100 / sortedBands.length;

  for (const band of sortedBands) {
    const colour = lerpColour(COLOUR_WEST_RGB, COLOUR_EAST_RGB, band.eastFrac);
    const eastPct = Math.round(band.eastFrac * 100);
    const label = eastPct === 0   ? '100% W'
                : eastPct === 100 ? '100% E'
                : `${100 - eastPct}/${eastPct}`;

    const chunk = document.createElement('div');
    chunk.style.cssText = `
      flex: 0 0 ${pct}%;
      background: ${colour};
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      min-width: 0;
    `;

    // Only show label if chunk is wide enough to hold text
    if (pct > 6) {
      const span = document.createElement('span');
      span.textContent = label;
      span.style.cssText = `
        font-size: 0.6rem;
        font-weight: 600;
        color: #fff;
        white-space: nowrap;
        text-shadow: 0 1px 2px rgba(0,0,0,0.4);
        overflow: hidden;
        pointer-events: none;
      `;
      chunk.appendChild(span);
    }
    bar.appendChild(chunk);
  }

  document.getElementById('legend-gradient-labels').style.display = 'none';
  document.getElementById('legend-results').classList.remove('hidden');

  function placeLabel(lat, lng, html) {
    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'heatmap-label',
        html,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
      interactive: false,
      pane: 'labelsPane',
    }).addTo(map);
    heatmapLabelMarkers.push(marker);
  }

  // Place labels only on 100% agreement bands (unanimous east or west).
  // Contested areas are explained by the gradient legend in the header.
  for (const [key, b] of bands.entries()) {
    const eastPct = Math.round((b.e / b.total) * 100);
    const westPct = 100 - eastPct;
    if (eastPct !== 100 && westPct !== 100) continue;

    const html = eastPct === 100
      ? `<span class="heatmap-label-inner east-label">100%<span class="heatmap-label-sub">say east</span></span>`
      : `<span class="heatmap-label-inner west-label">100%<span class="heatmap-label-sub">say west</span></span>`;

    // BFS: one label per connected component in this band
    const inBand = new Uint8Array(GRID_COLS * GRID_ROWS);
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      if (!inTorontoMask[i]) continue;
      const e = eastCounts[i], w = westCounts[i];
      if (e + w === 0) continue;
      if (`${e}/${e + w}` === key) inBand[i] = 1;
    }
    const visited = new Uint8Array(GRID_COLS * GRID_ROWS);
    for (let start = 0; start < GRID_COLS * GRID_ROWS; start++) {
      if (!inBand[start] || visited[start]) continue;
      const queue = [start];
      visited[start] = 1;
      let sumLng = 0, sumLat = 0, count = 0, qi = 0;
      while (qi < queue.length) {
        const idx = queue[qi++];
        sumLng += cellCentroids[idx * 2];
        sumLat += cellCentroids[idx * 2 + 1];
        count++;
        const r = Math.floor(idx / GRID_COLS), c = idx % GRID_COLS;
        for (const [nr, nc] of [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]) {
          if (nr < 0 || nr >= GRID_ROWS || nc < 0 || nc >= GRID_COLS) continue;
          const ni = nr * GRID_COLS + nc;
          if (inBand[ni] && !visited[ni]) { visited[ni] = 1; queue.push(ni); }
        }
      }
      placeLabel(sumLat / count, sumLng / count, html);
    }
  }
}

// ── Worker setup ───────────────────────────────────────────────────────────
function initWorker() {
  heatmapWorker = new Worker('heatmap-worker.js');
  heatmapWorker.onmessage = ({ data }) => {
    if (data.type === 'result') {
      // Restore transferred buffers so grid is still usable
      cellCentroids = new Float64Array(data.centroids);
      inTorontoMask = new Uint8Array(data.inMask);
      const eastCounts = new Int32Array(data.eastCounts);
      const westCounts = new Int32Array(data.westCounts);
      heatmapLayer.update(eastCounts, westCounts);
      updateHeatmapLabels(eastCounts, westCounts);
    }
  };
}

// ── Load aggregates from Firestore → post to worker ────────────────────────
async function loadAggregates() {
  try {
    const snapshot = await getDocs(collection(db, COLLECTION));
    updateSubmissionCount(snapshot.size);

    if (!hasSubmitted) return;

    // Convert {lng, lat} objects back to [lng, lat] arrays for Turf in worker
    const toArrays = ring => ring.map(p => [p.lng, p.lat]);

    const submissions = [];
    snapshot.forEach(docSnap => {
      const d = docSnap.data();
      if (d.eastPolygon && d.westPolygon) {
        submissions.push({
          east: toArrays(d.eastPolygon),
          west: toArrays(d.westPolygon),
        });
      }
    });

    if (submissions.length === 0) return;

    // Transfer typed arrays to worker to avoid copying
    const centroidsCopy  = cellCentroids.slice();
    const inMaskCopy     = inTorontoMask.slice();

    heatmapWorker.postMessage({
      type: 'compute',
      submissions,
      centroids: centroidsCopy,
      inMask: inMaskCopy,
      cols: GRID_COLS,
      rows: GRID_ROWS,
    }, [centroidsCopy.buffer, inMaskCopy.buffer]);

  } catch (e) {
    console.warn('Could not load aggregates from Firestore:', e);
  }
}

function updateSubmissionCount(count) {
  const noun = count === 1 ? 'other' : 'others';
  document.getElementById('instructions').textContent =
    `Draw a line across the map, then submit your answer to see how ${count} ${noun} have drawn the line.`;
}

// ── Line-splitting logic ───────────────────────────────────────────────────

// Build a half-plane mask polygon on one side of the drawn line.
// We extend the line far past the bbox, then close a polygon around
// one side of it (the "east" half = right side of north-to-south line).
function buildSideMask(points, side) {
  // points are [lat, lng]; convert to [lng, lat] for geometry
  const [minLng, minLat, maxLng, maxLat] = gridBbox;
  const pad = Math.max(maxLng - minLng, maxLat - minLat) * 3;

  // Direction vector from first to last point (in lng/lat space)
  const first = [points[0][1],              points[0][0]];
  const last  = [points[points.length-1][1], points[points.length-1][0]];
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const ux = dx / len;
  const uy = dy / len;

  // Extend line endpoints well past the bbox
  const startExt = [first[0] - ux * pad, first[1] - uy * pad];
  const endExt   = [last[0]  + ux * pad, last[1]  + uy * pad];

  // Perpendicular points far to each side
  const perpDist = pad;
  // Right side of direction vector: rotate (ux,uy) by -90° → (uy, -ux)
  const rightStart = [startExt[0] + uy * perpDist, startExt[1] - ux * perpDist];
  const rightEnd   = [endExt[0]   + uy * perpDist, endExt[1]   - ux * perpDist];
  const leftStart  = [startExt[0] - uy * perpDist, startExt[1] + ux * perpDist];
  const leftEnd    = [endExt[0]   - uy * perpDist, endExt[1]   + ux * perpDist];

  // All the drawn points in [lng, lat]
  const lineCoords = points.map(([lat, lng]) => [lng, lat]);

  let ring;
  if (side === 'right') {
    ring = [startExt, ...lineCoords, endExt, rightEnd, rightStart, startExt];
  } else {
    ring = [startExt, ...lineCoords, endExt, leftEnd, leftStart, startExt];
  }

  try {
    return turf.polygon([ring]);
  } catch (e) {
    return null;
  }
}

function splitTorontoPolygon(drawnPoints) {
  if (drawnPoints.length < 2) return null;

  // Determine which side is "east" (higher average longitude)
  // by checking a point to the right of the overall direction
  const first = drawnPoints[0];
  const last  = drawnPoints[drawnPoints.length - 1];
  const dx = last[1] - first[1];   // lng diff
  const dy = last[0] - first[0];   // lat diff
  const len = Math.hypot(dx, dy);

  // A point to the right of the direction vector (rotate -90°)
  const midLat = (first[0] + last[0]) / 2;
  const midLng = (first[1] + last[1]) / 2;
  const rightLng = midLng + (dy / len) * 0.01;
  const rightLat = midLat - (dx / len) * 0.01;

  // Is the right side east (higher lng) or west?
  const rightIsEast = rightLng > midLng || (rightLng === midLng && rightLat > midLat);
  const eastSide  = rightIsEast ? 'right' : 'left';
  const westSide  = rightIsEast ? 'left'  : 'right';

  const eastMask = buildSideMask(drawnPoints, eastSide);
  const westMask = buildSideMask(drawnPoints, westSide);
  if (!eastMask || !westMask) return null;

  let eastFeature, westFeature;
  try {
    eastFeature = turf.intersect(torontoFeature, eastMask);
    westFeature = turf.intersect(torontoFeature, westMask);
  } catch (e) {
    console.warn('intersect failed:', e);
    return null;
  }

  if (!eastFeature || !westFeature) return null;

  // Extract outer ring coordinates for storage
  function outerRing(feature) {
    const geom = feature.geometry;
    if (geom.type === 'Polygon') return geom.coordinates[0];
    if (geom.type === 'MultiPolygon') return geom.coordinates[0][0];
    return null;
  }

  const east = outerRing(eastFeature);
  const west = outerRing(westFeature);
  if (!east || !west) return null;

  return { east, west, eastFeature, westFeature };
}

// ── Drawing ────────────────────────────────────────────────────────────────
const EDGE_PAN_ZONE  = 60;
const EDGE_PAN_SPEED = 8;
let edgePanFrame = null;
let lastMouseContainerPoint = null;

function startEdgePan() {
  if (edgePanFrame) return;
  function step() {
    if (!isDrawing || !lastMouseContainerPoint) { edgePanFrame = null; return; }
    const { x, y } = lastMouseContainerPoint;
    const { x: w, y: h } = map.getSize();
    let dx = 0, dy = 0;
    if (x < EDGE_PAN_ZONE)     dx = -EDGE_PAN_SPEED * (1 - x / EDGE_PAN_ZONE);
    if (x > w - EDGE_PAN_ZONE) dx =  EDGE_PAN_SPEED * (1 - (w - x) / EDGE_PAN_ZONE);
    if (y < EDGE_PAN_ZONE)     dy = -EDGE_PAN_SPEED * (1 - y / EDGE_PAN_ZONE);
    if (y > h - EDGE_PAN_ZONE) dy =  EDGE_PAN_SPEED * (1 - (h - y) / EDGE_PAN_ZONE);
    if (dx !== 0 || dy !== 0) map.panBy([dx, dy], { animate: false });
    edgePanFrame = requestAnimationFrame(step);
  }
  edgePanFrame = requestAnimationFrame(step);
}

function stopEdgePan() {
  if (edgePanFrame) { cancelAnimationFrame(edgePanFrame); edgePanFrame = null; }
}

map.on('mousedown', e => {
  isDrawing = true;
  if (heatmapLayer._eastCounts) clearHeatmap();
  // Don't push the mousedown point yet — wait for first mousemove so we
  // don't draw a teleport segment if resuming an existing line.
  _pendingStartPoint = [e.latlng.lat, e.latlng.lng];
  map.dragging.disable();
  startEdgePan();
});

map.on('mousemove', e => {
  lastMouseContainerPoint = e.containerPoint;
  if (!isDrawing) return;
  // On first move of this stroke, commit the start point (connecting to prior
  // line if one exists, or starting fresh).
  if (_pendingStartPoint) {
    if (drawnPoints.length === 0) drawnPoints = [_pendingStartPoint];
    else drawnPoints.push(_pendingStartPoint);
    _pendingStartPoint = null;
  }
  drawnPoints.push([e.latlng.lat, e.latlng.lng]);
  if (drawnPolyline) map.removeLayer(drawnPolyline);
  drawnPolyline = L.polyline(drawnPoints, { color: '#e63946', weight: 3 }).addTo(map);
});

map.on('mouseup', () => {
  if (!isDrawing) return;
  isDrawing = false;
  stopEdgePan();
  map.dragging.enable();
  if (drawnPoints.length > 1) finishDraw();
});

// ── Touch drawing ──────────────────────────────────────────────────────────
const mapEl = document.getElementById('map');

mapEl.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  isDrawing = true;
  if (heatmapLayer._eastCounts) clearHeatmap();
  const touch = e.touches[0];
  const rect  = mapEl.getBoundingClientRect();
  const latlng = map.containerPointToLatLng([touch.clientX - rect.left, touch.clientY - rect.top]);
  // Don't push yet — wait for first touchmove to avoid teleport segments.
  _pendingStartPoint = [latlng.lat, latlng.lng];
}, { passive: false, capture: true });

mapEl.addEventListener('touchmove', e => {
  if (!isDrawing || e.touches.length !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  const touch  = e.touches[0];
  const rect   = mapEl.getBoundingClientRect();
  const latlng = map.containerPointToLatLng([touch.clientX - rect.left, touch.clientY - rect.top]);
  // On first move, commit the touchstart point.
  if (_pendingStartPoint) {
    if (drawnPoints.length === 0) drawnPoints = [_pendingStartPoint];
    else drawnPoints.push(_pendingStartPoint);
    _pendingStartPoint = null;
  }
  drawnPoints.push([latlng.lat, latlng.lng]);
  if (drawnPolyline) map.removeLayer(drawnPolyline);
  drawnPolyline = L.polyline(drawnPoints, { color: '#e63946', weight: 3 }).addTo(map);
}, { passive: false, capture: true });

mapEl.addEventListener('touchend', e => {
  if (!isDrawing) return;
  e.preventDefault();
  e.stopPropagation();
  isDrawing = false;
  if (drawnPoints.length > 1) finishDraw();
}, { passive: false, capture: true });

// ── Finish draw — preview split then show controls ─────────────────────────
function finishDraw() {
  const result = splitTorontoPolygon(drawnPoints);
  if (!result) {
    showToast("Line didn't cross Toronto cleanly — try drawing all the way across.");
    return;
  }
  splitResult = result;

  // Show a preview: east in orange, west in blue, below the mask
  if (window._previewLayer) { map.removeLayer(window._previewLayer); }
  window._previewLayer = L.geoJSON({
    type: 'FeatureCollection',
    features: [
      { ...result.eastFeature, properties: { side: 'east' } },
      { ...result.westFeature, properties: { side: 'west' } },
    ],
  }, {
    pane: 'heatmapPane',
    style: feature => {
      const isEast = feature.properties.side === 'east';
      return {
        fillColor:   isEast ? '#e07b39' : '#4a90d9',
        fillOpacity: 0.22,
        color:       isEast ? '#e07b39' : '#4a90d9',
        weight: 1.5,
      };
    },
  }).addTo(map);

  showControls();
}

// ── Controls ───────────────────────────────────────────────────────────────
function showControls() {
  document.getElementById('controls-modal').classList.remove('hidden');
}

function hideControls() {
  document.getElementById('controls-modal').classList.add('hidden');
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);
}

function clearHeatmap() {
  heatmapLayer.clear();
  heatmapLabelMarkers.forEach(m => map.removeLayer(m));
  heatmapLabelMarkers = [];
  document.getElementById('legend-results').classList.add('hidden');
}

function clearDraw() {
  if (drawnPolyline) { map.removeLayer(drawnPolyline); drawnPolyline = null; }
  if (window._previewLayer) { map.removeLayer(window._previewLayer); window._previewLayer = null; }
  drawnPoints = [];
  splitResult = null;
  _pendingStartPoint = null;
  clearHeatmap();
}

document.getElementById('btn-redraw').addEventListener('click', () => {
  clearDraw();
  hideControls();
  if (hasSubmitted) loadAggregates();
});

document.getElementById('btn-submit').addEventListener('click', async () => {
  if (!splitResult) return;

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  // Firestore doesn't support nested arrays — store coords as {lng, lat} objects
  const toObjects = ring => ring.map(([lng, lat]) => ({ lng, lat }));

  await setDoc(doc(db, COLLECTION, userId), {
    eastPolygon: toObjects(splitResult.east),
    westPolygon: toObjects(splitResult.west),
    ts: serverTimestamp(),
  });

  hasSubmitted = true;
  localStorage.setItem('eastwest_submitted', 'true');

  clearDraw();
  hideControls();
  showToast('Thanks! Your answer has been recorded.');

  await loadAggregates();

  btn.disabled = false;
  btn.textContent = 'Submit my answer';
});

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
  initWorker();
  heatmapLayer = new HeatmapCanvasLayer();
  heatmapLayer.addTo(map);

  await loadBoundary();
  await loadAggregates();
}
init();
