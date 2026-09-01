# Monitoring image vulnerability policy

No monitoring VEX exception is active. Both monitoring images must pass the CI
HIGH/CRITICAL container gate without suppression.

The official Prometheus v3.13.2 binary was built with Go 1.26.5. The pinned
`monitoring/prometheus.Dockerfile` rebuilds verified commit
`bb5dff00cf8fdfbf5c65e0531aa835fa238a43a2` and the checksum-verified release
web UI with Go 1.26.6. The checked-in `prometheus.go.mod` and
`prometheus.go.sum` locks retain the upstream source while lifting
`golang.org/x/crypto` to v0.55.0 (and the minimum-version-selected companion
`golang.org/x/*` modules) to remediate CVE-2026-56854. The build verifies that
exact security floor before compilation. The static non-root runtime,
reproducible metadata, SBOM, Trivy gate and `govulncheck` source/binary
reachability checks apply without suppression.

The official Alertmanager v0.33.1 binaries contain vulnerable Go modules.
`monitoring/alertmanager.Dockerfile` therefore rebuilds both `alertmanager` and
`amtool` from verified commit `2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5`.
The source archive and official prebuilt web UI are checksum verified, the Go
1.26.6 builder and static non-root Distroless runtime are digest pinned, and the
build requires `golang.org/x/text` v0.41.0, `google.golang.org/grpc` v1.82.1,
`golang.org/x/mod` v0.40.0, `golang.org/x/crypto` v0.55.0,
`github.com/klauspost/compress` v1.18.7 and
OpenTelemetry v1.44.0. Reproducible LDFlags, `SOURCE_DATE_EPOCH` and normalized
output mtimes bind both binaries and runtime layers to the upstream version,
revision and release timestamp. CI builds and scans independent `linux/amd64`
and `linux/arm64` candidates. Registry publication and construction of an
optional shared multi-architecture manifest are explicit operator tasks.

`govulncheck` v1.6.0 reports zero affected symbols in source mode and in binary
mode for both platforms and both commands. The binaries retain the Go symbol
table (`-w` is used, `-s` is forbidden) so the binary scanner does not replace
package reachability with advisory-wide wildcards. The build additionally fails
if `go list -deps` ever contains an `x/crypto/openpgp` package. No OpenPGP package
is linked into either binary, and no VEX suppression is applied.

Any source, checksum, builder, runtime or dependency change requires a fresh
SBOM, Trivy scan and binary vulnerability review. A future VEX statement is
acceptable only with current, version-bound reachability evidence; it must never
replace an available patched build.
