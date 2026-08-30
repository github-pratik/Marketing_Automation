// Offline proof of VIO-demo-sheet-run's row handling. Reads jsCode straight out of the workflow
// JSON so the test cannot drift from what deploys.
//
// The risks here are specific: re-processing a row on every poll (this runs on a one-minute
// schedule), silently dropping a row the human is watching, and polling a tab the pipeline itself
// writes to — which would be a feedback loop against real spend.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-demo-sheet-run.json', import.meta.url)));
const jsOf = (name) => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  if (n.type !== 'n8n-nodes-base.code') throw new Error(`"${name}" is ${n.type}, not a Code node`);
  return n.parameters.jsCode;
};
const CTRL = /[\u0000-\u001f\u007f]/;
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

// ---------- Pick unprocessed rows ----------
const pickCode = jsOf('Pick demo rows');
const pick = (rows) => new Function('$input', pickCode)({ all: () => rows.map(j => ({ json: j })) })
  .map(i => i.json);

const row = (o = {}) => ({
  row_number: 2, first_name: 'Pratik', title: 'AI Solutions Engineer',
  company: 'VisioneerIT', contact_email: 'p.pshpatil@outlook.com',
  // Product is required since 2026-08-29 — nothing can infer which company should be pitching
  // this person, so a row without it is refused rather than guessed at.
  source_config: 'Manual', channel_state_email: '', Product: 'OryonIQ', ...o,
});

ok('a fresh row is picked up', pick([row()]).length === 1);
ok('the row number is carried', pick([row()])[0].row_number === 2);
// THE loop guard, now that this polls the same tab the pipeline writes to. Without it, rows the
// intake workflow appends would re-trigger this schedule against real Reoon and OpenAI spend.
// The live sheet's dropdown offers Apollo / Warmly-Intent / Referral / Manual — 'demo' cannot be
// typed. 'Manual' means a human entered this row, which is exactly what a demo row is. The loop
// guard still holds: pipeline rows carry oryoniq/visioneerit, Apollo-sourced rows carry Apollo.
for (const sc of ['oryoniq', 'visioneerit', 'Apollo', 'Warmly-Intent', 'Referral', '', 'demo'])
  ok(`source_config "${sc}" is NOT picked up — only Manual rows are`, pick([row({ source_config: sc })]).length === 0);
for (const sc of ['Manual', 'manual', 'MANUAL', ' Manual '])
  ok(`source_config "${sc}" IS picked up`, pick([row({ source_config: sc })]).length === 1);

// Idempotence — this polls every minute, so a claimed row must never be re-processed.
// Leads has no `status` column; channel_state_email is the one that means exactly this.
for (const s of ['pending_approval', 'enrolled', 'needs_review', 'dropped', 'bounced', 'replied'])
  ok(`channel_state_email "${s}" means already claimed`, pick([row({ channel_state_email: s })]).length === 0);
ok('blank channel_state_email is unclaimed', pick([row({ channel_state_email: '   ' })]).length === 1);

// THE HANDOFF (fixed 2026-08-29). Readiness used to mean "this column is blank", but nothing that
// writes a lead leaves it blank — VIO-intake-verify-curate stamps 'not_sent'. Every verified
// staff-typed lead therefore landed in Leads and was never picked up, while looking correct to a
// human reading the sheet. 'not_sent' is now explicitly the ready state.
ok('not_sent is READY — it is what the verified intake path writes',
   pick([row({ channel_state_email: 'not_sent' })]).length === 1);
ok('  and it is case-insensitive', pick([row({ channel_state_email: 'NOT_SENT' })]).length === 1);
ok('  while every other state still means hands off',
   ['queued', 'sent', 'positive', 'booked', 'rejected', 'unsubscribed', 'dropped', 'needs_review']
     .every((s) => pick([row({ channel_state_email: s })]).length === 0));

// THE HUMAN OVERRIDE. visioneerit.com is a catch-all domain: it accepts mail for any address, so
// Reoon returns is_deliverable:true but is_safe_to_send:false and intake parks the lead at
// needs_review. Weakening the automatic rule would let unverified strangers through, so instead a
// person who knows the mailbox exists marks that ONE row `approved`.
ok('approved is READY — the human override for a lead verification will not pass',
   pick([row({ channel_state_email: 'approved' })]).length === 1);
ok('  case-insensitively', pick([row({ channel_state_email: 'APPROVED' })]).length === 1);
ok('needs_review on its own is NOT ready — a human must actually act',
   pick([row({ channel_state_email: 'needs_review' })]).length === 0);
ok('dropped is never ready, no matter what',
   pick([row({ channel_state_email: 'dropped' })]).length === 0);
// The override buys the right to be DRAFTED, not the right to be SENT: the Slack gate still
// stands behind it. If this ever stops being true the override becomes a way to mail anyone.
// The override buys the right to be DRAFTED and then to pass VIO-enrol-email's own checks — it is
// not a licence to mail anyone. That workflow re-reads suppression and re-checks the verdict.
ok('enrolment still runs through a fail-closed precondition step',
   wf.nodes.some((n) => n.type === 'n8n-nodes-base.executeWorkflow'
     && n.parameters.workflowId?.value === 'VIOwfLenrolmail'));

// Blank spacer rows are not errors.
ok('a wholly blank row is ignored',
   pick([{ row_number: 9, source_config: 'Manual', first_name: '', company: '', contact_email: '', channel_state_email: '' }]).length === 0);

// A bad row must be REPORTED, not dropped — the person who typed it is watching.
const bad = (o) => { const r = pick([row(o)]); return r.length === 1 ? r[0] : null; };
for (const [label, o] of [
  ['missing first_name', { first_name: '' }],
  ['missing company', { company: '' }],
  ['missing email', { contact_email: '' }],
  ['malformed email', { contact_email: 'not-an-address' }],
  ['email with a comma', { contact_email: 'a@b.com,c@d.com' }],
  ['email with brackets', { contact_email: '<a@b.com>' }],
]) {
  const r = bad(o);
  ok(`${label} is surfaced, not dropped`, r !== null, 'row vanished');
  if (r) {
    ok(`  ${label} is flagged invalid`, r.invalid === true);
    ok(`  ${label} explains why`, typeof r.problems === 'string' && r.problems.length > 0);
  }
}
ok('a good row is not flagged', pick([row()])[0].invalid === false);

// Hostile / messy input must not throw.
for (const [label, rows] of [
  ['no rows at all', []],
  ['null row', [null]],
  ['row of nulls', [{ source_config: 'Manual', first_name: null, company: null, contact_email: null, channel_state_email: null }]],
  ['non-string fields', [row({ first_name: 42, company: {}, contact_email: [] })]],
  ['control chars in a name', [row({ first_name: 'Pra\ntik' })]],
  ['very long company', [row({ company: 'x'.repeat(9000) })]],
]) {
  let threw = null;
  try { pick(rows); } catch (e) { threw = e.message; }
  ok(`survives ${label}`, threw === null, threw);
}
ok('control characters are stripped', !CTRL.test(JSON.stringify(pick([row({ first_name: 'Pra\ntik' })]))));
ok('over-long values are capped', pick([row({ company: 'x'.repeat(9000) })])[0].company.length <= 160);

// ---------- product routing into the drafter ----------
const shapeCode = jsOf('Shape for drafting');
const shape = (j) => new Function('$input', shapeCode)({ item: { json: j } }).json;
// PRODUCT ROUTING (fixed 2026-08-29). draft_config was hardcoded 'oryoniq', so a council CIO
// typed in for VisioneerIT was drafted GovCon capture copy signed OryonIQ. It now comes from the
// sheet's own Product column.
ok('an OryonIQ row drafts with the OryonIQ config',
   shape(pick([row({ Product: 'OryonIQ' })])[0]).source_config === 'oryoniq');
ok('a VisioneerIT row drafts with the VisioneerIT config',
   shape(pick([row({ Product: 'VisioneerIT' })])[0]).source_config === 'visioneerit');
for (const p of ['', '   ', 'Acme', 'oryon', 'both'])
  ok(`Product "${p}" is refused rather than guessed`, pick([row({ Product: p })])[0].invalid === true);
ok('a refused row says what to do about it',
   /choose OryonIQ or VisioneerIT/.test(pick([row({ Product: '' })])[0].problems));
// The page call must follow the row, not a constant.
ok('the Sendr page is generated for the row\'s own product',
   !/product: 'oryoniq'/.test(jsOf('Shape for page')));
ok('the row identity survives into the drafter', shape(pick([row()])[0])._row === 2);
ok('the email address survives into the drafter', shape(pick([row()])[0])._email === 'p.pshpatil@outlook.com');

// ---------- the row never claims more than happened ----------
const writeCode = jsOf('Shape row update');
const write = (rep, src) => new Function('$input', '$', writeCode)(
  { item: { json: rep } }, () => ({ first: () => ({ json: src }) })).json;
const src = { _row: 2, _opener: 'op', _email_draft: 'body', _page: 'https://p' };
ok('an enrolled row uses the sheet vocabulary: enrolled',
   write({ leads: [{ status: 'enrolled' }] }, src).channel_state_email === 'enrolled');
// NOT 'dropped'. That word belongs to verification — it means Reoon says the address is not real,
// and VIO-enrol-email refuses such a lead as a negative no human may override. Using it for
// "enrolment did not land" locked a lead with a perfectly good address out permanently.
ok('a NOT-enrolled row goes to needs_review, not dropped',
   write({ enrolled: false }, src).channel_state_email === 'needs_review');
ok('  and never to dropped, which would be a verified negative',
   write({ enrolled: false }, src).channel_state_email !== 'dropped');

// ⚠️ THE ENROLMENT SHAPE. This node read `r.leads[].status` — VIO-agent-tool-push-instantly's
// shape — while the call had been repointed to VIO-enrol-email, which emits a flat `enrolled`
// boolean and no `leads` key. It silently evaluated false on EVERY successful send and wrote the
// lead back as needs_review. A lead that looks unsent can be vouched for again and mailed twice.
ok('the current target shape is read correctly',
   write({ enrolled: true }, src).channel_state_email === 'enrolled');
ok('the legacy gated-tool shape still works',
   write({ leads: [{ status: 'enrolled' }] }, src).channel_state_email === 'enrolled');
// An unknown shape must THROW, not default to "not enrolled" — defaulting is what hid this.
// A throw strands the row where an operator can free it deliberately; a wrong needs_review
// invites a duplicate send to a real person.
for (const [label, r] of [['an empty result', {}], ['an unrecognised shape', { something: 'else' }]]) {
  let threw = null;
  try { write(r, src); } catch (e) { threw = e.message; }
  ok(`${label} REFUSES rather than guessing`, threw !== null && /REFUSED/.test(threw), threw);
}
ok('the page url is written back', write({ leads: [{ status: 'enrolled' }] }, src).sendr_page_url === 'https://p');

const badRow = new Function('$input', jsOf('Explain the bad row'))(
  { item: { json: { row_number: 5, problems: 'contact_email is blank' } } }).json;
ok('a bad row is marked needs_review', badRow.channel_state_email === 'needs_review');
ok('a bad row explains itself in the sheet', /contact_email is blank/.test(badRow.verify_reason));

// An Execute Workflow call returns ONLY the sub-workflow's own output — anything the caller
// attached to the input is gone. Carrying _email through the drafting call and expecting it back
// produced an enrolment with a blank address and "(unnamed lead)", which the gate refused.
// Caught live 2026-08-29 on the first autonomous run.
const pageCode = jsOf('Shape for page');
const enrolCode = jsOf('Shape for enrolment');
ok('Shape for page reads identity from Shape for drafting, not from the draft output',
   /\$\('Shape for drafting'\)/.test(pageCode));
ok('Shape for enrolment reads identity from Shape for page',
   /\$\('Shape for page'\)/.test(enrolCode));

// The node now reads TWO upstream nodes by name — 'Generate Sendr page' for the URL and
// 'Shape for page' for the lead — so the mock has to answer per node instead of returning the
// same object for every name. A mock that ignores the node name cannot catch a node reading the
// wrong upstream, which is exactly the bug this suite now guards.
const runEnrol = (item, src) => new Function('$input', '$', enrolCode)(
  { item: { json: item } },
  (name) => ({ first: () => ({ json: name === 'Generate Sendr page' ? item : src }) })).json;
const goodSrc = { _row: 2, _email: 'p@v.com', _first_name: 'P', _title: 'T', _company: 'V', _opener: 'o' };
ok('a complete row produces one lead with its address',
   runEnrol({ pageUrl: 'https://x' }, { ...goodSrc, _product: 'oryoniq' }).leads[0].contact_email === 'p@v.com');

// THE PRODUCT MUST BE THE LEAD'S OWN. It was the constant 'demo', which push-instantly maps to a
// campaign carrying OryonIQ's copy — so an approved VisioneerIT lead would have been sent OryonIQ's
// email while linking to a VisioneerIT page, and would have bypassed that tool's fail-closed
// `visioneerit: null` refusal. Cross-product leakage is the mistake a prospect actually sees.
ok('an OryonIQ lead enrols as oryoniq',
   runEnrol({ pageUrl: 'https://x' }, { ...goodSrc, _product: 'oryoniq' }).product === 'oryoniq');
ok('a VisioneerIT lead enrols as visioneerit, NOT as the OryonIQ-copy demo campaign',
   runEnrol({ pageUrl: 'https://x' }, { ...goodSrc, _product: 'visioneerit' }).product === 'visioneerit');
ok('the product is never the hardcoded string "demo"',
   !/^\s*product:\s*'demo',/m.test(enrolCode));
{
  let t = null;
  try { runEnrol({ pageUrl: 'https://x' }, { ...goodSrc, _product: '' }); } catch (e) { t = e.message; }
  ok('a lead with no product refuses before a human is asked', t !== null && /REFUSED/.test(t), t);
}
ok('the page url reaches the lead', runEnrol({ pageUrl: 'https://x' }, { ...goodSrc, _product: 'oryoniq' }).leads[0].sendr_page_url === 'https://x');
let threw = null;
try { runEnrol({ pageUrl: 'https://x' }, { ...goodSrc, _product: 'oryoniq', _email: '' }); } catch (e) { threw = e.message; }
ok('a row that LOST its email refuses here, before a human is asked',
   threw !== null && /REFUSED/.test(threw), threw || 'did not throw');

// Every value written to channel_state_email must exist in the live sheet's data-validation
// dropdown. The docs say not_sent/queued/sent/bounced; the live column says
// needs_review / pending_approval / approved / enrolled / replied / positive / booked /
// rejected / dropped / unsubscribed / bounced. Writing through the API bypasses validation, so
// an off-vocabulary value lands silently in a column a human filters on.
const SHEET_VOCAB = new Set(['needs_review','pending_approval','approved','enrolled','replied',
  'positive','booked','rejected','dropped','unsubscribed','bounced']);
for (const node of ['Shape row update', 'Explain the bad row', 'Claim row (pending_approval)']) {
  const src = jsOf(node);
  for (const m of src.matchAll(/channel_state_email:\s*(?:[^'"\n]*\?\s*)?'([a-z_]+)'/g))
    ok(`${node} writes "${m[1]}" — a value the sheet dropdown allows`, SHEET_VOCAB.has(m[1]));
  for (const m of src.matchAll(/:\s*'([a-z_]+)'\s*;?\s*$/gm)) { /* no-op, guard above is enough */ }
}

// A row parked on an unanswered approval must be CLAIMED, or the one-minute schedule re-drafts and
// re-pages it every cycle. Two Sendr pages were burned that way before this was added.
const claimIdx = wf.nodes.findIndex(n => n.name === 'Claim row (pending_approval)');
ok('the row is claimed before the gated enrolment', claimIdx !== -1);
ok('the claim writes pending_approval', /pending_approval/.test(jsOf('Claim row (pending_approval)')));
const afterPage = wf.connections['Generate Sendr page'].main[0].map(c => c.node);
ok('the claim happens straight after the page, before enrolment',
   afterPage.includes('Claim row (pending_approval)'), afterPage.join(','));

// ---------- structure ----------
ok('workflow id stable', wf.id === 'VIOwfDsheetdemo1');

const sheetNodes = wf.nodes.filter(n => n.type === 'n8n-nodes-base.googleSheets');
ok('every Sheets node is pinned to the VIO credential by id',
   sheetNodes.length > 0 && sheetNodes.every(n => n.credentials?.googleApi?.id === 'VIOgsheetcred01'));

// The feedback-loop guard. Polling Leads would re-trigger on rows the live intake pipeline
// appends, which is a loop against real Reoon and OpenAI spend.
// It now polls the SAME tab the pipeline writes to, so the loop guard is the source_config filter
// asserted above — not tab separation. Both must hold together.
// The LEAD DATA must all live on one tab — the loop guard depends on that plus the source_config
// filter. The System tab is exempt: it carries only the liveness heartbeat, never a lead, so it
// cannot feed anything back into the poll.
const tabs = sheetNodes.map(n => n.parameters.sheetName?.value);
ok('every lead-data node operates on the Leads tab',
   tabs.filter(t => t !== 'System').every(t => t === 'Leads'), tabs.join(','));
ok('the only non-Leads tab touched is the heartbeat',
   sheetNodes.filter(n => n.parameters.sheetName?.value === 'System')
             .every(n => n.name === 'Write heartbeat'));
ok('the loop guard is the source_config filter', /source_config/.test(pickCode) && /manual/.test(pickCode));
ok('no A1 range anywhere (live column order does not match the docs)',
   !/"[A-Z]{1,2}[0-9]{1,4}:[A-Z]{1,2}/.test(JSON.stringify(wf)));

const calls = wf.nodes.filter(n => n.type === 'n8n-nodes-base.executeWorkflow')
                      .map(n => n.parameters.workflowId.value);
ok('calls the drafting workflow', calls.includes('VIOwf4agent0001'));
ok('calls the Sendr page workflow', calls.includes('VIOwf6sendrgen01'));
// ⚠️ THE EMAIL LEG IS DELIBERATELY UNGATED (2026-08-30, owner's instruction: 15-20 outreach a day
// makes a click per lead unworkable). It calls VIO-enrol-email, which replaces the human with five
// checks that throw. This is defensible ONLY because a human chose every recipient by typing them
// into the Inbox tab — no model picks who gets mailed on this path.
ok('the email leg calls the ungated email enrolment path', calls.includes('VIOwfLenrolmail'));
ok('it does NOT call the agent\'s gated tool — that gate stays for the path where an LLM picks people',
   !calls.includes('VIOwfBpushinst1'));
for (const n of wf.nodes.filter(x => x.type === 'n8n-nodes-base.executeWorkflow'))
  ok(`${n.name} runs once per row`, n.parameters.mode === 'each');
ok('the enrolment step waits for its sub-workflow, so a refusal surfaces here',
   wf.nodes.find(n => n.parameters?.workflowId?.value === 'VIOwfLenrolmail')
     ?.parameters?.options?.waitForSubWorkflow === true);

// The agent's tool MUST keep its gate. If this ever fails, an LLM can mail strangers unreviewed.
{
  const tool = JSON.parse(readFileSync(new URL('./VIO-agent-tool-push-instantly.json', import.meta.url)));
  ok('the AGENT tool still holds its Slack approval',
     tool.nodes.some((n) => /Ask Human/i.test(n.name))
     && tool.nodes.some((n) => /Authorize Enrolment/i.test(n.name)));
}

// The runner must hand the enrolment step the REAL verification state. It used to hardcode
// verify_action:'pass', which would tell the ungated path every lead was Reoon-verified —
// including catch-all addresses that only got through because a human vouched by name.
ok('the real verification verdict is carried, not asserted',
   !/verify_action:\s*'pass'/.test(jsOf('Shape for enrolment')));
ok('  and it comes from the sheet row', /_verify_action/.test(jsOf('Pick demo rows'))
   || /verify_action: clean\(r\.verify_action/.test(jsOf('Pick demo rows')));

// This workflow runs unattended on a schedule. Nothing that spends money or reaches a person may
// be reachable from it without its own approval — and neither is wired in today.
// Reveal spends Apollo credits per lead and this schedule is unattended, so it stays out.
for (const [id, what] of Object.entries({
  VIOwfArevealcon1: 'reveal_contacts (Apollo credits)',
  VIOwf1intake0001: 'intake verify (Reoon credits)',
})) ok(`unattended schedule does NOT call ${what}`, !calls.includes(id));
ok('no direct HTTP node', !wf.nodes.some(n => n.type === 'n8n-nodes-base.httpRequest'));

const names = new Set(wf.nodes.map(n => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const g of v.main) for (const c of g)
    ok(`connection ${src} -> ${c.node} resolves`, names.has(c.node));


// ---------- the page URL must survive the claim step ----------
// Sendr really did build the page and the enrolment gate still refused with "no sendr_page_url",
// because 'Claim row in sheet' sits between the page call and the readers and a Sheets update
// outputs the ROW IT WROTE. Both readers must name the page node, never read $input. (2026-08-29)
{
  const order = [];
  let cur = 'Generate Sendr page';
  while (cur && order.length < 10) {
    const nxt = wf.connections[cur]?.main?.[0]?.[0]?.node;
    if (!nxt) break;
    order.push(nxt); cur = nxt;
  }
  ok('a Sheets write really does sit between the page call and enrolment',
     order.indexOf('Claim row in sheet') > -1
     && order.indexOf('Claim row in sheet') < order.indexOf('Shape for enrolment'),
     order.join(' -> '));

  for (const node of ['Shape for enrolment', 'Claim row (pending_approval)']) {
    const js = jsOf(node);
    ok(`${node} reads the page URL from the page node by name`,
       /\$\('Generate Sendr page'\)/.test(js), 'reads $input instead — the sheet row has no pageUrl');
    ok(`${node} does not read pageUrl off its own input`,
       !/\$input\.item\.json\.pageUrl/.test(js));
  }
  // The field that never existed. Match the ASSIGNMENT, not the word — the comment above the fix
  // names `_page_pending` on purpose so the next reader knows what went wrong.
  ok('the claim step no longer assigns the field Shape for page never produced',
     !/sendr_page_url:\s*src\._page_pending/.test(jsOf('Claim row (pending_approval)')));
  ok('  it writes the real page URL instead',
     /sendr_page_url:\s*page\b/.test(jsOf('Claim row (pending_approval)')));

  // An empty page URL must stop the lead, not ship a broken sentence: step 1's CTA IS the merge tag.
  const enrol = jsOf('Shape for enrolment');
  ok('enrolment refuses a lead with no page URL', /REFUSED[^`]*Sendr page URL/.test(enrol));
}


// ---------- claim first, work second ----------
// A row used to be claimed only after drafting AND page generation, while the schedule re-read the
// same tab every 60 seconds — so one row produced two Slack approval requests, two drafts and two
// Sendr pages (seen live 2026-08-29).
{
  const branch = wf.connections['Row usable?'].main[1].map((c) => c.node);
  ok('the claim branch is wired off the usable path', branch.includes('Claim row early'), branch.join(', '));
  ok('the claim runs BEFORE drafting — v1 execution order follows connection order',
     branch.indexOf('Claim row early') < branch.indexOf('Shape for drafting'), branch.join(' then '));

  // It must be a PARALLEL branch, never inline: inline would hand the drafting chain a Sheets
  // node's output instead of the picked row, which is exactly how the Sendr page URL was lost.
  ok('drafting still receives the picked row, not a Sheets write',
     branch.includes('Shape for drafting'));
  ok('the claim chain is terminal', !('Claim early in sheet' in wf.connections));

  const early = jsOf('Claim row early');
  ok('the early claim sets pending_approval', /pending_approval/.test(early));
  // Writing blanks for fields that do not exist yet would erase a previous run's values.
  for (const f of ['opener', 'email_draft', 'sendr_page_url'])
    ok(`the early claim does not blank ${f}`, !new RegExp(`${f}\\s*:`).test(early));

  const sheetNode = wf.nodes.find((n) => n.name === 'Claim early in sheet');
  ok('the early claim writes via update on row_number',
     sheetNode.parameters.operation === 'update'
     && sheetNode.parameters.columns.matchingColumns.includes('row_number'));
  ok('  declaring an explicit schema', (sheetNode.parameters.columns.schema || []).length > 0);
  ok('  pinned to the service-account credential by id',
     sheetNode.credentials?.googleApi?.id === 'VIOgsheetcred01');
  ok('  on typeVersion 4.7', sheetNode.typeVersion === 4.7);

  // The poll must not be faster than the work it starts.
  const mins = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger')
                 .parameters.rule.interval[0].minutesInterval;
  ok('the poll interval leaves room for the chain to claim', mins >= 2, `every ${mins} min`);
}

// 'dropped' belongs to VERIFICATION — it means Reoon says the address is not real, and
// VIO-enrol-email refuses such a lead outright as a negative no human may override. Writing it
// here for "enrolment did not land" locked a lead with a perfectly good address out of the
// pipeline permanently (seen live 2026-08-30).
{
  const upd = jsOf('Shape row update');
  ok("a non-landing enrolment is NOT recorded as 'dropped'", !/: 'dropped'/.test(upd), upd.match(/.{0,60}'dropped'.{0,40}/)?.[0]);
  ok('  it is recorded as needs_review, which is what it actually is',
     /enrolled \? 'enrolled' : 'needs_review'/.test(upd));
}

// ---------- the heartbeat ----------
// Staff type into this spreadsheet and nothing on screen tells them the poller is alive. Both
// schedules are silent by design when there is nothing to do — the mapper's chain literally stops
// at the sheet read — so "working, nothing to do" and "dead" looked identical from the sheet.
{
  const beat = (rows) => new Function('$input', jsOf('Heartbeat'))(
    { all: () => rows.map((j) => ({ json: j })) }).json;
  const readNode = 'Read Leads';

  // It must hang off the sheet READ, so it reports what was actually seen rather than just that a
  // timer fired — and it must be the FIRST branch, so a throw further down cannot swallow it.
  const branch = wf.connections[readNode].main[0].map((c) => c.node);
  ok('the heartbeat hangs off the sheet read', branch.includes('Heartbeat'), branch.join(', '));
  ok('  and runs before the work, so a later throw cannot swallow it', branch[0] === 'Heartbeat');
  // Without this the read emits nothing on an empty tab and the heartbeat never fires — exactly
  // when a human most needs to know the system is alive.
  ok('the read always emits, so an empty tab still produces a heartbeat',
     wf.nodes.find((n) => n.name === readNode).alwaysOutputData === true);

  const b = beat([{ row_number: 2, status: '', junk: 'x' }]);
  ok('it names the workflow in words a human recognises', /VIO-demo-sheet-run/.test(b.workflow));
  ok('it records when it last ran', typeof b.last_run_at === 'string' && b.last_run_at.length > 5);
  ok('  in local time, not UTC arithmetic', !/UTC/.test(b.last_run_at));
  ok('it says when the next check is due', typeof b.next_check_at === 'string' && b.next_check_at.length > 3);
  ok('it states the interval', b.every === '3 min');
  ok('it reports what it saw', /leads|lead|row/i.test(String(b.checked)));
  ok('an idle cycle still reports a result', typeof b.last_result === 'string' && b.last_result.length > 5);

  // A write failure must never take down the run it is only reporting on.
  const w = wf.nodes.find((n) => n.name === 'Write heartbeat');
  ok('the heartbeat write cannot break the run it reports on', w.onError === 'continueRegularOutput');
  ok('  it updates one row per workflow instead of appending forever',
     w.parameters.operation === 'appendOrUpdate' && w.parameters.columns.matchingColumns.includes('workflow'));
  ok('  and writes to the System tab', w.parameters.sheetName.value === 'System');
}

console.log(`\n[demo-sheet-run] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


