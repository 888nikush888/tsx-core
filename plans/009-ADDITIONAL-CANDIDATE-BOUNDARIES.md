# 009 – ApeX, regionale Klassen, Extended, WEEX, Deepcoin und GRVT

Stand: 2026-09-03. Ausschließlich lokale CCXT-4.5.75-Quellprüfung, offizielle Dokumentation und isolierte SDK-Tests. Keine Kontozugriffe, Provider-Orders, Profilfreigaben oder Änderungen am SDK. Diese Notiz unterscheidet echte Scopegrenzen von noch fehlenden Nachweisen; sie ist keine vollständige Profilattestation.

## Entscheidungen

| Identifier | Entscheidung | Entscheidender Befund |
|---|---|---|
| apex | not_easy | Die tatsächlich installierte Order-Signatur verlangt ein zusätzliches Apex/zkLink-SDK; nach 009 kein zulässiger kleiner Parameteradapter. |
| bybiteu | not_easy | Regionaler Produktvertrag erklärt Swap/Future für nicht unterstützt; aktuelle regionale API beschreibt Spot/Spot-Margin. Ein geerbter globaler Marktloader hebt diesen Vertrag nicht auf. |
| gateeu | not_easy | Regionaler Produktvertrag und Marktloader sind Spot-only; Derivatehosts der globalen Mutterklasse sind keine regionale Freigabe. |
| grvt | not_easy | Native OTO-Schutzkinder werden laut Bulkvertrag erst nach vollständigem Parentfill aktiv. Die benötigte Partial-IOC-Schutzsemantik ist damit nicht gegeben. |
| deepcoin | pending | Normaler Batch und separate Triggerroute sind unterschiedlich. Ein belegter gemischter Schutzbatch oder vollständiger Attached-Child-Lifecycle fehlt bislang. |
| extended | pending | Native Signierung ist im CCXT-Paket vorhanden; kein pauschaler SDK-Ausschluss. Preisgebundene Stops und Attached-Child-Identität müssen im gemeinsamen Lebenszyklus belegbar sein. |
| weex | pending | V3-Normalbatch und Algo-Stoproute sind verschieden. Attached-SL existiert, aber dessen tatsächliche Child-/Partial-/Zero-fill-Belege fehlen. |

Für `bybiteu` und `gateeu` steht `option=null` im SDK, nicht ausdrücklich false. Deshalb kein erfundenes `not_derivative` nach dem strengeren Inventurschema. Der konkrete Futures-/Perp-Ausschluss hat eigene Produktbelege. Keine Aussage, dass andere Gesellschaften derselben Marke keine Derivate anbieten.

## ApeX: notwendige zusätzliche Signaturinfrastruktur

Installierter `async_support/apex.py:create_order:1287` benötigt eigene Seeds und ruft `get_zk_contract_signature_obj` auf. Die eigentliche Funktion in `base/exchange.py:2160` importiert **apexpro.zklink_sdk**, erstellt ContractBuilder/Contract und signiert über ZkLinkSigner. Fehlt das Paket, fordert die Funktion ein plattformspezifisches ApexOmni-Paket. Das ist kein fehlendes CCXT-Flag und keine kleine Serializerkorrektur. Weder ein solches SDK noch eine eigene Ersatzsignatur wurde installiert.

Die [offizielle Omni-Referenz](https://api-docs.omni.apex.exchange/) beschreibt zusätzlich zur API-Authentifizierung die zkLink-bezogene Orderauthentifizierung. Persönliche Seeds/API-Zugänge wurden nicht gelesen. Der permanente Test ruft genau die installierte Signaturfunktion auf, sperrt den externen Import gezielt und bestätigt den Abbruch vor einem Providertransport.

## Regionale Klassen: kein stiller Wechsel auf den globalen Anbieter

Die [regionale Bybit-API-Mitteilung vom 2. September 2026](https://announcements.bybit.eu/en-EU/article/api-trading-power-your-tools-and-ai-with-deep-liquidity-and-low-latency--art639fafc104c9/) nennt Spot und Spot-Margin. `bybiteu.py` setzt `hostname=bybit.eu`, `mica=true`, `swap=false`, `future=false`. Der geerbte `bybit.fetch_markets:1868` plant dennoch Spot, zwei Derivatekategorien und sechs Optionwährungen. Der permanente Test bestätigt diese **Inkonsistenz**, nicht funktionierende EU-Derivate. Globale Flags, Credentials oder Endpoint-Erreichbarkeit dürfen nicht zum Umgehen regionaler Produktgrenzen verwendet werden.

Die [regionale Gate-API](https://www.gate.com/en-eu/docs/developers/apiv4/) bezeichnet den Vertrag unter `api.gateeu.com` als Spot-API. `gateeu.py` setzt Futures/Swaps false und `fetchMarkets.types=['spot']`. Der permanente Test bestätigt genau einen Spot-Loader und null Derivatelader. Deep-merge-geerbte globale Derivatehosts sind keine verifizierten regionalen Angebote. Es wurde kein Regional-/Host-/Kontowechsel durchgeführt.

## GRVT: Partial-Fill-Schutz ist ein echter Vertragsunterschied

Die [aktuelle Trading-API, Bulk Orders](https://api-docs.grvt.io/trading_api/#bulk-orders) beschreibt normalen Bulk, einzelne TP/SL, OCO, OTO und OTOCO. Ein gemischter Parent plus Stop ist eine OTO-Gruppe, deren Trigger erst beim **vollständigen** Parentfill aktiv werden. Ein Cancel eines Gruppenmitglieds betrifft die Gruppe. Ein bloßer zwei-elementiger Bulk ist daher kein unabhängig aktiver Schutz für einen teilweise ausgeführten IOC-Parent.

TSX muss auch Teilfüllungen mit derselben ursprünglichen begrenzten Order behandeln. IOC heimlich durch FOK zu ersetzen würde die Handelssemantik ändern. Ein separater nachträglicher Stop nach ungeschütztem Entry oder eine behauptete sofortige OTO-Aktivierung sind ebenfalls keine erlaubten Abbildungen. Genau dieser Unterschied begründet `not_easy`; nicht das allein fehlende SDK-`create_orders`.

Gelesener SDK-Pfad `grvt.create_order:1885`: Subaccount, eigene Client-ID, IOC → IMMEDIATE_OR_CANCEL, getrennte Trigger-Metadaten und eigene Signatur. Authentifizierung ab 489 und Builder-Fee-Optionen wären bei einer späteren Erweiterung zusätzlich zu prüfen; sie wurden nicht ausgeführt. Bestehende Credentials wurden weder erzeugt noch verändert.

## Extended: offene eng begrenzte Fragen statt unzutreffendem SDK-Ausschluss

Die [offizielle API](https://api.docs.extended.exchange/#order-management) verlangt auch bei Market-/TPSL-Ausführung einen vorab festgelegten Preis; ein Marketauftrag arbeitet als begrenzter IOC. Der Preis wird beim Trigger nicht nachträglich vom Server bestimmt. Attached-SL und der Parent besitzen mehrere Signaturen. Die REST-Antwort bestätigt Annahme, nicht endgültige Matching-Engine-Ausführung. Ersetzen kann bei späterer Ablehnung beide Orders stornieren.

Installierter Code: `create_extended_order_request:2475`, `create_order:2649`; `base/exchange.py:1636` nutzt **mit CCXT gebündelte** Starknet-Abhängigkeiten. Der Nachweis ist somit ausdrücklich anders als ApeX. Die zwei permanenten Tests bestätigen: fehlender Stop-Ausführungspreis wird vor Send abgewiesen; Attached-SL trägt Preis/Trigger/Settlement-Signatur, aber im Request keine eigene Child-ID. Signaturberechnung wurde in diesem zweiten Formattest gezielt durch einen lokalen Stub ersetzt; damit ist keine echte Signatur verifiziert.

Noch nötig: native Parent-/Child-Korrelation, Beleg für Partial-/Zero-fill und tatsächliche Cancellation; zulässige Schutzpreisgrenze ohne Änderung des Nutzer-SL; vollständige REST-Order-/Funding-/Geldquellen. `fetch_open_orders:2943`, Fills 944, Funding 1008, Balance 1405, Ledger 1541 und Positionen 2167 sind Einstiegspunkte, keine bereits abgenommenen Providerreader. Alle Währungen und Subaccounts bleiben originalgebunden.

## WEEX: aktuelle V3, nicht mit altem V2 verwechseln

[Changelog](https://www.weex.com/api-doc/contract/changelog), [normaler Batch](https://www.weex.com/api-doc/contract/Transaction_API/PlaceOrdersBatch), [Orderparameter](https://www.weex.com/api-doc/contract/Transaction_API/PlaceOrder): V3 bietet einen Batch normaler Limit-/Marketorders; die Einträge können Attached-SL-Parameter tragen. Per-Leg-IDs in einem Normalbatch belegen nicht die Annahme eines separaten Algo-Stops.

Der Pin ist bereits V3. `create_contract_order:2152` leitet Stoporders nach `/capi/v3/algoOrder`; `create_contract_order_request:2203` lehnt separate SL/TP beim Aufrufer `createOrders` ausdrücklich ab. Der permanente Test prüft die echte Routenwahl, eigene `clientAlgoId`, STOP_MARKET/Trigger und die Batchablehnung. Die Sandboxverzweigung verweigert separate SL/TP zusätzlich; daraus folgt kein pauschales Urteil über alle Live-Produkte.

Kleine zukünftige Hooks: eigenständiger Algo-Current-State/Historyreader, originale IDs und Fees, gelesener Modus, Callback-freie Deadline/Noncebindung. Zuvor ist eine konkrete gemeinsame Schutzannahme einschließlich Teil-/Nullfüllung erforderlich. Bis dahin `pending`, kein künstliches Child-ACK.

## Deepcoin: Trigger nicht durch Normalbatch umbenennen

Die [offizielle Batchreferenz](https://www.deepcoin.com/docs/DeepCoinTrade/batchOrders) beschreibt bis fünf normal parametrierte Orders und Attached-Triggerpreise. Die direkt geladene Seite antwortete im Nachlauf mit 403; die verfügbare primäre Suchindexfassung ist deshalb **kein vollständiger Live-API-/Semantiknachweis**.

SDK `create_order:1393` trennt die normale Order von `triggerPrice` → `/deepcoin/trade/trigger-order`; Requesthelper ab 1569. Der permanente Test bestätigt die tatsächliche separate Route und unveränderten Trigger. `stopLossPrice` ist nicht gleichbedeutend mit diesem Triggerzweig; ein reines Umbenennen im normalen Batch wäre unbelegt.

Vor einem Profil fehlen insbesondere belegte gemeinsame Entry-/Schutzannahme und eigene Kindidentität, vollständige aktuelle Triggerliste, historische Originalfills/Funding und tatsächlicher Margin-/Positionsmodus. Bestehende SDK-Methoden Balance 898, Ledger 1202, offene Orders 1946, Positionen 2376 und Fills 2723 ersetzen diese Originalnachweise nicht. Dokumentationsausfall ist kein technischer Ausschluss.

## Tatsächlich ausgeführte permanente Proben

Neue Datei: `exchange_executor/tests/test_additional_candidate_boundaries.py`.

- Erster Lauf: 8 Tests, eine falsche Testannahme zu Bybit-EU-Optionswährungen und ein vorgezogener Credentialfehler im Extended-Test. Kein Produktionscode geändert.
- Gegenprüfung des Pins: sechs konfigurierte Optionswährungen, nicht nur drei Fallbackwerte; preisbezogener Extended-Test ruft den tatsächlichen Requestbuilder ohne Credentials auf.
- Korrigierter Lauf: **8/8 Tests, 1,959 s, Exit 0**. Ruff Exit 0.
- Enthalten: Pin, Apex-Importgrenze, beide Regionalklassen, zwei Extended-Grenzen, WEEX-Algoroute/Batchablehnung, Deepcoin-Triggerroute.
- `fetch` und unerwartetes `request` sind fail-closed Mocks. Null Providerzugriff. Ergebnisse sind SDK-Charakterisierung, keine echten Kontofähigkeiten oder abgeschlossene Paritätsmatrix.

## Konkrete Versionsbindung

Dateien relativ zu `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/`:

| Datei | SHA-256 |
|---|---|
| `async_support/apex.py` | `d6c11a11154415efbfcb8c222dd229ef86ee8322e506f673a284910272744ba5` |
| `base/exchange.py` | `e37cf08f743bc41d0571c77e38857266189fddcf5d74970c45086f35b272d915` |
| `async_support/bybiteu.py` | `fab44594a160e9b3dc43b43d20b89de0498e39bf2ea0e2f7f0c4157a6d22a6e1` |
| `async_support/gateeu.py` | `7c184910585c956e2b12728e16a9c626e6174ec2e727e9d69e9f3c6324b532cd` |
| `async_support/bybit.py` | `31560dfed28c743bc3a83445d5f2957a04e0b18e0b17c5f18665f10ebad32c47` |
| `async_support/gate.py` | `3e6bd51b06345c6a592a6c031c601c77952f0ae0c0fde628e449f886bde9a2ac` |
| `async_support/extended.py` | `44b79c4457110ddccb0a4092a11e17b8a47ccc42eea5f6dcf0a066a2c7320ad7` |
| `async_support/weex.py` | `beb23d3eeead7b11d965ef9b017caa7a851e9f13f834a6edc79b6c93e9907bf8` |
| `async_support/deepcoin.py` | `deb20b89a932ae432c7b1a10406f2881f6b5fe37f5080d19520195ca32e14aa7` |
| `async_support/grvt.py` | `cb3cd04ca218b2d6a0ae368d661141ac5d2e8183dd34890d58d34c41b2478e06` |
