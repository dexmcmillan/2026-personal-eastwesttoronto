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

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
  maxZoom: 19,
  opacity: 1,
}).addTo(map);

// Pane for mask — sits above tiles but below drawn lines
map.createPane('maskPane');
map.getPane('maskPane').style.zIndex = 300;
map.getPane('maskPane').style.pointerEvents = 'none';

// ── State ──────────────────────────────────────────────────────────────────
let torontoFeature = null;   // GeoJSON Feature (Polygon) for city boundary
let gridBbox = null;         // [minLng, minLat, maxLng, maxLat]
let cellCentroids = null;    // Float64Array — lng,lat pairs for each cell
let inTorontoMask = null;    // Uint8Array — 1 if cell centroid is inside Toronto

let isDrawing = false;
let drawnPoints = [];
let drawnPolyline = null;
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
    map.getPane('overlayPane').appendChild(this._canvas);
    map.on('moveend zoomend', this._redraw, this);
    map.on('move zoom',       this._reposition, this);
  },

  onRemove(map) {
    this._canvas.remove();
    map.off('moveend zoomend', this._redraw, this);
    map.off('move zoom',       this._reposition, this);
  },

  update(eastCounts, westCounts) {
    this._eastCounts = eastCounts;
    this._westCounts = westCounts;
    this._redraw();
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
      for (let c = 0; c < GRID_COLS; c++) {
        const idx = r * GRID_COLS + c;
        if (!inTorontoMask[idx]) continue;

        const e = this._eastCounts[idx];
        const w = this._westCounts[idx];
        const total = e + w;
        if (total === 0) continue;

        const eastPct = e / total;
        ctx.fillStyle = lerpColour(COLOUR_WEST_RGB, COLOUR_EAST_RGB, eastPct);
        ctx.globalAlpha = 0.65;
        ctx.fillRect(
          Math.round(c * cellW),
          Math.round(r * cellH),
          Math.ceil(cellW),
          Math.ceil(cellH)
        );
      }
    }
    ctx.globalAlpha = 1;
  },

  _reposition() {
    if (!this._canvas || !this._eastCounts || !gridBbox) return;
    const [minLng, , , maxLat] = gridBbox;
    const topLeft = this._map.latLngToLayerPoint([maxLat, minLng]);
    L.DomUtil.setPosition(this._canvas, topLeft);
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

// ── Worker setup ───────────────────────────────────────────────────────────
function initWorker() {
  heatmapWorker = new Worker('heatmap-worker.js');
  heatmapWorker.onmessage = ({ data }) => {
    if (data.type === 'result') {
      // Restore transferred buffers so grid is still usable
      cellCentroids = new Float64Array(data.centroids);
      inTorontoMask = new Uint8Array(data.inMask);
      heatmapLayer.update(
        new Int32Array(data.eastCounts),
        new Int32Array(data.westCounts)
      );
    }
  };
}

// ── Load aggregates from Firestore → post to worker ────────────────────────
async function loadAggregates() {
  try {
    const snapshot = await getDocs(collection(db, COLLECTION));
    updateSubmissionCount(snapshot.size);

    if (!hasSubmitted) return;

    const submissions = [];
    snapshot.forEach(docSnap => {
      const d = docSnap.data();
      if (d.eastPolygon && d.westPolygon) {
        submissions.push({ east: d.eastPolygon, west: d.westPolygon });
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
function extendLineBeyondBoundary(points) {
  const [minLng, minLat, maxLng, maxLat] = gridBbox;
  const diag = Math.hypot(maxLng - minLng, maxLat - minLat) * 2;

  function extend(from, towards, dist) {
    // points are [lat, lng]; work in lng/lat space
    const dx = towards[1] - from[1];
    const dy = towards[0] - from[0];
    const len = Math.hypot(dx, dy);
    if (len === 0) return from;
    return [from[0] - (dy / len) * dist, from[1] - (dx / len) * dist];
  }

  const startExt = extend(points[0], points[1], diag);
  const endExt   = extend(points[points.length - 1], points[points.length - 2], diag);
  return [startExt, ...points, endExt];
}

function splitTorontoPolygon(drawnPoints) {
  const extended = extendLineBeyondBoundary(drawnPoints);
  // Convert [lat, lng] points to [lng, lat] for GeoJSON/Turf
  const lineCoords = extended.map(([lat, lng]) => [lng, lat]);
  const line = turf.lineString(lineCoords);

  let pieces;
  try {
    pieces = turf.lineSplit(torontoFeature, line);
  } catch (e) {
    console.warn('lineSplit failed:', e);
    return null;
  }

  if (!pieces || pieces.features.length < 2) return null;

  // Sort pieces by centroid longitude: highest lng = east
  const sorted = pieces.features
    .map(f => ({ f, lng: turf.centroid(f).geometry.coordinates[0] }))
    .sort((a, b) => b.lng - a.lng);

  const eastFeature = sorted[0].f;

  // Union any remaining pieces as west
  let westFeature = sorted[1].f;
  for (let i = 2; i < sorted.length; i++) {
    try { westFeature = turf.union(westFeature, sorted[i].f); } catch (e) { /* skip */ }
  }

  // Extract outer ring coordinates
  function outerRing(feature) {
    const geom = feature.geometry;
    if (geom.type === 'Polygon') return geom.coordinates[0];
    if (geom.type === 'MultiPolygon') return geom.coordinates[0][0];
    return null;
  }

  const east = outerRing(eastFeature);
  const west = outerRing(westFeature);
  if (!east || !west) return null;

  return { east, west };
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
  drawnPoints = [[e.latlng.lat, e.latlng.lng]];
  if (drawnPolyline) { map.removeLayer(drawnPolyline); drawnPolyline = null; }
  map.dragging.disable();
  startEdgePan();
});

map.on('mousemove', e => {
  lastMouseContainerPoint = e.containerPoint;
  if (!isDrawing) return;
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
  const touch = e.touches[0];
  const rect  = mapEl.getBoundingClientRect();
  const latlng = map.containerPointToLatLng([touch.clientX - rect.left, touch.clientY - rect.top]);
  drawnPoints = [[latlng.lat, latlng.lng]];
  if (drawnPolyline) { map.removeLayer(drawnPolyline); drawnPolyline = null; }
}, { passive: false, capture: true });

mapEl.addEventListener('touchmove', e => {
  if (!isDrawing || e.touches.length !== 1) return;
  e.preventDefault();
  e.stopPropagation();
  const touch  = e.touches[0];
  const rect   = mapEl.getBoundingClientRect();
  const latlng = map.containerPointToLatLng([touch.clientX - rect.left, touch.clientY - rect.top]);
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

  // Show a preview: east in orange, west in blue, on top of mask
  if (window._previewLayer) { map.removeLayer(window._previewLayer); }
  window._previewLayer = L.geoJSON({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [result.east] } },
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [result.west] } },
    ],
  }, {
    style: feature => {
      const centLng = turf.centroid(feature).geometry.coordinates[0];
      const isEast  = centLng === turf.centroid({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [result.east] } }).geometry.coordinates[0];
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

function clearDraw() {
  if (drawnPolyline) { map.removeLayer(drawnPolyline); drawnPolyline = null; }
  if (window._previewLayer) { map.removeLayer(window._previewLayer); window._previewLayer = null; }
  drawnPoints = [];
  splitResult = null;
}

document.getElementById('btn-redraw').addEventListener('click', () => {
  clearDraw();
  hideControls();
});

document.getElementById('btn-submit').addEventListener('click', async () => {
  if (!splitResult) return;

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  await setDoc(doc(db, COLLECTION, userId), {
    eastPolygon: splitResult.east,
    westPolygon: splitResult.west,
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
