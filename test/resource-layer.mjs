/*
 * The resource layer writes what a province has, where it has it.
 *
 * A layer made entirely of text is invisible to a test that only asks whether a
 * frame threw, so the harness records every fillText and this reads them back.
 * What has to hold:
 *
 *   the figures are KNOWN deposits only, so a province whose coal is entirely
 *   unprospected writes nothing about coal;
 *   the deposit written matches resources.json;
 *   yield is 0, because development has no levels on the map yet;
 *   and each line is rasterised ONCE and blitted after, because writing them
 *   live took the blit step to 346ms and the map to 7fps.
 *
 *   node --max-old-space-size=6144 test/resource-layer.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire, texts, blits } from './dom-shim.mjs';

const problems = [];
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = install(root);

process.on('uncaughtException', (e) => problems.push(['uncaught', e]));
process.on('unhandledRejection', (e) => problems.push(['rejection', e]));

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

// A stack row: the yield over the deposit. The mark in front of it is an icon
// blitted from the sheet, so nothing of it reaches fillText. The optional word
// is the fallback the layer uses when the sheet fails to load.
const LINE = /^(?:\S+\s)?\(\d+\/\d+\)$/u;
const game = globalThis.window.game;
ok(Boolean(game), 'the app booted');

const button = globalThis.document.querySelector('button[data-mode="resources"]');
ok(Boolean(button), 'the Resources button is in the toolbar');

// The toolbar handler reads closest('button[data-mode]'), so the event carries a
// stand-in for the button that was pressed.
const pick = (mode) => fire(dom.el('toolbar'), 'click',
  { target: { closest: (sel) => (sel.includes('data-mode') ? { dataset: { mode } } : null) } });

// ------------------------------------------------------------ off by default
texts.length = 0;
game.lookAt(3000, 1300, 4);
run(20);
const before = texts.filter((t) => /\(\d+\//.test(t.t)).length;
ok(before === 0, `nothing is written until the layer is chosen (${before})`);

// -------------------------------------------------------------------- on
pick('resources');
game.lookAt(3000, 1300, 4);
texts.length = 0;
run(20);
const rows = texts.filter((t) => LINE.test(t.t));
ok(rows.length > 0, `the layer writes figures when chosen (${rows.length} lines)`);

// ------------------------------------------------------------- the format
const sample = rows[0]?.t ?? '';
ok(LINE.test(sample), `the shape is yield over deposit: ${JSON.stringify(sample)}`);
const yields = rows.map((r) => Number(r.t.match(/\((\d+)\//)[1]));
ok(yields.every((y) => y === 0), 'every yield is 0, since development has no levels yet');
const deposits = rows.map((r) => Number(r.t.match(/\/(\d+)\)/)[1]));
ok(deposits.every((d) => d > 0), 'every deposit is above 0');

// --------------------------------------------------- the figures are real
// Every deposit written has to exist as a KNOWN figure somewhere in the file.
// This is what catches a layer that reads the wrong box: unprospected, offshore
// and stranded are all deliberately absent.
const doc = JSON.parse(fs.readFileSync(path.join(root, 'data/json/resources.json'), 'utf8'));
const w = game.world();
const lines = w.resourceLines;
ok(lines.size > 1000, `the world holds a stack for ${lines.size} provinces`);
const known = new Set();
const hidden = new Set();
for (const id in doc.provinces) {
  const e = doc.provinces[id];
  for (const k of doc.kinds) if (e[k]) known.add(e[k]);
  for (const box of ['unprospected', 'offshore', 'stranded']) {
    if (e[box]) for (const k of doc.kinds) if (e[box][k]) hidden.add(e[box][k]);
  }
}
const unreal = deposits.filter((d) => !known.has(d));
ok(unreal.length === 0, `every figure written is a known deposit in the file (${unreal.length} were not)`);

// A province that holds a resource ONLY as unprospected must write nothing for
// it. Find one and check the map stays quiet about it.
const secret = Object.entries(doc.provinces).find(([, e]) => e.unprospected
  && doc.kinds.some((k) => e.unprospected[k] && !e[k]));
ok(Boolean(secret), `the file has a province hiding a resource entirely (${secret?.[0]})`);

// ------------------------------------------------------- what it costs
// Every line is baked into a bitmap once and blitted from then on, the way the
// city names are. fillText therefore counts BAKES and drawImage counts what
// reached the screen, and the two have to be read apart.
//
// The strings repeat heavily: 1,487 stacks share 232 distinct lines between
// them. A view that is holding still should bake on its first frame and nothing
// after, and that is the whole claim the cache makes.
pick('resources');
game.lookAt(3000, 1300, 4);
run(20);
texts.length = 0;
game.lookAt(3001, 1300, 4);   // one pixel: one frame, and the size has not changed
run(1);
const rebaked = texts.filter((t) => LINE.test(t.t)).length;
ok(rebaked === 0, `a steady frame bakes nothing new (${rebaked} lines re-rasterised)`);

// What the layer costs on top of the map under it, since drawImage is also how
// the chunks and the city names arrive. Measured against the same view with the
// layer off, so the chunks cancel.
const cost = (z) => {
  const at = (mode) => {
    pick(mode);
    game.lookAt(3000, 1300, z);
    run(8);
    blits.length = 0;
    game.lookAt(3001, 1300, z);
    run(1);
    return blits.length;
  };
  const off = at('political');
  return at('resources') - off;
};
const near = cost(4);
ok(near > 0, `the layer blits its lines (${near} bitmaps at zoom 4)`);

// Zooming out has to be the cheap direction, and for a while it was not: the
// line size was floated up to a 6px minimum, so a map small enough that no
// province could hold its own stack drew every one of them anyway, overlapping
// and unreadable. Below the size a line can be read at, the layer says nothing.
// 8.5 css pixels a line before zoom against a 6px floor puts the cutoff at 0.71.
const quiet = cost(0.25);
const justUnder = cost(0.6);
const justOver = cost(0.9);
// The two passes do not repaint exactly the same chunks, so the difference
// carries a few either way and a silent layer can measure a little below zero.
// NOISE is what that is worth; the gap being tested here is two orders of it.
const NOISE = 20;
ok(Math.abs(quiet) < NOISE, `world zoom writes nothing the chunks can hide (${quiet})`);
ok(Math.abs(justUnder) < NOISE, `nor does 0.6, still under the cutoff (${justUnder})`);
ok(justOver > 100, `0.9 is over it and writes in earnest (${justOver})`);

// And the far end: zoomed right in, a screen holds a couple of provinces.
const tight = cost(10);
ok(tight < near, `zoomed right in there is almost nothing on screen (${tight})`);
// ------------------------------------------------------------------ the sheet
// data/icons/resources.png is one sheet, six cells across and three down at 64px
// a cell, filled left to right and top to bottom. If it fails to load the layer
// falls back to short words and everything else in this file still passes, so
// the sheet has to be checked on its own.
const sheet = w.resourceSheet;
ok(Boolean(sheet), 'the icon sheet loaded');
ok(sheet?.width === 384 && sheet?.height === 192,
  `and it is 6 by 3 cells of 64px: ${sheet?.width}x${sheet?.height}`);

const src = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const tableSrc = /const RESOURCE_ICON = \{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
const cells = new Map();
for (const m of tableSrc.matchAll(/(\w+):\s*(\d+)/g)) cells.set(m[1], Number(m[2]));
ok(cells.size === 18, `every resource has a cell (${cells.size})`);
const missing = doc.kinds.filter((k) => !cells.has(k));
ok(missing.length === 0, `and every kind in the file is one of them (${missing.join(", ") || "none missing"})`);
const taken = [...cells.values()].sort((a, b) => a - b);
ok(taken.every((v, i) => v === i),
  `the eighteen cells are 0 to 17 with none repeated: ${taken.join(",")}`);

// -------------------------------------------------------- where it is written
// A stack is written at the province, and a centroid is not always the
// province. The centroid is the mean of the pixels, and the mean of an
// archipelago is the water between its islands: Onanlanu is 234 pixels of land
// in a 71 by 59 box, and its mean falls 15.5 pixels out to sea, two hundred
// screen pixels off the nearest shore at a close zoom. The stack was written
// there, correctly and uselessly, and panning walked it off the top of the
// window while the islands it named stayed on screen.
//
// So every anchor has to be a pixel the province actually owns. 85 of the 1,490
// stacks needed moving; the worst, Shimokoube Coast, by 457 pixels.
const W = w.width, H = w.height;
const owns = (id, x, y) => {
  const index = w.byId.get(id).index;
  return y >= 0 && y < H && w.provinceAt[Math.round(y) * W + ((Math.round(x) % W) + W) % W] === index;
};

let wasOff = 0, movedN = 0, worst = 0;
const stillOff = [];
for (const [id, stack] of lines) {
  const bb = w.bounds.get(id);
  if (!bb) continue;
  if (!owns(id, bb.cx, bb.cy)) wasOff++;
  const moved = Math.hypot(stack.ax - bb.cx, stack.ay - bb.cy);
  if (moved > 0) { movedN++; worst = Math.max(worst, moved); }
  if (!owns(id, stack.ax, stack.ay)) stillOff.push(w.byId.get(id).name);
}
ok(wasOff > 0, `the map has provinces whose centroid misses their own land (${wasOff})`);
ok(stillOff.length === 0,
  `every stack is anchored on its own province (${stillOff.length} are not: ${stillOff.slice(0, 6).join(", ")})`);
ok(movedN === wasOff, `and only those were moved: ${movedN} moved, ${wasOff} needed it`);
ok(worst > 100, `the worst was a long way out (${worst.toFixed(0)} px)`);

// Onanlanu is the one that was reported. Its stack must sit on an island.
const ona = lines.get('onanlanu');
ok(Boolean(ona), 'Onanlanu holds a stack');
ok(owns('onanlanu', ona.ax, ona.ay), 'and it is written on one of its islands');
// ------------------------------------------------------------------ the hover
// An icon says which resource it is at a glance, and a glance is not always
// enough, so pointing at a row names it. The row is found by where the layer
// actually drew it, which is the only way back from a bitmap to its subject.
//
// A province with ONE row is the one to aim at: its single row sits exactly on
// the anchor, so centring the view on the anchor puts it under the middle of
// the window and there is nothing to arithmetic about.
const canvas = dom.el('map');
const cx = canvas.width / 2, cy = canvas.height / 2;

// Selecting goes through the real path. mousedown lands on the canvas and
// mouseup on the window, which is where the handler is; Escape clears it.
const clickAt = (px, py) => {
  fire(canvas, 'mousedown', { button: 0, clientX: px, clientY: py });
  fire(globalThis.window, 'mouseup', { button: 0, clientX: px, clientY: py });
};
const clearPick = () => fire(globalThis.document, 'keydown', { key: 'Escape' });

// That a click landed, read off the card it opens. Which province it picked is
// not asked here: the view is centred on that province's own anchor, so the
// middle of the window is a pixel it owns, and what its stack does next is the
// evidence that matters.
const cardOpen = () => Boolean(dom.el('card')?.classList?.contains('open'));

// A stack row, told from a map chunk by its size: rows are tens of pixels
// across, a chunk is hundreds.
const rowsUnder = (px, py) => blits.filter((b) => b.dh > 0 && b.dh < 90 && b.dw < 260
  && px >= b.dx && px <= b.dx + b.dw && py >= b.dy && py <= b.dy + b.dh);

const drawAt = (mx, my, z) => {
  game.lookAt(mx, my, z);
  run(10);
  blits.length = 0;
  game.lookAt(mx + 0.5, my, z);
  run(1);
};
const tooltip = dom.el('tooltip');
pick('resources');

let single = null;
for (const [id, stack] of lines) {
  if (stack.length !== 1) continue;
  const bb = w.bounds.get(id);
  // Big enough that it is drawn at a comfortable zoom, and away from the seam.
  if (!bb || bb.maxX - bb.minX < 200 || bb.maxY - bb.minY < 200) continue;
  if (bb.cx < 500 || bb.cx > w.width - 500) continue;
  single = { id, stack };
  break;
}
ok(Boolean(single), `found a one-row province to aim at (${single?.id})`);

game.lookAt(single.stack.ax, single.stack.ay, 6);
run(10);
fire(canvas, 'mousemove', { clientX: cx, clientY: cy });

const shown = tooltip.innerHTML || '';
const kind = single.stack[0].kind;
const srcNames = /const RESOURCE_NAME = \{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
const proper = new RegExp(`${kind}:\\s*\x27([^\x27]+)\x27`).exec(srcNames)?.[1];
ok(Boolean(proper), `${kind} has a proper name in the source (${proper})`);
ok(!tooltip.hidden, 'pointing at a row opens the tooltip');
ok(shown.includes(proper), `and it names the resource: ${JSON.stringify(shown.slice(0, 90))}`);
ok(shown.includes(`deposit ${w.resources[single.id][kind]}`),
  `and gives the deposit (${w.resources[single.id][kind]})`);
ok(shown.includes(w.byId.get(single.id).name), 'and says which province it is in');

// Off the stack, the province underneath answers instead.
fire(canvas, 'mousemove', { clientX: 40, clientY: canvas.height - 40 });
const away = tooltip.innerHTML || '';
ok(!away.includes(`deposit ${w.resources[single.id][kind]}`)
  || away.includes('&middot;'),
  'moving off the stack stops describing that deposit');

// And with the layer off, a row is never the answer.
pick('political');
run(4);
fire(canvas, 'mousemove', { clientX: cx, clientY: cy });
ok(!(tooltip.innerHTML || '').includes('yield 0 a day'),
  'no deposit tooltip when the layer is off');
pick('resources');

// -------------------------------------------------------- picking a province
// Picking a province is asking about that one, so its stack comes forward: it
// is drawn larger, drawn last so it lands on top of its neighbours, and it
// skips the room tests, because hiding what was asked for on the grounds that
// the ground is narrow is the opposite of an answer.
//
// The anchor is a pixel the province owns, so centring on it and clicking the
// middle of the window picks that one and nothing else.
clearPick();
drawAt(single.stack.ax, single.stack.ay, 6);
const plain = rowsUnder(cx, cy);
ok(plain.length > 0, `its one row is drawn unpicked (${plain.length})`);

clickAt(cx, cy);
ok(cardOpen(), `clicking the middle picks something (${single.id} is under it)`);
drawAt(single.stack.ax, single.stack.ay, 6);
const large = rowsUnder(cx, cy);
ok(large.length > 0, `and it is still drawn once picked (${large.length})`);

const small = Math.max(...plain.map((b) => b.dh));
const grown = Math.max(...large.map((b) => b.dh));
ok(grown > small, `picking it enlarges the row: ${small}px tall against ${grown}px`);

// Ouresca Island is three pixels across and holds three things, so no zoom
// short of 13 gives it room. Unpicked it says nothing at zoom 2; picked it
// says it anyway.
const tiny = lines.get('ouresca_island');
ok(Boolean(tiny), 'Ouresca Island holds a stack');
clearPick();
drawAt(tiny.ax, tiny.ay, 2);
const hushed = rowsUnder(cx, cy);
ok(hushed.length === 0, `unpicked it draws nothing at zoom 2 (${hushed.length})`);

clickAt(cx, cy);
ok(cardOpen(), 'clicking it picks it');
drawAt(tiny.ax, tiny.ay, 2);
const anyway = rowsUnder(cx, cy);
ok(anyway.length > 0, `and picked it says what it holds anyway (${anyway.length})`);
clearPick();

// ---------------------------------------------------------------- the face
// The game is set in Cabin. style.css declares it as --ui and ships it in
// data/ui/fonts, and the canvas has to say the same or every name and figure on
// the map is in a different typeface from the panel beside it. Only this layer:
// LABEL_FACE carries the country, province and sea names and is left as it was.
const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
ok(/--ui:\s*Cabin/.test(css), 'style.css sets the interface in Cabin');
const js = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
ok(/const RESOURCE_FACE = .Cabin,/.test(js), 'and the resource layer draws in Cabin');
ok(/const LABEL_FACE = ..Segoe UI/.test(js),
  'while LABEL_FACE stays the plain face, since the country and province names are not this layer');
// --------------------------------------------------------------- a sweep
for (const s of [0.25, 0.4, 0.7, 0.72, 1, 2.5, 6, 12, 16]) { game.lookAt(3000, 1300, s); run(6); }
ok(true, 'a zoom sweep over the layer threw nothing');

// -------------------------------------------------------------------- report
console.log(`\n${rows.length} distinct lines baked at zoom 4, for example ${JSON.stringify(rows.slice(0, 3).map((r) => r.t))}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const [w, e] of problems) console.log(`  ${w}: ${e.message}`);
  process.exit(1);
}
console.log('\nthe resource layer writes what a province knows it has');
