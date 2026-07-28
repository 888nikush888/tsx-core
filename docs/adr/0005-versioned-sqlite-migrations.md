# ADR 0005: Versionierte, transaktionale SQLite-Migrationen

## Status

Akzeptiert am 2026-07-14.

## Kontext

Das bisherige Startverfahren ergänzte Spalten und Indizes ad hoc. Dadurch waren Reihenfolge, bereits ausgeführte Schritte, Code-/Schema-Drift und Rollback-Evidenz nicht eindeutig beweisbar. Ein neueres Schema durfte außerdem nicht still von einem älteren Binary geöffnet werden.

## Entscheidung

SQLite führt eine lückenlose `schema_migrations`-Historie aus Version, Name, SHA-256 und Ausführungszeit. Jede ausstehende Migration läuft einzeln in `BEGIN IMMEDIATE`/`COMMIT`; Fehler führen zu `ROLLBACK` und blockieren den Start. Unbekannte neuere Versionen, Lücken, Reihenfolgefehler sowie geänderte Namen oder Checksummen werden fail-closed abgewiesen.

Vor der ersten Änderung an einer bereits vorhandenen Datenbank erzeugt der Prozess über die SQLite-Online-Backup-API einen integritätsgeprüften Snapshot unter `session_data/.migration-backups/`. Der Snapshot wird nicht automatisch gelöscht. Aktuelle Migrationen sind additiv; die Inbox-Deduplizierung entfernt ausschließlich bereits vertragswidrige doppelte `(chat_id, message_id)`-Zeilen, bevor der eindeutige Index entsteht.

## Rollback

Ein Binary-Rollback darf das Schema nur dann unverändert weiterverwenden, wenn dessen Kompatibilität im Release-Record belegt ist. Andernfalls wird der Dienst vollständig gestoppt, die Outbox dokumentiert und der passende Snapshot mit `npm run db:migration:restore -- <snapshot.db> --confirm-restore-pre-migration` atomar installiert; bestehende DB/WAL/SHM-Dateien bleiben forensisch erhalten. Danach darf ausschließlich das zum Snapshot passende frühere Image starten.

## Akzeptanzkriterien

- Legacy-Schema migriert reproduzierbar auf `LATEST_SCHEMA_VERSION` und behält Outbox-Daten.
- Jede Migration ist atomar und genau einmal in lückenloser Reihenfolge verzeichnet.
- Neuere, manipulierte oder nicht zusammenhängende Historien blockieren den Start.
- Vor Legacy-Migration existiert ein per `PRAGMA integrity_check` verifizierter Snapshot.
- Restore verweigert aktive Prozess-/Routing-Locks, bewahrt den ersetzten Zustand und kann erneut auf die aktuelle Version migriert werden.

Die derzeitige `LATEST_SCHEMA_VERSION` ist 14. Migration 8 ergänzt versionierte deklarative Signalverträge, Migration 9 Kanalrisiko, Equity- und Execution-Telemetrie, Migration 10 Agenten, Sitzungen, Aktionen, Kontrollanforderungen und Event-Zustellungen für MCP, Migration 11 die auditfeste Löschung aktiver MCP-Agenten über einen Tombstone-Zeitpunkt, Migration 12 Exchange-Streams, MCP-Freigaben und Trade Journal, Migration 13 den leeren Auslieferungszustand und Migration 14 den persistenten MCP-Runtime-Modus mit sicherem Default `disabled`. Vorhandene Inbox-/Outbox-, Trading- und MCP-Auditdaten bleiben erhalten. Künftige Versionsänderungen aktualisieren diese Zahl nur zusammen mit Migrationstest und Downgrade-Plan.
