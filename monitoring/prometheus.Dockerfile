ARG GO_IMAGE=golang:1.26.6-bookworm@sha256:116d58cbd88c1297624acc6e967a060012422bacf9930927e23fb719189c6f36
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6
ARG SOURCE_DATE_EPOCH=1785410710

FROM --platform=${BUILDPLATFORM} ${GO_IMAGE} AS builder
ARG TARGETOS=linux
ARG TARGETARCH
ARG SOURCE_DATE_EPOCH
ENV CGO_ENABLED=0 \
    GOTOOLCHAIN=local \
    SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}
WORKDIR /src

ADD --checksum=sha256:beffc32fe1e56dd49c2146589e63182414c5fea1cc555343d29d58a7ee49332d \
    https://codeload.github.com/prometheus/prometheus/tar.gz/bb5dff00cf8fdfbf5c65e0531aa835fa238a43a2 /tmp/prometheus.tar.gz
ADD --checksum=sha256:6a2255eb51cbe8735a58b4955d3b211920e91331590654bf81b1c1d4a4b32e9d \
    https://github.com/prometheus/prometheus/releases/download/v3.13.2/prometheus-web-ui-3.13.2.tar.gz /tmp/prometheus-web-ui.tar.gz

RUN test "$(go env GOVERSION)" = "go1.26.6" \
    && tar -xzf /tmp/prometheus.tar.gz --strip-components=1 -C /src \
    && tar -xzf /tmp/prometheus-web-ui.tar.gz -C /src/web/ui \
    && test "$(cat VERSION)" = "3.13.2" \
    && test -f web/ui/static/mantine-ui/index.html \
    && rm /tmp/prometheus.tar.gz /tmp/prometheus-web-ui.tar.gz \
    && go mod verify \
    && PREBUILT_ASSETS_STATIC_DIR=web/ui/static make assets-compress

RUN install -d -m 0755 \
      /out/rootfs/usr/bin \
      /out/rootfs/etc/prometheus \
      /out/rootfs/licenses/prometheus \
      /out/rootfs/prometheus \
    && install -m 0444 documentation/examples/prometheus.yml /out/rootfs/etc/prometheus/prometheus.yml \
    && install -m 0444 LICENSE NOTICE /out/rootfs/licenses/prometheus/ \
    && GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build \
      -mod=readonly -trimpath -buildvcs=false -tags=netgo,builtinassets \
      -ldflags="-w -buildid= \
        -X github.com/prometheus/common/version.Version=3.13.2 \
        -X github.com/prometheus/common/version.Revision=bb5dff00cf8fdfbf5c65e0531aa835fa238a43a2 \
        -X github.com/prometheus/common/version.Branch=release-3.13 \
        -X github.com/prometheus/common/version.BuildUser=tsx-core@reproducible \
        -X github.com/prometheus/common/version.BuildDate=20260730-11:25:10" \
      -o /out/rootfs/usr/bin/prometheus ./cmd/prometheus \
    && GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build \
      -mod=readonly -trimpath -buildvcs=false -tags=netgo,builtinassets \
      -ldflags="-w -buildid= \
        -X github.com/prometheus/common/version.Version=3.13.2 \
        -X github.com/prometheus/common/version.Revision=bb5dff00cf8fdfbf5c65e0531aa835fa238a43a2 \
        -X github.com/prometheus/common/version.Branch=release-3.13 \
        -X github.com/prometheus/common/version.BuildUser=tsx-core@reproducible \
        -X github.com/prometheus/common/version.BuildDate=20260730-11:25:10" \
      -o /out/rootfs/usr/bin/promtool ./cmd/promtool \
    && chmod 0555 /out/rootfs/usr/bin/prometheus /out/rootfs/usr/bin/promtool \
    && chown 65534:65534 /out/rootfs/prometheus \
    && find /out/rootfs -exec touch -h --date="@${SOURCE_DATE_EPOCH}" {} +

FROM builder AS security-audit
ARG VULN_DB_EPOCH=manual
RUN test -n "${VULN_DB_EPOCH}" \
    && GOBIN=/usr/local/bin go install golang.org/x/vuln/cmd/govulncheck@v1.6.0 \
    && govulncheck -scan=symbol ./cmd/prometheus ./cmd/promtool \
    && govulncheck -mode=binary -scan=symbol /out/rootfs/usr/bin/prometheus \
    && govulncheck -mode=binary -scan=symbol /out/rootfs/usr/bin/promtool

FROM ${RUNTIME_IMAGE} AS runner
LABEL org.opencontainers.image.title="TSX Core Hardened Prometheus" \
      org.opencontainers.image.description="Prometheus 3.13.2 rebuilt with the patched Go toolchain" \
      org.opencontainers.image.source="https://github.com/prometheus/prometheus" \
      org.opencontainers.image.version="3.13.2" \
      org.opencontainers.image.revision="bb5dff00cf8fdfbf5c65e0531aa835fa238a43a2" \
      org.opencontainers.image.created="2026-07-30T11:25:10Z" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.base.name="gcr.io/distroless/static-debian13:nonroot" \
      org.opencontainers.image.base.digest="sha256:f7f8f729987ad0fdf6b05eeeae94b26e6a0f613bdf46feea7fc40f7bd72953e6"
COPY --from=builder /out/rootfs/ /
USER 65534:65534
WORKDIR /prometheus
EXPOSE 9090
ENTRYPOINT ["/usr/bin/prometheus"]
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus"]
