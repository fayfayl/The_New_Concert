// The resource layer: yields, stacks and drawing.

const VERSION = new URL(import.meta.url).search;
const { deriveOnChange, ease, perf, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let RESOURCE_ICON, RESOURCE_LINE, RESOURCE_MARK, RESOURCE_MAX_LINE, RESOURCE_MIN_LINE, RESOURCE_OVERHANG, RESOURCE_SELECTED, RESOURCE_SHEET_CELL, RESOURCE_SHEET_COLS, UNFERTILISED, connectedOf, debug, developmentOf, developmentPitOf, resourceFont, resourceIconPx, view;
export function link(all) { ({ RESOURCE_ICON, RESOURCE_LINE, RESOURCE_MARK, RESOURCE_MAX_LINE, RESOURCE_MIN_LINE, RESOURCE_OVERHANG, RESOURCE_SELECTED, RESOURCE_SHEET_CELL, RESOURCE_SHEET_COLS, UNFERTILISED, connectedOf, debug, developmentOf, developmentPitOf, resourceFont, resourceIconPx, view } = all); }

// Resource layer text lines per province, rebuilt on change.
// Resources that ignore development and yield in full when connected.
const ALWAYS_FULL = new Set(['fertileLand', 'fish', 'textiles', 'livestock']);

// Share of timber yielded at any development.
const FLOOR = { timber: 0.2 };
// Resources worked on the pit development weighting.
const PIT = new Set(['coal', 'naturalGas']);

// Yield of a deposit; always-full kinds yield nothing when unconnected, and fertile land falls short of nitrates.
const yieldOf = (kind, amount, dev, devPit, connected = true, nitrates = 1) =>
(ALWAYS_FULL.has(kind) ? (connected ? Math.round(amount * (kind === 'fertileLand' ? UNFERTILISED + (1 - UNFERTILISED) * nitrates : 1) * 10) / 10 : 0)
  : Math.round(amount * Math.max(FLOOR[kind] ?? 0, PIT.has(kind) ? devPit : dev) * 10) / 10);

// Yesterday's nitrate cover of a province's owner.
const nitratesOf = (w, id) => live.lastSupply?.get(w.byId?.get(id)?.owner)?.kept?.nitrates ?? 1;

// Rebuilds the resource lines whenever the world changes.
deriveOnChange((w) => { w.resourceLines = buildResourceLines(w); });

function buildResourceLines(world) {
  const out = new Map();
  if (!world.resources) return out;
  const hasSheet = Boolean(world.resourceSheet);
  for (const id in world.resources) {
    const held = world.resources[id];
    const lines = [];
    const stats = world.stats?.[id] || {};
    const dev = developmentOf(world, world.byId?.get(id), stats);
    const devPit = developmentPitOf(world, world.byId?.get(id), stats);
    const connected = connectedOf(world, world.byId?.get(id));
    for (const kind of world.resourceKinds) {
      const amount = held[kind];
      if (!amount) continue;
      lines.push({ kind, text: `(${yieldOf(kind, amount, dev, devPit, connected, nitratesOf(world, id))}/${amount})` });
    }
    if (!lines.length) continue;

    // Widest row of the stack, for the room test.
    lines.wide = lines.reduce((a, b) => (rowChars(b, hasSheet) > rowChars(a, hasSheet) ? b : a));
    out.set(id, lines);
  }
  for (const [id, lines] of out) anchorStack(world, id, lines);
  return out;
}

// Stack anchor: centre of the largest island, snapped onto its land.
function anchorStack(world, id, lines) {
  const bb = world.bounds.get(id);
  if (!bb) return;
  lines.ax = bb.cx;
  lines.ay = bb.cy;

  const W = world.width, H = world.height;
  const at = world.provinceAt;
  const index = world.byId.get(id)?.index;
  if (!at || index === undefined) return;

  const owns = (x, y) => y >= 0 && y < H && at[y * W + ((x % W) + W) % W] === index;
  if (owns(Math.round(bb.cx), Math.round(bb.cy))) return;

  // Flood fill into islands; keep the largest.
  const x0 = bb.minX, y0 = bb.minY;
  const bw = bb.maxX - bb.minX + 1, bh = bb.maxY - bb.minY + 1;
  const seen = new Uint8Array(bw * bh);
  const stack = new Int32Array(bw * bh);
  let bestN = 0, bestX = bb.cx, bestY = bb.cy;

  for (let start = 0; start < bw * bh; start++) {
    if (seen[start]) continue;
    seen[start] = 1;
    const sy = (start / bw) | 0, sx = start - sy * bw;
    if (!owns(x0 + sx, y0 + sy)) continue;

    let top = 0, count = 0, sumX = 0, sumY = 0;
    stack[top++] = start;
    while (top) {
      const i = stack[--top];
      const y = (i / bw) | 0, x = i - y * bw;
      count++; sumX += x0 + x; sumY += y0 + y;
      if (x > 0 && !seen[i - 1] && (seen[i - 1] = 1) && owns(x0 + x - 1, y0 + y)) stack[top++] = i - 1;
      if (x + 1 < bw && !seen[i + 1] && (seen[i + 1] = 1) && owns(x0 + x + 1, y0 + y)) stack[top++] = i + 1;
      if (y > 0 && !seen[i - bw] && (seen[i - bw] = 1) && owns(x0 + x, y0 + y - 1)) stack[top++] = i - bw;
      if (y + 1 < bh && !seen[i + bw] && (seen[i + bw] = 1) && owns(x0 + x, y0 + y + 1)) stack[top++] = i + bw;
    }
    if (count > bestN) { bestN = count; bestX = sumX / count; bestY = sumY / count; }
  }
  if (!bestN) return;

  if (!owns(Math.round(bestX), Math.round(bestY))) {
    let near = Infinity, nx = bestX, ny = bestY;
    for (let y = bb.minY; y <= bb.maxY; y++) {
      for (let x = bb.minX; x <= bb.maxX; x++) {
        if (!owns(x, y)) continue;
        const d = (x - bestX) * (x - bestX) + (y - bestY) * (y - bestY);
        if (d < near) { near = d; nx = x; ny = y; }
      }
    }
    bestX = nx; bestY = ny;
  }
  lines.ax = bestX;
  lines.ay = bestY;
}

// Resource layer: known deposits per province, yield over amount.
// One stack line baked into a cached bitmap.
// Screen boxes of drawn resource rows, read by the hover.
const resourceHits = [];

const resourceLineCache = new Map();
let resourceMeasure = null;

// Character width of a row, for picking a stack's widest.
const rowChars = (row, hasSheet) =>
  (hasSheet ? 0 : (RESOURCE_MARK[row.kind] ?? row.kind).length + 1) + row.text.length;

function bakedResourceLine(row, px) {
  const dpr = Math.max(1, live.pixelRatio);
  const sheet = state.world?.resourceSheet;
  const cell = sheet ? RESOURCE_ICON[row.kind] : undefined;
  const key = `${px}|${dpr.toFixed(2)}|${cell ?? row.kind}|${row.text}`;
  const had = resourceLineCache.get(key);
  if (had) return had;

  if (!resourceMeasure) resourceMeasure = document.createElement('canvas').getContext('2d');
  resourceMeasure.font = resourceFont(px);

  const icon = cell === undefined ? 0 : resourceIconPx(px);
  const gap = cell === undefined ? 0 : Math.round(px * 0.3);
  const text = cell === undefined ? `${RESOURCE_MARK[row.kind] ?? row.kind} ${row.text}` : row.text;
  const width = resourceMeasure.measureText(text).width;

  const halo = Math.max(2, px * 0.28);
  const pad = Math.ceil(halo) + 2;
  const w = Math.ceil(icon + gap + width) + pad * 2;
  const h = Math.ceil(Math.max(px * 1.6, icon)) + pad * 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);

  const x = canvas.getContext('2d');
  x.scale(dpr, dpr);

  if (cell !== undefined) {
    x.shadowColor = 'rgba(6,8,12,.9)';
    x.shadowBlur = Math.max(1.5, px * 0.18);
    const sx = (cell % RESOURCE_SHEET_COLS) * RESOURCE_SHEET_CELL;
    const sy = Math.floor(cell / RESOURCE_SHEET_COLS) * RESOURCE_SHEET_CELL;
    x.drawImage(sheet, sx, sy, RESOURCE_SHEET_CELL, RESOURCE_SHEET_CELL,
      pad, pad + (h - pad * 2 - icon) / 2, icon, icon);
    x.shadowColor = 'transparent';
    x.shadowBlur = 0;
  }

  x.font = resourceFont(px);
  x.textAlign = 'left';
  x.textBaseline = 'middle';
  x.lineJoin = 'round';
  x.lineWidth = halo;
  x.strokeStyle = 'rgba(6,8,12,.85)';
  x.fillStyle = 'rgba(232,238,246,.95)';
  x.strokeText(text, pad + icon + gap, h / 2);
  x.fillText(text, pad + icon + gap, h / 2);

  const baked = { canvas, w, h };
  resourceLineCache.set(key, baked);
  return baked;
}

// Draws every known deposit in each province with room for it.
function drawResources(ctx, cssW, cssH, dx) {
  const t0 = performance.now();
  const w = state.world;
  if (!w?.resources || !w.bounds) return;

  const lines = w.resourceLines;
  if (!lines?.size) return;

  const s = view.scale;

  // Nothing below the readable size.
  const natural = RESOURCE_LINE * s;
  if (natural < RESOURCE_MIN_LINE) { debug.resourcesDrawn = 0; return; }

  const base = Math.round(Math.min(natural, RESOURCE_MAX_LINE));
  const big = Math.round(base * RESOURCE_SELECTED);

  const pitchOf = (px) => Math.max(px, w.resourceSheet ? resourceIconPx(px) : 0);
  const basePitch = pitchOf(base), bigPitch = pitchOf(big);
  const rowH = basePitch / s;         // one row of the stack, in map pixels

  let drawn = 0;
  const one = (id, rows, chosen) => {
    const bb = w.bounds.get(id);
    if (!bb) return;

    const line = chosen ? big : base;
    const pitch = chosen ? bigPitch : basePitch;

    if (!chosen && bb.maxY - bb.minY + 1 < rowH * rows.length) return;

    const x = rows.ax * s + view.x;
    if (x + dx < -160 || x + dx > cssW + 160) return;
    const y = rows.ay * s + view.y;
    const reach = rows.length * pitch * 0.5 + pitch;
    if (y + reach < 0 || y - reach > cssH) return;

    const widest = bakedResourceLine(rows.wide, line);
    if (!chosen && (bb.maxX - bb.minX + 1) * s < widest.w * RESOURCE_OVERHANG) return;

    let ly = y - ((rows.length - 1) * pitch) / 2;
    for (let i = 0; i < rows.length; i++, ly += pitch) {
      const b = bakedResourceLine(rows[i], line);
      ctx.drawImage(b.canvas, 0, 0, b.canvas.width, b.canvas.height,
        x - b.w / 2, ly - b.h / 2, b.w, b.h);
      resourceHits.push({
        x0: x + dx - b.w / 2, x1: x + dx + b.w / 2,
        y0: ly - pitch / 2, y1: ly + pitch / 2,
        id, kind: rows[i].kind, amount: w.resources[id]?.[rows[i].kind] ?? 0,
        yield: yieldOf(rows[i].kind, w.resources[id]?.[rows[i].kind] ?? 0,
          developmentOf(w, w.byId.get(id), w.stats?.[id] || {}),
          developmentPitOf(w, w.byId.get(id), w.stats?.[id] || {}),
          connectedOf(w, w.byId.get(id)), nitratesOf(w, id)),
      });
    }
    drawn++;
  };

  for (const [id, rows] of lines) if (id !== state.selected) one(id, rows, false);
  const chosenRows = state.selected && lines.get(state.selected);
  if (chosenRows) one(state.selected, chosenRows, true);
  perf.resources = ease(perf.resources, performance.now() - t0);
  debug.resourcesDrawn = drawn;
}

export { ALWAYS_FULL, FLOOR, PIT, yieldOf, nitratesOf, buildResourceLines, anchorStack, resourceHits, resourceLineCache, resourceMeasure, rowChars, bakedResourceLine, drawResources };
