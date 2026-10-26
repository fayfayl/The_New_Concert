// Country and province labels: fitting, curving, glyphs and drawing.

const VERSION = new URL(import.meta.url).search;
const { LABEL_HIST_BUCKET, computeBlockGeometry, setIslandBlocks } = await import(`../world/mapdata.js${VERSION}`);
const { cssToken, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let COVERAGE_SAMPLES, RESOURCE_ICON_PX, RESOURCE_MAX_LINE, clamp, view;
export function link(all) { ({ COVERAGE_SAMPLES, RESOURCE_ICON_PX, RESOURCE_MAX_LINE, clamp, view } = all); }

// Labels: one per contiguous same-owner block, in axis, spine, span, type steps.

// Label appearance. Sizes are in map units and scale with the zoom.
const LABEL_TRACKING = 0.16;     // letter spacing, as a fraction of the font size
const LABEL_LINE_HEIGHT = 1.1;   // line spacing, as a multiple of the font size
// Label fade, driven by the label's own size on screen.
const LABEL_ALPHA = 0.85;                  // peak opacity, in the band between the two

// Country-name dimming while a selection stands.
const LABEL_DIM_TO = 0.2;                  // label opacity multiplier while selecting
const LABEL_DIM_MS = 160;

// Dimming progress: 0 is full strength, 1 fully dimmed.
let labelDim = 0;
let labelDimClock = null;

// Moves the dimming towards the selection's target.
function stepLabelDim(now) {
  const want = state.selected ? 1 : 0;
  const step = labelDimClock === null ? 1 : (now - labelDimClock) / LABEL_DIM_MS;
  labelDimClock = now;
  if (labelDim === want) return false;
  labelDim = want > labelDim ? Math.min(want, labelDim + step) : Math.max(want, labelDim - step);
  return true;
}

// What every label's opacity is multiplied by right now.
const labelDimming = () => 1 - labelDim * (1 - LABEL_DIM_TO);

// Fade-in in screen px of font size; fade-out in share of window width.
const LABEL_FADE_IN = [3, 6];              // screen pixels of font size
const LABEL_FADE_OUT = [0.34, 0.78];       // label width, as a fraction of the window

// Eased 0..1 ramp from a to b.
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// A label's opacity from its screen font size and window coverage; 0 hides it.
function labelOpacity(px, covers) {
  return LABEL_ALPHA
    * smoothstep(LABEL_FADE_IN[0], LABEL_FADE_IN[1], px)
    * (1 - smoothstep(LABEL_FADE_OUT[0], LABEL_FADE_OUT[1], covers));
}
// Tightest spine bend radius, as a multiple of the label's type size.
const BEND_RADIUS = 7;

// Polity label text and halo colours as "r,g,b", with relative opacities.
const LABEL_COLOUR = '28,34,45';
const LABEL_OUTLINE = '255,255,255';
const LABEL_COLOUR_OPACITY = 0.9;     // 0 hides the text and leaves only the halo
const LABEL_OUTLINE_ALPHA = 0.76;   // 0 leaves bare text with nothing behind it
const LABEL_OUTLINE_WIDTH = 0.13;   // as a fraction of the font size

// --- choosing the font size and the number of lines
const LABEL_FIT = { along: 0.86, across: 0.9 };  // share of span/thickness the text may fill
const LABEL_MAX_LINES = 3;       // hard ceiling on stacked lines
const LABEL_WRAP_ASPECT = 2.3;   // length-to-width ratio above which a block never stacks
const LABEL_WRAP_GAIN = 1.15;    // size gain an extra line must give to be taken

// Choosing which stretch of the block the name covers.
const LABEL_DENSITY_FLOOR = 0.4; // solid-ground threshold, as a share of mean width
const LABEL_MIN_DENSITY = 0.3;   // a whole block sparser than this is an archipelago

// Naming for countries that are mostly islands.
const LABEL_ISLANDS_SHARE = 0.4;      // share of a country's land left unnamed
const LABEL_SPARSE_TRACKING = 0.3;    // letter spacing for such a name
const LABEL_SPARSE_LIFT = 2.2;        // how far it may exceed the scatter it crosses
const LABEL_ISLANDS_MAX_SPAN = 0.18;  // max archipelago span, as a share of map width

//change the number to change weight/boldness of text
// Font face for map labels, from --ui-plain.
const LABEL_FACE = cssToken('--ui-plain');

// Font for the resource layer, from --ui.
const RESOURCE_FACE = cssToken('--ui');
const resourceFont = (px) => `500 ${px}px ${RESOURCE_FACE}`;

// Preloads the resource font for canvas drawing.
document.fonts?.load?.(`500 12px ${RESOURCE_FACE}`)?.catch?.(() => {});
const resourceIconPx = (px) => Math.round((px * RESOURCE_ICON_PX) / RESOURCE_MAX_LINE);
const labelFont = (px) => `600 ${px}px ${LABEL_FACE}`;

// Width of one line of label text, in multiples of its font size.
const MEASURE_SIZE = 100;
let measureCtx = null;             // reusable measuring context
function widthRatio(text, tracking = LABEL_TRACKING) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = labelFont(MEASURE_SIZE);
  const chars = [...text];
  const w = chars.reduce((s, c) => s + measureCtx.measureText(c).width, 0)
    + MEASURE_SIZE * tracking * (chars.length - 1);
  return w / MEASURE_SIZE;
}

// Splits a name into n lines, minimising the widest line.
function wrapInto(words, n) {
  if (words.length < n) return null;
  let best = null;
  const search = (start, left, acc) => {
    if (left === 1) {
      const lines = [...acc, words.slice(start).join(' ')];
      const worst = Math.max(...lines.map(widthRatio));
      if (!best || worst < best.worst) best = { lines, worst };
      return;
    }
    for (let end = start + 1; end <= words.length - left + 1; end++) {
      search(end, left - 1, [...acc, words.slice(start, end).join(' ')]);
    }
  };
  search(0, n, []);
  return best;
}

// Picks the font size and line count for one label (step 4).
function fitLabel(text, span, thickness, maxLines, tracking = LABEL_TRACKING) {
  const words = text.split(/\s+/);
  let best = null;
  for (let n = 1; n <= Math.min(maxLines, words.length); n++) {
    const wrapped = n === 1 ? { lines: [text], worst: widthRatio(text, tracking) } : wrapInto(words, n);
    if (!wrapped) continue;
    const size = Math.min(
      span * LABEL_FIT.along / wrapped.worst,             // limited by the block's length
      thickness * LABEL_FIT.across / (n * LABEL_LINE_HEIGHT)   // limited by its width
    );
    if (!best || size > best.size * LABEL_WRAP_GAIN) best = { lines: wrapped.lines, size, width: wrapped.worst };
  }
  return best;
}

// Finds the stretch of the axis that is solid territory (step 3).
function denseRange(f, floor) {
  const keys = [...f.hist.keys()].sort((a, b) => a - b);
  if (!keys.length) return null;

  const first = keys[0], last = keys[keys.length - 1];
  const w = new Array(last - first + 1).fill(0);
  for (const [k, v] of f.hist) w[k - first] = v;

  const at = (i) => w[clamp(i, 0, w.length - 1)];
  const smooth = (i) => (at(i - 1) + at(i) + at(i + 1)) / 3;

  const total = w.reduce((s, v) => s + v, 0);
  const threshold = (total / w.length) * floor;      // mean width, scaled down

  // Every unbroken run of solid ground across the whole profile.
  const runs = [];
  let run = null;
  for (let i = 0; i < w.length; i++) {
    if (smooth(i) >= threshold) {
      run ??= { lo: i, hi: i, px: 0 };
      run.hi = i;
      run.px += w[i];
    } else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  if (!runs.length) return null;

  // Groups runs, bridging interior gaps.
  const groups = [];
  for (const r of runs) {
    const prev = groups[groups.length - 1];
    const gap = prev ? r.lo - prev.hi - 1 : Infinity;
    const bridgeable = prev
      && gap < (prev.hi - prev.lo + 1)
      && gap < (r.hi - r.lo + 1);
    if (bridgeable) { prev.hi = r.hi; prev.px += r.px; }
    else groups.push({ ...r });
  }

  let best = groups[0];
  for (const g of groups) if (g.px > best.px) best = g;
  const { lo, hi } = best;

  // Clamped to the block's own extent.
  return [
    Math.max((first + lo) * LABEL_HIST_BUCKET, f.tMin),
    Math.min((first + hi + 1) * LABEL_HIST_BUCKET, f.tMax),
    groups.length,
  ];
}

// Builds every label at load, one per contiguous block, indexed by block.
function buildLabels(world, geometry) {
  if (!geometry) return [];
  surrendered.clear();
  return nameArchipelagos(world, geometry, geometry.blocks.map((_, b) => buildLabel(world, geometry, b)));
}

// Blocks that handed their label to a gathered archipelago name.
const surrendered = new Set();

// Gathers mostly-unnamed island countries under one name across their pieces.
function nameArchipelagos(world, geometry, labels) {
  const { blocks, geo } = geometry;

  for (const b of surrendered) labels[b] = buildLabel(world, geometry, b);
  surrendered.clear();

  // Land per country, and how much of it is named.
  const land = new Map();
  const pieces = new Map();
  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    if (!blk || blk.level) continue;
    const n = geo[b] ? geo[b].n : 0;
    const s = land.get(blk.owner) || { total: 0, named: 0, labelled: false };
    s.total += n;
    if (labels[b]) { s.named += n; s.labelled = true; }
    land.set(blk.owner, s);
    if (!pieces.has(blk.owner)) pieces.set(blk.owner, []);
    pieces.get(blk.owner).push(b);
  }

  const plan = new Map();
  for (const [owner, s] of land) {
    if (!s.total || (s.total - s.named) / s.total < LABEL_ISLANDS_SHARE) continue;
    const members = [];
    for (const b of pieces.get(owner)) members.push(...blocks[b].members);
    plan.set(owner, members);
  }

  const { touched, spare } = setIslandBlocks(world, geometry, plan);
  for (const b of spare) labels[b] = null;

  for (const b of touched) {
    const blk = blocks[b];
    const f = geometry.fit[b];

    if (!f || f.tMax - f.tMin > world.width * LABEL_ISLANDS_MAX_SPAN) {
      if (land.get(blk.owner).labelled) {
        blk.members = [];
        geometry.geo[b] = null;
        geometry.fit[b] = null;
        labels[b] = null;
        continue;
      }

      const bs = pieces.get(blk.owner);
      let pick = bs[0];
      for (const q of bs) if ((geo[q]?.n || 0) > (geo[pick]?.n || 0)) pick = q;
      blk.members = [...blocks[pick].members];
      computeBlockGeometry(world, geometry, [b]);
    }

    const L = buildLabel(world, geometry, b, true);
    labels[b] = L;

    if (L) {
      for (const q of pieces.get(blk.owner)) {
        if (labels[q]) { labels[q] = null; surrendered.add(q); }
      }
    }
  }
  return labels;
}

// One block's label, or null if it should not have one.
function buildLabel(world, geometry, b, sparseOK = false) {
  const { blocks, geo, fit } = geometry;
  const blk = blocks[b];
  const g = geo[b], f = fit[b];
  if (!blk || !g || !f) return null;

  const text = world.table.polityById.get(blk.owner).name.toUpperCase();
  const extent = f.tMax - f.tMin;
  const thickness = 2 * Math.sqrt(f.pp / f.n);          // ~2 sigma across
  if (extent <= 0 || thickness <= 0) return null;

  const sparse = g.n / (extent * thickness) < LABEL_MIN_DENSITY;
  if (sparse && !sparseOK) return null;

  const range = sparse ? null : denseRange(f, LABEL_DENSITY_FLOOR);
  if (!sparse && !range) return null;
  const [tLo, tHi, groups] = sparse ? [f.tMin, f.tMax, 1] : range;
  const span = tHi - tLo;
  if (span <= 0) return null;

  const [a2, a1, a0] = solveQuadratic(f) || [0, 0, 0];

  const shape = groups > 1 ? span : extent;
  const tracking = sparse ? LABEL_SPARSE_TRACKING : LABEL_TRACKING;
  const maxLines = sparse ? 1
    : shape / thickness < LABEL_WRAP_ASPECT ? LABEL_MAX_LINES : 1;
  const laid = fitLabel(text, span, sparse ? thickness * LABEL_SPARSE_LIFT : thickness,
    maxLines, tracking);
  if (!laid) return null;

  // Limits the curvature by the type size.
  const radius = BEND_RADIUS * laid.size;
  const bendLimit = 1 / (2 * Math.max(radius, 1));
  const bend = clamp(a2, -bendLimit, bendLimit);

  const a0Fixed = a0 + (f.s0 ? (a2 - bend) * (f.s2 / f.s0) : 0);

  const L = {
    lines: laid.lines, size: clamp(laid.size, 0.05, 400),
    width: laid.width,          // widest line, in ems
    tMid: (tLo + tHi) / 2,
    cx: g.cx, cy: g.cy, ux: g.ux, uy: g.uy,
    a2: bend, a1, a0: a0Fixed,
    block: b,
    tracking,                   // wider on a name written across open water
    sparse,
    isRealm: blk.level === 'realm',
    realmBlock: blk.realmBlock,
    spanY: blk.spanY,           // realm blocks only; see realmHolds()
  };
  L.bounds = labelBounds(L, span);
  return L;
}

// Map-unit box the finished label cannot escape.
function labelBounds(L, span) {
  const half = span / 2;
  const pad = L.size * (L.lines.length * LABEL_LINE_HEIGHT + LABEL_OUTLINE_WIDTH + 1);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= 12; i++) {
    const { x, y } = spinePoint(L, -half + (span * i) / 12);
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

// Least-squares fit of u = a*t^2 + b*t + c; returns [a, b, c] or null.
function solveQuadratic(f) {
  const m = [
    [f.s4, f.s3, f.s2],
    [f.s3, f.s2, f.s1],
    [f.s2, f.s1, f.s0],
  ];
  const v = [f.u2, f.u1, f.u0];
  const det = (n) =>
    n[0][0] * (n[1][1] * n[2][2] - n[1][2] * n[2][1]) -
    n[0][1] * (n[1][0] * n[2][2] - n[1][2] * n[2][0]) +
    n[0][2] * (n[1][0] * n[2][1] - n[1][1] * n[2][0]);
  const d = det(m);
  if (!isFinite(d) || Math.abs(d) < 1e-6) return null;
  const col = (i) => m.map((row, r) => row.map((val, c) => (c === i ? v[r] : val)));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

// Converts a spine position (t along, u across) to map point and angle.
function spinePoint(L, t, u = 0) {
  const tt = L.tMid + t;
  const off = L.a2 * tt * tt + L.a1 * tt + L.a0 + u;
  const slope = 2 * L.a2 * tt + L.a1;
  return {
    x: L.cx + L.ux * tt - L.uy * off,
    y: L.cy + L.uy * tt + L.ux * off,
    angle: Math.atan2(L.uy + L.ux * slope, L.ux - L.uy * slope),
  };
}

// Moves `arc` along the spine from t and returns the t it arrives at.
function advanceT(L, t, arc) {
  if (!L.a2 && !L.a1) return t + arc;        // straight spine: nothing to correct
  const STEPS = 4;
  const d = arc / STEPS;
  for (let i = 0; i < STEPS; i++) {
    const slope = 2 * L.a2 * (L.tMid + t) + L.a1;
    t += d / Math.sqrt(1 + slope * slope);
  }
  return t;
}

function curveWiden(L, t, px) {
  if (!L.a2) return 1;
  const tt = L.tMid + t;
  const slope = 2 * L.a2 * tt + L.a1;
  const radius = Math.pow(1 + slope * slope, 1.5) / Math.abs(2 * L.a2) * view.scale;
  const inner = radius - px / 2;
  return inner > 1 ? radius / inner : 4;
}

// Glyph atlas: each label character baked once per size as a bitmap.

// Glyph sizes snap to a 5% ladder.
const GLYPH_STEP = 1.05;
const GLYPH_MIN = 3;                // below this the label has faded out
const GLYPH_MAX = 512;              // device pixels

// Glyphs bake at twice their display size.
const GLYPH_SUPERSAMPLE = 2;

// Glyph atlas budget, in pixels.
const GLYPH_BUDGET_PX = 8e6;

const glyphAtlas = new Map();
let glyphAtlasPx = 0;
let glyphMeasure = null;            // scratch context, for metrics only

function glyphSize(devicePx) {
  const rung = Math.pow(GLYPH_STEP, Math.round(Math.log(devicePx) / Math.log(GLYPH_STEP)));
  return clamp(rung, GLYPH_MIN, GLYPH_MAX);
}

// One baked character at one size, with its placement metrics.
function bakedGlyph(ch, size) {
  const key = `${size}|${ch}`;
  const had = glyphAtlas.get(key);
  if (had) return had;

  if (!glyphMeasure) glyphMeasure = document.createElement('canvas').getContext('2d');
  glyphMeasure.font = labelFont(size);
  glyphMeasure.textAlign = 'center';
  glyphMeasure.textBaseline = 'middle';
  const m = glyphMeasure.measureText(ch);

  const left = m.actualBoundingBoxLeft, right = m.actualBoundingBoxRight;
  const up = m.actualBoundingBoxAscent, down = m.actualBoundingBoxDescent;
  const pad = Math.ceil(size * LABEL_OUTLINE_WIDTH / 2) + 2;   // room for the halo
  const w = Math.ceil(left + right) + pad * 2;
  const h = Math.ceil(up + down) + pad * 2;

  const g = { canvas: null, w, h, ox: left + pad, oy: up + pad, adv: m.width };

  if (w > 0 && h > 0 && (left + right) > 0 && (up + down) > 0) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const x = c.getContext('2d');
    x.font = labelFont(size);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.lineJoin = 'round';
    x.lineWidth = size * LABEL_OUTLINE_WIDTH;

    x.strokeStyle = `rgba(${LABEL_OUTLINE},${LABEL_OUTLINE_ALPHA})`;
    x.fillStyle = `rgba(${LABEL_COLOUR},${LABEL_COLOUR_OPACITY})`;
    x.strokeText(ch, g.ox, g.oy);
    x.fillText(ch, g.ox, g.oy);
    g.canvas = c;
  }

  if (glyphAtlasPx + w * h > GLYPH_BUDGET_PX) {
    glyphAtlas.clear();
    glyphAtlasPx = 0;
  }
  glyphAtlas.set(key, g);
  glyphAtlasPx += w * h;
  return g;
}

// The tilted rectangle one glyph occupies on screen.
function glyphBox(g, k, atX, atY, angle) {
  const w = g.w * k, h = g.h * k;
  const cos = Math.cos(angle), sin = Math.sin(angle);

  const offX = w / 2 - g.ox * k;
  const offY = h / 2 - g.oy * k;
  return {
    cx: atX + offX * cos - offY * sin,
    cy: atY + offX * sin + offY * cos,
    hw: w / 2,
    hh: h / 2,
    ax: cos,
    ay: sin,
  };
}

// Area shared by an upright box and a tilted one, in square screen pixels.
function glyphOverlapArea(b, g) {
  const ux = g.ax * g.hw, uy = g.ay * g.hw;      // half-width vector, along the glyph
  const vx = -g.ay * g.hh, vy = g.ax * g.hh;     // half-height vector, across it
  let poly = [
    [g.cx - ux - vx, g.cy - uy - vy],
    [g.cx + ux - vx, g.cy + uy - vy],
    [g.cx + ux + vx, g.cy + uy + vy],
    [g.cx - ux + vx, g.cy - uy + vy],
  ];

  // Signed distance into the box for each edge; positive is inside.
  const edges = [
    (p) => p[0] - b[0], (p) => b[2] - p[0],
    (p) => p[1] - b[1], (p) => b[3] - p[1],
  ];
  for (const depth of edges) {
    if (poly.length < 3) return 0;
    const next = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], c = poly[(i + 1) % poly.length];
      const da = depth(a), dc = depth(c);
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (dc >= 0)) {
        const t = da / (da - dc);                // where the edge crosses
        next.push([a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]);
      }
    }
    poly = next;
  }
  if (poly.length < 3) return 0;

  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length];
    twice += a[0] * c[1] - c[0] * a[1];
  }
  return Math.abs(twice) / 2;
}

// Grid: screen-space buckets for nearby-item queries during city placement.
const GRID_CELL = 96;

function makeGrid() {
  const cells = new Map();
  let query = 0;

  const forCells = (x0, y0, x1, y1, fn) => {
    const c0 = Math.floor(x0 / GRID_CELL), c1 = Math.floor(x1 / GRID_CELL);
    const r0 = Math.floor(y0 / GRID_CELL), r1 = Math.floor(y1 / GRID_CELL);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) fn((r + 512) * 4096 + (c + 512));
    }
  };

  return {
    add(item, x0, y0, x1, y1) {
      forCells(x0, y0, x1, y1, (key) => {
        const list = cells.get(key);
        if (list) list.push(item);
        else cells.set(key, [item]);
      });
    },

    // Items in the cells this rectangle touches, each once, into `out`.
    near(x0, y0, x1, y1, out) {
      out.length = 0;
      query++;
      forCells(x0, y0, x1, y1, (key) => {
        const list = cells.get(key);
        if (!list) return;
        for (const item of list) {
          if (item.seenBy === query) continue;
          item.seenBy = query;
          out.push(item);
        }
      });
      return out;
    },
  };
}

// The upright box a tilted glyph box fits inside.
function glyphExtent(g) {
  const cos = Math.abs(g.ax), sin = Math.abs(g.ay);
  return [
    g.cx - (g.hw * cos + g.hh * sin), g.cy - (g.hw * sin + g.hh * cos),
    g.cx + (g.hw * cos + g.hh * sin), g.cy + (g.hw * sin + g.hh * cos),
  ];
}

// Is this screen point inside a tilted glyph box?
function pointInGlyph(x, y, g) {
  const dx = x - g.cx, dy = y - g.cy;
  return Math.abs(dx * g.ax + dy * g.ay) <= g.hw && Math.abs(dy * g.ax - dx * g.ay) <= g.hh;
}

// What fraction of an upright box the glyphs cover, 0 to 1.
function coveredFraction(b, glyphs) {
  if (!glyphs || !glyphs.length) return 0;
  const w = b[2] - b[0], h = b[3] - b[1];
  if (w <= 0 || h <= 0) return 0;

  const near = glyphs.filter((g) => boxHitsGlyph(b, g));
  if (!near.length) return 0;

  const N = COVERAGE_SAMPLES;
  let inside = 0;
  for (let iy = 0; iy < N; iy++) {
    const y = b[1] + h * (iy + 0.5) / N;
    for (let ix = 0; ix < N; ix++) {
      const x = b[0] + w * (ix + 0.5) / N;
      if (near.some((g) => pointInGlyph(x, y, g))) inside++;
    }
  }
  return inside / (N * N);
}

function boxHitsGlyph(b, g) {
  const bx = (b[0] + b[2]) / 2, by = (b[1] + b[3]) / 2;
  const bhw = (b[2] - b[0]) / 2, bhh = (b[3] - b[1]) / 2;
  const dx = g.cx - bx, dy = g.cy - by;
  const c = Math.abs(g.ax), s = Math.abs(g.ay);

  if (Math.abs(dx) > bhw + g.hw * c + g.hh * s) return false;
  if (Math.abs(dy) > bhh + g.hw * s + g.hh * c) return false;
  if (Math.abs(dx * g.ax + dy * g.ay) > g.hw + bhw * c + bhh * s) return false;
  if (Math.abs(dy * g.ax - dx * g.ay) > g.hh + bhw * s + bhh * c) return false;
  return true;
}

// Lays out every glyph of every polity name; paintLabels() draws it.
function layoutLabels(labels, cssW, cssH, dx, boxes = null) {
  labelOpCount = 0;
  const holds = realmHolds(labels, cssH);
  const s = view.scale;
  const dimming = labelDimming();

  for (const L of labels) {
    if (!L) continue;              // a block with no name, or one emptied by a change

    const b = L.bounds;
    if (b.x1 * s + view.x + dx < 0 || b.x0 * s + view.x + dx > cssW
      || b.y1 * s + view.y < 0 || b.y0 * s + view.y > cssH) continue;

    const px = L.size * view.scale;
    let alpha;
    if (L.isRealm) {
      alpha = LABEL_ALPHA * smoothstep(LABEL_FADE_IN[0], LABEL_FADE_IN[1], px) * (holds.get(L.block) || 0);
    } else {
      alpha = labelOpacity(px, (L.width * px) / cssW);
      if (L.realmBlock !== undefined) alpha *= 1 - (holds.get(L.realmBlock) || 0);
    }
    alpha *= dimming;
    if (alpha <= 0.004) continue;              // fully faded, or not readable yet

    const gap = px * L.tracking;

    const bake = glyphSize(px * live.pixelRatio * GLYPH_SUPERSAMPLE);
    const k = px / bake;

    const n = L.lines.length;
    for (let li = 0; li < n; li++) {
      const across = (li - (n - 1) / 2) * LABEL_LINE_HEIGHT * px / view.scale;
      const chars = [...L.lines[li]];

      const glyphs = chars.map((c) => bakedGlyph(c, bake));
      const widths = glyphs.map((g) => g.adv * k);

      const flat = widths.reduce((s, w) => s + w, 0) + gap * (chars.length - 1);
      let at = -flat / 2, widen = 1;
      for (let i = 0; i < chars.length; i++) {
        widen = Math.max(widen, curveWiden(L, (at + widths[i] / 2) / view.scale, px));
        at += widths[i] + gap;
      }

      const spacing = gap * widen;
      const total = widths.reduce((s, w) => s + w, 0) + spacing * (chars.length - 1);

      // Walks the glyphs along the curve.
      let t = advanceT(L, 0, -total / 2 / view.scale);
      for (let i = 0; i < chars.length; i++) {
        t = advanceT(L, t, widths[i] / 2 / view.scale);
        const g = glyphs[i];
        if (g.canvas) {
          const { x, y, angle } = spinePoint(L, t, across);
          const atX = x * view.scale + view.x;
          const atY = y * view.scale + view.y;

          const op = labelOps[labelOpCount] || (labelOps[labelOpCount] = {});
          op.canvas = g.canvas;
          op.dx = -g.ox * k;
          op.dy = -g.oy * k;
          op.dw = g.w * k;
          op.dh = g.h * k;
          op.atX = atX;
          op.atY = atY;
          op.angle = angle;
          op.alpha = alpha;
          labelOpCount++;

          if (boxes) boxes.push(glyphBox(g, k, atX, atY, angle));
        }
        t = advanceT(L, t, (widths[i] / 2 + spacing) / view.scale);
      }
    }
  }
  return labelOpCount;
}

// Window-height shares over which a realm's name hands over to its members'.
const REALM_HANDOVER = [0.75, 0.90];

// How much each realm's name stands in for its members', 1 down to 0.
const realmHold = new Map();
function realmHolds(labels, cssH) {
  realmHold.clear();
  for (const L of labels) {
    if (!L || !L.isRealm) continue;
    const covers = (L.spanY || 0) * view.scale / cssH;
    realmHold.set(L.block, 1 - smoothstep(REALM_HANDOVER[0], REALM_HANDOVER[1], covers));
  }
  return realmHold;
}

// Reusable op queue that layoutLabels() fills and paintLabels() empties.
const labelOps = [];
let labelOpCount = 0;

// Blits a label layout.
function paintLabels(ctx, n) {
  if (!n) return;
  ctx.save();
  ctx.imageSmoothingEnabled = true;

  let alpha = -1;
  for (let i = 0; i < n; i++) {
    const op = labelOps[i];
    if (op.alpha !== alpha) { ctx.globalAlpha = alpha = op.alpha; }
    ctx.save();
    ctx.translate(op.atX, op.atY);
    ctx.rotate(op.angle);
    ctx.drawImage(op.canvas, op.dx, op.dy, op.dw, op.dh);
    ctx.restore();
  }
  ctx.restore();
}

// White silhouette of one province at map resolution, cropped to its bounds.
function buildSilhouette(world, id, at = world.provinceAt) {
  const bb = world.bounds.get(id);
  if (!bb) return null;

  const w = bb.maxX - bb.minX + 1;
  const h = bb.maxY - bb.minY + 1;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const index = world.byId.get(id).index;
  for (let y = 0; y < h; y++) {
    const row = (bb.minY + y) * world.width;
    for (let x = 0; x < w; x++) {
      const mx = bb.minX + x;
      if (at[row + (mx < world.width ? mx : mx - world.width)] !== index) continue;
      const o = (y * w + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, x: bb.minX, y: bb.minY, w, h };
}

// The province border as a path, in the silhouette's pixel coordinates.
function buildOutlinePath(s) {
  const w = s.w, h = s.h;
  const data = s.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] !== 0;

  const path = new Path2D();
  let segments = 0;

  for (let y = 0; y <= h; y++) {
    let run = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && on(x, y) !== on(x, y - 1);
      if (edge && run < 0) run = x;
      else if (!edge && run >= 0) { path.moveTo(run, y); path.lineTo(x, y); segments++; run = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && on(x, y) !== on(x - 1, y);
      if (edge && run < 0) run = y;
      else if (!edge && run >= 0) { path.moveTo(x, run); path.lineTo(x, y); segments++; run = -1; }
    }
  }
  s.segments = segments;
  return path;
}

export { LABEL_TRACKING, LABEL_LINE_HEIGHT, LABEL_ALPHA, LABEL_DIM_TO, LABEL_DIM_MS, labelDim, labelDimClock, stepLabelDim, labelDimming, LABEL_FADE_IN, LABEL_FADE_OUT, smoothstep, labelOpacity, BEND_RADIUS, LABEL_COLOUR, LABEL_OUTLINE, LABEL_COLOUR_OPACITY, LABEL_OUTLINE_ALPHA, LABEL_OUTLINE_WIDTH, LABEL_FIT, LABEL_MAX_LINES, LABEL_WRAP_ASPECT, LABEL_WRAP_GAIN, LABEL_DENSITY_FLOOR, LABEL_MIN_DENSITY, LABEL_ISLANDS_SHARE, LABEL_SPARSE_TRACKING, LABEL_SPARSE_LIFT, LABEL_ISLANDS_MAX_SPAN, LABEL_FACE, RESOURCE_FACE, resourceFont, resourceIconPx, labelFont, MEASURE_SIZE, measureCtx, widthRatio, wrapInto, fitLabel, denseRange, buildLabels, surrendered, nameArchipelagos, buildLabel, labelBounds, solveQuadratic, spinePoint, advanceT, curveWiden, GLYPH_STEP, GLYPH_MIN, GLYPH_MAX, GLYPH_SUPERSAMPLE, GLYPH_BUDGET_PX, glyphAtlas, glyphAtlasPx, glyphMeasure, glyphSize, bakedGlyph, glyphBox, glyphOverlapArea, GRID_CELL, makeGrid, glyphExtent, pointInGlyph, coveredFraction, boxHitsGlyph, layoutLabels, REALM_HANDOVER, realmHold, realmHolds, labelOps, labelOpCount, paintLabels, buildSilhouette, buildOutlinePath };
