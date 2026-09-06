#!/usr/bin/env python3
"""
Install the Google service-account credential into n8n and prepare the outbound Sheet.

Run this once, after you have:
  1. a service-account JSON key downloaded from Google Cloud (Sheets API enabled), and
  2. a spreadsheet shared with that service account's client_email as EDITOR.

What it does, in order, stopping at the first real failure so you get one clear reason:

  verify   mint a token from the key and read the spreadsheet — proves the key works AND that the
           sheet is actually shared, BEFORE anything touches n8n. This is the step that catches the
           single most common mistake: a valid key on a sheet nobody shared with it.
  tabs     create the Leads / Suppression / Events / Costs / Segments tabs and write their header
           rows (idempotent — existing tabs are left alone, headers are only written when row 1 is
           empty, so re-running this on the live sheet cannot clobber data)
  install  import the key into n8n's credential store as `VIO Google Sheets` (id VIOgsheetcred01)
  shred    remove the loose JSON key file, so the secret ends up only in the two approved places

Usage:
  python3 setup-google-sheets.py --key ~/Downloads/sa.json --sheet-id 1AbC...xyz
  python3 setup-google-sheets.py --key sa.json --sheet-id 1AbC... --verify-only
  python3 setup-google-sheets.py --key sa.json --sheet-id 1AbC... --keep-key

The key is never printed, never echoed, and never written anywhere except n8n's encrypted store.
"""
import json, os, sys, time, base64, argparse, subprocess, tempfile
import urllib.request, urllib.error, urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
DROPLET = "root@104.248.119.152"
CONTAINER = "n8n-stack-n8n-1"
CRED_ID = "VIOgsheetcred01"
CRED_NAME = "VIO Google Sheets"
PROJECT_ID = "bUI1KrAElvnT1YW8"  # n8n personal project — see n8n-workflows/README.md
SCOPE = "https://www.googleapis.com/auth/spreadsheets"

# Header rows, verbatim from SHEET_SCHEMA.md. Workflows key on these exact names — changing one
# here without changing every workflow that reads it is how a pipeline silently stops matching.
TABS = {
    "Leads": [
        "lead_id", "source_config",
        # WHO pitched this person (oryoniq / visioneerit). Deliberately separate from
        # source_config: the live sheet repurposed that column to mean HOW the lead arrived
        # (Apollo / Warmly-Intent / Referral / Manual), which is a different question, and
        # a row that cannot say which product contacted someone cannot be filtered by brand.
        "Product",   # capital P — matches the live column exactly; header matching is case-sensitive
        "apollo_id", "first_name", "last_name", "title", "company",
        "company_domain", "has_email", "has_phone", "contact_email", "phone", "linkedin_url",
        "timezone", "signal", "opener", "email_draft", "reoon_status", "verify_action",
        "verify_reason", "sendr_page_id", "sendr_page_url", "gif_url",
        "channel_state_email", "channel_state_linkedin", "idempotency_key", "reply_received",
        "reply_sentiment", "reply_out_of_office", "call_state", "meeting_booked",
        "created_at", "updated_at",
    ],
    # Input surface for the live demo: a human types a lead here and VIO-demo-sheet-run picks it
    # up on a one-minute schedule, writing the drafted email back beside it. Deliberately NOT the
    # Leads tab — the intake pipeline writes there, so polling it would re-trigger on this
    # system's own rows, a feedback loop against real Reoon and OpenAI spend.
    # `status` is the claim marker: blank = unprocessed, anything else = leave alone.
    "Demo": [
        "first_name", "title", "company", "contact_email", "product",
        "status", "opener", "email_draft", "sendr_page_url", "notes", "updated_at",
    ],
    "Suppression": ["identifier_type", "identifier_value", "reason", "added_at", "added_by"],
    # Per-action audit log. Kept alongside Costs on purpose: Events answers "what happened to this
    # lead", Costs answers "what did this tool consume" — and not every cost is lead-attributable
    # (subscriptions, inbox warmup), so neither tab can absorb the other without losing something.
    "Events": ["timestamp", "lead_id", "lead_email", "tool", "action", "units", "est_cost_usd",
               "result", "workflow", "source_config"],
    "Costs": ["date", "tool", "metric", "count", "est_cost_usd", "source_config", "notes"],
    # The engine's targeting memory: one row per (product, role, industry, size) bucket, so the
    # operator agent can learn which prospects actually reply instead of re-deciding from scratch
    # every run. It lives in the Sheet and NOT in an n8n memory node on purpose — a
    # memoryBufferWindow holds one conversation and forgets it; this has to survive every run, every
    # product and every model swap.
    #
    # `sent` and `sample_size` are deliberately different numbers. `sent` is everything ever sent;
    # `sample_size` is the part that has actually had a chance to reply (sent - bounced - still
    # inside the reply window) and is the denominator of every rate here. It is also the number the
    # sample gate is checked against — see SHEET_SCHEMA.md and segment-scoring.js. A rate must never
    # be read out of this tab without the sample_size sitting next to it.
    "Segments": ["segment_key", "source_config", "role_bucket", "industry_bucket", "size_band",
                 "sent", "bounced", "pending", "sample_size", "replied", "positive",
                 "reply_rate", "positive_rate", "reply_rate_lb", "positive_rate_lb",
                 "confidence", "first_sent_at", "last_reply_at", "last_updated", "notes"],
}


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def mint_token(sa: dict) -> str:
    """Self-signed JWT -> OAuth access token. Signed with openssl so this stays stdlib-only, same
    dependency policy as the rest of the engine."""
    now = int(time.time())
    header = {"alg": "RS256", "typ": "JWT"}
    claims = {
        "iss": sa["client_email"],
        "scope": SCOPE,
        "aud": sa.get("token_uri", "https://oauth2.googleapis.com/token"),
        "iat": now,
        "exp": now + 3600,
    }
    signing_input = f"{b64u(json.dumps(header).encode())}.{b64u(json.dumps(claims).encode())}"

    with tempfile.TemporaryDirectory() as tmp:
        pem = os.path.join(tmp, "k.pem")
        fd = os.open(pem, os.O_WRONLY | os.O_CREAT, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(sa["private_key"])
        p = subprocess.run(["openssl", "dgst", "-sha256", "-sign", pem],
                           input=signing_input.encode(), capture_output=True)
    if p.returncode != 0:
        sys.exit(f"[verify] could not sign the JWT: {p.stderr.decode()[:200]}")
    jwt = f"{signing_input}.{b64u(p.stdout)}"

    body = urllib.parse.urlencode({
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt}).encode()
    req = urllib.request.Request(claims["aud"], data=body, method="POST",
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read().decode())["access_token"]
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        hint = ""
        if "invalid_grant" in detail:
            hint = ("\n  Usually means the system clock is off, or the key was revoked/deleted in "
                    "Google Cloud.")
        elif "access_denied" in detail or "unauthorized_client" in detail:
            hint = "\n  Usually means the Google Sheets API is not enabled on that project."
        sys.exit(f"[verify] token request failed ({e.code}): {detail}{hint}")


def api(token, path, method="GET", body=None):
    url = f"https://sheets.googleapis.com/v4/spreadsheets/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:400]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", required=True, help="path to the service-account JSON key")
    ap.add_argument("--sheet-id", required=True, help="the spreadsheet id from its URL")
    ap.add_argument("--verify-only", action="store_true", help="check access, change nothing")
    ap.add_argument("--keep-key", action="store_true", help="don't shred the JSON key afterwards")
    ap.add_argument("--host", default=DROPLET)
    args = ap.parse_args()
    sys.exit(
        "REFUSED: VIO Google Sheets was deleted 2026-09-06 after the Supabase cutover. "
        "Do not reinstall this credential."
    )

    key_path = os.path.abspath(os.path.expanduser(args.key))
    if not os.path.exists(key_path):
        sys.exit(f"No such key file: {key_path}")
    sa = json.load(open(key_path))
    for field in ("client_email", "private_key", "type"):
        if field not in sa:
            sys.exit(f"{os.path.basename(key_path)} is missing '{field}' — is it a service-account "
                     f"key, or did you download an OAuth client secret by mistake?")
    if sa["type"] != "service_account":
        sys.exit(f"That key is type '{sa['type']}', not 'service_account'.")

    print(f"[key    ] service account: {sa['client_email']}")

    # ---- 1. verify ----
    token = mint_token(sa)
    status, meta = api(token, args.sheet_id)
    if status == 403:
        sys.exit(f"[verify ] 403 — the key is valid but this sheet is NOT shared with\n"
                 f"          {sa['client_email']}\n"
                 f"          Share the spreadsheet with that address as Editor, then re-run.")
    if status == 404:
        sys.exit(f"[verify ] 404 — no spreadsheet with id {args.sheet_id}. Check the id from the URL.")
    if status != 200:
        sys.exit(f"[verify ] HTTP {status}: {meta}")
    existing = [s["properties"]["title"] for s in meta.get("sheets", [])]
    print(f"[verify ] OK — '{meta['properties']['title']}' reachable. Tabs: {', '.join(existing)}")

    if args.verify_only:
        print("\n[done   ] verify-only — nothing changed.")
        return

    # ---- 2. tabs + headers (idempotent) ----
    missing = [t for t in TABS if t not in existing]
    if missing:
        status, r = api(token, f"{args.sheet_id}:batchUpdate", "POST", {
            "requests": [{"addSheet": {"properties": {"title": t}}} for t in missing]})
        if status != 200:
            sys.exit(f"[tabs   ] could not create {missing}: {r}")
        print(f"[tabs   ] created: {', '.join(missing)}")
    else:
        print(f"[tabs   ] all {len(TABS)} already exist")

    for tab, headers in TABS.items():
        status, r = api(token, f"{args.sheet_id}/values/{urllib.parse.quote(tab)}!1:1")
        if status != 200:
            sys.exit(f"[headers] could not read {tab}!1:1 — {r}")
        if r.get("values"):
            print(f"[headers] {tab}: row 1 already populated, left untouched")
            continue
        rng = f"{urllib.parse.quote(tab)}!A1"
        status, r = api(token, f"{args.sheet_id}/values/{rng}?valueInputOption=RAW", "PUT",
                        {"values": [headers]})
        if status != 200:
            sys.exit(f"[headers] could not write {tab}: {r}")
        print(f"[headers] {tab}: wrote {len(headers)} columns")

    # ---- 3. install into n8n ----
    cred = [{
        "id": CRED_ID, "name": CRED_NAME, "type": "googleApi",
        "data": {"email": sa["client_email"], "privateKey": sa["private_key"],
                 "region": "us-central1", "inpersonate": False},
    }]
    remote = (f'docker exec -i {CONTAINER} sh -c "umask 077; cat > /tmp/gc.json; '
              f'n8n import:credentials --input=/tmp/gc.json --projectId={PROJECT_ID}; rm -f /tmp/gc.json"')
    p = subprocess.run(["ssh", "-o", "ConnectTimeout=30", args.host, remote],
                       input=json.dumps(cred).encode(), capture_output=True)
    out = (p.stdout + p.stderr).decode()
    if "Successfully imported" not in out:
        sys.exit(f"[n8n    ] credential import failed:\n{out[-500:]}")
    print(f"[n8n    ] installed credential '{CRED_NAME}' (id {CRED_ID})")
    print("[n8n    ] restart n8n before use — it caches decrypted credentials in memory:")
    print(f"          ssh {args.host} 'docker restart {CONTAINER}'")

    # ---- 4. shred the loose key ----
    if args.keep_key:
        print(f"[key    ] kept at {key_path} (--keep-key). Delete it once you're happy.")
    else:
        with open(key_path, "r+b") as f:
            n = f.seek(0, 2); f.seek(0); f.write(b"\0" * n); f.flush(); os.fsync(f.fileno())
        os.remove(key_path)
        print(f"[key    ] shredded {key_path} — the key now lives only in n8n's encrypted store")

    print(f"\n[done   ] Sheet ready: https://docs.google.com/spreadsheets/d/{args.sheet_id}/edit")


if __name__ == "__main__":
    main()
