// County generator: divides provinces into counties at build time.

import { OCEAN, MIN_BORDER_PX, CHAMFER_ORTH, CHAMFER_DIAG, BORDER_DIST_MAX } from './mapdata.js';
import { makeProjection, distanceKm, toDegrees } from './geo.js';

// Pushes every item of one array onto another.
const appendAll = (into, from) => { for (const v of from) into.push(v); };

// ------------------------------------------------------------------ palettes

// Terrain map colours by landform.
export const TERRAIN_COLOURS = [
  ['Plains', 0x00ff0c, 'Plains'],
  ['Hills', 0x0004ff, 'Hills'],
  ['Mountains', 0xff0000, 'Mountains'],
];

// Köppen climate colours, grouped into the game's twelve.
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

// Colour distance within which a pixel matches a palette entry.
export const KOPPEN_TOLERANCE = 40;

export const TERRAINS = ['Plains', 'Hills', 'Mountains'];
export const CLIMATES = [
  'Rainforest', 'Monsoon', 'Savanna', 'Desert', 'Steppe', 'Mediterranean',
  'Humid subtropical', 'Oceanic', 'Humid continental', 'Subarctic', 'Tundra', 'Ice cap',
];
// Landform above Mountains, assigned per province by hand.
export const ALPINE = 'Alpine';

// ----------------------------------------------------------------- constants

// Kilometres a division covers in a day, by landform.
export const TERRAIN_SPEED = { Plains: 24, Hills: 16, Mountains: 8, Alpine: 3 };

// Urban tag, applied alongside the landform to city counties.
export const URBAN = 'Urban';
export const URBAN_SPEED = 0.5;    // what a built-up county does to the landform speed
export const URBAN_AREA = 1400;     // km2 a city county aims at, about 37 km across

// Roughness exponent applied while growing city counties.
export const URBAN_ROUGH = 2.6;

// Speed multiplier by climate.
export const CLIMATE_SPEED = {
  Rainforest: 0.42, Monsoon: 0.50, Savanna: 0.80, Desert: 0.85, Steppe: 0.95,
  Subarctic: 0.70, Tundra: 0.50, 'Ice cap': 0.50,
};

// Target county area in km², by climate.
export const CLIMATE_TARGET = {
  'Ice cap': 70000, Tundra: 52000, Subarctic: 26000, Desert: 12000, Steppe: 8000,
  Rainforest: 7000, Monsoon: 6500, Savanna: 6000,
};
export const DEFAULT_TARGET = 5000;

// Days a county may take to cross, for the cold climates.
export const CLIMATE_CROSS_DAYS = { 'Ice cap': 44, Tundra: 38, Subarctic: 28 };
export const MAX_CROSS_DAYS = 12;   // everywhere else
export const SPLIT_ROUNDS = 4;      // times a county may be re-split to meet the budget

export const crossDaysFor = (climateCode) =>
  CLIMATE_CROSS_DAYS[CLIMATES[climateCode - 1]] ?? MAX_CROSS_DAYS;
// Ceiling on counties per connected piece of land.
export const MAX_COUNTIES = 96;
// Speck thresholds for pieces of land.
export const MIN_PIECE_PX = 3;      // pixels, below which a piece is an artefact
export const MIN_PIECE = 30;        // km², the same for a piece of several thin ones
export const MIN_AREA = 800;        // km², below which a county merges into a neighbour

// Border share one neighbour may hold before a county counts as engulfed.
export const ENGULF_SHARE = 0.82;

// Length-to-width ratio past which a county is cut in two.
export const MAX_ELONGATION = 2.6;
export const SLIVER_ELONGATION = 3.4;   // past this a county is dissolved, not kept
export const SLIVER_MAX_PX = 800;       // pixel size up to which a sliver is dissolved

// Cost a boundary pays for not sitting on a river.
export const RIVER_COST = 14;

// Cost a seed pays for claiming more than its share.
export const BALANCE = 0.9;

// Strength of the roughness field in the step-cost exponent.
export const ROUGHNESS = 0.9;

// Noise octaves as [wavelength px, weight].
const OCTAVES = [[44, 0.12], [18, 0.24], [8, 0.31], [3, 0.33]];

// Roughness gain, scaled with county size.
export const ROUGH_GAIN = 1.53;

// How much BALANCE is relaxed where counties are large.
export const BALANCE_RELIEF = 0.45;

// Seed choice weighting between distance (1) and the field (0).
const SEED_BIAS = 0.45;

export const RIVER_MARGIN = 3;      // map pixels from a province edge inside which rivers are ignored

// Saturation point of the edge-distance field.
const DIST_MAX = BORDER_DIST_MAX;

// A stable value in 0..1 from a pair of lattice coordinates.
function hash2(x, y) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * (3 - 2 * t);

// Value noise on a lattice that wraps east to west.
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

// Bakes the signed roughness field for the whole map as bytes.
export function roughnessField(width, height) {
  const out = new Uint8Array(width * height);
  const octaves = OCTAVES.map(([px, weight]) => [Math.max(1, Math.round(width / px)), weight]);
  const total = octaves.reduce((s, o) => s + o[1], 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (const [cells, weight] of octaves) v += weight * valueNoise(x, y, cells, width);
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

// Days to walk across a county on its terrain and climate.
export const daysToCross = (county) =>
  Math.sqrt(county.area) / ((TERRAIN_SPEED[county.terrain] ?? TERRAIN_SPEED.Plains)
    * (CLIMATE_SPEED[county.climate] ?? 1) * (county.urban ? URBAN_SPEED : 1));

// Crossing-day budget for a county.
export const crossBudget = (county) =>
  CLIMATE_CROSS_DAYS[county.climate] ?? MAX_CROSS_DAYS;
export const climateName = (code) => CLIMATES[code - 1] || null;

// ------------------------------------------------------------ 1. the landscape

// Nearest palette entry to a colour, or null past the tolerance.
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

// Memoised colour-to-code lookup over a palette.
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

// Area-weighted terrain and climate shares per province.
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

// Every landscape covering more than `share` of a province, largest first.
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

// Share a landscape must cover to be dominant.
export const DOMINANT_SHARE = 0.40;

// Terrain and climate for every land pixel of the game map.
export function readLandscape({
  provinceAt, width, height, northRow,
  trueArea, terrain, climate, colourToIndex, oceanKey, provinceCount,
}) {
  const terrainOf = paletteLookup(TERRAIN_COLOURS, TERRAIN_CODE, (e) => e[2]);
  const climateOf = paletteLookup(KOPPEN, CLIMATE_CODE, (e) => e[2]);

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

// Distance of every land pixel from its province edge.
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

// Pixel indices grouped by province in flat arrays.
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

// Binary heap of (cost, pixel, seed) on growable typed arrays.
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

// Blur radius for the county-size target field.
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

// Blurs the per-pixel county-size target field.
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

// Ground length-to-width ratio of a set of pixels.
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

// Area-weighted modal code over a set of pixels.
function modalOver(pixels, codes, width, areaOfPixel, n) {
  const tally = new Float64Array(n + 1);
  for (const i of pixels) tally[codes[i]] += areaOfPixel((i / width) | 0);
  let best = 0, bestW = 0;
  for (let v = 1; v <= n; v++) if (tally[v] > bestW) { bestW = tally[v]; best = v; }
  return best;
}

// Centre of a set of pixels as lat/lon, kept on its own ground.
function centreOf(pixels, width, proj) {
  let vx = 0, vy = 0, vz = 0;
  for (const i of pixels) {
    const y = (i / width) | 0;
    const [a, b, c] = proj.toVector(i - y * width, y);
    vx += a; vy += b; vz += c;
  }
  const mean = proj.fromVector([vx, vy, vz]);

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

// Generates every county on the map, as countyAt and counties.
export function generateCounties({
  provinceAt, width, height, northRow, globeHeight, atIndex,
  // Rivers and inland lakes, as one array.
  terrainAt, climateAt, waterAt, edgeDist, trueRatio, cityAt = null, onProgress,
  maxCounties = MAX_COUNTIES,
}) {
  const proj = makeProjection({ width, height, globeHeight, northRow });
  const areaOfPixel = (y) => proj.areaOfPixel(y);

  const cosLat = new Float64Array(height);
  for (let y = 0; y < height; y++) cosLat[y] = Math.max(0.08, Math.cos(proj.latAt(y)));

  const targetAt = smoothTargets(terrainAt, climateAt, provinceAt, width, height);

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

  // Owner codes: NOT_IN outside the piece, FREE unreached, else a seed.
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

    // --- true areas, scaled by the province's enlargement
    const ratio = trueRatio[ix] || 1;

    // Fraction of a county one pixel's ground asks for.
    const demand = (i) => (areaOfPixel((i / width) | 0) * ratio) / targetAt[i];
    const measured = parts.map((part) => {
      let drawn = 0;
      for (const i of part) drawn += areaOfPixel((i / width) | 0);
      return { part, area: drawn * ratio };
    });

    const speck = (m) => m.part.length <= MIN_PIECE_PX || m.area < MIN_PIECE;
    let keep = measured.filter((m) => !speck(m));
    let drop = measured.filter(speck);
    if (!keep.length) { keep = measured; drop = []; }
    stats.absorbedPieces += drop.length;

    const madeHere = [];
    for (const { part, area } of keep) {
      let want = 0;
      for (const i of part) want += demand(i);
      want = Math.max(1, Math.round(want));

      let cities = 0;
      if (cityAt) for (const i of part) if (cityAt[i]) cities++;
      const n = Math.max(cities, Math.min(maxCounties, want));
      if (n < want) { stats.capped++; stats.cappedFrom += want - n; }
      stats.urbanSeeds += cities;

      if (counties.length + n > MAX_INDEX) {
        throw new Error(`more than ${MAX_INDEX} counties; countyAt cannot hold them. `
          + 'Raise the climate targets under CLIMATE_TARGET or widen the array.');
      }
      const perPixel = (areaOfPixel((part[0] / width) | 0)) * ratio;
      const urbanPixels = Math.round(URBAN_AREA / Math.max(perPixel, 1e-9));

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

      // Re-split counties over their crossing budget.
      for (let round = 0; round < SPLIT_ROUNDS; round++) {
        const slow = [];
        for (const c of made) {
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

    // --- specks, each to the nearest county of the same province
    if (drop.length) {
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

    for (const i of pixels) if (!countyAt[i]) stats.uncovered++;

    if (onProgress) onProgress(ix, provinceCount, counties.length);
  }

  return { countyAt, counties, stats, proj, areaOfPixel, cosLat };
}

// Divides one piece of land into `n` counties, cities first.
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

  // Multi-source BFS recording distance to the nearest seed.
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

  // Drains the heap with the cost field raised to roughPow.
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

  // --- anything still unclaimed, regrown with limits lifted
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

// Merges counties below MIN_AREA, then tags the rest.
export function finishCounties({
  countyAt, counties, width, height, terrainAt, climateAt, areaOfPixel, proj, cosLat,
}) {
  const byIndex = new Map(counties.map((c) => [c.index, c]));

  // --- adjacency and shared border length
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

  // --- merge, smallest first
  const merged = new Map();                  // index -> the index it became
  const resolve = (i) => { while (merged.has(i)) i = merged.get(i); return i; };
  let mergeCount = 0;

  // Shared border between two counties, and one county's whole border.
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
  let dissolved = 0;
  for (const c of counties) {
    if (merged.has(c.index) || c.urban) continue;
    if (c.pixels.length < 12 || c.pixels.length > SLIVER_MAX_PX) continue;
    if (elongation(c.pixels, width, cosLat) <= SLIVER_ELONGATION) continue;

    const hosts = [];
    for (const [t] of neighboursOf(c)) if (t.province === c.province) hosts.push(t);
    if (hosts.length < 2) continue;

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

// River and lake shares per county and per border.
export function measureWater({
  counties, riverAt, lakeAt, width, height, minBorder = MIN_BORDER_PX,
}) {
  const n = counties.length;

  const at = n < 65535 ? new Uint16Array(width * height) : new Int32Array(width * height);
  for (let k = 0; k < n; k++) {
    for (const i of counties[k].pixels) at[i] = k + 1;
  }

  const own = new Int32Array(n + 1);
  const river = new Int32Array(n + 1);
  const lake = new Int32Array(n + 1);

  const edge = new Map();
  const span = n + 1;

  // Tallies border pixels, river, lake and river side per pair.
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
    if (px < minBorder) { dropped++; continue; }
    const a = Math.floor(key / span), b = key % span;
    const A = counties[a - 1], B = counties[b - 1];
    if (r) {
      riverEdges++;
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

// Carries rivers across the lakes they meet.
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

    // --- where rivers arrive, grouped per river
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

    // --- the centre, a pixel inside the lake
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

// Shortest path between two pixels that stays in the water.
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

// Share of off-river towns allowed a river crossing.
export const URBAN_CROSS_SHARE = 0.8;

// Counties a river may run straight through.
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

// FNV-1a hash of an id to a fraction in [0,1).
function hash01(id) {
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Furthest a county boundary may be pulled to reach a river, in map pixels.
export const RIVER_SNAP = 4;

// Pulls county boundaries near a river onto it.
export function snapToRivers({
  countyPx, provinceAt, riverAt, width, height,
  snap = RIVER_SNAP, margin = RIVER_MARGIN, crossable = new Set(),
}) {
  const n = width * height;
  const at = (x, y) => y * width + ((x % width) + width) % width;   // wraps east-west

  // --- which rivers are barriers
  const barrier = new Uint8Array(n);
  let ignored = 0, crossed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!riverAt[i] || !provinceAt[i]) continue;

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

  // --- anchors, and counties with none to spare
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

  // River pixels go to whichever bank reached them first.
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

  let stranded = 0;
  for (let i = 0; i < n; i++) if (provinceAt[i] && !fixed[i]) { stranded++; out[i] = countyPx[i]; }

  // --- nothing may be broken in two
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

// How many four-connected pieces each county is in.
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

// Connected pieces of one colour, diagonals counting as joined.
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

// Gives a province's Alpine tag to its mountain counties.
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

// A distinct hashed colour per county for the county map.
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
