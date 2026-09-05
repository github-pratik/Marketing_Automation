# Failure-mode audit — Inbox → Leads → send chain

Scope: the live path `Inbox tab -> VIO-inbox-mapper (2 min poll) -> VIO-intake-verify-curate
(Reoon) -> Leads tab -> VIO-run-outreach (3 min poll) -> VIO-operator-agent (OpenAI) ->
VIO-sendr-generate-page (Sendr) -> VIO-enrol-email (Instantly, no human approval)`.

Method: read every node's `jsCode`, `onError`, `retryOnFail`, and the `connections` graph directly
out of the deployed-JSON backups in this folder (not re-typed, not assumed). No SSH, no live
n8n access, no writes to the Sheet — every claim below is either (a) cited to a specific file +
node + code, or (b) marked **UNVERIFIED** with the experiment that would settle it. This file adds
no fixes — it is a report only.

**Read this first — one root cause behind four of the eight questions.**
`VIO-run-outreach` claims a Leads row (`channel_state_email: 'pending_approval'`) BEFORE the
expensive work (OpenAI draft, Sendr page, Instantly enrol) starts — deliberately, to stop the
double-draft bug the repo already hit once (see Q7). But nothing un-claims the row if anything
downstream throws. `pending_approval` is not in `Pick demo rows`' `READY` set
(`VIO-run-outreach.json`, node `Pick demo rows`: `READY = new Set(['', 'not_sent', 'approved'])`),
so a row that reaches `pending_approval` and then hits *any* unhandled error is never picked up
again by the schedule. The only way out is a human running `VIO-sheet-repair`'s `approve` action
with `force: true` (`VIO-sheet-repair.json`, node `Mark approved`). That is a real, working escape
hatch — but it is manual, and (see Q4/Q6 below) it cannot tell "drafted but never sent" apart from
"sent, but the write that would have said so never landed." Questions 2, 3, 5, and 6 are all
instances of this one structural gap.

---

## Q1 — Reoon times out / 500s / returns a malformed body

**Verdict: SAFE**, verified in code, including the specific claim in CLAUDE.md that a failed
verification leaves the Inbox row unclaimed.

- `VIO-intake-verify-curate.json`, node `Reoon Verify (power)`: `retryOnFail: true, maxTries: 3,
  waitBetweenTries: 3000, onError: "continueErrorOutput"`. The node's own `notes` field states why:
  "one lead whose verification errors after 3 retries would abort the whole run and discard every
  lead that already succeeded" if this weren't set. A timeout, a 5xx, or a response that fails the
  node's JSON parse (no `responseFormat` override, so n8n auto-parses) **all** land in the error
  output — there is no code path that treats a Reoon failure as a pass.
- The error output goes to `Reoon Call Failed (lead left unprocessed)` (`n8n-nodes-base.noOp`,
  terminal — no Sheets write of any kind).
- A malformed-but-parseable body (e.g. missing `status`) does not throw at all — `Classify (pass /
  drop / needs_review)`'s own code defaults `status = String(r.status || 'unknown').toLowerCase()`,
  and anything not in `{safe, valid}` / `{invalid, spamtrap}` / `disposable` falls into the `else`
  branch: `action = 'needs_review'`. A malformed body can never silently read as verified.
- The caller-facing join, `Intake Result (to caller)`, distinguishes this exact case: for a lead the
  gate passed to Reoon but that never reached `Classify`, it emits `outcome: 'verify_failed',
  reason: 'Reoon call did not return a verdict', verified: false` (comment: "Reporting this as a
  skip would be a lie — the lead is unprocessed and should be retried, not written off").
- `VIO-inbox-mapper.json`, node `Shape Inbox status`, reads that outcome and computes
  `const retry = outcome === 'verify_failed' || outcome === 'no_verdict'; status: retry ? '' :
  (...)`. Blank `status` is the claim marker (`Read Inbox` picks up rows where `status` is empty),
  so the row is genuinely retried on the next 2-minute poll, exactly as CLAUDE.md and the README
  claim.

**Residual, lower-severity risk (not what Q1 asked, but found while tracing it):** the two Sheets
reads in intake (`Read Leads (dedupe)`, `Read Suppression`) and the two writes (`Write Lead Row
(Leads)`, `Log Reoon Call (Events)`) have `retryOnFail: true, maxTries: 3` but **no `onError`
override** — a Sheets 429/500 that survives 3 retries throws normally, which (since `Verify + curate
(intake)` in `VIO-inbox-mapper.json` also has no `onError`) kills the *entire batch's* execution, not
just the one lead. Because both `errorWorkflow` settings point at `VIOwfEerroralert`
(`VIO-inbox-mapper.json` / `VIO-intake-verify-curate.json` `settings.errorWorkflow:
"VIOwfEerroralert"`), this is not silent — a Slack alert fires. Recovery is automatic (every Inbox
row in that cycle is still blank, since `Mark Inbox row` never ran, so the whole batch retries next
cycle) with one edge case: if the failure happens on `Log Reoon Call (Events)` *after* `Write Lead
Row (Leads)` already committed, the lead **is** correctly in `Leads`, but the batch-level exception
means `Intake Result (to caller)` never runs, so `VIO-inbox-mapper` reports nothing for that row and
leaves it unclaimed too. The retry on the next cycle re-verifies via `Gate (dedupe + suppression)`,
finds the email already in `Leads`, and reports `outcome: 'skipped', reason: 'duplicate'` — the
Inbox row ends up marked `needs_review` / "we already hold this lead" even though it actually
succeeded. Cosmetically wrong, not a lost or duplicated lead (`Write Lead Row (Leads)`'s
`appendOrUpdate` operation is keyed on `contact_email`, so a genuine second attempt would update the
same row, not create a duplicate one).

---

## Q2 — OpenAI errors, an empty choice, or a refusal string

**Verdict: mostly SAFE at the send boundary, but LOST at the row level** (see root cause above).

- `VIO-operator-agent.json`, node `Assemble + Report`, has its own defensive check:
  `if (!choice || !choice.message || typeof choice.message.content !== 'string') { throw new
  Error('personalize returned no message content...'); }`. This catches a missing `choices` array,
  a missing `message`, or a non-string `content` (e.g. a `content_filter` finish reason with
  `content: null`).
- **Gap found in that same check:** an empty string (`content: ""`) *passes* it —
  `typeof "" === 'string'` is true — and `opener = "".trim().replace(...) = ""`. The email gets
  built as `Hi ${first_name},\n\n\n\n${offer}...` with a blank paragraph, and `Assemble + Report`
  reports it as ordinary output, no error, no `email_complete: false` flag for this reason (that
  flag exists only for the separate "no Sendr URL yet" case).
- That gap **is caught later**, not by accident: `VIO-enrol-email.json`, node `Preconditions (fail
  closed)`: `const opener = String(l.opener || '').trim(); if (opener.length < 20) throw new
  Error('REFUSED: ... has no usable opening line (0 chars).')`. A banned-pattern list
  (`/\{\{/, /lorem ipsum/i, /as an ai/i, /placeholder/i, /\bnull\b/`, etc.) also catches a leaked
  chatbot preamble or an unrendered merge tag. **So no lead is WRONGLY SENT with an empty or
  garbage opener** — this is a real, working gate.
- `personalize` (the OpenAI node itself) has `retryOnFail: true, maxTries: 2`; a genuine API error
  (429, 500, or a hard content-policy refusal returned as an HTTP error rather than a normal
  completion) throws after 2 tries with no `onError` override.
- **The LOST part:** by the time either the `Assemble + Report` throw or the `Preconditions` throw
  fires, `Row usable?`'s parallel branch has already run `Claim row early` →
  `Claim early in sheet`, writing `channel_state_email: 'pending_approval'`
  (`VIO-run-outreach.json`, node `Claim row early`). Since `Draft (operator agent)` and `Enrol
  email (no gate — see notes)` are both plain `executeWorkflow` nodes with no `onError`, the throw
  propagates and kills this row's chain before `Shape row update` / `Write result back` ever run.
  The row sits at `pending_approval` — not in `READY` — forever, until a human runs
  `VIO-sheet-repair`'s `approve` with `force: true`. No email was sent (SAFE on that axis), but the
  lead is functionally dropped from the pipeline with only a Slack error alert as the trail.

---

## Q3 — Sendr returns 200 with no `pageUrl`, or a page that later fails asset rendering

**Verdict: SAFE at the send boundary (no broken CTA is ever mailed), LOST at the row level** — same
mechanism as Q2.

- `VIO-sendr-generate-page.json`, node `Report Page URL`: `return [{ json: { ok: true, pageUrl:
  res.pageUrl || null, ... } }]`. **`ok: true` is hardcoded** — it does not reflect whether
  `pageUrl` actually came back. A Sendr 200 with a missing `pageUrl` is reported as `ok: true,
  pageUrl: null`.
- `VIO-run-outreach.json`, node `Claim row (pending_approval)`: `const page =
  $('Generate Sendr page').first().json.pageUrl || '';` — silently becomes `''`. This gets written
  to the `sendr_page_url` column while `channel_state_email` is unconditionally set to
  `pending_approval` in the same write.
- The empty URL **is caught** before any send: `VIO-enrol-email.json`, `Preconditions (fail
  closed)`: `const page = String(l.sendr_page_url || '').trim(); if (!/^https?:\/\//.test(page))
  throw new Error('REFUSED: ... has no Sendr page URL...')`. No lead is enrolled with a broken or
  blank CTA.
- Same stranding as Q2 follows: the row was already claimed to `pending_approval` by `Claim row
  early` before Sendr ever ran, so the `Preconditions` throw leaves it permanently parked.
- **Asset-only failure (GIF/audio render fails after a valid `pageUrl` was returned):** this is
  explicitly handled, and correctly, by a *different* workflow. `VIO-sendr-events.json`'s
  `Classify Engagement` splits `asset_warning` (a usable `pageUrl` plus a failed optional asset —
  "this link works, send it") from `error` (no usable page). Per the README, this was verified live:
  a page whose GIF task failed still returns `HTTP 200` and renders. Since the CTA link itself
  works, a lead enrolled with such a page is not "wrongly sent" — it is SAFE, just cosmetically
  degraded, and `asset_warning` routes to log-only (`Worth a human?` IF, false branch), so no one is
  actively told to go fix the page. That is a minor visibility gap, not a data-loss or send-integrity
  one.

---

## Q4 — Instantly returns 200 for a lead it did not create (workspace-wide `skip_if_in_campaign`)

**Verdict: the send-safety part is SAFE and fixed in code. A separate, real bug means the Sheet then
lies about the outcome — filed as its own top-5 item below.**

- `VIO-enrol-email.json`, node `Report`, has the exact guard CLAUDE.md/README describe: `const
  returnedCampaign = String(res.campaign || res.campaign_id || ''); const created = Boolean(res.id)
  && returnedCampaign === String(a.campaign_id || '');` — only counted as `enrolled` when Instantly's
  own response confirms the lead landed in the *requested* campaign, not merely that a 200 came
  back. The node's comment states the exact prior incident this replaced ("A previous version of
  this pipeline reported 'enrolled: 2' while the campaign held zero"). `VIO-agent-tool-push-
  instantly.json`'s `Report` node carries an equivalent, more detailed version of the same guard.
  `Build Sheet Rows` in `VIO-enrol-email.json` writes a `Leads` row **only** when `r.enrolled` is
  true, so a false "enrolled" from a workspace-wide skip cannot land in the sheet as a lead row.
- **The bug this uncovered:** `VIO-run-outreach.json`, node `Shape row update` (the node that
  writes the *final* `channel_state_email` back onto the `Leads` row after `Enrol email (no gate —
  see notes)` returns): `const enrolled = Array.isArray(r.leads) && r.leads.some((l) => l.status
  === 'enrolled'); ... channel_state_email: enrolled ? 'enrolled' : 'needs_review'`. This reads
  `r.leads[].status`, which is the shape `VIO-agent-tool-push-instantly.json`'s `Report` node
  produces (verified directly — that node returns `{ json: { ..., leads: [{ email, status:
  'enrolled' | 'failed' | ... }] } }`). **`VIO-enrol-email` never produces a top-level `leads`
  array** — its own `Report`/`Build Sheet Rows` chain returns flat per-lead items keyed by
  `_kind`/`contact_email`/`channel_state_email`, with no `leads` wrapper anywhere in the file
  (confirmed by reading every node in `VIO-enrol-email.json`). `Enrol email (no gate — see notes)`
  was repointed from `VIO-agent-tool-push-instantly` to `VIO-enrol-email` on 2026-08-30 (the node's
  own rename to "no gate — see notes" documents this), but `Shape row update` was not updated to
  match the new sub-workflow's output shape.
- Net effect: `Array.isArray(r.leads)` is `undefined`/`false` on every call through this path, so
  `enrolled` evaluates `false` **unconditionally**, regardless of what actually happened. **Every
  lead that is genuinely, successfully enrolled and mailed through this path gets written back to
  `Leads` as `channel_state_email: 'needs_review'`** — the opposite of Q4's classic failure mode
  (claiming a send that didn't happen), but arguably worse for this system's design, where "Google
  Sheets is the dashboard": the sheet actively misreports every real send as unsent.

---

## Q5 — Google Sheets rate-limits or fails mid-chain

**Verdict: split by where in the chain it happens. Before any external send: SAFE (self-heals, at
worst wastes an OpenAI/Sendr call, and retries are now in place — see note below). After Instantly's
HTTP call succeeds: the dangerous case, folded into Q6 below since the mechanism is identical.**

**⚠️ Note on timing — the repo changed under this audit.** The first pass through this question found
every Sheets node in `VIO-run-outreach.json` and `VIO-enrol-email.json` with no `retryOnFail` at
all (confirmed by reading each node's JSON directly), while `VIO-intake-verify-curate.json`'s
equivalents already retried 3x. Re-checking those same files while finishing this report, they now
**all** retry (`retryOnFail: true`, `maxTries: 4`, `waitBetweenTries: 5000`) — this repo was being
edited live, outside this audit, while it was in progress (a new file,
`n8n-workflows/test-sheets-resilience.mjs`, appeared with a comment dated 2026-08-30: "Hit live
2026-08-30 during a load test: six tabs that demonstrably existed were reported as 'no such tab'" —
the exact gap this section flagged). This section reports the **current** (post-fix) state; the
git working tree still carries these changes uncommitted at the time of writing, so `git diff` on
the files listed below will show them.

Current retry configuration, traced node by node (re-verified against the live files):

| Node | File | `retryOnFail` | `maxTries` / wait | `onError` |
|---|---|---|---|---|
| `Read Leads (dedupe)`, `Read Suppression`, `Write Lead Row (Leads)`, `Log Reoon Call (Events)` | `VIO-intake-verify-curate.json` | `true` | 3 / 2000ms | none (default: stop) |
| `Read Leads`, `Claim early in sheet`, `Claim row in sheet`, `Write result back` | `VIO-run-outreach.json` | `true` | 4 / 5000ms | none (default: stop) |
| `Read Suppression`, `Read Events`, `Write Lead Row (Leads)`, `Log Enrolment (Events)` | `VIO-enrol-email.json` | `true` | 4 / 5000ms | none (default: stop) |

Every Sheets node in this chain now retries a transient failure. **None of them has an `onError`
override**, though — a 429 that survives 4 tries × 5s (roughly 20+ seconds of backoff) still throws
normally and stops the execution exactly as before; retries make the failure mode rarer, not
different in kind. The analysis below is unchanged by the fix, only less likely to trigger:

- **Failure before `Claim row (pending_approval)` commits** (i.e. at `Claim early in sheet`, now
  after 4 retries): the row was never actually written to, so it is still blank/`not_sent` in the
  live sheet. Next poll picks it up again cleanly. **SAFE**, just delayed.
- **Failure at `Claim row in sheet` (after Draft + Sendr already ran)**: the row is *not* updated
  (write never landed even after retries), so it's still in the `READY` state from before. Next poll
  re-drafts (wastes an OpenAI call) and re-generates a Sendr page (wastes Sendr quota, orphans the
  first page — no code anywhere deletes or reuses it). **SAFE** from a duplicate-send standpoint,
  wasteful in practice.
- **Failure at `Write result back` or the two Sheets writes inside `VIO-enrol-email`, *after*
  `Enroll Lead (Instantly)` already returned success**: this is the dangerous case — see Q6, because
  it is mechanically the same "the send happened, the record of it didn't" gap regardless of whether
  the interruption is a Sheets error or a process crash. Retries narrow this window (a single 429
  no longer trips it) but do not close it — 4 retries can still be exhausted under sustained quota
  pressure, and the gap is structural (no checkpoint before the Instantly call), not a retry-count
  problem.

---

## Q6 — n8n restarts mid-execution (every deploy)

**Verdict: UNVERIFIED for the exact n8n runtime behaviour (no live access, per constraints), but the
consequence for THIS chain's state machine is derivable from the code with high confidence, and it
is the single most dangerous gap found in this audit.**

What the repo's own docs establish about restarts (`README.md`, "Restarting to bind webhook
routes"): `docker restart n8n-stack-n8n-1` is a documented, routine step in the deploy checklist —
"routes only bind at startup" — so this is not a hypothetical, it happens on every workflow change.
Nothing in any `VIO-*.json` file, and nothing referenced in the README's deploy checklist, describes
an in-flight execution surviving or resuming after that restart. There is no queue-mode/worker
configuration, no static-data lock, and no "resume from checkpoint" node anywhere in
`VIO-run-outreach.json` or `VIO-enrol-email.json` (grepped `lock|singleton|staticData|SETNX` across
both files — no hits outside the WF-3 hardening note, which is about a *different* dedup and is
explicitly still TODO). **UNVERIFIED, and worth settling directly:** trigger
`VIO-run-outreach` against a real "manual" row, and `docker restart n8n-stack-n8n-1` at the moment
`Enroll Lead (Instantly)` is executing (watch `docker logs` for the POST); then check
`execution_entity` for that execution's terminal status and whether the Instantly dashboard shows
the lead as actually enrolled.

What the code DOES establish, independent of the exact crash semantics:

- The row is claimed to `pending_approval` well before the send (`Claim row early`, confirmed
  earlier in the chain than `Enroll Lead`), so a crash **before** the Instantly call is safe —
  nothing was sent, and the row is recoverable via `force: true`.
- A crash **after** `Enroll Lead (Instantly)` returns success but **before** `Write result back`
  (in `VIO-run-outreach`) or `Write Lead Row (Leads)` / `Log Enrolment (Events)` (in
  `VIO-enrol-email`) commit is indistinguishable, from the Sheet's point of view, from a crash that
  happened *before* the send — in both cases the row is left at `pending_approval` with no
  Events-tab record either (that write is downstream of the same commit point). **Nothing in this
  chain writes an intermediate "send attempted" marker before calling Instantly** — the first
  durable record of the attempt is the *result* of the whole node chain succeeding.
- `VIO-sheet-repair.json`'s `Mark approved` node — the only tool that can free a `pending_approval`
  row — makes decisions purely from `verify_action` / `reoon_status` / `channel_state_email`
  (comment: "the verification verdict is the authority"). It has **no way to check Instantly** (no
  HTTP node, no read of any tool outside the Sheet) and therefore cannot tell "this row never sent"
  from "this row already sent and a write got lost." Re-approving with `force: true` sends the row
  back through the full chain: a fresh OpenAI draft (different text — `temperature: 0.7`, not
  deterministic), a fresh Sendr page (a new URL), and a fresh `Enroll Lead (Instantly)` call.
- **Whether that second call actually double-emails the prospect is UNVERIFIED from this repo** — it
  depends on exactly what Instantly does when `skip_if_in_campaign: true` is sent for an email
  already progressing through the *same* campaign's sequence (skip re-adding, but does the sequence
  itself already have this prospect scheduled for a second send under a new lead id, since the retry
  is a new `Enroll Lead` call with a freshly-generated Sendr URL and opener text?). Nothing in
  `INTEGRATIONS.md` documents this specific scenario (grepped for `skip_if_in_campaign`,
  `already in campaign`, `resend`, `re-add` — no hits). **Experiment to settle it:** in a sandbox
  Instantly campaign, enrol a test address, wait for step 1 to send, then call `POST
  /api/v2/leads` again for the same address/campaign with `skip_if_in_campaign: true` and check
  whether a second step-1 email actually goes out.

Given the ambiguity, this is filed as **LOST at minimum (the row and its true state), with a real,
unverified risk of DUPLICATED (an actual second email to a real prospect)** if a human works around
the stranding via `force: true` without independently checking Instantly first.

---

## Q7 — Two polls overlap (3-min runner, ~30-60s chain)

**Verdict: the early-claim fix works as designed for the case it was built for. A narrower,
structurally-unclosed window remains for cross-execution overlap — marked UNVERIFIED where it
depends on n8n scheduler behaviour.**

- Confirmed in `VIO-run-outreach.json`'s `connections` block: `Row usable?`'s true output (index 1)
  fans out to **two** targets in this exact order: `Claim row early` first, `Shape for drafting`
  second. `Claim row early`'s own code comment states why this ordering matters: "n8n's v1 execution
  order runs the first connected branch to completion before the second, so the claim lands before
  drafting starts." `VIO-run-outreach.json`'s `settings.executionOrder` is indeed `"v1"`. This
  claim about connection-order determining execution-order **is plausible and matches the documented
  n8n v1 behaviour but was not independently verified live in this audit** (no n8n access) —
  **UNVERIFIED**, experiment: seed two claimable rows, trigger manually, and diff the `Claim early in
  sheet` write timestamp against the `personalize` (OpenAI) call's start timestamp in the execution
  record; the fix only holds if the claim genuinely lands first for every row, not just on average.
- `Claim row early` only ever writes `row_number` + `channel_state_email` + `updated_at` (confirmed
  in its code — no `opener`/`sendr_page_url`/etc.), specifically so it cannot stomp on later writes;
  this part is a straightforward code fact, not a runtime claim.
- **The window that remains:** there is no lock preventing a **second, independent execution** of
  `VIO-run-outreach` from starting while a **first execution is still running** — `Every minute`
  is a plain `scheduleTrigger` (`VIO-run-outreach.json`), and nothing in the workflow (no static
  data check, no Redis `SETNX`, confirmed by grep across the file) enforces single-instance
  execution. n8n's own default behaviour for whether overlapping schedule-trigger executions are
  blocked was **not verified** in this audit (no live instance). If the CHAIN genuinely stays under
  60s as documented, this can't matter (3-min interval, sub-minute run) — but the same-poll case
  (many "manual" rows claimable in one cycle, each going through OpenAI + Sendr + Instantly
  sequentially) could push a single execution's wall-clock time past 3 minutes under load or Reoon/
  Sendr/OpenAI slowness, at which point the next scheduled trigger fires while the first is still
  mid-batch. **UNVERIFIED**, experiment: seed 10+ claimable rows, trigger the workflow, and check
  whether `execution_entity` shows two `VIO-run-outreach` executions with overlapping
  `startedAt`/`stoppedAt` ranges.

---

## Q8 — Clock/timezone: the 20/day cap vs. midnight

**Verdict: a real, code-confirmed compliance-control weakening — not a "wrong person emailed" bug,
but the stated 15-20/day ceiling is not actually enforced against a Detroit calendar day.**

- `VIO-enrol-email.json`, `Preconditions (fail closed)`: `const today = new
  Date().toISOString().slice(0, 10);` — `.toISOString()` is always UTC. The per-lead loop then
  compares `String(e.timestamp || '').slice(0, 10) !== today` against `Events` rows to count
  `sentToday`.
- The rest of this same codebase demonstrably knows better: `VIO-run-outreach.json`'s own
  `Heartbeat` node uses `const TZ = 'America/Detroit'; ... d.toLocaleString('en-US', { timeZone: TZ,
  ... })` explicitly because (per its comment) a person compares the time "to the clock on their
  wall." The Instantly campaign's own send window is documented elsewhere in this repo as
  Mon–Fri 09:00–17:00 **Detroit** time. The cap-day boundary in `VIO-enrol-email` is the one place in
  this chain that didn't get the same treatment.
- Detroit is UTC-4 (EDT, currently in effect) or UTC-5 (EST). The UTC date rolls over at 8pm/7pm
  Detroit time — mid-business-evening, not at Detroit midnight. Concretely: 20 leads could be
  enrolled by, say, 3pm Detroit (cap reached, `sentToday >= 20` refuses further calls for the rest
  of the UTC day); at 8:01pm Detroit the UTC date has already advanced to the next day, `sentToday`
  resets to 0 against the new UTC-dated `Events` rows, and up to 20 more could be enrolled before the
  Detroit calendar day itself is even over (Detroit midnight is still ~4-5 hours away). This is a
  genuine path to roughly double the stated daily ceiling within one Detroit business day — not a
  crash, not a wrong recipient, but the cap CLAUDE.md and the code comments both describe as "the
  owner's stated ceiling" is not the control it's presented as.
- This does not, by itself, cause a WRONGLY-SENT email to the wrong person or an invalid address —
  every lead still has to clear `Preconditions`' other four checks. It is filed here as a distinct,
  real finding about the cap's integrity, not merged into the "phantom send" issue above.

---

## Summary table

| # | Failure | Verdict | Where caught (if at all) |
|---|---|---|---|
| 1 | Reoon fails/malformed | SAFE | `Reoon Verify (power)` onError + `Intake Result`/`Shape Inbox status` retry logic |
| 2 | OpenAI empty/refusal | SAFE at send boundary, LOST at row level | `VIO-enrol-email` `Preconditions` opener length/pattern check; but row stranded at `pending_approval` |
| 3 | Sendr 200/no pageUrl | SAFE at send boundary, LOST at row level | Same `Preconditions` URL check; `Report Page URL`'s `ok: true` is itself a minor lie |
| 4 | Instantly false-200 | SAFE (send integrity fixed) | `Report`'s campaign-match check — but `Shape row update` then miswrites the outcome regardless (see #1 below) |
| 5 | Sheets rate-limit mid-chain | SAFE before send, dangerous after (folds into Q6) | No retry on demo-sheet-run/enrol-email Sheets nodes; self-heals pre-send, ambiguous post-send |
| 6 | n8n restart mid-execution | LOST at minimum, DUPLICATED risk on manual recovery | No checkpoint before the Instantly call; UNVERIFIED exact crash semantics and Instantly re-add behaviour |
| 7 | Poll overlap | Early-claim fix verified structurally; cross-execution overlap UNVERIFIED | Connection order confirmed; no execution-lock exists |
| 8 | Midnight/timezone | Real cap-integrity bug, not a wrong-recipient bug | Nowhere — UTC date vs. Detroit business day, uncaught |

---

## Top 5 by likelihood × damage

**1. `Shape row update` reads the wrong sub-workflow's output shape — every successful email enrolment through the ungated path is recorded as `needs_review` instead of `enrolled`.**
*Likelihood: certain — this fires on every single successful send through this path, not an edge
case.* *Damage: high — it corrupts the one system of record ("Google Sheets is the dashboard") for
exactly the sends that matter, and it directly sets up a human-triggered duplicate send: someone
sees `needs_review`, assumes nothing went out, and re-approves via `VIO-sheet-repair`, at which
point the row is legitimately reprocessed — new draft, new Sendr page, new Instantly call — for a
prospect who may have already been mailed.*
Cite: `VIO-run-outreach.json` node `Shape row update` (`Array.isArray(r.leads) &&
r.leads.some(l => l.status === 'enrolled')`) vs. `VIO-enrol-email.json`'s actual output shape (no
`leads` key anywhere in the file) vs. `VIO-agent-tool-push-instantly.json`'s `Report` node, which
*does* produce that shape and is what `Shape row update` was evidently written against before the
2026-08-30 repoint.
**Fix:** rewrite `Shape row update` to read `VIO-enrol-email`'s real output — either read
`$('Enrol email (no gate — see notes)').all()` for the `_kind === 'lead'` item's
`channel_state_email` field, or (cleaner, matching the pattern already proven in
`VIO-intake-verify-curate`'s `Intake Result (to caller)` node) add a single terminal join node to
`VIO-enrol-email.json` that returns one unambiguous `{ enrolled: boolean, reason, ... }` item per
call, and have `Shape row update` read that.

**2. No checkpoint exists between "Instantly confirms the send" and "the Sheet records it" — a crash or a Sheets write failure in that narrow window produces a phantom send the system cannot detect, and the only recovery path (`force: true`) will re-send.**
*Likelihood: low per-row, but n8n restarts are a documented, routine part of every deploy on this
shared box, and the window covers `Enroll Lead (Instantly)` plus two to four downstream node
executions.* *Damage: very high — a real duplicate email to a real prospect, with no audit trail
distinguishing it from a false alarm, is the worst single outcome this audit considered, and the
existing recovery tool (`VIO-sheet-repair`) actively walks a human into causing it.*
Cite: `VIO-run-outreach.json` (`Enroll Lead` → `Report` → `Build Sheet Rows` → Sheets writes, no
intermediate durable marker) and `VIO-sheet-repair.json`'s `Mark approved` node (decides purely from
`verify_action`/`channel_state_email`, no way to check Instantly).
**Fix:** write a `pending_send` (or similar) Events row *before* calling `Enroll Lead (Instantly)`,
keyed on a stable idempotency value (e.g. `lead_id` + date), and have `VIO-enrol-email`'s
`Preconditions` refuse if such a row already exists without a matching terminal outcome — turning an
interrupted run into a detectable, refuse-and-alert case instead of a silent retry-and-duplicate
one.

**3. Any downstream throw after `Claim row early` permanently strands the Leads row at `pending_approval`, with no automatic retry.**
*Likelihood: high — this is the shared failure path for Q2 (OpenAI), Q3 (Sendr), the cap-exceeded
throw, the suppression-hit throw, and any Sheets write failure after the claim.* *Damage: medium —
no wrong email goes out, but a real, human-typed lead silently falls out of the pipeline and stays
lost until someone notices the stuck row and remembers the `force: true` incantation; at scale (the
target is daily volume) this is a slow, compounding leak of exactly the leads a human went to the
trouble of typing in.*
Cite: `VIO-run-outreach.json`, `Row usable?` → `Claim row early` (writes `pending_approval`
unconditionally) with no corresponding "release the claim" path on any of the five throw sites in
`VIO-enrol-email.json`'s `Preconditions`, or on `Assemble + Report`'s / `Report Page URL`'s own
failure modes.
**Fix:** wrap the post-claim chain (`Shape for drafting` through `Write result back`) with `onError:
continueRegularOutput` at the `Draft`/`Generate Sendr page`/`Enrol email` Execute Workflow nodes, and
add an explicit "claim failed, release" branch that writes a distinguishable terminal state (e.g.
`stranded_<reason>`) instead of leaving `pending_approval` as both "in flight" and "abandoned."

**4. The 20/day cap is computed against UTC, not the Detroit business day it is supposed to bound.**
*Likelihood: high — this doesn't need a failure to trigger, it happens on any day with sustained
sending activity into the evening.* *Damage: medium — no wrong recipient, but it quietly doubles the
one number CLAUDE.md calls "the owner's stated ceiling," which matters for deliverability/warm-up
pacing and for anyone relying on the cap as a compliance control.*
Cite: `VIO-enrol-email.json`, `Preconditions (fail closed)`: `new Date().toISOString().slice(0, 10)`,
contrasted with `VIO-run-outreach.json`'s own `Heartbeat` node explicitly using `timeZone:
'America/Detroit'` elsewhere in the same repo.
**Fix:** compute `today` with the same `America/Detroit` `toLocaleString`/`Intl.DateTimeFormat`
pattern already used in the `Heartbeat` nodes, or explicitly document (and accept) that the cap is
UTC-bounded if that's actually fine.

**5. Cross-execution overlap of `VIO-run-outreach` under load is structurally possible and unverified.**
*Likelihood: low under normal, low-volume "demo" conditions (~30-60s chain vs. 3-min interval), but
rises directly with volume — and volume is the stated goal (15-20/day, presumably growing).*
*Damage: potentially high if it occurs (duplicate drafts/pages/enrolments for the same row racing
each other), but currently unverified whether n8n's scheduler even allows it on this instance/
version, and the early-claim fix substantially narrows the window versus the pre-2026-08-29 code.*
Cite: `VIO-run-outreach.json`, `Every minute` (`scheduleTrigger`, 3-min interval) with no lock/
static-data/Redis guard anywhere in the file (grepped).
**Fix:** the cheapest real fix is a static-data or Redis `SETNX` "workflow already running" guard at
the very top of the execution (the WF-3 hardening note already flags Redis as available on the
droplet for an analogous purpose) — then verify with the two-execution overlap experiment described
under Q7 before trusting either the fix or its absence.
