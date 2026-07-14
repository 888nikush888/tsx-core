# Changelog

Alle relevanten Änderungen werden in dieser Datei dokumentiert. Das Format folgt Keep a Changelog; Versionen folgen Semantic Versioning.

## [Unreleased]

### Added

- Fail-closed Kanonisierung von Telegram-Quellen für quellspezifische Filter, Aliase und KI-Templates.
- Begrenzte operative Daten-Retention mit Disk-/SQLite-Kapazitätsmetriken und Readiness-Gates.

## [1.0.0] - 2026-07-13

### Added

- Durable SQLite-Inbox/Outbox mit bestätigter TDLib-Zustellung und fail-closed `unknown`-Reconciliation.
- Strikte, geerdete KI-Signalverträge, Provider-Budgets, Provenance und adversariales Golden Set ohne Runtime-Human-in-the-loop.
- Rollenbasierte Loopback-Control-Plane, ehrliche Health-/Readiness-Metriken und korrelierte Zustelllogs.
- Verifizierte Backups, Offline-Restore, Crash-Loop-Schutz und Graceful Shutdown.
- Quality-OS mit Coverage-, Mutation-, Architektur-, Secret-, SAST-, Dependency-, Lizenz-, SBOM- und Container-Gates.

### Changed

- Container läuft non-root mit read-only Root-Dateisystem, begrenzten Ressourcen, gepinntem Base-Image und ohne npm im Runtime-Layer.
- Konfiguration wird atomar und ohne Secret-Persistenz geschrieben.
- Frontend enthält nur erreichbare Produktivmodule und tatsächlich verwendete Dependencies; große Chart-Abhängigkeiten werden separat gebündelt.

### Security

- Dashboard-Authentifizierung, exakte CORS-Origin, Security Header, Request-Limits und Bestätigung destruktiver Aktionen.
- GitHub Actions sind per vollständigem SHA gepinnt; Trivy verwendet den nach GHSA-69fq-xp46-6x23 sicheren Action-/Scanner-Stand.
- Container- und npm-Scans blockieren bekannte moderate beziehungsweise HIGH/CRITICAL-Funde.
