// The rail network and the infrastructure layers.

const VERSION = new URL(import.meta.url).search;
const { mapColAt, mapRowAt } = await import(`../world/geo.js${VERSION}`);
const { countyFortCeiling } = await import(`../world/ceilings.js${VERSION}`);
const { forgetOnChange, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let RESOURCE_LINE, RESOURCE_MAX_LINE, RESOURCE_MIN_LINE, RESOURCE_OVERHANG, RESOURCE_SELECTED, anchorStack, builtLevel, debug, railShare, resourceFont, unlockedSlots, usableCeiling, view;
export function link(all) { ({ RESOURCE_LINE, RESOURCE_MAX_LINE, RESOURCE_MIN_LINE, RESOURCE_OVERHANG, RESOURCE_SELECTED, anchorStack, builtLevel, debug, railShare, resourceFont, unlockedSlots, usableCeiling, view } = all); }

// Rail network: a node per railed county and a link per declared line.
let railNet = null, railNetWorld = null;
forgetOnChange(() => { railNetWorld = null; });

function railNetwork(w) {
  if (railNetWorld === w) return railNet;
  railNetWorld = w;
  railNet = { nodes: [], links: [] };
  const cs = w.counties;
  if (!cs?.countyAt || !cs.byId || !cs.bounds) return railNet;

  const wanted = new Set();
  const wantId = new Set();
  const nodeAt = new Map();
  for (const c of cs.byId.values()) {
    const to = Array.isArray(c.rail) ? c.rail : (c.rail ? [] : null);
    if (!to) continue;
    const bb = cs.bounds.get(c.id);
    if (!bb) continue;
    wantId.add(c.id);
    const at = Array.isArray(c.centre)
      ? { x: mapColAt((c.centre[1] * Math.PI) / 180, cs.width), y: mapRowAt((c.centre[0] * Math.PI) / 180) }
      : { x: bb.cx, y: bb.cy };
    nodeAt.set(c.id, at);
    railNet.nodes.push({ x: at.x, y: at.y, id: c.id });
    for (const other of to) wanted.add(c.id < other ? c.id + "|" + other : other + "|" + c.id);
  }
  if (!railNet.nodes.length) return railNet;
  const idAt = (index) => cs.atIndex?.[index]?.id;

  const W = cs.width, H = cs.height, at = cs.countyAt;
  const pairs = new Map();
  const note = (a, b, x, y) => {
    if (a === b) return;
    const ia = idAt(a), ib = idAt(b);
    if (!ia || !ib || !wantId.has(ia) || !wantId.has(ib)) return;
    const key = ia < ib ? ia + "|" + ib : ib + "|" + ia;
    if (!wanted.has(key)) return;          // adjacent, but no line runs between them
    const list = pairs.get(key) || (pairs.set(key, []), pairs.get(key));
    if (list.length < 400) list.push(x + y * W);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = at[i];
      if (!c) continue;
      note(c, at[x + 1 < W ? i + 1 : y * W], x, y);
      if (y + 1 < H) note(c, at[i + W], x, y);
    }
  }

  // Water crossed by a straight run, sampled.
  const wetness = (x0, y0, x1, y1) => {
    let wet = 0;
    for (let k = 1; k < 24; k++) {
      const t = k / 24;
      const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
      if (y < 0 || y >= H) continue;
      if (!at[y * W + ((x % W) + W) % W]) wet++;
    }
    return wet;
  };

  for (const [key, px] of pairs) {
    const [ia, ib] = key.split("|");
    const A = nodeAt.get(ia), B = nodeAt.get(ib);
    if (!A || !B || !px.length) continue;
    if (!wetness(A.x, A.y, B.x, B.y)) {
      railNet.links.push({ ax: A.x, ay: A.y, wx: null, wy: null, bx: B.x, by: B.y });
      continue;
    }

    const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    let best = null, bestWet = Infinity, bestOff = Infinity;
    const step = Math.max(1, Math.floor(px.length / 24));
    for (let k = 0; k < px.length; k += step) {
      const p = px[k], x = p % W, y = (p - (p % W)) / W;
      const wet = wetness(A.x, A.y, x, y) + wetness(x, y, B.x, B.y);
      const off = (x - mx) * (x - mx) + (y - my) * (y - my);
      if (wet < bestWet || (wet === bestWet && off < bestOff)) {
        bestWet = wet; bestOff = off; best = { x, y };
      }
    }
    if (best) railNet.links.push({ ax: A.x, ay: A.y, wx: best.x, wy: best.y, bx: B.x, by: B.y });
  }
  return railNet;
}

// Draws the rail layer.
function drawRail(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  const net = railNetwork(w);
  if (!net.links.length && !net.nodes.length) { debug.infrastructure = 0; return; }

  const px = (v) => v * s + view.x;
  const py = (v) => v * s + view.y;
  const on = (x) => x + dx > -200 && x + dx < cssW + 200;

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass ? "rgba(236,242,250,.92)" : "rgba(8,10,14,.75)";
    ctx.lineWidth = Math.max(pass ? 1.1 : 3.2, (pass ? 1.1 : 3.2) * Math.min(2, s));
    ctx.beginPath();
    for (const l of net.links) {
      const x0 = px(l.ax);
      if (!on(x0) && !on(px(l.bx))) continue;
      ctx.moveTo(x0, py(l.ay));
      if (l.wx !== null) ctx.lineTo(px(l.wx), py(l.wy));
      ctx.lineTo(px(l.bx), py(l.by));
    }
    ctx.stroke();
  }

  const r = Math.max(1.6, Math.min(4, 2.2 * s));
  ctx.fillStyle = "rgba(236,242,250,.95)";
  ctx.strokeStyle = "rgba(8,10,14,.75)";
  ctx.lineWidth = 1.4;
  let drawn = 0;
  for (const n of net.nodes) {
    const x = px(n.x), y = py(n.y);
    if (!on(x) || y < -20 || y > cssH + 20) continue;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    drawn++;
  }
  ctx.restore();
  debug.infrastructure = drawn;
}

// Level line bitmaps, cached per size.
const levelLineCache = new Map();
let levelMeasure = null;

function bakedLevelLine(text, px) {
  const dpr = Math.max(1, live.pixelRatio);
  const key = `${px}|${dpr.toFixed(2)}|${text}`;
  const had = levelLineCache.get(key);
  if (had) return had;

  if (!levelMeasure) levelMeasure = document.createElement('canvas').getContext('2d');
  levelMeasure.font = resourceFont(px);
  const width = levelMeasure.measureText(text).width;

  const halo = Math.max(2, px * 0.28);
  const pad = Math.ceil(halo) + 2;
  const w = Math.ceil(width) + pad * 2;
  const h = Math.ceil(px * 1.6) + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);

  const x = canvas.getContext('2d');
  x.scale(dpr, dpr);
  x.font = resourceFont(px);
  x.textAlign = 'left';
  x.textBaseline = 'middle';
  x.lineJoin = 'round';
  x.lineWidth = halo;
  x.strokeStyle = 'rgba(6,8,12,.85)';
  x.fillStyle = 'rgba(232,238,246,.95)';
  x.strokeText(text, pad, h / 2);
  x.fillText(text, pad, h / 2);

  const baked = { canvas, w, h };
  levelLineCache.set(key, baked);
  return baked;
}

// Memoised level anchor per province.
let levelAnchors = null, levelAnchorWorld = null;

function levelAnchor(w, id) {
  if (levelAnchorWorld !== w) { levelAnchors = new Map(); levelAnchorWorld = w; }
  let a = levelAnchors.get(id);
  if (!a) { a = {}; anchorStack(w, id, a); levelAnchors.set(id, a); }
  return a;
}

// Draws the chosen infrastructure level at each province's anchor.
function drawInfrastructure(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  if (!w?.bounds || !w.stats) return;
  const key = state.mode.slice('infra:'.length);
  if (key === 'rail') return;   // rail is drawn under the labels
  if (key === 'fortNew') { drawCountyForts(ctx, cssW, cssH, dx); return; }

  const natural = RESOURCE_LINE * s;
  if (natural < RESOURCE_MIN_LINE) { debug.infrastructure = 0; return; }

  const base = Math.round(Math.min(natural, RESOURCE_MAX_LINE));
  const big = Math.round(base * RESOURCE_SELECTED);

  let drawn = 0;
  const one = (id, chosen) => {
    const e = w.stats[id];
    if (!e) return;

    let built, max;
    if (key === 'hydro') {
      // Hydro: generated over potential.
      max = e.hydroPotential || 0;
      const share = (b, m) => (m > 0 ? b / m : 0);
      built = Math.round(max * (0.4 * share(builtLevel(e, 'road'), (e.road || [0, 0])[1])
        + 0.3 * share(builtLevel(e, 'electricity'), (e.electricity || [0, 0])[1])
        + 0.3 * railShare(w, w.byId.get(id))));
    } else if (key === 'factories') {
      // Factories: built against unlocked slots.
      built = (e.civilianFactories || 0) + (e.militaryFactories || 0);
      max = unlockedSlots(Array.isArray(e.buildingSlots) ? e.buildingSlots[1] : 0,
        builtLevel(e, 'road'), builtLevel(e, 'electricity'), railShare(w, w.byId.get(id)));
    } else {
      if (!Array.isArray(e[key])) return;
      [built, max] = e[key];
      max = usableCeiling(key, max);
    }
    if (!max) return;

    const bb = w.bounds.get(id);
    if (!bb) return;
    const a = levelAnchor(w, id);

    const b = bakedLevelLine(built + '/' + max, chosen ? big : base);

    const x = a.ax * s + view.x;
    if (x + dx < -160 || x + dx > cssW + 160) return;
    const y = a.ay * s + view.y;
    if (y + b.h < 0 || y - b.h > cssH) return;

    if (!chosen && (bb.maxX - bb.minX + 1) * s < b.w * RESOURCE_OVERHANG) return;

    ctx.drawImage(b.canvas, 0, 0, b.canvas.width, b.canvas.height,
      x - b.w / 2, y - b.h / 2, b.w, b.h);
    drawn++;
  };

  for (const id of w.bounds.keys()) if (id !== state.selected) one(id, false);
  if (state.selected) one(state.selected, true);
  debug.infrastructure = drawn;
}

// County fortification layer, beside the province one.
function drawCountyForts(ctx, cssW, cssH, dx) {
  const w = state.world, s = view.scale;
  const cs = w?.counties;
  if (!cs?.byId || !cs.bounds) return;

  const natural = RESOURCE_LINE * s;
  if (natural < RESOURCE_MIN_LINE) { debug.infrastructure = 0; return; }
  const base = Math.round(Math.min(natural, RESOURCE_MAX_LINE));
  const big = Math.round(base * RESOURCE_SELECTED);

  let drawn = 0;
  const one = (c, chosen) => {
    const max = countyFortCeiling(c);
    if (!max) return;                       // no fort ceiling here
    const built = c.fortification || 0;

    const bb = cs.bounds.get(c.id);
    if (!bb) return;

    const at = Array.isArray(c.centre)
      ? { x: mapColAt((c.centre[1] * Math.PI) / 180, cs.width), y: mapRowAt((c.centre[0] * Math.PI) / 180) }
      : { x: bb.cx, y: bb.cy };

    const b = bakedLevelLine(built + '/' + max, chosen ? big : base);
    const x = at.x * s + view.x;
    if (x + dx < -160 || x + dx > cssW + 160) return;
    const y = at.y * s + view.y;
    if (y + b.h < 0 || y - b.h > cssH) return;
    if (!chosen && (bb.maxX - bb.minX + 1) * s < b.w * RESOURCE_OVERHANG) return;

    ctx.drawImage(b.canvas, 0, 0, b.canvas.width, b.canvas.height,
      x - b.w / 2, y - b.h / 2, b.w, b.h);
    drawn++;
  };

  const chosen = state.county?.id || null;
  for (const c of cs.byId.values()) if (c.id !== chosen) one(c, false);
  if (chosen && cs.byId.has(chosen)) one(cs.byId.get(chosen), true);
  debug.countyForts = drawn;
}

export { railNet, railNetWorld, railNetwork, drawRail, levelLineCache, levelMeasure, bakedLevelLine, levelAnchors, levelAnchorWorld, levelAnchor, drawInfrastructure, drawCountyForts };
