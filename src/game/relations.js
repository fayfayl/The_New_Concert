// Relations between polities: compass distance, what each has done to the other, and world tension.

const VERSION = new URL(import.meta.url).search;
const { CLOCK_EPOCH, DAY_MS, TICKS_PER_DAY, TICKS_PER_HOUR, everyDay, everyTick, forgetOnChange, live } = await import(`../core/core.js${VERSION}`);
const { localHours, mapLonAt } = await import(`../world/geo.js${VERSION}`);
const { nameOf } = await import(`./government.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let governmentPosition, occupiedFraction, spiritById, imposersOf;
export function link(all) { ({ governmentPosition, occupiedFraction, spiritById, imposersOf } = all); }

// Relations: where two countries on the same compass point start, and what each point of distance costs.
const RELATIONS_BASE = 20;
const RELATIONS_PER_DISTANCE = 1 / 3;
const RELATIONS_RANGE = 100;
// World tension: what an occupied province adds while held, and the daily decay of everything else.
const OCCUPATION_TENSION = 1;
const TENSION_DECAY = 0.2;
const TENSION_CAP = 100;
// War: relations between belligerents while it lasts, and how fast the grudge fades at peace, a day.
const WAR_RELATIONS = -60;
const WAR_RECOVERY = 3 / 365;
// Brothers in arms: relations between countries on the same side of a war, and how fast it fades at peace, a day.
const ARMS_RELATIONS = 30;
const ARMS_FADE = 4 / 365;
// Claims: relations lost per share of the claimant's own people on ground the other holds, and the most it costs.
const CLAIM_RELATIONS = -150;
const CLAIM_CAP = -40;
// Sanctions and non-aggression pacts: relations between the two while they hold.
const SANCTION_RELATIONS = -30;
const PACT_RELATIONS = 5;
// Volunteers: relations between the sender and each country the receiver is at war with.
const VOLUNTEER_RELATIONS = -25;
// State agreements: what they add a day while they run, and the most, given freely as lend lease or at a price.
const AGREEMENT_PER_DAY = 0.05;
const LEND_LEASE_CEILING = 30;
const AGREEMENT_CEILING = 10;
// Anything asked in return, money or goods, makes it a trade.
const traded = (x) => (typeof x.price === 'number' ? x.price > 0 : Object.values(x.price || {}).some((n) => n > 0));
const agreementLabel = (x) => (traded(x) ? 'state agreement' : 'lend lease');
const agreementCeiling = (x) => (traded(x) ? AGREEMENT_CEILING : LEND_LEASE_CEILING);
// Denounce: relations lost at once, and how fast it fades, a day.
const DENOUNCE_RELATIONS = -20;
const DENOUNCE_FADE = 5 / 365;
// Improve relations: what it adds a day while it runs, and the most it adds.
const IMPROVE_PER_DAY = 0.1;
const IMPROVE_CEILING = 30;
// What a running action or policy built, fading a day once it stops.
const RUNNING_FADE = 10 / 365;

const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

// Inside a realm: what holding together adds between the realm and each member, and between members.
const SAME_REALM = 40;

// Who speaks for a polity abroad: its realm, if it is a member of one.
const voiceOf = (w, id) => {
  const parent = w.table?.polityById?.get(id)?.parent;
  return parent && parent !== id && w.government?.byPolity?.has(parent) ? parent : id;
};
// The pair a figure between two polities belongs to: their own inside one realm, their voices across two.
const voicedKey = (w, a, b) => {
  const va = voiceOf(w, a), vb = voiceOf(w, b);
  return va === vb ? pairKey(a, b) : pairKey(va, vb);
};
const clampRelations = (n) => Math.max(-RELATIONS_RANGE, Math.min(RELATIONS_RANGE, n));

// What the pair's standing acts and spirits put between them, as [label, figure] per pair.
function standingParts(w) {
  const g = w.government;
  const out = new Map();
  const put = (a, b, label, n) => {
    if (!a || !b || a === b || typeof n !== 'number' || !n) return;
    const k = voicedKey(w, a, b);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([label, n]);
  };
  const colonies = new Map();
  for (const p of w.table?.polityById?.values() || []) if (p.suzerain) colonies.set(p.suzerain, [...(colonies.get(p.suzerain) || []), p.id]);
  const holders = new Map();
  for (const [id, gov] of g?.byPolity || []) holders.set(gov.startingIdeology, [...(holders.get(gov.startingIdeology) || []), id]);

  for (const [id, gov] of g?.byPolity || []) {
    for (const sid of gov.spirits || []) {
      const sp = spiritById(w, sid);
      put(id, sp?.target, sp?.name || sid, sp?.effects?.relationsWithTarget);
      for (const c of colonies.get(id) || []) put(id, c, sp?.name || sid, sp?.effects?.relationsWithColonies);
    }
    const acts = [
      ...(gov.policies || []).map((x) => [x, g.policies?.policies?.find((q) => q.name === nameOf(x))]),
      ...(gov.decrees || []).map((x) => [x, g.decrees?.decrees?.find((q) => q.name === nameOf(x))]),
      ...(gov.fading || []).map((x) => [x, (x.policy ? g.policies?.policies : g.decrees?.decrees)?.find((q) => q.name === nameOf(x))]),
    ];
    for (const [held, act] of acts) {
      // An expired decree keeps only its permanent effects; one coming on or going off counts at its strength.
      const kept = held?.expired
        ? Object.fromEntries(Object.entries(act?.effects || {}).filter(([k]) => (act?.permanent || []).includes(k)))
        : act?.effects || {};
      const strength = held?.strength ?? 1;
      const e = Object.fromEntries(Object.entries(kept).filter(([k]) => !held?.except?.includes(k))
        .map(([k, n]) => [k, typeof n === 'number' ? n * strength : n]));
      const target = typeof held === 'object' ? held.target : null;
      put(id, target, act?.name, e.relationsWithTarget);
      for (const c of colonies.get(id) || []) put(id, c, act?.name, e.relationsWithColonies);
      for (const by of imposersOf(w, id)) put(id, by, act?.name, e.relationsWithImposers);
      // An act aimed at every ideology picks no side.
      if (typeof e.relationsWithHolders === 'number' && target && target !== 'all') {
        for (const h of holders.get(target) || []) put(id, h, act?.name, e.relationsWithHolders);
      }
    }
  }

  // Claimed ground another country holds, by how much of the claimant it is.
  const people = new Map();
  const claimed = new Map();   // claimant|holder -> people on the claimed ground
  for (const p of w.table?.provinces || []) {
    const st = w.stats?.[p.id];
    if (!st || !p.owner) continue;
    people.set(p.owner, (people.get(p.owner) || 0) + (st.population || 0));
    // Whoever sits on the ground: its occupier while it is occupied.
    const holder = p.occupier && occupiedFraction(w, p) > 0 ? p.occupier : p.owner;
    for (const c of st.claims || []) {
      if (c === holder) continue;
      const k = c + '|' + holder;
      claimed.set(k, (claimed.get(k) || 0) + (st.population || 0));
    }
  }
  for (const [k, n] of claimed) {
    const [claimant, holder] = k.split('|');
    const share = n / (people.get(claimant) || 1);
    const name = w.table?.polityById?.get(claimant)?.short || claimant;
    put(claimant, holder, 'claims by ' + name, Math.max(CLAIM_CAP, CLAIM_RELATIONS * share));
  }

  // Sanctions in force.
  for (const x of g?.relations?.relations || []) {
    if (x.band !== 'sanctions') continue;
    put(x.first, x.second, 'sanctions by ' + (w.table?.polityById?.get(x.first)?.short || x.first), SANCTION_RELATIONS);
  }
  for (const x of g?.relations?.relations || []) {
    if (x.band === 'nonAggression') put(x.first, x.second, 'non-aggression pact', PACT_RELATIONS);
    // Volunteers fight the receiver's enemies, and those enemies know whose they are.
    if (x.band === 'volunteers') {
      const name = 'volunteers from ' + (w.table?.polityById?.get(x.first)?.short || x.first);
      for (const enemy of w.polityValues?.[x.second]?.atWar || []) put(x.first, enemy, name, VOLUNTEER_RELATIONS);
    }
  }

  // A realm and its members hold together.
  const members = new Map();
  for (const p of w.table?.polityById?.values() || []) {
    if (voiceOf(w, p.id) !== p.id) members.set(p.parent, [...(members.get(p.parent) || []), p.id]);
  }
  for (const [realm, list] of members) {
    for (let i = 0; i < list.length; i++) {
      put(realm, list[i], 'same realm', SAME_REALM);
      for (let j = i + 1; j < list.length; j++) put(list[i], list[j], 'same realm', SAME_REALM);
    }
  }
  return out;
}

// World tension: what stands (occupations) and what was done (decaying), and each country's share of it.
function tensionOf(w) {
  const t = w.tension || (w.tension = { events: [] });
  const caused = new Map();
  const add = (id, n) => caused.set(id, (caused.get(id) || 0) + n);
  for (const p of w.table?.provinces || []) {
    if (p.occupier && occupiedFraction(w, p) > 0) add(voiceOf(w, p.occupier), OCCUPATION_TENSION);
  }
  for (const e of t.events) add(voiceOf(w, e.by), e.amount);
  const raw = [...caused.values()].reduce((a, n) => a + n, 0);
  const scale = raw > TENSION_CAP ? TENSION_CAP / raw : 1;
  for (const [id, n] of caused) caused.set(id, n * scale);
  return { value: Math.min(TENSION_CAP, raw), caused };
}

// What is left of brothers in arms from a war that ended on this date.
const armsSince = (ended) => Math.max(0, ARMS_RELATIONS - ARMS_FADE * ((CLOCK_EPOCH - Date.parse(ended)) / DAY_MS));
const putArms = (w, history, a, b, n) => {
  if (!n || a === b || voiceOf(w, a) === voiceOf(w, b)) return;
  const bag = (history[voicedKey(w, a, b)] ||= {});
  bag['brothers in arms'] = Math.max(bag['brothers in arms'] ?? 0, n);
};

// Wars that ended before the start leave what is left of their grudge, the worse where a pair fought twice.
function pastWarHistory(w, history) {
  const parts = new Map();
  for (const war of w.government?.pastWars || []) {
    if (war.war) parts.set(war.war, [...(parts.get(war.war) || []), war]);
    const years = (CLOCK_EPOCH - Date.parse(war.ended)) / DAY_MS / 365;
    const left = war.grudge ?? Math.min(0, WAR_RELATIONS + WAR_RECOVERY * 365 * years);
    if (!left || !Array.isArray(war.sides) || war.sides.length < 2) continue;
    for (let i = 0; i < war.sides.length; i++) {
      for (let j = i + 1; j < war.sides.length; j++) {
        for (const a of war.sides[i]) for (const b of war.sides[j]) {
          if (a === b) continue;
          const bag = (history[voicedKey(w, a, b)] ||= {});
          bag.war = Math.min(bag.war ?? 0, left);
        }
      }
    }
    // Those who fought on one side keep what is left of it, the better where they fought together twice.
    const arms = armsSince(war.ended);
    for (const side of war.sides) {
      for (let i = 0; i < side.length; i++) for (let j = i + 1; j < side.length; j++) putArms(w, history, side[i], side[j], arms);
    }
  }
  // Across two parts of one war, a side is the same side, and the alliance ended with the first peace.
  for (const list of parts.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const arms = armsSince(Date.parse(list[p].ended) < Date.parse(list[q].ended) ? list[p].ended : list[q].ended);
        if (!arms) continue;
        list[p].sides.forEach((side, i) => {
          for (const a of side) for (const b of list[q].sides[i] || []) putArms(w, history, a, b, arms);
        });
      }
    }
  }
}

// Pairs at war hold the war's figure in their history.
function warHistory(w) {
  const history = w.relationHistory || (w.relationHistory = {});
  if (!w.relationHistoryStarted) {
    pastWarHistory(w, history);
    // Improve relations already running at the start, with what it has built.
    for (const x of improving(w)) (history[voicedKey(w, x.first, x.second)] ||= {})['improve relations'] = Math.min(IMPROVE_CEILING, x.progress || 0);
    // Policies building relations at the start, with what they have built: progress, else their ceiling.
    for (const [id, gov] of w.government?.byPolity || []) {
      for (const x of gov.policies || []) {
        const e = policyEffects(w, x);
        if (!e.relationsWithTargetPerDay || !x.target || x.target === id) continue;
        const built = x.progress ?? e.relationsWithTargetCeiling ?? 0;
        (history[voicedKey(w, id, x.target)] ||= {})[nameOf(x).toLowerCase()] = Math.min(e.relationsWithTargetCeiling ?? Infinity, built);
      }
    }
    // State agreements running at the start, with what they have built.
    for (const x of w.government?.relations?.relations || []) {
      if (x.band !== 'stateAgreement') continue;
      const bag = (history[voicedKey(w, x.first, x.second)] ||= {});
      const label = agreementLabel(x);
      bag[label] = Math.min(agreementCeiling(x), Math.max(bag[label] || 0, x.progress || 0));
    }
    // Denunciations made before the start, in the order made: each adds to what is left of the last, and all of it fades to the start.
    const denounced = (w.government?.relations?.relations || []).filter((x) => x.band === 'denounced')
      .map((x) => ({ ...x, at: x.on ? Date.parse(x.on) : CLOCK_EPOCH })).sort((p, q) => p.at - q.at);
    const standing = new Map();
    for (const x of denounced) {
      const k = x.first + '|' + x.second;
      const last = standing.get(k);
      const before = last ? Math.min(0, last.value + DENOUNCE_FADE * (x.at - last.at) / DAY_MS) : 0;
      standing.set(k, { first: x.first, second: x.second, value: before + DENOUNCE_RELATIONS, at: x.at });
    }
    for (const x of standing.values()) {
      const left = Math.min(0, x.value + DENOUNCE_FADE * Math.max(0, CLOCK_EPOCH - x.at) / DAY_MS);
      if (!left) continue;
      const name = w.table?.polityById?.get(x.first)?.short || x.first;
      (history[voicedKey(w, x.first, x.second)] ||= {})['denounced by ' + name] = left;
    }
    w.relationHistoryStarted = true;
  }
  for (const [a, v] of Object.entries(w.polityValues || {})) {
    for (const b of v.atWar || []) (history[voicedKey(w, a, b)] ||= {}).war = WAR_RELATIONS;
  }
  for (const k of alliedInWar(w)) (history[k] ||= {})['brothers in arms'] = ARMS_RELATIONS;
}

// Pairs fighting a common enemy now.
function alliedInWar(w) {
  const out = new Set();
  const ids = Object.keys(w.polityValues || {});
  for (let i = 0; i < ids.length; i++) {
    const ea = w.polityValues[ids[i]].atWar || [];
    if (!ea.length) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const eb = w.polityValues[ids[j]].atWar || [];
      if (eb.some((x) => ea.includes(x)) && !ea.includes(ids[j]) && voiceOf(w, ids[i]) !== voiceOf(w, ids[j])) out.add(voicedKey(w, ids[i], ids[j]));
    }
  }
  return out;
}

// Compass positions, refreshed one country at a time; and what every pair shares, refreshed daily.
const positions = new Map();
let terms = { standing: new Map(), tension: { value: 0, caused: new Map() } };
const positionOf = (w, id) => {
  try { const pos = governmentPosition(w, id)?.position; if (pos) positions.set(id, pos); } catch { /* no position */ }
};
function refreshTerms(w) {
  warHistory(w);
  terms = { standing: standingParts(w), tension: tensionOf(w) };
  if (live.lastRelations) live.lastRelations.tension = terms.tension;
}

// One pair's relations, from the positions and terms in hand.
function pairRelations(w, a, b) {
  // Across two realms, or between a realm's member and an outsider, the realms' own pair answers.
  const va = voiceOf(w, a), vb = voiceOf(w, b);
  if (va !== vb && (va !== a || vb !== b)) return pairRelations(w, va, vb);
  const pa = positions.get(a), pb = positions.get(b);
  if (!pa || !pb) return null;
  const distance = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
  const base = RELATIONS_BASE - distance * RELATIONS_PER_DISTANCE;
  const k = pairKey(a, b);
  const parts = [...(terms.standing.get(k) || []), ...Object.entries(w.relationHistory?.[k] || {})];
  const before = base + parts.reduce((s, [, n]) => s + n, 0);
  // What either raised in tension, weighed more heavily the further apart the pair stands.
  const weight = (RELATIONS_RANGE - before) / RELATIONS_RANGE + distance / 300;
  const charged = ((terms.tension.caused.get(a) || 0) + (terms.tension.caused.get(b) || 0)) / 2 * weight;
  return { value: clampRelations(before - charged), base, parts, tension: charged, distance };
}

// Every pair at once, used at load.
function dailyRelations(w) {
  for (const id of w.government?.byPolity?.keys() || []) positionOf(w, id);
  refreshTerms(w);
  const ids = [...positions.keys()];
  const out = new Map();
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.set(pairKey(ids[i], ids[j]), pairRelations(w, ids[i], ids[j]));
  }
  out.tension = terms.tension;
  return out;
}

// The tick of the day a country's capital reaches midnight, from its longitude.
let slotsWorld = null, slots = new Map();
forgetOnChange(() => { slotsWorld = null; });
function midnightSlots(w) {
  if (slotsWorld === w) return slots;
  const capitalX = new Map();
  for (const c of w.cities || []) {
    const owner = c.capital ? w.byId?.get(c.province)?.owner : null;
    if (owner && !capitalX.has(owner)) capitalX.set(owner, c.x);
  }
  slots = new Map();
  for (const id of w.government?.byPolity?.keys() || []) {
    let x = capitalX.get(id);
    // A realm keeps its first member's time; a polity with no capital its largest province's.
    if (x === undefined) {
      const member = [...(w.table?.polityById?.values() || [])].find((p) => p.parent === id && capitalX.has(p.id));
      x = member ? capitalX.get(member.id) : undefined;
    }
    if (x === undefined) {
      let best = null;
      for (const p of w.table?.provinces || []) {
        if (p.owner !== id) continue;
        const n = w.stats?.[p.id]?.population || 0;
        if (!best || n > best[0]) best = [n, w.bounds?.get(p.id)?.cx];
      }
      x = best?.[1];
    }
    const utcMidnight = x === undefined ? 0 : (24 - localHours(mapLonAt(x, w.width), 0, w.width)) % 24;
    slots.set(id, Math.floor(utcMidnight * TICKS_PER_HOUR) % TICKS_PER_DAY);
  }
  slotsWorld = w;
  return slots;
}

// At a capital's midnight, that country's position and its relations with everyone are refreshed.
function midnightRelations(w, tick) {
  const slot = tick % TICKS_PER_DAY;
  const due = [...midnightSlots(w)].filter(([, s]) => s === slot).map(([id]) => id);
  if (!due.length) return;
  for (const id of due) positionOf(w, id);
  for (const a of due) {
    for (const b of positions.keys()) {
      if (a === b) continue;
      const x = pairRelations(w, a, b);
      if (x) live.lastRelations.set(pairKey(a, b), x);
    }
  }
}

// Relations between two polities, from the last day's figures.
function relationsBetween(a, b) {
  return live.lastRelations?.get(pairKey(a, b)) || null;
}

// A held policy's effects.
const policyEffects = (w, x) => w.government?.policies?.policies?.find((q) => q.name === nameOf(x))?.effects || {};

// Improve relations actions running now.
const improving = (w) => (w.government?.relations?.relations || []).filter((x) => x.band === 'improving');

// Running policies and actions build history a little each day, to their ceiling.
function growHistory(w) {
  const g = w.government;
  const history = w.relationHistory || (w.relationHistory = {});
  // Labels of every running source, and those that ran today.
  const running = new Set(['improve relations', 'lend lease', 'state agreement']);
  const ran = new Set();
  for (const x of improving(w)) {
    const k = voicedKey(w, x.first, x.second);
    const bag = (history[k] ||= {});
    bag['improve relations'] = Math.min(IMPROVE_CEILING, (bag['improve relations'] || 0) + IMPROVE_PER_DAY);
    ran.add(k + '|improve relations');
  }
  // State agreements build relations while they run; a pair counts once for each kind however much is sent.
  const supplying = new Set();
  for (const x of g?.relations?.relations || []) {
    if (x.band !== 'stateAgreement') continue;
    const k = voicedKey(w, x.first, x.second);
    const label = agreementLabel(x);
    if (supplying.has(k + '|' + label)) continue;
    supplying.add(k + '|' + label);
    ran.add(k + '|' + label);
    const bag = (history[k] ||= {});
    bag[label] = Math.min(agreementCeiling(x), (bag[label] || 0) + AGREEMENT_PER_DAY);
  }
  for (const p of g?.policies?.policies || []) if (p.effects?.relationsWithTargetPerDay) running.add(p.name.toLowerCase());
  for (const [id, gov] of g?.byPolity || []) {
    // Policies that build relations with their target while they run.
    for (const x of gov.policies || []) {
      const e = policyEffects(w, x);
      const target = typeof x === 'object' ? x.target : null;
      if (!e.relationsWithTargetPerDay || !target || target === id) continue;
      const k = voicedKey(w, id, target);
      const bag = history[k] || (history[k] = {});
      const label = nameOf(x).toLowerCase();
      bag[label] = Math.min(e.relationsWithTargetCeiling ?? Infinity, (bag[label] || 0) + e.relationsWithTargetPerDay);
      ran.add(k + '|' + label);
    }
  }
  // A grudge fades once the war is over.
  const fighting = new Set();
  for (const [a, v] of Object.entries(w.polityValues || {})) for (const b of v.atWar || []) fighting.add(voicedKey(w, a, b));
  const allied = alliedInWar(w);
  for (const [k, bag] of Object.entries(history)) {
    if (bag.war !== undefined && !fighting.has(k)) {
      bag.war = Math.min(0, bag.war + WAR_RECOVERY);
      if (!bag.war) delete bag.war;
    }
    // A denunciation fades a little faster than trust.
    for (const label of Object.keys(bag)) {
      if (!label.startsWith('denounced by ')) continue;
      bag[label] = Math.min(0, bag[label] + DENOUNCE_FADE);
      if (!bag[label]) delete bag[label];
    }
    // A running source that has stopped fades.
    for (const label of Object.keys(bag)) {
      if (!running.has(label) || ran.has(k + '|' + label)) continue;
      bag[label] = Math.max(0, bag[label] - RUNNING_FADE);
      if (!bag[label]) delete bag[label];
    }
    // Trust fades faster than distrust.
    if (bag['brothers in arms'] !== undefined && !allied.has(k)) {
      bag['brothers in arms'] = Math.max(0, bag['brothers in arms'] - ARMS_FADE);
      if (!bag['brothers in arms']) delete bag['brothers in arms'];
    }
  }
  for (const e of w.tension?.events || []) e.amount = Math.max(0, e.amount - TENSION_DECAY);
  if (w.tension) w.tension.events = w.tension.events.filter((e) => e.amount > 0);
}

// Last day's relations for every pair, read by the console and, later, by trade and diplomacy.
live.lastRelations = new Map();
everyDay((w) => { growHistory(w); refreshTerms(w); });
everyTick(midnightRelations);

export { RUNNING_FADE, ARMS_RELATIONS, ARMS_FADE, DENOUNCE_RELATIONS, DENOUNCE_FADE, SANCTION_RELATIONS, PACT_RELATIONS, VOLUNTEER_RELATIONS, AGREEMENT_PER_DAY, LEND_LEASE_CEILING, AGREEMENT_CEILING, armsSince, alliedInWar, SAME_REALM, voiceOf, voicedKey, IMPROVE_PER_DAY, IMPROVE_CEILING, improving, CLAIM_RELATIONS, CLAIM_CAP, WAR_RELATIONS, WAR_RECOVERY, pastWarHistory, warHistory, RELATIONS_BASE, RELATIONS_PER_DISTANCE, RELATIONS_RANGE, OCCUPATION_TENSION, TENSION_DECAY, TENSION_CAP, pairKey, standingParts, tensionOf, refreshTerms, pairRelations, dailyRelations, midnightSlots, midnightRelations, relationsBetween, growHistory };
