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

// The Sheets read nodes emit one empty placeholder item when a tab holds only its header row
// (alwaysOutputData). Model that faithfully — mistaking it for a real row is the whole point.
const sheetRows = (rows) => (rows.length ? rows : [{}]);

function gate(lead, { leads = [], suppression = [] } = {}) {
  const normalized = runNode('Normalize Lead', { input: [lead] });
  return runNode('Gate (dedupe + suppression)', {
    nodes: {
      'Normalize Lead': normalized,
      'Read Leads (dedupe)': sheetRows(leads),
      'Read Suppression': sheetRows(suppression),
    },
  })[0];
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
  eq('empty tabs -> verify', g.gate_action, 'verify');
  eq('reason ok', g.gate_reason, 'ok');
  eq('empty Leads tab counted as zero rows', g.leads_rows_scanned, 0);
  eq('empty Suppression tab counted as zero rows', g.suppression_rows_scanned, 0);
}

console.log('\n== suppression: every identifier, not just email ==');
{
  const cases = [
    ['email', { identifier_type: 'email', identifier_value: 'JANE.DOE@acme-fed.com' }, 'email='],
    ['company domain', { identifier_type: 'domain', identifier_value: 'acme-fed.com' }, 'company_domain='],
    ['domain with scheme + www', { identifier_type: 'domain', identifier_value: 'https://www.acme-fed.com' }, 'company_domain='],
    ['email domain (suppressed under a different channel)', { identifier_type: 'domain', identifier_value: 'acme-fed.com' }, 'domain_from_email='],
    ['phone, differently formatted', { identifier_type: 'phone', identifier_value: '202-555-0143' }, 'phone='],
    ['phone with country code', { identifier_type: 'phone', identifier_value: '+12025550143' }, 'phone='],
    ['linkedin, no scheme, no trailing slash', { identifier_type: 'linkedin', identifier_value: 'linkedin.com/in/janedoe' }, 'linkedin='],
    ['linkedin with tracking query', { identifier_type: 'linkedin', identifier_value: 'https://linkedin.com/in/janedoe?originalSubdomain=us' }, 'linkedin='],
  ];
  for (const [label, row, marker] of cases) {
    const g = gate(LEAD, { suppression: [row] });
    ok(`suppressed by ${label}`,
      g.gate_action === 'skip' && g.gate_reason === 'suppressed' && g.gate_detail.includes(marker),
      `${g.gate_action}/${g.gate_reason}: ${g.gate_detail}`);
  }

  const untyped = gate(LEAD, { suppression: [{ identifier_type: '', identifier_value: 'jane.doe@acme-fed.com' }] });
  ok('a suppression row with a blank identifier_type still suppresses',
    untyped.gate_reason === 'suppressed', untyped.gate_detail);

  const garbageType = gate(LEAD, { suppression: [{ identifier_type: 'e-mail', identifier_value: 'jane.doe@acme-fed.com' }] });
  ok('a mistyped identifier_type still suppresses', garbageType.gate_reason === 'suppressed', garbageType.gate_detail);

  const blank = gate(LEAD, { suppression: [{ identifier_type: 'email', identifier_value: '' }] });
  eq('a blank identifier_value suppresses nothing', blank.gate_action, 'verify');

  const other = gate(LEAD, { suppression: [{ identifier_type: 'email', identifier_value: 'someone.else@acme-fed.com' }] });
  eq('an unrelated suppressed address does not block this lead', other.gate_action, 'verify');

  const noPhone = gate({ ...LEAD, phone: '', linkedin_url: '' },
    { suppression: [{ identifier_type: 'phone', identifier_value: '' }] });
  eq('a lead with no phone is not matched by an empty phone entry', noPhone.gate_action, 'verify');
}

console.log('\n== dedupe against the Leads tab ==');
{
  const existing = { lead_id: 'abc123', contact_email: 'jane.doe@acme-fed.com', company: 'Acme Federal' };
  const g = gate(LEAD, { leads: [existing] });
  ok('same email already on the tab -> skip', g.gate_action === 'skip' && g.gate_reason === 'duplicate', g.gate_detail);

  const byId = gate({ ...LEAD, apollo_id: 'abc123', email: 'j.doe@acme-fed.com' }, { leads: [existing] });
  ok('same lead_id under a different address -> skip', byId.gate_reason === 'duplicate', byId.gate_detail);

  const casing = gate(LEAD, { leads: [{ contact_email: '  JANE.DOE@ACME-FED.COM ' }] });
  eq('dedupe is case/whitespace insensitive', casing.gate_reason, 'duplicate');

  const otherLead = gate(LEAD, { leads: [{ lead_id: 'zzz', contact_email: 'bob@other.com' }] });
  eq('an unrelated existing row does not block', otherLead.gate_action, 'verify');

  const emptyCols = gate({ ...LEAD, apollo_id: '' }, { leads: [{ lead_id: '', contact_email: '' }] });
  eq('a blank existing row never matches', emptyCols.gate_action, 'verify');
}

console.log('\n== precedence and fail-closed ==');
{
  const both = gate(LEAD, {
    leads: [{ contact_email: 'jane.doe@acme-fed.com' }],
    suppression: [{ identifier_type: 'email', identifier_value: 'jane.doe@acme-fed.com' }],
  });
  eq('suppressed AND duplicate reports suppressed', both.gate_reason, 'suppressed');

  const noKey = gate({ first_name: 'Nobody', company: 'Ghost Co' });
  ok('no email and no apollo_id -> skip, never verify',
    noKey.gate_action === 'skip' && noKey.gate_reason === 'no_identifier', noKey.gate_detail);
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

console.log('\n== Sheets row shapes (autoMapInputData matches on header text) ==');
{
  const schema = (node, tab) => {
    const n = WF.nodes.find((x) => x.name === node);
    return n.parameters.columns.schema.map((s) => s.id);
  };
  const g = gate(LEAD);
  const c = classify({ email: 'jane.doe@acme-fed.com', status: 'safe', overall_score: 95 }, g);

  const leadRow = runNode('Shape Lead Row', { input: [c] })[0];
  const eventRow = runNode('Shape Reoon Event', { input: [c] })[0];

  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  ok('Leads row keys match the Leads columns exactly, in order',
    same(Object.keys(leadRow), schema('Write Lead Row (Leads)')),
    JSON.stringify(Object.keys(leadRow)));
  ok('Events row keys match the Events columns exactly, in order',
    same(Object.keys(eventRow), schema('Log Reoon Call (Events)')),
    JSON.stringify(Object.keys(eventRow)));

  eq('call_state starts at not_eligible', leadRow.call_state, 'not_eligible');
  ok('call_state is the 4-value enum, not a boolean', typeof leadRow.call_state === 'string');
  eq('channel_state_email starts not_sent', leadRow.channel_state_email, 'not_sent');
  eq('verify_action carries the decision', leadRow.verify_action, 'pass');
  eq('contact_email is the normalised address', leadRow.contact_email, 'jane.doe@acme-fed.com');
  eq('lead_id on the row matches the gate', leadRow.lead_id, g.lead_id);

  eq('event tool', eventRow.tool, 'reoon');
  eq('event action', eventRow.action, 'verify');
  eq('event units', eventRow.units, 1);
  eq('event workflow', eventRow.workflow, 'VIO-intake-verify-curate');
  eq('event result carries the decision + status', eventRow.result, 'pass (safe, score 95)');
  eq('est_cost_usd left blank — COSTS.md has Reoon $/credit as UNKNOWN', eventRow.est_cost_usd, '');
  eq('event lead_id matches', eventRow.lead_id, g.lead_id);
}

console.log('\n== workflow-level invariants ==');
{
  eq('stays deactivated', WF.active, false);
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

  const sheetsNodes = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  ok('Sheets nodes authenticate as a service account',
    sheetsNodes.every((n) => n.parameters.authentication === 'serviceAccount'));
  ok('appends ignore extra fields instead of adding columns to the Sheet',
    sheetsNodes.filter((n) => n.parameters.operation === 'append')
      .every((n) => n.parameters.options.handlingExtraData === 'ignoreIt'));
  ok('reads run once and never stall an empty tab',
    sheetsNodes.filter((n) => !n.parameters.operation)
      .every((n) => n.executeOnce === true && n.alwaysOutputData === true));
  ok('nothing writes to the Suppression tab',
    !sheetsNodes.some((n) => n.parameters.sheetName.value === 'Suppression' && n.parameters.operation));
}

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'}: ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('failing:', fails.join(' | ')); process.exit(1); }
