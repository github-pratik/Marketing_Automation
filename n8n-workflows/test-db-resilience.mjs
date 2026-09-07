// Database discipline, checked across every VIO workflow.
//
// WHAT THIS REPLACES
// `test-sheets-resilience.mjs` lived here until 2026-09-06. It held two rules about Google Sheets:
// every Sheets node must retry (the quota is 60 reads/minute and a burst silently failed reads
// mid-chain, hit live 2026-08-30), and a throttled read must never be reported as a missing tab.
// Both subjects are gone — there are no Sheets nodes and `VIO-sheet-audit` is retired — so the
// suite had started crashing on a file that no longer exists while its other half passed over an
// empty list and proved nothing.
//
// The CONCERN survived the migration even though the subject did not. Supabase's pooler drops idle
// connections, so a query can fail once and succeed a second later, and a workflow that treats that
// as fatal loses the lead. And two new hazards arrived with SQL that a spreadsheet never had.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

const files = readdirSync(DIR).filter((f) => /^VIO-.*\.json$/.test(f)).sort();
ok('there are workflows to check', files.length > 10, String(files.length));

let pgNodes = 0;
for (const file of files) {
  const wf = JSON.parse(readFileSync(join(DIR, file)));

  // THE CUTOVER STAYS DONE. The Google Sheets credential was deleted from n8n on 2026-09-06, so a
  // Sheets node reintroduced by a copy-paste or a restored backup would not fail loudly — it would
  // fail at runtime, on one lead, with a credential error nobody is watching for.
  const sheets = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
  ok(`${file}: no Google Sheets node`, sheets.length === 0,
     sheets.map((n) => n.name).join(', '));

  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) {
    pgNodes++;

    // RULE 1: retry. The pooler closes idle connections, so the first query after a quiet spell can
    // fail for a reason that has nothing to do with the lead. Without a retry that lead's whole
    // chain dies — and for a claimed lead it dies AFTER the claim, leaving it stranded.
    ok(`${file} / ${n.name} retries`, n.retryOnFail === true);
    ok(`  ${n.name} tries more than twice`, (n.maxTries || 0) >= 3, `maxTries=${n.maxTries}`);
    ok(`  ${n.name} waits between tries`, (n.waitBetweenTries || 0) >= 1000,
       `waitBetweenTries=${n.waitBetweenTries}`);

    // RULE 2: no expression interpolated into the SQL TEXT. Values crossing into these queries
    // include a company name a stranger typed into a spreadsheet and an address pasted from an
    // email. An `{{ }}` inside the query hands them the query.
    ok(`  ${n.name}: nothing interpolated into the SQL text`,
       !/\{\{/.test(n.parameters.query || ''),
       (n.parameters.query || '').match(/.{0,40}\{\{.{0,40}/)?.[0]);

    // RULE 3: pinned by id. Referencing a credential by NAME alone makes the CLI importer bind to
    // the first credential of that TYPE — it silently bound two VIO workflows to IndustrialBriefs'
    // OpenAI key once. This is a shared instance.
    ok(`  ${n.name}: credential pinned by id`,
       n.credentials?.postgres?.id === 'VIOsupabasepg1',
       JSON.stringify(n.credentials?.postgres));
  }
}
ok('the database nodes were actually found (this suite is not vacuous)', pgNodes > 5, String(pgNodes));

// RULE 4: nothing writes to the append-only tables by any route other than an insert. `events` and
// `suppression` are the compliance record; an UPDATE or DELETE against either is refused by a
// trigger at the database, but a workflow that tries is a workflow whose author misunderstood the
// contract, and it will fail on a real lead rather than here.
for (const file of files) {
  const wf = JSON.parse(readFileSync(join(DIR, file)));
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.postgres')) {
    const q = (n.parameters.query || '').toLowerCase();
    ok(`${file} / ${n.name}: does not edit the append-only ledger`,
       !/(update|delete\s+from)\s+events\b/.test(q), q.slice(0, 90));
    ok(`${file} / ${n.name}: does not edit the suppression list`,
       !/(update|delete\s+from)\s+suppression\b/.test(q), q.slice(0, 90));
  }
}

console.log(`\n[db-resilience] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
