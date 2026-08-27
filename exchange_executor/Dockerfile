ARG PYTHON_IMAGE=python@sha256:31a768b01976652c222e318fe5bd6e7c252f056cbf489c88fa256f1bf0af58e3

FROM ${PYTHON_IMAGE} AS dependencies
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /build
COPY requirements.lock ./requirements.lock
RUN python -m pip install --require-hashes --prefix=/install -r requirements.lock

FROM ${PYTHON_IMAGE} AS runner
LABEL org.opencontainers.image.title="TSX Core Exchange Executor" \
      org.opencontainers.image.source="local-workspace" \
      org.opencontainers.image.base.name="python:3.12-alpine3.23" \
      org.opencontainers.image.base.digest="sha256:31a768b01976652c222e318fe5bd6e7c252f056cbf489c88fa256f1bf0af58e3"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random \
    EXECUTOR_HOST=0.0.0.0 \
    EXECUTOR_PORT=8090
WORKDIR /app
RUN apk add --no-cache "sqlite-libs=3.53.4-r0" "libcrypto3=3.5.8-r0" "libssl3=3.5.8-r0" \
    && addgroup --system --gid 65532 executor \
    && adduser --system --uid 65532 --ingroup executor --no-create-home --home /nonexistent executor
COPY --from=dependencies /install /usr/local
COPY --chown=0:0 --chmod=0444 *.py ./

USER 65532:65532
EXPOSE 8090
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz', timeout=4).read()"]
CMD ["python", "server.py"]
