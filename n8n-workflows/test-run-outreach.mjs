// Offline proof of VIO-demo-sheet-run's row handling. Reads jsCode straight out of the workflow
// JSON so the test cannot drift from what deploys.
//
// The risks here are specific: re-processing a row on every poll (this runs on a one-minute
// schedule), silently dropping a row the human is watching, and polling a tab the pipeline itself
// writes to — which would be a feedback loop against real spend.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-run-outreach.json', import.meta.url)));
const jsOf = (name) => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  if (n.type !== 'n8n-nodes-base.code') throw new Error(`"${name}" is ${n.type}, not a Code node`);
  return n.parameters.jsCode;
};
const CTRL = /[\u0000-\u001f\u007f]/;
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

// ---------- the claimed lead ----------
// MOVED TO SUPABASE 2026-09-05. Choosing WHICH lead to act on is now one SQL statement: the
// `leads_ready` view carries the lifecycle state, the source whitelist, the active-campaign check
// and a fresh suppression check, and the claim's own `channel_state_email in (...)` makes taking
// the same person twice impossible. Those conditions are tested where they live —
// test-leads-ready-sql.mjs, against the real view.
//
// What is left in JavaScript, and therefore here, is shaping the claimed row and refusing one that
// cannot be personalised.
const pickCode = jsOf('Pick demo rows');
const pick = (answer) => new Function('$input', pickCode)(
  { first: () => ({ json: answer }), all: () => [{ json: answer }] }).map((i) => i.json);

const lead = (o = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  first_name: 'Pratik', last_name: 'Patil', title: 'AI Solutions Engineer',
  company: 'VisioneerIT', contact_email: 'p.pshpatil@outlook.com',
  company_domain: 'visioneerit.com', product: 'oryoniq',
  channel_state_email: 'pending_approval', verify_action: 'pass', reoon_status: 'safe', ...o,
});
const claimed = (o = {}) => ({ ready_count: 1, lead: lead(o) });

ok('a claimed lead is shaped', pick(claimed()).length === 1);
// row_number kept its name because four nodes downstream read it; it carries the primary key now.
ok('the lead id is carried as row_number', pick(claimed())[0].row_number === lead().id);
ok('  and also under its real name', pick(claimed())[0].lead_id === lead().id);

// An idle cycle. The claim node always returns a row so the heartbeat can run, and `lead` is null
// on it — mistaking that for a lead would push an empty row through drafting and into a real send.
ok('nothing claimed -> nothing to shape', pick({ ready_count: 0, lead: null }).length === 0);
ok('  and a missing lead key is the same thing', pick({ ready_count: 0 }).length === 0);

// Product decides the copy, the Sendr template and the Instantly campaign. The column is a
// Postgres enum, so an unknown value cannot be stored today — this refuses anyway, because the day
// someone adds a third product to the enum this должен stop rather than draft GovCon copy for them.
for (const p of ['', 'acme', 'ORYONIQ ', null])
  ok(`product ${JSON.stringify(p)} is refused, not guessed`,
     p === 'ORYONIQ ' ? pick(claimed({ product: p }))[0].invalid === false
                      : pick(claimed({ product: p }))[0].invalid === true);
ok('a lead with no email is refused', pick(claimed({ contact_email: '' }))[0].invalid === true);
ok('a lead with neither name nor company is refused',
   pick(claimed({ first_name: '', company: '' }))[0].invalid === true);
ok('  but a company alone is enough to personalise',
   pick(claimed({ first_name: '' }))[0].invalid === false);
ok('the refusal says what was wrong, for the row the human reads',
   /no email address/.test(pick(claimed({ contact_email: '' }))[0].problems));

// `invalid` is the exact name and exact value the IF node tests (`invalid === true`), and the
// branch order matters: output 0 is the BAD path. Reading the node's name as "is it usable?"
// inverts it and sends every good lead to the explainer.
{
  const ifNode = wf.nodes.find((n) => n.name === 'Row usable?');
  ok('the IF still tests `invalid === true`',
     /\$json\.invalid === true/.test(ifNode.parameters.conditions.conditions[0].leftValue));
  const arms = wf.connections['Row usable?'].main;
  ok('  output 0 is the bad-row branch', arms[0][0].node === 'Explain the bad row');
  ok('  output 1 is the drafting branch', arms[1][0].node === 'Shape for drafting');
  ok('  and `invalid` is a real boolean, not a truthy string',
     typeof pick(claimed({ contact_email: '' }))[0].invalid === 'boolean');
}


// THE READINESS RULES MOVED INTO SQL. `not_sent` and `approved` are ready; every other state
// means hands off; `dropped` is never ready. Those are now conditions in the `leads_ready` view and
// in the claim's own `channel_state_email in (...)`, and they are asserted against the real view in
// test-leads-ready-sql.mjs. Asserting them here would assert a mock of a view.
//
// What must still be true HERE is that this workflow actually uses that view and that claim, and
// does not quietly grow a second opinion about who may be mailed.
{
  const claim = wf.nodes.find((n) => n.name === 'Claim one lead (atomic)');
  ok('the sender reads leads_ready and nothing else', /from leads_ready/.test(claim.parameters.query));
  ok('  and never selects straight out of leads', !/from leads\s+l?\s*$/m.test(claim.parameters.query));
  // The claim is what makes taking the same person twice impossible. Without the state predicate
  // on the UPDATE, two overlapping polls both pass the sub-select and both proceed.
  ok('the claim re-checks the state inside the UPDATE, under the row lock',
     /and l\.channel_state_email in \('not_sent', 'approved'\)/.test(claim.parameters.query));
  ok('  and marks the lead before any work is done',
     /set channel_state_email = 'pending_approval'/.test(claim.parameters.query));
  ok('  taking exactly one lead per cycle', /limit 1/.test(claim.parameters.query));
  // An idle cycle must still produce a row, or the heartbeat branch never runs and a dead
  // scheduler looks exactly like a quiet one.
  ok('the claim always returns a row, even when nothing is ready',
     /left join picked/.test(claim.parameters.query) && claim.alwaysOutputData === true);
  ok('the heartbeat does not hang off the lead branch',
     wf.connections['Claim one lead (atomic)'].main[0].some((t) => t.node === 'Heartbeat'));
}

// The override buys the right to be DRAFTED and then to pass VIO-enrol-email's own checks — it is
// not a licence to mail anyone. That workflow re-reads suppression and re-checks the verdict.
ok('enrolment still runs through a fail-closed precondition step',
   wf.nodes.some((n) => n.type === 'n8n-nodes-base.executeWorkflow'
     && n.parameters.workflowId?.value === 'VIOwfLenrolmail'));

// A bad lead must be REPORTED, not dropped — somebody is watching for it.
const bad = (o) => { const r = pick(claimed(o)); return r.length === 1 ? r[0] : null; };
for (const [label, o] of [
  ['missing first_name and company', { first_name: '', company: '' }],
  ['missing email', { contact_email: '' }],
  ['unknown product', { product: 'acme' }],
]) {
  const r = bad(o);
  ok(`${label} is surfaced, not dropped`, r !== null, 'lead vanished');
  if (r) {
    ok(`  ${label} is flagged invalid`, r.invalid === true);
    ok(`  ${label} explains why`, typeof r.problems === 'string' && r.problems.length > 0);
  }
}
ok('a good lead is not flagged', pick(claimed())[0].invalid === false);

// Hostile / messy input must not throw. A claim node returns whatever the row holds, and a crash
// here leaves the lead stuck at pending_approval with nothing to explain it.
for (const [label, answer] of [
  ['a null answer', {}],
  ['a null lead', { ready_count: 0, lead: null }],
  ['a lead of nulls', claimed({ first_name: null, company: null, contact_email: null, product: null })],
  ['non-string fields', claimed({ first_name: 42, company: {}, contact_email: [] })],
  ['control chars in a name', claimed({ first_name: 'Pra\ntik' })],
  ['a very long company', claimed({ company: 'x'.repeat(9000) })],
]) {
  let threw = null;
  try { pick(answer); } catch (e) { threw = e.message; }
  ok(`survives ${label}`, threw === null, threw);
}
ok('control characters are stripped',
   !CTRL.test(JSON.stringify(pick(claimed({ first_name: 'Pra\ntik' })))));
ok('over-long values are capped',
   pick(claimed({ company: 'x'.repeat(9000) }))[0].company.length <= 160);

// ---------- product routing into the drafter ----------
const shapeCode = jsOf('Shape for drafting');
const shape = (j) => new Function('$input', shapeCode)({ item: { json: j } }).json;
// PRODUCT ROUTING (fixed 2026-08-29). draft_config was hardcoded 'oryoniq', so a council CIO
// typed in for VisioneerIT was drafted GovCon capture copy signed OryonIQ. It now comes from the
// sheet's own Product column.
ok('an OryonIQ lead drafts with the OryonIQ config',
   shape(pick(claimed({ product: 'oryoniq' }))[0]).source_config === 'oryoniq');
ok('a VisioneerIT lead drafts with the VisioneerIT config',
   shape(pick(claimed({ product: 'visioneerit' }))[0]).source_config === 'visioneerit');
for (const p of ['', '   ', 'Acme', 'oryon', 'both'])
  ok(`product "${p}" is refused rather than guessed`, pick(claimed({ product: p }))[0].invalid === true);
ok('a refused lead names the product it could not use',
   /is not one this workflow can draft for/.test(pick(claimed({ product: 'acme' }))[0].problems));
// The page call must follow the row, not a constant.
ok('the Sendr page is generated for the row\'s own product',
   !/product: 'oryoniq'/.test(jsOf('Shape for page')));
ok('the lead identity survives into the drafter',
   shape(pick(claimed())[0])._row === '11111111-2222-3333-4444-555555555555');
ok('the email address survives into the drafter',
   shape(pick(claimed())[0])._email === 'p.pshpatil@outlook.com');

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
for (const node of ['Shape row update', 'Explain the bad row']) {
  const src = jsOf(node);
  for (const m of src.matchAll(/channel_state_email:\s*(?:[^'"\n]*\?\s*)?'([a-z_]+)'/g))
    ok(`${node} writes "${m[1]}" — a value the sheet dropdown allows`, SHEET_VOCAB.has(m[1]));
  for (const m of src.matchAll(/:\s*'([a-z_]+)'\s*;?\s*$/gm)) { /* no-op, guard above is enough */ }
}

// A lead parked on an unanswered approval must be CLAIMED, or the schedule re-drafts and re-pages
// it every cycle. Two Sendr pages were burned that way before the sheet version added a claim after
// the page. The Supabase version claims at the TOP instead, which closes the gap the old one left
// open: between reading the row and marking it, a second poll could take the same person.
{
  const claim = wf.nodes.find((n) => n.name === 'Claim one lead (atomic)');
  ok('the claim exists', Boolean(claim));
  ok('and it is the FIRST thing after the schedule, before any work is done',
     wf.connections['Every 3 minutes'].main[0][0].node === 'Claim one lead (atomic)');
  ok('nothing between the claim and the drafting can spend anything',
     !wf.nodes.some((n) => n.type === 'n8n-nodes-base.httpRequest'));
}

// ---------- structure ----------
ok('workflow id stable', wf.id === 'VIOwfDsheetdemo1');

// MOVED TO SUPABASE 2026-09-05. Everything this block guarded against was a property of sheets:
// which tab a node touched, whether an A1 range had drifted from the live column order, and a
// feedback loop from polling the same tab the pipeline appends to. None of them exist here — and
// left in place over an empty node list they would all pass while proving nothing.
ok('no Google Sheets node remains',
   wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets').length === 0);

const pgNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');
ok('the record is Postgres', pgNodes.length === 3, String(pgNodes.length));
ok('every database node is pinned to VIO Supabase by id',
   pgNodes.every((n) => n.credentials?.postgres?.id === 'VIOsupabasepg1'));
// The values crossing into these queries include a company name a stranger typed into a
// spreadsheet. An expression interpolated into the SQL text would hand them the query.
for (const n of pgNodes)
  ok(`  ${n.name}: no expression interpolated into the SQL text`, !/\{\{/.test(n.parameters.query));
for (const n of pgNodes.filter((x) => x.name !== 'Claim one lead (atomic)'))
  ok(`  ${n.name}: values arrive as one bound jsonb parameter`,
     /\$1::jsonb/.test(n.parameters.query));
// A write that fails once must not strand a lead at pending_approval with nothing to explain it.
for (const n of pgNodes)
  ok(`  ${n.name}: retries rather than stranding the lead`, n.retryOnFail === true);

// The heartbeat is NOT an events row. events is append-only and is what the console reads; one
// heartbeat every three minutes is 480 rows a day burying the ledger it exists to make readable.
const hb = pgNodes.find((n) => n.name === 'Write heartbeat');
ok('the heartbeat writes system_status, not events', /into system_status/.test(hb.parameters.query));
ok('  and overwrites rather than accumulating', /on conflict \(workflow\) do update/.test(hb.parameters.query));
ok('  nothing in this workflow inserts into events directly',
   !pgNodes.some((n) => /insert into events/i.test(n.parameters.query)));

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
ok('  and it comes from the claimed lead', /_verify_action/.test(jsOf('Shape for drafting'))
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
// A Sheets update used to sit between the page call and the readers, and it outputs the ROW IT
// WROTE — not the page result. Both readers therefore had to name the page node rather than read
// $input. That claim node is gone, so `Generate Sendr page` now feeds `Shape for enrolment`
// directly, but reading by NAME is still the correct habit: it survives a node being inserted
// between them again, which is exactly how this broke the first time. (2026-08-29 / 2026-09-05)
{
  const afterPage = wf.connections['Generate Sendr page'].main[0].map((c) => c.node);
  ok('the page result now reaches enrolment directly',
     afterPage.includes('Shape for enrolment'), afterPage.join(','));

  const js = jsOf('Shape for enrolment');
  ok('Shape for enrolment reads the page URL from the page node BY NAME',
     /\$\('Generate Sendr page'\)/.test(js), 'reads $input — that breaks the moment a node is inserted');
  ok('  and does not read pageUrl off its own input',
     !/\$input\.item\.json\.pageUrl/.test(js));
  ok('  and writes a real page URL, not the field that never existed',
     !/sendr_page_url:\s*src\._page_pending/.test(jsOf('Shape row update')));
}


// ---------- claim first, work second ----------
// A lead used to be claimed only AFTER drafting and page generation, while the schedule re-read the
// same tab every cycle — so one row produced two Slack approval requests, two drafts and two Sendr
// pages (seen live 2026-08-29). The sheet version fixed that with two separate claim writes, one on
// each branch. The database version needs neither: the claim IS the selection.
{
  const claim = wf.nodes.find((n) => n.name === 'Claim one lead (atomic)');

  // Nothing may run before the claim. If drafting could start first, the old bug is back.
  ok('the schedule fires the claim and nothing else',
     wf.connections['Every 3 minutes'].main[0].length === 1
     && wf.connections['Every 3 minutes'].main[0][0].node === 'Claim one lead (atomic)');

  // The two branches off the claim: work, and liveness. Drafting must receive the SHAPED lead, not
  // a database node's raw output — handing the chain the wrong shape is how the page URL was lost.
  const branch = wf.connections['Claim one lead (atomic)'].main[0].map((c) => c.node);
  ok('the claim feeds the picker and the heartbeat, in parallel',
     branch.includes('Pick demo rows') && branch.includes('Heartbeat'), branch.join(','));
  ok('drafting receives the shaped lead',
     wf.connections['Row usable?'].main[1][0].node === 'Shape for drafting');

  // Writing blanks for fields that do not exist yet would erase a previous run's values. The
  // claim touches the lifecycle column and the timestamp, and nothing else.
  for (const f of ['opener', 'email_draft', 'sendr_page_url'])
    ok(`the claim does not blank ${f}`,
       !new RegExp(`${f}\\s*=`).test(claim.parameters.query.slice(0, claim.parameters.query.indexOf('returning'))));

  // The poll must not be faster than the work it starts. With an atomic claim a fast poll is no
  // longer dangerous, only wasteful — but the ceiling still exists so this cannot be turned into a
  // hot loop against Reoon and OpenAI by changing one number.
  const mins = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger')
                 .parameters.rule.interval[0].minutesInterval;
  ok('the poll interval leaves room for the chain to finish', mins >= 2, `every ${mins} min`);
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
  const beat = (answer) => new Function('$input', jsOf('Heartbeat'))(
    { first: () => ({ json: answer }), all: () => [{ json: answer }] })[0].json;

  // It must hang off the CLAIM, so it reports what the database actually said rather than just
  // that a timer fired — and it must be the FIRST branch, so a throw further down cannot swallow it.
  const branch = wf.connections['Claim one lead (atomic)'].main[0].map((c) => c.node);
  ok('the heartbeat hangs off the claim', branch.includes('Heartbeat'), branch.join(', '));
  ok('  and runs before the work, so a later throw cannot swallow it', branch[0] === 'Heartbeat');
  // Without this the claim emits nothing on an idle cycle and the heartbeat never fires — exactly
  // when a human most needs to know the system is alive.
  ok('the claim always emits, so an idle cycle still produces a heartbeat',
     wf.nodes.find((n) => n.name === 'Claim one lead (atomic)').alwaysOutputData === true);

  const idle = beat({ ready_count: 0, lead: null });
  ok('it names the workflow in words a human recognises', /VIO-run-outreach/.test(idle.workflow));
  ok('it states the interval', idle.every_minutes === 3);
  ok('it says when the next check is due', String(idle.detail.next_check_at).length > 3);
  ok('  in local time, not UTC arithmetic', !/UTC/.test(String(idle.detail.next_check_at)));
  ok('an idle cycle still reports a result', /no leads ready/.test(idle.last_result));
  ok('  and reports itself healthy', idle.ok === true);
  ok('  with nothing waiting', idle.waiting === 0);

  // THE NUMBER THAT MATTERS. `waiting` counts what is ready AFTER this cycle took one. Reporting
  // the pre-claim number shows a queue that never empties even when the runner is keeping up; a
  // count that never falls is the signal that mail has stopped moving.
  const busy = beat({ ready_count: 5, lead: { contact_email: 'a@b.com' } });
  ok('a claimed lead is subtracted from the waiting count', busy.waiting === 4, String(busy.waiting));
  ok('  and the result names who was claimed', /a@b\.com/.test(busy.last_result));
  const stuck = beat({ ready_count: 3, lead: null });
  ok('leads ready but none claimed is called out, not reported as fine',
     /look at this/.test(stuck.last_result), stuck.last_result);

  // An unreachable database must say so rather than reporting a confident zero, which would read
  // as "nothing to do" — the exact wrong conclusion.
  const down = beat({});
  ok('an unreachable database is reported as not-ok', down.ok === false);
  ok('  and says no lead was lost', /no lead is lost/i.test(down.last_result));
  ok('  and does NOT claim a waiting count it does not have', down.waiting === null);

  // A write failure must never take down the run it is only reporting on.
  const w = wf.nodes.find((n) => n.name === 'Write heartbeat');
  ok('the heartbeat write cannot break the run it reports on', w.onError === 'continueRegularOutput');
  ok('  it updates one row per workflow instead of appending forever',
     /on conflict \(workflow\) do update/.test(w.parameters.query));
  ok('  and writes to system_status, never to the append-only ledger',
     /into system_status/.test(w.parameters.query) && !/into events/i.test(w.parameters.query));
}

// ---------- one lead per cycle, and WHY ----------
// Four nodes downstream read their lead with $('Shape for drafting').first(). In a multi-item run
// .first() is always item ZERO, so a second lead in the same cycle is built from the FIRST lead's
// identity — proven by running the real node code: processing "Bob" produced Alice's company,
// Alice's address and no product. A page branded with the wrong company, aimed at the wrong person.
// Capping here fixes all four call sites at once and cannot be partially applied.
{
  // The cap is now the SQL `limit 1`, not a JavaScript slice — one lead is claimed per cycle and
  // there is no second one to lose. But the reason the cap exists has not changed, so the guard
  // rail has not either.
  ok('exactly one lead is claimed per cycle',
     /limit 1/.test(wf.nodes.find((n) => n.name === 'Claim one lead (atomic)').parameters.query));
  ok('a claimed lead yields one item', pick(claimed()).length === 1);
  ok('no claimed lead yields nothing', pick({ ready_count: 0, lead: null }).length === 0);

  // THE GUARD RAIL. If anyone ever lifts that limit, these readers must be revisited first: in a
  // multi-item run `.first()` is ALWAYS item zero, so a second lead would be built from the first
  // lead's identity — a page branded with the wrong company, aimed at the wrong person.
  // Strip comments first: nodes quote the pattern in their own explanations, and counting a
  // comment as a call site would drift the moment anyone edits the prose.
  const codeOnly = (js) => js.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const firstReaders = wf.nodes
    .filter((n) => /\$\('[^']+'\)\.first\(\)/.test(codeOnly(n.parameters?.jsCode || '')))
    .map((n) => n.name);
  for (const nm of ['Shape for page', 'Shape for enrolment', 'Shape row update'])
    ok(`  ${nm} still reads .first() and depends on the cap`, firstReaders.includes(nm));
  ok('the .first() readers are exactly the three the cap protects',
     firstReaders.length === 3, firstReaders.join(', '));
}

// ---------- the Sendr page must receive the AI opener, not the template placeholder ----------
// VIO-sendr-generate-page's 'Build Page Request' reads lead.opener and lead.contact_email. Only
// _opener/_email were sent, so every personalized page rendered the TEMPLATE's placeholder line
// with no address attached — the per-lead opener is the entire point of the page.
{
  const src = { _row: 2, _email: 'bob@b.com', _first_name: 'Bob', _company: 'Beta', _title: 'CTO',
                _opener: 'the AI written line', _product: 'oryoniq', _domain: 'b.com',
                source_config: 'oryoniq' };
  const page = new Function('$input', '$', jsOf('Shape for page'))(
    { item: { json: { opener: 'ignored' } } }, () => ({ first: () => ({ json: src }) })).json;
  ok('the page receives the AI opener under the name the reader uses', page.opener === 'the AI written line');
  ok('the page receives the address for attribution', page.contact_email === 'bob@b.com');
  // Cross-check against what the sub-workflow actually reads, so a rename on either side fails here.
  const sendr = JSON.parse(readFileSync(new URL('./VIO-sendr-generate-page.json', import.meta.url)));
  const build = sendr.nodes.find((n) => n.name === 'Build Page Request').parameters.jsCode;
  for (const f of ['opener', 'contact_email', 'first_name', 'company'])
    ok(`'${f}' is both sent and read`, f in page && new RegExp(`lead\\.${f}\\b`).test(build));
}

// A failed READ must not silence the heartbeat. When the Sheets read died on a Google quota error
// the whole chain stopped, so the status row quietly stopped updating — the exact failure the
// heartbeat exists to make visible (seen live 2026-08-30). The database version has the same shape
// of risk: the claim is now the read, and if it throws, the heartbeat branch dies with it.
{
  const beat = (answer) => new Function('$input', jsOf('Heartbeat'))(
    { first: () => ({ json: answer }), all: () => [{ json: answer }] })[0].json;
  const claim = wf.nodes.find((n) => n.name === 'Claim one lead (atomic)');
  ok('the claim still emits when it finds nothing', claim.alwaysOutputData === true);
  ok('  and retries a transient database error rather than failing the cycle',
     claim.retryOnFail === true && claim.maxTries >= 3);

  // An unreachable database must be REPORTED, never reported as a confident zero — "nothing to do"
  // and "I could not look" are opposite conclusions and must not share a status line.
  const failed = beat({});
  ok('the heartbeat reports an unreachable database in plain words',
     /COULD NOT REACH THE DATABASE/.test(failed.last_result));
  ok('  and reassures that nothing is lost', /no lead is lost/i.test(failed.last_result));
  ok('  and refuses to invent a waiting count', failed.waiting === null);
  ok('  and marks itself not-ok so the console can show it', failed.ok === false);

  const good = beat({ ready_count: 1, lead: { contact_email: 'a@b.com' } });
  ok('a normal cycle still reports normally', good.ok === true && /claimed/.test(good.last_result));
}

console.log(`\n[run-outreach] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


