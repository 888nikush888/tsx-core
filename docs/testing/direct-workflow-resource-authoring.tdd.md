# Direkte Workflow-Bausteinautorenschaft: TDD-Evidenz

## Ziel

- Parser-Prompts werden ausschließlich direkt im Parser-Baustein gepflegt; die globale Prompt-Vorlagen-API und ihre UI entfallen.
- Signal-Schema, Signal-Vertrag und Strategie lassen sich ohne vorher vorhandene Fachversion direkt in ihrem Baustein erstellen und anschließend unveränderlich veröffentlichen.
- Canvas-Entfernung, Archivierung und endgültige Löschung sind getrennte Aktionen.
- Eine endgültige Löschung bleibt fail-closed, sobald eine aktive oder historische Workflowrevision eine Version der Familie referenziert.

## TDD-Checkpoints

| Stufe | Commit | Evidenz |
|---|---|---|
| RED | `b965bffaa3b2edb15c07326df60c7223e90d11f5` | Sechs Frontend-Akzeptanztests schlugen wegen der noch vorhandenen Vorlagenauswahl und der fehlenden direkten Editoren fehl. Der Backendtest konnte die noch nicht implementierte Familienlöschung nicht importieren. |
| RED – unabhängiges Schema/Vertrag | Arbeitsstand vor GREEN | Ein zusätzliches Repository-Szenario bewies den Altfehler `standard !== loma`: eine explizite Parser-Struktur wurde vom Fallback-Vertrag überschrieben. |
| GREEN | `cffd2b23f80e18026f790b34576931753e4e87c0` | UI, API und Repository erfüllen die neuen Verträge; direkte Fachobjekte werden veröffentlicht, Parser-Schema und Fallback-Vertrag bleiben unabhängig, und historisch referenzierte Familien werden nicht gelöscht. |

## Abgedeckte User Journeys

| # | Garantie | Test | Typ |
|---:|---|---|---|
| 1 | Ein neuer Parser besitzt nur den direkten Prompt und ruft `/api/templates` nicht auf. | `frontend/tests/workflow-resource-editor.test.tsx`, `tests/test_web_server.js` | Component/API |
| 2 | Eine Strategie kann in einem leeren Strategiebaustein definiert, als V1 angelegt und veröffentlicht werden. | `frontend/tests/workflow-resource-editor.test.tsx` | Component/Integration |
| 3 | Ein Signal-Vertrag kann inklusive deklarativer Definition im leeren Vertragsbaustein angelegt und veröffentlicht werden. | `frontend/tests/workflow-resource-editor.test.tsx` | Component/Integration |
| 4 | Ein Signal-Schema kann im leeren Schemabaustein aufgebaut werden; Änderungen an bestehenden Schemas erzeugen automatisch eine neue ID. | `frontend/tests/workflow-resource-editor.test.tsx` | Component/Integration |
| 5 | Parser-Schema und Fallback-Vertragsversion bleiben unabhängig konfigurierbar. | `tests/test_trading_core.js`, `tests/test_trading_web_control.js` | Repository/API |
| 6 | Canvas-Lösen, Archivieren und endgültiges Löschen sind separat bestätigt und übertragen unterschiedliche Operationen. | `frontend/tests/workflow-resource-editor.test.tsx`, `frontend/tests/workflow-builder-history.test.tsx`, `tests/test_web_server.js` | Component/API |
| 7 | Eine unbenutzte Ressourcenfamilie wird vollständig gelöscht; jede historische Referenz blockiert dies. | `tests/test_workflow_builder.js` | Repository/Safety |
| 8 | Die direkte Autorenschaft und beide Bibliotheksaktionen sind auf Desktop, Firefox, WebKit und Mobil sichtbar und bedienbar. | `frontend/e2e/dashboard.spec.ts` | E2E |

## Tatsächlich ausgeführte Validierung

| Prüfung | Ergebnis |
|---|---|
| `npm run test:coverage` | PASS, 72/72 Testdateien; 97,47 % Statements/Lines, 89,03 % Branches, 100 % Funktionen im Critical-Coverage-Satz |
| Gezielte Backendabdeckung für `workflow_repository.ts`, `web_server.ts`, `trading_repository.ts` | PASS, gemeinsam 81,54 % Statements/Lines, 78,86 % Branches, 88,95 % Funktionen |
| `npm run test:coverage --prefix frontend` | PASS, 20/20 Dateien und 119/119 Tests |
| Geänderte ausführbare Frontendzeilen | 81,82 % kombiniert; `resource-editor.tsx` 87,69 %, `workflow-builder.tsx` 65,22 % |
| `npm run test:e2e --prefix frontend` | PASS, 48/48 Tests in vier Playwright-Projekten |
| `python -m pytest -q` | PASS, 41 Tests und 13 Subtests |
| Root-/Frontend-Lint, Typecheck, Architektur, Komplexität und Frontend-Reachability | PASS |
| `npm run build` und separater Frontend-Build | PASS |

Die globale historische Frontendabdeckung liegt weiterhin unter 80 %. Für diese Änderung wird deshalb zusätzlich die Abdeckung der neu hinzugefügten ausführbaren Zeilen ausgewiesen; sie überschreitet 80 %, ohne vorhandene Grenzwerte zu lockern oder Code künstlich auszunehmen. Es wurden keine neuen Tests übersprungen oder deaktiviert.
