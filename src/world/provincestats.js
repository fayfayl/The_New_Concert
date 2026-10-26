// Merges and splits the province tables by kind of fact.

// The six levelled building types, stored as [built, ceiling] once merged.
export const LEVELS = ['road', 'electricity', 'radar', 'supplyHub', 'antiAir', 'airBase'];

/** Ceiling field names in province-stats.json, matching the glossary's maxRoad. */
export const CEILING_OF = Object.fromEntries(
  LEVELS.map((k) => [k, 'max' + k[0].toUpperCase() + k.slice(1)])
);

// Factory types sharing one province slot pool.
export const FACTORIES = ['civilianFactories', 'militaryFactories'];

// Building types, stored per county.
export const BUILDINGS = ['eyrie', 'dockyard', 'syntheticOil', 'syntheticRubber'];

// Stored map position of each building's mark, as [x, y].
export const BUILDING_AT = {
  eyrie: 'eyrieAt',
  dockyard: 'dockyardAt',
  syntheticOil: 'syntheticOilAt',
  syntheticRubber: 'syntheticRubberAt',
};
// Attitude fields stored per province.
export const ATTITUDE = ['unrest', 'resistance', 'compliance', 'annexedOn'];

const ATTITUDE_BLANK = { unrest: 0, resistance: 0, compliance: 0, annexedOn: null };

// Per-province ideology support, points summing to 100.
export const SUPPORT = 'support';

// Merges the four province files into one shape; each is optional.
export function mergeStats(stats, infrastructure, attitude, support) {
  const base = stats?.provinces || {};
  const inf = infrastructure?.provinces || {};
  const att = attitude?.provinces || {};
  const sup = support?.provinces || {};
  const out = {};
  for (const [id, s] of Object.entries(base)) {
    const i = inf[id] || {}, a = att[id] || {};
    const e = {
      claims: s.claims || [],
      population: s.population || 0,
      buildingSlots: s.buildingSlots || [0, 0],
      hydroPotential: s.hydroPotential || 0,
    };
    for (const k of LEVELS) e[k] = [i[k] || 0, s[CEILING_OF[k]] || 0];
    for (const k of FACTORIES) e[k] = i[k] || 0;
    for (const k of ATTITUDE) e[k] = k in a ? a[k] : ATTITUDE_BLANK[k];
    e[SUPPORT] = { ...(sup[id] || {}) };
    out[id] = e;
  }
  return out;
}

// Splits merged stats into the four files, dropping zeroes.
export function splitStats(merged) {
  const stats = {}, infrastructure = {}, attitude = {}, support = {};
  for (const [id, e] of Object.entries(merged)) {
    const s = { claims: e.claims || [], population: e.population || 0 };
    for (const k of LEVELS) s[CEILING_OF[k]] = (Array.isArray(e[k]) ? e[k][1] : 0) || 0;
    s.buildingSlots = e.buildingSlots || [0, 0];
    s.hydroPotential = e.hydroPotential || 0;
    stats[id] = s;

    const i = {};
    for (const k of LEVELS) { const b = Array.isArray(e[k]) ? e[k][0] : Number(e[k]) || 0; if (b) i[k] = b; }
    for (const k of FACTORIES) if (e[k]) i[k] = e[k];
    if (Object.keys(i).length) infrastructure[id] = i;

    const a = {};
    for (const k of ATTITUDE) if (e[k]) a[k] = e[k];
    if (Object.keys(a).length) attitude[id] = a;

    if (e[SUPPORT] && Object.keys(e[SUPPORT]).length) support[id] = e[SUPPORT];
  }
  return { stats, infrastructure, attitude, support };
}
