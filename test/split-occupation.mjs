/*
 * A province the front runs through is drawn county by county.
 *
 * Occupation is held by county, so a province can be part held. The political
 * map coloured each province wholly by its derived occupier, so a province two
 * thirds occupied read as the occupier's to the last field. Each county now
 * takes the colour of whoever holds it, an occupied one carries the owner's
 * stripes, the line between the two holders is drawn as a frontier, and every
 * province that is not split is painted byte for byte as it was.
 *
 * The map is loaded twice, in two processes, since a page loads once per
 * process: as the data stands, and with a third of one occupied province handed
 * back to its owner. The first is what every pixel away from the handed-back
 * ground has to match.
 *
 * The imagery is withheld from both, which keeps the fill flat. With it on, the
 * political map washes toward a pastel by distance from the frontier and no
 * pixel could be checked against a polity's colour.
 *
 *   node --max-old-space-size=6144 test/split-occupation.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const here = fileURLToPath(import.meta.url);
const root = path.join(path.dirname(here), '..');
const role = process.argv.find((a) => a.startsWith('--child='))?.slice('--child='.length);
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const TILE = Number(/const TILE = (\d+)/.exec(fs.readFileSync(path.join(root, 'src/main.js'), 'utf8'))[1]);

// ------------------------------------------------------------- which ground
// The wholly occupied province with the most counties. A third of them are
// handed back: fewer than half, so its derived occupier is unchanged, the map
// cache's hash still matches, and both runs restore the same cache.
const inProvince = new Map();
for (const c of read('data/json/geography/counties.json').counties) {
  if (!inProvince.has(c.province)) inProvince.set(c.province, []);
  inProvince.get(c.province).push(c.id);
}
let target = null;
for (const [occupier, owners] of Object.entries(read('data/json/province/counties-starting-values.json').occupation || {})) {
  for (const [owner, ids] of Object.entries(owners)) {
    const held = new Set(ids);
    for (const [pid, list] of inProvince) {
      if (!list.every((id) => held.has(id))) continue;
      if (!target || list.length > target.list.length) target = { pid, occupier, owner, list };
    }
  }
}
const freed = new Set(target ? target.list.slice(0, Math.floor(target.list.length / 3)) : []);

// ================================================================ one load
if (role) {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  const { install, fire } = await import('./dom-shim.mjs');
  const dom = install(root);
  const problems = [];
  process.on('uncaughtException', (e) => problems.push(e));
  process.on('unhandledRejection', (e) => problems.push(e));

  // No imagery, so the fill is flat. In the split run, a third of the province
  // is handed back before the page ever sees the occupation.
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('satellite.png')) return { ok: false, status: 404 };
    const res = await real(url, opts);
    if (role !== 'split' || !u.includes('counties-starting-values.json')) return res;
    const json = await res.json();
    const ids = json.occupation[target.occupier][target.owner];
    json.occupation[target.occupier][target.owner] = ids.filter((id) => !freed.has(id));
    return { ok: true, status: 200, json: async () => json };
  };

  // Every tile's pixels as the painter last left them. The tiles are made in one
  // run, row by row, and the first TILE-square createImageData is on tile 0, so
  // a tile's place on the map is its place in that run.
  const createElement = document.createElement.bind(document);
  const Ctx = Object.getPrototypeOf(createElement('canvas').getContext('2d'));
  const made = [];
  document.createElement = (tag, ...rest) => {
    const el = createElement(tag, ...rest);
    if (String(tag).toLowerCase() === 'canvas') made.push(el);
    return el;
  };
  let tile0 = null;
  const createImageData = Ctx.createImageData;
  Ctx.createImageData = function (w, h) {
    if (tile0 === null && w === TILE && h === TILE) tile0 = this.canvas;
    return createImageData.call(this, w, h);
  };
  const painted = new Map();
  const putImageData = Ctx.putImageData;
  Ctx.putImageData = function (img, dx, dy, sx = 0, sy = 0, w = img.width, h = img.height) {
    const cv = this.canvas;
    if (cv.width <= TILE && cv.height <= TILE) {
      if (!painted.has(cv)) painted.set(cv, new Uint8ClampedArray(cv.width * cv.height * 4));
      const buf = painted.get(cv);
      for (let y = sy; y < sy + h; y++) {
        const from = (y * img.width + sx) * 4;
        buf.set(img.data.subarray(from, from + w * 4), ((y + dy) * cv.width + sx + dx) * 4);
      }
    }
    return putImageData.call(this, img, dx, dy, sx, sy, w, h);
  };

  await import('../src/main.js');
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      const q = dom.frameQueue.splice(0, dom.frameQueue.length);
      if (!q.length) break;
      for (const fn of q) {
        try { fn(performance.now()); } catch (e) { problems.push(e); return; }
      }
    }
  };
  for (let i = 0; i < 400 && !dom.frameQueue.length; i++) await new Promise((r) => setTimeout(r, 50));
  fire(dom.el('start-enter'), 'click');
  run(40);

  const game = globalThis.window.game;
  const w = game.world();
  const W = w.width, H = w.height;
  const cols = Math.ceil(W / TILE);
  const first = made.indexOf(tile0);
  const tileAt = (x, y) => made[first + Math.floor(y / TILE) * cols + Math.floor(x / TILE)];

  // The province and a margin round it, so its frontiers are in the picture.
  const bb = w.bounds.get(target.pid);
  const M = 24;
  const x0 = Math.max(0, bb.minX - M), y0 = Math.max(0, bb.minY - M);
  const x1 = Math.min(W - 1, bb.maxX + M), y1 = Math.min(H - 1, bb.maxY + M);
  const needed = new Set();
  for (let y = y0; y <= y1; y += TILE) for (let x = x0; x <= x1; x += TILE) needed.add(tileAt(x, y));
  for (const x of [x0, x1]) for (const y of [y0, y1]) needed.add(tileAt(x, y));

  game.lookAt((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, 2);
  for (let k = 0; k < 600; k++) {
    run(5);
    if ([...needed].every((c) => painted.has(c))) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  run(20);

  const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
  const rgba = new Uint8Array(rw * rh * 4);
  let unpainted = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cv = tileAt(x, y), buf = painted.get(cv);
      if (!buf) { unpainted++; continue; }
      const s = ((y % TILE) * cv.width + (x % TILE)) * 4, d = ((y - y0) * rw + (x - x0)) * 4;
      rgba[d] = buf[s]; rgba[d + 1] = buf[s + 1]; rgba[d + 2] = buf[s + 2]; rgba[d + 3] = buf[s + 3];
    }
  }

  // Which pixels the handing back may change, and the exact colours on the
  // province itself. Only the split run can say, since only it knows the front.
  const P = w.byId.get(target.pid).index;
  const cAt = w.counties.countyAt;
  const isFreed = (j) => j >= 0 && w.provinceAt[j] === P && freed.has(w.counties.atIndex[cAt[j]]?.id);
  const rightOf = (j) => ((j % W) + 1 < W ? j + 1 : j - (j % W));
  const belowOf = (j) => (j + W < W * H ? j + W : -1);
  const cls = new Uint8Array(rw * rh);    // 0 must match the baseline, 1 may change, 2 handed back
  const lines = [];
  if (role === 'split') {
    const colour = (id) => w.table.polityById.get(id).colour;
    const owner = colour(target.owner), occ = colour(target.occupier);
    const same = (c, k) => c[0] === k[0] && c[1] === k[1] && c[2] === k[2];
    const n = { freed: 0, freedWrong: 0, fill: 0, stripe: 0, heldWrong: 0, front: 0, frontWrong: 0, quiet: 0, quietWrong: 0 };
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x, l = (y - y0) * rw + (x - x0);
        const nb = [rightOf(i), belowOf(i)].filter((j) => j >= 0);
        const mine = isFreed(i);
        if (w.provinceAt[i] !== P) { cls[l] = nb.some(isFreed) ? 1 : 0; continue; }
        cls[l] = mine ? 2 : (nb.some(isFreed) ? 1 : 0);

        const c = rgba.subarray(l * 4, l * 4 + 3);
        const fill = mine ? owner : occ;
        const across = nb.some((j) => w.provinceAt[j] === P && isFreed(j) !== mine);
        const outside = nb.some((j) => w.provinceAt[j] !== P);
        const county = nb.some((j) => w.provinceAt[j] === P && cAt[j] !== cAt[i] && isFreed(j) === mine);
        if (across) {
          // The front: darker than its own fill in every channel, never the fill.
          n.front++;
          if (same(c, fill) || c[0] > fill[0] || c[1] > fill[1] || c[2] > fill[2]) n.frontWrong++;
        } else if (outside) {
          // A frontier or a subdivision with the next province: not this test's.
        } else if (county) {
          // Two counties of the same holder: no line between them.
          n.quiet++;
          if (!same(c, fill) && !(!mine && same(c, owner))) n.quietWrong++;
        } else if (mine) {
          n.freed++;
          if (!same(c, owner)) n.freedWrong++;
        } else if (same(c, occ)) n.fill++;
        else if (same(c, owner)) n.stripe++;
        else n.heldWrong++;
      }
    }
    lines.push([n.freed > 0 && n.freedWrong === 0,
      `the ${freed.size} counties handed back are the owner's colour, unstriped: ${n.freed} px, ${n.freedWrong} wrong`]);
    lines.push([n.fill > 0 && n.stripe > 0 && n.heldWrong === 0,
      `the ${target.list.length - freed.size} still held are the occupier's, striped with the owner's: ${n.fill} + ${n.stripe} px, ${n.heldWrong} wrong`]);
    lines.push([n.front > 0 && n.frontWrong === 0,
      `the front between them is drawn as a line: ${n.front} px, ${n.frontWrong} not darker than their fill`]);
    lines.push([n.quietWrong === 0,
      `and two counties of one holder meet with no line: ${n.quiet} px, ${n.quietWrong} wrong`]);
  }

  fs.writeFileSync(out, JSON.stringify({
    region: [x0, y0, rw, rh], unpainted, problems: problems.map((e) => e.stack || String(e)), lines,
    rgba: Buffer.from(rgba).toString('base64'), cls: Buffer.from(cls).toString('base64'),
  }));
  process.exit(0);
}

// ================================================================ the two
const problems = [];
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) problems.push(m); };

ok(Boolean(target) && target.list.length >= 3,
  `an occupied province with three or more counties: ${target?.pid}, ${target?.list.length} counties, ${target?.occupier} over ${target?.owner}`);
if (!target || target.list.length < 3) process.exit(1);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'split-occupation-'));
const load = (which) => {
  const out = path.join(tmp, `${which}.json`);
  const r = spawnSync(process.execPath, ['--max-old-space-size=6144', here, `--child=${which}`, '--out', out],
    { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  const said = `${r.stdout || ''}${r.stderr || ''}`;
  ok(!/out of date/.test(said), `the ${which} run restored the map cache`);
  if (!fs.existsSync(out)) {
    console.log(said.split('\n').slice(-20).join('\n'));
    ok(false, `the ${which} run finished`);
    process.exit(1);
  }
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  ok(got.problems.length === 0, `the ${which} run threw nothing${got.problems.length ? ': ' + got.problems[0] : ''}`);
  ok(got.unpainted === 0, `the ${which} run painted all of ${target.pid} and its margin`);
  return { ...got, rgba: Buffer.from(got.rgba, 'base64'), cls: Buffer.from(got.cls, 'base64') };
};

const base = load('baseline');
const split = load('split');
fs.rmSync(tmp, { recursive: true, force: true });

for (const [c, m] of split.lines) ok(c, m);

ok(base.region.join() === split.region.join(), 'both runs read the same ground');
let kept = 0, moved = 0, freedPx = 0, freedChanged = 0;
for (let l = 0; l < split.cls.length; l++) {
  const s = l * 4;
  const differs = base.rgba[s] !== split.rgba[s] || base.rgba[s + 1] !== split.rgba[s + 1]
    || base.rgba[s + 2] !== split.rgba[s + 2] || base.rgba[s + 3] !== split.rgba[s + 3];
  if (split.cls[l] === 0) { kept++; if (differs) moved++; }
  else if (split.cls[l] === 2) { freedPx++; if (differs) freedChanged++; }
}
ok(moved === 0, `every pixel away from the handed-back ground is as it was: ${kept} px, ${moved} changed`);
// A stripe in the old picture was already the owner's colour, so about one pixel
// in five of the handed-back ground reads the same either way.
ok(freedChanged > freedPx / 2, `and the handed-back ground did change: ${freedChanged} of ${freedPx} px`);

if (problems.length) {
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('\na province the front runs through is drawn county by county');
