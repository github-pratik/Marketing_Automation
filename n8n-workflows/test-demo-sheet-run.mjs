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
const pickCode = jsOf('Pick unprocessed rows');
const pick = (rows) => new Function('$input', pickCode)({ all: () => rows.map(j => ({ json: j })) })
  .map(i => i.json);

const row = (o = {}) => ({
  row_number: 2, first_name: 'Pratik', title: 'AI Solutions Engineer',
  company: 'VisioneerIT', contact_email: 'p.pshpatil@outlook.com', product: 'demo', status: '', ...o,
});

ok('a fresh row is picked up', pick([row()]).length === 1);
ok('the row number is carried', pick([row()])[0].row_number === 2);
ok('a blank product defaults to demo', pick([row({ product: '' })])[0].product === 'demo');
ok('product is lowercased', pick([row({ product: 'OryonIQ' })])[0].product === 'oryoniq');

// Idempotence — this polls every minute, so a claimed row must never be re-processed.
for (const s of ['queued', 'drafted', 'done', 'skipped', 'error', 'anything at all'])
  ok(`status "${s}" means already claimed`, pick([row({ status: s })]).length === 0);
ok('whitespace-only status still counts as unclaimed', pick([row({ status: '   ' })]).length === 1);

// Blank spacer rows are not errors.
ok('a wholly blank row is ignored',
   pick([{ row_number: 9, first_name: '', company: '', contact_email: '', status: '' }]).length === 0);

// A bad row must be REPORTED, not dropped — the person who typed it is watching.
const bad = (o) => { const r = pick([row(o)]); return r.length === 1 ? r[0] : null; };
for (const [label, o] of [
  ['missing first_name', { first_name: '' }],
  ['missing company', { company: '' }],
  ['missing email', { contact_email: '' }],
  ['malformed email', { contact_email: 'not-an-address' }],
  ['email with a comma', { contact_email: 'a@b.com,c@d.com' }],
  ['email with brackets', { contact_email: '<a@b.com>' }],
  ['unknown product', { product: 'acme' }],
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
  ['row of nulls', [{ first_name: null, company: null, contact_email: null, status: null }]],
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
ok('demo drafts with the OryonIQ config', shape(pick([row({ product: 'demo' })])[0]).source_config === 'oryoniq');
ok('visioneerit drafts with its own config',
   shape(pick([row({ product: 'visioneerit' })])[0]).source_config === 'visioneerit');
ok('the row identity survives into the drafter', shape(pick([row()])[0])._row === 2);
ok('the email address survives into the drafter', shape(pick([row()])[0])._email === 'p.pshpatil@outlook.com');

// ---------- the row never claims more than happened ----------
const markCode = jsOf('Mark drafted');
const mark = (j) => new Function('$input', markCode)({ item: { json: j } }).json;
const drafted = mark({ row_number: 2, drafted: true, opener: 'x' });
ok('a drafted row is marked drafted, not sent', drafted.status === 'drafted');
ok('the note does not claim an email was sent', !/\bsent\b/i.test(drafted.notes), drafted.notes);
ok('the note says enrolment is separate and approved', /separate|approv/i.test(drafted.notes));
ok('a draft with no opener is an error, not a success', mark({ drafted: false }).status === 'error');

const badRow = new Function('$input', jsOf('Explain the bad row'))(
  { item: { json: { row_number: 5, problems: 'contact_email is blank' } } }).json;
ok('a skipped row says skipped', badRow.status === 'skipped');
ok('a skipped row explains itself in the sheet', /contact_email is blank/.test(badRow.notes));

// ---------- structure ----------
ok('workflow id stable', wf.id === 'VIOwfDsheetdemo1');

const sheetNodes = wf.nodes.filter(n => n.type === 'n8n-nodes-base.googleSheets');
ok('every Sheets node is pinned to the VIO credential by id',
   sheetNodes.length > 0 && sheetNodes.every(n => n.credentials?.googleApi?.id === 'VIOgsheetcred01'));

// The feedback-loop guard. Polling Leads would re-trigger on rows the live intake pipeline
// appends, which is a loop against real Reoon and OpenAI spend.
const tabs = sheetNodes.map(n => n.parameters.sheetName?.value);
ok('reads and writes the Demo tab only, never Leads', tabs.every(t => t === 'Demo'), tabs.join(','));
ok('no A1 range anywhere (live column order does not match the docs)',
   !/"[A-Z]{1,2}[0-9]{1,4}:[A-Z]{1,2}/.test(JSON.stringify(wf)));

const calls = wf.nodes.filter(n => n.type === 'n8n-nodes-base.executeWorkflow')
                      .map(n => n.parameters.workflowId.value);
ok('calls the drafting workflow', calls.includes('VIOwf4agent0001'));
ok('drafting runs once per row, not once for the batch',
   wf.nodes.find(n => n.name === 'Draft (operator agent)')?.parameters?.mode === 'each');

// This workflow runs unattended on a schedule. Nothing that spends money or reaches a person may
// be reachable from it without its own approval — and neither is wired in today.
const GATED = {
  VIOwfBpushinst1: 'push_to_instantly (contacts real people)',
  VIOwfArevealcon1: 'reveal_contacts (Apollo credits)',
  VIOwf1intake0001: 'intake verify (Reoon credits)',
};
for (const [id, what] of Object.entries(GATED))
  ok(`unattended schedule does NOT call ${what}`, !calls.includes(id));
ok('no direct HTTP node', !wf.nodes.some(n => n.type === 'n8n-nodes-base.httpRequest'));

const names = new Set(wf.nodes.map(n => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const g of v.main) for (const c of g)
    ok(`connection ${src} -> ${c.node} resolves`, names.has(c.node));

console.log(`\n[demo-sheet-run] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
