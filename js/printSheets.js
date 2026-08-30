// Printable route sheets -- an HTML/CSS equivalent of pipeline/build_docx.py's
// cover page + one page per route. Designed for the browser's own
// Print/Save-as-PDF rather than a .docx file, so no server-side rendering
// or extra library is needed -- open it, print it. Includes a lightweight
// inline-SVG mini-map per route (projected directly from the route's own
// road geometry) since there's no static-map renderer available in-browser.
'use strict';
if (typeof require !== 'undefined') {
  if (typeof Geo === 'undefined') global.Geo = require('./geo');
  if (typeof Colors === 'undefined') global.Colors = require('./colors');
  if (typeof qrcode === 'undefined') global.qrcode = require('./vendor_qrcode');
}

const PrintSheets = (() => {
  function difficulty(res, targetMin, targetMax) {
    const span = Math.max(targetMax - targetMin, 1);
    const bands = [0.1, 0.37, 0.63, 0.9].map(f => targetMin + f * span);
    if (res < bands[0]) return 'Very Easy';
    if (res < bands[1]) return 'Easy';
    if (res < bands[2]) return 'Moderate';
    if (res < bands[3]) return 'Hard';
    return 'Very Hard';
  }

  function kindLabel(k) { return { walk: 'Walk', hybrid: 'Hybrid (drive + walk)', drive: 'Drive-to' }[k]; }
  function shapeLabel(s) { return s === 'loop' ? 'Loop (ends near start)' : 'Out & back'; }

  function tint(hexColor, amount = 0.85) {
    const h = hexColor.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const t = v => Math.round(v + (255 - v) * amount);
    return `rgb(${t(r)},${t(g)},${t(b)})`;
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // Simple equirectangular projection into an SVG viewBox, y-flipped so
  // north is up. Returns {project(lon,lat) -> [x,y], viewBox}.
  function makeProjector(points, size = 600, padFrac = 0.08) {
    const lons = points.map(p => p[0]), lats = points.map(p => p[1]);
    const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
    const latMin = Math.min(...lats), latMax = Math.max(...lats);
    const latMid = (latMin + latMax) / 2;
    const cosLat = Math.cos(latMid * Math.PI / 180);
    const spanX = Math.max((lonMax - lonMin) * cosLat, 1e-6);
    const spanY = Math.max(latMax - latMin, 1e-6);
    const aspect = spanX / spanY;
    const w = aspect >= 1 ? size : size * aspect;
    const h = aspect >= 1 ? size / aspect : size;
    const pad = size * padFrac;
    function project([lon, lat]) {
      const x = ((lon - lonMin) * cosLat / spanX) * w + pad;
      const y = (1 - (lat - latMin) / spanY) * h + pad;
      return [x, y];
    }
    return { project, width: w + 2 * pad, height: h + 2 * pad };
  }

  function routeMiniMapSvg(route, color, size = 560) {
    const allPts = [];
    for (const rd of route.roads) for (const seg of rd.geometry) allPts.push(...seg);
    if (route.marker) allPts.push(route.marker.point);
    if (route.hub) allPts.push(route.hub.point);
    if (!allPts.length) return '';
    const { project, width, height } = makeProjector(allPts, size);

    let paths = '';
    for (const rd of route.roads) {
      for (const seg of rd.geometry) {
        if (seg.length < 2) continue;
        const d = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${project(p).join(',')}`).join(' ');
        paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    }
    let markers = '';
    if (route.hub) {
      const [x, y] = project(route.hub.point);
      markers += `<circle cx="${x}" cy="${y}" r="7" fill="#15181d" stroke="white" stroke-width="2.5"/>`;
    }
    if (route.marker) {
      const [x, y] = project(route.marker.point);
      markers += `<circle cx="${x}" cy="${y}" r="5.5" fill="${color}" stroke="white" stroke-width="2"/>`;
    }
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#fbfbf9"/>${paths}${markers}</svg>`;
  }

  function qrSvg(url, cellSize = 4) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag(cellSize, 4);
  }

  function coverPageHtml(data, wardName) {
    const totalRes = data.routes.reduce((s, r) => s + r.residencesTotal, 0);
    const walkN = data.routes.filter(r => r.kind === 'walk').length;
    const hybridN = data.routes.filter(r => r.kind === 'hybrid').length;
    const driveN = data.routes.filter(r => r.kind === 'drive').length;
    const hubs = data.hubs;
    const multiHub = hubs && hubs.length > 1;

    const startBlock = multiHub
      ? `<p><b>Event start points:</b> this ward is spread across several villages/areas, each with its own local start — see each route's "Start / parking" line for which one applies.</p>
         <ul>${hubs.map(h => `<li>${esc(h.label)}</li>`).join('')}</ul>`
      : `<p><b>Event start point:</b> ${esc(data.start.label)}</p>`;

    const startDesc = multiHub ? 'the start point named on each route' : esc(data.start.label);
    const tips = [
      'Deliver the FULL length of every road listed on your sheet, both sides — do not deliver on roads that are not on your sheet, even if you walk past them to connect two of your roads.',
      `"Walk" routes start on foot from ${startDesc}. "Drive-to" routes start from a suggested free-parking road shown on the map — park there and walk the route. "Hybrid" routes are driven to and then walked in full.`,
      'A "Loop" route naturally returns you close to where you started — good for a pair splitting both sides of the road at once. "Out & back" means walk out delivering one side, then back delivering the other.',
      "Scan the QR code on your route's page to open the live interactive map on your phone.",
      "Parking spots marked on the maps are suggestions on a nearby free-parking road, not official spaces — use your own discretion and don't block driveways or verges.",
    ];
    if (multiHub) tips.push("This ward is split into several local areas, each with its own start point — you don't need to cover the whole ward in one day; treat each area as its own mini-event, and optionally meet up centrally afterwards.");

    return `<section class="sheet cover">
      <div class="cover-eyebrow">${esc(wardName.toUpperCase())} WARD</div>
      <h1>Leaflet Delivery — Route Sheets</h1>
      <p class="cover-stats">${data.routes.length} routes · ~${Math.round(totalRes).toLocaleString()} estimated residences · ${walkN} walk, ${hybridN} hybrid, ${driveN} drive-to</p>
      <div class="cover-overview">${overviewSvg(data)}</div>
      ${startBlock}
      <h2>How to use these sheets</h2>
      <ul>${tips.map(t => `<li>${t}</li>`).join('')}</ul>
    </section>`;
  }

  function overviewSvg(data) {
    const colorsMap = Colors.routeColors(data.routes.map(r => r.id));
    const allPts = [];
    for (const r of data.routes) for (const rd of r.roads) for (const seg of rd.geometry) allPts.push(...seg);
    if (!allPts.length) return '';
    const { project, width, height } = makeProjector(allPts, 640, 0.05);
    let paths = '';
    for (const r of data.routes) {
      const color = colorsMap[r.id];
      for (const rd of r.roads) for (const seg of rd.geometry) {
        if (seg.length < 2) continue;
        const d = seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${project(p).join(',')}`).join(' ');
        paths += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    }
    const hubs = data.hubs && data.hubs.length ? data.hubs : [data.start];
    let hubMarkers = '';
    for (const h of hubs) {
      const [x, y] = project(h.point);
      hubMarkers += `<circle cx="${x}" cy="${y}" r="6" fill="#15181d" stroke="white" stroke-width="2"/>`;
    }
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" style="max-height:340px" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="100%" height="100%" fill="#fbfbf9"/>${paths}${hubMarkers}</svg>`;
  }

  function routePageHtml(route, color, appUrlBase, wardName, opts) {
    const colorLight = tint(color);
    const url = `${appUrlBase}#${route.secret}`;
    const streets = [...new Set(route.roads.map(r => r.name))].sort();
    let subtitle = `${wardName} Ward · Leaflet Delivery Round Sheet`;
    if (route.hub) subtitle += ` · Area: ${esc(route.hub.label)}`;

    return `<section class="sheet route-sheet">
      <div class="route-titlebar" style="background:${colorLight}">
        <div class="route-titlebar-left">
          <div class="route-id" style="color:${color}">Route ${esc(route.id)}</div>
          <div class="route-name">${esc(route.name)}</div>
          <div class="route-subtitle">${subtitle}</div>
        </div>
        <div class="route-titlebar-right">
          <div class="route-kind">${kindLabel(route.kind)}</div>
          <div class="route-shape">${shapeLabel(route.shape)}</div>
          <div class="route-res">${Math.round(route.residencesTotal)} estimated residences</div>
        </div>
      </div>
      <div class="route-body">
        <div class="route-map">${routeMiniMapSvg(route, color)}</div>
        <div class="route-info">
          <div class="route-difficulty">${difficulty(route.residencesTotal, opts.targetMin, opts.targetMax)}</div>
          <div class="route-hint"><b>Start/parking:</b> ${esc(route.startHint)}</div>
          ${route.notes ? `<div class="route-notes">${esc(route.notes)}</div>` : ''}
          <div class="route-streets"><b>Streets (${streets.length}):</b><br>${streets.map(esc).join(', ')}</div>
          <div class="route-qr">${qrSvg(url)}<div class="route-qr-url">${esc(url)}</div></div>
        </div>
      </div>
    </section>`;
  }

  function buildPrintableHtml(data, wardName, appUrlBase, opts = {}) {
    const targetMin = opts.targetMin ?? 150, targetMax = opts.targetMax ?? 450;
    const colorsMap = Colors.routeColors(data.routes.map(r => r.id));
    const cover = coverPageHtml(data, wardName);
    const pages = data.routes.map(r => routePageHtml(r, colorsMap[r.id], appUrlBase, wardName, { targetMin, targetMax })).join('\n');

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(wardName)} Route Sheets</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #15181d; margin: 0; background: #e8e8e6; }
  .sheet { background: white; width: 210mm; min-height: 297mm; margin: 0 auto 12px; padding: 16mm; page-break-after: always; }
  @media print { body { background: white; } .sheet { margin: 0; box-shadow: none; page-break-after: always; } .no-print { display: none; } }
  .cover-eyebrow { text-align:center; color:#5b6470; font-weight:700; letter-spacing:.06em; font-size:13px; }
  .cover h1 { text-align:center; font-size:30px; margin:6px 0 4px; }
  .cover-stats { text-align:center; color:#5b6470; font-size:13px; margin-bottom:14px; }
  .cover-overview { margin: 10px 0 18px; }
  .cover h2 { font-size:15px; margin-top:18px; }
  .cover ul { font-size:12px; line-height:1.6; color:#333; }
  .route-titlebar { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; border-radius:10px; }
  .route-id { font-size:22px; font-weight:800; }
  .route-name { font-size:14px; font-weight:600; margin-top:2px; }
  .route-subtitle { font-size:10px; color:#5b6470; margin-top:2px; }
  .route-titlebar-right { text-align:right; }
  .route-kind { font-size:13px; font-weight:700; }
  .route-shape { font-size:11px; color:#5b6470; }
  .route-res { font-size:11.5px; font-weight:700; margin-top:2px; }
  .route-body { display:flex; gap:16px; margin-top:16px; }
  .route-map { flex: 1.3; border:1px solid #eee; border-radius:8px; overflow:hidden; aspect-ratio:1/1; }
  .route-info { flex: 1; font-size:12px; line-height:1.6; }
  .route-difficulty { font-style:italic; color:#5b6470; margin-bottom:8px; }
  .route-hint { background:#f6f6f6; border-radius:8px; padding:8px 10px; margin-bottom:8px; }
  .route-notes { font-size:10.5px; color:#a06a00; font-style:italic; margin-bottom:8px; }
  .route-streets { font-size:11px; color:#444; margin-bottom:14px; }
  .route-qr { text-align:center; margin-top:10px; }
  .route-qr svg { width:110px; height:110px; }
  .route-qr-url { font-size:8.5px; color:#888; margin-top:4px; word-break:break-all; }
  .print-bar { position:sticky; top:0; background:#15181d; color:white; padding:10px 16px; text-align:center; z-index:10; }
  .print-bar button { background:#1a73e8; color:white; border:none; border-radius:6px; padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer; }
</style></head><body>
<div class="print-bar no-print"><button onclick="window.print()">Print / Save as PDF</button></div>
${cover}
${pages}
</body></html>`;
  }

  return { buildPrintableHtml, difficulty, kindLabel, shapeLabel, routeMiniMapSvg, overviewSvg, qrSvg };
})();

if (typeof module !== 'undefined') module.exports = PrintSheets;
