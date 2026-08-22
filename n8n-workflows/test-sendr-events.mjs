// Test harness for the VIO-sendr-events BRAIN — built 2026-08-10.
// Mirrors the two code nodes in VIO-sendr-events.json (Authenticate + Classify Engagement) and
// runs them against REAL Sendr webhook payload shapes (api.sendr.io/openapi, the
// POST /api/v1/enrichment/sendr-page-webhook schema), including the exact camelCased `attributes`
// echo observed live on page 3791582 — plus forged, replayed and malformed cases.
//
// Proves the Sendr engagement -> heat -> notify/log routing is correct, correlates back to the
// right lead, and is TCPA-safe BEFORE it can ever reach a human. No live n8n / Slack / Sendr needed.
//
// Why the TCPA cases are in here at all: this workflow sees the most tempting false positives in
// the whole system. "They opened their personalized page twice and clicked the CTA" reads like
// buying intent, and it is — but it is not a reply and it is not consent to be phoned. The ceiling
// here is a Slack message. These tests exist so that stays true when someone edits the heat map.
//
// Run:  node test-sendr-events.mjs

const WEBHOOK_TOKEN = 'shared-secret-abc123';   // stands in for $env.VIO_WEBHOOK_TOKEN
const SENDR_SECRET = 'sendr-generated-xyz789';  // stands in for $env.VIO_SENDR_WEBHOOK_SECRET

// ---- Node 1: fail-closed authentication (mirrors "Authenticate (fail-closed)") ----
function authenticate(req, expected, sendrSecret) {
  if (!expected) throw new Error('REFUSED: VIO_WEBHOOK_TOKEN not set (fail-closed)');
  const q = req.query || {};
  const headers = req.headers || {};
  const got = q.t || q.token || headers['x-vio-token'];
  if (!got || String(got) !== String(expected)) throw new Error('REFUSED: bad or missing token');
  if (sendrSecret) {
    const sent = headers['x-webhook-secret'];
    if (!sent || String(sent) !== String(sendrSecret)) {
      throw new Error('REFUSED: X-Webhook-Secret mismatch');
    }
  }
  return req.body || req;
}

// ---- Node 2: classify + correlate (mirrors "Classify Engagement") ----
const HEAT = {
  'engagement:meeting_booked': 'booked',
  'engagement:button_click': 'hot',
  'engagement:video_play': 'hot',
  'engagement:audio_play': 'hot',
  'engagement:video_comment': 'hot',
  'engagement:video_emoji_click': 'hot',
  'engagement:page_view': 'warm',
  'page:done': 'asset_ready',
  'page:failed': 'error',
  'page:pending': 'quiet',
  'page_render:created': 'quiet',
  'page_render:updated': 'quiet',
  'page_render:deleted': 'quiet',
  'contact_page_engagement:created': 'warm',
  'contact_page_engagement:updated': 'warm',
};

function classify(p, seen) {
  const evt = String(p.eventType || p.event_type || '');
  const attrs = p.attributes || {};
  const pick = (...names) => { for (const n of names) if (attrs[n]) return attrs[n]; return null; };

  const lead = {
    email: pick('leadEmail', 'lead_email'),
    name: pick('leadName', 'lead_name'),
    company: pick('company'),
    product: pick('product'),
    campaign: pick('sendrCampaignId', 'sendr_campaign_id'),
  };

  const key = `${p.pageId || p.pageSlug || '?'}:${evt}:${p.timestamp || ''}`;
  if (seen.includes(key)) {
    return { decision: 'skip', heat: 'duplicate', lead, event: evt };
  }
  seen.push(key);

  let heat = HEAT[evt] || 'unknown';

  // `page:failed` does not mean the page is unusable — see the workflow node's comment.
  const reason = String(p.errorMessage || p.failureMessage || '');
  const failedTask = (reason.match(/^([a-zA-Z]+Task)\b/) || [])[1] || null;
  if (heat === 'error' && !!p.pageUrl && /gif|audio|lipsync|background/i.test(reason)) {
    heat = 'asset_warning';
  }

  const notify = ['booked', 'hot', 'error', 'asset_warning'].includes(heat);
  return { decision: notify ? 'notify_human' : 'log_only', heat, event: evt, lead, failedTask };
}

// ---- Fixtures: the real attribute echo, exactly as Sendr returned it on page 3791582 ----
const REAL_ATTRS = {
  source: 'reach-engine',
  company: 'VisioneerIT',
  product: 'OryonIQ',
  apolloId: 'seed-test',
  leadName: 'Pratik',
  leadEmail: 'pratik.patil@visioneerit.com',
  sendrCampaignId: '10748',
  _GifHyperlinkText: 'See the 3 pursuits OryonIQ is tracking for your NAICS codes',
};

const ev = (eventType, extra = {}) => ({
  eventType,
  pageId: 3791582,
  pageSlug: 'd6w5stmx91',
  pageUrl: 'https://sendrpage.com/d6w5stmx91',
  templateId: 8462,
  eventStatus: 'done',
  timestamp: '2026-08-10T12:00:00.000Z',
  attributes: REAL_ATTRS,
  ...extra,
});

// ---- Tests ----
let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
}
function throws(name, fn, matchText) {
  try { fn(); console.log(` FAIL  ${name} — expected a throw, got none`); fail++; }
  catch (e) {
    const ok = e.message.includes(matchText);
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`);
    if (!ok) console.log(`        got "${e.message}", wanted it to contain "${matchText}"`);
    ok ? pass++ : fail++;
  }
}

console.log('\n-- authentication (fail-closed) --');
throws('no env token set at all -> refuse everything',
  () => authenticate({ query: { t: WEBHOOK_TOKEN } }, undefined, null), 'not set');
throws('missing token -> refused',
  () => authenticate({ query: {} }, WEBHOOK_TOKEN, null), 'bad or missing token');
throws('wrong token -> refused',
  () => authenticate({ query: { t: 'guessed' } }, WEBHOOK_TOKEN, null), 'bad or missing token');
check('correct ?t= -> body returned',
  authenticate({ query: { t: WEBHOOK_TOKEN }, body: { eventType: 'page:done' } }, WEBHOOK_TOKEN, null),
  { eventType: 'page:done' });
throws('good ?t= but wrong X-Webhook-Secret when one is configured -> refused',
  () => authenticate({ query: { t: WEBHOOK_TOKEN }, headers: { 'x-webhook-secret': 'nope' }, body: {} },
    WEBHOOK_TOKEN, SENDR_SECRET), 'X-Webhook-Secret mismatch');
check('both factors correct -> body returned',
  authenticate({ query: { t: WEBHOOK_TOKEN }, headers: { 'x-webhook-secret': SENDR_SECRET },
    body: { eventType: 'engagement:page_view' } }, WEBHOOK_TOKEN, SENDR_SECRET),
  { eventType: 'engagement:page_view' });

console.log('\n-- lead correlation (the whole reason attributes are stamped) --');
{
  const r = classify(ev('engagement:page_view'), []);
  check('camelCase echo -> lead recovered', r.lead,
    { email: 'pratik.patil@visioneerit.com', name: 'Pratik', company: 'VisioneerIT',
      product: 'OryonIQ', campaign: '10748' });
}
{
  // A page generated by hand in the Sendr UI, or by an older build, may carry snake_case.
  const snake = ev('engagement:page_view', { attributes: {
    lead_email: 'a@b.com', lead_name: 'Ada', company: 'Acme', product: 'VisioneerIT',
    sendr_campaign_id: '10751' } });
  const r = classify(snake, []);
  check('snake_case echo -> lead still recovered', r.lead,
    { email: 'a@b.com', name: 'Ada', company: 'Acme', product: 'VisioneerIT', campaign: '10751' });
}
{
  const r = classify(ev('engagement:page_view', { attributes: {} }), []);
  check('no attributes at all -> nulls, not a crash', r.lead,
    { email: null, name: null, company: null, product: null, campaign: null });
}

console.log('\n-- heat routing --');
const cases = [
  ['engagement:meeting_booked', 'booked', 'notify_human'],
  ['engagement:button_click', 'hot', 'notify_human'],
  ['engagement:video_play', 'hot', 'notify_human'],
  ['engagement:audio_play', 'hot', 'notify_human'],
  ['engagement:video_comment', 'hot', 'notify_human'],
  ['engagement:video_emoji_click', 'hot', 'notify_human'],
  ['page:failed', 'error', 'notify_human'],
  ['engagement:page_view', 'warm', 'log_only'],
  ['page:done', 'asset_ready', 'log_only'],
  ['page:pending', 'quiet', 'log_only'],
  ['page_render:updated', 'quiet', 'log_only'],
  ['contact_page_engagement:created', 'warm', 'log_only'],
  ['something:new_from_sendr', 'unknown', 'log_only'],
];
for (const [evt, heat, decision] of cases) {
  // page:failed with no pageUrl is the genuinely-broken case; the asset-only case is tested below.
  const payload = evt === 'page:failed' ? ev(evt, { pageUrl: null }) : ev(evt);
  const r = classify(payload, []);
  check(`${evt} -> ${heat}/${decision}`, { heat: r.heat, decision: r.decision }, { heat, decision });
}

console.log('\n-- page:failed is not one thing (verified live 2026-08-10) --');
{
  // The exact string Sendr delivered on the webhook. GET /pages/{id} returns errorMessage: null
  // for the same page, so this webhook is the only place the diagnosis exists.
  const real = 'pageGifTask: missing recordingFileUrl (no quick link or template video) slug=p6hml3rxye templateId=8464';
  const r = classify(ev('page:failed', { errorMessage: real }), []);
  check('GIF task failed but page URL exists -> asset_warning, not error',
    { heat: r.heat, decision: r.decision }, { heat: 'asset_warning', decision: 'notify_human' });
  check('the failing sub-task is named', r.failedTask, 'pageGifTask');
}
{
  const r = classify(ev('page:failed', { pageUrl: null, errorMessage: 'pageGifTask: whatever' }), []);
  check('no usable page URL -> still a real error', r.heat, 'error');
}
{
  const r = classify(ev('page:failed', { errorMessage: 'renderer crashed, no page produced' }), []);
  check('a non-asset failure with a URL -> still a real error', r.heat, 'error');
}

console.log('\n-- replay / dedup --');
{
  const seen = [];
  const first = classify(ev('engagement:meeting_booked'), seen);
  const replay = classify(ev('engagement:meeting_booked'), seen);
  check('first booking notifies', first.decision, 'notify_human');
  check('identical replay is skipped', { d: replay.decision, h: replay.heat },
    { d: 'skip', h: 'duplicate' });
  const later = classify(ev('engagement:meeting_booked', { timestamp: '2026-08-11T09:00:00.000Z' }), seen);
  check('a genuinely NEW booking later still notifies', later.decision, 'notify_human');
}
{
  // Sendr emits deprecated aliases alongside the new names — the same real view can arrive twice
  // under two different event names. Both are log_only, so neither can double-alert a human.
  const seen = [];
  const a = classify(ev('engagement:page_view'), seen);
  const b = classify(ev('contact_page_engagement:created'), seen);
  check('alias pair never escalates to a notification',
    { a: a.decision, b: b.decision }, { a: 'log_only', b: 'log_only' });
}

console.log('\n-- TCPA: nothing here may ever authorise a call --');
{
  const outcomes = new Set();
  for (const [evt] of cases) outcomes.add(classify(ev(evt), []).decision);
  outcomes.add(classify(ev('page:failed', { errorMessage: 'pageGifTask: x' }), []).decision);
  check('every event resolves to notify_human or log_only — no call decision exists',
    [...outcomes].sort(), ['log_only', 'notify_human']);
  const booked = classify(ev('engagement:meeting_booked'), []);
  check('even a booking only reaches notify_human', booked.decision, 'notify_human');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
