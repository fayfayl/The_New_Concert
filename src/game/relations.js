// Relations between polities: each country's view of each other, from compass distance, what each has done to the other, and world tension.

const VERSION = new URL(import.meta.url).search;
const { CLOCK_EPOCH, DAY_MS, TICKS_PER_DAY, TICKS_PER_HOUR, clock, everyDay, everyTick, finish, forgetOnChange, live } = await import(`../core/core.js${VERSION}`);
const { localHours, mapLonAt } = await import(`../world/geo.js${VERSION}`);
const { nameOf } = await import(`./government.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let governmentPosition, occupiedFraction, spiritById, imposersOf, activeAgreements, colonyHolder, fillTokens, highestTariffSteps;
export function link(all) { ({ governmentPosition, occupiedFraction, spiritById, imposersOf, activeAgreements, colonyHolder, fillTokens, highestTariffSteps } = all); }

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
// Occupation: the owner's view of the occupier, per share of its own people under occupation, and the most it costs.
const OCCUPIED_RELATIONS = -150;
const OCCUPIED_CAP = -40;
// Sanctions and non-aggression pacts: relations between the two while they hold.
const SANCTION_RELATIONS = -30;
const PACT_RELATIONS = 5;
// Volunteers: relations between the sender and each country the receiver is at war with, and with the receiver.
const VOLUNTEER_RELATIONS = -25;
const VOLUNTEER_GRATITUDE = 10;
// State agreements: what they add a day while they run, and the most, given freely as lend lease or at a price.
const AGREEMENT_PER_DAY = 0.05;
const LEND_LEASE_CEILING = 30;
const AGREEMENT_CEILING = 10;
// Anything asked in return, money or goods, makes it a trade.
const traded = (x) => (typeof x.price === 'number' ? x.price > 0 : Object.values(x.price || {}).some((n) => n > 0));
const agreementLabel = (x) => (traded(x) ? 'state agreement' : 'lend lease');
const agreementCeiling = (x) => (traded(x) ? AGREEMENT_CEILING : LEND_LEASE_CEILING);
// Production points a day that earn an agreement's full ceiling; less earns a share of it, and builds as much slower.
const AGREEMENT_FULL_POINTS = 3;
// Points of one unit of a good: equipment and ships by their points, a resource 1.
function goodPoints(w, good) {
  const list = (x) => (Array.isArray(x) ? x : Object.values(x || {}));
  const item = list(w.production?.equipment?.items).find((q) => q.id === good) || list(w.production?.ships?.hulls).find((q) => q.id === good);
  return item?.points ?? 1;
}
// Share of the full ceiling a supplier's agreements of one kind with one receiver earn, by what they send a day.
function agreementShare(w, x) {
  const points = activeAgreements(w).filter((y) => y.first === x.first && y.second === x.second && traded(y) === traded(x))
    .reduce((s, y) => s + (y.amount || 0) * goodPoints(w, y.good), 0);
  return Math.min(1, points / AGREEMENT_FULL_POINTS);
}
// Denounce: relations lost at once, and how fast it fades, a day.
const DENOUNCE_RELATIONS = -20;
const DENOUNCE_FADE = 5 / 365;
// Improve relations: what it adds a day while it runs, and the most it adds.
const IMPROVE_PER_DAY = 0.1;
const IMPROVE_CEILING = 30;
// Daily gain scales with the improving country's own view: x(1 + view / 100), kept between these.
const IMPROVE_RATE_MIN = 0.025;
const IMPROVE_RATE_MAX = 0.15;
// Guarantee: what it adds a day in the guaranteed country's view while it holds, the most, and what refusing to honour it costs at once.
const GUARANTEE_PER_DAY = 0.05;
const GUARANTEE_CEILING = 20;
const GUARANTEE_REFUSAL = -40;
// Development aid: what each level a builder keeps up adds to the host's view of it, and the most.
const AID_PER_LEVEL = 2;
const AID_CEILING = 15;
// Share of what a giver's improve relations, agreements, investment, development aid and guarantees build that the giver feels back.
const GIVER_SHARE = 0.25;
// Share of a claim's penalty in the claimant's own view of the holder.
const CLAIMANT_SHARE = 0.5;
// What a running action or policy built, fading a day once it stops.
const RUNNING_FADE = 10 / 365;
// Tariffs: what each 10% of the highest rate levied costs a day in the taxed country's view of the levier, and the most.
const TARIFF_PER_TENTH = -1 / 30;
const TARIFF_CAP = -30;
const TARIFF_LABEL = 'tariffs by ';
// The decree a dated stance record stands for.
const STANCE = 'Stance on POLITY_NAME';
// Friend of an enemy: the history a friendship needs, the view that makes an enemy, what each point of friendship costs, the share for a friendship only returned, and the most it costs per enemy and in all.
const FRIEND_LINE = 30;
const ENEMY_LINE = -40;
const FRIEND_RATE = 0.5;
const FRIEND_GIVEN_SHARE = 0.25;
const FRIEND_CAP = -15;
const FRIEND_TOTAL_CAP = -25;

// One country's view of another: a's of b.
const pairKey = (a, b) => a + '>' + b;

// Inside a realm: what holding together adds between the realm and each member, and between members.
const SAME_REALM = 40;

// Who speaks for a polity abroad: its realm, if it is a member of one.
const voiceOf = (w, id) => {
  const parent = w.table?.polityById?.get(id)?.parent;
  return parent && parent !== id && w.government?.byPolity?.has(parent) ? parent : id;
};
// Whose view of whom a figure belongs to: their own inside one realm, their voices' across two.
const voicedKey = (w, a, b) => {
  const va = voiceOf(w, a), vb = voiceOf(w, b);
  return va === vb ? pairKey(a, b) : pairKey(va, vb);
};
// Both views of a pair.
const bothKeys = (w, a, b) => [voicedKey(w, a, b), voicedKey(w, b, a)];
const clampRelations = (n) => Math.max(-RELATIONS_RANGE, Math.min(RELATIONS_RANGE, n));

// Countries by the ideology they hold.
function holdersOf(w) {
  const holders = new Map();
  for (const [id, gov] of w.government?.byPolity || []) holders.set(gov.startingIdeology, [...(holders.get(gov.startingIdeology) || []), id]);
  return holders;
}

// The relations figures an act held by id carries, as [a, b, figure]: a's view of b.
function actFigures(w, id, target, e, holders) {
  const out = [[id, target, e.relationsWithTarget], [target, id, e.relationsFromTarget]];
  for (const by of imposersOf(w, id)) out.push([by, id, e.relationsWithImposers]);
  // An act aimed at every ideology picks no side.
  if (typeof e.relationsWithHolders === 'number' && target && target !== 'all') {
    for (const h of holders.get(target) || []) out.push([h, id, e.relationsWithHolders]);
  }
  return out;
}

// An act's label once ended, kept apart from the same act held again.
const ENDED = ', ended';

// What standing acts and spirits put into one country's view of another, as [label, figure] per view.
function standingParts(w) {
  const g = w.government;
  const out = new Map();
  // a's view of b.
  const put = (a, b, label, n) => {
    if (!a || !b || a === b || typeof n !== 'number' || !n) return;
    const k = voicedKey(w, a, b);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([label, n]);
  };
  const both = (a, b, label, n) => { put(a, b, label, n); put(b, a, label, n); };
  const colonies = new Map();
  for (const p of w.table?.polityById?.values() || []) if (p.suzerain) colonies.set(p.suzerain, [...(colonies.get(p.suzerain) || []), p.id]);
  const holders = holdersOf(w);

  for (const [id, gov] of g?.byPolity || []) {
    for (const sid of gov.spirits || []) {
      const sp = spiritById(w, sid);
      put(id, sp?.target, sp?.name || sid, sp?.effects?.relationsWithTarget);
      put(sp?.target, id, sp?.name || sid, sp?.effects?.relationsFromTarget);
      for (const c of colonies.get(id) || []) both(id, c, sp?.name || sid, sp?.effects?.relationsWithColonies);
    }
    // A leader's own stance toward a country, or toward each country named.
    const leader = gov.leader ? (g.leaders?.leaders || []).find((x) => x.id === gov.leader) : null;
    if (leader) {
      const title = [leader.title, leader.name].filter(Boolean).join(' ');
      put(id, leader.target, title, leader.effects?.relationsWithTarget);
      for (const [t, n] of Object.entries(leader.effects?.relationsWithTargets || {})) put(id, t, title, n);
      for (const [t, n] of Object.entries(leader.effects?.relationsFromTargets || {})) put(t, id, title, n);
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
      // An infrastructure target names its builder.
      const target = typeof held === 'object' ? (held.target && typeof held.target === 'object' ? held.target.builder : held.target) : null;
      const label = act?.name ? fillTokens(act.name, typeof held === 'object' ? held.target : null, g, w.table?.polityById?.get(id)) : act?.name;
      // A figure that fades from the day the act was enacted.
      const fade = (n) => (typeof n !== 'number' || !e.relationsFadePerYear || held?.since === undefined ? n
        : Math.sign(n) * Math.max(0, Math.abs(n) - e.relationsFadePerYear * Math.max(0, clock.day - held.since) / 365));
      // A grudge left in history stands for the ended act's negative figures.
      for (const [a, b, n] of actFigures(w, id, target, e, holders)) if (!(held?.lingers && n < 0)) put(a, b, label, fade(n));
      for (const c of colonies.get(id) || []) both(id, c, label, e.relationsWithColonies);
    }
  }

  // Claimed ground another country holds, by how much of the claimant it is, in the holder's view of the claimant.
  const people = new Map();
  const claimed = new Map();   // claimant|holder -> people on the claimed ground
  const occupied = new Map();  // owner|occupier -> people on the occupied ground
  for (const p of w.table?.provinces || []) {
    const st = w.stats?.[p.id];
    if (!st || !p.owner) continue;
    people.set(p.owner, (people.get(p.owner) || 0) + (st.population || 0));
    // Whoever sits on the ground: its occupier while it is occupied.
    const holder = p.occupier && occupiedFraction(w, p) > 0 ? p.occupier : p.owner;
    if (holder !== p.owner) occupied.set(p.owner + '|' + holder, (occupied.get(p.owner + '|' + holder) || 0) + (st.population || 0));
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
    const figure = Math.max(CLAIM_CAP, CLAIM_RELATIONS * share);
    put(holder, claimant, 'claims by ' + name, figure);
    // The claimant thinks less of the holder too, by half.
    put(claimant, holder, 'claims on ' + (w.table?.polityById?.get(holder)?.short || holder), figure * CLAIMANT_SHARE);
  }
  // Own ground another country occupies, by how much of the owner it is, in the owner's view of the occupier.
  for (const [k, n] of occupied) {
    const [owner, occupier] = k.split('|');
    const share = n / (people.get(owner) || 1);
    const name = w.table?.polityById?.get(occupier)?.short || occupier;
    put(owner, occupier, 'occupation by ' + name, Math.max(OCCUPIED_CAP, OCCUPIED_RELATIONS * share));
  }

  // Sanctions in force, in the target's view of the sanctioner.
  for (const x of g?.relations?.relations || []) {
    if (x.band !== 'sanctions') continue;
    put(x.second, x.first, 'sanctions by ' + (w.table?.polityById?.get(x.first)?.short || x.first), SANCTION_RELATIONS);
  }
  for (const x of g?.relations?.relations || []) {
    if (x.band === 'nonAggression') both(x.first, x.second, 'non-aggression pact', PACT_RELATIONS);
    // Volunteers fight the receiver's enemies, and those enemies know whose they are.
    if (x.band === 'volunteers') {
      const name = 'volunteers from ' + (w.table?.polityById?.get(x.first)?.short || x.first);
      for (const enemy of w.polityValues?.[x.second]?.atWar || []) put(enemy, x.first, name, VOLUNTEER_RELATIONS);
      put(x.second, x.first, name, VOLUNTEER_GRATITUDE);
    }
  }

  // A realm and its members hold together.
  const members = new Map();
  for (const p of w.table?.polityById?.values() || []) {
    if (voiceOf(w, p.id) !== p.id) members.set(p.parent, [...(members.get(p.parent) || []), p.id]);
  }
  for (const [realm, list] of members) {
    for (let i = 0; i < list.length; i++) {
      both(realm, list[i], 'same realm', SAME_REALM);
      for (let j = i + 1; j < list.length; j++) both(list[i], list[j], 'same realm', SAME_REALM);
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
  for (const k of bothKeys(w, a, b)) {
    const bag = (history[k] ||= {});
    bag['brothers in arms'] = Math.max(bag['brothers in arms'] ?? 0, n);
  }
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
          for (const k of bothKeys(w, a, b)) {
            const bag = (history[k] ||= {});
            bag.war = Math.min(bag.war ?? 0, left);
          }
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

// An act just ended leaves its negative figures in history, at the strength it held, to fade as a denunciation does.
function endedGrudges(w) {
  const g = w.government;
  const history = w.relationHistory || (w.relationHistory = {});
  let holders = null;
  for (const [id, gov] of g?.byPolity || []) {
    for (const f of gov.fading || []) {
      if (f.lingers !== undefined) continue;
      const act = (f.policy ? g.policies?.policies : g.decrees?.decrees)?.find((q) => q.name === nameOf(f));
      // A figure that fades from the day enacted goes on fading with the act.
      f.lingers = !act?.effects?.relationsFadePerYear;
      if (!f.lingers || !act) continue;
      const e = Object.fromEntries(Object.entries(act?.effects || {}).filter(([k, n]) => typeof n === 'number' && !f.except?.includes(k))
        .map(([k, n]) => [k, n * (f.from ?? 1)]));
      const target = f.target && typeof f.target === 'object' ? f.target.builder : f.target;
      const label = fillTokens(act.name, f.target ?? null, g, w.table?.polityById?.get(id)) + ENDED;
      for (const [a, b, n] of actFigures(w, id, target, e, holders ||= holdersOf(w))) {
        if (!a || !b || a === b || !(n < 0)) continue;
        const bag = (history[voicedKey(w, a, b)] ||= {});
        bag[label] = Math.min(bag[label] ?? 0, n);
      }
    }
  }
}

// Pairs at war hold the war's figure in both views.
function warHistory(w) {
  const history = w.relationHistory || (w.relationHistory = {});
  if (!w.relationHistoryStarted) {
    pastWarHistory(w, history);
    // Improve relations already running at the start, with what it has built, in the other country's view.
    for (const x of improving(w)) {
      const days = x.since ? Math.max(0, (CLOCK_EPOCH - Date.parse(x.since)) / DAY_MS) : 0;
      (history[voicedKey(w, x.second, x.first)] ||= {})['improve relations'] = Math.min(IMPROVE_CEILING, IMPROVE_PER_DAY * days);
    }
    w.improveStartPending = true;
    // Policies building relations at the start, with what they have built in the target's view: progress, else their ceiling.
    for (const [id, gov] of w.government?.byPolity || []) {
      for (const x of gov.policies || []) {
        const e = policyEffects(w, x);
        if (!e.relationsWithTargetPerDay || !x.target || x.target === id) continue;
        const built = x.progress ?? e.relationsWithTargetCeiling ?? 0;
        (history[voicedKey(w, x.target, id)] ||= {})[nameOf(x).toLowerCase()] = Math.min(e.relationsWithTargetCeiling ?? Infinity, built);
      }
      // Policies and decrees turning a country's own view of their target, in that view.
      for (const x of ownViewHeld(gov)) {
        const e = policyEffects(w, x);
        if (!e.ownViewOfTargetPerDay || !x.target || x.target === id) continue;
        const ceiling = e.ownViewOfTargetCeiling ?? Infinity;
        (history[voicedKey(w, id, x.target)] ||= {})[ownViewLabel(w, x)] = towardSign(x) * Math.min(ceiling, Math.abs(x.progress ?? ceiling));
        // The target sees it too, in its view of the holder.
        if (e.targetViewPerDay) {
          const seen = e.targetViewCeiling ?? Infinity;
          (history[voicedKey(w, x.target, id)] ||= {})[seenLabel(w, x, id)] = towardSign(x) * Math.min(seen, Math.abs(x.progress ?? seen));
        }
      }
    }
    // Guarantees held at the start, in the guaranteed country's view: built since given, else long-standing at the ceiling.
    for (const x of guarantees(w)) {
      const days = x.since ? Math.max(0, (CLOCK_EPOCH - Date.parse(x.since)) / DAY_MS) : Infinity;
      const bag = (history[voicedKey(w, x.second, x.first)] ||= {});
      bag.guarantee = Math.max(bag.guarantee || 0, Math.min(GUARANTEE_CEILING, GUARANTEE_PER_DAY * days));
    }
    // State agreements running at the start, with what they have built, in the receiver's view.
    for (const x of activeAgreements(w)) {
      const bag = (history[voicedKey(w, x.second, x.first)] ||= {});
      const label = agreementLabel(x);
      // What it has built since it was signed.
      const days = x.since ? Math.max(0, (CLOCK_EPOCH - Date.parse(x.since)) / DAY_MS) : 0;
      const share = agreementShare(w, x);
      bag[label] = Math.min(agreementCeiling(x) * share, Math.max(bag[label] || 0, AGREEMENT_PER_DAY * share * days));
    }
    // Stances held and ended before the start, from since to until: what each built while held, faded 10 a year to the start, in the holder's own view.
    const stanceAct = (w.government?.decrees?.decrees || []).find((d) => d.name === STANCE);
    for (const [id, gov] of w.government?.byPolity || []) {
      for (const x of (gov.decrees || []).filter((d) => d?.decree === STANCE && d.expired && d.since && d.until)) {
        const e = stanceAct?.effects || {};
        const held = Math.max(0, (Date.parse(x.until) - Date.parse(x.since)) / DAY_MS);
        const built = Math.min(e.ownViewOfTargetCeiling ?? Infinity, (e.ownViewOfTargetPerDay || 0) * held);
        const left = Math.max(0, built - RUNNING_FADE * Math.max(0, (CLOCK_EPOCH - Date.parse(x.until)) / DAY_MS));
        if (left) (history[voicedKey(w, id, x.target)] ||= {})[ownViewLabel(w, x)] = towardSign(x) * left;
      }
    }
    // Denunciations made before the start, in the order made: each adds to what is left of the last, and all of it fades to the start, in both views.
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
      for (const k of bothKeys(w, x.first, x.second)) (history[k] ||= {})['denounced by ' + name] = left;
    }
    w.relationHistoryStarted = true;
  }
  for (const [a, v] of Object.entries(w.polityValues || {})) {
    for (const b of v.atWar || []) for (const k of bothKeys(w, a, b)) (history[k] ||= {}).war = WAR_RELATIONS;
  }
  for (const k of alliedInWar(w)) (history[k] ||= {})['brothers in arms'] = ARMS_RELATIONS;
}

// Views between pairs fighting a common enemy now, both ways.
function alliedInWar(w) {
  const out = new Set();
  const ids = Object.keys(w.polityValues || {});
  for (let i = 0; i < ids.length; i++) {
    const ea = w.polityValues[ids[i]].atWar || [];
    if (!ea.length) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const eb = w.polityValues[ids[j]].atWar || [];
      if (eb.some((x) => ea.includes(x)) && !ea.includes(ids[j]) && voiceOf(w, ids[i]) !== voiceOf(w, ids[j])) for (const k of bothKeys(w, ids[i], ids[j])) out.add(k);
    }
  }
  return out;
}

// Compass positions, refreshed one country at a time; and what every pair shares, refreshed daily.
const positions = new Map();
let terms = { standing: new Map(), tension: { value: 0, caused: new Map() }, friends: new Map() };
const positionOf = (w, id) => {
  try { const pos = governmentPosition(w, id)?.position; if (pos) positions.set(id, pos); } catch { /* no position */ }
};
function refreshTerms(w) { finish(termSteps(w)); }

// Views worked out between pauses of the daily terms.
const TERMS_SLICE = 100;

// The same in steps, the new terms built to one side and put in at the end.
function* termSteps(w) {
  warHistory(w);
  endedGrudges(w);
  const next = { standing: standingParts(w), tension: tensionOf(w) };
  yield;
  next.friends = yield* friendSteps(w, next);
  if (w.improveStartPending) {
    // Improve relations running at the start, rebuilt at each improving country's own rate.
    delete w.improveStartPending;
    const history = w.relationHistory;
    const built = improving(w).map((x) => {
      const days = x.since ? Math.max(0, (CLOCK_EPOCH - Date.parse(x.since)) / DAY_MS) : 0;
      return [voicedKey(w, x.second, x.first), Math.min(IMPROVE_CEILING, improveRate(w, x.first, x.second, next) * days)];
    });
    for (const [k, n] of built) (history[k] ||= {})['improve relations'] = n;
    next.friends = yield* friendSteps(w, next);
  }
  terms = next;
  if (live.lastRelations) live.lastRelations.tension = terms.tension;
}

// A's view of b without the base, tension or friends of enemies: standing terms, history, and a share of what a gave.
function historyParts(w, a, b, t = terms) {
  const k = pairKey(a, b);
  // A giver feels back a share of what its giving built in the other's view.
  const bName = w.table?.polityById?.get(b)?.short || b;
  const given = Object.entries(w.relationHistory?.[pairKey(b, a)] || {}).filter(([label]) => givenLabels(w).has(label))
    .map(([label, n]) => [label + (GIVEN_JOIN[label] || ' to ') + bName, n * GIVER_SHARE]);
  return [...(t.standing.get(k) || []), ...Object.entries(w.relationHistory?.[k] || {}), ...given];
}

// Friend of an enemy: c's view of a, where a and b are friends by history and b is c's enemy, between voices only.
function friendParts(w, t = terms) { return finish(friendSteps(w, t)); }

// The same in steps, from the terms t.
function* friendSteps(w, t) {
  // Counted from views that carry none of their own.
  t.friends = new Map();
  let worked = 0;
  const out = new Map();
  const isVoice = (id) => w.government?.byPolity?.has(id) && voiceOf(w, id) === id;
  const voices = [...(w.government?.byPolity?.keys() || [])].filter(isVoice);
  const sum = (parts) => parts.reduce((s, [, n]) => s + n, 0);
  // A colony and its own suzerain, either way round.
  const suzerainOf = (id) => { const s = w.table?.polityById?.get(id)?.suzerain; return s ? voiceOf(w, s) : null; };
  const ruled = (x, y) => suzerainOf(x) === y || suzerainOf(y) === x;
  // History views above the line: who thinks well of b, and whom b thinks well of.
  const fans = new Map(), friends = new Map();
  const keys = new Set([...t.standing.keys(), ...Object.keys(w.relationHistory || {})]);
  yield;
  // Views looked at, ten times as many to a pause.
  let looked = 0;
  for (const k of Object.keys(w.relationHistory || {})) {
    if (++looked % (TERMS_SLICE * 10) === 0) yield;
    keys.add(k.split('>').reverse().join('>'));
  }
  // Something good in either view, standing or done.
  const good = (k) => (t.standing.get(k) || []).some(([, n]) => n > 0) || Object.values(w.relationHistory?.[k] || {}).some((n) => n > 0);
  for (const k of keys) {
    if (++looked % (TERMS_SLICE * 10) === 0) yield;
    const [a, b] = k.split('>');
    if (a === b || !isVoice(a) || !isVoice(b) || (!good(k) && !good(pairKey(b, a)))) continue;
    if (++worked % TERMS_SLICE === 0) yield;
    const n = sum(historyParts(w, a, b, t));
    if (n <= FRIEND_LINE || ruled(a, b)) continue;
    if (!fans.has(b)) fans.set(b, []);
    fans.get(b).push([a, n]);
    if (!friends.has(a)) friends.set(a, []);
    friends.get(a).push([b, n]);
  }
  // Voices at war.
  const war = new Set();
  for (const [a, v] of Object.entries(w.polityValues || {})) for (const b of v.atWar || []) war.add(pairKey(voiceOf(w, a), voiceOf(w, b)));
  for (const c of voices) {
    const drops = new Map();
    for (const b of voices) {
      if (b === c || (!fans.has(b) && !friends.has(b))) continue;
      // How much of an enemy b is: half at the line, all of it at -100 or at war.
      let weight = 0;
      if (war.has(pairKey(c, b))) weight = 1;
      else {
        if (++worked % TERMS_SLICE === 0) yield;
        const v = pairRelations(w, c, b, t)?.value;
        if (typeof v === 'number' && v <= ENEMY_LINE) weight = Math.min(1, 0.5 + 0.5 * (ENEMY_LINE - v) / (RELATIONS_RANGE + ENEMY_LINE));
      }
      if (!weight) continue;
      // A thinks well of b, in full; b thinks well of a, at a share.
      const lost = new Map();
      for (const [a, n] of fans.get(b) || []) lost.set(a, (lost.get(a) || 0) + FRIEND_RATE * (n - FRIEND_LINE));
      for (const [a, n] of friends.get(b) || []) lost.set(a, (lost.get(a) || 0) + FRIEND_RATE * FRIEND_GIVEN_SHARE * (n - FRIEND_LINE));
      const label = 'friend of ' + (w.table?.polityById?.get(b)?.short || b);
      for (const [a, n] of lost) {
        if (a === c || ruled(c, a)) continue;
        if (!drops.has(a)) drops.set(a, []);
        drops.get(a).push([label, Math.max(FRIEND_CAP, -n * weight)]);
      }
    }
    // The most it costs in one view, shared across its enemies.
    for (const [a, list] of drops) {
      const total = sum(list);
      const scale = total < FRIEND_TOTAL_CAP ? FRIEND_TOTAL_CAP / total : 1;
      out.set(pairKey(c, a), list.map(([label, n]) => [label, n * scale]));
    }
  }
  return out;
}

// One country's view of another, a's of b, from the positions and terms in hand.
function pairRelations(w, a, b, t = terms) {
  // Across two realms, or between a realm's member and an outsider, the realms' own views answer.
  const va = voiceOf(w, a), vb = voiceOf(w, b);
  if (va !== vb && (va !== a || vb !== b)) return pairRelations(w, va, vb, t);
  const pa = positions.get(a), pb = positions.get(b);
  if (!pa || !pb) return null;
  const distance = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
  const base = RELATIONS_BASE - distance * RELATIONS_PER_DISTANCE;
  const parts = [...historyParts(w, a, b, t), ...(t.friends.get(pairKey(a, b)) || [])];
  const before = base + parts.reduce((s, [, n]) => s + n, 0);
  // What b raised in tension, weighed more heavily the further apart the two stand.
  const weight = (RELATIONS_RANGE - before) / RELATIONS_RANGE + distance / 300;
  const charged = (t.tension.caused.get(b) || 0) * weight;
  return { value: clampRelations(before - charged), base, parts, tension: charged, distance };
}

// Every view at once, used at load.
function dailyRelations(w) {
  for (const id of w.government?.byPolity?.keys() || []) positionOf(w, id);
  refreshTerms(w);
  const ids = [...positions.keys()];
  const out = new Map();
  for (const a of ids) for (const b of ids) if (a !== b) out.set(pairKey(a, b), pairRelations(w, a, b));
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

// At a capital's midnight, that country's position, its view of everyone and everyone's view of it are refreshed.
function midnightRelations(w, tick) { finish(midnightSteps(w, tick)); }

// The same in steps, the views worked out to one side and put in at the end.
function* midnightSteps(w, tick) {
  const slot = tick % TICKS_PER_DAY;
  const due = [...midnightSlots(w)].filter(([, s]) => s === slot).map(([id]) => id);
  if (!due.length) return;
  for (const id of due) { positionOf(w, id); yield; }
  const views = [];
  let worked = 0;
  for (const a of due) {
    for (const b of positions.keys()) {
      if (a === b) continue;
      if (++worked % TERMS_SLICE === 0) yield;
      const x = pairRelations(w, a, b), y = pairRelations(w, b, a);
      if (x) views.push([pairKey(a, b), x]);
      if (y) views.push([pairKey(b, a), y]);
    }
  }
  for (const [k, x] of views) live.lastRelations.set(k, x);
}

// A's view of b, from the last day's figures.
function relationsBetween(a, b) {
  return live.lastRelations?.get(pairKey(a, b)) || null;
}

// A held policy's or decree's effects.
const policyEffects = (w, x) => (x?.decree ? w.government?.decrees?.decrees : w.government?.policies?.policies)?.find((q) => q.name === nameOf(x))?.effects || {};
// Policies and decrees that may turn their holder's own view, running now.
const ownViewHeld = (gov) => [...(gov.policies || []), ...(gov.decrees || []).filter((x) => x?.decree && !x.expired)];

// Improve relations actions running now.
const improving = (w) => (w.government?.relations?.relations || []).filter((x) => x.band === 'improving');

// Guarantees holding now: records in the relations file and those spirits grant.
const guarantees = (w) => (w.government?.relations?.relations || []).filter((x) => x.band === 'guarantee').concat(spiritGuarantees(w));

// Guarantees a country's spirits grant, as relation records; every country's without one named.
function spiritGuarantees(w, polityId = null) {
  const held = w.government?.byPolity;
  if (!held) return [];
  // Spirit guarantees given up by a refusal.
  const lost = new Set((w.government?.relations?.relations || []).filter((x) => x.band === 'guaranteeLost').map((x) => x.first + '>' + x.second));
  const out = [];
  for (const [id, gov] of held) {
    for (const name of gov?.spirits || []) {
      const v = spiritById(w, name)?.effects?.guaranteedBy;
      if (!v || typeof v.polity !== 'string' || v.polity === id) continue;
      if (Array.isArray(v.whileForm) && !v.whileForm.includes(gov.form)) continue;
      if (v.whileIndependent && w.table?.polityById?.get(id)?.suzerain) continue;
      const halves = (w.government?.spirits?.spirits || [])
        .filter((s) => s.effects?.guarantees?.spirit === name).map((s) => s.id || s.name);
      if (halves.length && !halves.some((e) => held.get(v.polity)?.spirits?.includes(e))) continue;
      if (polityId && id !== polityId && v.polity !== polityId) continue;
      if (lost.has(v.polity + '>' + id)) continue;
      out.push({ band: 'guarantee', first: v.polity, second: id, spirit: name });
    }
  }
  return out;
}

// A guarantor refuses to join a war on a country it guarantees: that country takes the cost, every other it guarantees a quarter, and all its guarantees go.
function refuseGuarantee(w, guarantor, guaranteed) {
  const g = w.government?.relations;
  const held = guarantees(w).filter((x) => x.first === guarantor);
  if (!held.some((x) => x.second === guaranteed)) return false;
  if (g) {
    g.relations = g.relations.filter((x) => !(x.band === 'guarantee' && x.first === guarantor));
    for (const x of held) if (x.spirit) g.relations.push({ band: 'guaranteeLost', first: guarantor, second: x.second });
  }
  const history = w.relationHistory || (w.relationHistory = {});
  const label = 'guarantee refused by ' + (w.table?.polityById?.get(guarantor)?.short || guarantor);
  for (const id of new Set(held.map((x) => x.second))) {
    const bag = (history[voicedKey(w, id, guarantor)] ||= {});
    bag[label] = (bag[label] || 0) + GUARANTEE_REFUSAL * (id === guaranteed ? 1 : GIVER_SHARE);
  }
  return true;
}

// Levels built by development aid, each record a builder, host, province and kind.
const aidRecords = (w) => (w.government?.relations?.relations || []).filter((x) => x.band === 'developmentAid');

// A policy turning its holder's own view of its target: +1 for, -1 against.
const towardSign = (x) => (x?.toward === 'for' ? 1 : -1);
// The same policy as its target sees it: "propaganda by Vosennac".
const seenLabel = (w, x, id) => nameOf(x).toLowerCase() + ' by ' + (w.table?.polityById?.get(id)?.short || id);
// An act's name in its own-view label, a trailing target token dropped: "stance" for "Stance on POLITY_NAME".
const ownViewName = (name) => name.replace(/ \w+ POLITY_NAME$/, '').toLowerCase();
const ownViewLabel = (w, x) => ownViewName(nameOf(x)) + (towardSign(x) > 0 ? ' for ' : ' against ') + (w.table?.polityById?.get(x.target)?.short || x.target);
// Policy and decree names that turn their holder's own view of their target.
const ownViewPolicies = (w) => [...(w.government?.policies?.policies || []), ...(w.government?.decrees?.decrees || [])]
  .filter((p) => p.effects?.ownViewOfTargetPerDay).map((p) => ownViewName(p.name));

// Labels of what a giver builds in another's view: improve relations, agreements, guarantees, and policies that build relations.
let givenWorld = null, givenSet = null;
// How a giver's label names the other, where not "to".
const GIVEN_JOIN = { guarantee: ' of ' };
function givenLabels(w) {
  if (givenWorld === w) return givenSet;
  givenSet = new Set(['improve relations', 'lend lease', 'state agreement', 'development aid', 'guarantee']);
  for (const p of w.government?.policies?.policies || []) if (p.effects?.relationsWithTargetPerDay) givenSet.add(p.name.toLowerCase());
  givenWorld = w;
  return givenSet;
}

// What improve relations builds a day: faster the better the improving country thinks of the other, its own share left out.
function improveRate(w, a, b, t = terms) {
  const own = pairRelations(w, a, b, t);
  const view = own.value - own.parts.filter(([l]) => l.startsWith('improve relations to ')).reduce((s, [, n]) => s + n, 0);
  return Math.min(IMPROVE_RATE_MAX, Math.max(IMPROVE_RATE_MIN, IMPROVE_PER_DAY * (1 + view / 100)));
}

// Running policies and actions build history a little each day, to their ceiling.
function growHistory(w) { finish(historySteps(w)); }

// Tariffs read, and views faded, between pauses of the daily history.
const HISTORY_SLICE = 1000;

// The same in steps, what fades worked out to one side and put in at the end.
function* historySteps(w) {
  const g = w.government;
  const history = w.relationHistory || (w.relationHistory = {});
  // Labels of every running source, and those that ran today.
  const running = givenLabels(w);
  const ran = new Set();
  // Tariffs, in the taxed country's view of the levier, by the highest rate levied on it; a voiced pair counts once at its highest.
  const levied = new Map();
  let worked = 0;
  for (const [by, taxed, rate] of yield* highestTariffSteps(w)) {
    if (++worked % HISTORY_SLICE === 0) yield;
    const k = voicedKey(w, taxed, by);
    const voice = k.slice(k.indexOf('>') + 1);
    const label = TARIFF_LABEL + (w.table?.polityById?.get(voice)?.short || voice);
    const at = k + '|' + label;
    if (!levied.has(at) || levied.get(at)[2] < rate) levied.set(at, [k, label, rate]);
  }
  // What is given lands in the receiver's view of the giver.
  for (const x of improving(w)) {
    const k = voicedKey(w, x.second, x.first);
    const bag = (history[k] ||= {});
    bag['improve relations'] = Math.min(IMPROVE_CEILING, (bag['improve relations'] || 0) + improveRate(w, x.first, x.second));
    ran.add(k + '|improve relations');
  }
  yield;
  // State agreements build relations while they run; a pair counts once for each kind however much is sent.
  const supplying = new Set();
  for (const x of activeAgreements(w)) {
    const k = voicedKey(w, x.second, x.first);
    const label = agreementLabel(x);
    if (supplying.has(k + '|' + label)) continue;
    supplying.add(k + '|' + label);
    ran.add(k + '|' + label);
    const bag = (history[k] ||= {});
    const share = agreementShare(w, x);
    bag[label] = Math.min(agreementCeiling(x) * share, (bag[label] || 0) + AGREEMENT_PER_DAY * share);
  }
  // A guarantee builds in the guaranteed country's view while it holds; a pair counts once however it is held.
  for (const x of guarantees(w)) {
    const k = voicedKey(w, x.second, x.first);
    if (ran.has(k + '|guarantee')) continue;
    ran.add(k + '|guarantee');
    const bag = (history[k] ||= {});
    bag.guarantee = Math.min(GUARANTEE_CEILING, (bag.guarantee || 0) + GUARANTEE_PER_DAY);
  }
  // Development aid kept up abroad, by level, in the host's view of the builder; a suzerain in its own colony gains nothing.
  const aided = new Map();
  for (const x of aidRecords(w)) {
    if (!x.levels || colonyHolder(w, x.second) === x.first) continue;
    const k = voicedKey(w, x.second, x.first);
    aided.set(k, (aided.get(k) || 0) + x.levels);
  }
  for (const [k, n] of aided) {
    const bag = (history[k] ||= {});
    bag['development aid'] = Math.max(Math.min(AID_CEILING, AID_PER_LEVEL * n), (bag['development aid'] || 0) - RUNNING_FADE);
    ran.add(k + '|development aid');
  }
  // The tariffs levied.
  for (const [at, [k, label, rate]] of levied) {
    if (++worked % HISTORY_SLICE === 0) yield;
    const bag = (history[k] ||= {});
    bag[label] = Math.max(TARIFF_CAP, (bag[label] || 0) + TARIFF_PER_TENTH * rate * 10);
    ran.add(at);
  }
  yield;
  for (const [id, gov] of g?.byPolity || []) {
    // Policies that build relations with their target while they run.
    for (const x of gov.policies || []) {
      const e = policyEffects(w, x);
      const target = typeof x === 'object' ? x.target : null;
      if (!e.relationsWithTargetPerDay || !target || target === id) continue;
      const k = voicedKey(w, target, id);
      const bag = history[k] || (history[k] = {});
      const label = nameOf(x).toLowerCase();
      bag[label] = Math.min(e.relationsWithTargetCeiling ?? Infinity, (bag[label] || 0) + e.relationsWithTargetPerDay);
      ran.add(k + '|' + label);
    }
    // Policies and decrees that turn the holder's own view of their target while they run.
    for (const x of ownViewHeld(gov)) {
      const e = policyEffects(w, x);
      const target = typeof x === 'object' ? x.target : null;
      if (!e.ownViewOfTargetPerDay || !target || target === id) continue;
      const k = voicedKey(w, id, target);
      const bag = history[k] || (history[k] = {});
      const label = ownViewLabel(w, x);
      const ceiling = e.ownViewOfTargetCeiling ?? Infinity;
      bag[label] = towardSign(x) * Math.min(ceiling, Math.abs(bag[label] || 0) + e.ownViewOfTargetPerDay);
      ran.add(k + '|' + label);
      // The target sees it too, in its view of the holder.
      if (e.targetViewPerDay) {
        const tk = voicedKey(w, target, id);
        const tbag = history[tk] || (history[tk] = {});
        const seen = seenLabel(w, x, id);
        tbag[seen] = towardSign(x) * Math.min(e.targetViewCeiling ?? Infinity, Math.abs(tbag[seen] || 0) + e.targetViewPerDay);
        ran.add(tk + '|' + seen);
      }
    }
  }
  yield;
  const turning = ownViewPolicies(w);
  const isRunning = (label) => running.has(label) || label.startsWith(TARIFF_LABEL) || turning.some((p) => label.startsWith(p + ' for ') || label.startsWith(p + ' against ') || label.startsWith(p + ' by '));
  // A grudge fades once the war is over.
  const fighting = new Set();
  for (const [a, v] of Object.entries(w.polityValues || {})) for (const b of v.atWar || []) for (const k of bothKeys(w, a, b)) fighting.add(k);
  const allied = alliedInWar(w);
  yield;
  // Faded figures as [bag, label, figure], an empty figure for one gone, put in at the end.
  const faded = [];
  for (const [k, bag] of Object.entries(history)) {
    if (++worked % HISTORY_SLICE === 0) yield;
    // The bag's figures as faded so far.
    let now = null;
    const at = (label) => (now?.has(label) ? now.get(label) : bag[label]);
    const put = (label, n) => (now ||= new Map()).set(label, n || undefined);
    const gone = (label) => now?.has(label) && now.get(label) === undefined;
    if (at('war') !== undefined && !fighting.has(k)) put('war', Math.min(0, at('war') + WAR_RECOVERY));
    // A denunciation, a refused guarantee or an ended act's grudge fades a little faster than trust.
    for (const label of Object.keys(bag)) {
      if (gone(label) || (!label.startsWith('denounced by ') && !label.startsWith('guarantee refused by ') && !label.endsWith(ENDED))) continue;
      put(label, Math.min(0, at(label) + DENOUNCE_FADE));
    }
    // A running source that has stopped fades.
    for (const label of Object.keys(bag)) {
      if (gone(label) || !isRunning(label) || ran.has(k + '|' + label)) continue;
      const n = at(label);
      put(label, n > 0 ? Math.max(0, n - RUNNING_FADE) : Math.min(0, n + RUNNING_FADE));
    }
    // Trust fades faster than distrust.
    if (at('brothers in arms') !== undefined && !allied.has(k)) put('brothers in arms', Math.max(0, at('brothers in arms') - ARMS_FADE));
    for (const [label, n] of now || []) faded.push([bag, label, n]);
  }
  for (const [bag, label, n] of faded) {
    if (n === undefined) delete bag[label];
    else bag[label] = n;
  }
  for (const e of w.tension?.events || []) e.amount = Math.max(0, e.amount - TENSION_DECAY);
  if (w.tension) w.tension.events = w.tension.events.filter((e) => e.amount > 0);
}

// Last day's view of every country by every other, read by the console and, later, by trade and diplomacy.
live.lastRelations = new Map();
everyDay(function* (w) { yield* historySteps(w); yield; yield* termSteps(w); });
everyTick(midnightSteps);

export { TARIFF_PER_TENTH, TARIFF_CAP, TARIFF_LABEL, AGREEMENT_FULL_POINTS, goodPoints, agreementShare, IMPROVE_RATE_MIN, IMPROVE_RATE_MAX, improveRate, FRIEND_LINE, ENEMY_LINE, FRIEND_RATE, FRIEND_GIVEN_SHARE, FRIEND_CAP, FRIEND_TOTAL_CAP, friendParts, historyParts, GUARANTEE_PER_DAY, GUARANTEE_CEILING, GUARANTEE_REFUSAL, guarantees, spiritGuarantees, refuseGuarantee, AID_PER_LEVEL, AID_CEILING, aidRecords, RUNNING_FADE, ARMS_RELATIONS, ARMS_FADE, DENOUNCE_RELATIONS, DENOUNCE_FADE, SANCTION_RELATIONS, PACT_RELATIONS, VOLUNTEER_RELATIONS, VOLUNTEER_GRATITUDE, AGREEMENT_PER_DAY, LEND_LEASE_CEILING, AGREEMENT_CEILING, armsSince, alliedInWar, SAME_REALM, voiceOf, voicedKey, IMPROVE_PER_DAY, IMPROVE_CEILING, GIVER_SHARE, CLAIMANT_SHARE, givenLabels, bothKeys, improving, CLAIM_RELATIONS, CLAIM_CAP, OCCUPIED_RELATIONS, OCCUPIED_CAP, towardSign, ownViewLabel, WAR_RELATIONS, WAR_RECOVERY, pastWarHistory, warHistory, RELATIONS_BASE, RELATIONS_PER_DISTANCE, RELATIONS_RANGE, OCCUPATION_TENSION, TENSION_DECAY, TENSION_CAP, pairKey, standingParts, tensionOf, refreshTerms, pairRelations, dailyRelations, midnightSlots, midnightRelations, midnightSteps, relationsBetween, growHistory, HISTORY_SLICE, historySteps, TERMS_SLICE, termSteps, friendSteps };
