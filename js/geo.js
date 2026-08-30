// Geometry/projection primitives -- direct port of pipeline/graph.py's
// geometry helpers (dist_m, nearest_point_on_multiline, cum_lengths,
// point_at_fraction, remaining_subpaths, covered_subpaths, seg_length).
// Points are always [lon, lat] pairs, matching the Python side.
'use strict';

const Geo = (() => {
  const state = { lat0: 52.82 }; // overwritten per-ward by setLatRef()
  const MIN_SUBPATH_LEN_M = 5;

  function setLatRef(lat) { state.lat0 = lat; }
  function getLatRef() { return state.lat0; }

  function distM(p1, p2) {
    const [lon1, lat1] = p1, [lon2, lat2] = p2;
    const dx = (lon2 - lon1) * 111320 * Math.cos(state.lat0 * Math.PI / 180);
    const dy = (lat2 - lat1) * 111320;
    return Math.hypot(dx, dy);
  }

  function segLength(pts) {
    let tot = 0;
    for (let i = 0; i < pts.length - 1; i++) tot += distM(pts[i], pts[i + 1]);
    return tot;
  }

  function cumLengths(pts) {
    const cum = [0];
    for (let i = 0; i < pts.length - 1; i++) cum.push(cum[cum.length - 1] + distM(pts[i], pts[i + 1]));
    return { cum, total: cum[cum.length - 1] };
  }

  function pointAtFraction(pts, cum, total, frac) {
    if (total === 0) return pts[0];
    const target = frac * total;
    for (let i = 0; i < cum.length - 1; i++) {
      if (cum[i] <= target && target <= cum[i + 1]) {
        const segLen = cum[i + 1] - cum[i];
        if (segLen === 0) return pts[i];
        const t = (target - cum[i]) / segLen;
        return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])];
      }
    }
    return pts[pts.length - 1];
  }

  function nearestPointOnMultiline(geometry, ref) {
    let bestD = Infinity, bestPt = null;
    const [rx, ry] = ref;
    for (const frag of geometry) {
      for (let i = 0; i < frag.length - 1; i++) {
        const [x1, y1] = frag[i], [x2, y2] = frag[i + 1];
        const dx = x2 - x1, dy = y2 - y1;
        const L2 = dx * dx + dy * dy;
        const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((rx - x1) * dx + (ry - y1) * dy) / L2));
        const px = x1 + t * dx, py = y1 + t * dy;
        const d = distM([rx, ry], [px, py]);
        if (d < bestD) { bestD = d; bestPt = [px, py]; }
      }
    }
    return bestPt;
  }

  function nearestFractionOnFrag(frag, cum, total, ref, tolerance) {
    let bestD = Infinity, bestFrac = null;
    for (let i = 0; i < frag.length - 1; i++) {
      const [x1, y1] = frag[i], [x2, y2] = frag[i + 1];
      const dx = x2 - x1, dy = y2 - y1;
      const L2 = dx * dx + dy * dy;
      const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((ref[0] - x1) * dx + (ref[1] - y1) * dy) / L2));
      const px = x1 + t * dx, py = y1 + t * dy;
      const d = distM(ref, [px, py]);
      if (d < bestD) {
        const segFrac = total === 0 ? 0 : (cum[i] + t * (cum[i + 1] - cum[i])) / total;
        bestD = d; bestFrac = segFrac;
      }
    }
    if (bestD <= tolerance) return { d: bestD, frac: bestFrac };
    return { d: Infinity, frac: null };
  }

  function mergeRanges(ranges) {
    const merged = [];
    for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
      if (merged.length && a <= merged[merged.length - 1][1] + 1e-9) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
      } else {
        merged.push([a, b]);
      }
    }
    return merged;
  }

  function remainingSubpaths(pts, coveredRanges) {
    if (!coveredRanges.length) return [pts];
    const { cum, total } = cumLengths(pts);
    const merged = mergeRanges(coveredRanges);
    const remaining = [];
    let cursor = 0;
    for (const [a, b] of merged) {
      if (a > cursor + 1e-9) remaining.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < 1 - 1e-9) remaining.push([cursor, 1]);

    const out = [];
    for (const [a, b] of remaining) {
      if (b - a < 1e-9) continue;
      const startPt = pointAtFraction(pts, cum, total, a);
      const endPt = pointAtFraction(pts, cum, total, b);
      const mid = pts.filter((_, i) => cum[i] > a * total && cum[i] < b * total);
      const sub = [startPt, ...mid, endPt];
      if (segLength(sub) >= MIN_SUBPATH_LEN_M) out.push(sub);
    }
    return out;
  }

  function coveredSubpaths(pts, coveredRanges) {
    if (!coveredRanges.length) return [];
    const { cum, total } = cumLengths(pts);
    const merged = mergeRanges(coveredRanges);
    const out = [];
    for (const [a, b] of merged) {
      if (b - a < 1e-9) continue;
      const startPt = pointAtFraction(pts, cum, total, a);
      const endPt = pointAtFraction(pts, cum, total, b);
      const mid = pts.filter((_, i) => cum[i] > a * total && cum[i] < b * total);
      const sub = [startPt, ...mid, endPt];
      if (segLength(sub) >= MIN_SUBPATH_LEN_M) out.push(sub);
    }
    return out;
  }

  return {
    setLatRef, getLatRef, distM, segLength, cumLengths, pointAtFraction,
    nearestPointOnMultiline, nearestFractionOnFrag, remainingSubpaths, coveredSubpaths,
  };
})();

if (typeof module !== 'undefined') module.exports = Geo;
