// Flags, names and the modifier text tooltips use.

const VERSION = new URL(import.meta.url).search;

// Functions from other modules, filled in by main.js once every module has loaded.
let SHIPMENT_DAYS, RESOURCE_ICON, RESOURCE_NAME, RESOURCE_SHEET_COLS, RUNDEAN_MONTHS, fillTokens, label, shortNameOf, spiritById;
export function link(all) { ({ SHIPMENT_DAYS, RESOURCE_ICON, RESOURCE_NAME, RESOURCE_SHEET_COLS, RUNDEAN_MONTHS, fillTokens, label, shortNameOf, spiritById } = all); }

// Marks a named thing in a tooltip.
const tipName = (s) => (s || s === 0 ? '<span class="named">' + s + '</span>' : '');

// Clips a flag box's shading to the flag's own outline.
function maskFlagShading(img) {
  img.onload = () => {
    const box = img.parentElement;
    if (typeof box?.style?.setProperty === 'function') box.style.setProperty('--flag-mask', `url("${img.src}")`);
  };
}

// Flag file paths and the placeholder flag.
const FLAG_DIR = './data/img/flags/';
const flagFile = (slug) => FLAG_DIR + slug + '.png';
const FLAG_PLACEHOLDER = flagFile('placeholder');

// Flag slugs already found to have no file.
const flagMissing = new Set();

// Records a missing flag and shows its stand-in.
window.flagMiss = function flagMiss(img, slug) {
  img.onerror = null;
  if (slug) flagMissing.add(slug);
  if (img.classList.contains('mini-flag') || img.classList.contains('swatch-flag')) {
    img.hidden = true;
    img.parentElement?.classList.add('blank');
  } else {
    img.src = FLAG_PLACEHOLDER;
  }
};

// A country named in a tooltip: article, flag, then name in gold.
function flaggedName(polity, name) {
  const cut = /^(the )(.*)$/i.exec(name || '');
  return cut ? cut[1] + miniFlag(polity) + tipName(cut[2]) : miniFlag(polity) + tipName(name);
}

// Capitalises an article at the head of a sentence in markup.
const capitaliseArticle = (html) => String(html).replace(
  /(^|[.!?]\s*|<div[^>]*>|<br\s*\/?>|<hr\s*\/?>|<\/div>\s*)((?:\s*<[^>]+>)*\s*)the\b/g,
  (_, before, tags) => before + tags + 'The');

// Flag file name for a country, from its short name.
function flagSlug(polity, fallback = '') {
  return String(shortNameOf(polity) || fallback || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Flag file for a slug, or the placeholder.
function flagSrc(slug) {
  return slug && !flagMissing.has(slug) ? flagFile(slug) : FLAG_PLACEHOLDER;
}

// Text-sized flag markup for a country named in a tooltip.
function miniFlag(polity) {
  const slug = flagSlug(polity);
  if (!slug) return '';
  const blank = flagMissing.has(slug);
  const box = '<span class="mini-flag-box' + (blank ? ' blank' : '') + '"'
    + ' style="--flag-colour: rgb(' + (polity?.colour ?? '128,128,128') + ')">';
  return box + (blank ? '' : '<img class="mini-flag" alt=""'
    + ' src="' + flagFile(slug) + '"'
    + ' onerror="window.flagMiss(this, \'' + slug + '\')">') + '</span>';
}

// A traded good's display name: a resource, or consumer goods.
const goodName = (kind) => RESOURCE_NAME[kind] ?? (kind === 'consumerGoods' ? 'Consumer goods' : undefined);

// A resource's icon markup from the sprite sheet; consumer goods from their own icon.
function resourceIcon(kind) {
  if (kind === 'consumerGoods') return '<i class="res goods"></i>';
  const cell = RESOURCE_ICON[kind];
  if (cell === undefined) return '';
  return '<i class="res" style="--cols:' + RESOURCE_SHEET_COLS + ';--col:' + (cell % RESOURCE_SHEET_COLS)
    + ';--row:' + Math.floor(cell / RESOURCE_SHEET_COLS) + '"></i>';
}

// A shipment: the daily figure over the interval, and the interval.
const everyOf = (x) => x.every ?? SHIPMENT_DAYS;
const perShipment = (n, x) => (Math.round(n * everyOf(x) * 10) / 10).toLocaleString('en-GB');
const intervalOf = (x) => ' every ' + everyOf(x) + ' days';
// Who pays a shipment's bunkering and tariffs.

// A count of equipment items, plural past one; infantry equipment is counted in sets and takes none.
function equipmentCount(w, id, n) {
  const item = (w.production?.equipment?.items || []).find((x) => x.id === id);
  const name = (item?.name || id).toLowerCase();
  return n + ' ' + tipName(item?.unit || Number(String(n).replace(/,/g, '')) === 1 ? name : name + 's');
}

// A relation's title in its tooltip, by band.
const RELATION_TITLE = {
  puppet: () => 'Puppet',
  guarantee: () => 'Guarantee',
  allies: () => 'Alliance',
  access: () => 'Military access',
  sanctions: () => 'Sanctions',
  war: () => 'War',
  denounced: () => 'Denouncement',
  improving: () => 'Improving relations',
  nonAggression: () => 'Non-aggression pact',
  stateAgreement: (r) => {
    const paidIn = (r) => { const p = typeof r.price === 'number' ? { money: r.price } : r.price || {}; return Object.values(p).some((n) => n > 0); };
    const list = r.goods || [r];
    return list.every(paidIn) ? 'State agreement' : list.some(paidIn) ? 'Lend lease and state agreement' : 'Lend lease';
  },
  volunteers: () => 'Volunteers',
  lease: () => 'Lease',
  developmentAid: () => 'Development aid',
};

// An ISO date in the game's calendar.
function calendarDate(iso) {
  const d = new Date(Date.parse(iso));
  return d.getUTCDate() + ' ' + RUNDEAN_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

// An end date: a full date, or a year meaning 1 January of it.
const endDate = (until) => tipName(calendarDate(typeof until === 'number' ? until + '-01-01' : until));

// Tooltip terms of one standing relation.
function relationTip(w, band, r, other = null) {
  const pol = (id) => w.table?.polityById?.get(id);
  const shortName = (id) => shortNameOf(pol(id), true) || id;
  const head = '<b>' + (RELATION_TITLE[r.band]?.(r) || band.name) + '</b>';
  const first = flaggedName(pol(r.first), shortName(r.first));
  const second = flaggedName(pol(r.second), shortName(r.second));
  const line = (text) => capitaliseArticle(head + '<div>' + text + '.</div>');

  if (r.band === 'puppet') return line(second + ' is a puppet of ' + first);
  if (r.band === 'guarantee') return line(first + ' guarantees the independence of ' + second);
  if (r.band === 'denounced') return line(first + ' denounced the actions of ' + second + (r.on ? ' on ' + tipName(calendarDate(r.on)) : ''));
  if (r.band === 'improving') return line(first + ' is improving relations with ' + second);
  if (r.band === 'sanctions') return line(first + ' has placed sanctions on ' + second);
  if (r.band === 'nonAggression') return line(first + ' and ' + second + ' have agreed not to make war on each other');
  if (r.band === 'access') return line(first + ' and ' + second + ' grant each other military access');
  if (r.band === 'allies') return line(first + ' and ' + second + ' are allies');
  if (r.band === 'war') return line(first + ' and ' + second + ' are at war');
  if (r.band === 'volunteers') return line(first + ' has sent ' + (r.divisions ? r.divisions + ' divisions of ' : '') + 'volunteers to fight for ' + second);
  if (r.band === 'stateAgreement') {
    const good = (g, n) => (goodName(g) ? n + ' ' + resourceIcon(g) + tipName(goodName(g).toLowerCase())
      : equipmentCount(w, g, n));
    const paidFor = (x) => {
      const price = typeof x.price === 'number' ? { money: x.price } : x.price || {};
      return Object.entries(price).filter(([, n]) => n > 0)
        .map(([k, n]) => (k === 'money' ? '$' + perShipment(n, x) : good(k, perShipment(n, x)))).join(' and ');
    };
    const until = (x) => (x.until ? ' until ' + endDate(x.until) : '');
    const list = r.goods || [r];
    // Laid out as a lease is: what and from whom, to whom and until when, and the price under it.
    if (list.length === 1) {
      const paid = paidFor(r);
      return capitaliseArticle(head + '<div>' + good(r.good, perShipment(r.amount, r)) + intervalOf(r) + ' from ' + first + '</div>'
        + '<div>to ' + second + until(r) + '.</div>')
        + (paid ? '<div class="sub">' + paid + intervalOf(r) + '</div>' : '');
    }
    // Several goods: one line each, then from whom and to whom.
    // The interval and the end are said once where every good shares them.
    const shared = list.every((x) => everyOf(x) === everyOf(list[0]));
    const ends = list.every((x) => x.until === list[0].until);
    return capitaliseArticle(head + list.map((x) => {
      const paid = paidFor(x);
      return '<div>' + good(x.good, perShipment(x.amount, x)) + (shared ? '' : intervalOf(x)) + (ends ? '' : until(x)) + (paid ? ', for ' + paid : '') + '</div>';
    }).join('') + '<div>' + (shared ? intervalOf(list[0]).trim() + ' ' : '') + 'from ' + first + '</div><div>to ' + second + (ends ? until(list[0]) : '') + '.</div>');
  }

  // Development aid: what the builder keeps up, a line each, then where it stands.
  if (r.band === 'developmentAid') {
    const projects = w.production?.construction?.projects || [];
    const list = r.aid || [r];
    return capitaliseArticle(head + list.map((x) => {
      const proj = projects.find((p) => p.id === x.infrastructure);
      const what = (proj?.name || x.infrastructure).toLowerCase();
      const one = x.levels === 1;
      const unit = x.infrastructure === 'rail' ? 'railed count' + (one ? 'y' : 'ies')
        : proj?.on === 'county' && x.infrastructure !== 'fortification' ? what + (one ? '' : 's') : what + ' level' + (one ? '' : 's');
      const q = w.byId?.get(x.province);
      return '<div>' + x.levels + ' ' + tipName(unit) + ' in ' + tipName(q?.name || x.province) + '</div>';
    }).join('') + '<div>kept up by ' + first + ' for ' + second + '.</div>');
  }

  if (r.band !== 'lease') {
    return head + (other ? ' ' + miniFlag(pol(other))
      + tipName(shortNameOf(pol(other)) || other) : '');
  }

  const q = (w.table?.provinces || []).find((x) => x.id === r.province);
  const rent = r.rent?.money != null ? '$' + perShipment(r.rent.money, r) + intervalOf(r)
    : r.rent ? Object.entries(r.rent).map(([k, v]) => perShipment(v, r) + ' ' + tipName(k)).join(', ') + intervalOf(r) : null;
  const what = (RESOURCE_NAME[r.resource] ?? r.resource).toLowerCase();
  return capitaliseArticle(head + '<div>' + r.amount + ' ' + resourceIcon(r.resource)
    + tipName(what) + ' from ' + tipName(q ? q.name : r.province) + ', '
    + flaggedName(pol(r.first), shortName(r.first)) + '</div>'
    + '<div>to ' + flaggedName(pol(r.second), shortName(r.second)) + ' until ' + endDate(r.until) + '.</div>')
    + (rent ? '<div class="sub">' + rent + '</div>' : '');
}

// A law category's display label.
const lawLabel = (w, category) => w?.government?.laws?.categories?.[category]?.label;

// Modifier keys where a lower value is better.
const LOWER_IS_BETTER = new Set([
  'interest', 'maintenance', 'lawAdoptionCost', 'decreeCost', 'ministerCost',
  'policyCost', 'policyUpkeep', 'commanderCost', 'doctrineCost', 'driftMultiplierTowardTarget',
  'conscriptionRaiseCost', 'equipmentUse', 'supplyUse', 'conversionDays',
  'trainingTime', 'nightPenalty', 'unrest', 'unrestPerDay', 'colonialUnrestPerDay',
  'bombingDamage', 'happinessPenalties', 'againstEnemySupply', 'againstFortification',
  'militaryAllianceTension', 'wearinessModifier',
]);

// One modifier, as a line a player reads.
// Figure tokens in a modifier's wording.
const FIGURE_TOKEN = /\b(PERCENTAGE|PERCENT|POINTS|NUMBER|DAYS|MULTIPLIER|PERDAY|OPTION)\b/;

// Whether a modifier figure is a stated level.
const isLevel = (m, stated) => m?.level === 'always' || (m?.level === 'law' && stated);

function modifierLine(w, key, v, subject, stated, target) {
  const m = w.government?.modifiers?.modifiers?.[key];
  const shown = m?.shown || key;
  const bare = isLevel(m, stated);
  const sign = (n) => (bare ? '' : n >= 0 ? '+' : '');
  const figure = (token) => {
    if (typeof v !== 'number') return String(v);
    if (token === 'PERCENTAGE') return sign(v) + Number((v * 100).toFixed(1)) + '%';
    if (token === 'PERCENT') return sign(v) + v + '%';
    if (token === 'MULTIPLIER') return '\u00d7' + v;
    if (token === 'OPTION') return String(v);
    if (token === 'DAYS') return v + ' days';
    if (token === 'PERDAY') return sign(v) + Number(v.toFixed(3));
    return sign(v) + (Math.abs(v) < 1 ? Number(v.toFixed(3)) : v);
  };

  const hit = shown.match(FIGURE_TOKEN);
  const pivot = m?.unit === 'multiplier' ? 1 : 0;
  const good = !bare && typeof v === 'number' && v !== pivot
    ? (v > pivot) !== LOWER_IS_BETTER.has(key) : null;
  const cls = good === null ? '' : good ? ' class="up"' : ' class="down"';
  const holder = v && typeof v === 'object' && !Array.isArray(v) && typeof v.polity === 'string'
    ? v.polity : (typeof target === 'string' ? target : null);
  const polityOfLine = holder ? w.table?.polityById?.get(holder) : null;
  if (!hit) {
    return '<div class="cm-line"><span>'
      + fillTokens(shown, subject ? null : (holder ?? null), w.government, polityOfLine, true)
      + '</span></div>';
  }
  const base = shown.replace(hit[0], '').replace(/\s+/g, ' ').trim();
  const named = subject ? subject + ' ' + base : base;
  const text = target === 'all' ? named.replaceAll('IDEOLOGY_DEMONYM ', 'all ') : named;
  const label = fillTokens(text, subject ? null : (holder ?? null), w.government, polityOfLine, true);
  return '<div class="cm-line"><span>' + label + '</span><b' + cls + '>'
    + figure(hit[0]) + '</b></div>';
}

// One effect as one or more lines, one per map entry.
function modifierLines(w, key, v, stated = false, target = null, keepZero = false) {
  const m = w.government?.modifiers?.modifiers?.[key];
  const level = isLevel(m, stated);
  const dead = (x) => x === null || x === undefined || x === false
    || (x === 0 && !level && !keepZero);
  if (dead(v)) return '';
  const settings = v && typeof v === 'object' && !Array.isArray(v)
    && (typeof v.polity === 'string' || Array.isArray(v.whileForm));
  if (v && typeof v === 'object' && !Array.isArray(v) && !settings) {
    const say = (s) => {
      if (goodName(s)) return resourceIcon(s) + tipName(goodName(s).toLowerCase());
      const law = lawLabel(w, s);
      return law ? law.toLowerCase()
        : String(s).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    };
    // A map keyed by countries: one line each, the country as its target.
    const byPolity = Object.keys(v).every((k) => w.table?.polityById?.has(k));
    return Object.entries(v).filter(([, n]) => !dead(n))
      .map(([subject, n]) => (byPolity ? modifierLine(w, key, n, null, stated, subject)
        : modifierLine(w, key, n, say(subject), stated, target)))
      .join('');
  }
  return modifierLine(w, key, v, null, stated, target);
}

// Tooltip for a spirit tile.
function spiritTip(w, id) {
  const sp = spiritById(w, id);
  if (!sp) return '<b>' + id + '</b>';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  const under = (v) => v && typeof v === 'object' && !Array.isArray(v)
    && (Array.isArray(v.whileForm) || v.whileIndependent === true);
  const guarantor = ([k, v]) => k === 'guarantees' && typeof v?.spirit === 'string';
  const effects = Object.entries(sp.effects || {});
  const body = effects.filter(([k, v]) => !under(v) && !guarantor([k, v]))
    .map(([k, v]) => modifierLines(w, k, v, false, sp.target)).join('');
  const an = (f) => (/^[aeiou]/i.test(f) ? 'an ' : 'a ')
    + tipName(esc(f).toLowerCase());
  const formList = (forms) => forms.map(an).join(', ').replace(/, ([^,]*)$/, ' or $1');
  const conditional = effects.filter(([, v]) => under(v)).map(([k, v]) => {
    const shown = w.government?.modifiers?.modifiers?.[k]?.shown || k;
    const holder = typeof v.polity === 'string' ? v.polity : (sp.target ?? null);
    const by = typeof holder === 'string' ? w.table?.polityById?.get(holder) : null;
    const said = fillTokens(shown, holder, w.government, by, true);
    const forms = Array.isArray(v.whileForm)
      ? 'the form of government is ' + formList(v.whileForm) : '';
    const free = v.whileIndependent === true ? 'the country is not a puppet' : '';
    return '<hr><div class="sub">If ' + [free, forms].filter(Boolean).join(' and ')
      + ', it is ' + said + '.</div>';
  }).join('');

  const terms = effects.filter(guarantor).map(([, v]) => {
    const other = spiritById(w, v.spirit);
    const on = other?.effects?.guaranteedBy || {};
    const forms = Array.isArray(on.whileForm)
      ? 'its form of government is ' + formList(on.whileForm) : '';
    const free = on.whileIndependent === true ? 'it is not a puppet' : '';
    const when = [free, forms].filter(Boolean).join(' and ');
    return '<hr><div class="sub">Every country under the '
      + tipName(esc(other?.name || v.spirit)) + ' is guaranteed by us'
      + (when ? ' if ' + when : '') + '.</div>';
  }).join('');

  const said = w.government?.modifiers?.tags || {};
  const tagged = (sp.tags || []).map((t) => said[t]?.shown).filter(Boolean)
    .map((s) => '<div class="cm-line"><span>' + esc(s) + '</span></div>').join('');

  const local = Object.entries(sp.inProvinces?.effects || {})
    .map(([k, v]) => modifierLines(w, k, v, false, sp.target)).join('');
  let where = '';
  if (local) {
    const named = sp.inProvinces?.provinces || [];
    const byId = new Map((w.table?.provinces || []).map((q) => [q.id, q.name]));
    where = '<hr><div class="sub">' + (named.length
      ? 'In ' + named.map((q) => tipName(esc(byId.get(q) || q))).join(', ')
      : 'In some provinces') + '</div>';
  }

  const why = sp.description
    ? '<hr><div class="sub">' + esc(sp.description) + '</div>' : '';
  return '<b>' + esc(sp.name) + '</b>' + body + tagged + conditional + terms + where + local + why;
}

// Panel label for each doctrine branch.
const DIPLO_DOCTRINE_LABEL = {
  land: 'Land doctrine', air: 'Air doctrine',
  naval: 'Naval doctrine', magical: 'Magical doctrine',
};

// Tooltip for a doctrine tile.
function doctrineTip(w, branch, school) {
  const opt = w.government?.laws?.doctrine?.branches?.[branch]?.find((o) => o.name === school);
  const head = '<b>' + school + '</b><div class="sub">'
    + (DIPLO_DOCTRINE_LABEL[branch] || branch) + '</div>';
  const body = Object.entries(opt?.effects || {})
    .map(([k, v]) => modifierLines(w, k, v)).join('');
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return head + body
    + (opt?.special ? '<hr><div class="sub">' + esc(opt.special) + '</div>' : '');
}

function lawTip(w, category, option) {
  const opt = w.government?.laws?.categories?.[category]?.options?.find((o) => o.name === option);
  const head = '<b>' + option + '</b><div class="sub">'
    + (lawLabel(w, category) || category) + '</div>';

  return head + Object.entries(opt?.effects || {})
    .map(([k, v]) => modifierLines(w, k, v, true, null, true)).join('');
}
const diploRow = (label, value, icon) =>
  '<div class="diplo-row">' + (icon ? '<i class="ico ' + icon + '"></i>' : '')
  + '<span class="lab">' + label + '</span>'
  + (value == null ? '' : '<span class="val">' + value + '</span>')
  + '</div>';

export { tipName, maskFlagShading, FLAG_DIR, flagFile, FLAG_PLACEHOLDER, flagMissing, flaggedName, capitaliseArticle, flagSlug, flagSrc, miniFlag, goodName, resourceIcon, relationTip, lawLabel, LOWER_IS_BETTER, FIGURE_TOKEN, isLevel, modifierLine, modifierLines, spiritTip, DIPLO_DOCTRINE_LABEL, doctrineTip, lawTip, diploRow };
