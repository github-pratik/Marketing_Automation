#!/usr/bin/env python3
"""
Generate a Sendr personalized page per lead, from an EXISTING Sendr page template.

Sendr has no create-template API — a real template must be built in Sendr's UI first
(Pages -> New template). Which template to use is read from the product config's `sendr` block,
so this file never needs editing to serve another Visioneerit product:

    config-oryoniq.json     -> template 8462, campaign 10748  (OryonIQ - GovCon Capture/BD)
    config-visioneerit.json -> template 8464, campaign 10751  (VisioneerIT - Federal/SLED)

This only ever GENERATES pages. It cannot send anything and cannot enrol a lead into a sequence —
Sendr has no add-lead-to-campaign endpoint at all, so campaign enrolment stays a human action in
the Sendr UI. Nothing here can put a lead into an active outreach sequence.

Usage:
  python3 push_to_sendr_page.py seed-test.json --config config-oryoniq.json
  python3 push_to_sendr_page.py leads.json --config config-visioneerit.json
  python3 push_to_sendr_page.py leads.json --template-id 8462          # explicit override
  python3 push_to_sendr_page.py leads.json --config config-oryoniq.json --dry-run
"""
import json, os, sys, argparse, urllib.request, urllib.error

from engine import assemble_email

ROOT = os.path.dirname(os.path.abspath(__file__))
SENDR = "https://api.sendr.io/api/v1"

# Sendr's own enum for POST /enrichment/sendr-page. Anything not in here is rejected by the API.
GIF_SOURCES = ("landing-page", "video-thumbnail", "dynamic-website", "linkedin-profile")
# These two make the GIF out of an external target, so the API rejects the request with
# "gifWebsiteUrl is required..." unless a URL comes with them.
GIF_SOURCES_NEEDING_URL = ("dynamic-website", "linkedin-profile")


def resolve(p):
    """Accept a path relative to this folder OR to wherever the user actually is. Paths default to
    reach-engine/, but `reach-engine/config-oryoniq.json` typed from the repo root is the obvious
    thing to write and used to fail with a confusing doubled path."""
    if os.path.isabs(p):
        return p
    for cand in (os.path.join(ROOT, p), os.path.abspath(p)):
        if os.path.exists(cand):
            return cand
    return os.path.join(ROOT, p)


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
    # See INTEGRATIONS.md: some vendors' WAFs block urllib's default User-Agent outright.
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


def get_template_variables(template_id, secrets):
    status, data = http_json(f"{SENDR}/page-template/{template_id}/variables",
                             "GET", {"X-API-Key": secrets["SENDR_API_KEY"]})
    return data if status == 200 and isinstance(data, list) else []


def build_variables_values(lead, template_vars, cfg=None):
    """Map reach-engine's lead + config fields onto whatever tags the real template actually
    declares — read dynamically, not hardcoded, so this doesn't need editing when the template's
    copy changes. Sendr's own fallback/exampleValue is used before an empty string, so a tag we
    can't fill degrades to the template author's intended placeholder rather than a visible blank.

    The pool is deliberately wider than any one template uses: declaring a tag in the Sendr UI is
    then the ONLY step needed to start filling it. See sendr-page-template.md for the tags worth
    declaring and why (the AI-written `opener` is the big one — the email has always had it, the
    page has not)."""
    cfg = cfg or {}
    pursuits = lead.get("pursuits") or []
    pool = {
        # Lead identity
        "first_name": lead.get("first_name"), "firstname": lead.get("first_name"),
        "company": lead.get("company"), "company_name": lead.get("company"),
        "title": lead.get("title"), "job_title": lead.get("title"),
        "company_domain": lead.get("company_domain"),
        # The per-lead AI line the engine already writes for the email.
        "opener": lead.get("opener"), "personalization": lead.get("opener"),
        # Campaign-level copy, straight from the product config — so the page and the email argue
        # the same case instead of drifting apart in two different editors.
        "product": cfg.get("product"), "signal": cfg.get("signal"),
        "offer": cfg.get("offer"), "cta": cfg.get("cta"),
        # Kept distinct from `cta` on purpose — Sendr's calendar element iframes this value,
        # and an ordinary page that sets X-Frame-Options renders as a grey broken box.
        "booking_url": cfg.get("booking_url"),
        "one_liner": cfg.get("one_liner"),
        "sender": (cfg.get("sender") or "").replace("\n", ", "),
        # GovCon specifics, when an enrichment step has supplied them (see sendr-page-template.md).
        "naics": lead.get("naics"), "set_aside": lead.get("set_aside"),
        "pursuit_1": pursuits[0] if len(pursuits) > 0 else None,
        "pursuit_2": pursuits[1] if len(pursuits) > 1 else None,
        "pursuit_3": pursuits[2] if len(pursuits) > 2 else None,
    }
    values = {}
    for v in template_vars:
        tag = v.get("tag")
        if not tag:
            continue
        values[tag] = pool.get(tag) or v.get("fallback") or v.get("exampleValue") or ""
    return values


def lead_website(lead):
    """A real https:// URL for the lead's own company, or None. Sendr screenshots this for the
    dynamic-website GIF and the video background — it is what makes the page feel 1:1."""
    domain = (lead.get("company_domain") or "").strip()
    if not domain:
        email = lead.get("contact_email") or ""
        domain = email.split("@", 1)[1] if "@" in email else ""
    domain = domain.replace("https://", "").replace("http://", "").strip("/").split("/")[0]
    return f"https://{domain}" if domain and "." in domain else None


def build_body(lead, template_id, template_vars, sendr_cfg, product, webhook_url=None, cfg=None):
    """Assemble the exact POST body, including the media fields the template needs.

    The gif fields are not optional decoration: a template whose GIF element is set to
    dynamic-website or linkedin-profile makes the API reject the whole request with
    "gifWebsiteUrl is required when gifSource is dynamic-website or linkedin-profile" unless a URL
    is supplied. Sending gifSource EXPLICITLY (rather than inheriting the template's) means this
    script decides, per lead, whether it can satisfy that requirement — and degrades to
    landing-page (which needs no external URL) when it can't, instead of failing the lead."""
    want = sendr_cfg.get("gif_source", "landing-page")
    if want not in GIF_SOURCES:
        want = "landing-page"
    site = lead_website(lead)
    gif_source = want if (want not in GIF_SOURCES_NEEDING_URL or site) else "landing-page"

    body = {
        "templateId": int(template_id),
        "variablesValues": build_variables_values(lead, template_vars, cfg),
        "gifSource": gif_source,
        # Echoed back on every page + engagement webhook. This is the ONLY way to tell which lead
        # an otherwise anonymous "someone viewed a page" event belongs to, so it is not optional.
        # Keys are camelCase deliberately: Sendr camelCases them on the way back (verified live —
        # `lead_email` came back as `leadEmail`), so sending camelCase keeps sent == received and
        # spares the n8n side a casing guess. Sendr also injects its own `_GifHyperlinkText`.
        "attributes": {
            "product": product,
            "leadEmail": lead.get("contact_email") or "",
            "leadName": lead.get("first_name") or "",
            "company": lead.get("company") or "",
            "apolloId": str(lead.get("apollo_id") or ""),
            "sendrCampaignId": str(sendr_cfg.get("campaign_id") or ""),
            "source": "reach-engine",
        },
    }
    if gif_source in GIF_SOURCES_NEEDING_URL:
        body["gifWebsiteUrl"] = site
    if sendr_cfg.get("gif_hyperlink_text"):
        body["gifHyperlinkText"] = sendr_cfg["gif_hyperlink_text"]
    if site:
        # Only used if the template actually has a video with Dynamic Video Background enabled;
        # harmless and ignored otherwise, so it is always safe to send when we know the site.
        body["videoBackgroundUrl"] = site
        body["videoBackgroundType"] = "scroll"
    if webhook_url:
        body["webhookUrl"] = webhook_url
    return body


def generate_page(body, secrets):
    return http_json(f"{SENDR}/enrichment/sendr-page", "POST",
                     {"X-API-Key": secrets["SENDR_API_KEY"], "Content-Type": "application/json"}, body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("leads_file", help="a leads.json or seed-test.json produced by engine.py")
    ap.add_argument("--config", default=None,
                    help="product config whose `sendr` block holds the template + campaign ids")
    ap.add_argument("--template-id", default=None, help="override the config's page_template_id")
    ap.add_argument("--webhook-url", default=None,
                    help="optional per-page inline callback. Prefer the workspace webhook (see "
                         "INTEGRATIONS.md) — Sendr scopes an inline URL to ONE generated page.")
    ap.add_argument("--dry-run", action="store_true", help="print the exact bodies, call nothing")
    args = ap.parse_args()

    if not args.config and not args.template_id:
        sys.exit("Pass --config config-oryoniq.json (preferred) or --template-id.")

    cfg, sendr_cfg, product = {}, {}, "unknown"
    if args.config:
        cfg_path = resolve(args.config)
        cfg = json.load(open(cfg_path))
        product = cfg.get("product", "unknown")
        sendr_cfg = cfg.get("sendr") or {}
        if not sendr_cfg and not args.template_id:
            sys.exit(f"{os.path.basename(cfg_path)} has no `sendr` block and no --template-id given.")

    template_id = args.template_id or sendr_cfg.get("page_template_id")
    if not template_id:
        sys.exit("No page_template_id — set config.sendr.page_template_id or pass --template-id.")

    sec_path = find_secrets()
    if not sec_path:
        sys.exit("No .secrets.env found.")
    secrets = load_secrets(sec_path)
    if not secrets.get("SENDR_API_KEY"):
        sys.exit("Missing SENDR_API_KEY in .secrets.env")

    leads_path = resolve(args.leads_file)
    leads = json.load(open(leads_path))

    template_vars = get_template_variables(template_id, secrets)
    if not template_vars:
        sys.exit(f"Template {template_id} has no readable variables — wrong id, or wrong account?")

    tags = ", ".join(v.get("tag", "?") for v in template_vars)
    print(f"[pages] {product} · {len(leads)} lead(s) from {os.path.basename(leads_path)}")
    print(f"        template {template_id} declares: {tags}")
    if sendr_cfg.get("campaign_name"):
        print(f"        pairs with Sendr campaign {sendr_cfg['campaign_id']} · {sendr_cfg['campaign_name']}")
    print()

    made, failed, degraded = 0, 0, 0
    for lead in leads:
        body = build_body(lead, template_id, template_vars, sendr_cfg, product, args.webhook_url, cfg)
        if body["gifSource"] != sendr_cfg.get("gif_source", "landing-page"):
            degraded += 1
            print(f"  note  {lead.get('first_name')}: no company domain known -> GIF falls back to "
                  f"landing-page instead of {sendr_cfg.get('gif_source')}")
        if args.dry_run:
            made += 1
            print(f"  DRY   {lead.get('first_name')}: {json.dumps(body)}")
            continue
        status, data = generate_page(body, secrets)
        if status in (200, 201):
            made += 1
            # Recorded on the lead so the rest of the chain can find this page again —
            # make_scroll_gif.py needs the id, push_to_instantly.py needs the URL.
            lead["sendr_page_id"] = data.get("pageId")
            lead["sendr_page_url"] = data.get("pageUrl")
            # The email leg has always had the AI opener; now it also gets the specific,
            # personalized page link instead of the generic config CTA — see engine.py's
            # assemble_email(). Skipped for leads verify already hard-dropped (no opener to use).
            opener = lead.get("opener") or ""
            if lead.get("sendr_page_url") and opener and not opener.startswith("["):
                lead["email_draft"] = assemble_email(lead, opener, cfg, page_url=lead["sendr_page_url"])
            print(f"  page  {lead.get('first_name')}: {data.get('pageUrl')}   (pageId {data.get('pageId')})")
            for w in data.get("warnings") or []:
                print(f"        warning: {w}")
        else:
            failed += 1
            print(f"  FAIL  {lead.get('first_name')}: HTTP {status} {data}", file=sys.stderr)

    if made and not args.dry_run:
        json.dump(leads, open(leads_path, "w"), indent=2)
        print(f"\n[pages] wrote sendr_page_id + sendr_page_url back into "
              f"{os.path.basename(leads_path)} (make_scroll_gif.py reads the id from there)")

    tail = f", {degraded} with a degraded GIF source" if degraded else ""
    print(f"\n[done] generated {made}, failed {failed}{tail}.")
    if made and not args.dry_run:
        print("       Pages are rendering async — engagement events arrive on the Sendr workspace")
        print("       webhook (n8n VIO-sendr-events). Nothing has been sent to anyone.")


if __name__ == "__main__":
    main()
