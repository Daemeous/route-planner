// Direct port of pipeline/secret_words.py -- see that file for the full
// rationale. Word bank kept in sync with the Python version.
'use strict';

const SecretWords = (() => {
  const WORD_BANK = {
    A: ['Aston', 'Amber', 'Arbor', 'Alder', 'Anchor', 'Antler', 'Autumn', 'Acorn', 'Atlas', 'Almond', 'Apple', 'Arrow', 'Aspen', 'Auburn', 'Avery', 'Azure', 'Anvil', 'Alpine', 'Ashby', 'Argus'],
    B: ['Bells', 'Birch', 'Blaze', 'Bramble', 'Breeze', 'Bronze', 'Bishop', 'Badger', 'Barrel', 'Beacon', 'Bramley', 'Brook', 'Basil', 'Blossom', 'Brindle', 'Bracken', 'Bantam', 'Bugle', 'Byway', 'Burrow'],
    C: ['Cable', 'Cedar', 'Clover', 'Comet', 'Copper', 'Crest', 'Cobalt', 'Cricket', 'Compass', 'Cinder', 'Cotton', 'Crimson', 'Chestnut', 'Canary', 'Carbon', 'Cavern', 'Cider', 'Cloak', 'Cabin', 'Candle'],
    D: ['Dune', 'Dover', 'Dapple', 'Denim', 'Drift', 'Dexter', 'Dobbin', 'Dahlia', 'Damson', 'Delve', 'Dingle', 'Domino', 'Driftwood', 'Duffle', 'Dusk', 'Dandy', 'Dawson', 'Deacon', 'Dimple', 'Dandelion'],
    E: ['Ember', 'Elm', 'Egret', 'Ebony', 'Elder', 'Endive', 'Everest', 'Emery', 'Ensign', 'Espresso', 'Eave', 'Eider', 'Estuary', 'Eagle', 'Elkhorn', 'Eastwood', 'Elmwood', 'Evergreen', 'Easel', 'Embers'],
    F: ['Ferry', 'Fable', 'Finch', 'Flint', 'Forge', 'Frost', 'Fennel', 'Falcon', 'Foxglove', 'Furrow', 'Feather', 'Fern', 'Filbert', 'Firefly', 'Fizzy', 'Fondue', 'Foxtail', 'Fudge', 'Fumble', 'Fossil'],
    G: ['Gable', 'Ginger', 'Glow', 'Grove', 'Gully', 'Gannet', 'Garnet', 'Gazebo', 'Gecko', 'Glade', 'Goblet', 'Granite', 'Gravel', 'Greenway', 'Griffin', 'Gumdrop', 'Gusto', 'Galaxy', 'Garden', 'Gypsy'],
    H: ['Harbor', 'Hazel', 'Heather', 'Holly', 'Honey', 'Hollow', 'Hamlet', 'Harvest', 'Hawthorn', 'Hedge', 'Helix', 'Hemlock', 'Heron', 'Hickory', 'Hollyhock', 'Homestead', 'Hopper', 'Hornbeam', 'Huckle', 'Hyphen'],
    I: ['Ivy', 'Indigo', 'Ibis', 'Ivory', 'Inkwell', 'Iris', 'Isle', 'Igloo', 'Icicle', 'Ironwood', 'Impala', 'Inlet', 'Islet', 'Iceberg', 'Idyll', 'Ingot', 'Inkspot', 'Isleton', 'Ironbark', 'Ivywood'],
    J: ['Jasper', 'Jade', 'Juniper', 'Jubilee', 'Jigsaw', 'Jester', 'Jenny', 'Jetty', 'Jonquil', 'Jackdaw', 'Jamboree', 'Jelly', 'Jigger', 'Jolly', 'Journey', 'Jumble', 'Jungle', 'Junco', 'Jaunt', 'Jonesy'],
    K: ['Kestrel', 'Kettle', 'Knoll', 'Kelpie', 'Kernel', 'Kingfisher', 'Kayak', 'Kite', 'Kipper', 'Koala', 'Keepsake', 'Keystone'],
    L: ['Larch', 'Lantern', 'Lark', 'Lavender', 'Ledge', 'Linden', 'Lotus', 'Lattice', 'Lichen', 'Lilac', 'Limestone', 'Locket', 'Lookout', 'Longbow'],
    M: ['Maple', 'Marsh', 'Meadow', 'Mint', 'Moss', 'Marigold', 'Mallard', 'Meander', 'Mistletoe', 'Mosaic', 'Muster', 'Magpie', 'Millpond', 'Mulberry'],
    N: ['Nettle', 'Nook', 'Nutmeg', 'Nimbus', 'Narrows', 'Needle', 'Nectar', 'Nutshell', 'Northfield', 'Nightjar'],
    O: ['Oak', 'Otter', 'Ochre', 'Onyx', 'Orchard', 'Osprey', 'Opal', 'Oxbow', 'Owlet', 'Oakleaf'],
    P: ['Pebble', 'Pine', 'Poppy', 'Primrose', 'Pigeon', 'Pantry', 'Parsley', 'Pheasant', 'Pinecone', 'Puffin'],
    Q: ['Quill', 'Quartz', 'Quarry', 'Quaver', 'Quokka', 'Quest', 'Quince', 'Quicksilver', 'Quiver'],
    R: ['Ridge', 'Rowan', 'Robin', 'Rustle', 'Rosewood', 'Ripple', 'Reed', 'Raven', 'Ravine', 'Redwood'],
    S: ['Spruce', 'Sparrow', 'Sage', 'Shale', 'Sorrel', 'Starling', 'Sundew', 'Swallow', 'Silo', 'Spindle'],
    T: ['Thistle', 'Timber', 'Teal', 'Trellis', 'Thicket', 'Toffee', 'Trout', 'Tansy', 'Tundra', 'Turnstile'],
    U: ['Umber', 'Urchin', 'Underhill', 'Upland', 'Utopia', 'Umbra', 'Unity', 'Urban'],
    V: ['Violet', 'Vale', 'Vetch', 'Vine', 'Vireo', 'Velvet', 'Vantage', 'Vellum', 'Verdant', 'Vesper'],
    W: ['Willow', 'Wren', 'Walnut', 'Wisteria', 'Warble', 'Woodlark', 'Wildrose', 'Whistle', 'Wobble', 'Wicker'],
    X: ['Xenia', 'Xylo', 'Xerus', 'Xanthus'],
    Y: ['Yarrow', 'Yew', 'Yonder', 'Yardstick', 'Yeoman', 'Yolk', 'Yodel'],
    Z: ['Zephyr', 'Zinnia', 'Zest', 'Zigzag', 'Zircon', 'Zenith'],
  };

  // Deterministic string-seeded RNG (mulberry32 keyed by a string hash) --
  // mirrors Python's random.Random(seed) in spirit: same seed -> same
  // sequence, stable across rebuilds, no external dependency needed.
  function seededRng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    };
  }

  function assignSecretWords(routeIds, wardName) {
    const rng = seededRng(`leaflet-route-words:${wardName}`);
    const used = new Set();
    const out = {};
    for (const rid of routeIds) {
      const letter = rid[0].toUpperCase();
      const bank = WORD_BANK[letter] || WORD_BANK.A;
      let candidates = bank.filter(w => !used.has(w));
      if (!candidates.length) candidates = bank;
      let word = candidates[Math.floor(rng() * candidates.length)];
      if (used.has(word)) {
        let n = 2;
        while (used.has(`${word}${n}`)) n++;
        word = `${word}${n}`;
      }
      used.add(word);
      out[rid] = word;
    }
    return out;
  }

  return { WORD_BANK, assignSecretWords };
})();

if (typeof module !== 'undefined') module.exports = SecretWords;
