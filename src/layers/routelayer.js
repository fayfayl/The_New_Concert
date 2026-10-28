// The trade routes layer: yesterday's cargo drawn along its legs, by mode and volume, with the stops it made, and fed inland to and from each hub.

const VERSION = new URL(import.meta.url).search;
const { mapColAt, mapRowAt } = await import(`../world/geo.js${VERSION}`);
const { DAY_SLICE_MS, cssToken, dayPending, els, finish, invalidateView, live, state } = await import(`../core/core.js${VERSION}`);
const { loadRouteStore, saveRouteStore } = await import(`../world/mapcache.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let borderPrep, debug, drawnGraphs, feederSteps, flaggedName, goodName, placeTooltip, resourceIcon, restoreSteps, routeLine, routeLineSteps, routeSeaSteps, routeStoreNew, routeStoreSteps, routesDrawable, screenToMap, seaEdgeSteps, shortNameOf, spreadLines, storeKeySteps, tradeEnds, view;
export function link(all) { ({ borderPrep, debug, drawnGraphs, feederSteps, flaggedName, goodName, placeTooltip, resourceIcon, restoreSteps, routeLine, routeLineSteps, routeSeaSteps, routeStoreNew, routeStoreSteps, routesDrawable, screenToMap, seaEdgeSteps, shortNameOf, spreadLines, storeKeySteps, tradeEnds, view } = all); }

// Colour and dash of each mode, in the paper and ink palette: rail an ink track, road a paper line cased in ink, sea a dashed chart line.
const ROUTE_STYLE = {
  sea: { colour: cssToken('--sheet'), dash: [7, 5] },
  rail: { colour: cssToken('--ink'), dash: [] },
  road: { colour: cssToken('--sheet-lo'), dash: [] },
};
// Under each mode: an ink casing under road, none under rail or at sea.
const ROUTE_HALO = { rail: null, road: cssToken('--ink'), sea: null };
// Rail ties: ink bars across the track, their width and spacing in css pixels before zoom.
const TIE_WIDTH = 1.3;
const TIE_GAP = 6;
const TIE_REACH = 5;
// Port call stamp: two red rings; border crossing: a red bar across the line.
const STAMP_COLOUR = '#c45a46';
const STAMP_OUTER = 6;
const STAMP_INNER = 3;
const BAR_COLOUR = cssToken('--ribbon');
const BAR_HALF = 7;
// Line width in css pixels at the thinnest and the busiest segment, before zoom.
const ROUTE_THIN = 0.8;
const ROUTE_THICK = 6;
// Hover reach from a line, in css pixels.
const ROUTE_HOVER_PX = 6;
// Sales and stop countries named in a hover.
const ROUTE_TIP_ROWS = 6;
const ROUTE_TIP_STOPS = 10;

// Each route's line, kept while the route stands.
const linesOf = new WeakMap();
const lineOf = (w, route) => { if (!linesOf.has(route)) linesOf.set(route, routeLine(w, route)); return linesOf.get(route); };

// Segments built from yesterday's sales: each step of a leg and of a feeder, with what passed along it.
let held = null;
function routeSegments(w) {
  const sales = live.lastSupply?.sales;
  if (held?.sales === sales && held.w === w) return held;
  held = finish(segmentSteps(w, live.lastSupply));
  return held;
}

// The same in steps, one sale, feeder or city a step, filling out as it goes.
function* segmentSteps(w, supply, out = {}) {
  const sales = supply?.sales;
  const at = (c) => [mapColAt(c[1] * Math.PI / 180, w.width), mapRowAt(c[0] * Math.PI / 180)];
  const segs = new Map(), stops = new Map();
  Object.assign(out, { w, sales, byKey: segs, stopsAt: stops });
  // A line's points as map steps, each adding its volume and sale to the segment it runs along.
  const addLine = (pts, mode, volume, key, stopsIn) => {
    // Points carried across the map seam the short way.
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i][0] - pts[i - 1][0];
      if (d > w.width / 2) pts[i][0] -= w.width; else if (d < -w.width / 2) pts[i][0] += w.width;
    }
    for (let i = 1; i < pts.length; i++) {
      // Each segment held on the copy of the map its western end is on.
      const shift = Math.floor(Math.min(pts[i - 1][0], pts[i][0]) / w.width) * w.width;
      const a = [pts[i - 1][0] - shift, pts[i - 1][1]], b = [pts[i][0] - shift, pts[i][1]];
      const k = mode + '|' + Math.round(a[0]) + ',' + Math.round(a[1]) + '|' + Math.round(b[0]) + ',' + Math.round(b[1]);
      const back = mode + '|' + Math.round(b[0]) + ',' + Math.round(b[1]) + '|' + Math.round(a[0]) + ',' + Math.round(a[1]);
      let s = segs.get(k) || segs.get(back);
      if (!s) segs.set(k, (s = { key: k, back, mode, ax: a[0], ay: a[1], bx: b[0], by: b[1], volume: 0, sales: new Map(), stops: new Set(), calls: new Map() }));
      s.volume += volume;
      if (volume) s.sales.set(key, (s.sales.get(key) || 0) + volume);
      for (const c of stopsIn || []) {
        s.stops.add(c);
        if (volume) s.calls.set(c, (s.calls.get(c) || 0) + volume);
      }
    }
    return pts;
  };
  // Counties a drawn route or feeder passes.
  const cs = w.counties, sea = drawnGraphs(w).sea, onLine = new Set();
  const quayOf = (id) => { const i = sea.portAt[w.byId.get(id)?.index ?? -1]; return i >= 0 ? sea.quayCounty[i] : 0; };
  for (const sale of sales || []) {
    for (const leg of sale.route.legs) {
      if (leg.mode === 'sea') { onLine.add(quayOf(leg.from)); onLine.add(quayOf(leg.to)); } else for (const id of leg.through) onLine.add(cs.byId.get(id)?.index);
    }
    if (!linesOf.has(sale.route)) { yield* routeSeaSteps(w, sale.route); linesOf.set(sale.route, yield* routeLineSteps(w, sale.route)); }
    const line = lineOf(w, sale.route);
    const saleKey = sale.kind + '|' + sale.seller + '|' + sale.buyer + (sale.via ? '|' + sale.via : '');
    // A port call at the port, a border crossing on the step that makes it.
    const mark = (pts, mode, country, volume) => {
      const end = pts[pts.length - 1], from = pts[pts.length - 2] || end;
      const x = (((mode === 'sea' ? end[0] : (from[0] + end[0]) / 2) % w.width) + w.width) % w.width;
      const y = mode === 'sea' ? end[1] : (from[1] + end[1]) / 2;
      const key = Math.round(x) + ',' + Math.round(y);
      const m = stops.get(key) || { x, y, country, volume: 0, sea: mode === 'sea', dx: end[0] - from[0], dy: end[1] - from[1] };
      m.volume += volume;
      stops.set(key, m);
    };
    // A leg carries what its own ports keep of a shared stop at either end.
    const kept = (l) => l?.shares?.[0].share ?? 1;
    // Where cargo on a leg next stops, as country|province|mode: its own stop, else the next leg's that has one.
    const nextStop = (li) => { const l = sale.route.legs.slice(li).find((x) => x.stop); return l && l.stop + '|' + l.to + '|' + l.mode; };
    sale.route.legs.forEach((leg, li) => {
      const volume = sale.amount * kept(leg) * kept(sale.route.legs[li - 1]);
      const pts = addLine(line[li].map(at), leg.mode, volume, saleKey, [nextStop(li)].filter(Boolean));
      if (leg.stop) mark(pts, leg.mode, leg.stop, sale.amount * kept(leg));
    });
    // The other ports a shared stop calls at.
    for (const alt of spreadLines(w, sale.route)) {
      const into = addLine(alt.points[0].map(at), 'sea', sale.amount * alt.share, saleKey, [alt.stop + '|' + alt.province + '|sea']);
      addLine(alt.points[1].map(at), 'sea', sale.amount * alt.share, saleKey, [nextStop(alt.leg + 1)].filter(Boolean));
      mark(into, 'sea', alt.stop, sale.amount * alt.share);
    }
    yield;
  }
  // Feeders: from each province with a surplus to the seller's hub, and from the buyer's hub to each with demand, the capital for national demand, by its share, split evenly between its cities; by sea where the land does not join.
  const fed = new Map();
  for (const sale of sales || []) {
    for (const k of [sale.seller + '|1|' + sale.kind, sale.buyer + '|0|' + sale.kind]) fed.set(k, (fed.get(k) || 0) + sale.amount);
  }
  // Each province's cities by county.
  const citiesIn = new Map();
  for (const t of w.cities || []) {
    const k = cs?.countyAt[t.y * cs.width + t.x];
    if (!k) continue;
    if (!citiesIn.has(t.province)) citiesIn.set(t.province, new Set());
    citiesIn.get(t.province).add(k);
  }
  for (const [k, volume] of fed) {
    const [id, side, kind] = k.split('|');
    for (const [p, share] of tradeEnds(supply.get(id), kind, side === '1')) {
      // From each of the province's cities by an even part, else its seat.
      const from = p && citiesIn.has(p) ? [...citiesIn.get(p)] : [-1];
      for (const c of from) {
        const pieces = yield* feederSteps(w, id, p, c);
        for (const n of pieces.walked || []) onLine.add(n);
        for (const piece of pieces) addLine(piece.points.map(at), piece.mode, volume * share / from.length, kind + '|' + id + '|', null);
        yield;
      }
    }
  }
  // Every city off the lines fed to the nearest of them on the way to its country's hub, carrying nothing.
  for (const t of w.cities || []) {
    const id = w.byId.get(t.province)?.owner, k = cs?.countyAt[t.y * cs.width + t.x];
    if (!id || !k || onLine.has(k) || !w.table?.polityById?.has(id)) continue;
    const pieces = yield* feederSteps(w, id, t.province, k, onLine);
    for (const c of pieces.walked || []) onLine.add(c);
    for (const piece of pieces) addLine(piece.points.map(at), piece.mode, 0, '', null);
    yield;
  }
  return Object.assign(out, finished(out), { fed, done: true });
}

// A set of segments as drawn: listed, with the busiest's volume, and in runs of one mode and width, quietest first.
function finished(out) {
  const list = [...out.byKey.values()];
  const most = list.reduce((a, s) => Math.max(a, s.volume), 0);
  return { segs: list, byKey: out.byKey, stops: [...out.stopsAt.values()], most, runs: runsOf(list, most) };
}
// Steps of width segments are drawn in, in css pixels before zoom.
const WIDTH_STEP = 0.1;
function runsOf(list, most) {
  const runs = new Map();
  for (const seg of list) {
    const step = Math.round(widthOf(seg, most, 1) / WIDTH_STEP);
    const key = seg.mode + '|' + step;
    if (!runs.has(key)) runs.set(key, { mode: seg.mode, width: step * WIDTH_STEP, segs: [] });
    runs.get(key).segs.push(seg);
  }
  return [...runs.values()].sort((a, b) => a.width - b.width);
}

// ------------------------------------------------------------ building in the background

// Milliseconds of route building an idle moment runs where the browser gives it no more, after its first step.
const BUILD_SLICE_MS = DAY_SLICE_MS;
// Milliseconds between looks for new work once all is built, and between redraws of a layer still filling in.
const BUILD_REST_MS = 250;
const BUILD_REDRAW_MS = 250;
// Sea lines drawn between writes of the store.
const STORE_EVERY = 4000;
// A step of the work saying nothing is left until something changes.
const REST = Symbol('rest');
// Where the work runs: in tasks put behind everything else where the browser has them, else in idle moments; else it is built at once when drawn.
const later = globalThis.scheduler?.postTask ? (fn) => globalThis.scheduler.postTask(fn, { priority: 'background' }) : globalThis.requestIdleCallback ? (fn) => globalThis.requestIdleCallback(fn, { timeout: 100 }) : null;

// The segments being built for sales not drawn yet, and what of them is shown meanwhile.
let job = null, partial = null;
// The key of the store, the world it was read for, and the sea graph whose legs all have lines.
let storeKey = null, readied = null, edgesDrawn = null;
// When each was last done, in ms from the page's start.
const doneAt = {};

// The work in the background: the store read and border samples, today's segments as sales change, then every sea leg's line, the store written as lines are added.
function* routeWork() {
  for (;;) {
    const w = state.world;
    if (!w?.subs?.subAt || !w.counties?.countyAt) { yield REST; continue; }
    if (readied !== w) { yield* ready(w); readied = w; doneAt.readied = performance.now(); }
    if (!routesDrawable(w)) { yield REST; continue; }
    const supply = live.lastSupply;
    if (held?.w !== w || held.sales !== supply?.sales) {
      job = { supply, out: {} };
      const steps = segmentSteps(w, supply, job.out);
      while (!steps.next().done && live.lastSupply === supply && state.world === w) yield;
      if (job.out.done) { held = job.out; doneAt.segments = performance.now(); if (state.mode === 'routes') invalidateView(); }
      job = null;
      partial = null;
      continue;
    }
    const g = drawnGraphs(w).sea;
    if (edgesDrawn !== g) {
      for (const _ of seaEdgeSteps(w, g)) {
        if (routeStoreNew() >= STORE_EVERY) yield* store(w);
        yield;
        if (live.lastSupply !== supply || state.world !== w) break;
      }
      if (live.lastSupply === supply && state.world === w) { edgesDrawn = g; doneAt.edges = performance.now(); }
      continue;
    }
    if (routeStoreNew()) yield* store(w);
    yield REST;
  }
}

// Reads the store for a map, then builds the border samples it lacked.
function* ready(w) {
  storeKey = yield* storeKeySteps(w);
  let got = null, done = false;
  loadRouteStore(storeKey).then((x) => { got = x; done = true; });
  while (!done) yield;
  if (got) yield* restoreSteps(w, got);
  yield* borderPrep(w);
  if (!got) yield* store(w);
}

// Writes the store, waiting until it is written.
function* store(w) {
  const data = yield* routeStoreSteps(w);
  let done = false;
  saveRouteStore(storeKey, data).then(() => { done = true; });
  while (!done) yield;
}

const work = later ? routeWork() : null;
let waiting = false, redrawn = 0;
// Runs the work for an idle moment while no day is being run, and asks for the next.
function pump(deadline) {
  waiting = false;
  const t0 = performance.now();
  const budget = deadline?.didTimeout === false ? Math.max(BUILD_SLICE_MS, deadline.timeRemaining()) : BUILD_SLICE_MS;
  // While a day is being run, the work waits.
  let rest = dayPending();
  while (!rest) {
    if (work.next().value === REST) rest = true;
    else if (performance.now() - t0 >= budget) break;
  }
  // A layer still filling in, redrawn now and then.
  if (job && state.mode === 'routes' && held?.w !== state.world && performance.now() - redrawn >= BUILD_REDRAW_MS) { partial = null; redrawn = performance.now(); invalidateView(); }
  wake(rest ? BUILD_REST_MS : 0);
}
// Asks for the work to go on, after a rest where given.
function wake(ms = 0) {
  if (!work || waiting) return;
  waiting = true;
  const ask = () => later(pump);
  if (ms) setTimeout(ask, ms); else ask();
}
wake();

// How far the work has gone: the store read, today's segments built, every sea leg's line drawn.
const routeWorkState = () => ({ at: { ...doneAt }, readied: readied === state.world, segments: held?.w === state.world && held.sales === live.lastSupply?.sales, edges: Boolean(edgesDrawn) && edgesDrawn === (routesDrawable(state.world) ? drawnGraphs(state.world).sea : null) });

// The segments to draw: today's where built, else those last built, else what is built so far; built at once where the browser has no idle moments.
function drawnSegments(w) {
  if (!work) return routeSegments(w);
  if (held?.w === w) return held;
  if (job?.out.byKey) return (partial ||= finished(job.out));
  return { segs: [], byKey: new Map(), stops: [], most: 0, runs: [] };
}

// Line width of a segment: by the square root of its share of the busiest.
const widthOf = (s, most, scale) => (ROUTE_THIN + (ROUTE_THICK - ROUTE_THIN) * Math.sqrt(most ? s.volume / most : 0)) * zoomOf(scale);
// How much zoom widens a line.
const zoomOf = (scale) => Math.min(2, Math.max(0.6, scale));

function drawTradeRoutes(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  const { runs, stops } = drawnSegments(w);
  wake();
  if (panelSeg && panelSeg.held !== held) refreshRoutePanel();
  const px = (v) => v * s + view.x;
  const py = (v) => v * s + view.y;
  const on = (a, b) => Math.max(a, b) + dx > -50 && Math.min(a, b) + dx < cssW + 50;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Quietest first, so a busy lane lies over the lines it crosses; under each mode its halo, then the line, then rail's ties.
  const z = zoomOf(s);
  let drawn = 0;
  const trace = (run, count) => {
    ctx.beginPath();
    let any = false;
    for (const seg of run.segs) {
      const x0 = px(seg.ax), x1 = px(seg.bx), y0 = py(seg.ay), y1 = py(seg.by);
      if (!on(x0, x1) || Math.max(y0, y1) < -50 || Math.min(y0, y1) > cssH + 50) continue;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      any = true;
      if (count) drawn++;
    }
    return any;
  };
  for (const pass of ['halo', 'line', 'ties']) {
    for (const run of runs) {
      const width = run.width * z;
      const style = ROUTE_STYLE[run.mode];
      if (pass === 'halo') {
        if (!ROUTE_HALO[run.mode]) continue;
        ctx.strokeStyle = ROUTE_HALO[run.mode];
        ctx.lineWidth = width + 2 * z;
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
      } else if (pass === 'line') {
        ctx.strokeStyle = style.colour;
        ctx.lineWidth = width;
        ctx.lineCap = style.dash.length ? 'butt' : 'round';
        ctx.setLineDash(style.dash.map((n) => n * z));
      } else {
        if (run.mode !== 'rail') continue;
        ctx.strokeStyle = style.colour;
        ctx.lineWidth = width + TIE_REACH * z;
        ctx.lineCap = 'butt';
        ctx.setLineDash([TIE_WIDTH * z, TIE_GAP * z]);
      }
      if (trace(run, pass === 'line')) ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  // Port calls as a double ring stamp; border crossings as a bar across the line.
  let marked = 0;
  for (const m of stops) {
    const x = px(m.x), y = py(m.y);
    if (x + dx < -20 || x + dx > cssW + 20 || y < -20 || y > cssH + 20) continue;
    if (m.sea) {
      ctx.strokeStyle = STAMP_COLOUR;
      ctx.lineWidth = 1.5 * Math.min(1.5, z);
      for (const r of [STAMP_OUTER, STAMP_INNER]) {
        ctx.beginPath();
        ctx.arc(x, y, r * Math.min(1.5, z), 0, Math.PI * 2);
        ctx.stroke();
      }
    } else {
      const len = Math.hypot(m.dx, m.dy) || 1, h = BAR_HALF * Math.min(1.5, z);
      const nx = -m.dy / len * h, ny = m.dx / len * h;
      ctx.strokeStyle = BAR_COLOUR;
      ctx.lineWidth = 3 * Math.min(1.5, z);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - nx, y - ny);
      ctx.lineTo(x + nx, y + ny);
      ctx.stroke();
    }
    marked++;
  }
  ctx.restore();
  debug.routes = drawn;
  debug.routeStops = marked;
}

// The busiest segment under the pointer, or null.
function routeAtEvent(ev) {
  if (state.mode !== 'routes' || !state.world) return null;
  const w = state.world;
  const box = els.canvas.getBoundingClientRect();
  const p = screenToMap(ev.clientX - box.left, ev.clientY - box.top);
  const reach = ROUTE_HOVER_PX / view.scale;
  const { segs, most } = drawnSegments(w);
  // The line nearest the cursor within reach, the busier where two are as near.
  let best = null, near = Infinity;
  for (const seg of segs) {
    for (const shift of [0, w.width, -w.width]) {
      const x = p.x + shift, y = p.y;
      const vx = seg.bx - seg.ax, vy = seg.by - seg.ay;
      const len = vx * vx + vy * vy;
      const t = len ? Math.max(0, Math.min(1, ((x - seg.ax) * vx + (y - seg.ay) * vy) / len)) : 0;
      const d = Math.hypot(x - seg.ax - t * vx, y - seg.ay - t * vy);
      if (d > reach + widthOf(seg, most, view.scale) / 2 / view.scale) continue;
      if (d < near - 1e-9 || (Math.abs(d - near) <= 1e-9 && seg.volume > best.volume)) { best = seg; near = d; }
    }
  }
  return best;
}

// Names, goods and amounts as the tooltip and the route panel show them.
const MODE_NAME = { sea: 'Sea lane', rail: 'Rail', road: 'Road' };
const countryName = (w, id) => { const p = w.table.polityById.get(id); return flaggedName(p, shortNameOf(p, true) || id); };
// A stop's place: the city at the port, else the port's province, for a port call; the province entered for a border crossing; key country|province|mode.
function stopPlace(w, key) {
  const [, id, mode] = key.split('|');
  const p = w.byId.get(id);
  if (!p) return id;
  if (mode !== 'sea') return p.name;
  const g = drawnGraphs(w).sea, cs = w.counties, i = g.portAt[p.index];
  const towns = (w.cities || []).filter((t) => t.province === id);
  const quay = i >= 0 ? towns.find((t) => cs.countyAt[t.y * cs.width + t.x] === g.quayCounty[i]) : null;
  return quay?.name || p.name;
}
const stopName = (w, key) => flaggedName(w.table.polityById.get(key.split('|')[0]), stopPlace(w, key));
// Fertile land is shown as crops on the routes; equipment by its name.
const equipmentName = (k) => (state.world?.production?.equipment?.items || []).find((x) => x.id === k)?.name;
const goodLabel = (k) => resourceIcon(k) + (k === 'fertileLand' ? 'Crops' : goodName(k) ?? equipmentName(k) ?? k);
// A leading article capitalised where a name starts the line.
const startCapital = (html) => html.replace(/^((?:s*<[^>]+>)*s*)the/, '$1The');
const amount = (x) => (x >= 10 ? Math.round(x) : x > 0 && x < 0.05 ? '&lt;0.1' : x.toFixed(1));
// A sale's ends: seller to buyer, with the lease or agreement it is sent under, or within one country for a feeder.
const saleEnds = (w, seller, buyer, via) => (buyer ? `${countryName(w, seller)} to ${countryName(w, buyer)}${via ? ', ' + via : ''}` : `within ${countryName(w, seller)}`);
const salesOf = (seg) => [...seg.sales].sort((a, b) => b[1] - a[1]);

// A tooltip naming what a segment carries, from whom to whom, and where it stops.
function showRouteTooltip(seg, ev) {
  const w = state.world;
  live.tipFor = null;
  live.tipTime = null;
  const rows = salesOf(seg);
  els.tooltip.innerHTML =
    `<div>${MODE_NAME[seg.mode]}</div>` +
    rows.slice(0, ROUTE_TIP_ROWS).map(([k, x]) => {
      const [kind, seller, buyer, via] = k.split('|');
      return `<div class="sub">${goodLabel(kind)} <b>${amount(x)}</b>: ${saleEnds(w, seller, buyer, via)}</div>`;
    }).join('') +
    (rows.length > ROUTE_TIP_ROWS ? `<div class="sub">and ${rows.length - ROUTE_TIP_ROWS} more</div>` : '') +
    (seg.stops.size ? `<div class="sub">Next stops: ${[...seg.stops].slice(0, ROUTE_TIP_STOPS).map((k) => stopName(w, k)).join(', ')}${seg.stops.size > ROUTE_TIP_STOPS ? ', …' : ''}</div>` : '');
  placeTooltip(ev);
}

// ------------------------------------------------------------ the route panel

// The stretch of line the panel shows, and the segments it was read from.
let panelSeg = null;
let panelWired = false;
const panelEl = () => document.getElementById('route-panel');
const routePanelOpen = () => Boolean(panelSeg);

// Fills the panel from a segment: every trade it carries and every stop.
function fillRoutePanel(seg) {
  const w = state.world;
  const rows = salesOf(seg);
  const calls = [...seg.stops].map((id) => [id, seg.calls.get(id) || 0]).sort((a, b) => b[1] - a[1]);
  document.getElementById('route-panel-title').textContent = MODE_NAME[seg.mode];
  document.getElementById('route-panel-body').innerHTML =
    '<h3>Trade<span>per day</span></h3>' +
    (rows.length ? '<ul class="route-rows">' + rows.map(([k, x]) => {
      const [kind, seller, buyer, via] = k.split('|');
      return `<li><span class="route-good">${goodLabel(kind)}</span><b>${amount(x)}</b><span class="route-ends">${startCapital(saleEnds(w, seller, buyer, via))}</span></li>`;
    }).join('') + '</ul>' : '<p class="route-none">Nothing carried</p>') +
    (calls.length ? '<hr><h3>Next stops<span>cargo per day</span></h3><ul class="route-rows route-stops">' + calls.map(([id, x]) =>
      `<li><span class="route-ends">${startCapital(stopName(w, id))}</span><b>${amount(x)}</b></li>`).join('') + '</ul>' : '');
}

// Opens the panel on a segment, or moves it to another.
function openRoutePanel(seg) {
  const el = panelEl();
  if (!el || !seg) return;
  wireRoutePanel();
  panelSeg = { key: seg.key, back: seg.back, seg, held };
  fillRoutePanel(seg);
  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');
  clampRoutePanel();
}

function closeRoutePanel() {
  const el = panelEl();
  panelSeg = null;
  if (!el) return;
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
}

// Refills the panel from today's segments, on the same stretch of line.
function refreshRoutePanel() {
  const seg = held?.byKey.get(panelSeg.key) || held?.byKey.get(panelSeg.back);
  panelSeg.held = held;
  if (seg) panelSeg.seg = seg;
  fillRoutePanel(seg || { mode: panelSeg.seg.mode, sales: new Map(), stops: new Set(), calls: new Map() });
}

// Keeps a dragged panel inside the map.
function clampRoutePanel() {
  const el = panelEl(), wrap = el?.parentElement;
  if (!el || !wrap || !el.style.left) return;
  el.style.left = Math.max(0, Math.min(parseFloat(el.style.left), wrap.clientWidth - el.offsetWidth)) + 'px';
  el.style.top = Math.max(0, Math.min(parseFloat(el.style.top), wrap.clientHeight - el.offsetHeight)) + 'px';
}

// The close key, and dragging by the head.
function wireRoutePanel() {
  if (panelWired) return;
  panelWired = true;
  const el = panelEl();
  document.getElementById('route-panel-close').addEventListener('click', closeRoutePanel);
  const head = document.getElementById('route-panel-head');
  let grab = null;
  head.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.target?.closest?.('button')) return;
    const box = el.getBoundingClientRect(), wrap = el.parentElement.getBoundingClientRect();
    grab = { dx: ev.clientX - box.left, dy: ev.clientY - box.top, left: wrap.left, top: wrap.top };
    el.style.right = 'auto';
    el.style.left = box.left - wrap.left + 'px';
    el.style.top = box.top - wrap.top + 'px';
    head.setPointerCapture?.(ev.pointerId);
    head.classList.add('grabbed');
    ev.preventDefault();
  });
  head.addEventListener('pointermove', (ev) => {
    if (!grab) return;
    el.style.left = ev.clientX - grab.left - grab.dx + 'px';
    el.style.top = ev.clientY - grab.top - grab.dy + 'px';
    clampRoutePanel();
  });
  const drop = () => { grab = null; head.classList.remove('grabbed'); };
  head.addEventListener('pointerup', drop);
  head.addEventListener('pointercancel', drop);
  window.addEventListener('resize', clampRoutePanel);
}

export { ROUTE_STYLE, ROUTE_HALO, ROUTE_THIN, ROUTE_THICK, STAMP_OUTER, BAR_HALF, ROUTE_HOVER_PX, ROUTE_TIP_ROWS, ROUTE_TIP_STOPS, routeSegments, routeWorkState, drawTradeRoutes, routeAtEvent, showRouteTooltip, routePanelOpen, openRoutePanel, closeRoutePanel, stopPlace };
