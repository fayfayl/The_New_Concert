/**
 * ceilings.js — what the ground allows, in one place.
 *
 * Two readers need these figures and must never disagree: sync-provinces.js,
 * which settles the province ceilings once and writes them into
 * province-stats.json, and the game, which works out a county's fortification
 * ceiling on the fly. Both import from here, so a figure tuned in the plans is
 * changed once.
 *
 * Values are under Province mechanics, Maximum levels and Counties,
 * Fortification in the plans.
 */

// The six levelled province types, by landform. Keyed by type name rather than
// by position so a table cannot fall out of step with LEVELS in provincestats.js
// by being reordered; sync-provinces.js refuses to run if a level is missing.
export const LEVEL_TERRAIN_CEILING = {
  Plains:    { road: 10, electricity: 10, radar: 10, supplyHub: 10, antiAir: 10, airBase: 10 },
  Hills:     { road:  8, electricity:  8, radar: 10, supplyHub:  8, antiAir: 10, airBase:  6 },
  Mountains: { road:  4, electricity:  6, radar:  8, supplyHub:  4, antiAir:  8, airBase:  2 },
  Alpine:    { road:  2, electricity:  3, radar:  5, supplyHub:  2, antiAir:  6, airBase:  0 },
};

// A type left out of a climate's row is not capped by it, and the four temperate
// climates are absent for the same reason. A climate can only ever LOWER the
// terrain figure, so a number above the terrain ceiling would never bind.
export const LEVEL_CLIMATE_CEILING = {
  Rainforest: { road: 5, electricity: 6, radar: 4, supplyHub: 5, antiAir:  5, airBase:  4 },
  Monsoon:    { road: 6, electricity: 7, radar: 5, supplyHub: 6, antiAir:  6, airBase:  5 },
  Savanna:    { road: 8, electricity: 8,           supplyHub: 8, antiAir:  9, airBase:  8 },
  Desert:     { road: 6, electricity: 8, radar: 9, supplyHub: 6, antiAir: 10, airBase:  9 },
  Steppe:     { road: 8, electricity: 8,           supplyHub: 8, antiAir: 10, airBase: 10 },
  Subarctic:  { road: 4, electricity: 6, radar: 6, supplyHub: 5, antiAir:  7, airBase:  6 },
  Tundra:     { road: 2, electricity: 4, radar: 5, supplyHub: 3, antiAir:  6, airBase:  4 },
  'Ice cap':  { road: 1, electricity: 2, radar: 4, supplyHub: 2, antiAir:  4, airBase:  2 },
};

// The county fortification ceiling. Urban keeps 8 rather than taking the Plains
// row, because a city is harder to take than the field outside it.
export const FORT_TERRAIN_CEILING = { Plains: 6, Hills: 8, Mountains: 10, Alpine: 8, Urban: 8 };
export const FORT_CLIMATE_CEILING = { Rainforest: 4, Monsoon: 5, Desert: 4, Subarctic: 5, Tundra: 4, 'Ice cap': 3 };

// Below this latitude, subarctic is altitude rather than latitude. A subarctic
// county at 40 degrees is a mountain; one at 65 is the far north. The map splits
// at almost exactly this line: below 40 degrees, 85% of subarctic counties are
// mountain or alpine, and above 60 only 1% are.
//
// It lifts the FORTIFICATION cap alone. The level caps are about weather, which
// a mountain has just the same, but the fortification cap stands for permafrost
// and a building season measured in weeks, and a temperate mountain has neither.
// Rock is the best ground on the map to dig into.
export const SUBARCTIC_BY_ALTITUDE = 50;

/**
 * What a county's own ground allows, 0 to 10.
 *
 * The HIGHEST of its landforms, not the lowest and not a mean: a county holding
 * mountains holds the ground works are dug into whatever else is in it. Climate
 * then lowers it and never raises it, except for subarctic held by altitude.
 */
export function countyFortCeiling(c) {
  let ceil = 0;
  for (const t of [].concat(c.terrain || [])) ceil = Math.max(ceil, FORT_TERRAIN_CEILING[t] || 0);
  if (!ceil) return 0;
  const cap = FORT_CLIMATE_CEILING[c.climate];
  const highGround = c.climate === 'Subarctic' && Math.abs(c.centre?.[0] ?? 90) < SUBARCTIC_BY_ALTITUDE;
  return cap !== undefined && !highGround ? Math.min(ceil, cap) : ceil;
}
