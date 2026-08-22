# VisioneerIT Outbound — cost & credit economics

**Approach: measure, don't estimate.** Run a real pilot batch through the real pipeline, meter
what each tool actually consumes, and report **cost per meeting booked** to the boss — real data,
not a projection. This doc holds the model, the known baseline, the metering method, and (once
Phase 5 of `VISIONEERIT_BUILD_PLAN.md` actually runs) the results.

**Status legend:** `[KNOWN]` a verified figure (with the date it was checked) · `[UNKNOWN]` needs
pulling from that tool's own billing dashboard before the pilot — don't guess a number here, go
check the real one.

---

## What's metered, per tool

| Tool | Free | Metered | Rate |
|---|---|---|---|
| **Apollo** | `mixed_people/api_search` (sourcing) — 0 credits | `people/match` reveal: email reveal, mobile/direct-dial reveal | Lead credits `[KNOWN, 2026-07-18]`: ~1,163 remaining — re-check before the pilot, this drains as it's spent. Mobile/dial credits `[KNOWN, 2026-07-18]`: baseline was 0, resets monthly — confirm the current balance, this is the scarce one (see `INTEGRATIONS.md` guard: reveal a phone only for a confirmed positive reply). `$`/credit: `[UNKNOWN]` — read off the actual Apollo plan/billing page. |
| **Reoon** | — | every `/verify` call | `[KNOWN, 2026-07-18]`: ~351K instant credits available. `$`/credit: `[UNKNOWN]`. |
| **OpenAI** | — | every `/chat/completions` call — the opener today, reply-sentiment classification once Phase 3 is built | Token-metered, cheap at `gpt-4.1-mini`. Exact current `$`/token: `[UNKNOWN]` here on purpose — pull it live from the OpenAI usage dashboard rather than hardcoding a rate that goes stale the moment pricing changes. |
| **Instantly** | — | subscription (seats / warmed inboxes), not metered per send | Plan tier + `$`/mo: `[UNKNOWN]`. |
| **Sendr** | — | subscription (workspace seat), possibly per personalized-page generation | Plan tier + `$`/mo: `[UNKNOWN]`. |
| ~~**Thoughtly**~~ | — | — | **`[N/A — voice skipped 2026-08-17]`** Costs nothing because it is not in the pipeline: no dial node exists, no credentials are needed, no per-call spend. Positive replies hand off to a human instead. If voice is ever revived this line comes back as `$`/minute or `$`/call `[UNKNOWN]` — and the compliance gate re-runs first (`VISIONEERIT_BUILD_PLAN.md`). |
| **n8n** | hosting is a flat sunk cost on the shared droplet | — | not attributable per-lead; excluded from cost-per-meeting |

**Before Phase 5 (the pilot) starts:** fill in every `[UNKNOWN]` cell above from each tool's real
billing page, and re-verify the two `2026-07-18` credit balances haven't drifted. Don't estimate
any of them — that defeats the entire point of this doc.

## Metering method

Every metered action gets logged to the `Costs` tab in the Sheet (see `SHEET_SCHEMA.md`): `date`,
`tool`, `metric`, `count`, `est_cost_usd`, `source_config`. Log it at the point of the call, not
reconstructed afterward from memory — each workflow (reveal, verify, send, call) writes its own
row as it spends.

**Cost per meeting booked** — the number that actually goes to the boss:

```
cost_per_meeting = sum(Costs tab . est_cost_usd, over the pilot's date range)
                    / count(Leads tab . meeting_booked = true)
```

Report it next to the Bucket A / Bucket B split from `VISIONEERIT_BUILD_PLAN.md` — cost-per-meeting
is the sharpest Bucket B number, but it means nothing on its own without knowing whether the
Bucket A gates (deliverability, bounce rate, compliance) held while it was measured. A cheap
cost-per-meeting bought by skipping verification or spamming isn't a win.

## Results

**None yet.** Phase 5 of `VISIONEERIT_BUILD_PLAN.md` (the ~25-lead pilot) hasn't run. This section
gets filled in with the real batch's numbers once it does — not with a projection before then.
