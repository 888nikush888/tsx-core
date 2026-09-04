# 005-Folgeplan: belegte Fremdwährungsbewertungen und vollständige Einheitenbindung

> **Aktualisierte Freigabe vom 2. September 2026:** Auf die konkrete Frage nach höchstens zehn Sekunden altem, vor der Buchung belegtem Kurs antwortete der Nutzer: „wie du meinst. einfach alles in usd usdt usdc halten“. Der Root setzt entsprechend die unten festgehaltene begrenzte Methode um. Die danach folgenden bisherigen Entwurfsabschnitte beschreiben den historischen Stand vor dieser Entscheidung. Kraken-Spot/Crossvenue und weitere Bewertungsassets bleiben ausdrücklich ausgeschlossen.
>
> **Executor:** Vor späterer Arbeit dieses Dokument und `plans/005-money-risk-ledger.md` vollständig lesen. Zuerst die offenen Entscheidungen und die konkrete API-/Dateifreigabe mit dem Hauptagenten klären. Dieser Plan reserviert keine Migrationnummer. Der Hauptagent besitzt `plans/README.md` und den gemeinsamen Implementierungsstatus; hier keine gemeinsame Statusänderung veranlassen.

## Aktuelle Entscheidung und Implementierungsgrenze

Fortschritt am 3. September: M43-Originale, M44-dauerhaftes Scheduling, M45-exakte Eventbewertungen und M46-adaptive Quellenbelege sind lokal implementiert und fokussiert geprüft. Sizing-/Reserve-/Tierumrechnung, automatische Bewertung aus gespeicherten Originalen sowie Reporting-/Adaptive-Kette einschließlich Oberfläche sind angeschlossen. Adaptive Entscheidungen vergleichen exakte Geldwerte; nachträgliche Quellenkonflikte invalidieren bestehende Freigaben, ohne alte Bewertungen umzuschreiben. Die vollständigen gemeinsamen Prüfgates stehen noch aus. Die darunter genannten Reservierungs-/reiner-Producer-Grenzen sind der frühere Arbeitsstand; keine zusätzliche externe Befugnis entstand dadurch. Maßgebliche aktuelle Ergebnisse: `IMPLEMENTATION-STATUS.md`.

- D1: `bounded-as-of`, geeignete Beobachtung vor oder am Geldereignis, höchstens 10.000 ms alt; spätere aktuelle Kurse dürfen nicht rückdatiert werden. Aktuelle Sizing-/Reservekurse erhalten dieselbe eigene Frischegrenze, unabhängig von historischen Bewertungen.
- Assets dieser Erweiterung: ausschließlich USD, USDT und USDC. Keine Stablecoin-Parität, kein automatischer Wechsel der bestehenden Konto-/Reportingwährung. Andere Assets bleiben unverändert erhalten und ohne separaten Beleg ungeklärt; bestehende historische Paperbelege werden nicht gelöscht oder umgeschrieben.
- D2: Bybit-REST-Indexdaten dürfen ausdrücklich als `provider_snapshot_observation` genutzt werden. Die originale Provider-Envelopezeit bleibt `providerResponseAt`, `providerQuoteAt` bleibt mangels dokumentierter Tickzeit null; lokale Readzeiten werden getrennt erfasst. Für die beiden USDT/USD-Indexlegs gilt maximal 1.000 ms Abstand. Diese Methode behauptet weder ursprüngliche Tickzeit noch Atomizität.
- D3: Exakte begrenzte Zähler-/Nennerarithmetik aus Original-Dezimalstrings, ohne Geldwerte über Float zu führen. Rates werden nicht als gerundete Dezimalzahl ausgegeben. Bei begrenzter Ausgabe werden untere/obere Dezimalgrenze und Exaktheitsstatus ausdrücklich erhalten; finale Exchange-Quantisierung erfolgt aus der exakten Zahl. Die lokale Ledger-/Summen-/Consumerintegration einschließlich M45/M46 ist inzwischen angeschlossen und getestet. Dies ist kein Beleg für passende Kurse zu jedem historischen Ereignis oder für eine reale Providerabnahme.
- D4 bleibt ausgeschlossen: kein Kraken-Spot-, Crossvenue- oder beliebiger Tickerfallback. Feste neue Bybit-Quellen: BTCUSD/BTCUSDT-Indizes für USDT→USD und USDCUSDT-`usdIndexPrice` für USDC→USD. Keine zusätzlichen Gebührenassets.
- Root besitzt Node-Vertrag, Rationalrechnung, Persistenz/Consumer und nötige Datenbankmigration. M43–M46 sowie die abgestimmten Adapter-/Schedulinghooks sind lokal angelegt und integriert; nicht nochmals als offene Reservierung behandeln. Alle Reads bleiben im bestehenden gemeinsamen Budget. Keine neue Netzwerk-/Konto-/Trade-/Commit-/Releasebefugnis.
- Einzelne erfolgreiche Quotelegs werden auch bei späterem Fehler erhalten. Unvollständige oder zeitlich unpassende Paare berechtigen nicht zur Bewertung. Historie, Quote-Frische, Accountbindung und Geldbewertung bleiben getrennte Beweise.

Die ursprünglich roten Rationaltests sind inzwischen grün und Bestandteil der registrierten Gesamtläufe. Offen bleiben die in `IMPLEMENTATION-STATUS.md` konkret genannten Provider-/Scopegrenzen und die abschließende 008-Abnahme; frühere Entwurfszustände darunter sind keine neuen Implementierungsaufträge.

## Status, Kontext und Drift

- Priorität P1/P2; Aufwand L; finanzielles Änderungsrisiko hoch.
- Status: **Recherche dokumentiert; zeitliche Policy, Zahlenvertrag und Implementation offen.** Keine fertige Live-FX-Bewertung, keine Providerabnahme und keine Freigabe für echte Konten behaupten.
- Geplant am 2. September 2026 gegen HEAD `f8089277d0667dd45bcf070037800d423fd89254` in `C:/Users/nikla/Desktop/tsx-core`.
- Wesentliche Vorgängerstufen liegen im gemeinsam bearbeiteten, nicht committeten Worktree. Ein unveränderter HEAD beweist daher keine unveränderten Schnittstellen.
- Abhängigkeiten: ursprünglicher Plan 005; Identität/Fills aus 001/002; Schutz-/Entry-Lifecycle aus 003; endgültiger IOC-/Tier-/Sizing-Vertrag aus 004. Die bisherige Ledger-/Funding-Arbeit ist in `plans/005-IMPLEMENTATION-NOTES.md` und `plans/005-FUNDING-COVERAGE-NOTES.md` dokumentiert.
- Bereits vorhandene Komponenten: immutable Geldereignisse/Bewertungen, eigene Fill-/Fee-/Teil-PnL-Projektionen, aktuelle Risikoreserven, dauerhafte Account-Logs und getrennte beobachtete Funding-Coverage. Deren Sicherheit darf nicht durch pauschales Freigeben von Fremdwährungen ersetzt werden.

Vor späteren Änderungen lesen:

```powershell
git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src exchange_executor tests docs plans
git diff --stat -- src exchange_executor tests docs plans
git status --short
```

Anschließend die unten genannten Symbole im aktuellen Worktree prüfen. Unbekannte Änderungen nicht rücksetzen. Die jetzige Beauftragung erlaubt nur diese neue Plandatei; die folgenden Source-Scope- und Umsetzungsschritte sind **Kandidaten für eine spätere separate Freigabe**.

## Warum diese Stufe erforderlich ist

USD, USDT und USDC sind unterschiedliche Einheiten. Die aktuelle native Bewertung funktioniert nur bei tatsächlich gleicher Original- und Reportingwährung oder belegtem Nullbetrag. Eine nicht bewertete Fremdassetgebühr bleibt unbekannt; sie darf weder als Nullbetrag noch durch angenommene Parität in den Tagesverlust eingehen.

Ein richtiger historischer Ledger allein reicht nicht: Bybit liefert Account-Equity/Available in USD, während lineare Marktpreise, Stopabstände und Tiergrenzen beispielsweise in USDT liegen. Sizing und Reserven müssen dieselbe Einheitenbindung durchhalten, bevor ein solcher Entry zugelassen werden kann. Kapital-/Marginprozente, Hebelgrenzen, Signalpreise und Stopregeln bleiben unverändert.

## Offene Entscheidungen: vor Code auflösen

| Entscheidung | Gegenwärtiger Stand | Unzulässige Vorwegnahme |
|---|---|---|
| D1: Zeitliche Bewertungsmethode | Originalplan verlangt Bewertung zum Buchungszeitpunkt. Nutzerentscheidung zu höchstens 10 Sekunden altem `bounded-as-of` vor Event ausstehend. | `observedAt = eventTime` aus einem anderszeitigen Kurs erzeugen; 10 Sekunden bereits als erlaubt behandeln. |
| D2: Belegzeit und Cross-Leg-Synchronität | Vorgeschlagen: getrennte echte Quotezeit, Provider-Antwortzeit und lokale Readzeiten; höchstens 1 Sekunde Leg-Versatz. Dies sind Policyvorschläge, keine Providergarantien. | Antwortzeit als dokumentierte Tick-Entstehungszeit ausgeben; zwei unabhängige Requests als atomaren Snapshot bezeichnen. |
| D3: Rational-/Rundungsvertrag | Konkrete API, Speicherform, Aggregation, Präzisionsgrenzen und Rundung noch separat freizugeben. | Bestehendes 18-stelliges `divideDecimal` als exakten Originalkurs deklarieren; ungefragt Ledger-/Consumerformate umbauen. |
| D4: Historische Zusatzquellen | Kraken Spot/Cross-Venue und eine eigene Candle-Bewertungsmethode nicht freigegeben. | Neue öffentliche Clients, Quellenfallbacks oder gröbere Altbestandsbewertung automatisch einschalten. |
| D5: Reportingbindung | Bestehende verifizierte Kontobindung bleibt maßgeblich. Bybit meldet USD, aktueller erster Hyperliquid-Perp-DEX USDC. | Hyperliquid-USDC in USD umbenennen oder bestehende Bewertungen auf neue Währungen umschreiben. |

Falls D1 abgelehnt oder nicht entschieden ist, bleiben fehlende Ereigniszeit-Belege unresolved. Sichere Native-Asset-Fälle bleiben funktionsfähig; eine globale Dauerabschaltung ersetzt weder die spätere Integration noch die Erklärung einzelner fehlender Belege.

## Aktueller lokaler Code und Konventionen

Die folgenden Ausschnitte wurden direkt im Worktree gelesen; Zeilennummern sind Orientierung, Symbole vor jeder Umsetzung neu finden.

`src/trading_money_ledger.ts:37,121,197` enthält den bisherigen Paper-Vertrag und genau eine unveränderliche Bewertung pro Event:

```ts
export interface EventTimeValuation {
  eventId: string;
  route: string;
  baseAsset: string;
  quoteAsset: string;
  rate: string;
  observedAt: number;
  evidenceId: string;
}
```

```ts
if (quote.observedAt !== event.occurredAt) throw new Error('Valuation must be evidenced at the monetary event time.');
```

Nur `paper:event-time-rate:v1` mit fester Paarliste ist freigegeben. `appendValuation` multipliziert exakt; widersprüchliche Events/Bewertungen werden dauerhaft als Konflikt behalten, nicht überschrieben. Diese Beschränkung ist beabsichtigt und darf nicht isoliert entfernt werden.

Weitere Anschlussstellen:

- `src/trading_decimal.ts`: String-Dezimalarithmetik mit BigInt; `divideDecimal` schneidet auf höchstens 18 Nachkommastellen ab. `multiplyExactSignedDecimal` und `allocateDecimalExact` verweigern nicht exakt darstellbare Ergebnisse. Keine Number-/Float-Geldarithmetik ergänzen.
- `src/trading_risk_reservations.ts:44`: `provedReservation` verlangt gegenwärtig `market.settlementAsset === input.reportingCurrency`. Der Fehler `Risk settlement conversion is unproven.` ist die korrekte aktuelle Fail-closed-Grenze.
- `src/trading_risk.ts:213,239,266`: `positionQuantity`, `equityPercentPositionQuantity` und `equityPercentMarginQuantity` verrechnen derzeit Accountgrößen direkt mit Marktpreisen. Eine USD-/USDT-Freigabe erfordert hier eine ausdrückliche Einheitenumrechnung, nicht nur einen FX-Kurs im Ledger.
- `src/trading_risk_sources.ts`, `trading_risk_repository.ts`, `trading_risk_admission.ts`: Ownership-/Stop-/Markquellen, persistierte Reservebeobachtung, Ledger-Hash und finaler synchroner Frischefence. Bestehende Coordinator-/Epoch-/Identitätsprüfungen erhalten.
- `src/ccxt_exchange.ts:228,319` und `exchange_executor/ccxt_adapter.py:441,470,818`: bestehende Account-, Markt- und Open-State-Anschlüsse. Keine zusätzlichen versteckten Requests im Node-Validator oder unter einem SQLite-Lock.
- `exchange_executor/leverage_tier_evidence.py`: vorhandener roher Bybit-Tickerread für `category=linear`; der Zweck ist heute Mark-/Tierbeweis, nicht FX-Historie.
- `exchange_executor/stream_hub.py`: vorhandener CCXT-Pro-Transport, aber aktive Derivatesymbole, begrenzter In-Memory-Puffer und Empfangszeit-Fallback. Kein dauerhafter, lückenloser FX-Quote-Speicher.
- `exchange_executor/history_reader.py`: `RecoveryReadBudget` startet mit höchstens fünf Reads und teilt Deadline/Backoff. `ccxt_adapter.open_state` stellt den gemeinsamen Haushalt für History, gezielte Recovery, Mode und Account-Log bereit.
- `exchange_executor/account_log_sources.py`: Kraken-Rohfelder `exchange_rate`, `exchange_rate_from`, `conversion_fee` sind bereits allowlisted; der aktuelle Request setzt `conversion_details` noch nicht. Eine Änderung des Requests braucht einen ehrlichen Quellen-/Filtervertrag und darf bestehende Originalreceipts nicht umschreiben.
- Testmuster: `tests/test_trading_money_ledger.js` benutzt `assert`, `mkdtemp`, eine ausdrücklich isolierte Test-DB, Replay und Restart. Neue Tests ebenso aufbauen und im kleinen Hunk in `tests/run_all.js` registrieren.

### Lokal ausgeführter, ausschließlich gefakter CCXT-Nachweis

Installiertes Paket: `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt`, `__version__ = 4.5.75`.

Ein In-Memory-Fake ersetzte `publicGetV5MarketTickers` und injizierte Marktmetadaten; es gab keinen echten Providerrequest. `fetch_ticker('USDC/USDT')` erzeugte exakt `category=spot, symbol=USDCUSDT`. Obwohl die Fake-REST-Antwort eine äußere `time` enthielt, war der normalisierte `timestamp` `None`; `info.usdIndexPrice` blieb der Originalstring `1.0003`.

Ursache im installierten `ccxt/bybit.py`: `fetch_ticker` übergibt nur die einzelne Listenzeile an `parse_ticker`; dieser liest `ticker.time`, nicht die äußere Antwortzeit. CCXT Pro übernimmt dagegen `message.ts` als normalisierten Timestamp, vereinigt Derivate-Deltas aber mit gecachten Werten. Originale Kategorie, Envelope, Sequenz und Feldherkunft dürfen in einem späteren FX-Beleg nicht verloren gehen.

Dieser Prüflauf ist kein implementierter FX-Vertrag und keine Providerabnahme. Die unten geplanten neuen Red-Tests existieren zum Zeitpunkt dieses Plans noch nicht.

## Primärquellen und zulässige Schlussfolgerungen

### Bybit: eigener USD-Anker, keine feste Stablecoin-Parität

Die [aktuelle UTA-FAQ](https://www.bybit.com/en/help-center/article/FAQ-Unified-Trading-Account) definiert den USDT-Umrechnungsfaktor als `BTCUSD Index Price / BTCUSDT Index Price`. Die USD-Bewertung weiterer Assets verwendet den entsprechenden USDT-Index und diesen Faktor; bei fehlendem USDT-Perp-Index nennt der Anbieter einen Spotpreis als Referenz. Das ist eine dokumentierte Indexbewertung, kein tatsächlicher Kassatausch und keine Erlaubnis, beliebige Perp-Markpreise zu dividieren.

Der [REST-Tickervertrag](https://bybit-exchange.github.io/docs/v5/market/tickers) dokumentiert für `category=spot` das Feld `usdIndexPrice` als USD-Index für die UTA-Assetbewertung. Es ist für passende XXX/USDT- oder XXX/USDC-Instrumente vorgesehen; nicht unterstützte Collateral-Coins können einen leeren Wert liefern. Es bewertet das **Basisasset in USD**, nicht die Quotewährung. Die tatsächliche Preislieferung muss jeweils im gültigen Originalresponse belegt sein.

Der [WebSocket-Tickervertrag](https://bybit-exchange.github.io/docs/v5/websocket/public/ticker) dokumentiert `ts` als Zeitpunkt der Datenerzeugung. Spot-Ticker sind Snapshots; Derivate können Deltas liefern. Diese Transportzeiten und Vollständigkeitsregeln nicht durch lokale Empfangszeit oder einen ungeprüften CCXT-Cache ersetzen.

Der [Walletvertrag](https://bybit-exchange.github.io/docs/v5/account/wallet-balance) weist Equity, Available, Initial Margin und Perp-UPL in USD aus. Available in Coin-Einheiten muss ausdrücklich über den Index umgerechnet werden. `coin.usdValue / walletBalance` ist ohne bewiesenen Nenner-/UPL-/Borrow-/Rundungsvertrag kein Ersatz-FX-Kurs; Collateral-Haircuts sind Risikodiscounts, keine Wechselkurse.

### Historische Grenzen

[Bybit Index-Klines](https://bybit-exchange.github.io/docs/v5/market/index-kline) liefern Intervallwerte mit Startzeit und OHLC. Die laufende Candle hat keinen endgültigen Schlusswert. Der installierte CCXT-Wrapper rundet einen mitten im Intervall liegenden `since` auf die nächste Grenze auf. Weder zukünftiger Bucket noch späterer Schlusswert dürfen als vorheriger Eventkurs verwendet werden. Eine bereits abgeschlossene Minute ist trotzdem keine exakte Millisekundenbeobachtung; eine solche gröbere Methode benötigt eigene Freigabe und Kennzeichnung.

[Bybit Recent Trades](https://bybit-exchange.github.io/docs/v5/market/recent-trade) liefern Originalpreise und Tradezeiten, bei Spot aber nur einen begrenzten jüngsten Ausschnitt. Daraus folgt kein beliebig rückladbarer oder vollständiger historischer USD-Index. Ein Spot-Trade in USDT liefert außerdem noch keinen USD-Anker.

### Kraken und Hyperliquid: Kandidaten, keine stillen Fallbacks

[Kraken Account Log](https://docs.kraken.com/api-reference/account-history/get-account-log) dokumentiert `conversion_details=true` für zusätzliche Wechselkurs-/Conversionfee-Felder. Verwendbar wären nur ausdrücklich zugeordnete tatsächliche Conversionbelege mit geklärter Richtung, Asset, Eventzeit, Cash-Leg und Gebührenbehandlung. Die derzeit recherchierten Primärangaben belegen diese vollständige Zuordnung noch nicht. Keine Kursableitung aus bloßen Balance-Differenzen und keine Schätzung einer fehlenden Fee-Währung.

Kraken Futures liefert bereits [Ticker/Indexinformationen](https://docs.kraken.com/api-reference/market-data/get-tickers); CCXT erkennt originale Instrumente vom Typ `spot index`. Konkrete Stablecoin-Index-IDs sind damit nicht automatisch belegt. Nicht `rr_usdtusd` oder andere Namen erfinden. Die [Derivatehistorie](https://docs.kraken.com/api/docs/futures-api/trading/get-history) ist zeitlich begrenzt und beschreibt real-time Indexhistorie teilweise als stündlich aggregiert. Sie ist kein allgemeiner Eventzeit-Fallback.

Kraken [dokumentiert](https://support.kraken.com/articles/360029077772-python-code-to-retrieve-historical-time-and-sales-trading-history-?mode=consumerapp) die vollständige Spot-Tradehistorie über den [Trades-Endpunkt](https://docs.kraken.com/api-reference/market-data/get-recent-trades), einschließlich Originalpreis, Zeit und Fortsetzung. Das wäre eine separat zu spezifizierende öffentliche Cross-Venuequelle. Sie ist **nicht freigegeben**, gehört nicht zur jetzigen Bybit-Integration und darf nicht mit Kraken-Futures-Credentials oder einem neuen stillen Client aktiviert werden.

Hyperliquids [Mark-/Oracle-Definitionen](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/robust-price-indices) betreffen Derivatepreise und Funding. Daraus folgt kein allgemeiner USDC/USD-Konversionsbeleg. Den bestehenden nativen USDC-Vertrag des ersten Perp-DEX erhalten; HIP-3-/Token-Identitäten nicht allein aufgrund gleichnamiger Felder oder Tickersymbole gleichsetzen.

## Vorgeschlagene feste Bewertungsrouten

Diese Namen und Datentypen sind Entwurfsnamen, keine bereits genehmigte API.

| Entwurfsroute | Originalquellen | Einheit / Grenze |
|---|---|---|
| `bybit:usdt-usd-index-ratio:v1` | Bybit `category=inverse,symbol=BTCUSD,indexPrice` und `category=linear,symbol=BTCUSDT,indexPrice` | USD je USDT; beide Legs vollständig und zeitlich gebunden. Inverse Instrumente werden nur als dokumentierte Indexdatenquelle gelesen, nicht für inverse Trades freigeschaltet. |
| `bybit:usdc-usd-index:v1` | Bybit `category=spot,symbol=USDCUSDT,usdIndexPrice` | USD je USDC; kein Rückschluss aus `lastPrice` allein. |
| `bybit:fee-asset-usd-index:v1` | Feste noch freizugebende Asset-/Spotinstrument-Liste, jeweils `usdIndexPrice` | USD je eindeutigem Original-Fee-Asset. Kandidatenliste und Metadatenprüfung vor Code festlegen; keine dynamische beliebige Tickersuche. |
| Native Asset / echter Nullbetrag | Bestehende verifizierte Reportingbindung | Unverändert. Null benötigt keine erfundene Fremdassetbewertung; Nichtnull ohne Asset bleibt unknown. |

Für Gegenrichtung oder Cross-Raten nicht eine zweite unabhängige Paritätsregel ergänzen: dieselben belegten Legs mit expliziter Division und dimensionaler Kontrolle verwenden. Beispiel `USD/USDT` invertieren ist nur mit bewiesenem nichtnulligem Nenner erlaubt. Mark, Last, Bid/Ask, Oracle und Index sind verschiedene Bewertungsgrundlagen; kein stiller `a or b or 1`-Fallback.

## Entwurf des Evidenzvertrags

### 1. Unveränderlicher Quote-Beleg: `FxQuoteEvidenceV1`

Mindestens zu spezifizieren:

- `quoteId`, Provider, ausdrücklich Live-/Testnet-Origin, Endpoint/Topic und feste `routeId`.
- `sourceVersion`, Profilversion/-hash, CCXT-Version und Metadatenhash.
- Originales Providerinstrument und Kategorie, Basis-/Quotewährung, verwendetes Originalfeld und Original-Dezimalstring.
- Tatsächliche `providerQuoteAt`, sofern vorhanden; davon getrennt `providerResponseAt`, lokale `startedAt`/`completedAt` und eine klare Zeitbasis wie `provider_generated`, `provider_snapshot_observation` oder `execution`.
- Originalreceipt-/Payloadhash, gegebenenfalls Sequenz und Snapshot-/Delta-/Kontinuitätsbeleg. Fehlende Quote-IDs nicht durch nackte Trade-IDs in einem gemeinsamen Namespace ersetzen.
- Bei Cross-Raten vollständige geordnete Leg-IDs und Operatoren; keine alleinstehende gerundete Rate ohne Herkunft.
- Konkreter Status/Fehler für fehlende, leere, stale, widersprüchliche oder unbewiesene Werte.

Öffentliche Quote-Identität ist Provider-/Origin-/Marktscope, nicht ein künstlicher eigener Fill. Kontobindung und Credentialgeneration beim Transport/Verbrauch zusätzlich prüfen. Gemeinsame Quote-Nutzung zwischen Konten nur nach ausdrücklich freigegebenem Cache-/Bindungsvertrag, nicht durch Vermischen privater Accountbelege.

### 2. Eventbewertung: `FxEventValuationV2`

- Referenz auf die bereits kanonische `MoneyEvent.id`, Original-Eventzeit, Kontofingerprint und ursprüngliche Ereignis-/Assetbindung.
- Verifizierte Reportingwährung; gegebenenfalls getrennte Policy-/Bindingversion, niemals bestehende Originale umschreiben.
- Gepinnte Bewertungsmethode und Routenversion, unveränderliche Quote-IDs sowie deterministische Auswahlregel einschließlich des betrachteten Quote-Datenstands.
- `valuationBasis`, etwa ausdrücklich `provider_index_asof` oder tatsächlich belegte `actual_conversion`; keine Behauptung, eine Indexbewertung sei ausgeführter Kassatausch.
- Exakter Rechenweg und rationaler Originalwert; konkret freigegebene Ausgabe-/Aggregationspräzision und Rundungsprovenienz.
- Bewertung, Quellscope, Traversierungsfortschritt und Finalität getrennt halten. Ein vollständig bewerteter Ledger oder Quote-EOF beweist keine vollständige Account-Fillhistorie und löst keinen negativen Write-/Cancel-Ausgang auf.

Mit dem 001/002-Agenten abgestimmt: Bewertung hängt an kanonischer Money-event.id. Für `basis=fill` darf die geplante echte persistierte `fillId + kind`-Zuordnung nicht wieder auf nackte Provider-IDs reduziert werden. Bestehende Funding-Legacyaliases und Original-JSON/IDs bleiben erhalten; FX besitzt eigene Belegnamespaces. Mehrdeutige Legacyzuordnung bleibt Konflikt.

## Zeit-/Frischevertrag und Altbestand

**Der folgende bounded-as-of-Abschnitt ist nur Vorschlag und bis D1/D2 nicht implementierbar.**

1. Höchstens zehn Sekunden alte geeignete Beobachtung vor oder am Ereignis; niemals eine danach entstandene aktuelle Quote rückdatieren.
2. Für Cross-Raten vorgeschlagen höchstens eine Sekunde Unterschied der geeigneten Leg-Zeiten. Das belegt keine Börsenatomizität; Ableitung und Versatz sichtbar halten.
3. REST-Antwortzeit ist kein dokumentierter ursprünglicher Tickzeitpunkt. Falls eine Provider-Snapshotbeobachtung akzeptiert werden soll, muss genau diese schwächere Zeitbasis in D1/D2 genehmigt und im Ergebnis sichtbar sein. Antwort-, Abruf- und Eventzeit niemals zusammenziehen.
4. Historische Eignung gegen `event.occurredAt` prüfen. Eine heute nachgeladene tatsächlich alte Quote kann geeignet sein; ein heute erzeugter aktueller Ticker für dieselbe alte Buchung nicht.
5. Aktuelle Sizing-/Reservebewertung benötigt einen gesonderten frischen Kurs; vorgeschlagen sind ebenfalls höchstens zehn Sekunden Alter, noch unter D1/D2 zu bestätigen. Eine gültige historische Eventbewertung ist kein aktueller Entry-FX-Fence. Ablauf und Quellenstand unmittelbar vor Send nochmals synchron prüfen.
6. Originale UTC-Eventzeiten erhalten, auch bei verspäteter Lieferung, Kursnachtrag, UTC-Wechsel und Restart. Keine Verschiebung auf Empfangs-/Bewertungstag.
7. Quote-Historie vor möglichen Events dauerhaft aufbauen. Ein begrenzter Stream-Ring und ein neu gestarteter Prozess sind kein Historienbeleg. Quote-Retention an referenzierte Bewertungen, offene Arbeit und freigegebene Nachlieferungsfenster binden; erforderliche Belege nicht zur Einhaltung einer Speichergrenze löschen.
8. Legacy ohne belegtes Asset, geeigneten Kurs oder eindeutig zugehörige Conversion bleibt ausdrücklich unresolved. Bestehende Daten nicht mit heutigen Kursen oder Candle-Closes vervollständigen. Benötigte separate Aufklärung konkret benennen.

Neue passende Belege dürfen unbewertete Events auflösen. Bereits akzeptierte Bewertungen nicht bei jedem neuen aktuellen Quote neu berechnen. Neue Belege, echte Korrekturen und widersprüchliche Originale unterscheiden; eine spätere Revisions-API müsste Historie und Risiko-Invalidierung explizit erhalten. Der bestehende Konfliktmechanismus darf nicht durch stilles Überschreiben ersetzt werden.

## Rational-, Rundungs- und Einheitenvertrag

Die Rate `60000 / 60150` ist exakt `400 / 401`, keine endliche Dezimalzahl. Die Darstellung `0.997506234413965087` ist eine begrenzte Approximation. Ihr Anhängen an einen als exakt bezeichneten Beleg würde die Herkunft verfälschen.

Vor separater API-Freigabe müssen feststehen:

- Exakte Zähler-/Nennerdarstellung aus Original-Dezimalstrings, Normalisierung, Vorzeichen, Nenner > 0 und Größen-/Komplexitätsgrenzen.
- Deterministische Cross-Raten mit dimensionaler Prüfung und ohne Zwischenrundung.
- Ob genaue rationale Werte bis zur Aggregation geführt oder nachvollziehbare Rundungsintervalle benutzt werden; Umgang mit wachsender Nenner-/Datenmenge muss begrenzt sein.
- Explizite Reportingpräzision und Rundungsmodus, aufbewahrter exakter Rest beziehungsweise Fehlergrenze. Geldanzeige und Risikovergleich nicht durch unterschiedliche unbeschriebene Rundung auseinanderlaufen lassen.
- Risikovergleich exakt oder nachweislich konservativ, ohne Budgetlockerung. Ein negativer Nichtnullbetrag unter der Ausgabequantisierung darf nicht als sicher 0 verschwinden. Credits/Rebates ebenso nicht als exakter Nullwert ausgeben, wenn nur die Anzeige rundet.
- Vorzeichen unverändert: positiver Original-Fee-Cost wird negativer Cashflow, negativer Cost ein Rebate. Indexumrechnung ist keine zusätzliche Fee und keine zweite PnL-Buchung.

Vollständige Einheitentransformation bei späterer Integration, mit `r = USD je Settlementasset`:

- Historischer Cashflow: `reportCashflow = originalCashflow * r(eventTime)`.
- Aktuelle zusätzliche Verpflichtung: `settlementMarkToStop + settlementPendingEntryRisk`, danach Umrechnung mit dem aktuellen geeigneten `r(now)`.
- Risk-Sizing: `quantity <= riskBudgetUSD / (stopDistanceSettlement * r(now))`, anschließend bestehende Mengen-/Tier-/IOC-Prüfungen.
- Kapital-/Margin-Sizing: unveränderte Equityprozente ergeben USD-Kapital. In Settlement-/Marktquote-Einheiten umrechnen, dann den vereinbarten Hebel-/Notionalvertrag anwenden. Nicht pauschal USD-Available durch einen USDT-Preis teilen.
- Strategiemaximum, Mindestnotional und Tiergrenzen behalten ihre jeweils explizite Währung; vor Vergleich in dieselbe Einheit bringen. Nicht unterstellen, dass alle drei in Reporting-USD vorliegen.
- Provider-UPL, Equity und Available, die bereits in Reporting-USD geliefert werden, nicht erneut konvertieren. Keine Haircuts als FX-Kurs und keine neue Margin-Prozentinterpretation.
- Schutz-/Exit-/Reconcilefunktion darf weder an unvollständiger Bewertung scheitern noch gespeicherte Stops lockern. Nachträgliche Budgetüberschreitung folgt dem bestehenden dauerhaften Entrydrain aus 003, keinem zweiten Cancelbudget und keiner neuen Liquidationslogik.

## Spätere Dateikandidaten und harte Grenzen

Erst nach expliziter API-/Implementierungsfreigabe koordinieren:

- Neu vorgeschlagen: `src/trading_fx_contract.ts`, `src/trading_fx_repository.ts`, `src/trading_fx_valuation.ts`, `exchange_executor/fx_evidence.py` und gegebenenfalls ein separat vereinbarter reiner Rationalbaustein.
- Enge Integration: `src/trading_money_ledger.ts`, `trading_accounting_contract.ts`, `trading_types.ts`, `ccxt_exchange.ts`, `trading_risk.ts`, `trading_risk_sources.ts`, `trading_risk_reservations.ts`, `trading_risk_repository.ts`, `trading_risk_admission.ts`; minimale Enginehooks nur nach Hunk-Abstimmung mit 003/004.
- Python: `ccxt_profiles.py`, `ccxt_adapter.py`, gegebenenfalls abgestimmte DTOs in `server.py` und vorhandener gemeinsamer Reader-/Scheduler-Anschluss. Keine Providerhistoryfunktionen außerhalb der freigegebenen Hunkzuständigkeit ändern.
- Migration in `src/db.ts` erst mit exklusiv zugeteilter freier Nummer. DB-init/close, Maintenance und andere Agentmigrationen nicht überschreiben. Quote-/Bewertungs-FKs und Retentionfilter gemeinsam prüfen.
- Neue fokussierte Tests gemäß nächstem Abschnitt; `tests/run_all.js` nur gezielter Registrierungshunk; nach tatsächlicher Umsetzung `docs/TRADING_GUIDE.md` mit ehrlich benannter Methode ergänzen.

Nicht freigegeben: Quellen-/Schemaänderungen jetzt, Kraken-Spot-Crossvenueclient, Konten-/Secret-/Reportwährungsänderungen, API-Upgrades, echte Requests an Provider/Server/Telegram, Trades, Deployment, Commit/Push, neue UI, beliebige Asset-/Tickerdiscovery oder Abschwächung von Quality-/Call-/Deadline-Gates. Auch öffentlich lesende Providerrequests sind in der lokalen Implementierungsprüfung nicht erlaubt; nur gespeicherte Dokumentationsbeispiele und lokale Fakes verwenden.

## Bedingte Umsetzungsschritte für einen späteren Executor

### Schritt 0: Entscheidungen und Schnittstellen freigeben lassen

Die tatsächliche Nutzerentscheidung zu D1 dokumentieren; keine Zustimmung aus Schweigen ableiten. D2/D3 und konkrete Datei-/API-Grenzen vom Hauptagenten freigeben lassen. Abhängige 004-Sizing-/Tier-Hunks und 001/002-ID-Vertrag abgleichen. D4 bleibt ausgeschlossen, sofern nicht separat ausdrücklich geändert.

**Gate:** Schriftlich festgehaltene Entscheidung und Scopefreigabe vorhanden; andernfalls nur Planpflege, keine Source-/Testvorarbeit.

### Schritt 1: Reine Vertrags- und Rechenregressionen zuerst

Vorgeschlagene `tests/test_trading_fx_contract.js` und `tests/test_trading_fx_valuation.js` zuerst anlegen und gezielt rot nachweisen. Erst dann die separat genehmigten Validatoren und Zahlenfunktionen implementieren. Historische und aktuelle Frischeprüfung sowie fehlende/missdeutete Felder abdecken.

**Gate:** Beide neuen Testdateien gezielt grün; `tsc --noEmit` und relevante ESLint-Dateien ohne Fehler/Warnungen. Kein Livevertrag durch einen geänderten Paper-Test erschleichen.

### Schritt 2: Dauerhafte Quote-/Bewertungsbeziehungen

Nach Migrationfreigabe Originalreceipts, Quote-IDs, Eventverknüpfungen und dauerhafte offene Bewertungsarbeit atomar speichern. Widersprüche erhalten. Quote- und Consumerfortschritt niemals vor den benötigten Originalen committen. Original-Event- und Fundingaliases unverändert. Referenzierte Quotes bei Retention erhalten.

**Gate:** Neue `tests/test_trading_fx_repository.js` zuerst rot, dann grün: Replay, Crash zwischen Quote und Projektion, Restart, UTC-Wechsel, Legacykonflikt, Migration/Neu-DB und `PRAGMA foreign_key_check`. Keine Produktions-DB verwenden.

### Schritt 3: Fester Bybit-Producer im gemeinsamen Haushalt

Nur genehmigte Routen und Originalstrings aufnehmen; Kategorie/Instrument/Feld/Origin strikt prüfen. Vorhandene geeignete Reads dürfen beweiserhaltend geteilt werden. Sämtliche zusätzlichen FX-Reads, Recovery-, History-, Accountmode- und Logreads in demselben begrenzten Reconcile-Haushalt zählen; kein zweiter Fünfer-Topf und keine automatische CCXT-Pagination. Persistente Fairness verhindert Verhungern von History oder benötigten FX-Legs; Deadline/Backoff nicht erweitern.

**Gate:** Neue `exchange_executor/tests/test_fx_evidence.py` zuerst rot, dann grün: falsche Kategorie, leere Indizes, fehlende Zeitbasis, Cross-Leg-Versatz, exakte Originalzahlen, gemeinsames Fünferbudget, Deadline, Backoff und Restartfortschritt. Kein echter Request.

### Schritt 4: Historische Eventprojektion und aktuelle Einheitenbindung zusammenführen

Nur nach D1/D3 und API-Freigabe unbewertete Events deterministisch mit passenden Belegen bewerten. Neue Ledgerbewertung muss Funding-/Risk-Quellenhash und vorbereitete Admissionbelege invalidieren. Dann USD-/Settlementeinheiten in Sizing, Notional-/Tiervergleichen und tatsächlichen Reserven vollständig integrieren; den bisherigen Fremdwährungsblock nicht vor dieser vollständigen Prüfung entfernen.

**Gate:** Neue `tests/test_trading_fx_engine.js` zuerst rot, dann grün; bestehende Ledger-, Accounting-, Funding-, Reserve-, Tier- und IOC-Tests grün. Verspätete negative Buchung erzeugt bei Überschreitung Entrydrain, ohne Schutzverlust.

### Schritt 5: Finale Fences, Nachweis und ehrliche Dokumentation

Frische-/Identitäts-/Policy-/Quotequellenhash unmittelbar vor tatsächlichem Dispatch prüfen. Dauerhaftes `dispatching` vor dem DB-Guard erhalten, kein Netzwerkawait unter SQLite-Lock und keinen bestehenden letzten synchronen Guard entfernen. Aktuelle Quotes dürfen niemals eine bestehende historische Bewertung still umpreisen.

**Gate:** Gezielte No-Send-, Ablauf-, Quellenwechsel- und Restarttests grün; anschließend gemeinsame Gates vom Hauptagenten. Dokumentation unterscheidet Native, tatsächliche Conversion, genehmigte Indexmethode, unbekannte Altbewertung und Providerabnahme. 005 nicht allein wegen dieser Teilstufe als DONE markieren.

## Red-Testmatrix mit festen Sollwerten

Die folgenden Werte sind ausdrücklich **synthetische lokale Fixtures**, keine beobachteten Marktpreise.

| Fixture / Fall | Erwartung |
|---|---|
| Funding `-10 USDT`, belegter Kurs `0.98 USD/USDT` | `-9.8 USD`, niemals pauschal `-10 USD`. |
| Rebate `+0.025 USDC`, Kurs `1.002 USD/USDC` | `+0.02505 USD`. |
| Fee `-0.01 BNB`, USD-Index `300.125` | `-3.00125 USD`. |
| Reserve `50 USDT`, aktueller Kurs `0.98` | `49 USD`; Originalreserveeinheit bleibt nachvollziehbar. |
| Riskbudget `20 USD`, Abstand `10 USDT`, Kurs `1.25 USD/USDT` | Höchstens `1.6` Basiseinheiten vor weiteren Mengen-/Tiergrenzen. |
| Kapital `100 USD`, Hebel `2`, Preis `100 USDT`, Kurs `1.25` | Notional `200 USD`, entsprechend `160 USDT`, höchstens `1.6` Basiseinheiten; Prozent unverändert. |
| Cross-Rate `60000/60150` | Exakt `400/401` in Herkunft/Rechenweg; endliche Anzeige nicht als exakte Rate deklarieren. |
| Nichtnullbetrag kleiner als Ausgabequantum | Nicht still als sicher `0` buchen; freigegebene Rest-/Rundungsprovenienz und konservativer Riskvergleich. |
| Nichtnullgebühr ohne Fee-Asset | Unresolved trotz vorhandener BTC-/USDT-Quotes. |
| Ticker mit `time` nur außen | Keine erfundene einzelne Tickzeit; vollständige Originalantwort/Zeitbasis nötig. |
| Falsche Kategorie, falscher Basiscoin, Live/Testnet-Mischung, leerer `usdIndexPrice` | Unresolved; kein Mark-/Last-/Parity-Fallback. |
| Kurs nach Event, zu alt, widersprüchliche Quote-ID | Unresolved/Konflikt, Originalbelege bleiben. Zeitgrenztests erst gemäß tatsächlich freigegebener D1-Policy. |
| Aktuelle oder nach vorn gerundete Candle | Keine rückdatierte Eventbewertung. |
| Tatsächlich alter Kurs erst später empfangen | Bei genehmigter Eignung genau eine Bewertung am ursprünglichen UTC-Eventtag. |
| Historische Bewertung vorhanden, aktueller Kurs stale | Historischer Ledger unverändert; neue Entries gesperrt, Schutz/Exit laufen. |
| Negative Funding-Nachlieferung bzw. erstmals mögliche negative Bewertung | Admissionrevision ungültig; bei bewiesener Überschreitung dauerhafter Entrydrain, kein Stopverlust. |
| Identische nackte Fill-ID in verschiedenen bewiesenen Marktscopes | Getrennte kanonische Moneyevents bleiben getrennt; kein FX-Dedupe über nackte Provider-ID. |
| Gleiches Legacy-Fundingevent über neuen Receipt | Keine zweite Geldbuchung; ursprünglicher Alias bleibt maßgeblich. |
| Neustart zwischen Quote-Persistenz und Projektion; wiederholte Projektion | Genau einmal, weder Belegverlust noch Neubewertung mit heutigem Kurs. |
| Sechster zusätzlicher Read, Deadline oder Backoff | Kein Request; persistente Fortsetzung/Fairness ohne Budgetlockerung. |
| UTC-Wechsel mit offenen alten FX-/Fundingfenstern | Alte Arbeit bleibt erhalten; aktueller Tagesbeweis nicht aus fremdem Fenster behauptet. |
| Quote-/Policy-/Credentialänderung nach Vorbereitung | Finaler Fence verhindert Send; bestehende Schutzverwaltung bleibt frei. |

## Spätere lokale Prüfkommandos

Arbeitsverzeichnis `C:/Users/nikla/Desktop/tsx-core`. Projekt verwendet Node 22/npm 10.9 und Python 3.12/CCXT 4.5.75. Keine Installation oder Versionsänderung erforderlich. Diese Befehle sind **künftige Gates**, nicht in dieser Planpflege ausgeführte neue FX-Tests.

```powershell
$fxNode = 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe'
$fxPython = 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe'
$fxRuff = 'C:/Users/nikla/AppData/Local/Temp/tsx-core-ccxt-py312/Scripts/ruff.exe'

# Neu vorgeschlagene Tests: erst nach Schritt-0-Freigabe anlegen.
& $fxNode --import tsx tests/test_trading_fx_contract.js
& $fxNode --import tsx tests/test_trading_fx_valuation.js
& $fxNode --import tsx tests/test_trading_fx_repository.js
& $fxNode --import tsx tests/test_trading_fx_engine.js
& $fxPython -B -m unittest discover -s exchange_executor/tests -p test_fx_evidence.py -v

# Bestehende Regressionen.
& $fxNode --import tsx tests/test_trading_money_ledger.js
& $fxNode --import tsx tests/test_trading_accounting_gate.js
& $fxNode --import tsx tests/test_trading_funding_observation.js
& $fxNode --import tsx tests/test_trading_risk_reservations.js
& $fxNode --import tsx tests/test_trading_risk_repository.js
& $fxNode --import tsx tests/test_trading_leverage_tiers.js
& $fxNode --import tsx tests/test_trading_entry_price_engine.js
& $fxNode --import tsx tests/test_retention_accounting.js

# Unveränderte gemeinsame Gates; Gesamtlauf mit Hauptagent koordinieren.
& $fxNode node_modules/typescript/bin/tsc --noEmit
& $fxNode node_modules/eslint/bin/eslint.js 'src/**/*.ts' 'tests/**/*.js' 'scripts/**/*.js' '*.js' --max-warnings 0
& $fxRuff check exchange_executor
& $fxNode scripts/check_architecture.js
& $fxNode scripts/check_complexity_budget.js
& $fxPython -B -m unittest discover -s exchange_executor/tests -v
& $fxNode tests/run_all.js
```

Erfolg jeweils Exit 0, neue und bestehende Assertions grün, keine neuen Lintwarnungen, keine gelockerten Gates. Neue Architektur-/Coverage-/Migrations-/Retentionpflichten für tatsächlich angelegte Module ausdrücklich mitführen. Wenn Schritt 0 nicht freigegeben ist, die fehlenden Testdateien nicht als Anlass nehmen, sie vorab zu erzeugen.

## Abschlusskriterien, STOP und Wartung

Die **jetzige Dokumentationsaufgabe** ist abgeschlossen, wenn nur dieser Folgeplan angelegt, sein vollständiger Inhalt zurückgelesen und D1/D3/D4 eindeutig offen beziehungsweise ausgeschlossen geblieben sind. Dafür ist keine Anwendungssuite notwendig.

Eine **spätere FX-Implementierung** wäre erst nach allen folgenden Punkten vollständig:

- [ ] Nutzerentscheidung zur Eventzeit-/As-of-Methode und separate Zahlen-/API-Freigabe dokumentiert.
- [ ] Alle genannten Quellen-/Zeit-/Einheiten-/Replayfälle zuerst rot und danach grün nachgewiesen.
- [ ] Keine feste USD-/USDT-/USDC-Parität, kein fehlender Kurs als 0, keine falsche Fee-Währung.
- [ ] Historische Bewertung und aktuelle Sizing-/Reserve-/Tierbewertung vollständig getrennt und einheitlich dimensioniert.
- [ ] Gemeinsame Deadline/Fünferbudget/Fairness, Restart und Quote-Retention nachgewiesen.
- [ ] Originalevents, Aliases und Konflikte unverändert erhalten; keine double postings.
- [ ] Schutz/Exit bei Bewertungsunsicherheit weiter funktionsfähig; finale Entryfences erhalten.
- [ ] Sämtliche späteren lokalen Gates grün, konkrete Altbestandsgrenzen dokumentiert; Provider-/Releaseabnahme weiterhin getrennt.

**STOP und an Hauptagent melden**, wenn eine notwendige Policyentscheidung fehlt, eine API-/Datei-/Migrationfreigabe fehlt, erforderliche Kurs-/Asset-/Richtungs-/Zeitbelege fehlen, eine historische Rekonstruktion nur durch Annahmen möglich wäre, ein weiterer Providerclient nötig wird, der aktuelle Code wesentlich von den beschriebenen Verträgen abweicht oder die Lösung ein Quality-/Call-/Deadline-/Risikolimit lockern würde. Fehlende Nutzerantwort nie als Zustimmung behandeln. Bei wiederholtem Testfehlschlag Ursache und Belege melden, nicht Budget oder Tests abschwächen.

Wartung: Weitere Fee-Assets, Quanto-/inverse Instrumente, neue Reportingbindungen, Cross-Venue-Routen und feinere/gröbere Zeitmethoden sind neue versionierte Fähigkeiten. Ein geänderter CCXT-Parser oder Providerfeldvertrag benötigt neue lokale Contractbelege. Große Quotehistorien brauchen ein ausdrückliches Speicher-/Retentionkonzept; eine ungeprüfte Ringpufferkürzung oder Löschen noch benötigter Beweise ist kein solches Konzept. Dieser Folgeplan belegt keine Fertigstellung des gesamten Pakets 005.
