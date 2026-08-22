#!/usr/bin/env python3
"""
Build a per-lead scroll GIF of the LEAD'S OWN WEBSITE and host it at a public URL, so it can be
embedded in the outreach email/LinkedIn message.

This exists because Sendr's own GIF task is broken on this account — `pageGifTask: missing
recordingFileUrl` on every gifSource, including `landing-page`, which by Sendr's own docs should
not need a recording at all (see ../INTEGRATIONS.md). The page itself renders fine; only the GIF
asset fails. Rather than block on the vendor, this rebuilds that one asset ourselves.

It costs nothing extra to source: Sendr already screenshots the lead's site per page (a ~1440x9000
full-page capture) and hosts it. This pans down that image. No new capture infrastructure, and no
video framework — a GIF pan over one still is an ffmpeg filter, not a composition.

Flow:
  push_to_sendr_page.py  ->  page created, Sendr renders backgroundScreenshot async
  make_scroll_gif.py     ->  fetch that screenshot, pan it, upload, return a public URL
  push_to_instantly.py   ->  that URL goes in the email

Storage is any S3-compatible bucket (Cloudflare R2 or DigitalOcean Spaces — same API). Credentials
live in .secrets.env only; see REQUIRED_SECRETS below. Signed with SigV4 by hand to keep this
stdlib-only, same as the rest of the engine.

Usage:
  python3 make_scroll_gif.py --page-id 3794813                  # one page
  python3 make_scroll_gif.py leads.json                         # every lead with a sendr_page_id
  python3 make_scroll_gif.py leads.json --no-upload             # build locally, skip storage
  python3 make_scroll_gif.py --page-id 3794813 --dry-run        # show what it would do
"""
import json, os, sys, argparse, subprocess, shutil, tempfile, hashlib, hmac, time
import urllib.request, urllib.error, urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
SENDR = "https://api.sendr.io/api/v1"

# All four are required to upload. Absent -> the GIF is still built, just not hosted.
REQUIRED_SECRETS = ("ASSET_S3_ENDPOINT", "ASSET_S3_BUCKET", "ASSET_S3_ACCESS_KEY", "ASSET_S3_SECRET_KEY")

# Email-safe defaults. 460px/8fps/48 colours lands around 390KB, which every major client will
# load inline; 600px/12fps/128 colours looks better but pushes past 1.4MB and Gmail starts
# clipping. Widen these only if you know where the mail is going.
DEFAULTS = {"width": 460, "fps": 8, "duration": 2.6, "colors": 48, "frame_h": 690, "src_w": 1100}


def resolve(p):
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


def http_json(url, headers=None, timeout=60):
    h = {"User-Agent": "Mozilla/5.0 (compatible; oryoniq-reach-engine/1.0)"}
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:
        return 0, {"error": str(e)}


def fetch_page(page_id, secrets):
    return http_json(f"{SENDR}/pages/{page_id}", {"X-API-Key": secrets["SENDR_API_KEY"]})


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; oryoniq-reach-engine/1.0)"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)
    return os.path.getsize(dest)


def build_gif(src, dest, opt):
    """Pan down a tall full-page screenshot. The crop's y expression is the whole trick: it holds
    at the top for 0.3s (so the hero is readable), then eases down to the bottom, clamped so the
    last frame never runs past the image."""
    travel = max(opt["duration"] - 0.7, 0.5)
    vf = (
        f"[0:v]scale={opt['src_w']}:-1,"
        f"crop={opt['src_w']}:{opt['frame_h']}:0:"
        f"'min(max(0\\,(t-0.3)/{travel})*(ih-{opt['frame_h']})\\,ih-{opt['frame_h']})',"
        f"scale={opt['width']}:-1:flags=lanczos,fps={opt['fps']},split[a][b];"
        f"[a]palettegen=max_colors={opt['colors']}:stats_mode=diff[p];"
        f"[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
    )
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-loop", "1",
           "-t", str(opt["duration"]), "-i", src, "-filter_complex", vf, dest]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(dest):
        return None, (r.stderr or "ffmpeg produced no output").strip()[:300]
    return os.path.getsize(dest), None


# ---- S3-compatible upload (SigV4, stdlib only — works for both R2 and DO Spaces) ----

def _sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


def s3_put(body, key, content_type, secrets):
    """Path-style PUT: <endpoint>/<bucket>/<key>. Path-style works on both R2 and Spaces, which
    virtual-host style does not (R2 has no per-bucket subdomain)."""
    endpoint = secrets["ASSET_S3_ENDPOINT"].rstrip("/")
    bucket = secrets["ASSET_S3_BUCKET"]
    region = secrets.get("ASSET_S3_REGION") or "auto"   # R2 wants "auto"; Spaces wants e.g. "nyc3"
    access, secret = secrets["ASSET_S3_ACCESS_KEY"], secrets["ASSET_S3_SECRET_KEY"]

    path = "/" + bucket + "/" + urllib.parse.quote(key, safe="/")
    host = urllib.parse.urlparse(endpoint).netloc
    amzdate = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    datestamp = amzdate[:8]
    payload_hash = hashlib.sha256(body).hexdigest()

    headers = {
        "host": host,
        "content-type": content_type,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amzdate,
    }
    # Spaces honours a public-read ACL; R2 ignores it and serves via its own public bucket setting.
    if (secrets.get("ASSET_S3_ACL") or "").strip():
        headers["x-amz-acl"] = secrets["ASSET_S3_ACL"].strip()

    signed = ";".join(sorted(headers))
    canon_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canon_req = "\n".join(["PUT", path, "", canon_headers, signed, payload_hash])
    scope = f"{datestamp}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope,
                         hashlib.sha256(canon_req.encode()).hexdigest()])
    k = _sign(("AWS4" + secret).encode(), datestamp)
    for part in (region, "s3", "aws4_request"):
        k = _sign(k, part)
    sig = hmac.new(k, to_sign.encode(), hashlib.sha256).hexdigest()
    headers["Authorization"] = (f"AWS4-HMAC-SHA256 Credential={access}/{scope}, "
                                f"SignedHeaders={signed}, Signature={sig}")

    req = urllib.request.Request(endpoint + path, data=body, method="PUT", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
    except Exception as e:
        return 0, str(e)


def public_url(key, secrets):
    base = (secrets.get("ASSET_PUBLIC_BASE") or "").rstrip("/")
    if base:
        return f"{base}/{key}"
    return f"{secrets['ASSET_S3_ENDPOINT'].rstrip('/')}/{secrets['ASSET_S3_BUCKET']}/{key}"


def storage_ready(secrets):
    return [k for k in REQUIRED_SECRETS if not secrets.get(k) or secrets[k].endswith("_here")]


# ---- main ----

def process(page_id, secrets, opt, args, outdir):
    status, page = fetch_page(page_id, secrets)
    if status != 200:
        return {"page_id": page_id, "ok": False, "error": f"page lookup HTTP {status}: {page}"}

    shot = page.get("backgroundScreenshot")
    if not shot:
        why = ("still rendering — re-run in a minute" if page.get("backgroundProcessing")
               else "no backgroundScreenshot: generate the page with a known company domain so "
                    "videoBackgroundUrl gets sent")
        return {"page_id": page_id, "ok": False, "error": why}

    # Key off the page slug, never the lead. This URL is public and goes in an email header —
    # putting a name or address in it would leak the prospect to anyone who sees the message.
    slug = page.get("pageSlug") or str(page_id)
    key = f"gif/{slug}.gif"
    dest = os.path.join(outdir, f"{slug}.gif")

    if args.dry_run:
        return {"page_id": page_id, "ok": True, "dry_run": True, "source": shot,
                "would_write": dest, "would_upload_to": key,
                "would_be_at": public_url(key, secrets) if not storage_ready(secrets) else None}

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "site")
        try:
            download(shot, src)
        except Exception as e:
            return {"page_id": page_id, "ok": False, "error": f"screenshot download failed: {e}"}
        size, err = build_gif(src, dest, opt)
        if err:
            return {"page_id": page_id, "ok": False, "error": f"ffmpeg: {err}"}

    res = {"page_id": page_id, "ok": True, "slug": slug, "file": dest, "bytes": size,
           "page_url": page.get("pageUrl")}
    if size > 1_000_000:
        res["warning"] = f"{size//1024}KB — over 1MB, Gmail will clip it; lower --width or --colors"

    if args.no_upload:
        res["uploaded"] = False
        return res
    missing = storage_ready(secrets)
    if missing:
        res["uploaded"] = False
        res["blocked_on"] = f"missing in .secrets.env: {', '.join(missing)}"
        return res

    with open(dest, "rb") as f:
        body = f.read()
    code, err = s3_put(body, key, "image/gif", secrets)
    if code not in (200, 201, 204):
        res["uploaded"] = False
        res["error"] = f"upload HTTP {code}: {err}"
        return res
    res["uploaded"] = True
    res["gif_url"] = public_url(key, secrets)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("leads_file", nargs="?", help="leads.json whose entries carry sendr_page_id")
    ap.add_argument("--page-id", default=None, help="a single Sendr page id instead of a leads file")
    ap.add_argument("--no-upload", action="store_true", help="build locally, don't touch storage")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, build nothing")
    ap.add_argument("--out", default=None, help="output dir (default reach-engine/gifs/)")
    for k, v in DEFAULTS.items():
        ap.add_argument(f"--{k.replace('_', '-')}", type=type(v), default=v)
    args = ap.parse_args()

    if not args.leads_file and not args.page_id:
        sys.exit("Pass a leads file or --page-id.")
    if not shutil.which("ffmpeg") and not args.dry_run:
        sys.exit("ffmpeg not found. brew install ffmpeg")

    sec_path = find_secrets()
    if not sec_path:
        sys.exit("No .secrets.env found.")
    secrets = load_secrets(sec_path)
    if not secrets.get("SENDR_API_KEY"):
        sys.exit("Missing SENDR_API_KEY in .secrets.env")

    opt = {k: getattr(args, k) for k in DEFAULTS}
    outdir = args.out or os.path.join(ROOT, "gifs")
    os.makedirs(outdir, exist_ok=True)

    leads = []
    if args.page_id:
        page_ids = [args.page_id]
    else:
        leads = json.load(open(resolve(args.leads_file)))
        page_ids = [l.get("sendr_page_id") for l in leads]
        if not any(page_ids):
            sys.exit("No lead in that file has a sendr_page_id — run push_to_sendr_page.py first.")

    missing = storage_ready(secrets)
    if missing and not (args.no_upload or args.dry_run):
        print(f"[gif] storage not configured ({', '.join(missing)}) — building locally only.\n")

    print(f"[gif] {sum(1 for p in page_ids if p)} page(s) -> {opt['width']}px "
          f"{opt['fps']}fps {opt['duration']}s {opt['colors']} colours\n")

    ok = 0
    for i, pid in enumerate(page_ids):
        if not pid:
            print(f"  skip  lead {i+1}: no sendr_page_id")
            continue
        r = process(pid, secrets, opt, args, outdir)
        if not r.get("ok"):
            print(f"  FAIL  page {pid}: {r['error']}", file=sys.stderr)
            continue
        ok += 1
        if r.get("dry_run"):
            print(f"  DRY   page {pid}: {r['would_upload_to']}  <- {r['source'][:60]}...")
        else:
            tail = r.get("gif_url") or r.get("blocked_on") or r["file"]
            print(f"  gif   page {pid}: {r['bytes']//1024}KB  {tail}")
            if r.get("warning"):
                print(f"        warning: {r['warning']}")
            if leads and r.get("gif_url"):
                leads[i]["gif_url"] = r["gif_url"]

    if leads and not args.dry_run and any(l.get("gif_url") for l in leads):
        path = resolve(args.leads_file)
        json.dump(leads, open(path, "w"), indent=2)
        print(f"\n[gif] wrote gif_url back into {os.path.basename(path)}")

    print(f"\n[done] {ok}/{len([p for p in page_ids if p])} built.")


if __name__ == "__main__":
    main()
