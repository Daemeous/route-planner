// Turns a map-data payload into the final standalone ward app HTML --
// port of pipeline/html_app.py.
'use strict';

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
      start: { lat: Math.round(startLat * 1e7) / 1e7, lon: Math.round(startLon * 1e7) / 1e7, label: data.start.label },
      hubs,
      routesMeta,
      roads,
    };
  }

  function buildHtml(data, template, wardName, { appsScriptUrl = '', googleClientId = '', noSecretGate = false } = {}) {
    const payload = exportHtmlData(data);
    let out = template.replace('__HTML_DATA__', JSON.stringify(payload));
    out = out.replaceAll('__WARD_NAME__', wardName);
    out = out.replace('__APPS_SCRIPT_URL__', appsScriptUrl);
    out = out.replace('__GOOGLE_CLIENT_ID__', googleClientId);
    out = out.replace('__NO_SECRET_GATE__', noSecretGate ? 'true' : 'false');
    return out;
  }

  return { exportHtmlData, buildHtml };
})();

if (typeof module !== 'undefined') module.exports = HtmlApp;
