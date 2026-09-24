// Add (or refresh) a whole district in data/pubs.json -- the committed pub
// cache the browser tool reads before falling back to the (slow,
// rate-limited) public Overpass API. The publish backend also appends to
// that file one ward at a time as people open uncached wards; this is for
// covering a district in one go, or refreshing it when it feels stale.
// `git pull` first, since the backend commits to the same file:
//
//   node tools/build-pubs-cache.js <wards.csv> [bufferDeg]
//
// The bbox is the CSV's @lat/@lon extent plus bufferDeg (default 0.05, more
// than bboxOfRoads' 0.02 so any ward's road bbox falls inside it).
'use strict';
const fs = require('fs');
const path = require('path');
const Csv = require('../js/csv');
const Pubs = require('../js/pubs');

async function main() {
  const [csvPath, bufferArg] = process.argv.slice(2);
  if (!csvPath) { console.error('Usage: node tools/build-pubs-cache.js <wards.csv> [bufferDeg]'); process.exit(1); }
  const buffer = bufferArg ? parseFloat(bufferArg) : 0.05;

  const rows = Csv.parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const lats = [], lons = [];
  for (const r of rows) {
    const lat = parseFloat(r['@lat']), lon = parseFloat(r['@lon']);
    if (isFinite(lat) && isFinite(lon)) { lats.push(lat); lons.push(lon); }
  }
  if (!lats.length) throw new Error('No @lat/@lon values found in ' + csvPath);
  const round = x => Math.round(x * 1e6) / 1e6;
  const bbox = [Math.min(...lats) - buffer, Math.min(...lons) - buffer, Math.max(...lats) + buffer, Math.max(...lons) + buffer].map(round);

  console.log('Fetching pubs for bbox', bbox.join(', '), '...');
  const pubs = await Pubs.fetchPubs(bbox, { useCache: false });

  // Merge rather than overwrite: pubs inside the bbox are replaced by the
  // fresh result, coverage the bbox swallows is dropped, the rest is kept.
  const out = path.join(__dirname, '..', 'data', 'pubs.json');
  let cache = { coverage: [], pubs: [] };
  if (fs.existsSync(out)) cache = JSON.parse(fs.readFileSync(out, 'utf8'));
  const inBbox = p => p.lat >= bbox[0] && p.lat <= bbox[2] && p.lon >= bbox[1] && p.lon <= bbox[3];
  const contains = (o, i) => o[0] <= i[0] && o[1] <= i[1] && o[2] >= i[2] && o[3] >= i[3];
  const merged = cache.pubs.filter(p => !inBbox(p)).concat(pubs);
  merged.sort((a, b) => a.name.localeCompare(b.name) || a.lat - b.lat);
  const coverage = cache.coverage.filter(c => !contains(bbox, c.bbox));
  coverage.push({ bbox, fetchedAt: new Date().toISOString().slice(0, 10) });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ coverage, pubs: merged }, null, 1) + '\n');
  console.log(`Wrote ${pubs.length} pubs to ${out}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
