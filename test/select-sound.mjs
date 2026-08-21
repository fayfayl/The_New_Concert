/*
 * Ground and water have a sound each, and one gesture makes one of them.
 *
 * The three files differ in size and the shim carries the source byte length
 * through decodeAudioData, so which sound started is a fact this can read.
 *
 * What has to hold:
 *
 *   picking a province plays province_county_selection.ogg;
 *   picking a county plays it too;
 *   a right click, which picks BOTH in one handler, plays it once;
 *   picking water in the Navy mode plays region_subregion_selection.ogg,
 *   once, although it picks a region and a subregion together;
 *   picking water outside the Navy mode plays nothing, since nothing is
 *   picked there;
 *   and clearing a selection plays nothing.
 *
 *   node --max-old-space-size=6144 test/select-sound.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire, sounds } from './dom-shim.mjs';

const problems = [];
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = install(root);

process.on('uncaughtException', (e) => problems.push(['uncaught', e]));
process.on('unhandledRejection', (e) => problems.push(['rejection', e]));

let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.log('\nFAIL  the test stopped before the end');
  for (const [where, e] of problems) console.log(`  ${where}: ${e.stack || e.message}`);
  process.exitCode = 1;
});

await import('../src/main.js');

const run = (n) => {
  for (let i = 0; i < n; i++) {
    const q = dom.frameQueue.splice(0, dom.frameQueue.length);
    if (!q.length) break;
    for (const fn of q) {
      try { fn(performance.now()); } catch (e) { problems.push(['frame', e]); return; }
    }
  }
};
for (let i = 0; i < 400 && !dom.frameQueue.length; i++) await new Promise((r) => setTimeout(r, 50));
fire(dom.el('start-enter'), 'click');
run(40);

const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) problems.push(['check', new Error(m)]); };

const game = globalThis.window.game;
const w = game.world();
const canvas = dom.el('map');

// The two files, by size, which is how the shim tells them apart.
const sizeOf = (p) => fs.statSync(path.join(root, p)).size;
const CLICK = sizeOf('data/sfx/old_radio_button.ogg');
const SELECT = sizeOf('data/sfx/province_county_selection.ogg');
// Water has two recordings and one of them is picked at random per click.
const WATER = ['data/sfx/region_subregion_selection.ogg',
  'data/sfx/region_subregion_selection_2.ogg'].map(sizeOf);
ok(new Set([CLICK, SELECT, ...WATER]).size === 2 + WATER.length,
  `every sound is a different file (${[CLICK, SELECT, ...WATER].join(", ")} bytes)`);
const shipped = fs.readdirSync(path.join(root, 'data/sfx')).filter((f2) => f2.endsWith('.ogg'));
ok(sounds.decoded === shipped.length,
  `all ${shipped.length} were decoded (${sounds.decoded})`);

const selections = () => sounds.started.filter((s) => s.bytes === SELECT).length;
const waters = () => sounds.started.filter((s) => WATER.includes(s.bytes)).length;

// A pixel a given province certainly owns, and a pixel no province owns.
const ownPixel = (id) => {
  const bb = w.bounds.get(id);
  const index = w.byId.get(id).index;
  for (let y = bb.minY; y <= bb.maxY; y++) {
    for (let x = bb.minX; x <= bb.maxX; x++) {
      if (w.provinceAt[y * w.width + x] === index) return { x, y };
    }
  }
  return null;
};
const land = new Set([...w.byId.values()].map((p) => p.index));
const seaFrom = (fromY) => {
  for (let y = fromY; y < w.height; y += 7) {
    for (let x = 0; x < w.width; x += 7) {
      if (!land.has(w.provinceAt[y * w.width + x])) return { x, y };
    }
  }
  return null;
};
const seaPixel = () => seaFrom(40);

// A second patch, far enough away to be a different subregion, so clicking
// between the two selects something new each time.
const seaPixel2 = () => seaFrom(Math.floor(w.height * 0.6));

const cx = canvas.width / 2, cy = canvas.height / 2;
const lookAndClick = (at, button = 0) => {
  game.lookAt(at.x, at.y, 8);
  run(8);
  sounds.reset();
  if (button === 2) {
    fire(canvas, 'contextmenu', { button: 2, clientX: cx, clientY: cy });
  } else {
    fire(canvas, 'mousedown', { button: 0, clientX: cx, clientY: cy });
    fire(globalThis.window, 'mouseup', { button: 0, clientX: cx, clientY: cy });
  }
  run(2);
};

// ------------------------------------------------------------------ a province
const big = [...w.byId.values()].find((p) => p.area > 50000);
ok(Boolean(big), `found a province to click (${big?.id})`);
lookAndClick(ownPixel(big.id));
ok(dom.el('card').classList.contains('open'), 'the card opens');
ok(selections() === 1, `picking a province plays the selection sound once (${selections()})`);

// Picking the SAME one again returns early and says nothing.
lookAndClick(ownPixel(big.id));
ok(selections() === 0, `picking the one already picked stays quiet (${selections()})`);

// ------------------------------------------------------------------- a county
// A right click picks the county AND the province it sits in, both in the one
// handler. That is one gesture and has to be one sound.
const other = [...w.byId.values()].find((p) => p.area > 50000 && p.id !== big.id);
lookAndClick(ownPixel(other.id), 2);
const afterRight = selections();
ok(dom.el('county-card').classList.contains('open'), 'the county card opens on a right click');
ok(afterRight === 1, `a right click plays it ONCE, not once per selection (${afterRight})`);

// -------------------------------------------------------------------- water
const sea = seaPixel();
ok(Boolean(sea), `found open water to click (${sea?.x},${sea?.y})`);

// Outside the Navy mode a click on water picks nothing at all, so it says
// nothing. It also clears whatever was selected, which is silent too.
lookAndClick(sea);
ok(selections() === 0, `clicking water plays no ground sound (${selections()})`);
ok(waters() === 0, `and no water sound outside the Navy mode (${waters()})`);

// In the Navy mode it picks the region and the subregion inside it, both from
// the one handler. That is one gesture and has to be one sound.
const pickMode = (mode) => fire(dom.el('toolbar'), 'click',
  { target: { closest: (sel) => (sel.includes('data-mode') ? { dataset: { mode } } : null) } });
pickMode('navy');
run(4);
lookAndClick(sea);
ok(waters() === 1, `picking water in the Navy mode plays it once (${waters()})`);
ok(selections() === 0, `and plays no ground sound (${selections()})`);

// The same water again changes nothing, so it says nothing.
lookAndClick(sea);
ok(waters() === 0, `picking the same water again stays quiet (${waters()})`);

// Both recordings are reachable. Picking is random, so this clicks between two
// subregions enough times that seeing only one of them would be a real result
// and not luck: 30 clicks, and one variant never coming up is a 1 in 2^29 event.
const seen = new Set();
const seaB = seaPixel2();
for (let k = 0; k < 30 && seen.size < WATER.length; k++) {
  lookAndClick(k % 2 ? seaB : sea);
  for (const st of sounds.started) if (WATER.includes(st.bytes)) seen.add(st.bytes);
}
ok(seen.size === WATER.length,
  `both recordings come up over 30 clicks (${seen.size} of ${WATER.length})`);

// Back to land, which is the other sound and not this one.
lookAndClick(ownPixel(big.id));
ok(selections() === 1, `back on land it is the ground sound (${selections()})`);
ok(waters() === 0, `and not the water one (${waters()})`);
pickMode('political');
run(4);

// ---------------------------------------------------------- clearing it again
// A DIFFERENT province, because big is the one still selected from above and
// select() returns early on the one already picked.
lookAndClick(ownPixel(other.id));
ok(selections() === 1, `picking another province plays it (${other.id})`);
sounds.reset();
fire(globalThis.document, 'keydown', { key: 'Escape' });
run(2);
ok(selections() === 0, `clearing the selection plays nothing (${selections()})`);

// -------------------------------------------------------------------- report
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const [where, e] of problems) console.log(`  ${where}: ${e.message}`);
  process.exit(1);
}
console.log('\nground and water have a sound each, and one click makes one of them');
finished = true;
