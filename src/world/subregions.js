// Sea subregions: divides sea regions into the pieces fleets move between.

// Seafloor depth bands with colours, shallowest first.
export const DEPTH_BANDS = [
  [0xb6e1f9, 'Shelf', 'above -100 m'],
  [0x87cefa, 'Slope', '-100 m to -1000 m'],
  [0x4c84b4, 'Bathyal', '-1000 m to -3000 m'],
  [0x04668d, 'Abyssal', '-3000 m to -6000 m'],
  [0x095177, 'Hadal', 'below -6000 m'],
];

// Index into DEPTH_BANDS where shallow water stops.
export const SHALLOW_THROUGH = 2;

// Whether a depth band counts as shallow water.
export const isShallow = (band) => {
  const ix = DEPTH_BANDS.findIndex(([, name]) => name === band);
  return ix < 0 ? true : ix < SHALLOW_THROUGH;   // unpainted is a lake, which is shallow
};

// Target area of one subregion, in km².
export const TARGET_AREA = 100000;        // about 316 km across

// Ceiling on subregions per region.
export const MAX_SUBREGIONS = 400;

// Fewest game-map pixels per subregion.
export const MIN_SUBREGION_PX = 240;
// Rounds of Lloyd relaxation to run.
const RELAX_ROUNDS = 0;

// Minimum centre spacing as a fraction of even-scatter spacing.
const SEED_SEPARATION = 0.55;

// Area of each depth band per region.
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

// Shallow, deep, or nothing painted at all.
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
    shallow: painted > 0 ? shallow / painted >= 0.5 : true,
    painted,
    unpainted: hist[0],
  };
}

// Number of pieces a region divides into, from area over target.
export function subregionCount({ area, pixels, target = TARGET_AREA }) {
  const wanted = Math.max(1, Math.min(MAX_SUBREGIONS, Math.round(area / target)));
  const affordable = Math.max(1, Math.floor(pixels / MIN_SUBREGION_PX));
  return { n: Math.min(wanted, affordable), wanted, target };
}

// Cuts one region into `n` pieces by nearest centre.
export function cutStraight({ xs, ys, n, seed = 1, rounds = RELAX_ROUNDS }) {
  const count = xs.length;
  const owner = new Int32Array(count).fill(-1);
  if (n <= 1) return { owner: owner.fill(0), cx: [mean(xs)], cy: [mean(ys)] };

  // Centres are fitted on a pixel sample.
  const step = Math.max(1, Math.ceil(count / SAMPLE_MAX));
  const m = Math.ceil(count / step);
  const sxs = new Float64Array(m), sys = new Float64Array(m);
  for (let i = 0, k = 0; i < count; i += step, k++) { sxs[k] = xs[i]; sys[k] = ys[i]; }

  // Random seeds with a minimum separation.
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

  for (let i = 0; i < count; i++) owner[i] = nearest(xs[i], ys[i]);
  return { owner, cx, cy };
}

// Most pixels the centres are fitted on.
const SAMPLE_MAX = 30000;

// Makes every piece one connected piece.
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

// Fewest pixels a finished subregion may be.
export const MIN_PIECE_PX = 80;

// Fewest km² a finished subregion may be.
export const MIN_PIECE_AREA = 2000;

// Folds undersized pieces into the neighbour sharing most edge.
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

// The four pixels around one, as indices into the region's pixel list.
function neighbours(i, xs, ys, at) {
  const x = xs[i], y = ys[i];
  return [at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)];
}

// Seeded deterministic generator for one region.
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

// Small cells per subregion in the oversegmentation.
export const OVERSEGMENT = 6;

// Least shared edge for two cells to merge.
export const MIN_MERGE_EDGE = 6;

// Grows `n` subregions by merging small cells at random.
export function agglomerate({ fine, nFine, area, adjacency, n, rand }) {
  const parent = new Int32Array(nFine).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

  const size = Float64Array.from(area);
  const live = new Set();
  for (let i = 0; i < nFine; i++) if (area[i] > 0) live.add(i);

  const near = [];
  for (let i = 0; i < nFine; i++) near.push(new Map(adjacency[i] || []));

  while (live.size > n) {
    let small = -1, smallest = Infinity;
    for (const i of live) if (size[i] < smallest) { smallest = size[i]; small = i; }
    if (small < 0) break;

    const all = [...near[small]].filter(([q]) => live.has(q) && q !== small);
    if (!all.length) { live.delete(small); continue; }       // walled off; leave it be
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

  const ordinal = new Map();
  for (const i of live) ordinal.set(i, ordinal.size);
  const owner = new Int32Array(fine.length);
  for (let i = 0; i < fine.length; i++) owner[i] = ordinal.get(find(fine[i])) ?? 0;
  return { owner, n: ordinal.size };
}

// Neck radius, in pixels, for a subregion to count as joined.
export const NECK_RADIUS = 3;

// Cuts off lobes joined to a subregion by a thin neck.
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

// Stable seed number from a string.
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
