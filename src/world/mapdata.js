// Province bitmap analysis shared by the browser and the sync script.

export const LABEL_HIST_BUCKET = 3;   // map pixels per slice, when measuring width along an axis

// Converts a hex string or [r,g,b] to [r,g,b]; throws on anything else.
export function toRgb(value) {
  if (Array.isArray(value)) return value;
  let h = String(value).trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`bad colour: ${value}`);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Normalises the province table's colours and list fields.
export function normaliseTable(table) {
  table.oceanColour = toRgb(table.oceanColour);
  for (const q of table.polities) q.colour = toRgb(q.colour);
  for (const p of table.provinces) {
    p.colour = toRgb(p.colour);
    p.terrain = Array.isArray(p.terrain) ? p.terrain : (p.terrain ? [p.terrain] : []);
    p.climate = Array.isArray(p.climate) ? p.climate : (p.climate ? [p.climate] : []);
  }
  table.polityById = new Map(table.polities.map((q) => [q.id, q]));
  return table;
}

export const OCEAN = 0;                    // province index 0 is reserved for sea and empty space

// Packs an RGB colour into one integer key.
export const rgbKey = (r, g, b) => (r << 16) | (g << 8) | b;

// Builds the world model from the province table and the bitmap.
export function buildWorld(table, image) {
  const { width, height } = image;
  const { byId, atIndex, colourToIndex } = indexProvinces(table);
  const { provinceAt, unknown } = mapPixels(image, table, colourToIndex);

  if (unknown.size) warnUnknownColours(unknown, table);

  const { adjacency, coastal, bounds } = scanAdjacency(provinceAt, width, height, byId, atIndex);
  warnEmptyProvinces(byId, bounds);

  return { width, height, provinceAt, atIndex, byId, adjacency, coastal, bounds, table };
}

// Assigns province indices and builds id, index and colour lookups.
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

// Maps every pixel to a province index.
export function mapPixels(image, table, colourToIndex) {
  const px = image.data;
  const Store = table.provinces.length < 65535 ? Uint16Array : Int32Array;
  const provinceAt = new Store(image.width * image.height);
  const oceanKey = rgbKey(...table.oceanColour);
  const unknown = new Map();

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const k = rgbKey(px[i], px[i + 1], px[i + 2]);
    if (k === oceanKey) continue;
    const index = colourToIndex.get(k);
    if (index === undefined) unknown.set(k, (unknown.get(k) || 0) + 1);
    else provinceAt[p] = index;
  }
  return { provinceAt, unknown };
}

// Derives adjacency, coastline and per-province bounds in one pass.

// Shared pixels needed before two provinces count as neighbours.
export const MIN_BORDER_PX = 2;

export function scanAdjacency(provinceAt, width, height, byId, atIndex) {
  const half = width / 2;
  const adjacency = new Map([...byId.keys()].map((id) => [id, new Set()]));
  const coastal = new Set();
  const bounds = new Map();
  const idOf = (index) => atIndex[index].id;

  const touch = new Map();

  const link = (a, b) => {
    if (a === b) return;
    if (a === OCEAN || b === OCEAN) {
      coastal.add(idOf(a === OCEAN ? b : a));
      return;
    }
    const key = a < b ? a * 65536 + b : b * 65536 + a;
    touch.set(key, (touch.get(key) || 0) + 1);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const index = provinceAt[i];

      if (index !== OCEAN) {
        const id = idOf(index);
        let bb = bounds.get(id);
        if (!bb) {
          bounds.set(id, (bb = {
            minX: x, minY: y, maxX: x, maxY: y, n: 0, sx: 0, sy: 0,
            maxLeft: -1, minRight: width, nLeft: 0, sxLeft: 0,
          }));
        }
        if (x < bb.minX) bb.minX = x; else if (x > bb.maxX) bb.maxX = x;
        if (y < bb.minY) bb.minY = y; else if (y > bb.maxY) bb.maxY = y;
        bb.n++; bb.sx += x; bb.sy += y;
        if (x < half) { if (x > bb.maxLeft) bb.maxLeft = x; bb.nLeft++; bb.sxLeft += x; }
        else if (x < bb.minRight) bb.minRight = x;
      }

      // Right-hand pair, wrapping to column 0 at the map edge.
      link(index, provinceAt[x + 1 < width ? i + 1 : y * width]);
      if (y + 1 < height) link(index, provinceAt[i + width]); // pair below
    }
  }
  for (const bb of bounds.values()) resolveWrap(bb, width);

  let dropped = 0;
  for (const [key, n] of touch) {
    if (n < MIN_BORDER_PX) { dropped++; continue; }
    const a = Math.floor(key / 65536), b = key % 65536;
    adjacency.get(idOf(a)).add(idOf(b));
    adjacency.get(idOf(b)).add(idOf(a));
  }

  return { adjacency, coastal, bounds, contacts: touch.size, dropped };
}

// Chamfer distance from each land pixel to the nearest national border.
// Fixes a province's box and centroid for ground across the map seam.
export function resolveWrap(bb, width) {
  bb.cy = bb.sy / bb.n;

  const plain = bb.maxX - bb.minX + 1;
  const wrapped = bb.maxLeft < 0 || bb.minRight >= width
    ? Infinity
    : (width - bb.minRight) + bb.maxLeft + 1;

  if (wrapped >= plain) {
    bb.cx = bb.sx / bb.n;
    return bb;
  }

  bb.minX = bb.minRight;
  bb.maxX = bb.maxLeft + width;
  bb.cx = ((bb.sx + bb.nLeft * width) / bb.n) % width;
  return bb;
}

// Normalises the sea table's colours and tag lists.
export function normaliseSeaTable(table) {
  table.landColour = toRgb(table.landColour);
  for (const r of table.regions) {
    r.colour = toRgb(r.colour);
    r.tags = Array.isArray(r.tags) ? r.tags : (r.tags ? [r.tags] : []);
  }
  table.regionById = new Map(table.regions.map((r) => [r.id, r]));
  return table;
}

// Maps sea.png to sea region indices, with 0 as land.
// Indexes sea regions; slot 0 is land.
export function indexSea(table) {
  const byId = new Map();
  const atIndex = [null];
  const colourToIndex = new Map();

  for (const r of table.regions) {
    if (r.id === undefined || r.id === null || r.id === '') {
      console.warn('sea region with no id, skipped:', r);
    } else if (byId.has(r.id)) {
      console.warn(`duplicate sea region id "${r.id}" — the second is ignored`, r);
    } else {
      r.index = atIndex.length;
      atIndex.push(r);
      byId.set(r.id, r);
      colourToIndex.set(rgbKey(...r.colour), r.index);
    }
  }
  return { byId, atIndex, colourToIndex };
}

export function buildSeaWorld(table, image) {
  const { width, height } = image;
  const { byId, atIndex, colourToIndex } = indexSea(table);

  const Store = table.regions.length < 65535 ? Uint16Array : Int32Array;
  const seaAt = new Store(width * height);
  const landKey = rgbKey(...table.landColour);
  const px = image.data;
  const unknown = new Map();

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const k = rgbKey(px[i], px[i + 1], px[i + 2]);
    if (k === landKey) continue;
    const index = colourToIndex.get(k);
    if (index === undefined) unknown.set(k, (unknown.get(k) || 0) + 1);
    else seaAt[p] = index;
  }
  if (unknown.size) {
    console.warn(`${unknown.size} colour(s) in sea.png are not in sea.json and read as land.`,
      [...unknown].slice(0, 8).map(([k, n]) => ({ found: `#${(k >>> 0).toString(16).padStart(6, '0')}`, pixels: n })));
  }

  const { adjacency, bounds } = scanAdjacency(seaAt, width, height, byId, atIndex);
  return { width, height, seaAt, atIndex, byId, adjacency, bounds, table, unknown: unknown.size };
}

// Normalises the county table's colours and terrain lists.
// Normalises the sea subregion table.
export function normaliseSubTable(table) {
  for (const s of table.subregions || []) {
    s.colour = toRgb(s.colour);
    s.tags = Array.isArray(s.tags) ? s.tags : (s.tags ? [s.tags] : []);
  }
  table.subById = new Map((table.subregions || []).map((s) => [s.id, s]));
  return table;
}

/** Index -> subregion, colour -> index, id -> subregion. As indexCounties. */
export function indexSubs(table) {
  const byId = new Map();
  const atIndex = [null];
  const colourToIndex = new Map();

  for (const s of table.subregions || []) {
    if (s.id === undefined || s.id === null || s.id === '') {
      console.warn('sea subregion with no id, skipped:', s);
    } else if (byId.has(s.id)) {
      console.warn(`duplicate sea subregion id "${s.id}" — the second is ignored`, s);
    } else {
      s.index = atIndex.length;
      atIndex.push(s);
      byId.set(s.id, s);
      colourToIndex.set(rgbKey(...s.colour), s.index);
    }
  }
  return { byId, atIndex, colourToIndex };
}

/** The per-pixel subregion index, from sea_subregions.png. As buildCountyWorld. */
export function buildSubWorld(table, image) {
  const { width, height } = image;
  const { byId, atIndex, colourToIndex } = indexSubs(table);

  const subAt = new Uint16Array(width * height);
  const landKey = rgbKey(...toRgb(table.landColour));
  const px = image.data;
  const unknown = new Map();

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const k = rgbKey(px[i], px[i + 1], px[i + 2]);
    if (k === landKey) continue;
    const index = colourToIndex.get(k);
    if (index === undefined) unknown.set(k, (unknown.get(k) || 0) + 1);
    else subAt[p] = index;
  }
  if (unknown.size) {
    console.warn(`${unknown.size} colour(s) in sea_subregions.png are not in sea.json.`,
      [...unknown].slice(0, 8).map(([k, n]) => ({ found: `#${(k >>> 0).toString(16).padStart(6, '0')}`, pixels: n })));
  }

  const { adjacency, bounds } = scanAdjacency(subAt, width, height, byId, atIndex);
  return { width, height, subAt, atIndex, byId, adjacency, bounds, table, unknown: unknown.size };
}

export function normaliseCountyTable(table) {
  table.oceanColour = toRgb(table.oceanColour);
  for (const c of table.counties) {
    c.colour = toRgb(c.colour);
    c.terrain = Array.isArray(c.terrain) ? c.terrain : (c.terrain ? [c.terrain] : []);
  }
  table.countyById = new Map(table.counties.map((c) => [c.id, c]));
  return table;
}

// Indexes counties; slot 0 is sea.
export function indexCounties(table) {
  const byId = new Map();
  const atIndex = [null];
  const colourToIndex = new Map();

  for (const c of table.counties) {
    if (c.id === undefined || c.id === null || c.id === '') {
      console.warn('county with no id, skipped:', c);
    } else if (byId.has(c.id)) {
      console.warn(`duplicate county id "${c.id}" — the second is ignored`, c);
    } else {
      c.index = atIndex.length;
      atIndex.push(c);
      byId.set(c.id, c);
      colourToIndex.set(rgbKey(...c.colour), c.index);
    }
  }
  return { byId, atIndex, colourToIndex };
}

// Maps counties.png to county indices and county adjacency.
export function buildCountyWorld(table, image) {
  const { width, height } = image;
  const { byId, atIndex, colourToIndex } = indexCounties(table);

  const countyAt = new Uint16Array(width * height);
  const oceanKey = rgbKey(...table.oceanColour);
  const px = image.data;
  const unknown = new Map();

  for (let i = 0, p = 0; i < px.length; i += 4, p++) {
    const k = rgbKey(px[i], px[i + 1], px[i + 2]);
    if (k === oceanKey) continue;
    const index = colourToIndex.get(k);
    if (index === undefined) unknown.set(k, (unknown.get(k) || 0) + 1);
    else countyAt[p] = index;
  }
  if (unknown.size) {
    console.warn(`${unknown.size} colour(s) in counties.png are not in counties.json.`,
      [...unknown].slice(0, 8).map(([k, n]) => ({ found: `#${(k >>> 0).toString(16).padStart(6, '0')}`, pixels: n })));
  }

  const { adjacency, bounds } = scanAdjacency(countyAt, width, height, byId, atIndex);
  return { width, height, countyAt, atIndex, byId, adjacency, bounds, table, unknown: unknown.size };
}

export const CHAMFER_ORTH = 3;
export const CHAMFER_DIAG = 4;
export const BORDER_DIST_MAX = 255;

// Furthest a border affects the distance field, in map pixels.
export const BORDER_DIST_REACH = Math.floor(BORDER_DIST_MAX / CHAMFER_ORTH);

// Owner ordinal per province index, -1 for ocean.
export function ownerOrdinals(atIndex) {
  const ownerAt = new Int32Array(atIndex.length).fill(-1);
  const ordinal = new Map();
  for (let ix = 1; ix < atIndex.length; ix++) {
    const owner = frontierKeyOf(atIndex[ix]);
    if (!ordinal.has(owner)) ordinal.set(owner, ordinal.size);
    ownerAt[ix] = ordinal.get(owner);
  }
  return ownerAt;
}

export function buildBorderDistance(world) {
  const dist = new Uint8Array(world.width * world.height);
  refreshBorderDistance(world, dist, null);
  return dist;
}

// Recomputes the border distance field over one rectangle, in place.
export function refreshBorderDistance(world, dist, box) {
  const { width, height, provinceAt, atIndex } = world;
  const ownerAt = ownerOrdinals(atIndex);

  const x0 = box ? Math.max(0, box.x0) : 0;
  const y0 = box ? Math.max(0, box.y0) : 0;
  const x1 = box ? Math.min(width, box.x1) : width;
  const y1 = box ? Math.min(height, box.y1) : height;
  if (x1 <= x0 || y1 <= y0) return;

  const MAX = BORDER_DIST_MAX;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const index = provinceAt[i];
      if (index === OCEAN) { dist[i] = 0; continue; }
      const mine = ownerAt[index];
      const left = ownerAt[provinceAt[x > 0 ? i - 1 : i + width - 1]];
      const right = ownerAt[provinceAt[x + 1 < width ? i + 1 : y * width]];
      const up = y > 0 ? ownerAt[provinceAt[i - width]] : mine;
      const down = y + 1 < height ? ownerAt[provinceAt[i + width]] : mine;
      dist[i] = (left !== mine || right !== mine || up !== mine || down !== mine) ? 0 : MAX;
    }
  }

  const A = CHAMFER_ORTH, B = CHAMFER_DIAG;

  // Wraps the sweep across the map seam for full-width boxes.
  const wrapX = x0 === 0 && x1 === width;

  const tail = wrapX ? Math.min(BORDER_DIST_REACH + 1, width >> 1) : 0;

  const left = (i, x, y) => (x > 0 ? dist[i - 1] : wrapX ? dist[y * width + width - 1] : MAX) + A;
  const right = (i, x, y) => (x + 1 < width ? dist[i + 1] : wrapX ? dist[y * width] : MAX) + A;
  const upLeft = (i, x, y) => (x > 0 ? dist[i - width - 1] : wrapX ? dist[(y - 1) * width + width - 1] : MAX) + B;
  const upRight = (i, x, y) => (x + 1 < width ? dist[i - width + 1] : wrapX ? dist[(y - 1) * width] : MAX) + B;
  const downLeft = (i, x, y) => (x > 0 ? dist[i + width - 1] : wrapX ? dist[(y + 1) * width + width - 1] : MAX) + B;
  const downRight = (i, x, y) => (x + 1 < width ? dist[i + width + 1] : wrapX ? dist[(y + 1) * width] : MAX) + B;

  for (let y = y0; y < y1; y++) {                 // forward: down and right
    const step = (x) => {
      const i = y * width + x;
      let d = dist[i];
      if (d === 0) return;
      d = Math.min(d, left(i, x, y));
      if (y > 0) {
        d = Math.min(d, dist[i - width] + A, upLeft(i, x, y), upRight(i, x, y));
      }
      dist[i] = d > MAX ? MAX : d;
    };
    for (let x = x0; x < x1; x++) step(x);

    for (let x = 0; x < tail; x++) step(x);
  }

  for (let y = y1 - 1; y >= y0; y--) {            // backward: up and left
    const step = (x) => {
      const i = y * width + x;
      let d = dist[i];
      if (d === 0) return;
      d = Math.min(d, right(i, x, y));
      if (y + 1 < height) {
        d = Math.min(d, dist[i + width] + A, downRight(i, x, y), downLeft(i, x, y));
      }
      dist[i] = d > MAX ? MAX : d;
    };
    for (let x = x1 - 1; x >= x0; x--) step(x);
    for (let x = width - 1; x >= width - tail; x--) step(x);
  }
}

// Reports unclaimed bitmap colours with their nearest table colour.
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

// Reports provinces whose colour appears nowhere in the bitmap.
export function warnEmptyProvinces(byId, bounds) {
  const empty = [...byId.values()].filter((p) => !bounds.has(p.id));
  if (empty.length) {
    console.warn(
      `${empty.length} province(s) matched no pixels and will behave as ocean:`,
      empty.map((p) => ({ id: p.id, name: p.name, expected: `rgb(${p.colour})` }))
    );
  }
}

// Full-map label passes: blocks, principal axes and fit sums.
/** A narrow channel of sea still counts as one country, up to this many pixels. */
export const NEAR_GAP = 5;

// Provinces within NEAR_GAP pixels of each other across water.
export function nearbyProvinces(provinceAt, width, height, radius = NEAR_GAP) {
  const claim = new Uint16Array(provinceAt.length);   // which province reached this water
  const dist = new Uint8Array(provinceAt.length);
  const near = new Map();

  const link = (a, b) => {
    if (a === b || !a || !b) return;
    if (!near.has(a)) near.set(a, new Set());
    if (!near.has(b)) near.set(b, new Set());
    near.get(a).add(b);
    near.get(b).add(a);
  };

  let frontier = [];
  for (let i = 0; i < provinceAt.length; i++) {
    if (provinceAt[i] !== OCEAN) { claim[i] = provinceAt[i]; frontier.push(i); }
  }

  for (let step = 1; step <= radius && frontier.length; step++) {
    const next = [];
    for (const i of frontier) {
      const x = i % width, y = (i - x) / width;
      for (let k = 0; k < 4; k++) {
        const nx = x + (k === 0 ? -1 : k === 1 ? 1 : 0);
        const ny = y + (k === 2 ? -1 : k === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (provinceAt[j] !== OCEAN) continue;

        if (!claim[j]) {
          claim[j] = claim[i];
          dist[j] = step;
          next.push(j);
        } else if (claim[j] !== claim[i] && dist[j] + step <= radius) {
          link(claim[i], claim[j]);
        }
      }
    }
    frontier = next;
  }
  return near;
}

/** The owner id that means nobody. Land holding it is never labelled. */
export const UNOWNED = 'NONE';

// Who holds a province: the occupier, else the owner.
export const controllerOf = (p) => p.occupier || p.owner;

/** Whether somebody other than its owner holds the province. */
export const isOccupied = (p) => !!(p?.occupier && p.occupier !== p.owner);

// Key that decides whether a frontier separates two touching provinces.
export const frontierKeyOf = (p) => (isOccupied(p)
  ? `${p.occupier}>${p.owner}`
  : controllerOf(p));

/** Whether a province belongs in a label block at all. */
export const isLabelled = (world, p) => {
  const held = controllerOf(p);
  return held !== UNOWNED && world.table.polityById.has(held);
};

// Top polity of a province's parent chain.
export function realmOf(table, id) {
  let at = id;
  for (let step = 0; step < 8; step++) {
    const parent = table?.polityById?.get(at)?.parent;
    if (!parent || parent === at || !table.polityById.has(parent)) return at;
    at = parent;
  }
  console.warn(`polity "${id}" sits in a parent loop; treating "${at}" as its realm`);
  return at;
}

// Whether owner is id or anywhere below it on the parent chain.
export function isUnder(table, owner, id) {
  let at = owner;
  for (let step = 0; step < 8 && at; step++) {
    if (at === id) return true;
    const parent = table?.polityById?.get(at)?.parent;
    if (!parent || parent === at) return false;
    at = parent;
  }
  return false;
}

/** The polities whose parent is `id`, not counting itself. */
export function membersOf(table, id) {
  return [...(table?.polityById?.values() || [])].filter((q) => q.parent === id && q.id !== id);
}

// Connected pieces of a set of provinces over the labelling graph.
export function componentsOf(world, near, members) {
  const inSet = new Set(members);
  const seen = new Set();
  const parts = [];

  for (const start of members) {
    if (seen.has(start)) continue;
    seen.add(start);
    const part = [];
    const stack = [start];
    while (stack.length) {
      const ix = stack.pop();
      part.push(ix);
      for (const id of labelNeighbours(world, near, world.atIndex[ix].id)) {
        const q = world.byId.get(id);
        if (!q || seen.has(q.index) || !inSet.has(q.index)) continue;
        seen.add(q.index);
        stack.push(q.index);
      }
    }
    parts.push(part);
  }
  return parts;
}

// Labelling neighbours of a province: real ones plus those within NEAR_GAP.
export function labelNeighbours(world, near, id) {
  const extra = near && near.get(world.byId.get(id).index);
  if (!extra) return world.adjacency.get(id);
  return [...world.adjacency.get(id), ...[...extra].map((ix) => world.atIndex[ix].id)];
}

// Moment and fit accumulators shared by full and per-block builds.

export const newMoments = () => ({ n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 });

export function addMoment(a, x, y) {
  a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.sxy += x * y; a.syy += y * y;
}

/** Centroid and principal axis, or null for a block too small to have one. */
export function blockAxis(a) {
  if (a.n < 12) return null;
  const cx = a.sx / a.n, cy = a.sy / a.n;
  const vxx = a.sxx / a.n - cx * cx;
  const vxy = a.sxy / a.n - cx * cy;
  const vyy = a.syy / a.n - cy * cy;
  const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);   // principal eigenvector
  return { cx, cy, ux: Math.cos(theta), uy: Math.sin(theta), n: a.n };
}

export const newFit = () => ({
  tMin: Infinity, tMax: -Infinity, n: 0, pp: 0, hist: new Map(),
  s0: 0, s1: 0, s2: 0, s3: 0, s4: 0, u0: 0, u1: 0, u2: 0,
});

/** One pixel measured along the block's axis (t) and across it (u). */
export function addFitSample(f, g, x, y) {
  const dx = x - g.cx, dy = y - g.cy;
  const t = dx * g.ux + dy * g.uy;
  const u = -dx * g.uy + dy * g.ux;
  if (t < f.tMin) f.tMin = t; else if (t > f.tMax) f.tMax = t;
  const bucket = Math.floor(t / LABEL_HIST_BUCKET);      // land per slice along the axis
  f.hist.set(bucket, (f.hist.get(bucket) || 0) + 1);
  const t2 = t * t;
  f.n++; f.pp += u * u;
  f.s0++; f.s1 += t; f.s2 += t2; f.s3 += t2 * t; f.s4 += t2 * t2;
  f.u0 += u; f.u1 += u * t; f.u2 += u * t2;
}

// Groups provinces into same-owner blocks by flood fill.
export function buildBlocks(world, near) {
  const { byId, atIndex } = world;
  const blocks = [];
  const blockOf = new Map();

  for (const p of byId.values()) {
    if (blockOf.has(p.id) || !isLabelled(world, p)) continue;
    const n = blocks.length;
    const stack = [p.id];
    blockOf.set(p.id, n);
    while (stack.length) {
      const id = stack.pop();
      for (const q of labelNeighbours(world, near, id)) {
        if (blockOf.has(q) || controllerOf(byId.get(q)) !== controllerOf(p)) continue;
        blockOf.set(q, n);
        stack.push(q);
      }
    }
    blocks.push({ owner: controllerOf(p), members: [] });
  }
  if (!blocks.length) return null;

  const blockAt = new Int32Array(atIndex.length).fill(-1);
  for (const [id, b] of blockOf) {
    const ix = byId.get(id).index;
    blockAt[ix] = b;
    blocks[b].members.push(ix);
  }
  return { blocks, blockAt };
}

/** Rebuilds each block's member list from blockAt. For a cache restore. */
export function attachBlockMembers(geometry) {
  for (const blk of geometry.blocks) blk.members = [];
  for (let ix = 1; ix < geometry.blockAt.length; ix++) {
    const b = geometry.blockAt[ix];
    if (b >= 0) geometry.blocks[b].members.push(ix);
  }
  return geometry;
}

export function computeLabelGeometry(world) {
  const { width, provinceAt } = world;

  const height = provinceAt.length / width;
  const near = nearbyProvinces(provinceAt, width, height);

  const built = buildBlocks(world, near);
  if (!built) return null;
  const { blocks, blockAt } = built;

  const acc = blocks.map(newMoments);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const b = blockAt[provinceAt[i]];
      if (b >= 0) addMoment(acc[b], x, y);
    }
  }
  const geo = acc.map(blockAxis);

  const fit = geo.map((g) => g && newFit());
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const b = blockAt[provinceAt[i]];
      if (b >= 0 && geo[b]) addFitSample(fit[b], geo[b], x, y);
    }
  }

  return { blocks, blockAt, geo, fit, near };
}

// Builds realm blocks alongside their members' blocks.
// One block per listed country, holding all its provinces.
export function setIslandBlocks(world, geometry, plan) {
  const spare = [];
  geometry.blocks.forEach((blk, b) => {
    if (!blk || blk.level !== 'islands') return;
    blk.members = [];
    geometry.geo[b] = null;
    geometry.fit[b] = null;
    spare.push(b);
  });

  const touched = [];
  for (const [owner, members] of plan) {
    if (!members.length) continue;
    let b;
    if (spare.length) b = spare.pop();
    else {
      b = geometry.blocks.length;
      geometry.blocks.push(null);
      geometry.geo.push(null);
      geometry.fit.push(null);
    }
    geometry.blocks[b] = { owner, members: [...members], level: 'islands' };
    touched.push(b);
  }

  computeBlockGeometry(world, geometry, touched);
  return { touched, spare };
}

export function addRealmBlocks(world, geometry) {
  if (!geometry) return [];

  const spare = [];
  geometry.blocks.forEach((blk, b) => {
    if (!blk) return;
    if (blk.level === 'realm') {
      blk.members = [];
      geometry.geo[b] = null;
      geometry.fit[b] = null;
      spare.push(b);
    } else {
      blk.realmBlock = undefined;
    }
  });

  const byRealm = new Map();
  for (const p of world.byId.values()) {
    if (!isLabelled(world, p)) continue;
    const held = controllerOf(p);
    const realm = realmOf(world.table, held);
    if (realm === held) continue;                 // answers to nobody
    if (!byRealm.has(realm)) byRealm.set(realm, []);
    byRealm.get(realm).push(p.index);
  }

  const touched = [];
  const realmBlockAt = new Map();
  for (const [realm, members] of byRealm) {
    for (const part of componentsOf(world, geometry.near, members)) {
      let b;
      if (spare.length) b = spare.pop();
      else {
        b = geometry.blocks.length;
        geometry.blocks.push(null);
        geometry.geo.push(null);
        geometry.fit.push(null);
      }
      geometry.blocks[b] = { owner: realm, members: part, level: 'realm' };
      for (const ix of part) realmBlockAt.set(ix, b);
      touched.push(b);
    }
  }

  for (const blk of geometry.blocks) {
    if (!blk || blk.level === 'realm' || !blk.members.length) continue;
    const b = realmBlockAt.get(blk.members[0]);
    if (b !== undefined) blk.realmBlock = b;
  }

  computeBlockGeometry(world, geometry, touched);

  for (const b of touched) {
    const blk = geometry.blocks[b];
    let top = Infinity, bottom = -Infinity;
    for (const ix of blk.members) {
      const bb = world.bounds.get(world.atIndex[ix].id);
      if (!bb) continue;
      if (bb.minY < top) top = bb.minY;
      if (bb.maxY > bottom) bottom = bb.maxY;
    }
    blk.spanY = bottom >= top ? bottom - top + 1 : 0;
  }

  return touched.concat(spare);
}

// Recomputes geometry for named blocks from their member provinces.
export function computeBlockGeometry(world, geometry, ids) {
  const { width, provinceAt, bounds, atIndex } = world;

  for (const b of ids) {
    const blk = geometry.blocks[b];
    if (!blk || !blk.members.length) {
      geometry.geo[b] = null;
      geometry.fit[b] = null;
      continue;
    }

    const acc = newMoments();
    for (const ix of blk.members) {
      const bb = bounds.get(atIndex[ix].id);
      if (!bb) continue;
      for (let y = bb.minY; y <= bb.maxY; y++) {
        const row = y * width;
        for (let x = bb.minX; x <= bb.maxX; x++) {
          const wx = x < width ? x : x - width;
          if (provinceAt[row + wx] === ix) addMoment(acc, x, y);
        }
      }
    }

    const g = blockAxis(acc);
    geometry.geo[b] = g;
    if (!g) { geometry.fit[b] = null; continue; }

    const f = newFit();
    for (const ix of blk.members) {
      const bb = bounds.get(atIndex[ix].id);
      if (!bb) continue;
      for (let y = bb.minY; y <= bb.maxY; y++) {
        const row = y * width;
        for (let x = bb.minX; x <= bb.maxX; x++) {
          const wx = x < width ? x : x - width;
          if (provinceAt[row + wx] === ix) addFitSample(f, g, x, y);
        }
      }
    }
    geometry.fit[b] = f;
  }
}
