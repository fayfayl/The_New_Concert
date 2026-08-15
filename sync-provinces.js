/*
 * sync-provinces.js — reconcile data/provinces.json with data/provinces.png.
 *
 * Run:  node sync-provinces.js             report only, writes nothing
 *       node sync-provinces.js --write     apply the changes
 *       node sync-provinces.js --reslug    regenerate ids from names, provinces and cities alike
 *       node sync-provinces.js --prune     delete entries no longer in the bitmap
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
 * data/true_area.png; without that file they are left alone.
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
} from './src/mapdata.js';
import { CACHE_FILE, hashInputs, buildCacheMeta, packCache } from './src/mapcache.js';
import { makeProjection, toDegrees } from './src/geo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WRITE = process.argv.includes('--write');
const RESLUG = process.argv.includes('--reslug');
const PRUNE = process.argv.includes('--prune');
const CACHE = process.argv.includes('--cache');
const CITIES = process.argv.includes('--cities');
const DIR = path.join(__dirname, 'data');
const PNG = path.join(DIR, 'provinces.png');
const JSON_PATH = path.join(DIR, 'provinces.json');
const CACHE_PATH = path.join(DIR, CACHE_FILE);
const CITIES_PNG = path.join(DIR, 'cities.png');
const CITIES_JSON = path.join(DIR, 'cities.json');
const STATS_JSON = path.join(DIR, 'province-stats.json');
// The whole world on a 2:1 globe, poles included. Areas are measured from this
// rather than from provinces.png — see the note at the top of src/geo.js.
const GLOBE_PNG = path.join(DIR, 'true_area.png');

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
  if (depth !== 8) throw new Error(`bit depth ${depth} not supported — save as 8 bits per channel`);
  if (interlace) throw new Error('interlaced PNG not supported — save without interlacing');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const stride = w * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const flat = Buffer.alloc(h * stride);

  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? flat[y * stride + x - channels] : 0;
      const up = y > 0 ? flat[(y - 1) * stride + x] : 0;
      const ul = (x >= channels && y > 0) ? flat[(y - 1) * stride + x - channels] : 0;
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
      const k = flat[i];
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

// ------------------------------------------------------------------ helpers

const hex = (k) => '#' + (k >>> 0).toString(16).padStart(6, '0');
const parseHex = (s) => parseInt(String(s).replace(/^#/, ''), 16);

/**
 * Writes JSON indented, but with arrays of plain values kept on one line.
 *
 * JSON.stringify's indenting is right about objects and wrong about these: a
 * pair like [0, 0] becomes four lines, and a file of them is unreadable and
 * unscrollable for no gain. Only arrays holding nothing but scalars are
 * collapsed, and only while they stay short, so a long list still breaks.
 *
 * Done to the text rather than by hand-rolling a serialiser, which means it
 * could in principle mangle a string containing a bracket — so the result is
 * parsed back and compared against what went in, and anything that does not
 * survive that is written the ordinary way instead. The check costs a
 * millisecond and removes the entire class of worry.
 */
function writeJSON(file, value) {
  const plain = JSON.stringify(value, null, 2);

  const packed = plain.replace(/\[\s*([^[\]{}]*?)\s*\]/g, (whole, inner) => {
    if (!inner.trim()) return '[]';
    const flat = inner.split('\n').map((s) => s.trim()).filter(Boolean).join(' ');
    return flat.length <= 72 ? `[${flat}]` : whole;
  });

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
  let borders = 0, tooShort = [];
  for (const [key, n] of touch) {
    if (n >= MIN_BORDER_PX) borders++;
    else tooShort.push(key);
  }
  return { borders, coastal: coastal.size, tooShort };
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
const { borders, coastal, tooShort } = countBorders(img.width, img.height, img.px, oceanKey);

// ------------------------------------------------------ area on the globe
//
// Without true_area.png there is nothing whose rows are latitudes, and an area
// figure would be a guess. Areas are then left exactly as they are in the JSON
// rather than being written wrong.
let projection = null, measured = null, globeNote = '';

if (!fs.existsSync(GLOBE_PNG)) {
  globeNote = 'true_area.png missing — areas left untouched';
} else {
  const globe = decodePNG(GLOBE_PNG);

  // A whole globe, so 360 degrees across and 180 down: twice as wide as it is
  // tall, or the rows do not carry the latitudes this assumes.
  if (globe.width !== globe.height * 2) {
    globeNote = `true_area.png is ${globe.width}x${globe.height}, which is not the 2:1 of a whole globe`;
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
      globeNote = `unrecognised colours in true_area.png, not counted — ${shown}`
        + `${strayColours.length > 5 ? `; and ${strayColours.length - 5} more` : ''}`;
    }

    const unmeasured = [...blobs.keys()].filter((k) => !measured.has(k));
    if (unmeasured.length) {
      globeNote = `${unmeasured.length} province${unmeasured.length > 1 ? 's' : ''} in provinces.png`
        + ' have no pixels in true_area.png and keep their previous area';
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
if (measured) {
  for (const p of provinces) {
    const m = measured.get(parseHex(p.colour));
    if (!m) continue;                      // stale entry, no pixels to measure
    p.area = Math.round(m.area);
    p.centre = [Number(m.lat.toFixed(4)), Number(m.lon.toFixed(4))];
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
  polities: old.polities && old.polities.length ? old.polities : [{ id: 'NONE', name: 'Unclaimed', colour: '#5a5a60' }],
  provinces,
};

// ------------------------------------------------------------------ report

console.log(`bitmap        ${img.width}x${img.height}, ${counts.size} distinct colours`);
console.log(`ocean colour  ${hex(oceanKey)}${oceanChanged ? '  (auto-detected — JSON updated)' : ''}`);
console.log(`provinces     ${provinces.length}  (${kept.length} kept, ${added.length} added, ${stale.length} stale)`);
console.log(`borders       ${borders}`
  + `${tooShort.length ? `  (${tooShort.length} contact${tooShort.length > 1 ? 's' : ''} of under ${MIN_BORDER_PX}px ignored)` : ''}`);
console.log(`coastal       ${coastal}`);

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
  if (globeNote) console.log(`note          ${globeNote}`);
} else if (globeNote) {
  console.log(`area          skipped: ${globeNote}`);
}

const nameOf = (k) => {
  const p = provinces.find((q) => parseHex(q.colour) === k);
  return `${String(p.id).padStart(3)} ${String(p.name).padEnd(12)}`;
};

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
const PAIRED = ['road', 'rail', 'supplyHub', 'fortification', 'electricity', 'antiAir', 'buildingSlots'];

const BLANK_STATS = {
  claims: [],            // polity ids with a claim on this province
  population: 0,
  road: [0, 0],
  rail: [0, 0],
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
};

const oldStats = fs.existsSync(STATS_JSON) ? JSON.parse(fs.readFileSync(STATS_JSON, 'utf8')) : {};
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

if (WRITE) {
  writeJSON(JSON_PATH, table);
  console.log(`\nwrote ${path.relative(process.cwd(), JSON_PATH)}`);
  writeJSON(STATS_JSON, { provinces: statsById });
  console.log(`wrote ${path.relative(process.cwd(), STATS_JSON)}`);
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
    const hash = hashInputs(fs.readFileSync(PNG), raw);

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

    const packed = packCache(buildCacheMeta(world, geometry, hash), world.provinceAt, world.borderDist);
    const gz = zlib.deflateSync(packed, { level: 9 });
    fs.writeFileSync(CACHE_PATH, gz);

    const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
    console.log(`\nwrote ${path.relative(process.cwd(), CACHE_PATH)}`);
    console.log(`  ${mb(packed.length)} packed -> ${mb(gz.length)} deflated, built in ${Date.now() - started} ms`);
    console.log(`  the page skips its own scans while provinces.png and the owners in`);
    console.log(`  provinces.json are unchanged; edit either and it recomputes and warns.`);
  }
}

// --------------------------------------------------------------- the cities

/** Makes an id unique within `taken` by appending _2, _3 and so on. */
function uniqueWithin(base, taken) {
  let id = base, n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

/**
 * Turns data/cities.png into data/cities.json.
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
