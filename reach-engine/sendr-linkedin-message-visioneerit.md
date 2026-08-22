# Sendr LinkedIn campaign copy — VisioneerIT (draft)

Parent-brand sequence, targeting CIO / CISO / Director of IT / IT Program Manager / Digital
Transformation Lead at federal & SLED organizations (`config-visioneerit.json`'s ICP) — a
different audience from the OryonIQ GovCon capture/BD sequence, so this runs as its own campaign
against its own sheet.

## Sequence structure (per help.sendr.ai "Building your first sequence" + "LinkedIn actions in a
sequence")

1. **Connection Request** — personalised note, ≤300 characters (LinkedIn hard limit)
2. **Wait** — 2 days
3. **Connection Check** (condition) — branches on whether the request was accepted; a Message
   step cannot fire on an unconnected contact
4. **LinkedIn Message** — only on the accepted branch

## Step 1 — Connection request note

> Hi {{first_name}} — following the CMMC Phase II suspension and the new zero-trust mandates
> hitting agencies this year. Connecting with IT/security leaders navigating that shift.

(≈180 characters — well under the 300-char cap.)

## Step 4 — Message (accepted-connection branch only)

> {{opener}}
>
> The Pentagon suspended CMMC Phase II on July 13, 2026, and agencies are under new zero-trust
> and AI-procurement mandates — security and modernization budgets are moving now.
>
> VisioneerIT stands up zero-trust, CMMC readiness, and AI-augmented security operations without
> a year-long procurement cycle. Put together a quick page on what that looks like for
> {{company}}: {{page_url}}
>
> Ellen, VisioneerIT

## Variables needed

| Tag | Source |
|---|---|
| `{{first_name}}` | lead's first name |
| `{{company}}` | lead's company / agency |
| `{{opener}}` | AI-written per-lead line (`config-visioneerit.json`'s `personalization_prompt`) |
| `{{page_url}}` | the Sendr personalised page URL for this lead — generate the page first via the VisioneerIT page template, then feed the URL back in as this step's variable |

## Daily limits (per help.sendr.ai — applies per connected LinkedIn seat)

Connection requests default to 15/day (recommended max 20/day, ~100-200/week LinkedIn-side);
messages default to 25/day (recommended max 100/day). If OryonIQ and VisioneerIT run from the
same LinkedIn seat, these two campaigns' connection requests share one daily/weekly cap — plan
volume accordingly or connect a second seat.
