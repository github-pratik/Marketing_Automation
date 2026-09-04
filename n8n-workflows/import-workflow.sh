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
#
#   - ⚠️ THE CLI CANNOT RELOAD A RUNNING TRIGGER. `n8n import:workflow` and
#     `n8n update:workflow` run in a SEPARATE process: they write the database, and
#     the running server never finds out. With EXECUTIONS_MODE=regular the main
#     process holds every ACTIVE trigger workflow (schedule + webhook) in memory, so
#     it keeps executing the OLD code indefinitely while every database query you
#     use to verify the deploy shows the NEW code. Proven 2026-09-04: VIO-inbox-mapper
#     ran at 15:12 on a 10,141-char copy of a node the database had at 11,954 chars,
#     20 minutes and a full deactivate/activate cycle after the import.
#
#     SUB-WORKFLOWS ARE FINE. Anything invoked by Execute Workflow (VIO-enrol-email,
#     VIO-intake-verify-curate, VIO-operator-agent, VIO-sendr-generate-page) is read
#     from the database per call, so those deploy instantly. It is only the workflows
#     with their own trigger that go stale.
#
#     To actually reload one: toggle it Inactive -> Active in the n8n WEB UI (goes
#     through the running server), or restart the n8n container. The CLI
#     --active=true is NOT enough, and on an already-active workflow it is a no-op.
#
#     TO VERIFY A DEPLOY, NEVER READ workflow_entity. Read what the run actually used:
#       select ed."workflowData" from execution_data ed
#       join execution_entity e on e.id = ed."executionId"
#       join workflow_entity w on w.id = e."workflowId"
#       where w.name = 'VIO-...' order by e."startedAt" desc limit 1;
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
