# Telegram Forwarder mit TDLib (Enterprise Edition)

Ein leistungsstarker, robuster und vollständig nach **TypeScript** migrierter Telegram-Nachrichten-Weiterleiter auf Basis der offiziellen **TDLib** (Telegram Database Library). Dieses Tool läuft unter Node.js und leitet Nachrichten aus Quellkanälen automatisch an einen Zielkanal weiter.

Es ist für den **Docker-Betrieb als daemonisierten Hintergrunddienst (Service)** optimiert, bietet integrierte **Prometheus-Metriken**, strukturierte **JSON-Logs** und speichert Zustände ausfallsicher in einer **SQLite-Datenbank**.

---

## 📂 Ordnerstruktur & Datei-Guide

Damit das Projekt übersichtlich bleibt, sind die Dateien klar aufgeteilt:

```text
├── dist/                     # Kompilierter JavaScript-Code (wird automatisch erzeugt)
├── src/                      # TypeScript-Quellcode
│   ├── ui/
│   │   └── colors.ts         # Farbcodes für das TUI-Dashboard
│   ├── config.ts             # Konfigurations-Parser und -Validierer
│   ├── db.ts                 # SQLite-Datenbanktreiber (Persistent State, Queue & Buffer)
│   ├── dupe_blocker.ts       # XML-Signal-Deduplizierer (normalisiert XML und fragt DB ab)
│   ├── env.ts                # Umgebungsvariablen-Manager (.env)
│   ├── filters.ts            # RegEx-, Typ- und Keyword-Filter (inkl. ReDoS-Schutz)
│   ├── forwarder.ts          # Hauptprogramm (Client-Initialisierung und Routing-Loop)
│   ├── metrics.ts            # Prometheus-Metriken und Healthcheck HTTP-Server
│   ├── queue.ts              # Concurrency-Queue für asynchrone Nachrichtenweiterleitung
│   ├── signal_parser.ts      # TS-Modul zur KI-XML-Signalextraktion via OpenRouter
│   └── ui.ts                 # CLI-Menüsteuerung und Headless-Logger
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

## 🚀 Schnellstart & Installation

### Option A: Lokale Installation (Entwicklung)

1. **Abhängigkeiten installieren**:
   ```bash
   npm ci
   ```
2. **Konfiguration einrichten**:
   * Kopieren Sie `.env.example` zu `.env` und tragen Sie `OPENROUTER_API_KEY`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` sowie einen zufälligen `DASHBOARD_ADMIN_TOKEN` ein. Secrets werden ausschließlich über die Prozessumgebung gelesen und weder im Dashboard angezeigt noch in Backups exportiert.
   * Im Enterprise-Betrieb werden Secrets als einzelne Dateien aus dem Secret-Store eingebunden und über `OPENROUTER_API_KEY_FILE`, `TELEGRAM_API_HASH_FILE`, `DASHBOARD_ADMIN_TOKEN_FILE` und optional `DASHBOARD_VIEWER_TOKEN_FILE` referenziert. Direkter Wert und `_FILE` dürfen nie gleichzeitig gesetzt sein; der Prozess bricht sonst fail-closed ab. Bereits gesetzte Orchestrator-Variablen haben Vorrang vor `.env`.
   * Kopieren Sie `config.json.example` zu `config.json` und tragen Sie Ihre Quell- und Zielkanäle ein.
3. **Im Entwicklungsmodus ausführen** (kompiliert on-the-fly):
   ```bash
   npm run dev
   ```
4. **Für Produktion kompilieren**:
   ```bash
   npm run build
   npm start
   ```

### Dashboard-Zugriff

Der Control-Plane-Server bindet standardmäßig ausschließlich an `127.0.0.1`. Alle `/api/*`-Endpunkte verlangen einen verifizierten Bearer-Token. Lokale Nicht-Produktionsprozesse verwenden standardmäßig `DASHBOARD_AUTH_MODE=token`: `DASHBOARD_ADMIN_TOKEN` erlaubt Änderungen, der optionale `DASHBOARD_VIEWER_TOKEN` nur Lesezugriffe. Beide Tokens müssen mindestens 32 zufällige Zeichen lang und voneinander verschieden sein, zum Beispiel erzeugt mit:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Der Produktions-Container wählt ohne explizite, geprüfte Abweichung `DASHBOARD_AUTH_MODE=oidc`. Er validiert Signatur, erlaubten Algorithmus, Issuer, Audience, Ablaufzeit und Rollen eines JWT gegen `DASHBOARD_OIDC_JWKS_URL`. Die Claim-Werte aus `DASHBOARD_OIDC_ADMIN_ROLE` und `DASHBOARD_OIDC_VIEWER_ROLE` werden auf die beiden internen Rollen abgebildet; unbekannte Rollen, fehlendes `sub`, falsche Audience und ungültige Signaturen werden abgewiesen. Die Audit-Actor-ID ist ein stabiler pseudonymer Hash aus Issuer und `sub`, kein Shared-Token-Fingerprint.

Das Dashboard akzeptiert ein lokales Token oder kurzlebiges OIDC-Access-Token nur im Browser-`sessionStorage`. Alternativ kann ein vorgeschalteter, vollständig vertrauenswürdiger OIDC-Proxy das verifizierte Access-Token bei jeder Upstream-Anfrage injizieren; er muss eingehende `Authorization`-Header entfernen. Für Remote-Zugriff bleibt `WEB_HOST=127.0.0.1`, TLS endet am Proxy und dessen exakte Origin wird mit `DASHBOARD_ALLOWED_ORIGIN=https://forwarder.example.com` freigegeben. Die API darf nicht direkt unverschlüsselt im Netzwerk exponiert werden.

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

Manuelle Prüfung und Wiederherstellung:

```bash
npm run backup:create
npm run backup:verify -- ./backups/backup-<timestamp>-<id>

# Dienst vollständig stoppen und failed/unknown Zustellungen dokumentieren.
npm run backup:restore -- ./backups/backup-<timestamp>-<id>

# Dienst starten, /readyz und Outbox prüfen, dann einen synthetischen End-to-End-Flow ausführen.
```

Restore verweigert die Ausführung, solange `.process_active` oder `.routing_active` im State-Verzeichnis existiert. Ein nach hartem Prozessabbruch veralteter Lock darf erst entfernt werden, nachdem auf Betriebssystemebene bestätigt wurde, dass kein Forwarder-Prozess mehr läuft und die Outbox reconciled ist. Bestehende DB und Konfiguration werden nicht gelöscht, sondern als `.pre-restore-*` für einen unmittelbaren Rollback erhalten.

Die Backup-Artefakte enthalten Nachrichten-, Signal- und damit potenziell personenbezogene Daten. In `NODE_ENV=production` ist Off-host-Replikation deshalb standardmäßig Pflicht. `BACKUP_OFFSITE_URL_TEMPLATE` bezeichnet einen HTTPS-Objektendpunkt, der authentifizierte `PUT`- und `GET`-Anfragen auf demselben, durch `{artifact}` parametrisierten Pfad unterstützt; Token und 32-Byte-AES-Schlüssel kommen über `BACKUP_OFFSITE_TOKEN[_FILE]` und `BACKUP_ENCRYPTION_KEY[_FILE]`. Einen Schlüssel erzeugt `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

Jedes lokale Artefakt wird vor dem Upload geprüft, als begrenztes internes Archiv mit AES-256-GCM verschlüsselt und hochgeladen. Anschließend lädt der Dienst exakt dieses Objekt wieder herunter, vergleicht SHA-256 und Länge, authentifiziert und entschlüsselt es und führt erneut SQLite-Integritäts-, Tabellen-, Manifest- und Secret-Prüfungen aus. Erst dann gilt das Backup als erfolgreich und Readiness bleibt grün. Der Verschlüsselungsschlüssel muss getrennt vom Backup-Store aufbewahrt werden; ein lokales Verzeichnis oder ein nicht zurücklesbarer Upload erfüllt Disaster Recovery nicht.

### Daten-Retention und Kapazität

Operative Daten werden standardmäßig 90 Tage aufbewahrt. Die Retention löscht ausschließlich alte `completed`-Outbox-Einträge, final `processed`/`filtered` Inbox-Nachrichten, nicht mehr von ungeklärten Tasks referenzierte Signale und alte AI-Budgettage. `pending`, `preparing`, `sending`, `failed` und `unknown` werden nie automatisch entfernt. Die Arbeit läuft in begrenzten Batches; ein nicht abarbeitbarer Rückstand oder weniger als `DATA_MIN_FREE_BYTES` freier Speicher setzt Readiness auf Fehler.

Konfiguration: `DATA_RETENTION_DAYS`, `DATA_RETENTION_INTERVAL_MS`, `DATA_RETENTION_BATCH_SIZE` und `DATA_MIN_FREE_BYTES`. Prometheus exportiert Retention-Zustand, gelöschte Zeilen, SQLite-Belegung, wiederverwendbare Seiten und freien Speicher. Eine Änderung der Aufbewahrungsfrist benötigt Data-Owner-Freigabe und muss mit der Off-host-Backup-Retention konsistent sein.

### Datenbank-Migration und Binary-Rollback

Das Schema wird über eine lückenlose, checksum-geschützte `schema_migrations`-Historie aktualisiert. Jede Migration läuft in einer eigenen SQLite-Transaktion; neuere, manipulierte oder lückenhafte Historien blockieren den Start. Vor Änderungen an einer bestehenden Datenbank erzeugt der Prozess unter `session_data/.migration-backups/` automatisch einen integritätsgeprüften Snapshot.

Aktuelle Migrationen sind zum vorherigen Binary additiv kompatibel. Falls ein späteres Release einen DB-Downgrade verlangt, wird der Dienst inklusive aller Nebeninstanzen gestoppt, `failed`/`unknown` dokumentiert und der im Release-Record benannte Snapshot explizit wiederhergestellt:

```bash
npm run db:migration:restore -- ./session_data/.migration-backups/pre-migration-....db --confirm-restore-pre-migration
```

Das Kommando verweigert aktive Prozess-/Routing-Locks, prüft den Snapshot und bewahrt die ersetzte Datenbank samt WAL/SHM für Forensik. Anschließend darf nur das zum alten Schema passende Rollback-Image gestartet werden.

### Automatische KI-Signalverarbeitung

Die Signalverarbeitung arbeitet ohne Human-in-the-loop. Ein Ergebnis darf jedoch nur automatisch weitergeleitet werden, wenn es exakt dem für die Quelle festgelegten Schema entspricht und alle Zahlen-, Wertebereichs-, Reihenfolge- und LONG/SHORT-Geometrieprüfungen besteht. Markdown, XML-Deklarationen, unbekannte Tags, nicht sequenzielle Targets, abgeschnittene Modellantworten und Text außerhalb des XML-Dokuments werden fail-closed abgewiesen; unbekannte oder nicht lesbare Template-Dateien fallen nicht still auf den Standardprompt zurück.

`xmlParsing.aiLimits` begrenzt Eingabelänge, Ausgabetokens, sichtbare Primär-/Fallback-Versuche, Request-Timeout, Backoff sowie Requests und reservierte Tokens pro UTC-Tag. Die SDK-internen Retries sind deaktiviert. Das Tagesbudget wird vor jedem Provider-Aufruf atomar in SQLite reserviert; ein abgebrochener oder hinsichtlich der Provider-Nutzung unklarer Aufruf wird konservativ mit seiner Reservierung verbucht. Ein Prozessabbruch kann deshalb bis zum nächsten UTC-Tag Kapazität blockieren, gibt aber nie unbewiesen Budget frei.

Zu jedem akzeptierten Signal speichert SQLite Template, Schemaname, SHA-256 des wirksamen Prompts, tatsächliches Modell, Provider-Request-ID, Tokenverbrauch und Parser-Version. Prompts oder vollständige Modell-Denkwege werden nicht geloggt. `OPENROUTER_API_KEY` bleibt ausschließlich in der Prozessumgebung.

Vor einem Modell-, Prompt- oder Template-Release muss mit Staging-Zugang `npm run test:ai-eval` ausgeführt werden. Das Gate vergleicht normale, schemaspezifische und adversariale Fälle aus `tests/fixtures/signal_golden_set.json` mit den freigegebenen Ergebnissen und schlägt bei jeder Abweichung oder unerwarteten Annahme fehl. Der normale Offline-Testlauf ruft keinen externen KI-Provider auf.

### Option B: Docker / Docker-Compose (Empfohlen für Server)

Der Container läuft als unprivilegierter Benutzer mit schreibgeschütztem Root-Dateisystem, ohne Linux-Capabilities und mit CPU-, RAM-, PID- und Log-Grenzen. Dashboard und Metriken werden ausschließlich auf Host-Loopback veröffentlicht; externer Zugriff benötigt einen authentifizierenden TLS-Reverse-Proxy.

1. Konfigurieren Sie `.env` und `config.json` auf dem Host. Legen Sie `session_data`, `session_files`, `signals`, `logs` und `backups` an und stellen Sie sicher, dass UID/GID `1000:1000` dort schreiben darf.
2. Bauen Sie das gepinnte Image und führen Sie die einmalige TDLib-Erstanmeldung interaktiv aus:
   ```bash
   docker compose build
   docker compose run --rm -e NON_INTERACTIVE=false forwarder node dist/forwarder.js
   ```
   Beenden Sie den interaktiven Lauf nach erfolgreicher Anmeldung sauber. Die Sitzung bleibt im eingebundenen `session_data`-Verzeichnis erhalten.
3. Starten Sie anschließend den daemonisierten Dienst:
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
   ```
4. Prüfen Sie Liveness, Readiness und den Containerstatus:
   ```bash
   curl --fail http://127.0.0.1:${HOST_METRICS_PORT:-9100}/healthz
   curl --fail http://127.0.0.1:${HOST_METRICS_PORT:-9100}/readyz
   docker compose ps
   ```

Der Container-Restart ist auf drei Fehlversuche begrenzt, damit Konfigurations-, Authentifizierungs- oder Crash-Loops nicht unbegrenzt weiterlaufen. `./backups` ist nur die lokale Restore-Quelle. Ohne vollständige Off-host-Konfiguration verweigert der Production-Container den Start.

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

Im Produktions-Container ist zusätzlich `AUDIT_WEBHOOK_URL` mit `AUDIT_WEBHOOK_TOKEN[_FILE]` Pflicht. Der HTTPS-Endpunkt darf erst 2xx antworten, nachdem der Record außerhalb des Forwarder-Hosts unveränderlich und gemäß Unternehmens-Retention gespeichert wurde. Ist die Vorabzustellung nicht beweisbar, antwortet die Control Plane mit 503 und führt die Mutation nicht aus; spätere Zustellfehler setzen Readiness und `tg_forwarder_audit_healthy` auf rot. `AUDIT_REMOTE_REQUIRED=false` ist ausschließlich für explizit als lokal deklarierte Nicht-Produktionsprozesse vorgesehen und im Containerbetrieb kein Enterprise-Nachweis.

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
