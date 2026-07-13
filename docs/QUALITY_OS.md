# Quality Operating System

## Ziel und Geltungsbereich

Jeder Merge muss Qualität, Sicherheit, Betriebsstabilität und Änderbarkeit mindestens erhalten. Dieses Quality OS gilt für Backend, Dashboard, KI-Prompts und -Schemas, Container, Konfiguration, Datenbank und Betriebsdokumentation. Ein grüner Einzeltest ersetzt kein Gate; widersprüchliche Evidenz führt zum strengeren Ergebnis.

## Requirement Contract

Für jedes neue oder geänderte kritische Feature wird vor Implementierung diese Tabelle im Issue oder PR ausgefüllt:

| Business-/Systemziel | Input Contract          | Output Contract    | Invarianten         | Side Effects             | Failure Policy              | Observability        | Test Evidence | Owner   |
| -------------------- | ----------------------- | ------------------ | ------------------- | ------------------------ | --------------------------- | -------------------- | ------------- | ------- |
| _messbares Ziel_     | _Schema, Grenzen, Auth_ | _Schema, Semantik_ | _muss immer gelten_ | _DB, Telegram, Provider_ | _fail closed/retry/unknown_ | _Log, Metrik, Alarm_ | _Test/Run-ID_ | _Rolle_ |

Fehlt der Contract für einen kritischen Pfad, ist Correctness nicht beweisbar und der Release bleibt **NO-GO**.

## PR-Risikowert

Jeder zutreffende Faktor wird einmal addiert. Der Autor trägt Summe und Evidenz in die PR-Vorlage ein.

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
| Mutation Score kritischer Module ≥70 %            | Fail                          | Fail     | Fail                      |
| Duplicate Ratio <5 %                              | Fail                          | Fail     | Fail                      |
| Architekturregeln und Zyklen                      | Fail                          | Fail     | Fail                      |
| Dependency-Audit ab Moderate                      | Fail                          | Fail     | Fail                      |
| Lizenz-Allowlist                                  | Fail                          | Fail     | Fail                      |
| Secret-History-Scan                               | Fail                          | Fail     | Fail                      |
| CodeQL SAST                                       | Fail                          | Fail     | Fail                      |
| SBOM Backend, Frontend, Container                 | Evidence                      | Evidence | Fail wenn fehlend         |
| Container HIGH/CRITICAL, non-root, Native Imports | Fail                          | Fail     | Fail                      |
| DB-Migration/Restore-Test                         | Bei DB-Änderung Fail          | Fail     | Fail                      |
| Breaking-API-Check                                | N/A: keine externe Public API | N/A      | N/A, bis Vertrag entsteht |
| Live KI-Golden-Set mit Staging-Provider           | Bei KI-Änderung Fail          | Evidence | Fail                      |
| Synthetischer E2E-Flow                            | Optional                      | Evidence | Fail                      |
| Performance-/30-Tage-Soak                         | Bei Ressourcenänderung        | Evidence | Fail vor Erstproduktion   |
| Rollback- und Offline-Restore-Übung               | Bei betroffener Änderung      | Evidence | Fail                      |

Der Workflow `.github/workflows/quality.yml` implementiert die lokal automatisierbaren Gates. Branch Protection, Staging-Zugang, Alarmziel, Off-host-Backup und Produktions-SLOs sind externe Kontrollen und müssen separat belegt werden.

## Gate-Ausnahmen

Ein Gate wird nie still übersprungen. Eine Ausnahme benötigt vor dem Merge eine Datei `docs/risk-acceptances/RA-<datum>-<slug>.md`, eine Laufzeit von höchstens 30 Tagen, benannte Owner und Approver, konkrete Evidenz, kompensierende Kontrollen und Exit-Kriterien. `npm run quality:risk-acceptances` blockiert ungültige oder abgelaufene Records. Kritische Sicherheitslücken, ungetestete Migrationen, fehlender Rollback, kritische Flows ohne Test, unverifizierter Restore und ungeklärte irreversible KI-Aktionen sind nicht akzeptierbar.

## Traceability

Für kritische Änderungen muss der PR diese Kette vollständig verlinken:

`Requirement → Acceptance Criteria → ADR → Commit/PR → Review → Testfall → Build/SBOM → Deployment → SLO/Alert → Incident → Regressionstest`

Jede fehlende Kante wird als `TRACEABILITY GAP` markiert. Ein Incident wird erst geschlossen, wenn Ursache, Datenumfang, sichere Wiederholung und Regressionstest dokumentiert sind.

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
| Backup-Frische                              |                      ≤15 min |                   0 | Readiness rot; Off-host-Pipeline reparieren             |

Synthetische E2E-Prüfungen laufen im Staging mindestens alle 15 Minuten. Monatlich werden Restore und kontrollierter Provider-/Netzwerkausfall geübt. Postmortems sind blameless, aber ein Regressionstest für jede technisch reproduzierbare Incident-Ursache ist verpflichtend.

## AI Governance ohne Runtime-HITL

Das System leitet akzeptierte KI-Ergebnisse automatisch weiter; es gibt bewusst keinen Human-in-the-loop im Runtime-Pfad. Fail-closed-Schema, Grounding gegen die Eingabenachricht, erlaubte Werte, Geometrie, Token-/Request-/Tagesbudgets, Timeouts und Provenance sind daher unverzichtbare Freigabebedingungen. Modell, Prompt-Hash, Template, Schema und Parser werden je Ergebnis protokolliert; Rechte bleiben auf die konfigurierte Zielzustellung begrenzt. Ein Kill Switch ist über Routing-Stopp/Readiness und den begrenzten Container-Restart vorhanden.

Ein AI-Release ist **NO-GO**, wenn Golden-Set-Qualität sinkt, adversariale Fälle akzeptiert werden, das Output-Schema instabil ist, Budget oder Latenz überschritten werden oder Provenance/Rollback fehlen.
