# ADR 0004: Verifiziertes Backup und Offline-Restore

- Status: Accepted
- Datum: 2026-07-13

## Kontext

SQLite, Outbox und Konfiguration sind für Recovery erforderlich. Eine bloße Dateikopie während Schreibaktivität oder ein Backup auf derselben Platte beweist keine Wiederherstellbarkeit.

## Entscheidung

Der Dienst erstellt spätestens alle 15 Minuten einen SQLite-Online-Snapshot plus bereinigte Konfiguration und Manifest. Hashes, Größen, `integrity_check`, Pflicht-Tabellen und Secret-Ausschluss werden vor atomarer Veröffentlichung geprüft. Restore läuft offline, verweigert aktive Locks und erhält den vorherigen Zustand für Rollback.

## Konsequenzen

RPO ist 15 Minuten und Ziel-RTO 60 Minuten. Der heutige Artefaktvertrag umfasst zusätzlich Runtime-Einstellungen und lokale Parser-Templates; verwaltete Secrets, Exchange-Keys und TDLib-Sitzungsdaten bleiben absichtlich ausgeschlossen und müssen nach Restore getrennt bereitgestellt werden. Off-host-Replikation, monatlicher Staging-Restore und TDLib-Reauthentifizierung bleiben operative Pflichten; lokale Artefakte allein sind kein Disaster Recovery.

Ergänzung 26.07.2026: SQLite-Backups umfassen nun auch dynamische Verträge, Kanalrisiko/-telemetrie und MCP-Agentenzustand einschließlich Token-Hashes, jedoch nie Klartext-Agententokens. Restore koordiniert den unabhängigen MCP-Prozess über `.mcp-maintenance`; anschließend sind Agenten-Tokens zu rotieren.
