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
  const confidence = Math.abs(eastPct - 0.5) * 2; // 0 at 50/50, 1 at 100/0
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

// ── Bootstrap ──────────────────────────────────────────────────────────────
loadNeighbourhoods();
