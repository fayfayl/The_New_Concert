// Province figures: happiness, unrest, development and what spirits and acts do there.

const VERSION = new URL(import.meta.url).search;
const { UNOWNED, isOccupied, realmOf } = await import(`../world/mapdata.js${VERSION}`);
const { UNALIGNED, actEffects, heldActs, dugDeposits, feltFor, industryShares, miningShare, nameOf, spreadByWeight, spreadOverProvinces, supportHappiness, urbanisation } = await import(`./government.js${VERSION}`);
const { CLOCK_EPOCH, DAY_MS, deriveOnChange, everyDay, forgetOnChange, state } = await import(`../core/core.js${VERSION}`);
const { clamp } = await import(`../render/view.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let colonyHolder, demonymOf, fillTokens, foodHappiness, governmentPosition, nationalModifier, nationalParts, polityOf, stabilityOf, updateCard;
export function link(all) { ({ colonyHolder, demonymOf, fillTokens, foodHappiness, governmentPosition, nationalModifier, nationalParts, polityOf, stabilityOf, updateCard } = all); }

// The province card: what a province has.
// Happiness and unrest: happiness is derived, unrest is stored.
const HAPPINESS_BASE = 50;
const UNREST_THRESHOLD = 20;      // 30 while the country is under strain
const UNREST_DECAY = 2;           // a day, wherever nothing is pressing

// Share of a province's counties carrying rail, 0 to 1; cached per world.
let railCache = null, railCacheWorld = null;
forgetOnChange(() => { railCacheWorld = null; });

// Whether a province is in the national economy: road or cross-border rail.
let railToCapital = null, railToCapitalWorld = null;
forgetOnChange(() => { railToCapitalWorld = null; });

// Provinces whose railways reach their own capital in-country.
function railsReachingTheCapital(w) {
  if (railToCapitalWorld === w) return railToCapital;
  railToCapital = new Set();
  const counties = [...w.counties.byId.values()];
  const provinceOf = new Map(counties.map((c) => [c.id, c.province]));
  const ownerOf = (pid) => w.byId?.get(pid)?.owner;

  const capitalProvince = new Map();
  for (const c of (w.cities || [])) {
    if (!c.capital) continue;
    const o = ownerOf(c.province);
    if (o !== undefined) capitalProvince.set(o, c.province);
  }

  const seen = new Set();
  for (const c of counties) {
    if (seen.has(c.id) || c.rail === undefined) continue;
    const home = ownerOf(provinceOf.get(c.id));
    const part = [];
    const queue = [c.id];
    seen.add(c.id);
    let touchesCapital = false;
    while (queue.length) {
      const id = queue.shift();
      const pid = provinceOf.get(id);
      part.push(pid);
      if (capitalProvince.get(home) === pid) touchesCapital = true;
      for (const other of (Array.isArray(w.counties.byId.get(id)?.rail) ? w.counties.byId.get(id).rail : [])) {
        if (seen.has(other)) continue;
        const there = provinceOf.get(other);
        if (there === undefined || ownerOf(there) !== home) continue;   // the line leaves the country
        seen.add(other);
        queue.push(other);
      }
    }
    if (touchesCapital) for (const pid of part) railToCapital.add(pid);
  }
  railToCapitalWorld = w;
  return railToCapital;
}

function connectedOf(w, p) {
  if (!w?.counties?.byId || !p) return true;
  if (builtLevel(w.stats?.[p.id] || {}, 'road') >= 1) return true;
  return railsReachingTheCapital(w).has(p.id);
}

function railShare(w, p) {
  if (!w?.counties?.byId || !p) return 0;
  if (railCacheWorld !== w) {
    railCache = new Map();
    for (const c of w.counties.byId.values()) {
      const id = c.province;
      if (id === undefined) continue;
      const t = railCache.get(id) || { n: 0, railed: 0 };
      t.n++;
      if (c.rail !== undefined) t.railed++;
      railCache.set(id, t);
    }
    railCacheWorld = w;
  }
  const t = railCache.get(p.id);
  return t && t.n ? t.railed / t.n : 0;
}

// Fraction of a province's counties held by anyone but the owner.
function occupiedFraction(w, p) { return p.occupied ?? (isOccupied(p) ? 1 : 0); }

// True while the province's owner is at war.
export function ownerAtWar(w, p) {
  return (w?.polityValues?.[p?.owner]?.atWar?.length ?? 0) > 0;
}

// How far an occupied population sides with its occupier, 0 to 1.
export function collaborationOf(w, p, stats, baseHappiness) {
  if (!p?.occupier) return 0;
  const claimed = (stats.claims || []).includes(p.occupier) ? 1 : 0;
  const ideology = 0;
  return clamp(0.5 * claimed + 0.4 * (1 - baseHappiness / 100) + ideology, 0, 1);
}

// Cap and per-strike happiness cost for fought-over ground.
const STRUCK_CAP = 5;
const STRUCK_HAPPINESS = 3;

// A province's war weariness weight: 1 plus its factories.
function wearinessWeight(stats) {
  return 1 + (stats.civilianFactories || 0) + (stats.militaryFactories || 0);
}

// Happiness lost to what happened on this ground, whatever the nation feels.
function struckOf(stats) {
  return STRUCK_HAPPINESS * Math.min(STRUCK_CAP, stats.struckAverage || 0);
}

// Writes each province's urbanisation and livelihood onto its stats.
function provinceTraits(world) {
  if (!world?.stats) return;
  const towned = new Set((world.cities || []).map((c) => c.province));
  for (const [id, e] of Object.entries(world.stats)) {
    const p = world.byId.get(id);
    e.urbanisation = p ? urbanisation({
      population: e.population, area: p.area,
      factories: (e.civilianFactories || 0) + (e.militaryFactories || 0),
      hasCity: towned.has(id),
    }) : 0;
    e.mining = miningShare(world.resources?.[id]);
  }
}
deriveOnChange((w) => provinceTraits(w));

// Mean weariness weight across a polity's ground, cached per polity.
forgetOnChange((w) => w.wearinessMeans?.clear());
function wearinessMean(w, owner) {
  if (!w?.wearinessMeans || !w.stats) return 0;
  if (w.wearinessMeans.has(owner)) return w.wearinessMeans.get(owner);
  let sum = 0, n = 0;
  for (const q of w.table.provinces) {
    if (q.owner !== owner) continue;
    sum += wearinessWeight(w.stats[q.id] || {});
    n++;
  }
  const mean = n ? sum / n : 0;
  w.wearinessMeans.set(owner, mean);
  return mean;
}

// Happiness lost to war weariness in this province, 0 to WEARINESS_CAP.
const WEARINESS_CAP = 30;
function wearinessOf(w, p, stats) {
  const weariness = w?.polityValues?.[p?.owner]?.weariness || 0;
  if (!weariness) return 0;
  const mean = wearinessMean(w, p.owner);
  if (!mean) return 0;
  return Math.min(WEARINESS_CAP, weariness * wearinessWeight(stats) / mean);
}

// Unsettled share of a recent annexation, 1 falling to 0 over 180 days.
function unsettledShare(stats, today) {
  if (!stats.annexedOn || !today) return 0;
  const days = (today - new Date(stats.annexedOn)) / 86400000;
  return days >= 0 && days < 180 ? 1 - days / 180 : 0;
}

// Share of a province's deposits actually worked, 0 to 1.
function developmentOf(w, p, stats) {
  const share = (built, max) => (max > 0 ? built / max : 0);
  return 0.4 * share(builtLevel(stats, 'road'), (stats.road || [0, 0])[1])
    + 0.3 * share(builtLevel(stats, 'electricity'), (stats.electricity || [0, 0])[1])
    + 0.3 * railShare(w, p);
}

// Deposit development share for coal and natural gas pits.
function developmentPitOf(w, p, stats) {
  const share = (built, max) => (max > 0 ? built / max : 0);
  return Math.min(1, 0.3 * share(builtLevel(stats, 'road'), (stats.road || [0, 0])[1])
    + 0.5 * share(builtLevel(stats, 'electricity'), (stats.electricity || [0, 0])[1])
    + 0.3 * railShare(w, p));
}

// The built half of a [built, max] pair.
const builtLevel = (stats, key) => (Array.isArray(stats[key]) ? stats[key][0] : Number(stats[key])) || 0;

function unlockedSlots(maximum, road, electricity, railedShare) {
  if (!maximum) return 0;
  const share = 0.3 + 0.6 * ((road + electricity) / 20);
  return Math.min(maximum, Math.ceil(maximum * share) + (railedShare >= 0.5 ? 1 : 0));
}

// A province's holdings of each thing an act or spirit is felt by.
function weighForSpread(w, q) {
  const st = w.stats?.[q.id] || {};
  const urban = st.urbanisation ?? 0;
  return {
    id: q.id,
    population: st.population || 0,
    urbanisation: urban,
    rural: 1 - urban,
    factories: st.civilianFactories || 0,
    dug: dugDeposits(w.resources?.[q.id]),
    industry: (st.civilianFactories || 0) + dugDeposits(w.resources?.[q.id]),
    fertileLand: w.resources?.[q.id]?.fertileLand || 0,
    mining: st.mining ?? 0,
  };
}

// Units a province holds of the deposits an act names.
function namedDeposits(w, id, named) {
  if (!named) return 0;
  const dep = w.resources?.[id] || {};
  let n = 0;
  for (const k of Object.keys(named)) if (typeof dep[k] === 'number') n += dep[k];
  return n;
}

const spiritSpreadBy = new Map();
forgetOnChange(() => spiritSpreadBy.clear());
function spiritEffect(w, p, key) {
  const owner = polityOf(w, p)?.id;
  if (!owner || !w.government?.spirits?.spirits) return [];
  const realm = realmOf(w.table, owner);
  const holders = realm === owner ? [owner] : [owner, realm];
  if (!holders.some((h) => w.government.byPolity?.get(h)?.spirits?.length)) return [];

  const at = owner + '|' + key;
  if (!spiritSpreadBy.has(at)) {
    const out = new Map();
    const bump = (id, name, n) => {
      if (!n) return;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push([name, n]);
    };
    for (const holder of holders) {
      const held = w.government.byPolity?.get(holder)?.spirits || [];
      if (!held.length) continue;
      const mine = (w.table?.provinces || [])
        .filter((q) => q.owner === holder || realmOf(w.table, q.owner) === holder)
        .map((q) => weighForSpread(w, q));
      for (const name of held) {
        const s = spiritById(w, name);
        if (!s) continue;
        if (s.effects?.[key]) {
          const reach = s.exceptProvinces?.length
            ? mine.filter((q) => !s.exceptProvinces.includes(q.id))
            : mine;
          const felt = feltFor(s, key);
          const over = felt?.by === 'resourceYield'
            ? reach.map((q) => ({ ...q, resourceYield: namedDeposits(w, q.id, s.effects.resourceYield) }))
            : reach;
          const spread = felt
            ? spreadByWeight(s.effects[key], over, felt.by, felt.spread)
            : spreadOverProvinces(s.effects[key], reach, name + '|' + key);
          for (const [id, n] of spread) bump(id, label(s), n);
        }
        const only = s.inProvinces;
        if (only?.effects?.[key]) for (const id of only.provinces || []) bump(id, label(s), only.effects[key]);
      }
    }
    spiritSpreadBy.set(at, out);
  }
  return spiritSpreadBy.get(at).get(p.id) || [];
}

// What a province card calls a spirit's contribution.
const label = (s) => s.factor || s.name;

// The ideology a province's owner holds, cached per polity.
const heldIdeologyBy = new Map();
forgetOnChange(() => heldIdeologyBy.clear());
function heldIdeology(w, id) {
  const table = w.government?.ideologies?.ideologies;
  if (!id || !table || !w.government?.byPolity?.has(id)) return null;
  if (!heldIdeologyBy.has(id)) {
    let held = null;
    try { held = table.find((i) => i.name === governmentPosition(w, id).ideology); }
    catch { held = null; }
    heldIdeologyBy.set(id, held);
  }
  return heldIdeologyBy.get(id);
}

// Province happiness from its support for the ruling ideology.
function ideologyHappiness(w, p) {
  const held = heldIdeology(w, polityOf(w, p)?.id);
  if (!held) return 0;
  return supportHappiness(w.stats?.[p.id]?.support, held.name, w.government?.ideologies);
}

// Total spirit effect on a province for one modifier.
function spiritTotal(w, p, key) {
  return spiritEffect(w, p, key).reduce((a, [, n]) => a + n, 0);
}

// Multiplier on a province's tax on the way to the treasury.
function taxMultiplier(w, p, happiness) {
  const parts = [...spiritEffect(w, p, 'taxRevenue'), ...actEffect(w, p, 'taxRevenue')];
  const mods = parts.reduce((a, [, n]) => a + n, 0);
  return { value: (0.5 + happiness / 100) * (1 + mods), parts };
}

// Deposits a polity holds, resource name to amount.
const depositsBy = new Map();
forgetOnChange(() => depositsBy.clear());
function depositsOf(w, id) {
  if (!depositsBy.has(id)) {
    const out = {};
    for (const q of w.table?.provinces || []) {
      if (q.owner !== id && realmOf(w.table, q.owner) !== id) continue;
      for (const [k, v] of Object.entries(w.resources?.[q.id] || {})) {
        if (typeof v === 'number' && v > 0) out[k] = (out[k] || 0) + v;
      }
    }
    depositsBy.set(id, out);
  }
  return depositsBy.get(id);
}

// Each movement's share of a country's support.
const nationalShareBy = new Map();
forgetOnChange(() => nationalShareBy.clear());
function nationalShares(w, id) {
  if (!nationalShareBy.has(id)) {
    const sum = {};
    let people = 0;
    for (const q of w.table?.provinces || []) {
      if (q.owner !== id && realmOf(w.table, q.owner) !== id) continue;
      const st = w.stats?.[q.id];
      const n = st?.population || 0;
      if (!st?.support) continue;
      people += n;
      for (const [k, v] of Object.entries(st.support)) sum[k] = (sum[k] || 0) + v * n;
    }
    const aligned = Object.entries(sum).reduce((a, [k, v]) => a + (k === UNALIGNED ? 0 : v), 0);
    const out = {};
    for (const [k, v] of Object.entries(sum)) if (k !== UNALIGNED) out[k] = aligned ? v / aligned : 0;
    nationalShareBy.set(id, people ? out : null);
  }
  return nationalShareBy.get(id);
}

// Share of a polity's people under enemy occupation.
function occupiedShare(w, id) {
  let held = 0, all = 0;
  for (const q of w.table?.provinces || []) {
    if (q.owner !== id) continue;
    const n = w.stats?.[q.id]?.population || 0;
    all += n;
    held += n * occupiedFraction(w, q);
  }
  return all ? held / all : 0;
}

// Share of an industry a province holds.
function industryAt(w, id, industry) {
  if (industry === 'rail') return railShare(w, { id });
  if (industry === 'manufacturing') return w.stats?.[id]?.civilianFactories || 0;
  return w.resources?.[id]?.[industry] || 0;
}

// Share of a province backing the movement an act names.
function supportFor(w, id, target) {
  const s = w.stats?.[id]?.support;
  if (!s) return 0;
  return s[target] || 0;
}

// Whether a province backs its country's held ideology most.
function governingLeads(w, p) {
  const held = heldIdeology(w, polityOf(w, p)?.id);
  const support = w.stats?.[p.id]?.support;
  if (!held || !support) return true;
  let top = null, best = -1;
  for (const [k, v] of Object.entries(support)) {
    if (k === UNALIGNED) continue;
    if (v > best) { best = v; top = k; }
  }
  return top === null || top === held.name;
}

// Looks up a spirit by its id.
function spiritById(w, id) {
  return w.government?.spirits?.spirits?.find((x) => (x.id || x.name) === id) || null;
}

// Spirit additions to the happiness multiplier on a country's own acts.
function spiritPenalty(w, id, opposed) {
  const held = w.government?.byPolity?.get(id)?.spirits || [];
  let n = 0;
  for (const name of held) {
    const sp = spiritById(w, name);
    const v = sp?.effects?.happinessPenalties;
    if (!v) continue;
    const by = sp.scaling?.happinessPenalties?.governingLeads || 0;
    n += v * (1 + by * (opposed ? 0 : 1));
  }
  return n;
}

// Occupation laws an occupier enforces over one country, as a government.
function occupationGovernment(w, occupier, subject) {
  const set = w.government?.occupation?.[occupier]?.[subject];
  const names = set?.laws || [];
  const policies = [], decrees = [];
  for (const n of names) {
    if (w.government.policies?.policies?.some((x) => x.name === nameOf(n))) policies.push(n);
    else decrees.push(n);
  }
  const stateOwned = set?.stateOwned || w.government?.byPolity?.get(subject)?.stateOwned || [];
  if (!names.length && !stateOwned.length) return null;
  return { laws: {}, policies, decrees, stateOwned };
}

const actEffectBy = new Map();
forgetOnChange(() => actEffectBy.clear());
function actEffect(w, p, key) {
  const occupied = isOccupied(p);
  const holder = polityOf(w, p)?.id;
  if (!holder) return [];
  const gov = occupied ? occupationGovernment(w, holder, p.owner)
    : w.government?.byPolity?.get(holder);
  if (!gov) return [];

  const opposed = key === 'happiness' && !occupied && !governingLeads(w, p);
  const at = holder + '|' + (occupied ? p.owner : '') + '|' + key + (opposed ? '|opposed' : '');
  if (!actEffectBy.has(at)) {
    const realm = occupied ? holder : realmOf(w.table, holder);
    const above = occupied || realm === holder ? null : w.government.byPolity.get(realm) || null;
    const atWar = (w.polityValues?.[holder]?.atWar?.length ?? 0) > 0 ? 1 : 0;
    const muffle = key !== 'happiness' || occupied ? 1
      : Math.max(0, 1 + actEffects(gov, w.government, 'happinessPenalties', { parent: above })
        .reduce((a, x) => a + x.figure, 0)
        + spiritPenalty(w, holder, opposed));
    const scale = (act) => {
      const soften = (act?.effects?.[key] || 0) < 0 ? muffle : 1;
      const by = act?.scaling?.[key];
      if (!by) return soften;
      return soften * (1 + (by.atWar || 0) * atWar) * (1 + (by.occupied || 0) * occupiedShare(w, holder));
    };
    const label = (name, target) => fillTokens(name, target, w.government, null).toLowerCase();
    const shares = industryShares(depositsOf(w, occupied ? p.owner : holder), w.government);
    const movements = nationalShares(w, occupied ? p.owner : holder);

    const held = (q) => !isOccupied(q);
    const reach = (id) => (w.table?.provinces || [])
      .filter((q) => held(q) && (q.owner === id || realmOf(w.table, q.owner) === id))
      .map((q) => weighForSpread(w, q));
    const taken = () => (w.table?.provinces || [])
      .filter((q) => q.occupier === holder && q.owner === p.owner)
      .map((q) => weighForSpread(w, q));
    const reaches = occupied
      ? { own: taken(), realm: [] }
      : { own: reach(holder), realm: above ? reach(realm) : [] };

    const out = new Map();
    const bump = (id, name, n) => {
      if (!n) return;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push([name, n]);
    };
    for (const a of actEffects(gov, w.government, key, { parent: above, scale, label, shares, movements })) {
      const over = reaches[a.from] || reaches.own;
      if (!a.felt) { for (const q of over) bump(q.id, a.label, a.figure); continue; }
      // Acts aimed at every movement skip per-province incidence.
      if (a.felt.by === 'support' && a.target === 'all') continue;
      const by = a.felt.by === 'support'
        ? over.map((q) => ({ ...q, support: supportFor(w, q.id, a.target) }))
        : a.felt.by === 'target'
          ? over.map((q) => ({ ...q, target: industryAt(w, q.id, a.target) }))
          : over;
      for (const [id, n] of spreadByWeight(a.figure, by, a.felt.by, a.felt.spread)) bump(id, a.label, n);
    }
    actEffectBy.set(at, out);
  }
  return actEffectBy.get(at).get(p.id) || [];
}

// A province's compliance, 0 to 1: stored, plus acts in force there and the occupier's spirits and leader.
function complianceOf(w, p, stats) {
  let c = stats.compliance || 0;
  if (!isOccupied(p)) return clamp(c, 0, 1);
  for (const [, n] of actEffect(w, p, 'compliance')) c += n;
  for (const [, n, kind] of nationalParts(w, p.occupier, 'compliance')) if (kind === 'spirit' || kind === 'leader') c += n;
  return clamp(c, 0, 1);
}

// The leader's figure for a modifier, charged in each of the leader's own provinces.
const leaderParts = (w, p, key) => (p?.owner && !isOccupied(p)
  ? nationalParts(w, p.owner, key).filter(([, , kind]) => kind === 'leader') : []);

function happinessOf(w, p, stats, today) {
  const parts = [];
  const add = (label, n) => { if (n) parts.push([label, n]); };

  const [road = 0] = stats.road || [];
  const [power = 0] = stats.electricity || [];
  add('services', road * 0.3 + railShare(w, p) * 3);
  add('electricity', power * 0.8);
  add('employment', (stats.civilianFactories || 0) * 0.8);
  add('occupied', -30 * occupiedFraction(w, p) * (1 - complianceOf(w, p, stats)));
  add('war weariness', -wearinessOf(w, p, stats));
  add('fought over', -struckOf(stats));
  add('recently annexed', -25 * unsettledShare(stats, today));
  for (const [name, n] of Object.entries(foodHappiness(w, p) || {})) add(name, n);
  for (const [name, n] of spiritEffect(w, p, 'happiness')) add(name, n);
  for (const [name, n] of actEffect(w, p, 'happiness')) add(name, n);
  const creed = heldIdeology(w, polityOf(w, p)?.id);
  add(creed ? `${demonymOf(creed)} government` : 'government', ideologyHappiness(w, p));

  const raw = HAPPINESS_BASE + parts.reduce((a, [, n]) => a + n, 0);
  return { value: clamp(raw, 0, 100), parts };
}

// Unrest: stored value, daily rate and its breakdown.
// The act in force in a province that stops unrest building there, or null.
function unrestHeldBy(w, p) {
  const holder = polityOf(w, p)?.id;
  if (!holder) return null;
  const occupied = isOccupied(p);
  const gov = occupied ? occupationGovernment(w, holder, p.owner) : w.government?.byPolity?.get(holder);
  if (!gov) return null;
  const realm = occupied ? holder : realmOf(w.table, holder);
  const above = realm === holder ? null : w.government.byPolity.get(realm) || null;
  const held = heldActs(gov, above, w.government.defaults);
  const tables = [[held.policies, w.government.policies?.policies], [held.decrees, w.government.decrees?.decrees]];
  for (const [acts, table] of tables) {
    for (const x of acts) {
      const act = table?.find((a) => a.name === nameOf(x));
      if (act?.effects?.unrestAccumulates === false) return act.name;
    }
  }
  return null;
}

function unrestOf(w, p, stats, happiness, stability = null) {
  const local = Math.max(0, UNREST_THRESHOLD - happiness) / 5;
  const occupation = p?.occupier ? 5 * (stats.resistance || 0) * occupiedFraction(w, p) : 0;
  // A country under 20 stability adds to unrest in every province it holds.
  const stab = p?.owner ? (stability?.get(p.owner) ?? stabilityOf(w, p.owner)) : 50;
  const national = stab < 20 ? (20 - stab) / 10 : 0;
  const garrison = 0;                              // 3 per unit stationed, capped at 9
  const spirits = [...spiritEffect(w, p, 'unrestPerDay'), ...actEffect(w, p, 'unrestPerDay'), ...leaderParts(w, p, 'unrestPerDay')];
  // The holder's colonial tax in a colony, the realm's national tax in a member.
  const holder = p?.owner ? colonyHolder(w, p.owner) : null;
  const colonial = holder ? nationalModifier(w, holder, 'colonialUnrestPerDay') : 0;
  const realm = w.table?.polityById?.get(p?.owner)?.parent;
  const member = realm && realm !== p.owner ? nationalModifier(w, realm, 'memberUnrestPerDay') : 0;
  const pressure = local + national + occupation + colonial + member + spirits.reduce((a, [, n]) => a + n, 0);
  const rising = pressure > garrison;
  const heldBy = rising ? unrestHeldBy(w, p) : null;
  const rate = !rising ? -UNREST_DECAY : heldBy ? 0 : pressure - garrison;
  const parts = [];
  if (local) parts.push(['unhappy', local]);
  if (occupation) parts.push(['resistance', occupation]);
  if (national) parts.push(['instability', national]);
  if (colonial) parts.push(['colonial tax', colonial]);
  if (member) parts.push(['national tax', member]);
  for (const [name, n] of spirits) parts.push([name, n]);
  if (garrison) parts.push(['garrison', -garrison]);
  if (heldBy) parts.push([heldBy.toLowerCase(), -(pressure - garrison)]);
  if (!rising && (stats.unrest || 0) > 0) parts.push(['settling', -UNREST_DECAY]);
  return { value: clamp(stats.unrest || 0, 0, 100), rate, parts };
}

// Moves every province's unrest by its rate, all worked out from the same day.
everyDay((w, day) => {
  const today = new Date(CLOCK_EPOCH + day * DAY_MS);
  const stability = new Map();
  const steps = [];
  for (const p of w.table?.provinces || []) {
    const st = w.stats?.[p.id];
    if (!st || !p.owner || p.owner === UNOWNED) continue;
    if (!stability.has(p.owner)) stability.set(p.owner, stabilityOf(w, p.owner));
    steps.push([st, unrestOf(w, p, st, happinessOf(w, p, st, today).value, stability).rate]);
  }
  for (const [st, rate] of steps) st.unrest = clamp((st.unrest || 0) + rate, 0, 100);
  if (state.selected) updateCard();
});

export { HAPPINESS_BASE, UNREST_THRESHOLD, UNREST_DECAY, railCache, railCacheWorld, railToCapital, railToCapitalWorld, railsReachingTheCapital, connectedOf, railShare, occupiedFraction, STRUCK_CAP, STRUCK_HAPPINESS, wearinessWeight, struckOf, provinceTraits, wearinessMean, WEARINESS_CAP, wearinessOf, unsettledShare, developmentOf, developmentPitOf, builtLevel, unlockedSlots, weighForSpread, namedDeposits, spiritSpreadBy, spiritEffect, label, heldIdeologyBy, heldIdeology, ideologyHappiness, spiritTotal, taxMultiplier, depositsBy, depositsOf, nationalShareBy, nationalShares, occupiedShare, industryAt, supportFor, governingLeads, spiritById, spiritPenalty, occupationGovernment, actEffectBy, actEffect, complianceOf, leaderParts, happinessOf, unrestHeldBy, unrestOf };
