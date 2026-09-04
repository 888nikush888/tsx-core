# 009 – Grenzen des unveränderten CCXT-Pins

Stand: 2026-09-03; ausschließlich lokale CCXT-4.5.75-Inventur und gelesener TSX-Vertrag. Keine Behauptung über eine generelle Unfähigkeit der jeweiligen Börsen-API, keine rechtliche/geografische Bewertung und kein realer Providerabruf.

## Verbindliche technische Grenze

`exchange_executor/ccxt_capabilities.py` verlangt native REST-Unterstützung für Balance, Positionen, offene Orders, Fills, Submit, Cancel und Leverage sowie native Pro-Unterstützung für Orders, Fills und Positionen. `capability_flags` akzeptiert exakt `True`, nicht `emulated`, `None` oder `False`. `ccxt_registry.py::_initial_status` verweigert Kandidaten, sobald eine dieser Pflichtfähigkeiten fehlt. Paket 009 verlangt ausdrücklich, diesen bestehenden Sicherheitsvorfilter und CCXT 4.5.75 beizubehalten.

Die folgende Ausgrenzung gilt daher für **diesen Pin und diesen unveränderten TSX-Vertrag**, nicht für alle künftigen Versionen. Ein neues Profil, Credentialfeld oder kleiner Parameteradapter kann einen fehlenden nativen CCXT-/Pro-Vertrag nicht hinzufügen. Das künstliche Umdeklarieren von `has`, eigener Ersatzstream oder ein nicht beauftragtes SDK-Update ist keine erlaubte Abkürzung. Bei neuer CCXT-Version neu inventarisieren; heute weder als ausführbar noch als lokal verifiziert deklarieren.

Die reproduzierbaren Belege stehen je Identifier unter `inventory.exchanges[].blockers`, `rest/pro.has`, `states`, `methods`, `classEvidence` und im nach tatsächlichen Dateibytes gehashten Sourceindex von `docs/testing/ccxt-expansion-matrix.json`. Die aufgelisteten Werte wurden direkt aus dieser neu gebauten Inventur gelesen. Sie beweisen einen harten **Vorfilterausschluss**, nicht Entry-/Stop- oder Buchhaltungsparität. Die übrigen Anbieter erhalten eine separate semantische Prüfung, nicht dieselbe pauschale Begründung.

## Individuelle fehlende Pflichtfähigkeiten

`P` = Pro; alle anderen Namen REST. `fehlt` umfasst SDK-False/None, deren Originalwert im Manifest erhalten bleibt. Ein ausdrücklich emulierter Aufruf ist markiert.

| CCXT-ID | Fehlende native Pflichtfähigkeiten |
| --- | --- |
| backpack | setLeverage; P.watchMyTrades |
| bequant | P.watchMyTrades; P.watchPositions |
| bigone | fetchPositions; setLeverage; P.watchOrders; P.watchMyTrades; P.watchPositions |
| bitbns | fetchPositions; setLeverage; P.watchOrders; P.watchMyTrades; P.watchPositions |
| bitfinex | setLeverage; P.watchPositions |
| bitflyer | fetchOpenOrders **emulated**; setLeverage; P.watchOrders; P.watchMyTrades; P.watchPositions |
| bitrue | fetchPositions; P.watchMyTrades; P.watchPositions |
| bitstamp | fetchPositions; setLeverage; P.watchMyTrades; P.watchPositions |
| blofin | P.watchMyTrades |
| btse | P.watchOrders; P.watchMyTrades; P.watchPositions |
| bullish | setLeverage |
| bydfi | cancelOrder; P.watchMyTrades |
| coinbase | setLeverage; P.watchMyTrades; P.watchPositions |
| coinbaseinternational | setLeverage; P.watchOrders; P.watchMyTrades; P.watchPositions |
| coinex | P.watchPositions |
| cryptocom | setLeverage |
| delta | P.watchOrders; P.watchMyTrades; P.watchPositions |
| deribit | setLeverage; P.watchPositions |
| derive | setLeverage; P.watchPositions |
| digifinex | P.watchOrders; P.watchMyTrades; P.watchPositions |
| dydx | fetchMyTrades; setLeverage; P.watchOrders; P.watchMyTrades; P.watchPositions |
| fmfwio | P.watchOrders; P.watchMyTrades; P.watchPositions |
| foxbit | fetchPositions; setLeverage; P.watchOrders; P.watchMyTrades; P.watchPositions |
| gemini | fetchPositions; setLeverage; P.watchMyTrades; P.watchPositions |
| hashkey | P.watchPositions |
| hibachi | setLeverage; P.watchOrders; P.watchMyTrades; P.watchPositions |
| hitbtc | P.watchMyTrades; P.watchPositions |
| htx | P.watchPositions |
| lbank | fetchPositions; setLeverage; P.watchMyTrades; P.watchPositions |
| lighter | P.watchPositions |
| mexc | P.watchPositions |
| mudrex | P.watchOrders; P.watchMyTrades; P.watchPositions |
| nado | setLeverage |
| onetrading | fetchPositions; setLeverage; P.watchPositions |
| pacifica | P.watchPositions |
| paradex | P.watchMyTrades; P.watchPositions |
| phemex | P.watchPositions |
| poloniex | P.watchPositions |
| toobit | P.watchPositions |
| whitebit | P.watchPositions |
| zebpay | P.watchOrders; P.watchMyTrades; P.watchPositions |

Alle 41 Identifier sind für diesen Auftrag technisch `not_easy`, solange Pin und Pflichtfähigkeiten unverändert bleiben. Bei `bequant`, `bitbns`, `bitflyer`, `foxbit`, `lbank` ist zudem ein Teil der Produktdeklaration unbekannt; das wird **nicht** zu einer erfundenen Spot-only-Aussage. Unabhängig davon ist bereits der konkret genannte verpflichtende native Vertrag nicht erfüllt. Keine Aussage über ungetestete alternative Produkt-/Regionalendpunkte.

## Gesondert offene Produktdeklarationen

`bybiteu` und `gateeu` passieren die geerbten Fähigkeitsflags, deklarieren aber jeweils `swap=False`, `future=False`, `option=None`. Sie dürfen nicht allein wegen der gemeinsamen Marke oder geerbter Methoden als globale Futures-Profile freigeschaltet werden. Diese beiden benötigen noch eine direkte Prüfung ihrer geladenen Markt-/Host-/Produktfilter. Unbekannte Optionsunterstützung ist weder Perp-Unterstützung noch Beleg für Spot-only. Bis dahin `pending`, nicht mit den 41 Vorfilterausschlüssen vermischen.
