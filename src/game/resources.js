// Resources each day: yields, power, fuel, synthesis, base demand, food, the automatic market, reserves and shortages.

const VERSION = new URL(import.meta.url).search;
const { UNOWNED } = await import(`../world/mapdata.js${VERSION}`);
const { CLOCK_EPOCH, DAY_MS, clock, everyDay, finish, forgetOnGovernment, governmentChanged, invalidateView, live, perf } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let ALWAYS_FULL, FLOOR, PIT, builtLevel, connectedOf, developmentOf, developmentPitOf, findRoute, lawsFor, nationalModifier, nationalParts, occupationEfficiencyOf, occupiedFraction, partsUnder, realmAbove, relationsBetween, reparationsDue, resourceLineSteps, routeSteps, treesBuilt;
export function link(all) { ({ ALWAYS_FULL, FLOOR, PIT, builtLevel, connectedOf, developmentOf, developmentPitOf, findRoute, lawsFor, nationalModifier, nationalParts, occupationEfficiencyOf, occupiedFraction, partsUnder, realmAbove, relationsBetween, reparationsDue, resourceLineSteps, routeSteps, treesBuilt } = all); }

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
// A share of food met within this of whole counts as whole.
const MET_EPSILON = 1e-9;
const metShare = (supply, demand) => (demand > 0 && supply / demand < 1 - MET_EPSILON ? supply / demand : 1);
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
// Goods gathered for a shipment, by lease or agreement, part and kind, with what gathered today; stock: items for the stockpile.
function gatherShipment(w, x, part, kind, n, to, stock = false) {
  if (!n) return;
  const s = ((w.shipments ||= {})[shipmentKey(x) + '|' + part + '|' + kind] ||= { to, kind, n: 0 });
  if (s.day !== clock.day) { s.day = clock.day; s.today = 0; }
  s.n += n;
  s.today += n;
  if (stock) s.stock = true;
}
// Shipping terms: under CIF, the default, a shipment's sender pays its bunkering and tariffs; under FOB its receiver.
const SHIPPING_TERMS = ['CIF', 'FOB'];
const shippingPayer = (x, from, to) => (x.terms === 'FOB' ? to : from);
// What a shipment is sent under, as the routes layer names it.
const shipmentVia = (x) => (x.band === 'lease' ? 'lease' : Object.values(agreementPrice(x)).some((n) => n > 0) ? 'state agreement' : 'lend lease');
// The good a shipment's route is found and taxed for: equipment by its type, not its generation.
const shipmentGood = (kind) => String(kind).split(':')[0];
// Sets the shipping terms of every lease and agreement between two countries, or those of one good, resource or province.
function setShippingTerms(w, first, second, terms, what = null) {
  if (!SHIPPING_TERMS.includes(terms)) throw new Error(`terms are ${SHIPPING_TERMS.join(' or ')}, not "${terms}"`);
  const list = (w.government?.relations?.relations || []).filter((x) => (x.band === 'lease' || x.band === 'stateAgreement')
    && x.first === first && x.second === second && (what === null || [x.good, x.resource, x.province].includes(what)));
  if (!list.length) throw new Error(`no lease or state agreement from "${first}" to "${second}"${what === null ? '' : ' in "' + what + '"'}`);
  for (const x of list) x.terms = terms;
  return list.map((x) => ({ band: x.band, good: x.good || x.resource, province: x.province, terms: x.terms }));
}

// A state agreement from today for so many years: first supplies second with amount of a good a day, for price $ a day or goods by name.
function addAgreement(w, first, second, good, amount, price = 0, years = 5) {
  for (const id of [first, second]) if (!w.table?.polityById?.has(id)) throw new Error(`no polity "${id}"`);
  if (first === second) throw new Error('a country cannot supply itself');
  const goods = [...(w.resourceKinds || []), 'consumerGoods', ...equipmentIds(w)];
  if (!goods.includes(good)) throw new Error(`no good "${good}"; one of ${goods.join(', ')}`);
  if (!(amount > 0)) throw new Error('amount must be above 0');
  const today = CLOCK_EPOCH + clock.day * DAY_MS, d = new Date(today);
  const x = {
    band: 'stateAgreement', first, second, good, amount, price,
    since: new Date(today - DAY_MS).toISOString().slice(0, 10),
    until: new Date(Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10),
  };
  ((w.government.relations ||= {}).relations ||= []).push(x);
  governmentChanged(new Set([first, second]));
  return x;
}

// Goods state-regulated in every country, moved only by state agreement.
const STATE_REGULATED = new Set(['tazkuri', 'goizederium']);
// A state-owned industry's good where its name is not one.
const OWNED_GOOD = { manufacturing: 'consumerGoods' };
// The three kinds of food.
const FOOD_KINDS = ['fertileLand', 'livestock', 'fish'];
// Smallest amount the market moves.
const TRADE_EPSILON = 1e-6;

// Goods on the automatic market: every resource but the state-regulated ones, and consumer goods.
const tradedKinds = (w) => [...(w.resourceKinds || []).filter((k) => !STATE_REGULATED.has(k)), 'consumerGoods'];

// Goods some act, spirit, leader or ideology names in a surplusOffered map.
const offerMapsBy = new WeakMap();
function offerMapped(w) {
  const g = w.government || {};
  if (!offerMapsBy.has(g)) {
    const kinds = new Set();
    for (const x of [...(g.spirits?.spirits || []), ...(g.policies?.policies || []), ...(g.decrees?.decrees || []), ...(g.leaders?.leaders || []), ...(g.ideologies?.ideologies || [])]) {
      const m = x?.effects?.surplusOffered;
      if (m && typeof m === 'object') for (const k of Object.keys(m)) kinds.add(k);
    }
    offerMapsBy.set(g, kinds);
  }
  return offerMapsBy.get(g);
}

// A country's trade law and what else moves it: share of a surplus offered per good, share of a deficit filled, goods its state owns.
function tradeTerms(w, id) {
  const law = w.government?.laws?.categories?.trade?.options?.find((o) => o.name === lawsFor(w, id).trade)?.effects || {};
  const others = (key) => nationalParts(w, id, key).reduce((a, [, n, kind]) => (kind === 'law' ? a : a + n), 0);
  const offerBase = law.surplusOffered ?? 0;
  const offerFlat = offerBase ? others('surplusOffered') : 0;
  const owned = new Set([...(realmAbove(w, id)?.stateOwned || []), ...(w.government?.byPolity?.get(id)?.stateOwned || [])].map((i) => OWNED_GOOD[i] || i));
  const mapped = offerMapped(w);
  const offers = {};
  return {
    owns: (kind) => owned.has(kind),
    offer: (kind) => (offers[kind] ??= offerBase && !owned.has(kind) && !STATE_REGULATED.has(kind)
      ? Math.min(1, Math.max(0, offerBase * (1 + offerFlat + (mapped.has(kind) ? others('surplusOffered.' + kind) : 0)))) : 0),
    fill: law.deficitFilled ? Math.max(0, law.deficitFilled + others('deficitFilled')) : 0,
  };
}

// Trade terms kept per country until its government or its realm's changes.
const termsBy = new WeakMap();
function tradeTermsOf(w, id) {
  if (!termsBy.has(w)) termsBy.set(w, new Map());
  const held = termsBy.get(w);
  const sig = JSON.stringify([lawsFor(w, id).trade, ...[w.government?.byPolity?.get(id), realmAbove(w, id)]
    .map((g) => g && [g.form, g.startingIdeology, g.leader, g.spirits, g.policies, g.decrees, g.fading, g.stateOwned])]);
  if (held.get(id)?.[0] !== sig) held.set(id, [sig, tradeTerms(w, id)]);
  return held.get(id)[1];
}

// Route cost of a stop in points, and $ a point is worth on a unit of cargo.
const STOP_POINTS = 800;
const POINT_DOLLARS = 0.1;
// $ a unit of each traded good is worth.
const GOODS_VALUE = {
  naturalGas: 330, coal: 1200, timber: 1500, iron: 1900, oil: 3000,
  fertileLand: 4000, nitrates: 4000, livestock: 5700, fish: 5700,
  baseMetals: 11500, rubber: 19000, baul: 19000, textiles: 16000, consumerGoods: 20000,
  aluminium: 32000, tungsten: 49000, rareMetals: 49000, gold: 1000000,
};
// Coal and oil a route burns; to follow the cargo origin's Oil-fired shipping research, not yet in the tree.
const COAL_SHARE = 0.7;
const OIL_SHARE = 0.3;
// Fuel burnt at a stop for each unit of cargo.
const STOP_FUEL = 0.01;
// Product classes a tariff or a ceiling names.
const TARIFF_CLASSES = ['resources', 'equipment', 'consumerGoods'];
// A target no tariff names, read as any country.
const ANY = '\0';

// Equipment types a tariff may name.
const equipmentIds = (w) => (Array.isArray(w.production?.equipment?.items) ? w.production.equipment.items : Object.values(w.production?.equipment?.items || {})).map((x) => x.id);
// Each product's class, per world.
const classesBy = new WeakMap();
function productClass(w, product) {
  if (!classesBy.has(w)) {
    classesBy.set(w, new Map([...(w.resourceKinds || []).map((k) => [k, 'resources']), ...equipmentIds(w).map((k) => [k, 'equipment']), ['consumerGoods', 'consumerGoods']]));
  }
  return classesBy.get(w).get(product) || null;
}
// Every product a tariff may name.
const tariffGoods = (w) => [...(w.resourceKinds || []), ...equipmentIds(w), 'consumerGoods'];
// The goods a product, a class or everything covers.
const coveredBy = (w, product) => (product === 'all' ? tariffGoods(w)
  : TARIFF_CLASSES.includes(product) ? tariffGoods(w).filter((k) => productClass(w, k) === product) : [product]);

// Highest rate a country may charge on each class: its trade law's, or what a spirit, policy or decree gives that class instead.
function tariffCeilings(w, id) {
  const gov = w.government?.byPolity?.get(id) || {};
  const laws = lawsFor(w, id);
  const law = w.government?.laws?.categories?.trade?.options?.find((o) => o.name === laws.trade)?.effects?.tariffCeiling;
  const out = {};
  for (const c of TARIFF_CLASSES) {
    const given = partsUnder(w, gov, realmAbove(w, id), laws, 'tariffCeiling.' + c).filter(([, , kind]) => kind !== 'law').map(([, n]) => n);
    out[c] = given.length ? Math.min(...given) : typeof law === 'number' ? law : 0;
  }
  return out;
}
// The ceiling on a product, a class or everything; everything takes the highest class's.
const ceilingOn = (w, ceilings, product) => (product === 'all' ? Math.max(...Object.values(ceilings))
  : ceilings[TARIFF_CLASSES.includes(product) ? product : productClass(w, product)] ?? 0);

// A charging country's rate on a seller's good: the narrowest entry, a country before every country, a good before its class before everything.
function tariffRate(w, entry, seller, kind) {
  const cls = productClass(w, kind);
  for (const t of [seller, 'all']) {
    for (const p of [kind, cls, 'all']) {
      const n = entry.rates.get(t + '|' + p);
      if (n !== undefined) return Math.min(n, entry.ceilings[cls] ?? 0);
    }
  }
  return 0;
}

// Every country's tariffs as charged: rates clamped to their ceilings.
function tariffIndex(w) { return finish(tariffIndexSteps(w)); }

// Countries worked through between pauses of the tariffs.
const TARIFF_SLICE = 10;

// The same in steps, pausing between countries.
function* tariffIndexSteps(w) {
  const index = new Map();
  let worked = 0;
  for (const [id, gov] of w.government?.byPolity || []) {
    if (!gov.tariffs?.length) continue;
    if (++worked % TARIFF_SLICE === 0) yield;
    const ceilings = tariffCeilings(w, id);
    for (const x of gov.tariffs) x.rate = Math.max(0, Math.min(x.rate, ceilingOn(w, ceilings, x.product)));
    index.set(id, { ceilings, rates: new Map(gov.tariffs.map((x) => [x.target + '|' + x.product, x.rate])) });
  }
  return index;
}
// The index in force, rebuilt by each market and after any change.
let tariffsHeld = null;
forgetOnGovernment(() => { tariffsHeld = null; });
function tariffsToday(w) {
  if (tariffsHeld?.w !== w) tariffsHeld = { w, index: tariffsFresh(w) };
  return tariffsHeld.index;
}
// The same in steps where it is not held.
function* tariffsTodaySteps(w) {
  if (tariffsHeld?.w !== w) {
    const index = yield* tariffsFreshSteps(w);
    tariffsHeld = { w, index };
  }
  return tariffsHeld.index;
}
// The index rebuilt, the last one kept with its rates where every ceiling and rate is the same.
let tariffsKept = null;
function tariffsFresh(w) { return finish(tariffsFreshSteps(w)); }

// The same in steps.
function* tariffsFreshSteps(w) {
  const index = yield* tariffIndexSteps(w);
  const parts = [];
  let worked = 0;
  for (const [id, x] of index) {
    if (++worked % TARIFF_SLICE === 0) yield;
    parts.push(id + ':' + Object.values(x.ceilings).join('/') + ':' + [...x.rates].join(';'));
  }
  const sig = parts.join('#');
  if (tariffsKept?.w !== w || tariffsKept.sig !== sig) tariffsKept = { w, sig, index };
  return tariffsKept.index;
}

// The route a seller's cargo takes to a buyer, or null where none is open: the cheapest path from the seller's hub to the buyer's.
// cost: points with each stop's tariff on this cargo. untaxed: the same route without them. stops: the country of each port call and border crossing. rates: the tariff at each stop. legs: the path.
function routeOf(w, from, to, kind, index = tariffsToday(w), memo = null) {
  return findRoute(w, from, to, ratesOn(w, index, from, kind), memo);
}
// The same in steps, pausing while a tree is built.
function* routeOfSteps(w, from, to, kind, index, memo = null) {
  return yield* routeSteps(w, from, to, ratesOn(w, index, from, kind), memo);
}

// Where a country's side of a good lies on the map, as [province id, share], largest first: surplus by province for a seller, demand by province for a buyer; what no province holds is the capital's, as null.
function tradeEnds(bag, kind, selling) {
  const made = bag?.places?.yields?.[kind], used = bag?.places?.demand?.[kind];
  const list = [];
  let placed = 0;
  if (selling) {
    for (const [p, n] of made || []) { placed += n; const x = n - (used?.get(p) || 0); if (x > TRADE_EPSILON) list.push([p, x]); }
    const rest = (bag?.yields?.[kind] || 0) - placed;
    if (rest > TRADE_EPSILON) list.push([null, rest]);
  } else {
    for (const [p, n] of used || []) { placed += n; if (n > TRADE_EPSILON) list.push([p, n]); }
    const rest = (bag?.demand?.[kind] || 0) - placed;
    if (rest > TRADE_EPSILON) list.push([null, rest]);
  }
  if (!list.length) list.push([null, 1]);
  const total = list.reduce((a, [, n]) => a + n, 0);
  return list.map(([p, n]) => [p, n / total]).sort((x, y) => y[1] - x[1]);
}

// Every other country's tariff on a seller's good, as a signature and a map; kept per index.
const ratesBy = new WeakMap();
function ratesOn(w, index, from, kind) {
  if (!ratesBy.has(index)) ratesBy.set(index, new Map());
  const held = ratesBy.get(index);
  const key = from + '|' + kind;
  if (!held.has(key)) {
    const rates = new Map();
    for (const [c, entry] of index) {
      const n = c === from ? 0 : tariffRate(w, entry, from, kind);
      if (n > 0) rates.set(c, n);
    }
    held.set(key, [[...rates].map(([c, n]) => c + ':' + n).join(), rates]);
  }
  return held.get(key);
}

// What a buyer counts a unit of a seller's cargo as costing to land: its value with the tariffs along the route, and the shipping; cheaper by the buyer's good view of the seller and dearer by a poor one.
function landedCost(route, relations, value) {
  const charged = (route.rates || []).reduce((a, n) => a + n, 0);
  return (value * (1 + charged) + route.untaxed * POINT_DOLLARS) / (1 + relations / 100);
}

// The highest rate each country levies on each other, whatever on, as [levier, taxed, rate].
// Each levier's rows, by its table, ceilings and the countries in play.
const highestBy = new Map();
function highestTariffs(w) { return finish(highestTariffSteps(w)); }

// The same in steps, pausing between leviers.
function* highestTariffSteps(w) {
  const out = [];
  const ids = [...(w.government?.byPolity?.keys() || [])];
  let worked = 0;
  for (const [by, entry] of yield* tariffsTodaySteps(w)) {
    if (++worked % TARIFF_SLICE === 0) yield;
    const sig = ids.length + '|' + Object.values(entry.ceilings).join() + '|' + [...entry.rates].join();
    const held = highestBy.get(by);
    if (held?.[0] === sig && held[1] === w) { out.push(...held[2]); continue; }
    const rows = [];
    const keys = [...entry.rates.keys()].map((k) => k.split('|'));
    const named = new Set(keys.map(([t]) => t).filter((t) => t !== 'all'));
    // The goods an entry names, and one good of each class it does not name.
    const goodsNamed = new Set(keys.map(([, p]) => p).filter((p) => p !== 'all' && !TARIFF_CLASSES.includes(p)));
    const goods = [...goodsNamed, ...TARIFF_CLASSES.map((c) => tariffGoods(w).find((k) => productClass(w, k) === c && !goodsNamed.has(k))).filter(Boolean)];
    const top = (t) => goods.reduce((a, k) => Math.max(a, tariffRate(w, entry, t, k)), 0);
    const toAny = top(ANY);
    for (const t of ids) {
      if (t === by) continue;
      const n = named.has(t) ? top(t) : toAny;
      if (n > 0) rows.push([by, t, n]);
    }
    highestBy.set(by, [sig, w, rows]);
    out.push(...rows);
  }
  return out;
}

// Sets a country's rate on a target ('all' or a tag) and a product ('all', a class or a good); throws above the ceiling.
function setTariff(w, tag, target, product, rate) {
  const gov = w.government?.byPolity?.get(tag);
  if (!gov) throw new Error(`no government for "${tag}"`);
  if (target !== 'all' && (!w.table?.polityById?.has(target) || target === tag)) throw new Error(`target is 'all' or another polity's tag, not "${target}"`);
  if (product !== 'all' && !TARIFF_CLASSES.includes(product) && !productClass(w, product)) {
    throw new Error(`no product "${product}"; try 'all', ${TARIFF_CLASSES.join(', ')} or a good`);
  }
  if (typeof rate !== 'number' || !(rate >= 0 && rate <= 1)) throw new Error('rate is a share from 0 to 1');
  const ceiling = ceilingOn(w, tariffCeilings(w, tag), product);
  if (rate > ceiling + 1e-9) throw new Error(`${tag} may charge at most ${Math.round(ceiling * 100)}% on ${product}`);
  const others = (gov.tariffs || []).filter((x) => !(x.target === target && x.product === product));
  // A rate of 0 is kept only where it holds off a broader one.
  const without = { ceilings: { resources: 1, equipment: 1, consumerGoods: 1 }, rates: new Map(others.map((x) => [x.target + '|' + x.product, x.rate])) };
  const kept = rate > 0 || coveredBy(w, product).some((k) => tariffRate(w, without, target === 'all' ? ANY : target, k) > 0);
  gov.tariffs = kept ? [...others, { target, product, rate }] : others;
  tariffsHeld = null;
  return tariffTable(w, tag);
}

// A country's tariff table with its ceilings.
function tariffTable(w, tag) {
  const gov = w.government?.byPolity?.get(tag);
  if (!gov) throw new Error(`no government for "${tag}"`);
  tariffsToday(w);
  return {
    law: lawsFor(w, tag).trade,
    ceilings: tariffCeilings(w, tag),
    rates: (gov.tariffs || []).map((x) => ({ ...x })),
  };
}

// A country's trade for a day; shipping: what the state paid for its shipments' bunkering and tariffs, by stop.
// with: by the seller and the buyer of the cargo, the tariffs, bunkering and state fuel sold at the country's stops.
const tradeBooks = () => ({ bought: {}, sold: {}, from: {}, to: {}, landed: 0, tariffs: 0, tariffsFrom: {}, tariffsOn: {}, tariffsPaid: 0, tariffsTo: {}, bunkering: 0, fuelSales: 0, fuelBurnt: { coal: 0, oil: 0 }, shipping: 0, shippingTo: {}, with: {} });

// Cargo put in at each stop on a route, the bunkering and fuel it takes on there, and the tariff charged there on the seller's goods.
// payer: a state paying a shipment's bunkering and tariffs, charged no tariff at its own stops; else the seller's tariffs paid.
function bookStops(w, trade, route, n, seller, kind, terms = null, payer = null, buyer = null) {
  if (!trade.has(seller)) trade.set(seller, tradeBooks());
  if (payer && !trade.has(payer)) trade.set(payer, tradeBooks());
  const s = trade.get(seller), p = payer && trade.get(payer);
  for (let i = 0; i < route.stops.length; i++) {
    // A shared stop books each port's part where it calls.
    for (const { stop, rate, share } of route.shares?.[i] || [{ stop: route.stops[i], rate: route.rates[i], share: 1 }]) {
      const m = n * share;
      if (!trade.has(stop)) trade.set(stop, tradeBooks());
      const at = trade.get(stop);
      at.landed += m;
      const spent = STOP_POINTS * POINT_DOLLARS * m;
      const owner = terms?.get(stop) || tradeTermsOf(w, stop);
      const fuel = spent * (COAL_SHARE * owner.owns('coal') + OIL_SHARE * owner.owns('oil'));
      at.bunkering += spent;
      at.fuelSales += fuel;
      const due0 = stop === payer ? 0 : STOP_POINTS * POINT_DOLLARS * rate * m;
      for (const party of [seller, buyer]) {
        if (!party || party === stop) continue;
        const x = (at.with[party] ||= { tariffs: 0, bunkering: 0, fuelSales: 0 });
        x.tariffs += due0; x.bunkering += spent; x.fuelSales += fuel;
      }
      at.fuelBurnt.coal += STOP_FUEL * m * COAL_SHARE;
      at.fuelBurnt.oil += STOP_FUEL * m * OIL_SHARE;
      if (p) { p.shipping += spent; p.shippingTo[stop] = (p.shippingTo[stop] || 0) + spent; }
      const due = due0;
      if (!due) continue;
      at.tariffs += due;
      at.tariffsFrom[seller] = (at.tariffsFrom[seller] || 0) + due;
      at.tariffsOn[kind] = (at.tariffsOn[kind] || 0) + due;
      if (p) { p.shipping += due; p.shippingTo[stop] += due; continue; }
      s.tariffsPaid += due;
      s.tariffsTo[stop] = (s.tariffsTo[stop] || 0) + due;
    }
  }
}

// Buyers served and routes asked for between pauses of a market in steps, where no route needs a tree built.
const ROUTE_SLICE = 10;
// How far over a buyer's cheapest landed cost a seller may be and still share the order.
const SHARE_BAND = 0.15;
// Most sellers a buyer shares an order among at once.
const SHARE_SELLERS = 3;
// Least a sale moves, but for a buyer whose whole need is less.
const MIN_LOT = 0.1;
// One day of the automatic market over every country's yield and demand; run(kinds) matches those goods, steps(kinds) the same in steps. tariffs: an index in place of the countries' own.
function tradeMarket(w, out, tariffs = null) {
  const ids = [...out.keys()];
  const terms = new Map(ids.map((id) => [id, tradeTermsOf(w, id)]));
  const books = tradeBooks;
  const trade = new Map(ids.map((id) => [id, books()]));
  // Each sale with its route, and the parties' enemies, asked once a market.
  const sales = [];
  const hostile = new Map();
  if (!tariffs) { tariffsHeld = { w, index: tariffsFresh(w) }; tariffs = tariffsHeld.index; }
  const world = {};
  // Food held back for the calories the three kinds leave unmet: from a country's own spare food first, then bought as crops.
  const hunger = new Map(ids.map((id) => {
    const b = out.get(id);
    const spare = FOOD_KINDS.map((k) => Math.max(0, (b.yields[k] || 0) - (b.demand[k] || 0)));
    const total = spare.reduce((a, n) => a + n, 0);
    const gap = Math.max(0, (b.fedPeople || 0) / PEOPLE_PER_FOOD - FOOD_KINDS.reduce((a, k) => a + (b.demand[k] || 0), 0));
    const kept = Math.min(gap, total);
    const extra = Object.fromEntries(FOOD_KINDS.map((k, i) => [k, total ? spare[i] * kept / total : 0]));
    extra.fertileLand += gap - kept;
    return [id, extra];
  }));
  const position = (id, kind) => (out.get(id).yields[kind] || 0) - (out.get(id).demand[kind] || 0) - (hunger.get(id)[kind] || 0);

  // Buyers served in order of the share of their own surplus they offer, then of what they give against what they take.
  const kinds = tradedKinds(w);
  const standing = new Map(ids.map((id) => {
    let surplus = 0, offered = 0, wanted = 0;
    for (const kind of kinds) {
      const n = position(id, kind);
      if (n > 0) { surplus += n; offered += n * terms.get(id).offer(kind); } else wanted -= n * terms.get(id).fill;
    }
    return [id, [surplus ? offered / surplus : 0, offered + wanted ? offered / (offered + wanted) : 0]];
  }));
  const order = ids.map((id, i) => i).sort((a, b) => {
    const x = standing.get(ids[a]), y = standing.get(ids[b]);
    return y[0] - x[0] || y[1] - x[1] || (ids[a] < ids[b] ? -1 : 1);
  });

  // A buyer's view of each seller, or null at war; filled as asked.
  const views = new Array(ids.length * ids.length);
  const viewOf = (bi, si) => {
    const k = bi * ids.length + si;
    if (views[k] === undefined) {
      const buyer = ids[bi], seller = ids[si];
      const war = (w.polityValues?.[buyer]?.atWar || []).includes(seller) || (w.polityValues?.[seller]?.atWar || []).includes(buyer);
      views[k] = war ? null : relationsBetween(buyer, seller)?.value ?? 0;
    }
    return views[k];
  };

  // Buyers served and routes asked for since the last pause of a market in steps.
  let asked = 0;
  function* steps(goods) {
    for (const kind of goods) {
      const row = world[kind] = { deficit: 0, wanted: 0, offered: 0, moved: 0, unfilled: 0, short: 0, unrouted: 0 };
      const pos = ids.map((id) => position(id, kind));
      // Sellers by what they offer, most first.
      const sellers = [];
      for (const [i, id] of ids.entries()) {
        if (pos[i] < 0) row.deficit -= pos[i];
        const offered = pos[i] > 0 ? pos[i] * terms.get(id).offer(kind) : 0;
        if (offered > TRADE_EPSILON) { sellers.push([i, offered]); row.offered += offered; }
      }
      sellers.sort((a, b) => b[1] - a[1]);
      const at = sellers.map(([i]) => i), left = sellers.map(([, n]) => n);
      // Every seller each buyer reaches, with the route and its landed cost.
      const reach = new Map();
      for (const bi of order) {
        if (pos[bi] >= 0) continue;
        const buyer = ids[bi];
        const list = [];
        for (let j = 0; j < at.length; j++) {
          const relations = viewOf(bi, at[j]);
          // A seller viewed at -100 or below, or at war, is passed over.
          if (relations === null || 1 + relations / 100 <= 0) continue;
          // A pause after a route tree is built, or after ROUTE_SLICE routes.
          const built = treesBuilt();
          const route = yield* routeOfSteps(w, ids[at[j]], buyer, kind, tariffs, hostile);
          if (treesBuilt() !== built || ++asked >= ROUTE_SLICE) { asked = 0; yield; }
          if (!route) { row.unrouted++; continue; }
          list.push({ j, route, cost: landedCost(route, relations, GOODS_VALUE[kind] || 0), n: 0 });
        }
        if (list.length) reach.set(bi, list);
      }
      // Buyers' own need first, then what a free trader takes beyond it. Each round a buyer splits what it still wants among the sellers with cargo left within SHARE_BAND of its cheapest, the SHARE_SELLERS cheapest of them, the cheaper the larger, no order under MIN_LOT; each seller fills the orders cheapest to land first.
      // Buyers whose whole need is under MIN_LOT, who buy it in one lot.
      const small = new Set();
      // Each pair's sale of this good, so a free trader's extra joins its first.
      const saleOf = new Map();
      for (const beyond of [false, true]) {
        const want = new Map();
        for (const [bi] of reach) {
          const fill = terms.get(ids[bi]).fill;
          if (!beyond) row.wanted += -pos[bi] * fill;
          const n = -pos[bi] * (beyond ? fill : Math.min(1, fill)) - (trade.get(ids[bi]).bought[kind] || 0);
          if (!beyond && n > TRADE_EPSILON && n < MIN_LOT) small.add(bi);
          if (beyond ? n >= MIN_LOT : n > TRADE_EPSILON) want.set(bi, n);
        }
        // A sale of m to a buyer that wants n, kept to MIN_LOT unless it fills the buyer.
        const lot = (bi, m, n) => m >= MIN_LOT || m >= n - TRADE_EPSILON;
        // Each round fills every buyer that orders or empties a seller.
        for (let round = 0; round <= 2 * at.length && want.size; round++) {
          const orders = [];
          for (const [bi, n] of want) {
            const open = reach.get(bi).filter((x) => lot(bi, left[x.j], n) && left[x.j] > TRADE_EPSILON);
            if (!open.length) { want.delete(bi); continue; }
            const cheapest = Math.min(...open.map((x) => x.cost));
            const reachOf = cheapest * SHARE_BAND;
            const band = open.map((x) => [x, reachOf > 0 ? 1 - (x.cost - cheapest) / reachOf : Number(x.cost <= cheapest)]).filter(([, k]) => k > 0).sort((a, b) => a[0].cost - b[0].cost || a[0].j - b[0].j);
            // The most sellers whose every order comes to MIN_LOT, one for a small buyer.
            let shares = band.slice(0, 1);
            for (let c = Math.min(SHARE_SELLERS, band.length); c > 1 && !small.has(bi); c--) {
              const pick = band.slice(0, c), total = pick.reduce((a, [, k]) => a + k, 0);
              if (pick.every(([, k]) => n * k / total >= MIN_LOT)) { shares = pick; break; }
            }
            const total = shares.reduce((a, [, k]) => a + k, 0);
            for (const [x, k] of shares) orders.push([bi, x, n * k / total]);
          }
          orders.sort((a, b) => a[1].cost - b[1].cost || a[0] - b[0] || a[1].j - b[1].j);
          let moved = 0;
          for (const [bi, x, n] of orders) {
            const wants = want.get(bi) || 0;
            const m = Math.min(n, left[x.j], wants);
            if (m <= TRADE_EPSILON || !lot(bi, m, wants)) continue;
            x.n += m; left[x.j] -= m; moved += m;
            // What is left under MIN_LOT of a buyer that wanted more counts as filled.
            const rest = wants - m;
            if (rest > TRADE_EPSILON && (rest >= MIN_LOT || small.has(bi))) want.set(bi, rest); else want.delete(bi);
          }
          if (moved <= TRADE_EPSILON) break;
        }
        // Each buyer's purchases booked by seller, its route's stops and all.
        for (const [bi, list] of reach) {
          const buyer = ids[bi];
          const t = trade.get(buyer);
          for (const x of list) {
            const n = x.n;
            x.n = 0;
            if (n <= TRADE_EPSILON) continue;
            const seller = ids[at[x.j]];
            const s = trade.get(seller);
            row.moved += n;
            t.bought[kind] = (t.bought[kind] || 0) + n;
            s.sold[kind] = (s.sold[kind] || 0) + n;
            (t.from[kind] ||= {})[seller] = (t.from[kind][seller] || 0) + n;
            (s.to[kind] ||= {})[buyer] = (s.to[kind][buyer] || 0) + n;
            // Cargo put in at each stop on the route, the bunkering and fuel it takes on there, and the tariff charged there.
            if (saleOf.has(x)) saleOf.get(x).amount += n;
            else { saleOf.set(x, { kind, seller, buyer, amount: n, route: x.route }); sales.push(saleOf.get(x)); }
            bookStops(w, trade, x.route, n, seller, kind, terms, null, buyer);
          }
        }
      }
      for (const [i, id] of ids.entries()) {
        const gap = -pos[i] - (trade.get(id).bought[kind] || 0);
        if (gap > TRADE_EPSILON) { row.unfilled += gap; row.short++; }
      }
    }
  }
  const run = (goods) => finish(steps(goods));
  return { run, steps, trade, world, sales };
}

// One day of every country's resources.
function dailySupply(w, settle = false) { return finish(supplySteps(w, settle)); }

// Provinces, or counties, worked through between pauses of a day's resources.
const SUPPLY_SLICE = 50;

// The same in steps, pausing between provinces and between goods.
function* supplySteps(w, settle = false) {
  const prior = live.lastSupply || new Map();
  const out = new Map();
  const of = (id) => {
    if (!out.has(id)) {
      out.set(id, {
        yields: {}, demand: {}, places: { yields: {}, demand: {} }, people: 0, fedPeople: 0, fishDemand: 0, powerDemand: 0, freePower: 0,
        coalPlants: 0, rubberPlants: 0, factories: 0,
      });
    }
    return out.get(id);
  };
  const add = (bag, k, n) => { if (n) bag[k] = (bag[k] || 0) + n; };
  // The same, by province, for where trade starts and ends.
  const addAt = (bag, k, p, n) => { if (!n) return; const m = (bag[k] ||= new Map()); m.set(p, (m.get(p) || 0) + n); };
  const demandAt = (b, k, p, n) => { add(b.demand, k, n); addAt(b.places.demand, k, p, n); };
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
  // Outside a settled day, what would gather is only noted, for the routes layer.
  const noted = new Map();
  const gather = (x, part, kind, n, to) => {
    if (settle) { gatherShipment(w, x, part, kind, n, to); return; }
    if (!n) return;
    const k = shipmentKey(x) + '|' + part + '|' + kind;
    if (!noted.has(k)) noted.set(k, { x, to, kind, today: 0 });
    noted.get(k).today += n;
  };

  let worked = 0;
  for (const p of w.table?.provinces || []) {
    if (++worked % SUPPLY_SLICE === 0) yield;
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
      addAt(b.places.yields, kind, p.id, n * (1 - occupied));
      if (efficiency) { add(of(p.occupier).yields, kind, n * efficiency); addAt(of(p.occupier).places.yields, kind, p.id, n * efficiency); }
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
      // Food is booked nationally below, and placed here.
      addAt(b.places.demand, 'fertileLand', p.id, people * PER_PERSON.fertileLand);
      addAt(b.places.demand, 'livestock', p.id, people * PER_PERSON.livestock);
      addAt(b.places.demand, 'fish', p.id, people * PER_PERSON.fish * tier);
    } else if (people) {
      const own = w.resources?.[p.id] || {};
      const met = metShare;
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
    for (const [k, n] of Object.entries(factoryDemand)) demandAt(b, k, p.id, n * factories);
    for (const k of ['road', 'electricity', 'radar', 'supplyHub', 'antiAir', 'airBase']) {
      const level = builtLevel(st, k);
      if (!level) continue;
      for (const [r, n] of Object.entries(levelDemand(k))) demandAt(b, r, p.id, n * level);
      b.powerDemand += level * (projects[k]?.power || 0);
    }
    demandAt(b, 'nitrates', p.id, FERTILISER * (w.resources?.[p.id]?.fertileLand || 0));
  }
  yield;

  // Rail and the plants, county by county.
  for (const c of w.counties?.byId?.values() || []) {
    if (++worked % SUPPLY_SLICE === 0) yield;
    const p = w.byId?.get(c.province);
    if (!p?.owner || p.owner === UNOWNED) continue;
    const b = of(p.owner);
    if (c.rail !== undefined) for (const [k, n] of Object.entries(railDemand)) demandAt(b, k, p.id, n);
    for (const [k, n] of Object.entries(projects.fortification?.baseDemand || {})) demandAt(b, k, p.id, n * (c.fortification || 0));
    for (const x of buildings) if (c[x.building]) for (const [k, n] of Object.entries(x.baseDemand || {})) demandAt(b, k, p.id, n);
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

  yield;

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
  // Today's tariffs, rebuilt once for shipments and the market alike.
  const tariffs = yield* tariffsFreshSteps(w);
  tariffsHeld = { w, index: tariffs };
  // Shipments due today are sent along their route, into the receiver's reserve or stockpile; with no route open one waits for its next day.
  const held = settle ? [...activeLeases(w), ...activeAgreements(w)] : [];
  const shipped = [];
  const routeMemo = new Map();
  const senderOf = (x, s) => (s.to === x.first ? x.second : x.first);
  const shipmentsOf = (x) => { const head = shipmentKey(x) + '|'; return Object.entries(w.shipments || {}).filter(([k]) => k.startsWith(head)).map(([, s]) => s); };
  if (settle) {
    const send = function* (x, back) {
      for (const s of shipmentsOf(x)) {
        if (!s.n) continue;
        const from = senderOf(x, s);
        if (!back) {
          const route = yield* routeOfSteps(w, from, s.to, shipmentGood(s.kind), tariffs, routeMemo);
          if (!route) continue;
          shipped.push({ x, from, to: s.to, kind: s.kind, n: s.n, route });
        }
        const v = w.polityValues?.[back ? from : s.to];
        if (v) { const bag = s.stock ? (v.stockpile ||= {}) : (v.reserves ||= {}); bag[s.kind] = (bag[s.kind] || 0) + s.n; }
        s.n = 0;
      }
    };
    for (const x of held) if (shipmentDue(x)) yield* send(x, false);
    // Leases and agreements out of force: what had gathered goes back to its sender.
    const heldKeys = new Set(held.map(shipmentKey));
    for (const x of w.government?.relations?.relations || []) {
      if ((x.band !== 'lease' && x.band !== 'stateAgreement') || heldKeys.has(shipmentKey(x))) continue;
      (w.shipmentStops ||= {})[shipmentKey(x)] = clock.day;
      yield* send(x, true);
    }
    // War between the parties ends a lease or agreement for good.
    const atWar = (x) => (w.polityValues?.[x.first]?.atWar || []).includes(x.second) || (w.polityValues?.[x.second]?.atWar || []).includes(x.first);
    const rel = w.government?.relations;
    if (rel?.relations) rel.relations = rel.relations.filter((x) => !((x.band === 'lease' || x.band === 'stateAgreement') && atWar(x)));
  }

  // Each country's day: demand first, then the market, then the balance.
  const day = new Map();
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
    // Fuel sold to yesterday's traffic at stops here.
    const burnt = prior.get(id)?.trade?.fuelBurnt;
    add(b.demand, 'coal', burnt?.coal || 0);
    add(b.demand, 'oil', burnt?.oil || 0);

    // Food demand.
    add(b.demand, 'fertileLand', b.fedPeople * PER_PERSON.fertileLand);
    add(b.demand, 'livestock', b.fedPeople * PER_PERSON.livestock);
    add(b.demand, 'fish', b.fishDemand);

    day.set(id, { b, held, rates, free, gasForPower, coalForPower, supply: {}, shortfall: {}, kept: {} });
  }

  // The automatic market: everything but rubber now, rubber once synthetic rubber is known; one good a step.
  yield;
  let tradeMs = 0;
  const market = tradeMarket(w, out, tariffs);
  // Shipments sent today book their stops as market cargo does, their bunkering and tariffs charged to the payer.
  for (const s of shipped) bookStops(w, market.trade, s.route, s.n, s.from, shipmentGood(s.kind), null, shippingPayer(s.x, s.from, s.to), s.to);
  // Each lease and agreement drawn on the routes at what gathered for it today.
  for (const x of held) {
    for (const s of shipmentsOf(x)) {
      if (!s.today || s.day < clock.day - 1) continue;
      const from = senderOf(x, s);
      const route = yield* routeOfSteps(w, from, s.to, shipmentGood(s.kind), tariffs, routeMemo);
      if (route) market.sales.push({ kind: shipmentGood(s.kind), seller: from, buyer: s.to, amount: s.today, route, via: shipmentVia(x) });
    }
  }
  // Outside a settled day: what was noted, and equipment agreements at their daily amount.
  if (!settle) {
    const equipment = activeAgreements(w).filter((x) => !(w.resourceKinds || []).includes(x.good) && x.amount > 0)
      .map((x) => ({ x, to: x.second, kind: x.good, today: x.amount }));
    for (const s of [...noted.values(), ...equipment]) {
      const from = senderOf(s.x, s);
      const route = yield* routeOfSteps(w, from, s.to, shipmentGood(s.kind), tariffs, routeMemo);
      if (route) market.sales.push({ kind: shipmentGood(s.kind), seller: from, buyer: s.to, amount: s.today, route, via: shipmentVia(s.x) });
    }
  }
  yield;
  const trade = function* (kind) {
    const steps = market.steps([kind]);
    for (;;) {
      const t0 = performance.now();
      const x = steps.next();
      tradeMs += performance.now() - t0;
      if (x.done) return;
      yield;
    }
  };
  for (const kind of tradedKinds(w).filter((k) => k !== 'rubber')) { yield* trade(kind); yield; }

  // Reserves: store a surplus up to the rate, release on a negative rate, draw automatically when short.
  const settleReserve = (d, kind, available, demand) => {
    const { held, rates } = d;
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
  // What a day brings in a kind: yield, bought and sold.
  const balance = (id, d, kind) => {
    const demand = d.b.demand[kind] || 0;
    const t = market.trade.get(id);
    const available = (d.b.yields[kind] || 0) + (t?.bought[kind] || 0) - (t?.sold[kind] || 0);
    d.supply[kind] = settleReserve(d, kind, available, demand);
    d.shortfall[kind] = demand > 0 ? 1 - Math.min(1, d.supply[kind] / demand) : 0;
    d.kept[kind] = 1 - lostAt(d.shortfall[kind], SHORTAGE_K[kind]);
    return demand > 0 ? Math.min(1, d.supply[kind] / demand) : 1;
  };

  for (const [id, d] of day) {
    const { b } = d;
    const gasShare = balance(id, d, 'naturalGas');
    const coalShare = balance(id, d, 'coal');
    const oilShare = balance(id, d, 'oil');
    const supplied = d.free + d.gasForPower * gasShare * GAS_POWER + d.coalForPower * coalShare * COAL_POWER;
    d.power = { demand: b.powerDemand, supplied: Math.min(supplied, b.powerDemand), free: d.free, cover: b.powerDemand > 0 ? Math.min(1, supplied / b.powerDemand) : 1 };

    // Fuel from oil one for one and from coal through synthesis; synthetic rubber from oil.
    const syntheticFuel = b.coalPlants * coalShare;
    const syntheticRubber = b.rubberPlants * oilShare;
    const realFuel = (b.demand.fuel || 0) * oilShare;
    add(b.yields, 'fuel', realFuel + syntheticFuel);
    add(b.yields, 'rubber', syntheticRubber);
    d.synthetic = {
      fuel: b.demand.fuel ? Math.min(syntheticFuel, Math.max(0, b.demand.fuel - realFuel)) / b.demand.fuel : 0,
      rubber: b.demand.rubber ? Math.min(syntheticRubber, Math.max(0, b.demand.rubber - (b.yields.rubber - syntheticRubber))) / b.demand.rubber : 0,
    };
    d.fuel = { real: realFuel, synthetic: syntheticFuel };
  }
  yield* trade('rubber');
  if (settle) perf.trade = tradeMs;
  yield;

  for (const [id, d] of day) {
    const { b, held, supply, kept } = d;
    const met = {};
    for (const kind of Object.keys({ ...b.yields, ...b.demand })) {
      if (kind === 'naturalGas' || kind === 'coal' || kind === 'oil') continue;
      met[kind] = balance(id, d, kind);
    }
    // Food: calories decide hunger, each kind decides how well a country eats.
    const calories = b.fedPeople / PEOPLE_PER_FOOD;
    const fed = (supply.fertileLand || 0) + (supply.livestock || 0) + (supply.fish || 0);
    met.calories = metShare(fed, calories);
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
    // Losses within rounding of nothing are nothing.
    for (const k of Object.keys(happiness)) if (Math.abs(happiness[k]) < MET_EPSILON) happiness[k] = 0;

    const storage = RESERVE_STORAGE * Object.values(held).reduce((a, n) => a + n, 0);
    out.set(id, {
      yields: b.yields, demand: b.demand, supply, shortfall: d.shortfall, kept, met, reserves: { ...held }, power: d.power, synthetic: d.synthetic,
      fuel: d.fuel, happiness, storage, people: b.people, places: b.places, trade: market.trade.get(id),
    });
  }
  out.market = market.world;
  out.sales = market.sales;
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
everyDay(function* (w) {
  const before = live.lastSupply;
  live.lastSupply = yield* supplySteps(w, true);
  // Fertile land on the resource layer follows nitrate cover.
  const moved = [...live.lastSupply].some(([id, s]) => Math.abs((s.kept.nitrates ?? 1) - (before.get(id)?.kept?.nitrates ?? 1)) > 0.005);
  if (moved) { w.resourceLines = yield* resourceLineSteps(w); invalidateView(); }
});

export { COAL_POWER, GAS_POWER, OIL_FUEL, TIMBER_POWER, PEOPLE_PER_FOOD, PER_PERSON, FISH_TIER, FERTILISER, UNFERTILISED, FOOD_HAPPINESS, GOODS_HAPPINESS, GOLD_HAPPINESS, SHORTAGE_K, RESERVE_DAYS, RESERVE_STORAGE, lostAt, SHIPMENT_DAYS, shipmentKey, shipmentDue, shipmentDays, gatherShipment, SHIPPING_TERMS, shippingPayer, shipmentVia, shipmentGood, setShippingTerms, addAgreement, tradeBooks, bookStops, activeLeases, activeAgreements, agreementPrice, STATE_REGULATED, tradedKinds, tradeTerms, tradeTermsOf, STOP_POINTS, POINT_DOLLARS, COAL_SHARE, OIL_SHARE, STOP_FUEL, TARIFF_CLASSES, productClass, tariffCeilings, tariffRate, tariffIndex, TARIFF_SLICE, tariffIndexSteps, tariffsToday, tariffsTodaySteps, tariffsFresh, tariffsFreshSteps, routeOf, routeOfSteps, tradeEnds, GOODS_VALUE, landedCost, SHARE_BAND, SHARE_SELLERS, MIN_LOT, highestTariffs, highestTariffSteps, setTariff, tariffTable, tradeMarket, provinceYields, heldYields, dailySupply, SUPPLY_SLICE, supplySteps, foodHappiness };
