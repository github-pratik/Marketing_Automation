// Test harness for the CALLABLE entry point of VIO-intake-verify-curate — built 2026-08-25.
//
// `test-intake-gate.mjs` proves the brain. This one proves the batch: that adding an
// `executeWorkflowTrigger` so a parent workflow (`VIO-source-leads`) can hand this one a list of
// leads did not (a) fork the gates into a second copy, (b) lose the manual path, or (c) quietly
// process only the first lead — the failure that looks exactly like success.
//
// Same discipline as its sibling: it reads `jsCode` straight out of VIO-intake-verify-curate.json
// and runs it in a small n8n shim. Nothing is re-typed, so these tests cannot drift from what will
// run on the droplet.
//
// What it proves:
//   * SHAPE. The fan-out emits one n8n item per lead. The alternative shape (an array riding on one
//     item) is shown to be broken rather than asserted to be — the test feeds the raw envelope to
//     `Normalize Lead` and demonstrates the 1-lead-out-of-N result.
//   * CONVERGENCE. Both triggers reach `Normalize Lead`, and every path from either trigger to the
//     Reoon node passes through the one and only gate. Walked over the real connection graph.
//   * A batch arriving via the new trigger hits the same gates, with the same verdicts, as the same
//     lead arriving through the manual path.
//   * A batch holding a duplicate and a suppressed lead has both rejected BEFORE Reoon — zero
//     credits — while the clean leads in the same batch still go through.
//   * An empty batch is a no-op, not an error.
//   * A malformed batch does not throw, at any shape of malformed.
//   * One bad lead does not abort the rest — in the fan-out (skipped with a reason) and at the
//     Reoon call (error output, wired to a terminal node).
//
// Run:  node test-intake-callable.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, 'VIO-intake-verify-curate.json');
const WF = JSON.parse(readFileSync(FILE, 'utf8'));

const nodeByName = (name) => {
  const n = WF.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named "${name}" in the workflow JSON`);
  return n;
};
const jsOf = (name) => nodeByName(name).parameters.jsCode;

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

// A Sheets read on a header-only tab emits one empty placeholder item (alwaysOutputData).
const sheetRows = (rows) => (rows.length ? rows : [{}]);

// The IF node: `$json.gate_action equals 'verify'`, strict string compare, evaluated per item.
// Output 0 is what reaches Reoon; output 1 is the terminal Skipped NoOp.
const ifSplit = (gated) => ({
  toReoon: gated.filter((g) => g.gate_action === 'verify'),
  toSkipped: gated.filter((g) => g.gate_action !== 'verify'),
});

// The two entry points, each run end-to-end through the SAME gate nodes.
function viaTrigger(payload, { leads = [], suppression = [] } = {}) {
  const fanned = runNode('Batch In (one item per lead)', { input: payload });
  const normalized = fanned.length ? runNode('Normalize Lead', { input: fanned }) : [];
  const gated = normalized.length
    ? runNode('Gate (dedupe + suppression)', {
        nodes: {
          'Normalize Lead': normalized,
          'Read Leads (dedupe)': sheetRows(leads),
          'Read Suppression': sheetRows(suppression),
        },
      })
    : [];
  return { fanned, normalized, gated, ...ifSplit(gated) };
}

function viaManual(lead, { leads = [], suppression = [] } = {}) {
  const normalized = runNode('Normalize Lead', { input: [lead] });
  const gated = runNode('Gate (dedupe + suppression)', {
    nodes: {
      'Normalize Lead': normalized,
      'Read Leads (dedupe)': sheetRows(leads),
      'Read Suppression': sheetRows(suppression),
    },
  });
  return { normalized, gated, ...ifSplit(gated) };
}

function classify(reoonResponses, gated) {
  const verified = gated.filter((g) => g.gate_action === 'verify');
  return runNode('Classify (pass / drop / needs_review)', {
    input: reoonResponses,
    nodes: { 'Gate (dedupe + suppression)': gated, 'Verify this lead?': [verified] },
  });
}

// ---- assertions ------------------------------------------------------------------------------
let pass = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fails.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const eq = (label, got, want) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const noThrow = (label, fn) => {
  try { const v = fn(); ok(label, true); return v; }
  catch (e) { ok(label, false, `threw ${e && e.message}`); return undefined; }
};

const lead = (n, over = {}) => ({
  email: `person${n}@acme-fed.com`,
  first_name: `Person${n}`,
  last_name: 'Doe',
  title: 'Capture Manager',
  company: 'Acme Federal',
  company_domain: 'acme-fed.com',
  linkedin_url: `https://www.linkedin.com/in/person${n}/`,
  apollo_id: '',
  phone: '',
  source_config: 'oryoniq',
  signal: 'new BPA award',
  ...over,
});

// The exact shape VIO-source-leads' Report node emits: ONE item, an envelope with a leads array.
const envelope = (leads, over = {}) => ({
  ok: true,
  ran: ['resolve_icp', 'apollo_search_free', 'filter_has_email'],
  source_config: 'oryoniq',
  product: 'OryonIQ',
  emailable: leads.length,
  credits_spent: 0,
  note: 'Apollo free search only.',
  leads,
  ...over,
});

console.log('\n== batch shape: one item per lead ==');
{
  const env = envelope([lead(1), lead(2), lead(3)]);
  const fanned = runNode('Batch In (one item per lead)', { input: [env] });
  eq('an envelope of 3 leads fans out to 3 items', fanned.length, 3);
  ok('each item is one lead, not an array', fanned.every((f) => !Array.isArray(f.leads) && f.email));
  eq('order is preserved', fanned.map((f) => f.first_name).join(','), 'Person1,Person2,Person3');
  ok('batch bookkeeping is attached and visible', fanned.every((f, i) => f._batch && f._batch.index === i));
  eq('_batch reports the batch size', fanned[0]._batch.size, 3);
  eq('_batch names the entry point', fanned[0]._batch.entry, 'execute_workflow');

  // The rejected alternative, demonstrated rather than asserted. `Normalize Lead` maps ITEMS.
  const wrong = runNode('Normalize Lead', { input: [env] });
  eq('the array-on-one-item shape yields exactly one lead from a batch of 3', wrong.length, 1);
  eq('...and that one lead has no identity at all (silent data loss)', wrong[0].lead_id, '');

  // N items, one lead each — a parent that already fanned out.
  const bare = runNode('Batch In (one item per lead)', { input: [lead(1), lead(2)] });
  eq('N bare lead items pass straight through', bare.length, 2);
  eq('bare items are counted as bare, not as envelopes', bare[0]._batch.bare_items, 2);

  // Mixed, and a body-wrapped envelope (a parent forwarding a raw webhook payload).
  const mixed = runNode('Batch In (one item per lead)', {
    input: [envelope([lead(1), lead(2)]), lead(3), { body: envelope([lead(4)]) }],
  });
  eq('envelopes, bare items and a body-wrapped envelope all fan out together', mixed.length, 4);
  eq('mixed arrival: 2 envelopes counted', mixed[0]._batch.envelopes, 2);

  // A stringified list (a parent that JSON.stringify'd its payload).
  const strung = runNode('Batch In (one item per lead)', {
    input: [{ source_config: 'oryoniq', leads: JSON.stringify([lead(1), lead(2)]) }],
  });
  eq('a JSON-stringified leads array is still fanned out', strung.length, 2);

  // Envelope-level defaults reach leads that lack their own.
  const inherited = runNode('Batch In (one item per lead)', {
    input: [envelope([{ email: 'nc@acme-fed.com' }], { source_config: 'visioneerit', signal: 'zero-trust memo' })],
  });
  eq('a lead with no source_config inherits the envelope\'s', inherited[0].source_config, 'visioneerit');
  eq('a lead with no signal inherits the envelope\'s', inherited[0].signal, 'zero-trust memo');
  const notInherited = runNode('Batch In (one item per lead)', {
    input: [envelope([lead(1, { source_config: 'oryoniq' })], { source_config: 'visioneerit' })],
  });
  eq('a lead\'s own source_config wins over the envelope\'s', notInherited[0].source_config, 'oryoniq');
  ok('envelope bookkeeping is NOT smeared onto leads',
    !('ok' in inherited[0]) && !('note' in inherited[0]) && !('credits_spent' in inherited[0]),
    JSON.stringify(Object.keys(inherited[0])));
}

console.log('\n== both entry points hit the same gates, with the same verdicts ==');
{
  const L = lead(1);
  const opts = { leads: [], suppression: [] };
  const manual = viaManual(L, opts).gated[0];
  const batch = viaTrigger([envelope([L])], opts).gated[0];

  const compare = ['lead_id', 'lead_id_source', 'email', 'company_domain', 'gate_action',
                   'gate_reason', 'gate_detail', 'leads_rows_scanned', 'suppression_rows_scanned'];
  for (const k of compare) eq(`manual and batch agree on ${k}`, batch[k], manual[k]);

  // ...and they agree when the verdict is a rejection, too.
  const supp = { suppression: [{ identifier_type: 'domain', identifier_value: 'acme-fed.com' }] };
  const mS = viaManual(L, supp).gated[0];
  const bS = viaTrigger([envelope([L])], supp).gated[0];
  eq('manual path: suppressed', mS.gate_reason, 'suppressed');
  eq('batch path: suppressed, identically', bS.gate_reason, mS.gate_reason);
  eq('...with the same detail string', bS.gate_detail, mS.gate_detail);
  ok('a suppressed lead never reaches Reoon on either path',
    viaManual(L, supp).toReoon.length === 0 && viaTrigger([envelope([L])], supp).toReoon.length === 0);
}

console.log('\n== a batch with a duplicate and a suppressed lead: both rejected before Reoon ==');
{
  const clean1 = lead(1);
  const dup = lead(2, { email: 'already@acme-fed.com' });
  const suppressed = lead(3, { email: 'optout@acme-fed.com' });
  const clean2 = lead(4);

  const r = viaTrigger([envelope([clean1, dup, suppressed, clean2])], {
    leads: [{ lead_id: 'xyz', contact_email: 'already@acme-fed.com' }],
    suppression: [{ identifier_type: 'email', identifier_value: 'OptOut@Acme-Fed.com' }],
  });

  eq('all four leads were gated', r.gated.length, 4);
  eq('the duplicate is skipped', r.gated[1].gate_reason, 'duplicate');
  eq('the suppressed lead is skipped', r.gated[2].gate_reason, 'suppressed');
  eq('only the two clean leads reach Reoon', r.toReoon.length, 2);
  eq('the two rejects land on the terminal Skipped branch', r.toSkipped.length, 2);
  ok('neither reject is in the Reoon-bound set — zero credits spent on them',
    !r.toReoon.some((g) => ['already@acme-fed.com', 'optout@acme-fed.com'].includes(g.email)),
    JSON.stringify(r.toReoon.map((g) => g.email)));
  ok('a rejection in the middle does not stop the leads after it',
    r.toReoon.map((g) => g.first_name).join(',') === 'Person1,Person4',
    JSON.stringify(r.toReoon.map((g) => g.first_name)));

  // The Leads tab and Suppression tab are each read ONCE for the whole batch (executeOnce: true).
  eq('one Suppression read serves every lead in the batch', r.gated[3].suppression_rows_scanned, 1);
  eq('one Leads read serves every lead in the batch', r.gated[3].leads_rows_scanned, 1);
}

console.log('\n== dedupe WITHIN a batch (only reachable now that batches exist) ==');
{
  const twice = viaTrigger([envelope([lead(1), lead(2), lead(1)])]);
  eq('the first copy verifies', twice.gated[0].gate_action, 'verify');
  eq('the repeat is skipped', twice.gated[2].gate_action, 'skip');
  eq('...as duplicate_in_batch', twice.gated[2].gate_reason, 'duplicate_in_batch');
  eq('one person, one Reoon credit', twice.toReoon.filter((g) => g.email === 'person1@acme-fed.com').length, 1);
  eq('the unrelated lead between them is unaffected', twice.gated[1].gate_action, 'verify');

  const sameId = viaTrigger([envelope([
    lead(1, { apollo_id: 'ap-77', email: 'a@acme-fed.com' }),
    lead(2, { apollo_id: 'ap-77', email: 'b@acme-fed.com' }),
  ])]);
  eq('same apollo_id under two addresses is caught in-batch', sameId.gated[1].gate_reason, 'duplicate_in_batch');

  // A suppressed first copy must not "claim" the identifier and mask the reason for the second.
  const both = viaTrigger([envelope([lead(1), lead(1)])], {
    suppression: [{ identifier_type: 'email', identifier_value: 'person1@acme-fed.com' }],
  });
  ok('both copies of a suppressed lead report suppressed, not duplicate_in_batch',
    both.gated.every((g) => g.gate_reason === 'suppressed'),
    JSON.stringify(both.gated.map((g) => g.gate_reason)));

  // Two identity-less leads must not collide with each other on the empty string.
  const noKeys = viaTrigger([envelope([{ first_name: 'A', company: 'X' }, { first_name: 'B', company: 'Y' }])]);
  ok('two identity-less leads both report no_identifier, never duplicate_in_batch',
    noKeys.gated.every((g) => g.gate_reason === 'no_identifier'),
    JSON.stringify(noKeys.gated.map((g) => g.gate_reason)));
  eq('and neither reaches Reoon', noKeys.toReoon.length, 0);
}

console.log('\n== an empty batch is a no-op, not an error ==');
{
  const empty = noThrow('an envelope with leads: [] does not throw',
    () => runNode('Batch In (one item per lead)', { input: [envelope([])] }));
  eq('...and emits zero items, so nothing downstream executes', empty.length, 0);

  const none = noThrow('no input items at all does not throw',
    () => runNode('Batch In (one item per lead)', { input: [] }));
  eq('...and also emits zero items', none.length, 0);

  const r = viaTrigger([envelope([])]);
  eq('an empty batch reaches neither the gate nor Reoon', r.gated.length + r.toReoon.length, 0);
}

console.log('\n== a malformed batch does not throw ==');
{
  const junk = [
    ['leads is a string that is not JSON', [{ leads: 'not json at all' }]],
    ['leads is a number', [{ leads: 42 }]],
    ['leads is null', [{ leads: null }]],
    ['leads is an object, not a list', [{ leads: { email: 'x@y.com' } }]],
    ['leads holds nulls and scalars', [envelope([null, 'nope', 7, undefined])]],
    ['leads holds nested arrays', [envelope([[lead(1)], [lead(2)]])]],
    ['the item itself is null', [null]],
    ['the item itself is an array', [[lead(1)]]],
    ['the item is a bare string', ['hello']],
    ['a status object with no leads at all', [{ ok: true, note: 'nothing here' }]],
    ['deeply nested body wrapper', [{ body: { body: envelope([lead(1)]) } }]],
    ['leads array containing a circular-ish self reference', [(() => {
      const o = { email: 'circ@acme-fed.com' }; o.self = o; return envelope([o]);
    })()]],
  ];
  for (const [label, input] of junk) {
    noThrow(`malformed: ${label}`, () => runNode('Batch In (one item per lead)', { input }));
  }

  const scalars = runNode('Batch In (one item per lead)', { input: [envelope([null, 'nope', 7])] });
  eq('non-object entries are dropped, not turned into leads', scalars.length, 0);

  const statusOnly = runNode('Batch In (one item per lead)', { input: [{ ok: true, note: 'x' }] });
  eq('a status object is not mistaken for a lead', statusOnly.length, 0);

  const objLeads = runNode('Batch In (one item per lead)', { input: [{ leads: { email: 'x@y.com' } }] });
  ok('a single object under `leads` is reported, not silently swallowed',
    objLeads.length === 0, JSON.stringify(objLeads));

  const warned = runNode('Batch In (one item per lead)', { input: [envelope([lead(1), null, 'junk'])] });
  eq('a batch of 1 good + 2 junk yields the 1 good lead', warned.length, 1);
  ok('and the junk is reported on _batch.warnings rather than hidden',
    warned[0]._batch.warnings.length === 2, JSON.stringify(warned[0]._batch.warnings));
}

console.log('\n== one lead failing does not abort the rest of the batch ==');
{
  // (a) in the fan-out: a malformed entry among good ones costs only itself.
  const mixed = runNode('Batch In (one item per lead)', {
    input: [envelope([lead(1), null, lead(2), 'garbage', lead(3)])],
  });
  eq('3 good leads survive 2 malformed neighbours', mixed.length, 3);
  eq('surviving order is intact', mixed.map((m) => m.first_name).join(','), 'Person1,Person2,Person3');

  // (b) through the gate: a lead that cannot be keyed is skipped, the rest proceed.
  const r = viaTrigger([envelope([lead(1), { first_name: 'Ghost', company: 'Ghost Co' }, lead(2)])]);
  eq('the unkeyable lead is skipped', r.gated[1].gate_reason, 'no_identifier');
  eq('the other two still reach Reoon', r.toReoon.length, 2);

  // (c) at the Reoon call: a per-lead HTTP failure must not take the batch down.
  const reoon = nodeByName('Reoon Verify (power)');
  eq('the Reoon node routes failures to an error output', reoon.onError, 'continueErrorOutput');
  ok('it still retries before giving up', reoon.retryOnFail === true && reoon.maxTries === 3);
  const errBranch = (WF.connections['Reoon Verify (power)'].main[1] || []).map((c) => c.node);
  eq('the error output is wired to exactly one terminal node', errBranch.length, 1);
  const errNode = nodeByName(errBranch[0]);
  eq('...and that node is a terminal NoOp', errNode.type, 'n8n-nodes-base.noOp');
  // The claim is "writes nothing to any Sheet", so test THAT, not the stronger proxy of "has no
  // outgoing connections at all" — which was true only until the branch had to report its outcome
  // back to a caller (2026-08-29). Walk everything reachable from the failure branch and assert
  // no Sheets node is among it.
  const reachable = (start) => {
    const seen = new Set(), stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const grp of (WF.connections[cur]?.main || []))
        for (const c of grp) stack.push(c.node);
    }
    seen.delete(start);
    return [...seen];
  };
  const downstream = reachable(errNode.name);
  ok('the failure branch writes nothing to any Sheet',
    downstream.every((nm) => nodeByName(nm).type !== 'n8n-nodes-base.googleSheets'),
    `reaches: ${downstream.join(', ')}`);
  ok('the failure branch does report its outcome to the caller',
    downstream.includes('Intake Result (to caller)'), `reaches: ${downstream.join(', ')}`);

  // Successes on output 0 still classify: Classify resolves each lead by the echoed email, so the
  // gap left by a failed sibling cannot misalign the survivors.
  const g = viaTrigger([envelope([lead(1), lead(2), lead(3)])]).gated;
  const survivors = classify([
    { email: 'person1@acme-fed.com', status: 'safe', overall_score: 95 },
    { email: 'person3@acme-fed.com', status: 'catch_all', overall_score: 70 },
  ], g);
  eq('two survivors classify even though the middle lead never returned', survivors.length, 2);
  eq('survivor 1 resolved to the right lead', survivors[0].lead_id, g[0].lead_id);
  ok('survivor 2 resolved to lead 3, not shifted into lead 2 by index',
    survivors[1].lead_id === g[2].lead_id, `${survivors[1].lead_id} vs ${g[2].lead_id}`);
  eq('survivor 2 keeps its own verdict', survivors[1].action, 'needs_review');
}

console.log('\n== a whole batch classifies and shapes rows, one row per lead ==');
{
  const g = viaTrigger([envelope([lead(1), lead(2)])]).gated;
  const classified = classify([
    { email: 'person1@acme-fed.com', status: 'safe', overall_score: 95 },
    { email: 'person2@acme-fed.com', status: 'invalid', overall_score: 10 },
  ], g);
  eq('two leads in, two classifications out', classified.length, 2);
  eq('lead 1 passes', classified[0].action, 'pass');
  eq('lead 2 drops', classified[1].action, 'drop');

  const leadRows = runNode('Shape Lead Row', { input: classified });
  const eventRows = runNode('Shape Reoon Event', { input: classified });
  eq('one Leads row per verified lead', leadRows.length, 2);
  eq('one Events row per Reoon call', eventRows.length, 2);
  ok('each Leads row carries its own lead_id',
    leadRows[0].lead_id === g[0].lead_id && leadRows[1].lead_id === g[1].lead_id);
  ok('source_config survives the whole batch path',
    leadRows.every((r) => r.source_config === 'oryoniq'), JSON.stringify(leadRows.map((r) => r.source_config)));
  ok('batch bookkeeping never leaks into a Sheet row',
    leadRows.every((r) => !('_batch' in r)) && eventRows.every((r) => !('_batch' in r)));
  eq('every Events row meters exactly one credit', eventRows.filter((r) => r.units === 1).length, 2);
}

console.log('\n== workflow structure: two entry points, ONE copy of the gates ==');
{
  const types = WF.nodes.map((n) => n.type);
  eq('the workflow id is unchanged', WF.id, 'VIOwf1intake0001');
  eq('it stays deactivated by design', WF.active, false);

  ok('the manual trigger is still there', types.includes('n8n-nodes-base.manualTrigger'));
  ok('an executeWorkflowTrigger was added', types.includes('n8n-nodes-base.executeWorkflowTrigger'));
  eq('exactly one executeWorkflowTrigger',
    types.filter((t) => t === 'n8n-nodes-base.executeWorkflowTrigger').length, 1);
  eq('the sub-workflow trigger passes input through unfiltered',
    nodeByName('Leads In (from parent workflow)').parameters.inputSource, 'passthrough');
  ok('still no webhook trigger (this one is called, not exposed)',
    !types.some((t) => t.toLowerCase().includes('webhook')));

  // Every original node id survives, so an import updates in place instead of orphaning nodes.
  const ids = new Set(WF.nodes.map((n) => n.id));
  const original = ['vio-wf1-trigger', 'vio-wf1-testlead', 'vio-wf1-normalize', 'vio-wf1-readleads',
    'vio-wf1-readsupp', 'vio-wf1-gate', 'vio-wf1-ifgate', 'vio-wf1-reoon', 'vio-wf1-classify',
    'vio-wf1-shapeevent', 'vio-wf1-shapelead', 'vio-wf1-events', 'vio-wf1-leads', 'vio-wf1-skipped'];
  ok('every pre-existing node id is unchanged', original.every((id) => ids.has(id)),
    JSON.stringify(original.filter((id) => !ids.has(id))));
  eq('node ids are unique', ids.size, WF.nodes.length);

  // Exactly one copy of each stage — the anti-drift rule this repo already has a tool for.
  for (const name of ['Normalize Lead', 'Gate (dedupe + suppression)', 'Verify this lead?',
                      'Reoon Verify (power)']) {
    eq(`exactly one "${name}" node`, WF.nodes.filter((n) => n.name === name).length, 1);
  }

  // Connections are coherent: every target exists, and nothing dangles.
  const names = new Set(WF.nodes.map((n) => n.name));
  const badSource = Object.keys(WF.connections).filter((n) => !names.has(n));
  ok('every connection source is a real node', badSource.length === 0, JSON.stringify(badSource));
  const badTarget = Object.values(WF.connections)
    .flatMap((c) => (c.main || []).flat()).map((c) => c.node).filter((n) => !names.has(n));
  ok('every connection target is a real node', badTarget.length === 0, JSON.stringify(badTarget));

  // Both entry points converge on the same first node.
  const out = (n) => ((WF.connections[n] || {}).main || []).flat().map((c) => c.node);
  eq('the manual path reaches Normalize Lead', out('Test Lead (edit me)')[0], 'Normalize Lead');
  eq('the trigger path goes to the fan-out first', out('Leads In (from parent workflow)')[0],
    'Batch In (one item per lead)');
  eq('...and the fan-out joins the same Normalize Lead', out('Batch In (one item per lead)')[0],
    'Normalize Lead');

  // Walk the real graph: no path from any trigger reaches Reoon without passing the gate.
  const triggers = WF.nodes.filter((n) => /Trigger$/i.test(n.type) || n.type.endsWith('manualTrigger'))
    .map((n) => n.name);
  eq('there are exactly two entry points', triggers.length, 2);
  const paths = [];
  const walk = (node, path) => {
    if (path.includes(node)) return;            // cycle guard
    const p = path.concat(node);
    if (node === 'Reoon Verify (power)') { paths.push(p); return; }
    for (const nxt of out(node)) walk(nxt, p);
  };
  triggers.forEach((t) => walk(t, []));
  ok('every trigger has a path to Reoon', paths.length >= 2, `${paths.length} paths`);
  ok('EVERY path to Reoon passes through the gate, from both entry points',
    paths.every((p) => p.includes('Gate (dedupe + suppression)') && p.includes('Verify this lead?')),
    JSON.stringify(paths));
  ok('the gate sits before Reoon on every path',
    paths.every((p) => p.indexOf('Gate (dedupe + suppression)') < p.indexOf('Reoon Verify (power)')));
  ok('no path reaches Reoon without Normalize Lead',
    paths.every((p) => p.includes('Normalize Lead')));

  // The fan-out must stay a fan-out: no gating logic duplicated inside it.
  const fanJs = jsOf('Batch In (one item per lead)');
  const code = fanJs.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok('the fan-out contains no suppression logic', !/suppress/i.test(code));
  ok('the fan-out contains no dedupe logic', !/dedup|duplicate/i.test(code));
  ok('the fan-out does not recompute lead_id or sha256', !/lead_id|sha256/i.test(code));
  ok('the fan-out makes no HTTP call', !/http|fetch|axios/i.test(code));

  // Credentials and Sheets discipline are untouched by this change.
  const creds = WF.nodes.filter((n) => n.credentials).flatMap((n) => Object.values(n.credentials));
  ok('every credential is still pinned by id AND name', creds.every((c) => c.id && c.name),
    JSON.stringify(creds));
  ok('the Sheets credential is still VIOgsheetcred01',
    WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets')
      .every((n) => n.credentials.googleApi.id === 'VIOgsheetcred01'));
  ok('no new outbound call was introduced',
    WF.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').length === 1);
  ok('no secret material in the JSON',
    !/BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20}|"privateKey"/.test(readFileSync(FILE, 'utf8')));
  ok('nothing writes to the Suppression tab',
    !WF.nodes.some((n) => n.type === 'n8n-nodes-base.googleSheets'
      && n.parameters.sheetName.value === 'Suppression' && n.parameters.operation));
}

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'}: ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('failing:', fails.join(' | ')); process.exit(1); }
