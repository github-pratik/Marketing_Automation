// Test harness for the Sheet writes on VIO-inbound-reply-to-call — built 2026-08-21.
//
// Same discipline as test-intake-gate.mjs, and for the same reason: this file does NOT re-type the
// node logic. It reads `jsCode` straight out of VIO-inbound-reply-to-call.json and runs it in a
// small n8n shim, so it tests what will actually run on the droplet and cannot silently drift from
// the workflow. (test-reply-brain.mjs, the older harness next to it, DOES re-type the gate — that
// one is a mirror and has to be kept in sync by hand.)
//
// What it proves before a single Sheet write happens live:
//   * an opt-out is detected from PHRASING, not from sentiment — "unsubscribe", "remove me",
//     "take me off your list", "stop emailing me", "opt me out", "do not contact me" all suppress
//   * a bounce suppresses with reason `bounced`, and never overwrites reply_* on the lead row
//   * a positive reply, a negative-but-not-opt-out reply, and an out-of-office DO NOT suppress
//   * the Leads row is matched on lead_id and genuinely FALLS BACK to contact_email
//   * Suppression rows are only ever appended, carry all five documented columns, and are never
//     written with a blank identifier_value (a blank one would match everything in WF-1's check)
//   * a malformed / half-missing payload fails safe: no throw, no write, and the Events row says
//     in plain words what a human has to fix
//   * every write is header-name mapped — no A1 column letters anywhere, because the live column
//     order does not match SHEET_SCHEMA.md
//
// Run:  node test-reply-sheet-writes.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const WF_PATH = join(HERE, 'VIO-inbound-reply-to-call.json');
const RAW = readFileSync(WF_PATH, 'utf8');
const WF = JSON.parse(RAW);

const nodeByName = (name) => {
  const n = WF.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node named "${name}" in the workflow JSON`);
  return n;
};
const jsOf = (name) => nodeByName(name).parameters.jsCode;

// ---- minimal n8n Code-node shim --------------------------------------------------------------
const wrap = (v) => (Array.isArray(v) ? v : [v]).map((json) => ({ json }));

// mode: runOnceForAllItems  ($input.all(), $('Node').all())
function runAll(nodeName, { input = [], nodes = {} } = {}) {
  const body = jsOf(nodeName);
  const $input = { all: () => wrap(input) };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`shim: node "${name}" not wired for this test`);
    return { all: () => wrap(nodes[name]), first: () => wrap(nodes[name])[0] };
  };
  // eslint-disable-next-line no-new-func
  return new Function('$input', '$', body)($input, $).map((i) => i.json);
}

// mode: runOnceForEachItem  ($input.item, $('Node').item, $getWorkflowStaticData)
function runEach(nodeName, { item = {}, nodes = {}, staticData = {} } = {}) {
  const body = jsOf(nodeName);
  const $input = { item: { json: item } };
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`shim: node "${name}" not wired for this test`);
    return { item: { json: nodes[name] } };
  };
  const $getWorkflowStaticData = () => staticData;
  // eslint-disable-next-line no-new-func
  const out = new Function('$input', '$', '$getWorkflowStaticData', body)($input, $, $getWorkflowStaticData);
  return [out.json];
}

// The Sheets read node emits one empty placeholder item when the tab holds only its header row
// (alwaysOutputData). Model that faithfully — mistaking it for a real row is exactly the bug.
const sheetRows = (rows) => (rows.length ? rows : [{}]);

// What the OpenAI node hands the gate: a raw chat/completions response (simplifyOutput: false).
const openAiRaw = (sentiment) => ({
  choices: [{ message: { content: JSON.stringify(sentiment) } }],
});

// Drive the real chain: gate -> outcome -> the four shape nodes that feed the four Sheets nodes.
function run(payload, sentiment, { leads = [], staticData = {}, rawOverride } = {}) {
  const gate = runEach('Dedup + TCPA Gate', {
    item: rawOverride !== undefined ? rawOverride : openAiRaw(sentiment),
    nodes: { 'Authenticate (fail-closed)': payload },
    staticData,
  });
  const outcome = runAll('Shape Reply Outcome', {
    input: sheetRows(leads),
    nodes: { 'Dedup + TCPA Gate': gate },
  });
  return {
    gate: gate[0],
    outcome: outcome[0],
    outcomes: outcome,
    updById: runAll('Shape Lead Update (by lead_id)', { input: outcome }),
    updByEmail: runAll('Shape Lead Update (by contact_email)', { input: outcome }),
    suppression: runAll('Shape Suppression Row', { input: outcome }),
    events: runAll('Shape Reply Event', { input: outcome }),
  };
}

// ---- assertions ------------------------------------------------------------------------------
let pass = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fails.push(label); console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`); }
}
const eq = (label, got, want) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const EMAIL = 'pat.rivera@acme-fed.com';
const LEAD_ROW = {
  lead_id: '5f3a9b',
  contact_email: EMAIL,
  source_config: 'oryoniq',
  first_name: 'Pat',
  reply_received: false,
  reply_sentiment: '',
};
const reply = (text, extra = {}) => ({
  event_type: 'reply_received',
  email_id: 'e-' + Math.random().toString(16).slice(2),
  campaign_id: 'c-1',
  lead_email: EMAIL,
  lead_id: '5f3a9b',
  reply_text: text,
  ...extra,
});
const POS = { sentiment: 'positive', out_of_office: false };
const NEG = { sentiment: 'negative', out_of_office: false };
const OOO = { sentiment: 'neutral', out_of_office: true };

// ================================================================================================
console.log('\n== opt-out phrasing suppresses (the compliance hole this closes) ==');
{
  const variants = [
    ['unsubscribe', 'Please unsubscribe me from this list.', NEG],
    ['remove me', 'Remove me from your mailing list, thanks.', NEG],
    ['take me off your list', 'Take me off your list please.', NEG],
    ['stop emailing', 'Stop emailing me.', NEG],
    ['opt me out', 'Please opt me out of these emails.', NEG],
    ['opt-out', 'I would like to opt-out.', NEG],
    ['do not contact me', 'Do not contact me again.', NEG],
    ["don't email us", "Don't email us anymore.", NEG],
    ['no longer wish to receive', 'I no longer wish to receive these messages.', NEG],
    // Politely worded and classified POSITIVE by the model — sentiment must not save it from
    // suppression. This is the case a sentiment-based rule would get wrong.
    ['polite opt-out classified positive', 'Thanks, looks great, but please remove me from the list.', POS],
  ];
  for (const [label, text, sent] of variants) {
    const r = run(reply(text), sent, { leads: [LEAD_ROW] });
    ok(`"${label}" -> suppressed`,
      r.suppression.length === 1 && r.suppression[0].reason === 'opt_out'
      && r.suppression[0].identifier_type === 'email'
      && r.suppression[0].identifier_value === EMAIL
      && r.suppression[0].added_by === 'VIO-inbound-reply-to-call'
      && typeof r.suppression[0].added_at === 'string' && r.suppression[0].added_at.includes('T'),
      JSON.stringify(r.suppression));
  }

  // An opt-out is still a reply: the lead row must record it, not just the Suppression tab.
  const r = run(reply('Please unsubscribe me.'), NEG, { leads: [LEAD_ROW] });
  eq('an opt-out still updates the lead row', r.updById.length, 1);
  eq('  reply_received', r.updById[0].reply_received, true);
  eq('  reply_sentiment', r.updById[0].reply_sentiment, 'negative');
  eq('  reply_out_of_office', r.updById[0].reply_out_of_office, false);
  ok('  updated_at is an ISO timestamp', /^\d{4}-\d{2}-\d{2}T.*Z$/.test(r.updById[0].updated_at), r.updById[0].updated_at);
}

console.log('\n== a bounce suppresses with reason "bounced" ==');
{
  const bounce = {
    event_type: 'email_bounced',
    email_id: 'b-1',
    campaign_id: 'c-1',
    lead_email: EMAIL,
    lead_id: '5f3a9b',
  };
  const r = run(bounce, POS, { leads: [LEAD_ROW] });
  eq('one Suppression row', r.suppression.length, 1);
  eq('  reason', r.suppression[0].reason, 'bounced');
  eq('  identifier_type', r.suppression[0].identifier_type, 'email');
  eq('  identifier_value', r.suppression[0].identifier_value, EMAIL);
  // A bounce is not a reply. Writing reply_received/reply_sentiment here would erase a real reply
  // recorded earlier on the same row.
  ok('lead row is NOT marked as replied', !('reply_received' in r.updById[0]), JSON.stringify(r.updById[0]));
  ok('lead row does not touch reply_sentiment', !('reply_sentiment' in r.updById[0]), JSON.stringify(r.updById[0]));
  eq('  channel_state_email', r.updById[0].channel_state_email, 'bounced');
  ok('  updated_at still written', typeof r.updById[0].updated_at === 'string');
  eq('an Events row is still written for the bounce', r.events.length, 1);

  const soft = run({ event_type: 'email_bounce_soft', email_id: 'b-2', lead_email: EMAIL }, POS, { leads: [LEAD_ROW] });
  eq('any *bounce* event type suppresses', soft.suppression[0].reason, 'bounced');

  const flagged = run({ event_type: 'delivery_failed', email_id: 'b-3', lead_email: EMAIL, bounced: true }, POS);
  eq('a bounced:true flag suppresses even under an unfamiliar event name', flagged.suppression[0].reason, 'bounced');
}

console.log('\n== replies that must NOT suppress ==');
{
  const cases = [
    ['positive', 'Sounds interesting — can you send some times next week?', POS, 'propose_call'],
    ['negative but not an opt-out', 'Not interested at the moment, we already have a vendor for this.', NEG, 'skip'],
    ['negative, wrong person', 'This is not my area, I have nothing to do with capture.', NEG, 'skip'],
    ['out-of-office', 'I am out of the office until the 12th with limited access to email.', OOO, 'skip'],
    ['question', 'Who is this and how did you get my address?', { sentiment: 'neutral', out_of_office: false }, 'skip'],
  ];
  for (const [label, text, sent, decision] of cases) {
    const r = run(reply(text), sent, { leads: [LEAD_ROW] });
    ok(`${label} -> NOT suppressed`, r.suppression.length === 0, JSON.stringify(r.suppression));
    eq(`${label} -> lead row updated`, r.updById.length, 1);
    eq(`${label} -> gate decision unchanged`, r.gate.decision, decision);
  }

  const oooRun = run(reply('I am OOO until the 12th.'), OOO, { leads: [LEAD_ROW] });
  eq('out-of-office is recorded on the row', oooRun.updById[0].reply_out_of_office, true);
  eq('  and its sentiment too', oooRun.updById[0].reply_sentiment, 'neutral');

  // Deliberate direction, documented in the node: an auto-reply that ALSO contains an explicit
  // opt-out request is still an opt-out. Over-suppressing costs a lead; under-suppressing is a
  // compliance breach.
  const oooOptOut = run(reply('Auto-reply: I have left the company. Please remove me from your list.'), OOO, { leads: [LEAD_ROW] });
  ok('an out-of-office containing a real opt-out DOES suppress (deliberate)',
    oooOptOut.suppression.length === 1 && oooOptOut.suppression[0].reason === 'opt_out',
    JSON.stringify(oooOptOut.suppression));
}

console.log('\n== matching the Leads row: lead_id, falling back to contact_email ==');
{
  const byId = run(reply('thanks'), POS, { leads: [LEAD_ROW] });
  eq('lead_id match wins', byId.outcome.match_on, 'lead_id');
  eq('  updates by lead_id', byId.updById.length, 1);
  eq('  and NOT by email', byId.updByEmail.length, 0);
  eq('  the match value is the lead_id', byId.updById[0].lead_id, '5f3a9b');
  ok('  contact_email is not rewritten when matching by lead_id', !('contact_email' in byId.updById[0]),
    JSON.stringify(byId.updById[0]));

  const noIdOnPayload = run(reply('thanks', { lead_id: undefined }), POS, { leads: [LEAD_ROW] });
  eq('no lead_id in payload -> falls back to contact_email', noIdOnPayload.outcome.match_on, 'contact_email');
  eq('  updates by email', noIdOnPayload.updByEmail.length, 1);
  eq('  and NOT by lead_id', noIdOnPayload.updById.length, 0);

  const staleId = run(reply('thanks', { lead_id: 'not-on-the-tab' }), POS, { leads: [LEAD_ROW] });
  eq('a lead_id that is not on the tab still falls back to email', staleId.outcome.match_on, 'contact_email');
  eq('  match value uses the Sheet spelling', staleId.updByEmail[0].contact_email, EMAIL);

  const casing = run(reply('thanks', { lead_id: '', lead_email: 'PAT.RIVERA@Acme-Fed.com ' }), POS, { leads: [LEAD_ROW] });
  eq('email matching is case/whitespace insensitive', casing.outcome.match_on, 'contact_email');

  const emptyTab = run(reply('please unsubscribe'), NEG, { leads: [] });
  eq('empty Leads tab -> no match', emptyTab.outcome.match_on, '');
  eq('  no lead update is attempted', emptyTab.updById.length + emptyTab.updByEmail.length, 0);
  // Compliance must not depend on the lead being on the tab.
  eq('  the opt-out is STILL suppressed', emptyTab.suppression.length, 1);
  eq('  and still logged to Events', emptyTab.events.length, 1);
  ok('  the Events row says no row matched', emptyTab.events[0].result.includes('no Leads row matched'),
    emptyTab.events[0].result);
}

console.log('\n== the Events row ==');
{
  const r = run(reply('Sounds interesting, tell me more.'), POS, { leads: [LEAD_ROW] });
  const e = r.events[0];
  eq('one row', r.events.length, 1);
  eq('  tool', e.tool, 'openai');
  eq('  action', e.action, 'classify_reply');
  eq('  units', e.units, 1);
  eq('  est_cost_usd is blank (measure, don\'t estimate)', e.est_cost_usd, '');
  eq('  workflow', e.workflow, 'VIO-inbound-reply-to-call');
  eq('  lead_id', e.lead_id, '5f3a9b');
  eq('  lead_email', e.lead_email, EMAIL);
  eq('  source_config comes off the matched row', e.source_config, 'oryoniq');
  ok('  result describes the classification', /reply positive/.test(e.result), e.result);
  eq('  Events keys include the schema plus reply fields for Postgres',
    JSON.stringify(Object.keys(e)),
    JSON.stringify(['timestamp', 'lead_id', 'lead_email', 'tool', 'action', 'units', 'est_cost_usd',
      'result', 'workflow', 'source_config', 'reply_sentiment', 'is_reply']));

  const opened = run({ event_type: 'email_opened', email_id: 'o-1', lead_email: EMAIL }, POS, { leads: [LEAD_ROW] });
  eq('an open writes nothing at all', opened.events.length + opened.suppression.length
    + opened.updById.length + opened.updByEmail.length, 0);
}

console.log('\n== Suppression tab safety ==');
{
  const r = run(reply('please unsubscribe'), NEG, { leads: [LEAD_ROW] });
  eq('columns are exactly the Suppression schema',
    JSON.stringify(Object.keys(r.suppression[0])),
    JSON.stringify(['identifier_type', 'identifier_value', 'reason', 'added_at', 'added_by']));

  // A blank identifier_value would be compared against EVERY identifier shape by
  // VIO-intake-verify-curate's suppression check — writing one could block the whole pipeline.
  const noEmail = run({ event_type: 'reply_received', email_id: 'n-1', reply_text: 'unsubscribe me' }, NEG);
  eq('an opt-out with no address writes NO suppression row', noEmail.suppression.length, 0);
  ok('  the outcome still says it wanted to suppress', noEmail.outcome.suppress === true);
  ok('  and the Events row tells a human to add it by hand',
    noEmail.events[0].result.includes('NO EMAIL IN PAYLOAD'), noEmail.events[0].result);

  const junkEmail = run({ event_type: 'reply_received', email_id: 'n-2', lead_email: 'not-an-address', reply_text: 'unsubscribe' }, NEG);
  eq('a malformed address is not written either', junkEmail.suppression.length, 0);

  // A workflow-level replay: the gate already refuses it, and nothing downstream may double-write.
  const shared = {};
  const first = run(reply('unsubscribe me', { email_id: 'dup-1' }), NEG, { leads: [LEAD_ROW], staticData: shared });
  const second = run(reply('unsubscribe me', { email_id: 'dup-1' }), NEG, { leads: [LEAD_ROW], staticData: shared });
  eq('first delivery suppresses', first.suppression.length, 1);
  eq('replayed delivery writes nothing', second.suppression.length + second.events.length
    + second.updById.length + second.updByEmail.length, 0);
}

console.log('\n== malformed / missing payload fields fail safe (never throw) ==');
{
  const safe = (label, fn) => {
    try { const v = fn(); ok(label, true); return v; }
    catch (e) { ok(label, false, String(e)); return null; }
  };

  const empty = safe('empty payload {} does not throw', () => run({}, POS, { leads: [LEAD_ROW] }));
  if (empty) eq('  and writes nothing', empty.events.length + empty.suppression.length + empty.updById.length, 0);

  const noType = safe('payload with no event_type does not throw',
    () => run({ lead_email: EMAIL, reply_text: 'hello' }, POS, { leads: [LEAD_ROW] }));
  if (noType) eq('  and writes nothing (unknown event)', noType.events.length, 0);

  const nullText = safe('reply_text null does not throw',
    () => run(reply(null), POS, { leads: [LEAD_ROW] }));
  if (nullText) eq('  it is simply not an opt-out', nullText.suppression.length, 0);

  const objText = safe('reply_text as an object does not throw',
    () => run(reply({ body: 'unsubscribe' }), POS, { leads: [LEAD_ROW] }));
  if (objText) eq('  still writes the lead + event rows', objText.events.length, 1);

  const htmlOnly = safe('html-only reply body does not throw',
    () => run({ event_type: 'reply_received', email_id: 'h-1', lead_email: EMAIL, reply_html: '<p>Please <b>unsubscribe</b> me</p>' }, NEG, { leads: [LEAD_ROW] }));
  if (htmlOnly) eq('  html tags are stripped before matching', htmlOnly.suppression.length, 1);

  const junkRows = safe('junk rows on the Leads tab do not throw',
    () => run(reply('hi'), POS, { leads: [{}, { lead_id: null, contact_email: null }, LEAD_ROW] }));
  if (junkRows) eq('  the real row is still found', junkRows.outcome.match_on, 'lead_id');

  const badModel = safe('an unparseable OpenAI response does not throw',
    () => run(reply('please remove me'), POS, { leads: [LEAD_ROW], rawOverride: { choices: [] } }));
  if (badModel) {
    eq('  sentiment falls back to unknown', badModel.updById[0].reply_sentiment, 'unknown');
    eq('  and the opt-out is STILL caught (phrases, not sentiment)', badModel.suppression.length, 1);
  }

  const fenced = safe('a fenced ```json model answer still parses',
    () => run(reply('hi'), POS, { leads: [LEAD_ROW], rawOverride: { choices: [{ message: { content: '```json\n{"sentiment":"positive","out_of_office":false}\n```' } }] } }));
  if (fenced) eq('  sentiment parsed', fenced.updById[0].reply_sentiment, 'positive');
}

console.log('\n== the workflow file itself ==');
{
  eq('keeps its id (updates in place, does not clone)', WF.id, 'VIOwf3inbound001');
  eq('keeps its name', WF.name, 'VIO-inbound-reply-to-call');

  // The pre-existing nodes and their ids must survive untouched.
  const ids = WF.nodes.map((n) => n.id);
  for (const id of ['vio-wf3-webhook', 'vio-wf3-auth', 'vio-wf3-openai', 'vio-wf3-decide',
    'vio-wf3-if', 'vio-wf3-propose', 'vio-wf3-skip']) {
    ok(`original node id "${id}" is unchanged`, ids.includes(id));
  }
  ok('no duplicate node ids', new Set(ids).size === ids.length);
  ok('the auth node is still fail-closed',
    /VIO_WEBHOOK_TOKEN not set \(fail-closed\)/.test(jsOf('Authenticate (fail-closed)'))
    && /bad or missing token/.test(jsOf('Authenticate (fail-closed)')));
  ok('the gate still holds the dedup + warm-only logic',
    /duplicate email_id/.test(jsOf('Dedup + TCPA Gate')) && /warm-only/.test(jsOf('Dedup + TCPA Gate')));
  ok('the Slack approval still hangs off the IF, unchanged',
    WF.connections['Propose a call?'].main[0][0].node === 'Propose Call to Human (Slack)');
  ok('the ledger path runs alongside the Slack path, not instead of it',
    WF.connections['Dedup + TCPA Gate'].main[0].map((c) => c.node).join(',')
      === 'Propose a call?,Read Leads (reply lookup)',
    JSON.stringify(WF.connections['Dedup + TCPA Gate'].main[0]));

  // Connections are coherent: every target exists, every new node is reachable from the trigger.
  const names = new Set(WF.nodes.map((n) => n.name));
  const targets = Object.values(WF.connections).flatMap((c) => c.main.flat().map((x) => x.node));
  ok('every connection points at a node that exists',
    targets.every((t) => names.has(t)), targets.filter((t) => !names.has(t)).join(','));
  ok('every connection source exists',
    Object.keys(WF.connections).every((s) => names.has(s)));
  const reachable = new Set(['Instantly Reply Webhook']);
  for (let i = 0; i < WF.nodes.length; i++) {
    for (const [src, conn] of Object.entries(WF.connections)) {
      if (!reachable.has(src)) continue;
      for (const t of conn.main.flat()) reachable.add(t.node);
    }
  }
  ok('every node is reachable from the webhook',
    WF.nodes.every((n) => reachable.has(n.name)),
    WF.nodes.filter((n) => !reachable.has(n.name)).map((n) => n.name).join(','));

  eq('zero Google Sheets nodes',
    WF.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets').length, 0);
  const pgNodes = WF.nodes.filter((n) => n.type === 'n8n-nodes-base.postgres');
  eq('five Postgres nodes: one read + four writes', pgNodes.length, 5);
  ok('every Postgres node pins VIO Supabase by id',
    pgNodes.every((n) => n.credentials?.postgres?.id === 'VIOsupabasepg1'
      && n.credentials.postgres.name === 'VIO Supabase'),
    JSON.stringify(pgNodes.map((n) => n.credentials)));
  ok('the read runs once and still emits on a miss',
    pgNodes.filter((n) => n.name.startsWith('Read '))
      .every((n) => n.executeOnce === true && n.alwaysOutputData === true));
  ok('lead updates are UPDATE, never insert',
    pgNodes.filter((n) => n.name.startsWith('Update Lead'))
      .every((n) => /update leads/i.test(n.parameters.query)
        && !/insert into leads/i.test(n.parameters.query)));
  const supp = pgNodes.filter((n) => /Suppression/.test(n.name));
  eq('exactly one Suppression writer', supp.length, 1);
  ok('  and it can only INSERT', /insert into suppression/i.test(supp[0].parameters.query)
    && !/update suppression|delete from suppression/i.test(supp[0].parameters.query));
  const events = pgNodes.filter((n) => /Event/.test(n.name));
  eq('exactly one Events writer', events.length, 1);
  ok('  inserts into events', /insert into events/i.test(events[0].parameters.query));
  ok('  also writes replies the dashboard reads', /insert into replies/i.test(events[0].parameters.query));

  const creds = WF.nodes.filter((n) => n.credentials).flatMap((n) => Object.values(n.credentials));
  ok('every credential in the file is pinned by id AND name',
    creds.every((c) => c.id && c.name), JSON.stringify(creds));
  ok('no IndustrialBriefs credential is referenced',
    !creds.some((c) => ['mPUq9mR58Mxpd1rA', 'dpzUGSCyYoUPCAvv', 'ePhhBsC5X1uQehIJ'].includes(c.id)),
    JSON.stringify(creds));
  ok('no secret material in the JSON',
    !/BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20}|"privateKey"/.test(RAW));

  // Voice stays out of scope: nothing here may dial.
  ok('no dialer node was introduced',
    !WF.nodes.some((n) => /twilio|thoughtly|vonage|plivo/i.test(n.type + JSON.stringify(n.parameters))));
}

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'}: ${pass}/${pass + fails.length}`);
if (fails.length) { console.log('failing:', fails.join(' | ')); process.exit(1); }
