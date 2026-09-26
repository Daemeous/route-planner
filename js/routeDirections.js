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

  // ── Which tracker stretch each step covers ──
  // A step is one pavement of a stretch of road; the live tracker records
  // done stretches per row as "seg<fragment>:<from>-<to>:<side>" fractions
  // of that row's road_geometry fragments, B = both sides, S = the right of
  // the fragment's own direction, F = its left (see graph.js). Worked out
  // here, at build time, where the rows' full geometry is to hand, so the
  // published app can report a ticked step without any geometry of its own.
  const MARK_NEAR_M = 8;     // step line to row line: same road
  const MARK_ALIGN = 0.85;   // |cos| of the angle between them: running along it, not across
  const MARK_MIN_M = 5;      // shorter overlaps are junction crossings

  // WKT fragments as [lat,lon] lists, keeping each fragment's index even if
  // it doesn't parse (the tracker counts fragments the same way).
  function rowFragments(roadGeometry) {
    return String(roadGeometry || '').split('|').map(part => {
      const m = part.match(/LINESTRING\s*\((.*)\)/i);
      if (!m) return [];
      return m[1].split(',').map(pair => { const [lon, lat] = pair.trim().split(/\s+/).map(Number); return [lat, lon]; })
        .filter(p => isFinite(p[0]) && isFinite(p[1]));
    });
  }

  function stepMarker(route, rowsByIndex) {
    const pts = [];
    const frags = [];
    for (const rowIndex of new Set(route.roads.map(rd => rd.rowIndex).filter(i => i != null))) {
      const row = rowsByIndex.get(rowIndex);
      if (!row) continue;
      rowFragments(row.roadGeometry).forEach((f, idx) => { if (f.length >= 2) { frags.push({ rowIndex, idx, f }); pts.push(...f); } });
    }
    if (!frags.length) return () => [];
    const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const xy = ([lat, lon]) => [lon * kx, lat * ky];
    frags.forEach(fr => {
      fr.pts = fr.f.map(xy);
      fr.cum = [0];
      for (let i = 1; i < fr.pts.length; i++) fr.cum.push(fr.cum[i - 1] + Math.hypot(fr.pts[i][0] - fr.pts[i - 1][0], fr.pts[i][1] - fr.pts[i - 1][1]));
      fr.len = fr.cum[fr.cum.length - 1];
    });

    // Nearest aligned point on any fragment: {fr, t (fraction), fwd}.
    function snap(p, dir) {
      let best = null;
      for (const fr of frags) {
        if (!fr.len) continue;
        for (let i = 1; i < fr.pts.length; i++) {
          const a = fr.pts[i - 1], b = fr.pts[i];
          const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
          if (!L) continue;
          const cos = (dx * dir[0] + dy * dir[1]) / L;
          if (Math.abs(cos) < MARK_ALIGN) continue;
          const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L * L)));
          const d = Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
          if (d <= MARK_NEAR_M && (!best || d < best.d)) best = { d, fr, t: (fr.cum[i - 1] + u * L) / fr.len, fwd: cos > 0 };
        }
      }
      return best;
    }

    // -> [[rowIndex, token], ...] for one step.
    return leg => {
      if (leg.pavement === 'back' || leg.alreadyDone || leg.homes < 0.5) return [];
      const line = leg.latlngs.map(xy);
      const samples = [];
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!L) continue;
        const dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
        for (let s = 0, n = Math.max(1, Math.ceil(L / 3)); s <= n; s++) samples.push(snap([a[0] + dir[0] * L * s / n, a[1] + dir[1] * L * s / n], dir));
      }
      // Runs of consecutive samples on the same fragment, same direction.
      const runs = [];
      let cur = null;
      for (const h of samples) {
        if (!h) { cur = null; continue; }
        if (!cur || cur.fr !== h.fr || cur.fwd !== h.fwd) { cur = { fr: h.fr, fwd: h.fwd, a: h.t, b: h.t }; runs.push(cur); }
        cur.a = Math.min(cur.a, h.t); cur.b = Math.max(cur.b, h.t);
      }
      // Delivering the pavement on your right while walking the fragment's
      // way is its right side (S); every other combination flips it.
      return runs.filter(r => (r.b - r.a) * r.fr.len >= MARK_MIN_M).map(r => {
        const side = leg.pavement === 'both' ? 'B' : ((leg.pavement === 'right') === r.fwd ? 'S' : 'F');
        return [r.fr.rowIndex, `seg${r.fr.idx}:${r.a.toFixed(4)}-${r.b.toFixed(4)}:${side}`];
      });
    };
  }

  function compact(plan, markStep = () => []) {
    return {
      legs: plan.legs.map(l => l.type === 'transfer'
        ? { type: 'transfer', len: Math.round(l.len), latlngs: l.latlngs.map(p => [round6(p[0]), round6(p[1])]) }
        : {
          type: 'leg', n: l.n, street: l.street, side: l.side, dir: l.dir, pavement: l.pavement, alreadyDone: l.alreadyDone || undefined,
          homes: Math.round(l.homes * 10) / 10, len: Math.round(l.len), cue: l.cue, endCue: l.endCue || undefined,
          latlngs: l.latlngs.map(p => [round6(p[0]), round6(p[1])]),
          marks: (m => (m.length ? m : undefined))(markStep(l)),
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
    const rowsByIndex = new Map(rows.filter(r => r.rowIndex != null).map(r => [r.rowIndex, r]));
    let planned = 0, failed = 0;
    for (const route of payload.routes) {
      try {
        const roads = route.roads.map(rd => ({
          street: rd.name, res: rd.residences, segments: toLatLngSegments(rd.geometry),
          homes: rd.homes ? rd.homes.map(([lon, lat]) => [lat, lon]) : null,
          halfDone: rd.halfDone ? rd.halfDone.map(h => ({ side: h.side, pts: h.pts.map(([lon, lat]) => [lat, lon]) })) : null,
        }))
          .filter(rd => rd.segments.length);
        const plan = WalkOrder.plan({ roads }, { start: startFor(route, payload), network, driveSparse: route.kind === 'drive' });
        route.directions = compact(plan, stepMarker(route, rowsByIndex));
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
