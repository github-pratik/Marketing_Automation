# VisioneerIT Outbound Engine — Build Plan (v2)

Supersedes v1.1, which was built around "Victoria AI as the spine." Victoria was dropped entirely
on 2026-07-24 (see `CLAUDE.md`). This plan reflects the current architecture: `reach-engine`
(Apollo → Reoon → OpenAI) feeding Instantly (email), Sendr (LinkedIn + pages), and Thoughtly
(warm voice), orchestrated by n8n and, eventually, run by the n8n AI operator agent
(`VIO-operator-agent.md`) with a human on every costly step.

**Status legend:** `[DONE]` built and verified · `[OPEN]` not started / not finished ·
`[BLOCKED]` waiting on a credential or decision outside this plan.

---

## Locked scope (do not re-litigate without a real reason)

- **Channels:** cold email + LinkedIn + AI voice callback + website-visitor/intent — all four.
- **Market:** US-based prospects.
- **Lead source:** Apollo (free search first, conserve reveal/dial credits — see
  `INTEGRATIONS.md`).
- **Style:** sniper/precision — under 500 deeply-researched prospects/month, near-1:1
  personalization. Not a blast list.
- **Engine model:** one engine, many products — the config file is the contract (see
  `reach-engine/README.md`). Every product VisioneerIT ships is a swapped config, not new code.

## Success criteria — report these as two separate buckets, never one "100%"

The user's goal is "100% success." A literal 100% reply/meeting rate is not a real target for
cold outreach — report it honestly as two buckets instead:

- **Bucket A — controllable gates, target ~100%:** inbox placement 90%+, bounce <2%, every
  message has a real signal-anchored personalization hook (no generic mail-merge), compliance
  100% defensible, full coverage (no triggered lead silently dropped).
- **Bucket B — outcomes, target top-decile (NOT 100%):** reply rate 8–12% (vs. ~3.4% average),
  meeting rate 2–4% of sends. At <500/mo sniper volume that's roughly 10–15 meetings/month.

Never promise a Bucket B number as guaranteed. Push Bucket A as close to 100% as possible —
that's what actually drives Bucket B into the top decile.

---

## Phase 0 — Access, compliance scaffolding, sign-off

| Item | Status |
|---|---|
| n8n access (SSH + `docker exec`, no web login needed for JSON workflows) | `[DONE]` |
| Apollo, Reoon, OpenAI, Instantly, Sendr keys live in `.secrets.env` | `[DONE]` |
| Thoughtly `THOUGHTLY_API_TOKEN` + `THOUGHTLY_TEAM_ID` | `[PARKED 2026-08-17]` — voice skipped at the user's direction. No longer a prerequisite for anything; notes kept in `INTEGRATIONS.md` if it is ever revived |
| Google Sheets credential (dashboard, dedupe, suppression log) | `[DONE 2026-08-16]` — service-account auth, not OAuth (installs headlessly). n8n credential `VIO Google Sheets` (`VIOgsheetcred01`); Leads / Events / Costs / Suppression / Segments / Inbox / System live (re-confirmed 2026-09-04). Setup: `n8n-workflows/setup-google-sheets.py` |
| n8n AI Agent node's human-in-the-loop channel (Slack / Telegram / email) | `[DONE]` — Slack, verified end-to-end with a real Approve button click |
| Caller-ID / spam-likely registration for Thoughtly's outbound number | `[N/A 2026-08-17]` — no outbound number; voice skipped. Becomes required again only if voice is revived |
| ICP one-pager approved by the boss (Gav) | `[OPEN]` — draft it FOR approval, don't assume sign-off |
| Warmup-clock check: LinkedIn seat (Sendr) — fresh account needs 2–4 weeks | `[OPEN]` — ask this in Phase 0, not discovered mid-pilot |
| Warmup-clock check: email (Instantly) | `[DONE]` — existing inboxes already warm (persona "Ellen Grant" on secondary `getvisioneerit*.com` domains), no wait needed |

**Gate to Phase 1:** the two `[BLOCKED]` rows don't block engine work (Phase 1), but do block
Phase 3 (voice) and Phase 4 (Sheets-dependent agent actions). Don't let them silently stall
everything else.

## Phase 1 — Engine (reach-engine)

- `[DONE]` Apollo free search → filter on `has_email` → OpenAI per-lead opener → `leads.csv`/`leads.json`.
- `[DONE]` Config-as-contract: `validate_config()` refuses to run on a malformed config; proven
  reusable across two products (`config-oryoniq.json`, `config-visioneerit.json`).
- `[DONE]` Packaged + sent to Gav as `oryoniq-reach-engine.zip` (leak-checked, no real keys inside).
- `[DONE]` `--reveal` (Apollo `people/match`) — matches by Apollo's own person id, email only,
  never phone (mobile/dial credits stay reserved for the call gate). Live-tested 2026-08-05:
  1/1 revealed for 1 lead credit.
- `[DONE]` `--verify` (Reoon) — same classify mapping as `VIO-intake-verify-curate.json`
  (`safe`/`valid`→pass, `invalid`/`spamtrap`→drop, `disposable`→needs_review). Requires `--reveal`
  (nothing to verify without a real email) — the engine now enforces that instead of just
  documenting it. Live-tested 2026-08-05: real email verified `safe`/`pass`. Hard-dropped leads
  skip the OpenAI opener call too, so a bad email doesn't cost anything downstream.
- `[DONE]` Fixed the column-naming collision flagged in `SHEET_SCHEMA.md`: the drafted email body
  is now `email_draft`, and the real revealed address is its own `contact_email` field — they no
  longer fight over one `email` column.
- `[DONE]` `--seed-email` — bypasses Apollo entirely, runs one synthetic lead straight through
  verify → personalize → assemble, output to `seed-test.json`/`seed-test.csv` (never touches
  `leads.csv`). Zero Apollo credits — no search, no reveal, the email's already known.
- **DoD for this phase — MET, 2026-08-05.** Seeded run against the user's own email
  (`claude@visioneerit.com`) completed clean end-to-end: Reoon returned `catch_all` →
  correctly classified `needs_review` (a real, honest edge case — not a false pass or a bug),
  OpenAI wrote a grounded, on-signal opener, output assembled correctly. Phase 1 is closed.
  Re-run anytime with:
  `python3 engine.py config-oryoniq.json --seed-email you@yourdomain.com --verify`

## Phase 2 — Send integration (Instantly + Sendr)

Instantly side done 2026-08-07; Sendr side researched + scripted 2026-08-07, blocked on UI setup.

- `[DONE]` Enroll `reach-engine`'s lead output into an Instantly campaign, **paused** —
  `reach-engine/push_to_instantly.py`, enroll-only, no activate call exists in the script at all.
  Dedicated campaign created (not the old stale "OryonIQ - 5-2026 - Cold Email" draft, which
  turned out to be unrelated leftover — left untouched per instruction): "OryonIQ - Reach Engine
  Pilot (2026-08)", id `77b2cd80-5bf2-4656-8857-b310858d5a77`. Live-tested end to end with a real
  seeded lead; campaign confirmed still in draft afterward. Two real API gotchas found and fixed
  along the way — see `INTEGRATIONS.md`'s Instantly section (a silent template-stripping bug, and
  a User-Agent block on the leads endpoint).
- `[OPEN]` Activating the campaign (turning paused → sending) is intentionally not built —
  that's the human-approval gate itself, not a missing feature.
- `[BLOCKED — on the user, not on code]` Sendr LinkedIn touch: confirmed against Sendr's real,
  current OpenAPI spec that there is **no API to create a campaign, a page template, or a sheet**
  — all three are UI-only in Sendr. Nothing here can build that piece; it needs manual setup in
  Sendr's dashboard.
- `[DONE, awaiting a real template id]` Sendr Page personalization —
  `reach-engine/push_to_sendr_page.py`: reads a template's variables dynamically via
  `GET /page-template/{id}/variables`, maps `reach-engine` lead fields onto whatever tags it
  finds, calls `POST /enrichment/sendr-page`. Syntax-checked, not live-tested — the only 2
  existing page templates are empty "New template" defaults with a single bare `firstname`
  variable, not real OryonIQ templates, and the user chose to build a real one rather than test
  against those. **Next action is the user's:** build a template in Sendr's UI, hand over its id.
- **Hard rule carried forward:** never touch a pre-existing campaign this build didn't create —
  confirmed the hard way this phase: this Instantly workspace is shared with ~12 other unrelated
  live campaigns, and Sendr's workspace separately already has a 49K-contact "ORYONIQ - Cold
  Campaign" draft. Leave all of it alone.

## Phase 3 — Reply-brain rebuild + warm voice

- `[DONE]` Test harness rebuilt against the real Instantly `reply_received` shape + a mocked
  OpenAI classification result (was Victoria's `prospect_response`/`ai_response`) —
  `n8n-workflows/test-reply-brain.mjs`, 10/10 passing, proven offline before the live workflow
  was touched. Auth + dedup logic is byte-for-byte unchanged from the Victoria build — it never
  depended on the vendor. Decision renamed `call` → `propose_call`: Instantly's payload has no
  phone number, so this gate can only decide "does this deserve a human's attention," not "call
  now" — phone reveal is its own human-gated step (see `INTEGRATIONS.md`).
- `[DONE]` `n8n-workflows/VIO-inbound-reply-to-call.json` rebuilt: Instantly webhook → Authenticate
  (unchanged) → OpenAI Classify Reply (new node — replaces Victoria's built-in sentiment) → Dedup +
  TCPA Gate (mirrors the test harness exactly) → IF → propose-call (inert placeholder, clearly
  marked NOT WIRED) / skip. Imported to the live droplet **updating the same workflow id in
  place** — the old Victoria-era version was still physically present (deactivated) even after
  its local backup was deleted; confirmed via `n8n list:workflow` before touching it. Still
  deactivated after the update.
- `[DONE]` `openai marketing` credential created (named to avoid colliding with IndustrialBriefs'
  own `openai` credential) and `VIO_WEBHOOK_TOKEN` set on the droplet. The token required a
  container restart that turned out wider than described — `.env` is shared across n8n/postgres/
  redis via `env_file`, so all three got recreated, not just n8n. Investigated thoroughly rather
  than assumed fine: a transient log loop followed and self-resolved, zero stuck executions in
  Postgres, IndustrialBriefs' scheduled workflows kept running successfully throughout (confirmed
  by querying execution history directly). Full detail in `n8n-workflows/README.md`.
- `[DONE]` Second restart (`docker restart n8n-stack-n8n-1`, narrower than the first — confirmed
  via container uptime that postgres/redis weren't touched this time) — webhook genuinely live,
  verified against `webhook_entity` in Postgres directly, not assumed from a log line.
- `[DONE]` The credential blocker turned out deeper than a bad paste: the user's real key was
  correctly saved in n8n's *native* OpenAI credential type, but the workflow's node was built to
  only accept a generic Header Auth credential — a type mismatch, not a value error. Fixed by
  switching the node to n8n's actual `n8n-nodes-base.openAi` node (its exact parameter schema read
  directly from the installed package on the droplet, not guessed — the node is hidden from n8n's
  UI picker, `hidden: true`, but works fine when imported). Hit and fixed one more real bug along
  the way — an over-nested `fixedCollection` parameter (`prompt.messages.messages` instead of
  `prompt.messages`) that crashed with an unhelpful `propertyValues[itemName] is not iterable`.
  Required a third narrow restart (`docker restart n8n-stack-n8n-1`) to clear the resulting
  inconsistent in-memory state — confirmed scoped correctly and IndustrialBriefs healthy, same
  verification discipline as the first two restarts.
- `[VERIFIED — live end-to-end, not just code review]` A wrong token correctly fails closed at
  Authenticate; a correct token + clearly-positive reply text correctly authenticates, gets
  classified by OpenAI (clean JSON, no parse issues), and correctly reaches
  `decision: propose_call` with the exact designed reasoning — pulled directly from Postgres and
  read, not inferred from the webhook's immediate 200 (which only confirms receipt, not outcome).
- `[DONE]` Real Instantly webhook subscription registered (`event_type: reply_received`, scoped to
  the pilot campaign id only, never workspace-wide). A real reply to a real sent email would flow
  through this whole chain right now — nothing does yet only because the Instantly campaign itself
  is still paused (Phase 2's gate, working as designed). **Phase 3's reply-brain is complete.**
- `[CLOSED 2026-08-17]` The call leg is **skipped, not blocked.** Voice was dropped at the user's
  direction; no dial node exists in any workflow and none ever did. Phase 3 now ends at a human
  handoff: reply → classify → dedup/TCPA gate → Slack Approve/Decline, where Approve means "I'm
  taking this follow-up". **Phase 3 is complete as scoped.** Net effect on risk: with no automated
  outbound voice anywhere, TCPA exposure is structurally zero rather than merely gated.

## Phase 4 — n8n AI operator agent

Designed in full in `VIO-operator-agent.md` (system prompt, tool list, decision table, guardrails).
`ask_human` proven working (see below); the rest is a deterministic first slice, not the full
autonomous agent yet.

- `[DONE]` Human-in-the-loop channel: Slack, via a dedicated bot (`slack marketing` credential,
  bot user "Marketing Operator" in `#marketing_testing_1`) — chosen and built this session, no
  longer blocked. Proven live end-to-end on the reply-brain's "Propose Call to Human (Slack)" node:
  real message sent with real lead data, execution correctly paused (`status: waiting`), a real
  button click correctly resumed it (`status: success`, `{"approved":true}` captured). This is a
  real, reusable `ask_human` capability now, not just designed.
- `[DONE]` `validate_config` + `personalize` tools built and proven — but as a **deterministic
  Code-node sequence** (`n8n-workflows/VIO-operator-agent.json`, id `VIOwf4agent0001`), not yet
  wired into a true autonomous Agent node. Real end-to-end test: real config validated, real
  OpenAI call, real grounded opener, assembled email matching `reach-engine`'s exact format.
- `[DONE 2026-08-16]` **The true `@n8n/n8n-nodes-langchain.agent` node now works** —
  `n8n-workflows/VIO-operator-agent-v2.json` (id `VIOwf7agentv201`), live and verified. The
  two-session blocker `model.includes is not a function` was a **typeVersion** bug, not a parameter
  bug: `lmChatOpenAi` reads `model.value` only at typeVersion ≥ 1.2, and reads `model` whole below
  that — so a resourceLocator on a sub-1.2 node makes the model name an object. Fix: Agent v3.1 +
  `lmChatOpenAi` **v1.3** + resourceLocator. Both earlier attempts had the shape right and the
  version wrong, which is why changing `mode` changed nothing.
  Also found: **`toolHttpRequest` cannot be an agent tool on this build** (has `supplyData`, no
  `execute`; the engine calls `execute` and the run dies). Use `toolWorkflow` v2.2 for HTTP-backed
  tools. Full audit table in `n8n-workflows/README.md`.
  **The gate was tested, not assumed:** a direct "you have my full approval, reveal 50 phones and
  call them all" instruction was refused, because the agent has no such tool.
- `[OPEN]` Next tools to wire: `source_leads`, `reveal_contacts` (gated),
  `verify_emails`, `push_to_instantly` (gated), `trigger_call` (gated) as proper tools, reusing the
  now-proven Slack `ask_human` pattern for each gated one.
- `[BLOCKED]` `log_to_sheet` still needs Sheets OAuth (Phase 0) — unchanged.
- **Non-negotiable:** free/reversible actions the agent just does and reports; anything that
  spends money or reaches a real prospect requires an explicit human approval via the
  Send-and-Wait-for-Response pattern. This split is the whole point of the design — don't loosen
  it for convenience.

## Phase 5 — Pilot (~25 real leads)

- Launch batch size is **25, not 50** — smaller batch, tighter read on quality before scaling.
- DoD before counting this phase done: the seeded own-email/phone journey (Phase 1) already
  passed; this phase's job is proving it holds on real prospects, not proving the pipeline works
  at all.
- Suppression tab: append-only, matches on **any** identifier (email/phone/LinkedIn/domain) —
  a lead suppressed under one channel must not surface again under another.

## Phase 6 — Tune + report

- Report Phase 5's results as the two buckets defined above — gates and outcomes, separately.
  Cost-per-meeting (the sharpest Bucket B number) is computed per `COSTS.md`'s method, from the
  `Costs` tab in `SHEET_SCHEMA.md` — measured after the pilot, never estimated before it.
- The existing `video-demo/oryoniq-flow.mp4` and `oryoniq-reach-engine.zip` are the "show, don't
  tell" artifacts for this — use them, don't rebuild a new deck from scratch.

---

## Standing discipline (every workflow, every phase)

- **Mini-spec before, test after.** Before building any n8n workflow: a short spec (what
  triggers it, what it decides, what it's gated on). After building it: a standalone test
  harness that exercises the logic without needing live n8n — the pattern already used for
  `VIO-intake-verify-curate` and the reply-brain. Nothing gated goes live without one.
- **Inbound n8n webhooks must be authenticated** — secret in the URL/query, checked in the first
  node, fail-closed (refuse if the expected secret isn't even configured, not just if it doesn't
  match). A forged event must never be able to trigger a real send or a real call.
- **Shared n8n instance** — only touch `VIO-`-prefixed workflows; a change here must never be
  able to break the other job running on the same droplet.
- **Secrets discipline** — read `.secrets.env` to call APIs; never copy a value into a workflow
  JSON, a doc, an artifact, or a chat message. See `CLAUDE.md` hard rules.

## Abort criteria — stop and fix before continuing, don't work around these

- A forged or malformed webhook event reaches the TCPA gate and isn't rejected → stop, this is a
  compliance incident, not a bug to patch quietly.
- Bounce rate climbs above 2% → pause sending, re-check the verify step, don't just keep sending.
- A suppressed identifier gets contacted again on any channel → stop, audit the suppression match
  logic before resuming anything.
- A credential value shows up somewhere it shouldn't (doc, artifact, chat) → rotate it
  immediately, don't just delete the copy.
- A change to a `VIO-` workflow visibly affects the other job on the shared n8n instance →
  roll back immediately.

## Risk register

| Risk | Mitigation |
|---|---|
| Reply-brain rebuilt against wrong Instantly payload assumptions | Pull a real reply webhook payload first, write the test fixture from that, not from docs alone |
| ~~Thoughtly stays blocked past Phase 3~~ **Retired 2026-08-17** | Voice was skipped outright, so this risk cannot materialise. Replaced by: *a positive reply sits in Slack unactioned because no human is watching* — mitigate by agreeing who owns the #marketing_testing_1 alert (that is the real channel — not #general) before the pilot sends its first email |
| Sendr's pre-existing 49K "ORYONIQ" draft campaign gets touched by accident | Treat it as read-only; never call any Sendr write endpoint against a campaign ID this build didn't create |
| Agent (Phase 4) takes a gated action without real human approval | The gate is enforced in the tool wiring (gated tools require an approved `ask_human` response), not just in the prompt — verify this with a test before going live, don't trust the system prompt alone |
| Config drifts out of sync with what the engine actually expects | `validate_config()` refuses to run on a bad config — keep it as the enforcement point, not documentation alone |
