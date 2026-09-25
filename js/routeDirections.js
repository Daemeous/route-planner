// Adds turn-by-turn walking directions to a built route payload (see
// mapData.js) -- the bridge between the route planner and js/walkOrder.js.
//
// Routes themselves are unchanged: this only works out the ORDER to walk
// each one in, starting where the route already starts (its parking spot
// for drive/hybrid routes, otherwise its hub/pub). Walk-ins follow real
// roads using a walking network built from every row in the sheet near the
// ward -- including roads already marked Complete (still walkable) and any
// no-homes rows below the sheet's ###ROUTE_PLANNER_ONLY_BELOW### marker
// (see sheets.js). Works the same with or without that marker.
//
// The result is stored on each route as `route.directions` in a compact,
// JSON-friendly shape, so the published app and print sheets only need to
// draw it -- neither has to run the planner itself.
'use strict';
if (typeof require !== 'undefined' && typeof WalkOrder === 'undefined') { global.WalkOrder = require('./walkOrder'); }

const RouteDirections = (() => {
  const NETWORK_PAD_DEG = 0.015; // ~1.5 km: walk-ins can start outside the ward
  const round6 = x => Math.round(x * 1e6) / 1e6;

  function rowSegments(roadGeometry) {
    try {
      return String(roadGeometry).split('|').map(part => part.match(/LINESTRING\((.*)\)/)[1].split(',').map(pair => {
        const [lon, lat] = pair.trim().split(' ').map(Number);
        return [lat, lon];
      })).filter(seg => seg.length >= 2 && seg.every(p => isFinite(p[0]) && isFinite(p[1])));
    } catch (e) { return []; }
  }

  // [[lon,lat],...] per segment (payload shape) -> [[lat,lon],...] (planner shape).
  const toLatLngSegments = geometry => geometry.filter(seg => seg.length >= 2).map(seg => seg.map(([lon, lat]) => [lat, lon]));

  function payloadBox(payload) {
    const pts = [];
    for (const r of payload.routes) for (const rd of r.roads) for (const seg of rd.geometry) pts.push(...seg);
    for (const h of payload.hubs || [payload.start]) pts.push(h.point);
    const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
    const pad = NETWORK_PAD_DEG;
    return { latMin: Math.min(...lats) - pad, latMax: Math.max(...lats) + pad, lonMin: Math.min(...lons) - pad * 1.6, lonMax: Math.max(...lons) + pad * 1.6 };
  }

  function buildNetworkFor(payload, rows, networkRows) {
    const box = payloadBox(payload);
    const inBox = ([la, lo]) => la > box.latMin && la < box.latMax && lo > box.lonMin && lo < box.lonMax;
    const roads = [];
    for (const r of [...rows, ...(networkRows || [])]) {
      const segments = rowSegments(r.roadGeometry);
      if (segments.some(seg => seg.some(inBox))) roads.push({ street: r.street, res: 0, segments });
    }
    return { network: WalkOrder.buildNetwork(roads), roadCount: roads.length, networkOnly: (networkRows || []).length };
  }

  function startFor(route, payload) {
    if (route.marker) {
      // General street routes: the marker is where to begin, not somewhere to park.
      const kind = payload.general && route.kind === 'walk' ? 'spot' : 'parking';
      return { latlng: [route.marker.point[1], route.marker.point[0]], label: route.marker.label, kind };
    }
    const hub = route.hub || payload.start;
    return { latlng: [hub.point[1], hub.point[0]], label: hub.label, kind: 'hub' };
  }

  function compact(plan) {
    return {
      legs: plan.legs.map(l => l.type === 'transfer'
        ? { type: 'transfer', len: Math.round(l.len), latlngs: l.latlngs.map(p => [round6(p[0]), round6(p[1])]) }
        : {
          type: 'leg', n: l.n, street: l.street, side: l.side, dir: l.dir, pavement: l.pavement,
          homes: Math.round(l.homes * 10) / 10, len: Math.round(l.len), cue: l.cue, endCue: l.endCue || undefined,
          latlngs: l.latlngs.map(p => [round6(p[0]), round6(p[1])]),
        }),
      stats: {
        steps: plan.stats.legs, homes: Math.round(plan.stats.homes),
        walkM: Math.round(plan.stats.walkM + plan.stats.transferM), crossings: plan.stats.crossings,
      },
    };
  }

  // Mutates payload: sets route.directions on every route. Returns a small
  // summary for the build log. A route that can't be planned (bad geometry)
  // simply gets no directions; everything else carries on.
  function addDirections(payload, rows, networkRows) {
    const { network, roadCount, networkOnly } = buildNetworkFor(payload, rows, networkRows);
    let planned = 0, failed = 0;
    for (const route of payload.routes) {
      try {
        const roads = route.roads.map(rd => ({
          street: rd.name, res: rd.residences, segments: toLatLngSegments(rd.geometry),
          homes: rd.homes ? rd.homes.map(([lon, lat]) => [lat, lon]) : null,
        }))
          .filter(rd => rd.segments.length);
        const plan = WalkOrder.plan({ roads }, { start: startFor(route, payload), network, driveSparse: route.kind === 'drive' });
        route.directions = compact(plan);
        planned++;
      } catch (e) {
        console.warn(`No directions for route ${route.id}:`, e);
        delete route.directions;
        failed++;
      }
    }
    return { planned, failed, roadCount, networkOnly };
  }

  return { addDirections, buildNetworkFor, rowSegments };
})();

if (typeof module !== 'undefined') module.exports = RouteDirections;
