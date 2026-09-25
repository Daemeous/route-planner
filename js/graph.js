// Road network graph: parsing, adjacency, splitting, network distances.
// Direct port of pipeline/graph.py. Row objects here are plain JS objects
// keyed by whatever the sheet's header row says (see sheets.js for the
// column-mapping layer that normalises arbitrary headers into the fixed
// keys this module expects: street, status, residences, wardName,
// roadGeometry, partialGeometry).
'use strict';
if (typeof require !== 'undefined' && typeof Geo === 'undefined') { global.Geo = require('./geo'); }
if (typeof require !== 'undefined' && typeof Homes === 'undefined') { global.Homes = require('./homes'); }

const Graph = (() => {
  const SNAP_TOLERANCE_M = 50;

  const NON_RESIDENTIAL_KEYWORDS = /footpath|bridleway|cycleway|cycle\s?path|\btrack\b|\bservices?\b|drive.?through|access point|viaduct|culvert|footbridge|\bbyway\b/i;
  const PROW_NUMBER_SUFFIX = /\s\d{1,4}$/;

  function isNonResidentialFeature(name, residences) {
    if (NON_RESIDENTIAL_KEYWORDS.test(name)) return true;
    if (PROW_NUMBER_SUFFIX.test(name) && residences <= 5) return true;
    return false;
  }

  function parseLinestrings(s) {
    return s.split('|').map(p => {
      const m = p.trim().match(/LINESTRING\((.*)\)/);
      if (!m) throw new Error('bad LINESTRING: ' + p);
      return m[1].split(',').map(pair => {
        const [lon, lat] = pair.trim().split(' ').map(Number);
        return [lon, lat];
      });
    });
  }

  // partial_geometry is "seg<fragment>:<from>-<to>:<side>" ranges joined by
  // "|", in fractions of each LINESTRING fragment. The side, as the live
  // tracker (leaflet-map core.js) reads it: B = both sides done; S = the
  // right-hand side done and F = the left-hand side, relative to the
  // fragment's own direction (S is drawn offset +5 m, F -5 m). An S and an
  // F over the same stretch together make both sides.
  function parsePartialSides(s) {
    const d = new Map(); // fragment -> {B:[[a,b]], S:[...], F:[...]}
    if (!s || s === '-') return d;
    for (const tok of s.split('|')) {
      const m = tok.match(/seg(\d+):([\d.]+)-([\d.]+):(\w)/);
      if (!m) continue;
      const idx = parseInt(m[1], 10), side = m[4] === 'S' || m[4] === 'F' ? m[4] : 'B';
      if (!d.has(idx)) d.set(idx, { B: [], S: [], F: [] });
      const a = parseFloat(m[2]), b = parseFloat(m[3]);
      d.get(idx)[side].push([Math.min(a, b), Math.max(a, b)]);
    }
    return d;
  }

  const mergeIntervals = list => {
    const out = [];
    for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
      if (out.length && a <= out[out.length - 1][1] + 1e-9) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const intersectIntervals = (A, B) => {
    const out = [];
    for (const [a1, b1] of A) for (const [a2, b2] of B) { const a = Math.max(a1, a2), b = Math.min(b1, b2); if (b > a) out.push([a, b]); }
    return mergeIntervals(out);
  };
  const subtractIntervals = (A, B) => {
    let out = A.map(x => [...x]);
    for (const [c, d] of B) {
      out = out.flatMap(([a, b]) => (d <= a || c >= b ? [[a, b]] : [...(c > a ? [[a, c]] : []), ...(d < b ? [[d, b]] : [])]));
    }
    return out.filter(([a, b]) => b - a > 1e-9);
  };

  // Partial completion is marked by tapping a map, so it's never exact. With
  // fragment lengths (metres) given, ranges are cleaned up before use:
  //   - any range under PARTIAL_MIN_M is a stray tap and is ignored;
  //   - done stretches less than PARTIAL_MIN_M apart, or that stop less
  //     than PARTIAL_MIN_M short of either end, are joined up -- otherwise
  //     "done to here" + "done from here" leaves a sliver still "to do".
  const PARTIAL_MIN_M = 10;
  const dropTiny = (list, L) => (L ? list.filter(([a, b]) => (b - a) * L >= PARTIAL_MIN_M) : list);
  function closeGaps(list, L) {
    const merged = mergeIntervals(list);
    if (!L || !merged.length) return merged;
    const tol = PARTIAL_MIN_M / L;
    const out = [];
    for (const [a, b] of merged) {
      if (out.length && a - out[out.length - 1][1] < tol) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
      else out.push([a, b]);
    }
    if (out[0][0] < tol) out[0][0] = 0;
    if (1 - out[out.length - 1][1] < tol) out[out.length - 1][1] = 1;
    return out;
  }

  // Fully done ranges per fragment: B ranges, plus where an S and an F
  // overlap. fragLens (metres per fragment) turns on the tolerance above.
  function parsePartial(s, fragLens = null) {
    const d = new Map();
    for (const [idx, sides] of parsePartialSides(s)) {
      const L = fragLens ? fragLens[idx] : null;
      const S = closeGaps(dropTiny(sides.S, L), L), F = closeGaps(dropTiny(sides.F, L), L);
      const full = closeGaps(dropTiny([...dropTiny(sides.B, L), ...intersectIntervals(S, F)], L), L);
      if (full.length) d.set(idx, full);
    }
    return d;
  }

  // One-side-only ranges per fragment: [{a, b, side: 'S'|'F'}] -- that side's
  // done, the other side still needs delivering.
  function parseHalfDone(s, fragLens = null) {
    const d = new Map();
    const full = parsePartial(s, fragLens);
    for (const [idx, sides] of parsePartialSides(s)) {
      const L = fragLens ? fragLens[idx] : null;
      const done = full.get(idx) || [];
      const half = [
        ...dropTiny(subtractIntervals(closeGaps(dropTiny(sides.S, L), L), done), L).map(([a, b]) => ({ a, b, side: 'S' })),
        ...dropTiny(subtractIntervals(closeGaps(dropTiny(sides.F, L), L), done), L).map(([a, b]) => ({ a, b, side: 'F' })),
      ];
      if (half.length) d.set(idx, half);
    }
    return d;
  }

  // rows: array of {street, status, residences, wardName, lat, lon, roadGeometry, partialGeometry}
  function loadRoads(rows, { ward = null, excludeNonResidential = false } = {}) {
    const filtered = ward === null ? rows : rows.filter(r => r.wardName === ward);
    const excluded = [];
    const kept = [];
    for (const r of filtered) {
      if (excludeNonResidential && r.status !== 'Complete') {
        if (isNonResidentialFeature(r.street, r.residences)) { excluded.push(r.street); continue; }
      }
      kept.push(r);
    }
    if (!kept.length) throw new Error(`No rows found for ward=${JSON.stringify(ward)}`);

    Geo.setLatRef(kept.reduce((s, r) => s + r.lat, 0) / kept.length);

    const roads = {};
    for (const r of kept) {
      const linestrings = parseLinestrings(r.roadGeometry);
      const lengths = linestrings.map(Geo.segLength);
      const totalLen = lengths.reduce((a, b) => a + b, 0);
      const partial = parsePartial(r.partialGeometry, lengths);     // both sides done
      const halfDone = parseHalfDone(r.partialGeometry, lengths);  // one side done
      // Where the homes are along the road (data/homes, see js/homes.js), as
      // points on the line -- null if unknown, and everything below then
      // falls back to spreading the homes evenly by length.
      const homePoints = r.homeFracs && typeof Homes !== 'undefined' ? Homes.pointsOnLine(linestrings, r.homeFracs) : null;

      let remainingGeom, coveredGeom, estResidences, halfPieces = null;
      if (r.status === 'In_Progress') {
        let coveredLen = 0;
        remainingGeom = []; coveredGeom = [];
        linestrings.forEach((pts, idx) => {
          const ranges = partial.get(idx) || [];
          const L = lengths[idx];
          for (const [a, b] of ranges) coveredLen += (b - a) * L;
          remainingGeom.push(...Geo.remainingSubpaths(pts, ranges));
          coveredGeom.push(...Geo.coveredSubpaths(pts, ranges));
        });
        // One-side-done stretches stay in the route (the other side still
        // needs delivering) but count as half done. Their geometry, in the
        // fragment's own direction, lets walking directions skip the done side.
        let halfLen = 0;
        halfPieces = [];
        linestrings.forEach((pts, idx) => {
          for (const h of halfDone.get(idx) || []) {
            halfLen += (h.b - h.a) * lengths[idx];
            const [piece] = Geo.coveredSubpaths(pts, [[h.a, h.b]]);
            if (piece) halfPieces.push({ pts: piece, side: h.side });
          }
        });
        const remainingLen = totalLen - coveredLen;
        const fracRemaining = totalLen ? (remainingLen - halfLen / 2) / totalLen : 0;
        estResidences = r.residences * fracRemaining;
        // With home positions, "40% of the length done" becomes "the homes
        // actually on the done stretch are done".
        if (homePoints) {
          const counts = Homes.distribute(homePoints, [...remainingGeom, ...coveredGeom]);
          const onRemaining = counts.slice(0, remainingGeom.length).reduce((a, b) => a + b, 0);
          const total = counts.reduce((a, b) => a + b, 0);
          const onHalf = Homes.pointsOn(homePoints, halfPieces.map(h => h.pts)).length;
          if (total) estResidences = r.residences * (onRemaining - onHalf / 2) / total;
        }
      } else if (r.status === 'Complete') {
        remainingGeom = []; coveredGeom = linestrings; estResidences = 0;
      } else {
        // 'Not_Started', 'Planned', or any other not-yet-delivered status --
        // this tool does its own fresh route planning, so a road someone
        // flagged as "Planned" in the live tracker is still fully eligible.
        remainingGeom = linestrings; coveredGeom = []; estResidences = r.residences;
      }

      roads[r.street] = {
        name: r.street,
        status: r.status,
        residencesFull: r.residences,
        coveredGeometry: coveredGeom,
        residencesRemaining: estResidences,
        fullGeometry: linestrings,
        remainingGeometry: remainingGeom,
        totalLengthM: totalLen,
        rowIndex: r.rowIndex,
        partialGeometryRaw: r.partialGeometry,
        homePoints,
        halfDone: halfPieces && halfPieces.length ? halfPieces : null,
      };
    }
    if (excluded.length) console.log(`Excluded ${excluded.length} non-residential features:`, excluded);
    return roads;
  }

  function buildAdjacency(roads, tolerance = SNAP_TOLERANCE_M) {
    const names = Object.keys(roads);
    const endpoints = {}, allVerts = {};
    for (const name of names) {
      const eps = [], verts = [];
      for (const seg of roads[name].fullGeometry) {
        eps.push(seg[0], seg[seg.length - 1]);
        verts.push(...seg);
      }
      endpoints[name] = eps;
      allVerts[name] = verts;
    }

    const bucketSize = 0.001;
    const buckets = new Map();
    const key = (bx, by) => bx + ',' + by;
    for (const name of names) {
      for (const v of allVerts[name]) {
        const bx = Math.floor(v[0] / bucketSize), by = Math.floor(v[1] / bucketSize);
        const k = key(bx, by);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push([name, v]);
      }
    }
    function nearby(pt) {
      const bx = Math.floor(pt[0] / bucketSize), by = Math.floor(pt[1] / bucketSize);
      const out = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const b = buckets.get(key(bx + dx, by + dy));
        if (b) out.push(...b);
      }
      return out;
    }

    const adjacency = {};
    const addEdge = (a, b) => {
      if (!adjacency[a]) adjacency[a] = new Set();
      adjacency[a].add(b);
    };
    for (const a of names) {
      for (const ep of endpoints[a]) {
        let bestD = 1e9, bestName = null;
        for (const [b, v] of nearby(ep)) {
          if (b === a) continue;
          const d = Geo.distM(ep, v);
          if (d < bestD) { bestD = d; bestName = b; }
        }
        if (bestD <= tolerance) { addEdge(a, bestName); addEdge(bestName, a); }
      }
    }
    return adjacency;
  }

  function roadNetworkDistances(roads, adjacency, startPoint, entryRadiusM = 250) {
    const crow = {};
    for (const n of Object.keys(roads)) {
      const pt = Geo.nearestPointOnMultiline(roads[n].fullGeometry, startPoint);
      crow[n] = pt ? Geo.distM(startPoint, pt) : Infinity;
    }
    let entries = Object.keys(crow).filter(n => crow[n] <= entryRadiusM);
    if (!entries.length && Object.keys(crow).length) {
      entries = [Object.keys(crow).reduce((best, n) => (crow[n] < crow[best] ? n : best))];
    }

    const dist = {};
    for (const n of Object.keys(roads)) dist[n] = Infinity;
    // simple binary-heap-free priority queue (arrays are small: per-ward road counts)
    const pq = [];
    for (const n of entries) { dist[n] = crow[n]; pq.push([dist[n], n]); }

    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, n] = pq.shift();
      if (d > dist[n]) continue;
      for (const nb of (adjacency[n] || [])) {
        if (!(nb in roads)) continue;
        const nd = d + (roads[nb].totalLengthM || 0);
        if (nd < dist[nb]) { dist[nb] = nd; pq.push([nd, nb]); }
      }
    }
    for (const n of Object.keys(roads)) if (dist[n] === Infinity) dist[n] = crow[n];
    return dist;
  }

  function nearestFractionHelper(frag, cum, total, ep, tolerance) {
    return Geo.nearestFractionOnFrag(frag, cum, total, ep, tolerance);
  }

  // Best (fragIdx, fraction) match for `point` across EVERY fragment of
  // `geometry`, no tolerance cutoff (always returns the closest one) --
  // used to work out where a split road-part's endpoint falls within the
  // TRUE original road_geometry, so a route that only covers part of a
  // long/disconnected road can report progress against the right slice of
  // the original row's partial_geometry rather than the whole thing.
  function bestFractionAcrossFragments(geometry, point) {
    let best = { fragIdx: -1, frac: 0, dist: Infinity };
    geometry.forEach((frag, fragIdx) => {
      const { cum, total } = Geo.cumLengths(frag);
      for (let i = 0; i < frag.length - 1; i++) {
        const [x1, y1] = frag[i], [x2, y2] = frag[i + 1];
        const dx = x2 - x1, dy = y2 - y1;
        const L2 = dx * dx + dy * dy;
        const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - x1) * dx + (point[1] - y1) * dy) / L2));
        const px = x1 + t * dx, py = y1 + t * dy;
        const d = Geo.distM(point, [px, py]);
        if (d < best.dist) {
          const frac = total === 0 ? 0 : (cum[i] + t * (cum[i + 1] - cum[i])) / total;
          best = { fragIdx, frac, dist: d };
        }
      }
    });
    return best;
  }

  // originalGeometry: the TRUE, unsplit road_geometry fragments for this
  // road (captured before splitLongRoads/splitDisconnectedRoads ran).
  // partPoints: the point sequence of one split-off part. Returns the
  // partial_geometry-format range(s) -- [{fragIdx, a, b}, ...] -- covering
  // that part within the original geometry, so marking just this part done
  // writes only the right slice back, not the whole original row.
  //
  // Matches the endpoints geometrically rather than composing split
  // fractions analytically, which sidesteps having to track fraction
  // provenance through every prior transformation (an already-partial
  // In_Progress road, a long-road split, an Area split can each shift what
  // "fraction 0.4 of this fragment" even refers to) -- a nearest-point
  // match against the one thing that never changes, the original
  // coordinates, is simpler and just as accurate for this purpose. The one
  // known gap: a part whose endpoints land on two non-adjacent original
  // fragments (spanning 3+ fragments) is approximated as covering the
  // start fragment tail-to-end and the end fragment start-to-fraction,
  // skipping any fragment fully enclosed in between it can't see from just
  // the two endpoints -- rare, and reviewable from the Pending queue like
  // any other proposed change.
  function originalRangesForPart(originalGeometry, partPoints) {
    if (!partPoints.length) return [];
    const startMatch = bestFractionAcrossFragments(originalGeometry, partPoints[0]);
    const endMatch = bestFractionAcrossFragments(originalGeometry, partPoints[partPoints.length - 1]);
    if (startMatch.fragIdx === -1 || endMatch.fragIdx === -1) return [];

    if (startMatch.fragIdx === endMatch.fragIdx) {
      const a = Math.min(startMatch.frac, endMatch.frac), b = Math.max(startMatch.frac, endMatch.frac);
      return [{ fragIdx: startMatch.fragIdx, a, b }];
    }
    return [
      { fragIdx: startMatch.fragIdx, a: Math.min(startMatch.frac, 1), b: 1 },
      { fragIdx: endMatch.fragIdx, a: 0, b: Math.max(endMatch.frac, 0) },
    ];
  }

  // Name for the i-th part cut from road `name`: "X (part 2)", or
  // "X (part 2.1)" when `name` is already a part. Skips (and then claims)
  // anything already in `taken` -- a road split at junctions keeps its
  // leftover under its own name, and a later split of that leftover must
  // not reuse "(part 1)" etc. and overwrite the first split's parts.
  function partNameFor(name, i, taken) {
    const isPart = / \(part [\d.]+\)$/.test(name);
    let n = i + 1, cand;
    do { cand = isPart ? name.replace(/\)$/, `.${n})`) : `${name} (part ${n})`; n++; } while (taken && taken.has(cand));
    if (taken) taken.add(cand);
    return cand;
  }

  // Share `road`'s remaining homes between pieces of its remaining geometry,
  // by where its homes actually are. Returns an array of residences, or null
  // when positions are unknown (callers keep their length-based figures).
  function residencesByHomes(road, pieces) {
    if (!road.homePoints || !pieces.length) return null;
    const counts = Homes.distribute(road.homePoints, pieces);
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return null;
    return counts.map(c => road.residencesRemaining * c / total);
  }

  function splitLongRoads(roads, { threshold = 100, minSegmentRes = 40, edgeMargin = 0.08, mergeTolerance = 0.08, tolerance = SNAP_TOLERANCE_M } = {}) {
    const eligibleNames = Object.keys(roads).filter(n => roads[n].status !== 'Complete');
    const otherEndpoints = {};
    for (const n of eligibleNames) {
      const eps = [];
      for (const seg of roads[n].fullGeometry) eps.push(seg[0], seg[seg.length - 1]);
      otherEndpoints[n] = eps;
    }

    const newRoads = {};
    const taken = new Set(Object.keys(roads));
    for (const [name, r] of Object.entries(roads)) {
      if (r.status === 'Complete' || r.residencesRemaining <= threshold || !r.remainingGeometry.length) {
        newRoads[name] = r;
        continue;
      }
      const fragLens = r.remainingGeometry.map(Geo.segLength);
      const totalLen = fragLens.reduce((a, b) => a + b, 0) || 1;
      const candidateEps = [];
      for (const n2 of eligibleNames) if (n2 !== name) candidateEps.push(...otherEndpoints[n2]);

      const untouched = [];
      const splitParts = [];
      let anySplit = false;

      r.remainingGeometry.forEach((frag, fi) => {
        const flen = fragLens[fi];
        const fragRes = r.residencesRemaining * (flen / totalLen);
        if (fragRes <= threshold || frag.length < 3) { untouched.push([frag, fragRes]); return; }

        const { cum, total: ftotal } = Geo.cumLengths(frag);
        const fracs = [];
        for (const ep of candidateEps) {
          const { d, frac } = nearestFractionHelper(frag, cum, ftotal, ep, tolerance);
          if (frac !== null && frac >= edgeMargin && frac <= 1 - edgeMargin) fracs.push(frac);
        }
        fracs.sort((a, b) => a - b);
        const mergedFracs = [];
        for (const f of fracs) {
          if (!mergedFracs.length || f - mergedFracs[mergedFracs.length - 1] > mergeTolerance) mergedFracs.push(f);
        }
        if (!mergedFracs.length) { untouched.push([frag, fragRes]); return; }

        const bounds = [0, ...mergedFracs, 1];
        let subParts = [];
        for (let i = 0; i < bounds.length - 1; i++) {
          const a = bounds[i], b = bounds[i + 1];
          const startPt = Geo.pointAtFraction(frag, cum, ftotal, a);
          const endPt = Geo.pointAtFraction(frag, cum, ftotal, b);
          const mid = frag.filter((_, i2) => cum[i2] > a * ftotal && cum[i2] < b * ftotal);
          const pts = [startPt, ...mid, endPt];
          subParts.push([pts, fragRes * (b - a)]);
        }

        let i = 0;
        while (i < subParts.length) {
          const [pts, res] = subParts[i];
          if (res < minSegmentRes && subParts.length > 1) {
            if (i === 0) {
              const [npts, nres] = subParts[i + 1];
              subParts[i + 1] = [[...pts.slice(0, -1), ...npts], nres + res];
            } else {
              const [ppts, pres] = subParts[i - 1];
              subParts[i - 1] = [[...ppts.slice(0, -1), ...pts], pres + res];
            }
            subParts.splice(i, 1);
          } else { i++; }
        }

        if (subParts.length <= 1) { untouched.push([frag, fragRes]); return; }
        anySplit = true;
        splitParts.push(...subParts);
      });

      if (!anySplit) { newRoads[name] = r; continue; }

      // Where the homes really are, when known (the split points themselves
      // are still decided by the length-based estimate above).
      const byHomes = residencesByHomes(r, [...untouched.map(([pts]) => pts), ...splitParts.map(([pts]) => pts)]);
      if (byHomes) {
        untouched.forEach((u, i) => { u[1] = byHomes[i]; });
        splitParts.forEach((sp, i) => { sp[1] = byHomes[untouched.length + i]; });
      }
      if (untouched.length) {
        const remGeom = untouched.map(([pts]) => pts);
        newRoads[name] = {
          ...r,
          residencesRemaining: untouched.reduce((s, [, res]) => s + res, 0),
          fullGeometry: remGeom,
          remainingGeometry: remGeom,
          coveredGeometry: [],
          totalLengthM: remGeom.reduce((s, p) => s + Geo.segLength(p), 0),
        };
      }
      splitParts.forEach(([pts, res], i) => {
        const partName = partNameFor(name, i, taken);
        newRoads[partName] = {
          ...r,
          name: partName,
          residencesFull: r.residencesFull,
          residencesRemaining: res,
          fullGeometry: [pts],
          remainingGeometry: [pts],
          coveredGeometry: [],
          totalLengthM: Geo.segLength(pts),
          splitFrom: name,
          rootName: r.rootName || name,
        };
      });
    }
    return newRoads;
  }

  // Long roads often have their homes bunched in a village with long empty
  // stretches between (Newport Road, Gnosall: a third of its 14.7 km has no
  // homes). With home positions, cut a road down to the stretches that
  // have homes -- homes no more than gapM apart, plus marginM either side --
  // so routes stop walking or driving the empty bits. The dropped stretches
  // are still walkable for directions (they're in the walking network), and
  // mapData.js stretches each kept part's REPORTED range over the empty
  // bits next to it, so reporting every part done still completes the row.
  // Roads without positions, or where trimming would keep 85%+ of the
  // length anyway, are left exactly as they were.
  function trimToHomes(roads, { gapM = 250, marginM = 30, keepIfOverFrac = 0.85 } = {}) {
    const out = {};
    const taken = new Set(Object.keys(roads));
    for (const [name, r] of Object.entries(roads)) {
      if (!r.homePoints || r.status === 'Complete' || r.residencesRemaining <= 0 || !r.remainingGeometry.length) { out[name] = r; continue; }
      const stretches = []; // {pts, homes}
      let totalLen = 0, keptLen = 0, placed = 0;
      for (const frag of r.remainingGeometry) {
        const { cum, total } = Geo.cumLengths(frag);
        totalLen += total;
        const pos = Homes.positionsAlong(r.homePoints, frag);
        placed += pos.length;
        let i = 0;
        while (i < pos.length) {
          let j = i;
          while (j + 1 < pos.length && pos[j + 1] - pos[j] <= gapM) j++;
          const a = Math.max(0, pos[i] - marginM), b = Math.min(total, pos[j] + marginM);
          if (b - a > 1) {
            const pts = [Geo.pointAtFraction(frag, cum, total, a / total), ...frag.filter((_, k) => cum[k] > a && cum[k] < b), Geo.pointAtFraction(frag, cum, total, b / total)];
            stretches.push({ pts, homes: j - i + 1 });
            keptLen += b - a;
          }
          i = j + 1;
        }
      }
      if (!placed || !stretches.length || keptLen >= keepIfOverFrac * totalLen) { out[name] = r; continue; }
      const one = stretches.length === 1;
      stretches.forEach((st, k) => {
        const partName = one ? name : partNameFor(name, k, taken);
        out[partName] = {
          ...r,
          name: partName,
          residencesRemaining: r.residencesRemaining * st.homes / placed,
          fullGeometry: [st.pts],
          remainingGeometry: [st.pts],
          coveredGeometry: [],
          totalLengthM: Geo.segLength(st.pts),
          splitFrom: name,
          rootName: r.rootName || name,
          homesTrimmed: true,
        };
      });
    }
    return out;
  }

  function indexGroupsByIsolation(fragments, isolationThresholdM) {
    const n = fragments.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (find(i) === find(j)) continue;
        let best = Infinity;
        for (const p of [fragments[i][0], fragments[i][fragments[i].length - 1]]) {
          for (const q of [fragments[j][0], fragments[j][fragments[j].length - 1]]) {
            best = Math.min(best, Geo.distM(p, q));
          }
        }
        if (best <= isolationThresholdM) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const g = find(i);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(i);
    }
    return [...groups.values()];
  }

  function fragCentroid(frag) {
    const xs = frag.map(p => p[0]), ys = frag.map(p => p[1]);
    return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
  }

  function splitDisconnectedRoads(roads, isolationThresholdM = 600) {
    const newRoads = {};
    for (const [name, r] of Object.entries(roads)) {
      const frags = r.fullGeometry;
      if (frags.length < 2) { newRoads[name] = r; continue; }
      const idxGroups = indexGroupsByIsolation(frags, isolationThresholdM);
      if (idxGroups.length <= 1) { newRoads[name] = r; continue; }

      const groupCentroids = idxGroups.map(idxs => fragCentroid(frags[idxs[0]]));
      const nearestGroup = frag => {
        const c = fragCentroid(frag);
        let best = 0, bestD = Infinity;
        groupCentroids.forEach((gc, gi) => { const d = Geo.distM(c, gc); if (d < bestD) { bestD = d; best = gi; } });
        return best;
      };

      const fullByGroup = idxGroups.map(() => []);
      idxGroups.forEach((idxs, gi) => idxs.forEach(i => fullByGroup[gi].push(frags[i])));
      const remainingByGroup = idxGroups.map(() => []);
      for (const frag of r.remainingGeometry) remainingByGroup[nearestGroup(frag)].push(frag);
      const coveredByGroup = idxGroups.map(() => []);
      for (const frag of r.coveredGeometry) coveredByGroup[nearestGroup(frag)].push(frag);

      const totalRemainingLen = r.remainingGeometry.reduce((s, f) => s + Geo.segLength(f), 0) || 1;
      const groupsHomes = residencesByHomes(r, r.remainingGeometry);
      const groupRes = gi => {
        if (!groupsHomes) return null;
        return r.remainingGeometry.reduce((s, f, fi) => s + (remainingByGroup[gi].includes(f) ? groupsHomes[fi] : 0), 0);
      };

      idxGroups.forEach((_, gi) => {
        const groupName = `${name} (Area ${gi + 1})`;
        const groupRemaining = remainingByGroup[gi];
        const groupLen = groupRemaining.reduce((s, f) => s + Geo.segLength(f), 0);
        const resShare = groupRes(gi) ?? r.residencesRemaining * (groupLen / totalRemainingLen);
        newRoads[groupName] = {
          ...r,
          name: groupName,
          residencesRemaining: resShare,
          fullGeometry: fullByGroup[gi],
          remainingGeometry: groupRemaining,
          coveredGeometry: coveredByGroup[gi],
          totalLengthM: fullByGroup[gi].reduce((s, f) => s + Geo.segLength(f), 0),
          splitFrom: name,
          rootName: r.rootName || name,
        };
      });
    }
    return newRoads;
  }

  return {
    isNonResidentialFeature, parseLinestrings, parsePartial, parsePartialSides, parseHalfDone, loadRoads,
    buildAdjacency, roadNetworkDistances, splitLongRoads, splitDisconnectedRoads, trimToHomes, residencesByHomes, partNameFor,
    bestFractionAcrossFragments, originalRangesForPart,
    SNAP_TOLERANCE_M,
  };
})();

if (typeof module !== 'undefined') module.exports = Graph;
