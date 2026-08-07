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

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WRITE = process.argv.includes('--write');
const RESLUG = process.argv.includes('--reslug');
const PRUNE = process.argv.includes('--prune');
const DIR = path.join(__dirname, 'data');
const PNG = path.join(DIR, 'provinces.png');
const JSON_PATH = path.join(DIR, 'provinces.json');

// Opt-in speck hunt: --min-size=8 warns about anything under 8 px.
// Off by default, because a small island is a legitimate province.
const MIN_SIZE = Number((process.argv.find((a) => a.startsWith('--min-size=')) || '').split('=')[1]) || 0;

// ------------------------------------------------------------ PNG decoding
// Supports bit depth 8, colour types 0/2/3/4/6, non-interlaced. That covers
// anything a normal paint program will save.

function decodePNG(file) {
  const b = fs.readFileSync(file);
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');

  let pos = 8, w = 0, h = 0, depth = 8, ctype = 2, plte = null, interlace = 0;
  const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'PLTE') plte = data;
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

  // one packed 0xRRGGBB integer per pixel
  const px = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let r, g, bl;
    if (ctype === 3) { const k = flat[i]; r = plte[k * 3]; g = plte[k * 3 + 1]; bl = plte[k * 3 + 2]; }
    else if (ctype === 2) { r = flat[i * 3]; g = flat[i * 3 + 1]; bl = flat[i * 3 + 2]; }
    else if (ctype === 6) { r = flat[i * 4]; g = flat[i * 4 + 1]; bl = flat[i * 4 + 2]; }
    else if (ctype === 0) { r = g = bl = flat[i]; }
    else { r = g = bl = flat[i * 2]; }
    px[i] = (r << 16) | (g << 8) | bl;
  }
  return { width: w, height: h, px };
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

/** "Rødt Fjell" -> "rodt_fjell". Ids are slugs so events can name provinces. */
function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/[åÅ]/g, 'a')
    .toLowerCase()
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
