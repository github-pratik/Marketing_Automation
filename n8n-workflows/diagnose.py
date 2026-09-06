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

# EXECUTION STORMS ARE DEFECTS, WHATEVER THE ERROR SAYS.
# On 2026-09-04 the scheduler fired VIO-inbox-mapper 2,551 times in one hour (mode=trigger,
# ~85x its 2-minute cadence), exhausted the Sheets read quota, and every failure carried a
# textbook "transient" message — so this tool reported 1,175 failures as weather and said
# "nothing is broken". It also put 1,153 alerts into Slack. A transient is a transient only
# at a transient RATE. Anything above STORM_PER_HOUR executions in an hour is reported first,
# as a defect, before any per-message classification runs.
EXPECTED_PER_HOUR = {"VIO-inbox-mapper": 30, "VIO-run-outreach": 20}
STORM_PER_HOUR = 90          # 3x the fastest poller; nothing legitimate reaches this

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


def storms(hours):
    raw = psql(f"""
        select coalesce(json_agg(row_to_json(x))::text, '[]') from (
          select w.name as wf, date_trunc('hour', e."startedAt")::text as hour,
                 count(*) as n, sum(case when e.status='error' then 1 else 0 end) as errs,
                 min(e.mode) as mode
          from execution_entity e join workflow_entity w on w.id = e."workflowId"
          where w.name like 'VIO%' and e."startedAt" > now() - interval '{int(hours)} hours'
          group by 1, 2 having count(*) >= {STORM_PER_HOUR}
          order by 2
        ) x;
    """)
    try:
        return json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []


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

    st = storms(a.hours)
    if st:
        print("  EXECUTION STORM — a defect regardless of what each failure says:")
        for r in st:
            exp = EXPECTED_PER_HOUR.get(r["wf"], "?")
            print(f"   {r['wf']}  {r['hour'][:13]}  {r['n']} runs in the hour "
                  f"(expected ~{exp}, mode={r['mode']}), {r['errs']} failed")
        print("  A scheduler firing far above cadence burns API quota and floods Slack;")
        print("  the per-message errors below are consequences, not causes.\n")
        storm_hours = {(r["wf"], r["hour"][:13]) for r in st}
        fails = [f for f in fails if (f["wf"], f["at"][:13].replace("T", " ")) not in storm_hours]
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
    probe = get("vio-db-probe")
    if probe:
        tables = probe.get("tables") or {}
        print(f"  supabase {probe.get('reached')}")
        print(f"  leads={tables.get('leads')}  events={tables.get('events')}  "
              f"suppression={tables.get('suppression')}  "
              f"leads_ready={tables.get('leads_ready')}")
        if tables.get("leads_ready") == 0:
            print("  leads_ready is empty — outreach is idle on purpose.")
    else:
        print("  vio-db-probe did not answer. Heartbeats live in system_status,")
        print("  not the Sheet System tab (VIO-sheet-audit is retired).")

    # ---------------- what is stuck -----------------------------------------
    section("PIPELINE")
    if probe:
        print("  Record is Supabase. Ready queue is the leads_ready view.")
        print("  A person vouches in the staff console (approved), not VIO-sheet-repair.")

    print()


if __name__ == "__main__":
    main()
