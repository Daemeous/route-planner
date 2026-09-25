// Route clustering: direct port of pipeline/cluster.py.
'use strict';
if (typeof require !== 'undefined' && typeof Geo === 'undefined') { global.Geo = require('./geo'); }
if (typeof require !== 'undefined' && typeof Graph === 'undefined') { global.Graph = require('./graph'); }
if (typeof require !== 'undefined' && typeof Homes === 'undefined') { global.Homes = require('./homes'); }

const Cluster = (() => {
  const WALK_RADIUS_M = 700;
  const HYBRID_RADIUS_M = 1100;
  const TARGET_MIN = 150;
  const TARGET_MAX = 450;
  const TARGET_SOFT = 200;

  // ---- Sizing routes by effort rather than homes (opt-in: sizeBy 'effort')
  // A home on a sparse rural lane takes far longer to reach than one on a
  // town street -- Patriot's rule of thumb is ~40 rural homes in the time of
  // ~250 town ones. So each road's homes are weighted by how spread out they
  // are: x1 at 60+ homes per km of road (town), rising smoothly to x6.25 at
  // 15 or fewer per km (rural), on a log scale in between. Route sizes
  // (targetSoft/Min/Max) are then in "town-home equivalents".
  // Caveat: the data only says how many homes a road has, not where along it
  // they are, so a long road with its houses bunched in a village looks
  // sparser (and gets weighted heavier) than it really is.
  const EFFORT_TOWN_PER_KM = 60, EFFORT_RURAL_PER_KM = 15, EFFORT_RURAL_WEIGHT = 250 / 40;
  const RURAL_DRIVE_PER_KM = 30; // below this (and over 2 km of road) an effort-sized route is driven
  const DRIVE_SPREAD_KM = 1.5;   // ...as is one whose pieces spread wider than this (town routes stay within ~1.1 km)
  const EFFORT_MERGE_GAP_M = 3000; // small effort-sized routes merge with a neighbour up to this far (they're driven anyway)

  function effortWeight(road) {
    const km = road.remainingGeometry.reduce((s, g) => s + Geo.segLength(g), 0) / 1000;
    const perKm = road.residencesRemaining / Math.max(km, 0.02);
    if (perKm >= EFFORT_TOWN_PER_KM) return 1;
    if (perKm <= EFFORT_RURAL_PER_KM) return EFFORT_RURAL_WEIGHT;
    const f = Math.log(EFFORT_TOWN_PER_KM / perKm) / Math.log(EFFORT_TOWN_PER_KM / EFFORT_RURAL_PER_KM);
    return Math.exp(f * Math.log(EFFORT_RURAL_WEIGHT));
  }

  // Effort sizing only: a road whose effort alone is more than a normal
  // route (a long rural lane, split only where side roads join it -- which
  // may be nowhere) is cut into equal-length parts of about targetSoft
  // effort each, so it can form routes like everything else. Parts keep
  // rootName, so progress reports still write back to the right slice of
  // the original sheet row (see mapData.js).
  // Strict target sizing (targetMax given) makes the same cut on any road
  // bigger than one route -- by homes (weight 1) or by effort -- into as
  // many parts as keeps each nearest targetSoft without passing targetMax.
  function splitByEffort(roads, targetSoft, { weight = effortWeight, targetMax = null } = {}) {
    const out = {};
    const taken = new Set(Object.keys(roads));
    for (const [name, r] of Object.entries(roads)) {
      const effort = r.status === 'Complete' || r.residencesRemaining <= 0 ? 0 : r.residencesRemaining * weight(r);
      const k = targetMax
        ? Math.max(Math.round(effort / targetSoft), Math.ceil(effort / targetMax))
        : Math.ceil(effort / targetSoft);
      if (k < 2 || !r.remainingGeometry.length) { out[name] = r; continue; }
      const lens = r.remainingGeometry.map(Geo.segLength);
      const total = lens.reduce((a, b) => a + b, 0);
      if (!total) { out[name] = r; continue; }
      const chain = chainFragments(r.remainingGeometry);
      // Where to cut: every total/k metres -- or, when home positions are
      // known (js/homes.js), halfway between homes so each part gets an equal
      // share of the homes rather than of the road.
      let cutsAt = null;
      if (r.homePoints) {
        const pos = [];
        let off = 0;
        chain.forEach(frag => {
          for (const s of Homes.positionsAlong(r.homePoints, frag)) pos.push(off + s);
          off += Geo.segLength(frag);
        });
        pos.sort((a, b) => a - b);
        if (pos.length >= k) cutsAt = Array.from({ length: k - 1 }, (_, i) => { const j = Math.round((i + 1) * pos.length / k); return (pos[j - 1] + pos[j]) / 2; });
      }
      const edges = cutsAt ? [0, ...cutsAt, total] : null;
      const stepFor = i => (edges ? edges[i + 1] - edges[i] : total / k);
      // Walk the fragments, cutting after each part's length.
      const pieces = [];
      let cur = [], curLen = 0;
      chain.forEach(frag => {
        const { cum, total: fl } = Geo.cumLengths(frag);
        let from = 0;
        while (fl - from > 1e-6) {
          const step = stepFor(pieces.length);
          const need = step - curLen;
          const to = Math.min(fl, from + need);
          const a = Geo.pointAtFraction(frag, cum, fl, from / fl), b = Geo.pointAtFraction(frag, cum, fl, to / fl);
          const mid = frag.filter((_, i) => cum[i] > from && cum[i] < to);
          cur.push([a, ...mid, b]);
          curLen += to - from;
          from = to;
          if (curLen >= step - 1e-6 && pieces.length < k - 1) { pieces.push(cur); cur = []; curLen = 0; }
        }
      });
      if (cur.length) pieces.push(cur);
      if (pieces.length < 2) { out[name] = r; continue; }
      // Homes per part: where they really are when known, else by length.
      let homesPer = null;
      if (r.homePoints) {
        const flat = pieces.flat(), owner = pieces.flatMap((g, i) => g.map(() => i));
        const bySeg = Graph.residencesByHomes(r, flat);
        if (bySeg) { homesPer = pieces.map(() => 0); bySeg.forEach((v, j) => { homesPer[owner[j]] += v; }); }
      }
      pieces.forEach((geom, i) => {
        const len = geom.reduce((s, g) => s + Geo.segLength(g), 0);
        const partName = Graph.partNameFor(name, i, taken);
        out[partName] = {
          ...r,
          name: partName,
          residencesRemaining: homesPer ? homesPer[i] : r.residencesRemaining * len / total,
          fullGeometry: geom,
          remainingGeometry: geom,
          coveredGeometry: [],
          totalLengthM: len,
          splitFrom: name,
          rootName: r.rootName || name,
        };
      });
    }
    return out;
  }

  // A road's geometry is a list of fragments in no particular order; put
  // them end to end along the road (starting from an extreme end, always
  // taking the nearest next fragment, flipped if need be) so equal-length
  // cuts give parts that are each one continuous stretch.
  function chainFragments(frags) {
    if (frags.length < 2) return frags;
    const pts = frags.flat();
    const c = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
    // Start at the fragment end furthest from the middle of the road.
    let startI = 0, startsAtFirst = true, far = -1;
    frags.forEach((f, i) => {
      [[f[0], true], [f[f.length - 1], false]].forEach(([p, atFirst]) => {
        const d = Geo.distM(p, c);
        if (d > far) { far = d; startI = i; startsAtFirst = atFirst; }
      });
    });
    const left = new Set(frags.map((_, i) => i));
    const out = [];
    let cur = startsAtFirst ? frags[startI] : [...frags[startI]].reverse();
    left.delete(startI);
    out.push(cur);
    while (left.size) {
      const end = cur[cur.length - 1];
      let best = null;
      for (const i of left) {
        const f = frags[i];
        const d0 = Geo.distM(end, f[0]), d1 = Geo.distM(end, f[f.length - 1]);
        if (!best || Math.min(d0, d1) < best.d) best = { i, d: Math.min(d0, d1), flip: d1 < d0 };
      }
      cur = best.flip ? [...frags[best.i]].reverse() : frags[best.i];
      left.delete(best.i);
      out.push(cur);
    }
    return out;
  }

  function roadCentroid(road, geometryKey = 'remainingGeometry') {
    let xs = [], ys = [];
    for (const seg of road[geometryKey]) for (const [lon, lat] of seg) { xs.push(lon); ys.push(lat); }
    if (!xs.length) return null;
    return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
  }

  const sizeOf = c => (c.size ?? c.residences);

  function mergeSmallClusters(clusters, adjacency, targetMin, targetMax = TARGET_MAX) {
    let changed = true;
    while (changed) {
      changed = false;
      const roadToIdx = {};
      clusters.forEach((c, i) => c.roads.forEach(n => { roadToIdx[n] = i; }));
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        if (sizeOf(c) >= targetMin) continue;
        const neighbourIdxs = new Set();
        for (const n of c.roads) for (const nb of (adjacency[n] || [])) {
          const j = roadToIdx[nb];
          if (j !== undefined && j !== i) neighbourIdxs.add(j);
        }
        let bestJ = null, bestSum = null;
        for (const j of neighbourIdxs) {
          const s = sizeOf(c) + sizeOf(clusters[j]);
          if (s <= targetMax && (bestSum === null || s < bestSum)) { bestJ = j; bestSum = s; }
        }
        if (bestJ !== null) {
          clusters[bestJ].roads.push(...c.roads);
          clusters[bestJ].residences += c.residences;
          if (c.size != null) clusters[bestJ].size += c.size;
          clusters.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return clusters;
  }

  function clusterCentroid(cluster, roads) {
    let xs = 0, ys = 0, n = 0;
    for (const name of cluster.roads) {
      const c = roadCentroid(roads[name], 'fullGeometry');
      if (c) { xs += c[0]; ys += c[1]; n++; }
    }
    return n ? [xs / n, ys / n] : null;
  }

  function mergeSmallClustersByGeography(clusters, roads, targetMin, maxGapM = 1000, targetMax = TARGET_MAX) {
    let changed = true;
    while (changed) {
      changed = false;
      if (clusters.length <= 1) break;
      for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        if (sizeOf(c) >= targetMin) continue;
        const ci = clusterCentroid(c, roads);
        if (!ci) continue;
        let bestJ = null, bestD = null;
        clusters.forEach((other, j) => {
          if (j === i) return;
          if (sizeOf(c) + sizeOf(other) > targetMax) return;
          const cj = clusterCentroid(other, roads);
          if (!cj) return;
          const d = Geo.distM(ci, cj);
          if (d > maxGapM) return;
          if (bestD === null || d < bestD) { bestJ = j; bestD = d; }
        });
        if (bestJ !== null) {
          clusters[bestJ].roads.push(...c.roads);
          clusters[bestJ].residences += c.residences;
          if (c.size != null) clusters[bestJ].size += c.size;
          clusters[bestJ].geographicMerge = true;
          clusters.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return clusters;
  }

  function clusterRoads(roads, adjacency, eventStart, opts = {}) {
    const walkRadiusM = opts.walkRadiusM ?? WALK_RADIUS_M;
    const hybridRadiusM = opts.hybridRadiusM ?? HYBRID_RADIUS_M;
    const targetMin = opts.targetMin ?? TARGET_MIN;
    const targetMax = opts.targetMax ?? TARGET_MAX;
    const targetSoft = opts.targetSoft ?? TARGET_SOFT;

    const eligible = {};
    for (const [n, r] of Object.entries(roads)) if (r.status !== 'Complete' && r.residencesRemaining > 0) eligible[n] = r;
    const byEffort = opts.sizeBy === 'effort';
    // Strict target (opt-in): a route only takes another road if that
    // brings it closer to targetSoft, and every merge is capped at the
    // caller's targetMax -- so routes land near the target rather than at
    // two or three times it.
    const strict = !!opts.strictTarget;
    const sizeOfRoad = {};
    for (const [n, r] of Object.entries(eligible)) sizeOfRoad[n] = byEffort ? r.residencesRemaining * effortWeight(r) : r.residencesRemaining;

    const networkDist = Graph.roadNetworkDistances(roads, adjacency, eventStart);
    const distFromStart = {};
    for (const n of Object.keys(eligible)) distFromStart[n] = networkDist[n];

    let remaining = new Set(Object.keys(eligible));
    const clusters = [];

    while (remaining.size) {
      let seed = null, seedD = Infinity;
      for (const n of remaining) if (distFromStart[n] < seedD) { seedD = distFromStart[n]; seed = n; }
      const members = new Set([seed]);
      let res = eligible[seed].residencesRemaining;
      let size = sizeOfRoad[seed];
      remaining.delete(seed);
      let frontier = new Set([...(adjacency[seed] || [])].filter(n => remaining.has(n)));

      while (frontier.size) {
        const candidates = [...frontier].sort((a, b) => distFromStart[a] - distFromStart[b]);
        let picked = null;
        for (const c of candidates) {
          if (size >= targetSoft) break;
          if (size + sizeOfRoad[c] > targetMax) continue;
          if (strict && Math.abs(size + sizeOfRoad[c] - targetSoft) >= Math.abs(size - targetSoft)) continue;
          picked = c; break;
        }
        if (picked === null) break;
        members.add(picked);
        res += eligible[picked].residencesRemaining;
        size += sizeOfRoad[picked];
        remaining.delete(picked);
        frontier.delete(picked);
        for (const nb of (adjacency[picked] || [])) if (remaining.has(nb)) frontier.add(nb);
      }

      clusters.push(byEffort ? { roads: [...members].sort(), residences: res, size } : { roads: [...members].sort(), residences: res });
    }

    // (Homes-based sizing keeps its original fixed merge ceiling unless
    // strict; effort sizing uses the caller's targetMax, since its units differ.)
    const mergeMax = byEffort || strict ? targetMax : TARGET_MAX;
    let out = mergeSmallClusters(clusters, adjacency, targetMin, mergeMax);
    // Trimming to home positions (Graph.trimToHomes) leaves hamlets as
    // islands with no road between them, so they need the wider merge too.
    const trimmed = Object.values(eligible).some(r => r.homesTrimmed);
    out = mergeSmallClustersByGeography(out, roads, targetMin, byEffort || trimmed ? EFFORT_MERGE_GAP_M : 1000, mergeMax);

    for (const c of out) {
      const minD = Math.min(...c.roads.map(n => distFromStart[n]));
      c.minDistFromStartM = Math.round(minD);
      if (opts.general) c.kind = 'walk'; // no event start to walk or drive from; lanes become 'drive' below
      else if (minD <= walkRadiusM) c.kind = 'walk';
      else if (minD <= hybridRadiusM) c.kind = 'hybrid';
      else c.kind = 'drive';
      // Effort sizing: a long, sparse route is a lane to drive along and
      // deliver, whatever its distance from the start -- and so is one made
      // of clusters spread out across the countryside (once home positions
      // trim the empty road between hamlets, what's left can look dense).
      if (byEffort) {
        const geoms = c.roads.flatMap(n => eligible[n].remainingGeometry);
        const km = geoms.reduce((a, g) => a + Geo.segLength(g), 0) / 1000;
        const pts = geoms.flat();
        const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
        const spreadKm = pts.length ? Geo.distM([Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]) / 1000 : 0;
        if ((km > 2 && c.residences / km < RURAL_DRIVE_PER_KM) || spreadKm > DRIVE_SPREAD_KM) c.kind = 'drive';
      }
      c.residences = Math.round(c.residences * 10) / 10;
      if (c.size != null) c.size = Math.round(c.size);
      if (c.geographicMerge === undefined) c.geographicMerge = false;
    }

    out.sort((a, b) => a.minDistFromStartM - b.minDistFromStartM);
    return out;
  }

  function pickParkingRoad(roads, clusterRoadNames, adjacency) {
    const members = new Set(clusterRoadNames);
    const inClusterDegree = n => [...(adjacency[n] || [])].filter(nb => members.has(nb)).length;
    return clusterRoadNames.reduce((best, n) => {
      const dn = inClusterDegree(n), db = inClusterDegree(best);
      if (dn > db) return n;
      if (dn === db && roads[n].residencesRemaining > roads[best].residencesRemaining) return n;
      return best;
    });
  }

  function clusterShape(clusterRoadNames, adjacency) {
    const members = new Set(clusterRoadNames);
    const edges = new Set();
    for (const n of clusterRoadNames) for (const nb of (adjacency[n] || [])) {
      if (members.has(nb)) edges.add([n, nb].sort().join(' '));
    }
    return edges.size >= clusterRoadNames.length ? 'loop' : 'out-and-back';
  }

  // maxMergeDistanceM has no cap by default: these settlements only seed
  // each hamlet's own drive-to routes (see buildMultiHub), so folding a
  // stranded small settlement into its nearest neighbour costs a volunteer
  // extra driving, not extra walking -- unlike the walk/hybrid radii above,
  // there's no distance past which that stops being worth doing, so a
  // settlement should never survive to become a route on its own just
  // because it happened to be the ward's most isolated hamlet.
  function findSettlements(roads, adjacency, maxRadiusM = 1000, seedRadiusM = 1300, minSettlementRes = 60, maxMergeDistanceM = Infinity) {
    // A road with nothing left to deliver shouldn't become a settlement --
    // let alone a whole standalone route -- of its own.
    const eligible = Object.keys(roads).filter(n => roads[n].status !== 'Complete' && roads[n].residencesRemaining > 0);
    const centroids = {};
    for (const n of eligible) centroids[n] = roadCentroid(roads[n], 'fullGeometry');
    let remaining = new Set(eligible.filter(n => centroids[n]));
    const settlements = [];

    while (remaining.size) {
      let seed = null, seedRes = -Infinity;
      for (const n of remaining) if (roads[n].residencesRemaining > seedRes) { seedRes = roads[n].residencesRemaining; seed = n; }
      const seedPt = centroids[seed];
      const group = new Set([seed]);
      remaining.delete(seed);
      let [groupCx, groupCy] = seedPt;

      let changed = true;
      while (changed) {
        changed = false;
        for (const n of [...remaining]) {
          const [cx, cy] = centroids[n];
          if (Geo.distM([groupCx, groupCy], [cx, cy]) <= maxRadiusM && Geo.distM(seedPt, [cx, cy]) <= seedRadiusM) {
            group.add(n); remaining.delete(n); changed = true;
          }
        }
        if (changed) {
          const xs = [...group].map(m => centroids[m][0]), ys = [...group].map(m => centroids[m][1]);
          groupCx = xs.reduce((a, b) => a + b, 0) / xs.length;
          groupCy = ys.reduce((a, b) => a + b, 0) / ys.length;
        }
      }
      settlements.push([...group].sort());
    }

    const merged = mergeTinySettlements(settlements, roads, centroids, minSettlementRes, maxMergeDistanceM);
    return merged.sort((a, b) => sumRes(b, roads) - sumRes(a, roads));
  }

  function sumRes(group, roads) { return group.reduce((s, n) => s + roads[n].residencesRemaining, 0); }
  function centroidOf(group, centroids) {
    const xs = group.map(n => centroids[n][0]), ys = group.map(n => centroids[n][1]);
    return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
  }

  function mergeTinySettlements(settlements, roads, centroids, minRes, maxMergeDistanceM) {
    let changed = true;
    while (changed) {
      changed = false;
      if (settlements.length <= 1) break;
      for (let i = 0; i < settlements.length; i++) {
        const g = settlements[i];
        if (sumRes(g, roads) >= minRes) continue;
        const ci = centroidOf(g, centroids);
        let bestJ = null, bestD = Infinity;
        settlements.forEach((other, j) => {
          if (j === i) return;
          const d = Geo.distM(ci, centroidOf(other, centroids));
          if (d < bestD) { bestD = d; bestJ = j; }
        });
        if (bestJ !== null && bestD <= maxMergeDistanceM) {
          settlements[bestJ] = settlements[bestJ].concat(g);
          settlements.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    return settlements;
  }

  return {
    effortWeight, splitByEffort,
    roadCentroid, clusterRoads, pickParkingRoad, clusterShape, findSettlements,
    WALK_RADIUS_M, HYBRID_RADIUS_M, TARGET_MIN, TARGET_MAX, TARGET_SOFT,
  };
})();

if (typeof module !== 'undefined') module.exports = Cluster;
