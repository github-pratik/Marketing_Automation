// Suppression matching, tested against the REAL database.
//
// WHY THIS EXISTS
// Until 2026-09-05 this logic lived twice: once in JavaScript inside the intake gate, once in SQL
// inside Supabase. `test-suppression-parity.mjs` existed solely to prove the two had not drifted,
// because everyone on that list has asked us to stop and a one-case divergence is a person who
// opted out and gets mailed anyway.
//
// The intake gate now asks `is_suppressed()` and has no matching logic of its own, so parity is no
// longer the question — correctness of the one remaining implementation is. That implementation is
// SQL, so this suite runs SQL. Mocking it would only prove the mock.
//
// It talks to the live project through the droplet's psql, which is the only host on the path with
// a client and IPv4 reachability to the pooler. Nothing here writes to `suppression`: the table is
// append-only and its contents are a compliance record, not a fixture. Every case is asked against
// the entries that are genuinely there.
//
//   node test-suppression-sql.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HOST = 'root@104.248.119.152';
const SECRETS = new URL('../.secrets.env', import.meta.url);

const env = Object.fromEntries(
  readFileSync(SECRETS, 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));

const need = ['SUPABASE_DB_PASSWORD'];
for (const k of need) {
  if (!env[k]) {
    console.log(`[suppression-sql] SKIPPED — ${k} is not in .secrets.env`);
    process.exit(0);
  }
}

// One round trip for the whole suite. Each case is a row in the result, so a network wobble fails
// the run rather than silently testing half of it.
// SQL goes over STDIN, never as a -c argument. Two shells sit between here and psql (the local
// one and the remote one), and `$$` — which every plpgsql block needs — expands to a process id in
// both. Piping means the SQL is never a shell word, so nothing can rewrite it on the way.
function ask(sql) {
  const remote =
    `docker exec -i -e PGPASSWORD='${env.SUPABASE_DB_PASSWORD.replace(/'/g, `'\\''`)}' ` +
    `n8n-stack-postgres-1 psql -X -A -t -F '|' -v ON_ERROR_STOP=1 ` +
    `-h aws-0-us-west-2.pooler.supabase.com -p 5432 ` +
    `-U postgres.fhlwloqkcgxqyndzjeih -d postgres -f -`;
  try {
    return execFileSync('ssh', ['-o', 'ConnectTimeout=20', HOST, remote],
      { encoding: 'utf8', timeout: 120000, input: sql }).trim();
  } catch (e) {
    console.log(`[suppression-sql] could not reach the database: ${String(e.stderr || e).slice(0, 300)}`);
    process.exit(1);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// ---- what is actually on the list -------------------------------------------------------------
const listed = ask(`select identifier_type || ' ' || identifier_value from suppression order by 1`);
console.log('suppression entries currently on the list:');
for (const l of listed.split('\n').filter(Boolean)) console.log('   ', l);

// The corpus is written against `example.com`, which is on the list and is an RFC 2606 reserved
// domain — it can never be a real prospect, so these questions are safe to ask of live data.
const CASES = [
  // [label, email, domain, phone, linkedin, expected]
  ['the exact suppressed domain',            'a@example.com',        null, null, null, true],
  ['a different person at that domain',      'someone.else@example.com', null, null, null, true],
  ['plus-addressing cannot get past it',     'a+govcon@example.com', null, null, null, true],
  ['multiple plus tags cannot either',       'a+x+y@example.com',    null, null, null, true],
  ['a SUBDOMAIN is covered',                 'a@mail.example.com',   null, null, null, true],
  ['a deep subdomain is covered',            'a@a.b.c.example.com',  null, null, null, true],
  ['uppercase is the same address',          'A@EXAMPLE.COM',        null, null, null, true],
  ['surrounding whitespace is the same',     '  a@example.com  ',    null, null, null, true],
  ['a zero-width space cannot get past',     'a​@example.com',  null, null, null, true],
  ['a zero-width joiner cannot either',      'a‍@example.com',  null, null, null, true],
  ['a soft hyphen cannot either',            'a­@example.com',  null, null, null, true],
  ['a BOM inside the domain cannot either',  'a@exam﻿ple.com',  null, null, null, true],
  ['the domain given on its own',            null, 'example.com',    null, null, true],
  ['the domain with scheme and www',         null, 'https://www.example.com/careers', null, null, true],

  // The other half: over-matching would block real prospects, which is just as wrong and much
  // harder to notice, because nothing complains when mail silently does not go out.
  ['an unrelated domain is NOT blocked',     'dana@cardinalfederal.com', null, null, null, false],
  ['a lookalike suffix is NOT blocked',      'a@notexample.com',     null, null, null, false],
  ['a domain that merely CONTAINS it is NOT blocked', 'a@example.com.evil.net', null, null, null, false],
  ['a subdomain of an unrelated host is NOT blocked', 'a@mail.cardinalfederal.com', null, null, null, false],
  ['nothing at all matches nothing',         null, null, null, null, false],
  ['an empty string matches nothing',        '', '', '', '', false],
];

const q = (v) => (v === null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const sql = CASES.map(([label, e, d, p, l], i) =>
  `select ${i} as i, is_suppressed(${q(e)}, ${q(d)}, ${q(p)}, ${q(l)}) as hit`).join(' union all ');
const answers = new Map(
  ask(sql).split('\n').filter(Boolean).map((r) => {
    const [i, hit] = r.split('|');
    return [Number(i), hit === 't'];
  }));

for (const [i, [label, , , , , want]] of CASES.entries()) {
  const got = answers.get(i);
  ok(`${want ? 'BLOCKS' : 'allows'}: ${label}`, got === want, `got ${got}, want ${want}`);
}

// ---- the storage guard from migration 002 -----------------------------------------------------
// A suppression that matches nothing is the worst outcome available: someone believes a person was
// taken off the list, and they were not.
{
  // A session-local function rather than a DO block, so the outcome comes back as a ROW. A DO
  // block can only report through NOTICE, which psql writes to stderr — the first version of this
  // test read stdout, saw the bare word "DO", and called a working guard a failure.
  //
  // The insert really is attempted. The exception handler rolls its subtransaction back, so the
  // append-only compliance list is not written to by a test.
  const r = ask(`create or replace function pg_temp.try_bad_suppression() returns text
    language plpgsql as $f$
    begin
      insert into suppression (identifier_type, identifier_value, reason, added_by)
      values ('domain', 'invalid', 'test', 'test-suppression-sql.mjs');
      return 'ACCEPTED';
    exception when others then
      return case when sqlerrm like '%is ambiguous%' then 'REFUSED-AMBIGUOUS'
                  else 'OTHER: ' || sqlerrm end;
    end $f$;
    select pg_temp.try_bad_suppression();`);
  ok('a single-label domain is refused at insert', /REFUSED-AMBIGUOUS/.test(r), r.slice(0, 160));

  const rows = ask(`select count(*)::int from suppression where coalesce(array_length(match_keys,1),0) = 0`);
  ok('no stored suppression matches nothing', rows.trim() === '0', rows);
}

// ---- the gate's own query, run exactly as the workflow runs it --------------------------------
// Not a paraphrase: the SQL is read out of the deployed node, so this cannot drift from what
// executes. If someone edits the query, this test runs the edited one.
{
  const wf = JSON.parse(readFileSync(new URL('./VIO-intake-verify-curate.json', import.meta.url)));
  const node = wf.nodes.find((n) => n.name === 'Ask the database (dedupe + suppression)');
  const payload = JSON.stringify({ email: 'a+tag@example.com', domain: '', phone: '', linkedin: '', apollo_id: '' });
  const runnable = node.parameters.query.replace(/\$1::jsonb/g, `'${payload}'::jsonb`);
  const r = ask(runnable);
  const [dupe, suppressed] = r.split('|');
  ok('the deployed gate query runs against the live schema', r.includes('|'), r.slice(0, 200));
  ok('  and it reports a suppressed address as suppressed', suppressed === 't', r);
  ok('  and does not confuse suppressed with duplicate', dupe === 'f', r);
}

console.log(`\n[suppression-sql] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
