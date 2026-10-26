// The country dossier: relations, actions, forces and opening it.

const VERSION = new URL(import.meta.url).search;
const { els, state } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let activeAgreements, activeLeases, voicedKey, closeCard, diploRow, doctrineOf, doctrineTip, flagSlug, flagSrc, governmentPosition, label, lawTip, manpowerOf, manpowerTip, maskFlagShading, menText, meterTip, modifierLines, playSelect, provincesUnder, relationTip, selectCounty, shortNameOf, spiritById, spiritGuarantees, spiritTip, stabilityOf, stabilityTip;
export function link(all) { ({ activeAgreements, activeLeases, voicedKey, closeCard, diploRow, doctrineOf, doctrineTip, flagSlug, flagSrc, governmentPosition, label, lawTip, manpowerOf, manpowerTip, maskFlagShading, menText, meterTip, modifierLines, playSelect, provincesUnder, relationTip, selectCounty, shortNameOf, spiritById, spiritGuarantees, spiritTip, stabilityOf, stabilityTip } = all); }

const cardOpen = () => els.card.classList.contains('open');

// Diplomacy panel: the owning country's state, opened by CTRL and left click.

// Draws the Actions box as a WIP stamp.
function paintDiploActions() {
  els.diploActions.innerHTML = '<h3>Actions</h3><div class="diplo-stamp"><span>WIP</span></div>';
}

// Relation band shared by a puppet and its suzerain.
const PUPPET_BAND = { id: 'puppet', name: 'Puppet', of: 'first', mirror: 'Suzerain' };

// Suzerain relations touching a polity, as relation records.
function puppetRelations(w, polityId) {
  const name = (p) => shortNameOf(p) || p.id;
  return (w.table?.polities || [])
    .filter((p) => p.suzerain && (p.suzerain === polityId || p.id === polityId))
    .sort((a, b) => name(a).localeCompare(name(b)))
    .map((p) => ({ band: 'puppet', first: p.suzerain, second: p.id }));
}

// Wars this country is fighting, as relation records.
function warRelations(w, polityId) {
  return (w.polityValues?.[polityId]?.atWar || []).map((id) => ({ band: 'war', first: polityId, second: id }));
}

// The Relations box: who this country stands with, and how.
function paintDiploRelations(w, polityId) {
  const box = els.diploRelations;
  box.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = 'Relations';
  box.append(h);

  const table = w.government?.relations;
  const carried = spiritGuarantees(w, polityId).concat(puppetRelations(w, polityId), warRelations(w, polityId));
  const pol = (id) => w.table?.polityById?.get(id);
  const shortName = (id) => shortNameOf(pol(id)) || id;

  let n = 0;
  for (const band of [PUPPET_BAND, ...(table?.bands || [])]) {
    // Wars come from the live lists, which the war records seed.
    let rows = (table?.relations || []).filter((x) => x.band === band.id && x.band !== 'war')
      .concat(carried.filter((x) => x.band === band.id));
    // A denunciation leaves the panel once what it cost has faded.
    if (band.id === 'denounced') {
      rows = rows.filter((r) => (w.relationHistory?.[voicedKey(w, r.first, r.second)]?.['denounced by ' + (pol(r.first)?.short || r.first)] || 0) < 0);
    }
    // Agreements and leases past their end leave the panel.
    if (band.id === 'stateAgreement') rows = rows.filter((r) => activeAgreements(w).includes(r));
    if (band.id === 'lease') rows = rows.filter((r) => activeLeases(w).includes(r));
    // State agreements between the same supplier and receiver share one flag.
    if (band.id === 'stateAgreement') {
      const byPair = new Map();
      for (const r of rows) {
        const k = r.first + '|' + r.second;
        if (byPair.has(k)) byPair.get(k).goods.push(r);
        else byPair.set(k, { ...r, goods: [r] });
      }
      rows = [...byPair.values()];
    }
    // Development aid between the same builder and host shares one flag.
    if (band.id === 'developmentAid') {
      const byPair = new Map();
      for (const r of rows.filter((x) => x.levels > 0)) {
        const k = r.first + '|' + r.second;
        if (byPair.has(k)) byPair.get(k).aid.push(r);
        else byPair.set(k, { ...r, aid: [r] });
      }
      rows = [...byPair.values()];
    }
    // One row per relation kind, with a fan of flags.
    const decks = new Map();
    for (const r of rows) {
      const mine = r.first === polityId;
      if (!mine && r.second !== polityId) continue;
      const label = mine ? band.name : (band.mirror || band.name);
      let deck = decks.get(label);
      if (!deck) {
        const row = document.createElement('div');
        row.className = 'diplo-row deck-row';
        row.dataset.band = band.id;
        const kind = document.createElement('i');
        kind.className = 'kind';
        kind.setAttribute?.('aria-label', label);
        meterTip(kind, '<b>' + label + '</b>');
        deck = document.createElement('span');
        deck.className = 'val deck';
        row.append(kind, deck);
        box.append(row);
        decks.set(label, deck);
        n++;
      }
      const other = mine ? r.second : r.first;
      const flag = document.createElement('img');
      flag.alt = shortName(other);
      const slug = flagSlug(pol(other), other);
      flag.onerror = () => window.flagMiss(flag, slug);
      maskFlagShading(flag);
      flag.src = flagSrc(slug);
      const flagBox = document.createElement('span');
      flagBox.className = 'diplo-flag small';
      flagBox.append(flag);
      const card = document.createElement('span');
      card.className = 'card';
      card.append(flagBox);
      meterTip(card, relationTip(w, band, r, other));
      deck.append(card);
    }
  }

}

// Totals of a country's own provinces for the ledger's right box.
function diploForces(w, id) {
  const held = provincesUnder(w, id);
  const mine = new Set(held.map((q) => q.id));
  let civ = 0, mil = 0, forts = 0, docks = 0;
  for (const q of held) {
    const inf = w.stats?.[q.id] || {};
    civ += inf.civilianFactories || 0;
    mil += inf.militaryFactories || 0;
  }
  for (const c of (w.counties?.byId ? w.counties.byId.values() : [])) {
    if (!mine.has(c.province)) continue;
    if (c.dockyard) docks++;
    forts += c.fortification || 0;
  }
  return { civ, mil, forts, docks };
}

// Folder of national spirit art.
const SPIRIT_ART = './data/img/national_spirits/';

// Folder of law option art.
const LAW_ART = './data/img/laws/';

// Fills the panel for one polity and slides it in.
function openDiplo(polityId) {
  const w = state.world;
  const polity = polityId && w?.table?.polities ? w.table.polities.find((x) => x.id === polityId) : null;
  if (!polity) return closeDiplo();

  closeCard();
  selectCounty(null);

  state.diplo = polityId;
  playSelect();

  const gov = w.government?.byPolity?.get(polityId) || null;
  const values = w.polityValues?.[polityId] || null;

  els.diploName.textContent = polity.name || polityId;
  paintDiploFlag(polity);
  els.diploPolity.textContent = shortNameOf(polity) || polityId;
  els.diploFaction.textContent = 'No faction';
  paintDiploLeader(w, polityId);
  const stability = stabilityOf(w, polityId);
  const manpower = manpowerOf(w, polityId);
  els.diploStability.textContent = Math.round(stability) + '%';
  els.diploManpower.textContent = menText(manpower.pool);
  meterTip(els.diploStability, stabilityTip(w, polityId, stability));
  meterTip(els.diploManpower, manpowerTip(w, polityId, manpower));

  const form = gov ? w.government?.ideologies?.forms?.find((f) => f.name === gov.form) : null;
  const votes = gov?.elections ?? form?.elections ?? false;
  let named = null;
  try { named = gov ? governmentPosition(w, polityId).ideology : null; } catch { named = null; }
  els.diploIdeology.textContent = named || '\u2014';
  els.diploIdeology.classList.toggle('blank', !named);
  els.diploElection.textContent = votes ? 'Next Election TBD' : 'No Election';
  els.diploFocus.textContent = 'No National Focus set';

  const spirits = gov?.spirits || [];
  els.diploSpirits.replaceChildren();
  if (spirits.length) {
    for (const sid of spirits) {
      const tile = document.createElement('i');
      tile.className = 'diplo-tile';
      tile.dataset.spirit = sid;
      const art = spiritById(w, sid)?.image;
      if (art) tile.style.backgroundImage = `url("${SPIRIT_ART}${art}.png")`;
      meterTip(tile, spiritTip(w, sid));
      els.diploSpirits.append(tile);
    }
  } else {
    const none = document.createElement('span');
    none.className = 'none';
    none.textContent = 'No national spirits';
    els.diploSpirits.append(none);
  }

  paintDiploRelations(w, polityId);

  paintDiploActions();

  const laws = Object.entries(gov?.laws || {});
  const box = els.diploLedgerLeft;
  box.replaceChildren();

  const heading = (title) => {
    const h = document.createElement('h3');
    h.textContent = title;
    box.append(h);
  };
  const grid = () => {
    const g = document.createElement('div');
    g.className = 'diplo-grid';
    box.append(g);
    return g;
  };

  heading('Laws');
  if (laws.length) {
    const g = grid();
    for (const [cat, opt] of laws) {
      const tile = document.createElement('i');
      tile.className = 'diplo-tile';
      tile.dataset.law = cat;
      tile.dataset.option = opt;
      const art = w.government?.laws?.categories?.[cat]?.options?.find((o) => o.name === opt)?.image;
      if (art) tile.style.backgroundImage = `url("${LAW_ART}${art}.png")`;
      meterTip(tile, lawTip(w, cat, opt));
      g.append(tile);
    }
  } else {
    const d = document.createElement('div');
    d.className = 'diplo-row none';
    d.textContent = 'Unknown';
    box.append(d);
  }

  const doctrine = Object.entries(gov ? doctrineOf(w, polityId) : {}).filter(([, school]) => school);
  if (doctrine.length) {
    heading('Doctrine');
    const g = grid();
    for (const [branch, school] of doctrine) {
      const tile = document.createElement('i');
      tile.className = 'diplo-tile';
      tile.dataset.doctrine = branch;
      tile.dataset.school = school;
      meterTip(tile, doctrineTip(w, branch, school));
      g.append(tile);
    }
  } else if (!gov) {
    heading('Doctrine');
    const d = document.createElement('div');
    d.className = 'diplo-row none';
    d.textContent = 'Unknown';
    box.append(d);
  }

  for (const title of ['Ministers', 'Commanders']) {
    heading(title);
    const g = grid();
    for (let i = 0; i < 3; i++) {
      const tile = document.createElement('i');
      tile.className = 'diplo-tile empty';
      g.append(tile);
    }
  }
  const f = diploForces(w, polityId);
  els.diploLedgerRight.innerHTML = '<h3>Forces</h3>'
    + diploRow('Divisions', 0, 'div')
    + diploRow('Air units', 0, 'air')
    + diploRow('Ship units', 0, 'ship')
    + diploRow('Forts', f.forts, 'fort')
    + '<h3>Industry</h3>'
    + diploRow('Military factories', f.mil, 'mil')
    + diploRow('Civilian factories', f.civ, 'civ')
    + diploRow('Dockyards', f.docks, 'dock');

  showDiploTab('diplomacy');
  els.diplo.classList.add('open');
  els.diplo.setAttribute('aria-hidden', 'false');
}

const diploOpen = () => els.diplo.classList.contains('open');

// Draws the leader in office, their portrait and party.
function paintDiploLeader(w, polityId) {
  const PLACEHOLDER = './data/img/portraits/placeholder.png';
  const held = w.government?.byPolity?.get(polityId)?.leader;
  const leader = held
    ? (w.government?.leaders?.leaders || []).find((l) => l.id === held) : null;

  els.diploLeader.textContent = leader
    ? [leader.house ? leader.title : null, leader.name].filter(Boolean).join(' ')
    : 'Placeholder';
  els.diploParty.textContent = leader ? (leader.party || 'No party') : 'Placeholder';

  const img = els.diploPortrait;
  if (!img) return;
  img.onerror = () => { img.onerror = null; img.src = PLACEHOLDER; };
  img.src = leader?.portrait
    ? './data/img/portraits/' + leader.portrait + '.png' : PLACEHOLDER;

  if (leader) meterTip(img, leaderTip(w, leader));
  else { img.onmouseenter = null; img.onmousemove = null; img.onmouseleave = null; }
}

// Tooltip for a leader's portrait.
function leaderTip(w, leader) {
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const head = '<b>' + esc([leader.title, leader.name].filter(Boolean).join(' ')) + '</b>'
    + '<div class="sub">' + esc(leader.party || leader.house || 'No party') + '</div>';
  const body = Object.entries(leader.effects || {})
    .map(([k, v]) => modifierLines(w, k, v, false, leader.target)).join('');
  const why = leader.description
    ? '<hr><div class="sub">' + esc(leader.description) + '</div>' : '';
  return head + body + why;
}

// Draws the country's flag, or the placeholder.
function paintDiploFlag(polity) {
  const slug = flagSlug(polity);
  const img = els.diploFlag;
  if (!img) return;
  img.onerror = () => window.flagMiss(img, slug);
  maskFlagShading(img);
  img.src = flagSrc(slug);
  img.alt = '';
}

function closeDiplo() {
  state.diplo = null;
  els.diplo.classList.remove('open');
  els.diplo.setAttribute('aria-hidden', 'true');
}

function showDiploTab(which) {
  const on = which === 'diplomacy';
  els.diploTabDiplomacy.classList.toggle('on', on);
  els.diploTabLedger.classList.toggle('on', !on);
  els.diploPaneDiplomacy.hidden = !on;
  els.diploPaneLedger.hidden = on;
}

export { cardOpen, paintDiploActions, PUPPET_BAND, puppetRelations, paintDiploRelations, diploForces, SPIRIT_ART, LAW_ART, openDiplo, diploOpen, paintDiploLeader, leaderTip, paintDiploFlag, closeDiplo, showDiploTab };
