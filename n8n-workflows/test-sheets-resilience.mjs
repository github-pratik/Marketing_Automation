// Google Sheets quota discipline, checked across every VIO workflow.
//
// Sheets allows 60 READ requests per minute per user. Nothing in this system retried, so a
// perfectly ordinary burst — two pollers, someone pasting rows, and one audit run (which alone
// spends nine reads) — silently failed reads mid-chain. Hit live 2026-08-30 during a load test:
// six tabs that demonstrably existed were reported as "no such tab".
//
// Two rules come out of that, and this suite holds both.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

const files = readdirSync(DIR).filter((f) => /^VIO-.*\.json$/.test(f)).sort();
let sheetNodes = 0;

// RULE 1: every Sheets node retries with a real wait. A read that fails once under load will very
// likely succeed a few seconds later; without a retry the lead's whole chain dies for a reason
// that had nothing to do with the lead.
for (const file of files) {
  const wf = JSON.parse(readFileSync(join(DIR, file)));
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.googleSheets')) {
    sheetNodes++;
    ok(`${file} / ${n.name} retries`, n.retryOnFail === true);
    ok(`  ${n.name} tries more than twice`, (n.maxTries || 0) >= 3, `maxTries=${n.maxTries}`);
    // The quota is per MINUTE, so retrying instantly just burns the same budget again.
    // The quota is per MINUTE. 4 tries x 5s spans only 20s and a real burst still killed the run
    // (VIO-run-outreach, 2026-08-30). 5 x 15s spans ~75s, which outlasts a saturated minute.
    ok(`  ${n.name} waits long enough to outlast a quota minute`,
       (n.maxTries || 0) * (n.waitBetweenTries || 0) >= 60000,
       `${n.maxTries} x ${n.waitBetweenTries}ms = ${(n.maxTries||0)*(n.waitBetweenTries||0)}ms`);
  }
}
ok('there are Sheets nodes to check', sheetNodes > 20, `${sheetNodes}`);

// RULE 2: a throttled read must never be reported as a missing tab. The two need opposite
// responses — wait, versus re-provision the tab — so sharing a label sends people the wrong way.
{
  const audit = JSON.parse(readFileSync(join(DIR, 'VIO-sheet-audit.json')));
  const code = audit.nodes.find((n) => n.name === 'Report').parameters.jsCode;
  const run = (msg) => new Function('$', code)(() => ({ all: () => [{ json: { error: { message: msg } } }] }))[0].json;

  for (const msg of [
    "Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'",
    'Request failed with status code 429',
    'RESOURCE_EXHAUSTED',
    'The service is receiving too many requests from you',
  ]) {
    const out = run(msg);
    ok(`"${msg.slice(0, 38)}..." reads as throttled, not missing`, out.Leads.status === 'throttled', out.Leads.status);
    ok('  and the run announces it is incomplete', typeof out._WARNING === 'string' && /INCOMPLETE/.test(out._WARNING));
    ok('  and keeps the underlying error for a human', typeof out.Leads.error === 'string' && out.Leads.error.length > 0);
  }

  const gone = run('Unable to parse range: NoSuchTab!A:Z');
  ok('a genuinely unreadable tab is still reported missing', gone.Leads.status === 'missing');
  ok('  and does NOT raise the throttling warning', gone._WARNING === undefined);
  // The note has to be explicit, because "missing" is the scarier word and the one people act on.
  ok('the throttled note says it proves nothing about existence',
     /NOTHING about whether the tab exists/i.test(run('429').Leads.note));
}

console.log(`\n[sheets-resilience] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
