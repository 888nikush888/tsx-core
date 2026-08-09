ARG GO_IMAGE=golang:1.26.5-bookworm@sha256:6c5605ab3a9a9fb3c4eafe5b3d63cdbf3881caf113262b67862547b54a9db599
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6
ARG SOURCE_DATE_EPOCH=1783191941

# Build on the native builder platform and cross-compile; the target runtime has no RUN instruction.
FROM --platform=${BUILDPLATFORM} ${GO_IMAGE} AS builder
ARG TARGETOS=linux
ARG TARGETARCH
ARG SOURCE_DATE_EPOCH
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
WORKDIR /src

ADD --checksum=sha256:fdeab39769b39ebeb2fa0da244295dfb02da76e1c8b5afc041fbd99076ed5181 \
    https://codeload.github.com/prometheus/alertmanager/tar.gz/2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5 /tmp/alertmanager.tar.gz
ADD --checksum=sha256:1f63344e196e47ba7bfe27276f44c1da77e39fb76493e42b2cf0a50ca8f04321 \
    https://github.com/prometheus/alertmanager/releases/download/v0.33.1/alertmanager-web-ui-0.33.1.tar.gz /tmp/alertmanager-web-ui.tar.gz

RUN test "$(go env GOVERSION)" = "go1.26.5" \
    && tar -xzf /tmp/alertmanager.tar.gz --strip-components=1 -C /src \
    && tar -xzf /tmp/alertmanager-web-ui.tar.gz -C /src/ui/app \
    && test "$(cat VERSION)" = "0.33.1" \
    && test -f ui/app/dist/.build_stamp \
    && rm /tmp/alertmanager.tar.gz /tmp/alertmanager-web-ui.tar.gz

RUN go get \
      golang.org/x/text@v0.39.0 \
      google.golang.org/grpc@v1.82.1 \
      golang.org/x/crypto@v0.53.0 \
      github.com/klauspost/compress@v1.18.7 \
      go.opentelemetry.io/otel@v1.44.0 \
      go.opentelemetry.io/otel/metric@v1.44.0 \
      go.opentelemetry.io/otel/trace@v1.44.0 \
    && go mod tidy \
    && go mod verify \
    && test "$(go list -m -f '{{.Version}}' golang.org/x/text)" = "v0.39.0" \
    && test "$(go list -m -f '{{.Version}}' google.golang.org/grpc)" = "v1.82.1" \
    && test "$(go list -m -f '{{.Version}}' golang.org/x/crypto)" = "v0.53.0" \
    && test "$(go list -m -f '{{.Version}}' github.com/klauspost/compress)" = "v1.18.7" \
    && test "$(go list -m -f '{{.Version}}' go.opentelemetry.io/otel)" = "v1.44.0" \
    && test "$(go list -m -f '{{.Version}}' go.opentelemetry.io/otel/metric)" = "v1.44.0" \
    && test "$(go list -m -f '{{.Version}}' go.opentelemetry.io/otel/trace)" = "v1.44.0" \
    && test -z "$(go list -deps ./cmd/alertmanager ./cmd/amtool \
      | grep -E '^golang.org/x/crypto/openpgp(/|$)' || true)"

RUN install -d -m 0755 \
      /out/rootfs/usr/bin \
      /out/rootfs/etc/alertmanager \
      /out/rootfs/licenses/alertmanager \
      /out/rootfs/alertmanager \
    && install -m 0444 examples/ha/alertmanager.yml /out/rootfs/etc/alertmanager/alertmanager.yml \
    && install -m 0444 LICENSE NOTICE /out/rootfs/licenses/alertmanager/ \
    && GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build \
      -mod=readonly -trimpath -buildvcs=false -tags=netgo \
      -ldflags="-w -buildid= \
        -X github.com/prometheus/common/version.Version=0.33.1 \
        -X github.com/prometheus/common/version.Revision=2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5 \
        -X github.com/prometheus/common/version.Branch=release-0.33 \
        -X github.com/prometheus/common/version.BuildUser=tsx-core@reproducible \
        -X github.com/prometheus/common/version.BuildDate=20260704-19:05:41" \
      -o /out/rootfs/usr/bin/alertmanager ./cmd/alertmanager \
    && GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build \
      -mod=readonly -trimpath -buildvcs=false -tags=netgo \
      -ldflags="-w -buildid= \
        -X github.com/prometheus/common/version.Version=0.33.1 \
        -X github.com/prometheus/common/version.Revision=2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5 \
        -X github.com/prometheus/common/version.Branch=release-0.33 \
        -X github.com/prometheus/common/version.BuildUser=tsx-core@reproducible \
        -X github.com/prometheus/common/version.BuildDate=20260704-19:05:41" \
      -o /out/rootfs/usr/bin/amtool ./cmd/amtool \
    && chmod 0555 /out/rootfs/usr/bin/alertmanager /out/rootfs/usr/bin/amtool \
    && chown 65534:65534 /out/rootfs/alertmanager \
    && find /out/rootfs -exec touch -h --date="@${SOURCE_DATE_EPOCH}" {} +

FROM builder AS security-audit
ARG VULN_DB_EPOCH=manual
RUN test -n "${VULN_DB_EPOCH}" \
    && GOBIN=/usr/local/bin go install golang.org/x/vuln/cmd/govulncheck@v1.6.0 \
    && govulncheck -scan=symbol ./cmd/alertmanager ./cmd/amtool \
    && govulncheck -mode=binary -scan=symbol /out/rootfs/usr/bin/alertmanager \
    && govulncheck -mode=binary -scan=symbol /out/rootfs/usr/bin/amtool

FROM ${RUNTIME_IMAGE} AS runner
LABEL org.opencontainers.image.title="TSX Core Hardened Alertmanager" \
      org.opencontainers.image.description="Alertmanager 0.33.1 rebuilt with patched Go security dependencies" \
      org.opencontainers.image.source="https://github.com/prometheus/alertmanager" \
      org.opencontainers.image.version="0.33.1" \
      org.opencontainers.image.revision="2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5" \
      org.opencontainers.image.created="2026-07-04T19:05:41Z" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="gcr.io/distroless/static-debian13:nonroot" \
      org.opencontainers.image.base.digest="sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6"
COPY --from=builder /out/rootfs/ /
# Preserve the official image's nobody UID/GID so existing named volumes remain writable.
USER 65534:65534
WORKDIR /alertmanager
EXPOSE 9093
ENTRYPOINT ["/bin/alertmanager"]
CMD ["--config.file=/etc/alertmanager/alertmanager.yml", "--storage.path=/alertmanager"]
