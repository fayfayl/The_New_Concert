/*
 * CTRL and a left click: opens the diplomacy panel for the country that owns
 * the province under the pointer.
 *
 * Read back out of the DOM, the same way the county panel test is, because the
 * DOM is all a player can see. The panel opening is a class on an element and
 * what it says is textContent.
 *
 *   node --max-old-space-size=6144 test/diplo-panel.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
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
const panel = dom.el('diplo');
const text = (id) => String(dom.el(id).textContent ?? '').trim();
const open = () => panel.classList.contains('open');

// A whole click, in the order a browser sends it, with CTRL held.
const ctrlClick = (x, y) => {
  fire(canvas, 'mousedown', { button: 0, clientX: x, clientY: y });
  fire(globalThis.window, 'mouseup', { button: 0, clientX: x, clientY: y, ctrlKey: true });
  run(4);
};

const plainClick = (x, y) => {
  fire(canvas, 'mousedown', { button: 0, clientX: x, clientY: y });
  fire(globalThis.window, 'mouseup', { button: 0, clientX: x, clientY: y });
  run(4);
};

// Somewhere on land, found by ctrl-clicking until a country answers.
let found = null;
outer:
for (let y = 120; y < 820 && !found; y += 41) {
  for (let x = 120; x < 1500; x += 59) {
    ctrlClick(x, y);
    if (open() && text('diplo-name') !== '—') { found = { x, y }; break outer; }
  }
}

if (!found) {
  problems.push(['land', new Error('no country under any of the ctrl-clicks tried')]);
} else {
  console.log(`ctrl-clicked ${found.x},${found.y}`);
  for (const id of ['diplo-name', 'diplo-polity', 'diplo-faction', 'diplo-leader',
    'diplo-stability', 'diplo-manpower', 'diplo-party', 'diplo-ideology',
    'diplo-election', 'diplo-focus']) {
    console.log(`  ${id.replace('diplo-', '').padEnd(10)} ${text(id)}`);
  }

  if (panel.getAttribute('aria-hidden') !== 'false') {
    problems.push(['panel', new Error('the panel is open but still marked aria-hidden')]);
  }

  // Every field the panel promises, whether it is real yet or a placeholder.
  for (const id of ['diplo-name', 'diplo-polity', 'diplo-faction', 'diplo-leader',
    'diplo-stability', 'diplo-manpower', 'diplo-party', 'diplo-election', 'diplo-focus']) {
    if (!text(id) || text(id) === '—') problems.push(['panel', new Error(`${id} is empty`)]);
  }
  if (text('diplo-faction') !== 'No faction') {
    problems.push(['panel', new Error(`faction says "${text('diplo-faction')}"`)]);
  }
  if (text('diplo-focus') !== 'No National Focus set') {
    problems.push(['panel', new Error(`focus says "${text('diplo-focus')}"`)]);
  }
  if (!['No Election', 'Next Election TBD'].includes(text('diplo-election'))) {
    problems.push(['panel', new Error(`election says "${text('diplo-election')}"`)]);
  }
  if (!/%$/.test(text('diplo-stability'))) {
    problems.push(['panel', new Error(`stability says "${text('diplo-stability')}"`)]);
  }

  // The flag is named from the short name, and falls back to the placeholder
  // for the countries that have none drawn.
  const flagSrc = String(dom.el('diplo-flag').src || '');
  console.log(`  flag       ${flagSrc}`);
  if (!/^\.\/data\/img\/flags\/[a-z0-9-]+\.png$/.test(flagSrc)) {
    problems.push(['panel', new Error(`the flag src is "${flagSrc}"`)]);
  }

  // The actions box is not playable yet and says so. Anything else there is a
  // list of acts that cannot be taken.
  const actions = dom.el('diplo-actions');
  const relations = dom.el('diplo-relations');
  // The actions box is one innerHTML string; the relation rows are elements,
  // since each hangs its terms on a tooltip and the shim never fills innerHTML
  // from append(). So the two are read differently.
  const said = String(actions.innerHTML);
  const relRows = [...relations.children].filter((k) => String(k.className).includes('diplo-row'));
  const nBands = relRows.length;
  console.log(`  actions    ${said.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}`);
  console.log(`  bands      ${nBands}`);
  if (!said.includes('>WIP<') || (said.match(/diplo-row/g) || []).length !== 1) {
    problems.push(['diplomacy', new Error(`the actions box says "${said}"`)]);
  }
  // A band with nothing in it for this country is not drawn, so a country in no
  // relations shows the one row that says so. Krenland is one of those.
  const fixed = JSON.parse(await readFile(path.join(root,
    'data/json/government/polities-relations-fixed.json'), 'utf8'));
  if (nBands !== 1 || String(relRows[0]?.textContent) !== 'No de jure relations') {
    problems.push(['diplomacy', new Error(`a country in no relations drew ${nBands} rows`)]);
  }

  // The panel reads that file straight, so a relation naming a band or a
  // country that does not exist would draw a row nobody can read.
  const bandIds = new Set(fixed.bands.map((b) => b.id));
  const polityIds = new Set(JSON.parse(await readFile(path.join(root,
    'data/json/geography/polities.json'), 'utf8')).polities.map((p) => p.id));
  for (const r of fixed.relations) {
    if (!bandIds.has(r.band)) problems.push(['relations', new Error(`band "${r.band}" is not defined`)]);
    for (const side of [r.first, r.second]) {
      if (!polityIds.has(side)) problems.push(['relations', new Error(`"${side}" is not a polity`)]);
    }
    if (r.first === r.second) problems.push(['relations', new Error(`${r.first} is in a relation with itself`)]);
  }
  // A band read from one side needs the name for the other, or the country on
  // the far side of it gets a heading written from the wrong end.
  for (const b of fixed.bands) {
    if (b.of !== 'both' && !b.mirror && fixed.relations.some((r) => r.band === b.id)) {
      problems.push(['relations', new Error(`band "${b.id}" is one-sided and has no mirror`)]);
    }
  }
  console.log(`  fixed      ${fixed.relations.length} relations across ${fixed.bands.length} bands`);

  // The ledger tab, and that switching to it hides the other pane.
  fire(dom.el('diplo-tab-ledger'), 'click');
  run(2);
  if (!dom.el('diplo-pane-diplomacy').hidden) {
    problems.push(['tabs', new Error('the Diplomacy pane is still showing on the ledger tab')]);
  }
  // The left box is built from elements, so it is read as elements. The shim
  // never fills innerHTML from append(), and its className and classList are
  // two unrelated things, so neither can be leaned on here.
  const headings = [...dom.el('diplo-ledger-left').children]
    .filter((k) => k.tagName === 'H3').map((k) => String(k.textContent));
  const right = String(dom.el('diplo-ledger-right').innerHTML);
  console.log(`  ledger     ${headings.join(', ')}`);
  console.log(`  forces     ${right.slice(0, 60).replace(/\s+/g, ' ')}`);
  for (const want of ['Laws', 'Ministers', 'Commanders']) {
    if (!headings.includes(want)) problems.push(['ledger', new Error(`the left box has no ${want}`)]);
  }
  for (const want of ['Divisions', 'Air units', 'Ship units', 'Forts',
    'Military factories', 'Civilian factories', 'Dockyards']) {
    if (!right.includes(want)) problems.push(['ledger', new Error(`the right box has no ${want}`)]);
  }
  // Every figure in the box is one number. mergeStats keeps levels as a
  // [built, ceiling] pair, and adding one of those straight put a comma-joined
  // list of every province's fort level into the Forts row.
  for (const m of right.matchAll(/<span class="val">([^<]*)<[/]span>/g)) {
    if (!/^[0-9]+$/.test(m[1])) {
      problems.push(['ledger', new Error(`a forces figure reads "${m[1]}", not a number`)]);
    }
  }

  // Mutually exclusive with the province card: a plain click puts it away.
  plainClick(found.x, found.y);
  if (open()) problems.push(['exclusive', new Error('a plain left click left the panel open')]);
  if (!dom.el('card').classList.contains('open')) {
    problems.push(['exclusive', new Error('the province card did not open after the panel closed')]);
  }

  // And opening the panel puts the province card away again.
  ctrlClick(found.x, found.y);
  if (!open()) problems.push(['exclusive', new Error('ctrl-click did not reopen the panel')]);
  if (dom.el('card').classList.contains('open')) {
    problems.push(['exclusive', new Error('the province card is still open under the panel')]);
  }

  // Escape peels it off first, before the province selection.
  // The map's key handler is on window, not document.
  fire(globalThis.window, 'keydown', { key: 'Escape' });
  run(2);
  if (open()) problems.push(['escape', new Error('Escape did not close the panel')]);

  // And it closes what is on the screen rather than what a flag says is: the
  // press read state.diplo, so a flag out of step with an open panel let the
  // press fall through the whole chain and open the pause menu over it.
  ctrlClick(found.x, found.y);
  if (!open()) problems.push(['escape', new Error('ctrl-click did not reopen the panel')]);
  fire(globalThis.window, 'keydown', { key: 'Escape' });
  run(2);
  if (open()) problems.push(['escape', new Error('Escape left the panel open')]);
  if (dom.el('pause')?.classList?.contains('open')) {
    problems.push(['escape', new Error('Escape opened the pause menu over the panel')]);
  }

  // CTRL and the right button asks about the member rather than the realm, so
  // on ground held by a member the two gestures answer with different countries.
  const ctrlRight = (x, y) => {
    fire(canvas, 'contextmenu', { clientX: x, clientY: y, ctrlKey: true });
    run(4);
  };
  ctrlRight(found.x, found.y);
  const member = text('diplo-name');

  // A plain right click picks ground, so it puts the panel away exactly as a
  // plain left click does. It did not, and the county card came up beside a
  // panel that was still standing.
  fire(canvas, 'contextmenu', { clientX: found.x, clientY: found.y });
  run(4);
  if (open()) problems.push(['exclusive', new Error('a plain right click left the panel open')]);

  ctrlRight(found.x, found.y);
  ctrlClick(found.x, found.y);
  const realm = text('diplo-name');
  console.log(`  ctrl-right ${member}${member === realm ? '' : `  (left gives ${realm})`}`);
  if (!open() || member === '—') {
    problems.push(['exclusive', new Error('ctrl and the right button did not open the panel')]);
  }

  // A realm holds no ground itself, so its forces are its members'. Counting
  // only what it owns outright showed every empire as having nothing at all.
  fire(dom.el('diplo-tab-ledger'), 'click');
  run(2);
  const forcesText = String(dom.el('diplo-ledger-right').innerHTML);
  const figures = [...forcesText.matchAll(/<span class="val">([0-9]+)<[/]span>/g)].map((m) => Number(m[1]));
  console.log(`  forces sum ${figures.reduce((a, b) => a + b, 0)}`);
  fire(dom.el('diplo-tab-diplomacy'), 'click');
  run(2);

  // Most of the map has no government entry yet, and the first country found
  // was one of them. Everything drawn FROM those files — the named ideology,
  // the law list, the spirits — only appears on a country that has been
  // authored, so the panel has to be seen on one of those too.
  let governed = null;
  sweep:
  for (let y = 120; y < 860 && !governed; y += 29) {
    for (let x = 120; x < 1560; x += 37) {
      ctrlClick(x, y);
      if (open() && text('diplo-ideology') !== '—') { governed = { x, y }; break sweep; }
    }
  }

  if (!governed) {
    problems.push(['authored', new Error('no country with a government entry found on the map')]);
  } else {
    fire(dom.el('diplo-tab-ledger'), 'click');
    run(2);
    // The spirit row is elements too, so that each tile can carry a tooltip.
    const spiritKids = [...dom.el('diplo-spirits').children];
    const spiritTiles = spiritKids.filter((k) => k.dataset && k.dataset.spirit);
    console.log('');
    console.log(`authored country at ${governed.x},${governed.y}: ${text('diplo-name')}`);
    console.log(`  ideology   ${text('diplo-ideology')}`);
    console.log(`  election   ${text('diplo-election')}`);
    console.log(`  spirits    ${spiritTiles.length}`);

    // The tiles are elements, so they can be walked and their tooltips fired.
    // className is what they were given; the shim keeps className and classList
    // as two unrelated things, so that is what has to be matched on.
    const tiles = [];
    for (const kid of dom.el('diplo-ledger-left').children) {
      for (const t of (kid.children || [])) {
        if (String(t.className).includes('diplo-tile')) tiles.push(t);
      }
    }
    const lawTiles = tiles.filter((t) => t.dataset && t.dataset.law);
    console.log(`  law tiles  ${lawTiles.length}`);
    if (!lawTiles.length) {
      problems.push(['authored', new Error('the law grid is empty for an authored country')]);
    }
    // Six or seven: colonialTax is only there for a country with colonies.
    if (lawTiles.length < 6) {
      problems.push(['authored', new Error(`${lawTiles.length} law tiles, expected at least 6`)]);
    }
    // The doctrine grid sits under the laws, in the same tiles with the same
    // tooltip. A country may hold fewer than four schools: a landlocked one has
    // no naval branch, and that tile is left out rather than drawn empty.
    const docTiles = tiles.filter((t2) => t2.dataset && t2.dataset.doctrine);
    console.log(`  doctrine   ${docTiles.map((t2) => t2.dataset.branch || t2.dataset.doctrine).join(', ')}`);
    if (docTiles.length < 3 || docTiles.length > 4) {
      problems.push(['authored', new Error(`${docTiles.length} doctrine tiles, expected 3 or 4`)]);
    }
    if (docTiles.some((t2) => !t2.dataset.school)) {
      problems.push(['authored', new Error('a doctrine tile names no school')]);
    }
    if (tiles.length - lawTiles.length - docTiles.length !== 6) {
      problems.push(['authored', new Error('the minister and commander grids are not 3 slots each')]);
    }

    // Hovering a law tile names the law and lists its effects.
    const tip = dom.el('tooltip');
    if (lawTiles.length) lawTiles[0].onmouseenter({ clientX: 40, clientY: 40 });
    const shown = String(tip.innerHTML);
    console.log(`  tooltip    ${shown.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)}`);
    if (!shown.includes(lawTiles[0].dataset.option)) {
      problems.push(['tooltip', new Error('the tooltip does not name the law')]);
    }
    if (!shown.includes('cm-line')) {
      problems.push(['tooltip', new Error('the tooltip lists no effects')]);
    }
    // A fraction has to read as a percentage, an absolute as a plain number.
    // Printing every effect the same way made a law that moves revenue by a
    // quarter look like a quarter of a point. Checked against the unit each key
    // is actually given, since both kinds appear in the same tooltip: Limited
    // conscription carries manpower, which is absolute, beside happiness, which
    // is points.
    const units = JSON.parse(await readFile(path.join(root,
      'data/json/government/modifiers.json'), 'utf8')).modifiers;
    const tokenOf = (key) => (units[key]?.shown || '')
      .match(/(PERCENTAGE|PERCENT|POINTS|NUMBER|DAYS|MULTIPLIER|PERDAY|OPTION)/)?.[1];
    for (const m of shown.matchAll(/<span>([^<]+)<[/]span><b>([^<]*)<[/]b>/g)) {
      const token = tokenOf(m[1]);
      if ((token === 'PERCENTAGE' || token === 'PERCENT') && !m[2].endsWith('%')) {
        problems.push(['tooltip', new Error(`${m[1]} is a ${token} but printed "${m[2]}"`)]);
      }
      if (token === 'POINTS' && /%/.test(m[2])) {
        problems.push(['tooltip', new Error(`${m[1]} is in points but printed "${m[2]}"`)]);
      }
    }
    if (docTiles.length) {
      docTiles[0].onmouseenter({ clientX: 40, clientY: 40 });
      const dh = String(tip.innerHTML);
      console.log(`  doc tip    ${dh.replace(/<[^>]*>/g, ' ').replace(/s+/g, ' ').trim().slice(0, 70)}`);
      if (!dh.includes(docTiles[0].dataset.school)) {
        problems.push(['tooltip', new Error('the doctrine tooltip does not name the school')]);
      }
      if (/(NaN|undefined|\[object)/.test(dh)) {
        problems.push(['tooltip', new Error('the doctrine tooltip prints a broken figure')]);
      }
      docTiles[0].onmouseleave();
    }

    lawTiles[0].onmouseleave();
    if (!tip.hidden) problems.push(['tooltip', new Error('the tooltip stayed up after the pointer left')]);

    // Either the country holds spirits, each a tile with a breakdown of its
    // own, or it holds none and the row says so.
    const noneRow = spiritKids.some((k) => String(k.textContent) === 'No national spirits');
    if (!spiritTiles.length && !noneRow) {
      problems.push(['authored', new Error('the spirit row is neither tiles nor a none row')]);
    }
    if (spiritTiles.length) {
      spiritTiles[0].onmouseenter({ clientX: 40, clientY: 40 });
      const sh = String(tip.innerHTML);
      console.log(`  spirit tip ${sh.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70)}`);
      // Named, and its figures printed rather than left as [object Object]:
      // lawCeiling and ideologySupportPerDay carry a map, not a number.
      if (!sh.includes('<b>')) problems.push(['tooltip', new Error('the spirit tooltip has no name')]);
      if (sh.includes('[object')) {
        problems.push(['tooltip', new Error('a mapped effect printed as an object')]);
      }
      if (/(NaN|undefined|null)/.test(sh)) {
        problems.push(['tooltip', new Error(`the spirit tooltip prints "${sh.match(/(NaN|undefined|null)/)[0]}"`)]);
      }
      spiritTiles[0].onmouseleave();
    }
  }
}

console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):\n`);
  for (const [where, err] of problems) console.log(`  [${where}] ${err.message}`);
  process.exitCode = 1;
} else {
  console.log('no problems');
}
