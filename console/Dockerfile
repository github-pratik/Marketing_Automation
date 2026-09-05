# Node 22 for a stable global fetch. Alpine because this image holds one file and
# no dependencies — there is nothing to compile and nothing to audit.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./
COPY public ./public

# Never run as root: this process is reachable from the public internet through
# Caddy, and it holds the Supabase service key in its environment.
USER node

ENV PORT=8080
EXPOSE 8080

# Fails the container if the process is up but cannot reach Supabase, so a
# broken key shows as unhealthy rather than as an empty dashboard.
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
