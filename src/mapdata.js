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
 *   - `terrain` and `climate` become lists, so a bare string works as shorthand
 *     for one tag and a province with neither still answers with an empty list
 *   - polities get a Map by id, since they are looked up per province per repaint
 * Mutates and returns the same object.
 */
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

/**
 * How many pixels two provinces must share before they count as neighbours.
 *
 * At 2, a single-pixel contact is ignored. That is not a frontier but a drawing
 * artefact — the pixel where three borders nearly meet, or a coastline a pixel
 * out of true. Raise it if the map is drawn coarsely and short contacts start
 * being meaningful; set it to 1 to count every touch as before.
 */
export const MIN_BORDER_PX = 2;

export function scanAdjacency(provinceAt, width, height, byId, atIndex) {
  const half = width / 2;
  const adjacency = new Map([...byId.keys()].map((id) => [id, new Set()]));
  const coastal = new Set();
  const bounds = new Map();
  const idOf = (index) => atIndex[index].id;

  // Touching pixels are COUNTED first and turned into neighbours afterwards,
  // because how much two provinces touch decides whether they are neighbours at
  // all — see MIN_BORDER_PX below.
  //
  // The key packs both indices into one number rather than a string. This runs
  // once per pixel along every boundary on the map, and building a string for
  // each would cost more than the whole scan.
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

      // Grow this province's box, count its pixels, and sum their positions.
      if (index !== OCEAN) {
        const id = idOf(index);
        let bb = bounds.get(id);
        if (!bb) {
          bounds.set(id, (bb = {
            minX: x, minY: y, maxX: x, maxY: y, n: 0, sx: 0, sy: 0,
            // The two halves of the map, kept apart so that a province holding
            // ground on both sides of the seam can be given a box that describes
            // where it is. See resolveWrap.
            maxLeft: -1, minRight: width, nLeft: 0, sxLeft: 0,
          }));
        }
        if (x < bb.minX) bb.minX = x; else if (x > bb.maxX) bb.maxX = x;
        if (y < bb.minY) bb.minY = y; else if (y > bb.maxY) bb.maxY = y;
        bb.n++; bb.sx += x; bb.sy += y;
        if (x < half) { if (x > bb.maxLeft) bb.maxLeft = x; bb.nLeft++; bb.sxLeft += x; }
        else if (x < bb.minRight) bb.minRight = x;
      }

      // The pair to the right, and at the last column that is column 0 of the
      // same row: the map is a globe and its left and right edges are the same
      // meridian. Land drawn to both edges is one landmass, so provinces meeting
      // there are neighbours, and an army may cross. Nothing wraps vertically,
      // since the poles are not joined to anything.
      link(index, provinceAt[x + 1 < width ? i + 1 : y * width]);
      if (y + 1 < height) link(index, provinceAt[i + width]); // pair below
    }
  }
  // Position sums become centroids now the counts are final. Note this is the
  // centre of MASS, not of the box: for an L-shaped province it can fall outside.
  for (const bb of bounds.values()) resolveWrap(bb, width);

  // Now decide which of those contacts are real frontiers.
  //
  // Two provinces meeting along a single pixel are not neighbours in any sense
  // the game should act on. It is what a hand-drawn map produces where three
  // borders nearly meet, or where a coastline is one pixel out — a place the two
  // shapes graze rather than adjoin. Treating it as a frontier gives an army a
  // route through a gap too small to see, and lights a country on the far side
  // of a mountain range when its neighbour is selected.
  //
  // Diagonal contact was already excluded, for the same reason at a smaller
  // scale. This is that rule carried one step further.
  let dropped = 0;
  for (const [key, n] of touch) {
    if (n < MIN_BORDER_PX) { dropped++; continue; }
    const a = Math.floor(key / 65536), b = key % 65536;
    adjacency.get(idOf(a)).add(idOf(b));
    adjacency.get(idOf(b)).add(idOf(a));
  }

  return { adjacency, coastal, bounds, contacts: touch.size, dropped };
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
 * The field depends on who owns what, so a province changing hands invalidates
 * part of it. It does not have to be rebuilt whole: see refreshBorderDistance,
 * which redoes a rectangle of it and is what ownership changes use.
 */
/**
 * Settles a province box, and its centroid, against the map wrapping.
 *
 * A box is one rectangle and the map has no left or right edge, so a province
 * holding ground on both sides of the seam gets a box spanning the whole map.
 * Verley-Maret occupies column 5999 and columns 0 to 381, which is 383 columns
 * of map, and its plain box is 6000 wide.
 *
 * Every pixel below the midpoint is at or before `maxLeft`, and every pixel at
 * or above it is at or after `minRight`, so nothing lies between the two. The
 * wrapped box therefore runs from `minRight` to `maxLeft + width` and holds
 * every pixel the province has, whatever its shape.
 *
 * Whichever box is narrower wins. A province spanning the middle of the map
 * rather than the seam keeps its plain box, since the wrapped one comes out
 * wider. `maxX` may therefore be at or past `width`, and every reader of it
 * takes x modulo width.
 */
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
  // The left-hand pixels sit a map width further along in this frame, so the
  // centroid is summed there and brought back into the map afterwards. Averaging
  // the raw x instead puts the centre of a seam province in the far hemisphere.
  bb.cx = ((bb.sx + bb.nLeft * width) / bb.n) % width;
  return bb;
}

/**
 * The sea equivalent of normaliseTable. Colours become [r,g,b] and the tag list
 * is made a list, so nothing downstream handles more than one form of either.
 */
export function normaliseSeaTable(table) {
  table.landColour = toRgb(table.landColour);
  for (const r of table.regions) {
    r.colour = toRgb(r.colour);
    r.tags = Array.isArray(r.tags) ? r.tags : (r.tags ? [r.tags] : []);
  }
  table.regionById = new Map(table.regions.map((r) => [r.id, r]));
  return table;
}

/**
 * sea.png read the way provinces.png is: one flat colour per region, the same
 * size, and the background colour standing for land.
 *
 * Index 0 means LAND here, where in the province world it means sea. The two
 * arrays are therefore complements of each other, and a pixel is in exactly one
 * of them.
 *
 * scanAdjacency does the second half unchanged. It was written against a
 * per-pixel index array and a table of things with ids, which is what this is,
 * so sea regions get the same wrapped bounds, the same centroids and the same
 * MIN_BORDER_PX rule about what counts as a border. Its `coastal` set comes back
 * meaning regions that touch land, which is all of them, and is discarded.
 */
/** indexProvinces for the sea. Slot 0 is land, so real regions start at 1. */
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
    if (k === landKey) continue;           // the array is already 0
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

/**
 * counties.json, on the same terms as the province and sea tables: colours
 * become [r,g,b] and the terrain list is made a list.
 */
/**
 * The sea subregions, which live in sea.json beside the regions they came from.
 *
 * One table, because a subregion is meaningless without its region and the two
 * are edited together. `landColour` is the sea table's, so this normalises what
 * normaliseSeaTable has not already.
 */
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

/** indexProvinces for the counties. Slot 0 is sea, so real counties start at 1. */
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

/**
 * counties.png read the way provinces.png is: one flat colour per county, the
 * same size, with the ocean colour standing for water.
 *
 * The adjacency this produces is the one armies move on, so it uses the same
 * scanAdjacency as the provinces do: edges only, no diagonals, wrapping east to
 * west, and a contact shorter than MIN_BORDER_PX read as a drawing artefact
 * rather than a frontier.
 */
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

// The furthest a border can make itself felt, in map pixels. A distance is
// stored pre-scaled by CHAMFER_ORTH and saturates at BORDER_DIST_MAX, so
// nothing beyond this can be affected by a border appearing or disappearing —
// which is what bounds the rectangle an ownership change has to redo.
export const BORDER_DIST_REACH = Math.floor(BORDER_DIST_MAX / CHAMFER_ORTH);

/**
 * Owner per province index, as a small integer.
 *
 * Index 0 is ocean and keeps -1, which matches no country, so every coastline
 * counts as a frontier. Rebuilt from the table on every call, so it always
 * reflects the owners as they stand rather than as they loaded.
 */
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

/**
 * Recomputes the distance field over one rectangle of the map, in place.
 *
 * `box` is {x0, y0, x1, y1} in map pixels, half-open, or null for the whole
 * map. Both passes read freely OUTSIDE the box and only ever write inside it,
 * so a distance owed to a border beyond the rectangle still arrives: the path
 * from that border crosses the boundary at a pixel whose value is already
 * right, and the passes carry it in from there.
 *
 * That is only true while every pixel outside the box does hold its correct
 * distance. Which pixels an ownership change can disturb is bounded by
 * BORDER_DIST_REACH, so a caller that grows the changed province's bounding box
 * by that much is safe; ownership.js is where that is done.
 */
export function refreshBorderDistance(world, dist, box) {
  const { width, height, provinceAt, atIndex } = world;
  const ownerAt = ownerOrdinals(atIndex);

  const x0 = box ? Math.max(0, box.x0) : 0;
  const y0 = box ? Math.max(0, box.y0) : 0;
  const x1 = box ? Math.min(width, box.x1) : width;
  const y1 = box ? Math.min(height, box.y1) : height;
  if (x1 <= x0 || y1 <= y0) return;

  const MAX = BORDER_DIST_MAX;

  // Seeds: the sea, and any land pixel with a differently owned neighbour. All
  // four directions are tested, unlike the border drawing which needs only two
  // — a one-sided seed would bias the whole field a pixel in one direction.
  // Everything else in the box is reset to MAX, so a rectangle redone after a
  // border disappeared is not left holding the distances that border set.
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const index = provinceAt[i];
      if (index === OCEAN) { dist[i] = 0; continue; }
      // NO DIRECTION FALLS BACK TO -1, in any of the four. Sideways it wraps,
      // because the map does. Up and down fall back to the pixel's own owner,
      // which is the same as not testing that direction at all.
      //
      // -1 means "somebody else is there", and there is nobody on the other side
      // of either edge. Sideways it made column 0 and the last column a frontier
      // down open country that is not divided at all. Vertically it did the same
      // to the first and last row: 100% of the 4,246 land pixels in row 2649 came
      // out as frontier against 0.1% one row in, and a frontier is drawn at full
      // strength, so it was a solid line straight across the bottom of the map
      // where Kontaria runs off the edge.
      //
      // The map is a band cut out of the globe. A cut is not a border.
      // See test/borderdist-map.mjs, which measures all four edges.
      const mine = ownerAt[index];
      const left = ownerAt[provinceAt[x > 0 ? i - 1 : i + width - 1]];
      const right = ownerAt[provinceAt[x + 1 < width ? i + 1 : y * width]];
      const up = y > 0 ? ownerAt[provinceAt[i - width]] : mine;
      const down = y + 1 < height ? ownerAt[provinceAt[i + width]] : mine;
      dist[i] = (left !== mine || right !== mine || up !== mine || down !== mine) ? 0 : MAX;
    }
  }

  const A = CHAMFER_ORTH, B = CHAMFER_DIAG;

  // The SEEDS wrap, as the note above says, so a frontier crossing the map seam is
  // marked on both sides of it. The distances that spread out from those seeds did
  // not, and that is the other half of the same problem: a pixel in the last column
  // could not be told how far it was from a frontier just east of the first column,
  // so it kept MAX while its neighbour across the seam held a small number. The
  // shading is read straight off this field, and a step from MAX to nearly zero in
  // the space of one column draws as a hard line down open country. On the map that
  // is x 5999, the antimeridian.
  //
  // Only a pass over the whole width can wrap. A partial box that stops short of
  // either edge has no seam in it to cross.
  const wrapX = x0 === 0 && x1 === width;

  // How far a distance can travel before it saturates, which is as far as anything
  // needs to reach around the seam. Anything past this is already MAX on both
  // sides and has nothing to say to the other.
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
      dist[i] = d > MAX ? MAX : d;      // clamp by hand: Uint8Array wraps, it does not saturate
    };
    for (let x = x0; x < x1; x++) step(x);

    // The row again, over its first few columns. The reads above the row were
    // final when they were taken, but the one to the LEFT of column 0 is the last
    // column of this same row, which the sweep had not reached yet. Now it has.
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
    for (let x = width - 1; x >= width - tail; x--) step(x);   // the same, at the other end
  }
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
/** A narrow channel of sea still counts as one country, up to this many pixels. */
export const NEAR_GAP = 5;

/**
 * Which provinces come within NEAR_GAP pixels of each other across open water.
 *
 * Touching is too strict a test for labelling. An island a few pixels off the
 * coast is plainly part of the same country to anyone looking at the map, but
 * scanAdjacency() sees no shared border and the label machinery treats it as a
 * separate territory — so it gets a name of its own, in tiny type, instead of
 * being swept into the one big label it belongs to.
 *
 * This grows every province outwards through the sea, one ring at a time, up to
 * `radius`. Where two growths meet, the provinces behind them are that far apart
 * and are recorded as near neighbours. One pass over the coastal water settles
 * every pair at once, which is why this is cheap despite sounding expensive:
 * only sea within `radius` of land is ever visited.
 *
 * The spread goes through WATER only. Two provinces separated by a third are
 * already connected through it, or deliberately are not.
 */
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
        if (provinceAt[j] !== OCEAN) continue;        // land is scanAdjacency's business

        if (!claim[j]) {
          claim[j] = claim[i];
          dist[j] = step;
          next.push(j);
        } else if (claim[j] !== claim[i] && dist[j] + step <= radius) {
          // Two growths have met: their provinces are dist[j] + step apart.
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

/**
 * Who holds the ground: the occupier where there is one, the owner otherwise.
 *
 * `owner` is the de jure owner and stays put under occupation, since it is what a
 * peace treaty transfers and what a claim is measured against. Everything DRAWN
 * reads this instead, because a political map shows who is in control. So an
 * occupied province takes the occupier's colour, sits inside the occupier's
 * border, and counts toward the occupier's name.
 */
export const controllerOf = (p) => p.occupier || p.owner;

/**
 * What decides whether two touching provinces are separated by a frontier.
 *
 * Not the same question as who holds the ground. Fatiras is held by Vosennac and
 * so is Marche de Fatiras, so `controllerOf` gives both the same answer and the
 * line between them would be drawn as an internal subdivision. It is not one:
 * one is Voseni soil and the other is Cunarian soil under occupation, and the
 * front between them is exactly where the map should show a border.
 *
 * So occupied ground keys on the pair, occupier and owner both. Two occupations
 * by the same power over different countries separate for the same reason.
 */
export const frontierKeyOf = (p) => (p.occupier && p.occupier !== p.owner
  ? `${p.occupier}>${p.owner}`
  : controllerOf(p));

/** Whether a province belongs in a label block at all. */
export const isLabelled = (world, p) => {
  const held = controllerOf(p);
  return held !== UNOWNED && world.table.polityById.has(held);
};

/**
 * The polity at the top of a chain of `parent` links, which is the country a
 * province is really part of.
 *
 * `parent` means a constituent of one realm: Fellnor and Avanta are two halves
 * of one empire, so no frontier runs between them and one name covers both.
 * `suzerain` is deliberately NOT followed, being the looser hold a power has
 * over a colony — a colony is its own country on the map, drawn with its own
 * frontier and its own name, whoever it answers to.
 *
 * The walk is bounded rather than trusting the data, since a parent loop
 * written by hand would otherwise hang the page at load.
 */
export function realmOf(table, id) {
  let at = id;
  for (let step = 0; step < 8; step++) {
    const parent = table.polityById.get(at)?.parent;
    if (!parent || parent === at || !table.polityById.has(parent)) return at;
    at = parent;
  }
  console.warn(`polity "${id}" sits in a parent loop; treating "${at}" as its realm`);
  return at;
}

/**
 * Connected pieces of a set of province indices, over the labelling graph.
 *
 * Shared by the label blocks, by a realm's blocks, and by ownership.js when a
 * province leaving a block cuts what is left in two — all the same question.
 */
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

/**
 * A province's neighbours for LABELLING, which is its real neighbours plus the
 * ones it comes within NEAR_GAP of across water. Returns ids.
 */
export function labelNeighbours(world, near, id) {
  const extra = near && near.get(world.byId.get(id).index);
  if (!extra) return world.adjacency.get(id);
  return [...world.adjacency.get(id), ...[...extra].map((ix) => world.atIndex[ix].id)];
}

/*
 * The two accumulators below are shared by the full-map build and by the
 * per-block rebuild an ownership change runs. One copy of the arithmetic, so a
 * block recomputed after changing hands is identical to the same block computed
 * from cold, and a province changing owner cannot make its country's name jump.
 */

export const newMoments = () => ({ n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 });

export function addMoment(a, x, y) {
  a.n++; a.sx += x; a.sy += y; a.sxx += x * x; a.sxy += x * y; a.syy += y * y;
}

/** Centroid and principal axis, or null for a block too small to have one. */
export function blockAxis(a) {
  if (a.n < 12) return null;                  // too few pixels for a meaningful axis
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

/**
 * Groups provinces into blocks: flood fill the adjacency graph, never crossing
 * into a different owner. Unowned land gets no label.
 *
 * Each block carries its members as province indices, so a block can be
 * measured, split or merged later without another pass over the map.
 */
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

  // Provinces that all but touch count as touching for labelling — see above.
  const height = provinceAt.length / width;
  const near = nearbyProvinces(provinceAt, width, height);

  const built = buildBlocks(world, near);
  if (!built) return null;
  const { blocks, blockAt } = built;

  // --- STEP 1: one pass over the map summing each block's pixel positions, which
  //     gives the centroid and covariance, and from those the principal axis.
  // Both passes below walk x and y as loop counters rather than deriving them
  // from the index. A division and a modulo per pixel is invisible on a small
  // map and tens of millions of operations on a large one.
  const acc = blocks.map(newMoments);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const b = blockAt[provinceAt[i]];
      if (b >= 0) addMoment(acc[b], x, y);
    }
  }
  const geo = acc.map(blockAxis);

  // --- STEP 2: a second pass, now that the axis is known. Each pixel is measured
  //     along it (t) and across it (u). The sums feed the least-squares spine,
  //     and the tally of pixels per slice of t feeds denseRange.
  const fit = geo.map((g) => g && newFit());
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const b = blockAt[provinceAt[i]];
      if (b >= 0 && geo[b]) addFitSample(fit[b], geo[b], x, y);
    }
  }

  // `near` travels with the geometry. Rebuilding it costs a pass over every
  // coastal pixel on the map, and an ownership change needs the same graph the
  // blocks were built from to decide what merges with what.
  return { blocks, blockAt, geo, fit, near };
}

/**
 * Blocks for the REALMS, alongside the blocks for their members.
 *
 * A realm made of several polities has two names that could be written across
 * it — the empire's, and each kingdom's — and which one belongs on the map
 * depends on how much of the screen the country fills. So both are built, and
 * §4 of main.js decides between them by size, the same measure that decides
 * whether any label is worth drawing at all.
 *
 * Blocks are only added for a realm that HAS members below it. A country whose
 * polity is its own realm, which is nearly all of them, already had its label.
 *
 * Cheap despite adding a second layer: the geometry is measured over the member
 * provinces' bounding boxes rather than over the map, and only a handful of
 * countries on the map are composite.
 *
 * Rebuilt rather than updated when provinces change hands, since which provinces
 * a realm holds is exactly what changes then. Returns the blocks touched.
 */
/**
 * One block per country listed, holding every province it owns whether or not
 * the pieces touch.
 *
 * Ordinary blocks are contiguous by construction, which is what a name written
 * along a landmass needs and is no use to a country that has no landmass. An
 * island country is several blocks of one province each, none of them able to
 * carry the name, and naming the largest leaves the rest of the country bare.
 * This is the other shape: one block for the whole country, so a name can run
 * across islands buildBlocks would never have joined.
 *
 * `plan` maps a polity id to the province indices its block should hold. Slots
 * are recycled the way realm blocks recycle them, so calling this on every
 * ownership change does not grow the arrays. Returns the blocks now holding a
 * country and the slots left over, whose labels the caller drops.
 */
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

  // Empty the ones from last time and keep their slots. A block id indexes into
  // three arrays and into the caller's labels, so growing the arrays on every
  // ownership change would leak a slot each time.
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
    // One block per contiguous piece, as for any other block: a realm split
    // across a sea gets its name written on each half.
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

  // Each member block is pointed at the realm block covering it, so its label
  // knows whose name is standing in for its own.
  for (const blk of geometry.blocks) {
    if (!blk || blk.level === 'realm' || !blk.members.length) continue;
    const b = realmBlockAt.get(blk.members[0]);
    if (b !== undefined) blk.realmBlock = b;
  }

  computeBlockGeometry(world, geometry, touched);

  // How tall the realm's ground is, in map pixels, which is what decides when
  // its name gives way to its members'. Taken over the member provinces only,
  // so a colony half a world away does not stretch it: colonies hang off
  // `suzerain` and are never in a realm block to begin with.
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

  return touched.concat(spare);          // the leftovers lose their labels
}

/**
 * Redoes the geometry of named blocks only, by walking their member provinces
 * rather than the map.
 *
 * Cost is the member provinces' bounding boxes, not 15.9 million pixels, which
 * is what makes recomputing a label affordable when a province changes hands.
 * Blocks left empty by a change come back as null and lose their label.
 */
export function computeBlockGeometry(world, geometry, ids) {
  const { width, provinceAt, bounds, atIndex } = world;

  for (const b of ids) {
    const blk = geometry.blocks[b];
    if (!blk || !blk.members.length) {
      geometry.geo[b] = null;
      geometry.fit[b] = null;
      continue;
    }

    // Each member is walked over its OWN box and counted only where the pixel
    // is really its own, so two members with overlapping boxes cannot count the
    // same pixel twice.
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
