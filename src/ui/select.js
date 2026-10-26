// Picking provinces, counties and sea under the pointer, and selection.

const VERSION = new URL(import.meta.url).search;
const { OCEAN, addRealmBlocks, isOccupied } = await import(`../world/mapdata.js${VERSION}`);
const { countyFortCeiling } = await import(`../world/ceilings.js${VERSION}`);
const { setOwners } = await import(`../world/ownership.js${VERSION}`);
const { UNKNOWN_POLITY, dirtyBoxes, els, invalidateBuffer, invalidateProvinces, invalidateView, state, worldChanged } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let DESELECT_FADE_MS, boxesFor, buildLabel, buildSilhouette, nameArchipelagos, paintFlagBlock, playSelect, playWater, polityOf, screenToMap, tooBigToLight, tooBigToLightBox, updateCard, updatePanel;
export function link(all) { ({ DESELECT_FADE_MS, boxesFor, buildLabel, buildSilhouette, nameArchipelagos, paintFlagBlock, playSelect, playWater, polityOf, screenToMap, tooBigToLight, tooBigToLightBox, updateCard, updatePanel } = all); }

// Pointer position in map pixels, with the map copy it was read off.
function mapPointAtEvent(ev) {
  const w = state.world;
  if (!w) return null;
  const rect = els.canvas.getBoundingClientRect();
  const { x, y } = screenToMap(ev.clientX - rect.left, ev.clientY - rect.top);
  const fx = Math.floor(x);
  return {
    x: ((fx % w.width) + w.width) % w.width,
    y: Math.floor(y),
    copy: Math.floor(fx / w.width),
  };
}

// Map cell index under a pointer event, or -1; cached per event.
const cellByEvent = new WeakMap();

function cellAtEvent(ev) {
  const had = cellByEvent.get(ev);
  if (had !== undefined) return had;

  const w = state.world;
  const rect = els.canvas.getBoundingClientRect();
  const { x, y } = screenToMap(ev.clientX - rect.left, ev.clientY - rect.top);
  const py = Math.floor(y);
  const cell = py < 0 || py >= w.height
    ? -1
    : py * w.width + ((((Math.floor(x) % w.width) + w.width) % w.width));

  cellByEvent.set(ev, cell);
  return cell;
}

// The province under the cursor, or null.
function provinceAtEvent(ev) {
  const w = state.world;
  const i = cellAtEvent(ev);
  if (i < 0) return null;
  const index = w.provinceAt[i];
  return index === OCEAN ? null : w.atIndex[index].id;
}

// The county under the cursor, or null.
function countyAtEvent(ev) {
  const w = state.world;
  if (!w || !w.counties) return null;
  const i = cellAtEvent(ev);
  if (i < 0) return null;
  const ix = w.counties.countyAt[i];
  return ix ? w.counties.atIndex[ix] : null;
}

// The sea subregion under the pointer, or null off the water.
function subAtEvent(ev) {
  const w = state.world;
  const subs = w && w.subs;
  if (!subs) return null;
  const i = cellAtEvent(ev);
  if (i < 0 || w.provinceAt[i] !== OCEAN) return null;
  const ix = subs.subAt[i];
  return ix === 0 ? null : subs.atIndex[ix].id;
}

// The sea region under the cursor, or null; land wins.
function seaAtEvent(ev) {
  const w = state.world;
  const sea = w && w.sea;
  if (!sea) return null;
  const i = cellAtEvent(ev);
  if (i < 0 || w.provinceAt[i] !== OCEAN) return null;
  const region = sea.seaAt[i];
  return region === 0 ? null : sea.atIndex[region].id;
}

// Marks a sea region for repaint, unless over the highlight ceiling.
function invalidateSea(...ids) {
  const sea = state.world && state.world.sea;
  if (!sea) return;
  for (const id of ids) {
    const bb = id && sea.bounds.get(id);
    if (bb && !tooBigToLightBox(bb)) dirtyBoxes.push(...boxesFor(state.world, bb));
  }
}

// Selects a sea region, or clears the selection when `id` is null.
function selectSea(id) {
  if (state.selectedSea === id) return;
  const was = state.selectedSea;
  state.selectedSea = id;
  if (id) playWater();
  invalidateSea(was, id);
}

// Selects or hovers a sea subregion, repainting the water buffer.
function selectSub(id) {
  if (state.selectedSub === id) return;
  state.selectedSub = id;
  if (id) playWater();
  if (state.mode === 'navy') invalidateBuffer();
}

function hoverSub(id) {
  if (state.hoveredSub === id) return;
  state.hoveredSub = id;
  if (state.mode === 'navy') invalidateBuffer();
}

// Sets the hovered sea region.
function hoverSea(id) {
  if (state.hoveredSea === id) return;
  const was = state.hoveredSea;
  state.hoveredSea = id;
  invalidateSea(was, id);
}

// Dropped selection's remaining highlight, 1 down to 0, smoothstepped.
function fadeStrength() {
  if (!state.fade) return 0;
  const t = (performance.now() - state.fade.t0) / DESELECT_FADE_MS;
  if (t >= 1) return 0;
  const k = 1 - t;
  return k * k * (3 - 2 * k);
}

// Selects a province, or clears the selection when `id` is null.
function select(id) {
  const was = state.selected;
  if (was === id) {
    if (id) updateCard();
    return;
  }
  state.selected = id;
  if (id) playSelect();

  invalidateProvinces(was, id);
  for (const q of neighboursOf(was)) invalidateProvinces(q);
  for (const q of neighboursOf(id)) invalidateProvinces(q);

  if (state.fade) invalidateProvinces(state.fade.id, ...state.fade.neighbours);

  state.fade = was
    ? { id: was, neighbours: new Set(neighboursOf(was)), silhouette: state.silhouette, outline: null, t0: performance.now() }
    : null;

  state.silhouette = id && !tooBigToLight(state.world, id) ? buildSilhouette(state.world, id) : null;
  state.outline = null;
  updateCard();
  updatePanel();
}

// The county under the right button.

// Picks the county under the pointer, or clears it when `id` is null.
function selectCounty(id) {
  const w = state.world;
  const county = id && w.counties ? w.counties.byId.get(id) : null;
  if (!county) {
    const had = state.county;
    state.county = null;
    els.countyCard.classList.remove('open');
    els.countyCard.setAttribute('aria-hidden', 'true');
    if (had) invalidateView();
    return;
  }

  playSelect();

  state.county = {
    id,
    silhouette: buildSilhouette(w.counties, id, w.counties.countyAt),
    outline: null,
  };
  updateCountyCard(county);
  invalidateView();
}

// Fills the county panel and slides it in.
function updateCountyCard(county) {
  const w = state.world;
  const province = w.byId.get(county.province);
  const pol = province ? polityOf(w, province) : UNKNOWN_POLITY;

  els.countyName.textContent = county.name;
  paintFlagBlock(els.countyFlag, pol);
  els.countyPolity.textContent = pol.name;
  els.countyProvince.textContent = province ? province.name : '—';

  const owner = isOccupied(province)
    ? w.table.polityById.get(province.owner) : null;
  els.countyOwner.hidden = !owner;
  els.countyOwner.textContent = owner ? `occupied — owned by ${owner.name}` : '';

  els.countyTerrain.textContent = county.terrain.join(' + ') || '—';
  els.countyClimate.textContent = county.climate || '—';

  els.countyFort.textContent = `${county.fortification || 0}/${countyFortCeiling(county)}`;

  els.countyRail.textContent = county.rail ? 'Yes' : 'No';
  els.countyArea.textContent = county.area >= 1e6
    ? `${(county.area / 1e6).toFixed(2)}M km²`
    : `${Math.round(county.area).toLocaleString()} km²`;

  els.countyCard.classList.add('open');
  els.countyCard.setAttribute('aria-hidden', 'false');
}

// A province's neighbour ids, or nothing when `id` is null.
const neighboursOf = (id) => (id && state.world.adjacency.get(id)) || [];

// Provinces changing hands.

// Hands provinces to new owners; returns true if any moved.
function changeOwners(changes) {
  const w = state.world;
  if (!w) return false;

  const result = setOwners(w, w.geometry, changes);
  if (!result) return false;

  for (const b of result.blocks) w.labels[b] = buildLabel(w, w.geometry, b);

  for (const b of addRealmBlocks(w, w.geometry)) w.labels[b] = buildLabel(w, w.geometry, b);

  nameArchipelagos(w, w.geometry, w.labels);

  dirtyBoxes.push(...result.boxes);

  worldChanged();
  return true;
}

export { mapPointAtEvent, cellByEvent, cellAtEvent, provinceAtEvent, countyAtEvent, subAtEvent, seaAtEvent, invalidateSea, selectSea, selectSub, hoverSub, hoverSea, fadeStrength, select, selectCounty, updateCountyCard, neighboursOf, changeOwners };
