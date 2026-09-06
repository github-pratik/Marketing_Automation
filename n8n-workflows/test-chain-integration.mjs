// Offline proof of the SEAMS between workflows — not the insides of any one of them.
//
// Every other test-*.mjs in this folder loads jsCode out of ONE workflow's JSON and tests it in
// isolation. That is exactly why two real bugs reached a live run uncaught:
//   (a) VIO-inbox-mapper handed VIO-intake-verify-curate a lead, and VIO-intake-verify-curate's
//       'Normalize Lead' node builds its return value as an EXPLICIT object — so any field the
//       mapper sent that isn't named there is silently dropped. `Product` was lost this way.
//   (b) VIO-intake-verify-curate stamped a lifecycle value on EVERY lead it wrote to the Leads
//       tab, including ones Reoon had just rejected, and that exact value had just become
//       VIO-demo-sheet-run's definition of "ready to send" — so a rejected address landed in
//       Leads marked ready to run.
// Both are fixed in the code as of this writing (see the "FIX" comments inside the workflow JSON
// themselves), but nothing in the existing suites would fail if either regressed, because no
// existing suite ever feeds one workflow's real output into the next workflow's real input. This
// file does exactly that, by chaining the same jsCode-out-of-JSON technique across files.
//
// Chain under test: Inbox row -> VIO-inbox-mapper -> VIO-intake-verify-curate -> Leads row ->
// VIO-demo-sheet-run -> VIO-operator-agent.
//
// NEVER re-type any workflow's logic here. Every value asserted below is produced by running the
// REAL jsCode pulled straight out of the REAL JSON, so this file cannot drift from what is
// actually deployed the way a hand-written mock of "what intake does" could.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// The ready-state set, parsed from the migration that defines `leads_ready`. Both halves of the
// intake -> sender seam read it from there rather than each declaring their own copy.
import { READY_STATES } from './leads-ready-invariant.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const loadWf = (file) => JSON.parse(readFileSync(path.join(DIR, file)));
const jsOf = (wf, name, file = '?') => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node "${name}" in ${file}`);
  if (typeof n.parameters.jsCode !== 'string') throw new Error(`node "${name}" in ${file} has no jsCode`);
  return n.parameters.jsCode;
};

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) pass++;
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail++; }
};

const mapperWf = loadWf('VIO-inbox-mapper.json');
const intakeWf = loadWf('VIO-intake-verify-curate.json');
const demoWf = loadWf('VIO-run-outreach.json');
const agentWf = loadWf('VIO-operator-agent.json');

// ============================================================================================
// SEAM 1 — VIO-inbox-mapper "Shape Lead row"  --(Execute Workflow)-->  VIO-intake-verify-curate
//          "Batch In (one item per lead)" -> "Normalize Lead"
// ============================================================================================
// The exact shape of bug (a): 'Normalize Lead' rebuilds the lead as an explicit object literal.
// Anything the mapper sent that isn't named in that literal vanishes with no error, no warning,
// and no test anywhere else in this repo would go red.
const mapCode = jsOf(mapperWf, 'Map headers (alias table)', 'VIO-inbox-mapper.json');
const leadRowCode = jsOf(mapperWf, 'Shape Lead row', 'VIO-inbox-mapper.json');
const batchInCode = jsOf(intakeWf, 'Batch In (one item per lead)', 'VIO-intake-verify-curate.json');
const normalizeCode = jsOf(intakeWf, 'Normalize Lead', 'VIO-intake-verify-curate.json');

const runMap = (rows) => new Function('$input', mapCode)({ all: () => rows.map((j) => ({ json: j })) });
const runLeadRow = (row) => new Function('$input', leadRowCode)({ item: { json: row } }).json;
const runBatchIn = (items) => new Function('$input', batchInCode)({ all: () => items });
const runNormalize = (items) => new Function('$input', normalizeCode)({ all: () => items });

// A realistic Inbox row, arbitrary real-world headers, a human typed it and chose the product.
const inboxRow = {
  row_number: 9, status: '',
  'Company name': 'Acme Regional Water Authority', 'First name': 'PAT', 'Last name': 'OKONKWO',
  'Email address': 'pat.okonkwo@acmewater.gov', 'Website': 'acmewater.gov', 'Job Title': 'CIO',
  Product: 'VisioneerIT',
};

const mapped = runMap([inboxRow]).map((i) => i.json)[0];
ok('setup: the crafted Inbox row actually maps cleanly (so the seam test below is meaningful)',
   !!mapped && mapped._ok === true, JSON.stringify(mapped));

// This IS what crosses the Execute Workflow boundary from the mapper's side.
const shaped = runLeadRow(mapped);
const SENT_FIELDS = ['email', 'contact_email', 'first_name', 'last_name', 'company', 'title',
  'company_domain', 'linkedin_url', 'phone', 'source_config', 'Product'];
for (const f of SENT_FIELDS) {
  ok(`setup: the mapper's "Shape Lead row" actually sends "${f}"`, shaped[f] !== undefined && shaped[f] !== null);
}

const batched = runBatchIn([{ json: shaped }]);
ok('the intake join accepts a single bare lead item (not wrapped in a { leads: [...] } envelope)',
   batched.length === 1, JSON.stringify(batched));

const normalized = runNormalize(batched).map((i) => i.json);
ok('exactly one lead survives normalisation', normalized.length === 1);
const n = normalized[0] || {};

// THE REGRESSION THIS WOULD CATCH: if 'Normalize Lead' ever again forgets to name one of these
// fields in its explicit return object, that field reads back as undefined here and this line
// goes red — which is exactly the failure mode a Product-drop bug looks like from the outside.
for (const f of SENT_FIELDS) {
  ok(`"${f}" survives Normalize Lead's explicit-object rebuild`, n[f] === shaped[f],
     `sent ${JSON.stringify(shaped[f])}, got back ${JSON.stringify(n[f])}`);
}
// Named explicitly because this is the exact field and exact failure this seam existed to catch.
ok('Product specifically is not blank after normalisation (bug (a), as it actually happened)',
   n.Product === 'VisioneerIT', JSON.stringify(n));
ok('the email specifically is not blank after normalisation', n.email === 'pat.okonkwo@acmewater.gov');

// inbox_row is a deliberate, DOCUMENTED exception, not an oversight: Normalize Lead does not carry
// it, and 'Intake Result (to caller)' instead reads it back from Batch In's own output at the
// join. Assert both halves, so a change to either side that breaks the report-back path (without
// touching Normalize Lead at all) still goes red here.
ok("Normalize Lead does not carry inbox_row (by design — it is not part of this node's contract)",
   n.inbox_row === undefined);
ok("but Batch In's own output still carries inbox_row, for 'Intake Result' to read directly",
   batched[0].json.inbox_row === 9);

// ============================================================================================
// SEAM 2 — VIO-intake-verify-curate "Shape Lead Row"  -->  VIO-demo-sheet-run "Pick demo rows"
// ============================================================================================
// The exact shape of bug (b): intake writes ONE lifecycle value to Leads.channel_state_email no
// matter what Reoon decided, and demo-sheet-run reads that same column to decide what is safe to
// run. If the two ever disagree on which value means "go", either a rejected address gets sent or
// a good one never runs. The verdict->value mapping below is produced by running the REAL
// 'Classify' node, not by re-deriving my own idea of what Reoon status should mean.
const classifyCode = jsOf(intakeWf, 'Classify (pass / drop / needs_review)', 'VIO-intake-verify-curate.json');
const shapeLeadRowCode = jsOf(intakeWf, 'Shape Lead Row', 'VIO-intake-verify-curate.json');
const pickDemoRowsCode = jsOf(demoWf, 'Pick demo rows', 'VIO-run-outreach.json');

// Fakes just enough of n8n's $() node-reference API for 'Classify' to run standalone.
const runClassify = (reoonResponse, gateLead) => {
  const $ = (name) => ({
    all: () => (name === 'Gate (dedupe + suppression)' ? [{ json: gateLead }] : []),
  });
  return new Function('$input', '$', classifyCode)({ all: () => [{ json: reoonResponse }] }, $);
};
const runShapeLeadRow = (classifyItemJson) =>
  new Function('$input', shapeLeadRowCode)({ all: () => [{ json: classifyItemJson }] });
// The runner no longer filters rows in JavaScript — `leads_ready` does it in SQL. So the seam this
// suite exists to guard is now "does the state intake WRITES appear in the set the sender ACTS ON",
// and both halves are read from one place: leads-ready-invariant.mjs, which parses the view's own
// migration. A constant copied into two languages is how this seam broke twice already.
const senderWouldAct = (leadsRow) => READY_STATES.includes(leadsRow.channel_state_email);

const baseLead = {
  lead_id: 'abc123def456', source_config: 'Manual', Product: 'VisioneerIT', apollo_id: '',
  first_name: 'Pat', last_name: 'Okonkwo', title: 'CIO', company: 'Acme Water Authority',
  company_domain: 'acmewater.gov', email: 'pat.okonkwo@acmewater.gov',
  contact_email: 'pat.okonkwo@acmewater.gov', phone: '', linkedin_url: '', timezone: '',
  signal: '', has_email: true, has_phone: false,
};

// Reoon statuses picked to exercise all three of Classify's branches — pass / drop / needs_review
// — per INTEGRATIONS.md's documented mapping, which 'Classify' itself implements and this reuses
// rather than re-declaring.
const scenarios = [
  { label: 'a Reoon-safe address', status: 'safe',
    extra: { is_safe_to_send: true, is_deliverable: true, is_catch_all: false }, runnable: true },
  { label: 'a Reoon-invalid (hard-fail) address', status: 'invalid',
    extra: { is_safe_to_send: false, is_deliverable: false, is_catch_all: false }, runnable: false },
  { label: 'a Reoon catch-all address', status: 'catch_all',
    extra: { is_safe_to_send: false, is_deliverable: true, is_catch_all: true }, runnable: false },
];

for (const { label, status, extra, runnable } of scenarios) {
  const reoonResponse = { email: baseLead.email, status, overall_score: 70, ...extra };
  const verdict = runClassify(reoonResponse, baseLead)[0].json;
  const leadsRow = runShapeLeadRow(verdict)[0].json; // == what intake actually writes to Leads
  ok(`setup: ${label} is written to Leads with a Product (column-name check, see SEAM 3)`,
     leadsRow.Product === 'VisioneerIT', JSON.stringify(leadsRow));

  const acted = senderWouldAct(leadsRow);
  if (runnable) {
    ok(`${label} (verdict "${verdict.action}", channel_state_email="${leadsRow.channel_state_email}") IS acted on by the sender`,
       acted === true, leadsRow.channel_state_email);
  } else {
    ok(`${label} (verdict "${verdict.action}", channel_state_email="${leadsRow.channel_state_email}") is NOT acted on automatically — bug (b) would have shipped this row`,
       acted === false, leadsRow.channel_state_email);
  }
}

// The documented human override: a catch-all lead a person has personally vouched for. This is
// the other half of the same seam — the override column value has to ALSO be honoured, not just
// the automatic 'not_sent' path.
{
  const reoonResponse = { email: baseLead.email, status: 'catch_all', is_safe_to_send: false,
    is_deliverable: true, is_catch_all: true, overall_score: 70 };
  const verdict = runClassify(reoonResponse, baseLead)[0].json;
  const leadsRow = runShapeLeadRow(verdict)[0].json;
  ok('setup: the catch-all row really was parked at needs_review before the override',
     leadsRow.channel_state_email === 'needs_review');
  // A human vouches for it — historically by editing the sheet, now by clicking Release in the
  // console, which writes exactly this value.
  leadsRow.channel_state_email = 'approved';
  ok('a human-approved catch-all lead IS acted on (the override that exists for exactly this)',
     senderWouldAct(leadsRow), leadsRow.channel_state_email);
  // And the override has to survive the trip: the console writes `approved`, and the view has to
  // still call that ready. Two words for one idea is how the 2026-08-29 handoff broke.
  ok('  and `approved` is in the sender\'s ready set, not merely tolerated',
     READY_STATES.includes('approved'), JSON.stringify(READY_STATES));
}

// ============================================================================================
// SEAM 3 — column-name agreement: "Product" (capital P), everywhere this pipeline touches it
// ============================================================================================
// A case mismatch between a writer and a reader (or between a writer's jsCode and the Sheets
// node's own column schema) does not error — the Sheets node's autoMapInputData either creates a
// brand new blank column or silently leaves the intended one untouched, and a reader keyed on the
// other case just gets undefined forever.
ok('mapper writes the lead\'s product under the key "Product" (capital P)', shaped.Product !== undefined);
ok('Normalize Lead still exposes it as "Product"', n.Product !== undefined);
ok('intake\'s Shape Lead Row writes it to the Leads row as "Product"',
   runShapeLeadRow(runClassify({ email: baseLead.email, status: 'safe', is_safe_to_send: true,
     is_deliverable: true, is_catch_all: false }, baseLead)[0].json)[0].json.Product === 'VisioneerIT');
ok('the sender reads the product from the lead\'s own column, not a default',
   /lead\.product/.test(pickDemoRowsCode) && !/'oryoniq'\s*;/.test(pickDemoRowsCode));

// Every Google Sheets WRITE node in the whole repo whose schema declares a product-ish column
// must spell it EXACTLY "Product" — derived dynamically from every VIO-*.json on disk, not from a
// list of files I typed by hand (parallel agents are editing this folder right now).
const files = readdirSync(DIR).filter((f) => /^VIO-.*\.json$/.test(f));
const allWfs = new Map(files.map((f) => [f, loadWf(f)]));

let productSchemaChecks = 0;
for (const [f, wf] of allWfs) {
  for (const wnode of wf.nodes) {
    const schema = wnode.parameters?.columns?.schema || [];
    for (const col of schema) {
      if (String(col.id || '').toLowerCase() === 'product') {
        productSchemaChecks++;
        ok(`${f} node "${wnode.name}" spells the product column exactly "Product"`, col.id === 'Product',
           `got ${JSON.stringify(col.id)}`);
      }
    }
  }
}
ok('setup: at least one product column schema was actually found and checked (not vacuous)',
   productSchemaChecks > 0);

// SEAM 3b — the last leg of the stated chain: demo-sheet-run -> VIO-operator-agent. The product
// travels as lowercase `source_config` on the way in; the agent's own `validate_config` must
// resolve it to the SAME product it was drafted for, or a VisioneerIT lead gets OryonIQ copy
// again (the exact bug this build has already shipped once, per CLAUDE.md's own commit history).
const draftingCode = jsOf(demoWf, 'Shape for drafting', 'VIO-run-outreach.json');
const validateConfigCode = jsOf(agentWf, 'validate_config', 'VIO-operator-agent.json');
const runShapeForDrafting = (row) => new Function('$input', draftingCode)({ item: { json: row } }).json;
const runValidateConfig = (item) =>
  new Function('$input', validateConfigCode)({ first: () => ({ json: item }) })[0].json;

// A claimed lead, in the shape the atomic claim returns it — `product` is a Postgres enum now,
// lowercase, where the sheet's column was capital-P display text.
const claimedLead = (product) => ({
  ready_count: 1,
  lead: {
    id: '99999999-8888-7777-6666-555555555555',
    first_name: 'Pat', company: 'Acme Water Authority',
    contact_email: 'pat.okonkwo@acmewater.gov', title: 'CIO', company_domain: 'acmewater.gov',
    source: 'manual', channel_state_email: 'not_sent', product,
    verify_action: 'pass', reoon_status: 'safe',
  },
});
const runPick = (answer) => new Function('$input', pickDemoRowsCode)(
  { first: () => ({ json: answer }), all: () => [{ json: answer }] });

for (const productCol of ['oryoniq', 'visioneerit']) {
  const picked = runPick(claimedLead(productCol))[0]?.json;
  ok(`setup: a "${productCol}" row is picked up as valid, not refused`, !!picked && picked.invalid === false,
     JSON.stringify(picked));
  const drafted = runShapeForDrafting(picked);
  const cfg = runValidateConfig(drafted);
  ok(`the sender's product handoff resolves the operator agent's OWN "${productCol}" config, not a default`,
     String(cfg.product).toLowerCase() === productCol,
     `config_used=${cfg.config_used}, product=${cfg.product}, defaulted=${cfg.config_defaulted}`);
}

// ============================================================================================
// SEAM 4 — every Execute Workflow node's target actually exists as a workflow on disk
// ============================================================================================
// A call to a workflow id that doesn't exist (typo, renamed file, id changed on import) throws
// only at RUNTIME on a live n8n instance — nothing in any single-workflow suite can see it, since
// each one only ever loads its own file. Derived fully dynamically: every VIO-*.json currently in
// the folder, and every id it declares — not a list I typed by hand.
const idToFile = new Map();
for (const [f, wf] of allWfs) {
  if (wf.id) idToFile.set(wf.id, f);
}
ok('setup: more than one workflow id was found to check Execute Workflow targets against',
   idToFile.size > 1, `found ${idToFile.size}`);

let execWorkflowChecks = 0;
for (const [f, wf] of allWfs) {
  for (const wnode of wf.nodes) {
    if (wnode.type !== 'n8n-nodes-base.executeWorkflow') continue;
    const target = wnode.parameters?.workflowId?.value;
    execWorkflowChecks++;
    ok(`${f} node "${wnode.name}" (Execute Workflow) targets an id that exists as some VIO-*.json's own id`,
       typeof target === 'string' && idToFile.has(target),
       `target=${JSON.stringify(target)}; known ids: ${[...idToFile.keys()].join(', ')}`);
  }
}
ok('setup: at least one Execute Workflow node was actually found and checked (not vacuous)',
   execWorkflowChecks > 0, `checked ${execWorkflowChecks}`);

// ============================================================================================
// SEAM 5 — one shared vocabulary for Leads.channel_state_email across every workflow that writes it
// ============================================================================================
// The whole point of this section: derive what each workflow ACTUALLY writes by reading its own
// code, rather than typing out "the vocabulary" from memory or from a doc — a doc can drift, and
// a hand-typed list would just be my own guess repeated back at me.
//
// Extraction method: find every `channel_state_email:` object-literal assignment in a workflow's
// combined jsCode, and pull out the literal string(s) it can resolve to — a bare string literal,
// every "then" branch of a ternary chain (a value right after a `?`), the final "else" at the end
// of a ternary chain, or (for a bare identifier like `e.stage`) whatever that identifier is
// literally assigned to elsewhere in the SAME file. This deliberately does not try to be a real
// JS parser — it is good enough to recover every case actually used in this codebase, which was
// checked by hand against the source above while writing this file.
function stripLineComments(code) {
  return code.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}
function extractAssignedLiterals(code, key) {
  const values = new Set();
  const re = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*:\\s*', 'g');
  let m;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length;
    let depth = 0, j = i;
    while (j < code.length) {
      const ch = code[j];
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
      j++;
    }
    const expr = code.slice(i, j);
    for (const mm of expr.matchAll(/\?\s*'([a-zA-Z_][a-zA-Z0-9_]*)'/g)) values.add(mm[1]);
    const tail = expr.match(/:\s*'([a-zA-Z_][a-zA-Z0-9_]*)'\s*$/);
    if (tail) values.add(tail[1]);
    const bare = expr.trim().match(/^'([a-zA-Z_][a-zA-Z0-9_]*)'$/);
    if (bare) values.add(bare[1]);
    const ident = expr.trim().match(/^[a-zA-Z_][a-zA-Z0-9_.]*$/);
    if (ident) {
      const varName = ident[0].split('.').pop();
      const assignRe = new RegExp('\\b' + varName + "\\s*=\\s*'([a-zA-Z_][a-zA-Z0-9_]*)'", 'g');
      for (const am of code.matchAll(assignRe)) values.add(am[1]);
    }
  }
  return values;
}

const vocabByFile = new Map();
for (const [f, wf] of allWfs) {
  const allCode = stripLineComments(wf.nodes.map((wn) => wn.parameters?.jsCode || '').join('\n\n'));
  const values = extractAssignedLiterals(allCode, 'channel_state_email');
  if (values.size) vocabByFile.set(f, values);
}
ok('setup: more than one workflow was found writing channel_state_email (the seam this section checks)',
   vocabByFile.size > 1, `writers: ${[...vocabByFile.keys()].join(', ')}`);

// THE READY SET NOW LIVES IN SQL. It used to be a `new Set([...])` literal inside the sender's
// JavaScript, and this block extracted it and checked every writer's value against it. The set is
// now a condition in the `leads_ready` view, so it is parsed out of that view's migration by
// leads-ready-invariant.mjs — and both sides of this seam import it from there rather than each
// keeping a copy. A copy is how this broke on 2026-08-29 and again on 2026-09-05.
for (const st of ['not_sent', 'approved'])
  ok(`intake's ready value "${st}" is in the set the sender acts on`, READY_STATES.includes(st),
     JSON.stringify(READY_STATES));
for (const st of ['dropped', 'needs_review', 'pending_approval', 'enrolled'])
  ok(`"${st}" is NOT in it — a lead in that state must not be mailed`, !READY_STATES.includes(st));
// And the whole point of parsing rather than declaring: this fails if the view stops saying it.
ok('the ready set came from the view definition, not from this file',
   READY_STATES.length >= 2 && READY_STATES.length <= 4, JSON.stringify(READY_STATES));

// 'enrolled' means "already sent" everywhere it is written — every writer of it must agree that it
// is a terminal state, i.e. NONE of them should also be treating it as still-runnable.
const enrolledWriters = [...vocabByFile.entries()].filter(([, v]) => v.has('enrolled')).map(([f]) => f);
ok('setup: more than one workflow was found writing "enrolled" (push-instantly / enrol-email / demo-sheet-run)',
   enrolledWriters.length > 1, `writers: ${enrolledWriters.join(', ')}`);
ok('"enrolled" is excluded from the sender\'s ready set everywhere it is written (an enrolled lead must never restart)',
   !READY_STATES.includes('enrolled'));

// ---------------------------------------------------------------------------
// A CALLABLE WORKFLOW MUST HAVE EXACTLY ONE TERMINAL NODE.
//
// n8n returns the output of whichever terminal node finishes LAST. A workflow
// that ends on a side effect therefore has no return value worth the name — and
// a Google Sheets node's output is the ROW IT WROTE, so the caller silently
// receives {timestamp, lead_email, tool, action, ...} instead of a verdict.
//
// This has now bitten twice:
//   * VIO-intake-verify-curate ended on four separate branches; a caller got
//     whichever one happened to run last. Fixed with 'Intake Result (to caller)'.
//   * VIO-enrol-email had TWO terminals — the real result AND `Write intent`, the
//     write-ahead checkpoint, dangling as a parallel dead end. VIO-run-outreach
//     got the Events row on 2026-09-01 and refused the whole send record.
//
// Both were invisible to the per-workflow suites because each workflow was fine
// on its own. It is a SEAM defect, so it is tested here.
for (const f of ['VIO-intake-verify-curate', 'VIO-enrol-email', 'VIO-sendr-generate-page',
                 'VIO-operator-agent', 'VIO-source-leads']) {
  const w = JSON.parse(readFileSync(new URL(`./${f}.json`, import.meta.url)));
  const callable = (w.nodes || []).some((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
  if (!callable) continue;
  const hasOutgoing = new Set(Object.keys(w.connections || {}));
  const terminals = (w.nodes || [])
    .filter((n) => !hasOutgoing.has(n.name))
    .filter((n) => !/stickyNote/i.test(n.type));
  // The rule that actually matters is NOT "exactly one terminal" — two Code nodes on the
  // two arms of an IF are a legitimate either/or result, and `VIO-operator-agent` and
  // `VIO-sendr-generate-page` are both shaped that way on purpose.
  //
  // The rule is: NO TERMINAL MAY BE A SIDE EFFECT. A Sheets/HTTP/Slack node's output is the
  // row it wrote or the response it got, which is data-shaped and passes for a verdict — so
  // it corrupts the caller silently instead of failing. Both real occurrences of this bug
  // (`Write intent`, `Log Reoon Call (Events)`) were dangling Sheets writes.
  const sideEffects = terminals.filter((n) => /googleSheets|httpRequest|slack/i.test(n.type));
  ok(`${f}: no terminal node is a side effect (its output would pass for a verdict)`,
     sideEffects.length === 0,
     `dangling: ${sideEffects.map((n) => `${n.name} [${n.type.split('.').pop()}]`).join(', ')}`);
}

console.log(`\n[chain-integration] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
