# Monitoring image vulnerability policy

No monitoring VEX exception is active. Both monitoring images must pass the CI
HIGH/CRITICAL container gate without suppression.

Prometheus v3.13.2 is pinned by multi-architecture digest and contains the fixed
`golang.org/x/text` v0.39.0 and `google.golang.org/grpc` v1.82.1 dependencies.

The official Alertmanager v0.33.1 binaries contain vulnerable Go modules.
`monitoring/alertmanager.Dockerfile` therefore rebuilds both `alertmanager` and
`amtool` from verified commit `2c8da51e03f3dbbed24f9711ca2d76aab4eef9c5`.
The source archive and official prebuilt web UI are checksum verified, the Go
1.26.5 builder and static non-root Distroless runtime are digest pinned, and the
build requires `golang.org/x/text` v0.39.0, `google.golang.org/grpc` v1.82.1,
`golang.org/x/crypto` v0.53.0, `github.com/klauspost/compress` v1.18.7 and
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
