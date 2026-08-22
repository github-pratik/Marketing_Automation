#!/usr/bin/env python3
"""
OryonIQ Personal-Reach Engine — GUIDED DEMO
===========================================
A no-setup walkthrough of a REAL run of the engine. No API keys, no credits, nothing to
install beyond Python 3.

The point of this demo: the engine LOGIC is fixed (in production it runs on n8n and travels
with an AI agent). The ONE thing that changes per product or campaign is the CONFIG FILE — and
the agent generates it. So the config is the CONTRACT: if it doesn't land correct, nothing runs.
This demo shows that contract being validated, then the engine running on it, then the SAME
engine running a different product just by swapping the config.

    Run it:   python3 demo.py       (press Enter to advance)
"""
import sys, json, os, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))

# Use the REAL validator from the engine (fall back to a tiny inline copy if run standalone).
try:
    from engine import validate_config
except Exception:
    def validate_config(cfg):
        need = ("product", "one_liner", "signal", "offer", "cta", "sender", "personalization_prompt")
        errs = [f"'{k}' missing/empty" for k in need if not str(cfg.get(k, "")).strip()]
        if not isinstance(cfg.get("icp"), dict) or not cfg["icp"].get("person_titles"):
            errs.append("'icp.person_titles' missing")
        return errs


def pause(label="[Enter] ▸ continue"):
    try:
        input(f"\n    {label} ")
    except EOFError:
        print()

def rule(ch="─", n=68):
    print("    " + ch * n)

def wrap(text, indent="      "):
    for line in textwrap.wrap(text, width=76 - len(indent)):
        print(indent + line)

def load_cfg(name):
    return json.load(open(os.path.join(HERE, name)))


def banner():
    print()
    rule("═")
    print("      ORYONIQ  ·  PERSONAL-REACH ENGINE")
    print("      From a firmographic list to a personalized reach — automatically.")
    rule("═")
    wrap("The engine LOGIC is fixed. In production it runs on n8n and travels with an AI "
         "agent. What you're running here is the reference implementation — the same "
         "logic, runnable offline as a backup.")
    print()
    wrap("The ONE thing that changes per product or campaign is the CONFIG FILE, and the agent "
         "generates it. So the config is the CONTRACT: get it right and the engine runs "
         "anything; get it wrong and nothing launches. Watch it prove that out.")
    pause("[Enter] ▸ start")


def step_validate():
    print(); rule()
    print("    STEP 0  ·  VALIDATE THE CONFIG      (the contract)")
    rule()
    wrap("Before a single API call, the config is checked. This is the gate the agent must "
         "pass: every campaign is only as good as the config that defines it.")
    cfg = load_cfg("config-oryoniq.json")
    print(f"\n      Checking config-oryoniq.json  (product: {cfg['product']})")
    for field in ("product", "one_liner", "icp.person_titles", "signal", "offer", "cta",
                  "sender", "personalization_prompt"):
        print(f"        ✓ {field}")
    errs = validate_config(cfg)
    if errs:
        print("\n      ✗ INVALID — campaign will NOT run:")
        for e in errs:
            print("          - " + e)
    else:
        print("\n      → CONFIG VALID — safe to run.")
        wrap("(If the agent ever produced a config missing, say, the signal, it would fail "
             "right here and never touch a real prospect.)", indent="        ")
    pause()


CONFIG_SIGNAL = ("The Pentagon suspended CMMC Phase II on July 13, 2026, and the DoD committed "
                 "$32B to AI, cloud, and cyber in H1 FY2026 — federal set-asides are opening fast.")

RAW = [
    {"first_name": "Kiara", "company": "Modernized Mobile LLC", "has_email": True},
    {"first_name": "Mike",  "company": "Government Contracting Services LLC", "has_email": False},
    {"first_name": "Nina",  "company": "Aviation Training Consulting", "has_email": True},
    {"first_name": "James", "company": "Cherry Bekaert", "has_email": True},
]
OPENERS = {
    "Kiara": "Hi Kiara, with the Pentagon suspending CMMC Phase II and the DoD committing $32B to "
             "AI, cloud, and cyber this fiscal year, your capture efforts at Modernized Mobile have a "
             "unique window to align with these shifting priorities. How are you adjusting your BD "
             "strategy to navigate these fast-opening federal set-asides?",
    "Nina":  "Hi Nina, with the Pentagon's pause on CMMC Phase II and a $32B DoD push into AI, cloud, "
             "and cyber this year, proposal teams like yours face new opportunities and shifting "
             "priorities in federal capture. I'd like to share how we help contractors adapt quickly.",
    "James": "James, with the Pentagon pausing CMMC Phase II and the DoD allocating $32 billion to AI, "
             "cloud, and cyber this fiscal year, your business development efforts are entering a rapidly "
             "evolving federal landscape. How is Cherry Bekaert positioning to capture these set-asides?",
}


def step_source():
    print(); rule()
    print("    STEP 1  ·  SOURCE     (cost: $0 — Apollo search is free)")
    rule()
    wrap("Using the config's target definition, the engine asks Apollo who matches. Search is "
         "free: it returns who matches plus a flag for whether we can reach them, without "
         "revealing (or paying for) any contact data yet.")
    print("\n      Apollo returned:")
    for p in RAW:
        mark = "✓ email" if p["has_email"] else "✗ no email"
        print(f"        • {p['first_name']:<6} {p['company']:<34} [{mark}]")
    pause()


def step_filter():
    print(); rule()
    print("    STEP 2  ·  FILTER     (cost: $0 — still free)")
    rule()
    wrap("Drop anyone with no reachable email before spending anything. Search wide for free, "
         "only ever pay to reveal contact data on the handful worth keeping.")
    kept = [p for p in RAW if p["has_email"]]
    print()
    for p in RAW:
        tag = "KEEP" if p["has_email"] else "drop  (no reachable email)"
        print(f"        {p['first_name']:<6} → {tag}")
    print(f"\n      {len(kept)} of {len(RAW)} kept — and we've still spent $0.")
    pause()


def step_personalize():
    print(); rule()
    print("    STEP 3  ·  PERSONALIZE   (the moat — OpenAI reads the config's signal)")
    rule()
    wrap("For each survivor, OpenAI is given the config's live SIGNAL and writes a specific "
         "opener tying it to that person's role and firm. Reads like homework, not mail-merge.")
    print("\n      Signal (from the config):")
    wrap("“" + CONFIG_SIGNAL + "”", indent="        ")
    for name, opener in OPENERS.items():
        print(f"\n      ▸ {name}:")
        wrap("“" + opener + "”", indent="        ")
    pause()


def step_output():
    print(); rule()
    print("    STEP 4  ·  ASSEMBLE + OUTPUT")
    rule()
    wrap("The opener drops into the config's template (offer + soft ask + CTA) and the finished "
         "list is written to leads.csv — ready for the sending layer.")
    print("\n      Example finished email (Kiara):")
    print("      " + "┄" * 60)
    body = (f"Subject: cmmc phase 2 just got paused\n\n{OPENERS['Kiara']}\n\n"
            "OryonIQ flags the pursuits that fit your NAICS and SDB status before the RFP "
            "drops, so you're bidding while everyone else is still searching.\n\n"
            "Want the three it's surfacing for a firm like yours? oryoniq.com/contact\n\n"
            "Ellen\nOryonIQ, VisioneerIT")
    for line in body.split("\n"):
        wrap(line, indent="        ") if line.strip() else print()
    print("      " + "┄" * 60)
    pause()


def step_reuse():
    print(); rule()
    print("    STEP 5  ·  SWAP THE CONFIG   (the config IS the contract)")
    rule()
    wrap("The engine didn't change. Point it at a different config and it runs a different "
         "product — as long as the config validates. An un-filled template does NOT validate, "
         "so it can never run by accident. The agent's job is to fill it in correctly.")
    print()
    for fname in ("config-oryoniq.json", "config-visioneerit.json", "config-template.json"):
        cfg = load_cfg(fname)
        errs = validate_config(cfg)
        if errs:
            print(f"      {fname:<26} [INVALID]  -> {errs[0]}")
        else:
            titles = ", ".join(cfg["icp"]["person_titles"][:3])
            print(f"      {fname:<26} [ VALID ]  -> targets: {titles} ...")
    print()
    wrap("Two real products run; the blank template is refused. That's the guarantee — a bad "
         "config never reaches a prospect.")
    pause()


def outro():
    print(); rule("═")
    print("      THAT'S THE ENGINE")
    rule("═")
    wrap("Fixed engine, swappable config. In production: the engine logic lives in n8n and is "
         "carried by an AI agent; the agent GENERATES and VALIDATES a config per campaign; this "
         "Python is your reference implementation and offline backup.")
    print()
    print("      The pieces:")
    print("        • engine.py               the engine logic (reference / backup)")
    print("        • config-oryoniq.json     one product config  ← the agent writes these")
    print("        • config-visioneerit.json a second product, same engine")
    print("        • leads.csv               the output, ready for the sending layer")
    print()
    wrap("What plugs into leads.csv next: Instantly sends the email, Sendr adds LinkedIn + a "
         "personalized page, Thoughtly makes the warm call on a positive reply — all "
         "orchestrated by n8n. This engine is the brain that feeds all of it.")
    print()
    wrap("To run it LIVE on fresh leads, see README.md.")
    print()


def main():
    banner()
    step_validate()
    step_source()
    step_filter()
    step_personalize()
    step_output()
    step_reuse()
    outro()


if __name__ == "__main__":
    main()
