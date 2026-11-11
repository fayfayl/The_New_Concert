// The country dossier: relations, actions, forces and opening it.

const VERSION = new URL(import.meta.url).search;
const { CLOCK_EPOCH, DAY_MS, clock, els, governmentChanged, live, state } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let DENOUNCE_RELATIONS, capitaliseArticle, aidPoliticalPower, actionDailyCost, activeAgreements, activeLeases, bothKeys, builtLevel, colonyHolder, giveDevelopmentAid, guarantees, occupiedFraction, pairRelations, paintHud, voiceOf, voicedKey, closeCard, diploRow, doctrineOf, doctrineTip, flagSlug, flagSrc, governmentPosition, label, lawTip, manpowerOf, manpowerTip, maskFlagShading, menText, meterTip, modifierLines, playSelect, provincesUnder, relationTip, relationsBetween, tipLabel, flaggedName, selectCounty, shortNameOf, spiritById, spiritGuarantees, spiritTip, stabilityOf, stabilityTip;
export function link(all) { ({ DENOUNCE_RELATIONS, capitaliseArticle, aidPoliticalPower, actionDailyCost, activeAgreements, activeLeases, bothKeys, builtLevel, colonyHolder, giveDevelopmentAid, guarantees, occupiedFraction, pairRelations, paintHud, voiceOf, voicedKey, closeCard, diploRow, doctrineOf, doctrineTip, flagSlug, flagSrc, governmentPosition, label, lawTip, manpowerOf, manpowerTip, maskFlagShading, menText, meterTip, modifierLines, playSelect, provincesUnder, relationTip, relationsBetween, tipLabel, flaggedName, selectCounty, shortNameOf, spiritById, spiritGuarantees, spiritTip, stabilityOf, stabilityTip } = all); }

const cardOpen = () => els.card.classList.contains('open');

// Diplomacy panel: the owning country's state, opened by CTRL and left click.

// Diplomatic actions the game carries out; the rest answer with the WIP note.
const LIVE_ACTIONS = new Set(['Improve relations', 'Denounce', 'Guarantee', 'Development aid']);
// Days a denounced country may not improve relations with the denouncer.
const DENOUNCED_DAYS = 90;
// Projects the development aid picker offers.
const AID_PICKS = ['road', 'electricity'];
// The development aid picker: open or shut, for which country, and its choices.
const aidPick = { open: false, for: null, province: null, project: null };

// Today on the game clock, as a time and a date.
const todayMs = () => CLOCK_EPOCH + clock.day * DAY_MS;
const todayIso = () => new Date(todayMs()).toISOString().slice(0, 10);
const daysSince = (iso) => Math.floor((todayMs() - Date.parse(iso)) / DAY_MS);

// A's view of b, voiced as the game reads it.
const viewOf = (w, a, b) => relationsBetween(...voicedKey(w, a, b).split('>'))?.value;
// Relation records of one band from a to b.
const recordsOf = (w, band, a, b) => (w.government?.relations?.relations || []).filter((x) => x.band === band && x.first === a && x.second === b);
// Whether two countries, or their realms, are at war.
function fighting(w, a, b) {
  const at = (x, y) => (w.polityValues?.[x]?.atWar || []).includes(y);
  const va = voiceOf(w, a), vb = voiceOf(w, b);
  return at(a, b) || at(b, a) || at(va, vb) || at(vb, va);
}
const signedWhole = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n));
const capitalise = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const escapeHtml = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');

// What compass distance does to an act's cost: dearer apart, or dearer alike.
function distanceFactor(act, distance) {
  if (act.costDoublesAtDistance) return 1 + distance / act.costDoublesAtDistance;
  if (act.costDoublesCloser) return 1 + Math.max(0, act.costDoublesCloser - distance) / act.costDoublesCloser;
  return 1;
}

// An act's opening political power, less the world tension discount.
function actionCost(w, name, cost) {
  const d = w.government?.actions?.tensionDiscount;
  const per = d?.perPoint?.[name];
  if (!per) return cost;
  return Math.max(cost * (d.floor ?? 0), cost - per * (live.lastRelations?.tension?.value || 0));
}

// The host's provinces open to a level of road or electricity, by name.
function aidRoom(w, us, them) {
  const queued = w.polityValues?.[us]?.construction || [];
  const out = [];
  for (const q of provincesUnder(w, them)) {
    const p = w.byId?.get(q.id) || q;
    const st = w.stats?.[q.id];
    if (!st || occupiedFraction(w, p) > 0) continue;
    const open = AID_PICKS.filter((id) => {
      const [built = 0, ceiling = 0] = Array.isArray(st[id]) ? st[id] : [builtLevel(st, id), 0];
      return built + queued.filter((x) => x.project === id && x.province === q.id).length < ceiling;
    });
    if (open.length) out.push({ id: q.id, name: p.name || q.id, open });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// The national spirit barring an action, by name, if any.
function barredBy(w, us, them, name) {
  const tension = live.lastRelations?.tension?.value || 0;
  const bars = {
    'Alliance:Military': [us, (e) => e.cannotMilitaryAlly || (e.militaryAllianceTension || 0) > tension],
    'Send volunteers': [us, (e) => e.cannotIntervene],
    'Expeditionary force': [us, (e) => e.cannotIntervene],
    'Request military access': [them, (e) => e.cannotGrantAccess],
  }[name];
  if (!bars) return null;
  const [holder, test] = bars;
  const id = (w.government?.byPolity?.get(holder)?.spirits || []).find((s) => test(spiritById(w, s)?.effects || {}));
  return id ? spiritById(w, id)?.name || id : null;
}

// What an action needs, each as a sentence and whether it holds.
function needLines(w, us, them, needs, theirs) {
  const pol = (id) => w.table?.polityById?.get(id);
  const short = shortNameOf(pol(them), true) || them;
  const name = flaggedName(pol(them), short);
  const view = typeof theirs === 'number' ? theirs : -Infinity;
  const holds = (band) => (w.government?.relations?.relations || []).some((x) => x.band === band && [x.first, x.second].includes(us) && [x.first, x.second].includes(them));
  const out = [];
  if (needs?.notAtWar) out.push(['We must not be at war with ' + name, !fighting(w, us, them)]);
  if (typeof needs?.relations === 'number') out.push(['Opinions of ' + name + ' on us must be ' + signedWhole(needs.relations) + ' or better', view >= needs.relations]);
  if (typeof needs?.relationsAbove === 'number') out.push(['Opinions of ' + name + ' on us must be above ' + signedWhole(needs.relationsAbove), view > needs.relationsAbove]);
  if (typeof needs?.relationsWithMembers === 'number') out.push(['Opinions of every member on us must be ' + signedWhole(needs.relationsWithMembers) + ' or better', view >= needs.relationsWithMembers]);
  if (needs?.targetAtWar) out.push([name + ' must be at war', (w.polityValues?.[them]?.atWar || []).length > 0]);
  if (needs?.militaryAllianceOrAccess) out.push(['We must have a military alliance or military access with ' + name, holds('allies') || holds('access')]);
  return out;
}

// The player's actions toward a country, each with its cost and why it is shut.
function actionRows(w, us, them) {
  const me = w.table?.polityById?.get(us), it = w.table?.polityById?.get(them);
  const member = voiceOf(w, us) !== us;
  const pp = w.polityValues?.[us]?.politicalPower || 0;
  const theirs = viewOf(w, them, us);
  const allied = (w.government?.relations?.relations || []).some((x) => x.band === 'allies' && [x.first, x.second].includes(us) && [x.first, x.second].includes(them));
  const rows = [];
  for (const act of w.government?.actions?.actions || []) {
    // A member takes only Ask for diplomatic action toward its own realm.
    if (Boolean(act.onlyByMembers) !== (member && voiceOf(w, us) === them)) continue;
    if (act.name === 'Leave an alliance' && !allied) continue;
    const kinds = act.options
      ? act.options.map((o) => ({ key: act.name + ':' + o.name, name: o.name + ' alliance', cost: o.cost, needs: o.needs, effect: [act.effect, o.effect] }))
      : [{ key: act.name, name: act.name, cost: act.cost, needs: act.needs, effect: [act.effect] }];
    for (const k of kinds) {
      const row = { ...k, act, target: flaggedName(it, shortNameOf(it, true) || them), cooldown: act.cooldownDays, live: LIVE_ACTIONS.has(act.name), cost: actionCost(w, act.name, k.cost * distanceFactor(act, relationsBetween(us, them)?.distance || 0)), extra: [], why: null };
      const improving = act.name === 'Improve relations' ? recordsOf(w, 'improving', us, them) : [];
      if (act.name === 'Improve relations') {
        const distance = relationsBetween(us, them)?.distance || 0;
        row.extra.push(['Political power per day', '−' + actionDailyCost(w, act.name, distance).toFixed(2)]);
      }
      if (act.dailyCost && !act.dailyCostDistance) row.extra.push(['Political power per day', '−' + actionDailyCost(w, act.name).toFixed(2)]);
      if (act.doubledAboveOwnView != null && (viewOf(w, us, them) ?? 0) > act.doubledAboveOwnView) row.cost *= 2;
      if (act.claimCost != null && provincesUnder(w, them).some((q) => (w.stats?.[q.id]?.claims || []).includes(us))) row.cost = act.claimCost;
      if (act.tensionWithoutCasusBelli || act.tension) row.extra.push(['World tension', '+' + (act.tensionWithoutCasusBelli || act.tension)]);
      row.needLines = needLines(w, us, them, k.needs, theirs);
      if (act.name === 'Development aid') {
        const view = typeof theirs === 'number' ? theirs : 0;
        row.cost = aidPoliticalPower(w, colonyHolder(w, them) === us) * (100 - view) / 100;
      }
      if (improving.length) {
        Object.assign(row, { key: 'Stop improving relations', name: 'Stop improving relations', cost: 0, stop: true, needLines: [], extra: [], cooldown: null });
        rows.push(row);
        continue;
      }
      const denounced = (a, b, days) => recordsOf(w, 'denounced', a, b).find((x) => x.on && daysSince(x.on) < days);
      const left = (x, days) => days - daysSince(x.on);
      const name = flaggedName(it, shortNameOf(it, true) || them);
      const Name = name.replace(/^the /, 'The ');
      const why = (() => {
        if (act.notByMembers && member) return 'Our realm takes this action for us';
        if (act.notByVassals && me?.suzerain) return 'Our suzerain takes this action for us';
        if (act.notAgainstOwnVassals && it?.suzerain === us) return Name + ' is our own vassal';
        if (act.notAgainstOwnSuzerain && me?.suzerain === them) return Name + ' is our suzerain';
        const bar = barredBy(w, us, them, k.key);
        if (bar) return 'Our national spirit <i>' + bar + '</i> bars this action';
        const unmet = row.needLines.find(([, ok]) => !ok);
        if (unmet) return unmet[0];
        if (act.name === 'Improve relations') {
          const x = denounced(them, us, DENOUNCED_DAYS);
          if (x) return Name + ' denounced us, so we may not improve relations for another ' + left(x, DENOUNCED_DAYS) + ' days';
        }
        if (act.name === 'Denounce') {
          const x = denounced(us, them, act.cooldownDays);
          if (x) return 'We may not denounce ' + name + ' again for another ' + left(x, act.cooldownDays) + ' days';
        }
        if (act.notUnderPact && (recordsOf(w, 'nonAggression', us, them).length || recordsOf(w, 'nonAggression', them, us).length)) return 'We have a non-aggression pact with ' + name;
        if (act.name === 'Guarantee' && guarantees(w).some((x) => x.first === us && x.second === them)) return 'We already guarantee ' + name;
        if (act.name === 'Non-aggression pact' && (recordsOf(w, 'nonAggression', us, them).length || recordsOf(w, 'nonAggression', them, us).length)) return 'We already have a non-aggression pact with ' + name;
        if (act.name === 'Development aid' && !aidRoom(w, us, them).length) return Name + ' has no province where we can build';
        return null;
      })();
      row.why = why || (pp < row.cost ? 'We have only ' + Math.floor(pp) + ' political power' : null);
      rows.push(row);
    }
  }
  return rows;
}

// Tooltip for one action row: figures, then what it needs and why it is shut, then what it does.
function actionTip(row, pp) {
  const line = (label, value, cls) => '<div class="cm-line"><span>' + label + '</span><b' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</b></div>';
  const sentence = (text, ok) => '<div class="sub' + (ok ? '' : ' down') + '">' + text + '.</div>';
  const unmet = row.needLines.some(([text, ok]) => !ok && text === row.why);
  const terms = row.needLines.map(([text, ok]) => sentence(text, ok)).join('')
    + (row.why && !unmet ? sentence(row.why, false) : '');
  const effect = capitaliseArticle(row.effect.filter(Boolean).map((t) => capitalise(escapeHtml(t)).replace(/\.?$/, '.')).join(' ').split('POLITY_NAME').join(row.target));
  return '<b>' + row.name + '</b>'
    + line('Political power', Math.round(row.cost), row.cost > pp ? 'down' : '')
    + row.extra.map(([label, value]) => line(label, value)).join('')
    + (row.cooldown ? line('Cooldown', row.cooldown + ' days') : '')
    + (terms ? '<hr>' + terms : '')
    + (effect ? '<hr><div class="sub">' + effect + '</div>' : '');
}

// The development aid picker: province, project and the key that builds.
function aidPicker(w, us, them) {
  const room = aidRoom(w, us, them);
  const at = room.find((p) => p.id === aidPick.province) || room[0];
  aidPick.province = at.id;
  if (!at.open.includes(aidPick.project)) aidPick.project = at.open[0];
  const names = w.production?.construction?.projects || [];
  const select = (pick, options, value) => {
    const el = document.createElement('select');
    el.dataset.pick = pick;
    for (const [id, text] of options) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = text;
      el.append(o);
    }
    el.value = value;
    return el;
  };
  const wrap = document.createElement('div');
  wrap.className = 'diplo-aid';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'aid-build';
  go.dataset.act = 'aid-build';
  go.textContent = 'Build';
  wrap.append(
    select('province', room.map((p) => [p.id, p.name]), aidPick.province),
    select('project', at.open.map((id) => [id, names.find((x) => x.id === id)?.name || id]), aidPick.project),
    go);
  return wrap;
}

// Draws the Actions box: the player's diplomatic actions toward this country.
function paintDiploActions(w, polityId, force = false) {
  const box = els.diploActions;
  // A picker in use keeps its place through the daily repaint.
  if (!force && document.activeElement?.tagName === 'SELECT' && box.contains?.(document.activeElement)) return;
  box.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = 'Actions';
  box.append(h);
  const us = state.playing;
  if (aidPick.for !== polityId) Object.assign(aidPick, { open: false, for: polityId, province: null, project: null });
  if (!w || !us || us === polityId) {
    const none = document.createElement('div');
    none.className = 'diplo-row none';
    none.textContent = us ? 'No actions toward own country' : 'No country played';
    box.append(none);
    return;
  }
  const pp = w.polityValues?.[us]?.politicalPower || 0;
  for (const row of actionRows(w, us, polityId)) {
    const slot = document.createElement('div');
    slot.className = 'act-slot';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'diplo-row act';
    b.disabled = Boolean(row.why);
    b.dataset.act = row.key;
    const lab = document.createElement('span');
    lab.className = 'lab';
    lab.textContent = row.name;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = String(Math.round(row.cost));
    b.append(lab, val);
    slot.append(b);
    box.append(slot);
    meterTip(slot, actionTip(row, pp));
    if (row.key === 'Development aid' && aidPick.open && !row.why) box.append(aidPicker(w, us, polityId));
  }
}

// Recomputes both views of a pair from the terms in hand.
function refreshPair(w, a, b) {
  for (const k of bothKeys(w, a, b)) {
    const view = pairRelations(w, ...k.split('>'));
    if (view) live.lastRelations?.set(k, view);
  }
}

// Takes the action under a key in the Actions box, or answers that it is not in the game yet.
function takeDiploAction(key, from = null) {
  const w = state.world, us = state.playing, them = state.diplo;
  if (!w || !us || !them || us === them) return;
  if (key === 'aid-build') return buildAid(w, us, them);
  const row = actionRows(w, us, them).find((r) => r.key === key);
  if (!row || row.why) return;
  if (!row.live) return showWipNote(from);
  if (row.key === 'Development aid') {
    aidPick.open = !aidPick.open;
    return paintDiploActions(w, them, true);
  }
  const table = (w.government.relations ||= {});
  const list = (table.relations ||= []);
  if (row.stop) {
    table.relations = list.filter((x) => !(x.band === 'improving' && x.first === us && x.second === them));
  } else {
    w.polityValues[us].politicalPower -= row.cost;
    const today = todayIso();
    if (row.act.name === 'Improve relations') list.push({ band: 'improving', first: us, second: them, since: today });
    if (row.act.name === 'Guarantee') list.push({ band: 'guarantee', first: us, second: them, since: today });
    if (row.act.name === 'Non-aggression pact') list.push({ band: 'nonAggression', first: us, second: them, since: today });
    if (row.act.name === 'Denounce') {
      const held = recordsOf(w, 'denounced', us, them)[0];
      if (held) held.on = today;
      else list.push({ band: 'denounced', first: us, second: them, on: today });
      const label = 'denounced by ' + (w.table.polityById.get(us)?.short || us);
      const history = w.relationHistory || (w.relationHistory = {});
      for (const k of bothKeys(w, us, them)) {
        const bag = (history[k] ||= {});
        bag[label] = (bag[label] || 0) + DENOUNCE_RELATIONS;
      }
    }
  }
  if (row.act.tension && !row.stop) (w.tension ||= { events: [] }).events.push({ by: us, amount: row.act.tension });
  refreshPair(w, us, them);
  governmentChanged(new Set([us, them]));
  paintHud?.(true);
}

// Queues the picked level of development aid.
function buildAid(w, us, them) {
  try {
    giveDevelopmentAid(w, us, aidPick.project, aidPick.province);
  } catch (e) {
    console.warn(e.message);
    return;
  }
  aidPick.open = false;
  governmentChanged(new Set([us, them]));
  paintHud?.(true);
}

// Takes a choice from the development aid picker.
function pickAid(el) {
  const pick = el?.dataset?.pick;
  if (!pick || !state.world || !state.diplo) return;
  aidPick[pick] = el.value;
  paintDiploActions(state.world, state.diplo, true);
}

// The note for an action not in the game yet.
function showWipNote(from = null, text = 'WIP, feature not implemented yet') {
  const body = els.wipNote.querySelector?.('.dialog-body');
  if (body) body.textContent = text;
  const r = from?.getBoundingClientRect?.();
  const k = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  if (r && els.wipNote.style) Object.assign(els.wipNote.style, { left: (r.left + r.width / 2) / k + 'px', top: (r.top + r.height / 2) / k + 'px' });
  els.wipNote.hidden = false;
  els.wipNote.classList.add('open');
  els.wipNote.setAttribute('aria-hidden', 'false');
}

function closeWipNote() {
  els.wipNote.hidden = true;
  els.wipNote.classList.remove('open');
  els.wipNote.setAttribute('aria-hidden', 'true');
}

const wipNoteOpen = () => Boolean(els.wipNote?.classList.contains('open'));

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
  paintDiploPair(w, polity);
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

  paintDiploActions(w, polityId);

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

// A's view of b, term by term.
function viewTip(w, a, b, view) {
  const pol = (id) => w.table.polityById.get(id);
  const nameOf = (id) => shortNameOf(pol(id), true) || id;
  const named = (id, s = nameOf(id)) => flaggedName(pol(id), s);
  const tenths = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(1);
  const line = (label, n) => '<div class="cm-line"><span>' + label + '</span><b'
    + (n > 0 ? ' class="up"' : n < 0 ? ' class="down"' : '') + '>' + tenths(n) + '</b></div>';
  const head = '<b>Opinions of ' + named(a) + ' on ' + named(b) + '</b>';
  if (!view) return head;
  const parts = [...view.parts].filter(([, n]) => Math.abs(n) >= 0.05).sort((x, y) => y[1] - x[1]);
  const sum = view.base + parts.reduce((s, [, n]) => s + n, 0) - view.tension;
  const [va, vb] = voicedKey(w, a, b).split('>');
  const fighting = (w.polityValues?.[va]?.atWar || []).includes(vb) || (w.polityValues?.[vb]?.atWar || []).includes(va);
  const realmOf = (id) => pol(id)?.parent;
  const disputes = parts.filter(([label]) => label.startsWith('claims on ') || label.startsWith('claims by ')).length;
  const termOf = (label) => {
    if (label === 'war') return fighting ? 'At war' : 'Past war';
    if (label === 'same realm') return realmOf(b) === a ? 'Member of realm' : realmOf(a) === b ? 'Head of realm' : 'Same realm';
    if (label === 'guarantee') return 'Received guarantee';
    if (label.startsWith('guarantee of ')) return 'Given guarantee';
    if (label.startsWith('claims on ') || label.startsWith('claims by ')) return disputes > 1 ? 'Disputed territories' : 'Disputed territory';
    if (label.startsWith('denounced by ')) {
      const by = [...w.table.polityById.values()].find((p) => (p.short || p.name) === label.slice(13))?.id;
      return by && voicedKey(w, by, b) === voicedKey(w, a, b) ? 'Issued denunciation' : 'Received denunciation';
    }
    return tipLabel(w, label);
  };
  return head
    + line(view.base >= 0 ? 'Ideological affinity' : 'Ideological aversion', view.base)
    + [...parts.reduce((m, [label, n]) => m.set(termOf(label), (m.get(termOf(label)) || 0) + n), new Map())]
      .sort((x, y) => y[1] - x[1]).map(([label, n]) => line(label, n)).join('')
    + (view.tension >= 0.05 ? line('World tension', -view.tension) : '')
    + (Math.abs(view.value - sum) >= 0.05 ? line('Held to −100 to 100', view.value - sum) : '')
    + '<hr><div class="cm-line"><span>Total</span><b>' + tenths(view.value) + '</b></div>';
}

// The playing country's and this country's views of each other.
function paintDiploPair(w, polity) {
  const us = state.playing, them = polity.id;
  els.diploPair.hidden = !us || us === them;
  if (els.diploPair.hidden) return;
  const figure = (el, a, b) => {
    const view = relationsBetween(...voicedKey(w, a, b).split('>'));
    const n = Math.round(view?.value ?? 0);
    el.textContent = n > 0 ? '+' + n : n < 0 ? '−' + -n : '0';
    el.classList.toggle('up', n > 0);
    el.classList.toggle('down', n < 0);
    return viewTip(w, a, b, view);
  };
  const ours = figure(els.diploPairOurs, us, them), theirs = figure(els.diploPairTheirs, them, us);
  for (const el of [els.diploPairOurs, els.diploPairTo, els.diploPairThemBox]) meterTip(el, ours);
  for (const el of [els.diploPairTheirs, els.diploPairFrom, els.diploPairUsBox]) meterTip(el, theirs);
  paintDiploFlag(w.table.polityById.get(us), els.diploPairUs);
  paintDiploFlag(polity, els.diploPairThem);
}

// Draws the country's flag, or the placeholder.
function paintDiploFlag(polity, img = els.diploFlag) {
  const slug = flagSlug(polity);
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

export { cardOpen, LIVE_ACTIONS, actionRows, paintDiploActions, takeDiploAction, pickAid, showWipNote, closeWipNote, wipNoteOpen, PUPPET_BAND, puppetRelations, paintDiploRelations, diploForces, SPIRIT_ART, LAW_ART, openDiplo, diploOpen, paintDiploLeader, leaderTip, paintDiploFlag, closeDiplo, showDiploTab };
