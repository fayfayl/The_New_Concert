// Province and county ceilings from terrain and climate.

// Level ceilings for the six province types, by landform.
export const LEVEL_TERRAIN_CEILING = {
  Plains:    { road: 10, electricity: 10, radar: 10, supplyHub: 10, antiAir: 10, airBase: 10 },
  Hills:     { road:  8, electricity:  8, radar: 10, supplyHub:  8, antiAir: 10, airBase:  6 },
  Mountains: { road:  4, electricity:  6, radar:  8, supplyHub:  4, antiAir:  8, airBase:  2 },
  Alpine:    { road:  2, electricity:  3, radar:  5, supplyHub:  2, antiAir:  6, airBase:  0 },
};

// Climate caps on level ceilings; missing types are uncapped.
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

// County fortification ceiling by landform.
export const FORT_TERRAIN_CEILING = { Plains: 6, Hills: 8, Mountains: 10, Alpine: 8, Urban: 8 };
export const FORT_CLIMATE_CEILING = { Rainforest: 4, Monsoon: 5, Desert: 4, Subarctic: 5, Tundra: 4, 'Ice cap': 3 };

// Latitude below which subarctic counts as altitude.
export const SUBARCTIC_BY_ALTITUDE = 50;

// Cost multipliers on building and upkeep, by landform and climate.
export const TERRAIN_COST = { Plains: 1.0, Urban: 1.0, Hills: 1.4, Mountains: 2.2, Alpine: 3.5 };
export const CLIMATE_COST = {
  Steppe: 1.1, Savanna: 1.2, Desert: 1.3, Monsoon: 1.5, Subarctic: 1.5, Rainforest: 1.6, Tundra: 2.0, 'Ice cap': 2.4,
};

// A county's terrain times climate cost, averaging mixed ground.
export function groundCost(c) {
  const mean = (list, table) => {
    const known = list.filter((x) => table[x] !== undefined);
    return known.length ? known.reduce((a, x) => a + table[x], 0) / known.length : 1;
  };
  return mean([].concat(c.terrain || []), TERRAIN_COST) * mean([].concat(c.climate || []), CLIMATE_COST);
}

// Fort ceiling for a county, 0 to 10.
export function countyFortCeiling(c) {
  let ceil = 0;
  for (const t of [].concat(c.terrain || [])) ceil = Math.max(ceil, FORT_TERRAIN_CEILING[t] || 0);
  if (!ceil) return 0;
  const cap = FORT_CLIMATE_CEILING[c.climate];
  const highGround = c.climate === 'Subarctic' && Math.abs(c.centre?.[0] ?? 90) < SUBARCTIC_BY_ALTITUDE;
  return cap !== undefined && !highGround ? Math.min(ceil, cap) : ceil;
}
