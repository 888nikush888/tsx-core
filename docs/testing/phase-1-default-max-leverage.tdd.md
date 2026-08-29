# Phase 1: TDD-Nachweis für Standard- und Maximalhebel

## Abgedeckte Anforderungen

- Neue Strategiekonfigurationen speichern `schemaVersion: 4` mit `defaultLeverage` und `maxLeverage`.
- Bestehende Konfigurationen der Schemaversionen 1 bis 3 bleiben lesbar und verwenden im Speicher `maxLeverage` als Standardhebel.
- Ein Signalhebel wird nur verwendet, wenn er als ganze Zahl zwischen 1 und 125 im Signal belegt ist.
- Der effektive Hebel ist entweder der Standardhebel oder der angeforderte, auf das Strategiemaximum begrenzte Hebel.
- Neue Handelspläne speichern die vollständige Hebelentscheidung; der Executor erhält weiterhin nur den effektiven Hebel.
- Builder, Editor, Setup-Bundle und Positionsanzeige verstehen V4 und bleiben zu alten Daten kompatibel.

## RED-Nachweise

| Checkpoint | Erwartetes Fehlschlagen |
|---|---|
| `60eb790` | `resolveLeverageDecision` war nicht vorhanden; Dezimalhebel wurden noch akzeptiert; Workflow-Sizing kannte den Standardhebel nicht; die Oberfläche enthielt weder beide Felder noch die V4-Zusammenfassung. |
| `83e9656` | `resolveDisplayedLeverage` war nicht vorhanden; neue Pläne konnten in der Positions-/Journalansicht nicht über `leverageDecision.effective` dargestellt werden. |

Die roten Tests wurden vor der jeweiligen Produktionsänderung ausgeführt. Beide Fehlerbilder waren auf die jeweils fehlende Funktion beschränkt und deshalb gültige RED-Zustände.

## GREEN-Nachweise

| Garantie | Test | Ergebnis |
|---|---|---|
| Entscheidung für fehlenden, normalen, begrenzten und ungültigen Signalhebel | `tests/test_trading_core.js` | PASS |
| Ganzzahligkeit und Grenzen 1/125 sowie Ablehnung 0/126/2,5 | `tests/test_signal_contract_validation.js`, `tests/test_signal_parser.js` | PASS |
| V4-Validierung, Legacy-Normalisierung und unveränderte Hashprüfung | `tests/test_trading_core.js` | PASS |
| Workflow-Sizing und Compiler erzeugen V4 | `tests/test_workflow_builder.js`, `tests/test_workflow_fallback.js` | PASS |
| Setup-Bundle exportiert und importiert normalisierte V4-Daten | `tests/test_setup_bundle.js` | PASS |
| UI validiert Standard- und Maximalhebel vor dem Speichern | `frontend/tests/workflow-resource-editor.test.tsx` | PASS |
| Builder-Zusammenfassung zeigt Standard/Maximum und Legacy-Fallback | `frontend/tests/workflow-builder-resilience.test.tsx` | PASS |
| Positions-/Journalanzeige bevorzugt `effective` und fällt auf Legacy zurück | `frontend/tests/operations-panel-helpers.test.ts` | PASS |

## Vollständige Gates

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run lint:frontend`: PASS
- `npm test`: PASS, 62/62 Testdateien
- `npm test --prefix frontend`: PASS, 88/88 Tests
- `npm run build`: PASS
- `npm run quality:architecture`: PASS, 59 Module, 0 Zyklen
- `npm run quality:complexity`: PASS, 0 Grenzwertverletzungen
- `npm run quality:frontend`: PASS, 36/36 Module erreichbar
- `npm run quality:duplicates`: PASS, 0,87 % duplizierte Zeilen bei 5-%-Grenze
- `npm run test:e2e --prefix frontend`: PASS, 40/40 auf Chromium, Firefox, WebKit und Mobil-Chromium

## Coverage

- Kritische Backend-Suite: 97,47 % Statements, 89,03 % Branches, 100 % Functions, 97,47 % Lines.
- Frontend-Gesamtbestand: 60,24 % Statements, 53,38 % Branches, 52,03 % Functions, 61,04 % Lines.
- Die in Phase 1 neu hinzugefügten reinen Entscheidungs- und Anzeigezweige besitzen direkte Positiv-, Grenz-, Kappungs-, Fehler- und Legacy-Tests. Der niedrigere Frontend-Gesamtwert ist ein vorhandener Bestandswert großer UI-Komponenten und wurde durch Phase 1 nicht als Qualitätsgrenze definiert.

## Checkpoints

- RED Kernverhalten: `60eb790`
- GREEN Kernverhalten: `78deeb1`
- Parser-Regressionsabgleich: `dfe5d4e`
- RED Journal-Kompatibilität: `83e9656`
- GREEN Journal-Kompatibilität: `4f47c5f`

