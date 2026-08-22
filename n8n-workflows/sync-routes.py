#!/usr/bin/env python3
"""
Keep VIO-sendr-generate-page's ROUTES map in sync with reach-engine/config-<product>.json.

WHY THIS EXISTS
---------------
The Sendr page templates DECLARE signal/offer/cta as variables. Two different code paths fill
them: the Python engine reads config-<product>.json, while the n8n workflow reads a ROUTES map
hardcoded in a Code node. There is no automatic link between the two, so they drift — and drift
here is not cosmetic. Seen live 2026-08-16: the generated page said "budget signals are moving
fast" (a Sendr placeholder) while the email cited the dated CMMC suspension. The prospect got two
different arguments for the same product, in the same touch.

Re-copying by hand is the documented procedure and it has already been forgotten once. This turns
that discipline into a check that fails loudly.

  python3 sync-routes.py            # check only; exits 1 on drift, prints a field-level diff
  python3 sync-routes.py --fix      # rewrite the ROUTES block from the configs

After --fix, re-import the workflow (see README.md) — editing the JSON does not deploy it.
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
WORKFLOW = os.path.join(ROOT, "VIO-sendr-generate-page.json")
CONFIG_DIR = os.path.join(ROOT, os.pardir, "reach-engine")
NODE_NAME = "Route Product to Template"

# product key -> config filename. The key is what the caller passes as `product`, lowercased and
# stripped to letters, so "OryonIQ" and "oryoniq" both land here.
PRODUCTS = {
    "oryoniq": "config-oryoniq.json",
    "visioneerit": "config-visioneerit.json",
}

# Sendr-side labels that have no home in the config (they name the Sendr TEMPLATE, not the
# campaign). Kept here so a template rename is a one-line change in one file.
TEMPLATE_NAMES = {
    "oryoniq": "OryonIQ - GovCon Capture Page",
    "visioneerit": "VisioneerIT - Zero-Trust Readiness Page",
}

# Every field the workflow needs, and where it comes from in the config. Order is the order it is
# emitted, so a regenerated block stays readable and diffs stay small.
FIELDS = [
    ("product", lambda c: c["product"]),
    ("template_id", lambda c: c["sendr"]["page_template_id"]),
    ("campaign_id", lambda c: c["sendr"]["campaign_id"]),
    ("gif_source", lambda c: c["sendr"]["gif_source"]),
    ("gif_hyperlink_text", lambda c: c["sendr"]["gif_hyperlink_text"]),
    ("one_liner", lambda c: c["one_liner"]),
    ("signal", lambda c: c["signal"]),
    ("offer", lambda c: c["offer"]),
    ("cta", lambda c: c["cta"]),
    ("booking_url", lambda c: c.get("booking_url", "")),
]

BANNER = """// product -> Sendr page template + LinkedIn campaign, plus the campaign copy the page templates
// declare as variables (signal / offer / cta).
//
// GENERATED from reach-engine/config-<product>.json by n8n-workflows/sync-routes.py.
// Do not hand-edit: change the config, then run `python3 sync-routes.py --fix` and re-import.
// Without this, the page silently falls back to whatever placeholder was typed into Sendr and the
// page and the email argue different cases for the same prospect (seen live 2026-08-16).
//
// Fail closed on an unknown product: generating the WRONG product's page for a lead is worse than
// generating none, because it looks deliberate and it is the thing they will actually read."""


def load_configs():
    out = {}
    for key, fname in PRODUCTS.items():
        path = os.path.join(CONFIG_DIR, fname)
        with open(path) as f:
            cfg = json.load(f)
        route = {"product": None}
        for field, getter in FIELDS:
            try:
                route[field] = getter(cfg)
            except KeyError as e:
                sys.exit(f"{fname} is missing {e} — cannot build the route for '{key}'")
        route["template_name"] = TEMPLATE_NAMES[key]
        out[key] = route
    return out


def render(routes):
    """Emit the ROUTES const block as JavaScript. json.dumps gives correctly escaped JS string
    literals for free — quotes, backslashes and non-ASCII all survive the round trip into the
    workflow's jsCode field."""
    lines = [BANNER, "const ROUTES = {"]
    for key, r in routes.items():
        lines.append(f"  {key}: {{")
        lines.append(f"    product: {json.dumps(r['product'])},")
        lines.append(f"    template_id: {json.dumps(r['template_id'])},")
        lines.append(f"    template_name: {json.dumps(r['template_name'])},")
        for field, _ in FIELDS:
            if field == "product":
                continue
            if field == "template_id":
                continue
            lines.append(f"    {field}: {json.dumps(r[field])},")
        lines.append("  },")
    lines.append("};")
    return "\n".join(lines)


def parse_deployed(js):
    """Pull the current field values out of the deployed jsCode so --check can diff field by field
    rather than just saying 'the text differs'."""
    # Swallow the contiguous `//` comment block immediately above `const ROUTES` too — it is part
    # of the generated banner. Matching only from `const` leaves the previous banner stranded above
    # the new one, and the headers stack up one per run.
    block = re.search(r"(?:^//[^\n]*\n)*^const ROUTES = \{.*?\n\};", js, re.S | re.M)
    if not block:
        sys.exit(f"could not find a `const ROUTES = {{...}};` block in node '{NODE_NAME}'")
    found = {}
    for m in re.finditer(r"\n  ([a-z]+): \{(.*?)\n  \},", block.group(0), re.S):
        key, body = m.group(1), m.group(2)
        vals = {}
        for fm in re.finditer(r"\n    (\w+):\s*(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|\d+)", body):
            raw = fm.group(2)
            if raw.startswith("'"):
                raw = json.dumps(raw[1:-1].replace("\\'", "'"))
            try:
                vals[fm.group(1)] = json.loads(raw)
            except json.JSONDecodeError:
                vals[fm.group(1)] = raw
        found[key] = vals
    return block, found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix", action="store_true", help="rewrite the ROUTES block from the configs")
    args = ap.parse_args()

    with open(WORKFLOW) as f:
        wf = json.load(f)
    node = next((n for n in wf["nodes"] if n["name"] == NODE_NAME), None)
    if node is None:
        sys.exit(f"no node named '{NODE_NAME}' in {os.path.basename(WORKFLOW)}")

    js = node["parameters"]["jsCode"]
    want = load_configs()
    block, have = parse_deployed(js)

    drift = []
    for key, route in want.items():
        if key not in have:
            drift.append(f"  {key}: MISSING from the workflow entirely")
            continue
        for field in ("product", "template_id", "template_name", "gif_source",
                      "gif_hyperlink_text", "one_liner", "signal", "offer", "cta", "booking_url"):
            got, exp = have[key].get(field), route[field]
            if got != exp:
                drift.append(f"  {key}.{field}\n      config:   {exp!r}\n      workflow: {got!r}")
    for key in have:
        if key not in want:
            drift.append(f"  {key}: in the workflow but has no config — remove it or add the config")

    if not drift:
        print(f"[sync] ROUTES matches {', '.join(PRODUCTS.values())} — no drift.")
        return

    print(f"[sync] {len(drift)} field(s) drifted between the configs and the workflow:\n")
    print("\n".join(drift))

    if not args.fix:
        print("\nRun with --fix to regenerate the ROUTES block from the configs.")
        sys.exit(1)

    node["parameters"]["jsCode"] = js[:block.start()] + render(want) + js[block.end():]
    with open(WORKFLOW, "w") as f:
        json.dump(wf, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"\n[sync] rewrote ROUTES in {os.path.basename(WORKFLOW)}.")
    print("[sync] re-import the workflow to deploy it — editing the JSON does not.")


if __name__ == "__main__":
    main()
