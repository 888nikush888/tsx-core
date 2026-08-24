# TSX Core – Operations Runbook

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

## Trading-Notfall und Reconciliation

<a id="trading-notfall-und-reconciliation"></a>

1. In **Betrieb → Live** prüfen, ob Kill-Switch, Unknown Orders, ungeschützte Positionen oder veralteter Abgleich gemeldet sind. Keine Order manuell erneut senden und keine lokale Zeile löschen.
2. Exchange-Weboberfläche read-only gegen Konto, Symbol, Client Order ID, Menge und reduce-only Status vergleichen. Withdrawal-/Transfer-Funktionen sind für diese Untersuchung nie erforderlich.
3. Bei offener managed Position sicherstellen, dass exakt ein gültiger Protective Stop über die vollständige Restmenge existiert. Bei fehlendem Schutz **Notfall-Flatten** mit der angezeigten exakten Phrase ausführen; die Anwendung deaktiviert vorher neue Entries und sendet nur reduce-only.
4. Ein unbekannter Submit-/Cancel-Ausgang wird nicht blind wiederholt. Erst Exchange-Historie und Fills belegen. Danach **Jetzt reconciliieren**; der Reconciler übernimmt bestätigte Orders/Fills, verkleinert den Stop nach TP-Teilfills und setzt ihn entsprechend der Strategie auf konfiguriertes Break-even/Trailing oder – im adaptiven Modus – nach TP1/TP2 auf Break-even und danach auf TP(i-2).
5. Fremde Orders oder Positionen auf demselben API-Konto gelten als unmanaged Exposure. Entweder außerhalb des Systems nach Vier-Augen-Betriebsprozess schließen oder ein separates ausschließlich diesem System gehörendes Exchange-Subkonto verwenden. Der Kill-Switch bleibt bis zu einer erfolgreichen Null-/Managed-Reconciliation aktiv.
6. Vor Aufheben der Sperre Datenumfang, betroffene Kanäle/Strategieversionen und Ursache dokumentieren. **Abgleichen und Sperre aufheben** führt nochmals alle aktivierten Konten gegen die Exchange; erst Erfolg entfernt die Sperre.

Factory Reset und Datenbank-Löschung dürfen niemals Exchange-Exposure verwaisen lassen. Factory Reset stoppt MCP-Brücke und Trading-Worker, signalisiert dem unabhängigen MCP-Prozess ein gemeinsames Wartungsfenster, storniert offene Entries, prüft jedes Nicht-Paper-Konto über CCXT REST und verweigert bei Order/Position oder nicht erreichbarer Exchange die Löschung. Danach werden DB einschließlich Workflowrevisionen, MCP-Modus, Verträgen, adaptivem Risiko, Analytics und MCP-Agenten, Strategie-/Alt-Routingzustand, alle Exchange-Key-Dateien und der interne Executor-Key entfernt; der neue Key wird nach Neustart automatisch vom bereits laufenden Sidecar akzeptiert und der neue MCP-Modus ist `disabled`. **Betriebsdaten leeren** ist davon getrennt: Es stoppt das Nachrichten-Routing und entfernt Nachrichten, Queue-/Medienpuffer sowie nicht von Trades referenzierte Signale atomar. Trading-Historie, Strategien, Konten, Secrets und trade-referenzierte Signale bleiben unverändert erhalten.

## Signalvertrag oder Schema-Profil ändern

1. Im Vertragsbaustein Vertrags-ID, Version, Status und Definition-Hash erfassen. Publizierte Definitionen nie in SQLite bearbeiten; der Builder erzeugt eine neue Version.
2. Änderung als neuen Entwurf aus der gewünschten Version erstellen oder Vertrag duplizieren. XML-Pfade, Feldtypen, Entry-/Target-Form, Geometrie und Quelltext-Erdung im visuellen Builder vollständig prüfen.
3. Den Entwurf mit kontrolliertem XML und ursprünglichem Telegram-Text validieren; anschließend publizieren. Erst danach ein Ersatzprofil mit passendem Parser-Template und neuer `contractVersionId` anlegen beziehungsweise umstellen.
4. Verwendet eine aktive Kanalroute das Profil, zuerst eine neue Strategieversion mit dem Ersatzprofil publizieren und die Route bewusst umstellen. Bestehende Trades behalten ihre immutable alte Strategieversion.
5. Das Ersatzprofil mit einer Paper-Nachricht prüfen. Das Signal muss ein eindeutiges `USD`-, `USDC`- oder `USDT`-Paar liefern; Provenance, Geometrie, Intent, Kanalrisiko, TP-Allokationen und Stop-Modus kontrollieren.
6. Erst wenn kein aktiviertes Profil mehr auf die alte Vertragsversion verweist, diese archivieren. Entwürfe verwenden `delete-signal-contract-draft`. Publizierte oder archivierte Versionen können mit `delete-signal-contract-version` endgültig gelöscht werden, nachdem sämtliche – auch deaktivierte – Schema-Profile umgestellt oder gelöscht wurden; Profillöschung verwendet `delete-trading-signal-schema`.
7. Nach der Änderung Trading-Snapshot, Kanalrouten, `/readyz`, Audit-Record, `contract_changed`-Event und Paper-Intent prüfen. Bei Mismatch Route deaktivieren; kein stiller Fallback auf einen anderen Vertrag.

## MCP-Agent kompromittiert oder fehlerhaft

1. Bei unklarem Umfang unter **MCP-Agenten → MCP-Server** zuerst `disabled` wählen; dadurch werden alle Sitzungen getrennt und noch nicht gestartete freigegebene MCP-Arbeit verworfen. Danach den betroffenen Agenten deaktivieren. Bei endgültigem Widerruf **Agent löschen** verwenden; dadurch werden Token, Rechte, aktive Sitzungen und noch wartende Kontrollanforderungen widerrufen und der Agent aus dem aktiven Inventar entfernt. Die anonymisierte Audit-Historie bleibt erhalten.
2. Unter **Betrieb → Live** Kill-Switch, offene Positionen, unbekannte Orders und letzte Reconciliation prüfen. Bei unklarer Exchange-Wirkung niemals denselben Tool-Aufruf blind wiederholen.
3. Agenten-Aktionen, Sitzung, `mcp_control_request`-ID, hashverkettete Audit-Records und passende Trading-Execution-Events sichern. Token oder Request-Secrets nicht in Tickets kopieren.
4. Falls `trading.kill_switch`, `trading.cancel_entries` oder `trading.flatten` verwendet wurde, Exchange read-only gegen Client Order IDs und Fills prüfen und anschließend über einen menschlichen Admin reconciliieren.
5. Ursache beheben, Rechte auf das Minimum reduzieren und Token rotieren. Alte Tokens können nicht wieder aktiviert werden.

Bei Backup-Restore, Migration-Rollback oder Factory Reset stoppt TSX Core die interne MCP-Brücke und setzt im gemeinsamen SQLite-Volume `.mcp-maintenance`. Der unabhängige MCP-Dienst muss daraufhin seine Sitzungen und den DB-Handle schließen. Ein Dienst, der den Marker ignoriert oder während des Wartungsfensters neu startet, bleibt ungesund und darf nicht manuell am Marker vorbeigestartet werden.

## MCP-Vorschlag prüfen

1. In **MCP-Agenten → Freigabe-Warteschlange** Agent, Aktion, Ablaufzeit, Payload, Preflight-Blocker und Wirkungsbeschreibung prüfen. Unbekannte oder nicht mehr benötigte Vorschläge ablehnen.
2. Vor Routing-, Risiko-, Strategie- oder Vertragsänderungen aktive Routen und Positionen gegenprüfen. Die Freigabe bestätigt nur die konkrete persistierte Payload; sie erweitert keine Agentenrechte.
3. Genehmigen verlangt die explizite destruktive Bestätigung. Die Brücke prüft den Agenten und sein aktuelles Recht bei Ausführung nochmals. Entzogene Rechte, neue Referenzen oder inzwischen ungültiger Zustand müssen zum Fehler führen.
4. Nach Ausführung `proposalId`, Agenten-Aktion, `authorized`/`completed`-Audit-Records und den fachlichen Zielzustand gemeinsam prüfen. `failed` oder nach Neustart unterbrochene Vorschläge niemals blind duplizieren; Ursache und mögliche Teilwirkung zuerst reconciliieren.

## Exchange-WebSocket degradiert

1. Unter **Betrieb → Konten/Live** Konto, CCXT-Pro-Streamstatus, Cursor/Lückenzähler, letztes Ereignis und Fehler sichern. Keine Streamzeile manuell aus SQLite löschen.
2. Prüfen, ob die periodische REST-Reconciliation weiterhin erfolgreich und jünger als 30 Sekunden ist. WebSocket-Ausfall allein darf sie nicht stoppen; schlägt auch REST fehl, Trading bleibt beziehungsweise wird fail-closed gesperrt.
3. Bei Cursor-Lücke sofort **Jetzt reconciliieren** verwenden und Remote Orders/Fills/Positionen mit den managed Client-IDs vergleichen. Der WebSocket-Payload ist niemals autoritativer Wiederherstellungsbeleg.
4. Sidecar-/SDK-Netzwerk, Credential-Status und Exchange-Statusseite prüfen. Nach Wiederverbindung muss der Cursor fortlaufen, der Status `healthy` werden und ein zustandsänderndes Testevent eine erzwungene REST-Reconciliation auslösen.
5. Wiederholte identische Events sind erwartbar und werden über den Event-Schlüssel dedupliziert. Bei dauerhaft wachsendem Lückenzähler Live-Entries deaktiviert lassen und eskalieren.

## Clock Drift

<a id="clock-drift"></a>

1. `tg_forwarder_clock_drift_milliseconds` und `tg_forwarder_clock_max_drift_milliseconds` vergleichen. Ein ausgelöster Clock-Guard bleibt bis zum Prozessneustart gelatcht und blockiert neue Trading-Entries; bestehende Positionen werden weiterhin reconciliert und geschützt.
2. Auf dem Container-Host den Status des autorisierten NTP-/Zeitdienstes und dessen letzte erfolgreiche Synchronisation prüfen. Zeitzone ist unerheblich; UTC-Systemzeit und monotone Uhr dürfen nicht springen.
3. Keine Uhrzeit manuell zurückstellen, solange der Dienst läuft. Erst Ursache und Host-Offset korrigieren, dann den Forwarder kontrolliert neu starten.
4. Nach Neustart müssen Clock-Metrik und Readiness grün bleiben. Vor Wiederfreigabe von Trading eine erfolgreiche Exchange-Reconciliation und den dokumentierten synthetischen Test abwarten.

`CLOCK_MAX_DRIFT_MS` akzeptiert 100 bis 5000 Millisekunden und ist standardmäßig 1000. Der Guard erkennt Sprünge relativ zur monotonen Prozessuhr; die anfängliche absolute UTC-Synchronisation bleibt eine Host-/NTP-Vorbedingung und muss durch Infrastruktur-Monitoring belegt werden.

## Retention und Speicherdruck

- `failed`, `unknown` und aktive Outbox-Zustände niemals zur Speichergewinnung löschen.
- `tg_forwarder_database_allocated_bytes`, `tg_forwarder_database_reusable_bytes`, `tg_forwarder_disk_available_bytes` und `tg_forwarder_retention_backlog` gemeinsam bewerten.
- Bei Backlog zunächst Ursache und Nachrichtenrate bestimmen; Batchgröße nur innerhalb der validierten Grenzen und nach Lasttest erhöhen.
- Bei vollem Datenträger Routing sauber stoppen. Keine DB-, WAL- oder SHM-Datei manuell entfernen.
- Änderungen der Retention müssen Data Owner, Backup-Aufbewahrung, Rechtsgrundlage und Restore-Tests gemeinsam berücksichtigen.
- Manuell reviewte Journal-Trades werden von der Standardbereinigung nicht entfernt. Exchange-Stream-Rohereignisse sind pro Konto auf die jüngsten 5.000 begrenzt; Journal-Export ist kein Backup-Ersatz.

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

Immer den gesamten Compose-Stack einschließlich `mcp-server` stoppen. Nach Restore jeden Agenten-Token rotieren, Rechte, Ereignis-Abonnements und den wiederhergestellten persistenten MCP-Modus gegen den Restore-Zeitpunkt prüfen. Danach mit `docker compose up -d` starten und MCP erst nach dieser Prüfung im Dashboard aktivieren; für eine ungeklärte Restore-Lage zuerst `disabled` setzen.

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
4. Im ausgelieferten Repository sind diese Self-hosted Workflows bis zur Runner-Einrichtung nur manuell auslösbar. Für Produktionsbetrieb einen extern überwachten Scheduler konfigurieren, der `Staging Release Gate` nach jedem erfolgreichen Main-Build, `Staging Synthetic Monitor` alle 15 Minuten und `Production 30-Day Evidence` täglich startet. Das externe Incident-System muss ausgebliebene Starts und Runner-Offline-Zustände alarmieren, weil ein nicht gestarteter Workflow keinen Anwendungsalarm erzeugt.
5. Vor dem Release die JSON-Artefakte unter `reports/staging/` und `reports/soak/` dem Release-Record zuordnen. Sie müssen denselben Commit-Hash wie der Tag tragen; ein 30-Tage-Fenster mit weniger als 171936 Scrapes oder 100 Zustellversuchen ist nicht belastbar und bleibt NO-GO.

Die Staging- und Produktions-Observer-Identitäten erhalten keinerlei Produktions-Schreibrechte außer dem absichtlich begrenzten synthetischen Staging-Send. Token-Rotation, Runner-Patching und die Prüfung des externen Alarmempfängers erfolgen monatlich und nach jedem Credential-Verdacht.

## Audit-Trail-Ausfall

1. Bei `ForwarderAuditTrailUnhealthy` alle Dashboard-Mutationen einstellen; die Anwendung blockiert neue Änderungen bereits mit HTTP 503. Telegram-Routing läuft weiter, solange keine andere Readiness-Bedingung verletzt ist.
2. `tg_forwarder_audit_last_remote_success_timestamp_seconds`, Gateway-Status und die letzte `request_id` vergleichen. Keine Records oder Bearer-Token in Tickets kopieren.
3. Die lokale `logs/audit-chain.jsonl` schreibgeschützt sichern und mit einer isolierten Instanz beziehungsweise dem zugehörigen Audit-Test verifizieren. Eine beschädigte Kette nie bearbeiten oder überschreiben; Host und Datei forensisch erhalten.
4. Bei Gateway-Ausfall den externen Store reparieren, den Dienst stoppen und zunächst `npm run audit:verify` ausführen. Danach mit `npm run audit:replay -- --confirm-audit-replay` die vollständige lokale Kette idempotent nachliefern. Der Gateway-Vertrag muss Duplikate anhand des Hashes akzeptieren, aber widersprüchliche Records ablehnen.
5. Vor Wiederfreigabe einen ungefährlichen authentifizierten Test-Request ausführen und lokale Kette, externen Record, 2xx-Antwort, Metrik und Alarmauflösung gemeinsam belegen.

Erreicht die lokale Datei `AUDIT_LOCAL_MAX_BYTES`, wird sie nur im vollständigen Stoppzustand nach belegter Off-host-Archivierung verschoben. Danach startet der Dienst eine neue Kette; Archiv-Hash, letzter alter Hash und erster neuer Hash werden im unveränderlichen Audit-System und im Betriebsrecord verknüpft.
