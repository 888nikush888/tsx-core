# 009 – Binance- und OKX-Familien: Produktgrenzen und Integrationspfade

Stand: 2026-09-03, lokale Prüfung mit **CCXT 4.5.75**. Untersuchung ausschließlich anhand installierter Quellen, öffentlicher offizieller Dokumentation und abgefangener lokaler SDK-Aufrufe. Kein API-/Kontozugriff, keine Order, keine Profilfreigabe. Ausgangsstand: bestehende Reparaturen 001–008; der Auftraggeber meldet 196 Testdateien und den vollständigen Modulratchet grün. Diese Meldung ist kein eigener neuer Gesamttest und keine Providerabnahme.

## Entscheidung in Kürze

| Slice | Entscheidung für 009 | Präziser Grund |
| --- | --- | --- |
| `binance` / `binanceusdm`, klassische USDⓈ-M Crypto-Perpetuals, linear, One-way/Cross | `not_easy` für den gegenwärtigen geschützten Entry-Vertrag | IOC selbst ist abbildbar, aber die gemeinsame normale Batchorder darf den Stop nicht mehr enthalten. Ein separater Entry-/Stop-Mutationsablauf wäre eine andere Schutzarchitektur, kein fehlendes Profilflag. |
| Dieselbe Familie, USDⓈ-M Portfolio Margin | `not_easy` | Zusätzlich andere accountweite Margin-/Collateral-Verträge; der gepinnte SDK-Pfad verwendet für einige Conditional-Operationen noch die abgelösten PAPI-Routen. |
| `binance` / `binancecoinm`, COIN-M inverse Perpetuals | `not_easy` | Auch COIN-M verbietet inzwischen Stop-Typen im normalen Batch. Zusätzlich fehlt dem bestehenden TSX-Modell die inverse Mengen-/PnL-Rechnung; Contractzahl × Contractgröße ist hier nicht einfach Basismenge. |
| Binance befristete Futures, Options, Quanto-/sonstige Nichtlinear-Slices, TradFi mit eigenem Session-/Settlement-Vertrag | `not_easy` im aktuellen Standard | Keine stillschweigende Umdeutung zum linearen Crypto-Perpetual. Expiry/Settlement bzw. abweichende Recheneinheiten verlangen eigene Lifecycle-/Geldnachweise. Unbelegte zusätzliche Angebote werden damit nicht als vorhanden behauptet. |
| `okx` Global, echte lineare Crypto-SWAPs, `net_mode`, Cross, **preisbegrenzter IOC mit genau einem angehängten Markt-SL** | **`not_easy` gegenüber dem aktuellen Two-leg-Lifecycle** | Der Provider-/SDK-Wirepfad ist positiv belegbar. Die abschließende Zero-Fill-Prüfung zeigt aber: Ein nie angelegtes Kind lässt sich im bestehenden vorjournalisierten Zweierauftrag nicht terminal auflösen. Eine neue optional-child-/not-created-Lifecycle-Semantik wäre erforderlich, nicht bloß ein Providerhelper. |
| OKX gewöhnlicher GTC-/Post-only-Entry mit demselben attached-SL-Verfahren | `not_easy` für diese konkrete Schutzvariante | Die aktuelle Regel erzeugt das Kind nach vollständiger Ausführung oder Teilfüllung **mit beendetem Rest**, nicht bei weiter offenem teilgefülltem Parent. Der Native-Attach-Pfad beweist deshalb keine kontinuierliche Deckung dieses Entrytyps. Kein stiller GTC→IOC-Wechsel. |
| OKX inverse, Options, normale Expiry-Futures, Portfolio Margin/Hedge/Isolated | `not_easy` gegenüber dem derzeitigen TSX-One-way/Cross/linear-Swap-Vertrag | Produktrechnung bzw. Kontomodell sind nicht mit einem Normalisierungsflag gleichwertig. Das Urteil betrifft diese Slices, nicht OKX insgesamt. |
| `myokx` EEA, dokumentierte X-Perps | `not_easy` | Dokumentierte feste mehrjährige Expiry; weder Name „X-Perp“ noch vererbtes Swap-Flag entfernt die Laufzeit. |
| `myokx`, eventuell zusätzlich verfügbare echte laufzeitlose lineare SWAPs | `pending` | In dieser Untersuchung kein belastbarer aktueller Angebots-/API-Scopebeleg. REST-/Pro-Deklarationen widersprechen sich beim Swap-Flag. Nicht allein deswegen ausschließen und nicht als Global-Alias freischalten. |

`eligible` würde bedeuten: mit bestehendem CCXT und begrenzten Providerhelfern auf den Standard bringbar, **weder implementationVerified noch providerAcceptanceVerified**. Nach der zusätzlichen Zero-Fill-Lifecycleprüfung ist keiner der hier vollständig geprüften Slices vorbehaltlos `eligible`. Das ist kein Ausschluss aufgrund kleiner Normalisierungslücken: Die jeweilige ausschlaggebende Schutz-/Produktgrenze steht oben. Live und Demo/Testnet benötigen getrennte Bindungen, Fixtures und spätere gesondert autorisierte Abnahme. Insbesondere wurde die Juli-Änderung nicht gegen ein Demo-Konto geprüft.

## Tatsächlich gelesener TSX-Vertrag

- `exchange_executor/ccxt_profiles.py:7`: `attached_stop` ist als Strategie benannt; die drei gegenwärtigen Profile benutzen `certified_batch`. Eine Deklaration implementiert noch keinen alternativen Rückgabe-/Reconcilepfad.
- `exchange_executor/ccxt_adapter.py:516` rechnet Basismenge in Contracts um; `:631` verlangt gleiche angefragte Entry-/Stopmenge; `:666`/`:685` senden beide Spezifikationen gemeinsam an `create_orders`; `:701` behandelt Teilresultate nicht als atomare Erfolgszusage.
- `exchange_executor/symbol_resolver.py:22` lässt aktive lineare Swaps zu. `fill_quantity_provenance.py:76`, `fill_identity.py:42` und `_linear_accounting_metadata` in `ccxt_adapter.py:259` binden die originale Mengenrechnung an dieses Modell.
- `src/trading_recovery.ts:220`/`:238`: Jede erwartete Order braucht eine konkrete positive Beobachtung. Ein leeres Listing löst einen mutmaßlich gesendeten Auftrag nicht auf.
- `src/trading_safety_proof.ts:65`/`:125`/`:178`: aktuelle vollständige Quellen, gebundene Ownership und **remote bestätigte** Stopdeckung bleiben Voraussetzungen. Ein noch nicht entstandenes Attached-Kind ist kein bereits aktiver Stop.
- `exchange_executor/current_state.py:12` begrenzt aktuelle Kontoscans separat; `history_reader.py`/RecoverySchedule begrenzen zusätzliche Recovery-/History-/Fundingreads gemeinsam. Neue Quellen dürfen keinen weiteren Fünfer-Topf oder versteckte SDK-Autopagination öffnen.

## A. Binance: aktuelle Migration schlägt ältere Batchschemas

Die [offizielle USDⓈ-M-Änderungsliste](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/change-log) ordnet Conditional-Orders seit 2025-12-09 dem Algo-Service zu; normale `/order`- und `/batchOrders`-Aufrufe lehnen diese Typen mit `-4120` ab. Dieselbe Liste korrigiert im August 2026 die Trade-Retention auf drei Monate und beschreibt teilweise zusammengeführte UM-/CM-Historyantworten. Das ist aktueller als die alten SDK-Dokumentationslinks und sechsmonatige Annahmen.

Die [CM-/UM-Integrationsmitteilung](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/Important-CM-UM-Integration-Notice) ist seit Ende Juni 2026 wirksam: COIN-M hat eigene neue Algo-Routen, Stop-Ablehnung je normalem Batch-Element, gemeinsame Position-Mode-Einstellung und gemeinsame UM-/CM-Limits. Placement-Antworten sind nicht zwingend Fillnachweise. Deshalb dürfen Aliasinstanzen desselben Kontos weder unterschiedliche Moduswahrheiten noch unabhängige Budgets behaupten.

### Gepinnter SDK-Befund, keine Providerbehauptung

Alle folgenden Zeilen beziehen sich auf `.../site-packages/ccxt/async_support/binance.py`:

| Methode | Zeile | Lokal belegtes Verhalten / notwendiger Helper |
| --- | ---: | --- |
| `create_orders` | 6584 | Wählt ausschließlich `fapiPrivatePostBatchOrders` bzw. `dapiPrivatePostBatchOrders` für diese Slices. Kein gemischtes normales/Algo-Batchrouting. |
| `create_order` | 6662 | Linear-Conditional kann `fapiPrivatePostAlgoOrder` verwenden; das löst **nicht** das gemeinsame Entry-/Stop-Problem. PAPI-Conditional-Pfade separat prüfen, nicht mit normalem FAPI gleichsetzen. |
| `fetch_order` / `fetch_orders` | 7151 / 7244 | Trigger-/normale Quelle und Produktkontext müssen explizit geführt werden. Alte/native IDs nicht umschreiben. |
| `fetch_open_orders` | 7563 | Ein Aufruf wählt normale **oder** Algo-Orders; es gibt keinen automatisch vollständigen Vereinigungsbeleg. Accountweit außerdem UM-/CM-Scope nach aktueller Migration halten. |
| `fetch_my_trades` | 8394 | Unified-Methode verlangt für Derivate noch ein Symbol. `paginate=True` würde zusätzliche Aufrufe verstecken. Native Sourcehelfer für belegte accountweite Scans sind normale Integrationsarbeit, kein Grund für `not_easy`. |
| `parse_trade` | 5057 | Bewahrt `info`; liest `orderId`, Trade-ID, `commission` und `commissionAsset`. Die echte Gebührenwährung nicht durch Settlement ersetzen. |
| `fetch_funding_history` / `parse_income` | 11548 / 9299 | Filtert `FUNDING_FEE`; liefert Income-Asset und Originalantwort. Das ist nicht der vollständige Account-Geldstrom. Ungefilterte Income-Originale/Receipts und Typnamespace sind nötig. |
| `fetch_position_mode` / `fetch_margin_mode` | 13680 / 13807 | Verwendet authentifizierte Mode-/SymbolConfig-Routen; gegen Konto, Generation, Markt und aktuelles Profil binden. Kein automatischer Modewechsel. |
| `fetch_leverage_tiers` | 10946 | Authentifizierte Brackets verfügbar; rohe Grenzen samt accountbezogenem Koeffizienten erhalten, keine pauschale öffentliche MaxLeverage. |

Der [aktuelle Handelsvertrag](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade) bietet IOC sowie separat adressierbare Algo-Orders. Normale und Algo-IDs müssen getrennt bleiben; insbesondere `algoId`/`clientAlgoId` nicht mit ausgeführter Kindorder verwechseln. Tradeabfragen unterstützen begrenzte Zeitfenster bzw. ID-Fortsetzung; Zeit- und `fromId`-Modus sind nicht beliebig kombinierbar. Orderhistory verliert alte ungefüllte Cancels früher als ausgeführte Orders. Ein fehlender Altauftrag ist daher kein Nichtversandbeweis.

Der [Accountvertrag](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account) trennt Single-Asset-Werte von USD-bewerteten Multi-Asset-Aggregaten und liefert Income-Betrag, Asset, Typ, Zeit und Transaktions-/optionale Trade-ID. Für TSX wäre ein klar gebundener nativer Reportingasset-Slice der engste Start. USD-Aggregate sind kein 1:1-FX-Kurs für USDT/USDC oder BNB-Gebühren. Die aktuelle exakt garantierte Income-Retention/Finalität bleibt separat `pending`; hier wurde keine drei-Monats-Garantie aus der Trade-Retention übertragen.

**Schutzgrenze:** Keinen dokumentierten nativen gemeinsamen IOC-plus-SL-Auftrag als Ersatz gefunden. Das ist eine begrenzte Rechercheaussage, kein Beweis, dass nie ein weiterer Endpoint existieren kann. Der nachgewiesene normale Batchpfad ist jedoch ausdrücklich unzulässig. Zwei separate Mutationen, gleich ob parallel oder nacheinander, werden hier nicht als kleiner Helper freigegeben. `closePosition` wäre außerdem eine andere Größen-/Ownershipsemantik als ein exakt mengenbegrenzter Reduce-only-Stop.

**Pro:** `ccxt/pro/binance.py:3927`, `:4537`, `:4934` implementieren Orders, Positionen, eigene Trades; `:4346`/`:4382`/`:5269` behandeln bereits `ALGO_UPDATE`. Watch-Flags und Nachrichtenerhalt bleiben Trigger, keine REST- oder Accountfinalität. Neu zusammengeführte Symboluniversen benötigen Originalmarkt-/Produktbindung. Credentials: API-Key und Secret; `fetch_accounts` ist im Pin nicht implementiert. Ein separat belegter UID-Helper oder der vorhandene ausdrücklich keygebundene Identitätsmodus ist nötig; keine erfundene stabile UID bei Rotation.

## B. OKX Global: native IOC-Untermenge, nicht synthetischer Zweierbatch

Die [offizielle Ankündigung vom 1. Juli 2026](https://www.okx.com/help/okx-announcement-on-optimizing-order-placement-for-order-attached-take) ergänzt den zuvor ausschließlich vollständigen Fill: Bei Teilfüllung und anschließendem Reststorno entsteht der angehängte Schutz für die tatsächlich gefüllte Menge. Split-TP ist ausgenommen. Damit ist ein einzelner SL an einem terminierenden IOC ein ernsthafter Integrationskandidat. Es ist weder eine atomare Fillgarantie noch ein Nachweis für einen weiter teiloffenen GTC-Parent.

Die [V5-Referenz](https://www.okx.com/docs-v5) beschreibt `ioc`, separate normale/Algo-Listen und eigene Attached-/Algo-ID-Felder. `attachAlgoId` ist ausdrücklich **nicht** die spätere `algoId`; die eigene `attachAlgoClOrdId` wird zur Kind-Client-ID. Einige Beschreibungen nennen noch vollständige Parentfüllung: Diese Textabweichung muss im Abnahmeartefakt sichtbar bleiben, statt die datierte Juli-Regel zu ignorieren. Die [offiziellen Basisordertypen](https://www.okx.com/en-gb/help/x-basic-order-types) beschreiben native Futures-Preisgrenzen und Reststorno. Markt-SL ohne TSX-Limit bedeutet deshalb keine Provider-Fillgarantie.

### Native Abbildung und anschließend bestätigte Lifecyclegrenze

1. `attached_stop`-Providerhelper bildet den **originalen gemeinsamen Intent** auf eine Parent-IOC-Order mit originalem `px` und genau einem `attachAlgoOrds`-SL ab. `slOrdPx='-1'`, unveränderter Nutzertrigger, eigene deterministische `attachAlgoClOrdId`; kein TP-Splitting, kein `optimal_limit_ioc` als Ersatz für das eigene Entrylimit.
2. Parent-ACK und nur angehängte Konfiguration bleiben von realem Kindstatus getrennt. Echte Child-REST-Beobachtung über eigene Algo-Client-ID bindet `algoId`, Symbol, Seite, Trigger, tatsächliche Rest-/Fillmenge und reduzierende Semantik. Keine `attachAlgoId`-Umbenennung, kein pauschales `open`.
3. Zero-Fill-IOC erzeugt möglicherweise kein Kind. Der bisherige `resolveObservedOperations` verlangt beide tatsächlichen Orders: Es braucht einen engen **originalgebundenen Native-Parent-Abschlussbeleg**, nicht ein erfundenes rejected-Kind. Gleiches gilt für nach Teilfüllung verkleinerte Kindmenge: ursprüngliche Anforderung bleibt unverändert, beobachtete abgeleitete Menge separat und nachvollziehbar.
4. Erst mit diesen Belegen kann bestehende Ownership/Schutzprojektion das Kind übernehmen. Fehlendes/verspätetes/abgelehntes Kind bleibt im vorhandenen Unknown-/Schutz-/Reconcilepfad. Kein neuer Entry→Stop-Einzelauftrag und keine zweite Engine.
5. Nicht-IOC-Strategien bleiben ausdrücklich außerhalb eines solchen zukünftigen Slices. Das verlangt eine sichtbare Präflightgrenze, keine Strategieänderung. Diese Schnittstellenanforderung wurde vor Implementierung an Root gemeldet; Sourcefreigabe wurde nicht angefordert oder vorgenommen.

**Abschließender Abgleich, maßgeblich für die Entscheidung:** `ExchangeOrderResult.exchangeOrderId` ist in `trading_types.ts:653` zwingend; `executionFields` in `exchange_contract_validation.ts:55` verlangt eine echte nichtleere ID auch bei Cancel/Reject. `submitTrackedProtectedEntry` in `trading_engine.ts:2411` journalisiert beide IDs und setzt beide Legs vor Send auf `submitting`. Die erwähnte Recovery verlangt anschließend positive Beobachtungen beider Legs. `cleanupExitSiblings` in `trading_engine.ts:2072` verweigert Closure bei `unknown` ohne Remote-ID. Der vorhandene `retireUndispatchedExit`-Pfad gilt nur für tatsächlich ungesendete `created`-Exits; er beweist nicht, dass ein nach gesendetem Parent bedingt erzeugbares Kind nie entstand. Ein `not_created`-/optional-child-Nachweisvertrag existiert im geprüften Produktionscode nicht. Damit würde der originale Zero-Fill-IOC aktuell dauerhaft unresolved bleiben. Nur diesen Fall zu ignorieren oder eine synthetische Child-ID/Cancelled-Antwort einzuführen wäre falsch. Eine neue Lifecycle-/Journalbeweisart würde mehrere gemeinsame Verbraucher berühren und ist **nicht** der hier erlaubte kleine Attached-Providerhelper. Das ändert die vorläufige IOC-Eignung zu `not_easy`, nicht die positiv dokumentierte Providersemantik.

### Weitere kleine, aber verpflichtende Normalisierungsarbeiten

Alle lokalen Methodenstellen: `.../site-packages/ccxt/async_support/okx.py`.

| Bereich | Pin-Stelle | Nachweis-/Implementierungsbedarf |
| --- | --- | --- |
| Parent-Wire | `create_order_request:3060`, `create_orders:3382` | IOC und Attached-Market-SL sind im Pin transportierbar. Zwei unabhängige normale/Trigger-Specs werden dagegen beide an den normalen Batchendpoint gesendet; das ist nicht der zulässige Attached-Pfad. |
| Originalmarkt/Units | `parse_market:1752` | `instType`, `ctVal`, `ctValCcy`, `settleCcy`, `expTime`, `lotSz`, `tickSz` original binden. Basismenge = Contracts × belegter Basis-Contractwert nur beim tatsächlich linearen passenden Slice. |
| Aktuelle Orders | `fetch_open_orders:4276` | Normale Liste und mehrere Algoarten separat, jede Seite mit Originalcursor; `trigger=True` wählt standardmäßig nur `trigger`, nicht sämtliche conditional/oco/trailing-Orders. Kein vollständiger Scope aus einer einzigen Liste. |
| Einzel-ID | `fetch_order:4130` | Originale Parent-/Algo-ID-Routen und spätere Execution-Order-ID getrennt korrelieren. Fremde oder leere Client-IDs bleiben roh fremd/leer. |
| Fills | `fetch_my_trades:4788`, `parse_trade:2407` | `fills-history`, Instrumenttyp, Original-`billId`-Cursor; SDK-Trade-ID ist `tradeId`, nicht der Cursor. `fillTime` und `ts` nicht ungeprüft austauschen. Raw-Fee/Asset und Originalzeit erhalten. |
| Gebühren/Geld | `parse_trade:2466`, `fetch_ledger:4879`, `parse_ledger_entry:5010` | SDK negiert Provider-Fee zum CCXT-Kostenzeichen; Rebate nicht doppelt negieren. `balChg` ist ein Cashleg, kein zusätzlich zu denselben Trades nochmals zu buchender PnL. |
| Funding | `fetch_funding_history:6545` | Liest Bills-Archive mit Typ 8; Ergebnis wird nachträglich gefiltert. Für fortsetzbare Belege rohe `billId`, `ccy`, `balChg`, `posBalChg`, `pnl`, Typ/Subtyp erhalten; gefilterte Unified-Liste allein beweist kein accountweites EOF. |
| Mode/UID | `fetch_position_mode:6760`, `fetch_leverage:5676` | AccountConfig plus symbolbezogenes Leverage-Readback; `uid/mainUid`, Konto-/Generations-/Mode-/Profilbindung. API-Key, Secret **und Passphrase**. Kein automatisch umgestelltes Konto. |
| Tiergrenzen | `fetch_market_leverage_tiers:7211`, `parse_market_leverage_tiers:7266` | SDK benennt rohe `minSz/maxSz` als `minNotional/maxNotional`, ohne Contract-/Preisumrechnung. Diese Namen dürfen im TSX-Solver nicht als bewiesenes Settlementnotional gelten. Originaleinheit, Accountmodus, Markt, Contractgröße und aktuelle Markbewertung explizit binden. |

Die [offizielle Algo-/History-Referenz](https://app.okx.com/docs-v5/en/) trennt Pending, History und konkrete Algoabfrage; begrenzte Archive dürfen nicht zur unbegrenzten Nichtvorhandenheitsaussage werden. Das [Bills-Archiv](https://app.okx.com/docs-v5/en/#trading-account-rest-api-get-bills-details-last-3-months) unterstützt drei Monate; ältere Export-/Apply-Pfade sind kein synchroner Standardscan. Ungelöste Altpflichten bleiben sichtbar. Die [Mode-Referenz](https://app.okx.com/docs-v5/en/#trading-account-rest-api-get-account-configuration) liefert UID, Konto- und Positionmodus. Der zunächst engste Slice ist Futures-Accountmodus/Net/Cross mit belegter nativer Settlementwährung; Multi-Currency-/Portfolio-Margin nicht aus einem Leveragewert ableiten. [Tierregeln](https://www.okx.com/en-ae/help/v-tiered-maintenance-margin-ratio-rules) rechnen im Futures-Cross-Scope mit Contracts; zusätzliche lokale Reserven und andere Orders müssen in der gebundenen Prüfung berücksichtigt werden.

**Reporting:** Native USDT→USDT bzw. USDC→USDC benötigt keine Paritätsannahme. USD-Reporting über andere Assets benötigt echte verfügbare FX-Originale oder bleibt unresolved. OKX-Fill-Indizes allein werden hier nicht zu einer neuen FX-Route erklärt. Funding, Gebühren/Rebates und Teil-PnL müssen idempotent aus den originalen Bill-/Fillereignissen in das gemeinsame Ledger; alle Time-/Currency-/Revisionchecks und die fünf zusätzlichen Aufrufe bleiben erhalten.

**Pro:** `ccxt/pro/okx.py:1808` kann mit `trigger=True` `orders-algo` und sonst `orders` abonnieren; `:1627` eigene Trades, `:1676` Positionen, `:427` Ticker. Beide Orderkanäle sind nötig, wenn man diese Beschleunigung vollständig bewirbt. Ein Stream erzeugt nur REST-Reconcilebedarf; fehlender Initialsnapshot und Restarts können keine leere Kontowahrheit beweisen.

## C. `myokx` ist kein uneingeschränkter Alias

`async_support/myokx.py:11` erbt OKX, setzt aber `hostname='eea.okx.com'`, `mica=True`, eigene Marktfilter und `future=False`. `pro/myokx.py:8` setzt zusätzlich `swap=False`; die Watchmethoden bleiben vererbt. Diese Unterschiede sind lokal reproduzierbar und dürfen im vollständigen ID-Inventar nicht verloren gehen.

Die [offiziellen EEA-X-Perp-Spezifikationen](https://www.okx.com/en-sg/help/x-perps-contract-specifications) nennen feste fünfjährige Laufzeiten und konkrete Endtermine. Der installierte `okx.parse_market` bewahrt bei `instType=FUTURES` die Expiry; der Fundingpfad erkennt an anderer Stelle `ruleType='xperp'`. Das rechtfertigt keinen TSX-Swap-Alias. Der Bezeichner USD im Instrument ist ebenso kein Beleg für eine beliebige USD/USDC/USDT-Gleichheit. Ein mögliches weiteres echtes Swap-Angebot und dessen Demo-/Live-Scope bleiben `pending`, nicht ein aus dem Klassenflag erfundener positiver Fall.

## Ausgeführte lokale Gegenproben

Python 3.12 mit `-B`; tatsächliche installierte Async-Klassen, `set_markets` mit rein synthetischem linearem bzw. inversen Markt; `request` vor jeglichem Transport durch einen lokalen Recorder ersetzt. Keine Netzwerkfunktion aufgerufen. Die Gegenprobe ruft **die echte `create_orders`-Implementierung** auf, nicht eine nachgeschriebene Abbildung. Ergebnis aller vier Cases: lokal erfolgreich abgeschlossen.

| Case | Abgefangener tatsächlicher Request |
| --- | --- |
| `binanceusdm`, Entry LIMIT/IOC + Reduce-only-Markttrigger | `fapiPrivate POST batchOrders`, Entry `price=100.5`, Stop `type=STOP_MARKET`, `triggerPrice=90`, `clientAlgoId=tsxstop1`: gerade der nach aktueller Dokumentation abgelehnte gemischte Normalbatch. |
| `binancecoinm`, dieselbe Form | `dapiPrivate POST batchOrders`, Stop weiterhin STOP_MARKET: kein automatisch migrierter Algo-Batch. |
| `okx`, zwei unabhängige Specs | `private POST trade/batch-orders`, `ordType=ioc` plus `ordType=trigger`: kein nativer Attached-Auftrag. |
| `okx`, ein Parent mit einem Attached-SL | Ein IOC mit `px=100.5`; `attachAlgoClOrdId=tsxstop1`, `slTriggerPx=90`, `slOrdPx=-1`, `slTriggerPxType=mark` bleiben exakt erhalten. |

Zusätzlich ausgeführte Assertions für **OKX und myokx**: synthetischer linearer Markt mit `ctVal=0.01`; native Tiergrenze `maxSz=100`; der echte SDK-Parser liefert `maxNotional=100` und `currency=USDT` ohne Contract-/Markumrechnung. Beide Assertions grün. Dies belegt die notwendige Einheitenkorrektur, nicht ein Provider-Tierlimit. Bei Mark 50.000 wäre der aus diesen synthetischen Units abgeleitete Grenzwert 50.000 USDT, nicht 100 USDT.

Anschließend drei echte lokale Node-Boundaryassertions gegen `validateOrderResult`/`confirmedOrderEvidence`: Cancelled-Parent mit echter ID und Fillmenge 0 wird akzeptiert; Child mit `exchangeOrderId:null` wird als ungültiger Identifier verworfen; die unabhängige Evidenzmenge enthält danach nur den Parent. Alle drei grün. Dies bestätigt die Nichtdarstellbarkeit des nie erzeugten Childs im aktuellen Antwortvertrag; der oben gelesene Recovery-/Closurepfad liefert die dauerhafte Folgewirkung. Keine temporäre Providerantwort wurde als reale Order bestätigt.

### Vor einer Implementierungsabnahme permanent zu ergänzen

1. Alle vier Wirefälle oben; neue Quellen dürfen den negativen Binance-/normalen OKX-Batch nicht freischalten.
2. OKX IOC: vollständiger Fill, Teilfill plus Cancel, Zero-Fill plus Cancel, verzögertes/fehlendes/abgelehntes Kind, Stop sofort ausgelöst; ursprüngliche Anforderung unverändert.
3. Kein Schutzbeweis allein aus Parent-ACK oder `attachAlgoId`; falsche Algo-Client-ID, falsches Konto/Generation/Symbol/Trigger/Seite und doppelte widersprüchliche Kind-ID negativ.
4. Reale Teilmengenprojektion; `accFillSz>0` trotz terminalem Cancel; kein Neustart des IOC-Rests; Kindfill und spätere reguläre Execution-ID gemeinsam idempotent.
5. GTC-Partials und Split-TP nicht aus dem IOC-Nachweis freigeben.
6. Normale plus alle relevanten Algo-Scopes, mehr als eine volle Seite, Cursorzyklus, Deadline, verspätetes Kind, Fremdorders und verschiedene Produkt-/Settlementscopes; unvollständig bleibt unvollständig.
7. Fees in Originalasset, Rebate, Fundingabzug/-gutschrift, Accountlog-/Fillüberlappung, winzige Decimal-/Rationalbeträge; kein künstlicher USD-Wert und keine doppelte PnL-Buchung.
8. Contractgröße ungleich eins, Tick-/Lotgrenzen, rohe Tier-Contractgrenzen und frischer Mark; fehlende Einheiten-/Mode-/Accountbelege blockieren nur neue Entries, nicht vorhandenen Schutz.
9. Restart in jedem Journal-/Parent-/Child-/Cursorabschnitt; späte negative Cashkorrektur; Callbudget und Deadline einschließlich Fehler/Retry/Pro-Lücken.
10. Globale Freigabe/Drain/Closure mit echten Parent-/Child-Terminalbelegen; Retentionlücken oder verschwundene ungefüllte Altorders niemals als no-send interpretieren.

Diese Cases sind ein Implementierungsauftrag, keine hier behauptete grüne Paritätssuite. Im aktuellen Research wurden nur die beschriebenen Offline-Wire-/Parserproben ausgeführt.

## Reproduzierbare Versionsbindung

SDK-Wurzel: `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/`.

| Datei relativ zur SDK-Wurzel | SHA-256 |
| --- | --- |
| `async_support/binance.py` | `89dea75776e911a7ff27631b823534106e854e81e0e944c3204d717592ff2096` |
| `pro/binance.py` | `6c812f68ba2974cbdc5ebd35ecc00b402995d7aa4a6baf1d79458a914ba76203` |
| `async_support/binanceusdm.py` | `1270e0ed41bd23f4b290dd6a36f02ca13d7c0420ae82518ea5c59c4745dd1e41` |
| `async_support/binancecoinm.py` | `852c01ac68ae51f9c0661fc60985adcd3d50229c45c84bf8bff81be80b1e9fff` |
| `async_support/okx.py` | `470fda8880a1170b576dd6911fccb349bb95bd5847a277a11b98f7bbb4e85665` |
| `pro/okx.py` | `82c27ec2e4609005e0c29e1b0caa683a5c6d0a4ceb73259646e150816fb9f7c5` |
| `async_support/myokx.py` | `4d8f2ed6d290f06e2c6d588514d2976f1cec39ef9069c987e20d78b394066dfb` |
| `pro/myokx.py` | `a73299aefa74b45396813cdae011e45665b8ff5d8c12588af533f2b2c9f8d5ac` |

Grenze der Übergabe: Nur diese Research-Datei wurde angelegt. Keine SDK-, Source-, Schema-, Registry-, Profil- oder Gateänderung. Kein realer Provideracceptance-Nachweis. Binance-Protokollumstellung, OKX-IOC-Untermenge, Parent-/Child-Integrationsbedarf und EEA-Produktgrenze wurden Root und relevante Aliasbefunde dem Offline-Inventaragenten gemeldet.
