# Production- und Enterprise-Betriebsanleitung

## Zweck und verbindlicher Status

Dieses Dokument ist der Einstiegspunkt für Installation, Konfiguration, Betrieb, Release, Recovery und die noch extern zu erbringenden Enterprise-Nachweise. Der Forwarder verarbeitet und validiert KI-Signale vollständig automatisch; es gibt **keine inhaltliche Human-in-the-loop-Freigabe im Laufzeitpfad**. Ungültige, mehrdeutige, abgeschnittene oder nicht schema-konforme KI-Ausgaben werden fail-closed verworfen.

Review- und Release-Freigaben in GitHub bleiben davon getrennte Governance-Kontrollen. Sie entscheiden über Softwareänderungen und Deployments, nicht über einzelne Nachrichten oder KI-Ergebnisse.

Ein lokaler grüner Testlauf ist ein Release-Candidate-Nachweis, aber noch kein Produktionsnachweis. Ein Production-GO ist erst zulässig, wenn alle in [Enterprise-Nachweise](#enterprise-nachweise-und-aktuelle-offene-punkte) genannten externen Gates für exakt denselben Commit belegt sind.

## 1. Systemüberblick

Der Dienst liest Telegram-Quellkanäle über TDLib, filtert Nachrichten, kann strukturierte Signale über einen LLM-Provider erzeugen und leitet akzeptierte Ergebnisse an genau ein Ziel weiter. Kritische Zustände liegen in SQLite; ein bestätigungsbasierter Outbox-Zustandsautomat verhindert stilles Vergessen und kennzeichnet nach einem unklaren Send-Abbruch die Zustellung als `unknown`, statt sie blind zu wiederholen.

Die wichtigsten Oberflächen sind:

| Oberfläche | Standard | Zweck | Produktionsgrenze |
| --- | --- | --- | --- |
| Web-Dashboard/API | `127.0.0.1:8080` | Status, Konfiguration, Outbox, kontrollierte Aktionen | Nur über TLS-/OIDC-Proxy remote erreichbar |
| Prometheus | `127.0.0.1:9100` | `/metrics`, `/healthz`, `/readyz` | Nur intern oder über read-only Monitoring-Zugriff |
| SQLite | `session_data/forwarder.db` | Inbox, Outbox, Signale, Budgets, Migrationen | Nie live kopieren oder manuell bearbeiten |
| Audit-Kette | `logs/audit-chain.jsonl` | Manipulationsnachweis mutierender API-Aufrufe | Produktion verlangt unveränderlichen Off-host-Empfänger |
| Backups | `backups/` plus Off-host-Store | Verifizierte, verschlüsselte Wiederherstellung | Lokales Verzeichnis allein erfüllt DR nicht |

Architekturdetails stehen in [ARCHITECTURE.md](ARCHITECTURE.md), verbindliche Qualitätsregeln in [QUALITY_OS.md](QUALITY_OS.md) und Störungsabläufe in [operations.md](runbooks/operations.md).

## 2. Voraussetzungen

Für lokale Verifikation:

- Node.js 20 und npm aus dem Lockfile-kompatiblen Toolchain-Stand;
- ein sauberer Checkout mit `package-lock.json` und `frontend/package-lock.json`;
- keine produktiven Secrets im Repository oder in Shell-Historien;
- für Containerverifikation ein laufender Docker-Engine-Dienst.

Für Produktion zusätzlich:

- Linux-Host oder vergleichbare Containerplattform mit persistenten, nur für UID/GID `1000:1000` beschreibbaren Volumes;
- TLS-Reverse-Proxy und OIDC-Provider;
- unveränderlicher externer Audit-Empfänger;
- authentifizierter, rücklesbarer Off-host-Objektspeicher und davon getrennt verwalteter AES-Schlüssel;
- Prometheus, Alertmanager, Incident-Empfänger und benannter On-Call;
- getrennte Self-hosted Runner für Staging und read-only Produktionsbeobachtung.

## 3. Reproduzierbarer Checkout und lokale Verifikation

```bash
git clone <repository-url>
cd <repository>
npm ci --no-audit --no-fund
npm ci --prefix frontend --no-audit --no-fund
npm run build
npm test
npm run lint
npm run lint:frontend
npm run typecheck
npm run test:coverage
npm run test:coverage:modules
npm run test:mutation
npm run quality:duplicates
npm run quality:architecture
npm run quality:complexity
npm run quality:frontend
npm run quality:release
npm run quality:risk-acceptances
npm run quality:licenses
npm run quality:sbom
```

Zusätzlich müssen Backend und Frontend ohne bekannte Moderate-/High-/Critical-Produktionslücke sein:

```bash
npm audit --omit=dev --audit-level=moderate
npm audit --prefix frontend --omit=dev --audit-level=moderate
```

`npm run quality:monitoring` benötigt einen laufenden Docker-Engine-Dienst, weil die gepinnten Prometheus-/Alertmanager-Werkzeuge in Containern ausgeführt werden. Das Container-Image selbst und seine nativen Imports werden im Workflow `.github/workflows/quality.yml` gebaut, gescannt und attestiert. Fehlende lokale Container-Unterstützung ist kein Pass; die CI-Evidenz bleibt Pflicht.

## 4. Nicht geheime Anwendungskonfiguration

Im normalen Docker-Betrieb wird keine Host-Datei vorbereitet. Compose initialisiert `forwarder_config`; das Dashboard schreibt die validierte Konfiguration atomar nach `/app/config/config.json`. Unter **Channels** werden API ID, Quellen und Ziel gepflegt, unter **Options** und **Filters** die Routingregeln und unter **Parser** Modelle, Budgets und Templates. Der Import/Export im Bereich **System** enthält ausschließlich Nicht-Secrets.

Regeln:

- Quellidentitäten werden kanonisch normalisiert; Alias- und Filterregeln müssen dieselbe Quelle eindeutig bezeichnen.
- `config.json` enthält keine API-Hashes, Tokens oder Schlüssel.
- Mindestens Telegram API ID, ein Quellkanal und ein gültiger Zielkanal sind vor dem Start erforderlich.
- Änderungen an Ziel, Filterlogik, Template, Modell oder AI-Limits werden wie kritische Änderungen getestet und reviewed.
- Eine ungültige Konfiguration blockiert den Start oder die betroffene Funktion; Warnungen dürfen nicht als Produktionsfreigabe interpretiert werden.
- Extern verwaltete API IDs können weiterhin über `TELEGRAM_API_ID` gesetzt werden; ein positiver externer Wert hat bewusst Vorrang vor dem Dashboard-Wert.

## 5. Secrets und OIDC

### Standalone-Docker

Beim ersten Browseraufruf erzeugt der Server nach Origin- und Audit-Prüfung ein zufälliges Admin-Token. Es wird nur in diesem Response angezeigt, im Browser ausschließlich im `sessionStorage` gehalten und im persistenten Volume `forwarder_secrets` gespeichert. Telegram API Hash und OpenRouter-Key werden im Dashboard write-only gesetzt: Status und Quelle sind lesbar, der Wert selbst nie. Extern gesetzte Secrets sind im Web schreibgeschützt.

Die Wiederherstellung des Admin-Tokens ist eine privilegierte Host-Aktion:

```bash
docker compose exec -T forwarder sh -c 'cat /app/secrets/dashboard_admin_token'
```

Die Ausgabe ist ein Secret. Sie darf weder in Tickets noch in Logs oder Shell-Transkripte übernommen werden.

### Enterprise-Modus

`ENTERPRISE_MODE=true` aktiviert OIDC sowie zwingende Remote-Audit- und Off-host-Backup-Gates. Secrets kommen dabei bevorzugt als Orchestrator-Dateien:

```env
ENTERPRISE_MODE=true
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH_FILE=/run/secrets/telegram_api_hash
OPENROUTER_API_KEY_FILE=/run/secrets/openrouter_api_key

DASHBOARD_AUTH_MODE=oidc
DASHBOARD_OIDC_ISSUER=https://identity.example/realms/operations
DASHBOARD_OIDC_AUDIENCE=telegram-forwarder
DASHBOARD_OIDC_JWKS_URL=https://identity.example/realms/operations/protocol/openid-connect/certs
DASHBOARD_OIDC_ADMIN_ROLE=forwarder-admin
DASHBOARD_OIDC_VIEWER_ROLE=forwarder-viewer
DASHBOARD_OIDC_ROLE_CLAIM=roles
DASHBOARD_ALLOWED_ORIGIN=https://forwarder.example.com

AUDIT_WEBHOOK_URL=https://audit.example/v1/records
AUDIT_WEBHOOK_TOKEN_FILE=/run/secrets/audit_webhook_token

BACKUP_OFFSITE_REQUIRED=true
BACKUP_OFFSITE_URL_TEMPLATE=https://backup.example/telegram-forwarder/{artifact}
BACKUP_OFFSITE_TOKEN_FILE=/run/secrets/backup_offsite_token
BACKUP_ENCRYPTION_KEY_FILE=/run/secrets/backup_encryption_key
```

Für dasselbe Secret dürfen direkter Wert und `_FILE` nie gleichzeitig gesetzt sein. Secret-Dateien gehören nicht in den Workspace, nicht in Images, nicht in Backups und nicht in Logs. Der Reverse-Proxy entfernt eingehende `Authorization`-Header und injiziert ausschließlich ein von ihm verifiziertes, kurzlebiges Access-Token. `WEB_HOST` bleibt auf Host-Ebene Loopback; nur innerhalb des isolierten Compose-Netzes bindet der Container auf `0.0.0.0`.

## 6. Einmalige Telegram-Anmeldung

Die TDLib-Anmeldung findet vollständig im Dashboard statt und ist eine Account-Bootstrap-Aktion, keine inhaltliche Human-in-the-loop-Freigabe für Nachrichten:

1. Unter **Channels** Telegram API ID und API Hash sowie Quelle und Ziel speichern.
2. Im Dashboard **Start Forwarder** wählen.
3. Die angeforderte Telefonnummer im internationalen Format eingeben.
4. Telegram-/E-Mail-Code und bei Bedarf das 2FA-Passwort im jeweils angezeigten Web-Prompt eingeben oder die Anmeldung auf einem bereits angemeldeten Gerät bestätigen.
5. Auf `connected` und anschließend `readyz=200` prüfen.

Codes und Passwörter werden nur an das aktive TDLib-Promise übergeben, nicht persistiert und nicht über Statusendpunkte zurückgegeben. Danach gelten:

- `forwarder_session_data` und `forwarder_session_files` bleiben über Container-Neuerstellungen persistent;
- Staging und Produktion verwenden getrennte Accounts und Verzeichnisse;
- Sessiondaten werden nie in Git, Build-Artefakte oder Support-Tickets aufgenommen;
- ein Sessionverlust wird durch erneutes Starten und die Web-Anmeldung behoben, nicht über ein SQLite-Restore.

## 7. Nutzung und täglicher Betrieb

Start und Update im Standalone-Modus:

```bash
docker compose up --build -d
docker compose ps
docker compose logs --tail=200 forwarder
```

Kontrollierter Stopp ohne Datenlöschung:

```bash
docker compose down
```

`docker compose down -v` löscht die persistenten Volumes und ist ausschließlich für einen bewusst bestätigten Total-Reset zulässig. Für normale Updates darf `-v` nie verwendet werden.

Status prüfen:

```bash
curl --fail http://127.0.0.1:9100/healthz
curl --fail http://127.0.0.1:9100/readyz
curl --fail http://127.0.0.1:9100/metrics
```

`healthz=200` beweist nur, dass der Prozess antwortet. Nur `readyz=200` erlaubt Routing; Telegram, DB, Queue, Backup, Audit, Retention, Disk und weitere Einzelchecks müssen dabei grün sein. Nach jedem Update werden im Dashboard Verbindung, Queue, `failed`/`unknown`-Outbox, letzter erfolgreicher Forward und Backupstatus geprüft.

Nur für Quellcode-Entwicklung außerhalb Docker:

```bash
npm ci
npm ci --prefix frontend
npm run dev
```

## 8. Produktionsstart mit Compose

Der einfache lokale Build ist für Standalone und Staging gedacht:

```bash
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:${HOST_METRICS_PORT:-9100}/healthz
curl --fail http://127.0.0.1:${HOST_METRICS_PORT:-9100}/readyz
```

Für ein echtes Release wird **nicht** das frei neu gebaute lokale Tag deployt. Deployt wird der vom Release-Workflow gescannte und attestierte GHCR-Digest aus `release-manifest.json`, beispielsweise `ghcr.io/<owner>/<repo>@sha256:<digest>`:

```bash
export FORWARDER_IMAGE='ghcr.io/<owner>/<repo>@sha256:<digest>'
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml pull
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d --no-build
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml images
```

`FORWARDER_IMAGE` wird sowohl für den Forwarder als auch den Alert-Relay gesetzt. `--no-build` verhindert, dass der freigegebene Digest unbemerkt durch ein lokales Build ersetzt wird. Tag, Digest und Ausgabe von `docker compose images` werden im Deployment-Record festgehalten.

Nach dem ersten Start müssen innerhalb des freigegebenen Wartungsfensters geprüft werden:

1. Container läuft als `node`, Root-Dateisystem ist read-only, Capabilities sind entfernt.
2. `healthz` und `readyz` sind grün; keine Restart-Schleife ist sichtbar.
3. Prometheus scraped den Dienst und alle Alert-Regeln sind geladen.
4. Ein Testalarm erreicht mit derselben `correlation_id` das Incident-System.
5. Ein Backup wird lokal erstellt, off-host hochgeladen, zurückgelesen, entschlüsselt und vollständig verifiziert.
6. Audit-Mutationen erscheinen lokal verkettet und unveränderlich off-host.
7. Der echte Staging-E2E-Test liefert exakt eine Nachricht.

## 9. Dashboard und API sicher bedienen

Viewer dürfen Status, redigierte Konfiguration, Logs, Metrikhistorie und Outbox lesen. Nur Admins dürfen mutieren. Browser-Mutationen benötigen zusätzlich den Dashboard-Request-Header; destruktive oder duplikatgefährdete Aktionen benötigen einen aktionsspezifischen Bestätigungsheader.

Ungeklärte Outbox-Einträge abrufen:

```bash
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  "http://127.0.0.1:8080/api/outbox?status=failed,unknown"
```

Eine `unknown`-Zustellung wird zuerst im Zielkanal reconciled:

- nachweislich vorhanden: `/api/outbox/acknowledge` mit `X-Destructive-Confirmation: acknowledge-unknown-delivery` und konkreter Begründung;
- nachweislich nicht vorhanden: `/api/outbox/retry` mit `X-Destructive-Confirmation: retry-unknown-delivery`;
- weiterhin unklar: Eintrag bleibt `unknown`, Routing gegebenenfalls stoppen und eskalieren.

Es gibt absichtlich keinen automatischen Retry für `unknown`, weil das Duplikatrisiko nicht beweisbar ist. Diese Operator-Reconciliation ist Incident-Handling und keine inhaltliche Freigabe jedes normalen KI-Signals.

## 10. Automatische KI-Verarbeitung ohne Human-in-the-loop

Vor jedem Provideraufruf greifen Zeichen-, Token-, Request-, Tagesbudget-, Timeout-, Retry- und Backoff-Grenzen. Akzeptiert wird nur exakt gültiges XML mit erlaubten Werten, lückenlosen Targets und konsistenter LONG-/SHORT-Geometrie. Providerfehler, Timeouts, unbekannte Templates, Schemaabweichungen und Budgetüberschreitungen führen zu keiner Weiterleitung.

Jede Änderung an Modell, Prompt, Template, Schema oder Parser benötigt:

```bash
npm test
npm run test:coverage
npm run test:mutation
npm run test:ai-eval
```

`test:ai-eval` verwendet den echten Staging-Provider und kann Kosten verursachen. Das Ergebnis muss Modell-, Prompt-/Template-Hash, Parser-Version und denselben Commit wie das Release ausweisen. Sinkende Golden-Set-Qualität, unerwartete Annahme adversarialer Eingaben, instabiles Schema oder Budgetüberschreitung blockieren den Release.

## 11. Normalbetrieb und 15-Minuten-Triage

On-Call muss binnen 15 Minuten beantworten können: Welche Quelle und Outbox-ID ist betroffen, wurde zugestellt, wie groß ist der Datenumfang und ist ein Retry sicher? Die Reihenfolge ist:

1. `healthz`/`readyz` und deren Einzelchecks sichern.
2. In strukturierten Logs nach `correlation_id`, `outbox_id`, `attempt`, `outcome` und `error_code` filtern.
3. `failed` und `unknown` aus der Outbox abrufen.
4. Telegram-Verbindung, Pending-Alter, Queue, AI-Budget, Audit, Backup, Retention und freien Speicher prüfen.
5. Erst danach stoppen, acknowledge/retry ausführen oder eskalieren.

Verbindliche Alarmgrenzen, Crash-Loop-Ablauf und konkrete API-Schritte stehen in [operations.md](runbooks/operations.md). Lockdateien, DB/WAL/SHM oder ungeklärte Outbox-Einträge werden niemals zur vermeintlichen Reparatur blind gelöscht.

## 12. Backup, Restore und Rollback

Backup erstellen und prüfen:

```bash
docker compose exec -T forwarder /nodejs/bin/node dist/backup_cli.js create /app/backups
docker compose exec -T forwarder sh -c 'ls -1dt /app/backups/backup-* | head -1'
docker compose exec -T forwarder /nodejs/bin/node dist/backup_cli.js verify /app/backups/<artifact-name>
```

Restore:

```bash
# Dienst und alle Nebeninstanzen zuerst vollständig stoppen; Volumes behalten.
docker compose down
docker compose run --rm --no-deps --entrypoint /nodejs/bin/node forwarder dist/backup_cli.js restore /app/backups/<artifact-name>
docker compose up -d
```

Das Restore-Kommando verweigert aktive Prozess-/Routing-Locks, validiert Manifest, Checksummen, SQLite-Integrität, Pflicht-Tabellen und Secret-Freiheit und bewahrt den ersetzten Zustand als `.pre-restore-*`. Danach werden Counts, `readyz`, Outbox und ein synthetischer E2E-Flow geprüft.

Bei einer inkompatiblen Migration wird nur der zum vorherigen Binary gehörende geprüfte Pre-Migration-Snapshot verwendet:

```bash
docker compose down
docker compose run --rm --no-deps --entrypoint /nodejs/bin/node forwarder dist/migration_cli.js restore \
  /app/session_data/.migration-backups/pre-migration-....db --confirm-restore-pre-migration
docker compose up -d
```

Ein Rollback gilt erst als bewiesen, wenn der exakte vorherige Image-Digest mit dem passenden DB-Zustand gestartet, Readiness grün und eine Zustellung bestätigt wurde. Ein theoretischer Plan oder nur ein erfolgreiches Backup ist kein Restore-Nachweis.

## 13. Release-Ablauf

1. Kritischen Requirement-Contract, Akzeptanzkriterien, ADR und PR-Risikowert verlinken.
2. PR-Gates und die gemäß Score erforderlichen Reviews abschließen.
3. Main-Workflow, Container-Scan, SBOM, SAST und Secret-History-Scan müssen grün sein.
4. `staging.yml` muss für exakt denselben Commit erfolgreich sein.
5. `production_evidence.yml` muss ein vollständiges, gültiges 30-Tage-Fenster nachweisen.
6. Restore-/Rollback-Probe, Alertzustellung, On-Call und Change-Fenster im Release-Record belegen.
7. `package.json`-Version und `CHANGELOG.md` aktualisieren; signierten Tag `v<version>` erstellen.
8. Der Tag-Workflow veröffentlicht nur den zuvor gescannten Image-Kandidaten, SBOMs, Scans, Manifest und Attestationsnachweise.
9. Ausschließlich den Digest aus dem veröffentlichten Manifest deployen.
10. Post-Deploy: `readyz`, Outbox, Backup-Frische, Audit, Alerting und synthetische Zustellung prüfen.

Ein Gate darf nur über einen gültigen, höchstens 30 Tage laufenden Record unter `docs/risk-acceptances/` behandelt werden. Die in `QUALITY_OS.md` ausdrücklich nicht akzeptierbaren Blocker können auch damit nicht freigegeben werden.

## 14. Enterprise-Nachweise und aktuelle offene Punkte

Der Code und die automatisierbaren lokalen Kontrollen sind implementiert. Die folgenden Punkte hängen von realen Identitäten, Infrastruktur oder verstrichener Betriebszeit ab und dürfen nicht durch Beispieldaten ersetzt werden:

| Nachweis | Aktueller Repository-/Workspace-Status | Für Production-GO erforderlich |
| --- | --- | --- |
| GitHub-Remote und reale CODEOWNERS | **NICHT VERIFIZIERT**: Im lokalen Repository ist kein Remote konfiguriert; reale Owner können nicht abgeleitet werden. | Remote einrichten, auflösbare Benutzer/Teams in `.github/CODEOWNERS`, fehlerfreie GitHub-Auswertung |
| Branch Protection und Security-Features | **NICHT VERIFIZIERT** ohne GitHub-Repository und berechtigtes Token | `npm run quality:github-governance` muss alle Reviews, Required Checks, Adminschutz, Dependency Graph, Secret Scanning und Push Protection belegen |
| Geschützte Environments und Runner | **NICHT VERIFIZIERT** | Getrennte `staging`- und `production-observer`-Environments/Runner mit minimalen Rechten |
| Container-Build und -Scan | **NICHT LOKAL VERIFIZIERT**: Docker-Client ist vorhanden, Engine war bei der letzten Prüfung nicht erreichbar. | Erfolgreicher CI-Build, Native-Import-Test, non-root-Prüfung, HIGH/CRITICAL-Scan und Container-SBOM |
| OIDC und TLS-Proxy | **NICHT VERIFIZIERT**: keine reale Issuer-/Proxy-Evidenz im Repository | Signatur-/Rollen-/Origin-Negativtests gegen Staging, TLS-Konfiguration und Header-Stripping belegen |
| Unveränderlicher Audit-Empfänger | **NICHT VERIFIZIERT** | Reale Vorabpersistenz, idempotenter Replay, Retention und Alarm bei Ausfall nachweisen |
| Verschlüsselter Off-host-Backup-Store | **NICHT VERIFIZIERT** | Reales PUT/GET, unabhängiger Schlüssel, Download/Decrypt/Restore und gemessenes RPO/RTO belegen |
| Incident-Empfänger und On-Call | **NICHT VERIFIZIERT** | `npm run ops:test-alert -- --confirm-alert-delivery`, identische `correlation_id`, Eskalation und Owner im Record |
| Echter Telegram-Staging-E2E | **NICHT VERIFIZIERT** ohne isolierten Account/Chats/Runner | Erfolgreiches `staging.yml`-Artefakt für exakt den Release-Commit, exakt eine Zielnachricht |
| Live-AI-Golden-Set des Release-Commits | Muss pro KI-relevantem Release neu belegt werden | Erfolgreiches `npm run test:ai-eval` auf Staging mit freigegebenem Provider/Modell |
| Reale Restore-/Rollback-Übung | Lokale automatisierte Tests ersetzen keine Infrastrukturübung | Off-host-Restore und vorheriger Image-Digest mit Datenabgleich und gemessener Dauer |
| 30-Tage-Stabilität und SLO | **NICHT VERIFIZIERT**, solange kein vollständiges reales Messfenster vorliegt | `npm run ops:soak`: mindestens 30 Tage, 99,5 %, mindestens 100 Versuche, keine `unknown`, P95 und Ressourcenlimits eingehalten |

Solange eine dieser für den konkreten Release relevanten Zeilen offen ist, lautet die Produktionsentscheidung **NO-GO**. Die Workflows blockieren Tag-Releases bei fehlender Staging-, Produktions-, Governance-, Scan- oder Artefaktevidenz; offen bedeutet damit nicht „später prüfen“, sondern „noch nicht veröffentlichen“.

## 15. Abnahmeprotokoll

Vor GO werden im Release-Record mindestens diese Werte und Links festgehalten:

```text
Release-Tag / Commit / Image-Digest:
Quality-Workflow:
Staging-E2E-Artefakt:
Live-AI-Eval-Artefakt:
Container-Scan und SBOM:
GitHub-Governance-Evidenz:
Off-host-Backup + Restore-Dauer:
Rollback-Digest + Ergebnis:
Testalarm-correlation_id:
30-Tage-Soak-Artefakt:
OIDC-/TLS-Negativtest:
On-Call / Eskalationsweg:
Offene Risikoakzeptanzen:
Finale Entscheidung (GO/NO-GO):
```

Fehlende oder widersprüchliche Evidenz wird als fehlgeschlagen bewertet. Damit bleibt der Betriebszustand reproduzierbar, auditierbar und ohne still akzeptierte Risiken.
