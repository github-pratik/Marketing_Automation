# OryonIQ Outreach Console

The staff interface for the outbound engine, backed by **Supabase** rather than the
Google Sheet. Hosted on the DigitalOcean droplet alongside n8n, behind the Caddy
that already terminates TLS there.

This is the thing that replaces "open Instantly and the sheet".

---

## What it is

A single Node process (`server.mjs`, no npm dependencies) that serves a static
page and a small JSON API. The page never talks to Supabase directly.

```
browser ──► Caddy (TLS) ──► console:8080 ──► Supabase REST
             droplet          this app        service key lives HERE only
```

**Why a server and not a static page.** The Supabase `service_role` key bypasses
row-level security completely. `supabase/001_schema.sql` says in as many words that
the interface must not use that key in a browser. So the key stays in the
container's environment, and the browser gets a session cookie instead.

## What it shows

| Tab | Reads | Truthful when empty |
|---|---|---|
| Leads | `leads`, plus today's Instantly `send` events for the sent count (enrolment is not a send) | "Nothing is queued to send" is stated explicitly |
| Needs you | leads at `needs_review`, or held | "Everything has been decided" |
| Replies | `replies` | "No replies yet" — not a fabricated example |
| Find leads | calls `VIO-source-leads` (free search) then `VIO-apollo-reveal` (paid, chosen ids only) | "Nobody matched" is a real Apollo result, not a sample |
| Add leads | writes `leads` + `events` | — |

Clicking a lead opens its **ledger**: every `events` row for it, newest first.
Rows carrying `payload.backfilled` are labelled **reconstructed** in the timeline,
because they were rebuilt during the sheet migration and were never observed as
they happened.

## The ledger rule

Every staff action writes to `events` as well as changing `leads`. `events` is
append-only at the database level — a trigger refuses `UPDATE` and `DELETE` — so
"who released this lead, and when" cannot later be edited away.

Suppression is written **before** the lead's state changes. If the process dies
between the two, the half that already happened is the safe half: the address is
blocked even though the row still looks active.

## Refusals that are deliberate

- **A blank or unknown product is refused, not guessed.** Guessing wrong puts the
  wrong company's pitch in front of a real person and cannot be recalled.
- **A product with no active Instantly campaign is refused.** VisioneerIT has no
  campaign, so it must refuse rather than borrow OryonIQ's.
- **A suppressed address is refused at the point of adding**, so it never reaches
  the table at all.
- **A dropped lead cannot be released.** Reoon already proved the address is not
  real; that state is terminal.

## Running it locally

```bash
set -a; . ./.secrets.env; set +a
export STAFF_PASSWORD='your-local-password' SESSION_SECRET=$(openssl rand -hex 32)
node console/server.mjs
```

Then open `http://localhost:8080`.

## Deploying

`deploy.sh` copies the folder to the droplet, builds the image, and restarts the
service. It never copies `.secrets.env` — the droplet keeps its own env file
outside this repo.

```bash
./console/deploy.sh
```

Environment the container needs:

| Variable | Why |
|---|---|
| `SUPABASE_URL` | the project REST base |
| `SUPABASE_SERVICE_KEY` | server-side only, never sent to a browser |
| `STAFF_PASSWORD` | the shared staff login |
| `SESSION_SECRET` | signs the session cookie; the process refuses to start without it |
| `VIO_WEBHOOK_TOKEN` | optional; without it Find leads cannot search or reveal. Never sent to the browser |
| `N8N_WEBHOOK_BASE` | optional; defaults to the live n8n webhook host |

The process **exits on startup** if any of those is missing, rather than falling
back to a default. A predictable session secret is the same as no login at all,
and that failure would otherwise be silent.

## Migrating the sheet

`migrate-leads.mjs` reads `sheet-rows.json` — the Leads rows captured from the last
successful `VIO-run-outreach` execution, which is exactly what the poller last saw —
and writes them into Supabase.

```bash
node console/migrate-leads.mjs            # dry run, prints what it would write
node console/migrate-leads.mjs --commit   # writes
```

It skips any address already present, so re-running it is safe.

**The events it writes are reconstructed and say so.** The sheet never kept a
ledger, so there is no true history to import. Only facts that can be pointed at
become events: `created_at`, the Reoon verdict, the written opener, the Sendr page
URL, and the send times — the last taken from Instantly's own `last_contact`,
because the sheet's timestamp stopped at a failed write rather than at the send.

## Not built yet

- **Per-person accounts.** One shared password today. `staff_profiles` and
  Supabase Auth are the upgrade, and the ledger already records an actor per event.
- **A reveal of a real person from this tab has not been run in production yet.**
  The workflow is live and the console now calls it; the first click spends a
  real Apollo credit and writes a real stranger into intake.
