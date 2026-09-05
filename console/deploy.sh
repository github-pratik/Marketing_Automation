#!/usr/bin/env bash
# =============================================================================
# Deploy the outreach console to the DigitalOcean droplet.
#
# It runs as its OWN container attached to the n8n stack's network, rather than
# as a service inside that stack's compose file. The n8n instance is shared with
# another job; a standalone container cannot cause `docker compose up` to
# recreate n8n as a side effect of an unrelated edit.
#
# Caddy already terminates TLS on that box. It reaches this container by name
# over the shared network, so the console never binds a public port itself.
#
#   ./console/deploy.sh              # build, restart, verify
#   ./console/deploy.sh --logs       # tail the running container
# =============================================================================
set -euo pipefail

HOST="${VIO_HOST:-root@104.248.119.152}"
REMOTE_DIR="/root/vio-console"
NETWORK="n8n-stack_default"
CONTAINER="vio-console"
IMAGE="vio-console:latest"
# Holds the changed staff password. Named, so it outlives every container.
VOLUME="vio-console-data"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${1:-}" == "--logs" ]]; then
  exec ssh "$HOST" "docker logs --tail 100 -f $CONTAINER"
fi

echo "[1/5] copying source to $HOST:$REMOTE_DIR"
# Only the three things the image needs. Note what is NOT sent: .secrets.env
# never leaves this machine — the droplet keeps its own .env, written once by
# the step below and never overwritten.
ssh "$HOST" "mkdir -p $REMOTE_DIR/public"
scp -q "$HERE/server.mjs" "$HERE/Dockerfile" "$HOST:$REMOTE_DIR/"
scp -q "$HERE/public/index.html" "$HOST:$REMOTE_DIR/public/"

echo "[2/5] checking the droplet has its environment file"
if ! ssh "$HOST" "test -f $REMOTE_DIR/.env"; then
  echo
  echo "  $REMOTE_DIR/.env does not exist on the droplet."
  echo "  Create it there once, with these four keys, then re-run:"
  echo
  echo "    SUPABASE_URL=https://<project>.supabase.co"
  echo "    SUPABASE_SERVICE_KEY=<service role key>"
  echo "    STAFF_PASSWORD=<the shared staff login>"
  echo "    SESSION_SECRET=<openssl rand -hex 32>"
  echo
  exit 1
fi

echo "[3/5] building the image on the droplet"
ssh "$HOST" "cd $REMOTE_DIR && docker build -q -t $IMAGE ."

echo "[4/5] restarting the container"
ssh "$HOST" "
  docker rm -f $CONTAINER >/dev/null 2>&1 || true
  docker run -d --name $CONTAINER \
    --network $NETWORK \
    --env-file $REMOTE_DIR/.env \
    -v $VOLUME:/data \
    --restart unless-stopped \
    $IMAGE >/dev/null
"
# The volume is what makes a password change survive a redeploy. Recreating the
# container is also the only way a change to .env takes effect: docker restart
# does NOT re-read --env-file.

echo "[5/5] verifying it can reach Supabase"
sleep 4
# Asked from inside the network, the same way Caddy will reach it. A 200 with
# ok:true means the process is up AND its Supabase key works — an empty
# dashboard caused by a bad key would otherwise look like healthy silence.
ssh "$HOST" "docker run --rm --network $NETWORK curlimages/curl:latest \
  -s --max-time 10 http://$CONTAINER:8080/api/health"
echo
echo "[done] deployed. Caddy serves it at the hostname in the Caddyfile."
