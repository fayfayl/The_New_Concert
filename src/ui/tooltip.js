// The map tooltip and its local time.

const VERSION = new URL(import.meta.url).search;
const { localHours, mapLatAt, mapLonAt, sinSolarElevation, solarDeclination, subsolarLongitude } = await import(`../world/geo.js${VERSION}`);
const { TICKS_PER_DAY, TICK_MINUTES, clock, els, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let MARKS, NIGHT_DAY_START, NIGHT_FULL_DARK, RESOURCE_NAME, countyAtEvent, flagFile, flagMissing, flagSlug, flagSrc, markHits, miniFlag, polityOf, resourceHits, subAtEvent, tipName;
export function link(all) { ({ MARKS, NIGHT_DAY_START, NIGHT_FULL_DARK, RESOURCE_NAME, countyAtEvent, flagFile, flagMissing, flagSlug, flagSrc, markHits, miniFlag, polityOf, resourceHits, subAtEvent, tipName } = all); }

const swatch = (rgb) => `<span class="swatch" style="background: rgb(${rgb})"></span>`;

// Puts a country's flag on a block, colour left underneath.
function paintFlagBlock(el, pol) {
  if (!el) return;

  let img = el.firstElementChild;
  if (!img) { img = document.createElement('img'); img.alt = ''; el.append(img); }
  const slug = flagSlug(pol);
  const fits = (on) => {
    el.style.minWidth = on ? '0' : '';
    el.style.background = on ? 'transparent' : `rgb(${pol?.colour ?? '128,128,128'})`;
    el.style.boxShadow = on ? 'none' : '';
  };
  fits(false);
  img.hidden = false;
  img.onerror = () => { img.hidden = true; fits(false); };
  img.onload = () => { img.hidden = false; fits(true); };
  if (slug) img.src = flagSrc(slug);
  else { img.hidden = true; fits(false); }
}

const polSwatch = (pol) => {
  const slug = flagSlug(pol);
  const under = `rgb(${pol?.colour ?? '128,128,128'})`;
  const blank = !slug || flagMissing.has(slug);
  return `<span class="swatch flag${blank ? ' blank' : ''}" style="--flag-colour: ${under}">`
    + (blank ? '' : `<img class="swatch-flag" alt="" src="${flagFile(slug)}"`
      + ` onerror="window.flagMiss(this, '${slug}')">`)
    + '</span>';
};

// What a province's people want, largest first; ideology map only.
function supportRows(w, p) {
  if (state.mode !== 'ideology') return '';
  const s = w.stats?.[p.id]?.support;
  if (!s || !Object.keys(s).length) return '<div class="sub">nothing yet</div>';
  return Object.entries(s).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<div class="sub">${swatch(w.ideologyColour?.get(k) || [128, 128, 128])}<b>${v}%</b> ${k}</div>`)
    .join('');
}

const TOOLTIP_OFFSET = 14;

// Province or sea region the open tooltip describes, or null.
live.tipFor = null;
// How to read tipFor's local time, and the last reading shown.
live.tipClock = null;
live.tipTime = null;
live.tipHead = '';
live.tipTail = '';

// Sun, twilight and moon marks for the local time.
const SUN_MARK = '<svg viewBox="0 0 12 12" aria-label="day"><circle cx="6" cy="6" r="2.6"/>'
  + '<path d="M6 0v2M6 10v2M0 6h2M10 6h2M1.8 1.8l1.4 1.4M8.8 8.8l1.4 1.4M1.8 10.2l1.4-1.4M8.8 3.2l1.4-1.4"'
  + ' stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
const TWILIGHT_MARK = '<svg viewBox="0 0 12 12" aria-label="twilight"><path d="M2.6 9A3.4 3.4 0 0 1 9.4 9z"/>'
  + '<path d="M0 9h12M6 2v2M1.7 4.1l1.4 1.4M10.3 4.1l-1.4 1.4" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
const MOON_MARK = '<svg viewBox="0 0 12 12" aria-label="night"><path d="M8.5 1.2A5 5 0 1 0 10.8 9 4.2 4.2 0 0 1 8.5 1.2z"/></svg>';
const SKY_MARK = { day: SUN_MARK, twilight: TWILIGHT_MARK, night: MOON_MARK };

// The tooltip's local-time line, marked with the map's light there.
const timeMarkup = (c) => (c
  ? `<div class="tip-time">Local time: ${SKY_MARK[c.sky]}<b>${c.time}</b></div>`
  : '');

// Key that tells two clock readings apart.
const clockKey = (c) => (c ? c.time + c.sky : null);

// Local time and light at a province, sea region or subregion.
function landClock(world, id) {
  return boundsClock(world, world.bounds.get(id));
}

function seaClock(world, id) {
  return boundsClock(world, world.sea?.bounds?.get(id));
}

function subClock(world, sub) {
  const [lat, lon] = sub?.centre || [];
  return Number.isFinite(lat) && Number.isFinite(lon)
    ? clockAt(world, (lat * Math.PI) / 180, (lon * Math.PI) / 180) : null;
}

function boundsClock(world, bb) {
  return bb ? clockAt(world, mapLatAt(bb.cy), mapLonAt(bb.cx, world.width)) : null;
}

function clockAt(world, lat, lon) {
  return { time: timeAtLon(world, lon), sky: skyAt(world, lat, lon) };
}

// Day, twilight or night at a place, on the night shading's cut-offs.
function skyAt(world, lat, lon) {
  const s = sinSolarElevation(lat, lon, solarDeclination(live.sunDayOfYear),
    subsolarLongitude(live.sunUtcHour, world.width));
  return s >= NIGHT_DAY_START ? 'day' : s <= NIGHT_FULL_DARK ? 'night' : 'twilight';
}

// Local time at a longitude in radians, rounded to the tick.
function timeAtLon(world, lon) {
  const hours = localHours(lon, live.sunUtcHour, world.width);

  const ticks = Math.round((hours * 60) / TICK_MINUTES) % TICKS_PER_DAY;
  const mins = ticks * TICK_MINUTES;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// Shrinks the tooltip to the width of its text.
function fitTooltip() {
  const el = els.tooltip;
  el.style.width = '';
  if (typeof document.createRange !== 'function'
    || typeof document.createTreeWalker !== 'function' || !el.getBoundingClientRect) return;

  let right = 0;
  try {
    const range = document.createRange();
    const walk = document.createTreeWalker(el, 4 /* SHOW_TEXT */);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      if (!String(node.nodeValue || '').trim()) continue;
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) if (r.width) right = Math.max(right, r.right);
    }
    for (const q of el.querySelectorAll('img, i')) {
      const r = q.getBoundingClientRect();
      if (r.width) right = Math.max(right, r.right);
    }
  } catch { return; }
  if (!right) return;

  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const pad = (parseFloat(style.paddingRight) || 0) + (parseFloat(style.borderRightWidth) || 0);
  const em = parseFloat(style.fontSize) || 13;
  const want = right - box.left + pad;
  if (want > 0 && want < box.width - em / 3) el.style.width = `${(want / em).toFixed(3)}em`;
}

// Shows the tooltip beside the pointer, flipped at window edges.
function placeTooltip(ev) {
  els.tooltip.hidden = false;
  fitTooltip();

  const box = els.wrap.getBoundingClientRect();
  const x = ev.clientX - box.left;
  const y = ev.clientY - box.top;
  const tw = els.tooltip.offsetWidth;
  const th = els.tooltip.offsetHeight;

  els.tooltip.style.left = `${x + TOOLTIP_OFFSET + tw > box.width ? x - TOOLTIP_OFFSET - tw : x + TOOLTIP_OFFSET}px`;
  els.tooltip.style.top = `${y + TOOLTIP_OFFSET + th > box.height ? y - TOOLTIP_OFFSET - th : y + TOOLTIP_OFFSET}px`;
}
// Shows the hover tooltip, or hides it when `id` is null.
function showTooltip(id, ev, seaId = null) {
  const w = state.world;
  if (!id && !seaId) { els.tooltip.hidden = true; live.tipFor = null; return; }

  if (id) {
    const p = w.byId.get(id);
    const pol = polityOf(w, p);
    const clock = landClock(w, id);
    const county = countyAtEvent(ev);
    live.tipFor = id;
    live.tipClock = () => landClock(state.world, id);
    live.tipTime = clockKey(clock);
    const ground = state.mode === 'ideology' ? null : county;
    live.tipHead =
      (ground
        ? `<div class="plain">A <b>${ground.terrain[0]}</b> county in <b>${p.name}</b></div>`
        : `<div>${p.name}</div>`) +
      `<div class="sub">Owner: ${miniFlag(pol)}<b>${tipName(pol.name)}</b></div>` +
      (state.mode === 'ideology' ? ''
        : `<div class="sub">Climate: <b>${ground ? ground.climate : p.climate.join(', ')}</b></div>`);
    live.tipTail = supportRows(w, p);
    els.tooltip.innerHTML = live.tipHead + timeMarkup(clock) + live.tipTail;
  } else {
    const r = w.sea.byId.get(seaId);
    const navy = state.mode === 'navy';
    const sub = navy && !r.lake && w.subs ? w.subs.byId.get(subAtEvent(ev)) : null;
    live.tipFor = navy ? seaId : null;
    live.tipClock = !navy ? null
      : sub?.centre ? () => subClock(state.world, sub) : () => seaClock(state.world, seaId);
    const clock = live.tipClock ? live.tipClock() : null;
    live.tipTime = clockKey(clock);
    const band = sub?.depth ? `<b>${sub.depth}</b> ` : '';
    const article = /^[aeiou]/i.test(sub?.depth || 'subregion') ? 'An' : 'A';
    live.tipHead =
      (sub
        ? `<div class="plain">${article} ${band}subregion in the <b>${r.name}</b></div>`
        : `<div>${r.name}</div>`) +
      (sub?.area || r.area ? `<div class="sub">Area: <b>${areaText(sub?.area ? sub : r)}</b></div>` : '');
    live.tipTail = '';
    els.tooltip.innerHTML = live.tipHead + timeMarkup(clock) + live.tipTail;
  }
  placeTooltip(ev);
}

// The resource row under the pointer, or null; topmost wins.
function resourceAtEvent(ev) {
  if (state.mode !== 'resources' || !resourceHits.length) return null;
  const box = els.canvas.getBoundingClientRect();
  const x = ev.clientX - box.left;
  const y = ev.clientY - box.top;
  for (let i = resourceHits.length - 1; i >= 0; i--) {
    const h = resourceHits[i];
    if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
  }
  return null;
}

// Tooltip naming the deposit under the pointer.
function showResourceTooltip(hit, ev) {
  const w = state.world;
  const p = w.byId.get(hit.id);
  live.tipFor = null;
  live.tipTime = null;

  els.tooltip.innerHTML =
    `<div>${RESOURCE_NAME[hit.kind] ?? hit.kind}</div>` +
    `<div class="sub">A deposit of <b>${hit.amount}</b>${p ? ` in <b>${tipName(p.name)}</b>` : ''}</div>` +
    `<div class="sub">Yield: <b>${hit.yield ?? 0}/day</b></div>`;
  placeTooltip(ev);
}

// The eyrie mark under the pointer, or null; topmost wins.
function markAtEvent(ev) {
  if (!markHits.length) return null;
  const box = els.canvas.getBoundingClientRect();
  const x = ev.clientX - box.left;
  const y = ev.clientY - box.top;
  for (let i = markHits.length - 1; i >= 0; i--) {
    const h = markHits[i];
    if (x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) return h;
  }
  return null;
}

// Tooltip naming the building under the pointer.
function showMarkTooltip(hit, ev) {
  const w = state.world;
  const c = w.counties?.byId?.get(hit.id);
  const p = w.byId.get(hit.province ?? c?.province);
  const pol = p ? polityOf(w, p) : null;
  live.tipFor = null;
  live.tipTime = null;

  els.tooltip.innerHTML =
    `<div>${MARKS[hit.kind].label}</div>` +
    (pol ? `<div class="sub">${miniFlag(pol)}${tipName(pol.name)}</div>` : '') +
    `<div class="sub">${c ? c.name : tipName(p ? p.name : '')}</div>`;
  placeTooltip(ev);
}

// A province's true surface area, as a line of text.
function areaText(p) {
  if (typeof p.area !== 'number') return '— (run test/sync-provinces.js)';
  return p.area >= 1e6
    ? `${(p.area / 1e6).toFixed(2)}M km²`
    : `${Math.round(p.area).toLocaleString()} km²`;
}

export { swatch, paintFlagBlock, polSwatch, supportRows, TOOLTIP_OFFSET, SUN_MARK, TWILIGHT_MARK, MOON_MARK, SKY_MARK, timeMarkup, clockKey, landClock, seaClock, subClock, boundsClock, clockAt, skyAt, timeAtLon, fitTooltip, placeTooltip, showTooltip, resourceAtEvent, showResourceTooltip, markAtEvent, showMarkTooltip, areaText };
