# TSX Core

TypeScript-Control-Plane für Telegram-Signal-Automatisierung und Multi-Exchange-Trading auf Basis von **TDLib** und **CCXT Pro** (Python-Sidecar). Visuelle Workflows, parallele Ausführung auf mehreren Börsenkonten, SQLite-Persistenz, Prometheus-Metriken, JSON-Logging.

**Dokumentation:** [Production Guide](docs/PRODUCTION_GUIDE.md) · [Trading Guide](docs/TRADING_GUIDE.md) · [MCP Guide](docs/MCP_GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Quality Gates](docs/QUALITY_OS.md) · [Operations Runbook](docs/runbooks/operations.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Implementierungsprüfung, echte Providerabnahme und Releasefreigabe sind getrennte Nachweise. Lokale Fake-Tests oder die statische Exchange-Allowlist sind keine Testnet-/Livefreigabe. Der aktuelle Offline-Prüfrahmen, seine noch fehlende echte Provider-Ausführung und die Pflichtbelege stehen in [Provider- und Releaseabnahme](docs/testing/exchange-acceptance.md).

## Struktur

```
src/                      TypeScript-Backend (Signal-Ingestion, Trading, MCP, Web-API)
frontend/                 React/Vite Workflow-Builder und Betriebs-Dashboard
exchange_executor/        Python-CCXT-Sidecar (REST + WebSocket)
docs/                     Architektur-, Betriebs- und Governance-Dokumentation
monitoring/               Prometheus, Alertmanager, Regeln
tests/                    Unit-, Integrations-, Contract- und Systemtests
```

---

## Architektur

1. **SQLite-Persistenz**: Queue, Album-Buffer und Signale in `session_data/forwarder.db`
2. **Prometheus**: `/metrics` + `/healthz` + `/readyz` auf Port 9100
3. **JSON-Logging**: strukturiert an stdout für Log-Aggregatoren
4. **Multi-Stage Docker**: Build-Stufe kompiliert, Production-Image enthält nur Artefakte
5. **Signalverträge**: versionierte SQLite-Datensätze, verwaltet im visuellen Builder
6. **Workflow-Control-Plane**: Kanäle → Filter → Parser → Schema → Vertrag → Strategie → Sizing → Risiko → Konto → Ausgabe
7. **MCP-Agenten**: separater Dienst, gehashte Tokens, Minimalrechte, auditierter Kontrollbrücken-Zugriff
8. **Supply Chain**: Quelle nur auf `main`, CI baut und scannt jeden Stand

---

## 🚀 Schnellstart: vollständig über Docker und Web-UI

Voraussetzung ist Docker Desktop oder Docker Engine mit Docker Compose 2.24 oder neuer. Eine lokale Node.js-Installation, `.env`, `config.json`, manuell angelegte Ordner und eine Terminal-Anmeldung bei Telegram sind für die normale Nutzung nicht erforderlich.

1. Repository auschecken, einen einmaligen Container-Bootstrap-Nachweis erzeugen und den Dienst starten (PowerShell):

   ```powershell
   $bytes = [byte[]]::new(32)
   [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
   $env:DASHBOARD_BOOTSTRAP_PROOF = [Convert]::ToHexString($bytes).ToLowerInvariant()
   $env:DASHBOARD_BOOTSTRAP_PROOF
   docker compose up --build -d
   ```

   `--build` ist auch nach jedem erneuten Download oder `git pull` erforderlich. Ein bloßes `docker compose up -d` darf ein bereits vorhandenes lokales Image weiterverwenden und würde dann eine ältere Oberfläche ausliefern. Persistente Volumes bleiben beim Neubau erhalten.

2. `http://127.0.0.1:8080` öffnen, den eben ausgegebenen Nachweis eingeben und **Create secure dashboard** wählen. Erst diese bewusste Erststartaktion erzeugt serverseitig einen starken dauerhaften Admin-Bearer-Token und zeigt ihn genau einmal zum Kopieren und sicheren Hinterlegen an. Der Bootstrap-Nachweis wird danach verbraucht. Vor diesem sichtbaren Schritt wird keine lokale Sitzung erzeugt; ein späterer Session-Token verlangt erneut den dauerhaften Admin-Bearer und wird nie allein aufgrund von Browser-Headern ausgegeben.
3. Im Builder **Betrieb → System** öffnen, Telegram API ID und den 32-stelligen API Hash sowie bei KI-Nutzung den OpenRouter-Key write-only speichern. Dort auch das Routing starten. Telefon, Telegram-Code, E-Mail-Code und optionale 2FA werden ausschließlich im Web-Dialog abgefragt und nicht persistiert.
4. Über **Baustein** einen Kanal, Filter, Parser, Schema, Vertrag, Strategie, Positionsgröße und Börsenkonto erstellen oder eine veröffentlichte Version wiederverwenden. Die Karten von links nach rechts verbinden. Erst vollständige Pfade sind ausführbar; ein Kanal darf in mehrere Kontopfade verzweigen. Alternativ lassen sich Kontobausteine als exklusive Reihenfolge verbinden: Das nächste Konto wird nur versucht, wenn das Handelspaar auf dem vorherigen Konto eindeutig nicht verfügbar ist.
5. Unter **Betrieb → Konten** Paper, Hyperliquid, Bybit oder Kraken Futures anlegen, das kontoweite Positionslimit setzen und das Konto prüfen. Danach unter **Betrieb → Live** reconciliieren und die Ausführung bewusst aktivieren.
6. Betriebszustand prüfen:

   ```bash
   docker compose ps
   curl --fail http://127.0.0.1:9100/healthz
   curl --fail http://127.0.0.1:9100/readyz
   docker compose logs -f forwarder
   ```

`healthz` darf bereits während der Einrichtung grün sein; `readyz` wird erst nach vollständiger Konfiguration, Telegram-Anmeldung und aktivem Routing grün. Der dauerhafte lokale Admin-Token bleibt im Secret-Volume gültig und wird daraus niemals erneut an den Browser zurückgegeben. Bei aktiviertem Compose-Local-Trust ersetzt ein automatisch erzeugter, pro Prozess begrenzter Session-Token die manuelle Bearer-Eingabe. Remote-Zugriffe erhalten diesen Vertrauenspfad nicht und benötigen Tailscale-Identity, OIDC oder einen explizit verwalteten Bearer-Key. Zusätzliche Admin- und read-only Viewer-Bearer-Keys werden unter **System & Backup → API- und Bearer-Keys** erzeugt, rotiert oder deaktiviert und jeweils nur einmal angezeigt.

Im Standalone-Modus verwendet das Dashboard integrierten lokalen Zugriff, verkettete Audit-Logs und verifizierte lokale Backups. Sämtliche Runtime-/Enterprise-Parameter – OIDC, externe Origin, Remote-Audit, verschlüsselte Off-site-Backups, Retention, Kapazitätsgrenzen und Timeouts – werden unter **Betrieb → System** gespeichert und über **Kontrolliert neu starten** aktiviert. Enterprise-Modus erzwingt OIDC, deaktiviert Local Trust und verlangt unveränderlichen Remote-Audit-Trail sowie verschlüsselte, rücklesbar verifizierte Off-host-Backups.

### Leerer Auslieferungszustand und vorhandene Docker-Volumes

Repository und Container-Image liefern ausschließlich Programmfunktionen und leere Tabellen aus. Beim echten Erststart sind Ausführung, Live-Trading und der MCP-Laufzeitmodus deaktiviert; Kanäle, Konten, Paper-Bilanzen/-Märkte, Verträge, Signal-Schema-Profile, Strategien, Routen, Trades, Journal und MCP-Agenten sind leer. Auch `config.json.example` enthält keine Beispielkanäle und aktiviert den KI-Parser nicht.

Benannte Docker-Volumes gehören nicht zum GitHub-Download und überleben einen neuen Download, `git pull`, Image-Neubau sowie `docker compose down`. Wenn beim Start einer erneut heruntergeladenen Kopie alte Inhalte oder ein bereits vorhandener Admin-Token erscheinen, stammt dieser Zustand aus einem weiterverwendeten Docker-Volume und nicht aus GitHub. Für einen sicheren Total-Reset bevorzugt **System & Backup → Factory Reset** verwenden. Nur wenn der alte Dienst nicht mehr bedienbar ist und sämtliche lokalen Daten ausdrücklich verworfen werden sollen:

```bash
docker compose down -v
docker compose up --build -d
```

`down -v` löscht Konfiguration, Secrets und Bearer-Token, Telegram-Sitzung, SQLite/Trading-Historie, Signale, Logs und lokale Backups unwiederbringlich. Danach beginnt der sichtbare Token-Erststart und der fachliche Bestand ist vollständig leer.

### Trading vollständig im Web einrichten

1. Eine neue Installation enthält **keine** Konten, Paper-Bilanz, Signalverträge, Signal-Schema-Profile, Strategien, Workflows, Kanäle oder MCP-Agenten. Im Builder werden alle fachlichen Objekte als Bausteine erstellt oder aus der Bibliothek wiederverwendet.
2. Ein vollständiger Pfad lautet grundsätzlich `Kanal → Filter → Parser → Schema → Vertrag → Strategie → Sizing → optional adaptives Risiko → Konto → optional Ausgabe`. Direkte Kanten dürfen Stufen überspringen; die erforderlichen Typen müssen im Pfad trotzdem vorhanden sein. Unvollständige Pfade bleiben inert.
3. Unter **Betrieb → Konten** Hyperliquid, Bybit oder Kraken Futures wählen, Testnet/Live bestimmen und die Keys eingeben. Paper Trading ist optional und benötigt eine eigene Startbilanz. Zugangsdaten werden nie zurückgelesen. Withdrawal-Rechte sind nicht erforderlich und dürfen nicht vergeben werden.
4. Das maximale Positionslimit von 1 bis 20 wird am Börsenkonto festgelegt und umfasst alle Strategien, Kanäle und Workflowpfade dieses Kontos. Ein Kanal kann gleichzeitig zu mehreren Konten führen; jeder Zweig darf eigenes Sizing und eigenes adaptives Risiko besitzen.
5. Unter **Betrieb → Live** zuerst alle aktivierten Konten reconciliieren und dann die automatische Ausführung aktivieren. Für Echtgeld muss einmal exakt `ENABLE LIVE TRADING` bestätigt werden. Danach läuft jeder vollständige, freigegebene Pfad ohne Einzelapproval.
6. **Betrieb → Journal/Analyse/Logs** zeigt Intents, Positionen, Entries, TP/SL/Flatten-Orders, Fills, Risk Events, Kanal-/Börsenleistung und Reconciliation. Unknown Orders, fremde Positionen oder fehlender Protective Stop sperren neue Entries fail-closed.

Private Order-, Trade- und Positions-Streams sowie öffentliche Marktdaten von Hyperliquid, Bybit und Kraken Futures laufen über CCXT Pro. Zustandsändernde Events lösen unmittelbar einen erzwungenen Exchange-Abgleich aus; ausschließlich der danach über CCXT REST gelesene Snapshot darf lokalen Trading-Zustand ändern. Cursor-Lücken oder Stream-Ausfälle markieren den Stream als degradiert, lassen die periodische REST-Schutzschleife aber unverändert aktiv.

Die Anwendung führt keinen beliebigen in der UI eingegebenen Code aus. Strategien, Verträge und Workflows sind strikt validiert und versioniert; ein grundlegend anderer Algorithmus benötigt eine getestete Engine-Version. Exchange-Zugriffe laufen ausschließlich über das interne, nicht am Host veröffentlichte CCXT-Sidecar. CCXT ist exakt gepinnt; ein Upgrade benötigt erneut Contract-, Testnet- und Reconciliation-Nachweise.

Die Strategie bestimmt pro Kanalroute, ob **alle**, **keine** oder nur eine explizite Liste normalisierter Symbole gehandelt werden darf. Bei **Alle** entscheidet die ausgewählte Börse verbindlich über Marktverfügbarkeit; unbekannte oder nicht handelbare Symbole werden vor einer Order abgewiesen.

### Bedienoberfläche

- **Workflow-Arbeitsfläche**: spaltenweise Karten, typisierte Verbindungen, Suche, Mini-Map, Trockenlauf und atomare Revisionen. Ein Klick auf eine Karte öffnet ihren vollständigen Editor.
- **Betrieb → Live/Konten**: Kill-Switch, Execution-/Live-/Paper-Zustand, kontoübergreifende Limits, Reconciliation, Zugangsdaten-Rotation und Notfallaktionen.
- **Betrieb → Analyse/Journal**: Equity, Drawdown, tägliche/wöchentliche Auswertung, Kanalranking, Slippage-/Börsenvergleich, Latenz sowie filterbare Trade-Provenienz.
- **Adaptives Risiko als Pfadbaustein**: gestaffelte Prozentwerte, Lookback, Mindest-Trades, Gewinn-/Verlustschwellen, automatische Reduktion/Sperre und manuelle Sperre. Zustand und Performance werden pro Kanal, Konto und logischem Baustein geführt.
- **Logs**: zusammenhängender Live-Terminalstrom mit 20.000 Zeilen Ringpuffer, Freitext-/Regex-Suche und virtueller Darstellung; keine Level-Filter zerreißen Abläufe.
- **Betrieb → Backups/MCP/System**: Restore, Agentenrechte/-Vorschläge, Telegram-Anmeldung, Remote-Zugriff, Secrets und Enterprise-Parameter bleiben im selben Interface erreichbar.

### Sicherer Remote-Zugriff und MCP

Für WLAN/VPN ist **Tailscale Serve** der bevorzugte Weg. Dashboard und MCP bleiben auf Host-Loopback; Serve veröffentlicht sie nur im Tailnet. **Tailscale Funnel ist verboten**, weil es einen öffentlichen Internet-Endpunkt erzeugt. Im Dashboard-Authentifizierungsmodus `tailscale` akzeptiert TSX Core ausschließlich die von einem ausdrücklich vertrauten lokalen Serve-Proxy gelieferten Identitätsheader und ordnet Login-Adressen einer Admin- oder Viewer-Allowlist zu. `scripts/configure_tailscale_serve.ps1` deaktiviert Funnel für den Zielport und richtet Serve auf den Loopback-Dienst ein.

Der MCP-Dienst startet automatisch als dritter, gehärteter Service. Seine fachliche Schnittstelle ist bei einer neuen oder zurückgesetzten Installation jedoch sicher **deaktiviert**:

```bash
docker compose up --build -d
curl --fail http://127.0.0.1:8091/healthz
```

Unter **MCP-Agenten** schaltet der Admin den persistenten Servermodus auf **Aktiv**, **Standby** oder **Deaktiviert**. Aktiv nimmt Sitzungen und Tool-Aufrufe an. Standby beendet Sitzungen und pausiert Warteschlangen bei laufendem, schnell reaktivierbarem Dienst. Deaktiviert beendet Sitzungen und verwirft zusätzlich noch nicht gestartete freigegebene Aktionen. Jeder Moduswechsel wird auditiert und überlebt Container-Neustarts. Für jeden Agenten wird ein Token genau einmal ausgegeben. TSX Core speichert nur SHA-256, zeigt aktive Sitzungen und protokolliert jeden Tool-Aufruf. Rechte und Ereignis-Abonnements gelten dauerhaft, bis ein Admin sie ändert, den Agenten deaktiviert, löscht oder den Token rotiert. Vertrags-, Profil-, Strategie-, Routing- und Risikoänderungen erhalten vorab einen Preflight; sicherheitsrelevante Varianten landen als persistente Vorschläge in der Freigabe-Warteschlange und werden erst nach expliziter Admin-Entscheidung ausgeführt. **Agent löschen** widerruft Token, Rechte, Sitzungen und wartende Kontrollanforderungen sofort; die anonymisierte Audit-Historie bleibt erhalten. Details und Client-Beispiel: [`docs/MCP_GUIDE.md`](docs/MCP_GUIDE.md).

### Zustellgarantie und Recovery

Jede eingehende Telegram-Nachricht wird über `(chat_id, message_id)` dedupliziert und vor der Verarbeitung als SQLite-Outbox-Task persistiert. Zustände laufen über `pending → preparing → sending → completed`; `completed` wird erst nach `updateMessageSendSucceeded` beziehungsweise einer bereits bestätigten TDLib-Antwort gesetzt. Nach einem Prozessabbruch werden Tasks aus `preparing` automatisch sicher fortgesetzt. Tasks aus `sending` wechseln dagegen auf `unknown`, weil ein automatischer Retry eine bereits zugestellte Nachricht duplizieren könnte.

Ungeklärte Zustellungen sind authentifiziert abrufbar:

```bash
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  "http://127.0.0.1:8080/api/outbox?status=failed,unknown"
```

Ein Retry ist eine explizite Risikoentscheidung und benötigt den Admin-Token sowie `X-Destructive-Confirmation: retry-unknown-delivery`. Wurde die Zustellung im Zielkanal nachweislich gefunden, kann der Task mit Begründung über `/api/outbox/acknowledge` und `X-Destructive-Confirmation: acknowledge-unknown-delivery` abgeschlossen werden. Beide Aktionen werden mit Request-ID, Rolle, Pfad und HTTP-Status im Audit-Log erfasst.

Bei `SIGTERM`, `SIGINT`, Dashboard-Stopp oder interaktivem Neustart wird die Queue zuerst pausiert, wartende In-Memory-Einträge werden verworfen (sie bleiben in SQLite `pending`), laufende Jobs erhalten ein Abort-Signal und der Prozess wartet bis zu `SHUTDOWN_GRACE_MS` (Standard 30 Sekunden) auf deren tatsächliches Ende. Erst danach werden TDLib, HTTP-Server und SQLite geschlossen. Läuft die Frist ab, bleibt der Routing-Lock als Recovery-Signal bestehen; ein neuer Routing-Start im selben Prozess wird verweigert.

Nach drei unerwarteten Abbrüchen innerhalb von fünf Minuten legt der Dienst `session_data/.crash_blocked` an und startet das Routing auch außerhalb des Zeitfensters nicht automatisch. Vor einer Freigabe müssen Operatoren die Ursache aus den Logs und Outbox-Zuständen klären und erst danach `.crash_blocked` sowie gegebenenfalls `.routing_active` entfernen. Das Löschen dieser Dateien ohne Ursachenklärung ist kein zulässiger Recovery-Schritt.

### Backupnachweise und Restore (lokales Snapshotziel 15 Minuten)

Beim Prozessstart und im konfigurierten Intervall von höchstens 15 Minuten plant der Dienst unter `BACKUP_DIR` ein atomar veröffentlichtes Artefakt: SQLite-Online-Snapshot plus gepinnte gemeinsame Generation der nicht geheimen Konfiguration, Runtime-Einstellungen und Templates. Checksummen, `PRAGMA integrity_check`, Pflicht-Tabellen und Secret-Ausschluss werden vor Veröffentlichung geprüft; Fehler setzen Readiness und `tg_forwarder_backup_healthy` auf Fehler. Standardmäßig werden 672 Artefakte aufbewahrt. Das Intervall ist ein Snapshotziel, keine garantierte RPO für wiederherstellbaren Tradingzustand; die Health-Toleranz beträgt zwei Intervalle, Ziel-RTO 60 Minuten bleibt operativ zu messen.

CLI und Status unterscheiden `integrityVerified`, `configurationCoherent`, `offsiteVerified`, `restoreEligibility` (`eligible`/`blocked`/`unknown` mit Gründen, Scope ausschließlich `artifact-local-integrated-restore`) und den tatsächlich durchgeführten `restoreDrill` mit Datum/Artefakt-SHA. Jede Kategorie hat ihre eigene letzte Nachweiszeit. Offsite-Erfolg ist kein Probelauf; ein intaktes Backup mit offenen/verbliebenen Tradingverpflichtungen ist nicht restore-eligible. Sind nur ältere Snapshots eligible/verfügbar, besteht keine belegte 15-Minuten-Recovery für Trading. Einzelheiten und Grenzen: [ADR 0004](docs/adr/0004-verified-backup-recovery.md).

Im Web unter **System & Backup → Enterprise Operations** können Operatoren Backups sofort erzeugen, vorhandene Artefakte auswählen, vollständig verifizieren und nach Eingabe von `RESTORE` wiederherstellen. Der Dienst stoppt dabei Routing und Scheduler, schließt SQLite, bewahrt den ersetzten DB-/Config-Stand als Rollback auf und startet den Container kontrolliert neu. Die folgenden Befehle bleiben nur als Break-glass-Alternative erhalten.

Manuelle Prüfung und Wiederherstellung im Docker-Betrieb (`<artifact-name>` durch den Verzeichnisnamen im Backup-Volume ersetzen):

```bash
# Online: „Backup jetzt“ im Dashboard. CLI-create benötigt exklusiven Prozessbesitz.
docker compose exec -T forwarder /nodejs/bin/node -e "const fs=require('fs');const names=fs.readdirSync('/app/backups').filter(name=>name.startsWith('backup-')).sort();console.log(names.at(-1)||'no backup found')"
docker compose exec -T forwarder /nodejs/bin/node dist/backup_cli.js verify /app/backups/<artifact-name>
# Expliziter isolierter Probelauf in eigenem temporären Verzeichnis; keine Trading-Runtime:
docker compose exec -T forwarder /nodejs/bin/node dist/backup_cli.js drill /app/backups/<artifact-name>

# Dienst vollständig stoppen und failed/unknown Zustellungen dokumentieren.
docker compose down
docker compose run --rm --no-deps --entrypoint /nodejs/bin/node forwarder dist/backup_cli.js restore /app/backups/<artifact-name>
docker compose up -d

# Dienst starten, /readyz und Outbox prüfen, dann einen synthetischen End-to-End-Flow ausführen.
```

Restore verweigert die Ausführung, solange `.process_active` oder `.routing_active` im State-Verzeichnis existiert. Ein nach hartem Prozessabbruch veralteter Lock darf erst entfernt werden, nachdem auf Betriebssystemebene bestätigt wurde, dass kein Forwarder-Prozess mehr läuft und die Outbox reconciled ist. Bestehende DB und Konfiguration werden nicht gelöscht, sondern als `.pre-restore-*` für einen unmittelbaren Rollback erhalten.

Die Backup-Artefakte enthalten Nachrichten-, Signal- und damit potenziell personenbezogene Daten. Im Enterprise-Modus ist Off-host-Replikation deshalb zwingend. Das Web-Feld `backupOffsiteUrlTemplate` bezeichnet einen HTTPS-Objektendpunkt, der authentifizierte `PUT`- und `GET`-Anfragen auf demselben, durch `{artifact}` parametrisierten Pfad unterstützt; Bearer-Token und 32-Byte-AES-Schlüssel werden unter **System & Backup → Enterprise-Secrets** write-only gespeichert.

Jedes lokale Artefakt wird vor dem Upload geprüft, als begrenztes internes Archiv mit AES-256-GCM verschlüsselt und hochgeladen. Anschließend lädt der Dienst exakt dieses Objekt wieder herunter, vergleicht SHA-256 und Länge, authentifiziert und entschlüsselt es und führt erneut SQLite-Integritäts-, Tabellen-, Manifest- und Secret-Prüfungen aus. Erst dann entsteht ein eigener Offsite-Nachweis, gebunden an den Manifest-SHA der zurückgelesenen Kopie; lokale Integritätsnachweise und deren Zeit bleiben davon unabhängig. Dies erzeugt keinen Restore-Drill und belegt keine heutige Börsenflatheit. Der Verschlüsselungsschlüssel muss getrennt vom Backup-Store aufbewahrt werden; lokale Artefakte oder ein nicht zurücklesbarer Upload erfüllen Disaster Recovery nicht.

Nach Verlust des lokalen Backup-Volumes wird der im Backup-/Audit-Status vermerkte `.tgfb`-Objektname unter **System & Backup → Enterprise Operations → Off-site-Backup abrufen** eingegeben. Die Control Plane lädt, entschlüsselt und verifiziert das Objekt und stellt es erst danach in der lokalen Restore-Auswahl bereit. Der AES-Schlüssel ist nach der ersten Speicherung absichtlich unveränderlich; eine Rotation ohne Keyring würde ältere Generationen zerstören.

### Daten-Retention und Kapazität

Operative Daten werden standardmäßig 90 Tage aufbewahrt. Die Retention löscht ausschließlich alte `completed`-Outbox-Einträge, final `processed`/`filtered` Inbox-Nachrichten, nicht mehr von ungeklärten Tasks referenzierte Signale und alte AI-Budgettage. `pending`, `preparing`, `sending`, `failed` und `unknown` werden nie automatisch entfernt. Die Arbeit läuft in begrenzten Batches; ein nicht abarbeitbarer Rückstand oder weniger als `DATA_MIN_FREE_BYTES` freier Speicher setzt Readiness auf Fehler.

Konfiguration: `DATA_RETENTION_DAYS`, `DATA_RETENTION_INTERVAL_MS`, `DATA_RETENTION_BATCH_SIZE` und `DATA_MIN_FREE_BYTES`. Prometheus exportiert Retention-Zustand, gelöschte Zeilen, SQLite-Belegung, wiederverwendbare Seiten und freien Speicher. Eine Änderung der Aufbewahrungsfrist benötigt Data-Owner-Freigabe und muss mit der Off-host-Backup-Retention konsistent sein.

### Datenbank-Migration und Binary-Rollback

Das Schema wird über eine lückenlose, checksum-geschützte `schema_migrations`-Historie aktualisiert. Jede Migration läuft in einer eigenen SQLite-Transaktion; neuere, manipulierte oder lückenhafte Historien blockieren den Start. Vor Änderungen an einer bestehenden Datenbank erzeugt der Prozess unter `session_data/.migration-backups/` automatisch einen integritätsgeprüften Snapshot.

Aktuelle Migrationen sind zum vorherigen Binary additiv kompatibel. Falls ein späteres Release einen DB-Downgrade verlangt, wird der Dienst inklusive aller Nebeninstanzen gestoppt, `failed`/`unknown` dokumentiert und der im Release-Record benannte Snapshot explizit wiederhergestellt:

```bash
docker compose down
docker compose run --rm --no-deps --entrypoint /nodejs/bin/node forwarder dist/migration_cli.js restore \
  /app/session_data/.migration-backups/pre-migration-....db --confirm-restore-pre-migration
docker compose up -d
```

Das Kommando verweigert aktive Prozess-/Routing-Locks, prüft den Snapshot und bewahrt die ersetzte Datenbank samt WAL/SHM für Forensik. Anschließend darf nur das zum alten Schema passende Rollback-Image gestartet werden.

### Automatische KI-Signalverarbeitung

Die Signalverarbeitung arbeitet ohne Human-in-the-loop. Ein Ergebnis darf jedoch nur automatisch weitergeleitet werden, wenn es exakt dem für die Quelle festgelegten Schema entspricht und alle Zahlen-, Wertebereichs-, Reihenfolge- und LONG/SHORT-Geometrieprüfungen besteht. Markdown, XML-Deklarationen, unbekannte Tags, nicht sequenzielle Targets, abgeschnittene Modellantworten und Text außerhalb des XML-Dokuments werden fail-closed abgewiesen; unbekannte oder nicht lesbare Template-Dateien fallen nicht still auf den Standardprompt zurück.

Da die vollständige Quellnachricht an OpenRouter übertragen wird, muss der Operator einmalig unter **Signale & Nachrichten → KI-Parser** die Option **Externe Datenverarbeitung freigegeben** aktivieren und damit Data-Owner-Freigabe, Rechtsgrundlage und Providervertrag für sämtliche konfigurierten Quellen bestätigen. Ohne diese Konfigurationsfreigabe bleiben AI-Aufrufe und daraus folgende Side Effects blockiert; eine Laufzeitfreigabe pro Nachricht gibt es weiterhin nicht.

`xmlParsing.aiLimits` begrenzt Eingabelänge, Ausgabetokens, sichtbare Primär-/Fallback-Versuche, Request-Timeout, Backoff sowie Requests und reservierte Tokens pro UTC-Tag. Die SDK-internen Retries sind deaktiviert. Das Tagesbudget wird vor jedem Provider-Aufruf atomar in SQLite reserviert; ein abgebrochener oder hinsichtlich der Provider-Nutzung unklarer Aufruf wird konservativ mit seiner Reservierung verbucht. Ein Prozessabbruch kann deshalb bis zum nächsten UTC-Tag Kapazität blockieren, gibt aber nie unbewiesen Budget frei.

Zu jedem akzeptierten Signal speichert SQLite Template, Schemaname, SHA-256 des wirksamen Prompts, tatsächliches Modell, Provider-Request-ID, Tokenverbrauch und Parser-Version. Prompts oder vollständige Modell-Denkwege werden nicht geloggt. `OPENROUTER_API_KEY` bleibt ausschließlich in der Prozessumgebung.

Telegram-Eingang, Originalnachricht und Klassifizierungsauftrag werden gemeinsam mit der zu diesem Zeitpunkt aktiven Workflowrevision in einer SQLite-Transaktion gespeichert. Filter, Prompt, Schema, Vertrag, Strategie und Risikoeinstellungen bleiben für diesen Eingang gepinnt; aktuelle Ausführungsfreigaben und Kontosperren gelten trotzdem. Albumteile werden nach Telegram-Nachrichten-ID dedupliziert. Klassifizierungs-Fanout und Albumabschluss erzeugen ihre Folgeaufträge atomar. Altbestand ohne eindeutige Provenienz erhält `needs_review` und wird nicht automatisch nachgehandelt oder weitergeleitet.

Signale sind unter ihrer fachlichen ID unveränderlich; identische Wiederholungen erhalten Originalzeit und Provenienz, widersprüchliche Wiederholungen benötigen Review. Parserattempts werden separat protokolliert. Jeder echte AI-Aufruf erhält eine eigene Reservierungs-ID. Identisches Settlement derselben ID ist wirkungslos; widersprüchliche Abrechnung wird abgewiesen. Eine verlorene Commitantwort wird ohne neuen Provideraufruf unter derselben ID geprüft. Ungeklärte alte Reservierungen bleiben als Auditposition erhalten, belasten aber nicht den neuen UTC-Tag; Retention entfernt sie nicht. Diese Garantien betreffen die lokale Verarbeitung, nicht mathematisches Exactly-once externer Provideraktionen.

Vor einem Modell-, Prompt- oder Template-Release muss mit Staging-Zugang `npm run test:ai-eval` ausgeführt werden. Das Gate vergleicht normale, schemaspezifische und adversariale Fälle aus `tests/fixtures/signal_golden_set.json` mit den freigegebenen Ergebnissen und schlägt bei jeder Abweichung oder unerwarteten Annahme fehl. Der normale Offline-Testlauf ruft keinen externen KI-Provider auf.

### Docker-Betrieb und persistente Daten

Der Container läuft als unprivilegierter Benutzer mit schreibgeschütztem Root-Dateisystem, ohne Linux-Capabilities und mit CPU-, RAM-, PID- und Log-Grenzen. Compose initialisiert benannte Volumes für Konfiguration, Secrets, Templates, TDLib-Sitzung, SQLite, Signale, Logs und Backups; Updates und normale Container-Neuerstellungen erhalten diese Daten.

Der Standardstart erzeugt genau drei Services: `forwarder` besitzt Telegram, Dashboard, Trading-Zustand und Sicherheitslogik; `exchange-executor` kapselt die offiziellen Python-SDKs und besitzt keinen Host-Port; `mcp-server` stellt den unabhängig schaltbaren Agenten-Endpunkt bereit. Diese Prozessgrenzen halten native Exchange-Abhängigkeiten und deren Credentials aus der Node-Control-Plane heraus. Der MCP-Dienst teilt nur das SQLite-State-Volume, besitzt weder Telegram- noch Exchange-Secrets und bleibt in der Werkseinstellung logisch deaktiviert.

```bash
# Start oder Update
docker compose up --build -d

# Status und Logs
docker compose ps
docker compose logs --tail=200 forwarder

# Kontrolliert stoppen; persistente Volumes bleiben erhalten
docker compose down

# Volumes niemals mit -v löschen, sofern kein bewusst bestätigter Total-Reset beabsichtigt ist.
docker volume ls --filter name=tsx-core_forwarder
```

Dashboard, Metriken und der MCP-Port werden ausschließlich auf Host-Loopback veröffentlicht. Externer Zugriff erfolgt bevorzugt über Tailscale Serve oder alternativ einen authentifizierenden TLS-Reverse-Proxy. Compose verwendet `restart: unless-stopped`, damit ein kontrollierter Web-Neustart und ein Factory Reset den Dienst automatisch wieder in Betrieb nehmen; der persistente MCP-Modus bleibt dabei erhalten und wird beim Factory Reset wieder auf `disabled` gesetzt. Die anwendungsinterne Crash-Loop-Sperre verhindert trotzdem unkontrolliertes Routing nach wiederholten Fehlern. Das lokale Backup-Volume allein ist kein Enterprise-DR-Nachweis.

Incident-URL, internes Relay-Token und Incident-Gateway-Token werden vollständig im Web unter **System & Backup → Vollständige Runtime- und Enterprise-Konfiguration** beziehungsweise **Enterprise-Secrets** gesetzt. Danach startet `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d` den Monitoring-Stack; Alertmanager und Relay lesen ausschließlich die verwalteten Config-/Secret-Volumes, nicht `.env` oder Host-Secret-Dateien. Prometheus verwendet einen unveränderlichen Multi-Arch-Digest. Alertmanager 0.33.1 wird lokal reproduzierbar aus dem verifizierten Upstream-Commit mit checksum-geprüften Quellen, Go 1.26.6 und gepatchten Go-Modulen in eine digest-gepinnte Distroless-Non-Root-Runtime gebaut. CI baut und scannt die `linux/amd64`- und `linux/arm64`-Kandidaten ohne VEX-Ausnahmen; eine Registry-Veröffentlichung erfolgt nicht automatisch. Beide Dienste speichern 30 Tage Metriken beziehungsweise fünf Tage Alertmanager-Zustand und veröffentlichen ihre UIs nur auf Host-Loopback.

---

## 📊 Monitoring & Log-Konfiguration

Diese Parameter werden im Docker-Standardbetrieb unter **System & Backup → Vollständige Runtime- und Enterprise-Konfiguration** gesetzt; die lokale `.env` wird nicht in den Container injiziert:

```env
# Schaltet die Logausgabe auf strukturiertes JSON um (perfekt für Docker/Kubernetes)
JSON_LOGGING=true  # Web-Feld: jsonLogging

# Interner Metrik-Port und Bind-Adresse bleiben durch Compose sicher vorgegeben.
METRICS_PORT=9100
METRICS_HOST=0.0.0.0
```

### Abrufen der Metriken
* **Liveness**: `curl http://localhost:9100/healthz` -> HTTP 200, solange der Prozess HTTP-Anfragen bedienen kann.
* **Readiness**: `curl http://localhost:9100/readyz` -> HTTP 200 nur bei erreichbarer SQLite-Datenbank, aktiver Telegram-Verbindung, laufendem Routing und nicht pausierter Queue; andernfalls HTTP 503 mit Einzelchecks.
* **Prometheus Scraping**: `curl http://localhost:9100/metrics`
  * Liefert bestätigte Zustellungen, Queue- und Outbox-Zustände einschließlich `failed`/`unknown`, Telegram-Verbindungszustand, letzten bestätigten Zustellzeitpunkt, Tagesverbrauch/-reservierung der KI sowie echte Prozess-RAM-/Uptime-Werte.

Die Dashboard-Historie zeigt ausschließlich gemessenen Durchsatz, Queue, CPU und RAM. Die frühere aus HTTP-Latenz und Zufall abgeleitete angebliche Internet-Bandbreite wurde entfernt, da sie keine belastbare Betriebsmetrik war. Die versionierten Regeln unter `monitoring/` alarmieren auf fehlende Metriken, unbekannte/fehlgeschlagene Zustellungen, DB-/Telegram-Ausfall, Backup-/Retention-/Disk-Probleme und Queue-Rückstau. `npm run quality:monitoring` validiert Prometheus, Alertmanager und die Regeltests mit gepinnten Tool-Images.

### Manipulationsnachweis und externer Audit-Trail

Mutierende Dashboard-Aufrufe werden vor ihrer Nebenwirkung synchron in `logs/audit-chain.jsonl` geschrieben, auf den Datenträger synchronisiert und über SHA-256 mit dem vorherigen Record verkettet. Der Record enthält Request-ID, pseudonyme Actor-ID, Rolle, Methode, Pfad und Abschlussstatus, aber weder Bearer-Token noch Request-Body. Eine beim Start beschädigte Kette blockiert den Dienst; das lokale 64-MiB-Limit blockiert weitere Mutationen, statt unkontrolliert zu wachsen.

Im Enterprise-Modus sind zusätzlich `auditWebhookUrl` und das write-only Secret `auditWebhookToken` Pflicht. Der HTTPS-Endpunkt darf erst 2xx antworten, nachdem der Record außerhalb des Forwarder-Hosts unveränderlich und gemäß Unternehmens-Retention gespeichert wurde. Ist die Vorabzustellung nicht beweisbar, antwortet die Control Plane mit 503 und führt die Mutation nicht aus; spätere Zustellfehler setzen Readiness und `tg_forwarder_audit_healthy` auf rot. Remote-Audit kann im Enterprise-Modus nicht deaktiviert werden.

Nach einem Gateway-Ausfall wird die lokale Kette zuerst mit `npm run audit:verify` geprüft und anschließend im gestoppten Zustand mit `npm run audit:replay -- --confirm-audit-replay` vollständig und idempotent nachgeliefert. Der Gateway muss bereits bekannte Hashes akzeptieren und bei gleichem Hash mit abweichendem Inhalt fail-closed ablehnen.

Nach jedem neuen Incident-Empfänger und mindestens monatlich wird eine echte Testalarmierung ausgelöst:

```bash
npm run ops:test-alert -- --confirm-alert-delivery
```

Der ausgegebene `correlation_id` muss im externen Incident-System nachgewiesen und im Release-/Übungsrecord abgelegt werden. Eine HTTP-Annahme durch Alertmanager allein ist kein Zustellnachweis.

### Staging-E2E und 30-Tage-Produktionsnachweis

Die Workflows `staging.yml` und `synthetic.yml` benötigen einen isolierten Self-hosted Runner mit den Labels `self-hosted, staging`, einen bereits authentifizierten technischen Telegram-Account, zwei ausschließlich dafür verwendete Chats sowie getrennte TDLib-Verzeichnisse. Der Test sendet eine eindeutig korrelierte Fixture in den Quellchat, wartet auf die reale Weiterleitung und akzeptiert im Zielchat exakt eine Kopie. Das Evidence-Artefakt enthält IDs, Zeitpunkte, Latenz und Inhalts-Hashes, aber keinen Nachrichteninhalt. Interaktive Anmeldung und die Wiederverwendung der Produktions-Session werden abgewiesen.

Ein zweiter, read-only Self-hosted Runner mit den Labels `self-hosted, production-observer` kann ein vollständiges 30-Tage-Fenster aus Prometheus prüfen. Bis solche Runner eingerichtet sind, sind Staging-, Synthetic- und 30-Tage-Workflows ausschließlich manuell auslösbar. Für echten Produktionsbetrieb muss ein externer Scheduler den Observer täglich und den Synthetic-Monitor alle 15 Minuten starten sowie ausgebliebene Läufe alarmieren. `npm run ops:soak` fordert mindestens 99,5 % Scrape-Verfügbarkeit und bestätigte Zustellung, P95 unter 60 Sekunden, mindestens 100 Zustellversuche, keine unbekannte Zustellung, durchgehend gesunde Backups/Retention/Disk sowie begrenzte Queue und RAM. `PROMETHEUS_URL` muss HTTPS verwenden (Loopback ausgenommen), das optionale Bearer-Token kommt aus `PROMETHEUS_TOKEN[_FILE]`.

Die Quelle wird direkt und ausschließlich über `main` veröffentlicht. `.github/workflows/quality.yml` besitzt keine Release-Credentials und prüft den veröffentlichten Commit mit Tests, Coverage, Mutation, Browser-/WCAG-Gates, SAST, Secret-Scan, SBOM und Container-Scans. Staging- und Langzeitnachweise bleiben separate Betreiberprüfungen; fehlende Runner, Provider-Zugänge oder Messwerte gelten nicht als bestanden. Die Betriebsdetails stehen in `docs/runbooks/operations.md`.

---

## 🧪 Tests ausführen

Für Quellcode-Verifikation werden Node.js 22 und npm 10.9 verwendet. Der vollständige lokale Kernlauf lautet:

```bash
npm ci --no-audit --no-fund
npm ci --prefix frontend --no-audit --no-fund
npm run typecheck
npm run lint
npm run lint:frontend
npm run lint:python
npm test
npm run test:coverage
npm run test:coverage:modules
npm run build
```

Mutation, Browsermatrix, Container/SBOM/Vulnerability, Secret-History und CodeQL laufen zusätzlich im GitHub Quality Workflow. Die vollständige Gate-Matrix und kontextabhängigen Befehle stehen in [`docs/QUALITY_OS.md`](docs/QUALITY_OS.md) und [`docs/PRODUCTION_GUIDE.md`](docs/PRODUCTION_GUIDE.md).
