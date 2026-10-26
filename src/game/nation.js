// National figures: modifiers, stability, manpower, political power, command power and the treasury.

const VERSION = new URL(import.meta.url).search;
const { UNOWNED, isUnder, membersOf } = await import(`../world/mapdata.js${VERSION}`);
const { actKey, governingSupport, heldActs, industryKind, industryShares, nameOf, nationalSupport, ownedLabel } = await import(`./government.js${VERSION}`);
const { groundCost } = await import(`../world/ceilings.js${VERSION}`);
const { LEVELS, FACTORIES, BUILDINGS } = await import(`../world/provincestats.js${VERSION}`);
const { CLOCK_EPOCH, DAY_MS, clock, everyDay, forgetOnChange, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let actEffect, aidRecords, complianceOf, consumerShareOf, relationsBetween, depositsOf, heldYields, fillTokens, happinessOf, heldIdeology, label, lawLabel, occupiedFraction, populationOf, spiritById, taxMultiplier, unsettledShare, reparationsDue, activeLeases, activeAgreements, agreementPrice, shipmentDue, shipmentDays;
export function link(all) { ({ actEffect, aidRecords, complianceOf, consumerShareOf, relationsBetween, depositsOf, heldYields, fillTokens, happinessOf, heldIdeology, label, lawLabel, occupiedFraction, populationOf, spiritById, taxMultiplier, unsettledShare, reparationsDue, activeLeases, activeAgreements, agreementPrice, shipmentDue, shipmentDays } = all); }

// Sum of one modifier across everything a country carries.
function nationalModifier(w, polityId, key) {
  return nationalParts(w, polityId, key).reduce((a, [, n]) => a + n, 0);
}

// Itemised national modifier: each source's name and amount, cached per polity and key.
const nationalPartsBy = new Map();
forgetOnChange(() => nationalPartsBy.clear());
function nationalParts(w, polityId, key) {
  const at = polityId + '|' + key;
  if (!nationalPartsBy.has(at)) nationalPartsBy.set(at, nationalPartsOf(w, polityId, key));
  return nationalPartsBy.get(at);
}

function nationalPartsOf(w, polityId, key) {
  const g = w.government;
  if (!g) return [];
  const gov = g.byPolity?.get(polityId) || {};
  const members = membersOf(w.table, polityId)
    .filter((q) => g.byPolity.has(q.id))
    .map((q) => ({ id: q.id, population: populationOf(w, q.id) }));
  const people = members.reduce((a, m) => a + m.population, 0);
  if (!people) return partsUnder(w, gov, realmAbove(w, polityId), lawsFor(w, polityId), key);

  const summed = new Map();
  for (const m of members) {
    for (const [label, n, kind] of partsUnder(w, g.byPolity.get(m.id), null, lawsFor(w, m.id), key, gov)) {
      const at = kind + '|' + label;
      const line = summed.get(at) || [label, 0, kind];
      line[1] += n * m.population / people;
      summed.set(at, line);
    }
  }
  return [...partsUnder(w, gov, null, {}, key), ...summed.values()];
}

// One government entry's share of a modifier, with its realm's acts.
function partsUnder(w, gov, above, laws, key, skip = null) {
  const g = w.government;
  const out = [];
  const [head, tail] = key.split('.');
  // An act coming on or going off counts at its strength; except names effects it keeps elsewhere.
  const take = (label, kind, effects, strength = 1, except = null) => {
    if (except?.includes(head)) return;
    const v = tail === undefined ? effects?.[key] : effects?.[head]?.[tail];
    if (typeof v === 'number' && v !== 0 && strength) out.push([label, v * strength, kind]);
  };
  const heldBy = (list, x) => (list || []).some((y) => actKey(y) === actKey(x));
  const acts = (field) => [above, gov].flatMap((holder) => (holder?.[field] || [])
    .map((x) => [holder, x]))
    .filter(([, x], i, all) => all.findIndex(([, y]) => actKey(y) === actKey(x)) === i
      && !heldBy(skip?.[field], x));

  take(gov.startingIdeology, 'ideology', g.ideologies?.ideologies
    ?.find((i) => i.name === gov.startingIdeology)?.effects);
  for (const [cat, chosen] of Object.entries(laws)) {
    take(chosen + ' ' + (lawLabel(w, cat) || cat).toLowerCase(), 'law',
      g.laws?.categories?.[cat]?.options?.find((o) => o.name === chosen)?.effects);
  }
  for (const [, p] of acts('policies')) {
    take(nameOf(p), 'policy', g.policies?.policies?.find((x) => x.name === nameOf(p))?.effects, p?.strength ?? 1);
  }
  for (const [holder, d] of acts('decrees')) {
    const act = g.decrees?.decrees?.find((x) => x.name === nameOf(d));
    const effects = d?.expired
      ? Object.fromEntries(Object.entries(act?.effects || {})
        .filter(([k]) => (act?.permanent || []).includes(k)))
      : act?.effects;
    take(fillTokens(nameOf(d), d?.target, w.government, w.table?.polityById?.get(holder.id)),
      'decree', effects, d?.strength ?? 1);
  }
  // Acts that have left, going off.
  for (const holder of [above, gov]) {
    for (const f of holder?.fading || []) {
      const table = f.policy ? g.policies?.policies : g.decrees?.decrees;
      const act = table?.find((x) => x.name === nameOf(f));
      take(fillTokens(nameOf(f), f.target, w.government, w.table?.polityById?.get(holder.id)),
        f.policy ? 'policy' : 'decree', act?.effects, f.strength, f.except);
    }
  }
  const skipped = new Set(skip?.spirits || []);
  for (const id of new Set([...(above?.spirits || []), ...(gov.spirits || [])])) {
    if (skipped.has(id)) continue;
    const sp = spiritById(w, id);
    take(sp?.name || id, 'spirit', sp?.effects);
  }
  // Leaders of both the realm and the member count.
  for (const holder of [above, gov]) {
    if (!holder?.leader || holder.leader === skip?.leader) continue;
    const l = (g.leaders?.leaders || []).find((x) => x.id === holder.leader);
    take(l ? [l.title, l.name].filter(Boolean).join(' ') : holder.leader, 'leader', l?.effects);
  }
  // State-owned industries of the realm and the polity; targetYield is read per industry as targetYield.name.
  const own = g.decrees?.stateOwnership;
  if (own) {
    const unscaled = new Set(own.unscaled || []);
    const skippedOwned = new Set(skip?.stateOwned || []);
    const shares = gov.id ? industryShares(depositsOf(w, gov.id), g) : {};
    for (const i of new Set([...(above?.stateOwned || []), ...(gov.stateOwned || [])])) {
      if (skippedOwned.has(i)) continue;
      const figures = own.byTarget?.[industryKind(i)] || {};
      const n = head === 'targetYield' ? (tail === i ? figures.targetYield : 0)
        : unscaled.has(key) ? figures[key] : (figures[key] || 0) * (shares?.[i] ?? 1);
      if (typeof n === 'number' && n !== 0) out.push([ownedLabel(i), n, 'ownership']);
    }
  }
  return out;
}

// The realm's government entry above a member, or null.
function realmAbove(w, polityId) {
  const parent = w.table?.polityById?.get(polityId)?.parent;
  return parent && parent !== polityId ? w.government?.byPolity?.get(parent) || null : null;
}

// Laws a polity lives under: its own, then its realm's, then defaults.
function lawsFor(w, polityId) {
  const g = w.government;
  return heldActs(g?.byPolity?.get(polityId), realmAbove(w, polityId), g?.defaults).laws;
}

// Every province the polity holds, itself and everything under it.
const provincesUnderBy = new Map();
forgetOnChange(() => provincesUnderBy.clear());
function provincesUnder(w, polityId) {
  if (!w.table?.polityById) return [];
  if (!provincesUnderBy.has(polityId)) {
    provincesUnderBy.set(polityId, w.table.provinces.filter((q) => isUnder(w.table, q.owner, polityId)));
  }
  return provincesUnderBy.get(polityId);
}

// A country's stability, 0 to 100.
function stabilityOf(w, polityId) {
  return stabilityTerms(w, polityId).value;
}

// Stability's terms beyond the modifiers: rebel-held ground, debt and standing unrest.
function stabilityTerms(w, polityId) {
  const rebels = -50 * risenShare(w, polityId);
  const debt = debtStability(w, polityId);
  // A colony takes what its holder carries for its colonies.
  const holder = colonyHolder(w, polityId);
  const colonial = holder ? nationalModifier(w, holder, 'colonialStability') : 0;
  const held = 50 + nationalModifier(w, polityId, 'stability') + rebels + debt + colonial;

  // Unrest lowers stability, floored at 20.
  const unrest = nationalUnrestOf(w, polityId);
  const charge = 20 * Math.max(0, unrest - 30) / 70;
  const after = Math.max(Math.min(held, 20), held - charge);
  const value = Math.max(0, Math.min(100, after));
  return { rebels, debt, colonial, unrest: after - held, held: value - after, value };
}

// Population-weighted unrest across a country.
function nationalUnrestOf(w, polityId) {
  let people = 0, weighted = 0;
  for (const q of provincesUnder(w, polityId)) {
    const n = w.stats?.[q.id]?.population || 0;
    if (!n) continue;
    people += n;
    weighted += n * (w.stats?.[q.id]?.unrest || 0);
  }
  return people ? weighted / people : 0;
}

// Share of a country's people in rebel hands.
function risenShare(w, polityId) {
  const held = provincesUnder(w, polityId);
  if (!held.length) return 0;
  const mine = new Set(held.map((q) => q.id));
  let people = 0;
  for (const q of held) people += w.stats?.[q.id]?.population || 0;
  if (!people) return 0;

  let risen = 0;
  for (const [province, n] of rebelPeopleByProvince(w)) if (mine.has(province)) risen += n;
  return Math.min(1, risen / people);
}

// People in rebel-held counties, per province.
let rebelPeople = null;
forgetOnChange(() => { rebelPeople = null; });
function rebelPeopleByProvince(w) {
  if (rebelPeople) return rebelPeople;
  const counties = w.counties?.byId ? [...w.counties.byId.values()] : [];
  const perProvince = new Map();
  for (const c of counties) perProvince.set(c.province, (perProvince.get(c.province) || 0) + 1);
  rebelPeople = new Map();
  for (const c of counties) {
    if (!c.rebels) continue;
    const n = (w.stats?.[c.province]?.population || 0) / (perProvince.get(c.province) || 1);
    rebelPeople.set(c.province, (rebelPeople.get(c.province) || 0) + n);
  }
  return rebelPeople;
}

// Manpower pool, in men.
// Men serving in a polity's ships.
function crewsOf(w, polityId) {
  const hulls = w.production?.ships?.hulls || [];
  return (w.polityValues?.[polityId]?.fleet || [])
    .reduce((a, s) => a + (hulls.find((h) => h.id === s.hull)?.crew || 0), 0);
}

// Manpower lost on annexed ground still unsettled, at its most.
const UNSETTLED_MANPOWER = 0.8;
// An occupier's share of an occupied province's people under its conscription law, at no and at full compliance.
const OCCUPIED_MANPOWER = [0.02, 0.2];

function manpowerOf(w, polityId) {
  const g = w.government;
  const law = lawsFor(w, polityId).conscription || null;
  const share = g?.laws?.categories?.conscription?.options
    ?.find((o) => o.name === law)?.effects?.manpower;
  if (!share) return { share: 0, pool: 0, people: 0, occupied: 0, unsettled: 0, held: 0 };

  const others = nationalModifier(w, polityId, 'manpower') - share;
  const today = new Date(CLOCK_EPOCH + clock.day * DAY_MS);
  let people = 0, occupied = 0, unsettled = 0, held = 0;
  for (const q of provincesUnder(w, polityId)) {
    const st = w.stats?.[q.id] || {};
    const n = st.population || 0;
    const lost = n * occupiedFraction(w, q);
    people += n;
    occupied += lost;
    unsettled += (n - lost) * UNSETTLED_MANPOWER * unsettledShare(st, today);
  }
  // Ground it occupies abroad, by compliance.
  for (const q of w.table?.provinces || []) {
    if (q.occupier !== polityId || isUnder(w.table, q.owner, polityId)) continue;
    const frac = occupiedFraction(w, q);
    if (!(frac > 0)) continue;
    const st = w.stats?.[q.id] || {};
    const [low, high] = OCCUPIED_MANPOWER;
    held += (st.population || 0) * frac * (low + (high - low) * complianceOf(w, q, st));
  }
  const rate = share * (1 + others);
  const crews = crewsOf(w, polityId);
  return { share: rate, pool: Math.max(0, Math.round((people - occupied - unsettled + held) * rate - crews)), people, occupied, unsettled, held, crews };
}

// Formats a count of men for a panel row.
const menText = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M'
  : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n));

// Stability breakdown tooltip, act by act.
function stabilityTip(w, polityId, value) {
  const parts = [...nationalParts(w, polityId, 'stability')].sort((x, y) => y[1] - x[1]);
  const terms = stabilityTerms(w, polityId);
  const line = (label, n, cls, kind) => '<div class="cm-line"><span>'
    + (kind === 'spirit' ? '<i>' + label + '</i>' : label) + '</span><b'
    + (cls ? ' class="' + cls + '"' : '') + '>' + (n > 0 ? '+' : '') + Math.round(n)
    + '</b></div>';
  return '<b>Stability</b>'
    + '<div class="cm-line"><span>Base</span><b>50</b></div>'
    + parts.map(([label, n, kind]) => line(label, n, n > 0 ? 'up' : 'down', kind)).join('')
    + [['Rebel-held ground', terms.rebels], ['Debt', terms.debt], ['Standing unrest', terms.unrest], ['Held to 0 to 100', terms.held]]
      .filter(([, n]) => Math.round(n)).map(([label, n]) => line(label, n, n > 0 ? 'up' : 'down')).join('')
    + '<hr><div class="cm-line"><span>total</span><b>' + Math.round(value) + '</b></div>';
}

// Manpower pool breakdown tooltip.
function manpowerTip(w, polityId, m) {
  return '<b>Manpower</b>'
    + '<div class="cm-line"><span>population</span><b>' + menText(m.people) + '</b></div>'
    + [['occupied', -m.occupied], ['unsettled', -m.unsettled], ['held abroad', m.held], ['in ships', -(m.crews || 0) / (m.share || 1)]]
      .filter(([, n]) => Math.round(n)).map(([label, n]) => '<div class="cm-line"><span>' + label + '</span><b class="'
        + (n > 0 ? 'up' : 'down') + '">' + (n > 0 ? '+' : '−') + menText(Math.round(Math.abs(n))) + '</b></div>').join('')
    + '<div class="cm-line"><span>conscription</span><b>'
    + Number((m.share * 100).toFixed(1)) + '%</b></div>'
    + '<hr><div class="cm-line"><span>pool</span><b>' + menText(m.pool) + '</b></div>';
}

// Political power: base income and stock cap.
const POLITICAL_POWER_BASE = 2;
const POLITICAL_POWER_CAP = 2000;
// Improve relations: political power a day on the same compass point, and the distance at which it doubles.
const IMPROVE_COST = 0.2;
const IMPROVE_DISTANCE = 283;
// Sanctions: share of earned political power each one costs a day.
const SANCTION_COST = 0.02;

// Share of a country's people behind the ideology it holds, 0 to 100, cached per polity.
const governingSupportBy = new Map();
forgetOnChange(() => governingSupportBy.clear());
function governingSupportOf(w, polityId) {
  if (!governingSupportBy.has(polityId)) {
    const ideology = heldIdeology(w, polityId)?.name || null;
    const provinces = provincesUnder(w, polityId).map((q) => w.stats?.[q.id] || {});
    governingSupportBy.set(polityId, {
      ideology, support: ideology ? governingSupport(nationalSupport(provinces), ideology) : 0,
    });
  }
  return governingSupportBy.get(polityId);
}

// Daily political power income and the terms it is made of.
function politicalPowerOf(w, polityId) {
  const flat = nationalParts(w, polityId, 'politicalPowerPerDay');
  const percent = nationalParts(w, polityId, 'politicalPower');
  // Each Improve relations a country runs costs more the further apart the two stand on the compass.
  const actions = (w.government?.relations?.relations || []).filter((x) => x.band === 'improving' && x.first === polityId)
    .map((x) => ['improving relations with ' + x.second, -IMPROVE_COST * (1 + (relationsBetween(x.first, x.second)?.distance || 0) / IMPROVE_DISTANCE)]);
  const stability = stabilityOf(w, polityId);
  const { ideology, support } = governingSupportOf(w, polityId);
  const base = POLITICAL_POWER_BASE + flat.reduce((a, [, n]) => a + n, 0);
  const stabilityFactor = 1 + (stability - 50) / 100;
  const supportFactor = 0.75 + support / 200;
  const modifier = 1 + percent.reduce((a, [, n]) => a + n, 0);
  const earned = Math.max(0, base * stabilityFactor * supportFactor * modifier);
  for (const x of w.government?.relations?.relations || []) {
    if (x.band === 'sanctions' && x.first === polityId) actions.push(['sanctioning ' + x.second, -SANCTION_COST * earned]);
  }
  const daily = earned + actions.reduce((a, [, n]) => a + n, 0);
  return { daily, earned, actions, flat, percent, stability, stabilityFactor, ideology, support, supportFactor, modifier };
}

everyDay((w) => {
  for (const [id, values] of Object.entries(w.polityValues || {})) {
    if (!w.table?.polityById?.has(id)) continue;
    const { daily } = politicalPowerOf(w, id);
    values.politicalPower = Math.max(0, Math.min(POLITICAL_POWER_CAP, (values.politicalPower || 0) + daily));
  }
});

// Command power: base income, units per extra point, income cap and stock cap.
const COMMAND_POWER_BASE = 0.5;
const COMMAND_POWER_UNITS = 100;
const COMMAND_POWER_DAILY_CAP = 2;
const COMMAND_POWER_CAP = 100;

// Units a country fields; none until armies exist.
function unitsFielded(w, polityId) { return 0; }

// Occupation laws touching a modifier, once each, per occupier, cached.
const occupationPartsBy = new Map();
forgetOnChange(() => occupationPartsBy.clear());
function occupationParts(w, polityId, key) {
  if (!occupationPartsBy.has(key)) {
    const out = new Map();
    for (const p of w.table?.provinces || []) {
      if (!p.occupier || !(occupiedFraction(w, p) > 0)) continue;
      const seen = out.get(p.occupier) || new Map();
      for (const [name, n] of actEffect(w, p, key)) seen.set(name, n);
      out.set(p.occupier, seen);
    }
    occupationPartsBy.set(key, out);
  }
  return [...(occupationPartsBy.get(key).get(polityId) || [])];
}

// A polity's own share of a modifier; a realm leaves out its members'.
function ownParts(w, polityId, key) {
  if (!membersOf(w.table, polityId).length) return nationalParts(w, polityId, key);
  return partsUnder(w, w.government?.byPolity?.get(polityId) || {}, realmAbove(w, polityId), lawsFor(w, polityId), key);
}

// Daily command power income and the terms it is made of; a realm counts only its own.
function commandPowerOf(w, polityId) {
  const units = unitsFielded(w, polityId);
  const base = Math.min(COMMAND_POWER_DAILY_CAP, COMMAND_POWER_BASE + units / COMMAND_POWER_UNITS);
  const percent = [...ownParts(w, polityId, 'commandPowerIncome'), ...occupationParts(w, polityId, 'commandPowerIncome')];
  const modifier = 1 + percent.reduce((a, [, n]) => a + n, 0);
  const daily = Math.max(0, base * modifier);
  return { daily, units, base, percent, modifier };
}

everyDay((w) => {
  for (const [id, values] of Object.entries(w.polityValues || {})) {
    if (!w.table?.polityById?.has(id)) continue;
    values.commandPower = Math.min(COMMAND_POWER_CAP, (values.commandPower || 0) + commandPowerOf(w, id).daily);
  }
});

// Treasury rates, in $ a day.
const REALM_SHARE = 0.25;             // of a member's tax, paid to its realm at Moderate national tax
const COLONIAL_SHARE = 0.2;          // of a colony's tax, paid to its holder at Moderate colonial tax
const DEBT_INTEREST = 0.0002;         // of the debt
const GOLD_INTEREST = 1;              // extra interest at no gold at all, on the shortage curve
const OCCUPATION_HOLDING = 200;       // per occupied province, paid by the occupier
const MEDIAN_PROVINCE_KM2 = 40224;

// Money a day for each thing standing, from the construction list, cached per world.
let upkeepWorld = null, upkeepCache = null;
function upkeepRates(w) {
  if (upkeepWorld !== w) {
    const projects = w.production?.construction?.projects || [];
    const by = Object.fromEntries(projects.map((x) => [x.id, x]));
    upkeepCache = {
      rail: by.rail?.upkeep || 0,
      fortification: by.fortification?.upkeep || 0,
      levels: Object.fromEntries(LEVELS.map((k) => [k, by[k]?.upkeep || 0])),
      area: new Set(LEVELS.filter((k) => by[k]?.area)),
      factories: Object.fromEntries(projects.filter((x) => x.factory).map((x) => [x.factory, x.upkeep || 0])),
      buildings: Object.fromEntries(projects.filter((x) => x.building).map((x) => [x.building, x.upkeep || 0])),
    };
    upkeepWorld = w;
  }
  return upkeepCache;
}
const OCCUPIED_UPKEEP = 1.5;          // occupier's share of upkeep is dearer
const UNREST_UPKEEP = 1.25;           // at unrest 40 or above
// Stability lost as debt passes each multiple of a year's income.
const DEBT_STEPS = [[2, -30], [1, -15], [0.5, -5]];

// Product of a multiplier modifier across everything a country carries.
const nationalMultiplier = (w, id, key) => nationalParts(w, id, key).reduce((a, [, n]) => a * n, 1);

// The holder of a colony, or null for anything else.
function colonyHolder(w, id) {
  const holder = w.table?.polityById?.get(id)?.suzerain;
  return holder && w.government?.byPolity?.get(id)?.form === 'Colony' ? holder : null;
}

// One day of every country's books: revenue, expenditure and each line of both.
function dailyBooks(w, day) {
  const today = new Date(CLOCK_EPOCH + day * DAY_MS);
  const books = new Map();
  const of = (id) => {
    if (!books.has(id)) books.set(id, { tax: 0, realmIn: 0, realmOut: 0, colonialIn: 0, colonialOut: 0, rail: 0, maintenance: 0, occupation: 0, policies: 0, interest: 0, construction: 0, production: 0, fleet: 0, storage: 0, stateIndustry: 0, reparations: 0, reparationsIn: 0, rent: 0, rentIn: 0, agreements: 0, agreementsIn: 0 });
    return books.get(id);
  };

  for (const p of w.table?.provinces || []) {
    const st = w.stats?.[p.id];
    if (!st || !p.owner || p.owner === UNOWNED) continue;
    const people = (st.population || 0) / 1000 * (1 + nationalModifier(w, p.owner, 'revenueFromPeople'));
    const works = 1000 * (st.civilianFactories || 0) * (1 + nationalModifier(w, p.owner, 'revenueFromCivilianFactories'));
    const happy = happinessOf(w, p, st, today).value;
    const occupied = occupiedFraction(w, p);
    of(p.owner).tax += (people + works) * taxMultiplier(w, p, happy).value * (1 - occupied);
    if (occupied > 0 && p.occupier) of(p.occupier).occupation += OCCUPATION_HOLDING;
  }

  // Charges an amount to whoever keeps a province: the owner, and the occupier on its share.
  const keep = (p, line, base) => {
    const unrest = (w.stats?.[p.id]?.unrest || 0) >= 40 ? UNREST_UPKEEP : 1;
    const occupied = occupiedFraction(w, p);
    of(p.owner)[line] += base * unrest * (1 - occupied) * (1 + nationalModifier(w, p.owner, 'maintenance'));
    if (occupied > 0 && p.occupier) {
      of(p.occupier)[line] += base * unrest * occupied * OCCUPIED_UPKEEP * (1 + nationalModifier(w, p.occupier, 'maintenance'));
    }
  };
  // Development aid: builders and the levels they keep up, per province and kind.
  const aid = new Map();
  for (const x of aidRecords(w)) {
    if (!x.levels) continue;
    const kinds = aid.get(x.province) || new Map();
    kinds.set(x.infrastructure, [...(kinds.get(x.infrastructure) || []), [x.first, x.levels]]);
    aid.set(x.province, kinds);
  }
  // Units of each aided kind standing in a province: levels, railed counties, fort levels, buildings.
  const units = new Map();
  for (const c of aid.size ? w.counties?.byId?.values() || [] : []) {
    const kinds = aid.get(c.province);
    if (!kinds) continue;
    const n = units.get(c.province) || {};
    if (c.rail !== undefined) n.rail = (n.rail || 0) + 1;
    if (c.fortification) n.fortification = (n.fortification || 0) + c.fortification;
    for (const kind of BUILDINGS) if (c[kind]) n[kind] = (n[kind] || 0) + 1;
    units.set(c.province, n);
  }
  for (const id of aid.keys()) {
    const st = w.stats?.[id] || {};
    const n = units.get(id) || {};
    for (const k of LEVELS) n[k] = Array.isArray(st[k]) ? st[k][0] : Number(st[k]) || 0;
    units.set(id, n);
  }
  // Charges a builder its share of an aided kind's upkeep, and the rest, where kept, to whoever keeps the province.
  const keepAided = (p, line, base, kind, rest = true) => {
    let left = base;
    const total = units.get(p.id)?.[kind] || 0;
    for (const [by, n] of total ? aid.get(p.id)?.get(kind) || [] : []) {
      const share = Math.min(left, base * n / total);
      const unrest = (w.stats?.[p.id]?.unrest || 0) >= 40 ? UNREST_UPKEEP : 1;
      of(by)[line] += share * unrest * (1 + nationalModifier(w, by, 'maintenance'));
      left -= share;
    }
    if (left > 0 && rest) keep(p, line, left);
  };
  const rates = upkeepRates(w);
  // What the state owns, its realm's holdings included.
  const ownedBy = new Map();
  const owned = (id) => {
    if (!ownedBy.has(id)) ownedBy.set(id, new Set([...(realmAbove(w, id)?.stateOwned || []), ...(w.government?.byPolity?.get(id)?.stateOwned || [])]));
    return ownedBy.get(id);
  };
  const ground = new Map();   // province id -> [area-weighted ground, area]
  for (const c of w.counties?.byId?.values() || []) {
    const p = w.byId?.get(c.province);
    if (!p || !p.owner || p.owner === UNOWNED) continue;
    const g = ground.get(p.id) || [0, 0];
    g[0] += groundCost(c) * (c.area || 0); g[1] += c.area || 0;
    ground.set(p.id, g);
    for (const kind of BUILDINGS) if (c[kind] && rates.buildings[kind]) keepAided(p, 'maintenance', rates.buildings[kind], kind);
    if (c.fortification) keepAided(p, 'maintenance', rates.fortification * c.fortification * groundCost(c), 'fortification');
    // Private railways keep their own track; a builder keeps up what it built.
    if (c.rail !== undefined) keepAided(p, 'rail', rates.rail * groundCost(c), 'rail', owned(p.owner).has('rail'));
  }

  for (const p of w.table?.provinces || []) {
    const st = w.stats?.[p.id];
    if (!st || !p.owner || p.owner === UNOWNED) continue;
    const [weighted, area] = ground.get(p.id) || [0, 0];
    const groundMean = area ? weighted / area : 1;
    const areaTerm = Math.pow((p.area || MEDIAN_PROVINCE_KM2) / MEDIAN_PROVINCE_KM2, 0.25);
    let levels = 0;
    for (const k of LEVELS) {
      const built = Array.isArray(st[k]) ? st[k][0] : Number(st[k]) || 0;
      if (!built) continue;
      const cost = built * rates.levels[k] * (rates.area.has(k) ? areaTerm : 1);
      // A kind a builder keeps up is billed on its own.
      if (aid.get(p.id)?.has(k)) keepAided(p, 'maintenance', cost * groundMean, k);
      else levels += cost;
    }
    if (levels) keep(p, 'maintenance', levels * groundMean);
    let works = 0;
    // Private consumer-goods works keep themselves; the state keeps what it orders or owns.
    const kept = owned(p.owner).has('manufacturing') ? 1 : 1 - consumerShareOf(w, p.owner);
    for (const k of FACTORIES) works += (st[k] || 0) * (rates.factories[k] || 0) * (k === 'civilianFactories' ? kept : 1);
    if (works) keep(p, 'maintenance', works);
  }

  // State industry: the state pays to run what it owns, on the ground it controls.
  const running = w.government?.decrees?.stateOwnership?.runningCost || {};
  const runs = (p, amount) => {
    if (!amount) return;
    const unrest = (w.stats?.[p.id]?.unrest || 0) >= 40 ? UNREST_UPKEEP : 1;
    of(p.owner).stateIndustry += amount * unrest * (1 - occupiedFraction(w, p)) * (1 + nationalModifier(w, p.owner, 'maintenance'));
  };
  for (const p of w.table?.provinces || []) {
    const st = w.stats?.[p.id];
    if (!st || !p.owner || p.owner === UNOWNED || !owned(p.owner).size) continue;
    const held = owned(p.owner);
    if (held.has('manufacturing')) runs(p, (running.manufacturing || 0) * (st.civilianFactories || 0));
    for (const [kind, n] of Object.entries(heldYields(w, p, st))) {
      if (held.has(kind)) runs(p, (running[industryKind(kind)] || 0) * n);
    }
  }

  for (const [id, b] of books) {
    const parent = w.table?.polityById?.get(id)?.parent;
    if (!parent || parent === id) continue;
    b.realmOut = b.tax * REALM_SHARE * (1 + nationalModifier(w, parent, 'revenueFromMembers'));
    of(parent).realmIn += b.realmOut;
  }

  for (const [id, b] of [...books]) {
    const holder = colonyHolder(w, id);
    if (!holder) continue;
    b.colonialOut = b.tax * COLONIAL_SHARE * (1 + nationalModifier(w, holder, 'revenueFromColonies'));
    of(holder).colonialIn += b.colonialOut;
  }

  // Reparations: a fixed instalment, owed whatever the payer earns.
  for (const due of reparationsDue(w)) {
    if (!due.money || due.suspended) continue;
    of(due.payer).reparations += due.money;
    for (const [to, share] of Object.entries(due.to)) of(to).reparationsIn += due.money * share;
  }

  // State agreements at a price in money, paid by the receiver to the supplier for each shipment as it is sent, for the days it gathered.
  for (const x of activeAgreements(w)) {
    const money = (agreementPrice(x).money || 0) * shipmentDays(w, x);
    if (!money || !shipmentDue(x)) continue;
    of(x.second).agreements += money;
    of(x.first).agreementsIn += money;
  }

  // Lease rents, paid by the lessee to the lessor for each shipment as it is sent, for the days it gathered.
  for (const x of activeLeases(w)) {
    if (!x.rent?.money || !shipmentDue(x)) continue;
    const money = x.rent.money * shipmentDays(w, x);
    of(x.second).rent += money;
    of(x.first).rentIn += money;
  }

  for (const [id, values] of Object.entries(w.polityValues || {})) {
    if (!w.table?.polityById?.has(id)) continue;
    const b = of(id);
    const policies = w.government?.byPolity?.get(id)?.policies || [];
    const share = policies.reduce((a, x) => a + (w.government.policies?.policies
      ?.find((q) => q.name === nameOf(x))?.upkeep || 0), 0);
    b.revenue = b.tax + b.realmIn + b.colonialIn + b.reparationsIn + b.rentIn + b.agreementsIn;
    b.policies = b.revenue * share * (1 + nationalModifier(w, id, 'policyUpkeep'));
    const debt = Math.max(0, -(values.treasury || 0));
    // Short of gold, a country borrows on worse terms.
    const goldLost = 1 - (live.lastSupply?.get(id)?.kept?.gold ?? 1);
    b.interest = debt * DEBT_INTEREST * nationalMultiplier(w, id, 'interest') * (1 + GOLD_INTEREST * goldLost);
    // Yesterday's spending on the queues, ships in service and what is held in store.
    const made = live.lastProduction?.get(id);
    b.construction = made?.constructionMoney || 0;
    b.production = (made?.equipmentMoney || 0) + (made?.shipMoney || 0);
    b.fleet = made?.fleetUpkeep || 0;
    b.storage = (made?.stockpileStorage || 0) + (live.lastSupply?.get(id)?.storage || 0);
    b.expenditure = b.realmOut + b.colonialOut + b.rail + b.maintenance + b.occupation + b.policies + b.interest
      + b.construction + b.production + b.fleet + b.storage + b.stateIndustry + b.reparations + b.rent + b.agreements;
    b.net = b.revenue - b.expenditure;
  }
  return books;
}

// War weariness: days at war and the dead set the multiplier; at peace weariness falls and half the war is forgotten every three years.
const WEARINESS_DAYS = 720;
const WEARINESS_DAYS_CAP = 3;
const WEARINESS_DEATHS = 400;
const WEARINESS_PEACE_DECAY = 1;
const WEARINESS_HALF_LIFE = 1095;
everyDay((w) => {
  const halve = 0.5 ** (1 / WEARINESS_HALF_LIFE);
  for (const [id, v] of Object.entries(w.polityValues || {})) {
    if (!w.government?.byPolity?.has(id)) continue;
    if (v.atWar?.length) {
      v.daysAtWar = (v.daysAtWar || 0) + 1;
      v.wasAtWar = true;
    } else {
      v.weariness = Math.max(0, (v.weariness || 0) - WEARINESS_PEACE_DECAY);
      v.cumulativeDeaths = (v.cumulativeDeaths || 0) * halve;
      v.daysAtWar = (v.daysAtWar || 0) * halve;
      // The last war over, the ground stops counting its battles.
      if (v.wasAtWar) {
        for (const q of provincesUnder(w, id)) if (w.stats?.[q.id]) w.stats[q.id].struckAverage = 0;
        for (const c of w.counties?.byId?.values() || []) if (w.byId?.get(c.province)?.owner === id) delete c.struck;
        v.wasAtWar = false;
      }
    }
    const people = populationOf(w, id) || 1;
    const modifier = (v.wearinessModifier ?? 1) * nationalParts(w, id, 'wearinessModifier').reduce((a, [, n]) => a * (1 + n), 1);
    v.baseWeariness = (Math.min(WEARINESS_DAYS_CAP, (v.daysAtWar || 0) / WEARINESS_DAYS) + WEARINESS_DEATHS * (v.cumulativeDeaths || 0) / people) * modifier;
  }
});

// Last day's books per country, read by the debt penalty and the console.
live.lastBooks = new Map();

everyDay((w, day) => {
  live.lastBooks = dailyBooks(w, day);
  for (const [id, values] of Object.entries(w.polityValues || {})) {
    const b = live.lastBooks.get(id);
    if (b) values.treasury = (values.treasury || 0) + b.net;
  }
  // What was paid comes off what is owed.
  // A suspended party pays nothing and its instalment is owed as arrears.
  for (const due of reparationsDue(w)) {
    const money = due.terms.money;
    if (!money || !due.money) continue;
    if (due.suspended) money.arrears = (money.arrears || 0) + due.money;
    else money.outstanding = Math.max(0, money.outstanding - due.money);
  }
});

// Debt against a year of revenue, scaled by the debt allowance; 0 when not in debt.
function debtRatio(w, id) {
  const debt = -(w.polityValues?.[id]?.treasury || 0);
  if (debt <= 0) return 0;
  const income = live.lastBooks.get(id)?.revenue || 0;
  return income > 0 ? debt / (income * 365) / nationalMultiplier(w, id, 'debtThresholds') : Infinity;
}

// Stability lost to debt.
function debtStability(w, id) {
  const ratio = debtRatio(w, id);
  return DEBT_STEPS.find(([at]) => ratio > at)?.[1] || 0;
}

export { nationalModifier, nationalPartsBy, nationalParts, nationalPartsOf, partsUnder, realmAbove, lawsFor, provincesUnderBy, provincesUnder, stabilityOf, stabilityTerms, nationalUnrestOf, risenShare, rebelPeople, rebelPeopleByProvince, UNSETTLED_MANPOWER, OCCUPIED_MANPOWER, manpowerOf, menText, stabilityTip, manpowerTip, POLITICAL_POWER_BASE, POLITICAL_POWER_CAP, IMPROVE_COST, IMPROVE_DISTANCE, governingSupportBy, governingSupportOf, politicalPowerOf, COMMAND_POWER_BASE, COMMAND_POWER_UNITS, COMMAND_POWER_DAILY_CAP, COMMAND_POWER_CAP, unitsFielded, occupationPartsBy, occupationParts, ownParts, commandPowerOf, REALM_SHARE, COLONIAL_SHARE, DEBT_INTEREST, GOLD_INTEREST, OCCUPATION_HOLDING, MEDIAN_PROVINCE_KM2, upkeepRates, crewsOf, OCCUPIED_UPKEEP, UNREST_UPKEEP, DEBT_STEPS, nationalMultiplier, colonyHolder, dailyBooks, debtRatio, debtStability };
