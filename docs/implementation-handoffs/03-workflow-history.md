# Phase 3 – Persistente, konfliktfeste Builder-Historie

## Phase

Phase 3 der Master-Gesamtspezifikation: serverpersistentes Undo/Redo für den Workflow-Builder mit Impact-Vorschau, Sicherheitsbarrieren und Recovery-Vertrag.

## Ausgangs-Commit

`7e835f5`

## End-Commit

`a5e13ce` (funktions-, sicherheits-, regressions- und testvollständiger Code; diese Übergabe folgt als Dokumentationscommit)

## Neue Migrationen

- Migration 20 ergänzt `workflow_builder_history` als Singleton-Tabelle mit getrennten Undo-/Redo-JSON-Stacks und Aktualisierungszeit.
- Die Migration ist append-only und baut auf der weiterhin unverändert vorhandenen dynamischen Börsenmigration 19 auf.
- Der initiale Zustand ist leer. Vorhandene Workflow-Revisionen werden nicht nachträglich als künstlicher Verlauf interpretiert.

## Neue und geänderte Contracts

- `GET /api/workflow/history` liefert ausschließlich Metadaten: Verfügbarkeit, Anzahl, Limit sowie nächstes Label; keine Graph- oder Secret-Daten.
- `POST /api/workflow/history/impact` berechnet die tatsächlichen Auswirkungen des nächsten Undo-/Redo-Ziels gegen die aktuelle aktive Revision.
- `POST /api/workflow/history/apply` akzeptiert ausschließlich Richtung und Basisrevision. Das Ziel wird serverseitig aus dem aktuellen Stack ermittelt.
- `POST /api/workflow/history/reset` ist ein Recovery-Endpunkt für Administratoren und benötigt sowohl `X-Destructive-Confirmation: reset-workflow-history` als auch die ausgeschriebene Bestätigung `WORKFLOW-HISTORIE ZURÜCKSETZEN`.
- Alle vier Endpunkte sind Administratoren vorbehalten; Viewer erhalten ausdrücklich 403.
- Normale Workflow-Aktivierungen erzwingen serverseitig `record`. Ein Client kann die Historie weder ignorieren noch zurücksetzen.
- Undo/Redo erzeugt immer eine neue Workflow-Revision und verwendet optimistische Konfliktprüfung über `baseRevisionId`.
- Der Verlauf ist auf fünf Einträge je Richtung begrenzt und wird strikt gegen unbekannte Felder, ungültige Labels, Zeitstempel, IDs und fehlende Zielrevisionen validiert.
- Beschädigte Historie blockiert Lesen und Schreiben fail-closed, bis der kontrollierte Recovery-Reset ausgeführt wurde.

## Hauptänderungen

- Persistenten Historien-Stack und atomare Revisionsaktivierung im Workflow-Repository ergänzt.
- Strukturellen Graphvergleich eingeführt, damit identische Graphen nicht anhand flüchtiger Serialisierungsdetails unterschieden werden.
- Impact-Vorschau und exakte Bestätigung für risikoreiche Wiederherstellungen ergänzt.
- Invalidierungsbarrieren an veröffentlichte Ressourcen und Familien, Strategien, Parser-Schemas, Signalverträge, Kontolöschung, Setup-Bundle-Ersatz sowie Legacy-Migration angebunden.
- Fehlgeschlagene oder abgelehnte Mutationen ändern die Historie nicht; Setup-Bundle-Fehler stellen aktiven Workflow und Historie vollständig zurück.
- Builder um sichtbare Undo-/Redo-Schaltflächen, Zähler, Labels, sichere Tastenkürzel, Impact-Dialog und Konfliktneuladen erweitert.
- Die von Sonar beanstandete History-Navigation durch Auslagern der reinen Nachrichtenformatierung unter das Cognitive-Complexity-Limit gebracht; der sichtbare Textvertrag ist direkt getestet.
- Nach einer Wiederherstellung werden ungültige Knoten-, Kanten- und Pfadselektionen entfernt; Suche und Viewport bleiben bestehen.
- Verlauf wird unabhängig geladen. Ein reiner History-Fehler legt den übrigen Builder nicht lahm.
- Recovery-Reset separat auditiert, ohne den aktiven Workflow zu ändern.
- E2E-Reisen für Verbindungshistorie und den Phase-1-Standardhebel über vier Browserprofile ergänzt.

## Betroffene Bereiche

- Datenbank: `src/db.ts`
- Repository und Historienlogik: `src/workflow_repository.ts`
- API, Rollenprüfung und Audit: `src/web_server.ts`
- Invalidation: `src/setup_bundle.ts`, `src/trading_repository.ts`
- Typen: `src/trading_types.ts`, `frontend/src/app/workflow/types.ts`
- Builder: `frontend/src/app/workflow/workflow-builder.tsx`
- Tests: `tests/test_workflow_history.js`, `tests/test_workflow_history_barriers.js`, `tests/test_web_server.js`, `tests/test_setup_bundle.js`, `tests/test_workflow_migration.js`, `tests/test_dynamic_exchange_registry.js`, `frontend/tests/workflow-builder-history.test.tsx`, `frontend/tests/workflow-builder-resilience.test.tsx`, `frontend/e2e/dashboard.spec.ts`

## Testergebnisse

- Backend: 65/65 Testdateien bestanden.
- Frontend: 17/17 Testdateien und 98/98 Tests bestanden.
- Python: 41/41 Tests bestanden.
- E2E: 44/44 Szenarien auf Chromium, Firefox, WebKit und Mobil-Chromium bestanden.
- Kritische Backend-Coverage: 97,47/89,03/100/97,47 %.
- Modul-Coverage (lokaler Windows-Nachweis): 95,41/83,63/99,18/95,41 %.
- Plattformübergreifender Ratchet: 95,01/83,33/99,09/95,01 %.
- Python-Coverage: 74 %.
- Frontend-Coverage: 61,89/55,82/54,15/62,70 %.

Die Reihenfolge der Coverage-Werte ist Statements/Branches/Functions/Lines.

## Quality Gates

- Typecheck, Backend-Lint, Frontend-Lint und Produktionsbuild: PASS.
- Architektur: PASS, 61 Module, 196 interne Imports und 0 Zyklen.
- Komplexität: PASS, 0 Warnungen, Worst-Case 15 und keine Funktion über 100 Zeilen.
- Frontend-Erreichbarkeit: PASS, 37/37 Module.
- Duplikate: PASS, 0,81 % bei einer Grenze von 5 %.
- Release-, Risk-Acceptance-, Build-Context-, Lizenz-, Dependency- und SBOM-Gates: PASS.
- NPM-Audits: PASS, 0 Schwachstellen in Backend und Frontend.
- Kritische Mutationstests: PASS; Queue 72,67 %, Retry 71,43 %, Schema 76,73 % und Trading/Risiko 93,28 % bei jeweils 70-%-Grenze.
- Lokales Monitoring-Image-Gate: **NOT RUN**, da Docker Desktop auf der lokalen Maschine nicht aktiv ist. Der GitHub-Lauf muss dieses Gate in der unterstützten Umgebung bestätigen.
- Lokales GitHub-Governance-Gate: **NOT RUN**, da die benötigten GitHub-Variablen und Autorisierung lokal nicht vorhanden waren.
- GitHub-/Sonar-Abschluss: Lauf `33277680448` auf exakt `a5e13cef9687fb720e50d446fe73fdd74bafe715` vollständig grün; Sonar-Analyse `feee6e91-7d15-4156-9e53-b64fde17a951` mit Quality Gate `OK`, Ratings A, 88,0 % neuer Coverage, 0,0 % neuer Duplikation, 0 Blocker/Critical-Issues und 0 ungeprüften Security-Hotspots.

## Sicherheits- und Betriebsverhalten

- Historieneinträge enthalten nur Revisions-ID, Label und Zeitstempel. Credentials und andere Secrets werden nicht dupliziert.
- Undo/Redo wiederholt keine externen Seiteneffekte wie Katalog-Probes, Credential-Schreibvorgänge oder Börsenoperationen.
- Mehrdeutige oder veraltete Basisrevisionen liefern Konflikt statt stiller Überschreibung.
- Invalidierende Lösch-, Ersetzungs- und Migrationsoperationen löschen den Verlauf erst nach erfolgreichem Abschluss.
- Der Recovery-Reset ist eine explizite administrative Gefahrenzonenaktion und wird dauerhaft auditiert.

## Offene TODOs

Keine Phase-3-TODOs. Der vollständige GitHub-Lauf `33277680448` und die exakte Sonar-Evidence sind grün.

## Hinweise für Phase 4

- Telegram-Viewer-Funktionen dürfen Workflow-Historie weder auslesen noch mutieren.
- Neue Builder-Verweise aus Phase 4 müssen dieselben serverseitigen `record`-, Konflikt- und Invalidierungsverträge verwenden.
- Recovery- und Factory-Reset-Pfade müssen die Historie weiterhin ausdrücklich behandeln.
- Vollständige RED/GREEN- und Gate-Nachweise stehen in `docs/testing/phase-3-workflow-history.tdd.md`.
