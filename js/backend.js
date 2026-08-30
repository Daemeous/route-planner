// Progress-reporting client -- talks directly to a ward's OWN live
// leaflet-map Apps Script deployment (its MAP_CONFIG.APPS_SCRIPT_URL), the
// SAME backend the main tracker site's core.js already uses. No separate
// sheet or backend is created by this app: an authorised signed-in editor's
// taps write directly (action:"update"/"partial"); anyone else who's
// signed in has their taps queued as a pending suggestion
// (action:"propose") for an authorised editor to review in the main
// leaflet-map site's admin panel -- exactly the same accept/deny queue
// real edits already go through there. See leaflet-pipeline's
// apps-script/leaflet-map.gs.txt for the server side of this contract.
'use strict';

const Backend = (() => {
  function tokenParam() {
    const token = Auth.getAccessToken();
    if (!token) return null;
    return { accessToken: token };
  }

  async function call(appsScriptUrl, body) {
    const res = await fetch(appsScriptUrl, { method: 'POST', body: JSON.stringify(body) });
    return res.json();
  }

  async function verify(appsScriptUrl) {
    const tp = tokenParam();
    if (!tp) throw new Error('Not signed in.');
    return call(appsScriptUrl, { action: 'verify', ...tp });
  }

  // Merge a newly-covered original-geometry range into whatever's already
  // recorded for this row, so writing just this route's slice never erases
  // another route's already-reported slice of the same original road.
  function mergePartialGeometry(existingPg, newRanges) {
    const existing = (existingPg && existingPg !== '-') ? existingPg.split('|') : [];
    const added = newRanges.map(r => `seg${r.fragIdx}:${r.a.toFixed(4)}-${r.b.toFixed(4)}:B`);
    const merged = [...new Set([...existing, ...added])];
    return merged.length ? merged.join('|') : '-';
  }

  // road: one entry from a route's `roads` list (see mapData.js) -- may or
  // may not carry rowIndex/originalRanges depending on whether it's a
  // whole original road or a split-off part of one.
  // authorised: from a prior verify() call's `authorised` field.
  // Returns {ok, pending, error?}.
  async function markRoadDone(appsScriptUrl, road, authorised, done = true) {
    const tp = tokenParam();
    if (!tp) return { ok: false, error: 'Not signed in.' };
    if (road.rowIndex == null) return { ok: false, error: 'This road has no source row to report against.' };

    const isPart = Array.isArray(road.originalRanges) && road.originalRanges.length > 0;
    const action = authorised ? (isPart ? 'partial' : 'update') : 'propose';
    const body = { action, ...tp, rowIndex: road.rowIndex };

    if (isPart) {
      const pg = done
        ? mergePartialGeometry(road.currentPartialGeometry, road.originalRanges)
        : (road.currentPartialGeometry || '-'); // undo: leave prior state, this app doesn't subtract a range
      body.partialGeometry = pg;
      if (!authorised) body.field = 'partial_geometry';
    } else {
      body.newStatus = done ? 'Complete' : 'Not_Started';
      if (!authorised) body.field = 'status';
    }

    const data = await call(appsScriptUrl, body);
    if (!data.ok) return { ok: false, error: data.error || 'Request failed.' };
    return { ok: true, pending: !authorised };
  }

  // Whole-route completion is just every road on it, one call each --
  // there's no bulk endpoint on the backend, so this fires them in
  // parallel and reports how many succeeded.
  async function markRouteDone(appsScriptUrl, roads, authorised, done = true) {
    const results = await Promise.all(roads.map(r => markRoadDone(appsScriptUrl, r, authorised, done)));
    const failed = results.filter(r => !r.ok);
    return { ok: failed.length === 0, succeeded: results.length - failed.length, total: results.length, errors: failed.map(f => f.error) };
  }

  // No sign-in required -- lets a browser check whether its own earlier
  // proposals have been reviewed yet, without needing to stay signed in
  // (see handlePendingStatus in leaflet-map.gs.txt).
  async function pendingStatus(appsScriptUrl, rowFieldPairs) {
    if (!rowFieldPairs.length) return {};
    const data = await call(appsScriptUrl, { action: 'pendingStatus', rows: rowFieldPairs });
    return data.ok ? data.statuses : {};
  }

  return { verify, markRoadDone, markRouteDone, pendingStatus, mergePartialGeometry };
})();

if (typeof module !== 'undefined') module.exports = Backend;
