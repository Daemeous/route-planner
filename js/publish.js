// Publishes a generated ward app straight to the GitHub repo this tool is
// itself hosted from (via the GitHub REST API, using a personal access
// token the organiser provides -- this is an admin action, not something
// volunteers ever touch). Filename is `<constituency>-<ward>.html`, e.g.
// stafford-littleworth.html. Also enforces the "generate close to the
// day" discipline: any previously-published page older than
// MAX_AGE_DAYS is deleted whenever a new one is published, tracked via a
// manifest.json file kept alongside the pages in the repo.
'use strict';

const Publish = (() => {
  const MAX_AGE_DAYS = 14;
  const MANIFEST_PATH = 'manifest.json';
  const API_BASE = 'https://api.github.com';

  function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  // Infers {owner, repo} from the page's own GitHub Pages URL --
  // https://<owner>.github.io/<repo>/... -- so there's nothing to
  // configure by hand when running this tool from its own published copy.
  // Returns null if not running from a *.github.io origin (e.g. localhost
  // during development), in which case the caller must ask for it.
  function inferRepoFromLocation() {
    const host = window.location.hostname;
    const m = host.match(/^([^.]+)\.github\.io$/i);
    if (!m) return null;
    const owner = m[1];
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    const repo = pathParts.length ? pathParts[0] : `${owner}.github.io`;
    const isUserRootSite = repo.toLowerCase() === `${owner}.github.io`.toLowerCase();
    return { owner, repo, isUserRootSite };
  }

  function pagesUrlFor({ owner, repo, isUserRootSite }, filename) {
    return isUserRootSite ? `https://${owner}.github.io/${filename}` : `https://${owner}.github.io/${repo}/${filename}`;
  }

  async function api(method, owner, repo, path, token, body) {
    const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${json.message || res.statusText}`);
    return json;
  }

  function toBase64Utf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function fromBase64Utf8(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
  }

  async function readManifest(owner, repo, token) {
    const file = await api('GET', owner, repo, MANIFEST_PATH, token);
    if (!file) return { manifest: {}, sha: null };
    try { return { manifest: JSON.parse(fromBase64Utf8(file.content)), sha: file.sha }; }
    catch (e) { return { manifest: {}, sha: file.sha }; }
  }

  async function writeFile(owner, repo, path, content, message, token) {
    const existing = await api('GET', owner, repo, path, token);
    return api('PUT', owner, repo, path, token, {
      message, content: toBase64Utf8(content), sha: existing ? existing.sha : undefined,
    });
  }

  async function deleteFile(owner, repo, path, message, token) {
    const existing = await api('GET', owner, repo, path, token);
    if (!existing) return;
    await api('DELETE', owner, repo, path, token, { message, sha: existing.sha });
  }

  // Returns {url, cleanedUp: [{filename, ward, generatedAt}]}.
  async function publishWard({ owner, repo, isUserRootSite }, token, { constituency, ward, htmlContent }) {
    const constSlug = slugify(constituency || 'ward');
    const wardSlug = slugify(ward);
    const filename = `${constSlug}-${wardSlug}.html`;

    const { manifest } = await readManifest(owner, repo, token);

    const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
    const cleanedUp = [];
    for (const [fname, entry] of Object.entries(manifest)) {
      if (fname === filename) continue; // about to be refreshed below regardless of age
      const ts = Date.parse(entry.generatedAt);
      if (!isNaN(ts) && ts < cutoff) {
        await deleteFile(owner, repo, fname, `Auto-clean: ${fname} is over ${MAX_AGE_DAYS} days old`, token);
        cleanedUp.push({ filename: fname, ward: entry.ward, generatedAt: entry.generatedAt });
        delete manifest[fname];
      }
    }

    await writeFile(owner, repo, filename, htmlContent, `Publish ${ward} route app`, token);
    manifest[filename] = { ward, constituency, generatedAt: new Date().toISOString() };
    await writeFile(owner, repo, MANIFEST_PATH, JSON.stringify(manifest, null, 2), `Update manifest for ${filename}`, token);

    return { url: pagesUrlFor({ owner, repo, isUserRootSite }, filename), filename, cleanedUp };
  }

  return { slugify, inferRepoFromLocation, pagesUrlFor, readManifest, publishWard, MAX_AGE_DAYS };
})();

if (typeof module !== 'undefined') module.exports = Publish;
