// The debug readout and its statistics.

const VERSION = new URL(import.meta.url).search;
const { SPEEDS, TICKS_PER_DAY, clock, els, perf, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let CAPITAL_AT, CAPITAL_NAME_AT, CITY_AT, CITY_NAME_AT, F_CAPITAL, F_CAPITAL_NAME, F_CITY, F_CITY_NAME, F_RIVER, RIVER_ALPHA, RIVER_AT, TILE, cityFade, debug, levelLineCache, overviewCovers, panelOpen, resourceLineCache, sfx, sunShiftPx, view;
export function link(all) { ({ CAPITAL_AT, CAPITAL_NAME_AT, CITY_AT, CITY_NAME_AT, F_CAPITAL, F_CAPITAL_NAME, F_CITY, F_CITY_NAME, F_RIVER, RIVER_ALPHA, RIVER_AT, TILE, cityFade, debug, levelLineCache, overviewCovers, panelOpen, resourceLineCache, sfx, sunShiftPx, view } = all); }

// Build version shown in the debug menu.
const BUILD = 'v0.10.a-indev';

// The size a ring was traced at, for the readout.
const ringShape = (holder) => (holder.silhouette
  ? `(${holder.silhouette.w}&times;${holder.silhouette.h})`
  : '(NO SHAPE)');

const READOUT_MS = 250;    // refresh interval of the live numbers, ms
live.readoutAt = 0;

const statRow = (k, v, warn) =>
  `<div class="row"><span>${k}</span><span${warn ? ' class="warn"' : ''}>${v}</span></div>`;

// Refreshes the Performance block a few times a second.
function updateReadout(now) {
  if (!panelOpen() || now - live.readoutAt < READOUT_MS) return;
  const since = now - live.readoutAt;
  live.readoutAt = now;

  const target = 1000 / SPEEDS[clock.speed - 1];
  const achieved = since > 0 && since < 2000 ? ((clock.ticked - clock.rateFrom) * 1000) / since : 0;
  clock.rateFrom = clock.ticked;

  const drawing = overviewCovers(view.scale) ? 'overview' : 'tiles';
  const chunks = live.tiles ? live.tiles.list.length : 0;
  const visible = drawing === 'tiles' ? `${debug.tilesDrawn} / ${chunks}` : `0 / ${chunks}`;

  els.perf.innerHTML =
    statRow('Build', BUILD) +
    statRow('Tick', `${clock.tick}${clock.paused ? ' (paused)' : ''}`) +
    statRow('Ticks/s', `${achieved.toFixed(1)} / ${target.toFixed(1)} at speed ${clock.speed}`,
      !clock.paused && achieved < target * 0.9) +
    statRow('Sun', `${live.sunUtcHour.toFixed(2)}h, day ${live.sunDayOfYear}, +${Math.round(sunShiftPx(state.world))}px`) +
    statRow('Mask builds', `${perf.maskBuilds} (${Math.floor(clock.tick / TICKS_PER_DAY) + 1} days)`,
      perf.maskBuilds > Math.floor(clock.tick / TICKS_PER_DAY) + 2) +
    statRow('Frame', `${perf.frameMs ? (1000 / perf.frameMs).toFixed(0) : 0} fps`, perf.frameMs > 22) +
    statRow('  js / gap', `${perf.frameJs.toFixed(1)} ms + ${Math.max(0, perf.frameMs - perf.frameJs).toFixed(1)} ms`,
      perf.frameMs - perf.frameJs > 8) +
    statRow('Blit', `${perf.draw.toFixed(2)} ms`, perf.draw > 8) +
    statRow('  night', `${perf.night.toFixed(2)} ms`, perf.night > 4) +
    statRow('  labels', `${perf.labels.toFixed(2)} ms`, perf.labels > 3) +
    statRow('  cities', `${perf.cities.toFixed(2)} ms`, perf.cities > 3) +
    (state.selected || state.county || state.fade
      ? statRow('  ring', `${perf.ringDraw.toFixed(2)} ms stroke, ${perf.ringBuild.toFixed(1)} ms trace`
        + `, ${perf.ringBuilds} traces, ${perf.ringPx} segments`, perf.ringDraw > 3)
      : '') +
    statRow('Last paint', `${perf.paint.toFixed(2)} ms`, perf.paint > 16) +
    (state.mode === 'resources'
      ? statRow('Resources', `${perf.resources.toFixed(2)} ms, ${debug.resourcesDrawn || 0} stacks`
        + `, ${resourceLineCache.size} baked`
        , perf.resources > 4)
      : '') +
    (state.mode === 'routes'
      ? statRow('Trade routes', `${debug.routes || 0} segments, ${debug.routeStops || 0} stops`)
      : '') +
    (state.mode.startsWith('infra:')
      ? statRow('Layer', `${state.mode.slice(6)}, ${debug.infrastructure || 0} labelled`
        + `, ${levelLineCache.size} baked`)
      : '') +
    statRow('Click sound', sfx.buffer
      ? `${(sfx.offset * 1000).toFixed(0)}ms trimmed, ${(sfx.attack * 1000).toFixed(0)}ms attack,`
      + ` ${(live.sfxDelay * 1000).toFixed(0)}ms held,`
      + ` ${sfx.lag.toFixed(1)}ms to answer,`
      + ` ${sfx.base + sfx.output ? `${((sfx.base + sfx.output) * 1000).toFixed(0)}ms device` : 'device n/a'}`
      + `, peak ${sfx.peak.toFixed(2)}`
      : 'not loaded', sfx.lag > 8) +
    statRow('Canvas', `${els.canvas.width} &times; ${els.canvas.height}`
      + ` (${(els.canvas.width * els.canvas.height / 1e6).toFixed(1)}M px @ ${live.pixelRatio.toFixed(2)}x of ${(window.devicePixelRatio || 1)})`,
      els.canvas.width * els.canvas.height > 5e6) +
    (live.frameFault
      ? statRow('LOOP THREW', `${live.frameFault.message} (${live.frameFaults} frames)`, true)
      : '') +
    statRow('Repaints', `${perf.fullRepaints} full / ${perf.partRepaints} part`) +
    statRow('Repainting', live.repaintPass && live.tiles
      ? `${live.tiles.list.length - live.repaintPass.todo.size} / ${live.tiles.list.length} chunks`
      : 'idle', !!live.repaintPass) +
    statRow('Drawing from', drawing) +
    statRow('Chunks drawn', visible) +
    statRow('Zoom', `${view.scale.toFixed(2)}  (${Math.round(view.scale * 100)}%)`) +
    statRow('Cursor', debug.cursor
      ? `x ${debug.cursor.x}, y ${debug.cursor.y}` +
      `${debug.cursor.copy ? ` (copy ${debug.cursor.copy > 0 ? '+' : ''}${debug.cursor.copy})` : ''}` +
      `${debug.cursor.y < 0 || debug.cursor.y >= state.world.height ? ' — off the map' : ''}`
      : '—') +
    statRow('Sea subregions', state.world.subs
      ? `${(state.world.subs.atIndex.length - 1).toLocaleString()} drawn`
      + `${state.hoveredSub ? `, over ${state.hoveredSub}` : ''}`
      : 'none — run: node test/sync-provinces.js --regen-sea-subs --write --cache') +
    statRow('Highlighted', [
      state.selected ? `province ${state.selected} ${ringShape(state)}` : null,
      state.county ? `county ${state.county.id} ${ringShape(state.county)}` : null,
    ].filter(Boolean).join(' + ') || 'nothing') +
    statRow('Rivers', state.world.rivers
      ? `${cityFade(F_RIVER).toFixed(2)} @ ${RIVER_AT}, ${RIVER_ALPHA} when full`
      : 'no rivers.png') +
    statRow('City icons', `${cityFade(F_CITY).toFixed(2)} @ ${CITY_AT}`) +
    statRow('Capital icons', `${cityFade(F_CAPITAL).toFixed(2)} @ ${CAPITAL_AT}`) +
    statRow('City names', `${cityFade(F_CITY_NAME).toFixed(2)} @ ${CITY_NAME_AT}`) +
    statRow('Capital names', `${cityFade(F_CAPITAL_NAME).toFixed(2)} @ ${CAPITAL_NAME_AT}`) +
    statRow('Load', `${perf.load.ms.toFixed(0)} ms ${perf.load.cached ? '(cached)' : '(computed)'}`, !perf.load.cached) +
    (state.showProvinceNames ? statRow('Names shown', `${debug.names} / ${state.world.byId.size}`) : '') +
    (state.showSeaNames && state.world.sea
      ? statRow('Sea names shown', `${debug.seaNames} / ${state.world.sea.byId.size}`) : '');
}

// One-off summary of the loaded map.
function showStats(w) {
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
    statRow('Counties', w.counties
      ? `${(w.counties.atIndex.length - 1).toLocaleString()} in ${w.byId.size} provinces`
      : 'none', !w.counties) +
    statRow('Sea regions', w.sea
      ? `${w.sea.atIndex.length - 1} (${w.sea.atIndex.slice(1).filter((r) => r.lake).length} lakes)`
      : 'none', !w.sea) +
    statRow('Polities', w.table.polities.length - 1) +
    statRow('Labels', `${w.labels.filter(Boolean).length} / ${w.labels.length} blocks`) +
    statRow('Chunks', live.tiles ? `${live.tiles.cols} &times; ${live.tiles.rows} @ ${TILE}px` : 'not built yet') +
    statRow('Overview', `${live.overview.canvas.width} &times; ${live.overview.canvas.height}`) +
    statRow('Cities', w.cities.length
      ? `${w.cities.length} (${w.cities.filter((c) => c.capital).length} capital)`
      : 'none', !w.cities.length) +
    statRow('Satellite', w.satellite ? `${w.satellite.width} &times; ${w.satellite.height}` : 'none',
      !!w.satellite && (w.satellite.width !== w.width || w.satellite.height !== w.height)) +
    statRow('Empty', empty, empty > 0);
}

export { BUILD, ringShape, READOUT_MS, statRow, updateReadout, showStats };
