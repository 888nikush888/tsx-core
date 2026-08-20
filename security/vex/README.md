# Application VEX policy

VEX statements in this directory are narrow exploitability findings, not broad vulnerability waivers. Each statement must identify one installed package version and one vulnerability, document why the vulnerable code cannot execute in TSX Core, and remain covered by the supply-chain tests.

`CVE-2026-14456` affects only an OpenSSL QUIC server listener. TSX Core opens no QUIC or HTTP/3 listener: the dashboard, MCP endpoint, exchange executor and monitoring endpoints use TCP HTTP, while Tailscale Serve terminates remote HTTPS before forwarding to the loopback dashboard port. The exact `libssl3t64` version remains visible in the generated SBOM, and CI displays suppressed findings. Remove the statement as soon as the digest-pinned Distroless base contains the vendor fix or if any QUIC listener is introduced.

Evidence: [Debian Security Tracker](https://security-tracker.debian.org/tracker/CVE-2026-14456) and [Trivy VEX documentation](https://trivy.dev/docs/dev/docs/supply-chain/vex/).
