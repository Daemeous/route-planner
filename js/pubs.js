// Port of pipeline/pub_finder.py -- fetch pub/bar locations from OSM's
// Overpass API and shortlist the nearest ones to a ward's centroid. Runs
// directly in the browser (Overpass allows cross-origin requests).
'use strict';
if (typeof require !== 'undefined' && typeof fetch === 'undefined') { global.fetch = require('node-fetch'); }

const Pubs = (() => {
  // overpass.kumi.systems is deliberately NOT in this list -- confirmed via
  // a real browser that it doesn't send Access-Control-Allow-Origin, so a
  // page-side fetch() to it is rejected by CORS regardless of whether the
  // service itself is up. Fine for a server-side caller (no CORS
  // enforcement there), useless for this browser-only tool.
  const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://lz4.overpass-api.de/api/interpreter',
  ];

  async function queryOverpass(query, { timeoutMs = 40000, attempts = 4 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), timeoutMs);
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: query,
            signal: controller.signal,
          });
          clearTimeout(t);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return await res.json();
        } catch (e) { lastErr = e; }
      }
      await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
    }
    throw new Error(`Overpass API unreachable after ${attempts} attempts: ${lastErr}`);
  }

  // bbox = [minLat, minLon, maxLat, maxLon]
  async function fetchPubs(bbox) {
    const [minLat, minLon, maxLat, maxLon] = bbox;
    const query = `[out:json][timeout:50];(` +
      `node["amenity"="pub"](${minLat},${minLon},${maxLat},${maxLon});` +
      `way["amenity"="pub"](${minLat},${minLon},${maxLat},${maxLon});` +
      `node["amenity"="bar"](${minLat},${minLon},${maxLat},${maxLon});` +
      `);out center tags;`;
    const result = await queryOverpass(query);
    const pubs = [];
    for (const el of result.elements || []) {
      const name = el.tags && el.tags.name;
      if (!name) continue;
      let lat, lon;
      if (el.type === 'node') { lat = el.lat; lon = el.lon; }
      else { if (!el.center) continue; lat = el.center.lat; lon = el.center.lon; }
      pubs.push({ name, lat, lon });
    }
    return pubs;
  }

  function distM(lat1, lon1, lat2, lon2, latRef) {
    const dx = (lon2 - lon1) * 111320 * Math.cos(latRef * Math.PI / 180);
    const dy = (lat2 - lat1) * 111320;
    return Math.hypot(dx, dy);
  }

  function shortlistPubsForWard(pubs, weightedCentroid, topN = 5) {
    if (!pubs.length) return [];
    const [clon, clat] = weightedCentroid;
    const ranked = [...pubs].sort((a, b) => distM(clat, clon, a.lat, a.lon, clat) - distM(clat, clon, b.lat, b.lon, clat));
    return ranked.slice(0, topN).map(p => ({ ...p, distanceM: Math.round(distM(clat, clon, p.lat, p.lon, clat)) }));
  }

  return { fetchPubs, shortlistPubsForWard };
})();

if (typeof module !== 'undefined') module.exports = Pubs;
