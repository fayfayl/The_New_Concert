/**
 * provincestats.js — the province tables, split by what kind of fact they are.
 *
 * One province's figures used to live in one file, which mixed three things
 * that change for three different reasons:
 *
 *   province-stats.json                    what the map and the authoring fix.
 *                                          Population, claims, the ceilings the
 *                                          ground allows, the building slots.
 *                                          A game never changes any of it.
 *
 *   provinces-starting-infrastructure.json what a game STARTS with built, and
 *                                          what a save therefore has to carry:
 *                                          the six levels and the two factory
 *                                          counts.
 *
 *   provinces-starting-attitude.json       what a game starts with felt: unrest,
 *                                          the strikes a province has taken, how
 *                                          far an occupied one resists and
 *                                          complies, and when it was annexed.
 *
 *   provinces-starting-support.json        what a game starts with wanted: the
 *                                          share of the province behind each
 *                                          named ideology and behind none.
 *
 * The rest of the code wants one object per province with `road` as
 * [built, ceiling], so the files are merged back into that shape on load and
 * split again on write. Nothing downstream of mergeStats() knows there are four
 * files, which is the point: the split is about how the data is stored and
 * edited, not about how it is used.
 */

/** The six levelled types, stored as [built, ceiling] once merged. */
export const LEVELS = ['road', 'electricity', 'radar', 'supplyHub', 'antiAir', 'airBase'];

/** Ceiling field names in province-stats.json, matching the glossary's maxRoad. */
export const CEILING_OF = Object.fromEntries(
  LEVELS.map((k) => [k, 'max' + k[0].toUpperCase() + k.slice(1)])
);

export const FACTORIES = ['civilianFactories', 'militaryFactories'];

// Buildings live on COUNTIES, in counties-starting-values.json beside the
// railway, because a building stands in one place and is captured with the
// ground it stands on. They are kept out of counties.json for the reason rail is:
// that file is read back off counties.png on every sync and nothing on a bitmap
// records a building.
// These two are exported from here because this is where the shape of a
// province's data is described, and the drawer and the console read them.
//
// They are flags rather than counts: a province either holds one or it does
// not, and there is no such thing as two. They take no building slot and no
// ceiling, so they carry no [built, max] pair and are true or false throughout.
export const BUILDINGS = ['eyrie', 'dockyard', 'syntheticOil', 'syntheticRubber'];

// Where a building's mark stands, as [x, y] in map pixels. Worked out once from
// the ground the day the building appears and then stored, never recomputed: a
// mark that moved because a county was retagged or the placement rule was
// tightened would be a building that had walked across its own province.
export const BUILDING_AT = {
  eyrie: 'eyrieAt',
  dockyard: 'dockyardAt',
  syntheticOil: 'syntheticOilAt',
  syntheticRubber: 'syntheticRubberAt',
};
// collaboration is NOT here: it is derived at capture from claims and the
// province's own happiness, never stored. See collaborationOf() in main.js.
// struck is NOT here. It is stored per county, in counties.json beside the
// railway, because a province of thirty counties and a province of one should
// not answer the same way for the same number of battles. The province reads the
// mean of its counties as `struckAverage`, filled on load.
export const ATTITUDE = ['unrest', 'resistance', 'compliance', 'annexedOn'];

const ATTITUDE_BLANK = { unrest: 0, resistance: 0, compliance: 0, annexedOn: null };

// What a province wants, as points across the 22 named ideologies and 'unaligned',
// summing to 100. Held per province because support is not uniform across a
// country. A province with no entry wants nothing anybody has named.
export const SUPPORT = 'support';

/**
 * Puts the three files back into the one shape the rest of the code reads.
 * Every argument is optional: a missing file leaves its fields at their blanks,
 * so the map still draws with nothing but province-stats.json present.
 */
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

/**
 * The reverse. Returns the four objects ready to be written, dropping anything
 * that is zero from the two starting-value files: a province with
 * nothing built has nothing to say, and writing 1,525 zeroes for every field
 * would put back most of the weight the split was meant to remove.
 */
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
