# External audit verification — n8n claims

Verified against the code **on disk right now**, not against the audit's description of it. The
repo was under active concurrent editing for the entire duration of this verification (two other
sessions landed four commits while this was running: `6fc61bb`, `4628124`, and `49985f1` touched
`n8n-workflows/`, one of which **renamed `VIO-demo-sheet-run.json` → `VIO-run-outreach.json`**
mid-audit, same workflow id `VIOwfDsheetdemo1`). Every verdict below was re-checked against the
final state: **commit `49985f1`, working tree clean.** Where a claim names the old filename, the
finding is reported against its current file, and the rename is called out explicitly.

Method: for every claim, the node's `jsCode` (or, for pure-config claims, the node's JSON
parameters) was extracted directly from the workflow JSON and, wherever the claim was about
runtime behavior rather than static config, actually **executed** with `new Function(...)` against
constructed inputs that reproduce the scenario in question — the same technique the existing
`test-*.mjs` suites use. Scripts live in the scratchpad, not in this repo.

Verdict key: **CONFIRMED** (defect is present now) / **ALREADY-FIXED** (defect existed, current
code demonstrably does not have it) / **FALSE** (never matched the code) / **PARTLY-TRUE** (part of
the claim is fixed, part is not, or the mechanism is right but the stated symptom is wrong).

---

## Claim 1 — VIO-enrol-email: "successful enrolment recorded as needs_review — terminal node is a Sheets write so r.leads is undefined"

**Verdict: PARTLY-TRUE.** The exact symptom described (silent mislabel as `needs_review`) is
fixed. The root cause it names (a Sheets-write terminal node, not the code that builds the
`enrolled`/`leads` shape, decides what the caller actually receives) is still present, and now
very likely produces a *different, still-serious* failure: every call throws and strands the row at
`pending_approval` instead of marking it either way.

The caller is `n8n-workflows/VIO-run-outreach.json` (renamed from `VIO-demo-sheet-run.json`,
`4628124`), node **`Shape row update`** (line 242), fed by **`Enrol email (no gate — see notes)`**
(line 226, `Execute Workflow`, `mode: "each"`, target `VIOwfLenrolmail` = `VIO-enrol-email.json`):

```js
const src = $('Shape for enrolment').first().json;
const r = $input.item.json;
// ⚠️ READ THE SHAPE THE CURRENT TARGET ACTUALLY EMITS.
//
// This read `r.leads[].status`, which is VIO-agent-tool-push-instantly's shape. The enrolment call
// was repointed to VIO-enrol-email on 2026-08-30 and that workflow emits a FLAT item with an
// `enrolled` boolean and no `leads` key at all — so this silently evaluated false on every
// successful send and wrote the lead back as needs_review.
// ...
let enrolled;
if (typeof r.enrolled === 'boolean') {
  enrolled = r.enrolled;                                   // VIO-enrol-email
} else if (Array.isArray(r.leads)) {
  enrolled = r.leads.some((l) => l && l.status === 'enrolled');  // legacy gated tool
} else {
  throw new Error(`REFUSED: the enrolment step returned a shape this node does not recognise (keys: ${Object.keys(r || {}).join(', ') || 'none'}). ...`);
}
```

This is a real fix for the stated symptom: an unrecognised shape now throws instead of silently
defaulting to `needs_review`. **But the premise that a real call returns `{enrolled: boolean}` at
all is not demonstrated**, and the workflow graph says it doesn't:

`n8n-workflows/VIO-enrol-email.json` — node **`Report`** (line 156) is the one that builds
`{enrolled: created, ...}`. It is **not a terminal node**: `Report → Build Sheet Rows → Leads
rows/Events rows → Write Lead Row (Leads) / Log Enrolment (Events)`. Separately,
**`Preconditions (fail closed)`** (line 98) has a single output branch that fans out in parallel to
both `Log intent (before send) → Write intent` and `Enroll Lead (Instantly) → Report → ...` (added
in the latest commit, "Record intent before sending"). The workflow's actual leaf nodes — computed
from the connection graph, nodes with no outgoing connection — are:

```
Write Lead Row (Leads)   line 322   googleSheets, appendOrUpdate, autoMapInputData, columns: contact_email/channel_state_email/Product/sendr_page_url/opener/updated_at
Log Enrolment (Events)   line 455   googleSheets, append,         autoMapInputData, columns: timestamp/lead_email/tool/action/units/result/workflow/lead_id/est_cost_usd/source_config
Write intent             line 602   googleSheets, append,         autoMapInputData, same Events columns
```

None of the three declares a column named `enrolled`, and none declares `leads`. With
`handlingExtraData: "ignoreIt"`, any field on the input that isn't one of those declared columns
(e.g. the internal `_kind` tag `Build Sheet Rows` uses to route rows) is dropped, not echoed. There
is no join node downstream of these three the way `VIO-intake-verify-curate` has one
(`Intake Result (to caller)`) — and this codebase has already hit exactly this failure mode once:
CLAUDE.md documents that before that join node existed, "an Execute Workflow call returned
whichever branch happened to run last." `VIO-enrol-email` has the identical shape (multiple
un-joined Sheets-write leaves) and no such join.

This matters regardless of which of two n8n mechanics is the real one — whether the caller gets
only the last-executed leaf's output, or a merge of every leaf that ran: in **neither** case does
any leaf emit a literal `enrolled` boolean or `leads` array, so `r.enrolled` is not a boolean and
`r.leads` is not an array either way, and `Shape row update` hits its `throw`. Default n8n node
error behavior (no `onError`/`continueOnFail` set on `Shape row update` or on `Enrol email`) stops
the whole execution on that throw — so in a batch with more than one claimed row, the *rest* of the
batch would also be abandoned mid-run, still claimed, until an operator frees them.

The test suite does not catch this because it doesn't exercise the real shape: `test-run-outreach.mjs`
mocks `$('Shape for enrolment')` with a hand-rolled object and calls `write({ enrolled: true },
src)` directly — it never constructs the shape `VIO-enrol-email`'s own leaf nodes would actually
produce, so a passing test here doesn't prove the integration correct.

**Net effect on disk right now:** a successful enrolment is very unlikely to still land as
`needs_review` (that symptom is fixed) — it more likely throws and strands the row at
`pending_approval`, silently halting the rest of the run's batch too. That is a different bug from
the one named, not a non-bug.

---

## Claim 2 — VIO-agent-tool-push-instantly: the same r.leads shape defect, original instance

**Verdict: CONFIRMED** (present in the code; currently has no active caller anywhere in this repo,
so it is latent rather than actively firing).

`n8n-workflows/VIO-agent-tool-push-instantly.json` has the exact same architecture as claim 1, and
is in fact the workflow `Shape row update`'s comment calls "the legacy gated tool" / "VIO-agent-tool-push-instantly's shape":

- **`Report`** (line 205) builds `{ok, approved, outcome, enrolled, failed, not_enrolled, leads, ...}`.
- It is not terminal. Leaf nodes (no outgoing connection): **`Write Lead Row (Leads)`** (line 435,
  googleSheets appendOrUpdate), **`Log Enrolment (Events)`** (line 567, googleSheets append), and
  **`Not Approved (nothing sent)`** (line 220, a code node — genuinely terminal on the
  not-approved path only).
- For the interesting (approved + enrolled) path, the two leaves that fire are both Sheets writes,
  same as claim 1, with no join node reconciling them into one deterministic return shape.

So a caller that expects `{leads: [...]}` back from this workflow — which is precisely what
`Shape row update`'s `Array.isArray(r.leads)` fallback branch assumes — would not reliably get it,
for the identical structural reason as claim 1.

Practical caveat: a repo-wide search for this workflow's id (`VIOwfBpushinst1`) finds it referenced
**only inside its own file**. Neither `VIO-operator-agent.json` nor `VIO-operator-agent-v2.json`
currently wires it in as a tool (the v2 agent's only tools are `validate_config` and
`log_to_sheet`), and `VIO-run-outreach.json` now calls `VIO-enrol-email` instead (a sticky note on
that workflow explicitly says the Slack-gated path "remains on VIO-agent-tool-push-instantly...
for the agent path" as documentation, not as a wire-up). So the defect is real and unfixed in the
code, but nothing in this repo currently exercises it. CLAUDE.md's own "Next" list still has "the
remaining operator-agent tools" as unbuilt work, which is exactly where this would bite once wired.

---

## Claim 3 — VIO-demo-sheet-run: 4 per-item nodes use .first() — rows 2..N collapse onto row 1

**Verdict: CONFIRMED**, proven by execution, not just inspection. (File renamed to
`VIO-run-outreach.json`, `4628124`, same id `VIOwfDsheetdemo1` — diffed node-by-node against the
pre-rename commit: only `Pick demo rows` and `Heartbeat` changed text/copy; all four `.first()`
call sites below are byte-identical before and after the rename.)

Every code node using `.first()` in this workflow (exhaustive — grepped all code nodes' `jsCode`):

| Node | Line | Mode | `.first()` call(s) |
|---|---|---|---|
| `Shape for page` | 168 | `runOnceForEachItem` | `$('Shape for drafting').first().json` |
| `Shape for enrolment` | 204 | `runOnceForEachItem` | `$('Generate Sendr page').first().json.pageUrl`, `$('Shape for page').first().json` |
| `Shape row update` | 242 | `runOnceForEachItem` | `$('Shape for enrolment').first().json` |
| `Claim row (pending_approval)` | 383 | `runOnceForEachItem` | `$('Shape for page').first().json`, `$('Generate Sendr page').first().json.pageUrl` |

The three `Execute Workflow` nodes in the same chain (`Draft (operator agent)`,
`Generate Sendr page`, `Enrol email (no gate — see notes)`) are all correctly set to
**`mode: "each"`** — confirmed directly from the JSON. That setting only governs how *those three
nodes* consume their own input (one sub-workflow call per item, correctly paired). It does
**not** make the four nodes above safe, because none of them read their own paired input for
identity — they all reach *backwards by name* to an earlier node's full result set and take index
`[0]`, unconditionally. `Shape for page`'s own comment states the opposite and is simply wrong:

```js
// Each execution here handles one row (mode: 'each'), so first() is that row's context.
```

`mode: 'each'` is a property of the *Execute Workflow* node three steps upstream, not of `$('Shape
for drafting')`'s accessor — `.first()` always means index 0 of that node's complete output,
regardless of which item the *current* `runOnceForEachItem` iteration is on. The correct
n8n idiom for this (per-item cross-node lookup) is pairedItem-aware access, not `.first()` — and
this codebase already has a working example of the right pattern a few files over (see
`Merge verdicts` in claim 6/9 below, which builds a `Map` and looks up by join key).

**This can fire in production**: `Pick demo rows` (the node that seeds the batch) has no cap —
no `.slice()`, no limit — it returns one item per matching ready row, so any poll cycle that finds
more than one ready row at once (the schedule runs every minute; several staff-typed rows landing
in the same window is not exotic) puts more than one item through this chain.

Proof, run against the file on disk right now (`n8n-workflows/VIO-run-outreach.json`), simulating a
real 2-row batch (row 2 and row 3 both ready) and invoking each node exactly as n8n's
`runOnceForEachItem` engine would — once per item, with `$input.item` correctly scoped to the
current item and `$(...)` mocked to return each named node's **full** multi-item result:

```
=== Shape for page ===
iter 0 (n8n would call this for row 2) -> got _row=2, _email=row1@a.com
iter 1 (n8n would call this for row 3) -> got _row=2, _email=row1@a.com      <-- WRONG, should be row 3

=== Claim row (pending_approval) ===
iter 0 -> row claimed: {"row_number":2, ...}
iter 1 -> row claimed: {"row_number":2, ...}                                 <-- row 3 never claimed

=== Shape for enrolment ===
iter 0 -> contact_email being enrolled: row1@a.com, _row=2
iter 1 -> contact_email being enrolled: row1@a.com, _row=2                   <-- row 3's own lead never enrolled; row 1 proposed a 2nd time

=== Shape row update ===
iter 0 -> row_number written back: 2
iter 1 -> row_number written back: 2                                         <-- row 3's sheet row never updated
```

This is worse than "silently dropped": row 1's lead gets **re-proposed for enrolment on every
iteration** of the batch (once per ready row that poll found), while every other row in the batch
is never claimed, never drafted with its own content, never enrolled, and never written back —
it is left exactly as it was, to be picked up (and mis-processed the same way) again next minute.

---

## Claim 4 — `Shape for page`: page gets the template's placeholder opener + no attribution email (_opener/_email vs opener/contact_email)

**Verdict: CONFIRMED.**

`VIO-run-outreach.json`, node **`Shape for page`** (line 168) sends the Sendr-page sub-workflow an
object whose only opener/email fields are underscore-prefixed:

```js
return { json: {
  product: src.source_config,
  first_name: src._first_name, title: src._title,
  company: src._company, company_domain: src._domain || '',
  _row: src._row, _email: src._email, _first_name: src._first_name,
  _title: src._title, _company: src._company,
  _opener: typeof drafted.opener === 'string' ? drafted.opener.trim() : '',
  _email_draft: typeof drafted.email === 'string' ? drafted.email : '',
  ...
} };
```

There is no `opener` key and no `contact_email` key anywhere in this object — only `_opener` and
`_email`. This flows unchanged through `Execute Workflow` node `Generate Sendr page`
(`workflowId: VIOwf6sendrgen01`, confirmed matching `VIO-sendr-generate-page.json`'s own `id`) into
that sub-workflow's `Called by Workflow` trigger (passthrough) → `Authenticate (fail-closed)`
(`return { json: item.body || item }` — for a direct Execute Workflow call, `item.body` is
`undefined`, so it falls through to `item` unchanged, no renaming) → `Route Product to Template`
(`const lead = $input.item.json; ... return { json: { ok: true, ...route, lead } }` — also
unchanged, no renaming).

`VIO-sendr-generate-page.json`, node **`Build Page Request`** (line 118) is what actually reads the
lead's opener and email — by the **unprefixed** names:

```js
const route = $('Route Product to Template').first().json;
const lead = route.lead;
...
const pool = {
  ...
  opener: lead.opener, personalization: lead.opener,
  ...
};
...
attributes: {
  ...
  leadEmail: lead.contact_email || '',
  ...
}
```

`lead.opener` and `lead.contact_email` are both `undefined` given what `Shape for page` actually
sends. Consequence, directly from the code: `pool.opener` is `undefined`, so
`variablesValues[v.tag] = pool[v.tag] || v.fallback || v.exampleValue || ''` falls through to the
**template's own fallback/placeholder** for the opener variable — the AI-written line never
reaches the page. And `attributes.leadEmail` becomes `''`. The same node's own comment explains why
that specifically matters: `leadEmail` is "the ONLY thing that lets VIO-sendr-events turn an
anonymous 'page 123 was viewed' into 'Pratik at VisioneerIT opened his page'" — so this also breaks
page-view attribution, not just opener copy.

---

## Claim 5 — VIO-sheet-audit: 8 chained Sheets reads, no executeOnce — multiplies into ~1,440 calls

**Verdict: CONFIRMED.**

`n8n-workflows/VIO-sheet-audit.json` chains 9 Google Sheets read nodes in a straight line —
`Read Leads → Read Suppression → Read Events → Read Costs → Read Segments → Read Demo → Read Inbox
→ Read Pipeline → Read System → Report` — matching the claim's "8 chained" count if `Read Leads` is
the seed (fed by the single authenticated webhook item) and the other 8 are the ones actually put
at risk of multiplying by what `Read Leads` returns. Checked every one of the 9:

```
Read Leads        operation=read  executeOnce=None
Read Suppression  operation=read  executeOnce=None
Read Events       operation=read  executeOnce=None
Read Costs        operation=read  executeOnce=None
Read Segments     operation=read  executeOnce=None
Read Demo         operation=read  executeOnce=None
Read Inbox        operation=read  executeOnce=None
Read Pipeline      operation=read  executeOnce=None
Read System        operation=read  executeOnce=None
```

None has `executeOnce` set, none has a filter — every one is a plain unfiltered "read whole tab."
By standard n8n node semantics, a node without `executeOnce: true` runs once **per input item**,
not once per execution. `Read Leads` returns one item per Leads row (call it L). Fed L items,
`Read Suppression` — absent `executeOnce` — runs L times, each call re-reading the entire
Suppression tab (S rows), producing L×S items. `Read Events`, fed L×S items, runs L×S times,
producing L×S×E items, and so on multiplicatively through all 8 downstream reads. This compounds
faster than a linear "~1,440" estimate for anything but very small tabs — the claim's number is a
plausible rough figure for modest row counts, but the architectural defect (every downstream read
in the chain is exposed to fan-out because none is pinned to run once) is confirmed exactly as
described.

---

## Claim 6 — VIO-inbox-mapper: success branch can't mark rows — _ok dropped, Shape Inbox status has no upstream ref

**Verdict: ALREADY-FIXED** (or never matched current code — either way, this is not the state on
disk).

`n8n-workflows/VIO-inbox-mapper.json`, node **`Merge verdicts`** (line 347, `runOnceForAllItems`)
explicitly builds and returns `_ok`:

```js
const outcome = v ? R(v.outcome) : 'no_verdict';
const imported = outcome === 'pass' || outcome === 'needs_review';
out.push({ json: {
  row_number: meta.row_number === undefined ? null : meta.row_number,
  contact_email: sent.contact_email || '',
  _ok: imported,
  ...
} });
```

— joined correctly on the Inbox row number via a `Map` built from `$input.all()` (the verdicts
intake echoed back) and looked up per item from `$('Shape Lead row').all()` (this workflow's own
memory of what it sent) — the pairedItem-safe pattern that claim 3 and claim 9's nodes should have
used instead of `.first()`.

Node **`Shape Inbox status`** (line 230, `runOnceForEachItem`) reads its own directly-paired input,
not a name-reference: `const r = $input.item.json; const ok = r._ok === true;` — this is exactly
the correct, safe accessor (it is fed directly in-line by `Merge verdicts` on the success path, and
by `Usable row?`'s false branch on the rejected-at-mapping path, so `$input.item` is always the
right item either way).

Proved by extracting both functions and actually running them in sequence — `Merge verdicts` fed a
simulated intake result (`inbox_row: 5, outcome: 'pass'`) plus the matching `Shape Lead row` memory,
then its output item piped into `Shape Inbox status`:

```
Merge verdicts output: {"row_number":5,"contact_email":"a@x.com","_ok":true,"_verify_outcome":"pass", ...}
Shape Inbox status output: {"row_number":5,"status":"mapped","notes":"Address verified (safe)","mapped_lead_id":"a@x.com"}
```

`status: "mapped"` — a genuinely successful row is correctly marked. `_ok` is not dropped and
`Shape Inbox status` has a working, correct upstream reference. This whole reconciliation
mechanism (`inbox_row` echo, `_ok`, the `Map`-based join) is exactly the kind of fix CLAUDE.md
documents landing on 2026-08-29/30 for this workflow; the claim describes a state this code no
longer has.

---

## Claim 7 — VIO-operator-agent-v2 log_to_sheet: $fromAI('lead_id', "The lead's id…") — apostrophe = syntax error

**Verdict: CONFIRMED**, and it is not limited to `lead_id` — the identical defect is also present
in `lead_email`.

`n8n-workflows/VIO-operator-agent-v2.json`, node **`log_to_sheet`** (`googleSheetsTool`, id
`vio-wf7-tool-logsheet`, name declared at line 260), `parameters.columns.value`:

```
line 243: "lead_id":    "={{ $fromAI('lead_id', 'The lead's id if this row is about one specific lead, else an empty string', 'string') }}",
line 244: "lead_email": "={{ $fromAI('lead_email', 'The lead's email if this row is about one specific lead, else an empty string', 'string') }}",
```

Both description strings are single-quote-delimited JS string literals containing an unescaped
apostrophe (`lead's`), which terminates the string literal early — this is invalid JavaScript,
independent of any n8n-specific parsing quirk. Verified by extracting the literal expression body
of every field in this node's `columns.value` and compiling each one with `new Function`:

```
timestamp:     COMPILES OK   | $now.toISO()
lead_id:       *** SYNTAX ERROR *** (SyntaxError: missing ) after argument list)
lead_email:    *** SYNTAX ERROR *** (SyntaxError: missing ) after argument list)
tool:          COMPILES OK
action:        COMPILES OK
units:         COMPILES OK
est_cost_usd:  COMPILES OK   (uses an em-dash "—", not an apostrophe — no issue)
result:        COMPILES OK
source_config: COMPILES OK
```

Every other `$fromAI(...)` description in the same node compiles cleanly — the pattern is specific
to the two fields whose description text happens to contain a possessive apostrophe. Since n8n
evaluates each mapped column's expression when the node runs, and `lead_id`/`lead_email` are core
fields on essentially every audit row the agent would try to log, this confirms the claim: the
agent's only Sheets-write tool is broken for real use, not just in a corner case.

---

## Claim 8 — VIO-sendr-generate-page: only the first lead in a batch gets a page

**Verdict: CONFIRMED**, proven by execution. Currently not actively triggering via the only in-repo
caller (which always sends one lead per call), but the defect is real in the code and the
workflow's own webhook is exposed to it directly.

`n8n-workflows/VIO-sendr-generate-page.json`, node **`Build Page Request`** (line 118) is
`mode: "runOnceForAllItems"` — it runs **once per execution**, not once per lead — and takes the
lead identity from `.first()`:

```js
const route = $('Route Product to Template').first().json;
const lead = route.lead;
...
return [{ json: { body, ... } }];   // exactly one item, always
```

`Route Product to Template` upstream is `runOnceForEachItem`, so for a genuine multi-lead batch it
produces one routed item per lead — but `Build Page Request` collapses all of them to `.first()`
and returns exactly one output item regardless. Proved by feeding it two routed leads (Alice,
Bob) exactly as `Route Product to Template` would produce them:

```
Number of output items from Build Page Request for a 2-lead batch: 1
leadEmail actually sent to Sendr: alice@acme.com   (Bob, the 2nd lead, never appears anywhere in the output)
```

`Report Page URL` downstream (also `runOnceForAllItems`) is consistent with the same one-page-only
assumption (`$('Build Page Request').first().json`, `$input.first().json`).

Caveat on live impact: a repo-wide search for this workflow's id (`VIOwf6sendrgen01`) finds exactly
one caller — `VIO-run-outreach.json`'s `Generate Sendr page` node, which is correctly set to
`mode: "each"` (one sub-workflow call per lead, so each call's own batch is always exactly 1). So
this defect is not currently firing through that path. It is directly reachable, unguarded, through
this workflow's own `Generate Page Webhook` trigger if anything ever posts more than one lead in a
single call — nothing in the code checks or refuses a multi-item batch.

---

## Claim 9 — VIO-inbox-mapper: AI-mapping branch uses .first() in a per-item node

**Verdict: CONFIRMED**, proven by execution, and worse in effect than a simple drop.

Exhaustive search of every code node's `jsCode` in `VIO-inbox-mapper.json` for `.first()` finds
exactly one hit: node **`Apply AI mapping`** (line 168, `runOnceForEachItem`):

```js
const src = $('Shape AI prompt').first().json;
const r = Object.assign({}, src);
...
const val = clean((r._raw || {})[header]);   // header VALUES come from src, i.e. row 1, always
...
return { json: Object.assign({}, r, { _problems, _ok, _llm_applied, _llm_used: true }) };
```

`src` (always index 0 of `Shape AI prompt`'s full output) supplies `row_number`, `_raw` (the row's
actual cell values), and every other base field — the current iteration's own OpenAI response
(`$input.item.json`) only supplies the proposed header→field *mapping names*, which then get
applied to **row 1's** `_raw` values regardless of which row's AI response is actually being
processed. This is fed by `Map remaining headers (AI)` (an `openAi` node, default per-item mode),
which itself is fed by `Shape AI prompt` (`runOnceForEachItem`) — so a poll cycle where more than
one row simultaneously needs AI mapping (unrecognised headers *and* a still-missing required field)
puts more than one item through this exact path.

Proved by simulating two such rows in the same cycle — row 10 ("Jane"/JaneCo) and row 11
("John"/JohnCo), both needing AI mapping, each with its own correctly-paired OpenAI response:

```
iteration 0 (Jane's own response) -> row_number: 10, contact_email: jane@janeco.com, company: JaneCo
iteration 1 (this is really John's AI response, row 11) -> row_number: 10, contact_email: jane@janeco.com, company: JaneCo
```

Both iterations produce **identical output** — Jane's row, twice. This is not merely "row 2 is
dropped": it's a Frankenstein merge where a later row's AI mapping outcome is discarded and an
earlier row's full identity is written a second time — row 10 gets claimed/processed twice, row 11
never gets its own data at all and is left exactly as it was for the next poll to mis-handle again.

Contrast: `Merge verdicts` in the same workflow (claim 6) solves the identical "match a later node's
per-item output back to an earlier node's per-item output" problem correctly, with a `Map` keyed by
join id and a loop over `.all()` — proving the correct pattern was available in this same file and
simply wasn't used here.

---

## Claim 10 — VIO-sheet-audit: missing tab reported as existing with headers: ['error']

**Verdict: ALREADY-FIXED.**

`n8n-workflows/VIO-sheet-audit.json`, node **`Report`** (line 260) has an explicit guard, with a
comment describing this exact prior failure, before any header computation runs:

```js
// A tab that does not exist comes back as a single item carrying an error, because every read
// is onError:continueRegularOutput + alwaysOutputData. Do not report that as a column named
// "error".
const errored = rows.length === 1 && rows[0] && typeof rows[0].error !== 'undefined'
                && Object.keys(rows[0]).filter((k) => k !== 'row_number').length === 1;
if (errored) {
  const msg = String(rows[0].error && (rows[0].error.message || rows[0].error) || rows[0].error || '');
  const throttled = /quota|too many requests|rate limit|RESOURCE_EXHAUSTED|429/i.test(msg);
  out[tab] = throttled
    ? { status: 'throttled', note: '...quota was exceeded — this says NOTHING about whether the tab exists...', error: msg.slice(0, 300) }
    : { status: 'missing', note: '...the tab may genuinely not exist', error: msg.slice(0, 300) };
  continue;
}
```

All 9 read nodes are confirmed `onError: "continueRegularOutput"` + `alwaysOutputData: true`,
matching what the guard assumes. Proved by running the actual `Report` function against a
simulated mixed result set (one genuinely-missing tab, one throttled tab, one healthy tab, several
empty-but-real tabs):

```
"Suppression": { "status": "missing", "note": "the read failed and it does not look like throttling — the tab may genuinely not exist", "error": "Sheet named 'Suppression2' was not found" }
"Events":      { "status": "throttled", "note": "the Google Sheets read quota was exceeded — this says NOTHING about whether the tab exists...", "error": "Quota exceeded ... 429 RESOURCE_EXHAUSTED" }
```

Neither ever reports `status: "ok"` / `headers: ["error"]`. The fix goes further than the claim
even asks: it also distinguishes a genuinely-missing tab from a rate-limited read (a real, separate
bug the same shape would otherwise cause — 9 reads per run is most of Google's 60/min per-user
quota on its own).

---

## Claim 11 — Sheets writes after the paid call have no retryOnFail

**Verdict: ALREADY-FIXED, comprehensively.**

Every single Google Sheets node in every `VIO-*.json` workflow file in this repo was enumerated —
not just writes downstream of a paid call, all of them, reads included, as the strongest form of
the check:

```
Total googleSheets nodes across all 20 VIO-*.json files: 48
Missing retryOnFail: 0
```

Spot-checked the two most claim-relevant cases directly: `VIO-enrol-email.json`'s three writes
after the Instantly POST (`Write Lead Row (Leads)`, `Log Enrolment (Events)`, `Write intent`, lines
322/455/602) all carry `retryOnFail: true`; `VIO-intake-verify-curate.json`'s `Write Lead Row
(Leads)` and `Log Reoon Call (Events)` (after the Reoon paid call) do too. No exceptions found
anywhere in the repo. Re-verified at the final synced commit (`49985f1`) — unchanged.

---

## Claim 12 — Dead src._page_pending line writes a blank URL (Claim row / pending_approval)

**Verdict: ALREADY-FIXED**, with one caveat: the fixed node is the *same* node broken by claim 3.

`VIO-run-outreach.json`, node **`Claim row (pending_approval)`** (line 383). Its own comment names
the exact prior bug and the current code no longer has it:

```js
// This node also wrote `src._page_pending`, a field 'Shape for page' has never produced — so the
// sheet's sendr_page_url column was being filled with an empty string on every run.
const src = $('Shape for page').first().json;
const page = $('Generate Sendr page').first().json.pageUrl || '';
return { json: {
  row_number: src._row,
  channel_state_email: 'pending_approval',
  ...
  sendr_page_url: page,
  ...
} };
```

A whole-file search confirms exactly one remaining occurrence of the string `_page_pending` in
`VIO-run-outreach.json`, and it is inside this comment describing the historical bug — there is no
executable reference to it left. `sendr_page_url` is now populated from the dedicated `page`
variable.

**Caveat:** `Claim row (pending_approval)` is one of the four nodes proven broken under claim 3.
The specific defect named in claim 12 (a dead field that always wrote blank) is genuinely gone —
but in any batch with more than one ready row, this node's `.first()` calls still mean
`sendr_page_url` (and every other field it writes) comes from row 1, not the row actually being
processed, for exactly the reasons demonstrated in claim 3. Fixing the named symptom did not fix
the node's remaining single-row assumption.

---

# Offline test suites

All suites run from `n8n-workflows/` (`for t in test-*.mjs; do node "$t"; done`) plus the two
Python suites, against the same synced commit (`49985f1`, clean tree).

| Suite | Result |
|---|---|
| test-ask-human-gate.mjs | 116 passed, 0 failed |
| test-chain-integration.mjs | 76 passed, 0 failed |
| test-costs-rollup.mjs | 52 passed, 0 failed |
| test-enrol-email.mjs | 109 passed, 0 failed |
| test-inbox-mapper.mjs | 135 passed, 0 failed |
| test-instantly-events.mjs | 71 passed, 0 failed |
| test-intake-callable.mjs | 125 passed, 0 failed |
| test-intake-gate.mjs | 84 passed, 0 failed |
| test-operator-agent-lead.mjs | 369 passed, 0 failed |
| test-operator-plan.mjs | 26 passed, 0 failed |
| test-push-instantly-gate.mjs | 318 passed, 0 failed |
| test-reply-brain.mjs | 10 passed, 0 failed |
| test-reply-sheet-writes.mjs | 132 passed, 0 failed |
| test-reveal-gate.mjs | 235 passed, 0 failed |
| test-run-campaign.mjs | 62 passed, 0 failed |
| test-run-outreach.mjs (formerly test-demo-sheet-run.mjs) | 167 passed, 0 failed |
| test-segment-scoring.mjs | 71 passed, 0 failed |
| test-sendr-events.mjs | 32 passed, 0 failed |
| test-sheets-resilience.mjs | 160 passed, 0 failed |
| test-source-leads.mjs | 76 passed, 0 failed |
| test-upstream-reads.mjs | 18 passed, 0 failed |
| **Subtotal, 21 .mjs suites** | **2,444 passed, 0 failed** |
| n8n-workflows/test-sync-routes.py | 41 passed, 0 failed |
| reach-engine/test_sigv4.py | 4 passed, 0 failed |
| **Grand total, 23 suites** | **2,489 passed, 0 failed** |

Every suite reports zero failures. That is not the same claim as "no bugs remain" — claims 1, 3, 8,
and 9 above are all real, currently-present defects that these same passing suites do not catch,
specifically because each suite's mocks feed the node under test an idealized shape (a single
`.first()`-friendly item, or the *intended* return shape of a sub-workflow rather than what its
actual terminal node emits) rather than a reconstruction of what n8n would really hand it in a
multi-item batch or a multi-leaf sub-workflow return. Passing here means the code does what its
test expects, not that the test's expectation matches production behavior.

---

# Summary

| # | Claim | Verdict |
|---|---|---|
| 1 | VIO-enrol-email: success recorded as needs_review, r.leads undefined | PARTLY-TRUE — symptom fixed, root cause (Sheets-write terminal node) unfixed, now throws instead |
| 2 | VIO-agent-tool-push-instantly: same defect, original instance | CONFIRMED — present, currently uncalled anywhere in-repo |
| 3 | VIO-demo-sheet-run: 4 nodes use .first(), rows 2..N collapse | CONFIRMED — proven by execution; Execute Workflow `mode:'each'` is correct and irrelevant to the bug |
| 4 | Shape for page: placeholder opener, no attribution email | CONFIRMED — `_opener`/`_email` produced, `opener`/`contact_email` consumed |
| 5 | VIO-sheet-audit: 8 chained reads, no executeOnce | CONFIRMED — 9 total reads, 8 downstream of the seed, none pinned |
| 6 | VIO-inbox-mapper: success branch can't mark rows | ALREADY-FIXED — proven by execution, `_ok` present and correctly consumed |
| 7 | log_to_sheet: apostrophe syntax error | CONFIRMED — proven by compilation; also affects `lead_email`, not just `lead_id` |
| 8 | VIO-sendr-generate-page: only first lead gets a page | CONFIRMED — proven by execution; not firing via the sole in-repo caller today |
| 9 | VIO-inbox-mapper: AI-mapping branch .first() in per-item node | CONFIRMED — proven by execution; produces a cross-row data merge, not just a drop |
| 10 | VIO-sheet-audit: missing tab reported as headers:['error'] | ALREADY-FIXED — proven by execution, now reports missing/throttled |
| 11 | Sheets writes after paid call have no retryOnFail | ALREADY-FIXED — 48/48 googleSheets nodes repo-wide carry retryOnFail |
| 12 | Dead src._page_pending writes blank URL | ALREADY-FIXED — but same node still broken by claim 3 |
