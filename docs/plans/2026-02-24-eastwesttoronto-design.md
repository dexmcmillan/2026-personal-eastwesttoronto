# East vs. West Toronto — Design Doc

**Date:** 2026-02-24
**Project:** `2026-personal-eastwesttoronto`
**Hosting:** GitHub Pages (static)
**Persistence:** Firebase Firestore (free tier)

---

## Overview

A public-facing interactive web tool that lets users draw a freehand line across a map of Toronto to define where they think "east" ends and "west" begins. Each submission records which neighbourhoods fall on each side. On every load, the map shows aggregated results: what percentage of previous respondents classified each neighbourhood as east vs. west.

---

## Architecture

- Single `index.html` with companion CSS/JS files (no build step)
- Leaflet.js for map rendering (loaded from CDN)
- Firebase JS SDK (loaded from CDN) for Firestore reads/writes
- Toronto neighbourhood GeoJSON bundled in the repo
- Hosted on GitHub Pages

---

## Data

### GeoJSON Source
City of Toronto open data — neighbourhood boundaries (~140 neighbourhoods). Bundled as `data/toronto-neighbourhoods.geojson`. Key field: `AREA_NAME`.

### Firestore Schema
Collection: `submissions`
Document ID: user UUID (from `localStorage`) — overwrites on resubmit

```
submissions/{uuid}
  timestamp: string (ISO 8601)
  line: [[lat, lng], ...]       // freehand polyline points
  east: [string, ...]           // neighbourhood names classified as east
  west: [string, ...]           // neighbourhood names classified as west
```

### Deduplication
A UUID is generated on first visit and stored in `localStorage`. Subsequent submissions from the same browser session use `setDoc` with the same UUID, overwriting the previous entry.

---

## UI & Interaction Flow

1. Page loads with Leaflet map centered on Toronto, neighbourhoods outlined
2. Neighbourhoods coloured by aggregated east/west data (neutral grey if no data)
3. Each neighbourhood labelled: `"Leslieville — 84% East"` (or just name if no data)
4. User draws a freehand line by clicking and dragging across the map
   - Map panning disabled while drawing
   - Line renders in real-time
5. On mouse-up, line is finalized:
   - Neighbourhood classification computed (majority area rule)
   - East neighbourhoods coloured orange, west neighbourhoods coloured blue
   - Opacity scaled to confidence (faint at 51/49, vivid at 90/10)
6. **Submit** and **Redraw** buttons appear
   - Redraw clears the line and resets to aggregated view
   - Submit saves to Firestore, shows thank-you confirmation

---

## Classification Logic

For each neighbourhood polygon, compute what fraction of its area falls on each side of the drawn polyline using geometric intersection. The side containing > 50% of the area wins (majority rules).

Implementation: use **Turf.js** (loaded from CDN) for polygon/line intersection and area calculations.

---

## Results Aggregation

On every page load, read all Firestore submissions and compute per neighbourhood:

- `east_count` — submissions that classified it east
- `west_count` — submissions that classified it west
- `east_pct` — `east_count / (east_count + west_count) * 100`

Colour fill = majority side; opacity = confidence level.
Zero submissions → neutral grey, name-only labels.

---

## Files

```
2026-personal-eastwesttoronto/
├── index.html
├── style.css
├── app.js
├── data/
│   └── toronto-neighbourhoods.geojson
├── docs/
│   └── plans/
│       └── 2026-02-24-eastwesttoronto-design.md
└── .gitignore
```

---

## Firebase Setup (manual, one-time)

1. Create a Firebase project at console.firebase.google.com
2. Enable Firestore in test mode (or with rules allowing public read/write)
3. Copy the Firebase config object into `app.js`
4. No authentication required — anonymous public access
