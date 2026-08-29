# Phase 2 – Dynamische CCXT-Registry und TSX Certification

## Phase

Phase 2 der Master-Gesamtspezifikation: dynamische Erkennung des installierten CCXT-Katalogs bei weiterhin streng evidence-basierter Handelsfreigabe.

## Ausgangs-Commit

`6375a462610b4dce1e8687c73a01c0eb7846a68a`

## End-Commit

`47f46d4` (funktions-, refactor- und testvollständiger Code; diese Übergabe folgt als Dokumentationscommit)

## Neue Migrationen

- Migration 19 baut `trading_accounts`, `trading_trade_intents` und `trading_exchange_events` in einer Transaktion mit dynamischen Börsenkennungen neu auf.
- Daten, relevante Indizes und Fremdschlüssel bleiben erhalten.
- Vor der Migration wird der vorhandene verifizierte Snapshot-Mechanismus verwendet.
- Bei einer Fremdschlüsselverletzung wird vollständig auf Schema 18 zurückgerollt.

## Geänderte Contracts

- Börsenkennungen sind nun syntaktisch validierte Kleinbuchstaben-IDs mit maximal 64 Zeichen statt eines festen TypeScript-Enums.
- Registry-Statuswerte sind exakt `discovered`, `candidate`, `certified`, `quarantined`, `ineligible` und `deprecated`.
- Der Executor liefert einen accountlosen, authentifizierten statischen Katalog und einen accountlosen öffentlichen Markt-Probe.
- Ein Probe kann nie zertifizieren; ausschließlich passende lokale Profile, Certification-Evidence und die gepinnte CCXT-Version erlauben `certified`.
- Der Katalogstart ist netzwerkfrei. `loadMarkets()` wird erst bei einem expliziten öffentlichen Probe oder einer vorhandenen Accountoperation verwendet.
- Credential-Dateien verwenden V2 mit einem `credentials`-Objekt. V1 bleibt lesbar und wird atomar mit restriktiven Dateirechten migriert.
- Die exakte Credential-Allowlist umfasst `apiKey`, `secret`, `uid`, `accountId`, `login`, `password`, `twofa`, `privateKey`, `walletAddress` und `token`.
- Remote-Order/Fills dürfen ohne `clientOrderId` gelesen werden; selbst erzeugte Submit-/Cancel-Antworten bleiben streng.
- Neue Konten benötigen eine erreichbare Registry, Status `certified` und Unterstützung des gewählten Modus. Ein Katalogausfall berührt bestehende Konten nicht.
- Analytics und Setup-Bundles akzeptieren historische, syntaktisch gültige Börsenkennungen unabhängig vom aktuellen Registry-Status.

## Hauptänderungen

- Python-Registry, Profile, Capability-Normalisierung, Certification-Evidence und fail-closed Symbolauflösung ergänzt.
- Bestehende Hyperliquid-, Bybit- und Kraken-Futures-Adapter auf profilbasierte Auswahl umgestellt, ohne weitere Börsen live zu zertifizieren.
- Dynamischen Node-Katalog mit kurzer Lazy-Cache-Grenze, synthetischem Paper-Deskriptor und öffentlichem Probe ergänzt.
- Credential-Store V2 samt atomarer V1-Migration und exakter Feldvalidierung implementiert.
- Adapterregistrierung und Forwarder für bereits gespeicherte dynamische Konten geöffnet, ohne Startup-Abhängigkeit vom Katalog.
- Account-Anlage und UI auf Certification- und Modusprüfung umgestellt; Kandidaten können öffentlich geprüft werden.
- Dynamische Kennungen durch Datenbank, Telemetrie, Analytics und portable Setup-Bundles geführt.
- Das vorhandene Komplexitätsbudget nach dem GREEN-Stand ohne Grenzwerterhöhung wiederhergestellt.
- Einen Gitleaks-Fehlalarm für die feste künstliche Gate.io-Test-Credential-Zeile mit einer regel-, pfad- und formatgebundenen Ausnahme behoben; echte Secrets bleiben erfasst.

## Betroffene Bereiche

- Executor: `exchange_executor/ccxt_registry.py`, `ccxt_profiles.py`, `ccxt_capabilities.py`, `ccxt_certification.py`, `symbol_resolver.py`, `ccxt_adapter.py`, `ccxt_client.py`, `credentials.py`, `server.py`
- Certification-Evidence: `exchange_executor/certifications/*.json`
- Backend: `src/exchange_catalog.ts`, `trading_credentials.ts`, `trading_web_control.ts`, `trading_types.ts`, `ccxt_exchange.ts`, `db.ts`, `forwarder.ts`, `web_server.ts`, `setup_bundle.ts`, `trading_telemetry.ts`
- Frontend: `frontend/src/app/workflow/exchange-catalog.ts`, `operations-panel.tsx`, `types.ts`
- Tests: neue Phase-2-Python-, Backend-, Frontend- und E2E-Abdeckung

## Testergebnisse

- Backend: 63/63 Testdateien bestanden.
- Frontend: 16/16 Testdateien und 90/90 Tests bestanden.
- Python: 38/38 Tests bestanden.
- E2E: 40/40 Szenarien auf Chromium, Firefox, WebKit und Mobil-Chromium bestanden.
- Kritische Backend-Coverage: 97,47/89,03/100/97,47 %.
- Modul-Coverage: 95,34/83,38/99,10/95,34 %.
- Python-Coverage: 71 %.
- Frontend-Coverage: 60,18/53,28/52,16/60,98 %.

Die Reihenfolge der Coverage-Werte ist Statements/Branches/Functions/Lines.

## Quality Gates

- Typecheck, Backend-Lint, Frontend-Lint und Produktionsbuild: PASS.
- Architektur: PASS, 60 Module und 0 Zyklen.
- Komplexität: PASS, 0 Warnungen, Worst-Case 15.
- Frontend-Erreichbarkeit: PASS, 37/37 Module.
- Duplikate: PASS, 0,83 % bei einer Grenze von 5 %.
- Release-, Risk-Acceptance-, Build-Context-, Lizenz-, Dependency- und SBOM-Gates: PASS.
- NPM-Audits: PASS, 0 Schwachstellen in Backend und Frontend.
- Supply-Chain-Test für die enge Gitleaks-Ausnahme: PASS nach dokumentiertem RED/GREEN.
- Lokales Monitoring-Image-Gate: **NOT RUN**, da Docker Desktop auf der lokalen Maschine nicht aktiv ist. Der GitHub-Lauf muss dieses Gate in der unterstützten Umgebung bestätigen.

## Bewusste Grenzen

- Keine neue Börse wird durch Discovery oder Probe automatisch live-fähig. Zusätzliche Börsen bleiben Kandidaten oder sind je nach statischer Fähigkeit ineligible.
- Spot, inverse/COIN-M-Produkte, native Bracket-Annahmen unbekannter Börsen und ein CCXT-Upgrade sind ausdrücklich nicht Bestandteil dieser Phase.
- Die lokale Laufzeit ist Node 24/npm 11/Python 3.14; die exakten unterstützten Versionen Node 22/npm 10/Python 3.12 und CCXT 4.5.75 werden durch GitHub Actions geprüft.
- Das bestehende Frontend-Gesamtcoverage liegt unter 80 %, während die neue Kataloglogik direkte Tests besitzt und die gewichtete Gesamtcodeabdeckung über 80 % liegt.

## Offene TODOs

Keine funktionalen Phase-2-TODOs. Vor Phase 3 müssen der Dokumentationscommit hochgeladen, alle GitHub-Checks einschließlich SonarQube Cloud auf der exakten Main-Revision grün und der lokale Arbeitsbaum sauber sein.

## Bekannte Risiken

- Ein CCXT-Versionswechsel oder eine Abweichung von Certification-Evidence quarantiniert die betroffene Börse absichtlich.
- Ein unbekannter Exchange-Adapter kann erst nach separater Prüfung und neuer Evidence zertifiziert werden.
- Der dynamische Katalog kann zeitweise nicht erreichbar sein; in diesem Fall bleiben neue Konten fail-closed, vorhandene Konten und Trades aber funktionsfähig.

## Hinweise für Phase 3

- Phase 3 darf keine Registry- oder Credential-Nebenwirkungen in Workflow-Historien aufnehmen.
- Bestehende Börsenkennungen müssen als opaque, validierte Strings behandelt werden; keine feste Vierer-Union wieder einführen.
- Undo/Redo muss server-persistent und unveränderlich umgesetzt werden und darf weder Katalog-Probes noch Credential-Schreibvorgänge wiederholen.
- Vollständige RED/GREEN- und Gate-Nachweise stehen in `docs/testing/phase-2-dynamic-ccxt-registry.tdd.md`.
