// Parses whatever a non-technical user pastes when looking up a start
// point's coordinates by hand (the Overpass pub lookup can be slow or
// down, so "just Google it" is the documented fallback -- see index.html).
// Handles Google's AI Overview answer format verbatim, and a plain pair of
// numbers in any layout/separator.
'use strict';

const Coords = (() => {
  // Google's AI Overview typically answers a "<place> latitude longitude"
  // search with text shaped like:
  //   Latitude: 52.807943 (52° 48' 28.6" N)
  //   Longitude: -2.100236 (2° 06' 00.8" W)
  // (sometimes on one line, sometimes two -- both handled since this
  // doesn't anchor to line boundaries).
  function parseLabelled(text) {
    const latMatch = text.match(/lat(?:itude)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    const lonMatch = text.match(/lon(?:g(?:itude)?)?\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i);
    if (!latMatch || !lonMatch) return null;
    return { lat: parseFloat(latMatch[1]), lon: parseFloat(lonMatch[1]) };
  }

  // Fallback: just pull out the first two decimal-or-integer numbers,
  // whatever separates them (comma, space, semicolon, a stray tab from a
  // pasted spreadsheet cell, N/S/E/W suffixes, anything).
  function parseTwoNumbers(text) {
    const nums = text.match(/-?\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 2) return null;
    return { lat: parseFloat(nums[0]), lon: parseFloat(nums[1]) };
  }

  // Returns {lat, lon} or null if nothing usable was found. Does NOT
  // sanity-check the values against a ward -- see fixSignIfOutOfBounds.
  function parseCoordinatePaste(text) {
    if (!text || !text.trim()) return null;
    return parseLabelled(text) || parseTwoNumbers(text);
  }

  // A pasted or retyped coordinate that's dropped its minus sign is a
  // known recurring problem (copy-paste from some sources silently strips
  // it, or someone retypes it by hand and misses it) -- for a UK ward
  // that turns a nearby pub into a point out in mainland Europe, which
  // silently makes every route a long "drive" route instead of erroring
  // outright. Since the ward's own road data gives a reliable expected
  // bounding box, a point wildly outside it -- where flipping one or
  // both signs would bring it back in range -- is corrected automatically
  // rather than left to quietly produce nonsense routes.
  //
  // bounds: {lonMin, lonMax, latMin, latMax} (see mapData.js's boundsOf).
  // Returns {lat, lon, corrected: bool, note: string|null}.
  function fixSignIfOutOfBounds(point, bounds, marginDeg = 0.5) {
    const { lat, lon } = point;
    const inBounds = (la, lo) =>
      la >= bounds.latMin - marginDeg && la <= bounds.latMax + marginDeg &&
      lo >= bounds.lonMin - marginDeg && lo <= bounds.lonMax + marginDeg;

    if (inBounds(lat, lon)) return { lat, lon, corrected: false, note: null };

    const candidates = [
      { lat: -lat, lon, flip: 'latitude' },
      { lat, lon: -lon, flip: 'longitude' },
      { lat: -lat, lon: -lon, flip: 'latitude and longitude' },
    ];
    for (const c of candidates) {
      if (inBounds(c.lat, c.lon)) {
        return {
          lat: c.lat, lon: c.lon, corrected: true,
          note: `That point looked to be nowhere near this ward -- flipped the sign of the ${c.flip} to bring it back in range. Double check the pin lands where you expect.`,
        };
      }
    }
    return { lat, lon, corrected: false, note: null };
  }

  return { parseCoordinatePaste, fixSignIfOutOfBounds };
})();

if (typeof module !== 'undefined') module.exports = Coords;
