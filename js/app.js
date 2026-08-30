// Main UI controller wiring the pipeline modules to index.html.
'use strict';

// Shared OAuth client leaflet-map's own core.js already uses for its
// "Sign in with Google" button -- see README.md for the one Google Cloud
// Console change this tool needs on top of what's already configured
// (adding this tool's hosted origin to the client's authorized origins;
// no new scopes, since this only ever asks for openid/email/profile).
const DEFAULT_GOOGLE_CLIENT_ID = '580224381168-i67a13m72bvlpq8rtkhnjk15tic4k9e1.apps.googleusercontent.com';

const state = {
  rows: [], wards: [], columnMap: null,
  ward: null, roadsForBbox: null,
  pubShortlist: [], selectedPub: null,
  payload: null, appsScriptUrl: '',
  googleClientId: DEFAULT_GOOGLE_CLIENT_ID,
  repoInfo: null, appUrl: null,
};

const $ = id => document.getElementById(id);

function setBanner(el, kind, text) {
  el.className = `banner show ${kind}`;
  el.textContent = text;
}
function setBannerHtml(el, kind, html) {
  el.className = `banner show ${kind}`;
  el.innerHTML = html;
}
function clearBanner(el) { el.className = 'banner'; el.textContent = ''; }
function logLine(el, text) {
  el.classList.add('show');
  el.textContent += (el.textContent ? '\n' : '') + text;
  el.scrollTop = el.scrollHeight;
}
function enableStep(id) { $(id).classList.remove('disabled'); }
function scrollToStep(id) { $(id).scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// ── Step 1: load data ──
async function loadRowsFromCsv(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't fetch that link (HTTP ${res.status}). Check it's a "Publish to web" CSV link.`);
  const text = await res.text();
  return Sheets.fromCsvText(text);
}

function parseSheetUrl(url) {
  const idMatch = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const gidMatch = url.match(/[?#&]gid=(\d+)/);
  if (!idMatch) throw new Error("Couldn't find a spreadsheet ID in that link.");
  return { spreadsheetId: idMatch[1], gid: gidMatch ? gidMatch[1] : '0' };
}

async function loadRowsViaSheetsApi(url, accessToken) {
  const { spreadsheetId, gid } = parseSheetUrl(url);
  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) throw new Error(`Couldn't open that sheet (HTTP ${metaRes.status}). Check the link and that you have access.`);
  const meta = await metaRes.json();
  const sheetProps = (meta.sheets || []).map(s => s.properties).find(p => String(p.sheetId) === String(gid)) || meta.sheets[0].properties;

  const valuesRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetProps.title)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!valuesRes.ok) throw new Error(`Couldn't read that sheet's data (HTTP ${valuesRes.status}).`);
  const values = await valuesRes.json();
  return Sheets.fromValuesGrid(values.values || []);
}

function applyLoadedData({ rows, wards, missing, headerRow }) {
  const banner = $('loadBanner');
  const issue = $('colMapIssue');
  if (missing && missing.length) {
    issue.style.display = 'block';
    issue.innerHTML = `Couldn't find a column for: <b>${missing.join(', ')}</b>. Found headers: <code>${(headerRow || []).join(', ')}</code>. ` +
      `The tool looks for common names (Street/Road, @lat/Latitude, @lon/Longitude, Ward, Status, Residences, road_geometry, partial_geometry) -- rename a column in your sheet to match, or check you published the right tab.`;
  } else {
    issue.style.display = 'none';
  }
  if (!rows.length) { setBanner(banner, 'error', 'No rows found in that sheet.'); return; }

  state.rows = rows;
  state.wards = wards;
  setBanner(banner, 'ok', `Loaded ${rows.length} roads across ${wards.length} ward${wards.length === 1 ? '' : 's'}.`);

  const sel = $('wardSelect');
  sel.innerHTML = wards.map(w => `<option value="${w}">${w}</option>`).join('');
  enableStep('step2');
  fillConstituencyGuess();
  onWardOrStartModeChange();
}

function fillConstituencyGuess() {
  const ward = $('wardSelect').value;
  const match = state.rows.find(r => r.wardName === ward && r.constituency);
  if (match) $('constituencyName').value = match.constituency;
  updatePublishTargetHint();
}

$('manualTrackerToggle').onclick = () => $('manualTrackerBody').classList.toggle('show');
$('manualLoadToggle').onclick = () => $('manualLoadBody').classList.toggle('show');

const LAST_AREA_KEY = 'lrp:lastArea';

async function loadFromTrackerUrl(url, areaLabel) {
  const banner = $('loadBanner');
  setBanner(banner, 'info', 'Reading tracker config…');
  const cfg = await Tracker.fetchTrackerConfig(url);
  state.appsScriptUrl = cfg.appsScriptUrl;
  if (cfg.googleClientId) state.googleClientId = cfg.googleClientId;
  if (cfg.appsScriptUrl) { $('appsScriptUrl').value = cfg.appsScriptUrl; enableStep('step4'); }
  updateTrackerConnectionUI();
  setBanner(banner, 'info', `Found "${cfg.title || 'this deployment'}"'s data source -- loading…`);
  const loaded = await loadRowsFromCsv(cfg.csvUrl);
  applyLoadedData(loaded);
  if (cfg.title) $('constituencyName').value = cfg.title;
  const backendNote = cfg.appsScriptUrl ? ' Its live tracker backend is connected too, so reporting works out of the box.' : '';
  setBanner(banner, 'ok',
    `Loaded ${loaded.rows.length} roads across ${loaded.wards.length} ward(s) from "${cfg.title || url}".${backendNote}`);
  try { localStorage.setItem(LAST_AREA_KEY, JSON.stringify({ label: areaLabel || cfg.title || url, url })); } catch (e) {}
  scrollToStep('step2');
}

async function populateDeploymentDropdown() {
  const sel = $('deploymentSelect');
  try {
    const list = await Tracker.fetchDeploymentRegistry();
    let lastUrl = null;
    try { lastUrl = JSON.parse(localStorage.getItem(LAST_AREA_KEY) || 'null'); } catch (e) {}
    sel.innerHTML = '<option value="">— Choose your area —</option>' +
      list.map(d => `<option value="${d.url}"${lastUrl && lastUrl.url === d.url ? ' selected' : ''}>${d.name}</option>`).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">Couldn\'t load the list -- use the link option below</option>';
    $('manualTrackerBody').classList.add('show');
  }
}
populateDeploymentDropdown();

$('loadDeploymentBtn').onclick = async () => {
  const sel = $('deploymentSelect');
  const url = sel.value;
  const banner = $('loadBanner');
  if (!url) { setBanner(banner, 'error', 'Pick your area from the list first.'); return; }
  try { await loadFromTrackerUrl(url, sel.options[sel.selectedIndex].textContent); }
  catch (e) { setBanner(banner, 'error', e.message); }
};

$('loadTrackerBtn').onclick = async () => {
  const url = $('trackerUrl').value.trim();
  const banner = $('loadBanner');
  if (!url) { setBanner(banner, 'error', 'Paste your tracker site\'s link first.'); return; }
  try { await loadFromTrackerUrl(url); }
  catch (e) { setBanner(banner, 'error', e.message); }
};

$('loadCsvBtn').onclick = async () => {
  const url = $('csvUrl').value.trim();
  const banner = $('loadBanner');
  if (!url) { setBanner(banner, 'error', 'Paste a published CSV link first.'); return; }
  setBanner(banner, 'info', 'Loading…');
  try { applyLoadedData(await loadRowsFromCsv(url)); }
  catch (e) { setBanner(banner, 'error', e.message); }
};

$('showSignInLoadBtn').onclick = () => {
  $('signInLoadPanel').style.display = $('signInLoadPanel').style.display === 'none' ? 'block' : 'none';
};

$('signInLoadBtn').onclick = async () => {
  const url = $('sheetEditUrl').value.trim();
  const banner = $('loadBanner');
  if (!url) { setBanner(banner, 'error', 'Paste a sheet link first.'); return; }
  setBanner(banner, 'info', 'Signing in…');
  try {
    const token = await Auth.signIn(state.googleClientId);
    setBanner(banner, 'info', 'Reading sheet…');
    applyLoadedData(await loadRowsViaSheetsApi(url, token));
  } catch (e) { setBanner(banner, 'error', e.message); }
};

// ── Step 2: ward + config ──
$('advancedToggle').onclick = () => $('advancedBody').classList.toggle('show');

document.querySelectorAll('input[name=startMode]').forEach(r => {
  r.onchange = () => {
    document.querySelectorAll('.radio-opt').forEach(o => o.classList.remove('active'));
    r.closest('.radio-opt').classList.add('active');
    $('manualStartFields').style.display = r.value === 'manual' ? 'block' : 'none';
    $('pubPickPanel').style.display = r.value === 'auto' ? 'block' : 'none';
    onWardOrStartModeChange();
  };
});

// Skips the "paste an Apps Script URL and test it" busywork when it's
// already known-good from the tracker load -- nothing to verify there.
function updateTrackerConnectionUI() {
  const connected = !!state.appsScriptUrl;
  $('trackerAutoConnected').style.display = connected ? 'block' : 'none';
  $('trackerManualConnect').style.display = connected ? 'none' : 'block';
}

$('coordPaste').addEventListener('input', () => {
  const banner = $('coordBanner');
  const parsed = Coords.parseCoordinatePaste($('coordPaste').value);
  if (!parsed) { clearBanner(banner); return; }
  $('manualStartLat').value = parsed.lat;
  $('manualStartLon').value = parsed.lon;
  setBanner(banner, 'ok', `Parsed: ${parsed.lat}, ${parsed.lon} -- check it looks right below, or edit either field directly.`);
});

$('wardScale').onchange = onWardOrStartModeChange;
$('wardSelect').onchange = () => { fillConstituencyGuess(); onWardOrStartModeChange(); };

async function onWardOrStartModeChange() {
  const ward = $('wardSelect').value;
  const wardScale = $('wardScale').value;
  const startMode = document.querySelector('input[name=startMode]:checked').value;
  const panel = $('pubPickPanel');
  if (!ward || wardScale === 'multi' || startMode !== 'auto') { panel.innerHTML = ''; return; }

  panel.innerHTML = '<div class="hint">Looking up nearby pubs…</div>';
  try {
    const wardRows = state.rows.filter(r => r.wardName === ward);
    const roads = Graph.loadRoads(wardRows, { ward });
    const bbox = Pipeline.bboxOfRoads(roads);
    const centroid = Pipeline.weightedCentroid(roads);
    const pubs = await Pubs.fetchPubs(bbox);
    const shortlist = Pubs.shortlistPubsForWard(pubs, centroid, 6);
    state.pubShortlist = shortlist;
    if (!shortlist.length) { panel.innerHTML = pubLookupFallbackHtml(); return; }
    state.selectedPub = shortlist[0];
    panel.innerHTML = '<div class="hint">Pick the event start pub:</div>' + shortlist.map((p, i) =>
      `<label class="radio-opt${i === 0 ? ' active' : ''}" style="margin-top:6px">
        <input type="radio" name="pubPick" value="${i}" ${i === 0 ? 'checked' : ''}>
        <div><div class="radio-opt-label">${p.name}</div><div class="radio-opt-desc">${p.distanceM}m from ward centre</div></div>
      </label>`).join('');
    panel.querySelectorAll('input[name=pubPick]').forEach(r => r.onchange = () => {
      panel.querySelectorAll('.radio-opt').forEach(o => o.classList.remove('active'));
      r.closest('.radio-opt').classList.add('active');
      state.selectedPub = shortlist[parseInt(r.value, 10)];
    });
  } catch (e) {
    panel.innerHTML = pubLookupFallbackHtml(e.message);
  }
}

function pubLookupFallbackHtml(errorDetail) {
  const reason = errorDetail ? `Couldn't look up pubs (${errorDetail}).` : "No pubs found nearby.";
  return `<div class="hint">${reason}
    <button class="btn secondary" style="margin-top:8px" onclick="switchToManualStart()">Enter a start point myself instead</button><br><br>
    Search "&lt;pub name&gt; &lt;town&gt; latitude longitude" on Google, and its AI answer will give you
    coordinates to paste straight in.</div>`;
}

function switchToManualStart() {
  document.querySelector('input[name=startMode][value=manual]').click();
  $('manualStartName').focus();
}

function currentClusterOpts() {
  const target = parseInt($('targetSize').value, 10) || 150;
  const min = parseInt($('targetMin').value, 10) || Math.round(target * 0.75);
  const max = parseInt($('targetMax').value, 10) || Math.round(target * 2.25);
  return {
    targetSoft: target, targetMin: min, targetMax: max,
    walkRadiusM: parseInt($('walkRadius').value, 10) || 700,
    hybridRadiusM: parseInt($('hybridRadius').value, 10) || 1100,
  };
}

$('buildBtn').onclick = async () => {
  const log = $('buildLog');
  const banner = $('buildBanner');
  log.textContent = ''; log.classList.add('show');
  clearBanner(banner);
  $('buildBtn').disabled = true;
  try {
    const ward = $('wardSelect').value;
    const wardScale = $('wardScale').value;
    const startMode = document.querySelector('input[name=startMode]:checked').value;
    const opts = currentClusterOpts();

    let payload;
    if (wardScale === 'multi') {
      logLine(log, `Building ${ward} as multiple local areas…`);
      const wardRows = state.rows.filter(r => r.wardName === ward);
      const roadsForBbox = Graph.loadRoads(wardRows, { ward });
      const bbox = Pipeline.bboxOfRoads(roadsForBbox);
      logLine(log, 'Looking up pubs across the ward…');
      const pubs = await Pubs.fetchPubs(bbox);
      logLine(log, `Found ${pubs.length} pubs. Finding settlements and clustering…`);
      payload = await Pipeline.buildMultiHub(state.rows, ward, pubs, { clusterOpts: opts });
      logLine(log, `Done: ${payload.hubs.length} local areas, ${payload.routes.length} routes.`);
    } else {
      let pubName, pubLat, pubLon;
      if (startMode === 'manual') {
        pubName = $('manualStartName').value.trim() || 'Start point';
        pubLat = parseFloat($('manualStartLat').value);
        pubLon = parseFloat($('manualStartLon').value);
        if (!isFinite(pubLat) || !isFinite(pubLon)) throw new Error('Enter a valid latitude and longitude for the start point.');

        const wardRoadsForCheck = Graph.loadRoads(state.rows.filter(r => r.wardName === ward), { ward });
        const [latMin, lonMin, latMax, lonMax] = Pipeline.bboxOfRoads(wardRoadsForCheck);
        const fixed = Coords.fixSignIfOutOfBounds({ lat: pubLat, lon: pubLon }, { latMin, lonMin, latMax, lonMax });
        if (fixed.corrected) {
          pubLat = fixed.lat; pubLon = fixed.lon;
          logLine(log, `⚠ ${fixed.note}`);
          $('manualStartLat').value = pubLat; $('manualStartLon').value = pubLon;
        }
      } else {
        if (!state.selectedPub) throw new Error('No start pub selected -- wait for the lookup to finish or enter one manually.');
        pubName = state.selectedPub.name; pubLat = state.selectedPub.lat; pubLon = state.selectedPub.lon;
      }
      logLine(log, `Building ${ward} from ${pubName}…`);
      payload = Pipeline.buildSingleHub(state.rows, ward, pubName, pubLat, pubLon, opts);
      logLine(log, `Done: ${payload.routes.length} routes.`);
    }

    state.ward = ward;
    state.payload = payload;
    renderReview(payload);
    setBanner(banner, 'ok', 'Routes built -- see the review step below.');
    enableStep('step3'); enableStep('step4'); enableStep('step5');
    updateTrackerConnectionUI();
    updatePublishTargetHint();
    scrollToStep('step3');
  } catch (e) {
    setBanner(banner, 'error', e.message);
    console.error(e);
  } finally {
    $('buildBtn').disabled = false;
  }
};

// ── Step 3: review ──
function buildAppHtml() {
  return HtmlApp.buildHtml(state.payload, window.__APP_TEMPLATE__, state.ward, {
    appsScriptUrl: state.appsScriptUrl, googleClientId: state.googleClientId,
  });
}

function renderReview(payload) {
  const total = payload.routes.reduce((s, r) => s + r.residencesTotal, 0);
  const walkN = payload.routes.filter(r => r.kind === 'walk').length;
  const hybridN = payload.routes.filter(r => r.kind === 'hybrid').length;
  const driveN = payload.routes.filter(r => r.kind === 'drive').length;

  $('summaryGrid').innerHTML = [
    [payload.routes.length, 'Routes'],
    [Math.round(total).toLocaleString(), 'Residences'],
    [walkN, 'Walk'],
    [hybridN, 'Hybrid'],
    [driveN, 'Drive-to'],
    [(payload.hubs || [1]).length, payload.hubs ? 'Local areas' : 'Start point'],
  ].map(([num, lbl]) => `<div class="summary-tile"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`).join('');

  $('previewFrame').srcdoc = buildAppHtml();

  $('routeList').innerHTML = payload.routes.map(r =>
    `<div class="rl-item"><span><b>${r.id}</b> ${r.name}</span><span>${Math.round(r.residencesTotal)} res · ${r.kind}</span></div>`
  ).join('');
}

// ── Step 4: connect this ward's live tracker ──
$('testBackendBtn').onclick = async () => {
  const url = $('appsScriptUrl').value.trim();
  const banner = $('backendTestBanner');
  if (!url) { setBanner(banner, 'error', 'Paste the Apps Script URL first.'); return; }
  setBanner(banner, 'info', 'Testing…');
  try {
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ action: '__test__' }) });
    const data = await res.json();
    if (data.error === 'Unknown action') {
      state.appsScriptUrl = url;
      setBanner(banner, 'ok', "Reached a leaflet-map backend -- looks right. This ward's app will report progress here.");
    } else {
      setBanner(banner, 'error', `Got a response, but not what a leaflet-map backend returns (${JSON.stringify(data)}). Double check the URL.`);
    }
  } catch (e) {
    setBanner(banner, 'error', `Couldn't reach that URL: ${e.message}`);
  }
  enableStep('step5');
};

// ── Step 5: deliverables ──
function downloadBlob(filename, content, mime = 'text/html') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function slugify(name) { return Publish.slugify(name); }

function currentAppUrl() {
  if (state.appUrl) return state.appUrl;
  const hostMyselfUrl = $('appUrlBase').value.trim();
  if (hostMyselfUrl) return hostMyselfUrl;
  const repoInfo = Publish.inferRepoFromLocation();
  if (repoInfo) return Publish.pagesUrlFor(repoInfo, `${slugify($('constituencyName').value || 'district')}-${slugify(state.ward)}.html`);
  return `https://example.github.io/your-repo/${slugify(state.ward)}.html`;
}

$('hostMyselfToggle').onclick = () => $('hostMyselfBody').classList.toggle('show');

$('downloadAppBtn').onclick = () => {
  if (!state.payload) return;
  downloadBlob(`${slugify(state.ward)}.html`, buildAppHtml());
};

$('downloadSheetsBtn').onclick = () => {
  if (!state.payload) return;
  const opts = currentClusterOpts();
  const html = PrintSheets.buildPrintableHtml(state.payload, state.ward, currentAppUrl(), opts);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  downloadBlob(`${slugify(state.ward)}_route_sheets.html`, html);
};

function updatePublishTargetHint() {
  const el = $('publishTargetHint');
  const repoInfo = Publish.inferRepoFromLocation();
  if (!repoInfo) {
    el.textContent = "Not running from the real hosted copy right now (e.g. local testing) -- publishing needs that to know where to land.";
    return;
  }
  state.repoInfo = repoInfo;
  const constituency = $('constituencyName').value.trim() || 'district';
  const ward = state.ward || $('wardSelect').value || 'ward';
  const filename = `${slugify(constituency)}-${slugify(ward)}.html`;
  el.innerHTML = `Will publish to: <b>${Publish.pagesUrlFor(repoInfo, filename)}</b>`;
}
$('constituencyName').addEventListener('input', updatePublishTargetHint);

$('publishBtn').onclick = async () => {
  const banner = $('publishBanner');
  const constituency = $('constituencyName').value.trim();
  if (!state.payload) { setBanner(banner, 'error', 'Build routes first.'); return; }
  if (!constituency) { setBanner(banner, 'error', 'Enter the constituency/district name first.'); return; }

  setBanner(banner, 'info', 'Publishing…');
  $('publishBtn').disabled = true;
  try {
    const result = await Publish.publishWard({ constituency, ward: state.ward, htmlContent: buildAppHtml() });
    state.appUrl = result.url;
    let cleanupNote = '';
    if (result.cleanedUp && result.cleanedUp.length) {
      cleanupNote = ` Also cleaned up ${result.cleanedUp.length} page(s) over ${Publish.MAX_AGE_DAYS} days old: ` +
        escHtml(result.cleanedUp.map(c => c.ward || c.filename).join(', ')) +
        `. Reminder: generate a fresh route plan close to the actual event day, not weeks ahead -- it needs an up-to-date picture of which roads are already done to avoid double-leafleting.`;
    }
    renderPublishedBanner(banner, result.url, cleanupNote, 'checking');
    pollUntilLive(result.url, live => renderPublishedBanner(banner, result.url, cleanupNote, live ? 'live' : 'slow'));
  } catch (e) {
    setBanner(banner, 'error', e.message);
  } finally {
    $('publishBtn').disabled = false;
  }
};

function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function renderPublishedBanner(banner, url, cleanupNote, status) {
  const link = `<a href="${escHtml(url)}" target="_blank" rel="noopener">${escHtml(url)}</a>`;
  const statusLine = {
    checking: '⏳ Publishing usually takes GitHub Pages a minute or two to go live -- checking automatically, no need to keep refreshing yourself…',
    live: '✓ It\'s live now!',
    slow: "⏳ Still building after a couple of minutes -- unusual, but the link will work once it's ready. Try it again shortly.",
  }[status];
  setBannerHtml(banner, 'ok', `Published: ${link}<br>${statusLine}${cleanupNote}`);
}

// Same-origin fetch (the published page lives on the same daemeous.github.io
// host as this tool) -- no GitHub API or token needed to know when it's up,
// just ask for the page itself until it stops 404ing.
async function pollUntilLive(url, onUpdate, { intervalMs = 6000, maxAttempts = 20 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const res = await fetch(`${url}?_check=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) { onUpdate(true); return; }
    } catch (e) { /* keep polling */ }
  }
  onUpdate(false);
}

// ── Load the app viewer template once, up front ──
fetch('app_template.html').then(r => r.text()).then(t => { window.__APP_TEMPLATE__ = t; })
  .catch(() => { window.__APP_TEMPLATE__ = null; });
