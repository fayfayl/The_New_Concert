/*
 * sync-provinces.js — reconcile data/provinces.json with data/provinces.png.
 *
 * Run:  node sync-provinces.js             report only, writes nothing
 *       node sync-provinces.js --write     apply the changes
 *       node sync-provinces.js --reslug    regenerate ids from province names
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
  normaliseTable, buildWorld, buildBorderDistance, computeLabelGeometry,
} from './src/mapdata.js';
import { CACHE_FILE, hashInputs, buildCacheMeta, packCache } from './src/mapcache.js';

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

/** Count shared borders, the same way the game does at load. */
function countBorders(width, height, px, oceanKey) {
  const edges = new Set();
  const coastal = new Set();
  const add = (a, b) => {
    if (a === b) return;
    if (a === oceanKey || b === oceanKey) {
      if (a !== oceanKey) coastal.add(a);
      if (b !== oceanKey) coastal.add(b);
      return;
    }
    edges.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x + 1 < width) add(px[i], px[i + 1]);
      if (y + 1 < height) add(px[i], px[i + width]);
    }
  }
  return { borders: edges.size, coastal: coastal.size };
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
const { borders, coastal } = countBorders(img.width, img.height, img.px, oceanKey);

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
console.log(`borders       ${borders}`);
console.log(`coastal       ${coastal}`);

const nameOf = (k) => {
  const p = provinces.find((q) => parseHex(q.colour) === k);
  return `${String(p.id).padStart(3)} ${String(p.name).padEnd(12)}`;
};

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

if (WRITE) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(table, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), JSON_PATH)}`);
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
      const cities = marks.map((m) => ({
        // A city new to the bitmap is named after the province it stands in.
        // Provinces here are named for their city as often as not, so that is
        // usually right already, and obvious to correct when it is not.
        id: uniqueWithin(m.was?.id ?? slugify(m.provinceName ?? 'city'), takenCityIds),
        name: m.was?.name ?? m.provinceName ?? 'Unnamed City',
        capital: m.kind === 'capital',
        x: m.x,
        y: m.y,
        province: m.province,
      }));

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

      if (WRITE) {
        fs.writeFileSync(CITIES_JSON, JSON.stringify({ cities }, null, 2));
        console.log(`  wrote ${path.relative(process.cwd(), CITIES_JSON)}`);
      } else {
        console.log(`  (dry run — pass --write to save cities.json)`);
      }
    }
  }
}
