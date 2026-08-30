# Konfigurierbarer Account-/Exchange-Fallback

## Ausgangs- und Endstand

- Quellplan: `TSX-Core_Konfigurierbarer-Account-Fallback_Ultimativer-Plan_AKTUALISIERT.md`, SHA-256 `20D96EA5D58220311B6C9BCC97B820DCC0A1D7E2EDDB689B72FC91C1110A614C`.
- Start-Commit: `aa4f9e80f639b893f62ca419cd80352e04766de9`.
- Funktions- und Test-Endstand: `98743df218d5d26facfbfc6cfeb9a5a815b8f194`.
- Datenbankschema: Migration 22 `configurable_account_fallback_policy`.
- Umsetzung ausschließlich lokal auf `main`; kein Server-Rollout und kein Release-Tag.

## Verhalten

Eine lineare Account-Kette kann jetzt je Übergang festlegen, welche sicheren, lokalen Auswahlgründe den nächsten Account aktivieren:

- `SYMBOL_UNAVAILABLE`
- `MAX_CONCURRENT_POSITIONS`
- `SYMBOL_ALREADY_OWNED`

Die Regel gehört zur ausgehenden Fallback-Kante. Deshalb dürfen A→B und B→C unterschiedliche Policies besitzen. Der letzte Kandidat besitzt keine ausgehende Policy und beendet einen zulässigen Fehlschlag als `exhausted`.

Der Auswahlablauf bleibt fail-closed:

1. Account-, Runtime-, Kill-Switch-, Reconciliation-, offene-Order- und kritische Risikoprüfungen laufen zuerst.
2. Nur die drei expliziten Route-Skip-Gründe können eine Kette weiterführen.
3. Die konkrete Kanten-Policy muss den Grund erlauben.
4. Der nächste Account erzeugt einen neuen, account-lokalen Intent mit eigenem Equity, Market, Sizing, Leverage und adaptivem Risiko.
5. Nach `selected` oder einem Submit-Versuch ist kein Fallback mehr möglich.

Ungeklärte Orders, kritische Risikoereignisse, Daily-Loss/Daily-Risk, globale oder Account-Kill-Switches, technische/unklare Fehler, Reconciliation-Störungen, abgelaufene TTL und unsichere Submit-Ausgänge stoppen die Kette immer. Die ursprüngliche Signalzeit bleibt für alle Kandidaten erhalten; ein Wechsel setzt die Entry-TTL nicht zurück.

## Contracts und Persistenz

- `WorkflowGraph.schemaVersion` unterstützt V3.
- V3-`account_fallback`-Kanten benötigen eine kanonische, eindeutige, nicht leere `fallbackOn`-Liste aus den drei zulässigen Gründen.
- Flow-Kanten dürfen keine Policy tragen.
- V1/V2 bleiben lesbar. Bestehende V2-Ketten werden beim Kompilieren exakt als Pair-only interpretiert.
- `WorkflowExecutionPath`, kompilierte Route-Candidates und persistierte Run-Candidates enthalten einen unveränderlichen Policy-Snapshot.
- Migration 22 ergänzt `fallback_on_json` in `workflow_execution_paths` und `trading_fallback_candidates`; existierende nicht-terminale Kanten werden mit `SYMBOL_UNAVAILABLE` zurückgefüllt.
- Policy-Änderungen verändern den Workflow-Impact-Hash, sind destruktiv und benötigen die bestehende Aktivierungsbestätigung.
- Setup-Bundle V2 erhält Graph-V3-Policies; Setup-Bundle V1 und Legacy-Graphen bleiben importierbar. Secret- und Größenprüfungen bleiben unverändert.

## Builder und Betrieb

- Neue und bestehende Fallback-Verbindungen öffnen einen eigenen Policy-Dialog.
- Presets: „Nur Handelspaar“, „Verfügbarkeit & Kapazität“ und „Benutzerdefiniert“.
- Harte Safety-Gates werden im Dialog sichtbar erklärt, sind aber nicht auswählbar.
- Optional kann dieselbe Regel auf die erreichbare Kette eines Kanals angewendet werden.
- Kantenlabel und Verbindungsinspektor zeigen die wirksame Policy.
- Route Overview zeigt Reihenfolge und Übergangsregeln.
- Account-Knoten zeigen aktuelle Positionen, Limit und Restkapazität; das Limit bleibt am Börsenkonto editierbar.
- Die Simulation gruppiert und sortiert Kandidaten, zeigt Übergangsregeln sowie PASS/BLOCK, führt aber keine Börsenmutation aus.
- Undo/Redo stellt Policy-Änderungen mitsamt Impact-Bestätigung wieder her.
- Betrieb zeigt Candidate-Policy und Run-Details; Analytics aggregiert Skip-Gründe.
- Der Telegram Viewer kennt `workflow_fallback_candidate_skipped` read-only und zeigt Quellkonto, Zielkonto und Grund ohne Secrets.

## Tests und Qualitätsnachweise

- Node: 72/72 Testdateien bestanden.
- Kritische Node-Coverage: 96,81 % Statements, 89,02 % Branches, 100 % Funktionen, 96,81 % Lines.
- Modul-Coverage: 95,14 % Statements/Lines, 83,64 % Branches und 99,15 % Funktionen; damit oberhalb des gemeinsamen Cross-Platform-Ratchets.
- Frontend: 20/20 Testdateien, 113/113 Tests bestanden.
- Neue Frontend-Module: Policy-Dialog 96,66/100/92,30/96,29 %, Policy-Helfer 92,72/81,81/100/97,50 %, Simulation 100/88,46/100/100 %.
- Python Executor: 41/41 Tests, 74 % Gesamt-Coverage.
- Browser/WCAG: 44/44 Szenarien auf Chromium, Firefox, WebKit und Mobile Chromium.
- Architektur: 75 Module, 234 interne Imports, 0 Zyklen.
- Komplexität: 0 Warnungen, 0 Verletzungen, Worst-Case 15, keine Funktion über 100 Zeilen.
- Duplikation: 1,02 % bei einer Grenze von unter 5 %.
- Root- und Frontend-Audit: 0 Schwachstellen auf `moderate` oder höher.
- Lint, Python-Lint, Typecheck, Build, Lizenz-, Dependency-, Release-, Risk-Acceptance-, Build-Context- und SBOM-Gates: bestanden.
- Frontend-Produktionschunks: 325,52 KiB, 368,36 KiB und 436,87 KiB; alle unter 500 KiB.

Die vollständige Test-zu-Anforderung-Matrix steht in `docs/testing/configurable-account-fallback-policy.tdd.md`.

## Runtimes

- Node.js `22.23.2`
- npm `10.9.8`
- Python `3.12.13`
- CCXT `4.5.75`
- Ruff `0.15.7`
- Coverage.py `7.10.7`

## GitHub Required Checks

Die lokale Prüfung ersetzt nicht die Quality-OS-Prüfung des exakten gepushten `main`-Commits. Vor Freigabe müssen dort grün sein:

- Lint, Tests, Coverage, Build und Supply Chain einschließlich Monitoring-Konfiguration
- SonarQube Cloud Quality Gate ohne offene Hotspots oder Blocker/Critical Issues
- vier Mutation-Shards
- vier Browser-/Accessibility-Projekte
- CodeQL, Secret-History-Scan und Dependency-Review-Regel
- Container-Build, SBOM und Vulnerability-Scans

## Bekannte Einschränkungen

- Die Policy gilt bewusst nur vor der Auswahl eines Accounts. Ein Submit- oder unklarer Börsenausgang darf niemals auf einem zweiten Konto dupliziert werden.
- Die Fallback-Kette ist pro Kanal linear; Verzweigungen und Zyklen werden abgewiesen.
- Die Simulation ist eine Momentaufnahme. Kapazität und Marktdaten können sich bis zur späteren Ausführung ändern.
- Der lokale Windows-Docker-Daemon war für den Monitoring-Container-Gate nicht verfügbar. Dieser Gate bleibt unverändert und wird verbindlich im GitHub-Linux-Workflow auf dem exakten Commit ausgeführt.
