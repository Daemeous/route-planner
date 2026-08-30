// Minimal RFC4180-ish CSV parser (handles quoted fields with embedded
// commas/newlines and doubled-quote escaping) -- used both for the Node
// test harness and, in-browser, as a fallback if a pasted data source is a
// raw CSV rather than JSON.
'use strict';

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(r => r.length > 1 || r[0] !== '').map(r => {
    const obj = {};
    header.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    return obj;
  });
}

if (typeof module !== 'undefined') module.exports = { parseCsv };
