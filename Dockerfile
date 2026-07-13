ARG NODE_IMAGE=node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm ci --prefix frontend --ignore-scripts --no-audit --no-fund
COPY src/ ./src/
COPY frontend/ ./frontend/
RUN npm run build

FROM ${NODE_IMAGE} AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm rebuild sqlite3 --build-from-source \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runner
LABEL org.opencontainers.image.title="Telegram TDLib Forwarder" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.base.name="docker.io/library/node:20-bookworm-slim" \
      org.opencontainers.image.base.digest="sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0"

ENV NODE_ENV=production \
    NON_INTERACTIVE=true
WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/frontend/dist ./frontend/dist
COPY --chown=node:node templates/ ./templates/
COPY --chown=node:node config.json.example ./config.json.example

RUN mkdir -p /app/session_data /app/session_files /app/signals /app/logs /app/backups \
    && chown -R node:node /app/session_data /app/session_files /app/signals /app/logs /app/backups

USER node
EXPOSE 8080 9100
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9100/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/forwarder.js"]
