// Reads and writes the precomputed map cache.

// Cache format version; bumped when stored data or its derivation changes.
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

// Hash of the bitmaps and JSON fields the cached data is derived from.
export function hashInputs(pngBytes, raw, seaPngBytes = null, seaRaw = null,
  countyPngBytes = null, countyRaw = null, subPngBytes = null) {
  const parts = [String(raw.oceanColour)];
  for (const p of raw.provinces || []) parts.push(`${p.id}|${p.colour}|${p.owner}|${p.occupier ?? ''}`);

  if (seaRaw) {
    parts.push(`sea|${seaRaw.landColour}`);
    for (const r of seaRaw.regions || []) parts.push(`${r.id}|${r.colour}`);
  }

  if (countyRaw) {
    parts.push(`counties|${countyRaw.oceanColour}`);
    for (const c of countyRaw.counties || []) parts.push(`${c.id}|${c.colour}|${c.province}`);
  }

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

// Derives each province's occupier from county occupation.
export function applyCountyOccupation(raw, countyRaw, occupation) {
  const counties = countyRaw?.counties;
  if (!counties?.length) return;
  const byId = new Map(counties.map((c) => [c.id, c]));
  for (const [occupier, owners] of Object.entries(occupation || {})) {
    for (const ids of Object.values(owners || {})) {
      for (const id of ids || []) {
        const c = byId.get(id);
        if (c) c.occupier = occupier;
      }
    }
  }
  const tally = new Map();
  for (const c of counties) {
    if (!tally.has(c.province)) tally.set(c.province, { total: 0, by: new Map() });
    const t = tally.get(c.province);
    t.total++;
    if (c.occupier) t.by.set(c.occupier, (t.by.get(c.occupier) || 0) + 1);
  }
  for (const p of raw.provinces || []) {
    delete p.occupier;
    delete p.occupied;
    const t = tally.get(p.id);
    if (!t || !t.by.size) continue;
    let taken = 0, top = null, most = 0;
    for (const [who, n] of t.by) {
      if (who === p.owner) continue;
      taken += n;
      if (n > most || (n === most && who < top)) { top = who; most = n; }
    }
    if (!taken) continue;
    p.occupied = taken / t.total;
    if (most > t.total - taken) p.occupier = top;
  }
}

// ------------------------------------------------------------------ writing

// Sea half of the cache meta: box and neighbours per region, or null.
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

// Flattens the derived world into index-keyed structures for the cache.
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
    meta.bounds.push(bb ? [bb.minX, bb.minY, bb.maxX, bb.maxY, bb.n, bb.cx, bb.cy] : null);
    meta.adjacency.push([...(adjacency.get(p.id) || [])].map((id) => indexOf.get(id)));
    if (coastal.has(p.id)) meta.coastal.push(ix);
  }

  if (geometry) {
    meta.labels = {
      blocks: geometry.blocks.map((b) => b.owner),
      blockAt: Array.from(geometry.blockAt),
      geo: geometry.geo,
      fit: geometry.fit.map((f) => f && { ...f, hist: [...f.hist] }),
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
  const want = at + pixels * (3 + (meta.sea ? 2 : 0) + (meta.counties ? 2 : 0) + (meta.subs ? 2 : 0));
  if (bytes.length !== want) return null;

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

// Rebuilds the buildWorld() result from the cache without a pixel scan.
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
    bounds.set(id, { minX, minY, maxX, maxY, n, sx: cx * n, sy: cy * n, cx, cy });
  }

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
