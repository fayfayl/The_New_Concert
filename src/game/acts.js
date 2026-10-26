// Acts over time and who may take them: policies coming on and going off, decrees that run out, what ends what, law ceilings and prospecting.

const VERSION = new URL(import.meta.url).search;
const { clock, everyDay, invalidateView, worldChanged } = await import(`../core/core.js${VERSION}`);
const { actKey, industryKind, nameOf } = await import(`./government.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let aidRecords, colonyHolder, heldIdeology, occupiedFraction, partiesOf, spiritById;
export function link(all) { ({ aidRecords, colonyHolder, heldIdeology, occupiedFraction, partiesOf, spiritById } = all); }

// A policy cancelled may be started again after this many days.
const RESTART_DAYS = 30;

const tableOf = (w, kind) => (kind === 'policy' ? w.government?.policies : w.government?.decrees);
const actOf = (w, kind, name) => tableOf(w, kind)?.[kind === 'policy' ? 'policies' : 'decrees']?.find((a) => a.name === name) || null;
const kindOf = (x) => (x?.policy ? 'policy' : 'decree');

// Days an act takes to come on and to go off.
function timingOf(w, kind, act) {
  const t = tableOf(w, kind)?.timing || {};
  return { ramp: act?.ramp ?? t.ramp ?? 0, fade: act?.fade ?? t.fade ?? 0 };
}

// Days a duration decree held at the start has left, spread by a hash of the holder and the decree.
function startingDaysLeft(id, x, act) {
  let h = 2166136261;
  for (const c of id + '|' + actKey(x)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Math.max(1, Math.round(((h >>> 0) / 4294967296) * act.durationDays));
}

// A held act starting today, coming on over its ramp; toward is "for" or "against" its target.
function startAct(w, kind, name, target, toward) {
  const act = actOf(w, kind, name);
  const { ramp } = timingOf(w, kind, act);
  const x = { [kind]: name, since: clock.day, strength: ramp ? 0 : 1 };
  if (target !== undefined) x.target = target;
  if (toward !== undefined) x.toward = toward;
  // A duration decree runs its full term.
  if (kind === 'decree' && act?.durationDays) x.daysLeft = act.durationDays;
  return x;
}

// An act leaving, kept to go off over its fade; except names effects that stay.
function fadeAct(w, gov, x, except = null) {
  const kind = kindOf(x);
  const name = nameOf(x);
  const { fade } = timingOf(w, kind, actOf(w, kind, name));
  const out = { [kind]: name, ended: clock.day, from: x?.strength ?? 1, fade, strength: fade ? (x?.strength ?? 1) : 0 };
  if (x?.target !== undefined && x?.target !== null) out.target = x.target;
  if (except?.length) out.except = except;
  gov.fading = [...(gov.fading || []), out];
}

// Days until a cancelled policy may start again, or 0.
function restartWait(gov, kind, name, target) {
  const key = name + '|' + (target ?? '');
  const last = (gov.fading || []).filter((f) => kindOf(f) === kind && actKey(f) === key).map((f) => f.ended);
  if (kind !== 'policy' || !last.length) return 0;
  return Math.max(0, RESTART_DAYS - (clock.day - Math.max(...last)));
}

// Enacting a decree ends what it names and the spirits it names by tag; a decree that only ends another is then done.
function endsWithDecree(w, gov, act, target) {
  // Aimed at every ideology, it replaces the same decree aimed at one.
  if (target === 'all' && act?.target === 'ideology') {
    const narrow = (y) => nameOf(y) === act.name && y?.target !== undefined && y?.target !== null && y?.target !== 'all';
    for (const y of (gov.decrees || []).filter(narrow)) fadeAct(w, gov, y);
    gov.decrees = (gov.decrees || []).filter((y) => !narrow(y));
  }
  if (act?.ends) {
    const same = (y) => nameOf(y) === act.ends && (target === undefined || target === null || target === 'all' || y?.target === undefined || y?.target === target);
    for (const y of (gov.decrees || []).filter(same)) fadeAct(w, gov, y);
    gov.decrees = (gov.decrees || []).filter((y) => !same(y) && nameOf(y) !== act.name);
  }
  if (act?.endsSpiritTag) {
    gov.spirits = (gov.spirits || []).filter((id) => !(spiritById(w, id)?.tags || []).includes(act.endsSpiritTag));
  }
}

// Prospecting: a share of the resource's unprospected deposits in ground the country controls becomes known.
function prospect(w, id, gov, kind, rule) {
  const done = (gov.surveyed ||= {});
  const [lo, hi] = done[kind] ? rule.again : rule.first;
  done[kind] = (done[kind] || 0) + 1;
  const share = lo + Math.random() * (hi - lo);
  for (const p of w.table?.provinces || []) {
    if (p.owner !== id || (p.occupier && p.occupier !== id && occupiedFraction(w, p) > 0)) continue;
    const held = w.resources?.[p.id];
    const un = held?.unprospected;
    if (!un) continue;
    if (un[kind] && Math.random() < share) {
      held[kind] = (held[kind] || 0) + un[kind];
      delete un[kind];
    }
    // Found under water, it is seen and still out of reach.
    if (un.offshore?.[kind] && Math.random() < share) {
      held.offshore = { ...(held.offshore || {}), [kind]: (held.offshore?.[kind] || 0) + un.offshore[kind] };
      delete un.offshore[kind];
      if (!Object.keys(un.offshore).length) delete un.offshore;
    }
    if (!Object.keys(un).length) delete held.unprospected;
  }
}

// A duration decree running out: it pays out, then keeps what is permanent or is gone.
function completeDecree(w, id, gov, x, act) {
  const reveal = act.effects?.revealsUnprospected;
  if (reveal && x.target) prospect(w, id, gov, x.target, reveal);
  if (act.thenPermanent) {
    fadeAct(w, gov, x, act.permanent || []);
    x.expired = true;
    delete x.daysLeft;
  } else {
    fadeAct(w, gov, x);
    gov.decrees = gov.decrees.filter((y) => y !== x);
  }
}

// Each day: acts come on, duration decrees count down, departed acts go off.
function dailyActs(w) {
  let changed = false;
  for (const [id, gov] of w.government?.byPolity || []) {
    for (const field of ['policies', 'decrees']) {
      const kind = field === 'policies' ? 'policy' : 'decree';
      const held = gov[field] || [];
      for (let i = 0; i < held.length; i++) {
        let x = held[i];
        const act = actOf(w, kind, nameOf(x));
        if (!act) continue;
        if (x?.since !== undefined && (x.strength ?? 1) < 1) {
          const { ramp } = timingOf(w, kind, act);
          x.strength = ramp ? Math.min(1, (clock.day - x.since) / ramp) : 1;
          changed = true;
        }
        if (kind === 'decree' && act.durationDays && !x?.expired) {
          if (typeof x === 'string') x = held[i] = { decree: x };
          x.daysLeft = (x.daysLeft ?? startingDaysLeft(id, x, act)) - 1;
          if (x.daysLeft <= 0) { completeDecree(w, id, gov, x, act); changed = true; }
        }
      }
    }
    if (gov.fading?.length) {
      for (const f of gov.fading) f.strength = f.fade ? Math.max(0, f.from * (1 - (clock.day - f.ended) / f.fade)) : 0;
      // Kept until gone and past the wait to restart.
      gov.fading = gov.fading.filter((f) => f.strength > 0 || clock.day - f.ended < RESTART_DAYS);
      changed = true;
    }
  }
  if (changed) { worldChanged(); invalidateView(); }
}
everyDay(dailyActs);

// The highest option a country's spirits allow in a law category, or null.
function lawCeilingOf(w, id, category, above = null) {
  const g = w.government;
  const options = g?.laws?.categories?.[category]?.options?.map((o) => o.name) || [];
  let at = null;
  for (const holder of [above, g?.byPolity?.get(id)]) {
    for (const sid of holder?.spirits || []) {
      const cap = spiritById(w, sid)?.effects?.lawCeiling?.[category];
      const i = options.indexOf(cap);
      if (i >= 0 && (at === null || i < at)) at = i;
    }
  }
  return at === null ? null : options[at];
}

// Development aid records on an infrastructure target: one kind in one province, kept up.
const aidOn = (w, target) => aidRecords(w).filter((x) => x.levels > 0 && x.province === target?.province && x.infrastructure === target?.infrastructure);

// Decrees moving the upkeep of development aid.
const HAND_OVER = 'Hand over INFRASTRUCTURE_NAME infrastructure in PROVINCE_NAME';
const TAKE_OVER = 'Take over INFRASTRUCTURE_NAME infrastructure in PROVINCE_NAME';
const REQUEST_HAND_OVER = 'Request hand over of INFRASTRUCTURE_NAME infrastructure in PROVINCE_NAME';

// Clears a builder's record of one kind in one province; the upkeep falls to the host.
function clearAid(w, builder, target) {
  const table = w.government?.relations;
  if (!table) return;
  table.relations = table.relations.filter((x) => !(x.band === 'developmentAid' && x.first === builder
    && x.province === target.province && x.infrastructure === target.infrastructure));
}

// An infrastructure decree just enacted: hand over, take over, or ask the builder.
function enactInfrastructure(w, id, x) {
  const name = nameOf(x);
  if (![HAND_OVER, TAKE_OVER, REQUEST_HAND_OVER].includes(name) || !x?.target) return;
  if (name === HAND_OVER) return clearAid(w, id, x.target);
  const builders = [...new Set(aidOn(w, x.target).filter((y) => y.first !== id).map((y) => y.first))];
  const builder = x.target.builder || builders[0];
  if (!x.target.builder && builders.length > 1) throw new Error(`name the builder: ${builders.join(', ')}`);
  x.target = { ...x.target, builder };
  if (name === TAKE_OVER) return clearAid(w, builder, x.target);
  x.answer = 'accepted';
  clearAid(w, builder, x.target);
}

// Whether one availability condition holds for a country and a target.
function conditionHolds(w, id, key, value, target) {
  const g = w.government;
  const gov = g?.byPolity?.get(id) || {};
  const v = w.polityValues?.[id] || {};
  const provinces = w.table?.provinces || [];
  const spiritTags = (gov.spirits || []).flatMap((s) => spiritById(w, s)?.tags || []);
  switch (key) {
    case 'polity': return value.includes(id);
    case 'form': return value.includes(gov.form);
    case 'atWar': return Boolean(v.atWar?.length) === value;
    case 'elections': {
      const own = gov.elections ?? g?.ideologies?.forms?.find((f) => f.name === gov.form)?.elections ?? false;
      return own === value;
    }
    case 'colonies': return [...(w.table?.polityById?.values() || [])].some((q) => colonyHolder(w, q.id) === id) === value;
    case 'treatyTerm': return partiesOf(w).some((p) => (p.on || []).includes(id) && p.terms?.[value]);
    case 'targetAtWar': return (v.atWar || []).includes(target) === value;
    case 'targetNeighbour': {
      const theirs = new Set(provinces.filter((p) => p.owner === target).map((p) => p.id));
      const touches = provinces.some((p) => p.owner === id && [...(w.adjacency?.get(p.id) || [])].some((q) => theirs.has(q)));
      return touches === value;
    }
    case 'afterDecree': return (gov.decrees || []).some((d) => value.includes(nameOf(d)) && !d?.expired
      && (target === undefined || target === null || d?.target === undefined || d?.target === target));
    case 'unprospected': return provinces.some((p) => p.owner === id
      && (w.resources?.[p.id]?.unprospected?.[target] || w.resources?.[p.id]?.unprospected?.offshore?.[target])) === value;
    case 'economicBelow': return (heldIdeology(w, id)?.economic ?? Infinity) < value;
    case 'spiritTag': return spiritTags.includes(value);
    case 'targetIndustry': return industryKind(target) === value;
    case 'targetStateOwned': return (gov.stateOwned || []).includes(target) === value;
    case 'occupation': return provinces.some((p) => p.occupier === id && occupiedFraction(w, p) > 0) === value;
    case 'targetInfrastructure': return aidOn(w, target).some((x) => x.first === id) === value;
    case 'targetForeignInfrastructure': return (w.byId?.get(target?.province)?.owner === id
      && aidOn(w, target).some((x) => x.first !== id && (!target?.builder || x.first === target.builder))) === value;
    default: return false;
  }
}

// A block of conditions: all must hold; `unless` bars where every condition in any of its blocks holds.
function blockHolds(w, id, block, target) {
  return Object.entries(block).every(([k, val]) => k === 'unless' || conditionHolds(w, id, k, val, target));
}

// Why a country may not take an act, or null where it may.
function unavailable(w, id, kind, act, target) {
  const av = act?.available;
  // "any" or nothing: open to every country.
  if (!av || typeof av !== 'object') return null;
  if (!blockHolds(w, id, av, target)) {
    const failed = Object.entries(av).filter(([k, val]) => k !== 'unless' && !conditionHolds(w, id, k, val, target)).map(([k]) => k);
    return `${act.name} needs ${failed.join(', ')}`;
  }
  const bars = av.unless ? (Array.isArray(av.unless) ? av.unless : [av.unless]) : [];
  const barred = bars.find((b) => blockHolds(w, id, b, target));
  return barred ? `${act.name} is barred by ${Object.keys(barred).join(', ')}` : null;
}

export { HAND_OVER, TAKE_OVER, REQUEST_HAND_OVER, clearAid, enactInfrastructure, RESTART_DAYS, timingOf, startingDaysLeft, startAct, fadeAct, restartWait, endsWithDecree, prospect, completeDecree, dailyActs, lawCeilingOf, conditionHolds, unavailable };
