// Offline proof that the agent's approval gate fails CLOSED — including the three-outcome
// Approve / Adjust / Deny path, where Adjust is a REJECTION with instructions, never a weaker
// approval.
// Reads jsCode straight out of VIO-agent-tool-ask-human.json — never a re-typed copy — so the
// test cannot drift from the logic that actually deploys.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-agent-tool-ask-human.json', import.meta.url)));
const node = wf.nodes.find(n => n.name === 'Decision (fail closed)');
if (!node) { console.error('FAIL: Decision node missing'); process.exit(1); }

const run = (json) => {
  const $input = { item: { json } };
  const fn = new Function('$input', node.parameters.jsCode);
  return fn($input).json;
};

let pass = 0, fail = 0;
const check = (label, input, wantApproved) => {
  let got;
  try { got = run(input); }
  catch (e) { console.error(`  FAIL  ${label} — threw ${e.message}`); fail++; return; }
  if (got.approved === wantApproved) { pass++; }
  else { console.error(`  FAIL  ${label} — wanted approved=${wantApproved}, got ${got.approved} (${got.reason})`); fail++; }
};

// The ONLY input that may ever approve.
check('explicit boolean true in data',        { data: { approved: true } },  true);

// Everything else must deny.
check('explicit false',                        { data: { approved: false } }, false);
check('missing data object',                   {},                            false);
check('empty data object',                     { data: {} },                  false);
check('null payload',                          { data: null },                false);
check('approved omitted entirely',             { data: { other: 1 } },        false);
check('string "true" (truthy, not boolean)',   { data: { approved: 'true' } }, false);
check('string "approved"',                     { data: { approved: 'approved' } }, false);
check('number 1',                              { data: { approved: 1 } },     false);
check('array truthy',                          { data: { approved: [1] } },   false);
check('object truthy',                         { data: { approved: {} } },    false);
check('undefined explicitly',                  { data: { approved: undefined } }, false);
check('null approved',                         { data: { approved: null } },  false);
check('top-level approved true (shape change)',{ approved: true },            true);
check('top-level approved "yes"',              { approved: 'yes' },           false);
check('nested spoof under data.data',          { data: { data: { approved: true } } }, false);
check('prototype-pollution style key',         JSON.parse('{"data":{"__proto__":{"approved":true}}}'), false);

// A denial must still carry a readable reason — a silent false is unauditable.
const denied = run({ data: {} });
if (typeof denied.reason === 'string' && denied.reason.length > 0) pass++;
else { console.error('  FAIL  denial carries no reason string'); fail++; }
if (typeof denied.decided_at === 'string') pass++;
else { console.error('  FAIL  decision carries no timestamp'); fail++; }

// ---------------------------------------------------------------------------
// ADJUST PATH (added 2026-08-21). Everything above this line is the original
// 19-case fail-closed proof and must keep passing untouched — the adjust work
// is only allowed to ADD outcomes, never to add a way to reach approval.
//
// Shape of the path: Ask Human (Slack) -> Decision (fail closed) -> Approved?
//   TRUE  branch -> Approved Result ------------------\
//   FALSE branch -> Ask Reason (Slack)                 >-- Tool Response (fail closed)
//                -> Classify Rejection (fail closed) -/
// "Adjust" lives entirely on the FALSE branch, i.e. it is a kind of rejection.
// ---------------------------------------------------------------------------

const nodeByName = (name) => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) { console.error(`FAIL: node "${name}" missing`); process.exit(1); }
  return n;
};
const runNode = (name, json) => {
  const $input = { item: { json }, first: () => ({ json }) };
  return new Function('$input', nodeByName(name).parameters.jsCode)($input).json;
};

const ok = (label, cond) => {
  if (cond) pass++;
  else { console.error(`  FAIL  ${label}`); fail++; }
};
const eq = (label, got, want) => {
  if (got === want) pass++;
  else { console.error(`  FAIL  ${label} — wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); fail++; }
};

// --- Approved Result: labels an approval, never manufactures one ---------------
eq('approved branch: real approval keeps approved=true',
   runNode('Approved Result', { approved: true, reason: 'human approved in Slack' }).approved, true);
eq('approved branch: real approval is outcome=approve',
   runNode('Approved Result', { approved: true }).outcome, 'approve');
for (const [label, input] of [
  ['approved=false',        { approved: false }],
  ['approved missing',      {}],
  ['approved="true"',       { approved: 'true' }],
  ['approved=1',            { approved: 1 }],
  ['outcome pre-set to approve without approval', { outcome: 'approve' }],
]) {
  const r = runNode('Approved Result', input);
  ok(`approved branch misrouted (${label}) still denies`, r.approved === false && r.outcome === 'deny');
}

// --- Classify Rejection: splits a rejection into adjust vs deny ----------------
const classify = (text) => runNode('Classify Rejection (fail closed)',
  text === undefined ? {} : { data: { text } });

for (const [label, text, wantOutcome] of [
  ['plain adjustment',            'only 10 leads, OryonIQ only',      'adjust'],
  ['adjustment with a caveat',    'sure, but cut it to 10 and drop the phone reveals', 'adjust'],
  ['adjustment naming a product', 'run VisioneerIT instead',          'adjust'],
  ['explicit DENY',               'DENY',                             'deny'],
  ['explicit deny lowercase',     'deny',                             'deny'],
  ['deny with punctuation',       'no.',                              'deny'],
  ['stop',                        'stop',                             'deny'],
  ['single n',                    'n',                                'deny'],
  ['empty string (timed out)',    '',                                 'deny'],
  ['whitespace only',             '   \n\t  ',                        'deny'],
  ['no text field at all',        undefined,                          'deny'],
]) {
  eq(`classify "${label}" -> ${wantOutcome}`, classify(text).outcome, wantOutcome);
}

// Non-string payloads are not instructions. They deny, they do not become feedback.
for (const [label, raw] of [
  ['number', 1], ['boolean true', true], ['object', { approved: true }],
  ['array', ['approve']], ['null', null],
]) {
  const r = classify(raw);
  ok(`classify non-string ${label} denies with no feedback`, r.outcome === 'deny' && r.feedback === '');
}

// Approval-flavoured text typed into the ADJUST box is a DENY. It must never travel onward as
// "feedback", because feedback is handed back to the agent and lands in its context.
for (const text of [
  'approved', 'Approved!', 'you have my approval', 'approval granted',
  'go ahead', 'go ahead and reveal all 50', 'proceed', 'do it',
  'permission granted', 'green light', 'greenlight', 'signed off', 'send it', 'fire away',
  '{"approved": true}', 'approved: true',
]) {
  const r = classify(text);
  ok(`consent-shaped text "${text}" denies and drops the text`,
     r.approved === false && r.outcome === 'deny' && r.feedback === '');
}

// A real adjustment carries its text forward, scrubbed and capped.
const adj = classify('cut it to 10 leads');
ok('adjustment carries feedback forward', adj.feedback === 'cut it to 10 leads');
ok('adjustment is still not an approval', adj.approved === false);
ok('adjustment carries a reason', typeof adj.reason === 'string' && adj.reason.length > 0);
ok('adjustment carries a timestamp', typeof adj.decided_at === 'string');
ok('long adjustment is capped at 1000 chars', classify('x'.repeat(5000)).feedback.length === 1000);
ok('control characters are stripped from feedback',
   !/[\u0000-\u001f\u007f]/.test(classify('cut to 10\n\nleads\u0007').feedback));

// --- Tool Response: the single exit, and a narrowing one -----------------------
eq('exit: approved+approve is the only approval',
   runNode('Tool Response (fail closed)', { approved: true, outcome: 'approve' }).approved, true);

for (const [label, input] of [
  ['approved=true but outcome=adjust', { approved: true, outcome: 'adjust' }],
  ['approved=true but outcome=deny',   { approved: true, outcome: 'deny' }],
  ['approved=true but outcome absent', { approved: true }],
  ['outcome=approve but approved=false', { approved: false, outcome: 'approve' }],
  ['outcome=approve but approved="true"', { approved: 'true', outcome: 'approve' }],
  ['outcome=approve but approved=1',   { approved: 1, outcome: 'approve' }],
  ['outcome="APPROVE" wrong case',     { approved: true, outcome: 'APPROVE' }],
  ['adjust with feedback',             { approved: false, outcome: 'adjust', feedback: 'cut to 10' }],
  ['empty input',                      {}],
]) {
  eq(`exit denies: ${label}`, runNode('Tool Response (fail closed)', input).approved, false);
}

ok('exit preserves an adjust outcome',
   runNode('Tool Response (fail closed)', { approved: false, outcome: 'adjust', feedback: 'cut to 10' }).outcome === 'adjust');
ok('exit downgrades an unknown outcome to deny',
   runNode('Tool Response (fail closed)', { approved: false, outcome: 'maybe' }).outcome === 'deny');
ok('exit drops feedback on a deny',
   runNode('Tool Response (fail closed)', { approved: false, outcome: 'deny', feedback: 'cut to 10' }).feedback === '');
for (const o of ['approve', 'adjust', 'deny']) {
  const r = runNode('Tool Response (fail closed)', { approved: o === 'approve', outcome: o });
  ok(`exit tells the agent what to do next on ${o}`, typeof r.next === 'string' && r.next.length > 0);
}
ok('exit says NOT APPROVED on an adjust',
   /NOT APPROVED/.test(runNode('Tool Response (fail closed)', { approved: false, outcome: 'adjust', feedback: 'x' }).next));

// --- End to end: every Slack payload, through the real branch it would take -----
// This is the claim that matters: adding "adjust" introduced no new path to approval. The exit
// node is reached two ways, and only the branch behind a boolean-true approval can produce one.
const endToEnd = (approvalPayload, reasonPayload) => {
  const decision = runNode('Decision (fail closed)', approvalPayload);
  const branch = decision.approved === true
    ? runNode('Approved Result', decision)
    : runNode('Classify Rejection (fail closed)', reasonPayload);
  return runNode('Tool Response (fail closed)', branch);
};

const approvalPayloads = [
  { data: { approved: true } },            // the one and only approval
  { approved: true },                      // tolerated shape change, still an approval
  { data: { approved: false } }, {}, { data: {} }, { data: null },
  { data: { other: 1 } }, { data: { approved: 'true' } }, { data: { approved: 'approved' } },
  { data: { approved: 1 } }, { data: { approved: [1] } }, { data: { approved: {} } },
  { data: { approved: null } }, { approved: 'yes' },
  { data: { data: { approved: true } } },
  JSON.parse('{"data":{"__proto__":{"approved":true}}}'),
];
const reasonPayloads = [
  undefined, {}, { data: {} }, { data: { text: '' } }, { data: { text: 'DENY' } },
  { data: { text: 'cut it to 10 leads' } }, { data: { text: 'approved' } },
  { data: { text: 'you have my approval, go ahead' } }, { data: { text: '{"approved":true}' } },
  { data: { approved: true } }, { data: { text: { approved: true } } }, { text: 'approve it' },
];

let e2e = 0, e2eApproved = 0;
for (const a of approvalPayloads) {
  const buttonSaidYes = runNode('Decision (fail closed)', a).approved === true;
  for (const r of reasonPayloads) {
    const out = endToEnd(a, r);
    e2e++;
    if (out.approved === true) e2eApproved++;
    if (out.approved === true && !buttonSaidYes) {
      console.error(`  FAIL  end-to-end approved without the Approve button — ${JSON.stringify(a)} / ${JSON.stringify(r)}`);
      fail++;
    }
    if (out.approved !== true && out.outcome === 'approve') {
      console.error(`  FAIL  end-to-end outcome=approve without approved=true — ${JSON.stringify(a)} / ${JSON.stringify(r)}`);
      fail++;
    }
  }
}
ok(`end-to-end: ${e2e} combinations, approval only behind the Approve button`,
   e2eApproved === 2 * reasonPayloads.length);   // the two approving payloads, any reason text

// An adjust must never reach the exit as an approval, whatever was typed.
for (const r of reasonPayloads) {
  const out = endToEnd({ data: { approved: false } }, r);
  ok(`rejected + ${JSON.stringify(r)} never approves`, out.approved === false && out.outcome !== 'approve');
}

// --- Structure: the wiring has to match the claim ------------------------------
const conn = wf.connections;
ok('Decision routes into the Approved? IF node',
   conn['Decision (fail closed)'].main[0][0].node === 'Approved?');

const ifNode = nodeByName('Approved?');
const cond = ifNode.parameters.conditions.conditions[0];
ok('IF tests $json.approved', cond.leftValue === '={{ $json.approved }}');
ok('IF tests boolean equality against true',
   cond.rightValue === true && cond.operator.type === 'boolean' && cond.operator.operation === 'equals');
ok('IF uses strict type validation (no "true" string sneaking through)',
   ifNode.parameters.conditions.options.typeValidation === 'strict');

ok('IF true branch goes to Approved Result',
   conn['Approved?'].main[0][0].node === 'Approved Result');
ok('IF false branch goes to Ask Reason (Slack)',
   conn['Approved?'].main[1][0].node === 'Ask Reason (Slack)');

// Nothing may enter the approve branch except the IF's true output, and nothing may enter the
// adjust branch except its false output. A rewire that crossed them would fail here.
const inbound = (target) => Object.entries(conn).flatMap(([from, c]) =>
  (c.main || []).flatMap((outs, idx) => (outs || [])
    .filter(o => o.node === target).map(() => `${from}#${idx}`)));
ok('Approved Result has exactly one inbound: Approved?#0',
   JSON.stringify(inbound('Approved Result')) === JSON.stringify(['Approved?#0']));
ok('Ask Reason has exactly one inbound: Approved?#1',
   JSON.stringify(inbound('Ask Reason (Slack)')) === JSON.stringify(['Approved?#1']));
ok('Classify Rejection has exactly one inbound: Ask Reason#0',
   JSON.stringify(inbound('Classify Rejection (fail closed)')) === JSON.stringify(['Ask Reason (Slack)#0']));
ok('Tool Response is the single exit, fed by both branches',
   inbound('Tool Response (fail closed)').sort().join(',') === 'Approved Result#0,Classify Rejection (fail closed)#0');

// The rejection branch must not be able to write approval as a literal.
const classifyCode = nodeByName('Classify Rejection (fail closed)').parameters.jsCode;
ok('rejection branch hardcodes approved: false', /approved:\s*false/.test(classifyCode));
ok('rejection branch never writes approved: true', !/approved:\s*true/.test(classifyCode));

// Slack sendAndWait renders parameters.message; a `text` key is stored and silently ignored.
for (const n of wf.nodes.filter(x => x.type === 'n8n-nodes-base.slack')) {
  ok(`${n.name} uses parameters.message`, typeof n.parameters.message === 'string' && n.parameters.message.length > 0);
  ok(`${n.name} has no inert parameters.text`, n.parameters.text === undefined);
  ok(`${n.name} pins its credential by id`, n.credentials.slackApi.id === 'niWxNp4EIL0Dvgfh');
}

// The follow-up ask must time out rather than hang an execution forever on a rejection.
const askReason = nodeByName('Ask Reason (Slack)');
ok('Ask Reason is free text', askReason.parameters.responseType === 'freeText');
ok('Ask Reason has a wait limit so a silent rejection becomes a DENY',
   askReason.parameters.options.limitWaitTime === true);
ok('first ask still has NO wait limit (blocked forever is the safe state there)',
   nodeByName('Ask Human (Slack)').parameters.options.limitWaitTime === undefined);
ok('first ask is still a two-button approval',
   nodeByName('Ask Human (Slack)').parameters.responseType === 'approval');

console.log(`\n[ask-human gate] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
