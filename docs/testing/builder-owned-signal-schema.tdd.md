# Builder-eigenes Signal-Schema: TDD-Evidenz

## Ziel

- Der Signal-Schema-Dialog enthält keinen fest eingebauten Parserprofil-Wähler.
- Das Schema definiert seine normalisierte Signalstruktur direkt und unveränderlich.
- Die Parserquelle stammt aus den im Canvas platzierten und verbundenen Parser-Bausteinen.
- Ein verbundener Vertrag ergänzt Sicherheitsregeln, ohne die Schema-Pfade umzubenennen.
- Bestehende Schemas und Setup-Bundles werden ohne Datenbankrücksetzung migriert.

## TDD-Checkpoints

| Stufe | Commit | Evidenz |
|---|---|---|
| RED | `2368289` | Frontend-, Repository-, Migrations- und Vertragskompositionstests beschrieben das Zielverhalten vor der Implementierung und schlugen erwartungsgemäß fehl. |
| GREEN | `d023907` | Schema-Definition, Builder-Parserquellen, Laufzeitkomposition, Migration und Setup-Bundle v3 wurden implementiert; die gezielten Tests sowie der Chromium-End-to-End-Test waren grün. |

## Abgedeckte Garantien

| # | Garantie | Test | Typ |
|---:|---|---|---|
| 1 | Der Schema-Dialog zeigt keine hardcodierte Parser-Schema-Auswahl und sendet eine echte Definition an die API. | `frontend/tests/workflow-resource-editor.test.tsx` | Component/Integration |
| 2 | Im Canvas vorhandene Parser werden ermittelt; eine direkte Parser-Schema-Verbindung wird eindeutig gekennzeichnet. | `frontend/tests/workflow-graph.test.ts` | Unit |
| 3 | Eigene Feldpfade und Target-Elementnamen werden ausgeführt; der Vertrag kann die zulässige Target-Anzahl verschärfen. | `tests/test_signal_contract_validation.js` | Unit/Security |
| 4 | Ein Schema kann ohne Fallback-Vertrag gespeichert, gehasht und wieder geladen werden. | `tests/test_trading_core.js` | Repository |
| 5 | Schema-Definitionen bestehender Installationen werden aus der bisherigen Vertragsreferenz übernommen. | `tests/test_signal_schema_migration.js` | Migration |
| 6 | Setup-Bundle v3 transportiert die Schema-Definition; v1/v2 bleiben importierbar. | `tests/test_setup_bundle.js`, `tests/test_web_server.js` | Integration/API |
| 7 | Der echte Builder-Dialog zeigt Parserquelle und Strukturfelder statt des alten Dropdowns. | `frontend/e2e/dashboard.spec.ts` | E2E |

## Tatsächlich ausgeführte Validierung

| Prüfung | Ergebnis |
|---|---|
| `npm run test:coverage` | PASS, 73/73 Testdateien; kritischer Satz 97,50 % Statements/Lines, 89,13 % Branches und 100 % Funktionen |
| Vollständige Node-Abdeckung mit allen `src/**/*.ts` | PASS, 89,46 % Statements/Lines, 83,62 % Branches und 99,05 % Funktionen |
| Geänderte ausführbare Produktionszeilen | PASS, 242/268 beziehungsweise 90,30 % im vollständigen Lauf; der anschließend ergänzte Vertragskompositionstest hebt `signal_contract.ts` separat auf 100 % Statements/Lines und 95 % Branches |
| `npm run test:coverage --prefix frontend` | PASS, 20/20 Testdateien und 120/120 Tests |
| `npm run test:e2e --prefix frontend` | PASS, 48/48 Tests in Chromium, Firefox, WebKit und Mobile Chromium |
| `python -m pytest -q` | PASS, 41 Tests und 13 Subtests |
| Root-/Frontend-Lint, Typecheck, Architektur, Komplexität und Frontend-Reachability | PASS; keine abgesenkten Grenzwerte |
| `npm run build` | PASS, TypeScript- und Frontend-Produktionsbuild |

Die globale historische Frontendabdeckung beträgt weiterhin 66,15 % Statements. Für die Änderung wird deshalb zusätzlich die tatsächliche Abdeckung der neu hinzugefügten ausführbaren Produktionszeilen ausgewiesen; sie liegt mit 90,30 % über dem geforderten 80-%-Wert. Es wurden keine Tests deaktiviert oder übersprungen.
