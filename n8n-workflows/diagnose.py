#!/usr/bin/env python3
"""
One command that explains the whole outbound engine's health.

WHY THIS EXISTS
---------------
Every diagnosis in this project has cost the same hour: ssh to the droplet, work
out that n8n stores execution data as a flattened pointer array, hand-dereference
it to find the error message, then separately check the sheet, then Instantly.
Three separate incidents were misdiagnosed because the error message was never
actually read — the Sheets column outage got blamed on a read quota for two days.

So: read the errors, don't infer them.

    python3 diagnose.py              # last 24h
    python3 diagnose.py --hours 72
    python3 diagnose.py --full       # include the guards that fired correctly

WHAT IT SEPARATES
-----------------
A "failed execution" in n8n means two completely different things here, and
conflating them is what makes the error list look terrifying:

  DEFECT — something is broken and mail is not moving.
  GUARD  — a check did its job and refused. `VIO-enrol-email` throwing
           "REFUSED: nobody vouched for it" is the system WORKING; it shows up
           as a red execution because n8n has no other way to stop a run.

Guards are hidden unless --full. If you are looking at a red instance and every
line is a guard, nothing is wrong.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request

HOST = os.environ.get("VIO_N8N_HOST", "root@104.248.119.152")
PG = os.environ.get("VIO_PG_CONTAINER", "n8n-stack-postgres-1")
BASE = "https://n8n.industrialbriefs.com/webhook"
SHEET_TABS = ("Leads", "Inbox", "System", "Events", "Suppression")

# A thrown message matching any of these is a deliberate refusal, not a defect.
# Keep this list tight: mislabelling a real bug as a guard is how one hides.
# Google wobbles. Every Sheets node here already retries 5x at 15s, so a failure
# that reaches us survived 75 seconds of retry — but the poller runs again in 2-3
# minutes and picks the row straight back up. These self-heal. Chasing them as
# bugs wastes the session; only worry if the RATE climbs (see the summary line).
TRANSIENT_PATTERNS = (
    r"receiving too many requests",
    r"Service unavailable",
    r"The resource you are requesting could not be found",
    r"ECONNRESET|ETIMEDOUT|socket hang up",
)

GUARD_PATTERNS = (
    r"^REFUSED:",
    r"bad or missing token",
    r"is '(approved|dropped|pending_approval|enrolled|needs_review)' —",
    r"no lead in Leads with address",
    r"that is a verified negative",
    r"nothing to vouch",
)


def sh(cmd):
    return subprocess.run(["ssh", "-o", "ConnectTimeout=25", HOST, cmd],
                          capture_output=True, text=True).stdout.strip()


def psql(sql):
    """Feed SQL on stdin. Quoting it into `psql -c` through ssh mangles the
    double-quoted camelCase columns n8n uses ("startedAt", "workflowId") and the
    query comes back EMPTY rather than erroring — which reads as "no failures"
    on a completely broken instance. Do not put SQL back on the command line."""
    r = subprocess.run(
        ["ssh", "-o", "ConnectTimeout=25", HOST,
         f"docker exec -i {PG} psql -U postgres -d railway -t -A"],
        input=sql, capture_output=True, text=True)
    if r.returncode != 0 or "ERROR:" in r.stderr:
        print(f"  ! postgres: {(r.stderr or '').strip().splitlines()[:1]}", file=sys.stderr)
    return r.stdout.strip()


def deref(arr):
    """n8n flattens execution data into an array of interned values; strings that
    are decimal indices are pointers into it. Resolve them."""
    def go(v, d=0):
        if d > 8:
            return "..."
        if isinstance(v, str) and v.isdigit() and int(v) < len(arr):
            return go(arr[int(v)], d + 1)
        if isinstance(v, dict):
            return {k: go(x, d + 1) for k, x in v.items()}
        if isinstance(v, list):
            return [go(x, d + 1) for x in v]
        return v
    return go


def is_guard(msg):
    return any(re.search(p, msg) for p in GUARD_PATTERNS)


def is_transient(msg):
    return any(re.search(p, msg, re.I) for p in TRANSIENT_PATTERNS)


def failures(hours):
    raw = psql(f"""
        select coalesce(json_agg(row_to_json(x))::text, '[]') from (
          select e.id, w.name as wf, e."startedAt"::text as at, ed.data
          from execution_entity e
          join workflow_entity w on w.id = e."workflowId"
          join execution_data ed on ed."executionId" = e.id
          where w.name like 'VIO%'
            and e.status = 'error'
            and e."startedAt" > now() - interval '{int(hours)} hours'
          order by e."startedAt" desc
        ) x;
    """)
    try:
        rows = json.loads(raw or "[]")
    except json.JSONDecodeError:
        print("  ! could not read execution data from postgres", file=sys.stderr)
        return []

    out = []
    for r in rows:
        try:
            arr = json.loads(r["data"])
        except Exception:
            continue
        g = deref(arr)
        node = msg = None
        for el in arr:
            if isinstance(el, dict) and "lastNodeExecuted" in el and node is None:
                node = g(el["lastNodeExecuted"])
        for el in arr:
            if isinstance(el, dict) and "message" in el and ("stack" in el or "name" in el):
                m = str(g(el).get("message") or "")
                if m:
                    msg = m
                    break
        out.append(dict(id=r["id"], wf=r["wf"], at=r["at"][:19],
                        node=str(node), msg=(msg or "unknown").strip()))
    return out


def get(path, body=None):
    token = os.environ.get("VIO_WEBHOOK_TOKEN")
    if not token:
        return None
    req = urllib.request.Request(
        f"{BASE}/{path}",
        data=json.dumps(body or {}).encode(),
        headers={"x-vio-token": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode() or "{}")
    except Exception as e:
        print(f"  ! {path}: {e}")
        return None


def section(title):
    print(f"\n\033[1m{title}\033[0m\n" + "-" * len(title))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--full", action="store_true", help="show guards too")
    a = ap.parse_args()

    # ---------------- errors -------------------------------------------------
    section(f"FAILURES (last {a.hours}h)")
    fails = failures(a.hours)
    guards = [f for f in fails if is_guard(f["msg"])]
    transient = [f for f in fails if not is_guard(f["msg"]) and is_transient(f["msg"])]
    defects = [f for f in fails if not is_guard(f["msg"]) and not is_transient(f["msg"])]

    if not fails:
        print("  none.")
    else:
        print(f"  {len(fails)} failed execution(s): {len(defects)} defect(s), "
              f"{len(transient)} transient, {len(guards)} guard(s) working as designed.")
        if not defects:
            print("  Nothing is broken. Transients self-heal on the next poll;")
            print("  guards are refusals doing their job.")

    if defects:
        print("\n  DEFECTS — these mean mail is not moving:")
        seen = {}
        for f in defects:
            seen.setdefault((f["wf"], f["node"], f["msg"][:110]), []).append(f)
        for (wf, node, msg), hits in sorted(seen.items(), key=lambda kv: -len(kv[1])):
            print(f"\n   {len(hits):>3}x  {wf}")
            print(f"        node : {node}")
            print(f"        error: {msg}")
            print(f"        last : {hits[0]['at']}   (execution {hits[0]['id']})")

    if transient:
        by = {}
        for f in transient:
            by.setdefault(f["wf"] + " :: " + f["node"], []).append(f)
        print("\n  TRANSIENT — Google wobbled; the next poll retried and got it:")
        for k, hits in sorted(by.items(), key=lambda kv: -len(kv[1])):
            print(f"   {len(hits):>3}x  {k}   (last {hits[0]['at']})")

    if guards and a.full:
        print("\n  GUARDS — refusals, not bugs:")
        seen = {}
        for f in guards:
            seen.setdefault((f["wf"], f["msg"][:90]), []).append(f)
        for (wf, msg), hits in sorted(seen.items(), key=lambda kv: -len(kv[1])):
            print(f"   {len(hits):>3}x  {wf}: {msg}")
    elif guards:
        print(f"\n  ({len(guards)} guard refusal(s) hidden — pass --full to see them.)")

    # ---------------- liveness ----------------------------------------------
    section("POLLERS")
    audit = get("vio-sheet-audit")
    if audit:
        sysvals = (audit.get("System") or {}).get("values") or {}
        names = sysvals.get("workflow") or []
        if not names:
            print("  System tab empty — the pollers have not written a heartbeat.")
        for i, wf in enumerate(names):
            def col(k):
                v = sysvals.get(k) or []
                return v[i] if i < len(v) else (v[0] if v else "?")
            print(f"  {wf}")
            print(f"     last run {col('last_run_at')} · every {col('every')} "
                  f"· {col('checked')} · {col('last_result')}")

    # ---------------- what is stuck -----------------------------------------
    section("PIPELINE")
    if audit:
        for tab in SHEET_TABS:
            t = audit.get(tab) or {}
            if isinstance(t, dict) and t.get("data_rows") is not None:
                print(f"  {tab:12} {t['data_rows']} row(s), {t.get('header_count')} column(s)")
        leads = (audit.get("Leads") or {}).get("values") or {}
        states = leads.get("channel_state_email") or []
        # READY must stay in step with VIO-run-outreach's own allow-list.
        ready = {"", "not_sent", "approved"}
        print(f"\n  Leads states present: {states}")
        blocked = [s for s in states if s not in ready]
        if blocked and not [s for s in states if s in ready]:
            print(f"  Nothing is ready to send. Every lead sits in: {blocked}")
            print("  `needs_review` means verification could not confirm the mailbox")
            print("  (catch-all domain). A person vouches via VIO-sheet-repair approve.")

    print()


if __name__ == "__main__":
    main()
