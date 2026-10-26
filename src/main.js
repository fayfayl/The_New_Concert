// Province map viewer: loads every module, wires them together and boots.

// Imported with the ?v= token index.html loaded this file with, so every module is fetched fresh.
const VERSION = new URL(import.meta.url).search;

const { CACHE_FILE, applyCountyOccupation, countiesFromCache, hashInputs, seaFromCache, subsFromCache, worldFromCache } = await import(`./world/mapcache.js${VERSION}`);
const { addRealmBlocks, attachBlockMembers, buildBorderDistance, buildCountyWorld, buildSeaWorld, buildSubWorld, buildWorld, computeLabelGeometry, indexCounties, indexProvinces, indexSea, indexSubs, normaliseCountyTable, normaliseSeaTable, normaliseSubTable, normaliseTable, toRgb } = await import(`./world/mapdata.js${VERSION}`);
const { BUILDINGS, BUILDING_AT, mergeStats } = await import(`./world/provincestats.js${VERSION}`);
const { UNALIGNED } = await import(`./game/government.js${VERSION}`);
const MODULES = ['core/core', 'core/load', 'render/modes', 'render/tiles', 'render/labels', 'render/view', 'layers/cities', 'layers/resourcelayer', 'layers/debugdraw', 'layers/infralayer', 'layers/marks', 'ui/console', 'ui/card', 'game/clock', 'ui/select', 'ui/tooltip', 'ui/panel', 'game/province', 'ui/diplo', 'ui/tips', 'game/nation', 'game/industry', 'game/production', 'game/resources', 'game/relations', 'game/treaties', 'game/acts', 'ui/readout', 'ui/menus', 'ui/audio', 'ui/input'];
const loaded = await Promise.all(MODULES.map((n) => import(`./${n}.js${VERSION}`)));
const all = Object.assign({}, ...loaded);
for (const m of loaded) m.link?.(all);
const { CLOCK_EPOCH, DAY_MS, MARKS, MARK_KINDS, MAX_SCALE, MIN_SCALE, POLITICAL_POWER_BASE, RESOURCE_KINDS, RUNDEAN_MONTHS, TICKS_PER_DAY, TICKS_PER_HOUR, applyClock, buildLabels, buildNightMask, buildResourceLines, buildTiles, changeOwners, clamp, clampPan, clock, clockDate, consoleGovSummary, consoleInfrastructure, countedLoad, dailyBooks, els, fillLoadingQuote, fitToView, frame, invalidateView, linkInternationalCities, loadBitmap, loadBytes, loadCache, loadJSON, loadPixels, markMapReady, openStartMenu, perf, politicalPowerOf, provinceTraits, setActFromConsole, setBuilding, setDoctrineFromConsole, setFactoriesFromConsole, setFormFromConsole, setFortFromConsole, setLawFromConsole, setLevelFromConsole, setLoadingNote, setLoadingProgress, setPaused, setRailFromConsole, setSpeed, setSpiritFromConsole, sfx, showStats, startParallax, state, colonyHolder, updateClockControls, updatePanel, view, wireInput, live, happinessOf, unrestOf, dailyIndustry, commandPowerOf, COMMAND_POWER_CAP, dailySupply, queueConstruction, queueEquipment, queueShip, cancelQueued, queuesOf, dailyRelations, relationsBetween } = all;

// Loads the data, builds the model, and starts the render loop.
async function init() {
  const t0 = performance.now();
  setLoadingNote('Loading data…');

  const [raw, polityRaw, pngBytes, cacheBytes, satellite, rivers, night, cities, cityIcon, capitalIcon,
    markIcons, plantIcon,
    resourceSheet, stats, startInfra, startAttitude, startSupport, polityValues,
    startGovernment, lawTable, policyTable, decreeTable, ideologyTable, spiritTable, modifierTable,
    actionTable, relationTable, leaderTable,
    startOccupation, pastWars, treaties,
    resources, constructionTable, equipmentTable, shipTable, quotes,
    seaRaw, seaPngBytes, countyRaw, countyValues, countyPngBytes, subPngBytes] = await Promise.all(countedLoad(0, 70, [
      loadJSON('./data/json/geography/provinces.json'),
      loadJSON('./data/json/geography/polities.json'),
      loadBytes('./data/img/bitmap/provinces.png'),
      loadBytes(`./data/${CACHE_FILE}`, true),
      loadBitmap('./data/img/bitmap/satellite.png'),
      loadBitmap('./data/img/bitmap/rivers.png'),
      loadBitmap('./data/img/bitmap/night_1920s.png'),
      loadJSON('./data/json/geography/cities.json', true),
      loadBitmap('./data/icons/city.png'),
      loadBitmap('./data/icons/capital.png'),
      Promise.all(MARK_KINDS.map((k) => loadBitmap('./data/icons/' + MARKS[k].icon))),
      loadBitmap('./data/icons/Synthetic-plant.png'),
      loadBitmap('./data/icons/resources.png'),
      loadJSON('./data/json/province/province-stats.json', true),
      loadJSON('./data/json/province/provinces-starting-infrastructure.json', true),
      loadJSON('./data/json/province/provinces-starting-attitude.json', true),
      loadJSON('./data/json/province/provinces-starting-support.json', true),
      loadJSON('./data/json/government/polities-starting-values.json', true),
      loadJSON('./data/json/government/polities-starting-government.json', true),
      loadJSON('./data/json/government/laws.json', true),
      loadJSON('./data/json/government/policies.json', true),
      loadJSON('./data/json/government/decrees.json', true),
      loadJSON('./data/json/government/ideologies.json', true),
      loadJSON('./data/json/government/national-spirits.json', true),
      loadJSON('./data/json/government/modifiers.json', true),
      loadJSON('./data/json/government/diplomatic-actions.json', true),
      loadJSON('./data/json/government/polities-relations-fixed.json', true),
      loadJSON('./data/json/government/polities-leaders.json', true),
      loadJSON('./data/json/government/polities-starting-occupation.json', true),
      loadJSON('./data/json/government/polities-past-wars.json', true),
      loadJSON('./data/json/government/polities-treaties.json', true),
      loadJSON('./data/json/province/resources.json', true),
      loadJSON('./data/json/production/construction.json', true),
      loadJSON('./data/json/production/equipment.json', true),
      loadJSON('./data/json/production/ships.json', true),
      loadJSON('./data/json/quotes.json', true),
      loadJSON('./data/json/geography/sea.json', true),
      loadBytes('./data/img/bitmap/sea.png', true),
      loadJSON('./data/json/geography/counties.json', true),
      loadJSON('./data/json/province/counties-starting-values.json', true),
      loadBytes('./data/img/bitmap/counties.png', true),
      loadBytes('./data/img/bitmap/sea_subregions.png', true),
    ]));

  raw.polities = polityRaw.polities;
  if (countyRaw?.counties && countyValues?.counties) {
    for (const c of countyRaw.counties) Object.assign(c, countyValues.counties[c.id] || {});
  }
  applyCountyOccupation(raw, countyRaw, countyValues?.occupation);

  const hash = hashInputs(pngBytes, raw, seaPngBytes, seaRaw, countyPngBytes, countyRaw, subPngBytes);
  const cache = await loadCache(cacheBytes, hash);
  const table = normaliseTable(raw);

  let world, geometry;
  const restored = cache && worldFromCache(table, cache, indexProvinces);
  setLoadingNote(restored ? 'Restoring the map…' : 'Building the map…');
  setLoadingProgress(70);
  if (restored) {
    ({ world, geometry } = restored);
  } else {
    world = buildWorld(table, await loadPixels(pngBytes));
    world.borderDist = buildBorderDistance(world);
    geometry = computeLabelGeometry(world);
  }

  if (geometry) attachBlockMembers(geometry);
  world.geometry = geometry;

  if (geometry) addRealmBlocks(world, geometry);

  world.sea = null;
  if (seaRaw && seaRaw.regions && seaRaw.regions.length) {
    const seaTable = normaliseSeaTable(seaRaw);
    world.sea = (cache && cache.seaAt)
      ? seaFromCache(seaTable, cache.meta.sea, cache.seaAt, indexSea, world.width, world.height)
      : null;
    if (!world.sea && seaPngBytes) {
      const seaPixels = await loadPixels(seaPngBytes);
      if (seaPixels.width === world.width && seaPixels.height === world.height) {
        world.sea = buildSeaWorld(seaTable, seaPixels);
      } else {
        console.warn(`sea.png is ${seaPixels.width}x${seaPixels.height}, not `
          + `${world.width}x${world.height}; the Navy mode is off.`);
      }
    }
  }
  world.subs = null;
  if (seaRaw && seaRaw.subregions && seaRaw.subregions.length) {
    const subTable = normaliseSubTable(seaRaw);
    world.subs = (cache && cache.subAt)
      ? subsFromCache(subTable, cache.meta.subs, cache.subAt, indexSubs, world.width, world.height)
      : null;
    if (!world.subs && subPngBytes) {
      const subPixels = await loadPixels(subPngBytes);
      if (subPixels.width === world.width && subPixels.height === world.height) {
        world.subs = buildSubWorld(subTable, subPixels);
      } else {
        console.warn(`sea_subregions.png is ${subPixels.width}x${subPixels.height}, not `
          + `${world.width}x${world.height}; the Navy layer shows whole regions.`);
      }
    }
  }

  world.counties = null;
  if (countyRaw && countyRaw.counties && countyRaw.counties.length) {
    const countyTable = normaliseCountyTable(countyRaw);
    world.counties = (cache && cache.countyAt)
      ? countiesFromCache(countyTable, cache.meta.counties, cache.countyAt, indexCounties, world.width, world.height)
      : null;
    if (!world.counties && countyPngBytes) {
      const countyPixels = await loadPixels(countyPngBytes);
      if (countyPixels.width === world.width && countyPixels.height === world.height) {
        world.counties = buildCountyWorld(countyTable, countyPixels);
      } else {
        console.warn(`counties.png is ${countyPixels.width}x${countyPixels.height}, not `
          + `${world.width}x${world.height}; the County mode is off.`);
      }
    }
  }

  for (const el of document.querySelectorAll('button[data-mode="navy"], button[data-toggle="showSeaNames"]')) {
    el.hidden = !world.sea;
  }
  document.querySelector('button[data-mode="county"]').hidden = !world.counties;
  document.querySelector('button[data-mode="ideology"]').hidden =
    !Object.keys(startSupport?.provinces || {}).length;

  world.satellite = satellite;
  world.rivers = rivers;
  world.night = night;
  world.nightMask = buildNightMask(world, live.sunDayOfYear);
  world.cities = cities?.cities ?? [];
  linkInternationalCities(world.cities);
  world.cityIcons = { city: cityIcon, capital: capitalIcon };
  world.buildingIcons = {
    ...Object.fromEntries(MARK_KINDS.map((k, i) => [k, markIcons[i]])), plain: plantIcon,
  };
  world.stats = stats ? mergeStats(stats, startInfra, startAttitude, startSupport) : null;
  // A province's battle count is the mean over its counties.
  if (world.stats && countyRaw?.counties?.length) {
    const seen = new Map();
    for (const c of countyRaw.counties) {
      const t = seen.get(c.province) || [0, 0];
      t[0] += c.struck || 0;
      t[1] += 1;
      seen.set(c.province, t);
    }
    for (const e of Object.values(world.stats)) e.struckAverage = 0;
    for (const [id, [total, n]] of seen) if (world.stats[id]) world.stats[id].struckAverage = total / n;
  }
  world.polityValues = polityValues?.polities ?? null;
  world.government = startGovernment
    ? { byPolity: new Map((startGovernment.polities || []).map((g) => [g.id, g])),
        defaults: startGovernment.defaults || null,
        laws: lawTable, policies: policyTable, decrees: decreeTable, modifiers: modifierTable,
        actions: actionTable, relations: relationTable, leaders: leaderTable,
        ideologies: ideologyTable, spirits: spiritTable,
        occupation: startOccupation?.occupations || null, pastWars: pastWars?.wars || [], treaties: treaties?.treaties || [] }
    : null;
  world.ideologyColour = new Map([
    ...(ideologyTable?.ideologies || []).map((i) => [i.name, toRgb(i.colour)]),
    ...(ideologyTable?.unalignedColour ? [[UNALIGNED, toRgb(ideologyTable.unalignedColour)]] : []),
  ]);

  world.wearinessMeans = new Map();   // per polity, filled on first use
  world.resources = resources?.provinces ?? null;
  world.production = { construction: constructionTable, equipment: equipmentTable, ships: shipTable };
  provinceTraits(world);
  world.resourceKinds = resources?.kinds ?? [];
  const unnamed = world.resourceKinds.filter((k) => !RESOURCE_KINDS[k]);
  if (unnamed.length) console.warn(`resources.json has kinds main.js has no row for: ${unnamed.join(', ')}`);
  world.resourceSheet = resourceSheet;
  world.resourceLines = buildResourceLines(world);
  world.quotes = quotes?.quotes ?? [];

  fillLoadingQuote(world.quotes);

  world.labels = buildLabels(world, geometry);
  state.world = world;
  state.satellite = !!satellite;
  perf.load = { ms: performance.now() - t0, cached: !!restored };

  if (satellite && (satellite.width !== world.width || satellite.height !== world.height)) {
    console.warn(
      `satellite.png is ${satellite.width}x${satellite.height} but provinces.png is ` +
      `${world.width}x${world.height}. They must match; the imagery will not align.`
    );
  }

  buildTiles(world);
  showStats(world);
  wireInput();
  fitToView();
  updatePanel();

  applyClock();
  updateClockControls();

  // Fills the national caches under the loading screen, books first: debt is weighed against them.
  // Industry, resources and happiness feed each other; settle them before the first day.
  for (let i = 0; i < 4; i++) { live.lastIndustry = dailyIndustry(world); live.lastSupply = dailySupply(world); }
  live.lastBooks = dailyBooks(world, clock.day);
  world.resourceLines = buildResourceLines(world);
  live.lastRelations = dailyRelations(world);
  for (const id of Object.keys(world.polityValues || {})) politicalPowerOf(world, id);

  setLoadingNote('Drawing the map…');
  setLoadingProgress(92);
  frame();
  setLoadingProgress(100);
  markMapReady();

  // Console API, e.g. game.setOwner('norrhus', 'FNA').
  const game = {
    setOwner: (province, owner) => changeOwners([[province, owner]]),
    setOwners: changeOwners,
    world: () => state.world,

    // Buildings by county id; buildings() takes a county or a province.
    build: (county, kind) => setBuilding(county, kind, true),
    demolish: (county, kind) => setBuilding(county, kind, false),
    buildings: (where) => {
      const w = state.world;
      const c = w?.counties?.byId?.get(where);
      if (c) {
        const out = {};
        for (const k of BUILDINGS) out[k] = c[k] ? { at: c[BUILDING_AT[k]] } : false;
        return out;
      }
      if (!w?.byId?.has(where)) throw new Error(`no county or province "${where}"`);
      const out = {};
      for (const q of w.counties?.atIndex || []) {
        if (!q || q.province !== where) continue;
        for (const k of BUILDINGS) if (q[k]) (out[q.id] = out[q.id] || {})[k] = { at: q[BUILDING_AT[k]] };
      }
      return out;
    },

    // Camera and clock from the console, e.g. game.lookAt(3211, 2018, 4).
    clock: () => ({
      tick: clock.tick, speed: clock.speed, paused: clock.paused, ...clockDate(clock.tick),
      month: RUNDEAN_MONTHS[clockDate(clock.tick).month],
    }),
    // A jump: no daily handlers run for the days skipped.
    setTick: (tick) => {
      clock.tick = Math.max(0, Math.round(tick));
      clock.day = Math.floor(clock.tick / TICKS_PER_DAY);
      clock.tickDone = clock.tick;
      applyClock();
      return game.clock();
    },
    // Month is 1 to 12 here.
    setDate: (year, month, day, hour = 0) => {
      const days = Math.round((Date.UTC(year, month - 1, day) - CLOCK_EPOCH) / DAY_MS);
      clock.tick = Math.max(0, days * TICKS_PER_DAY + Math.round(hour * TICKS_PER_HOUR));
      clock.day = Math.floor(clock.tick / TICKS_PER_DAY);
      clock.tickDone = clock.tick;
      applyClock();
      return game.clock();
    },
    pause: () => { setPaused(true); return game.clock(); },
    resume: () => { setPaused(false); return game.clock(); },
    speed: (n) => { setSpeed(n); return clock.speed; },

    // Gets or sets the click sound delay, in milliseconds.
    clickDelay: (ms) => {
      if (typeof ms === 'number') live.sfxDelay = clamp(ms, 0, 500) / 1000;
      return Math.round(live.sfxDelay * 1000);
    },
    // Sound measurements taken at load, in milliseconds.
    clickSound: () => ({
      trimmed: Math.round(sfx.offset * 1000),
      attack: Math.round(sfx.attack * 1000),
      held: Math.round(live.sfxDelay * 1000),
      answer: Number(sfx.lag.toFixed(1)),
      device: Math.round((sfx.base + sfx.output) * 1000),
      peak: Number(sfx.peak.toFixed(3)),
      loaded: Boolean(sfx.buffer),
    }),

    view: () => ({ ...view }),
    lookAt: (mapX, mapY, scale = view.scale) => {
      view.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
      view.x = els.canvas.clientWidth / 2 - mapX * view.scale;
      view.y = els.canvas.clientHeight / 2 - mapY * view.scale;
      clampPan();
      invalidateView();
      return { ...view };
    },

    // Sets a country's government free of cost; each returns the result.
    government: (tag) => consoleGovSummary(tag),
    // A province's happiness and unrest, as the daily step reads them.
    unrest: (id) => {
      const w = state.world;
      const p = w?.byId?.get(id);
      if (!p) throw new Error(`no province "${id}"`);
      const st = w.stats?.[id] || {};
      const today = new Date(CLOCK_EPOCH + Math.floor(clock.tick / TICKS_PER_DAY) * DAY_MS);
      const happy = happinessOf(w, p, st, today);
      const u = unrestOf(w, p, st, happy.value);
      const r = (n) => Number(n.toFixed(2));
      return { unrest: r(u.value), perDay: r(u.rate), happiness: r(happy.value),
        unrestParts: Object.fromEntries(u.parts.map(([k, n]) => [k, r(n)])),
        happinessParts: Object.fromEntries(happy.parts.map(([k, n]) => [k, r(n)])) };
    },
    // A country's construction, equipment, ship and research points and consumer goods, as the daily step reads them.
    industry: (tag) => {
      const w = state.world;
      if (!w?.table?.polityById?.has(tag)) throw new Error(`no polity "${tag}"`);
      const b = (live.lastIndustry.size ? live.lastIndustry : dailyIndustry(w)).get(tag) || {};
      const r = (n) => Number((n || 0).toFixed(2));
      return {
        constructionPoints: r(b.points), equipmentPoints: r(b.equipment), shipPoints: r(b.ships),
        researchPoints: r(b.research), researchSlots: b.slots ?? 1, electrifiedPopulation: Math.round(b.electrified || 0), meanElectricity: r(b.meanElectricity),
        orderedFactories: r(b.ordered), consumerFactories: r(b.consumer), militaryFactories: r(b.military), dockyards: r(b.dockyards),
        consumerGoods: { produced: r(b.goods), demanded: r(b.demand), balance: r(b.balance) },
        materialsDrawn: Object.fromEntries(Object.entries(b.materials || {}).map(([k, n]) => [k, r(n)])),
      };
    },
    // Every resource a country yields, owes and holds, and what its shortages cost.
    supply: (tag) => {
      const w = state.world;
      if (!w?.table?.polityById?.has(tag)) throw new Error(`no polity "${tag}"`);
      const s = live.lastSupply.get(tag);
      if (!s) return null;
      const r = (n) => Number((n || 0).toFixed(2));
      const kinds = [...new Set([...Object.keys(s.yields), ...Object.keys(s.demand), ...Object.keys(s.reserves)])].sort();
      return {
        resources: Object.fromEntries(kinds.map((k) => [k, {
          yield: r(s.yields[k]), demand: r(s.demand[k]), supply: r(s.supply[k]), reserve: r(s.reserves[k]),
          short: Math.round(100 * (s.shortfall[k] || 0)) + '%', kept: r(s.kept[k] ?? 1),
        }])),
        power: { demand: r(s.power.demand), supplied: r(s.power.supplied), cover: r(s.power.cover) },
        food: { calories: Math.round(100 * s.met.calories) + '%', crops: Math.round(100 * (s.met.fertileLand ?? 1)) + '%', meat: Math.round(100 * (s.met.livestock ?? 1)) + '%', fish: Math.round(100 * (s.met.fish ?? 1)) + '%' },
        happiness: Object.fromEntries(Object.entries(s.happiness).filter(([, n]) => Math.abs(n) >= 0.005).map(([k, n]) => [k, r(n)])),
        storage: r(s.storage),
      };
    },
    // Sets how much of a resource is put by (positive) or released (negative) each day.
    reserve: (tag, resource, rate) => {
      const v = state.world?.polityValues?.[tag];
      if (!v) throw new Error(`no polity "${tag}"`);
      if (resource === 'power') throw new Error('power cannot be held in reserve');
      if (typeof rate !== 'number' || !Number.isFinite(rate)) throw new Error('rate is a number a day');
      v.reserveRates = { ...(v.reserveRates || {}), [resource]: rate };
      if (!rate) delete v.reserveRates[resource];
      return { resource, rate, held: Number((v.reserves?.[resource] || 0).toFixed(2)) };
    },
    build: (tag, project, where, to) => queueConstruction(state.world, tag, project, where, to),
    produce: (tag, item, count = 1, generation = 1) => queueEquipment(state.world, tag, item, count, generation),
    layDown: (tag, hull, county, generation = 1) => queueShip(state.world, tag, hull, county, generation),
    queue: (tag) => queuesOf(state.world, tag),
    cancel: (tag, queue, index) => cancelQueued(state.world, tag, queue, index),
    stockpile: (tag) => ({ ...(state.world?.polityValues?.[tag]?.stockpile || {}) }),
    // Everything a country holds: resources in reserve, equipment in the stockpile, ships in service.
    inventory: (tag) => {
      const w = state.world;
      const v = w?.polityValues?.[tag];
      if (!v) throw new Error(`no polity "${tag}"`);
      const r = (n) => Number((n || 0).toFixed(2));
      const roman = ['', 'I', 'II', 'III', 'IV'];
      const items = w.production?.equipment?.items || [];
      const hulls = w.production?.ships?.hulls || [];
      const equipment = {};
      for (const [key, n] of Object.entries(v.stockpile || {})) {
        const [id, g] = key.split(':');
        if (n) equipment[(items.find((x) => x.id === id)?.name || id) + ' ' + roman[g]] = n;
      }
      const ships = {};
      for (const s of v.fleet || []) {
        const name = (hulls.find((h) => h.id === s.hull)?.name || s.hull) + ' ' + roman[s.generation];
        ships[name] = (ships[name] || 0) + 1;
      }
      const reserves = {};
      for (const kind of new Set([...Object.keys(v.reserves || {}), ...Object.keys(v.reserveRates || {})])) {
        reserves[kind] = { held: r(v.reserves?.[kind]), rate: v.reserveRates?.[kind] || 0 };
      }
      const made = live.lastProduction.get(tag) || {};
      return { reserves, equipment, ships, storagePerDay: r((made.stockpileStorage || 0) + (live.lastSupply.get(tag)?.storage || 0)) };
    },
    fleet: (tag) => [...(state.world?.polityValues?.[tag]?.fleet || [])],
    // Relations between two polities and what they are made of.
    relations: (a, b) => {
      const w = state.world;
      for (const t of [a, b]) if (!w?.table?.polityById?.has(t)) throw new Error(`no polity "${t}"`);
      const x = relationsBetween(a, b);
      if (!x) return null;
      const r = (n) => Number(n.toFixed(1));
      return { relations: r(x.value), base: r(x.base), distance: r(x.distance), history: Object.fromEntries(x.parts.map(([k, n]) => [k, r(n)])), tension: r(-x.tension) };
    },
    // Every relation a polity holds, best first.
    relationsOf: (tag) => {
      const w = state.world;
      if (!w?.table?.polityById?.has(tag)) throw new Error(`no polity "${tag}"`);
      const rows = [];
      for (const [k, x] of live.lastRelations) {
        const [a, b] = k.split('|');
        if (a === tag || b === tag) rows.push([a === tag ? b : a, Number(x.value.toFixed(1))]);
      }
      rows.sort((p, q) => q[1] - p[1]);
      return Object.fromEntries(rows);
    },
    // World tension and who raised it.
    tension: () => {
      const t = live.lastRelations.tension;
      return t ? { tension: Number(t.value.toFixed(1)), raisedBy: Object.fromEntries([...t.caused].map(([k, n]) => [k, Number(n.toFixed(1))])) } : null;
    },
    // Treaties in force and what is still owed under them.
    treaties: () => (state.world?.government?.treaties || []).map((t) => ({
      name: t.name, signed: t.signed,
      parties: (t.parties || []).map((p) => ({ on: p.on, by: p.by, reparations: p.terms?.reparations || null })),
    })),
    treasury: (tag) => {
      const w = state.world;
      if (!w?.table?.polityById?.has(tag)) throw new Error(`no polity "${tag}"`);
      const b = (live.lastBooks.size ? live.lastBooks : dailyBooks(w, clock.day)).get(tag) || {};
      const r = (n) => Math.round(n || 0);
      return {
        stored: r(w.polityValues?.[tag]?.treasury),
        perDay: r(b.net),
        revenue: { tax: r(b.tax), fromRealmMembers: r(b.realmIn), fromColonies: r(b.colonialIn), reparations: r(b.reparationsIn), rent: r(b.rentIn), stateAgreements: r(b.agreementsIn), total: r(b.revenue) },
        expenditure: { toRealm: r(b.realmOut), toHolder: r(b.colonialOut), rail: r(b.rail), maintenance: r(b.maintenance), occupation: r(b.occupation), policies: r(b.policies), interest: r(b.interest), construction: r(b.construction), production: r(b.production), fleet: r(b.fleet), storage: r(b.storage), stateIndustry: r(b.stateIndustry), reparations: r(b.reparations), rent: r(b.rent), stateAgreements: r(b.agreements), total: r(b.expenditure) },
        colonyOf: colonyHolder(w, tag),
      };
    },
    politicalPower: (tag) => {
      const w = state.world;
      if (!w?.table?.polityById?.has(tag)) throw new Error(`no polity "${tag}"`);
      const pp = politicalPowerOf(w, tag);
      return {
        stored: Number((w.polityValues?.[tag]?.politicalPower || 0).toFixed(2)),
        perDay: Number(pp.daily.toFixed(3)),
        base: POLITICAL_POWER_BASE,
        flat: Object.fromEntries(pp.flat),
        stability: Number(pp.stability.toFixed(1)),
        stabilityFactor: Number(pp.stabilityFactor.toFixed(3)),
        ideology: pp.ideology,
        support: Number(pp.support.toFixed(1)),
        supportFactor: Number(pp.supportFactor.toFixed(3)),
        percent: Object.fromEntries(pp.percent),
        actions: Object.fromEntries(pp.actions.map(([k, n]) => [k, Number(n.toFixed(3))])),
      };
    },
    commandPower: (tag) => {
      const w = state.world;
      if (!w?.table?.polityById?.has(tag)) throw new Error(`no polity "${tag}"`);
      const cp = commandPowerOf(w, tag);
      return {
        stored: Number((w.polityValues?.[tag]?.commandPower || 0).toFixed(2)),
        cap: COMMAND_POWER_CAP,
        perDay: Number(cp.daily.toFixed(3)),
        units: cp.units,
        base: Number(cp.base.toFixed(3)),
        percent: Object.fromEntries(cp.percent),
      };
    },
    setLaw: setLawFromConsole,
    setForm: setFormFromConsole,
    setDoctrine: setDoctrineFromConsole,
    addPolicy: (tag, name, target) => setActFromConsole(tag, 'policy', name, target, true),
    removePolicy: (tag, name, target) => setActFromConsole(tag, 'policy', name, target, false),
    addDecree: (tag, name, target) => setActFromConsole(tag, 'decree', name, target, true),
    removeDecree: (tag, name, target) => setActFromConsole(tag, 'decree', name, target, false),
    addSpirit: (tag, id) => setSpiritFromConsole(tag, id, true),
    removeSpirit: (tag, id) => setSpiritFromConsole(tag, id, false),

    // Infrastructure: levels and factories per province, forts and rail per county.
    infrastructure: consoleInfrastructure,
    setLevel: setLevelFromConsole,
    setFactories: setFactoriesFromConsole,
    setFort: setFortFromConsole,
    addRail: (a, b) => setRailFromConsole(a, b, true),
    removeRail: (a, b) => setRailFromConsole(a, b, false),
  };

  window.game = game;
}

openStartMenu();

startParallax();

init().catch((err) => {
  document.body.innerHTML =
    `<div style="padding:24px;font:14px var(--ui-plain);color:#d8dce4">
       <strong>Failed to start.</strong><br><br>${err.message}<br><br>
       <span style="color:#8a91a0">If this says the file could not be loaded, you are probably
       opening index.html directly. Browsers block local file reads. Serve the folder over
       HTTP instead &mdash; see README.md.</span>
     </div>`;
  console.error(err);
});
