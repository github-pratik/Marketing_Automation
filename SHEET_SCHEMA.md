# VisioneerIT Outbound — Google Sheet schema

The Sheet is the data bus (every `VIO-` workflow reads/writes it), the dashboard, the pilot's
cost meter, and — since 2026-08-21 — its targeting memory. **Specified here: seven tabs** —
`Inbox`, `System`, `Leads`, `Suppression`, `Events`, `Costs`, `Segments`. Live sheet-audit on
**2026-09-04** also saw `Demo` and `Pipeline` on the spreadsheet (this doc does not yet specify
their columns). Header = row 1. Workflows key on exact column names — don't rename a
column without updating every workflow that reads/writes it.

**LIVE since 2026-08-16.** Spreadsheet `VisioneerIT Outbound`, id `1ZD8VMxrXCJHbjaVUwgUSHI_pw4YBP_n7u7Gsdq71X2c`.
`Leads`, `Events`, `Costs`, `Suppression`, `Segments`, `Inbox`, and `System` all exist on the live
sheet (re-confirmed 2026-09-04). Creating tabs is idempotent; existing tabs and their headers are
left alone. Shared with `vio-n8n-sheets@visioneerit-outbound.iam.gserviceaccount.com` as Editor, and the n8n credential
`VIO Google Sheets` is installed and verified.

**Writes are live since 2026-08-17**, in `VIO-intake-verify-curate` (WF-1) — it reads `Leads` +
`Suppression` as gates and appends to `Leads` + `Events`. See `n8n-workflows/README.md` for the
execution evidence and the five Sheets-node gotchas found doing it.

> ⚠️ **Column ORDER in the live Sheet does not match the order listed in this document.** The column
> *names* are identical and complete; only the positions differ (e.g. `lead_id` is column P on the
> live `Leads` tab, not column A). Nothing is broken — n8n's Sheets node appends in
> `autoMapInputData` mode, which matches on header **text** — but it means **no workflow or script
> may address these tabs by A1 column letters**. Read the header row and match on names.

**Auth: a Google SERVICE ACCOUNT, not OAuth.** n8n's Sheets node supports both
(`googleApi` with `email`+`privateKey`, or `googleSheetsOAuth2Api`). The service account wins here
because it installs headlessly via the CLI — OAuth needs a human to finish a browser consent flow,
which a headless session cannot do. The Sheet must then be **shared with the service account's
`client_email` as Editor**; a valid key on an unshared sheet is the single most common failure and
returns a bare 403.

**One command does the whole setup:**
```bash
python3 n8n-workflows/setup-google-sheets.py --key <path-to-sa.json> --sheet-id <id>
```
It verifies access first (so you get one clear reason rather than a cascade), creates any missing
tabs, writes these header rows, installs the credential into n8n as `VIO Google Sheets`
(id `VIOgsheetcred01`), and then shreds the loose key file. `--verify-only` checks access and
changes nothing. Restart n8n afterwards — it caches decrypted credentials in memory.

---

## Tab 1 — `Leads` (the data bus)

One row per lead, updated in place as it moves source → verify → personalize → send → reply →
booked. Column names below match the real field names the current tools already emit — don't
drift from these without updating the code that writes them.

| Column | Populated by | Notes |
|---|---|---|
| `lead_id` | first writer | stable key; use `apollo_id` if present |
| `source_config` | reach-engine | which product config generated this lead (`oryoniq`, `visioneerit`, ...) — the engine is one-engine-many-products, this is how a row traces back to its campaign |
| `apollo_id` | reach-engine (`apollo_search`) | Apollo's own person id |
| `first_name`, `title`, `company` | reach-engine | direct from Apollo free search |
| `has_email`, `has_phone` | reach-engine | free Apollo flags, **not** the actual address/number |
| `contact_email` | reach-engine, **after** `--reveal` | the real revealed address. **Live** since 2026-08-05 — `apollo_reveal()` in `engine.py`, matched by Apollo person id, email only. |
| `phone` | **not from `--reveal`** — a separate, later action | deliberately NOT part of the batch reveal step, to conserve Apollo's scarce mobile/dial credits. **Nothing pulls this now and nothing is planned to** — voice was skipped 2026-08-17, so the one downstream consumer is gone. Keep the column (a human may still want a number for a manual follow-up) but treat it as operator-filled, not pipeline-filled. |
| `company_domain` | reach-engine (`org_domain`) | free from Apollo's unpaid search; drives the Sendr dynamic-website GIF and video background |
| `sendr_page_id`, `sendr_page_url` | `push_to_sendr_page.py` / `VIO-sendr-generate-page` | written back onto the lead so the chain is resumable and engagement events can be traced to a row |
| `gif_url` | `make_scroll_gif.py` | only when the self-built GIF path is used; Sendr's own GIF lives on the page, not here |
| `linkedin_url` | Sendr enrichment | needed to route the LinkedIn touch |
| `timezone` | Sendr/Apollo enrichment | originally for calling-hours on an automated call. Voice is skipped, so this is now advisory only — useful for send-time tuning and for a human deciding when to reply. |
| `signal` | reach-engine (from config) | the live market hook used to personalize, kept for audit |
| `opener` | reach-engine (`openai_opener`) | the drafted one-line hook |
| `email_draft` | reach-engine (`assemble_email`) | full drafted email body. Fixed 2026-08-05 — `engine.py`'s output column is now genuinely `email_draft`, separate from `contact_email`; they no longer collide. |
| `reoon_status` | Reoon verify — either implementation | same values both places |
| `verify_action`, `verify_reason` | `reach-engine` (`reoon_verify()`) | `pass` / `drop` / `needs_review` + why — same mapping as n8n's Classify node, kept in sync on purpose |
| ~~`overall_score`, `is_safe_to_send`, `is_catch_all`, `is_deliverable`, `verified_at`~~ | — | **These are NOT columns.** They never existed on the live tab or in `setup-google-sheets.py`, and this row used to claim otherwise. `VIO-intake-verify-curate`'s Classify node does compute them, but they land in the execution record and, condensed, in the `Events.result` string (e.g. `needs_review (catch_all, score 75)`). Add real columns only if an audit actually needs them — and add them to `setup-google-sheets.py` at the same time. |
| `channel_state_email` | Instantly (Phase 2, not built) | `not_sent` / `queued` / `sent` / `bounced` |
| `channel_state_linkedin` | Sendr (Phase 2, not built) | `not_sent` / `queued` / `sent` |
| `idempotency_key` | reply webhook | dedup key for the reply-brain gate — see `n8n-workflows/test-reply-brain.mjs` |
| `reply_received` | reply webhook | bool |
| `reply_sentiment` | OpenAI classification (Phase 3, not built) | replaces Victoria's old built-in `ai_response.sentiment` — must be `positive` to ever reach the call gate |
| `reply_out_of_office` | OpenAI classification (Phase 3, not built) | bool; `true` always skips the call regardless of sentiment |
| `call_state` | **operator, not automation** (voice skipped 2026-08-17) | `not_eligible` / `pending_approval` / `called` / `skipped`. No workflow writes this. Retained so a human can record a manual follow-up, and so the column doesn't have to be re-added if voice is ever revived. |
| `meeting_booked` | Sendr `engagement:meeting_booked`, or manual | bool. The Sendr event only becomes reachable once a real embeddable `booking_url` exists — see `INTEGRATIONS.md`. Until then this is operator-filled. |
| `created_at`, `updated_at` | first/last writer | ISO timestamps |

## Tab 2 — `Suppression` (append-only)

Matches on **any** identifier — a lead suppressed under one channel must not resurface under
another. Never delete a row here; if a suppression was added in error, add a new row noting the
correction, don't remove the old one.

| Column | Notes |
|---|---|
| `identifier_type` | `email` / `phone` / `linkedin` / `domain` |
| `identifier_value` | the actual value being suppressed |
| `reason` | `opt_out` / `bounced` / `complained` / `manual` |
| `added_at` | ISO timestamp |
| `added_by` | workflow name (e.g. `VIO-inbound-reply-to-call`) or a human's name |

Every workflow that's about to contact a lead on any channel checks this tab first, matching
against **all** of the lead's known identifiers, not just the one for that channel.

**Live reader since 2026-08-17:** `VIO-intake-verify-curate` checks this tab *before* spending a
Reoon credit, matching a lead's email, its email's domain, its company_domain, its phone (last 10
digits) and its linkedin against every row. A row whose `identifier_type` is blank or unrecognised
is compared against **every** identifier shape rather than skipped — a malformed suppression row
must still suppress. Proven live: a `domain`/`example.com` row correctly blocked
`dana.reed@example.com`, i.e. suppression added under one channel stopped a lead arriving on
another.

## Tab 3 — `Events` (per-action audit log)

One row per billable or state-changing action a workflow takes on a lead. Answers "what happened to
this lead, and what did it cost" — the per-lead counterpart to `Costs`, which meters per tool.
Append-only in practice; nothing updates a row here.

| Column | Notes |
|---|---|
| `timestamp` | ISO timestamp of the action |
| `lead_id` | same key as `Leads.lead_id` — Apollo person id, else first 16 hex of sha256(lowercased email) |
| `lead_email` | denormalised on purpose so a row is readable without a `Leads` lookup |
| `tool` | `apollo` / `reoon` / `openai` / `instantly` / `sendr` (no `thoughtly` — voice skipped 2026-08-17) |
| `action` | what was done, e.g. `verify`, `reveal`, `opener`, `generate_page`, `send` |
| `units` | the meterable quantity — 1 credit, 1 call, 1 page |
| `est_cost_usd` | **leave blank when the real rate is `[UNKNOWN]` in `COSTS.md`.** "Measure, don't estimate" — a made-up number in the cost meter is worse than a gap. Reoon's `$`/credit is currently unknown, so WF-1 writes `units: 1` and an empty cost. |
| `result` | the outcome in one string, e.g. `needs_review (catch_all, score 75)` |
| `workflow` | which `VIO-` workflow wrote the row |
| `source_config` | which product config the lead came from |

**Live writer since 2026-08-17:** `VIO-intake-verify-curate` appends one row per Reoon `/verify`
call (`tool: reoon`, `action: verify`, `units: 1`). Nothing writes an Events row for a lead the gate
skipped — a skipped lead consumed nothing, and its reason lives in the execution record.

## Tab 4 — `Costs` (the pilot's cost meter)

Measure, don't estimate — meter what each tool actually consumes rather than projecting it.
Full cost methodology (per-tool baselines, the cost-per-meeting formula) lives in `COSTS.md`;
this tab is just the raw meter it reads from.

| Column | Notes |
|---|---|
| `date` | |
| `tool` | `apollo` / `reoon` / `openai` / `instantly` / `sendr` (no `thoughtly` — voice skipped 2026-08-17) |
| `metric` | whatever's meterable for that tool — e.g. `lead_credits`, `mobile_credits`, `verify_credits`, `api_calls`, `emails_sent` |
| `count` | |
| `est_cost_usd` | |
| `source_config` | which product/campaign this ties back to |
| `notes` | |

## Tab 5 — `Segments` (the targeting memory)

One row per prospect bucket, not per lead. This is where the engine learns **which kinds of
prospects actually reply** so future targeting can be weighted toward them.

**Why it is a tab and not an LLM memory.** n8n's `memoryBufferWindow` holds one conversation and
forgets it — it cannot accumulate evidence across runs, products, or a model swap, and it cannot be
audited. Reply-rate learning is a statistics problem over months of sends, so it lives in data the
Sheet keeps and the agent *queries*. The agent never remembers a segment's performance; it looks it
up.

The reading/ranking logic is `n8n-workflows/segment-scoring.js` (pure functions, no deps — runs in a
Code node, in `node`, or in a test), and `n8n-workflows/test-segment-scoring.mjs` covers it.

| Column | Notes |
|---|---|
| `segment_key` | `source_config\|role_bucket\|industry_bucket\|size_band` — lowercase, pipe-delimited, fixed 4 parts. Built by `buildSegmentKey()`; reversible with `parseSegmentKey()` |
| `source_config` | which product config (`oryoniq`, `visioneerit`, ...) — same meaning as on `Leads`. One engine, many products: OryonIQ's capture buyers and VisioneerIT's CISOs are different markets and must never be pooled |
| `role_bucket` | normalized job family: `capture_bd`, `proposal`, `contracts`, `it_leadership`, `security`, `engineering`, `program_pm`, `exec`, `sales`, `marketing`, `finance`, `hr`, `operations`, `other`, `unknown` |
| `industry_bucket` | `gov_defense`, `it_software`, `prof_services`, `industrial`, `healthcare`, `financial`, `education`, `nonprofit`, `other`, `unknown` |
| `size_band` | `1-10` / `11-50` / `51-200` / `201-500` / `501-1000` / `1001+` / `unknown`. The 500 line is the SBA small-business employee threshold — for OryonIQ it is the most decision-relevant fact about a company's size |
| `sent` | every send ever attempted into this bucket |
| `bounced` | of those, hard bounces — they never had a chance to reply |
| `pending` | sends still inside the reply window (no reply *yet* is not the same as no reply) |
| `sample_size` | **the denominator of every rate in this row** = `sent - bounced - pending`. Kept as its own column so a reader never has to reconstruct it, and so the sample gate has one unambiguous number to check |
| `replied` | any reply, of any sentiment |
| `positive` | replies OpenAI classified `positive` (same classifier as `Leads.reply_sentiment`) |
| `reply_rate`, `positive_rate` | `replied`/`sample_size` and `positive`/`sample_size`. **Blank when `sample_size` is 0** — never `0`, never `#DIV/0!` |
| `reply_rate_lb`, `positive_rate_lb` | Wilson 95% score-interval **lower** bounds. These, not the raw rates, are what ranking sorts on |
| `confidence` | `insufficient` (<50) / `low` (50–199) / `moderate` (200–499) / `high` (500+). `insufficient` is the only one that changes behaviour — it blocks ranking outright |
| `first_sent_at`, `last_reply_at` | ISO timestamps; bound the window the row's evidence covers |
| `last_updated` | ISO timestamp of the last recompute |
| `notes` | free text — e.g. a copy change that makes older sends in this bucket non-comparable |

### The sample gate, and why it is non-negotiable

**`rankSegments()` refuses to rank any segment with fewer than 50 matured sends, and it does not
compute a rate for one.** Ungated segments come back in a separate `insufficient` list carrying
counts only, with `reply_rate: null`.

The reason is specific and not academic. Early in a pilot every bucket has a handful of sends, and
1 reply from 2 sends reads as "50% — target these people". It is not a 50% reply rate; it is one
event. An LLM handed that number will act on it and argue for it fluently, and the argument will be
persuasive because the number is real — it is just meaningless. The money is spent on Apollo
reveals and Instantly sends against a pattern that does not exist.

A statistic alone does not save you. Ranking on the Wilson lower bound is strictly better than
ranking on the raw rate, but check the arithmetic: 1/2 has a Wilson LB of **9.5%** while 60/1000 has
**4.7%**. The coin flip still wins. Wilson penalises small samples; it does not penalise them
anywhere near enough in the single digits, because no interval can extract information from a
sample that contains none. So the gate sits **on top of** the statistic, not instead of it — gate
first, then rank the survivors by Wilson LB.

The second rule is a corollary: **every rate this tab produces travels with its `sample_size`.**
A percentage without its denominator is the exact thing that makes a low-n result persuasive.

**Escaping the gate.** `targetingWeights()` reserves 20% of future sends for segments that have not
reached 50. Without that reserve the gate is a trap — a bucket stuck at 12 sends would never be
targeted, so it would never reach 50, so it would never be evaluated, and the pilot would freeze its
earliest and noisiest picture in place permanently.

**How much volume this needs before it means anything.** 50 sends is a floor, not a threshold of
trust: at a 5% reply rate it buys ~2.5 expected replies. Actually separating a 4% segment from an 8%
one (80% power, 5% alpha) takes roughly **550 matured sends per segment**. So query rolled up first
— `rankSegments(rows, {dimensions: ['source_config','role_bucket']})` marginalises the other
dimensions and renders them `*` — because ~4 live role buckets are decision-grade at ~2,200 sends,
whereas the full four-way key runs to 70–130 live segments and would need 30,000+. **Store the full
key; query the roll-up.** You cannot recover a dimension you never wrote down.

---

**Why five tabs, not one:** `Leads` is the operational pipeline every workflow reads/writes live;
`Suppression` is a compliance-critical append-only log that must never be touched by a routine
write; `Events` is a per-lead audit trail of actions taken; `Costs` is a per-tool metering log that
has nothing to do with any individual lead's state (and can't be folded into `Events`, because not
every cost is lead-attributable — subscriptions and inbox warmup aren't); `Segments` is aggregate,
not per-lead at all, and is the only tab that is *derived* — it can be recomputed from `Leads` +
`Events` if it is ever corrupted, which none of the other four can. Keeping them separate means a
bug in the pipeline tab can't accidentally corrupt suppression history, cost data, or the targeting
memory.

---

## Tab 6 — `Inbox` (the human front door) — LIVE since 2026-08-29

**The only tab staff are meant to type into.** Every other tab is written by workflows and read by
humans; this one is the reverse. Leads that do not come from Apollo — a Warmly export, a purchased
list, a conference scan, a colleague's spreadsheet — get pasted here in whatever shape their source
gave them, and `VIO-inbox-mapper` (WF-8, `VIOwfHinboxmap`) normalises them onto `Leads` every two
minutes.

**There is no fixed header row.** That is the point: an uploaded sheet's columns will not match
ours, and telling staff to rename 12 columns by hand before pasting is how a lead list stops
getting used. Paste the source's own headers. The mapper knows ~60 spellings (`Email`, `E-mail
Address`, `Work Email`, `Company`, `Organisation`, `Full Name`, `Website`, `Job Title`, …) and
falls back to OpenAI for headers it has never seen.

**Four columns are OURS and are never treated as lead data.** Leave them blank when pasting:

| column | who writes it | meaning |
|---|---|---|
| `status` | the mapper | **Blank = unclaimed.** Becomes `mapped` or `needs_review`. |
| `notes` | the mapper | Why a row was not imported, plus any unrecognised column names. |
| `mapped_lead_id` | the mapper | The `contact_email` the row became in `Leads`. |
| `source_config` | you (optional) | Defaults to `Manual`. |

**Blank `status` is the claim marker, so never pre-fill it.** Typing anything into `status` on a
fresh row makes the mapper skip that row forever.

**A row needs an email, a first name, and a company to import.** Less than that produces an email
addressed to nobody about nothing, so it is written back `needs_review` with the reason — it is
never silently dropped.

**You can type at your own pace.** The poll fires every two minutes, including mid-edit. A row with
**no email address yet** is left completely alone — not claimed, not flagged — because no address
almost always means "still typing" rather than "broken". Fill the address last if you like. (A row
that *has* an address and is still missing something is genuinely incomplete and does get flagged.)

**Large uploads drain in batches of 50 per cycle.** A 49,000-row paste is normal and will not
break; it simply imports over successive polls rather than all at once.

**Two things the mapper fixes or flags that are worth knowing about:** ALL-CAPS values are
title-cased (a real list gave `ROBERT` / `TRUSTED SOLUTIONS LLC`, and `Hi ROBERT,` reads as
shouting at a stranger — `LLC`, `INC`, `GSA`, `DOD`, `AI`, `IT` stay upper). And a first name that
does not appear anywhere in the email address is **flagged, not corrected** — seen live as `ANGELA
SPEASE` against `Kevin.Spease@`, which is one person's name pasted next to another's address. The
mapper will not guess which one is right; the `notes` column asks you to check.


---

## Tab 7 — `System` (is it alive?) — LIVE since 2026-08-30

**One row per scheduled workflow, rewritten on every cycle.** It holds no lead data at all. It
exists to answer one question a staff member cannot otherwise answer from inside the spreadsheet:
*is anything actually running?*

Both schedules are silent by design when there is nothing to do — the mapper's chain literally
stops at the sheet read when no row is claimable — so **"working, nothing to do" and "dead" looked
identical**. This tab separates them.

| column | means |
|---|---|
| `workflow` | which poller, in plain words (`VIO-inbox-mapper (reads your Inbox)`) |
| `last_run_at` | when it last looked, in local time — not UTC |
| `checked` | how much it saw (`5 row(s) in Inbox`) |
| `waiting` | how many rows are not yet processed |
| `last_result` | what it concluded (`all rows imported, nothing waiting`) |
| `every` | its interval (`2 min` / `3 min`) |
| `next_check_at` | when the next look is due |

**How to read it:** if `last_run_at` is within roughly one interval of now, the system is alive.
If it is stale by several intervals, something is wrong — check the Slack error channel.

**Two design points worth keeping.** The heartbeat hangs off the sheet READ, not the schedule
trigger, so it reports what was actually seen rather than merely that a timer fired; and it is the
FIRST branch off that read, so a failure further down the chain cannot swallow it. Its write is
`onError: continueRegularOutput` — a status row must never be able to break the run it is only
reporting on.

**`waiting` counts rows not yet imported, not rows about to be.** A row still being typed (no email
address yet) is counted here but deliberately skipped until it is finished, so the wording avoids
promising to pick it up this cycle.
