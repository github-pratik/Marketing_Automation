#!/usr/bin/env python3
"""
Guard against n8n's "Column names were updated after the node's setup".

This error took the OryonIQ send path down for three days and was misdiagnosed
twice (once as a Sheets read-quota problem, once as "partial schemas are bad").
The notes below are the verified mechanism, read out of the deployed n8n 2.22.6
image rather than inferred from behaviour. Do not re-derive it.

WHERE THE ERROR COMES FROM
--------------------------
The Google Sheets node caches the sheet's columns in `parameters.columns.schema`.
`checkForSchemaChanges` compares that cache to the live header row POSITIONALLY —
by index, never by name (GoogleSheets.utils.js:283):

    for (const [columnIndex, columnName] of columnNames.entries()) {
        const schemaEntry = schemaColumns[columnIndex];
        if (schemaEntry === undefined) break;          // <-- an empty cache exits here
        if (columnName !== schemaEntry) { ...throw... }
    }

So a partial cache is safe only while it stays a positional PREFIX of the header.
Insert a column near the front — `Product` went into `Leads` at position 3 on
2026-08-29 — and every node whose cache predates it throws on every run, forever.

ONLY appendOrUpdate IS AFFECTED, AND THAT IS AN n8n INCONSISTENCY
-----------------------------------------------------------------
Three operations could call the check. Only two do, and they disagree:

    append.operation.js:211
        if (nodeVersion >= 4.4 && dataMode !== 'autoMapInputData')   <- SKIPPED for auto-map
    appendOrUpdate.operation.js:272
        if (nodeVersion >= 4.4)                                      <- runs regardless
    update.operation.js
        never calls it at all

That asymmetry is the whole story, and it explains the confusing evidence:

  * `VIO-run-outreach :: Claim row in sheet` (update, stale 9-column cache) ran
    477 times a day, clean. `update` never checks.
  * `VIO-intake-verify-curate :: Write Lead Row` (append, cache that does NOT
    match the header) has never thrown. `append` skips the check for auto-map.
  * `VIO-enrol-email :: Write Lead Row` (appendOrUpdate) threw on every single
    execution. Same kind of stale cache — but the one operation that still looks.

An earlier note in CLAUDE.md guessed that intake survived "because it declares the
full 34-column schema". That was a coincidence, not the reason. The reason is the
operation it uses.

WHAT --fix DOES
---------------
In `mappingMode: autoMapInputData` the schema is used for NOTHING at runtime — the
row is built from the input item's own keys (appendOrUpdate.operation.js:309), and
the match column is resolved against the live header, not the cache
(appendOrUpdate.operation.js:281). The cache only feeds the editor's dropdown.

So we empty it. `if (schemaEntry === undefined) break` then exits on index 0 and
the node can never raise this error again — no matter how the tab's columns
change later. This removes the failure mode rather than realigning it once.

`mappingMode: defineBelow` genuinely needs its schema (it names the values being
written), so those are reported and never auto-fixed.

USAGE
    python3 check-sheet-schema.py            # report, exit 1 if anything is at risk
    python3 check-sheet-schema.py --fix      # empty the at-risk caches, then report

Run after any edit to a Sheets-writing workflow, and after any column change on
the spreadsheet. Editing the JSON does not deploy — re-import afterwards.
"""

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent

# The only operation that runs checkForSchemaChanges in a way we can trip.
# `append` skips it for autoMapInputData; `update` never calls it.
RISKY_OP = "appendOrUpdate"
MIN_CHECKED_TYPEVERSION = 4.4


def sheets_nodes(wf):
    for node in wf.get("nodes", []):
        if "googleSheets" in (node.get("type") or ""):
            yield node


def classify(wf, node):
    """Return (severity, detail) for one Sheets node, or None if not a writer."""
    params = node.get("parameters") or {}
    op = params.get("operation") or "read"
    if op not in {"append", "appendOrUpdate", "update"}:
        return None

    cols = params.get("columns") or {}
    schema = cols.get("schema") or []
    mode = cols.get("mappingMode")
    tab = (params.get("sheetName") or {}).get("value", "?")
    tv = float(node.get("typeVersion") or 0)
    where = f"{wf['name']} :: {node['name']}"
    detail = dict(where=where, op=op, tab=tab, mode=mode,
                  n=len(schema), tv=tv,
                  head=[s.get("id") for s in schema[:4]])

    if op != RISKY_OP or tv < MIN_CHECKED_TYPEVERSION or not schema:
        # Cannot raise the error. A stale cache on append/update is dead weight,
        # not a defect — flag it as inert so nobody "fixes" it in a panic.
        detail["why"] = ("no cached schema" if not schema
                         else f"`{op}` does not run the check")
        return ("inert", detail)

    if mode == "autoMapInputData":
        return ("at_risk", detail)
    return ("manual", detail)


def audit(fix=False):
    buckets = {"at_risk": [], "manual": [], "inert": [], "fixed": []}

    for path in sorted(HERE.glob("VIO-*.json")):
        wf = json.loads(path.read_text())
        dirty = False

        for node in sheets_nodes(wf):
            got = classify(wf, node)
            if not got:
                continue
            sev, detail = got

            if sev == "at_risk" and fix:
                node["parameters"]["columns"]["schema"] = []
                dirty = True
                buckets["fixed"].append(detail)
            else:
                buckets[sev].append(detail)

        if dirty:
            path.write_text(json.dumps(wf, indent=2, ensure_ascii=False) + "\n")

    return buckets


def main():
    fix = "--fix" in sys.argv
    b = audit(fix)

    if b["fixed"]:
        print(f"FIXED — emptied {len(b['fixed'])} cache(s) that could throw:\n")
        for d in b["fixed"]:
            print(f"   {d['where']}")
            print(f"      {d['op']} -> {d['tab']}  dropped {d['n']} cached columns {d['head']}")
        print("\n   Re-import these workflows. Editing JSON does not deploy.\n")

    if b["at_risk"]:
        print(f"AT RISK — {len(b['at_risk'])} node(s) WILL throw once the tab's")
        print("columns stop matching the cache positionally:\n")
        for d in b["at_risk"]:
            print(f"   {d['where']}")
            print(f"      {d['op']} v{d['tv']} -> {d['tab']}  schema[{d['n']}] starts {d['head']}")
        print("\n   Run with --fix to empty them.\n")

    if b["manual"]:
        print(f"MANUAL — {len(b['manual'])} defineBelow node(s) need their schema.")
        print("Confirm each is still a positional prefix of the live header:\n")
        for d in b["manual"]:
            print(f"   {d['where']}\n      {d['op']} -> {d['tab']}  schema[{d['n']}]")
        print()

    print(f"{len(b['inert'])} other write node(s) cannot raise this error "
          f"(append/update, or no cached schema).")

    if b["at_risk"]:
        return 1
    print("\nNo node can raise \"Column names were updated after the node's setup\".")
    return 0


if __name__ == "__main__":
    sys.exit(main())
