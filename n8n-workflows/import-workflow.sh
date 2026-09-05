#!/usr/bin/env bash
# Import / update a VIO workflow into an n8n instance via the CLI.
# Portability: pass a different host to move workflows to a NEW droplet.
#
#   ./import-workflow.sh VIO-inbound-reply-to-call.json                 # default droplet
#   ./import-workflow.sh VIO-inbound-reply-to-call.json root@NEW_IP     # a new droplet
#   VIO_N8N_CONTAINER=other-n8n-1 ./import-workflow.sh WF.json root@IP  # non-default container name
#   VIO_PG_CONTAINER=other-pg-1   ./import-workflow.sh WF.json root@IP  # non-default postgres container name
#
# Notes:
#   - Workflow JSON MUST carry a top-level "id" (same id = update in place; new id = new workflow).
#
#   - ⚠️ `import:workflow` DEACTIVATES the workflow it imports, and it IGNORES the
#     JSON's own "active" key (found live 2026-09-05 — see README.md). Left alone,
#     that silently turns off a live poller or webhook with nothing louder than one
#     "Deactivating workflow ..." line buried between two "Successfully imported"
#     messages. This script now protects against that automatically: it reads the
#     LIVE active flag before importing and, if the workflow was active, re-runs
#     `n8n update:workflow --active=true` right after — so an import can no longer
#     leave something off by accident. It then prints the post-import state so the
#     operator sees it rather than trusting the exit code.
#
#     This restores the DATABASE FLAG, which is a different thing from RELOADING A
#     RUNNING TRIGGER — see the next note. A brand-new workflow (id not yet in the
#     database) always arrives deactivated; that's correct, not a bug — activate it
#     deliberately once it's ready.
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
#     --active=true (including the auto re-activation this script now does) is NOT
#     enough on its own for a workflow with its own trigger — this script says so
#     below whenever it re-activates one.
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
PG_CONTAINER="${VIO_PG_CONTAINER:-n8n-stack-postgres-1}"

[ -f "$WF" ] || { echo "error: no such file: $WF" >&2; exit 1; }

ID="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['id'])" "$WF" 2>/dev/null)" || {
  echo "error: $WF has no top-level \"id\" — refusing (an import without one creates a NEW workflow, not an update)" >&2
  exit 1
}

# The JSON's own "active" key is ignored by the importer, so the database is the
# only source of truth for "was this workflow supposed to be on" before we touch it.
# Empty result = id not in the database yet (a genuinely new workflow); that is not
# an error, it just means there is nothing to restore afterwards.
WAS_ACTIVE="$(ssh "$HOST" "docker exec $PG_CONTAINER psql -U postgres -d railway -tAc \"select active from workflow_entity where id='$ID'\"" | tr -d '[:space:]')"

cat "$WF" | ssh "$HOST" "
  docker exec -i $CONTAINER sh -c 'cat > /tmp/w.json'
  docker exec $CONTAINER n8n import:workflow --input=/tmp/w.json
  docker exec $CONTAINER rm -f /tmp/w.json
"

case "$WAS_ACTIVE" in
  t)
    echo "was active before this import -> restoring the active flag"
    ssh "$HOST" "docker exec $CONTAINER n8n update:workflow --id=$ID --active=true"
    ;;
  f)
    echo "was inactive before this import -> leaving deactivated"
    ;;
  *)
    echo "no prior row for id=$ID (new workflow) -> leaving deactivated; activate deliberately when ready"
    ;;
esac

echo "post-import state:"
ssh "$HOST" "docker exec $PG_CONTAINER psql -U postgres -d railway -tAc \"select id, name, active from workflow_entity where id='$ID'\""

if [ "$WAS_ACTIVE" = "t" ]; then
  echo
  echo "⚠️  the active FLAG is restored, but that is not the same as reloading a running"
  echo "    trigger's code. If this workflow has its own poller/webhook trigger (i.e. it"
  echo "    isn't only invoked via Execute Workflow), also toggle it Inactive->Active in"
  echo "    the n8n WEB UI, or restart the container — otherwise it keeps running the OLD"
  echo "    code with the flag merely looking correct. See README.md."
fi

echo "OK: imported $(basename "$WF") -> $HOST ($CONTAINER)"
