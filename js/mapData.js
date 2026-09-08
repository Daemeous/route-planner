// Assembles the final route payload from a clustering result -- port of
// pipeline/map_data.py. This is the shared data shape both the interactive
// map view and the printable route sheets are built from.
'use strict';
if (typeof require !== 'undefined') {
  if (typeof Geo === 'undefined') global.Geo = require('./geo');
  if (typeof Graph === 'undefined') global.Graph = require('./graph');
  if (typeof Cluster === 'undefined') global.Cluster = require('./cluster');
  if (typeof SecretWords === 'undefined') global.SecretWords = require('./secretWords');
}

const MapData = (() => {
  function genIds(n) {
    const ids = [];
    let i = 0;
    while (ids.length < n) {
      i++;
      let s = '', x = i;
      while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
      ids.push(s);
    }
    return ids;
  }

  function baseName(roadName) {
    const i = roadName.lastIndexOf(' (part ');
    return i === -1 ? roadName : roadName.slice(0, i);
  }

  function routeName(roads, clusterRoadNames) {
    const ranked = [...clusterRoadNames].sort((a, b) => roads[b].residencesRemaining - roads[a].residencesRemaining);
    const topDisplay = [], seen = new Set();
    for (const n of ranked) {
      if (roads[n].residencesRemaining <= 0) continue;
      const base = baseName(n);
      if (seen.has(base)) continue;
      seen.add(base);
      topDisplay.push(base);
      if (topDisplay.length === 2) break;
    }
    if (!topDisplay.length) topDisplay.push(baseName(ranked[0]));
    return topDisplay.join(' & ');
  }

  function startHintText(kind, pubLabel, parkingLabel) {
    if (kind === 'walk') return `${pubLabel} (event start point)`;
    if (kind === 'hybrid') return `Drive to ${parkingLabel} and park there (suggested — please use your own discretion), then walk the route`;
    return `Park on ${parkingLabel} (suggested — please use your own discretion)`;
  }

  function routeFromCluster(cid, c, roads, adjacency, hubPoint, hubLabel, hubId, originalGeometry) {
    const shape = Cluster.clusterShape(c.roads, adjacency);
    let marker = null;
    if (c.kind !== 'walk') {
      const parkingName = Cluster.pickParkingRoad(roads, c.roads, adjacency);
      const ref = Cluster.roadCentroid(roads[parkingName], 'fullGeometry');
      const snapped = Geo.nearestPointOnMultiline(roads[parkingName].fullGeometry, ref);
      marker = { label: parkingName, point: snapped };
    }

    const roadList = c.roads.map(n => {
      const rd = roads[n];
      const entry = {
        name: n,
        status: rd.status,
        residences: Math.round(rd.residencesRemaining * 10) / 10,
        geometry: rd.remainingGeometry,
        rowIndex: rd.rowIndex,
      };
      // A road that was split (a long road cut into parts, or a same-named-
      // but-unrelated-fragments road cut into Areas) shares its row with
      // sibling parts on OTHER routes -- marking it done must write only
      // this part's slice of partial_geometry, never the whole row's
      // status, or it would wrongly mark those siblings done too.
      if (rd.rootName && originalGeometry && originalGeometry[rd.rootName]) {
        const orig = originalGeometry[rd.rootName];
        entry.rowIndex = orig.rowIndex;
        // Each remaining-geometry segment matched independently (not
        // flattened together) so a multi-segment Area-split part gets a
        // range per segment instead of one range spanning its endpoints.
        entry.originalRanges = rd.remainingGeometry.flatMap(seg => Graph.originalRangesForPart(orig.fullGeometry, seg));
        // The merge base for writing partial_geometry back -- this route
        // only proposes/updates the slice it covers, so whatever's already
        // recorded for the OTHER slices of this row must be preserved.
        entry.currentPartialGeometry = orig.partialGeometryRaw;
      }
      return entry;
    });

    const notes = c.geographicMerge
      ? "NEEDS REVIEW: combines roads not directly linked by a mapped road in this dataset (nearest-cluster fallback) — double-check there's a sensible walking/driving link between them, or split this route."
      : '';

    const route = {
      id: cid,
      name: routeName(roads, c.roads),
      kind: c.kind,
      shape,
      residencesTotal: Math.round(c.residences * 10) / 10,
      startHint: startHintText(c.kind, hubLabel, marker ? marker.label : null),
      notes,
      roads: roadList,
      marker,
    };
    if (hubId !== undefined) {
      route.hubId = hubId;
      route.hub = { point: hubPoint, label: hubLabel };
    }
    return route;
  }

  function boundsOf(routesOut) {
    const allPts = [];
    for (const r of routesOut) for (const rd of r.roads) for (const seg of rd.geometry) allPts.push(...seg);
    const lons = allPts.map(p => p[0]), lats = allPts.map(p => p[1]);
    return { lonMin: Math.min(...lons), lonMax: Math.max(...lons), latMin: Math.min(...lats), latMax: Math.max(...lats) };
  }

  function buildMapData(roads, adjacency, clusters, eventStart, pubLabel, wardName, originalGeometry) {
    const ids = genIds(clusters.length);
    const routesOut = clusters.map((c, i) => routeFromCluster(ids[i], c, roads, adjacency, eventStart, pubLabel, undefined, originalGeometry));
    const secrets = SecretWords.assignSecretWords(routesOut.map(r => r.id), wardName);
    for (const r of routesOut) r.secret = secrets[r.id];
    return {
      ward: wardName,
      routes: routesOut,
      start: { point: eventStart, label: pubLabel },
      bounds: boundsOf(routesOut),
    };
  }

  // hubSpecs: [{id, label, point, clusters}]
  function buildMapDataMultihub(roads, adjacency, hubSpecs, wardName, originalGeometry) {
    const totalRoutes = hubSpecs.reduce((s, h) => s + h.clusters.length, 0);
    const ids = genIds(totalRoutes);
    let idIdx = 0;
    const routesOut = [], hubsOut = [];
    for (const hub of hubSpecs) {
      hubsOut.push({ id: hub.id, label: hub.label, point: hub.point });
      for (const c of hub.clusters) {
        const cid = ids[idIdx++];
        routesOut.push(routeFromCluster(cid, c, roads, adjacency, hub.point, hub.label, hub.id, originalGeometry));
      }
    }
    const secrets = SecretWords.assignSecretWords(routesOut.map(r => r.id), wardName);
    for (const r of routesOut) r.secret = secrets[r.id];
    return {
      ward: wardName,
      routes: routesOut,
      hubs: hubsOut,
      start: { point: hubsOut[0].point, label: hubsOut[0].label },
      bounds: boundsOf(routesOut),
    };
  }

  return { genIds, routeName, startHintText, routeFromCluster, buildMapData, buildMapDataMultihub };
})();

if (typeof module !== 'undefined') module.exports = MapData;
