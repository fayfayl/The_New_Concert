// The playing country's bar: flag, national values and menu buttons. Also the hover tips on controls.

const VERSION = new URL(import.meta.url).search;
const { CLOCK_EPOCH, DAY_MS, clock, els, live, state, TICKS_PER_DAY } = await import(`../core/core.js${VERSION}`);
const { realmOf } = await import(`../world/mapdata.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let RESOURCE_NAME, flaggedName, resourceIcon, HAPPINESS_BASE, commandPowerOf, debtConstruction, nationalModifier, shortagesOf, flagSlug, flagSrc, happinessOf, manpowerOf, manpowerTip, maskFlagShading, menText, meterTip, nationalParts, placeTooltip, politicalPowerOf, realmFigures, stabilityOf, stabilityTip;
export function link(all) { ({ RESOURCE_NAME, flaggedName, resourceIcon, HAPPINESS_BASE, commandPowerOf, debtConstruction, nationalModifier, shortagesOf, flagSlug, flagSrc, happinessOf, manpowerOf, manpowerTip, maskFlagShading, menText, meterTip, nationalParts, placeTooltip, politicalPowerOf, realmFigures, stabilityOf, stabilityTip } = all); }

const PLACEHOLDER_ICON = './data/icons/placeholder.png';
const HUD_REFRESH_MS = 400;

// The screen the interface is designed at; it scales by the tighter side.
const DESIGN_W = 1600, DESIGN_H = 900;

// The flag's height, the same as the two bars, and its widest.
const FLAG_H = 84, FLAG_MAX_W = 200;

// Text follows the interface's scale, held between these so it stays readable.
const TEXT_MIN = 0.9, TEXT_MAX = 2;

const whole = (n) => Math.round(n || 0).toLocaleString('en-GB');
const tenths = (n) => (n || 0).toFixed(1);

// A treasury figure, short.
function money(n) {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n || 0);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${Math.round(a)}`;
}

// Gives a paper box its own crop and turn of the texture tile.
function randomGrain(el) {
  const r = (n) => Math.round(Math.random() * n);
  if (typeof el.style?.setProperty !== 'function') return;
  el.style.setProperty('--tex-turn', r(359) + 'deg');
  el.style.setProperty('--tex-at', `-${r(900)}px -${r(900)}px`);
}

// A line of a breakdown tooltip.
const tipLine = (label, value, cls) => `<div class="cm-line"><span>${label}</span><b${cls ? ` class="${cls}"` : ''}>${value}</b></div>`;
const signed = (n, text) => (n > 0 ? '+' : n < 0 ? '\u2212' : '') + text(Math.abs(n));
const change = (label, n, text) => tipLine(label, signed(n, text), n > 0 ? 'up' : 'down');
const percentOf = (n) => Math.round(n * 100) + '%';
const hundredths = (n) => n.toFixed(2);
const nonZero = (rows) => rows.filter(([, n]) => Math.abs(n) >= 0.005);
const total = (label, value) => `<hr>${tipLine(label, value)}`;
const capital = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
// A breakdown label with a flag at a country's tag and an icon at a resource's name.
function tipLabel(w, label) {
  let s = capital(label).replace(/\b[A-Z]{3}\b/g, (tag) => {
    const polity = w.table.polityById.get(tag);
    return polity ? flaggedName(polity, polity.short || polity.name) : tag;
  });
  if (!/^(state|private|collectivised|decollectivised|surveys for) |(industry|shortage)$/i.test(label)) return s;
  const kinds = Object.keys(RESOURCE_NAME).sort((a, b) => RESOURCE_NAME[b].length - RESOURCE_NAME[a].length);
  for (const kind of kinds) {
    const hit = new RegExp(`(^|[\\s(])(${RESOURCE_NAME[kind]})(?=[\\s,.)]|$)`, 'i').exec(s);
    if (hit) return s.slice(0, hit.index) + hit[1] + resourceIcon(kind) + hit[2] + s.slice(hit.index + hit[0].length);
  }
  return s;
}
// A national modifier's line, spirits in italics as on the stability tooltip.
const partLine = ([label, n, kind], text = percentOf) => change(kind === 'spirit' ? `<i>${label}</i>` : tipLabel(state.world, label), n, text);

function politicalPowerTip(w, tag) {
  const pp = politicalPowerOf(w, tag);
  return '<b>Political power</b>'
    + tipLine('Available', whole(w.polityValues?.[tag]?.politicalPower))
    + '<hr>'
    + tipLine('Base income', hundredths(2))
    + nonZero(pp.flat).map((x) => partLine(x, hundredths)).join('')
    + times('Stability', pp.stabilityFactor)
    + times(`Support for ${(pp.ideology || 'government').toLowerCase()}`, pp.supportFactor)
    + nonZero(pp.percent).map((x) => partLine(x)).join('')
    + nonZero(pp.actions).map(([k, n]) => change(tipLabel(w, k), n, hundredths)).join('')
    + total('Per day', signed(pp.daily, hundredths));
}

function treasuryTip(tag) {
  const t = window.game.treasury(tag);
  const REVENUE = { tax: 'Tax', tariffs: 'Tariffs', fuelSales: 'State fuel sales', bunkeringTax: 'Bunkering tax', fromRealmMembers: 'From realm members', fromColonies: 'From colonies', reparations: 'Reparations', rent: 'Rent', stateAgreements: 'State agreements' };
  const SPENDING = { toRealm: 'To realm', toHolder: 'To holder', rail: 'Railway upkeep', maintenance: 'Maintenance', occupation: 'Occupation', policies: 'Policies', interest: 'Interest', construction: 'Construction', production: 'Production', fleet: 'Fleet', storage: 'Storage', stateIndustry: 'State industry', reparations: 'Reparations', rent: 'Rent', stateAgreements: 'State agreements', shipping: 'Shipping' };
  const rows = (names, side, sign) => Object.entries(names).filter(([k]) => side[k]).map(([k, name]) => change(name, sign * side[k], money)).join('');
  return '<b>Treasury</b>'
    + tipLine('Balance', money(t.stored))
    + '<hr>'
    + rows(REVENUE, t.revenue, 1)
    + rows(SPENDING, t.expenditure, -1)
    + total('Per day', signed(t.perDay, money));
}

function happinessTip(w, tag) {
  const today = new Date(CLOCK_EPOCH + Math.floor(clock.tick / TICKS_PER_DAY) * DAY_MS);
  const sums = new Map();
  let people = 0, all = 0;
  for (const p of w.table.provinces) {
    if (!p.owner || (p.owner !== tag && realmOf(w.table, p.owner) !== tag)) continue;
    const st = w.stats?.[p.id];
    const n = st?.population || 0;
    if (!n) continue;
    const h = happinessOf(w, p, st, today);
    people += n;
    all += n * h.value;
    for (const [k, v] of h.parts) sums.set(k, (sums.get(k) || 0) + v * n);
  }
  const rows = people ? [...sums].map(([k, v]) => [k, v / people]) : [];
  return '<b>Happiness</b>'
    + tipLine('Baseline', HAPPINESS_BASE + '%')
    + nonZero(rows).sort((a, b) => b[1] - a[1]).map(([k, n]) => change(tipLabel(w, k), n, (x) => tenths(x) + '%')).join('')
    + total('Population average', Math.round(people ? all / people : 0) + '%');
}

const times = (label, n) => tipLine(label, `\u00d7${n.toFixed(2)}`, n > 1.0005 ? 'up' : n < 0.9995 ? 'down' : '');
const modifierLines = (w, tag, keys) => keys.flatMap((k) => nationalParts(w, tag, k))
  .filter(([, n]) => n).map(([label, n]) => change(label, n, percentOf)).join('');
const sumOf = (w, tag, keys) => keys.reduce((a, k) => a + nationalModifier(w, tag, k), 0);

// The polities whose points a country's bar counts: itself, and every member if it heads a realm.
function pointMakers(w, tag) {
  const makers = new Set();
  for (const p of w.table.provinces) {
    if (p.owner && (p.owner === tag || realmOf(w.table, p.owner) === tag) && live.lastIndustry?.has?.(p.owner)) makers.add(p.owner);
  }
  return [...makers];
}

// A country's points with its members', as the bar shows them.
function pointsOf(w, tag) {
  const out = { points: 0, equipment: 0, ships: 0, research: 0 };
  for (const id of pointMakers(w, tag)) {
    const b = live.lastIndustry.get(id);
    for (const k of Object.keys(out)) out[k] += b[k] || 0;
  }
  return out;
}

// A realm's points, member by member.
function memberTip(w, tag, title, field) {
  const rows = pointMakers(w, tag).map((id) => [flaggedName(w.table.polityById.get(id), w.table.polityById.get(id)?.short || id), live.lastIndustry.get(id)[field] || 0]).sort((a, b) => b[1] - a[1]);
  return `<b>${title}</b>`
    + rows.map(([name, n]) => tipLine(name, tenths(n))).join('')
    + total('Per day', tenths(rows.reduce((a, [, n]) => a + n, 0)));
}

// A multiplier's line, left out when it changes nothing.
const moved = (label, n) => (Math.abs(n - 1) >= 0.005 ? times(label, n) : '');

// A group of national modifiers: their combined multiplier, then each one under it.
function groupLines(w, tag, label, keys, extra = 0, extraLabel = '') {
  const parts = keys.flatMap((k) => nationalParts(w, tag, k)).filter(([, n]) => n).sort((x, y) => y[1] - x[1]);
  const sum = parts.reduce((s, [, n]) => s + n, 0) + extra;
  if (!parts.length && !extra) return '';
  return times(label, Math.max(0, 1 + sum))
    + parts.map((x) => partLine(x).replace('cm-line', 'cm-line cm-part')).join('')
    + (extra ? change(extraLabel, extra, percentOf).replace('cm-line', 'cm-line cm-part') : '');
}

// The lines every kind of point shares after its count.
function pointLines(w, tag, why, seized, made, groups) {
  const share = (x, y) => (y ? x / y : 1);
  const kept = live.lastSupply?.get?.(tag)?.kept || {};
  const whole = (r) => kept[r] ?? 1;
  const half = (r) => 1 - (1 - whole(r)) / 2;
  return moved('Electricity', share(why.lit, why.count))
    + groups
    + times('Stability', 1 + (stabilityOf(w, tag) - 50) / 200)
    + moved(tipLabel(w, 'Coal shortage'), whole('coal'))
    + moved(tipLabel(w, 'Natural gas shortage'), whole('naturalGas'))
    + moved(tipLabel(w, 'Tungsten shortage'), half('tungsten'))
    + moved(tipLabel(w, 'Fuel shortage'), half('fuel'))
    + moved('Unrest', share(why.calm, why.lit))
    + moved('Occupied by others', share(why.held, why.calm))
    + (seized ? change('From ground it occupies', seized, tenths) : '')
    + total('Per day', tenths(made));
}

function constructionTip(w, tag, b) {
  const why = b?.why;
  if (!why) return `<b>Construction points</b>${total('Per day', tenths(b?.points))}`;
  if (!why.civilian) return `<b>Construction points</b>${tipLine('Civilian factories', tenths(0))}${b.seized?.points ? change('From ground it occupies', b.seized.points, tenths) : ''}${total('Per day', tenths(b.points))}`;
  return '<b>Construction points</b>'
    + tipLine('Civilian factories', tenths(why.civilian))
    + change('Consumer goods production', -(why.civilian - why.points.count), tenths)
    + pointLines(w, tag, why.points, b.seized?.points, b.points,
      groupLines(w, tag, 'Factory output', ['factoryOutput', 'civilianFactoryOutput', 'targetYield.manufacturing'])
      + groupLines(w, tag, 'Construction speed', ['construction'], debtConstruction(w, tag), 'Debt'));
}

function equipmentTip(w, tag, b) {
  const why = b?.why;
  if (!why) return `<b>Equipment points</b>${total('Per day', tenths(b?.equipment))}`;
  if (!why.equipment.count) return `<b>Equipment points</b>${tipLine('Military factories', tenths(0))}${b.seized?.equipment ? change('From ground it occupies', b.seized.equipment, tenths) : ''}${total('Per day', tenths(b.equipment))}`;
  return '<b>Equipment points</b>'
    + tipLine('Military factories', tenths(why.equipment.count))
    + pointLines(w, tag, why.equipment, b.seized?.equipment, b.equipment,
      groupLines(w, tag, 'Factory output', ['factoryOutput', 'militaryFactoryOutput'])
      + groupLines(w, tag, 'Military production', ['militaryProduction']));
}

function shipsTip(w, tag, b) {
  const why = b?.why;
  if (!why) return `<b>Ship points</b>${total('Per day', tenths(b?.ships))}`;
  const y = why.ships, share = (x) => (y.count ? x / y.count : 0);
  const bonus = (label, x) => (share(x) > 0.0005 ? change(label, share(x), percentOf) : '');
  if (!y.count) return `<b>Ship points</b>${tipLine('0 dockyards', hundredths(0))}${b.seized?.ships ? change('From ground it occupies', b.seized.ships, tenths) : ''}${total('Per day', tenths(b.ships))}`;
  return '<b>Ship points</b>'
    + tipLine(`${Math.round(y.count / 2)} ${y.count === 2 ? 'dockyard' : 'dockyards'}`, hundredths(y.count))
    + bonus('Electricity', y.electricity)
    + bonus('Military factories nearby', y.factories)
    + bonus('Supply hubs', y.hub)
    + pointLines(w, tag, { ...y, count: y.lit }, b.seized?.ships, b.ships,
      groupLines(w, tag, 'Dockyard output', ['factoryOutput', 'dockyardOutput'])
      + groupLines(w, tag, 'Military production', ['militaryProduction']));
}

function researchTip(w, tag, b) {
  const cover = shortagesOf(tag).cover;
  const people = (b?.electrified || 0) / 2000000;
  return '<b>Research points</b>'
    + tipLine('Base output', hundredths(1))
    + change(`${menText(Math.round(b?.electrified || 0))} people with electricity`, people, hundredths)
    + (cover < 0.9995 ? change('Power shortage', -people * (1 - cover), hundredths) : '')
    + groupLines(w, tag, 'Research bonus', ['research'])
    + times('Stability', 1 + (stabilityOf(w, tag) - 50) / 250)
    + total('Per day', tenths(b?.research))
    + tipLine('Research slots', b?.slots ?? 1);
}

const COMMAND_BASE = 0.5;

function commandPowerTip(w, tag) {
  const cp = commandPowerOf(w, tag);
  return '<b>Command power</b>'
    + tipLine('Available', `${whole(w.polityValues?.[tag]?.commandPower)} of 100`)
    + '<hr>'
    + tipLine('Base income', hundredths(COMMAND_BASE))
    + (cp.base - COMMAND_BASE > 0.005 ? change(`${cp.units} units fielded`, cp.base - COMMAND_BASE, hundredths) : '')
    + nonZero(cp.percent).map((x) => partLine(x)).join('')
    + total('Per day', signed(cp.daily, hundredths));
}

// The ten national values, as the bar shows them.
const VALUES = [
  { id: 'politicalPower', name: 'Political power', read: (w, t) => whole(w.polityValues?.[t]?.politicalPower) },
  { id: 'treasury', name: 'Treasury', read: (w, t) => money(w.polityValues?.[t]?.treasury) },
  { id: 'stability', name: 'Stability', read: (w, t) => Math.round(stabilityOf(w, t)) + '%' },
  { id: 'happiness', name: 'Happiness', read: (w, t) => Math.round(realmFigures(w, t).happiness) + '%' },
  { id: 'manpower', name: 'Manpower', read: (w, t) => menText(manpowerOf(w, t).pool) },
  { id: 'commandPower', name: 'Command power', read: (w, t) => whole(w.polityValues?.[t]?.commandPower) },
  { id: 'construction', name: 'Construction points', read: (w, t, b) => tenths(b?.points) },
  { id: 'equipment', name: 'Equipment points', read: (w, t, b) => tenths(b?.equipment) },
  { id: 'ships', name: 'Ship points', read: (w, t, b) => tenths(b?.ships) },
  { id: 'research', name: 'Research points', read: (w, t, b) => tenths(b?.research) },
];

const MENU = ['Government', 'Policies and decrees', 'Supply', 'Production', 'Recruitment and deployment', 'Research', 'Trade', 'Intelligence', 'Diplomacy'];

const icon = () => {
  const img = document.createElement('img');
  img.alt = '';
  img.src = PLACEHOLDER_ICON;
  return img;
};

let cells = null;
let paintedDay = null;
let paintedTag = null;

function buildHud() {
  const values = document.getElementById('hud-values'), menu = document.getElementById('hud-menu');
  if (!values || !menu || cells) return;
  cells = new Map();
  for (const v of VALUES) {
    const cell = document.createElement('span');
    cell.className = 'hud-value';
    randomGrain(cell);
    const figure = document.createElement('b');
    cell.append(icon(), figure);
    values.append(cell);
    cells.set(v.id, { cell, figure });
  }
  for (const name of MENU) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hud-key';
    b.dataset.tip = name;
    b.setAttribute('aria-label', name);
    const lever = document.createElement('i');
    lever.className = 'lever';
    if (typeof lever.style?.setProperty === 'function') lever.style.setProperty('--tilt', (4 - MENU.indexOf(name)) * 3.5 + 'deg');
    b.append(lever, icon());
    menu.append(b);
  }
}

// Shows the bar for the playing country and refreshes it once a day, or at once when asked.
function paintHud(now = false) {
  document.body?.classList?.toggle('playing', Boolean(state.playing));
  const w = state.world, tag = state.playing;
  if (!w || !tag || !cells) return;
  const day = Math.floor(clock.tick / TICKS_PER_DAY);
  if (!now && day === paintedDay && tag === paintedTag) return;

  if (tag !== paintedTag) {
    const polity = w.table.polityById.get(tag);
    const img = document.getElementById('hud-flag');
    const slug = flagSlug(polity);
    if (img) {
      img.onerror = () => window.flagMiss(img, slug);
      maskFlagShading(img);
      const masked = img.onload;
      img.onload = () => {
        masked?.();
        const wide = Math.min(FLAG_MAX_W, FLAG_H * img.naturalWidth / img.naturalHeight);
        img.style.width = wide + 'px';
        img.style.height = wide * img.naturalHeight / img.naturalWidth + 'px';
      };
      img.src = flagSrc(slug);
    }
  }
  paintedDay = day;
  paintedTag = tag;

  const b = pointsOf(w, tag);
  const own = live.lastIndustry?.get?.(tag);
  const makers = pointMakers(w, tag);
  const alone = makers.length === 1 && makers[0] === tag;
  for (const v of VALUES) cells.get(v.id).figure.textContent = v.read(w, tag, b);

  const stability = stabilityOf(w, tag), manpower = manpowerOf(w, tag);
  const tips = {
    politicalPower: politicalPowerTip(w, tag),
    treasury: treasuryTip(tag),
    construction: alone ? constructionTip(w, tag, own) : memberTip(w, tag, 'Construction points', 'points'),
    equipment: alone ? equipmentTip(w, tag, own) : memberTip(w, tag, 'Equipment points', 'equipment'),
    ships: alone ? shipsTip(w, tag, own) : memberTip(w, tag, 'Ship points', 'ships'),
    research: alone ? researchTip(w, tag, own) : memberTip(w, tag, 'Research points', 'research'),
    stability: stabilityTip(w, tag, stability),
    happiness: happinessTip(w, tag),
    manpower: manpowerTip(w, tag, manpower),
    commandPower: commandPowerTip(w, tag),
  };
  for (const [id, markup] of Object.entries(tips)) meterTip(cells.get(id).cell, markup);
}

const escapeTip = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Hover tips for any control carrying data-tip, in the game's own tooltip.
function wireTips() {
  let held = null;
  const hide = () => { if (held) { held = null; els.tooltip.hidden = true; } };
  document.addEventListener('mouseover', (ev) => {
    const el = ev.target?.closest?.('[data-tip]');
    if (el === held) return;
    hide();
    if (!el || el.onmouseenter) return;
    held = el;
    live.tipFor = null;
    els.tooltip.innerHTML = `<div class="plain">${escapeTip(el.getAttribute('data-tip'))}</div>`;
    placeTooltip(ev);
  });
  document.addEventListener('mousemove', (ev) => { if (held) placeTooltip(ev); });
  document.addEventListener('pointerdown', hide, true);
}

// Sets the interface's scale from the screen.
function scaleInterface() {
  const k = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  const root = document.documentElement?.style;
  if (!(k > 0) || typeof root?.setProperty !== 'function') return;
  root.setProperty('--ui-scale', k.toFixed(4));
  root.setProperty('--ui-text-k', (k / Math.min(TEXT_MAX, Math.max(TEXT_MIN, k))).toFixed(4));
}

function wireHud() {
  buildHud();
  scaleInterface();
  window.addEventListener('resize', scaleInterface);
  for (const id of ['hud-values', 'clock-paper']) {
    const el = document.getElementById(id);
    if (el) randomGrain(el);
  }
  wireTips();
  setInterval(paintHud, HUD_REFRESH_MS);
}

export { tipLabel, happinessTip, paintHud, randomGrain, wireHud };
