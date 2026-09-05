// Offline proof of VIO-apollo-reveal — the workflow that spends Apollo lead credits.
//
// WHY THIS EXISTS
// Every other VIO workflow fails by doing nothing. This one fails by doing something expensive.
// A bug in the free search wastes an afternoon; a bug here empties a credit balance, or reveals a
// person we already hold, or hands a lead to intake with no address in it.
//
// The three things worth proving, in order of what they cost when wrong:
//   1. The cap holds, and an unauthenticated or malformed request never reaches the paid call.
//   2. Someone we already have is skipped BEFORE we pay, not after.
//   3. No branch can end without reporting — including the branches where nothing was spent.
//      A node that emits zero items stops the chain where it stands, and the terminal report never
//      runs. That is how VIO-sheet-provision silently did nothing for two runs while reporting
//      success, so every "nothing happened" path here is a test case rather than an assumption.
//
// All code is read out of the workflow JSON, never re-typed, so these tests cannot drift from what
// is deployed.
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('./VIO-apollo-reveal.json', import.meta.url)));
const nodeCode = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named ${name}`);
  return n.parameters.jsCode;
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

// Harness: `stage` holds each node's output so a later node's $('Name') resolves the way n8n's does.
const wrap = (arr) => arr.map((j) => ({ json: j }));
function runner() {
  const stage = {};
  const $ = (name) => {
    if (!(name in stage)) throw new Error(`node "${name}" did not run in this execution`);
    return { all: () => wrap(stage[name]) };
  };
  const exec = (nodeName, inputJson) => {
    const items = wrap(inputJson);
    const $input = { all: () => items, first: () => items[0] };
    const out = new Function('$input', '$', nodeCode(nodeName))($input, $);
    stage[nodeName] = (out || []).map((i) => i.json);
    return stage[nodeName];
  };
  return { exec, stage, $ };
}

const GUARD = 'Guard (cap + shape)';
const SKIP = 'Skip ones we already hold';
const SHAPE = 'Shape for intake';
const EVENTS = 'Events rows';
const REPORT = 'Reveal Report';

const person = (id, over = {}) => ({ person: Object.assign({
  id, first_name: 'Dana', last_name: 'Reyes', title: 'Capture Manager',
  email: `dana.reyes@cardinalfederal.com`,
  linkedin_url: 'https://linkedin.com/in/danareyes',
  organization: { name: 'Cardinal Federal', primary_domain: 'www.CardinalFederal.com' },
}, over) });

const guardRefuses = (name, body, re) => {
  const r = runner();
  try { r.exec(GUARD, [body]); ok(name, false, 'it was ACCEPTED'); }
  catch (e) { ok(name, re ? re.test(e.message) : /REFUSED/.test(e.message), e.message.slice(0, 110)); }
};

// ============ 1. the spending gate ============================================================
guardRefuses('an unknown product is refused', { product: 'acme', ids: ['abcdefgh'] }, /unknown product/);
guardRefuses('an array product is refused, not coerced', { product: ['oryoniq'], ids: ['abcdefgh'] }, /must be a string/);
// The whole design: you cannot say "reveal everyone matching X" and find out afterwards it meant
// nine thousand people. You name the ids you want.
guardRefuses('filters instead of ids are refused', { product: 'oryoniq', person_titles: ['CIO'] }, /must be an array/);
guardRefuses('an empty pull is refused rather than silently doing nothing', { product: 'oryoniq', ids: [] }, /empty pull is a mistake/);
guardRefuses('26 ids is refused', { product: 'oryoniq', ids: Array.from({ length: 26 }, (_, i) => 'id00000' + i) }, /cap is 25/);
guardRefuses('a hand-typed id is refused', { product: 'oryoniq', ids: ['dana@cardinalfederal.com'] }, /not a plausible Apollo person id/);
guardRefuses('  and so is a short one', { product: 'oryoniq', ids: ['abc'] }, /not a plausible/);

{
  const r = runner();
  const out = r.exec(GUARD, [{ product: 'OryonIQ ', ids: ['aaaaaaaa11', 'bbbbbbbb22', 'aaaaaaaa11'] }]);
  ok('exactly 25 ids is allowed', runner().exec(GUARD, [{ product: 'oryoniq', ids: Array.from({ length: 25 }, (_, i) => 'id000000' + i) }]).length === 25);
  // Paying twice for one address is the failure worth preventing; a human assembling a list from
  // two pages legitimately produces a repeat.
  ok('a duplicate id is collapsed, not refused', out.length === 2);
  ok('  and the collapse is reported', out[0].duplicates_collapsed === 1);
  ok('one n8n ITEM per id, never an array on one item', out.every((o) => typeof o.apollo_id === 'string'));
  ok('product is normalised for downstream', out[0].product === 'oryoniq');
}

// ============ 2. dedupe BEFORE spending =======================================================
{
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11', 'bbbbbbbb22'] }]);
  // Leads rows: one matches on apollo_id, and we also check lead_id because Leads.lead_id IS the
  // Apollo id for Apollo-sourced leads, and older reach-engine rows fill one column but not both.
  const out = r.exec(SKIP, [{ apollo_id: 'aaaaaaaa11', lead_id: 'aaaaaaaa11' }, { lead_id: 'zzzz' }]);
  ok('a lead we already hold is skipped before the paid call', out.length === 1);
  ok('  and it is the RIGHT one that survives', out[0].apollo_id === 'bbbbbbbb22');
  ok('  the skip is reported by id', JSON.stringify(out[0].already_held) === '["aaaaaaaa11"]');

  const r2 = runner();
  r2.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11'] }]);
  const only = r2.exec(SKIP, [{ lead_id: 'aaaaaaaa11' }]);
  // The load-bearing case: everyone was already ours. Emitting zero items here would stop the
  // chain and the report would never run, making an ordinary outcome look like a crash.
  ok('when EVERY id is already held, an item is still emitted', only.length === 1);
  ok('  flagged so the IF routes it past the paid call', only[0]._reveal === false);
  ok('  carrying the count for the report', only[0].already_held_count === 1);

  const r3 = runner();
  r3.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11'] }]);
  ok('an EMPTY Leads sheet reveals everyone', r3.exec(SKIP, []).length === 1);
  ok('  and flags them for the paid branch', r3.stage[SKIP][0]._reveal === true);
}

// ============ 3. shaping what Apollo returns ==================================================
{
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11', 'bbbbbbbb22'] }]);
  r.exec(SKIP, []);
  const out = r.exec(SHAPE, [person('aaaaaaaa11'), person('bbbbbbbb22', { email: 'sam@ridgeline.com', organization: { name: 'Ridgeline', primary_domain: 'ridgeline.com' } })]);
  ok('both revealed people are shaped', out.length === 2);
  // The field names must match Normalize Lead inside intake, which builds an EXPLICIT object —
  // anything not named there is silently dropped, exactly as Product was on 2026-08-29.
  ok('the intake contract fields are present',
     ['email', 'contact_email', 'first_name', 'last_name', 'company', 'title', 'company_domain',
      'linkedin_url', 'has_email', 'source_config', 'Product'].every((k) => k in out[0]));
  ok('email is lowercased', out[0].email === 'dana.reyes@cardinalfederal.com');
  ok('contact_email mirrors email', out[0].contact_email === out[0].email);
  // The reveal is worth more than the address: the free search returns neither surname nor domain.
  ok('the SURNAME the free search withheld is now present', out[0].last_name === 'Reyes');
  ok('the DOMAIN the free search withheld is now present, normalised',
     out[0].company_domain === 'cardinalfederal.com', out[0].company_domain);
  ok('Product is the display name intake writes to the sheet', out[0].Product === 'OryonIQ');
  // source_config is HOW the lead arrived, never who pitches it. Writing the product here made
  // every Apollo lead invisible to VIO-run-outreach, which selects rows on this column — the lead
  // reached the sheet, verified clean, and was skipped on every poll forever.
  ok('source_config says apollo, NOT the product', out[0].source_config === 'apollo', out[0].source_config);
  ok('  and the two are genuinely different fields', out[0].source_config !== out[0].Product.toLowerCase());
  ok('no phone is ever requested here', out[0].phone === '' && out[0].has_phone === false);
}
{
  const r = runner();
  r.exec(GUARD, [{ product: 'visioneerit', ids: ['aaaaaaaa11'] }]);
  r.exec(SKIP, []);
  ok('VisioneerIT pulls carry the VisioneerIT product name, not the default',
     r.exec(SHAPE, [person('aaaaaaaa11')])[0].Product === 'VisioneerIT');
}
{
  // onError:continueRegularOutput means a failed call arrives as an error item. One bad id must
  // not cost us the other twenty-four.
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11', 'bbbbbbbb22'] }]);
  r.exec(SKIP, []);
  const out = r.exec(SHAPE, [{ error: 'HTTP 422' }, person('bbbbbbbb22')]);
  ok('one failed reveal does not lose the others', out.length === 1);
  ok('  and the survivor is correct', out[0].apollo_id === 'bbbbbbbb22');
}
{
  // Apollo can return the person and no address. That is a credit spent for nothing, and it must
  // be visible rather than looking like a lead that quietly never appeared.
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11'] }]);
  r.exec(SKIP, []);
  const out = r.exec(SHAPE, [person('aaaaaaaa11', { email: '' })]);
  ok('a person with no address yields no lead', out.length === 1 && out[0]._any === false);
  ok('  but the attempt is still recorded', out[0].rows.length === 1);
  ok('  with a reason a human can act on', /no email address/.test(out[0].rows[0].reason));
}

{
  // THE ONE THAT MATTERS MOST. Apollo's people/match does not fail on an unknown id — proven live
  // on 2026-09-05, a request for 000000000000000000000000 returned 200 with a different person on
  // it. Had that person carried an email, a stranger nobody chose would have entered an outbound
  // pipeline and we would have paid for it. Substitution must never become a lead.
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11'] }]);
  r.exec(SKIP, []);
  const out = r.exec(SHAPE, [person('someoneelse99', { email: 'stranger@elsewhere.com' })]);
  ok('a substituted person is NOT turned into a lead', out.length === 1 && out[0]._any === false);
  ok('  the substitution is named in the reason', /DIFFERENT person/.test(out[0].rows[0].reason));
  ok('  and it is filed under the id WE asked for, so the operator can see which pick failed',
     out[0].rows[0].apollo_id === 'aaaaaaaa11', out[0].rows[0].apollo_id);
  ok('  the stranger\'s address is never carried forward',
     !JSON.stringify(out[0].rows[0]).includes('stranger@elsewhere.com'));
}

// ============ 4. the money is always logged ===================================================
{
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11', 'bbbbbbbb22'] }]);
  r.exec(SKIP, []);
  r.exec(SHAPE, [person('aaaaaaaa11'), person('bbbbbbbb22', { email: '' })]);
  const ev = r.exec(EVENTS, r.stage[SHAPE]);
  // Intake logs the leads it verifies; a credit spent on someone with no address produces no lead
  // and would otherwise leave no trace outside Apollo's billing page.
  ok('one Events row per ATTEMPT, not per usable lead', ev.length === 2);
  ok('  the successful reveal is billed 1', ev.find((e) => e.lead_id === 'aaaaaaaa11').units === 1);
  ok('  the empty one is billed 0, so totals stay honest', ev.find((e) => e.lead_id === 'bbbbbbbb22').units === 0);
  ok('  tool and action match the Events vocabulary',
     ev.every((e) => e.tool === 'apollo' && e.action === 'reveal'));
  ok('  est_cost_usd is left blank while the rate is unknown', ev.every((e) => e.est_cost_usd === ''));
  ok('  and the row says which workflow wrote it', ev.every((e) => e.workflow === 'VIO-apollo-reveal'));
  ok('the Events columns match SHEET_SCHEMA Tab 3 exactly',
     JSON.stringify(Object.keys(ev[0])) === JSON.stringify(['timestamp', 'lead_id', 'lead_email',
       'tool', 'action', 'units', 'est_cost_usd', 'result', 'workflow', 'source_config']),
     JSON.stringify(Object.keys(ev[0])));
}

// ============ 5. no branch ends without reporting =============================================
{
  // Path A: everyone already held. Nothing spent, nothing revealed — and it must still report.
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11'] }]);
  r.exec(SKIP, [{ lead_id: 'aaaaaaaa11' }]);
  const rep = r.exec(REPORT, r.stage[SKIP])[0];
  ok('A: "all already held" still produces a report', Boolean(rep.ok));
  ok('  reporting zero spend', rep.credits_spent_estimate === 0);
  ok('  and naming who was skipped', JSON.stringify(rep.already_held_ids) === '["aaaaaaaa11"]');
  ok('  and NOT claiming intake ran', rep.ran.indexOf('intake_verify_curate') === -1);
}
{
  // Path B: revealed and handed on.
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11', 'bbbbbbbb22'] }]);
  r.exec(SKIP, []);
  r.exec(SHAPE, [person('aaaaaaaa11'), person('bbbbbbbb22', { email: '' })]);
  const rep = new Function('$input', '$', nodeCode(REPORT))(
    { all: () => [], first: () => ({ json: {} }) },
    (name) => {
      if (name === 'Verify + curate (intake)') {
        return { all: () => wrap([{ email: 'dana.reyes@cardinalfederal.com', outcome: 'pass', reason: 'deliverable', reoon_status: 'safe', lead_id: 'aaaaaaaa11' }]) };
      }
      if (!(name in r.stage)) throw new Error('did not run');
      return { all: () => wrap(r.stage[name]) };
    })[0].json;
  ok('B: a real pull reports what was requested', rep.requested === 2);
  ok('  one revealed', rep.revealed === 1);
  ok('  one paid for with no address', rep.no_address === 1);
  ok('  credits estimated on revealed only', rep.credits_spent_estimate === 1);
  ok('  intake verdicts are passed through', rep.verdicts.length === 1 && rep.verdicts[0].outcome === 'pass');
  // The single most important sentence in the response: a pull is not a send.
  ok('  and the response says plainly that nothing was emailed', /Nothing has been emailed/.test(rep.note));
}
{
  // Path C: paid, and Apollo returned no address for anyone.
  const r = runner();
  r.exec(GUARD, [{ product: 'oryoniq', ids: ['aaaaaaaa11'] }]);
  r.exec(SKIP, []);
  r.exec(SHAPE, [person('aaaaaaaa11', { email: '' })]);
  const rep = r.exec(REPORT, r.stage[SHAPE])[0];
  ok('C: "paid but got nothing" still produces a report', Boolean(rep.ok));
  ok('  it does not claim a lead was created', rep.handed_to_intake === 0);
  ok('  and says so in words', /No lead was created/.test(rep.note));
}

// ============ 6. structure: the rules this workflow must not break ============================
{
  // A node counts as terminal when it has no outgoing target — which is NOT the same as being
  // absent from `connections`. A node can appear there with an empty array and still be an end.
  // The first version of this check only tested for absence, and a mutation that emptied
  // "Log Reveal (Events)"'s targets passed it: a Google Sheets write would have become a second
  // terminal, and the caller's response would have been whichever of the two finished last.
  const outgoing = (name) => ((wf.connections[name] || {}).main || [])
    .reduce((n, arm) => n + (arm || []).length, 0);
  const terminals = wf.nodes.filter((n) => outgoing(n.name) === 0)
    .filter((n) => n.type !== 'n8n-nodes-base.webhook'
                && n.type !== 'n8n-nodes-base.executeWorkflowTrigger');
  // n8n returns whichever terminal finishes last, so a second terminal makes the response a coin
  // flip. VIO-enrol-email and VIO-intake-verify-curate both shipped this bug.
  ok('exactly one terminal node', terminals.length === 1, terminals.map((n) => n.name).join(', '));
  ok('  and it is the report, not a side effect', terminals[0].name === REPORT);

  const http = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  ok('exactly one paid call', http.length === 1);
  ok('  to people/match', /people\/match/.test(http[0].parameters.url));
  // A personal inbox is worse for deliverability, worse for reply rate, and a colder thing to do
  // to someone who has never heard of us. This deliberately differs from reach-engine/engine.py.
  ok('  asking for the WORK address only', /reveal_personal_emails: false/.test(http[0].parameters.jsonBody));
  ok('  and it survives one bad id', http[0].onError === 'continueRegularOutput');

  const auth = wf.nodes.find((n) => n.name === 'Authenticate (fail-closed)');
  ok('the webhook is authenticated', Boolean(auth));
  ok('  fail-closed on a missing token', /VIO_WEBHOOK_TOKEN not set/.test(auth.parameters.jsCode));
  // Auth must sit between the webhook and anything that spends.
  ok('  and auth runs before the guard',
     wf.connections['Authenticate (fail-closed)'].main[0][0].node === GUARD);
  ok('the webhook cannot reach the paid call without passing auth',
     wf.connections['Reveal Webhook'].main[0][0].node === 'Authenticate (fail-closed)');

  const creds = wf.nodes.filter((n) => n.credentials);
  ok('every credential is pinned by id, not name alone',
     creds.every((n) => Object.values(n.credentials).every((c) => c.id)),
     creds.map((n) => n.name).join(', '));

  // MOVED TO SUPABASE 2026-09-05. The whole class of Sheets hazards this block used to guard
  // against — a cached column list compared positionally, an append that silently adds a column,
  // an unset `authentication` defaulting to OAuth2 — does not exist against a database. What
  // replaces them are the hazards that DO exist here.
  ok('no Google Sheets node remains',
     wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets').length === 0);

  const pgNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');
  ok('the record is Postgres', pgNodes.length === 2, String(pgNodes.length));
  ok('  pinned to VIO Supabase by id, not by name',
     pgNodes.every((n) => n.credentials.postgres.id === 'VIOsupabasepg1'));
  ok('  the held-ids read runs once for the batch, not once per requested id',
     pgNodes.find((n) => n.name === 'Read Leads (held ids)').executeOnce === true);
  ok('  and never stalls the chain when nobody is held yet',
     pgNodes.find((n) => n.name === 'Read Leads (held ids)').alwaysOutputData === true);
  // The values crossing into these queries include a company name a stranger typed. Interpolating
  // an expression into the SQL text would hand them the query.
  for (const n of pgNodes)
    ok(`  ${n.name}: no expression interpolated into the SQL text`, !/\{\{/.test(n.parameters.query));
  ok('  the audit write binds one jsonb parameter',
     /\$1::jsonb/.test(pgNodes.find((n) => n.name === 'Log Reveal (Events)').parameters.query));
  // The dedupe read must not be able to WRITE. It runs before the spend gate, on every pull.
  ok('  the pre-spend read is a select and nothing else',
     /^\s*select\b/i.test(pgNodes.find((n) => n.name === 'Read Leads (held ids)').parameters.query));
}

console.log(`\n[apollo-reveal] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
