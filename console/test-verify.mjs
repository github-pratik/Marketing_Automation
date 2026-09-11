// Offline proof that Reoon mapping and batch grouping match intake.
// Reads the functions the console uses — not a retyped copy.

import {
  classifyReoon, stateForAction, groupHeldLeads,
  isHeldForPerson, isUnverifiedHeld, isDeletableFromLoad,
} from './verify.mjs';

let pass = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; return; }
  fails.push(extra ? `${name} (${extra})` : name);
};
const eq = (name, got, want) => ok(name, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

eq('safe is pass', classifyReoon('safe').action, 'pass');
eq('valid is pass', classifyReoon('valid').action, 'pass');
eq('invalid is drop', classifyReoon('invalid').action, 'drop');
eq('spamtrap is drop', classifyReoon('spamtrap').action, 'drop');
eq('disposable is needs_review, not drop', classifyReoon('disposable').action, 'needs_review');
eq('catch_all is needs_review', classifyReoon('catch_all').action, 'needs_review');
eq('unknown is needs_review', classifyReoon('').action, 'needs_review');
eq('pass writes not_sent so the runner can claim it', stateForAction('pass').channel_state_email, 'not_sent');
eq('pass verify_action is pass', stateForAction('pass').verify_action, 'pass');
eq('drop is dropped', stateForAction('drop').channel_state_email, 'dropped');
eq('needs_review stays needs_review', stateForAction('needs_review').channel_state_email, 'needs_review');

const csv = { id: 'a', batch_id: 'abc123', batch_label: 'Testing_Data.csv', channel_state_email: 'pending_approval', verify_action: 'unverified' };
const csv2 = { id: 'b', batch_id: 'abc123', batch_label: 'Testing_Data.csv', channel_state_email: 'pending_approval', verify_action: 'unverified' };
const typed = { id: 'c', batch_id: '', batch_label: '', channel_state_email: 'pending_approval', verify_action: 'unverified' };
const groups = groupHeldLeads([csv, csv2, typed]);
eq('one CSV load is one group', groups[0].leads.length, 2);
eq('  named from the file', groups[0].label, 'Testing_Data.csv');
eq('typed lead is its own group', groups[1].leads.length, 1);

ok('held pending is held', isHeldForPerson(csv));
ok('held unverified is the Reoon target', isUnverifiedHeld(csv));
ok('catch-all already judged is not re-spent', !isUnverifiedHeld({ ...csv, verify_action: 'needs_review', channel_state_email: 'needs_review' }));
ok('enrolled is not bulk-deleted with the load', !isDeletableFromLoad({ ...csv, channel_state_email: 'enrolled' }));
ok('pending load can be deleted', isDeletableFromLoad(csv));

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'}: ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('failing:', fails.join(' | ')); process.exit(1); }
