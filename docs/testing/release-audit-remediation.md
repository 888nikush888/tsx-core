# Release audit remediation (2026-09-07)

This change addresses the release audit of main `27d918cc70734dfd6f6d2fbd15a7e488c87f1832`.
The implementation and test boundaries below do not constitute deployment or
provider acceptance. Exact GitHub Actions and Sonar results belong to the final
published commit and must be read from that commit's checks.

| Finding | Implemented behavior and evidence |
| --- | --- |
| F01: restart depends on HTTP finish | Restart, restore and factory reset use a durable operation bound to actor, request and process generation. Response finish/close or a bounded fallback requests completion once. Replays never repeat destructive work. An uncertain completion write remains `unknown`; a new process is distinct from routing/trading readiness. Real HTTP and isolated child-process tests cover disconnects, receipt errors and crashes. |
| F02: Sonar blockers | All 18 reported cognitive-complexity locations were split into bounded helpers. Both review sorts explicitly preserve the existing UTF-16 order and canonical hash bytes. The account-wide failure regex has explicit alternative groups. Log search identifies its dedicated-worker scope; no origin rule or quality threshold is suppressed. Actual Sonar closure must be confirmed by the published analysis. |
| F03: unenforced GitHub checks | Pull requests now run the existing named quality checks and their own Sonar analysis. Exact SHA/scope validation prevents a main result being reused for a PR. Repository settings must enforce the 14 named GitHub Actions checks, current base, two approvals, CODEOWNER/last-push approval, resolved conversations and administrator protection. Release tags must be immutable. The current maintainer roster needs two eligible non-author reviewers; code does not create or impersonate approval. |
| F04: real-provider acceptance absent | Deliberately remains unproved. Hyperliquid's renewed implementation receipt binds reviewed source and actual local gate evidence only; `providerAcceptanceVerified` stays false. Bybit and Kraken Futures remain quarantined. Real accounts, external orders, production restore/reset and deployment were not exercised by these tests. |
| F05: coverage denominator and failure paths | Python tests still all execute while only source/tooling contributes to measured coverage. LCOV paths are normalized without changing counters or scope. Tests add future/expired/wrong-day and identity-mismatched observations, partial database failure, parser input/configuration/consent/provider failure, missing/archived dependencies, conflicting original executions and uncertain exit operations. A found UI bug now exposes the credential-version match boolean while retaining redaction of the credential identity. |
| F06: frontend complexity | Operator route selection, backup commands and nested resource/workflow forms are separated into small units. Frontend tests cover route families, viewer restrictions, confirmations, stable operation IDs, uncertain writes without automatic replay, obsolete job reads and delayed responses. |

The independent review of restart completion also considers a hung HTTP/audit
response during shutdown. A successful destructive operation must not remain
indefinitely dependent on that response. Shutdown and new-generation tests are
isolated from provider and production data, and keep entry authorization off.

Release-tag verification additionally requires a successful Quality OS main-push
run for the exact tagged commit, including its Sonar gate. An ancestor with a red
main run cannot become a release candidate just by receiving a tag.

The graph table has dedicated component tests. Its connection command rejects
self-connections and endpoints removed from the current graph, and checks the
viewer restriction directly as well as disabling the controls.

The original Telegram `degraded`/`recovered` notifications are historical input,
not live telemetry. No claim about the currently deployed process or its network
health follows from publishing these changes. A healthy stream alone still does
not grant account-level trading authorization.

GitHub's dependency graph is permanently enabled for public repositories. The
governance check verifies both public visibility fields from the repository API;
moving this repository to private requires a separately reviewed policy. This
avoids relying on an undocumented repository setting or the deprecated SBOM export.
See [GitHub security and analysis settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-security-and-analysis-settings-for-your-repository).
