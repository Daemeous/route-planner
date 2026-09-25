// Assembles the final route payload from a clustering result -- port of
// pipeline/map_data.py. This is the shared data shape both the interactive
// map view and the printable route sheets are built from.
'use strict';
if (typeof require !== 'undefined') {
  if (typeof Geo === 'undefined') global.Geo = require('./geo');
  if (typeof Homes === 'undefined') global.Homes = require('./homes');
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

  // General ward routes have no event start: every route has its own
  // suggested spot -- somewhere to begin on foot for a street route, or to
  // park for a lane route.
  function generalStartHintText(kind, spotLabel) {
    const spot = String(spotLabel).replace(/\s*\(part [\d.]+\)$/, '');
    return kind === 'drive'
      ? `Park on ${spot} (suggested — please use your own discretion)`
      : `Start on ${spot} (suggested — if you're driving, park nearby with discretion)`;
  }

  function startHintText(kind, pubLabel, parkingLabel) {
    if (kind === 'walk') return `${pubLabel} (event start point)`;
    if (kind === 'hybrid') return `Drive to ${parkingLabel} and park there (suggested — please use your own discretion), then walk the route`;
    return `Park on ${parkingLabel} (suggested — please use your own discretion)`;
  }

  function routeFromCluster(cid, c, roads, adjacency, hubPoint, hubLabel, hubId, originalGeometry, general = false) {
    const shape = Cluster.clusterShape(c.roads, adjacency);
    let marker = null;
    if (c.kind !== 'walk' || general) {
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
      // Home positions on this part (build-time only: walking directions use
      // them to give each step its real homes; not copied into the app).
      if (rd.homePoints) {
        const on = Homes.pointsOn(rd.homePoints, rd.remainingGeometry);
        if (on.length) entry.homes = on;
      }
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
        if (rd.homesTrimmed) { entry.homesTrimmed = true; entry.rootName = rd.rootName; }
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
      startHint: general ? generalStartHintText(c.kind, marker.label) : startHintText(c.kind, hubLabel, marker ? marker.label : null),
      notes,
      roads: roadList,
      marker,
    };
    if (hubId !== undefined && !general) {
      route.hubId = hubId;
      route.hub = { point: hubPoint, label: hubLabel };
    }
    return route;
  }

  // Rows cut down to their stretches with homes (Graph.trimToHomes) have
  // empty bits no route walks. So that reporting every kept part done still
  // completes the row in the tracker, each part's REPORTED range is
  // stretched over the empty bits beside it (halfway to the next part, or
  // to the end), and a fragment no part touches goes to a neighbouring
  // part. What's walked is unchanged -- only what "done" covers.
  function extendTrimmedReportRanges(routesOut, originalGeometry) {
    if (!originalGeometry) return;
    const byRow = new Map();
    for (const r of routesOut) for (const e of r.roads) {
      if (!e.homesTrimmed || !e.originalRanges || !e.originalRanges.length) continue;
      if (!byRow.has(e.rootName)) byRow.set(e.rootName, []);
      byRow.get(e.rootName).push(e);
    }
    for (const [root, entries] of byRow) {
      const orig = originalGeometry[root];
      if (!orig) continue;
      const per = orig.fullGeometry.map(() => []);
      entries.forEach(e => e.originalRanges.forEach(rg => { if (per[rg.fragIdx]) per[rg.fragIdx].push(rg); }));
      per.forEach(list => {
        if (!list.length) return;
        list.sort((x, y) => x.a - y.a);
        list[0].a = 0;
        list[list.length - 1].b = 1;
        for (let i = 1; i < list.length; i++) {
          if (list[i].a > list[i - 1].b) { const mid = (list[i - 1].b + list[i].a) / 2; list[i - 1].b = mid; list[i].a = mid; }
        }
      });
      per.forEach((list, fi) => {
        if (list.length) return;
        let owner = null;
        for (let d = 1; d < per.length && !owner; d++) {
          for (const j of [fi - d, fi + d]) {
            const hit = per[j] && per[j].length && entries.find(e => e.originalRanges.some(rg => rg.fragIdx === j));
            if (hit) { owner = hit; break; }
          }
        }
        (owner || entries[0]).originalRanges.push({ fragIdx: fi, a: 0, b: 1 });
      });
    }
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
    extendTrimmedReportRanges(routesOut, originalGeometry);
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
  // general: routes with no event start (see Pipeline.buildGeneral) -- the
  // local areas were only used to organise the clustering, so they're not
  // passed on as hubs/start points.
  function buildMapDataMultihub(roads, adjacency, hubSpecs, wardName, originalGeometry, { general = false } = {}) {
    const totalRoutes = hubSpecs.reduce((s, h) => s + h.clusters.length, 0);
    const ids = genIds(totalRoutes);
    let idIdx = 0;
    const routesOut = [], hubsOut = [];
    for (const hub of hubSpecs) {
      hubsOut.push({ id: hub.id, label: hub.label, point: hub.point });
      for (const c of hub.clusters) {
        const cid = ids[idIdx++];
        routesOut.push(routeFromCluster(cid, c, roads, adjacency, hub.point, hub.label, hub.id, originalGeometry, general));
      }
    }
    extendTrimmedReportRanges(routesOut, originalGeometry);
    const secrets = SecretWords.assignSecretWords(routesOut.map(r => r.id), wardName);
    for (const r of routesOut) r.secret = secrets[r.id];
    if (general) {
      const b = boundsOf(routesOut);
      return {
        ward: wardName,
        general: true,
        routes: routesOut,
        hubs: [],
        start: { point: [(b.lonMin + b.lonMax) / 2, (b.latMin + b.latMax) / 2], label: `${wardName} ward` },
        bounds: b,
      };
    }
    return {
      ward: wardName,
      routes: routesOut,
      hubs: hubsOut,
      start: { point: hubsOut[0].point, label: hubsOut[0].label },
      bounds: boundsOf(routesOut),
    };
  }

  return { genIds, routeName, startHintText, generalStartHintText, routeFromCluster, buildMapData, buildMapDataMultihub };
})();

if (typeof module !== 'undefined') module.exports = MapData;
