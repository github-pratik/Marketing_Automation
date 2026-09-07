#!/usr/bin/env python3
"""Idempotently register Instantly webhooks for the OryonIQ campaign.

Copies the authenticated target URL from an existing VIO subscription so the
token never has to be re-typed. Scoped to ONE campaign — never workspace-wide
on this shared Instantly account.

  python3 n8n-workflows/register-instantly-webhooks.py
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAMPAIGN = "77b2cd80-5bf2-4656-8857-b310858d5a77"
WANTED = (
    ("email_sent", "VIO last-contact: email_sent (OryonIQ)"),
    ("email_bounced", "VIO suppression: email_bounced (OryonIQ)"),
    ("lead_unsubscribed", "VIO suppression: lead_unsubscribed (OryonIQ)"),
)


def load_secrets():
    path = os.path.join(ROOT, ".secrets.env")
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def req(key, method, path, body=None):
    url = "https://api.instantly.ai/api/v2" + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; oryoniq-reach-engine/1.0)",
    }
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"error": raw[:400]}
        return e.code, parsed


def main():
    secrets = load_secrets()
    key = secrets.get("INSTANTLY_API_KEY")
    if not key:
        sys.exit("Missing INSTANTLY_API_KEY in .secrets.env")

    status, listed = req(key, "GET", "/webhooks")
    if status != 200 or not isinstance(listed, dict):
        sys.exit(f"GET /webhooks failed: {status} {listed}")
    items = listed.get("items") or []
    existing = {
        (h.get("campaign"), h.get("event_type")): h
        for h in items
        if h.get("campaign") == CAMPAIGN
    }

    template = next(
        (h for h in items if h.get("campaign") == CAMPAIGN and h.get("target_hook_url")
         and "vio-instantly-events" in (h.get("target_hook_url") or "")),
        None,
    )
    if not template:
        sys.exit("No existing vio-instantly-events subscription to copy the URL from")
    target = template["target_hook_url"]
    if "?t=" not in target:
        sys.exit("Existing webhook URL is missing the fail-closed token query")

    for event_type, name in WANTED:
        have = existing.get((CAMPAIGN, event_type))
        if have:
            print(f"already registered  {event_type}  id={have.get('id')}  status={have.get('status')}")
            continue
        code, created = req(key, "POST", "/webhooks", {
            "campaign": CAMPAIGN,
            "name": name,
            "target_hook_url": target,
            "event_type": event_type,
        })
        if code not in (200, 201) or not isinstance(created, dict) or not created.get("id"):
            sys.exit(f"POST /webhooks {event_type} failed: {code} {created}")
        print(f"created            {event_type}  id={created['id']}  status={created.get('status')}")

    status, listed = req(key, "GET", "/webhooks")
    items = (listed.get("items") or []) if isinstance(listed, dict) else []
    ours = [h for h in items if h.get("campaign") == CAMPAIGN]
    print(f"campaign {CAMPAIGN} now has {len(ours)} VIO webhook(s):")
    for h in sorted(ours, key=lambda x: x.get("event_type") or ""):
        print(f"  {h.get('event_type'):24}  {h.get('id')}  status={h.get('status')}")


if __name__ == "__main__":
    main()
