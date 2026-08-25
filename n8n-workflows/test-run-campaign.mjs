// Offline proof of VIO-run-campaign's gates and wiring. Reads jsCode straight out of the workflow
// JSON so the test cannot drift from what deploys.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-run-campaign.json', import.meta.url)));
const jsOf = (name) => {
  const n = wf.nodes.find(x => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  if (n.type !== 'n8n-nodes-base.code') throw new Error(`"${name}" is ${n.type}, not a Code node`);
  return n.parameters.jsCode;
};
const CTRL = /[\u0000-\u001f\u007f]/;
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

// ---------- Resolve Run ----------
const resolveCode = jsOf('Resolve Run');
const runResolve = (b) => new Function('$input', resolveCode)({ first: () => ({ json: b }) }).json;
const throwsResolve = (b) => { try { runResolve(b); return null; } catch (e) { return e.message; } };

ok('oryoniq resolves', runResolve({ product: 'oryoniq' }).product === 'oryoniq');
ok('visioneerit resolves', runResolve({ product: 'visioneerit' }).product === 'visioneerit');
ok('case-insensitive', runResolve({ product: 'OryonIQ' }).product === 'oryoniq');
for (const [label, b] of [
  ['unknown product', { product: 'acme' }],
  ['missing product', {}],
  ['null product', { product: null }],
  ['numeric product', { product: 7 }],
  ['array product', { product: ['oryoniq'] }],
  ['object product', { product: { p: 'oryoniq' } }],
  ['empty product', { product: '   ' }],
]) {
  const msg = throwsResolve(b);
  ok(`REFUSES ${label}`, msg !== null && /REFUSED/.test(msg), msg === null ? 'did not throw' : msg);
}

ok('default limit is 5', runResolve({ product: 'oryoniq' }).limit === 5);
ok('limit capped at 25', runResolve({ product: 'oryoniq', limit: 900 }).limit === 25);
ok('cap is reported', runResolve({ product: 'oryoniq', limit: 900 }).limit_capped === true);
ok('negative falls back', runResolve({ product: 'oryoniq', limit: -3 }).limit === 5);
ok('Infinity falls back', runResolve({ product: 'oryoniq', limit: Infinity }).limit === 5);
ok('run is timestamped', typeof runResolve({ product: 'oryoniq' }).started_at === 'string');

// ---------- Fan Out ----------
const fanCode = jsOf('Fan Out Leads');
const runFan = (src, run = { product: 'oryoniq', limit: 5, started_at: 'T' }) =>
  new Function('$input', '$', fanCode)({ first: () => ({ json: src }) }, () => ({ first: () => ({ json: run }) }));

const lead = (i) => ({ first_name: 'A' + i, title: 'Capture Manager', company: 'Co' + i });
ok('fans out one item per lead', runFan({ leads: [lead(1), lead(2), lead(3)], product: 'OryonIQ' }).length === 3);
ok('carries source_config onto each item',
   runFan({ leads: [lead(1)], product: 'OryonIQ', source_config: 'oryoniq' })[0].json.source_config === 'oryoniq');
ok('preserves lead fields', runFan({ leads: [lead(1)] })[0].json.first_name === 'A1');

for (const [label, src] of [
  ['empty leads array', { leads: [] }],
  ['leads missing', {}],
  ['leads is null', { leads: null }],
  ['leads is a string', { leads: 'nope' }],
]) {
  let out = null, threw = null;
  try { out = runFan(src); } catch (e) { threw = e.message; }
  ok(`survives ${label}`, threw === null, threw);
  ok(`  ${label} ends the run cleanly`, out !== null && out.length === 1 && out[0].json._no_leads === true);
}

// ---------- Run Report ----------
const repCode = jsOf('Run Report');
const runRep = (items, run = { product: 'oryoniq', limit: 5 }) =>
  new Function('$input', '$', repCode)(
    { all: () => items.map(j => ({ json: j })), first: () => ({ json: items[0] }) },
    () => ({ first: () => ({ json: run }) }))[0].json;

const rep = runRep([
  { lead: 'Kiara · Capture Manager · Modernized Mobile LLC', opener: 'x', email: 'Hi Kiara,', email_complete: false, missing: ['sendr_page_url'] },
  { lead: 'Nina · Proposal Manager · Aviation', opener: 'y', email: 'Hi Nina,', email_complete: false, missing: [] },
]);
ok('reports the draft count', rep.drafted === 2);
ok('states zero credits spent', rep.credits_spent === 0);
ok('states nobody contacted', rep.contacted === 0);
ok('names the gated next step', /GATED/.test(rep.next_step));
ok('carries the drafts through', rep.drafts.length === 2 && rep.drafts[0].opener === 'x');

const empty = runRep([{ _no_leads: true, reason: 'none found' }]);
ok('empty run reports zero drafted', empty.drafted === 0);
ok('empty run still says zero spend', empty.credits_spent === 0 && empty.contacted === 0);

const ctrl = runRep([{ lead: 'A', opener: 'line\nbreak\ttab', email: 'x', email_complete: true, missing: [] }]);
ok('control characters scrubbed', !CTRL.test(JSON.stringify(ctrl)));
try { JSON.parse(JSON.stringify(ctrl)); pass++; }
catch { console.error('  FAIL  not strict-JSON round-trippable'); fail++; }

// ---------- structure ----------
ok('workflow id stable', wf.id === 'VIOwfCruncamp001');
ok('webhook has an explicit webhookId',
   Boolean(wf.nodes.find(n => n.type === 'n8n-nodes-base.webhook')?.webhookId),
   'without it n8n registers a mangled fallback path and 404s while reporting success');
ok('auth is fail-closed',
   /REFUSED/.test(jsOf('Authenticate (fail-closed)')) && /VIO_WEBHOOK_TOKEN/.test(jsOf('Authenticate (fail-closed)')));

const calls = wf.nodes.filter(n => n.type === 'n8n-nodes-base.executeWorkflow')
                      .map(n => n.parameters.workflowId.value);
ok('calls the source workflow', calls.includes('VIOwf9source0001'));
ok('calls the drafting workflow', calls.includes('VIOwf4agent0001'));

// The whole claim of this workflow is that a run costs nothing and reaches nobody. If a future
// edit wires in a paid or outward-facing stage without its own approval, this must fail loudly.
const GATED = {
  VIOwfArevealcon1: 'reveal_contacts (Apollo credits)',
  VIOwfBpushinst1: 'push_to_instantly (contacts real people)',
  VIOwf6sendrgen01: 'sendr page (Sendr quota)',
  VIOwf1intake0001: 'intake verify (Reoon credits)',
};
for (const [id, what] of Object.entries(GATED))
  ok(`does NOT call ${what} — this run must stay free`, !calls.includes(id));
ok('no direct HTTP node (every external call goes through a stage that owns its own gate)',
   !wf.nodes.some(n => n.type === 'n8n-nodes-base.httpRequest'));

// Execute Workflow defaults to ONE execution for ALL input items. The drafting sub-workflow
// assembles with $input.first(), so without mode:'each' eight sourced leads produced exactly one
// email and the run still reported success. Caught live 2026-08-22.
const draftNode = wf.nodes.find(n => n.name === 'Draft Email (per lead)');
ok('drafting runs once PER LEAD, not once for the batch',
   draftNode?.parameters?.mode === 'each',
   `mode=${draftNode?.parameters?.mode} — with the default, N leads in yields 1 email out`);

// A count you cannot compare against its input is not a report.
const repSrc = jsOf('Run Report');
ok('report carries the source stage counts', /emailable/.test(repSrc) && /returned_by_apollo/.test(repSrc));
ok('report flags an emailable/drafted mismatch', /all_emailable_drafted/.test(repSrc));

const names = new Set(wf.nodes.map(n => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const g of v.main) for (const c of g)
    ok(`connection ${src} -> ${c.node} resolves`, names.has(c.node));

console.log(`\n[run-campaign] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
