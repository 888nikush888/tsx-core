# Konfigurierbarer Account-/Exchange-Fallback: TDD-Evidenz

## Quelle und User Journeys

Quelle ist `TSX-Core_Konfigurierbarer-Account-Fallback_Ultimativer-Plan_AKTUALISIERT.md` mit SHA-256 `20D96EA5D58220311B6C9BCC97B820DCC0A1D7E2EDDB689B72FC91C1110A614C`. Der geprüfte Ausgangsstand war `aa4f9e80f639b893f62ca419cd80352e04766de9`.

- Als Betreiber kann ich für jede Account-Fallback-Kante festlegen, bei welchen sicheren Gründen zum nächsten Konto gewechselt wird.
- Als Betreiber kann ich A→B und B→C unterschiedlich konfigurieren, ohne bestehende Pair-only-Ketten zu verändern.
- Als Betreiber sehe und bearbeite ich Policy, Reihenfolge, Kapazität, Simulation, Run-Verlauf und Analytics im neuen Interface.
- Als Betreiber kann ich mich darauf verlassen, dass Safety-, Risk-, Kill-Switch-, Reconciliation-, TTL- und Submit-Fehler nie übersprungen werden.
- Als Betreiber kann ich Graph und Policies sicher exportieren/importieren sowie Änderungen über Undo/Redo nachvollziehen.

## TDD-Checkpoints

| Stufe | Commit | Evidenz |
|---|---|---|
| RED – Graph, Compiler, Legacy, Bundle und Viewer | `9fbbff1e619abd1c84535bf61cde102bae4cffa8` | Neue Contracts referenzierten noch nicht implementierte V3-Policies und schlugen erwartungsgemäß fehl. |
| RED – Account-Kapazität | `ea9d33bb6384972e3feca5c2a67f89e1883a67ef` | Die neue Kapazitätsdarstellung existierte noch nicht. |
| RED – Simulation und Runtime-Snapshot | `2b359d3b3a21e3cc0a62c7e256208a2c84b5c63c` | Candidate-Policy und Simulation fehlten. |
| RED – visuelle Kettensimulation | `41361a3a5a231921101ce0e518e411e4564d8c7a` | Geordnete Übergänge wurden noch nicht dargestellt. |
| RED – Analytics | `efd11f8ae5f09febc1031a14c0b8918542053cd7` | Skip-Gründe waren noch nicht aggregiert. |
| RED – Run-Observability | `975e721303a860dbea5878fabfffd1588334b863c` | Betrieb zeigte Candidate-Policies noch nicht. |
| GREEN – vollständige Funktion | `0b5b0b1ff4b2c5ae6079b1b96b94543851477f68` | Backend, Migration, Runtime, UI und E2E erfüllten die neuen Tests. |
| Refactor – gemeinsame Policy-Regeln | `ffe0d0e16e2c10eef8a2036a5b84f7d3e62d8b33` | Kanonisierung und Policy-Regeln wurden zentralisiert; Tests blieben grün. |
| Safety-/History-Nachweis | `eddaee0ff4ea6a155a96b717007f208d0043062b` | Safety vor Capacity sowie Undo/Redo wurden explizit geprüft. |
| Komplexitäts-Refactor | `8ac3847945a8215b70d1c94772520ac7e2aeecb2` | Advance- und Hydration-Logik wurden zerlegt; Gate blieb bei 0 Warnungen. |
| Migration-Fixture | `fce82acf37e23e6651e8254c3bb1ed626c63916d` | V18→V22 und V21→V22 laufen mit vollständiger Legacy-Struktur. |
| Coverage-Nachweis | `98743df218d5d26facfbfc6cfeb9a5a815b8f194` | Dialog-, Fehler-, Empty- und Block-Pfade wurden ergänzt. |
| RED – Sonar-Compute-Task-Diagnose | `3f1c3664d5a6ab726e1f48e457aea4db38d681b0` | Fehlgeschlagene Compute Tasks konnten ihre bereinigte Ursache noch nicht als Evidenz sichern. |
| GREEN – Sonar-Compute-Task-Diagnose | `56cbe94a49f8fc13942dbb245eb1e59d568e6970` | Compute-Task-Status und Fehlermeldung werden fail-closed und ohne Stacktrace exportiert. |
| RED – produktbezogenes Sonar-LOC-Budget | `a5a873d2eca7e97a7a49c5ff3cfa8aa9fd2b2623` | Das 50.000-LOC-Kontingent war noch nicht auf deploybaren Produktcode begrenzt. |
| GREEN – produktbezogenes Sonar-LOC-Budget | `f6d1a803518f30971920ad0fdde1f6a7ed1c2dcc` | TypeScript-, Frontend- und Python-Produktcode bleiben analysiert; spezialisierte Repository-Gates decken Nicht-Produkt-Artefakte ab. |
| RED – isoliertes Flow-Upsert | `a5b02d7f2d9bfa8609af4b91a41833cfc3a3eadd` | Die komplexe Connection-Persistenz war noch nicht als separat testbare Operation verfügbar. |
| GREEN – Sonar-Komplexitätsremediation | `5e75d482dbef7a9e8fa7c6832e82b3acc73a423e` | Flow-Upserts sind isoliert getestet; der letzte Critical Finding wurde beseitigt. |

## Test-Spezifikation

| # | Was garantiert ist | Testziel | Typ | Ergebnis |
|---:|---|---|---|---|
| 1 | V3 akzeptiert nur kanonische, eindeutige Policies aus drei zulässigen Gründen. | `tests/test_workflow_builder.js` | Contract | PASS |
| 2 | V2-Ketten bleiben Pair-only; V3 kompiliert abweichende A→B- und B→C-Policies. | `tests/test_workflow_fallback.js`, `frontend/tests/workflow-routes.test.ts` | Integration/Unit | PASS |
| 3 | Policies werden in Execution Paths und Run Candidates gespeichert und bleiben pro Signal unveränderlich. | `tests/test_workflow_fallback.js`, `tests/test_configurable_fallback_migration.js` | Integration/Migration | PASS |
| 4 | Migration 22 füllt Legacy-Ketten korrekt zurück; V18 und V21 migrieren bis V22. | `tests/test_configurable_fallback_migration.js`, `tests/test_dynamic_exchange_registry.js` | Migration | PASS |
| 5 | Volles Konto A kann zu B wechseln; deaktivierte Policy stoppt. | `tests/test_workflow_fallback.js` | Integration | PASS |
| 6 | Bereits gehaltenes Symbol kann nur bei erlaubter Policy zu B wechseln. | `tests/test_workflow_fallback.js` | Integration | PASS |
| 7 | Mixed Chain „A voll → B Pair fehlt → C frei“ wählt C mit der jeweiligen Kantenregel. | `tests/test_workflow_fallback.js` | Integration | PASS |
| 8 | Ungeklärte Orders und kritische Risikoereignisse gewinnen vor jedem Capacity-/Owned-Skip. | `tests/test_workflow_fallback.js` | Safety-Integration | PASS |
| 9 | Daily Loss/Risk und globale/Account-Kill-Switches stoppen die Kette. | `tests/test_workflow_fallback.js` | Safety-Integration | PASS |
| 10 | Technische, Reconciliation- und unbekannte Fehler erzeugen keinen Folge-Intent. | `tests/test_workflow_fallback.js` | Failure-Integration | PASS |
| 11 | Nach Account-Auswahl oder Submit-Versuch gibt es keinen Fallback. | `tests/test_workflow_fallback.js` | Safety-Integration | PASS |
| 12 | Der letzte zulässige Candidate endet als `exhausted` mit exaktem Grund. | `tests/test_workflow_fallback.js` | Integration | PASS |
| 13 | Die ursprüngliche Entry-TTL wird nicht zurückgesetzt. | `tests/test_workflow_fallback.js` | Boundary | PASS |
| 14 | Der Zielaccount verwendet eigenes Equity, Sizing, Leverage, Market, adaptive Risk und Zertifizierung. | `tests/test_workflow_fallback.js`, `tests/test_dynamic_exchange_registry.js` | Integration | PASS |
| 15 | Policy-only-Änderungen sind destruktiv, bestätigungspflichtig und über Undo/Redo reversibel. | `tests/test_workflow_fallback.js`, `frontend/e2e/dashboard.spec.ts` | Integration/E2E | PASS |
| 16 | Setup-Bundle V2 roundtript Graph V3; Legacy-Bundle bleibt lesbar; Bounds und Secret-Prüfung bleiben aktiv. | `tests/test_setup_bundle.js` | Integration/Security | PASS |
| 17 | Builder-Dialog bietet Presets, Custom, Kettenanwendung und unveränderliche Safety-Hinweise. | `frontend/tests/workflow-fallback-policy.test.tsx` | Component | PASS |
| 18 | Kapazität zeigt belegt, maximal, frei und Grenzfälle. | `frontend/tests/account-capacity.test.ts` | Unit | PASS |
| 19 | Simulation zeigt Reihenfolge, Übergänge, Fehler, leere und blockierte Pfade ohne Mutation. | `frontend/tests/workflow-simulation-result.test.tsx` | Component | PASS |
| 20 | Route Overview, Betrieb, Analytics und Viewer zeigen Policies beziehungsweise Skip-Gründe. | `frontend/tests/operations-workspace.test.tsx`, `tests/test_telegram_viewer_core.js`, `tests/test_workflow_fallback.js` | Component/Integration | PASS |
| 21 | Der vollständige Builder-Flow ist per Tastatur, mobil und WCAG A/AA nutzbar. | `npm run test:e2e --prefix frontend` | E2E | PASS, 44/44 |

## Tatsächlich ausgeführte Validierung

| Befehl | Ergebnis |
|---|---|
| `npm test` | PASS, 72/72 Testdateien |
| `npm run test:coverage` | PASS, 96,81 % Statements/Lines, 89,02 % Branches, 100 % Funktionen |
| `npm run test:coverage:modules` | PASS, 95,14/83,64/99,15/95,14 % |
| `npm run test:coverage --prefix frontend` | PASS, 20/20 Dateien und 114/114 Tests; neue Feature-Module jeweils über 80 % relevanter Abdeckung |
| `coverage run --branch --source=exchange_executor -m unittest discover -s exchange_executor/tests -v` | PASS, 41/41 Tests |
| `coverage report --fail-under=60` | PASS, 74 % |
| `npm run test:e2e --prefix frontend` | PASS, 44/44 über vier Playwright-Projekte |
| `npm run lint`, `npm run lint:frontend`, `npm run lint:python`, `npm run typecheck` | PASS |
| Architektur, Komplexität, Frontend, Release, Risk-Acceptance und Build-Context | PASS |
| `npm audit` für Root und Frontend | PASS, 0 Schwachstellen |
| Lizenz-, Dependency-, Duplikations- und SBOM-Gates | PASS; Duplikation 1,02 % |
| `npm run build` | PASS; größter JS-Chunk 436,87 KiB |
| GitHub Quality OS `33364316415` | PASS auf `5e75d482dbef7a9e8fa7c6832e82b3acc73a423e`; Sonar Gate OK, 0 ungeprüfte Hotspots, 0 Blocker/Critical Findings |

## Coverage und bekannte Lücken

- Die neuen kleinen Frontend-Featuremodule überschreiten den geforderten 80-%-Nachweis. Die historische globale Frontendabdeckung liegt weiterhin unter 80 %, wurde durch diese Funktion aber nicht als Gate abgesenkt oder umdefiniert.
- Der gemeinsame Node-Modul-Ratchet bleibt bewusst auf der konservativen, auf Linux und Windows verifizierten Baseline 95,01/83,33/99,09/95,01 %. Der aktuelle Windows-Lauf liegt darüber; eine einzelne Plattformprobe ersetzt diese Cross-Platform-Baseline nicht.
- Der lokale Windows-Docker-Daemon war nicht verfügbar. Der unveränderte Monitoring-Container-Gate wird deshalb durch den Required GitHub Quality-OS-Workflow auf der exakten gepushten Revision bewiesen.
- Es gibt keine übersprungenen oder deaktivierten neuen Tests und keine gelockerten Grenzwerte.

## Merge-Evidenz

Die RED-, GREEN-, Refactor- und Coverage-Commits bleiben einzeln auf `main` erhalten. Sie dürfen nicht gesquasht werden, ohne diese Matrix und ihre Commit-Referenzen in die Merge-Evidenz zu übernehmen.
