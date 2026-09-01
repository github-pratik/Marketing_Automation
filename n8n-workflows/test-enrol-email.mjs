// Offline proof of VIO-enrol-email — the EMAIL enrolment path that has NO human approval.
//
// This is the highest-stakes suite in the repo. Every other workflow either costs money or writes
// a sheet; this one puts a real email in front of a real stranger with nobody reading it first.
// The Slack gate was removed here on 2026-08-30 (owner: 15-20 outreach a day makes a click per
// lead unworkable), and five automated checks took over the human's job. If any of them stops
// throwing, unreviewed mail goes out — so every check gets a test, and the tests read jsCode
// straight out of the workflow JSON so they cannot drift from what deploys.
import { readFileSync } from 'node:fs';
import { schemaViolations } from './sheets-schema-invariant.mjs';

const wf = JSON.parse(readFileSync(new URL('./VIO-enrol-email.json', import.meta.url)));
const jsOf = (name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`no node "${name}"`);
  return n.parameters.jsCode;
};
let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) pass++; else { console.error(`  FAIL  ${l}${d ? ' — ' + d : ''}`); fail++; } };

const preCode = jsOf('Preconditions (fail closed)');
// The node names every upstream it reads, so the mock answers per node. $input is deliberately
// given the LAST SHEET READ's output — which is what the deployed node actually receives — so a
// regression back to reading $input for the request fails here instead of in production.
const mk = (req, supp, ev) => (name) => {
  if (name === 'Called by Workflow') return { first: () => ({ json: req }) };
  const rows = (name === 'Read Suppression' ? supp : ev).map((j) => ({ json: j }));
  return { all: () => rows, first: () => rows[0] || { json: {} } };
};
const run = (req, supp = [], ev = []) => new Function('$input', '$', preCode)(
  { first: () => ({ json: (ev[ev.length - 1] || {}) }), all: () => ev.map((j) => ({ json: j })) },
  mk(req, supp, ev));
const refuses = (req, supp = [], ev = []) => { try { run(req, supp, ev); return null; } catch (e) { return e.message; } };

const LEAD = (o = {}) => ({
  contact_email: 'dana@northgate.com', first_name: 'Dana', company: 'Northgate Systems',
  verify_action: 'pass',
  opener: 'Most of the bids you lose, you lose to the same handful of primes.',
  sendr_page_url: 'https://sendrpage.com/abc123', ...o,
});
const REQ = (o = {}) => ({ product: 'oryoniq', leads: [LEAD()], ...o });
// Stamped with the actual current instant, so the event lands in whatever Detroit day it is right
// now. Using the UTC date here silently put every fixture event into TOMORROW for the several
// hours each evening when UTC has rolled over and Detroit has not — which is exactly the bug the
// cap fix addresses, and it made these assertions pass or fail depending on the time of day.
const NOW_ISO = new Date().toISOString();
const sends = (n, iso = NOW_ISO) => Array.from({ length: n },
  () => ({ tool: 'instantly', action: 'enroll', timestamp: iso }));

// ---------- the happy path still works ----------
ok('a verified lead is authorised', run(REQ()).length === 1);
ok('  and gets the OryonIQ campaign', run(REQ())[0].json.instantly_body.campaign
   === '77b2cd80-5bf2-4656-8857-b310858d5a77');

// ---------- CHECK 1: verified, or vouched for by a person ----------
// Replaces the human asking "is this a real address". A catch-all domain accepts mail for ANY
// address, so no verifier can confirm a mailbox on it — only a person who knows them can.
ok('an unverified lead is refused', /REFUSED/.test(refuses(REQ({ leads: [LEAD({ verify_action: 'needs_review' })] }))));
ok('a REJECTED address is refused', /REFUSED/.test(refuses(REQ({ leads: [LEAD({ verify_action: 'drop' })] }))));
ok('a lead with no verdict at all is refused', /REFUSED/.test(refuses(REQ({ leads: [LEAD({ verify_action: '' })] }))));
ok('a human vouch (approved) lets a catch-all through',
   run(REQ({ leads: [LEAD({ verify_action: 'needs_review', channel_state_email: 'approved' })] })).length === 1);
// A vouch is a judgement call about an AMBIGUOUS address, never a veto over a definite negative.
// If Reoon says the mailbox does not exist, human confidence does not make it deliverable — it
// just earns a bounce against the sending domain.
for (const verdict of ['drop', 'invalid'])
  ok(`a human vouch can NOT override a '${verdict}' verdict`,
     /verified negative/.test(refuses(REQ({ leads: [LEAD({ verify_action: verdict, channel_state_email: 'approved' })] }))));
ok('the verified-negative check runs BEFORE the vouch is consulted',
   preCode.indexOf('verified negative') < preCode.indexOf("state !== 'approved'"));

// ---------- CHECK 2: suppression, re-read at send time ----------
// Replaces "have they asked us to stop". Re-read rather than trusted, because the list moves.
for (const [label, id] of [['the exact address', 'dana@northgate.com'], ['the company domain', 'northgate.com']]) {
  ok(`suppression on ${label} refuses`,
     /REFUSED/.test(refuses(REQ(), [{ identifier_value: id }])));
}
ok('suppression matching ignores case and whitespace',
   /REFUSED/.test(refuses(REQ(), [{ identifier_value: '  DANA@NORTHGATE.COM ' }])));
ok('an unrelated suppression entry does not block', run(REQ(), [{ identifier_value: 'someone@else.com' }]).length === 1);

// ⚠️ SUPPRESSION MATCHES THE PERSON, NOT THE STRING. All three of these bypassed exact-string
// matching and reached the Instantly POST body for someone who had asked us to stop (red team,
// 2026-08-30). This is the check with legal weight, so each bypass gets its own assertion.
const SUPP_EMAIL = [{ identifier_value: 'dana@northgate.com' }];
for (const [label, addr] of [
  ['plus-addressing', 'dana+newsletter@northgate.com'],
  ['plus-addressing with junk', 'dana+a+b+c@northgate.com'],
  ['uppercase', 'DANA@NORTHGATE.COM'],
  ['surrounding whitespace', '  dana@northgate.com  '],
  ['a zero-width space mid-address', 'da​na@northgate.com'],
  ['a soft hyphen mid-address', 'da­na@northgate.com'],
  ['a zero-width joiner', 'dana‍@northgate.com'],
]) ok(`suppressed person cannot be reached via ${label}`,
      /REFUSED/.test(refuses(REQ({ leads: [LEAD({ contact_email: addr })] }), SUPP_EMAIL)), addr);

// Suppressing a DOMAIN must cover its subdomains — opting out of x.com and then being mailed at
// mail.x.com is the same person receiving the same unwanted mail.
const SUPP_DOMAIN = [{ identifier_value: 'northgate.com' }];
for (const addr of ['d@mail.northgate.com', 'd@a.b.northgate.com', 'd@NORTHGATE.COM'])
  ok(`domain suppression covers ${addr}`,
     /REFUSED/.test(refuses(REQ({ leads: [LEAD({ contact_email: addr })] }), SUPP_DOMAIN)));
// ...but must not over-reach onto a domain that merely ends similarly.
ok('domain suppression does NOT block an unrelated domain',
   run(REQ({ leads: [LEAD({ contact_email: 'd@notnorthgate.com' })] }), SUPP_DOMAIN).length === 1);
ok('  nor a different company entirely',
   run(REQ({ leads: [LEAD({ contact_email: 'd@other.com' })] }), SUPP_DOMAIN).length === 1);
ok('the suppression list is READ from the sheet, not passed in',
   /\$\('Read Suppression'\)/.test(preCode));

// ---------- CHECK 3: the product must resolve to a real campaign ----------
ok('an unknown product refuses', /REFUSED/.test(refuses(REQ({ product: 'acme' }))));
ok('a missing product refuses', /REFUSED/.test(refuses(REQ({ product: '' }))));
ok('VisioneerIT refuses with a REASON, not "unknown product"',
   /no Instantly campaign yet/.test(refuses(REQ({ product: 'visioneerit' }))));

// ---------- CHECK 4: the AI-written line, sanity-checked ----------
// Replaces the human reading the email. This is the ONLY model-written part that reaches a
// prospect; everything else is fixed campaign copy.
for (const [label, opener] of [
  ['an unrendered merge tag', 'Hi {{firstName}}, quick note about your bids this quarter.'],
  ['a closing merge brace', 'Your team at companyName}} keeps bidding the same work.'],
  ['a chatbot preamble', 'As an AI language model, I can help you write an opening line here.'],
  ['a template placeholder', 'PLACEHOLDER: write something about their capture work here.'],
  ['a leaked TODO', 'TODO: mention the recompete they lost last year to the incumbent.'],
  ['a literal undefined', 'Your work with undefined has been growing steadily this year.'],
  ['an empty line', ''],
  ['a one-word line', 'hello'],
]) ok(`opener with ${label} refuses`, /REFUSED/.test(refuses(REQ({ leads: [LEAD({ opener })] }))), opener);
ok('an absurdly long opener refuses', /REFUSED/.test(refuses(REQ({ leads: [LEAD({ opener: 'x'.repeat(401) })] }))));

// The opener lands in an HTML email body AND on a public page. The earlier check caught leaked
// ARTEFACTS (merge tags, chatbot preambles) but let malicious-but-coherent text straight through —
// a model talked into emitting a link is the difference between a bad sentence and us phishing our
// own prospect. Every legitimate URL in this campaign is fixed copy or the {{sendrPageUrl}} tag.
for (const [label, opener] of [
  ['an anchor tag', 'Your recompete looks tough <a href="http://evil.tld">see this</a> before you bid.'],
  ['any HTML tag', 'Your bids keep losing <b>badly</b> to the same incumbents every single year.'],
  ['a bare http URL', 'Worth reviewing http://evil.tld/login before your next capture decision.'],
  ['a www URL', 'Take a look at www.evil.tld for the incumbent analysis you keep missing.'],
  ['a zero-width character', 'Most bids you lose go to the same primes​ every single year now.'],
]) ok(`opener containing ${label} refuses`, /REFUSED/.test(refuses(REQ({ leads: [LEAD({ opener })] }))), opener);
ok('a clean opener with no markup or links still passes', run(REQ()).length === 1);
ok('a normal opener passes', run(REQ()).length === 1);

// ---------- CHECK 5: the daily cap, counted from what actually sent ----------
// Replaces "is this too many". Counted off Events, not an internal tally that resets on restart.
ok('under the cap is allowed', run(REQ(), [], sends(19)).length === 1);
ok('at the cap refuses', /daily cap/.test(refuses(REQ(), [], sends(20))));
ok('over the cap refuses', /daily cap/.test(refuses(REQ(), [], sends(25))));
ok('a batch that would CROSS the cap refuses whole, not partially',
   /daily cap/.test(refuses(REQ({ leads: [LEAD(), LEAD({ contact_email: 'b@northgate.com' })] }), [], sends(19))));
ok("yesterday's sends do not count", run(REQ(), [], sends(50, '2020-01-01T10:00:00Z')).length === 1);
// The UTC day rolls over ~5 hours before the Detroit day. A send made this evening must still
// count against today's cap even though UTC already calls it tomorrow.
ok('the cap follows the sending team\'s day, not UTC',
   /daily cap/.test(refuses(REQ(), [], sends(20, new Date().toISOString()))));
ok('non-enrolment events do not count against the cap',
   run(REQ(), [], Array.from({ length: 50 }, () => ({ tool: 'reoon', action: 'verify', timestamp: NOW_ISO }))).length === 1);
ok('the cap is read from the Events log', /\$\('Read Events'\)/.test(preCode));

// ---------- the request itself ----------
ok('an empty lead list refuses', /REFUSED/.test(refuses(REQ({ leads: [] }))));
ok('a malformed address refuses', /REFUSED/.test(refuses(REQ({ leads: [LEAD({ contact_email: 'not-an-address' })] }))));
ok('a comma-bearing address refuses', /REFUSED/.test(refuses(REQ({ leads: [LEAD({ contact_email: 'a@b.com,c@d.com' })] }))));
ok('a page URL that is not a URL refuses', /REFUSED/.test(refuses(REQ({ leads: [LEAD({ sendr_page_url: 'soon' })] }))));
ok('too many leads in one call refuses',
   /per-run cap/.test(refuses(REQ({ leads: Array.from({ length: 6 }, (_, i) => LEAD({ contact_email: `p${i}@x.com` })) }))));

// ---------- the body Instantly receives ----------
const body = run(REQ())[0].json.instantly_body;
ok('custom variables are TOP-LEVEL', typeof body.custom_variables === 'object');
// Nested under `payload`, Instantly silently discards them and still answers 201 — the CTA then
// renders as a bare colon to a real prospect.
ok('  and never nested under payload', !('payload' in body));
ok('the page URL rides in custom_variables', body.custom_variables.sendrPageUrl === 'https://sendrpage.com/abc123');
ok('skip_if_in_campaign is on, so nobody is mailed twice', body.skip_if_in_campaign === true);
ok('the opener is sent as personalization', body.personalization === LEAD().opener);

// ---------- structure: the endpoint may only exist past the checks ----------
ok('the Instantly endpoint appears exactly once, inside the precondition node',
   (JSON.stringify(wf).match(/api\.instantly\.ai/g) || []).length === 1
   && /api\.instantly\.ai/.test(preCode));
const post = wf.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest');
ok('the HTTP node has no URL of its own', post.parameters.url === '={{ $json.instantly_url }}');
ok('  and no body of its own', post.parameters.jsonBody === '={{ JSON.stringify($json.instantly_body) }}');
ok('there is NO campaign-activation endpoint anywhere', !/\/campaigns\//.test(JSON.stringify(wf)));
// The send hangs off the preconditions directly (so it receives the URL and body they build), but
// the write-ahead intent branch is connected FIRST so it lands before anything irreversible.
{
  const b = wf.connections['Preconditions (fail closed)'].main[0].map((c) => c.node);
  ok('the send hangs off the precondition node', b.includes('Enroll Lead (Instantly)'), b.join(', '));
  ok('  with the intent record written first', b.indexOf('Log intent (before send)') < b.indexOf('Enroll Lead (Instantly)'));
}

// ---------- reporting ----------
const repCode = jsOf('Report');
// Instantly answers 201 for a lead it did NOT create: skip_if_in_campaign is WORKSPACE-wide, so an
// address already present anywhere comes back carrying the pre-existing lead id. A previous version
// reported "enrolled: 2" while the campaign held zero.
ok('a 201 is not treated as proof of enrolment', /returnedCampaign/.test(repCode));
ok('  enrolment requires the returned lead to be in OUR campaign',
   /res\.id.*campaign_id|campaign_id.*res\.id/s.test(repCode));

const rowsCode = jsOf('Build Sheet Rows');
ok('only a real enrolment advances the lifecycle', /if \(r\.enrolled\)/.test(rowsCode));
ok('a no-op is still logged as an event', /enroll_noop/.test(rowsCode));
ok('cost is left blank, never estimated', /est_cost_usd: ''/.test(rowsCode));

// ---------- sheet hygiene ----------
const sheets = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
ok('every Sheets node pins the credential by id',
   sheets.every((n) => n.credentials?.googleApi?.id === 'VIOgsheetcred01'));
ok('every Sheets node is typeVersion 4.7', sheets.every((n) => n.typeVersion === 4.7));
const schemaBad = schemaViolations(wf);
ok('Sheets caches obey the schema rule (empty on appendOrUpdate+autoMap, present on defineBelow)',
   schemaBad.length === 0, schemaBad.join(' | '));
ok('reads never stall an empty tab',
   sheets.filter((n) => !n.parameters.operation).every((n) => n.alwaysOutputData === true));
ok('no A1 range anywhere', !/"[A-Z]{1,2}[0-9]{1,4}:[A-Z]{1,2}/.test(JSON.stringify(wf)));
ok('an error workflow is set', wf.settings?.errorWorkflow === 'VIOwfEerroralert');
ok('workflow id stable', wf.id === 'VIOwfLenrolmail');

// The trigger must PASS THROUGH, not declare a schema. `workflowInputs:{values:[]}` — an empty
// declared schema — made n8n refuse to run the workflow at all (WorkflowHasIssuesError), and a
// non-empty one would silently drop every field not named. Found live 2026-08-30.
{
  const trig = wf.nodes.find((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger');
  ok('the trigger passes input through', trig.parameters.inputSource === 'passthrough');
  ok('  and declares no input schema', !('workflowInputs' in trig.parameters));
}

// ---------- the reason this workflow may be ungated at all ----------
// The request must be read from the TRIGGER by name. Two Sheets reads sit between them, and a
// Sheets node's output is its rows — reading $input here refused every call with "no leads
// supplied" (found live 2026-08-30, the third instance of this shape in one day).
// ---------- the write-ahead checkpoint ----------
// There was no record between "Instantly accepted the send" and "the sheet recorded it". An n8n
// restart in that window — and a restart happens on every deploy — left the lead enrolled with
// nothing saying so: the row stayed pending_approval, the cap undercounted, and freeing the row
// invited a SECOND send to a real person.
{
  const ev = (action, n = 1, email = 'dana@northgate.com') => Array.from({ length: n },
    () => ({ tool: 'instantly', action, lead_email: email, timestamp: new Date().toISOString() }));

  ok('a clean history (attempt + outcome) is allowed',
     run(REQ(), [], [...ev('enroll_attempt'), ...ev('enroll')]).length === 1);
  ok('  a no-op outcome closes the attempt too',
     run(REQ(), [], [...ev('enroll_attempt'), ...ev('enroll_noop')]).length === 1);

  // The ambiguous state: we started a send and never recorded finishing it.
  ok('an attempt with NO outcome refuses the address',
     /recorded send attempt/.test(refuses(REQ(), [], ev('enroll_attempt'))));
  ok('  two attempts and one outcome also refuses',
     /recorded send attempt/.test(refuses(REQ(), [], [...ev('enroll_attempt', 2), ...ev('enroll')])));
  ok('  and the message tells a human how to resolve it',
     /Instantly.*Events row|Events row/.test(refuses(REQ(), [], ev('enroll_attempt'))));
  // Another lead's orphan must not block this one.
  ok("someone else's orphan does not block this address",
     run(REQ(), [], ev('enroll_attempt', 1, 'other@x.com')).length === 1);

  // The cap must count attempts, or every crashed run quietly raises the ceiling.
  ok('the daily cap counts attempts, not just confirmed outcomes',
     /daily cap/.test(refuses(REQ(), [], ev('enroll_attempt', 20, 'other@x.com'))));

  // Structure: the intent must be written BEFORE the POST, on its own branch so the POST still
  // receives the precondition output that carries the URL and body.
  const branch = wf.connections['Preconditions (fail closed)'].main[0].map((c) => c.node);
  ok('the intent branch runs before the send', branch[0] === 'Log intent (before send)', branch.join(' then '));
  ok('  and the send still hangs off the preconditions directly', branch.includes('Enroll Lead (Instantly)'));
  const w = wf.nodes.find((n) => n.name === 'Write intent');
  // No onError:continue here on purpose: a send we cannot record is a send we might repeat.
  ok('the intent write is NOT allowed to fail silently', w.onError === undefined);
  ok('  and it retries', w.retryOnFail === true);
}

ok('the request is read from the trigger by name, not from $input',
   /\$\('Called by Workflow'\)/.test(preCode));
ok('  so a Sheets read between them cannot replace it',
   !/const req = \$input/.test(preCode));

ok('the file records WHY there is no human gate here',
   /human ALREADY chose|human already chose/i.test(preCode) || /Inbox tab/.test(preCode));

const names = new Set(wf.nodes.map((n) => n.name));
for (const [src, v] of Object.entries(wf.connections))
  for (const g of v.main) for (const c of g)
    ok(`connection ${src} -> ${c.node} resolves`, names.has(c.node));

// ---------- the workflow must RETURN something its caller can read ----------
// Its terminal nodes are two Sheets writes, so without a join an Execute Workflow call gets back
// whichever ROW was written last — an Events row. The caller then cannot tell whether the lead was
// enrolled: before it refused loudly it guessed wrong and wrote every successful send back as
// needs_review, where the lead could be sent a SECOND time. Same fix as intake's result node.
{
  const res = wf.nodes.find((n) => n.name === 'Enrolment Result (to caller)');
  ok('there is a single result node', Boolean(res));
  const feeders = Object.entries(wf.connections)
    .filter(([, v]) => v.main.some((g) => g.some((c) => c.node === 'Enrolment Result (to caller)')))
    .map(([k]) => k);
  // Computed, not counted. This asserted `length === 2` and so went green while
  // `Write intent` — the write-ahead checkpoint — dangled as a SECOND terminal. On
  // 2026-09-01 VIO-run-outreach got that Events row back and refused the whole send
  // record. Every Sheets node must land here, however many there turn out to be.
  const sheetWrites = wf.nodes
    .filter((n) => n.type === 'n8n-nodes-base.googleSheets' && n.parameters.operation
                   && n.parameters.operation !== 'read')
    .map((n) => n.name);
  const missing = sheetWrites.filter((n) => !feeders.includes(n));
  ok('every Sheets write feeds the result node, so none of them can be the terminal',
     missing.length === 0, `dangling: ${missing.join(', ')}`);
  ok('  including the Leads write', feeders.includes('Write Lead Row (Leads)'));
  ok('  and the Events write', feeders.includes('Log Enrolment (Events)'));
  ok('  and the write-ahead intent checkpoint', feeders.includes('Write intent'));
  ok('it is terminal itself', !('Enrolment Result (to caller)' in wf.connections));

  const code = res.parameters.jsCode;
  // Reading $input here would get the sheet rows again — the exact mistake it exists to correct.
  ok('it reads Report by name, not $input', /\$\('Report'\)/.test(code) && !/\$input\.all\(\)/.test(code));

  const run = (reports) => new Function('$input', '$', code)(
    { all: () => [] }, () => ({ all: () => reports.map((j) => ({ json: j })) }));
  const out = run([{ email: 'a@b.com', enrolled: true, product: 'oryoniq', note: 'ok', at: 'T' }]);
  ok('a success returns enrolled:true the caller can read', out[0].json.enrolled === true);
  ok('  and carries the address', out[0].json.email === 'a@b.com');
  const noop = run([{ email: 'a@b.com', enrolled: false, note: 'already existed', at: 'T' }]);
  ok('a no-op returns enrolled:false, not a silent success', noop[0].json.enrolled === false);
  // Returning nothing would let the caller assume success.
  let threw = null;
  try { run([]); } catch (e) { threw = e.message; }
  ok('an empty report REFUSES rather than returning nothing', threw !== null && /REFUSED/.test(threw));
}

console.log(`\n[enrol-email] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
