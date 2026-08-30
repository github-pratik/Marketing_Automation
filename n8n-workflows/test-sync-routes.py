#!/usr/bin/env python3
"""
Tests for n8n-workflows/sync-routes.py.

WHY PYTHON AND NOT .mjs
-----------------------
The other test files here (`test-intake-gate.mjs`, `test-sendr-events.mjs`) are JavaScript because
the thing they test is JavaScript — they read `jsCode` straight out of a workflow JSON and execute
it, so the tests cannot drift from the deployed logic. The thing THIS file tests is a Python CLI,
and the only meaningful assertion about a CLI is what it prints and what it exits with. A .mjs
version would shell out to `python3` for every case and gain nothing.

The same anti-drift principle still applies, in the same form: every fixture is built by COPYING
the real repo into a temp directory and mutating one thing. No expected copy is retyped here, so
the tests cannot pass against a config the repo no longer has.

  python3 n8n-workflows/test-sync-routes.py
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
ENGINE_DIR = os.path.join(REPO, "reach-engine")

COPY = {
    "n8n-workflows": ["sync-routes.py", "VIO-sendr-generate-page.json",
                      "VIO-operator-agent.json", "VIO-operator-agent-v2.json"],
    "reach-engine": ["engine.py", "config-oryoniq.json", "config-visioneerit.json",
                     "campaign-oryoniq-pilot.json",
                     # Every file named in sync-routes.py's CAMPAIGNS map must be here. The script
                     # exits 2 ("anchor problem") when a declared campaign file is missing, which
                     # is correct — a campaign the checker believes in but cannot read is exactly
                     # the silent gap that let VisioneerIT's copy go unchecked. But it means this
                     # sandbox has to stay complete: adding a product to CAMPAIGNS without adding
                     # it here fails every fixture at once. (2026-08-29)
                     "campaign-visioneerit-pilot.json"],
}

PASS, FAIL = [], []


# ------------------------------------------------------------------ sandbox helpers
class Sandbox:
    """A throwaway copy of just the files sync-routes.py reads. Paths inside the script are all
    derived from __file__, so a copied tree behaves exactly like the real one."""

    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="sync-routes-test-")
        for sub, names in COPY.items():
            os.makedirs(os.path.join(self.root, sub), exist_ok=True)
            for n in names:
                shutil.copy2(os.path.join(REPO, sub, n), os.path.join(self.root, sub, n))

    def path(self, rel):
        return os.path.join(self.root, rel)

    def read(self, rel):
        with open(self.path(rel)) as f:
            return f.read()

    def write(self, rel, text):
        with open(self.path(rel), "w") as f:
            f.write(text)

    def json(self, rel):
        with open(self.path(rel)) as f:
            return json.load(f)

    def put_json(self, rel, obj):
        with open(self.path(rel), "w") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.write("\n")

    def sub(self, rel, old, new, count=1):
        text = self.read(rel)
        if old not in text:
            raise AssertionError(f"fixture anchor missing in {rel}: {old[:70]!r}")
        self.write(rel, text.replace(old, new, count))

    def node(self, wf_rel, name):
        wf = self.json(wf_rel)
        for n in wf["nodes"]:
            if n["name"] == name:
                return wf, n
        raise AssertionError(f"no node '{name}' in {wf_rel}")

    def sub_node_js(self, wf_rel, name, old, new):
        wf, n = self.node(wf_rel, name)
        js = n["parameters"]["jsCode"]
        if old not in js:
            raise AssertionError(f"fixture anchor missing in {wf_rel}/{name}: {old[:70]!r}")
        n["parameters"]["jsCode"] = js.replace(old, new, 1)
        self.put_json(wf_rel, wf)

    def run(self, *args):
        p = subprocess.run([sys.executable, self.path("n8n-workflows/sync-routes.py"), *args],
                           capture_output=True, text=True)
        return p

    def clean_baseline(self):
        """Repair the drift that exists in the repo TODAY so 'clean' is testable. Both repairs are
        derived from the repo's own canonical sources — nothing is retyped."""
        cfg = self.json("reach-engine/config-oryoniq.json")

        # 1. VIO-operator-agent-v2's embedded prompt lost the config's trailing clause.
        wf, n = self.node("n8n-workflows/VIO-operator-agent-v2.json", "validate_config")
        js = n["parameters"]["jsCode"]
        js = re.sub(r"(personalization_prompt:\s*)'(?:[^'\\]|\\.)*'",
                    lambda m: m.group(1) + "'" + cfg["personalization_prompt"] + "'", js, count=1)
        n["parameters"]["jsCode"] = js
        self.put_json("n8n-workflows/VIO-operator-agent-v2.json", wf)

        # 2. engine.py's with-page CTA sentence predates the deployed Instantly wording.
        #    Idempotent on purpose: repair() names a STATE the fixture must be in, not an edit that
        #    must apply. Once the real repo is repaired the old wording is legitimately gone, and a
        #    hard anchor here would fail the whole suite for the good reason. The strict anchor in
        #    sub() stays correct for the MUTATION helpers, where a silent no-op would test nothing.
        # Two superseded wordings now, not one. The 2026-08-29 copy rewrite added "so you can see
        # the format" (a page link with no reason to click is a link nobody clicks), so the
        # sentence this fixture repairs TO has moved once more. Each entry is a state this file
        # may legitimately be found in; the last is today's.
        supersedes = [
            'f"Put together a quick page with the ones it\'s surfacing for {company}: {page_url}"',
            'f"I put together a short page for {company}: {page_url}"',
        ]
        fixed = ('f"I put a short page together for {company} so you can see the format: '
                 '{page_url}"')
        text = self.read("reach-engine/engine.py")
        hit = next((x for x in supersedes if x in text), None)
        if hit:
            self.write("reach-engine/engine.py", text.replace(hit, fixed, 1))
        elif fixed not in text:
            raise AssertionError(
                "engine.py has neither the stale nor the repaired CTA sentence — the anchor this "
                "fixture depends on has moved; update repair() rather than loosening the check.")
        return self

    def destroy(self):
        shutil.rmtree(self.root, ignore_errors=True)


def _field_literal(sb, wf_rel, field, node="validate_config"):
    """Return a `field: <literal>` fragment exactly as it appears in the workflow today.

    Fixtures used to hardcode these (`sender: 'Ellen\\n...'`, `person_titles: ['Capture Manager',
    ...]`). Both agents now emit JSON-escaped DOUBLE-quoted literals, because `sender` holds a
    newline a single-quoted JS literal cannot. Anchoring on a quote style turned an ordinary shape
    change into a test failure, so read the anchor out of the file instead."""
    wf = sb.json(wf_rel)
    js = next(n for n in wf["nodes"] if n["name"] == node)["parameters"]["jsCode"]
    pat = (rf"{field}:\s*\[[^\]]*\]" if field.endswith("s")
           else rf"{field}:\s*(['\"])(?:[^\\]|\\.)*?\1")
    m = re.search(pat, js)
    if not m:
        raise AssertionError(f"no `{field}:` literal in {wf_rel}/{node} — update this helper")
    return m.group(0)


def _sender_literal(sb, wf_rel, node="validate_config"):
    """Return the `sender: <literal>` source exactly as it appears in the workflow today.

    The fixture used to hardcode `sender: 'Ellen\\nOryonIQ, VisioneerIT'`. Both agents now emit
    JSON-escaped double-quoted literals, because `sender` contains a newline that a single-quoted
    JS literal cannot hold. Anchoring on a quote style made an ordinary shape change look like a
    test failure, so read the anchor out of the file instead."""
    wf = sb.json(wf_rel)
    js = next(n for n in wf["nodes"] if n["name"] == node)["parameters"]["jsCode"]
    m = re.search(r"sender:\s*(['\"])(?:[^\\]|\\.)*?\1", js)
    if not m:
        raise AssertionError(f"no `sender:` literal in {wf_rel}/{node} — update this helper")
    return m.group(0)

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("  ok   " if cond else "  FAIL ") + name + (("\n         " + detail) if
                                                       (detail and not cond) else ""))


def case(name, mutate, expect_exit, expect_checks=(), forbid_checks=(), args=(),
         baseline=True, expect_text=(), forbid_text=("Traceback",)):
    """Run one scenario. `expect_checks` are drift-report section ids that MUST appear;
    `forbid_checks` MUST NOT — that pair is what proves consumers are detected independently."""
    sb = Sandbox()
    try:
        if baseline:
            sb.clean_baseline()
        if mutate:
            mutate(sb)
        p = sb.run(*args)
        out = p.stdout + p.stderr
        reported = set(re.findall(r"^--- (\S+)\s", p.stdout, re.M))
        errored = set(re.findall(r"^  (\S+) \(", p.stdout, re.M))
        seen = reported | errored
        detail = f"exit={p.returncode}\n         reported={sorted(seen)}\n{indent(out)}"
        okay = p.returncode == expect_exit
        okay &= all(c in seen for c in expect_checks)
        okay &= all(c not in seen for c in forbid_checks)
        okay &= all(t in out for t in expect_text)
        okay &= all(t not in out for t in forbid_text)
        check(name, okay, detail)
        return sb, p
    finally:
        sb.destroy()


def indent(s):
    return "\n".join("         | " + ln for ln in s.strip().splitlines()[:24])


# ------------------------------------------------------------------ 1. clean state
print("\n1. clean state")
case("a repaired repo reports no drift and exits 0", None, 0,
     forbid_checks=("routes", "agent-v1-config", "agent-v2-config", "email-shape",
                    "instantly-copy", "cta-sentence"),
     expect_text=("no drift",))

print("\n1b. the repo as it stands")
# This began as "the UNREPAIRED repo is reported, not tuned away" — a guard against building the
# checker and then softening it until the existing drift disappeared. That was the right guard
# while the drift existed, but it pinned the suite to a transient repo state: repairing the drift
# (the whole point of the tool) broke the test. The durable form asserts the same property from
# the other side — the real repo is clean, and any NEW drift fails here. The checker's ability to
# detect drift is proven by the per-consumer mutation cases in section 2, where it belongs.
_sb = Sandbox()
try:
    _p = _sb.run()
    check("the repo as it stands is clean (exit 0)",
          _p.returncode == 0 and "no drift" in _p.stdout,
          f"exit={_p.returncode}\n{indent(_p.stdout)}")
finally:
    _sb.destroy()


# ------------------------------------------------------------------ 2. drift per consumer
print("\n2. a mutated config is caught in every consumer, and each consumer independently")


def mutate_config_offer(sb):
    cfg = sb.json("reach-engine/config-oryoniq.json")
    cfg["offer"] = "OryonIQ does something completely different now."
    sb.put_json("reach-engine/config-oryoniq.json", cfg)


case("editing the config's offer trips routes + both agents + the Instantly template",
     mutate_config_offer, 1,
     expect_checks=("routes", "agent-v1-config", "agent-v2-config", "instantly-copy"))

case("editing the config's cta trips routes + both agents only",
     lambda sb: sb.put_json("reach-engine/config-oryoniq.json",
                            dict(sb.json("reach-engine/config-oryoniq.json"),
                                 cta="https://www.oryoniq.com/elsewhere")),
     1, expect_checks=("routes", "agent-v1-config", "agent-v2-config"),
     forbid_checks=("instantly-copy", "email-shape", "cta-sentence"))

case("ROUTES map alone drifts -> only `routes` reports",
     lambda sb: sb.sub_node_js("n8n-workflows/VIO-sendr-generate-page.json",
                               "Route Product to Template",
                               # derived, not retyped: the fixture only needs SOME value the
                               # config also holds, so it survives copy rewrites (this anchor went
                               # stale on 2026-08-29 when the pursuits/NAICS claim was dropped)
                               "gif_hyperlink_text: " + json.dumps(
                                   sb.json("reach-engine/config-oryoniq.json")
                                     ["sendr"]["gif_hyperlink_text"]),
                               "gif_hyperlink_text: \"something else entirely\""),
     1, expect_checks=("routes",),
     forbid_checks=("agent-v1-config", "agent-v2-config", "instantly-copy", "cta-sentence"))

case("operator-agent v1's embedded signal alone drifts -> only `agent-v1-config` reports",
     lambda sb: sb.sub_node_js("n8n-workflows/VIO-operator-agent.json", "validate_config",
                               "The Pentagon suspended CMMC Phase II on July 13, 2026",
                               "The Pentagon suspended CMMC Phase II on July 14, 2026"),
     1, expect_checks=("agent-v1-config",),
     forbid_checks=("routes", "agent-v2-config", "instantly-copy", "email-shape", "cta-sentence"))

case("operator-agent v2's embedded VisioneerIT cta alone drifts -> only `agent-v2-config`",
     lambda sb: sb.sub_node_js("n8n-workflows/VIO-operator-agent-v2.json", "validate_config",
                               "'https://www.visioneerit.com/contact'",
                               "'https://www.visioneerit.com/book'"),
     1, expect_checks=("agent-v2-config",),
     forbid_checks=("routes", "agent-v1-config", "instantly-copy", "cta-sentence"))


def _offer_of(sb, product="oryoniq"):
    """The config's offer verbatim — the canonical string every consumer must carry.
    Fixtures anchor on THIS rather than on a hardcoded phrase, so a copy change in the repo
    does not masquerade as a test failure."""
    return sb.json(f"reach-engine/config-{product}.json")["offer"]


def _first_words(text, n=3):
    return " ".join(text.split()[:n])


def mutate_campaign_offer(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    v = c["sequences"][0]["steps"][0]["variants"][0]
    offer = _offer_of(sb)
    assert offer in v["body"], "step 1 variant A no longer carries the config offer verbatim"
    v["body"] = v["body"].replace(offer, "OryonIQ does something materially different now.")
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("the Instantly step-1 offer alone drifts -> only `instantly-copy` reports",
     mutate_campaign_offer, 1, expect_checks=("instantly-copy",),
     forbid_checks=("routes", "agent-v1-config", "agent-v2-config", "cta-sentence"))


def _signoff_html(sb):
    """The campaign's sign-off block, derived from the config rather than retyped.

    Hardcoding this cost four fixtures at once when the sender changed on 2026-08-29. A fixture
    that names a value the repo no longer holds either mutates nothing (and silently tests
    nothing) or injects genuine drift into a case asserting there is none."""
    return "Ellen<br>" + sb.json("reach-engine/config-oryoniq.json")["sender"].split("\n", 1)[1]


def mutate_campaign_sender(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    v = c["sequences"][0]["steps"][1]["variants"][0]
    v["body"] = v["body"].replace(_signoff_html(sb), "Ellen<br>Acme Corp")
    assert "Acme Corp" in v["body"], "fixture no-op: sign-off anchor moved"
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("a stale sign-off in a FOLLOW-UP touch is caught too",
     mutate_campaign_sender, 1, expect_checks=("instantly-copy",))


def mutate_bait_and_switch(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    v = c["sequences"][0]["steps"][0]["variants"][0]
    v["body"] = v["body"].replace("{{sendrPageUrl}}</a>",
                                  "{{sendrPageUrl}}</a> or https://www.visioneerit.com/contact")
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("an OryonIQ email linking visioneerit.com is caught (the 2026-08-17 bug)",
     mutate_bait_and_switch, 1, expect_checks=("instantly-copy",),
     expect_text=("visioneerit's CTA",))

case("rewording the n8n CTA sentence away from the deployed one -> `cta-sentence`",
     lambda sb: sb.sub_node_js("n8n-workflows/VIO-operator-agent.json", "Assemble + Report",
                               "I put a short page together for ${cfg.company} so you can see the format",
                               "Made you a page, ${cfg.company}"),
     1, expect_checks=("cta-sentence",), forbid_checks=("routes", "agent-v1-config"))

case("reordering the n8n email blocks -> `email-shape`",
     lambda sb: sb.sub_node_js(
         "n8n-workflows/VIO-operator-agent.json", "Assemble + Report",
         "`Hi ${cfg.first_name},\\n\\n${opener}\\n\\n${cfg.offer}\\n\\n${ask}\\n\\n${cfg.sender}`",
         "`Hi ${cfg.first_name},\\n\\n${cfg.offer}\\n\\n${opener}\\n\\n${ask}\\n\\n${cfg.sender}`"),
     1, expect_checks=("email-shape",))

case("declaring the email incomplete WITHOUT carrying the omitted sentence is drift",
     lambda sb: sb.sub_node_js("n8n-workflows/VIO-operator-agent.json", "Assemble + Report",
                               "const cta_line_pending = `I put a short page",
                               "const something_else = `I put a short page"),
     1, expect_checks=("email-shape",), expect_text=("cta_line_pending",))


# ------------------------------------------------------------------ 3. false positives
print("\n3. template-only differences must NOT report as drift (the case that matters most)")

NO_DRIFT = ("routes", "agent-v1-config", "agent-v2-config", "email-shape", "instantly-copy",
            "cta-sentence")


def remarkup(sb):
    """An editor re-saving the campaign: self-closing <br/>, inline styles, a stray <span>."""
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    for step in c["sequences"][0]["steps"]:
        for v in step["variants"]:
            v["body"] = (v["body"].replace("<br>", "<br/>")
                                  .replace("<div>", '<div style="font-family:Arial">')
                                  .replace(_first_words(_offer_of(sb), 1),
                                           f"<span>{_first_words(_offer_of(sb), 1)}</span>"))
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("re-marking-up the campaign HTML is not drift", remarkup, 0, forbid_checks=NO_DRIFT)


def smart_quotes(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    v = c["sequences"][0]["steps"][0]["variants"][0]
    v["body"] = v["body"].replace("you're bidding", "you’re bidding")
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("smart-quoting the offer in the campaign is not drift", smart_quotes, 0,
     forbid_checks=NO_DRIFT)


def new_subject(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    c["sequences"][0]["steps"][0]["variants"][0]["subject"] = "a totally new subject line"
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("changing a subject line is not drift", new_subject, 0, forbid_checks=NO_DRIFT)


def rewrite_touch3(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    v = c["sequences"][0]["steps"][2]["variants"][0]
    v["body"] = ("<div>Hi {{firstName}},</div><div><br></div><div>A completely different argument "
                 "that shares not one word with the config.</div><div><br></div>"
                 "<div>" + _signoff_html(sb) + "</div>")
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("a follow-up touch arguing a different angle is not drift", rewrite_touch3, 0,
     forbid_checks=NO_DRIFT)


def extra_variant(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    step1 = c["sequences"][0]["steps"][0]
    step1["variants"].append({
        "subject": "variant C",
        "body": ("<div>Hi {{firstName}},</div><div><br></div><div>{{personalization}}</div>"
                 "<div><br></div><div>An entirely new angle with none of the config copy in it.</div>"
                 "<div><br></div><div>" + _signoff_html(sb) + "</div>"),
    })
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("an extra A/B variant that drops the offer is not drift (one variant must keep it)",
     extra_variant, 0, forbid_checks=NO_DRIFT)

case("rendering the sign-off on one comma-separated line is not drift",
     # The SAME sender, rendered on one comma-separated line instead of two — a formatting
     # difference the checker must tolerate. Derived from the config, so this keeps meaning what
     # it says the next time the sender changes.
     lambda sb: sb.sub_node_js(
         "n8n-workflows/VIO-operator-agent.json", "validate_config",
         _sender_literal(sb, "n8n-workflows/VIO-operator-agent.json"),
         "sender: '"
         + sb.json("reach-engine/config-oryoniq.json")["sender"].replace("\n", ", ") + "'"),
     0, forbid_checks=NO_DRIFT)

case("truncating an agent's illustrative icp list is not drift (icp never reaches a prospect)",
     lambda sb: sb.sub_node_js(
         "n8n-workflows/VIO-operator-agent.json", "validate_config",
         _field_literal(sb, "n8n-workflows/VIO-operator-agent.json", "person_titles"),
         "person_titles: ['Capture Manager']"),
     0, forbid_checks=NO_DRIFT)

# VisioneerIT HAS a campaign as of 2026-08-29, so the old "no campaign yet is a note" case is gone.
# What matters now is the opposite: that its copy is actually CHECKED. While CAMPAIGNS mapped only
# oryoniq, the checker skipped VisioneerIT entirely and said so in a note — which reads like a pass.
# A product whose copy nothing verifies can drift from its config indefinitely.
case("VisioneerIT's campaign is checked, not skipped", None, 0,
     forbid_checks=NO_DRIFT,
     forbid_text=("no Instantly campaign file yet",))


def mutate_visioneerit_offer(sb):
    c = sb.json("reach-engine/campaign-visioneerit-pilot.json")
    v = c["sequences"][0]["steps"][0]["variants"][0]
    cfg = sb.json("reach-engine/config-visioneerit.json")
    v["body"] = v["body"].replace(cfg["offer"], "Something the config never said.")
    sb.put_json("reach-engine/campaign-visioneerit-pilot.json", c)


case("VisioneerIT campaign copy drifting from its config IS caught",
     mutate_visioneerit_offer, 1, expect_checks=("instantly-copy",))


# ------------------------------------------------------------------ 4. broken anchors
print("\n4. a missing or restructured anchor errors clearly, and never with a stack trace")


def rename_assemble(sb):
    wf = sb.json("n8n-workflows/VIO-operator-agent.json")
    for n in wf["nodes"]:
        if n["name"] == "Assemble + Report":
            n["name"] = "Assemble"
    sb.put_json("n8n-workflows/VIO-operator-agent.json", wf)


case("renaming the 'Assemble + Report' node -> exit 2 naming the node",
     rename_assemble, 2, expect_text=("Assemble + Report", "anchors on"),
     forbid_text=("Traceback",))

case("removing the `const email` assignment -> exit 2 naming the assignment",
     lambda sb: sb.sub_node_js("n8n-workflows/VIO-operator-agent.json", "Assemble + Report",
                               "const email = `Hi", "const body = `Hi"),
     2, expect_text=("const email", "Re-point"), forbid_text=("Traceback",))

case("renaming assemble_email() in engine.py -> exit 2 naming the function",
     lambda sb: sb.sub("reach-engine/engine.py", "def assemble_email(", "def build_email("),
     2, expect_text=("assemble_email",), forbid_text=("Traceback",))

case("removing the CONFIGS map from operator-agent v2 -> exit 2",
     lambda sb: sb.sub_node_js("n8n-workflows/VIO-operator-agent-v2.json", "validate_config",
                               "const CONFIGS = {", "const PRODUCT_CONFIGS = {"),
     2, expect_text=("CONFIGS",), forbid_text=("Traceback",))

case("removing the ROUTES block -> exit 2",
     lambda sb: sb.sub_node_js("n8n-workflows/VIO-sendr-generate-page.json",
                               "Route Product to Template",
                               "const ROUTES = {", "const R = {"),
     2, expect_text=("ROUTES",), forbid_text=("Traceback",))


def break_campaign(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    c["sequences"][0]["steps"][0].pop("variants")
    c["sequences"][0]["steps"][0]["body"] = "flattened"
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


case("restructuring the Instantly campaign -> exit 2 naming the path it expected",
     break_campaign, 2, expect_text=("sequences[0].steps[*].variants[*].body",),
     forbid_text=("Traceback",))


def unclosed_object(sb):
    """A half-finished edit by a concurrent agent: the literal never closes.

    Cuts the CONFIGS map mid-literal rather than anchoring on the text that follows it. The
    previous version partitioned on `};\\n\\nconst REQUIRED_STR`, which encoded v1's old
    single-`const cfg` shape — so making v1 product-aware broke the fixture rather than the
    thing it tests. What must hold is only that an unclosed literal errors instead of crashing.
    """
    wf, n = sb.node("n8n-workflows/VIO-operator-agent.json", "validate_config")
    js = n["parameters"]["jsCode"]
    start = js.find("const CONFIGS = {")
    assert start != -1, "no `const CONFIGS = {` in validate_config — update this fixture"
    n["parameters"]["jsCode"] = js[:start + 220]
    sb.put_json("n8n-workflows/VIO-operator-agent.json", wf)


case("a half-written config literal errors instead of crashing", unclosed_object, 2,
     expect_text=("never closed",), forbid_text=("Traceback",))


def wrong_field(sb):
    """The inert-parameter trap from CLAUDE.md: the code moved to a field n8n does not render."""
    wf, n = sb.node("n8n-workflows/VIO-operator-agent.json", "Assemble + Report")
    n["parameters"]["code"] = n["parameters"].pop("jsCode")
    sb.put_json("n8n-workflows/VIO-operator-agent.json", wf)


case("jsCode moved to another parameter -> exit 2, not a crash", wrong_field, 2,
     expect_text=("parameters.jsCode",), forbid_text=("Traceback",))


# ------------------------------------------------------------------ 5. --fix
print("\n5. --fix rewrites only the ROUTES map and refuses everything else")


def routes_and_agent_drift(sb):
    cfg = sb.json("reach-engine/config-oryoniq.json")
    cfg["signal"] = "A brand new dated market signal, 2026-09-01."
    sb.put_json("reach-engine/config-oryoniq.json", cfg)


sb = Sandbox().clean_baseline()
try:
    before_agent = sb.read("n8n-workflows/VIO-operator-agent.json")
    before_agent2 = sb.read("n8n-workflows/VIO-operator-agent-v2.json")
    before_camp = sb.read("reach-engine/campaign-oryoniq-pilot.json")
    routes_and_agent_drift(sb)
    p = sb.run("--fix")
    routes_js = [n for n in sb.json("n8n-workflows/VIO-sendr-generate-page.json")["nodes"]
                 if n["name"] == "Route Product to Template"][0]["parameters"]["jsCode"]

    check("--fix rewrites the ROUTES map", "2026-09-01" in routes_js,
          indent(p.stdout))
    check("--fix leaves VIO-operator-agent.json byte-identical",
          sb.read("n8n-workflows/VIO-operator-agent.json") == before_agent)
    check("--fix leaves VIO-operator-agent-v2.json byte-identical",
          sb.read("n8n-workflows/VIO-operator-agent-v2.json") == before_agent2)
    check("--fix leaves the live Instantly campaign byte-identical",
          sb.read("reach-engine/campaign-oryoniq-pilot.json") == before_camp)
    check("--fix says out loud what it refused and why",
          "REFUSED agent-v1-config" in p.stdout and "REFUSED agent-v2-config" in p.stdout,
          indent(p.stdout))
    check("--fix still exits non-zero while report-only drift stands", p.returncode == 1,
          f"exit={p.returncode}")
finally:
    sb.destroy()


def campaign_only_drift(sb):
    c = sb.json("reach-engine/campaign-oryoniq-pilot.json")
    v = c["sequences"][0]["steps"][0]["variants"][0]
    offer = _offer_of(sb)
    assert offer in v["body"], "step 1 variant A no longer carries the config offer verbatim"
    v["body"] = v["body"].replace(offer, "OryonIQ finds things, differently worded.")
    sb.put_json("reach-engine/campaign-oryoniq-pilot.json", c)


sb = Sandbox().clean_baseline()
try:
    before_camp = sb.read("reach-engine/campaign-oryoniq-pilot.json")
    before_routes = sb.read("n8n-workflows/VIO-sendr-generate-page.json")
    campaign_only_drift(sb)
    after_camp = sb.read("reach-engine/campaign-oryoniq-pilot.json")
    p = sb.run("--fix")
    check("--fix never touches the campaign that actually sends",
          sb.read("reach-engine/campaign-oryoniq-pilot.json") == after_camp)
    check("--fix does not rewrite an already-clean ROUTES map",
          sb.read("n8n-workflows/VIO-sendr-generate-page.json") == before_routes)
    check("--fix refuses the campaign with a stated reason",
          "REFUSED instantly-copy" in p.stdout and "real prospects" in p.stdout, indent(p.stdout))
    check("--fix exits 1 when it could fix nothing", p.returncode == 1, f"exit={p.returncode}")
finally:
    sb.destroy()


sb = Sandbox().clean_baseline()
try:
    rename_assemble(sb)
    before = sb.read("n8n-workflows/VIO-sendr-generate-page.json")
    routes_and_agent_drift(sb)
    p = sb.run("--fix")
    check("--fix writes nothing while an anchor is broken (exit 2)",
          p.returncode == 2 and sb.read("n8n-workflows/VIO-sendr-generate-page.json") == before,
          f"exit={p.returncode}\n{indent(p.stdout)}")
finally:
    sb.destroy()


# ------------------------------------------------------------------
print(f"\n{len(PASS)}/{len(PASS) + len(FAIL)} passed")
if FAIL:
    print("failed:\n  " + "\n  ".join(FAIL))
sys.exit(1 if FAIL else 0)
