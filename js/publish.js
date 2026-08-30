// Publishes a generated ward app to the route-planner repo's own GitHub
// Pages -- WITHOUT the browser ever holding a GitHub credential. The
// actual GitHub API call happens server-side, in a small Apps Script web
// app (see apps_script/publish-backend.gs) whose GitHub token lives only
// in that script's own Script Properties. This page just POSTs the built
// HTML there and gets back the live URL -- no GitHub account, no token,
// nothing for a non-technical organiser to set up.
'use strict';

const Publish = (() => {
  // The shared publish backend for this tool's own deployment. If you've
  // forked this repo, deploy your own copy of publish-backend.gs (see its
  // header comment) and swap this URL for yours.
  const PUBLISH_BACKEND_URL = 'https://script.google.com/macros/s/AKfycbw8Q0NJDPpl8UaRHzJtWU-Gef_XKy7cphYLqerCWN4AIU7e161r9QaROxKEvzXq9dD0zA/exec';
  const MAX_AGE_DAYS = 14;

  function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  // Infers {owner, repo} from the page's own GitHub Pages URL --
  // https://<owner>.github.io/<repo>/... -- purely for predicting the
  // eventual published URL in the UI before publishing; the actual write
  // happens server-side and doesn't need this.
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

  // Returns {url, filename, cleanedUp: [{filename, ward, generatedAt}]}.
  async function publishWard({ constituency, ward, htmlContent }) {
    const res = await fetch(PUBLISH_BACKEND_URL, {
      method: 'POST',
      body: JSON.stringify({ constituency, ward, htmlContent }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.error || `Publish backend returned HTTP ${res.status}.`);
    return data;
  }

  return { slugify, inferRepoFromLocation, pagesUrlFor, publishWard, MAX_AGE_DAYS, PUBLISH_BACKEND_URL };
})();

if (typeof module !== 'undefined') module.exports = Publish;
