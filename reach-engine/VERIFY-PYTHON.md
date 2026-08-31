# Audit verification — reach-engine Python + compliance claims

Verified against the code and docs on disk as of 2026-08-30. No SSH, no deploys, no API calls
(Apollo/OpenAI/Reoon/Instantly/Sendr/Google) were made. `.secrets.env` was read only to classify
each value as present/placeholder/real-looking — no key value is reproduced below. Two claims
(4 and 5) were additionally checked with small, local, network-free Python reproductions (pure
`str.format()` / `csv.writer` / `json.dump` calls against synthetic data) to move them from
"reasoned from reading the code" to "demonstrated." Those reproduction scripts touched only
`/private/tmp/.../scratchpad`, never any file under this repo.

Verdict key: **CONFIRMED** (the defect exists in the code as claimed) · **PARTLY-TRUE** (real,
but the claim overstates or mis-locates the mechanism) · **FALSE** (no such defect is in the code
or its documented behavior) · **ALREADY-FIXED** (a real defect, but guarded/handled elsewhere) ·
**UNVERIFIABLE OFFLINE** (depends on a live call or the live sheet).

---

## 1. `apollo_reveal()` — "accepts the locked placeholder and attributes a stranger's email to the wrong lead"

**Verdict: FALSE** (the specific mechanism named), with one smaller, real, adjacent gap noted below.

```python
# engine.py:131-142
def apollo_reveal(lead, secrets):
    """Apollo `people/match` on one already-filtered survivor. Matches by Apollo's own person
    id (returned from the free search, so no ambiguity) and reveals EMAIL ONLY — spends one
    lead credit. Never asks for the phone; see module docstring for why."""
    body = {"id": lead.get("id"), "reveal_personal_emails": True}
    status, data = http_json(
        "https://api.apollo.io/api/v1/people/match", "POST",
        {"X-Api-Key": secrets["APOLLO_API_KEY"], "Content-Type": "application/json"}, body)
    if status != 200:
        print(f"[apollo] reveal failed for {lead.get('first_name')}: HTTP {status}: {data}", file=sys.stderr)
        return None
    return (data.get("person") or {}).get("email")
```

I could not find "locked placeholder" — or any concept resembling it — anywhere in this
function, in `engine.py`, or in `INTEGRATIONS.md`'s documentation of Apollo's actual behavior.
Two things directly weigh against the claim:

- `apollo_reveal()` is called **only** from the real (non-seed) path in `main()` (engine.py:297-304,
  inside `if args.reveal:`), never from the `--seed-email` path, which hardcodes `"id": "seed-test"`
  (engine.py:285) but never reaches this function. So the seeded/synthetic id can't leak into a
  reveal call.
- `INTEGRATIONS.md:19-24` documents, from a **live-verified** 2026-08-22 check, that every person
  object returned by Apollo's free search carries an `id` field (one of only ~8 guaranteed fields),
  and `INTEGRATIONS.md:35-36` states reveal is "Matched by Apollo's own person `id` (from the free
  search, **no ambiguity**)" — the project's own documented, live-tested understanding of this API
  is the opposite of "returns a stranger's data." I have no way to independently re-test Apollo's
  behavior (no API calls permitted), so I can't rule out the API itself misbehaving, but there is
  no evidence for it in this repo, and the repo's own evidence points the other way.

**The one real, smaller gap**: `apollo_reveal()` never validates `lead.get("id")` is truthy before
firing the request, and never cross-checks that the returned `person` object's own id matches the
`id` it sent — it just trusts `(data.get("person") or {}).get("email")` wholesale. That's a
real, missing defense-in-depth check, but on the documented behavior above it is not currently
reachable: `id` is guaranteed present on every real lead, so there is no live path that hands
`apollo_reveal()` a missing/placeholder id today.

**What would settle it definitively:** a live call to `POST /people/match` with a deliberately
invalid or reused `id` against a real Apollo account, to see whether it 404s/returns a null person
(consistent with the docs) or actually returns a different real person's data. I was not permitted
to make that call.

---

## 2. `push_to_instantly.py` line 79 — "enrols a lead whose personalization is a raw `[openai HTTP 401: …]` string"

**Verdict: CONFIRMED.**

The error string is manufactured here:
```python
# engine.py:196-210
def openai_opener(lead, cfg, secrets, model):
    ...
    status, data = http_json("https://api.openai.com/v1/chat/completions", "POST", ...)
    if status != 200:
        return f"[openai HTTP {status}: {str(data)[:120]}]"
    return data["choices"][0]["message"]["content"].strip().strip('"')
```
and written straight into the lead record whenever the lead wasn't already Reoon-hard-dropped:
```python
# engine.py:333, 343
opener = "[skipped — verify hard-dropped this lead]" if dropped else openai_opener(p, cfg, secrets, args.model)
...
"opener": opener,
```
This is what lands in `leads.json`. `push_to_instantly.py` reads that value straight through with
no check on its content:
```python
# push_to_instantly.py:66-85
def build_lead_payload(lead, campaign_id):
    ...
    body = {
        "campaign": campaign_id,
        "email": lead["contact_email"],
        "first_name": lead.get("first_name"),
        "company_name": lead.get("company"),
        "job_title": lead.get("title"),
        "personalization": lead.get("opener"),          # <-- line 79, no validation
        "skip_if_in_campaign": True,
    }
```
And the only three skip conditions in `main()`'s enrollment loop are email-presence, a hard verify
drop, and a missing Sendr page URL — none of them inspect `opener`:
```python
# push_to_instantly.py:116-131
for lead in leads:
    email = lead.get("contact_email")
    if not email:
        ...continue
    if lead.get("verify_action") == "drop":
        ...continue
    if not lead.get("sendr_page_url") and not args.allow_no_page:
        ...continue
    ...
    status, data = push_lead(lead, args.campaign, secrets)
```

**Concrete scenario:** run `engine.py --reveal --verify` on a batch where the OpenAI call 401s for
one lead (bad/rotated key, rate limit, transient 5xx) but that lead's email still passes Reoon
(`verify_action` = `pass`) and it already has a `sendr_page_url`. `leads.json` then carries
`"opener": "[openai HTTP 401: {\"error\": ...}]"` for that lead. Running `push_to_instantly.py
leads.json --campaign <id>` enrolls it — none of the three gates catch it — creating a **paused**
Instantly lead record whose `personalization` custom field is the literal broken string. It is
enrolled, not sent (this script never activates a campaign — see its own docstring and the final
printed line, "Campaign is still PAUSED"), but nothing here would stop that string from reaching a
real inbox if the campaign is later activated without a human specifically re-checking every
lead's personalization field.

**Worth noting — the codebase already knows this failure shape, just not here.**
`push_to_sendr_page.py` guards exactly this case before it reuses `opener` to build a page-specific
email preview:
```python
# push_to_sendr_page.py:266-268
opener = lead.get("opener") or ""
if lead.get("sendr_page_url") and opener and not opener.startswith("["):
    lead["email_draft"] = assemble_email(lead, opener, cfg, page_url=lead["sendr_page_url"])
```
That `not opener.startswith("[")` check has no counterpart in `push_to_instantly.py`, so this is
an inconsistently-applied guard, not an undiscovered failure mode — the fix pattern already exists
one file away.

---

## 3. "Fails open — only skips `verify_action == 'drop'`; unverified batches enrol silently"

**Verdict: CONFIRMED**, and more broadly than the one-line description suggests.

`push_to_instantly.py` is the only consumer of `verify_action` anywhere in `reach-engine/`'s
Python code, and the check is a single equality test:
```python
# push_to_instantly.py:123-126
if lead.get("verify_action") == "drop":
    print(f"  skip  {lead.get('first_name')}: verify hard-dropped this lead")
    skipped += 1
    continue
```
(confirmed by `grep -rn "needs_review\|verify_action" *.py` — no other file reads `verify_action`
at all.)

Every `_reoon.action` value engine.py can produce **other than `"drop"`** sails through this gate
and gets enrolled exactly like a clean `pass`:
```python
# engine.py:146-153 — REOON_ACTION table
"safe":   ("pass", ...), "valid": ("pass", ...),
"invalid": ("drop", ...), "spamtrap": ("drop", ...),
"disposable": ("needs_review", "flagged disposable - confirm real throwaway vs greylisted corporate ..."),
# engine.py:162, 164 — Reoon HTTP error, or any status Reoon returns that isn't in the table above
{"reoon_status": "error", "action": "needs_review", "reason": f"Reoon HTTP {status}"}
("needs_review", f"ambiguous ({reoon_status}) - human judges")
# engine.py:320 — verify ran but this particular lead had no email to check
{"reoon_status": "n/a", "action": "needs_review", "reason": "no email revealed"}
# engine.py:325 — --verify was never passed at all for this whole run
{"reoon_status": "n/a", "action": "n/a", "reason": "not verified — pass --verify"}
```
`"needs_review"` and `"n/a"` are both `!= "drop"`, so a disposable-flagged address, a Reoon outage,
an unrecognized Reoon status, and — most bluntly — **an entire batch run without `--verify` at
all** (every lead's action is `"n/a"`) all pass this gate identically to a verified-clean lead.
Nothing in `push_to_instantly.py`'s output distinguishes them either — the same
`push  {name} <{email}> -> enrolled, paused` line prints regardless.

**Concrete scenario:** `python3 engine.py config-oryoniq.json --limit 20 --reveal` (reveal only,
no `--verify`) followed by `python3 push_to_instantly.py leads.json --campaign <id>
--allow-no-page` enrolls all 20 revealed leads with zero Reoon checks and no warning that
verification never ran.

---

## 4. "13 `open()` calls, 0 with `encoding=` — a non-UTF-8 locale crashes AFTER all credits are spent"

**Verdict: PARTLY-TRUE.** The counts check out under a defensible scoping and `encoding=` is
genuinely absent everywhere, but I built a local reproduction and the "crashes after spend"
mechanism is real for exactly **one** of these call sites, not a general property of all of them —
several are accidentally safe for a reason the claim doesn't account for.

**The counts.** Every genuine `open()` builtin call in `reach-engine/*.py` (`urllib...urlopen(...)`
excluded), confirmed with `grep -n "open(" *.py` and manual de-duplication of the one line that has
both an `urlopen` and an `open` on it (`make_scroll_gif.py:92`):

| File | genuine `open()` calls | lines |
|---|---|---|
| `engine.py` | 4 | 38, 257, 352, 356 |
| `push_to_instantly.py` | 2 | 33, 108 |
| `push_to_sendr_page.py` | 4 | 57, 214, 232, 277 |
| `make_scroll_gif.py` | 5 (2 binary: `"rb"`/`"wb"`) | 63, 92, 231, 274, 308 |
| `demo.py` | 1 | 46 |
| `test_sigv4.py` | 0 | — |
| **Total** | **16** | |

`grep -n "encoding=" *.py` returns **zero matches in any file** — confirmed, 0 of the 16 pass
`encoding=`. The audit's "13" matches exactly if you scope to text-mode calls in the four scripts
that actually touch paid APIs (excluding `demo.py`, whose own docstring says "No API keys, no
credits" — engine.py:9 area is where credit discipline is documented, demo.py:5 says it plainly —
and excluding the 2 binary-mode calls, where Python doesn't accept `encoding=` at all): 4 + 2 + 4 +
(5-2) = **13**. So the count and the "0 encoding=" fact are both accurate under that scoping.

**Where the claim overreaches — verified by direct reproduction, no network calls:**

`json.dump(...)` defaults to `ensure_ascii=True`, which escapes every non-ASCII character to
`\uXXXX` before it ever reaches the file. None of `engine.py`'s `leads.json` write (line 352),
`push_to_sendr_page.py`'s write-back (line 277), or `make_scroll_gif.py`'s write-back (line 308)
pass `ensure_ascii=False`, so **all three are self-protecting against non-ASCII lead content
regardless of the host's default encoding** — I confirmed this by writing a record containing a
smart quote (`'…familiar’ they said.'`) through `open(path, 'w', encoding='ascii')` +
`json.dump(...)`: it wrote cleanly, no exception. This directly contradicts treating "0
`encoding=`" as if it meant "13 live crash sites."

The **one call site that genuinely reproduces the claimed crash** is `engine.py`'s CSV writer,
which — unlike `json.dump` — writes raw text with no ASCII-escaping:
```python
# engine.py:356-360
with open(os.path.join(ROOT, out_csv), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(FIELDS)
    for r in out:
        w.writerow([r[k] for k in FIELDS])
```
Forcing `encoding='ascii'` on this exact pattern with a lead record containing an accented company
name (`'Société Générale Federal'`) raised, verbatim:
```
UnicodeEncodeError: 'ascii' codec can't encode character '\xe9' in position 14: ordinal not in range(128)
```
This line runs at the very end of `main()`, **after** the entire reveal loop (engine.py:297-304,
Apollo credits), the entire verify loop (engine.py:311-326, Reoon credits), and the entire
per-lead opener loop (engine.py:330-349, OpenAI credits) have completed for the whole `--limit`
batch — so yes, a crash here happens after every credit in the run is already spent. AI-generated
opener text (em dashes, curly quotes) or a non-ASCII company/person name from Apollo are both
realistic triggers; note `openai_opener()`'s own `.strip('"')` (engine.py:210) only strips straight
ASCII quotes, not the curly ones GPT models commonly emit.

**One important correction to the claimed blast radius**: `leads.json` (line 352) is written
**immediately before** the vulnerable CSV write (line 356) and, per the `json.dump` finding above,
succeeds regardless of locale. So the batch's results are **not** actually lost when this crash
happens — they're already durably on disk in `leads.json` — the practical damage is an unhandled
traceback plus a missing/corrupt `leads.csv` companion file, not a full loss of the spent credits.

**A related, previously-unclaimed defect I found while reproducing this**: `engine.py:257`
(`cfg = json.load(open(cfg_path))`) reads the config file with no `encoding=`, and the real, shipped
`config-oryoniq.json` contains em dashes in its `_comment_*` fields. Forcing `encoding='ascii'` on
that exact read raised `UnicodeDecodeError: 'ascii' codec can't decode byte 0xe2 in position 167`.
This is a real, empirically-confirmed crash on a non-UTF-8-default host too — but it fires at the
very first file operation in `main()`, **before** `validate_config` runs and before any credit is
spent, so it's a "won't start at all" bug, not a "crashes after spend" bug (`push_to_sendr_page.py`
has the identical pattern at its own config read, line 214). Also worth noting for scope: network
request bodies (`json.dumps(body).encode()` in every `http_json()`) are unaffected by any of this —
`str.encode()` with no argument defaults to UTF-8 unconditionally, independent of locale — so the
risk here is confined to local file I/O, not the Apollo/OpenAI/Reoon/Instantly/Sendr calls
themselves.

---

## 5. `validate_config` "accepts a prompt that KeyErrors after spend"

**Verdict: CONFIRMED — reproduced locally**, no network calls needed since this is pure
`str.format()` behavior.

```python
# engine.py:87-90
prompt = cfg.get("personalization_prompt", "")
for token in ("{first_name}", "{company}"):
    if token not in prompt:
        errors.append(f"'personalization_prompt' must contain {token} so it fills per lead")
```
This only checks that the two literal substrings `{first_name}` and `{company}` are present — it
never checks that the prompt contains **no other** `{...}` token beyond the three the caller
actually supplies:
```python
# engine.py:197-200
task = cfg["personalization_prompt"].format(
    first_name=lead.get("first_name", "there"),
    title=lead.get("title", "(role)"),
    company=org_name(lead))
```
I ran `validate_config()` and then the exact `.format()` call above against a config shaped
identically to the real ones but with one extra token in the prompt:

```
personalization_prompt = "Write to {first_name} at {company} about {industry}."
validate_config(cfg) -> []            # accepted as VALID — {industry} is invisible to it
.format(first_name=..., title=..., company=...) -> KeyError: 'industry'
```
`openai_opener()` (engine.py:196-210) wraps that `.format()` call in nothing — no try/except — so
the `KeyError` propagates uncaught out of `main()`'s per-lead loop (engine.py:330-349). That loop
runs strictly after the reveal loop (Apollo credits, engine.py:297-304) and the verify loop (Reoon
credits, engine.py:311-326) have both finished for the entire `--limit` batch, and it hits the
`KeyError` on the very first lead — before `leads.json`/`leads.csv` are ever written
(engine.py:351-360 is after this loop). So a bad prompt of this shape genuinely spends every
Apollo-reveal and Reoon-verify credit for the whole run, then crashes with nothing persisted at
all — strictly worse than claim 4's scenario, where at least `leads.json` survives.

**Currently live or not:** I checked all three shipped configs — `config-oryoniq.json`,
`config-visioneerit.json`, `config-template.json` — and each `personalization_prompt` uses only
`{first_name}`, `{title}`, `{company}`, all three of which `.format()` is given. **None of the
configs on disk trigger this today.** This is a structural gap in `validate_config` (it validates a
subset condition, not the safe condition — "contains these two" instead of "contains only
these"), not a currently-active bug against the current campaigns.

---

## 6. `make_scroll_gif.py` — "S3 upload failure reported as success"

**Verdict: CONFIRMED as a latent code defect; currently dormant/unreachable given `.secrets.env`'s present contents.**

```python
# make_scroll_gif.py:161-168
req = urllib.request.Request(endpoint + path, data=body, method="PUT", headers=headers)
try:
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.status, None                      # body never read, even on success
except urllib.error.HTTPError as e:
    return e.code, e.read().decode()[:300]
except Exception as e:
    return 0, str(e)
```
```python
# make_scroll_gif.py:233-239
code, err = s3_put(body, key, "image/gif", secrets)
if code not in (200, 201, 204):
    res["uploaded"] = False
    res["error"] = f"upload HTTP {code}: {err}"
    return res
res["uploaded"] = True
res["gif_url"] = public_url(key, secrets)
return res
```
"Success" here means only "the endpoint returned a 2xx status code." Nothing verifies the object
is actually retrievable at the URL about to be emailed to a prospect:
- No ETag/checksum comparison against the uploaded bytes.
- No follow-up `HEAD`/`GET` against `public_url(key, secrets)` before declaring `uploaded: True`.
- The public-read ACL header is **opt-in only**:
```python
# make_scroll_gif.py:144-146
# Spaces honours a public-read ACL; R2 ignores it and serves via its own public bucket setting.
if (secrets.get("ASSET_S3_ACL") or "").strip():
    headers["x-amz-acl"] = secrets["ASSET_S3_ACL"].strip()
```
  If `ASSET_S3_ACL` isn't set, no ACL header is sent at all. A PUT with no ACL header commonly
  lands as a **private** object on S3-compatible providers whose bucket default isn't public — the
  PUT itself still returns 200/201/204 (a private write is still a successful write), so
  `res["uploaded"] = True` and a `gif_url` are returned, but that URL can 404 or require auth for
  the recipient. That is a genuine "upload failure" (the asset the email needs isn't usable) being
  reported as full success, with no code path that would ever notice.

**Concrete scenario:** `.secrets.env` has no `ASSET_S3_ACL` entry at all (confirmed — the file's 5
keys are `APOLLO_API_KEY`, `Openai_api_key`, `REOON_API_KEY`, `INSTANTLY_API_KEY`,
`SENDR_API_KEY`; no `ASSET_S3_*` key of any kind is present). If `ASSET_S3_*` credentials for a
bucket whose default ACL is private were added, every `make_scroll_gif.py` run would report
`uploaded: True` with a working-looking `gif_url` for objects the recipient's mail client can't
actually load.

**Currently reachable — no.** `storage_ready()` gates the whole upload path first:
```python
# make_scroll_gif.py:37, 178-179
REQUIRED_SECRETS = ("ASSET_S3_ENDPOINT", "ASSET_S3_BUCKET", "ASSET_S3_ACCESS_KEY", "ASSET_S3_SECRET_KEY")
def storage_ready(secrets):
    return [k for k in REQUIRED_SECRETS if not secrets.get(k) or secrets[k].endswith("_here")]
```
All four `ASSET_S3_*` keys are **entirely absent** from `.secrets.env` right now (not present even
as empty/placeholder lines — `grep -oE "^[A-Za-z_]+=" .secrets.env` lists only the 5 keys above).
So `process()` takes the early-return branch (`res["uploaded"] = False; res["blocked_on"] = "missing
in .secrets.env: ..."`, make_scroll_gif.py:225-229) and `s3_put()` is never called at all today —
matching CLAUDE.md's own note that this is "blocked only on `ASSET_S3_*` credentials." The defect
is real and would activate the moment those four secrets are filled in, but no live upload — false-success
or otherwise — is currently possible.

---

## 7. "No unsubscribe link and no postal address in any sendable body"

Checked every sendable body named in the brief. No legal conclusion below, only presence/absence
against the two named elements.

| Source | Unsubscribe / opt-out language | Physical postal address |
|---|---|---|
| `engine.py` `assemble_email()` (lines 213-234) | **Absent** | **Absent** |
| `config-oryoniq.json` → `sender` (line 29) | `"Ellen\nOryonIQ (a VisioneerIT company)"` — **absent** | **Absent** |
| `config-visioneerit.json` → `sender` (line 25) | `"Ellen\nVisioneerIT"` — **absent** | **Absent** |
| `campaign-oryoniq-pilot.json`, all 4 steps × both variants | **Absent** | **Absent** |
| `campaign-visioneerit-pilot.json`, all 4 steps × both variants | **Absent** | **Absent** |

Method: `grep -inoE` for `unsubscribe|opt.out|opt.in` and for postal-address patterns
(`street|suite|ave\.|avenue|blvd|boulevard|PO Box|P\.O\. Box|zip code|\d{5}(-\d{4})?`) across both
campaign JSON files and `engine.py`. The unsubscribe/opt-out search returned zero matches anywhere.
The address-pattern search returned two matches, both false positives (Sendr `campaign_id` values
`10748`/`10751` matching the 5-digit-number pattern, not an actual address). `assemble_email()`'s
own output is exactly greeting + opener + `cfg['offer']` + a fixed ask sentence + a CTA line +
`cfg['sender']` — and `cfg['sender']` in both shipped configs is only a first name and a company
name, nothing else. I read all 4 steps × both A/B variants of both campaign files in full (10 email
bodies total) — none contains either element in any form.

**UNVERIFIABLE OFFLINE**: whether Instantly (the sending platform) auto-appends its own
unsubscribe footer or compliance block at delivery time, outside of what's stored in these JSON
files. Many ESPs do this at the account or campaign-settings level, which wouldn't appear in this
repo at all. Settling this requires either checking the live Instantly campaign's settings/footer
configuration or inspecting an actual sent message — both out of scope here (no API calls
permitted). As authored in this repo, the content itself carries neither element; whether the
delivery platform adds one on top is a separate question this repo's files can't answer.

---

## 8. Sender identity — "copy signs 'Ellen', the LinkedIn seat is Pratik, the repo calls Ellen a persona"

**Verdict: CONFIRMED, verbatim, all three parts.**

**Copy signs "Ellen":** both configs' `sender` field (`config-oryoniq.json:29`,
`config-visioneerit.json:25`) and the sign-off of all 4 email steps in both campaign JSON files
end `Ellen<br>OryonIQ (a VisioneerIT company)` / `Ellen<br>VisioneerIT`. Both LinkedIn message
templates also sign off as Ellen:
```
reach-engine/sendr-linkedin-message.md:32:            > Ellen, OryonIQ / VisioneerIT
reach-engine/sendr-linkedin-message-visioneerit.md:35: > Ellen, VisioneerIT
```

**The LinkedIn seat is Pratik:**
```
INTEGRATIONS.md:152-153
- **Auth-check:** `GET /seat/me` — live-verified 200, workspace "VISIONEERIT", seat
  `pratik.patil@visioneerit.com`.
```
`INTEGRATIONS.md:148` headers this section "## Sendr — LinkedIn + personalized pages" — this is
the tool that sends the LinkedIn connection requests and messages, and its authenticated seat is a
real named person, Pratik Patil, not "Ellen." This makes the mismatch sharper on LinkedIn than on
email: a LinkedIn connection request shows the requester's real profile name (LinkedIn doesn't let
an account display a different name than its own profile), so a recipient who accepts a connection
from "Pratik Patil" would then receive a follow-up message signed "Ellen" — a mismatch visible
within one single channel, not just across channels.

**The repo calls Ellen a persona — found twice, verbatim:**
```
VISIONEERIT_BUILD_PLAN.md:53
| Warmup-clock check: email (Instantly) | `[DONE]` — existing inboxes already warm (persona "Ellen Grant" on secondary `getvisioneerit*.com` domains), no wait needed |

INTEGRATIONS.md:78-79
- **Role:** replaces Victoria as the email sender. Warmed inboxes already exist (persona "Ellen
  Grant" on secondary `getvisioneerit*.com`/`getoryoniq.com` domains) — no warmup wait needed.
```
Both explicitly use the word "persona" attached to the name "Ellen Grant." A full name and inbox
address also exist for her (`gav-draft-review.html:257`: `Ellen Grant <ellen@getoryoniq.com>`;
`:306`: `Ellen Grant <ellen@getvisioneerit.com>`), consistent across both product domains.

---

## 9. "No `approved_by` recorded anywhere — the safety claim names no human"

**Verdict: CONFIRMED**, with one narrow point marked unverifiable.

A repo-wide, case-insensitive search for `approved_by`, `approvedBy`, `approver`, and "approved by"
across every `.md`/`.json`/`.py`/`.mjs`/`.js`/`.html` file returns exactly one hit, and it's
unrelated (an ICP one-pager document approval in `VISIONEERIT_BUILD_PLAN.md:51`, not a send
approval).

I checked `SHEET_SCHEMA.md`'s full column listing for all 7 tabs (`Leads`, `Suppression`, `Events`,
`Costs`, `Segments`, `Inbox`, `System`). The closest thing to a human-approval record is
`Suppression.added_by` (`SHEET_SCHEMA.md:90`: "workflow name ... or a human's name") — but that
records who added a *suppression* entry, not who approved a *send*. `Leads.call_state`
(`SHEET_SCHEMA.md:74`) has a `pending_approval` state value, but its own docs note "No workflow
writes this" — there's no column, let alone one that's actually populated, for who cleared it.

I also read the actual n8n workflow backing the Slack approval gate CLAUDE.md describes
(`n8n-workflows/VIO-inbound-reply-to-call.json`). Its Slack node is:
```json
"operation": "sendAndWait", "responseType": "approval",
"approvalOptions": {"values": {"approvalType": "double", "approveLabel": "Approve", "disapproveLabel": "Decline"}}
```
Its three downstream Sheets-writing nodes (`Update Lead Row (by lead_id)`, `Update Lead Row (by
contact_email)`, `Log Reply Classification (Events)`) have explicit column schemas — I read all of
them in full. None includes a field for the responding Slack user: the Lead Row schema is
`lead_id, contact_email, reply_received, reply_sentiment, reply_out_of_office,
channel_state_email, updated_at`; the Events schema is `timestamp, lead_id, lead_email, tool,
action, units, est_cost_usd, result, ...`. Whoever clicks Approve/Decline in Slack is never written
to either.

**UNVERIFIABLE OFFLINE**: n8n's Slack `sendAndWait` mechanism necessarily receives the responding
Slack user's identity from Slack's API in order to resume the paused execution — that data exists
transiently in the execution's raw JSON. Whether it is retained in a form a human could later query
(n8n's execution-data retention/UI on the live instance) is a live-instance question I can't check
without SSH access, which I was told not to use. What I can confirm from the files on disk is that
no workflow **deliberately persists** an approver identity anywhere designed for that purpose —
the audit trail identifies the lead and the outcome, never the human who exercised the gate.
