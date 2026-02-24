// ── Constants ──────────────────────────────────────────────────────────────
const TORONTO_CENTER = [43.7181, -79.3762];
const TORONTO_ZOOM = 11;

const COLOUR_NEUTRAL = '#aaaaaa';
const COLOUR_EAST = '#e07b39';   // orange
const COLOUR_WEST = '#4a90d9';   // blue
const OPACITY_MIN = 0.15;
const OPACITY_MAX = 0.75;

// ── Map setup ──────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView(TORONTO_CENTER, TORONTO_ZOOM);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
  maxZoom: 19,
}).addTo(map);

// ── State ──────────────────────────────────────────────────────────────────
let geojsonData = null;
let neighbourhoodLayer = null;
let labelLayers = [];
let aggregates = {};   // { "Leslieville": { east: 12, west: 3 }, ... }

let isDrawing = false;
let drawnPoints = [];   // [[lat, lng], ...]
let drawnPolyline = null;
let lastClassified = null;

// ── Load GeoJSON ───────────────────────────────────────────────────────────
async function loadNeighbourhoods() {
  const response = await fetch('data/toronto-neighbourhoods.geojson');
  geojsonData = await response.json();
  renderNeighbourhoods();
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

  // Add labels at polygon centroids
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
    return { fillColor: COLOUR_NEUTRAL, fillOpacity: 0.3, color: '#666', weight: 1 };
  }
  const total = agg.east + agg.west;
  const eastPct = agg.east / total;
  const confidence = Math.abs(eastPct - 0.5) * 2;
  const opacity = OPACITY_MIN + confidence * (OPACITY_MAX - OPACITY_MIN);
  const colour = eastPct >= 0.5 ? COLOUR_EAST : COLOUR_WEST;
  return { fillColor: colour, fillOpacity: opacity, color: '#666', weight: 1 };
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
map.on('mousedown', e => {
  isDrawing = true;
  drawnPoints = [[e.latlng.lat, e.latlng.lng]];
  if (drawnPolyline) {
    map.removeLayer(drawnPolyline);
    drawnPolyline = null;
  }
  map.dragging.disable();
});

map.on('mousemove', e => {
  if (!isDrawing) return;
  drawnPoints.push([e.latlng.lat, e.latlng.lng]);
  if (drawnPolyline) map.removeLayer(drawnPolyline);
  drawnPolyline = L.polyline(drawnPoints, { color: '#e63946', weight: 3 }).addTo(map);
});

map.on('mouseup', () => {
  if (!isDrawing) return;
  isDrawing = false;
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

// Determine which side of the drawn polyline a [lng, lat] point is on.
function getSideOfLine(point, linePoints) {
  let minDist = Infinity;
  let sign = 0;

  for (let i = 0; i < linePoints.length - 1; i++) {
    const ax = linePoints[i][1];     // lng
    const ay = linePoints[i][0];     // lat
    const bx = linePoints[i + 1][1];
    const by = linePoints[i + 1][0];
    const px = point[0];             // lng
    const py = point[1];             // lat

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
        return { fillColor: COLOUR_EAST, fillOpacity: 0.5, color: '#666', weight: 1 };
      } else if (classified.west.includes(name)) {
        return { fillColor: COLOUR_WEST, fillOpacity: 0.5, color: '#666', weight: 1 };
      }
      return { fillColor: COLOUR_NEUTRAL, fillOpacity: 0.3, color: '#666', weight: 1 };
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

// ── Bootstrap ──────────────────────────────────────────────────────────────
loadNeighbourhoods();
