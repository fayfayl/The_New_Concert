// Updates colours, blocks and border distances when provinces change hands.

// Query string this module was loaded with, for versioned imports.
const VERSION = new URL(import.meta.url).search;

const {
  BORDER_DIST_REACH, refreshBorderDistance,
  computeBlockGeometry, labelNeighbours, isLabelled, componentsOf,
} = await import(`./mapdata.js${VERSION}`);

// Padding around a changed province for the border distance redo.
const MARGIN = BORDER_DIST_REACH + 1;

// Hands provinces to new owners; returns the touched blocks or null.
export function setOwners(world, geometry, changes) {
  const changed = [];
  const blocks = new Set();

  for (const change of changes) {
    const [id, owner] = Array.isArray(change) ? change : [change.province, change.owner];
    const p = world.byId.get(id);
    if (!p) { console.warn(`setOwners: no province "${id}"`); continue; }
    if (!world.table.polityById.has(owner)) { console.warn(`setOwners: no polity "${owner}"`); continue; }
    if (p.owner === owner) continue;

    if (geometry) leaveBlock(world, geometry, p, blocks);
    p.owner = owner;
    if (geometry) joinBlock(world, geometry, p, blocks);
    changed.push(p);
  }
  if (!changed.length) return null;

  const boxes = mergeBoxes(changed.flatMap((p) => {
    const bb = world.bounds.get(p.id);
    return bb ? regionsFor(world, bb) : [];
  }));

  if (world.borderDist) {
    for (const box of boxes) refreshBorderDistance(world, world.borderDist, box);
  }
  if (geometry) computeBlockGeometry(world, geometry, blocks);

  return { changed: changed.map((p) => p.id), blocks, boxes };
}

// ------------------------------------------------------------------ blocks

// Removes a province from its block, splitting the remainder if cut.
function leaveBlock(world, geometry, p, touched) {
  const b = geometry.blockAt[p.index];
  if (b < 0) return;                       // unowned, or never in a block

  const blk = geometry.blocks[b];
  blk.members = blk.members.filter((ix) => ix !== p.index);
  geometry.blockAt[p.index] = -1;
  touched.add(b);
  if (blk.members.length < 2) return;      // nothing left that could be split

  const parts = componentsOf(world, geometry.near, blk.members);
  if (parts.length < 2) return;

  blk.members = parts[0];
  for (const rest of parts.slice(1)) {
    const nb = addBlock(geometry, blk.owner);
    geometry.blocks[nb].members = rest;
    for (const ix of rest) geometry.blockAt[ix] = nb;
    touched.add(nb);
  }
}

// Adds a province to its new owner's block, merging blocks it joins.
function joinBlock(world, geometry, p, touched) {
  if (!isLabelled(world, p)) return;       // unowned land belongs to no block

  const targets = new Set();
  for (const id of labelNeighbours(world, geometry.near, p.id)) {
    const q = world.byId.get(id);
    if (!q || q.owner !== p.owner) continue;
    const b = geometry.blockAt[q.index];
    if (b >= 0) targets.add(b);
  }

  const list = [...targets].sort((a, b) => a - b);
  const target = list.length ? list[0] : addBlock(geometry, p.owner);
  const blk = geometry.blocks[target];

  for (const other of list.slice(1)) {
    const o = geometry.blocks[other];
    for (const ix of o.members) {
      geometry.blockAt[ix] = target;
      blk.members.push(ix);
    }
    o.members = [];                        // emptied, and so loses its label
    touched.add(other);
  }

  blk.members.push(p.index);
  geometry.blockAt[p.index] = target;
  touched.add(target);
}

// Appends an empty block and returns its id.
function addBlock(geometry, owner) {
  const b = geometry.blocks.length;
  geometry.blocks.push({ owner, members: [] });
  geometry.geo.push(null);
  geometry.fit.push(null);
  return b;
}

// ----------------------------------------------------------------- regions

// Rectangles a province's change can disturb, grown by MARGIN.
function regionsFor(world, bb) {
  const y0 = Math.max(0, bb.minY - MARGIN);
  const y1 = Math.min(world.height, bb.maxY + 1 + MARGIN);
  const x0 = bb.minX - MARGIN;
  const x1 = bb.maxX + 1 + MARGIN;

  if (x1 - x0 >= world.width) return [{ x0: 0, y0, x1: world.width, y1 }];

  const out = [{ x0: Math.max(0, x0), y0, x1: Math.min(world.width, x1), y1 }];
  if (x0 < 0) out.push({ x0: world.width + x0, y0, x1: world.width, y1 });
  if (x1 > world.width) out.push({ x0: 0, y0, x1: x1 - world.width, y1 });
  return out;
}

// Merges overlapping rectangles.
function mergeBoxes(list) {
  const out = [];
  for (const box of list) {
    let merged = box;
    for (let i = out.length - 1; i >= 0; i--) {
      const other = out[i];
      const hits = merged.x0 < other.x1 && other.x0 < merged.x1
        && merged.y0 < other.y1 && other.y0 < merged.y1;
      if (!hits) continue;
      merged = {
        x0: Math.min(merged.x0, other.x0), y0: Math.min(merged.y0, other.y0),
        x1: Math.max(merged.x1, other.x1), y1: Math.max(merged.y1, other.y1),
      };
      out.splice(i, 1);
    }
    out.push(merged);
  }
  return out;
}
