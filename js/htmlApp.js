// Turns a map-data payload into the final standalone ward app HTML --
// port of pipeline/html_app.py.
'use strict';
if (typeof require !== 'undefined' && typeof Colors === 'undefined') { global.Colors = require('./colors'); }
if (typeof require !== 'undefined' && typeof directionsMapFactory === 'undefined') { global.directionsMapFactory = require('./directionsMap').directionsMapFactory; }

const HtmlApp = (() => {
  function toLatLon(geometry) {
    return geometry.map(seg => seg.map(([lon, lat]) => [Math.round(lat * 1e7) / 1e7, Math.round(lon * 1e7) / 1e7]));
  }

  function exportHtmlData(data) {
    const routesMeta = {};
    const roads = [];
    for (const route of data.routes) {
      routesMeta[route.id] = {
        id: route.id,
        name: route.name,
        kind: route.kind,
        shape: route.shape,
        residences: route.residencesTotal,
        startHint: route.startHint,
        notes: route.notes,
        marker: route.marker,
        hubId: route.hubId ?? null,
        secret: route.secret,
        // Walking directions (routeDirections.js), when the build planned them.
        directions: route.directions || null,
      };
      route.roads.forEach((rd, i) => {
        roads.push({
          id: `${route.id}-${i}`,
          street: rd.name,
          routeId: route.id,
          res: rd.residences,
          status: rd.status,
          segments: toLatLon(rd.geometry),
          rowIndex: rd.rowIndex ?? null,
          originalRanges: rd.originalRanges ?? null,
          currentPartialGeometry: rd.currentPartialGeometry ?? null,
        });
      });
    }

    const [startLon, startLat] = data.start.point;
    const hubsSrc = (data.hubs && data.hubs.length) ? data.hubs : [{ id: null, label: data.start.label, point: data.start.point }];
    const hubs = hubsSrc.map(hub => {
      const [hlon, hlat] = hub.point;
      return { id: hub.id ?? null, lat: Math.round(hlat * 1e7) / 1e7, lon: Math.round(hlon * 1e7) / 1e7, label: hub.label };
    });

    return {
      ward: data.ward,
      // General ward routes (no event start point): the app shows no start/hub markers.
      general: !!data.general,
      start: { lat: Math.round(startLat * 1e7) / 1e7, lon: Math.round(startLon * 1e7) / 1e7, label: data.start.label },
      hubs: data.general ? [] : hubs,
      routesMeta,
      roads,
    };
  }

  function buildHtml(data, template, wardName, { appsScriptUrl = '', googleClientId = '', noSecretGate = false } = {}) {
    const payload = exportHtmlData(data);
    const routeColors = Colors.routeColors(data.routes.map(r => r.id));
    const dataJson = JSON.stringify(payload);
    let out = template.replace('__HTML_DATA__', () => dataJson);
    out = out.replaceAll('__WARD_NAME__', wardName);
    out = out.replace('__APPS_SCRIPT_URL__', appsScriptUrl);
    out = out.replace('__GOOGLE_CLIENT_ID__', googleClientId);
    out = out.replace('__NO_SECRET_GATE__', noSecretGate ? 'true' : 'false');
    out = out.replace('__ROUTE_COLOR__', JSON.stringify(routeColors));
    // Inline the directions drawing code: a downloaded/self-hosted app can't
    // count on js/directionsMap.js being next to it. (Function replacer, so
    // any "$" in the source isn't read as a replacement pattern.)
    const dirSrc = typeof directionsMapFactory === 'function'
      ? `const DirectionsMap = (${directionsMapFactory.toString()})();`
      : 'const DirectionsMap = null;';
    out = out.replace('/*__DIRECTIONS_MAP_JS__*/', () => dirSrc);
    return out;
  }

  return { exportHtmlData, buildHtml };
})();

if (typeof module !== 'undefined') module.exports = HtmlApp;
