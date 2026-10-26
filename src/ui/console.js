// Console commands that change governments and infrastructure.

const VERSION = new URL(import.meta.url).search;
const { nameOf } = await import(`../game/government.js${VERSION}`);
const { membersOf } = await import(`../world/mapdata.js${VERSION}`);
const { countyFortCeiling } = await import(`../world/ceilings.js${VERSION}`);
const { state, worldChanged } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let LEVEL_TYPES, builtLevel, doctrineOf, governmentPosition, railShare, colonyHolder, unlockedSlots, usableCeiling, lawCeilingOf, unavailable, startAct, fadeAct, restartWait, endsWithDecree, enactInfrastructure;
export function link(all) { ({ LEVEL_TYPES, builtLevel, doctrineOf, governmentPosition, railShare, colonyHolder, unlockedSlots, usableCeiling, lawCeilingOf, unavailable, startAct, fadeAct, restartWait, endsWithDecree, enactInfrastructure } = all); }

// Console setters: change things at no cost; names, availability and ceilings are checked.

// A polity's government entry, or an error naming what was asked for.
function consoleGov(tag) {
  const g = state.world?.government?.byPolity?.get(tag);
  if (!g) throw new Error(`no government for "${tag}"`);
  return g;
}

// A list of names as an error message reads it: "a", "b" or "c".
const consoleChoices = (names) => names.map((n) => `"${n}"`).join(', ');

// Console report of a government: its entry and the compass ideology.
function consoleGovSummary(tag) {
  const w = state.world, g = consoleGov(tag);
  let ideology = null;
  try { ideology = governmentPosition(w, tag)?.ideology ?? null; } catch { ideology = null; }
  return {
    polity: tag, form: g.form, ideology,
    laws: { ...(g.laws || {}) }, doctrine: doctrineOf(w, tag),
    policies: [...(g.policies || [])], decrees: [...(g.decrees || [])],
    stateOwned: [...(g.stateOwned || [])], spirits: [...(g.spirits || [])],
  };
}

// Signals a government change and returns the report.
function governmentChanged(tag) {
  worldChanged();
  return consoleGovSummary(tag);
}

function setLawFromConsole(tag, category, option) {
  const g = consoleGov(tag);
  const cats = state.world.government.laws?.categories || {};
  const c = cats[category];
  if (!c) throw new Error(`no law category "${category}"; try ${consoleChoices(Object.keys(cats))}`);
  if (!c.options.some((o) => o.name === option)) {
    throw new Error(`no "${option}" in ${category}; try ${consoleChoices(c.options.map((o) => o.name))}`);
  }
  // Colonial tax needs a colony and national tax a member to fall on.
  const table = state.world.table;
  if (category === 'colonialTax' && ![...table.polityById.values()].some((q) => colonyHolder(state.world, q.id) === tag)) {
    throw new Error(`${tag} holds no colony`);
  }
  if (category === 'nationalTax' && !membersOf(table, tag).length) throw new Error(`${tag} is not a realm`);
  // A spirit may cap how far a law is raised.
  const parent = table.polityById.get(tag)?.parent;
  const cap = lawCeilingOf(state.world, tag, category, parent && parent !== tag ? state.world.government.byPolity.get(parent) : null);
  if (cap && c.options.findIndex((o) => o.name === option) > c.options.findIndex((o) => o.name === cap)) {
    throw new Error(`${tag} may raise ${category} no further than "${cap}"`);
  }
  g.laws = { ...(g.laws || {}), [category]: option };
  return governmentChanged(tag);
}

function setFormFromConsole(tag, form) {
  const g = consoleGov(tag);
  const forms = state.world.government.ideologies?.forms || [];
  if (!forms.some((f) => f.name === form)) {
    throw new Error(`no form "${form}"; try ${consoleChoices(forms.map((f) => f.name))}`);
  }
  g.form = form;
  return governmentChanged(tag);
}

// Sets a doctrine branch's school; null removes the branch.
function setDoctrineFromConsole(tag, branch, school) {
  const g = consoleGov(tag);
  const branches = state.world.government.laws?.doctrine?.branches || {};
  const list = branches[branch];
  if (!list) throw new Error(`no doctrine branch "${branch}"; try ${consoleChoices(Object.keys(branches))}`);
  const doctrine = { ...(g.doctrine || {}) };
  if (school === null || school === undefined) delete doctrine[branch];
  else if (!list.some((s) => s.name === school)) {
    throw new Error(`no "${school}" in ${branch}; try ${consoleChoices(list.map((s) => s.name))}`);
  } else doctrine[branch] = school;
  g.doctrine = doctrine;
  return governmentChanged(tag);
}

// Adds or removes a policy or decree, with an optional target and toward, "for" or "against" it.
function setActFromConsole(tag, kind, name, target, on, toward) {
  const g = consoleGov(tag);
  const table = kind === 'policy'
    ? state.world.government.policies?.policies || []
    : state.world.government.decrees?.decrees || [];
  const field = kind === 'policy' ? 'policies' : 'decrees';
  const act = table.find((a) => a.name === name);
  if (!act) {
    throw new Error(`no ${kind} "${name}"; try ${consoleChoices(table.map((a) => a.name))}`);
  }
  const held = [...(g[field] || [])];
  const same = (x) => nameOf(x) === name && (target === undefined || x?.target === target);
  if (on) {
    if (held.some(same)) throw new Error(`${tag} already holds ${kind} "${name}"`);
    if (toward !== undefined && toward !== 'for' && toward !== 'against') throw new Error('toward is "for" or "against"');
    const why = unavailable(state.world, tag, kind, act, target);
    if (why) throw new Error(why);
    const wait = restartWait(g, kind, name, target);
    if (wait) throw new Error(`${name} may start again in ${wait} days`);
    held.push(startAct(state.world, kind, name, target, toward));
    if (kind === 'decree') enactInfrastructure(state.world, tag, held[held.length - 1]);
    g[field] = held;
    if (kind === 'decree') endsWithDecree(state.world, g, act, target);
  } else {
    if (!held.some(same)) throw new Error(`${tag} holds no ${kind} "${name}"`);
    // What leaves goes off over its fade.
    for (let i = held.length - 1; i >= 0; i--) if (same(held[i])) { fadeAct(state.world, g, held[i]); held.splice(i, 1); }
    g[field] = held;
  }
  return governmentChanged(tag);
}

function setSpiritFromConsole(tag, id, on) {
  const g = consoleGov(tag);
  const spirits = state.world.government.spirits?.spirits || [];
  if (!spirits.some((s) => s.id === id)) throw new Error(`no spirit "${id}"`);
  const held = [...(g.spirits || [])];
  if (on) {
    if (held.includes(id)) throw new Error(`${tag} already holds "${id}"`);
    held.push(id);
  } else {
    if (!held.includes(id)) throw new Error(`${tag} does not hold "${id}"`);
    held.splice(held.indexOf(id), 1);
  }
  g.spirits = held;
  return governmentChanged(tag);
}

/* --- the ground: levels, factories, forts and rail */

// A province's stats entry and the province itself, or an error.
function consoleProvince(id) {
  const w = state.world;
  const p = w?.byId?.get(id);
  const s = w?.stats?.[id];
  if (!p || !s) throw new Error(`no province "${id}"`);
  return { w, p, s };
}

// What a province has built, against what it may build.
function consoleInfrastructure(id) {
  const { w, p, s } = consoleProvince(id);
  const out = {};
  for (const k of LEVEL_TYPES) {
    const [built = 0, ground = 0] = Array.isArray(s[k]) ? s[k] : [s[k] || 0, 0];
    out[k] = { built, max: usableCeiling(k, ground) };
  }
  const [, slotMax = 0] = Array.isArray(s.buildingSlots) ? s.buildingSlots : [0, 0];
  out.slots = {
    unlocked: unlockedSlots(slotMax, builtLevel(s, 'road'), builtLevel(s, 'electricity'), railShare(w, p)),
    max: slotMax,
  };
  out.civilianFactories = s.civilianFactories || 0;
  out.militaryFactories = s.militaryFactories || 0;
  return out;
}

// Sets one of the six levels, capped by what the country may build.
function setLevelFromConsole(id, kind, level) {
  const { s } = consoleProvince(id);
  if (!LEVEL_TYPES.includes(kind)) throw new Error(`no level "${kind}"; try ${consoleChoices(LEVEL_TYPES)}`);
  const ground = Array.isArray(s[kind]) ? s[kind][1] : 0;
  const max = usableCeiling(kind, ground);
  if (!Number.isInteger(level) || level < 0 || level > max) {
    throw new Error(`${kind} in "${id}" can be 0 to ${max}`);
  }
  s[kind] = [level, ground];
  worldChanged();
  return consoleInfrastructure(id);
}

// Sets civilian and military factories within the unlocked slots.
function setFactoriesFromConsole(id, civilian, military = 0) {
  const { s } = consoleProvince(id);
  for (const n of [civilian, military]) {
    if (!Number.isInteger(n) || n < 0) throw new Error('factory counts are whole numbers from 0');
  }
  const { slots } = consoleInfrastructure(id);
  if (civilian + military > slots.unlocked) {
    throw new Error(`"${id}" has ${slots.unlocked} of ${slots.max} building slots unlocked`);
  }
  s.civilianFactories = civilian;
  s.militaryFactories = military;
  worldChanged();
  return consoleInfrastructure(id);
}

// A county's fortification, 0 to what its own terrain and climate allow.
function setFortFromConsole(countyId, level) {
  const c = state.world?.counties?.byId?.get(countyId);
  if (!c) throw new Error(`no county "${countyId}"`);
  const max = countyFortCeiling(c);
  if (!Number.isInteger(level) || level < 0 || level > max) {
    throw new Error(`fortification in "${countyId}" can be 0 to ${max}`);
  }
  if (level) c.fortification = level;
  else delete c.fortification;
  worldChanged();
  return { county: countyId, fortification: level, max };
}

// Lays or lifts rail between two counties; one county alone lifts all its lines.
function setRailFromConsole(a, b, on) {
  const w = state.world;
  const cs = w?.counties;
  const ca = cs?.byId?.get(a);
  if (!ca) throw new Error(`no county "${a}"`);
  const link = (x, y) => { x.rail = [...new Set([...(x.rail || []), y])]; };
  const unlink = (x, y) => { if (Array.isArray(x.rail)) x.rail = x.rail.filter((z) => z !== y); };

  if (b === undefined) {
    if (on) ca.rail = ca.rail || [];
    else {
      for (const id of ca.rail || []) {
        const other = cs.byId.get(id);
        if (other) unlink(other, a);
      }
      delete ca.rail;
    }
  } else {
    const cb = cs.byId.get(b);
    if (!cb) throw new Error(`no county "${b}"`);
    if (on && ![...(cs.adjacency?.get(a) || [])].includes(b)) {
      throw new Error(`"${a}" and "${b}" do not border each other`);
    }
    if (on) { link(ca, b); link(cb, a); } else { unlink(ca, b); unlink(cb, a); }
  }

  worldChanged();
  return { county: a, rail: ca.rail ?? null };
}

export { consoleGov, consoleChoices, consoleGovSummary, governmentChanged, setLawFromConsole, setFormFromConsole, setDoctrineFromConsole, setActFromConsole, setSpiritFromConsole, consoleProvince, consoleInfrastructure, setLevelFromConsole, setFactoriesFromConsole, setFortFromConsole, setRailFromConsole };
