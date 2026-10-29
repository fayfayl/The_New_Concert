/*
 * Relations run one way: each country's view of another, read back through
 * game.relations and the relations module after the game has loaded.
 *
 *   node --max-old-space-size=6144 test/relations.mjs
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { install, fire } from './dom-shim.mjs';

const problems = [];
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dom = install(root);

process.on('uncaughtException', (e) => problems.push(['uncaught', e]));
process.on('unhandledRejection', (e) => problems.push(['rejection', e]));

const t0 = Date.now();
await import('../src/main.js');
for (let i = 0; i < 12000 && !(dom.frameQueue.length && globalThis.window.game); i++) await new Promise((r) => setTimeout(r, 50));
console.log(`booted in ${Date.now() - t0}ms`);
fire(dom.el('start-enter'), 'click');

const { state } = await import('../src/core/core.js');
const rel = await import('../src/game/relations.js');
const game = globalThis.window.game;
const w = state.world;

// A's view of b, its parts by label.
const view = (a, b) => game.relations(a, b).view;
const part = (a, b, label) => view(a, b).history[label];
const expect = (what, got, want) => {
  const ok = want === undefined ? got === undefined : typeof got === 'number' && Math.abs(got - want) < 0.05;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}: ${got}${ok ? '' : ', expected ' + want}`);
  if (!ok) problems.push(['relations', new Error(`${what}: ${got}, expected ${want}`)]);
};

// 150 days since 11 January 1926 at Fellnor-Avanta's own rate.
const fnaBuilt = Math.min(30, rel.improveRate(w, 'FNA', 'KGN') * 150);
expect('KGN view of FNA, improve relations', part('KGN', 'FNA', 'improve relations'), fnaBuilt);
expect('FNA view of KGN, improve relations to Kaganland', part('FNA', 'KGN', 'improve relations to Kaganland'), fnaBuilt / 4);
expect('ILT view of VOS, Voseni Mandate', part('ILT', 'VOS', 'Voseni Mandate'), 40);
expect('VOS view of ILT, Voseni Mandate', part('VOS', 'ILT', 'Voseni Mandate'), undefined);
expect('SBY view of TWD, denounced by Twadamia', part('SBY', 'TWD', 'denounced by Twadamia'), -23);
expect('TWD view of SBY, denounced by Twadamia', part('TWD', 'SBY', 'denounced by Twadamia'), -23);
expect('SAN view of AUS, denounced by Neo-Ausarta', part('SAN', 'AUS', 'denounced by Neo-Ausarta'), part('AUS', 'SAN', 'denounced by Neo-Ausarta'));
expect('AUS view of SAN, denounced by Sanata', part('AUS', 'SAN', 'denounced by Sanata'), part('SAN', 'AUS', 'denounced by Sanata'));
expect('TWD view of KRN, claims by Krenland', part('TWD', 'KRN', 'claims by Krenland'), -28.25);
expect('KRN view of TWD, claims by Krenland', part('KRN', 'TWD', 'claims by Krenland'), undefined);
// Casalina sends 1 iron and 1 infantry equipment a day: 2 of the 3 points for the full ceiling.
expect('NCN view of CSL, lend lease', part('NCN', 'CSL', 'lend lease'), 20);
expect('CSL view of NCN, lend lease to Nationalist Cunaria', part('CSL', 'NCN', 'lend lease to Nationalist Cunaria'), 5);
// Sanata sends 17 points a day to Sanatese Vortopaga: past the full ceiling.
expect('SVP view of SAN, lend lease', part('SVP', 'SAN', 'lend lease'), 30);
expect('SCN view of QRG, volunteers', part('SCN', 'QRG', 'volunteers from Qorgastan'), 10);
expect('NCN view of QRG, volunteers', part('NCN', 'QRG', 'volunteers from Qorgastan'), -25);
expect('QRG view of NCN, volunteers', part('QRG', 'NCN', 'volunteers from Qorgastan'), undefined);
expect('CFR view of VOS, occupation by Vosennac', part('CFR', 'VOS', 'occupation by Vosennac'), -40);
expect('VOS view of CFR, occupation by Vosennac', part('VOS', 'CFR', 'occupation by Vosennac'), undefined);
expect('VOS view of ILT, tension charged', view('VOS', 'ILT').tension, 0);
if (!(view('ILT', 'VOS').tension < 0)) problems.push(['relations', new Error('ILT view of VOS carries no tension from Vosennac')]);

// A leader the countries named think less of, from the data.
for (const t of ['MRI', 'FNA', 'SAN']) {
  expect(`${t} view of VOS, Prime Minister Florent Seyrès`, part(t, 'VOS', 'Prime Minister Florent Seyrès'), -15);
  expect(`VOS view of ${t}, Prime Minister Florent Seyrès`, part('VOS', t, 'Prime Minister Florent Seyrès'), undefined);
}
// A spirit the target thinks less of the holder for.
expect('VRP view of VKD, Kratumant', part('VRP', 'VKD', 'Kratumant'), -20);
expect('VKD view of VRP, Kratumant', part('VKD', 'VRP', 'Kratumant'), undefined);

// Friend of an enemy: Aroyan's view of Socialist Cunaria, friend of Qorgastan; one way only.
rel.refreshTerms(w);
const friendOf = (a, b) => (rel.pairRelations(w, a, b)?.parts || []).filter(([label]) => label.startsWith('friend of '));
const aroyan = Object.fromEntries(friendOf('ARY', 'SCN'))['friend of ' + w.table.polityById.get('QRG').short];
expect('ARY view of SCN, friend of Qorgastan', aroyan, -14.9);
if (!(aroyan < 0 && aroyan >= rel.FRIEND_CAP)) problems.push(['friends', new Error(`ARY view of SCN, friend of Qorgastan: ${aroyan}`)]);
expect('SCN view of ARY, friend of terms', friendOf('SCN', 'ARY').length, 0);
// None inside a realm, and none past the total cap.
const ids = [...w.government.byPolity.keys()];
let inRealm = 0, overCap = 0;
for (const a of ids) for (const b of ids) {
  if (a === b) continue;
  const list = friendOf(a, b);
  if (rel.voiceOf(w, a) === rel.voiceOf(w, b) && list.length) inRealm++;
  if (list.reduce((s, [, n]) => s + n, 0) < rel.FRIEND_TOTAL_CAP - 1e-9) overCap++;
}
expect('friend of terms inside a realm', inRealm, 0);
expect('views past the friend of total cap', overCap, 0);

// A leader's stance, held in memory only.
const queen = w.government.leaders.leaders.find((x) => x.id === w.government.byPolity.get('TWD').leader);
const kept = { target: queen.target, effects: queen.effects };
queen.target = 'KAN';
queen.effects = { ...queen.effects, relationsWithTarget: -12 };
rel.refreshTerms(w);
const stance = (a, b) => Object.fromEntries(rel.pairRelations(w, a, b).parts)[[queen.title, queen.name].filter(Boolean).join(' ')];
expect('TWD view of KAN, leader stance', stance('TWD', 'KAN'), -12);
expect('KAN view of TWD, leader stance', stance('KAN', 'TWD'), undefined);
Object.assign(queen, kept);

// Targeted propaganda, held in memory only: ten days on, then stopped.
const ilt = w.government.byPolity.get('ILT');
const before = ilt.policies;
ilt.policies = [...(before || []), { policy: 'Propaganda', target: 'VOS', toward: 'against', strength: 1 }, { policy: 'Propaganda', target: 'TWD', toward: 'for', strength: 1 }];
for (let i = 0; i < 10; i++) rel.growHistory(w);
expect('ILT view of VOS, propaganda against', w.relationHistory['ILT>VOS']['propaganda against Vosennac'], -1);
expect('ILT view of TWD, propaganda for', w.relationHistory['ILT>TWD']['propaganda for Twadamia'], 1);
expect('VOS view of ILT, propaganda against', w.relationHistory['VOS>ILT']?.['propaganda against Vosennac'], undefined);
ilt.policies = before;
for (let i = 0; i < 18; i++) rel.growHistory(w);
expect('ILT view of VOS, propaganda 18 days stopped', w.relationHistory['ILT>VOS']['propaganda against Vosennac'], -1 + 18 * rel.RUNNING_FADE);

// Development aid, Vosennac in Ilitaria: three road levels built, kept up, then taken over.
const prod = await import('../src/game/production.js');
const nation = await import('../src/game/nation.js');
const acts = await import('../src/game/acts.js');
const road = { infrastructure: 'road', province: 'al_nafura' };
const hostView = rel.relationsBetween('ILT', 'VOS').value;
const pp = w.polityValues.VOS.politicalPower;
for (let i = 0; i < 3; i++) expect('VOS political power for a road in ILT', game.developmentAid('VOS', 'road', 'al_nafura').politicalPower, 15 * (100 - hostView) / 100);
expect('VOS political power left', w.polityValues.VOS.politicalPower, pp - 3 * 15 * (100 - hostView) / 100);
const roadsBefore = w.stats.al_nafura.road[0];
for (const x of w.polityValues.VOS.construction) if (x.aid) x.progress = x.total;
prod.dailyProduction(w);
expect('al_nafura roads built', w.stats.al_nafura.road[0], roadsBefore + 3);
expect('VOS levels on the record', rel.aidRecords(w).find((x) => x.first === 'VOS' && x.province === 'al_nafura')?.levels, 3);
expect('VOS keeps up road in al_nafura', Number(acts.conditionHolds(w, 'VOS', 'targetInfrastructure', true, road)), 1);
expect('ILT holds foreign road in al_nafura', Number(acts.conditionHolds(w, 'ILT', 'targetForeignInfrastructure', true, road)), 1);
// Upkeep moves from host to builder.
const records = w.government.relations.relations;
const withAid = nation.dailyBooks(w, 0);
w.government.relations.relations = records.filter((x) => x.band !== 'developmentAid');
const without = nation.dailyBooks(w, 0);
w.government.relations.relations = records;
if (!(withAid.get('ILT').maintenance < without.get('ILT').maintenance)) problems.push(['aid', new Error('ILT still billed for aided roads')]);
if (!(withAid.get('VOS').maintenance > without.get('VOS').maintenance)) problems.push(['aid', new Error('VOS not billed for aided roads')]);
// Relations: +2 a level in the host's view, a quarter in the builder's.
rel.growHistory(w);
rel.refreshTerms(w);
const parts = (a, b) => Object.fromEntries(rel.pairRelations(w, a, b).parts);
expect('ILT view of VOS, development aid', parts('ILT', 'VOS')['development aid'], 6);
expect('VOS view of ILT, development aid to Ilitaria', parts('VOS', 'ILT')['development aid to Ilitaria'], 1.5);
// Take over: the record clears, the builder's view takes -15, the host's bonus fades.
game.addDecree('ILT', acts.TAKE_OVER, road);
expect('VOS levels on the record after take over', rel.aidRecords(w).find((x) => x.first === 'VOS' && x.province === 'al_nafura')?.levels, undefined);
for (let i = 0; i < 10; i++) rel.growHistory(w);
rel.refreshTerms(w);
expect('VOS view of ILT, take over', parts('VOS', 'ILT')['Take over road infrastructure in Al-Nafura'], -15);
expect('ILT view of VOS, development aid 10 days on', parts('ILT', 'VOS')['development aid'], 6 - 10 * rel.RUNNING_FADE);
expect('VOS view of ILT, development aid 10 days on', parts('VOS', 'ILT')['development aid to Ilitaria'], (6 - 10 * rel.RUNNING_FADE) * rel.GIVER_SHARE);
// A year after the take over, the -15 has faded by 5.
const taken = w.government.byPolity.get('ILT').decrees.find((x) => x.decree === acts.TAKE_OVER);
taken.since -= 365;
rel.refreshTerms(w);
expect('VOS view of ILT, take over a year on', parts('VOS', 'ILT')['Take over road infrastructure in Al-Nafura'], -10);
taken.since += 365;
expect('ILT holds foreign road after take over', Number(acts.conditionHolds(w, 'ILT', 'targetForeignInfrastructure', true, road)), 0);

// Guarantees: long-standing ones at the ceiling in the guaranteed country's view, a quarter in the guarantor's.
const { CLOCK_EPOCH, DAY_MS } = await import('../src/core/core.js');
const short = (id) => w.table.polityById.get(id)?.short || id;
rel.refreshTerms(w);
for (const [a, b] of [['ZAN', 'VKD'], ['FNA', 'KGN']]) {
  expect(b + ' view of ' + a + ', guarantee', parts(b, a).guarantee, rel.GUARANTEE_CEILING);
  expect(a + ' view of ' + b + ', guarantee of ' + short(b), parts(a, b)['guarantee of ' + short(b)], rel.GUARANTEE_CEILING * rel.GIVER_SHARE);
}
// A guarantee given 100 days before the start has built 0.05 a day.
const fresh = { ...w, relationHistory: {}, relationHistoryStarted: false,
  government: { ...w.government, relations: { ...w.government.relations, relations: [{ band: 'guarantee', first: 'VOS', second: 'TWD', since: new Date(CLOCK_EPOCH - 100 * DAY_MS).toISOString().slice(0, 10) }] } } };
rel.warHistory(fresh);
expect('TWD view of VOS, guarantee since 100 days', fresh.relationHistory['TWD>VOS']?.guarantee, 100 * rel.GUARANTEE_PER_DAY);
// One given now builds 0.05 a day.
const guaranteeRecord = { band: 'guarantee', first: 'VOS', second: 'TWD' };
w.government.relations.relations.push(guaranteeRecord);
for (let i = 0; i < 10; i++) rel.growHistory(w);
expect('TWD view of VOS, guarantee 10 days on', w.relationHistory['TWD>VOS']?.guarantee, 10 * rel.GUARANTEE_PER_DAY);
w.government.relations.relations = w.government.relations.relations.filter((x) => x !== guaranteeRecord);
// Refused: -40 in the guaranteed country's view, the record gone, and a year on -35 with the guarantee faded.
const refusal = 'guarantee refused by ' + short('ZAN');
expect('ZAN refuses VKD', Number(rel.refuseGuarantee(w, 'ZAN', 'VKD')), 1);
expect('ZAN guarantee of VKD on the record', rel.guarantees(w).filter((x) => x.first === 'ZAN' && x.second === 'VKD').length, 0);
rel.refreshTerms(w);
expect('VKD view of ZAN, guarantee refused', parts('VKD', 'ZAN')[refusal], rel.GUARANTEE_REFUSAL);
expect('ZAN view of VKD, guarantee refused', parts('ZAN', 'VKD')[refusal], undefined);
expect('NKO view of ZAN, guarantee refused', parts('NKO', 'ZAN')[refusal], rel.GUARANTEE_REFUSAL * rel.GIVER_SHARE);
expect('ZAN guarantees left', rel.guarantees(w).filter((x) => x.first === 'ZAN').length, 0);
for (let i = 0; i < 365; i++) rel.growHistory(w);
rel.refreshTerms(w);
expect('VKD view of ZAN, guarantee refused a year on', parts('VKD', 'ZAN')[refusal], rel.GUARANTEE_REFUSAL + 5);
expect('VKD view of ZAN, guarantee a year on', parts('VKD', 'ZAN').guarantee, rel.GUARANTEE_CEILING - 10);
expect('ZAN view of VKD, guarantee of a year on', parts('ZAN', 'VKD')['guarantee of ' + short('VKD')], (rel.GUARANTEE_CEILING - 10) * rel.GIVER_SHARE);
expect('KGN view of FNA, guarantee still held', parts('KGN', 'FNA').guarantee, rel.GUARANTEE_CEILING);
// A spirit's guarantees go the same way.
const spiritHeld = rel.guarantees(w).filter((x) => x.first === 'TRN').map((x) => x.second);
const trnRefusal = 'guarantee refused by ' + short('TRN');
expect('TRN refuses LPC', Number(rel.refuseGuarantee(w, 'TRN', 'LPC')), 1);
rel.refreshTerms(w);
expect('LPC view of TRN, guarantee refused', parts('LPC', 'TRN')[trnRefusal], rel.GUARANTEE_REFUSAL);
const other = spiritHeld.find((x) => x !== 'LPC');
expect(`${other} view of TRN, guarantee refused`, parts(other, 'TRN')[trnRefusal], rel.GUARANTEE_REFUSAL * rel.GIVER_SHARE);
expect('TRN guarantees left', rel.guarantees(w).filter((x) => x.first === 'TRN').length, 0);

// Border war, held then ended: its negative figures stay as a grudge, fading 5 a year.
const kanNeighbour = [...w.government.byPolity.keys()].find((t) => t !== 'KAN' && !acts.unavailable(w, 'KAN', 'policy', w.government.policies.policies.find((x) => x.name === 'Border war'), t));
game.addPolicy('KAN', 'Border war', kanNeighbour);
w.government.byPolity.get('KAN').policies.find((x) => x.policy === 'Border war').strength = 1;
rel.refreshTerms(w);
expect(kanNeighbour + ' view of KAN, Border war held', parts(kanNeighbour, 'KAN')['Border war'], -40);
game.removePolicy('KAN', 'Border war', kanNeighbour);
rel.refreshTerms(w);
expect(kanNeighbour + ' view of KAN, Border war after it ends', parts(kanNeighbour, 'KAN')['Border war'], undefined);
expect(kanNeighbour + ' view of KAN, Border war, ended', parts(kanNeighbour, 'KAN')['Border war, ended'], -40);
expect('KAN view of ' + kanNeighbour + ', Border war, ended', parts('KAN', kanNeighbour)['Border war, ended'], -20);
for (let i = 0; i < 365; i++) rel.growHistory(w);
rel.refreshTerms(w);
expect(kanNeighbour + ' view of KAN, Border war, ended a year on', parts(kanNeighbour, 'KAN')['Border war, ended'], -35);
expect('KAN view of ' + kanNeighbour + ', Border war, ended a year on', parts('KAN', kanNeighbour)['Border war, ended'], -15);

// Kanland dissolves the communist paramilitaries, then all of them: the single decree goes, its -20 lingers.
const communism = w.government.byPolity.get('QRG').startingIdeology;
const dissolve = 'Dissolve the IDEOLOGY_DEMONYM paramilitaries';
game.addDecree('KAN', dissolve, communism);
rel.refreshTerms(w);
const dissolveLabel = Object.keys(parts('QRG', 'KAN')).find((l) => l.startsWith('Dissolve'));
expect('QRG view of KAN, ' + dissolveLabel, parts('QRG', 'KAN')[dissolveLabel], -20);
game.addDecree('KAN', dissolve, 'all');
rel.refreshTerms(w);
const kanDissolves = w.government.byPolity.get('KAN').decrees.filter((x) => x.decree === dissolve).map((x) => x.target);
expect('KAN single-ideology dissolve decrees held', kanDissolves.filter((t) => t !== 'all').length, 0);
expect('KAN dissolve all held', kanDissolves.filter((t) => t === 'all').length, 1);
expect('QRG view of KAN, ' + dissolveLabel, parts('QRG', 'KAN')[dissolveLabel], undefined);
expect('QRG view of KAN, ' + dissolveLabel + ', ended', parts('QRG', 'KAN')[dissolveLabel + ', ended'], -20);
for (let i = 0; i < 365; i++) rel.growHistory(w);
rel.refreshTerms(w);
expect('QRG view of KAN, ' + dissolveLabel + ', ended a year on', parts('QRG', 'KAN')[dissolveLabel + ', ended'], -15);
// Legalising all of them ends the decree aimed at all.
game.addDecree('KAN', 'Legalise the IDEOLOGY_DEMONYM paramilitaries', 'all');
expect('KAN dissolve decrees after legalising all', w.government.byPolity.get('KAN').decrees.filter((x) => x.decree === dissolve).length, 0);

// Ban parties, then Legalise the parties: the -30 lingers.
game.addDecree('KAN', 'Ban parties', communism);
rel.refreshTerms(w);
expect('QRG view of KAN, Ban parties', parts('QRG', 'KAN')['Ban parties'], -30);
game.addDecree('KAN', 'Legalise the parties', communism);
rel.refreshTerms(w);
expect('KAN Ban parties held after legalising', w.government.byPolity.get('KAN').decrees.filter((x) => x.decree === 'Ban parties').length, 0);
expect('QRG view of KAN, Ban parties after legalising', parts('QRG', 'KAN')['Ban parties'], undefined);
expect('QRG view of KAN, Ban parties, ended', parts('QRG', 'KAN')['Ban parties, ended'], -30);

// Stance against Virupa, held by Vosennac for its year: its own view only, to -30, then fading 10 a year.
const stanceLabel = 'stance against ' + short('VRP');
game.addDecree('VOS', 'Stance on POLITY_NAME', 'VRP', 'against');
for (let i = 0; i < 365; i++) { rel.growHistory(w); acts.dailyActs(w); }
rel.refreshTerms(w);
expect('VOS Stance on Virupa held after a year', w.government.byPolity.get('VOS').decrees.filter((x) => x.decree === 'Stance on POLITY_NAME').length, 0);
expect('VOS view of VRP, ' + stanceLabel, parts('VOS', 'VRP')[stanceLabel], -30);
expect('VRP view of VOS, stance', Object.keys(parts('VRP', 'VOS')).filter((l) => l.startsWith('stance')).length, 0);
expect('VOS view of VRP, a lingering stance', Object.keys(parts('VOS', 'VRP')).filter((l) => l.endsWith(', ended')).length, 0);
for (let i = 0; i < 365; i++) rel.growHistory(w);
rel.refreshTerms(w);
expect('VOS view of VRP, ' + stanceLabel + ' a year on', parts('VOS', 'VRP')[stanceLabel], -20);

console.log('');
if (problems.length) {
  console.log(`${problems.length} problem(s):\n`);
  for (const [where, err] of problems) console.log(`  [${where}] ${err.message}`);
  process.exitCode = 1;
} else {
  console.log('no problems');
}
process.exit();
