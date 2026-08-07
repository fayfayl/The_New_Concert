/*
 * main.js — province map viewer.
 *
 * TWO SOURCES OF TRUTH, and they never overlap:
 *   provinces.png   SHAPE and NEIGHBOURS. Every province is one flat RGB colour.
 *   provinces.json  DATA — name, owner, terrain — keyed by that same colour.
 *
 * Nothing anywhere keeps a hand-written neighbour list. Adjacency is read out of
 * the pixels at load, so redrawing the bitmap updates the map's topology by
 * itself and cannot fall out of step with the data.
 *
 * WHAT HAPPENS, IN ORDER:
 *   1. load      JSON and PNG fetched, colours normalised                 (§1)
 *   2. build     pixels -> province per pixel -> adjacency, coasts, bounds (§2)
 *   3. labels    one name placed per contiguous block of territory        (§4)
 *   4. loop      render buffer -> blit through the view -> draw labels    (§3, §5, §6)
 *
 * Steps 1-3 run once, at boot. Only step 4 repeats.
 *
 * DRAWING IS IN TWO STAGES, which is what keeps panning smooth:
 *   painting   the map is drawn at map resolution into offscreen canvases, and
 *              only when a COLOUR changes. A new map mode repaints everything;
 *              a selection or a hover repaints just the provinces involved.
 *   blitting   drawView() puts the result on screen through the pan/zoom
 *              transform. Cheap, and all a pan or zoom actually needs.
 * The dirty flags in §6 decide which of them runs on any given frame.
 *
 * At map sizes in the millions of pixels, "the offscreen canvas" is really a
 * grid of tiles plus a small whole-map overview — see §3, which explains why.
 *
 * COORDINATES: "map pixels" are positions in the bitmap; "screen pixels" are CSS
 * pixels on the canvas. A map pixel (mx,my) lands at (mx*scale + x, my*scale + y).
 * Anything sized in map pixels grows as you zoom; anything in screen pixels does
 * not. Which one a value is in is noted wherever it is not obvious.
 */

// ============================================================ 1. data loading

// Map data changes constantly while drawing, and a stale cache looks exactly
// like a bug in the code. Always fetch fresh.
const noCache = (url) => `${url}?t=${Date.now()}`;

async function loadJSON(url) {
  const res = await fetch(noCache(url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`could not load ${url} (${res.status})`);
  return res.json();
}

/**
 * Read the bitmap's pixels exactly as authored.
 *
 * A PNG carrying an sRGB/ICC chunk is colour-managed into the display profile
 * on decode, nudging channels by a point or two. White never moves and pastels
 * barely do, but a saturated colour shifts enough to stop matching the JSON —
 * and that province then silently reads as ocean. This turns that off.
 */
async function loadPixels(url) {
  const res = await fetch(noCache(url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`could not load ${url} (${res.status})`);
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' });

  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return ctx.getImageData(0, 0, c.width, c.height, { colorSpace: 'srgb' });
}

/**
 * Loads the satellite imagery, or null if there is none.
 *
 * Kept as an ImageBitmap rather than decoded into a pixel array: it is only ever
 * blitted underneath the province colours, never inspected, so it can live on
 * the GPU. Decoding it would add another 60MB to the JavaScript heap for nothing.
 *
 * A missing file is not an error — the map works without it, and the toolbar
 * simply disables the button.
 */
async function loadBitmap(url) {
  try {
    const res = await fetch(noCache(url), { cache: 'no-store' });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none' });
  } catch {
    console.warn(`${url} could not be loaded; continuing without it.`);
    return null;
  }
}

/**
 * Accepts "#c44a3e", the shorthand "#c43", or an existing [r,g,b] array, and
 * always returns [r,g,b]. Throws on anything else rather than quietly yielding
 * a colour that would never match a pixel.
 */
function toRgb(value) {
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
function normaliseTable(table) {
  table.oceanColour = toRgb(table.oceanColour);
  for (const q of table.polities) q.colour = toRgb(q.colour);
  for (const p of table.provinces) {
    p.colour = toRgb(p.colour);
    p.terrain = Array.isArray(p.terrain) ? p.terrain : (p.terrain ? [p.terrain] : []);
  }
  table.polityById = new Map(table.polities.map((q) => [q.id, q]));
  return table;
}

// ============================================================= 2. world model

const OCEAN = 0;                    // province index 0 is reserved for sea and empty space
const UNKNOWN_POLITY = { id: '?', name: 'Unknown', colour: [90, 90, 96] };

// Packs a colour into one integer so it can key a Map. Comparing three separate
// channels per pixel, or building "r,g,b" strings, would both be far slower.
const rgbKey = (r, g, b) => (r << 16) | (g << 8) | b;

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
function buildWorld(table, image) {
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
function indexProvinces(table) {
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
function mapPixels(image, table, colourToIndex) {
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
function scanAdjacency(provinceAt, width, height, byId, atIndex) {
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
 * Reports colours found in the bitmap that no province claims, worst first.
 *
 * Each is shown with the nearest colour that IS in the table, because the
 * distance says what went wrong. A distance of only a few points means the same
 * colour arrived slightly altered — anti-aliasing, lossy compression, or the
 * colour management that loadPixels() turns off. A large distance means a
 * genuinely unregistered province.
 */
function warnUnknownColours(unknown, table) {
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
function warnEmptyProvinces(byId, bounds) {
  const empty = [...byId.values()].filter((p) => !bounds.has(p.id));
  if (empty.length) {
    console.warn(
      `${empty.length} province(s) matched no pixels and will behave as ocean:`,
      empty.map((p) => ({ id: p.id, name: p.name, expected: `rgb(${p.colour})` }))
    );
  }
}

// ================================================================ 3. rendering
//
// Everything here paints into the OFFSCREEN buffer, at map resolution and with
// no notion of pan or zoom. Putting it on screen is §5's job.

// The landscape tags. Impassable is deliberately absent: the rules make it a
// property a region carries rather than a landscape of its own, so averaging it
// in would wash out the terrain underneath it.
const TERRAIN_COLOURS = Object.fromEntries(Object.entries({
  Plains: '#7c945c',
  Hills: '#968454',
  Mountains: '#808086',
  Desert: '#ceb876',
  Jungle: '#487a4a',
  Arctic: '#ced8e0',
}).map(([k, v]) => [k, toRgb(v)]));

const IMPASSABLE = 'Impassable';
const IMPASSABLE_COLOUR = toRgb('#23262c');
const IMPASSABLE_MIX = 0.45;    // how far toward that near-black the landscape is pulled

// A province whose owner is not in the polity table still has to draw as
// something, so it falls back to a neutral grey rather than crashing the repaint.
const polityOf = (w, p) => w.table.polityById.get(p.owner) || UNKNOWN_POLITY;

// The three map modes. Each is just "province -> base [r,g,b]"; highlighting,
// borders and everything else is applied on top by renderBuffer().
const MODES = {
  political: (w, p) => polityOf(w, p).colour,
  province: (w, p) => p.colour,
  // Landscape tags average together, so Mountains + Arctic reads as snowfield
  // rather than as either one. Impassable is excluded from that average and
  // darkens the result instead — it is a property, not a landscape, so a
  // province should still read as the terrain it is while looking shut.
  terrain: (w, p) => {
    const cols = p.terrain.map((t) => TERRAIN_COLOURS[t]).filter(Boolean);
    const base = cols.length
      ? [0, 1, 2].map((c) => cols.reduce((s, q) => s + q[c], 0) / cols.length)
      : [120, 120, 120];
    if (!p.terrain.includes(IMPASSABLE)) return base.map(Math.round);
    return base.map((v, c) => Math.round(v + (IMPASSABLE_COLOUR[c] - v) * IMPASSABLE_MIX));
  },
};

// Border darkness, as a multiplier on the province's own colour. Subdivisions
// inside one country stay quiet; national borders and coastlines read strongly.
const BORDER_INTERNAL = 0.80;   // neighbour has the same owner
const BORDER_NATIONAL = 0.42;   // neighbour has a different owner, or is open sea

// How far each highlight state mixes its province toward white. A proportional
// mix, not a flat addition: adding a fixed amount would push an already-bright
// channel past 255 on a pale province, clipping it and shifting the hue as it
// brightens. Mixing lifts every channel by the same share of its own headroom.
const LIGHTEN = { selected: 0.24, neighbour: 0.15, hovered: 0.09 };

// Compositing over the satellite imagery. The province layer is drawn with a
// PER-PIXEL alpha rather than one opacity for the whole layer: interiors go
// translucent so the terrain reads through, while borders stay nearly solid.
// Fading the layer as a whole would wash the borders out along with everything
// else, and the borders are the part that has to stay legible.
const SATELLITE_FILL = 0.46;     // how much province colour shows over the imagery
const SATELLITE_EDGE = 0.88;     // borders and coastlines, which must stay readable

// The ring drawn around the selected province. Its width is in SCREEN pixels, so
// buildOutline() rebuilds it whenever the zoom changes. See §4 for how.
const OUTLINE_COLOUR = '#cea35eff';
const OUTLINE_WIDTH = 2.5;
const OUTLINE_MAX_PIXELS = 4e6;     // ceiling on the offscreen canvas the ring is built in

/* ------------------------------------------------------------ the buffer
 *
 * The painted map is not one canvas but a grid of TILE-sized ones, plus a small
 * downscaled copy of the whole thing. Both exist for the same reason: a single
 * 6000x2650 canvas is 64MB, and touching any part of it costs as if you had
 * touched all of it.
 *
 *   tiles     Full resolution, in chunks. A repaint uploads only the chunks it
 *             overlaps rather than a 64MB texture, and drawing uses only the
 *             chunks on screen. Used from OVERVIEW threshold upwards.
 *   overview  The entire map at whatever fits in OVERVIEW_MAX. Zoomed out, the
 *             whole map is on screen, so tiles would mean rescaling all 15.9
 *             million pixels every frame; this holds around a tenth of that and
 *             is never shown larger than its own resolution, so nothing is lost.
 *
 * A repaint keeps both in step: tiles first, then the same rectangle is copied
 * down into the overview.
 */
const TILE = 512;             // chunk edge, in map pixels
const OVERVIEW_MAX = 2048;    // longest edge of the zoomed-out copy

let tiles = null;             // { cols, rows, list: [{ x, y, w, h, canvas, ctx }] }
let overview = null;          // { canvas, ctx, scale }
let scratch = null;           // one reusable TILE x TILE ImageData, shared by every tile
let scratchCanvas = null;     // and a canvas of the same size, for compositing over imagery
let scratchCtx = null;

/** Builds the tile grid and the overview. Once per world. */
function buildTiles(world) {
  const cols = Math.ceil(world.width / TILE);
  const rows = Math.ceil(world.height / TILE);
  const list = [];
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x = tx * TILE, y = ty * TILE;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(TILE, world.width - x);      // edge tiles are short
      canvas.height = Math.min(TILE, world.height - y);
      list.push({ x, y, w: canvas.width, h: canvas.height, canvas, ctx: canvas.getContext('2d') });
    }
  }
  tiles = { cols, rows, list };
  scratch = list[0].ctx.createImageData(TILE, TILE);
  scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = TILE;
  scratchCanvas.height = TILE;
  scratchCtx = scratchCanvas.getContext('2d');

  // The overview is assembled tile by tile, so its scale is chosen to make one
  // tile land on a WHOLE number of overview pixels. At an arbitrary scale a tile
  // edge falls mid-pixel, that copy's edge is antialiased against empty canvas,
  // and the partly transparent result shows the page through as a grid of seams
  // — which is then plainly visible zoomed out. Snapping the scale so tile
  // boundaries are integers makes the copies abut exactly.
  const wanted = Math.min(1, OVERVIEW_MAX / Math.max(world.width, world.height));
  const tileDest = Math.max(1, Math.round(TILE * wanted));
  const scale = tileDest / TILE;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(world.width * scale));
  canvas.height = Math.max(1, Math.round(world.height * scale));
  overview = { canvas, ctx: canvas.getContext('2d'), scale };
}

/** Every tile overlapping the half-open map rect [x0,x1) by [y0,y1). */
function tilesOver(x0, y0, x1, y1) {
  const out = [];
  const c0 = Math.max(0, Math.floor(x0 / TILE));
  const c1 = Math.min(tiles.cols - 1, Math.floor((x1 - 1) / TILE));
  const r0 = Math.max(0, Math.floor(y0 / TILE));
  const r1 = Math.min(tiles.rows - 1, Math.floor((y1 - 1) / TILE));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push(tiles.list[r * tiles.cols + c]);
  }
  return out;
}

/**
 * Works out all three shades of every province before any pixel is touched.
 *
 * Returns flat [r,g,b]-per-index arrays. The pixel loops then only index into
 * them: deciding a colour inside those loops would mean a Map lookup and a fresh
 * array for every pixel on the map. This is O(provinces), a few hundred, so it
 * is cheap enough to redo on every repaint however small the repaint is.
 */
function shadeTable(world, mode, selected, hovered) {
  const { atIndex } = world;
  const n = atIndex.length;
  const fill = new Uint8Array(n * 3);   // province interior
  const soft = new Uint8Array(n * 3);   // its edge against the same owner
  const hard = new Uint8Array(n * 3);   // its edge against another owner, or the sea
  const neighbours = selected ? world.adjacency.get(selected) : null;
  const colourOf = MODES[mode];

  // Owners as small integers, so the pixel loop can ask "same owner?" with a
  // number comparison rather than a string one. Ocean stays -1, which never
  // matches any province, so every coastline automatically counts as a hard edge.
  const ownerAt = new Int32Array(n).fill(-1);
  const ownerOrdinal = new Map();

  for (let ix = 1; ix < n; ix++) {
    const p = atIndex[ix];
    if (!ownerOrdinal.has(p.owner)) ownerOrdinal.set(p.owner, ownerOrdinal.size);
    ownerAt[ix] = ownerOrdinal.get(p.owner);

    // Highlight, if this province is in one of the three states. The selected
    // province lightens most and also gets the ring drawn in §5; its neighbours
    // lighten less, which is what shows you where you could move.
    const mix = selected === p.id ? LIGHTEN.selected
      : neighbours?.has(p.id) ? LIGHTEN.neighbour
        : hovered === p.id ? LIGHTEN.hovered : 0;
    const c = colourOf(world, p);
    for (let ch = 0; ch < 3; ch++) {
      const v = c[ch] + (255 - c[ch]) * mix;
      fill[ix * 3 + ch] = v;
      soft[ix * 3 + ch] = v * BORDER_INTERNAL;
      hard[ix * 3 + ch] = v * BORDER_NATIONAL;
    }
  }

  // Whether the imagery is showing decides the layer's alphas. With it off
  // everything is opaque and the result is byte-for-byte what it always was.
  const over = !!(world.satellite && state.satellite);
  return {
    fill, soft, hard, ownerAt, over,
    aFill: over ? Math.round(255 * SATELLITE_FILL) : 255,
    aEdge: over ? Math.round(255 * SATELLITE_EDGE) : 255,
    aSea: over ? 0 : 255,          // let the imagery's own sea show through
  };
}

/**
 * Paints part of one tile and uploads just that part.
 *
 * Bounds are tile-local and half-open: [lx0,lx1) by [ly0,ly1). Pixels go into
 * the shared `scratch`, whose row stride is always TILE regardless of how short
 * an edge tile is, and only the painted rectangle is handed to putImageData.
 */
function paintTileRegion(world, t, tile, lx0, ly0, lx1, ly1) {
  const { width, height, provinceAt } = world;
  const { fill, soft, hard, ownerAt, over, aFill, aEdge, aSea } = t;
  const d = scratch.data;
  const [or_, og, ob] = world.table.oceanColour;   // trailing _ only to avoid shadowing `or`

  for (let ly = ly0; ly < ly1; ly++) {
    const y = tile.y + ly;
    let i = y * width + tile.x + lx0;              // index into the map
    let o = (ly * TILE + lx0) * 4;                 // index into the scratch
    for (let lx = lx0; lx < lx1; lx++, i++, o += 4) {
      const index = provinceAt[i];
      if (index === OCEAN) {
        d[o] = or_; d[o + 1] = og; d[o + 2] = ob;
        d[o + 3] = aSea;
        continue;
      }

      // Borders are not stored anywhere — they are found here, per pixel. If the
      // pixel to the right or below belongs to someone else, this one is on an
      // edge and draws darker. That single rule produces every internal border,
      // every national border and the entire coastline.
      //
      // These reads cross tile boundaries freely, because they index the map,
      // not the tile — so a border on a chunk edge is drawn from the same data
      // as one in the middle, and no seam appears.
      //
      // Because only right and below are checked, the dark line falls on one side
      // of each boundary rather than being shared, and is always exactly one map
      // pixel wide — so it thins out visually as you zoom in.
      const x = tile.x + lx;
      const right = x + 1 < width ? provinceAt[i + 1] : index;
      const below = y + 1 < height ? provinceAt[i + width] : index;
      const mine = ownerAt[index];
      let edge = 0;                                // 0 interior, 1 internal edge, 2 national edge
      if (right !== index) edge = ownerAt[right] === mine ? 1 : 2;
      if (below !== index && edge < 2) edge = Math.max(edge, ownerAt[below] === mine ? 1 : 2);

      const src = edge === 2 ? hard : edge === 1 ? soft : fill;
      const c = index * 3;
      d[o] = src[c]; d[o + 1] = src[c + 1]; d[o + 2] = src[c + 2];
      d[o + 3] = edge ? aEdge : aFill;
    }
  }

  const w = lx1 - lx0, h = ly1 - ly0;
  if (!over) {
    // No imagery: the layer is opaque, so it can go straight to the tile.
    tile.ctx.putImageData(scratch, 0, 0, lx0, ly0, w, h);
    return;
  }

  // Imagery underneath, province layer over it. putImageData cannot composite —
  // it replaces pixels outright, alpha included — so the layer goes to a scratch
  // canvas first and is then drawn, which does blend.
  tile.ctx.clearRect(lx0, ly0, w, h);
  tile.ctx.drawImage(world.satellite, tile.x + lx0, tile.y + ly0, w, h, lx0, ly0, w, h);
  scratchCtx.putImageData(scratch, 0, 0, lx0, ly0, w, h);
  tile.ctx.drawImage(scratchCanvas, lx0, ly0, w, h, lx0, ly0, w, h);
}

/** Copies a map rectangle from the tiles down into the overview. */
function refreshOverview(world, x0, y0, x1, y1) {
  const { scale, ctx } = overview;
  ctx.imageSmoothingEnabled = true;

  // Widen by a couple of map pixels. The copy lands on fractional overview
  // coordinates and is antialiased at its edges, so overlapping the neighbouring
  // region slightly keeps those edges from accumulating into visible seams.
  const pad = Math.ceil(2 / scale);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(world.width, x1 + pad); y1 = Math.min(world.height, y1 + pad);

  for (const tile of tilesOver(x0, y0, x1, y1)) {
    const ax0 = Math.max(x0, tile.x), ay0 = Math.max(y0, tile.y);
    const ax1 = Math.min(x1, tile.x + tile.w), ay1 = Math.min(y1, tile.y + tile.h);
    if (ax1 <= ax0 || ay1 <= ay0) continue;

    // Round the destination EDGES, not the width, so that two copies sharing a
    // boundary resolve it to the same integer and leave nothing between them.
    const dx0 = Math.round(ax0 * scale), dx1 = Math.round(ax1 * scale);
    const dy0 = Math.round(ay0 * scale), dy1 = Math.round(ay1 * scale);
    if (dx1 <= dx0 || dy1 <= dy0) continue;      // region too small to survive the downscale

    ctx.drawImage(
      tile.canvas,
      ax0 - tile.x, ay0 - tile.y, ax1 - ax0, ay1 - ay0,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
  }
}

/**
 * Repaints every tile. Only needed on load and on a change of map mode, since
 * those are the only things that alter every province at once.
 */
function renderBuffer(world, mode, selected, hovered) {
  if (!tiles) buildTiles(world);
  const t = shadeTable(world, mode, selected, hovered);
  for (const tile of tiles.list) paintTileRegion(world, t, tile, 0, 0, tile.w, tile.h);

  // Lay down ocean before assembling the overview. The copies below should cover
  // it completely, but if a sub-pixel sliver ever escapes them it now shows sea
  // rather than the page behind the canvas.
  overview.ctx.fillStyle = `rgb(${world.table.oceanColour})`;
  overview.ctx.fillRect(0, 0, overview.canvas.width, overview.canvas.height);

  refreshOverview(world, 0, 0, world.width, world.height);
}

/**
 * Repaints only the provinces whose colour has changed, by bounding box.
 *
 * This is what makes a large map usable. Hovering alters exactly two provinces
 * and selecting alters a province plus its neighbours, but a full repaint costs
 * width*height regardless — on a 6000x2650 map, 15.9 million pixels for a change
 * affecting a hundredth of a percent of them.
 *
 * A province's own pixels are the only ones that change: the border test reads a
 * neighbour's OWNER, which a highlight never touches, so nothing outside the box
 * can be affected. Other provinces caught inside the same box are simply
 * recomputed to the values they already had.
 */
function repaintProvinces(world, mode, selected, hovered, ids) {
  if (!tiles) return renderBuffer(world, mode, selected, hovered);

  const t = shadeTable(world, mode, selected, hovered);
  for (const id of ids) {
    const bb = world.bounds.get(id);
    if (!bb) continue;                 // province with no pixels; nothing to repaint

    // One box at a time rather than one box around them all: two provinces on
    // opposite sides of the map would otherwise union into the whole thing.
    const x0 = bb.minX, y0 = bb.minY, x1 = bb.maxX + 1, y1 = bb.maxY + 1;
    for (const tile of tilesOver(x0, y0, x1, y1)) {
      const lx0 = Math.max(0, x0 - tile.x), ly0 = Math.max(0, y0 - tile.y);
      const lx1 = Math.min(tile.w, x1 - tile.x), ly1 = Math.min(tile.h, y1 - tile.y);
      if (lx1 > lx0 && ly1 > ly0) paintTileRegion(world, t, tile, lx0, ly0, lx1, ly1);
    }
    refreshOverview(world, x0, y0, x1, y1);
  }
}

// =================================================================== 4. labels

//
// Every contiguous run of same-owner provinces is a "block", and each block gets
// one label. Placing it takes four steps:
//
//   1. AXIS    PCA over the block's pixels gives the direction the land runs in.
//   2. SPINE   a quadratic fitted to the spread across that axis gives a gentle
//              curve following the land, which the text is drawn along.
//   3. SPAN    denseRange() finds the stretch of the axis that is solid ground,
//              which is what the name should cover.
//   4. TYPE    fitLabel() picks the font size, and the number of lines, that
//              fills that span without spilling over the border.
//
// Steps 1-3 happen once, at load. Only step 4's result is used per frame.
// Every size here is in MAP pixels; drawLabels() converts to screen pixels by
// multiplying by view.scale at the last moment.

// --- appearance
const LABEL_MIN_PX = 9;          // on-screen size below which a label is skipped as unreadable
const LABEL_MAX_PX = 40;         // and above which it stops growing
const LABEL_TRACKING = 0.16;     // letter spacing, as a fraction of the font size
const LABEL_LINE_HEIGHT = 1.1;   // distance between stacked lines, as a multiple of the font size
const LABEL_ALPHA = { far: 0.85, near: 0.5 };    // opacity when zoomed out / fully zoomed in
const MAX_BEND = 0.28;           // ceiling on spine curvature, so text cannot fold back on itself

// --- choosing the font size and the number of lines
const LABEL_FIT = { along: 0.86, across: 0.9 };  // fraction of the block's span/thickness the text may fill
const LABEL_MAX_LINES = 3;       // hard ceiling on stacked lines
const LABEL_WRAP_ASPECT = 2.3;   // length-to-width above which a block never stacks: a long thin
                                 // territory reads better with its name spread along it
const LABEL_WRAP_GAIN = 1.15;    // and an extra line must grow the type by this factor to be worth taking

// --- choosing which stretch of the block the name covers
const LABEL_HIST_BUCKET = 3;     // map pixels per slice, when measuring the block's width along its axis
const LABEL_DENSITY_FLOOR = 0.4; // a slice counts as solid ground at this fraction of the block's mean width
const LABEL_MIN_DENSITY = 0.3;   // a whole block sparser than this is an archipelago, and gets no label

const labelFont = (px) => `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;

/**
 * Width of one line of label text, expressed in multiples of its font size —
 * so a return of 12 means the line is 12x as wide as it is tall.
 *
 * This measures the real font instead of estimating from an average glyph
 * width. A name in wide capitals (M, N, R, Z) runs far past what an average
 * predicts, and the text would then be laid out longer than the land it was
 * sized to fit, spilling over the border.
 *
 * The size measured at does not matter, as the result is a ratio; 100 just
 * keeps the rounding error small.
 */
const MEASURE_SIZE = 100;
let measureCtx = null;             // one reusable context; measuring needs no visible canvas
function widthRatio(text) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = labelFont(MEASURE_SIZE);
  const chars = [...text];
  const w = chars.reduce((s, c) => s + measureCtx.measureText(c).width, 0)
    + MEASURE_SIZE * LABEL_TRACKING * (chars.length - 1);
  return w / MEASURE_SIZE;
}

/**
 * Splits a name into exactly `n` lines, breaking only between words.
 *
 * Tries every possible set of break points and keeps whichever makes the WIDEST
 * line as narrow as possible, since that widest line is what limits the font
 * size. Returns { lines, worst }, or null if there are too few words.
 */
function wrapInto(words, n) {
  if (words.length < n) return null;
  let best = null;
  const search = (start, left, acc) => {
    if (left === 1) {
      const lines = [...acc, words.slice(start).join(' ')];
      const worst = Math.max(...lines.map(widthRatio));
      if (!best || worst < best.worst) best = { lines, worst };
      return;
    }
    for (let end = start + 1; end <= words.length - left + 1; end++) {
      search(end, left - 1, [...acc, words.slice(start, end).join(' ')]);
    }
  };
  search(0, n, []);
  return best;
}

/**
 * Picks the font size and line count for one label: STEP 4 above.
 *
 * Tries 1, 2 ... `maxLines` lines and keeps the best. For each count, the size
 * that fits is limited by two things at once — the text must be no longer than
 * the block's span, and the stack of lines no taller than its thickness — so the
 * size is the smaller of those two limits.
 *
 * A round block has thickness to spare and little span, so splitting a two-word
 * name buys far more size than shrinking it onto one line. Callers control that
 * through `maxLines`: see LABEL_WRAP_ASPECT for why long thin blocks are given 1.
 *
 * Returns { lines, size }.
 */
function fitLabel(text, span, thickness, maxLines) {
  const words = text.split(/\s+/);
  let best = null;
  for (let n = 1; n <= Math.min(maxLines, words.length); n++) {
    const wrapped = n === 1 ? { lines: [text], worst: widthRatio(text) } : wrapInto(words, n);
    if (!wrapped) continue;
    const size = Math.min(
      span * LABEL_FIT.along / wrapped.worst,             // limited by the block's length
      thickness * LABEL_FIT.across / (n * LABEL_LINE_HEIGHT)   // limited by its width
    );
    // Each extra line has to earn its place. Splitting a line roughly halves its
    // length and so nearly doubles the size that fits, meaning size alone would
    // keep wrapping forever; requiring a real gain stops a name splitting again
    // for one or two percent and stranding a word like "OF" on a line by itself.
    if (!best || size > best.size * LABEL_WRAP_GAIN) best = { lines: wrapped.lines, size };
  }
  return best;
}

/**
 * Finds the stretch of the axis that is solid territory: STEP 3 above.
 *
 * `f.hist` holds the block's pixel count per slice along the axis, which is its
 * width profile. This starts at the slice containing the median pixel — the
 * middle of the land by weight, rather than the midpoint of the extent — then
 * walks outwards in each direction, stopping when the block narrows below
 * `floor` of its own mean width.
 *
 * The two sides stop independently, and that is the point. A country cut off
 * flat by a neighbour's border is solid right up to that edge, so that side runs
 * all the way out; a coast fraying into capes stops where the land thins. If
 * instead an equal share were trimmed off both ends, one ragged coast would
 * shorten the name across the entire country.
 *
 * Returns [tLo, tHi] in axis coordinates.
 */
function denseRange(f, floor) {
  const keys = [...f.hist.keys()].sort((a, b) => a - b);
  if (!keys.length) return null;

  // Copy into a plain array indexed by slice, so that a gap of open sea shows up
  // as the zero width it is rather than being skipped over.
  const first = keys[0], last = keys[keys.length - 1];
  const w = new Array(last - first + 1).fill(0);
  for (const [k, v] of f.hist) w[k - first] = v;

  // Read the profile smoothed over three slices, so that a single ragged notch
  // of coastline cannot halt the walk on its own.
  const at = (i) => w[clamp(i, 0, w.length - 1)];
  const smooth = (i) => (at(i - 1) + at(i) + at(i + 1)) / 3;

  const total = w.reduce((s, v) => s + v, 0);
  const threshold = (total / w.length) * floor;      // mean width, scaled down

  let cum = 0, seed = 0;                             // slice holding the median pixel
  for (let i = 0; i < w.length; i++) { cum += w[i]; if (cum >= total / 2) { seed = i; break; } }

  let lo = seed, hi = seed;
  while (lo > 0 && smooth(lo - 1) >= threshold) lo--;
  while (hi < w.length - 1 && smooth(hi + 1) >= threshold) hi++;

  // Slice boundaries round outwards, which on a block only a few pixels long
  // would return a range wider than the block itself. Clamp to what exists.
  return [
    Math.max((first + lo) * LABEL_HIST_BUCKET, f.tMin),
    Math.min((first + hi + 1) * LABEL_HIST_BUCKET, f.tMax),
  ];
}

/**
 * Builds every label once, at load. See the four steps at the top of section 4.
 *
 * One label per contiguous block, so a polity split across an enclave or an
 * island group gets its name written on each piece separately.
 */
function computeLabels(world) {
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
  if (!blocks.length) return [];

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

  const labels = [];
  blocks.forEach((blk, b) => {
    const g = geo[b], f = fit[b];
    if (!g || !f) return;

    const text = world.table.polityById.get(blk.owner).name.toUpperCase();
    const extent = f.tMax - f.tMin;
    const thickness = 2 * Math.sqrt(f.pp / f.n);          // ~2 sigma across
    if (extent <= 0 || thickness <= 0) return;

    // Skip archipelagos. Scattered islands cover a huge extent with very little
    // land, so the spine runs mostly over open sea and the name ends up floating
    // on water. Land per unit of extent tells them apart from real territory.
    if (g.n / (extent * thickness) < LABEL_MIN_DENSITY) return;

    // STEP 3: the stretch of solid ground the name will cover.
    const range = denseRange(f, LABEL_DENSITY_FLOOR);
    if (!range) return;
    const [tLo, tHi] = range;
    const span = tHi - tLo;
    if (span <= 0) return;

    // STEP 2: solve the 3x3 normal equations for u = a*t^2 + b*t + c by Cramer's
    // rule. That quadratic is the spine; MAX_BEND keeps it from curling up.
    const [a2, a1, a0] = solveQuadratic(f) || [0, 0, 0];
    const half = span / 2;
    const bend = clamp(a2, -MAX_BEND / Math.max(half, 1), MAX_BEND / Math.max(half, 1));

    // STEP 4. Note which measurement each argument gets: whether stacking is
    // allowed is judged on `extent`, the block's real shape, while the type is
    // sized to `span`, the solid part. Judging on `span` would misread a long
    // thin country as round once denseRange had cut its capes off.
    const maxLines = extent / thickness < LABEL_WRAP_ASPECT ? LABEL_MAX_LINES : 1;
    const laid = fitLabel(text, span, thickness, maxLines);
    if (!laid) return;

    // Deliberately no minimum size. A small block just gets small type and stays
    // hidden until LABEL_MIN_PX lets it through, which happens as you zoom in.
    // Dropping it here instead would mean it never gets a name at any zoom.

    labels.push({
      lines: laid.lines, size: clamp(laid.size, 0.05, 400),
      tMid: (tLo + tHi) / 2,
      cx: g.cx, cy: g.cy, ux: g.ux, uy: g.uy,
      a2: bend, a1, a0,
    });
  });
  return labels;
}

/**
 * Least-squares fit of u = a*t^2 + b*t + c to the block's pixels, by Cramer's
 * rule on the 3x3 normal equations. Returns [a, b, c], or null if the matrix is
 * singular — which happens when a block is too small or too straight to fit a
 * curve to, and callers then fall back to a flat spine.
 */
function solveQuadratic(f) {
  const m = [
    [f.s4, f.s3, f.s2],
    [f.s3, f.s2, f.s1],
    [f.s2, f.s1, f.s0],
  ];
  const v = [f.u2, f.u1, f.u0];
  const det = (n) =>
    n[0][0] * (n[1][1] * n[2][2] - n[1][2] * n[2][1]) -
    n[0][1] * (n[1][0] * n[2][2] - n[1][2] * n[2][0]) +
    n[0][2] * (n[1][0] * n[2][1] - n[1][1] * n[2][0]);
  const d = det(m);
  if (!isFinite(d) || Math.abs(d) < 1e-6) return null;
  const col = (i) => m.map((row, r) => row.map((val, c) => (c === i ? v[r] : val)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

/**
 * Converts a position on the spine into map coordinates.
 *
 * `t` is distance along the spine from the label's centre, `u` distance across
 * it — `u` is how stacked lines are pushed apart. Returns the map point plus the
 * tangent angle there, which is the rotation a glyph at that spot needs to sit
 * square on the curve.
 */
function spinePoint(L, t, u = 0) {
  const tt = L.tMid + t;
  const off = L.a2 * tt * tt + L.a1 * tt + L.a0 + u;
  const slope = 2 * L.a2 * tt + L.a1;
  return {
    x: L.cx + L.ux * tt - L.uy * off,
    y: L.cy + L.uy * tt + L.ux * off,
    angle: Math.atan2(L.uy + L.ux * slope, L.ux - L.uy * slope),
  };
}

/**
 * Draws every label, one glyph at a time so the text can follow the curve.
 *
 * Canvas has no curved-text primitive, so each character is positioned and
 * rotated on its own: walk along the line accumulating measured widths, ask
 * spinePoint() where that offset lands, then translate and rotate to draw there.
 * Each glyph is stroked before it is filled, giving the dark outline that keeps
 * white text readable over any province colour.
 */
function drawLabels(ctx, labels) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  for (const L of labels) {
    // L.size is in map pixels, so it has to be scaled to find the size on screen.
    // A tiny country therefore has a real label all along; it simply stays below
    // the legibility floor until you zoom in far enough.
    const size = L.size * view.scale;
    if (size < LABEL_MIN_PX) continue;
    const px = Math.min(size, LABEL_MAX_PX);

    ctx.font = labelFont(px);
    const gap = px * LABEL_TRACKING;

    // Fade out as the view zooms in. Labels are there to orient you across the
    // whole map; up close the provinces themselves are what you are looking at.
    const zoom = (view.scale - MIN_SCALE) / (MAX_SCALE - MIN_SCALE);
    const alpha = LABEL_ALPHA.far + (LABEL_ALPHA.near - LABEL_ALPHA.far) * clamp(zoom, 0, 1);

    ctx.lineWidth = px * 0.15;
    ctx.strokeStyle = `rgba(10,12,16,${(alpha * 0.76).toFixed(3)})`;
    ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;

    const n = L.lines.length;
    for (let li = 0; li < n; li++) {
      // Offset each line across the spine, centred on it: with 2 lines that is
      // -0.5 and +0.5 line heights, with 3 it is -1, 0, +1. So the label as a
      // whole stays centred on the block however many lines it has. Divided by
      // view.scale because spinePoint() works in map pixels, not screen pixels.
      const across = (li - (n - 1) / 2) * LABEL_LINE_HEIGHT * px / view.scale;
      const chars = [...L.lines[li]];
      const widths = chars.map((c) => ctx.measureText(c).width);
      const total = widths.reduce((s, w) => s + w, 0) + gap * (chars.length - 1);

      let cursor = -total / 2;
      for (let i = 0; i < chars.length; i++) {
        const centre = cursor + widths[i] / 2;
        const { x, y, angle } = spinePoint(L, centre / view.scale, across);
        ctx.save();
        ctx.translate(x * view.scale + view.x, y * view.scale + view.y);
        ctx.rotate(angle);
        ctx.strokeText(chars[i], 0, 0);
        ctx.fillText(chars[i], 0, 0);
        ctx.restore();
        cursor += widths[i] + gap;
      }
    }
  }
  ctx.restore();
}

/**
 * White silhouette of one province at map resolution, cropped to its bounds.
 *
 * This is the expensive half — a per-pixel pass — so it is built once per
 * selection and reused at every zoom level.
 */
function buildSilhouette(world, id) {
  const bb = world.bounds.get(id);
  if (!bb) return null;

  const w = bb.maxX - bb.minX + 1;
  const h = bb.maxY - bb.minY + 1;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const index = world.byId.get(id).index;
  for (let y = 0; y < h; y++) {
    const row = (bb.minY + y) * world.width + bb.minX;
    for (let x = 0; x < w; x++) {
      if (world.provinceAt[row + x] !== index) continue;
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, x: bb.minX, y: bb.minY, w, h };
}

/**
 * A yellow-orange ring straddling the province border, OUTLINE_WIDTH thick on
 * screen whatever the zoom.
 *
 * The band is the difference of two shifted-stamp passes: a union of copies
 * offset in a circle, which grows the shape outwards by half the width, minus an
 * intersection of the same copies, which shrinks it inwards by the same amount.
 * Subtracting the second from the first leaves a band centred on the true edge,
 * so the ring lands on the border rather than beside it. A source-in fill then
 * tints the band without disturbing its shape.
 *
 * Smoothing follows the map's own rule, so a zoomed-in ring is as crisply
 * stair-stepped as the province pixels it traces instead of blurring off them.
 *
 * Holding the ring to a fixed screen thickness means rebuilding whenever the
 * zoom changes: it is rasterised at the current scale, and the width is a
 * constant in that space. A big province at deep zoom would need an enormous
 * canvas, so resolution is capped and the width shrinks to match.
 */
function buildOutline(silhouette, viewScale) {
  const half = OUTLINE_WIDTH / 2;
  const pad = Math.ceil(half) + 2;
  let scale = viewScale;
  let w = Math.ceil(silhouette.w * scale) + pad * 2;
  let h = Math.ceil(silhouette.h * scale) + pad * 2;

  if (w * h > OUTLINE_MAX_PIXELS) {
    scale *= Math.sqrt(OUTLINE_MAX_PIXELS / (w * h));
    w = Math.ceil(silhouette.w * scale) + pad * 2;
    h = Math.ceil(silhouette.h * scale) + pad * 2;
  }

  const dw = silhouette.w * scale;
  const dh = silhouette.h * scale;
  const r = half * scale / viewScale;            // ring half-width, in canvas pixels
  const STEPS = 16;                              // enough that the band has no scallops
  const offsets = [];
  for (let i = 0; i < STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2;
    offsets.push([Math.cos(a) * r, Math.sin(a) * r]);
  }

  const layer = () => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.imageSmoothingEnabled = viewScale < 1;     // same rule the map is drawn by
    x.drawImage(silhouette.canvas, pad, pad, dw, dh);
    return [c, x];
  };

  const [outer, octx] = layer();                 // union: the shape grown outwards
  for (const [dx, dy] of offsets) octx.drawImage(silhouette.canvas, pad + dx, pad + dy, dw, dh);

  const [inner, ictx] = layer();                 // intersection: the shape shrunk inwards
  ictx.globalCompositeOperation = 'destination-in';
  for (const [dx, dy] of offsets) ictx.drawImage(silhouette.canvas, pad + dx, pad + dy, dw, dh);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(outer, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(inner, 0, 0);                    // hollow it out, leaving the band
  ctx.globalCompositeOperation = 'source-in';    // tint, preserving the edge
  ctx.fillStyle = OUTLINE_COLOUR;
  ctx.fillRect(0, 0, w, h);

  // Report the ring in map coordinates, so drawing it needs no special case.
  return {
    canvas,
    x: silhouette.x - pad / scale,
    y: silhouette.y - pad / scale,
    w: w / scale,
    h: h / scale,
    builtFor: viewScale,
  };
}

// ===================================================================== 5. view
//
// The pan/zoom transform, and putting the finished buffer on screen.
//
//   map -> screen:  sx = mx * scale + view.x
//   screen -> map:  mx = (sx - view.x) / scale
//
// `view` is the only state involved, and changing it needs no repaint of the
// buffer — just another blit.

const MIN_SCALE = 0.25;         // zoomed out: whole world, small
const MAX_SCALE = 16;           // zoomed in: individual map pixels visible
const view = { scale: 1, x: 0, y: 0 };   // x,y are the screen position of map pixel (0,0)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const screenToMap = (sx, sy) => ({ x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale });

/**
 * Zooms by `factor` about the point (sx,sy) on screen.
 *
 * The map point under the cursor is found first, then the offset is recomputed
 * so that same point lands back under the cursor afterwards. That is what makes
 * wheel-zoom feel anchored rather than drifting toward the middle.
 */
function zoomAt(sx, sy, factor) {
  const before = screenToMap(sx, sy);
  view.scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  view.x = sx - before.x * view.scale;
  view.y = sy - before.y * view.scale;
  clampPan();
  invalidateView();
}

const zoomCentre = (factor) => zoomAt(els.canvas.clientWidth / 2, els.canvas.clientHeight / 2, factor);

/**
 * Keeps the map from being dragged completely out of sight. At least a quarter
 * of the viewport must still hold map, in both directions.
 */
function clampPan() {
  const w = state.world;
  if (!w) return;
  const vw = els.canvas.clientWidth;
  const vh = els.canvas.clientHeight;
  view.x = clamp(view.x, -w.width * view.scale + vw * 0.25, vw * 0.75);
  view.y = clamp(view.y, -w.height * view.scale + vh * 0.25, vh * 0.75);
}

/** Scales and centres so the whole map is visible, with a 4% margin. */
function fitToView() {
  const w = state.world;
  if (!w) return;
  const vw = els.canvas.clientWidth;
  const vh = els.canvas.clientHeight;
  view.scale = clamp(Math.min(vw / w.width, vh / w.height) * 0.96, MIN_SCALE, MAX_SCALE);
  view.x = (vw - w.width * view.scale) / 2;
  view.y = (vh - w.height * view.scale) / 2;
  invalidateView();
}

/**
 * Draws one frame: the map buffer, then the selection ring, then the labels.
 *
 * This is the cheap half of drawing — three composited layers, no per-pixel work
 * — which is why panning and zooming can run at frame rate.
 */
function drawView() {
  const canvas = els.canvas;

  // Match the canvas's pixel buffer to the physical display. Without this the
  // map is resampled by the browser and looks soft on a high-DPI screen. The
  // transform then lets everything below be written in CSS pixels regardless.
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
  if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0c1015';        // matches --steel-deepest in index.html
  ctx.fillRect(0, 0, cssW, cssH);

  // Smooth only when shrinking the map. Zoomed in, nearest-neighbour keeps the
  // province edges as the hard pixel steps they are instead of blurring them.
  ctx.imageSmoothingEnabled = view.scale < 1;

  // Which part of the map is on screen. Taken outwards to whole map pixels, so
  // nothing shears along the edges.
  const s = view.scale;
  const w = state.world;
  const sx0 = clamp(Math.floor(-view.x / s), 0, w.width);
  const sy0 = clamp(Math.floor(-view.y / s), 0, w.height);
  const sx1 = clamp(Math.ceil((cssW - view.x) / s), 0, w.width);
  const sy1 = clamp(Math.ceil((cssH - view.y) / s), 0, w.height);

  if (sx1 > sx0 && sy1 > sy0) {
    if (s <= overview.scale) {
      // Zoomed out far enough that the overview holds at least as many pixels as
      // the screen can show, so drawing from it loses nothing and rescales about
      // a tenth as much data. This is the common case, and the whole reason the
      // overview exists: at fit zoom the entire map is visible, and going tile by
      // tile would mean rescaling all 15.9 million pixels on every frame.
      const o = overview.scale;
      ctx.drawImage(
        overview.canvas,
        sx0 * o, sy0 * o, (sx1 - sx0) * o, (sy1 - sy0) * o,
        view.x + sx0 * s, view.y + sy0 * s, (sx1 - sx0) * s, (sy1 - sy0) * s
      );
    } else {
      // Zoomed in: full resolution, but only the chunks actually on screen. Every
      // tile beyond the window is skipped outright.
      debug.tilesDrawn = 0;
      for (const tile of tilesOver(sx0, sy0, sx1, sy1)) {
        const ax0 = Math.max(sx0, tile.x), ay0 = Math.max(sy0, tile.y);
        const ax1 = Math.min(sx1, tile.x + tile.w), ay1 = Math.min(sy1, tile.y + tile.h);
        if (ax1 <= ax0 || ay1 <= ay0) continue;

        // Destination edges are rounded rather than the width being rounded, so
        // neighbouring tiles agree on where their shared edge lands and cannot
        // leave a gap between them.
        const dx0 = Math.round(view.x + ax0 * s), dx1 = Math.round(view.x + ax1 * s);
        const dy0 = Math.round(view.y + ay0 * s), dy1 = Math.round(view.y + ay1 * s);
        ctx.drawImage(
          tile.canvas,
          ax0 - tile.x, ay0 - tile.y, ax1 - ax0, ay1 - ay0,
          dx0, dy0, dx1 - dx0, dy1 - dy0
        );
        debug.tilesDrawn++;
      }
    }
  }

  if (state.silhouette) {
    // The ring holds a constant thickness on screen, so it has to be redrawn at
    // the new scale whenever the zoom changes. Panning leaves it alone.
    if (state.outline?.builtFor !== view.scale) state.outline = buildOutline(state.silhouette, view.scale);
    const o = state.outline;
    ctx.drawImage(o.canvas, o.x * view.scale + view.x, o.y * view.scale + view.y, o.w * view.scale, o.h * view.scale);
  }

  if (state.showLabels && state.world.labels) drawLabels(ctx, state.world.labels);
  drawOverlays(ctx, cssW, cssH);
}

// ========================================================== 6. debug overlays
//
// Everything the debug menu can switch on. All of it draws in screen space over
// the finished map, none of it touches the buffer, and none of it costs anything
// while switched off. Panning and zooming already redraw, so a toggle only has
// to invalidate the view.

const NAME_MIN_PX = 30;        // province must be at least this wide on screen to be named
const OVERLAY_FONT = '500 11px system-ui, -apple-system, "Segoe UI", sans-serif';

// Filled in as the overlays draw, and read back by the Performance readout.
const debug = { names: 0, tilesDrawn: 0, path: '—' };

function drawOverlays(ctx, cssW, cssH) {
  if (state.showCoastal) drawCoastalFlags(ctx, cssW, cssH);
  if (state.showProvinceNames) drawProvinceNames(ctx, cssW, cssH);
  if (state.showAdjacency) drawAdjacency(ctx);
  if (state.showBounds) drawSelectionBounds(ctx);
  if (state.showChunks) drawChunkGrid(ctx, cssW, cssH);
}

/** Sets up the stroke-then-fill style shared by the text overlays. */
function overlayText(ctx, weight = .95) {
  ctx.font = OVERLAY_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(6,8,12,.85)';
  ctx.fillStyle = `rgba(232,238,246,${weight})`;
}

/**
 * Every province's name at its centroid.
 *
 * Skipped for anything too small to read at the current zoom, which is what
 * keeps this usable — naming all 289 at once would be illegible and slow. The
 * count that survives is reported in the readout so the cutoff can be judged.
 */
function drawProvinceNames(ctx, cssW, cssH) {
  const w = state.world, s = view.scale;
  ctx.save();
  overlayText(ctx);
  let drawn = 0;
  for (const [id, bb] of w.bounds) {
    if ((bb.maxX - bb.minX + 1) * s < NAME_MIN_PX) continue;      // too small to read
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x < -120 || y < -20 || x > cssW + 120 || y > cssH + 20) continue;   // off screen
    const name = w.byId.get(id).name;
    ctx.strokeText(name, x, y);
    ctx.fillText(name, x, y);
    drawn++;
  }
  ctx.restore();
  debug.names = drawn;
}

/**
 * The tile grid, with each chunk's column,row and whether it is being drawn.
 *
 * Chunks actually blitted this frame are outlined brightly, the rest faintly —
 * so the culling in drawView() can be watched working. Zoomed out no chunk is
 * lit at all, because the overview is being used instead.
 */
function drawChunkGrid(ctx, cssW, cssH) {
  if (!tiles) return;
  const s = view.scale;
  const usingTiles = s > overview.scale;

  // Which chunks drawView() would have used, by the same visible-rect test.
  const inUse = new Set();
  if (usingTiles) {
    const sx0 = clamp(Math.floor(-view.x / s), 0, state.world.width);
    const sy0 = clamp(Math.floor(-view.y / s), 0, state.world.height);
    const sx1 = clamp(Math.ceil((cssW - view.x) / s), 0, state.world.width);
    const sy1 = clamp(Math.ceil((cssH - view.y) / s), 0, state.world.height);
    if (sx1 > sx0 && sy1 > sy0) for (const t of tilesOver(sx0, sy0, sx1, sy1)) inUse.add(t);
  }

  ctx.save();
  ctx.font = OVERLAY_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 1;

  for (const tile of tiles.list) {
    const x = Math.round(tile.x * s + view.x), y = Math.round(tile.y * s + view.y);
    const x1 = Math.round((tile.x + tile.w) * s + view.x), y1 = Math.round((tile.y + tile.h) * s + view.y);
    if (x1 < 0 || y1 < 0 || x > cssW || y > cssH) continue;

    const live = inUse.has(tile);
    ctx.strokeStyle = live ? 'rgba(168,189,212,.9)' : 'rgba(127,151,178,.28)';
    ctx.strokeRect(x + .5, y + .5, x1 - x - 1, y1 - y - 1);

    if (x1 - x > 74 && y1 - y > 26) {
      const label = `${tile.x / TILE},${tile.y / TILE}`;
      ctx.fillStyle = live ? 'rgba(168,189,212,.95)' : 'rgba(127,151,178,.45)';
      ctx.fillText(label, x + 5, y + 4);
    }
  }
  ctx.restore();
}

/**
 * Lines from the selected province to each of its neighbours.
 *
 * The adjacency graph is derived from pixels rather than authored, so this is
 * the quickest way to see it is right — a missing line means two provinces that
 * look joined never actually touch, and a stray one means a leaked pixel.
 */
function drawAdjacency(ctx) {
  const w = state.world;
  if (!state.selected) return;
  const from = w.bounds.get(state.selected);
  if (!from) return;
  const s = view.scale;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(168,189,212,.75)';
  ctx.fillStyle = 'rgba(232,238,246,.9)';
  for (const id of w.adjacency.get(state.selected)) {
    const to = w.bounds.get(id);
    if (!to) continue;
    ctx.beginPath();
    ctx.moveTo(from.cx * s + view.x, from.cy * s + view.y);
    ctx.lineTo(to.cx * s + view.x, to.cy * s + view.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(to.cx * s + view.x, to.cy * s + view.y, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The selected province's bounding box and centroid.
 *
 * The box is what repaintProvinces() actually repaints, so a province whose box
 * covers far more than the province does is one that makes partial repaints
 * expensive — scattered islands sharing one id, usually.
 */
function drawSelectionBounds(ctx) {
  const w = state.world;
  if (!state.selected) return;
  const bb = w.bounds.get(state.selected);
  if (!bb) return;
  const s = view.scale;
  const x = bb.minX * s + view.x, y = bb.minY * s + view.y;
  const bw = (bb.maxX - bb.minX + 1) * s, bh = (bb.maxY - bb.minY + 1) * s;

  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(217,140,95,.9)';
  ctx.strokeRect(x + .5, y + .5, bw, bh);
  ctx.setLineDash([]);

  ctx.beginPath();                                  // centroid: where a label anchors
  ctx.arc(bb.cx * s + view.x, bb.cy * s + view.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(217,140,95,.95)';
  ctx.fill();
  ctx.restore();
}

/** A dot on every province the pixel scan found touching open sea. */
function drawCoastalFlags(ctx, cssW, cssH) {
  const w = state.world, s = view.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(120,200,225,.85)';
  for (const id of w.coastal) {
    const bb = w.bounds.get(id);
    if (!bb) continue;
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x < 0 || y < 0 || x > cssW || y > cssH) continue;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ====================================================================== 7. app

const els = {
  canvas: document.getElementById('map'),
  tooltip: document.getElementById('tooltip'),
  wrap: document.getElementById('canvas-wrap'),
  panel: document.getElementById('panel'),
  toggles: document.getElementById('toggles'),
  perf: document.getElementById('perf'),
  selName: document.getElementById('sel-name'),
  selBody: document.getElementById('sel-body'),
  neighbours: document.getElementById('neighbours'),
  stats: document.getElementById('stats'),
  toolbar: document.getElementById('toolbar'),
  zoomLevel: document.getElementById('zoom-level'),
};

const state = {
  mode: 'political',      // which of MODES colours the map
  selected: null,         // province id, or null
  hovered: null,          // province id, or null
  world: null,            // the model from buildWorld(), once loaded
  silhouette: null,       // selected province's shape; survives zooming
  outline: null,          // the ring built from it, rebuilt on every zoom change

  // Overlay switches. Each is driven by a button in the debug menu carrying a
  // matching data-toggle, so adding one is a line of HTML and a draw call.
  satellite: false,       // imagery under the province colours; set true if it loads
  showLabels: true,
  showProvinceNames: false,
  showChunks: false,
  showAdjacency: false,
  showBounds: false,
  showCoastal: false,
};


// Redrawing is driven by flags rather than by redrawing on every event, so a
// burst of mouse moves within one frame still costs a single repaint.
let bufferDirty = true;               // EVERY province changed: repaint the whole buffer
let viewDirty = true;                 // only the pan/zoom changed: re-blit alone will do
const dirtyProvinces = new Set();     // just these changed: repaint their boxes only

const invalidateBuffer = () => { bufferDirty = true; };
const invalidateView = () => { viewDirty = true; els.zoomLevel.textContent = `${Math.round(view.scale * 100)}%`; };

/**
 * Marks individual provinces as needing a repaint.
 *
 * Prefer this to invalidateBuffer() whenever the set of affected provinces is
 * known. On a large map the difference is a few thousand pixels against sixteen
 * million. Nulls are ignored, so "the province that was selected before" can be
 * passed without checking it first.
 */
function invalidateProvinces(...ids) {
  for (const id of ids) if (id) dirtyProvinces.add(id);
}

/* Timings and tallies for the debug menu's Performance block. Kept as running
 * averages because a single frame's number is too noisy to read. */
const perf = { fps: 0, draw: 0, paint: 0, fullRepaints: 0, partRepaints: 0, lastFrame: 0 };
const ease = (was, now) => (was ? was * 0.9 + now * 0.1 : now);

/** True when the canvas's CSS box no longer matches its pixel buffer. */
function canvasResized() {
  const dpr = window.devicePixelRatio || 1;
  return els.canvas.width !== Math.round(els.canvas.clientWidth * dpr)
    || els.canvas.height !== Math.round(els.canvas.clientHeight * dpr);
}

/** The render loop. Runs continuously but does nothing unless a flag is set. */
function frame() {
  if (state.world) {
    // The canvas is sized by CSS, so its box can change without any event of
    // ours firing — a window resize, or the dev panel sliding. Check it here,
    // every frame, rather than reacting to a ResizeObserver: observer callbacks
    // are delivered after this callback has already run, so a redraw triggered
    // from one is always a frame late, and until it lands the browser stretches
    // the previous frame's image to the new box. Over a 300ms slide that reads
    // as a map squashed for the whole animation, snapping back at the end.
    if (canvasResized()) {
      clampPan();
      viewDirty = true;
    }

    if (bufferDirty) {
      const t0 = performance.now();
      renderBuffer(state.world, state.mode, state.selected, state.hovered);
      perf.paint = ease(perf.paint, performance.now() - t0);
      perf.fullRepaints++;
      bufferDirty = false;
      dirtyProvinces.clear();   // the full repaint covered them
      viewDirty = true;         // new buffer contents always need putting on screen
    } else if (dirtyProvinces.size) {
      const t0 = performance.now();
      repaintProvinces(state.world, state.mode, state.selected, state.hovered, dirtyProvinces);
      perf.paint = ease(perf.paint, performance.now() - t0);
      perf.partRepaints++;
      dirtyProvinces.clear();
      viewDirty = true;
    }
    if (viewDirty) {
      const t0 = performance.now();
      drawView();
      perf.draw = ease(perf.draw, performance.now() - t0);
      viewDirty = false;
    }

    const now = performance.now();
    if (perf.lastFrame) perf.fps = ease(perf.fps, 1000 / (now - perf.lastFrame));
    perf.lastFrame = now;
    updateReadout(now);
  }
  requestAnimationFrame(frame);
}

/**
 * Which province is under the cursor, or null for sea or off-map.
 *
 * Hit testing is a single array lookup: the pointer is converted to a map pixel
 * and that pixel already knows its province. No shape or polygon test is needed,
 * so it stays constant-time however complicated the borders get.
 */
function provinceAtEvent(ev) {
  const w = state.world;
  const rect = els.canvas.getBoundingClientRect();
  const { x, y } = screenToMap(ev.clientX - rect.left, ev.clientY - rect.top);
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= w.width || py >= w.height) return null;
  const index = w.provinceAt[py * w.width + px];
  return index === OCEAN ? null : w.atIndex[index].id;
}

/** Selects a province, or clears the selection when `id` is null. */
function select(id) {
  const was = state.selected;
  state.selected = id;

  // Exactly two groups change shade: what was highlighted before, and what is
  // highlighted now — each being a province plus its neighbours. Repainting just
  // those is what keeps selecting instant on a large map.
  invalidateProvinces(was, id);
  for (const q of neighboursOf(was)) invalidateProvinces(q);
  for (const q of neighboursOf(id)) invalidateProvinces(q);

  // Trace the shape once here, since that is the costly part. The ring itself is
  // left for drawView() to build, because it depends on the current zoom.
  state.silhouette = id ? buildSilhouette(state.world, id) : null;
  state.outline = null;
  updatePanel();
}

/** A province's neighbour ids, or nothing at all when `id` is null. */
const neighboursOf = (id) => (id && state.world.adjacency.get(id)) || [];

const swatch = (rgb) => `<span class="swatch" style="background: rgb(${rgb})"></span>`;

const TOOLTIP_OFFSET = 14;

/**
 * Shows the hover tooltip, or hides it when `id` is null.
 *
 * It normally sits below and right of the cursor, but flips to the other side
 * when it would otherwise run past the edge of the map area.
 */
function showTooltip(id, ev) {
  const w = state.world;
  if (!id) { els.tooltip.hidden = true; return; }

  const p = w.byId.get(id);
  const pol = polityOf(w, p);
  els.tooltip.innerHTML =
    `<div>${p.name}</div>` +
    `<div class="sub">${swatch(pol.colour)}${pol.name}${p.terrain.length ? ` &middot; ${p.terrain.join(' + ')}` : ''}</div>`;
  els.tooltip.hidden = false;

  const box = els.wrap.getBoundingClientRect();
  const x = ev.clientX - box.left;
  const y = ev.clientY - box.top;
  const tw = els.tooltip.offsetWidth;
  const th = els.tooltip.offsetHeight;

  els.tooltip.style.left = `${x + TOOLTIP_OFFSET + tw > box.width ? x - TOOLTIP_OFFSET - tw : x + TOOLTIP_OFFSET}px`;
  els.tooltip.style.top = `${y + TOOLTIP_OFFSET + th > box.height ? y - TOOLTIP_OFFSET - th : y + TOOLTIP_OFFSET}px`;
}

const panelOpen = () => els.panel.classList.contains('open');

/**
 * Slides the development inspector in or out, bound to the backtick key.
 *
 * The panel is a debugging tool rather than part of the game, so it starts
 * closed and takes up no layout space at all when closed — the map simply gets
 * the full width. The animation itself lives in the CSS; all this does is set
 * the class that drives it.
 *
 * Contents are rebuilt on the way in, because selections made while it was
 * closed did not bother updating a panel nobody could see.
 */
function togglePanel() {
  els.panel.classList.toggle('open');
  document.getElementById('toggle-panel').classList.toggle('active', panelOpen());
  if (panelOpen()) {
    updatePanel();
    readoutAt = 0;             // refresh the live numbers at once, not up to 250ms later
  }
  // The slide resizes the canvas continuously, and frame() notices that on each
  // tick and redraws to match — so the map keeps step with the panel rather than
  // being stretched to fit until the animation ends. Nothing further is needed.
}

/** Rewrites the development inspector for the current selection. */
function updatePanel() {
  if (!panelOpen()) return;                       // nothing to update while it is closed
  const w = state.world;
  if (!state.selected) {
    els.selName.textContent = '—';
    els.selBody.innerHTML = '<span class="hint">Click a province on the map.</span>';
    els.neighbours.innerHTML = '';
    return;
  }
  const p = w.byId.get(state.selected);
  const nb = [...w.adjacency.get(p.id)]
    .map((id) => w.byId.get(id))
    .sort((a, b) => a.name.localeCompare(b.name));

  els.selName.textContent = p.name;
  els.selBody.innerHTML = `
    <div class="row"><span>ID</span><span>${p.id}</span></div>
    <div class="row"><span>Owner</span><span>${swatch(polityOf(w, p).colour)}${polityOf(w, p).name}</span></div>
    <div class="row"><span>Terrain</span><span>${p.terrain.join(' + ') || '—'}</span></div>
    <div class="row"><span>Coastal</span><span>${w.coastal.has(p.id) ? 'yes' : 'no'}</span></div>
    <div class="row"><span>Pixels</span><span>${w.bounds.get(p.id)?.n ?? 0}</span></div>
    <div class="row"><span>Neighbours</span><span>${nb.length}</span></div>`;
  els.neighbours.innerHTML = `<h1>Adjacent provinces</h1><ul>${nb.map((q) => `<li data-id="${q.id}">${swatch(polityOf(w, q).colour)}${q.name}</li>`).join('')
    }</ul>`;
}

const READOUT_MS = 250;    // refresh rate of the live numbers; per-frame DOM writes are wasteful
let readoutAt = 0;

const statRow = (k, v, warn) =>
  `<div class="row"><span>${k}</span><span${warn ? ' class="warn"' : ''}>${v}</span></div>`;

/**
 * Refreshes the Performance block, a few times a second.
 *
 * Rewriting this every frame would itself cost more than most of what it
 * measures, and the numbers are eased averages that barely move between frames.
 */
function updateReadout(now) {
  if (!panelOpen() || now - readoutAt < READOUT_MS) return;
  readoutAt = now;

  const drawing = view.scale > overview.scale ? 'tiles' : 'overview';
  const visible = drawing === 'tiles' ? `${debug.tilesDrawn} / ${tiles.list.length}` : `0 / ${tiles.list.length}`;

  els.perf.innerHTML =
    statRow('Frame', `${perf.fps.toFixed(0)} fps`, perf.fps < 45) +
    statRow('Blit', `${perf.draw.toFixed(2)} ms`, perf.draw > 8) +
    statRow('Last paint', `${perf.paint.toFixed(2)} ms`, perf.paint > 16) +
    statRow('Repaints', `${perf.fullRepaints} full / ${perf.partRepaints} part`) +
    statRow('Drawing from', drawing) +
    statRow('Chunks drawn', visible) +
    statRow('Zoom', `${Math.round(view.scale * 100)}%`) +
    (state.showProvinceNames ? statRow('Names shown', `${debug.names} / ${state.world.byId.size}`) : '');
}

/** One-off summary of the loaded map. Nothing here changes after load. */
function showStats(w) {
  // Each border is recorded on both provinces, so the total is halved below.
  let edges = 0;
  for (const s of w.adjacency.values()) edges += s.size;
  const px = w.width * w.height;
  const empty = [...w.byId.values()].filter((p) => !w.bounds.has(p.id)).length;

  els.stats.innerHTML =
    statRow('Size', `${w.width} &times; ${w.height}`) +
    statRow('Pixels', `${(px / 1e6).toFixed(1)}M`) +
    statRow('Provinces', w.byId.size) +
    statRow('Borders', edges / 2) +
    statRow('Coastal', w.coastal.size) +
    statRow('Polities', w.table.polities.length - 1) +
    statRow('Labels', w.labels.length) +
    statRow('Chunks', `${tiles.cols} &times; ${tiles.rows} @ ${TILE}px`) +
    statRow('Overview', `${overview.canvas.width} &times; ${overview.canvas.height}`) +
    statRow('Satellite', w.satellite ? `${w.satellite.width} &times; ${w.satellite.height}` : 'none',
      !!w.satellite && (w.satellite.width !== w.width || w.satellite.height !== w.height)) +
    // A province in the table with no pixels is invisible and unclickable, so
    // it is worth flagging here rather than only in the console at load.
    statRow('Empty', empty, empty > 0);
}

// =================================================================== 7. input

// Drag pans, click selects — and the mouse cannot say which you meant until you
// either move or let go. A press that travels fewer than this many pixels before
// release counts as a click, which stops a shaky hand from eating selections.
const DRAG_SLOP = 4;

/** Attaches every event listener. Called once, from init(). */
function wireInput() {
  // Shared by the mouse handlers below: whether a button is down, whether it has
  // yet travelled far enough to count as a drag, and where it last was.
  let dragging = false;
  let moved = false;
  let last = { x: 0, y: 0 };

  els.canvas.addEventListener('mousedown', (ev) => {
    dragging = true;
    moved = false;
    last = { x: ev.clientX, y: ev.clientY };
  });

  // On window, not the canvas, so a drag continues even when the pointer leaves
  // the map — and still ends properly if the button is released outside it.
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - last.x;
    const dy = ev.clientY - last.y;
    if (!moved && (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP)) {
      moved = true;
      els.canvas.classList.add('panning');
    }
    if (moved) {
      view.x += dx;
      view.y += dy;
      clampPan();
      invalidateView();
      last = { x: ev.clientX, y: ev.clientY };
    }
  });

  window.addEventListener('mouseup', (ev) => {
    // Never travelled past the slop, so it was a click after all.
    if (dragging && !moved) select(provinceAtEvent(ev));
    dragging = false;
    els.canvas.classList.remove('panning');
  });

  // Hover highlighting and the tooltip. Separate from the pan handler above,
  // since this one only cares about the canvas.
  els.canvas.addEventListener('mousemove', (ev) => {
    if (dragging && moved) { els.tooltip.hidden = true; return; }  // stay quiet mid-drag
    const id = provinceAtEvent(ev);
    // Only repaint when the province under the cursor actually changes, not on
    // every pixel of movement within one province.
    // Only the province being left and the one being entered change shade.
    if (id !== state.hovered) { invalidateProvinces(state.hovered, id); state.hovered = id; }
    showTooltip(id, ev);
  });

  els.canvas.addEventListener('mouseleave', () => {
    invalidateProvinces(state.hovered);      // just clear the one that was lit
    state.hovered = null;
    els.tooltip.hidden = true;
  });

  // passive:false because preventDefault() is needed to stop the page scrolling.
  els.canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = els.canvas.getBoundingClientRect();
    // Exponential in the wheel delta, so one notch is always the same RATIO of
    // zoom. A fixed step would crawl when zoomed out and leap when zoomed in.
    zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, Math.pow(1.0015, -ev.deltaY));
  }, { passive: false });

  document.getElementById('zoom-in').addEventListener('click', () => zoomCentre(1.4));
  document.getElementById('zoom-out').addEventListener('click', () => zoomCentre(1 / 1.4));
  document.getElementById('zoom-fit').addEventListener('click', fitToView);

  document.getElementById('toggle-panel').addEventListener('click', togglePanel);

  // The imagery is optional, so the button reflects whether there is any to show.
  const sat = document.getElementById('toggle-satellite');
  sat.disabled = !state.world.satellite;
  sat.classList.toggle('active', state.satellite);
  sat.addEventListener('click', () => {
    state.satellite = !state.satellite;
    sat.classList.toggle('active', state.satellite);
    invalidateBuffer();      // the compositing is baked into the tiles, so repaint them
  });

  // Every overlay switch, from one listener. A button's data-toggle names the
  // field in `state` it drives, so a new overlay needs no wiring of its own —
  // add the button, add the field, and draw it in drawOverlays().
  els.toggles.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-toggle]');
    if (!b) return;
    const key = b.dataset.toggle;
    state[key] = !state[key];
    b.classList.toggle('active', state[key]);
    invalidateView();          // overlays draw over the map; the buffer is untouched
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === '+' || ev.key === '=') zoomCentre(1.4);
    else if (ev.key === '-' || ev.key === '_') zoomCentre(1 / 1.4);
    else if (ev.key === '0') fitToView();
    else if (ev.key === '`') togglePanel();
  });

  // One listener on the list rather than one per item, since updatePanel()
  // rebuilds its contents on every selection.
  els.neighbours.addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-id]');
    if (li) select(li.dataset.id);
  });

  els.toolbar.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (!b) return;                                // a click on some other button
    state.mode = b.dataset.mode;
    for (const other of els.toolbar.querySelectorAll('button[data-mode]')) {
      other.classList.toggle('active', other === b);
    }
    invalidateBuffer();      // a mode change recolours every province at once
  });

  // No resize listener or ResizeObserver here on purpose: frame() compares the
  // canvas box against its pixel buffer on every tick, which catches window
  // resizes and the panel slide alike, and does it in time to draw that frame.
}

// ==================================================================== 8. boot

/**
 * Loads the data, builds the model, and starts the render loop.
 *
 * Order matters here: buildWorld() needs the normalised table, computeLabels()
 * needs the adjacency buildWorld() derives, and fitToView() needs the map's size
 * to know what to fit to.
 */
async function init() {
  const table = normaliseTable(await loadJSON('./data/provinces.json'));

  // Fetched together: the imagery is the larger file by far, and waiting for it
  // after the province bitmap would add its whole download to the load time.
  const [pixels, satellite] = await Promise.all([
    loadPixels('./data/provinces.png'),
    loadBitmap('./data/satellite.png'),
  ]);

  const world = buildWorld(table, pixels);
  world.satellite = satellite;
  world.labels = computeLabels(world);      // placed once; only their size changes with zoom
  state.world = world;
  state.satellite = !!satellite;

  // The imagery has to line up with the province bitmap pixel for pixel, since
  // it is blitted with the same coordinates. Anything else is a mistake worth
  // saying out loud rather than leaving as a mysteriously offset map.
  if (satellite && (satellite.width !== world.width || satellite.height !== world.height)) {
    console.warn(
      `satellite.png is ${satellite.width}x${satellite.height} but provinces.png is ` +
      `${world.width}x${world.height}. They must match; the imagery will not align.`
    );
  }

  // Before showStats, which reports the chunk grid and overview it creates.
  buildTiles(world);
  showStats(world);
  wireInput();
  fitToView();
  updatePanel();
  requestAnimationFrame(frame);
}

init().catch((err) => {
  document.body.innerHTML =
    `<div style="padding:24px;font:14px system-ui;color:#d8dce4">
       <strong>Failed to start.</strong><br><br>${err.message}<br><br>
       <span style="color:#8a91a0">If this says the file could not be loaded, you are probably
       opening index.html directly. Browsers block local file reads. Serve the folder over
       HTTP instead &mdash; see README.md.</span>
     </div>`;
  console.error(err);
});
