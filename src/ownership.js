/*
 * ownership.js — provinces changing hands after load.
 *
 * Three things are derived from who owns what, and each is handled differently
 * when an owner changes:
 *
 *   colours     Worked out fresh on every repaint from the province's current
 *               owner, so they need nothing here beyond a repaint of the right
 *               pixels. The same is true of the borders, which are found per
 *               pixel by comparing owners rather than stored.
 *   borderDist  A distance field over every pixel, used for the inland fade.
 *               Redone over a rectangle, not the map.
 *   labels      Provinces are grouped into blocks of one owner, and each block
 *               is measured. Only the blocks a change touches are regrouped and
 *               remeasured.
 *
 * The map is 15.9 million pixels and a country's label geometry is two passes
 * over all of them, so doing either from scratch per change is not an option:
 * a war moves provinces constantly and this has to cost about what the province
 * itself is worth.
 *
 * Nothing here draws or measures text. setOwners() reports which blocks need
 * their label rebuilt and which rectangles need repainting, and the caller does
 * both — building a label means measuring real type, which needs a canvas.
 *
 * COUNTIES. When counties arrive they are the same shape of problem one level
 * down: a county changes hands, its province's owner is whatever its counties
 * add up to, and only then does any of the above run. The entry point stays
 * setOwners(), taking province-level results.
 */

// Versioned for the same reason main.js versions its own imports: a static
// import here would resolve to an unversioned URL and could come from cache
// while the rest of the program is fresh.
const VERSION = new URL(import.meta.url).search;

const {
  BORDER_DIST_REACH, refreshBorderDistance,
  computeBlockGeometry, labelNeighbours, isLabelled, componentsOf,
} = await import(`./mapdata.js${VERSION}`);

// How far outside a changed province the distance field has to be redone. A
// border appearing or disappearing cannot be felt further than the field can
// measure, and the extra pixel covers the neighbouring pixels whose own seed
// test reads across the province's edge.
const MARGIN = BORDER_DIST_REACH + 1;

/**
 * Hands provinces to new owners.
 *
 * `changes` is an iterable of [provinceId, polityId]. Unknown ids and changes
 * that are not changes are skipped with a warning rather than throwing, since
 * this will be driven by events and by the AI.
 *
 * Returns null when nothing changed, otherwise:
 *   changed  the province ids that moved
 *   blocks   Set of label block ids whose label must be rebuilt
 *   boxes    map rectangles whose pixels are now wrong, {x0, y0, x1, y1}
 */
export function setOwners(world, geometry, changes) {
  const changed = [];
  const blocks = new Set();

  for (const change of changes) {
    const [id, owner] = Array.isArray(change) ? change : [change.province, change.owner];
    const p = world.byId.get(id);
    if (!p) { console.warn(`setOwners: no province "${id}"`); continue; }
    if (!world.table.polityById.has(owner)) { console.warn(`setOwners: no polity "${owner}"`); continue; }
    if (p.owner === owner) continue;

    // One province at a time, each seeing the owners as they stand at that
    // moment, so a batch behaves exactly as the same changes made in order.
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

  // Owners are all written by now, so a rectangle redone here sees the finished
  // state and two overlapping rectangles cannot disagree.
  if (world.borderDist) {
    for (const box of boxes) refreshBorderDistance(world, world.borderDist, box);
  }
  if (geometry) computeBlockGeometry(world, geometry, blocks);

  return { changed: changed.map((p) => p.id), blocks, boxes };
}

// ------------------------------------------------------------------ blocks

/**
 * Takes a province out of its block, splitting what is left if it no longer
 * hangs together.
 *
 * Losing a province can cut a block in two: a corridor between two halves of a
 * country, or the last province linking an island group to the mainland. Each
 * surviving piece becomes a block of its own and gets its own copy of the
 * country's name, which is what a cold load would have produced.
 */
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

/**
 * Puts a province into the block of its new owner, merging any blocks it now
 * joins together.
 *
 * A province can adjoin several blocks of the same owner at once, which is what
 * completing a land bridge looks like. All of them become one. A province with
 * no such neighbour starts a block of its own.
 */
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

/**
 * Appends an empty block and returns its id.
 *
 * Emptied blocks keep their slot rather than being removed, because a block id
 * is an index into three parallel arrays and into the caller's labels. Renumbering
 * them on every change would mean rebuilding every label on the map.
 */
function addBlock(geometry, owner) {
  const b = geometry.blocks.length;
  geometry.blocks.push({ owner, members: [] });
  geometry.geo.push(null);
  geometry.fit.push(null);
  return b;
}

// ----------------------------------------------------------------- regions

/**
 * The rectangles a province's change can have disturbed, grown by MARGIN.
 *
 * One rectangle usually, two for a province near the map's seam: east and west
 * are the same meridian, so a border there is felt on both edges of the bitmap.
 * A province wide enough that the grown box laps itself takes the full width.
 */
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

/**
 * Merges overlapping rectangles, so a batch of neighbouring provinces is redone
 * once rather than once each. Purely an economy: overlapping rectangles would
 * give the same answer, just more slowly.
 */
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
