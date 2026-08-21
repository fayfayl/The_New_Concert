/*
 * subregions.js — the sea divided into the pieces a fleet moves between.
 *
 * A sea region is drawn by hand in sea.png and is the level trade routes and
 * orders live at. A SUBREGION is generated from it and is the level fleets
 * occupy, move between and fight in, exactly as a county is to a province.
 *
 * TWO THINGS MAKE THIS DIFFERENT FROM THE COUNTY GENERATOR, and both come from
 * what the water is.
 *
 * The first is that the borders are STRAIGHT. A county boundary follows the
 * ground — a ridge, a river, the edge of a marsh — and is drawn with noise in the
 * cost field to keep it from looking surveyed. There is nothing out at sea for a
 * boundary to follow, and every chart ever drawn of open water divides it with
 * ruled lines. So a region is cut by nearest-centre: every pixel joins the centre
 * closest to it, which makes each border the perpendicular bisector of two
 * centres, which is a straight line. Nothing is roughened.
 *
 * The second is that depth is not a property of the region. A sea with a shelf
 * along one coast and abyss in the middle is both, so sea_elevation.png is read
 * per pixel: the region divides at the target for whichever depth most of it is,
 * and each subregion it produces is then shallow or deep on its own account.
 */

/**
 * The five bands sea_elevation.png is painted in, shallowest first.
 *
 * NAMED FOR THE SEAFLOOR, not for the shallow/deep split. Calling a band "Deep"
 * while also calling half the map deep produced tooltips reading "deep · Deep",
 * which is nonsense twice over. These are the real zones — shelf, slope, bathyal,
 * abyssal, hadal — and none of them is a word the split uses.
 *
 * White is not a band. It is everything the file does not describe — land, and
 * the lakes that sit above sea level and so have no depth at all. Those come out
 * with nothing painted in them, which is not a fault in the map: a lake is
 * shallow water and is treated as such.
 */
export const DEPTH_BANDS = [
  [0xb6e1f9, 'Shelf', 'above -100 m'],
  [0x87cefa, 'Slope', '-100 m to -1000 m'],
  [0x4c84b4, 'Bathyal', '-1000 m to -3000 m'],
  [0x04668d, 'Abyssal', '-3000 m to -6000 m'],
  [0x095177, 'Hadal', 'below -6000 m'],
];

/**
 * Where shallow water stops, as an index into DEPTH_BANDS.
 *
 * At the top of the slope rather than at the shelf break. What the distinction
 * is for is submarines, mines, landings and anything that reaches the bottom, and
 * none of those care whether the water is 90 m or 900 m — they care whether it is
 * that or three kilometres.
 */
export const SHALLOW_THROUGH = 2;

/**
 * Whether a band is shallow water. DERIVED, never stored.
 *
 * The band already says how deep the water is, so a second field saying whether
 * that counts as shallow is the same fact written twice — and two ways for the
 * table to disagree with itself. Anything that wants the split asks here.
 */
export const isShallow = (band) => {
  const ix = DEPTH_BANDS.findIndex(([, name]) => name === band);
  return ix < 0 ? true : ix < SHALLOW_THROUGH;   // unpainted is a lake, which is shallow
};

/**
 * How much water one subregion is, in km2. ONE NUMBER, EVERYWHERE.
 *
 * The plan had four targets — lake, strait, shallow, deep — and a ceiling on top
 * of them, and the result was a mess: a strait cut into sixty slivers while an
 * ocean next door was cut into sixty pieces of half a million km2 each. The
 * targets discriminated and the ceiling then overrode them, so neither decided
 * anything and the sizes ran from 1,101 km2 to 492,019.
 *
 * Water is water. A cell is the same size wherever it is, the way a naval region
 * is in every game that has them, and what comes out of nearest-centre at a
 * uniform size is a hexagonal packing — which is what those maps look like, and
 * why they look like that.
 *
 * Depth still matters, but for what a subregion IS rather than how big: every one
 * is shallow or deep by the water in it. It no longer changes the size.
 */
export const TARGET_AREA = 100000;        // about 316 km across

/**
 * A safety rail, not a design. At the uniform target the largest ocean asks for
 * about two hundred and twenty; this is here so a mistake in the table cannot ask
 * for a hundred thousand.
 */
export const MAX_SUBREGIONS = 400;

/**
 * The fewest game-frame pixels a subregion may be made of.
 *
 * A region's area is measured over the whole globe from sea_true_area.png, but
 * its subregions are cut out of the game map, which stops short of both poles. A
 * polar sea can therefore be told to divide into more pieces than it has pixels
 * on screen to divide, and the pieces that came of it would be too small to click.
 */
export const MIN_SUBREGION_PX = 240;
/**
 * How many rounds of Lloyd relaxation to run. ZERO, and that is the point.
 *
 * Lloyd's algorithm moves every centre to the middle of what it owns and repeats,
 * and it converges — provably — on a hexagonal lattice. Fourteen rounds of it did
 * not produce cells that happened to look like hexagons; fourteen rounds of it IS
 * a hexagon generator. Every round makes the map more regular, so there is no
 * setting of this that gives varied shapes except none.
 */
const RELAX_ROUNDS = 0;

/**
 * How close two centres may be, against the spacing an even scatter would use.
 *
 * Well under one, so the spacing genuinely varies: a pair at 0.55 gives two small
 * cells side by side, and the gap they leave elsewhere gives a large one. At 1.0
 * this would be an even scatter again and the hexagons would come back.
 */
const SEED_SEPARATION = 0.55;

/**
 * How much of each depth band each region holds, by area.
 *
 * Read in the TRUE-AREA frame, where sea_elevation.png and sea_true_area.png are
 * the same 6000x3000 picture of the whole globe and line up pixel for pixel, so
 * nothing has to be reprojected and the poles are not counted as though they were
 * the size the game map draws them.
 */
export function depthByRegion({ globePx, elevPx, width, height, colourToId, areaOfRow }) {
  const bandOf = new Map(DEPTH_BANDS.map(([c], i) => [c, i + 1]));
  const out = new Map();

  for (let y = 0; y < height; y++) {
    const w = areaOfRow(y);
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const id = colourToId.get(globePx[i]);
      if (id === undefined) continue;
      let h = out.get(id);
      if (!h) { h = new Float64Array(DEPTH_BANDS.length + 1); out.set(id, h); }
      h[bandOf.get(elevPx[i]) || 0] += w;
    }
  }
  return out;
}

/** Shallow, deep, or nothing painted at all. */
export function readDepth(hist) {
  if (!hist) return { band: null, shallow: true, painted: 0, unpainted: 0 };
  let painted = 0, shallow = 0, best = 0, bestV = 0;
  for (let b = 1; b <= DEPTH_BANDS.length; b++) {
    const v = hist[b];
    painted += v;
    if (b <= SHALLOW_THROUGH) shallow += v;
    if (v > bestV) { bestV = v; best = b; }
  }
  return {
    band: best ? DEPTH_BANDS[best - 1][1] : null,
    // Nothing painted means a lake above sea level, which is shallow water.
    shallow: painted > 0 ? shallow / painted >= 0.5 : true,
    painted,
    unpainted: hist[0],
  };
}

/** How many pieces a region divides into. Its area over the target, and nothing else. */
export function subregionCount({ area, pixels, target = TARGET_AREA }) {
  const wanted = Math.max(1, Math.min(MAX_SUBREGIONS, Math.round(area / target)));
  const affordable = Math.max(1, Math.floor(pixels / MIN_SUBREGION_PX));
  return { n: Math.min(wanted, affordable), wanted, target };
}

/**
 * Cuts one region into `n` pieces with straight borders.
 *
 * Lloyd's algorithm: scatter n centres, give every pixel to the closest one,
 * move each centre to the middle of what it was given, repeat. It settles into
 * pieces of roughly equal size, and because the only rule is "closest centre",
 * every border between two of them is the perpendicular bisector of the pair —
 * a straight line, with no smoothing or tracing needed to make it one.
 *
 * PIXELS ARRIVE ALREADY UNWRAPPED. A sea straddling the antimeridian has pixels
 * at x=5999 and x=3 that are four apart and not five thousand nine hundred, and
 * a centre averaged over the raw columns would land on the far side of the world.
 * The caller shifts the region into a frame where it is contiguous; this works in
 * that frame throughout and never sees the seam.
 */
export function cutStraight({ xs, ys, n, seed = 1, rounds = RELAX_ROUNDS }) {
  const count = xs.length;
  const owner = new Int32Array(count).fill(-1);
  if (n <= 1) return { owner: owner.fill(0), cx: [mean(xs)], cy: [mean(ys)] };

  // THE CENTRES ARE FOUND ON A SAMPLE, and only the last pass touches every
  // pixel. The largest ocean here is seven hundred thousand pixels and divides
  // into sixty, so a full round is forty-two million distances and fourteen of
  // them is six hundred million — for centres that a thirtieth of the pixels
  // place just as well. Where a centre settles is a property of the SHAPE, and
  // every thirtieth pixel describes the same shape.
  const step = Math.max(1, Math.ceil(count / SAMPLE_MAX));
  const m = Math.ceil(count / step);
  const sxs = new Float64Array(m), sys = new Float64Array(m);
  for (let i = 0, k = 0; i < count; i += step, k++) { sxs[k] = xs[i]; sys[k] = ys[i]; }

  // SEEDS ARE SCATTERED, NOT SPREAD. Farthest-point seeding puts them as far
  // from each other as they will go, and relaxing that is a recipe for one
  // answer: a hexagonal lattice, because that is the arrangement Lloyd's
  // algorithm converges to and a hexagon is what an evenly spaced Voronoi cell
  // is. It came out looking like a wargame's hex grid, which is not what a chart
  // of the sea looks like.
  //
  // So the centres go down at random, with nothing but a minimum separation to
  // stop two landing on top of each other, and the separation is well under the
  // spacing an even scatter would have. Some cells come out twice the size of
  // their neighbour, some are long, some are five-sided and some eight — which is
  // what varies the shapes. They are still convex and every border is still a
  // straight bisector; only the regularity is gone.
  //
  // The randomness is a HASH OF THE REGION, not Math.random. Running the
  // generator twice has to give the same map, or every re-run silently redraws
  // every boundary in the sea.
  const rand = xorshift(seed);
  const ideal = Math.sqrt((m * step) / n);       // spacing an even scatter would use
  let sep = ideal * SEED_SEPARATION;

  const cx = [], cy = [];
  for (let s = 0, tries = 0; s < n;) {
    const i = Math.floor(rand() * m) % m;
    const x = sxs[i], y = sys[i];
    let ok = true;
    for (let k = 0; k < cx.length && ok; k++) {
      const dx = x - cx[k], dy = y - cy[k];
      if (dx * dx + dy * dy < sep * sep) ok = false;
    }
    if (ok) { cx.push(x); cy.push(y); s++; tries = 0; continue; }
    // Nowhere left that far from everything: ease the rule rather than spin.
    if (++tries > 40) { sep *= 0.82; tries = 0; }
  }

  const nearest = (x, y) => {
    let best = 0, bestD = Infinity;
    for (let k = 0; k < n; k++) {
      const dx = x - cx[k], dy = y - cy[k];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  };

  const held = new Int32Array(m).fill(-1);
  const sx = new Float64Array(n), sy = new Float64Array(n), sn = new Float64Array(n);
  for (let r = 0; r < rounds; r++) {
    let moved = 0;
    for (let i = 0; i < m; i++) {
      const k = nearest(sxs[i], sys[i]);
      if (held[i] !== k) { held[i] = k; moved++; }
    }
    if (!moved && r) break;

    sx.fill(0); sy.fill(0); sn.fill(0);
    for (let i = 0; i < m; i++) {
      const k = held[i];
      sx[k] += sxs[i]; sy[k] += sys[i]; sn[k]++;
    }
    for (let k = 0; k < n; k++) {
      if (!sn[k]) continue;                 // a centre nothing chose keeps its place
      cx[k] = sx[k] / sn[k];
      cy[k] = sy[k] / sn[k];
    }
  }

  // And now every pixel, once, against the centres those rounds settled on.
  for (let i = 0; i < count; i++) owner[i] = nearest(xs[i], ys[i]);
  return { owner, cx, cy };
}

/** How many pixels the centres are fitted on, however large the region is. */
const SAMPLE_MAX = 30000;

/**
 * Makes every piece one piece.
 *
 * Nearest-centre says nothing about the water being joined up. A sea that bends
 * round a headland can have both ends nearer the same centre than to any other,
 * and the piece that comes out is in two halves with a peninsula between them —
 * one subregion a fleet cannot sail across.
 *
 * Each piece keeps its largest half. Every other half is given to whichever
 * neighbouring piece it shares the most edge with, which REMOVES a border rather
 * than bending one, so the straight lines survive. Repeated, because handing a
 * stray half to a neighbour can leave the neighbour's own stray half to deal
 * with, and it settles in a round or two.
 *
 * A pocket touching NOTHING — a pool of water inside a coastline, cut off from
 * the rest of its region by land — has no neighbour to be given to. It goes to
 * the nearest centre, which is the same rule that placed every other pixel, and
 * leaves it belonging to the subregion it is closest to rather than to nothing.
 */
export function mendPieces({ owner, xs, ys, at, n, cx, cy }) {
  const count = owner.length;
  const seen = new Int32Array(count).fill(-1);
  let mended = 0, stranded = 0;

  for (let round = 0; round < 6; round++) {
    seen.fill(-1);
    const parts = [];                        // [owner, [indices]]
    const stack = [];
    for (let s = 0; s < count; s++) {
      if (seen[s] >= 0) continue;
      const k = owner[s];
      const part = [];
      seen[s] = parts.length;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop();
        part.push(i);
        for (const j of neighbours(i, xs, ys, at)) {
          if (j >= 0 && seen[j] < 0 && owner[j] === k) { seen[j] = parts.length; stack.push(j); }
        }
      }
      parts.push([k, part]);
    }

    // The biggest piece of each owner is the one that keeps the name.
    const biggest = new Map();
    for (let p = 0; p < parts.length; p++) {
      const [k, part] = parts[p];
      const held = biggest.get(k);
      if (!held || part.length > parts[held][1].length) biggest.set(k, p);
    }
    if (parts.length === n) break;            // one piece each, nothing to mend

    let changed = 0;
    for (let p = 0; p < parts.length; p++) {
      const [k, part] = parts[p];
      if (biggest.get(k) === p) continue;

      const touch = new Map();
      for (const i of part) {
        for (const j of neighbours(i, xs, ys, at)) {
          if (j < 0 || owner[j] === k) continue;
          touch.set(owner[j], (touch.get(owner[j]) || 0) + 1);
        }
      }
      let take = -1;
      if (touch.size) {
        let most = -1;
        for (const [q, c] of touch) if (c > most) { most = c; take = q; }
      } else {
        // Cut off from everything. Nearest centre, measured from the middle of
        // the pocket — the same rule that placed every other pixel.
        const px = mean(part.map((i) => xs[i])), py = mean(part.map((i) => ys[i]));
        let bestD = Infinity;
        for (let q = 0; q < n; q++) {
          const dx = px - cx[q], dy = py - cy[q];
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; take = q; }
        }
        stranded += part.length;
      }
      if (take < 0 || take === k) continue;
      for (const i of part) owner[i] = take;
      mended += part.length;
      changed++;
    }
    if (!changed) break;
  }
  return { mended, stranded };
}

/**
 * The fewest pixels a finished subregion may be.
 *
 * MIN_SUBREGION_PX governs how many pieces are ASKED for and so sets the average.
 * Nearest-centre does not divide evenly, though — a centre that lands in a corner
 * of a bay is left with a sliver — and mending moves ground about afterwards. This
 * is the floor on what actually comes out.
 */
export const MIN_PIECE_PX = 80;

/**
 * And the fewest km2, which is the one that matters.
 *
 * A pixel count is not a size on a map whose rows are latitudes: eighty pixels is
 * three and a half thousand km2 at the equator and four hundred at 84 degrees.
 * Going by pixels alone left a piece of the Gwerinlur Strait at 31 km2 — a naval
 * subregion the size of a small town — because it had pixels enough to pass.
 */
export const MIN_PIECE_AREA = 2000;

/**
 * Folds pieces too small to be worth being a piece into their neighbours.
 *
 * Into whichever it shares the most edge with, which is the rule mendPieces uses
 * for the same reason: it deletes a border instead of moving one, so nothing that
 * survives is any less straight than it was.
 */
export function dissolveTiny({
  owner, xs, ys, at, n, cx, cy, weight = null,
  floor = MIN_PIECE_PX, floorArea = MIN_PIECE_AREA,
}) {
  let gone = 0;
  for (let round = 0; round < 8; round++) {
    const size = new Int32Array(n);
    const km2 = new Float64Array(n);
    for (let i = 0; i < owner.length; i++) {
      size[owner[i]]++;
      if (weight) km2[owner[i]] += weight[i];
    }

    let alive = 0;
    for (let k = 0; k < n; k++) if (size[k]) alive++;
    if (alive <= 1) break;

    // Smallest first, so folding one does not make another look big enough.
    const small = [];
    for (let k = 0; k < n; k++) {
      if (!size[k]) continue;
      if (size[k] < floor || (weight && km2[k] < floorArea)) small.push(k);
    }
    if (!small.length) break;
    small.sort((a, b) => size[a] - size[b]);

    let changed = 0;
    for (const k of small) {
      const touch = new Map();
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] !== k) continue;
        for (const j of neighbours(i, xs, ys, at)) {
          if (j < 0 || owner[j] === k) continue;
          touch.set(owner[j], (touch.get(owner[j]) || 0) + 1);
        }
      }
      let take = -1;
      if (touch.size) {
        let most = -1;
        for (const [q, c] of touch) if (c > most) { most = c; take = q; }
      } else if (cx) {
        // A pool of water walled in by land, with nothing to share an edge with.
        // It goes to the nearest OTHER piece — never back to itself, which is
        // what left single pixels standing as subregions of their own. It ends up
        // a detached part of a subregion, which is the honest answer: it is
        // detached, and the nearest is the one it belongs to.
        let bestD = Infinity;
        let px = 0, py = 0, m = 0;
        for (let i = 0; i < owner.length; i++) {
          if (owner[i] !== k) continue;
          px += xs[i]; py += ys[i]; m++;
        }
        px /= m; py /= m;
        for (let q = 0; q < n; q++) {
          if (q === k || !size[q]) continue;
          const dx = px - cx[q], dy = py - cy[q];
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; take = q; }
        }
      }
      if (take < 0) continue;               // the only piece there is
      for (let i = 0; i < owner.length; i++) if (owner[i] === k) owner[i] = take;
      gone++;
      changed++;
    }
    if (!changed) break;
  }
  return { dissolved: gone };
}

/** The four pixels around one, as indices into the region's own pixel list. */
function neighbours(i, xs, ys, at) {
  const x = xs[i], y = ys[i];
  return [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
}

/**
 * A small deterministic generator, seeded per region.
 *
 * Not Math.random. The sea has to come out the same every run: a re-generation
 * that silently redrew every boundary would make the file impossible to hand-edit
 * and impossible to review.
 */
export function xorshiftFor(seed) {
  return xorshift(seed);
}

function xorshift(seed) {
  let v = (seed | 0) || 0x9e3779b9;
  return () => {
    v ^= v << 13; v |= 0;
    v ^= v >>> 17;
    v ^= v << 5; v |= 0;
    return ((v >>> 0) % 1000003) / 1000003;
  };
}

/**
 * How many small cells each subregion is built out of.
 *
 * The cut is not one Voronoi diagram. Nearest-centre gives convex cells of
 * similar size, and no amount of jittering the centres changes that — a convex
 * cell surrounded by other convex cells has about six sides, which is why the
 * whole map read as a honeycomb however the seeds were scattered.
 *
 * So the region is deliberately OVER-CUT, into about six times as many pieces as
 * it wants, and those pieces are then merged into each other at random until the
 * right number is left. A subregion is a handful of small cells stuck together:
 * it has a ragged outline, it is not convex, no two are the same shape, and every
 * edge of it is still a straight bisector because that is all it is made of.
 */
export const OVERSEGMENT = 6;

/**
 * The least edge two cells may share and still be merged.
 *
 * Without it the random choice will sometimes join a cell to one it touches at a
 * corner, and the subregion comes out as two lobes hanging together by four
 * pixels of water. pinchOff cuts those afterwards; this stops most of them being
 * made.
 */
export const MIN_MERGE_EDGE = 6;

/**
 * Grows `n` subregions by sticking small cells together.
 *
 * Repeatedly: take the smallest cluster, and give it to one of its neighbours
 * picked at random, weighted by how much edge they share. Smallest-first keeps
 * anything from being left behind, and the random choice is what varies the
 * shapes — merging into the SMALLEST neighbour instead would even the sizes out
 * and walk straight back to a honeycomb.
 */
export function agglomerate({ fine, nFine, area, adjacency, n, rand }) {
  const parent = new Int32Array(nFine).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

  const size = Float64Array.from(area);
  const live = new Set();
  for (let i = 0; i < nFine; i++) if (area[i] > 0) live.add(i);

  // Neighbours per cluster, as a map of root -> shared edge length.
  const near = [];
  for (let i = 0; i < nFine; i++) near.push(new Map(adjacency[i] || []));

  while (live.size > n) {
    let small = -1, smallest = Infinity;
    for (const i of live) if (size[i] < smallest) { smallest = size[i]; small = i; }
    if (small < 0) break;

    const all = [...near[small]].filter(([q]) => live.has(q) && q !== small);
    if (!all.length) { live.delete(small); continue; }       // walled off; leave it be
    // Anything sharing a real edge. If nothing does, take the widest contact
    // there is rather than refusing to merge at all.
    let options = all.filter(([, w]) => w >= MIN_MERGE_EDGE);
    if (!options.length) options = [all.reduce((a, b) => (b[1] > a[1] ? b : a))];

    let total = 0;
    for (const [, w] of options) total += w;
    let pickAt = rand() * total, take = options[options.length - 1][0];
    for (const [q, w] of options) { pickAt -= w; if (pickAt <= 0) { take = q; break; } }

    parent[small] = take;
    size[take] += size[small];
    live.delete(small);
    for (const [q, w] of near[small]) {
      if (q === take) continue;
      near[take].set(q, (near[take].get(q) || 0) + w);
      near[q].set(take, (near[q].get(take) || 0) + w);
      near[q].delete(small);
    }
    near[take].delete(small);
  }

  // Renumber the survivors from zero, and relabel every pixel.
  const ordinal = new Map();
  for (const i of live) ordinal.set(i, ordinal.size);
  const owner = new Int32Array(fine.length);
  for (let i = 0; i < fine.length; i++) owner[i] = ordinal.get(find(fine[i])) ?? 0;
  return { owner, n: ordinal.size };
}

/**
 * How wide a neck has to be to count as the subregion being joined up.
 *
 * A pixel is CORE if everything within this many pixels of it is its own
 * subregion. Anything narrower than twice this is not a join, it is a hair.
 */
export const NECK_RADIUS = 3;

/**
 * Cuts off lobes hanging from a subregion by a thread.
 *
 * Merging small cells at random is what varies the shapes, and it is also what
 * produces this: two lobes of one subregion touching through four pixels of
 * water, because the cells between them went elsewhere. It is connected, so
 * mendPieces sees nothing wrong, and it looks like a mistake because it is one —
 * no fleet should have to thread a gap that narrow to stay in the same water.
 *
 * Eroding finds them. Shrink each subregion by NECK_RADIUS: a neck thinner than
 * twice that vanishes and the lobes fall apart, while a properly joined shape
 * stays in one piece. What the erosion separates is then grown back to its own
 * lobe, the largest lobe keeps the subregion, and the rest are handed to whatever
 * they border most — the same rule mendPieces uses, for the same reason.
 */
export function pinchOff({ owner, xs, ys, at, n, radius = NECK_RADIUS, rounds = 3 }) {
  const count = owner.length;
  let cut = 0, lobes = 0;

  for (let round = 0; round < rounds; round++) {
    const byOwner = new Map();
    for (let i = 0; i < count; i++) {
      let list = byOwner.get(owner[i]);
      if (!list) { list = []; byOwner.set(owner[i], list); }
      list.push(i);
    }

    let changed = 0;
    for (const [k, part] of byOwner) {
      if (part.length < 16) continue;

      // The core: everything a full radius inside its own subregion.
      const core = [];
      for (const i of part) {
        const x = xs[i], y = ys[i];
        let inside = true;
        for (let dy = -radius; dy <= radius && inside; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const j = at(x + dx, y + dy);
            if (j < 0 || owner[j] !== k) { inside = false; break; }
          }
        }
        if (inside) core.push(i);
      }
      if (core.length < 2) continue;

      // Lobes, as the pieces the erosion left. One means the shape is properly
      // joined and there is nothing here to cut.
      const label = new Map();
      let lobeN = 0;
      const stack = [];
      for (const s of core) {
        if (label.has(s)) continue;
        label.set(s, lobeN);
        stack.push(s);
        while (stack.length) {
          const i = stack.pop();
          for (const j of neighbours(i, xs, ys, at)) {
            if (j < 0 || owner[j] !== k || label.has(j)) continue;
            const x = xs[j], y = ys[j];
            let isCore = true;
            for (let dy = -radius; dy <= radius && isCore; dy++) {
              for (let dx = -radius; dx <= radius; dx++) {
                const q = at(x + dx, y + dy);
                if (q < 0 || owner[q] !== k) { isCore = false; break; }
              }
            }
            if (!isCore) continue;
            label.set(j, lobeN);
            stack.push(j);
          }
        }
        lobeN++;
      }
      if (lobeN < 2) continue;
      lobes += lobeN - 1;

      // Grow each lobe back out through the subregion, nearest first, so every
      // pixel of it belongs to the lobe it is closest to through the water.
      const grown = new Map(label);
      const queue = [...label.keys()];
      for (let head = 0; head < queue.length; head++) {
        const i = queue[head];
        for (const j of neighbours(i, xs, ys, at)) {
          if (j < 0 || owner[j] !== k || grown.has(j)) continue;
          grown.set(j, grown.get(i));
          queue.push(j);
        }
      }

      const size = new Int32Array(lobeN);
      for (const [, v] of grown) size[v]++;
      let keep = 0;
      for (let v = 1; v < lobeN; v++) if (size[v] > size[keep]) keep = v;

      for (let v = 0; v < lobeN; v++) {
        if (v === keep) continue;
        const give = [];
        for (const [i, w] of grown) if (w === v) give.push(i);
        if (!give.length) continue;

        const touch = new Map();
        for (const i of give) {
          for (const j of neighbours(i, xs, ys, at)) {
            if (j < 0 || owner[j] === k) continue;
            touch.set(owner[j], (touch.get(owner[j]) || 0) + 1);
          }
        }
        if (!touch.size) continue;          // nothing else borders it; leave it
        let take = -1, most = -1;
        for (const [q, c] of touch) if (c > most) { most = c; take = q; }
        for (const i of give) owner[i] = take;
        cut += give.length;
        changed++;
      }
    }
    if (!changed) break;
  }
  return { cut, lobes };
}

/** A stable number out of a string, for seeding. */
export function hashSeed(id) {
  let h = 0x811c9dc5;
  const t = String(id);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
}

const mean = (list) => {
  let s = 0;
  for (const v of list) s += v;
  return list.length ? s / list.length : 0;
};
