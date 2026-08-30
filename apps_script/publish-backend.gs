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
 */

const DEFAULT_OWNER = 'Daemeous';
const DEFAULT_REPO = 'route-planner';
const MANIFEST_PATH = 'manifest.json';
const MAX_AGE_DAYS = 14;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!body.ward || !body.htmlContent) return jsonResp({ ok: false, error: 'Missing ward or htmlContent' });

    const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
    if (!token) return jsonResp({ ok: false, error: 'Server misconfigured: GITHUB_TOKEN script property is not set.' });
    const owner = PropertiesService.getScriptProperties().getProperty('GITHUB_OWNER') || DEFAULT_OWNER;
    const repo = PropertiesService.getScriptProperties().getProperty('GITHUB_REPO') || DEFAULT_REPO;

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

function publishWard(owner, repo, token, constituency, ward, htmlContent) {
  const constSlug = slugify(constituency);
  const wardSlug = slugify(ward);
  const filename = `${constSlug}-${wardSlug}.html`;

  const manifest = readManifest(owner, repo, token);

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const cleanedUp = [];
  Object.keys(manifest).forEach(fname => {
    if (fname === filename) return; // about to be refreshed below regardless of age
    const entry = manifest[fname];
    const ts = Date.parse(entry.generatedAt);
    if (!isNaN(ts) && ts < cutoff) {
      deleteFile(owner, repo, fname, `Auto-clean: ${fname} is over ${MAX_AGE_DAYS} days old`, token);
      cleanedUp.push({ filename: fname, ward: entry.ward, generatedAt: entry.generatedAt });
      delete manifest[fname];
    }
  });

  writeFile(owner, repo, filename, htmlContent, `Publish ${ward} route app`, token);
  manifest[filename] = { ward, constituency, generatedAt: new Date().toISOString() };
  writeFile(owner, repo, MANIFEST_PATH, JSON.stringify(manifest, null, 2), `Update manifest for ${filename}`, token);

  return { url: `https://${owner}.github.io/${repo}/${filename}`, filename, cleanedUp };
}

function jsonResp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
