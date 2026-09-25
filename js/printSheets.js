// Printable route sheets -- an HTML/CSS equivalent of pipeline/build_docx.py's
// cover page + one page per route. Designed for the browser's own
// Print/Save-as-PDF rather than a .docx file, so no server-side rendering
// or extra library is needed -- open it, print it. The cover page's ward
// overview stays a lightweight inline SVG (see makeProjector/overviewSvg),
// but each route's own mini-map is a live Leaflet map on CARTO's "Positron"
// tiles, with the route's own roads labelled directly on top of it --
// street names/POIs from the tile itself, plus guaranteed labels for the
// route's own roads (tile providers routinely skip labelling short
// residential roads/cul-de-sacs at this zoom), beat the flat, unlabelled
// schematic this used to render.
'use strict';
if (typeof require !== 'undefined') {
  if (typeof Geo === 'undefined') global.Geo = require('./geo');
  if (typeof Colors === 'undefined') global.Colors = require('./colors');
  if (typeof qrcode === 'undefined') global.qrcode = require('./vendor_qrcode');
  if (typeof directionsMapFactory === 'undefined') global.directionsMapFactory = require('./directionsMap').directionsMapFactory;
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
  // north is up. Returns {project(lon,lat) -> [x,y], viewBox}. Only used
  // for the cover page's whole-ward overview now -- individual route
  // sheets use a live Leaflet map instead (see buildRouteMapSpec).
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

  function lonLatToLatLng([lon, lat]) { return [lat, lon]; }

  // wardStart is the ward/hub's event-start point, used as a fallback hub
  // marker for routes that don't carry their own (single-hub walk routes,
  // which have neither route.hub nor route.marker) -- without it those
  // sheets show a route with no reference point at all.
  //
  // Returns a plain-data spec (JSON-serialisable) describing everything
  // the in-browser init script needs to draw one route's map: it's built
  // here, server/build-side, from the route's own road data, then handed
  // to the browser rather than reaching back into `route` there.
  function buildRouteMapSpec(route, color, wardStart) {
    const roads = route.roads.map(rd => ({
      name: rd.name,
      segments: rd.geometry.filter(seg => seg.length >= 2).map(seg => seg.map(lonLatToLatLng)),
    }));
    const hubPoint = route.hub ? route.hub.point : (wardStart ? wardStart.point : null);
    const hubLabel = route.hub ? route.hub.label : (wardStart ? wardStart.label : null);
    return {
      id: route.id,
      color,
      roads,
      hub: hubPoint ? { point: lonLatToLatLng(hubPoint), label: hubLabel } : null,
      marker: route.marker ? { point: lonLatToLatLng(route.marker.point), label: route.marker.label } : null,
    };
  }

  function qrSvg(url, cellSize = 4) {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    return qr.createSvgTag(cellSize, 4);
  }

  function coverPageHtml(data, wardName, { directions = false } = {}) {
    const totalRes = data.routes.reduce((s, r) => s + r.residencesTotal, 0);
    const walkN = data.routes.filter(r => r.kind === 'walk').length;
    const hybridN = data.routes.filter(r => r.kind === 'hybrid').length;
    const driveN = data.routes.filter(r => r.kind === 'drive').length;
    const hubs = data.hubs;
    const multiHub = hubs && hubs.length > 1;

    const startBlock = data.general
      ? `<p><b>General ward routes:</b> there's no event start point. These routes are for going out on your own, whenever suits you. Each route starts at its own suggested spot, shown on its sheet.</p>`
      : multiHub
      ? `<p><b>Event start points:</b> this ward is spread across several villages/areas, each with its own local start — see each route's "Start / parking" line for which one applies.</p>
         <ul>${hubs.map(h => `<li>${esc(h.label)}</li>`).join('')}</ul>`
      : `<p><b>Event start point:</b> ${esc(data.start.label)}</p>`;

    const startDesc = multiHub ? 'the start point named on each route' : esc(data.start.label);
    const startTip = data.general
      ? 'Each route starts at its own suggested spot, shown on its sheet and map. Street routes are walked; lane routes are driven, delivering both sides as you go.'
      : null;
    const tips = directions ? [
      'Follow the numbered steps on your sheet in order, and tick each one off as you go.',
      'Some routes have two pages. Page 1 goes on the front of the plastic wallet and page 2 on the back. Just turn the wallet over when you get to the end of page 1.',
      "Keep the road on your <b>left</b>, so traffic comes towards you. The letterboxes you're doing are on your <b>right</b>. Only cross the road where a step tells you to.",
      "Each side of a road is its own step: you'll go up one side and come back down the other. Only deliver the streets in your steps, even if you walk past others.",
      startTip || `"Walk" routes start on foot from ${startDesc}. "Drive-to" and "Hybrid" routes start from a suggested free-parking road shown on the map.`,
      "Scan the QR code on your route's sheet to open the same directions on your phone, with the map following you round.",
      "Parking spots marked on the maps are suggestions on a nearby free-parking road, not official spaces. Use your own discretion and don't block driveways or verges.",
    ] : [
      'Deliver the FULL length of every road listed on your sheet, both sides — do not deliver on roads that are not on your sheet, even if you walk past them to connect two of your roads.',
      startTip || `"Walk" routes start on foot from ${startDesc}. "Drive-to" routes start from a suggested free-parking road shown on the map — park there and walk the route. "Hybrid" routes are driven to and then walked in full.`,
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
    const hubs = data.general ? [] : (data.hubs && data.hubs.length ? data.hubs : [data.start]);
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
        <div class="route-map"><div class="leaflet-mini-map" id="map-${esc(route.id)}"></div></div>
        <div class="route-info">
          <div class="route-info-main">
            <div class="route-difficulty">${difficulty(route.residencesTotal, opts.targetMin, opts.targetMax)}</div>
            <div class="route-map-note">Only deliver the streets listed below — other roads on the map are shown for orientation only. The black dot marks the start point.</div>
            <div class="route-hint"><b>Start/parking:</b> ${esc(route.startHint)}</div>
            ${route.notes ? `<div class="route-notes">${esc(route.notes)}</div>` : ''}
            <div class="route-streets"><b>Streets (${streets.length}):</b><br>${streets.map(esc).join(', ')}</div>
          </div>
          <div class="route-qr">${qrSvg(url)}<div class="route-qr-url">${esc(url)}</div></div>
        </div>
      </div>
    </section>`;
  }

  // The in-browser script that turns each route's `buildRouteMapSpec()`
  // output into an actual Leaflet map: tiles, the route's own roads, a
  // label per road (rotated to follow it, offset to the side so it isn't
  // sitting on top of the line), and hub/parking markers. Also gates the
  // print button on every map's tiles having actually loaded -- printing
  // (or Save-as-PDF) while tiles are still mid-fetch would bake in blank
  // grey squares instead of the basemap.
  function mapInitScript(specs) {
    const specsJson = JSON.stringify(specs).replace(/</g, '\\u003c');
    return `<script>
(function() {
  var specs = ${specsJson};
  var printBtn = document.getElementById('printBtn');
  var total = specs.length, loaded = 0, ready = false;
  function enablePrint() {
    if (ready) return;
    ready = true;
    printBtn.disabled = false;
    printBtn.textContent = 'Print / Save as PDF';
  }
  if (total === 0) enablePrint();
  setTimeout(enablePrint, 8000); // fallback in case a tile request stalls

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function labelAngleDeg(map, a, b) {
    var pa = map.latLngToLayerPoint(a), pb = map.latLngToLayerPoint(b);
    var angle = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle < -90) angle += 180;
    return angle;
  }
  function longestSegment(segments) {
    var best = segments[0], bestLen = -1;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i], len = 0;
      for (var j = 1; j < seg.length; j++) {
        var dy = seg[j][0] - seg[j - 1][0], dx = seg[j][1] - seg[j - 1][1];
        len += Math.sqrt(dx * dx + dy * dy);
      }
      if (len > bestLen) { bestLen = len; best = seg; }
    }
    return best;
  }

  specs.forEach(function (spec) {
    var map = L.map('map-' + spec.id, { zoomControl: false, attributionControl: true });
    // CARTO Basemaps API key (free tier, 5M tile requests/month) -- removes
    // the "API key required" watermark. From carto.com/basemaps/apikey;
    // keep CARTO/OSM attribution visible per the free-tier terms.
    var tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_32cj_1_90b7918b630fcb520359e0bc', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    tiles.on('load', function () { loaded++; if (loaded >= total) enablePrint(); });

    var allPts = [];
    spec.roads.forEach(function (r) {
      r.segments.forEach(function (seg) {
        if (seg.length < 2) return;
        L.polyline(seg, { color: spec.color, weight: 4.5, lineCap: 'round', lineJoin: 'round' }).addTo(map);
        allPts = allPts.concat(seg);
      });
    });
    if (spec.hub) allPts.push(spec.hub.point);
    if (spec.marker) allPts.push(spec.marker.point);
    if (!allPts.length) return;
    map.fitBounds(L.latLngBounds(allPts), { padding: [24, 24] });

    map.whenReady(function () {
      spec.roads.forEach(function (r) {
        var seg = longestSegment(r.segments);
        if (!seg || seg.length < 2) return;
        var mid = Math.floor((seg.length - 1) / 2);
        var a = seg[mid], b = seg[mid + 1] || seg[mid - 1];
        var angle = labelAngleDeg(map, L.latLng(a), L.latLng(b));
        var transform = 'translate(-50%,-50%) rotate(' + angle + 'deg) translate(0,-9px)';
        var html = '<span class="road-label" style="transform:' + transform + '">' + escHtml(r.name) + '</span>';
        L.marker(a, { icon: L.divIcon({ className: '', html: html, iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(map);
      });
      if (spec.hub) {
        L.marker(spec.hub.point, { icon: L.divIcon({ className: 'start-dot', iconSize: [14, 14] }) })
          .addTo(map).bindTooltip(escHtml(spec.hub.label || 'Start'), { permanent: false });
      }
      if (spec.marker) {
        var parkingHtml = '<span style="display:block;width:100%;height:100%;border-radius:50%;background:' + spec.color + ';border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.2);"></span>';
        L.marker(spec.marker.point, { icon: L.divIcon({ className: '', html: parkingHtml, iconSize: [12, 12] }) })
          .addTo(map).bindTooltip(escHtml(spec.marker.label || 'Parking'), { permanent: false });
      }
    });
  });
})();
<\/script>`;
  }

  // ---- "Walking directions" sheet style --------------------------------
  // At most TWO pages per route, one route per clear plastic wallet: page 1
  // (the front) has the map, start, QR code and the first steps; page 2 (only
  // if needed, the back) has up to two zoomed maps and the rest. By default
  // each page prints on its own sheet and the two go back to back in the
  // wallet; the print bar's "prints on both sides" tickbox adds blank backs
  // instead (after the cover, one-page routes and classic pages) so every
  // route still starts on a fresh sheet on a double-sided printer. Each page
  // is labelled with its route and page number either way. Pages are
  // fixed A4-sized boxes and a small in-page script lays each route out,
  // trying progressively more compact layouts until it fits -- so the page
  // count is decided by what actually fits, not guessed.

  function stepItemHtml(l) {
    const sideDir = esc(l.side) + (l.dir ? ` · ${l.pavement === 'both' || l.pavement === 'back' ? 'drive' : 'walk'} ${l.dir}` : '');
    const homes = l.homes < 0.5 ? 'nothing to deliver' : `${Math.round(l.homes)} home${Math.round(l.homes) === 1 ? '' : 's'}`;
    return `<li data-n="${l.n}"><span class="box"></span><span class="num" style="background:__LEGCOLOR_${l.n}__">${l.n}</span>` +
      `<div class="txt"><b>${esc(l.street)}</b> <span class="sd">${sideDir} · ${homes}</span><br><span class="cue">${esc(l.cue)}</span></div></li>`;
  }

  function directionsRoutePagesHtml(route, color, appUrlBase, wardName, general = false) {
    const d = route.directions;
    const steps = d.legs.filter(l => l.type === 'leg');
    const lanes = steps.some(l => l.pavement === 'both');
    const generalWalk = general && route.kind === 'walk' && route.marker;
    const url = `${appUrlBase}#${route.secret}`;
    const colorLight = tint(color);
    let subtitle = `${esc(wardName)} Ward · Leaflet Delivery Round Sheet`;
    if (route.hub) subtitle += ` · Area: ${esc(route.hub.label)}`;
    const startLine = generalWalk
      ? `Start on ${esc(String(route.marker.label).replace(/\s*\(part [\d.]+\)$/, ''))} (suggested). It's the coloured dot on the map.`
      : route.marker
      ? `Park on ${esc(String(route.marker.label).replace(/\s*\(part [\d.]+\)$/, ''))} (suggested, please use your own discretion). It's the coloured dot on the map.`
      : `${esc(route.startHint)}. Step 1 says where to walk to.`;
    const last = steps[steps.length - 1];
    const items = steps.map(stepItemHtml).join('') +
      (last && last.endCue ? `<li class="finish"><span class="box"></span><span class="num flag">🏁</span><div class="txt">${esc(last.endCue)}</div></li>` : '');
    const id = esc(route.id);
    return `<section class="page p1" id="p1-${id}">
      <div class="route-titlebar" style="background:${colorLight}">
        <div>
          <div class="route-id" style="color:${color}">Route ${id}</div>
          <div class="route-name">${esc(route.name)}</div>
          <div class="route-subtitle">${subtitle}</div>
        </div>
        <div class="route-titlebar-right">
          <div class="route-kind">${kindLabel(route.kind)}</div>
          <div>${(d.stats.walkM / 1000).toFixed(1)} km ${lanes ? 'in all' : 'walk'} · ${d.stats.steps} steps · ${d.stats.crossings} crossings</div>
          <div class="route-res">${Math.round(route.residencesTotal)} estimated residences</div>
        </div>
      </div>
      <div class="dmap main"><div class="lmap" id="map-${id}"></div></div>
      <div class="map-key" id="key-${id}"></div>
      <div class="info-row">
        <div class="rule"><b>Start:</b> ${startLine}<br>
          ${lanes
    ? '<b>How it works:</b> on lanes, drive along delivering both sides, then head back. On streets, park and walk, keeping the road on your left so traffic comes towards you, with the letterboxes on your right. Tick each step off as you go.'
    : "<b>Golden rule:</b> keep the road on your left, so traffic comes towards you. The letterboxes you're doing are on your right. Only cross where a step tells you to. Tick each step off as you go."}
          ${route.notes ? `<div class="route-notes">${esc(route.notes)}</div>` : ''}</div>
        <div class="qr">${qrSvg(url, 3)}<div class="qr-url">${esc(url)}</div></div>
      </div>
      <ol class="steps" id="s1-${id}"></ol>
      <div class="page-foot" id="foot-${id}">&nbsp;</div>
    </section>
    <section class="page p2" id="p2-${id}">
      <div class="p2-head"><span><b style="color:${color}">Route ${id}</b> · ${esc(route.name)} · continued</span><span class="p2-page">Page 2 of 2 · goes on the back of page 1</span></div>
      <div class="details" id="det-${id}"></div>
      <ol class="steps" id="s2-${id}"></ol>
    </section>
    <template id="pool-${id}">${items}</template>`;
  }

  function directionsLayoutScript(specs) {
    const specsJson = JSON.stringify(specs).replace(/</g, '\\u003c');
    return `<script>const DirectionsMap = (${directionsMapFactory.toString()})();<\/script>
<script>
(function () {
  var specs = ${specsJson};
  var TILE = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_32cj_1_90b7918b630fcb520359e0bc';
  var ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
  var PANEL_COLORS = ['#1a73e8', '#e8710a'];
  var MM = 96 / 25.4; // CSS px per mm
  // Most generous first; each later level packs more in. Detail maps only
  // exist if the route's steps are crowded on the main map.
  var LEVELS = [
    { mainH: 100, details: true, cols: 1, font: 10, detH: 72 },
    { mainH: 100, details: true, cols: 2, font: 9.5, detH: 72 },
    { mainH: 88, details: true, cols: 2, font: 9, detH: 60 },
    { mainH: 88, details: false, cols: 2, font: 9 },
    { mainH: 72, details: false, cols: 2, font: 8 },
    { mainH: 60, details: false, cols: 2, font: 7.2 },
  ];
  var printBtn = document.getElementById('printBtn');
  var tooLong = [];

  function overflows(el) { return el.scrollHeight > el.clientHeight + 1; }

  function layout(spec, lv, panels) {
    var p1 = document.getElementById('p1-' + spec.id), p2 = document.getElementById('p2-' + spec.id);
    var s1 = document.getElementById('s1-' + spec.id), s2 = document.getElementById('s2-' + spec.id);
    var det = document.getElementById('det-' + spec.id);
    [p1, p2].forEach(function (p) {
      p.style.setProperty('--step-font', lv.font + 'px');
      p.style.setProperty('--cols', lv.cols);
    });
    p1.querySelector('.dmap.main').style.height = lv.mainH + 'mm';
    var useDetails = !!(panels && lv.details);
    det.innerHTML = '';
    if (useDetails) {
      panels.forEach(function (pn, k) {
        det.insertAdjacentHTML('beforeend',
          '<div class="detail"><div class="detail-cap"><span class="panel-tag" style="background:' + PANEL_COLORS[k] + '">Map ' + pn.letter + '</span> steps ' + pn.from + '–' + pn.to + '</div>' +
          '<div class="dmap" style="height:' + lv.detH + 'mm"><div class="lmap" id="map-' + spec.id + '-' + pn.letter + '"></div></div></div>');
      });
    }
    s1.innerHTML = ''; s2.innerHTML = '';
    var pool = document.getElementById('pool-' + spec.id).content;
    var items = Array.prototype.slice.call(pool.children).map(function (li) { return li.cloneNode(true); });
    items.forEach(function (li) {
      var n = li.getAttribute('data-n');
      var num = li.querySelector('.num');
      if (n && num) num.style.background = DirectionsMap.legColor(+n);
    });
    p2.classList.remove('unused');
    var i = 0;
    for (; i < items.length; i++) {
      s1.appendChild(items[i]);
      if (overflows(p1)) { s1.removeChild(items[i]); break; }
    }
    for (var j = i; j < items.length; j++) s2.appendChild(items[j]);
    var needP2 = i < items.length || useDetails;
    // An unused page 2 is hidden, or shown as a blank back when printing on
    // both sides (see the .unused CSS).
    p2.classList.toggle('unused', !needP2);
    document.getElementById('foot-' + spec.id).textContent = needP2
      ? 'Page 1 of 2 · more steps on page 2, on the back'
      : 'Page 1 of 1';
    return { pages: needP2 ? 2 : 1, fits: !needP2 || !overflows(p2), useDetails: useDetails };
  }

  function chooseLayout(spec) {
    var mainPx = [190 * MM, 100 * MM], detPx = [92 * MM, 72 * MM];
    var panels = DirectionsMap.planPanels(spec.legs, mainPx, detPx);
    if (panels) panels.forEach(function (pn, k) { pn.color = PANEL_COLORS[k]; });
    var results = LEVELS.map(function (lv) { return layout(spec, lv, panels); });
    // A second page costs a second sheet of paper, but both still slip into
    // the one wallet, so readability comes first. Uncrowded route: one page
    // only if it still uses readable text. Crowded route: keep the zoomed maps
    // if at all possible. Otherwise the first (most readable) level that fits
    // on two.
    var pick = panels ? results.findIndex(function (r) { return r.fits && r.useDetails; })
      : results.findIndex(function (r, k) { return r.fits && r.pages === 1 && LEVELS[k].font >= 9; });
    if (pick < 0) pick = results.findIndex(function (r) { return r.fits; });
    if (pick < 0) { pick = LEVELS.length - 1; tooLong.push(spec.id); }
    var res = layout(spec, LEVELS[pick], panels);
    return { panels: res.useDetails ? panels : null };
  }

  var maps = [];
  function makeMap(elId) {
    var map = L.map(elId, { zoomControl: false, attributionControl: true, zoomSnap: 0.25 });
    map.tiles = L.tileLayer(TILE, { subdomains: 'abcd', maxZoom: 19, attribution: ATTR }).addTo(map);
    maps.push(map);
    return map;
  }
  function startMarker(map, spec) {
    if (!spec.start) return;
    var icon = spec.start.kind === 'parking'
      ? L.divIcon({ className: '', html: '<span style="display:block;width:14px;height:14px;border-radius:50%;background:' + spec.color + ';border:2.5px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.3)"></span>', iconSize: [14, 14] })
      : L.divIcon({ className: 'start-dot', iconSize: [14, 14] });
    L.marker(spec.start.latlng, { icon: icon, keyboard: false }).addTo(map);
  }
  function faintRoads(map, spec) {
    spec.roads.forEach(function (seg) { L.polyline(seg, { color: '#6b7178', weight: 1.5, opacity: 0.45, interactive: false }).addTo(map); });
  }

  function drawRoute(spec, chosen) {
    var main = makeMap('map-' + spec.id);
    main.fitBounds(DirectionsMap.routeBounds(spec.legs, spec.start && spec.start.latlng), { padding: [22, 22] });
    faintRoads(main, spec);
    startMarker(main, spec);
    var layer = L.layerGroup().addTo(main);
    var key = document.getElementById('key-' + spec.id);
    if (!chosen.panels) {
      DirectionsMap.drawLegs(main, layer, spec.legs, { offsetPx: 3.5 });
      DirectionsMap.drawStreetLabels(main, layer, spec.legs);
      key.textContent = 'Numbers give the order. Arrows show which way to walk. Each coloured line is drawn on the side of the road you\\'ll be on, so a road done both ways shows two lines. Dotted line = walk there, nothing to deliver.';
      return;
    }
    // Two zoomed maps: the main map becomes a key showing where each one is.
    chosen.panels.forEach(function (pn) {
      pn.legs.forEach(function (l) { L.polyline(l.latlngs, { color: pn.color, weight: 4, opacity: 0.9, interactive: false }).addTo(layer); });
      var b = L.latLngBounds(pn.legs.reduce(function (a, l) { return a.concat(l.latlngs); }, [])).pad(0.08);
      L.rectangle(b, { color: pn.color, weight: 1.5, dashArray: '5 4', fill: false, interactive: false }).addTo(layer);
      L.marker(b.getNorthWest(), { icon: L.divIcon({ className: '', html: '<span class="panel-box-label" style="background:' + pn.color + '">Map ' + pn.letter + '</span>', iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(layer);
    });
    spec.legs.filter(function (l) { return l.type === 'transfer'; }).forEach(function (l) {
      L.polyline(l.latlngs, { color: '#15181d', weight: 2.5, opacity: 0.7, dashArray: '2 7', interactive: false }).addTo(layer);
    });
    key.textContent = 'This map shows the whole route. Maps A and B on page 2 (on the back) zoom in on steps ' + chosen.panels[0].from + '–' + chosen.panels[0].to + ' and ' + chosen.panels[1].from + '–' + chosen.panels[1].to + '. Numbers give the order; arrows show which way to walk; each line is drawn on the side of the road you\\'ll be on. Dotted line = walk there, nothing to deliver.';
    chosen.panels.forEach(function (pn) {
      var m = makeMap('map-' + spec.id + '-' + pn.letter);
      var near = pn.only.has(1) ? spec.start && spec.start.latlng : null;
      m.fitBounds(DirectionsMap.routeBounds(pn.legs, near), { padding: [18, 18], maxZoom: 18 });
      faintRoads(m, spec);
      startMarker(m, spec);
      var lyr = L.layerGroup().addTo(m);
      DirectionsMap.drawLegs(m, lyr, spec.legs, { offsetPx: 3.5, only: pn.only });
      DirectionsMap.drawStreetLabels(m, lyr, spec.legs, pn.only);
    });
  }

  specs.forEach(function (spec) { drawRoute(spec, chooseLayout(spec)); });

  var pending = maps.length, ready = false;
  function enablePrint() {
    if (ready) return;
    ready = true;
    printBtn.disabled = false;
    printBtn.textContent = 'Print / Save as PDF';
  }
  if (!pending) enablePrint();
  maps.forEach(function (m) { m.tiles.once('load', function () { if (--pending <= 0) enablePrint(); }); });
  setTimeout(enablePrint, 10000); // fallback in case a tile request stalls
  if (tooLong.length) {
    document.getElementById('printNote').textContent = 'Route ' + tooLong.join(', ') + ' has too many steps to fit on two pages even at the smallest size, so it runs onto a third.';
  }
})();
<\/script>`;
  }

  function buildDirectionsPrintableHtml(data, wardName, appUrlBase, opts) {
    const colorsMap = Colors.routeColors(data.routes.map(r => r.id));
    const cover = coverPageHtml(data, wardName, { directions: true });
    const withDir = data.routes.filter(r => r.directions && r.directions.legs.some(l => l.type === 'leg'));
    const pages = data.routes.map(r => (withDir.includes(r)
      ? directionsRoutePagesHtml(r, colorsMap[r.id], appUrlBase, wardName, !!data.general)
      // No directions for this route (couldn't be planned): classic page for it.
      : routePageHtml(r, colorsMap[r.id], appUrlBase, wardName, { targetMin: opts.targetMin ?? 150, targetMax: opts.targetMax ?? 450 }).replace('class="sheet route-sheet"', 'class="page classic route-sheet"') + '<section class="page back-blank"></section>')).join('\n');
    const specs = withDir.map(r => {
      const start = r.marker
        ? { latlng: [r.marker.point[1], r.marker.point[0]], kind: 'parking' }
        : { latlng: [(r.hub || data.start).point[1], (r.hub || data.start).point[0]], kind: 'hub' };
      return {
        id: r.id, color: colorsMap[r.id], start, legs: r.directions.legs,
        roads: r.roads.flatMap(rd => rd.geometry.filter(seg => seg.length >= 2).map(seg => seg.map(([lon, lat]) => [lat, lon]))),
      };
    });
    const classicSpecs = data.routes.filter(r => !withDir.includes(r)).map(r => buildRouteMapSpec(r, colorsMap[r.id], data.general ? null : data.start));

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(wardName)} Route Sheets</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, sans-serif; color: #15181d; margin: 0; background: #e8e8e6; }
  .page { background: white; width: 190mm; height: 276mm; overflow: hidden; margin: 12px auto; padding: 0; outline: 10mm solid white; box-shadow: 0 0 0 10mm white, 0 0 0 calc(10mm + 1px) #d6d6d2; display: flex; flex-direction: column; }
  .page + .page, .page + template + .page { margin-top: calc(20mm + 14px); }
  /* Blank backs: hidden when each page gets its own sheet, shown (empty)
     when the printer prints on both sides, so each route starts a fresh sheet. */
  .page.unused, .page.back-blank { display: none; }
  body.both-sides .page.unused, body.both-sides .page.back-blank { display: flex; }
  .page.unused > * { display: none; }
  .page.unused::after, .page.back-blank::after { content: 'Blank back of the sheet above'; margin: auto; color: #b5b5b0; font-size: 12px; }
  .print-bar .sides { display: inline-flex; align-items: center; gap: 6px; margin-left: 14px; font-size: 13px; cursor: pointer; }
  .print-bar .sides input { width: 17px; height: 17px; }
  .how { font-size: 11.5px; color: #9aa3ad; margin-top: 4px; }
  body.both-sides .how.one, body:not(.both-sides) .how.both { display: none; }
  @media print {
    body { background: white; }
    .page.unused::after, .page.back-blank::after { content: none; }
    .page { margin: 0; outline: none; box-shadow: none; break-after: page; }
    .page + .page, .page + template + .page { margin-top: 0; }
    .no-print { display: none; }
    .num, .route-titlebar, .panel-tag, .panel-box-label, .leg-num { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
  .print-bar { position: sticky; top: 0; background: #15181d; color: white; padding: 10px 16px; text-align: center; z-index: 1000; }
  .print-bar button { background: #1a73e8; color: white; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .print-bar button:disabled { background: #5b6470; cursor: not-allowed; }
  .print-note { font-size: 12px; color: #f6c26b; margin-top: 4px; }
  .print-note:empty { display: none; }
  /* cover */
  .cover { padding: 6mm 4mm; display: block; }
  .cover-eyebrow { text-align: center; color: #5b6470; font-weight: 700; letter-spacing: .06em; font-size: 13px; }
  .cover h1 { text-align: center; font-size: 28px; margin: 6px 0 4px; }
  .cover-stats { text-align: center; color: #5b6470; font-size: 13px; margin-bottom: 14px; }
  .cover-overview { margin: 10px 0 18px; }
  .cover h2 { font-size: 15px; margin-top: 18px; }
  .cover ul { font-size: 12px; line-height: 1.6; color: #333; }
  /* route pages */
  .route-titlebar { display: flex; justify-content: space-between; align-items: center; padding: 9px 14px; border-radius: 9px; flex: none; }
  .route-id { font-size: 20px; font-weight: 800; }
  .route-name { font-size: 13px; font-weight: 600; margin-top: 1px; }
  .route-subtitle { font-size: 9.5px; color: #5b6470; margin-top: 1px; }
  .route-titlebar-right { text-align: right; font-size: 10.5px; color: #5b6470; }
  .route-kind { font-size: 12.5px; font-weight: 700; color: #15181d; }
  .route-res { font-size: 11px; font-weight: 700; margin-top: 1px; color: #15181d; }
  .dmap { width: 100%; border: 1px solid #e4e4e0; border-radius: 7px; overflow: hidden; flex: none; }
  .dmap.main { margin-top: 7px; }
  .lmap { width: 100%; height: 100%; background: #fbfbf9; }
  .map-key { font-size: 8.5px; color: #6b7178; font-style: italic; margin: 3px 2px 5px; flex: none; }
  .info-row { display: flex; gap: 10px; align-items: flex-start; flex: none; margin-bottom: 5px; }
  .rule { flex: 1; font-size: 10.5px; background: #f6f6f6; border-radius: 7px; padding: 6px 9px; line-height: 1.45; }
  .route-notes { font-size: 10px; color: #a06a00; font-style: italic; margin-top: 3px; }
  .qr { flex: 0 0 96px; text-align: center; }
  .qr svg { width: 86px; height: 86px; }
  .qr-url { font-size: 7px; color: #888; word-break: break-all; line-height: 1.2; }
  .p2-head { font-size: 11px; color: #5b6470; padding: 2px 2px 6px; border-bottom: 1.5px solid #15181d; flex: none; display: flex; justify-content: space-between; gap: 10px; }
  .p2-page { font-weight: 700; color: #15181d; white-space: nowrap; }
  .page-foot { margin-top: auto; padding-top: 4px; font-size: 9.5px; font-weight: 700; color: #5b6470; text-align: right; flex: none; }
  .details { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 6px 0; flex: none; }
  .details:empty { display: none; }
  .detail-cap { font-size: 10.5px; font-weight: 700; display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
  .panel-tag { display: inline-flex; align-items: center; justify-content: center; height: 17px; padding: 0 5px; border-radius: 4px; color: #fff; font-size: 10.5px; font-weight: 800; }
  .panel-box-label { font-size: 11px; font-weight: 800; color: #fff; padding: 1px 6px; border-radius: 4px; white-space: nowrap; transform: translate(-2px, -110%); display: inline-block; }
  ol.steps { list-style: none; margin: 0; padding: 0; columns: var(--cols, 1); column-gap: 14px; font-size: var(--step-font, 10px); line-height: 1.35; }
  ol.steps li { display: grid; grid-template-columns: 1.3em 1.9em 1fr; gap: 0 .45em; align-items: start; padding: .32em 0; border-bottom: 1px solid #e8e8e8; break-inside: avoid; }
  ol.steps .box { width: 1.15em; height: 1.15em; border: 1.3px solid #555; border-radius: 2px; margin-top: .1em; }
  ol.steps .num { width: 1.75em; height: 1.75em; border-radius: 50%; color: #fff; font-weight: 800; font-size: .95em; display: flex; align-items: center; justify-content: center; }
  ol.steps .num.flag { background: none; font-size: 1.1em; }
  ol.steps .sd { color: #5b6470; }
  ol.steps .cue { color: #222; }
  ol.steps li.finish .txt { color: #0a6a2a; font-style: italic; padding-top: .2em; }
  /* classic fallback page for a route without directions */
  .page.classic { padding: 4mm; display: block; }
  .page.classic .route-body { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
  .page.classic .route-map { width: 100%; aspect-ratio: 2/1; border: 1px solid #eee; border-radius: 8px; overflow: hidden; }
  .page.classic .leaflet-mini-map { width: 100%; height: 100%; }
  .page.classic .route-info { display: flex; gap: 20px; font-size: 12px; line-height: 1.6; }
  .page.classic .route-info-main { flex: 1; }
  .page.classic .route-qr svg { width: 110px; height: 110px; }
  .page.classic .route-qr-url { font-size: 8.5px; color: #888; word-break: break-all; }
  /* map decorations */
  .leg-num { width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; color: #fff; font-size: 9.5px; font-weight: 800; display: flex; align-items: center; justify-content: center; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
  .leg-arrow { width: 0; height: 0; margin: -4px 0 0 -3px; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 7px solid #fff; transform-origin: 3px 4px; }
  .road-label { position: absolute; left: 0; top: 0; white-space: nowrap; font-size: 9.5px; font-weight: 700; color: #15181d; text-shadow: 0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff; pointer-events: none; }
  .start-dot { background: #15181d; border: 2px solid white; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,.2); }
</style></head><body>
<div class="print-bar no-print"><button id="printBtn" disabled onclick="window.print()">Loading maps…</button>
  <label class="sides"><input type="checkbox" id="bothSides"> My printer prints on both sides of the paper</label>
  <div class="print-note" id="printNote"></div>
  <div class="how one">Each page prints on its own sheet of paper. If a route has a page 2, put it behind page 1 in the same clear plastic wallet, so page 1 shows on the front and page 2 on the back. One wallet per route.</div>
  <div class="how both">Page 2 prints on the back of page 1. Routes with only one page get a blank back, so every route has its own sheet. One sheet per wallet.</div>
  <div class="how" style="color:#f6c26b">Not sure? Print just the first 2 pages as a test. If they came out on one piece of paper, tick the box above.</div></div>
<script>
(function () {
  var box = document.getElementById('bothSides');
  function apply() { document.body.classList.toggle('both-sides', box.checked); }
  try { box.checked = localStorage.getItem('printBothSides') === '1'; } catch (e) {}
  apply();
  box.addEventListener('change', function () {
    apply();
    try { localStorage.setItem('printBothSides', box.checked ? '1' : '0'); } catch (e) {}
  });
})();
</script>
<section class="page cover">${cover.replace(/^<section class="sheet cover">|<\/section>$/g, '')}</section>
<section class="page back-blank"></section>
${pages}
${directionsLayoutScript(specs)}
${classicSpecs.length ? mapInitScript(classicSpecs).replace("document.getElementById('printBtn')", "({ set disabled(v) {}, set textContent(v) {} })") : ''}
</body></html>`;
  }

  function buildPrintableHtml(data, wardName, appUrlBase, opts = {}) {
    if (opts.style === 'directions') return buildDirectionsPrintableHtml(data, wardName, appUrlBase, opts);
    const targetMin = opts.targetMin ?? 150, targetMax = opts.targetMax ?? 450;
    const colorsMap = Colors.routeColors(data.routes.map(r => r.id));
    const cover = coverPageHtml(data, wardName);
    const pages = data.routes.map(r => routePageHtml(r, colorsMap[r.id], appUrlBase, wardName, { targetMin, targetMax })).join('\n');
    // General routes have no ward start point to mark on each map.
    const specs = data.routes.map(r => buildRouteMapSpec(r, colorsMap[r.id], data.general ? null : data.start));

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${esc(wardName)} Route Sheets</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet/dist/leaflet.js"></script>
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
  .route-body { display:flex; flex-direction:column; gap:16px; margin-top:16px; }
  .route-map { width:100%; border:1px solid #eee; border-radius:8px; overflow:hidden; aspect-ratio:2/1; }
  .leaflet-mini-map { width:100%; height:100%; background:#fbfbf9; }
  .route-info { display:flex; gap:24px; align-items:flex-start; }
  .route-info-main { flex:1; font-size:12px; line-height:1.6; }
  .route-difficulty { font-style:italic; color:#5b6470; margin-bottom:8px; }
  .route-map-note { font-size:9.5px; color:#8a8a85; font-style:italic; margin-bottom:8px; }
  .route-hint { background:#f6f6f6; border-radius:8px; padding:8px 10px; margin-bottom:8px; }
  .route-notes { font-size:10.5px; color:#a06a00; font-style:italic; margin-bottom:8px; }
  .route-streets { font-size:11px; color:#444; }
  .route-qr { flex:0 0 130px; text-align:center; }
  .route-qr svg { width:110px; height:110px; }
  .route-qr-url { font-size:8.5px; color:#888; margin-top:4px; word-break:break-all; }
  .print-bar { position:sticky; top:0; background:#15181d; color:white; padding:10px 16px; text-align:center; z-index:10; }
  .print-bar button { background:#1a73e8; color:white; border:none; border-radius:6px; padding:8px 16px; font-size:13px; font-weight:600; cursor:pointer; }
  .print-bar button:disabled { background:#5b6470; cursor:not-allowed; }
  .road-label { position:absolute; left:0; top:0; white-space:nowrap; font-size:10px; font-weight:700; color:#15181d; text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff,0 0 3px #fff,0 0 3px #fff; pointer-events:none; }
  .start-dot { background:#15181d; border:2px solid white; border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.2); }
</style></head><body>
<div class="print-bar no-print"><button id="printBtn" disabled onclick="window.print()">Loading maps…</button></div>
${cover}
${pages}
${mapInitScript(specs)}
</body></html>`;
  }

  return { buildPrintableHtml, difficulty, kindLabel, shapeLabel, buildRouteMapSpec, overviewSvg, qrSvg };
})();

if (typeof module !== 'undefined') module.exports = PrintSheets;
