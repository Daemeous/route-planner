// Reads a live leaflet-map deployment's own index.html and pulls its
// MAP_CONFIG block straight out -- so pointing this tool at, say,
// https://daemeous.github.io/leaflet-map/ fills in the published-CSV
// source, the Apps Script backend, the OAuth client, and a constituency
// name guess all in one paste, instead of hunting down each value by hand.
// Deliberately does NOT eval the config block as code (even though it's a
// JS object literal, not JSON) -- a small per-field regex extracts just
// the known string fields, so a malformed or unexpected index.html can't
// run anything, it just yields fewer fields found.
'use strict';
if (typeof require !== 'undefined' && typeof Sheets === 'undefined') { global.Sheets = require('./sheets'); }

const Tracker = (() => {
  const FIELDS = ['SHEET_ID', 'SHEET_GID', 'APPS_SCRIPT_URL', 'GOOGLE_CLIENT_ID', 'TITLE', 'SUBTITLE'];

  function normaliseIndexUrl(url) {
    url = url.trim();
    if (/\.html?(\?|#|$)/i.test(url)) return url;
    return url.replace(/\/?$/, '/') + 'index.html';
  }

  function parseConfigBlock(html) {
    const blockMatch = html.match(/(?:window\.)?MAP_CONFIG\s*=\s*\{([\s\S]*?)\n\s*\};/);
    if (!blockMatch) return null;
    const block = blockMatch[1];
    const found = {};
    for (const field of FIELDS) {
      const m = block.match(new RegExp(`\\b${field}\\s*:\\s*["']([^"']*)["']`));
      if (m) found[field] = m[1];
    }
    return found;
  }

  // Returns {sheetId, sheetGid, appsScriptUrl, googleClientId, title,
  // subtitle, csvUrl} or throws with a clear reason.
  async function fetchTrackerConfig(trackerUrl) {
    const indexUrl = normaliseIndexUrl(trackerUrl);
    let res;
    try {
      res = await fetch(indexUrl);
    } catch (e) {
      throw new Error(`Couldn't reach ${indexUrl} (${e.message}). Cross-site fetches can be blocked by the browser for some hosts -- try pasting the published-CSV link directly instead.`);
    }
    if (!res.ok) throw new Error(`Couldn't fetch ${indexUrl} (HTTP ${res.status}).`);
    const html = await res.text();
    const cfg = parseConfigBlock(html);
    if (!cfg || !cfg.SHEET_ID) throw new Error("That page doesn't look like a leaflet-map deployment (no MAP_CONFIG.SHEET_ID found).");

    return {
      sheetId: cfg.SHEET_ID,
      sheetGid: cfg.SHEET_GID || '0',
      appsScriptUrl: cfg.APPS_SCRIPT_URL || '',
      googleClientId: cfg.GOOGLE_CLIENT_ID || '',
      title: cfg.TITLE || '',
      subtitle: cfg.SUBTITLE || '',
      csvUrl: Sheets.pubCsvUrl(cfg.SHEET_ID, cfg.SHEET_GID || '0'),
    };
  }

  return { fetchTrackerConfig, parseConfigBlock, normaliseIndexUrl };
})();

if (typeof module !== 'undefined') module.exports = Tracker;
