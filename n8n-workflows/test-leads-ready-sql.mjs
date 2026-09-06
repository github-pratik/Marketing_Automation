// Who may be mailed — tested against the real view, and the real claim.
//
// WHY THIS EXISTS
// Until 2026-09-05 VIO-run-outreach read the whole Leads tab and decided in JavaScript which row to
// act on: the right lifecycle state, an allowed source, not suppressed. Every one of those
// conditions is now SQL — the `leads_ready` view and the claim's own predicate — so testing them in
// JavaScript would be testing a mock of a view.
//
// Two different things are proved here, and the second matters more:
//
//   1. `leads_ready` EXCLUDES what it should. Each condition is checked by moving one probe lead in
//      and out of it. Over-inclusion here means mailing someone nobody decided to contact.
//   2. THE CLAIM CANNOT TAKE THE SAME PERSON TWICE. The sheet version read a row, did a minute of
//      work, and only then marked it — two overlapping polls could take the same lead and mail them
//      twice. This runs the deployed claim query twice in a row and asserts the second one comes
//      back empty.
//
// The probe lead uses a domain nobody will ever own and is deleted at the end, including on the
// failure paths — a test that leaves a mailable row behind is a test that mails someone.
//
//   node test-leads-ready-sql.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HOST = 'root@104.248.119.152';
const env = Object.fromEntries(
  readFileSync(new URL('../.secrets.env', import.meta.url), 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));

if (!env.SUPABASE_DB_PASSWORD) {
  console.log('[leads-ready-sql] SKIPPED — SUPABASE_DB_PASSWORD is not in .secrets.env');
  process.exit(0);
}

// SQL over STDIN, never as a -c argument: two shells sit between here and psql and `$$` expands to
// a process id in both.
function ask(sql) {
  const remote =
    `docker exec -i -e PGPASSWORD='${env.SUPABASE_DB_PASSWORD.replace(/'/g, `'\\''`)}' ` +
    `n8n-stack-postgres-1 psql -X -A -t -F '|' -v ON_ERROR_STOP=1 ` +
    `-h aws-0-us-west-2.pooler.supabase.com -p 5432 ` +
    `-U postgres.fhlwloqkcgxqyndzjeih -d postgres -f -`;
  return execFileSync('ssh', ['-o', 'ConnectTimeout=20', HOST, remote],
    { encoding: 'utf8', timeout: 120000, input: sql }).trim();
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

const PROBE = 'ready-probe@vio-ready-check.example';
const cleanup = () => {
  try {
    ask(`delete from events where lead_email = '${PROBE}';
         delete from leads  where contact_email = '${PROBE}';`);
  } catch (e) { console.log(`  WARN  cleanup failed: ${String(e.stderr || e).slice(0, 200)}`); }
};
process.on('exit', cleanup);

try {
  // ---- 1. what leads_ready lets through ------------------------------------------------------
  // Each case sets ONE field away from ready and asks whether the probe is visible. Running them as
  // a single script keeps it to one round trip and one transaction's worth of drift.
  const CASES = [
    ['a verified, unsent, allowed-source lead IS ready', "channel_state_email='not_sent', source='manual'", true],
    ['a human-approved lead IS ready',                   "channel_state_email='approved'",                 true],
    ['a console-added lead IS ready',                    "source='console'",                               true],
    ['an uploaded lead IS ready',                        "source='upload'",                                true],
    ['an Apollo lead IS ready',                          "source='apollo'",                                true],
    ['an already-enrolled lead is NOT ready',            "channel_state_email='enrolled'",                 false],
    ['a lead being worked on is NOT ready',              "channel_state_email='pending_approval'",         false],
    ['a lead awaiting a human is NOT ready',             "channel_state_email='needs_review'",             false],
    ['a rejected address is NOT ready',                  "channel_state_email='dropped'",                  false],
    ['an unrecognised source is NOT ready',              "source='some-new-integration'",                  false],
    ['a source that merely looks right is NOT ready',    "source='Manual '",                               false],
  ];

  ask(`insert into leads (contact_email, product, source, channel_state_email, verify_action)
       values ('${PROBE}', 'oryoniq', 'manual', 'not_sent', 'pass');`);

  const script = CASES.map(([, set], i) =>
    `update leads set channel_state_email='not_sent', source='manual' where contact_email='${PROBE}';
     update leads set ${set} where contact_email='${PROBE}';
     select ${i}, exists(select 1 from leads_ready where contact_email='${PROBE}');`).join('\n');
  const seen = new Map(ask(script).split('\n').filter(Boolean)
    .map((r) => { const [i, v] = r.split('|'); return [Number(i), v === 't']; }));
  for (const [i, [label, , want]] of CASES.entries())
    ok(label, seen.get(i) === want, `got ${seen.get(i)}, want ${want}`);

  // ---- 2. suppression is part of readiness, not a separate step ------------------------------
  // A lead can be verified and ready and THEN land on the never-contact list. The re-check has to
  // live in the view, or a future edit to the sender forgets it and nobody notices until someone
  // who opted out gets mailed.
  {
    // psql prints a command tag ("UPDATE 1") for every non-SELECT, so the answer has to be fenced
    // rather than read off the front of the output.
    const r = ask(`update leads set channel_state_email='not_sent', source='manual',
                          contact_email='someone@example.com'
                    where contact_email='${PROBE}';
                   select '--SUPP--';
                   select exists(select 1 from leads_ready where contact_email='someone@example.com');
                   select '--END--';
                   update leads set contact_email='${PROBE}' where contact_email='someone@example.com';`);
    const answer = r.slice(r.indexOf('--SUPP--') + 8, r.indexOf('--END--'))
      .split('\n').map((l) => l.trim()).filter(Boolean)[0];
    ok('a suppressed domain is excluded by the view itself', answer === 'f', r.slice(0, 120));
  }

  // ---- 3. the claim cannot take the same person twice ----------------------------------------
  // The query is read out of the DEPLOYED node, so this cannot drift from what runs. If someone
  // edits the claim, this test runs the edited one.
  {
    const wf = JSON.parse(readFileSync(new URL('./VIO-run-outreach.json', import.meta.url)));
    const claimSql = wf.nodes.find((n) => n.name === 'Claim one lead (atomic)').parameters.query;

    // THE PROBE WINS BY ORDERING, NOT BY MOVING ANYONE ELSE.
    //
    // The first version of this test parked every other ready lead at needs_review, ran the claim,
    // then put them back. It left a real lead stuck at needs_review when the restore did not land —
    // a test that mutates live rows to make room for itself will eventually forget to undo it, and
    // the damage is invisible: a lead that simply stops being sent.
    //
    // The claim takes `order by created_at limit 1`, so a probe dated well in the past is always
    // the one claimed. Nobody else's row is touched.
    // AND THE WHOLE THING RUNS INSIDE A TRANSACTION THAT IS ROLLED BACK.
    //
    // The claim is a real UPDATE against the live table. Running it for a test and keeping the
    // result would consume somebody's turn in the queue — and the second claim in this very test
    // exists to prove that a claimed lead cannot be taken again, so it has to actually claim.
    // Rolling back gets the proof without spending anyone.
    //
    // The claim's CTE modifies data, so Postgres refuses to let it sit inside a subquery — it has
    // to run at the top level. Markers around each run let the two results be told apart.
    const out = ask(`
      begin;
      update leads set channel_state_email='not_sent', source='manual',
                       created_at = now() - interval '10 years'
        where contact_email='${PROBE}';
      select '--FIRST--';
      ${claimSql};
      select '--SECOND--';
      ${claimSql};
      select '--END--';
      rollback;
    `);
    const between = (a, b) => out.slice(out.indexOf(a) + a.length, out.indexOf(b))
      .split('\n').map((l) => l.trim()).filter(Boolean);
    const first = between('--FIRST--', '--SECOND--');
    const second = between('--SECOND--', '--END--');
    // `ready_count|lead` — a null lead renders as a trailing empty field.
    const tookOne = (rows) => rows.length === 1 && rows[0].split('|')[1] !== '';
    ok('the first claim takes the lead', tookOne(first), JSON.stringify(first));
    ok('  and it is the probe, not somebody real',
       first.join().includes('vio-ready-check.example'), JSON.stringify(first).slice(0, 140));
    ok('the SECOND claim comes back empty for that lead — nobody is mailed twice',
       !tookOne(second) || !second.join().includes('vio-ready-check.example'),
       JSON.stringify(second).slice(0, 140));

    // The claim marked the probe inside the transaction, and the rollback undid it. That is the
    // point: nothing this suite does survives it.
    const after = ask(`select '--S--'; select channel_state_email from leads where contact_email='${PROBE}'; select '--E--';`);
    const st = after.slice(after.indexOf('--S--') + 5, after.indexOf('--E--')).trim();
    ok('the claim left no trace once rolled back', st !== 'pending_approval', st);
  }

  // ---- 4. the claim always answers, even with nothing to do ----------------------------------
  // The heartbeat hangs off this node. A query that returns no rows on an idle cycle would stop
  // that branch, and a dead scheduler would look exactly like a quiet one.
  {
    const wf = JSON.parse(readFileSync(new URL('./VIO-run-outreach.json', import.meta.url)));
    const claimSql = wf.nodes.find((n) => n.name === 'Claim one lead (atomic)').parameters.query;
    // Nothing of ours is ready (the probe was just claimed), but a REAL lead might be. That is
    // fine: the assertion is about the SHAPE of the answer, not about it being empty. Exactly one
    // row must come back either way, because the heartbeat branch hangs off this node — a query
    // that returns nothing on an idle cycle makes a dead scheduler look like a quiet one.
    // Also inside a rolled-back transaction: if a real lead happens to be ready, this must not be
    // the thing that claims it.
    const out = ask(`begin; select '--CYCLE--'; ${claimSql}; select '--END--'; rollback;`);
    const rows = out.slice(out.indexOf('--CYCLE--') + 9, out.indexOf('--END--'))
      .split('\n').map((l) => l.trim()).filter(Boolean);
    ok('every cycle returns exactly one row, claimed or not', rows.length === 1, JSON.stringify(rows));
    ok('  carrying the ready count', /^\d+\|/.test(rows[0] || ''), JSON.stringify(rows));

  }
} finally {
  cleanup();
}

console.log(`\n[leads-ready-sql] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
