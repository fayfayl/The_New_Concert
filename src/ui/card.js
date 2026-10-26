// The province card and its meters.

const VERSION = new URL(import.meta.url).search;
const { LEVELS } = await import(`../world/provincestats.js${VERSION}`);
const { isOccupied } = await import(`../world/mapdata.js${VERSION}`);
const { CLOCK_EPOCH, DAY_MS, TICKS_PER_DAY, clock, els, live, state } = await import(`../core/core.js${VERSION}`);
const { INFRA_NAME } = await import(`../render/modes.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let areaText, builtLevel, happinessOf, label, paintFlagBlock, placeTooltip, polityOf, railShare, taxMultiplier, unlockedSlots, unrestOf;
export function link(all) { ({ areaText, builtLevel, happinessOf, label, paintFlagBlock, placeTooltip, polityOf, railShare, taxMultiplier, unlockedSlots, unrestOf } = all); }

// Unrest thresholds with their effects and bar colours.
const UNREST_STEPS = [
  { at: 40, what: 'supply and construction -20%', colour: 'hsl(28 58% 47%)' },
  { at: 70, what: 'no construction', colour: 'hsl(0 58% 48%)' },
  { at: 100, what: 'uprising' },
];
const UNREST_CALM = 'hsl(48 40% 44%)';

// Adds a tick to the unrest bar at each step below 100.
for (const { at } of UNREST_STEPS) {
  if (at >= 100 || !els.cardUnrestBar) continue;
  const tick = document.createElement('u');
  tick.style.left = at + '%';
  els.cardUnrestBar.appendChild(tick);
}

// Happiness colour, red at 0 to green at 100.
function moodColour(v) {
  const h = (v / 100) * 120;                       // 0 red .. 120 green
  return `hsl(${h.toFixed(0)} 52% 46%)`;
}

// Unrest colour, warming at each threshold.
function unrestColour(v) {
  let colour = UNREST_CALM;
  for (const s of UNREST_STEPS) if (v >= s.at && s.colour) colour = s.colour;
  return colour;
}

// Breakdown tooltip markup, one signed, coloured line per contribution.
// A daily rate, to two decimals below 1.
const rateText = (n) => (Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(1));

function partsMarkup(title, parts, empty, risingIsGood = true, digits = null) {
  const body = parts.length
    ? [...parts].sort((a, b) => b[1] - a[1])
      .map(([label, n]) => {
        const sign = n > 0 ? '+' : '';
        const round = digits !== null ? n.toFixed(digits)
          : Math.abs(n) < 1 ? n.toFixed(2)
            : Math.abs(n) < 10 ? n.toFixed(1) : n.toFixed(0);
        const good = n > 0 === risingIsGood;
        return `<div class="cm-line"><span>${label}</span><b class="${good ? 'up' : 'down'}">${sign}${round}</b></div>`;
      })
      .join('')
    : `<div class="sub none">${empty}</div>`;
  return `<b>${title}</b>${body}`;
}

// Attaches a hover breakdown to a meter row.
function meterTip(row, markup) {
  // The card owns the tooltip while hovered, so the map's time refresh leaves it alone.
  row.onmouseenter = (ev) => { live.tipFor = null; els.tooltip.innerHTML = markup; placeTooltip(ev); };
  if (!els.tooltip.hidden && row.matches?.(':hover')) els.tooltip.innerHTML = markup;
  row.onmousemove = (ev) => placeTooltip(ev);
  row.onmouseleave = () => { els.tooltip.hidden = true; };
}

// Writes both meters and their breakdowns for the selected province.
function paintMeters(w, p, stats) {
  const today = new Date(CLOCK_EPOCH + Math.floor(clock.tick / TICKS_PER_DAY) * DAY_MS);
  const happy = happinessOf(w, p, stats, today);
  const unrest = unrestOf(w, p, stats, happy.value);

  els.cardHappy.textContent = happy.value.toFixed(0);
  els.cardHappyFill.style.width = `${happy.value}%`;
  els.cardHappyFill.style.background = moodColour(happy.value);
  els.cardHappyNote.innerHTML = `tax &times;${taxMultiplier(w, p, happy.value).value.toFixed(2)}`;
  meterTip(els.cardHappyRow, partsMarkup('Happiness', happy.parts, 'nothing here yet', true, 1));

  els.cardUnrest.textContent = unrest.value.toFixed(0);
  els.cardUnrestFill.style.width = `${unrest.value}%`;
  els.cardUnrestFill.style.background = unrestColour(unrest.value);

  if (unrest.rate > 0) {
    els.cardUnrestNote.innerHTML = `<span class="down">+${rateText(unrest.rate)}/day</span>`;
  } else if (unrest.value > 0) {
    els.cardUnrestNote.innerHTML = `<span class="up">${rateText(unrest.rate)}/day, settling</span>`;
  } else {
    els.cardUnrestNote.textContent = 'settled';
  }
  const steps = UNREST_STEPS
    .map(({ at, what }) => `<div class="cm-line ${unrest.value >= at ? 'down' : 'sub'}">`
      + `<span>${unrest.value >= at ? '&bull;' : '&#9702;'} ${at}</span><span>${what}</span></div>`)
    .join('');
  meterTip(els.cardUnrestRow,
    partsMarkup('Unrest per day', unrest.parts, 'business as usual', false) + '<hr>' + steps);
}

// Card order for the levels; unlisted levels go last.
const CARD_ORDER = ['road', 'airBase', 'supplyHub', 'radar', 'electricity', 'antiAir'];
const CARD_FIELDS = [...CARD_ORDER, ...LEVELS.filter((k) => !CARD_ORDER.includes(k))]
  .filter((k) => LEVELS.includes(k))
  .map((k) => [k, INFRA_NAME[k] ?? k]);

// The six levelled infrastructure types.
const LEVEL_TYPES = LEVELS;

// Radar levels locked behind research.
const RADAR_LOCKED = 4;

// How many of the locked radar levels the country has researched.
function radarUnlocked() { return 0; }

// Ceiling a country may build to; radar loses its locked levels.
function usableCeiling(key, ceiling) {
  return key === 'radar' ? Math.max(0, ceiling - RADAR_LOCKED + radarUnlocked()) : ceiling;
}

// Levels that can still be added under the ceiling.
function buildableLevels(built, ceiling) { return Math.max(0, ceiling - built); }

// Formats a level as built/max, accepting a bare number.
function pair(v) {
  const [built, max] = Array.isArray(v) ? v : [v ?? 0, 0];
  return `${built ?? 0}/${max ?? 0}`;
}

// Zeroed stats for a province missing from the stats file.
const BLANK_STATS = { claims: [], hydroPotential: 0, population: 0, road: [0, 0], airBase: [0, 0], supplyHub: [0, 0], radar: [0, 0], electricity: [0, 0], antiAir: [0, 0], buildingSlots: [0, 0], civilianFactories: 0, militaryFactories: 0 };

function closeCard() {
  els.card.classList.remove('open');
  els.card.setAttribute('aria-hidden', 'true');
}

// Draws building slots: civilian, then military, then empty.
function drawSlots(host, unlocked, civ, mil, maximum = unlocked) {
  host.innerHTML = '';
  const n = maximum;
  host.classList.toggle('wrapped', n > 10);
  for (let i = 0; i < n; i++) {
    const box = document.createElement('span');
    box.className = 'card-slot'
      + (i >= unlocked ? ' locked' : i < civ ? ' civ' : i < civ + mil ? ' mil' : '');
    box.append(document.createElement('i'));
    host.append(box);
  }
}

// Fills the card for the current selection and slides it in or out.
function updateCard() {
  const w = state.world;
  if (!w || !state.selected) return closeCard();

  const p = w.byId.get(state.selected);
  const stats = { ...BLANK_STATS, ...(w.stats?.[p.id] || {}) };
  const polity = polityOf(w, p);

  els.cardName.textContent = p.name;
  els.cardPolity.textContent = polity.name;
  paintFlagBlock(els.cardFlag, polity);

  const occupied = isOccupied(p);
  const owner = occupied ? w.table.polityById.get(p.owner) : null;
  els.cardRole.textContent = occupied ? 'Occupying power' : 'Province owner';
  els.cardOwner.hidden = !occupied;
  els.cardOwner.textContent = occupied ? `Owned by ${owner?.name || p.owner}` : '';

  const claims = (stats.claims || [])
    .map((id) => w.table.polityById.get(id)?.name || id);
  els.cardClaims.textContent = claims.length ? claims.join(', ') : 'None';

  els.cardPop.textContent = stats.population.toLocaleString();
  els.cardArea.textContent = areaText(p);

  paintMeters(w, p, stats);

  els.cardGrid.innerHTML = CARD_FIELDS
    .map(([key, label]) => {
      const [built = 0, ground = 0] = Array.isArray(stats[key]) ? stats[key] : [stats[key] ?? 0, 0];
      const max = usableCeiling(key, ground);
      const dead = max ? '' : ' none';
      return `<div class="card-cell${dead}"><span>${label}</span><b>${built}/${max}</b></div>`;
    })
    .join('');

  const [, slotMax = 0] = Array.isArray(stats.buildingSlots) ? stats.buildingSlots : [0, 0];
  const unlocked = unlockedSlots(slotMax, builtLevel(stats, 'road'), builtLevel(stats, 'electricity'), railShare(w, p));
  const civ = stats.civilianFactories || 0;
  const mil = stats.militaryFactories || 0;
  els.cardSlotsN.textContent = slotMax > unlocked
    ? `${civ + mil}/${unlocked} of ${slotMax}`
    : `${civ + mil}/${unlocked}`;
  drawSlots(els.cardSlots, unlocked, civ, mil, slotMax);
  els.cardCivN.textContent = civ;
  els.cardMilN.textContent = mil;

  els.card.classList.add('open');
  els.card.setAttribute('aria-hidden', 'false');
}

export { UNREST_STEPS, UNREST_CALM, moodColour, unrestColour, rateText, partsMarkup, meterTip, paintMeters, CARD_ORDER, CARD_FIELDS, LEVEL_TYPES, RADAR_LOCKED, radarUnlocked, usableCeiling, buildableLevels, pair, BLANK_STATS, closeCard, drawSlots, updateCard };
