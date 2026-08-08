/*
 * mapdata.js — everything derived from the province bitmap.
 *
 * Shared by the browser and by sync-provinces.js, which precomputes all of it
 * into data/map-cache.bin so the page does not have to. That sharing is the
 * point: these scans decide adjacency, borders, and where labels sit, and a
 * build script quietly disagreeing with the renderer would be a miserable bug
 * to track down. There is one copy, and both sides run it.
 *
 * Everything here is pure — no canvas, no DOM, no module state — so it runs
 * unchanged under Node. Anything that has to measure text or touch a canvas
 * stays in main.js.
 */

export const LABEL_HIST_BUCKET = 3;   // map pixels per slice, when measuring width along an axis

/**
 * Accepts "#c44a3e", the shorthand "#c43", or an existing [r,g,b] array, and
 * always returns [r,g,b]. Throws on anything else rather than quietly yielding
 * a colour that would never match a pixel.
 */
export function toRgb(value) {
  if (Array.isArray(value)) return value;
  let h = String(value).trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`bad colour: ${value}`);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Puts the raw JSON into the shape the rest of the file expects, so nothing
 * downstream has to handle more than one form of anything:
 *   - every colour becomes [r,g,b], whatever it was written as
 *   - `terrain` becomes a list, so a bare string works as shorthand for one tag
 *   - polities get a Map by id, since they are looked up per province per repaint
 * Mutates and returns the same object.
 */
export function normaliseTable(table) {
  table.oceanColour = toRgb(table.oceanColour);
  for (const q of table.polities) q.colour = toRgb(q.colour);
  for (const p of table.provinces) {
    p.colour = toRgb(p.colour);
    p.terrain = Array.isArray(p.terrain) ? p.terrain : (p.terrain ? [p.terrain] : []);
  }
  table.polityById = new Map(table.polities.map((q) => [q.id, q]));
  return table;
}

export const OCEAN = 0;                    // province index 0 is reserved for sea and empty space

// Packs a colour into one integer so it can key a Map. Comparing three separate
// channels per pixel, or building "r,g,b" strings, would both be far slower.
export const rgbKey = (r, g, b) => (r << 16) | (g << 8) | b;

/**
 * Turns the province table and the bitmap into the world model everything else
 * reads: which province owns each pixel, who borders whom, what is coastal, and
 * where each province sits.
 *
 * TWO WAYS TO NAME A PROVINCE, and the distinction matters:
 *   id     a string, e.g. "rodtfjell". The public name. Events and save data use
 *          it, so it survives the map being redrawn.
 *   index  a small integer. Internal only. The per-pixel array is a typed array
 *          and can hold nothing but numbers, so pixels are stored as indices.
 * buildWorld() assigns the index and is the only place that should care how the
 * two relate; everything outside works in ids.
 */
export function buildWorld(table, image) {
  const { width, height } = image;
  const { byId, atIndex, colourToIndex } = indexProvinces(table);
  const { provinceAt, unknown } = mapPixels(image, table, colourToIndex);

  if (unknown.size) warnUnknownColours(unknown, table);

  const { adjacency, coastal, bounds } = scanAdjacency(provinceAt, width, height, byId, atIndex);
  warnEmptyProvinces(byId, bounds);

  return { width, height, provinceAt, atIndex, byId, adjacency, coastal, bounds, table };
}

/**
 * Gives every province its integer index and builds the three lookups the rest
 * of buildWorld() needs: id -> province, index -> province, colour -> index.
 *
 * A province with a missing or duplicate id is warned about and skipped rather
 * than throwing, so one bad row cannot take the whole map down.
 */
export function indexProvinces(table) {
  const byId = new Map();
  const atIndex = [null];            // slot 0 is OCEAN, so real provinces start at 1
  const colourToIndex = new Map();

  for (const p of table.provinces) {
    if (p.id === undefined || p.id === null || p.id === '') {
      console.warn('province with no id, skipped:', p);
    } else if (byId.has(p.id)) {
      console.warn(`duplicate province id "${p.id}" — the second is ignored`, p);
    } else {
      p.index = atIndex.length;
      atIndex.push(p);
      byId.set(p.id, p);
      colourToIndex.set(rgbKey(...p.colour), p.index);
    }
  }
  return { byId, atIndex, colourToIndex };
}

/**
 * Reduces the bitmap to one province index per pixel — the array every later
 * pass reads instead of the image itself.
 *
 * A colour that is in neither the JSON nor the ocean is counted and reported,
 * then left as ocean. That is almost always a stray anti-aliased edge or a
 * province someone painted but never added to the table.
 */
export function mapPixels(image, table, colourToIndex) {
  const px = image.data;
  // Two bytes per pixel where the province count allows it. On a 6000x2650 map
  // that is 32MB instead of 64MB, and the array is walked constantly.
  const Store = table.provinces.length < 65535 ? Uint16Array : Int32Array;
  const provinceAt = new Store(image.width * image.height);
  const oceanKey = rgbKey(...table.oceanColour);
  const unknown = new Map();

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const k = rgbKey(px[i], px[i + 1], px[i + 2]);
    if (k === oceanKey) continue;                  // array is already 0
    const index = colourToIndex.get(k);
    if (index === undefined) unknown.set(k, (unknown.get(k) || 0) + 1);
    else provinceAt[p] = index;
  }
  return { provinceAt, unknown };
}

/**
 * Derives adjacency, coastline and per-province bounds in a single pass — the
 * step that makes the bitmap, rather than any hand-written list, the authority
 * on which provinces touch.
 *
 * Each pixel is compared only with the one to its RIGHT and the one BELOW. That
 * is enough to catch every touching pair exactly once: a left-right pair is seen
 * from the left pixel, a top-bottom pair from the upper one. Checking all four
 * directions would find the same pairs twice over.
 *
 * Provinces meeting only at a diagonal do not count as neighbours, which matches
 * how armies move — corner to corner is not a shared border.
 *
 * The loop works in integer indices for speed but records results against public
 * string ids, so callers never see an index.
 */
export function scanAdjacency(provinceAt, width, height, byId, atIndex) {
  const adjacency = new Map([...byId.keys()].map((id) => [id, new Set()]));
  const coastal = new Set();
  const bounds = new Map();
  const idOf = (index) => atIndex[index].id;

  // Record what one touching pair of pixels means. Same province: nothing. Land
  // against sea: that province is coastal. Two provinces: they are neighbours.
  const link = (a, b) => {
    if (a === b) return;
    if (a === OCEAN || b === OCEAN) {
      coastal.add(idOf(a === OCEAN ? b : a));
      return;
    }
    adjacency.get(idOf(a)).add(idOf(b));
    adjacency.get(idOf(b)).add(idOf(a));
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const index = provinceAt[i];

      // Grow this province's box, count its pixels, and sum their positions.
      if (index !== OCEAN) {
        const id = idOf(index);
        let bb = bounds.get(id);
        if (!bb) bounds.set(id, (bb = { minX: x, minY: y, maxX: x, maxY: y, n: 0, sx: 0, sy: 0 }));
        if (x < bb.minX) bb.minX = x; else if (x > bb.maxX) bb.maxX = x;
        if (y < bb.minY) bb.minY = y; else if (y > bb.maxY) bb.maxY = y;
        bb.n++; bb.sx += x; bb.sy += y;
      }

      if (x + 1 < width) link(index, provinceAt[i + 1]);      // pair to the right
      if (y + 1 < height) link(index, provinceAt[i + width]); // pair below
    }
  }
  // Position sums become centroids now the counts are final. Note this is the
  // centre of MASS, not of the box: for an L-shaped province it can fall outside.
  for (const bb of bounds.values()) { bb.cx = bb.sx / bb.n; bb.cy = bb.sy / bb.n; }
  return { adjacency, coastal, bounds };
}

/**
 * How far every land pixel is from the nearest NATIONAL border, so the country
 * colour can be strong at the frontier and fade away inland.
 *
 * A national border means a boundary with a different owner, or with open sea.
 * Province subdivisions inside one country do not count — they get their thin
 * line and nothing more.
 *
 * This is a two-pass chamfer distance transform. The first pass carries
 * distances down and right, the second back up and left; between them every
 * pixel has effectively seen the whole map, in two linear passes rather than a
 * search per pixel.
 *
 * A diagonal step is weighted 4 against 3 for an orthogonal one, approximating
 * the true ratio of sqrt(2). That keeps the fade within 5.7% of a circle in
 * every direction — close enough to show no corners — while a distance still
 * fits in one byte, holding the field to 16MB rather than the 64MB an exact
 * float field would take. The weights bound how far can be measured, at
 * 255/3 = 85 map pixels, which FADE_PX has to stay under.
 *
 * Owners are fixed at load, so this is built once. If provinces ever change
 * hands it has to be rebuilt.
 */
export const CHAMFER_ORTH = 3;
export const CHAMFER_DIAG = 4;

export function buildBorderDistance(world) {
  const { width, height, provinceAt, atIndex } = world;

  // Owner per province index, as a small integer. Index 0 is ocean and keeps
  // -1, which matches no country, so every coastline seeds the transform.
  const ownerAt = new Int32Array(atIndex.length).fill(-1);
  const ordinal = new Map();
  for (let ix = 1; ix < atIndex.length; ix++) {
    const owner = atIndex[ix].owner;
    if (!ordinal.has(owner)) ordinal.set(owner, ordinal.size);
    ownerAt[ix] = ordinal.get(owner);
  }

  const MAX = 255;
  const dist = new Uint8Array(width * height).fill(MAX);

  // Seeds: the sea, and any land pixel with a differently owned neighbour. All
  // four directions are tested, unlike the border drawing which needs only two
  // — a one-sided seed would bias the whole field a pixel in one direction.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const index = provinceAt[i];
      if (index === OCEAN) { dist[i] = 0; continue; }
      const mine = ownerAt[index];
      const left = x > 0 ? ownerAt[provinceAt[i - 1]] : -1;
      const right = x + 1 < width ? ownerAt[provinceAt[i + 1]] : -1;
      const up = y > 0 ? ownerAt[provinceAt[i - width]] : -1;
      const down = y + 1 < height ? ownerAt[provinceAt[i + width]] : -1;
      if (left !== mine || right !== mine || up !== mine || down !== mine) dist[i] = 0;
    }
  }

  const A = CHAMFER_ORTH, B = CHAMFER_DIAG;

  for (let y = 0; y < height; y++) {              // forward: down and right
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x > 0) d = Math.min(d, dist[i - 1] + A);
      if (y > 0) d = Math.min(d, dist[i - width] + A);
      if (y > 0 && x > 0) d = Math.min(d, dist[i - width - 1] + B);
      if (y > 0 && x + 1 < width) d = Math.min(d, dist[i - width + 1] + B);
      dist[i] = d > MAX ? MAX : d;      // clamp by hand: Uint8Array wraps, it does not saturate
    }
  }

  for (let y = height - 1; y >= 0; y--) {         // backward: up and left
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let d = dist[i];
      if (d === 0) continue;
      if (x + 1 < width) d = Math.min(d, dist[i + 1] + A);
      if (y + 1 < height) d = Math.min(d, dist[i + width] + A);
      if (y + 1 < height && x + 1 < width) d = Math.min(d, dist[i + width + 1] + B);
      if (y + 1 < height && x > 0) d = Math.min(d, dist[i + width - 1] + B);
      dist[i] = d > MAX ? MAX : d;
    }
  }
  return dist;
}

/**
 * Reports colours found in the bitmap that no province claims, worst first.
 *
 * Each is shown with the nearest colour that IS in the table, because the
 * distance says what went wrong. A distance of only a few points means the same
 * colour arrived slightly altered — anti-aliasing, lossy compression, or the
 * colour management that loadPixels() turns off. A large distance means a
 * genuinely unregistered province.
 */
export function warnUnknownColours(unknown, table) {
  const rows = [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => {
    const rgb = [(k >> 16) & 255, (k >> 8) & 255, k & 255];
    let best = null, bestD = Infinity;
    for (const p of table.provinces) {
      const d = Math.abs(p.colour[0] - rgb[0]) + Math.abs(p.colour[1] - rgb[1]) + Math.abs(p.colour[2] - rgb[2]);
      if (d < bestD) { bestD = d; best = p; }
    }
    return { found: `rgb(${rgb})`, pixels: n, nearest: best ? `${best.id} rgb(${best.colour})` : '-', distance: bestD };
  });
  const drift = rows.some((r) => r.distance > 0 && r.distance <= 12);
  console.warn(
    `${unknown.size} colour(s) in the bitmap are not in provinces.json.` +
    (drift ? ' Small distances mean the browser colour-managed the image.' : ''),
    rows
  );
}

/**
 * Reports provinces listed in the JSON whose colour appears nowhere in the
 * bitmap. They have no pixels, so they are unclickable and invisible, and behave
 * as ocean. Usually a typo in the colour, or a province painted over.
 */
export function warnEmptyProvinces(byId, bounds) {
  const empty = [...byId.values()].filter((p) => !bounds.has(p.id));
  if (empty.length) {
    console.warn(
      `${empty.length} province(s) matched no pixels and will behave as ocean:`,
      empty.map((p) => ({ id: p.id, name: p.name, expected: `rgb(${p.colour})` }))
    );
  }
}

/**
 * The two full-map passes behind the labels: which provinces form one block,
 * each block's principal axis, and the sums that the spine and the inland fade
 * are fitted from. Returns null when there is nothing to label.
 *
 * Split from the label building itself because this half is pure arithmetic over
 * every pixel on the map — by far the most expensive thing at load, and so worth
 * precomputing — while the other half has to measure real text, which needs a
 * canvas and can only happen in the browser.
 */
export function computeLabelGeometry(world) {
  const { width, provinceAt, atIndex, byId, adjacency } = world;

  // --- group provinces into blocks: flood fill the adjacency graph, never
  //     crossing into a different owner. Unowned land gets no label.
  const blocks = [];
  const blockOf = new Map();
  for (const p of byId.values()) {
    if (blockOf.has(p.id) || !world.table.polityById.has(p.owner) || p.owner === 'NONE') continue;
    const n = blocks.length;
    const stack = [p.id];
    blockOf.set(p.id, n);
    while (stack.length) {
      const id = stack.pop();
      for (const q of adjacency.get(id)) {
        if (blockOf.has(q) || byId.get(q).owner !== p.owner) continue;
        blockOf.set(q, n);
        stack.push(q);
      }
    }
    blocks.push({ owner: p.owner });
  }
  if (!blocks.length) return null;

  const blockAt = new Int32Array(atIndex.length).fill(-1);
  for (const [id, b] of blockOf) blockAt[byId.get(id).index] = b;

  // --- STEP 1: one pass over the map summing each block's pixel positions, which
  //     gives the centroid and covariance, and from those the principal axis.
  // Both passes below walk x and y as loop counters rather than deriving them
  // from the index. A division and a modulo per pixel is invisible on a small
  // map and tens of millions of operations on a large one.
  const height = provinceAt.length / width;
  const acc = blocks.map(() => ({ n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 }));
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const b = blockAt[provinceAt[i]];
      if (b < 0) continue;
      const a = acc[b];
      a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.sxy += x * y; a.syy += y * y;
    }
  }

  const geo = acc.map((a) => {
    if (a.n < 12) return null;                  // too few pixels for a meaningful axis
    const cx = a.sx / a.n, cy = a.sy / a.n;
    const vxx = a.sxx / a.n - cx * cx;
    const vxy = a.sxy / a.n - cx * cy;
    const vyy = a.syy / a.n - cy * cy;
    const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);   // principal eigenvector
    return { cx, cy, ux: Math.cos(theta), uy: Math.sin(theta), n: a.n };
  });

  // --- STEP 2: a second pass, now that the axis is known. Each pixel is measured
  //     along it (t) and across it (u). The sums feed the least-squares spine,
  //     and the tally of pixels per slice of t feeds denseRange.
  const fit = geo.map((g) => g && {
    tMin: Infinity, tMax: -Infinity, n: 0, pp: 0, hist: new Map(),
    s0: 0, s1: 0, s2: 0, s3: 0, s4: 0, u0: 0, u1: 0, u2: 0,
  });
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const b = blockAt[provinceAt[i]];
      if (b < 0 || !geo[b]) continue;
      const g = geo[b], f = fit[b];
      const dx = x - g.cx, dy = y - g.cy;
      const t = dx * g.ux + dy * g.uy;          // along the axis
      const u = -dx * g.uy + dy * g.ux;         // perpendicular to it
      if (t < f.tMin) f.tMin = t; else if (t > f.tMax) f.tMax = t;
      const bucket = Math.floor(t / LABEL_HIST_BUCKET);      // land per slice along the axis
      f.hist.set(bucket, (f.hist.get(bucket) || 0) + 1);
      const t2 = t * t;
      f.n++; f.pp += u * u;
      f.s0++; f.s1 += t; f.s2 += t2; f.s3 += t2 * t; f.s4 += t2 * t2;
      f.u0 += u; f.u1 += u * t; f.u2 += u * t2;
    }
  }
  return { blocks, blockAt, geo, fit };
}
