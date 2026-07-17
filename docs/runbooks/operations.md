# Operations Runbook

## 15-Minuten-Triage

1. `/healthz` und `/readyz` abrufen; Readiness-Einzelchecks notieren.
2. `correlation_id`, `outbox_id`, `event`, `attempt`, `outcome`, `latency_ms` und `error_code` in strukturierten Logs filtern.
3. `/api/outbox?status=failed,unknown` mit Viewer-Token abrufen; Anzahl, Alter und betroffene Quellen/Ziele bestimmen.
4. Telegram-Verbindung, ältesten Pending-Task, AI-Tagesbudget, Backup-Frische, Queue-Nutzung und letzten bestätigten Sendzeitpunkt prüfen.
5. Vor Retry Datenumfang und Duplikatrisiko dokumentieren. `unknown` wird niemals blind erneut gesendet.

## Alarmmatrix

<a id="alarm-triage"></a>

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
- `.process_active` ist ein exklusiver PID-/Token-Lock. Ein vorhandener oder unlesbarer Lock blockiert den Start fail closed; nur ein nachweislich beendeter PID wird automatisch als stale bereinigt.
- `.routing_active` oder `.crash_blocked` erst entfernen, wenn auf OS-Ebene kein Prozess läuft, Logs ausgewertet und `failed/unknown` reconciled wurden.
- Danach genau einen Start durchführen und Readiness sowie synthetische Zustellung beobachten.

## Beschädigte verwaltete Konfiguration oder Secrets

1. Nicht versuchen, JSON- oder Secret-Dateien im Volume manuell zu korrigieren. Der Dienst startet in `recovery-required`; Routing, Scheduler und Datenbank bleiben aus.
2. Im mitgelieferten loopback-only Compose-Profil öffnet das Dashboard ohne Bearer-Eingabe eine ausschließlich lokale Repair-Session. Nur Konfiguration, Runtime-Einstellungen und verwaltete Secrets sowie Neustart sind erreichbar.
3. Ursache und `request_id` aus dem kritischen Recovery-Log sichern. Diese Repair-Mutationen sind ausdrücklich als unauditiert markiert, weil die Audit-Kette selbst fehlen oder beschädigt sein kann.
4. Gültige Werte im Web speichern, Container neu starten und erst nach grünem `readyz`, Outbox-Prüfung und synthetischem Test wieder Routing aktivieren.

## Unknown-Zustellung reconciliieren

1. Taskdaten und `correlation_id` sichern.
2. Zielkanal anhand Quelle, Zeit, Inhalt/Mediengruppe und Telegram-ID prüfen.
3. Nachgewiesen vorhanden: `/api/outbox/acknowledge` mit Begründung und Header `X-Destructive-Confirmation: acknowledge-unknown-delivery`.
4. Nachgewiesen nicht vorhanden: expliziter `/api/outbox/retry` mit Header `X-Destructive-Confirmation: retry-unknown-delivery`.
5. Unklar: Task bleibt `unknown`; eskalieren, nicht wiederholen.

## Backup, Restore und Rollback

```bash
docker compose exec -T forwarder /nodejs/bin/node dist/backup_cli.js create /app/backups
docker compose exec -T forwarder /nodejs/bin/node dist/backup_cli.js verify /app/backups/<artifact-name>
docker compose down
docker compose run --rm --no-deps --entrypoint /nodejs/bin/node forwarder dist/backup_cli.js restore /app/backups/<artifact-name>
docker compose up -d
```

Vor Restore Dienst stoppen, Locks und Outbox dokumentieren, Backup aus unabhängigem Ziel holen und Prüfergebnis archivieren. Das Artefakt stellt DB, nicht geheime Konfiguration, Runtime-Einstellungen und Templates wieder her; verwaltete Secrets sowie TDLib-Sessiondaten sind nicht enthalten und werden getrennt re-provisioniert. Danach `readyz`, Tabellen/Counts und einen synthetischen E2E-Flow prüfen. Bei Abweichung Dienst stoppen und die erhaltenen `.pre-restore-*`-Dateien gemäß Restore-Ausgabe zurückrollen. TDLib-Reauthentifizierung ist ein separater Recovery-Schritt.

## Release und Rollback

- Nur unveränderliches Image/Commit deployen; Version und SBOM notieren.
- Staging-Smoke, Live-AI-Golden-Set bei KI-Änderung und Restore-Evidenz müssen vorliegen.
- Rollback auf das vorherige Image verändert keine DB rückwärts. Bei Schemaänderungen gilt ausschließlich der freigegebene Downgrade-Plan.
- Nach Rollback Readiness, Outbox, letzte bestätigte Zustellung und Backup-Frische prüfen.
- Bei inkompatibler DB-Migration den Dienst stoppen und ausschließlich den im Release-Record benannten `.migration-backups`-Snapshot mit `docker compose run --rm --no-deps --entrypoint /nodejs/bin/node forwarder dist/migration_cli.js restore <snapshot> --confirm-restore-pre-migration` einspielen; das ersetzte DB/WAL/SHM-Set bleibt erhalten.

## Staging- und Produktions-Evidence

1. Einen nur für Staging bestimmten, nicht interaktiv betriebenen Telegram-Account einmalig anmelden und dessen TDLib-Verzeichnisse außerhalb des Repository-Workspaces sichern. Der Account benötigt Schreibzugriff auf `E2E_SOURCE_CHAT_ID` und Lesezugriff auf `E2E_TARGET_CHAT_ID`; der laufende Staging-Forwarder muss genau diese Quelle auf genau dieses Ziel routen.
2. Einen GitHub Self-hosted Runner mit den Labels `self-hosted, staging` anlegen. Im geschützten Environment `staging` die Secrets `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `OPENROUTER_API_KEY` und die Variablen `E2E_SOURCE_CHAT_ID`, `E2E_TARGET_CHAT_ID`, `E2E_TDL_DATABASE_DIR`, `E2E_TDL_FILES_DIR` hinterlegen. Verzeichnisse und Account dürfen nicht von Produktion genutzt werden.
3. Einen getrennten read-only Runner mit den Labels `self-hosted, production-observer` anlegen. Im Environment `production-observer` `PROMETHEUS_URL` und ein minimal berechtigtes `PROMETHEUS_TOKEN` setzen. Der Endpunkt darf nur PromQL-Abfragen erlauben; Admin-, Reload- und Write-APIs bleiben gesperrt.
4. `Staging Release Gate` nach jedem erfolgreichen Main-Build und `Staging Synthetic Monitor` alle 15 Minuten ausführen lassen. Das externe Incident-System muss Ausfälle des Schedules/Runner-Offline-Zustands zusätzlich überwachen, weil ein nicht gestarteter Workflow keinen Anwendungsalarm erzeugt.
5. Vor dem Release die JSON-Artefakte unter `reports/staging/` und `reports/soak/` dem Release-Record zuordnen. Sie müssen denselben Commit-Hash wie der Tag tragen; ein 30-Tage-Fenster mit weniger als 171936 Scrapes oder 100 Zustellversuchen ist nicht belastbar und bleibt NO-GO.

Die Staging- und Produktions-Observer-Identitäten erhalten keinerlei Produktions-Schreibrechte außer dem absichtlich begrenzten synthetischen Staging-Send. Token-Rotation, Runner-Patching und die Prüfung des externen Alarmempfängers erfolgen monatlich und nach jedem Credential-Verdacht.

## Audit-Trail-Ausfall

1. Bei `ForwarderAuditTrailUnhealthy` alle Dashboard-Mutationen einstellen; die Anwendung blockiert neue Änderungen bereits mit HTTP 503. Telegram-Routing läuft weiter, solange keine andere Readiness-Bedingung verletzt ist.
2. `tg_forwarder_audit_last_remote_success_timestamp_seconds`, Gateway-Status und die letzte `request_id` vergleichen. Keine Records oder Bearer-Token in Tickets kopieren.
3. Die lokale `logs/audit-chain.jsonl` schreibgeschützt sichern und mit einer isolierten Instanz beziehungsweise dem zugehörigen Audit-Test verifizieren. Eine beschädigte Kette nie bearbeiten oder überschreiben; Host und Datei forensisch erhalten.
4. Bei Gateway-Ausfall den externen Store reparieren, den Dienst stoppen und zunächst `npm run audit:verify` ausführen. Danach mit `npm run audit:replay -- --confirm-audit-replay` die vollständige lokale Kette idempotent nachliefern. Der Gateway-Vertrag muss Duplikate anhand des Hashes akzeptieren, aber widersprüchliche Records ablehnen.
5. Vor Wiederfreigabe einen ungefährlichen authentifizierten Test-Request ausführen und lokale Kette, externen Record, 2xx-Antwort, Metrik und Alarmauflösung gemeinsam belegen.

Erreicht die lokale Datei `AUDIT_LOCAL_MAX_BYTES`, wird sie nur im vollständigen Stoppzustand nach belegter Off-host-Archivierung verschoben. Danach startet der Dienst eine neue Kette; Archiv-Hash, letzter alter Hash und erster neuer Hash werden im unveränderlichen Audit-System und im Betriebsrecord verknüpft.
