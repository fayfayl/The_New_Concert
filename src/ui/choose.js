// Country selection: the box over the map at the start of a new game.

const VERSION = new URL(import.meta.url).search;
const { CLOCK_EPOCH, DAY_MS, TICKS_PER_DAY, clock, els, governmentChanged, live, state } = await import(`../core/core.js${VERSION}`);
const { realmOf } = await import(`../world/mapdata.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let SPIRIT_ART, buildLandSilhouette, flagSlug, flagSrc, governmentPosition, happinessOf, happinessTip, leaderTip, manpowerOf, manpowerTip, maskFlagShading, menText, meterTip, paintHud, quitToStartMenu, randomGrain, select, setLoadingNote, setLoadingProgress, setLoadingScreen, shortNameOf, spiritById, spiritTip, stabilityOf, stabilityTip;
export function link(all) { ({ SPIRIT_ART, buildLandSilhouette, flagSlug, flagSrc, governmentPosition, happinessOf, happinessTip, leaderTip, manpowerOf, manpowerTip, maskFlagShading, menText, meterTip, paintHud, quitToStartMenu, randomGrain, select, setLoadingNote, setLoadingProgress, setLoadingScreen, shortNameOf, spiritById, spiritTip, stabilityOf, stabilityTip } = all); }

const PORTRAIT_DIR = './data/img/portraits/';
const PORTRAIT_PLACEHOLDER = PORTRAIT_DIR + 'placeholder.png';

// How long the gauge runs after Play.
const ENTER_GAUGE_MS = 650;

// Share of the people a separate piece of land needs to be fitted.
const FIT_SHARE = 0.1;
// Room left round a country fitted to the screen, the closest it fits, and the bar's height.
const FIT_TOP = 92;
const FIT_MARGIN = 1.04;
const FIT_MAX_SCALE = 8;

// Difficulty effects on the rules tab: label, and whether the figure is a share.
const RULE_EFFECTS = {
  stability: ['Stability', false],
  politicalPowerPerDay: ['Political power per day', false],
  factoryOutput: ['Factory output', true],
  construction: ['Construction', true],
  manpower: ['Manpower', true],
  research: ['Research', true],
};

const LAND_CACHE_SIZE = 6;
const landCache = new Map();

let built = false;
let entering = false;
let preloaded = null;                     // keeps the decoded art alive

const byId = (id) => document.getElementById(id);
const polityFor = (tag) => state.world?.table?.polityById?.get(tag) || null;
const selection = () => state.world?.selection || [];

// The leader of a country, or null.
function leaderFor(w, tag) {
  const held = w.government?.byPolity?.get(tag)?.leader;
  return held ? (w.government?.leaders?.leaders || []).find((l) => l.id === held) || null : null;
}

function setPortrait(img, leader) {
  img.onerror = () => { img.onerror = null; img.src = PORTRAIT_PLACEHOLDER; };
  img.src = leader?.portrait ? PORTRAIT_DIR + leader.portrait + '.png' : PORTRAIT_PLACEHOLDER;
}

// Points a flag image at a country, with its wrinkle overlay.
function setFlag(img, polity) {
  const slug = flagSlug(polity);
  img.onerror = () => window.flagMiss(img, slug);
  maskFlagShading(img);
  img.src = flagSrc(slug);
}

function flagImage(polity) {
  const box = document.createElement('span');
  box.className = 'diplo-flag';
  const img = document.createElement('img');
  img.alt = '';
  box.append(img);
  setFlag(img, polity);
  return box;
}

// Builds the portrait tiles and the rows of flags.
function buildList() {
  if (built) return;
  const w = state.world;
  const majors = byId('choose-majors'), minors = byId('choose-minors');
  if (!w || !majors || !minors) return;
  built = true;
  for (const { tag, major } of selection()) {
    const polity = polityFor(tag);
    if (!polity) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tag = tag;
    b.dataset.sfx = 'paper';
    b.dataset.tip = shortNameOf(polity);
    if (major) {
      b.className = 'choose-major';
      randomGrain(b);
      const photo = document.createElement('span');
      photo.className = 'diplo-photo';
      const face = document.createElement('img');
      face.alt = '';
      const leader = leaderFor(w, tag);
      setPortrait(face, leader);
      if (leader) meterTip(photo, leaderTip(w, leader));
      photo.append(face);
      const flag = flagImage(polity);
      const name = document.createElement('span');
      name.className = 'choose-tile-name';
      name.textContent = shortNameOf(polity);
      const side = document.createElement('span');
      side.className = 'choose-tile-side';
      side.append(flag, name);
      b.append(photo, side);
      majors.append(b);
    } else {
      b.className = 'choose-minor';
      b.append(flagImage(polity));
      minors.append(b);
    }
    b.addEventListener('click', () => pickFromList(tag));
  }
}

// Builds the list and decodes its art under the loading screen.
async function prepareChoose() {
  buildList();
  const w = state.world;
  const held = [...document.querySelectorAll('#choose-majors img, #choose-minors img')];
  const fetchArt = (src) => { const img = new Image(); img.src = src; held.push(img); };
  fetchArt('./data/img/flags/overlay.png');
  fetchArt(PORTRAIT_PLACEHOLDER);
  for (const { tag } of selection()) {
    for (const sid of w?.government?.byPolity?.get(tag)?.spirits || []) {
      const art = spiritById(w, sid)?.image;
      if (art) fetchArt(SPIRIT_ART + art + '.png');
    }
  }
  await Promise.allSettled(held.map((img) => img.decode?.()));
  preloaded = held;
}

// Selects a country's capital, or its largest province, and looks at it.
function pickFromList(tag) {
  const w = state.world;
  const inRealm = (id) => realmOf(w.table, w.byId.get(id)?.owner || '') === tag;
  const town = (w.cities || []).find((t) => t.capital && w.byId.get(t.province)?.owner === tag)
    || (w.cities || []).find((t) => t.capital && inRealm(t.province));
  let id = town?.province;
  if (!id) {
    let most = -1;
    for (const q of w.table.provinces) {
      const n = w.stats?.[q.id]?.population || 0;
      if (q.owner && realmOf(w.table, q.owner) === tag && n > most) { most = n; id = q.id; }
    }
  }
  if (!id) return;
  state.chooseMember = false;
  live.quietSelect = true;
  select(id);
  updateChoice();
  live.quietSelect = false;
  if (town) {
    // Keeps the capital in the map above the box.
    const scale = window.game?.view?.().scale || 1;
    window.game?.lookAt?.(town.x, town.y + byId('choose-box').offsetHeight / 2 / scale);
  }
}

// What a realm holds across all its members.
function realmFigures(w, tag) {
  const today = new Date(CLOCK_EPOCH + Math.floor(clock.tick / TICKS_PER_DAY) * DAY_MS);
  let people = 0, happy = 0, civilian = 0, military = 0, dockyards = 0;
  const members = new Set();
  for (const p of w.table.provinces) {
    if (!p.owner || (p.owner !== tag && realmOf(w.table, p.owner) !== tag)) continue;
    members.add(p.owner);
    const st = w.stats?.[p.id];
    if (!st) continue;
    people += st.population || 0;
    happy += (st.population || 0) * happinessOf(w, p, st, today).value;
  }
  for (const id of members) {
    const b = live.lastIndustry?.get?.(id);
    if (!b) continue;
    civilian += (b.ordered || 0) + (b.consumer || 0);
    military += b.military || 0;
    dockyards += b.dockyards || 0;
  }
  return { people, happiness: people ? happy / people : 0, civilian, military, dockyards };
}

function infoRow(label, value) {
  const row = document.createElement('div');
  row.className = 'choose-row';
  const u = document.createElement('u');
  u.textContent = label;
  const b = document.createElement('b');
  b.textContent = value;
  row.append(u, b);
  return row;
}

// Shows one of the box's tabs, with Back and Play under it.
function showChooseTab(name) {
  const box = byId('choose-box'), rules = byId('choose-rules');
  if (!box || !rules) return;
  const toRules = name === 'rules';
  // The box keeps its height across the tabs.
  if (toRules && rules.hidden) {
    const k = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    box.style.minHeight = box.getBoundingClientRect().height / k + 'px';
  }
  if (!toRules) box.style.minHeight = '';
  for (const id of ['choose-majors', 'choose-minors', 'choose-panes']) byId(id).hidden = toRules;
  rules.hidden = !toRules;
  for (const b of document.querySelectorAll('#choose-tabs [data-choose-tab]')) b.classList.toggle('on', b.dataset.chooseTab === name);
  (toRules ? byId('choose-rules-foot') : byId('choose-middle'))?.append(byId('choose-actions'));
  if (toRules) paintRules();
}

// A button choosing one option of a rule.
function ruleButton(rule, o, chosen, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className + (o.name === chosen ? ' on' : '');
  b.dataset.rule = rule.name;
  b.dataset.option = o.name;
  return b;
}

// Every option of a rule against its effects, the chosen column stamped.
function ruleLedger(rule, chosen) {
  const keys = [...new Set(rule.options.flatMap((o) => Object.keys(o.effects || {})))];
  const table = document.createElement('table');
  table.className = 'rule-ledger';
  const head = table.createTHead().insertRow();
  head.append(document.createElement('th'));
  for (const o of rule.options) {
    const th = document.createElement('th');
    if (o.name === chosen) th.className = 'on';
    const b = ruleButton(rule, o, chosen, 'rule-level');
    b.dataset.sfx = 'paper';
    const ink = document.createElement('span');
    ink.textContent = o.name;
    b.append(ink);
    th.append(b);
    head.append(th);
  }
  const body = table.createTBody();
  for (const k of keys) {
    const row = body.insertRow();
    const [text, share] = RULE_EFFECTS[k] || [k, false];
    const th = document.createElement('th');
    th.textContent = text;
    row.append(th);
    for (const o of rule.options) {
      const v = o.effects?.[k] || 0;
      const cell = row.insertCell();
      cell.className = (v > 0 ? 'up' : v < 0 ? 'down' : '') + (o.name === chosen ? ' on' : '');
      cell.dataset.rule = rule.name;
      cell.dataset.option = o.name;
      cell.dataset.sfx = 'paper';
      cell.textContent = v ? (v > 0 ? '+' : '\u2212') + (share ? Math.round(Math.abs(v) * 100) + '%' : Math.abs(v)) : '\u2014';
    }
  }
  return table;
}

// One rubber stamp per option, the chosen one inked.
function ruleStamps(rule, chosen) {
  const row = document.createElement('div');
  row.className = 'rule-stamps';
  for (const o of rule.options) {
    const b = ruleButton(rule, o, chosen, 'rule-stamp');
    b.dataset.sfx = 'paper';
    b.textContent = o.name;
    row.append(b);
  }
  return row;
}

// Notches along a track, a knob on the chosen one.
function ruleDial(rule, chosen) {
  const dial = document.createElement('div');
  dial.className = 'rule-dial';
  dial.style.setProperty?.('--notches', rule.options.length);
  for (const o of rule.options) {
    const b = ruleButton(rule, o, chosen, 'rule-notch');
    const knob = document.createElement('i');
    const name = document.createElement('span');
    name.textContent = o.name;
    b.append(knob, name);
    dial.append(b);
  }
  return dial;
}

const RULE_SHOWN = { ledger: ruleLedger, stamps: ruleStamps, dial: ruleDial };

// Moves a dial's knob to the notch nearest a point on the screen.
function dialTo(dial, x) {
  const notches = [...dial.children];
  const r = dial.getBoundingClientRect();
  const i = Math.max(0, Math.min(notches.length - 1, Math.floor((x - r.left) / r.width * notches.length)));
  const b = notches[i];
  if (!b || b.classList.contains('on')) return;
  for (const n of notches) n.classList.toggle('on', n === b);
  state.rules?.set(b.dataset.rule, b.dataset.option);
}

// One sheet per rule, drawn as its data says.
function paintRules() {
  const w = state.world, sheets = byId('choose-rule-sheets');
  if (!w || !sheets) return;
  sheets.replaceChildren(...(w.rules || []).map((rule) => {
    const sheet = document.createElement('section');
    sheet.className = 'choose-paper rule-sheet shown-' + (rule.shown || 'stamps');
    const head = document.createElement('h3');
    head.textContent = rule.name;
    sheet.append(head, (RULE_SHOWN[rule.shown] || ruleStamps)(rule, state.rules?.get(rule.name)));
    return sheet;
  }));
}

// Fills the three panes for a country.
function paintCountry(w, tag, polity) {
  const gov = w.government?.byPolity?.get(tag) || null;
  const figures = realmFigures(w, tag);
  const stability = stabilityOf(w, tag);
  const manpower = manpowerOf(w, tag);
  const leader = leaderFor(w, tag);
  let ideology = null;
  try { ideology = gov ? governmentPosition(w, tag).ideology : null; } catch { ideology = null; }

  const leaderRow = infoRow('Leader', leader ? [leader.house ? leader.title : null, leader.name].filter(Boolean).join(' ') : '—');
  const stabilityRow = infoRow('Stability', Math.round(stability) + '%');
  const happinessRow = infoRow('Happiness', Math.round(figures.happiness) + '%');
  const manpowerRow = infoRow('Manpower', menText(manpower.pool));
  meterTip(stabilityRow, stabilityTip(w, tag, stability));
  meterTip(manpowerRow, manpowerTip(w, tag, manpower));
  meterTip(happinessRow, happinessTip(w, tag));
  if (leader) meterTip(leaderRow, leaderTip(w, leader));
  byId('choose-info').replaceChildren(
    leaderRow,
    infoRow('Population', menText(figures.people)),
    infoRow('Industry', `${Math.round(figures.civilian)} civilian, ${Math.round(figures.military)} military, ${Math.round(figures.dockyards)} dockyards`),
    infoRow('Army size', '—'),
    infoRow('Ideology', ideology || '—'),
    infoRow('Government', gov?.form || '—'),
    stabilityRow,
    happinessRow,
    manpowerRow,
  );

  byId('choose-photo').hidden = false;
  setPortrait(byId('choose-portrait'), leader);
  const photo = byId('choose-photo');
  if (leader) meterTip(photo, leaderTip(w, leader));
  else { photo.onmouseenter = null; photo.onmousemove = null; photo.onmouseleave = null; }

  byId('choose-name').textContent = shortNameOf(polity);
  byId('choose-flag-box').hidden = false;
  setFlag(byId('choose-flag'), polity);

  const spirits = byId('choose-spirits');
  spirits.replaceChildren();
  for (const sid of gov?.spirits || []) {
    const tile = document.createElement('i');
    tile.className = 'diplo-tile';
    const art = spiritById(w, sid)?.image;
    if (art) tile.style.backgroundImage = `url("${SPIRIT_ART}${art}.png")`;
    meterTip(tile, spiritTip(w, sid));
    spirits.append(tile);
  }

  byId('choose-brief').textContent = selection().find((r) => r.tag === tag)?.description || '';
}

function clearCountry() {
  byId('choose-info').replaceChildren();
  byId('choose-photo').hidden = true;
  byId('choose-name').textContent = 'No country selected';
  byId('choose-flag-box').hidden = true;
  byId('choose-spirits').replaceChildren();
  byId('choose-brief').textContent = '';
}

// A country's provinces and silhouette, the last few kept for reselecting.
function landOf(w, tag) {
  let land = landCache.get(tag);
  if (land) landCache.delete(tag);
  else {
    const ids = new Set(w.table.provinces.filter((p) => p.owner && (p.owner === tag || realmOf(w.table, p.owner) === tag)).map((p) => p.id));
    land = { ids, silhouette: buildLandSilhouette(w, ids) };
  }
  landCache.set(tag, land);
  if (landCache.size > LAND_CACHE_SIZE) landCache.delete(landCache.keys().next().value);
  return land;
}

// Lights and rings a whole country on the map, or clears it.
function lightCountry(tag) {
  if (state.chosenTag === tag) return;
  const w = state.world;
  state.chosenTag = tag;
  const land = tag ? landOf(w, tag) : null;
  state.chosenLand = land?.ids || null;
  state.silhouette = land?.silhouette || null;
  state.outline = null;
  live.viewDirty = true;
}

// Puts the selected province's country in the box.
function updateChoice() {
  const play = byId('choose-play');
  if (!state.choosing || !play) return;
  const w = state.world;
  const owner = state.selected ? w?.byId?.get(state.selected)?.owner : null;
  const tag = owner ? (state.chooseMember ? owner : realmOf(w.table, owner)) : null;
  const polity = tag ? polityFor(tag) : null;
  play.hidden = !polity;
  play.dataset.tag = polity ? tag : '';
  for (const b of [...(byId('choose-majors')?.children || []), ...(byId('choose-minors')?.children || [])]) {
    b.classList.toggle('on', Boolean(polity) && b.dataset.tag === tag);
  }
  lightCountry(polity ? tag : null);
  if (polity) paintCountry(w, tag, polity);
  else clearCountry();
}

// Shows or hides country selection.
function setChoosing(open) {
  state.choosing = open;
  state.chooseMember = false;
  document.body?.classList?.toggle('choosing', open);
  const el = byId('choose');
  el?.classList.toggle('open', open);
  el?.setAttribute('aria-hidden', String(!open));
  paintHud();
  if (open) {
    buildList();
    showChooseTab('country');
  }
  else {
    els.tooltip.hidden = true;
    lightCountry(null);
  }
  updateChoice();
}

// Fits a country's main body of land to the screen, at once.
function fitCountry(tag) {
  const w = state.world;
  const inRealm = (q) => q.owner && realmOf(w.table, q.owner) === tag;
  let own = w.table.provinces.filter((q) => q.owner === tag);
  if (!own.length) own = w.table.provinces.filter(inRealm);
  if (!own.length) return;
  const ids = new Set(own.map((q) => q.id));
  const town = (w.cities || []).find((t) => t.capital && ids.has(t.province));
  const start = town?.province || own.reduce((a, b) => ((w.stats?.[b.id]?.population || 0) > (w.stats?.[a.id]?.population || 0) ? b : a)).id;

  // The capital's land, and any other piece holding a tenth of the people.
  const people = (id) => w.stats?.[id]?.population || 0;
  const total = own.reduce((s, q) => s + people(q.id), 0);
  const seen = new Set(), reached = new Set();
  for (const first of [start, ...ids]) {
    if (seen.has(first)) continue;
    const piece = new Set([first]);
    seen.add(first);
    for (const id of piece) {
      for (const q of w.adjacency.get(id) || []) if (ids.has(q) && !seen.has(q)) { seen.add(q); piece.add(q); }
    }
    if (first === start || [...piece].reduce((s, id) => s + people(id), 0) >= total * FIT_SHARE) for (const id of piece) reached.add(id);
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of reached) {
    const bb = w.bounds.get(id);
    if (!bb) continue;
    minX = Math.min(minX, bb.minX);
    minY = Math.min(minY, bb.minY);
    maxX = Math.max(maxX, bb.maxX);
    maxY = Math.max(maxY, bb.maxY);
  }
  if (minX > maxX) return;
  const barK = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  const barH = FIT_TOP * barK;
  const scale = Math.min(
    FIT_MAX_SCALE,
    els.canvas.clientWidth / ((maxX - minX + 1) * FIT_MARGIN),
    (els.canvas.clientHeight - barH) / ((maxY - minY + 1) * FIT_MARGIN),
  );
  window.game?.lookAt?.((minX + maxX + 1) / 2, (minY + maxY + 1) / 2 - barH / 2 / scale, scale);
}

// Plays the chosen country, through a brief loading screen.
async function playChoice() {
  const tag = byId('choose-play')?.dataset.tag;
  if (!tag || entering) return;
  entering = true;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const holdKeys = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); };
  window.addEventListener('keydown', holdKeys, true);
  setLoadingNote('Preparing country\u2026');
  setLoadingScreen(true);
  byId('choose')?.classList.remove('open');
  const t0 = performance.now();
  for (let k = 0; k < 1;) {
    k = Math.min(1, (performance.now() - t0) / ENTER_GAUGE_MS);
    setLoadingProgress(100 * k);
    await wait(30);
  }
  playCountry(tag);
  fitCountry(tag);
  setLoadingScreen(false);
  window.removeEventListener('keydown', holdKeys, true);
  entering = false;
}

// Leaves country selection playing a country.
function playCountry(tag) {
  state.playing = tag;
  governmentChanged();
  select(null);
  setChoosing(false);
  els.canvas.focus?.();
}

function wireChoose() {
  byId('choose-play')?.addEventListener('click', playChoice);
  byId('choose-back')?.addEventListener('click', () => quitToStartMenu());
  byId('choose-tabs')?.addEventListener('click', (ev) => {
    const b = ev.target?.closest?.('[data-choose-tab]');
    if (b) showChooseTab(b.dataset.chooseTab);
  });
  byId('choose-rule-sheets')?.addEventListener('click', (ev) => {
    const b = ev.target?.closest?.('[data-rule]');
    if (!b || !state.rules) return;
    state.rules.set(b.dataset.rule, b.dataset.option);
    paintRules();
  });
  // A dial's knob follows the pointer while held.
  let dragged = null;
  const drop = () => { dragged = null; };
  byId('choose-rule-sheets')?.addEventListener('pointerdown', (ev) => {
    const dial = ev.target?.closest?.('.rule-dial');
    if (!dial) return;
    dragged = dial;
    dialTo(dial, ev.clientX);
    try { dial.setPointerCapture?.(ev.pointerId); } catch { /* no live pointer */ }
  });
  byId('choose-rule-sheets')?.addEventListener('pointermove', (ev) => { if (dragged) dialTo(dragged, ev.clientX); });
  byId('choose-rule-sheets')?.addEventListener('pointerup', drop);
  byId('choose-rule-sheets')?.addEventListener('pointercancel', drop);
}

export { realmFigures, playCountry, prepareChoose, setChoosing, updateChoice, wireChoose };
