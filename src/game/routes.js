// Trade routes: ports and the sea legs between them, land steps between counties, the cheapest path a cargo takes hub to hub, and the feeders drawn to each hub.

const VERSION = new URL(import.meta.url).search;
const { UNOWNED } = await import(`../world/mapdata.js${VERSION}`);
const { distanceKm, mapColAt, mapLatAt, mapLonAt, mapRowAt } = await import(`../world/geo.js${VERSION}`);
const { finish, forgetOnChange } = await import(`../core/core.js${VERSION}`);
const { hashWords } = await import(`../world/mapcache.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let IMPASSABLE, STOP_POINTS, builtLevel, railShare, relationsBetween;
export function link(all) { ({ IMPASSABLE, STOP_POINTS, builtLevel, railShare, relationsBetween } = all); }

// Points a km costs by each mode.
const MODE_POINTS = { sea: 1, rail: 3, road: 8 };
// Points a km costs by sea in a region tagged Arctic.
const ARCTIC_RESISTANCE = 2.5;
const ARCTIC = 'Arctic';
// Port province population at which a call costs the plain stop; smaller ports cost more, up to PORT_MAX times.
const PORT_REF = 1000000;
const PORT_MAX = 4;
// Spirit tag making every port of its holder an entrepot, where a call costs ENTREPOT_FACTOR of the plain stop.
const ENTREPOT = 'entrepot';
const ENTREPOT_FACTOR = 0.5;
// Km of unbroken land passage at which its cost doubles.
const STEP_KM = 4000;
// Km a ship sails on one load of coal: a sea leg costs its worked km up to it, and more beyond, double at twice it.
const PASSAGE_KM = 10000;
// Most a step between subregions is cheapened for being on a busy lane: the busiest by this share, others by it times the square root of their use against the busiest.
const LANE_PULL = 0.3;
// Most a lane may lengthen the way between two ports, as a share of the direct way.
const LANE_DETOUR = 0.1;
// Points over the cheapest at which another port of call takes 1/e as much cargo; ports dearer by SPREAD_REACH times it take none.
const ROUTE_SPREAD = 100;
const SPREAD_REACH = 3;
// Most ports sharing one stop.
const SPREAD_PORTS = 4;
// Moving cargo between ship and land partway, in port calls at that port.
const HANDLING = 1;
// Moving cargo between road and rail, in plain port calls.
const RAIL_HANDLING = 0.5;
// Cost multiplier of a land step by the ground of the two counties it joins, the harder of landform and climate; a railed step runs at 1.
const TERRAIN_COST = { Plains: 1, Urban: 1, Hills: 1.5, Mountains: 3, Alpine: 4 };
const CLIMATE_COST = { Desert: 2, Rainforest: 2, Tundra: 1.5, 'Ice cap': 3 };
// Cost multiplier on land steps into, and port calls at, a warzone county.
const WARZONE_RESISTANCE = 3;
// A country viewing either party at this or below refuses passage.
const EMBARGO = -100;
// Trees kept before the cache is cleared.
const TREES_HELD = 600;
// Trees built so far, read by work that pauses after each.
let treesMade = 0;
const treesBuilt = () => treesMade;
// Points added to each sea hop of a feeder, so it goes by sea only where its land does not join.
const FEEDER_SEA_HOP = 1e7;

const RAD = Math.PI / 180;
const kmBetween = (a, b) => distanceKm({ lat: a[0] * RAD, lon: a[1] * RAD }, { lat: b[0] * RAD, lon: b[1] * RAD });

// Points to cover km by a mode in one passage.
const passage = (km, mode) => km * MODE_POINTS[mode] * (1 + km / STEP_KM);
// Points to sail km in one passage, of which worked is the km each counted at its region's mode.
const sailing = (km, worked = km) => worked * (1 + Math.max(0, km - PASSAGE_KM) / PASSAGE_KM);
// A whole sea leg with its call, untaxed.
const seaLeg = (km, worked = km, factor = 1) => sailing(km, worked) + STOP_POINTS * factor;
// Highest level road and electricity are built to.
const LEVEL_MAX = 10;
// A port's development: road and electricity built against LEVEL_MAX, and its share of railed counties, 0 to 1.
const portDevelopment = (w, p, st) => 0.4 * builtLevel(st, 'road') / LEVEL_MAX + 0.3 * builtLevel(st, 'electricity') / LEVEL_MAX + 0.3 * railShare(w, p);
// Development at which a port counts its population as it is.
const PORT_DEVELOPMENT = 0.5;
// How much dearer a call is at a port of this population and development.
const portFactor = (people, development = PORT_DEVELOPMENT) => Math.min(PORT_MAX, Math.max(1, Math.sqrt(PORT_REF / Math.max(1, (people || 0) * development / PORT_DEVELOPMENT))));

// A binary min-heap of node indices by cost; stale entries are left for the caller to skip.
// Whether a way of cost n through u beats the one of cost d through p: cheaper, or as cheap and through the lower-numbered county, so every search breaks ties alike.
const TIE = 1e-9;
const better = (n, d, u, p) => n < d * (1 - TIE) || (n <= d * (1 + TIE) && (p < 0 || u < p));

class Heap {
  constructor(cap = 1024) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; this.top = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const out = this.v[0];
    this.top = this.k[0];
    const key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return out;
  }
}

// The sea graph, fixed per world: ports, sea distances between them, and the legs no intermediate port beats.
// Built again when the dockyards change.
const seaBy = new WeakMap();
let seaStale = true;
forgetOnChange(() => { seaStale = true; });
function seaGraph(w) {
  let g = seaBy.get(w);
  if (g && !seaStale) return g;
  seaStale = false;
  const sig = dockyardSig(w) + '#' + [...entrepotProvinces(w)].sort().join();
  if (!g || g.sig !== sig) { g = buildSeaGraph(w); g.sig = sig; g.factorSig = Array.from(g.factor, (x) => x.toFixed(3)).join(); seaBy.set(w, g); return g; }
  // Calls priced again by each port's population and development.
  g.factor = portFactors(w, g.ports, entrepotProvinces(w));
  g.edgeCall = Float64Array.from(g.edgeTo, (j) => STOP_POINTS * g.factor[j]);
  g.factorSig = Array.from(g.factor, (x) => x.toFixed(3)).join();
  return g;
}

// Each port's call factor: ENTREPOT_FACTOR at an entrepot holder's port, else by its population and development.
function portFactors(w, ports, major) {
  return Float64Array.from(ports, (p) => {
    const q = w.atIndex[p], st = w.stats?.[q.id] || {};
    return major.has(q.id) ? ENTREPOT_FACTOR : portFactor(st.population, portDevelopment(w, q, st));
  });
}

// Provinces holding a naval dockyard, as a key.
function dockyardSig(w) {
  const out = new Set();
  for (const c of w.counties?.byId?.values() || []) if (c.dockyard) out.add(c.province);
  return [...out].sort().join();
}

// Provinces of countries holding a spirit tagged entrepot.
function entrepotProvinces(w) {
  const tagged = new Set((w.government?.spirits?.spirits || []).filter((x) => (x.tags || []).includes(ENTREPOT)).map((x) => x.id || x.name));
  const held = new Set();
  for (const [id, gov] of w.government?.byPolity || []) if ((gov.spirits || []).some((x) => tagged.has(x))) held.add(id);
  const out = new Set();
  for (let p = 1; p < w.atIndex.length; p++) if (held.has(w.atIndex[p].owner)) out.add(w.atIndex[p].id);
  return out;
}

// A map position as [lat, lon] in degrees.
const pointAt = (w, x, y) => [mapLatAt(y + 0.5) / RAD, mapLonAt(x + 0.5, w.width) / RAD];

function buildSeaGraph(w) {
  const t0 = performance.now();
  const subs = w.subs, sea = w.sea;
  const NP = w.atIndex.length;
  const portAt = new Int32Array(NP).fill(-1);
  const none = { ports: [], portAt, quay: [], quayAt: [], coastAt: new Map(), touch: new Map(), quayCounty: new Int32Array(0), factor: new Float64Array(0), edgeOff: new Int32Array(1), edgeTo: new Int32Array(0), edgeKm: new Float32Array(0), edgeWorked: new Float32Array(0), edgeAt: new Int32Array(0), edgeCall: new Float64Array(0), edgeSail: new Float64Array(0), ms: 0 };
  if (!subs?.subAt || !sea || !w.provinceAt || !w.counties?.countyAt) return none;

  // Navigable subregions: not on a lake and not impassable.
  const NS = subs.atIndex.length;
  const open = new Uint8Array(NS), regionOf = new Int16Array(NS), mode = new Float32Array(NS).fill(MODE_POINTS.sea);
  for (let s = 1; s < NS; s++) {
    const r = sea.byId.get(subs.atIndex[s].region);
    regionOf[s] = r ? r.index : 0;
    open[s] = r && !r.lake && !(r.tags || []).includes(IMPASSABLE) ? 1 : 0;
    if ((r?.tags || []).includes(ARCTIC)) mode[s] = ARCTIC_RESISTANCE;
  }

  // Subregions each coastal county touches, with the shore pixels facing each, read at the shared edge of the county and sea bitmaps.
  const W = w.width, H = w.height, sa = subs.subAt, cs = w.counties, ca = cs.countyAt;
  const shore = new Map();
  const note = (k, s, at) => {
    if (!open[s]) return;
    let t = shore.get(k);
    if (!t) shore.set(k, (t = new Map()));
    if (!t.has(s)) t.set(s, []);
    t.get(s).push(at);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, a = ca[i];
      const r = x + 1 < W ? i + 1 : y * W, b = ca[r];
      if (a && !b && sa[r]) note(a, sa[r], i); else if (!a && b && sa[i]) note(b, sa[i], r);
      if (y + 1 < H) {
        const d = i + W, c = ca[d];
        if (a && !c && sa[d]) note(a, sa[d], i); else if (!a && c && sa[i]) note(c, sa[i], d);
      }
    }
  }
  // The same by province.
  const provOf = (k) => w.byId.get(cs.atIndex[k]?.province)?.index ?? 0;
  const touch = new Map();
  for (const [k, t] of shore) {
    const p = provOf(k);
    if (!p) continue;
    if (!touch.has(p)) touch.set(p, new Set());
    for (const s of t.keys()) touch.get(p).add(s);
  }

  const tScan = performance.now() - t0;
  // Where a province berths: the county of its capital on the coast, else of another city on the coast, else its coastal dockyard county, else the coastal county nearest an inland dockyard over the county graph.
  const berth = new Map();
  const offer = (p, k, at, rank) => { if (!berth.has(p) || rank < berth.get(p).rank) berth.set(p, { k, at, rank }); };
  const nearestCoast = (p, k0) => {
    const seen = new Set([k0]), queue = [k0];
    for (let n = 0; n < queue.length; n++) {
      const k = queue[n];
      if (shore.has(k)) return k;
      for (const id of cs.adjacency.get(cs.atIndex[k].id) || []) {
        const v = cs.byId.get(id)?.index;
        if (v && !seen.has(v) && provOf(v) === p) { seen.add(v); queue.push(v); }
      }
    }
    return 0;
  };
  const yards = new Map();
  for (const c of cs.byId.values()) if (c.dockyard) { const p = provOf(c.index); if (!yards.has(p)) yards.set(p, []); yards.get(p).push(c); }
  for (const t of w.cities || []) {
    const p = w.byId.get(t.province)?.index, k = ca[t.y * W + t.x];
    if (!p || !k || provOf(k) !== p) continue;
    // A coastal capital before any other coastal city.
    if (shore.has(k)) offer(p, k, [t.x, t.y], t.capital ? 0 : 0.5);
  }
  for (const [p, list] of yards) {
    for (const c of list) {
      if (shore.has(c.index)) offer(p, c.index, c.dockyardAt || null, 1);
      else { const k = nearestCoast(p, c.index); if (k) offer(p, k, c.dockyardAt || null, 2); }
    }
  }
  // The shore pixel of a county facing a subregion nearest a point, as [lat, lon].
  // Whether a water pixel belongs to water larger than a pocket: a few pixels touching the sea only at a corner do not count.
  const opened = new Int8Array(W * H).fill(-1), stamp = new Int32Array(W * H);
  let pass = 0;
  const openWater = (j) => {
    if (opened[j] >= 0) return opened[j] === 1;
    const seen = [j];
    stamp[j] = ++pass;
    let reached = false;
    for (let n = 0; n < seen.length && seen.length < POCKET_PX && !reached; n++) {
      const i = seen[n], x = i % W, y = (i - x) / W;
      for (const m of [y * W + (x + 1) % W, y * W + (x + W - 1) % W, i - W, i + W]) {
        if (m < 0 || m >= W * H || stamp[m] === pass || ca[m] || !sa[m]) continue;
        if (opened[m] === 1) { reached = true; break; }
        stamp[m] = pass;
        seen.push(m);
      }
    }
    const big = reached || seen.length >= POCKET_PX ? 1 : 0;
    for (const i of seen) if (opened[i] < 0) opened[i] = big;
    return big === 1;
  };
  // Whether a shore pixel faces open water of a subregion.
  const facesOpen = (i, s) => {
    const x = i % W, y = (i - x) / W;
    return [y * W + (x + 1) % W, y * W + (x + W - 1) % W, i - W, i + W].some((m) => m >= 0 && m < W * H && !ca[m] && sa[m] === s && openWater(m));
  };
  const facing = (k, s, at) => {
    const all = shore.get(k).get(s);
    const fair = all.filter((i) => facesOpen(i, s));
    const px = fair.length ? fair : all;
    let best = px[px.length >> 1];
    if (at) {
      let near = Infinity;
      for (const i of px) { const d = (i % W - at[0]) ** 2 + (Math.floor(i / W) - at[1]) ** 2; if (d < near) { near = d; best = i; } }
    }
    return pointAt(w, best % W, Math.floor(best / W));
  };
  // Ports: provinces with a city or a naval dockyard and a coastal county to berth in, the water that county opens onto, and what a call there costs.
  const ports = [...berth.keys()].sort((a, b) => a - b);
  const P = ports.length;
  ports.forEach((p, i) => { portAt[p] = i; });
  const quayCounty = Int32Array.from(ports, (p) => berth.get(p).k);
  const waters = ports.map((p) => [...shore.get(berth.get(p).k).keys()]);
  // Where a port's cargo comes ashore: its quay county's shore nearest the city or dockyard, facing each water it opens onto.
  const quayAt = ports.map((p, i) => new Map(waters[i].map((s) => [s, facing(quayCounty[i], s, berth.get(p).at)])));
  const quay = ports.map((p, i) => {
    const at = berth.get(p).at;
    if (!at) return quayAt[i].values().next().value;
    let best = null, near = Infinity;
    for (const pt of quayAt[i].values()) { const d = kmBetween(pt, pointAt(w, at[0], at[1])); if (d < near) { near = d; best = pt; } }
    return best;
  });
  const major = entrepotProvinces(w);
  const factor = portFactors(w, ports, major);
  const subPorts = Array.from({ length: NS }, () => []);
  const seeds = ports.map((p, i) => waters[i].map((s) => {
    subPorts[s].push(i);
    const k = kmBetween(quayAt[i].get(s), subs.atIndex[s].centre);
    return [s, k, k * mode[s]];
  }));

  // Subregion adjacency between navigable water, with the km between centres.
  const subOff = new Int32Array(NS + 1), subTo = [], subKm = [], subWorked = [];
  for (let s = 1; s < NS; s++) {
    subOff[s] = subTo.length;
    if (open[s]) {
      const me = subs.atIndex[s];
      for (const id of subs.adjacency.get(me.id) || []) {
        const t = subs.byId.get(id)?.index;
        if (!t || !open[t]) continue;
        // Half the step in each subregion, at its mode.
        const k = kmBetween(me.centre, subs.atIndex[t].centre);
        subTo.push(t); subKm.push(k); subWorked.push(k * (mode[s] + mode[t]) / 2);
      }
    }
    subOff[s + 1] = subTo.length;
  }

  // Sea km from every port to every other on the least worked km, and the path each takes; worked over the given weight of each step between subregions.
  const dist = new Float64Array(NS), distKm = new Float64Array(NS);
  const parent = new Int16Array(P * NS);
  const km = new Float32Array(P * P).fill(Infinity), worked = new Float32Array(P * P).fill(Infinity);
  const endSub = new Int16Array(P * P);
  const heap = new Heap(NS * 4);
  const allPorts = (weight) => {
    for (let i = 0; i < P; i++) {
      dist.fill(Infinity);
      const base = i * NS;
      parent.fill(-1, base, base + NS);
      heap.n = 0;
      for (const [s, k, c] of seeds[i]) if (c < dist[s]) { dist[s] = c; distKm[s] = k; parent[base + s] = 0; heap.push(c, s); }
      while (heap.n) {
        const s = heap.pop();
        const d = heap.top;
        if (d > dist[s]) continue;
        for (let e = subOff[s]; e < subOff[s + 1]; e++) {
          const t = subTo[e], n = d + weight[e];
          if (n < dist[t]) { dist[t] = n; distKm[t] = distKm[s] + subKm[e]; parent[base + t] = s; heap.push(n, t); }
        }
      }
      for (let j = 0; j < P; j++) {
        if (j === i) continue;
        let best = Infinity, at = 0, length = Infinity;
        for (const [s, k, c] of seeds[j]) {
          const n = dist[s] + c;
          if (n < best) { best = n; at = s; length = distKm[s] + k; }
        }
        km[i * P + j] = length;
        worked[i * P + j] = best;
        endSub[i * P + j] = at;
      }
    }
  };
  allPorts(subWorked);
  // The direct ways, kept for pairs the lanes would take too far round.
  const direct = { km: km.slice(), worked: worked.slice(), endSub: endSub.slice(), parent: parent.slice() };
  const straight = new Uint8Array(P * P);
  // Lanes: how many of those ways cross each step between subregions, either way; the busier a step, the cheaper it is worked, by up to LANE_PULL, and the ways are found again.
  const used = new Map();
  for (let i = 0; i < P; i++) {
    const base = i * NS;
    for (let j = 0; j < P; j++) {
      if (j === i || km[i * P + j] === Infinity) continue;
      for (let t = endSub[i * P + j], s = parent[base + t]; s > 0; t = s, s = parent[base + t]) {
        const key = s < t ? s * NS + t : t * NS + s;
        used.set(key, (used.get(key) || 0) + 1);
      }
    }
  }
  let busiest = 0;
  for (const n of used.values()) busiest = Math.max(busiest, n);
  const laned = Float64Array.from(subWorked);
  if (busiest) {
    for (let s = 1; s < NS; s++) {
      for (let e = subOff[s]; e < subOff[s + 1]; e++) {
        const t = subTo[e], n = used.get(s < t ? s * NS + t : t * NS + s) || 0;
        laned[e] = subWorked[e] * (1 - LANE_PULL * Math.sqrt(n / busiest));
      }
    }
    allPorts(laned);
    // A pair whose lane way is more than LANE_DETOUR longer than its direct one keeps the direct way.
    for (let x = 0; x < P * P; x++) {
      if (!(km[x] > direct.km[x] * (1 + LANE_DETOUR))) continue;
      km[x] = direct.km[x]; worked[x] = direct.worked[x]; endSub[x] = direct.endSub[x]; straight[x] = 1;
    }
  }
  // The parents a pair's way is read through.
  const parentFor = (i, j) => (straight[i * P + j] ? direct.parent : parent);

  const tSea = performance.now() - t0;
  // A leg is dropped where a port on its way splits it for less, even after a full stop and tariff there.
  // A leg too short to split: a call saves at most what it costs beyond PASSAGE_KM, against a stop at the cheapest port.
  const whole = (L, Wk) => Wk * Math.max(0, L - PASSAGE_KM) / PASSAGE_KM < STOP_POINTS * Math.min(1, ENTREPOT_FACTOR);
  const legAt = (a, b) => seaLeg(km[a * P + b], worked[a * P + b], factor[b]);
  const edgeOff = new Int32Array(P + 1), edgeTo = [], edgeKm = [], edgeWorked = [], edgeEnd = [];
  for (let i = 0; i < P; i++) {
    edgeOff[i] = edgeTo.length;
    const base = i * NS;
    for (let j = 0; j < P; j++) {
      const L = km[i * P + j];
      if (j === i || L === Infinity) continue;
      const direct = legAt(i, j);
      let beaten = false;
      const up = parentFor(i, j);
      for (let s = whole(L, worked[i * P + j]) ? 0 : endSub[i * P + j]; s > 0 && !beaten; s = up[base + s]) {
        for (const k of subPorts[s]) {
          if (k === i || k === j) continue;
          if (legAt(i, k) + legAt(k, j) + STOP_POINTS * factor[k] <= direct) { beaten = true; break; }
        }
      }
      if (beaten) continue;
      edgeTo.push(j); edgeKm.push(L); edgeWorked.push(worked[i * P + j]); edgeEnd.push(endSub[i * P + j]);
    }
    edgeOff[i + 1] = edgeTo.length;
  }

  return {
    subOff, subTo: Int32Array.from(subTo), subKm: Float32Array.from(subKm), subWorked: Float32Array.from(subWorked), mode,
    ports, portAt, quay, quayAt, quayCounty, factor, coast: Int32Array.from(touch.keys()), touch,
    coastAt: new Map([...shore].map(([k, t]) => [k, new Map([...t.keys()].map((x) => [x, facing(k, x, null)]))])), subPorts, parent, parentDirect: direct.parent, straight, NS, regionOf, km, worked, endSub, P,
    edgeOff, edgeTo: Int32Array.from(edgeTo), edgeKm: Float32Array.from(edgeKm), edgeWorked: Float32Array.from(edgeWorked), edgeEnd: Int16Array.from(edgeEnd),
    edgeAt: Int32Array.from(edgeTo, (j) => ports[j]), edgeCall: Float64Array.from(edgeTo, (j) => STOP_POINTS * factor[j]),
    edgeSail: Float64Array.from(edgeKm, (k, e) => sailing(k, edgeWorked[e])),
    ms: performance.now() - t0, parts: { scan: tScan, distances: tSea - tScan, legs: performance.now() - t0 - tSea },
  };
}

// The sea regions a sea leg crosses, by index.
// The parents a pair's sea way is read through: the direct ones for a pair the lanes would take too far round.
const pairParents = (g, i, j) => (g.straight?.[i * g.P + j] ? g.parentDirect : g.parent);

// Whether the sea way from one port to another crosses Arctic water.
function pairIced(g, i, j) {
  const up = pairParents(g, i, j);
  for (let s = g.endSub[i * g.P + j]; s > 0; s = up[i * g.NS + s]) if (g.mode[s] > MODE_POINTS.sea) return true;
  return false;
}

function seaLegRegions(g, e) {
  g.regionsOf ||= new Map();
  if (!g.regionsOf.has(e)) {
    const i = portOfEdge(g, e), up = pairParents(g, i, g.edgeTo[e]);
    const out = new Set();
    for (let s = g.edgeEnd[e]; s > 0; s = up[i * g.NS + s]) out.add(g.regionOf[s]);
    g.regionsOf.set(e, [...out]);
  }
  return g.regionsOf.get(e);
}

// The subregions a sea leg passes, first to last, as ids.
function seaLegSubs(w, g, e) {
  const i = portOfEdge(g, e), up = pairParents(g, i, g.edgeTo[e]);
  const out = [];
  for (let s = g.edgeEnd[e]; s > 0; s = up[i * g.NS + s]) out.push(w.subs.atIndex[s].id);
  return out.reverse();
}
// The port a sea edge leaves from.
function portOfEdge(g, e) {
  let lo = 0, hi = g.ports.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.edgeOff[mid] <= e) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// The land graph: county steps with their km and terrain, and where each province and port sits, fixed per world.
const stepsBy = new WeakMap();
function landSteps(w) {
  if (stepsBy.has(w)) return stepsBy.get(w);
  const cs = w.counties;
  const NC = cs.atIndex.length, NP = w.atIndex.length;
  const provOf = new Int32Array(NC), weight = new Float64Array(NC).fill(1), size = new Float64Array(NP);
  const seat = new Int32Array(NP).fill(-1);
  for (let c = 1; c < NC; c++) {
    const q = cs.atIndex[c];
    if (!q) continue;
    const p = w.byId.get(q.province)?.index ?? 0;
    provOf[c] = p;
    weight[c] = terrainCost(q);
    // A province's seat: its capital's county, else a city's, else its largest.
    if ((q.area || 0) > size[p]) { size[p] = q.area || 0; seat[p] = c; }
  }
  const named = new Uint8Array(NP);
  for (const t of w.cities || []) {
    const c = cs.countyAt[t.y * cs.width + t.x], p = w.byId.get(t.province)?.index;
    const rank = t.capital ? 2 : 1;
    if (c && p && provOf[c] === p && rank > named[p]) { seat[p] = c; named[p] = rank; }
  }
  // Counties a railway joins, both ways, whether or not they count as adjacent.
  const railed = new Map();
  const tie = (x, y) => { if (!railed.has(x)) railed.set(x, new Set()); railed.get(x).add(y); };
  for (const q of cs.byId.values()) if (Array.isArray(q.rail)) for (const id of q.rail) if (cs.byId.has(id)) { tie(q.id, id); tie(id, q.id); }
  const off = new Int32Array(NC + 1), to = [], km = [];
  for (let c = 1; c < NC; c++) {
    off[c] = to.length;
    const q = cs.atIndex[c];
    for (const id of q ? new Set([...(cs.adjacency.get(q.id) || []), ...(railed.get(q.id) || [])]) : []) {
      const r = cs.byId.get(id);
      if (r) { to.push(r.index); km.push(kmBetween(q.centre, r.centre)); }
    }
    off[c + 1] = to.length;
  }
  const out = { NC, off, to: Int32Array.from(to), km: Float32Array.from(km), provOf, weight, seat };
  stepsBy.set(w, out);
  return out;
}

// Cost multiplier of a county's ground: its landform, or its climate where that is harder.
function terrainCost(c) {
  const land = (Array.isArray(c.terrain) ? c.terrain : [c.terrain]).reduce((a, t) => Math.max(a, TERRAIN_COST[t] ?? 1), 1);
  return Math.max(land, CLIMATE_COST[c.climate] ?? 1);
}

// Who holds each county, which steps are railed and where the fronts are, read again after any change or war; trees are kept while all stand.
let landHeld = null, landStale = true;
forgetOnChange(() => { landStale = true; });

// Every country's wars, as a key; read again when a list of wars is replaced or changes length.
let warsHeld = null;
forgetOnChange(() => { warsHeld = null; });
function warsSig(w) {
  const pv = w.polityValues || {};
  if (warsHeld?.pv === pv) {
    let n = 0, same = true;
    for (const id in pv) {
      const a = pv[id]?.atWar;
      if (!a?.length) continue;
      if (warsHeld.lists[n] !== a || warsHeld.sizes[n] !== a.length) { same = false; break; }
      n++;
    }
    if (same && n === warsHeld.lists.length) return warsHeld.sig;
  }
  const at = Object.entries(pv).filter(([, v]) => v?.atWar?.length);
  warsHeld = { pv, lists: at.map(([, v]) => v.atWar), sizes: at.map(([, v]) => v.atWar.length), sig: at.map(([id, v]) => id + ':' + v.atWar.join('.')).join() };
  return warsHeld.sig;
}

function landGraph(w) {
  const wars = warsSig(w);
  if (landHeld?.w === w && !landStale && landHeld.wars === wars) return landHeld;
  landStale = false;
  const sea = seaGraph(w);
  const steps = landSteps(w);
  const cs = w.counties;
  const { NC, off, to, provOf } = steps;
  const polities = [...(w.table?.polityById?.keys() || [])];
  const countryAt = new Map(polities.map((id, i) => [id, i]));
  const ctrl = new Int32Array(NC).fill(-1);
  for (let c = 1; c < NC; c++) {
    const q = w.atIndex[provOf[c]], k = cs.atIndex[c];
    const who = k?.occupier || q?.occupier || q?.owner;
    if (who && who !== UNOWNED && countryAt.has(who)) ctrl[c] = countryAt.get(who);
  }
  // Warzones: occupied counties, and counties bordering one held by a country at war with their holder.
  const enemies = (a, b) => (w.polityValues?.[a]?.atWar || []).includes(b) || (w.polityValues?.[b]?.atWar || []).includes(a);
  const warAt = new Float64Array(NC).fill(1);
  for (let c = 1; c < NC; c++) {
    const q = w.atIndex[provOf[c]];
    let front = ctrl[c] >= 0 && q?.owner && polities[ctrl[c]] !== q.owner;
    for (let e = off[c]; e < off[c + 1] && !front; e++) {
      const a = ctrl[c], b = ctrl[to[e]];
      front = a >= 0 && b >= 0 && a !== b && enemies(polities[a], polities[b]);
    }
    if (front) warAt[c] = WARZONE_RESISTANCE;
  }
  const rails = [];
  for (const c of cs.byId.values()) if (Array.isArray(c.rail) && c.rail.length) rails.push(c.id + ':' + c.rail.join('.'));
  // Everything but the price of calls, which feeders do not read.
  const shape = ctrl.join() + '#' + rails.join() + '#' + polities.length + '#' + sea.sig + '#' + warAt.join();
  const sig = shape + '#' + sea.factorSig;
  if (landHeld?.w === w && landHeld.sig === sig) { landHeld.wars = wars; landHeld.sea = sea; return landHeld; }
  // A step is railed where a line runs between the two counties; rail runs at its own rate whatever the ground.
  const rail = new Uint8Array(to.length), cost = new Float64Array(to.length);
  for (let c = 1; c < NC; c++) {
    const lines = cs.atIndex[c]?.rail;
    for (let e = off[c]; e < off[c + 1]; e++) {
      const v = to[e];
      rail[e] = Array.isArray(lines) && lines.includes(cs.atIndex[v].id) || (Array.isArray(cs.atIndex[v].rail) && cs.atIndex[v].rail.includes(cs.atIndex[c].id)) ? 1 : 0;
      const ground = rail[e] ? 1 : (steps.weight[c] + steps.weight[v]) / 2;
      cost[e] = passage(steps.km[e], rail[e] ? 'rail' : 'road') * ground * warAt[v];
    }
  }
  // The county each port berths in, and each port's index by county.
  const portAt = new Int32Array(NC).fill(-1);
  sea.quayCounty.forEach((c, i) => { if (c > 0) portAt[c] = i; });
  landHeld = { w, sig, shape, wars, sea, ...steps, rail, cost, ctrl, warAt, portAt, polities, countryAt, trees: new Map() };
  return landHeld;
}

// A country's capital county, held by it, else its largest county held.
function capitalOf(w, land, id) {
  land.capitals ||= new Map();
  if (!land.capitals.has(id)) land.capitals.set(id, capitalCounty(w, land, id));
  return land.capitals.get(id);
}
function capitalCounty(w, land, id) {
  const c = land.countryAt.get(id);
  const cs = w.counties;
  let at = -1;
  for (const t of w.cities || []) {
    if (!t.capital || w.byId.get(t.province)?.owner !== id) continue;
    const k = cs.countyAt[t.y * cs.width + t.x];
    if (k && land.ctrl[k] === c) { at = k; break; }
  }
  if (at < 0) {
    let most = -1;
    for (let k = 1; k < land.NC; k++) {
      if (land.ctrl[k] === c && (cs.atIndex[k].area || 0) > most) { most = cs.atIndex[k].area || 0; at = k; }
    }
  }
  return at;
}

// The county a province's cargo gathers at, held by its owner: its quay where it is a port, else its capital's or a city's county, else its largest county; -1 if none is held.
function seatCounty(w, land, p, sea = seaGraph(w)) {
  const c = land.countryAt.get(p.owner), cs = w.counties;
  const i = sea.portAt[p.index];
  if (i >= 0 && land.ctrl[sea.quayCounty[i]] === c) return sea.quayCounty[i];
  let at = -1, best = -1;
  for (const t of w.cities || []) {
    if (t.province !== p.id) continue;
    const k = cs.countyAt[t.y * cs.width + t.x];
    if (k && land.ctrl[k] === c && (t.capital ? 1 : 0) > best) { best = t.capital ? 1 : 0; at = k; }
  }
  if (at >= 0) return at;
  for (let k = 1; k < land.NC; k++) {
    if (land.provOf[k] === p.index && land.ctrl[k] === c && (cs.atIndex[k].area || 0) > best) { best = cs.atIndex[k].area || 0; at = k; }
  }
  return at;
}

// Distance from the capital at which a hub candidate counts half.
const HUB_REACH_KM = 1000;
// How well a province serves as a hub: development by level times people per km², halved at HUB_REACH_KM from the capital.
function hubScore(w, p, capital) {
  const st = w.stats?.[p.id] || {};
  const km = capital ? kmBetween(p.centre, capital.centre) : 0;
  return portDevelopment(w, p, st) * (st.population || 0) / Math.max(1, p.area || 0) / (1 + (km / HUB_REACH_KM) ** 2);
}
// A country's capital province.
const capitalProvince = (w, id) => { const t = (w.cities || []).find((c) => c.capital && w.byId.get(c.province)?.owner === id); return t ? w.byId.get(t.province) : null; };

// The county a country's cargo starts and ends at: its province with a city held by it scoring highest by hubScore; else any province; else its capital.
function hubCounty(w, land, id) {
  land.ends ||= new Map();
  if (!land.ends.has(id)) land.ends.set(id, hubFor(w, land, id, capitalOf));
  return land.ends.get(id);
}
// The same worked out, the capital and sea graph read from those given.
function hubFor(w, land, id, capitalAt, sea) {
  const withCity = new Set((w.cities || []).map((t) => t.province));
  const capital = capitalProvince(w, id);
  let at = -1, most = [-1, -1];
  for (const p of w.atIndex) {
    if (p?.owner !== id) continue;
    const score = [withCity.has(p.id) ? 1 : 0, hubScore(w, p, capital)];
    const n = score.findIndex((x, j) => x !== most[j]);
    if (n < 0 || score[n] < most[n]) continue;
    const k = seatCounty(w, land, p, sea);
    if (k >= 0) { at = k; most = score; }
  }
  if (at < 0) at = capitalAt(w, land, id);
  return at;
}

// The province of a country's hub, by index.
function hubOf(w, land, id) {
  const k = hubCounty(w, land, id);
  return k < 0 ? -1 : land.provOf[k];
}

// Countries refusing passage to a party: at war with it, or viewing it at an embargo.
function hostileTo(w, land, id, memo) {
  if (memo?.has(id)) return memo.get(id);
  const out = new Set(w.polityValues?.[id]?.atWar || []);
  for (const c of land.polities) {
    if (c === id) continue;
    if ((w.polityValues?.[c]?.atWar || []).includes(id)) out.add(c);
    else if ((relationsBetween(c, id)?.value ?? 0) <= EMBARGO) out.add(c);
  }
  memo?.set(id, out);
  return out;
}

// Sea regions closed to a seller's cargo to a buyer, as a set of region indices; none until sea control is built.
function closedSeas(w, from, to) { return null; }

// Cheapest way from one county to every other, under the tariffs given and around the countries given; the costs are dropped once built.
function treeFrom(w, land, sea, start, rates, blocked, closed) { return finish(treeSteps(w, land, sea, start, rates, blocked, closed)); }

// Counties settled between pauses of a tree built in steps.
const TREE_SLICE = 2000;

// The same in steps, pausing between counties.
function* treeSteps(w, land, sea, start, rates, blocked, closed) {
  const NC = land.NC;
  let settled = 0;
  const dist = new Float64Array(NC).fill(Infinity);
  const parent = new Int32Array(NC).fill(-1);
  const via = new Int32Array(NC);
  const { off, to, cost, ctrl, warAt, portAt } = land;
  const { edgeOff, edgeTo, edgeSail, edgeCall, quayCounty } = sea;
  const heap = new Heap(NC * 2);
  dist[start] = 0;
  heap.push(0, start);
  while (heap.n) {
    const u = heap.pop();
    const d = heap.top;
    if (d > dist[u]) continue;
    if (++settled % TREE_SLICE === 0) yield;
    const cu = ctrl[u];
    // Unloading where it came by sea and goes on by land; loading where it came by land and goes on by sea.
    const unload = via[u] < 0 ? STOP_POINTS * HANDLING * sea.factor[portAt[u]] : 0;
    for (let e = off[u]; e < off[u + 1]; e++) {
      const v = to[e], cv = ctrl[v];
      if (cv >= 0 && blocked[cv]) continue;
      let n = d + cost[e] + unload;
      if (via[u] > 0 && land.rail[via[u] - 1] !== land.rail[e]) n += STOP_POINTS * RAIL_HANDLING;
      if (cv >= 0 && cv !== cu) n += STOP_POINTS * (1 + rates[cv]);
      if (better(n, dist[v], u, parent[v])) { dist[v] = n; parent[v] = u; via[v] = e + 1; heap.push(n, v); }
    }
    const i = portAt[u];
    if (i < 0) continue;
    const load = via[u] > 0 ? STOP_POINTS * HANDLING * sea.factor[i] : 0;
    for (let e = edgeOff[i], end = edgeOff[i + 1]; e < end; e++) {
      const v = quayCounty[edgeTo[e]], cv = ctrl[v];
      if (v <= 0 || cv < 0 || blocked[cv]) continue;
      const n = d + load + edgeSail[e] + edgeCall[e] * (1 + rates[cv]) * warAt[v];
      if (n >= dist[v]) continue;
      if (closed && seaLegRegions(sea, e).some((r) => closed.has(r))) continue;
      dist[v] = n; parent[v] = u; via[v] = -(e + 1); heap.push(n, v);
    }
  }
  return { parent, via, start, routes: new Map() };
}

// The legs from a tree's start to a county: land steps merged by mode until a border, through counties; sea legs port to port.
function legsTo(w, land, sea, t, target, rates) {
  const blocked = t.blocked;
  const steps = [];
  for (let v = target; v !== t.start; v = t.parent[v]) steps.push(v);
  steps.reverse();
  const cs = w.counties;
  const id = (c) => w.atIndex[land.provOf[c]].id;
  const country = (c) => (land.ctrl[c] >= 0 ? land.polities[land.ctrl[c]] : null);
  const legs = [];
  let u = t.start, open = null;
  for (const v of steps) {
    const e = t.via[v];
    const cu = land.ctrl[u], cv = land.ctrl[v];
    if (e < 0) {
      const k = sea.edgeKm[-e - 1];
      legs.push({ mode: 'sea', from: id(u), to: id(v), km: k, stop: country(v), rate: rates[cv], call: sea.factor[sea.edgeTo[-e - 1]] * land.warAt[v], points: sailing(k, sea.edgeWorked[-e - 1]), edge: -e - 1 });
      open = null;
    } else {
      const mode = land.rail[e - 1] ? 'rail' : 'road';
      const k = land.km[e - 1];
      if (!open || open.mode !== mode) {
        const last = legs[legs.length - 1];
        const switched = last && last.mode !== 'sea' && last.mode !== mode;
        open = { mode, from: id(u), to: id(v), km: 0, stop: null, rate: 0, call: 1, points: switched ? STOP_POINTS * RAIL_HANDLING : 0, through: [cs.atIndex[u].id] };
        legs.push(open);
      }
      open.to = id(v); open.km += k; open.points += land.cost[e - 1]; open.through.push(cs.atIndex[v].id);
      if (cv >= 0 && cv !== cu) { open.stop = country(v); open.rate = rates[cv]; open = null; }
    }
    u = v;
  }
  // Handling where cargo changes between land and sea partway.
  legs.forEach((l, n) => {
    if (l.mode !== 'sea') return;
    if (n > 0 && legs[n - 1].mode !== 'sea') l.points += STOP_POINTS * HANDLING * sea.factor[portOfEdge(sea, l.edge)];
    if (n < legs.length - 1 && legs[n + 1].mode !== 'sea') l.points += STOP_POINTS * HANDLING * sea.factor[sea.edgeTo[l.edge]];
  });
  // A sea leg names the regions it crosses; its edge is kept out of sight for drawing.
  for (const l of legs) {
    if (l.mode !== 'sea') continue;
    l.through = seaLegRegions(sea, l.edge).map((r) => w.sea.atIndex[r].id).reverse();
    Object.defineProperty(l, 'edge', { value: l.edge, enumerable: false });
  }
  spreadStops(land, sea, legs, rates, blocked);
  const stopped = legs.filter((l) => l.stop);
  const untaxed = legs.reduce((a, l) => a + l.points, 0) + STOP_POINTS * stopped.reduce((a, l) => a + l.call, 0);
  return {
    cost: untaxed + STOP_POINTS * stopped.reduce((a, l) => a + l.rate * l.call, 0), untaxed,
    stops: stopped.map((l) => l.stop), rates: stopped.map((l) => l.rate), calls: stopped.map((l) => l.call),
    shares: stopped.map((l) => l.shares || null),
    km: legs.reduce((a, l) => a + l.km, 0), legs,
  };
}

// A stop between two sea legs shared among the ports that would serve it for little more: each takes exp(-(its cost - the cheapest) / ROUTE_SPREAD), up to SPREAD_PORTS of them, as leg.shares [{ port, stop, rate, call, share }], the route's own port first.
function spreadStops(land, sea, legs, rates, blocked) {
  const P = sea.P;
  const leg = (i, j) => sailing(sea.km[i * P + j], sea.worked[i * P + j]);
  for (let n = 0; n + 1 < legs.length; n++) {
    if (legs[n].mode !== 'sea' || legs[n + 1].mode !== 'sea') continue;
    const a = portOfEdge(sea, legs[n].edge), x = sea.edgeTo[legs[n].edge], b = sea.edgeTo[legs[n + 1].edge];
    const options = [];
    for (let y = 0; y < P; y++) {
      if (y === a || y === b || !Number.isFinite(sea.km[a * P + y]) || !Number.isFinite(sea.km[y * P + b])) continue;
      const k = sea.quayCounty[y], c = land.ctrl[k];
      if (k <= 0 || c < 0 || blocked?.[c]) continue;
      const call = sea.factor[y] * land.warAt[k];
      options.push({ port: y, stop: land.polities[c], rate: rates[c], call, cost: leg(a, y) + STOP_POINTS * call * (1 + rates[c]) + leg(y, b) });
    }
    const least = Math.min(...options.map((o) => o.cost));
    const near = options.filter((o) => o.cost - least < ROUTE_SPREAD * SPREAD_REACH).sort((p, q) => p.cost - q.cost).slice(0, SPREAD_PORTS);
    if (!near.some((o) => o.port === x)) near.splice(SPREAD_PORTS - 1, 1, options.find((o) => o.port === x));
    if (near.length < 2) continue;
    const weight = near.map((o) => Math.exp(-(o.cost - least) / ROUTE_SPREAD));
    const total = weight.reduce((p, q) => p + q, 0);
    const shares = near.map((o, i) => ({ port: o.port, stop: o.stop, rate: o.rate, call: o.call, share: weight[i] / total }));
    shares.sort((p, q) => (p.port === x ? -1 : q.port === x ? 1 : 0));
    Object.defineProperty(legs[n], 'shares', { value: shares, enumerable: false });
  }
}

// Where cargo on a route also calls instead of its own ports: for each leg ending at a shared stop, the other ports with their share and the line through each, as { leg, share, stop, province, points: [into, out of] }.
function spreadLines(w, route) {
  const g = drawnGraphs(w).sea;
  const out = [];
  route.legs.forEach((l, n) => {
    if (!l.shares) return;
    const a = portOfEdge(g, l.edge), b = g.edgeTo[route.legs[n + 1].edge];
    for (const s of l.shares.slice(1)) out.push({ leg: n, share: s.share, stop: s.stop, province: w.atIndex[g.ports[s.port]].id, points: [seaPairLine(w, g, a, s.port), seaPairLine(w, g, s.port, b)] });
  });
  return out;
}

// The land graph, read once per memo: one market sees one set of wars.
const LAND_KEY = '#land';
// The cheapest open route for a seller's cargo to a buyer, hub to hub, or null; rates: the tariff each country charges on it, as [sig, Map].
function findRoute(w, from, to, rates, memo = null) { return finish(routeSteps(w, from, to, rates, memo)); }

// The same in steps, pausing while a tree is built.
function* routeSteps(w, from, to, rates, memo = null) {
  // The sea graph brought up to date a step before the land graph.
  if (!memo?.has(LAND_KEY)) { seaGraph(w); yield; }
  const land = memo?.get(LAND_KEY) || landGraph(w);
  memo?.set(LAND_KEY, land);
  const sea = seaGraph(w);
  const start = hubCounty(w, land, from), target = hubCounty(w, land, to);
  if (start < 0 || target < 0 || from === to) return null;
  if (start === target) return { cost: 0, untaxed: 0, stops: [], rates: [], calls: [], km: 0, legs: [] };
  if ((w.polityValues?.[from]?.atWar || []).includes(to) || (w.polityValues?.[to]?.atWar || []).includes(from)) return null;
  const hostFrom = hostileTo(w, land, from, memo), hostTo = hostileTo(w, land, to, memo);
  const closed = closedSeas(w, from, to);
  const [rateSig, rateMap] = rates;
  const ratesOf = () => {
    const r = new Float64Array(land.polities.length);
    for (const [c, n] of rateMap) if (c !== from && land.countryAt.has(c)) r[land.countryAt.get(c)] = n;
    return r;
  };
  // A tree around the seller's enemies first; around the buyer's too where its path crosses one of them.
  const attempt = function* (around) {
    const names = [...around].filter((c) => c !== from && c !== to && land.countryAt.has(c)).sort();
    const key = start + '|' + rateSig + '|' + names.join() + (closed ? '|' + [...closed].sort().join() : '');
    let t = land.trees.get(key);
    if (!t) {
      if (land.trees.size >= TREES_HELD) land.trees.clear();
      const blocked = new Uint8Array(land.polities.length);
      for (const c of names) blocked[land.countryAt.get(c)] = 1;
      t = yield* treeSteps(w, land, sea, start, ratesOf(), blocked, closed);
      treesMade++;
      t.rates = null;
      t.blocked = blocked;
      land.trees.set(key, t);
    }
    if (t.parent[target] < 0) return null;
    if (!t.routes.has(target)) t.routes.set(target, legsTo(w, land, sea, t, target, t.rates ||= ratesOf()));
    return t.routes.get(target);
  };
  const first = yield* attempt(hostFrom);
  if (!first) return null;
  const crossed = pathCountries(w, land, first).some((c) => c !== from && c !== to && hostTo.has(c));
  return crossed ? yield* attempt(new Set([...hostFrom, ...hostTo])) : first;
}

// Every country a route stops in or crosses, kept per route.
const passesBy = new WeakMap();
function pathCountries(w, land, route) {
  if (passesBy.has(route)) return passesBy.get(route);
  const out = new Set();
  for (const l of route.legs) {
    if (l.mode === 'sea') { out.add(l.stop); continue; }
    for (const id of l.through) { const k = w.counties.byId.get(id); if (k) { const c = land.ctrl[k.index]; if (c >= 0) out.add(land.polities[c]); } }
  }
  passesBy.set(route, [...out]);
  return passesBy.get(route);
}

// Up to BORDER_SAMPLES pixels spread along the border between each pair of touching areas of a bitmap, keyed low * N + high.
const BORDER_SAMPLES = 16;
// Rows of a bitmap read between pauses.
const BORDER_ROWS = 24;
const borderSamples = (w, at, N) => finish(borderSteps(w, at, N));
// The same in steps, pausing between rows.
function* borderSteps(w, at, N) {
  const W = w.width, H = w.height;
  const keyOf = (a, b) => (a < b ? a * N + b : b * N + a);
  function* each(fn) {
    for (let y = 0; y < H; y++) {
      if (y % BORDER_ROWS === 0) yield;
      for (let x = 0; x < W; x++) {
        const i = y * W + x, a = at[i];
        if (!a) continue;
        const r = x + 1 < W ? i + 1 : y * W;
        if (at[r] && at[r] !== a) fn(keyOf(a, at[r]), i);
        if (y + 1 < H && at[i + W] && at[i + W] !== a) fn(keyOf(a, at[i + W]), i);
      }
    }
  }
  const count = new Map();
  yield* each((k) => count.set(k, (count.get(k) || 0) + 1));
  const seen = new Map(), out = new Map();
  yield* each((k, i) => {
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    const stride = Math.max(1, Math.floor(count.get(k) / BORDER_SAMPLES));
    if (n % stride !== stride >> 1) return;
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    if (list.length < BORDER_SAMPLES) list.push(i);
  });
  return out;
}

// Border samples between subregions, and between counties, once per map.
const seaBordersBy = new WeakMap(), landBordersBy = new WeakMap();
function seaBorders(w) {
  if (!seaBordersBy.has(w.subs)) seaBordersBy.set(w.subs, { N: w.subs.atIndex.length, at: borderSamples(w, w.subs.subAt, w.subs.atIndex.length) });
  return seaBordersBy.get(w.subs);
}
function landBorders(w) {
  const cs = w.counties;
  if (!landBordersBy.has(cs)) landBordersBy.set(cs, { N: cs.atIndex.length, at: borderSamples(w, cs.countyAt, cs.atIndex.length), via: new Map() });
  return landBordersBy.get(cs);
}
// Both built in steps where not held yet.
function* borderPrep(w) {
  if (!seaBordersBy.has(w.subs)) { const at = yield* borderSteps(w, w.subs.subAt, w.subs.atIndex.length); seaBordersBy.set(w.subs, { N: w.subs.atIndex.length, at }); }
  const cs = w.counties;
  if (!landBordersBy.has(cs)) { const at = yield* borderSteps(w, cs.countyAt, cs.atIndex.length); landBordersBy.set(cs, { N: cs.atIndex.length, at, via: new Map() }); }
}

// A [lat, lon] point in map pixels.
const pixelOf = (w, p) => [mapColAt(p[1] * RAD, w.width), mapRowAt(p[0] * RAD)];
// The map pixel a [lat, lon] point stands on.
const pixelAt = (w, p) => pixelOf(w, p).map(Math.round);
// How many samples of a straight run lie on the wrong side of the coast: on land for a sea line, in water for a land line.
function offSide(w, a, b, sea) {
  const W = w.width, H = w.height, ca = w.counties.countyAt;
  let dx = b[0] - a[0];
  if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
  const n = Math.max(8, Math.ceil(Math.hypot(dx, b[1] - a[1]) / 3));
  let out = 0;
  for (let k = 1; k < n; k++) {
    const x = Math.round(a[0] + dx * k / n), y = Math.round(a[1] + (b[1] - a[1]) * k / n);
    if (y < 0 || y >= H) continue;
    if ((ca[y * W + ((x % W) + W) % W] > 0) === sea) out++;
  }
  return out;
}
// The sample nearest a straight run from a to b that keeps it most on its own side, in pixels.
function bestSample(w, list, a, b, sea) {
  let best = null, score = Infinity;
  for (const i of list) {
    const p = [i % w.width, Math.floor(i / w.width)];
    const n = (offSide(w, a, p, sea) + offSide(w, p, b, sea)) * 1e6 + Math.hypot(p[0] - a[0], p[1] - a[1]) + Math.hypot(b[0] - p[0], b[1] - p[1]);
    if (n < score) { score = n; best = p; }
  }
  return best;
}

// The pixels a run of subregions crosses at, from start to end, each on the border of two and kept off land where it can be, with the index in the run of the subregion it enters.
function gatesAlong(w, path, start, end) {
  const { N, at } = seaBorders(w);
  const lists = [];
  for (let n = 1; n < path.length; n++) {
    const a = path[n - 1], b = path[n];
    lists.push(at.get(a < b ? a * N + b : b * N + a) || []);
  }
  const mid = (list) => (list.length ? [list[list.length >> 1] % w.width, Math.floor(list[list.length >> 1] / w.width)] : null);
  const out = [];
  let prev = start;
  lists.forEach((list, n) => {
    if (!list.length) return;
    const next = (n + 1 < lists.length && mid(lists[n + 1])) || end;
    const p = bestSample(w, list, prev, next, true);
    out.push({ p, at: n + 1 });
    prev = p;
  });
  return out;
}

// Whether a straight run between two pixels stays on water, its two end pixels aside, read every half pixel and on both pixels where a reading falls between two.
function wetRun(w, a, b) {
  const W = w.width, H = w.height, sa = w.subs.subAt;
  let dx = b[0] - a[0];
  if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
  const dy = b[1] - a[1];
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) * 2));
  const ax = Math.round(a[0]), ay = Math.round(a[1]), bx = Math.round(a[0] + dx), by = Math.round(b[1]);
  const dry = (x, y) => !(x === ax && y === ay) && !(x === bx && y === by) && y >= 0 && y < H && !sa[y * W + ((x % W) + W) % W];
  for (let k = 1; k < n; k++) {
    const x = a[0] + dx * k / n, y = a[1] + dy * k / n;
    const x0 = Math.round(x - 1e-6), x1 = Math.round(x + 1e-6), y0 = Math.round(y - 1e-6), y1 = Math.round(y + 1e-6);
    if (dry(x0, y0) || dry(x1, y1) || (x0 !== x1 && dry(x1, y0)) || (y0 !== y1 && dry(x0, y1))) return false;
  }
  return true;
}

// Margin in pixels around a stretch within which a way round by any water is looked for, where its own subregions give none.
const DETOUR_MARGIN = 240;
const STEPS8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
// Buffers reused by searches while none is paused, and the stamps marking what a search has reached and which subregions it may enter.
const way = { cap: 0, g: null, prev: null, seen: null, stamp: 0, heap: new Heap(4096), busy: false, mark: null, marked: 0 };
// Pixels a search settles, and points a way pulled tight keeps, between pauses.
const DETOUR_SLICE = 1024;
const TIGHT_SLICE = 16;
// The shortest way between two pixels by water within a box, through the subregions given or any where none are, pulled tight; ends included, null where there is none; pausing between pixels.
function* wayWithin(w, a, b, allow, x0, y0, bw, bh) {
  const W = w.width, sa = w.subs.subAt;
  const size = bw * bh;
  // The shared buffers where free, else its own.
  const own = way.busy;
  let g, prev, seen, heap, stamp;
  if (own) { g = new Float64Array(size); prev = new Int32Array(size); seen = new Uint32Array(size); heap = new Heap(4096); stamp = 1; } else {
    if (size > way.cap) { way.cap = size; way.g = new Float64Array(size); way.prev = new Int32Array(size); way.seen = new Uint32Array(size); way.stamp = 0; }
    ({ g, prev, seen, heap } = way);
    stamp = ++way.stamp;
    way.busy = true;
  }
  try {
    let mark = null, marked = 0;
    if (allow) {
      if (!way.mark || way.mark.length < w.subs.atIndex.length) way.mark = new Uint32Array(w.subs.atIndex.length);
      mark = way.mark;
      marked = ++way.marked;
      for (const s of allow) mark[s] = marked;
    }
    const s = (a[1] - y0) * bw + (a[0] - x0), t = (b[1] - y0) * bw + (b[0] - x0);
    const tx = b[0] - x0, ty = b[1] - y0;
    const h = (x, y) => { const p = Math.abs(x - tx), q = Math.abs(y - ty); return p > q ? p + (Math.SQRT2 - 1) * q : q + (Math.SQRT2 - 1) * p; };
    // Where each column and row of the box starts in the map.
    const col = Int32Array.from({ length: bw }, (_, x) => (((x + x0) % W) + W) % W), row = Int32Array.from({ length: bh }, (_, y) => (y + y0) * W);
    const wet = (x, y) => sa[row[y] + col[x]];
    heap.n = 0;
    g[s] = 0; seen[s] = stamp; prev[s] = -1;
    heap.push(h(a[0] - x0, a[1] - y0), s);
    let settled = 0;
    while (heap.n) {
      const c = heap.pop(), f = heap.top;
      if (c === t) break;
      const cx = c % bw, cy = (c - cx) / bw;
      if (f - h(cx, cy) > g[c] + 1e-9) continue;
      if (++settled % DETOUR_SLICE === 0) {
        // Another search may run while this one waits, and marks subregions of its own.
        yield;
        if (allow && way.marked !== marked) { marked = ++way.marked; for (const x of allow) mark[x] = marked; }
      }
      for (const [ox, oy, step] of STEPS8) {
        const nx = cx + ox, ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const k = ny * bw + nx;
        if (k !== t) {
          const v = wet(nx, ny);
          if (!v || (allow && mark[v] !== marked)) continue;
        }
        // No corner of land cut on a diagonal.
        if (ox && oy && (!wet(nx, cy) || !wet(cx, ny))) continue;
        const n = g[c] + step;
        if (seen[k] === stamp && n >= g[k]) continue;
        g[k] = n; seen[k] = stamp; prev[k] = c;
        heap.push(n + h(nx, ny), k);
      }
    }
    if (seen[t] !== stamp) return null;
    const path = [];
    for (let c = t; c >= 0; c = prev[c]) path.push([c % bw + x0, Math.floor(c / bw) + y0]);
    path.reverse();
    // Pulled tight: from each point on to the farthest one a straight run on water reaches.
    const out = [path[0]];
    for (let i = 0; i < path.length - 1;) {
      if (out.length % TIGHT_SLICE === 0) yield;
      let j = i + 1, step = 1;
      while (j + step < path.length && wetRun(w, path[i], path[j + step])) { j += step; step *= 2; }
      let hi = Math.min(j + step, path.length);
      while (hi - j > 1) { const m = (j + hi) >> 1; if (wetRun(w, path[i], path[m])) j = m; else hi = m; }
      out.push(path[j]);
      i = j;
    }
    return out;
  } finally {
    if (!own) way.busy = false;
  }
}
// Ways by water found for stretches of sea lines, by their ends and subregions, null where none was.
const detoursHeld = new Map();
// A way by water between two pixels for a stretch of a sea line: through the subregions it runs in, else any water near it; null where none is found.
function* waterDetour(w, a, b, allow) {
  const key = a.join() + '|' + b.join() + '|' + allow.join('.');
  if (detoursHeld.has(key)) return detoursHeld.get(key);
  const W = w.width, H = w.height;
  let dx = b[0] - a[0];
  if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W;
  const A = [a[0], a[1]], B = [a[0] + dx, b[1]];
  // The box round the subregions given, where none wraps round the map.
  let x0 = Math.min(A[0], B[0]), x1 = Math.max(A[0], B[0]), y0 = Math.min(A[1], B[1]), y1 = Math.max(A[1], B[1]);
  let wraps = false;
  for (const s of allow) {
    const bb = w.subs.bounds.get(w.subs.atIndex[s].id);
    if (!bb) continue;
    if (bb.maxX - bb.minX > W / 2) { wraps = true; break; }
    let lo = bb.minX, hi = bb.maxX;
    const mid = (x0 + x1) / 2;
    while ((lo + hi) / 2 - mid > W / 2) { lo -= W; hi -= W; }
    while (mid - (lo + hi) / 2 > W / 2) { lo += W; hi += W; }
    x0 = Math.min(x0, lo); x1 = Math.max(x1, hi); y0 = Math.min(y0, bb.minY); y1 = Math.max(y1, bb.maxY);
  }
  const box = (m, X0, X1, Y0, Y1) => { const bx = X0 - m, by = Math.max(0, Y0 - m); return [bx, by, X1 + m - bx + 1, Math.min(H - 1, Y1 + m) - by + 1]; };
  const near = box(DETOUR_MARGIN, Math.min(A[0], B[0]), Math.max(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[1], B[1]));
  const found = (yield* wayWithin(w, A, B, allow, ...(wraps ? near : box(2, x0, x1, y0, y1)))) || (yield* wayWithin(w, A, B, null, ...near));
  detoursHeld.set(key, found);
  return found;
}

// Sea lines drawn, by their ends and the subregions between them, as map pixels x, y in turn; kept between sessions.
const seaLinesHeld = new Map();
// Sea lines drawn since the store was last written.
let seaLinesNew = 0;
const seaLineKey = (a, path, b) => a.join() + '|' + path.join('.') + '|' + b.join();
// The line from one point to another through a run of subregions as pixels, each stretch that leaves the water sent round by it; pausing while a way round is looked for.
function* seaLineSteps(w, path, a, b) {
  const key = seaLineKey(a, path, b);
  if (seaLinesHeld.has(key)) return seaLinesHeld.get(key);
  const stops = [{ p: a, at: 0 }, ...gatesAlong(w, path, a, b), { p: b, at: path.length - 1 }];
  const out = [a[0], a[1]];
  for (let n = 1; n < stops.length; n++) {
    const s = stops[n - 1], t = stops[n];
    const way = wetRun(w, s.p, t.p) ? null : yield* waterDetour(w, s.p, t.p, path.slice(Math.max(0, s.at - 1), t.at + 1));
    if (way) for (const p of way.slice(1, -1)) out.push(((p[0] % w.width) + w.width) % w.width, p[1]);
    out.push(t.p[0], t.p[1]);
    yield;
  }
  const px = Uint16Array.from(out);
  if (!seaLinesHeld.has(key)) { seaLinesHeld.set(key, px); seaLinesNew++; }
  return seaLinesHeld.get(key);
}
// The same as [lat, lon].
function* seaLinePoints(w, path, from, to) {
  const px = yield* seaLineSteps(w, path, pixelAt(w, from), pixelAt(w, to));
  const out = [];
  for (let n = 0; n < px.length; n += 2) out.push(pointAt(w, px[n], px[n + 1]));
  return out;
}

// A sea edge's line through the subregions it passes, from the shore of one quay county facing its first water to the other's facing its last, as [lat, lon]; kept per edge.
function seaEdgeLine(w, g, e) {
  return seaPairLine(w, g, portOfEdge(g, e), g.edgeTo[e]);
}
// The ports a line between two is drawn from and to: one way for both directions.
const pairEnds = (g, i, j) => (i > j && Number.isFinite(g.km[j * g.P + i]) ? [j, i] : [i, j]);
// The subregions from one port to another, first to last.
function pairPath(g, i, j) {
  const path = [], up = pairParents(g, i, j);
  for (let s = g.endSub[i * g.P + j]; s > 0; s = up[i * g.NS + s]) path.push(s);
  return path.reverse();
}
// The same from one port to another by index, whether or not a leg joins them; kept per pair.
const seaPairLine = (w, g, i, j) => finish(seaPairSteps(w, g, i, j));
// The same in steps, pausing while a way round is looked for.
function* seaPairSteps(w, g, i, j) {
  const [a, b] = pairEnds(g, i, j);
  g.lines ||= new Map();
  const key = a * g.P + b;
  if (!g.lines.has(key)) {
    const path = pairPath(g, a, b);
    const line = yield* seaLinePoints(w, path, g.quayAt[a].get(path[0]), g.quayAt[b].get(path[path.length - 1]));
    g.lines.set(key, line);
  }
  const line = g.lines.get(key).slice();
  return a === i ? line : line.reverse();
}
// The sea lines a route is drawn along built in steps, its own legs' and those of the ports sharing its stops.
function* routeSeaSteps(w, route) {
  const g = drawnGraphs(w).sea;
  for (let n = 0; n < route.legs.length; n++) {
    const l = route.legs[n];
    if (l.mode !== 'sea') continue;
    yield* seaPairSteps(w, g, portOfEdge(g, l.edge), g.edgeTo[l.edge]);
    if (!l.shares) continue;
    const a = portOfEdge(g, l.edge), b = g.edgeTo[route.legs[n + 1].edge];
    for (const s of l.shares.slice(1)) { yield* seaPairSteps(w, g, a, s.port); yield* seaPairSteps(w, g, s.port, b); }
  }
}
// Sea legs looked over between pauses where their lines are held already.
const EDGES_LOOKED = 512;
// Every sea leg's line drawn in steps where not held yet; the leg reached kept on the graph to go on from.
function* seaEdgeSteps(w, g) {
  g.edgesLooked ||= 0;
  for (let looked = 0; g.edgesLooked < g.edgeTo.length; g.edgesLooked++) {
    const e = g.edgesLooked;
    const [a, b] = pairEnds(g, portOfEdge(g, e), g.edgeTo[e]);
    if (g.lines?.has(a * g.P + b)) continue;
    const path = pairPath(g, a, b);
    const from = pixelAt(w, g.quayAt[a].get(path[0])), to = pixelAt(w, g.quayAt[b].get(path[path.length - 1]));
    if (seaLinesHeld.has(seaLineKey(from, path, to))) { if (++looked % EDGES_LOOKED === 0) yield; continue; }
    yield* seaLineSteps(w, path, from, to);
    yield;
  }
}

// Where a land step between two counties bends: none where the straight run stays on land, else a point on their border keeping it there, as [lat, lon].
function landBend(w, u, v, a, b) {
  // Worked out one way for both directions.
  if (u > v) return landBend(w, v, u, b, a);
  const lb = landBorders(w);
  const key = u < v ? u * lb.N + v : v * lb.N + u;
  const pa = pixelOf(w, a), pb = pixelOf(w, b);
  if (!offSide(w, pa, pb, false)) return [];
  const id = key + '|' + a.join() + '|' + b.join();
  if (!lb.via.has(id)) {
    const p = bestSample(w, lb.at.get(key) || [], pa, pb, false);
    lb.via.set(id, p ? [pointAt(w, p[0], p[1])] : []);
  }
  return lb.via.get(id);
}
// A land path through counties, bending where a straight step would cross water.
// Counties a land line passes between pauses.
const LAND_SLICE = 64;
function* landLine(w, land, g, ks) {
  const out = [];
  for (let n = 0; n < ks.length; n++) {
    if (n % LAND_SLICE === LAND_SLICE - 1) yield;
    const p = nodeAt(w, land, g, ks[n]);
    if (n) out.push(...landBend(w, ks[n - 1], ks[n], out[out.length - 1], p));
    out.push(p);
  }
  return out;
}

// Where a county is drawn: at its port's quay where it is one, else its centre.
const nodeAt = (w, land, g, k) => (land.portAt[k] >= 0 ? g.quay[land.portAt[k]] : w.counties.atIndex[k].centre);

// The land and sea graphs lines are drawn on: those trade last read, built only where none is held yet.
function drawnGraphs(w) {
  if (landHeld?.w === w) return { land: landHeld, sea: landHeld.sea };
  const land = landGraph(w);
  return { land, sea: land.sea };
}
// Whether trade has read the graphs lines are drawn on.
const routesDrawable = (w) => landHeld?.w === w;

// A route's line on the map: for each leg, the points it runs through as [lat, lon].
const routeLine = (w, route) => finish(routeLineSteps(w, route));
// The same in steps, a leg or part of one a step.
function* routeLineSteps(w, route) {
  const { land, sea: g } = drawnGraphs(w);
  const out = [];
  for (const l of route.legs) {
    out.push(l.mode === 'sea' ? yield* seaPairSteps(w, g, portOfEdge(g, l.edge), g.edgeTo[l.edge]) : yield* landLine(w, land, g, l.through.map((id) => w.counties.byId.get(id).index)));
    yield;
  }
  return out;
}

// Feeder networks, trees and lines, kept while the land they cross stands whatever its calls cost; and hubs and capitals of countries trade has not read, per land graph.
let feedHeld = null;
const feedersOf = (land) => {
  if (feedHeld?.shape !== land.shape) feedHeld = { shape: land.shape, nets: new Map(), trees: new Map(), lines: new Map() };
  return feedHeld;
};
const drawnEnds = new WeakMap();
const drawnOf = (land) => { if (!drawnEnds.has(land)) drawnEnds.set(land, { ends: new Map(), capitals: new Map() }); return drawnEnds.get(land); };
// A country's capital for drawing: as trade read it, else worked out without keeping it in the land graph.
function feederCapital(w, land, id) {
  if (land.capitals?.has(id)) return land.capitals.get(id);
  const d = drawnOf(land);
  if (!d.capitals.has(id)) d.capitals.set(id, capitalCounty(w, land, id));
  return d.capitals.get(id);
}
// A country's hub for drawing, the same way.
function feederHub(w, land, sea, id) {
  if (land.ends?.has(id)) return land.ends.get(id);
  const d = drawnOf(land);
  if (!d.ends.has(id)) d.ends.set(id, hubFor(w, land, id, feederCapital, sea));
  return d.ends.get(id);
}

// Share of the way on from a point of the network to the hub that counts against joining there.
const NET_ONWARD = 0.5;
// A country's feeder network: grown from its hub over its own land and ports, each time joining the city, province seat or port cheapest to reach, by the way to it plus NET_ONWARD of the way on to the hub; pausing between counties.
function* feederNet(w, land, sea, id, hub, ours) {
  const NC = land.NC, cs = w.counties;
  const dist = new Float64Array(NC).fill(Infinity), prev = new Int32Array(NC).fill(-1), via = new Int32Array(NC);
  const inNet = new Uint8Array(NC), mine = new Uint8Array(NC), toHub = new Float64Array(NC);
  for (let k = 1; k < NC; k++) mine[k] = ours(k) ? 1 : 0;
  // Cities and the seats of provinces, held by the country.
  const targets = new Set();
  for (const t of w.cities || []) {
    const k = cs.countyAt[t.y * cs.width + t.x];
    if (k && mine[k] && w.byId.get(t.province)?.owner === id) targets.add(k);
  }
  for (const p of w.atIndex) if (p?.owner === id && land.seat[p.index] > 0 && mine[land.seat[p.index]]) targets.add(land.seat[p.index]);
  // And the country's ports, so every port hangs on the same network.
  sea.ports.forEach((p, i) => { const k = sea.quayCounty[i]; if (k > 0 && mine[k] && land.ctrl[k] === land.countryAt.get(id)) targets.add(k); });
  const heap = new Heap(256);
  let settled = 0;
  // Joined counties, their way to the hub known.
  const join = (ks) => { for (const k of ks) { inNet[k] = 1; dist[k] = NET_ONWARD * toHub[k]; heap.push(dist[k], k); targets.delete(k); } };
  const grow = function* () {
    while (heap.n) {
      const u = heap.pop(), d = heap.top;
      if (d > dist[u]) continue;
      if (++settled % TREE_SLICE === 0) yield;
      for (let e = land.off[u]; e < land.off[u + 1]; e++) {
        const v = land.to[e];
        const n = d + land.cost[e] / land.warAt[v] + (via[u] > 0 && land.rail[via[u] - 1] !== land.rail[e] ? STOP_POINTS * RAIL_HANDLING : 0);
        if (mine[v] && !inNet[v] && better(n, dist[v], u, prev[v])) { dist[v] = n; prev[v] = u; via[v] = e + 1; heap.push(n, v); }
      }
      const i = land.portAt[u];
      if (i < 0) continue;
      for (let e = sea.edgeOff[i]; e < sea.edgeOff[i + 1]; e++) {
        const v = sea.quayCounty[sea.edgeTo[e]], n = d + FEEDER_SEA_HOP + sea.edgeSail[e];
        if (v > 0 && mine[v] && !inNet[v] && better(n, dist[v], u, prev[v])) { dist[v] = n; prev[v] = u; via[v] = -(e + 1); heap.push(n, v); }
      }
    }
  };
  join([hub]);
  for (;;) {
    yield* grow();
    let next = -1;
    for (const k of targets) if (dist[k] < Infinity && (next < 0 || dist[k] < dist[next])) next = k;
    if (next < 0) break;
    const path = [];
    let at = next;
    for (; !inNet[at]; at = prev[at]) path.push(at);
    for (const k of path) toHub[k] = toHub[at] + dist[k] - dist[at];
    join(path);
  }
  return { has: (k) => inNet[k] === 1 && k !== hub, get: (k) => [prev[k], via[k]], prev, via, inNet };
}

// Water pixels a pocket stays under: water joined to the sea by less is not berthed on.
const POCKET_PX = 300;
// Share of a sale's cargo under which a port of landing or departure hands it over to the nearest busier one by sea.
const PORT_FOLD = 0.1;
// How far behind a port on wholly Arctic water starts in a port network, in points: at NET_ONWARD, about 1,000 km of rail.
const ARCTIC_PORT_BEHIND = 6000;

// A country's ports along its feeder network: for each county on the network, the port nearest along it, the next county towards that port and the network step taken, a port on icebound water starting behind by the share of its waters that are Arctic; null for a country with no port on the network.
function* portNet(w, land, sea, id, tree) {
  const NC = land.NC, c = land.countryAt.get(id);
  const { prev, via, inNet } = tree;
  // The network's steps both ways: from each county, to its neighbours on the network with the step's cost.
  const near = new Map();
  const link = (a, b, e, up) => { if (!near.has(a)) near.set(a, []); near.get(a).push([b, e, up]); };
  let worked = 0;
  for (let k = 1; k < NC; k++) {
    if (!inNet[k] || prev[k] < 0) continue;
    if (++worked % TREE_SLICE === 0) yield;
    link(k, prev[k], via[k], true);
    link(prev[k], k, via[k], false);
  }
  const stepCost = (e) => (e > 0 ? land.cost[e - 1] : FEEDER_SEA_HOP + sea.edgeSail[-e - 1]);
  const dist = new Float64Array(NC).fill(Infinity), root = new Int32Array(NC).fill(-1), step = new Int32Array(NC).fill(-1), stepVia = new Int32Array(NC), stepUp = new Uint8Array(NC);
  const heap = new Heap(256);
  let any = false;
  sea.ports.forEach((p, i) => {
    const k = sea.quayCounty[i];
    if (k <= 0 || land.ctrl[k] !== c || !inNet[k]) return;
    const waters = [...sea.quayAt[i].keys()];
    const ice = waters.length ? waters.filter((x) => sea.mode[x] > MODE_POINTS.sea).length / waters.length : 0;
    const start = NET_ONWARD * ARCTIC_PORT_BEHIND * ice;
    if (start < dist[k]) { dist[k] = start; root[k] = i; heap.push(start, k); any = true; }
  });
  if (!any) return null;
  let settled = 0;
  while (heap.n) {
    const u = heap.pop(), d = heap.top;
    if (d > dist[u]) continue;
    if (++settled % TREE_SLICE === 0) yield;
    for (const [v, e, up] of near.get(u) || []) {
      const n = d + stepCost(e);
      if (better(n, dist[v], u, step[v])) { dist[v] = n; root[v] = root[u]; step[v] = u; stepVia[v] = e; stepUp[v] = up ? 0 : 1; heap.push(n, v); }
    }
  }
  return { root, step, stepVia, stepUp, inNet };
}

// The counties of each province's cities, once per map.
const cityCountiesBy = new WeakMap();
function cityCounties(w) {
  if (!cityCountiesBy.has(w)) {
    const cs = w.counties, out = new Map();
    for (const t of w.cities || []) {
      const k = cs.countyAt[t.y * cs.width + t.x];
      if (!k) continue;
      if (!out.has(t.province)) out.set(t.province, []);
      if (!out.get(t.province).includes(k)) out.get(t.province).push(k);
    }
    cityCountiesBy.set(w, out);
  }
  return cityCountiesBy.get(w);
}

// A county's way along its country's network to its port, as pieces by rail, road and sea from the county; reversed for cargo coming ashore; kept per country and county.
function portPieces(w, land, sea, id, net, k, ashore) {
  const held = feedersOf(land);
  held.portLines ||= new Map();
  const key = id + '|' + k;
  if (!held.portLines.has(key)) {
    const centre = (u) => nodeAt(w, land, sea, u);
    const pieces = [];
    const walked = [k];
    let line = null;
    for (let u = k; net.step[u] >= 0; u = net.step[u]) {
      const v = net.step[u], e = net.stepVia[u];
      if (e < 0) {
        // A sea step on the network, held from the parent's port to the child's.
        const x = -e - 1, from = portOfEdge(sea, x), to = sea.edgeTo[x];
        pieces.push({ mode: 'sea', points: net.stepUp[u] ? seaPairLine(w, sea, to, from) : seaPairLine(w, sea, from, to) });
        line = null;
      } else {
        const mode = land.rail[e - 1] ? 'rail' : 'road';
        if (!line || line.mode !== mode) pieces.push((line = { mode, points: [centre(u)] }));
        line.points.push(...landBend(w, u, v, line.points[line.points.length - 1], centre(v)), centre(v));
      }
      walked.push(v);
    }
    pieces.walked = walked;
    held.portLines.set(key, pieces);
  }
  const out = held.portLines.get(key);
  if (!ashore) return out;
  const back = out.slice().reverse().map((piece) => ({ mode: piece.mode, points: piece.points.slice().reverse() }));
  back.walked = out.walked;
  return back;
}

// Where a sale's cargo comes ashore (landing) or goes aboard at home: the port each of the country's provinces hangs from in its port network, by the provinces' shares, the ports under PORT_FOLD of the cargo handed to the nearest busier one by sea.
// As { leg, home, at, net, ports: Map(port -> { share, counties: [[county, share]], via: [{ port, share, counties }] }), rest }: leg the route's last or first sea leg, home the port the route itself uses there, at the port sailed from (landing) or for (departure), rest the share of provinces no reachable port serves; null where that leg does not touch the country.
function* endPlan(w, route, id, ends, landing) {
  const { land, sea } = drawnGraphs(w);
  const legs = route.legs;
  let n = -1;
  if (landing) legs.forEach((l, i) => { if (l.mode === 'sea') n = i; });
  else n = legs.findIndex((l) => l.mode === 'sea');
  const c = land.countryAt.get(id);
  if (n < 0 || c === undefined) return null;
  const home = landing ? sea.edgeTo[legs[n].edge] : portOfEdge(sea, legs[n].edge);
  if (land.ctrl[sea.quayCounty[home]] !== c) return null;
  const at = landing ? portOfEdge(sea, legs[n].edge) : sea.edgeTo[legs[n].edge];
  const held = feedersOf(land);
  held.portNets ||= new Map();
  if (!held.portNets.has(id)) {
    const hub = feederHub(w, land, sea, id), netKey = id + '|' + hub;
    if (hub < 0) return null;
    if (!held.nets.has(netKey)) {
      const ours = (k) => land.ctrl[k] === c || w.atIndex[land.provOf[k]]?.owner === id;
      held.nets.set(netKey, yield* feederNet(w, land, sea, id, hub, ours));
    }
    held.portNets.set(id, yield* portNet(w, land, sea, id, held.nets.get(netKey)));
  }
  const net = held.portNets.get(id);
  if (!net) return null;
  // A port reached by sea from the other end, and through ice only where the route itself goes through it.
  const iced = pairIced(sea, portOfEdge(sea, legs[n].edge), sea.edgeTo[legs[n].edge]);
  const sails = (y) => y === at || (Number.isFinite(landing ? sea.km[at * sea.P + y] : sea.km[y * sea.P + at]) && (iced || !(landing ? pairIced(sea, at, y) : pairIced(sea, y, at))));
  const towns = cityCounties(w);
  const all = new Map();
  let rest = 0;
  for (const [p, share] of ends) {
    const ks = p ? (towns.get(p) || [land.seat[w.byId.get(p)?.index ?? -1]]) : [feederCapital(w, land, id)];
    for (const k of ks) {
      const part = share / ks.length;
      const y = k > 0 && net.inNet[k] ? net.root[k] : -1;
      if (y < 0 || !sails(y)) { rest += part; continue; }
      if (!all.has(y)) all.set(y, { share: 0, counties: [], via: [] });
      const e = all.get(y);
      e.share += part;
      e.counties.push([k, part]);
    }
  }
  if (!all.size) return null;
  // The busier ports keep their own; each lesser one goes to the nearest of them by sea.
  const ranked = [...all].sort((a, b) => b[1].share - a[1].share);
  const kept = new Map(ranked.filter(([, e], i) => i === 0 || e.share >= PORT_FOLD));
  for (const [z, e] of ranked) {
    if (kept.has(z)) continue;
    let best = -1, near = Infinity;
    for (const y of kept.keys()) { const km = sea.km[(landing ? y * sea.P + z : z * sea.P + y)]; if (km < near) { near = km; best = y; } }
    if (best < 0) { rest += e.share; continue; }
    const into = kept.get(best);
    into.share += e.share;
    into.via.push({ port: z, share: e.share, counties: e.counties });
  }
  return { leg: n, home, at, net, ports: kept, rest };
}

// A feeder inside a country: from a county where given, else a province's seat, or the capital where null, to the country's hub, as pieces { mode: 'sea', 'rail' or 'road', points }.
// Over the counties it owns or holds, by sea between ports only where its land does not join; an exclave crosses others' land, and a coast with no port goes by sea to the nearest port reached.
function feederLine(w, id, province, county = -1, reached = null) { return finish(feederSteps(w, id, province, county, reached)); }

// The same in steps, pausing while a network or tree is built.
function* feederSteps(w, id, province, county = -1, reached = null) {
  const { land, sea } = drawnGraphs(w);
  const hub = feederHub(w, land, sea, id);
  if (reached) return yield* feederPieces(w, land, sea, id, hub, province, county, reached);
  // Kept per country, province and hub while the land stands.
  const held = feedersOf(land);
  const key = id + '|' + province + '|' + county + '|' + hub;
  if (!held.lines.has(key)) held.lines.set(key, yield* feederPieces(w, land, sea, id, hub, province, county));
  return held.lines.get(key);
}

function* feederPieces(w, land, sea, id, hub, province, county = -1, reached = null) {
  const held = feedersOf(land);
  const p = province ? w.byId.get(province)?.index : null;
  const from = county > 0 ? county : p ? land.seat[p] : feederCapital(w, land, id);
  if (hub < 0 || from < 0) return [];
  const c = land.countryAt.get(id);
  const ours = (k) => land.ctrl[k] === c || w.atIndex[land.provOf[k]]?.owner === id;
  const anyone = () => true;
  // Cheapest way to the hub from every county a land test lets in, fewest sea hops first; other counties are passed through by sea only.
  const treeOf = function* (key, open) {
    if (held.trees.has(key)) return held.trees.get(key);
    const NC = land.NC;
    const dist = new Float64Array(NC).fill(Infinity), prev = new Int32Array(NC).fill(-1), via = new Int32Array(NC);
    const mine = new Uint8Array(NC);
    for (let k = 1; k < NC; k++) mine[k] = ours(k) ? 1 : 0;
    const heap = new Heap(256);
    let settled = 0;
    dist[hub] = 0;
    heap.push(0, hub);
    const reach = (u, v, n, e) => { if (better(n, dist[v], u, prev[v])) { dist[v] = n; prev[v] = u; via[v] = e; heap.push(n, v); } };
    while (heap.n) {
      const u = heap.pop(), d = heap.top;
      if (d > dist[u]) continue;
      if (++settled % TREE_SLICE === 0) yield;
      if (open(u)) {
        for (let e = land.off[u]; e < land.off[u + 1]; e++) {
          const v = land.to[e];
          if (open(v)) reach(u, v, d + land.cost[e] / land.warAt[v] + (mine[v] ? 0 : FEEDER_SEA_HOP / 1e3), e + 1);
        }
      }
      const i = land.portAt[u];
      if (i < 0) continue;
      for (let e = sea.edgeOff[i]; e < sea.edgeOff[i + 1]; e++) reach(u, sea.quayCounty[sea.edgeTo[e]], d + FEEDER_SEA_HOP + sea.edgeSail[e], -(e + 1));
    }
    const back = { has: (k) => prev[k] >= 0, get: (k) => [prev[k], via[k]] };
    held.trees.set(key, back);
    return back;
  };
  const centre = (k) => nodeAt(w, land, sea, k);
  // The pieces from a county a tree reached to the hub, or to the first county in reached; the counties walked kept as walked.
  const walked = [];
  const pathFrom = function* (back, start) {
    const pieces = [];
    let land1 = null;
    walked.push(start);
    for (let u = start, n = 0; u !== hub && !(reached?.has(u)); n++) {
      if (n % LAND_SLICE === LAND_SLICE - 1) yield;
      // A fallback way joins the network at the first county of it it reaches, and follows it from there.
      const [v, via] = (back !== net && net?.has(u) ? net : back).get(u);
      if (via < 0) {
        // Sea edges are held from v's port to u's, so the line is walked back.
        const e = -via - 1;
        pieces.push({ mode: 'sea', points: (yield* seaPairSteps(w, sea, portOfEdge(sea, e), sea.edgeTo[e])).reverse() });
        land1 = null;
      } else {
        const mode = land.rail[via - 1] ? 'rail' : 'road';
        if (!land1 || land1.mode !== mode) pieces.push((land1 = { mode, points: [centre(u)] }));
        land1.points.push(...landBend(w, u, v, land1.points[land1.points.length - 1], centre(v)), centre(v));
      }
      walked.push(v);
      u = v;
    }
    pieces.walked = walked;
    return pieces;
  };
  const netKey = id + '|' + hub;
  if (!held.nets.has(netKey)) held.nets.set(netKey, yield* feederNet(w, land, sea, id, hub, ours));
  const net = held.nets.get(netKey);
  if (from === hub || net.has(from)) return yield* pathFrom(net, from);
  const own = yield* treeOf(netKey, (k) => ours(k));
  if (own.has(from)) return yield* pathFrom(own, from);
  const wide = yield* treeOf(netKey + '*', anyone);
  if (wide.has(from)) return yield* pathFrom(wide, from);
  // Neither: overland to the nearest shore of the province, then by sea to the nearest port of its own, or any reached where it has none.
  const ownless = !sea.ports.some((p, j) => sea.quayCounty[j] > 0 && ours(sea.quayCounty[j]) && (sea.quayCounty[j] === hub || own.has(sea.quayCounty[j])));
  const steps = new Map([[from, -1]]), queue = [from];
  let shoreK = 0;
  for (let n = 0; n < queue.length && !shoreK; n++) {
    const u = queue[n];
    if (sea.coastAt.has(u)) { shoreK = u; break; }
    for (let e = land.off[u]; e < land.off[u + 1]; e++) {
      const v = land.to[e];
      if (!steps.has(v) && land.provOf[v] === land.provOf[from]) { steps.set(v, u); queue.push(v); }
    }
  }
  const inlandKs = [];
  for (let u = shoreK; u > 0; u = steps.get(u)) inlandKs.unshift(u);
  // The walk to the shore by rail and road pieces.
  const inland = [];
  inlandKs.forEach((k, n) => {
    if (!n) return;
    const u = inlandKs[n - 1];
    let mode = 'road';
    for (let e = land.off[u]; e < land.off[u + 1]; e++) if (land.to[e] === k && land.rail[e]) mode = 'rail';
    let last = inland[inland.length - 1];
    if (!last || last.mode !== mode) inland.push((last = { mode, points: [centre(u)] }));
    last.points.push(...landBend(w, u, k, last.points[last.points.length - 1], centre(k)), centre(k));
  });
  let best = null;
  if (shoreK) {
    // Nearest water by worked km, Arctic counting harder, from the shore's own, with a port reached.
    const dist = new Map(), back = new Map(), heap = new Heap(64);
    for (const [x, ashore] of sea.coastAt.get(shoreK)) { const n = kmBetween(ashore, w.subs.atIndex[x].centre) * sea.mode[x]; if (n < (dist.get(x) ?? Infinity)) { dist.set(x, n); back.set(x, 0); heap.push(n, x); } }
    while (heap.n && !best) {
      const x = heap.pop();
      if (heap.top > dist.get(x)) continue;
      const i = sea.subPorts[x].find((j) => sea.quayCounty[j] > 0 && (sea.quayCounty[j] === hub || (ours(sea.quayCounty[j]) && own.has(sea.quayCounty[j]))))
        ?? (ownless ? sea.subPorts[x].find((j) => sea.quayCounty[j] > 0 && wide.has(sea.quayCounty[j])) : undefined);
      if (i !== undefined) {
        const path = [];
        for (let y = x; y > 0; y = back.get(y)) path.unshift(y);
        const ashore = sea.coastAt.get(shoreK).get(path[0]), quay = sea.quayAt[i].get(x);
        best = { k: sea.quayCounty[i], path, ashore, quay };
        break;
      }
      for (let e = sea.subOff[x]; e < sea.subOff[x + 1]; e++) {
        const y = sea.subTo[e], n = heap.top + sea.subWorked[e];
        if (n < (dist.get(y) ?? Infinity)) { dist.set(y, n); back.set(y, x); heap.push(n, y); }
      }
    }
  }
  if (best) {
    best.pts = yield* seaLinePoints(w, best.path, best.ashore, best.quay);
    if (inland.length) inland[inland.length - 1].points.push(best.pts[0]); else inland.push({ mode: 'road', points: [centre(from), best.pts[0]] });
    const out = [...inland, { mode: 'sea', points: best.pts }, ...(yield* pathFrom(ownless ? wide : own, best.k))];
    out.walked = [from, ...walked];
    return out;
  }
  const out = [{ mode: 'road', points: [centre(from), centre(hub)] }];
  out.walked = [from, hub];
  return out;
}

// ------------------------------------------------------------ the store

// Store layout version; bumped when what is kept or how it is drawn changes.
const ROUTE_STORE_VERSION = 8;
// Words of a bitmap hashed between pauses.
const HASH_WORDS = 1 << 18;
// The key of what the drawn lines rest on: the county and subregion bitmaps and their counts.
function* storeKeySteps(w) {
  let h = 0x811c9dc5;
  for (const at of [w.counties.countyAt, w.subs.subAt]) {
    const words = new Uint32Array(at.buffer, at.byteOffset, at.byteLength >> 2);
    for (let i = 0; i < words.length; i += HASH_WORDS) {
      h = hashWords(words.subarray(i, i + HASH_WORDS), h);
      yield;
    }
  }
  return [ROUTE_STORE_VERSION, w.width, w.height, w.counties.atIndex.length, w.subs.atIndex.length, h.toString(16)].join('-');
}

// Entries packed or unpacked between pauses.
const STORE_SLICE = 8192;
// Lists keyed by number or string packed: keys, where each one's entries start, and the entries in a typed array of the kind given.
function* packSteps(at, Kind) {
  const keys = [...at.keys()], off = new Uint32Array(keys.length + 1);
  let total = 0;
  keys.forEach((k, n) => { off[n] = total; total += at.get(k).length; });
  off[keys.length] = total;
  const values = new Kind(total);
  for (let n = 0; n < keys.length; n++) {
    values.set(at.get(keys[n]), off[n]);
    if (n % STORE_SLICE === 0) yield;
  }
  return { keys: typeof keys[0] === 'string' ? keys.join('\n') : Float64Array.from(keys), off, values };
}
// The same unpacked into a map, each entry made by the function given.
function* unpackSteps(p, out, make) {
  const keys = typeof p.keys === 'string' ? (p.keys ? p.keys.split('\n') : []) : p.keys;
  for (let n = 0; n < keys.length; n++) {
    if (!out.has(keys[n])) out.set(keys[n], make(p.values.subarray(p.off[n], p.off[n + 1])));
    if (n % STORE_SLICE === 0) yield;
  }
  return out;
}

// Everything kept between sessions, packed for the store: border samples and sea lines.
function* routeStoreSteps(w) {
  seaLinesNew = 0;
  const sea = seaBordersBy.get(w.subs), land = landBordersBy.get(w.counties);
  return {
    sea: sea ? (sea.packed ||= yield* packSteps(sea.at, Uint32Array)) : null,
    land: land ? (land.packed ||= yield* packSteps(land.at, Uint32Array)) : null,
    lines: yield* packSteps(seaLinesHeld, Uint16Array),
  };
}
// What a store held put back.
function* restoreSteps(w, data) {
  if (data.sea && !seaBordersBy.has(w.subs)) seaBordersBy.set(w.subs, { N: w.subs.atIndex.length, at: yield* unpackSteps(data.sea, new Map(), Array.from), packed: data.sea });
  if (data.land && !landBordersBy.has(w.counties)) landBordersBy.set(w.counties, { N: w.counties.atIndex.length, at: yield* unpackSteps(data.land, new Map(), Array.from), via: new Map(), packed: data.land });
  if (data.lines) yield* unpackSteps(data.lines, seaLinesHeld, (x) => x.slice());
}
// Sea lines drawn since the store was last written.
const routeStoreNew = () => seaLinesNew;

// Sea km between two ports by province id, or null where either is no port or no water joins them.
function seaKm(w, a, b) {
  const g = seaGraph(w);
  const i = g.portAt[w.byId.get(a)?.index ?? 0], j = g.portAt[w.byId.get(b)?.index ?? 0];
  if (i < 0 || j < 0 || i === undefined || j === undefined) return null;
  const k = g.km[i * g.ports.length + j];
  return k === Infinity ? null : k;
}

// Size of the sea graph, for the console.
function seaGraphStats(w) {
  const g = seaGraph(w);
  return { ports: g.ports.length, legs: g.edgeTo.length, ms: Math.round(g.ms), parts: Object.fromEntries(Object.entries(g.parts || {}).map(([k, n]) => [k, Math.round(n)])) };
}

export { LANE_PULL, LANE_DETOUR, HUB_REACH_KM, hubScore, MODE_POINTS, HANDLING, RAIL_HANDLING, ROUTE_SPREAD, SPREAD_REACH, SPREAD_PORTS, spreadLines, PORT_DEVELOPMENT, LEVEL_MAX, portDevelopment, TERRAIN_COST, CLIMATE_COST, WARZONE_RESISTANCE, ARCTIC_RESISTANCE, PORT_REF, PORT_MAX, ENTREPOT, ENTREPOT_FACTOR, STEP_KM, PASSAGE_KM, EMBARGO, passage, sailing, seaLeg, portFactor, seaKm, seaGraph, seaGraphStats, landGraph, treesBuilt, capitalOf, hubCounty, hubOf, findRoute, routeSteps, routeLine, routeLineSteps, feederLine, feederSteps, routeSeaSteps, closedSeas, drawnGraphs, routesDrawable, borderPrep, seaEdgeSteps, storeKeySteps, routeStoreSteps, restoreSteps, routeStoreNew, PORT_FOLD, endPlan, portPieces, seaPairLine };
