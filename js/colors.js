// Route colour palette -- port of render_maps.py's route_colors().
'use strict';

const Colors = (() => {
  const BASE_ROUTE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

  function hlsToRgbHex(h, l, s) {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    const toHex = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  function routeColors(routeIds) {
    const colors = {};
    routeIds.forEach((rid, i) => {
      if (i < BASE_ROUTE_COLORS.length) colors[rid] = BASE_ROUTE_COLORS[i];
      else {
        const h = (((i - BASE_ROUTE_COLORS.length) * 0.618033988749895) % 1 + 1) % 1;
        colors[rid] = hlsToRgbHex(h, 0.48, 0.65);
      }
    });
    return colors;
  }

  return { routeColors, BASE_ROUTE_COLORS };
})();

if (typeof module !== 'undefined') module.exports = Colors;
