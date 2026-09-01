/*
 * Counties: the level below provinces, generated rather than drawn.
 *
 * Provinces are painted by hand because their borders are political and there
 * is no rule that produces them. Counties are not. A county is a piece of ground
 * an army takes a sensible number of days to cross, and that IS a rule. Fifteen
 * thousand of them would take a year to draw and would be wrong again the moment
 * a province moved.
 *
 * The pipeline, in the order it runs:
 *
 *   1. LANDSCAPE   terrain and climate per pixel, read out of the true-area maps
 *   2. DISTANCE    how far each land pixel is from its province's edge
 *   3. PIECES      each province split into its separate pieces of land
 *   4. COUNT       how many counties a piece gets, from its area and landscape
 *   5. SEEDS       that many starting points, spread out within the piece
 *   6. GROWTH      all seeds grow at once until the piece is used up
 *   7. SPLIT       any county still too slow to cross is cut again
 *   8. MERGE       counties too small to be worth having are absorbed
 *   9. TAG         each county takes the modal terrain and climate of its ground
 *
 * Then one measurement, which is NOT part of the pipeline and runs on the read
 * path as well, since it describes whatever counties.png currently says:
 *
 *   measureWater  how much river and lake a county holds, and how much of each
 *                 border it shares with a neighbour is water
 *
 * All of it is build-time. The game reads counties.png and counties.json and
 * never runs a line of this.
 *
 * See the Counties section of plans.md, which this implements and which holds
 * the reasoning behind every constant.
 */

import { OCEAN, MIN_BORDER_PX } from './mapdata.js';
import { makeProjection, distanceKm, toDegrees } from './geo.js';

/** Array.push(...other) throws past about a hundred thousand arguments. */
const appendAll = (into, from) => { for (const v of from) into.push(v); };

// ------------------------------------------------------------------ palettes

/** terrain.png. Three colours; Alpine is derived from the province, not painted. */
export const TERRAIN_COLOURS = [
  ['Plains', 0x00ff0c, 'Plains'],
  ['Hills', 0x0004ff, 'Hills'],
  ['Mountains', 0xff0000, 'Mountains'],
];

/**
 * climate.png, in the published Köppen palette, grouped into the twelve the game
 * uses. The file was painted from that palette and the shades have drifted a
 * point or two, so colours are matched to the nearest entry rather than exactly.
 */
export const KOPPEN = [
  ['Af', 0x0000fe, 'Rainforest'], ['Am', 0x0077ff, 'Monsoon'],
  ['Aw', 0x46a9fa, 'Savanna'], ['As', 0x79baec, 'Savanna'],
  ['BWh', 0xfe0000, 'Desert'], ['BWk', 0xfe9695, 'Desert'],
  ['BSh', 0xf5a301, 'Steppe'], ['BSk', 0xffdb63, 'Steppe'],
  ['Csa', 0xffff00, 'Mediterranean'], ['Csb', 0xc6c700, 'Mediterranean'],
  ['Csc', 0x969600, 'Mediterranean'],
  ['Cwa', 0x96ff96, 'Humid subtropical'], ['Cfa', 0xc6ff4e, 'Humid subtropical'],
  ['Cwb', 0x63c764, 'Oceanic'], ['Cwc', 0x329633, 'Oceanic'],
  ['Cfb', 0x66ff33, 'Oceanic'], ['Cfc', 0x33c701, 'Oceanic'],
  ['Dsa', 0xff00fe, 'Humid continental'], ['Dsb', 0xc600c7, 'Humid continental'],
  ['Dwa', 0xabb1ff, 'Humid continental'], ['Dwb', 0x5a77db, 'Humid continental'],
  ['Dfa', 0x00ffff, 'Humid continental'], ['Dfb', 0x38c7ff, 'Humid continental'],
  ['Dsc', 0x963295, 'Subarctic'], ['Dsd', 0x966495, 'Subarctic'],
  ['Dwc', 0x4c51b5, 'Subarctic'], ['Dwd', 0x320087, 'Subarctic'],
  ['Dfc', 0x007e7d, 'Subarctic'], ['Dfd', 0x00455e, 'Subarctic'],
  ['ET', 0xb2b2b2, 'Tundra'], ['EF', 0x686868, 'Ice cap'],
];

// How far a painted colour may sit from its palette entry and still read as it.
// Every colour in climate.png but one lands within 3; Cfb is 29 out and has no
// other code within reach. Past this a pixel counts as unpainted.
export const KOPPEN_TOLERANCE = 40;

export const TERRAINS = ['Plains', 'Hills', 'Mountains'];
export const CLIMATES = [
  'Rainforest', 'Monsoon', 'Savanna', 'Desert', 'Steppe', 'Mediterranean',
  'Humid subtropical', 'Oceanic', 'Humid continental', 'Subarctic', 'Tundra', 'Ice cap',
];
// The fourth landform, above Mountains. Not painted in terrain.png and not
// derivable from it: it is a ruling about a province, typed in by hand, and
// applyAlpine carries it down to that province's mountain counties.
export const ALPINE = 'Alpine';

// ----------------------------------------------------------------- constants

/** Kilometres a division covers in a day, by landform. plans.md, Movement. */
export const TERRAIN_SPEED = { Plains: 24, Hills: 16, Mountains: 8, Alpine: 3 };

// Urban runs BESIDE the landform, not instead of it. A county holding a city is
// Plains and Urban, or Mountains and Urban: the ground under a city is still
// ground, and how fast an army crosses it depends on both. It is not painted and is not read
// from terrain.png; it comes from cities.json.
//
// Every city gets a county of its own, so a city is always somewhere an army can
// be ordered to and fought over on its own terms, and city counties are grown to
// a fraction of the size their neighbours get, so one is the city and its
// outskirts rather than a county that happens to contain a city.
export const URBAN = 'Urban';
export const URBAN_SPEED = 0.5;    // what a built-up county does to the landform speed
export const URBAN_AREA = 1400;     // km2 a city county aims at, about 37 km across

// How much harder the field pushes while the city counties are being drawn, as a
// power on the cost. They are eight pixels across and the smallest thing that
// deforms them has to be smaller than that, so they take the field at more than
// twice the strength the ground around them does. Without it a city county is a
// disc: it grows outward from one pixel and stops at its limit, and the limit of
// an even growth is a circle.
export const URBAN_ROUGH = 2.6;

/** And what the climate does to that speed. */
export const CLIMATE_SPEED = {
  Rainforest: 0.42, Monsoon: 0.50, Savanna: 0.80, Desert: 0.85, Steppe: 0.95,
  Subarctic: 0.70, Tundra: 0.50, 'Ice cap': 0.50,
};

/** Square kilometres a county wants to be, by the dominant climate of its piece. */
export const CLIMATE_TARGET = {
  'Ice cap': 70000, Tundra: 52000, Subarctic: 26000, Desert: 12000, Steppe: 8000,
  Rainforest: 7000, Monsoon: 6500, Savanna: 6000,
};
export const DEFAULT_TARGET = 5000;

/**
 * How many days a county may take to walk across, by climate.
 *
 * Twelve nearly everywhere, because a front that takes longer than that to
 * shift cannot respond to anything. The cold climates are the exception and get
 * far longer, because there is no front there to respond: nobody holds a line
 * across an ice cap, and cutting one into twelve-day pieces produces thousands
 * of counties in ground no army will ever stand in.
 *
 * This is the figure that decides how large the polar counties come out. It
 * binds through the target below and again through the split pass.
 */
export const CLIMATE_CROSS_DAYS = { 'Ice cap': 44, Tundra: 38, Subarctic: 28 };
export const MAX_CROSS_DAYS = 12;   // everywhere else
export const SPLIT_ROUNDS = 4;      // how many times a county may be cut again to get there

export const crossDaysFor = (climateCode) =>
  CLIMATE_CROSS_DAYS[CLIMATES[climateCode - 1]] ?? MAX_CROSS_DAYS;
// Per connected piece of land. High enough that it is a backstop rather than a
// sizing rule: a piece should be cut by its climate target, and a ceiling low
// enough to bind was deciding the size of every polar county instead.
export const MAX_COUNTIES = 96;
// What counts as a speck rather than an island.
//
// In PIXELS first, because a speck is a drawing artefact and an artefact is a
// pixel or a short diagonal chain of them, whatever ground that happens to be.
// An area threshold cannot do this job on its own: islands are drawn larger
// than life so they can be clicked, by as much as six times, so the same 200
// km² is four pixels on one island and thirty on another.
//
// The area floor is a second, much lower net for a piece that is several pixels
// of almost nothing. Nodavanua is six islands between 79 and 509 km², and a
// threshold at 200 swallowed five of them into the sixth and left the country
// with one county covering water it does not own.
export const MIN_PIECE_PX = 3;      // pixels, below which a piece is an artefact
export const MIN_PIECE = 30;        // km², the same for a piece of several thin ones
export const MIN_AREA = 800;        // km², below which a county is merged into a neighbour

// How much of a county's edge one neighbour may hold before the county counts as
// shut inside it. Sea counts toward the edge, so a coastal county is never
// engulfed by the land behind it.
//
// A count of neighbours cannot do this. A county can touch three others and
// still have one of them holding nine tenths of its border, which on the map is
// a hole in that neighbour with a nick out of one side.
export const ENGULF_SHARE = 0.82;

// How long a county may be against its width before it is cut down the middle.
//
// Measured in kilometres, not pixels. On an equirectangular map a pixel at
// seventy-seven degrees is a fifth as wide as it is tall, so a county that is
// square on the ground is five times wider than it is tall on the bitmap, and a
// count in pixels flags the whole arctic as slivers while missing real ones in
// the tropics.
export const MAX_ELONGATION = 2.6;
export const SLIVER_ELONGATION = 3.4;   // past this a county is dissolved, not kept
export const SLIVER_MAX_PX = 800;       // and only up to here; see the note below

// Growth. RIVER_COST is what a boundary pays NOT to sit on a river, so boundaries
// settle onto rivers where a piece has any. BALANCE is what a seed pays for having
// claimed more than its share, which evens the areas out. Both are in units of
// the base cost of 1 to enter a pixel.
export const RIVER_COST = 14;

// What a seed pays for having claimed more than its share. This is what keeps
// counties near the size they were aimed at, and it is the thing that has to be
// held back rather than turned up: at 2.5 every county came out the same size as
// its neighbours and the map read as a tiling, which is not what an
// administrative division looks like. Low enough that sizes vary, high enough
// that the day budget is still roughly kept, and the split pass catches the rest.
export const BALANCE = 0.9;

/**
 * How rough the ground is to cross, as a fraction of the base cost of a step.
 *
 * Without it every boundary between two counties is a clean arc and the map
 * reads as machined. Per-pixel white noise does not fix that, which is what this
 * was at first: a boundary crossing n pixels of independent noise wanders by
 * about the square root of n, so it is a fraction of a small county and nothing
 * at all on a large one. Small counties came out organic and the big polar ones
 * stayed straight.
 *
 * So the noise is CORRELATED: a value-noise field with structure at three
 * wavelengths, the longest of them 120 pixels. A boundary now follows the lie of
 * the field rather than averaging it out, and it wanders by the same relative
 * amount whatever the size of the counties either side.
 *
 * It is a hash of position, not a random number, so the same map comes out of
 * every run and one generator change can be compared against the last.
 */
/**
 * How hard the field pushes, in the exponent.
 *
 * The cost of a step is `exp(k × field)` with the field running from -1 to 1, so
 * k is the natural log of the ratio between the dearest ground and the cheapest.
 * At 0.8 that ratio is about five to one.
 *
 * The exponential is not decoration. Written as `1 + amplitude × field` the cost
 * carries a large constant term, and it is the RELATIVE variation that bends a
 * boundary: at an amplitude of 3.2 the mean cost was 2.6 and the swing about it
 * was 0.8, so the field moved a boundary by eight pixels however large the
 * amplitude was made. Raising it further only raised the mean with it. In the
 * exponent the mean stays at 1, the swing is the whole of the effect, and the
 * cost cannot go negative, which a plain sum can.
 */
export const ROUGHNESS = 0.9;

// Wavelength in pixels against weight. Every size of county needs octaves near its
// own size or its boundary averages the field out and comes back straight, and the
// sizes on this map run from forty pixels across to four hundred.
//
// It needs octaves SHORTER than the county as well as near it. One whose
// wavelength matches the boundary does not roughen it, it displaces it: the
// boundary moves bodily to one side and is as straight as it was. Wandering comes
// from a wavelength that fits along the boundary several times over.
// Measured against what a county actually is on this map, which is far smaller
// than it looks in kilometres: the median is 13 pixels across, an urban one is 8,
// and even an ice cap county is only about 70.
//
// Weighted SHORT, and that is the whole of the difference between a rough border
// and a misshapen county. An octave shorter than the county roughens its edge. An
// octave as long as the county or longer does not: it bends the growth bodily,
// and the county comes out lobed, or drawn out into a ribbon, or wrapped most of
// the way round its neighbour. A set running up to 96 pixels put 297 counties
// past three to one in elongation and the worst at nearly ten.
const OCTAVES = [[44, 0.12], [18, 0.24], [8, 0.31], [3, 0.33]];

/**
 * How much of that field is applied, as a multiple of ROUGHNESS.
 *
 * Roughness has to be proportional to the size of the thing being roughened. A
 * boundary is displaced by roughly the amplitude times the wavelength, so a fixed
 * amplitude that visibly wanders a sixty-pixel county is a two per cent wobble on
 * a four-hundred-pixel one, and the polar counties came out looking ruled.
 *
 * So the amplitude scales with how large a county wants to be on that ground,
 * which is the field the sizing already computes. It rises smoothly with it, so
 * there is no line on the map where the roughness changes, and it only reaches
 * its full value on the ice cap, where counties are four hundred pixels across.
 */
export const ROUGH_GAIN = 1.53;

// And how much the evening-out is relaxed on the same ground.
//
// Rough borders were not enough on their own. BALANCE makes every county the
// size it was aimed at, and counties that are all one size sitting in rows read
// as a tiling however much their edges wander. Where they are large it is
// divided by the same figure the roughness is multiplied by, so polar counties
// differ from each other in size as well as in shape. The day budget is looser
// for it, which is what step 4 is for.
export const BALANCE_RELIEF = 0.45;

// How much of the seed choice is distance and how much is the field. At 1 the
// seeds are spread as evenly as possible, which is the honeycomb; at 0 they
// follow the noise alone and cluster.
const SEED_BIAS = 0.45;

// A step costs what it covers on the ground.
//
// This is not a detail, and it goes wrong in two ways if left alone.
//
// With all eight neighbours costing the same, the distance being minimised is
// the Chebyshev one, whose equidistant sets are SQUARES, and the counties come
// out as rectangles with axis-aligned edges.
//
// And the map is equirectangular, so a pixel is 6.68 km wide at the equator and
// 1.16 km wide at eighty degrees, while staying 6.68 km tall everywhere. Growth
// that treats the two directions alike is round in PIXELS, which near the poles
// is six times taller than it is wide in kilometres. Since the whole point of
// the sizing is how many days a county takes to walk across, it has to be round
// in kilometres.
//
// Both are the same fix: charge for the ground a step covers. A horizontal step
// costs cos(latitude), a vertical one costs 1, and a diagonal costs the
// hypotenuse of the two, which is root two at the equator.
export const RIVER_MARGIN = 3;      // map pixels. A river closer than this to the
// province edge is ignored, or a county boundary lands on it and strands a ribbon

// The chamfer weights mapdata.js uses, so RIVER_MARGIN means the same thing in
// both distance fields.
const CHAMFER_ORTH = 3;
const CHAMFER_DIAG = 4;
const DIST_MAX = 255;

/** A stable value in 0..1 from a pair of lattice coordinates. */
function hash2(x, y) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

/**
 * Value noise on a lattice that wraps east to west.
 *
 * The lattice is a whole number of cells around the world, so the column at the
 * map seam neighbours the one at the far edge and the field is continuous across
 * it. A field that was not would put a straight boundary down the antimeridian.
 */
function valueNoise(x, y, cells, width) {
  const fx = (x * cells) / width, fy = (y * cells) / width;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fade(fx - x0), ty = fade(fy - y0);
  const w = (g) => ((g % cells) + cells) % cells;
  const a = hash2(w(x0), y0), b = hash2(w(x0 + 1), y0);
  const c = hash2(w(x0), y0 + 1), d = hash2(w(x0 + 1), y0 + 1);
  const top = a + (b - a) * tx, bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
}

/**
 * The field, baked once for the whole map, signed and centred on zero.
 *
 * Stored as a byte with 128 standing for no push either way, which is enough
 * resolution for a cost and a quarter of the memory a float would take over
 * fifteen million pixels.
 */
export function roughnessField(width, height) {
  const out = new Uint8Array(width * height);
  const octaves = OCTAVES.map(([px, weight]) => [Math.max(1, Math.round(width / px)), weight]);
  const total = octaves.reduce((s, o) => s + o[1], 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (const [cells, weight] of octaves) v += weight * valueNoise(x, y, cells, width);
      // 0..1 to -1..1, then to a byte around 128
      const signed = (v / total) * 2 - 1;
      out[y * width + x] = Math.max(0, Math.min(255, Math.round(128 + signed * 127)));
    }
  }
  return out;
}

const codeIndex = (list) => new Map(list.map((v, i) => [v, i + 1]));
const TERRAIN_CODE = codeIndex(TERRAINS);
const CLIMATE_CODE = codeIndex(CLIMATES);

export const terrainName = (code) => TERRAINS[code - 1] || null;

/**
 * How many days a county takes to walk across, on its own terrain and climate.
 *
 * The county is treated as a square, which is what the sizing assumed when it
 * chose the target. A real county is not square and the figure is a guide.
 */
export const daysToCross = (county) =>
  Math.sqrt(county.area) / ((TERRAIN_SPEED[county.terrain] ?? TERRAIN_SPEED.Plains)
    * (CLIMATE_SPEED[county.climate] ?? 1) * (county.urban ? URBAN_SPEED : 1));

/** And the budget that county is held to, which is not the same everywhere. */
export const crossBudget = (county) =>
  CLIMATE_CROSS_DAYS[county.climate] ?? MAX_CROSS_DAYS;
export const climateName = (code) => CLIMATES[code - 1] || null;

// ------------------------------------------------------------ 1. the landscape

/**
 * Nearest palette entry to a colour, or null past the tolerance.
 *
 * Every entry is [label, colour, value]. The shape is asserted because getting
 * it wrong does not throw: a string where a colour belongs comes out as NaN,
 * every distance is NaN, no comparison is ever true, and the whole map reads as
 * unpainted with nothing to say why.
 */
function nearest(colour, palette) {
  const r = (colour >> 16) & 255, g = (colour >> 8) & 255, b = colour & 255;
  if (typeof palette[0][1] !== 'number') throw new Error('palette entries must be [label, colour, value]');
  let best = null, bestD = Infinity;
  for (const entry of palette) {
    const c = entry[1];
    const d = Math.hypot(r - ((c >> 16) & 255), g - ((c >> 8) & 255), b - (c & 255));
    if (d < bestD) { bestD = d; best = entry; }
  }
  return bestD <= KOPPEN_TOLERANCE ? best : null;
}

/** colour -> code, memoised, so the pixel loop is a lookup and not a palette search. */
function paletteLookup(palette, codes, valueAt) {
  const seen = new Map();
  return (colour) => {
    let code = seen.get(colour);
    if (code === undefined) {
      const hit = nearest(colour, palette);
      code = hit ? codes.get(valueAt(hit)) : 0;
      seen.set(colour, code);
    }
    return code;
  };
}

/**
 * What each PROVINCE is made of, as a share of its own ground.
 *
 * Read straight off the true-area maps, where a province's colour in
 * true_area.png says which of its pixels to count. Nothing is aligned to the
 * game map and nothing falls back: this is the real island, at its real size,
 * whatever the game map had to do to it to make it clickable.
 *
 * WEIGHTED BY AREA, not by pixel count. Both source maps are equirectangular, so
 * a pixel at 70 degrees north covers about a third of the ground of one at the
 * equator, and counting pixels would let a province's polar end outvote its
 * temperate one. "Takes up more than 40% of the province" has to mean forty per
 * cent of its ground.
 *
 * The denominators are per question. Terrain is a share of the ground whose
 * terrain could be read, climate a share of the ground whose climate could be
 * read, so a patch that one map leaves unpainted cannot dilute the other.
 */
export function landscapeShares({
  trueArea, terrain, climate, colourToIndex, oceanKey, provinceCount, areaOfPixel,
}) {
  const terrainOf = paletteLookup(TERRAIN_COLOURS, TERRAIN_CODE, (e) => e[2]);
  const climateOf = paletteLookup(KOPPEN, CLIMATE_CODE, (e) => e[2]);

  const tStride = TERRAINS.length + 1, cStride = CLIMATES.length + 1;
  const tHist = new Float64Array((provinceCount + 1) * tStride);
  const cHist = new Float64Array((provinceCount + 1) * cStride);
  const ground = new Float64Array(provinceCount + 1);

  for (let y = 0; y < trueArea.h; y++) {
    const a = areaOfPixel(y);
    const row = y * trueArea.w;
    for (let x = 0; x < trueArea.w; x++) {
      const i = row + x;
      const c = trueArea.px[i];
      if (c === oceanKey) continue;
      const ix = colourToIndex.get(c);
      if (ix === undefined) continue;      // a colour the table has never heard of
      ground[ix] += a;
      const t = terrainOf(terrain.px[i]);
      const k = climateOf(climate.px[i]);
      if (t) tHist[ix * tStride + t] += a;
      if (k) cHist[ix * cStride + k] += a;
    }
  }
  return { tHist, cHist, ground, tStride, cStride };
}

/**
 * Everything covering more than `share` of a province, largest first.
 *
 * More than one answer is the point rather than a problem. A province half hills
 * and half mountains is both, and saying only which of the two won by a hair
 * throws away the more useful half of what the map knows.
 *
 * Nothing clearing the bar is possible — thirds of plains, hills and mountains
 * clear nothing at 40% — and an empty answer would be worse than a rough one, so
 * the largest is returned alone. `fellBack` says when that happened, because it
 * is the case worth counting rather than hiding.
 */
export function dominantIn(hist, ix, stride, names, share) {
  let total = 0;
  for (let v = 1; v < stride; v++) total += hist[ix * stride + v];
  if (!(total > 0)) return { names: [], fellBack: false };

  const ranked = [];
  for (let v = 1; v < stride; v++) {
    const n = hist[ix * stride + v];
    if (n > 0) ranked.push([names[v - 1], n / total]);
  }
  ranked.sort((a, b) => b[1] - a[1]);

  const over = ranked.filter(([, f]) => f > share);
  return over.length
    ? { names: over.map(([n]) => n), fellBack: false }
    : { names: [ranked[0][0]], fellBack: true };
}

/** The share of a province a landscape has to cover to be called dominant. */
export const DOMINANT_SHARE = 0.40;

/**
 * Terrain and climate for every land pixel of the game map.
 *
 * The two source maps are in the true-area frame, the whole globe at 2:1, and
 * the game map is the band of it from `northRow` down. So a game pixel at (x, y)
 * is the true-area pixel at (x, y + northRow), and for 99.77% of land that is
 * the same ground.
 *
 * The rest is islands, drawn larger on the game map than they are in life so
 * that they can be clicked and fought over. Their extra pixels overhang the real
 * island and land in the sea of the true-area maps, where there is nothing to
 * read. Those take their province's modal values instead, which costs almost
 * nothing: of the 83 provinces affected, 82 are a single terrain throughout and
 * 73 a single climate.
 *
 * Alignment is tested against the PROVINCE, not against land in general. An
 * enlarged island often overhangs onto a neighbour's true-area ground, and
 * reading terrain from there would be worse than the fallback.
 */
export function readLandscape({
  provinceAt, width, height, northRow,
  trueArea, terrain, climate, colourToIndex, oceanKey, provinceCount,
}) {
  const terrainOf = paletteLookup(TERRAIN_COLOURS, TERRAIN_CODE, (e) => e[2]);
  const climateOf = paletteLookup(KOPPEN, CLIMATE_CODE, (e) => e[2]);

  // A histogram per province over its TRUE-AREA pixels, wherever they lie. The
  // fallback has to come from the real island rather than from whatever ground
  // the enlarged one happens to cover.
  const tStride = TERRAINS.length + 1, cStride = CLIMATES.length + 1;
  const tHist = new Int32Array((provinceCount + 1) * tStride);
  const cHist = new Int32Array((provinceCount + 1) * cStride);
  const truePixels = new Int32Array(provinceCount + 1);

  for (let i = 0; i < trueArea.px.length; i++) {
    const c = trueArea.px[i];
    if (c === oceanKey) continue;
    const ix = colourToIndex.get(c);
    if (ix === undefined) continue;
    truePixels[ix]++;
    const t = terrainOf(terrain.px[i]);
    const k = climateOf(climate.px[i]);
    if (t) tHist[ix * tStride + t]++;
    if (k) cHist[ix * cStride + k]++;
  }

  const modal = (hist, ix, stride) => {
    let best = 0, bestN = 0;
    for (let v = 1; v < stride; v++) {
      const n = hist[ix * stride + v];
      if (n > bestN) { bestN = n; best = v; }
    }
    return best;
  };
  const provinceTerrain = new Uint8Array(provinceCount + 1);
  const provinceClimate = new Uint8Array(provinceCount + 1);
  for (let ix = 1; ix <= provinceCount; ix++) {
    provinceTerrain[ix] = modal(tHist, ix, tStride);
    provinceClimate[ix] = modal(cHist, ix, cStride);
  }

  const terrainAt = new Uint8Array(width * height);
  const climateAt = new Uint8Array(width * height);
  const alignedPixels = new Int32Array(provinceCount + 1);
  const gamePixels = new Int32Array(provinceCount + 1);
  let direct = 0, fallback = 0, blank = 0;

  for (let y = 0; y < height; y++) {
    const ty = y + northRow;
    const row = y * width;
    const trow = ty >= 0 && ty < trueArea.h ? ty * trueArea.w : -1;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const ix = provinceAt[i];
      if (ix === OCEAN) continue;
      gamePixels[ix]++;

      let t = 0, k = 0;
      if (trow >= 0) {
        const tc = trueArea.px[trow + x];
        if (tc !== oceanKey && colourToIndex.get(tc) === ix) {
          alignedPixels[ix]++;
          t = terrainOf(terrain.px[trow + x]);
          k = climateOf(climate.px[trow + x]);
        }
      }
      if (t && k) direct++;
      else {
        if (!t) t = provinceTerrain[ix];
        if (!k) k = provinceClimate[ix];
        if (t && k) fallback++; else blank++;
      }
      terrainAt[i] = t;
      climateAt[i] = k;
    }
  }

  return {
    terrainAt, climateAt, provinceTerrain, provinceClimate,
    truePixels, alignedPixels, gamePixels,
    stats: { direct, fallback, blank },
  };
}

// ------------------------------------------------------------- 2. the distance

/**
 * How far every land pixel is from the edge of its own province, by the same
 * two-pass chamfer mapdata.js uses for the border fade.
 *
 * Seeded from every pixel whose four-neighbour is a different province or the
 * sea, so a coastline and a provincial border both count. Distances are scaled
 * by CHAMFER_ORTH and saturate at DIST_MAX, which is far past anything that
 * matters here. East and west wrap; north and south do not.
 */
export function provinceEdgeDistance(provinceAt, width, height) {
  const dist = new Uint8Array(width * height).fill(DIST_MAX);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const ix = provinceAt[i];
      if (ix === OCEAN) { dist[i] = 0; continue; }
      const left = provinceAt[row + (x === 0 ? width - 1 : x - 1)];
      const right = provinceAt[row + (x + 1 === width ? 0 : x + 1)];
      const up = y > 0 ? provinceAt[i - width] : OCEAN;
      const down = y + 1 < height ? provinceAt[i + width] : OCEAN;
      if (left !== ix || right !== ix || up !== ix || down !== ix) dist[i] = 0;
    }
  }

  const A = CHAMFER_ORTH, B = CHAMFER_DIAG;
  for (let y = 0; y < height; y++) {
    const row = y * width, up = row - width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (dist[i] === 0) continue;
      const xm = x === 0 ? width - 1 : x - 1;
      const xp = x + 1 === width ? 0 : x + 1;
      let v = dist[row + xm] + A;
      if (y > 0) {
        v = Math.min(v, dist[up + x] + A, dist[up + xm] + B, dist[up + xp] + B);
      }
      if (v < dist[i]) dist[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    const row = y * width, down = row + width;
    for (let x = width - 1; x >= 0; x--) {
      const i = row + x;
      if (dist[i] === 0) continue;
      const xm = x === 0 ? width - 1 : x - 1;
      const xp = x + 1 === width ? 0 : x + 1;
      let v = dist[row + xp] + A;
      if (y + 1 < height) {
        v = Math.min(v, dist[down + x] + A, dist[down + xm] + B, dist[down + xp] + B);
      }
      if (v < dist[i]) dist[i] = v;
    }
  }
  return dist;
}

// ---------------------------------------------------------------- 3. the pieces

/**
 * Province pixels laid out for iteration: `start[ix]` to `start[ix + 1]` of `idx`
 * are the pixel indices of province `ix`.
 *
 * A flat pair of arrays rather than an array of arrays, because there are 1525
 * provinces and 3.77 million pixels and the per-array overhead is the larger of
 * the two costs.
 */
function provinceIndex(provinceAt, provinceCount) {
  const start = new Int32Array(provinceCount + 2);
  for (let i = 0; i < provinceAt.length; i++) {
    const ix = provinceAt[i];
    if (ix !== OCEAN) start[ix + 1]++;
  }
  for (let ix = 1; ix <= provinceCount + 1; ix++) start[ix] += start[ix - 1];

  const fill = start.slice();
  const idx = new Int32Array(start[provinceCount + 1]);
  for (let i = 0; i < provinceAt.length; i++) {
    const ix = provinceAt[i];
    if (ix !== OCEAN) idx[fill[ix]++] = i;
  }
  return { start, idx };
}

/** A binary heap of (cost, pixel, seed), on typed arrays that grow as needed. */
class Heap {
  constructor(cap) {
    this.cost = new Float64Array(cap);
    this.item = new Int32Array(cap);
    this.from = new Int32Array(cap);
    this.n = 0;
  }

  clear() { this.n = 0; }

  push(cost, item, from) {
    if (this.n === this.cost.length) this.grow();
    let i = this.n++;
    this.cost[i] = cost; this.item[i] = item; this.from[i] = from;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cost[p] <= this.cost[i]) break;
      this.swap(p, i);
      i = p;
    }
  }

  pop(out) {
    out.cost = this.cost[0]; out.item = this.item[0]; out.from = this.from[0];
    const last = --this.n;
    this.cost[0] = this.cost[last]; this.item[0] = this.item[last]; this.from[0] = this.from[last];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.n && this.cost[l] < this.cost[m]) m = l;
      if (r < this.n && this.cost[r] < this.cost[m]) m = r;
      if (m === i) break;
      this.swap(m, i);
      i = m;
    }
    return out;
  }

  swap(a, b) {
    let t = this.cost[a]; this.cost[a] = this.cost[b]; this.cost[b] = t;
    t = this.item[a]; this.item[a] = this.item[b]; this.item[b] = t;
    t = this.from[a]; this.from[a] = this.from[b]; this.from[b] = t;
  }

  grow() {
    const cap = this.cost.length * 2;
    const cost = new Float64Array(cap), item = new Int32Array(cap), from = new Int32Array(cap);
    cost.set(this.cost); item.set(this.item); from.set(this.from);
    this.cost = cost; this.item = item; this.from = from;
  }
}

const speedOf = (t, k, urban = false) =>
  (TERRAIN_SPEED[TERRAINS[t - 1]] ?? TERRAIN_SPEED.Plains)
  * (CLIMATE_SPEED[CLIMATES[k - 1]] ?? 1) * (urban ? URBAN_SPEED : 1);
const targetOf = (k) => CLIMATE_TARGET[CLIMATES[k - 1]] ?? DEFAULT_TARGET;

/**
 * How large a county wants to be on one pixel of ground, in km², as a field.
 *
 * Read per pixel rather than once per component. Taking the component's dominant
 * climate and applying it throughout put a step change wherever two components
 * met: an ice cap province cut into 70,000 km² counties sat against a subarctic
 * one cut into 26,000 km² counties, and the join was a straight line of sizes
 * changing by a factor of three. Read per pixel, the size grades across the
 * ground the way the climate does.
 *
 * A small table over the sixteen terrain and thirteen climate codes, so the
 * pixel loop is an array index.
 */
const SMOOTH_RADIUS = 26;           // pixels either side, run twice

function targetTable() {
  const nt = TERRAINS.length + 1, nk = CLIMATES.length + 1;
  const out = new Float64Array(nt * nk);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < nk; k++) {
      const cross = (crossDaysFor(k) * speedOf(t, k)) ** 2;
      out[t * nk + k] = Math.min(targetOf(k), cross);
    }
  }
  return { table: out, nk };
}

/**
 * The same field, blurred, which is what the growth actually reads.
 *
 * Read raw, the target steps by a factor of three where subarctic meets ice cap,
 * and the county size steps with it: a wall of small counties against a wall of
 * large ones with a straight line between them. Climate does not change like
 * that on the ground and neither should the counties.
 *
 * A separable box blur run twice, which is close enough to a Gaussian and is two
 * passes over the map rather than a convolution. Only land is sampled, so the
 * sea does not drag a coastal county toward some default, and the blur runs on
 * the RECIPROCAL of the target, which is the density counties are actually
 * placed by; blurring the target itself would let one huge polar number pull the
 * average up across a whole coastline.
 */
function smoothTargets(terrainAt, climateAt, provinceAt, width, height) {
  const { table, nk } = targetTable();
  const n = width * height;
  let a = new Float32Array(n), b = new Float32Array(n);
  const land = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    if (provinceAt[i] === OCEAN) continue;
    land[i] = 1;
    a[i] = 1 / table[terrainAt[i] * nk + climateAt[i]];
  }

  const R = SMOOTH_RADIUS;
  for (let pass = 0; pass < 2; pass++) {
    // across, wrapping east to west
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (!land[row + x]) continue;
        let sum = 0, count = 0;
        for (let d = -R; d <= R; d++) {
          const j = row + (((x + d) % width) + width) % width;
          if (land[j]) { sum += a[j]; count++; }
        }
        b[row + x] = sum / count;
      }
    }
    // and down
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (!land[row + x]) continue;
        let sum = 0, count = 0;
        for (let d = -R; d <= R; d++) {
          const ny = y + d;
          if (ny < 0 || ny >= height) continue;
          const j = ny * width + x;
          if (land[j]) { sum += b[j]; count++; }
        }
        a[row + x] = sum / count;
      }
    }
  }

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) if (land[i]) out[i] = 1 / a[i];
  return out;
}

/**
 * How long a set of pixels is against how wide, on the ground.
 *
 * The square root of the ratio of the second moments about its two principal
 * axes: 1 is round, 2 is twice as long as wide. Longitudes are scaled by the
 * cosine of the latitude so the answer is in kilometres rather than pixels, and
 * the first pixel is used as the origin so a set straddling the map seam is
 * measured across the seam rather than around the world.
 */
function elongation(pixels, width, cosLat) {
  const x0 = pixels[0] % width, y0 = (pixels[0] / width) | 0;
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const i of pixels) {
    const y = (i / width) | 0;
    let dx = (i - y * width) - x0;
    if (dx > width / 2) dx -= width; else if (dx < -width / 2) dx += width;
    dx *= cosLat[y];
    const dy = y - y0;
    n++; sx += dx; sy += dy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const mx = sx / n, my = sy / n;
  const a = sxx / n - mx * mx, b = syy / n - my * my, ab = sxy / n - mx * my;
  const t = (a + b) / 2, d = Math.sqrt(Math.max(0, ((a - b) / 2) ** 2 + ab * ab));
  return Math.sqrt((t + d) / Math.max(1e-9, t - d));
}

/** Modal code over a set of pixels, weighted by how much ground each pixel covers. */
function modalOver(pixels, codes, width, areaOfPixel, n) {
  const tally = new Float64Array(n + 1);
  for (const i of pixels) tally[codes[i]] += areaOfPixel((i / width) | 0);
  let best = 0, bestW = 0;
  for (let v = 1; v <= n; v++) if (tally[v] > bestW) { bestW = tally[v]; best = v; }
  return best;
}

/**
 * Centre of a set of pixels as lat/lon in radians, through unit vectors.
 *
 * A county wrapped around a bay has its mean out in the water, and a centre is
 * a PLACE: the game draws rail nodes and city markers on it, and one sitting
 * offshore is wrong wherever it is used. So the mean is kept when it falls on
 * the county's own ground and otherwise pulled to the pixel of its own that
 * lies nearest it. Convex counties, which are nearly all of them, are untouched.
 */
function centreOf(pixels, width, proj) {
  let vx = 0, vy = 0, vz = 0;
  for (const i of pixels) {
    const y = (i / width) | 0;
    const [a, b, c] = proj.toVector(i - y * width, y);
    vx += a; vy += b; vz += c;
  }
  const mean = proj.fromVector([vx, vy, vz]);

  // lonAt and latAt are both linear in the pixel index, so this inverts them
  // exactly rather than searching.
  const x = Math.round((((mean.lon + Math.PI) / (2 * Math.PI)) * width) - 0.5);
  const y = Math.round(((Math.PI / 2 - mean.lat) / Math.PI) * proj.globeHeight - 0.5)
    - proj.northRow;
  const at = y * width + ((x % width) + width) % width;
  for (const i of pixels) if (i === at) return mean;

  let best = at, bestDot = -Infinity;
  for (const i of pixels) {
    const py = (i / width) | 0;
    const [a, b, c] = proj.toVector(i - py * width, py);
    const dot = a * vx + b * vy + c * vz;
    if (dot > bestDot) { bestDot = dot; best = i; }
  }
  const by = (best / width) | 0;
  return { lat: proj.latAt(by), lon: proj.lonAt(best - by * width) };
}

// ------------------------------------------------------------------ 4-6. growth

/**
 * Every county on the map.
 *
 * Returns `countyAt`, one county index per pixel with 0 for sea, and `counties`
 * in index order. Both are what counties.png and counties.json are written from.
 */
export function generateCounties({
  provinceAt, width, height, northRow, globeHeight, atIndex,
  // Rivers AND inland lakes, in one array. Both are something a boundary pays
  // to cross, and the growth has no reason to tell them apart. measureWater
  // does, and takes the two separately.
  terrainAt, climateAt, waterAt, edgeDist, trueRatio, cityAt = null, onProgress,
  maxCounties = MAX_COUNTIES,
}) {
  const proj = makeProjection({ width, height, globeHeight, northRow });
  const areaOfPixel = (y) => proj.areaOfPixel(y);

  // How wide a pixel is against how tall, per row. Floored so a row at the pole
  // does not make horizontal movement free and stretch a county round the world.
  const cosLat = new Float64Array(height);
  for (let y = 0; y < height; y++) cosLat[y] = Math.max(0.08, Math.cos(proj.latAt(y)));

  const targetAt = smoothTargets(terrainAt, climateAt, provinceAt, width, height);

  // The cost of crossing a pixel, field and amplitude already combined, so the
  // growth loop reads one number instead of recomputing this fifteen million
  // times over.
  const roughAt = roughnessField(width, height);
  const costAt = new Float32Array(width * height);
  for (let i = 0; i < costAt.length; i++) {
    if (provinceAt[i] === OCEAN) { costAt[i] = 1; continue; }
    const scale = Math.sqrt(targetAt[i] / DEFAULT_TARGET);
    const k = ROUGHNESS * (1 + ROUGH_GAIN * Math.max(0, scale - 1));
    costAt[i] = Math.exp(k * ((roughAt[i] - 128) / 127));
  }
  const provinceCount = atIndex.length - 1;
  const pixelCount = width * height;

  const { start, idx } = provinceIndex(provinceAt, provinceCount);

  // Scratch, all map-sized and all reused. `owner` doubles as the membership
  // test: NOT_IN is a pixel outside the piece being grown, FREE is one inside it
  // that no seed has reached, and anything else is the seed that took it.
  const NOT_IN = -2, FREE = -1;
  const owner = new Int16Array(pixelCount).fill(NOT_IN);
  const bestCost = new Float32Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const step = new Uint16Array(pixelCount);
  const far = new Uint16Array(pixelCount);
  const seen = new Uint8Array(pixelCount);
  const countyAt = new Uint16Array(pixelCount);
  const heap = new Heap(1 << 16);
  const popped = { cost: 0, item: 0, from: 0 };

  const counties = [];
  const stats = { pieces: 0, absorbedPieces: 0, capped: 0, cappedFrom: 0, crossCapped: 0, seedsShort: 0, split: 0, uncovered: 0, urbanSeeds: 0 };

  // countyAt is Uint16 and 0 means sea, so this is the ceiling on the whole map.
  const MAX_INDEX = 65535;

  for (let ix = 1; ix <= provinceCount; ix++) {
    const pixels = idx.subarray(start[ix], start[ix + 1]);
    if (!pixels.length) continue;
    const province = atIndex[ix];

    // --- the pieces
    const parts = [];
    for (const seed of pixels) {
      if (seen[seed]) continue;
      const part = [];
      let top = 0;
      queue[top++] = seed;
      seen[seed] = 1;
      while (top) {
        const i = queue[--top];
        part.push(i);
        const y = (i / width) | 0, x = i - y * width;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          const nrow = ny * width;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx < 0 ? width - 1 : x + dx >= width ? 0 : x + dx;
            const j = nrow + nx;
            if (seen[j] || provinceAt[j] !== ix) continue;
            seen[j] = 1;
            queue[top++] = j;
          }
        }
      }
      parts.push(part);
    }
    stats.pieces += parts.length;

    // --- their true areas. Drawn area times the province's own enlargement
    // factor, so an island drawn at four times life size is measured at its real
    // size and gets the counties its real size deserves.
    const ratio = trueRatio[ix] || 1;

    // What one pixel of this province asks for, as a fraction of a county. Its
    // ground in km² over what a county wants to be on that ground.
    const demand = (i) => (areaOfPixel((i / width) | 0) * ratio) / targetAt[i];
    const measured = parts.map((part) => {
      let drawn = 0;
      for (const i of part) drawn += areaOfPixel((i / width) | 0);
      return { part, area: drawn * ratio };
    });

    const speck = (m) => m.part.length <= MIN_PIECE_PX || m.area < MIN_PIECE;
    let keep = measured.filter((m) => !speck(m));
    let drop = measured.filter(speck);
    // MIN_PIECE removes specks from a province that has a mainland to absorb them
    // into. Where there is no mainland it must not apply at all: an archipelago
    // country whose islands are each 150 km2 is a country of islands, not a
    // country of specks, and pooling them onto whichever is largest gives it one
    // county covering water it does not own. Nodavanua came out that way.
    //
    // So the threshold only bites when something is left above it. Below that,
    // every island keeps its own county.
    if (!keep.length) { keep = measured; drop = []; }
    stats.absorbedPieces += drop.length;

    const madeHere = [];
    for (const { part, area } of keep) {
      // How many counties this piece wants is the integral of its own demand
      // rather than its area over one target: every pixel asks for the fraction
      // of a county its ground is worth, and they are added up. A piece that is
      // half ice cap and half tundra asks for what each half is worth and gets
      // counties that grade between the two instead of one size throughout.
      let want = 0;
      for (const i of part) want += demand(i);
      want = Math.max(1, Math.round(want));

      // A piece with more cities than that wants more counties than that, since
      // every city is a seed and every seed is a county.
      let cities = 0;
      if (cityAt) for (const i of part) if (cityAt[i]) cities++;
      const n = Math.max(cities, Math.min(maxCounties, want));
      if (n < want) { stats.capped++; stats.cappedFrom += want - n; }
      stats.urbanSeeds += cities;

      if (counties.length + n > MAX_INDEX) {
        throw new Error(`more than ${MAX_INDEX} counties; countyAt cannot hold them. `
          + 'Raise the climate targets under CLIMATE_TARGET or widen the array.');
      }
      // URBAN_AREA in pixels of this piece, which depends on the latitude it sits
      // at and on how much larger than life the province is drawn.
      const perPixel = (areaOfPixel((part[0] / width) | 0)) * ratio;
      const urbanPixels = Math.round(URBAN_AREA / Math.max(perPixel, 1e-9));

      // How much larger than a temperate county this ground wants to be, which is
      // what both the roughness and the relief above are scaled by.
      let meanTarget = 0;
      for (const i of part) meanTarget += targetAt[i];
      const sizeScale = Math.sqrt(meanTarget / part.length / DEFAULT_TARGET);

      const grow = (pixels, count) => {
        const made = growPiece({
          part: pixels, n: count, width, height, waterAt, edgeDist, owner, bestCost,
          queue, step, far, heap, popped, countyAt, counties, province, NOT_IN, FREE,
          cityAt, urbanPixels, cosLat, roughAt, costAt, demand, sizeScale,
        });
        for (const c of made) {
          c.area = c.pixels.reduce((s, i) => s + areaOfPixel((i / width) | 0), 0) * ratio;
        }
        return made;
      };

      let made = grow(part, n);
      if (made.length < n) stats.seedsShort++;

      // The piece was sized on the terrain MOST of it has. A county that comes
      // out of slower ground than that is over its days-to-cross budget: a
      // range of mountains inside a plains province is cut to a plains size and
      // then takes three times as long to walk over. Those are cut again, on
      // their own terrain this time, until every one is within the budget.
      //
      // This is where the days-to-cross rule is actually enforced. The target
      // above only sets the average for a piece, and an average is not a bound.
      for (let round = 0; round < SPLIT_ROUNDS; round++) {
        const slow = [];
        for (const c of made) {
          // An urban county is deliberately small and holds the city that made it.
          // Cutting it would produce pieces with no city in them and lose the one
          // guarantee this pass exists to keep.
          if (c.urban || c.pixels.length <= 1) continue;
          const t = modalOver(c.pixels, terrainAt, width, areaOfPixel, TERRAINS.length);
          const k = modalOver(c.pixels, climateAt, width, areaOfPixel, CLIMATES.length);
          const days = Math.sqrt(c.area) / speedOf(t, k);
          const cap = crossDaysFor(k);
          let into = days > cap ? Math.ceil((days / cap) ** 2) : 0;

          if (into > 1) slow.push([c, Math.min(MAX_COUNTIES, into)]);
        }
        if (!slow.length) break;

        const still = made.filter((c) => !slow.some(([q]) => q === c));
        for (const [c, into] of slow) {
          if (counties.length + into > MAX_INDEX) break;
          const pixels = c.pixels;
          c.pixels = [];
          c.area = 0;
          c.dead = true;
          stats.split++;
          still.push(...grow(pixels, into));
        }
        made = still;
      }

      for (const c of made) madeHere.push(c);
    }

    // --- the specks, each to the nearest county of the same province. Great-circle
    // distance, so a rock either side of the map seam still finds its neighbour.
    if (drop.length) {
      // Centres once, not once per speck. A province can have a hundred of them.
      const centres = madeHere.map((c) => centreOf(c.pixels, width, proj));
      for (const { part, area } of drop) {
        const a = centreOf(part, width, proj);
        let to = 0, bestD = Infinity;
        for (let k = 0; k < madeHere.length; k++) {
          const d = distanceKm(a, centres[k]);
          if (d < bestD) { bestD = d; to = k; }
        }
        for (const i of part) countyAt[i] = madeHere[to].index;
        appendAll(madeHere[to].pixels, part);
        madeHere[to].area += area;
      }
    }

    // Every pixel of the province has to have ended up in a county. Nothing here
    // is allowed to leave ground unassigned, and a hole is invisible until an
    // army tries to walk into it.
    for (const i of pixels) if (!countyAt[i]) stats.uncovered++;

    if (onProgress) onProgress(ix, provinceCount, counties.length);
  }

  return { countyAt, counties, stats, proj, areaOfPixel, cosLat };
}

/**
 * One piece of land, divided into `n` counties.
 *
 * Two passes, and the order is the point.
 *
 * The CITIES go first and alone. Every city in the piece is a seed, every seed
 * becomes a county, and each grows to `URBAN_AREA` and stops, with the roughness
 * field pushing harder than it does anywhere else. Only then is the rest of the
 * ground divided, around the city counties already sitting in it.
 *
 * Grown together instead, as this did at first, the two spoil each other: the
 * city county stops at its limit while its neighbours are still running, they
 * close over the gap at whatever angle they happen to arrive at, and the join is
 * a scar rather than a border. Drawn first, the city has a finished edge and its
 * neighbours simply take the ground up to it.
 *
 * The ordinary seeds are placed by farthest-point sampling over what is left,
 * weighted by the roughness field. Taken plainly, farthest-point spreads seeds as
 * evenly as the ground allows, and evenly spread seeds grown to equal areas make
 * a honeycomb; the weighting pulls them toward some parts of the ground and away
 * from others so the arrangement follows the lie of the land. Distance is
 * measured THROUGH the land, so a peninsula takes a seed at its end rather than
 * one out in the strait.
 *
 * Every county comes out connected by construction, so nothing is repaired
 * afterwards.
 */
function growPiece({
  part, n, width, height, waterAt, edgeDist, owner, bestCost, queue, step, far,
  heap, popped, countyAt, counties, province, NOT_IN, FREE, cityAt, urbanPixels = 0, cosLat,
  roughAt, costAt, demand, sizeScale = 1,
}) {
  for (const i of part) {
    owner[i] = FREE;
    bestCost[i] = Infinity;
    far[i] = 0xffff;
    step[i] = 0xffff;
  }

  // Multi-source BFS through the free ground, recording how far every pixel is
  // from the nearest seed placed so far.
  const spread = (from) => {
    let head = 0, tail = 0;
    queue[tail++] = from;
    step[from] = 0;
    const touched = [from];
    while (head < tail) {
      const i = queue[head++];
      const d = step[i];
      const y = (i / width) | 0, x = i - y * width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx < 0 ? width - 1 : x + dx >= width ? 0 : x + dx;
          const j = ny * width + nx;
          if (owner[j] !== FREE || step[j] !== 0xffff) continue;
          step[j] = d + 1;
          touched.push(j);
          queue[tail++] = j;
        }
      }
    }
    for (const i of touched) if (step[i] < far[i]) far[i] = step[i];
    for (const i of touched) step[i] = 0xffff;
  };

  const made = [], claimed = [], held = [], limit = [];
  const margin = RIVER_MARGIN * CHAMFER_ORTH;

  let totalDemand = 0;
  for (const i of part) totalDemand += demand(i);
  const push = BALANCE / (1 + BALANCE_RELIEF * Math.max(0, sizeScale - 1));
  const share = Math.max(1e-9, totalDemand / Math.max(1, n));

  const addSeed = (pixel, isUrban) => {
    const county = { index: counties.length + 1, province, pixels: [], urban: isUrban };
    counties.push(county);
    made.push(county);
    claimed.push(0);
    held.push(0);
    limit.push(isUrban ? Math.max(1, urbanPixels) : Infinity);
    bestCost[pixel] = 0;
    heap.push(0, pixel, made.length - 1);
    return made.length - 1;
  };

  // `roughPow` raises the cost field to a power, which multiplies its exponent.
  // The cities take it at URBAN_ROUGH so that ground eight pixels across is
  // deformed as much as ground seventy pixels across is at 1.
  const drain = (roughPow) => {
    while (heap.n) {
      const { cost, item: i, from: s } = heap.pop(popped);
      if (owner[i] !== FREE) continue;
      owner[i] = s;
      claimed[s] += demand(i);
      held[s]++;
      countyAt[i] = made[s].index;
      made[s].pixels.push(i);

      if (held[s] >= limit[s]) continue;            // a city that has reached its size

      const y = (i / width) | 0, x = i - y * width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx < 0 ? width - 1 : x + dx >= width ? 0 : x + dx;
          const j = ny * width + nx;
          if (owner[j] !== FREE) continue;

          // A river attracts a county boundary, but only well inside the province.
          // A river drawn along a province edge would otherwise put a boundary on
          // it and strand a ribbon of ground between the two.
          const river = waterAt[j] && edgeDist[j] > margin;
          const rough = roughPow === 1 ? costAt[j] : costAt[j] ** roughPow;
          const v = cost + Math.hypot(dx * cosLat[ny], dy) * rough
            + (river ? RIVER_COST : 0) + push * (claimed[s] / share);
          if (v < bestCost[j]) { bestCost[j] = v; heap.push(v, j, s); }
        }
      }
    }
  };

  // --- the cities
  heap.clear();
  let cities = 0;
  if (cityAt) for (const i of part) if (cityAt[i]) { addSeed(i, true); cities++; }
  if (cities) drain(URBAN_ROUGH);

  // --- and the rest, over what they left
  const rest = [];
  for (const i of part) if (owner[i] === FREE) { bestCost[i] = Infinity; rest.push(i); }

  if (rest.length && made.length < n) {
    for (const i of part) far[i] = 0xffff;
    let first = rest[0];
    for (const i of rest) if (edgeDist[i] > edgeDist[first]) first = i;
    const picks = [first];
    spread(first);

    while (picks.length + cities < n) {
      let pick = -1, pickScore = 0;
      for (const i of rest) {
        if (far[i] === 0xffff || far[i] === 0) continue;
        const lie = 0.5 + (roughAt[i] - 128) / 254;   // the field is signed around 128
        const score = far[i] * (SEED_BIAS + (1 - SEED_BIAS) * 2 * lie);
        if (score > pickScore) { pickScore = score; pick = i; }
      }
      if (pick < 0) break;                    // nowhere left that is not beside a seed
      picks.push(pick);
      spread(pick);
    }

    heap.clear();
    for (const p of picks) addSeed(p, false);
    drain(1);
  }

  // --- anything still unclaimed
  //
  // A city stops at its limit, and on a one-city island every seed is a city
  // seed, so ground can be left over. It is grown again with the limits lifted.
  // Without this an island with a town on it would have ground in no county.
  let free = 0;
  for (const i of part) if (owner[i] === FREE) free++;
  if (free && made.length) {
    for (let k = 0; k < made.length; k++) limit[k] = Infinity;
    for (const i of part) if (owner[i] === FREE) bestCost[i] = Infinity;
    heap.clear();
    for (const i of part) {
      const s = owner[i];
      if (s < 0) continue;
      const y = (i / width) | 0, x = i - y * width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx < 0 ? width - 1 : x + dx >= width ? 0 : x + dx;
          const j = ny * width + nx;
          if (owner[j] !== FREE) continue;
          const v = bestCost[i] + Math.hypot(dx * cosLat[ny], dy) * costAt[j];
          if (v < bestCost[j]) { bestCost[j] = v; heap.push(v, j, s); }
        }
      }
    }
    drain(1);
  }

  for (const i of part) owner[i] = NOT_IN;
  return made;
}

// ----------------------------------------------------------------- 7-8. finish

/**
 * Merges away counties too small to be worth having, then tags what is left.
 *
 * A county below MIN_AREA goes into its smallest neighbour inside the same
 * province, smallest so that merging evens the sizes out rather than feeding
 * whichever giant happens to be adjacent. A piece that is one county and is
 * itself below the floor is left alone; there is nothing in the province to
 * merge it into and the ground still has to belong to something.
 *
 * Tagging is last because a merged county's terrain is the terrain of the ground
 * it ended up with, not of the ground it started with.
 */
export function finishCounties({
  countyAt, counties, width, height, terrainAt, climateAt, areaOfPixel, proj, cosLat,
}) {
  const byIndex = new Map(counties.map((c) => [c.index, c]));

  // --- adjacency, from the pixels, four-way as province adjacency is
  // Adjacency, and how much border each county shares with each neighbour. The
  // length is what says whether a county is merely beside another or shut inside
  // it, and a count of neighbours cannot tell the two apart.
  const near = new Map(counties.map((c) => [c.index, new Map()]));
  const edgeSea = new Map();
  const touch = (a, q) => {
    if (!q) { edgeSea.set(a, (edgeSea.get(a) || 0) + 1); return; }
    near.get(a).set(q, (near.get(a).get(q) || 0) + 1);
    near.get(q).set(a, (near.get(q).get(a) || 0) + 1);
  };
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const a = countyAt[row + x];
      if (!a) continue;
      const b = countyAt[row + (x + 1 === width ? 0 : x + 1)];
      const c = y + 1 < height ? countyAt[row + width + x] : 0;
      if (b !== a) touch(a, b);
      if (y + 1 >= height) touch(a, 0);
      else if (c !== a) touch(a, c);
    }
  }

  // --- merge, smallest first, so a chain of tiny counties collapses inward
  const merged = new Map();                  // index -> the index it became
  const resolve = (i) => { while (merged.has(i)) i = merged.get(i); return i; };
  let mergeCount = 0;

  // Border shared between two counties, and the whole border of one, both read
  // through `resolve` so they stay right as counties are absorbed.
  const shared = (a, b) => {
    let n = 0;
    for (const [q, len] of near.get(a) || []) if (resolve(q) === b) n += len;
    return n;
  };
  const perimeter = (a) => {
    let n = edgeSea.get(a) || 0;
    for (const [q, len] of near.get(a) || []) if (resolve(q) !== a) n += len;
    return n;
  };
  const absorb = (survivor, gone) => {
    appendAll(survivor.pixels, gone.pixels);
    survivor.area += gone.area;
    survivor.urban = survivor.urban || gone.urban;
    const into = near.get(survivor.index);
    for (const [q, len] of near.get(gone.index) || []) {
      const r = resolve(q);
      if (r === survivor.index) continue;
      into.set(r, (into.get(r) || 0) + len);
      const back = near.get(r);
      if (back) back.set(survivor.index, (back.get(survivor.index) || 0) + len);
    }
    edgeSea.set(survivor.index, (edgeSea.get(survivor.index) || 0) + (edgeSea.get(gone.index) || 0));
    merged.set(gone.index, survivor.index);
    gone.pixels = [];
  };
  const neighboursOf = (c) => {
    const out = new Map();
    for (const [q, len] of near.get(c.index) || []) {
      const r = resolve(q);
      const t = byIndex.get(r);
      if (!t || r === c.index || !t.pixels.length) continue;
      out.set(t, (out.get(t) || 0) + len);
    }
    return out;
  };

  for (const small of [...counties].sort((a, b) => a.area - b.area)) {
    // An urban county is small on purpose and is the only thing standing for its
    // city, so it is never the one absorbed. It can still absorb others.
    if (merged.has(small.index) || small.urban || small.area >= MIN_AREA) continue;
    let into = null;
    for (const [target] of neighboursOf(small)) {
      if (target.province !== small.province) continue;
      if (!into || target.area < into.area) into = target;
    }
    if (!into) continue;                     // alone in its province, so it stays
    absorb(into, small);
    mergeCount++;
  }

  // --- engulfed counties
  //
  // A county can have several neighbours and still be shut inside one of them.
  // Counting neighbours does not find that; the length of border does. Where one
  // neighbour holds most of a county's edge, the county has one way in and one
  // way out whatever else it touches, which is a poor thing to fight over and a
  // worse one to supply.
  //
  // The two are merged, and where one is urban it survives, so the city keeps a
  // county of its own and gains the neighbours its host had. Sea counts toward
  // the perimeter, so a coastal county is never engulfed by the land behind it.
  //
  // Only a neighbour in the SAME province. A county held inside another
  // province's is the shape of the province, not a fault of the growth, and
  // merging across that border would put one county in two provinces.
  let enclaves = 0, stranded = 0;
  for (let round = 0; round < 3; round++) {
    let changed = 0;
    for (const c of counties) {
      if (merged.has(c.index) || !c.pixels.length) continue;
      const edge = perimeter(c.index);
      if (!edge) continue;

      let host = null, most = 0;
      for (const [t, len] of neighboursOf(c)) if (len > most) { most = len; host = t; }
      if (!host || most / edge < ENGULF_SHARE) continue;

      if (host.province !== c.province) { stranded++; continue; }
      if (c.urban && host.urban) { stranded++; continue; }

      const [survivor, gone] = c.urban ? [c, host] : host.urban ? [host, c]
        : c.area >= host.area ? [c, host] : [host, c];
      absorb(survivor, gone);
      changed++;
      enclaves++;
    }
    if (!changed) break;
  }
  // --- slivers
  //
  // Some counties come out drawn into ribbons. It is not the roughness: at a fifth
  // of the amplitude there are still 217 of them against 235, so they are the
  // geometry rather than the noise. Any partition of irregular ground leaves cells
  // squeezed between a coast and their neighbours, and a Voronoi cell against a
  // wall is a poor shape by construction.
  //
  // They are DISSOLVED, not split. Splitting a ribbon divides its length and
  // leaves its width alone, so the pieces are shorter ribbons; tried across the
  // whole map it added 1,700 counties and made the worst elongation worse rather
  // than better. Dissolving hands each pixel to whichever neighbour is nearest,
  // and the neighbours close over the gap without becoming ribbons themselves.
  //
  // Only up to SLIVER_MAX_PX. A large elongated county is usually following a
  // coastline, which is ground that really is that shape, and dissolving it would
  // hand a great deal of land to counties sized for less. Never an urban one, and
  // never one with fewer than two neighbours in its province, which is the
  // engulfment rule's business rather than this one's.
  let dissolved = 0;
  for (const c of counties) {
    if (merged.has(c.index) || c.urban) continue;
    if (c.pixels.length < 12 || c.pixels.length > SLIVER_MAX_PX) continue;
    if (elongation(c.pixels, width, cosLat) <= SLIVER_ELONGATION) continue;

    const hosts = [];
    for (const [t] of neighboursOf(c)) if (t.province === c.province) hosts.push(t);
    if (hosts.length < 2) continue;

    // Each pixel to the nearest neighbour, by a walk outward from the edges of
    // the sliver rather than by distance to a centre, so the ground goes to the
    // county actually beside it.
    const mine = new Set(c.pixels);
    const take = new Map();
    const queue = [];
    for (const i of c.pixels) {
      const y = (i / width) | 0, x = i - y * width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const j = ny * width + ((x + dx + width) % width);
        if (mine.has(j) || !countyAt[j]) continue;
        const t = byIndex.get(resolve(countyAt[j]));
        if (!t || t.province !== c.province || !t.pixels.length) continue;
        if (!take.has(i)) { take.set(i, t); queue.push(i); }
      }
    }
    if (!take.size) continue;

    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], t = take.get(i);
      const y = (i / width) | 0, x = i - y * width;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const j = ny * width + ((x + dx + width) % width);
        if (!mine.has(j) || take.has(j)) continue;
        take.set(j, t);
        queue.push(j);
      }
    }
    if (take.size < c.pixels.length) continue;      // some of it is unreachable

    const per = areaOfPixel;
    const scale = c.area / c.pixels.reduce((s, i) => s + per((i / width) | 0), 0);
    for (const [i, t] of take) {
      t.pixels.push(i);
      t.area += per((i / width) | 0) * scale;
      countyAt[i] = t.index;
    }
    c.pixels = [];
    c.area = 0;
    merged.set(c.index, take.values().next().value.index);
    dissolved++;
  }

  // --- renumber, so the written indices are 1..n with no holes
  const kept = counties.filter((c) => !merged.has(c.index) && c.pixels.length);
  const remap = new Uint16Array(counties.length + 1);
  kept.forEach((c, k) => { remap[c.index] = k + 1; });
  for (const [from] of merged) remap[from] = remap[resolve(from)];
  for (let i = 0; i < countyAt.length; i++) if (countyAt[i]) countyAt[i] = remap[countyAt[i]];
  kept.forEach((c, k) => { c.index = k + 1; });

  // --- tag
  for (const c of kept) {
    c.terrain = terrainName(modalOver(c.pixels, terrainAt, width, areaOfPixel, TERRAINS.length));
    c.climate = climateName(modalOver(c.pixels, climateAt, width, areaOfPixel, CLIMATES.length));
    const centre = centreOf(c.pixels, width, proj);
    c.centre = [Number(toDegrees(centre.lat).toFixed(4)), Number(toDegrees(centre.lon).toFixed(4))];
  }

  return { counties: kept, merged: mergeCount, enclaves, stranded, dissolved };
}

// ------------------------------------------------------- water at the borders

/**
 * How much water each county holds, and how much of each border it shares is
 * water. Four figures, written onto the counties handed in:
 *
 *   riverShare    river pixels in the county over its own pixels
 *   lakeShare     lake pixels likewise
 *   riverBorders  per neighbour, the share of the border between them that is river
 *   lakeBorders   the same for lake
 *
 * The first two say what it is like to fight IN a county. The second two say
 * what it is like to attack INTO one from a particular direction, which is not
 * the same question and cannot be answered by a single figure on the county.
 *
 * RIVERS AND LAKES ARE COUNTED SEPARATELY, unlike the barrier field the growth
 * uses, where both are simply something a boundary pays to cross. Here they are
 * two modifiers with two strengths, so they are two arrays.
 *
 * THE BORDER IS A LINE BETWEEN TWO PIXELS AND HAS NO WIDTH, so a crossing counts
 * as river if the pixel on EITHER side of it is a river pixel, in either county.
 *
 * That last clause is the whole of it, and it is not a convenience. A river is
 * drawn one pixel wide, so those pixels sit inside one county or the other and
 * never in both. snapToRivers hands them to whichever bank the flood reached
 * first, which is a race and settles differently along the length of one river.
 * Count only the water inside the DEFENDING county and half the river borders on
 * the map give no modifier at all, decided by nothing anybody chose. An army
 * crossing a river that lies in its own county is still crossing the river.
 *
 * So the figure is symmetric and both counties are given it. Attacking east
 * across the Adle is the same crossing as attacking west across it.
 *
 * `counties` is an array of objects carrying `pixels`. The two border figures
 * are Maps keyed by the NEIGHBOURING COUNTY OBJECT, because ids are assigned
 * after this runs on the read path; the caller turns them into ids when it
 * writes them out.
 *
 * Only what a county HAS is recorded. A county with no river has no riverShare
 * and no riverBorders, the way a province with no coal has no coal in
 * resources.json, and every reader takes an absent figure as zero. Written for
 * all fourteen thousand, the zeroes are 600KB of a file the page fetches.
 */
export function measureWater({
  counties, riverAt, lakeAt, width, height, minBorder = MIN_BORDER_PX,
}) {
  const n = counties.length;

  // County per pixel, as a dense ordinal, 0 for ground in no county. Built from
  // the pixel lists rather than taken from the caller, so the read path and the
  // generate path measure the same thing however they arrived at it.
  const at = n < 65535 ? new Uint16Array(width * height) : new Int32Array(width * height);
  for (let k = 0; k < n; k++) {
    for (const i of counties[k].pixels) at[i] = k + 1;
  }

  const own = new Int32Array(n + 1);
  const river = new Int32Array(n + 1);
  const lake = new Int32Array(n + 1);

  // Border tallies, the pair packed into one integer so the inner loop keys a
  // Map with a number rather than building a string per boundary pixel.
  const edge = new Map();
  const span = n + 1;

  // px, river, lake, and then which SIDE the river water sat on: the lower of
  // the two ordinals, the higher, or both. Only kept so the run can report how
  // much of the map turns on the either-side rule; nothing is written from it.
  const tally = (a, b, i, j) => {
    const lo = a < b;
    const key = lo ? a * span + b : b * span + a;
    let e = edge.get(key);
    if (!e) edge.set(key, e = [0, 0, 0, 0, 0]);
    e[0]++;
    const ri = riverAt[i], rj = riverAt[j];
    if (ri || rj) {
      e[1]++;
      if (lo ? ri : rj) e[3]++;
      if (lo ? rj : ri) e[4]++;
    }
    if (lakeAt[i] || lakeAt[j]) e[2]++;
  };

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const a = at[i];
      if (!a) continue;
      own[a]++;
      if (riverAt[i]) river[a]++;
      if (lakeAt[i]) lake[a]++;

      // Right, wrapping east to west at the last column, and below, which does
      // not wrap. The two directions scanAdjacency uses, so every touching pair
      // is seen exactly once and this describes the same graph the game moves on.
      const r = x + 1 < width ? i + 1 : row;
      const rc = at[r];
      if (rc && rc !== a) tally(a, rc, i, r);
      if (y + 1 < height) {
        const d = i + width;
        const dc = at[d];
        if (dc && dc !== a) tally(a, dc, i, d);
      }
    }
  }

  for (const c of counties) {
    delete c.riverShare;
    delete c.lakeShare;
    delete c.riverBorders;
    delete c.lakeBorders;
  }

  let withRiver = 0, withLake = 0, riverEdges = 0, lakeEdges = 0, dropped = 0;
  let oneSided = 0;
  for (const [key, [px, r, l, loSide, hiSide]] of edge) {
    // A contact shorter than MIN_BORDER_PX is a drawing artefact rather than a
    // frontier, and the game's own adjacency has already discarded it. A figure
    // recorded against a pair that cannot fight is dead weight in the file.
    if (px < minBorder) { dropped++; continue; }
    const a = Math.floor(key / span), b = key % span;
    const A = counties[a - 1], B = counties[b - 1];
    if (r) {
      riverEdges++;
      // Every pixel of this river sits inside ONE of the two counties, so a rule
      // reading only the defender's water would give this border a modifier in
      // one direction and nothing in the other. See the note above.
      if (!loSide !== !hiSide) oneSided++;
      (A.riverBorders ??= new Map()).set(B, r / px);
      (B.riverBorders ??= new Map()).set(A, r / px);
    }
    if (l) {
      lakeEdges++;
      (A.lakeBorders ??= new Map()).set(B, l / px);
      (B.lakeBorders ??= new Map()).set(A, l / px);
    }
  }

  for (let k = 0; k < n; k++) {
    const c = counties[k];
    const px = own[k + 1];
    if (!px) continue;
    if (river[k + 1]) { c.riverShare = river[k + 1] / px; withRiver++; }
    if (lake[k + 1]) { c.lakeShare = lake[k + 1] / px; withLake++; }
  }

  return {
    withRiver,
    withLake,
    borders: edge.size - dropped,
    riverEdges,
    lakeEdges,
    oneSided,
    dropped,
    withRiverBorder: counties.filter((c) => c.riverBorders).length,
    withLakeBorder: counties.filter((c) => c.lakeBorders).length,
  };
}

/**
 * counties.png read back, for the case where it has been edited by hand.
 *
 * Generation is a one-off. After it the bitmap is the authority, the same way
 * provinces.png and sea.png are: paint one county's colour over another and the
 * two merge, move a boundary and the areas follow. This reads whatever is there
 * now and works out what each county has become, so counties.json can be brought
 * back into line without regenerating and throwing the edits away.
 *
 * Everything but the id and the name is derived and is recomputed here. Which
 * province a county belongs to is read from provinces.png at the same pixels
 * rather than taken from the table, so the two files cannot drift apart.
 *
 * Returns one entry per colour found, in the order the colours first appear,
 * with `problems` listing anything an edit can break that this cannot fix.
 */
/**
 * Carries a river through a lake instead of stopping it at the shore.
 *
 * The water file draws a lake in white, the same white as the ocean, and a lake
 * small enough to sit inside a province is not a thing the province map knows
 * about at all — the ground there just belongs to the country around it. So a
 * river runs up to the shore, the lake is drawn as land, and the river appears
 * to stop in the middle of a field and start again a few pixels further on.
 *
 * This joins them up. Every arm of river reaching a lake is run to the lake's
 * CENTRE, which connects all of them to each other through one point rather than
 * pairing them off — a lake with three rivers on it is a junction, and guessing
 * which two of the three were meant to be the same river would be inventing
 * hydrology the map never stated.
 *
 * Only lakes with two or more separate arms are bridged. One arm means the river
 * ends in the lake, which is a real thing for a river to do, and drawing a stub
 * to the middle of it would say something the map did not.
 *
 * Nothing is ever painted outside the lake. A line from the shore to the centre
 * of a bent lake can leave the water, and a river drawn across dry ground would
 * be worse than one that stops short, so it is clipped and counted instead.
 */
export function bridgeLakeRivers({ riverAt, lakeAt, width, height }) {
  const n = width * height;
  const added = new Uint8Array(n);
  const seen = new Uint8Array(n);
  const stats = { lakes: 0, bridged: 0, oneArm: 0, arms: 0, painted: 0, unreachable: 0 };

  const around8 = (i, fn) => {
    const x = i % width, y = (i / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if ((!dx && !dy) || nx < 0 || nx >= width) continue;
        fn(ny * width + nx);
      }
    }
  };

  for (let s = 0; s < n; s++) {
    if (!lakeAt[s] || seen[s]) continue;

    // --- the lake
    const body = [];
    seen[s] = 1;
    const stack = [s];
    while (stack.length) {
      const i = stack.pop();
      body.push(i);
      around8(i, (j) => { if (lakeAt[j] && !seen[j]) { seen[j] = 1; stack.push(j); } });
    }
    stats.lakes++;

    // --- where rivers arrive, grouped so one river touching the shore along
    //     four pixels counts once rather than four times
    const mouth = body.filter((i) => {
      let touching = false;
      around8(i, (j) => { if (riverAt[j]) touching = true; });
      return touching;
    });
    if (!mouth.length) continue;

    const inMouth = new Set(mouth);
    const grouped = new Set();
    const arms = [];
    for (const m of mouth) {
      if (grouped.has(m)) continue;
      const group = [];
      grouped.add(m);
      const q = [m];
      while (q.length) {
        const i = q.pop();
        group.push(i);
        around8(i, (j) => { if (inMouth.has(j) && !grouped.has(j)) { grouped.add(j); q.push(j); } });
      }
      arms.push(group);
    }

    if (arms.length < 2) { stats.oneArm++; continue; }
    stats.bridged++;
    stats.arms += arms.length;

    // --- the centre, which has to be a pixel of the lake and not merely the
    //     average of one: the mean of a horseshoe is on the beach.
    const centre = nearestTo(body, mean(body, width), width);

    for (const arm of arms) {
      const from = nearestTo(arm, mean(arm, width), width);
      const line = through(from, centre, lakeAt, around8);
      if (!line) { stats.unreachable++; continue; }
      for (const i of line) {
        if (!added[i] && !riverAt[i]) { added[i] = 1; stats.painted++; }
      }
    }
  }
  return { added, stats };
}

const mean = (list, width) => {
  let sx = 0, sy = 0;
  for (const i of list) { sx += i % width; sy += (i / width) | 0; }
  return [sx / list.length, sy / list.length];
};

const nearestTo = (list, [mx, my], width) => {
  let best = list[0], bestD = Infinity;
  for (const i of list) {
    const dx = (i % width) - mx, dy = ((i / width) | 0) - my;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
};

/**
 * The shortest way from one pixel to another WITHOUT LEAVING THE WATER.
 *
 * A straight line was the obvious thing and it was wrong: these lakes are small
 * and bent, and a line from an inlet to the middle of one left the water for 64
 * of the 230 arms, better than a quarter of them. Those either had to be thrown
 * away, which leaves the river severed, or drawn anyway, which puts a river
 * across dry land.
 *
 * A breadth-first walk over the lake pixels has neither problem. The lake is one
 * eight-connected piece by construction, so a path always exists, and every
 * pixel of it is water by definition.
 */
function through(from, to, lakeAt, around8) {
  if (from === to) return [from];
  const parent = new Map([[from, -1]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (i === to) break;
    around8(i, (j) => {
      if (lakeAt[j] && !parent.has(j)) { parent.set(j, i); queue.push(j); }
    });
  }
  if (!parent.has(to)) return null;
  const out = [];
  for (let i = to; i !== -1; i = parent.get(i)) out.push(i);
  return out;
}

/** How often a town not already standing on a river is let across one anyway. */
export const URBAN_CROSS_SHARE = 0.8;

/**
 * Which counties a river is allowed to run straight through.
 *
 * Towns grow at crossings. A bridge is the reason the town is there at all, and
 * a river treated as a wall would cut one in half and give the far bank to
 * whatever county is over the water — which is the single place on the map where
 * a river is certainly not a border.
 *
 * A town the river ALREADY runs through is always let across: that is not a
 * judgement, it is the map saying the town sits on the water. The rest are let
 * across four times in five, so a river still reads as a boundary now and then
 * near a town that merely happens to be nearby.
 *
 * The four in five is decided by HASHING THE COUNTY ID, not by a random number.
 * Random would redraw a different map every run, and running the pass twice
 * would move boundaries that nobody had touched. The hash gives the same answer
 * for the same county for ever, and a different answer for the one next to it.
 *
 * "Already stands on a river" is `riverShare`, which is river pixels alone. It
 * used to be a flag written by the counties pass over the barrier field, and
 * that field counts inland lakes as river, so a town on a lake shore with no
 * river anywhere near it was being exempted from a barrier it never had. The
 * two now ask the same question of the same water.
 */
export function crossableCounties(counties, share = URBAN_CROSS_SHARE) {
  const out = new Set();
  let onRiver = 0, byHash = 0, held = 0;

  for (const c of counties) {
    if (!(c.terrain || []).includes(URBAN)) continue;
    if (c.riverShare) { out.add(c.colour); onRiver++; continue; }
    if (hash01(c.id) < share) { out.add(c.colour); byHash++; } else held++;
  }
  return { colours: out, onRiver, byHash, held };
}

/** FNV-1a, to a fraction in [0,1). Stable across runs and across machines. */
function hash01(id) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** How far a county boundary may be pulled to reach a river, in map pixels. */
export const RIVER_SNAP = 4;

/**
 * Pulls county boundaries that already run near a river onto it.
 *
 * The generator charges for crossing a river, which shifts where two growth
 * fronts meet — but only if they were going to meet nearby anyway. Measured
 * against the same rivers displaced sideways, that put about 15% of the network
 * on a boundary for a real distance and left the rest crossed at right angles
 * every few pixels. This closes the near misses without regenerating anything,
 * which matters because counties.png is hand-edited now and a regeneration
 * overwrites it.
 *
 * THE WHOLE TRICK IS THAT NOTHING IS DECIDED HERE. Every pixel further than
 * `snap` from a river keeps the county it has and becomes an ANCHOR. The band
 * within `snap` is cleared and regrown from those anchors by a flood that cannot
 * cross a river. A county whose anchors are on the far bank can no longer reach
 * over, so the two floods meet on the water and the boundary is on the river by
 * construction rather than by being moved there.
 *
 * It follows that a river running through the middle of a county changes
 * nothing: the anchors on both banks are the same county, so both banks regrow
 * as it and the river sits inside it, exactly as before.
 *
 * FOUR-CONNECTED, deliberately. A river drawn as a diagonal staircase is one
 * pixel wide and an eight-connected flood walks straight through the corners of
 * it. Four-connected cannot: to get from one side of a diagonal step to the
 * other it would have to enter one of the two river pixels making the step.
 */
export function snapToRivers({
  countyPx, provinceAt, riverAt, width, height,
  snap = RIVER_SNAP, margin = RIVER_MARGIN, crossable = new Set(),
}) {
  const n = width * height;
  const at = (x, y) => y * width + ((x % width) + width) % width;   // wraps east-west

  // --- which rivers are barriers
  //
  // Not the ones hard against a province edge. A county boundary landing on one
  // strands a ribbon of ground between the river and the border, which is the
  // same reason the generator ignores them; see RIVER_MARGIN.
  const barrier = new Uint8Array(n);
  let ignored = 0, crossed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!riverAt[i] || !provinceAt[i]) continue;

      // Towns straddle rivers. That is most of why towns are where they are, and
      // a barrier through one would cut the city in half and hand the far bank to
      // whatever is over there — the one place on the map where a river is
      // emphatically NOT a boundary. `crossable` is the set of county colours
      // allowed through; see crossableCounties.
      if (crossable.has(countyPx[i])) { crossed++; continue; }

      const mine = provinceAt[i];
      let clear = true;
      for (let dy = -margin; dy <= margin && clear; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) { clear = false; break; }
        for (let dx = -margin; dx <= margin; dx++) {
          if (provinceAt[at(x + dx, ny)] !== mine) { clear = false; break; }
        }
      }
      if (clear) barrier[i] = 1; else ignored++;
    }
  }

  // --- the band, four-connected out to `snap` from a barrier
  const band = new Uint8Array(n);
  let queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) if (barrier[i]) { band[i] = 1; queue[tail++] = i; }
  const barrierPx = tail;

  for (let step = 0; step < snap; step++) {
    const end = tail;
    while (head < end) {
      const i = queue[head++];
      const x = i % width, y = (i / width) | 0;
      const around = [at(x - 1, y), at(x + 1, y), y > 0 ? i - width : -1, y + 1 < height ? i + width : -1];
      for (const j of around) {
        if (j < 0 || band[j] || !provinceAt[j]) continue;
        band[j] = 1;
        queue[tail++] = j;
      }
    }
  }

  // --- anchors, and the counties that have none to spare
  //
  // A county lying entirely inside the band has nothing to regrow from and would
  // simply be eaten. Those are frozen: their pixels stay anchors and the flood
  // goes round them.
  const anchorsOf = new Map();
  const totalOf = new Map();
  for (let i = 0; i < n; i++) {
    if (!provinceAt[i]) continue;
    const c = countyPx[i];
    totalOf.set(c, (totalOf.get(c) || 0) + 1);
    if (!band[i]) anchorsOf.set(c, (anchorsOf.get(c) || 0) + 1);
  }
  const frozen = new Set();
  for (const [c, total] of totalOf) {
    const anchors = anchorsOf.get(c) || 0;
    if (anchors < Math.max(4, total * 0.15)) frozen.add(c);
  }

  // --- regrow the band
  const out = new Int32Array(countyPx);
  const fixed = new Uint8Array(n);
  head = 0; tail = 0;
  for (let i = 0; i < n; i++) {
    if (!provinceAt[i]) continue;
    if (!band[i] || frozen.has(countyPx[i])) { fixed[i] = 1; queue[tail++] = i; }
  }

  // The flood, which may not enter a barrier and may not leave its province.
  while (head < tail) {
    const i = queue[head++];
    const x = i % width, y = (i / width) | 0;
    const mine = provinceAt[i];
    const around = [at(x - 1, y), at(x + 1, y), y > 0 ? i - width : -1, y + 1 < height ? i + width : -1];
    for (const j of around) {
      if (j < 0 || fixed[j] || barrier[j] || provinceAt[j] !== mine) continue;
      fixed[j] = 1;
      out[j] = out[i];
      queue[tail++] = j;
    }
  }

  // The river itself has to belong to somebody. It goes to whichever bank
  // reached it first, which puts the boundary on the near edge of the water
  // rather than down the middle of it — the same side every time, so a boundary
  // does not wander from bank to bank along one river.
  head = 0; tail = 0;
  for (let i = 0; i < n; i++) if (fixed[i]) queue[tail++] = i;
  while (head < tail) {
    const i = queue[head++];
    const x = i % width, y = (i / width) | 0;
    const mine = provinceAt[i];
    const around = [at(x - 1, y), at(x + 1, y), y > 0 ? i - width : -1, y + 1 < height ? i + width : -1];
    for (const j of around) {
      if (j < 0 || fixed[j] || provinceAt[j] !== mine) continue;
      fixed[j] = 1;
      out[j] = out[i];
      queue[tail++] = j;
    }
  }

  // Anything the flood never reached keeps what it had. That is ground walled off
  // by rivers on every side with no anchor in it at all, and there is nothing
  // better to say about it than what was already there.
  let stranded = 0;
  for (let i = 0; i < n; i++) if (provinceAt[i] && !fixed[i]) { stranded++; out[i] = countyPx[i]; }

  // --- nothing may be broken in two
  //
  // A county pinched to a thread inside the band can come out as two pieces, and
  // a county in two pieces is a county the movement rules cannot reason about.
  // Rather than try to be clever, any county whose piece count went up is put
  // back exactly as it was.
  //
  // TO A FIXED POINT, because one revert can break another county. A county that
  // had gained ground from a reverted neighbour loses it again when the neighbour
  // takes it back, and if that ground was what joined two lobes of it, the revert
  // is what breaks it. Doing this once left 24 counties in more pieces than they
  // started in; the loop cannot, because reverting only ever moves pixels back
  // towards the original, the set of reverted counties only grows, and the
  // original is by definition unbroken.
  const before = pieceCount(countyPx, provinceAt, width, height);
  const broken = new Set();
  let rounds = 0;
  for (;;) {
    const after = pieceCount(out, provinceAt, width, height);
    const fresh = [];
    for (const [c, k] of after) if (k > (before.get(c) || 1) && !broken.has(c)) fresh.push(c);
    if (!fresh.length) break;
    rounds++;
    for (const c of fresh) broken.add(c);
    for (let i = 0; i < n; i++) {
      if (provinceAt[i] && (broken.has(out[i]) || broken.has(countyPx[i]))) out[i] = countyPx[i];
    }
  }

  let moved = 0;
  for (let i = 0; i < n; i++) if (out[i] !== countyPx[i]) moved++;

  return {
    countyPx: out,
    moved, stranded, barrierPx, ignored, crossed,
    frozen: frozen.size, broken: broken.size, rounds,
    bandPx: band.reduce((s, v) => s + v, 0),
  };
}

/** How many four-connected pieces each county is in. */
function pieceCount(px, provinceAt, width, height) {
  const n = width * height;
  const seen = new Uint8Array(n);
  const count = new Map();
  const stack = [];
  const at = (x, y) => y * width + ((x % width) + width) % width;

  for (let s = 0; s < n; s++) {
    if (seen[s] || !provinceAt[s]) continue;
    const c = px[s];
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      const x = i % width, y = (i / width) | 0;
      const around = [at(x - 1, y), at(x + 1, y), y > 0 ? i - width : -1, y + 1 < height ? i + width : -1];
      for (const j of around) {
        if (j < 0 || seen[j] || !provinceAt[j] || px[j] !== c) continue;
        seen[j] = 1; stack.push(j);
      }
    }
    count.set(c, (count.get(c) || 0) + 1);
  }
  return count;
}

export function readCounties({
  countyPx, provinceAt, width, height, oceanKey, atIndex,
  terrainAt, climateAt, cityAt, trueRatio, areaOfPixel, proj,
}) {
  const groups = new Map();
  for (let i = 0; i < countyPx.length; i++) {
    const v = countyPx[i];
    if (v === oceanKey) continue;
    let g = groups.get(v);
    if (!g) groups.set(v, g = { colour: v, pixels: [], provinces: new Map(), cities: 0 });
    g.pixels.push(i);
    const ix = provinceAt[i];
    g.provinces.set(ix, (g.provinces.get(ix) || 0) + 1);
    if (cityAt && cityAt[i]) g.cities++;
  }

  const out = [];
  const problems = { onSea: [], split: [], pieces: [], twoCities: [] };

  for (const g of groups.values()) {
    // Which province. A county that has been painted across a provincial border
    // belongs to neither, and nothing here can decide which half was meant, so it
    // takes the province holding most of it and the edit is reported.
    let province = 0, most = 0, total = 0;
    for (const [ix, n] of g.provinces) {
      total += n;
      if (n > most) { most = n; province = ix; }
    }
    const sea = g.provinces.get(0) || 0;
    if (sea) problems.onSea.push({ colour: g.colour, pixels: sea });
    if (g.provinces.size - (sea ? 1 : 0) > 1) {
      problems.split.push({ colour: g.colour, provinces: g.provinces.size - (sea ? 1 : 0), stray: total - most });
    }
    if (!province) continue;                      // wholly over open sea; nothing to keep

    const ratio = trueRatio[province] || 1;
    let area = 0;
    for (const i of g.pixels) area += areaOfPixel((i / width) | 0);
    area *= ratio;

    const urban = g.cities > 0;
    if (g.cities > 1) problems.twoCities.push({ colour: g.colour, cities: g.cities });

    // How many separate pieces it is in. One is the ordinary case; more than one
    // happens honestly, where a county absorbed an offshore speck, so this is
    // counted and reported rather than treated as an error.
    const parts = countPieces(g.pixels, countyPx, width, height);
    if (parts > 1) problems.pieces.push({ colour: g.colour, parts });

    out.push({
      colour: g.colour,
      province: atIndex[province],
      pixels: g.pixels,
      area,
      urban,
      pieces: parts,
      terrain: terrainName(modalOver(g.pixels, terrainAt, width, areaOfPixel, TERRAINS.length)),
      climate: climateName(modalOver(g.pixels, climateAt, width, areaOfPixel, CLIMATES.length)),
      centre: (() => {
        const c = centreOf(g.pixels, width, proj);
        return [Number(toDegrees(c.lat).toFixed(4)), Number(toDegrees(c.lon).toFixed(4))];
      })(),
    });
  }

  return { counties: out, problems };
}

/** Connected pieces of one colour, diagonals counting as joined. */
function countPieces(pixels, px, width, height) {
  const mine = new Set(pixels);
  const seen = new Set();
  let parts = 0;
  for (const seed of pixels) {
    if (seen.has(seed)) continue;
    parts++;
    const stack = [seed];
    seen.add(seed);
    while (stack.length) {
      const i = stack.pop();
      const y = (i / width) | 0, x = i - y * width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx < 0 ? width - 1 : x + dx >= width ? 0 : x + dx;
          const j = ny * width + nx;
          if (!mine.has(j) || seen.has(j)) continue;
          seen.add(j);
          stack.push(j);
        }
      }
    }
  }
  return parts;
}

/**
 * Alpine, carried down from the province rather than painted.
 *
 * A province tagged Alpine gives it to its mountain counties, which turns the
 * tag from a whole province into a wall with passes through it: the counties
 * that take it are the wall, and the mountain counties that do not are the
 * passes. A province with no mountain counties gives it to its highest terrain
 * instead, so the tag is never simply lost.
 *
 * Alpine REPLACES the landform rather than running beside it, the way Urban
 * does. It is the fourth tier, not a property of the third.
 */
export function applyAlpine(counties, provinceTags) {
  const byProvince = new Map();
  for (const c of counties) {
    if (!byProvince.has(c.province.id)) byProvince.set(c.province.id, []);
    byProvince.get(c.province.id).push(c);
  }

  let marked = 0, fellBack = 0;
  for (const [id, list] of byProvince) {
    if (!provinceTags(id)) continue;
    let target = list.filter((c) => c.terrain === 'Mountains' && !c.urban);
    if (!target.length) {
      // A city is never alpine, whatever the ground it stands on.
      const rank = { Mountains: 3, Hills: 2, Plains: 1 };
      const open = list.filter((c) => !c.urban);
      const top = Math.max(0, ...open.map((c) => rank[c.terrain] || 0));
      target = open.filter((c) => (rank[c.terrain] || 0) === top);
      fellBack++;
    }
    for (const c of target) c.terrain = ALPINE;
    marked += target.length;
  }
  return { marked, fellBack };
}

/**
 * A distinct colour per county for counties.png.
 *
 * Spread by a multiplicative hash rather than counted upward, so neighbouring
 * counties are far apart in colour and a mistake in the growth shows as a patch
 * of the wrong hue instead of hiding in a gradient. Collisions are stepped past,
 * and white and the sea colour are kept clear.
 */
export function countyColours(n, reserved = []) {
  const taken = new Set([0xffffff, ...reserved]);
  const out = new Int32Array(n + 1);
  for (let k = 1; k <= n; k++) {
    let v = Math.imul(k, 2654435761) >>> 8 & 0xffffff;
    while (taken.has(v)) v = (v + 0x9e3779) & 0xffffff;
    taken.add(v);
    out[k] = v;
  }
  return out;
}
