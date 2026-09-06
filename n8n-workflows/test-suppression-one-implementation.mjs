// There must be exactly ONE implementation of suppression matching, and it must be the database.
//
// WHAT THIS REPLACES
// `test-suppression-parity.mjs` lived here until 2026-09-05. Suppression matching existed twice —
// once in JavaScript inside `VIO-enrol-email :: Preconditions (fail closed)`, once in SQL as
// `is_suppressed()` — and that test ran both over an adversarial corpus to prove they had not
// drifted. It was a good test of a bad situation: everyone on that list has ASKED US TO STOP, and
// a single divergent case is a person who opted out and gets mailed anyway.
//
// The JavaScript copy is gone. Parity is no longer a question that can be asked, so the test that
// asked it has no subject. What replaces it is the guard that keeps it that way.
//
// The matching itself — plus-addressing, subdomains, zero-width characters, and the over-matching
// half that would silently block real prospects — is proved against the live database in
// test-suppression-sql.mjs.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// The fingerprints of a re-implementation. Each one is a piece of canonicalisation that only makes
// sense if something is matching identifiers locally instead of asking.
const SMELLS = [
  [/\bemailKeys\s*=/, 'builds its own +tag-folded email keys'],
  [/\bdomainChain\s*=/, 'builds its own parent-domain chain'],
  [/const\s+supp\s*=\s*new Set/, 'builds a local suppression set to match against'],
  [/\$\(['"]Read Suppression['"]\)/, 'reads a Suppression tab to match against'],
];

// Writing to the list is a different thing entirely and stays legitimate: a bounce or an
// unsubscribe has to be able to ADD someone. Only MATCHING is centralised.
const WRITERS_ALLOWED = /append|insert into suppression/i;

const files = readdirSync(HERE).filter((f) => f.startsWith('VIO-') && f.endsWith('.json'));
ok('found the workflow files to scan', files.length > 10, String(files.length));

const offenders = [];
for (const f of files) {
  const wf = JSON.parse(readFileSync(join(HERE, f), 'utf8'));
  for (const n of wf.nodes) {
    const js = n.parameters?.jsCode || '';
    if (!js) continue;
    for (const [re, what] of SMELLS) {
      if (re.test(js)) offenders.push(`${f} :: ${n.name} — ${what}`);
    }
  }
}
ok('no workflow re-implements suppression matching in JavaScript',
   offenders.length === 0, '\n      ' + offenders.join('\n      '));

// And the one implementation is actually reachable from the two gates that decide whether a real
// person is contacted. A guard nobody calls is not a guard.
for (const [file, node] of [
  ['VIO-intake-verify-curate.json', 'Ask the database (dedupe + suppression)'],
  ['VIO-enrol-email.json', 'Ask the database (cap + suppression + history)'],
]) {
  const wf = JSON.parse(readFileSync(join(HERE, file), 'utf8'));
  const n = wf.nodes.find((x) => x.name === node);
  ok(`${file} asks the database`, Boolean(n), `no node named "${node}"`);
  if (n) {
    ok(`  and the question is is_suppressed()`, /is_suppressed\(/.test(n.parameters.query));
    // Over every identifier we hold, not just the address — the list matches the PERSON.
    ok(`  over more than the email alone`,
       (n.parameters.query.match(/is_suppressed\(([\s\S]*?)\)/)?.[1] || '').includes(','));
  }
}

// The sender must not be able to run without having asked.
{
  const wf = JSON.parse(readFileSync(join(HERE, 'VIO-enrol-email.json'), 'utf8'));
  const first = wf.connections['Called by Workflow']?.main?.[0]?.[0]?.node;
  ok('the send gate cannot be reached without the database answering first',
     first === 'Ask the database (cap + suppression + history)', String(first));
  const pre = wf.nodes.find((n) => n.name === 'Preconditions (fail closed)').parameters.jsCode;
  ok('and the gate fails closed when there is no answer for an address',
     /Refusing to send to an address whose suppression and send history could not be checked/.test(pre));
}

console.log(`\n[suppression-one-implementation] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
