# Operations Runbook

## 15-Minuten-Triage

1. `/healthz` und `/readyz` abrufen; Readiness-Einzelchecks notieren.
2. `correlation_id`, `outbox_id`, `event`, `attempt`, `outcome`, `latency_ms` und `error_code` in strukturierten Logs filtern.
3. `/api/outbox?status=failed,unknown` mit Viewer-Token abrufen; Anzahl, Alter und betroffene Quellen/Ziele bestimmen.
4. Telegram-Verbindung, ältesten Pending-Task, AI-Tagesbudget, Backup-Frische, Queue-Nutzung und letzten bestätigten Sendzeitpunkt prüfen.
5. Vor Retry Datenumfang und Duplikatrisiko dokumentieren. `unknown` wird niemals blind erneut gesendet.

## Alarmmatrix

| Signal                                        | Priorität | Sofortaktion                                                           |
| --------------------------------------------- | --------- | ---------------------------------------------------------------------- |
| `readyz != 200` >2 min                        | Hoch      | Einzelcheck und Dependency isolieren                                   |
| Outbox `unknown > 0`                          | Kritisch  | Routing bei wachsendem Umfang stoppen; Zielkanal reconciliieren        |
| Outbox `failed > 0` oder Pending-Alter >5 min | Hoch      | Fehlercode/Retrybarkeit prüfen                                         |
| Backup-Alter >15 min oder `backup_healthy=0`  | Hoch      | Off-host-Schutz prüfen; Release stoppen                                |
| `retention_healthy=0` oder Retention-Backlog  | Hoch      | Routing nicht freigeben; DB-Wachstum und Policy prüfen                  |
| Freier Datenträger unter `DATA_MIN_FREE_BYTES`| Kritisch  | Routing stoppen; sicheren Speicher erweitern, nichts ungeprüft löschen  |
| Crash-Block-Datei vorhanden                   | Kritisch  | keine Lock-Löschung vor Ursachenklärung                                |
| AI-Budget erschöpft / Schemafehleranstieg     | Hoch      | automatische AI-Verarbeitung fail closed lassen; Versionen vergleichen |

## Retention und Speicherdruck

- `failed`, `unknown` und aktive Outbox-Zustände niemals zur Speichergewinnung löschen.
- `tg_forwarder_database_allocated_bytes`, `tg_forwarder_database_reusable_bytes`, `tg_forwarder_disk_available_bytes` und `tg_forwarder_retention_backlog` gemeinsam bewerten.
- Bei Backlog zunächst Ursache und Nachrichtenrate bestimmen; Batchgröße nur innerhalb der validierten Grenzen und nach Lasttest erhöhen.
- Bei vollem Datenträger Routing sauber stoppen. Keine DB-, WAL- oder SHM-Datei manuell entfernen.
- Änderungen der Retention müssen Data Owner, Backup-Aufbewahrung, Rechtsgrundlage und Restore-Tests gemeinsam berücksichtigen.

## Timeout oder Provider-Ausfall

- Keine manuellen Parallelstarts erzeugen.
- Anhand der Outbox unterscheiden: `preparing` kann sicher wiederaufgenommen werden; `sending` wird `unknown`.
- AI-Timeoutergebnisse werden verworfen und reserviertes Budget konservativ verbucht.
- Bei Telegram `FLOOD_WAIT` greift nur der begrenzte, abbrechbare Retry. Werte über 60 Sekunden werden nicht geschlafen.

## Neustart und Crash Loop

- Normal: `SIGTERM` senden und Abschluss von Queue, TDLib, HTTP und DB abwarten.
- Nach drei unerwarteten Abbrüchen in fünf Minuten startet Routing nicht weiter.
- `.process_active`, `.routing_active` oder `.crash_blocked` erst entfernen, wenn auf OS-Ebene kein Prozess läuft, Logs ausgewertet und `failed/unknown` reconciled wurden.
- Danach genau einen Start durchführen und Readiness sowie synthetische Zustellung beobachten.

## Unknown-Zustellung reconciliieren

1. Taskdaten und `correlation_id` sichern.
2. Zielkanal anhand Quelle, Zeit, Inhalt/Mediengruppe und Telegram-ID prüfen.
3. Nachgewiesen vorhanden: `/api/outbox/acknowledge` mit Begründung und Header `X-Destructive-Confirmation: acknowledge-unknown-delivery`.
4. Nachgewiesen nicht vorhanden: expliziter `/api/outbox/retry` mit Header `X-Destructive-Confirmation: retry-unknown-delivery`.
5. Unklar: Task bleibt `unknown`; eskalieren, nicht wiederholen.

## Backup, Restore und Rollback

```bash
npm run backup:create
npm run backup:verify -- ./backups/backup-<timestamp>-<id>
npm run backup:restore -- ./backups/backup-<timestamp>-<id>
```

Vor Restore Dienst stoppen, Locks und Outbox dokumentieren, Backup aus unabhängigem Ziel holen und Prüfergebnis archivieren. Danach `readyz`, Tabellen/Counts und einen synthetischen E2E-Flow prüfen. Bei Abweichung Dienst stoppen und die erhaltenen `.pre-restore-*`-Dateien gemäß Restore-Ausgabe zurückrollen. TDLib-Sessiondaten sind nicht Teil des Backup-Artefakts; Reauthentifizierung ist ein separater Recovery-Schritt.

## Release und Rollback

- Nur unveränderliches Image/Commit deployen; Version und SBOM notieren.
- Staging-Smoke, Live-AI-Golden-Set bei KI-Änderung und Restore-Evidenz müssen vorliegen.
- Rollback auf das vorherige Image verändert keine DB rückwärts. Bei Schemaänderungen gilt ausschließlich der freigegebene Downgrade-Plan.
- Nach Rollback Readiness, Outbox, letzte bestätigte Zustellung und Backup-Frische prüfen.
