// Shared state, DOM handles, the clock's data and the change and daily hooks every module uses.

const VERSION = new URL(import.meta.url).search;

// Values several modules reassign, held on one object so every module reads the current one.
export const live = {};

// Functions from other modules, filled in by main.js once every module has loaded.
let diploOpen, openDiplo, ratioFor, tooBigToLight, updateCard, updatePanel, view;
export function link(all) { ({ diploOpen, openDiplo, ratioFor, tooBigToLight, updateCard, updatePanel, view } = all); }

// Reads a custom property from :root in style.css.
const rootStyle = getComputedStyle(document.documentElement);
function cssToken(name) {
  const v = rootStyle.getPropertyValue(name).trim();
  if (!v) console.warn(`style.css defines no ${name} on :root`);
  return v;
}

const UNKNOWN_POLITY = { id: '?', name: 'Unknown', colour: [90, 90, 96] };

// Change registry: caches to clear and figures to rebuild on world change.
const onWorldForget = [];
const onWorldDerive = [];
function forgetOnChange(forget) { onWorldForget.push(forget); }
function deriveOnChange(derive) { onWorldDerive.push(derive); }

function worldChanged() {
  const w = state.world;
  if (!w) return;
  for (const forget of onWorldForget) forget(w);
  for (const derive of onWorldDerive) derive(w);
  if (state.selected) updateCard();
  updatePanel();
  // Redraws the open file in place without the selection sound.
  if (state.diplo && diploOpen()) {
    live.quietSelect = true;
    try { openDiplo(state.diplo); } finally { live.quietSelect = false; }
  }
  invalidateView();
}

const els = {
  canvas: document.getElementById('map'),
  tooltip: document.getElementById('tooltip'),
  wrap: document.getElementById('canvas-wrap'),
  panel: document.getElementById('panel'),
  toggles: document.getElementById('toggles'),
  perf: document.getElementById('perf'),
  selName: document.getElementById('sel-name'),
  selBody: document.getElementById('sel-body'),
  government: document.getElementById('government'),
  neighbours: document.getElementById('neighbours'),
  card: document.getElementById('card'),
  diplo: document.getElementById('diplo'),
  diploName: document.getElementById('diplo-name'),
  diploFlag: document.getElementById('diplo-flag'),
  diploPolity: document.getElementById('diplo-polity'),
  diploFaction: document.getElementById('diplo-faction'),
  diploLeader: document.getElementById('diplo-leader'),
  diploPortrait: document.getElementById('diplo-portrait'),
  diploStability: document.getElementById('diplo-stability'),
  diploManpower: document.getElementById('diplo-manpower'),
  diploParty: document.getElementById('diplo-party'),
  diploIdeology: document.getElementById('diplo-ideology'),
  diploElection: document.getElementById('diplo-election'),
  diploFocus: document.getElementById('diplo-focus'),
  diploSpirits: document.getElementById('diplo-spirits'),
  diploTabDiplomacy: document.getElementById('diplo-tab-diplomacy'),
  diploTabLedger: document.getElementById('diplo-tab-ledger'),
  diploPaneDiplomacy: document.getElementById('diplo-pane-diplomacy'),
  diploPaneLedger: document.getElementById('diplo-pane-ledger'),
  diploRelations: document.getElementById('diplo-relations'),
  diploActions: document.getElementById('diplo-actions'),
  diploLedgerLeft: document.getElementById('diplo-ledger-left'),
  diploLedgerRight: document.getElementById('diplo-ledger-right'),
  countyCard: document.getElementById('county-card'),
  countyName: document.getElementById('county-name'),
  countyPolity: document.getElementById('county-polity'),
  countyProvince: document.getElementById('county-province'),
  countyOwner: document.getElementById('county-owner'),
  countyFlag: document.getElementById('county-flag'),
  countyTerrain: document.getElementById('county-terrain'),
  countyClimate: document.getElementById('county-climate'),
  countyFort: document.getElementById('county-fort'),
  countyRail: document.getElementById('county-rail'),
  countyArea: document.getElementById('county-area'),
  cardName: document.getElementById('card-name'),
  cardPolity: document.getElementById('card-polity'),
  cardRole: document.getElementById('card-role'),
  cardOwner: document.getElementById('card-owner'),
  cardFlag: document.getElementById('card-flag'),
  cardClaims: document.getElementById('card-claims'),
  cardPop: document.getElementById('card-pop'),
  cardArea: document.getElementById('card-area'),
  cardGrid: document.getElementById('card-grid'),
  cardHappyRow: document.getElementById('card-happy-row'),
  cardHappy: document.getElementById('card-happy'),
  cardHappyFill: document.getElementById('card-happy-fill'),
  cardHappyNote: document.getElementById('card-happy-note'),

  cardUnrestRow: document.getElementById('card-unrest-row'),
  cardUnrest: document.getElementById('card-unrest'),
  cardUnrestFill: document.getElementById('card-unrest-fill'),
  cardUnrestBar: document.getElementById('card-unrest-bar'),
  cardUnrestNote: document.getElementById('card-unrest-note'),

  cardSlots: document.getElementById('card-slots'),
  cardSlotsN: document.getElementById('card-slots-n'),
  cardCivN: document.getElementById('card-civ-n'),
  cardMilN: document.getElementById('card-mil-n'),
  stats: document.getElementById('stats'),
  toolbar: document.getElementById('toolbar'),
  zoomLevel: document.getElementById('zoom-level'),
  pause: document.getElementById('pause'),
  clock: document.getElementById('clock'),
  clockFace: document.getElementById('clock-face'),
  clockPlay: document.getElementById('clock-play'),
  clockSlower: document.getElementById('clock-slower'),
  clockFaster: document.getElementById('clock-faster'),
};

const state = {
  mode: 'political',      // which of MODES colours the map
  selected: null,         // province id, or null
  hovered: null,          // province id, or null
  selectedSea: null,      // sea region id, or null. Navy mode only
  selectedSub: null,      // sea subregion id, or null. Navy mode only
  hoveredSub: null,       // the same, under the pointer
  county: null,           // County under the right button
  diplo: null,            // Polity id whose diplomacy panel is open
  hoveredSea: null,       // sea region id, or null
  world: null,            // the model from buildWorld(), once loaded
  silhouette: null,       // Selected province's traced shape
  outline: null,          // Outline ring built from the silhouette
  fade: null,             // Dropped selection still fading out

  // Overlay switches, toggled from the debug menu.
  satellite: false,       // Satellite imagery under the province colours
  showNight: true,        // Night terminator and city lights
  showRivers: true,       // Rivers over the ground, from RIVER_AT up
  showCities: true,
  showLabels: true,
  showProvinceNames: false,
  showSeaNames: false,
  showChunks: false,
  showAdjacency: false,
  showBounds: false,
  showCoastal: false,
  showSeams: false,
};

// Redraw flags, consumed once per frame.
live.bufferDirty = true;               // EVERY province changed: repaint the whole buffer
live.repaintPass = null;               // Full repaint in progress, spread over frames
live.viewDirty = true;                 // only the pan/zoom changed: re-blit alone will do
const dirtyProvinces = new Set();     // just these changed: repaint their boxes only
const dirtyBoxes = [];                // Map rectangles to repaint
// Requests a full repaint or a re-blit.

const invalidateBuffer = () => { live.bufferDirty = true; };
const invalidateView = () => { live.viewDirty = true; els.zoomLevel.textContent = `${Math.round(view.scale * 100)}%`; };

// Marks provinces for a pixel repaint, skipping those too big to light.
function invalidateProvinces(...ids) {
  for (const id of ids) {
    if (id && !tooBigToLight(state.world, id)) dirtyProvinces.add(id);
  }
}

// Running-average timings and tallies for the debug Performance block.
const perf = { resources: 0, frameMs: 0, draw: 0, paint: 0, fullRepaints: 0, partRepaints: 0, lastFrame: 0, load: null, maskBuilds: 0, night: 0, cities: 0, labels: 0, ringDraw: 0, ringBuild: 0, ringBuilds: 0, ringPx: 0, frameJs: 0 };
const ease = (was, now) => (was ? was * 0.9 + now * 0.1 : now);

// True when the canvas's CSS box no longer matches its pixel buffer.
function canvasResized() {
  const dpr = ratioFor(els.canvas.clientWidth, els.canvas.clientHeight);
  return els.canvas.width !== Math.round(els.canvas.clientWidth * dpr)
    || els.canvas.height !== Math.round(els.canvas.clientHeight * dpr);
}

// The clock. One tick is 20 minutes of simulated time.

const TICK_MINUTES = 20;
const TICKS_PER_HOUR = 60 / TICK_MINUTES;               // 3
const TICKS_PER_DAY = TICKS_PER_HOUR * 24;              // 72

// Tick 0: 10 Ungerbruni 1926, 00:00 UTC.
const CLOCK_EPOCH = Date.UTC(1926, 5, 10);
const DAY_MS = 86400000;

// Real milliseconds per tick, slowest first.
const SPEEDS = [333, 100, 33];
// Shows the speed key range in the controls list.
{
  const keys = document.getElementById('speed-keys');
  if (keys) keys.textContent = `1 to ${SPEEDS.length}`;
}

// Most ticks one frame may run; past it the clock falls behind.
const MAX_TICKS_PER_FRAME = 12;

// Rundean month names over the Gregorian calendar.
const RUNDEAN_MONTHS = [
  'Mithalvan', 'Sithvan', 'Ungertre', 'Mithaltre', 'Sithtre', 'Ungerbruni',
  'Mithalbruni', 'Sithbruni', 'Ungergull', 'Mithalgull', 'Sithgull', 'Ungervan',
];

const clock = {
  tick: 0,
  speed: 2,             // index into SPEEDS, from 1
  paused: true,
  carry: 0,             // real milliseconds not yet worth a whole tick
  last: 0,              // when time was last read
  ticked: 0,            // Total ticks run
  rateFrom: 0,
  day: 0,               // last whole day the daily handlers ran for
  tickDone: 0,          // last tick the tick handlers ran for
};

// Handlers run once for each in-game day, and once for each tick, the clock passes.
const onEveryDay = [];
function everyDay(fn) { onEveryDay.push(fn); }
const onEveryTick = [];
function everyTick(fn) { onEveryTick.push(fn); }

// Runs the handlers for each tick crossed since the last call, a new day's first.
function runDays() {
  const w = state.world;
  while (w && clock.tickDone < clock.tick) {
    const t = ++clock.tickDone;
    const day = Math.floor(t / TICKS_PER_DAY);
    if (day > clock.day) {
      clock.day = day;
      for (const fn of onEveryDay) fn(w, clock.day);
    }
    for (const fn of onEveryTick) fn(w, t);
  }
  clock.tickDone = clock.tick;
  clock.day = Math.floor(clock.tick / TICKS_PER_DAY);
}

// Calendar date and time for a tick count.
function clockDate(tick) {
  const days = Math.floor(tick / TICKS_PER_DAY);
  const minutes = (tick % TICKS_PER_DAY) * TICK_MINUTES;
  const d = new Date(CLOCK_EPOCH + days * DAY_MS);
  const year = d.getUTCFullYear();
  return {
    year,
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    dayOfYear: Math.round((d.getTime() - Date.UTC(year, 0, 1)) / DAY_MS) + 1,
  };
}

export { rootStyle, cssToken, UNKNOWN_POLITY, onWorldForget, onWorldDerive, forgetOnChange, deriveOnChange, worldChanged, els, state, dirtyProvinces, dirtyBoxes, invalidateBuffer, invalidateView, invalidateProvinces, perf, ease, canvasResized, TICK_MINUTES, TICKS_PER_HOUR, TICKS_PER_DAY, CLOCK_EPOCH, DAY_MS, SPEEDS, MAX_TICKS_PER_FRAME, RUNDEAN_MONTHS, clock, onEveryDay, everyDay, onEveryTick, everyTick, runDays, clockDate };
