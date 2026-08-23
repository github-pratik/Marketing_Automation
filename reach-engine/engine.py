#!/usr/bin/env python3
"""
Personal-Reach Engine — prototype (the moat: source -> research -> personalize).

Config-driven: ONE engine, MANY products. Point it at a config file and it returns a
ready-to-send, personalized lead list. The sending layer (Instantly / Sendr / Thoughtly),
orchestrated by n8n, plugs into this output downstream.

Credit discipline (see memory: Apollo is fine, don't waste credits):
  - Apollo `mixed_people/api_search` is FREE (names, titles, has_email/has_phone flags).
    Used to SOURCE and PRE-FILTER. Costs nothing.
  - Apollo reveal (`people/match`) COSTS lead credits -> only runs with --reveal, on the
    already-filtered survivors, EMAIL ONLY. Never reveals phone here — mobile/dial credits
    are reserved for a confirmed positive reply downstream (the call gate), not this batch.
  - Reoon verify only runs on revealed emails (--verify), and only when --reveal also ran.
  - OpenAI (cheap, gpt-4.1-mini) writes the per-lead opener — skipped for any lead Reoon
    hard-drops, so a bad email doesn't even cost an OpenAI call.

Usage:
  python3 engine.py config-oryoniq.json --limit 5                     # free: source + personalize
  python3 engine.py config-oryoniq.json --limit 25 --reveal --verify  # spend on survivors only
"""
import json, os, sys, csv, argparse, urllib.request, urllib.parse, urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))


def find_secrets():
    """Look for .secrets.env next to this file first, then one level up."""
    for p in (os.path.join(ROOT, ".secrets.env"), os.path.join(ROOT, "..", ".secrets.env")):
        if os.path.exists(p):
            return p
    return None


def load_secrets(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def http_json(url, method="GET", headers=None, body=None, timeout=60):
    # Some vendors' WAFs block urllib's default "Python-urllib/x.y" User-Agent outright
    # (seen on Instantly's leads endpoint, a bare Cloudflare 1010) — send a normal one.
    h = {"User-Agent": "Mozilla/5.0 (compatible; oryoniq-reach-engine/1.0)"}
    h.update(headers or {})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:
        return 0, {"error": str(e)}


REQUIRED_STR = ("product", "one_liner", "signal", "offer", "cta", "sender", "personalization_prompt")


def validate_config(cfg):
    """The config is the CONTRACT between the agent and the engine. Returns a list of problems
    (empty = valid). This is the thing that must 'land correct' before a campaign can run."""
    errors = []
    for key in REQUIRED_STR:
        v = cfg.get(key)
        if not isinstance(v, str) or not v.strip():
            errors.append(f"'{key}' must be a non-empty string")
        elif "<" in v and ">" in v:
            errors.append(f"'{key}' still has a template placeholder — fill it in")
    icp = cfg.get("icp")
    if not isinstance(icp, dict):
        errors.append("'icp' must be an object")
    else:
        if not isinstance(icp.get("person_titles"), list) or not icp.get("person_titles"):
            errors.append("'icp.person_titles' must be a non-empty list")
        elif any("<" in str(t) and ">" in str(t) for t in icp["person_titles"]):
            errors.append("'icp.person_titles' still has template placeholders — fill them in")
        if not isinstance(icp.get("person_locations"), list) or not icp.get("person_locations"):
            errors.append("'icp.person_locations' must be a non-empty list")
    prompt = cfg.get("personalization_prompt", "")
    for token in ("{first_name}", "{company}"):
        if token not in prompt:
            errors.append(f"'personalization_prompt' must contain {token} so it fills per lead")
    return errors


def org_name(p):
    return ((p.get("organization") or {}).get("name")
            or (p.get("account") or {}).get("name")
            or p.get("organization_name") or "their firm")


def org_domain(p):
    """The lead's own company domain. Free — it comes back on Apollo's unpaid search, no reveal
    needed. Carried through so Sendr can screenshot THEIR site as the personalized page's GIF and
    video background (`gifSource: dynamic-website`); without it that feature silently degrades to a
    generic preview. Falls back to the email's domain on the seeded path, where there's no Apollo."""
    org = p.get("organization") or p.get("account") or {}
    raw = org.get("primary_domain") or org.get("website_url") or p.get("_seed_domain") or ""
    if not raw:
        email = p.get("_contact_email") or ""
        raw = email.split("@", 1)[1] if "@" in email else ""
    raw = raw.replace("https://", "").replace("http://", "").strip("/")
    return raw.split("/")[0].lower() or None


def apollo_search(cfg, secrets, per_page):
    icp = cfg["icp"]
    body = {
        "person_titles": icp.get("person_titles", []),
        "person_locations": icp.get("person_locations", ["United States"]),
        "q_keywords": icp.get("q_keywords", ""),
        "page": 1, "per_page": per_page,
    }
    status, data = http_json(
        "https://api.apollo.io/api/v1/mixed_people/api_search", "POST",
        {"X-Api-Key": secrets["APOLLO_API_KEY"], "Content-Type": "application/json"}, body)
    if status != 200:
        print(f"[apollo] search failed HTTP {status}: {data}", file=sys.stderr)
        return [], None
    return data.get("people", []), data.get("total_entries")


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


# Mirrors the Classify node in n8n-workflows/VIO-intake-verify-curate.json — keep both in sync.
REOON_ACTION = {
    "safe": ("pass", "deliverable, safe to send"),
    "valid": ("pass", "deliverable, safe to send"),
    "invalid": ("drop", "hard fail: invalid"),
    "spamtrap": ("drop", "hard fail: spamtrap"),
    "disposable": ("needs_review",
                   "flagged disposable - confirm real throwaway vs greylisted corporate (known Reoon false-negative)"),
}


def reoon_verify(email, secrets):
    """Reoon power-mode verify on one revealed email. Spends one Reoon credit."""
    url = ("https://emailverifier.reoon.com/api/v1/verify?"
           + urllib.parse.urlencode({"email": email, "key": secrets["REOON_API_KEY"], "mode": "power"}))
    status, data = http_json(url, "GET")
    if status != 200:
        return {"reoon_status": "error", "action": "needs_review", "reason": f"Reoon HTTP {status}"}
    reoon_status = str(data.get("status", "unknown")).lower()
    action, reason = REOON_ACTION.get(reoon_status, ("needs_review", f"ambiguous ({reoon_status}) - human judges"))
    return {"reoon_status": reoon_status, "action": action, "reason": reason}


def openai_opener(lead, cfg, secrets, model):
    task = cfg["personalization_prompt"].format(
        first_name=lead.get("first_name", "there"),
        title=lead.get("title", "(role)"),
        company=org_name(lead))
    system = ("You write sharp B2B GovCon cold-email opening lines. One or two sentences, "
              "no fluff, no em-dashes, no 'leverage/unlock/streamline'. Never invent specific "
              "facts about the company. Ground it in the SIGNAL below.\n\nSIGNAL: " + cfg.get("signal", ""))
    body = {"model": model, "temperature": 0.7,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": task}]}
    status, data = http_json("https://api.openai.com/v1/chat/completions", "POST",
                             {"Authorization": "Bearer " + secrets["Openai_api_key"],
                              "Content-Type": "application/json"}, body)
    if status != 200:
        return f"[openai HTTP {status}: {str(data)[:120]}]"
    return data["choices"][0]["message"]["content"].strip().strip('"')


def assemble_email(lead, opener, cfg, page_url=None):
    """page_url is the lead's own generated Sendr page (see push_to_sendr_page.py) — when it's
    known, the CTA points at that specific, personalized page instead of the generic cfg['cta']
    link. lead.get('company') covers push_to_sendr_page.py's reshaped output; org_name(lead)
    covers the raw Apollo survivor dict used on engine.py's own first pass."""
    fn = lead.get("first_name", "there")
    company = lead.get("company") or org_name(lead)
    if page_url:
        # Must match the DEPLOYED Instantly step-1 sentence verbatim — the template is what the
        # prospect actually reads, so this preview is the side that follows it, not the reverse.
        # sync-routes.py's `cta-sentence` check enforces this; the previous wording ("the ones
        # it's surfacing") also dangled — its antecedent lived in a line that no longer precedes it.
        cta_line = f"I put together a short page for {company}: {page_url}"
    else:
        cta_line = f"Want the three it's surfacing for a firm like yours? {cfg['cta']}"
    return f"Hi {fn},\n\n{opener}\n\n{cfg['offer']}\n\n{cta_line}\n\n{cfg['sender']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    ap.add_argument("--limit", type=int, default=5)
    ap.add_argument("--reveal", action="store_true", help="Apollo people/match (COSTS lead credits)")
    ap.add_argument("--verify", action="store_true", help="Reoon verify revealed emails (costs Reoon credits)")
    ap.add_argument("--model", default="gpt-4.1-mini")
    ap.add_argument("--seed-email",
                     help="DoD seeded-test path: skip Apollo entirely and run verify/personalize/assemble "
                          "against ONE synthetic lead at this real email, so you can check output quality "
                          "end-to-end without spending an Apollo credit or touching a real prospect.")
    ap.add_argument("--seed-name", default="Test Lead")
    ap.add_argument("--seed-title", default="(role)")
    ap.add_argument("--seed-company", default="(test)")
    args = ap.parse_args()

    if args.verify and not args.reveal and not args.seed_email:
        sys.exit("--verify requires --reveal (or --seed-email) — nothing to verify without a real email")

    cfg_path = args.config if os.path.isabs(args.config) else os.path.join(ROOT, args.config)
    cfg = json.load(open(cfg_path))
    problems = validate_config(cfg)
    if problems:
        print("Config did NOT validate — the campaign will not run until these are fixed:", file=sys.stderr)
        for pr in problems:
            print("   - " + pr, file=sys.stderr)
        sys.exit(1)
    print(f"[0 config ] {os.path.basename(cfg_path)} validated OK — safe to run")
    sec_path = find_secrets()
    if not sec_path:
        sys.exit("No .secrets.env found. Copy .secrets.env.example -> .secrets.env and add your "
                 "Apollo + OpenAI keys (see README.md).  No-key demo: python3 demo.py")
    secrets = load_secrets(sec_path)
    for k in ("APOLLO_API_KEY", "Openai_api_key"):
        if not secrets.get(k) or secrets[k].endswith("_here"):
            sys.exit(f"Missing {k} in .secrets.env (see README.md).  No-key demo: python3 demo.py")
    if args.verify and (not secrets.get("REOON_API_KEY") or secrets["REOON_API_KEY"].endswith("_here")):
        sys.exit("Missing REOON_API_KEY in .secrets.env (needed for --verify; see README.md)")

    print(f"== {cfg['product']} · personal-reach engine ==")
    print(f"   {cfg['one_liner']}\n")

    revealed_count = 0
    if args.seed_email:
        print(f"[1 source ] SEEDED — skipping Apollo entirely, one synthetic lead at {args.seed_email}")
        survivors = [{
            "first_name": args.seed_name, "title": args.seed_title,
            "organization_name": args.seed_company, "has_email": True, "has_direct_phone": None,
            "id": "seed-test", "_contact_email": args.seed_email,
        }]
        print("[2 filter ] n/a — seeded lead used as-is")
        note = "" if not args.reveal else " (--reveal has no effect in --seed-email mode)"
        print(f"[3 reveal ] skipped — seeded lead already has a real email, no Apollo credit spent{note}\n")
    else:
        people, total = apollo_search(cfg, secrets, per_page=max(args.limit * 2, 10))
        print(f"[1 source ] Apollo search returned {len(people)} of ~{total} matches  (FREE, 0 credits)")

        survivors = [p for p in people if p.get("has_email")][:args.limit]
        print(f"[2 filter ] kept {len(survivors)} emailable leads via free has_email flag")

        if args.reveal:
            print(f"[3 reveal ] Apollo people/match on {len(survivors)} survivors "
                  f"(spends up to {len(survivors)} lead credit(s), email only)...")
            for p in survivors:
                p["_contact_email"] = apollo_reveal(p, secrets)
                if p["_contact_email"]:
                    revealed_count += 1
            print(f"          revealed {revealed_count}/{len(survivors)} real email addresses\n")
        else:
            for p in survivors:
                p["_contact_email"] = None
            print("[3 reveal ] skipped — pass --reveal to spend Apollo credits and get real emails\n")

    verified_count = 0
    if args.verify:
        to_verify = [p for p in survivors if p.get("_contact_email")]
        print(f"[4 verify ] Reoon checking {len(to_verify)} revealed emails (power mode)...")
        for p in survivors:
            email = p.get("_contact_email")
            if email:
                p["_reoon"] = reoon_verify(email, secrets)
                verified_count += 1
            else:
                p["_reoon"] = {"reoon_status": "n/a", "action": "needs_review", "reason": "no email revealed"}
        dropped = sum(1 for p in survivors if p["_reoon"]["action"] == "drop")
        print(f"          {dropped} dropped on hard verify fail, rest pass or need review\n")
    else:
        for p in survivors:
            p["_reoon"] = {"reoon_status": "n/a", "action": "n/a", "reason": "not verified — pass --verify"}
        print("[4 verify ] skipped — pass --verify (after --reveal) to check deliverability\n")

    print(f"[5 person.] OpenAI ({args.model}) writing a per-lead opener (skipped for hard-dropped emails)...\n")

    out = []
    for i, p in enumerate(survivors, 1):
        dropped = p["_reoon"]["action"] == "drop"
        opener = "[skipped — verify hard-dropped this lead]" if dropped else openai_opener(p, cfg, secrets, args.model)
        rec = {
            "first_name": p.get("first_name"), "title": p.get("title"), "company": org_name(p),
            "company_domain": org_domain(p),
            "has_email": bool(p.get("has_email")), "has_phone": p.get("has_direct_phone"),
            "apollo_id": p.get("id"),
            "contact_email": p.get("_contact_email"),
            "reoon_status": p["_reoon"]["reoon_status"],
            "verify_action": p["_reoon"]["action"],
            "verify_reason": p["_reoon"]["reason"],
            "opener": opener,
            "email_draft": opener if dropped else assemble_email(p, opener, cfg),
        }
        out.append(rec)
        print(f"  lead {i}: {rec['first_name']} · {rec['title']} · {rec['company']}"
              + ("  [DROPPED]" if dropped else ""))
        print(f"          “{opener}”\n")

    out_json, out_csv = ("seed-test.json", "seed-test.csv") if args.seed_email else ("leads.json", "leads.csv")
    with open(os.path.join(ROOT, out_json), "w") as f:
        json.dump(out, f, indent=2)
    FIELDS = ("first_name", "title", "company", "company_domain", "has_email", "has_phone", "apollo_id",
              "contact_email", "reoon_status", "verify_action", "verify_reason", "opener", "email_draft")
    with open(os.path.join(ROOT, out_csv), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(FIELDS)
        for r in out:
            w.writerow([r[k] for k in FIELDS])

    print(f"[6 output ] wrote reach-engine/{out_json} + {out_csv}  ({len(out)} leads)")
    reveal_note = f"{revealed_count} credit(s)" if args.reveal and not args.seed_email else "0 (skipped or n/a)"
    verify_note = f"{verified_count} credit(s)" if args.verify else "0 (skipped, pass --verify)"
    print(f"[credits  ] Apollo search: 0 (free).  Apollo reveal: {reveal_note}.  Reoon verify: {verify_note}.")


if __name__ == "__main__":
    main()
