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

Die RED-Tests wurden jeweils vor dem Produktionscode ausgeführt. Die Fehler waren die erwarteten fehlenden Registry-, Migrations-, API-, Credential- oder UI-Verträge. Der Produktionscheckpoint `62ebe9c` machte diese Tests grün. Der anschließende Refactor `f0e2831` beseitigte die vom Komplexitäts-Gate gemeldeten Überschreitungen ohne Contract-Änderung; dieselben Credential-, Migrations- und Webtests liefen danach erneut grün.

Der erste GitHub-Lauf erkannte die bewusst künstliche Gate.io-Credential-Zeile als generischen API-Key. `f213553` belegte zunächst per fehlschlagendem Supply-Chain-Test, dass eine eng begrenzte Ausnahme fehlte. `0995fb2` erlaubt ausschließlich die Regel `generic-api-key`, ausschließlich in `tests/test_dynamic_exchange_registry.js` und ausschließlich für das feste Dummy-Zeilenformat mit dreistelliger Zahl. Echte, abweichende oder an anderen Pfaden liegende Secrets bleiben blockiert.

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

## Vollständige lokale Gates

- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm run lint:frontend`: PASS
- `npm test`: PASS, 63/63 Testdateien
- `npm test --prefix frontend`: PASS, 16/16 Dateien und 90/90 Tests
- `python -m unittest discover -s exchange_executor/tests -v`: PASS, 38/38 Tests
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

## Coverage

- Kritische Backend-Suite: 97,47 % Statements, 89,03 % Branches, 100 % Functions, 97,47 % Lines.
- Testbare Kernmodule: 95,34 % Statements, 83,38 % Branches, 99,10 % Functions, 95,34 % Lines.
- Python-Executor: 71 % gesamt; neue Registry 91 %, Profile 91 %, Capabilities 87 %, Symbolresolver 93 %, Certification 72 % und Credentials 73 %.
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
