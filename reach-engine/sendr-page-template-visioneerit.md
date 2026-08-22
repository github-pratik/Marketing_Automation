# Sendr page template — VisioneerIT

**Status: BUILT and live.** Template **8464 · "VisioneerIT - Zero-Trust Readiness Page"**, paired
with Sendr campaign **10751 · "VisioneerIT - Federal/SLED IT & Security LinkedIn"**. Both ids live
in `config-visioneerit.json`'s `sendr` block.

Parent-brand campaign — targets federal/SLED IT & security leaders directly (not the OryonIQ
GovCon capture/BD audience). Source: `config-visioneerit.json`.

**Read `sendr-page-template.md` (the OryonIQ twin) first** — the upgrade plan there applies to this
page one-for-one: the same two-variables-only gap, the same broken GIF block, the same booking-widget
point. Only Part 2 differs; the VisioneerIT equivalent of "name the three pursuits" is below.

## Variable tags to declare in Sendr

Same pool as the OryonIQ template — declare these exact tags and the engine fills them
automatically. Currently only `firstname` and `company` are declared, so the AI-written `opener`
never reaches the page:

| Sendr variable tag | Filled from |
|---|---|
| `firstname` (or `first_name`) | lead's first name |
| `company` (or `company_name`) | lead's company / agency |
| `title` (or `job_title`) | lead's job title |
| `opener` | AI-written per-lead opening line — **the one worth adding first** |
| `signal`, `offer`, `cta`, `product` | straight from `config-visioneerit.json` |

## The VisioneerIT version of "show, don't claim"

OryonIQ's page can name three live federal pursuits. This page's equivalent evidence is the
prospect's **own public attack surface**: a named, checkable observation about the agency's
posture — an expiring certificate, a legacy TLS version, a missing DMARC/DNSSEC record, an exposed
admin panel on a subdomain. All of it is public, none of it requires touching their systems.

Same reason it works: everything else on the page is an assertion, and this one thing can be
verified in thirty seconds. Same caution too — state plainly that it's a public-record observation,
not a scan of their network, or the credibility gain flips into a trust problem.

## Page copy

**Hero headline**
> {{first_name}}, zero-trust doesn't have to mean a year of procurement.

**Personalized line** (variable: `{{opener}}`)
> {{opener}}

**Body — the signal (static)**
> The Pentagon suspended CMMC Phase II on July 13, 2026, and agencies are now under new
> zero-trust and AI-procurement mandates. Security and modernization budgets are moving —
> most IT teams are still scoping the RFP.

**Body — the offer (static, personalize with `{{title}}` / `{{company}}`)**
> VisioneerIT stands up zero-trust, CMMC readiness, and AI-augmented security operations without
> a year-long procurement cycle — built for a {{title}} who needs {{company}} compliant on a
> real timeline, not a fiscal-year one.

**CTA button**
> Label: "See what zero-trust looks like for {{company}}"
> Link: `https://www.visioneerit.com/contact`

**Sign-off**
> Ellen
> VisioneerIT

## Notes

- Same production discipline as the OryonIQ page: keep `{{opener}}` to 1-2 sentences, AI-generated
  per lead by `engine.py` against `config-visioneerit.json`, so the LinkedIn message and this page
  tell the same story for the same prospect.
- This is the parent-brand pitch (zero-trust / CMMC / modernization) — do not blend it with the
  OryonIQ GovCon-market-intel pitch on the same page. Two products, two ICPs, two pages.
