/*
 * The right button: picks the county under it, rings it, and opens its panel.
 *
 * Everything here is read back out of the DOM, because that is all a player can
 * see. The panel opening is a class on an element; what it says is textContent.
 *
 *   node --max-old-space-size=6144 test/county-panel.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire } from './dom-shim.mjs';

const problems = [];
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = install(root);

process.on('uncaughtException', (e) => problems.push(['uncaught', e]));
process.on('unhandledRejection', (e) => problems.push(['rejection', e]));

const t0 = Date.now();
await import('../src/main.js');

const run = (n) => {
  let ran = 0;
  for (let i = 0; i < n; i++) {
    const queued = dom.frameQueue.splice(0, dom.frameQueue.length);
    if (!queued.length) break;
    for (const fn of queued) {
      try { fn(performance.now()); ran++; } catch (e) { problems.push(['frame', e]); return ran; }
    }
  }
  return ran;
};

for (let i = 0; i < 400 && !dom.frameQueue.length; i++) await new Promise((r) => setTimeout(r, 50));
console.log(`booted in ${Date.now() - t0}ms`);
fire(dom.el('start-enter'), 'click');
run(40);

const canvas = dom.el('map');
const card = dom.el('county-card');
const text = (id) => String(dom.el(id).textContent ?? '').trim();
const open = () => card.classList.contains('open');

// A WHOLE right click, in the order a browser sends it: the button goes down,
// the menu event fires, the button comes up. Firing only the middle one was how
// this test missed the fact that mouseup selected a province whatever button had
// been pressed — so the context menu handler cleared the province card and the
// very next event put it back.
let prevented = false;
const rightClick = (x, y) => {
  prevented = false;
  fire(canvas, 'mousedown', { button: 2, clientX: x, clientY: y });
  const ok = fire(canvas, 'contextmenu', {
    button: 2, clientX: x, clientY: y, preventDefault() { prevented = true; },
  });
  fire(globalThis.window, 'mouseup', { button: 2, clientX: x, clientY: y });
  run(4);
  return ok;
};

if (!rightClick(800, 450)) {
  problems.push(['wiring', new Error('the right button is not wired to the canvas')]);
}

// Somewhere on land, found by right-clicking until a county answers.
let found = null;
outer:
for (let y = 120; y < 820 && !found; y += 41) {
  for (let x = 120; x < 1500; x += 59) {
    rightClick(x, y);
    if (open() && text('county-name') !== '—') { found = { x, y }; break outer; }
  }
}

if (!found) {
  problems.push(['land', new Error('no county under any of the right-clicks tried')]);
} else {
  const row = {
    name: text('county-name'),
    polity: text('county-polity'),
    province: text('county-province'),
    terrain: text('county-terrain'),
    climate: text('county-climate'),
    rail: text('county-rail'),
    area: text('county-area'),
  };
  console.log(`right-clicked ${found.x},${found.y}`);
  for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(9)} ${v}`);

  if (!prevented) problems.push(['menu', new Error('the browser context menu was not suppressed')]);
  if (card.getAttribute('aria-hidden') !== 'false') {
    problems.push(['panel', new Error('the panel is open but still marked aria-hidden')]);
  }

  // Every row the mechanic promises: owner, terrain, climate and a railway.
  for (const k of ['name', 'polity', 'province', 'terrain', 'climate', 'rail', 'area']) {
    if (!row[k] || row[k] === '—') problems.push(['panel', new Error(`${k} is empty`)]);
  }
  if (!['Yes', 'No'].includes(row.rail)) {
    problems.push(['panel', new Error(`the railway row says "${row.rail}", not Yes or No`)]);
  }
  if (!/\d/.test(row.area)) problems.push(['panel', new Error(`the area row says "${row.area}"`)]);

  // A second right-click on a different county has to move the panel to it.
  const first = row.name;
  let moved = null;
  for (let x = found.x + 90; x < 1560 && !moved; x += 47) {
    rightClick(x, found.y);
    if (open() && text('county-name') !== first && text('county-name') !== '—') moved = text('county-name');
  }
  console.log(`  second click moved it to ${moved || 'NOWHERE'}`);
  if (!moved) problems.push(['panel', new Error('right-clicking another county did not move the panel')]);

  // THE RING. It was invisible for a while and nothing here noticed, because the
  // panel filled perfectly while the shape behind it had no pixels: a county
  // world restored from the cache carried no width, so every row offset came out
  // NaN and the silhouette traced nothing. Read out of the debug panel, which is
  // the only place the traced size is visible from outside.
  {
    fire(dom.el('toggle-panel'), 'click');
    run(4);
    await new Promise((r) => setTimeout(r, 300));   // the readout is throttled
    run(6);
    const m = String(dom.el('perf').innerHTML || '').match(/Highlighted<\/span><span[^>]*>([^<]*)</);
    const said = m ? m[1].trim() : null;
    console.log(`  rings: ${said}`);

    if (!said) {
      problems.push(['ring', new Error('the debug panel has no Highlighted row')]);
    } else {
      // BOTH rings. The county in white, and the province it sits in still in
      // gold — right-clicking a county says nothing about the province stopping
      // being selected, and clearing it was wrong.
      if (!said.includes('county ')) problems.push(['ring', new Error(`no county ring: "${said}"`)]);
      if (!said.includes('province ')) {
        problems.push(['ring', new Error(`the province lost its ring on a right click: "${said}"`)]);
      }
      if (said.includes('NO SHAPE')) {
        problems.push(['ring', new Error(`a ring has nothing traced behind it: "${said}"`)]);
      }
      if ((said.match(/\d+\s*(&times;|x|×)\s*\d+/g) || []).length < 2) {
        problems.push(['ring', new Error(`fewer than two traced shapes: "${said}"`)]);
      }
    }
    fire(dom.el('toggle-panel'), 'click');
    run(4);
  }

  // A left click puts the county away — it is a look at one patch of ground, not
  // something to carry around.
  fire(canvas, 'mousedown', { button: 0, clientX: found.x, clientY: found.y });
  run(4);
  if (open()) problems.push(['panel', new Error('a left click did not put the county panel away')]);
  console.log(`  left click closed it: ${!open()}`);

  // And the two never show together: a right click has to put the province away.
  fire(canvas, 'mousedown', { button: 0, clientX: found.x, clientY: found.y });
  fire(globalThis.window, 'mouseup', { button: 0, clientX: found.x, clientY: found.y });
  run(6);
  const provinceUp = dom.el('card').classList.contains('open');
  rightClick(found.x, found.y);
  run(6);
  const provinceStillUp = dom.el('card').classList.contains('open');
  console.log(`  province card: ${provinceUp ? 'opened by the left click' : 'never opened'},`
    + ` ${provinceStillUp ? 'STILL UP' : 'closed'} after the right click`);
  if (provinceStillUp) {
    problems.push(['panel', new Error('the province card is still up after a right click')]);
  }

  // A left click on ground the RIGHT button already picked has to open the
  // province card. The right click selects the province and then closes its
  // card, so the left click arrives with that province already selected and
  // used to return early, leaving neither card open.
  {
    rightClick(found.x, found.y);
    const beforeLeft = dom.el('card').classList.contains('open');
    fire(canvas, 'mousedown', { button: 0, clientX: found.x, clientY: found.y });
    fire(globalThis.window, 'mouseup', { button: 0, clientX: found.x, clientY: found.y });
    run(6);
    const afterLeft = dom.el('card').classList.contains('open');
    console.log(`  same spot: province card after right click ${beforeLeft}, after left click ${afterLeft}`);
    if (beforeLeft) problems.push(['panel', new Error('the right click left the province card open')]);
    if (!afterLeft) problems.push(['panel', new Error('a left click on the same county did not open the province card')]);
    if (open()) problems.push(['panel', new Error('the left click left the county panel open')]);
  }

  // Escape puts it away, and does it before touching the province selection.
  fire(globalThis.window, 'keydown', { key: 'Escape' });
  run(4);
  const closedByKey = !open();

  if (!closedByKey) {
    // Fall back to the close button, so a broken key handler is reported
    // rather than hiding a panel that will not shut at all.
    fire(dom.el('county-close'), 'click');
    run(4);
  }
  console.log(`  Escape closed it: ${closedByKey}; panel now ${open() ? 'OPEN' : 'closed'}`);
  if (!closedByKey) problems.push(['panel', new Error('Escape did not close the county panel')]);
  if (open()) problems.push(['panel', new Error('neither Escape nor the close button put the panel away')]);
}

console.log();
if (!problems.length) {
  console.log('the right button picks a county');
} else {
  console.log(`${problems.length} problem(s):\n`);
  for (const [where, e] of problems.slice(0, 5)) console.log(`  [${where}] ${e && e.message}`);
}
process.exit(problems.length ? 1 : 0);
