// Map tiles, the night mask, province shading and repainting.

const VERSION = new URL(import.meta.url).search;
const { mapLatAt, mapLonAt, solarDeclination, subsolarLongitude } = await import(`../world/geo.js${VERSION}`);
const { CHAMFER_ORTH, OCEAN, frontierKeyOf, isOccupied } = await import(`../world/mapdata.js${VERSION}`);
const { ease, els, perf, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let BORDER_INTERNAL, BORDER_NATIONAL, COUNTY_EDGE, COUNTY_MIX, COUNTY_PROVINCE, COUNTY_WASH, FADE_CURVE, FADE_PX, IMPASSABLE, IMPASSABLE_COLOUR, IMPASSABLE_MIX, LIGHTEN, MODES, NAVY_EDGE, NAVY_LAKE_ARC, NAVY_LAKE_LIGHT, NAVY_LAND, NAVY_LIGHT, NAVY_LIGHTEN, NAVY_LIGHT_SPREAD, NAVY_SAT, NAVY_SEA_ARC, NAVY_SUB_EDGE, NAVY_SUB_SPREAD, PASTEL_MIX, PASTEL_TOWARD, SATELLITE_CORE, SATELLITE_FLAT, SATELLITE_INTERNAL, SATELLITE_LIFT, SATELLITE_NATIONAL, SATELLITE_RIM, fadeStrength, view, visibleRect, wrapOffsets;
export function link(all) { ({ BORDER_INTERNAL, BORDER_NATIONAL, COUNTY_EDGE, COUNTY_MIX, COUNTY_PROVINCE, COUNTY_WASH, FADE_CURVE, FADE_PX, IMPASSABLE, IMPASSABLE_COLOUR, IMPASSABLE_MIX, LIGHTEN, MODES, NAVY_EDGE, NAVY_LAKE_ARC, NAVY_LAKE_LIGHT, NAVY_LAND, NAVY_LIGHT, NAVY_LIGHTEN, NAVY_LIGHT_SPREAD, NAVY_SAT, NAVY_SEA_ARC, NAVY_SUB_EDGE, NAVY_SUB_SPREAD, PASTEL_MIX, PASTEL_TOWARD, SATELLITE_CORE, SATELLITE_FLAT, SATELLITE_INTERNAL, SATELLITE_LIFT, SATELLITE_NATIONAL, SATELLITE_RIM, fadeStrength, view, visibleRect, wrapOffsets } = all); }

// Tiled offscreen buffer and downscaled overview.
const TILE = 512;             // chunk edge, in map pixels
// Longest edge of the zoomed-out overview, in pixels.
const OVERVIEW_MAX = 3072;

// Maximum stretch of the overview before switching to tiles.
const OVERVIEW_STRETCH = 1.25;

// Whether the overview is the cheaper source at this scale.
const overviewCovers = (s) => !!live.overview && s <= live.overview.scale * OVERVIEW_STRETCH;

live.tiles = null;             // { cols, rows, list: [{ x, y, w, h, canvas, ctx }] }
live.overview = null;          // { canvas, ctx, scale }
let scratch = null;
let scratchCanvas = null;
let scratchCtx = null;
// Window-sized offscreen layers, reused between frames.
const scratchLayers = new Map();

function viewportLayer(name, cssW, cssH, scale = 1) {
  const pw = Math.max(1, Math.round(cssW * live.pixelRatio * scale));
  const ph = Math.max(1, Math.round(cssH * live.pixelRatio * scale));

  let layer = scratchLayers.get(name);
  if (!layer) {
    const canvas = document.createElement('canvas');
    layer = { canvas, ctx: canvas.getContext('2d'), w: 0, h: 0 };
    scratchLayers.set(name, layer);
  }

  if (layer.canvas.width !== pw || layer.canvas.height !== ph) {
    layer.canvas.width = pw;
    layer.canvas.height = ph;
  }
  layer.w = pw;
  layer.h = ph;

  layer.ctx.setTransform(live.pixelRatio * scale, 0, 0, live.pixelRatio * scale, 0, 0);
  layer.ctx.globalCompositeOperation = 'source-over';
  layer.ctx.clearRect(0, 0, cssW, cssH);
  return layer;
}

// Day and night: terminator mask drawn over the map each frame.

const NIGHT_MASK_SCALE = 1 / 8;

// City lights compositing resolution, as a fraction of the window.
const NIGHT_LIGHT_SCALE = 0.5;

// Minimum interval between terminator redraws, in milliseconds.
const NIGHT_MIN_MS = 66;
live.nightDrawnAt = 0;
const NIGHT_DAY_START = Math.sin((6 * Math.PI) / 180);    // full daylight above this elevation
const NIGHT_FULL_DARK = Math.sin((-12 * Math.PI) / 180);  // and full night below this one

// Sun position: day of year and UTC hour, set by the clock.
live.sunDayOfYear = 161;
live.sunUtcHour = 0;

// Eastward shift of the night mask for the current hour, in map pixels.
function sunShiftPx(world) {
  const lon = subsolarLongitude(live.sunUtcHour, world.width);
  const px = (lon * world.width) / (Math.PI * 2);
  return ((px % world.width) + world.width) % world.width;
}

// Night darkening and city light strength.
const NIGHT_DARKEN = 0.28;
const NIGHT_LIGHTS = 0.55;

// Night mask canvas, pixel buffer and trigonometry tables.
let nightMask = null;

// Night mask: black, with alpha giving how much night it is.
function buildNightMask(world, dayOfYear) {
  const w = Math.ceil(world.width * NIGHT_MASK_SCALE);
  const h = Math.ceil(world.height * NIGHT_MASK_SCALE);

  const cw = w + 2;

  if (!nightMask || nightMask.canvas.width !== cw || nightMask.canvas.height !== h) {
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    const cosLon = new Float64Array(w);
    for (let x = 0; x < w; x++) cosLon[x] = Math.cos(mapLonAt(x / NIGHT_MASK_SCALE, world.width));

    const sinLat = new Float64Array(h);
    const cosLat = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      const lat = mapLatAt(y / NIGHT_MASK_SCALE);
      sinLat[y] = Math.sin(lat);
      cosLat[y] = Math.cos(lat);
    }

    nightMask = {
      canvas, ctx, img: ctx.createImageData(cw, h),
      cosLon, sinLat, cosLat, bleed: 1, period: w,
      scale: NIGHT_MASK_SCALE, dayOfYear: null,
      strip: null, stripCtx: null, reps: 0, stripDay: null,
    };
  }

  const { img, cosLon, sinLat, cosLat } = nightMask;
  const data = img.data;
  const dec = solarDeclination(dayOfYear);
  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  const span = NIGHT_DAY_START - NIGHT_FULL_DARK;

  for (let y = 0; y < h; y++) {
    const a = sinLat[y] * sinDec;
    const b = cosLat[y] * cosDec;
    const row = y * cw;
    let o = (row + 1) * 4 + 3;                                // column 0 is bleed
    for (let x = 0; x < w; x++, o += 4) {
      let t = (a + b * cosLon[x] - NIGHT_FULL_DARK) / span;   // 0 night, 1 day
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = t * t * (3 - 2 * t);                                // ease the twilight band
      data[o] = Math.round(255 * (1 - t));
    }
    data[row * 4 + 3] = data[(row + w) * 4 + 3];
    data[(row + cw - 1) * 4 + 3] = data[(row + 1) * 4 + 3];
  }

  nightMask.ctx.putImageData(img, 0, 0);
  nightMask.dayOfYear = dayOfYear;
  perf.maskBuilds++;
  return nightMask;
}

// Builds the tile grid and the overview. Once per world.
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
  live.tiles = { cols, rows, list };
  scratch = list[0].ctx.createImageData(TILE, TILE);
  scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = TILE;
  scratchCanvas.height = TILE;
  scratchCtx = scratchCanvas.getContext('2d');

  // Overview scale puts each tile on whole overview pixels.
  const wanted = Math.min(1, OVERVIEW_MAX / Math.max(world.width, world.height));
  const tileDest = Math.max(1, Math.round(TILE * wanted));
  const scale = tileDest / TILE;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(world.width * scale));
  canvas.height = Math.max(1, Math.ceil(world.height * scale));
  live.overview = { canvas, ctx: canvas.getContext('2d'), scale };

  // Fills the overview with ocean colour.
  live.overview.ctx.fillStyle = `rgb(${world.table.oceanColour})`;
  live.overview.ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Every tile overlapping the half-open map rect [x0,x1) by [y0,y1).
function tilesOver(x0, y0, x1, y1) {
  const out = [];
  const c0 = Math.max(0, Math.floor(x0 / TILE));
  const c1 = Math.min(live.tiles.cols - 1, Math.floor((x1 - 1) / TILE));
  const r0 = Math.max(0, Math.floor(y0 / TILE));
  const r1 = Math.min(live.tiles.rows - 1, Math.floor((y1 - 1) / TILE));
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push(live.tiles.list[r * live.tiles.cols + c]);
  }
  return out;
}

// Precomputes every province shade as flat [r,g,b] arrays.
// Highlight size ceiling and occupation stripe pattern.
const STRIPE_PERIOD = 14;
const STRIPE_WIDTH = 3;

const HIGHLIGHT_MAX_PX = 4e6;      // bounding-box pixels, about a quarter of the map

// Time per frame allowed for repainting chunks.
const REPAINT_BUDGET_MS = 6;

// True when lighting this province would cost more than a frame can spare.
function tooBigToLight(world, id) {
  return tooBigToLightBox(id && world.bounds.get(id));
}

// The size ceiling, on a bounding box.
function tooBigToLightBox(bb) {
  if (!bb) return false;
  return (bb.maxX - bb.minX + 1) * (bb.maxY - bb.minY + 1) > HIGHLIGHT_MAX_PX;
}

// Sea region fill and border colours for the Navy mode.
// Hue in degrees and lightness in 0..1.
function hueLightness([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d + (G < B ? 6 : 0));
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
  }
  return [h, (max + min) / 2];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

const navyColour = (r) => {
  const [h, l] = hueLightness(r.colour);
  const [lo, hi] = r.lake ? NAVY_LAKE_ARC : NAVY_SEA_ARC;
  const base = r.lake ? NAVY_LAKE_LIGHT : NAVY_LIGHT;
  const rgb = hslToRgb(lo + (h / 360) * (hi - lo), NAVY_SAT,
    base + (l - 0.5) * NAVY_LIGHT_SPREAD);

  // Darkens impassable water toward near-black.
  if (!r.tags.includes(IMPASSABLE)) return rgb;
  return rgb.map((v, c) => Math.round(v + (IMPASSABLE_COLOUR[c] - v) * IMPASSABLE_MIX));
};

// County fill and border colours, cached by highlighted province.
let countyShade = { counties: null, province: undefined, base: null, edge: null };

function countyShadeTable(counties, selectedProvince) {
  if (countyShade.counties === counties && countyShade.province === selectedProvince) {
    return countyShade;
  }
  const n = counties.atIndex.length;
  const base = countyShade.base && countyShade.base.length === n * 3
    ? countyShade.base : new Uint8Array(n * 3);
  const edge = countyShade.edge && countyShade.edge.length === n * 3
    ? countyShade.edge : new Uint8Array(n * 3);

  for (let ix = 1; ix < n; ix++) {
    const c = counties.atIndex[ix];
    const lit = c.province === selectedProvince ? LIGHTEN.selected : 0;
    for (let k = 0; k < 3; k++) {
      let v = c.colour[k] + (COUNTY_WASH[k] - c.colour[k]) * COUNTY_MIX;
      v += (255 - v) * lit;
      base[ix * 3 + k] = Math.round(v);
      edge[ix * 3 + k] = Math.round(v * COUNTY_EDGE);
    }
  }
  countyShade = { counties, province: selectedProvince, base, edge };
  return countyShade;
}

// Provinces whose counties are held by more than one side.
let splitShade = { counties: null, value: null };

function splitGround(world) {
  const { counties } = world;
  if (!counties) return null;
  if (splitShade.counties === counties) return splitShade.value;

  const n = world.atIndex.length;
  const m = counties.atIndex.length;
  const provinceOf = (c) => world.byId.get(c.province);

  const first = new Array(n);
  const mixed = new Uint8Array(n);
  for (let ci = 1; ci < m; ci++) {
    const c = counties.atIndex[ci];
    const p = provinceOf(c);
    if (!p) continue;
    const who = c.occupier || p.owner;
    if (first[p.index] === undefined) first[p.index] = who;
    else if (first[p.index] !== who) mixed[p.index] = 1;
  }

  const list = [];
  const slotOf = new Int32Array(m);
  const homeOf = new Int32Array(m);
  for (let ci = 1; ci < m; ci++) {
    const c = counties.atIndex[ci];
    const p = provinceOf(c);
    if (!p || !mixed[p.index]) continue;
    slotOf[ci] = n + list.length;
    homeOf[ci] = p.index;
    list.push({ slot: slotOf[ci], county: c, province: p });
  }

  const value = list.length ? { mixed, slotOf, homeOf, countyAt: counties.countyAt, list } : null;
  splitShade = { counties, value };
  return value;
}

// Sea subregion fill and border colours.
function subShadeTable(sea, subs, selected, hovered) {
  const n = subs.atIndex.length;
  const base = new Uint8Array(n * 3);
  const edge = new Uint8Array(n * 3);

  for (let ix = 1; ix < n; ix++) {
    const u = subs.atIndex[ix];
    const region = sea.byId.get(u.region);
    const tone = region ? navyColour(region) : NAVY_LAND;

    const k = Math.imul(ix, 2654435761) >>> 0;
    const wobble = ((k % 2001) / 1000 - 1) * NAVY_SUB_SPREAD;
    const lit = selected === u.id ? NAVY_LIGHTEN.selected
      : hovered === u.id ? NAVY_LIGHTEN.hovered : 0;

    for (let c = 0; c < 3; c++) {
      let v = tone[c] * (1 + wobble);
      v += (255 - v) * lit;
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      base[ix * 3 + c] = Math.round(v);
      edge[ix * 3 + c] = Math.round(v * NAVY_SUB_EDGE);
    }
  }
  return { base, edge };
}

function seaShadeTable(sea, selected, hovered) {
  const n = sea.atIndex.length;
  const base = new Uint8Array(n * 3);
  const edge = new Uint8Array(n * 3);

  for (let ix = 1; ix < n; ix++) {
    const r = sea.atIndex[ix];
    const tone = navyColour(r);

    const big = tooBigToLightBox(sea.bounds.get(r.id));
    const lit = big ? 0
      : selected === r.id ? NAVY_LIGHTEN.selected
        : hovered === r.id ? NAVY_LIGHTEN.hovered : 0;

    for (let c = 0; c < 3; c++) {
      const v = tone[c] + (255 - tone[c]) * lit;
      base[ix * 3 + c] = Math.round(v);
      edge[ix * 3 + c] = Math.round(v * NAVY_EDGE);
    }
  }
  return { base, edge };
}

function shadeTable(world, mode, selected, hovered) {
  const { atIndex } = world;
  const n = atIndex.length;
  const split = mode === 'political' ? splitGround(world) : null;
  const slots = n + (split ? split.list.length : 0);
  const rim = new Uint8Array(slots * 3);      // interior, hard against a frontier
  const core = new Uint8Array(slots * 3);     // interior, deep inland — the pastel wash
  const softRim = new Uint8Array(slots * 3);  // subdivision line, near a frontier
  const softCore = new Uint8Array(slots * 3); // subdivision line, inland
  const hard = new Uint8Array(slots * 3);     // the frontier line itself
  const stripe = new Uint8Array(slots * 3);   // owner's colour for occupation stripes
  const striped = new Uint8Array(slots);
  const neighbours = selected ? world.adjacency.get(selected) : null;
  const colourOf = MODES[mode];

  // Owners as small integers; ocean is -1.
  const ownerAt = new Int32Array(slots).fill(-1);
  const ownerOrdinal = new Map();

  const over = !!(world.satellite && state.satellite && world.borderDist);
  const dropped = state.fade;                 // a selection on its way out, if any
  const k = dropped ? fadeStrength() : 0;     // how much of its highlight is left

  const shaped = over && mode === 'political';
  const navy = mode === 'navy' && !!world.sea;
  const county = mode === 'county' && !!world.counties;
  const lift = new Uint8Array(n);       // extra opacity for a highlighted province
  const mixOf = split ? new Float32Array(n) : null;   // each province's highlight, for its counties

  const tint = (at, c, mix) => {
    for (let ch = 0; ch < 3; ch++) {
      const v = c[ch] + (255 - c[ch]) * mix;
      const pale = v + (PASTEL_TOWARD[ch] - v) * PASTEL_MIX;
      const inland = shaped ? pale : v;
      rim[at * 3 + ch] = v;
      core[at * 3 + ch] = inland;
      softRim[at * 3 + ch] = v * BORDER_INTERNAL;
      softCore[at * 3 + ch] = inland * BORDER_INTERNAL;
      hard[at * 3 + ch] = v * BORDER_NATIONAL;
    }
  };

  const stripeWith = (at, ownerId, mix) => {
    const owner = world.table.polityById.get(ownerId);
    if (!owner) return;
    striped[at] = 1;
    for (let ch = 0; ch < 3; ch++) {
      stripe[at * 3 + ch] = owner.colour[ch] + (255 - owner.colour[ch]) * mix;
    }
  };

  for (let ix = 1; ix < n; ix++) {
    const p = atIndex[ix];
    const key = frontierKeyOf(p);
    if (!ownerOrdinal.has(key)) ownerOrdinal.set(key, ownerOrdinal.size);
    ownerAt[ix] = ownerOrdinal.get(key);

    let role = selected === p.id ? 'selected'
      : neighbours?.has(p.id) ? 'neighbour'
        : hovered === p.id ? 'hovered' : null;

    let strength = 1;
    if (!role && dropped) {
      if (dropped.id === p.id) { role = 'selected'; strength = k; }
      else if (dropped.neighbours.has(p.id)) { role = 'neighbour'; strength = k; }
    }

    if (role && tooBigToLight(world, p.id)) role = null;

    const mix = role ? LIGHTEN[role] * strength : 0;
    if (over && role) lift[ix] = Math.round(255 * SATELLITE_LIFT[role] * strength);
    if (mixOf) mixOf[ix] = mix;

    tint(ix, colourOf(world, p), mix);

    if (mode === 'political' && isOccupied(p)) stripeWith(ix, p.owner, mix);
  }

  if (split) {
    for (const { slot, county, province: p } of split.list) {
      const held = { owner: p.owner, occupier: county.occupier };
      const key = frontierKeyOf(held);
      if (!ownerOrdinal.has(key)) ownerOrdinal.set(key, ownerOrdinal.size);
      ownerAt[slot] = ownerOrdinal.get(key);
      tint(slot, colourOf(world, held), mixOf[p.index]);
      if (held.occupier && held.occupier !== p.owner) stripeWith(slot, p.owner, mixOf[p.index]);
    }
  }

  // Rim-to-core blend by border distance, as a 256-entry table.
  const fade = new Uint8Array(256);
  const span = FADE_PX * CHAMFER_ORTH;
  if (shaped) {
    for (let d = 0; d < 256; d++) fade[d] = Math.round(255 * Math.min(1, d / span) ** FADE_CURVE);
  }

  const flat = over ? Math.round(255 * SATELLITE_FLAT) : 255;
  return {
    rim, core, softRim, softCore, hard, stripe, striped, ownerAt, over, fade, lift, split,

    seaAt: navy ? world.sea.seaAt : null,
    ...(navy ? seaShadeTable(world.sea, state.selectedSea, state.hoveredSea) : {}),

    subAt: navy && world.subs ? world.subs.subAt : null,
    ...(navy && world.subs ? (() => {
      const t = subShadeTable(world.sea, world.subs, state.selectedSub, state.hoveredSub);
      return { subBase: t.base, subEdge: t.edge };
    })() : {}),

    countyAt: county ? world.counties.countyAt : null,
    ...(county ? (() => {
      const t = countyShadeTable(world.counties, selected);
      return { countyBase: t.base, countyEdge: t.edge };
    })() : {}),
    aRim: shaped ? Math.round(255 * SATELLITE_RIM) : flat,
    aCore: shaped ? Math.round(255 * SATELLITE_CORE) : flat,
    aInternal: over ? Math.round(255 * SATELLITE_INTERNAL) : 0,
    aNational: over ? Math.round(255 * SATELLITE_NATIONAL) : 255,
    aSea: !over ? 255 : navy ? Math.round(255 * SATELLITE_FLAT) : 0,
  };
}

// Paints part of one tile and uploads just that part.
function paintTileRegion(world, t, tile, lx0, ly0, lx1, ly1) {
  const { width, height, provinceAt, borderDist } = world;
  const { rim, core, softRim, softCore, hard, stripe, striped, ownerAt, over, fade, lift } = t;
  const { aRim, aCore, aInternal, aNational, aSea } = t;
  const { seaAt, base: seaBase, edge: seaEdge, subAt, subBase, subEdge } = t;
  const { countyAt, countyBase, countyEdge, split } = t;
  const countyAlpha = over ? Math.round(255 * SATELLITE_FLAT) : 255;
  const d = scratch.data;
  const [or_, og, ob] = world.table.oceanColour;

  for (let ly = ly0; ly < ly1; ly++) {
    const y = tile.y + ly;
    let i = y * width + tile.x + lx0;              // index into the map
    let o = (ly * TILE + lx0) * 4;                 // index into the scratch
    for (let lx = lx0; lx < lx1; lx++, i++, o += 4) {
      const index = provinceAt[i];
      if (index === OCEAN) {
        const region = seaAt ? seaAt[i] : 0;
        if (region === 0) {
          d[o] = or_; d[o + 1] = og; d[o + 2] = ob;
          d[o + 3] = aSea;
          continue;
        }

        const sx = tile.x + lx;
        const right = sx + 1 < width ? i + 1 : y * width;
        const below = y + 1 < height ? i + width : i;
        const sRight = seaAt[right];
        const sBelow = y + 1 < height ? seaAt[below] : region;
        const onEdge = (sRight !== region && sRight !== 0)
          || (sBelow !== region && sBelow !== 0);

        const sub = subAt ? subAt[i] : 0;
        if (sub !== 0 && !onEdge) {
          const uRight = subAt[right];
          const uBelow = y + 1 < height ? subAt[below] : sub;
          const subOnEdge = (uRight !== sub && uRight !== 0)
            || (uBelow !== sub && uBelow !== 0);
          const uc = sub * 3;
          const usrc = subOnEdge ? subEdge : subBase;
          d[o] = usrc[uc]; d[o + 1] = usrc[uc + 1]; d[o + 2] = usrc[uc + 2];
          d[o + 3] = aSea;
          continue;
        }

        const sc = region * 3;
        const src = onEdge ? seaEdge : seaBase;
        d[o] = src[sc]; d[o + 1] = src[sc + 1]; d[o + 2] = src[sc + 2];
        d[o + 3] = aSea;
        continue;
      }

      // Edge test: right or below pixel in another province.
      const x = tile.x + lx;
      const ri = x + 1 < width ? i + 1 : y * width;
      const right = provinceAt[ri];
      const below = y + 1 < height ? provinceAt[i + width] : index;
      let at = index;
      let edge = 0;                                // 0 interior, 1 internal edge, 2 national edge
      if (split === null || (split.mixed[index] | split.mixed[right] | split.mixed[below]) === 0) {
        const mine = ownerAt[index];
        if (right !== index) edge = ownerAt[right] === mine ? 1 : 2;
        if (below !== index && edge < 2) edge = Math.max(edge, ownerAt[below] === mine ? 1 : 2);
      } else {
        const { mixed, slotOf, homeOf, countyAt: cAt } = split;
        const slotAt = (j, pj) => (mixed[pj] && homeOf[cAt[j]] === pj ? slotOf[cAt[j]] : pj);
        at = slotAt(i, index);
        const mine = ownerAt[at];
        const edgeTo = (j, pj) => (ownerAt[slotAt(j, pj)] === mine ? (pj === index ? 0 : 1) : 2);
        edge = edgeTo(ri, right);
        if (edge < 2 && y + 1 < height) edge = Math.max(edge, edgeTo(i + width, below));
      }

      const c = at * 3;

      if (countyAt) {
        const ci = countyAt[i];
        if (ci) {
          const cc = ci * 3;
          const cRight = countyAt[x + 1 < width ? i + 1 : y * width];
          const cBelow = y + 1 < height ? countyAt[i + width] : ci;
          const src = cRight !== ci || cBelow !== ci ? countyEdge : countyBase;
          if (edge === 2) {
            d[o] = Math.round(src[cc] * COUNTY_PROVINCE);
            d[o + 1] = Math.round(src[cc + 1] * COUNTY_PROVINCE);
            d[o + 2] = Math.round(src[cc + 2] * COUNTY_PROVINCE);
          } else {
            d[o] = src[cc]; d[o + 1] = src[cc + 1]; d[o + 2] = src[cc + 2];
          }
          d[o + 3] = countyAlpha;
          continue;
        }
      }

      if (edge === 2) {
        d[o] = hard[c]; d[o + 1] = hard[c + 1]; d[o + 2] = hard[c + 2];
        d[o + 3] = aNational;
        continue;
      }

      const f = over ? fade[borderDist[i]] : 0;
      const [near, far] = edge === 1 ? [softRim, softCore] : [rim, core];
      d[o] = near[c] + (((far[c] - near[c]) * f) >> 8);
      d[o + 1] = near[c + 1] + (((far[c + 1] - near[c + 1]) * f) >> 8);
      d[o + 2] = near[c + 2] + (((far[c + 2] - near[c + 2]) * f) >> 8);

      if (striped[at] && ((x + y) % STRIPE_PERIOD) < STRIPE_WIDTH) {
        d[o] = stripe[c]; d[o + 1] = stripe[c + 1]; d[o + 2] = stripe[c + 2];
      }

      if (!over) {
        d[o + 3] = 255;
      } else {
        const a = aRim + (((aCore - aRim) * f) >> 8) + lift[index] + (edge === 1 ? aInternal : 0);
        d[o + 3] = a > 255 ? 255 : a;
      }
    }
  }

  const w = lx1 - lx0, h = ly1 - ly0;
  if (!over) {
    tile.ctx.putImageData(scratch, 0, 0, lx0, ly0, w, h);
  } else {
    tile.ctx.clearRect(lx0, ly0, w, h);
    tile.ctx.drawImage(world.satellite, tile.x + lx0, tile.y + ly0, w, h, lx0, ly0, w, h);
    scratchCtx.putImageData(scratch, 0, 0, lx0, ly0, w, h);
    tile.ctx.drawImage(scratchCanvas, lx0, ly0, w, h, lx0, ly0, w, h);
  }

}

// Copies a map rectangle from the tiles down into the overview.
function refreshOverview(world, x0, y0, x1, y1) {
  const { scale, ctx } = live.overview;
  ctx.imageSmoothingEnabled = true;

  const pad = Math.ceil(2 / scale);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(world.width, x1 + pad); y1 = Math.min(world.height, y1 + pad);

  for (const tile of tilesOver(x0, y0, x1, y1)) {
    const ax0 = Math.max(x0, tile.x), ay0 = Math.max(y0, tile.y);
    const ax1 = Math.min(x1, tile.x + tile.w), ay1 = Math.min(y1, tile.y + tile.h);
    if (ax1 <= ax0 || ay1 <= ay0) continue;

    const dx0 = Math.round(ax0 * scale), dx1 = Math.round(ax1 * scale);
    const dy0 = Math.round(ay0 * scale), dy1 = Math.round(ay1 * scale);
    if (dx1 <= dx0 || dy1 <= dy0) continue;

    ctx.drawImage(
      tile.canvas,
      ax0 - tile.x, ay0 - tile.y, ax1 - ax0, ay1 - ay0,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
  }
}

// Starts a full repaint spread over several frames.
function startRepaint(world, mode, selected, hovered) {
  if (!live.tiles) buildTiles(world);
  return { t: shadeTable(world, mode, selected, hovered), todo: new Set(live.tiles.list) };
}

// Paints as much of a pass as the budget allows. True when finished.
function stepRepaint(world, pass) {
  const t0 = performance.now();
  const cssW = els.canvas.clientWidth, cssH = els.canvas.clientHeight;
  const first = [];
  for (const dx of wrapOffsets(cssW)) {
    const rect = visibleRect(view.x + dx, cssW, cssH);
    if (rect) first.push(...tilesOver(rect.x0, rect.y0, rect.x1, rect.y1));
  }

  const paint = (tile) => {
    pass.todo.delete(tile);
    paintTileRegion(world, pass.t, tile, 0, 0, tile.w, tile.h);
  };

  for (const tile of first) {
    if (!pass.todo.has(tile)) continue;
    paint(tile);
    if (performance.now() - t0 >= REPAINT_BUDGET_MS) break;
  }
  if (performance.now() - t0 < REPAINT_BUDGET_MS) {
    for (const tile of pass.todo) {
      paint(tile);
      if (performance.now() - t0 >= REPAINT_BUDGET_MS) break;
    }
  }

  const done = pass.todo.size === 0;
  if (done) refreshOverview(world, 0, 0, world.width, world.height);
  perf.paint = ease(perf.paint, performance.now() - t0);
  return done;
}

// Repaints only the provinces whose colour has changed, by bounding box.
function repaintProvinces(world, mode, selected, hovered, ids, boxes = []) {
  if (!live.tiles) { live.bufferDirty = true; return; }

  const t = shadeTable(world, mode, selected, hovered);
  for (const id of ids) {
    const bb = world.bounds.get(id);
    if (!bb) continue;

    for (const r of boxesFor(world, bb)) repaintBox(world, t, r.x0, r.y0, r.x1, r.y1);
  }

  for (const box of boxes) repaintBox(world, t, box.x0, box.y0, box.x1, box.y1);
}

// The rectangles a province box covers: one, or two across the seam.
function boxesFor(world, bb) {
  const y0 = bb.minY, y1 = bb.maxY + 1;
  if (bb.maxX < world.width) return [{ x0: bb.minX, y0, x1: bb.maxX + 1, y1 }];
  return [
    { x0: bb.minX, y0, x1: world.width, y1 },
    { x0: 0, y0, x1: bb.maxX + 1 - world.width, y1 },
  ];
}

// Repaints one half-open map rectangle and copies it into the overview.
function repaintBox(world, t, x0, y0, x1, y1) {
  for (const tile of tilesOver(x0, y0, x1, y1)) {
    const lx0 = Math.max(0, x0 - tile.x), ly0 = Math.max(0, y0 - tile.y);
    const lx1 = Math.min(tile.w, x1 - tile.x), ly1 = Math.min(tile.h, y1 - tile.y);
    if (lx1 > lx0 && ly1 > ly0) paintTileRegion(world, t, tile, lx0, ly0, lx1, ly1);
  }
  refreshOverview(world, x0, y0, x1, y1);
}

export { TILE, OVERVIEW_MAX, OVERVIEW_STRETCH, overviewCovers, scratch, scratchCanvas, scratchCtx, scratchLayers, viewportLayer, NIGHT_MASK_SCALE, NIGHT_LIGHT_SCALE, NIGHT_MIN_MS, NIGHT_DAY_START, NIGHT_FULL_DARK, sunShiftPx, NIGHT_DARKEN, NIGHT_LIGHTS, nightMask, buildNightMask, buildTiles, tilesOver, STRIPE_PERIOD, STRIPE_WIDTH, HIGHLIGHT_MAX_PX, REPAINT_BUDGET_MS, tooBigToLight, tooBigToLightBox, hueLightness, hslToRgb, navyColour, countyShade, countyShadeTable, splitShade, splitGround, subShadeTable, seaShadeTable, shadeTable, paintTileRegion, refreshOverview, startRepaint, stepRepaint, repaintProvinces, boxesFor, repaintBox };
