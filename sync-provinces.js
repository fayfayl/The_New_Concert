/*
 * sync-provinces.js — reconcile data/json/provinces.json with data/img/provinces.png.
 *
 * Run:  node sync-provinces.js             report only, writes nothing
 *       node sync-provinces.js --write     apply the changes
 *       node sync-provinces.js --reslug    regenerate ids from names, provinces and cities alike
 *       node sync-provinces.js --prune     delete entries no longer in the bitmap
 *       node sync-provinces.js --rivers    redraw data/img/rivers.png for the map layer
 *       node sync-provinces.js --snap-rivers  pull county boundaries onto nearby rivers
 *       node sync-provinces.js --regen-sea-subs  draw the sea subregions from nothing
 *       node sync-provinces.js --sea-subs   read a hand-edited sea_subregions.png back
 *
 * Ids are slugs of the province name ("Rodtfjell" -> "rodtfjell"). They are
 * preserved once assigned, so renaming a province does not silently break
 * anything pointing at it. --reslug regenerates them from the current names.
 *
 * Reads every colour present in the bitmap and makes the JSON match it:
 *   - colours already in the JSON keep their id, name, terrain and owner
 *   - colours new to the bitmap are added with placeholder values
 *   - entries whose colour is no longer in the bitmap are reported as stale
 *     and KEPT, unless you pass --prune
 *
 * It also writes each province's true surface area in km2 and the latitude and
 * longitude of its centre. Those two are DERIVED and rewritten every run, so
 * editing them by hand achieves nothing. They are measured from
 * data/img/true_area.png; without that file they are left alone.
 * See src/geo.js for why a pixel count is not an area.
 *
 * Because it matches on colour, you can redraw the map as often as you like
 * and any names and owners you have already filled in survive.
 *
 * It also prints a short survey of the map: which provinces are made of several
 * disconnected pieces (island chains and exclaves) and which are smallest.
 * Both are normal. Pass --min-size=N if you want to actively hunt for stray
 * pixels; nothing below N is then listed as a warning.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

// The scans below are the renderer's own, imported rather than reimplemented —
// see the note at the top of src/mapdata.js for why that matters.
import {
  normaliseTable, buildWorld, buildBorderDistance, computeLabelGeometry, MIN_BORDER_PX,
  normaliseSeaTable, buildSeaWorld, normaliseCountyTable, buildCountyWorld,
  normaliseSubTable, buildSubWorld,
} from './src/mapdata.js';
import { CACHE_FILE, hashInputs, buildCacheMeta, packCache, buildSubMeta } from './src/mapcache.js';
import { mergeStats, splitStats } from './src/provincestats.js';
import { makeProjection, toDegrees, MAP_NORTH_ROW, MAP_GLOBE_HEIGHT, mapLatAt, mapLonAt } from './src/geo.js';
import {
  depthByRegion, readDepth, subregionCount, cutStraight, mendPieces,
  dissolveTiny, agglomerate, pinchOff, hashSeed, xorshiftFor, OVERSEGMENT, isShallow,
  DEPTH_BANDS, MAX_SUBREGIONS, MIN_PIECE_PX, TARGET_AREA,
} from './src/subregions.js';
import {
  readLandscape, provinceEdgeDistance, generateCounties, finishCounties,
  applyAlpine, countyColours, daysToCross, crossBudget, readCounties, URBAN,
  ALPINE, MIN_AREA, MAX_COUNTIES,
  landscapeShares, dominantIn, DOMINANT_SHARE, TERRAINS, CLIMATES,
  snapToRivers, RIVER_SNAP, crossableCounties, URBAN_CROSS_SHARE,
  bridgeLakeRivers, measureWater,
} from './src/counties.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WRITE = process.argv.includes('--write');
const RESLUG = process.argv.includes('--reslug');
const PRUNE = process.argv.includes('--prune');
const CACHE = process.argv.includes('--cache');
const CITIES = process.argv.includes('--cities');
const SEA = process.argv.includes('--sea');
const RIVERS = process.argv.includes('--rivers');
const SNAP = process.argv.includes('--snap-rivers');
const SUBS_REGEN = process.argv.includes('--regen-sea-subs');
const SUBS = SUBS_REGEN || process.argv.includes('--sea-subs');
// --counties reads counties.png and brings counties.json into line with it, the
// way --sea does for the sea. --regen-counties throws the bitmap away and draws
// a new one, which is a one-off and discards anything edited by hand since.
const REGEN = process.argv.includes('--regen-counties');
const COUNTIES = REGEN || process.argv.includes('--counties');
// The ceiling on counties per piece of land, for trying a different one without
// editing the module. See the note on MAX_COUNTIES in src/counties.js.
const MAX_PER_PIECE = Number((process.argv.find((a) => a.startsWith('--max-counties=')) || '').split('=')[1]) || 0;
// --landscape reports what each province is made of as percentages of its true
// ground, which is what the terrain and climate tags are a reduction of. An
// owner id after it narrows the report to that country. Null when not asked for,
// so an empty string can still mean "every province".
const LANDSCAPE = (() => {
  const arg = process.argv.find((a) => a === '--landscape' || a.startsWith('--landscape='));
  return arg === undefined ? null : (arg.split('=')[1] || '');
})();
// data/ is sorted by KIND rather than by subject: bitmaps under img/, tables
// under json/. So the two files describing provinces live apart, which is the
// point — provinces.png and provinces.json are the two sources of truth this
// script exists to reconcile, and they are edited with completely different
// tools.
//
// The cache is the exception and sits at the root of data/, because it belongs
// to neither: it is derived from both and is written by this script rather than
// authored. main.js fetches it from there as `./data/${CACHE_FILE}`, so the two
// have to agree about that.
const DIR = path.join(__dirname, 'data');
const IMG = path.join(DIR, 'img');
const TABLES = path.join(DIR, 'json');

const PNG = path.join(IMG, 'provinces.png');
const JSON_PATH = path.join(TABLES, 'provinces.json');
const CACHE_PATH = path.join(DIR, CACHE_FILE);
const CITIES_PNG = path.join(IMG, 'cities.png');
const SEA_PNG = path.join(IMG, 'sea.png');
const SEA_GLOBE = path.join(IMG, 'sea_true_area.png');
const SEA_JSON = path.join(TABLES, 'sea.json');
const SEA_ELEVATION = path.join(IMG, 'sea_elevation.png');
const SUBS_PNG = path.join(IMG, 'sea_subregions.png');
const TERRAIN_PNG = path.join(IMG, 'terrain.png');
const CLIMATE_PNG = path.join(IMG, 'climate.png');
const RIVERS_PNG = path.join(IMG, 'true_water_bodies_and_rivers.png');
const RIVER_LAYER_PNG = path.join(IMG, 'rivers.png');
const COUNTIES_PNG = path.join(IMG, 'counties.png');
const COUNTIES_JSON = path.join(TABLES, 'counties.json');
// The buildings a county can hold, which this file must know about twice over:
// once to carry them across a counties.png read-back and once to write them out
// again. The writer builds each county from a named field list, so a building
// missing from here is silently demolished by a --counties --write however
// carefully the read preserved it. Kept in step with BUILDINGS in
// src/provincestats.js, which this cannot import.
const BUILDING_KINDS = ['eyrie', 'dockyard', 'syntheticOil', 'syntheticRubber'];
// Polities live in their own file: they are a list of countries, not a fact about
// any province, and keeping them here means a resync of the bitmap cannot touch them.
const POLITIES_JSON = path.join(TABLES, 'polities.json');
const readPolities = () => (fs.existsSync(POLITIES_JSON)
  ? JSON.parse(fs.readFileSync(POLITIES_JSON, 'utf8')).polities
  : [{ id: 'NONE', name: 'Unclaimed', colour: '#5a5a60' }]);
const CITIES_JSON = path.join(TABLES, 'cities.json');
const STATS_JSON = path.join(TABLES, 'province-stats.json');
// What a game starts with, kept apart from what the map fixes. See src/provincestats.js.
const START_INFRA_JSON = path.join(TABLES, 'provinces-starting-infrastructure.json');
const START_ATTITUDE_JSON = path.join(TABLES, 'provinces-starting-attitude.json');
const readJSONIf = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
// The whole world on a 2:1 globe, poles included. Areas are measured from this
// rather than from provinces.png — see the note at the top of src/geo.js.
const GLOBE_PNG = path.join(IMG, 'true_area.png');

// A city mark is one pixel. Black is a capital, mid-grey an ordinary city.
const CITY_MARKS = { 0x000000: 'capital', 0x6b6b6b: 'city' };

// How far a mark may move between runs and still be recognised as the same
// city. Nudging a pixel a little should not lose the name you gave it, but two
// genuinely different cities are never this close.
const CITY_MOVE_TOLERANCE = 10;

// Opt-in speck hunt: --min-size=8 warns about anything under 8 px.
// Off by default, because a small island is a legitimate province.
const MIN_SIZE = Number((process.argv.find((a) => a.startsWith('--min-size=')) || '').split('=')[1]) || 0;

// ------------------------------------------------------------ PNG decoding
// Supports bit depth 8, colour types 0/2/3/4/6, non-interlaced. That covers
// anything a normal paint program will save.

function decodePNG(file) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');

  let pos = 8, w = 0, h = 0, depth = 8, ctype = 2, plte = null, trns = null, interlace = 0;
  const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG not supported — save without interlacing');
  if (depth !== 8 && ctype !== 3) {
    throw new Error(`bit depth ${depth} on a non-palette PNG not supported — save as 8 bits per channel`);
  }
  if (![1, 2, 4, 8].includes(depth)) throw new Error(`bit depth ${depth} not supported`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];

  // A palette PNG may pack two, four or eight pixels into a byte, and an editor
  // saving a map of six colours will do exactly that. Filtering works on BYTES
  // whatever the depth, so the two have to be kept apart: `stride` is the
  // filtered row in bytes, and the pixels are unpacked out of it afterwards.
  const stride = Math.ceil((w * channels * depth) / 8);
  const step = Math.max(1, (channels * depth) >> 3);   // bytes between neighbouring pixels
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const flat = Buffer.alloc(h * stride);

  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= step ? flat[y * stride + x - step] : 0;
      const up = y > 0 ? flat[(y - 1) * stride + x] : 0;
      const ul = (x >= step && y > 0) ? flat[(y - 1) * stride + x - step] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - ul;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : ul);
      }
      flat[y * stride + x] = v & 255;
    }
  }

  // Unpack a sub-byte palette into one index per byte, so everything below
  // reads the same shape whatever the file was saved at.
  const index = depth === 8 ? flat : Buffer.alloc(h * w);
  if (depth !== 8) {
    const mask = (1 << depth) - 1;
    const per = 8 / depth;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const byte = flat[y * stride + ((x / per) | 0)];
        const shift = 8 - depth - (x % per) * depth;
        index[y * w + x] = (byte >> shift) & mask;
      }
    }
  }

  // One packed 0xRRGGBB integer per pixel, plus its opacity.
  //
  // Alpha is not decoration here. A palette PNG can hold the same colour twice,
  // once opaque and once transparent — cities.png does exactly that, with black
  // as both "capital" and "background". Read without tRNS, every background
  // pixel on the map would come back as a capital.
  const px = new Int32Array(w * h);
  const alpha = new Uint8Array(w * h).fill(255);
  for (let i = 0; i < w * h; i++) {
    let r, g, bl;
    if (ctype === 3) {
      const k = index[i];
      r = plte[k * 3]; g = plte[k * 3 + 1]; bl = plte[k * 3 + 2];
      if (trns && k < trns.length) alpha[i] = trns[k];
    } else if (ctype === 2) { r = flat[i * 3]; g = flat[i * 3 + 1]; bl = flat[i * 3 + 2]; }
    else if (ctype === 6) { r = flat[i * 4]; g = flat[i * 4 + 1]; bl = flat[i * 4 + 2]; alpha[i] = flat[i * 4 + 3]; }
    else if (ctype === 0) { r = g = bl = flat[i]; }
    else { r = g = bl = flat[i * 2]; alpha[i] = flat[i * 2 + 1]; }
    px[i] = (r << 16) | (g << 8) | bl;
  }
  return { width: w, height: h, px, alpha };
}

/**
 * Truecolour 8-bit PNG out of one packed colour per pixel.
 *
 * Rows are Sub-filtered, which turns a run of one colour into a run of zeros
 * and is what makes a map of flat regions compress at all.
 *
 * `alphaAt` makes it RGBA. Without it the file is opaque truecolour, which is
 * what counties.png is. With it the file is mostly nothing — rivers.png is a
 * whole map of transparency with a few thousand blue pixels threaded through it,
 * and Sub-filtering a run of transparent pixels gives a run of zeros, so the
 * fourth channel costs almost nothing once deflated.
 */
function encodePNG(width, height, px, alphaAt = null) {
  const ch = alphaAt ? 4 : 3;
  const stride = width * ch;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + stride);
    raw[at] = 1;                                   // Sub
    let pr = 0, pg = 0, pb = 0, pa = 0;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const v = px[i];
      const r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      const o = at + 1 + x * ch;
      raw[o] = (r - pr) & 255; raw[o + 1] = (g - pg) & 255; raw[o + 2] = (b - pb) & 255;
      pr = r; pg = g; pb = b;
      if (alphaAt) {
        const a = alphaAt(i);
        raw[o + 3] = (a - pa) & 255;
        pa = a;
      }
    }
  }

  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  const crc = (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = alphaAt ? 6 : 2;           // 8-bit, truecolour, with alpha or without
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ helpers

const hex = (k) => '#' + (k >>> 0).toString(16).padStart(6, '0');
const parseHex = (s) => parseInt(String(s).replace(/^#/, ''), 16);

/**
 * Writes JSON indented, but with arrays and objects of plain values kept on one
 * line.
 *
 * JSON.stringify's indenting is right about nested structure and wrong about
 * these: a pair like [0, 0] becomes four lines, and a file of them is unreadable
 * and unscrollable for no gain. Only arrays and objects holding nothing but
 * scalars are collapsed, and only while they stay short, so a long list still
 * breaks.
 *
 * The object rule earns its place on the county borders. A county names the
 * share of each border it shares with a neighbour that is river, which is a
 * handful of keys, and expanded that is five lines apiece across fourteen
 * thousand counties — seventy thousand lines of a file already three and a half
 * megabytes. It cannot swallow a county row, because those hold arrays and the
 * pattern refuses anything with a bracket in it.
 *
 * Done to the text rather than by hand-rolling a serialiser, which means it
 * could in principle mangle a string containing a bracket or a brace — so the
 * result is parsed back and compared against what went in, and anything that
 * does not survive that is written the ordinary way instead. The check costs a
 * millisecond and removes the entire class of worry.
 */
function writeJSON(file, value) {
  const plain = JSON.stringify(value, null, 2);

  const collapse = (open, close) => (whole, inner) => {
    if (!inner.trim()) return `${open}${close}`;
    const flat = inner.split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
    return flat.length <= 72 ? `${open}${flat}${close}` : whole;
  };

  // Both patterns refuse anything holding a bracket or a brace, so neither can
  // reach a structure with structure inside it and the order of the two does not
  // matter. A county row holds `terrain` and `centre` and is therefore never a
  // candidate however short it is, which is what keeps the file readable.
  const packed = plain
    .replace(/\{\s*([^[\]{}]*?)\s*\}/g, collapse('{', '}'))
    .replace(/\[\s*([^[\]{}]*?)\s*\]/g, collapse('[', ']'));

  let text = plain;
  try {
    if (JSON.stringify(JSON.parse(packed)) === JSON.stringify(value)) text = packed;
  } catch { /* fall through to the plain form */ }

  fs.writeFileSync(file, text + '\n');
}

/** Connected components per colour, 4-way. */
function analyse(width, height, px, oceanKey) {
  const seen = new Uint8Array(width * height);
  const blobs = new Map();
  const stack = new Int32Array(width * height);

  for (let start = 0; start < width * height; start++) {
    if (seen[start]) continue;
    const k = px[start];
    seen[start] = 1;
    if (k === oceanKey) continue;

    let sp = 0; stack[sp++] = start;
    let n = 0, sx = 0, sy = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % width, y = (p - x) / width;
      n++; sx += x; sy += y;
      if (x > 0 && !seen[p - 1] && px[p - 1] === k) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < width - 1 && !seen[p + 1] && px[p + 1] === k) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && !seen[p - width] && px[p - width] === k) { seen[p - width] = 1; stack[sp++] = p - width; }
      if (y < height - 1 && !seen[p + width] && px[p + width] === k) { seen[p + width] = 1; stack[sp++] = p + width; }
    }
    if (!blobs.has(k)) blobs.set(k, []);
    blobs.get(k).push({ n, cx: Math.round(sx / n), cy: Math.round(sy / n) });
  }
  for (const list of blobs.values()) list.sort((a, b) => b.n - a.n);
  return blobs;
}

/**
 * True surface area of each province, and where its centre lies on the globe.
 *
 * Areas are summed a row at a time, since every pixel in a row is worth the
 * same and pixels in different rows are not. The centre is the average of each
 * pixel's position as a VECTOR on the sphere, weighted by that pixel's area,
 * which puts it where the province's mass actually is and survives a province
 * straddling the map's east–west seam.
 */
function measure(width, height, px, oceanKey, projection) {
  const out = new Map();
  for (let y = 0; y < height; y++) {
    const a = projection.areaOfPixel(y);
    for (let x = 0; x < width; x++) {
      const k = px[y * width + x];
      if (k === oceanKey) continue;
      let m = out.get(k);
      // The first pixel seen is kept so that a colour nobody recognises can be
      // reported with somewhere to go and look at it.
      if (!m) { m = { area: 0, n: 0, vx: 0, vy: 0, vz: 0, atX: x, atY: y }; out.set(k, m); }
      const [ux, uy, uz] = projection.toVector(x, y);
      m.area += a;
      m.n++;
      m.vx += ux * a; m.vy += uy * a; m.vz += uz * a;
    }
  }
  for (const m of out.values()) {
    const { lat, lon } = projection.fromVector([m.vx, m.vy, m.vz]);
    m.lat = toDegrees(lat);
    m.lon = toDegrees(lon);
  }
  return out;
}

/**
 * Count shared borders, the same way the game does at load — including the
 * MIN_BORDER_PX rule, or this figure would describe a map the game does not
 * agree it has. Contacts too short to count are reported separately, since a
 * lot of them means the bitmap is drawn more finely than it can carry.
 */
function countBorders(width, height, px, oceanKey) {
  const touch = new Map();
  const coastal = new Set();
  const add = (a, b) => {
    if (a === b) return;
    if (a === oceanKey || b === oceanKey) {
      if (a !== oceanKey) coastal.add(a);
      if (b !== oceanKey) coastal.add(b);
      return;
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    touch.set(key, (touch.get(key) || 0) + 1);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      // Wraps east-west, as the renderer's own scan does — the count would
      // otherwise disagree with the adjacency the game actually uses.
      add(px[i], px[x + 1 < width ? i + 1 : y * width]);
      if (y + 1 < height) add(px[i], px[i + width]);
    }
  }
  // Who has a land neighbour at all. The pairs were being counted and thrown
  // away, and this is the whole of what makes a province an island: a body of
  // land surrounded by water is one that touches no other province by land.
  let borders = 0, tooShort = [];
  const neighboured = new Set();
  for (const [key, n] of touch) {
    if (n < MIN_BORDER_PX) { tooShort.push(key); continue; }
    borders++;
    const [a, b] = key.split('|');
    neighboured.add(Number(a)); neighboured.add(Number(b));
  }
  return { borders, coastal, tooShort, neighboured };
}

// --------------------------------------------------------------------- run

const img = decodePNG(PNG);
const old = fs.existsSync(JSON_PATH) ? JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')) : {};

// tally colours
const counts = new Map();
for (let i = 0; i < img.px.length; i++) counts.set(img.px[i], (counts.get(img.px[i]) || 0) + 1);

// decide which colour is ocean: the one named in the JSON if it is actually
// present, otherwise the most common colour in the image.
let oceanKey = old.oceanColour ? parseHex(old.oceanColour) : NaN;
let oceanChanged = false;
if (!counts.has(oceanKey)) {
  oceanKey = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  oceanChanged = true;
}

const blobs = analyse(img.width, img.height, img.px, oceanKey);
const { borders, coastal, tooShort, neighboured } = countBorders(img.width, img.height, img.px, oceanKey);

// ------------------------------------------------------ area on the globe
//
// Without true_area.png there is nothing whose rows are latitudes, and an area
// figure would be a guess. Areas are then left exactly as they are in the JSON
// rather than being written wrong.
let projection = null, measured = null, globeImg = null;

// Colours drawn in provinces.png that true_area.png has never heard of, kept
// so the report below can NAME them. Their area and centre are whatever was
// last written, which is the one case where those fields go quietly stale.
let unmeasured = [];

// A list rather than one string. Two of the notes below can be produced by the
// same run — colours in the globe that the table does not know, and provinces
// in the table that the globe does not draw — and holding one slot meant the
// second silently overwrote the first.
const globeNotes = [];

if (!fs.existsSync(GLOBE_PNG)) {
  globeNotes.push('true_area.png missing — areas left untouched');
} else {
  const globe = decodePNG(GLOBE_PNG);

  // A whole globe, so 360 degrees across and 180 down: twice as wide as it is
  // tall, or the rows do not carry the latitudes this assumes.
  if (globe.width !== globe.height * 2) {
    globeNotes.push(`true_area.png is ${globe.width}x${globe.height}, which is not the 2:1 of a whole globe`);
  } else {
    // Measured from true_area.png ITSELF, not from provinces.png placed inside
    // it. The two hold the same provinces in the same colours, but only this one
    // is the whole world: provinces.png is cut off short of both poles, so land
    // in the polar caps exists here and nowhere else. Nothing needs lining up
    // either — row 0 is the north pole and the last row is the south, so a row
    // is a latitude directly.
    //
    // Shapes, adjacency and everything drawn still come from provinces.png.
    // This file answers one question, which is how much ground each province
    // actually covers.
    projection = makeProjection({
      width: globe.width,
      height: globe.height,
      globeHeight: globe.height,
    });
    globeImg = globe;
    measured = measure(globe.width, globe.height, globe.px, oceanKey, projection);

    // Colours here that the table has never heard of. A handful is the usual
    // residue of exporting, and they are simply not counted; a lot of them means
    // the export resampled and blended province colours together, which would
    // make every area near a border slightly wrong.
    const strayColours = [];
    for (const [k, m] of measured) {
      if (blobs.has(k)) continue;
      strayColours.push({ k, n: m.n, atX: m.atX, atY: m.atY });
      measured.delete(k);
    }
    if (strayColours.length) {
      // Named, and with somewhere to look. "A colour does not match" is not
      // something anyone can act on; a hex and a pixel to jump to is.
      strayColours.sort((a, b) => b.n - a.n);
      const shown = strayColours.slice(0, 5)
        .map((s) => `${hex(s.k)} ${s.n}px at ${s.atX},${s.atY}`).join('; ');
      globeNotes.push(`unrecognised colours in true_area.png, not counted — ${shown}`
        + `${strayColours.length > 5 ? `; and ${strayColours.length - 5} more` : ''}`);
    }

    // Listed by name further down, once the table has been reconciled and there
    // are ids to print. Only the count belongs up here with the totals.
    unmeasured = [...blobs.keys()].filter((k) => !measured.has(k));
    if (unmeasured.length) {
      globeNotes.push(`${unmeasured.length} province${unmeasured.length > 1 ? 's' : ''} in provinces.png`
        + ' have no pixels in true_area.png and keep their previous area');
    }
  }
}

// reconcile against the existing table
const oldByColour = new Map((old.provinces || []).map((p) => [parseHex(p.colour), p]));

// Output order: everything already in the file keeps its position, then new
// provinces are appended at the end. Rewriting the file in map order would
// reshuffle entries you are part-way through editing and make diffs useless.
const inBitmap = new Set(blobs.keys());
const present = (old.provinces || [])
  .map((p) => parseHex(p.colour))
  .filter((k) => inBitmap.has(k));

const known = new Set(present);
const fresh = [...blobs.keys()]
  .filter((k) => !known.has(k))
  .sort((a, b) => {                     // new ones only, roughly N-S then W-E
    const A = blobs.get(a)[0], B = blobs.get(b)[0];
    return A.cy - B.cy || A.cx - B.cx;
  });
present.push(...fresh);

/**
 * Letters that NFD cannot help with.
 *
 * An accent is a combining mark: NFD splits it off the base letter and the
 * regex below strips it, so "é" reliably becomes "e". A stroke or a bar is not
 * a mark — it is part of the glyph, and the character has no decomposition at
 * all. So "ł" survives NFD intact, falls through to the [^a-z0-9] rule, and
 * turns into an underscore, quietly dropping a letter out of the id.
 *
 * These have to be listed by hand. Only the lower case is needed, since the
 * lookup happens after toLowerCase().
 */
const TRANSLITERATE = {
  ł: 'l', ø: 'o', đ: 'd', ð: 'd', ħ: 'h', ŧ: 't', ı: 'i', ĸ: 'k',
  æ: 'ae', œ: 'oe', ß: 'ss', þ: 'th', ŋ: 'ng',
};

/** "Rødt Fjell" -> "rodt_fjell". Ids are slugs so events can name provinces. */
function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip combining accents
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, (ch) => TRANSLITERATE[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'province';
}

const taken = new Set();
function uniqueId(base) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

// Existing ids are claimed first so that nothing already in use gets stolen.
if (!RESLUG) for (const p of old.provinces || []) if (blobs.has(parseHex(p.colour))) taken.add(String(p.id));

// Placeholder names must be the next number NOT already in use, not the
// province's position in the map — otherwise inserting a province renames
// nothing but collides with whatever already held that number.
const usedNames = new Set((old.provinces || []).map((p) => String(p.name)));
let nameSeq = 0;
function nextName() {
  let n;
  do { n = `Unnamed ${String(++nameSeq).padStart(2, '0')}`; } while (usedNames.has(n));
  usedNames.add(n);
  return n;
}

const added = [], kept = [], reslugged = [];
const provinces = present.map((k) => {
  const prev = oldByColour.get(k);
  if (prev) {
    const id = RESLUG ? uniqueId(slugify(prev.name)) : String(prev.id);
    if (RESLUG && id !== String(prev.id)) reslugged.push({ from: prev.id, to: id });
    kept.push(prev);
    return { ...prev, id, colour: hex(k) };
  }
  const name = nextName();
  const p = {
    id: uniqueId(slugify(name)),
    name,
    colour: hex(k),
    terrain: ['Plains'],
    owner: 'NONE',
  };
  added.push(p);
  return p;
});

// Area and centre are DERIVED, so they are rewritten from the bitmap every run
// rather than carried over like names and owners. Editing them by hand would
// only be undone. Rounded because the last digits are noise from the drawing:
// a province's outline is worth a pixel or two either way, which at this scale
// is tens of square kilometres.
// A province too small for the drawing to resolve keeps the area it was given.
// Below roughly a hundred pixels the outline is a large share of the whole shape,
// so the measurement is noise around the truth rather than the truth: at ~30 px
// the error runs to a quarter of the figure. Worse, it is not centred, since a
// feature narrower than a pixel gets fattened to stay visible at all, which
// biases small shapes HIGH — the map had El Puerto at 2.2x and Weilian at 2.0x
// their real size. Those provinces take the equal-area figures from the country
// masterlist, which has no such floor, and carry areaFixed so this run leaves
// them alone. The centre is still measured: that is a position, not a size, and
// is sound at any scale.
const pinned = [];
if (measured) {
  for (const p of provinces) {
    const m = measured.get(parseHex(p.colour));
    if (!m) continue;                      // stale entry, no pixels to measure
    if (p.areaFixed) pinned.push(p.id);
    else p.area = Math.round(m.area);
    p.centre = [Number(m.lat.toFixed(4)), Number(m.lon.toFixed(4))];
  }
}
// --------------------------------------------- terrain and climate
//
// Also DERIVED, and for the same reason: what a province is made of is a fact
// about the ground, and the ground is drawn in terrain.png and climate.png.
//
// Everything covering more than DOMINANT_SHARE of a province is named, so a
// province half hills and half mountains is BOTH. That is deliberate. Naming
// only the winner of a near-tie throws away the more useful half of what the
// maps know, and the game reads these as a set already.
//
// Alpine is the exception and is carried over untouched. It is not drawn
// anywhere and cannot be derived from anything. It is a ruling about a
// province, typed in by hand, and this pass would otherwise quietly delete
// forty-nine of them.
const landscapeNotes = [];
let landscaped = 0, terrainFallback = 0, climateFallback = 0, multiTerrain = 0, multiClimate = 0;

if (!globeImg || !projection) {
  landscapeNotes.push('no true_area.png to read them off — left untouched');
} else if (!fs.existsSync(TERRAIN_PNG) || !fs.existsSync(CLIMATE_PNG)) {
  landscapeNotes.push('terrain.png or climate.png missing — left untouched');
} else {
  const terrainImg = decodePNG(TERRAIN_PNG);
  const climateImg = decodePNG(CLIMATE_PNG);
  const wrong = [
    terrainImg.width !== globeImg.width || terrainImg.height !== globeImg.height
      ? `terrain.png is ${terrainImg.width}x${terrainImg.height}` : null,
    climateImg.width !== globeImg.width || climateImg.height !== globeImg.height
      ? `climate.png is ${climateImg.width}x${climateImg.height}` : null,
  ].filter(Boolean);

  if (wrong.length) {
    landscapeNotes.push(`${wrong.join('; ')} — both must match true_area.png`);
  } else {
    // Indexed over the reconciled list, so a province added this run is read
    // along with the rest rather than waiting for the next one.
    const indexOf = new Map(provinces.map((p, i) => [parseHex(p.colour), i + 1]));
    const shares = landscapeShares({
      trueArea: { w: globeImg.width, h: globeImg.height, px: globeImg.px },
      terrain: { px: terrainImg.px }, climate: { px: climateImg.px },
      colourToIndex: indexOf, oceanKey, provinceCount: provinces.length,
      areaOfPixel: (y) => projection.areaOfPixel(y),
    });

    provinces.forEach((p, i) => {
      const ix = i + 1;
      const t = dominantIn(shares.tHist, ix, shares.tStride, TERRAINS, DOMINANT_SHARE);
      const k = dominantIn(shares.cHist, ix, shares.cStride, CLIMATES, DOMINANT_SHARE);

      // Nothing to read. A province with no pixels in true_area.png keeps what
      // it had, exactly as its area does.
      if (!t.names.length && !k.names.length) return;
      landscaped++;

      if (t.names.length) {
        const alpine = [].concat(p.terrain || []).includes(ALPINE);
        p.terrain = alpine ? [...t.names, ALPINE] : t.names;
        if (t.fellBack) terrainFallback++;
        if (t.names.length > 1) multiTerrain++;
      }
      if (k.names.length) {
        p.climate = k.names;
        if (k.fellBack) climateFallback++;
        if (k.names.length > 1) multiClimate++;
      }
    });

    /*
     * --landscape: what each province is ACTUALLY made of, as percentages.
     *
     * The `terrain` and `climate` fields are a reduction of this, being
     * everything over DOMINANT_SHARE, and a reduction throws away exactly what
     * a population estimate needs. Northwest Krenland is tagged Plains and is
     * 49% plains, 26% mountains and 25% hills; a density applied to the tag
     * treats a quarter of it as farmland that is not there.
     *
     * The county table is the other place to ask, and it is coarser: a county
     * carries one modal landform over its whole area, so a province cut into
     * two counties can only ever answer in halves. This reads the true-area
     * maps per pixel, which is where the counties got it from.
     *
     * --landscape          every province
     * --landscape=KRN      one owner
     */
    if (LANDSCAPE !== null) {
      const pc = (hist, ix, stride, names) => {
        let total = 0;
        for (let v = 1; v < stride; v++) total += hist[ix * stride + v];
        if (!(total > 0)) return '-';
        const out = [];
        for (let v = 1; v < stride; v++) {
          const f = hist[ix * stride + v] / total;
          if (f >= 0.005) out.push([names[v - 1], f]);
        }
        return out.sort((a, b) => b[1] - a[1])
          .map(([n, f]) => `${n} ${(100 * f).toFixed(1)}%`).join(', ');
      };

      const want = provinces.filter((p) => !LANDSCAPE || p.owner === LANDSCAPE);
      console.log(`\nlandscape     ${want.length} province(s)`
        + `${LANDSCAPE ? ` owned by ${LANDSCAPE}` : ''}, by share of true ground`);
      for (const p of want.sort((a, b) => (b.area || 0) - (a.area || 0))) {
        const ix = provinces.indexOf(p) + 1;
        console.log(`  ${p.name}  ${Math.round(p.area || 0).toLocaleString()} km2`
          + `${coastal.has(parseHex(p.colour)) ? '  coastal' : ''}`);
        console.log(`    terrain  ${pc(shares.tHist, ix, shares.tStride, TERRAINS)}`);
        console.log(`    climate  ${pc(shares.cHist, ix, shares.cStride, CLIMATES)}`);
      }
    }
  }
}

// Entries whose colour is no longer anywhere in the bitmap. These are KEPT by
// default: painting over a province by accident should not silently destroy the
// name, owner and terrain you typed in by hand. Pass --prune to delete them.
const stale = (old.provinces || []).filter((p) => !blobs.has(parseHex(p.colour)));
if (!PRUNE) provinces.push(...stale);

const table = {
  width: img.width,
  height: img.height,
  oceanColour: hex(oceanKey),
  provinces,
};

// ------------------------------------------------------------------ report

console.log(`bitmap        ${img.width}x${img.height}, ${counts.size} distinct colours`);
console.log(`ocean colour  ${hex(oceanKey)}${oceanChanged ? '  (auto-detected — JSON updated)' : ''}`);
console.log(`provinces     ${provinces.length}  (${kept.length} kept, ${added.length} added, ${stale.length} stale)`);
console.log(`borders       ${borders}`
  + `${tooShort.length ? `  (${tooShort.length} contact${tooShort.length > 1 ? 's' : ''} of under ${MIN_BORDER_PX}px ignored)` : ''}`);
console.log(`coastal       ${coastal.size}`);
console.log(`islands       ${provinces.filter((p) => !neighboured.has(parseHex(p.colour))).length}`);

if (projection) {
  const km = (v) => v.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  let land = 0;
  for (const m of measured.values()) land += m.area;
  const globe = projection.surfaceKm2;
  // Latitudes of the measured bitmap, which is the whole globe, so pole to pole.
  const top = toDegrees(projection.latAt(0));
  const bottom = toDegrees(projection.latAt(projection.height - 1));

  console.log(`globe         ${projection.width} x ${projection.height}, ${top.toFixed(1)}° to ${bottom.toFixed(1)}°`);
  console.log(`surface       ${km(globe)} km2 total, ${km(land)} km2 land (${(100 * land / globe).toFixed(2)}%)`);
  for (const note of globeNotes) console.log(`note          ${note}`);
} else {
  for (const note of globeNotes) console.log(`area          skipped: ${note}`);
}

if (landscaped) {
  const pc = (n) => `${(100 * n / landscaped).toFixed(1)}%`;
  console.log(`landscape     ${landscaped} province${landscaped > 1 ? 's' : ''} read from terrain.png and climate.png`
    + ` at over ${(DOMINANT_SHARE * 100).toFixed(0)}% of their ground`);
  console.log(`  terrain     ${multiTerrain} with more than one (${pc(multiTerrain)}),`
    + ` ${terrainFallback} with nothing over the bar, largest taken (${pc(terrainFallback)})`);
  console.log(`  climate     ${multiClimate} with more than one (${pc(multiClimate)}),`
    + ` ${climateFallback} with nothing over the bar, largest taken (${pc(climateFallback)})`);
}
for (const note of landscapeNotes) console.log(`landscape     skipped: ${note}`);

const nameOf = (k) => {
  const p = provinces.find((q) => parseHex(q.colour) === k);
  return `${String(p.id).padStart(3)} ${String(p.name).padEnd(12)}`;
};

// Named, not merely counted — the same reasoning the stray colours above are
// reported by. "3 provinces have no pixels" is not something anybody can act
// on; an id and a place to look at is. These are drawn on the map and missing
// from the globe, so their area and centre are whatever was last written and
// will stay that way until the colour is painted into true_area.png. That is
// the one silent staleness in the file, since every other run rewrites both.
if (pinned.length) {
  console.log(`
areaFixed — area held at the masterlist figure, too small to measure (${pinned.length}):`);
  console.log('  ' + pinned.join(', '));
}
if (unmeasured.length) {
  console.log(`\nno pixels in true_area.png — area and centre left as they were (${unmeasured.length}):`);
  for (const k of unmeasured) {
    const pieces = blobs.get(k);
    const total = pieces.reduce((s, b) => s + b.n, 0);
    // Located by the largest piece, which is the one worth going to look at.
    console.log(`  ${hex(k)} ${nameOf(k)} ${String(total).padStart(5)} px at (${pieces[0].cx}, ${pieces[0].cy})`);
  }
}

if (tooShort.length) {
  // Worth seeing rather than just counting. A one-pixel contact is usually a
  // slip — two provinces that were meant to meet properly, or not at all — and
  // it is invisible at any zoom you would draw at.
  console.log(`\ncontacts too short to count as a border (${tooShort.length}):`);
  for (const key of tooShort.slice(0, 12)) {
    const [a, b] = key.split('|').map(Number);
    console.log(`  ${nameOf(a).trim()}  —  ${nameOf(b).trim()}`);
  }
  if (tooShort.length > 12) console.log(`  ... and ${tooShort.length - 12} more`);
}

const multi = [...blobs.entries()].filter(([, l]) => l.length > 1);
if (multi.length) {
  console.log(`\nprovinces in multiple pieces — island chains and exclaves (${multi.length}):`);
  for (const [k, list] of multi) {
    console.log(`  ${hex(k)} ${nameOf(k)} ${list.length} pieces: ${list.map((b) => b.n).join(', ')}`);
  }
}

const sizes = [...blobs.entries()]
  .map(([k, l]) => ({ k, total: l.reduce((s, b) => s + b.n, 0), at: l[0] }))
  .sort((a, b) => a.total - b.total);

console.log(`\nsmallest provinces:`);
for (const s of sizes.slice(0, 5)) {
  console.log(`  ${hex(s.k)} ${nameOf(s.k)} ${String(s.total).padStart(5)} px at (${s.at.cx}, ${s.at.cy})`);
}

if (measured) {
  const byArea = [...measured.entries()].sort((a, b) => b[1].area - a[1].area);
  const km = (v) => v.toLocaleString('en-GB', { maximumFractionDigits: 0 });
  console.log(`\nlargest provinces by true area:`);
  for (const [k, m] of byArea.slice(0, 5)) {
    console.log(`  ${hex(k)} ${nameOf(k)} ${km(m.area).padStart(11)} km2  ${String(m.n).padStart(7)} px  ${m.lat.toFixed(1)}°`);
  }

  // A pixel near a pole covers far less ground than one at the equator, so the
  // ranking by area is not the ranking by pixel count. Where the two disagree
  // the projection was doing the lying, which is the reason for all of this.
  const byPixels = [...measured.entries()].sort((a, b) => b[1].n - a[1].n);
  if (byPixels[0][0] !== byArea[0][0]) {
    const [k, m] = byPixels[0];
    console.log(`  largest by pixel count is ${nameOf(k).trim()} at ${m.lat.toFixed(1)}°, which the projection stretches`);
  }
}

if (MIN_SIZE) {
  const specks = sizes.filter((s) => s.total < MIN_SIZE);
  console.log(`\nbelow --min-size=${MIN_SIZE} (${specks.length}):`);
  for (const s of specks) {
    console.log(`  ${hex(s.k)} ${nameOf(s.k)} ${String(s.total).padStart(5)} px at (${s.at.cx}, ${s.at.cy})`);
  }
  if (!specks.length) console.log('  none');
}

if (reslugged.length) {
  console.log(`\nids regenerated from names (${reslugged.length}):`);
  for (const r of reslugged.slice(0, 12)) console.log(`  ${String(r.from).padEnd(14)} -> ${r.to}`);
  if (reslugged.length > 12) console.log(`  ... and ${reslugged.length - 12} more`);
}

if (stale.length) {
  console.log(
    `\nstale — colour no longer in the bitmap (${stale.length}), ` +
    (PRUNE ? 'DELETED:' : 'kept; pass --prune to delete:')
  );
  for (const p of stale) console.log(`  ${p.colour}  ${String(p.id).padEnd(14)} ${p.name}`);
  if (!PRUNE) console.log(`  kept so that a mis-stroke cannot lose data you typed in`);
}

// ------------------------------------------------- what a province HAS
//
// Kept apart from provinces.json rather than added to it, because the two are
// different kinds of fact and change for different reasons. provinces.json says
// what a province IS — its shape, name, owner, terrain — and is rewritten from
// the bitmap on every run. This file says what has been BUILT on it, which is
// authored, and later will be changed by the game as it is played.
//
// Entries are added for new provinces and never removed, on the same reasoning
// as stale entries above: losing numbers somebody typed in because a province
// was repainted for a moment is not a trade worth making.
// Infrastructure is a PAIR, [built, max]: how much of it there is, and how much
// this province could ever hold. Both are needed and neither implies the other —
// a province with no road may be one that has never had one built, or one that
// can never have one. The card shows them as "0/0" for that reason.
const PAIRED = ['road', 'airBase', 'supplyHub', 'fortification', 'electricity', 'antiAir', 'buildingSlots'];


// ------------------------------------------------- building slots
//
// Read from the counties for the same reason the level ceilings are: the
// province tags are the 40% reduction, and on mixed ground they are wrong
// rather than merely coarse.
const TERRAIN_SLOTS = { Plains: 4, Hills: 3, Mountains: 1, Alpine: 0 };
const CLIMATE_SLOTS = { Rainforest: 2, Monsoon: 2, Desert: 2, Savanna: 3, Steppe: 3, Subarctic: 3, Tundra: 1, 'Ice cap': 0 };
/*
 * Hydroelectric generation.
 *
 * 90 polities hold neither coal nor gas, Krenland among them, and under the
 * power rules that leaves them unable to light a room. They are not poor: they
 * are the countries that ran on falling water, which is most of the mountainous
 * north. Without this the model cannot represent Norway.
 *
 * Three things make a river worth damming, and all three are already on the map.
 * HEAD is the drop, from the county landform. FLOW is the water, from the river
 * share the county already records. RAIN is whether the flow is there all year,
 * from the climate. They multiply, because any one of them at zero is no scheme
 * at all: a wet mountain with no river, or a great river across a plain, is not
 * a site.
 *
 * Scaled by AREA and not averaged, since what a country can generate is the
 * absolute volume of falling water it holds, not how hilly it is per square
 * kilometre. The divisor puts world potential near 1,460, which is 34% of what
 * the map can generate once every deposit is worked, close to hydro's real share
 * of generation in the 1920s. At 600 it came to 590, and Krenland could not have
 * covered its own demand at any level of development, which is the wrong answer
 * for the country the model exists to represent.
 */
const HYDRO_HEAD = { Alpine: 1, Mountains: 1, Hills: 0.5, Plains: 0, Urban: 0 };
const HYDRO_RAIN = {
  Oceanic: 1, Monsoon: 1, Rainforest: 1, 'Humid continental': 0.9, 'Humid subtropical': 0.9,
  Subarctic: 0.8, Mediterranean: 0.5, Savanna: 0.5, Tundra: 0.3, Steppe: 0.15,
  Desert: 0, 'Ice cap': 0.1,
};
const HYDRO_DIVISOR = 250;

/** What a province could generate from falling water once it is dammed. */
function hydroPotential(counties) {
  const acc = new Map();
  for (const c of counties) {
    const id = c.province || c.parent;
    const area = c.area || 0;
    if (id === undefined || !area || !c.riverShare) continue;

    const t = c.terrain || [];
    const head = t.length ? t.reduce((s, x) => s + (HYDRO_HEAD[x] ?? 0), 0) / t.length : 0;
    if (!head) continue;

    const cl = Array.isArray(c.climate) ? c.climate : [c.climate];
    const rain = cl.length ? cl.reduce((s, x) => s + (HYDRO_RAIN[x] ?? 0.5), 0) / cl.length : 0.5;

    acc.set(id, (acc.get(id) || 0) + area * head * c.riverShare * rain);
  }
  const out = new Map();
  for (const [id, v] of acc) out.set(id, Math.round(v / HYDRO_DIVISOR));
  return out;
}

const SLOTS_PER_CITY = 3;

// Where people live something can be built, and more people means more of it.
// The ground on its own says otherwise: Alpine carries no slots and Ice cap
// carries none, which left 43 inhabited provinces holding nothing at all, East
// Pingjiang among them with a million people and Kallstrand on plains that
// happen to be frozen. Ground that is 84% alpine and carries a million people is
// not a contradiction, it is a valley, and a valley has room for works.
//
// A floor and not a cap. It only ever adds, so it cannot do what capping BY
// population did to the mountain passes, and the ground still decides wherever
// it is the more generous of the two, which is 96% of the map.
const POPULATION_SLOTS = [
  [10e6, 6],
  [5e6,  5],
  [2.5e6, 4],
  [1e6,  3],
  [250e3, 2],
  [1,    1],
];

const populationSlotsFor = (pop) => (POPULATION_SLOTS.find(([at]) => pop >= at) || [0, 0])[1];

// An island gets its ground and nothing for its cities. Three slots a city is a
// statement about a city drawing on the country behind it, and an island has no
// country behind it: Skogen Island is 535 km2 holding three thousand people and
// came out with seven slots, more than most of the mainland.
//
// An island is a province with no land neighbour, read off the same adjacency
// the game uses. Nothing about size enters into it — Weilian is 378 km2 and
// Nanpowan 657, and both border their neighbours by land, so neither is an
// island however small it looks.
//
// The capital bonus survives, being about the state and not the hinterland.

// A capital is not a fixed prize. The seat of a great power concentrates
// government, finance and industry in a way the seat of an island territory of
// three thousand people does not, and a flat bonus gave Isbjerg exactly what it
// gave Xindu. It scales with the state behind it instead.
const CAPITAL_SLOTS = [[50e6, 3], [10e6, 2], [1e6, 1]];
const capitalSlotsFor = (pop) => (CAPITAL_SLOTS.find(([at]) => pop >= at) || [0, 0])[1];

/** Area-weighted slot ground per province, as levelCeilings but one figure. */
function slotGround(counties) {
  const acc = new Map();
  for (const c of counties) {
    const id = c.province || c.parent;
    const area = c.area || 0;
    if (id === undefined || !area) continue;
    let g = acc.get(id);
    if (!g) acc.set(id, g = { area: 0, terrain: 0, climate: 0 });
    g.area += area;
    const tags = (c.terrain || [])
      .map((t) => (t === 'Urban' ? 'Plains' : t))
      .filter((t) => TERRAIN_SLOTS[t] !== undefined);
    const rows = tags.length ? tags : ['Plains'];
    g.terrain += area * (rows.reduce((a, t) => a + TERRAIN_SLOTS[t], 0) / rows.length);
    const cl = (Array.isArray(c.climate) ? c.climate : [c.climate]).filter((x) => CLIMATE_SLOTS[x] !== undefined);
    // An uncapped climate carries the top of the scale, as with the levels.
    g.climate += area * (cl.length ? cl.reduce((a, x) => a + CLIMATE_SLOTS[x], 0) / cl.length : 4);
  }
  const out = new Map();
  // Rounded, not floored. The slot scale runs 0 to 4 where the level scale runs
  // 0 to 10, so the same truncation costs four times as much: Gongyuk averages
  // 0.95 across ground that is 70% Alpine, 23% Hills and 5% Plains, and flooring
  // called that nothing at all. Ground that is genuinely empty still rounds to
  // zero, because it averages zero.
  for (const [id, g] of acc) out.set(id, Math.min(Math.round(g.terrain / g.area), Math.round(g.climate / g.area)));
  return out;
}

/** How much of a maximum a province has actually opened up. */
function unlockedSlots(maximum, road, electricity, railedShare) {
  if (!maximum) return 0;
  const share = 0.3 + 0.6 * ((road + electricity) / 20);
  return Math.min(maximum, Math.ceil(maximum * share) + (railedShare >= 0.5 ? 1 : 0));
}

// ------------------------------------------------- maximum levels
//
// The ceiling on each of the six levelled types is a property of the GROUND, and
// the ground does not move, so this is settled here once and written into the
// file. The game reads the figure and never recomputes it.
//
// Population is deliberately absent. A state can drive a road or a supply line
// through empty country if it pays for it, and capping by population held
// mountain passes to fortification 2 because nobody lived on them.
//
// Read from the COUNTIES, not from the province tags. Those tags are the
// "everything over 40%" reduction and on mixed ground they are wrong rather than
// coarse: Gongyuk is tagged Mountains and Alpine and has no mountain county at
// all, being Alpine 70%, Hills 23% and Plains 5%.
const LEVEL_TYPES = ['road', 'electricity', 'fortification', 'supplyHub', 'antiAir', 'airBase'];

const TERRAIN_CEILING = {
  Plains:    [10, 10,  6, 10, 10, 10],
  Hills:     [ 8,  8,  8,  8, 10,  6],
  Mountains: [ 4,  6, 10,  4,  8,  2],
  Alpine:    [ 2,  3,  8,  2,  6,  0],
};

// null is no cap from this climate, and the four temperate ones are absent for
// the same reason. A climate value can only ever LOWER the terrain one, so a
// number above the terrain ceiling would never bind.
// Below this latitude, subarctic is altitude rather than latitude, and the
// fortification cap that comes with it does not apply. A subarctic county at 40
// degrees is a mountain; one at 65 is the far north. The map splits at almost
// exactly this line: below 40 degrees, 85% of subarctic counties are mountain or
// alpine, and above 60 only 1% are.
//
// It is lifted for FORTIFICATION alone. The other five caps are about weather,
// which a mountain has just the same, but the fortification cap stands for
// permafrost and a building season measured in weeks, and a temperate mountain
// has neither. Rock is the best ground on the map to dig into.
const SUBARCTIC_BY_ALTITUDE = 50;

const CLIMATE_CEILING = {
  Rainforest: [5, 6,    4, 5,  5, 4],
  Monsoon:    [6, 7,    5, 6,  6, 5],
  Savanna:    [8, 8, null, 8,  9, 8],
  Desert:     [6, 8,    4, 6, 10, 9],
  Steppe:     [8, 8, null, 8, 10, 10],
  Subarctic:  [4, 6,    5, 5,  7, 6],
  Tundra:     [2, 4,    4, 3,  6, 4],
  'Ice cap':  [1, 2,    3, 2,  4, 2],
};

/**
 * Area-weighted ceilings per province, from counties.json.
 *
 * Terrain and climate are averaged separately and only then compared: taking the
 * lower per county and averaging afterwards would let one bad pairing decide the
 * whole province.
 */
function levelCeilings(counties, cityProvinces = new Set()) {
  const acc = new Map();

  for (const c of counties) {
    const id = c.province || c.parent;
    const area = c.area || 0;
    if (id === undefined || !area) continue;

    let g = acc.get(id);
    if (!g) acc.set(id, g = { area: 0, terrain: new Array(6).fill(0), climate: new Array(6).fill(0) });
    g.area += area;

    // Urban takes the Plains row whatever it sits on, a city being where the
    // infrastructure already is. It replaces the landform rather than averaging
    // in as a fifth one, because it is a marker over ground, not ground.
    const tags = (c.terrain || [])
      .map((t) => (t === 'Urban' ? 'Plains' : t))
      .filter((t) => TERRAIN_CEILING[t]);
    const rows = (tags.length ? tags : ['Plains']).map((t) => TERRAIN_CEILING[t]);
    const cl = (Array.isArray(c.climate) ? c.climate : [c.climate]).filter((x) => CLIMATE_CEILING[x]);
    const highGround = Math.abs(c.centre?.[0] ?? 90) < SUBARCTIC_BY_ALTITUDE;
    const fort = LEVEL_TYPES.indexOf('fortification');

    for (let i = 0; i < 6; i++) {
      g.terrain[i] += area * (rows.reduce((a, r) => a + r[i], 0) / rows.length);
      // An uncapped climate carries the top of the scale into the average, so
      // temperate ground neither raises nor lowers what the terrain said.
      const here = (i === fort && highGround) ? cl.filter((x) => x !== 'Subarctic') : cl;
      const caps = here.length ? here.map((x) => CLIMATE_CEILING[x][i] ?? 10) : [10];
      g.climate[i] += area * (caps.reduce((a, v) => a + v, 0) / caps.length);
    }
  }

  const air = LEVEL_TYPES.indexOf('airBase');
  const out = new Map();
  for (const [id, g] of acc) {
    const m = LEVEL_TYPES.map((_, i) => Math.min(
      Math.floor(g.terrain[i] / g.area),
      Math.floor(g.climate[i] / g.area),
    ));
    // A city is proof that ground was cleared and levelled here, so a strip is
    // possible however bad the average says the province is. Akhan is the case:
    // Mountains and Alpine throughout, and a city sitting on it. Without this
    // the averaged ground says no airfield at all, which is a stronger claim
    // than the map is making.
    if (cityProvinces.has(id)) m[air] = Math.max(1, m[air]);
    out.set(id, m);
  }
  return out;
}


// Rail is not here. It is built county by county and has no level, so it lives
// with the counties rather than as a province pair.
const BLANK_STATS = {
  claims: [],            // polity ids with a claim on this province
  population: 0,
  road: [0, 0],
  airBase: [0, 0],
  supplyHub: [0, 0],
  fortification: [0, 0],
  electricity: [0, 0],
  antiAir: [0, 0],
  // Factories do NOT get a count each. In Hearts of Iron a state has a pool of
  // building slots and civilian factories, military factories and dockyards all
  // compete for it — what a province has is a number of sockets and a decision
  // about what goes in each. So the SLOTS are the province's property, [unlocked,
  // maximum], and the two figures below are how the unlocked ones are spent.
  buildingSlots: [0, 0],
  civilianFactories: 0,
  militaryFactories: 0,
  // Unrest is the one province value that cannot be derived. Happiness is a
  // function of the fields above and is computed fresh every tick, but unrest
  // is a recurrence — today's figure depends on every previous day's happiness,
  // stability and garrison — and it is clamped to 0..100, which destroys the
  // history a replay would need. So it is stored, and happiness is not.
  unrest: 0,
  // The event, not the decay. "Recently annexed" costs happiness on a curve
  // that fades to nothing, and storing the curve means something has to tick it
  // daily and it drifts if a tick is missed. A date needs no maintenance and
  // lets the curve be changed without touching the data. null where it never was.
  annexedOn: null,
};

const oldStats = { provinces: mergeStats(readJSONIf(STATS_JSON), readJSONIf(START_INFRA_JSON), readJSONIf(START_ATTITUDE_JSON)) };
const statsById = oldStats.provinces || {};

// --reslug renames ids, and this file is keyed by id, so every entry has to
// travel with its province. Without this a reslug quietly replaces each renamed
// province's numbers with a blank set and leaves the originals behind under an
// id nothing points at any more — which looks like nothing at all until the
// day the numbers are no longer zeroes.
const statsMoved = [];
for (const { from, to } of reslugged) {
  if (!statsById[from] || statsById[to]) continue;
  statsById[to] = statsById[from];
  delete statsById[from];
  statsMoved.push(`${from} -> ${to}`);
}

const statsAdded = [];
for (const p of provinces) {
  if (statsById[p.id]) {
    const e = statsById[p.id];
    // Fill in any field added since the file was written, leaving the rest.
    for (const [k, v] of Object.entries(BLANK_STATS)) {
      if (!(k in e)) e[k] = structuredClone(v);
    }
    // And carry forward a file written when these were single numbers: the
    // figure already there is what has been built, with no cap recorded yet.
    for (const k of PAIRED) if (!Array.isArray(e[k])) e[k] = [Number(e[k]) || 0, 0];
    continue;
  }
  statsById[p.id] = structuredClone(BLANK_STATS);
  statsAdded.push(p.id);
}
// Entries whose province is not in the table any more.
//
// A BLANK one is worth nothing, and dropping it is the difference between a
// file that stays the size of the map and one that accumulates every id the
// map has ever had. One with figures in it is kept, on the same reasoning as a
// stale province: somebody typed those, and a province painted over by accident
// should not take them with it.
const isEmpty = (v) => (Array.isArray(v) ? v.every(isEmpty) : !v);
const inTable = new Set(provinces.map((p) => p.id));
const statsDropped = [];
const statsKept = [];
for (const id of Object.keys(statsById)) {
  if (inTable.has(id)) continue;
  if (Object.values(statsById[id]).every(isEmpty)) {
    delete statsById[id];
    statsDropped.push(id);
  } else {
    statsKept.push(id);
  }
}

console.log(`\nprovince stats  ${Object.keys(statsById).length} entries`
  + `${statsAdded.length ? `, ${statsAdded.length} added` : ''}`
  + `${statsMoved.length ? `, ${statsMoved.length} followed a renamed id` : ''}`
  + `${statsDropped.length ? `, ${statsDropped.length} blank and orphaned, removed` : ''}`);
if (statsKept.length) {
  console.log(`  ${statsKept.length} kept for provinces no longer in the table, because they hold data:`);
  for (const id of statsKept.slice(0, 8)) console.log(`    ${id}`);
  if (statsKept.length > 8) console.log(`    ... and ${statsKept.length - 8} more`);
}

// Settle the ceilings before writing. The `built` half of every pair is left
// exactly as it is; only the maximum is authored here, and it is authored from
// the ground rather than by hand.
const ceilingSource = fs.existsSync(COUNTIES_JSON)
  ? (JSON.parse(fs.readFileSync(COUNTIES_JSON, 'utf8')).counties || [])
  : [];
const cityProvinces = new Set(
  (fs.existsSync(CITIES_JSON) ? (JSON.parse(fs.readFileSync(CITIES_JSON, 'utf8')).cities || []) : [])
    .map((c) => c.province),
);
const ceilings = levelCeilings(ceilingSource, cityProvinces);
/*
 * A small island is small, whatever its ground would allow on a continent.
 * Gethin Island is 246 km2 of temperate plain and came out with a road ceiling
 * of 10 and an electricity ceiling of 10, which is a motorway network and a
 * national grid for thirty-two thousand people who can walk across it.
 *
 * So: no land neighbour and under 5,000 km2 takes three off every ceiling that
 * is 6 or more. Fortification is exempt, a rock in the sea being exactly the
 * thing you fortify, and a ceiling already under 6 is left alone rather than
 * driven to nothing.
 */
const SMALL_ISLE_KM2 = 5000;
const SMALL_ISLE_CUT = 3;
const SMALL_ISLE_EXEMPT = new Set(['fortification']);

const provinceById = new Map(provinces.map((p) => [p.id, p]));
let ceilingsSet = 0, isleCut = 0;
for (const [id, entry] of Object.entries(statsById)) {
  const m = ceilings.get(id);
  if (!m) continue;
  const p = provinceById.get(id);
  const smallIsle = p && !neighboured.has(parseHex(p.colour)) && (p.area || 0) < SMALL_ISLE_KM2;
  if (smallIsle) isleCut++;
  LEVEL_TYPES.forEach((key, i) => {
    const built = Array.isArray(entry[key]) ? entry[key][0] : Number(entry[key]) || 0;
    const cap = smallIsle && !SMALL_ISLE_EXEMPT.has(key) && m[i] >= 6
      ? m[i] - SMALL_ISLE_CUT
      : m[i];
    // A ceiling gates what can be added and never takes away what is there, so
    // a level already built survives a ceiling that has since been lowered.
    entry[key] = [built, Math.max(cap, built)];
  });
  ceilingsSet++;
}
// Slots, from the same counties. The first half of the pair is the UNLOCKED
// figure and is derived too, following from road and electricity rather than
// being something anyone sets.
const slotCities = fs.existsSync(CITIES_JSON)
  ? (JSON.parse(fs.readFileSync(CITIES_JSON, 'utf8')).cities || []) : [];
const ground = slotGround(ceilingSource);
const hydro = hydroPotential(ceilingSource);

// The share of each province's counties carrying a line, for the slot figure
// below. Hardcoding it to 0 was fine when no county had rail and wrong the day
// one did.
const railedShare = new Map();
{
  const seen = new Map();
  for (const c of ceilingSource) {
    const id = c.province || c.parent;
    if (id === undefined) continue;
    const t = seen.get(id) || { n: 0, railed: 0 };
    t.n++;
    if (Array.isArray(c.rail) ? c.rail.length : c.rail) t.railed++;
    seen.set(id, t);
  }
  for (const [id, t] of seen) railedShare.set(id, t.n ? t.railed / t.n : 0);
}
const capitalProvinces = new Set(slotCities.filter((c) => c.capital).map((c) => c.province));
const cityTally = {};
for (const c of slotCities) cityTally[c.province] = (cityTally[c.province] || 0) + 1;
const nationalPop = {};
for (const p of provinces) {
  nationalPop[p.owner] = (nationalPop[p.owner] || 0) + (statsById[p.id]?.population || 0);
}
let slotsSet = 0;
for (const p of provinces) {
  const e = statsById[p.id];
  const g = ground.get(p.id);
  if (!e || g === undefined) continue;
  const island = !neighboured.has(parseHex(p.colour));
  const raw = g
    + (island ? 0 : SLOTS_PER_CITY * (cityTally[p.id] || 0))
    + (capitalProvinces.has(p.id) ? capitalSlotsFor(nationalPop[p.owner] || 0) : 0);
  const maximum = Math.max(raw, populationSlotsFor(e.population || 0));
  const [road = 0] = Array.isArray(e.road) ? e.road : [0];
  const [power = 0] = Array.isArray(e.electricity) ? e.electricity : [0];
  e.buildingSlots = [unlockedSlots(maximum, road, power, railedShare.get(p.id) || 0), maximum];
  // The ground only. What is actually generated is this worked by the same
  // development rule a deposit is, under Resources, Extraction: a river nobody
  // has dammed generates nothing.
  e.hydroPotential = hydro.get(p.id) || 0;
  slotsSet++;
}

console.log('  slots written for ' + slotsSet + ' provinces');
console.log('  small islands cut ' + isleCut + ' provinces under ' + SMALL_ISLE_KM2 + ' km2 with no land neighbour');
{
  const h = [...hydro.values()].filter((v) => v > 0);
  console.log('  hydro potential ' + h.reduce((a, b) => a + b, 0) + ' across ' + h.length + ' provinces'
    + ', largest ' + Math.max(0, ...h));
}
console.log(`  ceilings written for ${ceilingsSet} provinces from ${ceilingSource.length.toLocaleString()} counties`
  + `${ceilingSource.length ? '' : ' — counties.json missing, none set'}`);

if (WRITE) {
  writeJSON(JSON_PATH, table);
  console.log(`\nwrote ${path.relative(process.cwd(), JSON_PATH)}`);
  const split = splitStats(statsById);
  writeJSON(STATS_JSON, { provinces: split.stats });
  writeJSON(START_INFRA_JSON, { provinces: split.infrastructure });
  writeJSON(START_ATTITUDE_JSON, { provinces: split.attitude });
  for (const f of [STATS_JSON, START_INFRA_JSON, START_ATTITUDE_JSON]) console.log(`wrote ${path.relative(process.cwd(), f)}`);
} else {
  console.log(`\n(dry run — nothing written. re-run with --write to apply)`);
}

// ----------------------------------------------------------- the map cache

/**
 * Precomputes everything the page would otherwise derive at load, and writes it
 * to data/map-cache.bin.
 *
 * Runs the renderer's own scans, imported from src/mapdata.js — the whole point
 * being that the cache holds exactly what the browser would have computed.
 *
 * Only ever written against the JSON as it exists ON DISK. Building it from a
 * table that has not been saved would produce a cache describing a map nobody
 * has, and it would pass its own hash check while doing so.
 */
if (CACHE) {
  if (!WRITE && (added.length || (PRUNE && stale.length) || reslugged.length)) {
    console.log('\ncache NOT written: there are unsaved changes above. Run with --write --cache.');
  } else {
    const started = Date.now();
    const raw = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    raw.polities = readPolities();
    const seaBytes = fs.existsSync(SEA_PNG) ? fs.readFileSync(SEA_PNG) : null;
    const seaRaw = fs.existsSync(SEA_JSON) ? JSON.parse(fs.readFileSync(SEA_JSON, "utf8")) : null;
    const countyBytes = fs.existsSync(COUNTIES_PNG) ? fs.readFileSync(COUNTIES_PNG) : null;
    const countyRaw = fs.existsSync(COUNTIES_JSON) ? JSON.parse(fs.readFileSync(COUNTIES_JSON, "utf8")) : null;
    const subBytes = fs.existsSync(SUBS_PNG) ? fs.readFileSync(SUBS_PNG) : null;
    const hash = hashInputs(fs.readFileSync(PNG), raw, seaBytes, seaRaw, countyBytes, countyRaw, subBytes);

    // The decoder above keeps a packed colour per pixel, which is all the rest
    // of this script needs; mapPixels() reads the RGBA bytes a browser would
    // hand it, so expand into that shape rather than teaching it a second one.
    const data = new Uint8ClampedArray(img.width * img.height * 4);
    for (let i = 0, o = 0; i < img.px.length; i++, o += 4) {
      const k = img.px[i];
      data[o] = (k >> 16) & 255; data[o + 1] = (k >> 8) & 255; data[o + 2] = k & 255; data[o + 3] = 255;
    }

    // normaliseTable mutates, so the hash above is taken first — it has to see
    // the colours in the form the browser will hash them in.
    const world = buildWorld(normaliseTable(raw), { width: img.width, height: img.height, data });
    world.borderDist = buildBorderDistance(world);
    const geometry = computeLabelGeometry(world);

    // The sea goes in the same file. It is read from its own bitmap and its own
    // table, and the page would otherwise have to scan a second full-size image
    // at load to know which region a pixel of water belongs to.
    let sea = null;
    if (seaBytes && seaRaw) {
      const seaImg = decodePNG(SEA_PNG);
      if (seaImg.width !== img.width || seaImg.height !== img.height) {
        console.log(`  sea.png is ${seaImg.width}x${seaImg.height}, not ${img.width}x${img.height}; left out of the cache`);
      } else {
        const seaData = new Uint8ClampedArray(seaImg.width * seaImg.height * 4);
        for (let i = 0, o = 0; i < seaImg.px.length; i++, o += 4) {
          const k = seaImg.px[i];
          seaData[o] = (k >> 16) & 255; seaData[o + 1] = (k >> 8) & 255; seaData[o + 2] = k & 255; seaData[o + 3] = 255;
        }
        const seaTable = normaliseSeaTable(seaRaw);
        sea = buildSeaWorld(seaTable, { width: seaImg.width, height: seaImg.height, data: seaData });

        // sea.png has colours sea.json has never been told about, which means it
        // has been redrawn since the table was last written. Baking that into the
        // cache would put water in the file that no region owns, so the sea is
        // dropped and the run says what to do about it.
        if (sea.unknown) {
          console.log(`  sea.png has ${sea.unknown} colour(s) sea.json does not list, so the sea is`);
          console.log(`  left out. Run: node sync-provinces.js --sea --write --cache`);
          sea = null;
        }
      }
    }

    // And the counties, on the same terms. Another two bytes a pixel, against a
    // second full-size bitmap decoded and scanned at every load.
    let counties = null;
    if (countyBytes && countyRaw) {
      const cImg = decodePNG(COUNTIES_PNG);
      if (cImg.width !== img.width || cImg.height !== img.height) {
        console.log(`  counties.png is ${cImg.width}x${cImg.height}, not ${img.width}x${img.height}; left out of the cache`);
      } else {
        const cData = new Uint8ClampedArray(cImg.width * cImg.height * 4);
        for (let i = 0, o = 0; i < cImg.px.length; i++, o += 4) {
          const k = cImg.px[i];
          cData[o] = (k >> 16) & 255; cData[o + 1] = (k >> 8) & 255; cData[o + 2] = k & 255; cData[o + 3] = 255;
        }
        counties = buildCountyWorld(normaliseCountyTable(countyRaw),
          { width: cImg.width, height: cImg.height, data: cData });
      }
    }

    // And the sea subregions, which the Navy layer draws. They live in sea.json
    // beside the regions, so the table is already read; only the bitmap is new.
    let subs = null;
    if (subBytes && seaRaw && (seaRaw.subregions || []).length) {
      const sImg = decodePNG(SUBS_PNG);
      if (sImg.width !== img.width || sImg.height !== img.height) {
        console.log(`  sea_subregions.png is ${sImg.width}x${sImg.height}, not ${img.width}x${img.height}; left out of the cache`);
      } else {
        const sData = new Uint8ClampedArray(sImg.width * sImg.height * 4);
        for (let i = 0, o = 0; i < sImg.px.length; i++, o += 4) {
          const k = sImg.px[i];
          sData[o] = (k >> 16) & 255; sData[o + 1] = (k >> 8) & 255; sData[o + 2] = k & 255; sData[o + 3] = 255;
        }
        subs = buildSubWorld(normaliseSubTable(seaRaw),
          { width: sImg.width, height: sImg.height, data: sData });

        if (subs.unknown) {
          console.log(`  sea_subregions.png has ${subs.unknown} colour(s) sea.json does not list, so the`);
          console.log(`  subregions are left out. Run: node sync-provinces.js --sea-subs --write --cache`);
          subs = null;
        }
      }
    }

    const meta = buildCacheMeta(world, geometry, hash, sea, counties);
    meta.subs = buildSubMeta(subs);
    const packed = packCache(meta,
      world.provinceAt, world.borderDist, sea && sea.seaAt, counties && counties.countyAt,
      subs && subs.subAt);
    const gz = zlib.deflateSync(packed, { level: 9 });
    fs.writeFileSync(CACHE_PATH, gz);

    const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
    console.log(`\nwrote ${path.relative(process.cwd(), CACHE_PATH)}`);
    console.log(`  ${mb(packed.length)} packed -> ${mb(gz.length)} deflated, built in ${Date.now() - started} ms`);
    console.log(`  ${sea ? sea.atIndex.length - 1 + ' sea regions' : 'no sea regions'}`
      + `, ${counties ? (counties.atIndex.length - 1).toLocaleString() + ' counties' : 'no counties'} included`);
    console.log(`  the page skips its own scans while provinces.png, sea.png, counties.png`);
    console.log(`  and the colours and owners in their tables are unchanged; edit any and it`);
    console.log(`  recomputes and warns.`);
  }
}

// ------------------------------------------------- county boundaries to rivers

/**
 * Runs snapToRivers over counties.png and writes it back.
 *
 * SEPARATE FROM --regen-counties ON PURPOSE. counties.png is hand-edited, and a
 * regeneration draws it from nothing and throws those edits away. This does not:
 * it moves pixels between counties that already exist, near rivers and nowhere
 * else, and every county keeps its colour, so counties.json still matches
 * afterwards apart from the areas — run --counties to bring those back in line.
 *
 * A copy of the file is written beside it first. This rewrites the one thing in
 * the project that is drawn by hand and cannot be regenerated.
 */
if (SNAP) {
  const width = img.width, height = img.height;
  const missing = [COUNTIES_PNG, RIVERS_PNG].filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.log(`\nsnap-rivers: ${missing.map((p) => path.relative(process.cwd(), p)).join(', ')} not found, skipped.`);
  } else {
    const drawn = decodePNG(COUNTIES_PNG);
    const water = decodePNG(RIVERS_PNG);
    if (drawn.width !== width || drawn.height !== height
      || water.width !== width || water.height !== height) {
      console.log(`\nsnap-rivers: counties.png is ${drawn.width}x${drawn.height} and the water file is`
        + ` ${water.width}x${water.height}; both must be ${width}x${height}. Skipped.`);
    } else {
      const table = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
      const ocean = parseHex(table.oceanColour);
      const index = new Map(table.provinces.map((p, i) => [parseHex(p.colour), i + 1]));
      const provinceAt = new Uint16Array(width * height);
      for (let i = 0; i < img.px.length; i++) {
        const ix = index.get(img.px[i]);
        if (ix !== undefined) provinceAt[i] = ix;
      }
      const RIVER_BLUE = 0x3aa5d2;
      const riverAt = new Uint8Array(width * height);
      for (let i = 0; i < riverAt.length; i++) if (water.px[i] === RIVER_BLUE) riverAt[i] = 1;

      // Towns are let through; see crossableCounties. Read from counties.json,
      // which is where the Urban tag and the river flag live, and matched to the
      // bitmap by colour.
      const cFile = fs.existsSync(COUNTIES_JSON)
        ? JSON.parse(fs.readFileSync(COUNTIES_JSON, "utf8")) : { counties: [] };
      const cross = crossableCounties((cFile.counties || []).map((c) => ({ ...c, colour: parseHex(c.colour) })));

      const r = snapToRivers({
        countyPx: drawn.px, provinceAt, riverAt, width, height,
        snap: RIVER_SNAP, crossable: cross.colours,
      });

      console.log(`\nsnap-rivers   within ${RIVER_SNAP}px of a river`);
      console.log(`  towns         ${cross.colours.size.toLocaleString()} of ${(cFile.counties || []).filter((c) => (c.terrain || []).includes('Urban')).length.toLocaleString()} let across`
        + ` (${cross.onRiver.toLocaleString()} already stand on a river, ${cross.byHash.toLocaleString()} of the rest at ${(URBAN_CROSS_SHARE * 100).toFixed(0)}%, ${cross.held.toLocaleString()} held back)`);
      console.log(`  barriers      ${r.barrierPx.toLocaleString()} river pixels`
        + ` (${r.ignored.toLocaleString()} ignored, too near a province edge; ${r.crossed.toLocaleString()} inside a town)`);
      console.log(`  band          ${r.bandPx.toLocaleString()} pixels regrown from the ground outside it`);
      console.log(`  moved         ${r.moved.toLocaleString()} pixels changed county`
        + ` (${(100 * r.moved / (width * height)).toFixed(3)}% of the map)`);
      console.log(`  frozen        ${r.frozen.toLocaleString()} counties too small to regrow, left alone`);
      console.log(`  reverted      ${r.broken.toLocaleString()} counties that would have come out in two pieces`
        + ` (${r.rounds} round${r.rounds === 1 ? '' : 's'} to settle)`);
      if (r.stranded) console.log(`  stranded      ${r.stranded.toLocaleString()} pixels walled in by rivers, unchanged`);

      if (!r.moved) {
        console.log(`  nothing to move.`);
      } else if (WRITE) {
        const backup = COUNTIES_PNG.replace(/\.png$/, '.before-snap.png');
        fs.copyFileSync(COUNTIES_PNG, backup);
        fs.writeFileSync(COUNTIES_PNG, encodePNG(width, height, r.countyPx));
        console.log(`  wrote ${path.relative(process.cwd(), COUNTIES_PNG)},`
          + ` previous kept as ${path.basename(backup)}`);
        console.log(`  now run: node sync-provinces.js --counties --write   (areas and centres)`);
      } else {
        console.log(`  --write to apply it. The current counties.png is copied aside first.`);
      }
    }
  }
}

// ------------------------------------------------------- the sea subregions

/**
 * Cuts every sea region into the pieces a fleet moves between.
 *
 * Three files and a table. `sea.png` has the region shapes in the game frame,
 * `sea_true_area.png` and `sea_elevation.png` are the same 6000x3000 picture of
 * the whole globe so depth can be counted without reprojecting anything, and
 * `sea.json` carries the tags that decide how finely a region divides.
 *
 * Written out as `sea_subregions.png`, one flat colour each, which makes it the
 * same kind of artefact counties.png is: generated once, then hand-editable, and
 * read back by the game as a per-pixel index.
 */
if (SUBS_REGEN) {
  const need = [SEA_PNG, SEA_GLOBE, SEA_ELEVATION, SEA_JSON].filter((p) => !fs.existsSync(p));
  if (need.length) {
    console.log(`\nsea subregions: ${need.map((p) => path.relative(process.cwd(), p)).join(', ')} not found, skipped.`);
  } else {
    const width = img.width, height = img.height;
    const shapes = decodePNG(SEA_PNG);
    const globe = decodePNG(SEA_GLOBE);
    const elev = decodePNG(SEA_ELEVATION);
    const table = JSON.parse(fs.readFileSync(SEA_JSON, 'utf8'));

    const wrong = [
      shapes.width !== width || shapes.height !== height ? `sea.png is ${shapes.width}x${shapes.height}` : null,
      elev.width !== globe.width || elev.height !== globe.height
        ? `sea_elevation.png is ${elev.width}x${elev.height} and sea_true_area.png is ${globe.width}x${globe.height}` : null,
    ].filter(Boolean);

    if (wrong.length) {
      console.log(`\nsea subregions: ${wrong.join('; ')}. Skipped.`);
    } else {
      console.log(`\nsea subregions`);
      const t0 = Date.now();

      const regions = table.regions || [];
      const byColour = new Map(regions.map((r) => [parseHex(r.colour), r]));
      const colourToId = new Map(regions.map((r) => [parseHex(r.colour), r.id]));

      // Depth, counted over the whole globe in true area. A polar sea is not
      // given the weight the game map's stretched rows would give it.
      const gProj = makeProjection({ width: globe.width, height: globe.height, globeHeight: globe.height });
      const depth = depthByRegion({
        globePx: globe.px, elevPx: elev.px, width: globe.width, height: globe.height,
        colourToId, areaOfRow: (y) => gProj.areaOfPixel(y) * globe.width,
      });

      // The region each game-frame pixel belongs to, and the pixels of each.
      const pixelsOf = new Map(regions.map((r) => [r.id, []]));
      for (let i = 0; i < shapes.px.length; i++) {
        const r = byColour.get(shapes.px[i]);
        if (r) pixelsOf.get(r.id).push(i);
      }

      const cProj = makeProjection({ width, height, globeHeight: MAP_GLOBE_HEIGHT, northRow: MAP_NORTH_ROW });
      const rowArea = new Float64Array(height);
      for (let y = 0; y < height; y++) rowArea[y] = cProj.areaOfPixel(y);

      const bandCode = new Map(DEPTH_BANDS.map(([c], i) => [c, i + 1]));
      const subs = [];
      const takenIds = new Set();
      const owned = new Int32Array(width * height);      // subregion ordinal per pixel
      let atCeiling = 0, capped = 0, mendedPx = 0, strandedPx = 0, noDepth = 0, dissolved = 0;
      let pinchedPx = 0, pinchedLobes = 0;

      for (const r of regions) {
        const px = pixelsOf.get(r.id);
        if (!px.length) continue;

        const d = readDepth(depth.get(r.id));
        if (!d.band) noDepth++;
        const { n, wanted } = subregionCount({ area: r.area || 0, pixels: px.length });
        if (wanted >= MAX_SUBREGIONS) atCeiling++;
        if (n < wanted) capped++;

        // Unwrapped into a frame where the region is in one piece. A sea across
        // the antimeridian has columns at both ends of the map, and a centre
        // averaged over the raw numbers lands on the far side of the world.
        const seen = new Uint8Array(width);
        for (const i of px) seen[i % width] = 1;
        let gap = 0, gapAt = 0, run = 0, runAt = 0;
        for (let k = 0; k < width * 2; k++) {
          const x = k % width;
          if (seen[x]) { run = 0; continue; }
          if (!run) runAt = x;
          run++;
          if (run > gap) { gap = run; gapAt = runAt; }
        }
        const shift = gap ? (gapAt + gap) % width : 0;

        const xs = new Float64Array(px.length), ys = new Float64Array(px.length);
        for (let k = 0; k < px.length; k++) {
          xs[k] = ((px[k] % width) - shift + width) % width;
          ys[k] = (px[k] / width) | 0;
        }

        // OVER-CUT, THEN MERGED. A single Voronoi diagram gives convex cells of
        // about six sides whatever the seeds do, which is the honeycomb. Cutting
        // six times as fine and sticking the pieces back together at random gives
        // outlines that are ragged, not convex and no two alike, out of parts that
        // are all still bounded by straight bisectors.
        const seed = hashSeed(r.id);
        const nFine = Math.max(1, Math.min(n * OVERSEGMENT, Math.floor(px.length / 40)));
        const { owner: fine } = cutStraight({ xs, ys, n: nFine, seed });

        // A lookup from the unwrapped coordinates back into this region's own
        // pixel list, so the passes below can walk from a pixel to its neighbours.
        //
        // A DENSE GRID over the bounding box, not a Map. Every pass here walks
        // neighbours, and pinchOff looks at a seven-by-seven block around each
        // pixel — forty-nine lookups apiece over twelve million pixels. A Map
        // made that take longer than the whole rest of the generator put
        // together; an array index costs nothing.
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let k = 0; k < px.length; k++) {
          if (xs[k] < minX) minX = xs[k];
          if (xs[k] > maxX) maxX = xs[k];
          if (ys[k] < minY) minY = ys[k];
          if (ys[k] > maxY) maxY = ys[k];
        }
        const bw = maxX - minX + 1, bh = maxY - minY + 1;
        const grid = new Int32Array(bw * bh).fill(-1);
        for (let k = 0; k < px.length; k++) grid[(ys[k] - minY) * bw + (xs[k] - minX)] = k;
        const at = (x, y) => {
          const gx = x - minX, gy = y - minY;
          if (gx < 0 || gy < 0 || gx >= bw || gy >= bh) return -1;
          return grid[gy * bw + gx];
        };

        // Ground per small cell, and how much edge each pair of them shares.
        const weight = new Float64Array(px.length);
        for (let k = 0; k < px.length; k++) weight[k] = rowArea[(px[k] / width) | 0];

        const fineArea = new Float64Array(nFine);
        const adjacency = Array.from({ length: nFine }, () => new Map());
        for (let k = 0; k < px.length; k++) {
          const a = fine[k];
          fineArea[a] += weight[k];
          for (const j of [at(xs[k] + 1, ys[k]), at(xs[k], ys[k] + 1)]) {
            if (j < 0) continue;
            const b = fine[j];
            if (b === a) continue;
            adjacency[a].set(b, (adjacency[a].get(b) || 0) + 1);
            adjacency[b].set(a, (adjacency[b].get(a) || 0) + 1);
          }
        }

        const grown = agglomerate({
          fine, nFine, area: fineArea, adjacency, n, rand: xorshiftFor(seed),
        });
        const owner = grown.owner;
        const pieces = grown.n;

        // The middle of each subregion, for the one case that needs a distance:
        // a pool of water walled in by land, with no neighbour to be given to.
        const cx = new Float64Array(pieces), cy = new Float64Array(pieces), cn = new Float64Array(pieces);
        for (let k = 0; k < px.length; k++) {
          cx[owner[k]] += xs[k]; cy[owner[k]] += ys[k]; cn[owner[k]]++;
        }
        for (let k = 0; k < pieces; k++) if (cn[k]) { cx[k] /= cn[k]; cy[k] /= cn[k]; }

        const mend = mendPieces({ owner, xs, ys, at, n: pieces, cx, cy });
        mendedPx += mend.mended;
        strandedPx += mend.stranded;

        // And once more after folding the slivers away, since a fold can leave
        // the piece that swallowed one reaching round a headland.
        dissolved += dissolveTiny({ owner, xs, ys, at, n: pieces, cx, cy, weight }).dissolved;
        mendedPx += mendPieces({ owner, xs, ys, at, n: pieces, cx, cy }).mended;

        // And the necks: two lobes of one subregion hanging together by a few
        // pixels of water, which is connected and so invisible to mendPieces.
        const pinch = pinchOff({ owner, xs, ys, at, n: pieces });
        pinchedPx += pinch.cut;
        pinchedLobes += pinch.lobes;

        // What each piece came out as.
        const made = [];
        for (let k = 0; k < grown.n; k++) {
          made.push({ px: [], area: 0, sx: 0, sy: 0, hist: new Float64Array(DEPTH_BANDS.length + 1) });
        }
        for (let k = 0; k < px.length; k++) {
          const s = made[owner[k]];
          const i = px[k];
          const y = (i / width) | 0;
          s.px.push(i);
          s.area += rowArea[y];
          s.sx += xs[k]; s.sy += y;
          const gy = y + MAP_NORTH_ROW;
          const e = gy >= 0 && gy < globe.height ? elev.px[gy * globe.width + (i % width)] : 0;
          s.hist[bandCode.get(e) || 0] += rowArea[y];
        }

        let part = 0;
        for (const s of made) {
          if (!s.px.length) continue;         // a centre nothing chose
          part++;
          const sd = readDepth(s.hist);
          const cxi = (s.sx / s.px.length + shift) % width;
          const cyi = s.sy / s.px.length;
          // Unique across the whole table, not just within the region. The
          // sequence is per region and a region can be generated more than once
          // across a run, so the plain name collided five times and the reader
          // silently dropped the second of each pair — leaving colours in the
          // bitmap that the table did not list.
          const id = uniqueWithin(`${r.id}_${part}`, takenIds);
          const ord = subs.length + 1;
          for (const i of s.px) owned[i] = ord;
          subs.push({
            id,
            name: `${r.name} ${part}`,
            region: r.id,
            // Arctic, Strait and Lake belong to the region, so every subregion of
            // one carries them. None is ever marked a piece at a time.
            tags: [...(r.tags || [])],
            lake: !!r.lake,
            depth: sd.band,
              area: Math.round(s.area),
            centre: [
              Number(toDegrees(mapLatAt(cyi)).toFixed(4)),
              Number(toDegrees(mapLonAt(cxi, width)).toFixed(4)),
            ],
          });
        }
      }

      const colours = countyColours(subs.length, [...byColour.keys(), parseHex(table.landColour || '#ffffff')]);
      subs.forEach((s, k) => { s.colour = hex(colours[k + 1]); });

      const areas = subs.map((s) => s.area).sort((a, b) => a - b);
      const shallowN = subs.filter((s) => isShallow(s.depth)).length;
      console.log(`  regions       ${regions.length}, cut at one size everywhere: ${TARGET_AREA.toLocaleString()} km2 a piece`);
      console.log(`  subregions    ${subs.length.toLocaleString()}`
        + `  (${shallowN} shallow, ${subs.length - shallowN} deep)`);
      console.log(`  area km2      min ${areas[0].toLocaleString()},`
        + ` median ${areas[areas.length >> 1].toLocaleString()},`
        + ` max ${areas[areas.length - 1].toLocaleString()}`);
      console.log(`  mended        ${mendedPx.toLocaleString()} px moved to keep every piece in one piece`
        + `${strandedPx ? `, ${strandedPx.toLocaleString()} px in pools cut off by land, given to the nearest` : ''}`);
      if (pinchedLobes) console.log(`  necks         ${pinchedLobes} lobe(s) hanging by a thread cut off, ${pinchedPx.toLocaleString()} px handed to a neighbour`);
      if (dissolved) console.log(`  dissolved     ${dissolved} piece(s) under ${MIN_PIECE_PX}px folded into the neighbour they shared most edge with`);
      if (capped) console.log(`  short         ${capped} region(s) had too few pixels on the game map to divide as far as asked`);
      if (noDepth) console.log(`  no depth      ${noDepth} region(s) are above sea level and painted in no band; taken as shallow`);
      console.log(`  read in       ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      if (WRITE) {
        const out = new Int32Array(width * height).fill(parseHex(table.landColour || '#ffffff'));
        for (let i = 0; i < out.length; i++) if (owned[i]) out[i] = colours[owned[i]];

        // A COPY FIRST, ALWAYS. This draws the bitmap from nothing, and the bitmap
        // is hand-edited — that is the whole reason --sea-subs exists beside it.
        // Run without the copy it destroyed a set of touch-ups outright, with no
        // way back short of the filesystem's own history.
        if (fs.existsSync(SUBS_PNG)) {
          const backup = SUBS_PNG.replace(/.png$/, '.before-regen.png');
          fs.copyFileSync(SUBS_PNG, backup);
          console.log(`  the previous bitmap is kept as ${path.basename(backup)}`);
        }
        fs.writeFileSync(SUBS_PNG, encodePNG(width, height, out));
        table.subregions = subs;
        writeJSON(SEA_JSON, table);
        console.log(`  wrote ${path.relative(process.cwd(), SUBS_PNG)} and the subregions into ${path.relative(process.cwd(), SEA_JSON)}`);
      } else {
        console.log(`  --write to save ${path.relative(process.cwd(), SUBS_PNG)} and the table`);
      }
    }
  }
}

/**
 * Reads a hand-edited sea_subregions.png back into the table.
 *
 * SEPARATE FROM --regen-sea-subs, and the same split counties.png has. Once the
 * bitmap has been touched up it is the authority, and regenerating would draw it
 * again from nothing and throw the edits away. This never writes the image: it
 * reads the colours off it and makes the table say what the picture says.
 *
 * Only the id and the name are kept from the old table, because only those two
 * are typed in. Everything else — which region it belongs to, its area, its
 * centre, how deep it is — is measured off the map again, so moving a boundary
 * moves the numbers with it.
 */
if (SUBS && !SUBS_REGEN) {
  const need = [SUBS_PNG, SEA_PNG, SEA_GLOBE, SEA_ELEVATION, SEA_JSON].filter((p) => !fs.existsSync(p));
  if (need.length) {
    console.log(`\nsea subregions: ${need.map((p) => path.relative(process.cwd(), p)).join(', ')} not found, skipped.`);
    console.log(`  --regen-sea-subs to draw them for the first time.`);
  } else {
    const width = img.width, height = img.height;
    const drawn = decodePNG(SUBS_PNG);
    const shapes = decodePNG(SEA_PNG);
    const globe = decodePNG(SEA_GLOBE);
    const elev = decodePNG(SEA_ELEVATION);
    const table = JSON.parse(fs.readFileSync(SEA_JSON, 'utf8'));

    if (drawn.width !== width || drawn.height !== height) {
      console.log(`\nsea subregions: the bitmap is ${drawn.width}x${drawn.height}, not ${width}x${height}. Skipped.`);
    } else {
      console.log(`\nsea subregions`);
      const t0 = Date.now();

      const regionAt = new Map((table.regions || []).map((r) => [parseHex(r.colour), r]));
      const old = new Map((table.subregions || []).map((s) => [parseHex(s.colour), s]));
      const land = parseHex(table.landColour || '#ffffff');

      const cProj = makeProjection({ width, height, globeHeight: MAP_GLOBE_HEIGHT, northRow: MAP_NORTH_ROW });
      const rowArea = new Float64Array(height);
      for (let y = 0; y < height; y++) rowArea[y] = cProj.areaOfPixel(y);
      const bandCode = new Map(DEPTH_BANDS.map(([c], i) => [c, i + 1]));

      const found = new Map();
      let uncoloured = 0, onLand = 0;
      for (let y = 0; y < height; y++) {
        const w = rowArea[y];
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const region = regionAt.get(shapes.px[i]);
          const c = drawn.px[i];
          if (!region) { if (c !== land) onLand++; continue; }
          if (c === land) { uncoloured++; continue; }

          let s = found.get(c);
          if (!s) {
            s = {
              n: 0, area: 0, sx: 0, sy: 0, coastal: false,
              hist: new Float64Array(DEPTH_BANDS.length + 1), regions: new Map(),
            };
            found.set(c, s);
          }
          s.n++; s.area += w; s.sx += x; s.sy += y;

          // Coastal: any of the four pixels around this one is land in
          // provinces.png. Read at the shared edge of the two bitmaps, so the
          // sea file and the province file cannot disagree about where a coast
          // is. The row above and below stop at the map edge. The columns wrap,
          // because the map does.
          if (!s.coastal) {
            const left = y * width + (x > 0 ? x - 1 : width - 1);
            const right = y * width + (x + 1 < width ? x + 1 : 0);
            const up = y > 0 ? i - width : -1;
            const down = y + 1 < height ? i + width : -1;
            for (const j of [left, right, up, down]) {
              if (j >= 0 && img.px[j] !== oceanKey) { s.coastal = true; break; }
            }
          }
          s.regions.set(region.id, (s.regions.get(region.id) || 0) + w);
          const gy = y + MAP_NORTH_ROW;
          const e = gy >= 0 && gy < globe.height ? elev.px[gy * globe.width + x] : 0;
          s.hist[bandCode.get(e) || 0] += w;
        }
      }

      // Everything but the id and the name, which take two passes below.
      const subs = [];
      let split = 0;
      for (const [c, s] of found) {
        let take = null, most = -1;
        for (const [id, v] of s.regions) if (v > most) { most = v; take = id; }
        if (s.regions.size > 1) split++;

        const region = (table.regions || []).find((r) => r.id === take);
        const sd = readDepth(s.hist);
        subs.push({
          id: null,
          name: null,
          region: take,
          regionName: region ? region.name : take,
          // Coastal or Open, on top of whatever the region carries. Every
          // subregion of a Gulf counts as Coastal, whether or not it touches a
          // land province; see Gulfs.
          tags: [
            ...((region && region.tags) || []),
            s.coastal || (region && (region.tags || []).includes('Gulf')) ? 'Coastal' : 'Open',
          ],
          lake: !!(region && region.lake),
          depth: sd.band,
          area: Math.round(s.area),
          centre: [
            Number(toDegrees(mapLatAt(s.sy / s.n)).toFixed(4)),
            Number(toDegrees(mapLonAt(s.sx / s.n, width)).toFixed(4)),
          ],
          colour: hex(c),
          was: old.get(c) || null,
        });
      }

      // THE COUNTY RULE, which already worked and which this should have been
      // from the start. A colour still on the map keeps the id and name it had,
      // and the highest number used in each sea is remembered; a colour that has
      // appeared since takes the next free number there. Nothing is suffixed, so
      // an id is always `sea_N` and its name always `Sea N`, and the two agree.
      //
      // The one addition is the guard on the pattern. Earlier runs of mine wrote
      // ids like `gwerinlur_strait_1_2` into the table, and simply keeping what a
      // colour had would preserve that for ever. Anything not of the form
      // `sea_N`, and anything clashing with an id already taken, is renumbered
      // instead. Names here are all generated, so nothing typed by hand is lost.
      const taken = new Set();
      const highest = new Map();
      for (const u of subs) {
        const prev = u.was;
        if (!prev) continue;
        const m = new RegExp(`^${u.region}_(\\d+)$`).exec(prev.id || '');
        if (!m || taken.has(prev.id)) continue;
        u.id = prev.id;

        // A GENERATED NAME IS ONE ENDING IN ITS OWN ID'S NUMBER, whatever comes
        // before it. Testing it against the region's CURRENT name instead was
        // wrong twice over: it left `north_sea_13` called "North Sea 14" when the
        // two had drifted, and it froze every name in a region the moment the
        // region was renamed, because "East Kontarian Ocean 100" no longer looked
        // generated once its sea had become the West Kontarian.
        //
        // Anything whose trailing number does not match the id, or which has no
        // trailing number at all, was typed by hand and is kept untouched.
        const tail = /\s(\d+)$/.exec(prev.name || '');
        const generated = tail && tail[1] === m[1];
        u.name = !prev.name || generated ? `${u.regionName} ${m[1]}` : prev.name;

        taken.add(u.id);
        highest.set(u.region, Math.max(highest.get(u.region) || 0, Number(m[1])));
      }

      let fresh = 0, renumbered = 0;
      for (const u of subs) {
        if (u.id) continue;
        const n = (highest.get(u.region) || 0) + 1;
        highest.set(u.region, n);
        u.id = `${u.region}_${n}`;
        u.name = `${u.regionName} ${n}`;
        taken.add(u.id);
        if (u.was) renumbered++; else fresh++;
      }
      for (const u of subs) { delete u.was; delete u.regionName; }

      const kept = subs.length - fresh - renumbered;
      const added = fresh;

      const gone = (table.subregions || []).filter((s) => !found.has(parseHex(s.colour)));
      const areas = subs.map((s) => s.area).sort((a, b) => a - b);
      console.log(`  read          ${subs.length.toLocaleString()} subregions from ${path.relative(process.cwd(), SUBS_PNG)}`);
      console.log(`  changed       ${gone.length} gone, ${added} new, ${kept} kept with their names`
        + `${renumbered ? `, ${renumbered} renumbered off a malformed id` : ''}`);
      console.log(`  area km2      min ${areas[0].toLocaleString()},`
        + ` median ${areas[areas.length >> 1].toLocaleString()},`
        + ` max ${areas[areas.length - 1].toLocaleString()}`);
      console.log(`  depth         ${subs.filter((s) => isShallow(s.depth)).length} shallow, ${subs.filter((s) => !isShallow(s.depth)).length} deep`);
      console.log(`  reach         ${subs.filter((s) => s.tags.includes('Coastal')).length} coastal, ${subs.filter((s) => s.tags.includes('Open')).length} open`);
      if (split) {
        console.log(`  across        ${split} subregion(s) have pixels in more than one sea region;`
          + ` each is filed under whichever it has most of`);
      }
      if (uncoloured) console.log(`  gaps          ${uncoloured.toLocaleString()} px of sea are left white in the bitmap and belong to nothing`);
      if (onLand) console.log(`  spill         ${onLand.toLocaleString()} px are coloured where sea.png says there is no sea`);
      console.log(`  read in       ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      if (WRITE) {
        table.subregions = subs;
        writeJSON(SEA_JSON, table);
        console.log(`  wrote ${path.relative(process.cwd(), SEA_JSON)}, ${path.relative(process.cwd(), SUBS_PNG)} untouched`);
      } else {
        console.log(`  --write to save the table.`);
      }
    }
  }
}

// --------------------------------------------------------------- the rivers

/**
 * Lifts the rivers out of true_water_bodies_and_rivers.png into their own layer.
 *
 * That file holds two things and the map wants one of them. Rivers are drawn in
 * a single blue; every other kind of water is white, which is the ocean over
 * three quarters of the file and inland lakes within provinces over the rest.
 * Only the blue is taken. A lake belongs to the province around it and is drawn
 * as that province, so tracing it in river ink would put a hole in a country
 * that does not have one.
 *
 * WRITTEN OUT RATHER THAN FILTERED IN THE BROWSER, and for the same reason the
 * cities and the map cache are: the page would otherwise decode a second
 * 15.9-million-pixel image and walk every pixel of it before it could draw
 * anything. What it gets instead is a file that is almost entirely transparent,
 * which deflates to very little and which createImageBitmap can hand to the GPU
 * without the main thread ever seeing the pixels.
 *
 * The colour is baked in here rather than tinted at draw time, because tinting
 * a bitmap on a canvas means compositing the whole thing every frame. Change
 * RIVER_INK and run this again.
 */
const RIVER_INK = 0x0b1a2b;          // deep, dark, very nearly black blue

if (RIVERS) {
  if (!fs.existsSync(RIVERS_PNG)) {
    console.log(`\nrivers: ${path.relative(process.cwd(), RIVERS_PNG)} not found, skipped.`);
  } else {
    const src = decodePNG(RIVERS_PNG);
    if (src.width !== img.width || src.height !== img.height) {
      console.log(`\nrivers: the file is ${src.width}x${src.height}, not ${img.width}x${img.height}. Skipped.`);
    } else {
      const RIVER_BLUE = 0x3aa5d2, WATER_WHITE = 0xffffff;
      const n = src.width * src.height;

      // A lake INSIDE a province, which is white in the water file and simply
      // ground in provinces.png. The ocean is the same white; what separates
      // them is whether a province is drawn there.
      const table = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
      const known = new Set(table.provinces.map((p) => parseHex(p.colour)));
      const riverAt = new Uint8Array(n);
      const lakeAt = new Uint8Array(n);
      let drawn = 0, lakePx = 0;
      for (let i = 0; i < n; i++) {
        if (src.px[i] === RIVER_BLUE) { riverAt[i] = 1; drawn++; }
        else if (src.px[i] === WATER_WHITE && known.has(img.px[i])) { lakeAt[i] = 1; lakePx++; }
      }

      const bridge = bridgeLakeRivers({ riverAt, lakeAt, width: src.width, height: src.height });

      const out = new Int32Array(n);          // RIVER_INK everywhere; only alpha decides
      const alpha = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = RIVER_INK;
        if (riverAt[i] || bridge.added[i]) alpha[i] = 255;
      }

      const b = bridge.stats;
      console.log(`\nrivers`);
      console.log(`  source        ${path.relative(process.cwd(), RIVERS_PNG)}, ${src.width}x${src.height}`);
      console.log(`  river pixels  ${drawn.toLocaleString()}`
        + ` (${(100 * drawn / n).toFixed(3)}% of the map) in ${hex(RIVER_INK)}`);
      console.log(`  inland lakes  ${b.lakes.toLocaleString()} of them, ${lakePx.toLocaleString()} px,`
        + ` too small or too dull to be on the province map`);
      console.log(`  bridged       ${b.bridged.toLocaleString()} carried a river across`
        + ` (${b.arms.toLocaleString()} arms joined through the middle),`
        + ` ${b.oneArm.toLocaleString()} left alone with one arm`);
      console.log(`  drawn across  ${b.painted.toLocaleString()} px`
        + `${b.unreachable ? `, ${b.unreachable} arm(s) the water did not connect` : ''}`);
      drawn += b.painted;

      if (!drawn) {
        console.log(`  nothing in ${hex(RIVER_BLUE)} anywhere in the file — nothing written.`);
      } else if (WRITE) {
        const buf = encodePNG(src.width, src.height, out, (i) => alpha[i]);
        fs.writeFileSync(RIVER_LAYER_PNG, buf);
        console.log(`  wrote ${path.relative(process.cwd(), RIVER_LAYER_PNG)}`
          + `  (${(buf.length / 1024).toFixed(0)} KB)`);
      } else {
        console.log(`  --write to save ${path.relative(process.cwd(), RIVER_LAYER_PNG)}`);
      }
    }
  }
}

// --------------------------------------------------------------- the cities

/** Makes an id unique within `taken` by appending _2, _3 and so on. */
/**
 * Escapes a string for use inside a RegExp.
 *
 * A declaration rather than a const, because it is called from the sea-subregion
 * pass further up the file and a const is not hoisted.
 */
function escapeRe(t) {
  return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueWithin(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

/**
 * The id and the name of one subregion, which are the same number twice.
 *
 * A subregion keeps both of the ones it had, and keeps them only if BOTH are
 * still free. Anything else drifts: taking the old id and a fresh name, or the
 * reverse, gives `gwerinlur_strait_1_2` called "Gwerinlur Strait 4", which is
 * unique and unreadable and no help to anyone trying to find it in the table.
 *
 * When it cannot keep them it takes the lowest number in its own sea where the
 * id and the name are both unused, so the pair always agree.
 */
function naming(was, regionId, regionName, seq, takenIds, takenNames) {
  if (was && !takenIds.has(was.id) && !takenNames.has(was.name)) {
    takenIds.add(was.id);
    takenNames.add(was.name);
    return { id: was.id, name: was.name };
  }
  let n = Math.max(1, seq || 1);
  while (takenIds.has(`${regionId}_${n}`) || takenNames.has(`${regionName} ${n}`)) n++;
  const id = `${regionId}_${n}`, name = `${regionName} ${n}`;
  takenIds.add(id);
  takenNames.add(name);
  return { id, name };
}

/**
 * Turns data/img/cities.png into data/json/cities.json.
 *
 * The bitmap holds one pixel per city — black for a capital, mid-grey for an
 * ordinary city — and its position, read against provinces.png, says which
 * province the city stands in. The browser never sees cities.png: extracting
 * here means the page loads a few kilobytes of JSON instead of decoding a
 * second 15.9-million-pixel image, exactly as with the map cache.
 *
 * Cities are matched to the existing file BY POSITION, so names and anything
 * else you have filled in survive a redraw. A mark that has shifted a little is
 * treated as the same city moving rather than as one vanishing and another
 * appearing — see CITY_MOVE_TOLERANCE.
 */
if (CITIES) {
  if (!fs.existsSync(CITIES_PNG)) {
    console.log(`\ncities: ${path.relative(process.cwd(), CITIES_PNG)} not found, skipped.`);
  } else {
    const cityImg = decodePNG(CITIES_PNG);

    if (cityImg.width !== img.width || cityImg.height !== img.height) {
      console.log(`\ncities: cities.png is ${cityImg.width}x${cityImg.height} but provinces.png is ` +
        `${img.width}x${img.height}. They must match — a mark's position IS its location.`);
    } else {
      // --- read the marks. Opacity, not colour, tells a capital from the
      //     background: a palette PNG can hold black twice, once of each.
      const marks = [];
      for (let y = 0; y < cityImg.height; y++) {
        for (let x = 0; x < cityImg.width; x++) {
          const i = y * cityImg.width + x;
          if (cityImg.alpha[i] === 0) continue;
          const kind = CITY_MARKS[cityImg.px[i]];
          if (kind) marks.push({ x, y, kind });
        }
      }

      // --- which province each one stands in
      const provinceOf = new Map(table.provinces.map((p) => [parseHex(p.colour), p]));
      for (const m of marks) {
        const p = provinceOf.get(img.px[m.y * img.width + m.x]);
        m.province = p ? p.id : null;
        m.provinceName = p ? p.name : null;
        m.owner = p ? p.owner : null;
      }

      // --- reconcile against what is already on disk
      const before = fs.existsSync(CITIES_JSON)
        ? (JSON.parse(fs.readFileSync(CITIES_JSON, 'utf8')).cities || []) : [];
      const unclaimed = [...before];
      const claim = (test) => {
        const i = unclaimed.findIndex(test);
        return i < 0 ? null : unclaimed.splice(i, 1)[0];
      };

      // Exact position first, in a pass of its own, so a city that has not moved
      // always matches itself before a neighbour can be claimed on its behalf.
      for (const m of marks) m.was = claim((c) => c.x === m.x && c.y === m.y);
      for (const m of marks) {
        if (m.was) continue;
        m.was = claim((c) => Math.abs(c.x - m.x) <= CITY_MOVE_TOLERANCE
          && Math.abs(c.y - m.y) <= CITY_MOVE_TOLERANCE);
        if (m.was) m.moved = true;
      }

      const takenCityIds = new Set();
      const cityReslugged = [];
      const built = marks.map((m, at) => {
        // A city new to the bitmap is named after the province it stands in.
        // Provinces here are named for their city as often as not, so that is
        // usually right already, and obvious to correct when it is not.
        const name = m.was?.name ?? m.provinceName ?? 'Unnamed City';

        // An id, once given, is kept — the same reasoning as for provinces: it
        // is what a save or an event refers to, so renaming a city should not
        // quietly break anything pointing at it. --reslug is how you ask for it
        // to be brought back in line with the name.
        const id = uniqueWithin(m.was && !RESLUG ? m.was.id : slugify(name), takenCityIds);
        if (m.was && id !== m.was.id) cityReslugged.push({ from: m.was.id, to: id });

        return {
          at,
          was: m.was,
          city: { id, name, capital: m.kind === 'capital', x: m.x, y: m.y, province: m.province },
        };
      });

      // Output order: the same rule the provinces above follow. A city already
      // in the file keeps its position, and new ones go at the end.
      //
      // The marks are read off the bitmap top to bottom, so writing them in that
      // order puts every new city wherever it happens to fall geographically,
      // and the ones still carrying their province's name as a placeholder are
      // scattered through the file. Appending puts the entries that need naming
      // together at the bottom, and leaves the diff to just those lines.
      const wasAt = new Map(before.map((c, i) => [c, i]));
      const rank = (e) => (e.was ? wasAt.get(e.was) : before.length + e.at);
      const cities = built.sort((a, b) => rank(a) - rank(b)).map((e) => e.city);

      const added = marks.filter((m) => !m.was).length;
      const moved = marks.filter((m) => m.moved).length;
      const orphans = cities.filter((c) => !c.province);

      console.log(`\ncities        ${cities.length}  (${cities.filter((c) => c.capital).length} capital, ` +
        `${added} new, ${moved} moved, ${unclaimed.length} gone)`);

      if (orphans.length) {
        console.log(`  ${orphans.length} mark(s) sit on no known province and will not render:`);
        for (const c of orphans.slice(0, 8)) console.log(`    ${c.x},${c.y}`);
      }

      // Two capitals for one polity is legal — a dual monarchy, or a seat of
      // state apart from a seat of government — so this is reported, not fixed.
      const capitalsBy = new Map();
      for (const m of marks.filter((m) => m.kind === 'capital' && m.owner)) {
        capitalsBy.set(m.owner, [...(capitalsBy.get(m.owner) || []), m.provinceName]);
      }
      for (const [owner, names] of capitalsBy) {
        if (names.length > 1) console.log(`  note: ${owner} has ${names.length} capitals — ${names.join(', ')}`);
      }

      if (unclaimed.length) {
        console.log(`  no longer in the bitmap, dropped: ${unclaimed.map((c) => c.name).join(', ')}`);
      }

      if (cityReslugged.length) {
        console.log(`  ids regenerated from names (${cityReslugged.length}):`);
        for (const r of cityReslugged.slice(0, 12)) console.log(`    ${String(r.from).padEnd(20)} -> ${r.to}`);
        if (cityReslugged.length > 12) console.log(`    ... and ${cityReslugged.length - 12} more`);
      }

      if (WRITE) {
        writeJSON(CITIES_JSON, { cities });
        console.log(`  wrote ${path.relative(process.cwd(), CITIES_JSON)}`);
      } else {
        console.log(`  (dry run — pass --write to save cities.json)`);
      }
    }
  }
}

// ------------------------------------------------------------- the sea regions
//
// sea.png is provinces.png for water: one flat colour per sea region, at the
// same size, with the background colour standing for land. It is read on the
// same terms, so redrawing it keeps every name and tag already typed in, and a
// region is matched by colour rather than by position.
//
// Regions only. Subregions are generated from these later and are not in this
// file. sea_elevation.png is not read yet either: it is 4 bits a pixel where
// the decoder above takes 8, and it is needed only to tell shallow water from
// deep, which is a subregion property.

if (SEA) {
  if (!fs.existsSync(SEA_PNG)) {
    console.log(`\nsea: ${path.relative(process.cwd(), SEA_PNG)} not found, skipped.`);
  } else {
    const seaImg = decodePNG(SEA_PNG);

    if (seaImg.width !== img.width || seaImg.height !== img.height) {
      console.log(`\nsea: sea.png is ${seaImg.width}x${seaImg.height} but provinces.png is `
        + `${img.width}x${img.height}. They must match, as a coastline is the edge they share.`);
    } else {
      const oldSea = fs.existsSync(SEA_JSON) ? JSON.parse(fs.readFileSync(SEA_JSON, "utf8")) : {};

      const seaCounts = new Map();
      for (let i = 0; i < seaImg.px.length; i++) seaCounts.set(seaImg.px[i], (seaCounts.get(seaImg.px[i]) || 0) + 1);

      // Whichever colour stands for land, on the rule the ocean colour follows:
      // the one named in the file if it is actually present, else the commonest.
      let landKey = oldSea.landColour ? parseHex(oldSea.landColour) : NaN;
      let landChanged = false;
      if (!seaCounts.has(landKey)) {
        landKey = [...seaCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        landChanged = true;
      }

      // Adjacency by the renderer's own rules: right and below only, wrapping
      // east to west, and a contact shorter than MIN_BORDER_PX counted as a
      // drawing artefact rather than a strait.
      const seaTouch = new Map();
      const seaPixels = new Map();
      const seaAt = new Map();
      const link = (a, b) => {
        if (a === b || a === landKey || b === landKey) return;
        const k = a < b ? `${a}|${b}` : `${b}|${a}`;
        seaTouch.set(k, (seaTouch.get(k) || 0) + 1);
      };
      for (let y = 0; y < seaImg.height; y++) {
        for (let x = 0; x < seaImg.width; x++) {
          const i = y * seaImg.width + x;
          const c = seaImg.px[i];
          if (c !== landKey) {
            seaPixels.set(c, (seaPixels.get(c) || 0) + 1);
            if (!seaAt.has(c)) seaAt.set(c, [x, y]);
          }
          link(c, seaImg.px[x + 1 < seaImg.width ? i + 1 : y * seaImg.width]);
          if (y + 1 < seaImg.height) link(c, seaImg.px[i + seaImg.width]);
        }
      }

      const neighbours = new Map([...seaPixels.keys()].map((c) => [c, new Set()]));
      let seaShort = 0;
      for (const [k, n] of seaTouch) {
        if (n < MIN_BORDER_PX) { seaShort++; continue; }
        const [a, b] = k.split("|").map(Number);
        neighbours.get(a).add(b);
        neighbours.get(b).add(a);
      }

      // Area and centre from the 2:1 globe, exactly as a province is measured.
      let seaMeasured = null, seaNote = "";
      if (!fs.existsSync(SEA_GLOBE)) {
        seaNote = "sea_true_area.png missing, areas left untouched";
      } else {
        const globe = decodePNG(SEA_GLOBE);
        if (globe.width !== globe.height * 2) {
          seaNote = `sea_true_area.png is ${globe.width}x${globe.height}, which is not the 2:1 of a whole globe`;
        } else {
          const proj = makeProjection({ width: globe.width, height: globe.height, globeHeight: globe.height });
          seaMeasured = measure(globe.width, globe.height, globe.px, landKey, proj);
        }
      }

      // Impassable water is out of the sea graph, so it neither joins two regions
      // nor keeps one from being a lake. Read off the authored tags, which are the
      // one thing about a region this script does not derive.
      const seaTagsOf = (r) => (Array.isArray(r.tags) ? r.tags : r.tags ? [r.tags] : []);
      const seaBlocked = new Set((oldSea.regions || [])
        .filter((r) => seaTagsOf(r).includes('Impassable'))
        .map((r) => parseHex(r.colour)));

      const seaOldByColour = new Map((oldSea.regions || []).map((r) => [parseHex(r.colour), r]));
      const seaPresent = (oldSea.regions || []).map((r) => parseHex(r.colour)).filter((k) => seaPixels.has(k));
      const seaKnown = new Set(seaPresent);
      const seaFresh = [...seaPixels.keys()].filter((k) => !seaKnown.has(k))
        .sort((a, b) => seaAt.get(a)[1] - seaAt.get(b)[1] || seaAt.get(a)[0] - seaAt.get(b)[0]);
      seaPresent.push(...seaFresh);

      const seaTaken = new Set();
      if (!RESLUG) for (const r of oldSea.regions || []) if (seaPixels.has(parseHex(r.colour))) seaTaken.add(String(r.id));
      const seaNames = new Set((oldSea.regions || []).map((r) => String(r.name)));
      let seaSeq = 0;
      const nextSeaName = () => {
        let n;
        do { n = `Unnamed Sea ${String(++seaSeq).padStart(2, "0")}`; } while (seaNames.has(n));
        seaNames.add(n);
        return n;
      };

      const seaAdded = [];
      const regions = seaPresent.map((k) => {
        const prev = seaOldByColour.get(k);
        let r;
        if (prev) {
          r = { ...prev, id: RESLUG ? uniqueWithin(slugify(prev.name), seaTaken) : String(prev.id), colour: hex(k) };
        } else {
          const name = nextSeaName();
          r = { id: uniqueWithin(slugify(name), seaTaken), name, colour: hex(k), tags: [] };
          seaAdded.push(r);
        }
        if (!Array.isArray(r.tags)) r.tags = [];

        // DERIVED, rewritten every run. A region bordering no other PASSABLE sea
        // region is a lake, which is the whole of the definition and needs nothing
        // marked by hand. The other tags are authored and are left alone.
        r.lake = [...neighbours.get(k)].every((j) => seaBlocked.has(j));

        const m = seaMeasured && seaMeasured.get(k);
        if (m) {
          r.area = Math.round(m.area);
          r.centre = [Number(m.lat.toFixed(4)), Number(m.lon.toFixed(4))];
        }
        return r;
      });

      const seaStale = (oldSea.regions || []).filter((r) => !seaPixels.has(parseHex(r.colour)));
      if (!PRUNE) regions.push(...seaStale);

      const lakes = regions.filter((r) => r.lake).length;
      console.log(`\nsea regions   ${regions.length}  (${regions.length - seaAdded.length - seaStale.length} kept, ${seaAdded.length} added, ${seaStale.length} stale)`);
      console.log(`land colour   ${hex(landKey)}${landChanged ? "  (auto-detected, sea.json updated)" : ""}`);
      console.log(`sea borders   ${[...seaTouch.values()].filter((n) => n >= MIN_BORDER_PX).length}`
        + `${seaShort ? `  (${seaShort} contact${seaShort > 1 ? "s" : ""} of under ${MIN_BORDER_PX}px ignored)` : ""}`);
      console.log(`lakes         ${lakes}  (bordering no other passable sea region)`);
      if (seaBlocked.size) {
        const shut = regions.filter((r) => r.lake && (neighbours.get(parseHex(r.colour)) || new Set()).size);
        console.log(`impassable    ${seaBlocked.size}  (${shut.length ? shut.map((r) => r.name).join(', ') + ' cut off by it' : 'nothing cut off by it'})`);
      }
      if (seaNote) console.log(`note          ${seaNote}`);

      // A region of a handful of pixels is usually a stroke that missed rather
      // than a pond, so it is worth seeing before it becomes a named sea.
      const specks = regions.filter((r) => (seaPixels.get(parseHex(r.colour)) || 0) < 20 && seaPixels.has(parseHex(r.colour)));
      if (specks.length) {
        console.log(`  ${specks.length} region(s) under 20px, worth checking they are meant to be there:`);
        for (const r of specks) {
          const at = seaAt.get(parseHex(r.colour));
          console.log(`    ${r.colour}  ${String(seaPixels.get(parseHex(r.colour))).padStart(4)} px at (${at[0]}, ${at[1]})`);
        }
      }

      if (WRITE) {
        writeJSON(SEA_JSON, { landColour: hex(landKey), regions });
        console.log(`  wrote ${path.relative(process.cwd(), SEA_JSON)}`);
      } else {
        console.log("  (dry run, pass --write to save sea.json)");
      }
    }
  }
}

// ------------------------------------------------------------------ the counties
//
// The level below provinces, generated rather than drawn. src/counties.js holds
// the algorithm and the reasoning behind every constant in it; this reads the
// four bitmaps it needs, runs it, and reports enough to tell whether the result
// is worth keeping.
//
// A dry run does everything except write, which is the point. Cutting the ground
// layer up is one decision affecting fourteen thousand pieces, and the figures
// below are how it gets checked before any of them exist.

if (COUNTIES) {
  const need = [PNG, GLOBE_PNG, TERRAIN_PNG, CLIMATE_PNG, RIVERS_PNG].filter((f) => !fs.existsSync(f));
  if (need.length) {
    console.log(`\ncounties: missing ${need.map((f) => path.basename(f)).join(", ")}, skipped.`);
  } else {
    const t0 = Date.now();
    const globe = decodePNG(GLOBE_PNG);
    const terrain = decodePNG(TERRAIN_PNG);
    const climate = decodePNG(CLIMATE_PNG);
    const rivers = decodePNG(RIVERS_PNG);
    const width = img.width, height = img.height;

    const wrong = [
      globe.width !== width || globe.height !== MAP_GLOBE_HEIGHT ? `true_area.png is ${globe.width}x${globe.height}, wanted ${width}x${MAP_GLOBE_HEIGHT}` : null,
      terrain.width !== globe.width || terrain.height !== globe.height ? `terrain.png is ${terrain.width}x${terrain.height}` : null,
      climate.width !== globe.width || climate.height !== globe.height ? `climate.png is ${climate.width}x${climate.height}` : null,
      rivers.width !== width || rivers.height !== height ? `true_water_bodies_and_rivers.png is ${rivers.width}x${rivers.height}` : null,
    ].filter(Boolean);
    if (wrong.length) {
      console.log(`\ncounties: ${wrong.join("; ")}.`);
      console.log(`  terrain and climate must match true_area.png; the rivers file must match provinces.png. Skipped.`);
    } else {
      console.log(`\ncounties`);

      // The province index, built here rather than through buildWorld: this needs
      // the per-pixel array and nothing else buildWorld computes.
      const cTable = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
      const oceanKey = parseHex(cTable.oceanColour);
      const atIndex = [null];
      const colourToIndex = new Map();
      for (const p of cTable.provinces) {
        p.index = atIndex.length;
        atIndex.push(p);
        colourToIndex.set(parseHex(p.colour), p.index);
      }
      const provinceAt = new Uint16Array(width * height);
      for (let i = 0; i < img.px.length; i++) {
        const ix = colourToIndex.get(img.px[i]);
        if (ix !== undefined) provinceAt[i] = ix;
      }

      const land = readLandscape({
        provinceAt, width, height, northRow: MAP_NORTH_ROW,
        trueArea: { w: globe.width, h: globe.height, px: globe.px },
        terrain: { px: terrain.px }, climate: { px: climate.px },
        colourToIndex, oceanKey, provinceCount: atIndex.length - 1,
      });
      const seen = land.stats.direct + land.stats.fallback + land.stats.blank;
      console.log(`  landscape     ${(land.stats.direct / seen * 100).toFixed(2)}% read per pixel, `
        + `${(land.stats.fallback / seen * 100).toFixed(2)}% from the province, `
        + `${land.stats.blank.toLocaleString()} px with neither`);

      // The drawn blue is a river. White is water of every other kind, which is
      // the sea over three quarters of the file and inland lakes within provinces.
      //
      // THREE ARRAYS, not one. To the GROWTH the two are the same thing, being
      // something a boundary pays to cross, so it takes them combined. To the
      // COMBAT modifiers they are not: a river is crossed and a lake is skirted,
      // and they carry different figures. So they are also kept apart, and
      // measureWater takes the two separately.
      const RIVER_BLUE = 0x3aa5d2, WATER_WHITE = 0xffffff;
      const riverAt = new Uint8Array(width * height);
      const lakeAt = new Uint8Array(width * height);
      const waterAt = new Uint8Array(width * height);
      let riverPx = 0, lakePx = 0;
      for (let i = 0; i < waterAt.length; i++) {
        const v = rivers.px[i];
        if (v === RIVER_BLUE) { riverAt[i] = 1; waterAt[i] = 1; riverPx++; }
        else if (v === WATER_WHITE && provinceAt[i]) { lakeAt[i] = 1; waterAt[i] = 1; lakePx++; }
      }
      console.log(`  water         ${riverPx.toLocaleString()} river px, ${lakePx.toLocaleString()} inland water px inside provinces`);

      /**
       * A county's border figures as an object keyed by the neighbour's id, or
       * nothing at all when it borders no water.
       *
       * measureWater keys them by the county OBJECT, because on the read path
       * ids are handed out after it runs. Sorted by id here so that two runs
       * over the same bitmap produce the same bytes and a diff reads as the
       * change rather than as the order the scan happened to find things in.
       */
      const bordersOf = (m) => (m && m.size
        ? Object.fromEntries([...m]
          .map(([q, v]) => [q.id, Number(v.toFixed(4))])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
        : undefined);

      /** Likewise a share, absent when there is none of that water in the county. */
      const shareOf = (v) => (v ? Number(v.toFixed(4)) : undefined);

      /** What each run has to say about the four figures. */
      const waterLine = (w) => [
        `  water in      ${w.withRiver.toLocaleString()} counties hold river,`
        + ` ${w.withLake.toLocaleString()} hold lake`,
        `  water borders ${w.riverEdges.toLocaleString()} of ${w.borders.toLocaleString()} shared borders`
        + ` are part river, ${w.lakeEdges.toLocaleString()} part lake`,
        // The figure that says whether the either-side rule earns its place. A
        // river is one pixel wide and snapToRivers gives it to whichever bank
        // reached it first, so on these borders the water lies wholly inside one
        // of the two counties. Reading only the defender's water would give each
        // of them a crossing penalty in one direction and none in the other.
        `  one-sided     ${w.oneSided.toLocaleString()} of those`
        + ` (${(100 * w.oneSided / Math.max(1, w.riverEdges)).toFixed(1)}%)`
        + ` are carried by water lying in one county only`,
      ].join('\n');

      // Every city is a seed, so every city ends up in a county of its own. Read
      // from the table the cities pass already wrote rather than from cities.png,
      // which would mean decoding a second full-size bitmap for 1,229 points.
      let cityAt = null, cityCount = 0, cityOffMap = 0;
      if (fs.existsSync(CITIES_JSON)) {
        cityAt = new Int32Array(width * height);
        const list = JSON.parse(fs.readFileSync(CITIES_JSON, "utf8")).cities || [];
        for (let k = 0; k < list.length; k++) {
          const c = list[k];
          const i = c.y * width + c.x;
          if (c.x < 0 || c.x >= width || c.y < 0 || c.y >= height || !provinceAt[i]) { cityOffMap++; continue; }
          if (cityAt[i]) continue;                 // two cities on one pixel
          cityAt[i] = k + 1;
          cityCount++;
        }
        console.log(`  cities        ${cityCount.toLocaleString()} seeded${cityOffMap ? `, ${cityOffMap} not on land and skipped` : ""}`);
      }

      const edgeDist = provinceEdgeDistance(provinceAt, width, height);

      // How much larger each province is drawn than it is, so an enlarged island
      // is measured at its real size and gets the counties that size deserves.
      const cProj = makeProjection({ width, height, globeHeight: MAP_GLOBE_HEIGHT, northRow: MAP_NORTH_ROW });
      const drawnArea = new Float64Array(atIndex.length);
      for (let y = 0; y < height; y++) {
        const a = cProj.areaOfPixel(y);
        for (let x = 0; x < width; x++) { const ix = provinceAt[y * width + x]; if (ix) drawnArea[ix] += a; }
      }
      const trueRatio = new Float64Array(atIndex.length).fill(1);
      for (let ix = 1; ix < atIndex.length; ix++) {
        const a = atIndex[ix].area;
        if (typeof a === "number" && a > 0 && drawnArea[ix] > 0) trueRatio[ix] = a / drawnArea[ix];
      }

      if (!REGEN) {
        // ------------------------------------------------------ reading the bitmap
        //
        // counties.png is the authority from here on. Paint one county's colour
        // over another and the two merge; move a boundary and the areas follow.
        // Only the id, the name, the railway and the buildings are kept from the
        // table, because only those are typed in; everything else is read back
        // off the map.
        const oldFile = fs.existsSync(COUNTIES_JSON)
          ? JSON.parse(fs.readFileSync(COUNTIES_JSON, "utf8")) : { counties: [] };
        const oldByColour = new Map((oldFile.counties || []).map((c) => [parseHex(c.colour), c]));

        const drawn = decodePNG(COUNTIES_PNG);
        if (drawn.width !== width || drawn.height !== height) {
          console.log(`  counties.png is ${drawn.width}x${drawn.height}, not ${width}x${height}. Skipped.`);
        } else {
          const read = readCounties({
            countyPx: drawn.px, provinceAt, width, height, oceanKey, atIndex,
            terrainAt: land.terrainAt, climateAt: land.climateAt, cityAt,
            trueRatio, areaOfPixel: (y) => cProj.areaOfPixel(y), proj: cProj,
          });
          const counties = read.counties;
          const water = measureWater({ counties, riverAt, lakeAt, width, height });

          const tagOf = new Map(cTable.provinces.map((p) => [p.id, [].concat(p.terrain || [])]));
          const imp = applyAlpine(counties, (id) => (tagOf.get(id) || []).includes(ALPINE));

          // Ids and names survive an edit. A county whose colour is still on the map
          // keeps the one it had; a colour that has appeared since is given the next
          // free number in its province.
          const taken = new Map();
          for (const c of counties) {
            const prev = oldByColour.get(c.colour);
            if (!prev) continue;
            c.id = prev.id;
            c.name = prev.name;
            // Rail is built, not measured. It survives a read-back for the
            // same reason the name does: nothing on any bitmap records it.
            if (prev.rail) c.rail = prev.rail;
            // Buildings likewise, with the pixel their mark stands on. Losing
            // these to a boundary edit would silently demolish every building on
            // the map, so they are carried across with the name.
            for (const b of BUILDING_KINDS) {
              if (!prev[b]) continue;
              c[b] = true;
              if (Array.isArray(prev[b + 'At'])) c[b + 'At'] = prev[b + 'At'];
            }
            const m = /_(\d+)$/.exec(prev.id);
            if (m) taken.set(c.province.id, Math.max(taken.get(c.province.id) || 0, Number(m[1])));
          }
          let fresh = 0;
          for (const c of counties) {
            if (c.id) continue;
            const n = (taken.get(c.province.id) || 0) + 1;
            taken.set(c.province.id, n);
            c.id = `${c.province.id}_${n}`;
            c.name = `${c.province.name} ${n}`;
            fresh++;
          }

          const gone = (oldFile.counties || []).filter((c) => !counties.some((q) => q.colour === parseHex(c.colour)));
          const bare = cTable.provinces.filter((p) => !counties.some((c) => c.province.id === p.id));
          const areas = counties.map((c) => c.area).sort((a, b) => a - b);
          const qq = (f) => Math.round(areas[Math.min(areas.length - 1, Math.floor(f * areas.length))]);

          console.log(`  read          ${counties.length.toLocaleString()} counties from counties.png`);
          console.log(`  changed       ${gone.length} gone, ${fresh} new, ${counties.length - fresh} kept with their names`);
          console.log(`  area km2      min ${Math.round(areas[0]).toLocaleString()}, median ${qq(0.5).toLocaleString()}, max ${Math.round(areas[areas.length - 1]).toLocaleString()}`);
          console.log(`  urban         ${counties.filter((c) => c.urban).length.toLocaleString()}, alpine ${imp.marked.toLocaleString()}`);
          console.log(waterLine(water));

          const p = read.problems;
          if (p.split.length) {
            console.log(`  ACROSS A BORDER  ${p.split.length} county(ies) hold ground in more than one province:`);
            for (const q of p.split.slice(0, 6)) console.log(`      ${hex(q.colour)}  ${q.stray} px outside the province holding most of it`);
            console.log(`      a county belongs to one province; repaint the stray pixels`);
          }
          if (p.onSea.length) {
            console.log(`  OVER THE SEA     ${p.onSea.length} county(ies) cover water:`);
            for (const q of p.onSea.slice(0, 6)) console.log(`      ${hex(q.colour)}  ${q.pixels} px`);
          }
          if (bare.length) {
            console.log(`  NO COUNTY        ${bare.length} province(s) have none: ${bare.slice(0, 6).map((q) => q.name).join(", ")}`);
          }
          if (p.twoCities.length) {
            console.log(`  two cities    ${p.twoCities.length} county(ies) hold more than one city, which the game cannot order separately`);
          }
          if (p.pieces.length) {
            console.log(`  in pieces     ${p.pieces.length} county(ies) are in more than one piece, which is expected where one absorbed an island`);
          }
          console.log(`  read in       ${((Date.now() - t0) / 1000).toFixed(1)}s`);

          if (WRITE) {
            writeJSON(COUNTIES_JSON, {
              oceanColour: hex(oceanKey),
              counties: counties.map((c) => ({
                id: c.id,
                name: c.name,
                colour: hex(c.colour),
                province: c.province.id,
                terrain: [c.terrain, ...(c.urban ? [URBAN] : [])],
                climate: c.climate,
                ...(c.rail ? { rail: c.rail } : {}),
                // Buildings, on the same terms as rail: carried across the read
                // above and written out here. This object is built field by
                // field, so anything not named here is dropped however carefully
                // it was preserved.
                ...Object.fromEntries(BUILDING_KINDS.flatMap((b) => (c[b]
                  ? [[b, true], [b + 'At', c[b + 'At']]]
                  : []))),
                riverShare: shareOf(c.riverShare),
                lakeShare: shareOf(c.lakeShare),
                riverBorders: bordersOf(c.riverBorders),
                lakeBorders: bordersOf(c.lakeBorders),
                area: Math.round(c.area),
                centre: c.centre,
              })),
            });
            console.log(`  wrote ${path.relative(process.cwd(), COUNTIES_JSON)}, counties.png untouched`);
          } else {
            console.log(`  (dry run, pass --write to save counties.json)`);
          }
        }
      } else {

      console.log(`  REGENERATING from scratch. counties.png is redrawn and any edit to it is lost.`);
      const built = generateCounties({
        provinceAt, width, height, northRow: MAP_NORTH_ROW, globeHeight: MAP_GLOBE_HEIGHT,
        atIndex, terrainAt: land.terrainAt, climateAt: land.climateAt,
        waterAt, edgeDist, trueRatio, cityAt,
        maxCounties: MAX_PER_PIECE || MAX_COUNTIES,
      });
      console.log(`  grown         ${built.counties.length.toLocaleString()} counties over ${built.stats.pieces.toLocaleString()} pieces of land`);

      const done = finishCounties({
        countyAt: built.countyAt, counties: built.counties, width, height,
        terrainAt: land.terrainAt, climateAt: land.climateAt,
        areaOfPixel: built.areaOfPixel, proj: built.proj, cosLat: built.cosLat,
      });
      const counties = done.counties;

      // After finishCounties, since merging, engulfing and dissolving all move
      // ground between counties and every one of the four figures is measured
      // over the ground a county ends up with.
      const water = measureWater({ counties, riverAt, lakeAt, width, height });
      const tagOf = new Map(cTable.provinces.map((p) => [p.id, [].concat(p.terrain || [])]));
      const imp = applyAlpine(counties, (id) => (tagOf.get(id) || []).includes(ALPINE));

      const areas = counties.map((c) => c.area).sort((a, b) => a - b);
      const q = (f) => Math.round(areas[Math.min(areas.length - 1, Math.floor(f * areas.length))]);
      const per = new Map();
      for (const c of counties) per.set(c.province.id, (per.get(c.province.id) || 0) + 1);
      const counts = [...per.values()].sort((a, b) => a - b);

      console.log(`  merged        ${done.merged.toLocaleString()} under ${MIN_AREA} km2 absorbed, ${counties.length.toLocaleString()} left`);
      console.log(`  absorbed      ${built.stats.absorbedPieces.toLocaleString()} pieces below the minimum joined a neighbouring county`);
      console.log(`  enclaves      ${done.enclaves.toLocaleString()} shut inside a neighbour and merged with it` + (done.stranded ? `, ${done.stranded} left alone` : ``));
      console.log(`  slivers       ${done.dissolved.toLocaleString()} drawn out into ribbons and dissolved into their neighbours`);
      if (built.stats.uncovered) {
        console.log(`  UNCOVERED     ${built.stats.uncovered} land pixels ended up in no county at all`);
      }
      console.log(`  area km2      min ${Math.round(areas[0]).toLocaleString()}, q1 ${q(0.25).toLocaleString()}, median ${q(0.5).toLocaleString()}, q3 ${q(0.75).toLocaleString()}, max ${Math.round(areas[areas.length - 1]).toLocaleString()}`);
      console.log(`  per province  min ${counts[0]}, median ${counts[counts.length >> 1]}, max ${counts[counts.length - 1]}`);
      console.log(`  ceiling       ${MAX_PER_PIECE || MAX_COUNTIES} per piece; ${built.stats.capped} pieces hit it, `
        + `${built.stats.cappedFrom.toLocaleString()} counties short of what their area asked for`);
      console.log(`  cross cap     ${built.stats.crossCapped} pieces cut smaller for being slow to walk over`);
      console.log(`  split again   ${built.stats.split.toLocaleString()} counties were over their climate's day budget and were cut further`);
      if (built.stats.seedsShort) console.log(`  crowded       ${built.stats.seedsShort} pieces could not fit every seed they were allowed`);
      console.log(`  alpine        ${imp.marked.toLocaleString()} counties, ${imp.fellBack} provinces having no mountains to put it on`);
      console.log(waterLine(water));

      const tally = (f) => {
        const m = new Map();
        for (const c of counties) m.set(f(c), (m.get(f(c)) || 0) + 1);
        return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
      };
      console.log(`  terrain       ${tally((c) => c.terrain)}`);
      console.log(`  climate       ${tally((c) => c.climate)}`);
      // Does the ground add up. Every square kilometre of every province has to
      // be in exactly one county, and the two totals are computed by different
      // routes, so a drift between them is a bug in the apportioning.
      const countyTotal = counties.reduce((a, c) => a + c.area, 0);
      const provinceTotal = atIndex.slice(1).reduce((a, p) => a + (p.area || 0), 0);
      const drift = (countyTotal - provinceTotal) / provinceTotal * 100;
      console.log(`  ground        ${Math.round(countyTotal).toLocaleString()} km2 in counties against `
        + `${Math.round(provinceTotal).toLocaleString()} in provinces, ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}%`);

      const small = counties.filter((c) => c.area < MIN_AREA).length;
      if (small) console.log(`  still small   ${small} counties under ${MIN_AREA} km2, having no neighbour in their province to join`);

      // The figure the sizing exists to control. A county past MAX_CROSS_DAYS is
      // one an army cannot get across in a usable time, which is what makes a
      // front unresponsive, and every one of them is a piece that ran into the
      // ceiling of MAX_COUNTIES before it ran into its target.
      const days = counties.map(daysToCross).sort((a, b) => a - b);
      const over = counties.filter((c) => daysToCross(c) > crossBudget(c));
      console.log(`  days across   median ${days[days.length >> 1].toFixed(1)}, `
        + `q3 ${days[Math.floor(days.length * 0.75)].toFixed(1)}, max ${days[days.length - 1].toFixed(1)}`);
      console.log(`  over budget   ${over.length.toLocaleString()} counties (${(over.length / counties.length * 100).toFixed(2)}%) `
        + `past the days their climate allows`);

      const urban = counties.filter((c) => c.urban);
      const uAreas = urban.map((c) => c.area).sort((a, b) => a - b);
      console.log(`  urban         ${urban.length.toLocaleString()} counties, `
        + `${uAreas.length ? `median ${Math.round(uAreas[uAreas.length >> 1]).toLocaleString()} km2` : 'none'}`);

      console.log(`  largest`);
      for (const c of [...counties].sort((a, b) => b.area - a.area).slice(0, 5)) {
        console.log(`    ${String(Math.round(c.area)).padStart(8)} km2  ${String(Math.round(Math.sqrt(c.area))).padStart(4)} km across  `
          + `${daysToCross(c).toFixed(0).padStart(3)} days  ${c.terrain}, ${c.climate}  in ${c.province.name}`);
      }

      console.log(`  built in      ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      if (WRITE) {
        const colours = countyColours(counties.length, [oceanKey]);

        // Ids first, on the counties themselves, and the rows after. The border
        // figures name a NEIGHBOUR, so every county has to have its id before
        // any row is written; assigning them inside the map left bordersOf
        // reading an id that did not exist yet on three counties in four.
        const seq = new Map();
        for (const c of counties) {
          const n = (seq.get(c.province.id) || 0) + 1;
          seq.set(c.province.id, n);
          c.id = `${c.province.id}_${n}`;
          c.name = `${c.province.name} ${n}`;
        }

        const rows = counties.map((c, k) => {
          return {
            id: c.id,
            name: c.name,
            colour: hex(colours[k + 1]),
            province: c.province.id,
            terrain: [c.terrain, ...(c.urban ? [URBAN] : [])],
            climate: c.climate,
            riverShare: shareOf(c.riverShare),
            lakeShare: shareOf(c.lakeShare),
            riverBorders: bordersOf(c.riverBorders),
            lakeBorders: bordersOf(c.lakeBorders),
            area: Math.round(c.area),
            centre: c.centre,
          };
        });

        const out = new Int32Array(width * height).fill(oceanKey);
        for (let i = 0; i < out.length; i++) {
          const ix = built.countyAt[i];
          if (ix) out[i] = colours[ix];
        }
        fs.writeFileSync(COUNTIES_PNG, encodePNG(width, height, out));
        writeJSON(COUNTIES_JSON, { oceanColour: hex(oceanKey), counties: rows });
        console.log(`  wrote ${path.relative(process.cwd(), COUNTIES_PNG)} and ${path.relative(process.cwd(), COUNTIES_JSON)}`);
      } else {
        console.log(`  (dry run, pass --write to save counties.png and counties.json)`);
      }
      }
    }
  }
}
