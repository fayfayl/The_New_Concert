/*
 * The border distance field across the map seam.
 *
 * The field is a chamfer distance to the nearest frontier, and the map shading
 * is read straight off it. Its SEEDS have always wrapped east to west, so a
 * frontier crossing the seam is marked on both sides. The distances spreading
 * out from those seeds did not, so a pixel in the last column could be told
 * nothing about a frontier just east of the first column: it kept MAX while the
 * pixel beside it across the seam held nearly zero, and that step drew as a hard
 * line down open country at x 5999. On the live map it was one of two seams
 * reported on the live map.
 *
 * The test is a small world with a frontier a few columns east of the seam, and
 * a pixel in the last column that can only reach it by going round.
 */

import {
  refreshBorderDistance, CHAMFER_ORTH, BORDER_DIST_MAX,
} from '../src/mapdata.js';

// Tall, because the top and bottom rows are seeds in their own right — a pole
// really is the end of the map, unlike the seam. A short world is nothing but
// edge, and every pixel in it sits a few rows from a seed.
const W = 64, H = 200;

/** Land throughout, owned by "a", except columns 5..7 which belong to "b". */
function world() {
  const provinceAt = new Uint16Array(W * H).fill(1);
  for (let y = 0; y < H; y++) for (let x = 5; x <= 7; x++) provinceAt[y * W + x] = 2;
  return {
    width: W, height: H, provinceAt,
    atIndex: [null, { id: 'p1', owner: 'a' }, { id: 'p2', owner: 'b' }],
  };
}

const w = world();
const dist = new Uint8Array(W * H);
refreshBorderDistance(w, dist, null);

const row = 100;                                // far from either pole
const at = (x) => dist[row * W + x];

// x=4 and x=8 sit against the frontier and are seeds. From the last column the
// way east is 63 -> 0 -> ... -> 4, five steps; the way west is fifty-five. Only
// the short way crosses the seam.
const problems = [];
const expect = (what, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}: ${got}${ok ? '' : ` (wanted ${want})`}`);
  if (!ok) problems.push(what);
};

console.log(`a frontier at columns 5..7, reading row ${row} of a ${W}x${H} world`);
expect('the frontier itself is a seed, x=4', at(4), 0);
expect('one step east of the seam, x=0', at(0), 4 * CHAMFER_ORTH);
expect('the last column reaches it the short way, x=63', at(63), 5 * CHAMFER_ORTH);
expect('two columns back, x=62', at(62), 6 * CHAMFER_ORTH);

// The point of the whole thing: no step at the seam bigger than one pixel's
// worth. Before the fix this was 165 against 12.
const step = Math.abs(at(63) - at(0));
expect('the step across the seam', step, CHAMFER_ORTH);

// And the far side of the world is still far away, so nothing has been
// flattened into saturation to make the seam go quiet.
const mid = at(36);
console.log(`  note  the far side, x=36: ${mid} of ${BORDER_DIST_MAX}`);
if (!(mid > 20 * CHAMFER_ORTH)) problems.push('the far side stopped being far');

// Every row should read the same: the wrap is not a property of one of them.
for (let y = 90; y < 110; y++) {
  if (dist[y * W + 63] !== at(63)) problems.push(`row ${y} disagrees at x=63`);
}

console.log(problems.length ? `\n${problems.length} problem(s): ${problems.join(', ')}` : '\nthe field wraps');
process.exit(problems.length ? 1 : 0);
