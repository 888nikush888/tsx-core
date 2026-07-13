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

Der Control-Plane-Server bindet standardmäßig ausschließlich an `127.0.0.1`. Alle `/api/*`-Endpunkte verlangen einen Bearer-Token; `DASHBOARD_ADMIN_TOKEN` erlaubt Änderungen, der optionale `DASHBOARD_VIEWER_TOKEN` nur Lesezugriffe. Beide Tokens müssen mindestens 32 zufällige Zeichen lang sein, zum Beispiel erzeugt mit:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Das Dashboard fragt den Token beim Öffnen ab und hält ihn nur im Browser-`sessionStorage`. Für Remote-Zugriff bleibt `WEB_HOST=127.0.0.1`; ein TLS-Reverse-Proxy wird vorgeschaltet und dessen exakte Origin mit `DASHBOARD_ALLOWED_ORIGIN=https://forwarder.example.com` freigegeben. Die API darf nicht direkt unverschlüsselt im Netzwerk exponiert werden.

### Option B: Docker / Docker-Compose (Empfohlen für Server)

Der Container speichert Sitzungsdaten permanent auf dem Host-System im Ordner `./session_data`.

1. Konfigurieren Sie `.env` und `config.json` auf Ihrem Host.
2. Starten Sie den Docker-Container:
   ```bash
   docker-compose up -d --build
   ```
3. **TDLib-Erstanmeldung**:
   Da Telegram beim ersten Start eine Telefonnummer und einen Login-Code erfordert, müssen Sie sich einmalig interaktiv im Container anmelden:
   ```bash
   # Container interaktiv betreten und Erstanmeldung durchführen
   docker attach tg-forwarder
   ```
   Geben Sie Ihre Telefonnummer und den per Telegram erhaltenen Login-Code ein. Sobald Sie angemeldet sind, können Sie die Verbindung mit `Strg + P` gefolgt von `Strg + Q` trennen (der Container läuft im Hintergrund weiter).

---

## 📊 Monitoring & Log-Konfiguration

In der `.env`-Datei können Sie folgende Parameter konfigurieren:

```env
# Schaltet die Logausgabe auf strukturiertes JSON um (perfekt für Docker/Kubernetes)
JSON_LOGGING=true

# Definiert den Port des Prometheus-Metrikservers (Standard: 9100)
METRICS_PORT=9100
```

### Abrufen der Metriken
* **Healthcheck**: `curl http://localhost:9100/healthz` -> `{"status":"ok", ...}`
* **Prometheus Scraping**: `curl http://localhost:9100/metrics`
  * Liefert Metriken wie `tg_forwarder_total_forwarded` und `tg_forwarder_queue_running`.

---

## 🧪 Tests ausführen

Das Projekt enthält eine umfangreiche Testsuite für alle Komponenten:

```bash
# Führt die gesamte Testsuite (Unit- und Integrationstests) aus
npm test
```
