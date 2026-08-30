// Orchestrates a full ward build -- port of the relevant parts of
// pipeline/run_ward.py (cmd_build, cmd_build_multihub, gen_hub_ids,
// _merge_hubs_sharing_a_pub, weighted_centroid).
'use strict';
if (typeof require !== 'undefined') {
  if (typeof Geo === 'undefined') global.Geo = require('./geo');
  if (typeof Graph === 'undefined') global.Graph = require('./graph');
  if (typeof Cluster === 'undefined') global.Cluster = require('./cluster');
  if (typeof MapData === 'undefined') global.MapData = require('./mapData');
  if (typeof Pubs === 'undefined') global.Pubs = require('./pubs');
}

const Pipeline = (() => {
  const MAX_SAME_PUB_MERGE_DISTANCE_M = 2000;

  function weightedCentroid(roads) {
    let tw = 0, sx = 0, sy = 0;
    for (const r of Object.values(roads)) {
      if (r.status === 'Complete') continue;
      const w = Math.max(r.residencesRemaining, 1);
      for (const seg of r.remainingGeometry) for (const [lon, lat] of seg) { sx += lon * w; sy += lat * w; tw += w; }
    }
    return tw === 0 ? null : [sx / tw, sy / tw];
  }

  function bboxOfRoads(roads, bufferDeg = 0.02) {
    const pts = [];
    for (const r of Object.values(roads)) for (const seg of r.fullGeometry) pts.push(...seg);
    const lats = pts.map(p => p[1]), lons = pts.map(p => p[0]);
    return [Math.min(...lats) - bufferDeg, Math.min(...lons) - bufferDeg, Math.max(...lats) + bufferDeg, Math.max(...lons) + bufferDeg];
  }

  function genHubIds(n) { return Array.from({ length: n }, (_, i) => `H${i + 1}`); }

  function mergeHubsSharingAPub(hubSpecs) {
    const merged = {}, order = [];
    for (const h of hubSpecs) {
      const key = h.label;
      const existing = merged[key];
      if (existing && Geo.distM(existing.point, h.point) <= MAX_SAME_PUB_MERGE_DISTANCE_M) {
        existing.clusters = existing.clusters.concat(h.clusters);
        continue;
      }
      const slotKey = !existing ? key : `${key} #${order.filter(k => k === key || k.startsWith(key + ' #')).length + 1}`;
      merged[slotKey] = { ...h };
      order.push(slotKey);
    }
    const out = order.map(k => merged[k]);
    out.forEach((h, i) => { h.id = `H${i + 1}`; });
    return out;
  }

  // Single-hub build: an explicit pub is given (a human judgement call, not
  // auto-picked) -- mirrors cmd_build.
  function captureOriginalGeometry(roads) {
    const out = {};
    for (const [n, r] of Object.entries(roads)) {
      out[n] = { fullGeometry: r.fullGeometry, rowIndex: r.rowIndex, partialGeometryRaw: r.partialGeometryRaw };
    }
    return out;
  }

  function buildSingleHub(rows, wardName, pubName, pubLat, pubLon, clusterOpts = {}) {
    let roads = Graph.loadRoads(rows, { ward: wardName });
    const originalGeometry = captureOriginalGeometry(roads);
    roads = Graph.splitLongRoads(roads);
    const adjacency = Graph.buildAdjacency(roads);
    const eventStart = [pubLon, pubLat];
    const clusters = Cluster.clusterRoads(roads, adjacency, eventStart, clusterOpts);
    return MapData.buildMapData(roads, adjacency, clusters, eventStart, pubName, wardName, originalGeometry);
  }

  // Multi-hub build for large/rural wards: settlements are found
  // automatically, and each settlement's pub is auto-picked from Overpass
  // results unless overridden -- mirrors cmd_build_multihub. Async because
  // it hits the Overpass API once per settlement (already-fetched `pubs`
  // list is passed in so callers can fetch it once for a whole district).
  async function buildMultiHub(rows, wardName, pubs, { maxRadiusM = 1000, overrides = {}, clusterOpts = {} } = {}) {
    let roadsAll = Graph.loadRoads(rows, { ward: wardName, excludeNonResidential: true });
    const originalGeometry = captureOriginalGeometry(roadsAll);
    roadsAll = Graph.splitDisconnectedRoads(roadsAll);
    const adjacencyAll = Graph.buildAdjacency(roadsAll);
    const settlements = Cluster.findSettlements(roadsAll, adjacencyAll, maxRadiusM);

    const hubIds = genHubIds(settlements.length);
    const hubSpecs = [];
    // Accumulates every settlement's OWN post-split road set -- NOT a copy
    // of roadsAll pre-split, since a road that got split within its
    // settlement no longer exists in roadsAll under its original name,
    // only under its "(part N)" names. Settlements' road-name groups are
    // disjoint by construction (see find_settlements), so each settlement
    // is authoritative for its own roads with no cross-settlement clashes.
    const mergedRoads = {};
    for (let i = 0; i < settlements.length; i++) {
      const group = settlements[i];
      let settlementRoads = {};
      for (const n of group) settlementRoads[n] = roadsAll[n];
      settlementRoads = Graph.splitLongRoads(settlementRoads);
      const settlementAdjacency = Graph.buildAdjacency(settlementRoads);
      Object.assign(mergedRoads, settlementRoads);

      const centroid = weightedCentroid(settlementRoads);
      let pubName, pubPoint;
      if (overrides[i]) {
        pubName = overrides[i].name; pubPoint = [overrides[i].lon, overrides[i].lat];
      } else {
        const shortlist = centroid ? Pubs.shortlistPubsForWard(pubs, centroid, 1) : [];
        if (shortlist.length) { pubName = shortlist[0].name; pubPoint = [shortlist[0].lon, shortlist[0].lat]; }
        else { pubName = `Settlement ${i} centre`; pubPoint = centroid; }
      }

      const clusters = Cluster.clusterRoads(settlementRoads, settlementAdjacency, pubPoint, clusterOpts);
      hubSpecs.push({ id: hubIds[i], label: pubName, point: pubPoint, clusters });
    }

    const merged = mergeHubsSharingAPub(hubSpecs);
    const mergedAdjacency = Graph.buildAdjacency(mergedRoads);
    return MapData.buildMapDataMultihub(mergedRoads, mergedAdjacency, merged, wardName, originalGeometry);
  }

  return { weightedCentroid, bboxOfRoads, genHubIds, mergeHubsSharingAPub, buildSingleHub, buildMultiHub };
})();

if (typeof module !== 'undefined') module.exports = Pipeline;
