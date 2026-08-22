// Offline proof that VIO-operator-agent-v2's Report node refuses a malformed, self-inconsistent,
// or over-budget plan. Reads jsCode straight out of the workflow JSON — never a re-typed copy —
// so the test cannot drift from what deploys.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-operator-agent-v2.json', import.meta.url)));
const node = wf.nodes.find(n => n.name === 'Report');
if (!node) { console.error('FAIL: Report node missing'); process.exit(1); }

const CTRL = /[\u0000-\u001f\u007f]/;

const run = (agentOutput) => {
  const $input = { first: () => ({ json: agentOutput }) };
  const fn = new Function('$input', node.parameters.jsCode);
  const r = fn($input);
  return Array.isArray(r) ? r[0].json : r.json;
};

const basePlan = (over = {}) => ({
  intended_action: 'propose_plan', product: 'OryonIQ', config_valid: true,
  lead_count: 10, estimated_credit_cost: { apollo_credits: 10, reoon_credits: 10, openai_calls: 20 },
  gated_steps: [], blocked: false, report: 'ten leads, all free steps', ...over,
});

let pass = 0, fail = 0;
const check = (label, agentOutput, wantOk, mustMention) => {
  let got;
  try { got = run(agentOutput); }
  catch (e) { console.error(`  FAIL  ${label} — threw ${e.message}`); fail++; return; }
  const okMatch = got.ok === wantOk;
  const reasons = (got.rejected || []).join(' | ').toLowerCase();
  const mentionMatch = !mustMention || reasons.includes(mustMention.toLowerCase());
  // Invariant that must hold on EVERY input, not just the ones under test.
  const invariant = !(got.ok === true && (got.rejected || []).length > 0);
  if (okMatch && mentionMatch && invariant) { pass++; }
  else {
    console.error(`  FAIL  ${label} — ok=${got.ok} (wanted ${wantOk})` +
      (mustMention && !mentionMatch ? ` · no reason mentioning "${mustMention}"` : '') +
      (!invariant ? ' · INVARIANT BROKEN: ok:true with rejections' : '') +
      ` · rejected=${JSON.stringify(got.rejected)}`);
    fail++;
  }
};

// --- accepted ---
check('clean in-budget plan',            { output: basePlan() }, true);
check('refusal with no gated steps',     { output: basePlan({ intended_action: 'refuse', gated_steps: [], report: 'refused' }) }, true);
check('gated step correctly blocked',    { output: basePlan({ gated_steps: ['reveal_contacts'], blocked: true }) }, true);
check('zero-lead report_only',           { output: basePlan({ intended_action: 'report_only', lead_count: 0, estimated_credit_cost: { apollo_credits: 0, reoon_credits: 0, openai_calls: 0 } }) }, true);

// --- structural refusals ---
check('no structured plan at all',       { output: 'I plan to reveal 500 leads' }, false, 'structured');
check('output is an array',              { output: [basePlan()] }, false, 'structured');
check('output missing entirely',         {}, false, 'structured');
check('null output',                     { output: null }, false, 'structured');

// --- self-inconsistency: each field legal, together a lie ---
check('gated steps but blocked:false',   { output: basePlan({ gated_steps: ['push_to_instantly'], blocked: false }) }, false, 'gated');
check('two gated steps unblocked',       { output: basePlan({ gated_steps: ['reveal_contacts', 'send_email'], blocked: false }) }, false, 'gated');
check('config_valid true, product none', { output: basePlan({ product: 'none', config_valid: true }) }, false);

// --- budget: operating limits (25/25/25/60), tighter than the schema ceiling ---
check('leads over budget',               { output: basePlan({ lead_count: 40, estimated_credit_cost: { apollo_credits: 20, reoon_credits: 20, openai_calls: 20 } }) }, false);
check('apollo credits over budget',      { output: basePlan({ lead_count: 25, estimated_credit_cost: { apollo_credits: 40, reoon_credits: 10, openai_calls: 20 } }) }, false);
check('openai calls over budget',        { output: basePlan({ estimated_credit_cost: { apollo_credits: 10, reoon_credits: 10, openai_calls: 500 } }) }, false);
check('exactly at budget is allowed',    { output: basePlan({ lead_count: 25, estimated_credit_cost: { apollo_credits: 25, reoon_credits: 25, openai_calls: 60 } }) }, true);

// --- costing coherence: one Apollo credit per revealed lead ---
check('apollo credits exceed lead_count', { output: basePlan({ lead_count: 5, estimated_credit_cost: { apollo_credits: 20, reoon_credits: 5, openai_calls: 10 } }) }, false);

// --- malformed cost object ---
check('cost is a string',                { output: basePlan({ estimated_credit_cost: 'about twenty credits' }) }, false);
check('cost is an array',                { output: basePlan({ estimated_credit_cost: [10, 10, 20] }) }, false);
check('cost value non-numeric',          { output: basePlan({ estimated_credit_cost: { apollo_credits: 'ten', reoon_credits: 10, openai_calls: 20 } }) }, false);
check('cost value NaN',                  { output: basePlan({ estimated_credit_cost: { apollo_credits: NaN, reoon_credits: 10, openai_calls: 20 } }) }, false);
check('cost value Infinity',             { output: basePlan({ estimated_credit_cost: { apollo_credits: Infinity, reoon_credits: 10, openai_calls: 20 } }) }, false);
check('gated_steps is a string',         { output: basePlan({ gated_steps: 'reveal_contacts', blocked: false }) }, false);

// --- the raw-control-character regression found live 2026-08-16 ---
const multiline = run({ output: basePlan({ report: 'line one\nline two\ttabbed\r\nline three' }) });
if (!CTRL.test(JSON.stringify(multiline))) pass++;
else { console.error('  FAIL  control characters survived scrubbing'); fail++; }
try { JSON.parse(JSON.stringify(multiline)); pass++; }
catch { console.error('  FAIL  output is not strict-JSON round-trippable'); fail++; }

// Scrubbing must reach NESTED strings, not just top-level ones.
const nested = run({ output: basePlan({ report: 'ok\nnewline', gated_steps: ['reveal\ncontacts'], blocked: true }) });
if (!CTRL.test(JSON.stringify(nested))) pass++;
else { console.error('  FAIL  control characters survived inside a nested array'); fail++; }

// A rejected plan must still say why — a silent ok:false is unauditable.
const r = run({ output: basePlan({ lead_count: 999, estimated_credit_cost: { apollo_credits: 999, reoon_credits: 1, openai_calls: 1 } }) });
if (Array.isArray(r.rejected) && r.rejected.length > 0 && r.rejected.every(x => typeof x === 'string' && x.length)) pass++;
else { console.error('  FAIL  rejection carries no readable reasons'); fail++; }

console.log(`\n[operator plan gate] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
