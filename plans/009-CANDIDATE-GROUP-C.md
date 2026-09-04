# 009 – Kandidatengruppe C: Mode Trade, WEEX, WOO, WOOFi Pro und XT

Stand: 2026-09-04. Geprüft wurde ausschließlich lokal mit Python 3.12 und der
installierten CCXT-/CCXT-Pro-Version **4.5.75** sowie gegen offizielle
Primärdokumentation. Keine Credentials, Konten, Providertransporte, WebSockets,
Orders oder TSX-Laufzeit wurden verwendet. Diese Entscheidung ist weder eine
Implementierungsattestation noch eine Providerabnahme. Für alle fünf IDs bleiben
`implementationVerified=false` und `providerAcceptanceVerified=false`.

## Entscheidung

| CCXT-ID | enger Produktbereich | Entscheidung | ausschlaggebende Grenze |
| --- | --- | --- | --- |
| `woo` | linearer USDT-Perp, Cross, One-way | `not_easy` | Der native Bracket-Pfad dokumentiert und erzeugt LIMIT, nicht den unveränderten begrenzten IOC-Entry. Der Pin verwirft IOC im Conditional-Zweig und normalisiert die erste Responsezeile – in der dokumentierten Bracket-Antwort kann das ein Stop-Child statt des Parents sein. Ein LIMIT-plus-Cancel-Ersatz benötigt einen neuen Race-/Partial-/Zero-fill-Lifecycle. |
| `woofipro` | linearer USDC-Perp, Cross, gewünschtes One-way | `not_easy` | Der Orderly-Bracket-Vertrag kennt LIMIT/MARKET, nicht IOC. Der gepinnte Attached-Builder erzeugt ein anderes TP/SL-Gebilde, verwirft IOC und der Normalbatch lehnt echte Stop-Legs ab. Ein ISOLATED-Original wird als Cross normalisiert; Funding besitzt keine unveränderliche Ereignis-ID und Trade-Historie ist auf die neuesten 500 Einträge begrenzt. |
| `modetrade` | linearer USDC-Perp, Cross, gewünschtes One-way | `not_easy` | Dieselben Orderly-Lifecycle-/History-/Money-Grenzen wie WOOFi Pro; zusätzlich fehlen im Pin die Margin-Mode-Reader. Die Klasse besitzt eine andere Brokerkennung und bleibt eine getrennte Identitätsdomäne, kein freies WOOFi-Alias. |
| `weex` | linearer USDT-Perp, Cross/Combined | `not_easy` | V3 kann IOC und einen Attached-SL am Parent senden, bestätigt aber nur Parent-Order-ID/Client-ID. Ein eigenständiger Stop läuft über den separaten Algo-Endpunkt; der Normalbatch ist kein Algo-Mischbatch und CCXT deklariert `createOrders=False`. Normal- und Algo-Current-State sind getrennte Reads. TSX müsste einen noch nicht identifizierten Child-Zustand und dessen Partial-/Zero-fill-/Cancelterminalität neu modellieren. |
| `xt` | linearer USDT-Perp | `not_easy` | Die dokumentierte normale IOC-Order kann einen Stoppreis tragen, ihr Beispiel-ACK beweist aber weder Parent- noch Child-ID. Im Pin ersetzt `stopLoss` den Entry vollständig durch den Profit-/Stop-Endpunkt; dessen Boolean-Antwort ergibt keine Order-ID. Modus ist nicht bewiesen, der Tierparser erzeugt bereits im ersten Intervall `minNotional > maxNotional`. |

`not_easy` bedeutet hier nur: nicht innerhalb des in Plan 009 erlaubten kleinen
Profil-/Normalisierungsumfangs vollständig sicher integrierbar. Es ist keine
Aussage, dass die Anbieter-APIs grundsätzlich ungeeignet sind. Eine spätere
Architekturerweiterung kann die Kandidaten neu bewerten.

## Warum kein Kandidat lokal implementierbar ist

Der bestehende gemeinsame TSX-Vertrag erwartet beim geschützten Submit zwei
eindeutige, echte Exchange-Ergebnisse und behandelt unbekannte gesendete Legs
weiter als Schutzpflicht. Er besitzt keinen belegten Zustand „Attached Child vom
Provider akzeptiert, aber noch nicht als eigene Order erzeugt/identifiziert“.
Genau dieser Zustand wäre für WEEX und XT nötig. WOO und die beiden
Orderly-Klassen würden zusätzlich die unveränderte IOC-Semantik durch einen
LIMIT-plus-Cancel-Ablauf ersetzen. Das ist kein Raw-Serializer-Fix, sondern eine
neue gemeinsame Zustandsmaschine für gleichzeitigen Fill, Cancel, Child-Erzeugung,
Teilfüllung, Nullfüllung, verspätete Events und Recovery.

Die History-/Money-Seite lässt sich ebenfalls nicht nur durch Aktivieren eines
CCXT-Flags schließen:

- Orderly dokumentiert für `/v1/trades` ausdrücklich nur die neuesten 500
  Einträge. Zeit- und Seitenparameter beweisen kein dichtes Fenster mit mehr als
  500 Ereignissen und keine dauerhafte Offline-Coverage.
- WOO normalisiert Funding auf `USD`, obwohl der untersuchte Perp-Scope USDT ist;
  das ist kein belegter 1:1-Kurs. WOOFi Pro und Mode Trade liefern für Funding
  `id=None`. Damit fehlen unveränderliche, replay-sichere Cashleg-Identitäten.
- WEEX verteilt normale Orders, Algo-Orders und deren Historien auf getrennte
  Endpunkte; ein einzelner generischer Open-Order-Read ist kein kompletter
  Schutzsnapshot.
- XT trennt normale Order-, Plan-, Profit- und Trailing-Namensräume. Nackte
  numerische IDs dürfen nicht domänenübergreifend als Ownershipbeweis gelten.

Die Nutzerentscheidung bleibt strikt: wirtschaftliche Auswertung nur in
USD/USDT/USDC, keine implizite Parität. Diese Einschränkung reduziert den
Produktscope, heilt aber weder fehlende Original-IDs noch unbewiesene
History-Coverage. Ereignisse in anderen Fee-/Funding-Währungen wären weiterhin
ungeklärt und dürften neue riskante Entries sperren; bestehender Schutz läuft
weiter.

## Permanente lokale Grenztests

Neue Datei: `exchange_executor/tests/test_candidate_group_c_boundaries.py`.

Die Tests binden die vollständigen Bytes aller fünf REST- und Pro-Klassen an
SHA-256 und prüfen mit echten SDK-Requestbuildern/-Parsern:

1. WOO-Bracket verwirft IOC und liefert bei Child-zuerst-Antwort die Child-ID als
   normalisierte Order-ID; der Fundingparser ersetzt den USDT-Produktscope durch
   `USD`.
2. WOOFi Pro und Mode Trade bauen keinen IOC-Bracket und verweigern ein echtes
   Stop-Leg im Normalbatch vor dem Send.
3. Beide Orderly-Parser überschreiben ISOLATED mit Cross, verwerfen Leverage und
   erzeugen Funding ohne Ereignis-ID.
4. WEEX Attached-SL besitzt im V3-Normalrequest nur die Parent-Client-ID; normale
   und Algo-Open-Orders benötigen zwei getrennte Endpunkte.
5. XT sendet bei `stopLoss` keinen Entry, erhält aus dem Boolean-ACK keine ID,
   produziert ein invertiertes erstes Notionalintervall und lässt `hedged`
   unbekannt.

`fetch` und unerwartetes `request` sind fail-closed Mocks. Die genau erwarteten
impliziten SDK-Methoden sind lokale `AsyncMock`-Antworten. Ergebnis des fokussierten
Laufs: **10/10 Tests grün**, kein Providertransport. Ruff wurde anschließend auf der
neuen Testdatei ausgeführt.

Gebundene vollständige Sourcehashes:

| Datei relativ zum installierten `ccxt/` | SHA-256 |
| --- | --- |
| `async_support/woo.py` | `123e1b2cb81b61d02d037501710015704bb9ded3e5f1e752db89849839200898` |
| `async_support/woofipro.py` | `e81dcdf6d7cb51aaba7f31b37e76ba49779df38684a57a86bd90a4b3215345d8` |
| `async_support/modetrade.py` | `e9289db2b53686ba54687ec7e7ca3747f2bf2de9814ba7191c53af94fe166ce5` |
| `async_support/weex.py` | `beb23d3eeead7b11d965ef9b017caa7a851e9f13f834a6edc79b6c93e9907bf8` |
| `async_support/xt.py` | `fc1cee6f675a43faebeef2ea7a35760830360a3b187f3d00ca087ee4e3f119a4` |
| `pro/woo.py` | `39bb1f6baf5f2429009e74561c5aa64259eda7dd70b42fe8da527dcad8464baa` |
| `pro/woofipro.py` | `8289f5b43922604a5d60e32abee8b66ea27b0673be7f359924ae48eb396cdd3d` |
| `pro/modetrade.py` | `f7aea910eb96ef7a25d6ca869d9839eae0ad9b56d0f38768cf215aff46a2f5a5` |
| `pro/weex.py` | `8a8e44a5e6b32033378526e4fca8a52bbf5d34e3d1bb3cff71f7e3910142b3e9` |
| `pro/xt.py` | `dbe54604c83c37741165acbdebb40734bf9333f2f74fff738a7bc5d845dbeadc` |

## Offizielle Primärquellen

Abruf am 2026-09-04, nur Dokumentseiten – keine API-Endpunkte:

- WOO: [Place algo order](https://developer.woox.io/api-reference/endpoint/trading/post_algo_order),
  [Get transaction history](https://developer.woox.io/api-reference/endpoint/trading/get_transactions),
  [Funding fee history](https://developer.woox.io/api-reference/endpoint/futures/get_fundingFee_history).
- Orderly: [Create algo order](https://orderly.network/docs/build-on-omnichain/restful-api/private/create-algo-order),
  [Get trades](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-trades),
  [Funding fee history](https://orderly.network/docs/build-on-omnichain/restful-api/private/get-funding-fee-history).
- WEEX V3: [Place order](https://www.weex.com/api-doc/contract/Transaction_API/PlaceOrder),
  [Place orders batch](https://www.weex.com/api-doc/contract/Transaction_API/PlaceOrdersBatch),
  [Current conditional orders](https://www.weex.com/api-doc/contract/Transaction_API/GetCurrentPendingOrders).
- XT Futures: [Create orders](https://doc.xt.com/docs/futures/Order/Create%20Orders),
  [Bulk orders](https://doc.xt.com/docs/futures/Order/BulkOrdersNew),
  [Create stop limit](https://doc.xt.com/docs/futures/Entrust/CreateStopLimit),
  [Notional brackets](https://doc.xt.com/docs/futures/MarketData/see-leverage-stratification-of-single-trading-pair).

## Spätere Neubewertung

Eine Neubewertung ist erst sinnvoll, wenn je Anbieter Originalbelege und eine
gemeinsame TSX-Erweiterung für alle folgenden Punkte vorliegen:

1. unveränderter preisbegrenzter IOC-Entry plus eigentumssicherer Stop bei
   Full-/Partial-/Zero-fill und unbekanntem Submit;
2. echte Parent-/Child-IDs oder ein expliziter, terminal beweisbarer
   `not_created`-/pending-child-Zustand ohne synthetische Exchange-ID;
3. vollständige Current-/History-Unterbereiche mit Retention, Cursor,
   dichten Zeitstempeln und persistierter Coverage;
4. exakte Originalgeldereignisse in USD/USDT/USDC mit dauerhafter ID,
   Originaldezimalen, Fee-/Funding-/PnL-Entdopplung und ohne Paritätsannahme;
5. gelesener Account-/Broker-/Subaccount-, Cross-/One-way- und
   größenabhängiger Marginbeweis.

Bis dahin kein Profil, keine Attestation, kein Receipt-Pin und keine Freigabe.
