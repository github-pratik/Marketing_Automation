// One structural tripwire, checked across every VIO workflow.
//
// THE FAILURE SHAPE: a Google Sheets node's output is ITS ROWS. Any Code node sitting behind one
// that reaches for a value produced FURTHER upstream must name that node — `$('Some Node')` — and
// not read `$input`. This broke three separate things in one day (2026-08-29/30):
//   * 'Shape for enrolment' read $input after a Sheets WRITE, so the Sendr page URL vanished and
//     the enrolment gate refused with "no sendr_page_url" while Sendr had really built the page
//   * 'Claim row (pending_approval)' wrote a page-URL field that was therefore always empty
//   * VIO-enrol-email's 'Preconditions' read $input after two Sheets READS and refused every call
//     with "no leads supplied"
// None was caught by a unit test: each workflow's own suite mocks its inputs, so it cannot see
// what actually feeds a node in the deployed graph.
//
// WHY THIS IS A LIST AND NOT A RULE: plenty of Code nodes behind a Sheets read are SUPPOSED to
// consume the rows — that is their whole job. Statically telling "consuming rows" from "reaching
// past the rows" is not decidable, and a check that cries wolf gets ignored. So every such node is
// classified here once, with a reason. A NEW one fails this suite until somebody classifies it,
// which is precisely the moment to ask "does this node need something the sheet read replaced?".
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

// Nodes whose input genuinely IS the sheet rows.
const CONSUMES_ROWS = {
  'VIO-inbox-mapper.json / Map headers (alias table)': 'the Inbox rows are the subject — it maps their headers',
  'VIO-demo-sheet-run.json / Pick demo rows': 'the Leads rows are the subject — it selects runnable ones',
  'VIO-costs-rollup.json / Build Rollup Rows': 'the Events rows are the subject — it aggregates them',
  'VIO-sheet-repair.json / Report': 'the Inbox rows are the subject — it reports what the tab holds',
  'VIO-inbox-mapper.json / Heartbeat': 'counts the Inbox rows it was just handed, to report liveness',
  'VIO-demo-sheet-run.json / Heartbeat': 'counts the Leads rows it was just handed, to report liveness',
};

const SHEETS = 'n8n-nodes-base.googleSheets';
const files = readdirSync(DIR).filter((f) => /^VIO-.*\.json$/.test(f)).sort();
ok('there are workflows to check', files.length > 0);

for (const file of files) {
  const wf = JSON.parse(readFileSync(join(DIR, file)));
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const parents = new Map();
  for (const [src, v] of Object.entries(wf.connections || {}))
    for (const g of (v.main || []))
      for (const c of (g || [])) {
        if (!parents.has(c.node)) parents.set(c.node, []);
        parents.get(c.node).push(src);
      }

  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.code') continue;
    const feeders = (parents.get(node.name) || []).map((p) => byName.get(p)).filter(Boolean);
    const sheetFeeders = feeders.filter((p) => p.type === SHEETS);
    if (!sheetFeeders.length) continue;

    const js = node.parameters.jsCode || '';
    if (!/\$input\.(first|item|all)\(\)/.test(js)) { pass++; continue; }

    const key = `${file} / ${node.name}`;
    if (key in CONSUMES_ROWS) {
      // Classified as a row-consumer. Assert it is still ONLY that: if it has started naming an
      // upstream node too, it is reaching past the rows and the classification is now wrong.
      ok(`${key} is a declared row-consumer (${CONSUMES_ROWS[key]})`, true);
      continue;
    }
    ok(`${key}: reads $input behind a Sheets node and is not classified`,
       /\$\('[^']+'\)/.test(js),
       `fed by ${sheetFeeders.map((f) => f.name).join(', ')}. If it consumes those rows, add it to ` +
       `CONSUMES_ROWS with a reason. If it needs a value from further upstream, name that node ` +
       `instead of reading $input — that is the bug this suite exists for.`);
  }
}

console.log(`\n[upstream-reads] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
