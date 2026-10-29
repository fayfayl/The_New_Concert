/*
 * The automatic market: each day's surpluses matched against each day's
 * deficits, under each country's trade law. Checked on small hand-made markets
 * of real polities, and then on the day the game has just run.
 *
 *   node --max-old-space-size=6144 test/trade.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire } from './dom-shim.mjs';

const problems = [];
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = install(root);

process.on('uncaughtException', (e) => problems.push(['uncaught', e]));
process.on('unhandledRejection', (e) => problems.push(['rejection', e]));

const t0 = Date.now();
await import('../src/main.js');
for (let i = 0; i < 400 && !dom.frameQueue.length; i++) await new Promise((r) => setTimeout(r, 50));
console.log(`booted in ${Date.now() - t0}ms`);
fire(dom.el('start-enter'), 'click');

const { state, live, worldChanged } = await import('../src/core/core.js');
const res = await import('../src/game/resources.js');
const nation = await import('../src/game/nation.js');
const game = globalThis.window.game;
const w = state.world;

const expect = (what, got, want) => {
  const ok = typeof got === 'number' && Math.abs(got - want) < 1e-6;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${got}${ok ? '' : ', expected ' + want}`);
  if (!ok) problems.push(['trade', new Error(`${what}: ${got}, expected ${want}`)]);
};

// Starting tariffs, as loaded: none inside a realm or an empire, the ceiling at -50 or below, no relations term on day 0.
const rel = await import('../src/game/relations.js');
const index = res.tariffsToday(w);
const goods = [...res.tradedKinds(w), 'consumerGoods'];
const charged = (a, b) => (index.has(a) ? goods.reduce((m, k) => Math.max(m, res.tariffRate(w, index.get(a), b, k)), 0) : 0);
const P = (id) => w.table.polityById.get(id);
const govIds = [...w.government.byPolity.keys()];
const pairsWhere = (fn) => govIds.flatMap((a) => govIds.filter((b) => a !== b && fn(a, b)).map((b) => [a, b]));
const realmPairs = pairsWhere((a, b) => rel.voiceOf(w, a) === rel.voiceOf(w, b));
expect(`realm and member pairs charging each other (of ${realmPairs.length})`, realmPairs.filter(([a, b]) => charged(a, b) > 0).length, 0);
const empirePairs = pairsWhere((a, b) => P(a).suzerain === b || P(b).suzerain === a || (P(a).suzerain && P(a).suzerain === P(b).suzerain));
expect(`colony and suzerain pairs charging each other (of ${empirePairs.length})`, empirePairs.filter(([a, b]) => charged(a, b) > 0).length, 0);
const COLONY0 = govIds.find((id) => nation.colonyHolder(w, id));
expect(`colony ${COLONY0} charging ${nation.colonyHolder(w, COLONY0)}`, charged(COLONY0, nation.colonyHolder(w, COLONY0)), 0);
const blocOf = (id) => { const v = rel.voiceOf(w, id); const s = P(v)?.suzerain || P(id)?.suzerain; return s ? blocOf(s) : v; };
const hostile = pairsWhere((a, b) => blocOf(a) !== blocOf(b) && live.lastRelations.get(a + '>' + b)?.value <= -50);
const allCeiling = (a) => Math.max(...Object.values(res.tariffCeilings(w, a)));
const atCeiling = hostile.filter(([a, b]) => Math.abs(index.get(a)?.rates.get(b + '|all') - allCeiling(a)) < 1e-9);
expect(`hostile pairs at the ceiling (of ${hostile.length})`, atCeiling.length, hostile.length);
const tariffTerms = Object.values(w.relationHistory || {}).flatMap((bag) => Object.keys(bag).filter((k) => k.startsWith(rel.TARIFF_LABEL)));
expect('tariff terms in relations history on day 0', tariffTerms.length, 0);
expect('tariff terms in the views on day 0', [...live.lastRelations.values()].filter((x) => x?.parts?.some(([l]) => String(l).startsWith(rel.TARIFF_LABEL))).length, 0);
// 30 days on: -1 per 10% of the highest rate, on a pair outside any realm.
const saved = structuredClone(w.relationHistory || {});
const [LEVIER, TAXED] = atCeiling.find(([a, b]) => rel.voiceOf(w, a) === a && rel.voiceOf(w, b) === b && !govIds.some((c) => c !== a && rel.voiceOf(w, c) === a));
const top = res.highestTariffs(w).find(([by, t]) => by === LEVIER && t === TAXED)[2];
for (let i = 0; i < 30; i++) rel.growHistory(w);
expect(`${TAXED} view of ${LEVIER} after 30 days at ${top * 100}%`, w.relationHistory[TAXED + '>' + LEVIER]?.[rel.TARIFF_LABEL + (P(LEVIER).short || LEVIER)], -top * 10);
w.relationHistory = saved;

// A polity under a trade law whose terms are the law's own figures.
const lawOf = (id) => nation.lawsFor(w, id).trade;
const plain = (law, offer, fill, but = []) => [...w.government.byPolity.keys()].find((id) => {
  if (lawOf(id) !== law || but.includes(id)) return false;
  const t = res.tradeTerms(w, id);
  return Math.abs(t.offer('coal') - offer) < 1e-9 && Math.abs(t.fill - fill) < 1e-9 && t.offer('textiles') === offer;
});
const FREE = plain('Free trade', 1, 1.2);
const FREE2 = plain('Free trade', 1, 1.2, [FREE]);
const EXPORT = plain('Export focus', 1, 1);
const LIMITED = plain('Limited exports', 0.4, 1);
const CLOSED = plain('Closed economy', 0, 0);
const OWNED = [...w.government.byPolity.values()].find((g) => (g.stateOwned || []).includes('coal') && res.tradeTerms(w, g.id).offer('textiles') > 0)?.id;
console.log(`  free ${FREE}, ${FREE2}; export ${EXPORT}; limited ${LIMITED}; closed ${CLOSED}; coal state-owned ${OWNED}`);

// Every pair at peace and at 0 relations unless a case says otherwise.
const ids = [FREE, FREE2, EXPORT, LIMITED, CLOSED, OWNED];
const wars = Object.fromEntries(ids.map((id) => [id, w.polityValues[id].atWar]));
for (const id of ids) w.polityValues[id].atWar = [];
const views = new Map();
for (const a of ids) for (const b of ids) if (a !== b) { views.set(a + '>' + b, live.lastRelations.get(a + '>' + b)); live.lastRelations.set(a + '>' + b, { value: 0 }); }
const view = (a, b, value) => live.lastRelations.set(a + '>' + b, { value });

// A market of the countries given, each as { yields, demand }, over the goods given.
const market = (bags, kinds = res.tradedKinds(w)) => {
  const out = new Map(Object.entries(bags).map(([id, b]) => [id, { yields: b.yields || {}, demand: b.demand || {}, fedPeople: 0 }]));
  const m = res.tradeMarket(w, out);
  m.run(kinds);
  return m;
};
const bought = (m, id, kind) => m.trade.get(id).bought[kind] || 0;
const sold = (m, id, kind) => m.trade.get(id).sold[kind] || 0;

// Free trade fills 120% of a deficit.
let m = market({ [EXPORT]: { yields: { coal: 100 } }, [FREE]: { demand: { coal: 10 } } });
expect('free trader buys 120% of a deficit of 10 coal', bought(m, FREE, 'coal'), 12);
expect('export focus sells all it is asked', sold(m, EXPORT, 'coal'), 12);
m = market({ [FREE]: { yields: { coal: 100 } }, [EXPORT]: { demand: { coal: 10 } } });
expect('export focus buys its deficit and no more', bought(m, EXPORT, 'coal'), 10);

// Limited exports offers 40%.
m = market({ [LIMITED]: { yields: { iron: 10 } }, [FREE]: { demand: { iron: 100 } } });
expect('limited exports sells 40% of a surplus of 10', sold(m, LIMITED, 'iron'), 4);
m = market({ [FREE]: { yields: { iron: 100 } }, [LIMITED]: { demand: { iron: 10 } } });
expect('limited exports fills all of its deficit', bought(m, LIMITED, 'iron'), 10);

// A closed economy neither buys nor sells.
m = market({ [CLOSED]: { yields: { coal: 50 }, demand: { iron: 10 } }, [FREE]: { yields: { iron: 50 }, demand: { coal: 10 } } });
expect('closed economy sells nothing', Object.keys(m.trade.get(CLOSED).sold).length, 0);
expect('closed economy buys nothing', Object.keys(m.trade.get(CLOSED).bought).length, 0);
expect('free trader finds no coal', bought(m, FREE, 'coal'), 0);

// Tazkuri and goizederium never enter the market; nor does a state-owned good.
expect('tazkuri is not a traded good', Number(res.tradedKinds(w).includes('tazkuri')), 0);
expect('goizederium is not a traded good', Number(res.tradedKinds(w).includes('goizederium')), 0);
m = market({ [FREE]: { yields: { tazkuri: 50, goizederium: 50 } }, [EXPORT]: { demand: { tazkuri: 10, goizederium: 10 } } }, ['tazkuri', 'goizederium', ...res.tradedKinds(w)]);
expect('tazkuri bought', bought(m, EXPORT, 'tazkuri'), 0);
expect('goizederium bought', bought(m, EXPORT, 'goizederium'), 0);
m = market({ [OWNED]: { yields: { coal: 50, textiles: 50 } }, [FREE]: { demand: { coal: 10, textiles: 10 } } });
expect('state-owned coal sold', sold(m, OWNED, 'coal'), 0);
expect('private textiles from the same country sold', sold(m, OWNED, 'textiles'), 12);

// No trade between countries at war, and none at -100.
w.polityValues[FREE].atWar = [EXPORT];
m = market({ [EXPORT]: { yields: { coal: 100 } }, [FREE]: { demand: { coal: 10 } } });
expect('coal bought from an enemy', bought(m, FREE, 'coal'), 0);
w.polityValues[FREE].atWar = [];
view(FREE, EXPORT, -100);
m = market({ [EXPORT]: { yields: { coal: 100 } }, [FREE2]: { yields: { coal: 1 } }, [FREE]: { demand: { coal: 10 } } });
expect('coal bought from a country viewed at -100', m.trade.get(FREE).from.coal?.[EXPORT] ?? 0, 0);
expect('coal bought from the small seller instead', bought(m, FREE, 'coal'), 1);

// Relations scale what a buyer counts landing a seller's cargo as costing: -50 doubles it, +100 halves it; the seller cheapest to land sells the most.
const landed = (seller, buyer, relations, index = new Map()) => res.landedCost(res.routeOf(w, seller, buyer, 'coal', index), relations, res.GOODS_VALUE.coal);
// What a buyer bought of coal from a seller.
const from = (m, buyer, seller) => m.trade.get(buyer).from.coal?.[seller] ?? 0;
view(FREE, EXPORT, -50);
view(FREE, FREE2, 100);
m = res.tradeMarket(w, new Map(Object.entries({ [EXPORT]: { yields: { coal: 10 } }, [FREE2]: { yields: { coal: 4 } }, [FREE]: { demand: { coal: 2 } } }).map(([id, b]) => [id, { yields: b.yields || {}, demand: b.demand || {}, fedPeople: 0 }])), new Map());
m.run(['coal']);
let first = landed(FREE2, FREE, 100) <= landed(EXPORT, FREE, -50) ? FREE2 : EXPORT;
const freeWants = 2 * res.tradeTermsOf(w, FREE).fill;
expect('the seller cheapest to land sells the most', Number(from(m, FREE, first) >= from(m, FREE, first === FREE2 ? EXPORT : FREE2)), 1);
expect('and the buyer is filled, a free trader beyond its need', bought(m, FREE, 'coal'), freeWants);
view(FREE, EXPORT, 0);
view(FREE, FREE2, 0);

// Short worldwide: the buyer cheapest to land at is served first, the other takes what is left.
m = market({ [EXPORT]: { yields: { coal: 5 }, demand: { iron: 5 } }, [LIMITED]: { demand: { iron: 5 } }, [FREE]: { yields: { iron: 5 } } });
const ironTo = (buyer) => res.landedCost(res.routeOf(w, FREE, buyer, 'iron', new Map()), 0, res.GOODS_VALUE.iron);
first = ironTo(EXPORT) <= ironTo(LIMITED) ? EXPORT : LIMITED;
expect('the buyer cheapest to land at is served first', bought(m, first, 'iron'), Math.min(5, 5 * Math.min(1, res.tradeTermsOf(w, first).fill)));
expect('all the iron is sold', bought(m, EXPORT, 'iron') + bought(m, LIMITED, 'iron'), 5);

// Tariffs: a hand-made index, the buyer charging 25% on one seller's coal.
const charging = (buyer, seller, kind, rate) => new Map([[buyer, { ceilings: { resources: 1, equipment: 1, consumerGoods: 1 }, rates: new Map([[seller + '|' + kind, rate]]) }]]);
const taxed = (bags, index, kinds = ['coal']) => {
  const out = new Map(Object.entries(bags).map(([id, b]) => [id, { yields: b.yields || {}, demand: b.demand || {}, fedPeople: 0 }]));
  const x = res.tradeMarket(w, out, index);
  x.run(kinds);
  return x;
};
const route = res.routeOf(w, EXPORT, FREE, 'coal', charging(FREE, EXPORT, 'coal', 0.25));
// Stops a route makes in a country.
const stopsIn = (r, id) => r.stops.filter((c) => c === id).length;
// A stop's call costs more at a small port, so the tariff there does too.
const callsIn = (r, id) => r.stops.reduce((a, c, i) => a + (c === id ? r.calls[i] : 0), 0);
expect('route cost: 25% at each stop in the buyer, by its port', route.cost - route.untaxed, 800 * 0.25 * callsIn(route, FREE));
// Landed cost: the value with the tariffs along the route, and the shipping at POINT_DOLLARS a point, over 1 plus relations/100.
expect('landed cost at 0 relations: value with tariffs, and shipping', res.landedCost(route, 0, 1000), 1000 * (1 + route.rates.reduce((a, n) => a + n, 0)) + route.untaxed * res.POINT_DOLLARS);
const flat = { cost: 1000, untaxed: 1000, rates: [0] };
expect('shipping 1000 points costs $100', res.landedCost(flat, 0, 0), 100);
expect('+100 relations halves the landed cost', res.landedCost(flat, 100, 900), 500);
expect('-50 relations doubles the landed cost', res.landedCost(flat, -50, 900), 2000);
expect('10% and 15% at two stops charge 25% on the value', res.landedCost({ ...flat, rates: [0.1, 0.15] }, 0, 1000), 1350);
expect('gold is worth more than coal a unit', Number(res.GOODS_VALUE.gold > res.GOODS_VALUE.coal), 1);
// Sellers within SHARE_BAND of the cheapest share the order.
m = taxed({ [FREE]: { yields: { gold: 10 } }, [FREE2]: { yields: { gold: 10 } }, [EXPORT]: { demand: { gold: 4 } } }, new Map(), ['gold']);
expect('two gold sellers at near the same landed cost both sell', Number((m.trade.get(EXPORT).from.gold?.[FREE] ?? 0) > 0 && (m.trade.get(EXPORT).from.gold?.[FREE2] ?? 0) > 0), 1);
// Two sellers, 10 and 4; the cheaper to land sells first, a tariff counting in the cost.
const bags = (want) => ({ [FREE]: { yields: { coal: 10 } }, [FREE2]: { yields: { coal: 4 } }, [EXPORT]: { demand: { coal: want } } });
const exportWants = 5 * Math.min(1, res.tradeTermsOf(w, EXPORT).fill);
m = taxed(bags(5), new Map());
first = landed(FREE, EXPORT, 0) <= landed(FREE2, EXPORT, 0) ? FREE : FREE2;
expect('untaxed: the seller cheaper to land sells the most', Number(from(m, EXPORT, first) >= from(m, EXPORT, first === FREE ? FREE2 : FREE)), 1);
const tax = charging(EXPORT, first, 'coal', 1);
m = taxed(bags(5), tax);
const second = first === FREE ? FREE2 : FREE;
const after = landed(first, EXPORT, 0, tax) <= landed(second, EXPORT, 0, tax) ? first : second;
expect('a tariff counts in which seller lands cheaper', Number(from(m, EXPORT, after) >= from(m, EXPORT, after === first ? second : first)), 1);
expect('and the buyer is filled', bought(m, EXPORT, 'coal'), exportWants);
m = taxed(bags(12), tax);
expect('a buyer wanting more than either has is filled from both', bought(m, EXPORT, 'coal'), Math.min(14, 12 * Math.min(1, res.tradeTermsOf(w, EXPORT).fill)));
m = taxed({ [EXPORT]: { yields: { coal: 100 } }, [FREE]: { demand: { coal: 10 } } }, charging(FREE, EXPORT, 'coal', 1));
expect('a sole seller at 100% still fills', bought(m, FREE, 'coal'), 12);
// No sale under MIN_LOT, but a buyer whose whole need is under it buys that in one lot.
m = taxed({ [FREE]: { yields: { coal: 10 } }, [FREE2]: { yields: { coal: 10 } }, [EXPORT]: { demand: { coal: 0.05 } } }, new Map());
expect('a buyer needing under MIN_LOT still buys it', bought(m, EXPORT, 'coal'), 0.05 * Math.min(1, res.tradeTermsOf(w, EXPORT).fill));
expect('and from one seller', Object.keys(m.trade.get(EXPORT).from.coal || {}).length, 1);
m = taxed({ [FREE]: { yields: { coal: 10 } }, [FREE2]: { yields: { coal: 10 } }, [EXPORT]: { demand: { coal: 0.25 } } }, new Map());
expect('no sale under MIN_LOT to a buyer needing more', Object.values(m.trade.get(EXPORT).from.coal || {}).filter((n) => n < res.MIN_LOT - 1e-9).length, 0);
// Revenue at each stop in the buyer: 80 x rate x units.
m = taxed({ [EXPORT]: { yields: { coal: 100 } }, [FREE]: { demand: { coal: 10 } } }, charging(FREE, EXPORT, 'coal', 0.25));
expect('tariff earned on 12 coal at 25%', m.trade.get(FREE).tariffs, 80 * 0.25 * 12 * stopsIn(route, FREE));
expect('tariff paid by the seller', m.trade.get(EXPORT).tariffsPaid, 80 * 0.25 * 12 * stopsIn(route, FREE));
expect('tariff on another good', taxed({ [EXPORT]: { yields: { iron: 100 } }, [FREE]: { demand: { iron: 10 } } }, charging(FREE, EXPORT, 'coal', 0.25), ['iron']).trade.get(FREE).tariffs, 0);
// The narrowest entry stands: a country before every country, a good before its class.
const wide = { ceilings: { resources: 1, equipment: 1, consumerGoods: 1 }, rates: new Map([['all|all', 0.05], [`all|oil`, 0.2], [`${EXPORT}|resources`, 0]]) };
expect('every country, oil', res.tariffRate(w, wide, FREE2, 'oil'), 0.2);
expect('every country, iron', res.tariffRate(w, wide, FREE2, 'iron'), 0.05);
expect('one country, oil', res.tariffRate(w, wide, EXPORT, 'oil'), 0);
expect('one country, consumer goods', res.tariffRate(w, wide, EXPORT, 'consumerGoods'), 0.05);

// Ceilings: the law's, or a spirit's per class.
const restore = new Map([FREE, EXPORT, CLOSED, 'EPT'].map((id) => [id, { laws: { ...w.government.byPolity.get(id).laws }, tariffs: w.government.byPolity.get(id).tariffs }]));
// Tables cleared for the cases below.
for (const id of restore.keys()) w.government.byPolity.get(id).tariffs = [];
worldChanged();
const throws = (what, fn) => {
  let thrown = false;
  try { fn(); } catch { thrown = true; }
  expect(what, Number(thrown), 1);
};
expect('free trade ceiling', res.tariffCeilings(w, FREE).resources, 0.1);
expect('export focus ceiling', res.tariffCeilings(w, EXPORT).equipment, 0.25);
expect('El Puerto ceiling on resources', res.tariffCeilings(w, 'EPT').resources, 0);
expect('El Puerto ceiling on consumer goods', res.tariffCeilings(w, 'EPT').consumerGoods, 0);
expect('El Puerto ceiling on equipment', res.tariffCeilings(w, 'EPT').equipment, 0.1);
throws('20% under free trade refused', () => game.setTariff(FREE, 'all', 'coal', 0.2));
throws('El Puerto 5% on oil refused', () => game.setTariff('EPT', 'all', 'oil', 0.05));
game.setTariff('EPT', 'all', 'all', 0.1);
expect('El Puerto 10% on everything charges oil', res.tariffRate(w, res.tariffsToday(w).get('EPT'), FREE, 'oil'), 0);
expect('El Puerto 10% on everything charges equipment', res.tariffRate(w, res.tariffsToday(w).get('EPT'), FREE, 'infantryEquipment'), 0.1);
game.setTariff(EXPORT, 'all', 'coal', 0.25);
expect('export focus 25% on coal', game.tariffs(EXPORT).rates[0].rate, 0.25);
game.setLaw(EXPORT, 'trade', 'Free trade');
expect('moved to free trade, clamped to 10%', game.tariffs(EXPORT).rates[0].rate, 0.1);

// Most favoured nation: one rate for every country, except in a closed economy.
game.setTariff(FREE, EXPORT, 'coal', 0.05);
expect('free trader may tax one country', Number(game.tariffs(FREE).rates.some((x) => x.target === EXPORT && x.product === 'coal' && x.rate === 0.05)), 1);
game.setTariff(FREE, EXPORT, 'coal', 0);
game.setTariff(CLOSED, FREE, 'coal', 0.5);
expect('closed economy taxing one country', game.tariffs(CLOSED).rates.find((x) => x.target === FREE)?.rate, 0.5);
game.setLaw(CLOSED, 'trade', 'Limited exports');
expect('opened, the one-country rate kept', game.tariffs(CLOSED).rates.length, 1);
game.setTariff(FREE, 'all', 'coal', 0.1);
game.setTariff(FREE, 'all', 'coal', 0);
expect('a rate lifted to 0 leaves the table', game.tariffs(FREE).rates.length, 0);

// Revenue in the books: raised by trade income, and remitted with tax.
const ledger = (id, tariffs) => {
  const was = live.lastSupply.get(id);
  live.lastSupply.set(id, { ...(was || {}), trade: { ...(was?.trade || {}), tariffs } });
  const b = nation.dailyBooks(w, 0).get(id);
  if (was) live.lastSupply.set(id, was); else live.lastSupply.delete(id);
  return b;
};
const income = (id) => 1 + nation.nationalModifier(w, id, 'tradeIncome');
let b0 = ledger(FREE, 0), b1 = ledger(FREE, 1000);
expect('tariff revenue booked', b1.tariffs, 1000 * income(FREE));
expect('tariff revenue in the total', b1.revenue - b0.revenue, 1000 * income(FREE));
const MEMBER = [...w.government.byPolity.keys()].find((id) => { const p = w.table.polityById.get(id)?.parent; return p && p !== id && live.lastSupply.has(id) && !nation.colonyHolder(w, id); });
const parent = w.table.polityById.get(MEMBER).parent;
b0 = ledger(MEMBER, 0); b1 = ledger(MEMBER, 1000);
expect(`member ${MEMBER} remits its tariffs to ${parent} at the tax share`, b1.realmOut - b0.realmOut, 1000 * income(MEMBER) * nation.REALM_SHARE * (1 + nation.nationalModifier(w, parent, 'revenueFromMembers')));
const COLONY = [...w.government.byPolity.keys()].find((id) => nation.colonyHolder(w, id) && live.lastSupply.has(id));
b0 = ledger(COLONY, 0); b1 = ledger(COLONY, 1000);
if (COLONY) expect(`colony ${COLONY} remits its tariffs at the colonial share`, b1.colonialOut - b0.colonialOut, 1000 * income(COLONY) * nation.COLONIAL_SHARE * (1 + nation.nationalModifier(w, nation.colonyHolder(w, COLONY), 'revenueFromColonies')));

// Bunkering at each stop in the buyer: $80 a unit, the state's share by what it owns of coal and oil.
const plainRoute = res.routeOf(w, EXPORT, FREE, 'coal', new Map());
const calls = stopsIn(plainRoute, FREE);
const stops = (bags, owned, kinds = ['coal']) => {
  const g = w.government.byPolity.get(FREE), was = g.stateOwned;
  g.stateOwned = owned;
  const x = taxed(bags, new Map(), kinds);
  if (was) g.stateOwned = was; else delete g.stateOwned;
  return x.trade.get(FREE);
};
const toFree = { [EXPORT]: { yields: { coal: 100 } }, [FREE]: { demand: { coal: 10 } } };
for (const [owned, share] of [[[], 0], [['coal'], 0.7], [['oil'], 0.3], [['coal', 'oil'], 1]]) {
  const t = stops(toFree, owned);
  expect(`bunkering on 12 coal landed, state owning [${owned}]`, t.bunkering, 80 * 12 * calls);
  expect(`state fuel sales on 12 coal landed, state owning [${owned}]`, t.fuelSales, 80 * 12 * calls * share);
}
let t = stops(toFree, []);
expect('coal burnt at the stops on 12 landed', t.fuelBurnt.coal, 0.007 * 12 * calls);
expect('oil burnt at the stops on 12 landed', t.fuelBurnt.oil, 0.003 * 12 * calls);
expect('bunkering at the seller only where the route calls there', taxed(toFree, new Map()).trade.get(EXPORT).bunkering, 80 * 12 * stopsIn(plainRoute, EXPORT));
const OWNED_COAL = res.tradeTerms(w, OWNED).owns('coal') && !res.tradeTerms(w, OWNED).owns('oil');
m = taxed({ [FREE]: { yields: { iron: 100 } }, [OWNED]: { demand: { iron: 10 } } }, new Map(), ['iron']);
if (OWNED_COAL && m.trade.get(OWNED).landed) expect(`${OWNED} (coal state-owned) sells 70% of its bunkering`, m.trade.get(OWNED).fuelSales, 0.7 * m.trade.get(OWNED).bunkering);
// In the books: fuel sales as trade income, corporate tax on the rest, both raised by trade income.
const booked = (id, trade) => {
  const was = live.lastSupply.get(id);
  live.lastSupply.set(id, { ...(was || {}), trade: { ...(was?.trade || {}), tariffs: 0, ...trade } });
  const b = nation.dailyBooks(w, 0).get(id);
  if (was) live.lastSupply.set(id, was); else live.lastSupply.delete(id);
  return b;
};
const corporate = { ...w.government.byPolity.get(FREE).laws };
for (const [law, rate] of [['Moderate taxation', 0.2], ['Minimal taxation', 0.06], ['Low taxation', 0.12], ['High taxation', 0.3], ['Punitive taxation', 0.4]]) {
  w.government.byPolity.get(FREE).laws = { ...corporate, corporateTax: law };
  worldChanged();
  for (const share of [0, 0.7, 1]) {
    b0 = booked(FREE, { bunkering: 0, fuelSales: 0 }); b1 = booked(FREE, { bunkering: 1000, fuelSales: 1000 * share });
    expect(`fuel sales booked at ${share * 100}% state-owned`, b1.fuelSales, 1000 * share * income(FREE));
    expect(`bunkering tax at ${law}, ${share * 100}% state-owned`, b1.bunkeringTax, 1000 * (1 - share) * rate * income(FREE));
    expect(`bunkering in the total at ${law}, ${share * 100}% state-owned`, b1.revenue - b0.revenue, 1000 * income(FREE) * (share + (1 - share) * rate));
  }
}
w.government.byPolity.get(FREE).laws = corporate;
worldChanged();
const trade = (id) => booked(id, { bunkering: 1000, fuelSales: 700 });
const fromTrade = (id) => 1000 * income(id) * (0.7 + 0.3 * nation.bunkeringRate(w, id));
b0 = booked(MEMBER, { bunkering: 0, fuelSales: 0 }); b1 = trade(MEMBER);
expect(`member ${MEMBER} remits fuel sales and bunkering tax at the tax share`, b1.realmOut - b0.realmOut, fromTrade(MEMBER) * nation.REALM_SHARE * (1 + nation.nationalModifier(w, parent, 'revenueFromMembers')));
if (COLONY) {
  b0 = booked(COLONY, { bunkering: 0, fuelSales: 0 }); b1 = trade(COLONY);
  expect(`colony ${COLONY} remits fuel sales and bunkering tax at the colonial share`, b1.colonialOut - b0.colonialOut, fromTrade(COLONY) * nation.COLONIAL_SHARE * (1 + nation.nationalModifier(w, nation.colonyHolder(w, COLONY), 'revenueFromColonies')));
}
// Fuel burnt at yesterday's stops is today's demand.
const yesterday = live.lastSupply.get(FREE);
const plainDay = res.dailySupply(w).get(FREE).demand;
live.lastSupply.set(FREE, { ...yesterday, trade: { ...yesterday.trade, fuelBurnt: { coal: yesterday.trade.fuelBurnt.coal + 7, oil: yesterday.trade.fuelBurnt.oil + 3 } } });
const fuelledDay = res.dailySupply(w).get(FREE).demand;
live.lastSupply.set(FREE, yesterday);
expect('coal demand from 1,000 units landed yesterday', fuelledDay.coal - (plainDay.coal || 0), 7);
expect('oil demand from 1,000 units landed yesterday', fuelledDay.oil - (plainDay.oil || 0), 3);

// Relations: -1 a month per 10% of the highest rate, in every taxed country's view, fading once lifted.
// Every other table set aside for these cases.
const setAside = new Map([...w.government.byPolity].filter(([id, g]) => id !== FREE && g.tariffs).map(([id, g]) => [id, g.tariffs]));
for (const id of setAside.keys()) delete w.government.byPolity.get(id).tariffs;
worldChanged();
game.setLaw(FREE, 'trade', 'Export focus');
game.setTariff(FREE, 'all', 'iron', 0.25);
game.setTariff(FREE, 'all', 'coal', 0.1);
const short = w.table.polityById.get(FREE).short || FREE;
const grudge = (id) => w.relationHistory?.[rel.voicedKey(w, id, FREE)]?.['tariffs by ' + short] ?? 0;
const before = [EXPORT, LIMITED].map(grudge);
for (let i = 0; i < 30; i++) rel.growHistory(w);
expect(`${EXPORT} view of ${FREE} after 30 days at 25%`, grudge(EXPORT) - before[0], -2.5);
expect(`${LIMITED} view of ${FREE} after 30 days at 25%`, grudge(LIMITED) - before[1], -2.5);
for (let i = 0; i < 2000; i++) rel.growHistory(w);
expect('capped', grudge(EXPORT), rel.TARIFF_CAP);
game.setTariff(FREE, 'all', 'iron', 0);
game.setTariff(FREE, 'all', 'coal', 0);
for (let i = 0; i < 365; i++) rel.growHistory(w);
expect('a year after lifting, 10 has faded', grudge(EXPORT), rel.TARIFF_CAP + 10);

for (const [id, x] of setAside) w.government.byPolity.get(id).tariffs = x;
for (const [id, x] of restore) { const g = w.government.byPolity.get(id); g.laws = x.laws; if (x.tariffs) g.tariffs = x.tariffs; else delete g.tariffs; }
for (const id of [EXPORT, LIMITED]) { const bag = w.relationHistory?.[rel.voicedKey(w, id, FREE)]; if (bag) delete bag['tariffs by ' + short]; }
worldChanged();

// Routes: by sea port to port, overland where there is no port, tariffs and bunkering at each stop, around enemies.
const routes = await import('../src/game/routes.js');
const { developmentOf } = await import('../src/game/province.js');
const sea = routes.seaGraph(w);
const isPort = (id) => sea.portAt[w.byId.get(id).index] >= 0;
const holder = (id) => { const p = w.byId.get(id); return p.occupier || p.owner; };
console.log(`  sea graph: ${sea.ports.length} ports, ${sea.edgeTo.length} legs, built in ${Math.round(sea.ms)}ms`);

// Two coastal countries trade by sea, putting into ports.
const far = res.routeOf(w, 'TVC', 'SAN', 'coal', new Map());
const sails = far.legs.filter((l) => l.mode === 'sea');
console.log(`  TVC to SAN: ${Math.round(far.km)} km, cost ${Math.round(far.cost)}, stops ${far.stops.join(' ')}`);
expect('TVC to SAN goes by sea', Number(sails.length > 0), 1);
expect('every sea leg ends at a port', sails.filter((l) => !isPort(l.from) || !isPort(l.to)).length, 0);
expect('every sea leg stops in the country holding its port', sails.filter((l) => l.stop !== holder(l.to)).length, 0);
expect('the route lands in the buyer', Number(far.stops.at(-1) === 'SAN'), 1);
// A crossing longer than PASSAGE_KM breaks at a port on the way, cheaper than one unbroken passage.
const sailed = sails.reduce((a, l) => a + l.km, 0);
const sailCost = sails.reduce((a, l) => a + routes.seaLeg(l.km), 0);
expect('TVC to SAN, longer than PASSAGE_KM, calls at a port on the way', Number(sailed > routes.PASSAGE_KM && sails.length >= 2), 1);
expect('the broken crossing costs less than one unbroken passage', Number(sailCost < routes.seaLeg(sailed)), 1);
// The plan's breaking, measured on this map's water: by God Vind and Costa Acero against straight across.
const depart = sails[0].from, arrive = sails.at(-1).to;
const planLegs = [[depart, 'god_vind_islands'], ['god_vind_islands', 'north_costa_acero'], ['north_costa_acero', arrive]].map(([a, b]) => routes.seaKm(w, a, b));
const direct = routes.seaKm(w, depart, arrive);
const broken = planLegs.reduce((a, k) => a + routes.seaLeg(k), 0);
console.log(`  ${depart} to ${arrive}: direct ${Math.round(direct)} km costs ${Math.round(routes.seaLeg(direct))}; by God Vind and Costa Acero ${planLegs.map(Math.round).join(', ')} km costs ${Math.round(broken)}; the route found sails ${Math.round(sailed)} km for ${Math.round(sailCost)}`);
expect('breaking at God Vind and Costa Acero beats the direct crossing', Number(broken < routes.seaLeg(direct)), 1);
expect('the route found is no dearer than that breaking', Number(sailCost <= broken + 1e-6), 1);

// A country with no port trades overland, crossing borders.
const land = routes.landGraph(w);
const portless = govIds.filter((id) => land.countryAt.has(id) && w.table.provinces.some((p) => p.owner === id) && !w.table.provinces.some((p) => p.owner === id && isPort(p.id)));
const INLAND = portless.find((id) => res.routeOf(w, id, 'SAN', 'coal', new Map()));
const inland = res.routeOf(w, INLAND, 'SAN', 'coal', new Map());
console.log(`  landlocked ${INLAND} to SAN: ${inland.legs.map((l) => l.mode + (l.stop ? '>' + l.stop : '')).join(' ')}`);
expect(`${INLAND} leaves by land`, Number(inland.legs[0].mode !== 'sea'), 1);
expect(`${INLAND}'s first stop is a border crossing`, Number(inland.legs.find((l) => l.stop)?.mode !== 'sea'), 1);
const NEXT = [...w.adjacency.get(w.table.provinces.find((p) => p.owner === INLAND).id)].map(holder).find((c) => c !== INLAND && land.countryAt.has(c) && res.routeOf(w, INLAND, c, 'coal', new Map()));
if (NEXT) {
  const near = res.routeOf(w, INLAND, NEXT, 'coal', new Map());
  expect(`${INLAND} to its neighbour ${NEXT} by land only`, near.legs.filter((l) => l.mode === 'sea').length, 0);
  expect(`${INLAND} to ${NEXT} stops at the border`, Number(near.stops.length >= 1 && near.stops.at(-1) === NEXT), 1);
}

// A transit country's tariff applies at its stops and moves the route's cost; bunkering lands there.
const offering = [FREE, FREE2, EXPORT, LIMITED];
let S, B, T, base;
for (const a of offering) for (const b of offering) {
  if (S || a === b) continue;
  const r = res.routeOf(w, a, b, 'coal', new Map());
  const t = r?.stops.find((c) => c !== a && c !== b);
  if (t) { S = a; B = b; T = t; base = r; }
}
console.log(`  transit: ${S} to ${B} stops in ${T} (${stopsIn(base, T)} times): ${base.stops.join(' ')}`);
const withTariff = res.routeOf(w, S, B, 'coal', charging(T, S, 'coal', 0.1));
expect(`${T}'s 10% raises the route's cost`, Number(withTariff.cost > base.cost), 1);
expect(`${T}'s 10% costs at most 80 points a stop`, Number(withTariff.cost <= base.cost + 80 * stopsIn(base, T) + 1e-6), 1);
expect(`the route still calling in ${T} is charged 10% there`, withTariff.rates.filter((n, i) => withTariff.stops[i] === T && n !== 0.1).length, 0);
m = taxed({ [S]: { yields: { coal: 100 } }, [B]: { demand: { coal: 10 } } }, charging(T, S, 'coal', 0.1));
const moved = sold(m, S, 'coal');
expect(`${T} earns its tariff at its stops`, m.trade.get(T)?.tariffs ?? 0, 80 * 0.1 * moved * stopsIn(withTariff, T));
expect(`${T} sells bunkering at its stops`, m.trade.get(T)?.bunkering ?? 0, 80 * moved * stopsIn(withTariff, T));
expect(`${T} burns the fuel it sells`, m.trade.get(T)?.fuelBurnt.coal ?? 0, 0.007 * moved * stopsIn(withTariff, T));
// A 100% tariff sends the route elsewhere where it can.
const steep = res.routeOf(w, S, B, 'coal', charging(T, S, 'coal', 1));
console.log(`  at 100% in ${T}: ${steep.stops.join(' ')}, cost ${Math.round(steep.cost)} against ${Math.round(base.cost)}`);
expect(`100% in ${T} costs no more than paying it at every stop`, Number(steep.cost <= base.cost + 800 * stopsIn(base, T) + 1e-6), 1);

// No route through a country at war with the buyer, nor through one embargoing the seller.
// A land leg runs through counties.
const countyHolder = (id) => { const c = w.counties.byId.get(id); return c.occupier || holder(c.province); };
const crossesT = (r) => r.stops.includes(T) || r.legs.some((l) => l.mode !== 'sea' && l.through.some((id) => countyHolder(id) === T));
const warsT = w.polityValues[T].atWar, warsB = w.polityValues[B].atWar;
w.polityValues[T].atWar = [...(warsT || []), B];
w.polityValues[B].atWar = [...(warsB || []), T];
const around = res.routeOf(w, S, B, 'coal', new Map());
console.log(`  ${T} at war with ${B}: ${around ? around.stops.join(' ') : 'no route'}`);
expect(`no route through ${T} at war with the buyer ${B}`, Number(around === null || !crossesT(around)), 1);
w.polityValues[T].atWar = warsT;
w.polityValues[B].atWar = warsB;
const viewed = live.lastRelations.get(T + '>' + S);
live.lastRelations.set(T + '>' + S, { value: -100 });
const embargoed = res.routeOf(w, S, B, 'coal', new Map());
expect(`no route through ${T} embargoing the seller ${S}`, Number(embargoed === null || !crossesT(embargoed)), 1);
if (viewed) live.lastRelations.set(T + '>' + S, viewed); else live.lastRelations.delete(T + '>' + S);
expect(`${S} to ${B} through ${T} again once at peace`, Number(crossesT(res.routeOf(w, S, B, 'coal', new Map()))), 1);

for (const id of ids) w.polityValues[id].atWar = wars[id];
for (const [k, x] of views) if (x) live.lastRelations.set(k, x); else live.lastRelations.delete(k);

// Ports: coastal provinces with a city or a naval dockyard.
const cityAt = new Set((w.cities || []).map((c) => c.province));
const yardAt = new Set([...w.counties.byId.values()].filter((c) => c.dockyard).map((c) => c.province));
expect('ports without a city or a dockyard', sea.ports.filter((p) => !cityAt.has(w.atIndex[p].id) && !yardAt.has(w.atIndex[p].id)).length, 0);
expect('ports are coastal', sea.ports.filter((p) => !sea.coast.includes(p)).length, 0);
console.log(`  ${sea.ports.length} ports of ${sea.coast.length} coastal provinces`);
// A sea leg berths at its port's city or dockyard.
const quayed = sails.filter((l) => { const q = sea.quay[sea.portAt[w.byId.get(l.to).index]]; return q[0] !== w.byId.get(l.to).centre[0] || q[1] !== w.byId.get(l.to).centre[1]; }).length;
expect('TVC to SAN berths off province centres', Number(quayed > 0), 1);
// Arctic water counts 2.5 a km, open water 1, a busy lane down to 1 less LANE_PULL.
expect('no leg counts less than its km less the lane pull', Array.from(sea.edgeWorked).filter((x, e) => x < (1 - routes.LANE_PULL) * sea.edgeKm[e] - 1e-3).length, 0);
expect('no leg counts more than 2.5 a km', Array.from(sea.edgeWorked).filter((x, e) => x > routes.ARCTIC_RESISTANCE * sea.edgeKm[e] + 1e-3).length, 0);
expect('some legs cross Arctic water', Number(Array.from(sea.edgeWorked).some((x, e) => x > sea.edgeKm[e] * 1.01)), 1);
// A call at a small port costs more, up to PORT_MAX; at a port of an entrepot spirit's holder it costs ENTREPOT_FACTOR.
expect('a call at a port of PORT_REF people', routes.portFactor(routes.PORT_REF), 1);
expect('a call at a port of PORT_REF / 4 people', routes.portFactor(routes.PORT_REF / 4), 2);
expect('a call at a port of 100 people', routes.portFactor(100), routes.PORT_MAX);
expect('a call at a port of PORT_REF people at twice PORT_DEVELOPMENT', routes.portFactor(routes.PORT_REF, 2 * routes.PORT_DEVELOPMENT), 1);
expect('a call at a port of PORT_REF people at a quarter of PORT_DEVELOPMENT', routes.portFactor(routes.PORT_REF, routes.PORT_DEVELOPMENT / 4), 2);
const tagged = w.government.spirits.spirits.filter((x) => (x.tags || []).includes(routes.ENTREPOT)).map((x) => x.id);
const entrepots = [...w.government.byPolity].filter(([, g]) => (g.spirits || []).some((x) => tagged.includes(x))).map(([id]) => id);
const theirPorts = sea.ports.map((p, i) => [p, i]).filter(([p]) => entrepots.includes(w.atIndex[p].owner));
console.log(`  entrepot spirits ${tagged.join(', ')}, held by ${entrepots.join(' ')}; ${theirPorts.length} ports`);
expect('entrepot ports at ENTREPOT_FACTOR', theirPorts.filter(([, i]) => sea.factor[i] !== routes.ENTREPOT_FACTOR).length, 0);
expect('an entrepot port smaller than PORT_REF', Number(theirPorts.some(([p]) => (w.stats[w.atIndex[p].id]?.population || 0) < routes.PORT_REF)), 1);
// A route leaves from the seller's province with a city highest in development, density and nearness to its capital.
const hub = routes.hubOf(w, routes.landGraph(w), 'TVC');
const withCity = new Set(w.cities.map((t) => t.province));
const tvcCapital = w.byId.get(w.cities.find((c) => c.capital && w.byId.get(c.province)?.owner === 'TVC').province);
const hubScore = (p) => routes.hubScore(w, p, tvcCapital);
const tvcScores = w.atIndex.filter((p) => p?.owner === 'TVC' && withCity.has(p.id)).map(hubScore);
expect('TVC leaves from its highest scoring province', hubScore(w.atIndex[hub]), Math.max(...tvcScores));
// Warzones: occupied counties and fronts cost WARZONE_RESISTANCE times on land and at their ports, read again when a war starts.
const peace = routes.landGraph(w);
const warzonesNow = Array.from(peace.warAt).filter((x) => x > 1).length;
console.log(`  ${warzonesNow} warzone counties at the start`);
expect('warzones at the start', Number(warzonesNow > 0), 1);
const counties = [...w.counties.byId.values()];
expect('occupied counties are warzones', counties.filter((c) => (c.occupier || w.byId.get(c.province).occupier) && (c.occupier || w.byId.get(c.province).occupier) !== w.byId.get(c.province).owner && peace.warAt[c.index] !== routes.WARZONE_RESISTANCE).length, 0);
const neighbour = (a) => counties.filter((c) => countyHolder(c.id) === a && peace.warAt[c.index] === 1).flatMap((c) => [...w.counties.adjacency.get(c.id)].map(countyHolder)).find((x) => x && x !== a && land.countryAt.has(x));
const warsInland = w.polityValues[INLAND].atWar;
const foe = neighbour(INLAND);
w.polityValues[INLAND].atWar = [...(warsInland || []), foe];
const fronted = routes.landGraph(w);
const front = counties.filter((c) => countyHolder(c.id) === INLAND && [...w.counties.adjacency.get(c.id)].some((k) => countyHolder(k) === foe));
expect(`${INLAND} at war with ${foe}: the landGraph is read again`, Number(fronted !== peace), 1);
expect(`${INLAND}'s border with ${foe} is a front (${front.length} counties)`, Number(front.length > 0 && front.every((c) => fronted.warAt[c.index] === routes.WARZONE_RESISTANCE)), 1);
w.polityValues[INLAND].atWar = warsInland;
expect('at peace again, the fronts are gone', Array.from(routes.landGraph(w).warAt).filter((x) => x > 1).length, warzonesNow);

// The day the game ran: world totals bought equal sold, a closed economy is out, limited exports keeps 60%.
const day = res.dailySupply(w);
const totals = {};
for (const [, s] of day) {
  for (const [k, n] of Object.entries(s.trade.bought)) totals[k] = (totals[k] || 0) + n;
  for (const [k, n] of Object.entries(s.trade.sold)) totals[k] = (totals[k] || 0) - n;
}
for (const k of res.tradedKinds(w)) expect(`world ${k} bought less sold`, Math.round((totals[k] || 0) * 1e6) / 1e6, 0);
for (const k of res.tradedKinds(w)) expect(`world ${k} moved is what was bought`, Math.round((day.market[k].moved - [...day.values()].reduce((a, s) => a + (s.trade.bought[k] || 0), 0)) * 1e6) / 1e6, 0);
for (const id of [...w.government.byPolity.keys()].filter((x) => lawOf(x) === 'Closed economy' && day.has(x))) {
  expect(`${id} goods bought`, Object.keys(day.get(id).trade.bought).length, 0);
  expect(`${id} goods sold`, Object.keys(day.get(id).trade.sold).length, 0);
}
for (const [id, s] of day) {
  for (const k of Object.keys(s.trade.sold)) {
    if (k === 'fertileLand' || k === 'livestock' || k === 'fish') continue;
    const most = res.tradeTerms(w, id).offer(k) * ((s.yields[k] || 0) - (s.demand[k] || 0));
    if (s.trade.sold[k] > most + 1e-6) problems.push(['trade', new Error(`${id} sold ${s.trade.sold[k]} ${k}, more than the ${most} it offers`)]);
  }
  for (const k of ['tazkuri', 'goizederium']) if (s.trade.sold[k] || s.trade.bought[k]) problems.push(['trade', new Error(`${id} traded ${k}`)]);
  const owned = new Set([...(nation.realmAbove(w, id)?.stateOwned || []), ...(w.government.byPolity.get(id)?.stateOwned || [])]);
  for (const k of Object.keys(s.trade.sold)) if (owned.has(k)) problems.push(['trade', new Error(`${id} sold state-owned ${k}`)]);
  for (const k of Object.keys(s.trade.bought)) {
    for (const from of Object.keys(s.trade.from[k])) {
      if ((w.polityValues[id]?.atWar || []).includes(from)) problems.push(['trade', new Error(`${id} bought ${k} from ${from}, at war`)]);
    }
  }
}
// Every sale carries its route.
expect('every sale has a route', day.sales.filter((x) => !x.route).length, 0);
// Where goods start and end on the map: shares summing to 1, the capital for what no province holds.
const sumOf = (ends) => ends.reduce((a, [, n]) => a + n, 0);
const ends = [...day.keys()].flatMap((id) => res.tradedKinds(w).flatMap((k) => [res.tradeEnds(day.get(id), k, true), res.tradeEnds(day.get(id), k, false)]));
expect('every side of every good sums to 1', ends.filter((e) => Math.abs(sumOf(e) - 1) > 1e-9).length, 0);
const fedP = [...day.keys()].find((id) => day.get(id).places.demand.fertileLand?.size > 3);
expect(`${fedP}'s crops are wanted in its provinces`, Number(res.tradeEnds(day.get(fedP), 'fertileLand', false).filter(([p]) => p).length > 3), 1);
const units = day.sales.reduce((a, x) => a + x.amount, 0);
console.log(`  ${day.sales.length} sales, ${(day.sales.reduce((a, x) => a + x.amount * x.route.stops.length, 0) / units).toFixed(2)} stops a unit, ${Object.values(day.market).reduce((a, x) => a + x.unrouted, 0)} sellers without a route`);
const told = game.route('TVC', 'SAN');
console.log(`  game.route('TVC', 'SAN'): ${told.legs.length} legs, drawn from ${told.drawnFrom.join(', ')}`);
expect('game.route gives the legs and where the goods are drawn', Number(told.legs.length > 0 && told.drawnFrom.length > 0 && told.drawnTo.length > 0), 1);
const shown = game.trade(LIMITED);
console.log(`  game.trade('${LIMITED}'): ${Object.keys(shown.bought).length} goods bought, ${Object.keys(shown.sold).length} sold`);

// Shipments of leases and state agreements: their route's stops booked as market cargo, their bunkering and tariffs charged to the payer.
// The payer: the sender under CIF and with no terms, the receiver under FOB.
expect('no terms: the sender pays', Number(res.shippingPayer({}, S, B) === S), 1);
expect('CIF: the sender pays', Number(res.shippingPayer({ terms: 'CIF' }, S, B) === S), 1);
expect('FOB: the receiver pays', Number(res.shippingPayer({ terms: 'FOB' }, S, B) === B), 1);
// What each country on a route takes from a shipment of n: $80 a unit at each stop, and its tariff but at the payer's own stops.
const takenBy = (r, n, payer) => {
  const out = new Map();
  r.stops.forEach((c, i) => {
    for (const { stop, rate, share } of r.shares?.[i] || [{ stop: c, rate: r.rates[i], share: 1 }]) {
      const e = out.get(stop) || { bunkering: 0, tariffs: 0 };
      e.bunkering += 80 * n * share;
      if (stop !== payer) e.tariffs += 80 * rate * n * share;
      out.set(stop, e);
    }
  });
  return out;
};
const sum = (map, key) => [...map.values()].reduce((a, e) => a + e[key], 0);
// 30 coal from S to B through T at 10%, and B charging 10% on it as well.
const index2 = new Map([...charging(T, S, 'coal', 0.1), ...charging(B, S, 'coal', 0.1)]);
const shipRoute = res.routeOf(w, S, B, 'coal', index2);
for (const [terms, payer, other] of [['CIF', S, B], ['FOB', B, S]]) {
  const tr = new Map();
  res.bookStops(w, tr, shipRoute, 30, S, 'coal', null, res.shippingPayer({ terms }, S, B));
  const want = takenBy(shipRoute, 30, payer);
  expect(`${terms}: ${T} earns its tariff at its stops`, tr.get(T).tariffs, 80 * 0.1 * 30 * stopsIn(shipRoute, T));
  expect(`${terms}: ${T} sells bunkering at its stops`, tr.get(T).bunkering, 80 * 30 * stopsIn(shipRoute, T));
  expect(`${terms}: ${T} burns the fuel`, tr.get(T).fuelBurnt.coal, 0.007 * 30 * stopsIn(shipRoute, T));
  expect(`${terms}: ${B} charges its tariff only when it does not pay`, tr.get(B)?.tariffs ?? 0, want.get(B)?.tariffs ?? 0);
  expect(`${terms}: ${payer} pays every stop's bunkering and tariffs`, tr.get(payer).shipping, sum(want, 'bunkering') + sum(want, 'tariffs'));
  expect(`${terms}: the payer's shipping is what the stops booked`, tr.get(payer).shipping, [...tr.values()].reduce((a, t) => a + t.bunkering + t.tariffs, 0));
  expect(`${terms}: ${other} pays nothing`, tr.get(other)?.shipping ?? 0, 0);
  expect(`${terms}: no private tariffs paid by ${S}`, tr.get(S).tariffsPaid, 0);
  expect(`${terms}: ${payer}'s shipping by stop sums to its shipping`, Object.values(tr.get(payer).shippingTo).reduce((a, n) => a + n, 0), tr.get(payer).shipping);
  // In the books: the payer's shipping is the stops' trade income and the private fuel sellers' remainder, before trade income modifiers.
  const was = new Map([...tr.keys()].map((id) => [id, live.lastSupply.get(id)]));
  for (const [id, t] of tr) live.lastSupply.set(id, { ...(was.get(id) || {}), trade: t });
  const bk = nation.dailyBooks(w, 0);
  for (const [id, s] of was) if (s) live.lastSupply.set(id, s); else live.lastSupply.delete(id);
  expect(`${terms}: ${payer}'s shipping booked`, bk.get(payer).shipping, tr.get(payer).shipping);
  expect(`${terms}: ${other}'s shipping booked`, bk.get(other)?.shipping ?? 0, 0);
  const earned = [...tr.keys()].reduce((a, id) => {
    const b = bk.get(id), t = tr.get(id), raised = income(id);
    return a + (b.tariffs + b.fuelSales + b.bunkeringTax) / raised + (t.bunkering - t.fuelSales) * (1 - nation.bunkeringRate(w, id));
  }, 0);
  expect(`${terms}: shipping paid is trade income earned plus the private remainder`, Math.round(earned * 1e6) / 1e6, Math.round(tr.get(payer).shipping * 1e6) / 1e6);
}
// A day with a shipment due: lend lease from S to B every day, FOB, 30 coal gathered.
const warsS = w.polityValues[S].atWar, warsB2 = w.polityValues[B].atWar;
w.polityValues[S].atWar = []; w.polityValues[B].atWar = [];
const lent = { band: 'stateAgreement', first: S, second: B, good: 'coal', amount: 0, price: 0, since: '1900-01-01', every: 1, terms: 'FOB' };
w.government.relations.relations.push(lent);
res.gatherShipment(w, lent, 'goods', 'coal', 30, B);
const entry = w.shipments[res.shipmentKey(lent) + '|goods|coal'];
const sent = res.routeOf(w, S, B, 'coal');
const shipDay = res.dailySupply(w, true);
expect('the shipment is sent', entry.n, 0);
expect(`${B} pays the shipping on lend lease FOB`, shipDay.get(B).trade.shipping, sum(takenBy(sent, 30, B), 'bunkering') + sum(takenBy(sent, 30, B), 'tariffs'));
const drawn = shipDay.sales.find((x) => x.via === 'lend lease' && x.seller === S && x.buyer === B && x.kind === 'coal');
expect('lend lease drawn on the routes at what gathered today', drawn?.amount ?? 0, 30);
w.government.relations.relations.splice(w.government.relations.relations.indexOf(lent), 1);
delete w.shipments[res.shipmentKey(lent) + '|goods|coal'];
// With no route open, a shipment waits with its sender for a later day.
const LOST = govIds.find((id) => id !== S && w.polityValues[id] && !(w.polityValues[id].atWar || []).includes(S) && !res.routeOf(w, S, id, 'coal', new Map()));
if (LOST) {
  const stuck = { band: 'stateAgreement', first: S, second: LOST, good: 'coal', amount: 0, price: 0, since: '1900-01-01', every: 1 };
  w.government.relations.relations.push(stuck);
  res.gatherShipment(w, stuck, 'goods', 'coal', 30, LOST);
  const held = w.shipments[res.shipmentKey(stuck) + '|goods|coal'];
  const stuckDay = res.dailySupply(w, true);
  expect(`no route from ${S} to ${LOST}: the shipment waits`, held.n, 30);
  expect(`no route from ${S} to ${LOST}: nothing drawn`, stuckDay.sales.filter((x) => x.via && x.seller === S && x.buyer === LOST).length, 0);
  w.government.relations.relations.splice(w.government.relations.relations.indexOf(stuck), 1);
  delete w.shipments[res.shipmentKey(stuck) + '|goods|coal'];
} else console.log('  every country has a route from ' + S);
w.polityValues[S].atWar = warsS; w.polityValues[B].atWar = warsB2;

console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):\n`);
  for (const [where, err] of problems) console.log(`  [${where}] ${err.message}`);
  process.exitCode = 1;
} else {
  console.log('no problems');
}
process.exit();
