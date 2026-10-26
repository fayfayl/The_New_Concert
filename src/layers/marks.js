// Building marks on the map and placing buildings.

const VERSION = new URL(import.meta.url).search;
const { BUILDINGS, BUILDING_AT } = await import(`../world/provincestats.js${VERSION}`);
const { OCEAN } = await import(`../world/mapdata.js${VERSION}`);
const { state, worldChanged } = await import(`../core/core.js${VERSION}`);
const { BUILDING_ICON_PX, BUILDING_OUTLINE_PX, F_BUILDING } = await import(`./cities.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let cityFade, debug, view;
export function link(all) { ({ cityFade, debug, view } = all); }

// Screen boxes of drawn building marks, read by the hover.
const markHits = [];

const MARK_RING = 0.20;           // of the mean of the county's width and height
const MARK_OFF_EDGE = 2;          // min distance from the county edge

const DOCKYARD_RING = 10;         // ring radius from the yard's coastal city
const DOCKYARD_RADII = [10, 8, 6, 4];  // radii tried, largest first
const DOCKYARD_OFF_CITY = 3;      // min distance from the town marker
const DOCKYARD_OFF_FRONTIER = 5;  // min distance from a frontier
const DOCKYARD_PORT_PX = 5;       // city this close to water counts as a port
const DOCKYARD_OFF_WATER = 2;     // min distance from the waterline
const DOCKYARD_NEAR_COAST = 6;    // max distance from the coast
const DOCKYARD_SHORE_REACH = 8;   // search radius for the nearest water

// Minimum gap between two marks in one province.
const MARK_MIN_GAP = 10;

// Stored positions of a province's other building marks, as [x, y] pairs.
function otherMarksIn(w, id, mine) {
  const e = w.stats?.[id];
  if (!e) return [];
  const out = [];
  for (const k of BUILDINGS) {
    if (k === mine || !e[k]) continue;
    const at = e[BUILDING_AT[k]];
    if (Array.isArray(at) && at.length === 2) out.push(at);
  }
  return out;
}

const clearOfMarks = (others, x, y) => {
  for (const [ox, oy] of others)
    if ((x - ox) ** 2 + (y - oy) ** 2 < MARK_MIN_GAP * MARK_MIN_GAP) return false;
  return true;
};

function markHash(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

let markAnchors = new Map(), markAnchorWorld = null;

// Where a building's mark stands inside its county.
function markAnchor(w, countyId, kind) {
  if (markAnchorWorld !== w) { markAnchors = new Map(); markAnchorWorld = w; }
  const key = countyId + ':' + kind;
  const hit = markAnchors.get(key);
  if (hit) return hit;
  const put = (a) => { markAnchors.set(key, a); return a; };

  const g = countyGround(w, countyId);
  if (!g) return put({ ax: 0, ay: 0, lost: true });

  const { bb } = g;
  const cx = bb.sx / bb.n, cy = bb.sy / bb.n;
  const bw = bb.maxX - bb.minX + 1, bh = bb.maxY - bb.minY + 1;
  const others = g.others().filter(([ox, oy]) => !(ox === undefined));
  const spaced = (x, y) => others.every(([ox, oy]) =>
    (x - ox) ** 2 + (y - oy) ** 2 >= MARK_MIN_GAP * MARK_MIN_GAP);

  const start = markHash(key) * Math.PI * 2;
  const radii = [MARK_RING * (bw + bh) / 2, 4, 2];

  if (kind === 'dockyard') {
    // Dockyard: off a port town, else off the shore.
    const ports = (w.cities || []).filter((c) =>
      g.mine(c.x, c.y) && g.seaWithin(c.x, c.y, DOCKYARD_PORT_PX));

    if (ports.length) {
      const city = ports[Math.floor(markHash(key + ':city') * ports.length) % ports.length];
      const seaGap = (x, y) => {
        for (let r = 1; r <= DOCKYARD_NEAR_COAST; r++) if (g.seaWithin(x, y, r)) return r;
        return DOCKYARD_NEAR_COAST + 1;
      };
      const nearestWater = (x, y) => {
        for (let r = 1; r <= DOCKYARD_SHORE_REACH; r++) {
          let found = null, near = Infinity;
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
              const d = dx * dx + dy * dy;
              if (d < near && g.water(x + dx, y + dy)) { near = d; found = [dx, dy]; }
            }
          }
          if (found) return found;
        }
        return null;
      };
      const home = nearestWater(city.x, city.y);
      const onCityShore = (x, y) => {
        if (!home) return true;
        const w2 = nearestWater(x, y);
        return w2 ? home[0] * w2[0] + home[1] * w2[1] >= 0 : false;
      };
      for (let shore = 0; shore < 2; shore++) {
        for (let pass = 0; pass < 2; pass++) {
          for (const r of DOCKYARD_RADII) {
            let best = null, bestGap = Infinity;
            for (let k = 0; k < 16; k++) {
              const th = start + k * Math.PI / 8;
              const x = Math.round(city.x + Math.cos(th) * r);
              const y = Math.round(city.y + Math.sin(th) * r);
              if (!g.mine(x, y)) continue;
              if (g.seaWithin(x, y, DOCKYARD_OFF_WATER)) continue;
              if (pass < 1 && !g.seaWithin(x, y, DOCKYARD_NEAR_COAST)) continue;
              if (shore < 1 && !onCityShore(x, y)) continue;
              if (!spaced(x, y)) continue;
              const gap = seaGap(x, y);
              if (gap < bestGap) { bestGap = gap; best = { ax: x, ay: y }; }
            }
            if (best) return put(best);
          }
        }
      }
    }

    // Fallback: a hashed coastal pixel.
    const shore = [];
    for (let y = bb.minY; y <= bb.maxY; y++) {
      for (let x = bb.minX; x <= bb.maxX; x++) {
        if (!g.mine(x, y)) continue;
        if (g.seaWithin(x, y, DOCKYARD_OFF_WATER)) continue;
        if (!g.seaWithin(x, y, DOCKYARD_NEAR_COAST)) continue;
        if (g.foreignWithin(x, y, DOCKYARD_OFF_FRONTIER)) continue;
        if (!spaced(x, y)) continue;
        shore.push([x, y]);
      }
    }
    if (shore.length) {
      const p = shore[Math.floor(markHash(key + ':shore') * shore.length) % shore.length];
      return put({ ax: p[0], ay: p[1] });
    }
    return put({ ax: Math.round(cx), ay: Math.round(cy), coastless: true });
  }

  // Eyrie and other kinds without a site rule.
  for (const r of radii) {
    if (r < 1) continue;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < 16; k++) {
        const th = start + k * Math.PI / 8;
        const x = Math.round(cx + Math.cos(th) * r);
        const y = Math.round(cy + Math.sin(th) * r);
        if (!g.mine(x, y)) continue;
        if (pass < 1 && !g.clear(x, y, MARK_OFF_EDGE)) continue;
        if (!spaced(x, y)) continue;
        return put({ ax: x, ay: y });
      }
    }
  }
  // Fallback: the county's middle.
  return put({ ax: Math.round(cx), ay: Math.round(cy) });
}

// Stored mark position, or a new one written onto the county.
function markAt(w, countyId, kind, c) {
  const key = BUILDING_AT[kind];
  const at = c[key];
  if (Array.isArray(at) && at.length === 2) return { ax: at[0], ay: at[1] };
  const a = markAnchor(w, countyId, kind);
  c[key] = [a.ax, a.ay];        // fixed from here on, and written out on save
  return a;
}

let navigableLakeSet = null, navigableLakeWorld = null;

// Lakes with two or more towns, as a set of sea region slots.
function navigableLakes(w) {
  if (navigableLakeWorld === w && navigableLakeSet) return navigableLakeSet;
  const sea = w.sea, at = w.provinceAt, W = w.width, H = w.height;
  const found = new Map();
  if (sea?.seaAt && at) {
    const wrap = (x) => ((x % W) + W) % W;
    const r = DOCKYARD_PORT_PX, rr = r * r;
    for (const c of w.cities || []) {
      const touched = new Set();
      for (let dy = -r; dy <= r; dy++) {
        const y = c.y + dy;
        if (y < 0 || y >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > rr) continue;
          const p = y * W + wrap(c.x + dx);
          if (at[p] !== OCEAN) continue;
          const slot = sea.seaAt[p];
          if (sea.atIndex[slot]?.lake) touched.add(slot);
        }
      }
      for (const slot of touched) found.set(slot, (found.get(slot) || 0) + 1);
    }
  }
  navigableLakeSet = new Set([...found].filter(([, n]) => n > 1).map(([slot]) => slot));
  navigableLakeWorld = w;
  return navigableLakeSet;
}

// Shared placement queries for a county; null if off the map.
function countyGround(w, countyId) {
  const cs = w.counties;
  const c = cs?.byId?.get(countyId);
  const bb = cs?.bounds?.get(countyId);
  const at = cs?.countyAt;
  if (!c || !bb || !at) return null;

  const W = cs.width, H = cs.height, index = c.index;
  const pat = w.provinceAt;
  const wrap = (x) => ((x % W) + W) % W;

  const sea = w.sea;
  const lakes = sea?.seaAt ? navigableLakes(w) : null;

  const g = {
    c, bb, W, H, wrap,
    mine: (x, y) => y >= 0 && y < H && at[y * W + wrap(x)] === index,
    // Navigable water: sea, or a lake with two towns.
    water: (x, y) => {
      if (y < 0 || y >= H || !pat) return false;
      const p = y * W + wrap(x);
      if (pat[p] !== OCEAN) return false;
      if (!sea?.seaAt) return true;
      const slot = sea.seaAt[p];
      const region = sea.atIndex[slot];
      if (!region) return false;
      return region.lake ? lakes.has(slot) : true;
    },
    // Ground of another country.
    foreign: (x, y) => {
      if (y < 0 || y >= H || !pat) return false;
      const p = y * W + wrap(x);
      if (pat[p] === OCEAN) return false;
      return w.atIndex[pat[p]]?.owner !== w.atIndex[pat[y * W + wrap(x)]]?.owner
        ? true
        : w.byId.get(c.province)?.owner !== w.atIndex[pat[p]]?.owner;
    },
  };
  g.seaWithin = (x, y, r) => {
    const b = Math.ceil(r), rr = r * r;
    for (let dy = -b; dy <= b; dy++)
      for (let dx = -b; dx <= b; dx++)
        if (dx * dx + dy * dy <= rr && g.water(x + dx, y + dy)) return true;
    return false;
  };
  g.foreignWithin = (x, y, r) => {
    const b = Math.ceil(r), rr = r * r;
    for (let dy = -b; dy <= b; dy++)
      for (let dx = -b; dx <= b; dx++)
        if (dx * dx + dy * dy <= rr && g.foreign(x + dx, y + dy)) return true;
    return false;
  };
  // Clear of the county edge within radius r.
  g.clear = (x, y, r) => {
    const b = Math.ceil(r), rr = r * r;
    for (let dy = -b; dy <= b; dy++)
      for (let dx = -b; dx <= b; dx++)
        if (dx * dx + dy * dy < rr && !g.mine(x + dx, y + dy)) return false;
    return true;
  };
  // Marks in this county, its province, and touching counties.
  g.others = () => {
    const out = [];
    const seen = new Set([countyId]);
    const near = [c];
    for (const q of cs.atIndex) if (q && q.province === c.province && !seen.has(q.id)) { seen.add(q.id); near.push(q); }
    for (const id2 of cs.adjacency?.get(countyId) || []) {
      if (seen.has(id2)) continue;
      seen.add(id2);
      const q = cs.byId.get(id2);
      if (q) near.push(q);
    }
    for (const q of near) {
      for (const k of BUILDINGS) {
        const at2 = q[BUILDING_AT[k]];
        if (q[k] && Array.isArray(at2) && at2.length === 2) out.push(at2);
      }
    }
    return out;
  };
  return g;
}

const outlinedIcons = new Map();

// Icon with a baked white outline traced round its silhouette.
function outlinedIcon(icon, h, outline) {
  let per = outlinedIcons.get(icon);
  if (!per) { per = new Map(); outlinedIcons.set(icon, per); }
  const key = `${h}|${outline}`;
  const had = per.get(key);
  if (had) return had;

  const ss = 2;
  const iw = icon.width * ss, ih = icon.height * ss;
  const r = outline * ih / h;                  // the edge, in baked pixels
  const pad = Math.ceil(r) + 1;

  const sil = document.createElement('canvas');
  sil.width = iw; sil.height = ih;
  const sx = sil.getContext('2d');
  sx.drawImage(icon, 0, 0, icon.width, icon.height, 0, 0, iw, ih);
  sx.globalCompositeOperation = 'source-in';   // keep the alpha, replace the colour
  sx.fillStyle = '#fff';
  sx.fillRect(0, 0, iw, ih);

  const canvas = document.createElement('canvas');
  canvas.width = iw + pad * 2; canvas.height = ih + pad * 2;
  const x = canvas.getContext('2d');
  const rr = r * r;
  for (let dy = -pad; dy <= pad; dy++) {
    for (let dx = -pad; dx <= pad; dx++) {
      if (dx * dx + dy * dy > rr) continue;
      x.drawImage(sil, pad + dx, pad + dy);
    }
  }
  x.drawImage(icon, 0, 0, icon.width, icon.height, pad, pad, iw, ih);

  const baked = { canvas, w: (iw + pad * 2) * h / ih, h: (ih + pad * 2) * h / ih };
  per.set(key, baked);
  return baked;
}

// Building kinds with a map mark, and their per-kind settings.
const MARKS = {
  eyrie: { label: 'Eyrie', icon: 'Eyrie.png' },
  dockyard: { label: 'Naval dockyard', icon: 'Dockyard.png' },
  syntheticOil: { label: 'Synthetic oil plant', icon: 'Synthetic-plant_oil.png', needs: 'coal' },
  syntheticRubber: { label: 'Synthetic rubber plant', icon: 'Synthetic-plant_rubber.png', needs: 'oil' },
};
// Fills each row's defaults from the shared figures.
for (const mark of Object.values(MARKS)) {
  mark.fade ??= F_BUILDING;
  mark.px ??= BUILDING_ICON_PX;
  mark.outline ??= BUILDING_OUTLINE_PX;
}
const MARK_KINDS = Object.keys(MARKS);
if (MARK_KINDS.join() !== BUILDINGS.join()) {
  console.warn(`MARKS (${MARK_KINDS.join(', ')}) and BUILDINGS in provincestats.js (${BUILDINGS.join(', ')}) disagree`);
}

// Scratch lists per kind for the labeller and the drawer.
const markScratch = Object.fromEntries(MARK_KINDS.map((k) => [k, { labels: [], drawing: [] }]));

// Every mark of one kind on this copy of the map, in the copy's space.
function buildingMarks(kind, cssW, cssH, dx, out) {
  out.length = 0;
  const spec = MARKS[kind];
  const w = state.world, s = view.scale;
  if (!w?.counties?.atIndex) return out;
  const icon = w.buildingIcons?.[kind] || w.buildingIcons?.plain;
  if (!icon) return out;
  if (cityFade(spec.fade) <= 0.004) return out;   // faded out reserves nothing

  const h = spec.px;
  const iw = Math.round(h * (icon.width / icon.height));
  const mark = outlinedIcon(icon, h, spec.outline);

  for (const c of w.counties?.atIndex || []) {
    if (!c || !c[kind]) continue;

    const at = markAt(w, c.id, kind, c);
    const x = at.ax * s + view.x;
    if (x + dx < -80 || x + dx > cssW + 80) continue;
    const y = at.ay * s + view.y;
    if (y + h < 0 || y - h > cssH) continue;

    out.push({ x, y, w: iw, h, mark, id: c.id, province: c.province });
  }
  return out;
}

// Adds or removes a building on a county from the console.
function setBuilding(countyId, kind, on) {
  const w = state.world;
  const c = w?.counties?.byId?.get(countyId);
  if (!c) throw new Error(`no county "${countyId}"`);
  if (!BUILDINGS.includes(kind)) {
    throw new Error(`no building "${kind}"; try ${BUILDINGS.map((k) => `"${k}"`).join(' or ')}`);
  }

  const needs = on ? MARKS[kind].needs : null;
  if (needs && !(w.resources?.[c.province]?.[needs] > 0)) {
    throw new Error(`"${c.province}" holds no ${needs}, so "${countyId}" cannot hold a `
      + MARKS[kind].label.toLowerCase());
  }

  const key = BUILDING_AT[kind];
  if (!on) {
    delete c[kind];
    delete c[key];
    worldChanged();
    return { county: countyId, province: c.province, kind, built: false, at: null };
  }

  const had = Array.isArray(c[key]) && c[key].length === 2;
  c[kind] = true;
  if (!had) delete c[key];
  const at = markAt(w, countyId, kind, c);

  if (at.coastless || at.lost) {
    delete c[kind];
    delete c[key];
    throw new Error(at.lost
      ? `"${countyId}" is not on the map`
      : `"${countyId}" has no coast, so it cannot hold a dockyard`);
  }

  worldChanged();
  return { county: countyId, province: c.province, kind, built: true, at: [at.ax, at.ay] };
}

function drawBuildingMarks(ctx, cssW, cssH, dx) {
  let drawn = 0;
  for (const kind of MARK_KINDS) {
    const spec = MARKS[kind];
    const marks = buildingMarks(kind, cssW, cssH, dx, markScratch[kind].drawing);
    if (!marks.length) continue;

    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * cityFade(spec.fade);
    for (const m of marks) {
      ctx.drawImage(m.mark.canvas, m.x - m.mark.w / 2, m.y - m.mark.h / 2, m.mark.w, m.mark.h);
      markHits.push({
        x0: m.x + dx - m.w / 2, x1: m.x + dx + m.w / 2,
        y0: m.y - m.h / 2, y1: m.y + m.h / 2, id: m.id, province: m.province, kind,
      });
      drawn++;
    }
    ctx.globalAlpha = prev;
  }
  debug.eyries = drawn;
}

export { markHits, MARK_RING, MARK_OFF_EDGE, DOCKYARD_RING, DOCKYARD_RADII, DOCKYARD_OFF_CITY, DOCKYARD_OFF_FRONTIER, DOCKYARD_PORT_PX, DOCKYARD_OFF_WATER, DOCKYARD_NEAR_COAST, DOCKYARD_SHORE_REACH, MARK_MIN_GAP, otherMarksIn, clearOfMarks, markHash, markAnchors, markAnchorWorld, markAnchor, markAt, navigableLakeSet, navigableLakeWorld, navigableLakes, countyGround, outlinedIcons, outlinedIcon, MARKS, MARK_KINDS, markScratch, buildingMarks, setBuilding, drawBuildingMarks };
