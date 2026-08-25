// Offline proof that VIO-agent-tool-push-instantly cannot email a stranger without an explicit,
// boolean-true human approval — and that nothing in it can start a campaign.
//
// Reads jsCode straight out of VIO-agent-tool-push-instantly.json — never a re-typed copy — so the
// test cannot drift from the logic that actually deploys. Mirrors test-ask-human-gate.mjs's
// adversarial payload set, because this workflow's decision node consumes that workflow's output.
//
// Makes NO network call of any kind. Everything runs against fixtures.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-agent-tool-push-instantly.json', import.meta.url)));

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) pass++;
  else { console.error(`  FAIL  ${label}`); fail++; }
};
const eq = (label, got, want) => {
  if (got === want) pass++;
  else { console.error(`  FAIL  ${label} — wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); fail++; }
};

const nodeByName = (name) => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) { console.error(`FAIL: node "${name}" missing`); process.exit(1); }
  return n;
};

// Runs a Code node's real jsCode with a minimal n8n surface: $input, $('Other Node') and $env.
const runNode = (name, { input = [], byName = {}, env = {} } = {}) => {
  const items = input.map(json => ({ json }));
  const $input = { item: items[0], first: () => items[0], all: () => items };
  const $ = (n) => {
    const arr = (byName[n] || []).map(json => ({ json }));
    return { first: () => arr[0], all: () => arr, last: () => arr[arr.length - 1] };
  };
  const out = new Function('$input', '$', '$env', nodeByName(name).parameters.jsCode)($input, $, env);
  return Array.isArray(out) ? out.map(i => i.json) : [out.json];
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ---------------------------------------------------------------------------
// Fixtures. `lead()` produces the shape reach-engine emits.
// ---------------------------------------------------------------------------
const lead = (o = {}) => ({
  first_name: 'Kiara',
  company: 'Modernized Mobile LLC',
  title: 'Capture Manager',
  opener: 'Saw the CMMC Phase II notice land on your segment.',
  contact_email: 'kiara@modernizedmobile.example',
  sendr_page_url: 'https://sendr.io/p/abc123',
  verify_action: 'send',
  ...o,
});
const batch = (n, mut = () => ({})) => Array.from({ length: n }, (_, i) =>
  lead({ first_name: `Lead${i}`, contact_email: `lead${i}@example.com`, ...mut(i) }));

const propose = (payload) => runNode('Build Proposal', { input: [payload] })[0];
const goodPayload = (leads = [lead()]) => ({ product: 'oryoniq', leads });

// ===========================================================================
// 1. BUILD PROPOSAL — who gets skipped, the cap, and the payload shape
// ===========================================================================
const p1 = propose(goodPayload());
eq('one clean lead is eligible', p1.eligible_count, 1);
eq('campaign resolved from the allow-list', p1.campaign_id, '77b2cd80-5bf2-4656-8857-b310858d5a77');

// --- the three skips, mirroring push_to_instantly.py -----------------------
const skipCases = [
  ['no contact_email',        { contact_email: '' }],
  ['contact_email missing',   { contact_email: undefined }],
  ['non-string contact_email',{ contact_email: 12345 }],
  ['malformed address',       { contact_email: 'not-an-address' }],
  ['address with a comma (two recipients)', { contact_email: 'a@b.com,c@d.com' }],
  ['verify hard-dropped',     { verify_action: 'drop' }],
  ['no sendr_page_url',       { sendr_page_url: '' }],
  ['sendr_page_url missing',  { sendr_page_url: undefined }],
  ['sendr_page_url non-string', { sendr_page_url: { url: 'x' } }],
];
for (const [label, mut] of skipCases) {
  // Paired with one good lead so the proposal is not empty (an empty batch is refused outright).
  const r = propose(goodPayload([lead(), lead({ contact_email: 'other@example.com', ...mut })]));
  ok(`skipped: ${label}`, r.eligible_count === 1 && r.skipped_count === 1
    && r.emails.length === 1 && !r.emails.includes('other@example.com'));
}
ok('a batch of only-skippable leads is REFUSED, not proposed as empty',
   /REFUSED/.test(throws(() => propose(goodPayload([lead({ sendr_page_url: '' })]))) || ''));
ok('there is no allow-no-page escape hatch anywhere in the workflow',
   !/allow[_-]?no[_-]?page/i.test(JSON.stringify(wf)));

// A duplicate address inside one batch must not be mailed twice.
const dup = propose(goodPayload([lead(), lead()]));
ok('duplicate address inside a batch is skipped', dup.eligible_count === 1 && dup.skipped_count === 1);

// --- the cap ---------------------------------------------------------------
const CAP = 12;
eq('the cap is published in the proposal output', propose(goodPayload(batch(CAP))).max_leads, CAP);
eq('a full-cap batch is accepted', propose(goodPayload(batch(CAP))).eligible_count, CAP);
for (const n of [CAP + 1, CAP + 2, 50, 500]) {
  const msg = throws(() => propose(goodPayload(batch(n))));
  ok(`${n} leads is REFUSED by the cap`, msg !== null && /REFUSED/.test(msg) && msg.includes(String(CAP)));
}
// A cap that silently truncates would have the human approve a list nobody proposed.
ok('over-cap refuses rather than truncating',
   propose.length >= 0 && throws(() => propose(goodPayload(batch(20)))) !== null);
// The cap is re-asserted after the gate too, not only before it.
ok('the cap is restated inside the authorize node',
   nodeByName('Authorize Enrolment (fail closed)').parameters.jsCode.includes(`MAX_LEADS = ${CAP}`));

// --- campaign allow-list ---------------------------------------------------
for (const [label, payload] of [
  ['unknown product',        { product: 'acme', leads: [lead()] }],
  ['product as an array',    { product: ['oryoniq'], leads: [lead()] }],
  ['product missing',        { leads: [lead()] }],
  ['product as an object',   { product: { toString: () => 'oryoniq' }, leads: [lead()] }],
  ['product with no campaign yet', { product: 'visioneerit', leads: [lead()] }],
  ['caller-supplied campaign disagrees', { product: 'oryoniq', campaign: 'someone-elses-campaign', leads: [lead()] }],
  ['leads not an array',     { product: 'oryoniq', leads: { email: 'a@b.com' } }],
  ['leads missing',          { product: 'oryoniq' }],
  ['leads empty',            { product: 'oryoniq', leads: [] }],
]) {
  const msg = throws(() => propose(payload));
  ok(`REFUSED: ${label}`, msg !== null && /REFUSED/.test(msg));
}
ok('a matching caller-supplied campaign id is accepted',
   propose({ product: 'oryoniq', campaign: '77b2cd80-5bf2-4656-8857-b310858d5a77', leads: [lead()] }).eligible_count === 1);
ok('toolWorkflow {query:{...}} arguments are accepted too',
   propose({ query: goodPayload() }).eligible_count === 1);

// --- the payload shape, byte-compatible with push_to_instantly.py ----------
const body = propose(goodPayload())[ 'bodies' ][0];
for (const k of ['campaign', 'email', 'first_name', 'company_name', 'job_title', 'personalization', 'skip_if_in_campaign']) {
  ok(`payload carries ${k}`, Object.prototype.hasOwnProperty.call(body, k));
}
eq('skip_if_in_campaign is boolean true', body.skip_if_in_campaign, true);
eq('opener lands on the personalization field', body.personalization, 'Saw the CMMC Phase II notice land on your segment.');

// custom_variables MUST be top-level. Nested inside `payload` Instantly answers 201 and silently
// discards it, and the campaign CTA then renders as a bare colon.
eq('custom_variables.sendrPageUrl is present', body.custom_variables.sendrPageUrl, 'https://sendr.io/p/abc123');
ok('custom_variables is a TOP-LEVEL key', Object.keys(body).includes('custom_variables'));
ok('there is no `payload` key on the body at all', body.payload === undefined
   && !Object.prototype.hasOwnProperty.call(body, 'payload'));
ok('no node ever nests custom_variables under payload',
   !/payload\s*:\s*\{[^}]*custom_variables/.test(JSON.stringify(wf)));
ok('every proposed body has custom_variables top-level',
   propose(goodPayload(batch(CAP))).bodies.every(b =>
     b.custom_variables && typeof b.custom_variables.sendrPageUrl === 'string'
     && !Object.prototype.hasOwnProperty.call(b, 'payload')));

// --- what the human is shown ----------------------------------------------
// Approving "12 leads" without seeing who is not informed consent.
const shown = propose(goodPayload(batch(CAP)));
ok('proposal names the campaign by name', shown.detail.includes('OryonIQ - Reach Engine Pilot (2026-08)'));
ok('proposal names the campaign by id', shown.detail.includes('77b2cd80-5bf2-4656-8857-b310858d5a77'));
ok('proposal states the exact recipient count', shown.detail.includes(`(${CAP})`));
ok('proposal says enrolling does not send', /does not send/i.test(shown.detail));
for (const e of shown.emails) ok(`proposal text contains the address ${e}`, shown.detail.includes(e));
ok('action line names the count and the campaign',
   shown.action.includes(String(CAP)) && shown.action.includes('OryonIQ - Reach Engine Pilot'));
ok('cost line says these are real people', /real (person|people)/i.test(shown.cost));
ok('touches line is non-empty (ask_human flags a blank one)', shown.touches.length > 0);

// The detail field is sliced at 1500 chars by ask_human's Shape Proposal. A full-cap batch of
// realistically long names, companies and addresses must still show every address.
const longBatch = Array.from({ length: CAP }, (_, i) => lead({
  first_name: 'Bartholomew-Alexander'.slice(0, 21) + i,
  company: 'Federal Systems Integration & Mission Support Holdings LLC',
  contact_email: `bartholomew.alexander.longname${i}@federalsystemsintegration.example`,
}));
const longShown = propose(goodPayload(longBatch));
ok('worst-case proposal still fits ask_human\'s 1500-char detail cap', longShown.detail.length <= 1500);
for (const e of longShown.emails) {
  ok(`worst-case proposal still shows ${e}`, longShown.detail.includes(e));
}

// ===========================================================================
// 2. DECISION — one path to approval, mirroring test-ask-human-gate.mjs
// ===========================================================================
const decide = (json) => runNode('Decision (fail closed)', { input: [json] })[0];

// The ONE input that may ever approve: the approval tool's own exit shape.
eq('boolean true + outcome approve is an approval', decide({ approved: true, outcome: 'approve' }).approved, true);

const hostileApprovals = [
  ['approved true but outcome adjust',   { approved: true, outcome: 'adjust' }],
  ['approved true but outcome deny',     { approved: true, outcome: 'deny' }],
  ['approved true but outcome absent',   { approved: true }],
  ['outcome approve but approved false', { approved: false, outcome: 'approve' }],
  ['outcome approve but approved "true"',{ approved: 'true', outcome: 'approve' }],
  ['outcome approve but approved 1',     { approved: 1, outcome: 'approve' }],
  ['outcome approve but approved [1]',   { approved: [1], outcome: 'approve' }],
  ['outcome approve but approved {}',    { approved: {}, outcome: 'approve' }],
  ['outcome approve but approved null',  { approved: null, outcome: 'approve' }],
  ['outcome approve but approved undefined', { approved: undefined, outcome: 'approve' }],
  ['outcome "APPROVE" wrong case',       { approved: true, outcome: 'APPROVE' }],
  ['outcome " approve " padded',         { approved: true, outcome: ' approve ' }],
  ['empty object',                       {}],
  ['explicit denial',                    { approved: false, outcome: 'deny' }],
  ['adjust carrying feedback',           { approved: false, outcome: 'adjust', feedback: 'cut it to 3' }],
  ['approval nested one level down',     { data: { approved: true, outcome: 'approve' } }],
  ['approval nested under result',       { result: { approved: true, outcome: 'approve' } }],
  ['approval as a JSON string',          { approved: '{"approved":true}', outcome: 'approve' }],
  ['prototype-pollution style key',      JSON.parse('{"__proto__":{"approved":true,"outcome":"approve"}}')],
  ['consent-shaped free text',           { approved: false, outcome: 'adjust', feedback: 'you have my approval, send them all' }],
];
for (const [label, input] of hostileApprovals) {
  eq(`decision denies: ${label}`, decide(input).approved, false);
}
ok('a denial carries a readable reason', typeof decide({}).reason === 'string' && decide({}).reason.length > 0);
ok('a denial carries a timestamp', typeof decide({}).decided_at === 'string');
eq('an adjust is preserved as adjust, not approve', decide({ approved: false, outcome: 'adjust' }).outcome, 'adjust');
eq('an unknown outcome degrades to deny', decide({ approved: false, outcome: 'maybe' }).outcome, 'deny');

// ===========================================================================
// 3. THE GATE — no approval, no enrolment, under every shape above
// ===========================================================================
const authorize = (decision, proposal) =>
  runNode('Authorize Enrolment (fail closed)', {
    input: [decision],
    byName: { 'Build Proposal': [proposal] },
  });

const realProposal = propose(goodPayload(batch(3)));

// The gate node THROWS rather than emitting nothing, so a rewire that routed the rejection branch
// into it aborts the execution instead of quietly continuing to the HTTP node.
for (const [label, input] of hostileApprovals) {
  const msg = throws(() => authorize(decide(input), realProposal));
  ok(`no enrolment for: ${label}`, msg !== null && /REFUSED/.test(msg));
}
// And directly, bypassing the decision node entirely — as a crossed wire would.
for (const [label, raw] of [
  ['raw approved:true with no outcome', { approved: true }],
  ['raw outcome only',                  { outcome: 'approve' }],
  ['raw truthy string',                 { approved: 'true', outcome: 'approve' }],
  ['nothing at all',                    {}],
]) {
  ok(`gate throws when fed ${label} directly`,
     /REFUSED/.test(throws(() => authorize(raw, realProposal)) || ''));
}

// The one approving path.
const approved = decide({ approved: true, outcome: 'approve', decided_at: '2026-08-25T00:00:00Z' });
const authorized = authorize(approved, realProposal);
eq('an approval authorises exactly the proposed leads', authorized.length, 3);
ok('every authorised item carries the leads URL',
   authorized.every(a => a.instantly_url === 'https://api.instantly.ai/api/v2/leads'));
ok('every authorised body keeps custom_variables top-level',
   authorized.every(a => a.instantly_body.custom_variables.sendrPageUrl
     && !Object.prototype.hasOwnProperty.call(a.instantly_body, 'payload')));

// Consent is per-recipient: an address the human never saw cannot be enrolled, even with a real
// approval in hand. This is the defence against the proposal and the send-list diverging.
const smuggled = JSON.parse(JSON.stringify(realProposal));
smuggled.bodies.push({ ...realProposal.bodies[0], email: 'never-shown@example.com' });
ok('an unshown address is REFUSED even with a real approval',
   /REFUSED/.test(throws(() => authorize(approved, smuggled)) || ''));

const swapped = JSON.parse(JSON.stringify(realProposal));
swapped.bodies[0].campaign = '00000000-0000-4000-8000-000000000000';
ok('a body targeting another campaign is REFUSED',
   /REFUSED/.test(throws(() => authorize(approved, swapped)) || ''));

const nested = JSON.parse(JSON.stringify(realProposal));
nested.bodies[0].payload = { sendrPageUrl: 'https://sendr.io/p/abc123' };
ok('a body carrying a nested `payload` key is REFUSED',
   /REFUSED/.test(throws(() => authorize(approved, nested)) || ''));

const noPage = JSON.parse(JSON.stringify(realProposal));
delete noPage.bodies[0].custom_variables;
ok('a body with no top-level custom_variables is REFUSED',
   /REFUSED/.test(throws(() => authorize(approved, noPage)) || ''));

const noSkip = JSON.parse(JSON.stringify(realProposal));
noSkip.bodies[0].skip_if_in_campaign = false;
ok('a body that would re-mail an enrolled prospect is REFUSED',
   /REFUSED/.test(throws(() => authorize(approved, noSkip)) || ''));

const over = JSON.parse(JSON.stringify(propose(goodPayload(batch(CAP)))));
over.bodies.push({ ...over.bodies[0], email: over.bodies[0].email });
ok('the cap holds after the gate as well as before it',
   /REFUSED/.test(throws(() => authorize(approved, over)) || ''));

// The not-approved branch is a terminus that reports, and reports zero.
const denied = runNode('Not Approved (nothing sent)', {
  input: [decide({ approved: false, outcome: 'adjust', feedback: 'only 3' })],
  byName: { 'Build Proposal': [realProposal] },
})[0];
ok('deny branch reports zero enrolled', denied.enrolled === 0 && denied.approved === false);
ok('deny branch tells the agent it holds no approval', /NOT APPROVED/.test(denied.next));

// ===========================================================================
// 4. STRUCTURE — the wiring has to match the claim
// ===========================================================================
const conn = wf.connections;
const inbound = (target) => Object.entries(conn).flatMap(([from, c]) =>
  (c.main || []).flatMap((outs, idx) => (outs || [])
    .filter(o => o.node === target).map(() => `${from}#${idx}`)));

eq('workflow id is stable', wf.id, 'VIOwfBpushinst1');
eq('workflow name is stable', wf.name, 'VIO-agent-tool-push-instantly');
ok('node ids are unique and present',
   new Set(wf.nodes.map(n => n.id)).size === wf.nodes.length && wf.nodes.every(n => typeof n.id === 'string' && n.id));

// Every webhook node needs an explicit webhookId or n8n registers a mangled fallback path.
for (const n of wf.nodes.filter(x => x.type === 'n8n-nodes-base.webhook')) {
  ok(`${n.name} has an explicit webhookId`, typeof n.webhookId === 'string' && n.webhookId.length > 0);
}
ok('the webhook is authenticated by the very next node',
   conn['Push Webhook'].main[0][0].node === 'Authenticate (fail-closed)');
ok('auth is fail-closed on a missing token variable',
   /REFUSED/.test(throws(() => runNode('Authenticate (fail-closed)',
     { input: [{ query: { t: 'anything' }, body: {} }], env: {} })) || ''));
ok('auth refuses a wrong token',
   /REFUSED/.test(throws(() => runNode('Authenticate (fail-closed)',
     { input: [{ query: { t: 'wrong' }, body: {} }], env: { VIO_WEBHOOK_TOKEN: 'right' } })) || ''));

// The proposal is reachable from both entry points, and both land in the SAME gated pipeline.
ok('Build Proposal is fed by the authenticated webhook and the tool trigger',
   inbound('Build Proposal').sort().join(',') === 'Authenticate (fail-closed)#0,Tool Call In#0');

// The blocking call to the approval tool.
const ask = nodeByName('Ask Human (BLOCKING)');
eq('the approval step is an Execute Workflow node', ask.type, 'n8n-nodes-base.executeWorkflow');
eq('it targets VIO-agent-tool-ask-human by id', ask.parameters.workflowId.value, 'VIOwf8askhuman1');
eq('it WAITS for the sub-workflow', ask.parameters.options.waitForSubWorkflow, true);
ok('the proposal goes to the approval tool and nowhere else',
   conn['Build Proposal'].main[0].length === 1
   && conn['Build Proposal'].main[0][0].node === 'Ask Human (BLOCKING)');
ok('the decision node is fed only by the approval tool',
   JSON.stringify(inbound('Decision (fail closed)')) === JSON.stringify(['Ask Human (BLOCKING)#0']));

// The IF, and the two branches.
const ifNode = nodeByName('Approved?');
const cond = ifNode.parameters.conditions.conditions[0];
ok('IF tests $json.approved', cond.leftValue === '={{ $json.approved }}');
ok('IF tests boolean equality against true',
   cond.rightValue === true && cond.operator.type === 'boolean' && cond.operator.operation === 'equals');
ok('IF uses strict type validation (no "true" string sneaking through)',
   ifNode.parameters.conditions.options.typeValidation === 'strict');
ok('IF true branch goes to the gate',
   conn['Approved?'].main[0][0].node === 'Authorize Enrolment (fail closed)');
ok('IF false branch goes to the terminus',
   conn['Approved?'].main[1][0].node === 'Not Approved (nothing sent)');
ok('the gate has exactly one inbound: the IF true branch',
   JSON.stringify(inbound('Authorize Enrolment (fail closed)')) === JSON.stringify(['Approved?#0']));
ok('the not-approved terminus goes nowhere', conn['Not Approved (nothing sent)'] === undefined);

// THE CENTRAL STRUCTURAL CLAIM: the HTTP node holds no target of its own.
const httpNodes = wf.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest');
eq('there is exactly one HTTP node in the whole workflow', httpNodes.length, 1);
const http = httpNodes[0];
ok('the HTTP node is fed only by the gate',
   JSON.stringify(inbound(http.name)) === JSON.stringify(['Authorize Enrolment (fail closed)#0']));
eq('its url is an expression, not a literal endpoint', http.parameters.url, '={{ $json.instantly_url }}');
eq('its body is an expression, not a rebuilt payload', http.parameters.jsonBody, '={{ JSON.stringify($json.instantly_body) }}');
ok('the Instantly endpoint string exists in exactly one node, the gate',
   wf.nodes.filter(n => JSON.stringify(n.parameters).includes('api.instantly.ai')).map(n => n.name).join(',')
   === 'Authorize Enrolment (fail closed)');
eq('the credential is pinned by id', http.credentials.httpHeaderAuth.id, 'VIOinstantlycr01');
ok('the credential supplies auth; no hand-rolled Authorization header',
   http.parameters.authentication === 'genericCredentialType'
   && http.parameters.genericAuthType === 'httpHeaderAuth'
   && !JSON.stringify(http.parameters.headerParameters).toLowerCase().includes('authorization'));
ok('a browser-like User-Agent is sent (a default client UA gets a bare Cloudflare 1010)',
   http.parameters.headerParameters.parameters.some(p => p.name === 'User-Agent' && /Mozilla/.test(p.value)));

// ===========================================================================
// 5. NOTHING HERE CAN ACTIVATE A CAMPAIGN
// ===========================================================================
// push_to_instantly.py deliberately contains no activation call at all, so there is no flag that
// could accidentally send. This asserts the same property structurally. The ban is scoped to
// `parameters` — the part n8n executes — so node `notes` may still explain the trap in prose.
const bannedEndpoint = [
  ['a campaign endpoint', /\/campaigns/i],
  ['an activation endpoint', /\/activate/i],
  ['a pause endpoint', /\/pause/i],
  ['a resume endpoint', /\/resume/i],
  ['a campaign-status write verb', /\bPATCH\b/],
  ['PUT', /"PUT"|'PUT'/],
  ['DELETE', /"DELETE"|'DELETE'/],
];
for (const n of wf.nodes) {
  const params = JSON.stringify(n.parameters);
  for (const [label, re] of bannedEndpoint) {
    ok(`${n.name}'s parameters contain no ${label}`, !re.test(params));
  }
}
for (const n of httpNodes) {
  eq(`${n.name} is POST only`, n.parameters.method, 'POST');
}
// The only endpoint the workflow can construct, asserted on the produced value rather than on
// source text — this is what a request would actually be sent to.
ok('every authorised request targets the leads endpoint and nothing else',
   authorized.every(a => a.instantly_url === 'https://api.instantly.ai/api/v2/leads'));
ok('no authorised request carries a campaign-resource path',
   authorized.every(a => !/campaign/i.test(a.instantly_url)));
// The campaign id travels in the BODY (which selects an existing campaign to enrol into), never
// in the URL, so no id can smuggle a path segment into the endpoint.
ok('the campaign id is a body field, not part of the URL',
   authorized.every(a => a.instantly_body.campaign === '77b2cd80-5bf2-4656-8857-b310858d5a77'
                      && !a.instantly_url.includes('77b2cd80')));
ok('the workflow contains no second HTTP-capable node type',
   wf.nodes.every(n => !/webhook|http/i.test(n.type)
     || n.type === 'n8n-nodes-base.webhook' || n.type === 'n8n-nodes-base.httpRequest'));

// ===========================================================================
// 6. END TO END — every approval shape, through the branch it would take
// ===========================================================================
const endToEnd = (payload) => {
  const d = decide(payload);
  if (d.approved !== true) {
    runNode('Not Approved (nothing sent)', { input: [d], byName: { 'Build Proposal': [realProposal] } });
    return { enrolled: 0 };
  }
  return { enrolled: authorize(d, realProposal).length };
};
let e2e = 0, e2eEnrolled = 0;
for (const [, input] of hostileApprovals) {
  e2e++;
  let r;
  try { r = endToEnd(input); } catch { r = { enrolled: 0 }; }   // a throw is also "nobody enrolled"
  if (r.enrolled > 0) {
    console.error(`  FAIL  end-to-end enrolled ${r.enrolled} without a boolean-true approval: ${JSON.stringify(input)}`);
    fail++;
  }
  e2eEnrolled += r.enrolled;
}
e2e++;
const happy = endToEnd({ approved: true, outcome: 'approve' });
ok(`end-to-end: ${e2e} approval shapes, only the boolean-true one enrols anybody`,
   e2eEnrolled === 0 && happy.enrolled === 3);

// ===========================================================================
// 7. REPORT
// ===========================================================================
const report = runNode('Report', {
  input: [{ id: 'lead-1' }, { error: 'HTTP 400 bad request' }, { id: 'lead-3' }],
  byName: { 'Build Proposal': [realProposal], 'Authorize Enrolment (fail closed)': authorized },
})[0];
eq('report counts enrolments', report.enrolled, 2);
eq('report counts failures', report.failed, 1);
ok('report restates that nothing was started', /not started/i.test(report.note));
ok('report is JSON-clean (no raw control characters)',
   !/[\u0000-\u001f\u007f]/.test(JSON.stringify(report)));

console.log(`\n[push-instantly gate] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
