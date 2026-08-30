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
ok('the Slack approval gate still sits in front of enrolment',
   wf.nodes.some((n) => n.type === 'n8n-nodes-base.executeWorkflow'
     && n.parameters.workflowId?.value === 'VIOwfBpushinst1')
   && /GATED/.test(JSON.stringify(wf.nodes.map((n) => n.name))));

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
ok('a NOT-enrolled row is dropped',
   write({ leads: [{ status: 'already_in_another_campaign' }] }, src).channel_state_email === 'dropped');
ok('an empty result is dropped', write({}, src).channel_state_email === 'dropped');
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
const tabs = sheetNodes.map(n => n.parameters.sheetName?.value);
ok('operates on the Leads tab', tabs.every(t => t === 'Leads'), tabs.join(','));
ok('the loop guard is the source_config filter', /source_config/.test(pickCode) && /manual/.test(pickCode));
ok('no A1 range anywhere (live column order does not match the docs)',
   !/"[A-Z]{1,2}[0-9]{1,4}:[A-Z]{1,2}/.test(JSON.stringify(wf)));

const calls = wf.nodes.filter(n => n.type === 'n8n-nodes-base.executeWorkflow')
                      .map(n => n.parameters.workflowId.value);
ok('calls the drafting workflow', calls.includes('VIOwf4agent0001'));
ok('calls the Sendr page workflow', calls.includes('VIOwf6sendrgen01'));
ok('calls the GATED enrolment tool', calls.includes('VIOwfBpushinst1'));
for (const n of wf.nodes.filter(x => x.type === 'n8n-nodes-base.executeWorkflow'))
  ok(`${n.name} runs once per row`, n.parameters.mode === 'each');
// The enrolment tool holds its own Slack approval. This schedule may reach it, but it cannot
// enrol anybody without a human answering — that property lives in the tool, not here.
ok('the enrolment step waits for its sub-workflow (the approval blocks)',
   wf.nodes.find(n => n.parameters?.workflowId?.value === 'VIOwfBpushinst1')
     ?.parameters?.options?.waitForSubWorkflow === true);

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

console.log(`\n[demo-sheet-run] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
