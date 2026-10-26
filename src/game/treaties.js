// Treaties in force: reparations paid in instalments, in money and in resources, until the total is paid.

const VERSION = new URL(import.meta.url).search;
const { nameOf } = await import(`./government.js${VERSION}`);

const treatiesOf = (w) => w.government?.treaties || [];

// Every party to every treaty, one loser each.
const partiesOf = (w) => treatiesOf(w).flatMap((t) => (t.parties || []).map((p) => ({ ...p, treaty: t })));

// Who imposed a treaty on a polity.
const imposersOf = (w, id) => partiesOf(w).filter((p) => (p.on || []).includes(id)).flatMap((p) => p.by || []);

// Whether a polity has repudiated the treaties imposed on it.
function repudiates(w, id) {
  const g = w.government;
  return (g?.byPolity?.get(id)?.decrees || []).some((x) => g.decrees?.decrees?.find((d) => d.name === nameOf(x))?.effects?.repudiates);
}

// Reparations falling due today: each payer's money instalment and what it owes of each resource.
function reparationsDue(w) {
  const out = [];
  for (const party of partiesOf(w)) {
    const r = party.terms?.reparations;
    if (!r) continue;
    const payers = (party.on || []).filter((id) => !repudiates(w, id));
    if (!payers.length) continue;
    const money = r.money && r.money.outstanding > 0 ? Math.min(r.money.instalment, r.money.outstanding) / payers.length : 0;
    const resources = {};
    for (const [kind, x] of Object.entries(r.resources || {})) {
      if (x.outstanding > 0) resources[kind] = Math.min(x.instalment, x.outstanding) / payers.length;
    }
    for (const payer of payers) out.push({ party, terms: r, payer, to: r.to || {}, suspended: Boolean(r.suspended), money, resources });
  }
  return out;
}

export { treatiesOf, partiesOf, imposersOf, repudiates, reparationsDue };
