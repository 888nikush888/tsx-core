# Telegram Forwarder mit TDLib (Enterprise Edition)

Ein leistungsstarker, robuster und vollständig nach **TypeScript** migrierter Telegram-Nachrichten-Weiterleiter auf Basis der offiziellen **TDLib** (Telegram Database Library). Dieses Tool läuft unter Node.js und leitet Nachrichten aus Quellkanälen automatisch an einen Zielkanal weiter.

Es ist für den **Docker-Betrieb als daemonisierten Hintergrunddienst (Service)** optimiert, bietet integrierte **Prometheus-Metriken**, strukturierte **JSON-Logs** und speichert Zustände ausfallsicher in einer **SQLite-Datenbank**.

Die vollständige, verbindliche Anleitung für Installation, Konfiguration, Nutzung, Production-Release, Recovery und alle noch extern zu erbringenden Enterprise-Nachweise steht in [`docs/PRODUCTION_GUIDE.md`](docs/PRODUCTION_GUIDE.md).

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
│   └── web_server.ts         # Authentifizierte Web-Control-Plane
├── templates/                # Vorlagen für die KI-Signalextraktion
├── tests/                    # Unit- und Integrationstests (TypeScript/Node.js)
├── .env.example              # Vorlage für API-Schlüssel und Einstellungen
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

---

## 🚀 Schnellstart: vollständig über Docker und Web-UI

Voraussetzung ist Docker Desktop oder Docker Engine mit Docker Compose 2.24 oder neuer. Eine lokale Node.js-Installation, `.env`, `config.json`, manuell angelegte Ordner und eine Terminal-Anmeldung bei Telegram sind für die normale Nutzung nicht erforderlich.

1. Repository auschecken und den Dienst starten:

   ```bash
   docker compose up --build -d
   ```

2. `http://127.0.0.1:8080` öffnen und **Create secure dashboard** wählen. Das serverseitig erzeugte Admin-Token einmalig sicher ablegen; im Browser verbleibt es nur im `sessionStorage`.
3. Unter **Channels** die Telegram API ID, den 32-stelligen API Hash, mindestens einen Quellkanal und den Zielkanal eintragen. **Save Configuration** speichert Nicht-Secrets und write-only Secrets getrennt in persistenten Docker-Volumes.
4. Falls der KI-Parser verwendet wird: unter **Parser** den OpenRouter-Key eintragen und Limits/Modelle prüfen. Ohne KI-Parser ist kein OpenRouter-Key nötig.
5. Auf dem Dashboard **Start Forwarder** anklicken. Telefon, Telegram-Code, E-Mail-Code und optionale 2FA werden ausschließlich im Web-Dialog abgefragt und nicht persistiert.
6. Betriebszustand prüfen:

   ```bash
   docker compose ps
   curl --fail http://127.0.0.1:9100/healthz
   curl --fail http://127.0.0.1:9100/readyz
   docker compose logs -f forwarder
   ```

`healthz` darf bereits während der Einrichtung grün sein; `readyz` wird erst nach vollständiger Konfiguration, Telegram-Anmeldung und aktivem Routing grün. Bei verlorenem Browser-Token kann ein Host-Administrator es gezielt mit `docker compose exec -T forwarder /nodejs/bin/node -e "process.stdout.write(require('fs').readFileSync('/app/secrets/dashboard_admin_token','utf8'))"` wiederherstellen. Der Befehl gibt ein Secret aus und darf nicht in Tickets oder Logs kopiert werden.

Im Standalone-Modus (`ENTERPRISE_MODE=false`, Standard) verwendet das Dashboard den sicheren Erststart-Token und lokale, verkettete Audit-Logs sowie verifizierte lokale Backups. `ENTERPRISE_MODE=true` aktiviert die harten Enterprise-Gates: OIDC, unveränderlicher Remote-Audit-Trail und verschlüsselte, rücklesbar verifizierte Off-host-Backups werden Pflicht. Remote-Zugriff erfolgt ausschließlich über einen TLS-Reverse-Proxy; dessen exakte Origin wird mit `DASHBOARD_ALLOWED_ORIGIN` freigegeben.

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

Die Backup-Artefakte enthalten Nachrichten-, Signal- und damit potenziell personenbezogene Daten. In `ENTERPRISE_MODE=true` ist Off-host-Replikation deshalb zwingend. `BACKUP_OFFSITE_URL_TEMPLATE` bezeichnet einen HTTPS-Objektendpunkt, der authentifizierte `PUT`- und `GET`-Anfragen auf demselben, durch `{artifact}` parametrisierten Pfad unterstützt; Token und 32-Byte-AES-Schlüssel kommen über `BACKUP_OFFSITE_TOKEN[_FILE]` und `BACKUP_ENCRYPTION_KEY[_FILE]`. Einen Schlüssel erzeugt `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

Jedes lokale Artefakt wird vor dem Upload geprüft, als begrenztes internes Archiv mit AES-256-GCM verschlüsselt und hochgeladen. Anschließend lädt der Dienst exakt dieses Objekt wieder herunter, vergleicht SHA-256 und Länge, authentifiziert und entschlüsselt es und führt erneut SQLite-Integritäts-, Tabellen-, Manifest- und Secret-Prüfungen aus. Erst dann gilt das Backup als erfolgreich und Readiness bleibt grün. Der Verschlüsselungsschlüssel muss getrennt vom Backup-Store aufbewahrt werden; ein lokales Verzeichnis oder ein nicht zurücklesbarer Upload erfüllt Disaster Recovery nicht.

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

`xmlParsing.aiLimits` begrenzt Eingabelänge, Ausgabetokens, sichtbare Primär-/Fallback-Versuche, Request-Timeout, Backoff sowie Requests und reservierte Tokens pro UTC-Tag. Die SDK-internen Retries sind deaktiviert. Das Tagesbudget wird vor jedem Provider-Aufruf atomar in SQLite reserviert; ein abgebrochener oder hinsichtlich der Provider-Nutzung unklarer Aufruf wird konservativ mit seiner Reservierung verbucht. Ein Prozessabbruch kann deshalb bis zum nächsten UTC-Tag Kapazität blockieren, gibt aber nie unbewiesen Budget frei.

Zu jedem akzeptierten Signal speichert SQLite Template, Schemaname, SHA-256 des wirksamen Prompts, tatsächliches Modell, Provider-Request-ID, Tokenverbrauch und Parser-Version. Prompts oder vollständige Modell-Denkwege werden nicht geloggt. `OPENROUTER_API_KEY` bleibt ausschließlich in der Prozessumgebung.

Vor einem Modell-, Prompt- oder Template-Release muss mit Staging-Zugang `npm run test:ai-eval` ausgeführt werden. Das Gate vergleicht normale, schemaspezifische und adversariale Fälle aus `tests/fixtures/signal_golden_set.json` mit den freigegebenen Ergebnissen und schlägt bei jeder Abweichung oder unerwarteten Annahme fehl. Der normale Offline-Testlauf ruft keinen externen KI-Provider auf.

### Docker-Betrieb und persistente Daten

Der Container läuft als unprivilegierter Benutzer mit schreibgeschütztem Root-Dateisystem, ohne Linux-Capabilities und mit CPU-, RAM-, PID- und Log-Grenzen. Compose initialisiert benannte Volumes für Konfiguration, Secrets, Templates, TDLib-Sitzung, SQLite, Signale, Logs und Backups; Updates und normale Container-Neuerstellungen erhalten diese Daten.

```bash
# Start oder Update
docker compose up --build -d

# Status und Logs
docker compose ps
docker compose logs --tail=200 forwarder

# Kontrolliert stoppen; persistente Volumes bleiben erhalten
docker compose down

# Volumes niemals mit -v löschen, sofern kein bewusst bestätigter Total-Reset beabsichtigt ist.
docker volume ls --filter name=cb2_forwarder
```

Dashboard und Metriken werden ausschließlich auf Host-Loopback veröffentlicht; externer Zugriff benötigt einen authentifizierenden TLS-Reverse-Proxy. Der Container-Restart ist auf drei Fehlversuche begrenzt, damit Konfigurations-, Authentifizierungs- oder Crash-Loops nicht unbegrenzt weiterlaufen. Das lokale Backup-Volume allein ist kein Enterprise-DR-Nachweis.

Für den Monitoring-Stack müssen `ALERT_WEBHOOK_URL`, `ALERT_RELAY_TOKEN_HOST_FILE` und `ALERT_WEBHOOK_TOKEN_HOST_FILE` gesetzt sein. Die beiden Dateien enthalten jeweils genau ein zufälliges Token mit mindestens 32 Zeichen und werden ausschließlich als Compose-Secrets eingebunden. Prometheus und Alertmanager sind per unveränderlichem Multi-Arch-Digest gepinnt, speichern 30 Tage Metriken beziehungsweise fünf Tage Alertmanager-Zustand und veröffentlichen ihre UIs nur auf Host-Loopback.

---

## 📊 Monitoring & Log-Konfiguration

In der `.env`-Datei können Sie folgende Parameter konfigurieren:

```env
# Schaltet die Logausgabe auf strukturiertes JSON um (perfekt für Docker/Kubernetes)
JSON_LOGGING=true

# Definiert den Port des Prometheus-Metrikservers (Standard: 9100)
METRICS_PORT=9100

# Bindet Metriken standardmäßig nur an Loopback. Für einen isolierten
# Container-Port explizit auf 0.0.0.0 setzen.
METRICS_HOST=127.0.0.1
```

### Abrufen der Metriken
* **Liveness**: `curl http://localhost:9100/healthz` -> HTTP 200, solange der Prozess HTTP-Anfragen bedienen kann.
* **Readiness**: `curl http://localhost:9100/readyz` -> HTTP 200 nur bei erreichbarer SQLite-Datenbank, aktiver Telegram-Verbindung, laufendem Routing und nicht pausierter Queue; andernfalls HTTP 503 mit Einzelchecks.
* **Prometheus Scraping**: `curl http://localhost:9100/metrics`
  * Liefert bestätigte Zustellungen, Queue- und Outbox-Zustände einschließlich `failed`/`unknown`, Telegram-Verbindungszustand, letzten bestätigten Zustellzeitpunkt, Tagesverbrauch/-reservierung der KI sowie echte Prozess-RAM-/Uptime-Werte.

Die Dashboard-Historie zeigt ausschließlich gemessenen Durchsatz, Queue, CPU und RAM. Die frühere aus HTTP-Latenz und Zufall abgeleitete angebliche Internet-Bandbreite wurde entfernt, da sie keine belastbare Betriebsmetrik war. Die versionierten Regeln unter `monitoring/` alarmieren auf fehlende Metriken, unbekannte/fehlgeschlagene Zustellungen, DB-/Telegram-Ausfall, Backup-/Retention-/Disk-Probleme und Queue-Rückstau. `npm run quality:monitoring` validiert Prometheus, Alertmanager und die Regeltests mit gepinnten Tool-Images.

### Manipulationsnachweis und externer Audit-Trail

Mutierende Dashboard-Aufrufe werden vor ihrer Nebenwirkung synchron in `logs/audit-chain.jsonl` geschrieben, auf den Datenträger synchronisiert und über SHA-256 mit dem vorherigen Record verkettet. Der Record enthält Request-ID, pseudonyme Actor-ID, Rolle, Methode, Pfad und Abschlussstatus, aber weder Bearer-Token noch Request-Body. Eine beim Start beschädigte Kette blockiert den Dienst; das lokale 64-MiB-Limit blockiert weitere Mutationen, statt unkontrolliert zu wachsen.

Im Enterprise-Modus ist zusätzlich `AUDIT_WEBHOOK_URL` mit `AUDIT_WEBHOOK_TOKEN[_FILE]` Pflicht. Der HTTPS-Endpunkt darf erst 2xx antworten, nachdem der Record außerhalb des Forwarder-Hosts unveränderlich und gemäß Unternehmens-Retention gespeichert wurde. Ist die Vorabzustellung nicht beweisbar, antwortet die Control Plane mit 503 und führt die Mutation nicht aus; spätere Zustellfehler setzen Readiness und `tg_forwarder_audit_healthy` auf rot. `AUDIT_REMOTE_REQUIRED=false` ist bei `ENTERPRISE_MODE=true` unzulässig.

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

Das Projekt enthält eine umfangreiche Testsuite für alle Komponenten:

```bash
# Führt die gesamte Testsuite (Unit- und Integrationstests) aus
npm test
```
