# VisioneerIT Outbound Engine

One reusable outbound engine for VisioneerIT products: **find the right people, keep only the reachable ones, write a personal opener, send email + LinkedIn, then hand a real reply to a human.**

OryonIQ (GovCon AI market intelligence) is the live pilot. Swap the config file and the same engine runs another VisioneerIT product. n8n orchestrates; OpenAI is the writing brain; **Supabase is the record**; the staff console is the dashboard. Google Sheets is retired.

Ellen sends the mail. Prospects meet Gavriel. Nothing is sent from a page view or a click.

## Staff console

This is the day-to-day board. It shows what the send loop will do next, what is waiting on a person, and where every lead sits.

![Staff console dashboard — pipeline, stats, and lead board](docs/github/dashboard.png)

The top card is the pipeline itself:

| Job | What it does |
|---|---|
| **Cold email** | `VIO-run-outreach` checks every 3 minutes. Only **Ready to send / Approved** people go out. |
| **Inbound replies** | Instantly webhook → OpenAI sentiment → Slack. A positive reply is a handoff, not a dial. |
| **Auto follow-up** | Optional playbook. If they sound interested, Ellen can send the meeting ask. Unclear stays a draft. |
| **Voice** | Disabled on purpose. A reply never places a call. |
| **VisioneerIT send** | Own Instantly campaign, or nothing. OryonIQ mail is never borrowed. |

Adding a lead does **not** email them. They wait on **Needs you** until someone confirms the person is real (or Reoon confirms the mailbox).

![Needs you — human gate before any cold email](docs/github/needs-you.png)

Cards on the board move on their own: Instantly send → **Already sent**, a reply → **Replied**, a booking → **Booked**. Staff can mark a person Hot / Later, suppress them, or open the ledger (every `events` row, newest first).

Screenshots use sample names. Live prospect data is not published here.

## How it works

```mermaid
flowchart LR
  A[Find or type a lead] --> B[Intake gates]
  B --> C[Needs you]
  C -->|Yes, this person is real| D[Ready to send]
  D --> E[n8n every 3 min]
  E --> F[OpenAI opener]
  F --> G[Sendr page]
  G --> H[Instantly email]
  H --> I[Reply]
  I --> J[Staff / meeting]
  B -->|duplicate or suppressed| K[Dropped — no credits]
  C -->|Never contact| L[Suppression list]
```

1. **Source** — Search Apollo for free (titles, seniority, US location, company size). Revealing an address is paid and capped; search never spends a credit.
2. **Gate** — Dedupe and suppression run *before* Reoon. A duplicate or a suppressed address costs nothing. A blank or unknown product is refused, not guessed.
3. **Human gate** — The console's **Needs you** tab. Catch-all domains stay here. Reoon `pass` can move them to the send queue.
4. **Send** — `VIO-run-outreach` claims from `leads_ready`. It drafts copy, generates a personalized Sendr page, and enrols Instantly. Heartbeats `system_status` every cycle; idle when the queue is empty is healthy.
5. **Reply** — Instantly posts in. OpenAI classifies sentiment. Slack gets Approve / Decline (*I'm taking this follow-up* / *not a real lead*). Suppression is append-only and matches any identifier.

## Stack

| Piece | Role |
|---|---|
| **Apollo** | Source people. Search is free; reveal is paid and only for people you pick. |
| **Reoon** | Verify mailboxes. Catch-all → hold, invalid → drop. |
| **OpenAI** | Per-lead opener and reply sentiment. |
| **Instantly** | Email send + warmup. Four warmed `@getoryoniq.com` accounts, 120/day cap. |
| **Sendr** | LinkedIn + personalized page. One campaign/template per product. |
| **n8n** | Orchestration. Only `VIO-` workflows on the shared instance. |
| **Supabase** | The record: `leads`, append-only `events`, `replies`, `suppression`. |
| **Staff console** | Dashboard. The browser never holds the database key. |

## Two products, one engine

| Product | Config | Sendr campaign | Page template |
|---|---|---|---|
| OryonIQ | `reach-engine/config-oryoniq.json` | GovCon Capture/BD LinkedIn | GovCon Capture Page |
| VisioneerIT | `reach-engine/config-visioneerit.json` | Federal/SLED IT & Security LinkedIn | Zero-Trust Readiness Page |

## Repo map

| Path | What it is |
|---|---|
| `console/` | Staff console (Node, no npm deps) |
| `n8n-workflows/` | Live `VIO-*` workflow JSON + tests |
| `reach-engine/` | Python engine: source → reveal → verify → personalize |
| `supabase/` | Schema and migrations |
| `INTEGRATIONS.md` | Auth, endpoints, credential names, access board |
| `VISIONEERIT_BUILD_PLAN.md` | Phased plan, gates, abort criteria |

```bash
# Guided demo — no keys
python3 reach-engine/demo.py

# Console locally (needs .secrets.env, never committed)
export STAFF_PASSWORD=… SESSION_SECRET=…
node console/server.mjs
```

Secrets live in n8n's credential store and in `.secrets.env` on disk. They are never committed.

## Hard rules

- No automated voice. Thoughtly was skipped; there is no dial node.
- Inbound n8n webhooks are authenticated and fail closed.
- Suppression is append-only.
- A wrong product guess cannot be recalled — the console refuses a blank or unknown product instead.
