// Drawing walking directions on a Leaflet map -- shared by the published
// ward app and the "walking directions" print sheets.
//
// Written as one self-contained factory function (no outside references
// except the global Leaflet `L`) because both consumers inline its SOURCE
// TEXT: the print sheets open from a blob: URL and the app may be
// downloaded and hosted elsewhere, so neither can rely on loading
// js/directionsMap.js by relative path. See htmlApp.js / printSheets.js.
//
// Legs come from routeDirections.js: {type:'leg', n, street, side, dir,
// pavement:'left'|'right', homes, len, cue, latlngs} or
// {type:'transfer', latlngs}. Each leg is drawn offset onto the pavement
// it's walked on, with direction arrows and a numbered badge.
'use strict';

function directionsMapFactory() {
  const LEG_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0fa3b1', '#f032e6', '#9a6324', '#469990', '#d4a000'];
  const legColor = n => LEG_COLORS[(n - 1) % LEG_COLORS.length];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Shift a line sideways by px screen pixels (positive = left of travel).
  function offsetLatLngs(map, latlngs, px) {
    const pts = latlngs.map(ll => map.latLngToLayerPoint(ll));
    const normal = (p, q) => {
      const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);
      return len ? [dy / len, -dx / len] : null; // left of travel, screen coords (y down)
    };
    return pts.map((p, i) => {
      const n1 = i > 0 ? normal(pts[i - 1], p) : null;
      const n2 = i < pts.length - 1 ? normal(p, pts[i + 1]) : null;
      let nx = (n1 ? n1[0] : 0) + (n2 ? n2[0] : 0), ny = (n1 ? n1[1] : 0) + (n2 ? n2[1] : 0);
      const len = Math.hypot(nx, ny);
      if (!len) return latlngs[i];
      nx /= len; ny /= len;
      const ref = n1 || n2;
      const miter = 1 / Math.max(0.5, ref[0] * nx + ref[1] * ny);
      return map.layerPointToLatLng([p.x + nx * px * miter, p.y + ny * px * miter]);
    });
  }
  const pavementOffset = (leg, px) => px * (leg.pavement === 'right' ? -1 : 1);

  function screenLength(map, latlngs) {
    let s = 0;
    for (let i = 1; i < latlngs.length; i++) s += map.latLngToLayerPoint(latlngs[i]).distanceTo(map.latLngToLayerPoint(latlngs[i - 1]));
    return s;
  }

  // Points at the given fractions along a line (screen space): [{latlng, angle}].
  function pointsAlong(map, latlngs, fractions) {
    const pts = latlngs.map(ll => map.latLngToLayerPoint(ll));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1];
    return fractions.map(f => {
      const s = f * total;
      let i = 1;
      while (i < pts.length - 1 && cum[i] < s) i++;
      const a = pts[i - 1], b = pts[i];
      const t = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return {
        latlng: map.layerPointToLatLng([a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)]),
        angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI,
      };
    });
  }

  // Draw legs into `layer` (cleared first). Must be redrawn after a zoom,
  // since offsets and arrow spacing are in screen pixels.
  //   sel: step number to highlight; done: Set of finished step numbers;
  //   only: Set of step numbers to draw in full (others become faint grey
  //   context -- used for zoomed print maps); badges/arrows: false to hide.
  function drawLegs(map, layer, legs, { sel = null, done = null, offsetPx = 4, onPick = null, only = null, badges = true, arrows = true, colorOf = null } = {}) {
    layer.clearLayers();
    let steps = legs.filter(l => l.type === 'leg');
    for (const l of legs) {
      if (l.type !== 'transfer') continue;
      L.polyline(l.latlngs, { color: '#15181d', weight: 2.5, opacity: 0.7, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(layer);
    }
    if (only) {
      for (const l of steps) {
        if (only.has(l.n)) continue;
        L.polyline(offsetLatLngs(map, l.latlngs, pavementOffset(l, offsetPx)), { color: '#9aa0a6', weight: 2.5, opacity: 0.55, interactive: false }).addTo(layer);
      }
      steps = steps.filter(l => only.has(l.n));
    }
    const isDone = n => !!(done && done.has(n));
    const colour = l => (isDone(l.n) ? '#9aa0a6' : colorOf ? colorOf(l) : legColor(l.n));
    const order = [...steps].sort((a, b) => (a.n === sel) - (b.n === sel)); // selected on top
    const lines = new Map();
    for (const l of order) {
      const isSel = l.n === sel, faded = sel != null && !isSel;
      const line = offsetLatLngs(map, l.latlngs, pavementOffset(l, offsetPx));
      lines.set(l.n, line);
      const pl = L.polyline(line, { color: colour(l), weight: isSel ? 6 : 4, opacity: faded ? 0.35 : 0.95, lineCap: 'round', lineJoin: 'round', bubblingMouseEvents: false }).addTo(layer);
      if (onPick) pl.on('click', () => onPick(l.n));
      if (!arrows) continue;
      const len = screenLength(map, line);
      if (len < 14) continue;
      const k = Math.max(1, Math.floor(len / 60));
      for (const p of pointsAlong(map, line, Array.from({ length: k }, (_, i) => (i + 0.5) / k))) {
        L.marker(p.latlng, {
          icon: L.divIcon({ className: '', html: `<div class="leg-arrow" style="transform:rotate(${p.angle}deg);opacity:${faded ? 0.5 : 1}"></div>`, iconSize: [0, 0] }),
          interactive: false, keyboard: false,
        }).addTo(layer);
      }
    }
    if (!badges) return;
    for (const l of order) {
      const line = lines.get(l.n);
      const [p] = pointsAlong(map, line, [Math.min(0.3, 18 / Math.max(screenLength(map, line), 1))]);
      const faded = sel != null && l.n !== sel;
      const m = L.marker(p.latlng, {
        icon: L.divIcon({ className: '', html: `<div class="leg-num" style="background:${colour(l)};opacity:${faded ? 0.55 : 1}">${l.n}</div>`, iconSize: [0, 0] }),
        keyboard: false, zIndexOffset: l.n === sel ? 1000 : 0, bubblingMouseEvents: false,
      }).addTo(layer);
      if (onPick) m.on('click', () => onPick(l.n));
    }
  }

  // One label per street, rotated along it (tiles often skip small closes).
  function drawStreetLabels(map, layer, legs, only = null) {
    const seen = new Set();
    for (const l of legs) {
      if (l.type !== 'leg' || seen.has(l.street) || (only && !only.has(l.n))) continue;
      seen.add(l.street);
      const [p] = pointsAlong(map, l.latlngs, [0.5]);
      let angle = p.angle;
      if (angle > 90) angle -= 180;
      if (angle < -90) angle += 180;
      const html = `<span class="road-label" style="transform:translate(-50%,-50%) rotate(${angle}deg) translate(0,-13px)">${esc(l.street)}</span>`;
      L.marker(p.latlng, { icon: L.divIcon({ className: '', html, iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(layer);
    }
  }

  // Bounds that frame the route itself: the start point is included only if
  // it's close -- a pub a kilometre away would shrink the route to nothing.
  function routeBounds(legs, startLatLng, nearM = 300) {
    const steps = legs.filter(l => l.type === 'leg');
    const pts = steps.flatMap(l => l.latlngs);
    if (startLatLng && steps.length && L.latLng(startLatLng).distanceTo(steps[0].latlngs[0]) < nearM) pts.push(startLatLng);
    return L.latLngBounds(pts);
  }

  // ---- Print map splitting ----------------------------------------------
  // When step badges would pile up on one map, split the steps into (at most
  // two) consecutive runs, each with its own zoomed map.
  const CROWD_PX = 14, CROWD_FRAC = 0.2;

  function fitZoom(latlngs, [w, h], pad = 22) {
    const b = L.latLngBounds(latlngs), crs = L.CRS.EPSG3857;
    const p1 = crs.latLngToPoint(b.getNorthWest(), 0), p2 = crs.latLngToPoint(b.getSouthEast(), 0);
    const scale = Math.min((w - 2 * pad) / Math.max(p2.x - p1.x, 1e-9), (h - 2 * pad) / Math.max(p2.y - p1.y, 1e-9));
    return Math.min(18, Math.floor(Math.log2(scale) * 4) / 4);
  }

  // Share of step badges that would sit on top of another when these legs are fitted into a map of `size` px.
  function crowdFrac(steps, size) {
    if (steps.length < 2) return 0;
    const z = fitZoom(steps.flatMap(l => l.latlngs), size), crs = L.CRS.EPSG3857;
    const badges = steps.map(l => {
      const pts = l.latlngs.map(ll => crs.latLngToPoint(L.latLng(ll), z));
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
      let target = Math.min(0.3 * len, 18);
      for (let i = 1; i < pts.length; i++) {
        const seg = pts[i].distanceTo(pts[i - 1]);
        if (target <= seg) return pts[i - 1].add(pts[i].subtract(pts[i - 1]).multiplyBy(seg ? target / seg : 0));
        target -= seg;
      }
      return pts[pts.length - 1];
    });
    let crowded = 0;
    badges.forEach((p, i) => { if (badges.some((q, j) => j !== i && p.distanceTo(q) < CROWD_PX)) crowded++; });
    return crowded / steps.length;
  }

  function spanOf(steps) {
    const b = L.latLngBounds(steps.flatMap(l => l.latlngs)), crs = L.CRS.EPSG3857;
    const p1 = crs.latLngToPoint(b.getNorthWest(), 0), p2 = crs.latLngToPoint(b.getSouthEast(), 0);
    return Math.max(p2.x - p1.x, p2.y - p1.y);
  }

  // Returns null (one map is fine) or two panels [{letter, legs, only, from, to}].
  // Splitting only happens when it clearly helps: each half must be less
  // crowded on its (smaller) map than the whole route is on the big one.
  function planPanels(legs, mainSize, detailSize) {
    const steps = legs.filter(l => l.type === 'leg');
    if (steps.length < 6) return null;
    const whole = crowdFrac(steps, mainSize);
    if (whole <= CROWD_FRAC) return null;
    let best = null;
    for (let i = 3; i <= steps.length - 3; i++) {
      const a = steps.slice(0, i), b = steps.slice(i);
      const sp = Math.max(spanOf(a), spanOf(b));
      if (!best || sp < best.sp) best = { i, sp, a, b };
    }
    if (!best) return null;
    const worstHalf = Math.max(crowdFrac(best.a, detailSize), crowdFrac(best.b, detailSize));
    if (worstHalf >= whole * 0.75) return null; // splitting wouldn't really help
    return [best.a, best.b].map((p, k) => ({
      letter: String.fromCharCode(65 + k), legs: p, only: new Set(p.map(l => l.n)), from: p[0].n, to: p[p.length - 1].n,
    }));
  }

  return { LEG_COLORS, legColor, offsetLatLngs, pointsAlong, screenLength, drawLegs, drawStreetLabels, routeBounds, crowdFrac, planPanels };
}

const DirectionsMap = typeof L !== 'undefined' ? directionsMapFactory() : null;
if (typeof module !== 'undefined') module.exports = { directionsMapFactory };
