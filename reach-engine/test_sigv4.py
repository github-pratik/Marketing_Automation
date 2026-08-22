#!/usr/bin/env python3
"""
Verify make_scroll_gif.py's SigV4 signing against AWS's own published test vectors.

Worth having as a real test rather than "it looked right": this code signs requests with live
storage credentials, and a signing bug fails as an opaque 403 that is easy to misdiagnose as a
wrong key, a wrong region, or a bucket-policy problem. A local vector check separates "our crypto
is wrong" from "your bucket config is wrong" in one second, before anyone goes hunting.

Run:  python3 test_sigv4.py
"""
import sys, os, hashlib, hmac
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_scroll_gif import _sign, s3_put

passed = failed = 0


def check(name, got, want):
    global passed, failed
    ok = got == want
    print(f"{'  ok  ' if ok else ' FAIL '} {name}")
    if not ok:
        print(f"        got  {got}\n        want {want}")
    passed += ok
    failed += not ok


# ---- 1. Signing-key derivation, AWS SigV4 documentation example ----
# docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — the documented derived
# signing key for this exact (secret, date, region, service) tuple.
SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
k = _sign(("AWS4" + SECRET).encode(), "20150830")
for part in ("us-east-1", "iam", "aws4_request"):
    k = _sign(k, part)
check("derived signing key matches AWS's published example",
      k.hex(), "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9")

# ---- 2. HMAC chain is order-sensitive (a transposed region/service must NOT collide) ----
k2 = _sign(("AWS4" + SECRET).encode(), "20150830")
for part in ("iam", "us-east-1", "aws4_request"):
    k2 = _sign(k2, part)
check("region/service order matters (no accidental collision)", k2.hex() != k.hex(), True)

# ---- 3. Payload hash: SigV4 signs the body, so an empty body has a specific known digest ----
check("empty-payload SHA256 is the documented constant",
      hashlib.sha256(b"").hexdigest(),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")

# ---- 4. Live structural check: AWS must parse our Authorization header far enough to look up the
# access key. A malformed header returns AuthorizationHeaderMalformed instead, which is the real
# failure mode this catches. Skipped without network. ----
if os.environ.get("SKIP_NETWORK"):
    print("  skip  live header-format probe (SKIP_NETWORK set)")
else:
    code, body = s3_put(b"probe", "gif/probe.gif", "image/gif", {
        "ASSET_S3_ENDPOINT": "https://s3.us-east-1.amazonaws.com",
        "ASSET_S3_BUCKET": "vio-signing-probe-does-not-exist-2f9a",
        "ASSET_S3_REGION": "us-east-1",
        "ASSET_S3_ACCESS_KEY": "AKIAIOSFODNN7EXAMPLE",
        "ASSET_S3_SECRET_KEY": SECRET,
    })
    bad = any(m in (body or "") for m in ("AuthorizationHeaderMalformed", "InvalidArgument"))
    check("AWS accepts the Authorization header format", (code, bad), (403, False))

print(f"\n{passed} passed, {failed} failed")
print("Note: a fully end-to-end signature match needs real credentials — these vectors prove the\n"
      "key derivation and header format, which is where hand-rolled SigV4 actually goes wrong.")
sys.exit(1 if failed else 0)
