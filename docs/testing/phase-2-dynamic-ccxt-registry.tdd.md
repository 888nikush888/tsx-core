# Phase 2: TDD-Nachweis für die dynamische CCXT-Registry

## Quelle und Nutzerziele

Quelle ist Phase 2 der Master-Gesamtspezifikation `TSX-Core_4-Plans_MASTER-Gesamtspezifikation_KEINE-SUBAGENTS.md`.

- Als Betreiber möchte ich alle im gepinnten CCXT-REST-Paket installierten Börsen ohne Netzwerkzugriff entdecken können.
- Als Betreiber möchte ich nur nachweislich zertifizierte Börsenkonten anlegen können, damit unbekannte Adapter nie automatisch live handeln.
- Als Betreiber möchte ich Kandidaten öffentlich prüfen können, ohne Credentials anzugeben und ohne dadurch eine Zertifizierung zu erhalten.
- Als bestehender Nutzer möchte ich Hyperliquid, Bybit und Kraken Futures unverändert weiterverwenden können.
- Als Betreiber möchte ich dynamische Börsenkennungen in Datenbank, Analytics, Setup-Bundle und UI verwenden können, ohne historische Daten zu verlieren.
- Als Betreiber möchte ich Credential-Dateien verlustfrei von V1 nach V2 migrieren und nur exakt erlaubte Geheimnisfelder speichern können.

## Planaufgabe zu RED/GREEN

| Planverhalten | Testziel | RED-Checkpoint | GREEN-Nachweis |
|---|---|---:|---|
| Dynamische Registry, sichere Kennungen und V2-Credentials | `tests/test_dynamic_exchange_registry.js`, `tests/test_trading_credentials.js`, `exchange_executor/tests/test_phase2_registry.py` | `8185d88` | `62ebe9c`, `f0e2831` |
| Nur zertifizierte, modusfähige Konten anlegen | `tests/test_trading_web_control.js`, `frontend/tests/exchange-catalog.test.ts` | `2e0a88a` | `62ebe9c` |
| Executor-Verträge, Profildrift und Symbolauflösung | `exchange_executor/tests/test_contracts.py`, `exchange_executor/tests/test_phase2_registry.py` | `9c769ec` | `62ebe9c` |
| Append-only Migration 19 und Setup-Bundle-Kompatibilität | `tests/test_dynamic_exchange_registry.js`, `tests/test_setup_bundle.js` | `0d57c15` | `62ebe9c` |
| Accountloser öffentlicher Probe-Endpunkt | `tests/test_web_server.js`, `frontend/e2e/dashboard.spec.ts` | `7dd612e` | `62ebe9c` |
| Vollständiger installierter Katalog und Versionsdrift | `exchange_executor/tests/test_phase2_registry.py`, `tests/test_supply_chain.js` | `dc03db3` | `62ebe9c` |
| Dynamische historische Analytics- und Telemetriegrenzen | `tests/test_trading_analytics.js`, `tests/test_web_server.js` | `5255639` | `62ebe9c` |
| Vollständige statische Deskriptoren ohne Startup-Netzwerk | `exchange_executor/tests/test_phase2_registry.py` | `0ac86b4` | `62ebe9c` |
| Gitleaks unterscheidet die feste Test-Credential-Zeile von echten Secrets | `tests/test_supply_chain.js`, `.gitleaks.toml` | `f213553` | `0995fb2` |
| Credential-Cache-Fingerprints verwenden den kanonischen Credential-Satz direkt als HMAC-Schlüsselmaterial | `exchange_executor/tests/test_contracts.py`, CodeQL `py/weak-sensitive-data-hashing` | `bd48f11` | `e4bd764` |
| Der Modul-Coverage-Ratchet bleibt plattformübergreifend konservativ und deckt sämtliche Katalog-Fehlerverträge direkt ab | `tests/test_module_coverage.js`, `tests/test_dynamic_exchange_registry.js` | `c3622ff` | `43e9697` |
| Containerisierte Executor-Tests behalten denselben Repository-Bezug wie lokale Tests und finden Certification-Evidence | `tests/test_supply_chain.js`, `.github/workflows/quality.yml` | `60c96b7` | `9f19f0c` |
| Sonar-Gate: Executor-Ursprung ist auf interne HTTP-Ziele begrenzt, parallele Katalogabrufe werden geteilt und die beiden Python-Funktionen bleiben unter dem Komplexitätsbudget | `tests/test_dynamic_exchange_registry.js`, `tests/test_ccxt_exchange.js`, `exchange_executor/tests/test_contracts.py`, `exchange_executor/tests/test_phase2_registry.py` | `372e8bf`, `a817e45` | `cad05e2` |

Die RED-Tests wurden jeweils vor dem Produktionscode ausgeführt. Die Fehler waren die erwarteten fehlenden Registry-, Migrations-, API-, Credential- oder UI-Verträge. Der Produktionscheckpoint `62ebe9c` machte diese Tests grün. Der anschließende Refactor `f0e2831` beseitigte die vom Komplexitäts-Gate gemeldeten Überschreitungen ohne Contract-Änderung; dieselben Credential-, Migrations- und Webtests liefen danach erneut grün.

Der erste GitHub-Lauf erkannte die bewusst künstliche Gate.io-Credential-Zeile als generischen API-Key. `f213553` belegte zunächst per fehlschlagendem Supply-Chain-Test, dass eine eng begrenzte Ausnahme fehlte. `0995fb2` erlaubt ausschließlich die Regel `generic-api-key`, ausschließlich in `tests/test_dynamic_exchange_registry.js` und ausschließlich für das feste Dummy-Zeilenformat mit dreistelliger Zahl. Echte, abweichende oder an anderen Pfaden liegende Secrets bleiben blockiert.

Der folgende GitHub-Lauf lieferte zwei weitere echte RED-Nachweise. CodeQL meldete `py/weak-sensitive-data-hashing`, weil der kanonische Credential-Satz vor dem vorhandenen HMAC unnötig mit einfachem SHA-256 vorverarbeitet wurde. Der Regressionstest in `bd48f11` schlug gegen genau diesen Vertrag fehl; `e4bd764` übergibt den kanonischen Satz nun unmittelbar an den HMAC-basierten Cache-Key und machte den Einzeltest sowie alle 39 Executor-Tests grün. Außerdem deckte Linux-CI auf, dass `47f46d4` einen nur unter Windows beobachteten Coverage-Wert als gemeinsame Baseline eingetragen hatte. `c3622ff` reproduzierte die fehlende Plattformkennzeichnung rot und ergänzt direkte Negativ- und Probe-Tests für den vollständigen Katalogvertrag. `43e9697` stellt die zuvor bereits unter Linux und Windows bestätigte konservative Baseline wieder her; der lokale vollständige Modul-Lauf liegt danach klar darüber.

Im Container-Gate waren Anwendung, CCXT 4.5.75 und alle 39 Tests grundsätzlich lauffähig; lediglich zwei Registry-Tests fanden ihre Certification-Evidence nicht, weil das Workflow-Mount den Testbaum von `/app/tests` nach `/tests` verschoben hatte. `60c96b7` hält diesen falschen Repository-Bezug als roten Supply-Chain-Vertrag fest. `9f19f0c` mountet die Tests schreibgeschützt unter `/app/tests`, sodass `Path(__file__).parents[1]` wie lokal auf `/app` und damit auf die im Image vorhandene `/app/certifications` zeigt.

Der anschließende vollständige GitHub-Lauf bestand sämtliche Gates außer SonarQube Cloud. Dessen exportierter Befund enthielt zwei kritische Cognitive-Complexity-Issues sowie je einen Sicherheits- und Zuverlässigkeitsbefund am Executor-Ursprung beziehungsweise an der In-flight-Korrelation. `372e8bf` reproduzierte die Python-Hilfsverträge und den direkten Katalogfall rot; `a817e45` ergänzte den zweiten unabhängigen Clientpfad. `cad05e2` zentralisiert die ausschließlich intern erlaubten Executor-Ursprünge, teilt parallele Katalogabrufe korrekt und zerlegt Markt- sowie Credential-Prüfungen in direkt getestete Hilfsfunktionen. Fremde HTTP-Ziele werden nun vor jedem Request abgelehnt; der Compose-interne HTTP-Transport bleibt ausdrücklich auf Loopback und den privaten Servicenamen begrenzt.

## Testbare Garantien

| # | Garantie | Test oder Befehl | Typ | Ergebnis |
|---:|---|---|---|---|
| 1 | Jede installierte CCXT-REST-Börse ist statisch discoverbar; Registry-Start führt kein `loadMarkets()` aus. | `exchange_executor/tests/test_phase2_registry.py` | Unit/Integration | PASS |
| 2 | Nur Hyperliquid, Bybit und Kraken Futures sind mit passender Evidence und CCXT-Version zertifiziert. | `exchange_executor/tests/test_phase2_registry.py`, `tests/test_supply_chain.js` | Security/Contract | PASS |
| 3 | Versions- oder Profildrift setzt eine Börse auf `quarantined`; fehlende installierte Profile werden `deprecated`. | `exchange_executor/tests/test_phase2_registry.py` | Security | PASS |
| 4 | Ein öffentlicher Markt-Probe kann höchstens `candidate`, niemals `certified`, liefern. | `exchange_executor/tests/test_phase2_registry.py`, `tests/test_web_server.js` | Integration | PASS |
| 5 | Die Symbolauflösung akzeptiert nur aktive lineare Swaps, beachtet die Settlement-Präferenz und scheitert bei Mehrdeutigkeit geschlossen. | `exchange_executor/tests/test_phase2_registry.py` | Unit | PASS |
| 6 | Credential V2 erlaubt ausschließlich die festgelegten zehn Felder; V1 wird atomar und verlustfrei migriert. | `tests/test_trading_credentials.js`, `exchange_executor/tests/test_phase2_registry.py` | Unit/Integration | PASS |
| 7 | Migration 19 erhält bestehende Accounts, Intents, Events, Indizes und Fremdschlüssel; ein ungültiger Altbestand rollt vollständig zurück. | `tests/test_dynamic_exchange_registry.js` | DB-Integration | PASS |
| 8 | Bei Katalogausfall sind neue Konten blockiert, während bestehende Konten weiterhin geprüft werden können. | `tests/test_trading_web_control.js` | Integration | PASS |
| 9 | Frontend gruppiert zertifizierte Börsen, prüfbare Kandidaten und übrige Einträge; nur zertifizierte Einträge können Konten erzeugen. | `frontend/tests/exchange-catalog.test.ts`, `frontend/tests/operations-workspace.test.tsx` | UI | PASS |
| 10 | Dynamische syntaktisch gültige Börsenkennungen funktionieren in Analytics und Setup-Bundles; historische Filter brauchen keinen aktuellen Katalogeintrag. | `tests/test_trading_analytics.js`, `tests/test_setup_bundle.js`, `tests/test_web_server.js` | Integration | PASS |
| 11 | Executor-Katalog und Probe sind authentifiziert, accountlos und übertragen keine Secrets. | `tests/test_web_server.js`, `exchange_executor/tests/test_phase2_registry.py` | API/Security | PASS |
| 12 | Desktop- und Mobilabläufe bleiben über Chromium, Firefox, WebKit und Mobil-Chromium bedienbar. | `npm run test:e2e --prefix frontend` | E2E | PASS, 40/40 |
| 13 | Katalogantworten mit ungültigem Ursprung, Vertrag, Metadaten, Credentials, Modi, Gründen oder Capabilities werden fail-closed verworfen; Probe-Fehler, Fremd-IDs und Paper-Probes ebenso. | `tests/test_dynamic_exchange_registry.js` | Security/Contract | PASS |
| 14 | Credential-Fingerprints sind deterministische, 64-stellige HMAC-Werte und ändern sich bei einer Credential-Änderung. | `exchange_executor/tests/test_contracts.py` | Security/Unit | PASS |
| 15 | Die containerisierte Python-Suite läuft gegen exakt dieselbe Certification-Evidence wie der Executor-Prozess, ohne Tests oder Evidence in das Runtime-Image einzubauen. | `tests/test_supply_chain.js`, GitHub-Container-Gate | Supply Chain/Integration | PASS |
| 16 | Der Executor-Transport akzeptiert Plain-HTTP ausschließlich zu Loopback oder zum privaten Compose-Service; ein konfigurierter Fremdhost wird in Katalog und Handelsclient vor dem Request fail-closed abgelehnt. | `tests/test_dynamic_exchange_registry.js`, `tests/test_ccxt_exchange.js` | Security/Integration | PASS |
| 17 | Parallele nicht erzwungene Katalogabfragen verwenden exakt dieselbe laufende Anfrage, ohne Promise-Wahrheitswert als fachliche Bedingung zu missbrauchen. | `tests/test_dynamic_exchange_registry.js` | Concurrency/Unit | PASS |
| 18 | Marktgrenzen, Markpreis und Credential-Textfelder behalten nach der Komplexitätszerlegung ihre Grenz-, Fallback- und Steuerzeichenverträge. | `exchange_executor/tests/test_contracts.py`, `exchange_executor/tests/test_phase2_registry.py` | Unit/Security | PASS |

## Vollständige lokale Gates

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run lint:frontend`: PASS
- `npm test`: PASS, 63/63 Testdateien
- `npm test --prefix frontend`: PASS, 16/16 Dateien und 90/90 Tests
- `python -m unittest discover -s exchange_executor/tests -v`: PASS, 41/41 Tests
- `npm run build`: PASS
- `npm run quality:architecture`: PASS, 60 Module, 193 interne Imports, 0 Zyklen
- `npm run quality:complexity`: PASS, 0 Warnungen und Worst-Case-Komplexität 15
- `npm run quality:frontend`: PASS, 37/37 Frontendmodule erreichbar
- `npm run quality:duplicates`: PASS, 0,83 % duplizierte Zeilen bei 5-%-Grenze
- `npm run quality:release`: PASS
- `npm run quality:risk-acceptances`: PASS
- `npm run quality:build-context`: PASS
- `npm audit --audit-level=moderate`: PASS, 0 Schwachstellen
- `npm audit --prefix frontend --audit-level=moderate`: PASS, 0 Schwachstellen
- `npm run quality:licenses`: PASS
- `npm run quality:dependencies`: PASS
- `npm run quality:sbom`: PASS
- `npm run test:e2e --prefix frontend`: PASS, 40/40

`npm run quality:monitoring` wurde lokal ausgeführt, konnte aber ohne laufende Docker-Desktop-Engine kein gehärtetes Prometheus-Image bauen. Dieser umgebungsabhängige Check ist lokal daher **NOT RUN** und nicht als bestanden gewertet. Der unterstützte GitHub-Lauf führt das Gate in seiner vorgesehenen Linux-/Docker-Umgebung aus.

`npm run quality:deployment-images` ist ohne die drei produktiven, digest-gepinnten Image-Variablen nicht anwendbar und wurde nicht als Phase-2-Gate gewertet. Es hat keine Produktivkonfiguration verändert.

## GitHub- und Sonar-Abschluss

- Exakte Main-Revision: `38427ad348c5d28d378de47ed52d11a82b0152b0`
- GitHub-Actions-Lauf: `33265072101`, Gesamtstatus `success`
- Erfolgreich: CodeQL, vier Browser-/Accessibility-Gates, vier Mutation-Gates, Linux-Lint/Tests/Coverage/Build/Supply-Chain, Container/SBOM/Vulnerability-Scan, Secret-History-Scan und SonarQube Cloud.
- Sonar-Analyse: `72f6f401-5f40-4551-b36f-89dec3c56a97`; Revision stimmt exakt überein.
- Sonar Quality Gate: `OK`; neue Reliability-, Security- und Maintainability-Ratings jeweils A, neue Coverage 86,5 %, neue Duplikation 0,0 % und Hotspot-Review 100 %.
- Offene Blocker/Critical-Issues: 0; ungeprüfte Security Hotspots: 0.

## Coverage

- Kritische Backend-Suite: 97,47 % Statements, 89,03 % Branches, 100 % Functions, 97,47 % Lines.
- Testbare Kernmodule auf Windows nach den zusätzlichen Katalog-Vertragstests: 95,40 % Statements, 83,70 % Branches, 99,17 % Functions, 95,40 % Lines.
- Gemeinsamer Linux-/Windows-Ratchet: 95,01 % Statements, 83,33 % Branches, 99,09 % Functions, 95,01 % Lines; `verifiedPlatforms` macht die Herkunft ausdrücklich prüfbar.
- Python-Executor: 79 % gesamt im vollständigen Phase-2-Lauf; die neu extrahierten Credential-Hilfen erreichen 79 % und sind durch Grenz- sowie Steuerzeichentests direkt abgedeckt.
- Frontend-Gesamtbestand: 60,18 % Statements, 53,28 % Branches, 52,16 % Functions, 60,98 % Lines.

Die neue Exchange-Katalog-Hilfe besitzt direkte Unit-Tests; der bestehende breite Frontend-Bestand bleibt unter 80 %. Über Backend, Frontend und Python liegt die gewichtete Gesamtabdeckung über 80 %, und alle neuen sicherheitskritischen Phase-2-Verträge sind direkt abgedeckt.

## Bekannte Umgebungsgrenzen

- Lokal liefen Node 24/npm 11 und Python 3.14. Das Projekt unterstützt Node 22/npm 10 und Python 3.12; diese exakten Versionen werden nach dem Push von GitHub Actions gegen dieselbe Main-Revision geprüft.
- Die lokale Python-Umgebung enthält nicht die im Lockfile gepinnte CCXT-Version 4.5.75. Das Lockfile, die Certification-Evidence und der Supply-Chain-Test erzwingen 4.5.75; GitHub installiert sie hash-geprüft in Python 3.12.
- Zwei parallele Belastungsläufe überschritten einmal das enge 100-ms-ReDoS-Testfenster beziehungsweise das 30-s-WebKit-Fenster. Beide betroffenen vollständigen Gates wurden anschließend isoliert wiederholt und bestanden; nur die isolierten PASS-Läufe gelten als Abschlussnachweis.

## Checkpoints

- RED Registry-Grundlagen: `8185d88`
- RED zertifizierter Kontoablauf: `2e0a88a`
- RED Executor-/Drift-Verträge: `9c769ec`
- RED Migration und Bundle: `0d57c15`
- RED öffentlicher Probe: `7dd612e`
- RED installierter Katalog: `dc03db3`
- RED Telemetrie: `5255639`
- RED statische Deskriptoren: `0ac86b4`
- GREEN Produktion: `62ebe9c`
- GREEN Refactor/Komplexität: `f0e2831`
- Coverage-Ratchet: `47f46d4`
- RED enger Gitleaks-Fixture-Vertrag: `f213553`
- GREEN enger Gitleaks-Fixture-Vertrag: `0995fb2`
- RED HMAC-Credential-Fingerprint: `bd48f11`
- GREEN HMAC-Credential-Fingerprint: `e4bd764`
- RED plattformübergreifender Coverage-Vertrag: `c3622ff`
- GREEN plattformübergreifender Coverage-Ratchet: `43e9697`
- RED Container-Fixture-Bezug: `60c96b7`
- GREEN Container-Fixture-Bezug: `9f19f0c`
- RED Sonar-Komplexität, Katalog-Korrelation und erster Ursprungsvertrag: `372e8bf`
- RED unabhängiger CCXT-Client-Ursprungsvertrag: `a817e45`
- GREEN Sonar-Gate-Korrekturen: `cad05e2`
