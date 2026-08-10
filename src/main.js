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

// Imported dynamically, carrying forward the ?v= token index.html loaded this
// file with. A static import would resolve to an unversioned URL and could come
// straight from cache while this file was freshly fetched — leaving half the
// program old and half new, which is a genuinely baffling thing to debug.
const VERSION = new URL(import.meta.url).search;

const {
  OCEAN, LABEL_HIST_BUCKET, CHAMFER_ORTH,
  toRgb, normaliseTable, buildWorld, buildBorderDistance, computeLabelGeometry,
  indexProvinces,
} = await import(`./mapdata.js${VERSION}`);
const { CACHE_FILE, hashInputs, unpackCache, worldFromCache } = await import(`./mapcache.js${VERSION}`);

// ============================================================ 1. data loading

// Map data changes constantly while drawing, and a stale cache looks exactly
// like a bug in the code. Always fetch fresh.
const noCache = (url) => `${url}?t=${Date.now()}`;

async function loadJSON(url, optional = false) {
  const res = await fetch(noCache(url), { cache: 'no-store' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`could not load ${url} (${res.status})`);
  }
  return res.json();
}

/** Raw bytes, or null if there is no such file. Used for optional data. */
async function loadBytes(url, optional = false) {
  const res = await fetch(noCache(url), { cache: 'no-store' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`could not load ${url} (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The precomputed map, if there is one and it still matches its inputs.
 *
 * Returns null for every kind of miss — no file, an old format, a hash from a
 * bitmap since redrawn — and the caller then derives everything itself. The
 * cache is only ever allowed to make loading faster, never to decide what the
 * map is.
 */
async function loadCache(bytes, expectedHash) {
  if (!bytes) return null;
  if (typeof DecompressionStream !== 'function') return null;   // older browser
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const cache = unpackCache(new Uint8Array(await new Response(stream).arrayBuffer()));
    if (!cache) return null;
    if (cache.meta.hash !== expectedHash) {
      console.info('map-cache.bin is out of date and was ignored. Rebuild it with: node sync-provinces.js --cache');
      return null;
    }
    return cache;
  } catch (err) {
    console.warn('map-cache.bin could not be read; computing from the bitmap instead.', err);
    return null;
  }
}

/**
 * Read the bitmap's pixels exactly as authored.
 *
 * A PNG carrying an sRGB/ICC chunk is colour-managed into the display profile
 * on decode, nudging channels by a point or two. White never moves and pastels
 * barely do, but a saturated colour shifts enough to stop matching the JSON —
 * and that province then silently reads as ocean. This turns that off.
 */
async function loadPixels(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none' });

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


// ============================================================= 2. world model

const UNKNOWN_POLITY = { id: '?', name: 'Unknown', colour: [90, 90, 96] };

// The model itself is built in mapdata.js, which the build script shares.


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
const BORDER_INTERNAL = 0.85;   // neighbour has the same owner
const BORDER_NATIONAL = 0.42;   // neighbour has a different owner, or is open sea

// How far each highlight state mixes its province toward white. A proportional
// mix, not a flat addition: adding a fixed amount would push an already-bright
// channel past 255 on a pale province, clipping it and shifting the hue as it
// brightens. Mixing lifts every channel by the same share of its own headroom.
const LIGHTEN = { selected: 0.10, neighbour: 0.04, hovered: 0.04 };

// Compositing over the satellite imagery. The province layer is drawn with a
// PER-PIXEL alpha, not one opacity for the whole layer, so that a country's
// colour is emphatic along its frontier and falls away inland — leaving the
// terrain to read through the middle of a large country while its shape stays
// unmistakable. Fading the layer uniformly would instead wash out the borders
// along with everything else, and the borders are what has to stay legible.
const SATELLITE_NATIONAL = 0.88;  // the drawn frontier line itself
const SATELLITE_INTERNAL = 0.22;  // province subdivisions, on top of the local fill alpha
const SATELLITE_RIM = 0.82;       // country colour hard against a national border
const SATELLITE_CORE = 0.36;      // country colour deep inland
const FADE_PX = 24;               // how far inward the colour reaches, in map pixels
const FADE_CURVE = 0.8;           // < 1 concentrates the falloff near the border

// The fade above is a political-map device: it exists to make a COUNTRY's shape
// read at a glance. The other modes answer different questions — which province
// is this, what terrain is it — and a fade only makes their fills mottled and
// their centres illegible. They use one flat opacity and no pastel wash.
const SATELLITE_FLAT = 0.84;

// Inland, the colour is not merely thinner but softer: it is washed toward a
// pale neutral before being laid over the terrain. Thinning alone leaves the
// interior reading as a dim version of the border colour rather than as a
// distinct pastel field, which is the look this is after.
const PASTEL_MIX = 0.55;
const PASTEL_TOWARD = [226, 231, 238];

// Highlighted provinces are pushed back towards opaque, or the fade would leave
// a selection deep inside a country too faint to make out.
const SATELLITE_LIFT = { selected: 0.5, neighbour: 0.32, hovered: 0.22 };

// How long a dropped selection takes to fade away. Short enough to feel like
// part of the click rather than an animation waiting to finish.
const DESELECT_FADE_MS = 60;

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
 * Works out every shade of every province before any pixel is touched.
 *
 * Returns flat [r,g,b]-per-index arrays. The pixel loops then only index into
 * them: deciding a colour inside those loops would mean a Map lookup and a fresh
 * array for every pixel on the map. This is O(provinces), a few hundred, so it
 * is cheap enough to redo on every repaint however small the repaint is.
 *
 * There are two interior colours, not one. `rim` is the country's own colour, as
 * it appears against a frontier; `core` is a pastel wash of it for deep inland.
 * The pixel loop blends between them by distance from the border, so a country
 * reads as a saturated outline enclosing a soft field rather than as a flat
 * colour at varying opacity. The border shades come in the same pair.
 */
function shadeTable(world, mode, selected, hovered) {
  const { atIndex } = world;
  const n = atIndex.length;
  const rim = new Uint8Array(n * 3);      // interior, hard against a frontier
  const core = new Uint8Array(n * 3);     // interior, deep inland — the pastel wash
  const softRim = new Uint8Array(n * 3);  // subdivision line, near a frontier
  const softCore = new Uint8Array(n * 3); // subdivision line, inland
  const hard = new Uint8Array(n * 3);     // the frontier line itself
  const neighbours = selected ? world.adjacency.get(selected) : null;
  const colourOf = MODES[mode];

  // Owners as small integers, so the pixel loop can ask "same owner?" with a
  // number comparison rather than a string one. Ocean stays -1, which never
  // matches any province, so every coastline automatically counts as a hard edge.
  const ownerAt = new Int32Array(n).fill(-1);
  const ownerOrdinal = new Map();

  // Whether the imagery is showing decides the whole alpha scheme. With it off
  // everything is opaque and the result is byte-for-byte what it always was.
  const over = !!(world.satellite && state.satellite && world.borderDist);
  const dropped = state.fade;                 // a selection on its way out, if any
  const k = dropped ? fadeStrength() : 0;     // how much of its highlight is left

  // And only the political map is shaped by distance from a frontier. The other
  // modes fill evenly, so that a province or a terrain type reads the same in
  // the middle of a country as it does at the edge.
  const shaped = over && mode === 'political';
  const lift = new Uint8Array(n);       // extra opacity for a highlighted province

  for (let ix = 1; ix < n; ix++) {
    const p = atIndex[ix];
    if (!ownerOrdinal.has(p.owner)) ownerOrdinal.set(p.owner, ownerOrdinal.size);
    ownerAt[ix] = ownerOrdinal.get(p.owner);

    // Highlight, if this province is in one of the three states. The selected
    // province lightens most and also gets the ring drawn in §5; its neighbours
    // lighten less, which is what shows you where you could move.
    let role = selected === p.id ? 'selected'
      : neighbours?.has(p.id) ? 'neighbour'
        : hovered === p.id ? 'hovered' : null;

    // A dropped selection keeps its highlight at falling strength until it has
    // faded out. The live selection always wins, so re-clicking a province that
    // is still fading, or picking one of its neighbours, snaps to full strength
    // rather than inheriting whatever the fade had reached.
    let strength = 1;
    if (!role && dropped) {
      if (dropped.id === p.id) { role = 'selected'; strength = k; }
      else if (dropped.neighbours.has(p.id)) { role = 'neighbour'; strength = k; }
    }

    const mix = role ? LIGHTEN[role] * strength : 0;
    if (over && role) lift[ix] = Math.round(255 * SATELLITE_LIFT[role] * strength);

    const c = colourOf(world, p);
    for (let ch = 0; ch < 3; ch++) {
      const v = c[ch] + (255 - c[ch]) * mix;                       // the country's colour
      const pale = v + (PASTEL_TOWARD[ch] - v) * PASTEL_MIX;       // washed, for inland
      const inland = shaped ? pale : v;         // unshaped modes never wash out
      rim[ix * 3 + ch] = v;
      core[ix * 3 + ch] = inland;
      softRim[ix * 3 + ch] = v * BORDER_INTERNAL;
      softCore[ix * 3 + ch] = inland * BORDER_INTERNAL;
      hard[ix * 3 + ch] = v * BORDER_NATIONAL;
    }
  }

  // How far between rim and core a pixel sits, by distance from the frontier,
  // resolved once into a 256-entry table so the pixel loop is a lookup rather
  // than a curve. 0 means fully rim, 255 fully core.
  //
  // The exponent shapes the falloff. Below 1 it concentrates the change close to
  // the border, giving a defined band of colour that drops away quickly, instead
  // of the even wash a straight ramp or a smoothstep produces.
  // Left at zero when unshaped, which pins every pixel to the rim colour and the
  // rim alpha — one flat fill, and no distance lookup doing anything.
  const fade = new Uint8Array(256);
  const span = FADE_PX * CHAMFER_ORTH;          // distances are stored pre-scaled
  if (shaped) {
    for (let d = 0; d < 256; d++) fade[d] = Math.round(255 * Math.min(1, d / span) ** FADE_CURVE);
  }

  const flat = over ? Math.round(255 * SATELLITE_FLAT) : 255;
  return {
    rim, core, softRim, softCore, hard, ownerAt, over, fade, lift,
    aRim: shaped ? Math.round(255 * SATELLITE_RIM) : flat,
    aCore: shaped ? Math.round(255 * SATELLITE_CORE) : flat,
    aInternal: over ? Math.round(255 * SATELLITE_INTERNAL) : 0,   // added to the local fill alpha
    aNational: over ? Math.round(255 * SATELLITE_NATIONAL) : 255,
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
  const { width, height, provinceAt, borderDist } = world;
  const { rim, core, softRim, softCore, hard, ownerAt, over, fade, lift } = t;
  const { aRim, aCore, aInternal, aNational, aSea } = t;
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

      const c = index * 3;

      // A frontier is drawn at full strength wherever it runs; it never fades.
      if (edge === 2) {
        d[o] = hard[c]; d[o + 1] = hard[c + 1]; d[o + 2] = hard[c + 2];
        d[o + 3] = aNational;
        continue;
      }

      // Interiors, and the subdivision lines within them, blend from the
      // country's own colour at the frontier to its pastel wash inland. `f` is
      // that blend as a byte, so the mix is a shift rather than a divide.
      const f = over ? fade[borderDist[i]] : 0;
      const [near, far] = edge === 1 ? [softRim, softCore] : [rim, core];
      d[o] = near[c] + (((far[c] - near[c]) * f) >> 8);
      d[o + 1] = near[c + 1] + (((far[c + 1] - near[c + 1]) * f) >> 8);
      d[o + 2] = near[c + 2] + (((far[c + 2] - near[c + 2]) * f) >> 8);

      if (!over) {
        d[o + 3] = 255;                          // no imagery: nothing to fade into
      } else {
        // Subdivision lines sit a little above the fill they cross, so they stay
        // visible inland without ever reading as a frontier.
        const a = aRim + (((aCore - aRim) * f) >> 8) + lift[index] + (edge === 1 ? aInternal : 0);
        d[o + 3] = a > 255 ? 255 : a;
      }
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
// Labels belong to the MAP, not to the screen: a name is sized and positioned in
// map units and simply scales with the zoom, as though painted onto the terrain.
// A country's name therefore covers the same part of that country at every zoom.
//
// Deliberately no upper size limit. Capping it would stop the text growing once
// the cap was reached, which reads as the label shrinking back toward its own
// centre as you zoom further in — it stops sitting still on the land.
//
// Zoom decides only how VISIBLE a name is, never its size or place. See
// LABEL_FADE_IN below.
const LABEL_TRACKING = 0.16;     // letter spacing, as a fraction of the font size
const LABEL_LINE_HEIGHT = 1.1;   // distance between stacked lines, as a multiple of the font size
/*
 * Opacity is a function of the label's OWN size on screen, not of the zoom.
 *
 * That distinction is the whole point. A label tied to the zoom fades in step
 * with every other label, however big or small its country — so zooming in
 * dims a tiny country's name at the very moment it finally became readable.
 * Driven by size instead, each label lives its own life: it fades in when it
 * grows readable, holds while it is a useful size, and fades out once it has
 * grown so large that you are plainly looking at provinces rather than at
 * countries. A large country reaches that point at a much lower zoom than a
 * small one, which is why big names disappear first.
 *
 * Both thresholds are in screen pixels of font size.
 */
const LABEL_ALPHA = 0.85;                  // peak opacity, in the band between the two

// The two ends are measured in different units, on purpose.
//
// Fading IN is about legibility, which is absolute: text under about eight
// pixels cannot be read whatever it names, so this is in screen pixels of font
// size.
//
// Fading OUT is about the name having outlived its usefulness, which is
// relative: what matters is how much of the WINDOW the country now fills. Font
// size is a poor proxy for that, because fitLabel() sizes a long name smaller
// than a short one — so at any given font size, a long-named country is far more
// zoomed in than a short-named one, and the two would drop out at quite
// different moments. Since a label is always laid out at LABEL_FIT.along of its
// territory's span, its width IS that span, and comparing it with the viewport
// asks the question directly. Fully faded by the time a country fills the
// screen, which is the point at which you are looking at provinces.
const LABEL_FADE_IN = [3, 6];              // screen pixels of font size
const LABEL_FADE_OUT = [0.34, 0.78];       // label width, as a fraction of the window

/** Eased 0..1 ramp, so neither end of a fade arrives as a visible step. */
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * A label's opacity: `px` is its font size on screen, `covers` the share of the
 * window its widest line spans. 0 means do not draw it at all.
 */
function labelOpacity(px, covers) {
  return LABEL_ALPHA
    * smoothstep(LABEL_FADE_IN[0], LABEL_FADE_IN[1], px)
    * (1 - smoothstep(LABEL_FADE_OUT[0], LABEL_FADE_OUT[1], covers));
}
// The tightest the spine may curve, as a multiple of the label's own type size.
//
// Crowding on the inside of a bend is dealt with by curveWiden(), which widens
// the letter gaps to cancel it — so this no longer has to protect letterspacing
// and can sit just clear of the one radius that has no answer: h/2, where the
// inner edge of the text stops moving forward at all and the letters invert.
// Everything above that is fair game, and the spine follows the land.
const BEND_RADIUS = 7;

// Polity label colours, as "r,g,b". Opacity is kept separate because it varies
// with zoom: LABEL_ALPHA sets the pair's overall strength at the current scale,
// and the two multipliers below then weight each against the other. Both are
// relative, so the text and its halo always fade together rather than one
// outliving the other. The outline is what keeps a name legible as it crosses
// provinces of very different colours, so they only work as a contrasting pair.
const LABEL_COLOUR = '28,34,45';
const LABEL_OUTLINE = '255,255,255';
const LABEL_COLOUR_OPACITY = 0.9;     // 0 hides the text and leaves only the halo
const LABEL_OUTLINE_ALPHA = 0.76;   // 0 leaves bare text with nothing behind it
const LABEL_OUTLINE_WIDTH = 0.13;   // as a fraction of the font size

// --- choosing the font size and the number of lines
const LABEL_FIT = { along: 0.86, across: 0.9 };  // fraction of the block's span/thickness the text may fill
const LABEL_MAX_LINES = 3;       // hard ceiling on stacked lines
const LABEL_WRAP_ASPECT = 2.3;   // length-to-width above which a block never stacks: a long thin
// territory reads better with its name spread along it
const LABEL_WRAP_GAIN = 1.15;    // and an extra line must grow the type by this factor to be worth taking

// --- choosing which stretch of the block the name covers
// LABEL_HIST_BUCKET comes from mapdata.js — the label geometry is computed there.
const LABEL_DENSITY_FLOOR = 0.4; // a slice counts as solid ground at this fraction of the block's mean width
const LABEL_MIN_DENSITY = 0.3;   // a whole block sparser than this is an archipelago, and gets no label

//change the number to change weight/boldness of text
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
    if (!best || size > best.size * LABEL_WRAP_GAIN) best = { lines: wrapped.lines, size, width: wrapped.worst };
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
function buildLabels(world, geometry) {
  if (!geometry) return [];
  const { blocks, geo, fit } = geometry;

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
    // rule. That quadratic is the spine — the curve the text is set along.
    const [a2, a1, a0] = solveQuadratic(f) || [0, 0, 0];

    // STEP 4. Note which measurement each argument gets: whether stacking is
    // allowed is judged on `extent`, the block's real shape, while the type is
    // sized to `span`, the solid part. Judging on `span` would misread a long
    // thin country as round once denseRange had cut its capes off.
    const maxLines = extent / thickness < LABEL_WRAP_ASPECT ? LABEL_MAX_LINES : 1;
    const laid = fitLabel(text, span, thickness, maxLines);
    if (!laid) return;

    // Only now can the curvature be limited, because the thing that limits it is
    // the size of the type.
    //
    // A curve of radius R crowds the letters on its inner side; they collide once
    // R approaches the height of the text. So the spine may bend as tightly as
    // BEND_RADIUS text-heights and no tighter — which on a strongly curved
    // country usually means no limit at all, and the spine simply follows the
    // land. Capping it by any fixed fraction of the label's length instead, as
    // this did before, straightened out exactly the curved countries that most
    // needed to bend.
    const radius = BEND_RADIUS * laid.size;
    const bendLimit = 1 / (2 * Math.max(radius, 1));
    const bend = clamp(a2, -bendLimit, bendLimit);

    // Flattening the curve means re-deriving the constant with it.
    //
    // t and u are both measured from the block's centre of mass, so the fit has
    // mean zero, which pins the constant to the curvature: a0 = -a2 * E[t^2].
    // A parabola bending downwards therefore sits ABOVE the centre at its vertex
    // and below at its ends — correct, and how it tracks a curved country. But
    // clamp the curvature and leave a0 alone and the spine keeps an offset only
    // the original, steeper curve justified: flat AND pushed off the land.
    const a0Fixed = a0 + (f.s0 ? (a2 - bend) * (f.s2 / f.s0) : 0);

    // Deliberately no minimum size. A small block just gets small type and stays
    // hidden until the zoom makes it large enough on screen to read.
    // Dropping it here instead would mean it never gets a name at any zoom.

    const L = {
      lines: laid.lines, size: clamp(laid.size, 0.05, 400),
      width: laid.width,          // widest line, in ems — see labelOpacity()
      tMid: (tLo + tHi) / 2,
      cx: g.cx, cy: g.cy, ux: g.ux, uy: g.uy,
      a2: bend, a1, a0: a0Fixed,
    };
    L.bounds = labelBounds(L, span);
    labels.push(L);
  });
  return labels;
}

/**
 * A box in MAP units that the finished label cannot escape.
 *
 * Drawing a label is not cheap — a glyph at a time, each one measured, rotated,
 * stroked and filled — and a label that is nowhere near the window should not
 * cost any of that. Zoomed in, that is nearly all of them: the type grows with
 * the land, so every name on the map passes its readability test while two are
 * actually on screen.
 *
 * Everything here is in map units and so is independent of zoom, which is why it
 * can be worked out once at build time and then only compared against the window.
 * The spine is sampled rather than solved because it is a parabola through a
 * rotated frame, and its extremes are easier to sample than to derive. The pad
 * covers what the sample cannot see: glyphs reach half a text height off the
 * spine, stacked lines reach further, and the outline sits outside even that.
 */
function labelBounds(L, span) {
  const half = span / 2;
  const pad = L.size * (L.lines.length * LABEL_LINE_HEIGHT + LABEL_OUTLINE_WIDTH + 1);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= 12; i++) {
    const { x, y } = spinePoint(L, -half + (span * i) / 12);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
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
 * How much wider the letter gaps must be at a point on the spine to hold their
 * spacing, as a multiple. 1 on a straight spine.
 *
 * A curve of radius R carries the inner edge of a line of text, half its height
 * in, around a radius of R - h/2. That inner edge travels less far than the
 * centre for the same angle, so the letters bunch up on it, and widening by
 * R / (R - h/2) gives back exactly what the curve took.
 */
/**
 * Moves `arc` along the spine from t, and returns the t it arrives at. Both are
 * in map units; `arc` may be negative.
 *
 * Along a curve of slope s, dt = ds / sqrt(1 + s*s). The slope changes as you
 * go, so this walks in a few substeps and re-reads it each time — enough for
 * text, where the spine is a gentle parabola over a few hundred pixels.
 */
function advanceT(L, t, arc) {
  if (!L.a2 && !L.a1) return t + arc;        // straight spine: nothing to correct
  const STEPS = 4;
  const d = arc / STEPS;
  for (let i = 0; i < STEPS; i++) {
    const slope = 2 * L.a2 * (L.tMid + t) + L.a1;
    t += d / Math.sqrt(1 + slope * slope);
  }
  return t;
}

function curveWiden(L, t, px) {
  if (!L.a2) return 1;
  const tt = L.tMid + t;
  const slope = 2 * L.a2 * tt + L.a1;
  const radius = Math.pow(1 + slope * slope, 1.5) / Math.abs(2 * L.a2) * view.scale;
  const inner = radius - px / 2;
  return inner > 1 ? radius / inner : 4;
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
/* ------------------------------------------------------- the glyph atlas
 *
 * Every character the labels use, drawn once and kept as a picture.
 *
 * The reason is what a zoom costs otherwise. Canvas2D cannot reuse anything
 * across a change of type size: at each new size it rebuilds the glyph's outline
 * path, and for the halo it STROKES that path, round joins and all, on the CPU.
 * A label's size is its map size times the zoom, so zooming hands it a size it
 * has never seen on every single frame, and zoomed out there are ninety-odd
 * names on screen — measured at 50 to 155ms of blocking work per frame, which is
 * the stutter. Panning never showed it, because panning does not change the size
 * and so every frame reuses the last one's work.
 *
 * A game engine avoids this by never rasterising text per frame at all: glyphs
 * live in a texture atlas and each one is drawn as a quad, so scale and rotation
 * are the GPU's problem. This is that idea in the tools available here. A baked
 * glyph is a bitmap, and drawImage of a bitmap does not care what size it is
 * being drawn at.
 *
 * Note what is cached and what is not. GLYPHS are cached — 'A' at 24px is always
 * 'A' at 24px, so nothing about the world can invalidate one. Labels are not:
 * which names exist, where their spines run and how big the type is are all
 * still worked out every frame, so a province changing hands changes the map's
 * labelling exactly as it did before.
 */

// Sizes are snapped to a ladder, since caching per exact size would mean a fresh
// bake on every frame of a zoom and no cache at all. 5% steps: the bitmap is
// then drawn at up to 2.5% off its baked size, which is not a difference anyone
// can see, and a zoom from end to end of the range touches about 90 rungs.
const GLYPH_STEP = 1.05;
const GLYPH_MIN = 3;                // below this the label has faded out anyway
const GLYPH_MAX = 512;              // device pixels, so this allows for HiDPI

// Glyphs are baked at twice the size they will be shown at, and every blit is
// therefore a reduction. Blitting at roughly 1:1 sounds cheaper and looks far
// worse: the letters land on fractional positions and at an angle, so they are
// resampled whatever their size, and resampling a 12px letter at 1:1 smears the
// dark body into its own white halo until the word goes grey. Shrinking a larger
// picture averages several source pixels into each one it puts down, which is
// what antialiasing is. The cost is four times the area per glyph, paid once.
const GLYPH_SUPERSAMPLE = 2;

// The ceiling is in PIXELS, not in entries. A bitmap's cost is its area, and
// these range over more than two orders of magnitude in size — a 200px capital
// is some fifty thousand pixels where a 3px one is a few dozen. Counting entries
// would let a few dozen large rungs quietly hold far more memory than several
// thousand small ones. 8M pixels is around 32MB, next to the 64MB the map tiles
// already hold.
const GLYPH_BUDGET_PX = 8e6;

const glyphAtlas = new Map();
let glyphAtlasPx = 0;
let glyphMeasure = null;            // scratch context, for metrics only

function glyphSize(devicePx) {
  const rung = Math.pow(GLYPH_STEP, Math.round(Math.log(devicePx) / Math.log(GLYPH_STEP)));
  return clamp(rung, GLYPH_MIN, GLYPH_MAX);
}

/**
 * One character at one size, halo and body already composited, plus the metrics
 * needed to place it: `ox`/`oy` locate the drawing origin inside the bitmap, and
 * `adv` is the advance width. All four are in the bitmap's own pixels, so a
 * caller scales every one of them by the same factor and the layout holds its
 * shape exactly — which is what keeps letterspacing even.
 *
 * A space has no ink and gets no bitmap, only an advance.
 */
function bakedGlyph(ch, size) {
  const key = `${size}|${ch}`;
  const had = glyphAtlas.get(key);
  if (had) return had;

  if (!glyphMeasure) glyphMeasure = document.createElement('canvas').getContext('2d');
  glyphMeasure.font = labelFont(size);
  // Alignment has to match how the glyph is DRAWN below, because the bounds
  // measureText returns are measured from wherever the origin would be under the
  // current alignment. Measure from the default start/alphabetic origin and draw
  // from a centre/middle one, and the box describes ink that is no longer there:
  // the bitmap comes out the wrong size and the letter is cut off in it.
  glyphMeasure.textAlign = 'center';
  glyphMeasure.textBaseline = 'middle';
  const m = glyphMeasure.measureText(ch);

  // Tight ink bounds rather than the em box, so a bitmap is no larger than the
  // mark it holds. Measured from the drawing origin, with the text centred on it.
  const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight;
  const up = m.actualBoundingBoxAscent, down = m.actualBoundingBoxDescent;
  const pad = Math.ceil(size * LABEL_OUTLINE_WIDTH / 2) + 2;   // room for the halo
  const w = Math.ceil(left + right) + pad * 2;
  const h = Math.ceil(up + down) + pad * 2;

  const g = { canvas: null, w, h, ox: left + pad, oy: up + pad, adv: m.width };

  if (w > 0 && h > 0 && (left + right) > 0 && (up + down) > 0) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.font = labelFont(size);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineJoin = 'round';
    x.lineWidth = size * LABEL_OUTLINE_WIDTH;

    // Baked at the label's own relative strengths, so the bitmap IS the finished
    // label at full opacity and a fade is one globalAlpha on the whole thing.
    // Fading halo and body separately, as this did before, let the body thin out
    // over its own halo and the two show through each other mid-fade.
    x.strokeStyle = `rgba(${LABEL_OUTLINE},${LABEL_OUTLINE_ALPHA})`;
    x.fillStyle = `rgba(${LABEL_COLOUR},${LABEL_COLOUR_OPACITY})`;
    x.strokeText(ch, g.ox, g.oy);
    x.fillText(ch, g.ox, g.oy);
    g.canvas = c;
  }

  // Dropped wholesale rather than evicted one at a time: the entries a zoom
  // leaves behind are sizes it will never be asked for again, so there is
  // nothing worth choosing between. Cleared BEFORE this glyph is added, so the
  // one being asked for right now survives the sweep.
  if (glyphAtlasPx + w * h > GLYPH_BUDGET_PX) {
    glyphAtlas.clear();
    glyphAtlasPx = 0;
  }
  glyphAtlas.set(key, g);
  glyphAtlasPx += w * h;
  return g;
}

/**
 * The rectangle one glyph occupies, kept TILTED rather than squared off.
 *
 * The obvious thing is to return an upright box around the glyph, and it is
 * wrong. Country names run at an angle, and an upright box around a tilted
 * rectangle claims the empty triangles at all four corners as well — at 45
 * degrees it is twice the area of the glyph it stands for. Set in type the size
 * these names are, those phantom corners reach far enough to block every spot a
 * city name could take, and the placement gives up on ground that is plainly
 * empty to look at.
 *
 * So the angle is kept and the overlap test does the extra work instead.
 * `cx`/`cy` are the centre — not the point the glyph was drawn from, since the
 * bitmap hangs from an origin somewhere inside it, so that offset is turned by
 * the same angle before being added on. `ax`/`ay` are the direction the glyph's
 * width runs in.
 */
function glyphBox(g, k, atX, atY, angle) {
  const w = g.w * k, h = g.h * k;
  const cos = Math.cos(angle), sin = Math.sin(angle);

  const offX = w / 2 - g.ox * k;
  const offY = h / 2 - g.oy * k;
  return {
    cx: atX + offX * cos - offY * sin,
    cy: atY + offX * sin + offY * cos,
    hw: w / 2,
    hh: h / 2,
    ax: cos,
    ay: sin,
  };
}

/**
 * Does an upright box overlap a tilted one?
 *
 * Two convex shapes miss each other exactly when some line can be drawn between
 * them, and for rectangles it is enough to try the four directions their own
 * edges face. Along each, both shapes cast a shadow; if the shadows come apart
 * anywhere, the shapes do not touch. The first two directions are the screen's
 * own axes, the last two the glyph's.
 */
function boxHitsGlyph(b, g) {
  const bx = (b[0] + b[2]) / 2, by = (b[1] + b[3]) / 2;
  const bhw = (b[2] - b[0]) / 2, bhh = (b[3] - b[1]) / 2;
  const dx = g.cx - bx, dy = g.cy - by;
  const c = Math.abs(g.ax), s = Math.abs(g.ay);

  if (Math.abs(dx) > bhw + g.hw * c + g.hh * s) return false;
  if (Math.abs(dy) > bhh + g.hw * s + g.hh * c) return false;
  if (Math.abs(dx * g.ax + dy * g.ay) > g.hw + bhw * c + bhh * s) return false;
  if (Math.abs(dy * g.ax - dx * g.ay) > g.hh + bhw * s + bhh * c) return false;
  return true;
}

/**
 * Draws the polity names.
 *
 * `boxes`, when given, is filled with the screen rectangle of every glyph drawn,
 * so that the city names placed afterwards can be kept off them. One box per
 * GLYPH rather than one per name: a country name zoomed in is enormous and
 * mostly air, and reserving the whole run of it would fence off a swathe of map
 * that a city name could have sat in quite happily between two letters.
 */
function drawLabels(ctx, labels, cssW, cssH, dx, boxes = null) {
  ctx.save();
  // The glyphs arrive as bitmaps drawn a few percent off their baked size, so
  // they need smoothing — unlike the map, which drawView deliberately draws with
  // it off once zoomed past 1:1 to keep province edges as hard pixel steps.
  ctx.imageSmoothingEnabled = true;

  const s = view.scale;

  for (const L of labels) {
    // Off screen, and so not worth measuring, rotating, stroking or filling a
    // single glyph of. The caller has already translated by dx for this copy of
    // the map, so that shift has to be undone to compare against the window.
    const b = L.bounds;
    if (b.x1 * s + view.x + dx < 0 || b.x0 * s + view.x + dx > cssW
      || b.y1 * s + view.y < 0 || b.y0 * s + view.y > cssH) continue;

    // L.size is in map units, so scaling by the zoom gives the size on screen.
    // Used directly and uncapped: the text grows with the land it names and keeps
    // covering the same stretch of it. A small country has a real label all
    // along; it is only skipped while too small on screen to read.
    const px = L.size * view.scale;
    const alpha = labelOpacity(px, (L.width * px) / cssW);
    if (alpha <= 0.004) continue;              // fully faded, or not readable yet

    const gap = px * LABEL_TRACKING;

    // Which rung of the ladder these glyphs are baked on, and the factor that
    // takes bitmap pixels back to screen pixels. The rung is chosen in DEVICE
    // pixels so a HiDPI screen bakes proportionally larger and stays sharp,
    // while k stays in CSS pixels to match the transform the canvas is under.
    const bake = glyphSize(px * (window.devicePixelRatio || 1) * GLYPH_SUPERSAMPLE);
    const k = px / bake;

    // The halo and body are already in the bitmap, so the label's opacity is now
    // one value on the whole mark rather than two on its parts.
    ctx.globalAlpha = alpha;

    const n = L.lines.length;
    for (let li = 0; li < n; li++) {
      // Offset each line across the spine, centred on it: with 2 lines that is
      // -0.5 and +0.5 line heights, with 3 it is -1, 0, +1. So the label as a
      // whole stays centred on the block however many lines it has. Divided by
      // view.scale because spinePoint() works in map pixels, not screen pixels.
      const across = (li - (n - 1) / 2) * LABEL_LINE_HEIGHT * px / view.scale;
      const chars = [...L.lines[li]];

      // Metrics come off the baked glyphs rather than from measureText, so the
      // layout and the pictures being placed agree by construction. Every one is
      // scaled by the same k, so the line is the baked line at a uniform scale
      // and the spacing between letters cannot drift.
      const glyphs = chars.map((c) => bakedGlyph(c, bake));
      const widths = glyphs.map((g) => g.adv * k);

      // Letters have height, so on a curve their inner edges sit closer together
      // than their centres and the word looks cramped on the inside of a bend.
      // The gap is widened to give that back — but by ONE amount for the whole
      // line, taken from the tightest point the text passes through.
      //
      // Uniform is the whole point. Curvature varies along a parabola, so
      // compensating letter by letter makes every gap slightly different, and
      // uneven letterspacing is far uglier than a bend ever was. Letters in the
      // gentler stretches get a hair more room than they strictly needed, and
      // nobody can see that; what they can see is spacing that wobbles.
      const flat = widths.reduce((s, w) => s + w, 0) + gap * (chars.length - 1);
      let at = -flat / 2, widen = 1;
      for (let i = 0; i < chars.length; i++) {
        widen = Math.max(widen, curveWiden(L, (at + widths[i] / 2) / view.scale, px));
        at += widths[i] + gap;
      }

      const spacing = gap * widen;
      const total = widths.reduce((s, w) => s + w, 0) + spacing * (chars.length - 1);

      // Walk the glyphs along the CURVE, not along the axis.
      //
      // spinePoint() takes t, a distance measured along the straight axis, but a
      // letter's width is a distance along the curve the letters actually sit
      // on. Those are not the same: where the spine is tilted by slope s, one
      // step along the axis covers sqrt(1 + s*s) of curve. Feeding widths in as
      // if they were axis distances therefore spreads the letters out wherever
      // the curve is steep and packs them where it is flat — which is uneven
      // letterspacing, and far larger than any crowding on the inside of a bend.
      //
      // advanceT() converts the other way, so every letter is placed a true
      // width plus a true gap further along the curve than the last.
      let t = advanceT(L, 0, -total / 2 / view.scale);
      for (let i = 0; i < chars.length; i++) {
        t = advanceT(L, t, widths[i] / 2 / view.scale);
        const g = glyphs[i];
        if (g.canvas) {
          const { x, y, angle } = spinePoint(L, t, across);
          const atX = x * view.scale + view.x;
          const atY = y * view.scale + view.y;
          ctx.save();
          ctx.translate(atX, atY);
          ctx.rotate(angle);
          // One blit of a finished picture, where this used to be a glyph path
          // built, stroked and filled from scratch at a size never seen before.
          ctx.drawImage(g.canvas, -g.ox * k, -g.oy * k, g.w * k, g.h * k);
          ctx.restore();

          if (boxes) boxes.push(glyphBox(g, k, atX, atY, angle));
        }
        t = advanceT(L, t, (widths[i] / 2 + spacing) / view.scale);
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
  const vh = els.canvas.clientHeight;

  // East-west the map loops, so there is nothing to clamp against — instead the
  // offset is wrapped back into a single map width. Panning east for long enough
  // brings you round to where you started, and view.x cannot drift off into
  // numbers large enough to lose precision.
  const span = w.width * view.scale;
  if (span > 0) view.x = ((view.x % span) + span) % span - span;

  // North-south there is no wrapping — the poles are not joined — so this still
  // holds at least a quarter of the viewport over the map.
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
  clampPan();          // normalises the wrapped x, so it starts where panning would leave it
  invalidateView();
}

/**
 * Draws one frame: the map buffer, then the selection ring, then the labels.
 *
 * This is the cheap half of drawing — three composited layers, no per-pixel work
 * — which is why panning and zooming can run at frame rate.
 */
/**
 * The horizontal offsets at which the map has to be drawn to fill the window.
 *
 * The map repeats east-west, so more than one copy of it can be on screen at
 * once — at the seam you see the far edge of the map continuing into the near
 * one. clampPan() keeps view.x within one map width of the origin, so this is
 * usually one or two copies, and three only on a very wide window.
 *
 * Offsets are in screen pixels and are added to view.x.
 */
function wrapOffsets(cssW) {
  const span = state.world.width * view.scale;      // one map width, on screen
  const out = [];
  const first = Math.floor((0 - view.x - span) / span) + 1;
  const last = Math.ceil((cssW - view.x) / span) - 1;
  for (let k = first; k <= last; k++) out.push(k * span);
  return out.length ? out : [0];
}

/**
 * Blits one copy of the map. `vx` is where its left edge sits on screen, which
 * for the wrapped copies is view.x plus some multiple of the map's width.
 */
function drawMapLayer(ctx, cssW, cssH, vx) {
  // Which part of this copy is on screen. Taken outwards to whole map pixels, so
  // nothing shears along the edges.
  const s = view.scale;
  const w = state.world;
  const sx0 = clamp(Math.floor(-vx / s), 0, w.width);
  const sy0 = clamp(Math.floor(-view.y / s), 0, w.height);
  const sx1 = clamp(Math.ceil((cssW - vx) / s), 0, w.width);
  const sy1 = clamp(Math.ceil((cssH - view.y) / s), 0, w.height);
  if (sx1 <= sx0 || sy1 <= sy0) return;

  if (s <= overview.scale) {
    // Zoomed out far enough that the overview holds at least as many pixels as
    // the screen can show, so drawing from it loses nothing and rescales about
    // a tenth as much data. This is the common case, and the whole reason the
    // overview exists: at fit zoom the entire map is visible, and going tile by
    // tile would mean rescaling all 15.9 million pixels on every frame.
    // Destination EDGES are rounded, not the width — the same rule the tiles
    // use. Two copies of the map meeting at the seam compute that shared edge
    // from the same number, so they resolve it to the same integer and abut
    // exactly. Left fractional, each copy's edge is antialiased against the
    // background and the page shows through the join as a hairline.
    const o = overview.scale;
    const dx0 = Math.round(vx + sx0 * s), dx1 = Math.round(vx + sx1 * s);
    const dy0 = Math.round(view.y + sy0 * s), dy1 = Math.round(view.y + sy1 * s);
    if (dx1 <= dx0 || dy1 <= dy0) return;
    ctx.drawImage(
      overview.canvas,
      sx0 * o, sy0 * o, (sx1 - sx0) * o, (sy1 - sy0) * o,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
    return;
  }

  // Zoomed in: full resolution, but only the chunks actually on screen. Every
  // tile beyond the window is skipped outright.
  for (const tile of tilesOver(sx0, sy0, sx1, sy1)) {
    const ax0 = Math.max(sx0, tile.x), ay0 = Math.max(sy0, tile.y);
    const ax1 = Math.min(sx1, tile.x + tile.w), ay1 = Math.min(sy1, tile.y + tile.h);
    if (ax1 <= ax0 || ay1 <= ay0) continue;

    // Destination edges are rounded rather than the width being rounded, so
    // neighbouring tiles agree on where their shared edge lands and cannot
    // leave a gap between them.
    const dx0 = Math.round(vx + ax0 * s), dx1 = Math.round(vx + ax1 * s);
    const dy0 = Math.round(view.y + ay0 * s), dy1 = Math.round(view.y + ay1 * s);
    ctx.drawImage(
      tile.canvas,
      ax0 - tile.x, ay0 - tile.y, ax1 - ax0, ay1 - ay0,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
    debug.tilesDrawn++;
  }
}

/**
 * Draws the ring around a province, at `alpha`.
 *
 * `holder` is anything carrying a silhouette and a cached ring — the live
 * selection, or one that is fading out. The ring holds a constant thickness on
 * screen, so it is rebuilt whenever the zoom changes; panning leaves it alone,
 * and each holder caches its own so the two never rebuild each other's.
 */
function drawSelectionRing(ctx, holder, alpha) {
  if (!holder.silhouette || alpha <= 0) return;
  if (holder.outline?.builtFor !== view.scale) holder.outline = buildOutline(holder.silhouette, view.scale);
  const o = holder.outline;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(o.canvas, o.x * view.scale + view.x, o.y * view.scale + view.y, o.w * view.scale, o.h * view.scale);
  ctx.restore();
}

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

  // Everything is drawn once per visible copy of the map. The map itself takes
  // the copy's own left edge; the layers over it are simpler to shift with a
  // translate, since they all position themselves from view.x already.
  const offsets = wrapOffsets(cssW);
  debug.tilesDrawn = 0;
  for (const dx of offsets) drawMapLayer(ctx, cssW, cssH, view.x + dx);

  for (const dx of offsets) {
    ctx.save();
    ctx.translate(dx, 0);

    drawSelectionRing(ctx, state, 1);
    if (state.fade) drawSelectionRing(ctx, state.fade, fadeStrength());

    // Country names first, then cities over them. A country name is a huge,
    // sparse thing spread across a whole territory and can afford to be crossed;
    // a city name is small and pinned to one point, and is unreadable the moment
    // anything lands on it. Where the two meet, the city has to win.
    // Collected only when there are city names to keep off them. Zoomed out
    // there are dozens of country names on screen and no city names at all, and
    // measuring every glyph of them for nobody is work worth not doing.
    const wantBoxes = state.showCities && state.showLabels && state.world.labels
      && (cityFade(F_CITY_NAME) > 0.004 || cityFade(F_CAPITAL_NAME) > 0.004);
    const labelBoxes = wantBoxes ? [] : null;

    if (state.showLabels && state.world.labels) drawLabels(ctx, state.world.labels, cssW, cssH, dx, labelBoxes);
    if (state.showCities) drawCities(ctx, cssW, cssH, dx, labelBoxes);
    drawOverlays(ctx, cssW, cssH, dx);
    ctx.restore();
  }
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


/* --------------------------------------------------------------- cities
 *
 * Two rules, and nothing else:
 *
 *   1. A THRESHOLD decides whether a thing is on the map. Zoom is at or past
 *      it, the thing belongs; below it, it does not.
 *   2. When that answer changes, its opacity TRANSITIONS between 0 and 1 over a
 *      fixed number of milliseconds. The transition knows nothing about zoom.
 *
 * There are four of them — city icons, capital icons, city names, capital names
 * — each with its own threshold and its own opacity, and all four run the same
 * code. Icons are drawn at a fixed size on screen, not scaled with the map: a
 * city is a point, and a dot that grew to fill a province would read as a region.
 */

const CITY_AT = 1.30;               // zoom at or above which each is on the map
const CAPITAL_AT = 0.50;
const CITY_NAME_AT = 2.25;
const CAPITAL_NAME_AT = 1.30;
const CITY_FADE_MS = 150;           // how long the transition takes, always

const CITY_ICON_PX = 11;            // on-screen height of an ordinary city
const CAPITAL_ICON_PX = 16;         // and of a capital
const CITY_NAME_PX = 12;            // name sizes, likewise fixed on screen
const CAPITAL_NAME_PX = 13;
const CITY_NAME_GAP = 3;            // clearance between an icon and its name
const CITY_NAME_PAD = 2;            // breathing room when testing for overlaps

// Deliberately the inverse of the polity labels: light text on a dark halo,
// where a country name is dark text on a light one. Two kinds of name on the
// same map should not look like the same kind of thing, and reversing the
// contrast separates them at a glance without another colour or another font.
const CITY_NAME_COLOUR = LABEL_OUTLINE;
const CITY_NAME_OUTLINE = LABEL_COLOUR;

// Index into the four opacities below. Order: icons then names, ordinary then
// capital, which is also the order they are drawn in.
const F_CITY = 0, F_CAPITAL = 1, F_CITY_NAME = 2, F_CAPITAL_NAME = 3;
const CITY_THRESHOLDS = [CITY_AT, CAPITAL_AT, CITY_NAME_AT, CAPITAL_NAME_AT];

const cityAlpha = [0, 0, 0, 0];
let cityClock = null;

/**
 * Moves each opacity towards where its threshold says it should be.
 *
 * `now` is a wall-clock reading taken once at the top of the frame, so the
 * transition advances by real elapsed time. Timing it off anything measured
 * around the drawing would run it slow exactly when drawing is slow, which is
 * while you are scrolling. Returns true while any of them is still moving.
 */
function stepCityFades(now) {
  // On the first call there is no previous reading, so a full step is used and
  // everything snaps to where it belongs rather than fading up from nothing.
  const step = cityClock === null ? 1 : (now - cityClock) / CITY_FADE_MS;
  cityClock = now;

  let moving = false;
  for (let i = 0; i < 4; i++) {
    const want = view.scale >= CITY_THRESHOLDS[i] ? 1 : 0;
    if (cityAlpha[i] === want) continue;
    cityAlpha[i] = want > cityAlpha[i]
      ? Math.min(want, cityAlpha[i] + step)
      : Math.max(want, cityAlpha[i] - step);
    moving = true;
  }
  return moving;
}

/** Eased, so a transition starts and ends softly rather than stopping dead. */
const cityFade = (i) => smoothstep(0, 1, cityAlpha[i]);

/**
 * Where a name may sit relative to its icon, best first: below the dot reads
 * most naturally, then above, then out to one side, and the diagonals only when
 * nothing straight will do. Each returns the centre of the name box.
 */
const CITY_NAME_SPOTS = [
  (w, h, half, px) => [0, h / 2 + CITY_NAME_GAP + px / 2],
  (w, h, half, px) => [0, -(h / 2 + CITY_NAME_GAP + px / 2)],
  (w, h, half) => [w / 2 + CITY_NAME_GAP + half, 0],
  (w, h, half) => [-(w / 2 + CITY_NAME_GAP + half), 0],
  (w, h, half) => [w / 2 + CITY_NAME_GAP + half, h / 2 + CITY_NAME_GAP],
  (w, h, half) => [-(w / 2 + CITY_NAME_GAP + half), h / 2 + CITY_NAME_GAP],
  (w, h, half) => [w / 2 + CITY_NAME_GAP + half, -(h / 2 + CITY_NAME_GAP)],
  (w, h, half) => [-(w / 2 + CITY_NAME_GAP + half), -(h / 2 + CITY_NAME_GAP)],
];

function drawCities(ctx, cssW, cssH, dx, labelBoxes = null) {
  const { cities, cityIcons } = state.world;
  if (!cities?.length) return;

  const iconA = [cityFade(F_CITY), cityFade(F_CAPITAL)];
  const nameA = [cityFade(F_CITY_NAME), cityFade(F_CAPITAL_NAME)];
  if (iconA[0] <= 0.004 && iconA[1] <= 0.004) return;

  const hits = (b, p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1];

  // Two kinds of obstacle, and they are not obeyed equally.
  //
  // HARD: the dots and the names already placed. A city can always be moved off
  // one of these, because the thing it is colliding with was itself placed by
  // this same pass and the map has room.
  //
  // SOFT: the letters of the country names underneath. A city sits where its
  // city is, and if a country name happens to run straight through that spot
  // then no amount of shuffling will help. Insisting would mean a city with no
  // name at all, which is a worse outcome than a name crossing a letter — a
  // country name is long and can spare one, while a city name is the only thing
  // identifying the dot it belongs to.
  const placed = [];
  const free = (b, own) => !placed.some((p) => p !== own && hits(b, p));
  const clearOfNames = (b) => !labelBoxes || !labelBoxes.some((g) => boxHitsGlyph(b, g));

  // How badly a spot sits on the country names, for when none of them is clear.
  // Counted in letters covered, so the least bad spot can be chosen rather than
  // simply falling back to the first one on the list.
  const namesHit = (b) => (labelBoxes ? labelBoxes.reduce((n, g) => n + (boxHitsGlyph(b, g) ? 1 : 0), 0) : 0);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  // Pass one: every icon, and every icon's box reserved. Reserving them all
  // before placing any name is what stops a name being put where a city drawn
  // later is about to appear.
  const named = [];
  for (const c of cities) {
    const k = c.capital ? 1 : 0;
    const icon = c.capital ? cityIcons.capital : cityIcons.city;
    if (!icon || iconA[k] <= 0.004) continue;

    // Positions are in this copy's own space, because the caller has already
    // translated the context by dx for it. Only the off-screen test adds dx
    // back, since that one question is about the window and not about the copy.
    const sx = c.x * view.scale + view.x;
    const sy = c.y * view.scale + view.y;
    if (sx + dx < -80 || sy < -80 || sx + dx > cssW + 80 || sy > cssH + 80) continue;

    const h = c.capital ? CAPITAL_ICON_PX : CITY_ICON_PX;
    const w = Math.round(h * (icon.width / icon.height));
    ctx.globalAlpha = iconA[k];
    ctx.drawImage(icon, Math.round(sx - w / 2), Math.round(sy - h / 2), w, Math.round(h));

    const own = [sx - w / 2 - CITY_NAME_PAD, sy - h / 2 - CITY_NAME_PAD,
    sx + w / 2 + CITY_NAME_PAD, sy + h / 2 + CITY_NAME_PAD];
    placed.push(own);
    if (nameA[k] > 0.004 && c.name) named.push({ c, k, sx, sy, w, h, own });
  }

  // Pass two: the names. Capitals first, so where two want the same space the
  // more important one gets it.
  named.sort((a, b) => (b.c.capital ? 1 : 0) - (a.c.capital ? 1 : 0));

  for (const { c, k, sx, sy, w, h, own } of named) {
    const px = c.capital ? CAPITAL_NAME_PX : CITY_NAME_PX;
    ctx.font = labelFont(px);
    const half = ctx.measureText(c.name).width / 2;

    // Every spot that clears the dots and the names already placed, in order of
    // preference. That much is not negotiable; the country names below are.
    const open = [];
    for (const spot of CITY_NAME_SPOTS) {
      const [ox, oy] = spot(w, h, half, px);
      const cx = sx + ox, cy = sy + oy;
      const b = [cx - half - CITY_NAME_PAD, cy - px / 2 - CITY_NAME_PAD,
      cx + half + CITY_NAME_PAD, cy + px / 2 + CITY_NAME_PAD];
      if (!free(b, own)) continue;
      b.cx = cx;
      b.cy = cy;
      open.push(b);
    }
    if (!open.length) continue;    // hemmed in by other cities; the dot stands alone

    // The first spot that also clears the country names, or failing that the one
    // that covers the fewest letters of them. Taking the first open spot instead
    // would put the name in its default position over a name it could have
    // half-missed, which looks like the placement never tried.
    let box = open.find((b) => clearOfNames(b));
    if (!box) {
      let worst = Infinity;
      for (const b of open) {
        const n = namesHit(b);
        if (n < worst) { worst = n; box = b; }
      }
    }
    placed.push(box);

    ctx.globalAlpha = nameA[k];
    ctx.lineWidth = px * LABEL_OUTLINE_WIDTH;
    ctx.strokeStyle = `rgba(${CITY_NAME_OUTLINE},${LABEL_OUTLINE_ALPHA})`;
    ctx.fillStyle = `rgba(${CITY_NAME_COLOUR},${LABEL_COLOUR_OPACITY})`;
    ctx.strokeText(c.name, Math.round(box.cx), Math.round(box.cy));
    ctx.fillText(c.name, Math.round(box.cx), Math.round(box.cy));
  }
  ctx.restore();
}


function drawOverlays(ctx, cssW, cssH, dx) {
  if (state.showCoastal) drawCoastalFlags(ctx, cssW, cssH, dx);
  if (state.showProvinceNames) drawProvinceNames(ctx, cssW, cssH, dx);
  if (state.showAdjacency) drawAdjacency(ctx);
  if (state.showBounds) drawSelectionBounds(ctx);
  if (state.showChunks) drawChunkGrid(ctx, cssW, cssH, dx);
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
function drawProvinceNames(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  ctx.save();
  overlayText(ctx);
  let drawn = 0;
  for (const [id, bb] of w.bounds) {
    if ((bb.maxX - bb.minX + 1) * s < NAME_MIN_PX) continue;      // too small to read
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x + dx < -120 || y < -20 || x + dx > cssW + 120 || y > cssH + 20) continue;   // off screen
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
function drawChunkGrid(ctx, cssW, cssH, dx) {
  if (!tiles) return;
  const s = view.scale;
  const usingTiles = s > overview.scale;

  // Which chunks drawMapLayer() used for THIS copy of the map, by the same
  // visible-rect test — so the lit chunks match what is actually drawn here
  // rather than what is drawn in the copy at the origin.
  const inUse = new Set();
  if (usingTiles) {
    const vx = view.x + dx;
    const sx0 = clamp(Math.floor(-vx / s), 0, state.world.width);
    const sy0 = clamp(Math.floor(-view.y / s), 0, state.world.height);
    const sx1 = clamp(Math.ceil((cssW - vx) / s), 0, state.world.width);
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
    if (x1 + dx < 0 || y1 < 0 || x + dx > cssW || y > cssH) continue;

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
function drawCoastalFlags(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(120,200,225,.85)';
  for (const id of w.coastal) {
    const bb = w.bounds.get(id);
    if (!bb) continue;
    const x = bb.cx * s + view.x, y = bb.cy * s + view.y;
    if (x + dx < 0 || y < 0 || x + dx > cssW || y > cssH) continue;
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
  fade: null,             // a dropped selection still fading out; see select()

  // Overlay switches. Each is driven by a button in the debug menu carrying a
  // matching data-toggle, so adding one is a line of HTML and a draw call.
  satellite: false,       // imagery under the province colours; set true if it loads
  showCities: true,
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
 * averages because a single frame's number is too noisy to read.
 *
 * Note that the frame figure is stored as an INTERVAL in milliseconds and only
 * turned into a rate when it is displayed. Averaging rates instead is what the
 * meter used to do, and it does not work: rAF sometimes delivers two callbacks
 * inside one display refresh, gaps of well under a millisecond having been
 * measured here. A rate is the reciprocal of the gap, so a short gap does not
 * merely nudge the average — a 0.3ms one reads as 3300fps and drags it up by
 * hundreds, while a long gap can only ever pull it down towards zero. The
 * reading has nowhere to go but up. And a gap that rounds to exactly zero gives
 * Infinity, which a running average can never leave: 0.9 x Infinity is still
 * Infinity, so the meter stays pinned there for the rest of the session.
 * Averaging the interval keeps a short frame worth no more than a short frame. */
const perf = { frameMs: 0, draw: 0, paint: 0, fullRepaints: 0, partRepaints: 0, lastFrame: 0, load: null };
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

    // City transitions run on a clock, so they need a tick and a redraw for as
    // long as one is still going.
    // City transitions run on a clock, so they get a tick and a redraw for as
    // long as one is going. Read at the top of the frame, before any drawing.
    if (stepCityFades(performance.now()) && state.showCities) viewDirty = true;

    // A dropped selection is animating, so its provinces need repainting every
    // frame until it is gone. Only those provinces — a handful of small boxes —
    // which is what makes animating a baked-in highlight affordable at all.
    if (state.fade) {
      invalidateProvinces(state.fade.id, ...state.fade.neighbours);
      // Cleared before the repaint below, so the last pass draws them plain.
      if (fadeStrength() <= 0) state.fade = null;
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
    if (perf.lastFrame) perf.frameMs = ease(perf.frameMs, now - perf.lastFrame);
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

  // Wrapped east-west, so a click on any copy of the map lands on the same
  // province. Vertically there is no wrapping and off-map is simply nothing.
  const px = ((Math.floor(x) % w.width) + w.width) % w.width;
  const py = Math.floor(y);
  if (py < 0 || py >= w.height) return null;

  const index = w.provinceAt[py * w.width + px];
  return index === OCEAN ? null : w.atIndex[index].id;
}

/**
 * How much of a dropped selection's highlight is still showing, 1 down to 0.
 *
 * Smoothstepped rather than linear, so it leaves at once and settles gently
 * instead of stopping dead at the end of its time.
 */
function fadeStrength() {
  if (!state.fade) return 0;
  const t = (performance.now() - state.fade.t0) / DESELECT_FADE_MS;
  if (t >= 1) return 0;
  const k = 1 - t;
  return k * k * (3 - 2 * k);
}

/** Selects a province, or clears the selection when `id` is null. */
function select(id) {
  const was = state.selected;
  if (was === id) return;                 // nothing to do, and no fade to start
  state.selected = id;

  // Exactly two groups change shade: what was highlighted before, and what is
  // highlighted now — each being a province plus its neighbours. Repainting just
  // those is what keeps selecting instant on a large map.
  invalidateProvinces(was, id);
  for (const q of neighboursOf(was)) invalidateProvinces(q);
  for (const q of neighboursOf(id)) invalidateProvinces(q);

  // Hand what was selected over to the fade, along with its traced shape so the
  // ring can keep being drawn while it dies away. Its neighbour set is copied
  // now because the fade outlives the selection that defined it.
  state.fade = was
    ? { id: was, neighbours: new Set(neighboursOf(was)), silhouette: state.silhouette, outline: null, t0: performance.now() }
    : null;

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

// Bumped whenever this file is edited, and shown in the debug menu. If what is
// on screen does not match what is in the file, this is how you find out.
const BUILD = 'arc-spacing';

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
    statRow('Build', BUILD) +
    statRow('Frame', `${perf.frameMs ? (1000 / perf.frameMs).toFixed(0) : 0} fps`, perf.frameMs > 22) +
    statRow('Blit', `${perf.draw.toFixed(2)} ms`, perf.draw > 8) +
    statRow('Last paint', `${perf.paint.toFixed(2)} ms`, perf.paint > 16) +
    // The single number that decides whether a frame can be delivered on time.
    // Everything above is JavaScript, and it is now small; what costs the rest is
    // the browser rasterising and compositing a surface of this many pixels every
    // frame. Display scaling counts twice over — 150% is 2.25x the area.
    statRow('Canvas', `${els.canvas.width} &times; ${els.canvas.height}`
      + ` (${(els.canvas.width * els.canvas.height / 1e6).toFixed(1)}M px @ ${(window.devicePixelRatio || 1)}x)`,
      els.canvas.width * els.canvas.height > 5e6) +
    statRow('Repaints', `${perf.fullRepaints} full / ${perf.partRepaints} part`) +
    statRow('Drawing from', drawing) +
    statRow('Chunks drawn', visible) +
    statRow('Zoom', `${view.scale.toFixed(2)}  (${Math.round(view.scale * 100)}%)`) +
    statRow('City icons', `${cityFade(F_CITY).toFixed(2)} @ ${CITY_AT}`) +
    statRow('Capital icons', `${cityFade(F_CAPITAL).toFixed(2)} @ ${CAPITAL_AT}`) +
    statRow('City names', `${cityFade(F_CITY_NAME).toFixed(2)} @ ${CITY_NAME_AT}`) +
    statRow('Capital names', `${cityFade(F_CAPITAL_NAME).toFixed(2)} @ ${CAPITAL_NAME_AT}`) +
    statRow('Load', `${perf.load.ms.toFixed(0)} ms ${perf.load.cached ? '(cached)' : '(computed)'}`, !perf.load.cached) +
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
    statRow('Cities', w.cities.length
      ? `${w.cities.length} (${w.cities.filter((c) => c.capital).length} capital)`
      : 'none', !w.cities.length) +
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

  // The imagery is optional, so its switch reflects whether there is any.
  const sat = document.getElementById('toggle-satellite');
  sat.disabled = !state.world.satellite;
  sat.classList.toggle('active', state.satellite);

  // Every debug switch, from one listener. A button's data-toggle names the
  // field in `state` it drives, so a new one needs no wiring of its own — add
  // the button, add the field, and draw it in drawOverlays().
  els.toggles.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-toggle]');
    if (!b || b.disabled) return;
    const key = b.dataset.toggle;
    state[key] = !state[key];
    b.classList.toggle('active', state[key]);

    // Overlays draw over the finished map, so they only need another blit. A
    // switch marked data-repaint changes the painted map itself and needs the
    // tiles rebuilt, which is far more expensive — hence the distinction.
    if (b.hasAttribute('data-repaint')) invalidateBuffer();
    else invalidateView();
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === '+' || ev.key === '=') zoomCentre(1.4);
    else if (ev.key === '-' || ev.key === '_') zoomCentre(1 / 1.4);
    else if (ev.key === '0') fitToView();
    else if (ev.key === '`') togglePanel();
    // select(null) already clears the highlight, the ring and the panel, and
    // repaints only what was lit — the same path as clicking open sea.
    else if (ev.key === 'Escape' && state.selected) select(null);
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

  // Catch a reload before it happens, since it throws away the view and costs a
  // second of loading to get back.
  //
  // Three things about this are the browser's call and not ours:
  //
  //   - THE WORDING. Every browser shows its own sentence and none of them can
  //     be replaced; returnValue is set only because the older ones need
  //     something non-empty there to treat the event as a refusal at all.
  //   - WHICH ACTION. Reloading, closing the tab and navigating away are one
  //     event, so a prompt on reload means a prompt on all three.
  //   - WHETHER IT APPEARS AT ALL. It is ignored until the page has been
  //     interacted with, which stops a page nobody has touched from trapping
  //     anyone. Pressing Enter on the start menu satisfies that.
  //
  // Only armed once the menu is gone: reloading while it is still up loses
  // nothing anyone would miss, and being asked to confirm before the game has
  // even started is just an obstacle.
  window.addEventListener('beforeunload', (ev) => {
    if (document.getElementById('start')?.classList.contains('gone') !== true) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  // No resize listener or ResizeObserver here on purpose: frame() compares the
  // canvas box against its pixel buffer on every tick, which catches window
  // resizes and the panel slide alike, and does it in time to draw that frame.
}

// ==================================================================== 8. boot

/**
 * Loads the data, builds the model, and starts the render loop.
 *
 * Order matters here: buildWorld() needs the normalised table, buildLabels()
 * needs the adjacency buildWorld() derives, and fitToView() needs the map's size
 * to know what to fit to.
 */
async function init() {
  const t0 = performance.now();

  // All four fetched together. The imagery is by far the largest, and waiting
  // for it after the others would add its whole download to the load time.
  const [raw, pngBytes, cacheBytes, satellite, cities, cityIcon, capitalIcon] = await Promise.all([
    loadJSON('./data/provinces.json'),
    loadBytes('./data/provinces.png'),
    loadBytes(`./data/${CACHE_FILE}`, true),
    loadBitmap('./data/satellite.png'),
    // Extracted from cities.png by the build step, so the page reads a few
    // kilobytes of JSON rather than decoding a second full-size bitmap.
    loadJSON('./data/cities.json', true),
    loadBitmap('./data/icons/city.png'),
    loadBitmap('./data/icons/capital.png'),
  ]);

  // Hashed before normaliseTable(), which rewrites the colours in place — the
  // build script hashes the same fields in the same form.
  const hash = hashInputs(pngBytes, raw);
  const cache = await loadCache(cacheBytes, hash);
  const table = normaliseTable(raw);

  let world, geometry;
  const restored = cache && worldFromCache(table, cache, indexProvinces);
  if (restored) {
    ({ world, geometry } = restored);
  } else {
    // No usable cache, so derive it all: a colour lookup per pixel, an adjacency
    // scan, a distance transform, and two more passes for the label geometry.
    world = buildWorld(table, await loadPixels(pngBytes));
    world.borderDist = buildBorderDistance(world);
    geometry = computeLabelGeometry(world);
  }

  world.satellite = satellite;
  world.cities = cities?.cities ?? [];
  world.cityIcons = { city: cityIcon, capital: capitalIcon };

  // Finishing the labels needs to measure real text, so it always happens here.
  world.labels = buildLabels(world, geometry);
  state.world = world;
  state.satellite = !!satellite;
  perf.load = { ms: performance.now() - t0, cached: !!restored };

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

  // Draw the map once here rather than leaving it to the first animation frame,
  // and only then arm the button. That first pass is a full repaint of all 15.9
  // million pixels — around 250ms — so run after the button goes live it lands
  // as a quarter-second freeze on the click itself. Run before, it happens
  // while the menu still says "Loading", where a wait is what it is claiming.
  // frame() re-arms itself on the way out, so this starts the loop too.
  frame();
  openStartMenu();
}

/**
 * Arms the start menu, which has been on screen since the page loaded.
 *
 * Called at the end of init() rather than the beginning, so the button cannot be
 * pressed until there is a map behind it — the alternative is dismissing the
 * menu onto a blank canvas while the bitmap is still being read.
 */
function openStartMenu() {
  const menu = document.getElementById('start');
  const enter = document.getElementById('start-enter');
  if (!menu || !enter) return;

  enter.disabled = false;
  enter.textContent = 'Enter';
  enter.focus();

  const dismiss = () => {
    menu.classList.add('gone');
    els.canvas.focus?.();
  };
  enter.addEventListener('click', dismiss);

  // Enter and Escape both work, but only while the menu is up — afterwards
  // Escape belongs to clearing the selection.
  window.addEventListener('keydown', (ev) => {
    if (menu.classList.contains('gone')) return;
    if (ev.key === 'Enter' || ev.key === 'Escape' || ev.key === ' ') {
      ev.preventDefault();
      dismiss();
    }
  });
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
