// The view transform, drawing a frame, and the frame loop.

const VERSION = new URL(import.meta.url).search;
const { mapLatAt, mapLonAt, sinSolarElevation, solarDeclination, subsolarLongitude } = await import(`../world/geo.js${VERSION}`);
const { canvasResized, clock, dirtyBoxes, dirtyProvinces, ease, els, invalidateProvinces, invalidateView, perf, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let COUNTY_RING_ALPHA, COUNTY_RING_COLOUR, F_CAPITAL_NAME, F_CITY_NAME, F_RIVER, MAP_GROUND, NIGHT_DARKEN, NIGHT_DAY_START, NIGHT_FULL_DARK, NIGHT_LIGHTS, NIGHT_LIGHT_SCALE, OUTLINE_COLOUR, OUTLINE_WIDTH, advanceClock, buildOutlinePath, cityFade, clockKey, debug, drawBuildingMarks, drawCities, drawInfrastructure, drawOverlays, drawRail, drawResources, fadeStrength, layoutLabels, markHits, overviewCovers, paintLabels, repaintProvinces, resourceHits, startRepaint, stepCityFades, stepLabelDim, stepRepaint, sunShiftPx, tilesOver, timeMarkup, updateReadout, viewportLayer;
export function link(all) { ({ COUNTY_RING_ALPHA, COUNTY_RING_COLOUR, F_CAPITAL_NAME, F_CITY_NAME, F_RIVER, MAP_GROUND, NIGHT_DARKEN, NIGHT_DAY_START, NIGHT_FULL_DARK, NIGHT_LIGHTS, NIGHT_LIGHT_SCALE, OUTLINE_COLOUR, OUTLINE_WIDTH, advanceClock, buildOutlinePath, cityFade, clockKey, debug, drawBuildingMarks, drawCities, drawInfrastructure, drawOverlays, drawRail, drawResources, fadeStrength, layoutLabels, markHits, overviewCovers, paintLabels, repaintProvinces, resourceHits, startRepaint, stepCityFades, stepLabelDim, stepRepaint, sunShiftPx, tilesOver, timeMarkup, updateReadout, viewportLayer } = all); }

const MIN_SCALE = 0.25;         // zoomed out: whole world, small
const MAX_SCALE = 16;           // zoomed in: individual map pixels visible
const view = { scale: 1, x: 0, y: 0 };   // x,y are the screen position of map pixel (0,0)

// Maximum canvas buffer size, in device pixels.
const MAX_CANVAS_PX = 4e6;

// Device pixel ratio the canvas is currently drawn at.
live.pixelRatio = 1;

// Device pixels per CSS pixel, reduced if the buffer would be too large.
function ratioFor(cssW, cssH) {
  const want = window.devicePixelRatio || 1;
  const area = Math.max(1, cssW * cssH);
  return Math.min(want, Math.sqrt(MAX_CANVAS_PX / area));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const screenToMap = (sx, sy) => ({ x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale });

// Zooms by `factor` about the screen point (sx,sy), keeping it under the cursor.
function zoomAt(sx, sy, factor) {
  const before = screenToMap(sx, sy);
  view.scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  view.x = sx - before.x * view.scale;
  view.y = sy - before.y * view.scale;
  clampPan();
  invalidateView();
}

const zoomCentre = (factor) => zoomAt(els.canvas.clientWidth / 2, els.canvas.clientHeight / 2, factor);

// Keeps the map in view: wraps x, keeps a quarter of the viewport over the map.
function clampPan() {
  const w = state.world;
  if (!w) return;
  const vh = els.canvas.clientHeight;

  const span = w.width * view.scale;
  if (span > 0) view.x = ((view.x % span) + span) % span - span;

  view.y = clamp(view.y, -w.height * view.scale + vh * 0.25, vh * 0.75);
}

// Scales and centres so the whole map is visible, with a 4% margin.
function fitToView() {
  const w = state.world;
  if (!w) return;
  const vw = els.canvas.clientWidth;
  const vh = els.canvas.clientHeight;
  view.scale = clamp(Math.min(vw / w.width, vh / w.height) * 0.96, MIN_SCALE, MAX_SCALE);
  view.x = (vw - w.width * view.scale) / 2;
  view.y = (vh - w.height * view.scale) / 2;
  clampPan();
  invalidateView();
}

// Horizontal offsets at which the wrapping map is drawn to fill the window.
function wrapOffsets(cssW, originX = view.x) {
  const span = state.world.width * view.scale;      // one map width, on screen
  const out = [];
  const first = Math.floor((0 - originX - span) / span) + 1;
  const last = Math.ceil((cssW - originX) / span) - 1;
  for (let k = first; k <= last; k++) out.push(k * span);
  return out.length ? out : [0];
}

// The on-screen part of one map copy, in map pixels, or null.
function visibleRect(vx, cssW, cssH) {
  const s = view.scale;
  const w = state.world;
  const x0 = clamp(Math.floor(-vx / s), 0, w.width);
  const y0 = clamp(Math.floor(-view.y / s), 0, w.height);
  const x1 = clamp(Math.ceil((cssW - vx) / s), 0, w.width);
  const y1 = clamp(Math.ceil((cssH - view.y) / s), 0, w.height);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

// Blits one copy of the map with its left edge at `vx`.
function drawMapLayer(ctx, cssW, cssH, vx) {
  const s = view.scale;
  const rect = visibleRect(vx, cssW, cssH);
  if (!rect) return;
  const { x0: sx0, y0: sy0, x1: sx1, y1: sy1 } = rect;

  if (overviewCovers(s)) {
    const o = live.overview.scale;
    const dx0 = Math.floor(vx + sx0 * s), dx1 = Math.ceil(vx + sx1 * s);
    const dy0 = Math.floor(view.y + sy0 * s), dy1 = Math.ceil(view.y + sy1 * s);
    if (dx1 <= dx0 || dy1 <= dy0) return;
    ctx.drawImage(
      live.overview.canvas,
      sx0 * o, sy0 * o, (sx1 - sx0) * o, (sy1 - sy0) * o,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
    return;
  }

  for (const tile of tilesOver(sx0, sy0, sx1, sy1)) {
    const ax0 = Math.max(sx0, tile.x), ay0 = Math.max(sy0, tile.y);
    const ax1 = Math.min(sx1, tile.x + tile.w), ay1 = Math.min(sy1, tile.y + tile.h);
    if (ax1 <= ax0 || ay1 <= ay0) continue;

    const dx0 = Math.floor(vx + ax0 * s), dx1 = Math.ceil(vx + ax1 * s);
    const dy0 = Math.floor(view.y + ay0 * s), dy1 = Math.ceil(view.y + ay1 * s);
    ctx.drawImage(
      tile.canvas,
      ax0 - tile.x, ay0 - tile.y, ax1 - ax0, ay1 - ay0,
      dx0, dy0, dx1 - dx0, dy1 - dy0
    );
    debug.tilesDrawn++;
  }
}

// Night layer: darkening and city lights, positioned from originX.

// Builds the night mask as whole periods side by side, computed per pixel.
function ensureNightStrip(mask, need) {
  const p = mask.period, h = mask.canvas.height;
  const reps = Math.max(2, need);

  if (!mask.strip || mask.reps < reps) {
    mask.strip = document.createElement('canvas');
    mask.strip.width = reps * p;
    mask.strip.height = h;
    mask.stripCtx = mask.strip.getContext('2d');
    mask.stripImg = mask.stripCtx.createImageData(reps * p, h);
    mask.reps = reps;
    mask.stripDay = null;                 // a new canvas holds nothing yet
  }
  if (mask.stripDay === mask.dayOfYear) return mask;

  const { cosLon, sinLat, cosLat, stripImg: img } = mask;
  const data = img.data;
  const dec = solarDeclination(mask.dayOfYear);
  const sinDec = Math.sin(dec), cosDec = Math.cos(dec);
  const span = NIGHT_DAY_START - NIGHT_FULL_DARK;

  const cw = mask.reps * p;

  for (let y = 0; y < h; y++) {
    const a = sinLat[y] * sinDec;
    const b = cosLat[y] * cosDec;
    let o = y * cw * 4 + 3;
    for (let x = 0; x < cw; x++, o += 4) {
      let t = (a + b * cosLon[x % p] - NIGHT_FULL_DARK) / span;   // 0 night, 1 day
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = t * t * (3 - 2 * t);                                   // ease the twilight band
      data[o] = Math.round(255 * (1 - t));
    }
  }
  mask.stripCtx.putImageData(img, 0, 0);
  mask.stripDay = mask.dayOfYear;
  return mask;
}

// The whole terminator across the window, in one piece.
function blitNightMask(ctx, mask, originX, cssW, cssH) {
  const s = view.scale, w = state.world;
  const k = mask.scale;

  const ry0 = clamp(Math.floor(-view.y / s), 0, w.height);
  const ry1 = clamp(Math.ceil((cssH - view.y) / s), 0, w.height);
  if (ry1 <= ry0) return;

  const dy0 = Math.floor(view.y + ry0 * s), dy1 = Math.ceil(view.y + ry1 * s);
  if (dy1 <= dy0) return;

  const mx0 = -originX / s, mx1 = (cssW - originX) / s;
  ensureNightStrip(mask, Math.ceil((mx1 - mx0) / w.width) + 1);

  const phase = mx0 - Math.floor(mx0 / w.width) * w.width;   // 0 .. one map width
  ctx.drawImage(mask.strip,
    phase * k, ry0 * k, (mx1 - mx0) * k, (ry1 - ry0) * k,
    0, dy0, cssW, dy1 - dy0);
}

// Blits a full-resolution map bitmap for one map copy.
function blitMapBitmap(ctx, bitmap, vx, cssW, cssH) {
  const s = view.scale;
  const rect = visibleRect(vx, cssW, cssH);
  if (!rect) return;

  const dx0 = Math.round(vx + rect.x0 * s), dx1 = Math.round(vx + rect.x1 * s);
  const dy0 = Math.round(view.y + rect.y0 * s), dy1 = Math.round(view.y + rect.y1 * s);
  if (dx1 <= dx0 || dy1 <= dy0) return;

  ctx.drawImage(bitmap,
    rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0,
    dx0, dy0, dx1 - dx0, dy1 - dy0);
}

const RIVER_AT = 2.55;              // zoom at or above which the rivers are on the map

// River opacity at full strength.
const RIVER_ALPHA = 0.34;

// Draws the rivers over the ground and under the night layer.
function drawRivers(ctx, cssW, cssH) {
  const w = state.world;
  const fade = cityFade(F_RIVER);
  if (!state.showRivers || !w.rivers || fade <= 0.004) return;

  ctx.save();
  ctx.globalAlpha = RIVER_ALPHA * fade;
  for (const dx of wrapOffsets(cssW)) blitMapBitmap(ctx, w.rivers, view.x + dx, cssW, cssH);
  ctx.restore();
}

// Draws the lit cities on the night side.
function drawCityLights(ctx, cssW, cssH, originX, alpha) {
  const w = state.world;

  const lights = viewportLayer('cityLights', cssW, cssH, NIGHT_LIGHT_SCALE);
  lights.ctx.imageSmoothingEnabled = view.scale < 1;
  for (const dx of wrapOffsets(cssW)) blitMapBitmap(lights.ctx, w.night, view.x + dx, cssW, cssH);

  const mask = viewportLayer('nightMask', cssW, cssH, NIGHT_LIGHT_SCALE);
  mask.ctx.imageSmoothingEnabled = true;
  blitNightMask(mask.ctx, w.nightMask, originX, cssW, cssH);

  lights.ctx.globalCompositeOperation = 'destination-in';
  lights.ctx.drawImage(mask.canvas, 0, 0, mask.w, mask.h, 0, 0, cssW, cssH);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = alpha;
  ctx.drawImage(lights.canvas, 0, 0, lights.w, lights.h, 0, 0, cssW, cssH);
  ctx.restore();
}

// Whether any of the visible map is dark enough to be worth drawing.
const NIGHT_PROBE = 5;

function anyNightVisible(world, cssW, cssH) {
  const dec = solarDeclination(live.sunDayOfYear);
  const sunLon = subsolarLongitude(live.sunUtcHour, world.width);

  for (const dx of wrapOffsets(cssW)) {
    const rect = visibleRect(view.x + dx, cssW, cssH);
    if (!rect) continue;

    for (let i = 0; i <= NIGHT_PROBE; i++) {
      const lat = mapLatAt(rect.y0 + ((rect.y1 - rect.y0) * i) / NIGHT_PROBE);
      for (let j = 0; j <= NIGHT_PROBE; j++) {
        const lon = mapLonAt(rect.x0 + ((rect.x1 - rect.x0) * j) / NIGHT_PROBE, world.width);
        if (sinSolarElevation(lat, lon, dec, sunLon) < NIGHT_DAY_START) return true;
      }
    }
  }
  return false;
}

function drawNightLayer(ctx, cssW, cssH) {
  const w = state.world;
  if (!state.showNight || !w.nightMask) return;
  if (!anyNightVisible(w, cssW, cssH)) return;

  const originX = view.x + sunShiftPx(w) * view.scale;
  const dark = NIGHT_DARKEN;

  if (dark > 0.004) {
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = dark;
    blitNightMask(ctx, w.nightMask, originX, cssW, cssH);
    ctx.restore();
  }

  const lit = NIGHT_LIGHTS;
  if (w.night && lit > 0.004) drawCityLights(ctx, cssW, cssH, originX, lit);
}

// Draws the ring around a province at `alpha`.
function drawSelectionRing(ctx, holder, alpha, colour = OUTLINE_COLOUR) {
  if (!holder.silhouette || alpha <= 0) return;
  const s = holder.silhouette;
  if (s.path === undefined) {
    const tBuild = performance.now();
    s.path = buildOutlinePath(s);
    perf.ringBuild = ease(perf.ringBuild, performance.now() - tBuild);
    perf.ringBuilds++;
    perf.ringPx = s.segments;
  }

  const t0 = performance.now();
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);
  ctx.translate(s.x, s.y);
  // Constant on-screen width at any zoom.
  ctx.lineWidth = OUTLINE_WIDTH / view.scale;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = colour;
  ctx.stroke(s.path);
  ctx.restore();
  perf.ringDraw = ease(perf.ringDraw, performance.now() - t0);
}

function drawView() {
  const canvas = els.canvas;

  // Canvas buffer at device resolution, capped at MAX_CANVAS_PX.
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const dpr = ratioFor(cssW, cssH);
  live.pixelRatio = dpr;
  if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
  if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = MAP_GROUND;
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.imageSmoothingEnabled = view.scale < 1;

  // Draws once per visible copy of the wrapped map.
  const offsets = wrapOffsets(cssW);
  debug.tilesDrawn = 0;
  resourceHits.length = 0;
  markHits.length = 0;
  for (const dx of offsets) drawMapLayer(ctx, cssW, cssH, view.x + dx);

  drawRivers(ctx, cssW, cssH);

  const tNight = performance.now();
  drawNightLayer(ctx, cssW, cssH);
  perf.night = ease(perf.night, performance.now() - tNight);

  for (const dx of offsets) {
    ctx.save();
    ctx.translate(dx, 0);

    drawSelectionRing(ctx, state, 1);
    if (state.fade) drawSelectionRing(ctx, state.fade, fadeStrength());
    if (state.county) drawSelectionRing(ctx, state.county, COUNTY_RING_ALPHA, COUNTY_RING_COLOUR);

    const showNames = state.showLabels && state.world.labels;
    const wantBoxes = state.showCities && showNames && !state.selected
      && (cityFade(F_CITY_NAME) > 0.004 || cityFade(F_CAPITAL_NAME) > 0.004);
    const labelBoxes = wantBoxes ? [] : null;

    const tLabels = performance.now();
    const ops = showNames ? layoutLabels(state.world.labels, cssW, cssH, dx, labelBoxes) : 0;
    perf.labels = ease(perf.labels, performance.now() - tLabels);

    const cityLayer = () => {
      if (!state.showCities) return;
      const t0 = performance.now();
      drawCities(ctx, cssW, cssH, dx, labelBoxes);
      perf.cities = ease(perf.cities, performance.now() - t0);
    };
    const nameLayer = () => paintLabels(ctx, ops);

    if (state.mode === 'infra:rail') drawRail(ctx, cssW, cssH, dx);

    if (state.selected) { nameLayer(); cityLayer(); } else { cityLayer(); nameLayer(); }
    drawBuildingMarks(ctx, cssW, cssH, dx);
    if (state.mode === 'resources') drawResources(ctx, cssW, cssH, dx);
    else if (state.mode.startsWith('infra:')) drawInfrastructure(ctx, cssW, cssH, dx);
    drawOverlays(ctx, cssW, cssH, dx);
    ctx.restore();
  }
}

// The render loop. Draws only when a flag is set and traps errors.
live.frameFault = null;
live.frameFaults = 0;

function frame() {
  const t0 = performance.now();
  try {
    frameBody();
  } catch (err) {
    live.frameFaults++;
    if (!live.frameFault) {
      live.frameFault = err;
      console.error('The render loop threw. The map will stop updating until this is fixed.', err);
    }
  }
  perf.frameJs = ease(perf.frameJs, performance.now() - t0);
  requestAnimationFrame(frame);
}

function frameBody() {
  if (state.world) {
    advanceClock(performance.now());

    if (canvasResized()) {
      clampPan();
      live.viewDirty = true;
    }

    if (stepCityFades(performance.now()) && state.showCities) live.viewDirty = true;

    if (stepLabelDim(performance.now())) live.viewDirty = true;

    if (state.fade) {
      invalidateProvinces(state.fade.id, ...state.fade.neighbours);
      if (fadeStrength() <= 0) state.fade = null;
      live.viewDirty = true;
    }

    if (live.bufferDirty) {
      live.repaintPass = startRepaint(state.world, state.mode, state.selected, state.hovered);
      live.bufferDirty = false;
      dirtyProvinces.clear();   // the full repaint covers them
      dirtyBoxes.length = 0;
    }

    if (live.repaintPass) {
      if (stepRepaint(state.world, live.repaintPass)) {
        live.repaintPass = null;
        perf.fullRepaints++;
      }
      live.viewDirty = true;         // show what has been painted so far
    } else if (dirtyProvinces.size || dirtyBoxes.length) {
      const t0 = performance.now();
      repaintProvinces(state.world, state.mode, state.selected, state.hovered, dirtyProvinces, dirtyBoxes);
      perf.paint = ease(perf.paint, performance.now() - t0);
      perf.partRepaints++;
      dirtyProvinces.clear();
      dirtyBoxes.length = 0;
      live.viewDirty = true;
    }
    if (live.viewDirty) {
      const t0 = performance.now();
      drawView();
      perf.draw = ease(perf.draw, performance.now() - t0);
      live.viewDirty = false;
    }

    const now = performance.now();
    if (perf.lastFrame) perf.frameMs = ease(perf.frameMs, now - perf.lastFrame);
    perf.lastFrame = now;
    updateReadout(now);
    refreshTooltipTime();
  }
}

// Keeps the open tooltip's time current while the clock runs.
function refreshTooltipTime() {
  if (!live.tipFor || els.tooltip.hidden || !state.world) return;
  const clock = live.tipClock ? live.tipClock() : null;
  if (clockKey(clock) === live.tipTime) return;
  live.tipTime = clockKey(clock);
  els.tooltip.innerHTML = live.tipHead + timeMarkup(clock) + live.tipTail;
}

export { MIN_SCALE, MAX_SCALE, view, MAX_CANVAS_PX, ratioFor, clamp, screenToMap, zoomAt, zoomCentre, clampPan, fitToView, wrapOffsets, visibleRect, drawMapLayer, ensureNightStrip, blitNightMask, blitMapBitmap, RIVER_AT, RIVER_ALPHA, drawRivers, drawCityLights, NIGHT_PROBE, anyNightVisible, drawNightLayer, drawSelectionRing, drawView, frame, frameBody, refreshTooltipTime };
