/*
 * mapcache.js — the precomputed map, on disk.
 *
 * Deriving the world from the bitmap costs the better part of a second: a
 * colour lookup per pixel, an adjacency scan, a distance transform, and two
 * more full-map passes for the labels. None of it depends on anything that
 * happens at runtime, so sync-provinces.js does it once and writes the answers
 * to data/map-cache.bin. The page then loads that instead.
 *
 * The cache is an OPTIMISATION, never a source of truth. It carries a hash of
 * the two files it was built from, and the reader throws it away and computes
 * from scratch if either has moved on. A stale cache showing yesterday's
 * borders would be a genuinely horrible bug, so it is made impossible rather
 * than merely unlikely.
 *
 * Layout, before compression:
 *
 *   "CHM1"                4 bytes
 *   metaLength            uint32, little endian
 *   meta                  metaLength bytes of UTF-8 JSON
 *   provinceAt            width * height uint16
 *   borderDist            width * height uint8
 *
 * The small structures — bounds, adjacency, coastline, label geometry — live in
 * the JSON, where they cost a few tens of KB and stay readable. The two per-
 * pixel arrays are raw. Compression is the caller's business: Node deflates,
 * the browser inflates, and neither belongs in here.
 */

// Bump whenever the meaning of what is stored changes — a new field, or a
// change to how any of it is derived. The hash catches changed INPUTS; this
// catches changed CODE, which the hash cannot see. Version 2: label blocks now
// join provinces that come within NEAR_GAP pixels of each other.
export const CACHE_VERSION = 2;
export const CACHE_FILE = 'map-cache.bin';

const MAGIC = 0x314d4843;      // "CHM1" read as a little-endian uint32

// ------------------------------------------------------------------ hashing

/** FNV-1a. Not cryptographic — it only has to notice that a file changed. */
export function hashBytes(bytes, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Identifies the inputs a cache was built from: the bitmap's bytes, and the
 * fields of the JSON the derived data actually depends on.
 *
 * Names and terrain are deliberately excluded — renaming a province changes
 * nothing about adjacency, borders or geometry, and invalidating a 15-million
 * pixel cache over a typo would be miserable. Owners ARE included, because both
 * the distance field and the label blocks are built from them.
 *
 * `raw` must be the JSON as parsed, before normaliseTable() rewrites colours.
 */
export function hashInputs(pngBytes, raw) {
  const parts = [String(raw.oceanColour)];
  for (const p of raw.provinces || []) parts.push(`${p.id}|${p.colour}|${p.owner}`);
  const text = new TextEncoder().encode(parts.join(';'));
  return hashBytes(text, hashBytes(pngBytes));
}

// ------------------------------------------------------------------ writing

/**
 * Flattens the derived world into the plain structures the cache stores.
 *
 * Everything is keyed by province INDEX rather than id, because indices are
 * small integers that pack tightly and the reader rebuilds the id mapping from
 * provinces.json anyway.
 */
export function buildCacheMeta(world, geometry, hash) {
  const { atIndex, byId, adjacency, bounds, coastal } = world;
  const n = atIndex.length - 1;
  const indexOf = new Map([...byId.values()].map((p) => [p.id, p.index]));

  const meta = {
    version: CACHE_VERSION,
    hash,
    width: world.width,
    height: world.height,
    provinces: n,
    bounds: [],
    adjacency: [],
    coastal: [],
    labels: null,
  };

  for (let ix = 1; ix <= n; ix++) {
    const p = atIndex[ix];
    const bb = bounds.get(p.id);
    // A province with no pixels in the bitmap has no box at all.
    meta.bounds.push(bb ? [bb.minX, bb.minY, bb.maxX, bb.maxY, bb.n, bb.cx, bb.cy] : null);
    meta.adjacency.push([...(adjacency.get(p.id) || [])].map((id) => indexOf.get(id)));
    if (coastal.has(p.id)) meta.coastal.push(ix);
  }

  if (geometry) {
    meta.labels = {
      blocks: geometry.blocks.map((b) => b.owner),
      blockAt: Array.from(geometry.blockAt),
      geo: geometry.geo,
      // A Map does not survive JSON, so the histograms go as entry pairs.
      fit: geometry.fit.map((f) => f && { ...f, hist: [...f.hist] }),
    };
  }
  return meta;
}

/** Meta plus the two per-pixel arrays, as one buffer. Not compressed. */
export function packCache(meta, provinceAt, borderDist) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const head = 8 + json.length;
  const out = new Uint8Array(head + provinceAt.byteLength + borderDist.byteLength);
  const view = new DataView(out.buffer);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(new Uint8Array(provinceAt.buffer, provinceAt.byteOffset, provinceAt.byteLength), head);
  out.set(borderDist, head + provinceAt.byteLength);
  return out;
}

// ------------------------------------------------------------------ reading

/** Reverses packCache. Returns null on anything unexpected. */
export function unpackCache(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return null;

  const jsonLength = view.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength)));
  if (meta.version !== CACHE_VERSION) return null;

  const pixels = meta.width * meta.height;
  const at = 8 + jsonLength;
  if (bytes.length !== at + pixels * 3) return null;      // 2 bytes + 1 byte per pixel

  // Copied rather than viewed: a typed array over a subarray inherits the whole
  // buffer, which would pin the compressed bytes in memory for the session.
  const provinceAt = new Uint16Array(pixels);
  new Uint8Array(provinceAt.buffer).set(bytes.subarray(at, at + pixels * 2));
  const borderDist = bytes.slice(at + pixels * 2);

  return { meta, provinceAt, borderDist };
}

/**
 * Rebuilds what buildWorld() would have produced, without touching a pixel.
 *
 * `indexProvinces` is passed in rather than imported so this module stays
 * free of any dependency on the scanning code it exists to skip.
 */
export function worldFromCache(table, cache, indexProvinces) {
  const { meta, provinceAt, borderDist } = cache;
  const { byId, atIndex } = indexProvinces(table);
  if (atIndex.length - 1 !== meta.provinces) return null;   // JSON and cache disagree

  const adjacency = new Map();
  const bounds = new Map();
  const coastal = new Set(meta.coastal.map((ix) => atIndex[ix].id));

  for (let ix = 1; ix <= meta.provinces; ix++) {
    const id = atIndex[ix].id;
    adjacency.set(id, new Set(meta.adjacency[ix - 1].map((j) => atIndex[j].id)));

    const b = meta.bounds[ix - 1];
    if (!b) continue;
    const [minX, minY, maxX, maxY, n, cx, cy] = b;
    // sx and sy are only the running sums the scan used to reach cx and cy;
    // they are restored so a cached bounds object is indistinguishable.
    bounds.set(id, { minX, minY, maxX, maxY, n, sx: cx * n, sy: cy * n, cx, cy });
  }

  const geometry = meta.labels && {
    blocks: meta.labels.blocks.map((owner) => ({ owner })),
    blockAt: Int32Array.from(meta.labels.blockAt),
    geo: meta.labels.geo,
    fit: meta.labels.fit.map((f) => f && { ...f, hist: new Map(f.hist) }),
  };

  return {
    world: {
      width: meta.width, height: meta.height,
      provinceAt, atIndex, byId, adjacency, coastal, bounds, table,
      borderDist,
    },
    geometry,
  };
}
