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
2. **Choose a ward, route type and route size.** Two route types (see
   [Route types](#route-types)): **event day, from a start point** --
   target size defaults to 150 residences, a pub is auto-suggested (pick
   from the shortlist) or enter a start point by hand, and large/rural
   wards can be split into several local areas -- or **general ward
   routes, no start point**, sized by effort, for covering a ward over
   time. Tick **Stick closely to the target size** to keep every route
   within about ±25% of the target, instead of letting leftover streets
   push some to two or three times it.
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

## Route types

- **Event day, from a start point.** Everyone meets at a pub (or other
  start point) and routes fan out from it. Routes are sized by number of
  homes. Walk routes start from the pub; drive-to and hybrid routes from a
  suggested parking road.
- **General ward routes, no start point.** For people going out on their
  own to cover a ward over time. The ward is split into local areas
  (only to organise the clustering -- no pub lookup), and routes are sized
  by **effort**: a home on a sparse rural lane counts as about six town
  homes (Patriot's rule of thumb: ~40 rural homes take as long as ~250 town
  ones), so the "target size" is in town-home equivalents. Each route is
  either walked (streets) or driven (lanes, delivering both sides in one
  pass), and gets its own suggested start spot. The app and sheets show no
  event start point.

Both types come with **walking directions**: numbered steps that walk each
side of a road once, keeping the road on your left (so UK traffic comes
towards you), with walk-ins routed along real roads. They're in the
published app and, optionally, the "Walking directions" print sheets (at
most two pages -- one double-sided sheet -- per route). See
`js/walkOrder.js` for how the order is worked out.

## Home positions (`data/homes/`)

The sheet's **Residences** column says how many homes each road has (OS
Open UPRN address points matched to the road by leaflet-pipeline), but not
*where along it* they are. Without that, the planner has to assume they're
spread evenly, which is badly wrong for long village and rural roads --
Newport Road in Gnosall has 350 homes on 14.7 km, with nearly half of them
on its busiest tenth and a third of it empty.

`data/homes/<district>.json` records where along each road its homes sit.
When the planner loads a sheet it fetches the file for that district (by
the sheet's "Local Authority District", e.g. `data/homes/stafford.json`)
and uses it to:

- **leave long empty stretches out of routes** -- a road is cut down to its
  stretches with homes (homes no more than 250 m apart, plus 30 m either
  side). Nobody walks or drives the empty bits; they're still in the
  walking network for directions;
- **split long roads, and size rural routes, by where the homes are**
  rather than by length;
- **count part-done roads properly** -- a road marked 40% done no longer
  means "40% of its homes done", but "the homes on the done stretch";
- **give each walking-directions step its real homes.**

The sheet's Residences figure stays the total for every road; the file
only decides where those homes are. **Progress reporting is unaffected:**
when a road has been cut down to its stretches with homes, each kept part
reports the empty bits next to it too, so reporting every part done still
completes the whole row in the tracker.

**No file, or a road not in it?** Everything falls back to the even spread,
exactly as before -- routes are byte-for-byte what they'd have been. Each
entry is tied to its road's geometry, so if the pipeline changes a road's
line, that road quietly falls back until the file is rebuilt, rather than
getting wrong positions.

**Rebuilding it** (about a minute; needs Node 18+ and the OS Open UPRN CSV
that leaflet-pipeline uses, free from the OS Data Hub under the Open
Government Licence):

    node tools/build-homes.js <sheet CSV URL or file> <osopenuprn.csv> data/homes/<district>.json

e.g. with Stafford's published CSV link and `osopenuprn_202605.csv`. It
replays leaflet-pipeline's own matching (drop 150+ UPRNs at one spot as
commercial; each remaining point to its nearest road within 40 m) and also
places homes 40-250 m back from a road (farms, long drives) where they'd
meet it. **Rerun it whenever the pipeline regenerates the district's
sheet.** Marking roads done doesn't need a rerun. Stafford's file is
~340 KB covering ~64,600 of the sheet's ~68,500 homes, and is only
downloaded when someone loads that district in the planner -- the live
tracker never reads it. The file format is documented at the top of
`js/homes.js`.

## Keeping browsers in step (`?v=` on script links)

Every `js/` link in `index.html` and `test.html` ends in `?v=<version>`.
**Bump it -- same value in both files -- whenever anything in `js/`
changes.** GitHub Pages lets browsers reuse a file for up to 10 minutes,
so without it a browser can pair a fresh `app.js` with a stale copy of
another file for a while after a push (seen in testing as
"Pipeline.buildGeneral is not a function"). The app template is always
revalidated.

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
| `js/pubs.js` | Pub lookup: served from `data/pubs.json` when the ward is covered, otherwise live from OpenStreetMap Overpass (and the ward is then queued for caching) |
| `data/pubs.json` | Shared pub cache. The publish backend adds each uncached ward the first time anyone opens it; `node tools/build-pubs-cache.js <wards.csv>` adds or refreshes a whole district |
| `js/pipeline.js` | Orchestrates a full ward build: single-hub, multi-hub, or general (no start point) |
| `js/homes.js` | Where along each road its homes are: builds and reads `data/homes/<district>.json` (see [Home positions](#home-positions-datahomes)) |
| `data/homes/` | Home positions per district, made by `node tools/build-homes.js` |
| `js/mapData.js` | Assembles the final route payload from a clustering result |
| `js/htmlApp.js` | Builds the downloadable/publishable app HTML |
| `js/printSheets.js` | Printable route-sheet generator (browser print/PDF): Classic, or Walking directions (max two pages per route) |
| `js/walkOrder.js` | Walking order for a route: each side of a road walked once, road on your left, walk-ins along real roads |
| `js/routeDirections.js` | Adds walking directions to a built route payload, using every sheet row (plus any `###ROUTE_PLANNER_ONLY_BELOW###` network-only rows) as the walking network |
| `js/directionsMap.js` | Draws walking directions on a Leaflet map; inlined into the published app and the print sheets |
| `js/progressMatch.js` | Works out which step someone is on from an occasional GPS fix (test page's "catch up my progress") |
| `test.html` | Prototype/test bench for walking directions |
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
| [OS Open UPRN](https://www.ordnancesurvey.co.uk/products/os-open-uprn) | [Open Government Licence v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/) | Home positions in `data/homes/`. Contains OS data © Crown copyright and database right 2026 |
