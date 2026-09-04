# 009 — Kandidatengruppe A: Aster, BingX, Bitget und DeepCoin

Stand: 2026-09-04. Geprüft wurden ausschließlich der lokal installierte
CCXT-/CCXT-Pro-Pin **4.5.75**, die vorhandenen TSX-Schutzverträge und öffentliche
Primärdokumentation. Alle SDK-Transporte in den neuen Tests sind fail-closed
abgefangen. Es gab keine Konten, Credentials, Providerrequests, Orders, Server-
oder TSX-Laufzeitverbindungen. Dies ist weder Profilattestation noch
Providerabnahme.

## Entscheidung

| ID und eng geprüfter Slice | Entscheidung | Konkrete, nicht durch ein Profilflag lösbare Grenze |
| --- | --- | --- |
| `aster`, V3 Crypto-USDT-Perps, One-way, Cross, Single-Asset | **`not_easy`** | Aster kann eigenständige OTO/OCO/OTOCO-Strategieparents anlegen. Die offizielle aktuelle API bietet für offene und historische Strategien nur einen Lookup anhand einer bereits bekannten `strategyId` oder `clientStrategyId`, aber keine accountweite vollständige Strategieliste. Der normale accountweite `openOrders`-Read ist ein anderer Scope. TSX muss auch unbekannte fremde Verpflichtungen erkennen. Das lässt sich ohne neuen Providervertrag oder nachweisbar lesbaren Produktausschluss nicht lokal rekonstruieren. |
| `bingx`, lineare USDT-/USDC-Perps, One-way | **`not_easy`** | Die offizielle Swap-Referenz erlaubt `clientOrderId` bei der Anlage nur für MARKET und LIMIT. Der benötigte eigenständige STOP_MARKET besitzt damit keinen belegten unveränderlichen eigenen Schlüssel nach verlorenem ACK. Der Batch verwendet dieselbe Orderstruktur und liefert Erfolge/Fehler getrennt. Preis, Menge oder Antwortindex dürfen nach TSX-Vertrag keine Eigentumsidentität ersetzen. |
| `bitget`, Classic lineare USDT-/USDC-Perps, One-way | **`not_easy`** | Der normale Batch kann einen Stop nur als Preset-Metadatum des Entries annehmen und bestätigt ausschließlich den Parent. Ein separat identifizierbarer TPSL-Stop verwendet einen anderen Endpunkt und ist nicht Bestandteil des Entry-Batches. Ein Support würde einen neuen gemeinsamen Embedded-Child-Lifecycle für Zero-/Teilfill, nie erzeugte Kinder, ACK-Verlust und Restart benötigen; das ist keine kleine Profilnormalisierung. |
| `deepcoin`, lineare USDT-Perps, One-way/Merge | **`not_easy`** | Der Pin besitzt keinen nativen `createOrders`-Pfad. Ein Attached-SL wird laut offizieller API erst **nach** Ausführung und Positionsöffnung erzeugt und erhält im Placement-ACK keine unabhängige Kindidentität. Die aktuelle Triggerliste ist symbolgebunden, auf 100 Zeilen begrenzt, ohne Cursor und ohne Client-ID; CCXT Pro 4.5.75 ignoriert den dokumentierten `PushTriggerOrder`-Event vollständig. Hinzu kommen kein nativer Funding-History- und kein Mode-Readback im Pin. |

`not_easy` bedeutet hier nicht „die Börse kann keine Derivate“. Es bedeutet nur,
dass der konkrete TSX-Slice den unveränderten 009-Sicherheitsstandard nicht mit
kleinem Profil, Parser oder Requestadapter erreichen kann. Spot, Coin-M/inverse,
Expiry-Futures, Hedge-/Split-/Isolated-/UTA-Slices und andere Sicherheiten werden
nicht stillschweigend mitentschieden.

## Maßgeblicher TSX-Vertrag

`exchange_executor/ccxt_adapter.py` sendet einen geschützten Entry als genau einen
gemeinsamen `create_orders`-Aufruf und verlangt anschließend für **beide** Beine
echte Exchange- und eigene Client-Identitäten. Ein unbekannter Submit bleibt
unresolved; es gibt keinen blinden Retry und keine geometrische Fremdorder-
Übernahme. `current_state.py` zertifiziert nur explizite, vollständig paginierte
Providerreader; der generische Fallback bleibt absichtlich
`provider_pagination_not_proven`. `stream_hub.py` verwendet Pro nur als Trigger;
REST muss weiterhin die autoritative vollständige Sicht liefern.

Für Geldwerte bleibt der festgelegte Scope USD/USDT/USDC ohne angenommene Parität.
Eine Börse wäre erst integrierbar, wenn Settlement sowie Fee-/Funding-Assets als
Originalwerte innerhalb dieses Scopes bewiesen oder andere Assets ausdrücklich
unresolved behandelt werden. Keiner der vier Kandidaten erhält aus einem
`has=True`-Flag eine solche Geld- oder Historienfreigabe.

## Aster

### Belegte Grenze

Die aktuelle offizielle
[Futures-V3-Account-/Trading-Referenz](https://asterdex.github.io/aster-api-website/futures-v3/account%26trades/)
(abgerufen 2026-09-04) trennt normale Orders von Strategieorders:

- `GET /fapi/v3/openOrders` kann normale offene Orders accountweit lesen.
- `POST /fapi/v3/placeStrategyOrder` kann OTO, OCO und OTOCO erzeugen.
- `GET /fapi/v3/strategyOpenOrder` und
  `GET /fapi/v3/strategyHistoryOrder` verlangen jeweils genau eine bereits
  bekannte `strategyId` **oder** `clientStrategyId` sowie den Strategietyp.
- Normale Order-/Fillhistorie ist symbolgebunden; nicht gefüllte stornierte oder
  abgelaufene Orders verschwinden nach sieben Tagen, und `userTrades` arbeitet in
  höchstens siebentägigen Fenstern.

Der separate
[RPC-Open-Orders-Endpunkt](https://asterdex.github.io/aster-api-website/rpc/endpoints/)
ist kein stiller Ersatz: er ist ein anderer Produkt-/Hostvertrag, liefert nur
Orders ab der dokumentierten Genesiszeit und maximal 1000 Zeilen ohne belegten
Fortsetzungscursor. Die Dokumentation sagt nicht zu, dass damit V3-Strategieparents
vollständig abgedeckt sind.

Der Pin kann normale Entry- und STOP_MARKET-Beine mit eigenen IDs in einem nativen
Batch serialisieren; daran scheitert Aster nicht. Der neue permanente Test zeigt
aber am echten SDK-Pfad, dass `fetch_open_orders()` ausschließlich
`fapiPrivateGetV3OpenOrders` aufruft. Es existiert nur der singuläre implizite
`fapiPrivateGetV3StrategyOpenOrder`, keine accountweite Strategiecollection.
CCXT Pro verarbeitet normale `ORDER_TRADE_UPDATE`/`ALGO_UPDATE`, kann aber einen
unbekannten, noch nicht aktivierten Parent nicht als vollständige REST-Sicht
ersetzen.

### Warum kein kleiner Implementierungsvorschlag

Eine lokale Liste eigener TSX-Strategie-IDs würde fremde Clients desselben Kontos
nicht abdecken. Ein symbol-/preisbasierter Scan würde Eigentum erfinden. Zulässig
wäre erst eine offizielle, vollständig paginierbare accountweite Strategieliste
oder ein authentifiziert lesbarer Beleg, dass das konkrete Konto keine Strategien
halten kann. Ohne eine solche Providerfähigkeit müsste TSX sein Kontomodell und
seinen globalen Fremdorder-/Freigabevertrag grundlegend ändern. Deshalb jetzt
`not_easy`, nicht weiter `pending`.

Zusätzlich blieben vor jeder späteren Neubewertung Agent→Main-Account-Bindung,
gemeinsamer Nonce-Fence für REST und Pro, Testnet-Host/Signaturdomain,
Crypto-vs-Stock-Marktfilter, echte ContractSize, Raw-Leverage-Brackets,
symbolübergreifende Fillcoverage sowie Income-Dedupe für Fee/Funding/PnL zu
implementieren und zu testen. Diese Punkte werden nicht durch den vorhandenen
Batch positiv vorweggenommen.

## BingX

### Belegte Grenze

Die offizielle
[BingX Perpetual Swap Trade API Reference](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-trade/api-reference.md)
(abgerufen 2026-09-04) nennt:

- `clientOrderId` bei der Anlage nur für MARKET und LIMIT; STOP_MARKET ist zwar
  ein Ordertyp, hat aber keine belegte eigene Client-ID-Zuweisung.
- Der Batch verwendet dieselbe Place-Order-Struktur, maximal fünf Elemente und
  getrennte `orders`-/`errors`-Collections.
- Current Orders können normale und bedingte Typen lesen; Historie ist auf
  höchstens siebentägige Zeitfenster begrenzt. Coin-M ist ein eigener Vertrag.

CCXT 4.5.75 schreibt trotzdem `clientOrderID` in das STOP_MARKET-Batchelement.
Ein SDK-Serializer ist keine Providerzusicherung. Der neue Test belegt außerdem:

1. Ein client-only `fetch_order(None, ..., {clientOrderId})` fügt dem nativen
   Request zusätzlich `orderId=None` hinzu. Ein enger Raw-Lookup könnte diesen
   SDK-Fehler reparieren, aber nicht die fehlende Stop-ID-Zuweisung des Providers.
2. `create_orders` normalisiert nur `data.orders`; `data.errors` geht aus der
   Rückgabeliste verloren. TSX erkennt das fehlende Bein zwar fail-closed, erhält
   daraus aber keinen positiven Stopbeleg.

### Warum kein kleiner Implementierungsvorschlag

Nach einem Timeout kann ein akzeptierter STOP_MARKET ohne unterstützten eigenen
Schlüssel weder eindeutig gefunden noch von einer fremden gleichartigen Order
unterschieden werden. Ein Attached-Stop verschiebt das Problem in denselben
Parent-/Child-Lifecycle wie Bitget. Notwendig wäre entweder ein neuer offizieller
immutable Stop-Key samt Lookup-/Retentionvertrag oder eine größere Änderung des
gemeinsamen Ownership-/Protection-Lifecycles. Beides liegt außerhalb „leicht
integrierbar“.

Spätere Neubewertung müsste zusätzlich Standardorders, bedingte Orders und TWAP
als getrennte Current-State-Scopes vollständig lesen, One-way-/Margin-/Leverage-
Readbacks binden, USDT und USDC getrennt normalisieren, historische Cursor und
Income/Funding-Originalidentitäten beweisen sowie die Pro-Reconnectpfade für alle
relevanten Scopes testen.

## Bitget

### Belegte Grenze

Offizielle Classic-Dokumente, alle abgerufen 2026-09-04:

- [Batch Order](https://www.bitget.com/api-doc/classic/contract/trade/Batch-Order):
  normale Orders werden unabhängig verarbeitet. `presetStopLossPrice` ist ein
  Feld des Parent-Entries; das ACK enthält nur `orderId` und `clientOid` des
  Parent-Elements.
- [Place Order](https://www.bitget.com/api-doc/classic/contract/trade/Place-Order):
  derselbe Preset-SL ist Parent-Metadatum. In One-way können neue Reduce-only-
  Orders vorhandene Schutzorders stornieren; der Orderstatus muss daher
  autoritativ gelesen werden.
- [Stop-profit and stop-loss plan orders](https://www.bitget.com/api-doc/classic/contract/plan/Place-Tpsl-Order):
  ein echter separater TPSL-Stop hat eine eigene `orderId`/`clientOid`, verwendet
  aber einen anderen Request nach dem Entry.
- [Get Pending Trigger Order](https://www.bitget.com/api-doc/classic/contract/plan/get-orders-plan-pending):
  `normal_plan`, `track_plan` und `profit_loss` sind explizite getrennte Scopes.

Der echte Pin bestätigt genau diese Trennung. Der Parent-Batch mit Preset-SL gibt
nur eine Parentorder zurück. Der normale `fetch_open_orders`-Pfad ruft nicht den
Plan-Endpunkt; `trigger=true, planType=profit_loss` ist ein zweiter Request. Auch
CCXT Pro verlangt für Planorders eine separate Trigger-Subscription.

### Warum kein kleiner Implementierungsvorschlag

Die vorhandene TSX-Journalform erwartet zwei bereits dispatchte und identifizierte
Beine. Bitgets Preset kann bei Zero-Fill ohne Kind enden und bei Fill/Teilfill
später einen Schutzzustand erzeugen; das ACK liefert dafür keine unabhängige
Kindidentität. Ein separater `place-tpsl-order` nach dem Fill würde zeitweise
ungeschützte Exposure erzeugen und ist kein Ersatz. Erforderlich wäre ein
anbieterübergreifender Embedded-Protection-Zustand mit originalem
`not_created`-/created-Beleg, Teilmengen, Late Fill, Cancel, Restart und globaler
Freigabe. Das ist derselbe größere Lifecyclevertrag, der bereits für andere
Parent-only-Attachments als `not_easy` behandelt wird.

UTA, Hedge/Isolated, Coin-M und Laufzeit-Futures bleiben separate Produkte. Für
einen späteren Classic-Slice wären darüber hinaus vollständige Normal-/Plan-
Current-State-Pagination, dreimonatige Planhistorie, Fill-/Funding-/Ledger-
Dedupe, Fee-Assetgrenzen, Modus-/Tierreadback und getrennte Pro-Subscriptions zu
implementieren.

## DeepCoin

### Belegte Grenze

Die aktuelle offizielle Dokumentation, abgerufen 2026-09-04, macht den
Lebenszyklus ausdrücklich:

- [Trigger Order](https://www.deepcoin.com/docs/DeepCoinTrade/triggerOrder):
  Attached TP/SL werden erst erzeugt, nachdem der Trigger ausgeführt und eine
  Position geöffnet wurde. Das ACK bestätigt nur die Parent-`ordId`/`clOrdId`.
- [Batch Place Orders](https://www.deepcoin.com/docs/v2/DeepCoinTrade/batchOrders):
  Einträge sind unabhängig; die dokumentierte V2-Batchform besitzt keine
  per-Order-Client-ID und das ACK liefert nur `ordId`/Fehlerstatus je Index.
- [Get Pending Trigger Orders](https://www.deepcoin.com/docs/DeepCoinTrade/triggerOrdersPending):
  symbolgebunden, maximal 100 Zeilen, ohne dokumentierten Cursor und ohne
  Client-ID im Ergebnis.
- [Private WebSocket](https://www.deepcoin.com/docs/privateWS/subscribe) und
  [Trigger Order Notification](https://www.deepcoin.com/docs/privateWS/TriggerOrder):
  `TriggerOrder`/`PushTriggerOrder` ist ein eigener Streamscope.

CCXT 4.5.75 besitzt `createOrders=False`; der Basispfad wirft vor Transport. Ein
regulärer Orderrequest kann `slTriggerPx` tragen, normalisiert aus dem ACK jedoch
nur den Parent. Der triggerbezogene REST-Read hat weder Cursor noch eigene
Client-ID. Der Pro-Dispatcher behandelt `PushTrade`, `PushOrder` und
`PushPosition`, aber keinen `PushTriggerOrder`; der permanente Test speist genau
diesen dokumentierten Event lokal ein und bestätigt, dass keine Auflösung erfolgt.

### Warum kein kleiner Implementierungsvorschlag

Ein neuer Serializer für den inzwischen dokumentierten V2-Batch genügt nicht:
Der Batch hat keine stabile per-Leg-Clientidentität, ist nicht atomar und bildet
einen eigenständigen bereits aktiven Stop nicht ab. Das Attachment hat wiederum
einen später erzeugten, im Parent-ACK unbekannten Child. Zugleich kann die
autoritative Triggerliste bei 100 Zeilen saturieren und liefert keine eigene
Clientidentität. Die Lücken betreffen daher Submit, Ownership, Current State,
History und Pro gemeinsam.

Vor einer Neubewertung wären ein providerseitiger immutable Child-/Stop-Key und
vollständige paginierbare Triggerquelle nötig. Zusätzlich fehlen im Pin native
Funding-History, Position-/Margin-Mode-Readbacks und Leverage-Tiers. Ein
Pro-Triggerparser wäre klein, löst aber weder Historie noch Schutz. Fee, Rebate,
Funding und Settlement müssten als Original-USD/USDT/USDC-Werte nachgewiesen
werden; andere Assets bleiben unresolved.

## Permanente Offline-Tests

Neue Datei:
`exchange_executor/tests/test_candidate_group_a_boundaries.py`.

Sie enthält zehn reale SDK-/Request-/Parsergrenzen:

1. CCXT-Pin 4.5.75;
2. Aster-Normalorderscope ohne Strategy-Collection;
3. BingX-client-only-Lookup mit `orderId=None`;
4. BingX-Partial-Batch, dessen Fehlercollection nicht zurückgegeben wird;
5. Bitget-getrennte Normal-/Plan-Current-State-Reads;
6. Bitget-Parent-only-ACK eines Preset-SL;
7. DeepCoin ohne nativen `createOrders`-Pfad;
8. DeepCoin-Parent-only-ACK eines Attached-SL;
9. DeepCoin-Triggerliste ohne Client-ID und Fortsetzungscursor;
10. DeepCoin Pro ignoriert den dokumentierten Triggerorder-Event.

Ausgeführt vom Repository-Root:

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe' -B -m unittest discover -s exchange_executor/tests -p test_candidate_group_a_boundaries.py -v
& 'C:/Users/nikla/AppData/Local/Temp/tsx-core-ccxt-py312/Scripts/ruff.exe' check exchange_executor/tests/test_candidate_group_a_boundaries.py
```

Ergebnis: **10/10 Tests, 2,537 s, Exit 0; Ruff Exit 0.** Keine vollständige Suite
und keine Profil-/Providerfreigabe daraus ableiten.

## Versionsbindung

Dateien relativ zum installierten `ccxt`-Paket:

| Datei | SHA-256 |
| --- | --- |
| `async_support/aster.py` | `df0bac5adcc10033bebf3b8a7e03f4cef856ee4a1ea5e2a60867800f8b86b9b7` |
| `pro/aster.py` | `e043049157b02a867058bfa30a3f8a92cf38490a6d2a77c7695b7505151764b5` |
| `async_support/bingx.py` | `470066ce94cd455c2c0cac0eb289d65a1f7c2ccb4d6451926db1b8a3dd8880b0` |
| `pro/bingx.py` | `8586a9a5cea6a625e6fcb84564db25bd601a52410f7a5d61d3279abc30bd3f01` |
| `async_support/bitget.py` | `8ca2c9ea06bb18a58efc07495af478ab4f4bf9f32c9c17280a153f38406d1262` |
| `pro/bitget.py` | `4a6fd4dbb8204a63a5518112d41b17fd38e0e88c15bb41f4c854da0fe62399a8` |
| `async_support/deepcoin.py` | `deb20b89a932ae432c7b1a10406f2881f6b5fe37f5080d19520195ca32e14aa7` |
| `pro/deepcoin.py` | `9b3002d88e7ff9c516a19440edef2b4f24d7ad377725c56aae74c57b6a30ce51` |
| `tests/test_candidate_group_a_boundaries.py` | `5129d047bd5201d60a30005a880bccb7cb30e19d4ccd12b8e8d6a196a79eaf7e` |

## Ergebnis für die koordinierte Matrix

Root kann die vier bisherigen `pending`-Einträge nach eigenständigem Lesen dieses
Belegs jeweils eng auf `not_easy` umstellen. Es wurde bewusst kein Produktprofil,
keine Certification/Receipt-/Approval-Registry und keine Matrixdatei verändert.
`implementationVerified=false` und `providerAcceptanceVerified=false` bleiben für
alle vier IDs zwingend.
