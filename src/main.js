/*
 * main.js — province map viewer.
 *
 * TWO SOURCES OF TRUTH, and they never overlap:
 *   provinces.png   SHAPE and NEIGHBOURS. Every province is one flat RGB colour.
 *   provinces.json  DATA — name, owner, terrain — keyed by that same colour.
 *
 * Nothing anywhere keeps a hand-written neighbour list. Adjacency is read out of
 * the pixels at load, so redrawing the bitmap updates the map's topology by
 * itself and cannot fall out of step with the data.
 *
 * WHAT HAPPENS, IN ORDER:
 *   1. load      JSON and PNG fetched, colours normalised                 (§1)
 *   2. build     pixels -> province per pixel -> adjacency, coasts, bounds (§2)
 *   3. labels    one name placed per contiguous block of territory        (§4)
 *   4. loop      render buffer -> blit through the view -> draw labels    (§3, §5, §6)
 *
 * Steps 1-3 run once, at boot. Only step 4 repeats.
 *
 * DRAWING IS IN TWO STAGES, which is what keeps panning smooth:
 *   painting   the map is drawn at map resolution into offscreen canvases, and
 *              only when a COLOUR changes. A new map mode repaints everything;
 *              a selection or a hover repaints just the provinces involved.
 *   blitting   drawView() puts the result on screen through the pan/zoom
 *              transform. Cheap, and all a pan or zoom actually needs.
 * The dirty flags in §6 decide which of them runs on any given frame.
 *
 * At map sizes in the millions of pixels, "the offscreen canvas" is really a
 * grid of tiles plus a small whole-map overview — see §3, which explains why.
 *
 * COORDINATES: "map pixels" are positions in the bitmap; "screen pixels" are CSS
 * pixels on the canvas. A map pixel (mx,my) lands at (mx*scale + x, my*scale + y).
 * Anything sized in map pixels grows as you zoom; anything in screen pixels does
 * not. Which one a value is in is noted wherever it is not obvious.
 */

// Imported dynamically, carrying forward the ?v= token index.html loaded this
// file with. A static import would resolve to an unversioned URL and could come
// straight from cache while this file was freshly fetched — leaving half the
// program old and half new, which is a genuinely baffling thing to debug.
const VERSION = new URL(import.meta.url).search;

const {
  OCEAN, LABEL_HIST_BUCKET, CHAMFER_ORTH, controllerOf, frontierKeyOf,
  toRgb, normaliseTable, buildWorld, buildBorderDistance, computeLabelGeometry,
  indexProvinces, attachBlockMembers, addRealmBlocks,
  normaliseSeaTable, buildSeaWorld, indexSea,
  normaliseCountyTable, buildCountyWorld, indexCounties,
  normaliseSubTable, buildSubWorld, indexSubs,
  setIslandBlocks, computeBlockGeometry,
} = await import(`./mapdata.js${VERSION}`);
const { CACHE_FILE, hashInputs, unpackCache, worldFromCache, seaFromCache, countiesFromCache, subsFromCache } = await import(`./mapcache.js${VERSION}`);
const { setOwners } = await import(`./ownership.js${VERSION}`);
const {
  mapLatAt, mapLonAt, solarDeclination, subsolarLongitude, localHours, sinSolarElevation,
} = await import(`./geo.js${VERSION}`);

// ============================================================ 1. data loading

// Map data changes constantly while drawing, and a stale cache looks exactly
// like a bug in the code. Always fetch fresh.
const noCache = (url) => `${url}?t=${Date.now()}`;

async function loadJSON(url, optional = false) {
  const res = await fetch(noCache(url), { cache: 'no-store' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`could not load ${url} (${res.status})`);
  }
  return res.json();
}

/** Raw bytes, or null if there is no such file. Used for optional data. */
async function loadBytes(url, optional = false) {
  const res = await fetch(noCache(url), { cache: 'no-store' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`could not load ${url} (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The precomputed map, if there is one and it still matches its inputs.
 *
 * Returns null for every kind of miss — no file, an old format, a hash from a
 * bitmap since redrawn — and the caller then derives everything itself. The
 * cache is only ever allowed to make loading faster, never to decide what the
 * map is.
 */
async function loadCache(bytes, expectedHash) {
  if (!bytes) return null;
  if (typeof DecompressionStream !== 'function') return null;   // older browser
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const cache = unpackCache(new Uint8Array(await new Response(stream).arrayBuffer()));
    if (!cache) return null;
    if (cache.meta.hash !== expectedHash) {
      console.info('map-cache.bin is out of date and was ignored. Rebuild it with: node sync-provinces.js --cache');
      return null;
    }
    return cache;
  } catch (err) {
    console.warn('map-cache.bin could not be read; computing from the bitmap instead.', err);
    return null;
  }
}

/**
 * Read the bitmap's pixels exactly as authored.
 *
 * A PNG carrying an sRGB/ICC chunk is colour-managed into the display profile
 * on decode, nudging channels by a point or two. White never moves and pastels
 * barely do, but a saturated colour shifts enough to stop matching the JSON —
 * and that province then silently reads as ocean. This turns that off.
 */
async function loadPixels(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none' });

  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return ctx.getImageData(0, 0, c.width, c.height, { colorSpace: 'srgb' });
}

/**
 * Loads the satellite imagery, or null if there is none.
 *
 * Kept as an ImageBitmap rather than decoded into a pixel array: it is only ever
 * blitted underneath the province colours, never inspected, so it can live on
 * the GPU. Decoding it would add another 60MB to the JavaScript heap for nothing.
 *
 * A missing file is not an error — the map works without it, and the toolbar
 * simply disables the button.
 */
async function loadBitmap(url) {
  try {
    const res = await fetch(noCache(url), { cache: 'no-store' });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' });
  } catch {
    console.warn(`${url} could not be loaded; continuing without it.`);
    return null;
  }
}


// ============================================================= 2. world model

const UNKNOWN_POLITY = { id: '?', name: 'Unknown', colour: [90, 90, 96] };

// The model itself is built in mapdata.js, which the build script shares.


// ================================================================ 3. rendering
//
// Everything here paints into the OFFSCREEN buffer, at map resolution and with
// no notion of pan or zoom. Putting it on screen is §5's job.

// The shape of the ground, in four tiers. Alpine is the high mountain above the
// tree line: bare rock and snow, so it reads paler and colder than the mountains
// below it. It is not painted in terrain.png; counties.js carries it down from
// the province tag.
const TERRAIN_COLOURS = Object.fromEntries(Object.entries({
  Plains: '#7c945c',
  Hills: '#968454',
  Mountains: '#808086',
  Alpine: '#aeb3bd',
}).map(([k, v]) => [k, toRgb(v)]));

// And what falls on it. These used to be three tags mixed in among the terrain —
// Desert, Jungle and Arctic — carried in the same list and averaged the same way.
// The province table now names the Köppen group the ground actually is, all
// twelve of them, so the map can say subarctic where it used to say cold.
//
// Kept in the register the three of them set rather than the published Köppen
// palette, which is a legend and reads like one: this is a landscape map, and
// scarlet and violet countryside would say nothing about what it is like to
// stand there. The three that had a colour keep it.
const CLIMATE_COLOURS = Object.fromEntries(Object.entries({
  'Ice cap': '#ced8e0',            // was Arctic
  Tundra: '#b9c3c4',
  Subarctic: '#6e8a72',
  'Humid continental': '#8aa165',
  Oceanic: '#7fa679',
  Mediterranean: '#a8a765',
  'Humid subtropical': '#789a5e',
  Monsoon: '#5f8f57',
  Rainforest: '#487a4a',           // was Jungle
  Savanna: '#b3a869',
  Steppe: '#c0b57e',
  Desert: '#ceb876',               // unchanged
}).map(([k, v]) => [k, toRgb(v)]));

/** The mean of a list of colours, or null when the list is empty. */
const meanColour = (cols) => (cols.length
  ? [0, 1, 2].map((c) => cols.reduce((s, q) => s + q[c], 0) / cols.length)
  : null);

// Water only. There is no impassable ground: the hardest land is Alpine, which
// is crossed slowly and at a cost rather than refused. An ice shelf is refused,
// because a ship that meets one is aground.
const IMPASSABLE = 'Impassable';
const IMPASSABLE_COLOUR = toRgb('#23262c');
const IMPASSABLE_MIX = 0.45;    // how far toward that near-black the water is pulled

// Where each resource sits on data/icons/resources.png. The sheet is six cells
// across and three down at 64px a cell, filled left to right and top to bottom,
// so the number here is the cell and the row and column fall out of it.
const RESOURCE_ICON = {
  fertileLand: 0, coal: 1, timber: 2, iron: 3, fish: 4, textiles: 5,
  oil: 6, baseMetals: 7, copper: 8, aluminium: 9, naturalGas: 10, rareMetals: 11,
  rubber: 12, gold: 13, nitrates: 14, tungsten: 15, tazkuri: 16, uranium: 17,
};

// What a resource is called. Only the layer hover uses this; the icon says
// which one it is at a glance and this is for when a glance is not enough.
const RESOURCE_NAME = {
  fertileLand: 'Fertile land', coal: 'Coal', timber: 'Timber', iron: 'Iron',
  fish: 'Fish', textiles: 'Textiles', oil: 'Oil', baseMetals: 'Base metals',
  copper: 'Copper', aluminium: 'Aluminium', naturalGas: 'Natural gas',
  rareMetals: 'Rare metals', rubber: 'Rubber', gold: 'Gold', nitrates: 'Nitrates',
  tungsten: 'Tungsten', tazkuri: 'Tazkuri', uranium: 'Uranium',
};

const RESOURCE_SHEET_COLS = 6;
const RESOURCE_SHEET_CELL = 64;

// What a row says when there is no sheet to draw from. loadBitmap returns null
// on a miss and the rest of the map carries on, so this does too.
const RESOURCE_MARK = {
  fertileLand: 'Food', timber: 'Wood', fish: 'Fish', textiles: 'Cloth',
  rubber: 'Rubber', coal: 'Coal', oil: 'Oil', naturalGas: 'Gas', iron: 'Iron',
  copper: 'Copper', aluminium: 'Alum', baseMetals: 'Base', rareMetals: 'Rare',
  tungsten: 'Tungsten', gold: 'Gold', nitrates: 'Nitre', uranium: 'Uranium',
  tazkuri: 'Tazkuri',
};

// A province has to be at least this many pixels across on screen before its
// figures are drawn. Below it the writing is unreadable and there is a lot of
// it: fifteen hundred provinces of stacked text at world zoom is a grey smear
// and a slow frame.
const RESOURCE_LINE = 8.5;      // css pixels per line, before zoom
const RESOURCE_OVERHANG = 0.5;  // how much of a line may hang past the province
// How big an icon is drawn when the text is at its ceiling, and in proportion
// below that. Larger than the letters beside it, because a word is read and an
// icon is recognised, and recognition wants the shape.
const RESOURCE_ICON_PX = 15;
// How much larger the selected province writes its stack. Picking a province is
// asking about that one, so its figures come forward and the rest stay as they
// were.
const RESOURCE_SELECTED = 1.6;
const RESOURCE_MIN_LINE = 6;
const RESOURCE_MAX_LINE = 13;


// A province whose owner is not in the polity table still has to draw as
// something, so it falls back to a neutral grey rather than crashing the repaint.
const polityOf = (w, p) => w.table.polityById.get(controllerOf(p)) || UNKNOWN_POLITY;

// The five map modes. Each is just "province -> base [r,g,b]"; highlighting,
// borders and everything else is applied on top by the shade table.
const MODES = {
  political: (w, p) => polityOf(w, p).colour,
  province: (w, p) => p.colour,
  // Landscape tags average together, so Alpine + Tundra reads as snowfield
  // rather than as either one. All four landforms average alike; none of them
  // is a property sitting on top of another.
  // The county map. Every county takes its own colour in paintTileRegion, which
  // is a level below anything this table knows about, so what it answers here is
  // only what shows through: the sea, and any land the county bitmap does not
  // cover. The political colour is the right thing for that.
  county: (w, p) => polityOf(w, p).colour,

  // The naval chart. Land is pushed back to a flat slate so that the water,
  // which is the subject here, carries every distinction on the screen. The sea
  // itself is coloured per region in paintTileRegion rather than through this
  // table, which is indexed by province and knows nothing about water.
  navy: () => NAVY_LAND,

  // The resource map. Every province keeps its political colour, because what
  // is being read here is the writing over it and the ground only has to say
  // whose it is. The figures are drawn in drawResources, a level above this.
  resources: (w, p) => polityOf(w, p).colour,
  terrain: (w, p) => {
    // Ground and climate weigh the same, whatever number of each a province has.
    // Averaging all the tags together in one list would let a province that is
    // subarctic AND humid continental outvote the mountains it is made of.
    // Alpine is one of the four landforms and averages with the rest.
    const land = meanColour(p.terrain.map((t) => TERRAIN_COLOURS[t]).filter(Boolean));
    const air = meanColour(p.climate.map((k) => CLIMATE_COLOURS[k]).filter(Boolean));
    const base = land && air
      ? [0, 1, 2].map((c) => (land[c] + air[c]) / 2)
      : land || air || [120, 120, 120];
    return base.map(Math.round);
  },
};

// The county map.
//
// Colours in counties.json are spread by a hash so that neighbours are far apart
// in hue, which is what the generator wanted: a mistake shows as a patch of the
// wrong colour instead of hiding in a gradient. That is right for checking the
// output and wrong for looking at, so they are muted here toward a common grey
// and lightened, which leaves every county distinguishable from the ones around
// it without the map reading as confetti.
const COUNTY_MIX = 0.45;           // how far a county moves toward the wash
const COUNTY_WASH = [214, 208, 196];
const COUNTY_EDGE = 0.82;          // the line between two counties of one province
const COUNTY_PROVINCE = 0.34;      // and the province border over the top of them

// The sea's own palette, used only by the Navy mode.
//
// Region colours in sea.json are whatever was convenient to paint sea.png with,
// and reading them raw gives a chart in ninety-three unrelated hues, half of
// them the colour of farmland. Mixing them all toward one blue fixes that and
// costs the thing the colours were for, which is telling one region from the
// next.
//
// So only the hue is kept, and it is compressed into an arc that reads as
// water: teal through blue to indigo for the sea, and a green arc for lakes,
// which is fresh water told from salt without a legend. Saturation and
// lightness are then fixed, so nothing comes out pale or muddy, with a little
// of the original lightness left in as a second axis of separation for two
// regions that landed on the same hue.
const NAVY_LAND = [64, 68, 76];

// How far a subregion's shade may wander from its region's, and how much
// darker its own borders are drawn. The region border stays NAVY_EDGE, which
// is darker still, so the two levels are told apart by weight rather than by
// colour — the same way a province border reads over the county map.
const NAVY_SUB_SPREAD = 0.13;
const NAVY_SUB_EDGE = 0.86;
const NAVY_SEA_ARC = [170, 264];   // degrees: cyan, through blue, to violet
const NAVY_LAKE_ARC = [92, 158];   // and the arc a lake may take: green to teal
const NAVY_SAT = 0.46;
const NAVY_LIGHT = 0.33;
const NAVY_LAKE_LIGHT = 0.40;
const NAVY_LIGHT_SPREAD = 0.13;    // how much of the source lightness survives
const NAVY_EDGE = 0.58;            // the line between two sea regions, as a multiplier
const NAVY_LIGHTEN = { selected: 0.26, hovered: 0.12 };

// Border darkness, as a multiplier on the province's own colour. Subdivisions
// inside one country stay quiet; national borders and coastlines read strongly.
const BORDER_INTERNAL = 0.85;   // neighbour has the same owner
const BORDER_NATIONAL = 0.42;   // neighbour has a different owner, or is open sea

// How far each highlight state mixes its province toward white. A proportional
// mix, not a flat addition: adding a fixed amount would push an already-bright
// channel past 255 on a pale province, clipping it and shifting the hue as it
// brightens. Mixing lifts every channel by the same share of its own headroom.
const LIGHTEN = { selected: 0.10, neighbour: 0.04, hovered: 0.04 };

// Compositing over the satellite imagery. The province layer is drawn with a
// PER-PIXEL alpha, not one opacity for the whole layer, so that a country's
// colour is emphatic along its frontier and falls away inland — leaving the
// terrain to read through the middle of a large country while its shape stays
// unmistakable. Fading the layer uniformly would instead wash out the borders
// along with everything else, and the borders are what has to stay legible.
const SATELLITE_NATIONAL = 0.88;  // the drawn frontier line itself
const SATELLITE_INTERNAL = 0.22;  // province subdivisions, on top of the local fill alpha
const SATELLITE_RIM = 0.82;       // country colour hard against a national border
const SATELLITE_CORE = 0.36;      // country colour deep inland
const FADE_PX = 24;               // how far inward the colour reaches, in map pixels
const FADE_CURVE = 0.8;           // < 1 concentrates the falloff near the border

// The fade above is a political-map device: it exists to make a COUNTRY's shape
// read at a glance. The other modes answer different questions — which province
// is this, what terrain is it — and a fade only makes their fills mottled and
// their centres illegible. They use one flat opacity and no pastel wash.
const SATELLITE_FLAT = 0.84;

// Inland, the colour is not merely thinner but softer: it is washed toward a
// pale neutral before being laid over the terrain. Thinning alone leaves the
// interior reading as a dim version of the border colour rather than as a
// distinct pastel field, which is the look this is after.
const PASTEL_MIX = 0.55;
const PASTEL_TOWARD = [226, 231, 238];

// Highlighted provinces are pushed back towards opaque, or the fade would leave
// a selection deep inside a country too faint to make out.
const SATELLITE_LIFT = { selected: 0.5, neighbour: 0.32, hovered: 0.22 };

// How long a dropped selection takes to fade away. Short enough to feel like
// part of the click rather than an animation waiting to finish.
const DESELECT_FADE_MS = 60;

// The ring drawn around the selected province. Its width is in SCREEN pixels, so
// buildOutline() rebuilds it whenever the zoom changes. See §4 for how.
const OUTLINE_COLOUR = '#cea35eff';

// The county ring, cool against the province ring’s gold. The two mean
// different things and are held at the same time, so they must not be told
// apart only by which is on top.
const COUNTY_RING_COLOUR = '#e6eef7ff';
const COUNTY_RING_ALPHA = 0.85;
const OUTLINE_WIDTH = 2.5;
const OUTLINE_MAX_PIXELS = 4e6;     // ceiling on the offscreen canvas the ring is built in

/* ------------------------------------------------------------ the buffer
 *
 * The painted map is not one canvas but a grid of TILE-sized ones, plus a small
 * downscaled copy of the whole thing. Both exist for the same reason: a single
 * 6000x2650 canvas is 64MB, and touching any part of it costs as if you had
 * touched all of it.
 *
 *   tiles     Full resolution, in chunks. A repaint uploads only the chunks it
 *             overlaps rather than a 64MB texture, and drawing uses only the
 *             chunks on screen. Used from OVERVIEW threshold upwards.
 *   overview  The entire map at whatever fits in OVERVIEW_MAX. Zoomed out, the
 *             whole map is on screen, so tiles would mean rescaling all 15.9
 *             million pixels every frame; this holds around a tenth of that and
 *             is never shown larger than its own resolution, so nothing is lost.
 *
 * A repaint keeps both in step: tiles first, then the same rectangle is copied
 * down into the overview.
 */
const TILE = 512;             // chunk edge, in map pixels
// Longest edge of the zoomed-out copy.
//
// This decides the zoom at which the renderer stops using the overview and
// starts reading full-resolution tiles, and getting it wrong is expensive in
// one direction only. Just above the threshold the whole visible map is drawn
// tile by tile: at 0.42 on a 1600x895 canvas that is 45 tiles, 10.5M source
// pixels downscaled with smoothing into a canvas holding 1.4M. Seven times more
// source than the destination can show, every frame.
//
// At 3072 the overview covers zooms up to 0.51 instead of 0.34, which is the
// band a whole continent is looked at in. It costs 3070 x 1356, about 17MB
// beside the 64MB the tiles already hold.
const OVERVIEW_MAX = 3072;

// How far past its own scale the overview may be stretched before the tiles are
// worth their cost. Above 1 it is being drawn larger than it was rendered, which
// softens it, and the alternative at that zoom is reading several times the
// canvas in source pixels. A quarter over is not visible on a map whose borders
// are already below one screen pixel wide at these zooms.
const OVERVIEW_STRETCH = 1.25;

/** Whether the overview is the cheaper source at this scale. */
// False before the overview is assembled, so nothing can cover anything yet.
const overviewCovers = (s) => !!overview && s <= overview.scale * OVERVIEW_STRETCH;

let tiles = null;             // { cols, rows, list: [{ x, y, w, h, canvas, ctx }] }
let overview = null;          // { canvas, ctx, scale }
let scratch = null;           // one reusable TILE x TILE ImageData, shared by every tile
let scratchCanvas = null;     // and a canvas of the same size, for compositing over imagery
let scratchCtx = null;
/* Window-sized offscreen layers, kept between frames and handed back cleared.
 *
 * The night layer needs two of them at once and both are the size of the
 * window, so they are held rather than made: allocating and throwing away a
 * canvas of several million pixels sixty times a second is not something to do.
 * Keyed by name so that adding a third later cannot accidentally share one.
 */
const scratchLayers = new Map();

function viewportLayer(name, cssW, cssH, scale = 1) {
  const pw = Math.max(1, Math.round(cssW * pixelRatio * scale));
  const ph = Math.max(1, Math.round(cssH * pixelRatio * scale));

  let layer = scratchLayers.get(name);
  if (!layer) {
    const canvas = document.createElement('canvas');
    layer = { canvas, ctx: canvas.getContext('2d'), w: 0, h: 0 };
    scratchLayers.set(name, layer);
  }

  // Resized only when the window has actually changed. Assigning to width or
  // height clears the canvas whatever the value, so doing it unconditionally
  // would be a second full clear on top of the one below.
  if (layer.canvas.width !== pw || layer.canvas.height !== ph) {
    layer.canvas.width = pw;
    layer.canvas.height = ph;
  }
  layer.w = pw;
  layer.h = ph;

  layer.ctx.setTransform(pixelRatio * scale, 0, 0, pixelRatio * scale, 0, 0);
  layer.ctx.globalCompositeOperation = 'source-over';
  layer.ctx.clearRect(0, 0, cssW, cssH);
  return layer;
}

// ------------------------------------------------------------- day and night
//
// The terminator is a LAYER, drawn over the finished map every frame. It was
// baked into the tiles while the sun stood still, which cost nothing per frame
// and was affordable only because nothing ever invalidated it. The clock moves
// the sun 5 degrees a tick and 30 ticks a second at the fastest speed, and
// rebaking 15.9 million pixels for each of those is not a thing that can be
// done at all — a single full repaint is around 250ms.
//
// The mask is held at an eighth of map scale. The terminator is a smooth curve
// hundreds of pixels wide at its softest, so 750 by 332 carries it with room to
// spare, and the twilight gradient hides the interpolation on the way back up.
//
// THE MASK DOES NOT MOVE WITH THE HOUR, which is what makes this cheap. Read
// the identity in geo.js: longitude enters it only as cos(lon - subsolar), and
// longitude is linear in x on an equirectangular map, so changing the hour
// SLIDES the whole pattern sideways without altering its shape. Only the
// declination term changes it, and that is a function of the day. So the mask
// is built once per day and the hour is a horizontal offset applied when it is
// drawn — a blit rather than a quarter of a million pixels of trigonometry
// thirty times a second.

const NIGHT_MASK_SCALE = 1 / 8;

// Resolution the city lights are composited at, as a fraction of the window.
// The lights are small blurred glows and the cut between them and the night side
// is a soft gradient, so neither carries detail that survives being drawn at
// full resolution. Halving it quarters the pixels in the four window-sized
// operations the light pass costs.
const NIGHT_LIGHT_SCALE = 0.5;

// Longest the terminator may go without being redrawn, in real milliseconds.
// The sun moves 5 degrees a tick and the clock runs up to 30 ticks a second, and
// redrawing a soft gradient thirty times a second is work nobody can see. At 15
// it still slides smoothly.
const NIGHT_MIN_MS = 66;
let nightDrawnAt = 0;
const NIGHT_DAY_START = Math.sin((6 * Math.PI) / 180);    // full daylight above this elevation
const NIGHT_FULL_DARK = Math.sin((-12 * Math.PI) / 180);  // and full night below this one

// Where the sun is. Day 161 of 1926 at 00:00 UTC is the start date, 10
// Ungerbruni, eleven days short of the solstice, so the sun is at +23.0 degrees
// and the far north is in midnight sun.
//
// Both are driven by the clock, which writes them on every tick it advances.
// They are also what `game.setSun()` sets from the console, and tick 0
// reproduces exactly the fixed sky the map had before the clock existed.
let sunDayOfYear = 161;
let sunUtcHour = 0;

/**
 * How far east the mask has slid, in map pixels, for the current hour.
 *
 * The mask is built with the sun over the map's centre, so this is the whole
 * of the difference between that and where the sun actually is. Wrapped into
 * one map width, since the pattern repeats with exactly that period.
 */
function sunShiftPx(world) {
  const lon = subsolarLongitude(sunUtcHour, world.width);
  const px = (lon * world.width) / (Math.PI * 2);
  return ((px % world.width) + world.width) % world.width;
}

// How hard the night reads, per map mode. The satellite view wants the real
// thing. The political map is carrying country colours that a heavy wash would
// bury, so it takes about half, which is enough to see where the line falls
// without losing which country is which.
const NIGHT_DARKEN = { political: 0.28, province: 0.31, terrain: 0.33, default: 0.32 };
const NIGHT_LIGHTS = { political: 0.55, province: 0.75, terrain: 0.75, default: 0.8 };
const nightStrength = (table) => table[state.mode] ?? table.default;

/* The mask, its pixel buffer, and the trigonometry that depends only on the
 * map. Held across rebuilds rather than made fresh each time.
 *
 * This is rebuilt once per GAME DAY, which at the fastest speed is every 2.4
 * seconds. Allocating a canvas and an ImageData each time discarded about 2MB
 * on each rebuild — some 48MB a minute — and a detached canvas keeps its
 * backing store outside the JavaScript heap, where the collector feels little
 * pressure from it and is in no hurry to reclaim it. The page therefore grew
 * steadily heavier the longer the clock ran, which is exactly the shape of
 * "it gets laggier the further time goes".
 */
let nightMask = null;

/**
 * Black, with the alpha of each pixel being how much night it is.
 *
 * Drawn over the map it darkens the night side; used as a `destination-in` mask
 * it cuts anything down to the night side. Both are wanted, so it is built once
 * and used twice.
 */
function buildNightMask(world, dayOfYear) {
  const w = Math.ceil(world.width * NIGHT_MASK_SCALE);
  const h = Math.ceil(world.height * NIGHT_MASK_SCALE);

  // Built once and kept. Everything below depends only on the map, not on the
  // day: the cosine of each column's longitude and the sine and cosine of each
  // row's latitude are the same on every date there will ever be.
  // One column of BLEED at each end, holding the column from the opposite edge.
  //
  // The mask is drawn at eight times its own size and the map wraps, so two
  // copies of it meet on screen. Sampling clamps at the edge of the source
  // rectangle, which at an eight times upscale holds the gradient flat for the
  // last few map pixels of each copy. Two copies meeting put two of those flat
  // bands side by side, and a terminator that is a smooth gradient everywhere
  // else shows the join as a line. The mask is periodic in longitude, so the
  // column beyond each edge is the column at the other edge, and with it there
  // the sampler always has somewhere to read.
  const cw = w + 2;

  if (!nightMask || nightMask.canvas.width !== cw || nightMask.canvas.height !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    const cosLon = new Float64Array(w);
    for (let x = 0; x < w; x++) cosLon[x] = Math.cos(mapLonAt(x / NIGHT_MASK_SCALE, world.width));

    const sinLat = new Float64Array(h);
    const cosLat = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      const lat = mapLatAt(y / NIGHT_MASK_SCALE);
      sinLat[y] = Math.sin(lat);
      cosLat[y] = Math.cos(lat);
    }

    nightMask = {
      canvas, ctx, img: ctx.createImageData(cw, h),
      cosLon, sinLat, cosLat, bleed: 1, period: w,
      scale: NIGHT_MASK_SCALE, dayOfYear: null,
      strip: null, stripCtx: null, reps: 0, stripDay: null,
    };
  }

  const { img, cosLon, sinLat, cosLat } = nightMask;
  const data = img.data;
  const dec = solarDeclination(dayOfYear);
  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  const span = NIGHT_DAY_START - NIGHT_FULL_DARK;

  // Only the ALPHA channel is written, here and anywhere else. The mask is
  // black throughout at varying opacity, so red, green and blue keep the zero
  // they were allocated with — which stays true across reuse precisely because
  // nothing ever touches them.
  for (let y = 0; y < h; y++) {
    const a = sinLat[y] * sinDec;
    const b = cosLat[y] * cosDec;
    const row = y * cw;
    let o = (row + 1) * 4 + 3;                                // column 0 is bleed
    for (let x = 0; x < w; x++, o += 4) {
      let t = (a + b * cosLon[x] - NIGHT_FULL_DARK) / span;   // 0 night, 1 day
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = t * t * (3 - 2 * t);                                // ease the twilight band
      data[o] = Math.round(255 * (1 - t));
    }
    // The two bleed columns, each copied from the far edge.
    data[row * 4 + 3] = data[(row + w) * 4 + 3];
    data[(row + cw - 1) * 4 + 3] = data[(row + 1) * 4 + 3];
  }

  nightMask.ctx.putImageData(img, 0, 0);
  nightMask.dayOfYear = dayOfYear;
  perf.maskBuilds++;
  return nightMask;
}

/** Builds the tile grid and the overview. Once per world. */
function buildTiles(world) {
  const cols = Math.ceil(world.width / TILE);
  const rows = Math.ceil(world.height / TILE);
  const list = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x = tx * TILE, y = ty * TILE;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(TILE, world.width - x);      // edge tiles are short
      canvas.height = Math.min(TILE, world.height - y);
      list.push({ x, y, w: canvas.width, h: canvas.height, canvas, ctx: canvas.getContext('2d') });
    }
  }
  tiles = { cols, rows, list };
  scratch = list[0].ctx.createImageData(TILE, TILE);
  scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = TILE;
  scratchCanvas.height = TILE;
  scratchCtx = scratchCanvas.getContext('2d');

  // The overview is assembled tile by tile, so its scale is chosen to make one
  // tile land on a WHOLE number of overview pixels. At an arbitrary scale a tile
  // edge falls mid-pixel, that copy's edge is antialiased against empty canvas,
  // and the partly transparent result shows the page through as a grid of seams
  // — which is then plainly visible zoomed out. Snapping the scale so tile
  // boundaries are integers makes the copies abut exactly.
  const wanted = Math.min(1, OVERVIEW_MAX / Math.max(world.width, world.height));
  const tileDest = Math.max(1, Math.round(TILE * wanted));
  const scale = tileDest / TILE;

  // CEIL, not round.
  //
  // drawMapLayer asks for the source rectangle [0, world.width * scale], and that
  // figure is fractional for most scales. Round it down and the rectangle is
  // wider than the canvas holding it, so the last fraction of a pixel is drawn
  // from outside the image, which is transparent. The page background then shows
  // through as a hairline down the join between two drawn copies of the map,
  // over open ocean as much as over land.
  //
  // At an OVERVIEW_MAX of 2048 the figure was 2050.78 and rounded up, so the
  // rectangle happened to fit and nothing showed. At 3072 it is 3070.3125 and
  // rounds down. The scale is what changed, not the rule, which is why one extra
  // row and column had never been needed before.
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(world.width * scale));
  canvas.height = Math.max(1, Math.ceil(world.height * scale));
  overview = { canvas, ctx: canvas.getContext('2d'), scale };

  // A floor of ocean, laid once. The overview is assembled chunk by chunk and
  // each copy lands on fractional coordinates, so a sub-pixel sliver can escape
  // between two of them; with this under it that sliver shows sea rather than the
  // page. It used to be repainted before every full pass, which is no longer
  // possible now that a pass is spread over frames: clearing it at the start
  // would blank the minimap and fill it in again while the player watched.
  overview.ctx.fillStyle = `rgb(${world.table.oceanColour})`;
  overview.ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/** Every tile overlapping the half-open map rect [x0,x1) by [y0,y1). */
function tilesOver(x0, y0, x1, y1) {
  const out = [];
  const c0 = Math.max(0, Math.floor(x0 / TILE));
  const c1 = Math.min(tiles.cols - 1, Math.floor((x1 - 1) / TILE));
  const r0 = Math.max(0, Math.floor(y0 / TILE));
  const r1 = Math.min(tiles.rows - 1, Math.floor((y1 - 1) / TILE));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push(tiles.list[r * tiles.cols + c]);
  }
  return out;
}

/**
 * Works out every shade of every province before any pixel is touched.
 *
 * Returns flat [r,g,b]-per-index arrays. The pixel loops then only index into
 * them: deciding a colour inside those loops would mean a Map lookup and a fresh
 * array for every pixel on the map. This is O(provinces), a few hundred, so it
 * is cheap enough to redo on every repaint however small the repaint is.
 *
 * There are two interior colours, not one. `rim` is the country's own colour, as
 * it appears against a frontier; `core` is a pastel wash of it for deep inland.
 * The pixel loop blends between them by distance from the border, so a country
 * reads as a saturated outline enclosing a soft field rather than as a flat
 * colour at varying opacity. The border shades come in the same pair.
 */
/*
 * A ceiling on what may be lit up.
 *
 * The highlight is baked into the painted map rather than drawn over it, which
 * is what makes it affordable: lighting a province costs a repaint of its
 * BOUNDING BOX, and for an ordinary province that is a small box. The bargain
 * fails for a box that is not describing where the province is. A placeholder
 * blocking out ground not yet drawn holds 1,409 pixels scattered through a box
 * of 1,178,070, so lighting it repaints eight hundred times more map than it
 * changes, and the selection ring on top of it wants a canvas the same size.
 *
 * A box spanning the map is no longer one of these cases. resolveWrap in
 * mapdata.js settles a box against the east-west wrapping, so a province
 * holding ground either side of the seam gets a box describing where it is.
 *
 * So past this size a province is simply not lit. It is still named, still
 * selectable, still reports its data and still ranks in the panel; only the
 * fill and the ring are skipped. The alternative is a third of a second of
 * frozen page every time the cursor crosses it.
 *
 * This is a floor under the worst case. Highlighting a province without
 * repainting it would remove the need for the ceiling, and nothing here does
 * that yet.
 */
const STRIPE_PERIOD = 14;   // map pixels between the start of one stripe and the next
const STRIPE_WIDTH = 3;     // how many of those the stripe itself covers

const HIGHLIGHT_MAX_PX = 4e6;      // bounding-box pixels, about a quarter of the map

// How long a frame may spend repainting chunks before handing the frame back.
// Short enough that a repaint never costs a dropped frame at 60Hz, which leaves
// the map filling in over two or three of them instead of freezing for one.
const REPAINT_BUDGET_MS = 6;

/** True when lighting this province would cost more than a frame can spare. */
function tooBigToLight(world, id) {
  return tooBigToLightBox(id && world.bounds.get(id));
}

/** The ceiling itself, on a box rather than an id, so the sea can share it. */
function tooBigToLightBox(bb) {
  if (!bb) return false;
  return (bb.maxX - bb.minX + 1) * (bb.maxY - bb.minY + 1) > HIGHLIGHT_MAX_PX;
}

/**
 * shadeTable for the water: one fill colour and one border colour per sea
 * region, indexed the way the province tables are so the pixel loop can read
 * both with the same arithmetic.
 *
 * Built only for the Navy mode. Every other mode paints the sea flat, so there
 * is nothing for these arrays to say.
 */
/** Hue in degrees and lightness in 0..1, which is all the palette above needs. */
function hueLightness([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d + (G < B ? 6 : 0));
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return [h, (max + min) / 2];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

const navyColour = (r) => {
  const [h, l] = hueLightness(r.colour);
  const [lo, hi] = r.lake ? NAVY_LAKE_ARC : NAVY_SEA_ARC;
  const base = r.lake ? NAVY_LAKE_LIGHT : NAVY_LIGHT;
  const rgb = hslToRgb(lo + (h / 360) * (hi - lo), NAVY_SAT,
    base + (l - 0.5) * NAVY_LIGHT_SPREAD);

  // Impassable water is pulled toward the
  // same near-black by the same amount. It is not a kind of sea, it is sea that
  // is not there, and it should read as shut on the chart as it does on the
  // terrain map.
  if (!r.tags.includes(IMPASSABLE)) return rgb;
  return rgb.map((v, c) => Math.round(v + (IMPASSABLE_COLOUR[c] - v) * IMPASSABLE_MIX));
};

/**
 * One fill colour and one border colour per county, indexed the way the province
 * tables are so the pixel loop reads both with the same arithmetic.
 *
 * KEPT between calls, and rebuilt only when the highlighted province changes.
 *
 * shadeTable() runs on every partial repaint, and a partial repaint happens every
 * time the cursor crosses from one province to the next. Building this each time
 * would be a fourteen-thousand pass and eighty-four kilobytes of fresh typed array
 * per mouse movement, thrown away immediately: not slow in itself, but the same
 * shape of mistake as the one that made the night mask leak forty megabytes a
 * minute. Nothing in it depends on the hover, so nothing in it needs redoing.
 */
let countyShade = { counties: null, province: undefined, base: null, edge: null };

function countyShadeTable(counties, selectedProvince) {
  if (countyShade.counties === counties && countyShade.province === selectedProvince) {
    return countyShade;
  }
  const n = counties.atIndex.length;
  const base = countyShade.base && countyShade.base.length === n * 3
    ? countyShade.base : new Uint8Array(n * 3);
  const edge = countyShade.edge && countyShade.edge.length === n * 3
    ? countyShade.edge : new Uint8Array(n * 3);

  for (let ix = 1; ix < n; ix++) {
    const c = counties.atIndex[ix];
    const lit = c.province === selectedProvince ? LIGHTEN.selected : 0;
    for (let k = 0; k < 3; k++) {
      let v = c.colour[k] + (COUNTY_WASH[k] - c.colour[k]) * COUNTY_MIX;
      v += (255 - v) * lit;
      base[ix * 3 + k] = Math.round(v);
      edge[ix * 3 + k] = Math.round(v * COUNTY_EDGE);
    }
  }
  countyShade = { counties, province: selectedProvince, base, edge };
  return countyShade;
}

/**
 * One fill and one border colour per sea SUBREGION.
 *
 * A subregion takes its region's colour and shifts it a little, so the whole
 * of one sea still reads as one sea while the pieces a fleet moves between are
 * visible inside it. The shift is a hash of the subregion's own index, which
 * keeps neighbours from landing on the same shade and never changes between
 * runs.
 *
 * The tags are the region's, so an impassable or a lake subregion is already
 * drawn as one: navyColour has applied all of that before this touches it.
 */
function subShadeTable(sea, subs, selected, hovered) {
  const n = subs.atIndex.length;
  const base = new Uint8Array(n * 3);
  const edge = new Uint8Array(n * 3);

  for (let ix = 1; ix < n; ix++) {
    const u = subs.atIndex[ix];
    const region = sea.byId.get(u.region);
    const tone = region ? navyColour(region) : NAVY_LAND;

    // A repeatable wobble in the region's own colour, between -1 and 1.
    const k = Math.imul(ix, 2654435761) >>> 0;
    const wobble = ((k % 2001) / 1000 - 1) * NAVY_SUB_SPREAD;
    const lit = selected === u.id ? NAVY_LIGHTEN.selected
      : hovered === u.id ? NAVY_LIGHTEN.hovered : 0;

    for (let c = 0; c < 3; c++) {
      let v = tone[c] * (1 + wobble);
      v += (255 - v) * lit;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      base[ix * 3 + c] = Math.round(v);
      edge[ix * 3 + c] = Math.round(v * NAVY_SUB_EDGE);
    }
  }
  return { base, edge };
}

function seaShadeTable(sea, selected, hovered) {
  const n = sea.atIndex.length;
  const base = new Uint8Array(n * 3);
  const edge = new Uint8Array(n * 3);

  for (let ix = 1; ix < n; ix++) {
    const r = sea.atIndex[ix];
    const tone = navyColour(r);

    // The same size ceiling the provinces use, applied here for the same reason:
    // invalidateSea refuses to repaint a region this large, so if the table lit
    // one anyway the highlight would appear only where some other repaint
    // happened to cross it. No region on the map reaches it today.
    const big = tooBigToLightBox(sea.bounds.get(r.id));
    const lit = big ? 0
      : selected === r.id ? NAVY_LIGHTEN.selected
        : hovered === r.id ? NAVY_LIGHTEN.hovered : 0;

    for (let c = 0; c < 3; c++) {
      // Toward white for the highlight, by the same proportional mix the
      // provinces use: a share of the headroom left in each channel, so
      // lightening never clips one and shifts the hue.
      const v = tone[c] + (255 - tone[c]) * lit;
      base[ix * 3 + c] = Math.round(v);
      edge[ix * 3 + c] = Math.round(v * NAVY_EDGE);
    }
  }
  return { base, edge };
}

function shadeTable(world, mode, selected, hovered) {
  // Dropped here rather than at the call sites so that every path agrees — a
  // full repaint and a partial one must shade the map identically, or the two
  // would disagree about what is lit and leave a patch behind.
  const { atIndex } = world;
  const n = atIndex.length;
  const rim = new Uint8Array(n * 3);      // interior, hard against a frontier
  const core = new Uint8Array(n * 3);     // interior, deep inland — the pastel wash
  const softRim = new Uint8Array(n * 3);  // subdivision line, near a frontier
  const softCore = new Uint8Array(n * 3); // subdivision line, inland
  const hard = new Uint8Array(n * 3);     // the frontier line itself
  const stripe = new Uint8Array(n * 3);   // occupied ground: the owner's colour, for the stripes
  const striped = new Uint8Array(n);      // and which provinces get them
  const neighbours = selected ? world.adjacency.get(selected) : null;
  const colourOf = MODES[mode];

  // Owners as small integers, so the pixel loop can ask "same owner?" with a
  // number comparison rather than a string one. Ocean stays -1, which never
  // matches any province, so every coastline automatically counts as a hard edge.
  const ownerAt = new Int32Array(n).fill(-1);
  const ownerOrdinal = new Map();

  // Whether the imagery is showing decides the whole alpha scheme. With it off
  // everything is opaque and the result is byte-for-byte what it always was.
  const over = !!(world.satellite && state.satellite && world.borderDist);
  const dropped = state.fade;                 // a selection on its way out, if any
  const k = dropped ? fadeStrength() : 0;     // how much of its highlight is left

  // And only the political map is shaped by distance from a frontier. The other
  // modes fill evenly, so that a province or a terrain type reads the same in
  // the middle of a country as it does at the edge.
  const shaped = over && mode === 'political';
  const navy = mode === 'navy' && !!world.sea;
  const county = mode === 'county' && !!world.counties;
  const lift = new Uint8Array(n);       // extra opacity for a highlighted province

  for (let ix = 1; ix < n; ix++) {
    const p = atIndex[ix];
    // Colour follows the controller; the frontier key decides where a border is
    // drawn, and those differ over occupied ground. See frontierKeyOf.
    const key = frontierKeyOf(p);
    if (!ownerOrdinal.has(key)) ownerOrdinal.set(key, ownerOrdinal.size);
    ownerAt[ix] = ownerOrdinal.get(key);

    // Highlight, if this province is in one of the three states. The selected
    // province lightens most and also gets the ring drawn in §5; its neighbours
    // lighten less, which is what shows you where you could move.
    let role = selected === p.id ? 'selected'
      : neighbours?.has(p.id) ? 'neighbour'
        : hovered === p.id ? 'hovered' : null;

    // A dropped selection keeps its highlight at falling strength until it has
    // faded out. The live selection always wins, so re-clicking a province that
    // is still fading, or picking one of its neighbours, snaps to full strength
    // rather than inheriting whatever the fade had reached.
    let strength = 1;
    if (!role && dropped) {
      if (dropped.id === p.id) { role = 'selected'; strength = k; }
      else if (dropped.neighbours.has(p.id)) { role = 'neighbour'; strength = k; }
    }

    // The size ceiling is applied HERE, after the role is worked out, rather
    // than to `selected` and `hovered` on the way in. Every way a province can
    // light up passes through this one line — selected, hovered, neighbour of a
    // selection, and any of those still fading out — and invalidateProvinces
    // refuses to repaint exactly these provinces, so the two must agree about
    // all four or none.
    //
    // Missing the neighbour case is what left rectangles across the map: the
    // shading said a huge province was lit, nothing ever repainted it to match,
    // and then every ordinary province repainted nearby carried the lift into
    // whatever slice of the huge one its bounding box happened to cover.
    //
    // Refusing the role rather than the selection also keeps the useful half of
    // selecting one: it is not lit itself, but its neighbours still are.
    if (role && tooBigToLight(world, p.id)) role = null;

    const mix = role ? LIGHTEN[role] * strength : 0;
    if (over && role) lift[ix] = Math.round(255 * SATELLITE_LIFT[role] * strength);

    const c = colourOf(world, p);
    for (let ch = 0; ch < 3; ch++) {
      const v = c[ch] + (255 - c[ch]) * mix;                       // the country's colour
      const pale = v + (PASTEL_TOWARD[ch] - v) * PASTEL_MIX;       // washed, for inland
      const inland = shaped ? pale : v;         // unshaped modes never wash out
      rim[ix * 3 + ch] = v;
      core[ix * 3 + ch] = inland;
      softRim[ix * 3 + ch] = v * BORDER_INTERNAL;
      softCore[ix * 3 + ch] = inland * BORDER_INTERNAL;
      hard[ix * 3 + ch] = v * BORDER_NATIONAL;
    }

    // Occupied ground: the stripe colour is the DE JURE owner's, so the province
    // reads as the occupier's with the owner showing through. Only the political
    // map does this. The other two are answering different questions and a
    // stripe over them would be noise.
    if (mode === 'political' && p.occupier && p.occupier !== p.owner) {
      const owner = world.table.polityById.get(p.owner);
      if (owner) {
        striped[ix] = 1;
        for (let ch = 0; ch < 3; ch++) {
          const v = owner.colour[ch] + (255 - owner.colour[ch]) * mix;
          stripe[ix * 3 + ch] = v;
        }
      }
    }
  }

  // How far between rim and core a pixel sits, by distance from the frontier,
  // resolved once into a 256-entry table so the pixel loop is a lookup rather
  // than a curve. 0 means fully rim, 255 fully core.
  //
  // The exponent shapes the falloff. Below 1 it concentrates the change close to
  // the border, giving a defined band of colour that drops away quickly, instead
  // of the even wash a straight ramp or a smoothstep produces.
  // Left at zero when unshaped, which pins every pixel to the rim colour and the
  // rim alpha — one flat fill, and no distance lookup doing anything.
  const fade = new Uint8Array(256);
  const span = FADE_PX * CHAMFER_ORTH;          // distances are stored pre-scaled
  if (shaped) {
    for (let d = 0; d < 256; d++) fade[d] = Math.round(255 * Math.min(1, d / span) ** FADE_CURVE);
  }

  const flat = over ? Math.round(255 * SATELLITE_FLAT) : 255;
  return {
    rim, core, softRim, softCore, hard, stripe, striped, ownerAt, over, fade, lift,

    // The water, for the Navy mode only. seaAt is null on every other mode and
    // whenever sea.png or sea.json is missing, and the painter falls back to the
    // one flat ocean colour it has always used.
    seaAt: navy ? world.sea.seaAt : null,
    ...(navy ? seaShadeTable(world.sea, state.selectedSea, state.hoveredSea) : {}),

    // And the subregions inside them, which is the level a fleet is actually
    // ordered to. Null when the bitmap is missing, and the Navy mode then draws
    // regions alone exactly as it did before they existed.
    subAt: navy && world.subs ? world.subs.subAt : null,
    ...(navy && world.subs ? (() => {
      const t = subShadeTable(world.sea, world.subs, state.selectedSub, state.hoveredSub);
      return { subBase: t.base, subEdge: t.edge };
    })() : {}),

    // The counties, for the County mode only. Null everywhere else, and the
    // painter then draws the province map it has always drawn.
    countyAt: county ? world.counties.countyAt : null,
    ...(county ? (() => {
      const t = countyShadeTable(world.counties, selected);
      return { countyBase: t.base, countyEdge: t.edge };
    })() : {}),
    aRim: shaped ? Math.round(255 * SATELLITE_RIM) : flat,
    aCore: shaped ? Math.round(255 * SATELLITE_CORE) : flat,
    aInternal: over ? Math.round(255 * SATELLITE_INTERNAL) : 0,   // added to the local fill alpha
    aNational: over ? Math.round(255 * SATELLITE_NATIONAL) : 255,
    // The Navy mode has something to say about the water and must be seen to say
    // it, so its sea is drawn nearly solid even over the imagery. Every other
    // mode leaves the water alone and lets the imagery show through.
    aSea: !over ? 255 : navy ? Math.round(255 * SATELLITE_FLAT) : 0,
  };
}

/**
 * Paints part of one tile and uploads just that part.
 *
 * Bounds are tile-local and half-open: [lx0,lx1) by [ly0,ly1). Pixels go into
 * the shared `scratch`, whose row stride is always TILE regardless of how short
 * an edge tile is, and only the painted rectangle is handed to putImageData.
 */
function paintTileRegion(world, t, tile, lx0, ly0, lx1, ly1) {
  const { width, height, provinceAt, borderDist } = world;
  const { rim, core, softRim, softCore, hard, stripe, striped, ownerAt, over, fade, lift } = t;
  const { aRim, aCore, aInternal, aNational, aSea } = t;
  const { seaAt, base: seaBase, edge: seaEdge, subAt, subBase, subEdge } = t;
  const { countyAt, countyBase, countyEdge } = t;
  // One value for the whole pass rather than a rounding per pixel.
  const countyAlpha = over ? Math.round(255 * SATELLITE_FLAT) : 255;
  const d = scratch.data;
  const [or_, og, ob] = world.table.oceanColour;   // trailing _ only to avoid shadowing `or`

  for (let ly = ly0; ly < ly1; ly++) {
    const y = tile.y + ly;
    let i = y * width + tile.x + lx0;              // index into the map
    let o = (ly * TILE + lx0) * 4;                 // index into the scratch
    for (let lx = lx0; lx < lx1; lx++, i++, o += 4) {
      const index = provinceAt[i];
      if (index === OCEAN) {
        // Water. seaAt is a second index over the same pixels, built from its own
        // bitmap, and is only consulted here: where the two bitmaps disagree the
        // land one wins, so a stray pixel in sea.png can never erase a coastline.
        //
        // Slot 0 there means land, which is what an ocean pixel outside every
        // drawn region reads as. It falls through to the flat colour, as does
        // every pixel of water when the Navy mode is not showing.
        const region = seaAt ? seaAt[i] : 0;
        if (region === 0) {
          d[o] = or_; d[o + 1] = og; d[o + 2] = ob;
          d[o + 3] = aSea;
          continue;
        }

        // The same right-and-below rule the land uses, wrapping east to west at
        // the last column. Land is skipped as a neighbour: a coastline already
        // has its dark line drawn from the province side, and drawing a second
        // one from the water would double its width.
        const sx = tile.x + lx;
        const right = sx + 1 < width ? i + 1 : y * width;
        const below = y + 1 < height ? i + width : i;
        const sRight = seaAt[right];
        const sBelow = y + 1 < height ? seaAt[below] : region;
        const onEdge = (sRight !== region && sRight !== 0)
          || (sBelow !== region && sBelow !== 0);

        // TWO LEVELS, drawn in one pass. The fill and the light border come
        // from the subregion, which is what a fleet occupies; the region border
        // is drawn over the top in the darker tone, so a sea still reads as one
        // sea while its divisions are visible inside it. Exactly the way the
        // County mode draws a province border over its counties.
        const sub = subAt ? subAt[i] : 0;
        if (sub !== 0 && !onEdge) {
          const uRight = subAt[right];
          const uBelow = y + 1 < height ? subAt[below] : sub;
          const subOnEdge = (uRight !== sub && uRight !== 0)
            || (uBelow !== sub && uBelow !== 0);
          const uc = sub * 3;
          const usrc = subOnEdge ? subEdge : subBase;
          d[o] = usrc[uc]; d[o + 1] = usrc[uc + 1]; d[o + 2] = usrc[uc + 2];
          d[o + 3] = aSea;
          continue;
        }

        const sc = region * 3;
        const src = onEdge ? seaEdge : seaBase;
        d[o] = src[sc]; d[o + 1] = src[sc + 1]; d[o + 2] = src[sc + 2];
        d[o + 3] = aSea;
        continue;
      }

      // Borders are not stored anywhere — they are found here, per pixel. If the
      // pixel to the right or below belongs to someone else, this one is on an
      // edge and draws darker. That single rule produces every internal border,
      // every national border and the entire coastline.
      //
      // These reads cross tile boundaries freely, because they index the map,
      // not the tile — so a border on a chunk edge is drawn from the same data
      // as one in the middle, and no seam appears.
      //
      // Because only right and below are checked, the dark line falls on one side
      // of each boundary rather than being shared, and is always exactly one map
      // pixel wide — so it thins out visually as you zoom in.
      // Right wraps at the last column to column 0 of the same row, so a border
      // running down the map's seam is drawn like any other. Below does not:
      // there is nothing past a pole to share an edge with.
      const x = tile.x + lx;
      const right = provinceAt[x + 1 < width ? i + 1 : y * width];
      const below = y + 1 < height ? provinceAt[i + width] : index;
      const mine = ownerAt[index];
      let edge = 0;                                // 0 interior, 1 internal edge, 2 national edge
      if (right !== index) edge = ownerAt[right] === mine ? 1 : 2;
      if (below !== index && edge < 2) edge = Math.max(edge, ownerAt[below] === mine ? 1 : 2);

      const c = index * 3;

      // The county map. It reads the same right-and-below rule twice: once for
      // the counties, which draw a light line, and once for the provinces above
      // them, which draw a dark one over it. Two levels on one map, and the
      // county line has to be the quieter of the two or the provinces disappear
      // into fourteen thousand subdivisions.
      if (countyAt) {
        const ci = countyAt[i];
        if (ci) {
          const cc = ci * 3;
          const cRight = countyAt[x + 1 < width ? i + 1 : y * width];
          const cBelow = y + 1 < height ? countyAt[i + width] : ci;
          const src = cRight !== ci || cBelow !== ci ? countyEdge : countyBase;
          if (edge === 2) {
            d[o] = Math.round(src[cc] * COUNTY_PROVINCE);
            d[o + 1] = Math.round(src[cc + 1] * COUNTY_PROVINCE);
            d[o + 2] = Math.round(src[cc + 2] * COUNTY_PROVINCE);
          } else {
            d[o] = src[cc]; d[o + 1] = src[cc + 1]; d[o + 2] = src[cc + 2];
          }
          d[o + 3] = countyAlpha;
          continue;
        }
      }

      // A frontier is drawn at full strength wherever it runs; it never fades.
      if (edge === 2) {
        d[o] = hard[c]; d[o + 1] = hard[c + 1]; d[o + 2] = hard[c + 2];
        d[o + 3] = aNational;
        continue;
      }

      // Interiors, and the subdivision lines within them, blend from the
      // country's own colour at the frontier to its pastel wash inland. `f` is
      // that blend as a byte, so the mix is a shift rather than a divide.
      const f = over ? fade[borderDist[i]] : 0;
      const [near, far] = edge === 1 ? [softRim, softCore] : [rim, core];
      d[o] = near[c] + (((far[c] - near[c]) * f) >> 8);
      d[o + 1] = near[c + 1] + (((far[c + 1] - near[c + 1]) * f) >> 8);
      d[o + 2] = near[c + 2] + (((far[c + 2] - near[c + 2]) * f) >> 8);

      // Occupied ground is striped with its de jure owner's colour. Diagonal, on
      // a period of STRIPE_PERIOD map pixels, from x + y so the run is at 45
      // degrees and never lines up with a border. Map pixels rather than screen
      // ones, so the stripes belong to the ground and travel with it under a
      // zoom instead of crawling across it.
      if (striped[index] && ((x + y) % STRIPE_PERIOD) < STRIPE_WIDTH) {
        d[o] = stripe[c]; d[o + 1] = stripe[c + 1]; d[o + 2] = stripe[c + 2];
      }

      if (!over) {
        d[o + 3] = 255;                          // no imagery: nothing to fade into
      } else {
        // Subdivision lines sit a little above the fill they cross, so they stay
        // visible inland without ever reading as a frontier.
        const a = aRim + (((aCore - aRim) * f) >> 8) + lift[index] + (edge === 1 ? aInternal : 0);
        d[o + 3] = a > 255 ? 255 : a;
      }
    }
  }

  const w = lx1 - lx0, h = ly1 - ly0;
  if (!over) {
    // No imagery: the layer is opaque, so it can go straight to the tile.
    tile.ctx.putImageData(scratch, 0, 0, lx0, ly0, w, h);
  } else {
    // Imagery underneath, province layer over it. putImageData cannot composite —
    // it replaces pixels outright, alpha included — so the layer goes to a scratch
    // canvas first and is then drawn, which does blend.
    tile.ctx.clearRect(lx0, ly0, w, h);
    tile.ctx.drawImage(world.satellite, tile.x + lx0, tile.y + ly0, w, h, lx0, ly0, w, h);
    scratchCtx.putImageData(scratch, 0, 0, lx0, ly0, w, h);
    tile.ctx.drawImage(scratchCanvas, lx0, ly0, w, h, lx0, ly0, w, h);
  }

  // Night is deliberately not applied here. It belongs to the hour rather than
  // to the ground, so it is drawn over the finished map in §5 instead of being
  // baked into it — see the note above buildNightMask.
}

/** Copies a map rectangle from the tiles down into the overview. */
function refreshOverview(world, x0, y0, x1, y1) {
  const { scale, ctx } = overview;
  ctx.imageSmoothingEnabled = true;

  // Widen by a couple of map pixels. The copy lands on fractional overview
  // coordinates and is antialiased at its edges, so overlapping the neighbouring
  // region slightly keeps those edges from accumulating into visible seams.
  const pad = Math.ceil(2 / scale);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(world.width, x1 + pad); y1 = Math.min(world.height, y1 + pad);

  for (const tile of tilesOver(x0, y0, x1, y1)) {
    const ax0 = Math.max(x0, tile.x), ay0 = Math.max(y0, tile.y);
    const ax1 = Math.min(x1, tile.x + tile.w), ay1 = Math.min(y1, tile.y + tile.h);
    if (ax1 <= ax0 || ay1 <= ay0) continue;

    // Round the destination EDGES, not the width, so that two copies sharing a
    // boundary resolve it to the same integer and leave nothing between them.
    const dx0 = Math.round(ax0 * scale), dx1 = Math.round(ax1 * scale);
    const dy0 = Math.round(ay0 * scale), dy1 = Math.round(ay1 * scale);
    if (dx1 <= dx0 || dy1 <= dy0) continue;      // region too small to survive the downscale

    ctx.drawImage(
      tile.canvas,
      ax0 - tile.x, ay0 - tile.y, ax1 - ax0, ay1 - ay0,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
  }
}

/**
 * Repaints every tile. Only needed on load and on a change of map mode, since
 * those are the only things that alter every province at once.
 */
/**
 * Repaints every tile, a few at a time, over as many frames as it takes.
 *
 * A full repaint is 15.9 million pixels across 72 chunks. Done in one go it holds
 * the main thread for long enough to be a freeze rather than a pause, and every
 * change of map mode did exactly that. So it is spread: each frame paints chunks
 * until REPAINT_BUDGET_MS is up and then hands the frame back, and the map fills
 * in over two or three frames instead of stopping for one long one.
 *
 * VISIBLE CHUNKS GO FIRST, which is what makes it feel instant rather than merely
 * be shorter. What is on screen is right on the first frame and the rest of the
 * world catches up behind it, unseen.
 *
 * The shade table is built once at the start and held for the whole pass, so every
 * chunk is painted from the same one and no seam appears between the part painted
 * this frame and the part painted last.
 */
function startRepaint(world, mode, selected, hovered) {
  if (!tiles) buildTiles(world);
  return { t: shadeTable(world, mode, selected, hovered), todo: new Set(tiles.list) };
}

/**
 * Paints as much of a pass as the budget allows. True when it is finished.
 *
 * What is on screen is chosen again on every frame rather than once at the start,
 * so panning into ground the pass has not reached yet moves it to the front of the
 * queue. Otherwise a pan during a repaint would show the old map until the pass
 * happened to arrive there, which is exactly when it would be noticed.
 *
 * Picking that order costs a walk over 72 chunks, which is nothing beside painting
 * even one of them.
 */
function stepRepaint(world, pass) {
  const t0 = performance.now();
  // ONCE PER COPY OF THE MAP, the way drawMapLayer does it. visibleRect clamps
  // to the map, so at the antimeridian a single call sees only the tiles at one
  // end and the other half of the window is left to the general sweep below.
  // That is what made a selection there paint one half at once and the half past
  // the meridian seconds later.
  const cssW = els.canvas.clientWidth, cssH = els.canvas.clientHeight;
  const first = [];
  for (const dx of wrapOffsets(cssW)) {
    const rect = visibleRect(view.x + dx, cssW, cssH);
    if (rect) first.push(...tilesOver(rect.x0, rect.y0, rect.x1, rect.y1));
  }

  // The chunk is painted; the OVERVIEW is left alone until the pass is done.
  //
  // Refreshing it per chunk is what made a change of mode wipe across the map
  // from the top left. Zoomed out the overview is the whole of what is drawn, so
  // every chunk copied into it showed at once, and the visible-chunks-first order
  // could do nothing about it because at that zoom every chunk is visible.
  //
  // Held back, the overview keeps the old map until the new one is complete and
  // then changes in a single frame. It costs one pass of 72 drawImage calls at
  // the end, which is a few milliseconds, and no extra memory: the alternative is
  // a second overview to draw from while this one fills, at 17MB.
  const paint = (tile) => {
    pass.todo.delete(tile);
    paintTileRegion(world, pass.t, tile, 0, 0, tile.w, tile.h);
  };

  for (const tile of first) {
    if (!pass.todo.has(tile)) continue;
    paint(tile);
    if (performance.now() - t0 >= REPAINT_BUDGET_MS) break;
  }
  if (performance.now() - t0 < REPAINT_BUDGET_MS) {
    for (const tile of pass.todo) {
      paint(tile);
      if (performance.now() - t0 >= REPAINT_BUDGET_MS) break;
    }
  }

  const done = pass.todo.size === 0;
  if (done) refreshOverview(world, 0, 0, world.width, world.height);
  perf.paint = ease(perf.paint, performance.now() - t0);
  return done;
}

/**
 * Repaints only the provinces whose colour has changed, by bounding box.
 *
 * This is what makes a large map usable. Hovering alters exactly two provinces
 * and selecting alters a province plus its neighbours, but a full repaint costs
 * width*height regardless — on a 6000x2650 map, 15.9 million pixels for a change
 * affecting a hundredth of a percent of them.
 *
 * A province's own pixels are the only ones that change: the border test reads a
 * neighbour's OWNER, which a highlight never touches, so nothing outside the box
 * can be affected. Other provinces caught inside the same box are simply
 * recomputed to the values they already had.
 */
function repaintProvinces(world, mode, selected, hovered, ids, boxes = []) {
  // Nothing to repaint into yet. Ask for the full pass instead, which builds the
  // chunks and covers these boxes on its way through.
  if (!tiles) { bufferDirty = true; return; }

  const t = shadeTable(world, mode, selected, hovered);
  for (const id of ids) {
    const bb = world.bounds.get(id);
    if (!bb) continue;                 // province with no pixels; nothing to repaint

    // One box at a time rather than one box around them all: two provinces on
    // opposite sides of the map would otherwise union into the whole thing.
    for (const r of boxesFor(world, bb)) repaintBox(world, t, r.x0, r.y0, r.x1, r.y1);
  }

  // Rectangles rather than provinces, for changes that are not one province's
  // own pixels: an ownership change moves the inland fade for everything within
  // reach of the border it made or unmade. See ownership.js.
  for (const box of boxes) repaintBox(world, t, box.x0, box.y0, box.x1, box.y1);
}

/**
 * The rectangles a province box covers, as one or two.
 *
 * resolveWrap in mapdata.js may set maxX at or past the map width, for a province
 * holding ground either side of the seam. Such a box is two rectangles, one
 * against each edge of the bitmap, which is the same shape regionsFor produces in
 * ownership.js for the same reason.
 */
function boxesFor(world, bb) {
  const y0 = bb.minY, y1 = bb.maxY + 1;
  if (bb.maxX < world.width) return [{ x0: bb.minX, y0, x1: bb.maxX + 1, y1 }];
  return [
    { x0: bb.minX, y0, x1: world.width, y1 },
    { x0: 0, y0, x1: bb.maxX + 1 - world.width, y1 },
  ];
}

/** Repaints one map rectangle, half-open, and copies it into the overview. */
function repaintBox(world, t, x0, y0, x1, y1) {
  for (const tile of tilesOver(x0, y0, x1, y1)) {
    const lx0 = Math.max(0, x0 - tile.x), ly0 = Math.max(0, y0 - tile.y);
    const lx1 = Math.min(tile.w, x1 - tile.x), ly1 = Math.min(tile.h, y1 - tile.y);
    if (lx1 > lx0 && ly1 > ly0) paintTileRegion(world, t, tile, lx0, ly0, lx1, ly1);
  }
  refreshOverview(world, x0, y0, x1, y1);
}

// =================================================================== 4. labels

//
// Every contiguous run of same-owner provinces is a "block", and each block gets
// one label. Placing it takes four steps:
//
//   1. AXIS    PCA over the block's pixels gives the direction the land runs in.
//   2. SPINE   a quadratic fitted to the spread across that axis gives a gentle
//              curve following the land, which the text is drawn along.
//   3. SPAN    denseRange() finds the stretch of the axis that is solid ground,
//              which is what the name should cover.
//   4. TYPE    fitLabel() picks the font size, and the number of lines, that
//              fills that span without spilling over the border.
//
// Steps 1-3 happen once, at load. Only step 4's result is used per frame.
// Every size here is in MAP pixels; layoutLabels() converts to screen pixels by
// multiplying by view.scale at the last moment.

// --- appearance
// Labels belong to the MAP, not to the screen: a name is sized and positioned in
// map units and simply scales with the zoom, as though painted onto the terrain.
// A country's name therefore covers the same part of that country at every zoom.
//
// Deliberately no upper size limit. Capping it would stop the text growing once
// the cap was reached, which reads as the label shrinking back toward its own
// centre as you zoom further in — it stops sitting still on the land.
//
// Zoom decides only how VISIBLE a name is, never its size or place. See
// LABEL_FADE_IN below.
const LABEL_TRACKING = 0.16;     // letter spacing, as a fraction of the font size
const LABEL_LINE_HEIGHT = 1.1;   // distance between stacked lines, as a multiple of the font size
/*
 * Opacity is a function of the label's OWN size on screen, not of the zoom.
 *
 * That distinction is the whole point. A label tied to the zoom fades in step
 * with every other label, however big or small its country — so zooming in
 * dims a tiny country's name at the very moment it finally became readable.
 * Driven by size instead, each label lives its own life: it fades in when it
 * grows readable, holds while it is a useful size, and fades out once it has
 * grown so large that you are plainly looking at provinces rather than at
 * countries. A large country reaches that point at a much lower zoom than a
 * small one, which is why big names disappear first.
 *
 * Both thresholds are in screen pixels of font size.
 */
const LABEL_ALPHA = 0.85;                  // peak opacity, in the band between the two

/* --- standing back while something is selected
 *
 * Selecting a province lightens it and its neighbours, and reading that means
 * comparing shapes. A country name is the one thing on the map large enough to
 * lie across several of them at once, so it drops to a fifth of its strength
 * while a selection stands and comes back when it is dropped.
 *
 * Country names only. City names are small and pinned to a point, so they sit
 * beside the shapes rather than across them and cost nothing to leave alone.
 * Province names are a debug overlay and not part of the map at all, so they
 * are left to behave like the other overlays rather than dressed to match.
 *
 * Faded rather than switched, because the map is never asked to change
 * instantly anywhere else, and a caption blinking out at the moment of a click
 * reads as a fault rather than as an answer to it.
 */
const LABEL_DIM_TO = 0.2;                  // what a label is worth while selecting
const LABEL_DIM_MS = 160;

// 0 is full strength, 1 fully dimmed. Kept as progress rather than as the
// multiplier itself so the transition takes the same time whatever LABEL_DIM_TO
// is set to.
let labelDim = 0;
let labelDimClock = null;

/** Moves the dimming towards where the selection says it should be. */
function stepLabelDim(now) {
  const want = state.selected ? 1 : 0;
  const step = labelDimClock === null ? 1 : (now - labelDimClock) / LABEL_DIM_MS;
  labelDimClock = now;
  if (labelDim === want) return false;
  labelDim = want > labelDim ? Math.min(want, labelDim + step) : Math.max(want, labelDim - step);
  return true;
}

/** What every label's opacity is multiplied by right now. */
const labelDimming = () => 1 - labelDim * (1 - LABEL_DIM_TO);

// The two ends are measured in different units, on purpose.
//
// Fading IN is about legibility, which is absolute: text under about eight
// pixels cannot be read whatever it names, so this is in screen pixels of font
// size.
//
// Fading OUT is about the name having outlived its usefulness, which is
// relative: what matters is how much of the WINDOW the country now fills. Font
// size is a poor proxy for that, because fitLabel() sizes a long name smaller
// than a short one — so at any given font size, a long-named country is far more
// zoomed in than a short-named one, and the two would drop out at quite
// different moments. Since a label is always laid out at LABEL_FIT.along of its
// territory's span, its width IS that span, and comparing it with the viewport
// asks the question directly. Fully faded by the time a country fills the
// screen, which is the point at which you are looking at provinces.
const LABEL_FADE_IN = [3, 6];              // screen pixels of font size
const LABEL_FADE_OUT = [0.34, 0.78];       // label width, as a fraction of the window

/** Eased 0..1 ramp, so neither end of a fade arrives as a visible step. */
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * A label's opacity: `px` is its font size on screen, `covers` the share of the
 * window its widest line spans. 0 means do not draw it at all.
 */
function labelOpacity(px, covers) {
  return LABEL_ALPHA
    * smoothstep(LABEL_FADE_IN[0], LABEL_FADE_IN[1], px)
    * (1 - smoothstep(LABEL_FADE_OUT[0], LABEL_FADE_OUT[1], covers));
}
// The tightest the spine may curve, as a multiple of the label's own type size.
//
// Crowding on the inside of a bend is dealt with by curveWiden(), which widens
// the letter gaps to cancel it — so this no longer has to protect letterspacing
// and can sit just clear of the one radius that has no answer: h/2, where the
// inner edge of the text stops moving forward at all and the letters invert.
// Everything above that is fair game, and the spine follows the land.
const BEND_RADIUS = 7;

// Polity label colours, as "r,g,b". Opacity is kept separate because it varies
// with zoom: LABEL_ALPHA sets the pair's overall strength at the current scale,
// and the two multipliers below then weight each against the other. Both are
// relative, so the text and its halo always fade together rather than one
// outliving the other. The outline is what keeps a name legible as it crosses
// provinces of very different colours, so they only work as a contrasting pair.
const LABEL_COLOUR = '28,34,45';
const LABEL_OUTLINE = '255,255,255';
const LABEL_COLOUR_OPACITY = 0.9;     // 0 hides the text and leaves only the halo
const LABEL_OUTLINE_ALPHA = 0.76;   // 0 leaves bare text with nothing behind it
const LABEL_OUTLINE_WIDTH = 0.13;   // as a fraction of the font size

// --- choosing the font size and the number of lines
const LABEL_FIT = { along: 0.86, across: 0.9 };  // fraction of the block's span/thickness the text may fill
const LABEL_MAX_LINES = 3;       // hard ceiling on stacked lines
const LABEL_WRAP_ASPECT = 2.3;   // length-to-width above which a block never stacks: a long thin
// territory reads better with its name spread along it
const LABEL_WRAP_GAIN = 1.15;    // and an extra line must grow the type by this factor to be worth taking

// --- choosing which stretch of the block the name covers
// LABEL_HIST_BUCKET comes from mapdata.js — the label geometry is computed there.
const LABEL_DENSITY_FLOOR = 0.4; // a slice counts as solid ground at this fraction of the block's mean width
const LABEL_MIN_DENSITY = 0.3;   // a whole block sparser than this is an archipelago

// What an archipelago gets INSTEAD of nothing.
//
// A block sparser than LABEL_MIN_DENSITY is mostly sea, so a name written across
// it floats on water. That is the right thing to refuse for the island chain
// hanging off a mainland country, which is already named on its mainland, and
// the wrong thing to refuse for a country that is mostly islands, which is then
// barely named or not named at all.
//
// What separates the two is not how a country is split but how much of it ends
// up with no name written on it. A country with outlying pieces each large
// enough to be named on its own is not an archipelago however many it has: the
// Empire of Akasora is sixteen blocks and twelve of them carry the name. A
// country where most of the land is in blocks too sparse to label is one
// however solid its largest island happens to be: the Colony of the Marzon
// Islands is a compact main island and a scatter, and putting the name on the
// island alone leaves 47% of the country bare.
//
// Such a country is gathered into a single block holding every province it
// owns, and the name is written across the lot the way an atlas writes an
// archipelago: one line, letterspaced, so it reads as covering an area rather
// than naming a landmass. The pieces give up their own labels to it, so the
// name appears once. Sixteen of the 191 countries on the map qualify.
const LABEL_ISLANDS_SHARE = 0.4;      // of a country's land with no name on it
const LABEL_SPARSE_TRACKING = 0.3;    // letter spacing for such a name
const LABEL_SPARSE_LIFT = 2.2;        // how far it may exceed the scatter it crosses
const LABEL_ISLANDS_MAX_SPAN = 0.18;  // of the map width; past this the pieces are not one archipelago

//change the number to change weight/boldness of text
/*
 * The map's lettering, which is deliberately NOT the interface's.
 *
 * The chrome is set in Bahnschrift, a cut of DIN 1451, for atmosphere. The map
 * is not: names painted across territory are read at every size from six pixels
 * to hundreds, at any angle, over imagery of any colour, and a plain humanist
 * sans survives that better than a narrow industrial face. An atlas and the
 * panel that reads it are two different jobs.
 *
 * The whole string is the key to the glyph atlas, not just the family — change
 * any part of it and every cached glyph is a miss until the atlas refills.
 */
const LABEL_FACE = '"Segoe UI", sans-serif';

// The resource layer only. Cabin is what style.css sets the interface in, as
// --ui, and it ships in data/ui/fonts. LABEL_FACE above is --ui-plain and is
// left alone: it carries the country, province and sea names.
const RESOURCE_FACE = 'Cabin, "Segoe UI", sans-serif';
const resourceFont = (px) => `500 ${px}px ${RESOURCE_FACE}`;
const resourceIconPx = (px) => Math.round((px * RESOURCE_ICON_PX) / RESOURCE_MAX_LINE);
const labelFont = (px) => `600 ${px}px ${LABEL_FACE}`;

/**
 * Width of one line of label text, expressed in multiples of its font size —
 * so a return of 12 means the line is 12x as wide as it is tall.
 *
 * This measures the real font instead of estimating from an average glyph
 * width. A name in wide capitals (M, N, R, Z) runs far past what an average
 * predicts, and the text would then be laid out longer than the land it was
 * sized to fit, spilling over the border.
 *
 * The size measured at does not matter, as the result is a ratio; 100 just
 * keeps the rounding error small.
 */
const MEASURE_SIZE = 100;
let measureCtx = null;             // one reusable context; measuring needs no visible canvas
function widthRatio(text, tracking = LABEL_TRACKING) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = labelFont(MEASURE_SIZE);
  const chars = [...text];
  const w = chars.reduce((s, c) => s + measureCtx.measureText(c).width, 0)
    + MEASURE_SIZE * tracking * (chars.length - 1);
  return w / MEASURE_SIZE;
}

/**
 * Splits a name into exactly `n` lines, breaking only between words.
 *
 * Tries every possible set of break points and keeps whichever makes the WIDEST
 * line as narrow as possible, since that widest line is what limits the font
 * size. Returns { lines, worst }, or null if there are too few words.
 */
function wrapInto(words, n) {
  if (words.length < n) return null;
  let best = null;
  const search = (start, left, acc) => {
    if (left === 1) {
      const lines = [...acc, words.slice(start).join(' ')];
      const worst = Math.max(...lines.map(widthRatio));
      if (!best || worst < best.worst) best = { lines, worst };
      return;
    }
    for (let end = start + 1; end <= words.length - left + 1; end++) {
      search(end, left - 1, [...acc, words.slice(start, end).join(' ')]);
    }
  };
  search(0, n, []);
  return best;
}

/**
 * Picks the font size and line count for one label: STEP 4 above.
 *
 * Tries 1, 2 ... `maxLines` lines and keeps the best. For each count, the size
 * that fits is limited by two things at once — the text must be no longer than
 * the block's span, and the stack of lines no taller than its thickness — so the
 * size is the smaller of those two limits.
 *
 * A round block has thickness to spare and little span, so splitting a two-word
 * name buys far more size than shrinking it onto one line. Callers control that
 * through `maxLines`: see LABEL_WRAP_ASPECT for why long thin blocks are given 1.
 *
 * Returns { lines, size }.
 */
function fitLabel(text, span, thickness, maxLines, tracking = LABEL_TRACKING) {
  const words = text.split(/\s+/);
  let best = null;
  for (let n = 1; n <= Math.min(maxLines, words.length); n++) {
    const wrapped = n === 1 ? { lines: [text], worst: widthRatio(text, tracking) } : wrapInto(words, n);
    if (!wrapped) continue;
    const size = Math.min(
      span * LABEL_FIT.along / wrapped.worst,             // limited by the block's length
      thickness * LABEL_FIT.across / (n * LABEL_LINE_HEIGHT)   // limited by its width
    );
    // Each extra line has to earn its place. Splitting a line roughly halves its
    // length and so nearly doubles the size that fits, meaning size alone would
    // keep wrapping forever; requiring a real gain stops a name splitting again
    // for one or two percent and stranding a word like "OF" on a line by itself.
    if (!best || size > best.size * LABEL_WRAP_GAIN) best = { lines: wrapped.lines, size, width: wrapped.worst };
  }
  return best;
}

/**
 * Finds the stretch of the axis that is solid territory: STEP 3 above.
 *
 * `f.hist` holds the block's pixel count per slice along the axis, which is its
 * width profile. This starts at the slice containing the median pixel — the
 * middle of the land by weight, rather than the midpoint of the extent — then
 * walks outwards in each direction, stopping when the block narrows below
 * `floor` of its own mean width.
 *
 * The two sides stop independently, and that is the point. A country cut off
 * flat by a neighbour's border is solid right up to that edge, so that side runs
 * all the way out; a coast fraying into capes stops where the land thins. If
 * instead an equal share were trimmed off both ends, one ragged coast would
 * shorten the name across the entire country.
 *
 * Returns [tLo, tHi] in axis coordinates.
 */
function denseRange(f, floor) {
  const keys = [...f.hist.keys()].sort((a, b) => a - b);
  if (!keys.length) return null;

  // Copy into a plain array indexed by slice, so that a gap of open sea shows up
  // as the zero width it is rather than being skipped over.
  const first = keys[0], last = keys[keys.length - 1];
  const w = new Array(last - first + 1).fill(0);
  for (const [k, v] of f.hist) w[k - first] = v;

  // Read the profile smoothed over three slices, so that a single ragged notch
  // of coastline cannot halt the walk on its own.
  const at = (i) => w[clamp(i, 0, w.length - 1)];
  const smooth = (i) => (at(i - 1) + at(i) + at(i + 1)) / 3;

  const total = w.reduce((s, v) => s + v, 0);
  const threshold = (total / w.length) * floor;      // mean width, scaled down

  // Every unbroken stretch of solid ground, found by scanning the whole profile
  // rather than by walking outwards from the middle.
  //
  // Walking from the median pixel is what this did before, and it fails on a
  // country in two pieces. The Federation of Voseni South Panathra is two large
  // islands either side of a strait: its median pixel lands IN the strait, which
  // is below the threshold, so the walk could not move in either direction and
  // handed back a range one slice wide. The name was then sized to fit the water
  // between the islands, which at 66,000 px of land came out under a pixel tall.
  const runs = [];
  let run = null;
  for (let i = 0; i < w.length; i++) {
    if (smooth(i) >= threshold) {
      run ??= { lo: i, hi: i, px: 0 };
      run.hi = i;
      run.px += w[i];
    } else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  if (!runs.length) return null;

  // Interior gaps are bridged, outer thin ground is still trimmed. The two are
  // not the same thing: the thin ends of a profile are capes fraying into the
  // sea and a name written over them sits on water, while a gap WITHIN the
  // profile is a strait with the country's own land on both sides. Running the
  // name across it puts the name on the country.
  //
  // A gap is only bridged when it is shorter than the stretches either side of
  // it, so a strait is crossed and an ocean is not. A mainland with a distant
  // island keeps its name on the mainland.
  const groups = [];
  for (const r of runs) {
    const prev = groups[groups.length - 1];
    const gap = prev ? r.lo - prev.hi - 1 : Infinity;
    const bridgeable = prev
      && gap < (prev.hi - prev.lo + 1)
      && gap < (r.hi - r.lo + 1);
    if (bridgeable) { prev.hi = r.hi; prev.px += r.px; }
    else groups.push({ ...r });
  }

  // Whichever group holds the most land. With one group, which is the ordinary
  // case, this is simply that group.
  let best = groups[0];
  for (const g of groups) if (g.px > best.px) best = g;
  const { lo, hi } = best;

  // Slice boundaries round outwards, which on a block only a few pixels long
  // would return a range wider than the block itself. Clamp to what exists.
  return [
    Math.max((first + lo) * LABEL_HIST_BUCKET, f.tMin),
    Math.min((first + hi + 1) * LABEL_HIST_BUCKET, f.tMax),
    groups.length,
  ];
}

/**
 * Builds every label, at load. See the four steps at the top of section 4.
 *
 * One label per contiguous block, so a polity split across an enclave or an
 * island group gets its name written on each piece separately. The array is
 * indexed BY BLOCK and holds nulls for blocks with no name, so an ownership
 * change can replace the entries it affects and leave the rest alone.
 */
function buildLabels(world, geometry) {
  if (!geometry) return [];
  surrendered.clear();
  return nameArchipelagos(world, geometry, geometry.blocks.map((_, b) => buildLabel(world, geometry, b)));
}

// Blocks that handed their label to a gathered archipelago name. Kept so the
// next run can rebuild them and measure the map as it would be without this
// pass, rather than compounding its own previous answer.
const surrendered = new Set();

/**
 * Rewrites the names of the countries the pass above cannot serve.
 *
 * It measures one thing per country: the share of its land sitting in blocks
 * that came back without a label. Past LABEL_ISLANDS_SHARE the country reads as
 * a scatter rather than as being anywhere in particular, and its provinces are
 * gathered into one block so the name can be written across all of them at once.
 * Its pieces then surrender their own labels, so the name appears once.
 *
 * Measuring bare land rather than the number of pieces is what makes this work
 * in both directions. A country of sixteen blocks, twelve of them named, is not
 * gathered. A country of two blocks, one a solid island and the other a scatter
 * holding half the ground, is.
 *
 * Run whole rather than over the countries an ownership change named. It is a
 * walk over a few hundred blocks and a bounding box each for the dozen or so
 * countries that qualify, which is cheaper than keeping track of who might have
 * been affected and being wrong about it.
 */
function nameArchipelagos(world, geometry, labels) {
  const { blocks, geo } = geometry;

  // A piece that gave up its label to a gathered name last time gets it back
  // first, so the measurement below is taken against the map as it would be if
  // this pass had never run. Without that, a country that has since taken
  // ground it can write on would still read as having none.
  for (const b of surrendered) labels[b] = buildLabel(world, geometry, b);
  surrendered.clear();

  // Land per country, and how much of it has a name written on it. Ordinary
  // blocks only: a realm block is a second name over the same ground, and an
  // islands block is this pass's own work.
  const land = new Map();
  const pieces = new Map();
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    if (!blk || blk.level) continue;
    const n = geo[b] ? geo[b].n : 0;
    const s = land.get(blk.owner) || { total: 0, named: 0, labelled: false };
    s.total += n;
    if (labels[b]) { s.named += n; s.labelled = true; }
    land.set(blk.owner, s);
    if (!pieces.has(blk.owner)) pieces.set(blk.owner, []);
    pieces.get(blk.owner).push(b);
  }

  const plan = new Map();
  for (const [owner, s] of land) {
    if (!s.total || (s.total - s.named) / s.total < LABEL_ISLANDS_SHARE) continue;
    const members = [];
    for (const b of pieces.get(owner)) members.push(...blocks[b].members);
    plan.set(owner, members);
  }

  const { touched, spare } = setIslandBlocks(world, geometry, plan);
  for (const b of spare) labels[b] = null;

  for (const b of touched) {
    const blk = blocks[b];
    const f = geometry.fit[b];

    // Gathering the pieces is right for a country whose islands are a group and
    // wrong for one holding islands in two oceans, where the name would be
    // written across the water between them. Past the cap the pieces are not one
    // archipelago, and the name goes back on the piece holding the most land.
    // Nothing on the map reaches it: the widest is 446 map pixels of the 1,080
    // allowed.
    //
    // It catches one more thing. computeBlockGeometry measures in the bitmap's
    // own frame, so two pieces either side of the map seam read as a map apart
    // rather than as neighbours, and their centroid lands in the wrong ocean.
    // That country trips the cap and keeps its name on its largest piece, which
    // is the answer this had before and is not wrong, only less than it could
    // be. No country on the map is in that position.
    if (!f || f.tMax - f.tMin > world.width * LABEL_ISLANDS_MAX_SPAN) {
      // A country already carrying names keeps them: whatever these pieces are,
      // they are not one archipelago, and the names it has are better than one
      // stretched between them. The United Imperial Territories are the only
      // country here, at 5,899 map pixels across.
      if (land.get(blk.owner).labelled) {
        blk.members = [];
        geometry.geo[b] = null;
        geometry.fit[b] = null;
        labels[b] = null;
        continue;
      }

      // A country carrying none has nothing to lose, so the name goes on the
      // piece holding the most land.
      const bs = pieces.get(blk.owner);
      let pick = bs[0];
      for (const q of bs) if ((geo[q]?.n || 0) > (geo[pick]?.n || 0)) pick = q;
      blk.members = [...blocks[pick].members];
      computeBlockGeometry(world, geometry, [b]);
    }

    const L = buildLabel(world, geometry, b, true);
    labels[b] = L;

    // One name, not two. The pieces hand theirs over, and are noted so the next
    // run of this pass can give them back.
    if (L) {
      for (const q of pieces.get(blk.owner)) {
        if (labels[q]) { labels[q] = null; surrendered.add(q); }
      }
    }
  }
  return labels;
}

/**
 * One block's label, or null if it should not have one.
 *
 * Indexed by block, and returned one at a time, so a province changing hands
 * rebuilds the labels of the blocks it touched instead of all of them. Blocks
 * left empty by such a change have no geometry and land here as null.
 */
function buildLabel(world, geometry, b, sparseOK = false) {
  const { blocks, geo, fit } = geometry;
  const blk = blocks[b];
  const g = geo[b], f = fit[b];
  if (!blk || !g || !f) return null;

  const text = world.table.polityById.get(blk.owner).name.toUpperCase();
  const extent = f.tMax - f.tMin;
  const thickness = 2 * Math.sqrt(f.pp / f.n);          // ~2 sigma across
  if (extent <= 0 || thickness <= 0) return null;

  // Scattered islands cover a huge extent with very little land, so the spine
  // runs mostly over open sea and the name ends up floating on water. Land per
  // unit of extent tells them apart from real territory. Refused unless the
  // caller has established that this country has nowhere better to write its
  // name; see nameArchipelagos.
  const sparse = g.n / (extent * thickness) < LABEL_MIN_DENSITY;
  if (sparse && !sparseOK) return null;

  // STEP 3: the stretch of solid ground the name will cover.
  //
  // denseRange exists to keep a name off the water: it hands back the one
  // cluster holding the most land and refuses to bridge a gap wider than the
  // ground either side of it. On an archipelago that answer is a single island,
  // and a name sized to a single island is the same as no name at all.
  //
  // There is no dry stretch to find on a country that is only islands, so the
  // sparse path does not look for one. It takes the whole scatter, first island
  // to last, which is where the country is and is how an atlas writes one.
  const range = sparse ? null : denseRange(f, LABEL_DENSITY_FLOOR);
  if (!sparse && !range) return null;
  const [tLo, tHi, groups] = sparse ? [f.tMin, f.tMax, 1] : range;
  const span = tHi - tLo;
  if (span <= 0) return null;

  // STEP 2: solve the 3x3 normal equations for u = a*t^2 + b*t + c by Cramer's
  // rule. That quadratic is the spine — the curve the text is set along.
  const [a2, a1, a0] = solveQuadratic(f) || [0, 0, 0];

  // STEP 4. Note which measurement each argument gets: whether stacking is
  // allowed is judged on `extent`, the block's real shape, while the type is
  // sized to `span`, the solid part. Judging on `span` would misread a long
  // thin country as round once denseRange had cut its capes off.
  // `extent` is the right measure for one landmass, where it is the span plus
  // whatever capes denseRange trimmed: judging on the span alone would read a
  // long thin country as round once its ends were cut off.
  //
  // It is the wrong measure for a country whose pieces are too far apart to have
  // been bridged, because it counts the pieces the name is not going on and the
  // sea between them.
  // A name over open water gets neither of those two judgements. It never
  // stacks, because stacked lines want a landmass with width to sit in and this
  // has none; and it is not held to the thickness of the scatter it crosses,
  // because that measures how far apart the islands are rather than how large
  // the letters may be. What still binds it is the span, so the name reaches
  // from the first island to the last and no further.
  const shape = groups > 1 ? span : extent;
  const tracking = sparse ? LABEL_SPARSE_TRACKING : LABEL_TRACKING;
  const maxLines = sparse ? 1
    : shape / thickness < LABEL_WRAP_ASPECT ? LABEL_MAX_LINES : 1;
  const laid = fitLabel(text, span, sparse ? thickness * LABEL_SPARSE_LIFT : thickness,
    maxLines, tracking);
  if (!laid) return null;

  // Only now can the curvature be limited, because the thing that limits it is
  // the size of the type.
  //
  // A curve of radius R crowds the letters on its inner side; they collide once
  // R approaches the height of the text. So the spine may bend as tightly as
  // BEND_RADIUS text-heights and no tighter — which on a strongly curved
  // country usually means no limit at all, and the spine simply follows the
  // land. Capping it by any fixed fraction of the label's length instead, as
  // this did before, straightened out exactly the curved countries that most
  // needed to bend.
  const radius = BEND_RADIUS * laid.size;
  const bendLimit = 1 / (2 * Math.max(radius, 1));
  const bend = clamp(a2, -bendLimit, bendLimit);

  // Flattening the curve means re-deriving the constant with it.
  //
  // t and u are both measured from the block's centre of mass, so the fit has
  // mean zero, which pins the constant to the curvature: a0 = -a2 * E[t^2].
  // A parabola bending downwards therefore sits ABOVE the centre at its vertex
  // and below at its ends — correct, and how it tracks a curved country. But
  // clamp the curvature and leave a0 alone and the spine keeps an offset only
  // the original, steeper curve justified: flat AND pushed off the land.
  const a0Fixed = a0 + (f.s0 ? (a2 - bend) * (f.s2 / f.s0) : 0);

  // Deliberately no minimum size. A small block just gets small type and stays
  // hidden until the zoom makes it large enough on screen to read.
  // Dropping it here instead would mean it never gets a name at any zoom.

  const L = {
    lines: laid.lines, size: clamp(laid.size, 0.05, 400),
    width: laid.width,          // widest line, in ems — see labelOpacity()
    tMid: (tLo + tHi) / 2,
    cx: g.cx, cy: g.cy, ux: g.ux, uy: g.uy,
    a2: bend, a1, a0: a0Fixed,
    // Which of the two names over this ground this is, and where the other one
    // is to be found. See realmHolds().
    block: b,
    tracking,                   // wider on a name written across open water
    sparse,
    isRealm: blk.level === 'realm',
    realmBlock: blk.realmBlock,
    spanY: blk.spanY,           // realm blocks only; see realmHolds()
  };
  L.bounds = labelBounds(L, span);
  return L;
}

/**
 * A box in MAP units that the finished label cannot escape.
 *
 * Drawing a label is not cheap — a glyph at a time, each one measured, rotated,
 * stroked and filled — and a label that is nowhere near the window should not
 * cost any of that. Zoomed in, that is nearly all of them: the type grows with
 * the land, so every name on the map passes its readability test while two are
 * actually on screen.
 *
 * Everything here is in map units and so is independent of zoom, which is why it
 * can be worked out once at build time and then only compared against the window.
 * The spine is sampled rather than solved because it is a parabola through a
 * rotated frame, and its extremes are easier to sample than to derive. The pad
 * covers what the sample cannot see: glyphs reach half a text height off the
 * spine, stacked lines reach further, and the outline sits outside even that.
 */
function labelBounds(L, span) {
  const half = span / 2;
  const pad = L.size * (L.lines.length * LABEL_LINE_HEIGHT + LABEL_OUTLINE_WIDTH + 1);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= 12; i++) {
    const { x, y } = spinePoint(L, -half + (span * i) / 12);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/**
 * Least-squares fit of u = a*t^2 + b*t + c to the block's pixels, by Cramer's
 * rule on the 3x3 normal equations. Returns [a, b, c], or null if the matrix is
 * singular — which happens when a block is too small or too straight to fit a
 * curve to, and callers then fall back to a flat spine.
 */
function solveQuadratic(f) {
  const m = [
    [f.s4, f.s3, f.s2],
    [f.s3, f.s2, f.s1],
    [f.s2, f.s1, f.s0],
  ];
  const v = [f.u2, f.u1, f.u0];
  const det = (n) =>
    n[0][0] * (n[1][1] * n[2][2] - n[1][2] * n[2][1]) -
    n[0][1] * (n[1][0] * n[2][2] - n[1][2] * n[2][0]) +
    n[0][2] * (n[1][0] * n[2][1] - n[1][1] * n[2][0]);
  const d = det(m);
  if (!isFinite(d) || Math.abs(d) < 1e-6) return null;
  const col = (i) => m.map((row, r) => row.map((val, c) => (c === i ? v[r] : val)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/**
 * Converts a position on the spine into map coordinates.
 *
 * `t` is distance along the spine from the label's centre, `u` distance across
 * it — `u` is how stacked lines are pushed apart. Returns the map point plus the
 * tangent angle there, which is the rotation a glyph at that spot needs to sit
 * square on the curve.
 */
function spinePoint(L, t, u = 0) {
  const tt = L.tMid + t;
  const off = L.a2 * tt * tt + L.a1 * tt + L.a0 + u;
  const slope = 2 * L.a2 * tt + L.a1;
  return {
    x: L.cx + L.ux * tt - L.uy * off,
    y: L.cy + L.uy * tt + L.ux * off,
    angle: Math.atan2(L.uy + L.ux * slope, L.ux - L.uy * slope),
  };
}

/**
 * How much wider the letter gaps must be at a point on the spine to hold their
 * spacing, as a multiple. 1 on a straight spine.
 *
 * A curve of radius R carries the inner edge of a line of text, half its height
 * in, around a radius of R - h/2. That inner edge travels less far than the
 * centre for the same angle, so the letters bunch up on it, and widening by
 * R / (R - h/2) gives back exactly what the curve took.
 */
/**
 * Moves `arc` along the spine from t, and returns the t it arrives at. Both are
 * in map units; `arc` may be negative.
 *
 * Along a curve of slope s, dt = ds / sqrt(1 + s*s). The slope changes as you
 * go, so this walks in a few substeps and re-reads it each time — enough for
 * text, where the spine is a gentle parabola over a few hundred pixels.
 */
function advanceT(L, t, arc) {
  if (!L.a2 && !L.a1) return t + arc;        // straight spine: nothing to correct
  const STEPS = 4;
  const d = arc / STEPS;
  for (let i = 0; i < STEPS; i++) {
    const slope = 2 * L.a2 * (L.tMid + t) + L.a1;
    t += d / Math.sqrt(1 + slope * slope);
  }
  return t;
}

function curveWiden(L, t, px) {
  if (!L.a2) return 1;
  const tt = L.tMid + t;
  const slope = 2 * L.a2 * tt + L.a1;
  const radius = Math.pow(1 + slope * slope, 1.5) / Math.abs(2 * L.a2) * view.scale;
  const inner = radius - px / 2;
  return inner > 1 ? radius / inner : 4;
}

/**
 * Draws every label, one glyph at a time so the text can follow the curve.
 *
 * Canvas has no curved-text primitive, so each character is positioned and
 * rotated on its own: walk along the line accumulating measured widths, ask
 * spinePoint() where that offset lands, then translate and rotate to draw there.
 * Each glyph is stroked before it is filled, giving the dark outline that keeps
 * white text readable over any province colour.
 */
/* ------------------------------------------------------- the glyph atlas
 *
 * Every character the labels use, drawn once and kept as a picture.
 *
 * The reason is what a zoom costs otherwise. Canvas2D cannot reuse anything
 * across a change of type size: at each new size it rebuilds the glyph's outline
 * path, and for the halo it STROKES that path, round joins and all, on the CPU.
 * A label's size is its map size times the zoom, so zooming hands it a size it
 * has never seen on every single frame, and zoomed out there are ninety-odd
 * names on screen — measured at 50 to 155ms of blocking work per frame, which is
 * the stutter. Panning never showed it, because panning does not change the size
 * and so every frame reuses the last one's work.
 *
 * A game engine avoids this by never rasterising text per frame at all: glyphs
 * live in a texture atlas and each one is drawn as a quad, so scale and rotation
 * are the GPU's problem. This is that idea in the tools available here. A baked
 * glyph is a bitmap, and drawImage of a bitmap does not care what size it is
 * being drawn at.
 *
 * Note what is cached and what is not. GLYPHS are cached — 'A' at 24px is always
 * 'A' at 24px, so nothing about the world can invalidate one. Labels are not:
 * which names exist, where their spines run and how big the type is are all
 * still worked out every frame, so a province changing hands changes the map's
 * labelling exactly as it did before.
 */

// Sizes are snapped to a ladder, since caching per exact size would mean a fresh
// bake on every frame of a zoom and no cache at all. 5% steps: the bitmap is
// then drawn at up to 2.5% off its baked size, which is not a difference anyone
// can see, and a zoom from end to end of the range touches about 90 rungs.
const GLYPH_STEP = 1.05;
const GLYPH_MIN = 3;                // below this the label has faded out anyway
const GLYPH_MAX = 512;              // device pixels, so this allows for HiDPI

// Glyphs are baked at twice the size they will be shown at, and every blit is
// therefore a reduction. Blitting at roughly 1:1 sounds cheaper and looks far
// worse: the letters land on fractional positions and at an angle, so they are
// resampled whatever their size, and resampling a 12px letter at 1:1 smears the
// dark body into its own white halo until the word goes grey. Shrinking a larger
// picture averages several source pixels into each one it puts down, which is
// what antialiasing is. The cost is four times the area per glyph, paid once.
const GLYPH_SUPERSAMPLE = 2;

// The ceiling is in PIXELS, not in entries. A bitmap's cost is its area, and
// these range over more than two orders of magnitude in size — a 200px capital
// is some fifty thousand pixels where a 3px one is a few dozen. Counting entries
// would let a few dozen large rungs quietly hold far more memory than several
// thousand small ones. 8M pixels is around 32MB, next to the 64MB the map tiles
// already hold.
const GLYPH_BUDGET_PX = 8e6;

const glyphAtlas = new Map();
let glyphAtlasPx = 0;
let glyphMeasure = null;            // scratch context, for metrics only

function glyphSize(devicePx) {
  const rung = Math.pow(GLYPH_STEP, Math.round(Math.log(devicePx) / Math.log(GLYPH_STEP)));
  return clamp(rung, GLYPH_MIN, GLYPH_MAX);
}

/**
 * One character at one size, halo and body already composited, plus the metrics
 * needed to place it: `ox`/`oy` locate the drawing origin inside the bitmap, and
 * `adv` is the advance width. All four are in the bitmap's own pixels, so a
 * caller scales every one of them by the same factor and the layout holds its
 * shape exactly — which is what keeps letterspacing even.
 *
 * A space has no ink and gets no bitmap, only an advance.
 */
function bakedGlyph(ch, size) {
  const key = `${size}|${ch}`;
  const had = glyphAtlas.get(key);
  if (had) return had;

  if (!glyphMeasure) glyphMeasure = document.createElement('canvas').getContext('2d');
  glyphMeasure.font = labelFont(size);
  // Alignment has to match how the glyph is DRAWN below, because the bounds
  // measureText returns are measured from wherever the origin would be under the
  // current alignment. Measure from the default start/alphabetic origin and draw
  // from a centre/middle one, and the box describes ink that is no longer there:
  // the bitmap comes out the wrong size and the letter is cut off in it.
  glyphMeasure.textAlign = 'center';
  glyphMeasure.textBaseline = 'middle';
  const m = glyphMeasure.measureText(ch);

  // Tight ink bounds rather than the em box, so a bitmap is no larger than the
  // mark it holds. Measured from the drawing origin, with the text centred on it.
  const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight;
  const up = m.actualBoundingBoxAscent, down = m.actualBoundingBoxDescent;
  const pad = Math.ceil(size * LABEL_OUTLINE_WIDTH / 2) + 2;   // room for the halo
  const w = Math.ceil(left + right) + pad * 2;
  const h = Math.ceil(up + down) + pad * 2;

  const g = { canvas: null, w, h, ox: left + pad, oy: up + pad, adv: m.width };

  if (w > 0 && h > 0 && (left + right) > 0 && (up + down) > 0) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.font = labelFont(size);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineJoin = 'round';
    x.lineWidth = size * LABEL_OUTLINE_WIDTH;

    // Baked at the label's own relative strengths, so the bitmap IS the finished
    // label at full opacity and a fade is one globalAlpha on the whole thing.
    // Fading halo and body separately, as this did before, let the body thin out
    // over its own halo and the two show through each other mid-fade.
    x.strokeStyle = `rgba(${LABEL_OUTLINE},${LABEL_OUTLINE_ALPHA})`;
    x.fillStyle = `rgba(${LABEL_COLOUR},${LABEL_COLOUR_OPACITY})`;
    x.strokeText(ch, g.ox, g.oy);
    x.fillText(ch, g.ox, g.oy);
    g.canvas = c;
  }

  // Dropped wholesale rather than evicted one at a time: the entries a zoom
  // leaves behind are sizes it will never be asked for again, so there is
  // nothing worth choosing between. Cleared BEFORE this glyph is added, so the
  // one being asked for right now survives the sweep.
  if (glyphAtlasPx + w * h > GLYPH_BUDGET_PX) {
    glyphAtlas.clear();
    glyphAtlasPx = 0;
  }
  glyphAtlas.set(key, g);
  glyphAtlasPx += w * h;
  return g;
}

/**
 * The rectangle one glyph occupies, kept TILTED rather than squared off.
 *
 * The obvious thing is to return an upright box around the glyph, and it is
 * wrong. Country names run at an angle, and an upright box around a tilted
 * rectangle claims the empty triangles at all four corners as well — at 45
 * degrees it is twice the area of the glyph it stands for. Set in type the size
 * these names are, those phantom corners reach far enough to block every spot a
 * city name could take, and the placement gives up on ground that is plainly
 * empty to look at.
 *
 * So the angle is kept and the overlap test does the extra work instead.
 * `cx`/`cy` are the centre — not the point the glyph was drawn from, since the
 * bitmap hangs from an origin somewhere inside it, so that offset is turned by
 * the same angle before being added on. `ax`/`ay` are the direction the glyph's
 * width runs in.
 */
function glyphBox(g, k, atX, atY, angle) {
  const w = g.w * k, h = g.h * k;
  const cos = Math.cos(angle), sin = Math.sin(angle);

  const offX = w / 2 - g.ox * k;
  const offY = h / 2 - g.oy * k;
  return {
    cx: atX + offX * cos - offY * sin,
    cy: atY + offX * sin + offY * cos,
    hw: w / 2,
    hh: h / 2,
    ax: cos,
    ay: sin,
  };
}

/**
 * Does an upright box overlap a tilted one?
 *
 * Two convex shapes miss each other exactly when some line can be drawn between
 * them, and for rectangles it is enough to try the four directions their own
 * edges face. Along each, both shapes cast a shadow; if the shadows come apart
 * anywhere, the shapes do not touch. The first two directions are the screen's
 * own axes, the last two the glyph's.
 */
/**
 * How much area an upright box and a tilted one share, in square screen pixels.
 *
 * Whether they touch at all is not enough to choose a spot by. A name laid
 * across the middle of one large letter touches exactly as many letters as one
 * clipping the corner of a single small one, so counting them calls those two
 * equally good and the first position on the list wins by default — which is
 * how a name ends up sitting squarely on a letter with clear ground beside it.
 *
 * The glyph's four corners are clipped against the box's four edges, one at a
 * time, and the shoelace formula measures whatever is left. Both shapes are
 * convex, so the clip is exact.
 */
function glyphOverlapArea(b, g) {
  const ux = g.ax * g.hw, uy = g.ay * g.hw;      // half-width vector, along the glyph
  const vx = -g.ay * g.hh, vy = g.ax * g.hh;     // half-height vector, across it
  let poly = [
    [g.cx - ux - vx, g.cy - uy - vy],
    [g.cx + ux - vx, g.cy + uy - vy],
    [g.cx + ux + vx, g.cy + uy + vy],
    [g.cx - ux + vx, g.cy - uy + vy],
  ];

  // Signed distance into the box for each of its four edges. Positive is inside.
  const edges = [
    (p) => p[0] - b[0], (p) => b[2] - p[0],
    (p) => p[1] - b[1], (p) => b[3] - p[1],
  ];
  for (const depth of edges) {
    if (poly.length < 3) return 0;
    const next = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      const da = depth(a), dc = depth(c);
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (dc >= 0)) {
        const t = da / (da - dc);                // where the edge crosses
        next.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]);
      }
    }
    poly = next;
  }
  if (poly.length < 3) return 0;

  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length];
    twice += a[0] * c[1] - c[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

/* ---------------------------------------------------------- the grid
 *
 * Placing city names asks one question over and over: what else is near this
 * rectangle. Answered by scanning every candidate, that is the number of cities
 * times the number of letters on screen times eight positions each, and it is
 * what made a map full of cities chug — at 237% zoom, 3.4ms of a 4.8ms frame,
 * for a layer that draws a few hundred small bitmaps.
 *
 * So everything on screen is bucketed into square cells first, and a question
 * only visits the cells its rectangle touches. The work stops depending on how
 * much is on the map and starts depending on how much is nearby, which for a
 * name a few pixels wide is almost nothing.
 *
 * Rebuilt every frame rather than kept: it holds SCREEN positions, and panning
 * moves all of them. Filling it is one pass over things already being walked.
 */
const GRID_CELL = 96;

function makeGrid() {
  const cells = new Map();
  let query = 0;

  // Cells a rectangle touches. The offset keeps the key positive for boxes that
  // start off the left or top of the screen; nothing here is 49000px out.
  const forCells = (x0, y0, x1, y1, fn) => {
    const c0 = Math.floor(x0 / GRID_CELL), c1 = Math.floor(x1 / GRID_CELL);
    const r0 = Math.floor(y0 / GRID_CELL), r1 = Math.floor(y1 / GRID_CELL);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) fn((r + 512) * 4096 + (c + 512));
    }
  };

  return {
    add(item, x0, y0, x1, y1) {
      forCells(x0, y0, x1, y1, (key) => {
        const list = cells.get(key);
        if (list) list.push(item);
        else cells.set(key, [item]);
      });
    },

    /**
     * Everything in the cells this rectangle touches, each returned once, into
     * `out`. An item spanning two cells is found twice, so each carries a stamp
     * of the query that last saw it — cheaper than a Set per question, and this
     * is asked thousands of times a frame.
     */
    near(x0, y0, x1, y1, out) {
      out.length = 0;
      query++;
      forCells(x0, y0, x1, y1, (key) => {
        const list = cells.get(key);
        if (!list) return;
        for (const item of list) {
          if (item.seenBy === query) continue;
          item.seenBy = query;
          out.push(item);
        }
      });
      return out;
    },
  };
}

/** The upright box a tilted glyph box fits inside. */
function glyphExtent(g) {
  const cos = Math.abs(g.ax), sin = Math.abs(g.ay);
  return [
    g.cx - (g.hw * cos + g.hh * sin), g.cy - (g.hw * sin + g.hh * cos),
    g.cx + (g.hw * cos + g.hh * sin), g.cy + (g.hw * sin + g.hh * cos),
  ];
}

/** Is this screen point inside a tilted glyph box? */
function pointInGlyph(x, y, g) {
  const dx = x - g.cx, dy = y - g.cy;
  return Math.abs(dx * g.ax + dy * g.ay) <= g.hw && Math.abs(dy * g.ax - dx * g.ay) <= g.hh;
}

/**
 * What fraction of an upright box the glyphs cover, 0 to 1.
 *
 * Sampled on a grid, so glyph boxes overlapping each other are counted once.
 * The glyphs are filtered to the ones that reach the box before any sampling,
 * which is what keeps this affordable with every letter on screen to consider.
 */
function coveredFraction(b, glyphs) {
  if (!glyphs || !glyphs.length) return 0;
  const w = b[2] - b[0], h = b[3] - b[1];
  if (w <= 0 || h <= 0) return 0;

  const near = glyphs.filter((g) => boxHitsGlyph(b, g));
  if (!near.length) return 0;

  const N = COVERAGE_SAMPLES;
  let inside = 0;
  for (let iy = 0; iy < N; iy++) {
    const y = b[1] + h * (iy + 0.5) / N;
    for (let ix = 0; ix < N; ix++) {
      const x = b[0] + w * (ix + 0.5) / N;
      if (near.some((g) => pointInGlyph(x, y, g))) inside++;
    }
  }
  return inside / (N * N);
}

function boxHitsGlyph(b, g) {
  const bx = (b[0] + b[2]) / 2, by = (b[1] + b[3]) / 2;
  const bhw = (b[2] - b[0]) / 2, bhh = (b[3] - b[1]) / 2;
  const dx = g.cx - bx, dy = g.cy - by;
  const c = Math.abs(g.ax), s = Math.abs(g.ay);

  if (Math.abs(dx) > bhw + g.hw * c + g.hh * s) return false;
  if (Math.abs(dy) > bhh + g.hw * s + g.hh * c) return false;
  if (Math.abs(dx * g.ax + dy * g.ay) > g.hw + bhw * c + bhh * s) return false;
  if (Math.abs(dy * g.ax - dx * g.ay) > g.hh + bhw * s + bhh * c) return false;
  return true;
}

/**
 * Works out where every glyph of every polity name goes, and draws none of it.
 * paintLabels() puts the result on screen.
 *
 * Split in two because the cities are drawn UNDERNEATH the names and have to
 * know what is coming: the layout has to happen before them and the drawing
 * after. Done as one function called twice, that walked, measured and placed
 * every glyph on screen twice a frame, which at a busy zoom was the single
 * largest thing in the frame.
 *
 * `boxes`, when given, is filled with the screen rectangle of every glyph. One
 * box per GLYPH rather than one per name: a country name zoomed in is enormous
 * and mostly air, and reserving the whole run of it would fence off a swathe of
 * map that a city name could have sat in quite happily between two letters.
 *
 * Returns the number of draws queued, which paintLabels() takes back.
 */
function layoutLabels(labels, cssW, cssH, dx, boxes = null) {
  labelOpCount = 0;
  const holds = realmHolds(labels, cssH);
  const s = view.scale;
  const dimming = labelDimming();

  for (const L of labels) {
    if (!L) continue;              // a block with no name, or one emptied by a change

    // Off screen, and so not worth measuring, rotating, stroking or filling a
    // single glyph of. The caller has already translated by dx for this copy of
    // the map, so that shift has to be undone to compare against the window.
    const b = L.bounds;
    if (b.x1 * s + view.x + dx < 0 || b.x0 * s + view.x + dx > cssW
      || b.y1 * s + view.y < 0 || b.y0 * s + view.y > cssH) continue;

    // L.size is in map units, so scaling by the zoom gives the size on screen.
    // Used directly and uncapped: the text grows with the land it names and keeps
    // covering the same stretch of it. A small country has a real label all
    // along; it is only skipped while too small on screen to read.
    const px = L.size * view.scale;
    let alpha;
    if (L.isRealm) {
      // A realm's name is not dropped for growing large, which is the rule for
      // every other name. It is dropped when its country fills enough of the
      // screen that its members' names are the ones worth reading, and that is
      // the same moment they arrive. It still has to be big enough to read.
      alpha = LABEL_ALPHA * smoothstep(LABEL_FADE_IN[0], LABEL_FADE_IN[1], px) * (holds.get(L.block) || 0);
    } else {
      alpha = labelOpacity(px, (L.width * px) / cssW);
      // A member stays quiet while its realm's name is doing the job, and comes
      // in as that name gives up. Two sides of one number, so they cross over.
      if (L.realmBlock !== undefined) alpha *= 1 - (holds.get(L.realmBlock) || 0);
    }
    alpha *= dimming;
    if (alpha <= 0.004) continue;              // fully faded, or not readable yet

    const gap = px * L.tracking;

    // Which rung of the ladder these glyphs are baked on, and the factor that
    // takes bitmap pixels back to screen pixels. The rung is chosen in DEVICE
    // pixels so a HiDPI screen bakes proportionally larger and stays sharp,
    // while k stays in CSS pixels to match the transform the canvas is under.
    const bake = glyphSize(px * pixelRatio * GLYPH_SUPERSAMPLE);
    const k = px / bake;

    // The halo and body are already in the bitmap, so the label's opacity is one
    // value on the whole mark rather than two on its parts. It travels with each
    // glyph rather than being set once, since the drawing happens later.

    const n = L.lines.length;
    for (let li = 0; li < n; li++) {
      // Offset each line across the spine, centred on it: with 2 lines that is
      // -0.5 and +0.5 line heights, with 3 it is -1, 0, +1. So the label as a
      // whole stays centred on the block however many lines it has. Divided by
      // view.scale because spinePoint() works in map pixels, not screen pixels.
      const across = (li - (n - 1) / 2) * LABEL_LINE_HEIGHT * px / view.scale;
      const chars = [...L.lines[li]];

      // Metrics come off the baked glyphs rather than from measureText, so the
      // layout and the pictures being placed agree by construction. Every one is
      // scaled by the same k, so the line is the baked line at a uniform scale
      // and the spacing between letters cannot drift.
      const glyphs = chars.map((c) => bakedGlyph(c, bake));
      const widths = glyphs.map((g) => g.adv * k);

      // Letters have height, so on a curve their inner edges sit closer together
      // than their centres and the word looks cramped on the inside of a bend.
      // The gap is widened to give that back — but by ONE amount for the whole
      // line, taken from the tightest point the text passes through.
      //
      // Uniform is the whole point. Curvature varies along a parabola, so
      // compensating letter by letter makes every gap slightly different, and
      // uneven letterspacing is far uglier than a bend ever was. Letters in the
      // gentler stretches get a hair more room than they strictly needed, and
      // nobody can see that; what they can see is spacing that wobbles.
      const flat = widths.reduce((s, w) => s + w, 0) + gap * (chars.length - 1);
      let at = -flat / 2, widen = 1;
      for (let i = 0; i < chars.length; i++) {
        widen = Math.max(widen, curveWiden(L, (at + widths[i] / 2) / view.scale, px));
        at += widths[i] + gap;
      }

      const spacing = gap * widen;
      const total = widths.reduce((s, w) => s + w, 0) + spacing * (chars.length - 1);

      // Walk the glyphs along the CURVE, not along the axis.
      //
      // spinePoint() takes t, a distance measured along the straight axis, but a
      // letter's width is a distance along the curve the letters actually sit
      // on. Those are not the same: where the spine is tilted by slope s, one
      // step along the axis covers sqrt(1 + s*s) of curve. Feeding widths in as
      // if they were axis distances therefore spreads the letters out wherever
      // the curve is steep and packs them where it is flat — which is uneven
      // letterspacing, and far larger than any crowding on the inside of a bend.
      //
      // advanceT() converts the other way, so every letter is placed a true
      // width plus a true gap further along the curve than the last.
      let t = advanceT(L, 0, -total / 2 / view.scale);
      for (let i = 0; i < chars.length; i++) {
        t = advanceT(L, t, widths[i] / 2 / view.scale);
        const g = glyphs[i];
        if (g.canvas) {
          const { x, y, angle } = spinePoint(L, t, across);
          const atX = x * view.scale + view.x;
          const atY = y * view.scale + view.y;

          // Queued rather than drawn. The op is reused from the pool, so a busy
          // frame allocates nothing here however many glyphs it places.
          const op = labelOps[labelOpCount] || (labelOps[labelOpCount] = {});
          op.canvas = g.canvas;
          op.dx = -g.ox * k;
          op.dy = -g.oy * k;
          op.dw = g.w * k;
          op.dh = g.h * k;
          op.atX = atX;
          op.atY = atY;
          op.angle = angle;
          op.alpha = alpha;
          labelOpCount++;

          if (boxes) boxes.push(glyphBox(g, k, atX, atY, angle));
        }
        t = advanceT(L, t, (widths[i] / 2 + spacing) / view.scale);
      }
    }
  }
  return labelOpCount;
}

/* How much of the window's HEIGHT a realm's ground has to fill before its own
 * name gives way to its members'.
 *
 * Height rather than width, and territory rather than type: what decides
 * whether you are looking at the empire or at its kingdoms is how much of the
 * screen the empire takes up, and the window is the wrong shape to judge that
 * sideways. Measured over the realm's own provinces, so a distant colony cannot
 * make an empire look larger than the part of it you are looking at.
 *
 * The pair is a crossfade rather than a switch: the parent starts giving way at
 * the first figure and the children have it entirely by the second.
 */
const REALM_HANDOVER = [0.75, 0.90];

/**
 * How much each realm's own name is standing in for its members', 1 down to 0.
 *
 * A country made of several polities has both names available over the same
 * ground, and which belongs there is a question of scale: the empire while you
 * are looking at the world, its kingdoms once the empire is what fills the
 * screen. One number decides both, so the two can only cross over and never
 * both be missing.
 */
const realmHold = new Map();
function realmHolds(labels, cssH) {
  realmHold.clear();
  for (const L of labels) {
    if (!L || !L.isRealm) continue;
    const covers = (L.spanY || 0) * view.scale / cssH;
    realmHold.set(L.block, 1 - smoothstep(REALM_HANDOVER[0], REALM_HANDOVER[1], covers));
  }
  return realmHold;
}

/* The queue layoutLabels() fills and paintLabels() empties. One array for the
 * whole program, holding objects that are written over rather than replaced:
 * this runs every frame, and a few hundred short-lived objects a frame is a few
 * hundred thousand a minute for the collector to deal with. */
const labelOps = [];
let labelOpCount = 0;

/** Blits a layout. Nothing here decides anything. */
function paintLabels(ctx, n) {
  if (!n) return;
  ctx.save();
  // The glyphs arrive as bitmaps drawn a few percent off their baked size, so
  // they need smoothing — unlike the map, which drawView deliberately draws with
  // it off once zoomed past 1:1 to keep province edges as hard pixel steps.
  ctx.imageSmoothingEnabled = true;

  let alpha = -1;
  for (let i = 0; i < n; i++) {
    const op = labelOps[i];
    if (op.alpha !== alpha) { ctx.globalAlpha = alpha = op.alpha; }
    ctx.save();
    ctx.translate(op.atX, op.atY);
    ctx.rotate(op.angle);
    // One blit of a finished picture, where this used to be a glyph path built,
    // stroked and filled from scratch at a size never seen before.
    ctx.drawImage(op.canvas, op.dx, op.dy, op.dw, op.dh);
    ctx.restore();
  }
  ctx.restore();
}

/**
 * White silhouette of one province at map resolution, cropped to its bounds.
 *
 * This is the expensive half — a per-pixel pass — so it is built once per
 * selection and reused at every zoom level.
 */
function buildSilhouette(world, id, at = world.provinceAt) {
  const bb = world.bounds.get(id);
  if (!bb) return null;

  const w = bb.maxX - bb.minX + 1;
  const h = bb.maxY - bb.minY + 1;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const index = world.byId.get(id).index;
  for (let y = 0; y < h; y++) {
    const row = (bb.minY + y) * world.width;
    for (let x = 0; x < w; x++) {
      // The box may run past the right edge of the bitmap and continue at the
      // left, so the column is taken modulo the width. The silhouette itself
      // stays one rectangle, and drawView already draws a copy of the map either
      // side of the seam, so the half past the edge lands on the copy it belongs to.
      const mx = bb.minX + x;
      if (at[row + (mx < world.width ? mx : mx - world.width)] !== index) continue;
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, x: bb.minX, y: bb.minY, w, h };
}

/**
 * A yellow-orange ring straddling the province border, OUTLINE_WIDTH thick on
 * screen whatever the zoom.
 *
 * The band is the difference of two shifted-stamp passes: a union of copies
 * offset in a circle, which grows the shape outwards by half the width, minus an
 * intersection of the same copies, which shrinks it inwards by the same amount.
 * Subtracting the second from the first leaves a band centred on the true edge,
 * so the ring lands on the border rather than beside it. A source-in fill then
 * tints the band without disturbing its shape.
 *
 * Smoothing follows the map's own rule, so a zoomed-in ring is as crisply
 * stair-stepped as the province pixels it traces instead of blurring off them.
 *
 * Holding the ring to a fixed screen thickness means rebuilding whenever the
 * zoom changes: it is rasterised at the current scale, and the width is a
 * constant in that space. A big province at deep zoom would need an enormous
 * canvas, so resolution is capped and the width shrinks to match.
 */
function buildOutline(silhouette, viewScale, colour = OUTLINE_COLOUR) {
  const half = OUTLINE_WIDTH / 2;
  const pad = Math.ceil(half) + 2;
  let scale = viewScale;
  let w = Math.ceil(silhouette.w * scale) + pad * 2;
  let h = Math.ceil(silhouette.h * scale) + pad * 2;

  if (w * h > OUTLINE_MAX_PIXELS) {
    scale *= Math.sqrt(OUTLINE_MAX_PIXELS / (w * h));
    w = Math.ceil(silhouette.w * scale) + pad * 2;
    h = Math.ceil(silhouette.h * scale) + pad * 2;
  }

  const dw = silhouette.w * scale;
  const dh = silhouette.h * scale;
  const r = half * scale / viewScale;            // ring half-width, in canvas pixels
  const STEPS = 16;                              // enough that the band has no scallops
  const offsets = [];
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2;
    offsets.push([Math.cos(a) * r, Math.sin(a) * r]);
  }

  const layer = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = viewScale < 1;     // same rule the map is drawn by
    x.drawImage(silhouette.canvas, pad, pad, dw, dh);
    return [c, x];
  };

  const [outer, octx] = layer();                 // union: the shape grown outwards
  for (const [dx, dy] of offsets) octx.drawImage(silhouette.canvas, pad + dx, pad + dy, dw, dh);

  const [inner, ictx] = layer();                 // intersection: the shape shrunk inwards
  ictx.globalCompositeOperation = 'destination-in';
  for (const [dx, dy] of offsets) ictx.drawImage(silhouette.canvas, pad + dx, pad + dy, dw, dh);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(outer, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(inner, 0, 0);                    // hollow it out, leaving the band
  ctx.globalCompositeOperation = 'source-in';    // tint, preserving the edge
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);

  // Report the ring in map coordinates, so drawing it needs no special case.
  return {
    canvas,
    x: silhouette.x - pad / scale,
    y: silhouette.y - pad / scale,
    w: w / scale,
    h: h / scale,
    builtFor: viewScale,
  };
}

// ===================================================================== 5. view
//
// The pan/zoom transform, and putting the finished buffer on screen.
//
//   map -> screen:  sx = mx * scale + view.x
//   screen -> map:  mx = (sx - view.x) / scale
//
// `view` is the only state involved, and changing it needs no repaint of the
// buffer — just another blit.

const MIN_SCALE = 0.25;         // zoomed out: whole world, small
const MAX_SCALE = 16;           // zoomed in: individual map pixels visible
const view = { scale: 1, x: 0, y: 0 };   // x,y are the screen position of map pixel (0,0)

/*
 * A ceiling on the canvas's own pixel buffer.
 *
 * Everything drawn each frame is rasterised and composited by the browser at
 * this size, and that cost is paid whether or not anything moved. It is by far
 * the largest thing in a frame on a big screen: a 2560x1440 window at 150%
 * display scaling asks for 3600x1950, which is 7 million pixels and takes the
 * frame rate from 60 to under 20 with the map otherwise unchanged.
 *
 * So the buffer is capped and the device ratio reduced to fit. The map is then
 * drawn at slightly under native resolution on very large or high-density
 * screens, which softens edges a little and is not close to the cost of missing
 * two frames in three.
 *
 * 4 million is about 2600x1500, which is sharp on any ordinary display and
 * leaves the browser a frame's worth of compositing to do rather than three.
 */
const MAX_CANVAS_PX = 4e6;

// What the canvas is actually being drawn at, as against what the display asked
// for. Set by drawView every frame and read by the glyph atlas, which bakes at
// device resolution and would otherwise bake for pixels that no longer exist.
let pixelRatio = 1;

/** Device pixels per CSS pixel, reduced if the buffer would be too large. */
function ratioFor(cssW, cssH) {
  const want = window.devicePixelRatio || 1;
  const area = Math.max(1, cssW * cssH);
  return Math.min(want, Math.sqrt(MAX_CANVAS_PX / area));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const screenToMap = (sx, sy) => ({ x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale });

/**
 * Zooms by `factor` about the point (sx,sy) on screen.
 *
 * The map point under the cursor is found first, then the offset is recomputed
 * so that same point lands back under the cursor afterwards. That is what makes
 * wheel-zoom feel anchored rather than drifting toward the middle.
 */
function zoomAt(sx, sy, factor) {
  const before = screenToMap(sx, sy);
  view.scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  view.x = sx - before.x * view.scale;
  view.y = sy - before.y * view.scale;
  clampPan();
  invalidateView();
}

const zoomCentre = (factor) => zoomAt(els.canvas.clientWidth / 2, els.canvas.clientHeight / 2, factor);

/**
 * Keeps the map from being dragged completely out of sight. At least a quarter
 * of the viewport must still hold map, in both directions.
 */
function clampPan() {
  const w = state.world;
  if (!w) return;
  const vh = els.canvas.clientHeight;

  // East-west the map loops, so there is nothing to clamp against — instead the
  // offset is wrapped back into a single map width. Panning east for long enough
  // brings you round to where you started, and view.x cannot drift off into
  // numbers large enough to lose precision.
  const span = w.width * view.scale;
  if (span > 0) view.x = ((view.x % span) + span) % span - span;

  // North-south there is no wrapping — the poles are not joined — so this still
  // holds at least a quarter of the viewport over the map.
  view.y = clamp(view.y, -w.height * view.scale + vh * 0.25, vh * 0.75);
}

/** Scales and centres so the whole map is visible, with a 4% margin. */
function fitToView() {
  const w = state.world;
  if (!w) return;
  const vw = els.canvas.clientWidth;
  const vh = els.canvas.clientHeight;
  view.scale = clamp(Math.min(vw / w.width, vh / w.height) * 0.96, MIN_SCALE, MAX_SCALE);
  view.x = (vw - w.width * view.scale) / 2;
  view.y = (vh - w.height * view.scale) / 2;
  clampPan();          // normalises the wrapped x, so it starts where panning would leave it
  invalidateView();
}

/**
 * Draws one frame: the map buffer, then the selection ring, then the labels.
 *
 * This is the cheap half of drawing — three composited layers, no per-pixel work
 * — which is why panning and zooming can run at frame rate.
 */
/**
 * The horizontal offsets at which the map has to be drawn to fill the window.
 *
 * The map repeats east-west, so more than one copy of it can be on screen at
 * once — at the seam you see the far edge of the map continuing into the near
 * one. clampPan() keeps view.x within one map width of the origin, so this is
 * usually one or two copies, and three only on a very wide window.
 *
 * Offsets are in screen pixels and are added to view.x.
 */
function wrapOffsets(cssW, originX = view.x) {
  const span = state.world.width * view.scale;      // one map width, on screen
  const out = [];
  const first = Math.floor((0 - originX - span) / span) + 1;
  const last = Math.ceil((cssW - originX) / span) - 1;
  for (let k = first; k <= last; k++) out.push(k * span);
  return out.length ? out : [0];
}

/**
 * The part of one copy of the map that is on screen, in map pixels, or null if
 * none of it is. `vx` is where that copy's left edge sits.
 *
 * Taken outwards to whole map pixels, so nothing shears along the edges. Three
 * layers ask this same question every frame — the map itself, the terminator
 * over it and the chunk grid — and they have to agree exactly, or the night
 * would be cut to a different rectangle than the ground it is falling on.
 */
function visibleRect(vx, cssW, cssH) {
  const s = view.scale;
  const w = state.world;
  const x0 = clamp(Math.floor(-vx / s), 0, w.width);
  const y0 = clamp(Math.floor(-view.y / s), 0, w.height);
  const x1 = clamp(Math.ceil((cssW - vx) / s), 0, w.width);
  const y1 = clamp(Math.ceil((cssH - view.y) / s), 0, w.height);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * Blits one copy of the map. `vx` is where its left edge sits on screen, which
 * for the wrapped copies is view.x plus some multiple of the map's width.
 */
function drawMapLayer(ctx, cssW, cssH, vx) {
  const s = view.scale;
  const rect = visibleRect(vx, cssW, cssH);
  if (!rect) return;
  const { x0: sx0, y0: sy0, x1: sx1, y1: sy1 } = rect;

  if (overviewCovers(s)) {
    // Zoomed out far enough that the overview holds at least as many pixels as
    // the screen can show, so drawing from it loses nothing and rescales about
    // a tenth as much data. This is the common case, and the whole reason the
    // overview exists: at fit zoom the entire map is visible, and going tile by
    // tile would mean rescaling all 15.9 million pixels on every frame.
    // Destination EDGES are rounded, not the width — the same rule the tiles
    // use. Two copies of the map meeting at the seam compute that shared edge
    // from the same number, so they resolve it to the same integer and abut
    // exactly. Left fractional, each copy's edge is antialiased against the
    // background and the page shows through the join as a hairline.
    const o = overview.scale;
    // Edges expand OUTWARD, so neighbouring draws overlap by up to a pixel
    // instead of meeting at one. Rounding both to the same integer is exact in
    // arithmetic and still leaves a seam on screen, because each draw filters
    // its own edge pixel from its own side of the boundary and the two halves
    // do not add up to one whole pixel of map. Overlapping costs nothing here:
    // the tiles are opaque, the content either side of the join is the same
    // map, and whichever draw lands second is right about what belongs there.
    const dx0 = Math.floor(vx + sx0 * s), dx1 = Math.ceil(vx + sx1 * s);
    const dy0 = Math.floor(view.y + sy0 * s), dy1 = Math.ceil(view.y + sy1 * s);
    if (dx1 <= dx0 || dy1 <= dy0) return;
    ctx.drawImage(
      overview.canvas,
      sx0 * o, sy0 * o, (sx1 - sx0) * o, (sy1 - sy0) * o,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
    return;
  }

  // Zoomed in: full resolution, but only the chunks actually on screen. Every
  // tile beyond the window is skipped outright.
  for (const tile of tilesOver(sx0, sy0, sx1, sy1)) {
    const ax0 = Math.max(sx0, tile.x), ay0 = Math.max(sy0, tile.y);
    const ax1 = Math.min(sx1, tile.x + tile.w), ay1 = Math.min(sy1, tile.y + tile.h);
    if (ax1 <= ax0 || ay1 <= ay0) continue;

    // Expanded outward, for the reason given in the overview branch above.
    const dx0 = Math.floor(vx + ax0 * s), dx1 = Math.ceil(vx + ax1 * s);
    const dy0 = Math.floor(view.y + ay0 * s), dy1 = Math.ceil(view.y + ay1 * s);
    ctx.drawImage(
      tile.canvas,
      ax0 - tile.x, ay0 - tile.y, ax1 - ax0, ay1 - ay0,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
    debug.tilesDrawn++;
  }
}

/* ------------------------------------------------------------ the night layer
 *
 * Drawn over the finished map, once per frame, in three steps: the darkening,
 * then the city lights cut to the same shape and added over it.
 *
 * All of it is positioned from `originX`, which is where the map would be if
 * the sun were over its centre column. That single offset is the hour: see
 * sunShiftPx. The layer wraps east-west on its own account, on a period of one
 * map width, and at most hours it is out of step with the ground by some
 * fraction of a width — which is why it is positioned from its own offset and
 * not from the map's. It is drawn in one piece across the window rather than
 * tiled; see ensureNightStrip for why that matters.
 */

/**
 * The mask, laid out as whole periods side by side.
 *
 * The terminator is periodic in longitude, and the obvious way to draw a
 * periodic thing across a wrapping map is to tile copies of it. That was the
 * way this worked and it was wrong twice over. Each copy had to be clamped to
 * the map and the two ends had to meet, and where they met the upscale had
 * nothing to interpolate towards, so the gradient flattened for the last few map
 * pixels of each copy and two flat ends side by side read as a line down the map.
 * Bleed columns did not help, because a source rectangle stops the sampler
 * reaching them. Clipping the copies to their exact abutting range did not
 * either: a canvas clip is antialiased, so the boundary pixel is shared between
 * two draws that each cover part of it, and at some zooms they do not add back up
 * to one. That is a seam that flickers as you zoom, which is worse than a seam.
 *
 * Copying the period into a strip at integer offsets and no scaling did not fix
 * it either, though every pixel provably landed on a pixel and the mask's own
 * columns measured continuous across the repeat — the smallest step of all 750
 * of them, at every season checked.
 *
 * So the strip is not assembled at all, it is COMPUTED: every column of it comes
 * from the same formula the mask does, and it goes down in one putImageData.
 * There is no join anywhere in it to be wrong about. The whole visible width is
 * then one drawImage out of that strip, so nothing meets anything on the way to
 * the screen either.
 *
 * The pixel loop runs over a few periods rather than one, and it runs when the
 * DAY changes. The sun moving through the day is this strip being sampled at a
 * different offset, not rebuilt.
 */
function ensureNightStrip(mask, need) {
  const p = mask.period, h = mask.canvas.height;
  const reps = Math.max(2, need);

  if (!mask.strip || mask.reps < reps) {
    mask.strip = document.createElement('canvas');
    mask.strip.width = reps * p;
    mask.strip.height = h;
    mask.stripCtx = mask.strip.getContext('2d');
    mask.stripImg = mask.stripCtx.createImageData(reps * p, h);
    mask.reps = reps;
    mask.stripDay = null;                 // a new canvas holds nothing yet
  }
  if (mask.stripDay === mask.dayOfYear) return mask;

  // COMPUTED, not copied. Repeating the period by blitting it several times is
  // exact on paper — integer offsets, no scaling, so every pixel lands on a
  // pixel — and the mask's own columns were measured continuous across the
  // repeat, the smallest step of all 750 of them. It still left a line, and the
  // only thing left between "the numbers are right" and "the screen is wrong" is
  // the join between two draws. So there is no join: every column of the strip
  // is worked out from the same formula the mask itself uses, and the whole
  // thing goes down in one putImageData.
  //
  // The cost is the pixel loop run over a few periods instead of one, and it
  // runs when the DAY changes, not when the hour does. The sun moving through
  // the day is the strip being sampled at a different offset, not rebuilt.
  const { cosLon, sinLat, cosLat, stripImg: img } = mask;
  const data = img.data;
  const dec = solarDeclination(mask.dayOfYear);
  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  const span = NIGHT_DAY_START - NIGHT_FULL_DARK;

  // mask.reps, NOT the reps asked for. The strip is kept when the window needs
  // fewer periods than it already holds, so the two part company as soon as you
  // zoom in, and filling a four-period image with a two-period stride shears
  // every row against the one above it.
  const cw = mask.reps * p;

  // Alpha only, as everywhere else: the mask is black throughout at varying
  // opacity, so red, green and blue keep the zero they were allocated with.
  for (let y = 0; y < h; y++) {
    const a = sinLat[y] * sinDec;
    const b = cosLat[y] * cosDec;
    let o = y * cw * 4 + 3;
    for (let x = 0; x < cw; x++, o += 4) {
      let t = (a + b * cosLon[x % p] - NIGHT_FULL_DARK) / span;   // 0 night, 1 day
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = t * t * (3 - 2 * t);                                   // ease the twilight band
      data[o] = Math.round(255 * (1 - t));
    }
  }
  mask.stripCtx.putImageData(img, 0, 0);
  mask.stripDay = mask.dayOfYear;
  return mask;
}

/** The whole terminator across the window, in one piece. */
function blitNightMask(ctx, mask, originX, cssW, cssH) {
  const s = view.scale, w = state.world;
  const k = mask.scale;

  // North and south do not wrap, so the rows are clamped to the map exactly as
  // the map layer clamps them.
  const ry0 = clamp(Math.floor(-view.y / s), 0, w.height);
  const ry1 = clamp(Math.ceil((cssH - view.y) / s), 0, w.height);
  if (ry1 <= ry0) return;

  // OUTWARD, not to the nearest. The map's first and last rows land wherever
  // the zoom puts them, on a fraction of a pixel. Rounding to the nearest here
  // lands short of that edge about half the time, and what shows in the
  // shortfall is a hairline of map that never got dark, a bright line straight
  // across the top and the bottom.
  //
  // Rounding outward cannot leave one. It can spill a fraction of a pixel past
  // the map instead, onto the backdrop, which is already very nearly black and
  // does not care.
  const dy0 = Math.floor(view.y + ry0 * s), dy1 = Math.ceil(view.y + ry1 * s);
  if (dy1 <= dy0) return;

  // East and west do wrap, so every column of the window has a longitude and
  // there is nothing to clamp: the strip covers the lot.
  const mx0 = -originX / s, mx1 = (cssW - originX) / s;
  ensureNightStrip(mask, Math.ceil((mx1 - mx0) / w.width) + 1);

  const phase = mx0 - Math.floor(mx0 / w.width) * w.width;   // 0 .. one map width
  ctx.drawImage(mask.strip,
    phase * k, ry0 * k, (mx1 - mx0) * k, (ry1 - ry0) * k,
    0, dy0, cssW, dy1 - dy0);
}

/** The same, for a bitmap held at full map resolution rather than at mask scale. */
function blitMapBitmap(ctx, bitmap, vx, cssW, cssH) {
  const s = view.scale;
  const rect = visibleRect(vx, cssW, cssH);
  if (!rect) return;

  const dx0 = Math.round(vx + rect.x0 * s), dx1 = Math.round(vx + rect.x1 * s);
  const dy0 = Math.round(view.y + rect.y0 * s), dy1 = Math.round(view.y + rect.y1 * s);
  if (dx1 <= dx0 || dy1 <= dy0) return;

  ctx.drawImage(bitmap,
    rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0,
    dx0, dy0, dx1 - dx0, dy1 - dy0);
}

const RIVER_AT = 2.55;              // zoom at or above which the rivers are on the map

/**
 * How much of the ground a river hides at its strongest.
 *
 * Never one, and low. A river is drawn in very nearly black, so at any real
 * strength it reads as a crack in the map rather than as water in a landscape,
 * and the drainage is dense enough in places that a strong line becomes scribble.
 * At a third the terrain under it still carries the picture and the river is
 * something you notice when you look for it. It is one number: raise it if they
 * are too faint to trace.
 */
const RIVER_ALPHA = 0.34;

/**
 * The rivers, over the finished ground and under the night.
 *
 * Under the night on purpose. A river is part of the landscape, so it goes dark
 * with the rest of the landscape at midnight; drawn over the terminator it would
 * stay bright through the night and read as something on the interface rather
 * than something in the world.
 *
 * data/img/rivers.png is transparent everywhere except the rivers, which is what
 * lets this be one blit rather than a mask and a fill. Nothing is tinted here:
 * the colour is in the file. See the rivers pass in sync-provinces.js.
 *
 * They fade in with zoom because a river is one pixel wide on the map. Below
 * RIVER_AT a screen pixel covers several map pixels, so what would be drawn is
 * not a river but a dotted line where the sampling happened to land on one.
 */
function drawRivers(ctx, cssW, cssH) {
  const w = state.world;
  const fade = cityFade(F_RIVER);
  if (!state.showRivers || !w.rivers || fade <= 0.004) return;

  // Drawn by the same rule as the ground: nearest-neighbour while magnified, so
  // a river stays as sharp as the map under it. Smoothing it was tried and only
  // made it blurry, which is a worse thing to have on the map than a hard line.
  ctx.save();
  ctx.globalAlpha = RIVER_ALPHA * fade;
  for (const dx of wrapOffsets(cssW)) blitMapBitmap(ctx, w.rivers, view.x + dx, cssW, cssH);
  ctx.restore();
}

/**
 * The lit cities on the night side.
 *
 * The lights belong to the ground and the mask belongs to the hour, so the two
 * are positioned differently and the cut between them has to happen somewhere.
 * It happens on layers the size of the window: the lights are laid down where
 * the map is, the terminator is assembled over them, and what survives the cut
 * goes onto the map with `lighter`, since a lit city adds to what is under it
 * rather than replacing it.
 *
 * THE MASK IS ASSEMBLED IN FULL BEFORE ANY OF IT CUTS ANYTHING. That is not an
 * economy, it is the difference between right and wrong. `destination-in`
 * composites the source against the ENTIRE destination rather than against the
 * rectangle being drawn, so cutting with one wrapped copy of the mask and then
 * another means the second erases everything the first one kept — the lights
 * survive only under the last copy drawn, and vanish everywhere else.
 *
 * Two copies is the ordinary case rather than a corner one. The map wraps
 * east-west and the terminator wraps on its own offset, which slides a full map
 * width through the course of a day, so the number of copies changes twice a
 * day at any given zoom. At 200% on a 1920px window those moments are 19:40 and
 * 23:40, which is why this read as the lights glitching at midnight.
 *
 * This is the expensive half of the layer and it is why the Day and night
 * switch is worth having. It is skipped outright when there is no lights
 * bitmap, when the map mode asks for no lights, and when the layer is off.
 */
function drawCityLights(ctx, cssW, cssH, originX, alpha) {
  const w = state.world;

  // The lights sit on the ground, so they take the map's own offsets and the
  // map's own smoothing rule. Several copies here are harmless: each draws only
  // into its own stretch of window and none of them disturbs the others.
  const lights = viewportLayer('cityLights', cssW, cssH, NIGHT_LIGHT_SCALE);
  lights.ctx.imageSmoothingEnabled = view.scale < 1;
  for (const dx of wrapOffsets(cssW)) blitMapBitmap(lights.ctx, w.night, view.x + dx, cssW, cssH);

  // The terminator, over the whole window, before it is used for anything.
  const mask = viewportLayer('nightMask', cssW, cssH, NIGHT_LIGHT_SCALE);
  mask.ctx.imageSmoothingEnabled = true;
  blitNightMask(mask.ctx, w.nightMask, originX, cssW, cssH);

  // One cut, against a mask that already covers everything it has to. The
  // mask's alpha is how much night it is, so what comes through is the lights
  // at exactly that strength: full where it is dark, nothing in daylight, and
  // fading across the twilight band.
  lights.ctx.globalCompositeOperation = 'destination-in';
  lights.ctx.drawImage(mask.canvas, 0, 0, mask.w, mask.h, 0, 0, cssW, cssH);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.drawImage(lights.canvas, 0, 0, lights.w, lights.h, 0, 0, cssW, cssH);
  ctx.restore();
}

/** Darkens the night side of the map and lights its cities. */
/**
 * Whether any of the visible map is dark enough to be worth drawing.
 *
 * Sampled on a coarse grid over the visible rectangle. The terminator is a
 * smooth curve hundreds of pixels across, so it cannot hide between samples at
 * this spacing, and a window looking at the middle of the day side then costs
 * nothing at all instead of nine window-sized composites that add up to zero.
 */
const NIGHT_PROBE = 5;

function anyNightVisible(world, cssW, cssH) {
  const dec = solarDeclination(sunDayOfYear);
  const sunLon = subsolarLongitude(sunUtcHour, world.width);

  // Every copy of the map that is on screen, not just the one at view.x.
  //
  // Near the seam two copies are visible and they show different longitudes.
  // Testing only the first one lets a window whose left half is in daylight
  // decide there is no night anywhere, and the layer is then skipped for the
  // right half as well, which is holding the terminator.
  for (const dx of wrapOffsets(cssW)) {
    const rect = visibleRect(view.x + dx, cssW, cssH);
    if (!rect) continue;

    for (let i = 0; i <= NIGHT_PROBE; i++) {
      const lat = mapLatAt(rect.y0 + ((rect.y1 - rect.y0) * i) / NIGHT_PROBE);
      for (let j = 0; j <= NIGHT_PROBE; j++) {
        const lon = mapLonAt(rect.x0 + ((rect.x1 - rect.x0) * j) / NIGHT_PROBE, world.width);
        if (sinSolarElevation(lat, lon, dec, sunLon) < NIGHT_DAY_START) return true;
      }
    }
  }
  return false;
}

function drawNightLayer(ctx, cssW, cssH) {
  const w = state.world;
  if (!state.showNight || !w.nightMask) return;
  if (!anyNightVisible(w, cssW, cssH)) return;

  const originX = view.x + sunShiftPx(w) * view.scale;
  const dark = nightStrength(NIGHT_DARKEN);

  if (dark > 0.004) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;      // a smooth gradient, drawn eight times its size
    ctx.globalAlpha = dark;
    blitNightMask(ctx, w.nightMask, originX, cssW, cssH);
    ctx.restore();
  }

  const lit = nightStrength(NIGHT_LIGHTS);
  if (w.night && lit > 0.004) drawCityLights(ctx, cssW, cssH, originX, lit);
}

/**
 * Draws the ring around a province, at `alpha`.
 *
 * `holder` is anything carrying a silhouette and a cached ring — the live
 * selection, or one that is fading out. The ring holds a constant thickness on
 * screen, so it is rebuilt whenever the zoom changes; panning leaves it alone,
 * and each holder caches its own so the two never rebuild each other's.
 */
function drawSelectionRing(ctx, holder, alpha, colour = OUTLINE_COLOUR) {
  if (!holder.silhouette || alpha <= 0) return;
  // Each holder caches its own, so two rings in different colours do not
  // rebuild each other every frame.
  if (holder.outline?.builtFor !== view.scale) {
    holder.outline = buildOutline(holder.silhouette, view.scale, colour);
  }
  const o = holder.outline;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(o.canvas, o.x * view.scale + view.x, o.y * view.scale + view.y, o.w * view.scale, o.h * view.scale);
  ctx.restore();
}

function drawView() {
  const canvas = els.canvas;

  // Match the canvas's pixel buffer to the physical display, up to the ceiling
  // in MAX_CANVAS_PX. Without this the map is resampled by the browser and looks
  // soft on a high-DPI screen; without the ceiling a large screen at 150% asks
  // for seven million pixels a frame and the frame rate collapses. The transform
  // then lets everything below be written in CSS pixels regardless.
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const dpr = ratioFor(cssW, cssH);
  pixelRatio = dpr;
  if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
  if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The deep steel the map is drawn onto.
  ctx.fillStyle = '#0c1015';      // matches --steel-deepest in index.html
  ctx.fillRect(0, 0, cssW, cssH);

  // Smooth only when shrinking the map. Zoomed in, nearest-neighbour keeps the
  // province edges as the hard pixel steps they are instead of blurring them.
  ctx.imageSmoothingEnabled = view.scale < 1;

  // Everything is drawn once per visible copy of the map. The map itself takes
  // the copy's own left edge; the layers over it are simpler to shift with a
  // translate, since they all position themselves from view.x already.
  const offsets = wrapOffsets(cssW);
  debug.tilesDrawn = 0;
  // Emptied here and not in drawResources, which runs once per copy of the map.
  resourceHits.length = 0;
  for (const dx of offsets) drawMapLayer(ctx, cssW, cssH, view.x + dx);

  // Over the ground, under everything else that is not the ground.
  drawRivers(ctx, cssW, cssH);

  // Over the finished ground and under everything else. Night falls on the map
  // rather than on the interface, so the selection ring, the country names and
  // the city marks all stand on top of it and stay as legible at midnight as at
  // noon. It is drawn once for the whole window rather than once per copy of
  // the map, because it wraps on its own offsets — see the note on the layer.
  const tNight = performance.now();
  drawNightLayer(ctx, cssW, cssH);
  perf.night = ease(perf.night, performance.now() - tNight);

  for (const dx of offsets) {
    ctx.save();
    ctx.translate(dx, 0);

    drawSelectionRing(ctx, state, 1);
    if (state.fade) drawSelectionRing(ctx, state.fade, fadeStrength());
    if (state.county) drawSelectionRing(ctx, state.county, COUNTY_RING_ALPHA, COUNTY_RING_COLOUR);

    // Cities UNDER the country names. A country name belongs to the land it is
    // written across, and a city sits on that land, so the name passing over it
    // is the right way round. A city buried by one leaves the map rather than
    // fighting for the space: see CITY_BLOCKED_AT.
    //
    // Drawing them in that order means the country names have to be laid out
    // before the cities and painted after, which is why those are two steps.
    //
    // A selection turns all of that around. The country names stand back to a
    // fifth of their strength, and the order goes with them: the cities come out
    // on top, keep their names, and take their natural positions, because the
    // whole reason for standing the names back is to read what is under them.
    const showNames = state.showLabels && state.world.labels;
    const wantBoxes = state.showCities && showNames && !state.selected
      && (cityFade(F_CITY_NAME) > 0.004 || cityFade(F_CAPITAL_NAME) > 0.004);
    const labelBoxes = wantBoxes ? [] : null;

    const tLabels = performance.now();
    const ops = showNames ? layoutLabels(state.world.labels, cssW, cssH, dx, labelBoxes) : 0;
    perf.labels = ease(perf.labels, performance.now() - tLabels);

    const cityLayer = () => {
      if (!state.showCities) return;
      const t0 = performance.now();
      drawCities(ctx, cssW, cssH, dx, labelBoxes);
      perf.cities = ease(perf.cities, performance.now() - t0);
    };
    const nameLayer = () => paintLabels(ctx, ops);
    if (state.selected) { nameLayer(); cityLayer(); } else { cityLayer(); nameLayer(); }
    if (state.mode === 'resources') drawResources(ctx, cssW, cssH, dx);
    drawOverlays(ctx, cssW, cssH, dx);
    ctx.restore();
  }
}

// ========================================================== 6. debug overlays
//
// Everything the debug menu can switch on. All of it draws in screen space over
// the finished map, none of it touches the buffer, and none of it costs anything
// while switched off. Panning and zooming already redraw, so a toggle only has
// to invalidate the view.

const NAME_MIN_PX = 30;        // province must be at least this wide on screen to be named
const OVERLAY_FONT = `500 11px ${LABEL_FACE}`;

// Filled in as the overlays draw, and read back by the Performance readout.
const debug = { names: 0, seaNames: 0, tilesDrawn: 0, path: '—', cursor: null };


/* --------------------------------------------------------------- cities
 *
 * Two rules, and nothing else:
 *
 *   1. A THRESHOLD decides whether a thing is on the map. Zoom is at or past
 *      it, the thing belongs; below it, it does not.
 *   2. When that answer changes, its opacity TRANSITIONS between 0 and 1 over a
 *      fixed number of milliseconds. The transition knows nothing about zoom.
 *
 * There are four of them — city icons, capital icons, city names, capital names
 * — each with its own threshold and its own opacity, and all four run the same
 * code. Icons are drawn at a fixed size on screen, not scaled with the map: a
 * city is a point, and a dot that grew to fill a province would read as a region.
 */

const CITY_AT = 1.30;               // zoom at or above which each is on the map
const CAPITAL_AT = 0.50;
const CITY_NAME_AT = 2.25;
const CAPITAL_NAME_AT = 1.30;
const CITY_FADE_MS = 150;           // how long the transition takes, always

const CITY_ICON_PX = 9;            // on-screen height of an ordinary city
const CAPITAL_ICON_PX = 14;         // and of a capital
const CITY_NAME_PX = 12;            // name sizes, likewise fixed on screen
const CAPITAL_NAME_PX = 13;
const CITY_NAME_GAP = 2;            // clearance between an icon and its name
const CITY_NAME_PAD = 2;            // breathing room when testing for overlaps

// How much of a city's ICON a country name may cover before the city drops off
// the map entirely, dot and name together.
//
// The country names are drawn over the cities, so past some point the dot is no
// longer really on the map: it is under a letter, showing as a few stray pixels
// around the edges of one. That reads as dirt on the letter rather than as a
// city, so it goes, and the name with it. The icon is what is tested rather
// than the name, because the icon is the thing that is fixed in place — a name
// has eight positions to try and can usually find one, while a dot in the
// middle of a letter is stuck there.
//
// Nothing is lost by it. Selecting the province stands the country names back,
// and everything under them returns.
const CITY_BLOCKED_AT = 0.85;

// Resolution of that test, per side. Coverage is SAMPLED rather than summed
// from the glyph rectangles because those overlap each other: two letters
// crossing the same dot would each report their share of it and the total would
// come out over the true figure, which on a threshold matters. 8x8 puts the
// answer within about a percent and a half, and only the glyphs that reach the
// icon at all are ever sampled.
const COVERAGE_SAMPLES = 8;

// Deliberately the inverse of the polity labels: light text on a dark halo,
// where a country name is dark text on a light one. Two kinds of name on the
// same map should not look like the same kind of thing, and reversing the
// contrast separates them at a glance without another colour or another font.
const CITY_NAME_COLOUR = LABEL_OUTLINE;
const CITY_NAME_OUTLINE = LABEL_COLOUR;

/* --- international cities
 *
 * A handful of cities have an international concession beside them, drawn as a
 * city of its own a few map pixels away: "International Chuhai" next to
 * "Chuhai". Icons are a fixed size on screen, so those few map pixels are a
 * fraction of one icon until the zoom is deep enough to separate them, and the
 * pair reads as one smudged dot with two names fighting over it.
 *
 * So below CITY_MERGE_AT the concession is not drawn at all and the city it
 * belongs to stands for both. Above it they are two marks, which is what they
 * are.
 *
 * The pairing is by name and confirmed by distance: "International X" folds
 * into the nearest "X", and only if that X is close enough to be the same
 * place. Nothing in the data marks a city as a concession, and inferring it
 * from the name alone would fold together two cities that merely share one.
 */
const CITY_MERGE_AT = 3.0;
const CITY_MERGE_MAX_PX = 30;     // in map pixels

/**
 * A city's name, drawn once into its own bitmap and kept.
 *
 * The country names have been baked since the glyph atlas went in. City names
 * were not, and were still being shaped, stroked and filled as live text twice
 * over — once for the halo, once for the body — for every city on screen on
 * every frame. On a map with a few hundred cities that is several hundred text
 * rasterisations a frame, which is affordable on a fast machine and is not on a
 * slow one.
 *
 * Baking is far easier here than it was for the country names. A city name is
 * horizontal, never curved, and always one of two sizes, so the whole string
 * goes into one bitmap rather than a glyph at a time, and the cache never grows
 * beyond two entries per city.
 *
 * Baked at device resolution so it stays sharp, and drawn back at CSS size.
 */
const cityNameCache = new Map();
let cityNameMeasure = null;

function bakedCityName(name, px) {
  const scale = Math.max(1, pixelRatio);
  const key = px + '|' + scale.toFixed(2) + '|' + name;
  const had = cityNameCache.get(key);
  if (had) return had;

  if (!cityNameMeasure) cityNameMeasure = document.createElement('canvas').getContext('2d');
  cityNameMeasure.font = labelFont(px);
  const width = cityNameMeasure.measureText(name).width;

  const pad = Math.ceil(px * LABEL_OUTLINE_WIDTH) + 2;
  const w = Math.ceil(width) + pad * 2;
  const h = Math.ceil(px * 1.6) + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);

  const x = canvas.getContext('2d');
  x.scale(scale, scale);
  x.font = labelFont(px);
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.lineJoin = 'round';
  x.lineWidth = px * LABEL_OUTLINE_WIDTH;
  x.strokeStyle = `rgba(${CITY_NAME_OUTLINE},${LABEL_OUTLINE_ALPHA})`;
  x.fillStyle = `rgba(${CITY_NAME_COLOUR},${LABEL_COLOUR_OPACITY})`;
  x.strokeText(name, w / 2, h / 2);
  x.fillText(name, w / 2, h / 2);

  // `half` is what the placement works in: half the text's own width, without
  // the padding the bitmap carries for its halo.
  const baked = { canvas, w, h, half: width / 2 };
  cityNameCache.set(key, baked);
  return baked;
}

function linkInternationalCities(cities) {
  const byName = new Map();
  for (const c of cities) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }

  for (const c of cities) {
    const base = /^International\s+(.+)$/i.exec(c.name)?.[1];
    if (!base) continue;

    let into = null, best = CITY_MERGE_MAX_PX;
    for (const q of byName.get(base) || []) {
      const d = Math.hypot(q.x - c.x, q.y - c.y);
      if (d < best) { best = d; into = q; }
    }
    if (!into) continue;

    c.mergesInto = into;
    // A concession can be the capital while the city it sits beside is not, and
    // capitals are on the map from far further out than cities are. So while
    // the two are merged the surviving mark carries the capital, or the country
    // would appear to have no capital at every zoom below the split.
    if (c.capital) into.absorbsCapital = true;
  }
}

// Index into the four opacities below. Order: icons then names, ordinary then
// capital, which is also the order they are drawn in.
const F_CITY = 0, F_CAPITAL = 1, F_CITY_NAME = 2, F_CAPITAL_NAME = 3, F_RIVER = 4;
const CITY_THRESHOLDS = [CITY_AT, CAPITAL_AT, CITY_NAME_AT, CAPITAL_NAME_AT, RIVER_AT];

const cityAlpha = CITY_THRESHOLDS.map(() => 0);
let cityClock = null;

/**
 * Moves each opacity towards where its threshold says it should be.
 *
 * `now` is a wall-clock reading taken once at the top of the frame, so the
 * transition advances by real elapsed time. Timing it off anything measured
 * around the drawing would run it slow exactly when drawing is slow, which is
 * while you are scrolling. Returns true while any of them is still moving.
 */
function stepCityFades(now) {
  // On the first call there is no previous reading, so a full step is used and
  // everything snaps to where it belongs rather than fading up from nothing.
  const step = cityClock === null ? 1 : (now - cityClock) / CITY_FADE_MS;
  cityClock = now;

  let moving = false;
  for (let i = 0; i < CITY_THRESHOLDS.length; i++) {
    const want = view.scale >= CITY_THRESHOLDS[i] ? 1 : 0;
    if (cityAlpha[i] === want) continue;
    cityAlpha[i] = want > cityAlpha[i]
      ? Math.min(want, cityAlpha[i] + step)
      : Math.max(want, cityAlpha[i] - step);
    moving = true;
  }
  return moving;
}

/** Eased, so a transition starts and ends softly rather than stopping dead. */
const cityFade = (i) => smoothstep(0, 1, cityAlpha[i]);

/**
 * Where a name may sit relative to its icon, best first: below the dot reads
 * most naturally, then above, then out to one side, and the diagonals only when
 * nothing straight will do. Each returns the centre of the name box.
 */
const CITY_NAME_SPOTS = [
  (w, h, half, px) => [0, h / 2 + CITY_NAME_GAP + px / 2],
  (w, h, half, px) => [0, -(h / 2 + CITY_NAME_GAP + px / 2)],
  (w, h, half) => [w / 2 + CITY_NAME_GAP + half, 0],
  (w, h, half) => [-(w / 2 + CITY_NAME_GAP + half), 0],
  (w, h, half) => [w / 2 + CITY_NAME_GAP + half, h / 2 + CITY_NAME_GAP],
  (w, h, half) => [-(w / 2 + CITY_NAME_GAP + half), h / 2 + CITY_NAME_GAP],
  (w, h, half) => [w / 2 + CITY_NAME_GAP + half, -(h / 2 + CITY_NAME_GAP)],
  (w, h, half) => [-(w / 2 + CITY_NAME_GAP + half), -(h / 2 + CITY_NAME_GAP)],
];

function drawCities(ctx, cssW, cssH, dx, labelBoxes = null) {
  const { cities, cityIcons } = state.world;
  if (!cities?.length) return;

  const iconA = [cityFade(F_CITY), cityFade(F_CAPITAL)];
  const nameA = [cityFade(F_CITY_NAME), cityFade(F_CAPITAL_NAME)];
  if (iconA[0] <= 0.004 && iconA[1] <= 0.004) return;

  const hits = (b, p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1];

  // Two kinds of obstacle, and they are not obeyed equally.
  //
  // HARD: the dots and the names already placed. A city can always be moved off
  // one of these, because the thing it is colliding with was itself placed by
  // this same pass and the map has room.
  //
  // SOFT: the letters of the country names, which are drawn over all of this.
  // A city sits where its city is, so if a country name runs straight through
  // that spot no amount of shuffling will help, and the least covered position
  // is taken instead. The city that is genuinely buried has already dropped out
  // above, at CITY_BLOCKED_AT, so anything still here is worth naming.
  // Both obstacle sets go into a grid, and every question below asks it for the
  // few things near the box rather than walking all of them. See makeGrid.
  const placedGrid = makeGrid();
  const glyphGrid = makeGrid();
  if (labelBoxes) for (const g of labelBoxes) glyphGrid.add(g, ...glyphExtent(g));

  // One scratch list per kind of question, filled and refilled. Allocating a
  // fresh array per query would put thousands of them a frame on the heap.
  const nearPlaced = [];
  const nearGlyphs = [];
  const glyphsNear = (b) => (labelBoxes ? glyphGrid.near(b[0], b[1], b[2], b[3], nearGlyphs) : nearGlyphs);

  const free = (b, own) => {
    for (const p of placedGrid.near(b[0], b[1], b[2], b[3], nearPlaced)) {
      if (p !== own && hits(b, p)) return false;
    }
    return true;
  };

  const clearOfNames = (b) => {
    for (const g of glyphsNear(b)) if (boxHitsGlyph(b, g)) return false;
    return true;
  };

  // How badly a spot sits on the country names, for when none of them is clear.
  // Measured as the AREA covered, not the number of letters touched: those are
  // very different questions once the letters are large, and the second one
  // cannot tell a name laid across the middle of a letter from one clipping its
  // corner. The cheap hit test comes first, so the area is only worked out for
  // the few glyphs a spot actually reaches.
  const namesHit = (b) => {
    let a = 0;
    for (const g of glyphsNear(b)) if (boxHitsGlyph(b, g)) a += glyphOverlapArea(b, g);
    return a;
  };

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  // Pass one: every icon, and every icon's box reserved. Reserving them all
  // before placing any name is what stops a name being put where a city drawn
  // later is about to appear.
  const named = [];
  const merged = view.scale < CITY_MERGE_AT;      // concessions folded into their city
  for (const c of cities) {
    if (merged && c.mergesInto) continue;

    // Capital while merged, not just capital by its own flag: a city standing
    // in for a concession that is one carries its mark until they separate.
    // Everything downstream reads k rather than c.capital for that reason.
    const capital = c.capital || (merged && c.absorbsCapital);
    const k = capital ? 1 : 0;
    const icon = capital ? cityIcons.capital : cityIcons.city;
    if (!icon || iconA[k] <= 0.004) continue;

    // Positions are in this copy's own space, because the caller has already
    // translated the context by dx for it. Only the off-screen test adds dx
    // back, since that one question is about the window and not about the copy.
    const sx = c.x * view.scale + view.x;
    const sy = c.y * view.scale + view.y;
    if (sx + dx < -80 || sy < -80 || sx + dx > cssW + 80 || sy > cssH + 80) continue;

    const h = k ? CAPITAL_ICON_PX : CITY_ICON_PX;
    const w = Math.round(h * (icon.width / icon.height));

    // Buried under a country name, so it is not on the map at all: no dot, no
    // name, and no space reserved, since a marker that is not drawn is not
    // something another city's name has to keep clear of. The icon's own
    // rectangle is measured, without the padding below, because the question is
    // about the mark itself and not the room around it.
    const box = [sx - w / 2, sy - h / 2, sx + w / 2, sy + h / 2];
    if (coveredFraction(box, glyphsNear(box)) >= CITY_BLOCKED_AT) continue;

    ctx.globalAlpha = iconA[k];
    ctx.drawImage(icon, Math.round(sx - w / 2), Math.round(sy - h / 2), w, Math.round(h));

    const own = [sx - w / 2 - CITY_NAME_PAD, sy - h / 2 - CITY_NAME_PAD,
    sx + w / 2 + CITY_NAME_PAD, sy + h / 2 + CITY_NAME_PAD];
    placedGrid.add(own, own[0], own[1], own[2], own[3]);

    if (nameA[k] > 0.004 && c.name) named.push({ c, k, sx, sy, w, h, own });
  }

  // Pass two: the names. Capitals first, so where two want the same space the
  // more important one gets it.
  named.sort((a, b) => b.k - a.k);

  for (const { c, k, sx, sy, w, h, own } of named) {
    const px = k ? CAPITAL_NAME_PX : CITY_NAME_PX;
    const baked = bakedCityName(c.name, px);
    const half = baked.half;

    // Every spot that clears the dots and the names already placed, in order of
    // preference. That much is not negotiable; the country names over them are.
    const open = [];
    for (const spot of CITY_NAME_SPOTS) {
      const [ox, oy] = spot(w, h, half, px);
      const cx = sx + ox, cy = sy + oy;
      const b = [cx - half - CITY_NAME_PAD, cy - px / 2 - CITY_NAME_PAD,
      cx + half + CITY_NAME_PAD, cy + px / 2 + CITY_NAME_PAD];
      if (!free(b, own)) continue;
      b.cx = cx;
      b.cy = cy;
      open.push(b);
    }
    if (!open.length) continue;    // hemmed in by other cities; the dot stands alone

    // The first spot that also clears the country names, or failing that the one
    // that covers the fewest letters of them. Taking the first open spot instead
    // would put the name in its default position over a name it could have
    // half-missed, which looks like the placement never tried.
    let box = open.find((b) => clearOfNames(b));
    if (!box) {
      let worst = Infinity;
      for (const b of open) {
        const n = namesHit(b);
        if (n < worst) { worst = n; box = b; }
      }
    }
    placedGrid.add(box, box[0], box[1], box[2], box[3]);

    // One blit of a finished picture, where this was a stroke and a fill of live
    // text. Positions are rounded so the bitmap lands on whole pixels and is not
    // resampled, which is also what keeps it crisp.
    ctx.globalAlpha = nameA[k];
    ctx.drawImage(baked.canvas,
      Math.round(box.cx - baked.w / 2), Math.round(box.cy - baked.h / 2), baked.w, baked.h);
  }
  ctx.restore();
}


/**
 * The lines the resource layer writes, built once.
 *
 * The draw loop runs every frame over every province on screen, and building
 * a string there is the wrong place for it: eighteen kinds looked up, an array
 * allocated and a template concatenated, per province, sixty times a second,
 * to produce the same characters every time. drawProvinceNames does none of
 * that because a name is already a string sitting on the province.
 *
 * So the text is a string here too. Rebuild this when a yield changes, which
 * is on the day boundary at most: yields come from road, electricity and rail,
 * and none of those moves inside a tick.
 */
function buildResourceLines(world) {
  const out = new Map();
  if (!world.resources) return out;
  // Handed in and not looked up, because this runs while the world is still
  // being assembled and state.world does not point at it yet.
  const hasSheet = Boolean(world.resourceSheet);
  for (const id in world.resources) {
    const held = world.resources[id];
    const lines = [];
    // In the order the file names them, so a province reads the same way
    // every time and the eye can learn where to look.
    for (const kind of world.resourceKinds) {
      const amount = held[kind];
      if (!amount) continue;
      lines.push({ kind, text: `(0/${amount})` });
    }
    if (!lines.length) continue;

    // The widest row in the stack, carried on the array itself. drawResources
    // needs a width to test a province's room against, and the honest one is the
    // width of the widest bitmap it is about to draw. Every icon is the same
    // width, so the widest row is whichever carries the longest figures; with no
    // sheet the word in front of them counts as well.
    lines.wide = lines.reduce((a, b) => (rowChars(b, hasSheet) > rowChars(a, hasSheet) ? b : a));
    out.set(id, lines);
  }
  for (const [id, lines] of out) anchorStack(world, id, lines);
  return out;
}

/**
 * Where a province's stack is written, which is not always its centroid.
 *
 * A centroid is the mean of the pixels, and the mean of an archipelago is the
 * water between its islands. Onanlanu is 234 pixels of land in a 71 by 59 box
 * and its mean falls 15.5 pixels out to sea, which at a close zoom is two
 * hundred screen pixels from the nearest shore. The stack was written there,
 * correctly and uselessly, and panning walked it off the screen while the
 * islands it belongs to stayed. 86 of the 1,500 provinces do this; the worst,
 * Verley-Maret, misses its own land by 477 pixels.
 *
 * So: the centroid where the centroid is on the province, and the middle of its
 * largest island where it is not. Largest and not nearest, because the point of
 * the label is to name the part of the province a person is looking at.
 *
 * Only the provinces that need it pay for it. The test is one array read, and
 * the fourteen hundred that pass it never walk their own box.
 */
function anchorStack(world, id, lines) {
  const bb = world.bounds.get(id);
  if (!bb) return;
  lines.ax = bb.cx;
  lines.ay = bb.cy;

  const W = world.width, H = world.height;
  const at = world.provinceAt;
  const index = world.byId.get(id)?.index;
  if (!at || index === undefined) return;

  const owns = (x, y) => y >= 0 && y < H && at[y * W + ((x % W) + W) % W] === index;
  if (owns(Math.round(bb.cx), Math.round(bb.cy))) return;

  // Flood fill the box into islands and keep the biggest.
  const x0 = bb.minX, y0 = bb.minY;
  const bw = bb.maxX - bb.minX + 1, bh = bb.maxY - bb.minY + 1;
  const seen = new Uint8Array(bw * bh);
  const stack = new Int32Array(bw * bh);
  let bestN = 0, bestX = bb.cx, bestY = bb.cy;

  for (let start = 0; start < bw * bh; start++) {
    if (seen[start]) continue;
    seen[start] = 1;
    const sy = (start / bw) | 0, sx = start - sy * bw;
    if (!owns(x0 + sx, y0 + sy)) continue;

    let top = 0, count = 0, sumX = 0, sumY = 0;
    stack[top++] = start;
    while (top) {
      const i = stack[--top];
      const y = (i / bw) | 0, x = i - y * bw;
      count++; sumX += x0 + x; sumY += y0 + y;
      if (x > 0 && !seen[i - 1] && (seen[i - 1] = 1) && owns(x0 + x - 1, y0 + y)) stack[top++] = i - 1;
      if (x + 1 < bw && !seen[i + 1] && (seen[i + 1] = 1) && owns(x0 + x + 1, y0 + y)) stack[top++] = i + 1;
      if (y > 0 && !seen[i - bw] && (seen[i - bw] = 1) && owns(x0 + x, y0 + y - 1)) stack[top++] = i - bw;
      if (y + 1 < bh && !seen[i + bw] && (seen[i + bw] = 1) && owns(x0 + x, y0 + y + 1)) stack[top++] = i + bw;
    }
    if (count > bestN) { bestN = count; bestX = sumX / count; bestY = sumY / count; }
  }
  if (!bestN) return;

  // The mean of one island can still miss it if the island is a crescent, so
  // settle on the pixel of that island nearest its own middle.
  if (!owns(Math.round(bestX), Math.round(bestY))) {
    let near = Infinity, nx = bestX, ny = bestY;
    for (let y = bb.minY; y <= bb.maxY; y++) {
      for (let x = bb.minX; x <= bb.maxX; x++) {
        if (!owns(x, y)) continue;
        const d = (x - bestX) * (x - bestX) + (y - bestY) * (y - bestY);
        if (d < near) { near = d; nx = x; ny = y; }
      }
    }
    bestX = nx; bestY = ny;
  }
  lines.ax = bestX;
  lines.ay = bestY;
}

/**
 * The resource layer.
 *
 * Every KNOWN deposit in a province, stacked at its centre of mass, as a mark
 * and a pair of figures: what it yields today over what is in the ground.
 *
 * Yield is zero throughout. It is deposit x (0.4 + 0.6 x development) under
 * Extraction, and development reads road, electricity and rail, none of which
 * has a level on the map yet. Showing 0 is the honest answer and the figure
 * moves on its own once those are authored.
 *
 * Unprospected, offshore and stranded deposits are all absent on purpose. This
 * is what a country knows it has and can work, which is a different list from
 * what is under it.
 */
/**
 * One line of a stack, drawn once into its own bitmap and kept.
 *
 * The same shape as bakedCityName, and there for the same reason. A line is
 * live text stroked once for the halo and filled once for the body, the map
 * holds 4,371 of them across 1,487 provinces, and a low zoom puts well over a
 * thousand on screen. That is several thousand text rasterisations a frame.
 *
 * The saving is larger here than it was for the city names, because the strings
 * repeat. Between all 1,487 stacks there are only 232 distinct lines, so the
 * cache fills within the first few provinces and everything after is blitting.
 *
 * Baked at device resolution and at the size it will be drawn at, so the blit is
 * one to one. An earlier attempt baked at a fixed 22px and scaled down to eight,
 * which was mush.
 */
// Where each row of each stack ended up on screen this frame, so the pointer
// can be told what it is over. Filled by drawResources and read by the hover,
// which is the only way back from a bitmap to the thing it came from.
//
// The box is the row PITCH tall and not the bitmap, which carries enough
// padding for its halo that neighbouring rows would overlap by half.
const resourceHits = [];

const resourceLineCache = new Map();
let resourceMeasure = null;

// How many characters wide a row reads, for picking the widest in a stack. The
// icon is a fixed width so it does not enter into it; without a sheet the word
// in front of the figures does.
const rowChars = (row, hasSheet) =>
  (hasSheet ? 0 : (RESOURCE_MARK[row.kind] ?? row.kind).length + 1) + row.text.length;

function bakedResourceLine(row, px) {
  const dpr = Math.max(1, pixelRatio);
  const sheet = state.world?.resourceSheet;
  const cell = sheet ? RESOURCE_ICON[row.kind] : undefined;
  const key = `${px}|${dpr.toFixed(2)}|${cell ?? row.kind}|${row.text}`;
  const had = resourceLineCache.get(key);
  if (had) return had;

  if (!resourceMeasure) resourceMeasure = document.createElement('canvas').getContext('2d');
  resourceMeasure.font = resourceFont(px);

  // With a sheet the row is icon, gap, figures. Without one the resource says
  // its own short name instead, which is what it did before there was art.
  const icon = cell === undefined ? 0 : resourceIconPx(px);
  const gap = cell === undefined ? 0 : Math.round(px * 0.3);
  const text = cell === undefined ? `${RESOURCE_MARK[row.kind] ?? row.kind} ${row.text}` : row.text;
  const width = resourceMeasure.measureText(text).width;

  const halo = Math.max(2, px * 0.28);
  const pad = Math.ceil(halo) + 2;
  const w = Math.ceil(icon + gap + width) + pad * 2;
  const h = Math.ceil(Math.max(px * 1.6, icon)) + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);

  const x = canvas.getContext('2d');
  x.scale(dpr, dpr);

  if (cell !== undefined) {
    // A dark edge under the art, so a pale icon does not vanish into pale sea.
    // The text gets the same from its own stroke; a bitmap has no stroke.
    x.shadowColor = 'rgba(6,8,12,.9)';
    x.shadowBlur = Math.max(1.5, px * 0.18);
    const sx = (cell % RESOURCE_SHEET_COLS) * RESOURCE_SHEET_CELL;
    const sy = Math.floor(cell / RESOURCE_SHEET_COLS) * RESOURCE_SHEET_CELL;
    x.drawImage(sheet, sx, sy, RESOURCE_SHEET_CELL, RESOURCE_SHEET_CELL,
      pad, pad + (h - pad * 2 - icon) / 2, icon, icon);
    x.shadowColor = 'transparent';
    x.shadowBlur = 0;
  }

  x.font = resourceFont(px);
  x.textAlign = 'left';
  x.textBaseline = 'middle';
  x.lineJoin = 'round';
  x.lineWidth = halo;
  x.strokeStyle = 'rgba(6,8,12,.85)';
  x.fillStyle = 'rgba(232,238,246,.95)';
  x.strokeText(text, pad + icon + gap, h / 2);
  x.fillText(text, pad + icon + gap, h / 2);

  const baked = { canvas, w, h };
  resourceLineCache.set(key, baked);
  return baked;
}

/**
 * Every known deposit in every province that has the room to say so.
 *
 * Nothing is styled on the passed context and nothing is saved or restored,
 * because every line arrives as a finished bitmap.
 */
function drawResources(ctx, cssW, cssH, dx) {
  const t0 = performance.now();
  const w = state.world;
  if (!w?.resources || !w.bounds) return;

  const lines = w.resourceLines;
  if (!lines?.size) return;

  const s = view.scale;

  // Below the size a line can be read at, the layer says nothing.
  //
  // The size used to be floated up to the minimum instead, which made zooming
  // out the expensive direction: it did not thin the layer, it brought more
  // provinces on screen and wrote 6px text across all of them, overlapping and
  // unreadable. RESOURCE_MIN_LINE is a floor on legibility, so it is a cutoff.
  const natural = RESOURCE_LINE * s;
  if (natural < RESOURCE_MIN_LINE) { debug.resourcesDrawn = 0; return; }

  // Whole pixels, so the bake cache holds the handful of sizes between the
  // cutoff and the ceiling and not a fresh set for every step of a zoom.
  const base = Math.round(Math.min(natural, RESOURCE_MAX_LINE));
  const big = Math.round(base * RESOURCE_SELECTED);

  // The rows are spaced by whichever is taller, the letters or the icon, so a
  // stack never writes over itself. Worked out for both sizes here, since the
  // selected province is the only one drawn at the larger of them.
  const pitchOf = (px) => Math.max(px, w.resourceSheet ? resourceIconPx(px) : 0);
  const basePitch = pitchOf(base), bigPitch = pitchOf(big);
  const rowH = basePitch / s;         // one row of the stack, in map pixels

  // Walked over the provinces that HOLD something, not over all of them. The
  // chosen one is held back to the end so its larger stack lands ON TOP of its
  // neighbours instead of under them, and so the hover, which reads the record
  // backwards, answers with it where two overlap.
  let drawn = 0;
  const one = (id, rows, chosen) => {
    const bb = w.bounds.get(id);
    if (!bb) return;

    // The chosen province is exempt from every room test below. Picking one is
    // a request to see it, and hiding what was asked for because the ground is
    // narrow is the opposite of an answer.
    const line = chosen ? big : base;
    const pitch = chosen ? bigPitch : basePitch;

    // Height first, because it costs a subtract. A nine-row stack needs nine
    // rows of room, and a province too short to hold its own stack was only
    // ever writing it across its neighbours.
    if (!chosen && bb.maxY - bb.minY + 1 < rowH * rows.length) return;

    // The caller has already done ctx.translate(dx, 0), which is the state
    // drawProvinceNames is written against. So dx belongs in the test for
    // whether THIS copy of the wrapped map is on screen and nowhere else.
    // Folding it into the coordinate as well put every wrapped copy at twice
    // the offset, so a province would show while the unwrapped copy covered it
    // and vanish the moment a wrapped one took over, which is what panning
    // toward Onanlanu looked like.
    const x = rows.ax * s + view.x;
    if (x + dx < -160 || x + dx > cssW + 160) return;
    const y = rows.ay * s + view.y;
    const reach = rows.length * pitch * 0.5 + pitch;
    if (y + reach < 0 || y - reach > cssH) return;

    // Then width, measured and not guessed. This asks the cache for a bitmap the
    // stack is about to draw anyway, so on all but the first few provinces it is
    // a map lookup. A fixed figure was standing in for this and it was far too
    // small: 46px of room let a province claim it could write "Tungsten (0/12)",
    // which is nearer ninety.
    //
    // Half of it, because a line may hang over the edges. Demanding the whole
    // width shut eighteen provinces out at every zoom there is: Zamogon is five
    // pixels across and holds four things, Ouresca Island is three across and
    // holds three. A name written wider than the island it belongs to is how an
    // atlas has always done it.
    const widest = bakedResourceLine(rows.wide, line);
    if (!chosen && (bb.maxX - bb.minX + 1) * s < widest.w * RESOURCE_OVERHANG) return;

    let ly = y - ((rows.length - 1) * pitch) / 2;
    for (let i = 0; i < rows.length; i++, ly += pitch) {
      const b = bakedResourceLine(rows[i], line);
      ctx.drawImage(b.canvas, 0, 0, b.canvas.width, b.canvas.height,
        x - b.w / 2, ly - b.h / 2, b.w, b.h);
      // In window space, so dx goes back in: the context carries it as a
      // translate, and the pointer knows nothing about which copy it is over.
      resourceHits.push({
        x0: x + dx - b.w / 2, x1: x + dx + b.w / 2,
        y0: ly - pitch / 2, y1: ly + pitch / 2,
        id, kind: rows[i].kind, amount: w.resources[id]?.[rows[i].kind] ?? 0,
      });
    }
    drawn++;
  };

  for (const [id, rows] of lines) if (id !== state.selected) one(id, rows, false);
  const chosenRows = state.selected && lines.get(state.selected);
  if (chosenRows) one(state.selected, chosenRows, true);
  perf.resources = ease(perf.resources, performance.now() - t0);
  debug.resourcesDrawn = drawn;
}

function drawOverlays(ctx, cssW, cssH, dx) {
  if (state.showCoastal) drawCoastalFlags(ctx, cssW, cssH, dx);
  if (state.showProvinceNames) drawProvinceNames(ctx, cssW, cssH, dx);
  if (state.showSeaNames) drawSeaNames(ctx, cssW, cssH, dx);
  if (state.showAdjacency) drawAdjacency(ctx);
  if (state.showBounds) drawSelectionBounds(ctx);
  if (state.showChunks) drawChunkGrid(ctx, cssW, cssH, dx);
  if (state.showSeams) drawSeams(ctx, cssW, cssH, dx);
}

/** Sets up the stroke-then-fill style shared by the text overlays. */
function overlayText(ctx, weight = .95) {
  ctx.font = OVERLAY_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(6,8,12,.85)';
  ctx.fillStyle = `rgba(232,238,246,${weight})`;
}

/**
 * Every province's name at its centroid.
 *
 * Skipped for anything too small to read at the current zoom, which is what
 * keeps this usable — naming all 289 at once would be illegible and slow. The
 * count that survives is reported in the readout so the cutoff can be judged.
 */
function drawProvinceNames(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  ctx.save();
  overlayText(ctx);
  let drawn = 0;
  for (const [id, bb] of w.bounds) {
    if ((bb.maxX - bb.minX + 1) * s < NAME_MIN_PX) continue;      // too small to read
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x + dx < -120 || y < -20 || x + dx > cssW + 120 || y > cssH + 20) continue;   // off screen
    const name = w.byId.get(id).name;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
    drawn++;
  }
  ctx.restore();
  debug.names = drawn;
}

/**
 * Every sea region's name at its centroid, on the same terms.
 *
 * Drawn in a colder tint so the two sets can be told apart with both switched
 * on. A centroid is the mean of the region's own water, so a sea curling round
 * a headland can put its name on the land inside the bend; drawProvinceNames
 * does the same to a horseshoe country and it is no less readable for it.
 */
function drawSeaNames(ctx, cssW, cssH, dx) {
  const sea = state.world.sea;
  if (!sea) return;

  const s = view.scale;
  ctx.save();
  overlayText(ctx);
  ctx.fillStyle = 'rgba(150,206,244,.95)';
  let drawn = 0;
  for (const [id, bb] of sea.bounds) {
    if ((bb.maxX - bb.minX + 1) * s < NAME_MIN_PX) continue;    // too small to read
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x + dx < -120 || y < -20 || x + dx > cssW + 120 || y > cssH + 20) continue;
    const r = sea.byId.get(id);
    const name = r.lake ? `${r.name} (lake)` : r.name;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
    drawn++;
  }
  ctx.restore();
  debug.seaNames = drawn;
}

/**
 * The tile grid, with each chunk's column,row and whether it is being drawn.
 *
 * Chunks actually blitted this frame are outlined brightly, the rest faintly —
 * so the culling in drawView() can be watched working. Zoomed out no chunk is
 * lit at all, because the overview is being used instead.
 */
function drawChunkGrid(ctx, cssW, cssH, dx) {
  if (!tiles) return;
  const s = view.scale;
  const usingTiles = !overviewCovers(s);

  // Which chunks drawMapLayer() used for THIS copy of the map, by the same
  // visible-rect test — so the lit chunks match what is actually drawn here
  // rather than what is drawn in the copy at the origin.
  const inUse = new Set();
  if (usingTiles) {
    const rect = visibleRect(view.x + dx, cssW, cssH);
    if (rect) for (const t of tilesOver(rect.x0, rect.y0, rect.x1, rect.y1)) inUse.add(t);
  }

  ctx.save();
  ctx.font = OVERLAY_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;

  for (const tile of tiles.list) {
    const x = Math.round(tile.x * s + view.x), y = Math.round(tile.y * s + view.y);
    const x1 = Math.round((tile.x + tile.w) * s + view.x), y1 = Math.round((tile.y + tile.h) * s + view.y);
    if (x1 + dx < 0 || y1 < 0 || x + dx > cssW || y > cssH) continue;

    const live = inUse.has(tile);
    ctx.strokeStyle = live ? 'rgba(168,189,212,.9)' : 'rgba(127,151,178,.28)';
    ctx.strokeRect(x + .5, y + .5, x1 - x - 1, y1 - y - 1);

    if (x1 - x > 74 && y1 - y > 26) {
      const label = `${tile.x / TILE},${tile.y / TILE}`;
      ctx.fillStyle = live ? 'rgba(168,189,212,.95)' : 'rgba(127,151,178,.45)';
      ctx.fillText(label, x + 5, y + 4);
    }
  }
  ctx.restore();
}

/**
 * Lines from the selected province to each of its neighbours.
 *
 * The adjacency graph is derived from pixels rather than authored, so this is
 * the quickest way to see it is right — a missing line means two provinces that
 * look joined never actually touch, and a stray one means a leaked pixel.
 */
function drawAdjacency(ctx) {
  const w = state.world;
  if (!state.selected) return;
  const from = w.bounds.get(state.selected);
  if (!from) return;
  const s = view.scale;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(168,189,212,.75)';
  ctx.fillStyle = 'rgba(232,238,246,.9)';
  for (const id of w.adjacency.get(state.selected)) {
    const to = w.bounds.get(id);
    if (!to) continue;
    ctx.beginPath();
    ctx.moveTo(from.cx * s + view.x, from.cy * s + view.y);
    ctx.lineTo(to.cx * s + view.x, to.cy * s + view.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(to.cx * s + view.x, to.cy * s + view.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The selected province's bounding box and centroid.
 *
 * The box is what repaintProvinces() actually repaints, so a province whose box
 * covers far more than the province does is one that makes partial repaints
 * expensive — scattered islands sharing one id, usually.
 */
function drawSelectionBounds(ctx) {
  const w = state.world;
  if (!state.selected) return;
  const bb = w.bounds.get(state.selected);
  if (!bb) return;
  const s = view.scale;
  const x = bb.minX * s + view.x, y = bb.minY * s + view.y;
  const bw = (bb.maxX - bb.minX + 1) * s, bh = (bb.maxY - bb.minY + 1) * s;

  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(217,140,95,.9)';
  ctx.strokeRect(x + .5, y + .5, bw, bh);
  ctx.setLineDash([]);

  ctx.beginPath();                                  // centroid: where a label anchors
  ctx.arc(bb.cx * s + view.x, bb.cy * s + view.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(217,140,95,.95)';
  ctx.fill();
  ctx.restore();
}

/**
 * Where the joins are.
 *
 * MAGENTA is the left edge of a drawn copy of the map, which is map x 0 and also
 * map x 6000 of the copy before it. CYAN is a tile column boundary, every 512 map
 * pixels. ORANGE is the right edge of the overview, which only differs from the
 * magenta line if a rounding rule has gone wrong.
 *
 * A vertical artefact sitting on a magenta line is a copy join. On a cyan line it
 * is a tile boundary. On neither, it is drawn on the map and is not a seam at all.
 */
function drawSeams(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  ctx.save();
  ctx.lineWidth = 1;

  ctx.strokeStyle = 'rgba(0,220,255,.55)';
  for (let x = TILE; x < w.width; x += TILE) {
    const sx = Math.round(view.x + x * s) + 0.5;
    if (sx + dx < -1 || sx + dx > cssW + 1) continue;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH); ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,0,220,.95)';
  for (const x of [0, w.width]) {
    const sx = Math.round(view.x + x * s) + 0.5;
    if (sx + dx < -1 || sx + dx > cssW + 1) continue;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH); ctx.stroke();
  }

  // The last tile column is the one that cannot land on a whole number of
  // overview pixels, so it is worth seeing on its own.
  ctx.strokeStyle = 'rgba(255,150,0,.9)';
  const last = Math.round(view.x + Math.floor(w.width / TILE) * TILE * s) + 0.5;
  if (!(last + dx < -1 || last + dx > cssW + 1)) {
    ctx.beginPath(); ctx.moveTo(last, 0); ctx.lineTo(last, cssH); ctx.stroke();
  }
  ctx.restore();
}

/** A dot on every province the pixel scan found touching open sea. */
function drawCoastalFlags(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(120,200,225,.85)';
  for (const id of w.coastal) {
    const bb = w.bounds.get(id);
    if (!bb) continue;
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x + dx < 0 || y < 0 || x + dx > cssW || y > cssH) continue;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ====================================================================== 7. app

const els = {
  canvas: document.getElementById('map'),
  tooltip: document.getElementById('tooltip'),
  wrap: document.getElementById('canvas-wrap'),
  panel: document.getElementById('panel'),
  toggles: document.getElementById('toggles'),
  perf: document.getElementById('perf'),
  selName: document.getElementById('sel-name'),
  selBody: document.getElementById('sel-body'),
  neighbours: document.getElementById('neighbours'),
  card: document.getElementById('card'),
  countyCard: document.getElementById('county-card'),
  countyName: document.getElementById('county-name'),
  countyPolity: document.getElementById('county-polity'),
  countyProvince: document.getElementById('county-province'),
  countyOwner: document.getElementById('county-owner'),
  countyFlag: document.getElementById('county-flag'),
  countyTerrain: document.getElementById('county-terrain'),
  countyClimate: document.getElementById('county-climate'),
  countyRail: document.getElementById('county-rail'),
  countyArea: document.getElementById('county-area'),
  cardName: document.getElementById('card-name'),
  cardPolity: document.getElementById('card-polity'),
  cardRole: document.getElementById('card-role'),
  cardOwner: document.getElementById('card-owner'),
  cardFlag: document.getElementById('card-flag'),
  cardClaims: document.getElementById('card-claims'),
  cardPop: document.getElementById('card-pop'),
  cardArea: document.getElementById('card-area'),
  cardGrid: document.getElementById('card-grid'),
  cardSlots: document.getElementById('card-slots'),
  cardSlotsN: document.getElementById('card-slots-n'),
  cardCivN: document.getElementById('card-civ-n'),
  cardMilN: document.getElementById('card-mil-n'),
  stats: document.getElementById('stats'),
  toolbar: document.getElementById('toolbar'),
  zoomLevel: document.getElementById('zoom-level'),
  pause: document.getElementById('pause'),
  clock: document.getElementById('clock'),
  clockFace: document.getElementById('clock-face'),
  clockPlay: document.getElementById('clock-play'),
  clockSlower: document.getElementById('clock-slower'),
  clockFaster: document.getElementById('clock-faster'),
};

const state = {
  mode: 'political',      // which of MODES colours the map
  selected: null,         // province id, or null
  hovered: null,          // province id, or null
  selectedSea: null,      // sea region id, or null. Navy mode only
  selectedSub: null,      // sea subregion id, or null. Navy mode only
  hoveredSub: null,       // the same, under the pointer
  county: null,           // the county under the right button; see selectCounty
  hoveredSea: null,       // sea region id, or null
  world: null,            // the model from buildWorld(), once loaded
  silhouette: null,       // selected province's shape; survives zooming
  outline: null,          // the ring built from it, rebuilt on every zoom change
  fade: null,             // a dropped selection still fading out; see select()

  // Overlay switches. Each is driven by a button in the debug menu carrying a
  // matching data-toggle, so adding one is a line of HTML and a draw call.
  satellite: false,       // imagery under the province colours; set true if it loads
  showNight: true,        // the terminator and the city lights, baked into the tiles
  showRivers: true,       // drawn over the ground, from RIVER_AT up; see drawRivers
  showCities: true,
  showLabels: true,
  showProvinceNames: false,
  showSeaNames: false,
  showChunks: false,
  showAdjacency: false,
  showBounds: false,
  showCoastal: false,
  showSeams: false,
};


// Redrawing is driven by flags rather than by redrawing on every event, so a
// burst of mouse moves within one frame still costs a single repaint.
let bufferDirty = true;               // EVERY province changed: repaint the whole buffer
let repaintPass = null;               // and the pass doing it, spread over frames
let viewDirty = true;                 // only the pan/zoom changed: re-blit alone will do
const dirtyProvinces = new Set();     // just these changed: repaint their boxes only
const dirtyBoxes = [];                // and these map rectangles, for changes that are not
// one province's own pixels — see changeOwners()

const invalidateBuffer = () => { bufferDirty = true; };
const invalidateView = () => { viewDirty = true; els.zoomLevel.textContent = `${Math.round(view.scale * 100)}%`; };

/**
 * Marks individual provinces as needing a repaint.
 *
 * Prefer this to invalidateBuffer() whenever the set of affected provinces is
 * known. On a large map the difference is a few thousand pixels against sixteen
 * million. Nulls are ignored, so "the province that was selected before" can be
 * passed without checking it first.
 */
/**
 * Marks provinces as needing their pixels repainted.
 *
 * A province too large to light is dropped here as well as in shadeTable. It
 * would repaint to exactly what it already shows, since shadeTable refuses to
 * light it — so the work is not merely expensive, it is guaranteed to change
 * nothing.
 */
function invalidateProvinces(...ids) {
  for (const id of ids) {
    if (id && !tooBigToLight(state.world, id)) dirtyProvinces.add(id);
  }
}

/* Timings and tallies for the debug menu's Performance block. Kept as running
 * averages because a single frame's number is too noisy to read.
 *
 * Note that the frame figure is stored as an INTERVAL in milliseconds and only
 * turned into a rate when it is displayed. Averaging rates instead is what the
 * meter used to do, and it does not work: rAF sometimes delivers two callbacks
 * inside one display refresh, gaps of well under a millisecond having been
 * measured here. A rate is the reciprocal of the gap, so a short gap does not
 * merely nudge the average — a 0.3ms one reads as 3300fps and drags it up by
 * hundreds, while a long gap can only ever pull it down towards zero. The
 * reading has nowhere to go but up. And a gap that rounds to exactly zero gives
 * Infinity, which a running average can never leave: 0.9 x Infinity is still
 * Infinity, so the meter stays pinned there for the rest of the session.
 * Averaging the interval keeps a short frame worth no more than a short frame. */
const perf = { resources: 0, frameMs: 0, draw: 0, paint: 0, fullRepaints: 0, partRepaints: 0, lastFrame: 0, load: null, maskBuilds: 0, night: 0, cities: 0, labels: 0 };
const ease = (was, now) => (was ? was * 0.9 + now * 0.1 : now);

/** True when the canvas's CSS box no longer matches its pixel buffer. */
function canvasResized() {
  const dpr = ratioFor(els.canvas.clientWidth, els.canvas.clientHeight);
  return els.canvas.width !== Math.round(els.canvas.clientWidth * dpr)
    || els.canvas.height !== Math.round(els.canvas.clientHeight * dpr);
}

/* ==================================================================== the clock
 *
 * The unit of simulated time is 20 minutes: 3 ticks to the hour, 72 to the day.
 * Every rule the simulation ever grows is evaluated per tick, never per second
 * and never per frame, so that a given run of ticks produces the same world on
 * any machine at any frame rate. Nothing but the clock may read wall time.
 *
 * The whole of the date is ONE INTEGER, the ticks elapsed since the start. Year,
 * month, day, hour and the position of the sun are all derived from it, so a
 * save carries a single number and there is no second copy of the date to fall
 * out of step with the first.
 *
 * Today it advances the time of day and nothing else. The schedules that hang
 * off it — construction and production on the day boundary, diplomacy on the
 * week, the economy on the month — are in plans.md and land here, at the one
 * place that knows a tick has happened.
 */

const TICK_MINUTES = 20;
const TICKS_PER_HOUR = 60 / TICK_MINUTES;               // 3
const TICKS_PER_DAY = TICKS_PER_HOUR * 24;              // 72

// Tick 0. 10 Ungerbruni 1926, 00:00 UTC, which is day 161 of the year and the
// sky the map already had before there was a clock to move it.
const CLOCK_EPOCH = Date.UTC(1926, 5, 10);
const DAY_MS = 86400000;

// Real milliseconds per tick, slowest first. The ratio between them is about 3,
// so each step is the same change however fast you were already going.
const SPEEDS = [333, 100, 33];

// A ceiling on how much simulated time one frame may deliver. Past it the clock
// FALLS BEHIND rather than catching up: a tab left in the background gets no
// animation frames at all, and without this the first frame after it comes back
// would try to run every tick owed since, which at 33ms a tick is an hour of
// simulation in one blocking loop.
const MAX_TICKS_PER_FRAME = 12;

// The Rundean calendar is the Gregorian one with its own names for the months,
// so the arithmetic is Date's and only the naming is ours. That is also how the
// wiki's own converter does it, and the two have to agree or a date written
// here would not be the date written there.
const RUNDEAN_MONTHS = [
  'Mithalvan', 'Sithvan', 'Ungertre', 'Mithaltre', 'Sithtre', 'Ungerbruni',
  'Mithalbruni', 'Sithbruni', 'Ungergull', 'Mithalgull', 'Sithgull', 'Ungervan',
];

const clock = {
  tick: 0,
  speed: 2,             // index into SPEEDS, from 1
  paused: true,         // starts stopped, so the world waits until it is asked to move
  carry: 0,             // real milliseconds not yet worth a whole tick
  last: 0,              // when time was last read
  ticked: 0,            // ticks ever run, for the achieved-rate readout
  rateFrom: 0,
};

/** Everything the tick count means, derived rather than stored. */
function clockDate(tick) {
  const days = Math.floor(tick / TICKS_PER_DAY);
  const minutes = (tick % TICKS_PER_DAY) * TICK_MINUTES;
  const d = new Date(CLOCK_EPOCH + days * DAY_MS);
  const year = d.getUTCFullYear();
  return {
    year,
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    // What the sun's declination is worked out from, so it has to count leap
    // days exactly as the calendar does rather than from a 365-day assumption.
    dayOfYear: Math.round((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS) + 1,
  };
}

/**
 * Whether time is passing.
 *
 * Three separate things stop it, and only the first is the player's own choice.
 * The other two are menus: a screen that has stopped to ask a question should
 * not have the world moving on behind it, and the start screen is not a place
 * the game is being played from at all. Neither touches `paused`, so pressing
 * Resume gives back exactly the state the menu interrupted.
 */
const clockRunning = () => !clock.paused && mapIsShowing() && !pauseOpen();

/**
 * Consumes elapsed real time in whole ticks.
 *
 * Frame rate does not affect how fast the world moves: the ticks come out of
 * elapsed milliseconds, so 60Hz, 144Hz and a stuttering machine all deliver the
 * same simulation for the same wall time. What is left over is carried, so
 * changing speed neither creates nor destroys time.
 */
function advanceClock(now) {
  // Read on every frame, running or not, so that unpausing does not hand the
  // accumulator the entire length of the pause.
  const elapsed = clock.last ? now - clock.last : 0;
  clock.last = now;
  if (!clockRunning()) return;

  const ms = SPEEDS[clock.speed - 1];
  clock.carry += elapsed;

  let ticked = 0;
  while (clock.carry >= ms && ticked < MAX_TICKS_PER_FRAME) {
    clock.carry -= ms;
    clock.tick++;
    ticked++;
  }
  if (clock.carry > ms * MAX_TICKS_PER_FRAME) clock.carry = ms * MAX_TICKS_PER_FRAME;

  if (ticked) {
    clock.ticked += ticked;
    applyClock();
  }
}

/**
 * Puts the world where the tick count says it should be.
 *
 * The only caller that matters is advanceClock, but it is written to be
 * idempotent so that setting the tick from the console lands in the same state
 * as having arrived there by running.
 */
function applyClock() {
  const at = clockDate(clock.tick);

  sunUtcHour = at.hour + at.minute / 60;
  sunDayOfYear = at.dayOfYear;

  // The mask is a function of the DAY alone — the hour is the offset it is
  // drawn at — so it is rebuilt when the day turns and at no other time. That
  // is once per 72 ticks rather than once per tick.
  const mask = state.world?.nightMask;
  if (state.world && (!mask || mask.dayOfYear !== at.dayOfYear)) {
    state.world.nightMask = buildNightMask(state.world, at.dayOfYear);
  }

  updateClockFace(at);

  // The ground has not changed, only the light falling on it, so this is a blit
  // and never a repaint. With the overlay switched off nothing on the map moved
  // at all and the frame is skipped entirely.
  //
  // Held to NIGHT_MIN_MS between redraws. A tick is 20 minutes of simulated time
  // and at the fastest speed thirty of them pass a second, which would ask for a
  // full frame thirty times a second to slide a soft gradient a few pixels. Ticks
  // that fall inside the interval still advance the clock and the date; they just
  // do not each buy a frame. Anything else that changes the view, such as a pan,
  // calls invalidateView directly and is unaffected.
  if (state.showNight) {
    const now = performance.now();
    if (now - nightDrawnAt >= NIGHT_MIN_MS) {
      nightDrawnAt = now;
      invalidateView();
    }
  }
}

/** `15:00, 10 Ungerbruni 1926`. */
function updateClockFace(at) {
  const hh = String(at.hour).padStart(2, '0');
  const mm = String(at.minute).padStart(2, '0');
  els.clockFace.textContent = `${hh}:${mm}, ${at.day} ${RUNDEAN_MONTHS[at.month]} ${at.year}`;
}

/** Reflects the run state and the speed on the plate. */
function updateClockControls() {
  els.clock.classList.toggle('running', !clock.paused);
  els.clockPlay.setAttribute('aria-pressed', String(!clock.paused));
  els.clockPlay.title = clock.paused ? 'Resume (Space)' : 'Pause (Space)';

  // Dimmed at the ends of the range rather than wrapping round. Speed is a
  // position on a scale, and a control that jumped from fastest back to slowest
  // would eventually do it by accident.
  els.clockSlower.disabled = clock.speed <= 1;
  els.clockFaster.disabled = clock.speed >= SPEEDS.length;
  els.clockSlower.title = `Slower (now ${clock.speed} of ${SPEEDS.length})`;
  els.clockFaster.title = `Faster (now ${clock.speed} of ${SPEEDS.length})`;
}

function setSpeed(speed) {
  const want = clamp(Math.round(speed), 1, SPEEDS.length);
  if (want === clock.speed) return;
  clock.speed = want;
  // The remainder is left alone on purpose. It is real time already elapsed and
  // still owed, so carrying it means a change of speed neither loses a fraction
  // of a tick nor conjures one, and the new rate applies from the next tick.
  updateClockControls();
}

function setPaused(paused) {
  if (clock.paused === paused) return;
  clock.paused = paused;
  updateClockControls();
}

/**
 * The render loop. Runs continuously but does nothing unless a flag is set.
 *
 * The body is wrapped because a throw in here used to end the program without
 * saying so. requestAnimationFrame(frame) sat at the bottom, so anything that
 * threw took the re-arm with it: the canvas stopped updating while every event
 * handler carried on answering, which reads as the map having frozen while the
 * tooltip still works. A missing entry in MODES did exactly that.
 *
 * Now the loop always re-arms, the first failure is reported where it can be
 * seen, and the repeats are counted rather than filling the console.
 */
let frameFault = null;
let frameFaults = 0;

function frame() {
  try {
    frameBody();
  } catch (err) {
    frameFaults++;
    if (!frameFault) {
      frameFault = err;
      console.error('The render loop threw. The map will stop updating until this is fixed.', err);
    }
  }
  requestAnimationFrame(frame);
}

function frameBody() {
  if (state.world) {
    // First, so that everything drawn below is drawn for the hour this frame
    // belongs to rather than the previous one's.
    advanceClock(performance.now());

    // The canvas is sized by CSS, so its box can change without any event of
    // ours firing — a window resize, or the dev panel sliding. Check it here,
    // every frame, rather than reacting to a ResizeObserver: observer callbacks
    // are delivered after this callback has already run, so a redraw triggered
    // from one is always a frame late, and until it lands the browser stretches
    // the previous frame's image to the new box. Over a 300ms slide that reads
    // as a map squashed for the whole animation, snapping back at the end.
    if (canvasResized()) {
      clampPan();
      viewDirty = true;
    }

    // City transitions run on a clock, so they need a tick and a redraw for as
    // long as one is still going.
    // City transitions run on a clock, so they get a tick and a redraw for as
    // long as one is going. Read at the top of the frame, before any drawing.
    if (stepCityFades(performance.now()) && state.showCities) viewDirty = true;

    // Labels standing back for a selection, or coming back after one. Only the
    // blit is affected — the painted map is untouched — so this needs a redraw
    // and nothing more.
    if (stepLabelDim(performance.now())) viewDirty = true;

    // A dropped selection is animating, so its provinces need repainting every
    // frame until it is gone. Only those provinces — a handful of small boxes —
    // which is what makes animating a baked-in highlight affordable at all.
    if (state.fade) {
      invalidateProvinces(state.fade.id, ...state.fade.neighbours);
      // Cleared before the repaint below, so the last pass draws them plain.
      if (fadeStrength() <= 0) state.fade = null;
      viewDirty = true;
    }

    // A full repaint starts here and finishes over the frames that follow. Asking
    // for another one mid-pass throws the old pass away and starts again, which is
    // what should happen: the mode or the selection has changed under it.
    if (bufferDirty) {
      repaintPass = startRepaint(state.world, state.mode, state.selected, state.hovered);
      bufferDirty = false;
      dirtyProvinces.clear();   // the full repaint covers them
      dirtyBoxes.length = 0;
    }

    if (repaintPass) {
      if (stepRepaint(state.world, repaintPass)) {
        repaintPass = null;
        perf.fullRepaints++;
      }
      viewDirty = true;         // show what has been painted so far
    } else if (dirtyProvinces.size || dirtyBoxes.length) {
      const t0 = performance.now();
      repaintProvinces(state.world, state.mode, state.selected, state.hovered, dirtyProvinces, dirtyBoxes);
      perf.paint = ease(perf.paint, performance.now() - t0);
      perf.partRepaints++;
      dirtyProvinces.clear();
      dirtyBoxes.length = 0;
      viewDirty = true;
    }
    if (viewDirty) {
      const t0 = performance.now();
      drawView();
      perf.draw = ease(perf.draw, performance.now() - t0);
      viewDirty = false;
    }

    const now = performance.now();
    if (perf.lastFrame) perf.frameMs = ease(perf.frameMs, now - perf.lastFrame);
    perf.lastFrame = now;
    updateReadout(now);
    refreshTooltipTime();
  }
}

/**
 * Keeps the time in the open tooltip up to date while the clock runs.
 *
 * The tooltip is built on mousemove and nowhere else, so with the pointer held
 * still it went on showing the local time of the moment it was opened: the clock
 * could run through the night and the tooltip would not notice until the mouse
 * was nudged a pixel.
 *
 * Only the markup is rebuilt, from the two halves showTooltip left behind. It is
 * not placed again: the pointer has not moved, and the time is always five
 * characters wide so the box does not change size under it either.
 *
 * The time is quantised to the twenty-minute tick, so this changes something
 * about three times an hour of game time however fast the clock is running.
 */
function refreshTooltipTime() {
  if (!tipFor || els.tooltip.hidden || !state.world) return;
  const time = localTimeAt(state.world, tipFor);
  if (time === tipTime) return;
  tipTime = time;
  els.tooltip.innerHTML = tipHead + timeMarkup(time) + tipTail;
}

/**
 * Which province is under the cursor, or null for sea or off-map.
 *
 * Hit testing is a single array lookup: the pointer is converted to a map pixel
 * and that pixel already knows its province. No shape or polygon test is needed,
 * so it stays constant-time however complicated the borders get.
 */
/**
 * Where the pointer is, in map pixels.
 *
 * `x` is wrapped into the map and is the column in the bitmaps; `copy` says
 * which repeat of the map east or west it was read off, since at low zoom the
 * same column is on screen more than once. Reported in the debug panel so a
 * mark on the map can be named by the column it sits on rather than estimated
 * from the longitude it looks like it is near.
 */
function mapPointAtEvent(ev) {
  const w = state.world;
  if (!w) return null;
  const rect = els.canvas.getBoundingClientRect();
  const { x, y } = screenToMap(ev.clientX - rect.left, ev.clientY - rect.top);
  const fx = Math.floor(x);
  return {
    x: ((fx % w.width) + w.width) % w.width,
    y: Math.floor(y),
    copy: Math.floor(fx / w.width),
  };
}

/**
 * The map cell under a pointer event, as an index into the map arrays, or -1.
 *
 * Wrapped east to west, so a click on any copy of the map lands on the same
 * place. There is no wrapping north to south and off the map is nothing.
 *
 * Worked out ONCE per event. A single mousemove asks what province, county, sea
 * region and subregion are under the pointer, and each of those read the canvas
 * rectangle and converted the point over again: four calls to
 * getBoundingClientRect, any of which can make the browser lay the page out
 * before it answers.
 */
const cellByEvent = new WeakMap();

function cellAtEvent(ev) {
  const had = cellByEvent.get(ev);
  if (had !== undefined) return had;

  const w = state.world;
  const rect = els.canvas.getBoundingClientRect();
  const { x, y } = screenToMap(ev.clientX - rect.left, ev.clientY - rect.top);
  const py = Math.floor(y);
  const cell = py < 0 || py >= w.height
    ? -1
    : py * w.width + ((((Math.floor(x) % w.width) + w.width) % w.width));

  cellByEvent.set(ev, cell);
  return cell;
}

/** The province under the cursor, or null. */
function provinceAtEvent(ev) {
  const w = state.world;
  const i = cellAtEvent(ev);
  if (i < 0) return null;
  const index = w.provinceAt[i];
  return index === OCEAN ? null : w.atIndex[index].id;
}

/** The county under the cursor, or null. */
function countyAtEvent(ev) {
  const w = state.world;
  if (!w || !w.counties) return null;
  const i = cellAtEvent(ev);
  if (i < 0) return null;
  const ix = w.counties.countyAt[i];
  return ix ? w.counties.atIndex[ix] : null;
}

/**
 * The sea subregion under the pointer, or null off the water.
 *
 * Read from its own index, and only where the province array says ocean, which
 * is the rule seaAtEvent follows too, so a stray pixel in either sea bitmap can
 * never take a click away from the land.
 */
function subAtEvent(ev) {
  const w = state.world;
  const subs = w && w.subs;
  if (!subs) return null;
  const i = cellAtEvent(ev);
  if (i < 0 || w.provinceAt[i] !== OCEAN) return null;
  const ix = subs.subAt[i];
  return ix === 0 ? null : subs.atIndex[ix].id;
}

/**
 * The sea region under the cursor, or null.
 *
 * Land wins wherever the two bitmaps disagree, on the same rule the painter
 * follows, so the answer here is always the one on the screen.
 */
function seaAtEvent(ev) {
  const w = state.world;
  const sea = w && w.sea;
  if (!sea) return null;
  const i = cellAtEvent(ev);
  if (i < 0 || w.provinceAt[i] !== OCEAN) return null;
  const region = sea.seaAt[i];
  return region === 0 ? null : sea.atIndex[region].id;
}

/** Marks a sea region for repaint, unless it is over the highlight ceiling. */
function invalidateSea(...ids) {
  const sea = state.world && state.world.sea;
  if (!sea) return;
  for (const id of ids) {
    const bb = id && sea.bounds.get(id);
    if (bb && !tooBigToLightBox(bb)) dirtyBoxes.push(...boxesFor(state.world, bb));
  }
}

/** Selects a sea region, or clears the selection when `id` is null. */
function selectSea(id) {
  if (state.selectedSea === id) return;
  const was = state.selectedSea;
  state.selectedSea = id;
  if (id) playWater();
  invalidateSea(was, id);
}

/**
 * The subregion picked, and the one under the pointer.
 *
 * Both repaint the whole water buffer rather than a box, because a subregion
 * has no bounds cached the way a region does and the shade table is rebuilt for
 * the mode anyway. It is only ever done in the Navy mode, where the water is
 * the subject.
 */
function selectSub(id) {
  if (state.selectedSub === id) return;
  state.selectedSub = id;
  if (id) playWater();
  if (state.mode === 'navy') invalidateBuffer();
}

function hoverSub(id) {
  if (state.hoveredSub === id) return;
  state.hoveredSub = id;
  if (state.mode === 'navy') invalidateBuffer();
}

/** The hover equivalent. Kept apart so the two never repaint each other twice. */
function hoverSea(id) {
  if (state.hoveredSea === id) return;
  const was = state.hoveredSea;
  state.hoveredSea = id;
  invalidateSea(was, id);
}

/**
 * How much of a dropped selection's highlight is still showing, 1 down to 0.
 *
 * Smoothstepped rather than linear, so it leaves at once and settles gently
 * instead of stopping dead at the end of its time.
 */
function fadeStrength() {
  if (!state.fade) return 0;
  const t = (performance.now() - state.fade.t0) / DESELECT_FADE_MS;
  if (t >= 1) return 0;
  const k = 1 - t;
  return k * k * (3 - 2 * k);
}

/** Selects a province, or clears the selection when `id` is null. */
function select(id) {
  const was = state.selected;
  if (was === id) {
    // Selecting what is already selected still has to show the card. A right
    // click selects the province the county sits in and then closes its card,
    // so the left click that follows arrives with the province already selected
    // and used to return here, leaving no card open at all.
    if (id) updateCard();
    return;
  }
  state.selected = id;
  if (id) playSelect();

  // Exactly two groups change shade: what was highlighted before, and what is
  // highlighted now — each being a province plus its neighbours. Repainting just
  // those is what keeps selecting instant on a large map.
  invalidateProvinces(was, id);
  for (const q of neighboursOf(was)) invalidateProvinces(q);
  for (const q of neighboursOf(id)) invalidateProvinces(q);

  // A fade already running is about to be thrown away, and its provinces are
  // sitting in the buffer painted at whatever strength it had reached. Nothing
  // else will ever come back for them: the lines above invalidate the previous
  // selection and the new one, but this fade belongs to the selection BEFORE
  // that, which is no longer named anywhere. Left alone they stay half-lit for
  // the rest of the session.
  //
  // Selecting faster than the fade lasts is the only way to reach this, so it
  // went unnoticed while a click on a large province took longer than the fade
  // itself. It is the stale patches on the map.
  if (state.fade) invalidateProvinces(state.fade.id, ...state.fade.neighbours);

  // Hand what was selected over to the fade, along with its traced shape so the
  // ring can keep being drawn while it dies away. Its neighbour set is copied
  // now because the fade outlives the selection that defined it.
  state.fade = was
    ? { id: was, neighbours: new Set(neighboursOf(was)), silhouette: state.silhouette, outline: null, t0: performance.now() }
    : null;

  // Trace the shape once here, since that is the costly part. The ring itself is
  // left for drawView() to build, because it depends on the current zoom.
  // Same ceiling as the fill: the ring is grown from a silhouette the size of
  // the province's bounding box, so one spanning the map wants a 60MB canvas
  // and a 15.9 million pixel loop before a single frame can be drawn.
  state.silhouette = id && !tooBigToLight(state.world, id) ? buildSilhouette(state.world, id) : null;
  state.outline = null;
  updateCard();
  updatePanel();
}

/* ------------------------------------------------------- the county under the
 * right button
 *
 * The left button picks a province, which is the thing you own and fight over.
 * The right picks the ground under the pointer, which is a county.
 *
 * BOTH RINGS SHOW AT ONCE — gold around the province, white around the county
 * inside it. Only the CARDS take turns, because they share a corner and one
 * would cover the other. A right click therefore closes the province card and
 * leaves everything else about the province exactly as it was.
 *
 * The highlight is a traced ring rather than a change of shade, because a shade
 * would have to be baked into the map and the map is only coloured by county in
 * one of its five modes. A ring is drawn over the top and so reads the same
 * whichever mode is showing.
 */

/** Picks the county under the pointer, or clears it when `id` is null. */
function selectCounty(id) {
  const w = state.world;
  const county = id && w.counties ? w.counties.byId.get(id) : null;
  if (!county) {
    const had = state.county;
    state.county = null;
    els.countyCard.classList.remove('open');
    els.countyCard.setAttribute('aria-hidden', 'true');
    // The ring is drawn straight onto the view rather than into the map buffer,
    // so clearing it needs a frame to be asked for. Without this it stays on
    // screen until something else happens to want one.
    if (had) invalidateView();
    return;
  }

  playSelect();

  // A county is a few thousand pixels at the most, so unlike a province there
  // is no size at which tracing one is too expensive to be worth doing.
  state.county = {
    id,
    silhouette: buildSilhouette(w.counties, id, w.counties.countyAt),
    outline: null,
  };
  updateCountyCard(county);
  invalidateView();
}

/** Fills the county panel and slides it in. */
function updateCountyCard(county) {
  const w = state.world;
  const province = w.byId.get(county.province);
  const pol = province ? polityOf(w, province) : UNKNOWN_POLITY;

  els.countyName.textContent = county.name;
  els.countyFlag.style.background = `rgb(${pol.colour})`;
  els.countyPolity.textContent = pol.name;
  els.countyProvince.textContent = province ? province.name : '—';

  // Only when the ground is held by somebody other than its owner, which is
  // the one case where "who owns this" has two answers.
  const owner = province && province.occupier && province.occupier !== province.owner
    ? w.table.polityById.get(province.owner) : null;
  els.countyOwner.hidden = !owner;
  els.countyOwner.textContent = owner ? `occupied — owned by ${owner.name}` : '';

  els.countyTerrain.textContent = county.terrain.join(' + ') || '—';
  els.countyClimate.textContent = county.climate || '—';

  // Nothing builds railways yet, so this reads No everywhere until something
  // does. The row is here rather than waiting for the mechanic because a
  // county with no railway is a fact about it, not a missing field.
  els.countyRail.textContent = county.rail ? 'Yes' : 'No';
  // Same wording as the province card, superscript and all — the two sit in the
  // same corner and one saying km2 beside the other saying km² reads as a typo.
  els.countyArea.textContent = county.area >= 1e6
    ? `${(county.area / 1e6).toFixed(2)}M km²`
    : `${Math.round(county.area).toLocaleString()} km²`;

  els.countyCard.classList.add('open');
  els.countyCard.setAttribute('aria-hidden', 'false');
}

/** A province's neighbour ids, or nothing at all when `id` is null. */
const neighboursOf = (id) => (id && state.world.adjacency.get(id)) || [];

/* ------------------------------------------- provinces changing hands
 *
 * ownership.js does the work and reports what it disturbed. Two parts are left
 * here because they need the page: a label has to be fitted against measured
 * type, and a repaint has to go through the dirty flags so that a hundred
 * provinces changing at once still costs one repaint on the next frame.
 */

/**
 * Hands provinces to new owners.
 *
 * `changes` is an iterable of [provinceId, polityId]. Returns true if anything
 * actually moved. Events and the AI will call this; for now the console does,
 * through window.game.
 */
function changeOwners(changes) {
  const w = state.world;
  if (!w) return false;

  const result = setOwners(w, w.geometry, changes);
  if (!result) return false;

  // Only the blocks that were regrouped. Every other name on the map keeps the
  // label it already had, down to the glyph.
  for (const b of result.blocks) w.labels[b] = buildLabel(w, w.geometry, b);

  // Which provinces a realm holds is precisely what a change of owner alters,
  // so its blocks are rebuilt and relabelled with it.
  for (const b of addRealmBlocks(w, w.geometry)) w.labels[b] = buildLabel(w, w.geometry, b);

  // A country can lose the last ground it could write on here, or gain its first,
  // and either way how much of it goes unnamed has changed.
  nameArchipelagos(w, w.geometry, w.labels);

  dirtyBoxes.push(...result.boxes);

  // Both of these show the owner, so they are stale if what they are describing
  // is one of the provinces that moved.
  if (state.selected && result.changed.includes(state.selected)) {
    updateCard();
    updatePanel();
  }
  return true;
}

const swatch = (rgb) => `<span class="swatch" style="background: rgb(${rgb})"></span>`;

const TOOLTIP_OFFSET = 14;

// Which province the open tooltip is describing, and the local time it is
// showing for it. Both null while it is closed or naming a sea, which has no
// time of its own. See refreshTooltipTime, which is what they are kept for.
let tipFor = null;
let tipTime = null;
let tipHead = '';
let tipTail = '';

/** The time as it appears in the tooltip, separator and all, or nothing. */
const timeMarkup = (t) => (t ? ` &middot; ${t}` : '');

/**
 * Local time at a province, rounded to the nearest 20 minutes.
 *
 * 20 minutes because that is one tick, so the tooltip never claims a precision
 * the simulation cannot hold: nothing can happen between two readings of this.
 *
 * Taken at the province's centre of mass rather than under the cursor, so the
 * figure belongs to the province being named and does not change as the pointer
 * crosses it.
 */
function localTimeAt(world, id) {
  const bb = world.bounds.get(id);
  if (!bb) return null;

  const lon = mapLonAt(bb.cx, world.width);
  const hours = localHours(lon, sunUtcHour, world.width);

  // Round to the tick, then carry the wrap: 23:56 rounds to 24:00, which is
  // 00:00 of the next day and not a time anybody writes down.
  const ticks = Math.round((hours * 60) / 20) % 72;
  const mins = ticks * 20;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/**
 * Shows the tooltip and puts it beside the pointer.
 *
 * Flipped to the other side of the pointer where it would run off the window.
 * Measured after the content is in, since how wide it is depends on what it
 * says.
 */
function placeTooltip(ev) {
  els.tooltip.hidden = false;

  const box = els.wrap.getBoundingClientRect();
  const x = ev.clientX - box.left;
  const y = ev.clientY - box.top;
  const tw = els.tooltip.offsetWidth;
  const th = els.tooltip.offsetHeight;

  els.tooltip.style.left = `${x + TOOLTIP_OFFSET + tw > box.width ? x - TOOLTIP_OFFSET - tw : x + TOOLTIP_OFFSET}px`;
  els.tooltip.style.top = `${y + TOOLTIP_OFFSET + th > box.height ? y - TOOLTIP_OFFSET - th : y + TOOLTIP_OFFSET}px`;
}
/**
 * Shows the hover tooltip, or hides it when `id` is null.
 *
 * It normally sits below and right of the cursor, but flips to the other side
 * when it would otherwise run past the edge of the map area.
 */
function showTooltip(id, ev, seaId = null) {
  const w = state.world;
  if (!id && !seaId) { els.tooltip.hidden = true; tipFor = null; return; }

  if (id) {
    const p = w.byId.get(id);
    const pol = polityOf(w, p);
    const time = localTimeAt(w, id);
    // The county under the cursor, where there is one. It is the level armies
    // move on, so it is worth naming even when the map is showing something else,
    // and its terrain is more use than the province's, being the ground itself
    // rather than the average of a dozen counties.
    const county = countyAtEvent(ev);
    // Held in two halves with the time between them, so the clock ticking over
    // can rewrite it without any of this being worked out again. countyAtEvent
    // in particular needs a pointer event, and by then there is not one.
    tipFor = id;
    tipTime = time;
    tipHead =
      `<div>${p.name}</div>` +
      `<div class="sub">${swatch(pol.colour)}${pol.name}`;
    tipTail = '</div>' +
      (county
        ? `<div class="sub">${county.name} &middot; ${county.terrain.join(' + ')}`
          + ` &middot; ${county.climate}</div>`
        : `<div class="sub">${[...p.terrain, ...p.climate].join(' &middot; ')}</div>`);
    els.tooltip.innerHTML = tipHead + timeMarkup(time) + tipTail;
  } else {
    // Named in every mode, whether or not the water can be picked in this one.
    // Knowing which sea is under the cursor is wanted as often on the political
    // map as on the chart.
    const r = w.sea.byId.get(seaId);
    tipFor = null;                 // a sea keeps no local time
    tipTime = null;
    // The subregion under the pointer as well, which is the level a fleet is
    // ordered to. The region is what the sea is called; the subregion is the
    // piece of it you would be moving into.
    const sub = w.subs && state.mode === 'navy' ? w.subs.byId.get(subAtEvent(ev)) : null;

    els.tooltip.innerHTML =
      `<div>${r.name}</div>` +
      `<div class="sub">${swatch(navyColour(r))}${[r.lake ? 'Lake' : 'Sea', ...r.tags].join(' &middot; ')}` +
      `${r.area ? ` &middot; ${areaText(r)}` : ''}</div>` +
      (sub
        // The band, and nothing else about the depth. It says how deep the water
        // is on its own; adding "deep" beside a band called Deep said it twice and
        // said it badly.
        ? `<div class="sub">${sub.name}${sub.depth ? ` &middot; ${sub.depth}` : ''}`
          + ` &middot; ${Math.round(sub.area).toLocaleString()} km²</div>`
        : '');
  }
  placeTooltip(ev);
}

/**
 * The resource row under the pointer, or null.
 *
 * Walked backwards, so where two stacks overlap the one drawn last, and
 * therefore the one on top, is the one answered with.
 */
function resourceAtEvent(ev) {
  if (state.mode !== 'resources' || !resourceHits.length) return null;
  const box = els.canvas.getBoundingClientRect();
  const x = ev.clientX - box.left;
  const y = ev.clientY - box.top;
  for (let i = resourceHits.length - 1; i >= 0; i--) {
    const h = resourceHits[i];
    if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
  }
  return null;
}

/**
 * Names the deposit under the pointer.
 *
 * The icon says which resource it is at a glance. This is for when a glance is
 * not enough: what the thing is called and what the province holds. No local
 * time, so tipFor is cleared and refreshTooltipTime leaves this alone.
 */
function showResourceTooltip(hit, ev) {
  const w = state.world;
  const p = w.byId.get(hit.id);
  tipFor = null;
  tipTime = null;

  els.tooltip.innerHTML =
    `<div>${RESOURCE_NAME[hit.kind] ?? hit.kind}</div>` +
    `<div class="sub">deposit ${hit.amount} &middot; yield 0 a day</div>` +
    `<div class="sub">${p ? p.name : ''}</div>`;
  placeTooltip(ev);
}

const panelOpen = () => els.panel.classList.contains('open');

/**
 * Slides the development inspector in or out, bound to the backtick key.
 *
 * The panel is a debugging tool rather than part of the game, so it starts
 * closed and takes up no layout space at all when closed — the map simply gets
 * the full width. The animation itself lives in the CSS; all this does is set
 * the class that drives it.
 *
 * Contents are rebuilt on the way in, because selections made while it was
 * closed did not bother updating a panel nobody could see.
 */
function togglePanel() {
  els.panel.classList.toggle('open');
  document.getElementById('toggle-panel').classList.toggle('active', panelOpen());
  if (panelOpen()) {
    updatePanel();
    readoutAt = 0;             // refresh the live numbers at once, not up to 250ms later
  }
  // The slide resizes the canvas continuously, and frame() notices that on each
  // tick and redraws to match — so the map keeps step with the panel rather than
  // being stretched to fit until the animation ends. Nothing further is needed.
}

/**
 * A province's true surface area, as a line of text.
 *
 * Written into provinces.json by sync-provinces.js, which needs true_area.png to
 * work out where the map sits between the poles — so it can legitimately be
 * absent, and that is worth saying plainly rather than showing a zero that
 * looks like a measurement. Above a million the figure is given in millions,
 * since six digits of square kilometres is precision nobody reads.
 */
function areaText(p) {
  if (typeof p.area !== 'number') return '— (run sync-provinces.js)';
  return p.area >= 1e6
    ? `${(p.area / 1e6).toFixed(2)}M km²`
    : `${Math.round(p.area).toLocaleString()} km²`;
}

/* ------------------------------------------------------ the province card
 *
 * What a province HAS, as opposed to what it is. Everything here is read from
 * data/json/province-stats.json, which sync-provinces.js keeps an entry in for every
 * province; the map data itself knows nothing about roads or factories.
 *
 * Order matters as much as content. Ownership sits at the top because it is the
 * one fact that decides what any of the rest is worth, then the two figures that
 * are counts of people and claims, then the built things in a grid, then the
 * factories — which get sockets rather than a number because their whole point
 * is that there is a limited number of places to put one.
 */
// Each of these is a PAIR in the stats file, [built, max]: what is there and
// what the province could hold. Shown as "0/0", so a province that simply has
// no road reads differently from one that can never have one.
// Six, so the two columns come out square.
//
// Rail is deliberately absent. It is built county by county and has no level,
// so it does not belong in a list of province levels; it will be shown as a
// share of counties once counties exist. Air base took the slot it left.
const CARD_FIELDS = [
  ['road', 'Road'],
  ['airBase', 'Air base'],
  ['supplyHub', 'Supply hub'],
  ['fortification', 'Fortification'],
  ['electricity', 'Electricity'],
  ['antiAir', 'Anti-air'],
];

/** "built / max", tolerating a bare number from a stats file written before. */
function pair(v) {
  const [built, max] = Array.isArray(v) ? v : [v ?? 0, 0];
  return `${built ?? 0}/${max ?? 0}`;
}

// Sockets drawn when a province has no slots recorded at all. They are shown
// locked rather than left out, so the panel keeps its height as provinces are
// filled in and the mechanic is visible before any data exists.
const CARD_GHOST_SLOTS = 5;

/** Zeroes, for a province the stats file has never heard of. */
const BLANK_STATS = { claims: [], population: 0, road: [0, 0], airBase: [0, 0], supplyHub: [0, 0], fortification: [0, 0], electricity: [0, 0], antiAir: [0, 0], buildingSlots: [0, 0], civilianFactories: 0, militaryFactories: 0 };

const cardOpen = () => els.card.classList.contains('open');

function closeCard() {
  els.card.classList.remove('open');
  els.card.setAttribute('aria-hidden', 'true');
}

/**
 * Draws the province's building slots: civilian first, then military, then the
 * ones still empty.
 *
 * One strip for both types on purpose. They are not two separate allowances but
 * a single pool, so every factory built takes a socket the other kind can no
 * longer have — and a row each would say the opposite.
 */
function drawSlots(host, unlocked, civ, mil) {
  host.innerHTML = '';
  const ghost = unlocked === 0;
  const n = ghost ? CARD_GHOST_SLOTS : unlocked;
  for (let i = 0; i < n; i++) {
    const box = document.createElement('span');
    box.className = 'card-slot'
      + (ghost ? ' locked' : i < civ ? ' civ' : i < civ + mil ? ' mil' : '');
    host.append(box);
  }
}

/**
 * Fills the card for the current selection, and slides it in or out.
 *
 * Called from select(), so it follows the selection exactly: clicking open sea
 * or pressing Escape closes it, because both clear the selection.
 */
function updateCard() {
  const w = state.world;
  if (!w || !state.selected) return closeCard();

  const p = w.byId.get(state.selected);
  const stats = { ...BLANK_STATS, ...(w.stats?.[p.id] || {}) };
  const polity = polityOf(w, p);

  els.cardName.textContent = p.name;
  els.cardPolity.textContent = polity.name;
  els.cardFlag.style.background = `rgb(${polity.colour})`;

  // Under occupation the card has to carry both facts. `polityOf` reports the
  // controller, since that is what the map is coloured by, so the de jure owner
  // is named underneath and the label above it changes to say which is which.
  const occupied = p.occupier && p.occupier !== p.owner;
  const owner = occupied ? w.table.polityById.get(p.owner) : null;
  els.cardRole.textContent = occupied ? 'Occupying power' : 'Province owner';
  els.cardOwner.hidden = !occupied;
  // Cleared, not just hidden. The line is only true of the province it was
  // written for, and leaving it in place had the card telling the next one it
  // was occupied when the stylesheet failed to take it down.
  els.cardOwner.textContent = occupied ? `Owned by ${owner?.name || p.owner}` : '';

  // Claims are polity ids in the file; show the names, since an id is a slug.
  const claims = (stats.claims || [])
    .map((id) => w.table.polityById.get(id)?.name || id);
  els.cardClaims.textContent = claims.length ? claims.join(', ') : 'None';

  els.cardPop.textContent = stats.population.toLocaleString();
  els.cardArea.textContent = areaText(p);

  els.cardGrid.innerHTML = CARD_FIELDS
    .map(([key, label]) => `<div class="card-cell"><span>${label}</span><b>${pair(stats[key])}</b></div>`)
    .join('');

  // Used against unlocked, which is the figure that decides whether anything
  // more can be built here at all.
  const [unlocked = 0] = Array.isArray(stats.buildingSlots) ? stats.buildingSlots : [0, 0];
  const civ = stats.civilianFactories || 0;
  const mil = stats.militaryFactories || 0;
  els.cardSlotsN.textContent = `${civ + mil}/${unlocked}`;
  drawSlots(els.cardSlots, unlocked, civ, mil);
  els.cardCivN.textContent = civ;
  els.cardMilN.textContent = mil;

  els.card.classList.add('open');
  els.card.setAttribute('aria-hidden', 'false');
}

/** Rewrites the development inspector for the current selection. */
function updatePanel() {
  if (!panelOpen()) return;                       // nothing to update while it is closed
  const w = state.world;
  if (!state.selected) {
    els.selName.textContent = '—';
    els.selBody.innerHTML = '<span class="hint">Click a province on the map.</span>';
    els.neighbours.innerHTML = '';
    return;
  }
  const p = w.byId.get(state.selected);
  const nb = [...w.adjacency.get(p.id)]
    .map((id) => w.byId.get(id))
    .sort((a, b) => a.name.localeCompare(b.name));

  els.selName.textContent = p.name;
  els.selBody.innerHTML = `
    <div class="row"><span>ID</span><span>${p.id}</span></div>
    <div class="row"><span>Owner</span><span>${swatch(polityOf(w, p).colour)}${polityOf(w, p).name}</span></div>
    <div class="row"><span>Terrain</span><span>${p.terrain.join(' + ') || '—'}</span></div>
    <div class="row"><span>Climate</span><span>${p.climate.join(' + ') || '—'}</span></div>
    <div class="row"><span>Coastal</span><span>${w.coastal.has(p.id) ? 'yes' : 'no'}</span></div>
    <div class="row"><span>Area</span><span>${areaText(p)}</span></div>
    ${tooBigToLight(w, p.id) ? '<div class="row"><span>Highlight</span><span class="warn">off, box '
      + (w.bounds.get(p.id).maxX - w.bounds.get(p.id).minX + 1) + ' wide by '
      + (w.bounds.get(p.id).maxY - w.bounds.get(p.id).minY + 1) + '</span></div>' : ''}
    <div class="row"><span>Pixels</span><span>${w.bounds.get(p.id)?.n ?? 0}</span></div>
    <div class="row"><span>Neighbours</span><span>${nb.length}</span></div>`;
  els.neighbours.innerHTML = `<h1>Adjacent provinces</h1><ul>${nb.map((q) => `<li data-id="${q.id}">${swatch(polityOf(w, q).colour)}${q.name}</li>`).join('')
    }</ul>`;
}

// Bumped whenever this file is edited, and shown in the debug menu. If what is
// on screen does not match what is in the file, this is how you find out.
const BUILD = 'v0.7-indev';

/** The size a ring was traced at, for the readout. */
const ringShape = (holder) => (holder.silhouette
  ? `(${holder.silhouette.w}&times;${holder.silhouette.h})`
  : '(NO SHAPE)');

const READOUT_MS = 250;    // refresh rate of the live numbers; per-frame DOM writes are wasteful
let readoutAt = 0;

const statRow = (k, v, warn) =>
  `<div class="row"><span>${k}</span><span${warn ? ' class="warn"' : ''}>${v}</span></div>`;

/**
 * Refreshes the Performance block, a few times a second.
 *
 * Rewriting this every frame would itself cost more than most of what it
 * measures, and the numbers are eased averages that barely move between frames.
 */
function updateReadout(now) {
  if (!panelOpen() || now - readoutAt < READOUT_MS) return;
  const since = now - readoutAt;
  readoutAt = now;

  // Ticks actually delivered against the ticks asked for, which is the figure
  // that says whether the simulation is keeping up. They part company when a
  // frame cannot be turned round inside a tick, and the clock then falls behind
  // real time rather than running the world in bursts. The first call has no
  // previous reading to measure against, so it reports nothing.
  const target = 1000 / SPEEDS[clock.speed - 1];
  const achieved = since > 0 && since < 2000 ? ((clock.ticked - clock.rateFrom) * 1000) / since : 0;
  clock.rateFrom = clock.ticked;

  const drawing = overviewCovers(view.scale) ? 'overview' : 'tiles';
  // Null until the chunks are built. Reading through it is what took the render
  // loop down once already.
  const chunks = tiles ? tiles.list.length : 0;
  const visible = drawing === 'tiles' ? `${debug.tilesDrawn} / ${chunks}` : `0 / ${chunks}`;

  els.perf.innerHTML =
    statRow('Build', BUILD) +
    statRow('Tick', `${clock.tick}${clock.paused ? ' (paused)' : ''}`) +
    statRow('Ticks/s', `${achieved.toFixed(1)} / ${target.toFixed(1)} at speed ${clock.speed}`,
      !clock.paused && achieved < target * 0.9) +
    statRow('Sun', `${sunUtcHour.toFixed(2)}h, day ${sunDayOfYear}, +${Math.round(sunShiftPx(state.world))}px`) +
    // Should track days elapsed and nothing faster. If this climbs with the
    // tick count then the mask is being rebuilt per tick and the reuse above
    // has been defeated.
    statRow('Mask builds', `${perf.maskBuilds} (${Math.floor(clock.tick / TICKS_PER_DAY) + 1} days)`,
      perf.maskBuilds > Math.floor(clock.tick / TICKS_PER_DAY) + 2) +
    statRow('Frame', `${perf.frameMs ? (1000 / perf.frameMs).toFixed(0) : 0} fps`, perf.frameMs > 22) +
    statRow('Blit', `${perf.draw.toFixed(2)} ms`, perf.draw > 8) +
    statRow('  night', `${perf.night.toFixed(2)} ms`, perf.night > 4) +
    statRow('  labels', `${perf.labels.toFixed(2)} ms`, perf.labels > 3) +
    statRow('  cities', `${perf.cities.toFixed(2)} ms`, perf.cities > 3) +
    statRow('Last paint', `${perf.paint.toFixed(2)} ms`, perf.paint > 16) +
    (state.mode === 'resources'
      ? statRow('Resources', `${perf.resources.toFixed(2)} ms, ${debug.resourcesDrawn || 0} stacks`
        + `, ${resourceLineCache.size} baked`
        , perf.resources > 4)
      : '') +
    // Three separate delays, and only the middle one is this page's fault.
    statRow('Click sound', sfx.buffer
      ? `${(sfx.offset * 1000).toFixed(0)}ms trimmed, ${(sfx.attack * 1000).toFixed(0)}ms attack,`
        + ` ${(sfxDelay * 1000).toFixed(0)}ms held,`
        + ` ${sfx.lag.toFixed(1)}ms to answer,`
        + ` ${sfx.base + sfx.output ? `${((sfx.base + sfx.output) * 1000).toFixed(0)}ms device` : 'device n/a'}`
        + `, peak ${sfx.peak.toFixed(2)}`
      : 'not loaded', sfx.lag > 8) +
    // The single number that decides whether a frame can be delivered on time.
    // Everything above is JavaScript, and it is now small; what costs the rest is
    // the browser rasterising and compositing a surface of this many pixels every
    // frame. Display scaling counts twice over — 150% is 2.25x the area.
    statRow('Canvas', `${els.canvas.width} &times; ${els.canvas.height}`
      + ` (${(els.canvas.width * els.canvas.height / 1e6).toFixed(1)}M px @ ${pixelRatio.toFixed(2)}x of ${(window.devicePixelRatio || 1)})`,
      els.canvas.width * els.canvas.height > 5e6) +
    (frameFault
      ? statRow('LOOP THREW', `${frameFault.message} (${frameFaults} frames)`, true)
      : '') +
    statRow('Repaints', `${perf.fullRepaints} full / ${perf.partRepaints} part`) +
    statRow('Repainting', repaintPass && tiles
      ? `${tiles.list.length - repaintPass.todo.size} / ${tiles.list.length} chunks`
      : 'idle', !!repaintPass) +
    statRow('Drawing from', drawing) +
    statRow('Chunks drawn', visible) +
    statRow('Zoom', `${view.scale.toFixed(2)}  (${Math.round(view.scale * 100)}%)`) +
    statRow('Cursor', debug.cursor
      ? `x ${debug.cursor.x}, y ${debug.cursor.y}` +
        `${debug.cursor.copy ? ` (copy ${debug.cursor.copy > 0 ? '+' : ''}${debug.cursor.copy})` : ''}` +
        `${debug.cursor.y < 0 || debug.cursor.y >= state.world.height ? ' — off the map' : ''}`
      : '—') +
    // Both rings, and the SHAPE each one is traced from. A ring with no shape
    // behind it draws nothing and looks exactly like a ring that was never asked
    // for, which is how the county highlight stayed missing.
    statRow('Sea subregions', state.world.subs
      ? `${(state.world.subs.atIndex.length - 1).toLocaleString()} drawn`
        + `${state.hoveredSub ? `, over ${state.hoveredSub}` : ''}`
      : 'none — run: node sync-provinces.js --regen-sea-subs --write --cache') +
    statRow('Highlighted', [
      state.selected ? `province ${state.selected} ${ringShape(state)}` : null,
      state.county ? `county ${state.county.id} ${ringShape(state.county)}` : null,
    ].filter(Boolean).join(' + ') || 'nothing') +
    statRow('Rivers', state.world.rivers
      ? `${cityFade(F_RIVER).toFixed(2)} @ ${RIVER_AT}, ${RIVER_ALPHA} when full`
      : 'no rivers.png') +
    statRow('City icons', `${cityFade(F_CITY).toFixed(2)} @ ${CITY_AT}`) +
    statRow('Capital icons', `${cityFade(F_CAPITAL).toFixed(2)} @ ${CAPITAL_AT}`) +
    statRow('City names', `${cityFade(F_CITY_NAME).toFixed(2)} @ ${CITY_NAME_AT}`) +
    statRow('Capital names', `${cityFade(F_CAPITAL_NAME).toFixed(2)} @ ${CAPITAL_NAME_AT}`) +
    statRow('Load', `${perf.load.ms.toFixed(0)} ms ${perf.load.cached ? '(cached)' : '(computed)'}`, !perf.load.cached) +
    (state.showProvinceNames ? statRow('Names shown', `${debug.names} / ${state.world.byId.size}`) : '') +
    (state.showSeaNames && state.world.sea
      ? statRow('Sea names shown', `${debug.seaNames} / ${state.world.sea.byId.size}`) : '');
}

/** One-off summary of the loaded map. Nothing here changes after load. */
function showStats(w) {
  // Each border is recorded on both provinces, so the total is halved below.
  let edges = 0;
  for (const s of w.adjacency.values()) edges += s.size;
  const px = w.width * w.height;
  const empty = [...w.byId.values()].filter((p) => !w.bounds.has(p.id)).length;

  els.stats.innerHTML =
    statRow('Size', `${w.width} &times; ${w.height}`) +
    statRow('Pixels', `${(px / 1e6).toFixed(1)}M`) +
    statRow('Provinces', w.byId.size) +
    statRow('Borders', edges / 2) +
    statRow('Coastal', w.coastal.size) +
    statRow('Counties', w.counties
      ? `${(w.counties.atIndex.length - 1).toLocaleString()} in ${w.byId.size} provinces`
      : 'none', !w.counties) +
    statRow('Sea regions', w.sea
      ? `${w.sea.atIndex.length - 1} (${w.sea.atIndex.slice(1).filter((r) => r.lake).length} lakes)`
      : 'none', !w.sea) +
    statRow('Polities', w.table.polities.length - 1) +
    statRow('Labels', `${w.labels.filter(Boolean).length} / ${w.labels.length} blocks`) +
    statRow('Chunks', tiles ? `${tiles.cols} &times; ${tiles.rows} @ ${TILE}px` : 'not built yet') +
    statRow('Overview', `${overview.canvas.width} &times; ${overview.canvas.height}`) +
    statRow('Cities', w.cities.length
      ? `${w.cities.length} (${w.cities.filter((c) => c.capital).length} capital)`
      : 'none', !w.cities.length) +
    statRow('Satellite', w.satellite ? `${w.satellite.width} &times; ${w.satellite.height}` : 'none',
      !!w.satellite && (w.satellite.width !== w.width || w.satellite.height !== w.height)) +
    // A province in the table with no pixels is invisible and unclickable, so
    // it is worth flagging here rather than only in the console at load.
    statRow('Empty', empty, empty > 0);
}

/* ---------------------------------------------------------- the pause menu
 *
 * Esc from the map, once there is nothing left to deselect.
 *
 * Escape already drops a selection, and this takes the press only when that
 * press would otherwise do nothing at all. So the key keeps one meaning rather
 * than two: put down whatever is being held, and when nothing is being held,
 * stop. Reaching the menu is then a matter of pressing it twice, and never a
 * matter of remembering which of the two it is about to do.
 */

/** Whether the start screen has been dismissed, so the map is what is on show. */
const mapIsShowing = () => document.getElementById('start')?.classList.contains('gone') === true;

const pauseOpen = () => els.pause.classList.contains('open');

function setPause(open) {
  els.pause.classList.toggle('open', open);
  els.pause.setAttribute('aria-hidden', String(!open));

  if (!open) {
    els.canvas.focus?.();
    return;
  }

  // Nothing on the map is being pointed at any more. The scrim takes the
  // pointer from here on, so no mousemove will reach the canvas to correct
  // either of these, and a tooltip left showing would hang over the menu until
  // it closed. The highlight under it would sit there just as long.
  els.tooltip.hidden = true;
  invalidateProvinces(state.hovered);
  state.hovered = null;

  document.getElementById('pause-resume')?.focus();
}

/**
 * Back to the start screen, with the map left standing behind it.
 *
 * Nothing is torn down. The world, the tiles, the labels and the view all
 * survive, so Enter puts you back exactly where you were rather than paying
 * for the load a second time — which is the whole reason this is a menu over
 * the map rather than a reload.
 *
 * What is dropped is what belonged to looking at a province: the selection,
 * its card and the panel describing it, all of which select(null) clears
 * through the same path as clicking open sea.
 */
function quitToStartMenu() {
  setPause(false);
  select(null);
  showStartMenu();
}

// =================================================================== 7. input

// Drag pans, click selects — and the mouse cannot say which you meant until you
// either move or let go. A press that travels fewer than this many pixels before
// release counts as a click, which stops a shaky hand from eating selections.
const DRAG_SLOP = 4;

// ---------------------------------------------------------------- the click
//
// Four short sounds: one on every button press, one for picking a province or
// a county, and two for picking water, of which one is chosen at random.
//
// Each is fetched once and decoded into a buffer held in memory. Every press
// then starts a fresh source node, which is cheap, so presses overlap on their
// own. See loadSounds below for why this is not an Audio element.
const SFX_CLICK = './data/sfx/old_radio_button.ogg';
const SFX_SELECT = './data/sfx/province_county_selection.ogg';
// Two recordings of the water selection, one picked at random each time. A
// single sample repeated on every click is what makes an interface sound
// mechanical, and water is clicked a great deal in the Navy mode.
const SFX_WATER = [
  './data/sfx/region_subregion_selection.ogg',
  './data/sfx/region_subregion_selection_2.ogg',
];
const SFX_VOLUME = 0.35;

// Where the sound is judged to begin, as a share of its own peak. An absolute
// floor cannot do this: it clips the attack off a quiet recording and steps
// over the start of a loud one.
//
// A quarter of peak, because the ear places a sound at the point it gets loud
// and not at the point it becomes measurable. old_radio_button.ogg takes 112ms
// to reach a tenth of its peak, and every one of those milliseconds reads as
// the interface being slow.
const SFX_ONSET = 0.25;

// Backed off from that point, so the attack itself survives the trim. A click
// that starts at its loudest sounds like a tick.
const SFX_PREROLL = 0.002;   // seconds

// And then held back on purpose.
//
// A real button clicks at the bottom of its travel, not at first contact, so a
// sound that lands the instant the mouse goes down reads as early. This is the
// travel. It is scheduled on the audio clock rather than through a timer, so it
// is the same few milliseconds every time and not whatever the main thread was
// doing. Tune it by ear with game.clickDelay(ms).
let sfxDelay = 0;            // seconds, set by ear

const sfx = {
  ctx: null, buffer: null, gain: null, offset: 0, on: true,
  // The two selection sounds, decoded the same way as the click and each with
  // its own leading silence measured off it. select is ground, water is sea.
  select: null, selectOffset: 0,
  // One entry per recording, each { buffer, offset }. Empty if none loaded.
  water: [],
  // Reported in the debug panel. Between them these say which part of the
  // delay is the file, which is this page, and which is the sound hardware.
  lag: 0, base: 0, output: 0, peak: 0, attack: 0,
};

/**
 * Decodes the click once, into memory.
 *
 * This was an Audio element first, and it was audibly late. An element goes
 * through the media pipeline: play() is asynchronous by specification, and
 * rewinding with currentTime = 0 forces a seek. Together that is tens of
 * milliseconds, which is nothing for a soundtrack and far too much for a
 * button. A decoded buffer starts on the next audio callback instead.
 *
 * Nothing here is awaited by the caller. The interface works in silence while
 * the file is loading, and works in silence forever if it fails to.
 */
async function loadSounds() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx || sfx.ctx) return;
  try {
    sfx.ctx = new Ctx({ latencyHint: 'interactive' });
    sfx.gain = sfx.ctx.createGain();
    sfx.gain.gain.value = SFX_VOLUME;
    sfx.gain.connect(sfx.ctx.destination);
    const bytes = await (await fetch(SFX_CLICK)).arrayBuffer();
    sfx.buffer = await sfx.ctx.decodeAudioData(bytes);
    sfx.offset = leadingSilence(sfx.buffer);

    // Each of these is caught on its own. Losing one leaves the click and the
    // other working, and selecting something in silence is a smaller loss than
    // losing every button on the page.
    const decode = async (url) => {
      const raw = await (await fetch(url)).arrayBuffer();
      const buffer = await sfx.ctx.decodeAudioData(raw);
      return { buffer, offset: leadingSilence(buffer) };
    };

    try {
      const one = await decode(SFX_SELECT);
      sfx.select = one.buffer;
      sfx.selectOffset = one.offset;
    } catch { sfx.select = null; }

    for (const url of SFX_WATER) {
      try { sfx.water.push(await decode(url)); } catch { /* one variant short */ }
    }
    // What the device costs before a sample reaches a speaker. This is a floor
    // nothing in this file can get under, so it is worth being able to read.
    sfx.base = sfx.ctx.baseLatency || 0;
    sfx.output = sfx.ctx.outputLatency || 0;
  } catch {
    sfx.ctx = null;
    sfx.buffer = null;
  }
}

/**
 * Where the sound actually begins, in seconds.
 *
 * Silence at the head of the file is latency the listener cannot tell apart
 * from a slow interface, and it is not something a bitmap editor shows you.
 * Measuring it here means the file can be replaced without anyone having to
 * remember to trim it first.
 */
function leadingSilence(buf) {
  const d = buf.getChannelData(0);
  let peak = 0, peakAt = 0;
  for (let i = 0; i < d.length; i++) {
    const v = Math.abs(d[i]);
    if (v > peak) { peak = v; peakAt = i; }
  }
  sfx.peak = peak;
  if (!peak) return 0;

  const gate = peak * SFX_ONSET;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) >= gate) {
      // How long the sound takes to get from here to its loudest. A long
      // attack cannot be trimmed away, and it is what makes a sound feel late
      // when it is not, so it is reported instead.
      sfx.attack = Math.max(0, (peakAt - i) / buf.sampleRate);
      return Math.max(0, i / buf.sampleRate - SFX_PREROLL);
    }
  }
  return 0;
}

/**
 * Plays it. Never throws and never reports.
 *
 * A source node is single use, so every press gets a new one. They are cheap,
 * and it means presses overlap on their own with no pool to advance.
 */
function playClick(ev) {
  playSound(sfx.buffer, sfx.offset, ev);
}

// One gesture, one sound. A right click selects the county AND the province it
// sits in, both from the same handler, and two copies of one file a millisecond
// apart is a flam. The handler sets this for the province half, so the sound
// belongs to the county, which is what was actually asked for.
//
// A flag and not a delay. Suppressing anything within n milliseconds of the
// last sound also suppresses two deliberate clicks in quick succession, and
// makes which one you hear depend on how fast the machine is.
let quietSelect = false;
let quietWater = false;

/** Plays the ground selection sound. Called from select() and selectCounty(). */
function playSelect() {
  if (quietSelect) return;
  playSound(sfx.select, sfx.selectOffset);
}

/**
 * Plays the water selection sound. Called from selectSea() and selectSub().
 *
 * One of the recordings at random. With one loaded this is the same sound every
 * time, which is what happens if the other fails to load.
 */
function playWater() {
  if (quietWater || !sfx.water.length) return;
  const pick = sfx.water[Math.floor(Math.random() * sfx.water.length)];
  playSound(pick.buffer, pick.offset);
}

function playSound(buffer, offset, ev) {
  if (!sfx.on || !buffer) return;
  // How long the page took to answer the press. The browser stamps the event
  // when it happens; this runs whenever the main thread is next free. A large
  // figure here is a rendering problem wearing an audio costume.
  if (ev && ev.timeStamp) sfx.lag = ease(sfx.lag, Math.max(0, performance.now() - ev.timeStamp));
  try {
    // A context built before the first gesture starts suspended. The press
    // that gets here is that gesture.
    if (sfx.ctx.state === 'suspended') sfx.ctx.resume();
    const source = sfx.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(sfx.gain);
    source.start(sfx.ctx.currentTime + sfxDelay, offset);
  } catch { /* nothing to do about it and nothing worth saying */ }
}

/** Attaches every event listener. Called once, from init(). */
function wireInput() {
  loadSounds();

  // Every button on the page goes through one delegated listener, so a button
  // added later is covered without being wired up. Capture phase, so it still
  // fires where a handler below stops propagation. A disabled button is not a
  // press and makes no sound.
  //
  // On pointerdown, NOT on click. A click event is delivered when the button
  // comes back up, so the sound waited for the release: press and hold, and it
  // arrived whenever you let go. That is most of the delay this used to have,
  // and no amount of audio work would have found it, because the audio was
  // always prompt about answering the wrong event.
  const pressed = (ev) => {
    const b = ev.target && ev.target.closest && ev.target.closest('button');
    if (b && !b.disabled) playClick(ev);
  };
  document.addEventListener('pointerdown', pressed, true);

  // A button reached by keyboard never sees a pointer event. The click it does
  // send carries detail 0, which is how it is told apart from the one a mouse
  // sends, so Enter on a focused button still sounds and a mouse press does not
  // sound twice.
  document.addEventListener('click', (ev) => {
    if (ev.detail === 0) pressed(ev);
  }, true);

  // Shared by the mouse handlers below: whether a button is down, whether it has
  // yet travelled far enough to count as a drag, and where it last was.
  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };

  els.canvas.addEventListener('mousedown', (ev) => {
    dragging = true;
    moved = false;
    last = { x: ev.clientX, y: ev.clientY };
  });

  // On window, not the canvas, so a drag continues even when the pointer leaves
  // the map — and still ends properly if the button is released outside it.
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - last.x;
    const dy = ev.clientY - last.y;
    if (!moved && (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP)) {
      moved = true;
      els.canvas.classList.add('panning');
    }
    if (moved) {
      view.x += dx;
      view.y += dy;
      clampPan();
      invalidateView();
      last = { x: ev.clientX, y: ev.clientY };
    }
  });

  window.addEventListener('mouseup', (ev) => {
    // THE LEFT BUTTON ONLY. This fires for every button, so a right click used
    // to end here selecting the province under it — undoing, one event later,
    // the select(null) that the context menu handler had just done to get the
    // province card out of the way. Both panels then came up in the same corner,
    // one over the other.
    //
    // Never travelled past the slop, so it was a click after all.
    if (dragging && !moved && ev.button === 0) {
      const id = provinceAtEvent(ev);
      select(id);
      // Only the Navy mode lets the water be picked. On every other mode a click
      // on the sea clears the selection and does nothing else, which is what it
      // has always done.
      if (state.mode === 'navy') {
        const seaId = id ? null : seaAtEvent(ev);
        const subId = id ? null : subAtEvent(ev);

        // One gesture, one sound. A click on water picks the region AND the
        // subregion inside it. The subregion is the finer of the two and the
        // level a fleet is ordered to, so it makes the sound; where the water
        // has no subregion drawn, the region answers for it.
        quietWater = Boolean(subId);
        selectSea(seaId);
        quietWater = false;
        selectSub(subId);
      }
    }
    dragging = false;
    els.canvas.classList.remove('panning');
  });

  // Hover highlighting and the tooltip. Separate from the pan handler above,
  // since this one only cares about the canvas.
  els.canvas.addEventListener('mousemove', (ev) => {
    debug.cursor = mapPointAtEvent(ev);
    if (dragging && moved) { els.tooltip.hidden = true; return; }  // stay quiet mid-drag
    const id = provinceAtEvent(ev);
    // Only repaint when the province under the cursor actually changes, not on
    // every pixel of movement within one province.
    // Only the province being left and the one being entered change shade.
    if (id !== state.hovered) { invalidateProvinces(state.hovered, id); state.hovered = id; }

    // Water is looked up only where there is no province, since land wins.
    // The highlight belongs to the Navy mode alone; the tooltip does not.
    const seaId = id ? null : seaAtEvent(ev);
    hoverSea(state.mode === 'navy' ? seaId : null);
    hoverSub(state.mode === 'navy' && !id ? subAtEvent(ev) : null);

    // A deposit under the pointer wins over the ground under it. The stack is
    // drawn on top of the province and is what the pointer is aiming at, and
    // the province keeps its name in the layer's own colouring anyway.
    const deposit = resourceAtEvent(ev);
    if (deposit) showResourceTooltip(deposit, ev);
    else showTooltip(id, ev, seaId);
  });

  // The right button picks the county under it. preventDefault stops the
  // browser menu, which would otherwise cover the panel being opened.
  //
  // Land only. Right-clicking the sea puts the panel away, since there is no
  // county out there to describe and leaving the last one up would say there
  // is.
  // A left click anywhere puts the county away. It is a look at one patch of
  // ground, not a selection to be carried around: going off to click something
  // else means you are done with it, and leaving the panel up would have it
  // describing ground nowhere near what is now highlighted.
  els.canvas.addEventListener('mousedown', (ev) => {
    if (ev.button === 0) selectCounty(null);
  });

  els.canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const county = countyAtEvent(ev);

    // BOTH highlights. The province the county is in is lit in gold, exactly as
    // a left click would light it, and the county is ringed in white inside it —
    // seeing which province the ground belongs to is most of the point of
    // picking a county at all.
    //
    // Only the CARDS take turns, because they share a corner and one would cover
    // the other. select() opens the province card as part of selecting, so the
    // order here matters: light it first, then put its card away.
    // Silently, so the one sound this gesture makes is the county below.
    if (county) {
      quietSelect = true;
      select(county.province);
      quietSelect = false;
    }
    closeCard();
    selectCounty(county ? county.id : null);
  });

  els.canvas.addEventListener('mouseleave', () => {
    debug.cursor = null;
    invalidateProvinces(state.hovered);      // just clear the one that was lit
    state.hovered = null;
    hoverSea(null);
    hoverSub(null);
    els.tooltip.hidden = true;
  });

  // passive:false because preventDefault() is needed to stop the page scrolling.
  els.canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    // Exponential in the wheel delta, so one notch is always the same RATIO of
    // zoom. A fixed step would crawl when zoomed out and leap when zoomed in.
    zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.pow(1.0015, -ev.deltaY));
  }, { passive: false });

  document.getElementById('zoom-in').addEventListener('click', () => zoomCentre(1.4));
  document.getElementById('zoom-out').addEventListener('click', () => zoomCentre(1 / 1.4));
  document.getElementById('zoom-fit').addEventListener('click', fitToView);

  document.getElementById('toggle-panel').addEventListener('click', togglePanel);

  // The imagery is optional, so its switch reflects whether there is any.
  const sat = document.getElementById('toggle-satellite');
  sat.disabled = !state.world.satellite;
  sat.classList.toggle('active', state.satellite);

  // Every debug switch, from one listener. A button's data-toggle names the
  // field in `state` it drives, so a new one needs no wiring of its own — add
  // the button, add the field, and draw it in drawOverlays().
  els.toggles.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-toggle]');
    if (!b || b.disabled) return;
    const key = b.dataset.toggle;
    state[key] = !state[key];
    b.classList.toggle('active', state[key]);

    // Overlays draw over the finished map, so they only need another blit. A
    // switch marked data-repaint changes the painted map itself and needs the
    // tiles rebuilt, which is far more expensive — hence the distinction.
    if (b.hasAttribute('data-repaint')) invalidateBuffer();
    else invalidateView();
  });

  document.getElementById('pause-resume').addEventListener('click', () => setPause(false));
  document.getElementById('pause-quit').addEventListener('click', quitToStartMenu);

  els.clockPlay.addEventListener('click', () => setPaused(!clock.paused));
  els.clockSlower.addEventListener('click', () => setSpeed(clock.speed - 1));
  els.clockFaster.addEventListener('click', () => setSpeed(clock.speed + 1));

  window.addEventListener('keydown', (ev) => {
    // The start screen owns the keyboard while it is up. Its own handler runs
    // Enter, Space and Escape over there, and nothing in here should be acting
    // behind it — Space would pause a clock nobody can see, and the digits
    // would change a speed nobody asked about.
    //
    // This covers every press the start screen does not consume. The press that
    // dismisses it is the other half of the problem and is stopped at source,
    // since by the time it reached here the screen would already be gone. See
    // the note in openStartMenu.
    if (!mapIsShowing()) return;

    // The pause menu owns the keyboard while it is up. Zooming the map or
    // sliding out the debug panel behind a menu that has stopped to ask a
    // question is not something to support, and Escape is what answers it.
    if (pauseOpen()) {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      setPause(false);
      return;
    }

    if (ev.key === '+' || ev.key === '=') zoomCentre(1.4);
    else if (ev.key === '-' || ev.key === '_') zoomCentre(1 / 1.4);
    else if (ev.key === '0') fitToView();
    else if (ev.key === '`') togglePanel();
    else if (ev.key >= '1' && ev.key <= String(SPEEDS.length)) setSpeed(Number(ev.key));
    else if (ev.key === ' ') {
      // A focused button keeps its own keys, which is the rule the start menu
      // follows for Enter. Space is how a button is pressed, and taking it away
      // from whichever one has the focus to run the clock instead would break
      // the toolbar for anyone working it from the keyboard.
      if (document.activeElement?.tagName === 'BUTTON') return;
      ev.preventDefault();          // or the page tries to scroll on it
      setPaused(!clock.paused);
    }
    else if (ev.key === 'Escape') {
      // select(null) already clears the highlight, the ring and the panel, and
      // repaints only what was lit — the same path as clicking open sea. Only
      // once there is nothing left to clear does the press reach the menu.
      //
      // And only from the map: while the start screen is up this key belongs
      // to it and to whichever of its panels is open, and openStartMenu() is
      // already listening for it.
      // The county goes first: it is the most recent thing to have been opened
      // and the smallest, so Escape peeling it off before the province selection
      // is what somebody who just right-clicked expects.
      if (state.county) selectCounty(null);
      else if (state.selected) select(null);
      // Both levels of water at once. A click on the sea picks the region AND the
      // subregion inside it, so clearing only the region left the subregion lit
      // with nothing selected above it.
      else if (state.selectedSea || state.selectedSub) { selectSea(null); selectSub(null); }
      else if (mapIsShowing()) setPause(true);
    }
  });

  // One listener on the list rather than one per item, since updatePanel()
  // rebuilds its contents on every selection.
  els.neighbours.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-id]');
    if (li) select(li.dataset.id);
  });

  // Closing the card leaves the province selected: the ring and the debug panel
  // are a separate question from whether you want its details in the way.
  document.getElementById('card-close').addEventListener('click', closeCard);
  document.getElementById('county-close').addEventListener('click', () => selectCounty(null));

  els.toolbar.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (!b) return;                                // a click on some other button
    state.mode = b.dataset.mode;
    // Nothing outside the Navy mode draws the water, so a selection made there
    // would be invisible everywhere else and would come back on returning to it,
    // having been made on a map the player has since left.
    if (state.mode !== 'navy') { state.selectedSea = null; state.hoveredSea = null; }
    for (const other of els.toolbar.querySelectorAll('button[data-mode]')) {
      other.classList.toggle('active', other === b);
    }
    invalidateBuffer();      // a mode change recolours every province at once
  });

  // Catch a reload before it happens, since it throws away the view and costs a
  // second of loading to get back.
  //
  // Three things about this are the browser's call and not ours:
  //
  //   - THE WORDING. Every browser shows its own sentence and none of them can
  //     be replaced; returnValue is set only because the older ones need
  //     something non-empty there to treat the event as a refusal at all.
  //   - WHICH ACTION. Reloading, closing the tab and navigating away are one
  //     event, so a prompt on reload means a prompt on all three.
  //   - WHETHER IT APPEARS AT ALL. It is ignored until the page has been
  //     interacted with, which stops a page nobody has touched from trapping
  //     anyone. Pressing Enter on the start menu satisfies that.
  //
  // Only armed once the menu is gone: reloading while it is still up loses
  // nothing anyone would miss, and being asked to confirm before the game has
  // even started is just an obstacle.
  window.addEventListener('beforeunload', (ev) => {
    if (!mapIsShowing()) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  // No resize listener or ResizeObserver here on purpose: frame() compares the
  // canvas box against its pixel buffer on every tick, which catches window
  // resizes and the panel slide alike, and does it in time to draw that frame.
}

// ==================================================================== 8. boot

/**
 * Loads the data, builds the model, and starts the render loop.
 *
 * Order matters here: buildWorld() needs the normalised table, buildLabels()
 * needs the adjacency buildWorld() derives, and fitToView() needs the map's size
 * to know what to fit to.
 */
async function init() {
  const t0 = performance.now();
  setLoadingNote('Loading data…');

  // All four fetched together. The imagery is by far the largest, and waiting
  // for it after the others would add its whole download to the load time.
  const [raw, pngBytes, cacheBytes, satellite, rivers, night, cities, cityIcon, capitalIcon,
    resourceSheet, stats, resources, quotes,
    seaRaw, seaPngBytes, countyRaw, countyPngBytes, subPngBytes] = await Promise.all([
      loadJSON('./data/json/provinces.json'),
      loadBytes('./data/img/provinces.png'),
      loadBytes(`./data/${CACHE_FILE}`, true),
      loadBitmap('./data/img/satellite.png'),
      // The rivers, already lifted out of true_water_bodies_and_rivers.png and
      // coloured by the build step, so this is a mostly-transparent 179KB file
      // rather than a second full-size decode. Optional: without it the map
      // simply has no rivers drawn on it.
      loadBitmap('./data/img/rivers.png'),
      // City lights as they stood in the 1920s, aligned to provinces.png. Optional:
      // without it the night side is simply dark.
      loadBitmap('./data/img/night_1920s.png'),
      // Extracted from cities.png by the build step, so the page reads a few
      // kilobytes of JSON rather than decoding a second full-size bitmap.
      loadJSON('./data/json/cities.json', true),
      loadBitmap('./data/icons/city.png'),
      loadBitmap('./data/icons/capital.png'),
      // The eighteen resource icons on one sheet, six across and three down at
      // 64px a cell. Optional: without it the layer falls back to the short
      // words it used before there was any art.
      loadBitmap('./data/icons/resources.png'),
      // What has been built on each province. Optional: without it the card shows
      // zeros rather than refusing to open.
      loadJSON('./data/json/province-stats.json', true),
      // Every deposit on the map, for the resource layer. Optional: without it
      // the layer draws nothing and the rest of the map is unaffected.
      loadJSON('./data/json/resources.json', true),
      // Shown on the loading screen once the map is ready. Optional.
      loadJSON('./data/json/quotes.json', true),
      // The sea, as its own table and its own bitmap on the same grid as the
      // provinces. Both optional: without them the Navy mode is not offered and
      // the water is drawn flat, which is what it did before there were regions.
      loadJSON('./data/json/sea.json', true),
      loadBytes('./data/img/sea.png', true),
      // The counties, the level below provinces. Both optional: without them the
      // County mode is not offered and nothing else changes.
      loadJSON('./data/json/counties.json', true),
      loadBytes('./data/img/counties.png', true),
      // The sea subregions, the level a fleet is ordered to. Optional: without
      // the bitmap the Navy mode draws whole regions as it did before.
      loadBytes('./data/img/sea_subregions.png', true),
    ]);

  // Hashed before normaliseTable(), which rewrites the colours in place — the
  // build script hashes the same fields in the same form.
  const hash = hashInputs(pngBytes, raw, seaPngBytes, seaRaw, countyPngBytes, countyRaw, subPngBytes);
  const cache = await loadCache(cacheBytes, hash);
  const table = normaliseTable(raw);

  let world, geometry;
  const restored = cache && worldFromCache(table, cache, indexProvinces);
  setLoadingNote(restored ? 'Restoring the map…' : 'Building the map…');
  if (restored) {
    ({ world, geometry } = restored);
  } else {
    // No usable cache, so derive it all: a colour lookup per pixel, an adjacency
    // scan, a distance transform, and two more passes for the label geometry.
    world = buildWorld(table, await loadPixels(pngBytes));
    world.borderDist = buildBorderDistance(world);
    geometry = computeLabelGeometry(world);
  }

  // Which provinces are in which block, listed per block. A cache restore has
  // the mapping but not the lists, so both paths are finished here rather than
  // in either branch. Ownership changes regroup blocks from these.
  if (geometry) attachBlockMembers(geometry);
  world.geometry = geometry;

  // A second layer of blocks, for countries made of several polities: the
  // empire as well as its kingdoms. Built here rather than cached, being cheap
  // and derived from the polity table, which the cache does not cover.
  if (geometry) addRealmBlocks(world, geometry);

  // The sea, restored from the same cache file when it is in there and built
  // from sea.png when it is not. Land wins wherever the two bitmaps disagree,
  // so a region is only ever consulted for a pixel the province array calls
  // ocean, and nothing here can move a coastline.
  world.sea = null;
  if (seaRaw && seaRaw.regions && seaRaw.regions.length) {
    const seaTable = normaliseSeaTable(seaRaw);
    world.sea = (cache && cache.seaAt)
      ? seaFromCache(seaTable, cache.meta.sea, cache.seaAt, indexSea, world.width, world.height)
      : null;
    if (!world.sea && seaPngBytes) {
      const seaPixels = await loadPixels(seaPngBytes);
      if (seaPixels.width === world.width && seaPixels.height === world.height) {
        world.sea = buildSeaWorld(seaTable, seaPixels);
      } else {
        console.warn(`sea.png is ${seaPixels.width}x${seaPixels.height}, not `
          + `${world.width}x${world.height}; the Navy mode is off.`);
      }
    }
  }
  // Both of these are about the water and have nothing to show without it.
  // The counties, restored from the same cache or built from counties.png when
  // there is none. Fourteen thousand of them, so the cache matters: reading them
  // back is a memcpy where building them is a decode, a scan and an adjacency
  // pass over sixteen million pixels.
  // The sea subregions, from the same cache or from their own bitmap. They live
  // in sea.json beside the regions, so there is no second table to fetch.
  world.subs = null;
  if (seaRaw && seaRaw.subregions && seaRaw.subregions.length) {
    const subTable = normaliseSubTable(seaRaw);
    world.subs = (cache && cache.subAt)
      ? subsFromCache(subTable, cache.meta.subs, cache.subAt, indexSubs, world.width, world.height)
      : null;
    if (!world.subs && subPngBytes) {
      const subPixels = await loadPixels(subPngBytes);
      if (subPixels.width === world.width && subPixels.height === world.height) {
        world.subs = buildSubWorld(subTable, subPixels);
      } else {
        console.warn(`sea_subregions.png is ${subPixels.width}x${subPixels.height}, not `
          + `${world.width}x${world.height}; the Navy layer shows whole regions.`);
      }
    }
  }

  world.counties = null;
  if (countyRaw && countyRaw.counties && countyRaw.counties.length) {
    const countyTable = normaliseCountyTable(countyRaw);
    world.counties = (cache && cache.countyAt)
      ? countiesFromCache(countyTable, cache.meta.counties, cache.countyAt, indexCounties, world.width, world.height)
      : null;
    if (!world.counties && countyPngBytes) {
      const countyPixels = await loadPixels(countyPngBytes);
      if (countyPixels.width === world.width && countyPixels.height === world.height) {
        world.counties = buildCountyWorld(countyTable, countyPixels);
      } else {
        console.warn(`counties.png is ${countyPixels.width}x${countyPixels.height}, not `
          + `${world.width}x${world.height}; the County mode is off.`);
      }
    }
  }

  for (const el of document.querySelectorAll('button[data-mode="navy"], button[data-toggle="showSeaNames"]')) {
    el.hidden = !world.sea;
  }
  document.querySelector('button[data-mode="county"]').hidden = !world.counties;

  world.satellite = satellite;
  world.rivers = rivers;
  world.night = night;
  world.nightMask = buildNightMask(world, sunDayOfYear);
  world.cities = cities?.cities ?? [];
  linkInternationalCities(world.cities);
  world.cityIcons = { city: cityIcon, capital: capitalIcon };
  world.stats = stats?.provinces ?? null;
  world.resources = resources?.provinces ?? null;
  world.resourceKinds = resources?.kinds ?? [];
  world.resourceSheet = resourceSheet;
  world.resourceLines = buildResourceLines(world);
  world.quotes = quotes?.quotes ?? [];

  // Written in now, while the gauge is still showing and the quote is
  // transparent, so it is holding its height before it is ever visible.
  fillLoadingQuote(world.quotes);

  // Finishing the labels needs to measure real text, so it always happens here.
  world.labels = buildLabels(world, geometry);
  state.world = world;
  state.satellite = !!satellite;
  perf.load = { ms: performance.now() - t0, cached: !!restored };

  // The imagery has to line up with the province bitmap pixel for pixel, since
  // it is blitted with the same coordinates. Anything else is a mistake worth
  // saying out loud rather than leaving as a mysteriously offset map.
  if (satellite && (satellite.width !== world.width || satellite.height !== world.height)) {
    console.warn(
      `satellite.png is ${satellite.width}x${satellite.height} but provinces.png is ` +
      `${world.width}x${world.height}. They must match; the imagery will not align.`
    );
  }

  // Before showStats, which reports the chunk grid and overview it creates.
  buildTiles(world);
  showStats(world);
  wireInput();
  fitToView();
  updatePanel();

  // Puts the plate at tick 0 rather than leaving it showing a dash until the
  // first tick, which on a clock that starts paused would be until the player
  // pressed something.
  applyClock();
  updateClockControls();

  // Draw the map once here rather than leaving it to the first animation frame,
  // and only then report ready. That first pass is a full repaint of all 15.9
  // million pixels — around 250ms — so reporting ready before it would put a
  // quarter-second freeze on the start menu's own fade. Run first, it happens
  // under the loading screen, where a wait is what is being claimed.
  // frame() re-arms itself on the way out, so this starts the loop too.
  setLoadingNote('Drawing the map…');
  frame();
  markMapReady();

  // The only way to move a province at the moment. Events and the AI will call
  // changeOwners() directly; this is the same thing from the console:
  //   game.setOwner('norrhus', 'FNA')
  //   game.setOwners([['norrhus', 'FNA'], ['rodtfjell', 'FNA']])
  // Bound to a name first, then published. Several of these report their new
  // state by calling another, and reaching that through the global would work
  // only for as long as nothing ever reassigned window.game.
  const game = {
    setOwner: (province, owner) => changeOwners([[province, owner]]),
    setOwners: changeOwners,
    world: () => state.world,

    // Reading and moving the camera from the console. `view.x` is wrapped by
    // clampPan(), so working out where a map pixel has landed on screen from the
    // outside means reproducing that wrapping; this hands over the real numbers
    // instead. lookAt() is the one that is actually useful: it puts a map
    // coordinate in the middle of the window at whatever zoom is asked for.
    //   game.lookAt(3211, 2018, 4)
    // The clock, from the console. There is deliberately no setSun() any more:
    // the sun is derived from the tick, so anything written straight into it
    // would be overwritten by the next tick, which is a trap rather than a tool.
    // Move the clock and the sun follows.
    //   game.setDate(1926, 12, 21)    21 Ungervan 1926, midnight — the solstice
    //   game.setDate(1926, 6, 10, 12) noon on the start date
    //   game.setTick(72 * 30)         thirty days in
    clock: () => ({
      tick: clock.tick, speed: clock.speed, paused: clock.paused, ...clockDate(clock.tick),
      month: RUNDEAN_MONTHS[clockDate(clock.tick).month],
    }),
    setTick: (tick) => {
      clock.tick = Math.max(0, Math.round(tick));
      applyClock();
      return game.clock();
    },
    // Month is 1 to 12 here, unlike the 0-based index everything inside uses,
    // because this is typed by a person and 6 is Ungerbruni to a person.
    setDate: (year, month, day, hour = 0) => {
      const days = Math.round((Date.UTC(year, month - 1, day) - CLOCK_EPOCH) / DAY_MS);
      clock.tick = Math.max(0, days * TICKS_PER_DAY + Math.round(hour * TICKS_PER_HOUR));
      applyClock();
      return game.clock();
    },
    pause: () => { setPaused(true); return game.clock(); },
    resume: () => { setPaused(false); return game.clock(); },
    speed: (n) => { setSpeed(n); return clock.speed; },

    // The button sound, by ear. Nothing else in the interface has a number
    // whose only correct value is the one that feels right.
    //   game.clickDelay()     what it is now, in milliseconds
    //   game.clickDelay(45)   hold it back a little further
    clickDelay: (ms) => {
      if (typeof ms === 'number') sfxDelay = clamp(ms, 0, 500) / 1000;
      return Math.round(sfxDelay * 1000);
    },
    // What the sound measured about itself when it loaded, in milliseconds.
    clickSound: () => ({
      trimmed: Math.round(sfx.offset * 1000),
      attack: Math.round(sfx.attack * 1000),
      held: Math.round(sfxDelay * 1000),
      answer: Number(sfx.lag.toFixed(1)),
      device: Math.round((sfx.base + sfx.output) * 1000),
      peak: Number(sfx.peak.toFixed(3)),
      loaded: Boolean(sfx.buffer),
    }),

    view: () => ({ ...view }),
    lookAt: (mapX, mapY, scale = view.scale) => {
      view.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
      view.x = els.canvas.clientWidth / 2 - mapX * view.scale;
      view.y = els.canvas.clientHeight / 2 - mapY * view.scale;
      clampPan();
      invalidateView();
      return { ...view };
    },
  };

  window.game = game;
}

/**
 * Called once at the end of init(), with a drawn map behind everything.
 *
 * The loading screen holds the window from the moment the page opens until this
 * runs, and the start menu waits behind it. So the wait is over before the menu
 * is ever seen, and Enter always lands straight on a finished map.
 */
function markMapReady() {
  const loading = document.getElementById('loading');
  const menu = document.getElementById('start');

  const reveal = () => {
    loading?.classList.add('gone');
    loading?.setAttribute('aria-hidden', 'true');
    if (!menu) return;
    menu.classList.remove('pending');
    menu.setAttribute('aria-hidden', 'false');

    // Focus on the NEXT frame, not in this one. Pressing Enter here would
    // otherwise dismiss this screen and then activate the button that had just
    // taken the focus, in the same keystroke, landing straight on the map and
    // skipping the menu entirely.
    requestAnimationFrame(() => document.getElementById('start-enter')?.focus());
  };

  if (!loading) { reveal(); return; }

  // The gauge has nothing left to report, so it goes, a quote takes its place,
  // and the line under it asks for a keypress. The screen waits there instead of
  // moving on by itself.
  loading.classList.add('ready');

  // A modifier on its own is not a key anybody means by "any key": holding Shift
  // before typing would otherwise dismiss this.
  const MODIFIERS = new Set([
    'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock',
    'ContextMenu', 'Dead', 'Fn', 'FnLock', 'Hyper', 'Super', 'AltGraph',
  ]);

  const go = (ev) => {
    if (ev.type === 'keydown' && MODIFIERS.has(ev.key)) return;
    // Suppress the keystroke's own default action for the same reason the focus
    // is deferred: Enter and Space would otherwise press whatever they landed on.
    ev.preventDefault();
    window.removeEventListener('keydown', go);
    window.removeEventListener('mousedown', go);
    reveal();
  };

  // A click counts too. Somebody who has just watched a bar fill will as often
  // reach for the mouse.
  window.addEventListener('keydown', go);
  window.addEventListener('mousedown', go);
}

/**
 * The line under the loading bar. Set as init() moves through its stages, so
 * whatever it reads when the screen appears is where the load actually is.
 * Harmless before the element exists or after it is gone.
 */
function setLoadingNote(text) {
  const note = document.getElementById('loading-note');
  if (note) note.textContent = text;
}

/**
 * Writes one of `data/json/quotes.json` into the loading screen, chosen at random.
 *
 * Called as soon as the file is read, not when loading finishes. The element is
 * transparent until the screen reaches its ready state, and filling it early is
 * what lets it hold its height in advance: fading it in then moves nothing.
 *
 * Does nothing if the file is missing or empty, and the prompt stands on its own.
 */
function fillLoadingQuote(list) {
  if (!list?.length) return;

  const q = list[Math.floor(Math.random() * list.length)];
  const text = document.getElementById('loading-quote-text');
  const by = document.getElementById('loading-quote-by');
  if (text) text.textContent = q.text;
  if (by) by.textContent = q.by ?? '';
}

/* ------------------------------------------------------ the drifting backdrop
 *
 * The artwork behind the loading screen and the start menu moves with the
 * pointer, against it rather than with it, so the screen reads as a window
 * onto something standing further back instead of as a flat picture.
 *
 * The two halves of this do not know about each other. style.css owns where
 * the layer sits, how much room it has to move in and what is stacked over it;
 * this owns how far it has drifted, published as two custom properties. So the
 * artwork can be restyled without touching the arithmetic, and the arithmetic
 * has no opinion about which screen is up.
 */

// Furthest the artwork travels from centre, in CSS pixels. The layer is inset
// by 40px on every side in style.css, and this has to stay under that figure
// or the edge of the photograph comes into view at the extremes.
const PARALLAX_PX = 26;

// How long the drift takes to close most of the distance to the pointer. It
// trails rather than tracking, and the lag is the whole effect: a layer that
// arrives instantly reads as glued to the cursor, and one that takes its time
// reads as having some weight to move.
const PARALLAX_MS = 320;

function startParallax() {
  // Movement for its own sake, which is precisely what this is, so somebody
  // who has asked for less of it gets none. Returning here means the listener
  // is never attached, so there is no per-move cost either. The CSS pins the
  // layer as well, for a preference turned on later in the session.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const root = document.documentElement;
  const at = { x: 0, y: 0 };      // where the artwork is
  const to = { x: 0, y: 0 };      // where the pointer says it should be
  let raf = 0;
  let clock = 0;

  const step = (now) => {
    // Exponential easing on ELAPSED TIME rather than a fixed share per frame,
    // for the reason stepCityFades gives: a share per frame closes the gap
    // faster on a 144Hz screen than on a 60Hz one, and the drift would be a
    // different gesture on different machines. On the first frame of a burst
    // there is no previous reading, so dt is 0 and nothing moves until there
    // is a real interval to move against.
    const k = 1 - Math.exp(-(clock ? now - clock : 0) / PARALLAX_MS);
    clock = now;
    at.x += (to.x - at.x) * k;
    at.y += (to.y - at.y) * k;

    // Settle rather than approach forever. An exponential never actually
    // arrives, and a frame requested every 16ms to move a hundredth of a pixel
    // is a frame nobody asked for and a compositor layer nothing is doing with.
    const done = Math.abs(to.x - at.x) < 0.05 && Math.abs(to.y - at.y) < 0.05;
    if (done) { at.x = to.x; at.y = to.y; }

    root.style.setProperty('--parallax-x', `${at.x.toFixed(2)}px`);
    root.style.setProperty('--parallax-y', `${at.y.toFixed(2)}px`);

    clock = done ? 0 : clock;
    raf = done ? 0 : requestAnimationFrame(step);
  };

  // mousemove rather than pointermove. A pen or a finger has no hover, so a
  // pointer event from one arrives already at the place it is touching, and
  // the artwork would jump the width of the screen on a tap rather than drift.
  window.addEventListener('mousemove', (ev) => {
    // Only while one of the two screens carrying the artwork is up. Once the
    // menu has been dismissed there is nothing on screen to move, and tracking
    // the pointer across a map being panned would be arithmetic for no picture.
    if (mapIsShowing()) return;

    // -1 at the left edge of the window, +1 at the right. The artwork moves
    // AGAINST the pointer: a layer sliding the same way as the cursor reads as
    // being dragged along by it, and one sliding the opposite way reads as
    // sitting behind the frame you are looking through.
    const nx = (ev.clientX / window.innerWidth) * 2 - 1;
    const ny = (ev.clientY / window.innerHeight) * 2 - 1;
    to.x = -clamp(nx, -1, 1) * PARALLAX_PX;
    to.y = -clamp(ny, -1, 1) * PARALLAX_PX;

    if (!raf) raf = requestAnimationFrame(step);
  }, { passive: true });

  // Nothing resets on the way out. Quitting to the start menu finds the
  // artwork where the pointer left it, which is right: it is the same screen,
  // and it has not moved in the meantime.
}

/**
 * Puts the start screen back up, over a map that is already built.
 *
 * Kept apart from markMapReady(), which shows it for the first time. That one
 * has a loading screen to dissolve and a `pending` class to take off and runs
 * exactly once; this is the same screen returned to later, and has neither.
 *
 * The wiring in openStartMenu() is untouched by any of it — those listeners
 * were attached once at module level and are still attached — so the screen
 * comes back working rather than having to be built again.
 */
function showStartMenu() {
  const menu = document.getElementById('start');
  if (!menu) return;
  menu.classList.remove('gone');
  menu.setAttribute('aria-hidden', 'false');

  // Focus on the NEXT frame, for the reason markMapReady() gives at greater
  // length: the press that asked to quit is still being delivered, and Enter
  // landing on a button that has just taken the focus would dismiss this
  // screen again in the same keystroke and drop you straight back on the map.
  requestAnimationFrame(() => document.getElementById('start-enter')?.focus());
}

/**
 * Wires the start menu up. Called at module level, so the buttons work the
 * moment the menu is shown.
 *
 * The menu itself is behind the loading screen and carries `pending` until
 * markMapReady() takes it off. Nothing here has to think about whether the map
 * is finished, because the menu is not reachable until it is.
 */
function openStartMenu() {
  const menu = document.getElementById('start');
  const enter = document.getElementById('start-enter');
  if (!menu || !enter) return;

  const dismiss = () => {
    // Not while the screen is hidden, and not twice over. Both questions are
    // answered by the classes rather than by a flag of its own, which is what
    // lets the screen be dismissed AGAIN after quitting has brought it back —
    // a latch set on the first press would have closed the menu permanently
    // and left the second visit to it with a dead Enter button.
    if (menu.classList.contains('gone') || menu.classList.contains('pending')) return;
    menu.classList.add('gone');
    menu.setAttribute('aria-hidden', 'true');
    els.canvas.focus?.();
  };
  enter.addEventListener('click', dismiss);

  /* The panels inside the menu: the changelog and the about box, closed until
   * asked for. A button names the one it opens with data-dialog, so another
   * panel is a button and some markup and needs nothing here.
   */
  let openedBy = null;                    // the button to give the focus back to
  const openDialog = () => menu.querySelector('.start-dialog.open');

  const setDialog = (dialog, open) => {
    if (!dialog) return;
    dialog.classList.toggle('open', open);
    dialog.setAttribute('aria-hidden', String(!open));
    // Focus follows what is on top, so the keys below act on the thing being
    // looked at, and closing puts it back where it came from.
    if (open) dialog.querySelector('.dialog-close')?.focus();
    else openedBy?.focus();
  };

  for (const button of menu.querySelectorAll('button[data-dialog]')) {
    button.addEventListener('click', () => {
      openedBy = button;
      setDialog(document.getElementById(button.dataset.dialog), true);
    });
  }

  for (const dialog of menu.querySelectorAll('.start-dialog')) {
    dialog.querySelector('.dialog-close')?.addEventListener('click', () => setDialog(dialog, false));
    // Anywhere off the panel. The panel stops the click reaching the scrim, so
    // a click inside it does nothing.
    dialog.addEventListener('click', (ev) => { if (ev.target === dialog) setDialog(dialog, false); });
  }

  // ENTER AND SPACE GO IN. ESCAPE DOES NOT.
  //
  // Escape is the key for stepping back, everywhere it appears: it drops a
  // selection, it closes the changelog, it closes the pause menu. Letting it
  // also start the game made it the one place where going back went forward,
  // and it is the natural key to reach for when you have just arrived at this
  // screen and want to be left alone on it.
  //
  // So here it closes an open panel, and with no panel open it does nothing at
  // all — there is nothing behind this screen to step back to. Enter and Space
  // are the ways in, and the Enter button says so.
  window.addEventListener('keydown', (ev) => {
    if (menu.classList.contains('gone') || menu.classList.contains('pending')) return;
    if (ev.key !== 'Enter' && ev.key !== 'Escape' && ev.key !== ' ') return;

    const dialog = openDialog();
    if (dialog) {
      if (ev.key !== 'Escape') return;      // leave Enter and Space to whatever has the focus
      ev.preventDefault();
      setDialog(dialog, false);
      return;
    }

    // Nothing open for it to close, and it is not a way in. Swallowed rather
    // than left to fall through, so that it cannot come to mean something else
    // later by accident.
    if (ev.key === 'Escape') {
      ev.preventDefault();
      return;
    }

    // A focused button keeps its own keys, or Enter on the Changelog button
    // would open the changelog and start the game in the same press.
    if (document.activeElement?.tagName === 'BUTTON' && document.activeElement !== enter) return;

    ev.preventDefault();

    // This press is SPENT, and no other listener may act on it.
    //
    // wireInput() attaches a second keydown listener to the same window for the
    // map's own keys. Without this line that listener still runs, and by then
    // dismiss() has already set `gone` — so it asks whether the map is showing,
    // is told yes, and treats the press as one made on the map. Space therefore
    // dismissed the start screen and set the clock running in the same keystroke.
    //
    // stopPropagation is not enough. Both listeners are on window, so there is
    // no propagation between nodes to stop; only the immediate form stops the
    // next listener on the same target. It works because this one is registered
    // FIRST, openStartMenu() being called at module level and wireInput() from
    // init(). The map's handler guards on the start screen as well, so neither
    // order can leave both of them acting.
    ev.stopImmediatePropagation();

    dismiss();
  });
}

// Wired before init() so the buttons are live the instant the menu is revealed,
// which markMapReady() does at the end of the load.
openStartMenu();

// Likewise, and earlier still: the loading screen carries the same artwork and
// is on screen from the first frame, so the drift is live while the map is
// being built rather than only once the menu behind it appears.
startParallax();

init().catch((err) => {
  document.body.innerHTML =
    `<div style="padding:24px;font:14px 'Segoe UI', sans-serif;color:#d8dce4">
       <strong>Failed to start.</strong><br><br>${err.message}<br><br>
       <span style="color:#8a91a0">If this says the file could not be loaded, you are probably
       opening index.html directly. Browsers block local file reads. Serve the folder over
       HTTP instead &mdash; see README.md.</span>
     </div>`;
  console.error(err);
});
