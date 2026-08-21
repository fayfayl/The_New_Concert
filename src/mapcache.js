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
// catches changed CODE, which the hash cannot see.
//
// 2: label blocks join provinces that come within NEAR_GAP pixels of each other.
// 3: adjacency and the border distance field wrap east-west, so provinces
//    meeting at the map's seam are neighbours and the seam is no longer treated
//    as a frontier.
// 4: a contact shorter than MIN_BORDER_PX no longer makes two provinces
//    neighbours, so the adjacency graph is smaller than it was.
// 5: the label geometry carries the near-links as well. Provinces changing
//    hands re-block themselves against that graph, and deriving it again at
//    runtime would mean a pass over every coastal pixel on the map.
// 6: provinces can carry an occupier, and everything drawn reads that in place
//    of the owner, so the label blocks and the distance field are built from a
//    different partition than before.
// 7: the distance field separates occupied ground from the occupier's own, so
//    the front between them is a frontier. See frontierKeyOf in mapdata.js.
// 8: province boxes are resolved against the map wrapping, so a province holding
//    ground either side of the seam has a box describing where it is instead of
//    one spanning the whole map. maxX may be at or past width. See resolveWrap.
// 9: carries seaAt as well, the per-pixel sea region index built from sea.png.
//    Optional: meta.sea is null when there is no sea.png to read, and the
//    payload is then the two arrays it always was.
// 10: countyAt too, the per-pixel county index built from counties.png. Like
//     the sea it is optional: meta.counties is null when there is nothing to
//     read, and the payload is then two bytes a pixel shorter.
export const CACHE_VERSION = 12;
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
export function hashInputs(pngBytes, raw, seaPngBytes = null, seaRaw = null,
  countyPngBytes = null, countyRaw = null, subPngBytes = null) {
  const parts = [String(raw.oceanColour)];
  // Occupier is in here because it decides what the map is coloured, so a change
  // to it has to invalidate a cache built before it.
  for (const p of raw.provinces || []) parts.push(`${p.id}|${p.colour}|${p.owner}|${p.occupier ?? ''}`);

  // The sea is carried in the same file and so has to invalidate it on the same
  // terms: a redrawn sea.png, a renamed region, a recoloured one. Left out, the
  // digest is byte for byte the one a cache without a sea has always had.
  if (seaRaw) {
    parts.push(`sea|${seaRaw.landColour}`);
    for (const r of seaRaw.regions || []) parts.push(`${r.id}|${r.colour}`);
  }

  // And the counties, on the same terms. A hand edit to counties.png has to
  // invalidate the cache, or the page would draw the county map it built last
  // week over the provinces of today.
  if (countyRaw) {
    parts.push(`counties|${countyRaw.oceanColour}`);
    for (const c of countyRaw.counties || []) parts.push(`${c.id}|${c.colour}|${c.province}`);
  }

  // And the sea subregions. They live in sea.json beside the regions, so the
  // list above already moves when one is renamed or recoloured — but the BITMAP
  // is its own file and a hand edit to it has to invalidate the cache too.
  if (seaRaw && seaRaw.subregions) {
    for (const s of seaRaw.subregions) parts.push(`${s.id}|${s.colour}|${s.region}`);
  }

  const text = new TextEncoder().encode(parts.join(';'));
  let h = hashBytes(pngBytes);
  if (seaPngBytes) h = hashBytes(seaPngBytes, h);
  if (countyPngBytes) h = hashBytes(countyPngBytes, h);
  if (subPngBytes) h = hashBytes(subPngBytes, h);
  return hashBytes(text, h);
}

// ------------------------------------------------------------------ writing

/**
 * The sea half of the meta: one entry per region, in index order, holding the
 * same box and neighbour list a province gets. Null when there is no sea world,
 * which is what tells unpackCache the payload has no seaAt on the end.
 */
export function buildSeaMeta(sea) {
  if (!sea) return null;
  const n = sea.atIndex.length - 1;
  const indexOf = new Map([...sea.byId.values()].map((r) => [r.id, r.index]));
  const out = { regions: n, bounds: [], adjacency: [] };

  for (let ix = 1; ix <= n; ix++) {
    const r = sea.atIndex[ix];
    const bb = sea.bounds.get(r.id);
    out.bounds.push(bb ? [bb.minX, bb.minY, bb.maxX, bb.maxY, bb.n, bb.cx, bb.cy] : null);
    out.adjacency.push([...(sea.adjacency.get(r.id) || [])].map((id) => indexOf.get(id)));
  }
  return out;
}

/** Rebuilds the sea world from the cache, as worldFromCache does for provinces. */
export function seaFromCache(table, meta, seaAt, indexSea, width, height) {
  if (!meta || !seaAt) return null;
  const { byId, atIndex } = indexSea(table);
  if (atIndex.length - 1 !== meta.regions) return null;

  const adjacency = new Map();
  const bounds = new Map();
  for (let ix = 1; ix <= meta.regions; ix++) {
    const id = atIndex[ix].id;
    adjacency.set(id, new Set(meta.adjacency[ix - 1].map((j) => atIndex[j].id)));
    const b = meta.bounds[ix - 1];
    if (!b) continue;
    const [minX, minY, maxX, maxY, n, cx, cy] = b;
    bounds.set(id, { minX, minY, maxX, maxY, n, sx: cx * n, sy: cy * n, cx, cy });
  }
  return { width, height, seaAt, atIndex, byId, adjacency, bounds, table };
}

/**
 * Flattens the derived world into the plain structures the cache stores.
 *
 * Everything is keyed by province INDEX rather than id, because indices are
 * small integers that pack tightly and the reader rebuilds the id mapping from
 * provinces.json anyway.
 */
/** The county half of the meta, the same shape as buildSeaMeta. */
/** The sea subregion half of the meta, the same shape as buildCountyMeta. */
export function buildSubMeta(subs) {
  if (!subs) return null;
  const n = subs.atIndex.length - 1;
  const indexOf = new Map([...subs.byId.values()].map((s) => [s.id, s.index]));
  const out = { subs: n, bounds: [], adjacency: [] };

  for (let ix = 1; ix <= n; ix++) {
    const s = subs.atIndex[ix];
    const bb = subs.bounds.get(s.id);
    out.bounds.push(bb ? [bb.minX, bb.minY, bb.maxX, bb.maxY, bb.n, bb.cx, bb.cy] : null);
    out.adjacency.push([...(subs.adjacency.get(s.id) || [])].map((id) => indexOf.get(id)));
  }
  return out;
}

/** Rebuilds the subregion world from the cache. */
export function subsFromCache(table, meta, subAt, indexSubs, width, height) {
  if (!meta || !subAt) return null;
  const { byId, atIndex } = indexSubs(table);
  if (atIndex.length - 1 !== meta.subs) return null;

  const adjacency = new Map();
  const bounds = new Map();
  for (let ix = 1; ix <= meta.subs; ix++) {
    const id = atIndex[ix].id;
    adjacency.set(id, new Set(meta.adjacency[ix - 1].map((j) => atIndex[j].id)));
    const b = meta.bounds[ix - 1];
    if (!b) continue;
    const [minX, minY, maxX, maxY, n, cx, cy] = b;
    bounds.set(id, { minX, minY, maxX, maxY, n, sx: cx * n, sy: cy * n, cx, cy });
  }
  return { width, height, subAt, atIndex, byId, adjacency, bounds, table };
}

export function buildCountyMeta(counties) {
  if (!counties) return null;
  const n = counties.atIndex.length - 1;
  const indexOf = new Map([...counties.byId.values()].map((c) => [c.id, c.index]));
  const out = { counties: n, bounds: [], adjacency: [] };

  for (let ix = 1; ix <= n; ix++) {
    const c = counties.atIndex[ix];
    const bb = counties.bounds.get(c.id);
    out.bounds.push(bb ? [bb.minX, bb.minY, bb.maxX, bb.maxY, bb.n, bb.cx, bb.cy] : null);
    out.adjacency.push([...(counties.adjacency.get(c.id) || [])].map((id) => indexOf.get(id)));
  }
  return out;
}

/** Rebuilds the county world from the cache, as seaFromCache does for the sea. */
/*
 * WIDTH AND HEIGHT ARE PART OF THE ANSWER, not decoration. A world built by
 * buildCountyWorld carries them and one restored from the cache used not to,
 * so anything indexing by `world.width` came out with NaN offsets and read
 * nothing at all — silently, since NaN is a perfectly good array index that
 * simply never matches. That is what left the county highlight invisible: the
 * silhouette traced a shape of no pixels and the ring drawn round it was empty.
 * A world is a world however it was made.
 */
export function countiesFromCache(table, meta, countyAt, indexCounties, width, height) {
  if (!meta || !countyAt) return null;
  const { byId, atIndex } = indexCounties(table);
  if (atIndex.length - 1 !== meta.counties) return null;

  const adjacency = new Map();
  const bounds = new Map();
  for (let ix = 1; ix <= meta.counties; ix++) {
    const id = atIndex[ix].id;
    adjacency.set(id, new Set(meta.adjacency[ix - 1].map((j) => atIndex[j].id)));
    const b = meta.bounds[ix - 1];
    if (!b) continue;
    const [minX, minY, maxX, maxY, n, cx, cy] = b;
    bounds.set(id, { minX, minY, maxX, maxY, n, sx: cx * n, sy: cy * n, cx, cy });
  }
  return { width, height, countyAt, atIndex, byId, adjacency, bounds, table };
}

export function buildCacheMeta(world, geometry, hash, sea = null, counties = null) {
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
    sea: buildSeaMeta(sea),
    counties: buildCountyMeta(counties),
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
      // Likewise the near-links, which are a Map of Sets. Province indices, so
      // they cost a couple of numbers per island rather than a string each.
      near: [...(geometry.near || [])].map(([ix, set]) => [ix, [...set]]),
    };
  }
  return meta;
}

/** Meta plus the two per-pixel arrays, as one buffer. Not compressed. */
export function packCache(meta, provinceAt, borderDist, seaAt = null, countyAt = null, subAt = null) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const head = 8 + json.length;
  const out = new Uint8Array(head + provinceAt.byteLength + borderDist.byteLength
    + (seaAt ? seaAt.byteLength : 0) + (countyAt ? countyAt.byteLength : 0)
    + (subAt ? subAt.byteLength : 0));
  const view = new DataView(out.buffer);

  view.setUint32(0, MAGIC, true);
  view.setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(new Uint8Array(provinceAt.buffer, provinceAt.byteOffset, provinceAt.byteLength), head);
  out.set(borderDist, head + provinceAt.byteLength);
  let at = head + provinceAt.byteLength + borderDist.byteLength;
  if (seaAt) {
    out.set(new Uint8Array(seaAt.buffer, seaAt.byteOffset, seaAt.byteLength), at);
    at += seaAt.byteLength;
  }
  if (countyAt) {
    out.set(new Uint8Array(countyAt.buffer, countyAt.byteOffset, countyAt.byteLength), at);
    at += countyAt.byteLength;
  }
  if (subAt) {
    out.set(new Uint8Array(subAt.buffer, subAt.byteOffset, subAt.byteLength), at);
  }
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
  // 2 bytes for the province index, 1 for the border distance, and 2 more each
  // for the sea region and the county where the file carries them.
  const want = at + pixels * (3 + (meta.sea ? 2 : 0) + (meta.counties ? 2 : 0) + (meta.subs ? 2 : 0));
  if (bytes.length !== want) return null;

  // Copied rather than viewed: a typed array over a subarray inherits the whole
  // buffer, which would pin the compressed bytes in memory for the session.
  const provinceAt = new Uint16Array(pixels);
  new Uint8Array(provinceAt.buffer).set(bytes.subarray(at, at + pixels * 2));
  const borderDist = bytes.slice(at + pixels * 2, at + pixels * 3);

  let seaAt = null, countyAt = null, subAt = null;
  let from = at + pixels * 3;
  if (meta.sea) {
    seaAt = new Uint16Array(pixels);
    new Uint8Array(seaAt.buffer).set(bytes.subarray(from, from + pixels * 2));
    from += pixels * 2;
  }
  if (meta.counties) {
    countyAt = new Uint16Array(pixels);
    new Uint8Array(countyAt.buffer).set(bytes.subarray(from, from + pixels * 2));
    from += pixels * 2;
  }
  if (meta.subs) {
    subAt = new Uint16Array(pixels);
    new Uint8Array(subAt.buffer).set(bytes.subarray(from, from + pixels * 2));
  }

  return { meta, provinceAt, borderDist, seaAt, countyAt, subAt };
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

  // Members are left empty here and filled by attachBlockMembers(), so the
  // restored geometry matches what buildBlocks() would have produced.
  const geometry = meta.labels && {
    blocks: meta.labels.blocks.map((owner) => ({ owner, members: [] })),
    blockAt: Int32Array.from(meta.labels.blockAt),
    geo: meta.labels.geo,
    fit: meta.labels.fit.map((f) => f && { ...f, hist: new Map(f.hist) }),
    near: new Map((meta.labels.near || []).map(([ix, list]) => [ix, new Set(list)])),
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
