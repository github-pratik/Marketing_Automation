# Node 22 for a stable global fetch. Alpine — this image holds one real
# dependency (xlsx, for the bulk-upload feature), so there is very little to
# compile and very little to audit.
FROM node:22-alpine

WORKDIR /app

# package.json + its lockfile copied and installed BEFORE the source, so an
# edit to server.mjs does not invalidate this layer and force a re-download of
# node_modules on every deploy — only a dependency change does. `npm ci`
# (not `npm install`) so the build reproduces the exact tree the lockfile
# pins, rather than silently picking up whatever a transitive dep bumped to
# since the lockfile was generated.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs followup.mjs reveal-request.mjs ./
COPY public ./public

# Where the changed password is stored. Created here, owned by `node`, BEFORE the
# USER switch: docker seeds a fresh named volume from the image's directory
# including its ownership, so mounting one here stays writable. Create it only at
# runtime and the volume arrives owned by root, and the first password change
# fails with EACCES.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

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
