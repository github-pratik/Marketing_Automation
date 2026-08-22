// Test harness for the VIO reply-to-call BRAIN — rebuilt 2026-08-07 against Instantly + OpenAI
// (was Victoria's `prospect_response` shape; Victoria was dropped 2026-07-24, see CLAUDE.md).
// Mirrors the code nodes in VIO-inbound-reply-to-call.json (Authenticate + Dedup/TCPA gate) and
// runs them against REAL Instantly `reply_received` webhook payload shapes (developer.instantly.ai
// guides/webhook-events) plus a mocked OpenAI sentiment-classification result, plus forged/edge
// cases. Proves the reply -> sentiment -> propose-call/skip/reject logic is correct and TCPA-safe
// BEFORE it can ever reach a human or a phone. No live n8n / OpenAI / Thoughtly needed.
//
// Scope note (why "propose_call", not "call"): Instantly's reply_received payload carries no
// phone number — reach-engine deliberately never reveals one in the batch step either (mobile/
// dial credits are reserved for exactly this moment, and revealing one is its own human-approved
// action per VIO-operator-agent.md). So this gate's job stops at "does this reply deserve a
// human's attention for a possible call" — the phone reveal and the call itself are separate,
// still-gated steps downstream, not something this workflow can decide alone.
//
// Run:  node test-reply-brain.mjs

const WEBHOOK_TOKEN = 'shared-secret-abc123'; // stands in for $env.VIO_WEBHOOK_TOKEN

// ---- Node 1: fail-closed authentication (mirrors "Authenticate (fail-closed)") — UNCHANGED,
// this logic never depended on which vendor sent the webhook. ----
function authenticate(req, expected) {
  if (!expected) throw new Error('REFUSED: VIO_WEBHOOK_TOKEN not set (fail-closed)');
  const q = req.query || {};
  const headers = req.headers || {};
  const got = q.t || q.token || headers['x-vio-token'];
  if (!got || String(got) !== String(expected)) throw new Error('REFUSED: bad or missing token');
  return req.body || req;
}

// ---- Node 2: dedup (idempotency) + TCPA warm-only gate (mirrors "Dedup + TCPA Gate") ----
// `sentiment` is a SEPARATE argument because in the live workflow it comes from a distinct
// OpenAI Classify node reading payload.reply_text — Instantly's event carries no sentiment of
// its own (unlike Victoria's old built-in ai_response field).
function decide(payload, sentiment, seen) {
  const key = payload.email_id || null;

  if (payload.event_type !== 'reply_received') {
    return { decision: 'ignore', reason: `not reply_received (${payload.event_type})` };
  }
  if (key && seen.has(key)) return { decision: 'skip', reason: 'duplicate email_id (replay/forged)' };
  if (key) seen.add(key);

  const s = String(sentiment.sentiment || '').toLowerCase();
  if (s !== 'positive') return { decision: 'skip', reason: `sentiment "${s}" (warm-only)` };
  if (sentiment.out_of_office === true) return { decision: 'skip', reason: 'out-of-office / auto-reply' };
  return {
    decision: 'propose_call',
    reason: 'positive + not-OOO — needs phone reveal + human approval before any call, not a call itself',
  };
}

// ---- Test cases (payload shapes taken from developer.instantly.ai's reply_received example;
// sentiment shapes are what the OpenAI Classify node is designed to return) ----
const REPLY_CASES = [
  { name: 'positive reply',              expect: 'propose_call',
    p: { event_type: 'reply_received', email_id: 'k1', reply_text: "Sounds interesting, tell me more." },
    sentiment: { sentiment: 'positive', out_of_office: false } },

  { name: 'positive but out-of-office',  expect: 'skip',
    p: { event_type: 'reply_received', email_id: 'k3', reply_text: "I'm OOO until the 12th, will follow up." },
    sentiment: { sentiment: 'positive', out_of_office: true } },

  { name: 'negative sentiment',          expect: 'skip',
    p: { event_type: 'reply_received', email_id: 'k4', reply_text: "Not interested, please remove me." },
    sentiment: { sentiment: 'negative', out_of_office: false } },

  { name: 'neutral sentiment',           expect: 'skip',
    p: { event_type: 'reply_received', email_id: 'k5', reply_text: "Who is this?" },
    sentiment: { sentiment: 'neutral', out_of_office: false } },

  { name: 'REPLAY of k1 (forged dup)',   expect: 'skip',
    p: { event_type: 'reply_received', email_id: 'k1', reply_text: "Sounds interesting, tell me more." },
    sentiment: { sentiment: 'positive', out_of_office: false } },

  { name: 'non-reply event',             expect: 'ignore',
    p: { event_type: 'email_opened', email_id: 'k7' },
    sentiment: { sentiment: 'positive', out_of_office: false } },

  { name: 'auto_reply_received sneaking in as reply_received (safety net)', expect: 'skip',
    p: { event_type: 'reply_received', email_id: 'k8', reply_text: "Auto-response: I am currently out of office." },
    sentiment: { sentiment: 'neutral', out_of_office: true } },
];

const AUTH_CASES = [
  { name: 'correct token',  expect: 'pass',   req: { query: { t: 'shared-secret-abc123' }, body: { event_type: 'reply_received' } } },
  { name: 'wrong token',    expect: 'reject', req: { query: { t: 'nope' }, body: { event_type: 'reply_received' } } },
  { name: 'missing token',  expect: 'reject', req: { query: {}, body: { event_type: 'reply_received' } } },
];

// ---- Run ----
let pass = 0, fail = 0;
const row = (name, expect, got, ok) => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(55)} expect ${String(expect).padEnd(13)} got ${got}`);

console.log('\n== Auth gate (forged / unauthenticated webhook) ==');
for (const c of AUTH_CASES) {
  let got;
  try { authenticate(c.req, WEBHOOK_TOKEN); got = 'pass'; }
  catch { got = 'reject'; }
  const ok = got === c.expect; ok ? pass++ : fail++;
  row(c.name, c.expect, got, ok);
}

console.log('\n== Reply gate (sentiment / TCPA warm-only / dedup) ==');
const seen = new Set();
for (const c of REPLY_CASES) {
  const r = decide(c.p, c.sentiment, seen);
  const ok = r.decision === c.expect; ok ? pass++ : fail++;
  row(c.name, c.expect, `${r.decision}  (${r.reason})`, ok);
}

console.log(`\n== RESULT: ${pass} passed, ${fail} failed ==\n`);
process.exit(fail ? 1 : 0);
