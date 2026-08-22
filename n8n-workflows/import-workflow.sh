#!/usr/bin/env bash
# Import / update a VIO workflow into an n8n instance via the CLI.
# Portability: pass a different host to move workflows to a NEW droplet.
#
#   ./import-workflow.sh VIO-inbound-reply-to-call.json                 # default droplet
#   ./import-workflow.sh VIO-inbound-reply-to-call.json root@NEW_IP     # a new droplet
#   VIO_N8N_CONTAINER=other-n8n-1 ./import-workflow.sh WF.json root@IP  # non-default container name
#
# Notes:
#   - Workflow JSON MUST carry a top-level "id" (same id = update in place; new id = new workflow).
#   - Imports arrive DEACTIVATED. Activate in the n8n UI when ready.
#   - JSON is secret-free: credentials referenced by name, tokens read from env at runtime.
set -euo pipefail

WF="${1:?usage: import-workflow.sh <workflow.json> [ssh-host]}"
HOST="${2:-root@104.248.119.152}"
CONTAINER="${VIO_N8N_CONTAINER:-n8n-stack-n8n-1}"

[ -f "$WF" ] || { echo "error: no such file: $WF" >&2; exit 1; }

cat "$WF" | ssh "$HOST" "
  docker exec -i $CONTAINER sh -c 'cat > /tmp/w.json'
  docker exec $CONTAINER n8n import:workflow --input=/tmp/w.json
  docker exec $CONTAINER rm -f /tmp/w.json
"
echo "OK: imported $(basename "$WF") -> $HOST ($CONTAINER), deactivated."
