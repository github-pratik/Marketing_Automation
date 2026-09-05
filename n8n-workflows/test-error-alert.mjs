// Offline proof of VIO-error-alert's rate limit.
//
// On 2026-09-04 this workflow posted 1,153 messages to Slack in one hour while the scheduler
// misfired VIO-inbox-mapper ~2,500 times. A channel that can take a thousand identical alerts is
// a channel people mute, which recreates the exact blindness this workflow exists to end. These
// tests drive the deployed jsCode with a fake clock and fake static data, so they cannot drift
// from what runs.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-error-alert.json', import.meta.url)));
const code = wf.nodes.find((n) => n.name === 'Shape Alert').parameters.jsCode;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// Harness: one persistent static-data object per "workflow", a settable clock.
function makeRunner() {
  const staticData = {};
  let clock = 1_700_000_000_000;
  const run = (wfName, node, message) => {
    const input = { first: () => ({ json: {
      workflow: { name: wfName, id: 'VIOwfX' },
      execution: { id: 'e1', lastNodeExecuted: node, error: { message } },
    } }) };
    const realNow = Date.now; Date.now = () => clock;
    try {
      return new Function('$input', '$getWorkflowStaticData', '$env', code)(
        input, () => staticData, {});
    } finally { Date.now = realNow; }
  };
  return { run, tick: (ms) => { clock += ms; }, staticData };
}

// ---------- first sight always posts ----------
{
  const r = makeRunner();
  const out = r.run('VIO-inbox-mapper', 'Read Inbox', 'The service is receiving too many requests from you');
  ok('a first failure posts', out.length === 1);
  ok('  and is labelled as a failure, not a refusal', out[0].json.is_refusal === false);
  ok('  with the workflow and node named', /VIO-inbox-mapper/.test(out[0].json.text) && /Read Inbox/.test(out[0].json.text));
}

// ---------- dedupe ----------
{
  const r = makeRunner();
  r.run('VIO-inbox-mapper', 'Read Inbox', 'quota');
  r.tick(60_000);
  const second = r.run('VIO-inbox-mapper', 'Read Inbox', 'quota');
  ok('the same failure one minute later is suppressed', second.length === 0);
  r.tick(11 * 60_000);
  const third = r.run('VIO-inbox-mapper', 'Read Inbox', 'quota');
  ok('after the dedupe window it posts again', third.length === 1);
  ok('  and reports how many it swallowed', /1 similar alert\(s\) suppressed/.test(third[0].json.text), third[0].json.text.slice(-80));
}

{
  const r = makeRunner();
  r.run('VIO-inbox-mapper', 'Read Inbox', 'quota');
  const other = r.run('VIO-enrol-email', 'Write Lead Row', 'column names');
  ok('a DIFFERENT failure inside the window still posts (dedupe is per signature)', other.length === 1);
}

// ---------- storm ----------
{
  const r = makeRunner();
  let posted = 0;
  // 20 distinct failures in 5 minutes — a storm even though nothing is a duplicate
  for (let i = 0; i < 20; i++) {
    const out = r.run('VIO-inbox-mapper', `Node ${i}`, `failure ${i}`);
    posted += out.length;
    if (out.length && out[0].json.is_storm) {
      ok(`storm notice fires at failure #${i + 1} (threshold 15)`, i === 15, `fired at ${i + 1}`);
    }
    r.tick(15_000);
  }
  ok('the storm posts 15 individual alerts + 1 storm notice, then nothing', posted === 16, `posted ${posted}`);
  const during = r.run('VIO-inbox-mapper', 'Node 99', 'failure 99');
  ok('everything during the quiet period is swallowed', during.length === 0);
  r.tick(31 * 60_000);
  const after = r.run('VIO-inbox-mapper', 'Node 100', 'failure 100');
  ok('after the quiet period alerts resume', after.length === 1);
  ok('  and the resume carries the swallowed count', /suppressed since/.test(after[0].json.text));
}

// ---------- refusals never trip the storm ----------
{
  const r = makeRunner();
  let storms = 0;
  for (let i = 0; i < 25; i++) {
    const out = r.run('VIO-enrol-email', 'Preconditions', `REFUSED: reason ${i}`);
    if (out.length && out[0].json.is_storm) storms++;
    r.tick(10_000);
  }
  ok('25 distinct guard refusals in 4 minutes do not trigger a storm', storms === 0);
}

// ---------- the existing behaviour is intact ----------
{
  const r = makeRunner();
  const out = r.run('VIO-enrol-email', 'Preconditions (fail closed)', 'REFUSED: nobody vouched');
  ok('a refusal is still labelled as a guard, not an outage', out[0].json.is_refusal === true && /Refused/.test(out[0].json.subject));
}

console.log(`\n[error-alert] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
