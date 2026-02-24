# East vs. West Toronto Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a static, public-facing web tool where users draw a freehand line on a Toronto neighbourhood map to define east vs. west, with crowd-sourced results displayed as percentages on each neighbourhood.

**Architecture:** Single-page static HTML/CSS/JS app with no build step. Leaflet.js renders the map and Toronto neighbourhood GeoJSON. Turf.js handles geometric intersection to classify neighbourhoods by majority area. Firebase Firestore (via CDN SDK) persists submissions, keyed by a per-browser UUID stored in localStorage.

**Tech Stack:** HTML5, CSS3, vanilla JS (ES modules), Leaflet.js 1.9 (CDN), Turf.js 6.5 (CDN), Firebase JS SDK v10 (CDN), GitHub Pages

---

## Prerequisites (manual, before starting)

1. Download Toronto neighbourhood GeoJSON from the City of Toronto open data portal:
   - URL: https://open.toronto.ca/dataset/neighbourhoods/
   - Download the GeoJSON version
   - Save to `data/toronto-neighbourhoods.geojson`

2. Create a Firebase project:
   - Go to console.firebase.google.com
   - Create a new project (e.g. `eastwesttoronto`)
   - Add a Web app to get the config object
   - Enable Firestore Database in **test mode**
   - Keep the config object handy — you'll paste it into `app.js` in Task 4

---

### Task 1: Project scaffold

**Files:**
- Create: `index.html`
- Create: `style.css`
- Create: `app.js`
- Create: `.gitignore`
- Create: `data/` directory (empty, for GeoJSON)

**Step 1: Initialize git repo**

```bash
cd /Users/DMcMillan@globeandmail.com/Documents/Code/2026-personal-eastwesttoronto
git init
```

**Step 2: Create `.gitignore`**

```
.DS_Store
node_modules/
```

**Step 3: Create empty placeholder files**

```bash
touch index.html style.css app.js
mkdir -p data
```

**Step 4: Commit scaffold**

```bash
git add .
git commit -m "chore: initial project scaffold"
```

---

### Task 2: HTML structure

**Files:**
- Modify: `index.html`

**Step 1: Write `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>East vs. West Toronto</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div id="header">
    <h1>East vs. West Toronto</h1>
    <p id="instructions">Draw a line across the map to show where you think east Toronto ends and west Toronto begins.</p>
  </div>

  <div id="map"></div>

  <div id="controls" class="hidden">
    <button id="btn-submit">Submit my answer</button>
    <button id="btn-redraw">Redraw</button>
  </div>

  <div id="toast" class="hidden">Thanks! Your answer has been recorded.</div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="https://unpkg.com/@turf/turf@6.5.0/turf.min.js"></script>
  <type="module" src="app.js"></script>
</body>
</html>
```

Note: Fix the script tag for app.js — it should be:
```html
<script type="module" src="app.js"></script>
```

**Step 2: Verify HTML renders in browser**

Open `index.html` directly in a browser (or use `python3 -m http.server 8080` and visit `http://localhost:8080`). You should see the heading and a blank area where the map will go.

**Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add HTML structure"
```

---

### Task 3: CSS layout and styling

**Files:**
- Modify: `style.css`

**Step 1: Write `style.css`**

```css
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f5f5f5;
}

#header {
  padding: 12px 20px;
  background: #fff;
  border-bottom: 1px solid #ddd;
}

#header h1 {
  font-size: 1.3rem;
  font-weight: 700;
  color: #1a1a1a;
}

#instructions {
  font-size: 0.9rem;
  color: #555;
  margin-top: 4px;
}

#map {
  flex: 1;
  cursor: crosshair;
}

#controls {
  padding: 12px 20px;
  background: #fff;
  border-top: 1px solid #ddd;
  display: flex;
  gap: 12px;
}

#controls.hidden {
  display: none;
}

button {
  padding: 8px 20px;
  border: none;
  border-radius: 4px;
  font-size: 0.95rem;
  cursor: pointer;
}

#btn-submit {
  background: #1a73e8;
  color: #fff;
}

#btn-submit:hover {
  background: #1557b0;
}

#btn-redraw {
  background: #e8e8e8;
  color: #333;
}

#btn-redraw:hover {
  background: #d0d0d0;
}

#toast {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  background: #323232;
  color: #fff;
  padding: 10px 24px;
  border-radius: 4px;
  font-size: 0.9rem;
  z-index: 9999;
}

#toast.hidden {
  display: none;
}

/* Neighbourhood labels */
.neighbourhood-label {
  background: transparent;
  border: none;
  box-shadow: none;
  font-size: 10px;
  font-weight: 600;
  color: #333;
  text-shadow: 0 0 3px #fff, 0 0 3px #fff;
  white-space: nowrap;
  pointer-events: none;
}
```

**Step 2: Reload browser and verify layout looks sensible (header, map area, no controls yet)**

**Step 3: Commit**

```bash
git add style.css
git commit -m "feat: add CSS layout and styling"
```

---

### Task 4: Map initialization and neighbourhood rendering

**Files:**
- Modify: `app.js`
- Requires: `data/toronto-neighbourhoods.geojson` (must be downloaded first — see Prerequisites)

**Step 1: Write the map init and GeoJSON rendering in `app.js`**

```javascript
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
```

**Step 2: Serve locally and verify**

```bash
python3 -m http.server 8080
```

Visit `http://localhost:8080`. You should see the Carto basemap with Toronto neighbourhoods outlined in grey. Labels should appear at centroids.

Expected: ~140 grey neighbourhood polygons with name labels.

**Step 3: Commit**

```bash
git add app.js
git commit -m "feat: render Toronto neighbourhoods on Leaflet map"
```

---

### Task 5: Freehand drawing

**Files:**
- Modify: `app.js`

**Step 1: Add drawing state and event handlers to `app.js`**

Add these variables to the State section:
```javascript
let isDrawing = false;
let drawnPoints = [];   // [[lat, lng], ...]
let drawnPolyline = null;
```

Add this drawing logic after the Bootstrap section:

```javascript
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
    classifyAndShow();
  }
});
```

**Step 2: Verify drawing works**

Reload `http://localhost:8080`. Click and drag across the map. A red line should appear as you draw. On mouse-up, nothing else happens yet (classifyAndShow doesn't exist yet — that's fine, you'll get a console error which is expected).

**Step 3: Commit**

```bash
git add app.js
git commit -m "feat: add freehand drawing on map"
```

---

### Task 6: Classification logic (Turf.js)

**Files:**
- Modify: `app.js`

**Step 1: Add `classifyAndShow` function**

This function takes the drawn polyline, splits each neighbourhood polygon by the line, and classifies each neighbourhood as east or west based on majority area.

Add after the drawing section:

```javascript
// ── Classification ─────────────────────────────────────────────────────────
function classifyAndShow() {
  const classified = { east: [], west: [] };

  // Build a long LineString from drawn points for Turf
  const line = turf.lineString(drawnPoints.map(([lat, lng]) => [lng, lat]));

  geojsonData.features.forEach(feature => {
    const name = feature.properties.AREA_NAME;

    // Ensure we have a Polygon (not MultiPolygon) — handle both
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
        // Try to split the polygon by the line
        const split = turf.lineSplit(poly, line);
        if (split.features.length < 2) {
          // Line doesn't intersect this polygon — it's entirely on one side
          // Use centroid to determine which side
          const centroid = turf.centroid(poly);
          const side = getSideOfLine(centroid.geometry.coordinates, drawnPoints);
          if (side === 'east') eastArea += turf.area(poly);
          else westArea += turf.area(poly);
        } else {
          // Split occurred — compute area on each side
          split.features.forEach(piece => {
            const pieceCentroid = turf.centroid(piece);
            const side = getSideOfLine(pieceCentroid.geometry.coordinates, drawnPoints);
            if (side === 'east') eastArea += turf.area(piece);
            else westArea += turf.area(piece);
          });
        }
      } catch (e) {
        // Fallback: use centroid
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

  // Colour map with this classification
  highlightClassification(classified);
  showControls();
  return classified;
}

// Determine which side of the drawn polyline a [lng, lat] point is on.
// Uses the cross-product of the overall line direction vector.
// "East" = right side when travelling along the polyline north-to-south;
// we define east as positive x (higher longitude).
// Simpler approach: project the point onto the nearest segment and check sign.
function getSideOfLine(point, linePoints) {
  // Find the nearest segment of the drawn line to this point
  let minDist = Infinity;
  let sign = 0;

  for (let i = 0; i < linePoints.length - 1; i++) {
    const ax = linePoints[i][1];     // lng
    const ay = linePoints[i][0];     // lat
    const bx = linePoints[i + 1][1];
    const by = linePoints[i + 1][0];
    const px = point[0];             // lng (turf centroid is [lng, lat])
    const py = point[1];             // lat

    // Distance from point to segment
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const closestX = ax + t * dx;
    const closestY = ay + t * dy;
    const dist = Math.hypot(px - closestX, py - closestY);

    if (dist < minDist) {
      minDist = dist;
      // Cross product z-component: (b-a) × (p-a)
      sign = dx * (py - ay) - dy * (px - ax);
    }
  }

  // Positive cross product = point is to the left of the line direction = west (lower longitude)
  // Negative = right = east (higher longitude)
  // This gives a geographic "east is right" when the line runs roughly N-S
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

// Store last classification for submit
let lastClassified = null;

// Override classifyAndShow to store result
const _classifyAndShow = classifyAndShow;
// (Replace the call in mouseup with direct assignment)
```

**Step 2: Update mouseup handler to store classification result**

Replace the mouseup handler with:
```javascript
map.on('mouseup', () => {
  if (!isDrawing) return;
  isDrawing = false;
  map.dragging.enable();
  if (drawnPoints.length > 1) {
    lastClassified = classifyAndShow();
  }
});
```

And remove the override attempt at the bottom of Step 1 (the `_classifyAndShow` lines). Also update `classifyAndShow` to return `classified` at the end:
```javascript
  // At the end of classifyAndShow, before the closing brace:
  return classified;
```

**Step 3: Test classification**

Reload the page. Draw a line roughly north-south through the middle of Toronto. On mouse-up, neighbourhoods west of your line should turn blue and east should turn orange. The Submit/Redraw buttons should appear.

**Step 4: Commit**

```bash
git add app.js
git commit -m "feat: classify neighbourhoods by majority area using Turf.js"
```

---

### Task 7: Redraw button

**Files:**
- Modify: `app.js`

**Step 1: Add redraw handler**

```javascript
// ── Controls ───────────────────────────────────────────────────────────────
document.getElementById('btn-redraw').addEventListener('click', () => {
  if (drawnPolyline) {
    map.removeLayer(drawnPolyline);
    drawnPolyline = null;
  }
  drawnPoints = [];
  lastClassified = null;
  document.getElementById('controls').classList.add('hidden');
  renderNeighbourhoods(); // re-render with aggregated colours
});
```

**Step 2: Test redraw**

Draw a line, see classification. Click Redraw — line should disappear, controls should hide, map should return to grey (or aggregated colours if there's data).

**Step 3: Commit**

```bash
git add app.js
git commit -m "feat: add redraw button"
```

---

### Task 8: Firebase Firestore integration

**Files:**
- Modify: `app.js`

**Prerequisite:** You need your Firebase config object from the Firebase console. It looks like:
```javascript
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "yourproject.firebaseapp.com",
  projectId: "yourproject",
  storageBucket: "yourproject.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

**Step 1: Add Firebase imports and init at the top of `app.js`**

Replace the top of `app.js` with:

```javascript
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getFirestore, collection, doc, setDoc, getDocs } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

// ── Firebase config (paste your config here) ───────────────────────────────
const firebaseConfig = {
  apiKey: "PASTE_YOUR_API_KEY",
  authDomain: "PASTE_YOUR_AUTH_DOMAIN",
  projectId: "PASTE_YOUR_PROJECT_ID",
  storageBucket: "PASTE_YOUR_STORAGE_BUCKET",
  messagingSenderId: "PASTE_YOUR_SENDER_ID",
  appId: "PASTE_YOUR_APP_ID"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
```

**Step 2: Add UUID helper and submission loading**

Add to the State section:
```javascript
// Get or create a persistent UUID for this browser
function getUserId() {
  let id = localStorage.getItem('eastwest_uuid');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('eastwest_uuid', id);
  }
  return id;
}
const userId = getUserId();
```

Add a `loadAggregates` function and call it during bootstrap:

```javascript
async function loadAggregates() {
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
}
```

Update Bootstrap to load aggregates before rendering:
```javascript
// ── Bootstrap ──────────────────────────────────────────────────────────────
async function init() {
  await loadAggregates();
  await loadNeighbourhoods();
}
init();
```

**Step 3: Add submit handler**

```javascript
document.getElementById('btn-submit').addEventListener('click', async () => {
  if (!lastClassified) return;

  const btn = document.getElementById('btn-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  await setDoc(doc(db, 'submissions', userId), {
    timestamp: new Date().toISOString(),
    line: drawnPoints,
    east: lastClassified.east,
    west: lastClassified.west,
  });

  // Show toast
  const toast = document.getElementById('toast');
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 3000);

  // Update local aggregates so re-renders reflect this submission
  await loadAggregates();

  btn.disabled = false;
  btn.textContent = 'Submit my answer';
  document.getElementById('controls').classList.add('hidden');

  // Re-render with updated aggregates
  if (drawnPolyline) {
    map.removeLayer(drawnPolyline);
    drawnPolyline = null;
  }
  drawnPoints = [];
  lastClassified = null;
  renderNeighbourhoods();
});
```

**Step 4: Paste your Firebase config values**

Open `app.js` and replace the `PASTE_YOUR_*` placeholders with your actual Firebase config values.

**Step 5: Test submission**

Reload the page. Draw a line, click Submit. Check the Firebase console — you should see a document appear in the `submissions` collection. Reload the page — neighbourhoods should now show colours and percentages.

Draw again from the same browser and submit — the Firestore document should be overwritten (same UUID), not duplicated.

**Step 6: Commit (without committing API key — add to .gitignore or use env)**

Add to `.gitignore`:
```
# Firebase config is embedded in app.js — do not commit real keys to public repos
# If open-sourcing, replace with environment-specific config
```

```bash
git add app.js .gitignore
git commit -m "feat: add Firebase Firestore read/write for submissions"
```

---

### Task 9: GitHub Pages deployment

**Files:**
- No code changes needed

**Step 1: Create GitHub repo**

```bash
gh repo create 2026-personal-eastwesttoronto --public --source=. --remote=origin --push
```

Or manually via github.com, then:
```bash
git remote add origin https://github.com/YOUR_USERNAME/2026-personal-eastwesttoronto.git
git push -u origin main
```

**Step 2: Enable GitHub Pages**

Go to the repo on github.com → Settings → Pages → Source: Deploy from branch → Branch: `main` → folder: `/ (root)` → Save.

**Step 3: Verify deployment**

Visit `https://YOUR_USERNAME.github.io/2026-personal-eastwesttoronto/`. The page should load the map.

**Step 4: Update Firebase authorized domains**

In the Firebase console → Authentication → Settings → Authorized domains, add your GitHub Pages domain (`YOUR_USERNAME.github.io`).

Also update Firestore rules if needed to allow reads/writes from this origin.

---

### Task 10: Final polish and touch devices

**Files:**
- Modify: `app.js`

Touch devices use `touchstart`/`touchmove`/`touchend` instead of mouse events.

**Step 1: Add touch event support**

Add after the mouse event handlers:

```javascript
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
```

**Step 2: Test on mobile (or browser DevTools device emulation)**

**Step 3: Commit**

```bash
git add app.js
git commit -m "feat: add touch support for mobile drawing"
git push
```

---

## Notes

- **Firebase API key security:** Firebase web API keys for Firestore with public read/write are designed to be exposed in client-side code. The real security is in Firestore Rules. For this project, test mode (open read/write) is fine. If you want to lock it down later, set rules to allow read for all but require a valid UUID format for writes.
- **`turf.lineSplit` edge cases:** Some neighbourhood polygons may not split cleanly (self-intersections, etc). The try/catch fallback in Task 6 handles these gracefully by falling back to centroid-based classification.
- **GeoJSON field name:** The City of Toronto GeoJSON uses `AREA_NAME` for neighbourhood names. If your downloaded file uses a different field, search for `AREA_NAME` in `app.js` and replace accordingly.
