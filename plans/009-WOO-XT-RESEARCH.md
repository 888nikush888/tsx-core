# 009: WOO X, WOOFi Pro, Mode Trade und XT — begrenzte Anbieterprüfung

Stand: 2026-09-03; lokale Basis `f8089277d0667dd45bcf070037800d423fd89254` plus uncommittierte Reparaturen. Plan 009 vollständig gelesen. Diese Notiz ist eine unabhängige Quellen-/SDK-Prüfung, **keine Implementierungsattestation, keine reale Providerabnahme und kein grünes Gesamtgate**. `implementationVerified=false`, `providerAcceptanceVerified=false` für sämtliche hier untersuchten zusätzlichen Profile.

## Ergebnis und Produktgrenzen

Keiner der vier Identifier ist durch diese Prüfung freigabefähig. Die gewünschten Kombinationen bleiben `pending`: Es gibt konkrete API-Ansätze und kleine reparierbare SDK-Abweichungen, aber noch keinen vollständigen Schutz-/Identitäts-/Modus-/History-Beweis. Fehlende Nachweise werden nicht als `not_easy` umetikettiert. Eine Entscheidung über den tatsächlichen Implementierungsumfang bleibt bei der koordinierten 009-Inventur.

| Identifier / Produkt | Belegter Ansatz | Einstufung und noch entscheidende Grenze |
|---|---|---|
| `woo`: lineare USDT-Perps, Cross, One-way | Offizielle Instrumente; signierter Konto-/Symbol-Readback; native Bracket-API mit tatsächlichen Algo-Kind-IDs in Beispielen | `pending`: Bracket dokumentiert LIMIT/MARKET, nicht den benötigten begrenzten IOC-Pfad; Kind-Lifecycle und vollständige Tier-/Geldnormalisierung fehlen |
| `woofipro`: lineare USDC-Perps, Cross, gewünschter One-way-Scope | Orderly-API, vorhandene Ed25519-Signatur, private Margin-/Account-Reads, native Bracket-Alternative | `pending`: SDK-Stopbatch verboten, Attached-Builder weicht vom Original ab; ursprüngliche Child-IDs/Zero-fill, One-way-Beleg, IMR-Kurve und Ledger-Coverage offen |
| `modetrade`: lineare USDC-Perps, Cross, gewünschter One-way-Scope | Eigenständige CCXT-Klasse mit demselben Orderly-Backend und anderer Brokerbindung | `pending`: wie Orderly oben, zusätzlich fehlender Margin-Read im gepinnten Wrapper und separat zu belegende Broker-/Kontobindung |
| `xt`: lineare USDT-Perps, Cross, gewünschter One-way-Scope | Native Order-/Entrust-/Account-APIs, private Leverage-/Cross-Daten, öffentliche Notional-Brackets | `pending`: kein belegter One-way-Read, kein vollständiger begrenzter Entry+Stop-ID-Vertrag; Raw-Normalisierungen und gesamte History nötig |
| `woo`: USD-/USDC-settled lineare Perps | Instrumentdokumentation bezeichnet Spot und USDT-Perps | `pending` hinsichtlich angebotener Kombination; keine Live-Instrumentinventur, keine Unterstützung aus SDK-Symbolsyntax ableiten |
| `woofipro` / `modetrade`: USD-/USDT-settled lineare Perps | Gelesene Orderly-Produkt-/Geldquellen belegen USDC; kein entsprechender Originalmarkt nachgewiesen | `pending` hinsichtlich angebotener Kombination; USD, USDT und USDC niemals synonym behandeln |
| `xt`: USD-/USDC-settled lineare Perps | Parser kann quotebasierte lineare Kontrakte darstellen; konkrete Anbieterbelege hier nur USDT | `pending` hinsichtlich angebotener Kombination; keine erfundenen Marktlisten |

Spot ist außerhalb des Derivateauftrags. XT unterscheidet im Original `U_BASED` und `COIN_BASED` sowie `productType`; inverse Kontrakte und Laufzeit-Futures sind **nicht** durch den linearen Perp-Scope abgedeckt. Ebenso keine automatische Freigabe für Hedge, Isolated, Vorablisting, Prediction oder andere Lifecycle-Produkte. Eine vorhandene Two-way-/Hedge-API ist kein One-way-Nachweis und rechtfertigt keinen automatischen Moduswechsel.

Die Produktbelege stammen aus [WOO-Instrumentdokumentation](https://developer.woox.io/api-reference/endpoint/public_data/instruments), [Orderly-Margin-/PnL-Vertrag](https://orderly.network/docs/introduction/trade-on-orderly/perpetual-futures/margin-leverage-and-pnl) und [XT-Ordervertrag](https://doc.xt.com/docs/futures/Order/Create%20Orders), ergänzt durch die unten gebundenen installierten Marktparser. Es wurden keine Markt-APIs aufgerufen.

## Reproduzierbare Quellenbindung

Tatsächlich importiert: Python 3.12 aus `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe`, CCXT **4.5.75**. SHA-256 jeweils über die gesamten installierten Datei-Bytes. Website-Dokumentation wurde am obigen Datum gelesen; sie ersetzt nicht die gepinnte SDK-Version. Keine Dependencies verändert.

| REST-Original | SHA-256 |
|---|---|
| [async_support/woo.py](C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/async_support/woo.py) | `123e1b2cb81b61d02d037501710015704bb9ded3e5f1e752db89849839200898` |
| [async_support/woofipro.py](C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/async_support/woofipro.py) | `e81dcdf6d7cb51aaba7f31b37e76ba49779df38684a57a86bd90a4b3215345d8` |
| [async_support/modetrade.py](C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/async_support/modetrade.py) | `e9289db2b53686ba54687ec7e7ca3747f2bf2de9814ba7191c53af94fe166ce5` |
| [async_support/xt.py](C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/async_support/xt.py) | `fc1cee6f675a43faebeef2ea7a35760830360a3b187f3d00ca087ee4e3f119a4` |

Zusätzlich gelesene Pro-Methoden und ganze Datei-Hashes:

- `pro/woo.py`: `watch_orders:881`, `watch_my_trades:915`, `watch_positions:1181`; `39bb1f6baf5f2429009e74561c5aa64259eda7dd70b42fe8da527dcad8464baa`.
- `pro/woofipro.py`: `watch_orders:635`, `watch_my_trades:669`, `watch_positions:937`; `8289f5b43922604a5d60e32abee8b66ea27b0673be7f359924ae48eb396cdd3d`.
- `pro/modetrade.py`: `watch_orders:637`, `watch_my_trades:671`, `watch_positions:941`; `f7aea910eb96ef7a25d6ca869d9839eae0ad9b56d0f38768cf215aff46a2f5a5`.
- `pro/xt.py`: `watch_orders:483`, `watch_my_trades:507`, `watch_positions:546`; `dbe54604c83c37741165acbdebb40734bf9333f2f74fff738a7bc5d845dbeadc`.

Alle vier besitzen konkrete Pro-Methoden für Orders, eigene Trades und Positionen. WOO benutzt getrennte normale/Algo-Execution-Topics; WOOFi/Mode Trade ebenfalls. XT abonniert Order/Trade/Position separat. Das ist ein Implementierungsansatz, **kein** Reconnect-/Duplikat-/Vollständigkeitsnachweis. Kein Stream wurde geöffnet; REST bleibt Autorität.

## 1. WOO X (`woo`)

### Identität und Produkt

`woo.py:716/764` liest Instruments und verarbeitet `PERP_BASE_QUOTE` als linearen Swap mit `contractSize=1`; native Präzision und Mindestwerte müssen dennoch exakt ausgewertet werden. `sign:3152` verwendet den vorhandenen API-Key-/Secret-Pfad. SDK-Live-Hosts sind `api.woox.io` / `api-pub.woox.io`, Staging ist separat konfiguriert. Keine Aussage über reale Staging-Parität oder Kontozugang.

Der signierte [Account-Read](https://developer.woox.io/api-reference/endpoint/account/get_account_info) enthält Kontoidentität, `accountMode` und tatsächliches `positionMode`. Das ist der Ansatz für One-way, nicht ein gesetztes Requestflag. [Symbolkonfiguration](https://developer.woox.io/api-reference/endpoint/account/get_symbol_config) liefert `marginFactor`, `maxLeverage`, `maxPosition`. [Futures-Leverage](https://developer.woox.io/api-reference/endpoint/futures/get_leverage) liefert symbolbezogene Margin-/Position-Modi und Seitenhebel; die Dokumentation verlangt Modi auch als Queryparameter. Daher diese Antwort nicht isoliert als unbeeinflussten Modusbeweis behandeln: ursprünglichen Account-/Default-Margin-Read, exakten Symbolscope und aktuelle Positionen konsistent binden. `fetch_leverage:3566` setzt Cross als Requestdefault; kein Beweis über ein tatsächliches Konto. Die vollständige größenabhängige Marginformel/Einheit ist durch die bloße Max-Leverage-Zahl noch nicht abgedeckt.

### Entry, Schutz und Identität

Die [Algo-API](https://developer.woox.io/api-reference/endpoint/trading/post_algo_order) unterscheidet Bracket, TP_SL und positionweiten TP/SL. Bracket-Entry ist dort LIMIT/MARKET; die Beispielantwort enthält mehrere tatsächliche Algo-IDs. Gewählte Client-ID muss unter offenen Algo-Orders eindeutig sein; normale Client-IDs liegen in einem getrennten Namespace. Positionweiter TP/SL kann vorherigen positionweiten Schutz ersetzen. Ein eigener Entry darf dadurch keinen fremden Stop überschreiben. Die Antwortreihenfolge identifiziert keine Rolle.

`create_order:1328` erzeugt bei `stopLoss` einen Bracket mit positionweitem Child, übersetzt aber `timeInForce=IOC` nur im nichtkonditionalen Zweig. Danach entfernt es `timeInForce`. Außerdem normalisiert es ausschließlich `data.rows[0]`. Die unten ausgeführte Probe belegt deshalb sowohl ein LIMIT statt IOC als auch eine Child-ID als scheinbare Entry-ID. `create_orders` ist nur die nicht implementierte Basismethode, kein nativer geschützter Batch.

Ein kleiner Raw-Bracket-Adapter ist ein Ansatz, kein fertiger Vertrag. Vorher fehlen der zulässige begrenzte IOC-Pfad, die sichere Rollenbindung jedes Original-Childs, eigene mengenbezogene Schutzsemantik sowie Cancel-/Partial-/Late-/Zero-fill-Beweise. Vorab zugewiesene Child-IDs sind denkbar und dokumentarisch beispielhaft vorhanden; **nicht** behaupten, WOO erzeuge alle Children erst nach Fill. Ob ein konkreter ungefüllter Entry überhaupt einen Child erzeugt und wie dessen terminaler Ausgang bewiesen wird, bleibt offen.

Ein LIMIT-Bracket plus anschließender Cancel wird hier ausdrücklich **nicht** als IOC-Ersatz freigegeben. Die gelesene [Cancel-Algo-Quelle](https://developer.woox.io/api-reference/endpoint/trading/cancel_algo_order) zeigt einen Cancel nach Algo-/Client-Algo-ID und `CANCELLED`, aber keine vollständige Garantie über gleichzeitig eintreffende Partial-Fills und den Erhalt genau des zugehörigen Restschutzes. Ohne diesen Originalvertrag würde der Workaround die bestehende Ausführungssemantik ändern. Der dokumentierte LIMIT/MARKET-Bracket-Pfad ist daher aktuell ein konkreter Konflikt, nicht nur ein fehlendes Capabilityflag.

### Current, Historie und Geld

`fetch_positions:3822` liest Futures-Positionen, `fetch_balance:2507` Asset-Balances. Normale und Algo-Orders müssen getrennt vollständig gelesen werden (`fetch_orders:1831`, `fetch_open_orders:1963`, `fetch_order:1726`). [Algo-Listen](https://developer.woox.io/api-reference/endpoint/trading/get_algo_orders) enthalten verschachtelte Parent-/Root-/Child-IDs, Aktivierung, Status und Pagination; eine flache normale Open-Order-Liste genügt nicht.

[Transaktionshistorie](https://developer.woox.io/api-reference/endpoint/trading/get_transactions) beschreibt zwei Jahre, Start-/Endzeit, `fromId` und Limit sowie eigene Fill-ID, Order-ID, Fee-Asset und nullable realisierte PnL. `fetch_my_trades:2337` verwendet dagegen bei automatischer Pagination den generischen `page`-Mechanismus. Originalcursor, Grenzinklusion, gleiche Zeitstempel und früherer Retention-Rand müssen deshalb explizit geprüft werden; der Wrapper-Paginate-Schalter ist kein Coveragebeleg.

[Funding-Historie](https://developer.woox.io/api-reference/endpoint/futures/get_fundingFee_history) bietet Transaktions-ID, Pay/Receive, Status, Zeit und Seitenmetadaten. `parse_income:3226` setzt die Währung jedoch fest auf USD. Das darf weder als belegtes USD-Settlement noch als 1:1-USDT-Umrechnung übernommen werden. Die wirtschaftliche Originalwährung ist separat festzustellen. `fetch_ledger:2676` liest Wallet-Historie, nicht automatisch das gesamte Tradingledger. Als weiter zu implementierende Originalquelle existiert [Token-Historie](https://developer.woox.io/api-reference/endpoint/assets/token_history) mit unter anderem Funding-, PnL-, Fee-/Rebate-Typen und eigener Tokenangabe. Deren Retention, unverwechselbare IDs und Überschneidung mit Fills/Funding müssen vor einem vollständigen Money-Proof geklärt werden.

## 2. Orderly-Familie: `woofipro` und `modetrade`

### Belegte Gemeinsamkeit, keine Aliasannahme

Beide sind **eigene** direkte `Exchange`-Klassen, nicht voneinander oder von `woo` abgeleitet. Beide benutzen im gepinnten Original `https://api-evm.orderly.org` sowie `https://testnet-api-evm.orderly.org`; `sign` (`woofipro:3261`, `modetrade:2797`) bindet `orderly-account-id`, API-Key, Timestamp und Ed25519-Signatur. Erforderlich sind API-Key, Secret und Account-ID. Der Broker-Ordertag unterscheidet sich: `CCXT` gegenüber `CCXTMODE`. Gleiches Backend bedeutet weder gleiche Konten noch austauschbare Autorität/IDs. Die separaten Klassen müssen in der Inventur separat erhalten bleiben.

Vorhandene, regulär bereitgestellte Orderly-Keys können technisch den bestehenden CCXT-Signaturpfad nutzen; es ist **kein** neuer Chain-Signer allein wegen des DEX-Labels nötig. Hier wurden keinerlei Wallet-/Account-/Key-Registrierungen durchgeführt oder vorgeschlagen. Der bestehende [TSX-Client](C:/Users/nikla/Desktop/tsx-core/exchange_executor/ccxt_client.py:47) übernimmt deklarierte Credentials; das ist keine automatische Zertifizierung eines neuen Credentialprofils.

Die heutigen offiziellen Beispiele verwenden `api.orderly.org` / `testnet-api.orderly.org`, anders als die gepinnte Hostkonfiguration. Kein automatischer Hosttausch oder ungeprüftes Aliasvertrauen: Auth-/Broker-/Hostparität bleibt separat zu belegen. [Orderly-Accountinformation](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-account-information) bietet einen signierten Account-ID-Read, Accountmodus, Maximalhebel und symbolbezogene IMR-Faktoren/Maximalnotionale.

### Modus und größenabhängiges Risiko

[Margin-Modes](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-margin-modes) ist ein signierter symbolbezogener **Default**-Read. [Einzelposition](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-one-position-info) liefert unter anderem `margin_mode`, Hebel und vorzeichenbehaftete Positionsmenge. Für Cross-Admission müssen Default und bestehende Exposure zusammen geprüft werden; Cross/Isolated-Scope nicht vermischen. Ein belastbarer One-way-Originalvertrag wurde in den gelesenen Quellen nicht vollständig nachgewiesen. `hedged=None` und eine vorzeichenbehaftete Menge sind für sich kein solcher Nachweis.

Wichtig: `parse_position` (`woofipro:3088`, `modetrade:2622`) setzt **immer** `marginMode='cross'` und verwirft den ursprünglichen Hebel. Ein native-shaped ISOLATED-Original wurde lokal nachweislich als Cross normalisiert. Deshalb originale Modusfelder zwingend vor dem gemeinsamen Wrapper-Ergebnis prüfen. WOOFi besitzt `fetch_margin_modes:2853`/`fetch_margin_mode:2883`; Mode Trade besitzt diese API/Methode im Pin noch nicht. Die aktuelle dokumentierte Raw-Alternative macht fehlendes Wrapper-`has` aber nicht zum dauerhaften Ausschluss.

Die [IMR-Regel](https://orderly.network/docs/introduction/trade-on-orderly/perpetual-futures/margin-leverage-and-pnl) hängt nicht nur von einer diskreten Hebelliste ab, sondern auch von Mark-Notional und dessen 4/5-Potenz. Order-/Positionsnotional ist zusätzlich im [offiziellen Account-Math-Vertrag](https://orderly.network/docs/sdks/tech-doc/modules/orderly_network_perp.account) berücksichtigt. `fetch_leverage` liest nur Accountinformationen; es liefert keine vollständige Tierfunktion. [Public Config](https://orderly.network/docs/build-on-omnichain/restful-api/public/get-leverage-configuration) zählt verfügbare Hebeleinstellungen auf, keine Notional-Tiers. Ein kleiner konservativer Provider-Solver wäre zu prüfen; keine erfundene Treppenfunktion, kein fester 50x-Beweis und keine SDK-Erweiterung behaupten, bevor diese Mathe-/Originalbindung getestet ist.

### Geschützter Entry und Original-Children

`create_orders` (`woofipro:1884`, `modetrade:1594`) lehnt Stop-/Trigger-/Attached-Orders **vor** dem Batchaufruf ab. Der normale [Batch-Endpunkt](https://orderly.network/docs/build-on-omnichain/restful-api/private/batch-create-order) beweist somit keinen Entry+Stop-Mischbatch.

Die beiden `create_order_request`-Implementierungen (`1720` / `1430`) erzeugen beim Standard-`stopLoss` ein anderes Algo-Gebilde als die heutige [Create-Algo-Dokumentation](https://orderly.network/docs/build-on-omnichain/restful-api/private/create-algo-order): root `TP_SL` und inneres `TP_SL`, statt eines tatsächlich geprüften Bracket-/Stop-Loss-Vertrags. Zudem wird IOC wie bei WOO im konditionalen Zweig nicht übernommen. Das ist ein konkreter Wrapper-/Raw-Adapterbedarf, kein Provider-Ablehnungsbeweis.

Der bessere native Ansatz ist [BRACKET + TP_SL](https://orderly.network/docs/build-on-omnichain/user-flows/algo-order-samples): dessen Menge richtet sich nach der ausgeführten Entry-Menge. Die positionweite Alternative richtet sich dagegen nach der gesamten Position und kann andere positionweite Stops stornieren oder selbst verworfen werden. Diese Alternative ist nicht eigentumssicher austauschbar. [Algo-Einzelabfrage](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-algo-order-by-order_id) enthält Root-/Parent-/Algo-ID und Children; daraus muss später eine vollständige Native-Identitätskette entstehen. Die einfachen Create-Beispiele garantieren noch keine beiden dauerhaften TSX-Leg-IDs, keine IOC-Kombination und keinen Zero-fill-/Cancel-Ausgang.

### Current-/History-/Money-Coverage

Die konkreten Wrapper haben normale und Algo-Orderabfragen, Einzel-Lookup auch nach Client-ID, Current-Positions und Holdings. Für Mode Trade: `fetch_order:1882`, `fetch_open_orders:2036`, `fetch_my_trades:2129`, `fetch_balance:2207`, `fetch_positions:2739`; bei WOOFi: `2172`, `2327`, `2420`, `2498`, `3203`. Komplette Current-Evidence muss sämtliche relevanten symbol-/marginbezogenen Teilbereiche, Children und unklare lokale IDs enthalten, nicht nur eine Standardliste.

[Trade-Historie](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-trades) dokumentiert trotz Zeit-/Seitenparametern nur die neuesten 500 Einträge. Native Fills enthalten ID, Order-ID, Ausführungszeit, Fee-Asset und PnL. Die Grenze darf nicht durch blindes `page++` als vollständig erklärt werden. Erforderlich sind beweisbare Fenster-/Order-Detailanschlüsse einschließlich dichter gleicher Zeitstempel, persistierter Retention-Grenze und verpasster Offlineintervalle. Keine Aussage, dass zeitliches Bisection die Retention immer überwinden könne.

[Funding-Historie](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-funding-fee-history) liefert Pay/Receive, Accrued-Status, Zeiten und Seitenmetadaten, im gelesenen Schema aber keine unveränderliche Ereignis-ID. `parse_income` gibt dementsprechend `id=None` aus und setzt USDC. Eine sichere Native-/Composite-ID, Änderungssemantik und Doppelbuchungsgrenze gegenüber PnL-Settlement sind noch zu belegen. [Fundingbeschreibung](https://orderly.network/docs/introduction/trade-on-orderly/perpetual-futures/funding-rate) unterscheidet aufgelaufenes Funding und dessen PnL-Settlement; öffentliche Fundingraten sind keine privaten Cashlegs.

`fetch_ledger` (`woofipro:2607`, `modetrade:2316`) ruft [Asset-Historie](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-asset-history) auf: diese dokumentiert Transfers/Ein-/Auszahlungen, nicht das ganze Tradingledger. Der Wrapper benutzt zudem `balance_token`/`pageSize`, während die aktuelle Quelle `token`/`size` nennt. Holdings, Fills, Funding und PnL-Settlement sind getrennt zu integrieren und gegen Überschneidungen zu prüfen. Keine Null-Funding-Inferenz aus leerer Transferhistorie.

## 3. XT (`xt`)

### Produkt, Account und Modus

`fetch_markets:1033`/`parse_market:1185` trennt Spot, lineare und inverse Kontrakte sowie Ablaufprodukte. Für lineare Kontrakte setzt der Parser zwar `settle` auf Quote, `settleId` aber auf Base; auch das ist kein unbesehen übernehmbarer Settlementbeleg. Originale `contractSize` und integer `origQty` sind zu beachten: ein Vertrag ist nicht automatisch eine Einheit Basisasset. SDK-Hosts sind `fapi.xt.com` (linear), `dapi.xt.com` (inverse), getrennt vom Spot-Host; kein Testnet in `urls.test` des Pins. Das beweist nicht, dass grundsätzlich kein Testnet existiert.

[Accountinformation](https://doc.xt.com/docs/futures/User/GetAccountInfo) liefert signiert Account-/User-ID und Trade-/Open-Berechtigungen. [Leverage-Read](https://doc.xt.com/docs/futures/Entrust/GetLeverageInfo) liefert Account-ID, Symbol, `positionType`, `positionSide`, Vertragstyp und Hebel. Der aktuelle Raw-Endpunkt ist in der gepinnten impliziten API noch nicht enthalten. Er ist ein möglicher begrenzter Adapteranschluss, kein Anlass, Cross aus Options abzuleiten. `position/change-type` ist lediglich ein [Margin-Setter](https://doc.xt.com/docs/futures/User/Change%20Position%20Type), kein One-way-Wechsel.

Die [offizielle Position-Mode-Hilfe](https://xtsupport.zendesk.com/hc/en-us/articles/7227252344729-Position-Mode) beschreibt Two-way-Positionen, auch für USDT-Kontrakte. Die API verwendet LONG/SHORT. Ein tatsächlicher One-way-Read/Originalvertrag wurde hier nicht gefunden; daraus folgt `pending`, nicht die unbelegte Aussage, XT könne niemals One-way. `parse_position:5127` liefert `hedged=None` und wertet fehlenden/unbekannten `positionType` als isolated aus. Fehlende Felder dürfen später nicht als bewiesener Modus durchgehen.

### Entry, Trigger und IDs

`create_contract_order:2553` sendet gewöhnliche Orders an `order/create`, Trigger an `entrust/create-plan` und `stopLoss`/`triggerStopPrice` an `entrust/create-profit`. Die SDK-Probe zeigt: ein vermeintlicher Entry mit `stopLoss` sendet nur den Profit-/Stop-Auftrag, ohne Entry-Orderart/Entry-Preis. `create_orders` ist nicht implementiert. Die einfache [Create-Order-Dokumentation](https://doc.xt.com/docs/futures/Order/Create%20Orders) besitzt native Attached-Preisfelder und IOC, aber das allein belegt weder Child-IDs noch die benötigte Lifecycle-Atomizität.

Die aktuelle [v2-Batch-Dokumentation](https://doc.xt.com/docs/futures/Order/BulkOrdersNew) nennt `atomic-create-batch` und bis zu 20 Orders. Im gepinnten SDK ist nur v1 `create-batch` deklariert. Die v2-Beispiele liefern weder einen Trigger-Mischbatch noch einen auswertbaren vollständigen Leg-ID-Response. Der Endpunktname ist keine Atomizitätsgarantie für TSX-Schutz. [Create-Profit](https://doc.xt.com/docs/futures/Entrust/CreateStopLimit) zeigt im Beispiel nur ein Boolean-Ergebnis und keine Client-ID-Bindung; [Create-Plan](https://doc.xt.com/docs/futures/Entrust/CreateTriggerOrders) ist wieder ein eigener Namespace. Kein boolesches Erfolgsergebnis darf als Exchange-ID benutzt werden.

Konkret besteht das v2-Beispiel aus einem JSON-Array normaler MARKET-Orders mit `symbol`, `origQty`, `orderType`, `orderSide`, `positionSide`; die Beispiel-ACK enthält lediglich einen leeren `result`-String. Beschrieben sind Triggerpreis-Validierungsfehler, nicht per-Leg-ACKs, Rollback bei Teilannahme oder Fill-/Stop-Schutz bei IOC. Die ältere [Bulk-Seite](https://doc.xt.com/docs/futures/Order/bulk-orders) nennt v2 im Titelvertrag, aber v1 in ihrem Beispiel und ebenfalls keinen Leg-Response. Keine dieser Seiten schließt die Schutzlücke. [Order-Detail](https://doc.xt.com/docs/futures/Order/see-orders-by-id) liefert `sourceId` als Triggerursprung sowie Ausführungsmenge und Triggerpreise; ein dokumentierter Triggerursprung ist noch keine beweisbare Liste sämtlicher erzeugter Child-IDs.

`fetch_order:2648` trennt `orderId`, `entrustId`, `profitId`, `trackId`. `fetch_orders_by_status:3011` trennt normale, Trigger-, Profit- und Trailing-Listen. IDs sind einschließlich dieses Ursprungsnamespace zu speichern; ein nackter Zahlenvergleich zwischen ihnen ist kein Ownership-Beweis. Entry-/Stop-Originalzuordnung, exakte schließende Menge, Partial-/Late-Fill sowie endgültiger Cancel bleiben vor Freigabe Pflicht.

### Tiers und Geld-/Historyquellen

[Notional-Brackets](https://doc.xt.com/docs/futures/MarketData/see-leverage-stratification-of-single-trading-pair) sind eine reale öffentliche Metadatenquelle. Die konto-/symbolgebundene effektive Hebeleinstellung kommt separat aus dem privaten Read. `fetch_leverage_tiers:4299`/`fetch_market_leverage_tiers:4377` sind implementiert, aber `parse_market_leverage_tiers:4425` verwendet für die erste Untergrenze `brackets[-1]`. Zwei Original-shaped Tiers mit Obergrenzen 50.000 und 250.000 wurden tatsächlich als erstes Intervall **[250.000, 50.000]** normalisiert. Eine begrenzte Raw-Normalisierung ist nötig; kein Produktionspatch in dieser Prüfung. Notional-Einheit, Markbewertung, sämtliche Tiergrenzen und eigene Restorders müssen unabhängig bewiesen werden.

`fetch_positions:4978` kombiniert Position- und Break-Listen. `fetch_my_trades:2048` liest die Contract-Trade-Liste; `fetch_orders_by_status` allein ist kein vollständiger historischer Abschluss aller Entrust-Namensräume. Historische Endpunkte existieren daneben; Retention, Seitenabschluss und Dense-Timestamp-Fälle bleiben ungeprüft. `parse_order:3578` skaliert Betrag/Filled teilweise mit `contractSize`, `remaining` aber direkt aus `leavingQty`: Originalmengen und Einheit müssen vor einer gemeinsamen Restmengenentscheidung konsistent normalisiert werden.

Der zusätzliche [Partial-Cancel-Read](https://doc.xt.com/docs/futures/Order/PartialCanceledOrders) enthält ausgeführte und stornierte Vertragsmengen, aber ausdrücklich nur Daten der letzten fünf Minuten und Zeitfenster bis 300.000 ms; übervolle Fenster können scheitern. Er ist damit kein dauerhafter Recovery-/Retentionersatz nach längerer Offlinezeit und beweist insbesondere keine atomare Submit-Teilannahmesemantik.

[Balance-Bills](https://doc.xt.com/docs/futures/User/Get%20User%27s%20Account%20Flow%20Information) liefert eigene ID, Coin, ADD/SUB, PnL-/Fee-/Funding-/Liquidationstypen und ID-/Richtungs-Pagination mit `hasNext`. [Funding-Liste](https://doc.xt.com/docs/futures/User/Get%20Fund%20Fee%20Information) bietet ID, Coin, Zeit und Positionsseite. Das sind brauchbare vollständige Ledgeransätze, **noch kein** getesteter Coveragebeweis. `fetch_ledger:3777`/`fetch_funding_history:4778` verwerfen die Seitenhülle; letzteres verlangt im Wrapper ein Symbol, obwohl die heutige Dokumentation einen All-Symbol-Ansatz erwähnt. `cast`-Vorzeichen, Bills-Doppelzählung und Fee/Rebate müssen aus Originalen geprüft werden, nicht aus dem Normalizer geraten.

## Tatsächlich ausgeführte lokale Gegenproben

Keine zusätzlichen Testdateien, kein importierter Repo-Server, keine Credentials, keine API-Sends. Ausgeführt wurden kleine Python-In-memory-Probes mit dem genannten Pin. Für die Orderproben wurden native-shaped Dokumentationsmärkte durch den **echten** jeweiligen `parse_market` geladen; sämtliche unerwarteten `fetch`-Aufrufe warfen sofort `REAL_TRANSPORT_FORBIDDEN`. Nur die genau benannten impliziten SDK-Methoden wurden durch zählende lokale Antwortfunktionen ersetzt. Diese Methodeninterzeption prüft Routing/Payload/Normalisierung, nicht Signatur- oder Providerverhalten.

| Probe | Ursprünglicher Input / lokale Antwort | Tatsächliches Ergebnis |
|---|---|---|
| WOO Bracket/IOC/IDs | `PERP_BTC_USDT`; Buy Limit 0.01 @ 50000; IOC; SL 45000; Client-ID 123; native-shaped `rows` mit Stop-ID 432132 vor Bracket-ID 432130 | ein abgefangener Algo-Aufruf; Payload `type=LIMIT`, kein IOC; normalisierte ID `432132` statt Parent; echte Transportaufrufe 0 |
| WOOFi Stop-Batch | `PERP_BTC_USDC`; eigener Limit-Entry plus Reduce-only-Triggerstop | `NotSupported` vor Batchsend; abgefangene Sends 0, echte Transportaufrufe 0 |
| Mode Trade Stop-Batch | gleicher native-shaped Produkt-/Orderinput, eigene Klasse | dieselbe Verweigerung; abgefangene Sends 0, echte Transportaufrufe 0 |
| WOOFi und Mode Trade Attached-Builder | echter `create_order_request`, Limit/IOC + `stopLoss` | jeweils root `TP_SL`, inneres `TP_SL`, `type=LIMIT` ohne IOC; keine Transportmethode nötig |
| XT vermeintlicher geschützter Entry | `btc_usdt`; native Contractsize 0.001; 10 Kontrakte, Limit 50000, IOC, SL 45000 | ein abgefangener `CreateProfit`, keine Entry-Orderart/-Preis; Boolean-Antwort ergibt `id=None`; echte Transportaufrufe 0 |
| XT Tieruntergrenze | zwei native Brackets: max 50000/250000, Hebel 50/25 | erste Untergrenze 250000 bei Obergrenze 50000; reine Parserprobe |
| WOOFi und Mode Trade Modus | native Position mit `margin_mode=ISOLATED`, Hebel 7 | jeweils normalisiert `marginMode=cross`, `leverage=None`; reine Parserproben |

Alle Proben beendeten sich mit Exit 0 **nach Assertions auf genau diese negativen Befunde**. Das bedeutet nicht, dass die Profile ihre Sicherheitsprüfungen bestanden. Kein allgemeiner Python-/Node-/Mutation-/Coverage-Lauf wurde für diese Notiz gestartet.

## Gemeinsame Anschlussgrenze und Übergabe

Die reale [geschützte Submission](C:/Users/nikla/Desktop/tsx-core/src/trading_engine.ts:2386) bindet beide ursprünglichen Client-IDs, markiert Entry und Stop als submitting und erwartet zwei echte `ExchangeOrderResult`-Objekte. Das [Journal](C:/Users/nikla/Desktop/tsx-core/src/trading_recovery.ts) behandelt den gesendeten unbekannten Ausgang konservativ. Ein vom Provider bei IOC-Zero-fill **nie erzeugter** Stop besitzt im aktuellen Vertrag keinen `not_created`-Ausgang. Weder eine synthetische Exchange-ID noch eine erfundene Cancel-Antwort, fehlende Remotezeile oder behauptete Nullfüllung heilt dies. Bereits gesendete unbekannte Legs bleiben obligationspflichtig. Ein Anbieter, der nachweislich vorab echte Child-IDs erzeugt und terminalisiert, kann einen anderen Anschluss ermöglichen; genau dieser Nachweis fehlt hier noch.

Vor einer `eligible`-/Implementierungsentscheidung sind deshalb je Kandidat mindestens folgende Originalbeweise erforderlich:

1. Zulässiger gebundener IOC-Entry mit unveränderbarer Preisgrenze und eigener, nicht fremde Exposure schließender Stopbindung; Original-IDs bei voller/teilweiser/Nullfüllung, unklarem Submit und Cancel.
2. Authentifizierte aktuelle Account-/Credential-/Brokerbindung plus tatsächlicher Cross-One-way-Scope; vollständige Tiers oder korrekt gebundene nichtlineare Marginfunktion, ohne automatische Accountkonfiguration.
3. Vollständige Current-/historische Unterbereiche mit dauerhaften IDs, Retention-/Cursor-Grenzen und beweisbaren Überschneidungen zwischen Fees, Funding, PnL und Transfer-/Settlementcashlegs.
4. Produktgenaue Parser-/Raw-Adapter-Fixes mit den zehn Pflichtklassen aus 009.2, einschließlich Streamausfall und Recovery. Kleine gefundene SDK-Fehler sind zu reparierende Integrationsarbeit, nicht automatisch `not_easy`.

Erst anschließend unabhängige Implementierungsattestation; echte Providerabnahme weiterhin ausschließlich über das separat autorisierte 008-Verfahren mit dessen Host-/Limit-/Ownership-/Cleanupgrenzen. Für fehlende Website-/API-Vertragsbelege ist der Status hier bewusst offen. Die Prüfung hat ausschließlich diese neue Notiz angelegt; Source, Profile, Zertifizierungen, Inventur, Tests und bestehende Freigaben bleiben unverändert.
