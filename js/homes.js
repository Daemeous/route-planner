// Where along each road its homes actually are.
//
// The sheet only says HOW MANY homes a road has (its Residences column --
// OS Open UPRN address points matched to the road by the leaflet-pipeline
// project). Without positions, the planner has to assume those homes are
// spread evenly along the road, which is badly wrong for long village and
// rural roads: Newport Road in Gnosall has 350 homes on 14.7 km, with 46%
// of them on the busiest tenth of its length and a third of it empty.
//
// data/homes/<district>.json (made by tools/build-homes.js from the same
// OS Open UPRN file the pipeline uses) records, for each sheet row, where
// along its line each home sits. The planner uses it only to decide WHERE
// a road's homes are -- the sheet's Residences figure is still the total.
// Everything falls back to the old even spread when there's no file, or a
// row isn't in it (e.g. its geometry changed since the file was made).
//
// File format (version 1):
//   {
//     version: 1, generated: "YYYY-MM-DD", source: "...", matchRadiusM: 40,
//     farMatchM: 250,
//     roads: { "<street>|<ward>|<geometry fingerprint>": [[pos, ...], ...] }
//   }
// Each road entry has one array per LINESTRING fragment of the row's
// road_geometry, holding each matched home's position along that fragment
// in thousandths of its length (0-1000): homes within 40 m of the road
// (the pipeline's own buffer) plus homes 40-250 m back from it, placed
// where they'd meet it. The fingerprint is a hash of the
// road_geometry text, so a row whose geometry has changed simply doesn't
// match any more (and falls back to the even spread) rather than getting
// the wrong positions.
'use strict';

const Homes = (() => {
  const VERSION = 1;
  const MATCH_RADIUS_M = 40;      // same buffer the pipeline counts homes with
  // The pipeline also counts homes further out (farms, houses down long
  // drives) against their nearest road. They're placed where they'd meet
  // it -- roughly where their drive joins -- up to this far; beyond it,
  // points are more likely across a district boundary than on a drive.
  const FAR_MATCH_M = 250;
  const COMMERCIAL_CLUSTER = 150; // pipeline: 150+ UPRNs at one spot = commercial

  // FNV-1a, 32-bit, as 8 hex chars.
  function fingerprint(s) {
    let h = 0x811c9dc5;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  function rowKey(row) { return `${row.street}|${row.wardName}|${fingerprint(row.roadGeometry)}`; }

  // [[lon,lat],...] per LINESTRING fragment (same parsing as Graph.parseLinestrings, but tolerant).
  function fragments(roadGeometry) {
    const out = [];
    for (const part of String(roadGeometry || '').split('|')) {
      const m = part.trim().match(/LINESTRING\((.*)\)/);
      if (!m) { out.push([]); continue; }
      out.push(m[1].split(',').map(p => p.trim().split(/\s+/).map(Number)).filter(p => p.length === 2 && isFinite(p[0]) && isFinite(p[1])));
    }
    return out;
  }

  // Local metres around a latitude; points are [lon, lat].
  function projector(lat0) {
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    return ([lon, lat]) => [lon * kx, lat * ky];
  }

  function fragLengths(fragXY) {
    return fragXY.map(f => { let s = 0; for (let k = 1; k < f.length; k++) s += Math.hypot(f[k][0] - f[k - 1][0], f[k][1] - f[k - 1][1]); return s; });
  }

  // ---- Building the file (tools/build-homes.js) --------------------------
  // rows: normalised sheet rows (sheets.js), BOTH route rows and any
  // network-only rows -- homes near a no-homes road must still be offered to
  // it, as the pipeline did, or they'd be pinned to the wrong road.
  // points: [[lat, lon], ...] OS Open UPRN positions around the district.
  function buildIndex(rows, points, { source = '', generated = new Date().toISOString().slice(0, 10) } = {}) {
    // Drop dense same-spot clusters, like the pipeline (commercial buildings).
    const atSpot = new Map();
    const spot = p => p[0].toFixed(5) + ',' + p[1].toFixed(5);
    for (const p of points) atSpot.set(spot(p), (atSpot.get(spot(p)) || 0) + 1);
    const homesPts = points.filter(p => atSpot.get(spot(p)) < COMMERCIAL_CLUSTER);

    const lats = rows.map(r => r.lat).filter(isFinite);
    const toXY = projector(lats.reduce((s, x) => s + x, 0) / lats.length);
    const roads = rows.map(r => {
      const fr = fragments(r.roadGeometry).map(f => f.map(toXY));
      return { row: r, fr, lens: fragLengths(fr) };
    });

    // Segment grid (50 m cells) so each point only checks nearby roads.
    const C = 50, grid = new Map();
    roads.forEach((rd, ri) => rd.fr.forEach((f, fi) => {
      for (let k = 1; k < f.length; k++) {
        const a = f[k - 1], b = f[k];
        for (let x = Math.floor(Math.min(a[0], b[0]) / C); x <= Math.floor(Math.max(a[0], b[0]) / C); x++) {
          for (let y = Math.floor(Math.min(a[1], b[1]) / C); y <= Math.floor(Math.max(a[1], b[1]) / C); y++) {
            const key = x + ',' + y;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push([ri, fi, k]);
          }
        }
      }
    }));

    const out = new Map(); // ri -> per-fragment position arrays
    let matched = 0, far = 0;
    for (const [lat, lon] of homesPts) {
      const p = toXY([lon, lat]);
      let best = null;
      const search = R => {
        for (let x = Math.floor((p[0] - R) / C); x <= Math.floor((p[0] + R) / C); x++) {
          for (let y = Math.floor((p[1] - R) / C); y <= Math.floor((p[1] + R) / C); y++) {
            for (const [ri, fi, k] of grid.get(x + ',' + y) || []) {
              const f = roads[ri].fr[fi], a = f[k - 1], b = f[k];
              const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
              const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
              const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
              if (d <= R && (!best || d < best.d)) best = { d, ri, fi, k, t };
            }
          }
        }
      };
      search(MATCH_RADIUS_M);
      if (!best) search(FAR_MATCH_M);
      if (!best) continue;
      if (best.d > MATCH_RADIUS_M) far++;
      const rd = roads[best.ri], f = rd.fr[best.fi];
      let s = 0;
      for (let k = 1; k < best.k; k++) s += Math.hypot(f[k][0] - f[k - 1][0], f[k][1] - f[k - 1][1]);
      s += best.t * Math.hypot(f[best.k][0] - f[best.k - 1][0], f[best.k][1] - f[best.k - 1][1]);
      if (!out.has(best.ri)) out.set(best.ri, rd.fr.map(() => []));
      out.get(best.ri)[best.fi].push(Math.round(1000 * s / (rd.lens[best.fi] || 1)));
      matched++;
    }

    const index = { version: VERSION, generated, source, matchRadiusM: MATCH_RADIUS_M, farMatchM: FAR_MATCH_M, roads: {} };
    for (const [ri, perFrag] of out) index.roads[rowKey(roads[ri].row)] = perFrag.map(a => a.sort((x, y) => x - y));
    return { index, stats: { points: points.length, afterCommercialFilter: homesPts.length, placed: matched, far, roads: out.size } };
  }

  // ---- Using the file (planner) --------------------------------------------
  // Adds row.homeFracs (per-fragment positions, 0-1 of the fragment) to every
  // row the file covers. Returns how many rows matched.
  function attach(rows, index) {
    if (!index || index.version !== VERSION || !index.roads) return { matched: 0, withHomes: rows.filter(r => r.residences > 0).length };
    let matched = 0, withHomes = 0;
    for (const r of rows) {
      if (r.residences > 0) withHomes++;
      const entry = index.roads[rowKey(r)];
      if (!entry) { delete r.homeFracs; continue; }
      r.homeFracs = entry.map(arr => arr.map(v => v / 1000));
      if (r.residences > 0) matched++;
    }
    return { matched, withHomes };
  }

  // Homes as points ON the road line ([lon, lat]), from a row's fractions
  // and its parsed full geometry. Null when there's nothing usable.
  function pointsOnLine(fullGeometry, homeFracs) {
    if (!homeFracs || homeFracs.length !== fullGeometry.length) return null;
    const pts = [];
    fullGeometry.forEach((frag, fi) => {
      if (!homeFracs[fi].length || frag.length < 2) return;
      const toXY = projector(frag[0][1]);
      const xy = frag.map(toXY);
      const cum = [0];
      for (let k = 1; k < xy.length; k++) cum.push(cum[k - 1] + Math.hypot(xy[k][0] - xy[k - 1][0], xy[k][1] - xy[k - 1][1]));
      const total = cum[cum.length - 1];
      for (const f of homeFracs[fi]) {
        const target = f * total;
        let k = 1;
        while (k < cum.length - 1 && cum[k] < target) k++;
        const t = (target - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
        pts.push([frag[k - 1][0] + t * (frag[k][0] - frag[k - 1][0]), frag[k - 1][1] + t * (frag[k][1] - frag[k - 1][1])]);
      }
    });
    return pts.length ? pts : null;
  }

  function distToPiece(p, piece, toXY) {
    const q = toXY(p);
    let best = Infinity;
    for (let k = 1; k < piece.length; k++) {
      const a = toXY(piece[k - 1]), b = toXY(piece[k]);
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy));
    }
    return best;
  }

  // Share out homePoints between pieces of the same road (each piece a
  // [[lon,lat],...] line): every home goes to the piece it lies on (the
  // nearest one; homes on none of them within tolM are left out). Returns
  // a count per piece.
  function distribute(homePoints, pieces, tolM = 2) {
    const counts = pieces.map(() => 0);
    if (!homePoints || !pieces.length) return counts;
    const toXY = projector(homePoints[0][1]);
    for (const p of homePoints) {
      let best = -1, bd = Infinity;
      pieces.forEach((piece, i) => { if (piece.length >= 2) { const d = distToPiece(p, piece, toXY); if (d < bd) { bd = d; best = i; } } });
      if (best >= 0 && bd <= tolM) counts[best]++;
    }
    return counts;
  }

  // The homes lying on any of `pieces` (within tolM).
  function pointsOn(homePoints, pieces, tolM = 2) {
    if (!homePoints || !pieces.length) return [];
    const toXY = projector(homePoints[0][1]);
    return homePoints.filter(p => pieces.some(piece => piece.length >= 2 && distToPiece(p, piece, toXY) <= tolM));
  }

  // Homes' distance along a single line, sorted: for cutting a road where its homes are.
  function positionsAlong(homePoints, line, tolM = 2) {
    if (!homePoints || line.length < 2) return [];
    const toXY = projector(line[0][1]);
    const xy = line.map(toXY);
    const out = [];
    for (const p of homePoints) {
      const q = toXY(p);
      let best = null, cum = 0;
      for (let k = 1; k < xy.length; k++) {
        const a = xy[k - 1], b = xy[k];
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
        const t = L2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)) : 0;
        const d = Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
        if (!best || d < best.d) best = { d, s: cum + t * L };
        cum += L;
      }
      if (best && best.d <= tolM) out.push(best.s);
    }
    return out.sort((a, b) => a - b);
  }

  return { VERSION, MATCH_RADIUS_M, FAR_MATCH_M, fingerprint, rowKey, fragments, buildIndex, attach, pointsOnLine, distribute, pointsOn, positionsAlong };
})();

if (typeof module !== 'undefined') module.exports = Homes;
