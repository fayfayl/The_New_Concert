// Compass position, costs and support figures derived from a government.

// A country's raw and anchored compass position and the ideology it holds.
export function compass(gov, tables, holding = null, parent = null, shares = null,
  movements = null) {
  const { laws, policies, decrees, ideologies } = tables;
  let e = 0, a = 0;
  const add = (v) => { if (v) { e += v[0]; a += v[1]; } };

  const form = ideologies.forms.find((f) => f.name === gov.form);
  if (!form) throw new Error(`no form of government "${gov.form}"`);
  add([form.economic, form.authority]);

  const held = heldActs(gov, parent, tables.defaults);
  gov = { ...gov, laws: held.laws, policies: held.policies, decrees: held.decrees,
    stateOwned: held.stateOwned };

  for (const [cat, chosen] of Object.entries(gov.laws || {})) {
    const c = laws.categories[cat];
    if (!c) throw new Error(`no law category "${cat}"`);
    const o = c.options.find((x) => x.name === chosen);
    if (!o) throw new Error(`no "${chosen}" in ${cat}`);
    add(o.compass);
  }
  for (const p of gov.policies || []) add(policies.policies.find((x) => x.name === nameOf(p))?.compass);
  for (const d of gov.decrees || []) {
    if (d?.expired) continue;
    const act = decrees.decrees.find((x) => x.name === nameOf(d));
    if (!act?.compass) continue;
    const target = typeof d === 'string' ? null : d.target;
    add(target === 'all' && act.compassAll ? act.compassAll : act.compass);
  }

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

// Name for no ideology, for governments and province support alike.
export const UNALIGNED = 'Unaligned';

// Nearest named ideology point, with a margin before a held name changes.
export function nearest(position, ideologies, holding = null) {
  const held = ideologies.ideologies.find((i) => i.name === holding);
  const margin = held ? (held.escapeThreshold ?? ideologies.escapeThreshold) : 0;
  if (Math.hypot(position[0], position[1]) < ideologies.unalignedRadius - margin) return UNALIGNED;
  const d = (i) => Math.hypot(position[0] - i.economic, position[1] - i.authority);
  const ranked = ideologies.ideologies.slice().sort((x, y) => d(x) - d(y));
  if (held) {
    const depth = (d(held) - d(ranked[0])) / 2;
    if (depth <= margin) return held.name;
  }
  return ranked[0].name;
}

// Political power cost of a law, before the drift multiplier.
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
      const mod = held ? (held.effects.consumerShare ?? 0) : 0;
      return Math.round(o.cost * (1 + mod));
    }
    default: return o.cost;
  }
}

// Per-category law price multipliers from a country's position.
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

// Drift multiplier on laws, policies and decrees for a move between points.
export function driftMultiplier(before, after, ideologies, holding, supportAtDestination = 0) {
  const held = ideologies.ideologies.find((i) => i.name === holding);
  if (!held) return 1;
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

// Industries that collectivise; all others nationalise.
const FARMED = new Set(['fertileLand', 'livestock']);
export const nameOf = (x) => (typeof x === 'string' ? x : x.policy || x.decree || x.name);

// Urbanisation of a province, 0 rural to 1 urban.
export function urbanisation({ population, area, factories = 0, hasCity = false }) {
  if (!population || !area) return 0;
  const density = clamp01(Math.log10(Math.max(population / area, 1) / 60));
  const industry = Math.min(1, factories / 6);
  return Math.min(1, 0.3 * density + 0.4 * industry + 0.3 * (hasCity ? 1 : 0));
}

// Share of a province's deposits that are dug, 0 to 1, or null with none.
// Count of dug deposit units in a province.
export function dugDeposits(deposits) {
  let dug = 0;
  for (const [k, v] of Object.entries(deposits || {})) {
    if (typeof v !== 'number') continue;
    if (!GROWN.has(k)) dug += v;
  }
  return dug;
}

export function miningShare(deposits) {
  let dug = 0, grown = 0;
  for (const [k, v] of Object.entries(deposits || {})) {
    if (typeof v !== 'number') continue;
    if (GROWN.has(k)) grown += v; else dug += v;
  }
  return dug + grown ? dug / (dug + grown) : null;
}

// A province's multiplier on a movement's support gain and loss rates.
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

// Population-weighted national support across ideologies and unaligned.
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

// National support entry for the held ideology.
export function governingSupport(national, ideology) {
  return national[ideology] || 0;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Spreads a national happiness figure unevenly over provinces by hash.
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

// Spread weight and strength for one modifier of an act or spirit.
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

// Spreads a national figure over provinces by how much of a thing each has.
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

  // Caps each province's final share over repeated passes.
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

// Province happiness from its support for the ruling ideology.
export function supportHappiness(support, ideology, ideologies) {
  if (!support || !Object.keys(support).length) return 0;
  const rule = ideologies?.supportHappiness;
  if (!rule) return 0;
  return ((support[ideology] || 0) - rule.baseline) * rule.perPoint;
}

// Compass position of a realm from its common laws and its members.
export function realmCompass(realm, members, tables, holding = null) {
  const own = compass(realm, tables, null);
  let total = 0, e = 0, a = 0;
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

// Political power cost of a decree, before the drift multiplier.
export function decreeCost(name, position, tables) {
  const d = tables.decrees.decrees.find((x) => x.name === name);
  if (!d) throw new Error(`no decree "${name}"`);
  return Math.round(d.cost * actWeighting(d, position, tables.decrees));
}

// Political power start cost of a policy, before the drift multiplier.
export function policyCost(name, position, tables) {
  const p = tables.policies.policies.find((x) => x.name === name);
  if (!p) throw new Error(`no policy "${name}"`);
  return Math.round(p.start * actWeighting(p, position));
}

// Price multiplier for an act from its compass direction and the position.
function actWeighting(act, position, all = null) {
  const [economic, authority] = position;
  switch (act.costWeightedBy) {
    case 'authority': return 1 - authority / 200;
    case 'authorityInverse': return 1 + authority / 200;
    case 'economic': return 1 + economic / 200;
    case 'economicInverse': return 1 - economic / 200;
    default: break;
  }
  // Undoing decrees are weighted as the opposite of the decree they undo.
  let [ce = 0, ca = 0] = act.compass || [];
  if (act.ends) {
    const undone = (all?.decrees || []).find((x) => x.name === act.ends);
    if (undone?.compass) { ce = -undone.compass[0]; ca = -undone.compass[1]; }
  }
  if (!ce && !ca) return 1;

  const both = ce && ca ? 2 : 1;                 // half weight each where it moves both
  const lean = (v) => Math.min(1, Math.abs(v) / ACT_FULL) * Math.sign(v);
  return axis(lean(ca), authority, both) * axis(lean(ce), economic, both);
}

// Weighting along one axis: cheaper with the lean, much dearer against it.
function axis(lean, at, both) {
  if (!lean) return 1;
  const against = lean * at < 0;
  return 1 - (lean * at) / ((against ? 100 : 200) * both);
}

// Compass magnitude at which an act leans fully.
const ACT_FULL = 25;

// Share of each industry kind a state holding takes.
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

// Province card label for a state-held industry.
export function ownedLabel(industry) {
  if (industry === 'rail') return 'state railways';
  if (industry === 'manufacturing') return 'state factories';
  const name = industry.replace(/([A-Z])/g, ' $1').toLowerCase();
  return FARMED.has(industry) ? `collectivised ${name}` : `state ${name} industry`;
}

// Modifiers that keep their full size when an act targets one movement.
const ABROAD = new Set(['relationsWithHolders', 'ideologySupportPerDay', 'driftMultiplierTowardTarget']);


// Per-act effects of a country's own acts on one modifier, per province.
// Acts a government holds with its realm's and the defaults folded in.
// An infrastructure target keys by its kind and province.
export const actKey = (x) => nameOf(x) + '|' + (x?.target && typeof x.target === 'object' ? x.target.infrastructure + '@' + x.target.province : x?.target ?? '');
const once = (list) => [...new Map(list.map((x) => [actKey(x), x])).values()];
export function heldActs(gov, parent = null, defaults = null) {
  const laws = { ...(defaults?.laws || {}), ...(parent?.laws || {}), ...(gov?.laws || {}) };
  const lawFrom = (category) => (gov?.laws?.[category] !== undefined ? 'own'
    : parent?.laws?.[category] !== undefined ? 'realm' : 'default');
  const ownAct = (field, x) => (gov?.[field] || []).some((y) => actKey(y) === actKey(x));
  return {
    laws, lawFrom, ownAct,
    policies: once([...(parent?.policies || []), ...(gov?.policies || [])]),
    decrees: once([...(parent?.decrees || []), ...(gov?.decrees || [])]),
    stateOwned: [...new Set([...(parent?.stateOwned || []), ...(gov?.stateOwned || [])])],
    fading: [...(parent?.fading || []), ...(gov?.fading || [])],
  };
}

export function actEffects(gov, tables, key, opts = {}) {
  const { parent = null, scale = () => 1, label = (name) => name.toLowerCase(),
    shares = null, movements = null } = opts;
  const { laws, policies, decrees } = tables;
  const out = [];
  const take = (label, act, from, target = null, strength = 1) => {
    const part = act?.felt === 'support' && target && target !== 'all' && !ABROAD.has(key)
      ? (movements ? movements[target] || 0 : 1) : 1;
    const n = (act?.effects?.[key] || 0) * scale(act) * part * strength;
    if (n) out.push({ label: act?.factor || label, figure: n, felt: feltFor(act, key), from, target });
  };

  const held = heldActs(gov, parent, tables.defaults);
  for (const [category, option] of Object.entries(held.laws))
    take(laws.categories?.[category]?.phrase || category,
      laws.categories?.[category]?.options?.find((o) => o.name === option), held.lawFrom(category));

  for (const x of held.policies)
    take(label(nameOf(x), x?.target), policies.policies.find((o) => o.name === nameOf(x)),
      held.ownAct('policies', x) ? 'own' : 'realm', x?.target ?? null, x?.strength ?? 1);

  for (const x of held.decrees) {
    const act = decrees.decrees.find((o) => o.name === nameOf(x));
    if (x?.expired && !(act?.permanent || []).includes(key)) continue;
    take(label(nameOf(x), x?.target), act,
      held.ownAct('decrees', x) ? 'own' : 'realm', x?.target ?? null, x?.strength ?? 1);
  }

  // Acts that have left, going off.
  for (const f of held.fading) {
    if (f.except?.includes(key)) continue;
    const act = (f.policy ? policies.policies : decrees.decrees).find((o) => o.name === nameOf(f));
    take(label(nameOf(f), f.target), act, (gov?.fading || []).includes(f) ? 'own' : 'realm', f.target ?? null, f.strength);
  }

  const own = decrees.stateOwnership;
  const unscaled = new Set(own?.unscaled || []);
  for (const i of new Set([...(parent?.stateOwned || []), ...(gov.stateOwned || [])])) {
    const figure = own?.byTarget?.[industryKind(i)]?.[key] || 0;
    const n = unscaled.has(key) ? figure : figure * (shares?.[i] ?? 1);
    if (n) out.push({ label: ownedLabel(i), figure: n,
      felt: { by: 'target', spread: 1 }, from: 'own', target: i });
  }

  return out;
}
