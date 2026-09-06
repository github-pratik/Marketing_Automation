# Integrations — auth, endpoints & access status

Every tool's auth, base URL, endpoints in use, n8n credential name, and current access status.
Update the status lines as access changes — this is the "is X actually usable right now" board.
See `CLAUDE.md` for how this fits the wider project; see `reach-engine/README.md` and
`VIO-operator-agent.md` for how these get orchestrated.

**Convention:** secrets live in `.secrets.env` (root) and `reach-engine/.secrets.env` — this doc
references key **names** only, never values. n8n credentials are separate: created in the n8n UI,
`VIO `-prefixed, referenced by name (never inline) in workflow JSON.

**Status legend:** `[LIVE]` wired into working code/workflow · `[KEY ONLY]` key confirmed live,
not yet wired into anything · `[BLOCKED]` missing a credential.

## Apollo — sourcing

- **Base:** `https://api.apollo.io/api/v1`
- **Auth:** header `X-Api-Key: <APOLLO_API_KEY>`
- **Free search:** `POST /mixed_people/api_search` — names, titles, `has_email` / `has_direct_phone`
  flags. Costs **0 credits**. This is the only Apollo call `reach-engine/engine.py` makes today.
- **⚠️ What the FREE search actually returns — verified live 2026-08-22, and it is less than the
  code assumed.** A `mixed_people/api_search` person carries only: `id`, `first_name`, `title`,
  `has_email`, `has_direct_phone`, `has_city/state/country`, `last_name_obfuscated`,
  `last_refreshed_at`, and an `organization` object. Three traps:
  - **No surname.** `last_name` does not exist; only `last_name_obfuscated` (e.g. `"B."`).
  - **No company domain.** `organization` has `name` plus `has_*` booleans — **no
    `primary_domain`, no `website_url`**. `engine.py`'s `org_domain()` comment claims the domain
    "comes back on Apollo's unpaid search". **It does not.** This matters beyond tidiness:
    `company_domain` drives Sendr's `gifSource: dynamic-website`, so without it the personalized
    page silently degrades to a generic preview instead of the lead's own site.
  - **`has_direct_phone` is a STRING, not a boolean** — literally
    `"Maybe: please request direct dial via people/bulk_match"`. `Boolean()` on that is `true`, so
    a naive coercion marks every lead as having a confirmed direct dial. Treat it as tri-state.
  Response top level is `{people, total_entries}` — there is no `pagination` object.
- **⚠️ `q_keywords` is a LITERAL TEXT MATCH, not an industry filter — measured live 2026-09-05.**
  Both product ICPs defaulted it to `government contracting` / `government`. On the same title set
  that phrase cut **168,759 matching people to SEVEN**, and adding any second filter took it to
  zero. The hardcoded search had therefore been returning almost nobody since it was written, and
  it read as a narrow market rather than a broken filter. It is now **empty by default**; targeting
  is `person_titles` + `person_seniorities` + `person_locations` + `organization_num_employees_ranges`
  (measured: 490 people for one US state at 51-200 staff). `q_keywords` stays available as a
  deliberate narrowing tool — it works, it is just far sharper than it reads.
- **Filter formats that bite:** `person_locations` wants `"Virginia, US"`, not `"Virginia"` — a bare
  state does not reliably match. `organization_num_employees_ranges` wants `"51,200"`, so the comma
  is INSIDE a band and cannot also separate bands (VIO-source-leads separates them with `;`).
- **Paid reveal:** `POST /people/match` — spends lead credits. Matched by Apollo's own person
  `id` (from the free search, no ambiguity), `reveal_personal_emails: true`. Only ever called on
  the already-filtered survivor list, never the raw search results — search wide for free, reveal
  only who's worth it. **Email only** — the engine never requests a phone number here.
- **Status:** `[LIVE]` — wired into `reach-engine/engine.py` (`apollo_search()`, `apollo_reveal()`
  behind `--reveal`). Live-tested 2026-08-05: 1/1 revealed for 1 lead credit.
- **⚠️ `people/match` DOES NOT FAIL ON AN UNKNOWN ID — it returns a different person.** Proven live
  2026-09-05: a request for `000000000000000000000000` came back **HTTP 200 with someone else's
  record on it**. So "the call succeeded" says nothing about who was returned. Had that person
  carried an email, a stranger nobody chose would have entered the outbound pipeline and been
  billed for. `VIO-apollo-reveal :: Shape for intake` now checks the echoed `person.id` against the
  ids actually requested and **discards a substituted person entirely** — address, name, company and
  domain — rather than merely not using them; a rejected person's details have no business in our
  audit log either. The Events row records the substituted id so the event stays traceable.
- **`reveal_personal_emails` is FALSE in n8n and TRUE in `reach-engine/engine.py`.** The n8n path
  wants the work address: a personal inbox is worse for deliverability, worse for reply rate, and a
  colder thing to do to someone who has never heard of us. **Reconcile `engine.py` to n8n, not the
  other way round.**
- **Guard:** mobile/direct-dial reveal is the scarce credit — spend it only on a confirmed
  positive-reply lead heading to Thoughtly, never the whole list.

## Reoon — email verification

- **Base:** `https://emailverifier.reoon.com/api/v1`
- **Auth:** **query param**, not a header — `?key=<REOON_API_KEY>`. (n8n gotcha: the Query Auth
  credential's param **name** must be exactly `key`, not e.g. "Reoon key".)
- **Endpoint in use:** `GET /verify` (power mode).
- **n8n credential:** `VIO Reoon` (Query Auth).
- **Classify mapping** (see `n8n-workflows/VIO-intake-verify-curate.json`): `safe` / `valid` →
  pass; `invalid` / `spamtrap` → drop; `disposable` → **needs_review** (Reoon false-flags
  greylisted corporate domains as disposable — don't auto-drop on it); anything else →
  needs_review.
- **Status:** `[LIVE]` in n8n — verified end-to-end in `VIO-intake-verify-curate` (built,
  deactivated, tested 2026-07-19). **Also live in `reach-engine/engine.py`** now (`reoon_verify()`
  behind `--verify`, requires `--reveal` first) — same mapping as the n8n node, kept in sync on
  purpose. Live-tested 2026-08-05: real revealed email verified `safe`/`pass`.

## OpenAI — the LLM brain

- **Base:** `https://api.openai.com/v1`
- **Auth:** header `Authorization: Bearer <Openai_api_key>` — note the key's lowercase/mixed name
  in `.secrets.env` (`Openai_api_key`, not `OPENAI_API_KEY`).
- **Endpoint in use:** `POST /chat/completions`, model `gpt-4.1-mini` (default; `--model` to
  override).
- **Does two jobs:** (1) writes the per-lead opener in `reach-engine/engine.py`
  (`openai_opener()`) from the config's `signal` + `personalization_prompt`; (2) will classify
  reply sentiment for the rebuilt reply-brain workflow, replacing Victoria's old built-in
  `prospect_response.sentiment` — **not yet built**.
- **Status:** `[LIVE]` — wired into `reach-engine/engine.py`. Sentiment-classification use is
  designed (`VIO-operator-agent.md`) but not implemented.

## Instantly — email send + warmup

- **Base:** `https://api.instantly.ai/api/v2`
- **Auth:** header `Authorization: Bearer <INSTANTLY_API_KEY>`
- **Role:** replaces Victoria as the email sender. Warmed inboxes already exist (persona "Ellen
  Grant" on secondary `getvisioneerit*.com`/`getoryoniq.com` domains) — no warmup wait needed.
  **Do not touch** any existing campaign this build didn't create — this is a **shared workspace**
  with ~12 other unrelated live campaigns (other clients/pitches), not VisioneerIT-exclusive.
- **Campaigns:** `POST /campaigns` (create), `PATCH /campaigns/{id}` (update, e.g. sequences —
  only the first `sequences[0]` array element is read), `GET /campaigns/{id}`. Created campaigns
  start in **draft** (`status: 0`) — creating one does not send anything; a separate activation
  action does, which nothing in this repo calls.
- **⚠️ `PATCH /campaigns/{id}` with a `sequences` body can REACTIVATE the campaign — it is
  state-dependent.** From `status: 3` (completed) a sequences PATCH flipped it to `status: 1`
  (active, sending) on 2026-08-21. From `status: 2` (paused) the same shape of PATCH left it
  paused on 2026-08-22. So pausing first is a real mitigation, not just hygiene — but the
  rule stands regardless: **always `GET` the status straight after any PATCH and pause if it
  moved.** The response body says nothing about the change either way. Original note:
  Verified
  2026-08-21: a campaign sitting at `status: 3` (completed) was flipped to `status: 1` (active,
  sending) purely as a side effect of updating its email template. The response is a bare `200`
  and says nothing about the status change — the only way to see it is to `GET` the campaign
  afterwards. Nothing sent in that instance because the schedule window happened not to dispatch,
  which is luck, not a safeguard. **Always `GET` the campaign's `status` immediately after any
  `PATCH`, and `POST /campaigns/{id}/pause` if it moved.** Editing copy is supposed to be a safe,
  reversible act; on this API it is not.
- **⚠️ Custom variables must be sent as top-level `custom_variables`, never inside `payload`.**
  Instantly merges `custom_variables` into the lead's stored `payload`, where the campaign
  template reads them as `{{tagName}}`. Sending the identical key nested inside a `payload` object
  instead returns `200`/`201` and **silently discards it** — verified on both `POST /leads` and
  `PATCH /leads/{id}`. Standard fields (`website`, `first_name`, …) persist either way, which
  makes the failure easy to miss. Same shape as n8n's inert `parameters.text` trap: success
  response, ignored field. Read the lead back and assert your key is in `payload` before trusting
  a template that references it.
- **Leads:** `POST /leads` to enroll (`campaign`, `email`, `first_name`, `company_name`,
  `job_title`, `personalization` — the last one is the exact field that merges into a template's
  `{{personalization}}` tag, and is where `reach-engine`'s per-lead `opener` goes). List with
  `POST /leads/list` — filter field is **`campaign`**, not `campaign_id`; the latter is silently
  ignored (returns unfiltered results, don't mistake that for an empty campaign). Delete with
  `DELETE /leads/{id}`.
- **Two real gotchas found live (2026-08-07), not in the docs:**
  1. **Bug:** a template body with **two or more distinct `{{merge}}` tags** combined with literal
     `<br/>` line-break tags gets silently stripped down to just the `<br/>`s and any `<a href>`
     links — all plain text vanishes, no error. `<div>`-wrapped paragraphs with the same tags are
     fine. Verified by isolating on a scratch campaign before touching the real one — always use
     `<div>` wrapping for multi-variable templates here, never bare `<br/>`.
  2. `urllib`'s default `Python-urllib/x.y` User-Agent gets a bare Cloudflare `error code: 1010`
     on the leads endpoint (`curl` with default headers works fine). `reach-engine`'s `http_json()`
     now sends a normal `User-Agent` on every request for this reason — don't strip it back out.
- **Status:** `[LIVE]` — wired via `reach-engine/push_to_instantly.py` (enroll only, paused,
  never activates). Live-tested 2026-08-07: real seeded lead enrolled into a dedicated new
  campaign (`OryonIQ - Reach Engine Pilot (2026-08)`, id `77b2cd80-5bf2-4656-8857-b310858d5a77`,
  template in `reach-engine/campaign-oryoniq-pilot.json`) with its real `reach-engine` opener as
  the `personalization` field, campaign confirmed still in draft.
- **Reply webhooks — real subscription system, unlike Sendr's UI-only campaigns:**
  `POST /api/v2/webhooks` (`GET`/`PATCH`/`DELETE` too), body `target_hook_url`, `name`,
  `event_type`, optional `campaign` (scopes the subscription to ONE campaign — use this, don't
  subscribe workspace-wide on a shared account), optional `headers`. Confirmed empty
  (`GET /webhooks` → `{"items":[]}`) as of 2026-08-07, no collision risk.
- **`reply_received` event** (from `developer.instantly.ai/guides/webhook-events`): fields include
  `campaign_id`, `lead_email`, `reply_text`, `reply_subject`, `email_id` (used as the dedup key —
  no explicit `idempotency_key` field like Victoria had). **No sentiment, no out-of-office flag, no
  phone number** — unlike Victoria's old `ai_response`, all of that is on VisioneerIT's side to
  add now. Out-of-office/auto-replies fire as a **separate** `auto_reply_received` event type —
  the reply-brain workflow doesn't subscribe to it, so those shouldn't reach the gate at all, but
  `n8n-workflows/VIO-inbound-reply-to-call.json`'s OpenAI classify step re-checks OOO independently
  anyway (defense in depth, in case Instantly's own detection has false negatives).
- **Registered and live:** subscription id `019fe8bd-9f94-7906-bd2a-bd896ad134ab`,
  `event_type: reply_received`, scoped to the pilot campaign id only (never workspace-wide on this
  shared account). Waited until the n8n side was actually ready to receive (credential + env var +
  activation, verified end-to-end — see `n8n-workflows/README.md`) before pointing a real
  subscription at it, per the project's own "an inactive webhook 404s silently" lesson from the
  Victoria build.

## Sendr — LinkedIn + personalized pages

- **Base:** `https://api.sendr.io`
- **Auth:** header `X-API-Key: <SENDR_API_KEY>`
- **Auth-check:** `GET /seat/me` — live-verified 200, workspace "VISIONEERIT", seat
  `pratik.patil@visioneerit.com`.
- **Real OpenAPI spec:** `https://api.sendr.io/openapi` (the docs page at `/docs` is a Scalar
  viewer that loads this — the spec URL isn't linked anywhere obvious, had to read the page's own
  `<script>` config to find it). Pulled fresh 2026-08-07 — full endpoint list below is verified
  against it, not memory.
- **Genuine platform constraint, confirmed against the live spec — not a gap in this build:**
  there is **no create/launch endpoint for campaigns, no create endpoint for page templates, and
  no create endpoint for sheets.** All three must be built in Sendr's UI first. The API can only:
  - **Campaigns:** `GET /campaigns`, `GET /campaigns/{id}` — read-only.
  - **Page templates:** `GET /page-template/list`, `GET /page-template/{id}/variables` — read-only.
    (Earlier notes said `POST /sheet` existed — it doesn't; corrected.)
  - **Sheets:** `GET /sheet`, `GET /sheet/{id}`, `GET /sheet/{id}/column` (read), and
    `POST /sheet/{sheetId}/row` (**add a row to an EXISTING sheet** — the only write endpoint on
    the enrollment side, and only useful if a real campaign already reads from that sheet).
  - **Page generation:** `POST /enrichment/sendr-page` — `templateId` + `variablesValues` (map of
    the template's own variable tags, read dynamically via the endpoint above — don't hardcode
    tag names), plus `gifSource` / `gifWebsiteUrl` / `videoBackgroundUrl` / `attributes` /
    `webhookUrl`. `GET /pages/{idOrSlug}` reads a generated page's current render state — the
    documented backup path when a webhook is delayed.
  - **Webhooks:** full `GET`/`POST`/`PATCH`/`DELETE /webhook` — signed, Sendr echoes a signing
    `secret` as an `X-Webhook-Secret` header, unlike the other tools here.

### Live product → campaign → template map (read from the account, 2026-08-10)

| Product | Sendr campaign | Page template | Config |
|---|---|---|---|
| OryonIQ | `10748` · OryonIQ - GovCon Capture/BD LinkedIn (sheet `jmaohm6rppfqj0xgvrs2f50q`) | `8462` · OryonIQ - GovCon Capture Page | `reach-engine/config-oryoniq.json` → `sendr` block |
| VisioneerIT | `10751` · VisioneerIT - Federal/SLED IT & Security LinkedIn (sheet `l4gqjtd62rp7jtqvjuu0z50i`) | `8464` · VisioneerIT - Zero-Trust Readiness Page | `reach-engine/config-visioneerit.json` → `sendr` block |

Both campaigns are `DRAFT`, 5 steps, 1 contact each. Untouched — Sendr has no add-lead-to-campaign
endpoint, so enrolment is a human action in the UI either way.

**Do not touch** the three older campaigns created by Gavriel Legynd
(`gavriel.legynd@visioneerit.com`), including the 49K-contact "ORYONIQ - Cold Campaign - May 2026"
(sheet `gdq4a7jro12aka8zzrcscdvo`). The two `3081`/`3080` "New template" defaults are empty
leftovers the API can't delete — harmless, unused.

### Three non-obvious behaviours, all found live — do not re-derive these

1. **`gifSource` must be sent explicitly, per lead.** A template whose GIF element is set to
   `dynamic-website` or `linkedin-profile` makes the API reject the *entire* request with
   `400 "gifWebsiteUrl is required when gifSource is dynamic-website or linkedin-profile"` unless a
   URL comes with it. Sending `gifSource` explicitly lets the caller degrade to `landing-page`
   (needs no external URL) for a lead with no known domain, instead of failing that lead.
2. **Sendr camelCases `attributes` on the way back.** Sent `lead_email`, received `leadEmail`;
   `apollo_id` → `apolloId`. It also injects its own `_GifHyperlinkText`. Everything here now sends
   camelCase so sent == received. `attributes` are the *only* way to tell which lead an otherwise
   anonymous engagement event belongs to — always stamp them.
3. **Inline `webhookUrl` is scoped to ONE generated page**, per Sendr's own docs — it is not a
   standing subscription. Use a workspace webhook (`POST /api/v1/webhook`) for the event stream.

### ⚠️ The calendar element iframes its URL — an ordinary page cannot go in it

Sendr's booking/calendar element renders as `<iframe src="...">`. Feeding it a normal marketing page
fails visibly: the browser blocks the frame and shows a grey broken-content box that reads as a
broken image. Found live on both templates 2026-08-16.

**A contact page is not the workaround.** Re-tested 2026-08-17 — *both* company contact pages send
the blocking headers, so neither can go in the calendar element:

| URL | Status | Frame headers |
|---|---|---|
| `https://www.visioneerit.com/contact` | 200 | `x-frame-options: SAMEORIGIN` · `frame-ancestors 'self'` |
| `https://www.oryoniq.com/contact` | 200 | `x-frame-options: SAMEORIGIN` · `frame-ancestors 'self'` |

Contact pages belong in `cta`, rendered as a link button. Keep the calendar element **removed**
until a genuinely embeddable URL exists (Calendly / HubSpot Meetings / Cal.com — all designed to be
framed). The configs carry a separate `booking_url` so a page link can't be mistaken for one, and it
stays empty on purpose.

### Registered webhook (live)

`VIO n8n — page + engagement events` → `https://n8n.industrialbriefs.com/webhook/vio-sendr-events?t=…`
(token in URL, fail-closed at the first node). Subscribed to `page:done`, `page:failed`, and all
seven `engagement:*` types. Sendr's generated signing secret is stored as `SENDR_WEBHOOK_SECRET` in
`.secrets.env`; set it on the n8n host as `VIO_SENDR_WEBHOOK_SECRET` to turn on second-factor
header validation (optional — the workflow skips that check when the env var is unset).

### GIF rendering fails — root cause found, and it's ours to fix

Every page generated from templates 8462 and 8464 returns `eventStatus: "failed"` with
`gifUrl: null`, on **all three** gif sources tried (`landing-page`, `dynamic-website`,
`video-thumbnail`). Sendr's reason:

> `pageGifTask: missing recordingFileUrl (no quick link or template video)`

**The templates have a GIF element but no recorded video in them** — confirmed independently:
`GET /page-template/list` reports `mediaType: null` on both 8462 and 8464. The GIF task has nothing
to build from. **This is a Sendr-UI fix, not a support ticket and not a plan entitlement problem**
(an earlier note here said otherwise — it was wrong): record a short video into each page template,
or remove the GIF element. Recording one is the better move, since it also unlocks LipSync and the
dynamic video background — see `reach-engine/sendr-page-template.md` Part 3.

**Two things worth knowing beyond the fix itself:**

1. **The reason string exists ONLY on the webhook.** `GET /api/v1/pages/{id}` returns
   `errorMessage: null` for the very same failed page — verified across all five. Without
   `VIO-sendr-events` receiving the webhook, this was undiagnosable from the REST API. Don't
   "simplify" that node by re-fetching the page.
2. **`page:failed` does not mean the page is unusable.** The pages return HTTP 200 and render
   correctly; only the optional asset is missing. `VIO-sendr-events` splits `asset_warning` from
   `error` for exactly this reason — telling a rep to withhold a link that works costs a real send.

- **Status:** `[LIVE]` for page generation — both products verified end-to-end, from
  `reach-engine/push_to_sendr_page.py --config <product>` and from n8n
  (`VIO-sendr-generate-page`), with real pages rendered and confirmed in a browser. `[LIVE]` for
  inbound events (`VIO-sendr-events`, verified with real unsolicited Sendr traffic).
  `[UI ONLY]` for campaign enrolment — a genuine platform constraint, not a gap in this build.
  n8n credential: **`VIO Sendr`** (`httpHeaderAuth`, header `X-API-Key`, id `VIOsendrcred001`).

## Asset hosting (S3-compatible) — self-built outreach GIFs

- **Why it exists:** Sendr's GIF task is broken on this account (see the Sendr section), so
  `reach-engine/make_scroll_gif.py` rebuilds that one asset. An email needs a public URL for
  `<img src>`, and Sendr has no upload endpoint — hence a bucket of our own.
- **Provider:** any S3-compatible store. Cloudflare R2 and DigitalOcean Spaces both work, same API.
  R2: `ASSET_S3_REGION=auto`, no ACL. Spaces: a real region (`nyc3`) and `ASSET_S3_ACL=public-read`.
- **Auth:** AWS SigV4, hand-rolled to keep the engine stdlib-only. `reach-engine/test_sigv4.py`
  checks the key derivation against AWS's published vector and the header format against live AWS —
  run it first if an upload 403s, to tell "our crypto is wrong" from "your bucket config is wrong".
- **Bucket must be public-read.** A prospect's mail client fetches the URL directly with no auth.
- **Object keys use the Sendr page slug, never the lead's name or email.** The URL is public;
  putting a prospect's identity in it would leak who was contacted to anyone who sees the message.
- **Status:** `[BLOCKED ON CREDENTIALS]` — the pipeline is built and tested end-to-end except the
  upload. `.secrets.env` carries `ASSET_S3_ENDPOINT`, `ASSET_S3_BUCKET`, `ASSET_S3_ACCESS_KEY`,
  `ASSET_S3_SECRET_KEY` (plus optional `ASSET_S3_REGION`, `ASSET_S3_ACL`, `ASSET_PUBLIC_BASE`) as
  placeholders. Fill those four and uploads start working with no code change. Without them the GIF
  still builds locally.

## Supabase — the record (2026-09-06)

- **Status:** `[LIVE]` — n8n credential `VIO Supabase` id `VIOsupabasepg1` (session-mode pooler).
  Staff console at `https://vio-console.104-248-119-152.sslip.io` reads the same project; the
  browser never holds the service key.
- **Tables:** `leads`, `events` (append-only, timestamp column `at`), `suppression` (append-only,
  `is_suppressed()`), `replies`, `campaigns`, `system_status`, view `leads_ready`.
- **In use by:** outreach, enrol-email, intake, apollo-reveal, instantly-events, inbound-reply,
  push-instantly, db-probe, the console.
- **Not in use by:** `VIO-inbox-mapper` and `VIO-sheet-*` (deactivated, credential unbound).
  `VIO-costs-rollup` stays off.

## Google Sheets — connection deleted (2026-09-06)

Was the data bus & dashboard through 2026-09-05. The n8n credential `VIO Google Sheets`
(`VIOgsheetcred01`) is **deleted**. Do not reinstall it. Do not point new writers at the Sheet.

- **Auth:** a Google **service account** (n8n credential type `googleApi`), NOT OAuth. n8n's Sheets
  node supports both; the service account was chosen because it installs headlessly via the CLI,
  whereas OAuth needs a human to finish a browser consent flow.
- **n8n credential:** `VIO Google Sheets` (id `VIOgsheetcred01`), installed 2026-08-16.
- **Service account:** `vio-n8n-sheets@visioneerit-outbound.iam.gserviceaccount.com`
  — created with **no project roles at all**. A service account needs zero project IAM to use
  Sheets; its access comes entirely from the spreadsheet being shared with it. Granting it project
  Editor would hand it far more than it needs.
- **Cloud project:** `visioneerit-outbound`, on the personal account `p.pshpatil@gmail.com`, no
  organisation. Sheets API + Drive API enabled.
- **Spreadsheet:** `VisioneerIT Outbound`, id `1ZD8VMxrXCJHbjaVUwgUSHI_pw4YBP_n7u7Gsdq71X2c`,
  owned by `p.pshpatil@gmail.com`, shared with the service account as **Editor**, General access
  still **Restricted**. Four tabs: `Leads`, `Events`, `Costs`, `Suppression` — see `SHEET_SCHEMA.md`.
- **Setup / re-setup:** `python3 n8n-workflows/setup-google-sheets.py --key <sa.json> --sheet-id <id>`
  It verifies access first, creates missing tabs, writes headers only into an empty row 1, installs
  the n8n credential, then shreds the loose key file. `--verify-only` checks without changing
  anything. **Restart n8n after installing** — it caches decrypted credentials in memory.
- **The failure everyone hits:** a valid key on a sheet nobody shared with the service account
  returns a bare **403**. Hit live during setup; the script now reports it in plain English with the
  address to share with. Check that before suspecting the key.
- **A dead end worth recording:** the FIRST attempt used `pratik.patil201@pccoepune.org`, a college
  account managed by `pccoepune.org`. It cannot create Cloud projects at all —
  *"You do not have the required `resourcemanager.projects.create` permission"*. Managed accounts
  commonly block this. Use a personal or properly-owned account.
- **Status:** `[DELETED 2026-09-06]` — n8n credential removed after the Supabase cutover. The
  spreadsheet may still exist as an archive; nothing in VIO can open it.

## Thoughtly — warm voice call · `[PARKED 2026-08-17]`

**Skipped at the user's direction on 2026-08-17. Not a blocker, not on the critical path.** These
notes are kept so voice can be revived without re-researching the API — nothing below is wired.

- **Auth:** two headers — `x-api-token: <THOUGHTLY_API_TOKEN>` and `team_id: <THOUGHTLY_TEAM_ID>`.
- **Role (if revived):** places a call ONLY on a confirmed positive reply (TCPA warm-only gate).
  Never cold.
- **Status:** parked. `.secrets.env` still holds placeholders for both `THOUGHTLY_API_TOKEN` and
  `THOUGHTLY_TEAM_ID` (confirmed 401 live). No dial node exists in any workflow and none ever did,
  so there is nothing to disable — the "skip" was a copy + docs change.
- **What replaced it:** a human handoff. `VIO-inbound-reply-to-call` still classifies the reply and
  still holds the dedup/TCPA gate, then posts Approve/Decline to Slack — where Approve now means
  *"I'm taking this follow-up"*, not *"pre-approve a robot call"*. The gate logic remains tested
  (`n8n-workflows/test-reply-brain.mjs`, 10/10).
- **Reviving it is a compliance event, not a config change.** Re-run the full compliance gate in
  `VISIONEERIT_BUILD_PLAN.md` before adding any dial node, and register caller-ID / spam-likely for
  the outbound number. The surviving TCPA gate code is a leftover guard, not prior approval.

## n8n — orchestration

- **Instance:** `n8n-industrialbriefs` · `root@104.248.119.152` · n8n `2.22.6` · container
  `n8n-stack-n8n-1` · `WEBHOOK_URL=https://n8n.industrialbriefs.com/`.
- **Access:** SSH + `docker exec` (see `n8n-workflows/README.md`, `import-workflow.sh`) — no web
  UI login needed to build or update workflows.
- **Credential convention:** created in the n8n UI only, never inline in workflow JSON.
  `VIO `-prefixed (e.g. `VIO Reoon`). Auth style varies by tool — Header Auth (Bearer) for most,
  Query Auth (`key=`) for Reoon, two headers for Thoughtly.
- **Shared instance, confirmed concretely (2026-08-07):** `n8n list:workflow` shows 13 other
  live workflows, all `IndustrialBriefs - *` — a separate, actively-developed job on the same
  droplet. Only ever touch `VIO-`-prefixed workflows. This is also why a container **restart**
  (needed to add a new env var — env vars can't be injected into a running container) isn't done
  unilaterally: it briefly affects their workflows too, not just VIO's.
- **Live workflows:** `VIO-intake-verify-curate` (Reoon verify + classify) — built, tested,
  deactivated. `VIO-inbound-reply-to-call` — rebuilt against Instantly's `reply_received` webhook +
  OpenAI sentiment classification (replacing Victoria's `prospect_response`/built-in `ai_response`);
  same workflow id, updated in place, **active, live, and verified end-to-end** — a real probe
  authenticates, gets classified by OpenAI, and reaches the correct gate decision, confirmed by
  reading the actual execution trace from Postgres. Uses n8n's native `n8n-nodes-base.openAi` node
  (not a generic HTTP Request — that was the credential-type mismatch that blocked this for a
  while; see `n8n-workflows/README.md` for the full diagnosis, including a `fixedCollection`
  parameter gotcha worth remembering). The real Instantly webhook subscription is registered too
  (scoped to the pilot campaign only). **Note:** the old
  Victoria-era version of this workflow was still physically present on the droplet (deactivated)
  even after its local JSON backup was deleted in this repo's cleanup — checked via
  `n8n list:workflow` before touching it, exactly the kind of "verify live state, don't trust
  local files" discipline this doc is supposed to encode.

## Google Sheets — dashboard

- **Status:** `[DELETED 2026-09-06]`. The staff console + Supabase replaced this. Historical
  notes below are how it was wired, not a licence to reconnect it.

## Orphaned

- `VICTORIA_AI_API_KEY` in `.secrets.env` — unused since the 2026-07-24 stack pivot. Harmless to
  leave; fine to remove whenever convenient.
