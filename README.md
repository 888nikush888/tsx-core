# TSX Core

**TSX Core** ist eine robuste TypeScript-Control-Plane für Telegram-Nachrichtenweiterleitung auf Basis der offiziellen **TDLib** (Telegram Database Library), ergänzt um ein internes Python-Sidecar ausschließlich für die offiziellen Hyperliquid-/Bybit-SDKs. Der Node.js-Dienst leitet Nachrichten aus Quellkanälen automatisch an einen Zielkanal weiter und kann validierte Signale kontrolliert in Trades überführen.

Es ist für den **Docker-Betrieb als daemonisierten Hintergrunddienst (Service)** optimiert, bietet integrierte **Prometheus-Metriken**, strukturierte **JSON-Logs** und speichert Zustände ausfallsicher in einer **SQLite-Datenbank**.

Die vollständige, verbindliche Anleitung für Installation, Konfiguration, Nutzung, Production-Release, Recovery und alle noch extern zu erbringenden Enterprise-Nachweise steht in [`docs/PRODUCTION_GUIDE.md`](docs/PRODUCTION_GUIDE.md).

Die vollständige Trading-Einrichtung für selbst verwaltete Signal-Schemas, paralleles Kanal-Routing, Hyperliquid/Bybit, adaptive TP-Staffelung, SL-Nachziehen und Notfälle steht in [`docs/TRADING_GUIDE.md`](docs/TRADING_GUIDE.md).

Die Einrichtung des optionalen, eigenständigen MCP-Dienstes, der Agenten-Tokens, dauerhaften Berechtigungen und Ereignis-Abonnements steht in [`docs/MCP_GUIDE.md`](docs/MCP_GUIDE.md).

Weitere verbindliche Dokumente:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) – Komponenten, Trust Boundaries und Zustandsflüsse;
- [`docs/QUALITY_OS.md`](docs/QUALITY_OS.md) – Tests, Security- und Release-Gates;
- [`docs/runbooks/operations.md`](docs/runbooks/operations.md) – Störung, Reconciliation, Restore und Rollback;
- [`docs/GITHUB_GOVERNANCE.md`](docs/GITHUB_GOVERNANCE.md) – erforderliche Repository-Regeln und aktuell offene Plattformkontrollen;
- [`docs/TRADING_BLUEPRINT_V4_GAP_ANALYSIS.md`](docs/TRADING_BLUEPRINT_V4_GAP_ANALYSIS.md) – aktueller Abgleich mit dem Trading-Blueprint;
- [`SECURITY.md`](SECURITY.md) und [`CHANGELOG.md`](CHANGELOG.md) – Support-/Meldeweg und Versionshistorie.

---

## 📂 Ordnerstruktur & Datei-Guide

Damit das Projekt übersichtlich bleibt, sind die Dateien klar aufgeteilt:

```text
├── dist/                     # Kompilierter JavaScript-Code (wird automatisch erzeugt)
├── src/                      # TypeScript-Quellcode
│   ├── config.ts             # Konfigurations-Parser und -Validierer
│   ├── db.ts                 # SQLite-Datenbanktreiber (Persistent State, Queue & Buffer)
│   ├── dupe_blocker.ts       # XML-Signal-Deduplizierer (normalisiert XML und fragt DB ab)
│   ├── env.ts                # Umgebungsvariablen-Manager (.env)
│   ├── filters.ts            # RegEx-, Typ- und Keyword-Filter (inkl. ReDoS-Schutz)
│   ├── forwarder.ts          # Hauptprogramm (Client-Initialisierung und Routing-Loop)
│   ├── metrics.ts            # Prometheus-Metriken und Healthcheck HTTP-Server
│   ├── queue.ts              # Concurrency-Queue für asynchrone Nachrichtenweiterleitung
│   ├── signal_parser.ts      # TS-Modul zur KI-XML-Signalextraktion via OpenRouter
│   ├── signal_schema.ts      # Dynamische XML-, Grounding- und USD-Quote-Validierung
│   ├── signal_contract.ts    # Deklarativer, versionierter Signalvertrags-Interpreter
│   ├── trading_*.ts          # Strategien, Kanalrisiko, Telemetrie, Orders und Reconciliation
│   ├── mcp_*.ts              # Agentenidentitäten, Kontrollbrücke und MCP-Server
│   └── web_server.ts         # Authentifizierte Web-Control-Plane und API
├── frontend/                 # React/Vite Dashboard einschließlich Trading Builder
├── exchange_executor/        # Internes Python-Sidecar für offizielle Exchange-SDKs
├── docs/                     # Architektur-, Betriebs-, Trading- und Governance-Dokumentation
├── monitoring/               # Prometheus, Alertmanager, Regeln und VEX-Nachweise
├── templates/                # Vorlagen für die KI-Signalextraktion
├── tests/                    # Unit-, Integrations-, Contract- und Systemtests
├── .env.example              # Referenz für Source-Dev/Orchestrator-Overrides
├── config.json.example       # Vorlage für die Kanal-Konfiguration
├── Dockerfile                # Multi-Stage Dockerfile (Build & Production-Runner)
├── docker-compose.yml        # Docker-Compose Konfiguration zur Orchestrierung
├── package.json              # Abhängigkeiten und Build-Scripts
├── tsconfig.json             # TypeScript-Compiler-Konfiguration
└── README.md                 # Diese Dokumentation
```

---

## 🛠️ System-Architektur (Enterprise)

Das System wurde auf Enterprise-Niveau gehoben und nutzt moderne Best Practices:

1. **State & Queue in SQLite**: Zustände (Persistenz-Queue, Album-Buffer und gesendete Signale) werden in der lokalen Datenbank `session_data/forwarder.db` gespeichert. Keine unzuverlässigen JSON-Dateien im Dateisystem mehr.
2. **Prometheus HTTP-Server**: Liefert Metriken (`/metrics`) über Systemdurchsatz und Queue-Zustände sowie Healthchecks (`/healthz`) für Container-Orchestratoren auf Port `9100`.
3. **Structured JSON Logging**: Im Container-Betrieb gibt der Service strukturierte JSON-Meldungen direkt an `stdout` aus, um sie in Log-Aggregatoren wie Kibana, Splunk oder Datadog einzulesen.
4. **Multi-Stage Docker Pipeline**: Der Compiler läuft in einer Build-Stufe. Das produktive Docker-Image enthält nur die kompilierten Dateien und native Produktivabhängigkeiten – sicher, gehärtet und klein.
5. **Dynamische Signalverträge**: Verträge sind versionierte SQLite-Datensätze. Der visuelle Builder verwaltet XML-Pfade, Feldtypen, Entry-/Target-Form, Geometrie und Quelltext-Erdung ohne ausführbaren Benutzer-Code.
6. **Cockpit und Labor**: Das Dashboard zeigt im Cockpit nur Live-Sicherheit, Positionen, PnL und Signalstrom. Equity, Drawdown, Kanalqualität, Slippage, Latenz und Simulation liegen im separaten Analytics-Bereich.
7. **Agenten-Control-Plane**: Ein optionaler MCP-Dienst verwendet pro Agent gehashte Tokens und dauerhaft verwaltete Minimalrechte. Schreibaktionen laufen nicht direkt gegen SQLite oder Exchanges, sondern über die auditierte TSX-Core-Kontrollbrücke.

---

## 🚀 Schnellstart: vollständig über Docker und Web-UI

Voraussetzung ist Docker Desktop oder Docker Engine mit Docker Compose 2.24 oder neuer. Eine lokale Node.js-Installation, `.env`, `config.json`, manuell angelegte Ordner und eine Terminal-Anmeldung bei Telegram sind für die normale Nutzung nicht erforderlich.

1. Repository auschecken und den Dienst starten:

   ```bash
   docker compose up --build -d
   ```

   `--build` ist auch nach jedem erneuten Download oder `git pull` erforderlich. Ein bloßes `docker compose up -d` darf ein bereits vorhandenes lokales Image weiterverwenden und würde dann eine ältere Oberfläche ausliefern. Persistente Volumes bleiben beim Neubau erhalten.

2. `http://127.0.0.1:8080` öffnen. Im normalen, ausschließlich auf Host-Loopback veröffentlichten Docker-Modus erzeugt der Server den dauerhaften Admin-Token beim ersten Seitenaufruf automatisch und zeigt ihn einmal zum sicheren Hinterlegen an. Bei späteren Browser-Sitzungen wird ebenfalls automatisch ein eigener, höchstens zwölf Stunden gültiger lokaler Session-Token erzeugt; eine Bearer-Eingabe ist lokal nicht erforderlich und der dauerhafte Admin-Token wird nicht erneut offengelegt.
3. Unter **Signale & Nachrichten → Kanäle** die Telegram API ID, den 32-stelligen API Hash, mindestens einen Quellkanal und den Zielkanal eintragen. **Konfiguration speichern** speichert Nicht-Secrets und write-only Secrets getrennt in persistenten Docker-Volumes. Die lokale `.env` wird von Docker Compose bewusst nicht eingelesen und kann diese Felder daher nicht mehr sperren.
4. Falls der KI-Parser verwendet wird: unter **Signale & Nachrichten → KI-Parser** den OpenRouter-Key eintragen und Limits/Modelle prüfen. Das `default`-Template ist direkt editierbar; die serverseitigen Prompt-Injection- und Schema-Schutzregeln bleiben unveränderlich angehängt. Ohne KI-Parser ist kein OpenRouter-Key nötig.
5. Auf dem Dashboard **Start Forwarder** anklicken. Telefon, Telegram-Code, E-Mail-Code und optionale 2FA werden ausschließlich im Web-Dialog abgefragt und nicht persistiert.
6. Betriebszustand prüfen:

   ```bash
   docker compose ps
   curl --fail http://127.0.0.1:9100/healthz
   curl --fail http://127.0.0.1:9100/readyz
   docker compose logs -f forwarder
   ```

`healthz` darf bereits während der Einrichtung grün sein; `readyz` wird erst nach vollständiger Konfiguration, Telegram-Anmeldung und aktivem Routing grün. Der dauerhafte lokale Admin-Token bleibt im Secret-Volume gültig und wird daraus niemals erneut an den Browser zurückgegeben. Bei aktiviertem Compose-Local-Trust ersetzt ein automatisch erzeugter, pro Prozess begrenzter Session-Token die manuelle Bearer-Eingabe. Remote-Zugriffe erhalten diesen Vertrauenspfad nicht und benötigen Tailscale-Identity, OIDC oder einen explizit verwalteten Bearer-Key. Zusätzliche Admin- und read-only Viewer-Bearer-Keys werden unter **System & Backup → API- und Bearer-Keys** erzeugt, rotiert oder deaktiviert und jeweils nur einmal angezeigt.

Im Standalone-Modus verwendet das Dashboard integrierten lokalen Zugriff, verkettete Audit-Logs und verifizierte lokale Backups. Sämtliche Runtime-/Enterprise-Parameter – OIDC, externe Origin, Remote-Audit, verschlüsselte Off-site-Backups, Retention, Kapazitätsgrenzen und Timeouts – werden unter **System & Backup → Vollständige Runtime- und Enterprise-Konfiguration** gespeichert und über **Container kontrolliert neu starten** aktiviert. Enterprise-Modus erzwingt OIDC, deaktiviert Local Trust und verlangt unveränderlichen Remote-Audit-Trail sowie verschlüsselte, rücklesbar verifizierte Off-host-Backups.

### Trading vollständig im Web einrichten

1. Unter **Trading → Paper-Märkte** zunächst Equity und Marktmetadaten für `paper-default` konfigurieren. Paper/Testnet sind der sichere Standard.
2. Über den eigenen Sidebar-Punkt **XML-Verträge** – alternativ **Trading → Verträge** – Signalverträge visuell erstellen, duplizieren, als Entwurf bearbeiten, mit XML und Quelltext testen und anschließend publizieren. Publizierte oder archivierte Versionen lassen sich nach expliziter Bestätigung endgültig löschen, sobald kein Signal-Schema-Profil mehr darauf verweist. Danach unter **Trading → Strategien** ein Signal-Schema-Profil mit einem beliebigen publizierten Vertrag und Parser-Template verknüpfen und die Strategie publizieren. Aktive Profile schützen ihren Vertrag gegen Archivierung; unbekannte, deaktivierte oder nicht publizierte Verknüpfungen bleiben fail-closed. Die adaptive TP-Halbierungsstaffel funktioniert automatisch mit 1 bis 20 Signal-Targets; das adaptive SL-Nachziehen setzt nach TP1/TP2 Break-even und danach den Stop auf TP(i-2).
3. Unter **Trading → Börsenkonten** Hyperliquid oder Bybit wählen, Testnet/Live bestimmen und die Keys eingeben. Die UI zeigt danach nur Konfigurations- und Verifikationsstatus; Keys werden nie zurückgelesen. Hyperliquid erwartet einen dedizierten API-Wallet Private Key plus Master-Wallet-Adresse, Bybit einen API-Key mit ausschließlich erforderlichen Futures-Handelsrechten. Withdrawal-Rechte sind nicht erforderlich und dürfen nicht vergeben werden.
4. Unter **Trading → Kanal-Routing** jeden Telegram-Quellkanal genau einer publizierten Strategieversion und einem aktivierten Konto zuordnen. Kanal A, B und C können gleichzeitig unterschiedliche Strategien/Konten ausführen; dasselbe Konto/Symbol bleibt exklusiv bei einer aktiven Position.
5. Unter **Trading → Betrieb** zuerst reconciliieren und dann die automatische Ausführung aktivieren. Für Echtgeld muss einmal exakt `ENABLE LIVE TRADING` bestätigt werden. Danach läuft die freigegebene Strategie ohne Approval pro Einzeltrade.
6. **Trades & Risiko** zeigt Intents, Positionen, Entries, TP/SL/Flatten-Orders, Fills, Risk Events und Reconciliation. Unknown Orders, fremde Positionen oder fehlender Protective Stop aktivieren fail-closed die Sperre und machen `/readyz` rot.

Die Anwendung führt keinen beliebigen in der UI eingegebenen Code aus. „Plugins“ sind strikt validierte, versionierte deklarative Strategien; ein neuer grundlegend anderer Algorithmus benötigt eine getestete Engine-Version. Exchange-Zugriffe laufen ausschließlich über das interne Sidecar mit den offiziellen SDKs `hyperliquid-python-sdk` und `pybit`; das Sidecar besitzt keinen Host-Port.

Ausführbare Signale müssen immer gegen `USD`, `USDC` oder `USDT` notiert sein. Andere Quote-Assets oder uneindeutige Paare werden vor dem Erzeugen eines Trade Intents abgewiesen.

### Bedienoberfläche

- **Cockpit**: Kill-Switch, Execution-/Live-/Paper-Zustand, aktive Positionen mit PnL, letzter Signalstrom und Notfallaktionen.
- **Analytics**: Equity-Kurve, Drawdown, tägliche/wöchentliche Auswertung, Kanalranking, Slippage-/Exchange-Vergleich, Signal-zu-Ausführungs-Latenz und Erwartungswert-Simulation.
- **Dynamisches Kanalrisiko**: je Telegram-Kanal `fixed`, `shadow` oder `automatic`, gestaffelte Risikoprozentwerte, Lookback, Mindest-Trades, Gewinn-/Verlustschwellen, automatische Reduktion/Sperre sowie manuelle Sperre/Stufenfixierung. Die Strategieobergrenze und alle globalen Safety-Gates bleiben zwingend.
- **Logs**: zusammenhängender Live-Terminalstrom mit 20.000 Zeilen Ringpuffer, Freitext-/Regex-Suche und virtueller Darstellung; keine Level-Filter zerreißen Abläufe.
- **Command Palette**: `Strg+K` beziehungsweise `⌘K` öffnet Navigation, Verträge, Kanäle, Positionen und erlaubte Schnellaktionen.
- **Monochrom-Design**: Status wird durch Text, Punkte, Konturen und invertierte Auswahlzustände vermittelt, nicht ausschließlich durch Farbe.

### Sicherer Remote-Zugriff und MCP

Für WLAN/VPN ist **Tailscale Serve** der bevorzugte Weg. Dashboard und MCP bleiben auf Host-Loopback; Serve veröffentlicht sie nur im Tailnet. **Tailscale Funnel ist verboten**, weil es einen öffentlichen Internet-Endpunkt erzeugt. Im Dashboard-Authentifizierungsmodus `tailscale` akzeptiert TSX Core ausschließlich die von einem ausdrücklich vertrauten lokalen Serve-Proxy gelieferten Identitätsheader und ordnet Login-Adressen einer Admin- oder Viewer-Allowlist zu. `scripts/configure_tailscale_serve.ps1` deaktiviert Funnel für den Zielport und richtet Serve auf den Loopback-Dienst ein.

Der MCP-Dienst ist optional und startet nicht im normalen Zwei-Service-Stack:

```bash
docker compose --profile mcp up --build -d
curl --fail http://127.0.0.1:8091/healthz
```

Unter **MCP-Agenten** wird für jeden Agenten ein Token genau einmal ausgegeben. TSX Core speichert nur SHA-256, zeigt aktive Sitzungen und protokolliert jeden Tool-Aufruf. Rechte und Ereignis-Abonnements gelten dauerhaft, bis ein Admin sie ändert, den Agenten deaktiviert, löscht oder den Token rotiert. **Agent löschen** widerruft Token, Rechte, Sitzungen und wartende Kontrollanforderungen sofort; die anonymisierte Audit-Historie bleibt erhalten. Details und Client-Beispiel: [`docs/MCP_GUIDE.md`](docs/MCP_GUIDE.md).

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

### Backup und Restore (RPO 15 Minuten / RTO 60 Minuten)

Beim Prozessstart und danach spätestens alle 15 Minuten erstellt der Dienst unter `BACKUP_DIR` ein atomar veröffentlichtes Backup-Artefakt. Es enthält einen konsistenten SQLite-Online-Backup-Snapshot, die nicht geheime Konfiguration und ein SHA-256-/Größenmanifest. Jedes Artefakt wird vor Veröffentlichung mit Checksummen, `PRAGMA integrity_check`, Pflicht-Tabellen und Secret-Feld-Prüfung verifiziert; ein fehlgeschlagenes Backup setzt Readiness und `tg_forwarder_backup_healthy` auf Fehler. Standardmäßig werden 672 Artefakte (sieben Tage bei 15 Minuten) aufbewahrt.

Im Web unter **System & Backup → Enterprise Operations** können Operatoren Backups sofort erzeugen, vorhandene Artefakte auswählen, vollständig verifizieren und nach Eingabe von `RESTORE` wiederherstellen. Der Dienst stoppt dabei Routing und Scheduler, schließt SQLite, bewahrt den ersetzten DB-/Config-Stand als Rollback auf und startet den Container kontrolliert neu. Die folgenden Befehle bleiben nur als Break-glass-Alternative erhalten.

Manuelle Prüfung und Wiederherstellung im Docker-Betrieb (`<artifact-name>` durch den Verzeichnisnamen im Backup-Volume ersetzen):

```bash
docker compose exec -T forwarder /nodejs/bin/node dist/backup_cli.js create /app/backups
docker compose exec -T forwarder /nodejs/bin/node -e "const fs=require('fs');const names=fs.readdirSync('/app/backups').filter(name=>name.startsWith('backup-')).sort();console.log(names.at(-1)||'no backup found')"
docker compose exec -T forwarder /nodejs/bin/node dist/backup_cli.js verify /app/backups/<artifact-name>

# Dienst vollständig stoppen und failed/unknown Zustellungen dokumentieren.
docker compose down
docker compose run --rm --no-deps --entrypoint /nodejs/bin/node forwarder dist/backup_cli.js restore /app/backups/<artifact-name>
docker compose up -d

# Dienst starten, /readyz und Outbox prüfen, dann einen synthetischen End-to-End-Flow ausführen.
```

Restore verweigert die Ausführung, solange `.process_active` oder `.routing_active` im State-Verzeichnis existiert. Ein nach hartem Prozessabbruch veralteter Lock darf erst entfernt werden, nachdem auf Betriebssystemebene bestätigt wurde, dass kein Forwarder-Prozess mehr läuft und die Outbox reconciled ist. Bestehende DB und Konfiguration werden nicht gelöscht, sondern als `.pre-restore-*` für einen unmittelbaren Rollback erhalten.

Die Backup-Artefakte enthalten Nachrichten-, Signal- und damit potenziell personenbezogene Daten. Im Enterprise-Modus ist Off-host-Replikation deshalb zwingend. Das Web-Feld `backupOffsiteUrlTemplate` bezeichnet einen HTTPS-Objektendpunkt, der authentifizierte `PUT`- und `GET`-Anfragen auf demselben, durch `{artifact}` parametrisierten Pfad unterstützt; Bearer-Token und 32-Byte-AES-Schlüssel werden unter **System & Backup → Enterprise-Secrets** write-only gespeichert.

Jedes lokale Artefakt wird vor dem Upload geprüft, als begrenztes internes Archiv mit AES-256-GCM verschlüsselt und hochgeladen. Anschließend lädt der Dienst exakt dieses Objekt wieder herunter, vergleicht SHA-256 und Länge, authentifiziert und entschlüsselt es und führt erneut SQLite-Integritäts-, Tabellen-, Manifest- und Secret-Prüfungen aus. Erst dann gilt das Backup als erfolgreich und Readiness bleibt grün. Der Verschlüsselungsschlüssel muss getrennt vom Backup-Store aufbewahrt werden; ein lokales Verzeichnis oder ein nicht zurücklesbarer Upload erfüllt Disaster Recovery nicht.

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

Vor einem Modell-, Prompt- oder Template-Release muss mit Staging-Zugang `npm run test:ai-eval` ausgeführt werden. Das Gate vergleicht normale, schemaspezifische und adversariale Fälle aus `tests/fixtures/signal_golden_set.json` mit den freigegebenen Ergebnissen und schlägt bei jeder Abweichung oder unerwarteten Annahme fehl. Der normale Offline-Testlauf ruft keinen externen KI-Provider auf.

### Docker-Betrieb und persistente Daten

Der Container läuft als unprivilegierter Benutzer mit schreibgeschütztem Root-Dateisystem, ohne Linux-Capabilities und mit CPU-, RAM-, PID- und Log-Grenzen. Compose initialisiert benannte Volumes für Konfiguration, Secrets, Templates, TDLib-Sitzung, SQLite, Signale, Logs und Backups; Updates und normale Container-Neuerstellungen erhalten diese Daten.

Der Standardstart erzeugt genau zwei Services: `forwarder` besitzt Telegram, Dashboard, Trading-Zustand und Sicherheitslogik; `exchange-executor` kapselt die offiziellen Python-SDKs und besitzt keinen Host-Port. Diese Prozessgrenze hält native Exchange-Abhängigkeiten und deren Credentials aus der Node-Control-Plane heraus. `mcp-server` ist ein dritter, unabhängiger Dienst, wird aber ausschließlich mit dem Compose-Profil `mcp` gestartet und teilt nur das SQLite-State-Volume. Er besitzt weder Telegram- noch Exchange-Secrets.

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

Dashboard, Metriken und der optionale MCP-Port werden ausschließlich auf Host-Loopback veröffentlicht. Externer Zugriff erfolgt bevorzugt über Tailscale Serve oder alternativ einen authentifizierenden TLS-Reverse-Proxy. Compose verwendet `restart: unless-stopped`, damit ein kontrollierter Web-Neustart und ein Factory Reset den Dienst automatisch wieder in Betrieb nehmen; die anwendungsinterne Crash-Loop-Sperre verhindert trotzdem unkontrolliertes Routing nach wiederholten Fehlern. Das lokale Backup-Volume allein ist kein Enterprise-DR-Nachweis.

Incident-URL, internes Relay-Token und Incident-Gateway-Token werden vollständig im Web unter **System & Backup → Vollständige Runtime- und Enterprise-Konfiguration** beziehungsweise **Enterprise-Secrets** gesetzt. Danach startet `docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d` den Monitoring-Stack; Alertmanager und Relay lesen ausschließlich die verwalteten Config-/Secret-Volumes, nicht `.env` oder Host-Secret-Dateien. Prometheus und Alertmanager sind per unveränderlichem Multi-Arch-Digest gepinnt, speichern 30 Tage Metriken beziehungsweise fünf Tage Alertmanager-Zustand und veröffentlichen ihre UIs nur auf Host-Loopback.

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

Ein zweiter, read-only Self-hosted Runner mit den Labels `self-hosted, production-observer` liest täglich ein vollständiges 30-Tage-Fenster aus Prometheus. `npm run ops:soak` fordert mindestens 99,5 % Scrape-Verfügbarkeit und bestätigte Zustellung, P95 unter 60 Sekunden, mindestens 100 Zustellversuche, keine unbekannte Zustellung, durchgehend gesunde Backups/Retention/Disk sowie begrenzte Queue und RAM. `PROMETHEUS_URL` muss HTTPS verwenden (Loopback ausgenommen), das optionale Bearer-Token kommt aus `PROMETHEUS_TOKEN[_FILE]`.

Der Tag-Release in `quality.yml` prüft über die GitHub-API, dass für exakt denselben Commit sowohl das Staging-Gate als auch der 30-Tage-Nachweis erfolgreich waren. Fehlende Runner, Provider-Zugänge, unvollständige Messfenster oder fehlende Artefakte blockieren damit die Veröffentlichung; sie werden nicht als N/A behandelt. Einrichtung und Secret-/Variable-Zuordnung stehen in `docs/runbooks/operations.md`.

---

## 🧪 Tests ausführen

Für Quellcode-Verifikation werden Node.js 22 und npm 10.9 verwendet. Der vollständige lokale Kernlauf lautet:

```bash
npm ci --no-audit --no-fund
npm ci --prefix frontend --no-audit --no-fund
npm run typecheck
npm run lint
npm run lint:frontend
npm test
npm run test:coverage
npm run test:coverage:modules
npm run build
```

Mutation, Browsermatrix, Container/SBOM/Vulnerability, Secret-History und CodeQL laufen zusätzlich im GitHub Quality Workflow. Die vollständige Gate-Matrix und kontextabhängigen Befehle stehen in [`docs/QUALITY_OS.md`](docs/QUALITY_OS.md) und [`docs/PRODUCTION_GUIDE.md`](docs/PRODUCTION_GUIDE.md).
