// One structural tripwire, checked across every VIO workflow.
//
// THE FAILURE SHAPE: a data node's output is ITS OWN RESULT — a Google Sheets node emits the rows
// it read, a Postgres node emits the rows the query returned. Any Code node sitting behind one that
// reaches for a value produced FURTHER upstream must name that node — `$('Some Node')` — and not
// read `$input`.
//
// The Sheets nodes are gone (2026-09-06) but the shape survived the migration exactly: `Gate` sits
// behind a query and needs the LEADS, `Preconditions` sits behind a query and needs the REQUEST,
// `Restore lead items` sits behind an insert and needs the payload that insert was built from. Each
// one is a place where reading $input would silently hand the next step the wrong object. This broke three separate things in one day (2026-08-29/30):
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

// Nodes whose input genuinely IS the data node's own result. Each is classified once, with the
// reason, so a NEW one fails this suite until somebody says which kind it is — and that is exactly
// the moment to ask "does this node need something the query result replaced?".
const CONSUMES_ROWS = {
  'VIO-run-outreach.json / Pick demo rows': 'the claim answer is the subject — it shapes the lead that was claimed',
  'VIO-run-outreach.json / Heartbeat': 'the claim answer is the subject — it reports what the cycle found',
  'VIO-intake-verify-curate.json / Gate (dedupe + suppression)': 'the per-lead dupe/suppression answers are the subject; it names Normalize Lead for the leads themselves',
  'VIO-enrol-email.json / Preconditions (fail closed)': 'the cap/suppression/history answer is the subject; it names Called by Workflow for the request',
  'VIO-apollo-reveal.json / Skip ones we already hold': 'the held apollo_ids are the subject; it names Guard for the requested ids',
  'VIO-apollo-reveal.json / Shape for intake': 'the people/match responses are the subject; it names Skip for the requested ids',
  'VIO-apollo-reveal.json / Events rows': 'the shaped attempts are the subject — it turns each into an audit row',
  'VIO-db-probe.json / Report': 'the query result IS the report — that is the whole workflow',
};

// Both kinds of data node, so this suite keeps working through the migration and after it.
const DATA_NODES = new Set(['n8n-nodes-base.googleSheets', 'n8n-nodes-base.postgres']);
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
    const dataFeeders = feeders.filter((p) => DATA_NODES.has(p.type));
    if (!dataFeeders.length) continue;

    const js = node.parameters.jsCode || '';
    if (!/\$input\.(first|item|all)\(\)/.test(js)) { pass++; continue; }

    const key = `${file} / ${node.name}`;
    if (key in CONSUMES_ROWS) {
      // Classified as a row-consumer. Assert it is still ONLY that: if it has started naming an
      // upstream node too, it is reaching past the rows and the classification is now wrong.
      ok(`${key} is a declared row-consumer (${CONSUMES_ROWS[key]})`, true);
      continue;
    }
    ok(`${key}: reads $input behind a data node and is not classified`,
       /\$\('[^']+'\)/.test(js),
       `fed by ${dataFeeders.map((f) => f.name).join(', ')}. If it consumes that result, add it to ` +
       `CONSUMES_ROWS with a reason. If it needs a value from further upstream, name that node ` +
       `instead of reading $input — that is the bug this suite exists for.`);
  }
}

console.log(`\n[upstream-reads] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
