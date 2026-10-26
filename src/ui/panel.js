// The side panel and its government block.

const VERSION = new URL(import.meta.url).search;
const { controllerOf, membersOf, realmOf } = await import(`../world/mapdata.js${VERSION}`);
const { compass, costWeighting, industryShares, nameOf, realmCompass } = await import(`../game/government.js${VERSION}`);
const { els, state, live } = await import(`../core/core.js${VERSION}`);

// Functions from other modules, filled in by main.js once every module has loaded.
let RESOURCE_NAME, areaText, depositsOf, flaggedName, nationalShares, polSwatch, polityOf, realmAbove, resourceIcon, shortNameOf, spiritById, tipName, tooBigToLight;
export function link(all) { ({ RESOURCE_NAME, areaText, depositsOf, flaggedName, nationalShares, polSwatch, polityOf, realmAbove, resourceIcon, shortNameOf, spiritById, tipName, tooBigToLight } = all); }

const panelOpen = () => els.panel.classList.contains('open');

// Slides the development inspector in or out; backtick key.
function togglePanel() {
  els.panel.classList.toggle('open');
  document.getElementById('toggle-panel').classList.toggle('active', panelOpen());
  if (panelOpen()) {
    updatePanel();
    live.readoutAt = 0;             // Forces an immediate readout refresh
  }
}

// Rewrites the development inspector for the current selection.
function updatePanel() {
  if (!panelOpen()) return;
  const w = state.world;
  if (!state.selected) {
    els.selName.textContent = '—';
    els.selBody.innerHTML = '<span class="hint">Click a province on the map.</span>';
    els.neighbours.innerHTML = '';
    return;
  }
  const p = w.byId.get(state.selected);
  const nb = [...w.adjacency.get(p.id)]
    .map((id) => w.byId.get(id))
    .sort((a, b) => a.name.localeCompare(b.name));

  els.selName.textContent = p.name;
  els.selBody.innerHTML = `
    <div class="row"><span>ID</span><span>${p.id}</span></div>
    <div class="row"><span>Owner</span><span>${polSwatch(polityOf(w, p))}${polityOf(w, p).name}</span></div>
    <div class="row"><span>Terrain</span><span>${p.terrain.join(' + ') || '—'}</span></div>
    <div class="row"><span>Climate</span><span>${p.climate.join(' + ') || '—'}</span></div>
    <div class="row"><span>Coastal</span><span>${w.coastal.has(p.id) ? 'yes' : 'no'}</span></div>
    <div class="row"><span>Area</span><span>${areaText(p)}</span></div>
    ${tooBigToLight(w, p.id) ? '<div class="row"><span>Highlight</span><span class="warn">off, box '
      + (w.bounds.get(p.id).maxX - w.bounds.get(p.id).minX + 1) + ' wide by '
      + (w.bounds.get(p.id).maxY - w.bounds.get(p.id).minY + 1) + '</span></div>' : ''}
    <div class="row"><span>Pixels</span><span>${w.bounds.get(p.id)?.n ?? 0}</span></div>
    <div class="row"><span>Neighbours</span><span>${nb.length}</span></div>`;
  els.government.innerHTML = governmentPanel(w, p);
  els.neighbours.innerHTML = `<h1>Adjacent provinces</h1><ul>${nb.map((q) => `<li data-id="${q.id}">${polSwatch(polityOf(w, q))}${q.name}</li>`).join('')
    }</ul>`;
}

// Demonym adjective taken from an ideology's movement name.
const bareDemonym = (movement) => movement.replace(/^the /, '').replace(/ movement$/, '');
const demonymOf = (ideology) => bareDemonym(ideology.movement);

// Fills name tokens in a decree or policy name from its target.
function fillTokens(text, target, tables, polity, mark = false) {
  const gold = (s) => (mark ? flaggedName(polity, s) : s);
  const named = typeof target === 'string' ? target : null;
  const movement = named === 'all'
    ? tables.ideologies.allMovement
    : tables.ideologies.ideologies.find((i) => i.name === named)?.movement;
  return text
    .replaceAll('IDEOLOGY_DEMONYM ', movement && named !== 'all'
      ? bareDemonym(movement) + ' ' : '')
    .replaceAll('MOVEMENT_NAME', movement ?? named ?? '')
    .replaceAll('INDUSTRY_NAME', industryName(named))
    .replaceAll('RESOURCE_NAME', mark && RESOURCE_NAME[named]
      ? resourceIcon(named) + ' ' + tipName(RESOURCE_NAME[named].toLowerCase())
      : (RESOURCE_NAME[named] ?? named ?? '').toLowerCase())
    .replaceAll('POLITY_NAME', gold(shortNameOf(polity, true)));
}

// Display name for an industry kind; fertile land and livestock render bare.
function industryName(kind) {
  if (typeof kind !== 'string') return '';
  if (kind === 'rail') return 'railways';
  if (kind === 'manufacturing') return 'consumer goods industry';
  const name = (RESOURCE_NAME[kind] ?? kind ?? '').toLowerCase();
  return kind === 'fertileLand' || kind === 'livestock' ? name : name + ' industry';
}

// Doctrine a polity fights under, with a realm member's per-branch overrides.
function doctrineOf(w, id) {
  const gov = w.government?.byPolity?.get(id);
  if (!gov) return {};
  return { ...(realmAbove(w, id)?.doctrine || {}), ...(gov.doctrine || {}) };
}

function governmentPosition(w, id) {
  const g = w.government;
  const gov = g?.byPolity?.get(id);
  if (!gov) return null;
  const members = membersOf(w.table, id)
    .filter((q) => g.byPolity.has(q.id))
    .map((q) => ({ gov: g.byPolity.get(q.id), population: populationOf(w, q.id) }));
  if (members.length) return realmCompass(gov, members, g, gov.startingIdeology || null);
  return compass(gov, g, gov.startingIdeology || null, realmAbove(w, id),
    industryShares(depositsOf(w, id), g), nationalShares(w, id));
}

function populationOf(w, id) {
  let n = 0;
  for (const q of w.table?.provinces || []) if (q.owner === id) n += w.stats?.[q.id]?.population || 0;
  return n;
}

// Debug panel of the owner's government, derived from the compass.
function governmentPanel(w, p) {
  const w0 = w.government;
  if (!w0) return '';
  const owner = controllerOf(p);
  const realm = realmOf(w.table, owner);
  return governmentBlock(w, realm, 'Government')
    + (realm === owner ? '' : governmentBlock(w, owner, 'Its government'));
}

function governmentBlock(w, held, title) {
  const g = w.government;
  const pol = w.table.polityById.get(held);
  const gov = g.byPolity.get(held);
  if (!gov) {
    return `<h1>${title}</h1><div class="row"><span>${pol?.name ?? held}</span>`
      + '<span class="hint">not authored yet</span></div>';
  }

  let c;
  try { c = governmentPosition(w, held); } catch (e) { return `<h1>${title}</h1><div class="row"><span>error</span><span class="warn">${e.message}</span></div>`; }
  const wt = costWeighting(c.position, g);
  const row = (k, v) => `<div class="row"><span>${k}</span><span>${v}</span></div>`;
  const list = (a) => (a && a.length
    ? a.map((x) => fillTokens(nameOf(x), x?.target, g, pol)).join(', ') : '—');
  const laws = Object.entries(gov.laws || {})
    .map(([k, v]) => `${v} <span class="hint">${k}</span>`).join('<br>');

  return `<h1>${title}</h1>`
    + row('Polity', `${polSwatch(pol)}${pol?.name ?? held}`)
    + row('Form', gov.form)
    + row('Ideology', c.ideology)
    + row('Compass', `${c.position[0].toFixed(0)} economic, ${c.position[1].toFixed(0)} authority`)
    + row('Policy slots', `${(gov.policies || []).length} of ${c.slots}`)
    + row('Laws', laws || '—')
    + row('Doctrine', Object.values(doctrineOf(w, held)).join(', ') || '—')
    + row('Policies', list(gov.policies))
    + row('Decrees', (gov.decrees || []).length
      ? gov.decrees.map((x) => fillTokens(nameOf(x), x?.target, g, pol)
        + (x?.expired ? ' <span class="hint">completed</span>' : '')).join(', ')
      : '—')
    + row('Spirits', list((gov.spirits || []).map((n) => spiritById(w, n)?.name || n)))
    + row('Law cost', `conscription ×${wt.conscription.toFixed(2)}, tax ×${wt.tax.toFixed(2)}, economy ×${wt.economy.toFixed(2)}`);
}

export { panelOpen, togglePanel, updatePanel, bareDemonym, demonymOf, fillTokens, industryName, doctrineOf, governmentPosition, populationOf, governmentPanel, governmentBlock };
