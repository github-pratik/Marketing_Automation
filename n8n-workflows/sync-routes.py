#!/usr/bin/env python3
"""
Keep every consumer of the campaign copy in sync with reach-engine/config-<product>.json.

WHY THIS EXISTS
---------------
The campaign copy — signal / offer / cta / sender / one_liner / personalization_prompt — is
authored in ONE place (`reach-engine/config-<product>.json`) and then hand-copied into five other
places that each reach a prospect by a different route. There is no automatic link between them,
so they drift, and drift here is never cosmetic: the prospect gets two different arguments for the
same product in the same touch.

It has happened twice already.
  2026-08-16  The Sendr page said "budget signals are moving fast" (a Sendr placeholder) while the
              email cited the dated CMMC suspension. Fixed by the ROUTES check below.
  2026-08-22  The n8n operator agent emitted the retired "Want the three it's surfacing..." CTA
              while the deployed Instantly template links the lead's own Sendr page. The node was
              repaired the same day; engine.py's preview of the same sentence was NOT, and this
              script found that survivor.

Re-copying by hand is the documented procedure and it has already been forgotten twice. This turns
that discipline into a check that fails loudly.

  python3 sync-routes.py            # check only; exits 1 on drift, prints a field-level diff
  python3 sync-routes.py --fix      # regenerate ONLY what is safe to regenerate (see below)

Exit codes:  0 = clean   1 = drift found   2 = an anchor could not be found (see ANCHORING)

After --fix, re-import the workflow (see README.md) — editing the JSON does not deploy it.


WHAT IS CANONICAL
-----------------
Two different things are canonical, for two different kinds of question.

  1. `reach-engine/config-<product>.json` is canonical for the copy VALUES.
     product / one_liner / signal / offer / cta / sender / personalization_prompt / sendr.*
     Anything that embeds a literal copy of one of these must match it.

  2. `reach-engine/engine.py`'s `assemble_email()` is canonical for the email body SHAPE — the
     ordered sequence of blocks (greeting, opener, offer, CTA line, sign-off). It is the only
     implementation that carries BOTH branches (a lead with a generated Sendr page, and a lead
     without one), and every other body was copied from it.

  3. `reach-engine/campaign-<product>-*.json` step 1 is canonical for the CTA SENTENCE — the words
     that put the link in front of the prospect. Not engine.py, and not the config: the Instantly
     template is the only one of the three that a prospect ever reads, so when the wording differs
     it is the template that is right by definition and the previews that are stale. This is
     deliberately the one place where the config is NOT the authority, because the config has no
     field for it.

WHAT IS *NOT* MECHANICALLY DERIVABLE (and is therefore deliberately not checked)
-------------------------------------------------------------------------------
A checker that reports false drift gets ignored within a week, so the line is drawn narrowly:

  * Merge tags and HTML.  `{{firstName}}`, `{{personalization}}`, `{{sendrPageUrl}}`,
    `<div>`/`<br>`/`<a href>` are Instantly-side structure with no representation in the config.
    Campaign bodies are normalised to plain text BEFORE comparison, so re-marking-up a paragraph
    is not drift.
  * Subject lines.  The config has no subject field. Template-only.
  * Follow-up touches 2-4 of the Instantly sequence.  They exist precisely to argue a DIFFERENT
    angle from the config's `offer` (and today they are unfinished `[[!! ... !!]]` placeholders).
    Requiring the config's offer in them would be false drift by construction. Only step 1 is
    checked for the offer.
  * Step 1 variant B.  An A/B variant is a different argument on purpose. The rule is "the config's
    offer must survive in AT LEAST ONE step-1 variant", not "in every variant".
  * `signal`.  It is fed to OpenAI as system-prompt grounding at run time; it never appears
    literally in any template, so there is nothing to compare against.
  * `icp`.  It steers Apollo search and never reaches a prospect. The agent nodes carry truncated
    illustrative title lists on purpose; flagging that would be noise. Only copy that can reach a
    prospect is checked.
  * Sign-off line breaks.  "Ellen\nOryonIQ, VisioneerIT" (plain text), "Ellen<br>OryonIQ,
    VisioneerIT" (HTML) and "Ellen, OryonIQ, VisioneerIT" (a one-line agent-tool return) are the
    same copy rendered for three media. Senders are compared as a name list, not byte for byte.
  * Typography.  Curly quotes and en/em dashes are normalised to their ASCII forms on BOTH sides
    before comparison, so an editor smart-quoting a paragraph is not a copy change.
  * A body that DECLARES itself incomplete.  `VIO-operator-agent` has no Sendr leg, so it has no
    per-lead page URL to put in the CTA line. It omits that line and says so in its own output
    (`email_complete: false`, `missing: ['sendr_page_url']`) while carrying the exact sentence the
    live campaign inserts in `cta_line_pending`. That is an honest subset, not drift: the omitted
    block is spliced back from `cta_line_pending` before comparing. A node that declares itself
    incomplete WITHOUT carrying the omitted sentence IS drift, because then nothing can be checked.
  * engine.py's no-page CTA branch.  It is the fallback for a lead with no generated page. Leads
    without a page are skipped rather than enrolled, so that sentence never sends; holding it to
    the Instantly wording would report a fallback as a defect.

WHAT --fix WILL AND WILL NOT REWRITE
------------------------------------
--fix rewrites exactly ONE thing: the generated `const ROUTES = {...}` block in
VIO-sendr-generate-page.json. That block carries a "GENERATED ... do not hand-edit" banner, this
script owns it, and nothing else lives inside it.

Everything else is REPORT-ONLY, and --fix refuses it explicitly rather than silently skipping:

  * `campaign-oryoniq-pilot.json` — NEVER auto-rewritten. It is the artifact that actually reaches
    real prospects; a bad machine edit is a wrong claim in a real inbox, not a failing test. It
    also carries deliberate `[[!! ... !!]]` operator placeholders and an A/B variant that a
    regenerator would flatten, and deploying it PATCHes a live campaign (which reactivates a paused
    one — verified 2026-08-21). A human must read every word of that diff.
  * `VIO-operator-agent.json` / `VIO-operator-agent-v2.json` — NEVER auto-rewritten. Their config
    literals are hand-written JavaScript interleaved with validation logic, not a generated block,
    so rewriting them means taking ownership of code this script did not write. They are also
    under concurrent edit by other agents; a blind machine rewrite would race a human change.
  * The email-body SHAPE checks — structural findings about code, not values. There is no
    mechanical rewrite that would be safe.

If report-only drift remains after a --fix run, the script still exits 1. "Fixed" must never mean
"the remaining problems were hidden".

ANCHORING
---------
Every consumer is located by a stable NAME, never by position or by content:
  * n8n nodes by `node["name"]` — node names are stable across edits; jsCode is not.
  * Python by `def assemble_email` via the `ast` module, so reformatting cannot break it.
  * The Instantly campaign by `sequences[0].steps[*].variants[*].body`.
If an anchor is missing or has been restructured, the script prints a specific, actionable message
naming the file, the node and what it expected, and exits 2 — never a stack trace. That matters
because `Assemble + Report` is under concurrent edit; the NAME will hold, the body may not.
"""
import argparse
import ast
import json
import os
import re
import sys
from html import unescape

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG_DIR = os.path.join(ROOT, os.pardir, "reach-engine")

SENDR_WORKFLOW = os.path.join(ROOT, "VIO-sendr-generate-page.json")
AGENT_V1 = os.path.join(ROOT, "VIO-operator-agent.json")
AGENT_V2 = os.path.join(ROOT, "VIO-operator-agent-v2.json")
ENGINE_PY = os.path.join(CONFIG_DIR, "engine.py")

NODE_NAME = "Route Product to Template"          # in VIO-sendr-generate-page.json
AGENT_CONFIG_NODE = "validate_config"            # in both operator agents
AGENT_ASSEMBLE_NODE = "Assemble + Report"        # in VIO-operator-agent.json (v1)

# product key -> config filename. The key is what the caller passes as `product`, lowercased and
# stripped to letters, so "OryonIQ" and "oryoniq" both land here.
PRODUCTS = {
    "oryoniq": "config-oryoniq.json",
    "visioneerit": "config-visioneerit.json",
}

# product key -> the Instantly campaign definition that actually sends for it. A product with no
# campaign file yet (VisioneerIT) is SKIPPED with a note, not reported as drift — "not built yet"
# and "built wrong" are different states and must read differently.
CAMPAIGNS = {
    "oryoniq": "campaign-oryoniq-pilot.json",
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

# The copy fields an operator-agent node embeds that can reach a prospect. `one_liner` and
# `personalization_prompt` are included because the agent hands them to the LLM that writes the
# opener, so they shape prospect-facing text even though they are never sent verbatim.
AGENT_COPY_FIELDS = ["product", "one_liner", "signal", "offer", "cta", "sender",
                     "personalization_prompt"]

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


# --------------------------------------------------------------------------------------------
# Result plumbing. Every check returns a Result; nothing calls sys.exit() from inside a check, so
# one broken anchor cannot hide the findings of the other five consumers.
# --------------------------------------------------------------------------------------------
class Result:
    def __init__(self, name, target, fixable=False, refuse_reason=None):
        self.name = name              # short id printed in the report
        self.target = target          # human-readable "what was checked"
        self.fixable = fixable        # may --fix rewrite this?
        self.refuse_reason = refuse_reason
        self.drift = []               # list of multi-line strings
        self.errors = []              # anchor/structure problems -> exit 2
        self.notes = []               # informational, never affects the exit code

    def ok(self):
        return not self.drift and not self.errors


def fail(result, msg):
    result.errors.append(msg)
    return result


# --------------------------------------------------------------------------------------------
# Normalisers. Each one exists to kill a specific class of FALSE drift; see the module docstring.
# --------------------------------------------------------------------------------------------
TYPO_MAP = {"‘": "'", "’": "'", "“": '"', "”": '"',
            "–": "-", "—": "-", " ": " "}


def norm_text(s):
    """Fold typographic variants that an HTML editor or a copy-paste introduces. Applied to BOTH
    sides, so it can only hide a change of punctuation style, never a change of words."""
    for a, b in TYPO_MAP.items():
        s = s.replace(a, b)
    return re.sub(r"[ \t]+", " ", s).strip()


def norm_sender(s):
    """A sign-off is a list of names. Plain text puts them on two lines, HTML uses <br>, an agent
    tool returns them on one comma-separated line. Compare the names, not the separators."""
    parts = [p.strip() for p in re.split(r"[\n,]+", norm_text(s))]
    return ", ".join(p for p in parts if p)


def html_to_text(html):
    """Instantly bodies are HTML; the config is plain text. Strip the markup (keeping <a> inner
    text, which is where {{sendrPageUrl}} lives) so a re-marked-up paragraph is not drift."""
    t = re.sub(r"(?i)<br\s*/?>", "\n", html)
    t = re.sub(r"(?i)</div\s*>", "\n", t)
    t = re.sub(r"(?i)<div[^>]*>", "", t)
    t = re.sub(r"(?i)</?p[^>]*>", "\n", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = unescape(t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


# --------------------------------------------------------------------------------------------
# Tiny JavaScript readers. n8n stores code as a JSON string; there is no JS parser here, so these
# are deliberately narrow: find a named object literal, then read specific string fields out of it.
# --------------------------------------------------------------------------------------------
STR_LIT = r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`"

_JS_ESC = {"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v",
           "0": "\0", "\\": "\\", "'": "'", '"': '"', "`": "`", "\n": ""}


def js_unquote(lit):
    body = lit[1:-1]
    out, i = [], 0
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            if nxt == "u" and re.match(r"[0-9a-fA-F]{4}", body[i + 2:i + 6]):
                out.append(chr(int(body[i + 2:i + 6], 16)))
                i += 6
                continue
            out.append(_JS_ESC.get(nxt, nxt))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def js_balanced(src, open_idx):
    """Return the index just past the `}` matching the `{` at open_idx, skipping string literals
    and comments so a brace inside a quoted sentence cannot end the object early."""
    depth, i, n = 0, open_idx, len(src)
    while i < n:
        c = src[i]
        if c in "'\"`":
            q, i = c, i + 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == q:
                    break
                i += 1
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            i = src.find("\n", i)
            if i == -1:
                return -1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1


def js_object_source(src, header_re, what):
    """Slice out `<header> { ... }`. Returns (text, None) or (None, error message)."""
    m = re.search(header_re, src)
    if not m:
        return None, f"could not find {what} (looked for /{header_re}/)"
    end = js_balanced(src, m.end() - 1)
    if end == -1:
        return None, f"found {what} but its `{{` is never closed — the object literal is malformed"
    return src[m.end() - 1:end], None


def js_string_fields(obj_src, fields):
    """Read `key: '...'` string values for the named keys out of an object literal source."""
    out = {}
    for f in fields:
        m = re.search(r"(?<![\w$])" + re.escape(f) + r"\s*:\s*(" + STR_LIT + r")", obj_src)
        if m:
            out[f] = js_unquote(m.group(1))
    return out


# --------------------------------------------------------------------------------------------
# Email-body SHAPE. Both the Python reference and the n8n node are reduced to the same canonical
# string: literal text preserved, every interpolation replaced by a named slot. That way renaming
# a local variable, or switching cfg['offer'] to cfg.offer, is not drift — but reordering the
# blocks or rewording the CTA sentence is.
# --------------------------------------------------------------------------------------------
SLOT_ALIASES = {
    "fn": "first_name", "first_name": "first_name", "cfg.first_name": "first_name",
    'lead.get("first_name", "there")': "first_name",
    "opener": "opener", "cfg.opener": "opener",
    "cfg['offer']": "offer", 'cfg["offer"]': "offer", "cfg.offer": "offer", "offer": "offer",
    "cfg['cta']": "cta", 'cfg["cta"]': "cta", "cfg.cta": "cta", "cta": "cta",
    "cfg['sender']": "sender", 'cfg["sender"]': "sender", "cfg.sender": "sender",
    "sender": "sender",
    "company": "company", "cfg.company": "company",
    "page_url": "page_url", "pageUrl": "page_url", "cfg.page_url": "page_url",
}


def slot(expr):
    expr = " ".join(expr.split())
    return "<" + SLOT_ALIASES.get(expr, "?" + expr) + ">"


def python_email_shapes(result):
    """Reduce reach-engine/engine.py's assemble_email() to {branch: canonical shape}. Anchored on
    the function NAME via ast, so reformatting the file cannot break this."""
    try:
        with open(ENGINE_PY) as f:
            tree = ast.parse(f.read())
    except (OSError, SyntaxError) as e:
        return fail(result, f"could not parse {os.path.relpath(ENGINE_PY, ROOT)}: {e}") and None

    fn = next((n for n in ast.walk(tree)
               if isinstance(n, ast.FunctionDef) and n.name == "assemble_email"), None)
    if fn is None:
        fail(result, f"no `def assemble_email(...)` in {os.path.relpath(ENGINE_PY, ROOT)} — it is "
                     "the canonical email shape; if it was renamed, update ENGINE anchors here")
        return None

    def flatten(node, locals_):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.JoinedStr):
            out = []
            for part in node.values:
                if isinstance(part, ast.Constant):
                    out.append(str(part.value))
                elif isinstance(part, ast.FormattedValue):
                    src = ast.unparse(part.value)
                    out.append(locals_[src] if src in locals_ else slot(src))
                else:
                    out.append("<?>")
            return "".join(out)
        return "<?" + ast.unparse(node) + ">"

    # `cta_line` is assigned in an if/else; expand each branch inline so the two shapes are
    # complete sentences rather than a nested placeholder.
    branches = {}
    for node in fn.body:
        if isinstance(node, ast.If):
            for label, body in (("with_page", node.body), ("no_page", node.orelse)):
                for st in body:
                    if isinstance(st, ast.Assign) and getattr(st.targets[0], "id", "") == "cta_line":
                        branches[label] = flatten(st.value, {})
    ret = next((n for n in ast.walk(fn) if isinstance(n, ast.Return)), None)
    if ret is None or not isinstance(ret.value, ast.JoinedStr):
        fail(result, "assemble_email() no longer ends in an f-string return — cannot derive the "
                     "canonical email shape")
        return None
    if not branches:
        fail(result, "assemble_email() no longer assigns `cta_line` in an if/else — cannot derive "
                     "the with-page vs no-page CTA sentences")
        return None
    return {label: flatten(ret.value, {"cta_line": line}) for label, line in branches.items()}


def js_template_literal(js, name):
    """Reduce `const <name> = \\`...\\`` to canonical slot form, or None if it is not there."""
    m = re.search(r"const\s+" + re.escape(name) + r"\s*=\s*`((?:[^`\\]|\\.)*)`", js)
    if not m:
        return None
    raw = m.group(1)
    out, i = [], 0
    while i < len(raw):
        if raw[i] == "$" and i + 1 < len(raw) and raw[i + 1] == "{":
            j = raw.index("}", i)
            out.append(slot(raw[i + 2:j]))
            i = j + 1
        elif raw[i] == "\\" and i + 1 < len(raw):
            out.append(_JS_ESC.get(raw[i + 1], raw[i + 1]))
            i += 2
        else:
            out.append(raw[i])
            i += 1
    return slot_merge_tags("".join(out))


# Instantly merge tags are the template's way of naming the same slots. Mapping them onto the same
# vocabulary is what lets an HTML campaign body, a Python f-string and a JS template literal be
# compared at all.
MERGE_TAGS = {
    "{{sendrPageUrl}}": "<page_url>",
    "{{companyName}}": "<company>",
    "{{firstName}}": "<first_name>",
    "{{personalization}}": "<opener>",
}


def slot_merge_tags(t):
    for k, v in MERGE_TAGS.items():
        t = t.replace(k, v)
    return re.sub(r"\{\{(\w+)\}\}", r"<?\1>", t)


def block_kinds(shape, cfg):
    """Reduce a body to its ordered block kinds, discarding the prose inside each block. This is
    what makes 'the blocks are laid out the same way' checkable independently of 'the CTA sentence
    is worded the same way' — two different questions with two different canonical sources."""
    kinds = []
    for raw in re.split(r"\n{2,}", shape):
        b = norm_text(raw)
        if not b:
            continue
        if re.fullmatch(r"Hi <first_name>,?", b):
            kinds.append("greeting")
        elif b == "<opener>":
            kinds.append("opener")
        elif b == "<offer>" or b == norm_text(cfg["offer"]):
            kinds.append("offer")
        elif "<page_url>" in b or "<cta>" in b:
            kinds.append("cta_line")
        elif b == "<sender>" or norm_sender(b) == norm_sender(cfg["sender"]):
            kinds.append("sender")
        else:
            kinds.append(f"other({b[:40]!r})")
    return kinds


def cta_sentence(shape):
    """The single block that carries the link. None if the body has no such block."""
    for raw in re.split(r"\n{2,}", shape):
        b = norm_text(raw)
        if "<page_url>" in b or "<cta>" in b:
            return b
    return None


# --------------------------------------------------------------------------------------------
# Loaders
# --------------------------------------------------------------------------------------------
def load_json(path, result, what):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        fail(result, f"{what} not found at {path}")
    except json.JSONDecodeError as e:
        fail(result, f"{what} at {path} is not valid JSON: {e}")
    return None


def find_node(wf, name, path, result):
    node = next((n for n in wf.get("nodes", []) if n.get("name") == name), None)
    if node is None:
        fail(result, f"no node named '{name}' in {os.path.basename(path)} — this check anchors on "
                     f"the node NAME; if it was renamed, rename it back or update this script")
        return None
    js = node.get("parameters", {}).get("jsCode")
    if not isinstance(js, str):
        fail(result, f"node '{name}' in {os.path.basename(path)} has no `parameters.jsCode` "
                     f"string — an n8n node that renders a different field will silently ignore "
                     f"whatever is written here (see CLAUDE.md on inert node parameters)")
        return None
    return node


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


def load_raw_configs():
    """The canonical side. If this cannot be read there is nothing to check anything against, so it
    is the one place that exits immediately — with a sentence, not a traceback."""
    out = {}
    for key, fname in PRODUCTS.items():
        path = os.path.join(CONFIG_DIR, fname)
        try:
            with open(path) as f:
                out[key] = json.load(f)
        except FileNotFoundError:
            sys.exit(f"[sync] {fname} not found at {path} — it is the canonical copy source; "
                     "nothing can be checked without it.")
        except json.JSONDecodeError as e:
            sys.exit(f"[sync] {fname} is not valid JSON ({e}) — fix the config first.")
        for field in ("product", "one_liner", "signal", "offer", "cta", "sender",
                      "personalization_prompt"):
            if field not in out[key]:
                sys.exit(f"[sync] {fname} is missing '{field}' — the canonical copy is incomplete.")
    return out


# --------------------------------------------------------------------------------------------
# CHECK 1 — the ROUTES map (the original check; behaviour unchanged, and the only fixable one)
# --------------------------------------------------------------------------------------------
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
            if field in ("product", "template_id"):
                continue
            lines.append(f"    {field}: {json.dumps(r[field])},")
        lines.append("  },")
    lines.append("};")
    return "\n".join(lines)


def parse_deployed(js, result):
    """Pull the current field values out of the deployed jsCode so --check can diff field by field
    rather than just saying 'the text differs'."""
    # Swallow the contiguous `//` comment block immediately above `const ROUTES` too — it is part
    # of the generated banner. Matching only from `const` leaves the previous banner stranded above
    # the new one, and the headers stack up one per run.
    block = re.search(r"(?:^//[^\n]*\n)*^const ROUTES = \{.*?\n\};", js, re.S | re.M)
    if not block:
        fail(result, f"could not find a `const ROUTES = {{...}};` block in node '{NODE_NAME}'")
        return None, None
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


def check_routes(state):
    r = Result("routes", "VIO-sendr-generate-page.json / 'Route Product to Template' ROUTES map",
               fixable=True)
    wf = load_json(SENDR_WORKFLOW, r, "VIO-sendr-generate-page.json")
    if wf is None:
        return r
    node = find_node(wf, NODE_NAME, SENDR_WORKFLOW, r)
    if node is None:
        return r
    js = node["parameters"]["jsCode"]
    want = load_configs()
    block, have = parse_deployed(js, r)
    if block is None:
        return r

    for key, route in want.items():
        if key not in have:
            r.drift.append(f"  {key}: MISSING from the workflow entirely")
            continue
        for field in ("product", "template_id", "template_name", "gif_source",
                      "gif_hyperlink_text", "one_liner", "signal", "offer", "cta", "booking_url"):
            got, exp = have[key].get(field), route[field]
            if got != exp:
                r.drift.append(f"  {key}.{field}\n      config:   {exp!r}\n      workflow: {got!r}")
    for key in have:
        if key not in want:
            r.drift.append(f"  {key}: in the workflow but has no config — remove it or add the config")

    # Stash what --fix needs; nothing is written until main() decides.
    state["routes_fix"] = (wf, node, js, block, want)
    return r


def apply_routes_fix(state):
    wf, node, js, block, want = state["routes_fix"]
    node["parameters"]["jsCode"] = js[:block.start()] + render(want) + js[block.end():]
    with open(SENDR_WORKFLOW, "w") as f:
        json.dump(wf, f, indent=2, ensure_ascii=False)
        f.write("\n")


# --------------------------------------------------------------------------------------------
# CHECK 2/3 — the config literals embedded in the two operator agents
# --------------------------------------------------------------------------------------------
REFUSE_AGENT = ("hand-written JS interleaved with validation logic, not a generated block, and "
                "under concurrent edit by other agents — a machine rewrite would race a human")


def _compare_copy(r, label, want, got, missing_is_drift=True):
    for field in AGENT_COPY_FIELDS:
        if field not in got:
            if missing_is_drift:
                r.drift.append(f"  {label}.{field}\n      config:   {want[field]!r}\n"
                               f"      workflow: <field not present in the embedded config>")
            continue
        exp, act = want.get(field, ""), got[field]
        if field == "sender":
            same = norm_sender(exp) == norm_sender(act)
        else:
            same = norm_text(exp) == norm_text(act)
        if not same:
            r.drift.append(f"  {label}.{field}\n      config:   {exp!r}\n      workflow: {act!r}")


def check_agent_v1_config(state):
    r = Result("agent-v1-config",
               "VIO-operator-agent.json / 'validate_config' embedded cfg",
               refuse_reason=REFUSE_AGENT)
    wf = load_json(AGENT_V1, r, "VIO-operator-agent.json")
    if wf is None:
        return r
    node = find_node(wf, AGENT_CONFIG_NODE, AGENT_V1, r)
    if node is None:
        return r
    obj, err = js_object_source(node["parameters"]["jsCode"], r"const\s+cfg\s*=\s*\{",
                                f"`const cfg = {{...}}` in node '{AGENT_CONFIG_NODE}'")
    if err:
        return fail(r, f"VIO-operator-agent.json: {err} — it embeds config-oryoniq.json's copy; "
                       "if the shape changed legitimately, re-point this check")
    _compare_copy(r, "oryoniq", state["cfgs"]["oryoniq"], js_string_fields(obj, AGENT_COPY_FIELDS))
    return r


def check_agent_v2_config(state):
    r = Result("agent-v2-config",
               "VIO-operator-agent-v2.json / 'validate_config' embedded CONFIGS map",
               refuse_reason=REFUSE_AGENT)
    wf = load_json(AGENT_V2, r, "VIO-operator-agent-v2.json")
    if wf is None:
        return r
    node = next((n for n in wf.get("nodes", []) if n.get("name") == AGENT_CONFIG_NODE), None)
    if node is None:
        return fail(r, f"no node named '{AGENT_CONFIG_NODE}' in VIO-operator-agent-v2.json")
    js = node.get("parameters", {}).get("jsCode")
    if not isinstance(js, str):
        return fail(r, f"node '{AGENT_CONFIG_NODE}' in VIO-operator-agent-v2.json has no "
                       "`parameters.jsCode` string")
    outer, err = js_object_source(js, r"const\s+CONFIGS\s*=\s*\{",
                                  f"`const CONFIGS = {{...}}` in node '{AGENT_CONFIG_NODE}'")
    if err:
        return fail(r, f"VIO-operator-agent-v2.json: {err}")
    for key in PRODUCTS:
        block, err = js_object_source(outer, r"(?<![\w$])" + key + r"\s*:\s*\{",
                                      f"product block `{key}: {{...}}` inside CONFIGS")
        if err:
            r.drift.append(f"  {key}: MISSING from the CONFIGS map ({err})")
            continue
        _compare_copy(r, key, state["cfgs"][key], js_string_fields(block, AGENT_COPY_FIELDS))
    return r


# --------------------------------------------------------------------------------------------
# CHECK 4 — email body SHAPE: the n8n operator agent vs engine.py's assemble_email()
# --------------------------------------------------------------------------------------------
def check_email_shape(state):
    r = Result("email-shape",
               "VIO-operator-agent.json / 'Assemble + Report' vs engine.py assemble_email()",
               refuse_reason="a structural finding about code, not a value — there is no "
                             "mechanical rewrite that would be safe")
    cfg = state["cfgs"]["oryoniq"]
    shapes = python_email_shapes(r)
    state["py_shapes"] = shapes
    if shapes is None:
        return r
    wf = load_json(AGENT_V1, r, "VIO-operator-agent.json")
    if wf is None:
        return r
    node = find_node(wf, AGENT_ASSEMBLE_NODE, AGENT_V1, r)
    if node is None:
        return r
    js = node["parameters"]["jsCode"]

    got = js_template_literal(js, "email")
    if got is None:
        return fail(r, f"node '{AGENT_ASSEMBLE_NODE}' no longer contains a "
                       "``const email = `...` `` template literal. This check anchors on the node "
                       "NAME (stable) and on that assignment (not). Re-point it if the node was "
                       "legitimately restructured.")

    # An honest incomplete preview: the node omits a block it cannot fill and says so, carrying the
    # omitted sentence verbatim. Splice it back before comparing — otherwise the checker punishes
    # the one consumer that is being explicit about its limits.
    declares_incomplete = re.search(r"email_complete\s*:\s*false", js) is not None
    pending = js_template_literal(js, "cta_line_pending")
    if declares_incomplete:
        if pending is None:
            r.drift.append(
                f"  '{AGENT_ASSEMBLE_NODE}' sets email_complete:false but has no "
                "`const cta_line_pending = `...`` carrying the omitted sentence. Without it the\n"
                "  omission cannot be checked against the sentence that actually sends — declare\n"
                "  the missing line or fill it.")
        else:
            blocks = re.split(r"\n{2,}", got)
            got = "\n\n".join(blocks[:-1] + [pending] + blocks[-1:])
            r.notes.append(f"  '{AGENT_ASSEMBLE_NODE}' declares email_complete:false; spliced "
                           "cta_line_pending back in before comparing")
    state["js_shape"] = got

    want = {k: block_kinds(v, cfg) for k, v in shapes.items()}
    have = block_kinds(got, cfg)
    if have not in want.values():
        r.drift.append(
            "  Assemble + Report lays its blocks out unlike EITHER branch of the canonical\n"
            "  assemble_email(). (Block order only — the CTA wording is checked separately.)\n"
            + "".join(f"      engine.py [{k}]: {v}\n" for k, v in sorted(want.items()))
            + f"      n8n node:        {have}")
    return r


# --------------------------------------------------------------------------------------------
# CHECK 5 — the Instantly campaign template (the one that actually sends)
# --------------------------------------------------------------------------------------------
REFUSE_CAMPAIGN = ("it is the artifact that reaches real prospects, it carries deliberate "
                   "[[!! ... !!]] operator placeholders and an A/B variant, and deploying it "
                   "PATCHes a live campaign — a human must read every word of that diff")


def check_instantly_copy(state):
    r = Result("instantly-copy", "reach-engine/campaign-*.json vs the configs",
               refuse_reason=REFUSE_CAMPAIGN)
    other_ctas = {k: v["cta"] for k, v in state["cfgs"].items()}
    for key in PRODUCTS:
        fname = CAMPAIGNS.get(key)
        if not fname:
            r.notes.append(f"  {key}: no Instantly campaign file yet — nothing to check")
            continue
        path = os.path.join(CONFIG_DIR, fname)
        camp = load_json(path, r, fname)
        if camp is None:
            continue
        cfg = state["cfgs"][key]

        try:
            steps = camp["sequences"][0]["steps"]
            bodies = [[v["body"] for v in st["variants"]] for st in steps]
        except (KeyError, IndexError, TypeError) as e:
            fail(r, f"{fname}: expected sequences[0].steps[*].variants[*].body — the campaign "
                    f"structure is not what this check anchors on ({e.__class__.__name__}: {e})")
            continue
        if not bodies or not bodies[0]:
            fail(r, f"{fname}: sequences[0].steps[0] has no variants — nothing sends")
            continue

        texts = [[html_to_text(b) for b in step] for step in bodies]
        state.setdefault("campaign_texts", {})[key] = texts

        # (a) The config's `offer` is the claim the campaign exists to make. It must survive in at
        #     least ONE step-1 variant. Requiring it in every variant, or in the follow-ups, would
        #     report the A/B test and the deliberately-different later touches as drift.
        offer = norm_text(cfg["offer"])
        if not any(offer in norm_text(t) for t in texts[0]):
            r.drift.append(
                f"  {key}: config `offer` appears in NO step-1 variant of {fname}.\n"
                f"      config:   {cfg['offer']!r}\n"
                f"      step 1 variants say: "
                + " | ".join(repr(t[:90] + ("..." if len(t) > 90 else "")) for t in texts[0]))

        # (b) The sign-off names must match the config in every touch — a stale company name in a
        #     follow-up is the same bug wearing a different hat.
        want_sender = norm_sender(cfg["sender"])
        for si, step in enumerate(texts, start=1):
            for vi, t in enumerate(step, start=1):
                tail = norm_sender("\n".join(t.splitlines()[-2:]))
                if want_sender not in tail:
                    r.drift.append(
                        f"  {key}: {fname} step {si} variant {vi} does not sign off with the "
                        f"config `sender`.\n      config: {want_sender!r}\n      body ends: {tail!r}")

        # (c) No other product's CTA URL may appear. An OryonIQ email linking visioneerit.com is
        #     the documented bait-and-switch bug (fixed 2026-08-17) and must not creep back.
        joined = "\n".join("\n".join(step) for step in texts)
        for okey, ourl in other_ctas.items():
            if okey != key and ourl and ourl in joined:
                r.drift.append(f"  {key}: {fname} links {ourl!r}, which is {okey}'s CTA. A "
                               f"{cfg['product']} email must point at its own domain.")
    return r


# --------------------------------------------------------------------------------------------
# CHECK 6 — where the prospect is actually sent
# --------------------------------------------------------------------------------------------
def check_cta_sentence(state):
    """The words that put the link in front of the prospect. Canonical here is the DEPLOYED
    Instantly step 1, not the config and not engine.py — it is the only one a prospect reads, so
    when they disagree the previews are the stale side. This is the check that would have caught
    today's live finding."""
    r = Result("cta-sentence", "the CTA sentence, against the deployed Instantly step 1",
               refuse_reason="a structural finding about code, not a value")
    texts = state.get("campaign_texts", {}).get("oryoniq")
    if not texts:
        r.notes.append("  skipped — no readable Instantly campaign to compare against")
        return r

    # Take it from the step-1 variant that carries the page link. Variants are A/B copy tests, so
    # more than one may carry it; they must agree with each other before anything else is judged.
    lines = set()
    for t in texts[0]:
        for raw in re.split(r"\n{2,}", slot_merge_tags(t)):
            b = norm_text(raw)
            if "<page_url>" in b:
                lines.add(b)
    if not lines:
        r.notes.append("  the deployed step 1 links no per-lead Sendr page — nothing to hold the "
                       "previews to")
        return r
    if len(lines) > 1:
        r.drift.append("  the step-1 A/B variants word the CTA sentence differently — decide which "
                       "one is the campaign's CTA before the previews can be held to it:\n"
                       + "".join(f"      {ln!r}\n" for ln in sorted(lines)))
        return r
    canonical = lines.pop()

    shapes = state.get("py_shapes")
    if shapes and "with_page" in shapes:
        got = cta_sentence(shapes["with_page"])
        # Only the with-page branch is judged. The no-page branch is the fallback for a lead with
        # no generated page; those leads are skipped rather than enrolled, so it never sends.
        if got is not None and got != canonical:
            r.drift.append(
                "  engine.py assemble_email() (with-page branch) words the CTA sentence unlike the\n"
                "  deployed Instantly step 1. The template is what the prospect reads, so the\n"
                "  Python preview is the stale side.\n"
                f"      instantly: {canonical!r}\n"
                f"      engine.py: {got!r}")

    js = state.get("js_shape")
    if js is None:
        r.notes.append("  n8n operator agent skipped — its email anchor could not be read (above)")
        return r
    got = cta_sentence(js)
    if got is None:
        r.drift.append(
            f"  VIO-operator-agent.json / '{AGENT_ASSEMBLE_NODE}' produces no CTA sentence at all,\n"
            "  while the deployed Instantly step 1 links the lead's own Sendr page. Its reported\n"
            f"  email is not the email the prospect receives.\n      instantly: {canonical!r}")
    elif got != canonical:
        r.drift.append(
            f"  VIO-operator-agent.json / '{AGENT_ASSEMBLE_NODE}' words the CTA sentence unlike the\n"
            "  deployed Instantly step 1.\n"
            f"      instantly: {canonical!r}\n"
            f"      n8n node:  {got!r}")
    return r


# --------------------------------------------------------------------------------------------
CHECKS = [check_routes, check_agent_v1_config, check_agent_v2_config,
          check_email_shape, check_instantly_copy, check_cta_sentence]


def main():
    ap = argparse.ArgumentParser(
        description="Check every consumer of the campaign copy against reach-engine/config-*.json")
    ap.add_argument("--fix", action="store_true",
                    help="regenerate the ROUTES block from the configs. Nothing else is ever "
                         "rewritten — see the module docstring for why.")
    args = ap.parse_args()

    state = {"cfgs": load_raw_configs()}
    results = [c(state) for c in CHECKS]

    errors = [(r, e) for r in results for e in r.errors]
    drifted = [r for r in results if r.drift]

    for r in results:
        for n in r.notes:
            print(f"[note ] {r.name}: {n.strip()}")

    if errors:
        print("\n[sync] ANCHOR PROBLEM — a consumer is not shaped the way this checker expects.")
        print("       Nothing was rewritten. Fix the anchor or re-point the checker.\n")
        for r, e in errors:
            print(f"  {r.name} ({r.target}):\n      {e}\n")

    if not drifted and not errors:
        print(f"[sync] all {len(results)} consumers match "
              f"{', '.join(PRODUCTS.values())} — no drift.")
        return 0

    if drifted:
        total = sum(len(r.drift) for r in drifted)
        print(f"\n[sync] {total} field(s) drifted across {len(drifted)} consumer(s):\n")
        for r in drifted:
            tag = "FIXABLE" if r.fixable else "REPORT-ONLY"
            print(f"--- {r.name}  [{tag}]  {r.target}")
            print("\n".join(r.drift))
            print()

    fixed = False
    if args.fix and errors:
        # Refuse to write anything while any consumer is in an unexpected shape. An anchor error
        # means the repo is not what this script believes it is, and a --fix run that half-lands is
        # worse than one that does nothing.
        print("[sync] --fix wrote NOTHING: fix the anchor problem above first.")
        return 2
    if args.fix:
        for r in drifted:
            if r.fixable and r.name == "routes" and "routes_fix" in state:
                apply_routes_fix(state)
                fixed = True
                print(f"[sync] rewrote ROUTES in {os.path.basename(SENDR_WORKFLOW)}.")
                print("[sync] re-import the workflow to deploy it — editing the JSON does not.")
        for r in drifted:
            if not r.fixable:
                print(f"[sync] --fix REFUSED {r.name}: {r.refuse_reason}.")
                print("       Edit it by hand, or change the config so the consumer is right.")
    elif drifted:
        if any(r.fixable for r in drifted):
            print("Run with --fix to regenerate the ROUTES block from the configs.")
        if any(not r.fixable for r in drifted):
            print("The report-only findings above are never auto-fixed; see the docstring.")

    if errors:
        return 2
    if drifted and not all(r.fixable for r in drifted):
        return 1
    return 0 if fixed else 1


if __name__ == "__main__":
    sys.exit(main())
