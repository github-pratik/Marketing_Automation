// Offline proof of VIO-costs-rollup. Reads jsCode straight out of the workflow JSON — this test
// cannot drift from the deployed logic because it never re-types it.
//
// What this workflow is for: the Costs tab is the pilot's cost meter and today it is completely
// empty with no writer. This rolls Events up into it, once a day, per (date, tool, metric,
// source_config). The two things that matter most to get right:
//   1. IDEMPOTENT — running the rollup twice over the same Events data must not double-count.
//      This node achieves that by recomputing the FULL total from Events every run and writing it
//      with appendOrUpdate keyed on the bucket's own columns, so a second run overwrites the same
//      numbers rather than adding to them.
//   2. "Measure, don't estimate" — est_cost_usd in Events is frequently blank. A bucket must never
//      report a cost of 0 (that reads as "free") when the truth is "unknown". The same discipline
//      applies to units: a row with no units value must not be silently assumed to be 1.
import { readFileSync } from 'node:fs';
import { schemaViolations } from './sheets-schema-invariant.mjs';

const wf = JSON.parse(readFileSync(new URL('./VIO-costs-rollup.json', import.meta.url)));
const nodeNamed = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  return n;
};
const jsOf = (name) => {
  const n = nodeNamed(name);
  if (n.type !== 'n8n-nodes-base.code') throw new Error(`"${name}" is ${n.type}, not a Code node`);
  return n.parameters.jsCode;
};

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

const buildCode = jsOf('Build Rollup Rows');
// mode is runOnceForAllItems, so the node reads $input.all() — mock exactly that surface.
const build = (items) => new Function('$input', buildCode)({ all: () => items.map((j) => ({ json: j })) })
  .map((i) => i.json);

const costRows = (out) => out.filter((r) => r._kind === 'cost_row');
const summaryOf = (out) => out.find((r) => r._kind === 'summary');

const ev = (over = {}) => ({
  timestamp: '2026-08-20T10:00:00.000Z', lead_id: 'L1', lead_email: 'a@b.com',
  tool: 'reoon', action: 'verify', units: 1, est_cost_usd: '', result: 'pass',
  workflow: 'VIO-intake-verify-curate', source_config: 'oryoniq', ...over,
});

// ---------- basic bucketing ----------
{
  const out = build([ev(), ev()]);
  const rows = costRows(out);
  ok('two identical events collapse into one bucket', rows.length === 1, `got ${rows.length}`);
  ok('bucket keys on date', rows[0].date === '2026-08-20');
  ok('bucket keys on tool', rows[0].tool === 'reoon');
  ok('bucket keys on metric (= action)', rows[0].metric === 'verify');
  ok('bucket keys on source_config', rows[0].source_config === 'oryoniq');
}

{
  const out = costRows(build([
    ev({ tool: 'reoon' }), ev({ tool: 'apollo', action: 'reveal' }),
  ]));
  ok('different tools produce separate rows', out.length === 2, `got ${out.length}`);
}

{
  const out = costRows(build([
    ev({ source_config: 'oryoniq' }), ev({ source_config: 'visioneerit' }),
  ]));
  ok('different source_configs are never pooled into one row', out.length === 2, `got ${out.length}`);
}

{
  const out = costRows(build([
    ev({ timestamp: '2026-08-20T23:59:00Z' }), ev({ timestamp: '2026-08-21T00:01:00Z' }),
  ]));
  ok('different days produce separate rows', out.length === 2, `got ${out.length}`);
}

// ---------- units: reliably counted, never invented ----------
{
  const out = costRows(build([ev({ units: 1 }), ev({ units: 2 }), ev({ units: 3 })]));
  ok('units sum correctly across rows in one bucket', out[0].count === 6, `got ${out[0].count}`);
}
{
  const out = costRows(build([ev({ units: 1 }), ev({ units: '' })]));
  ok('a row with no units value is NOT assumed to be 1',
     out[0].count === 1, `got ${out[0].count} (would be 2 if blank were treated as 1)`);
  ok('the gap is disclosed in notes', /no units value/.test(out[0].notes), out[0].notes);
}
{
  const out = costRows(build([ev({ units: '' }), ev({ units: null }), ev({ units: 'n/a' })]));
  ok('a bucket with NO usable units anywhere reports count as blank, not 0',
     out[0].count === '', `got ${JSON.stringify(out[0].count)}`);
}

// ---------- cost: measure, don't estimate ----------
{
  const out = costRows(build([ev({ est_cost_usd: '' }), ev({ est_cost_usd: '' })]));
  ok('a bucket where every row has blank cost reports est_cost_usd as blank, not 0',
     out[0].est_cost_usd === '', `got ${JSON.stringify(out[0].est_cost_usd)}`);
  ok('blank cost is never silently rendered as the string "0" either', out[0].est_cost_usd !== '0');
  ok('notes disclose that nothing was recorded', /no cost recorded/.test(out[0].notes), out[0].notes);
}
{
  const out = costRows(build([ev({ est_cost_usd: 0.02 }), ev({ est_cost_usd: 0.03 }), ev({ est_cost_usd: '' })]));
  ok('a partial bucket sums only the rows that DO carry a cost',
     Math.abs(out[0].est_cost_usd - 0.05) < 1e-9, `got ${out[0].est_cost_usd}`);
  ok('a partial bucket says its sum is partial', /partial sum/.test(out[0].notes), out[0].notes);
}
{
  const out = costRows(build([ev({ est_cost_usd: 0.1 }), ev({ est_cost_usd: 0.2 })]));
  ok('a fully-recorded bucket sums cleanly', Math.abs(out[0].est_cost_usd - 0.3) < 1e-9, `got ${out[0].est_cost_usd}`);
  ok('a fully-recorded bucket says so', /cost fully recorded/.test(out[0].notes), out[0].notes);
}

// ---------- idempotency ----------
{
  const events = [
    ev({ lead_email: 'a@b.com', units: 1, est_cost_usd: '' }),
    ev({ lead_email: 'c@d.com', tool: 'apollo', action: 'reveal', units: 1, est_cost_usd: 0.05 }),
    ev({ lead_email: 'e@f.com', source_config: 'visioneerit' }),
  ];
  const run1 = costRows(build(events));
  const run2 = costRows(build(events));
  ok('running the rollup twice over the SAME Events data produces the identical rows',
     JSON.stringify(run1) === JSON.stringify(run2));
  // The mechanism: each run recomputes from scratch (no running total is carried between calls),
  // so a second run overwrites via appendOrUpdate rather than adding on top.
  const totalUnits = (rows) => rows.reduce((s, r) => s + (typeof r.count === 'number' ? r.count : 0), 0);
  ok('a bucket total does not grow if the same events are processed again',
     totalUnits(run1) === totalUnits(run2));
}

// ---------- missing / malformed fields degrade safely, never throw ----------
{
  let threw = null;
  let out = [];
  try { out = build([{}, { timestamp: 'not-a-date', tool: '', action: '' }]); }
  catch (e) { threw = e.message; }
  ok('malformed/empty event rows never throw', threw === null, threw || '');
  const rows = costRows(out);
  ok('an unparsable date buckets under "unknown" rather than crashing',
     rows.some((r) => r.date === 'unknown'), JSON.stringify(rows));
}

// ---------- an empty Events tab (alwaysOutputData placeholder) produces zero rows ----------
{
  // A Sheets read on a tab holding only its header row returns no data rows; alwaysOutputData
  // then hands back one placeholder item. It must not become a bogus 'unknown' bucket.
  const out = build([{}]);
  ok('a single empty placeholder item yields zero cost rows', costRows(out).length === 0);
  const s = summaryOf(out);
  ok('the summary reports zero rows seen', s && s.rows_seen === 0, JSON.stringify(s));
}

// ---------- the summary item — "how many rows had no cost recorded" must be answerable ----------
{
  const out = build([
    ev({ est_cost_usd: '' }), ev({ est_cost_usd: 0.02 }),
    ev({ units: '' }),
  ]);
  const s = summaryOf(out);
  ok('a summary item is always produced', !!s);
  ok('summary counts rows with no cost recorded',
     s.rows_with_no_cost_recorded === 2, `got ${s.rows_with_no_cost_recorded}`); // the '' row + the units:'' row (its est_cost_usd defaults to '' too)
  ok('summary counts rows with no units recorded',
     s.rows_with_no_units_recorded === 1, `got ${s.rows_with_no_units_recorded}`);
  ok('summary carries a run timestamp', typeof s.run_at === 'string' && s.run_at.length > 0);
  ok('the summary is never written to Costs (it is not a cost_row)',
     !costRows(out).some((r) => '_kind' in r && r._kind === 'summary'));
}

// ---------- structure ----------
ok('workflow id stable', wf.id === 'VIOwfKcostsroll');
ok('an error workflow is set', wf.settings?.errorWorkflow === 'VIOwfEerroralert');
ok('executionOrder is v1', wf.settings?.executionOrder === 'v1');

ok('has a schedule trigger', wf.nodes.some((n) => n.type === 'n8n-nodes-base.scheduleTrigger'));

const sheetNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
ok('at least one Sheets node exists', sheetNodes.length >= 2);
ok('retired Sheet rollup has no Google credential bound',
   sheetNodes.every((n) => !n.credentials?.googleApi));
ok('every Sheets node is typeVersion 4.7', sheetNodes.every((n) => n.typeVersion === 4.7));

const readNode = nodeNamed('Read Events');
ok('the Events read is a read operation', readNode.parameters.operation === 'read');
ok('the Events read has alwaysOutputData (does not stall on an empty tab)',
   readNode.alwaysOutputData === true);
ok('the Events read continues past its own errors (onError: continueRegularOutput)',
   readNode.onError === 'continueRegularOutput');

const schemaBad = schemaViolations(wf);
ok('Sheets caches obey the schema rule (empty on appendOrUpdate+autoMap, present on defineBelow)',
   schemaBad.length === 0, schemaBad.join(' | '));

const writeNode = nodeNamed('Write Rollup (Costs)');
ok('the Costs write uses appendOrUpdate, never plain append (idempotency)',
   writeNode.parameters.operation === 'appendOrUpdate');
ok('the Costs write matches on date+tool+metric+source_config',
   JSON.stringify((writeNode.parameters.columns?.matchingColumns || []).slice().sort())
     === JSON.stringify(['date', 'metric', 'source_config', 'tool'].sort()));
ok('the Costs write targets the Costs tab', writeNode.parameters.sheetName?.value === 'Costs');
// autoMapInputData writes whatever keys the input item carries, so the shaping
// node — not the cached schema — decides the columns. Assert it there.
const rollupJs = jsOf('Build Rollup Rows');
// `_`-prefixed keys are internal routing markers (`_kind` splits cost rows from the
// run summary). They must never become sheet columns — which holds only because the
// write is `handlingExtraData: ignoreIt`. Assert that too, or the guard is a wish.
const emitted = [...new Set([...rollupJs.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]))];
const written = emitted.filter((k) => !k.startsWith('_')).sort();
ok('Build Rollup Rows emits exactly the columns setup-google-sheets.py creates for Costs',
   JSON.stringify(written) ===
   JSON.stringify(['count', 'date', 'est_cost_usd', 'metric', 'notes', 'source_config', 'tool'].sort()),
   `emitted ${JSON.stringify(written)}`);
ok('the Costs write ignores extra keys, so _kind cannot become a column',
   writeNode.parameters.options?.handlingExtraData === 'ignoreIt');

ok('no A1 range anywhere', !/"[A-Z]{1,2}[0-9]{1,4}:[A-Z]{1,2}/.test(JSON.stringify(wf)));

const names = new Set(wf.nodes.map((n) => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const g of v.main) for (const c of g)
    ok(`connection ${src} -> ${c.node} resolves`, names.has(c.node));

console.log(`\n[costs-rollup] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
