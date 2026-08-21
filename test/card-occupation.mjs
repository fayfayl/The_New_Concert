/*
 * The province card does not carry one province's facts onto the next.
 *
 * Selecting an occupied province and then an unrelated one left the card saying
 * the second was occupied, naming the FIRST one's owner. Two causes, one on top
 * of the other:
 *
 *   the line was hidden and never emptied, so the words were still there;
 *   and hidden did not hide it, because .card-owner i sets a display of its own
 *   and an author rule beats the browser's [hidden] whatever the specificity.
 *
 * The stylesheet cannot be tested here, since nothing in this harness applies
 * CSS, so that half is checked by reading the rule. The markup half is real.
 *
 *   node --max-old-space-size=6144 test/card-occupation.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire } from './dom-shim.mjs';

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
const card = dom.el('card');
const cardOwner = dom.el('card-owner');
const cardRole = dom.el('card-role');
ok(Boolean(cardOwner && cardRole), 'the card has a role line and an owner line');

// A pixel the province certainly owns, so a click in the middle of the window
// lands on it. A centroid will not do: 85 of them fall outside their own land.
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

const pick = (id) => {
  const at = ownPixel(id);
  game.lookAt(at.x, at.y, 8);
  run(8);
  const px = canvas.width / 2, py = canvas.height / 2;
  fire(canvas, 'mousedown', { button: 0, clientX: px, clientY: py });
  fire(globalThis.window, 'mouseup', { button: 0, clientX: px, clientY: py });
  run(2);
};

// ------------------------------------------------------------- the two provinces
const held = [...w.byId.values()].find((p) => p.occupier && p.occupier !== p.owner);
const free = [...w.byId.values()].find((p) => (!p.occupier || p.occupier === p.owner)
  && p.area > 20000);
ok(Boolean(held), `the map has an occupied province (${held?.id})`);
ok(Boolean(free), `and an unoccupied one (${free?.id})`);

// ------------------------------------------------------------------ occupied
pick(held.id);
ok(card.classList.contains('open'), 'the card opens on the occupied province');
ok(cardOwner.hidden === false, 'its owner line is shown');
ok(/^Owned by \S/.test(cardOwner.textContent || ''),
  `and names the owner: ${JSON.stringify(cardOwner.textContent)}`);
ok(cardRole.textContent === 'Occupying power',
  `the role reads Occupying power: ${JSON.stringify(cardRole.textContent)}`);
const carried = cardOwner.textContent;

// -------------------------------------------------------------- then a free one
pick(free.id);
ok(card.classList.contains('open'), 'the card opens on the unoccupied province');
ok(cardRole.textContent === 'Province owner',
  `the role reads Province owner: ${JSON.stringify(cardRole.textContent)}`);
ok(cardOwner.hidden === true, 'the owner line is hidden');
ok((cardOwner.textContent || '') === '',
  `and EMPTIED, not just hidden: ${JSON.stringify(cardOwner.textContent)}`);
ok(cardOwner.textContent !== carried,
  'so the previous province\'s owner cannot be read off it');

// ------------------------------------------------------------------ the CSS
// Hiding the line only works if the stylesheet lets it. .card-owner i sets a
// display of its own, which beats the browser's [hidden] whatever the
// specificity, so there has to be a rule that wins it back.
const css = fs.readFileSync(path.join(root, 'src/style.css'), 'utf8');
const rule = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css);
ok(rule, 'style.css makes [hidden] win against a display of its own');

// -------------------------------------------------------------------- report
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const [where, e] of problems) console.log(`  ${where}: ${e.message}`);
  process.exit(1);
}
console.log('\nthe card says nothing about the province before it');
finished = true;
