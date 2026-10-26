// Map modes, their colours, and the resource and infrastructure tables.

const VERSION = new URL(import.meta.url).search;
const { controllerOf, toRgb } = await import(`../world/mapdata.js${VERSION}`);
const { UNALIGNED } = await import(`../game/government.js${VERSION}`);
const { UNKNOWN_POLITY, cssToken } = await import(`../core/core.js${VERSION}`);

// The world model is built in mapdata.js.

// Colours for the four terrain tiers.
const TERRAIN_COLOURS = Object.fromEntries(Object.entries({
  Plains: '#7c945c',
  Hills: '#968454',
  Mountains: '#808086',
  Alpine: '#aeb3bd',
}).map(([k, v]) => [k, toRgb(v)]));

// Colours for the twelve Köppen climate groups.
const CLIMATE_COLOURS = Object.fromEntries(Object.entries({
  'Ice cap': '#ced8e0',
  Tundra: '#b9c3c4',
  Subarctic: '#6e8a72',
  'Humid continental': '#8aa165',
  Oceanic: '#7fa679',
  Mediterranean: '#a8a765',
  'Humid subtropical': '#789a5e',
  Monsoon: '#5f8f57',
  Rainforest: '#487a4a',
  Savanna: '#b3a869',
  Steppe: '#c0b57e',
  Desert: '#ceb876',
}).map(([k, v]) => [k, toRgb(v)]));

// The mean of a list of colours, or null when the list is empty.
const meanColour = (cols) => (cols.length
  ? [0, 1, 2].map((c) => cols.reduce((s, q) => s + q[c], 0) / cols.length)
  : null);

// Impassable water and its darkened colour.
const IMPASSABLE = 'Impassable';
const IMPASSABLE_COLOUR = toRgb('#23262c');
const IMPASSABLE_MIX = 0.45;    // mix toward the near-black

// Resource kinds: sprite cell, display name and fallback word.
const RESOURCE_KINDS = {
  fertileLand: { cell: 0, name: 'Fertile land', mark: 'Food' },
  coal:        { cell: 1, name: 'Coal', mark: 'Coal' },
  timber:      { cell: 2, name: 'Timber', mark: 'Wood' },
  iron:        { cell: 3, name: 'Iron', mark: 'Iron' },
  fish:        { cell: 4, name: 'Fish', mark: 'Fish' },
  textiles:    { cell: 5, name: 'Textiles', mark: 'Cloth' },
  oil:         { cell: 6, name: 'Oil', mark: 'Oil' },
  baseMetals:  { cell: 7, name: 'Base metals', mark: 'Base' },
  baul:        { cell: 8, name: 'Baul', mark: 'Baul' },
  aluminium:   { cell: 9, name: 'Aluminium', mark: 'Alum' },
  naturalGas:  { cell: 10, name: 'Natural gas', mark: 'Gas' },
  rareMetals:  { cell: 11, name: 'Rare metals', mark: 'Rare' },
  rubber:      { cell: 12, name: 'Rubber', mark: 'Rubber' },
  gold:        { cell: 13, name: 'Gold', mark: 'Gold' },
  nitrates:    { cell: 14, name: 'Nitrates', mark: 'Nitre' },
  tungsten:    { cell: 15, name: 'Tungsten', mark: 'Tungsten' },
  tazkuri:     { cell: 16, name: 'Tazkuri', mark: 'Tazkuri' },
  goizederium: { cell: 17, name: 'Goizederium', mark: 'Goiz' },
  livestock:   { cell: 18, name: 'Livestock', mark: 'Stock' },
};
const resourceField = (field) => Object.fromEntries(Object.entries(RESOURCE_KINDS).map(([k, r]) => [k, r[field]]));
const RESOURCE_ICON = resourceField('cell');
const RESOURCE_NAME = resourceField('name');
const RESOURCE_MARK = resourceField('mark');

const RESOURCE_SHEET_COLS = 6;
const RESOURCE_SHEET_CELL = 64;

// Resource layer text sizing and minimum on-screen province size.
const RESOURCE_LINE = 8.5;      // css pixels per line, before zoom
const RESOURCE_OVERHANG = 0.5;  // how much of a line may hang past the province
// Icon size at the text ceiling.
const RESOURCE_ICON_PX = 15;
// Text scale for the selected province.
const RESOURCE_SELECTED = 1.6;
const RESOURCE_MIN_LINE = 6;
const RESOURCE_MAX_LINE = 13;

// A province's controlling polity, or the Unknown fallback.
const polityOf = (w, p) => w.table.polityById.get(controllerOf(p)) || UNKNOWN_POLITY;

// A polity's short name, with "the" in prose when it takes one.
const shortNameOf = (polity, article = false) => {
  const short = polity?.short || polity?.name || '';
  return article && polity?.definite ? 'the ' + short : short;
};

// Map modes: each maps a province to its base colour.
const MODES = {
  political: (w, p) => polityOf(w, p).colour,
  province: (w, p) => p.colour,
  // County mode: political colour for sea and uncovered land.
  county: (w, p) => polityOf(w, p).colour,

  // Navy mode: land drawn as flat slate.
  navy: () => NAVY_LAND,

  // Resource mode: political colour under the resource figures.
  resources: (w, p) => polityOf(w, p).colour,
  // Ideology mode: the leading movement's colour.
  ideology: (w, p) => supportColour(w, p),

  terrain: (w, p) => {
    // Averages landform and climate colours separately, then evenly.
    const land = meanColour(p.terrain.map((t) => TERRAIN_COLOURS[t]).filter(Boolean));
    const air = meanColour(p.climate.map((k) => CLIMATE_COLOURS[k]).filter(Boolean));
    const base = land && air
      ? [0, 1, 2].map((c) => (land[c] + air[c]) / 2)
      : land || air || [120, 120, 120];
    return base.map(Math.round);
  },
};

// Infrastructure layers, registered as political-colour map modes.
const INFRA_NAME = {
  road: 'Road', electricity: 'Electricity', radar: 'Radar station', fortNew: 'Fort',
  supplyHub: 'Supply hub', antiAir: 'Anti-air', airBase: 'Air base',
  factories: 'Factories', hydro: 'Hydro', rail: 'Rail',
};
const INFRA_LAYERS = Object.keys(INFRA_NAME);
for (const key of INFRA_LAYERS) MODES['infra:' + key] = (w, p) => polityOf(w, p).colour;

// County map colours, muted toward a common wash.
const COUNTY_MIX = 0.45;           // how far a county moves toward the wash
const COUNTY_WASH = [214, 208, 196];
const COUNTY_EDGE = 0.82;
const COUNTY_PROVINCE = 0.34;

// Navy mode palette: region hues compressed into water arcs.
const NAVY_LAND = [64, 68, 76];

// Colour for provinces with no support data.
const SUPPORT_BLANK = [56, 58, 62];
// Support share range for the ideology wash.
const SUPPORT_FLOOR = 12;
const SUPPORT_FULL = 40;
const SUPPORT_WASH = 0.85;

// The leading movement's colour, washed out by its share.
function supportColour(w, p) {
  const s = w.stats?.[p.id]?.support;
  if (!s) return SUPPORT_BLANK;
  let lead = null;
  for (const [name, share] of Object.entries(s)) {
    if (name === UNALIGNED || !(share > 0)) continue;
    if (!lead || share > lead[1]) lead = [name, share];
  }
  const c = lead && w.ideologyColour?.get(lead[0]);
  if (!c) return SUPPORT_BLANK;

  const t = Math.max(0, Math.min(1, (lead[1] - SUPPORT_FLOOR) / (SUPPORT_FULL - SUPPORT_FLOOR)));
  const wash = (1 - t) * SUPPORT_WASH;
  return c.map((v) => Math.round(v + (255 - v) * wash));
}

// Sea subregion shade spread and border darkness.
const NAVY_SUB_SPREAD = 0.13;
const NAVY_SUB_EDGE = 0.86;
const NAVY_SEA_ARC = [170, 264];   // degrees: cyan, through blue, to violet
const NAVY_LAKE_ARC = [92, 158];   // and the arc a lake may take: green to teal
const NAVY_SAT = 0.46;
const NAVY_LIGHT = 0.33;
const NAVY_LAKE_LIGHT = 0.40;
const NAVY_LIGHT_SPREAD = 0.13;    // how much of the source lightness survives
const NAVY_EDGE = 0.58;            // sea region border, as a multiplier
const NAVY_LIGHTEN = { selected: 0.26, hovered: 0.12 };

// Border darkness, as a multiplier on the province colour.
const BORDER_INTERNAL = 0.85;   // neighbour has the same owner
const BORDER_NATIONAL = 0.42;   // neighbour has a different owner, or is open sea

// Mix toward white for each highlight state.
const LIGHTEN = { selected: 0.10, neighbour: 0.04, hovered: 0.04 };

// Per-pixel opacity of the province layer over satellite imagery.
const SATELLITE_NATIONAL = 0.88;  // the drawn frontier line itself
const SATELLITE_INTERNAL = 0.22;  // province subdivisions, added to fill alpha
const SATELLITE_RIM = 0.82;       // country colour hard against a national border
const SATELLITE_CORE = 0.36;      // country colour deep inland
const FADE_PX = 24;               // colour reach inland, in map pixels
const FADE_CURVE = 0.8;           // < 1 concentrates the falloff near the border

// Flat layer opacity over imagery for non-political modes.
const SATELLITE_FLAT = 0.84;

// Pastel wash applied to inland colour.
const PASTEL_MIX = 0.55;
const PASTEL_TOWARD = [226, 231, 238];

// Extra opacity for highlighted provinces.
const SATELLITE_LIFT = { selected: 0.5, neighbour: 0.32, hovered: 0.22 };

// Fade-out time for a dropped selection.
const DESELECT_FADE_MS = 60;

// Colour of the ring around the selected province.
const OUTLINE_COLOUR = cssToken('--gold');

// Map background colour.
const MAP_GROUND = cssToken('--steel-deepest');

// County selection ring colour, alpha and outline width.
const COUNTY_RING_COLOUR = '#e6eef7ff';
const COUNTY_RING_ALPHA = 0.85;
const OUTLINE_WIDTH = 2.5;

export { TERRAIN_COLOURS, CLIMATE_COLOURS, meanColour, IMPASSABLE, IMPASSABLE_COLOUR, IMPASSABLE_MIX, RESOURCE_KINDS, resourceField, RESOURCE_ICON, RESOURCE_NAME, RESOURCE_MARK, RESOURCE_SHEET_COLS, RESOURCE_SHEET_CELL, RESOURCE_LINE, RESOURCE_OVERHANG, RESOURCE_ICON_PX, RESOURCE_SELECTED, RESOURCE_MIN_LINE, RESOURCE_MAX_LINE, polityOf, shortNameOf, MODES, INFRA_NAME, INFRA_LAYERS, COUNTY_MIX, COUNTY_WASH, COUNTY_EDGE, COUNTY_PROVINCE, NAVY_LAND, SUPPORT_BLANK, SUPPORT_FLOOR, SUPPORT_FULL, SUPPORT_WASH, supportColour, NAVY_SUB_SPREAD, NAVY_SUB_EDGE, NAVY_SEA_ARC, NAVY_LAKE_ARC, NAVY_SAT, NAVY_LIGHT, NAVY_LAKE_LIGHT, NAVY_LIGHT_SPREAD, NAVY_EDGE, NAVY_LIGHTEN, BORDER_INTERNAL, BORDER_NATIONAL, LIGHTEN, SATELLITE_NATIONAL, SATELLITE_INTERNAL, SATELLITE_RIM, SATELLITE_CORE, FADE_PX, FADE_CURVE, SATELLITE_FLAT, PASTEL_MIX, PASTEL_TOWARD, SATELLITE_LIFT, DESELECT_FADE_MS, OUTLINE_COLOUR, MAP_GROUND, COUNTY_RING_COLOUR, COUNTY_RING_ALPHA, OUTLINE_WIDTH };
