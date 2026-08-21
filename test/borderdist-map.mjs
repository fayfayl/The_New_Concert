/*
 * The border distance field on the REAL map, at its four edges.
 *
 * The synthetic test next door proves the chamfer wraps. This one asks what the
 * field actually does on Chron, because the two seams that survived every fix
 * are both edges of this array:
 *
 *   - a vertical line at the antimeridian, visible over LAND and not over the
 *     open sea beside it, which is what a step in this field looks like, since
 *     the sea is shaded by a different path that never reads it;
 *   - a horizontal line along the map's bottom cut, where the seeding treats
 *     off-map as a different owner and marks the whole row as a frontier.
 *
 * A frontier is drawn at full strength. A row of them is a line across the map.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { refreshBorderDistance, CHAMFER_ORTH, BORDER_DIST_MAX, OCEAN } from '../src/mapdata.js';

// The decoder the sync script uses, lifted rather than duplicated.
const src = fs.readFileSync('sync-provinces.js', 'utf8');
const a = src.indexOf('function decodePNG(file) {');
let depth = 0, e = a;
for (; e < src.length; e++) {
  if (src[e] === '{') depth++;
  else if (src[e] === '}' && --depth === 0) { e++; break; }
}
const decodePNG = new Function('fs', 'zlib', src.slice(a, e) + '\nreturn decodePNG;')(fs, zlib);

const png = decodePNG('data/img/provinces.png');
const json = JSON.parse(fs.readFileSync('data/json/provinces.json', 'utf8'));
const list = Array.isArray(json) ? json : json.provinces;

// Colour -> index, in the order the JSON lists them; index 0 stays the sea.
const indexOf = new Map();
const atIndex = [null];
for (const p of list) {
  indexOf.set(parseInt(p.colour.slice(1), 16), atIndex.length);
  atIndex.push({ id: p.id, owner: p.owner, occupier: p.occupier });
}

const { width: W, height: H, px } = png;
const provinceAt = new Uint16Array(W * H);
for (let i = 0; i < W * H; i++) provinceAt[i] = indexOf.get(px[i]) ?? OCEAN;

const world = { width: W, height: H, provinceAt, atIndex };
const dist = new Uint8Array(W * H);
const t0 = Date.now();
refreshBorderDistance(world, dist, null);
console.log(`${W}x${H}, field built in ${Date.now() - t0}ms\n`);

const land = (i) => provinceAt[i] !== OCEAN;
const problems = [];

// ---------------------------------------------------------- the antimeridian
// Only land rows count. Sea is seeded to 0 on both sides whatever happens, so
// including it would drown the thing being measured.
const stepAt = (xa, xb) => {
  let n = 0, worst = 0, sum = 0;
  for (let y = 0; y < H; y++) {
    const ia = y * W + xa, ib = y * W + xb;
    if (!land(ia) || !land(ib)) continue;
    const d = Math.abs(dist[ia] - dist[ib]);
    worst = Math.max(worst, d); sum += d; n++;
  }
  return { n, worst, mean: n ? sum / n : 0 };
};

const seam = stepAt(W - 1, 0);
// A handful of ordinary interior columns, for something to compare against.
const control = [1000, 2000, 3000, 4000, 5000].map((x) => stepAt(x, x + 1));
const ctlWorst = Math.max(...control.map((c) => c.worst));
const ctlMean = control.reduce((s, c) => s + c.mean, 0) / control.length;

console.log('the step across the antimeridian, x=5999 to x=0, over land rows only');
console.log(`  ${seam.n} land rows, worst ${seam.worst}, mean ${seam.mean.toFixed(2)}`);
console.log(`  ordinary columns: worst ${ctlWorst}, mean ${ctlMean.toFixed(2)}`);
if (seam.worst > Math.max(ctlWorst, CHAMFER_ORTH * 2)) {
  problems.push(`the antimeridian steps by ${seam.worst} where an ordinary column steps by ${ctlWorst}`);
}

// ------------------------------------------------------- the top and bottom
// Off the top and the bottom of the map is not another country. Seeding those
// rows as frontiers draws them at full strength, straight across the map.
const rowSeeded = (y) => {
  let n = 0, seeds = 0;
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!land(i)) continue;
    n++;
    if (dist[i] === 0) seeds++;
  }
  return { n, seeds, share: n ? seeds / n : 0 };
};

console.log('\nland pixels sitting AT the map cut that are marked as a frontier');
for (const [name, y, inner] of [['top', 0, 1], ['bottom', H - 1, H - 2]]) {
  const edge = rowSeeded(y), next = rowSeeded(inner);
  console.log(`  ${name.padEnd(6)} row ${String(y).padStart(4)}: ${(edge.share * 100).toFixed(1)}%`
    + ` of ${edge.n} land pixels, against ${(next.share * 100).toFixed(1)}% one row in`);
  if (edge.n && edge.share > next.share + 0.25) {
    problems.push(`the ${name} row marks ${(edge.share * 100).toFixed(0)}% of its land as frontier`);
  }
}

console.log(`\nfield saturates at ${BORDER_DIST_MAX}`);
console.log(problems.length ? `\n${problems.length} problem(s):\n  ${problems.join('\n  ')}` : '\nboth edges are clean');
process.exit(problems.length ? 1 : 0);
