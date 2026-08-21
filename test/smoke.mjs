/*
 * Boots the map headlessly, runs frames, and switches every map mode.
 *
 * The point is the frame loop. A throw inside requestAnimationFrame kills it
 * silently: the canvas stops updating while the event handlers carry on, so the
 * map looks frozen while the tooltip still answers, and nothing anywhere says
 * why. This runs the same loop and reports the first thing that throws.
 *
 *   node --max-old-space-size=6144 test/smoke.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { install } from './dom-shim.mjs';

const problems = [];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const dom = install(root);

process.on('uncaughtException', (e) => problems.push(['uncaught', e]));
process.on('unhandledRejection', (e) => problems.push(['rejection', e]));

// The loop catches its own faults now so that one bad frame cannot end the
// program, which means the test has to listen for the report rather than for the
// throw. Anything else console.error says is passed through.
const realError = console.error;
console.error = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('The render loop threw')) {
    problems.push(['render loop', a[1] instanceof Error ? a[1] : new Error(String(a[1]))]);
    return;
  }
  realError(...a);
};

const t0 = Date.now();
try {
  await import('../src/main.js');
} catch (e) {
  problems.push(['boot', e]);
}

// Let the load settle: it awaits fetches, decodes and the cache.
for (let i = 0; i < 400 && !dom.frameQueue.length; i++) await new Promise((r) => setTimeout(r, 50));
console.log(`booted in ${Date.now() - t0}ms, ${dom.frameQueue.length} frame(s) queued`);

/** Runs n frames, draining whatever requestAnimationFrame the last one queued. */
function run(n, label) {
  let ran = 0;
  for (let i = 0; i < n; i++) {
    const queued = dom.frameQueue.splice(0, dom.frameQueue.length);
    if (!queued.length) break;
    for (const fn of queued) {
      try { fn(performance.now()); ran++; } catch (e) { problems.push([`${label} frame ${ran}`, e]); return ran; }
    }
  }
  return ran;
}

console.log(`initial frames: ${run(30, 'load')} ran`);

for (const button of dom.modeButtons) {
  const mode = button.dataset.mode;
  // The toolbar listens on the bar, not the button, so go through the same path
  // a click takes: the handler reads ev.target.closest('button[data-mode]').
  const bar = dom.el('toolbar');
  const ev = { target: { closest: (sel) => (sel.includes('data-mode') ? button : null) } };
  const { fire } = await import('./dom-shim.mjs');
  const clicked = fire(bar, 'click', ev);
  const frames = run(120, mode);
  console.log(`  ${mode.padEnd(9)} click ${clicked ? 'delivered' : 'NOT WIRED'}, ${String(frames).padStart(3)} frames`);
}

// The whole zoom range, because several layers size themselves from it and the
// faults they have are the kind that only appear at one end. The night mask lays
// itself out as however many periods the window needs, which is one at 16x and
// three at 0.25x on a wide window; getting that count wrong reads past the end of
// the strip, which is a seam rather than a crash.
{
  const { fire: fireEv } = await import('./dom-shim.mjs');
  const canvas = dom.el('map');
  let wheels = 0;
  for (const [n, delta] of [[24, 120], [40, -120], [24, 120]]) {
    for (let i = 0; i < n; i++) {
      if (fireEv(canvas, 'wheel', { deltaY: delta, clientX: 800, clientY: 450 })) wheels++;
      run(2, `zoom ${delta > 0 ? 'out' : 'in'} ${i}`);
    }
  }
  console.log(`zoom sweep: ${wheels} wheel event(s)`);
  if (!wheels) problems.push(['zoom', new Error('the wheel is not wired')]);
}

// The rivers layer, which is a file that may simply not be there and a fade that
// has to be doing something. Read out of the debug panel, since that is the only
// place either fact is visible from outside.
{
  const { fire: fireEv } = await import('./dom-shim.mjs');
  // The button rather than the backtick key: window-level listeners are not
  // recorded by the shim, so a keydown reaches nothing.
  if (!fireEv(dom.el('toggle-panel'), 'click')) {
    problems.push(['rivers', new Error('the debug button is not wired, so nothing below can be read')]);
  }
  run(4, 'open the panel');

  const riversRow = () => {
    const m = String(dom.el('perf').innerHTML || '').match(/Rivers<\/span><span[^>]*>([^<]*)</);
    return m ? m[1].trim() : null;
  };

  // Zoomed all the way in, then all the way out, reading the fade at each end.
  //
  // Both waits are real time and both are needed. The fade advances by elapsed
  // milliseconds rather than by frames, so running a hundred frames in a tenth of
  // a millisecond moves it barely at all; and the panel only rewrites itself
  // every READOUT_MS, so reading it straight after gives the value from before
  // the zoom. Without the wait this read exactly backwards and looked like the
  // fade was inverted.
  const canvas = dom.el('map');
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const at = async (delta, n) => {
    for (let i = 0; i < n; i++) { fireEv(canvas, 'wheel', { deltaY: delta, clientX: 800, clientY: 450 }); run(2); }
    await settle();
    run(10);
    return riversRow();
  };

  const near = await at(-120, 40);       // deltaY is negative for a zoom IN
  const far = await at(120, 40);
  console.log(`rivers: zoomed in "${near}", zoomed out "${far}"`);

  if (near === null) {
    problems.push(['rivers', new Error('the debug panel has no Rivers row')]);
  } else if (near.includes('no rivers.png')) {
    problems.push(['rivers', new Error('data/img/rivers.png did not load — run: node sync-provinces.js --rivers --write')]);
  } else {
    const fade = (t) => Number((String(t).match(/^([0-9.]+)/) || [])[1]);
    if (!(fade(near) > 0.9)) {
      problems.push(['rivers', new Error(`zoomed in the rivers read "${near}", so they never faded in`)]);
    }
    if (!(fade(far) < 0.1)) {
      problems.push(['rivers', new Error(`zoomed out the rivers read "${far}", so they never faded away`)]);
    }
  }
}

// The sea subregions in the Navy layer. They come out of the map cache like the
// counties do, and a cache built before they existed simply has none — which
// draws whole regions and looks completely normal, so it needs asserting.
{
  const { fire: fireEv } = await import('./dom-shim.mjs');
  fireEv(dom.el('toggle-panel'), 'click');
  run(4);
  await new Promise((r) => setTimeout(r, 300));
  run(6);
  const m = String(dom.el('perf').innerHTML || '').match(/Sea subregions<\/span><span[^>]*>([^<]*)</);
  const said = m ? m[1].trim() : null;
  console.log(`sea subregions: ${said}`);
  if (!said) problems.push(['navy', new Error('the debug panel has no Sea subregions row')]);
  else if (said.startsWith('none')) problems.push(['navy', new Error(`the subregion layer did not load: ${said}`)]);
  else if (!/^[0-9,]+ drawn/.test(said)) problems.push(['navy', new Error(`the row reads "${said}"`)]);
  fireEv(dom.el('toggle-panel'), 'click');
  run(4);
}

// Every blit that read outside its source. See checkSource in the shim.
{
  const { blitFaults } = await import('./dom-shim.mjs');
  const seen = [...new Set(blitFaults)];
  console.log(`blits reading off the end of their source: ${blitFaults.length}`
    + (seen.length ? ` (${seen.length} distinct)` : ''));
  for (const f of seen.slice(0, 6)) problems.push(['blit', new Error(f)]);
}

console.log();
if (!problems.length) {
  console.log('no exception in any frame');
} else {
  console.log(`${problems.length} problem(s):\n`);
  for (const [where, e] of problems.slice(0, 4)) {
    console.log(`  [${where}] ${e && e.message}`);
    if (e && e.stack) console.log(e.stack.split('\n').slice(1, 5).map((l) => '      ' + l.trim()).join('\n'));
    console.log();
  }
}
process.exit(problems.length ? 1 : 0);
