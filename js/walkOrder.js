// Walking order for a single route -- turns a route's unordered set of roads
// into numbered, turn-by-turn "legs", treating each side of a road as its
// own pavement rather than assuming both sides are done in one pass.
//
// The model: every road edge has two pavements. If you always walk with the
// road on your RIGHT (letterboxes on your left), then at each junction the
// only move that doesn't cross a road is to turn onto the next road
// clockwise round the corner -- and following that rule traces a closed
// loop round one "face" of the route's road network. At a dead end the next
// road clockwise is the same road, i.e. "cross at the end and come back down
// the other side". So:
//   - a tree-shaped route (a spine road plus closes off it) is ONE face: one
//     continuous loop that does every pavement exactly once and ends back at
//     the start, with zero wasted walking;
//   - a route containing blocks/loops has several faces; they're stitched
//     together with the fewest road crossings at junctions (a spanning tree
//     over faces), each crossed there and back.
// Every pavement is walked exactly once. Walking distance is therefore
// ~2x the road length, which is the real cost of doing both sides properly.
//
// By default the finished tour is then walked in REVERSE, so volunteers keep
// the road on their LEFT (letterboxes on the right): in the UK that makes the
// nearest traffic oncoming, so HGVs, splashes and gusts are seen coming --
// the same reasoning as Highway Code rule 2, and it matters most on rural
// lanes with no pavement. Reversing a closed tour is still a valid tour that
// walks every pavement once, so nothing else changes. opts.keepRoadOn =
// 'right' gives the un-reversed tour.
//
// Input roads are the app payload shape: {street, res, segments:[[[lat,lon],...]]}.
'use strict';

const WalkOrder = (() => {
  const NODE_SNAP_M = 12;    // endpoints this close are the same junction
  const T_SNAP_M = 20;       // a road end this close to another road's side joins it (T-junction)
  const SHARED_VERTEX_M = 1.5;
  const BEARING_PROBE_M = 15;
  const MIN_EDGE_M = 3;

  function baseName(n) { return String(n).replace(/\s*\(part \d+\)$/, ''); }

  function makeProjector(lat0, lon0) {
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    return {
      toXY: ([lat, lon]) => [(lon - lon0) * kx, (lat - lat0) * ky],
      toLL: ([x, y]) => [lat0 + y / ky, lon0 + x / kx],
    };
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  // Compass bearing of a->b in degrees, 0 = north, clockwise.
  const bearing = (a, b) => (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  const angDiff = (from, to) => ((to - from + 540) % 360) - 180; // (-180, 180]

  function cumulative(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    return cum;
  }

  function pointAt(pts, cum, s) {
    if (s <= 0) return pts[0];
    for (let i = 1; i < pts.length; i++) {
      if (cum[i] >= s) {
        const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
        return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
      }
    }
    return pts[pts.length - 1];
  }

  function slice(pts, cum, s0, s1) {
    const out = [pointAt(pts, cum, s0)];
    for (let i = 0; i < pts.length; i++) if (cum[i] > s0 && cum[i] < s1) out.push(pts[i]);
    out.push(pointAt(pts, cum, s1));
    return out;
  }

  function nearestOn(pts, cum, p) {
    let best = { d: Infinity, s: 0, pt: null };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
      const q = [a[0] + t * dx, a[1] + t * dy];
      const d = dist(p, q);
      if (d < best.d) best = { d, s: cum[i - 1] + t * (cum[i] - cum[i - 1]), pt: q };
    }
    return best;
  }

  function compass8(deg) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }
  const SIDE_WORD = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' };

  // ---- 1. Road network graph, split at every junction -----------------------
  function buildGraph(roads, proj) {
    const lines = [];
    roads.forEach((rd, ri) => {
      const total = rd.segments.reduce((s, seg) => s + seg.length, 0);
      if (!total) return;
      for (const seg of rd.segments) {
        const pts = [];
        for (const ll of seg) {
          const p = proj.toXY(ll);
          if (!pts.length || dist(pts[pts.length - 1], p) > 0.3) pts.push(p);
        }
        if (pts.length < 2) continue;
        const cum = cumulative(pts);
        if (cum[cum.length - 1] < MIN_EDGE_M) continue;
        lines.push({ road: ri, pts, cum, len: cum[cum.length - 1], splits: [] });
      }
    });
    const cand = []; // candidate junction points: {p, line, s}
    const joins = []; // explicit unions between candidates
    const addSplit = (li, s, p) => { const id = cand.length; cand.push({ p, line: li, s }); lines[li].splits.push(id); return id; };
    const ends = lines.map((l, li) => [addSplit(li, 0, l.pts[0]), addSplit(li, l.len, l.pts[l.pts.length - 1])]);

    // Shared interior vertices (a crossroads where both roads carry on through).
    const grid = new Map();
    lines.forEach((l, li) => l.pts.forEach((p, vi) => {
      const k = Math.round(p[0] / SHARED_VERTEX_M) + ',' + Math.round(p[1] / SHARED_VERTEX_M);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ li, vi });
    }));
    for (const hits of grid.values()) {
      const byLine = new Map();
      for (const h of hits) if (!byLine.has(h.li)) byLine.set(h.li, h);
      if (byLine.size < 2) continue;
      const ids = [...byLine.values()].map(h => addSplit(h.li, lines[h.li].cum[h.vi], lines[h.li].pts[h.vi]));
      for (let i = 1; i < ids.length; i++) joins.push([ids[0], ids[i]]);
    }

    // T-junctions: a line's end sitting on (or just short of) another line.
    lines.forEach((l, li) => {
      [0, 1].forEach(which => {
        const p = which ? l.pts[l.pts.length - 1] : l.pts[0];
        let best = null;
        lines.forEach((m, mi) => {
          if (mi === li) return;
          const hit = nearestOn(m.pts, m.cum, p);
          if (hit.d <= T_SNAP_M && (!best || hit.d < best.d)) best = { ...hit, mi };
        });
        if (best) joins.push([ends[li][which], addSplit(best.mi, best.s, best.pt)]);
      });
    });

    // Union-find over candidates: explicit joins + anything within NODE_SNAP_M.
    const parent = cand.map((_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
    joins.forEach(([a, b]) => union(a, b));
    for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
      if (dist(cand[i].p, cand[j].p) <= NODE_SNAP_M) union(i, j);
    }
    const nodeOf = new Map(), nodes = [];
    cand.forEach((c, i) => {
      const r = find(i);
      if (!nodeOf.has(r)) { nodeOf.set(r, nodes.length); nodes.push({ sum: [0, 0], n: 0 }); }
      const nd = nodes[nodeOf.get(r)];
      nd.sum[0] += c.p[0]; nd.sum[1] += c.p[1]; nd.n++;
    });
    nodes.forEach(nd => { nd.p = [nd.sum[0] / nd.n, nd.sum[1] / nd.n]; });
    const candNode = i => nodeOf.get(find(i));

    // Cut each line at its splits into edges between nodes.
    const edges = [];
    lines.forEach(l => {
      const cuts = [...new Set(l.splits)].map(id => ({ s: cand[id].s, node: candNode(id) })).sort((a, b) => a.s - b.s);
      const merged = [];
      for (const c of cuts) {
        const last = merged[merged.length - 1];
        if (last && (c.s - last.s < 0.5 || c.node === last.node && c.s - last.s < 2 * NODE_SNAP_M)) {
          if (c.s === l.len) merged[merged.length - 1] = c; // keep the true end
          continue;
        }
        merged.push(c);
      }
      for (let i = 1; i < merged.length; i++) {
        const a = merged[i - 1], b = merged[i];
        const len = b.s - a.s;
        if (len < MIN_EDGE_M) continue;
        if (a.node === b.node && len < 3 * NODE_SNAP_M) continue; // snapping artefact
        const pts = slice(l.pts, l.cum, a.s, b.s);
        pts[0] = nodes[a.node].p; pts[pts.length - 1] = nodes[b.node].p;
        const rd = roads[l.road];
        edges.push({
          a: a.node, b: b.node, pts, len,
          road: l.road, street: baseName(rd.street), res: 0,
        });
      }
    });
    // Residences are spread along each road by length, over the edges that
    // survived (so dropped snapping slivers don't lose any homes).
    const keptLen = roads.map(() => 0);
    for (const e of edges) keptLen[e.road] += e.len;
    for (const e of edges) e.res = roads[e.road].res * e.len / keptLen[e.road];
    const lost = roads.filter((rd, ri) => rd.res > 0 && !keptLen[ri]).map(rd => rd.street);
    return { nodes, edges, lost };
  }

  // ---- 2. Rotation system + faces ---------------------------------------
  // Half-edge h: edge = h>>1, forward if even. Walking h means walking the
  // pavement on the LEFT of the direction of travel (road on your right).
  function halfEdgeTools(g) {
    const E = g.edges;
    const tail = h => (h & 1 ? E[h >> 1].b : E[h >> 1].a);
    const head = h => (h & 1 ? E[h >> 1].a : E[h >> 1].b);
    const ptsOf = h => (h & 1 ? [...E[h >> 1].pts].reverse() : E[h >> 1].pts);
    const outBearing = h => {
      const pts = ptsOf(h), cum = cumulative(pts);
      return bearing(pts[0], pointAt(pts, cum, Math.min(BEARING_PROBE_M, cum[cum.length - 1] / 2)));
    };
    const inBearing = h => (outBearing(h ^ 1) + 180) % 360;
    const rot = g.nodes.map(() => []);
    for (let h = 0; h < 2 * E.length; h++) rot[tail(h)].push(h);
    const bOut = [];
    for (let h = 0; h < 2 * E.length; h++) bOut[h] = outBearing(h);
    rot.forEach(list => list.sort((x, y) => bOut[x] - bOut[y]));
    const posInRot = [];
    rot.forEach(list => list.forEach((h, i) => { posInRot[h] = i; }));
    // Arriving along h, keep the road on your right: turn onto the next road
    // clockwise from the one you came in on.
    const next = h => { const v = head(h), list = rot[v]; return list[(posInRot[h ^ 1] + 1) % list.length]; };
    return { tail, head, ptsOf, outBearing: h => bOut[h], inBearing, rot, posInRot, next };
  }

  // ---- 3. Build the tour ------------------------------------------------
  function plan(route, opts = {}) {
    const roads = route.roads.filter(r => r.segments && r.segments.length);
    const all = roads.flatMap(r => r.segments.flat());
    if (!all.length) return { legs: [], steps: [], stats: {} };
    const lat0 = all.reduce((s, p) => s + p[0], 0) / all.length;
    const lon0 = all.reduce((s, p) => s + p[1], 0) / all.length;
    const proj = makeProjector(lat0, lon0);
    const g = buildGraph(roads, proj);
    const T = halfEdgeTools(g);
    const H = 2 * g.edges.length;

    // Faces = orbits of next().
    const faceOf = new Array(H).fill(-1);
    let nFaces = 0;
    for (let h = 0; h < H; h++) {
      if (faceOf[h] !== -1) continue;
      let x = h;
      do { faceOf[x] = nFaces; x = T.next(x); } while (x !== h);
      nFaces++;
    }

    // Connected components of the road graph.
    const compOfNode = g.nodes.map(() => -1);
    let nComp = 0;
    g.nodes.forEach((_, v) => {
      if (compOfNode[v] !== -1 || !T.rot[v].length) return;
      const stack = [v]; compOfNode[v] = nComp;
      while (stack.length) {
        const u = stack.pop();
        for (const h of T.rot[u]) { const w = T.head(h); if (compOfNode[w] === -1) { compOfNode[w] = nComp; stack.push(w); } }
      }
      nComp++;
    });

    // A "corner" at node v is identified by the half-edge h arriving there;
    // it sits between road h^1 and next(h), on face faceOf[h].
    const cornersAt = v => T.rot[v].map(o => o ^ 1); // in clockwise order: corner k lies after rot[v][k]

    // Pick the start corner: node nearest the start point, corner facing it.
    const startXY = opts.start ? proj.toXY(opts.start.latlng) : null;
    function nearestNode(p, comp) {
      let best = -1, bd = Infinity;
      g.nodes.forEach((nd, v) => {
        if (!T.rot[v].length || (comp !== undefined && compOfNode[v] !== comp)) return;
        const d = dist(nd.p, p);
        if (d < bd) { bd = d; best = v; }
      });
      return { v: best, d: bd };
    }
    function cornerFacing(v, p) {
      const list = T.rot[v];
      if (list.length === 1 || !p || dist(p, g.nodes[v].p) < 1) return list[0] ^ 1;
      const b = bearing(g.nodes[v].p, p);
      for (let k = 0; k < list.length; k++) {
        const b0 = T.outBearing(list[k]), b1 = T.outBearing(list[(k + 1) % list.length]);
        const span = (b1 - b0 + 360) % 360 || 360, off = (b - b0 + 360) % 360;
        if (off <= span) return list[k] ^ 1;
      }
      return list[0] ^ 1;
    }

    const steps = [];
    const crossingsNamed = (v, fromH, toH) => {
      // Roads passed going clockwise vs anticlockwise between the two corners; take the shorter way.
      const list = T.rot[v], n = list.length;
      const i = T.posInRot[fromH ^ 1], j = T.posInRot[toH ^ 1];
      const cw = [], acw = [];
      for (let k = (i + 1) % n; k !== (j + 1) % n; k = (k + 1) % n) cw.push(list[k]);
      for (let k = i; k !== j; k = (k - 1 + n) % n) acw.push(list[k]);
      const pick = cw.length <= acw.length ? cw : acw;
      return [...new Set(pick.map(h => g.edges[h >> 1].street))];
    };

    // Walk a tour backwards: same pavements, opposite direction, so the road
    // is on your left instead of your right.
    function reverseTour(seq) {
      const rev = [];
      for (let i = seq.length - 1; i >= 0; i--) {
        const st = seq[i];
        if (st.type === 'walk') rev.push({ type: 'walk', h: st.h ^ 1, pavementOnRight: true });
        else rev.push({ ...st, from: st.to, to: st.from, back: !st.back });
      }
      let prevH = null;
      for (const st of rev) {
        if (st.type !== 'walk') continue;
        st.uturn = prevH !== null && st.h === (prevH ^ 1); // straight back along the road you just did
        prevH = st.h;
      }
      return rev;
    }
    const roadOnLeft = opts.keepRoadOn !== 'right';

    function tourComponent(comp, startH) {
      const out = [];
      // Spanning tree over this component's faces (Prim, cost = roads crossed).
      const children = new Map(); // corner h -> [{toH}]
      const inTree = new Set([faceOf[startH]]);
      const compCorners = [];
      g.nodes.forEach((_, v) => { if (compOfNode[v] === comp) compCorners.push(...cornersAt(v).map(h => ({ v, h }))); });
      const compFaces = new Set(compCorners.map(c => faceOf[c.h]));
      while (inTree.size < compFaces.size) {
        let best = null;
        for (const { v, h } of compCorners) {
          if (!inTree.has(faceOf[h])) continue;
          for (const h2 of cornersAt(v)) {
            if (inTree.has(faceOf[h2])) continue;
            const cost = crossingsNamed(v, h, h2).length;
            if (!best || cost < best.cost) best = { h, h2, cost };
          }
        }
        if (!best) break; // shouldn't happen within one component
        inTree.add(faceOf[best.h2]);
        if (!children.has(best.h)) children.set(best.h, []);
        children.get(best.h).push(best.h2);
      }
      const walkFace = (startCorner) => {
        let h = startCorner;
        do {
          for (const ch of children.get(h) || []) {
            const v = T.head(h);
            out.push({ type: 'cross', node: v, roads: crossingsNamed(v, h, ch), from: h, to: ch });
            walkFace(ch);
            out.push({ type: 'cross', node: v, roads: crossingsNamed(v, ch, h), from: ch, to: h, back: true });
          }
          const n = T.next(h);
          out.push({ type: 'walk', h: n, uturn: n === (h ^ 1) });
          h = n;
        } while (h !== startCorner);
      };
      walkFace(startH);
      steps.push(...(roadOnLeft ? reverseTour(out) : out));
    }

    // Order components greedily from the start point.
    const done = new Set();
    // No start given (someone heading out on their own, not from an event
    // start): begin at the route's busiest junction -- most roads meeting,
    // then most homes on them -- which is an easy place to find and meet at.
    const defaultStart = () => {
      let best = -1, bestScore = -1;
      g.nodes.forEach((nd, v) => {
        const deg = T.rot[v].length;
        if (!deg) return;
        const score = deg * 1e6 + T.rot[v].reduce((s, h) => s + g.edges[h >> 1].res, 0);
        if (score > bestScore) { bestScore = score; best = v; }
      });
      return g.nodes[best].p;
    };
    let here = startXY || defaultStart();
    let firstApproach = null;
    // With a walking network, "nearest" means shortest walk and the walk-in
    // follows real roads. A path that's absurdly longer than the straight
    // line (the network is missing a link) falls back to the straight line.
    const walkTo = (field, v) => {
      if (!field) return null;
      const path = field.pathTo(proj.toLL(g.nodes[v].p));
      if (!path) return null;
      const straight = dist(here, g.nodes[v].p);
      return path.d <= 3 * straight + 300 ? path : null;
    };
    while (done.size < nComp) {
      const field = opts.network ? opts.network.from(proj.toLL(here)) : null;
      let best = null;
      for (let c = 0; c < nComp; c++) {
        if (done.has(c)) continue;
        if (field) {
          g.nodes.forEach((nd, v) => {
            if (compOfNode[v] !== c || !T.rot[v].length) return;
            const path = walkTo(field, v);
            const d = path ? path.d : dist(here, nd.p);
            if (!best || d < best.d) best = { c, v, d, path };
          });
        } else {
          const nn = nearestNode(here, c);
          if (!best || nn.d < best.d) best = { c, ...nn, path: null };
        }
      }
      // Face the corner the walk-in arrives from.
      const lastLeg = best.path && best.path.latlngs.length >= 2 ? proj.toXY(best.path.latlngs[best.path.latlngs.length - 2]) : here;
      const h0 = cornerFacing(best.v, dist(lastLeg, g.nodes[best.v].p) > 1 ? lastLeg : here);
      const approach = { type: 'approach', fromXY: here, toNode: best.v, d: best.d, path: best.path, first: done.size === 0 };
      if (done.size === 0) firstApproach = approach;
      steps.push(approach);
      tourComponent(best.c, h0);
      done.add(best.c);
      here = g.nodes[best.v].p;
    }

    return buildLegs(steps, g, T, proj, { route, opts, nFaces, nComp, firstApproach });
  }

  // ---- 4. Steps -> human-readable legs --------------------------------
  // Each leg carries `pre` (things to do before it: walk from the start,
  // cross a road) and `turn` (how you get onto it from the previous leg);
  // the final cue sentence is composed once the leg's direction is known.
  function buildLegs(steps, g, T, proj, ctx) {
    const legs = [];
    let cur = null, last = null;
    let pending = [];
    let crossings = 0;
    const start = ctx.opts.start || {};

    const nodeRoads = v => [...new Set(T.rot[v].map(h => g.edges[h >> 1].street))];
    const closeLeg = () => { if (cur) { legs.push(cur); last = cur; cur = null; } };
    const turnWord = t => (Math.abs(t) < 35 ? 'straight' : Math.abs(t) > 150 ? 'round' : t < 0 ? 'left' : 'right');

    for (const st of steps) {
      if (st.type === 'approach') {
        closeLeg();
        last = null;
        const names = nodeRoads(st.toNode);
        const where = names.length > 1 ? `the corner of ${names.slice(0, 2).join(' and ')}` : names[0];
        const lead = st.first && start.kind === 'parking' && start.label ? `Park on ${start.label}. ` : '';
        if (st.d > 25) {
          const from = !st.first ? 'Walk'
            : start.kind === 'me' ? 'From where you are, walk'
            : start.kind !== 'parking' && start.label ? `From ${start.label}, walk` : 'Walk';
          // Name the roads walked along, leaving out the ones at the destination corner.
          const via = st.path ? st.path.streets.filter(n => !names.includes(n) && !/^Unknown Road/.test(n)).slice(0, 3) : [];
          const viaTxt = via.length ? ` via ${via.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : '';
          pending.push(`${lead}${from} to ${where}${viaTxt} (about ${Math.round(st.d / 10) * 10} m, nothing to deliver on the way).`);
          legs.push({ type: 'transfer', latlngs: st.path ? st.path.latlngs : [proj.toLL(st.fromXY), proj.toLL(g.nodes[st.toNode].p)], d: st.d, routed: !!st.path });
        } else if (st.first) {
          pending.push(`${lead}Start at ${where}.`);
        }
        continue;
      }
      if (st.type === 'cross') {
        closeLeg();
        crossings++;
        pending.push(`${st.back ? 'Cross back over' : 'Cross over'} ${st.roads.join(' / ')}.`);
        continue;
      }
      const e = g.edges[st.h >> 1];
      const pts = T.ptsOf(st.h);
      const turnHere = cur ? angDiff(cur.endBearing, T.outBearing(st.h)) : 0;
      // Same-named road forking at a junction: still a new leg, or the
      // volunteer can't tell which arm to take.
      const fork = cur && cur.street === e.street && T.rot[T.tail(st.h)].length >= 3 && Math.abs(turnHere) >= 50;
      if (!cur || cur.street !== e.street || st.uturn || fork) {
        const prev = cur;
        closeLeg();
        let turn = null;
        if (st.uturn && prev) { turn = { kind: 'uturn', from: prev.street }; crossings++; }
        else if (prev) turn = { kind: turnWord(turnHere), fork, from: prev.street };
        cur = { type: 'leg', street: e.street, pre: pending, turn, xy: [...pts], homes: 0, len: 0, sideVec: [0, 0], pavement: st.pavementOnRight ? 'right' : 'left' };
        pending = [];
      } else {
        cur.xy.push(...pts.slice(1));
      }
      cur.homes += e.res / 2;
      cur.len += e.len;
      // Which side of the road the pavement is on: sum the normals on that side of travel (length-weighted).
      const sgn = st.pavementOnRight ? -1 : 1;
      for (let k = 1; k < pts.length; k++) {
        const dx = pts[k][0] - pts[k - 1][0], dy = pts[k][1] - pts[k - 1][1];
        cur.sideVec[0] += -dy * sgn; cur.sideVec[1] += dx * sgn;
      }
      cur.endBearing = T.inBearing(st.h);
    }
    closeLeg();

    // Finalise: numbering, compass words, cue sentences, lat/lng geometry.
    let n = 0;
    const out = legs.map(l => {
      if (l.type === 'transfer') return { type: 'transfer', latlngs: l.latlngs, len: l.d, routed: l.routed };
      const a = l.xy[0], b = l.xy[l.xy.length - 1];
      const dir = dist(a, b) > Math.max(20, l.len * 0.25) ? compass8(bearing(a, b)) : null;
      const along = dir ? `walk ${SIDE_WORD[dir]} along ${l.street}` : `walk round ${l.street}`;
      let action;
      const t = l.turn;
      if (!t) action = `${along[0].toUpperCase()}${along.slice(1)}.`;
      else if (t.kind === 'uturn') action = `At the end of ${t.from}, cross over and come back down the other side.`;
      else if (t.fork) action = t.kind === 'straight' ? `Carry straight on, staying on ${l.street}.` : `Turn ${t.kind} to stay on ${l.street} (it branches here).`;
      else if (t.kind === 'straight') action = `Carry straight on into ${l.street}.`;
      else if (t.kind === 'round') action = `Turn round into ${l.street}.`;
      else action = `Turn ${t.kind} into ${l.street}.`;
      if (!t && l.pre.length) action = `Then ${along}.`;
      return {
        type: 'leg', n: ++n, street: l.street, cue: [...l.pre, action].join(' '),
        homes: l.homes, len: l.len,
        side: SIDE_WORD[compass8(bearing([0, 0], l.sideVec))] + ' side',
        dir, pavement: l.pavement, latlngs: l.xy.map(proj.toLL),
      };
    });
    const walkLegs = out.filter(l => l.type === 'leg');
    if (walkLegs.length) {
      const tail = [...pending, ctx.nComp === 1 ? "That's the route done, and you're back where you started." : "That's the route done."];
      walkLegs[walkLegs.length - 1].endCue = tail.join(' ');
    }
    const totalLen = out.reduce((s, l) => s + (l.type === 'leg' ? l.len : 0), 0);
    const transferLen = out.reduce((s, l) => s + (l.type === 'transfer' ? l.len : 0), 0);
    const roadLen = g.edges.reduce((s, e) => s + e.len, 0);
    return {
      legs: out,
      stats: {
        legs: walkLegs.length,
        homes: walkLegs.reduce((s, l) => s + l.homes, 0),
        walkM: totalLen,
        transferM: transferLen,
        lostRoads: g.lost,
        roadM: roadLen,
        crossings,
        faces: ctx.nFaces,
        components: ctx.nComp,
        junctions: g.nodes.filter((_, v) => T.rot[v].length > 2).length,
      },
    };
  }

  // ---- 5. Walking network ----------------------------------------------
  // Every road in the ward, so the walk to a route (and between separate
  // parts of one) follows real roads, and routes can be ranked by how far
  // they are to WALK to rather than as the crow flies. Works in lat/lng at
  // its edges so it can be shared by plans with their own projections.
  // Only knows the roads in the data it's given -- a footpath or main road
  // missing from the sheet can't be used, so some walks come out longer.
  function buildNetwork(allRoads) {
    const roads = allRoads.filter(r => r.segments && r.segments.length);
    const all = roads.flatMap(r => r.segments.flat());
    const proj = makeProjector(all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length);
    const g = buildGraph(roads, proj);
    // Bridge short gaps between disconnected pieces of the network with a
    // straight link -- typically a main road or footpath that isn't in the
    // data (no homes left on it), 30-100 m across. Longer gaps are left
    // alone: those are genuinely separate areas.
    const GAP_LINK_M = 120;
    {
      const comp = g.nodes.map(() => -1), nb = g.nodes.map(() => []);
      g.edges.forEach(e => { nb[e.a].push(e.b); nb[e.b].push(e.a); });
      let nc = 0;
      g.nodes.forEach((_, v) => {
        if (comp[v] !== -1 || !nb[v].length) return;
        const stack = [v]; comp[v] = nc;
        while (stack.length) { const u = stack.pop(); for (const w of nb[u]) if (comp[w] === -1) { comp[w] = nc; stack.push(w); } }
        nc++;
      });
      const bestPair = new Map();
      for (let v = 0; v < g.nodes.length; v++) {
        if (comp[v] === -1) continue;
        for (let w = v + 1; w < g.nodes.length; w++) {
          if (comp[w] === -1 || comp[w] === comp[v]) continue;
          const d = dist(g.nodes[v].p, g.nodes[w].p);
          if (d > GAP_LINK_M) continue;
          const key = Math.min(comp[v], comp[w]) + ',' + Math.max(comp[v], comp[w]);
          if (!bestPair.has(key) || d < bestPair.get(key).d) bestPair.set(key, { v, w, d });
        }
      }
      for (const { v, w, d } of bestPair.values()) {
        g.edges.push({ a: v, b: w, pts: [g.nodes[v].p, g.nodes[w].p], len: d, road: -1, street: null, res: 0 });
      }
    }
    for (const e of g.edges) e.cum = cumulative(e.pts);
    const adj = g.nodes.map(() => []);
    g.edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });

    function locate(ll) {
      const p = proj.toXY(ll);
      let best = null;
      g.edges.forEach((e, i) => {
        const hit = nearestOn(e.pts, e.cum, p);
        if (!best || hit.d < best.d) best = { e: i, s: hit.s, d: hit.d, pt: hit.pt };
      });
      return best && { ...best, p };
    }

    // Shortest walks from one point to everywhere (Dijkstra with a binary heap).
    function from(ll) {
      const src = locate(ll);
      const n = g.nodes.length;
      const dist = new Float64Array(n).fill(Infinity), prevEdge = new Int32Array(n).fill(-1);
      const heap = [];
      const push = (d, v) => {
        heap.push([d, v]);
        for (let i = heap.length - 1; i > 0;) { const j = (i - 1) >> 1; if (heap[j][0] <= heap[i][0]) break; [heap[i], heap[j]] = [heap[j], heap[i]]; i = j; }
      };
      const pop = () => {
        const top = heap[0], last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          for (let i = 0; ;) {
            const l = 2 * i + 1, r = l + 1; let m = i;
            if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
            if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
            if (m === i) break;
            [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
          }
        }
        return top;
      };
      if (src) {
        const e = g.edges[src.e], len = e.cum[e.cum.length - 1];
        dist[e.a] = src.d + src.s; dist[e.b] = src.d + (len - src.s);
        prevEdge[e.a] = -2; prevEdge[e.b] = -2; // reached straight from the start point
        push(dist[e.a], e.a); push(dist[e.b], e.b);
      }
      while (heap.length) {
        const [d, v] = pop();
        if (d > dist[v]) continue;
        for (const ei of adj[v]) {
          const e = g.edges[ei], w = e.a === v ? e.b : e.a, nd = d + e.cum[e.cum.length - 1];
          if (nd < dist[w]) { dist[w] = nd; prevEdge[w] = ei; push(nd, w); }
        }
      }

      // Walk from the start to `ll`: {d, latlngs, streets}, or null if unreachable.
      function pathTo(ll) {
        const t = locate(ll);
        if (!src || !t) return null;
        const te = g.edges[t.e], tlen = te.cum[te.cum.length - 1];
        const se = g.edges[src.e], slen = se.cum[se.cum.length - 1];
        const xy = [src.p, src.pt];
        const streets = [];
        const addStreet = n => { if (n && streets[streets.length - 1] !== n) streets.push(n); };
        if (t.e === src.e) {
          const d = src.d + Math.abs(src.s - t.s) + t.d;
          const piece = src.s <= t.s ? slice(se.pts, se.cum, src.s, t.s) : slice(se.pts, se.cum, t.s, src.s).reverse();
          xy.push(...piece, t.p);
          addStreet(se.street);
          return { d, latlngs: xy.map(proj.toLL), streets };
        }
        const viaA = dist[te.a] + t.s, viaB = dist[te.b] + (tlen - t.s);
        const endNode = viaA <= viaB ? te.a : te.b;
        const d = Math.min(viaA, viaB) + t.d;
        if (!isFinite(d)) return null;
        // Back-track node chain to the start edge.
        const chain = [];
        for (let v = endNode; prevEdge[v] >= 0;) {
          const e = g.edges[prevEdge[v]], u = e.a === v ? e.b : e.a;
          chain.push({ e, fwd: e.a === u });
          v = u;
          if (chain.length > g.edges.length) break;
        }
        chain.reverse();
        const firstNode = chain.length ? (chain[0].fwd ? chain[0].e.a : chain[0].e.b) : endNode;
        // Along the start edge to the first node.
        xy.push(...(firstNode === se.a ? slice(se.pts, se.cum, 0, src.s).reverse() : slice(se.pts, se.cum, src.s, slen)));
        addStreet(se.street);
        for (const { e, fwd } of chain) { xy.push(...(fwd ? e.pts : [...e.pts].reverse())); addStreet(e.street); }
        // Along the target edge to the target.
        xy.push(...(endNode === te.a ? slice(te.pts, te.cum, 0, t.s) : slice(te.pts, te.cum, t.s, tlen).reverse()), t.p);
        addStreet(te.street);
        return { d, latlngs: xy.map(proj.toLL), streets };
      }

      // Walking distance to the nearest bit of each route, keyed by routeId.
      function routeDistances() {
        const out = {};
        g.edges.forEach((e, i) => {
          const rid = e.road >= 0 ? roads[e.road].routeId : null;
          if (rid == null) return;
          let d = Math.min(dist[e.a], dist[e.b]);
          if (src && i === src.e) d = src.d;
          if (!(rid in out) || d < out[rid]) out[rid] = d;
        });
        return out;
      }

      return { pathTo, routeDistances, snapM: src ? src.d : Infinity };
    }

    return { from };
  }

  return { plan, buildGraph, buildNetwork, baseName };
})();

if (typeof module !== 'undefined') module.exports = WalkOrder;
