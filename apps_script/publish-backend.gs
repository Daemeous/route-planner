/**
 * Publishes a built ward app straight to the route-planner GitHub repo,
 * WITHOUT the browser tool ever holding a GitHub credential -- the token
 * lives here, server-side, in this script's own Script Properties, never
 * sent to or visible from any browser. This is what makes the tool's
 * "Publish to our shared site" button a genuine one-click action for
 * someone who has never touched GitHub and never will.
 *
 * ── SETUP (one-time, done by whoever administers the shared deployment) ──
 * 1. Create a new Google Sheet (used only as this script's container --
 *    nothing is written to it). Extensions -> Apps Script, paste this file
 *    in as Code.gs.
 * 2. Generate a GitHub fine-grained personal access token scoped to ONLY
 *    this one repo, with ONLY "Contents: Read and write" permission --
 *    https://github.com/settings/tokens?type=beta. Nothing else. This
 *    keeps the blast radius of the token to "can edit files in this one
 *    repo" even in the worst case.
 * 3. In the Apps Script editor: Project Settings -> Script Properties ->
 *    add GITHUB_TOKEN (the token from step 2). Add GITHUB_OWNER and
 *    GITHUB_REPO too if publishing somewhere other than
 *    Daemeous/route-planner.
 * 4. Deploy -> New deployment -> Web app. Execute as: Me. Who has access:
 *    Anyone. Copy the exec URL into PUBLISH_BACKEND_URL in js/publish.js,
 *    then push that change so it's baked into the deployed tool.
 * 5. Re-deploying after an edit: Deploy -> Manage deployments -> pencil
 *    icon -> Version: New version -> Deploy (same URL, no need to touch
 *    publish.js again).
 *
 * The token this script uses NEVER reaches the browser at any point --
 * the client only ever POSTs {constituency, ward, htmlContent} here and
 * gets back {ok, url, cleanedUp}.
 *
 * It also accepts {action: 'cachePubs', bbox} from js/pubs.js whenever a
 * browser had to ask Overpass for a ward outside data/pubs.json's
 * coverage. Only the bbox is taken from the browser: this script fetches
 * the pubs from Overpass itself and commits them, so nobody can write
 * made-up pubs into the repo through it.
 */

const DEFAULT_OWNER = 'Daemeous';
const DEFAULT_REPO = 'route-planner';
const MANIFEST_PATH = 'manifest.json';
const MAX_AGE_DAYS = 14;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
    if (!token) return jsonResp({ ok: false, error: 'Server misconfigured: GITHUB_TOKEN script property is not set.' });
    const owner = PropertiesService.getScriptProperties().getProperty('GITHUB_OWNER') || DEFAULT_OWNER;
    const repo = PropertiesService.getScriptProperties().getProperty('GITHUB_REPO') || DEFAULT_REPO;

    if (body.action === 'cachePubs') return jsonResp({ ok: true, ...cachePubs(owner, repo, token, body.bbox) });

    if (!body.ward || !body.htmlContent) return jsonResp({ ok: false, error: 'Missing ward or htmlContent' });

    const result = publishWard(owner, repo, token, body.constituency || 'district', body.ward, body.htmlContent);
    return jsonResp({ ok: true, ...result });
  } catch (err) {
    return jsonResp({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return jsonResp({ ok: true, message: 'POST {constituency, ward, htmlContent} here.' });
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
}

function ghApi(method, owner, repo, path, token, body) {
  const options = {
    method,
    headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json' },
    muteHttpExceptions: true,
  };
  if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, options);
  const code = res.getResponseCode();
  if (code === 404) return null;
  const json = JSON.parse(res.getContentText() || '{}');
  if (code < 200 || code >= 300) throw new Error(`GitHub ${method} ${path} -> ${code}: ${json.message || res.getContentText()}`);
  return json;
}

function writeFile(owner, repo, path, content, message, token) {
  const existing = ghApi('GET', owner, repo, path, token);
  return ghApi('PUT', owner, repo, path, token, {
    message,
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    sha: existing ? existing.sha : undefined,
  });
}

function deleteFile(owner, repo, path, message, token) {
  const existing = ghApi('GET', owner, repo, path, token);
  if (!existing) return;
  ghApi('DELETE', owner, repo, path, token, { message, sha: existing.sha });
}

function readManifest(owner, repo, token) {
  const file = ghApi('GET', owner, repo, MANIFEST_PATH, token);
  if (!file) return {};
  try {
    return JSON.parse(Utilities.newBlob(Utilities.base64Decode(file.content)).getDataAsString('UTF-8'));
  } catch (e) {
    return {};
  }
}

// Picks the lowest-numbered filename for this ward that ISN'T currently
// occupied by a still-active deployment: <base>.html, then <base>1.html,
// <base>2.html, etc. NEVER overwrites an existing entry -- two different
// people publishing the same ward (different route sizes, different
// event days, one refining the other's draft) must never silently
// destroy each other's already-printed QR codes. `manifest` here is
// expected to already have expired entries removed, so a freed slot
// (e.g. the plain <base>.html expired and was deleted) is naturally
// reused before any higher number, keeping numbering at its lowest
// possible value rather than ever "sticking" at a higher one.
function pickAvailableFilename(manifest, base) {
  let filename = `${base}.html`;
  for (let n = 1; manifest[filename] && n < 1000; n++) {
    filename = `${base}${n}.html`;
  }
  return filename;
}

function publishWard(owner, repo, token, constituency, ward, htmlContent) {
  const constSlug = slugify(constituency);
  const wardSlug = slugify(ward);
  const base = `${constSlug}-${wardSlug}`;

  const manifest = readManifest(owner, repo, token);

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const cleanedUp = [];
  Object.keys(manifest).forEach(fname => {
    const entry = manifest[fname];
    const ts = Date.parse(entry.generatedAt);
    if (!isNaN(ts) && ts < cutoff) {
      deleteFile(owner, repo, fname, `Auto-clean: ${fname} is over ${MAX_AGE_DAYS} days old`, token);
      cleanedUp.push({ filename: fname, ward: entry.ward, generatedAt: entry.generatedAt });
      delete manifest[fname];
    }
  });

  const filename = pickAvailableFilename(manifest, base);

  writeFile(owner, repo, filename, htmlContent, `Publish ${ward} route app`, token);
  manifest[filename] = { ward, constituency, generatedAt: new Date().toISOString() };
  writeFile(owner, repo, MANIFEST_PATH, JSON.stringify(manifest, null, 2), `Update manifest for ${filename}`, token);

  return { url: `https://${owner}.github.io/${repo}/${filename}`, filename, cleanedUp };
}

// ── Shared pub cache (data/pubs.json) ──
// Format: {coverage: [{bbox, fetchedAt}], pubs: [{name, lat, lon}]} --
// `pubs` holds every OSM pub/bar inside each coverage bbox. Must stay in
// step with the query and parsing in js/pubs.js.
const PUBS_PATH = 'data/pubs.json';
const PUBS_MAX_BBOX_DEG = 0.6;   // bigger than any ward (+ buffer), small enough to stop abuse
const PUBS_MAX_COVERAGE = 300;
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

function cachePubs(owner, repo, token, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(x => typeof x === 'number' && isFinite(x))) {
    throw new Error('bbox must be [minLat, minLon, maxLat, maxLon]');
  }
  const [minLat, minLon, maxLat, maxLon] = bbox;
  if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180 || minLat >= maxLat || minLon >= maxLon) {
    throw new Error('bbox out of range');
  }
  if (maxLat - minLat > PUBS_MAX_BBOX_DEG || maxLon - minLon > PUBS_MAX_BBOX_DEG) {
    throw new Error(`bbox larger than ${PUBS_MAX_BBOX_DEG} degrees`);
  }

  // Two people opening uncached wards at once would otherwise race on the
  // file's sha and one commit would fail.
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const file = ghApi('GET', owner, repo, PUBS_PATH, token);
    let cache = { coverage: [], pubs: [] };
    if (file) {
      try { cache = JSON.parse(Utilities.newBlob(Utilities.base64Decode(file.content)).getDataAsString('UTF-8')); } catch (e) {}
    }
    if (cache.coverage.some(c => bboxContains(c.bbox, bbox))) return { cached: false, reason: 'already covered' };
    if (cache.coverage.length >= PUBS_MAX_COVERAGE) return { cached: false, reason: 'coverage list full' };

    const fresh = queryPubs(bbox);
    const key = p => `${p.name}|${p.lat.toFixed(6)}|${p.lon.toFixed(6)}`;
    // Anything already cached inside this bbox is replaced by the fresh
    // result (drops closed pubs); coverage entries this bbox swallows go too.
    const pubs = cache.pubs.filter(p => !inBbox(p, bbox));
    const seen = new Set(pubs.map(key));
    fresh.forEach(p => { if (!seen.has(key(p))) { pubs.push(p); seen.add(key(p)); } });
    pubs.sort((a, b) => a.name.localeCompare(b.name) || a.lat - b.lat);
    const coverage = cache.coverage.filter(c => !bboxContains(bbox, c.bbox));
    coverage.push({ bbox, fetchedAt: new Date().toISOString().slice(0, 10) });

    const content = JSON.stringify({ coverage, pubs }, null, 1) + '\n';
    const put = ghApi('PUT', owner, repo, PUBS_PATH, token, {
      message: `Cache ${fresh.length} pubs for bbox ${bbox.join(',')}`,
      content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
      sha: file ? file.sha : undefined,
    });
    return { cached: true, added: fresh.length, commit: put && put.commit ? put.commit.sha : null };
  } finally {
    lock.releaseLock();
  }
}

function bboxContains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function inBbox(p, bbox) {
  return p.lat >= bbox[0] && p.lat <= bbox[2] && p.lon >= bbox[1] && p.lon <= bbox[3];
}

function queryPubs(bbox) {
  const b = bbox.join(',');
  const query = `[out:json][timeout:50];(node["amenity"="pub"](${b});way["amenity"="pub"](${b});node["amenity"="bar"](${b}););out center tags;`;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const res = UrlFetchApp.fetch(endpoint, { method: 'post', payload: { data: query }, muteHttpExceptions: true });
        if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
        const result = JSON.parse(res.getContentText());
        const pubs = [];
        (result.elements || []).forEach(el => {
          const name = el.tags && el.tags.name;
          if (!name) return;
          if (el.type === 'node') pubs.push({ name, lat: el.lat, lon: el.lon });
          else if (el.center) pubs.push({ name, lat: el.center.lat, lon: el.center.lon });
        });
        return pubs;
      } catch (e) { lastErr = e; }
    }
    Utilities.sleep(3000 * (attempt + 1));
  }
  throw new Error('Overpass unreachable: ' + lastErr);
}

function jsonResp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
