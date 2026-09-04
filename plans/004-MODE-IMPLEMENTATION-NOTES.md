# 004 Schritt 1: tatsächlicher Account-/Symbolmodus

Stand 2026-09-02. **Lokal implementiert und mit Fixtures geprüft; keine reale Providerabnahme. Nicht Gesamt-004-DONE.** Schritt 4 ist separat in `004-ENTRY-TTL-IMPLEMENTATION-NOTES.md` dokumentiert. Schritte 2/3 (harte Entry-Preisgrenze, notionalabhängige Tiers) sind durch diesen Teil nicht erledigt.

## Umfang und Verträge

- Neu `exchange_executor/execution_constraints.py`: strikt begrenzte, nur lesende Account-/Symbolbeobachtungen, kontrollierte Fehlercodes, Profilhash und finaler Binding-/Freshness-Guard.
- `ccxt_profiles.py`: getrennte deklarative Fähigkeiten für One-way, Margin, Leverage lesen/setzen und geschützten preisbegrenzten Entry. Letzterer bleibt bei allen drei Profilen `not_proven`; ein Profilflag ist kein beobachteter Kontozustand.
- `ccxt_adapter.py`: Verify ergänzt tatsächliche Konto-Modusbeobachtung; symbolbezogene `entry_constraints`; Modusreadback vor Leverage und final vor Entry. Reporting-/Accounting-Hunks anderer Pakete bleiben erhalten. Reduce-only-Orders verwenden die Entry-Modusprüfung nicht.
- `server.py`: authentifizierte interne, nur lesende Route `/v1/entry-constraints`. Sie erhält wie andere Kontomutationen die erwartete Accountbindung, führt aber selbst keine Mutation aus.
- `src/trading_execution_constraints.ts`, `trading_types.ts`, `ccxt_exchange.ts`: versionierter Antwortvertrag, kontrollierte Fehlerübertragung, HTTP-Prüfung; alte Verify-Antworten ohne tatsächliche Modusbeobachtung werden abgelehnt.
- `trading_engine.ts`: aktueller Readback im Preflight, erneuter Readback unter dem Coordinator unmittelbar vor Dispatch, synchroner letzter Guard nach dem Dispatch-Journal-Await. Bestehende TTL-, Startup-, Accounting- und Autorisierungsfences bleiben erhalten.
- `tests/test_trading_execution_constraints.js`, `tests/test_trading_execution_mode_fence.js`, `tests/test_ccxt_exchange.js`, `exchange_executor/tests/test_execution_constraints.py`; enge Registry-Ergänzungen in `tests/run_all.js`. Bestehende Python-Fakes enthalten jetzt explizite Modusantworten; die Rotation-after-leverage-Fixture beginnt mit abweichendem Hebel, damit tatsächlich der Setter und der Rotationspunkt durchlaufen werden.
- `sonar-project.properties`: alle vorhandenen Python-Produktionsmodule einschließlich `accounting_evidence.py` und `execution_constraints.py`; keine Tests in Produktionssources.

### Keine pauschale Entryfreigabe durch Verify

`verified=true` belegt die vorhandene allgemeine Konto-/Modusbeobachtung, **nicht** die Eignung jedes Symbols und nicht den Abschluss aller Risiko-/Provider-Gates. Verify liefert immer `entryAllowed=false`, `requiresSymbolRead=true`, Scope `account_observation`. Fehlender, ungültiger oder veralteter Modusreadback ergibt `verified=false` mit kontrolliertem Grund. Insbesondere ist ein beobachtbarer symbolabhängiger Modus nicht als pauschal falsch zu behandeln: sonst würde bereits bestehender Schutz unnötig mit einer nicht abgefragten Entryfähigkeit vermischt.

Der symbolbezogene Vertrag enthält Version, Exchange, kanonisches/providerseitiges Symbol, Accountfingerprint, Credentialgeneration, CCXT-/Profil-/API-Version, Profilhash, Herkunft, Zeitfenster, Modus, Leveragesemantik und Quellen. `entryAllowed=true` bedeutet ausschließlich: dieser Modus-Teilnachweis erlaubt den vorgesehenen Entry. Die sonstigen Risiko-, Kapazitäts-, Preis-, Eigentums- und Release-Gates bleiben unabhängig.

Alle Readbacks gelten weniger als 10.000 ms ab **Beginn** der Erfassung. Ein langer Lesevorgang verlängert das Fenster nicht. Profilhash entspricht SHA-256 über die kanonische deklarative Profilstruktur, nicht einem Beweis des gesamten Quellcodes. Die unabhängigen 008-Artefakte binden zusätzlich Quell-SHA/Profil-Dateihash; deren reale Belege existieren weiterhin nicht. Allgemeine Implementierungsprofil-Version 1/Allowlist wurden nicht als vermeintliche neue Providerzertifizierung umgeschrieben, damit Exitfähigkeit nicht durch den neuen Entry-Teilvertrag quarantänisiert wird. Ein geänderter Ausführungsprofilhash verlangt neue Kontoverifikation vor Entries.

## Offizielle Quellen und CCXT 4.5.75

Öffentliche offizielle Dokumentation wurde erneut gelesen; kein Providerkonto und keine Broker-API angesprochen. Installierte `ccxt==4.5.75`-Quellen unter dem lokalen gepinnten Python-Runtime-Verzeichnis wurden unabhängig abgeglichen. Neue Tests instanziieren außerdem echte SDK-Klassen mit vollständig ersetztem `request` und gesperrtem `fetch`; sie belegen SDK-Routing, **keine** reale Authentifizierung oder Providerantwort.

### Bybit V5

[Account Info](https://bybit-exchange.github.io/docs/v5/account/account-info) dokumentiert authentifiziertes `GET /v5/account/info`, `unifiedMarginStatus` und `marginMode`. Unterstützt werden UTA-Status 3–6; Entry verlangt `REGULAR_MARGIN`. `ISOLATED_MARGIN`, `PORTFOLIO_MARGIN` und fehlende Felder erlauben keinen Entry.

[Position Info](https://bybit-exchange.github.io/docs/v5/position) liefert bei explizitem `symbol` auch ohne Exposure den betreffenden Datensatz. Deshalb wird nicht aus einer leeren settleCoin-Abfrage One-way abgeleitet. `positionIdx=0`, exaktes Symbol, Kategorie `linear`, eine eindeutige Zeile, terminaler Cursor und positiver ganzzahliger Leverage-Readback sind erforderlich. Hedge-Indizes 1/2 blockieren. Das für UTA veraltete `tradeMode=0` ist kein Cross-Nachweis.

CCXT `async_support/bybit.py`: `fetch_margin_mode` Zeilen 9332–9345 ruft denselben privaten Account-Endpunkt; Positionsparser um 6567 verarbeitet `positionIdx`; `set_leverage` ab 6772 verändert den Hebel. Entries setzen zusätzlich `positionIdx=0`; tatsächlicher gewünschter Hebel wird nach einem erforderlichen Setter erneut gelesen. Ein bloß bestätigter, aber nicht wirksamer Setter lässt keinen Entry durch.

### Hyperliquid, erster Perp-Dex

[Perpetual Info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals) beschreibt `activeAssetData(user, coin)` mit zurückgeliefertem Nutzer, Coin und Leverage-Typ/-Wert sowie `clearinghouseState`. [Offizieller AssetPosition-Vertrag](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions) beschreibt die inhärente `oneWay`-Position. Dies wird nicht aus `fetchPositionMode`-Flags erfunden.

Der Readback verwendet ausschließlich die bereits gebundene `walletAddress`; SDK-Wallet, bestehende Kontoidentität, Antwort-User und Coin müssen exakt passen. Beobachtung ist **`public_bound_account`**, nicht `authenticated`. Die vorhandene Wallet-/Credentialgeneration-Bindung wird beibehalten; kein Vergleich Agent-Private-Key-Adresse == Masterwallet, keine neue Identitätsmigration und keine erfundene Agentberechtigungsprüfung. `clearinghouseState` muss die One-way-Struktur bestätigen; vorhandene Zielposition und `activeAssetData` dürfen hinsichtlich Margin-/Leverage-Werten nicht widersprechen. HIP-3/andere Perp-Dex-Namen werden in diesem Modusprofil nicht freigegeben.

Die [offizielle allgemeine Info-Dokumentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) beschreibt außerdem `userAbstraction`. Dieser zusätzliche gebundene Read ist erforderlich: nur explizit `disabled` ist für den konventionellen Modus freigegeben. `portfolioMargin`, `unifiedAccount`, `dexAbstraction` und mangels aufgelöster Semantik auch `default` blockieren neue Entries. Fehlende/unbekannte Antwort ebenfalls. Node und Executor prüfen die Abstraktion im finalen Fence. Generisches Verify kann einen bekannten anderen Zustand korrekt beobachten, bleibt aber ausdrücklich ohne Entry-Erlaubnis.

Dokumentationsstand: am 2026-09-02 aus dem offiziellen Suchindexinhalt erneut gelesen (Index meldete circa sechs Monate Crawlalter; direktes Öffnen lieferte zeitweise einen Abruffehler). Eine eigene API-Versionsnummer oder belastbare Auflösung von `default` zu `disabled` ist dort nicht ausgewiesen. Die dokumentierten Werte sind getrennte Enumwerte, kein Beleg ihrer Gleichheit. Deshalb konservative symbolbezogene Entry-Sperre bei `default`, **keine globale Kontoverifikationssperre**. Eine spätere belegte Auflösung verlangt aktualisierten Profilhash, Tests und Providerabnahme; nicht stillschweigend freigeben.

CCXT `async_support/hyperliquid.py`: `fetch_positions` ab 3471 nutzt öffentlichen Clearinghouse-Read; `set_leverage` ab 3678 bildet `marginMode` in `isCross` ab. Auch der [offizielle Update-Leverage-Vertrag](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint) enthält dieses Feld. Daher kein Setter vor aktuellem Cross-Nachweis, kein automatisches Korrigieren eines beobachteten Isolated-Modus; bei erforderlichem Hebelwechsel explizite Cross-Parameter und anschließender erneuter Readback. Ein gleichzeitig extern wechselnder Kontozustand kann wegen fehlender atomarer Provider-CAS weiterhin nicht ausgeschlossen werden.

### Kraken Futures, PF_-Multi-Collateral-Swaps

[GET Leverage Settings](https://docs.kraken.com/api-reference/multi-collateral/get-leverage-settings) gibt die konfigurierte Präferenzliste authentifiziert zurück. Der [offizielle Interface-Guide](https://support.kraken.com/hc/zh-cn/articles/360022627732-Trading-interface-guide) dokumentiert Cross als Standard pro Vertrag. Daraus folgt im begrenzten PF_-Scope: eindeutige vollständige Präferenzliste ohne Eintrag für das Zielsymbol und widerspruchsfreie vollständige Positionen belegen den Cross-Default. Fehlende Listen/Antworten sind **keine** leeren vollständigen Listen. Ein positiver `maxLeverage`-Eintrag oder `maxFixedLeverage` einer Zielposition blockiert Cross; malformed/duplizierte Angaben blockieren ebenfalls.

[Trading Multi-Collateral Derivatives](https://support.kraken.com/au/articles/4844429542676-trading-multi-collateral-derivatives) beschreibt Netto-Positionen und effektiven Cross-Hebel. Das Profil verwendet daher `leverageSemantics=effective_collateral_ratio`, `leverage=null`; kein erfundener einstellbarer Cross-Hebel.

Entscheidend: [PUT Leverage Settings](https://docs.kraken.com/api-reference/multi-collateral/set-leverage-settings) setzt bei vorhandenem `maxLeverage` **Isolated**, ohne dieses Feld Cross. CCXT `async_support/krakenfutures.py` `set_leverage` Zeilen 3161–3186 setzt immer `maxLeverage` und ruft `privatePutLeveragepreferences`. Deshalb wird **kein Kraken-Setter im Cross-Entry-Pfad aufgerufen**. `fetch_leverages`/`fetch_leverage` ab 3188/3216 lesen dieselbe private Liste; ihr normalisiertes `marginMode=None` genügt allein nicht. `fetch_positions` ab 2830 und Parser um 2899 erklären `maxFixedLeverage`.

Der korrekte Modusreadback erledigt nicht die separat noch fehlende Kraken-Reporting-/Funding-/Preisdeckel-/Tier-Abnahme. Solche unabhängigen Gates bleiben fail-closed.

## Tests und Integrationsstand

Nachtrag aus Schritt 2: Die damaligen Readonly-Mode-Fixtures allein erfassten noch nicht automatische Setup-Writes im vollständigen Hyperliquid-SDK-Bootstrap. Dieser unabhängig entdeckte Befund ist inzwischen durch eine REST-/Pro-Subclass vor Marktladen behoben und mit tatsächlichem `load_markets`/`create_orders` gegen gesperrten Transport geprüft. Details, roter Ausgangsbeleg und Grenzen stehen im [Preis-/SDK-Nachweis](004-PRICE-IMPLEMENTATION-NOTES.md). Die früheren `builderFee=false`-Flags waren allein keine hinreichende Readonly-Zusicherung. Keine reale Provideraktion wurde während der Reparatur ausgeführt.

- Neue Tests zuerst rot: fehlendes Modul; zusätzlicher Hyperliquid-Widerspruch, ungültiger Provider-Symboltyp, fehlende präzise Fehlerübertragung und zu langsame Accountbeobachtung jeweils als Regression gezeigt, dann grün.
- 18 fokussierte Python-Modusfälle grün; Gesamtsuite am Abschluss dieses lokalen Teils **161 Tests grün** mit Python 3.12 / CCXT 4.5.75. Enthält richtige Modi, Hedge/Isolated/Portfolio, fehlende Daten, exakte Symbol-/Walletbindung, Kontoabstraktion, Widersprüche, Profil-/Credentialdrift, Secret-redigierte Fehler, unwirksamen Setter, Moduswechsel vor Batch, unveränderte Reduce-only-Fähigkeit und Kraken ohne Setter.
- Node HTTP- und reine Validator-Fixtures grün. Vier zusätzliche echte Engine-Fixtures ausschließlich mit lokaler Paper-Transportemulation: sicherer Modus sendet, Preflight-Hedge sendet nichts, Moduswechsel beim finalen Read sendet nichts, Nachweisablauf nach dem letzten Journal-Await sendet nichts und lässt die Operation `abandoned`.
- Node Mode/Fence/TTL/Engine-Dateien grün. Gesamter Ruff grün; eigener fokussierter ESLint ohne Warnungen. Architektur zuletzt 105 Module / 389 interne Imports / keine Zyklen.
- Finaler fokussierter Lauf: sieben Node-Dateien (Mode-Validator, Engine-Mode-Fence, Entry-TTL, Engine, CCXT-HTTP, Sonar-Export, Sonar-Evidenz) grün. Gesamt-Typecheck nach Fertigstellung des parallelen Backup-Typvertrags ebenfalls erneut grün; `git diff --check` für den betroffenen Scope grün.
- Noch laufende Integrationshunks anderer Pakete verhinderten einen sauberen gemeinsamen Gesamtabschluss: Migration36-Allowlist war vorübergehend unvollständig und wurde durch den Besitzer korrigiert; anschließend DailyRisk-Fixture mit `ACCOUNTING_INCOMPLETE` statt altem `MAX_DAILY_RISK`, Money-Ledger-Komplexität 22 und BackupRestoreOptions/allowCurrentProcessLock im Typecheck an die jeweiligen Besitzer gemeldet. Diese Befunde wurden weder verdeckt noch durch Budget-/Fixtureabschwächung umgangen. Gemeinsame Abschlussgates nach Stabilisierung erneut ausführen.

Keine Migration durch diesen Modusteil. Keine tatsächlichen Konto-/Modusänderungen, kein Serverstart, kein Deployment, keine Commits, kein Push, keine GitHub-Mutation. Keine echte Providerabnahme/Releaseprüfung und kein unabhängiger menschlicher Reviewbeleg behauptet.
