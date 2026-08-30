# leaflet-routes

A browser-only tool that turns a ward's road data into printable, walkable
leaflet-delivery routes sized to a target number of residences (default
150 — roughly 90 minutes at ~100 homes/hour). No installation, no Python,
no server: open `index.html` (locally or hosted on GitHub Pages) and it
runs entirely client-side.

It's a companion to the [leaflet-map](https://github.com/Daemeous/leaflet-map)
/ [leaflet-pipeline](https://github.com/Daemeous/leaflet-pipeline) family,
not a replacement for either — leaflet-map is the live, ongoing
road-status tracker; this tool does the one-off job of turning that same
data into a pre-planned set of routes for a specific event day, with
printable sheets and QR codes. In-app progress reporting writes straight
back to a ward's own leaflet-map Data sheet through its existing Apps
Script backend — this tool never creates a separate sheet or backend of
its own.

## Using it

1. **Load your road data.** Paste the link to the ward's live tracker site
   (e.g. `https://yourname.github.io/leaflet-map/`) — it reads that site's
   own `MAP_CONFIG` and fills in the data source, backend, and title
   automatically. No tracker yet? Fall back to a plain "Publish to web"
   CSV link, or sign in with Google and paste any sheet link you can open.
2. **Choose a ward, route size, and start point.** Target size defaults to
   150 residences; a pub is auto-suggested from OpenStreetMap (pick from
   the shortlist) or enter a start point by hand. Large/rural wards can be
   split into several local areas automatically instead of one central
   start.
3. **Build.** Runs entirely in your browser — the same clustering
   algorithm as the Python pipeline this project grew out of (network-
   distance-aware region growing, long-road splitting, settlement-finding
   for rural wards), ported to JavaScript and validated against live
   production data.
4. **Review** the interactive map and route list.
5. **Connect the ward's live tracker** (optional, auto-filled if you used
   step 1's tracker link) so in-app progress reports go somewhere.
6. **Get your deliverables**: download the interactive app, download/print
   the route sheets, or publish straight to this tool's own GitHub Pages
   repo as `<constituency>-<ward>.html`.

## How progress reporting works

The generated app has no separate backend of its own. It talks directly to
the ward's *own* leaflet-map Apps Script deployment, using the exact same
protocol its main site already uses (see leaflet-pipeline's
`apps-script/leaflet-map.gs.txt`):

- A volunteer signs in with Google (the same "Sign in with Google" button
  as the main tracker site — no separate account, no OAuth setup on their
  end, just the standard consent prompt).
- If they're on that ward's **Authorised** list, their taps write directly
  (`action: "update"` / `"partial"`).
- Otherwise, taps go into that site's normal **pending-review queue**
  (`action: "propose"`) for an authorised editor to approve or deny from
  the main site's own admin panel — exactly like any other suggested edit
  there.
- A road that's part of a longer, split road only reports the slice this
  route actually covers (via `partial_geometry`), never the whole
  original row, so two different routes covering different parts of the
  same long road never stomp on each other.

There is no anonymous write path — reporting *anything* requires signing
in, since the backend needs a verified email to decide authorised-direct
vs pending-for-review. Read-only browsing needs no sign-in at all.

## Publishing & the 14-day freshness rule

Publishing (step 6) pushes straight to the GitHub repo this tool is itself
hosted from, via the GitHub REST API using a personal access token you
provide (an organiser action, not something volunteers ever do). The
filename is `<constituency-slug>-<ward-slug>.html`.

Every publish also deletes any previously-published page more than 14
days old (tracked in `manifest.json` alongside the pages) and reports what
it cleaned up. This is deliberate: a route plan is only as good as the
"already leafleted" data it was built from, so generating one weeks ahead
of the actual event risks double-leafleting roads that got done in the
meantime. Generate close to the day.

## One-time setup

**Google Sign-In.** This tool reuses the *same* shared OAuth client
leaflet-map's own `core.js` already uses
(`580224381168-....apps.googleusercontent.com`), requesting only
`openid email profile` — no new scopes, no sensitive-scope verification,
no Testing-mode allowlist to manage. The only Cloud Console change needed
is adding this tool's hosted origin (wherever you publish `index.html` to)
to that client's **Authorized JavaScript origins**.

**GitHub publishing.** Needs a personal access token with `repo` scope
(classic) or **Contents: read and write** (fine-grained), entered directly
in the browser at publish time — it's never stored anywhere by this tool
beyond the current page session.

## Repository contents

| Path | Purpose |
|---|---|
| `index.html` | The tool's UI — load data, configure, build, review, publish |
| `app_template.html` | Template for the downloadable/publishable interactive ward app |
| `js/geo.js` | Projection & geometry primitives |
| `js/graph.js` | Road loading, adjacency, splitting, network-distance routing |
| `js/cluster.js` | Route clustering & rural settlement-finding |
| `js/secretWords.js` | Per-route access-word generation for the app's URL scheme |
| `js/sheets.js` | Flexible column-mapping CSV/Sheets-API row loader |
| `js/tracker.js` | Reads a live leaflet-map deployment's own `MAP_CONFIG` |
| `js/pubs.js` | OpenStreetMap Overpass pub lookup |
| `js/pipeline.js` | Orchestrates a full ward build (single-hub or multi-hub) |
| `js/mapData.js` | Assembles the final route payload from a clustering result |
| `js/htmlApp.js` | Builds the downloadable/publishable app HTML |
| `js/printSheets.js` | Printable route-sheet generator (browser print/PDF) |
| `js/auth.js` | Google Sign-In (Identity Services) |
| `js/backend.js` | Talks to a ward's live leaflet-map Apps Script backend |
| `js/publish.js` | Publishes to GitHub Pages + 14-day cleanup |
| `js/colors.js` | Route colour palette |
| `js/vendor_qrcode.js` | Vendored MIT-licensed QR code generator ([kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)) |

## License

This project's own code is licensed under the **[PolyForm Noncommercial
License 1.0.0](LICENSE)**: free to use, share, and modify for any
non-commercial purpose, with attribution. Copyright © Daniel Hodgkins.

That covers this code only. The geographic data it processes comes from
sources under their own separate licenses that explicitly permit
commercial use (see Attributions below) — this project's non-commercial
restriction doesn't, and legally can't, extend to that underlying data.

## Attributions

| Dependency | License | Notes |
|---|---|---|
| [Leaflet.js](https://leafletjs.com) | BSD-2-Clause | Interactive map |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | [ODbL](https://opendatacommons.org/licenses/odbl/) | Pub lookup via Overpass API |
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | MIT | © Kazuhiko Arase — QR codes on route sheets |
| Google Identity Services | [Google Terms of Service](https://policies.google.com/terms) | Sign-in |
