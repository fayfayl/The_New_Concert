// Construction, equipment, ship and research points and consumer goods: what each country makes each day.

const VERSION = new URL(import.meta.url).search;
const { UNOWNED } = await import(`../world/mapdata.js${VERSION}`);
const { CLOCK_EPOCH, DAY_MS, clock, everyDay, finish, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let actEffect, debtRatio, happinessOf, lawsFor, nationalModifier, nationalParts, occupiedFraction, stabilityOf;
export function link(all) { ({ actEffect, debtRatio, happinessOf, lawsFor, nationalModifier, nationalParts, occupiedFraction, stabilityOf } = all); }

const ELECTRICITY_OUTPUT = 0.025;        // per level, on everything a factory makes
const UNREST_OUTPUT = 0.01;              // lost per 10 unrest
const UNREST_CONSTRUCTION = [[70, 0], [40, 0.8]];   // unrest at or above: construction kept
const GOODS_PER_PERSON = 1 / 2500000;    // consumer goods a day each person wants, at happiness 50
const OCCUPATION_EFFICIENCY = 0.6;       // what occupied ground yields its occupier, before modifiers
// Dockyard: ship points a day, and what each level or factory in its province adds.
const DOCKYARD_POINTS = 2;
const DOCKYARD_ELECTRICITY = 0.025;
const DOCKYARD_MILITARY = 0.1;
const DOCKYARD_MILITARY_CAP = 5;
const DOCKYARD_SUPPLY_HUB = 0.025;
// Construction lost as debt passes each multiple of a year's revenue.
const DEBT_CONSTRUCTION = [[2, -0.25], [1, -0.1]];
// Research: electrified people per point, and the electrified population at which each slot opens.
const RESEARCH_PEOPLE = 2000000;
const RESEARCH_SLOTS = [[20000000, 4], [8000000, 3], [2000000, 2], [0, 1]];
const RESEARCH_STABILITY = 250;          // stability moves research ±20%, less than factory output

// What one consumer factory draws a day.
const GOODS_MATERIALS = { textiles: 0.5, timber: 0.3, iron: 0.2 };

const sumParts = (parts, kinds) => parts.reduce((a, [, n, kind]) => a + (!kinds || kinds.includes(kind) ? n : 0), 0);

// A country's consumer share, 0 to 1: its economy law's share, moved by its ideology, less any points taken off.
function consumerShareOf(w, id) {
  const law = lawsFor(w, id).economy;
  const lawShare = w.government?.laws?.categories?.economy?.options?.find((o) => o.name === law)?.effects?.consumerShare ?? 0;
  const ideology = sumParts(nationalParts(w, id, 'consumerShare'), ['ideology']);
  const points = nationalModifier(w, id, 'consumerSharePoints');
  return Math.max(0, Math.min(1, lawShare * (1 + ideology) + points / 100));
}

// Construction lost to debt.
function debtConstruction(w, id) {
  const ratio = debtRatio(w, id);
  return DEBT_CONSTRUCTION.find(([at]) => ratio > at)?.[1] || 0;
}

// What occupied ground yields its occupier, 0 to 1.
function occupationEfficiencyOf(w, p) {
  let e = OCCUPATION_EFFICIENCY;
  for (const [, n] of actEffect(w, p, 'occupationEfficiency')) e += n;
  e += sumParts(nationalParts(w, p.occupier, 'occupationEfficiency'), ['ideology', 'spirit', 'leader']);
  return Math.max(0, Math.min(1, e));
}

// Yesterday's power cover and the shortages that cut factory output and consumer goods.
function shortagesOf(id) {
  const s = live.lastSupply?.get(id);
  const kept = s?.kept || {};
  const k = (r) => kept[r] ?? 1;
  return {
    cover: s?.power?.cover ?? 1,
    // Tungsten and fuel cost every factory half their loss: machine tools wear, and the lorries stand idle.
    factoryKept: k('coal') * k('naturalGas') * (1 - (1 - k('tungsten')) / 2) * (1 - (1 - k('fuel')) / 2),
    // Each input is its share of the goods, so a missing one costs only that share.
    goodsKept: Object.entries(GOODS_MATERIALS).reduce((a, [r, n]) => a + n * k(r), 0)
      / Object.values(GOODS_MATERIALS).reduce((a, n) => a + n, 0),
  };
}

// One day of every country's industry: construction, equipment and ship points, consumer goods and their parts.
function dailyIndustry(w) { return finish(industrySteps(w)); }

// Provinces, or countries, worked through between pauses of a day's industry.
const INDUSTRY_SLICE = 25;

// The same in steps, pausing between provinces and between countries.
function* industrySteps(w) {
  const today = new Date(CLOCK_EPOCH + clock.day * DAY_MS);
  const out = new Map();
  let worked = 0;
  const of = (id) => {
    if (!out.has(id)) out.set(id, { points: 0, goods: 0, spenders: 0, equipment: 0, ships: 0, dockyards: 0, ordered: 0, consumer: 0, military: 0, people: 0, provinces: 0, electricity: 0, electrified: 0, materials: { textiles: 0, timber: 0, iron: 0 } });
    return out.get(id);
  };
  const country = new Map();   // owner -> figures read once a day
  const figures = (id) => {
    if (!country.has(id)) {
      country.set(id, {
        share: consumerShareOf(w, id),
        output: nationalModifier(w, id, 'factoryOutput') + nationalModifier(w, id, 'civilianFactoryOutput')
          + nationalModifier(w, id, 'targetYield.manufacturing'),
        militaryOutput: nationalModifier(w, id, 'factoryOutput') + nationalModifier(w, id, 'militaryFactoryOutput'),
        militaryProduction: nationalModifier(w, id, 'militaryProduction'),
        dockyardOutput: nationalModifier(w, id, 'factoryOutput') + nationalModifier(w, id, 'dockyardOutput'),
        construction: nationalModifier(w, id, 'construction') + debtConstruction(w, id),
        stability: 1 + (stabilityOf(w, id) - 50) / 200,
        ...shortagesOf(id),
      });
    }
    return country.get(id);
  };

  const yards = new Map();   // province id -> dockyards in its counties
  for (const c of w.counties?.byId?.values() || []) if (c.dockyard) yards.set(c.province, (yards.get(c.province) || 0) + 1);

  for (const p of w.table?.provinces || []) {
    if (++worked % INDUSTRY_SLICE === 0) yield;
    const st = w.stats?.[p.id];
    if (!st || !p.owner || p.owner === UNOWNED) continue;
    const home = of(p.owner);
    home.people += st.population || 0;
    // What a province can afford follows its happiness, as tax does.
    home.spenders += (st.population || 0) * (0.5 + happinessOf(w, p, st, today).value / 100);
    home.provinces++;
    const level = Array.isArray(st.electricity) ? st.electricity[0] : Number(st.electricity) || 0;
    home.electricity += level;
    home.electrified += (st.population || 0) * level / 10;
    const civ = st.civilianFactories || 0;
    const mil = st.militaryFactories || 0;
    const docks = yards.get(p.id) || 0;
    if (!civ && !mil && !docks) continue;
    const f = figures(p.owner);
    const unrest = st.unrest || 0;
    const steady = f.stability * Math.max(0, 1 - UNREST_OUTPUT * Math.floor(unrest / 10)) * f.factoryKept;
    // What any factory here makes, before its own kind's output modifiers.
    const base = (1 + ELECTRICITY_OUTPUT * level * f.cover) * steady;
    const output = base * (1 + f.output);
    const ordered = civ * (1 - f.share);
    const consumer = civ * f.share;
    const built = UNREST_CONSTRUCTION.find(([at]) => unrest >= at)?.[1] ?? 1;
    const points = ordered * output * Math.max(0, 1 + f.construction) * built;
    const goods = consumer * output * f.goodsKept;
    const equipment = mil * base * Math.max(0, 1 + f.militaryOutput) * Math.max(0, 1 + f.militaryProduction);
    // A dockyard draws on its province's electricity, military factories and supply hub.
    const hub = Array.isArray(st.supplyHub) ? st.supplyHub[0] : Number(st.supplyHub) || 0;
    const yard = DOCKYARD_POINTS * (1 + DOCKYARD_ELECTRICITY * level * f.cover + DOCKYARD_MILITARY * Math.min(DOCKYARD_MILITARY_CAP, mil) + DOCKYARD_SUPPLY_HUB * hub);
    const ships = docks * yard * steady * Math.max(0, 1 + f.dockyardOutput) * Math.max(0, 1 + f.militaryProduction);

    // Output follows control: the owner keeps the unoccupied share, the occupier gets the rest at its efficiency.
    const occupied = occupiedFraction(w, p);
    const owner = of(p.owner);
    owner.points += points * (1 - occupied);
    owner.goods += goods * (1 - occupied);
    owner.ordered += ordered * (1 - occupied);
    owner.consumer += consumer * (1 - occupied);
    owner.equipment += equipment * (1 - occupied);
    owner.military += mil * (1 - occupied);
    owner.ships += ships * (1 - occupied);
    owner.dockyards += docks * (1 - occupied);
    for (const [k, n] of Object.entries(GOODS_MATERIALS)) owner.materials[k] += n * consumer * (1 - occupied);
    if (occupied > 0 && p.occupier) {
      const e = occupied * occupationEfficiencyOf(w, p);
      const occupier = of(p.occupier);
      occupier.points += points * e;
      occupier.goods += goods * e;
      occupier.equipment += equipment * e;
      occupier.ships += ships * e;
    }
  }
  for (const [id, b] of out) {
    if (++worked % INDUSTRY_SLICE === 0) yield;
    b.demand = b.spenders * GOODS_PER_PERSON;
    b.balance = b.goods - b.demand;
    // Research comes from people who live with power: each province's people times its electricity / 10.
    b.meanElectricity = b.provinces ? b.electricity / b.provinces : 0;
    b.research = (1 + b.electrified * shortagesOf(id).cover / RESEARCH_PEOPLE)
      * Math.max(0, 1 + nationalModifier(w, id, 'research')) * (1 + (stabilityOf(w, id) - 50) / RESEARCH_STABILITY);
    b.slots = RESEARCH_SLOTS.find(([at]) => b.electrified >= at)?.[1] ?? 1;
  }
  return out;
}

// Last day's industry per country, read by the console.
live.lastIndustry = new Map();
everyDay(function* (w) { live.lastIndustry = yield* industrySteps(w); });

export { DOCKYARD_POINTS, DOCKYARD_ELECTRICITY, DOCKYARD_MILITARY, DOCKYARD_MILITARY_CAP, DOCKYARD_SUPPLY_HUB, RESEARCH_PEOPLE, RESEARCH_SLOTS, RESEARCH_STABILITY, ELECTRICITY_OUTPUT, UNREST_OUTPUT, UNREST_CONSTRUCTION, GOODS_PER_PERSON, OCCUPATION_EFFICIENCY, DEBT_CONSTRUCTION, GOODS_MATERIALS, consumerShareOf, debtConstruction, shortagesOf, occupationEfficiencyOf, dailyIndustry, INDUSTRY_SLICE, industrySteps };
