#!/usr/bin/env bash
# test-live-webhook.sh
# Fire valid / forged / duplicate / edge payloads at the LIVE n8n reply handler,
# to re-prove the decision brain against the real deployment (not just locally).
# Mirrors the offline suite: n8n-workflows/test-reply-brain.mjs
#
# RUN AFTER: the workflow is ACTIVE and register-webhooks.sh has been run.
#
# Usage:
#   export VIO_WEBHOOK_URL="https://n8n.industrialbriefs.com/webhook/<secret-path>"
#   export VIO_WEBHOOK_TOKEN="<same-token-as-on-the-droplet>"
#   bash test-live-webhook.sh
#
# READING RESULTS — depends on the webhook node's Respond mode:
#   • "When Last Node Finishes"  -> auth rejects come back non-2xx (401/500); decisions may echo in the body.
#   • "Immediately / onReceived" -> everything returns 200; verify the actual call/skip/ignore
#                                   decision in the n8n *execution log* for each run instead.
# Either way, NO real call fires: the Thoughtly node ships DISABLED (dry-run).

set -uo pipefail
CURL="$(command -v curl || echo /usr/bin/curl)"
: "${VIO_WEBHOOK_URL:?set VIO_WEBHOOK_URL (active n8n production webhook URL)}"
: "${VIO_WEBHOOK_TOKEN:?set VIO_WEBHOOK_TOKEN}"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT

fire(){ # name  token  json  expected-note
  local name="$1" tok="$2" json="$3" note="$4" url="$VIO_WEBHOOK_URL" code
  [ -n "$tok" ] && url="${VIO_WEBHOOK_URL}?t=${tok}"
  code="$("$CURL" -sS -o "$TMP" -w '%{http_code}' --max-time 30 -X POST "$url" \
          -H 'Content-Type: application/json' -d "$json" 2>/dev/null || echo 000)"
  printf '  [HTTP %s]  %-24s expect: %s\n' "$code" "$name" "$note"
  [ -s "$TMP" ] && sed 's/^/            /' "$TMP" | head -c 240 && echo
}

k(){ echo "test-$1-$(date +%s 2>/dev/null || echo x)"; }   # semi-unique idempotency keys
DUPKEY="live-dup-key"

POS_PHONE='{"event":"prospect_response","idempotency_key":"'"$DUPKEY"'","channel":"email","ai_response":{"sentiment":"positive","out_of_office":false},"lead":{"email":"a@x.com","first_name":"Test","phone":"+15551234567"}}'
POS_NOPHONE='{"event":"prospect_response","idempotency_key":"'"$(k np)"'","ai_response":{"sentiment":"positive","out_of_office":false},"lead":{"email":"b@x.com"}}'
NEG='{"event":"prospect_response","idempotency_key":"'"$(k neg)"'","ai_response":{"sentiment":"negative"},"lead":{"email":"c@x.com","phone":"+15550000000"}}'
OOO='{"event":"prospect_response","idempotency_key":"'"$(k ooo)"'","ai_response":{"sentiment":"positive","out_of_office":true},"lead":{"email":"d@x.com","phone":"+15550000001"}}'
NONREPLY='{"event":"email_opened","idempotency_key":"'"$(k ev)"'","lead":{"email":"e@x.com"}}'

echo "== firing at ${VIO_WEBHOOK_URL} =="
echo "-- auth gate (forged / unauthenticated) --"
fire "wrong token"       "badtoken"           "$POS_PHONE"   "REJECT (must not process)"
fire "missing token"     ""                   "$POS_PHONE"   "REJECT (must not process)"
echo "-- decision gate (valid token) --"
fire "positive + phone"  "$VIO_WEBHOOK_TOKEN"  "$POS_PHONE"   "would CALL (dry-run)"
fire "REPLAY (dup key)"  "$VIO_WEBHOOK_TOKEN"  "$POS_PHONE"   "skip (duplicate)"
fire "positive no phone" "$VIO_WEBHOOK_TOKEN"  "$POS_NOPHONE" "skip (human follow-up)"
fire "negative"          "$VIO_WEBHOOK_TOKEN"  "$NEG"         "skip (sentiment)"
fire "out-of-office"     "$VIO_WEBHOOK_TOKEN"  "$OOO"         "skip (auto-reply)"
fire "non-reply event"   "$VIO_WEBHOOK_TOKEN"  "$NONREPLY"    "ignore"

echo
echo "Offline baseline for comparison:  node test-reply-brain.mjs"
