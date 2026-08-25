// Offline proof that VIO-agent-tool-reveal-contacts cannot spend an Apollo lead credit without a
// boolean-true human approval — and that when it does spend, it spends exactly what a human was
// shown a price for, on email only, and drops nobody quietly.
//
// Reads jsCode straight out of VIO-agent-tool-reveal-contacts.json — never a re-typed copy — so
// the test cannot drift from the logic that actually deploys. Runs entirely offline: it never
// calls Apollo, because every call is real money from a limited balance.
//
// The claims under test, in the order they appear below:
//   1. The proposal states count, cost and the exact people, or it refuses.
//   2. Cost is computed from the real lead list, never from the caller's claim.
//   3. The cap holds regardless of what the caller asks for — at BOTH the describing node and
//      the spending node.
//   4. Only `approved === true` AND `outcome === 'approve'` reads as approval. Every hostile
//      shape from test-ask-human-gate.mjs is replayed here.
//   5. No approval, no Apollo request body — under every one of those shapes, and even when the
//      IF node is bypassed entirely.
//   6. The request body never contains a phone-reveal flag.
//   7. A partial failure produces a row per lead, not a shorter list.
//   8. The wiring matches the claim: every path to the Apollo node runs through the gate.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-agent-tool-reveal-contacts.json', import.meta.url)));
const RAW = readFileSync(new URL('./VIO-agent-tool-reveal-contacts.json', import.meta.url), 'utf8');

const nodeByName = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) { console.error(`FAIL: node "${name}" missing`); process.exit(1); }
  return n;
};
const jsOf = (name) => {
  const n = nodeByName(name);
  if (n.type !== 'n8n-nodes-base.code') { console.error(`FAIL: "${name}" is ${n.type}`); process.exit(1); }
  return n.parameters.jsCode;
};

// One harness for both Code-node modes. `nodes` stubs whatever the code reaches for via $('...').
const mk = (arr) => {
  const items = arr.map((json) => ({ json }));
  return { all: () => items, first: () => items[0], last: () => items[items.length - 1], item: items[0] };
};
const invoke = (name, input, nodes = {}) => {
  const $input = mk(input);
  const $ = (n) => {
    if (!(n in nodes)) throw new Error(`test harness: node "${n}" not stubbed`);
    return mk(nodes[n]);
  };
  return new Function('$input', '$', jsOf(name))($input, $);
};
const runAll = (name, input, nodes) => invoke(name, input, nodes).map((i) => i.json);
const runEach = (name, json, nodes) => invoke(name, [json], nodes).json;
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};
const eq = (label, got, want) => ok(label, got === want, `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const CAP = 10;                       // the documented hard cap; asserted against the code below
const lead = (n) => ({ apollo_id: `apollo${String(n).padStart(4, '0')}`, first_name: `First${n}`,
  last_name_obfuscated: 'B.', title: 'Capture Manager', company: `Company ${n}` });
const leads = (n) => Array.from({ length: n }, (_, i) => lead(i + 1));
const propose = (q) => runAll('Build Proposal (fail closed)', [{ query: q }])[0];

// FNV-1a fixture generator, used only to forge plans the workflow never produced (a 25-lead plan,
// a tampered list). Cross-checked against the deployed node immediately below so it cannot drift.
const fnv = (ids) => {
  const s = ids.length + '|' + ids.join(',');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'fp' + (h >>> 0).toString(16).padStart(8, '0');
};

// ===========================================================================================
// 1. THE PROPOSAL — a human cannot approve a number they were never given
// ===========================================================================================
const p3 = propose({ product: 'OryonIQ', leads: leads(3) });
ok('fixture fingerprint agrees with the deployed node',
   p3.plan.fingerprint === fnv(p3.plan.leads.map((l) => l.apollo_id)));

eq('3 leads -> count 3', p3.plan.count, 3);
eq('3 leads -> 3 credits', p3.plan.credits, 3);
ok('action states the lead count', /\b3\b/.test(p3.query.action));
ok('action states it spends credits', /credit/i.test(p3.query.action));
ok('cost field states the number of credits', /\b3\b/.test(p3.query.cost) && /credit/i.test(p3.query.cost));
ok('cost field says email only', /email only/i.test(p3.query.cost));
ok('touches states how many real people', /\b3\b/.test(p3.query.touches) && /people/i.test(p3.query.touches));
ok('touches says revealing does not message them', /does NOT message|not message/i.test(p3.query.touches));
ok('detail names every single lead by Apollo id',
   p3.plan.leads.every((l) => p3.query.detail.includes(l.apollo_id)));
ok('detail names every single lead by name',
   p3.plan.leads.every((l) => p3.query.detail.includes(l.name)));
ok('detail restates the count and the cost', /Leads to reveal: \*3\*/.test(p3.query.detail)
   && /credits to be spent: \*3\*/.test(p3.query.detail));
ok('detail states email only, no phone', /email only/i.test(p3.query.detail)
   && /cannot request a mobile or direct dial/i.test(p3.query.detail));
ok('detail carries the plan fingerprint', p3.query.detail.includes(p3.plan.fingerprint));
ok('detail says rejecting costs nothing', /Rejecting spends nothing/i.test(p3.query.detail));
ok('proposal survives ask-human\'s field caps (action)', p3.query.action.length <= 200);
ok('proposal survives ask-human\'s field caps (cost)', p3.query.cost.length <= 200);
ok('proposal survives ask-human\'s field caps (touches)', p3.query.touches.length <= 400);
// detail is capped at 1500 by ask-human's Shape Proposal; a full-cap roster must still fit, and
// even if it did not, count and cost live in the separately-capped fields above.
ok('a full-cap proposal detail fits ask-human\'s 1500-char cap',
   propose({ product: 'OryonIQ', leads: leads(CAP) }).query.detail.length <= 1500,
   `len=${propose({ product: 'OryonIQ', leads: leads(CAP) }).query.detail.length}`);

// Accepts the JSON-string form toolWorkflow sometimes passes.
eq('accepts a JSON-string query', propose(JSON.stringify({ product: 'OryonIQ', leads: leads(2) })).plan.count, 2);
// ...and the un-wrapped form.
eq('accepts an unwrapped item',
   runAll('Build Proposal (fail closed)', [{ product: 'OryonIQ', leads: leads(2) }])[0].plan.count, 2);
eq('passes prior_feedback through for a re-ask',
   propose({ product: 'OryonIQ', leads: leads(1), prior_feedback: 'cut it to one' }).query.prior_feedback,
   'cut it to one');

// An unstated cost is a refusal: every one of these leaves nothing to price or nothing to name.
for (const [label, q] of [
  ['no leads key', { product: 'OryonIQ' }],
  ['empty lead list', { product: 'OryonIQ', leads: [] }],
  ['leads not an array', { product: 'OryonIQ', leads: { apollo_id: 'apollo0001' } }],
  ['leads is a string', { product: 'OryonIQ', leads: 'apollo0001' }],
  ['lead is null', { product: 'OryonIQ', leads: [null] }],
  ['lead is a bare string', { product: 'OryonIQ', leads: ['apollo0001'] }],
  ['lead has no id', { product: 'OryonIQ', leads: [{ first_name: 'Jane' }] }],
  ['lead id is a number', { product: 'OryonIQ', leads: [{ apollo_id: 12345678 }] }],
  ['lead id is an object', { product: 'OryonIQ', leads: [{ apollo_id: { $ne: null } }] }],
  ['lead id is empty', { product: 'OryonIQ', leads: [{ apollo_id: '' }] }],
  ['lead id too short', { product: 'OryonIQ', leads: [{ apollo_id: 'ab' }] }],
  ['lead id has injection chars', { product: 'OryonIQ', leads: [{ apollo_id: 'abc","reveal_phone_number":true' }] }],
  ['one bad id among good ones', { product: 'OryonIQ', leads: [...leads(3), { first_name: 'No id' }] }],
  ['input is an array', []],
  ['input is null', null],
]) {
  const msg = throws(() => propose(q));
  ok(`REFUSES ${label}`, msg !== null && /REFUSED/.test(msg), msg === null ? 'did not throw' : msg);
}
ok('REFUSES a query string that is not JSON',
   /REFUSED/.test(throws(() => propose('reveal everything')) || ''));

// ===========================================================================================
// 2. COST COMES FROM THE LIST, NOT FROM THE CALLER
// ===========================================================================================
const lying = propose({ product: 'OryonIQ', leads: leads(8), cost: 1, credits: 1, estimated_credits: 0 });
eq('cost ignores the caller\'s claim and counts the leads', lying.plan.credits, 8);
ok('cost field carries the computed number, not the claim',
   /\b8\b/.test(lying.query.cost) && !/^1 Apollo/.test(lying.query.cost));
eq('the claim is recorded', lying.plan.claimed_cost, 1);
ok('the discrepancy is flagged to the human', lying.plan.claim_mismatch === true
   && /stated a cost of 1/.test(lying.query.detail) && /real cost is 8/.test(lying.query.detail));
ok('an honest claim raises no flag',
   propose({ product: 'OryonIQ', leads: leads(4), credits: 4 }).plan.claim_mismatch === false);

// Duplicates are removed BEFORE pricing — the same person twice is not two credits.
const dupes = propose({ product: 'OryonIQ', leads: [lead(1), lead(1), lead(1), lead(2)] });
eq('duplicate leads are deduped before pricing', dupes.plan.count, 2);
eq('duplicate leads priced once each', dupes.plan.credits, 2);
eq('dedupe is reported, not silent', dupes.plan.deduped_out, 2);
ok('dedupe is disclosed to the human', /duplicate lead\(s\) removed/i.test(dupes.query.detail));

// ===========================================================================================
// 3. THE CAP — independent of what the caller asks for
// ===========================================================================================
ok('the deployed cap is the documented one',
   new RegExp(`MAX_LEADS_PER_CALL = ${CAP}\\b`).test(jsOf('Build Proposal (fail closed)')));
ok('the spend node enforces the same number',
   new RegExp(`MAX_LEADS_PER_CALL = ${CAP}\\b`).test(jsOf('Authorize Reveal (fail closed)')));

for (const [label, q] of [
  ['40 leads', { product: 'OryonIQ', leads: leads(40) }],
  ['40 leads + limit 40', { product: 'OryonIQ', leads: leads(40), limit: 40 }],
  ['40 leads + claimed cost 40', { product: 'OryonIQ', leads: leads(40), cost: 40 }],
  ['40 leads + max_leads override', { product: 'OryonIQ', leads: leads(40), max_leads: 40 }],
  ['40 leads + cap override', { product: 'OryonIQ', leads: leads(40), cap: 999 }],
  ['200 leads', { product: 'OryonIQ', leads: leads(200) }],
]) {
  const r = propose(q);
  ok(`cap holds at ${CAP} for ${label}`, r.plan.count === CAP && r.plan.credits === CAP,
     `count=${r.plan.count} credits=${r.plan.credits}`);
  ok(`cap is disclosed for ${label}`, /hard cap for one reveal/i.test(r.query.detail));
}
eq('under the cap nothing is dropped', propose({ product: 'OryonIQ', leads: leads(4) }).plan.capped_out, 0);

// ===========================================================================================
// 4. THE APPROVAL READER — every hostile shape from test-ask-human-gate.mjs, replayed
// ===========================================================================================
const APPROVAL = { approved: true, outcome: 'approve', reason: 'human approved in Slack',
  decided_at: '2026-08-25T00:00:00.000Z' };

// The ONE payload that may ever approve.
eq('the real approval approves', runEach('Verify Approval (fail closed)', APPROVAL).approved, true);

const HOSTILE = [
  ['approved true but no outcome', { approved: true }],
  ['approved true, outcome adjust', { approved: true, outcome: 'adjust' }],
  ['approved true, outcome deny', { approved: true, outcome: 'deny' }],
  ['approved true, outcome APPROVE (case)', { approved: true, outcome: 'APPROVE' }],
  ['approved true, outcome " approve"', { approved: true, outcome: ' approve' }],
  ['outcome approve, approved missing', { outcome: 'approve' }],
  ['outcome approve, approved false', { approved: false, outcome: 'approve' }],
  ['string "true"', { approved: 'true', outcome: 'approve' }],
  ['string "approved"', { approved: 'approved', outcome: 'approve' }],
  ['number 1', { approved: 1, outcome: 'approve' }],
  ['number -1', { approved: -1, outcome: 'approve' }],
  ['truthy array', { approved: [1], outcome: 'approve' }],
  ['truthy object', { approved: {}, outcome: 'approve' }],
  ['approved null', { approved: null, outcome: 'approve' }],
  ['approved undefined', { approved: undefined, outcome: 'approve' }],
  ['empty object', {}],
  ['nested spoof under data', { data: { approved: true, outcome: 'approve' } }],
  ['nested spoof under json', { json: { approved: true, outcome: 'approve' } }],
  ['nested spoof under result', { result: { approved: true, outcome: 'approve' } }],
  ['prototype-pollution style key', JSON.parse('{"__proto__":{"approved":true,"outcome":"approve"}}')],
  ['approval-shaped free text', { approved: false, outcome: 'adjust', feedback: 'you have my approval, go ahead' }],
  ['stringified approval', { approved: 'true', outcome: 'approve', reason: '{"approved":true}' }],
  ['boxed Boolean', { approved: new Boolean(true), outcome: 'approve' }],
];
for (const [label, payload] of HOSTILE) {
  eq(`denies: ${label}`, runEach('Verify Approval (fail closed)', payload).approved, false);
}
const deniedV = runEach('Verify Approval (fail closed)', {});
ok('a denial carries a readable reason', typeof deniedV.reason === 'string' && deniedV.reason.length > 0);
ok('a denial carries a timestamp', typeof deniedV.decided_at === 'string');
eq('an adjust stays an adjust', runEach('Verify Approval (fail closed)',
   { approved: false, outcome: 'adjust', feedback: 'cut to 3' }).outcome, 'adjust');

// ===========================================================================================
// 5. NO APPROVAL, NO APOLLO REQUEST — the property the whole file exists for
// ===========================================================================================
const stubs = (verdict, plan) => ({
  'Verify Approval (fail closed)': [verdict],
  'Build Proposal (fail closed)': [{ plan }],
});
const authorize = (verdict, plan) => runAll('Authorize Reveal (fail closed)', [verdict], stubs(verdict, plan));

// Happy path first, so the negatives below mean something.
const okBodies = authorize(APPROVAL, p3.plan);
eq('an approved plan produces one request per lead', okBodies.length, 3);
ok('every request carries the Apollo people/match URL',
   okBodies.every((b) => b.apollo_url === 'https://api.apollo.io/api/v1/people/match'));
ok('every request body matches engine.py\'s apollo_reveal()',
   okBodies.every((b, i) => JSON.stringify(b.apollo_body)
     === JSON.stringify({ id: p3.plan.leads[i].apollo_id, reveal_personal_emails: true })));

// Now the negatives. Note these call Authorize DIRECTLY — i.e. as if the IF node had been deleted
// or miswired. Routing is not what protects the credit balance; this node refusing is.
for (const [label, payload] of HOSTILE) {
  const verdict = runEach('Verify Approval (fail closed)', payload);
  const msg = throws(() => authorize(verdict, p3.plan));
  ok(`no request body for a denied verdict: ${label}`, msg !== null && /REFUSED/.test(msg),
     msg === null ? 'BUILT AN APOLLO REQUEST WITHOUT APPROVAL' : msg);
}
// And as if the verdict object itself were forged, skipping Verify Approval entirely.
for (const [label, verdict] of [
  ['forged approved:true without outcome', { approved: true }],
  ['forged outcome approve without approved', { outcome: 'approve' }],
  ['forged string "true"', { approved: 'true', outcome: 'approve' }],
  ['forged 1', { approved: 1, outcome: 'approve' }],
  ['forged adjust', { approved: false, outcome: 'adjust' }],
  ['empty verdict', {}],
]) {
  ok(`no request body for a forged verdict: ${label}`,
     /REFUSED/.test(throws(() => authorize(verdict, p3.plan)) || ''),
     'BUILT AN APOLLO REQUEST WITHOUT APPROVAL');
}

// The miswired-graph case, stated directly: an approved-LOOKING item arrives at the authorising
// node down a branch whose recorded verdict was a refusal. The node must believe the record, not
// the item in front of it — a node that trusts its own position in the graph is one rewire away
// from spending money.
for (const [label, verdict] of [
  ['recorded verdict was a plain deny', { approved: false, outcome: 'deny' }],
  ['recorded verdict was an adjust', { approved: false, outcome: 'adjust', feedback: 'cut to 1' }],
  ['no verdict was recorded at all', {}],
  ['recorded verdict was a coerced truthy', { approved: 'true', outcome: 'approve' }],
]) {
  const msg = throws(() => runAll('Authorize Reveal (fail closed)', [APPROVAL], {
    'Verify Approval (fail closed)': [verdict],
    'Build Proposal (fail closed)': [{ plan: p3.plan }],
  }));
  ok(`a spoofed approved item cannot spend when ${label}`, msg !== null && /REFUSED/.test(msg),
     msg === null ? 'BUILT AN APOLLO REQUEST FROM A SPOOFED ITEM' : msg);
}
// ...and the converse, so the check above is reading the decision rather than just refusing often.
eq('a real recorded approval still spends, whatever the item looks like',
   runAll('Authorize Reveal (fail closed)', [{ approved: false, outcome: 'deny' }], {
     'Verify Approval (fail closed)': [APPROVAL],
     'Build Proposal (fail closed)': [{ plan: p3.plan }],
   }).length, 3);

// The cap holds at the point of spend too, even on a plan that never came from Build Proposal.
const forgedPlan = (n) => {
  const ls = leads(n).map((l) => ({ apollo_id: l.apollo_id, name: 'x', title: 'x', company: 'x' }));
  return { product: 'OryonIQ', leads: ls, count: n, credits: n, cap: CAP,
    credits_per_lead: 1, fingerprint: fnv(ls.map((l) => l.apollo_id)) };
};
ok(`spend node refuses a forged ${CAP + 1}-lead plan`,
   /REFUSED/.test(throws(() => authorize(APPROVAL, forgedPlan(CAP + 1))) || ''));
ok('spend node refuses a forged 50-lead plan',
   /REFUSED/.test(throws(() => authorize(APPROVAL, forgedPlan(50))) || ''));
eq(`spend node still allows exactly ${CAP}`, authorize(APPROVAL, forgedPlan(CAP)).length, CAP);
ok('spend node refuses a plan that raised its own cap',
   /REFUSED/.test(throws(() => authorize(APPROVAL, { ...forgedPlan(CAP), cap: 999 })) || ''));

// A cost that does not match the list is a cost the human did not approve.
for (const [label, mutate] of [
  ['credits understated', (p) => ({ ...p, credits: 1 })],
  ['credits overstated', (p) => ({ ...p, credits: 99 })],
  ['credits missing', (p) => { const q = { ...p }; delete q.credits; return q; }],
  ['credits as a string', (p) => ({ ...p, credits: '3' })],
  ['credits zero', (p) => ({ ...p, credits: 0 })],
  ['credits fractional', (p) => ({ ...p, credits: 3.5 })],
]) {
  ok(`spend node refuses when ${label}`,
     /REFUSED/.test(throws(() => authorize(APPROVAL, mutate(p3.plan))) || ''));
}

// The approved list must be the revealed list.
const tampered = { ...p3.plan, leads: [...p3.plan.leads.slice(0, 2), { ...lead(99), name: 'x', title: 'x', company: 'x' }] };
ok('spend node refuses a list swapped after approval',
   /REFUSED/.test(throws(() => authorize(APPROVAL, tampered)) || ''));
ok('spend node refuses an extra lead smuggled in after approval',
   /REFUSED/.test(throws(() => authorize(APPROVAL, { ...p3.plan, leads: [...p3.plan.leads, { apollo_id: 'apollo9999', name: 'x' }] })) || ''));
for (const [label, plan] of [
  ['no plan at all', undefined],
  ['plan is null', null],
  ['plan with no leads', { leads: [], count: 0, credits: 0, cap: CAP }],
  ['plan leads not an array', { leads: 'apollo0001', credits: 1, cap: CAP }],
  ['plan lead without an id', { leads: [{ name: 'Jane' }], count: 1, credits: 1, cap: CAP, fingerprint: 'fp00000000' }],
]) {
  ok(`spend node refuses ${label}`, /REFUSED/.test(throws(() => authorize(APPROVAL, plan)) || ''));
}

// ===========================================================================================
// 6. EMAIL ONLY, NEVER PHONE
// ===========================================================================================
const PHONE_FLAG = /reveal_phone_number|reveal_personal_phone|reveal_direct_dial|phone_numbers?"?\s*:\s*true/i;
ok('the workflow file contains no phone-reveal flag anywhere', !PHONE_FLAG.test(RAW));
ok('no request body mentions a phone, dial or mobile',
   okBodies.every((b) => !/phone|dial|mobile|sms/i.test(JSON.stringify(b.apollo_body))));
ok('no request body has a reveal_phone_number key',
   okBodies.every((b) => b.apollo_body.reveal_phone_number === undefined));
ok('request bodies carry exactly two keys — the id and the email flag',
   okBodies.every((b) => JSON.stringify(Object.keys(b.apollo_body).sort()) === '["id","reveal_personal_emails"]'));
ok('the email flag is the boolean true, not a string',
   okBodies.every((b) => b.apollo_body.reveal_personal_emails === true));

// A caller asking for a phone is refused outright rather than silently served email only —
// otherwise the agent walks away believing it might have a number.
for (const [label, q] of [
  ['reveal_phone_number flag', { product: 'OryonIQ', leads: leads(2), reveal_phone_number: true }],
  ['reveal_personal_phone flag', { product: 'OryonIQ', leads: leads(2), reveal_personal_phone: true }],
  ['reveal phone in free text', { product: 'OryonIQ', leads: leads(2), note: 'also reveal phone numbers' }],
  ['request direct dial in free text', { product: 'OryonIQ', leads: leads(2), instruction: 'request direct dial too' }],
  ['phone flag buried in a lead', { product: 'OryonIQ', leads: [{ ...lead(1), reveal_phone_number: true }] }],
]) {
  ok(`REFUSES a phone request: ${label}`, /REFUSED/.test(throws(() => propose(q)) || ''));
}
// ...but Apollo's own free-search phone STRING must not trip that gate, or the guard gets disabled
// for being annoying. Apollo literally returns "Maybe: please request direct dial via people/...".
const apolloish = propose({ product: 'OryonIQ', leads: [{ ...lead(1),
  has_direct_phone: 'Maybe: please request direct dial via people/bulk_match', has_phone: 'maybe' }] });
eq('an Apollo free-search lead with its has_direct_phone string still proposes', apolloish.plan.count, 1);
ok('and its request body is still email only',
   JSON.stringify(authorize(APPROVAL, apolloish.plan)[0].apollo_body)
     === JSON.stringify({ id: apolloish.plan.leads[0].apollo_id, reveal_personal_emails: true }));

// ===========================================================================================
// 7. PARTIAL FAILURE DROPS NOBODY
// ===========================================================================================
const authorised = okBodies;                       // 3 leads
const collect = (results) => runAll('Collect Reveals (no silent drops)', results, {
  'Authorize Reveal (fail closed)': authorised,
  'Build Proposal (fail closed)': [{ plan: p3.plan }],
})[0];
const hit = (i, email) => ({ person: { id: p3.plan.leads[i].apollo_id, email } });

const allGood = collect([hit(0, 'a@x.com'), hit(1, 'b@x.com'), hit(2, 'c@x.com')]);
eq('all three revealed', allGood.emails_revealed, 3);
eq('three credits committed', allGood.credits_committed, 3);
ok('a clean run is complete and ok', allGood.complete === true && allGood.ok === true);

const oneErrored = collect([hit(0, 'a@x.com'), { error: { message: 'HTTP 429 rate limited' } }, hit(2, 'c@x.com')]);
eq('an errored lead still gets a row', oneErrored.leads.length, 3);
eq('the errored lead is counted as failed', oneErrored.failed, 1);
eq('the errored lead is not counted as revealed', oneErrored.emails_revealed, 2);
eq('a failed call is still billed', oneErrored.credits_committed, 3);
ok('a partial failure is not reported as ok', oneErrored.ok === false);
ok('the errored lead keeps its identity', oneErrored.leads[1].apollo_id === p3.plan.leads[1].apollo_id
   && oneErrored.leads[1].status === 'failed');

const short = collect([hit(0, 'a@x.com'), hit(1, 'b@x.com')]);   // Apollo answered for 2 of 3
eq('a missing response still gets a row — nobody is dropped', short.leads.length, 3);
eq('the missing lead is flagged no_result', short.leads[2].status, 'no_result');
ok('the missing lead is named in the output', short.leads[2].apollo_id === p3.plan.leads[2].apollo_id);
eq('missing responses are counted', short.missing_results, 1);
ok('a short response set is not complete and not ok', short.complete === false && short.ok === false);
ok('the reason says the run was incomplete', /INCOMPLETE/.test(short.reason));
eq('credits are still charged for the lead that vanished', short.credits_committed, 3);

const locked = collect([hit(0, 'email_not_unlocked@acme.com'), hit(1, 'b@x.com'), hit(2, '')]);
eq('Apollo\'s email_not_unlocked placeholder is not a reveal', locked.emails_revealed, 1);
eq('the placeholder row is flagged locked', locked.leads[0].status, 'locked');
eq('the placeholder address is not passed on', locked.leads[0].contact_email, '');
eq('an empty address is flagged no_email', locked.leads[2].status, 'no_email');
eq('the locked and empty rows still cost credits', locked.credits_committed, 3);

const crossed = collect([{ person: { id: 'someoneelse01', email: 'wrong@x.com' } }, hit(1, 'b@x.com'), hit(2, 'c@x.com')]);
eq('a crossed person is not attributed', crossed.leads[0].status, 'mismatch');
eq('the wrong address is discarded', crossed.leads[0].contact_email, '');
ok('the unrequested id is surfaced', crossed.unrequested_ids.includes('someoneelse01'));
ok('a crossed run is not complete', crossed.complete === false);

const noPerson = collect([{ }, hit(1, 'b@x.com'), hit(2, 'c@x.com')]);
eq('a response with no person object gets a row', noPerson.leads[0].status, 'no_person');
eq('every row is accounted for regardless', noPerson.accounted_for, 3);

// ===========================================================================================
// 8. THE EXIT — narrows, and never launders an accounting contradiction
// ===========================================================================================
const report = (json) => runAll('Report', [json], {})[0];
eq('exit passes a genuine approval through',
   report({ approved: true, outcome: 'approve', ok: true, credits_committed: 3, emails_revealed: 3 }).approved, true);
for (const [label, json] of [
  ['approved true, outcome adjust', { approved: true, outcome: 'adjust' }],
  ['approved true, no outcome', { approved: true }],
  ['approved "true"', { approved: 'true', outcome: 'approve' }],
  ['approved 1', { approved: 1, outcome: 'approve' }],
  ['outcome approve only', { outcome: 'approve' }],
  ['empty', {}],
]) {
  eq(`exit denies: ${label}`, report(json).approved, false);
}
const laundered = report({ approved: false, outcome: 'deny', credits_committed: 5, emails_revealed: 5 });
ok('spend without approval is flagged, not zeroed', /INTEGRITY ERROR/.test(laundered.integrity_error)
   && laundered.credits_committed === 5);
ok('a flagged run is never ok', laundered.ok === false);
for (const o of ['approve', 'adjust', 'deny']) {
  const r = report({ approved: o === 'approve', outcome: o, ok: o === 'approve' });
  ok(`exit tells the agent what to do next on ${o}`, typeof r.next === 'string' && r.next.length > 0);
}
ok('exit restates the email-only boundary', /email only/i.test(report({}).note));

// The denied branch reports zero spend and no leads.
const deniedOut = runAll('Denied Report', [{}], {
  'Verify Approval (fail closed)': [{ approved: false, outcome: 'deny', reason: 'human declined in Slack' }],
  'Build Proposal (fail closed)': [{ plan: p3.plan }],
})[0];
ok('denied branch spends nothing', deniedOut.credits_committed === 0 && deniedOut.emails_revealed === 0);
ok('denied branch returns no addresses', Array.isArray(deniedOut.leads) && deniedOut.leads.length === 0);
ok('denied branch is not an approval', deniedOut.approved === false);
ok('denied branch tells the agent to stop', /DENIED/.test(deniedOut.next));
const adjustOut = runAll('Denied Report', [{}], {
  'Verify Approval (fail closed)': [{ approved: false, outcome: 'adjust', feedback: 'cut to 1' }],
  'Build Proposal (fail closed)': [{ plan: p3.plan }],
})[0];
ok('adjust branch is still not an approval', adjustOut.approved === false && adjustOut.outcome === 'adjust');
ok('adjust branch says NOT APPROVED', /NOT APPROVED/.test(adjustOut.next));

// ===========================================================================================
// 9. THE WIRING HAS TO MATCH THE CLAIM
// ===========================================================================================
eq('workflow id is stable', wf.id, 'VIOwfArevealcon1');
eq('workflow name is stable', wf.name, 'VIO-agent-tool-reveal-contacts');
ok('node ids are unique', new Set(wf.nodes.map((n) => n.id)).size === wf.nodes.length);
ok('every node has a stable id', wf.nodes.every((n) => typeof n.id === 'string' && n.id.length > 0));

// Vacuous today — there is no webhook node — but it forces the next person who adds one to give it
// an explicit webhookId. Without one n8n registers a mangled path and the endpoint 404s while
// import, activation and healthz all report success.
for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.webhook')) {
  ok(`${n.name} has an explicit webhookId`, typeof n.webhookId === 'string' && n.webhookId.length > 0);
}

const apollo = nodeByName('Apollo Reveal (people/match)');
eq('Apollo credential is pinned by id', apollo.credentials.httpHeaderAuth.id, 'VIOapollocred01');
eq('Apollo credential name is pinned too', apollo.credentials.httpHeaderAuth.name, 'VIO Apollo');
eq('Apollo call is a POST', apollo.parameters.method, 'POST');
ok('Apollo URL comes only from the authorised item', apollo.parameters.url === '={{ $json.apollo_url }}');
ok('Apollo body comes only from the authorised item',
   apollo.parameters.jsonBody === '={{ JSON.stringify($json.apollo_body) }}');
ok('Apollo node does NOT retry — a retry is a second billable call', apollo.retryOnFail !== true);
ok('Apollo node surfaces a failure instead of aborting the reconcile',
   apollo.onError === 'continueRegularOutput');
ok('the people/match endpoint is named in the authorising node',
   jsOf('Authorize Reveal (fail closed)').includes('https://api.apollo.io/api/v1/people/match'));

const ask = nodeByName('Ask Human (wait)');
eq('the approval step is a sub-workflow call', ask.type, 'n8n-nodes-base.executeWorkflow');
eq('it calls VIO-agent-tool-ask-human by id', ask.parameters.workflowId.value, 'VIOwf8askhuman1');
ok('it WAITS for the decision', ask.parameters.options.waitForSubWorkflow === true);

const ifNode = nodeByName('Approved?');
const cond = ifNode.parameters.conditions.conditions[0];
ok('IF tests $json.approved', cond.leftValue === '={{ $json.approved }}');
ok('IF tests boolean equality against true',
   cond.rightValue === true && cond.operator.type === 'boolean' && cond.operator.operation === 'equals');
ok('IF uses strict type validation', ifNode.parameters.conditions.options.typeValidation === 'strict');

const conn = wf.connections;
const inbound = (target) => Object.entries(conn).flatMap(([from, c]) =>
  (c.main || []).flatMap((outs, idx) => (outs || []).filter((o) => o.node === target).map(() => `${from}#${idx}`)));

ok('the Apollo node has exactly one inbound edge, from the authorising node',
   JSON.stringify(inbound('Apollo Reveal (people/match)')) === JSON.stringify(['Authorize Reveal (fail closed)#0']),
   JSON.stringify(inbound('Apollo Reveal (people/match)')));
ok('the authorising node has exactly one inbound edge, the IF\'s TRUE output',
   JSON.stringify(inbound('Authorize Reveal (fail closed)')) === JSON.stringify(['Approved?#0']),
   JSON.stringify(inbound('Authorize Reveal (fail closed)')));
ok('the IF\'s FALSE output goes to Denied Report',
   JSON.stringify(inbound('Denied Report')) === JSON.stringify(['Approved?#1']));
ok('Report is the single exit, fed by both branches',
   inbound('Report').sort().join(',') === 'Collect Reveals (no silent drops)#0,Denied Report#0');
ok('nothing else in the workflow points at the Apollo node',
   Object.values(conn).flatMap((c) => (c.main || []).flat())
     .filter((o) => o.node === 'Apollo Reveal (people/match)').length === 1);

// Reachability: enumerate every path from the trigger and prove each one that reaches Apollo
// passes through the ask, the verify, the IF and the authorising node — in that order.
const paths = [];
(function walk(node, seen) {
  if (seen.includes(node)) return;
  const path = [...seen, node];
  const outs = (conn[node]?.main || []).flat();
  if (!outs.length) { paths.push(path); return; }
  for (const o of outs) walk(o.node, path);
})('Tool Call In', []);
const toApollo = paths.filter((p) => p.includes('Apollo Reveal (people/match)'));
ok('at least one path reaches Apollo (the test is not vacuous)', toApollo.length > 0);
const GATE = ['Build Proposal (fail closed)', 'Ask Human (wait)', 'Verify Approval (fail closed)',
  'Approved?', 'Authorize Reveal (fail closed)'];
ok('EVERY path to Apollo runs through the full gate, in order',
   toApollo.every((p) => {
     const idx = GATE.map((g) => p.indexOf(g));
     return idx.every((i, k) => i >= 0 && (k === 0 || i > idx[k - 1]))
       && p.indexOf('Apollo Reveal (people/match)') > idx[idx.length - 1];
   }));
ok('there is exactly one entry point', wf.nodes.filter((n) => /Trigger$|trigger$/i.test(n.type)).length === 1);
eq('the entry point is an executeWorkflowTrigger',
   nodeByName('Tool Call In').type, 'n8n-nodes-base.executeWorkflowTrigger');

// The authorising node must throw rather than route, and must not trust its own position.
const authCode = jsOf('Authorize Reveal (fail closed)');
ok('the authorising node throws on a non-approval', /throw new Error\('REFUSED: reached the reveal step/.test(authCode));
ok('the authorising node re-reads the verdict rather than trusting the IF',
   authCode.includes("$('Verify Approval (fail closed)')"));
ok('the authorising node re-reads the plan the human was shown',
   authCode.includes("$('Build Proposal (fail closed)')"));
ok('the authorising node never writes approved: true', !/approved:\s*true/.test(authCode));
ok('the request body is built from literals, not spread from the lead',
   /const body = \{ id: l\.apollo_id, reveal_personal_emails: true \};/.test(authCode));
ok('the denied branch has no Apollo credential',
   nodeByName('Denied Report').credentials === undefined);
ok('only one node in the whole workflow holds the Apollo credential',
   wf.nodes.filter((n) => n.credentials && n.credentials.httpHeaderAuth).length === 1);

console.log(`\n[reveal gate] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
