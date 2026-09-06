// Test harness for the VIO-intake-verify-curate BRAIN — built 2026-08-17.
//
// Unlike the other harnesses here, this one does NOT re-type the node logic: it reads the jsCode
// straight out of VIO-intake-verify-curate.json and runs it inside a small n8n shim. So it tests
// what will actually run on the droplet, and it cannot silently drift from the workflow.
//
// What it proves before a single Reoon credit or Sheets write happens live:
//   * lead_id is deterministic and matches real sha256 (checked against node:crypto)
//   * suppression matches on EVERY identifier — email, email-domain, company-domain, phone,
//     linkedin — across realistic formatting variants, and a malformed suppression row still
//     suppresses instead of being ignored
//   * dedupe skips a lead already on the Leads tab, by contact_email or by lead_id
//   * an empty tab (header row only) reads as empty, not as a match — the failure mode that would
//     otherwise let everything through or block everything
//   * the Reoon classify mapping is unchanged, including `disposable` -> needs_review
//   * the two Sheets rows carry exactly the documented columns, nothing more, nothing less
//
// Run:  node test-intake-gate.mjs

import { readFileSync } from 'node:fs';
import { READY_STATES } from './leads-ready-invariant.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WF = JSON.parse(readFileSync(join(HERE, 'VIO-intake-verify-curate.json'), 'utf8'));

const jsOf = (name) => {
  const n = WF.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named "${name}" in the workflow JSON`);
  return n.parameters.jsCode;
};

// ---- minimal n8n Code-node shim (runOnceForAllItems) ----------------------------------------
const wrap = (v) => (Array.isArray(v) ? v : [v]).map((json) => ({ json }));

function runNode(nodeName, { input = [], nodes = {} } = {}) {
  const body = jsOf(nodeName);
  const $input = { all: () => wrap(input) };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`shim: node "${name}" not wired for this test`);
    const branches = nodes[name];
    return {
      all: (branch = 0) => wrap(Array.isArray(branches[0]) ? branches[branch] : branches),
      first: () => wrap(Array.isArray(branches[0]) ? branches[0] : branches)[0],
    };
  };
  // eslint-disable-next-line no-new-func
  return new Function('$input', '$', body)($input, $).map((i) => i.json);
}

// MOVED TO SUPABASE 2026-09-05. The gate no longer reads two whole tabs and matches in
// JavaScript; it asks Postgres one question per lead and acts on the answer. So what this harness
// supplies is the ANSWER, not the raw data.
//
// The identifier matching itself — does suppressing a domain catch a subdomain, does a plus-tag
// slip past, do zero-width characters — is now `is_suppressed()` in SQL, and is tested against the
// real database in test-suppression-sql.mjs. Asserting it here would be asserting a mock.
function gate(lead, answer = {}) {
  const normalized = runNode('Normalize Lead', { input: [lead] });
  return runNode('Gate (dedupe + suppression)', {
    input: [Object.assign({ dupe: false, suppressed: false }, answer)],
    nodes: { 'Normalize Lead': normalized },
  })[0];
}

// A batch: one answer per lead, positionally paired the way Postgres returns them.
function gateBatch(leads, answers) {
  const normalized = runNode('Normalize Lead', { input: leads });
  return runNode('Gate (dedupe + suppression)', {
    input: answers.map((a) => Object.assign({ dupe: false, suppressed: false }, a)),
    nodes: { 'Normalize Lead': normalized },
  });
}

function classify(reoon, gatedLead) {
  return runNode('Classify (pass / drop / needs_review)', {
    input: [reoon],
    nodes: { 'Gate (dedupe + suppression)': [gatedLead], 'Verify this lead?': [[gatedLead]] },
  })[0];
}

// ---- assertions ------------------------------------------------------------------------------
let pass = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fails.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const LEAD = {
  email: 'Jane.Doe@Acme-Fed.com ', first_name: 'Jane', last_name: 'Doe',
  title: 'Capture Manager', company: 'Acme Federal', company_domain: 'https://www.acme-fed.com/',
  phone: '+1 (202) 555-0143', linkedin_url: 'https://www.linkedin.com/in/janedoe/',
  apollo_id: '', source_config: 'oryoniq', signal: 'new BPA award',
};

console.log('\n== lead_id ==');
{
  const n = runNode('Normalize Lead', { input: [LEAD] })[0];
  const real = createHash('sha256').update('jane.doe@acme-fed.com').digest('hex').slice(0, 16);
  eq('sha256(lowercased, trimmed email) matches node:crypto', n.lead_id, real);
  eq('email is normalised', n.email, 'jane.doe@acme-fed.com');
  eq('lead_id_source reports the rule used', n.lead_id_source, 'sha256(email)');

  const withApollo = runNode('Normalize Lead', { input: [{ ...LEAD, apollo_id: '5f3a9b' }] })[0];
  eq('apollo_id wins when present', withApollo.lead_id, '5f3a9b');
  eq('lead_id_source reports apollo', withApollo.lead_id_source, 'apollo_id');

  const again = runNode('Normalize Lead', { input: [{ email: 'JANE.DOE@acme-fed.com' }] })[0];
  eq('same email, different casing -> same lead_id', again.lead_id, n.lead_id);

  const unicode = runNode('Normalize Lead', { input: [{ email: 'josé@acme.com' }] })[0];
  eq('utf-8 email hashes correctly',
    unicode.lead_id, createHash('sha256').update('josé@acme.com').digest('hex').slice(0, 16));
}

console.log('\n== clean pass through the gate ==');
{
  const g = gate(LEAD);
  eq('a clean answer -> verify', g.gate_action, 'verify');
  eq('reason ok', g.gate_reason, 'ok');
  eq('the gate records where its answer came from', g.gate_source, 'supabase');
  // These counted sheet rows. There is no scan any more, so they report null rather than 0 —
  // a zero here would read as "the tab was empty", a different and misleading claim.
  eq('no row count is claimed', g.leads_rows_scanned, null);
  eq('and none for suppression either', g.suppression_rows_scanned, null);
}

console.log('\n== the gate acts on the answer it is given ==');
{
  const supp = gate(LEAD, { suppressed: true });
  ok('suppressed -> skip', supp.gate_action === 'skip' && supp.gate_reason === 'suppressed', supp.gate_detail);
  ok('  and the detail names the four identifiers checked',
     /email .* domain .* phone .* linkedin/.test(supp.gate_detail), supp.gate_detail);

  const dupe = gate(LEAD, { dupe: true });
  ok('duplicate -> skip', dupe.gate_action === 'skip' && dupe.gate_reason === 'duplicate', dupe.gate_detail);
  ok('  and names the address it matched', dupe.gate_detail.includes('jane.doe@acme-fed.com'), dupe.gate_detail);

  const clean = gate(LEAD, { dupe: false, suppressed: false });
  eq('neither -> verify', clean.gate_action, 'verify');
}

console.log('\n== precedence and fail-closed ==');
{
  // Both true: the person asked us to stop, which is the more important fact about them and the
  // one worth seeing in the log.
  eq('suppressed AND duplicate reports suppressed',
     gate(LEAD, { dupe: true, suppressed: true }).gate_reason, 'suppressed');

  const noKey = gate({ first_name: 'Nobody', company: 'Ghost Co' });
  ok('no email and no apollo_id -> skip, never verify',
     noKey.gate_action === 'skip' && noKey.gate_reason === 'no_identifier', noKey.gate_detail);
  // Checked BEFORE the database answer, so a lead with no identifier is refused even if the query
  // came back clean — there is nothing to look it up by.
  eq('  and that holds even on a clean answer',
     gate({ first_name: 'Nobody' }, { dupe: false, suppressed: false }).gate_reason, 'no_identifier');

  // THE fail-closed case, and the one that did not exist on the sheet. If Postgres returns fewer
  // rows than we sent leads, the missing lead has NO answer. Verifying it anyway would mean
  // mailing someone we cannot prove is not on the suppression list.
  const short = gateBatch(
    [LEAD, { email: 'second@acme-fed.com' }],
    [{ dupe: false, suppressed: false }],          // one answer, two leads
  );
  eq('a lead with no answer is held, not verified', short[1].gate_action, 'skip');
  eq('  with a reason that says the check could not run', short[1].gate_reason, 'gate_unavailable');
  eq('  and the lead that DID get an answer is unaffected', short[0].gate_action, 'verify');
}

console.log('\n== in-batch dedupe (still ours, not the database\'s) ==');
{
  // Two copies of one person in a single upload are both absent from the database, so both come
  // back dupe:false. Only the batch itself knows they are the same, and verifying twice would
  // spend two Reoon credits on one mailbox.
  const twice = gateBatch(
    [LEAD, { ...LEAD }],
    [{ dupe: false }, { dupe: false }],
  );
  eq('the first copy verifies', twice[0].gate_action, 'verify');
  eq('the second is caught in-batch', twice[1].gate_reason, 'duplicate_in_batch');

  const byId = gateBatch(
    [{ ...LEAD, apollo_id: 'zz9' }, { ...LEAD, apollo_id: 'zz9', email: 'other@acme-fed.com' }],
    [{ dupe: false }, { dupe: false }],
  );
  eq('same apollo_id under two addresses is caught in-batch', byId[1].gate_reason, 'duplicate_in_batch');

  // A skipped lead must NOT claim its identifiers, or a suppressed first copy would mask the
  // reason for the second and it would read as a mere duplicate.
  const bothSupp = gateBatch([LEAD, { ...LEAD }], [{ suppressed: true }, { suppressed: true }]);
  eq('both copies of a suppressed lead report suppressed', bothSupp[1].gate_reason, 'suppressed');

  const between = gateBatch(
    [LEAD, { email: 'unrelated@other.com' }, { ...LEAD }],
    [{ dupe: false }, { dupe: false }, { dupe: false }],
  );
  eq('an unrelated lead between two copies is unaffected', between[1].gate_action, 'verify');
  eq('and the third is still caught', between[2].gate_reason, 'duplicate_in_batch');
}


console.log('\n== Reoon classify mapping (unchanged — do not "improve") ==');
{
  const g = gate(LEAD);
  const cases = [
    ['safe', 'pass'], ['valid', 'pass'], ['SAFE', 'pass'],
    ['invalid', 'drop'], ['spamtrap', 'drop'],
    ['disposable', 'needs_review'], ['catch_all', 'needs_review'],
    ['unknown', 'needs_review'], ['role', 'needs_review'], ['weird_new_status', 'needs_review'],
  ];
  for (const [status, want] of cases) {
    const c = classify({ email: 'jane.doe@acme-fed.com', status, overall_score: 88 }, g);
    eq(`${status} -> ${want}`, c.action, want);
  }
  const disp = classify({ email: 'jane.doe@acme-fed.com', status: 'disposable' }, g);
  ok('disposable is explicitly NOT a drop', disp.action !== 'drop', disp.action);
  ok('disposable reason names the false-negative', disp.reason.includes('greylisted'), disp.reason);

  const c = classify({ email: 'jane.doe@acme-fed.com', status: 'safe', overall_score: 95 }, g);
  eq('lead is recovered by email, not index', c.lead_id, g.lead_id);
  eq('company survives to the classifier', c.company, 'Acme Federal');

  const missing = classify({ status: 'safe' }, g);
  ok('a response with no echoed email still resolves the lead via the true branch',
    missing.lead_id === g.lead_id, JSON.stringify(missing.lead_id));
}

console.log('\n== the row a shaper builds is the row the SQL binds ==');
{
  // The Sheets nodes carried a cached column list, and the test compared key order against it.
  // A Postgres node carries the QUERY, and the query's parameter expression names every field it
  // takes off the item. That is a stronger contract than a cached list, because the cached list
  // could go stale against the sheet — this one is read out of the thing that executes.
  //
  // A field the binding reads but the shaper does not emit arrives as `undefined`, which JSON
  // serialises away, which lands in the database as NULL. On `product` that is a failed insert;
  // on `verify_action` it is a lead written with no verdict.
  // Rather than pattern-matching field names out of the expression — which cannot tell a required
  // field from the second half of an `a || b` fallback — this EVALUATES the real binding against
  // the real shaped row. What comes back is exactly the json Postgres will receive.
  const bind = (node, row) => {
    const expr = WF.nodes.find((x) => x.name === node).parameters.options.queryReplacement;
    const body = expr.replace(/^=\{\{/, '').replace(/\}\}$/, '');
    // eslint-disable-next-line no-new-func
    return JSON.parse(new Function('$json', `return (${body});`)(row));
  };
  const g = gate(LEAD);
  const c = classify({ email: 'jane.doe@acme-fed.com', status: 'safe', overall_score: 95 }, g);

  const leadRow = runNode('Shape Lead Row', { input: [c] })[0];
  const eventRow = runNode('Shape Reoon Event', { input: [c] })[0];

  for (const [label, row, node] of [['Leads', leadRow, 'Write Lead Row (Leads)'],
                                    ['Events', eventRow, 'Log Reoon Call (Events)']]) {
    const sent = bind(node, row);
    const blank = Object.entries(sent).filter(([, v]) => v === undefined || v === null);
    ok(`the ${label} binding produces a value for every parameter it declares`,
       blank.length === 0, `null: ${JSON.stringify(blank.map(([k]) => k))}`);
    // And the SQL must not read a key the binding never sends: p.j->>'x' on a missing key is NULL,
    // which on a NOT NULL column is a failed insert and on a nullable one is silent data loss.
    const q = WF.nodes.find((x) => x.name === node).parameters.query;
    const read = [...new Set([...q.matchAll(/j->>'([a-z_]+)'/g)].map((m) => m[1]))];
    const unsent = read.filter((f) => !(f in sent));
    ok(`  and the ${label} query reads nothing the binding does not send`,
       unsent.length === 0, `unsent: ${JSON.stringify(unsent)}`);
  }
  // The two enum columns are the ones that fail the INSERT outright rather than writing a blank,
  // so they get their own assertion rather than relying on the sweep above.
  for (const f of ['channel_state_email', 'verify_action'])
    ok(`  ${f} is always present and non-empty`, Boolean(leadRow[f]), String(leadRow[f]));

  eq('call_state starts at not_eligible', leadRow.call_state, 'not_eligible');
  ok('call_state is the 4-value enum, not a boolean', typeof leadRow.call_state === 'string');
  eq('a PASSING lead starts not_sent — the state the runner treats as ready',
     leadRow.channel_state_email, 'not_sent');

  // THE STATE MUST FOLLOW THE VERDICT. This was hardcoded 'not_sent', which was harmless only
  // while nothing read it. Since 2026-08-29 'not_sent' is exactly what VIO-demo-sheet-run treats
  // as READY, so an address Reoon had just rejected was written into Leads marked ready to send.
  // Caught on the first real end-to-end run, by a deliberately invalid test address.
  {
    const rowFor = (reoon) => runNode('Shape Lead Row', {
      input: [classify({ email: 'jane.doe@acme-fed.com', ...reoon }, gate(LEAD))] })[0];
    const dropped = rowFor({ status: 'invalid', overall_score: 0 });
    eq('an address verification REJECTED is never marked ready',
       dropped.channel_state_email, 'dropped');
    eq('  and the row records why', dropped.verify_action, 'drop');
    const unsure = rowFor({ status: 'catch_all', overall_score: 50, is_catch_all: true });
    ok('an inconclusive address is not marked ready either',
       unsure.channel_state_email !== 'not_sent', unsure.channel_state_email);
    // THE SEAM. What this node writes has to line up with what the sender is willing to act on, or
    // leads pile up in the table looking correct and never move — which is exactly what happened on
    // 2026-08-29 and again on 2026-09-05. The two sides are now JavaScript and SQL, so the ready
    // set is parsed out of the migration that defines the view and imported by both suites.
    ok('a PASSING lead is written in a state the sender will act on',
       READY_STATES.includes(leadRow.channel_state_email), leadRow.channel_state_email);
    for (const [label, reoon] of [['a rejected address', { status: 'invalid', overall_score: 0 }],
                                  ['an inconclusive address', { status: 'catch_all', is_catch_all: true }]]) {
      const st = runNode('Shape Lead Row', {
        input: [classify({ email: 'jane.doe@acme-fed.com', ...reoon }, gate(LEAD))] })[0].channel_state_email;
      ok(`${label} is written in a state the sender will NOT act on`,
         !READY_STATES.includes(st), st);
    }
  }

  // Product must survive Normalize Lead. That node builds an explicit object, so anything not
  // named there is dropped — which is how the product a human chose in the Inbox reached intake
  // and vanished before the Leads row was written. Found live 2026-08-29.
  {
    const norm = runNode('Normalize Lead', { input: [{ ...LEAD, Product: 'VisioneerIT' }] })[0];
    eq('Product survives normalisation', norm.Product, 'VisioneerIT');
    const row = runNode('Shape Lead Row', {
      input: [classify({ email: 'jane.doe@acme-fed.com', status: 'safe', overall_score: 95 },
                       gate({ ...LEAD, Product: 'VisioneerIT' }))] })[0];
    eq('  and reaches the Leads row', row.Product, 'VisioneerIT');
    ok('  under the capital-P name the live sheet uses', 'Product' in row);
  }
  eq('verify_action carries the decision', leadRow.verify_action, 'pass');
  eq('contact_email is the normalised address', leadRow.contact_email, 'jane.doe@acme-fed.com');
  eq('lead_id on the row matches the gate', leadRow.lead_id, g.lead_id);

  eq('event tool', eventRow.tool, 'reoon');
  // The shaper still says 'verify'; the SQL writes the Supabase vocabulary word 'verified'.
  // The SQL is authoritative — actor and action are hardcoded there precisely so a shaper cannot
  // invent an action the dashboard does not know how to render.
  eq('event action (shaper)', eventRow.action, 'verify');
  ok('the query writes the events vocabulary word',
     /'verified'/.test(WF.nodes.find((x) => x.name === 'Log Reoon Call (Events)').parameters.query));
  eq('event units', eventRow.units, 1);
  eq('event workflow', eventRow.workflow, 'VIO-intake-verify-curate');
  eq('event result carries the decision + status', eventRow.result, 'pass (safe, score 95)');
  eq('est_cost_usd left blank — COSTS.md has Reoon $/credit as UNKNOWN', eventRow.est_cost_usd, '');
  eq('event lead_id matches', eventRow.lead_id, g.lead_id);
}

console.log('\n== workflow-level invariants ==');
{
  // Active since 2026-08-29 — VIO-inbox-mapper calls it live in batch mode. Confirmed
  // against the real database on 2026-09-05 (only VIO-costs-rollup is off).
  eq('is active', WF.active, true);
  eq('keeps its id', WF.id, 'VIOwf1intake0001');
  const types = WF.nodes.map((n) => n.type);
  ok('trigger is still the manual trigger', types.includes('n8n-nodes-base.manualTrigger'));
  ok('no webhook trigger was added', !types.some((t) => t.includes('webhook')));
  ok('no schedule trigger was added', !types.some((t) => t.includes('scheduleTrigger')));

  const creds = WF.nodes.filter((n) => n.credentials).flatMap((n) => Object.values(n.credentials));
  ok('every credential is pinned by id AND name', creds.every((c) => c.id && c.name), JSON.stringify(creds));
  ok('no IndustrialBriefs credential is referenced',
    !creds.some((c) => ['mPUq9mR58Mxpd1rA', 'dpzUGSCyYoUPCAvv', 'ePhhBsC5X1uQehIJ'].includes(c.id)),
    JSON.stringify(creds));

  const raw = readFileSync(join(HERE, 'VIO-intake-verify-curate.json'), 'utf8');
  ok('no secret material in the JSON',
    !/BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20}|"privateKey"/.test(raw));

  // Nothing in this workflow may contact a prospect.
  const outbound = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest')
    .map((n) => n.parameters.url);
  ok('the only outbound call is Reoon verification',
    outbound.length === 1 && outbound[0].startsWith('https://emailverifier.reoon.com/'),
    JSON.stringify(outbound));
  ok('no sender/dialer node exists here',
    !types.some((t) => /slack|emailSend|gmail|twilio/i.test(t)), JSON.stringify(types));

  // The Sheets invariants that used to live here would now pass over an empty list and prove
  // nothing, so they are replaced rather than kept as decoration.
  ok('Google Sheets is gone from this workflow',
    WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets').length === 0);

  const pgNodes = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');
  ok('the record is Postgres, and there are three touches of it', pgNodes.length === 3,
    String(pgNodes.length));

  // SQL INJECTION. These queries decide whether a real person is mailed, and one of the values
  // crossing into them is a company name a stranger typed into a spreadsheet. Every value must
  // arrive as a bound parameter; a query that interpolates {{ }} into its own text has none of
  // that protection, and the failure is silent until it isn't.
  for (const n of pgNodes) {
    ok(`  ${n.name}: no expression interpolated into the SQL text`,
      !/\{\{/.test(n.parameters.query), n.parameters.query.slice(0, 80));
    ok(`  ${n.name}: values arrive as one bound jsonb parameter`,
      /\$1::jsonb/.test(n.parameters.query) &&
      typeof n.parameters.options.queryReplacement === 'string');
  }

  // A write that fails once must not lose the lead — Supabase's pooler drops idle connections.
  for (const n of pgNodes)
    ok(`  ${n.name}: retries rather than dropping the lead`, n.retryOnFail === true);

  // Suppression is append-only and matching is the database's job now. This workflow must read
  // that list and never write to it.
  const sql = pgNodes.map((n) => n.parameters.query).join('\n');
  ok('the gate asks is_suppressed() rather than re-implementing it', /is_suppressed\(/.test(sql));
  ok('nothing here writes to the suppression table',
    !/insert\s+into\s+suppression|update\s+suppression|delete\s+from\s+suppression/i.test(sql));
  // Re-running intake over someone already enrolled must never reset them to not_sent.
  const leadSql = pgNodes.find((n) => n.name === 'Write Lead Row (Leads)').parameters.query;
  // Only the SET list, not the RETURNING clause — reading the state back is fine and useful;
  // assigning it is the thing that would re-send to someone already contacted.
  const setList = leadSql.slice(leadSql.indexOf('do update set'),
                                leadSql.lastIndexOf('returning'));
  ok('an upsert never rewrites the lifecycle column',
    !/channel_state_email\s*=/.test(setList), setList.slice(0, 140));
  ok('  but it does read it back, so the caller learns the state that stands',
    /returning[\s\S]*channel_state_email/.test(leadSql));
}

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'}: ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('failing:', fails.join(' | ')); process.exit(1); }
