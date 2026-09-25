# Internal TLS cutover for the five service endpoints

The dashboard, metrics listener, alert relay, Telegram viewer status listener,
and exchange executor require HTTPS in the Compose deployment. This is a
coordinated cutover: changing only one URL or certificate will interrupt
monitoring, viewer access, or order execution. Keep new trading entries blocked
until every dependent check passes. Never switch any of these endpoints back to
HTTP or disable certificate verification to restore availability.

## Provision outside Git

Set `INTERNAL_TLS_DIR` to an absolute, operator-controlled host directory
outside every Git checkout before running Compose. There is no default.
Provision the following files before creating any containers:

| File | Used by | Required certificate identities |
| --- | --- | --- |
| `ca.pem` | Node, Python, Prometheus, Alertmanager and host TLS clients | Trusted issuing CA certificate or bundle; no CA private key |
| `dashboard.crt`, `dashboard.key` | Forwarder dashboard | DNS `forwarder`; IP `127.0.0.1` for host/Tailscale backend |
| `metrics.crt`, `metrics.key` | Forwarder metrics | DNS `forwarder`; IP `127.0.0.1` for its healthcheck and host probes |
| `executor.crt`, `executor.key` | Exchange executor | DNS `exchange-executor`; IP `127.0.0.1` for its healthcheck |
| `viewer.crt`, `viewer.key` | Telegram viewer | DNS `telegram-viewer`; IP `127.0.0.1` for its healthcheck |
| `alert-relay.crt`, `alert-relay.key` | Alert relay | DNS `alert-relay`; IP `127.0.0.1` for its healthcheck |

Each leaf certificate must chain to `ca.pem`, be currently valid, match its
private key, and permit TLS server authentication. Keep private keys readable
only by the corresponding container's UID 65532 (for example, owner UID 65532
and mode 0600 on Linux); CA and certificate files must be readable by the
non-root clients. Every bind is an individual read-only file. Forwarder is the
only container receiving both dashboard and metrics keys because it hosts both
listeners. Prometheus and Alertmanager receive the public CA only. Do not put
PEM bytes into `.env`, managed runtime settings, Git, logs, or backups.

The host's Tailscale Serve backend must verify the dashboard leaf with the
host's trusted CA store. Import the issuing CA into that store before moving
Serve to `https://127.0.0.1:${HOST_WEB_PORT:-8080}`. A browser connecting
directly to the host port must likewise trust the CA. The outer Tailscale
certificate and the internal dashboard certificate serve different TLS hops.
Do not use `--insecure`, `-k`, a trust-all client, or an HTTP backend. Funnel
remains disabled.

## Validate and activate

The preflight needs Python 3.12 and `cryptography`. The Docker host is not
assumed to have that library installed. Use a dedicated virtual environment
outside the checkout and install the repository's hash-pinned executor lock;
this also installs executor packages that the preflight itself does not use.
The Python verifier checks the complete X.509 trust path and each required
server identity offline; manually composing signature checks with Node's
certificate primitives would omit certificate-policy checks.
First verify that `python3.12 --version` (Linux) or `py -3.12 --version`
(Windows) succeeds; provision Python 3.12 through the host's approved
installation method if it does not. On Linux, from the repository root:

```sh
python3.12 -m venv /opt/tsx-core-tls-preflight-venv
/opt/tsx-core-tls-preflight-venv/bin/python -m pip install --require-hashes -r exchange_executor/requirements.lock
export INTERNAL_TLS_DIR=/srv/tsx-core/internal-tls
/opt/tsx-core-tls-preflight-venv/bin/python scripts/check_internal_tls.py
```

On Windows PowerShell, from the repository root:

```powershell
$preflightVenv = Join-Path $env:LOCALAPPDATA 'TSXCore\tls-preflight-venv'
py -3.12 -m venv $preflightVenv
$preflightPython = Join-Path $preflightVenv 'Scripts\python.exe'
& $preflightPython -m pip install --require-hashes -r exchange_executor/requirements.lock
$env:INTERNAL_TLS_DIR = 'C:\TSXCore\internal-tls'
& $preflightPython scripts/check_internal_tls.py
```

Replace the example TLS directory with the actual external host path. The
one-time Python and pinned dependency installation needs network access; the
preflight itself does not. Confirm the Python 3.12 executable is available
before running either platform's commands.

1. Run the preflight before Compose. It reads the CA and five
   certificate/key pairs without
   modifying them. It verifies the trust chains, key matches, validity
   windows, all service DNS SANs and all five loopback IP SANs. On Linux, it
   also requires owner-only keys readable by UID 65532 and non-writable public
   CA/certificate files. On Windows, verify ACL and container access in the
   deployment smoke check. A missing bind source can otherwise become a
   directory when starting Compose.
2. Run `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml
   config --quiet`, `promtool check config monitoring/prometheus.yml`, and
   `amtool check-config monitoring/alertmanager.yml`. Check the effective
   Compose mounts: each private key belongs only to its service.
   A config-only CI check may set `INTERNAL_TLS_DIR` to a disposable absolute
   path outside the checkout, for example `/tmp/tsx-tls-config-only`; this
   validates interpolation but must never be used with `up`. The currently
   pinned native `promtool` and `amtool` validate these YAML files without
   loading the CA from disk; a live scrape and relay delivery still require
   the mounted CA. No production CA or private key enters CI.
3. Put trading into the existing entry-blocked maintenance state and preserve
   the current working TLS generation for rollback. Deploy all five server
   certificates, the shared CA, HTTPS client URLs, monitoring configuration,
   and Compose healthchecks in one controlled release. Recreate the affected
   containers; a restart of Forwarder alone does not restart Viewer, Executor,
   Relay, Prometheus, or Alertmanager.
4. Require healthy HTTPS checks for metrics, executor, viewer and alert relay. Check the
   dashboard through a verifying host client, Prometheus target `UP`, and an
   authenticated synthetic alert through Alertmanager to the relay. Verify
   Viewer-to-Core and Core-to-Viewer status requests, executor catalog/probe,
   paper orders and reconciliation before permitting new entries. Use the CA
   with the client; never suppress validation. Confirm invalid/untrusted or
   wrong-name certificates fail closed.
5. Only after the HTTPS dashboard is reachable and trusted, switch Tailscale
   Serve's backend to HTTPS and verify its tailnet identity path. If any check
   fails, keep entries blocked and restore the last verified **TLS**
   certificates and configuration as a unit. No HTTP fallback is allowed.

The application images also contain their own healthcheck commands. The
Compose healthchecks take precedence in this deployment; standalone image use
requires equivalent HTTPS probes. Prometheus-to-Alertmanager and the separate
MCP listener are outside these five service paths and must be assessed
separately before making a global claim that all internal HTTP is gone.
The monitoring override depends on the base `docker-compose.yml` because
Prometheus joins its `core-network` to reach Forwarder; do not start the
monitoring override as a standalone Compose project.

These external files and Compose values are a deployment bootstrap, not yet
an operator UI for certificate lifecycle. A later UI-managed rotation must
expose desired/active certificate fingerprints, expiry, trust status and an
audited coordinated apply/rollback without revealing private-key contents.
