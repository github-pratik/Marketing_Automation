#!/usr/bin/env bash
# register-webhooks.sh
# Point Victoria's (and Sendr's) callbacks at the LIVE n8n reply handler.
#
# RUN THIS ONLY AFTER:
#   1. The n8n workflow (VIO-inbound-reply-to-call) is imported, SAVED, and *ACTIVE*.
#      An inactive webhook 404s silently — the classic outbound silent-failure trap.
#   2. You have the PRODUCTION webhook URL (…/webhook/<path>, NOT …/webhook-test/<path>).
#   3. VIO_WEBHOOK_TOKEN matches the VIO_WEBHOOK_TOKEN env set on the n8n droplet.
#      Generate one once with:  openssl rand -hex 24
#
# Usage:
#   export VIO_WEBHOOK_URL="https://n8n.industrialbriefs.com/webhook/<secret-path>"
#   export VIO_WEBHOOK_TOKEN="<same-token-as-on-the-droplet>"
#   bash register-webhooks.sh
#
# Undo later:
#   Victoria: POST /v1/campaigns/<id>/webhook/deactivate
#   Sendr:    DELETE /api/v1/webhook   (body {"url":"<callback>"})

set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CURL="$(command -v curl || echo /usr/bin/curl)"
set -a; source "$REPO/.secrets.env"; set +a

: "${VIO_WEBHOOK_URL:?set VIO_WEBHOOK_URL to the ACTIVE n8n production webhook URL}"
: "${VIO_WEBHOOK_TOKEN:?set VIO_WEBHOOK_TOKEN (must match the env on the n8n droplet)}"

CAMPAIGN_ID="${VIO_CAMPAIGN_ID:-73703f2c-801c-411d-9da9-9c6addc986d4}"   # OryonIQ Pilot - Gav
CALLBACK="${VIO_WEBHOOK_URL}?t=${VIO_WEBHOOK_TOKEN}"                     # secret path + shared token
VA="https://api.versionseven.ai"
SENDR="https://api.sendr.io"
pp(){ if command -v jq >/dev/null 2>&1; then jq . 2>/dev/null || cat; else cat; fi; }

echo "=================================================================="
echo " VICTORIA  ·  reply webhook  ·  campaign $CAMPAIGN_ID"
echo "=================================================================="
echo "-- current webhooks --"
"$CURL" -sS "$VA/v1/campaigns/$CAMPAIGN_ID/webhooks" \
  -H "Authorization: Bearer $VICTORIA_AI_API_KEY" | pp

echo "-- activate callback  (…/webhook/…?t=***) --"
"$CURL" -sS -X POST "$VA/v1/campaigns/$CAMPAIGN_ID/webhook/activate" \
  -H "Authorization: Bearer $VICTORIA_AI_API_KEY" -H "Content-Type: application/json" \
  -d "{\"webhook_url\":\"$CALLBACK\"}" | pp

echo "-- verify --"
"$CURL" -sS "$VA/v1/campaigns/$CAMPAIGN_ID/webhooks" \
  -H "Authorization: Bearer $VICTORIA_AI_API_KEY" | pp

echo
echo "=================================================================="
echo " SENDR  ·  signed webhook  ·  page_view / meeting_booked  (Layer 3)"
echo "=================================================================="
# NOTE: run this half only once the Sendr pilot campaign + Page template exist.
# Verify field names + event strings against Sendr's OpenAPI (api-1.json) first.
# Sendr returns a signing secret and sends it back as X-Webhook-Secret on every call — capture it.
if [ "${REGISTER_SENDR:-0}" = "1" ]; then
  SENDR_CB="${VIO_SENDR_WEBHOOK_URL:-$VIO_WEBHOOK_URL}?t=${VIO_WEBHOOK_TOKEN}"
  "$CURL" -sS -X POST "$SENDR/api/v1/webhook" \
    -H "X-API-Key: $SENDR_API_KEY" -H "Content-Type: application/json" \
    -d "{\"url\":\"$SENDR_CB\",\"events\":[\"engagement:page_view\",\"engagement:meeting_booked\",\"page:done\"]}" | pp
  echo "-- list Sendr webhooks --"
  "$CURL" -sS "$SENDR/api/v1/webhook" -H "X-API-Key: $SENDR_API_KEY" | pp
else
  echo "skipped (set REGISTER_SENDR=1 once the Sendr pilot campaign + Page template are ready)"
fi

echo
echo "Done."
