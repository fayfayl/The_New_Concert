/*
 * The tooltip's clock, with the pointer held still.
 *
 * The tooltip is built on mousemove and nowhere else, so the local time in it
 * was the time at the moment it opened and stayed that way however long the game
 * clock ran. Nudging the mouse one pixel fixed it, which is what made it look
 * like the tooltip worked.
 *
 * So: hover once, then never touch the mouse again, run the clock, and watch the
 * time in the tooltip change on its own.
 *
 *   node --max-old-space-size=6144 test/tooltip-time.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire } from './dom-shim.mjs';

const problems = [];
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = install(root);

process.on('uncaughtException', (e) => problems.push(['uncaught', e]));
process.on('unhandledRejection', (e) => problems.push(['rejection', e]));

// The load runs on the real clock: it budgets its own work with performance.now
// and holding that still during boot would stall it. The controllable one is
// swapped in afterwards, once there is a map to hover.
const realNow = performance.now.bind(performance);
let clockMs = 0;

const t0 = Date.now();
await import('../src/main.js');

const run = (n) => {
  let ran = 0;
  for (let i = 0; i < n; i++) {
    const queued = dom.frameQueue.splice(0, dom.frameQueue.length);
    if (!queued.length) break;
    for (const fn of queued) {
      try { fn(clockMs); ran++; } catch (e) { problems.push(['frame', e]); return ran; }
    }
  }
  return ran;
};

// The load awaits fetches, decodes and the cache, so it is waited for in real
// time exactly as the smoke test waits for it.
for (let i = 0; i < 400 && !dom.frameQueue.length; i++) await new Promise((r) => setTimeout(r, 50));
console.log(`booted in ${Date.now() - t0}ms`);
clockMs = realNow();
performance.now = () => clockMs;
run(60);

// Into the game. The clock does not run while the start menu is up — see
// clockRunning — so without this the world never moves and the test would pass
// or fail for the wrong reason.
fire(dom.el('start-enter'), 'click');
run(30);
const started = document.getElementById('start')?.classList.contains('gone');
console.log(`start menu dismissed: ${started === true}`);
if (started !== true) problems.push(['start', new Error('the start menu did not go away, so the clock cannot run')]);

const canvas = dom.el('map');
const tooltip = dom.el('tooltip');

// Somewhere on land, found by hovering until the tooltip names a time. The sea
// has no local time, which is exactly the case this must not be testing.
const timeIn = (html) => (String(html).match(/\b([0-2]\d:[0-5]\d)\b/) || [])[1] || null;

let found = null;
outer:
for (let y = 100; y < 800 && !found; y += 37) {
  for (let x = 100; x < 1500; x += 53) {
    fire(canvas, 'mousemove', { clientX: x, clientY: y });
    run(2);
    if (!tooltip.hidden && timeIn(tooltip.innerHTML)) { found = { x, y }; break outer; }
  }
}

if (!found) {
  problems.push(['hover', new Error('no land found under any hover, so there was nothing to time')]);
} else {
  const opened = timeIn(tooltip.innerHTML);
  console.log(`hovered ${found.x},${found.y} — the tooltip opened at ${opened}`);

  // The clock, started and left alone. THE MOUSE IS NOT TOUCHED AGAIN from here:
  // any mousemove would rebuild the tooltip and prove nothing.
  const played = fire(dom.el('clock-play'), 'click');
  if (!played) problems.push(['clock', new Error('the play button is not wired')]);
  const face = () => String(dom.el('clock-face').textContent || '');
  const faceBefore = face();

  // A tick is twenty game minutes and the fastest speed is one every 33ms, so a
  // few seconds of clock is many ticks whatever speed it starts at.
  const seen = new Set([opened]);
  for (let step = 0; step < 240; step++) {
    clockMs += 50;
    run(1);
    const t = timeIn(tooltip.innerHTML);
    if (t) seen.add(t);
  }

  if (face() === faceBefore) {
    problems.push(['clock', new Error(`the clock did not move: still ${faceBefore}`)]);
  } else {
    console.log(`the clock ran: ${faceBefore} -> ${face()}`);
  }

  const now = timeIn(tooltip.innerHTML);
  console.log(`after 12s of clock and no mouse movement: ${now}`);
  console.log(`distinct times shown: ${seen.size} (${[...seen].slice(0, 6).join(', ')}${seen.size > 6 ? ', …' : ''})`);

  if (tooltip.hidden) problems.push(['tooltip', new Error('the tooltip closed on its own')]);
  if (seen.size < 2) {
    problems.push(['tooltip', new Error(
      `the time never changed: still ${now} after 12s of clock. It only updates on mousemove.`)]);
  }
  // It must still be describing the same province, not have been rebuilt into
  // something else.
  if (!String(tooltip.innerHTML).includes('class="sub"')) {
    problems.push(['tooltip', new Error('the tooltip lost its markup when the time was rewritten')]);
  }
}

console.log();
if (!problems.length) {
  console.log('the tooltip keeps its own time');
} else {
  console.log(`${problems.length} problem(s):\n`);
  for (const [where, e] of problems.slice(0, 4)) console.log(`  [${where}] ${e && e.message}`);
}
process.exit(problems.length ? 1 : 0);
