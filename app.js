import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, doc, setDoc, getDocs } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

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

// ── Constants ──────────────────────────────────────────────────────────────
const TORONTO_CENTER = [43.7181, -79.3762];
const TORONTO_ZOOM = 11;

const COLOUR_NEUTRAL = '#aaaaaa';
const COLOUR_EAST = '#e07b39';   // orange
const COLOUR_WEST = '#4a90d9';   // blue
const OPACITY_MIN = 0.02;
const OPACITY_MAX = 0.1;
const LABEL_ZOOM_THRESHOLD = 12;  // labels appear at this zoom and above

// ── Map setup ──────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true, minZoom: 10 }).setView(TORONTO_CENTER, TORONTO_ZOOM);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
  maxZoom: 19,
  opacity: 1,
}).addTo(map);

// Pane for mask — sits above tiles (200) but below neighbourhood polygons (400)
map.createPane('maskPane');
map.getPane('maskPane').style.zIndex = 300;
map.getPane('maskPane').style.pointerEvents = 'none';

// ── State ──────────────────────────────────────────────────────────────────
let geojsonData = null;
let neighbourhoodLayer = null;
let labelLayers = [];
let aggregates = {};

let isDrawing = false;
let drawnPoints = [];
let drawnPolyline = null;
let lastClassified = null;

// ── UUID (per-browser identity for deduplication) ──────────────────────────
function getUserId() {
  let id = localStorage.getItem('eastwest_uuid');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('eastwest_uuid', id);
  }
  return id;
}
const userId = getUserId();

// ── Load aggregates from Firestore ─────────────────────────────────────────
async function loadAggregates() {
  try {
    const snapshot = await getDocs(collection(db, 'submissions'));
    const counts = {};

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      (data.east || []).forEach(name => {
        if (!counts[name]) counts[name] = { east: 0, west: 0 };
        counts[name].east++;
      });
      (data.west || []).forEach(name => {
        if (!counts[name]) counts[name] = { east: 0, west: 0 };
        counts[name].west++;
      });
    });

    aggregates = counts;
  } catch (e) {
    console.warn('Could not load aggregates from Firestore:', e);
    aggregates = {};
  }
}

// ── Zoom-based label visibility ────────────────────────────────────────────
function updateLabelVisibility() {
  const mapEl = document.getElementById('map');
  if (map.getZoom() >= LABEL_ZOOM_THRESHOLD) {
    mapEl.classList.remove('labels-hidden');
  } else {
    mapEl.classList.add('labels-hidden');
  }
}

map.on('zoomend', updateLabelVisibility);

// ── Load GeoJSON ───────────────────────────────────────────────────────────
async function loadNeighbourhoods() {
  const response = await fetch('data/toronto-neighbourhoods.geojson');
  geojsonData = await response.json();

  // Fit map to neighbourhood bounds and lock scroll-out to that extent
  const bounds = L.geoJSON(geojsonData).getBounds();
  map.fitBounds(bounds, { padding: [-40, -40] });
  map.setMaxBounds(bounds.pad(0.15));

  renderMask();
  renderNeighbourhoods();
  updateLabelVisibility();
  document.getElementById('loading').classList.add('hidden');
}

// ── Mask: white overlay outside Toronto neighbourhood bounds ───────────────
function renderMask() {
  // Build a union of all neighbourhood polygons using Turf
  let union = null;
  for (const feature of geojsonData.features) {
    try {
      const geom = feature.geometry;
      let poly;
      if (geom.type === 'Polygon') {
        poly = turf.polygon(geom.coordinates);
      } else if (geom.type === 'MultiPolygon') {
        poly = turf.multiPolygon(geom.coordinates);
      } else {
        continue;
      }
      union = union ? turf.union(union, poly) : poly;
    } catch (e) {
      // skip features that fail union
    }
  }
  if (!union) return;

  // Create an inverted mask: world bbox with Toronto union as a hole
  const world = turf.polygon([[
    [-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]
  ]]);
  const mask = turf.difference(world, union);
  if (!mask) return;

  L.geoJSON(mask, {
    style: {
      fillColor: '#f8f8f8',
      fillOpacity: 1,
      color: '#ccc',
      weight: 0.5,
    },
    pane: 'maskPane',
    interactive: false,
  }).addTo(map);
}

// ── Render neighbourhood polygons ──────────────────────────────────────────
function renderNeighbourhoods() {
  if (neighbourhoodLayer) {
    map.removeLayer(neighbourhoodLayer);
  }
  labelLayers.forEach(l => map.removeLayer(l));
  labelLayers = [];

  neighbourhoodLayer = L.geoJSON(geojsonData, {
    style: feature => {
      const name = feature.properties.AREA_NAME;
      return styleForNeighbourhood(name);
    },
  }).addTo(map);

  geojsonData.features.forEach(feature => {
    const name = feature.properties.AREA_NAME;
    const center = turf.centerOfMass(feature);
    const [lng, lat] = center.geometry.coordinates;
    const label = buildLabel(name);
    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: 'neighbourhood-label',
        html: label,
        iconSize: null,
      }),
    }).addTo(map);
    labelLayers.push(marker);
  });
}

function styleForNeighbourhood(name) {
  const agg = aggregates[name];
  if (!agg || (agg.east === 0 && agg.west === 0)) {
    return { fillColor: COLOUR_NEUTRAL, fillOpacity: 0.02, color: '#aaa', weight: 0.5 };
  }
  const total = agg.east + agg.west;
  const eastPct = agg.east / total;
  const confidence = Math.abs(eastPct - 0.5) * 2;
  const opacity = OPACITY_MIN + confidence * (OPACITY_MAX - OPACITY_MIN);
  const colour = eastPct >= 0.5 ? COLOUR_EAST : COLOUR_WEST;
  return { fillColor: colour, fillOpacity: opacity, color: '#aaa', weight: 0.5 };
}

function buildLabel(name) {
  const agg = aggregates[name];
  if (!agg || (agg.east === 0 && agg.west === 0)) {
    return name;
  }
  const total = agg.east + agg.west;
  const eastPct = Math.round((agg.east / total) * 100);
  return `${name}<br><span style="font-weight:400">${eastPct}% East</span>`;
}

// ── Drawing ────────────────────────────────────────────────────────────────
const EDGE_PAN_ZONE = 60;   // px from edge to trigger pan
const EDGE_PAN_SPEED = 8;   // px per frame
let edgePanFrame = null;
let lastMouseContainerPoint = null;

function startEdgePan() {
  if (edgePanFrame) return;
  function step() {
    if (!isDrawing || !lastMouseContainerPoint) { edgePanFrame = null; return; }
    const { x, y } = lastMouseContainerPoint;
    const { x: w, y: h } = map.getSize();
    let dx = 0, dy = 0;
    if (x < EDGE_PAN_ZONE) dx = -EDGE_PAN_SPEED * (1 - x / EDGE_PAN_ZONE);
    if (x > w - EDGE_PAN_ZONE) dx = EDGE_PAN_SPEED * (1 - (w - x) / EDGE_PAN_ZONE);
    if (y < EDGE_PAN_ZONE) dy = -EDGE_PAN_SPEED * (1 - y / EDGE_PAN_ZONE);
    if (y > h - EDGE_PAN_ZONE) dy = EDGE_PAN_SPEED * (1 - (h - y) / EDGE_PAN_ZONE);
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
  if (drawnPolyline) {
    map.removeLayer(drawnPolyline);
    drawnPolyline = null;
  }
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
  if (drawnPoints.length > 1) {
    lastClassified = classifyAndShow();
  }
});

// ── Classification ─────────────────────────────────────────────────────────
function classifyAndShow() {
  const classified = { east: [], west: [] };

  const line = turf.lineString(drawnPoints.map(([lat, lng]) => [lng, lat]));

  geojsonData.features.forEach(feature => {
    const name = feature.properties.AREA_NAME;

    let polygons = [];
    if (feature.geometry.type === 'Polygon') {
      polygons = [turf.polygon(feature.geometry.coordinates)];
    } else if (feature.geometry.type === 'MultiPolygon') {
      polygons = feature.geometry.coordinates.map(coords => turf.polygon(coords));
    }

    let eastArea = 0;
    let westArea = 0;

    polygons.forEach(poly => {
      try {
        const split = turf.lineSplit(poly, line);
        if (split.features.length < 2) {
          const centroid = turf.centroid(poly);
          const side = getSideOfLine(centroid.geometry.coordinates, drawnPoints);
          if (side === 'east') eastArea += turf.area(poly);
          else westArea += turf.area(poly);
        } else {
          split.features.forEach(piece => {
            const pieceCentroid = turf.centroid(piece);
            const side = getSideOfLine(pieceCentroid.geometry.coordinates, drawnPoints);
            if (side === 'east') eastArea += turf.area(piece);
            else westArea += turf.area(piece);
          });
        }
      } catch (e) {
        const centroid = turf.centroid(poly);
        const side = getSideOfLine(centroid.geometry.coordinates, drawnPoints);
        if (side === 'east') eastArea += turf.area(poly);
        else westArea += turf.area(poly);
      }
    });

    if (eastArea >= westArea) {
      classified.east.push(name);
    } else {
      classified.west.push(name);
    }
  });

  highlightClassification(classified);
  showControls();
  return classified;
}

function getSideOfLine(point, linePoints) {
  let minDist = Infinity;
  let sign = 0;

  for (let i = 0; i < linePoints.length - 1; i++) {
    const ax = linePoints[i][1];
    const ay = linePoints[i][0];
    const bx = linePoints[i + 1][1];
    const by = linePoints[i + 1][0];
    const px = point[0];
    const py = point[1];

    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const closestX = ax + t * dx;
    const closestY = ay + t * dy;
    const dist = Math.hypot(px - closestX, py - closestY);

    if (dist < minDist) {
      minDist = dist;
      sign = dx * (py - ay) - dy * (px - ax);
    }
  }

  return sign > 0 ? 'west' : 'east';
}

function highlightClassification(classified) {
  if (neighbourhoodLayer) map.removeLayer(neighbourhoodLayer);
  labelLayers.forEach(l => map.removeLayer(l));
  labelLayers = [];

  neighbourhoodLayer = L.geoJSON(geojsonData, {
    style: feature => {
      const name = feature.properties.AREA_NAME;
      if (classified.east.includes(name)) {
        return { fillColor: COLOUR_EAST, fillOpacity: 0.12, color: '#aaa', weight: 0.5 };
      } else if (classified.west.includes(name)) {
        return { fillColor: COLOUR_WEST, fillOpacity: 0.12, color: '#aaa', weight: 0.5 };
      }
      return { fillColor: COLOUR_NEUTRAL, fillOpacity: 0.02, color: '#aaa', weight: 0.5 };
    },
  }).addTo(map);
}

function showControls() {
  document.getElementById('controls').classList.remove('hidden');
}

// ── Controls ───────────────────────────────────────────────────────────────
document.getElementById('btn-redraw').addEventListener('click', () => {
  if (drawnPolyline) {
    map.removeLayer(drawnPolyline);
    drawnPolyline = null;
  }
  drawnPoints = [];
  lastClassified = null;
  document.getElementById('controls').classList.add('hidden');
  renderNeighbourhoods();
});

document.getElementById('btn-submit').addEventListener('click', async () => {
  if (!lastClassified) return;

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  // Thin points to every 5th to reduce document size, store as flat objects
  const thinned = drawnPoints
    .filter((_, i) => i % 5 === 0)
    .map(p => ({ lat: Number(p[0]), lng: Number(p[1]) }));

  await setDoc(doc(db, 'submissions', userId), {
    timestamp: new Date().toISOString(),
    line: thinned,
    east: lastClassified.east.map(String),
    west: lastClassified.west.map(String),
  });

  const toast = document.getElementById('toast');
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);

  await loadAggregates();

  btn.disabled = false;
  btn.textContent = 'Submit my answer';
  document.getElementById('controls').classList.add('hidden');

  if (drawnPolyline) {
    map.removeLayer(drawnPolyline);
    drawnPolyline = null;
  }
  drawnPoints = [];
  lastClassified = null;
  renderNeighbourhoods();
});

// ── Touch support ──────────────────────────────────────────────────────────
map.on('touchstart', e => {
  if (e.touches && e.touches.length === 1) {
    isDrawing = true;
    const touch = e.touches[0];
    const latlng = map.containerPointToLatLng([touch.clientX, touch.clientY]);
    drawnPoints = [[latlng.lat, latlng.lng]];
    if (drawnPolyline) {
      map.removeLayer(drawnPolyline);
      drawnPolyline = null;
    }
    map.dragging.disable();
  }
});

map.on('touchmove', e => {
  if (!isDrawing || !e.touches || e.touches.length !== 1) return;
  e.originalEvent.preventDefault();
  const touch = e.touches[0];
  const latlng = map.containerPointToLatLng([touch.clientX, touch.clientY]);
  drawnPoints.push([latlng.lat, latlng.lng]);
  if (drawnPolyline) map.removeLayer(drawnPolyline);
  drawnPolyline = L.polyline(drawnPoints, { color: '#e63946', weight: 3 }).addTo(map);
});

map.on('touchend', () => {
  if (!isDrawing) return;
  isDrawing = false;
  map.dragging.enable();
  if (drawnPoints.length > 1) {
    lastClassified = classifyAndShow();
  }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
  await loadAggregates();
  await loadNeighbourhoods();
}
init();
