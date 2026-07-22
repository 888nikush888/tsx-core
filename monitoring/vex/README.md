# Monitoring image VEX policy

These OpenVEX documents apply only to the exact Go package versions embedded in
the digest-pinned Prometheus and Alertmanager images. They are exploitability
statements, not broad vulnerability ignores.

Each `not_affected` statement is backed by a `govulncheck v1.6.0 -mode binary`
scan of the corresponding release binary. The scanner found no vulnerable
symbols for the listed Trivy HIGH findings. CB2 additionally exposes both
monitoring UIs on host loopback only, feeds Prometheus fixed-name numeric metrics,
uses repository-controlled alert labels, configures only HTTP webhook delivery,
and enables no gRPC, xDS, or SSH endpoint.

Any image digest or embedded package-version change invalidates the matching
statement. The container gate must then fail until binary reachability is
re-verified. Remove the statement as soon as an upstream stable release includes
the fixed dependency version named in its `action_statement`.
