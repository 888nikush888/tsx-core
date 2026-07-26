ARG NODE_IMAGE=node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian13@sha256:773a62fbe24a3f8c8b24b16fd59154627f8b406737bc906f83bf1732bc8907dd
ARG DEBIAN_SNAPSHOT=20260713T150000Z

FROM ${NODE_IMAGE} AS base
ARG DEBIAN_SNAPSHOT
RUN sed -ri "s|deb.debian.org/debian-security|snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}|g" /etc/apt/sources.list.d/debian.sources \
    && sed -ri "s|deb.debian.org/debian|snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}|g" /etc/apt/sources.list.d/debian.sources \
    && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && sed -ri 's|^URIs: [^:]+://|URIs: https://|' /etc/apt/sources.list.d/debian.sources

FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --ignore-scripts --include=optional --no-audit --no-fund \
    && npm ci --prefix frontend --ignore-scripts --include=optional --no-audit --no-fund
COPY src/ ./src/
COPY frontend/ ./frontend/
RUN npm run build

FROM base AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild sqlite3 --build-from-source \
    && npm cache clean --force

FROM base AS runtime-layout
RUN mkdir -p /runtime/app/config /runtime/app/secrets /runtime/app/templates \
      /runtime/app/session_data /runtime/app/session_files /runtime/app/signals \
      /runtime/app/logs /runtime/app/backups \
    && chown -R 65532:65532 /runtime/app

FROM ${RUNTIME_IMAGE} AS runner
LABEL org.opencontainers.image.title="TSX Core" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.base.name="gcr.io/distroless/nodejs22-debian13" \
      org.opencontainers.image.base.digest="sha256:773a62fbe24a3f8c8b24b16fd59154627f8b406737bc906f83bf1732bc8907dd"

ENV NODE_ENV=production \
    ENTERPRISE_MODE=false \
    CONFIG_PATH=/app/config/config.json
WORKDIR /app

COPY --from=runtime-layout --chown=65532:65532 /runtime/app/ /app/
COPY --from=production-dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/dist ./dist
COPY --from=builder --chown=65532:65532 /app/frontend/dist ./frontend/dist
COPY --chown=65532:65532 config.json.example ./config/config.json

USER 65532:65532
EXPOSE 8080 8091 9100
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:9100/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["dist/forwarder.js"]
