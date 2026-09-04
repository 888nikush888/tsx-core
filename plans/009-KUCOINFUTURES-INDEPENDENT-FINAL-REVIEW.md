# 009 – KuCoinFutures unabhängige Schlussprüfung

**Eingefroren:** 2026-09-04  
**Urteil:** `not_easy`. Das bisherige `eligible`-Votum in `009-CANDIDATE-GROUP-B.md` ist durch die belegten Restgrenzen nicht haltbar. Identität und Current-State sind mit kleinen Raw-Adaptern abbildbar; Cross-Kapazität passt nicht in den vorhandenen Tiervertrag und eine vollständige accountweite Funding-Finalität ist mangels historisch vollständigem Symboluniversum nicht belegbar.

Diese Prüfung war offline/read-only gegenüber Börsenkonten: keine Credentials, Providerrequests oder Orders. Geprüft wurden die installierten CCXT-4.5.75-Dateien und offizielle KuCoin-Classic-Primärquellen.

## Gepinnte CCXT-Bytes

| Datei | SHA-256 |
|---|---|
| `ccxt/async_support/kucoin.py` | `26d6c99e03a4a0c7a050df62aa668896abce5fe2de3787f2be7c43b4ccbcdd9f` |
| `ccxt/async_support/kucoinfutures.py` | `a380fd2a4b038c23ac3ebf69c282fa6287c13cd0b82a681f850da09901bfecd3` |
| `ccxt/pro/kucoin.py` | `9e5d3ee27d5daa15168deb5215435755813a3ae70e1c2a7174525cff2d23111d` |
| `ccxt/pro/kucoinfutures.py` | `2f1a04ed8e112698eb06bcf99c5d03aa6666169df9ef3a1ba0d3e88a9c1eec20` |

`kucoinfutures` erbt die Classic-Implementierung von `kucoin`; die folgenden Raw-Methoden sind deshalb die relevanten Pinpunkte.

## Vier harte Restpunkte

### 1. Kanonische Accountidentität – **implementierbar**

- Offiziell: `GET https://api.kucoin.com/api/v1/user/api-key` ([Get Apikey Info](https://www.kucoin.com/docs-new/rest/account-info/account-funding/get-apikey-info)). Der aufrufende Master- oder Subaccount-Key liefert `uid`, `isMaster`, `permission`, `apiVersion`, `region` und `siteType`.
- CCXT-Pin: `privateGetUserApiKey({})`; der Endpoint ist in `async_support/kucoin.py` als `private GET user/api-key` registriert und wird normal durch `sign()` gebunden.
- Kleiner Adapter: nur Rohumschlag `code == "200000"` akzeptieren; `providerAccountId = siteType + ":" + uid` an denselben Credential-Fingerprint und dieselbe Credential-Generation binden; mindestens `General,Futures` verlangen. `apiKey` und `remark` nie persistieren oder ausgeben. UID aus UI oder API-Key-Fingerprint ist kein Ersatz.
- Grenze: UID kann als JSON-Zahl oder String erscheinen; sie muss verlustfrei als Dezimalstring erfasst werden. Ein float-decodierter Wert ist abzulehnen.

### 2. Accountweiter normaler + Stop-Current-State – **implementierbar, aber nicht atomar**

- Normale aktive Orders: `GET https://api-futures.kucoin.com/api/v1/orders?status=active&currentPage=N&pageSize=S` ([Get Order List](https://www.kucoin.com/docs-new/rest/futures-trading/orders/get-order-list)); `symbol`, `side` und `type` bleiben bewusst weg. CCXT-Pin: `futuresPrivateGetOrders`.
- Ungetriggerte Stops: `GET https://api-futures.kucoin.com/api/v1/stopOrders?currentPage=N&pageSize=S` ([Get Stop Order List](https://www.kucoin.com/docs-new/rest/futures-trading/orders/get-stop-order-list)); ebenfalls ohne Symbol-/Side-/Typefilter. Getriggerte Stops gehen laut Dokumentation in den normalen Orderbereich über. CCXT-Pin: `futuresPrivateGetStopOrders`.
- Positionsscope: `GET /api/v1/positions` ohne Currencyfilter, CCXT-Pin `futuresPrivateGetPositions`.
- Cursorgrenze: beide Orderantworten liefern `currentPage`, `pageSize`, `totalNum`, `totalPage`, `items`; dokumentiertes Default 50, Maximum 1000. Ein kleiner Adapter kann mit festem kleineren `pageSize`, exakt monotonem `currentPage`, stabilen Totalwerten sowie Duplicate-/Zählerprüfung vollständig traversieren. CCXTs `fetch_contract_orders_by_status()` ist ungeeignet, weil es jeweils nur einen Bereich liest und das Page-Envelope verwirft.
- Grenze: Page-Pagination ist kein atomarer Börsensnapshot. Total-/Duplicate-/Page-Drift muss den Read fail-closed machen; das Ergebnis darf nur als vollständig traversierter sequentieller Read, nie als simultaner Snapshot, bezeichnet werden. Unauflösbare oder delistete Native-Symbole dürfen nicht weggefiltert werden.

### 3. Cross-Risk / Max-Open-Size als Plan-Kapazitätsbeleg – **not_easy**

- `GET /api/v2/getMaxOpenSize?symbol&price&leverage` ([Get Max Open Size](https://www.kucoin.com/docs-new/rest/futures-trading/positions/get-max-open-size)) liefert nur `symbol`, `maxBuyOpenSize`, `maxSellOpenSize`. CCXT-Pin: `futuresPrivateGetGetMaxOpenSize`.
- `GET /api/v2/batchGetCrossOrderLimit?symbol&totalMargin&leverage` ([Get Cross Margin Risk Limit](https://www.kucoin.com/docs-new/rest/futures-trading/positions/get-cross-margin-risk-limit)) liefert eine glatte Cross-Kurve mit `maxOpenSize`, `maxOpenValue`, `totalMargin`, `price`, `leverage`, `imr`, `mmr`, `currency`. CCXT 4.5.75 generiert dafür **keine** Raw-Methode; lokal belegt ist nur `request("batchGetCrossOrderLimit", "futuresPrivate", "GET", {..., "version":"v2"})`, das korrekt `/api/v2/batchGetCrossOrderLimit` signiert.
- Providergrenze: Max-Open-Size echot weder Requestpreis noch Hebel; Cross-Risk ist ein hypothetischer Quote für übergebenes `totalMargin`/`leverage` und dokumentiert nicht, dass aktuelle freie Kontomargin, alle offenen Reservations und der konkrete TSX-Plan gemeinsam eingefroren sind. Beide Antworten haben weder Snapshot-/Quote-ID noch Ablauf-/Cursorbeleg.
- Architekturgrenze: TSX akzeptiert derzeit ausschließlich `TradingLeverageTierEvidence`/`tier_table_v1` mit vollständiger diskreter Tierkurve. KuCoin dokumentiert ausdrücklich eine glatte Cross-Kurve. Ein einzelner sidespezifischer Kapazitätsquote darf nicht als Fantasietier ausgegeben werden. Erforderlich wäre ein neuer diskriminierter, account-/credential-/symbol-/side-/price-/quantity-/leverage-/margin-/requesthash-/TTL-gebundener Capacity-Quote-Vertrag samt Node-/Python-Prüfung und Race-Tests. Das ist keine kleine Provideradapter-Ergänzung.

### 4. Fill-/Funding-Finalität einschließlich delisteter Symbole – **not_easy**

- Fills: `GET /api/v1/fills` ohne Symbolfilter, mit expliziten höchstens sieben Tage breiten `startAt/endAt`-Fenstern und `currentPage/pageSize`; CCXT-Pin `futuresPrivateGetFills`. Der Endpoint ist accountweit und paginiert, hält Daten aber nur drei Monate und ist ausdrücklich nicht Echtzeit. `GET /api/v1/recentFills` (`futuresPrivateGetRecentFills`) liefert nur die letzten bis zu 1000 Fills in 24 Stunden. Ein belastbarer Reader muss beide Quellen über echte `tradeId`/`orderId`/Economics überlappen und bei fehlendem Anchor oder gesättigten 1000 Recent-Fills `unknown` bleiben.
- Funding: `GET /api/v1/funding-history` ([Get Private Funding History](https://www.kucoin.com/docs-new/rest/futures-trading/funding-fees/get-private-funding-history)) verlangt laut offiziellem [KuCoin Futures Endpointinventar](https://github.com/Kucoin/kucoin-skills-hub/blob/main/skills/futures-trading/SKILL.md) `symbol`; Retention sechs Monate, maximal drei Monate pro Zeitfenster, Fortsetzung über `hasMore`, während offsetbasierte Pagination laut KuCoin ungenau/dupliziert sein kann. CCXT-Pin `futuresPrivateGetFundingHistory`; `fetch_funding_history()` verlangt im Classic-Pfad ein Symbol, verliert `hasMore` und wandelt die originale ID über `safe_number` (Präzisionsverlust > 2^53).
- Symbolgrenze: `/api/v1/contracts/active` liefert ausdrücklich nur aktuell handelbare Contracts. Es gibt keinen belegten Classic-Endpoint für die vollständige historische/delistete Symbolmenge eines Accounts. Accountweite Fills reichen nur drei Monate zurück; Funding reicht sechs Monate. Damit können vor der Fill-Retention geschlossene Positionen auf inzwischen delisteten Symbolen Funding im noch sichtbaren Fundingfenster erzeugt haben, ohne dass der notwendige Symbolscan bekannt ist.
- Folge: Per-Symbol-Funding kann lossless und fail-closed beobachtet werden, accountweite Funding-Finalität aber nicht. Futures-Ledgerdaten sind keine belegte 1:1-Quelle jedes Fundingevents mit derselben nativen Funding-ID. Der bestehende KuCoin-Reader bezeichnet seine Coverage deshalb korrekt als `unknown/provider_retention_limit`; diese Grenze darf nicht zu `complete` gelockert werden.

## Schlussfolgerung

Punkte 1 und 2 rechtfertigen enge Raw-Providerhelper. Punkte 3 und 4 sind harte Architektur-/Quellabdeckungsgrenzen. Deshalb ist `kucoinfutures` für Phase 009 **nicht `eligible/easy`**, sondern `not_easy`; keine Profil-, Receipt-, Approval-, Matrix- oder Releasefreigabe darf aus dieser Prüfung abgeleitet werden.
