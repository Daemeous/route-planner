// The "tap the map to set a start point" modal -- the alternative to
// typing/pasting coordinates by hand. Self-contained: owns its own
// Leaflet map instance (created once, reused across opens) and DOM
// wiring, and hands back a single {lat, lon} to whoever opened it.
'use strict';

const MapPicker = (() => {
  let map = null, marker = null, roadsLayer = null;
  let onConfirmCb = null;
  let searchMarkers = [];

  const els = () => ({
    overlay: document.getElementById('pickerOverlay'),
    mapDiv: document.getElementById('pickerMap'),
    coords: document.getElementById('pickerCoords'),
    confirmBtn: document.getElementById('pickerConfirmBtn'),
    closeBtn: document.getElementById('pickerCloseBtn'),
    cancelBtn: document.getElementById('pickerCancelBtn'),
    searchInput: document.getElementById('pickerSearchInput'),
    searchBtn: document.getElementById('pickerSearchBtn'),
    searchResults: document.getElementById('pickerSearchResults'),
  });

  function ensureMap() {
    if (map) return;
    const e = els();
    map = L.map(e.mapDiv, { tap: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 19,
    }).addTo(map);
    map.on('click', ev => placeMarker(ev.latlng.lat, ev.latlng.lng));
  }

  function placeMarker(lat, lon) {
    if (marker) { marker.setLatLng([lat, lon]); }
    else {
      marker = L.marker([lat, lon], { draggable: true }).addTo(map);
      marker.on('dragend', () => { const p = marker.getLatLng(); updateCoords(p.lat, p.lng); });
    }
    updateCoords(lat, lon);
  }

  function updateCoords(lat, lon) {
    const e = els();
    e.coords.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    e.confirmBtn.disabled = false;
  }

  function clearSearchMarkers() {
    searchMarkers.forEach(m => map.removeLayer(m));
    searchMarkers = [];
  }

  async function runSearch(query, bounds) {
    const e = els();
    e.searchResults.innerHTML = '<div class="picker-search-item">Searching…</div>';
    e.searchResults.classList.add('show');
    try {
      const viewbox = bounds ? `&viewbox=${bounds.lonMin},${bounds.latMax},${bounds.lonMax},${bounds.latMin}` : '';
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6${viewbox}&q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      const results = await res.json();
      if (!results.length) { e.searchResults.innerHTML = '<div class="picker-search-item">No matches -- try tapping the map directly instead.</div>'; return; }
      e.searchResults.innerHTML = '';
      results.forEach(r => {
        const item = document.createElement('div');
        item.className = 'picker-search-item';
        item.textContent = r.display_name;
        item.onclick = () => {
          const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
          map.setView([lat, lon], 17);
          placeMarker(lat, lon);
          e.searchResults.classList.remove('show');
        };
        e.searchResults.appendChild(item);
      });
    } catch (err) {
      e.searchResults.innerHTML = `<div class="picker-search-item">Search failed (${err.message}) -- tap the map directly instead.</div>`;
    }
  }

  // opts: { roads: {name: {fullGeometry}}, bounds: {latMin,lonMin,latMax,lonMax}, initial: [lat,lon]|null }
  function open(opts, onConfirm) {
    ensureMap();
    onConfirmCb = onConfirm;
    const e = els();
    e.overlay.classList.add('show');
    e.searchInput.value = '';
    e.searchResults.classList.remove('show');
    e.confirmBtn.disabled = true;
    e.coords.textContent = 'Tap the map to place a pin';

    if (marker) { map.removeLayer(marker); marker = null; }
    if (roadsLayer) { map.removeLayer(roadsLayer); roadsLayer = null; }
    clearSearchMarkers();

    // The modal (and its map div's real pixel size) only exists once the
    // browser has actually laid out this frame's DOM changes -- a fixed
    // setTimeout can fire before that reflow happens, and fitBounds()
    // computed against a stale/zero-size container silently produces a
    // wildly-wrong zoom level. Two nested rAFs reliably land after layout.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      map.invalidateSize();
      const { bounds } = opts;
      if (bounds) map.fitBounds([[bounds.latMin, bounds.lonMin], [bounds.latMax, bounds.lonMax]], { padding: [20, 20] });

      roadsLayer = L.layerGroup();
      Object.values(opts.roads || {}).forEach(r => {
        (r.fullGeometry || []).forEach(seg => {
          L.polyline(seg.map(([lon, lat]) => [lat, lon]), { color: '#888', weight: 2, opacity: 0.6, interactive: false }).addTo(roadsLayer);
        });
      });
      roadsLayer.addTo(map);

      if (opts.initial) placeMarker(opts.initial[0], opts.initial[1]);
    }));

    e.searchBtn.onclick = () => { const q = e.searchInput.value.trim(); if (q) runSearch(q, opts.bounds); };
    e.searchInput.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); e.searchBtn.onclick(); } };
    e.confirmBtn.onclick = () => { const p = marker.getLatLng(); close(); onConfirmCb && onConfirmCb(p.lat, p.lng); };
    e.cancelBtn.onclick = close;
    e.closeBtn.onclick = close;
    e.overlay.onclick = ev => { if (ev.target === e.overlay) close(); };
  }

  function close() {
    els().overlay.classList.remove('show');
  }

  return { open, close };
})();

if (typeof module !== 'undefined') module.exports = MapPicker;
