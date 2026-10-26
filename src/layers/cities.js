// City and capital marks and their names.

const VERSION = new URL(import.meta.url).search;
const { state, live } = await import(`../core/core.js${VERSION}`);
const { LABEL_COLOUR, LABEL_FACE, LABEL_OUTLINE } = await import(`../render/labels.js${VERSION}`);
const { RIVER_AT } = await import(`../render/view.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let LABEL_COLOUR_OPACITY, LABEL_OUTLINE_ALPHA, LABEL_OUTLINE_WIDTH, MARK_KINDS, boxHitsGlyph, buildingMarks, coveredFraction, glyphExtent, glyphOverlapArea, labelFont, makeGrid, markScratch, smoothstep, view;
export function link(all) { ({ LABEL_COLOUR_OPACITY, LABEL_OUTLINE_ALPHA, LABEL_OUTLINE_WIDTH, MARK_KINDS, boxHitsGlyph, buildingMarks, coveredFraction, glyphExtent, glyphOverlapArea, labelFont, makeGrid, markScratch, smoothstep, view } = all); }

const NAME_MIN_PX = 30;        // min on-screen width for a province name
const OVERLAY_FONT = `500 11px ${LABEL_FACE}`;

// Per-frame counts read by the Performance readout.
const debug = { names: 0, seaNames: 0, tilesDrawn: 0, path: '—', cursor: null };

// Cities: zoom thresholds and fade timing.

const CITY_AT = 1.30;               // zoom at or above which each is on the map
const CAPITAL_AT = 0.50;
const CITY_NAME_AT = 2.25;
const CAPITAL_NAME_AT = 1.30;
const CITY_FADE_MS = 150;           // fade duration

// Shared zoom, size and outline for building marks.
const BUILDING_AT_ZOOM = 0.90;      // between capitals and cities
const BUILDING_ICON_PX = 16;        // on-screen height of the mark
const BUILDING_OUTLINE_PX = 0.4;    // white edge traced round the mark
const CITY_ICON_PX = 9;            // on-screen height of an ordinary city
const CAPITAL_ICON_PX = 14;         // and of a capital
const CITY_NAME_PX = 12;            // name sizes, fixed on screen
const CAPITAL_NAME_PX = 13;
const CITY_NAME_GAP = 2;            // clearance between an icon and its name
const CITY_NAME_PAD = 2;            // padding for overlap tests

// Share of a city icon a country name may cover before the city is hidden.
const CITY_BLOCKED_AT = 0.85;

// Samples per side for the coverage test.
const COVERAGE_SAMPLES = 8;

// City names: light text on a dark halo.
const CITY_NAME_COLOUR = LABEL_OUTLINE;
const CITY_NAME_OUTLINE = LABEL_COLOUR;

// International cities: zoom below which a concession merges into its city.
const CITY_MERGE_AT = 3.0;
const CITY_MERGE_MAX_PX = 30;     // in map pixels

// City name bitmaps, baked once and cached.
const cityNameCache = new Map();
let cityNameMeasure = null;

function bakedCityName(name, px) {
  const scale = Math.max(1, live.pixelRatio);
  const key = px + '|' + scale.toFixed(2) + '|' + name;
  const had = cityNameCache.get(key);
  if (had) return had;

  if (!cityNameMeasure) cityNameMeasure = document.createElement('canvas').getContext('2d');
  cityNameMeasure.font = labelFont(px);
  const width = cityNameMeasure.measureText(name).width;

  const pad = Math.ceil(px * LABEL_OUTLINE_WIDTH) + 2;
  const w = Math.ceil(width) + pad * 2;
  const h = Math.ceil(px * 1.6) + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(h * scale);

  const x = canvas.getContext('2d');
  x.scale(scale, scale);
  x.font = labelFont(px);
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.lineJoin = 'round';
  x.lineWidth = px * LABEL_OUTLINE_WIDTH;
  x.strokeStyle = `rgba(${CITY_NAME_OUTLINE},${LABEL_OUTLINE_ALPHA})`;
  x.fillStyle = `rgba(${CITY_NAME_COLOUR},${LABEL_COLOUR_OPACITY})`;
  x.strokeText(name, w / 2, h / 2);
  x.fillText(name, w / 2, h / 2);

  const baked = { canvas, w, h, half: width / 2 };
  cityNameCache.set(key, baked);
  return baked;
}

function linkInternationalCities(cities) {
  const byName = new Map();
  for (const c of cities) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }

  for (const c of cities) {
    const base = /^International\s+(.+)$/i.exec(c.name)?.[1];
    if (!base) continue;

    let into = null, best = CITY_MERGE_MAX_PX;
    for (const q of byName.get(base) || []) {
      const d = Math.hypot(q.x - c.x, q.y - c.y);
      if (d < best) { best = d; into = q; }
    }
    if (!into) continue;

    c.mergesInto = into;
    if (c.capital) into.absorbsCapital = true;
  }
}

// Indices into the fade opacities.
const F_CITY = 0, F_CAPITAL = 1, F_CITY_NAME = 2, F_CAPITAL_NAME = 3, F_RIVER = 4, F_BUILDING = 5;
const CITY_THRESHOLDS = [CITY_AT, CAPITAL_AT, CITY_NAME_AT, CAPITAL_NAME_AT, RIVER_AT, BUILDING_AT_ZOOM];

const cityAlpha = CITY_THRESHOLDS.map(() => 0);
let cityClock = null;

// Moves each fade opacity towards its threshold; true while any is moving.
function stepCityFades(now) {
  const step = cityClock === null ? 1 : (now - cityClock) / CITY_FADE_MS;
  cityClock = now;

  let moving = false;
  for (let i = 0; i < CITY_THRESHOLDS.length; i++) {
    const want = view.scale >= CITY_THRESHOLDS[i] ? 1 : 0;
    if (cityAlpha[i] === want) continue;
    cityAlpha[i] = want > cityAlpha[i]
      ? Math.min(want, cityAlpha[i] + step)
      : Math.max(want, cityAlpha[i] - step);
    moving = true;
  }
  return moving;
}

// Eased opacity for fade i.
const cityFade = (i) => smoothstep(0, 1, cityAlpha[i]);

// Name positions around an icon, best first; each returns the box centre.
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

  const placedGrid = makeGrid();
  const glyphGrid = makeGrid();
  if (labelBoxes) for (const g of labelBoxes) glyphGrid.add(g, ...glyphExtent(g));

  const eyrieGrid = makeGrid();
  const nearEyries = [];
  for (const kind of MARK_KINDS) {
    for (const m of buildingMarks(kind, cssW, cssH, dx, markScratch[kind].labels)) {
      const b = [m.x - m.w / 2 - CITY_NAME_PAD, m.y - m.h / 2 - CITY_NAME_PAD,
      m.x + m.w / 2 + CITY_NAME_PAD, m.y + m.h / 2 + CITY_NAME_PAD];
      eyrieGrid.add(b, b[0], b[1], b[2], b[3]);
    }
  }

  const eyrieHit = (b) => {
    let a = 0;
    for (const p of eyrieGrid.near(b[0], b[1], b[2], b[3], nearEyries)) {
      const w = Math.min(b[2], p[2]) - Math.max(b[0], p[0]);
      if (w <= 0) continue;
      const h = Math.min(b[3], p[3]) - Math.max(b[1], p[1]);
      if (h > 0) a += w * h;
    }
    return a;
  };

  const nearPlaced = [];
  const nearGlyphs = [];
  const glyphsNear = (b) => (labelBoxes ? glyphGrid.near(b[0], b[1], b[2], b[3], nearGlyphs) : nearGlyphs);

  const free = (b, own) => {
    for (const p of placedGrid.near(b[0], b[1], b[2], b[3], nearPlaced)) {
      if (p !== own && hits(b, p)) return false;
    }
    return true;
  };

  const clearOfNames = (b) => {
    for (const g of glyphsNear(b)) if (boxHitsGlyph(b, g)) return false;
    return true;
  };

  const namesHit = (b) => {
    let a = 0;
    for (const g of glyphsNear(b)) if (boxHitsGlyph(b, g)) a += glyphOverlapArea(b, g);
    return a;
  };

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  // Pass one: place every icon and reserve its box.
  const named = [];
  const merged = view.scale < CITY_MERGE_AT;      // concessions folded into their city
  for (const c of cities) {
    if (merged && c.mergesInto) continue;

    const capital = c.capital || (merged && c.absorbsCapital);
    const k = capital ? 1 : 0;
    const icon = capital ? cityIcons.capital : cityIcons.city;
    if (!icon || iconA[k] <= 0.004) continue;

    const sx = c.x * view.scale + view.x;
    const sy = c.y * view.scale + view.y;
    if (sx + dx < -80 || sy < -80 || sx + dx > cssW + 80 || sy > cssH + 80) continue;

    const h = k ? CAPITAL_ICON_PX : CITY_ICON_PX;
    const w = Math.round(h * (icon.width / icon.height));

    // Skip cities buried under a country name.
    const box = [sx - w / 2, sy - h / 2, sx + w / 2, sy + h / 2];
    if (coveredFraction(box, glyphsNear(box)) >= CITY_BLOCKED_AT) continue;

    ctx.globalAlpha = iconA[k];
    ctx.drawImage(icon, Math.round(sx - w / 2), Math.round(sy - h / 2), w, Math.round(h));

    const own = [sx - w / 2 - CITY_NAME_PAD, sy - h / 2 - CITY_NAME_PAD,
    sx + w / 2 + CITY_NAME_PAD, sy + h / 2 + CITY_NAME_PAD];
    placedGrid.add(own, own[0], own[1], own[2], own[3]);

    if (nameA[k] > 0.004 && c.name) named.push({ c, k, sx, sy, w, h, own });
  }

  // Pass two: names, capitals first.
  named.sort((a, b) => b.k - a.k);

  for (const { c, k, sx, sy, w, h, own } of named) {
    const px = k ? CAPITAL_NAME_PX : CITY_NAME_PX;
    const baked = bakedCityName(c.name, px);
    const half = baked.half;

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
    if (!open.length) continue;    // no clear spot; icon only

    let box = null, leastEyrie = Infinity, leastNames = Infinity;
    for (const b of open) {
      const e = eyrieHit(b);
      if (!e && clearOfNames(b)) { box = b; break; }   // first clean spot wins
      const n = namesHit(b);
      if (e < leastEyrie || (e === leastEyrie && n < leastNames)) {
        leastEyrie = e; leastNames = n; box = b;
      }
    }
    placedGrid.add(box, box[0], box[1], box[2], box[3]);

    ctx.globalAlpha = nameA[k];
    ctx.drawImage(baked.canvas,
      Math.round(box.cx - baked.w / 2), Math.round(box.cy - baked.h / 2), baked.w, baked.h);
  }
  ctx.restore();
}

export { NAME_MIN_PX, OVERLAY_FONT, debug, CITY_AT, CAPITAL_AT, CITY_NAME_AT, CAPITAL_NAME_AT, CITY_FADE_MS, BUILDING_AT_ZOOM, BUILDING_ICON_PX, BUILDING_OUTLINE_PX, CITY_ICON_PX, CAPITAL_ICON_PX, CITY_NAME_PX, CAPITAL_NAME_PX, CITY_NAME_GAP, CITY_NAME_PAD, CITY_BLOCKED_AT, COVERAGE_SAMPLES, CITY_NAME_COLOUR, CITY_NAME_OUTLINE, CITY_MERGE_AT, CITY_MERGE_MAX_PX, cityNameCache, cityNameMeasure, bakedCityName, linkInternationalCities, F_CITY, F_CAPITAL, F_CITY_NAME, F_CAPITAL_NAME, F_RIVER, F_BUILDING, CITY_THRESHOLDS, cityAlpha, cityClock, stepCityFades, cityFade, CITY_NAME_SPOTS, drawCities };
