/*
 * Writes every polity's starting tariffs into
 * data/json/government/polities-starting-government.json.
 *
 * OVERWRITES the `tariffs` field of every polity in that file. Run it only by
 * hand, when the starting rates are meant to be redrawn; the game never derives
 * tariffs from relations itself.
 *
 *   node --max-old-space-size=6144 test/generate-tariffs.js
 *
 * A's rate on everything from B is A's ceiling x hostility, to the whole
 * percent, where hostility runs from 0 at a view of +10 to 1 at -50:
 *   rate = ceiling * clamp((10 - view) / 60, 0, 1)
 * view is A's view of B at the start, with no tariffs held, voiced as the game
 * voices it (a realm's member abroad by its realm). Within one bloc nothing is
 * charged: a realm and its members, a suzerain and the polities under it, and
 * those polities between themselves.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire } from './dom-shim.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(root, 'data/json/government/polities-starting-government.json');
const FRIENDLY = 10;
const SPAN = 60;

const dom = install(root);
await import('../src/main.js');
for (let i = 0; i < 400 && !dom.frameQueue.length; i++) await new Promise((r) => setTimeout(r, 50));
fire(dom.el('start-enter'), 'click');

const { state, live, worldChanged } = await import('../src/core/core.js');
const res = await import('../src/game/resources.js');
const rel = await import('../src/game/relations.js');
const w = state.world;
const govs = w.government.byPolity;
const ids = [...govs.keys()];

// Starting relations with no tariffs held.
for (const g of govs.values()) delete g.tariffs;
for (const bag of Object.values(w.relationHistory || {})) {
  for (const k of Object.keys(bag)) if (k.startsWith(rel.TARIFF_LABEL)) delete bag[k];
}
worldChanged();
const views = rel.dailyRelations(w);
for (const x of views.values()) {
  if (x?.parts?.some(([label]) => String(label).startsWith(rel.TARIFF_LABEL))) throw new Error('starting relations hold a tariff term');
}

// The head of a polity's bloc: its realm, or the bloc of its suzerain.
const blocOf = (id, seen = new Set()) => {
  const v = rel.voiceOf(w, id);
  if (seen.has(v)) return v;
  seen.add(v);
  const over = w.table.polityById.get(v)?.suzerain || w.table.polityById.get(id)?.suzerain;
  return over && over !== v && w.table.polityById.has(over) ? blocOf(over, seen) : v;
};

const rates = new Map();
for (const a of ids) {
  const ceilings = res.tariffCeilings(w, a);
  const ceiling = Math.max(...Object.values(ceilings));
  const out = [];
  for (const b of ids) {
    if (a === b || blocOf(a) === blocOf(b)) continue;
    const view = views.get(a + '>' + b)?.value;
    if (typeof view !== 'number') continue;
    const hostility = Math.max(0, Math.min(1, (FRIENDLY - view) / SPAN));
    const rate = Math.round(ceiling * hostility * 100) / 100;
    if (rate > 0) out.push({ target: b, product: 'all', rate });
  }
  out.sort((p, q) => (p.target < q.target ? -1 : 1));
  rates.set(a, out);
}

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let entries = 0;
for (const g of data.polities) {
  delete g.tariffs;
  const out = rates.get(g.id) || [];
  if (out.length) g.tariffs = out;
  entries += out.length;
}
// One line per tariff entry.
const text = JSON.stringify(data, null, 2).replace(/\{\s+"target": ("[^"]*"),\s+"product": ("[^"]*"),\s+"rate": ([\d.]+)\s+\}/g, '{ "target": $1, "product": $2, "rate": $3 }');
fs.writeFileSync(FILE, text);
console.log(`${[...rates.values()].filter((x) => x.length).length} polities, ${entries} tariff entries written to ${path.relative(root, FILE)}`);
live.lastRelations = null;
process.exit();
