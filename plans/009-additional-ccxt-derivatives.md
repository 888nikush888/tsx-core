# Plan 009: Alle leicht integrierbaren CCXT-Derivatebörsen auf TSX-Niveau verifizieren

> Eigenständiger Zusatzauftrag vom 2. September 2026. Zuerst Reparaturen 001–007 abschließen; dieses Paket anschließend **vor der finalen Gesamtprüfung aus 008** ausführen. Vorbereitende Quality-Werkzeuge aus 008 dürfen bereits vorher entstehen. Nummerierung bestehender Pläne nicht ändern.
> Lokal in `C:/Users/nikla/Desktop/tsx-core`. Planbasis: `f8089277d0667dd45bcf070037800d423fd89254`, 2026-09-02, mit noch uncommitteten Audit-Reparaturen. Keine Server-, Konto-, Order-, Commit-, Push- oder Release-Autorisierung aus diesem Plan ableiten.

## Status und Ziel

- Status: LOKAL ABGESCHLOSSEN am 2026-09-04. Die vollständige Offlineinventur enthält 103 REST-IDs: 1 `existing` (Hyperliquid im engen Master-Key-only-/USDC-Perp-Scope), 66 konkret belegte `not_easy`, 36 `not_derivative` und 0 `pending`. Kein zusätzliches Profil wurde freigegeben; Bybit und Kraken Futures bleiben korrekt quarantined. Provider-/Kontoabnahme und Release bleiben außerhalb dieses Abschlusses.
- Priorität: beauftragte Funktionserweiterung vor Endabnahme; Aufwand L über mehrere jeweils kleine Profile; Risiko HOCH wegen Handels- und Schutzsemantik.
- Voraussetzungen: akzeptierte gemeinsame Verträge aus 001–007; Acceptance-Artefaktformat und sichere Fake-Testwerkzeuge aus 008.
- Ergebnis: vollständige Kandidateninventur der gepinnten CCXT-Version und Implementierungsverifikation aller daraus nachweislich leicht integrierbaren Futures-/Perp-Profile, mit derselben Prüftiefe wie Hyperliquid, Bybit und Kraken Futures nach den Reparaturen.

Der Auftrag lautet nicht, nur zwei bekannte Anbieter auszuwählen oder beliebige Börsen durch Setzen eines Zertifizierungsflags freizuschalten. Jedes geeignete zusätzliche Profil muss tatsächlich implementiert und getestet werden. Schwierige oder nicht unterstützbare Kombinationen erhalten nachvollziehbare Einzelbegründungen; fehlende Prüfung darf nicht als technische Ungeeignetheit ausgegeben werden.

## Begriffe und Grenzen

**Leicht integrierbar** bedeutet: Die erforderliche Semantik lässt sich mit der vorhandenen CCXT-/CCXT-Pro-Anbindung, kleinen Profilen, Normalisierungen und klar begrenzten Provider-Modulen abbilden. Kein neuer Börsen-SDK, keine zweite Execution Engine, keine neue Signatur-/Chain-Infrastruktur und kein grundlegender Umbau von Kontomodell, Produktlebenszyklus oder Geldbuchhaltung. Kleine Adapterergänzungen und zugehörige Tests sind ausdrücklich Teil des Auftrags. Fehlgeschlagene Tests machen einen ansonsten geeigneten Kandidaten nicht automatisch „schwer“.

**Gleicher Detailgrad** bedeutet den reparierten Sicherheitsstandard aus 001–007, nicht das Kopieren heutiger Lücken oder bloßer JSON-Bools. REST bleibt Order-/Abgleichautorität; CCXT Pro liefert Aktualisierungstrigger. `has`-Flags sind Vorfilter, keine Nachweise für atomaren Batch, Stop-Schutz, Vollständigkeit oder tatsächlichen Kontomodus. `emulated` nicht in ein natives `true` umdeuten.

**Produktgenaue Prüfung:** Futures und Perps inventarisieren, jeweils linear/invers, Settlement, Ablaufdatum, Kontomodus und Testnet/Live unterscheiden. Der aktuelle Resolver unterstützt nur lineare Perpetuals. Laufzeit-Futures oder inverse/Quanto-Kontrakte sind deshalb nicht stillschweigend unterstützt: je Kombination prüfen, ob sie innerhalb der obigen Grenze korrekt ergänzbar sind. Wenn Ablauf-/Roll-/Abrechnungslogik eine größere Architekturänderung benötigt, diese konkrete Kombination mit Beleg zurückstellen. Kein Futures-Signal auf einen Perp oder umgekehrt umdeuten; keine automatische Rollfunktion hinzufügen. Reine Spot-Produkte sind außerhalb des Auftrags.

**Zwei Nachweise:** `implementationVerified` bezeichnet die lokale TSX-Implementierungs- und Fixture-Abnahme. `providerAcceptanceVerified` benötigt echte, passende Provider-Evidenz aus dem separat autorisierten Verfahren von 008. Weder ein öffentlicher Marktabruf noch ein Fake-Test verifiziert ein reales Benutzerkonto. Fehlendes Testnet, regionale Zugangsbeschränkungen oder ungeprüfte Live-Fähigkeiten offen kennzeichnen; nichts durch echte Geld-Trades kompensieren.

## Aktueller Code und Konventionen

Die folgenden Auszüge wurden direkt aus der lokalen Arbeitskopie gelesen. Vorgängerpakete ändern gemeinsame Schnittstellen: vor Beginn den akzeptierten Folgestand übernehmen, nicht alte Auszüge zurückpatchen.

`exchange_executor/ccxt_profiles.py:33` definiert immutable `ExchangeProfile` mit unter anderem `default_type`, `settlement_preference`, `modes`, `protected_entry_strategy`, `identity_strategy`, `position_mode`, `margin_mode` und `credential_fields`. `PROFILES` ab Zeile 58 enthält derzeit ausschließlich `hyperliquid`, `bybit`, `krakenfutures`, jeweils mit `default_type="swap"`. Ein deklarierter Strategiename ersetzt keine implementierte und geprüfte Schutzlogik.

`exchange_executor/ccxt_capabilities.py:16`:
```python
CANDIDATE_REST_REQUIREMENTS = tuple(value for value in REST_CAPABILITIES if value != "createOrders")
CANDIDATE_PRO_REQUIREMENTS = PRO_CAPABILITIES
```
`capability_flags` prüft explizit `available.get(name) is True`. Aktuell erforderlich sind Balance, Positionen, offene Orders, eigene Fills, Submit, Cancel und Leverage sowie `watchOrders`, `watchMyTrades`, `watchPositions`; Batch ist zusätzlich strategieabhängig. Diese Sicherheitsvoraussetzungen nicht zum Erhöhen der Kandidatenzahl entfernen.

`exchange_executor/symbol_resolver.py:22`:
```python
def linear_swap_markets(markets: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        market for market in markets
        if market.get("contract") is True
        and market.get("swap") is True
        and market.get("linear") is True
        and market.get("active") is not False
        and str(market.get("base") or "").isalnum()
    ]
```
`resolve_symbol` verweigert fehlende und gleichrangig mehrdeutige Märkte. Produkt-, Kontraktgrößen- und Settlement-Grenzen auch bei neuen Profilen erhalten; keine symbolbasierte Fremdpositionsübernahme.

`exchange_executor/ccxt_registry.py`: `_initial_status` ab Zeile 132 trennt Discovery, fehlende Fähigkeiten und Profilattestation; `_probe_once` ab Zeile 208 lädt öffentliche Märkte, beweist aber keine privaten Kontofähigkeiten. `ccxt_certification.py` bindet Implementierungsattestationen an Profil- und CCXT-Version. Die bestehende ADR `docs/adr/0012-ccxt-visual-workflow-control-plane.md` trennt Implementierungs-Allowlist ausdrücklich von realer Testnet-/Produktionsabnahme.

`src/trading_types.ts:1` verwendet `TradingExchange = string` mit validiertem Exchange-Identifier, keine starre Drei-Börsen-Union. Katalog und bestehendes Konto-/Builder-Interface wiederverwenden, keine zusätzlichen Börsenformulare pro Anbieter bauen.

Testmuster: `exchange_executor/tests/test_phase2_registry.py` verwendet injizierte Fake-REST-/Pro-Module, `unittest.IsolatedAsyncioTestCase`, zählbare Aufrufe und einen `StaticExchange`, dessen unerwarteter Netzwerkzugriff sofort fehlschlägt. Dieses Muster übernehmen. Die bestehende Inventurassertion vergleicht alle Katalog-IDs mit `set(installed_ccxt.exchanges)`; entsprechend alle IDs im neuen Prüfmanifest abdecken.

Primärquellen zur späteren Detailprüfung: [CCXT-Quellcode](https://github.com/ccxt/ccxt), [CCXT Manual](https://docs.ccxt.com/docs/manual), [CCXT Pro Manual](https://docs.ccxt.com/docs/pro-manual). Zusätzlich je Kandidat dessen offizielle API-Dokumentation und die tatsächlich installierte CCXT-Implementierung prüfen. Die laufend aktualisierte Website ist kein Beleg für Fähigkeiten der gepinnten Version 4.5.75. Im Kandidatenmanifest konkrete Dokument-URLs, Abrufdatum und relevante Methoden/Quellstellen festhalten.

## Scope

Nur erforderliche, nachvollziehbare Änderungen in folgenden Bereichen:

- `exchange_executor/ccxt_profiles.py`, `ccxt_capabilities.py`, `ccxt_certification.py`, `ccxt_registry.py`, `ccxt_client.py`, `ccxt_adapter.py`, `symbol_resolver.py`; gemeinsame Current-State-, History-, Streaming- und Accounting-Module im selben Verzeichnis, soweit die neuen Profile diese Verträge benötigen.
- Kleine neue providerbezogene Module unter `exchange_executor/`; keine Kopien einer vollständigen Engine pro Börse. Accounting-/Execution-Constraints-Schnittstellen aus 004/005 übernehmen.
- `src/ccxt_exchange.ts`, `src/exchange_contract_validation.ts`, `src/exchange_history_contract.ts`, `src/exchange_history_coverage.ts`, `src/exchange_catalog.ts`, `src/trading_types.ts` ausschließlich für notwendige gemeinsame Katalog-/Vertragsabbildungen.
- `exchange_executor/certifications/*.json`: neue geprüfte Implementierungsattestationen und eindeutige Evidence-Referenzen, keine erfundene Providerabnahme.
- Neue `exchange_executor/tools/audit_derivatives_candidates.py`, `exchange_executor/tests/test_additional_exchange_profiles.py`, zusätzliche fokussierte Provider-Tests/Fixtures unter `exchange_executor/tests/`.
- Neue `tests/test_exchange_profile_parity.js`, erforderliche Erweiterungen bestehender CCXT-/History-/Catalog-/Fallback-Tests, `tests/run_all.js`, Acceptance-Validator und dessen Tests aus 008.
- Neue `docs/testing/ccxt-expansion-matrix.json` und `.md`; `docs/testing/exchange-acceptance.md`, genannte ADR, `docs/TRADING_GUIDE.md`, `README.md`, `plans/` für korrekte Nachweise.
- `sonar-project.properties` und `.github/workflows/quality.yml` ausschließlich zur Einbeziehung neuer produktiver Module, Tests und Prüfartefakte ohne Senkung bestehender Gates.

Nicht ändern: Benutzerkonten oder Credentials, Strategien, Builder-Graph, Margin-Prozent, SL-/TP-Preise, Leverage-Defaults, API-Key-Fingerprints, bestehende Betriebs-/Zugriffsrechte, Paketversionen, Datenbankhistorie. Kein UI-Redesign, kein automatisches Hinzufügen/Aktivieren von Konten, keine Netzwerkzugriffe auf TSX-Server oder laufende Anwendung. Produktbezogene Eingaben außerhalb des bestehenden Modells oder weitere Dateien erst begründet abklären.

## Runtime, Drift und Befehle

Arbeitsverzeichnis für alle Befehle: `C:/Users/nikla/Desktop/tsx-core`. Bestehende schmutzige Arbeitskopie erhalten; keine Resets, Branchwechsel oder Commits. Erforderlich Node 22.x / npm 10.9.x, Python 3.12, CCXT 4.5.75. Kein automatisches Update. Verifizierte lokale Runtimepfade:

```powershell
$tsxNode = 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe'
$tsxPython = 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe'
$tsxRuff = 'C:/Users/nikla/AppData/Local/Temp/tsx-core-ccxt-py312/Scripts/ruff.exe'
git status --short
git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src exchange_executor tests scripts docs .github sonar-project.properties
git diff --stat HEAD -- src exchange_executor tests scripts docs .github sonar-project.properties
& $tsxNode --version
& $tsxPython -c "import sys,ccxt; print(sys.version); print(ccxt.__version__)"
```

Beide Driftprüfungen sind nötig: uncommittierte Vorgängerarbeiten bleiben bei einem reinen Commitvergleich unsichtbar. Erwartete Änderungen aus 001–007 mit deren Übergaben abgleichen und dokumentieren. Unerklärter Vertragsdrift ist eine STOP-Bedingung. Bei fehlendem Runtimepfad vorhandene geeignete Runtime lokalisieren; nicht durch zufällig installiertes Node 24 oder andere CCXT-Version ersetzen.

Vorhandene Gates:

```powershell
& $tsxPython -B -m unittest discover -s exchange_executor/tests
& $tsxRuff check exchange_executor
& $tsxNode node_modules/typescript/bin/tsc --noEmit
& $tsxNode node_modules/eslint/bin/eslint.js 'src/**/*.ts' 'tests/**/*.js' 'scripts/**/*.js' '*.js' --quiet
& $tsxNode tests/run_all.js
& $tsxNode scripts/check_architecture.js
& $tsxNode scripts/check_complexity_budget.js
git diff --check
```

Jeden Exitcode einzeln prüfen: erwartet 0, alle Tests grün, keine neuen Ausnahmen oder unregistrierten Tests. Coverage, Frontend, Browser, Mutation, Build, Sonar und exakte Revisionsabnahme laufen anschließend vollständig unter 008; Profile durchlaufen zusätzlich die fokussierten Gates unten. Die neue Inventur darf erst nach Anlage des Werkzeugs aufgerufen werden.

## Umsetzungsschritte

### 1. Vollständige und reproduzierbare Kandidatenmatrix erstellen

Alle IDs von `ccxt.async_support.exchanges` der installierten Version inventarisieren. Derivate-Subklassen und regionale Varianten nicht vergessen, Markenaliase nicht doppelt als integrierte Börsen zählen. Aliasbeziehungen belegen, nicht anhand ähnlicher Namen raten. Pro ID und Produkt-/Moduskombination speichern:

- CCXT-/Profilversion und Quellhash, kanonische ID/gegebenenfalls Alias, REST-/Pro-/Credential-Fähigkeiten einschließlich nativer/emulierter/fehlender Unterstützung;
- Futures/Perp, linear/invers/Quanto, Settlement, Kontraktgröße, Ablauf-/Preis-/Mengenbedingungen;
- Schutzstrategie, Modusnachweis, Identität, aktuelle/historische Datenvollständigkeit, Funding-/Fee-Währungen, Testnet-Hosts und Einschränkungen;
- Dokument- und Quellbelege, Integrationsumfang, Entscheidung `existing`, `eligible`, `not_easy`, `not_derivative` oder `pending`, konkrete Begründung und unabhängige Implementierungs-/Providerstatus.

Werkzeug standardmäßig `--offline`, ohne Secrets und Netzwerk. Optionales `--public-markets` erlaubt ausschließlich begrenzte, unauthentifizierte öffentliche Marktdatenabfragen, keinen TSX-/Kontozugriff. Timeouts, Parallelitäts-/Ratenlimit und fehlende Daten sichtbar behandeln. Ausfall einer Dokumentseite oder API bedeutet `pending`, nicht „ungeeignet“. Zunächst keine willkürliche Top-N-Liste festlegen.

**Gate:** neue `test_additional_exchange_profiles.py` prüft vollständige Mengenabdeckung, Aliasnachweise, Schema, reine Spot-Ausgrenzung, emulierte Fähigkeiten und standardmäßig null Netzwerk-/Secretzugriffe. `& $tsxPython -B -m unittest discover -s exchange_executor/tests -p test_additional_exchange_profiles.py` → grün. `& $tsxPython -B exchange_executor/tools/audit_derivatives_candidates.py --offline --verify-inventory docs/testing/ccxt-expansion-matrix.json` → Exit 0, keine fehlende ID; `pending` in diesem frühen Schritt noch sichtbar zulässig.

### 2. Gemeinsame Paritätsmatrix vor den einzelnen Profilen implementieren

Die neuen Profile durchlaufen dieselben folgenden Pflichtklassen wie die drei reparierten bestehenden Profile. Je Klasse konkrete normale und adversariale Provider-Fixtures, Quellbeleg und erwartetes Verhalten erfassen:

| Bereich | Erforderliche Nachweise |
|---|---|
| Identität und Secrets | Kontobindung/Subaccount, Credential-Generation, Rotation, stale Request, fehlende/ungültige Berechtigung; keine Secretlogs |
| Symbol und Produkt | exakte Marktauflösung, Mehrdeutigkeit, `contractSize`, Dezimalpräzision, Settlement, Mindest-/Maximalmenge, inaktive/fehlende Märkte, keine Spot-/Futures-Verwechslung |
| Kontomodus und Admission | tatsächlich gelesener Position-/Margin-Modus, mengenabhängige Leverage-Tiers, begrenzter Entry-Preis, Margin-/Reserveberechnung, Konto-Positionslimit |
| Entry und Schutz | nachgewiesene Entry-/Stop-Zuordnung, stabile eigene IDs, keine behauptete Batchatomizität, Teilannahme, unbekannter Submit, Partial-/Late-Fill, Reduce-only und Triggersemantik |
| Ownership und Abgleich | nullable fremde clientOrderId, verpflichtende Exchange-ID, Namensräume, eindeutige/mehrdeutige/unbekannte Orders/Fills; nie fremde Exposure übernehmen oder löschen |
| Historie | alle erforderlichen Produkt-/Settlement-/Symbolbereiche, Pagination, Retention, Zeitgrenzen, Duplikate, leere/volle Seiten, persistierte Cursor und Budget; unvollständig bleibt unvollständig |
| Lebenszyklus | Stop-/TP-Anpassung, adaptive Stops nur strenger, verbleibende eigene Menge, Cancelterminalität, Entry-Drain, Kill, Recovery, verspätete Fills, gemeinsamer Freigabebeweis |
| Geld und Risiko | Fee/Rebate-Vorzeichen, Funding-Vollständigkeit, Originalwährung, belegte Umrechnung, Replay/Idempotenz, ungeklärte Bewertung blockiert nur neue riskante Admission |
| Fehler und Streams | 502/503/Timeout getrennt von Vertragsfehlern, kein Blind-Submit-Retry, Pro-Abbruch/Reconnect/Duplikate, REST bleibt Autorität |
| Cross-Layer | Original-Signal-TTL auch über Fallback, keine Zweitausführung nach unklarem Submit, parallele Konten getrennt, Neustart-/Wartungsfences schützen weiterhin |

`createOrders=True` allein darf keinen dieser Fälle bestehen lassen. Nicht unterstützte Schutzstrategien führen zu einem nicht freigabefähigen Profil, nicht zu ungeschütztem Entry. Nicht zutreffende Fälle nur mit technisch überprüfbarer Begründung zulassen; ein Pflichtschutz kann nicht als N/A umgangen werden.

**Gate:** `tests/test_exchange_profile_parity.js` anlegen und registrieren. `& $tsxNode tests/run_all.js test_exchange_profile_parity.js` → grün einschließlich negativer Fälle: fehlende Pflichtfixture, gefälschte Attestation, Versions-/Hashdrift, unbewiesener Modus, bloßes CCXT-Flag, falscher Produktbereich. Der Gate muss mindestens eine absichtlich unvollständige Fixture nachweislich ablehnen, bevor vollständige Fixtures akzeptiert werden.

### 3. Jeden geeigneten Kandidaten klein und separat integrieren

Je `eligible`-Kombination offizielle API-Semantik und installierten CCXT-Code lesen, kleines Profil/Adapter ergänzen, zulässige Modi/Produkte exakt deklarieren. Bestehende Normalisierung und Beweise wiederverwenden; Anbieterbesonderheiten in eng begrenzten Modulen halten. Jede Shared-Contract-Änderung gegen alle bereits integrierten Profile regressieren. Parallelisierung ist je unabhängigem Profil möglich; gemeinsame Dateien haben einen koordinierenden Eigentümer.

Private Kontodaten nur über das bestehende verifizierte Laufzeitmodell, nicht aus öffentlichen Metadaten ableiten. Neue Nutzerkonten bleiben unverified, bis der Nutzer sie regulär verifiziert. Keine Kontokonfiguration automatisch aus dem Dokument oder aus Beispielcredentials erzeugen.

**Gate pro Profil:** zugehörige Python-Fixtures, `& $tsxPython -B -m unittest discover -s exchange_executor/tests`, `& $tsxNode tests/run_all.js test_exchange_profile_parity.js`, Typecheck, Ruff, Architektur und Complexity → Exit 0. Exakte eigene Fake-Requestzahl, Orderidentität, persistierte Zustände und Schutzwirkung prüfen. Katalog darf vor vollständiger Implementierungs-Evidence keinen zertifizierten Status zeigen.

### 4. TSX-Implementierungsverifikation und Katalog vervollständigen

Erst nach grünen Profiltests passende Implementierungsattestation erstellen. Produkt-/Modusumfang, CCXT-Version, Profil-/Implementierungshash, Testnamen/-resultate und Prüfzeit maschinenlesbar anbinden. Gemeinsame Adapteränderungen invalidieren betroffene Nachweise ebenso wie Profiländerungen. Acceptance-Validator aus 008 muss neue Profile dynamisch mitprüfen; keine Drei-Profil-Sonderliste zurücklassen.

Bestehende Kontoauswahl, Credentialfelder und Builder-Konten verwenden den Katalog. Nicht implementierte oder ungeprüfte Kombinationen bleiben klar gesperrt. Dokumentation nennt tatsächlichen Supportumfang, Identitäts-/Rotationsgrenzen, Testnet-Verfügbarkeit und reale Abnahme separat. ADR an dieser Stelle gezielt von der ursprünglichen Drei-Profil-Implementierungsgrenze auf den überprüften Erweiterungsumfang aktualisieren; keine rückwirkende Änderung historischer Nachweise.

**Gate:** Paritätstest und bestehende Registry-/Catalog-/Acceptance-Tests grün. Manipulierte/unvollständige Evidence verhindert Freigabe. Fake-Artefakte ergeben niemals `providerAcceptanceVerified=true`. `& $tsxPython -B exchange_executor/tools/audit_derivatives_candidates.py --offline --verify-complete docs/testing/ccxt-expansion-matrix.json` → Exit 0 nur wenn alle inventarisierten IDs entschieden und alle geeigneten Profile mit vollständiger Implementierungs-Evidence hinterlegt sind. Dieser zweite Modus muss `pending`, fehlende Profile und unbegründete Ausgrenzungen ablehnen.

### 5. Erweiterungsabschluss an 008 übergeben

Prüfmatrix, neue Profile, Quellbelege, Testresultate, Supportgrenzen und offene reale Providerabnahmen in einer Übergabe dokumentieren. Alle Gates aus dem Befehlsabschnitt ausführen. Sonar-Coverage-Konfiguration um jedes neue produktive Modul ergänzen. Anschließend führt 008 die **Gesamtprüfung über alte und neue Profile und sämtliche Reparaturen** durch.

Reale Providerabnahme erst mit ausdrücklicher separater Testnet-Autorisierung und den Pflichtlimits, Host-/Accountnachweisen sowie Eigentums-/Cleanupregeln aus 008. Ein Testnet ohne geeignete reproduzierbare Fälle bleibt NOT_PROVEN; kein automatischer Mainnet-Ersatz.

**Gate:** gesamte lokale Python-/Node-Suite, Typecheck, Lint, Architektur, Complexity und Diffprüfung Exit 0; vollständiges Inventurmanifest und Paritätsgate grün. Ergebnis und verbleibende Provider-/Releasegrenzen in `plans/README.md` und `docs/testing/exchange-acceptance.md` konsistent. 008-Endabnahme noch nicht durch diese Übergabe als bestanden markieren.

## Abschlusskriterien

- [ ] Jede ID der gepinnten CCXT-Version ist inventarisiert, Produkt-/Modusunterschiede und Aliase sind nachvollziehbar.
- [ ] Jeder leicht integrierbare Derivatekandidat ist tatsächlich integriert und lokal mit allen zutreffenden Paritätsfällen verifiziert, nicht nur aufgelistet.
- [ ] Keine offenen `pending`-Entscheidungen oder unbegründeten Ausgrenzungen; technische Nicht-Eignung hat konkrete API-/Codebelege.
- [ ] Alle alten und neuen Profile bestehen dieselben gemeinsamen Sicherheitsregressionen; kein geringerer Standard zugunsten größerer Börsenzahl.
- [ ] Neue Produkt-/Moduskombinationen werden exakt abgegrenzt; unbewiesene Unterstützung bleibt gesperrt.
- [ ] Implementierungs- und reale Providerabnahme sind getrennt, keine vorhandenen Konten aktiviert oder verändert.
- [ ] Alle oben genannten lokalen Gates und `--verify-complete` grün; vollständige Integration an 008 übergeben.

DONE dieses Pakets bedeutet vollständige lokale Implementierungsverifikation im beschriebenen Umfang, nicht echte Provider-/Releaseabnahme. Bei fehlenden Nachweisen den entsprechenden Status offen lassen.

## STOP-Bedingungen und Wartung

Bei erforderlichem neuen SDK, grundlegender Produkt-/Identitäts-/Accountingmigration oder nicht beweisbarem Schutz nicht improvisieren: betroffene Kombination mit konkreter Begründung melden, andere unabhängige Kandidaten weiter prüfen. Fehlende Kontoautorität stoppt ausschließlich reale Kontoaktionen; lokale Arbeit fortsetzen. Dokumentations-/Providerstörungen nicht als dauerhaften technischen Ausschluss missbrauchen. Unerklärte Vorgänger-Vertragsänderung, notwendige Out-of-Scope-Dateien oder zweimal fehlgeschlagener Gate nach begründetem Korrekturversuch erfordern Review statt Abschwächung der Prüfung.

Künftige CCXT-, Profil-, Provider- oder gemeinsame Vertragsänderungen invalidieren betroffene Evidence. Manifest und Paritätsmatrix bei jeder Erweiterung fortführen; weder laufende Website-Badges noch ein früher grüner Main-Commit ersetzen die Abnahme der tatsächlichen Revision.
