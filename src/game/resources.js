// Resources each day: yields, power, fuel, synthesis, base demand, food, reserves and shortages.

const VERSION = new URL(import.meta.url).search;
const { UNOWNED } = await import(`../world/mapdata.js${VERSION}`);
const { CLOCK_EPOCH, DAY_MS, clock, everyDay, invalidateView, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let ALWAYS_FULL, FLOOR, PIT, buildResourceLines, builtLevel, connectedOf, developmentOf, developmentPitOf, nationalModifier, occupationEfficiencyOf, occupiedFraction, reparationsDue;
export function link(all) { ({ ALWAYS_FULL, FLOOR, PIT, buildResourceLines, builtLevel, connectedOf, developmentOf, developmentPitOf, nationalModifier, occupationEfficiencyOf, occupiedFraction, reparationsDue } = all); }

// Power a unit of each fuel makes; timber counts its household share.
const COAL_POWER = 1.5;
const GAS_POWER = 2.25;
// Fuel a unit of oil makes.
const OIL_FUEL = 2;
const TIMBER_POWER = 0.1;

// Food: people one food feeds, and each kind's demand a person.
const PEOPLE_PER_FOOD = 350000;
const PER_PERSON = { fertileLand: 1.4e-6, livestock: 0.45e-6, fish: 0.3e-6, gold: 0.02e-6 };
// Fish demand by where the people live.
const FISH_TIER = { coastal: 1, city: 0.6, none: 0.4 };
// Nitrates a day per fertile land deposit, and the share of the harvest that needs none.
const FERTILISER = 0.02;
const UNFERTILISED = 0.6;

// Happiness lost at no supply at all.
const FOOD_HAPPINESS = { calories: 20, fertileLand: 4, livestock: 4, fish: 4 };
const GOODS_HAPPINESS = 10;
const GOLD_HAPPINESS = 3;

// How far a shortage can be absorbed before it bites.
const SHORTAGE_K = {
  iron: 1.5, aluminium: 1, nitrates: 1, oil: 1, fuel: 1, fertileLand: 1, livestock: 1, fish: 1, consumerGoods: 1,
  tazkuri: 1, rubber: 2, baul: 3, rareMetals: 3, coal: 3, baseMetals: 4, timber: 4, tungsten: 5, naturalGas: 5,
  gold: 5, textiles: 6,
};

// Reserve: days of the larger of demand and yield it holds, and $ a day a unit held.
const RESERVE_DAYS = 180;
const RESERVE_STORAGE = 0.02;

// Share of a thing lost at a shortfall, on the shortage curve.
const lostAt = (shortfall, k) => (k ? (Math.exp(k * shortfall) - 1) / (Math.exp(k) - 1) : 0);

// Province ids that hold a city.
let cityWorld = null, cityProvinces = new Set();
function hasCity(w, id) {
  if (cityWorld !== w) { cityProvinces = new Set((w.cities || []).map((c) => c.province)); cityWorld = w; }
  return cityProvinces.has(id);
}

// What one province yields of each kind at its development, before modifiers.
function provinceYields(w, p, st) {
  const out = {};
  const held = w.resources?.[p.id];
  if (!held) return out;
  const dev = developmentOf(w, p, st);
  const devPit = developmentPitOf(w, p, st);
  const connected = connectedOf(w, p);
  for (const kind of w.resourceKinds || []) {
    const amount = held[kind];
    if (typeof amount !== 'number' || amount <= 0) continue;
    out[kind] = ALWAYS_FULL.has(kind) ? (connected ? amount : 0)
      : amount * Math.max(FLOOR[kind] ?? 0, PIT.has(kind) ? devPit : dev);
  }
  return out;
}

// What a province yields of each kind for its owner: development, the owner's modifiers and yesterday's nitrates.
function heldYields(w, p, st) {
  const nitrateKept = live.lastSupply?.get(p.owner)?.kept?.nitrates ?? 1;
  const out = {};
  for (const [kind, n] of Object.entries(provinceYields(w, p, st))) {
    const mod = Math.max(0, 1 + nationalModifier(w, p.owner, 'resourceYield.' + kind)
      + nationalModifier(w, p.owner, 'targetYield.' + kind)) * (kind === 'fertileLand' ? UNFERTILISED + (1 - UNFERTILISED) * nitrateKept : 1);
    out[kind] = n * mod;
  }
  return out;
}

// Whether a lease or agreement is in force today: begun, not ended, and its two parties not at war with each other.
function inForce(w, x) {
  const today = CLOCK_EPOCH + clock.day * DAY_MS;
  const ends = x.until === undefined ? Infinity : typeof x.until === 'number' ? Date.UTC(x.until, 0, 1) : Date.parse(x.until);
  if (ends <= today || Date.parse(x.since) >= today) return false;
  return !(w.polityValues?.[x.first]?.atWar || []).includes(x.second) && !(w.polityValues?.[x.second]?.atWar || []).includes(x.first);
}

// Leases in force today: until a date, or 1 January of a year for those signed before the start.
function activeLeases(w) {
  return (w.government?.relations?.relations || []).filter((x) => x.band === 'lease' && inForce(w, x));
}

// State agreements in force today, until their end where they have one.
function activeAgreements(w) {
  return (w.government?.relations?.relations || []).filter((x) => x.band === 'stateAgreement' && inForce(w, x));
}

// What a state agreement asks in return, a day: $ under money and goods by name; nothing is lend lease.
function agreementPrice(x) {
  return typeof x.price === 'number' ? { money: x.price } : { ...(x.price || {}) };
}

// Shipments: what a lease or state agreement sends gathers with the sender and is sent every so many days.
const SHIPMENT_DAYS = 30;
const shipmentKey = (x) => [x.band, x.first, x.second, x.province || '', x.good || x.resource || ''].join('|');
// Whether a lease or agreement sends today; each keeps its own day of the interval.
function shipmentDue(x) {
  const every = x.every ?? SHIPMENT_DAYS;
  let h = 0;
  for (const c of shipmentKey(x)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (clock.day + (h % every)) % every === 0;
}
// Days gathered for the shipment sent today: since the last one, the start, its signing or its last day out of force.
function shipmentDays(w, x) {
  const signed = Math.floor((Date.parse(x.since) - CLOCK_EPOCH) / DAY_MS) || 0;
  const from = Math.max(0, signed, w.shipmentStops?.[shipmentKey(x)] ?? 0);
  return Math.max(0, Math.min(x.every ?? SHIPMENT_DAYS, clock.day - from));
}

// One day of every country's resources.
function dailySupply(w, settle = false) {
  const prior = live.lastSupply || new Map();
  const out = new Map();
  const of = (id) => {
    if (!out.has(id)) {
      out.set(id, {
        yields: {}, demand: {}, people: 0, fedPeople: 0, fishDemand: 0, powerDemand: 0, freePower: 0,
        coalPlants: 0, rubberPlants: 0, factories: 0,
      });
    }
    return out.get(id);
  };
  const add = (bag, k, n) => { if (n) bag[k] = (bag[k] || 0) + n; };
  const projects = Object.fromEntries((w.production?.construction?.projects || []).map((x) => [x.id, x]));
  const factoryDemand = projects.civilianFactory?.baseDemand || {};
  const levelDemand = (k) => projects[k]?.baseDemand || {};
  const railDemand = projects.rail?.baseDemand || {};
  const buildings = Object.values(projects).filter((x) => x.building);
  const coverOf = (id) => prior.get(id)?.power?.cover ?? 1;
  const local = new Map();   // unconnected province id -> its own food met
  const leased = new Map();  // province id -> leases on its deposits
  for (const x of activeLeases(w)) leased.set(x.province, [...(leased.get(x.province) || []), x]);
  // Goods gathered for a shipment, by lease or agreement and kind; only on a real day.
  const gather = (x, part, kind, n, to) => {
    if (!settle || !n) return;
    const s = ((w.shipments ||= {})[shipmentKey(x) + '|' + part + '|' + kind] ||= { to, kind, n: 0 });
    s.n += n;
  };

  for (const p of w.table?.provinces || []) {
    const st = w.stats?.[p.id];
    if (!st || !p.owner || p.owner === UNOWNED) continue;
    const b = of(p.owner);
    const occupied = occupiedFraction(w, p);
    const efficiency = occupied > 0 && p.occupier ? occupied * occupationEfficiencyOf(w, p) : 0;
    const yields = heldYields(w, p, st);
    // Leased units yield at the province's development and gather for the lessee's shipment.
    for (const x of leased.get(p.id) || []) {
      const units = w.resources?.[p.id]?.[x.resource] || 0;
      const n = yields[x.resource] || 0;
      if (x.first !== p.owner || !units || !n) continue;
      const share = n * Math.min(1, x.amount / units);
      yields[x.resource] = n - share;
      gather(x, 'goods', x.resource, share * (1 - occupied), x.second);
    }
    for (const [kind, n] of Object.entries(yields)) {
      add(b.yields, kind, n * (1 - occupied));
      if (efficiency) add(of(p.occupier).yields, kind, n * efficiency);
    }
    const hydro = (st.hydroPotential || 0) * developmentOf(w, p, st);
    b.freePower += hydro * (1 - occupied);
    if (efficiency) of(p.occupier).freePower += hydro * efficiency;

    // People: food only where the province is connected, else on its own figures.
    const people = st.population || 0;
    b.people += people;
    const tier = w.coastal?.has(p.id) ? FISH_TIER.coastal : hasCity(w, p.id) ? FISH_TIER.city : FISH_TIER.none;
    if (connectedOf(w, p)) {
      b.fedPeople += people;
      b.fishDemand += people * PER_PERSON.fish * tier;
    } else if (people) {
      const own = w.resources?.[p.id] || {};
      const met = (supply, demand) => (demand > 0 ? Math.min(1, supply / demand) : 1);
      local.set(p.id, {
        calories: met((own.fertileLand || 0) + (own.livestock || 0) + (own.fish || 0), people / PEOPLE_PER_FOOD),
        fertileLand: met(own.fertileLand || 0, people * PER_PERSON.fertileLand),
        livestock: met(own.livestock || 0, people * PER_PERSON.livestock),
        fish: met(own.fish || 0, people * PER_PERSON.fish * tier),
        fishTier: tier,
      });
    }

    // Base demand of what is built here.
    const factories = (st.civilianFactories || 0) + (st.militaryFactories || 0);
    b.factories += factories;
    for (const [k, n] of Object.entries(factoryDemand)) add(b.demand, k, n * factories);
    for (const k of ['road', 'electricity', 'radar', 'supplyHub', 'antiAir', 'airBase']) {
      const level = builtLevel(st, k);
      if (!level) continue;
      for (const [r, n] of Object.entries(levelDemand(k))) add(b.demand, r, n * level);
      b.powerDemand += level * (projects[k]?.power || 0);
    }
    add(b.demand, 'nitrates', FERTILISER * (w.resources?.[p.id]?.fertileLand || 0));
  }

  // Rail and the plants, county by county.
  for (const c of w.counties?.byId?.values() || []) {
    const p = w.byId?.get(c.province);
    if (!p?.owner || p.owner === UNOWNED) continue;
    const b = of(p.owner);
    if (c.rail !== undefined) for (const [k, n] of Object.entries(railDemand)) add(b.demand, k, n);
    for (const [k, n] of Object.entries(projects.fortification?.baseDemand || {})) add(b.demand, k, n * (c.fortification || 0));
    for (const x of buildings) if (c[x.building]) for (const [k, n] of Object.entries(x.baseDemand || {})) add(b.demand, k, n);
    for (const kind of ['syntheticOil', 'syntheticRubber']) {
      if (!c[kind]) continue;
      const conv = projects[kind]?.converts;
      if (!conv) continue;
      const st = w.stats?.[p.id] || {};
      const made = conv.output * (1 + 0.025 * builtLevel(st, 'electricity') * coverOf(p.owner)
        + 0.1 * Math.min(5, st.militaryFactories || 0)) * (1 - occupiedFraction(w, p));
      if (kind === 'syntheticOil') b.coalPlants += made;
      else b.rubberPlants += made;
    }
  }

  // Reparations in kind: taken from the payer's yield and divided among the victors.
  for (const due of reparationsDue(w)) {
    const payer = out.get(due.payer);
    for (const [kind, owed] of Object.entries(due.resources)) {
      const given = due.suspended ? 0 : Math.min(owed, payer?.yields?.[kind] || 0);
      if (payer && given) payer.yields[kind] -= given;
      for (const [to, share] of Object.entries(due.to)) if (given) add(of(to).yields, kind, given * share);
      if (settle) {
        const term = due.terms.resources[kind];
        term.outstanding = Math.max(0, term.outstanding - given);
        term.arrears = (term.arrears || 0) + (owed - given);
      }
    }
  }

  // State agreements in a resource: set aside from the supplier's yield for the receiver's shipment, as much as it has.
  for (const x of activeAgreements(w).filter((y) => (w.resourceKinds || []).includes(y.good))) {
    const given = Math.min(x.amount || 0, out.get(x.first)?.yields?.[x.good] || 0);
    if (!given) continue;
    out.get(x.first).yields[x.good] -= given;
    gather(x, 'goods', x.good, given, x.second);
  }
  // A price in goods: set aside from the receiver's yield for the supplier.
  for (const x of activeAgreements(w)) {
    for (const [kind, n] of Object.entries(agreementPrice(x))) {
      if (kind === 'money' || !(w.resourceKinds || []).includes(kind)) continue;
      const given = Math.min(n, out.get(x.second)?.yields?.[kind] || 0);
      if (!given) continue;
      out.get(x.second).yields[kind] -= given;
      gather(x, 'price', kind, given, x.first);
    }
  }
  // Rent in kind: set aside from the lessee's yield for the lessor.
  for (const x of activeLeases(w)) {
    for (const [kind, n] of Object.entries(x.rent || {})) {
      if (kind === 'money') continue;
      const given = Math.min(n, out.get(x.second)?.yields?.[kind] || 0);
      if (!given) continue;
      out.get(x.second).yields[kind] -= given;
      gather(x, 'price', kind, given, x.first);
    }
  }
  // Shipments due today are sent, into the receiver's reserve.
  if (settle) {
    const held = [...activeLeases(w), ...activeAgreements(w)];
    const send = (x, back) => {
      const head = shipmentKey(x) + '|';
      for (const [k, s] of Object.entries(w.shipments || {})) {
        if (!k.startsWith(head) || !s.n) continue;
        const v = w.polityValues?.[back ? (s.to === x.first ? x.second : x.first) : s.to];
        if (v) (v.reserves ||= {})[s.kind] = (v.reserves[s.kind] || 0) + s.n;
        s.n = 0;
      }
    };
    for (const x of held) if (shipmentDue(x)) send(x, false);
    // Leases and agreements out of force: what had gathered goes back to its sender.
    const heldKeys = new Set(held.map(shipmentKey));
    for (const x of w.government?.relations?.relations || []) {
      if ((x.band !== 'lease' && x.band !== 'stateAgreement') || heldKeys.has(shipmentKey(x))) continue;
      (w.shipmentStops ||= {})[shipmentKey(x)] = clock.day;
      send(x, true);
    }
    // War between the parties ends a lease or agreement for good.
    const atWar = (x) => (w.polityValues?.[x.first]?.atWar || []).includes(x.second) || (w.polityValues?.[x.second]?.atWar || []).includes(x.first);
    const rel = w.government?.relations;
    if (rel?.relations) rel.relations = rel.relations.filter((x) => !((x.band === 'lease' || x.band === 'stateAgreement') && atWar(x)));
  }

  for (const [id, b] of out) {
    const values = w.polityValues?.[id] || {};
    const industry = live.lastIndustry?.get(id) || {};
    const made = live.lastProduction?.get(id) || {};
    const rates = values.reserveRates || {};
    const held = values.reserves || (values.reserves = {});

    // People and the work in hand.
    // The public's gold follows what it can afford, as consumer goods do.
    add(b.demand, 'gold', (industry.spenders ?? b.people) * PER_PERSON.gold);
    for (const [k, n] of Object.entries(industry.materials || {})) add(b.demand, k, n);
    for (const [k, n] of Object.entries(made.wanted || {})) add(b.demand, k, n);
    add(b.demand, 'fuel', made.fleetFuel || 0);
    add(b.yields, 'consumerGoods', industry.goods || 0);
    add(b.demand, 'consumerGoods', industry.demand || 0);

    // Reserves: store a surplus up to the rate, release on a negative rate, draw automatically when short.
    const settle = (kind, available, demand) => {
      const reserve = held[kind] || 0;
      const rate = rates[kind] || 0;
      const cap = RESERVE_DAYS * Math.max(demand, available);
      const surplus = Math.max(0, available - demand);
      const stored = rate > 0 ? Math.max(0, Math.min(rate, surplus, cap - reserve)) : 0;
      const released = rate < 0 ? Math.min(-rate, reserve) : 0;
      const drawn = Math.min(reserve - released, Math.max(0, demand - available - released));
      held[kind] = reserve + stored - released - drawn;
      if (!held[kind]) delete held[kind];
      return available - stored + released + drawn;
    };
    const supply = {};
    const shortfall = {};
    const kept = {};
    const balance = (kind, available, demand) => {
      supply[kind] = settle(kind, available, demand);
      shortfall[kind] = demand > 0 ? 1 - Math.min(1, supply[kind] / demand) : 0;
      kept[kind] = 1 - lostAt(shortfall[kind], SHORTAGE_K[kind]);
      return demand > 0 ? Math.min(1, supply[kind] / demand) : 1;
    };

    // Power: hydro and timber first, then gas, then coal.
    const free = b.freePower + TIMBER_POWER * (b.yields.timber || 0);
    const need = Math.max(0, b.powerDemand - free);
    const gasForPower = Math.min(need / GAS_POWER, (b.yields.naturalGas || 0) + (held.naturalGas || 0));
    add(b.demand, 'naturalGas', gasForPower);
    const coalForPower = (need - gasForPower * GAS_POWER) / COAL_POWER;
    add(b.demand, 'coal', coalForPower);
    const coalPlants = b.coalPlants * (projects.syntheticOil?.converts?.per || 0);
    add(b.demand, 'coal', coalPlants);
    const oilPlants = b.rubberPlants * (projects.syntheticRubber?.converts?.per || 0);
    add(b.demand, 'oil', oilPlants + (b.demand.fuel || 0) / OIL_FUEL);

    const gasShare = balance('naturalGas', b.yields.naturalGas || 0, b.demand.naturalGas || 0);
    const coalShare = balance('coal', b.yields.coal || 0, b.demand.coal || 0);
    const oilShare = balance('oil', b.yields.oil || 0, b.demand.oil || 0);
    const supplied = free + gasForPower * gasShare * GAS_POWER + coalForPower * coalShare * COAL_POWER;
    const power = { demand: b.powerDemand, supplied: Math.min(supplied, b.powerDemand), free, cover: b.powerDemand > 0 ? Math.min(1, supplied / b.powerDemand) : 1 };

    // Fuel from oil one for one and from coal through synthesis; synthetic rubber from oil.
    const syntheticFuel = b.coalPlants * coalShare;
    const syntheticRubber = b.rubberPlants * oilShare;
    const realFuel = (b.demand.fuel || 0) * oilShare;
    add(b.yields, 'fuel', realFuel + syntheticFuel);
    add(b.yields, 'rubber', syntheticRubber);
    const synthetic = {
      fuel: b.demand.fuel ? Math.min(syntheticFuel, Math.max(0, b.demand.fuel - realFuel)) / b.demand.fuel : 0,
      rubber: b.demand.rubber ? Math.min(syntheticRubber, Math.max(0, b.demand.rubber - (b.yields.rubber - syntheticRubber))) / b.demand.rubber : 0,
    };

    // Food: calories decide hunger, each kind decides how well a country eats.
    add(b.demand, 'fertileLand', b.fedPeople * PER_PERSON.fertileLand);
    add(b.demand, 'livestock', b.fedPeople * PER_PERSON.livestock);
    add(b.demand, 'fish', b.fishDemand);

    const met = {};
    for (const kind of Object.keys({ ...b.yields, ...b.demand })) {
      if (kind === 'naturalGas' || kind === 'coal' || kind === 'oil') continue;
      met[kind] = balance(kind, b.yields[kind] || 0, b.demand[kind] || 0);
    }
    const calories = b.fedPeople / PEOPLE_PER_FOOD;
    const fed = (supply.fertileLand || 0) + (supply.livestock || 0) + (supply.fish || 0);
    met.calories = calories > 0 ? Math.min(1, fed / calories) : 1;
    // A hungry country minds only the hunger; the kinds count once it is fed.
    const wellFed = met.calories >= 1 ? 1 : 0;
    const happiness = {
      hunger: -FOOD_HAPPINESS.calories * (1 - met.calories),
      'crop shortage': -FOOD_HAPPINESS.fertileLand * (1 - (met.fertileLand ?? 1)) * wellFed,
      'meat shortage': -FOOD_HAPPINESS.livestock * (1 - (met.livestock ?? 1)) * wellFed,
      // Fish is measured against what a coastal population would owe, so a lower demand inland costs less.
      'fish shortage': b.fedPeople ? -FOOD_HAPPINESS.fish * Math.max(0, b.fishDemand - (supply.fish || 0)) / (b.fedPeople * PER_PERSON.fish) * wellFed : 0,
      'consumer goods shortage': -GOODS_HAPPINESS * (1 - (kept.consumerGoods ?? 1)),
      'gold shortage': -GOLD_HAPPINESS * (1 - (kept.gold ?? 1)),
    };

    const storage = RESERVE_STORAGE * Object.values(held).reduce((a, n) => a + n, 0);
    out.set(id, {
      yields: b.yields, demand: b.demand, supply, shortfall, kept, met, reserves: { ...held }, power, synthetic,
      fuel: { real: realFuel, synthetic: syntheticFuel }, happiness, storage, people: b.people,
    });
  }
  out.local = local;
  return out;
}

// Food happiness lost in a province: its country's, or its own when it is unconnected.
function foodHappiness(w, p) {
  const own = live.lastSupply?.local?.get(p.id);
  if (own) {
    const wellFed = own.calories >= 1 ? 1 : 0;
    return {
      hunger: -FOOD_HAPPINESS.calories * (1 - own.calories),
      'crop shortage': -FOOD_HAPPINESS.fertileLand * (1 - own.fertileLand) * wellFed,
      'meat shortage': -FOOD_HAPPINESS.livestock * (1 - own.livestock) * wellFed,
      'fish shortage': -FOOD_HAPPINESS.fish * (1 - own.fish) * own.fishTier * wellFed,
      'consumer goods shortage': live.lastSupply?.get(p.owner)?.happiness?.['consumer goods shortage'] || 0,
      'gold shortage': live.lastSupply?.get(p.owner)?.happiness?.['gold shortage'] || 0,
    };
  }
  return live.lastSupply?.get(p.owner)?.happiness || null;
}

// Last day's resources per country, read by industry, production, happiness, the treasury and the console.
live.lastSupply = new Map();
everyDay((w) => {
  const before = live.lastSupply;
  live.lastSupply = dailySupply(w, true);
  // Fertile land on the resource layer follows nitrate cover.
  const moved = [...live.lastSupply].some(([id, s]) => Math.abs((s.kept.nitrates ?? 1) - (before.get(id)?.kept?.nitrates ?? 1)) > 0.005);
  if (moved) { w.resourceLines = buildResourceLines(w); invalidateView(); }
});

export { COAL_POWER, GAS_POWER, OIL_FUEL, TIMBER_POWER, PEOPLE_PER_FOOD, PER_PERSON, FISH_TIER, FERTILISER, UNFERTILISED, FOOD_HAPPINESS, GOODS_HAPPINESS, GOLD_HAPPINESS, SHORTAGE_K, RESERVE_DAYS, RESERVE_STORAGE, lostAt, SHIPMENT_DAYS, shipmentKey, shipmentDue, shipmentDays, activeLeases, activeAgreements, agreementPrice, provinceYields, heldYields, dailySupply, foodHappiness };
