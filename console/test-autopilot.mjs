import {
  normalizeMode, filtersAreSaved, canEnableAutopilot,
  autoVerifiesUploads, autoFindsPeople, revealSpendFromEvents, pickRevealIds,
} from './autopilot.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(extra ? `${name} (${extra})` : name);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

eq('unknown mode is refused', normalizeMode('full-auto'), null);
eq('Autopilot is a real mode', normalizeMode('autopilot'), 'autopilot');
ok('blank Find is not saved', !filtersAreSaved({}));
ok('oryoniq Find is saved', filtersAreSaved({ product: 'oryoniq' }));
ok('cannot enable Autopilot without filters', !canEnableAutopilot({ find: {} }).ok);
ok('can enable Autopilot with filters', canEnableAutopilot({ find: { product: 'oryoniq' } }).ok);
ok('manual does not auto-verify CSVs', !autoVerifiesUploads('manual'));
ok('hybrid auto-verifies CSVs', autoVerifiesUploads('hybrid'));
ok('only Autopilot auto-finds', autoFindsPeople('autopilot') && !autoFindsPeople('hybrid'));

const start = '2026-09-11T00:00:00.000Z';
eq('today spend counts payload ids', revealSpendFromEvents([
  { action: 'reveal_requested', at: '2026-09-11T12:00:00.000Z', payload: { ids: ['a', 'b'] } },
  { action: 'reveal_requested', at: '2026-09-10T12:00:00.000Z', payload: { ids: ['old'] } },
  { action: 'send', at: '2026-09-11T12:00:00.000Z', payload: { ids: ['nope'] } },
], start), 2);

const people = [
  { apollo_id: 'heldalready' },
  { apollo_id: 'new1' },
  { apollo_id: 'new2' },
  { apollo_id: '' },
];
eq('skips people we already hold', pickRevealIds(people, { heldIds: new Set(['heldalready']), remaining: 25, cap: 25 }).join(','), 'new1,new2');
eq('respects remaining cap', pickRevealIds(people, { heldIds: new Set(), remaining: 1, cap: 25 }).length, 1);
eq('zero remaining spends nothing', pickRevealIds(people, { heldIds: new Set(), remaining: 0, cap: 25 }).length, 0);

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'}: ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('failing:', fails.join(' | ')); process.exit(1); }
