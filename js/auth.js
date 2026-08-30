// Google Sign-In (Identity Services) -- used for two things, both with the
// SAME lightweight "who is this" scope: reading a sheet the signed-in user
// can see (if it isn't published-to-web), and identifying the volunteer to
// the ward's live leaflet-map Apps Script backend when reporting progress
// (see backend.js), which itself decides authorised-vs-pending from the
// verified email -- this page never needs broader Sheets/Drive scopes.
// Uses the SAME OAuth client ID leaflet-map's own core.js already uses, so
// signing in here is the exact same "Sign in with Google" prompt as the
// main tracker site -- see README.md for the one Cloud Console change
// needed (adding this tool's hosted origin to that client's authorized
// origins; no new scopes, since openid/email/profile needs no extra
// consent-screen configuration).
'use strict';

const Auth = (() => {
  const SCOPES = 'openid email profile';

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;

  function loadGis() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Google Identity Services'));
      document.head.appendChild(s);
    });
  }

  function isSignedIn() { return !!accessToken && Date.now() < tokenExpiresAt; }
  function getAccessToken() { return isSignedIn() ? accessToken : null; }

  // Resolves with the access token, or rejects if the user closes the
  // consent popup / denies. clientId: pass the shared leaflet-map client ID.
  async function signIn(clientId) {
    await loadGis();
    return new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: (resp) => {
          if (resp.error) { reject(new Error(resp.error)); return; }
          accessToken = resp.access_token;
          tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
          resolve(accessToken);
        },
        error_callback: (err) => reject(new Error(err.type || 'sign-in failed')),
      });
      tokenClient.requestAccessToken({ prompt: isSignedIn() ? '' : 'consent' });
    });
  }

  function signOut() {
    if (accessToken && window.google && google.accounts) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
  }

  return { signIn, signOut, isSignedIn, getAccessToken, SCOPES };
})();

if (typeof module !== 'undefined') module.exports = Auth;
