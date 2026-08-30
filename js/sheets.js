// Normalises raw sheet rows (arbitrary header names) into the fixed shape
// graph.js's loadRoads() expects. The known-good schema -- confirmed
// against the live Stafford leafletting-tracker Sheet -- is:
//   Street, @lat, @lon, Ward, Local Authority District, Status,
//   Residences, road_geometry, partial_geometry
// Column matching is header-name based (case/space/punctuation-insensitive)
// with sensible synonyms, so a differently-titled sheet still loads instead
// of hard-failing -- this is meant to work with "any" Google Sheet a user
// points it at, not just this one project's exports.
'use strict';
if (typeof require !== 'undefined' && typeof parseCsv === 'undefined') { global.parseCsv = require('./csv').parseCsv; }

const Sheets = (() => {
  const SYNONYMS = {
    street: ['street', 'road', 'roadname', 'name'],
    lat: ['@lat', 'lat', 'latitude'],
    lon: ['@lon', '@lng', 'lon', 'lng', 'longitude'],
    wardName: ['ward'],
    constituency: ['localauthoritydistrict', 'constituency', 'district', 'lad'],
    status: ['status'],
    residences: ['residences', 'uprns', 'uprncount', 'estimatedresidences'],
    roadGeometry: ['road_geometry', 'roadgeometry', 'geometry'],
    partialGeometry: ['partial_geometry', 'partialgeometry'],
  };

  function normKey(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }

  // Fields that are genuinely optional -- their absence is never reported
  // via `missing` (which the UI treats as fatal-ish). Constituency is a
  // nice-to-have for auto-naming a published page, not required to build
  // routes at all.
  const OPTIONAL_FIELDS = new Set(['constituency']);

  // Returns {street, lat, lon, wardName, status, roadGeometry} plus null
  // entries for anything not found -- caller decides whether that's fatal.
  function detectColumns(headerRow) {
    const normed = headerRow.map(normKey);
    const found = {};
    for (const [field, syns] of Object.entries(SYNONYMS)) {
      const synsNorm = syns.map(normKey);
      let idx = normed.findIndex(h => synsNorm.includes(h));
      if (idx === -1 && field === 'street') idx = 0; // first column is almost always the name in this data family
      found[field] = idx === -1 ? null : headerRow[idx];
    }
    return found;
  }

  // rawRows: array of plain objects keyed by the ORIGINAL header strings
  // (what parseCsv / a Sheets API values.get response, reshaped, gives you).
  // rowIndex = the road's 1-indexed row number in the SOURCE sheet's Data
  // tab (row 2 = the first data row, matching leaflet-map's Apps Script
  // backend's own indexing -- see core.js's `r._rowIdx=i+2`). Required for
  // writing a direct status/partial update or a pending proposal back to
  // that exact row later from the live app.
  function normaliseRows(rawRows, columnMap) {
    return rawRows.map((r, i) => {
      const resRaw = r[columnMap.residences];
      const residences = resRaw === '-' || resRaw === '' || resRaw == null ? 0 : parseInt(resRaw, 10) || 0;
      return {
        rowIndex: i + 2,
        street: r[columnMap.street],
        status: r[columnMap.status],
        residences,
        wardName: r[columnMap.wardName],
        constituency: columnMap.constituency ? r[columnMap.constituency] : null,
        lat: parseFloat(r[columnMap.lat]),
        lon: parseFloat(r[columnMap.lon]),
        roadGeometry: r[columnMap.roadGeometry],
        partialGeometry: columnMap.partialGeometry ? (r[columnMap.partialGeometry] ?? '-') : '-',
      };
    });
  }

  function fromCsvText(csvText) {
    const rawRows = parseCsv(csvText);
    if (!rawRows.length) return { rows: [], wards: [], columnMap: null, missing: ['(empty sheet)'] };
    const headerRow = Object.keys(rawRows[0]);
    const columnMap = detectColumns(headerRow);
    const missing = Object.entries(columnMap).filter(([k, v]) => v === null && !OPTIONAL_FIELDS.has(k)).map(([k]) => k);
    const rows = normaliseRows(rawRows, columnMap);
    const wards = [...new Set(rows.map(r => r.wardName))].filter(Boolean);
    return { rows, wards, columnMap, missing, headerRow };
  }

  function pubCsvUrl(sheetId, gid) {
    return `https://docs.google.com/spreadsheets/d/e/${sheetId}/pub?gid=${gid}&single=true&output=csv`;
  }

  // valuesGrid: array of arrays (row 0 = headers) as returned by the Sheets
  // API's values.get -- used by the "sign in and read any sheet" fallback.
  function fromValuesGrid(valuesGrid) {
    if (!valuesGrid || !valuesGrid.length) return { rows: [], wards: [], columnMap: null, missing: ['(empty sheet)'] };
    const headerRow = valuesGrid[0];
    const rawRows = valuesGrid.slice(1).map(r => {
      const obj = {};
      headerRow.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
    const columnMap = detectColumns(headerRow);
    const missing = Object.entries(columnMap).filter(([k, v]) => v === null && !OPTIONAL_FIELDS.has(k)).map(([k]) => k);
    const rows = normaliseRows(rawRows, columnMap);
    const wards = [...new Set(rows.map(r => r.wardName))].filter(Boolean);
    return { rows, wards, columnMap, missing, headerRow };
  }

  return { detectColumns, normaliseRows, fromCsvText, fromValuesGrid, pubCsvUrl, SYNONYMS };
})();

if (typeof module !== 'undefined') module.exports = Sheets;
