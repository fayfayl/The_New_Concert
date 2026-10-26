// Advancing the clock and its controls.

const VERSION = new URL(import.meta.url).search;
const { MAX_TICKS_PER_FRAME, RUNDEAN_MONTHS, SPEEDS, clock, clockDate, els, invalidateView, runDays, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let NIGHT_MIN_MS, buildNightMask, clamp, mapIsShowing, pauseOpen;
export function link(all) { ({ NIGHT_MIN_MS, buildNightMask, clamp, mapIsShowing, pauseOpen } = all); }

// Whether time is passing: unpaused, map showing, no pause menu.
const clockRunning = () => !clock.paused && mapIsShowing() && !pauseOpen();

// Turns elapsed real time into whole ticks, carrying the remainder.
function advanceClock(now) {
  const elapsed = clock.last ? now - clock.last : 0;
  clock.last = now;
  if (!clockRunning()) return;

  const ms = SPEEDS[clock.speed - 1];
  clock.carry += elapsed;

  let ticked = 0;
  while (clock.carry >= ms && ticked < MAX_TICKS_PER_FRAME) {
    clock.carry -= ms;
    clock.tick++;
    ticked++;
  }
  if (clock.carry > ms * MAX_TICKS_PER_FRAME) clock.carry = ms * MAX_TICKS_PER_FRAME;

  if (ticked) {
    clock.ticked += ticked;
    applyClock();
    runDays();
  }
}

// Sets the world to the state for the current tick.
function applyClock() {
  const at = clockDate(clock.tick);

  live.sunUtcHour = at.hour + at.minute / 60;
  live.sunDayOfYear = at.dayOfYear;

  const mask = state.world?.nightMask;
  if (state.world && (!mask || mask.dayOfYear !== at.dayOfYear)) {
    state.world.nightMask = buildNightMask(state.world, at.dayOfYear);
  }

  updateClockFace(at);

  if (state.showNight) {
    const now = performance.now();
    if (now - live.nightDrawnAt >= NIGHT_MIN_MS) {
      live.nightDrawnAt = now;
      invalidateView();
    }
  }
}

// Writes the clock face as `15:00, 10 Ungerbruni 1926`.
function updateClockFace(at) {
  const hh = String(at.hour).padStart(2, '0');
  const mm = String(at.minute).padStart(2, '0');
  els.clockFace.textContent = `${hh}:${mm}, ${at.day} ${RUNDEAN_MONTHS[at.month]} ${at.year}`;
}

// Reflects the run state and the speed on the plate.
function updateClockControls() {
  els.clock.classList.toggle('running', !clock.paused);
  els.clockPlay.setAttribute('aria-pressed', String(!clock.paused));
  els.clockPlay.title = clock.paused ? 'Resume (Space)' : 'Pause (Space)';

  els.clockSlower.disabled = clock.speed <= 1;
  els.clockFaster.disabled = clock.speed >= SPEEDS.length;
  els.clockSlower.title = `Slower (now ${clock.speed} of ${SPEEDS.length})`;
  els.clockFaster.title = `Faster (now ${clock.speed} of ${SPEEDS.length})`;
}

function setSpeed(speed) {
  const want = clamp(Math.round(speed), 1, SPEEDS.length);
  if (want === clock.speed) return;
  clock.speed = want;
  updateClockControls();
}

function setPaused(paused) {
  if (clock.paused === paused) return;
  clock.paused = paused;
  updateClockControls();
}

export { clockRunning, advanceClock, applyClock, updateClockFace, updateClockControls, setSpeed, setPaused };
