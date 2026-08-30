# GAPS.md — ruthless gap audit of the VisioneerIT outbound engine (n8n)

Audit performed read-only against the working tree as of **2026-08-29, ~20:15**. No SSH, no
deploy, no writes except this file. Every claim below cites the actual file/line/code read; where
I could not settle something without hitting the live droplet, it is marked **UNVERIFIED**
explicitly rather than guessed.

**⚠️ The repo was being edited concurrently during this audit.** `VIO-costs-rollup.json` and
`test-costs-rollup.mjs` did not exist at the start of the run and appeared (mtimes 20:13–20:14)
partway through. All test results below are from a **second, later** full run taken after those
files appeared, so the numbers are self-consistent, but this means the target was moving — treat
this report as a snapshot, not a permanent record, and re-run the checks in "How to reproduce"
below before acting on anything here.

---

## 1. Offline test suites — exact results

```
test-ask-human-gate.mjs        [exit 0]  116 passed, 0 failed
test-costs-rollup.mjs          [exit 0]  52 passed, 0 failed
test-demo-sheet-run.mjs        [exit 0]  114 passed, 0 failed
test-inbox-mapper.mjs          [exit 0]  120 passed, 0 failed
test-instantly-events.mjs      [exit 0]  71 passed, 0 failed
test-intake-callable.mjs       [exit 0]  125/125 passed
test-intake-gate.mjs           [exit 0]  84/84 passed
test-operator-agent-lead.mjs   [exit 0]  369 passed, 0 failed
test-operator-plan.mjs         [exit 0]  26 passed, 0 failed
test-push-instantly-gate.mjs   [exit 0]  315 passed, 0 failed
test-reply-brain.mjs           [exit 0]  10 passed, 0 failed
test-reply-sheet-writes.mjs    [exit 0]  132/132 passed
test-reveal-gate.mjs           [exit 0]  235 passed, 0 failed
test-run-campaign.mjs          [exit 0]  62 passed, 0 failed
test-segment-scoring.mjs       [exit 0]  71 passed, 0 failed
test-sendr-events.mjs          [exit 0]  32 passed, 0 failed
test-source-leads.mjs          [exit 0]  76 passed, 0 failed
```
**Every offline suite passes, 0 failures, 0 skips.** Total ≈ 2,368 assertions green.

```
test-sync-routes.py            [exit 0]  40/40 passed
sync-routes.py                 [exit 0]  "all 6 consumers match config-oryoniq.json,
                                           config-visioneerit.json — no drift."
```
Notes emitted (not failures): an `email_complete:false` splice note on `Assemble + Report`, and a
note that VisioneerIT has no Instantly campaign file yet.

**Conclusion: nothing is broken that the existing offline suites check for.** Everything below is
something the suites do **not** check for — that's the point of this audit.

---

## 2. What `sync-routes.py`'s "6 consumers" actually cover (and don't)

Read directly from `sync-routes.py` (`SENDR_WORKFLOW`, `AGENT_V1`, `AGENT_V2`, `ENGINE_PY` module
constants, `check_routes`/`check_agent_v1_config`/`check_agent_v2_config`/`check_email_shape`/
`check_instantly_copy`/`check_cta_sentence`): it only cross-checks `VIO-sendr-generate-page.json`,
`VIO-operator-agent.json`, `VIO-operator-agent-v2.json` and `reach-engine/engine.py` against
`config-oryoniq.json` / `config-visioneerit.json`.

It does **not** check `VIO-agent-tool-push-instantly.json`'s hardcoded `CAMPAIGNS` allow-list
(the Instantly campaign ids), and it does **not** check the product routing inside
`VIO-demo-sheet-run.json`. Both are in the lead's actual path. See Finding B below — a real drift
of exactly this kind exists there right now, uncaught by anything green above.

---

## 3. Full lead-path trace, handoff by handoff

Path audited: Sheet `Inbox` tab (human types a row) → `VIO-inbox-mapper` (schedule, 2 min) →
`VIO-intake-verify-curate` (Reoon + dedupe + suppression) → `Leads` tab → `VIO-demo-sheet-run`
(schedule, 1 min) → `VIO-operator-agent` (drafts) → `VIO-sendr-generate-page` → Slack approval →
`VIO-agent-tool-push-instantly` → Instantly → `VIO-instantly-events` / `VIO-inbound-reply-to-call`
write results back.

| # | Handoff | Writer | Reader | Verdict |
|---|---|---|---|---|
| 1 | Inbox row → `VIO-inbox-mapper` | human/Sheets | `Read Inbox` → `Map headers` | OK — alias table + AI fallback, 120 tests green |
| 2 | mapper → intake (**Execute Workflow**) | `Shape Lead row` (mapper) | `Leads In` trigger (intake), `inputSource: passthrough` | **See Finding A — caller-side config anomaly** |
| 3 | intake → `Leads` tab | `Write Lead Row (Leads)` | `Pick demo rows` (demo-sheet-run) | OK, but only after a **live bug fix already recorded in the code itself**: `channel_state_email` values are cross-checked and match (`not_sent`/`needs_review`/`dropped` on write, `{'', 'not_sent', 'approved'}` READY-set on read) — see "FIX 1" comment in `VIO-demo-sheet-run.json` line 62, which documents a real prior mismatch (writer never left the cell blank, reader required blank) that was **already found and fixed** in this exact spot. No live residue of it. |
| 4 | demo-sheet-run → operator-agent (Execute Workflow, `mode:'each'`) | `Shape for drafting` | `Called by Workflow` trigger, `inputSource: passthrough` | OK — single-lead-per-call shape matches on both sides |
| 5 | operator-agent → demo-sheet-run (return value) | `Assemble + Report` | `Shape for page` | OK — deliberately reads identity back from `Shape for drafting` (own memory), not from the sub-workflow's return, documented and tested (`test-demo-sheet-run.mjs` lines 156-165) |
| 6 | demo-sheet-run → sendr-generate-page (Execute Workflow, `mode:'each'`) | `Shape for page` (sends **real** product: `oryoniq`/`visioneerit`) | `Route Product to Template` ROUTES map | OK — verified by `sync-routes.py`, and the real product is correctly threaded through |
| 7 | demo-sheet-run → push-instantly (Execute Workflow, `mode:'each'`) | `Shape for enrolment` (sends **hardcoded** `product: 'demo'`) | `Build Proposal`'s `CAMPAIGNS` allow-list | **BLOCKER — Finding B** |
| 8 | push-instantly → Instantly HTTP | `Authorize Enrolment` builds body from `Build Proposal` only | Instantly API | OK — 4 independent re-checks documented and tested, gate cannot be bypassed by rewiring |
| 9 | push-instantly → `Leads`/`Events` tabs | `Build Sheet Rows` | n/a (append/appendOrUpdate, schema present) | OK |
| 10 | Instantly → `VIO-instantly-events` | Instantly webhook | `Classify Event` → `Build Rows` | OK — `channel_state_email` values (`bounced`/`unsubscribed`) are outside demo-sheet-run's READY set, correctly terminal |
| 11 | Instantly reply → `VIO-inbound-reply-to-call` | Instantly webhook | `Shape Reply Outcome`/`Shape Lead Update` | OK — 132/132 in `test-reply-sheet-writes.mjs`, explicitly asserts column-name matching |

---

## Finding A — BLOCKER (high-confidence anomaly, exact runtime effect UNVERIFIED without a live n8n)

**File:** `n8n-workflows/VIO-inbox-mapper.json`, node `"Verify + curate (intake)"` (line 331),
`parameters.workflowInputs` (line ~318-323):

```json
"workflowInputs": {
  "mappingMode": "defineBelow",
  "value": {},
  "matchingColumns": [],
  "schema": []
}
```

This is the **only** `n8n-nodes-base.executeWorkflow` node in the entire codebase (8 total, checked
every one) that sets `workflowInputs` at all. Every other caller — `Ask Human (BLOCKING)`
(`VIO-agent-tool-push-instantly.json`), `Ask Human (wait)` (`VIO-agent-tool-reveal-contacts.json`),
`Draft (operator agent)` / `Generate Sendr page` / `Enrol (GATED — Slack approval)`
(`VIO-demo-sheet-run.json`), `Source Leads (free)` / `Draft Email (per lead)`
(`VIO-run-campaign.json`) — omits `workflowInputs` entirely, on the same `typeVersion 1.2`.

Why this matters: this project's own README (`n8n-workflows/README.md`, the "Two entry points, one
gate" section, and again verbatim in the `Leads In (from parent workflow)` node's own `notes` field
in `VIO-intake-verify-curate.json` line 21) states the **identical failure pattern** as an already-
known gotcha: *"a declared `workflowInputs` schema silently DROPS every field it does not list."*
That warning was written about the **trigger** side (`inputSource`), which correctly uses
`passthrough` on the callee (`VIO-intake-verify-curate.json` line 18). But the **caller** side here
carries a `workflowInputs` block with an *empty* schema/value/matchingColumns — the same shape the
project already learned causes field-dropping, applied on the other end of the same connection.

**What is confirmed by reading code:**
- The callee (`Leads In (from parent workflow)`) is `inputSource: passthrough` — it does not itself
  request a schema.
- No other working caller in this codebase sets `workflowInputs` at all.
- `test-inbox-mapper.mjs` (120 assertions) has **zero** assertions referencing `workflowInputs`,
  `mappingMode`, or `Verify + curate (intake)`'s parameters — this specific wiring is **untested**.
- The consuming code downstream (`Merge verdicts` in the same file) is defensive: if intake returns
  no verdict for a lead, it marks `_verify_outcome: 'no_verdict'`, and `Shape Inbox status` leaves
  that row's `status` blank (`retry = outcome === 'verify_failed' || outcome === 'no_verdict'`) so
  it is retried, not falsely marked done.

**What I could NOT confirm without a live n8n instance (UNVERIFIED):** whether n8n 2.22.6 actually
sends an empty object to the sub-workflow when `mappingMode: "defineBelow"` with empty `schema`/
`value`/`matchingColumns` is paired with a target using `inputSource: passthrough`, or whether this
specific empty shape is inert (i.e., what the n8n UI writes by default when it detects the target
declares no schema, in which case it may be a no-op). I read no n8n node source for this — only the
JSON, this project's own docs, and the comparative absence of the parameter everywhere else it
works. This needs one live smoke test (a real row through `VIO-inbox-mapper` with the intake target
active) before being trusted either way.

**Failure scenario if the worst case is true:** every lead a human types into the `Inbox` tab
reaches `Verify + curate (intake)` with its data stripped to nothing. Intake's `Batch In` node
receives zero usable leads, runs no Reoon calls, writes nothing to `Leads`, and returns nothing.
`Merge verdicts` sees an empty verdict set, marks every row `no_verdict`, and `Shape Inbox status`
leaves the row's `status` blank forever — so the row is retried every 2-minute cycle, forever,
never completing, and never surfacing an explicit error to a human (no exception is thrown in this
branch of the code, so `VIO-error-alert` never fires). The lead silently never arrives — not as a
crash, as an infinite stall that looks, at a glance, like "still processing."

**Rank: BLOCKER**, confidence: structural anomaly and untested path both confirmed by direct code
read; exact runtime consequence UNVERIFIED. Recommend one live test before trusting the Sheet-Inbox
entry point at all.

---

## Finding B — BLOCKER (confirmed by code, no live test needed to see the logic error)

**File:** `n8n-workflows/VIO-demo-sheet-run.json`, node `"Shape for enrolment"` (id
`vio-wfd-enrol`, name at line 199, `jsCode` at line 196):

```js
return { json: {
  product: 'demo',
  allow_recontact: true,
  leads: [{ ... }],
  ...
} };
```

`product` is **hardcoded to the literal string `'demo'`** — regardless of the row's actual
`Product` column (`oryoniq` or `visioneerit`), which was correctly threaded through two steps
earlier for drafting and page generation (`Shape for drafting` / `Shape for page`, both correctly
use `src.source_config`, the real product — see `test-demo-sheet-run.mjs` lines 127-128, which
explicitly asserts a VisioneerIT row drafts with `source_config === 'visioneerit'`).

The receiving allow-list, `n8n-workflows/VIO-agent-tool-push-instantly.json`, node `"Build
Proposal"` (line 59), `CAMPAIGNS` map (inside the `jsCode` starting at line 56):

```js
const CAMPAIGNS = {
  oryoniq:      { id: '77b2cd80-5bf2-4656-8857-b310858d5a77', product: 'oryoniq' },
  visioneerit:  null,   // no Instantly campaign exists yet — refuses cleanly, by design
  demo:         { id: '0525f568-6f2f-4fca-8f97-16552d7c20f6', product: 'oryoniq' },
};
```

Because `Shape for enrolment` always sends `product: 'demo'`, it **always** resolves to the `demo`
entry, which is hardcoded to carry **OryonIQ's copy** (the comment on that entry says so explicitly:
*"the demo campaign is keyed 'demo' but sends OryonIQ's step-1 body verbatim, so a row enrolled
through it was pitched BY OryonIQ and must say so"*). This is not a hypothetical: it is what the
code does on every single row that reaches this node, whether the sheet says OryonIQ or
VisioneerIT.

**Concretely: a VisioneerIT lead — drafted with VisioneerIT copy (step 4), given a VisioneerIT-
branded Sendr page (step 6, template 8464 "Zero-Trust Readiness Page") — is, if a human approves the
Slack prompt, enrolled into an Instantly campaign whose body is OryonIQ's, linking to a
VisioneerIT-branded landing page, from a campaign named "OryonIQ - Reach Engine Pilot".** This is
exactly the class of bug this project has already been burned by once (per `CLAUDE.md`'s own commit
log entry: *"Fix the VisioneerIT ICP, and stop cross-product copy leaking"*, and the earlier
`cta`-pointing-at-the-wrong-company's-domain bug described in `CLAUDE.md`'s "Current state" section).

Worse: the `visioneerit: null` entry exists specifically to **fail closed** when no real VisioneerIT
Instantly campaign exists — the comment says so ("Listed as null so the refusal says WHY instead of
'unknown product'"). Hardcoding `'demo'` **bypasses that fail-closed protection entirely** for
VisioneerIT leads: instead of a clean refusal naming the missing campaign, the lead silently gets
enrolled into the wrong brand's campaign.

**Not covered by any test:** `test-demo-sheet-run.mjs` asserts `Shape for enrolment` reads identity
from `Shape for page` (lines 164-176) and asserts the `channel_state_email` vocabulary (lines
178-190), but never asserts anything about the `product` field's value or that it should vary by
row. `test-push-instantly-gate.mjs` (315 assertions) tests `Build Proposal`'s `CAMPAIGNS` allow-list
logic in isolation but has no way to know the caller always sends `'demo'` for every row — that's a
cross-file drift, and `sync-routes.py`'s 6 consumers do not include either of these two files (see
Section 2 above).

**Rank: BLOCKER.** No live test needed to establish the logic error — it is a plain string literal
visible in the diff between two files, and its effect (cross-branded outbound email to a real
prospect, and a bypassed fail-closed check) is exactly what CLAUDE.md's hard rules and this
project's own history treat as the worst class of mistake this pipeline can make.

---

## Finding C — SERIOUS (documentation contradiction; live status UNVERIFIED, cannot SSH)

`n8n-workflows/README.md` states in two places that directly conflict once `VIO-inbox-mapper.json`
is taken into account:

- Line 141-142: *"`VIOwf1intake0001` (intake) is still deactivated by design — **activate it before
  wiring it into any orchestrator**, or the orchestrator fails at that step."* — and the intake
  workflow's own status line (line 150-151) repeats: *"Still **deactivated and manually-triggered on
  purpose**."*
- But `VIO-inbox-mapper.json` (README lines 573-621, marked **"LIVE"**) now has an `Execute
  Workflow` node, `"Verify + curate (intake)"`, that calls `VIOwf1intake0001` synchronously
  (`waitForSubWorkflow: true`) every 2 minutes on a schedule trigger.

On n8n 2.22.6, per this same README (lines 125-142, "An `Execute Workflow` TARGET must be ACTIVE"),
calling an inactive sub-workflow throws `Workflow is not active and cannot be executed` and **the
caller dies** with a stack trace — this exact failure mode already bit this project once
(`VIO-agent-tool-push-instantly` → `VIO-agent-tool-ask-human`, 2026-08-22, documented in the same
section). `VIOwf1intake0001` is conspicuously **absent** from the README's "must be ACTIVE" list
(line 138-140), which lists six other ids but not this one — consistent with intake still being
inactive by the doc's own account.

**If intake is still inactive** (which the docs' own words say, and which is not contradicted
anywhere), then every single run of `VIO-inbox-mapper` that has at least one usable row throws at
the `Verify + curate (intake)` step, aborting that execution, triggering `VIO-error-alert` → Slack
(per `settings.errorWorkflow` in the JSON) every 2 minutes — loud, not silent, but the entire
Sheet-Inbox intake path would be non-functional in production despite being labeled "LIVE."

**I could not verify actual current activation state — no SSH per task constraints.** This is
flagged as a **documentation self-contradiction that is directly actionable**: before trusting the
Sheet-Inbox path, confirm on the droplet whether `VIOwf1intake0001` has since been activated (and if
so, update the README's "must be ACTIVE" list, which currently states the opposite).

Also worth noting: none of `VIO-demo-sheet-run.json`, `VIO-instantly-events.json`,
`VIO-costs-rollup.json`, `VIO-sheet-audit.json`, `VIO-sheet-provision.json`, `VIO-sheet-repair.json`
appear in README's "Workflows" narrative section at all (that section stops at WF-8
`VIO-inbox-mapper` and WF-7 `VIO-operator-agent-v2`) — their activation status, and in most cases
their very existence, is undocumented. UNVERIFIED whether they are active; SERIOUS as a documentation
gap regardless, since the task's described "full path" runs through two of them
(`VIO-demo-sheet-run`, `VIO-instantly-events`).

---

## 4. Known failure classes — explicit check results

**Google Sheets nodes (typeVersion / credential id / write schema).** Extracted every
`n8n-nodes-base.googleSheets` node across all 19 workflow JSONs (32 nodes total): **100% are
`typeVersion 4.7`**, **100% pin `credentials.googleApi.id: "VIOgsheetcred01"`**, and **every write
operation (`append`/`appendOrUpdate`/`update`) declares a non-empty `columns.schema`**. Read
operations correctly omit `columns` (not applicable) and set `alwaysOutputData: true` in most
places that matter for downstream lookups (`Read Leads (dedupe)`/`Read Suppression` in intake,
`Read Leads (reply lookup)` in inbound-reply-to-call). **No violations found in this class.**

**`Execute Workflow` target-active cross-reference.** Full list of ids referenced by
`executeWorkflow`/`executeWorkflowTrigger` nodes: `VIOwf8askhuman1`, `VIOwf4agent0001`,
`VIOwf6sendrgen01`, `VIOwfBpushinst1`, `VIOwf9source0001`, `VIOwf1intake0001`. The first five are
covered by README's "must be ACTIVE" list; the sixth (`VIOwf1intake0001`) is the contradiction in
Finding C above. UNVERIFIED beyond what the docs themselves say — no SSH performed.

**Batch-mode vs. per-item mismatches.** Checked every `executeWorkflow` node's `mode` param against
its target's own input-handling shape:
- `Verify + curate (intake)` → intake: **no `mode` set (defaults to "once for all items")** — correct,
  intake's own `notes` field confirms this is deliberate (`"Runs ONCE FOR ALL ITEMS on purpose"`),
  and every downstream intake node is `$input.all().map(...)`, matching a batch shape.
- `Draft (operator agent)`, `Generate Sendr page`, `Enrol (GATED — Slack approval)` (all in
  `VIO-demo-sheet-run.json`), `Draft Email (per lead)` (in `VIO-run-campaign.json`): all `mode:
  'each'` — correct, all three targets (`VIOwf4agent0001`, `VIOwf6sendrgen01`, `VIOwfBpushinst1`)
  are single-lead workflows (`Test Lead (edit me)` / `Called by Workflow` handle exactly one item).
- **No mismatch found in this class**, aside from Finding A's separate `workflowInputs` anomaly on
  the same node (which is a field-mapping issue, not a batch-mode issue — its `mode` is correctly
  left unset).

**Inert node parameters (the Slack `sendAndWait`/`message` vs `text` class of bug).** Checked every
`n8n-nodes-base.slack` node's parameter keys: all three `sendAndWait` operations (`Ask Human
(Slack)`, `Ask Reason (Slack)`, `Propose Call to Human (Slack)`) correctly use `message`; both plain
`post`/no-operation Slack nodes (`Post to Slack` in `VIO-error-alert.json`, `Notify Human (Slack)`
in `VIO-sendr-events.json`) correctly use `text`. Also checked `select: "channel"` is explicit
everywhere (the other half of that same historical bug class) — it is, on all five Slack nodes.
**No recurrence of this bug class found.**

**Hardcoded product/config values that should come from `reach-engine/config-*.json`.** Beyond
Finding B (which is a genuine bug, not a stylistic hardcode), the only other hardcoded product
values are the Instantly `CAMPAIGNS` ids in `VIO-agent-tool-push-instantly.json` (`oryoniq`:
`77b2cd80-...`, `demo`: `0525f568-...`). These are **deliberately** not config-driven — the node's
own comment explains this is a security control (an LLM-supplied free-text campaign id could
otherwise misdirect prospects into one of the ~12 unrelated live campaigns sharing this Instantly
workspace) — this is a considered design choice, not an oversight, and is a legitimate allow-list
pattern. Noted as a **COSMETIC** documentation gap only: the `demo` campaign id
(`0525f568-6f2f-4fca-8f97-16552d7c20f6`) appears in exactly one file in the whole repo and nowhere
in `INTEGRATIONS.md` or any `reach-engine/config-*.json` — if that campaign is ever renamed, paused
permanently, or deleted on the Instantly side, nothing outside this one JSON file would tell anyone
why the demo path started failing.

---

## 5. Ranked findings summary

| Rank | Finding | File:line |
|---|---|---|
| **BLOCKER** | Finding A — the only `executeWorkflow` caller with a `workflowInputs` schema block in a codebase where every other working caller omits it; matches this project's own documented field-dropping bug pattern; untested; if the worst case is true, every Sheet-Inbox lead stalls forever, unclaimed, with no alert. | `n8n-workflows/VIO-inbox-mapper.json:318-323` (node `Verify + curate (intake)`, line 331) |
| **BLOCKER** | Finding B — `product: 'demo'` hardcoded regardless of the lead's real product; bypasses push-instantly's fail-closed `visioneerit: null` refusal; any approved VisioneerIT lead is cross-branded into an OryonIQ-copy Instantly campaign. Confirmed by code alone, no live test needed. | `n8n-workflows/VIO-demo-sheet-run.json:196` (node `Shape for enrolment`) × `n8n-workflows/VIO-agent-tool-push-instantly.json:56` (node `Build Proposal`, `CAMPAIGNS` map) |
| **SERIOUS** | Finding C — README states intake (`VIOwf1intake0001`) is still deactivated by design, in the same document that lists `VIO-inbox-mapper` (which calls it synchronously) as LIVE. One of these two claims is wrong; UNVERIFIED which, no SSH performed. | `n8n-workflows/README.md:138-142,150-151,573` |
| **SERIOUS** | README's "Workflows" narrative section and "must be ACTIVE" list do not mention `VIO-demo-sheet-run.json`, `VIO-instantly-events.json`, `VIO-costs-rollup.json`, `VIO-sheet-audit.json`, `VIO-sheet-provision.json`, `VIO-sheet-repair.json` at all — activation status of most of the described "full path" is undocumented. | `n8n-workflows/README.md` (absent) |
| **COSMETIC** | `VIO-demo-sheet-run.json`'s `Shape row update` writes `channel_state_email: 'dropped'` for both "human declined the Slack approval" and "Instantly said the lead already exists elsewhere" — two different outcomes collapse to one value, reducing audit precision in `VIO-sheet-audit`. Not a silent-loss bug; the row is correctly excluded from retry either way. | `n8n-workflows/VIO-demo-sheet-run.json` (node `Shape row update`) |
| **COSMETIC** | The `demo` Instantly campaign id (`0525f568-6f2f-4fca-8f97-16552d7c20f6`) exists in exactly one file and nowhere in `INTEGRATIONS.md`/`reach-engine/config-*.json`. | `n8n-workflows/VIO-agent-tool-push-instantly.json:56` |
| **COSMETIC** | `sync-routes.py`'s drift-detection ("6 consumers") does not cover `VIO-agent-tool-push-instantly.json`'s `CAMPAIGNS` map or `VIO-demo-sheet-run.json`'s product routing — Finding B is exactly the kind of drift this tool exists to catch, and it did not catch it because it isn't wired in. | `n8n-workflows/sync-routes.py:131-140` |

---

## 6. Explicitly UNVERIFIED (would need the live droplet)

- Exact runtime behavior of `workflowInputs: {mappingMode:"defineBelow", value:{}, ...}` on an
  `executeWorkflow` caller whose target uses `inputSource: passthrough`, on this n8n build (2.22.6).
  (Finding A.)
- Current activation state of `VIOwf1intake0001`, and by extension whether Finding C's contradiction
  is currently live-breaking or already resolved on the droplet. (Finding C.)
- Current activation state of `VIO-demo-sheet-run`, `VIO-instantly-events`, `VIO-costs-rollup`,
  `VIO-sheet-audit`, `VIO-sheet-provision`, `VIO-sheet-repair` — none confirmed by any doc read.
- Whether Finding B has already fired against a real person (no execution records were read; this
  was a static code audit only, per the read-only constraint).

## How to reproduce this audit

```bash
cd n8n-workflows
for t in test-*.mjs; do node "$t"; done
python3 test-sync-routes.py
python3 sync-routes.py
```
No SSH, no deploy, no writes were performed to reach any conclusion in this file.
