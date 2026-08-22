#!/usr/bin/env python3
"""
Push reach-engine's lead output into an Instantly campaign as PAUSED enrollment.

This script only ever creates lead records inside an existing campaign — it never activates
a campaign or triggers a send. Activation is a separate, explicit, human-approved action (see
VIO-operator-agent.md: enrolling is agent-alone/reversible, activating is human-gated) and is
deliberately not implemented here at all, so there is no flag that could accidentally send.

Usage:
  python3 push_to_instantly.py seed-test.json --campaign <campaign_id>
  python3 push_to_instantly.py leads.json --campaign <campaign_id>
  python3 push_to_instantly.py leads.json --campaign <campaign_id> --dry-run

Run push_to_sendr_page.py BEFORE this script: it writes sendr_page_url onto each lead, which is
carried here as the {{sendrPageUrl}} custom variable the campaign's CTA links to. Leads without
one are skipped rather than enrolled with a broken CTA (--allow-no-page overrides).
"""
import json, os, sys, argparse, urllib.request, urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))


def find_secrets():
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
    # (Instantly's leads endpoint does, with a bare Cloudflare 1010) — send a normal one.
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


def push_lead(lead, campaign_id, secrets):
    body = build_lead_payload(lead, campaign_id)
    return http_json("https://api.instantly.ai/api/v2/leads", "POST",
                      {"Authorization": "Bearer " + secrets["INSTANTLY_API_KEY"],
                       "Content-Type": "application/json"}, body)


def build_lead_payload(lead, campaign_id):
    """Instantly merges `custom_variables` into the lead's `payload`, where the campaign template
    reads them as {{tagName}}. The nesting matters and is NOT interchangeable: sending the same
    key inside a `payload` object instead returns HTTP 200/201 and silently discards it — verified
    against the live API 2026-08-21 on both POST and PATCH. Same failure shape as n8n's inert
    `parameters.text` (see CLAUDE.md): success response, ignored field. Only `custom_variables`
    persists."""
    body = {
        "campaign": campaign_id,
        "email": lead["contact_email"],
        "first_name": lead.get("first_name"),
        "company_name": lead.get("company"),
        "job_title": lead.get("title"),
        "personalization": lead.get("opener"),
        "skip_if_in_campaign": True,
    }
    page_url = lead.get("sendr_page_url")
    if page_url:
        body["custom_variables"] = {"sendrPageUrl": page_url}
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("leads_file", help="a leads.json or seed-test.json produced by engine.py")
    ap.add_argument("--campaign", required=True, help="target Instantly campaign id — never guessed, always explicit")
    ap.add_argument("--dry-run", action="store_true", help="print the Instantly lead payloads; do not call Instantly")
    ap.add_argument("--allow-no-page", action="store_true",
                    help="enroll leads that have no sendr_page_url. OFF by default and you almost "
                         "never want it: the campaign CTA is {{sendrPageUrl}}, and Instantly renders "
                         "a missing tag as an empty string, so the prospect gets a sentence that "
                         "ends in a bare colon. Generate pages first with push_to_sendr_page.py.")
    args = ap.parse_args()

    sec_path = find_secrets()
    if not sec_path:
        sys.exit("No .secrets.env found.")
    secrets = load_secrets(sec_path)
    if not secrets.get("INSTANTLY_API_KEY"):
        sys.exit("Missing INSTANTLY_API_KEY in .secrets.env")

    leads_path = args.leads_file if os.path.isabs(args.leads_file) else os.path.join(ROOT, args.leads_file)
    leads = json.load(open(leads_path))

    print(f"[push] {len(leads)} lead(s) from {os.path.basename(leads_path)} -> campaign {args.campaign}")
    if args.dry_run:
        print("       DRY RUN — no Instantly API call, no enrollment, no send.\n")
    else:
        print("       (enrolling only — campaign stays paused, nothing sends from this script)\n")

    pushed, skipped, failed = 0, 0, 0
    for lead in leads:
        email = lead.get("contact_email")
        if not email:
            print(f"  skip  {lead.get('first_name')}: no contact_email (run --reveal or --seed-email first)")
            skipped += 1
            continue
        if lead.get("verify_action") == "drop":
            print(f"  skip  {lead.get('first_name')}: verify hard-dropped this lead")
            skipped += 1
            continue
        if not lead.get("sendr_page_url") and not args.allow_no_page:
            print(f"  skip  {lead.get('first_name')}: no sendr_page_url — run push_to_sendr_page.py "
                  f"first, or pass --allow-no-page to send them the generic CTA")
            skipped += 1
            continue
        if args.dry_run:
            pushed += 1
            print(f"  DRY   {lead.get('first_name')} <{email}>: {json.dumps(build_lead_payload(lead, args.campaign))}")
            continue

        status, data = push_lead(lead, args.campaign, secrets)
        if status in (200, 201):
            pushed += 1
            print(f"  push  {lead.get('first_name')} <{email}> -> enrolled, paused")
        else:
            failed += 1
            print(f"  FAIL  {lead.get('first_name')} <{email}>: HTTP {status} {data}", file=sys.stderr)

    verb = "prepared" if args.dry_run else "pushed"
    print(f"\n[done] {verb} {pushed}, skipped {skipped}, failed {failed}.")
    if args.dry_run:
        print("       Dry run only — no lead records were created in Instantly.")
    else:
        print("       Campaign is still PAUSED — activation is a separate, explicit, human-approved step.")


if __name__ == "__main__":
    main()
