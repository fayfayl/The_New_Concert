/*
 * The trade routes layer draws yesterday's sales along their legs.
 *
 * What has to hold:
 *
 *   the toolbar carries a Trade routes button with a tooltip;
 *   nothing is drawn until the layer is chosen, and lines and stops are once it is;
 *   every segment's volume is what the sales along it carried, and the busiest is the widest;
 *   feeders run inside each country from its surplus provinces to its hub and from its hub to its demand, making no stops;
 *   hovering a line names each good with its icon and amount, seller to buyer with flags, and the stop countries with flags, and no summed volume;
 *   clicking a line opens one panel listing every trade and every stop, another line moves it, a new day refills it,
 *   Escape and the close key close it, and a click off the lines opens nothing.
 *
 *   node --max-old-space-size=6144 test/routes-layer.mjs
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

// Loading ends when the console is set up; up to ten minutes.
for (let i = 0; i < 12000 && !(dom.frameQueue.length && globalThis.window.game); i++) await new Promise((r) => setTimeout(r, 50));
fire(dom.el('start-enter'), 'click');
run(40);

const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) problems.push(['check', new Error(m)]); };
const game = globalThis.window.game;
const { debug } = await import('../src/layers/cities.js');
const layer = await import('../src/layers/routelayer.js');
const { live, state, els } = await import('../src/core/core.js');
const { view } = await import('../src/render/view.js');

// ------------------------------------------------------------- the button
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const button = /<button data-mode="routes"[^>]*>Trade routes<\/button>/.exec(html);
ok(Boolean(button), 'the toolbar has a Trade routes button');
ok(!/title=/.test(button?.[0] || ''), 'with no browser tooltip');

const pick = (mode) => fire(dom.el('toolbar'), 'click',
  { target: { closest: (sel) => (sel.includes('data-mode') ? { dataset: { mode } } : null) } });

// ------------------------------------------------------------ off by default
debug.routes = 0;
game.lookAt(2300, 900, 0.8);
run(10);
ok(!debug.routes, `nothing is drawn until the layer is chosen (${debug.routes})`);

// -------------------------------------------------------------------- on
pick('routes');
ok(state.mode === 'routes', 'the button chooses the layer');
game.lookAt(2300, 900, 0.8);
run(10);
ok(debug.routes > 0, `the layer draws route segments (${debug.routes})`);
ok(debug.routeStops > 0, `and marks the stops (${debug.routeStops})`);

// ------------------------------------------------------------ the volumes
const w = game.world();
const sales = live.lastSupply.sales;
const { segs, stops, most } = layer.routeSegments(w);
ok(sales.length > 0 && segs.length > 0, `${sales.length} sales drawn as ${segs.length} segments and ${stops.length} stops`);
const modes = new Set(segs.map((s) => s.mode));
ok(modes.has('sea') && (modes.has('rail') || modes.has('road')), `sea and land are both drawn (${[...modes].join(', ')})`);
ok(segs.reduce((a, s) => Math.max(a, s.volume), 0) === most, `the busiest segment carries ${most.toFixed(1)} a day`);
const busiest = segs.reduce((a, s) => (s.volume > a.volume ? s : a));
const carried = [...busiest.sales.values()].reduce((a, n) => a + n, 0);
ok(Math.abs(carried - busiest.volume) < 1e-6, 'its volume is the sum of the sales along it');
const total = sales.reduce((a, x) => a + x.amount, 0);
ok(busiest.volume <= total + 1e-6, `and no more than the day's whole trade (${total.toFixed(1)})`);
// Feeders: each country's side of each good fed in full, with no stops.
const feeders = segs.filter((s) => s.sales.size && [...s.sales.keys()].every((k) => k.endsWith('|')));
ok(segs.every((s) => s.mode in layer.ROUTE_STYLE) && Object.keys(layer.ROUTE_STYLE).join() === 'sea,rail,road', 'only sea lanes, rail and road are drawn');
ok(feeders.length > 0, `feeders are drawn (${feeders.length} segments)`);
ok(feeders.every((s) => s.stops.size === 0), 'feeders make no stops');
ok(feeders.every((s) => [...s.sales.keys()].every((k) => k.endsWith('|'))), 'feeders carry goods within one country');
const soldBy = new Map();
for (const x of sales) soldBy.set(x.seller + '|1|' + x.kind, (soldBy.get(x.seller + '|1|' + x.kind) || 0) + x.amount);
const { fed, ported } = layer.routeSegments(w);
// What a seller fed, by province and, for agreements and lend lease, from its capital.
const fedAll = (k) => [k, k + '|capital'].reduce((a, x) => a + (fed.get(x) || 0) + (ported.get(x) || 0), 0);
ok([...soldBy].every(([k, n]) => Math.abs(fedAll(k) - n) < 1e-6), 'every seller feeds what it sold, from its hub, its ports or its capital');
const style = layer.ROUTE_STYLE;
ok(style.sea.dash.length > 0 && style.rail.dash.length === 0 && style.road.dash.length === 0 && layer.ROUTE_HALO.road && !layer.ROUTE_HALO.rail && !layer.ROUTE_HALO.sea,
  'sea is dashed, rail a bare track, road a cased line');

// ----------------------------------------------------------------- hover
const mid = { x: (busiest.ax + busiest.bx) / 2, y: (busiest.ay + busiest.by) / 2 };
game.lookAt(mid.x, mid.y, 1);
run(4);
const at = { clientX: mid.x * view.scale + view.x, clientY: mid.y * view.scale + view.y };
const hit = layer.routeAtEvent(at);
ok(hit === busiest, 'hovering the busiest line finds it');
layer.showRouteTooltip(hit, at);
const tip = els.tooltip.innerHTML;
const [kind, seller, buyer] = [...busiest.sales].sort((a, b) => b[1] - a[1])[0][0].split('|');
const named = (id) => w.table.polityById.get(id)?.short || id;
ok(!tip.includes('Carries'), 'the tooltip gives no summed volume');
ok(/<i class="res[ "]/.test(tip), 'goods carry their icons');
ok(tip.includes('mini-flag-box'), 'countries carry their flags');
ok(tip.includes(named(seller)) && tip.includes(named(buyer)), `and its largest sale, ${kind} from ${seller} to ${buyer}`);
const stopNames = [...busiest.stops].slice(0, layer.ROUTE_TIP_STOPS).map((k) => layer.stopPlace(w, k));
ok(stopNames.length > 0 && stopNames.every((n) => tip.split('Next stops:')[1]?.includes(n)), `and its next stops by place (${stopNames.slice(0, 4).join(', ')}…)`);

// ---------------------------------------------------------------- click
const panel = dom.el('route-panel'), body = dom.el('route-panel-body');
panel.hidden = true;
const click = (where) => { fire(els.canvas, 'mousedown', { button: 0, ...where }); fire(globalThis.window, 'mouseup', { button: 0, ...where }); };
const before = state.selected;
click(at);
ok(!panel.hidden && layer.routePanelOpen(), 'clicking a line opens the route panel');
ok(state.selected === before, 'and selects no province');
const panelRows = (body.innerHTML.match(/<li>/g) || []).length;
ok(panelRows === busiest.sales.size + busiest.stops.size, `with a row for each of its ${busiest.sales.size} trades and ${busiest.stops.size} stops (${panelRows})`);
const title = dom.el('route-panel-title').textContent;
ok(title === { sea: 'Sea lane', rail: 'Rail', road: 'Road' }[busiest.mode], `titled by its mode (${title})`);
ok(/<i class="res[ "]/.test(body.innerHTML) && body.innerHTML.includes('mini-flag-box'), 'with good icons and country flags');
ok(!/\bNaN\b|undefined/.test(body.innerHTML), 'and no missing figures or names');
const calls = [...busiest.calls.values()];
ok(calls.length === busiest.stops.size && calls.every((n) => n > 0 && n <= busiest.volume + 1e-6), 'each stop calls with part of what the segment carries');
// A feeder: another line moves the one panel.
const feeder = feeders.reduce((a, s) => (s.volume > a.volume ? s : a));
const fmid = { x: (feeder.ax + feeder.bx) / 2, y: (feeder.ay + feeder.by) / 2 };
game.lookAt(fmid.x, fmid.y, 1);
run(4);
const fat = { clientX: fmid.x * view.scale + view.x, clientY: fmid.y * view.scale + view.y };
const fhit = layer.routeAtEvent(fat);
click(fat);
ok(fhit && !panel.hidden && (fhit.sales.size ? body.innerHTML.includes('within ') : body.innerHTML.includes('Nothing carried')), `another line moves the panel (${fhit?.mode}, ${fhit?.sales.size} trades)`);
// A new day: the panel refills from the new sales.
const { dailySupply } = await import('../src/game/resources.js');
click(at);
body.innerHTML = '';
live.lastSupply = dailySupply(w);
game.lookAt(mid.x, mid.y, 1);
run(4);
ok(!panel.hidden && body.innerHTML.includes('<li>'), 'a new day refills the open panel');
fire(globalThis.window, 'keydown', { key: 'Escape' });
ok(panel.hidden && !layer.routePanelOpen(), 'Escape closes the panel');
click(at);
fire(dom.el('route-panel-close'), 'click');
ok(panel.hidden, 'and so does its close key');
// Off the lines, a click opens nothing.
let off = null;
for (let d = 40; d < 1200 && !off; d += 20) {
  const p = { clientX: at.clientX + d, clientY: at.clientY + d / 3 };
  if (!layer.routeAtEvent(p)) off = p;
}
click(off);
ok(off && panel.hidden, 'a click off the lines opens no panel');
click(at);
pick('political');
ok(panel.hidden, 'leaving the layer closes the panel');
ok(layer.routeAtEvent(at) === null, 'off the layer, nothing is hovered');

console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):\n`);
  for (const [where, err] of problems) console.log(`  [${where}] ${err.stack || err.message}`);
  process.exitCode = 1;
} else {
  console.log('the trade routes layer draws what moved, where it moved');
}
process.exit();
