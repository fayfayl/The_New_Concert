// Production: the construction, equipment and ship queues, the stockpile and ships in service.

const VERSION = new URL(import.meta.url).search;
const { groundCost, countyFortCeiling } = await import(`../world/ceilings.js${VERSION}`);
const { clock, everyDay, live, worldChanged } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let activeAgreements, DOCKYARD_PORT_PX, builtLevel, countyGround, manpowerOf, occupiedFraction, railShare, setBuilding, unlockedSlots, usableCeiling;
export function link(all) { ({ activeAgreements, DOCKYARD_PORT_PX, builtLevel, countyGround, manpowerOf, occupiedFraction, railShare, setBuilding, unlockedSlots, usableCeiling } = all); }

const MEDIAN_PROVINCE_KM2 = 40224;
// Construction a level adds to projects in its own province.
const ROAD_CONSTRUCTION = 0.02;
const ELECTRICITY_CONSTRUCTION = 0.025;
// Generations researched; only the first until research exists.
const RESEARCHED_GENERATION = 1;

const tables = (w) => w.production || {};
const projectOf = (w, id) => (tables(w).construction?.projects || []).find((x) => x.id === id);
const itemOf = (w, id) => (tables(w).equipment?.items || []).find((x) => x.id === id);
const hullOf = (w, id) => (tables(w).ships?.hulls || []).find((x) => x.id === id);
const genCost = (base, g, rate = 1.5) => Math.ceil(base * rate ** (g - 1));
const valuesOf = (w, tag) => {
  const v = w.polityValues?.[tag];
  if (!v) throw new Error(`no polity "${tag}"`);
  v.construction ||= [];
  v.production ||= [];
  v.shipyard ||= [];
  v.stockpile ||= {};
  v.fleet ||= [];
  return v;
};

// A province's area-weighted ground across its counties.
function provinceGround(w, id) {
  let weighted = 0, area = 0;
  for (const c of w.counties?.byId?.values() || []) {
    if (c.province !== id) continue;
    weighted += groundCost(c) * (c.area || 0);
    area += c.area || 0;
  }
  return area ? weighted / area : 1;
}

// Whether a county touches navigable water, and whether it holds a port city.
function countyShore(w, countyId) {
  const g = countyGround(w, countyId);
  if (!g) return { coastal: false, port: false };
  const { bb } = g;
  let coastal = false;
  for (let y = bb.minY; y <= bb.maxY && !coastal; y++) {
    for (let x = bb.minX; x <= bb.maxX; x++) {
      if (g.mine(x, y) && (g.water(x + 1, y) || g.water(x - 1, y) || g.water(x, y + 1) || g.water(x, y - 1))) { coastal = true; break; }
    }
  }
  const port = coastal && (w.cities || []).some((t) => g.mine(t.x, t.y) && g.seaWithin(t.x, t.y, DOCKYARD_PORT_PX));
  return { coastal, port };
}

// Ground a polity may build on: its own, and not occupied.
function ownGround(w, tag, p) {
  if (!p || p.owner !== tag) throw new Error(`"${p?.id}" is not ${tag}'s`);
  if (occupiedFraction(w, p) > 0) throw new Error(`"${p.id}" is occupied`);
}

const scaled = (bill, k) => Object.fromEntries(Object.entries(bill || {}).map(([r, n]) => [r, n * k]));

// Queues a construction project; returns what it costs.
function queueConstruction(w, tag, id, where, to) {
  const proj = projectOf(w, id);
  if (!proj) throw new Error(`no project "${id}"; try ${(tables(w).construction?.projects || []).map((x) => `"${x.id}"`).join(', ')}`);
  if (proj.requires) throw new Error(`${proj.name} needs ${proj.requires}, which is not researched`);
  const v = valuesOf(w, tag);
  const queued = (match) => v.construction.filter(match).length;
  let multiplier = 1, points = proj.points, province, county = null;

  if (proj.on === 'province') {
    const p = w.byId?.get(where);
    const st = w.stats?.[where];
    if (!p || !st) throw new Error(`no province "${where}"`);
    ownGround(w, tag, p);
    province = where;
    if (proj.level) {
      const [built = 0, ceiling = 0] = Array.isArray(st[proj.level]) ? st[proj.level] : [builtLevel(st, proj.level), 0];
      const max = usableCeiling(proj.level, ceiling);
      const waiting = queued((x) => x.project === id && x.province === where);
      if (built + waiting >= max) throw new Error(`${proj.name} in "${where}" is at ${built}${waiting ? ` with ${waiting} queued` : ''} of ${max}`);
      const area = proj.area ? ((p.area || MEDIAN_PROVINCE_KM2) / MEDIAN_PROVINCE_KM2) ** 0.25 : 1;
      multiplier = (10 / ceiling) * (proj.ground ? provinceGround(w, where) : 1) * area;
    } else if (proj.factory) {
      const [, max = 0] = Array.isArray(st.buildingSlots) ? st.buildingSlots : [0, 0];
      const open = unlockedSlots(max, builtLevel(st, 'road'), builtLevel(st, 'electricity'), railShare(w, p));
      const used = (st.civilianFactories || 0) + (st.militaryFactories || 0)
        + queued((x) => x.province === where && projectOf(w, x.project)?.factory);
      if (used >= open) throw new Error(`"${where}" has no free building slot (${open} unlocked of ${max})`);
    }
  } else {
    const c = w.counties?.byId?.get(where);
    if (!c) throw new Error(`no county "${where}"`);
    const p = w.byId?.get(c.province);
    ownGround(w, tag, p);
    if (c.occupier) throw new Error(`"${where}" is occupied`);
    province = c.province;
    county = where;
    const here = (x) => x.county === where && x.project === id;
    if (id === 'rail') {
      if (c.rail !== undefined || queued(here)) throw new Error(`"${where}" is already railed or queued`);
      if (to !== undefined && ![...(w.counties.adjacency?.get(where) || [])].includes(to)) throw new Error(`"${where}" and "${to}" do not border each other`);
      multiplier = groundCost(c);
    } else if (proj.level === 'fortification') {
      const max = countyFortCeiling(c);
      const built = c.fortification || 0;
      if (built + queued(here) >= max) throw new Error(`fortification in "${where}" is at ${built} of ${max}`);
      multiplier = (10 / max) * groundCost(c);
    } else if (proj.building) {
      if (c[proj.building] || queued(here)) throw new Error(`"${where}" already holds or is building a ${proj.name.toLowerCase()}`);
      if (proj.needs && !(w.resources?.[c.province]?.[proj.needs] > 0)) throw new Error(`"${c.province}" holds no ${proj.needs}`);
      if (proj.coastal) {
        const shore = countyShore(w, where);
        if (!shore.coastal) throw new Error(`"${where}" is not on navigable water`);
        if (shore.port) points = proj.portPoints;
      }
    }
  }

  const total = points * multiplier;
  const entry = {
    project: id, province, county, to: to ?? null, total, progress: 0,
    money: total * proj.moneyPerPoint, materials: scaled(proj.materials, multiplier),
  };
  v.construction.push(entry);
  return { project: id, where, points: Math.round(total), money: Math.round(entry.money), materials: round(entry.materials) };
}

// Queues items of equipment.
function queueEquipment(w, tag, id, count = 1, generation = 1) {
  const item = itemOf(w, id);
  if (!item) throw new Error(`no item "${id}"; try ${(tables(w).equipment?.items || []).map((x) => `"${x.id}"`).join(', ')}`);
  if (!Number.isInteger(count) || count < 1) throw new Error('count is a whole number from 1');
  if (!Number.isInteger(generation) || generation < 1 || generation > RESEARCHED_GENERATION) throw new Error(`generation ${generation} is not researched`);
  valuesOf(w, tag).production.push({ item: id, generation, count, done: 0, progress: 0 });
  const points = genCost(item.points, generation);
  return { item: id, generation, count, points: points * count, money: Math.round(item.money * 1.5 ** (generation - 1) * count) };
}

// Lays down a hull at a dockyard.
function queueShip(w, tag, id, countyId, generation = 1) {
  const hull = hullOf(w, id);
  if (!hull) throw new Error(`no hull "${id}"; try ${(tables(w).ships?.hulls || []).map((x) => `"${x.id}"`).join(', ')}`);
  const c = w.counties?.byId?.get(countyId);
  if (!c?.dockyard) throw new Error(`"${countyId}" holds no dockyard`);
  ownGround(w, tag, w.byId?.get(c.province));
  if (c.occupier) throw new Error(`"${countyId}" is occupied`);
  const most = Math.min(hull.generations ?? 4, RESEARCHED_GENERATION);
  if (!Number.isInteger(generation) || generation < 1 || generation > most) throw new Error(`generation ${generation} is not available`);
  valuesOf(w, tag).shipyard.push({ hull: id, generation, county: countyId, progress: 0 });
  return { hull: id, generation, county: countyId, points: genCost(hull.points, generation), money: Math.round(hull.money * 1.5 ** (generation - 1)) };
}

const QUEUES = ['construction', 'production', 'shipyard'];
function cancelQueued(w, tag, queue, index) {
  if (!QUEUES.includes(queue)) throw new Error(`no queue "${queue}"; try ${QUEUES.map((q) => `"${q}"`).join(', ')}`);
  const list = valuesOf(w, tag)[queue];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) throw new Error(`${queue} holds ${list.length}`);
  return list.splice(index, 1)[0];
}

const round = (bag) => Object.fromEntries(Object.entries(bag || {}).map(([k, n]) => [k, Number(n.toFixed(2))]));
const keptFor = (kept, bill) => Object.keys(bill || {}).reduce((a, r) => a * (kept[r] ?? 1), 1);

// Finishes a construction project on the map.
function complete(w, x) {
  const proj = projectOf(w, x.project);
  const st = w.stats?.[x.province];
  if (proj.level && proj.on === 'province') {
    const [built = 0, ceiling = 0] = st[proj.level] || [];
    st[proj.level] = [built + 1, ceiling];
  } else if (proj.factory) {
    st[proj.factory] = (st[proj.factory] || 0) + 1;
  } else if (x.project === 'rail') {
    const c = w.counties.byId.get(x.county);
    c.rail = c.rail || [];
    if (x.to) {
      const d = w.counties.byId.get(x.to);
      c.rail = [...new Set([...c.rail, x.to])];
      if (d) d.rail = [...new Set([...(d.rail || []), x.county])];
    }
  } else if (proj.level === 'fortification') {
    const c = w.counties.byId.get(x.county);
    c.fortification = (c.fortification || 0) + 1;
  } else if (proj.building) {
    setBuilding(x.county, proj.building, true);
  }
}

// One day of every polity's queues.
function dailyProduction(w) {
  const out = new Map();
  let changed = false;
  const equipment = tables(w).equipment || {};
  for (const [tag, v] of Object.entries(w.polityValues || {})) {
    const made = live.lastIndustry?.get(tag) || {};
    const supply = live.lastSupply?.get(tag);
    const kept = supply?.kept || {};
    const cover = supply?.power?.cover ?? 1;
    const day = { constructionMoney: 0, equipmentMoney: 0, shipMoney: 0, fleetUpkeep: 0, fleetFuel: 0, stockpileStorage: 0, draws: {}, wanted: {}, completed: [] };
    const add = (into, bill, share) => { for (const [r, n] of Object.entries(bill || {})) into[r] = (into[r] || 0) + n * share; };
    const draw = (bill, share) => add(day.draws, bill, share);
    // What the queue would draw at full supply, walked down the queue in order.
    const want = (bill, share) => add(day.wanted, bill, share);

    // Construction: points in queue order; a project's own province speeds it, its materials' shortages slow it.
    let pool = made.points || 0;
    let wish = pool;
    for (const x of [...(v.construction || [])]) {
      if (pool <= 0) break;
      const st = w.stats?.[x.province] || {};
      const local = 1 + ROAD_CONSTRUCTION * builtLevel(st, 'road') + ELECTRICITY_CONSTRUCTION * builtLevel(st, 'electricity') * cover;
      const asked = Math.min(wish, (x.total - x.progress) / local);
      wish -= asked;
      want(x.materials, asked * local / x.total);
      const rate = local * keptFor(kept, x.materials);
      if (rate <= 0) continue;
      const spent = Math.min(pool, (x.total - x.progress) / rate);
      const work = spent * rate;
      pool -= spent;
      x.progress += work;
      day.constructionMoney += x.money * work / x.total;
      draw(x.materials, work / x.total);
      if (x.progress >= x.total - 1e-9) {
        complete(w, x);
        v.construction.splice(v.construction.indexOf(x), 1);
        day.completed.push(x.project + ' ' + (x.county || x.province));
        changed = true;
      }
    }

    // Equipment: points in queue order into the stockpile.
    pool = made.equipment || 0;
    // State agreements in equipment come first: the items themselves, from our stock, and built in our factories for the rest.
    for (const x of activeAgreements(w).filter((y) => y.first === tag && itemOf(w, y.good))) {
      const item = itemOf(w, x.good);
      const rv = w.polityValues?.[x.second];
      if (!rv) continue;
      rv.stockpile ||= {};
      v.stockpile ||= {};
      const order = ((v.orders ||= {})[x.second + '|' + x.good] ||= { owed: 0, progress: 0 });
      order.owed += x.amount || 0;
      const send = (k) => { rv.stockpile[k] = (rv.stockpile[k] || 0) + 1; order.owed -= 1; };
      // From stock, newest generation first.
      const stock = Object.keys(v.stockpile).filter((k) => k.startsWith(x.good + ':')).sort((a, b) => Number(b.split(':')[1]) - Number(a.split(':')[1]));
      for (const k of stock) {
        while (order.owed >= 1 - 1e-9 && v.stockpile[k] > 0) { v.stockpile[k] -= 1; send(k); }
        if (!v.stockpile[k]) delete v.stockpile[k];
      }
      // Built for the order, at our cost.
      const cost = genCost(item.points, 1, equipment.costPerGeneration);
      const rate = keptFor(kept, item.materials);
      while (order.owed >= 1 - 1e-9 && pool > 0 && rate > 0) {
        const spent = Math.min(pool, (cost - order.progress) / rate);
        const work = spent * rate;
        pool -= spent;
        order.progress += work;
        day.equipmentMoney += item.money * work / cost;
        want(item.materials, work / cost);
        draw(item.materials, work / cost);
        if (order.progress < cost - 1e-9) break;
        order.progress -= cost;
        send(item.id + ':1');
      }
      // What could not be sent is owed no further than a day's worth.
      order.owed = Math.min(order.owed, Math.max(1, x.amount || 0));
    }
    wish = pool;
    for (const x of [...(v.production || [])]) {
      if (pool <= 0) break;
      const item = itemOf(w, x.item);
      const cost = genCost(item.points, x.generation, equipment.costPerGeneration);
      const bill = scaled(item.materials, cost / item.points);
      const asked = Math.min(wish, (x.count - x.done) * cost - x.progress);
      wish -= asked;
      want(bill, asked / cost);
      const rate = keptFor(kept, bill);
      if (rate <= 0) continue;
      const spent = Math.min(pool, ((x.count - x.done) * cost - x.progress) / rate);
      const work = spent * rate;
      pool -= spent;
      x.progress += work;
      day.equipmentMoney += item.money * (equipment.costPerGeneration ?? 1.5) ** (x.generation - 1) * work / cost;
      draw(bill, work / cost);
      while (x.progress >= cost - 1e-9 && x.done < x.count) {
        x.progress -= cost;
        x.done++;
        const key = x.item + ':' + x.generation;
        v.stockpile[key] = (v.stockpile[key] || 0) + 1;
      }
      if (x.done >= x.count) v.production.splice(v.production.indexOf(x), 1);
    }

    // Ships: points in queue order; a hull commissions when its crew can be found.
    pool = made.ships || 0;
    for (const x of [...(v.shipyard || [])]) {
      const hull = hullOf(w, x.hull);
      const cost = genCost(hull.points, x.generation, tables(w).ships?.costPerGeneration);
      if (pool > 0 && x.progress < cost) {
        const spent = Math.min(pool, cost - x.progress);
        pool -= spent;
        x.progress += spent;
        day.shipMoney += hull.money * 1.5 ** (x.generation - 1) * spent / cost;
      }
      if (x.progress >= cost - 1e-9 && manpowerOf(w, tag).pool >= hull.crew) {
        const c = w.counties?.byId?.get(x.county);
        v.fleet.push({ hull: x.hull, generation: x.generation, county: x.county, province: c?.province ?? null, commissioned: clock.day });
        v.shipyard.splice(v.shipyard.indexOf(x), 1);
        day.completed.push(x.hull + ' ' + x.county);
      }
    }

    for (const s of v.fleet || []) {
      const hull = hullOf(w, s.hull);
      day.fleetUpkeep += hull?.upkeep || 0;
      day.fleetFuel += hull?.fuel || 0;
    }
    for (const [key, n] of Object.entries(v.stockpile || {})) {
      const [id, g] = key.split(':');
      const item = itemOf(w, id);
      if (item) day.stockpileStorage += (equipment.storage || 0) * genCost(item.points, Number(g), equipment.costPerGeneration) * n;
    }
    out.set(tag, day);
  }
  if (changed) worldChanged();
  return out;
}

// Last day's spending, draws and completions per polity, read by the treasury, resources and the console.
live.lastProduction = new Map();
everyDay((w) => { live.lastProduction = dailyProduction(w); });

// What a polity has queued, held and in service, for the console.
function queuesOf(w, tag) {
  const v = valuesOf(w, tag);
  const pct = (a, b) => Math.round(100 * a / b);
  return {
    construction: v.construction.map((x, i) => ({ index: i, project: x.project, where: x.county || x.province, done: pct(x.progress, x.total) + '%', points: Math.round(x.total) })),
    production: v.production.map((x, i) => {
      const item = itemOf(w, x.item);
      return { index: i, item: x.item, generation: x.generation, built: `${x.done}/${x.count}`, next: pct(x.progress, genCost(item.points, x.generation)) + '%' };
    }),
    shipyard: v.shipyard.map((x, i) => {
      const hull = hullOf(w, x.hull);
      return { index: i, hull: x.hull, generation: x.generation, county: x.county, done: pct(x.progress, genCost(hull.points, x.generation)) + '%' };
    }),
  };
}

export { MEDIAN_PROVINCE_KM2, ROAD_CONSTRUCTION, ELECTRICITY_CONSTRUCTION, RESEARCHED_GENERATION, provinceGround, countyShore, queueConstruction, queueEquipment, queueShip, cancelQueued, dailyProduction, queuesOf, genCost };
