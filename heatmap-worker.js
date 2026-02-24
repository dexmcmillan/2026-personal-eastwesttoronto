// Heatmap Web Worker
// Receives all submission polygons + precomputed grid centroids,
// runs point-in-polygon for each cell × each submission,
// and returns east/west count arrays via transferable buffers.

importScripts('https://unpkg.com/@turf/turf@6.5.0/turf.min.js');

self.onmessage = ({ data }) => {
  if (data.type !== 'compute') return;

  const { submissions, centroids, inMask, cols, rows } = data;
  const total = cols * rows;

  const eastCounts = new Int32Array(total);
  const westCounts = new Int32Array(total);

  for (const sub of submissions) {
    let eastPoly, westPoly;
    try {
      eastPoly = turf.polygon([sub.east]);
      westPoly = turf.polygon([sub.west]);
    } catch (e) {
      continue;
    }

    for (let i = 0; i < total; i++) {
      if (!inMask[i]) continue;
      const pt = turf.point([centroids[i * 2], centroids[i * 2 + 1]]);
      try {
        if (turf.booleanPointInPolygon(pt, eastPoly))      eastCounts[i]++;
        else if (turf.booleanPointInPolygon(pt, westPoly)) westCounts[i]++;
      } catch (e) {
        // skip this cell for this submission
      }
    }
  }

  self.postMessage({
    type: 'result',
    eastCounts: eastCounts.buffer,
    westCounts: westCounts.buffer,
    centroids: centroids.buffer,
    inMask: inMask.buffer,
  }, [eastCounts.buffer, westCounts.buffer, centroids.buffer, inMask.buffer]);
};
