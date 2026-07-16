# Changelog

Alle relevanten Änderungen werden in dieser Datei dokumentiert. Das Format folgt Keep a Changelog; Versionen folgen Semantic Versioning.

## [Unreleased]

### Added

- Vollständige Web-Control-Plane für Telegram-/OpenRouter-Secrets, Runtime-/Enterprise-Einstellungen, editierbare Default-Templates, Bearer-Key-Erzeugung, Monitoring-Secrets, lokale und verschlüsselte Off-site-Recovery sowie vollständigen Factory Reset.
- Integrierter Standalone-Start ohne Bearer-Dialog, sessiongebundener Browserzugang und ausführbare Frontend-Verhaltenstests für kritische Enterprise-Aktionen.
- Echte Readiness- und Pending-Alter-Metriken, serieller Mutations-Lock und gestreamtes Audit-Replay ohne unkontrollierte Speicherspitze.

- Fail-closed Kanonisierung von Telegram-Quellen für quellspezifische Filter, Aliase und KI-Templates.
- Begrenzte operative Daten-Retention mit Disk-/SQLite-Kapazitätsmetriken und Readiness-Gates.
- Isolierte, terminierende Mutation-Shards für Queue, Retry und KI-Schema mit eigenständiger Evidenz.
- Wöchentliche Vollprüfung, harte Container-CVE-Policy und ein attestiertes, nur nach allen Quality-Gates publizierbares Release-Image.
- Fail-closed Secret-File-Unterstützung für Orchestrator-/Vault-Mounts mit sicherer Umgebungspriorität.
- Verschlüsselte Off-host-Backups mit erzwungenem Download, Authentizitätsprüfung und vollständiger Restore-Verifikation vor Erfolgsmeldung.
- Gepinnter Prometheus-/Alertmanager-Stack mit getesteten Sicherheitsalarmen, authentifiziertem HTTPS-Incident-Relay und synthetischem Zustelltest.
- Reales Staging-Telegram-E2E, viertelstündliche synthetische Prüfung und inhaltsfreie Evidence-Artefakte ohne Human-in-the-loop.
- Gemessene Delivery-SLIs, getestete SLO-Burn-Alarme und ein verpflichtendes automatisiertes 30-Tage-Produktionsfenster vor Release.
- Lückenlose, checksum-geschützte SQLite-Migrationen mit verifiziertem Pre-Migration-Snapshot und forensisch sicherem Downgrade-Restore.
- Fail-closed, hashverketteter Control-Plane-Audit-Trail mit verpflichtender externer HTTPS-Persistenz im Produktions-Container.
- OIDC-/JWKS-Authentifizierung mit geprüftem Issuer, Audience, Zeitgrenzen und Admin-/Viewer-Rollen für die Production-Control-Plane.
- Automatischer Diff-basierter PR-Risikoscore, Dependabot-Matrix und API-verifiziertes GitHub-Governance-Release-Gate.

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
