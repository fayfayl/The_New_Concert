/*
 * Every button makes a sound, immediately, and nothing else does.
 *
 * Two things here are invisible from the screen and so go wrong silently.
 *
 * The handler is delegated: one listener on document, keyed on closest('button').
 * Nothing on screen changes when that stops matching.
 *
 * And the sound has to be a decoded buffer, not an Audio element. An element was
 * the first attempt and was audibly late, because play() is asynchronous and
 * currentTime = 0 forces a seek. A regression to that path would still play the
 * sound, still pass any test that only asked whether it played, and still be
 * wrong. So this reads the graph that was built, not just the noise.
 *
 *   node --max-old-space-size=6144 test/button-sound.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire, sounds, expectedOffset } from './dom-shim.mjs';

const problems = [];
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = install(root);

process.on('uncaughtException', (e) => problems.push(['uncaught', e]));

// A throw at the top level of a module is caught by the handler above and then
// the module simply stops, so everything below it never runs, the summary never
// prints and the process exits 0. A test that dies halfway would report as a
// pass. This is the backstop: the last line of the file sets `finished`, and
// anything else means it did not get there.
let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.log(`\nFAIL  the test stopped before the end`);
  for (const [w, e] of problems) console.log(`  ${w}: ${e.stack || e.message}`);
  process.exitCode = 1;
});
process.on('unhandledRejection', (e) => problems.push(['rejection', e]));

const t0 = Date.now();
await import('../src/main.js');

const run = (n) => {
  for (let i = 0; i < n; i++) {
    const queued = dom.frameQueue.splice(0, dom.frameQueue.length);
    if (!queued.length) break;
    for (const fn of queued) {
      try { fn(performance.now()); } catch (e) { problems.push(['frame', e]); return; }
    }
  }
};

for (let i = 0; i < 400 && !dom.frameQueue.length; i++) await new Promise((r) => setTimeout(r, 50));
console.log(`booted in ${Date.now() - t0}ms`);
fire(dom.el('start-enter'), 'click');
run(40);

// loadSounds() is deliberately not awaited by the caller, so give the fetch and
// the decode a moment to land before reading any of it back.
for (let i = 0; i < 100 && !sounds.decoded; i++) await new Promise((r) => setTimeout(r, 10));

const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) problems.push(['check', new Error(msg)]);
};

// ----------------------------------------------------------------- the graph
ok(sounds.contexts === 1, `one audio context, built once (${sounds.contexts})`);
// Every sound the game ships is decoded once at load, and pressing a button
// never decodes anything. Counted off the folder, so adding a fourth sound does
// not break this.
const shipped = fs.readdirSync(path.join(root, 'data/sfx')).filter((n) => n.endsWith('.ogg'));
const decodedAtLoad = sounds.decoded;
ok(decodedAtLoad === shipped.length,
  `each of the ${shipped.length} sounds is decoded once at load (${decodedAtLoad}): ${shipped.join(", ")}`);
ok(sounds.gain !== null, 'a gain node exists');
ok(sounds.gain && sounds.gain.gain.value > 0 && sounds.gain.gain.value < 1,
  `it plays under full volume: ${sounds.gain && sounds.gain.gain.value}`);
ok(sounds.gain && sounds.gain.to && sounds.gain.to.kind === 'destination',
  'the gain reaches the destination, so the sound is audible at all');

// ------------------------------------------------------------- a real button
sounds.reset();
const button = globalThis.document.createElement('button');
fire(globalThis.document, 'pointerdown', { target: button });
ok(sounds.started.length === 1, `a button press starts one source (${sounds.started.length})`);

// The PRESS makes the sound. A click arrives when the button comes back up, so
// answering it meant the sound waited for the release: press and hold, and it
// landed whenever you let go. That was most of the delay, and no amount of
// audio work would have found it, because the audio was always prompt about
// answering the wrong event.
//
// A mouse click carries detail 1 and must be ignored, or every press sounds
// twice.
sounds.reset();
fire(globalThis.document, 'click', { target: button, detail: 1 });
ok(sounds.started.length === 0, 'the click that follows a mouse press is ignored');

// Keyboard is the exception. Enter on a focused button sends a click and no
// pointer event at all, and it carries detail 0.
sounds.reset();
fire(globalThis.document, 'click', { target: button, detail: 0 });
ok(sounds.started.length === 1, 'Enter on a focused button still sounds');

sounds.reset();
fire(globalThis.document, 'pointerdown', { target: button });
ok(sounds.resumed >= 1, 'the first press resumes the context, which starts suspended');

// --------------------------------------------------------- the silence trim
// Latency the listener cannot tell apart from a slow interface. The fake decoder
// puts 1000 samples of silence at the head on purpose, so a trim that has been
// removed shows up here as an offset of 0.
// The trim lands a little BEFORE the onset on purpose, by SFX_PREROLL, so the
// attack survives it. A click that begins at its loudest sounds like a tick.
// So the window is: past most of the silence, and not past the onset itself.
const started = sounds.started[0] || {};
const offset = started.offset ?? -1;
ok(offset > expectedOffset * 0.5,
  `it skips the leading silence: offset ${(offset * 1000).toFixed(1)}ms of ${(expectedOffset * 1000).toFixed(1)}ms`);
ok(offset <= expectedOffset,
  `and stops short of the attack, so the click keeps its edge: ${((expectedOffset - offset) * 1000).toFixed(1)}ms of pre-roll`);
// Scheduled on the audio clock, not through a timer, so the hold is the same
// few milliseconds every time and not whatever the main thread was doing. The
// hold itself is set by ear through game.clickDelay(ms) and is 0 at the moment,
// so what has to hold is that the schedule matches the knob, not that it is any
// particular number.
ok(started.when > 0, `it is scheduled on the context clock: when ${started.when}`);
const held = started.when - (started.now ?? 0);
const want = globalThis.window.game.clickDelay() / 1000;
// The two samples are taken a tick apart, so the difference carries the clock
// as well as the hold. A few milliseconds of slack covers that.
ok(held >= want && held - want < 0.005,
  `and held by what clickDelay asks for: ${(held * 1000).toFixed(0)}ms scheduled, ${(want * 1000).toFixed(0)}ms asked`);

// -------------------------------------------------------------- overlapping
// A source node is single use. Four presses must make four of them, or a run of
// presses collapses into one clipped tick.
sounds.reset();
for (let i = 0; i < 4; i++) {
  fire(globalThis.document, 'pointerdown', { target: globalThis.document.createElement('button') });
}
ok(sounds.started.length === 4, `four presses start four sources (${sounds.started.length})`);

// ------------------------------------------------------- what must stay quiet
const quiet = (label, target) => {
  sounds.reset();
  fire(globalThis.document, 'pointerdown', { target });
  ok(sounds.started.length === 0, label);
};

const disabled = globalThis.document.createElement('button');
disabled.disabled = true;
quiet('a disabled button is silent', disabled);
quiet('a div is silent', globalThis.document.createElement('div'));
quiet('the canvas is silent, so panning the map does not click at you', dom.el('map'));

// A button reached through a child still counts, which is what closest() is for:
// the label inside a button is what the pointer actually lands on.
sounds.reset();
const label = globalThis.document.createElement('span');
label.parentElement = globalThis.document.createElement('button');
fire(globalThis.document, 'pointerdown', { target: label });
ok(sounds.started.length === 1, 'a press on something inside a button still plays');

// -------------------------------------------------------------------- report
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const [where, e] of problems) console.log(`  ${where}: ${e.message}`);
  process.exit(1);
}
ok(sounds.decoded === decodedAtLoad,
  `and no press decoded anything further (${sounds.decoded} against ${decodedAtLoad})`);

console.log('\nevery button makes a sound, on the next audio callback');
finished = true;
