# TSX Core – Quality Operating System

## Ziel und Geltungsbereich

Jeder Merge muss Qualität, Sicherheit, Betriebsstabilität und Änderbarkeit mindestens erhalten. Dieses Quality OS gilt für Backend, Dashboard, KI-Prompts und -Schemas, dynamische Signalverträge, MCP, Container, Konfiguration, Datenbank und Betriebsdokumentation. Ein grüner Einzeltest ersetzt kein Gate; widersprüchliche Evidenz führt zum strengeren Ergebnis.

## Requirement Contract

Für jedes neue oder geänderte kritische Feature wird vor Implementierung diese Tabelle im Issue oder PR ausgefüllt:

| Business-/Systemziel | Input Contract          | Output Contract    | Invarianten         | Side Effects             | Failure Policy              | Observability        | Test Evidence | Owner   |
| -------------------- | ----------------------- | ------------------ | ------------------- | ------------------------ | --------------------------- | -------------------- | ------------- | ------- |
| _messbares Ziel_     | _Schema, Grenzen, Auth_ | _Schema, Semantik_ | _muss immer gelten_ | _DB, Telegram, Provider_ | _fail closed/retry/unknown_ | _Log, Metrik, Alarm_ | _Test/Run-ID_ | _Rolle_ |

Fehlt der Contract für einen kritischen Pfad, ist Correctness nicht beweisbar und der Release bleibt **NO-GO**.

### Verbindliche Contracts der kritischen Produktpfade

| Business-/Systemziel | Input Contract | Output Contract | Invarianten | Side Effects | Failure Policy | Observability | Test Evidence | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Standalone-Webzugang ohne Token-Dialog | Host-Loopback, Token-Modus, `dashboardLocalTrust=true`, Same-Origin und Dashboard-Header | Sessiongebundener Admin-Zugang | Enterprise/OIDC deaktiviert den Pfad; lokale Prozesse des dedizierten Single-User-Hosts liegen in der Trust Boundary | Verwalteten Admin-Key erzeugen/lesen | Abweichende Origin/Betriebsart/Secret-Quelle wird abgewiesen; beschädigte Managed-Dateien starten nur eine lokale Repair-Plane | Security-/Audit-Log, Request-ID; klar markierter Recovery-Log bei fehlender Audit-Kette | `test_web_server.js`, Docker-Startup-Smoke | Security Owner |
| Web-Konfiguration und Secrets | Allowlist-Schema, exakte Typen; Secrets nur write-only | Atomar validierte Konfiguration bzw. Status ohne Klartext | String `"false"` aktiviert nie Side Effects; unbekannte Felder werden nicht persistiert; Backup-Key ist unveränderlich | Routing-/AI-/Enterprise-Verhalten | Invalid = HTTP 400/409 ohne Änderung | Audit authorized/completed | `test_config.js`, `test_secret_store.js`, `test_runtime_settings.js`, `test_web_server.js` | Security + Operations Owner |
| AI-Signalverarbeitung ohne HITL | Freigegebene Quelle, akzeptierter externer Datenvertrag, begrenzter Input, versioniertes Prompt/Modell | Exaktes geerdetes XML oder kein Side Effect | Kein Raw-Fallback bei Provider-/Timeout-/Schemafehler; Safety-Suffix und Budgets bleiben erzwungen | Vollständige Nachricht an OpenRouter; optional Telegram-Zustellung | Unklar/ungültig/Quota/Timeout = fail closed | Provenance, Usage, Failure, SLO | `test_signal_parser.js`, `evaluate_signal_golden_set.js`, `test_staging_e2e.js` | AI/Domain + Data Owner |
| Dauerhafte Telegram-Zustellung | Deduplizierte Inbox und persistierter Outbox-Task | Bestätigter Abschluss oder `failed`/`unknown` | `unknown` wird nie automatisch wiederholt; Idempotenz-ID bleibt stabil; höchstens 200 wartende Tasks liegen im RAM, der Rest bleibt in SQLite | Telegram-Nachricht und DB-Status | Timeout/Restart/Teilfehler werden reconciled; Backpressure verwirft keine DB-Tasks | Correlation-ID, Outbox, Pending-Alter-Alarm | `test_outbox.js`, `test_outbox_scheduler.js`, `test_process_lock.js`, `test_delivery_tracker.js`, `test_integration.js` | Domain + SRE Owner |
| Backup/Off-site-Recovery/Restore | Verifiziertes Artefakt oder valider `.tgfb`-Name; unveränderlicher AES-Key; Bestätigung | GCM-/Checksum-/SQLite-verifiziertes lokales Artefakt und atomarer Restore | Vor Quiesce verifizieren; vorherigen Zustand bewahren; Runtime-Einstellungen/Templates werden mitgesichert, Secrets/TDLib absichtlich nicht; Download und Expansion begrenzen | Backup-Gateway, Dateiersatz, Restart | Korruption = kein Quiesce bzw. Rollback | Backup-Status, Objektname, Audit | `test_backup.js`, `test_backup_replication.js`, `test_web_server.js`, Docker-Restore-Smoke | Data Owner + SRE |
| Vollständiger Factory Reset | Admin, exakte Bestätigung, alle Pfade/Secret-Quellen vorab löschbar | Sicherer Erststart mit Default-Konfiguration | Preflight vor Stilllegung; lokaler Zustand einschließlich Audit wird entfernt; AES-Key-Löschung bewirkt Crypto-Erasure | Stop, Volume-/Key-Löschung, Restart | Preflight-Fehler = keine Stilllegung; Unterbrechung bleibt fail closed | Remote-Audit, Reset-Status, Bootstrap | `test_secret_store.js`, `test_web_server.js`, Docker-Reset-Smoke | Security + Data Owner |
| Enterprise-Control-Plane | OIDC mit getrennten Rollen, exakter Origin, Remote-Audit, Incident-Relay und Off-site-Backup | Rollenbegrenzte UI/API | Kein Local Trust; Mutationen seriell; Audit vor Exit geflusht | Identity-/Audit-/Alert-/Backup-Aufrufe | Fehlende Integration blockiert Mutation/Startup | Audit, Alerts, SLO | `test_dashboard_auth.js`, `test_audit_trail.js`, `test_alert_relay.js`, `frontend/tests/system-tab.test.tsx` | Security + SRE |
| Dynamischer Signalvertrag | begrenzte deklarative Definition als Entwurf, Admin, Vorschau-XML/Quelle | immutable publizierte Version mit SHA-256 oder Validierungsfehler | kein User-Code; eindeutige Pfade; Geometry/Grounding; referenzierte Version nicht archivierbar | Vertrags-/Profilzustand und `contract_changed` | ungültig/unpubliziert/unbekannt = kein Trade, kein Fallback | Audit, Contract-Event, Version/Hash | `test_trading_core.js`, `test_trading_web_control.js`, `test_web_server.js`, `frontend/tests/trading-tab.test.tsx` | Trading Domain + Security |
| Automatisches Futures-Trading | Strikt validiertes ausführbares Signal mit aktiver Profil-/Vertragsversion und USD/USDC/USDT-Quote, publizierte Strategieversion, aktivierte Kanalroute und verifiziertes Konto | Idempotenter Entry plus manuelle oder adaptive reduce-only TP/SL-Staffel oder blockierter Intent | Dezimalstrings; ein Owner je Konto/Symbol; Protective Stop zwingend; adaptiver Stop nur in Gewinnrichtung; letzter TP schließt Rest; Kanalrisiko kann globale Caps nicht erhöhen; kein Blind-Retry; Live separat freigegeben | Hyperliquid/Bybit Order und persistierter Trade-/Telemetry-Zustand | Unbekanntes/deaktiviertes Profil, Kanalblock, Unknown Order, fremde Exposure, Stop-Fehler oder Reconcile-Ausfall = kein Trade beziehungsweise Kill-Switch/fail closed; kein HIL pro Trade | Trading-/Kanalmetriken, Execution-Latenz, Risk Events, Orders/Fills/Positionen, Audit | `test_signal_parser.js`, `test_trading_core.js`, `test_trading_engine.js`, `test_trading_failures.js`, `test_official_exchange.js`, `test_trading_web_control.js`, `test_web_server.js`, `frontend/tests/trading-tab.test.tsx`, `frontend/tests/analytics-tab.test.ts` | Trading Domain + Security + SRE |
| Tailnet-Remotezugriff | explizit vertrauter lokaler Tailscale-Serve-Proxy, exakte `https://*.ts.net`-Origin, Admin-/Viewer-Login-Allowlist | pseudonyme Dashboard-Identität mit Rolle | Dashboard bleibt Loopback; Funnel aus; Header ohne Trusted-Proxy-Modus wertlos | authentifizierte Dashboard-Aufrufe | unbekannter Login/Header/Origin = 401/403; ungültige Konfiguration blockiert Start | Access-Status, Security-/Audit-Log | `test_dashboard_auth.js`, `test_runtime_settings.js`, `test_web_server.js` | Security + SRE |
| MCP-Agentensteuerung | gültiger gehashter Agenten-Bearer, aktive Sitzung, aktuelles dauerhaftes Minimalrecht, valides Tool-Schema | begrenztes Read-Ergebnis oder auditierte Kontrollantwort | keine Exchange-Secrets/Adapter im MCP-Prozess; Recht pro Aufruf erneut prüfen; Write nur via persistente Bridge + Vorab-Audit + `TradingWebControl`; Wartungsmarker vor DB-Ersatz | Agenten-/Sitzungs-/Aktions-/Request-/Event-Zustand; mögliche Trading-Aktion | Auth/Recht/Schema/Audit/Bridge-Timeout = fail closed; Event-Fehler retryfähig; keine direkte DB-Order | Agenten-Aktionen, Audit, Sessions, Event-Delivery, Latenz | `test_mcp_control_plane.js`, `test_mcp_server.js`, `test_web_server.js`, `frontend/tests/mcp-agents-tab.test.tsx` | Security + Trading Domain + SRE |

## PR-Risikowert

Jeder zutreffende Faktor wird einmal addiert. `scripts/calculate_pr_risk.js` berechnet die Summe aus dem tatsächlichen Git-Diff und veröffentlicht die JSON-Evidenz; der Autor verlinkt sie in der PR-Vorlage.

| Faktor                                                                      | Punkte |
| --------------------------------------------------------------------------- | -----: |
| Kritische Domäne: Zustellung, irreversible Aktion, PII oder KI-Entscheidung |      5 |
| Authentifizierung, Autorisierung oder Secret-Grenze                         |      5 |
| KI-Prompt, Modell, Tool oder automatische Nebenwirkung                      |      5 |
| DB-Migration oder persistentes Datenmodell                                  |      4 |
| Concurrency, Retry, Timeout, Idempotenz oder Shutdown                       |      4 |
| Public-API-/Event-Vertragsänderung                                          |      3 |
| Fehlender Regressionstest oder kritische Branch Coverage <80 %              |      3 |
| Neue Produktionsabhängigkeit oder Base Image                                |      2 |
| Änderung >500 LOC netto                                                     |      2 |

| Summe | Verbindliches Verfahren                                |
| ----: | ------------------------------------------------------ |
|   0–4 | Standard-Review                                        |
|   5–9 | Senior Review                                          |
| 10–14 | Security-/Architecture-Review plus Rollback-Plan       |
|   ≥15 | Kein Merge ohne explizite Freigabe und Staging-Evidenz |

## Gate-Matrix

`Fail` blockiert. `Evidence` muss als CI-Artefakt oder Release-Record verlinkt sein. Nicht anwendbare Gates benötigen eine begründete N/A-Zeile im PR.

| Gate                                              | Pull Request                  | Main     | Release/Tag               |
| ------------------------------------------------- | ----------------------------- | -------- | ------------------------- |
| Lockfile-Install, Lint, Typecheck                 | Fail                          | Fail     | Fail                      |
| Unit-/Integration-/Contract-Tests                 | Fail                          | Fail     | Fail                      |
| Kritische per-file Branch Coverage ≥80 %          | Fail                          | Fail     | Fail                      |
| Kernmodul-Coverage gegen Ratchet                  | Fail                          | Fail     | Fail                      |
| Mutation Score kritischer Module ≥70 %            | Fail                          | Fail     | Fail                      |
| Duplicate Ratio <5 %                              | Fail                          | Fail     | Fail                      |
| Complexity-/Längen-Budget (kein Wachstum)         | Fail                          | Fail     | Fail                      |
| Architekturregeln und Zyklen                      | Fail                          | Fail     | Fail                      |
| Browser-/Accessibility-Matrix (4 Browserprofile) | Fail                          | Fail     | Fail                      |
| Dependency-Audit ab Moderate                      | Fail                          | Fail     | Fail                      |
| Lizenz-Allowlist                                  | Fail                          | Fail     | Fail                      |
| Secret-History-Scan                               | Fail                          | Fail     | Fail                      |
| CodeQL SAST                                       | Fail                          | Fail     | Fail                      |
| SBOM Backend, Frontend, Container                 | Evidence                      | Evidence | Fail wenn fehlend         |
| Container HIGH/CRITICAL, non-root, Native Imports | Fail                          | Fail     | Fail                      |
| DB-Migration/Restore-Test                         | Bei DB-Änderung Fail          | Fail     | Fail                      |
| MCP-/Event-Contract-Kompatibilität                | Fail bei inkompatibler Änderung | Fail   | Fail                      |
| Live KI-Golden-Set mit Staging-Provider           | Bei KI-Änderung Fail          | Evidence | Fail                      |
| Synthetischer E2E-Flow                            | Optional                      | Evidence | Fail                      |
| Performance-/30-Tage-Soak                         | Bei Ressourcenänderung        | Evidence | Fail                      |
| Rollback- und Offline-Restore-Übung               | Bei betroffener Änderung      | Evidence | Fail                      |

Der Workflow `.github/workflows/quality.yml` implementiert die lokal automatisierbaren Gates einschließlich getesteter Alarmregeln. `.github/workflows/staging.yml`, `.github/workflows/synthetic.yml` und `.github/workflows/production_evidence.yml` erzeugen die externen Staging-/SLO-Nachweise; ein Tag-Release prüft erfolgreiche Läufe für exakt seinen Commit. Branch Protection, Runner-/Environment-Schutz, Eigentum am Off-host-Ziel, der konkrete Incident-Empfänger und die tatsächlichen Messwerte bleiben externe Kontrollen und müssen durch die Plattform beziehungsweise den Release-Record belegt werden.

Vor Veröffentlichung validiert `scripts/verify_github_governance.js` Branch Protection, konkrete Required Checks, Review-/CODEOWNERS-Regeln, Security-Features und die benötigten Environments direkt über die GitHub-API. Fehlende oder unprüfbare Plattformkontrollen blockieren den Release; die Einrichtung ist in `docs/GITHUB_GOVERNANCE.md` beschrieben.

Das in `quality-baseline.json` geratchete Budget steht bei null ESLint-Warnungen sowie null Complexity-, Nesting- und Funktionslängen-Hotspots. `npm run quality:complexity` blockiert jede neue Warnung oder Budgetabweichung. Das Budget darf nie erhöht werden, außer über einen gültigen zeitlich befristeten Risikoakzeptanz-Record.

`npm run test:coverage` erzwingt zusätzlich mindestens 80 Prozent je Datei für die besonders kritischen Zustellungs-, Retry-, Schema-, Backup- und SLO-Module. `npm run test:coverage:modules` misst alle testbaren Kernmodule und blockiert jede Unterschreitung von `coverage-baseline.json`. Der am 26.07.2026 bestätigte Ratchet liegt bei 94,62 % Statements, 82,86 % Branches, 98,71 % Functions und 94,62 % Lines. Ausgenommen sind ausschließlich die Composition Roots `forwarder.ts`/`mcp_server.ts` und die bestätigungspflichtigen Wartungsprogramme `*_cli.ts`; ihre Verdrahtung wird durch Build, Contract-/MCP-Protokolltests und den echten Staging-E2E-Lauf validiert, nicht als Unit-Coverage ausgegeben.

### Externe Codeanalyse

`.sonarcloud.properties` setzt UTF-8, Python 3.12 und disjunkte Produktions-/Testpfade. Damit überschneiden sich `sonar.sources` und `sonar.tests` nicht, und testbezogene Regeln werden auf `tests`, `frontend/tests`, `frontend/e2e`, `exchange_executor/tests` und `monitoring/rules.test.yml` angewendet. Eine Änderung der Verzeichnisstruktur muss diese Datei im selben Commit aktualisieren.

SonarQube-Cloud-Funde können revisionsgebunden und read-only exportiert werden:

```bash
SONAR_TOKEN='from-secret-store' \
SONAR_PROJECT_KEY='owner_project' \
SONAR_EXPECTED_REVISION='40-character-commit' \
npm run quality:sonar-export
```

Der Token gehört ausschließlich in einen Secret Store beziehungsweise eine kurzlebige Prozessumgebung und niemals in Repository, Dokumentation, Shell-Historie oder Log. Aikido-, Sonar- und andere externe Findings werden auf tatsächliche Erreichbarkeit und Substanz geprüft; ein False Positive benötigt nachvollziehbare Evidenz, aber kein Finding darf pauschal ausgeblendet werden. Die verpflichtenden Repository-Gates bleiben unabhängig davon bestehen.

## Gate-Ausnahmen

Ein Gate wird nie still übersprungen. Eine Ausnahme benötigt vor dem Merge eine Datei `docs/risk-acceptances/RA-<datum>-<slug>.md`, eine Laufzeit von höchstens 30 Tagen, benannte Owner und Approver, konkrete Evidenz, kompensierende Kontrollen und Exit-Kriterien. `npm run quality:risk-acceptances` blockiert ungültige oder abgelaufene Records. Kritische Sicherheitslücken, ungetestete Migrationen, fehlender Rollback, kritische Flows ohne Test, unverifizierter Restore und ungeklärte irreversible KI-Aktionen sind nicht akzeptierbar.

## Traceability

Für kritische Änderungen muss der PR diese Kette vollständig verlinken:

`Requirement → Acceptance Criteria → ADR → Commit/PR → Review → Testfall → Build/SBOM → Deployment → SLO/Alert → Incident → Regressionstest`

Jede fehlende Kante wird als `TRACEABILITY GAP` markiert. Ein Incident wird erst geschlossen, wenn Ursache, Datenumfang, sichere Wiederholung und Regressionstest dokumentiert sind.

Benutzer-, API-, Betriebs- oder Sicherheitsverhalten gilt erst dann als dokumentiert, wenn mindestens `README.md`, der zuständige Fachleitfaden, betroffene Runbook-Schritte, ADR/Architektur bei Vertragsänderungen und `CHANGELOG.md` konsistent sind. Historische ADR-Entscheidungen werden nicht umgeschrieben, sondern durch eine datierte Ergänzung oder einen neuen ADR fortgeführt.

## Release Engineering

Pflichtartefakte je Release:

1. SemVer-Tag und Changelog-Eintrag.
2. Grüner `Quality OS`-Workflow mit unveränderlichen Action-SHAs.
3. CycloneDX-SBOMs und Container-Scan.
4. Migrations-/Downgrade- und Rollback-Plan oder belegtes N/A.
5. Staging-Smoke inklusive synthetischer Telegram-Zustellung.
6. Bei KI-Änderungen: Live-Golden-Set mit Modell-, Prompt-, Template- und Parser-Version.
7. Offline-Restore mit gemessener Dauer, Datenabgleich und Rollback-Probe.
8. Benannter On-Call und verifizierte Alarmzustellung.

Automatisches **NO-GO** gilt bei jedem fehlenden Pflichtartefakt sowie bei kritischer Sicherheitslücke, unbekannter Zustellung ohne Reconciliation, fehlendem Monitoring oder überschrittenem AI-Budget-/Schema-Gate.

## SLOs und Error Budget

Die Werte sind die initialen verbindlichen Ziele; sie werden nach dem ersten belastbaren 30-Tage-Fenster nur per ADR geändert.

| SLI                                         |                SLO (30 Tage) |        Error Budget | Aktion bei Verletzung                                   |
| ------------------------------------------- | ---------------------------: | ------------------: | ------------------------------------------------------- |
| Bestätigte Zustellungen / akzeptierte Tasks |                      ≥99,5 % |               0,5 % | Feature-Freeze; Outbox und Provider-Ursache analysieren |
| `unknown` Zustellungen                      |                            0 |                   0 | Sofort alarmieren; keine automatische Wiederholung      |
| P95 akzeptiert → bestätigt                  |                        ≤60 s | 5 % Fenster darüber | Queue/Telegram/Provider aufteilen; Kapazität begrenzen  |
| Ältester `pending` Task bei erwarteter Last |                       <5 min |               5 min | Readiness/Alarm; sichere Wiederaufnahme prüfen          |
| Readiness-Verfügbarkeit                     |                      ≥99,5 % |          3 h 36 min | Error-Budget-Freeze und Ursachenreview                  |
| KI-Golden-Set exakte Erwartung              |           100 % Release-Gate |                   0 | Modell-/Prompt-Release blockieren                       |
| KI-Kosten/Tag                               | ≤ konfiguriertes Tagesbudget |    0 Überschreitung | Provider-Aufrufe fail closed blockieren                 |
| Lokal und Off-host restore-verifiziert      |                      ≤15 min |                   0 | Readiness rot; Off-host-Pipeline reparieren             |
| Retention-Lauf ohne Backlog                 |                       ≤12 h |                   0 | Readiness rot; Kapazität und Batchgrenze prüfen         |
| Freier operativer Speicher                  | `≥ DATA_MIN_FREE_BYTES`      |                   0 | Routing stoppen; Kapazität sicher erweitern             |
| Trading Orders mit `unknown` Ausgang        |                            0 |                   0 | Kill-Switch; Exchange-Historie, keine Blind-Wiederholung |
| Managed Position ohne bestätigten Stop      |                            0 |                   0 | Sofort alarmieren und reduce-only Notfall-Flatten        |
| Reconciliation-Alter bei aktiver Execution  |                        ≤30 s |                   0 | Execution sperren; Executor/Exchange untersuchen         |
| Trading Kill-Switch im Steady State         |                            0 |                   0 | Release-/Feature-Freeze bis Ursachenbeleg                |
| Paper/Testnet Trade Intents im Soak         |                     ≥100/30d |                  100 | 30-Tage-Gate bleibt NO-GO                                |

Synthetische E2E-Prüfungen laufen im Staging mindestens alle 15 Minuten. Monatlich werden Restore und kontrollierter Provider-/Netzwerkausfall geübt. Postmortems sind blameless, aber ein Regressionstest für jede technisch reproduzierbare Incident-Ursache ist verpflichtend.

## AI Governance ohne Runtime-HITL

Das System leitet akzeptierte KI-Ergebnisse automatisch weiter; es gibt bewusst keinen Human-in-the-loop im Runtime-Pfad. Fail-closed-Schema, Grounding gegen die Eingabenachricht, erlaubte Werte, Geometrie, Token-/Request-/Tagesbudgets, Timeouts und Provenance sind daher unverzichtbare Freigabebedingungen. Modell, Prompt-Hash, Template, Schema und Parser werden je Ergebnis protokolliert; Rechte bleiben auf die konfigurierte Zielzustellung begrenzt. Ein Kill Switch ist über Routing-Stopp/Readiness und den begrenzten Container-Restart vorhanden.

Ein AI-Release ist **NO-GO**, wenn Golden-Set-Qualität sinkt, adversariale Fälle akzeptiert werden, das Output-Schema instabil ist, Budget oder Latenz überschritten werden oder Provenance/Rollback fehlen.
