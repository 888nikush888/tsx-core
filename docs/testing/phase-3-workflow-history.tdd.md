# Phase 3: TDD-Nachweis für die persistente Builder-Historie

## Quelle und Nutzerziele

Quelle ist Phase 3 der Master-Gesamtspezifikation `TSX-Core_4-Plans_MASTER-Gesamtspezifikation_KEINE-SUBAGENTS.md`.

- Als Administrator möchte ich die letzten fünf aktivierten Workflow-Stände auch nach einem Neustart sicher rückgängig machen und wiederholen können.
- Als Betreiber möchte ich vor jeder Wiederherstellung die fachlichen Auswirkungen sehen und risikoreiche Änderungen ausdrücklich bestätigen.
- Als Administrator möchte ich konkurrierende Änderungen niemals überschreiben; Revisionen und Historie müssen konfliktfest bleiben.
- Als Nutzer möchte ich Undo/Redo im Builder per Schaltfläche und sicheren Tastenkürzeln bedienen, ohne native Eingabe- oder Dialogfunktionen zu stören.
- Als Betreiber möchte ich, dass gelöschte oder migrierte Ressourcen keine unbrauchbaren Historienstände hinterlassen.
- Als Administrator möchte ich beschädigte Historie fail-closed behandeln und sie im Recovery-Fall gezielt, bestätigt und auditiert zurücksetzen können, ohne den aktiven Workflow zu verändern.
- Als bestehender Nutzer möchte ich, dass der in Phase 1 eingeführte Standardhebel sowie die dynamischen Börsenkennungen aus Phase 2 durch Undo/Redo unverändert erhalten bleiben.

## Planaufgabe zu RED/GREEN

| Planverhalten | Testziel | RED-Checkpoint | GREEN-Nachweis |
|---|---|---:|---|
| Persistenter, strikt validierter Verlauf mit maximal fünf Einträgen | `tests/test_workflow_history.js` | `6fe51e8` | `884df99` |
| Struktureller Vergleich unveränderlicher Workflow-Graphen | `tests/test_workflow_history.js` | `c11c594` | `884df99` |
| Admin-APIs, serverseitig erzwungene Aufzeichnung und Konfliktschutz | `tests/test_web_server.js` | `f2e8c7` | `22d9d3d` |
| Historienbarrieren bei veröffentlichter Ressource, Familie, Strategie, Schema, Vertrag, Konto, Bundle und Migration | `tests/test_workflow_history_barriers.js`, `tests/test_setup_bundle.js`, `tests/test_workflow_migration.js`, `tests/test_web_server.js` | `f2e8c7` | `22d9d3d` |
| Builder-Steuerung, sichere Tastenkürzel, Impact-Dialog und Konfliktneuladen | `frontend/tests/workflow-builder-history.test.tsx` | `0aa584a` | `21f1b48` |
| Browserabläufe für Verbindung sowie Phase-1-Standardhebel | `frontend/e2e/dashboard.spec.ts` | `4f3f977` | `7cbbc5a`, `3e5a2c9` |
| Kontrollierter Recovery-Reset nur für Administratoren | `tests/test_web_server.js` | `62998af` | `d11a38d` |
| Alle Historienoberflächen und -mutationen sind für Viewer gesperrt | `tests/test_web_server.js` | – | `1aaf6b2` |
| Migrations-, Coverage- und Komplexitätsregressionen schließen | `tests/test_dynamic_exchange_registry.js`, `tests/test_workflow_history.js`, `tests/test_web_server.js` | – | `8ba162e`, `ab85253` |
| Sonar-Komplexität der History-Navigation unter das Limit bringen | `frontend/tests/workflow-builder-history.test.tsx`, SonarQube Cloud | `fd20946` | `a5e13ce` |

Die RED-Tests wurden jeweils vor dem zugehörigen Produktionscode ausgeführt. Die ersten beiden Checkpoints beschrieben den Datenbank-, Stack-, Revisions- und Integritätsvertrag. Danach wurden API und Invalidierungsbarrieren, die Builder-Interaktion, die vollständigen Browserreisen und zuletzt der administrative Recovery-Pfad jeweils separat rot festgehalten und anschließend grün umgesetzt.

`3e5a2c9` beseitigt ausschließlich browser- und viewportabhängige Testflakiness; die produktiven Handler und ihre sichtbaren Revisionsnachrichten bleiben Gegenstand der E2E-Prüfung. `8ba162e` hält den bestehenden Komplexitätsrahmen ein und macht Migration 19 als unveränderliche Phase-2-Voraussetzung prüfbar, ohne die aktuelle Schema-Version auf 19 festzuschreiben. `ab85253` erhält den zuvor unter Linux und Windows verifizierten gemeinsamen Coverage-Ratchet; eine nur lokal beobachtete Windows-Steigerung wird nicht als plattformübergreifende Baseline ausgegeben.

Der erste vollständige Online-Lauf auf `1aaf6b2` bestand Quality Gate, Coverage, Duplikation, Hotspot-Prüfung und sämtliche übrigen Jobs, exportierte aber genau ein offenes Critical-Maintainability-Issue: Die History-Navigation lag mit Cognitive Complexity 16 einen Punkt über dem Limit 15. `fd20946` hält den ausgelagerten Formatierungsvertrag zunächst rot fest; `a5e13ce` verschiebt ausschließlich diese Darstellung aus dem Callback. Dieselben 99 Frontend-Tests, Lint und das lokale Komplexitätsgate liefen danach grün.

## Testbare Garantien

| # | Garantie | Test oder Befehl | Typ | Ergebnis |
|---:|---|---|---|---|
| 1 | Migration 20 legt genau einen persistenten Historienzustand an; die Datenbank meldet das Feature ausdrücklich. | `tests/test_workflow_history.js` | DB-Integration | PASS |
| 2 | Ohne aktiven Vorgänger wird kein künstlicher Undo-Eintrag erzeugt; der erste gültige Vorgänger ist danach wiederherstellbar. | `tests/test_workflow_history.js` | Unit/Integration | PASS |
| 3 | Undo und Redo aktivieren immer eine neue unveränderliche Workflow-Revision, statt alte Revisionen zu verändern. | `tests/test_workflow_history.js` | DB-Integration | PASS |
| 4 | Beide Stacks enthalten höchstens fünf Einträge; eine normale Änderung nach Undo leert den Redo-Stack. | `tests/test_workflow_history.js` | Unit/Integration | PASS |
| 5 | Beschädigtes, überlanges oder vertragswidriges Historien-JSON sowie fehlende Zielrevisionen scheitern geschlossen und unverändert. | `tests/test_workflow_history.js` | Security/DB | PASS |
| 6 | Revision, Basisrevision und Historienstacks werden in derselben Transaktion geändert; Konflikte hinterlassen keinerlei Teilzustand. | `tests/test_workflow_history.js`, `tests/test_web_server.js` | Concurrency/DB | PASS |
| 7 | Der Client kann den Aufzeichnungsmodus nicht auf `reset` oder `ignore` herabsetzen; normale API-Mutationen werden serverseitig als Historienänderung erfasst. | `tests/test_web_server.js` | API/Security | PASS |
| 8 | Impact wird aus dem tatsächlichen Zielgraphen berechnet; riskante Unterschiede brauchen die exakte Bestätigung. | `tests/test_workflow_history.js`, `tests/test_web_server.js` | Security/Integration | PASS |
| 9 | Rejected Operations erhalten die Historie; erfolgreiche invalidierende Operationen leeren sie erst nach ihrem erfolgreichen Abschluss. | `tests/test_workflow_history_barriers.js`, `tests/test_setup_bundle.js`, `tests/test_workflow_migration.js`, `tests/test_web_server.js` | Integration | PASS |
| 10 | Setup-Bundle-Rollback stellt Workflow und Historie atomar wieder her; erfolgreicher Ersatz invalidiert alte Historie. | `tests/test_setup_bundle.js` | DB-Integration | PASS |
| 11 | Der Builder bleibt bei separatem Historien-Ladefehler benutzbar, deaktiviert aber Undo/Redo sicher. | `frontend/tests/workflow-builder-history.test.tsx` | UI/Resilience | PASS |
| 12 | Undo/Redo erhält Viewport und Suche, entfernt stale Selektionen und lädt bei Konflikt Workflow plus Historie neu. | `frontend/tests/workflow-builder-history.test.tsx` | UI/Integration | PASS |
| 13 | Tastenkürzel funktionieren nur im sicheren Builder-Kontext und greifen nicht in Eingabefelder, Editoren oder offene Dialoge ein. | `frontend/tests/workflow-builder-history.test.tsx` | UI/Accessibility | PASS |
| 14 | Eine Verbindung kann browserseitig angelegt, rückgängig gemacht, wiederholt und gelöscht werden; jede Aktivierung zeigt eine neue Revision. | `frontend/e2e/dashboard.spec.ts` | E2E | PASS |
| 15 | `defaultLeverage` wechselt über Version 1, Version 2, Undo und Redo exakt zwischen den Werten 3 und 7. | `frontend/e2e/dashboard.spec.ts` | E2E/Regression | PASS |
| 16 | Dynamische Phase-2-Börsenkennungen bleiben opaque Strings; Migration 19 bleibt vorhanden und Migration 20 baut ausschließlich darauf auf. | `tests/test_dynamic_exchange_registry.js`, `tests/test_workflow_history.js` | Regression/DB | PASS |
| 17 | History-Status, Impact, Apply und Recovery-Reset sind für Viewer ausdrücklich HTTP 403. | `tests/test_web_server.js` | Authorization | PASS |
| 18 | Der Recovery-Reset benötigt Header- und ausgeschriebene Bestätigung, ist auditiert und erhält den aktiven Workflow unverändert. | `tests/test_web_server.js` | Security/Recovery | PASS |
| 19 | Desktop- und Mobilabläufe bleiben über Chromium, Firefox, WebKit und Mobil-Chromium bedienbar. | `npm run test:e2e --prefix frontend` | E2E | PASS, 44/44 |

## Vollständige lokale Gates

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run lint:frontend`: PASS
- `npm run test:coverage`: PASS, 65/65 Testdateien; 97,47/89,03/100/97,47 %
- `npm run test:coverage:modules`: PASS; lokaler Windows-Wert 95,41/83,63/99,18/95,41 %, gemeinsamer Ratchet 95,01/83,33/99,09/95,01 %
- `npm run test:coverage --prefix frontend`: PASS, 17/17 Dateien und 98/98 Tests; 61,89/55,82/54,15/62,70 %
- `python -m coverage run --source=exchange_executor -m unittest discover -s exchange_executor/tests -v`: PASS, 41/41 Tests; 74 % gesamt und Fail-under 60 erfüllt
- `npm run build`: PASS
- `npm run quality:architecture`: PASS, 61 Module, 196 interne Imports, 0 Zyklen
- `npm run quality:complexity`: PASS, 0 Warnungen, Worst-Case-Komplexität 15 und keine Funktion über 100 Zeilen
- `npm run quality:frontend`: PASS, 37/37 Frontendmodule erreichbar
- `npm run quality:duplicates`: PASS, 0,81 % duplizierte Zeilen bei 5-%-Grenze
- `npm run quality:release`: PASS
- `npm run quality:risk-acceptances`: PASS
- `npm run quality:build-context`: PASS
- `npm run quality:licenses`: PASS
- `npm run quality:dependencies`: PASS
- `npm run quality:sbom`: PASS, 116 Backend- und 60 Frontend-Komponenten
- `npm audit --audit-level=moderate`: PASS, 0 Schwachstellen
- `npm audit --prefix frontend --audit-level=moderate`: PASS, 0 Schwachstellen
- `npm run test:e2e --prefix frontend`: PASS, 44/44
- Kritische Mutationstests: PASS; Queue 72,67 %, Retry 71,43 %, Schema 76,73 % und Trading/Risiko 93,28 % bei jeweils 70-%-Grenze

Die Reihenfolge aller Coverage-Werte ist Statements/Branches/Functions/Lines.

`npm run quality:monitoring` wurde lokal angestoßen, konnte aber ohne laufende Docker-Desktop-Engine kein gehärtetes Prometheus-Image bauen. Dieser umgebungsabhängige Check ist lokal daher **NOT RUN** und nicht als bestanden gewertet. Der unterstützte GitHub-Lauf führt das Gate in seiner vorgesehenen Linux-/Docker-Umgebung aus.

`npm run quality:github-governance` benötigt die dafür vorgesehenen GitHub-Umgebungsvariablen und ein berechtigtes Token. Es wurde lokal ohne diese Autorisierung nicht als bestanden gewertet; der Repository-Workflow bleibt die maßgebliche Prüfung.

## GitHub- und Sonar-Abschluss

- Exakte Main-Revision: `a5e13cef9687fb720e50d446fe73fdd74bafe715`
- GitHub-Actions-Lauf: `33277680448`, Gesamtstatus `success`
- Erfolgreich: CodeQL, vier Browser-/Accessibility-Gates, vier Mutation-Gates, Linux-Lint/Tests/Coverage/Build/Supply-Chain, Container/SBOM/Vulnerability-Scan, Secret-History-Scan und SonarQube Cloud.
- Sonar-Analyse: `feee6e91-7d15-4156-9e53-b64fde17a951`; Revision stimmt exakt überein.
- Sonar Quality Gate: `OK`; neue Reliability-, Security- und Maintainability-Ratings jeweils A, neue Coverage 88,0 %, neue Duplikation 0,0 % und Hotspot-Review 100 %.
- Offene Blocker/Critical-Issues: 0; ungeprüfte Security Hotspots: 0. Die 147 übrigen offenen Sonar-Issues liegen sämtlich unterhalb Blocker/Critical.

## Checkpoints

- Ausgangsstand Phase 3: `7e835f5`
- RED persistente Historienverträge: `6fe51e8`
- RED struktureller Graphvergleich: `c11c594`
- GREEN persistente Historie: `884df99`
- RED API und Invalidierungsbarrieren: `f2e8c7`
- GREEN API und Invalidierungsbarrieren: `22d9d3d`
- RED Builder-Bedienung: `0aa584a`
- GREEN Builder-Bedienung: `21f1b48`
- RED Browserreisen: `4f3f977`
- GREEN Browserreisen: `7cbbc5a`
- RED Recovery-Reset: `62998af`
- GREEN Recovery-Reset: `d11a38d`
- Qualitäts- und Migrationstestkorrekturen: `8ba162e`
- Browserübergreifende E2E-Härtung: `3e5a2c9`
- Plattformübergreifender Coverage-Ratchet: `ab85253`
- Explizite Viewer-Sicherheitsmatrix: `1aaf6b2`
- RED Sonar-Komplexitätsbefund: `fd20946`
- GREEN Sonar-Komplexitätskorrektur: `a5e13ce`

## Bewusste Grenzen

- Die Historie speichert ausschließlich Workflow-Graphzustände und Referenzen. Credentials, Katalog-Probes, Börsenabfragen und andere externe Seiteneffekte werden weder gespeichert noch wiederholt.
- Der Verlauf ist absichtlich auf fünf Undo- und fünf Redo-Einträge begrenzt.
- Der Recovery-Reset ist kein Workflow-Reset: Er löscht ausschließlich die Historienstacks.
- Native Browser-Undo-Funktionen in Eingabefeldern und Dialogen behalten Vorrang.
