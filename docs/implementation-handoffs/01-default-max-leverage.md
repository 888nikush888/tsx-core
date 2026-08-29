# Phase 1 – Standard- und Maximalhebel

## Phase

Phase 1 der Master-Gesamtspezifikation: getrennte Konfiguration und nachvollziehbare Entscheidung für Standard- und Maximalhebel.

## Ausgangs-Commit

`5bedf445d34245bccd5583988a59750f8b57c248`

## End-Commit

`4f47c5fe67e5396d752cc8d17c4905fa9c0c03e6` (funktions- und testvollständiger Code; diese Übergabe folgt als Dokumentationscommit)

## Geänderte Contracts

- `StrategyConfiguration.schemaVersion` akzeptiert nun V4.
- `sizing.defaultLeverage` ist für V4 verpflichtend; `sizing.maxLeverage` bleibt verpflichtend.
- V1 bis V3 werden zur Laufzeit mit `defaultLeverage = maxLeverage` normalisiert.
- Neue gespeicherte Versionen und portable Setup-Bundles werden auf V4 normalisiert.
- `TradingPlan.leverageDecision` dokumentiert Quelle, Anforderung, Strategie-Standard, Strategie-Maximum, effektiven Hebel und Kappungsstatus.
- Der Executor-Vertrag bleibt absichtlich unverändert und erhält weiterhin nur den effektiven `leverage`-Wert.
- Dynamische Signalverträge akzeptieren Hebel ausschließlich als ganze Zahl von 1 bis 125.

## Neue Migrationen

Keine. Bestehende Daten werden beim Lesen kompatibel normalisiert und nur bei einer neuen Version als V4 geschrieben.

## Betroffene Dateien

- Backend: `src/trading_types.ts`, `src/trading_strategy.ts`, `src/trading_repository.ts`, `src/trading_risk.ts`, `src/signal_schema.ts`, `src/workflow_repository.ts`, `src/setup_bundle.ts`
- Frontend: `frontend/src/app/workflow/types.ts`, `frontend/src/app/workflow/workflow-builder.tsx`, `frontend/src/app/workflow/resource-editor.tsx`, `frontend/src/app/workflow/operations-panel.tsx`
- Tests: `tests/test_trading_core.js`, `tests/test_signal_contract_validation.js`, `tests/test_signal_parser.js`, `tests/test_workflow_builder.js`, `tests/test_workflow_fallback.js`, `tests/test_setup_bundle.js`, `frontend/tests/workflow-resource-editor.test.tsx`, `frontend/tests/workflow-builder-resilience.test.tsx`, `frontend/tests/operations-panel-helpers.test.ts`

## Tests ausgeführt

- Alle gezielten Backend- und Frontendtests während RED/GREEN.
- Vollständige Backend-, Frontend-, Coverage- und Browser-Suiten.
- Typecheck, beide Linter, Produktionsbuild sowie Architektur-, Komplexitäts-, Erreichbarkeits- und Duplikat-Gates.

## Testergebnisse

- Backend: 62/62 Testdateien bestanden.
- Frontend: 88/88 Tests bestanden.
- E2E: 40/40 Szenarien bestanden.
- Kritische Backend-Coverage: 97,47 % Statements, 89,03 % Branches, 100 % Functions, 97,47 % Lines.
- Frontend-Gesamtcoverage: 60,24 % Statements, 53,38 % Branches, 52,03 % Functions, 61,04 % Lines; alle neuen Phase-1-Zweige sind direkt getestet.

## Quality Gates

Alle in Phase 1 geforderten lokalen Gates sind grün. Der Build meldet nur die bereits bekannte Warnung für einen JavaScript-Chunk über 500 kB. Die Duplikatquote beträgt 0,87 % und liegt unter der erlaubten Grenze von 5 %.

## Bewusste Abweichungen

- Die lokale Maschine stellt Node 24/npm 11 bereit, während das Projekt Node 22/npm 10 verlangt. Alle lokalen Gates liefen erfolgreich; der exakte unterstützte Laufzeitstand wird zusätzlich durch GitHub Actions geprüft.
- Der Frontend-Gesamtbestand liegt unter dem allgemeinen TDD-Ziel von 80 %. Phase 1 vergrößert diesen Altbestand nicht unkontrolliert: sämtliche neuen Entscheidungszweige und Oberflächenregeln besitzen direkte Tests. Eine flächendeckende Nachrüstung unberührter Altkomponenten wäre außerhalb dieser Phase.

## Offene TODOs

Keine funktionalen TODOs für Phase 1. Vor Beginn von Phase 2 muss der GitHub-CI-Stand des hochgeladenen Phase-1-Commits geprüft werden.

## Bekannte Risiken

- Externe Verbraucher, die das Strategie-JSON strikt auf Schemaversion 3 fest verdrahtet haben, müssen V4 zulassen.
- Legacy-Konfigurationen zeigen absichtlich denselben Wert für Standard und Maximum, bis der Betreiber eine neue Version speichert.
- Der vorhandene große Frontend-Chunk bleibt ein Performance-Thema für eine spätere, gezielte Aufteilung.

## Hinweise für nächste Phase

- Phase 2 darf sich auf `leverageDecision.effective` als einzige ausgeführte Hebelquelle verlassen.
- Alte Pläne können noch ausschließlich `plan.leverage` enthalten; Anzeige- und Lesepfade müssen den vorhandenen Fallback beibehalten.
- Neue Strategien und Workflow-Kompilierungen müssen V4 schreiben und dürfen V1 bis V3 nicht rückwirkend in der Datenbank verändern.
- Die vollständigen RED/GREEN- und Gate-Nachweise stehen in `docs/testing/phase-1-default-max-leverage.tdd.md`.

