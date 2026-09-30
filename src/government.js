/**
 * The compass, and everything derived from it.
 *
 * A country does not hold an ideology. It holds a form of government, a law in
 * each category, whatever policies and decrees it has enacted, and its position
 * is the sum of what those contribute. The name is a label for where that lands.
 *
 * Nothing here touches the DOM or the world. Every function takes the tables it
 * needs, so this module can be run under node against the JSON alone, which is
 * what the test does.
 */

/**
 * Where a country sits, before and after the pull toward what it already is.
 *
 * The raw sum on its own renames a country that decided nothing: a constitutional
 * monarchy making conservative choices adds up to a technocracy, because the
 * arithmetic has no memory of what the government thinks it is. So the sum is
 * pulled a quarter of the way back toward the ideology being held, which is what
 * `anchorPull` is for, and a country keeps its name until it stands more than
 * `escapeThreshold` inside another point's region.
 *
 * A realm member is governed twice over. Its own entry holds what it decides
 * for itself and its parent's holds what the realm decides for all of it, so
 * Fellnor and Avanta can sit on different points inside one empire while sharing
 * an army, a currency and a customs union. A polity with no parent passes null
 * and nothing changes.
 *
 * @param {object} gov     a polities-starting-government.json entry
 * @param {object} tables  { laws, policies, decrees, ideologies }
 * @param {?string} holding the ideology the country currently holds, or null
 * @param {?object} parent  the realm's entry, where this polity is a member
 * @returns {{raw: number[], position: number[], ideology: string, slots: number}}
 */
export function compass(gov, tables, holding = null, parent = null, shares = null,
  movements = null) {
  const { laws, policies, decrees, ideologies } = tables;
  let e = 0, a = 0;
  const add = (v) => { if (v) { e += v[0]; a += v[1]; } };

  const form = ideologies.forms.find((f) => f.name === gov.form);
  if (!form) throw new Error(`no form of government "${gov.form}"`);
  add([form.economic, form.authority]);

  // The realm's laws sit under the member's own, so a member that legislates a
  // category for itself overrides the realm and a member that does not takes it.
  // What the realm owns is owned in the members' ground too: Trinational RailLink
  // runs Athanasia's lines as much as Dimuro's, and actEffects already charges it
  // there, so the compass reads it there as well. Once each, where both hold it.
  gov = {
    ...gov,
    laws: { ...(parent?.laws || {}), ...(gov.laws || {}) },
    policies: [...(parent?.policies || []), ...(gov.policies || [])],
    decrees: [...(parent?.decrees || []), ...(gov.decrees || [])],
    stateOwned: [...new Set([...(parent?.stateOwned || []), ...(gov.stateOwned || [])])],
  };

  for (const [cat, chosen] of Object.entries(gov.laws || {})) {
    const c = laws.categories[cat];
    if (!c) throw new Error(`no law category "${cat}"`);
    const o = c.options.find((x) => x.name === chosen);
    if (!o) throw new Error(`no "${chosen}" in ${cat}`);
    add(o.compass);
  }
  for (const p of gov.policies || []) add(policies.policies.find((x) => x.name === nameOf(p))?.compass);
  for (const d of gov.decrees || []) {
    // A campaign that has run its course is finished and gone. What it left behind is
    // an effect, which actEffects keeps, not an act the government is still doing, so
    // it no longer moves the country.
    if (d?.expired) continue;
    const act = decrees.decrees.find((x) => x.name === nameOf(d));
    if (!act?.compass) continue;
    // Aimed at every movement at once a decree can be a different act from the one
    // it is aimed at one, and says so in `compassAll`. Disarming one party's militia
    // while the rest keep theirs is picking a side; disarming all of them is the
    // state claiming what a state claims. Size does not enter it: what makes the
    // narrow act authoritarian is that it is narrow, not how many it reaches.
    const target = typeof d === 'string' ? null : d.target;
    add(target === 'all' && act.compassAll ? act.compassAll : act.compass);
  }

  // What a country owns moves it as surely as what it legislates, and it moves
  // it whether it took the industry this morning or has held it since 1870. The
  // four industry decrees carry no compass of their own for this reason: they
  // are the act, and this is the state the act produces.
  // Scaled the same way the effects are: a state that owns one small pit has not
  // moved as far left as one that owns the whole extractive sector.
  for (const i of gov.stateOwned || []) {
    const c = decrees.stateOwnership?.compass?.[industryKind(i)];
    if (c) add([c[0] * (shares?.[i] ?? 1), c[1] * (shares?.[i] ?? 1)]);
  }

  const raw = [clamp(e), clamp(a)];
  const anchor = ideologies.ideologies.find((i) => i.name === holding);
  const position = anchor
    ? [raw[0] + ideologies.anchorPull * (anchor.economic - raw[0]),
       raw[1] + ideologies.anchorPull * (anchor.authority - raw[1])]
    : raw.slice();

  return {
    raw,
    position,
    ideology: nearest(position, ideologies, holding),
    slots: policySlots(position[1], ideologies),
  };
}

/** How many policies can run at once, from the authority coordinate. */
export function policySlots(authority, ideologies) {
  for (const band of ideologies.policySlots) {
    if (band.authorityBelow === null || authority < band.authorityBelow) return band.slots;
  }
  return ideologies.policySlots[ideologies.policySlots.length - 1].slots;
}

/**
 * The nearest named point, with the margin that stops the name flickering.
 *
 * A country sitting on a boundary would otherwise be renamed every time a
 * province changed hands, so it keeps what it holds until something else is
 * nearer by more than the margin.
 *
 * Unaligned comes first and is measured from the CENTRE, not from the points.
 * Being far from every named ideology is not the same as having no politics:
 * measured from the points the compass breaks into sixteen pockets, two of
 * which are hard left command economics and hard right, and a country in
 * either has a very definite ideology. Measured from the centre there is one
 * zone and it means the same thing every time, which is a country whose laws
 * pull evenly both ways and settle in the middle. A government that holds a
 * name keeps it inside the zone by the same margin it keeps it against a
 * rival point, so it becomes unaligned only once it stands that far inside.
 *
 * The threshold is DEPTH past the boundary, not the difference between the two
 * distances. The boundary between two points lies halfway, so a country whose
 * held point is 20 away and whose rival is 10 stands 5 inside the rival's
 * region, not 10. An ideology may set its own `escapeThreshold` and the table's
 * is the default, so a government that holds on hard is written as a number on
 * the ideology rather than as a special case here.
 */
export function nearest(position, ideologies, holding = null) {
  const held = ideologies.ideologies.find((i) => i.name === holding);
  const margin = held ? (held.escapeThreshold ?? ideologies.escapeThreshold) : 0;
  if (Math.hypot(position[0], position[1]) < ideologies.unalignedRadius - margin) return 'unaligned';
  const d = (i) => Math.hypot(position[0] - i.economic, position[1] - i.authority);
  const ranked = ideologies.ideologies.slice().sort((x, y) => d(x) - d(y));
  if (held) {
    const depth = (d(held) - d(ranked[0])) / 2;
    if (depth <= margin) return held.name;
  }
  return ranked[0].name;
}

/**
 * What a law costs this country in political power, before the drift multiplier.
 *
 * Each category is priced off the axis that decides whether the thing is easy
 * for that government at all. Taking men is a question of authority and taking
 * money is a question of economics, so a state built to command its people
 * conscripts cheaply and one built on property finds confiscation dear.
 *
 * The economy law keeps a table of its own, because state capacity is neither
 * axis: anarcho-communism is the furthest left point on the compass and has no
 * state to give the order.
 */
export function lawCost(category, optionName, position, tables) {
  const c = tables.laws.categories[category];
  if (!c) throw new Error(`no law category "${category}"`);
  const o = c.options.find((x) => x.name === optionName);
  if (!o) throw new Error(`no "${optionName}" in ${category}`);
  const [economic, authority] = position;

  switch (c.costWeightedBy) {
    case 'authority': return Math.round(o.cost * (1 - authority / 200));
    case 'economic': return Math.round(o.cost * (1 + economic / 200));
    case 'economicInverse': return Math.round(o.cost * (1 - economic / 200));
    case 'ideologyTable': {
      const held = tables.ideologies.ideologies.find(
        (i) => i.name === nearest(position, tables.ideologies));
      // The economy modifier is the consumer share column, read as a fraction.
      const mod = held ? (held.effects.consumerShare ?? 0) : 0;
      return Math.round(o.cost * (1 + mod));
    }
    default: return o.cost;
  }
}

/**
 * What the weighting does to a law's price, per category, as a plain multiplier.
 *
 * The same three numbers `lawCost` applies, pulled out so a panel can show what
 * a country's position is doing to its statute book without naming a law.
 *
 * @returns {{conscription: number, tax: number, economy: number}}
 */
export function costWeighting(position, tables) {
  const [economic, authority] = position;
  const held = tables.ideologies.ideologies.find(
    (i) => i.name === nearest(position, tables.ideologies));
  return {
    conscription: 1 - authority / 200,
    tax: 1 + economic / 200,
    economy: 1 + (held ? (held.effects.consumerShare ?? 0) : 0),
  };
}

/**
 * The drift multiplier, applied after the weighting above to laws, policies and
 * decrees alike.
 *
 * `drift` is how much further from its own point a change leaves the country.
 * Moving away costs 2% a point to a ceiling of three times; moving back is
 * discounted 1% a point to a floor of three quarters; and support for the
 * ideology arrived at discounts it by half a per cent a point, since where the
 * population has already gone the work is largely done.
 */
export function driftMultiplier(before, after, ideologies, holding, supportAtDestination = 0) {
  const held = ideologies.ideologies.find((i) => i.name === holding);
  if (!held) return 1;                       // an unaligned country pays neither
  const d = (p) => Math.hypot(p[0] - held.economic, p[1] - held.authority);
  const drift = d(after) - d(before);
  const away = Math.min(3, 1 + 0.02 * Math.max(0, drift));
  const back = Math.max(0.75, 1 - 0.01 * Math.max(0, -drift));
  return away * back * (1 - 0.005 * supportAtDestination);
}

const clamp = (v) => Math.max(-100, Math.min(100, v));

/** Which heading in stateOwnership an industry falls under. */
export function industryKind(industry) {
  if (industry === 'rail' || industry === 'manufacturing') return industry;
  return FARMED.has(industry) ? 'farmed' : 'resource';
}

// Collectivisation takes land and herds off the people living on them. Every
// other industry, forests and fisheries and mills and plantations included, is
// an enterprise and nationalises.
const FARMED = new Set(['fertileLand', 'livestock']);
export const nameOf = (x) => (typeof x === 'string' ? x : x.policy || x.decree || x.name);

/**
 * How urban a province is, 0 rural to 1 urban.
 *
 * Three things are read and all three carry their own weight. Density alone
 * calls dense farmland a city and factories alone call a company town one, so
 * neither decides it by itself; and a town is worth something on its own account
 * rather than only doubling what the other two already found. A province with a
 * city, no works and thin country is still more urban than the fields beside it,
 * which a multiplier could not say: it has nothing to multiply.
 *
 * The factory term is the smallest of the three it has been, because a factory
 * count was standing in for the whole of it. Most of the map is below the density
 * scale's floor, so where there were no factories the figure fell to zero however
 * many people lived there and however many of them lived in a town.
 */
export function urbanisation({ population, area, factories = 0, hasCity = false }) {
  if (!population || !area) return 0;
  const density = clamp01(Math.log10(Math.max(population / area, 1) / 60));
  const industry = Math.min(1, factories / 6);
  return Math.min(1, 0.3 * density + 0.4 * industry + 0.3 * (hasCity ? 1 : 0));
}

/**
 * The share of a province's deposits that are dug rather than grown, 0 to 1.
 *
 * The split is the one the map already makes: the six kinds that never carry an
 * unprospected share are the ones nobody prospects for, because you grow or
 * catch them. Everything else is in the ground. A province with no deposits at
 * all returns null and is judged on its towns alone.
 */
/**
 * How many units a province digs, mills and pits being the same kind of work to
 * the people doing it. The count and not the share, so it stands beside a factory
 * count in the same weight.
 */
export function dugDeposits(deposits) {
  let dug = 0;
  for (const [k, v] of Object.entries(deposits || {})) {
    if (typeof v !== 'number') continue;               // offshore, stranded, unprospected
    if (!GROWN.has(k)) dug += v;
  }
  return dug;
}

export function miningShare(deposits) {
  let dug = 0, grown = 0;
  for (const [k, v] of Object.entries(deposits || {})) {
    if (typeof v !== 'number') continue;               // offshore, stranded, unprospected
    if (GROWN.has(k)) grown += v; else dug += v;
  }
  return dug + grown ? dug / (dug + grown) : null;
}

/**
 * What a province does to the rate at which a movement gains and loses there.
 *
 * A movement in the wrong kind of place is slow to build and quick to collapse,
 * both at once. Four things say what kind of place it is. `urban` is where a
 * following lives, and `factory` and `mining` are what it does for a living,
 * which are not the same question and were being asked as one: a liberalism of
 * merchants and professions is as urban as a syndicalism of engineers and shares
 * none of its works, and a fascism of small towns keeps its foundries. `harsh`
 * is the ground itself: desert, rainforest, subarctic forest, tundra and ice cap
 * are lived in by herders, clans and trappers whatever the towns and deposits
 * say. The towns count double, being the stronger signal, and a term whose
 * measure the province does not have is dropped rather than guessed at, so a
 * province with none of the hard climates is judged on the other three alone.
 */
export function supportRate(urbanisation, ideology, mining = null, factory = null, harsh = null) {
  const ground = harsh > 0 ? harsh : null;
  const off = 2 * Math.abs(urbanisation - ideology.urban)
    + (factory === null ? 0 : Math.abs(factory - ideology.factory))
    + (mining === null ? 0 : Math.abs(mining - ideology.mining))
    + (ground === null ? 0 : Math.abs(ground - (ideology.harsh ?? 0)));
  const terms = 2 + (factory === null ? 0 : 1) + (mining === null ? 0 : 1) + (ground === null ? 0 : 1);
  const fit = 1 - off / terms;
  return { gain: 0.5 + fit, loss: 1.5 - fit };
}

const HARSH = new Set(['Desert', 'Rainforest', 'Subarctic', 'Tundra', 'Ice cap']);

/** The share of a province's climates that are hard ground, so 0, a half or 1. */
export function harshShare(climates) {
  if (!climates?.length) return 0;
  return climates.filter((c) => HARSH.has(c)).length / climates.length;
}

const GROWN = new Set(['fertileLand', 'livestock', 'timber', 'fish', 'textiles', 'rubber']);

/**
 * What a country would poll, as points across the ideologies and unaligned.
 *
 * Weighted by population, so a capital of three million counts for what it is
 * against a province of two hundred thousand.
 */
export function nationalSupport(provinces) {
  const out = {};
  let total = 0;
  for (const { population, support } of provinces) {
    if (!population || !support) continue;
    total += population;
    for (const [k, v] of Object.entries(support)) out[k] = (out[k] || 0) + population * v;
  }
  if (!total) return {};
  for (const k of Object.keys(out)) out[k] /= total;
  return out;
}

/** The entry in it for the ideology the country holds, which is what most rules read. */
export function governingSupport(national, ideology) {
  return national[ideology] || 0;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * A national happiness figure spread unevenly over the provinces that carry it.
 *
 * `happiness` on a spirit is a change in the country's mean, not a flat charge
 * on every province: a resented government is resented harder in some places
 * than others, and a country where every province moved by the same 5 points
 * would have no politics in it. The share each province takes is fixed by a hash
 * of the spirit and the province, so it is the same on every run and never moves,
 * and the shares are then divided by their own population-weighted mean, which
 * makes the weighted mean of the result exactly the figure asked for.
 *
 * @param {number} figure     the national change, e.g. -5
 * @param {Array} provinces   [{id, population}], the ones the spirit reaches
 * @param {string} key        the spirit's name, so two spirits spread differently
 * @returns {Map<string, number>} province id to its own share of the figure
 */
export function spreadOverProvinces(figure, provinces, key, spread = SPIRIT_SPREAD) {
  const w = new Map();
  let total = 0, weighted = 0;
  for (const p of provinces) {
    const v = 1 + spread * (2 * hash01(key + '|' + p.id) - 1);
    w.set(p.id, v);
    total += p.population || 0;
    weighted += (p.population || 0) * v;
  }
  const mean = total ? weighted / total : 1;
  const out = new Map();
  for (const p of provinces) out.set(p.id, figure * (w.get(p.id) / (mean || 1)));
  return out;
}

/** FNV-1a to a fraction, so a share is fixed by its own name and never drifts. */
function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

const SPIRIT_SPREAD = 0.5;

/**
 * What a modifier on an act or a spirit is spread by, and how hard.
 *
 * `felt` is either one weight for everything the act does, or a map from modifier
 * to weight, since one act can land two ways: the slums are felt in the towns and
 * the unrest they cause is felt in the works. Either form may name a `spread` of
 * its own, and at 1 a province holding none of the thing takes none of the figure
 * instead of the floor the default leaves it.
 */
export function feltFor(act, key) {
  const f = act?.felt;
  if (!f) return null;
  const one = typeof f === 'string' ? f : f[key];
  if (!one) return null;
  const spread = typeof act.spread === 'object' && act.spread !== null
    ? act.spread[key] : act.spread;
  if (typeof one === 'string') return { by: one, spread: spread ?? ACT_SPREAD };
  return { by: one.by, spread: one.spread ?? spread ?? ACT_SPREAD };
}

/**
 * A national figure spread over provinces by how much of a thing each one has,
 * holding the population-weighted mean at the figure itself. A spirit spreads by
 * hash because a mood has no reason to fall where it falls; an act does. Land
 * reform is felt where the land is and worker conditions where the factories are,
 * and both still average what the table says they do.
 *
 * The ratio is held to ACT_CAP so one province holding most of the country's
 * farmland does not take the whole figure several times over.
 */
export function spreadByWeight(figure, provinces, key, spread = ACT_SPREAD) {
  let total = 0, share = 0;
  for (const p of provinces) { total += p.population || 0; share += (p.population || 0) * (p[key] || 0); }
  const mean = total ? share / total : 0;

  const w = new Map();
  let weighted = 0;
  for (const p of provinces) {
    const rel = mean ? Math.min((p[key] || 0) / mean, ACT_CAP) : 1;
    const v = (1 - spread) + spread * rel;
    w.set(p.id, v);
    weighted += (p.population || 0) * v;
  }
  const m = total ? weighted / total : 1;
  const part = new Map();
  for (const p of provinces) part.set(p.id, w.get(p.id) / (m || 1));

  // The cap has to hold on what a province ends up with, not on the ratio before
  // normalising. Where a thing sits in one province and nowhere else the mean
  // collapses toward the floor and that province takes several times the figure,
  // which is the whole of what the cap exists to stop: Fellnor holds one point of
  // fertile land, in Langholt, and land reform paid it 55 happiness. What is taken
  // off a province over the cap is handed to the rest, so the mean still holds.
  for (let pass = 0; pass < 8; pass++) {
    let over = 0, under = 0;
    for (const p of provinces) {
      const n = p.population || 0, v = part.get(p.id);
      if (v > ACT_CAP) over += n * (v - ACT_CAP); else under += n * v;
    }
    if (over < 1e-9 || under <= 0) break;
    const lift = 1 + over / under;
    for (const p of provinces) {
      const v = part.get(p.id);
      part.set(p.id, v > ACT_CAP ? ACT_CAP : v * lift);
    }
  }

  const out = new Map();
  for (const p of provinces) out.set(p.id, figure * part.get(p.id));
  return out;
}

const ACT_SPREAD = 0.7;
const ACT_CAP = 3;

/**
 * How content a province is with the government it has. Not a rating of the creed:
 * the share of that province backing the ruling ideology, against the share a
 * government of the period could expect to have behind it. A province with nothing
 * authored reads 0 rather than reading as though nobody backs anyone.
 */
export function supportHappiness(support, ideology, ideologies) {
  if (!support || !Object.keys(support).length) return 0;
  const { baseline = 21, perPoint = 0.6 } = ideologies?.supportHappiness || {};
  return ((support[ideology] || 0) - baseline) * perPoint;
}

/**
 * Where a realm itself sits, as against where its members do.
 *
 * A realm holds no ground. Fellnor-Avanta owns not one province: every acre is
 * Fellnor's or Avanta's, and the empire is the agreement between them. So its
 * position is what it legislates in common, plus what its members legislate at
 * home weighted by how many people they each speak for. Two parliaments that
 * agree put the empire where they both stand; two that do not put it between
 * them, which is what an empire that cannot move looks like on the compass.
 *
 * @param {object} realm    the parent entry, holding the common laws
 * @param {Array} members   [{gov, population}]
 * @param {object} tables   { laws, policies, decrees, ideologies }
 * @param {?string} holding the realm's own ideology, or null
 */
export function realmCompass(realm, members, tables, holding = null) {
  const own = compass(realm, tables, null);
  let total = 0, e = 0, a = 0;
  // A crowned realm holds no starting ideology of its own. It has no politics to
  // seed one from: what it is called is whatever its members are called, and
  // where they disagree it takes the one with the most people behind it. An
  // elected realm does have politics of its own, a president and a senate the
  // whole confederation votes for, so the Three Nations carries one and it is
  // passed in as `holding`.
  const behind = new Map();
  for (const { gov, population } of members) {
    const p = compass(gov, tables, gov.startingIdeology || null, realm);
    behind.set(p.ideology, (behind.get(p.ideology) || 0) + (population || 0));
    total += population || 0;
    e += (population || 0) * p.raw[0];
    a += (population || 0) * p.raw[1];
  }
  if (holding === null && behind.size) {
    holding = [...behind].sort((x, y) => y[1] - x[1])[0][0];
  }
  if (!total) return compass(realm, tables, holding);
  // Half the realm's own reading and half its members', so neither the common
  // laws nor the two governments alone decide where the empire stands.
  const raw = [clampAxis((own.raw[0] + e / total) / 2), clampAxis((own.raw[1] + a / total) / 2)];
  const anchor = tables.ideologies.ideologies.find((i) => i.name === holding);
  const position = anchor
    ? [raw[0] + tables.ideologies.anchorPull * (anchor.economic - raw[0]),
       raw[1] + tables.ideologies.anchorPull * (anchor.authority - raw[1])]
    : raw.slice();
  return {
    raw,
    position,
    ideology: nearest(position, tables.ideologies, holding),
    slots: policySlots(position[1], tables.ideologies),
  };
}

const clampAxis = (v) => Math.max(-100, Math.min(100, v));

/**
 * What a decree costs this country, before the drift multiplier.
 *
 * The drift multiplier alone cannot say that a conservative government finds
 * nationalising hard. It reads distance from the country's own point, so it
 * charges for any move away from that point and discounts any move toward it,
 * whichever direction the country leans: Krenland sitting right of Conservatism
 * was being discounted for nationalising and charged for selling. So a decree
 * may name an axis as a law category does. `economic` is dearer the further
 * right a country stands and `economicInverse` is cheaper, which is the pair
 * taking an industry and selling one need.
 */
export function decreeCost(name, position, tables) {
  const d = tables.decrees.decrees.find((x) => x.name === name);
  if (!d) throw new Error(`no decree "${name}"`);
  return Math.round(d.cost * actWeighting(d, position, tables.decrees));
}

/** The same for a policy, against its start cost. Upkeep is money and is not touched. */
export function policyCost(name, position, tables) {
  const p = tables.policies.policies.find((x) => x.name === name);
  if (!p) throw new Error(`no policy "${name}"`);
  return Math.round(p.start * actWeighting(p, position));
}

/**
 * What a country's position does to the price of an act, as a plain multiplier.
 *
 * The weighting is not typed in. A decree or a policy already says which way it
 * moves the country, so that is what prices it: an act that raises authority is
 * cheap for a government that has authority and dear for one that does not, and
 * an act that moves the country left is dear for a government standing on the
 * right. Martial law at [0, +25] is an authority act and Improve worker
 * conditions at [-15, -8] is an economic one, and neither needed a keyword.
 *
 * An act that moves both axes is priced on both at half weight, so it cannot
 * cost twice what a single-axis act of the same size does. `costWeightedBy`
 * overrides the whole of this, which is how the four industry decrees are priced:
 * they carry no compass of their own, since what moves the country is the
 * ownership rather than the act.
 *
 * Every figure runs on the same axis/200 the law categories use, so the widest
 * this reaches is half again or half off, at either edge of the compass.
 */
function actWeighting(act, position, all = null) {
  const [economic, authority] = position;
  switch (act.costWeightedBy) {
    case 'authority': return 1 - authority / 200;
    case 'authorityInverse': return 1 + authority / 200;
    case 'economic': return 1 + economic / 200;
    case 'economicInverse': return 1 - economic / 200;
    default: break;
  }
  // A decree that undoes another is weighted as the opposite of what it undoes.
  // Its own compass is [0, 0], because what moves the country is the original
  // leaving, so without this a government would pay the same to legalise a party
  // whether it had spent its life banning them or freeing them.
  let [ce = 0, ca = 0] = act.compass || [];
  if (act.ends) {
    const undone = (all?.decrees || []).find((x) => x.name === act.ends);
    if (undone?.compass) { ce = -undone.compass[0]; ca = -undone.compass[1]; }
  }
  if (!ce && !ca) return 1;

  // Direction alone is not enough. Officer training at [0, +3] and Secret police
  // at [0, +30] both raise authority, and an autocrat should find the second far
  // easier rather than both equally so, which is what a sign on its own says.
  // ACT_FULL is where an act counts for the whole of the axis weighting.
  const both = ce && ca ? 2 : 1;                 // half weight each where it moves both
  const lean = (v) => Math.min(1, Math.abs(v) / ACT_FULL) * Math.sign(v);
  return axis(lean(ca), authority, both) * axis(lean(ce), economic, both);
}

/**
 * One axis of the weighting, and it is deliberately not symmetric.
 *
 * Doing what a government already leans toward is modestly cheaper; doing the
 * opposite is a great deal dearer. A libertarian banning the opposition is not
 * making a slightly awkward decision, it is repudiating the thing it exists for,
 * and a discount and a penalty of the same size said otherwise: an anarchist
 * paid 132 for a ban that cost an autocrat 71.
 *
 * So the discount runs on the axis over 200, reaching half off at the edge, and
 * the penalty on the axis over 100, reaching double.
 */
function axis(lean, at, both) {
  if (!lean) return 1;
  const against = lean * at < 0;
  return 1 - (lean * at) / ((against ? 100 : 200) * both);
}

// The strongest thing on the board is Secret police at 30 and Martial law at 25.
// Anything at or past this leans as hard as an act can.
const ACT_FULL = 25;

/**
 * How much of each kind a state holding one industry has actually taken. Owning
 * Twadamia's coalfields is not the same act as owning its one point of natural
 * gas, and the old figures paid the same for both. Rail and manufacturing are one
 * network and one industrial base, so they are whole or nothing.
 *
 * `deposits` is what the country holds, resource name to amount.
 */
export function industryShares(deposits, tables) {
  const whole = new Set(tables?.decrees?.stateOwnership?.whole || ['rail', 'manufacturing']);
  const total = {};
  for (const [k, v] of Object.entries(deposits || {})) {
    if (typeof v !== 'number' || v <= 0) continue;
    const kind = industryKind(k);
    total[kind] = (total[kind] || 0) + v;
  }
  const out = {};
  for (const [k, v] of Object.entries(deposits || {})) {
    if (typeof v !== 'number' || v <= 0) continue;
    const kind = industryKind(k);
    out[k] = total[kind] ? v / total[kind] : 1;
  }
  for (const k of whole) out[k] = 1;
  return out;
}

/**
 * What a province card calls an industry the state holds. A farmed one is not
 * owned the way a mine is: it was taken from the people on it, and the word for
 * that is collectivised.
 */
function ownedLabel(industry) {
  if (industry === 'rail') return 'state railways';
  if (industry === 'manufacturing') return 'state factories';
  const name = industry.replace(/([A-Z])/g, ' $1').toLowerCase();
  return FARMED.has(industry) ? `collectivised ${name}` : `state ${name} industry`;
}

// What a movement-sized act does not scale down: a communist state is as offended
// by a ban whether your communists are three in a hundred or thirty, and a figure
// aimed at the movement itself is already aimed at only that movement.
const ABROAD = new Set(['relationsWithHolders', 'ideologySupportPerDay', 'driftMultiplierTowardTarget']);

/** What a province card calls a law, by the category rather than by the option. */
export const LAW_LABEL = {
  conscription: 'conscription', economy: 'the war economy', personalTax: 'income tax',
  corporateTax: 'company tax', colonialTax: 'colonial tax', monetary: 'the currency',
  trade: 'trade',
};

/**
 * What a country's own acts do to one modifier, act by act. Laws, policies and
 * decrees are charged in every province rather than spread as a mean the way a
 * spirit is: a spirit is a condition a country is in, an act is a thing it has
 * done, and a thing it has done is done everywhere. A member of a realm carries
 * the realm's acts under its own, the way compass() reads them.
 *
 * `scale` is handed each act and returns the multiplier that act's own scaling
 * block asks for, which is what lets martial law be resented less in a country
 * already at war. Without one every act counts whole.
 *
 * `label` is handed a name and a target so a caller can fill the tokens in it.
 */
// A realm and a member both holding the same act have enacted it once, not twice.
const byName = (list) => [...new Map(list.map((x) => [nameOf(x), x])).values()];

export function actEffects(gov, tables, key, opts = {}) {
  const { parent = null, scale = () => 1, label = (name) => name.toLowerCase(),
    shares = null, movements = null } = opts;
  const { laws, policies, decrees } = tables;
  const out = [];
  const take = (label, act, from, target = null) => {
    // An act that names a movement acts on as much of the country as that movement
    // is, so putting down the leagues of all twenty-two one at a time comes to what
    // putting them all down at once does, and no more. What reaches abroad or acts
    // on the movement itself is not a share of anything and is left whole.
    const part = act?.felt === 'support' && target && target !== 'all' && !ABROAD.has(key)
      ? (movements ? movements[target] || 0 : 1) : 1;
    const n = (act?.effects?.[key] || 0) * scale(act) * part;
    if (n) out.push({ label: act?.factor || label, figure: n, felt: feltFor(act, key), from, target });
  };

  const chosen = { ...(parent?.laws || {}), ...(gov.laws || {}) };
  for (const [category, option] of Object.entries(chosen))
    take(LAW_LABEL[category] || category,
      laws.categories?.[category]?.options?.find((o) => o.name === option),
      (gov.laws || {})[category] === undefined ? 'realm' : 'own');

  for (const x of byName([...(parent?.policies || []), ...(gov.policies || [])]))
    take(label(nameOf(x), x?.target), policies.policies.find((o) => o.name === nameOf(x)),
      (gov.policies || []).some((y) => nameOf(y) === nameOf(x)) ? 'own' : 'realm', x?.target ?? null);

  for (const x of byName([...(parent?.decrees || []), ...(gov.decrees || [])])) {
    const act = decrees.decrees.find((o) => o.name === nameOf(x));
    // A campaign that has run its course keeps only what it lists as permanent.
    if (x?.expired && !(act?.permanent || []).includes(key)) continue;
    take(label(nameOf(x), x?.target), act,
      (gov.decrees || []).some((y) => nameOf(y) === nameOf(x)) ? 'own' : 'realm', x?.target ?? null);
  }

  // Owning an industry is a standing state and not an act, so its figures come off
  // stateOwnership rather than off whichever decree put it there. One line: which
  // industries the state holds is a question for the government card.
  const own = decrees.stateOwnership;
  const unscaled = new Set(own?.unscaled || []);
  for (const i of new Set([...(parent?.stateOwned || []), ...(gov.stateOwned || [])])) {
    const figure = own?.byTarget?.[industryKind(i)]?.[key] || 0;
    // The figures say what owning the whole of a kind does, so a holding pays its
    // share of it. What the state does to the works it took is not a share of
    // anything: it runs them, and they run worse.
    const n = unscaled.has(key) ? figure : figure * (shares?.[i] ?? 1);
    if (n) out.push({ label: ownedLabel(i), figure: n,
      felt: { by: 'target', spread: 1 }, from: 'own', target: i });
  }

  return out;
}
