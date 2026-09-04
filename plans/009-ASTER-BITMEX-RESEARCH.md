# 009 – Aster und BitMEX: produktgenaue Vorprüfung

Stand: 2026-09-03. Lokale Grundlage: `f8089277d0667dd45bcf070037800d423fd89254` plus die vorhandenen uncommitteten Reparaturen 001–008. Python 3.12 / tatsächlich installiertes CCXT 4.5.75. Nur öffentliche offizielle Dokumente, lokale Quellen und vollständig abgefangene SDK-Aufrufe; keine Provider-, Konto-, TSX-, Server- oder Handelsverbindung.

Diese Notiz folgt auf [Binance/OKX](./009-BINANCE-OKX-RESEARCH.md). Sie ist keine Profilattestation. Für beide Anbieter bleiben `implementationVerified=false` und `providerAcceptanceVerified=false`. Der Improve-Review wurde ausschließlich für den beauftragten Providervergleich benutzt, nicht für einen erneuten allgemeinen Codeaudit.

## Entscheidung

| Exakter Slice | Entscheidung | Nachvollziehbarer Grund |
|---|---|---|
| Aster V3, EVM-Agent, lineare Crypto-USDT-Perps, One-way, Cross, Single-Asset, Live | `pending`, technisch geeigneter Batch-Kandidat | Der native Zweierbatch passt zum vorhandenen Journal. Die unten beschriebenen kleinen SDK-/Providerhelfer sind machbar und kein Ausschlussgrund. Noch unbelegt: vollständige Sicht unbekannter wartender Strategie-Aufträge. |
| Derselbe Aster-Slice, Testnet | `pending` | Zusätzlich fehlt im SDK eine Sandbox-URL-Abbildung. Offizielle Testnet-Domain und Message-Signaturdomain sind vorhanden; ein enger Host-/Domain-Helfer ist möglich. Keine Ableitung von Live-Abnahme. |
| Aster Hedge / Multi-Assets / andere Sicherheiten | `pending`, nicht Teil des vorgeschlagenen ersten Slices | Keine automatische Modusänderung. Der erste kleine Providervertrag darf fremde Modi erkennen und sperren, nicht mit One-way-/USDT-Risiko rechnen. |
| Aster Aktien-/Prediction-/inverse oder laufzeitgebundene Produkte | `pending` beziehungsweise außerhalb des Crypto-Perp-Slices | Keine Freigabe aufgrund des generischen SDK-`contractType`-Tests. Für inverse/Quanto und Laufzeitprodukte gelten dieselben mathematischen beziehungsweise Lebenszyklusgrenzen wie unten. Verfügbarkeit nicht erfunden. |
| BitMEX lineare USDT-Perps, One-way, Cross, Live | `not_easy` / aktuell keine Neueröffnung | Öffentliche aktuelle Betriebsbeschränkung und unabhängig davon kein allgemein verfügbarer geeigneter Entry-/Stop-Batch. Die lineare Kontraktrechnung allein wäre klein integrierbar. |
| BitMEX lineare USDT-Perps, Testnet | `not_easy` im bestehenden Schutzvertrag | Gepinnte Sandbox vorhanden; fehlender allgemeiner Schutzbatch bleibt. Testnet-Verfügbarkeit nach dem angekündigten Betriebsende ist gesondert `pending`, nicht aus Live-Mitteilung ableiten. |
| BitMEX inverse / Quanto / Expiry-Futures | `not_easy` | Zusätzlich nichtlineare beziehungsweise fremde Settlement-Rechnung oder Ablauf-/Settlement-Lifecycle; kein bloßer Resolver-/Profilflag. |

`pending` bedeutet eine konkrete unbelegte Anforderung, nicht nachgewiesene technische Unmöglichkeit. Insbesondere rechtfertigen Asters Nonce-, Builder-, Parser- oder Sandbox-Lücken kein pauschales `not_easy`.

## 1. Entscheidende offizielle Quellen

Alle Links am 2026-09-03 gelesen. Keine darin enthaltenen Handelsbeispiele ausgeführt.

### Aster

- [V3-Futures-Referenz](https://raw.githubusercontent.com/asterdex/api-docs/master/V3%28Recommended%29/EN/aster-finance-futures-api-v3.md), relevante Originalzeilen: 2261–2359, 2471–2537, 2986–3088, 3312–3518, 3729–3969. Belegt: maximal fünf unabhängig verarbeitete Batchorders; normale und Stop-Parameter; eigene `orderId`/`clientOrderId`; `openOrders` ohne Symbol; symbolgebundene Fillhistorie; Income ohne Typfilter; Income-ID nur je Typ eindeutig. Nicht gefüllte Cancel/Expired-Orders verschwinden nach sieben Tagen. Fillabfragen verwenden höchstens Siebentagesfenster und `fromId` nicht gleichzeitig mit Zeiten. Income hat inklusive Zeitgrenzen und maximal 1000 Zeilen, keinen dokumentierten Seitencursor. Strategieabfragen verlangen bekannte IDs. Das ist kein dokumentierter all-account Strategy-EOF.
- [Offizielle Account-/Trading-Webfassung](https://asterdex.github.io/aster-api-website/futures-v3/account%26trades/) zum Abgleich derselben Referenz, insbesondere `strategyOpenOrder` und `strategyHistoryOrder`. Nicht als unabhängige zweite Bestätigung derselben fehlenden Scope-Zusicherung zählen.
- [Futures Authentication](https://asterdex.github.io/aster-api-website/asterCode/authentication/): vorhandenes EIP-712 `Message.msg` muss den tatsächlich gesendeten Querystring abbilden; Mainnet-Chain-ID 1666, Testnet 714. [Testnet-Referenz](https://raw.githubusercontent.com/asterdex/api-docs/master/V3%28Recommended%29/EN/aster-finance-futures-api-testnet.md) nennt `fapi.asterdex-testnet.com`.
- [General Info](https://asterdex.github.io/aster-api-website/futures-v3/general-info/): agentbezogene Nonce-Eindeutigkeit, Mikrosekunden und unbekannter Ausführungsstatus bei 503. Dokumentinterner Fristdrift: der Nonce-Abschnitt nennt ±60 Sekunden, ein Beispiel weiterhin zehn Sekunden. Keine Lockerung des TSX-Entry-Deadlines daraus ableiten.
- [Agent-/Builder-Endpunkte](https://asterdex.github.io/aster-api-website/asterCode/endpoints/): `GET /fapi/v3/agent` liefert Agentberechtigungen und Ablauf. Kein dokumentiertes separates Strategy-Verbot. Das ist ein möglicher echter Agent→Main-Account-Nachweis, kein Anlass, Agent oder Builder automatisch anzulegen.
- [Changelog](https://raw.githubusercontent.com/asterdex/api-docs/master/CHANGELOG.md): ältere Strategierouten heißen `strategyOrder` und `strategyOrder/history`; kein accountweiter Listenvertrag. Der Eintrag vom 31.08. nennt den 01.09. als Deposit-Voraussetzung für private V3-Endpunkte. Die oben verlinkte General-Info-Webfassung nennt dagegen 07.09.2026. Dieser öffentliche Datumswiderspruch bleibt sichtbar; `-5050` ist ein Zugangsfehler, niemals Auftrag für TSX, einzuzahlen.
- [API-Übersicht](https://raw.githubusercontent.com/asterdex/api-docs/master/Aster%20API%20Overview.md): neue V1-Keys seit 25.03.2026 nicht mehr vorgesehen. Die Prüfung verwendet den gepinnten V3-Pfad, nicht einen neu gebauten V1-Client.
- [BAPI Portfolio](https://asterdex.github.io/aster-api-website/bapi/portfolio/) wurde als alternative Quelle geprüft: statistische Summen, Chart- und Gridmetriken; keine vollständige aktive Parent-/Childliste. Aggregate ersetzen keine Originalereignisse oder Ordervollständigkeit.

### BitMEX

- [Closure: Important dates and FAQ](https://support.bitmex.com/hc/en-gb/articles/38519921695645-BitMEX-closure-Important-dates-and-FAQ), aktualisiert 26.08.2026: vom 26.08. bis 23.09. positionsreduzierender Betrieb; angekündigtes Ende aller Handelsdienste am 23.09.2026 um 04:00 UTC. Das ist ein datierter Betriebsbefund, kein CCXT-Featuretest und keine Berechtigung für Kontoaktionen.
- [Create Contingent Orders](https://docs.bitmex.com/api-explorer/new-bulk-order): `/api/v2/order/bulkorder` nur für Kunden mit gesonderter Vereinbarung; normale Orders werden dort abgewiesen. Nicht aus der Überschrift „Bulk“ allgemeine Zwei-Leg-Unterstützung ableiten.
- [V1 Create Order](https://docs.bitmex.com/api-explorer/new-order.html) und [V2 Create Order](https://docs.bitmex.com/api-explorer/new-order-1.html): `ImmediateOrCancel`, native `Stop` ohne zusätzlichen Limitpreis; native Ausführungsgrenzen sind keine Fillgarantie. `Close` beeinflusst andere Orders und ist nicht einfach Ersatz für einen eigenen mengenbegrenzten Reduce-only-Stop. OTO wartet auf vollständige Primärausführung; OCO kann bereits bei Teilfüllung andere Legs stornieren. Beide bilden einen IOC-Teilfill-Schutz nicht unverändert ab.
- [REST API / Einheiten](https://www.bitmex.com/app/restAPI): USDT-Geldwerte in `USDt`, 1 USDt = 0.000001 USDT; BTC in XBt. Webabruf liefert teilweise die alte Browser-Hülle, der offizielle indexierte Dokumenttext enthält die Einheiten. Gegenprüfung über den tatsächlich installierten SDK-Currency-Konverter unten.
- [Wallet History](https://docs.bitmex.com/api-explorer/get-wallet-history): eigener Account, Währung, Betrag, `transactID`, Status, tatsächliche/logische Zeiten und gegebenenfalls Orderbeziehung. `currency=all`, Zeitgrenzen, `start`/`count` und Richtung ermöglichen einen begrenzten Rohreader. Keine dauerhafte Retentionsgarantie auf dieser Seite gefunden.
- [Get Executions](https://docs.bitmex.com/api-explorer/get-execution) und [Get Trade History](https://docs.bitmex.com/api-explorer/get-execution-trade-history.html): accountweite Rohereignisse versus geldwirksame Ausführungen. Funding nicht als gewöhnlichen Fill behandeln.
- [Positions](https://docs.bitmex.com/api-explorer/get-position.html) und [Risk Limit](https://docs.bitmex.com/api-explorer/risk-limit.html): Account-/Strategy-Bindung, Cross-Margin, eigene Risikogrenze und Minor-Currency-Einheiten. Aktuelle `OneWay`/`Long`/`Short`-Felder verbieten einen ungeprüften „inherent one-way“-Default aus älteren SDK-Kommentaren.
- [Funding und Wallet](https://support.bitmex.com/hc/en-gb/articles/7160076252573-Do-Funding-Payments-Come-Out-of-or-Go-Into-My-Wallet-Balance): realisierte Fundingzahlungen; Cross beeinflusst Wallet, Isolated eigene Position-Margin. Kein Ersatz durch erwartete Fundingrate oder Null.

## 2. Tatsächlich gepinnte Implementierung

Alle folgenden Pfade relativ zu `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/`. Zeilen über `inspect.getsourcelines` ermittelt, Hashes über Originaldateien.

| Datei | SHA-256 |
|---|---|
| `async_support/aster.py` | `df0bac5adcc10033bebf3b8a7e03f4cef856ee4a1ea5e2a60867800f8b86b9b7` |
| `pro/aster.py` | `e043049157b02a867058bfa30a3f8a92cf38490a6d2a77c7695b7505151764b5` |
| `async_support/bitmex.py` | `96c0638558faa1f2ae59af8fe6505e44a5057cb17c3a301ec122523e28e27312` |
| `pro/bitmex.py` | `d7e6044acd7d06cf011404048597c5c1721abcdb6820b3728a8675077a557bc6` |

### Aster SDK

- `parse_market:982`: irgendein `contractType` macht den Markt zum Swap; fehlende Kontraktgröße kann auf 1 fallen. TSX muss Originalprodukt/Einheiten prüfen. `PERPETUAL` und Crypto-Slice ausdrücklich binden, nicht `swap=true` blind übernehmen.
- `create_orders:2579` baut über `create_order_request:2646` einen nativen `fapiPrivatePostV3BatchOrders`. `clientOrderId` wird `newClientOrderId`. `LIMIT` enthält Preis und IOC; `market + stopLossPrice` wird `STOP_MARKET` ohne Preis. `parse_order:2171` erhält normale `orderId`/`clientOrderId`, Trigger, Mengen und Status. Für den akzeptierten Stop existiert daher kein grundsätzlich erst später erzeugtes Child wie beim untersuchten OKX-Attachment.
- `sign:4060`: gepinnte EIP-712-Signatur bereits vorhanden. Standard-`user` wird aus dem gehaltenen privaten Schlüssel abgeleitet; für einen Agentenschlüssel ist das nicht automatisch der Main-Account. Ein gebundener `user` kann als bestehender Parameter übergeben werden, die Signatur bleibt SDK-Aufgabe. Caller dürfen `user`/`signer`/Nonce/Domain nicht frei überschreiben.
- Dieselbe Funktion setzt `nonce = milliseconds() * 1000`; zwei Aufrufe derselben Millisekunde reproduzieren identische Nonces. REST und Pro sind getrennte Instanzen: ein bloßer Zähler pro Instanz reicht für denselben Agenten nicht. Notwendig ist ein gemeinsamer begrenzter Agent-/Mode-Schlüssel, Clock-/Restart-Fence und weiter die bestehenden Deadlines, keine neue Chain-Infrastruktur.
- `initialize_client:4174` kann standardmäßig Builder lesen und freigeben. `builderFee=false` beendet diesen Pfad vor dem ersten Fetch. Die tatsächliche Probe bestätigt außerdem fehlende `builder`/`feeRate` in beiden Legs. Vor Profilfreigabe muss dies unveränderlich durch den bestehenden SDK-Policy-Pfad gesichert sein, nicht nur durch einen Testparameter.
- `fetch_my_trades:1366` erlaubt lokal ein weggelassenes Symbol, obwohl das allein kein Accountscope-Beleg ist. `fetch_orders:2384`, `fetch_open_orders:2447`, `fetch_funding_history:3260`, `fetch_ledger:3346` führen echte V3-Reads aus. Funding-History setzt einen Typfilter; Ledger nicht. Raw-Reader dürfen nicht die symbolgebundene Fillquelle als komplette Kontohistorie etikettieren.
- `parse_trade:1203` verwendet `abs(commission)` und verliert damit das Originalvorzeichen. `parse_ledger_entry:3291` erhält Original-Income in `info`, stellt den Unified-Betrag aber als positive Größe plus Richtung dar. Eigene Geldbelege müssen von Raw-Cashbetrag, Asset, Typ und Identität ausgehen. Gegenprobe unten bestätigt den konkreten Informationsverlust.
- `load_leverage_brackets:3822` verwirft `initialLeverage`/Cap und cached nur Floor/Maintenance-Paare. `fetch_positions_risk:3542` lädt solche Brackets zusätzlich und filtert leere Positionen. Für Admission stattdessen aktuelle Raw-Brackets, echte Modusdaten und auch belegte flache Symbolzeilen verwenden; keine unsichtbaren Extra-Reads unter dem Recovery-Budget.
- REST hat keine Sandbox-URLs. Pro `authenticate:1174`, `watch_positions:1389`, `watch_orders:1562`, `watch_my_trades:1596` besitzen echte Futures-Streams; Listen-Key-/Keepalive-Reads brauchen dieselbe Agent-/Nonce-/Hostbindung. Streams bleiben Trigger, keine fehlende historische oder wartende-Strategy-Sicht.

### BitMEX SDK

- `parse_market:793` unterscheidet lineare Swaps, inverse und Quanto. Linear ergibt sich die Base-Menge pro Kontrakt aus `1 / underlyingToPositionMultiplier` beziehungsweise `underlyingToSettleMultiplier`; dies ist nicht der Geld-Skalierungsfaktor. Die vier wirklichen Parsergegenproben unten erhalten diese Unterscheidung sowie Expiry.
- `create_order:2029` signiert `/api/v1/order`; der gepinnte Pfad ist also V1, auch wenn heutige Dokumente zusätzlich V2 zeigen. `clientOrderId → clOrdID`, `reduceOnly → ReduceOnly`; Triggerdirection wird verlangt. Ein Literal `IOC` bleibt unverändert und ist nicht automatisch das native `ImmediateOrCancel`. Der richtige native Parameter passt ohne neue Engine.
- `create_orders` ist die nicht unterstützte Basismethode (`async_support/base/exchange.py:2420`). Deren Offline-Fehler allein wäre noch kein `not_easy`; ausschlaggebend sind der gesondert beschränkte öffentliche Bulkvertrag und OTO-/Partialfill-Grenzen oben.
- `fetch_orders:1109`/`fetch_open_orders:1151` können Accountscope ohne Symbol und einen `open`-Filter transportieren. `fetch_my_trades:1186` liest `execution/tradeHistory`, `fetch_ledger:1387` Wallet-History. `paginate` muss ausdrücklich aus bleiben; eigene persistierte Seiten/Offsets und Originalfilter unter bestehendem Budget. Ein SDK-`since` allein begrenzt beim Ledger nicht zuverlässig den Providerrequest, daher Zeiten ausdrücklich im Raw-Request.
- `parse_trade:1733` nutzt `trdMatchID` als ID, nicht die vorhandene eigene `execID`. Außerdem belässt `convert_from_raw_cost:599` Swap-Geldwerte im Raw-Maßstab, obwohl die Fee mit normalisiertem USDT-Code ausgegeben wird. Probe: `execComm=-100 USDt` wird Unified `-100 USDT`; vorhandener `convert_to_real_amount:570` ergibt dagegen `-0.0001`. Ein kleiner Originaleinheiten-Reader wäre notwendig, keine Decimal- oder FX-Parität.
- `parse_ledger_entry:1292` setzt eine fehlende Originalzeit auf 0. Das muss eine Quellenvalidierung abweisen. Eventzeit ist nicht durch `timestamp=0` bewiesen.
- `fetch_positions:2328` / `parse_position:2441` erhalten viele Raw-Felder in `info`; das alte Unified-`hedged=None` ist kein Modusnachweis. `set_leverage:2770` ist ein Write, keine Verifikation. Echte Cross-/Strategy-/Risikogrenzen zuerst lesen. Statische Markt-Maximalhebel sind keine aktuellen mengenabhängigen Account-Tiers.
- Pro `authenticate:679`, `watch_positions:715`, `watch_orders:934`, `watch_my_trades:1144` vorhanden; REST und Testnet-Hosts bereits gepinnt. Kein Stream ersetzt die fehlende geschützte Submit-Semantik.

## 3. Aster: Scope-Grenze gezielt ausgeschöpft

Geprüft wurden die vollständige V3-Referenz, deren Webfassung und Verzeichnis, aktuelle/ältere Strategieroutennamen, der SDK-ImplicitAPI-Katalog, `accountWithJoinMargin`, `positionRisk`, Agentberechtigungen, Position-/MultiAsset-/STP-Modus sowie die offizielle BAPI-Portfolioalternative.

Die offene Frage ist **nicht**, ob normale `STOP_MARKET`-Orders eine ID erhalten. Das tun die dokumentierten normalen Batch-/Orderformen. Offen ist: Kann ein unbekannter externer Strategie-Parent mit noch nicht freigegebenem Einstieg oder Child existieren, obwohl der normale all-symbol `openOrders`-Abruf keine solche Verpflichtung zeigt?

Keine gelesene Quelle sichert zu, dass alle wartenden Strategie-Suborders in `openOrders` erscheinen. Kein dokumentierter alternativer accountweiter Strategiecursor und kein lesbares, diese Strategien ausschließendes Kontomerkmal wurden gefunden. Ein bekannter `strategyId`-Detailread schließt gerade unbekannte IDs nicht aus. Dass TSX selbst keine Strategien anlegt, beseitigt fremde Verpflichtungen nicht. Statistik null, Subaccountliste, frische flache Positionen, MMP oder `canPerpTrade=true` sind dafür ebenfalls kein Beweis.

Engste notwendige Primärklärung: Entweder vollständige Darstellung aller noch aktivierbaren Strategie-Parents/Children in einer bereits dokumentierten Accountliste, eine zusätzliche vollständig paginierbare Liste oder ein authentifiziert lesbarer Ausschluss dieses Produkts für den konkreten Account. Ein darauf beschränkter Providerreader wäre klein und weiter im Scope. Bis dahin keine Profilfreigabe; ausdrücklich `pending`, nicht „Anbieter kann das sicher nicht“.

## 4. Aster: vollständige Geld- und Fillbelege als kleiner Folgebaustein

Der machbare Folgeentwurf, noch nicht implementiert:

1. Einen einzigen originalen accountweiten Income-Stream verwenden, nicht einen neuen Funding-Topf neben dem Scheduler. Vorgeschlagener Namespace `aster_v3_account_income_v1`, gebunden an Exchange, Mode, tatsächlichen Main-Account, Credential-Generation und vollständigen Filterhash. Logische Eventidentität mindestens `incomeType + tranId`; Originalstrings und einzelne Vorkommen unverändert erhalten.
2. Persistierte inklusive Zeitfenster adaptiv teilen. Eine volle Seite beweist keinen EOF. Ein unteilbares Millisekundenfenster mit 1000 Zeilen bleibt `saturated_unresolved`; kein Sprung `lastTime+1`, kein erfundener `page`/`fromId`-Parameter für Income. Normale dünnere Fenster bleiben funktionsfähig. Historischer Zugriff jenseits nachgewiesener Quellenreichweite bleibt offen; „Default sieben Tage“ ist keine Zusicherung einer gesamten Retention.
3. Funding aus originalem `FUNDING_FEE` mit echtem Asset buchen. `COMMISSION` und `REALIZED_PNL` gegen originale Fillidentität korrelieren, statt dieselbe Wirtschaft zweimal über Fill und Income zu buchen. Nicht alle Transfers als PnL behandeln. Unbekannte Bonuseinheiten, Korrekturen oder widersprüchliche Cashbelege bleiben sichtbar.
4. Für eigene Fills das wirkliche Symbol plus native Fill-/Order-ID erhalten. Accountweite Einnahmen sind keine synthetischen Fills. Den vollständigen historischen Symbolscope einschließlich fremder/ausgelisteter Märkte eigenständig nachweisen; lokale offene Positionen oder aktuelle Marktlisten allein reichen dafür nicht. Dies ist eine weitere vor Attestation zu prüfende Coveragepflicht, kein pauschales Verbot des vorhandenen Raw-Readers.
5. USDT bleibt USDT. Ein USD-Report braucht zugelassene eigene Bewertungsbelege; nicht Aster-USDT durch Bybit-/Kraken-Kurse oder durch 1:1 ersetzen. Native USDT-Buchungen und ihre Quellen können ohne diesen Zusatz bewertet werden, wenn die konfigurierte Berichtseinheit tatsächlich identisch ist.
6. Pro zusätzlichem tatsächlichem Read gemeinsamer Schedulerzähler, maximal fünf, vorhandene Deadline, faire Audit-/Forward-Fortsetzung und Restartpersistenz. Eine fehlgeschlagene oder saturierte Seite erzeugt keine Quellenfinalität und löst kein negatives Submit auf. Periodischer Rückscan und Revisioninvalidierung bleiben Pflicht.

## 5. Engster möglicher Implementierungszuschnitt

Nur Vorschlag für Root, keine Sourceänderung in diesem Auftrag:

| Kleines Modul / gemeinsamer Hook | Inhalt und Grenze |
|---|---|
| Neues `exchange_executor/aster_sdk_policy.py`; Einbindung über `ccxt_sdk_policy.client_class` | Gebundener Main-User/Agent, gemeinsamer Noncegeber für REST+Pro, keine Builder-/Agent-Setupwrites, kontrollierte Sandbox-Host-/Message-Domain. SDK signiert weiterhin selbst. |
| Neues `aster_execution.py`; Hooks `execution_constraints.read_entry_constraints`, `leverage_tiers` | Raw One-way/Cross/Single-Asset/Agent-Nachweis, vollständige frische Brackets und Notional-/Margin-Grenzen. Keine Modusänderung zur Verifikation. |
| Neues `aster_current_state.py`; Hook `current_state.read_current_state` | Alle dokumentierten aktuellen Scopes mit Originalreceipts. Wartende Strategie-Sicht erst nach obiger Zusicherung ergänzen; bis dahin keine erfolgreiche Vollständigkeit erfinden. |
| Neues `aster_history.py`; enge Hooks in `history_reader.py`, `history_coverage.py`, `history_pagination.py` | Symbol-/Retention-/Zeitgrenzen, echte native IDs, fremde Quellen sichtbar, bestehende Checkpoint-/Budgetverträge. Kein zweiter Loop. |
| Neues `aster_account_log.py`; Hooks `account_log_sources.py`, vorhandene Accountlog-Consumer | Raw-Income und saturationssichere Fenster; additive projektionstreue Fee/Funding/PnL-Normalisierung. Keine neue Geldengine oder Originalumschreibung. |
| `fill_identity.py`, `fill_quantity_provenance.py`, schmaler Normalisierer | Aster native-ID-/Base-Quantity-Vertrag; keine Feeabs()- oder Default-Kontraktgrößen-Autorisierung. |
| `ccxt_profiles.py`, Zertifizierung und Paritätsfixtures | Erst nach echten grünen Pflichtfällen und geschlossener Scopefrage. Keine Runtime-/Accountfreigabe aus dem Dokument. |

Bestehende Engine bleibt unverändert: vorjournalierte Entry-/Stop-IDs, dauerhafter Dispatch-Fence, beide echten Providerergebnisse, unklare Teilannahme über bestehenden Isolation-/Recoverypfad, eigener Entry-Drain und Schutzreparatur. Batchkonkurrenz ist keine Atomizität. Teilfill mit abgewiesenem Stop darf nicht zu `monitoring` werden; Stop-only/Zero-fill muss mit wirklichen IDs bereinigt werden.

Für BitMEX ist derzeit kein Produktionshunk empfohlen. HMAC, IOC-Mapping und lineare Einheitennormalisierung wären isoliert klein; sie schaffen keinen fehlenden allgemein verfügbaren Schutzbatch und heben die aktuelle Betriebsbeschränkung nicht auf.

## 6. Wirklich ausgeführte lokale Proben

Zwei einmalige Python-stdin-Proben, gepinnte Runtime mit `-B`, Exitcode jeweils 0. Kein neues Testfile, keine Runtime-/SDK-Datei geändert. Für SDK-Calls wurden Märkte ausschließlich aus Fakes vorgelegt und `fetch` vor dem ersten Aufruf durch eine fail-closed Funktion ersetzt. Die Signierung selbst lief tatsächlich mit ausschließlich erfundenem lokalem Testschlüssel; Schlüssel, Header und Signaturen wurden nicht ausgegeben.

Erste Probe: **12 Szenariogruppen**, Ausgabe `passed:12`, `networkCalls:0`:

1. Echter Aster-`create_orders`: genau ein signierter V3-Batch; `LIMIT/IOC`, Preis `60001.2`, Menge `0.01`; `STOP_MARKET`, Trigger `59000`, gleiche Menge, Reduce-only und kein Stop-`price`. Native IDs `101`/`102` und eigene Client-IDs bleiben getrennt.
2. `builderFee=false`: weder Builder-Read noch Approval-Write und keine Fee-Parameter in beiden Legs.
3. Tatsächliche Aster-`sign`-Aufrufe bei festgehaltener Millisekunde liefern identische Nonce: reproduzierter zu reparierender SDK-Randfall, kein positiver Providerbeweis.
4. Signierung mit unterschiedlichem Main-`user` und aus dem Testschlüssel abgeleitetem `signer` erhält beide Bindungen.
5. Echter `fetch_ledger` führt genau einen accountweiten Income-Read ohne Typ-/Symbolfilter aus; `-0.000001 USDT` bleibt im Original, Unified-Direction `out`.
6. Echter Aster-Tradeparser macht aus Original-Commission `-0.001` Unified-Fee `+0.001`: Vorzeichenverlust bestätigt.
7. Echter BitMEX-Submit-Serializer lässt Literal `IOC` unverändert: fehlendes natives Mapping bestätigt.
8. Derselbe SDK-Pfad mit `ImmediateOrCancel` erhält richtigen nativen TIF und eigene `clOrdID`.
9. Einzelner abgefangener BitMEX-Stop-Serializer: `Stop`, `stopPx=59000`, `ReduceOnly`, kein `price` und kein `Close`. **Kein Vorschlag für getrenntes Entry→Stop-Trading.**
10. BitMEX-`create_orders` wirft `NotSupported`, ohne `fetch` aufzurufen.
11. Echter BitMEX-Tradeparser zeigt Match-ID statt eigener Exec-ID und den oben beschriebenen Minor-Unit-Feeeffekt; Original `execID` bleibt vorhanden.
12. Echter BitMEX-Ledgerparser setzt fehlende Originalzeit auf 0; Quellenprüfung erforderlich.

Zweite Probe: **vier wirkliche BitMEX-Marktparserfälle**, Ausgabe `passed:4`, `networkCalls:0`: linearer USDT-Perp mit `contractSize=0.000001`; inverse `linear=false`; Quanto `linear=false`; Expiry-Vertrag bleibt `future=true`, `swap=false` mit Ablaufzeit.

Diese Tests belegen Serializer-/Parserverhalten, **nicht** Annahme oder Fillreihenfolge des Providers. Keine vollständige 009-Paritätsklasse wird dadurch als bestanden behauptet.

## 7. Verbindliche spätere Rot-/Grünfälle vor Aster-Attestation

- Unterschiedliche Agent/Main-Identität, falsche Generation/Mode/Chain-ID, verbotene Caller-Overrides, Rotation während Warteschlange; Builder-/Setupcall zählt bereits vor Order als Testfehler. Gleiche Agenten in zwei REST-/Pro-Instanzen, gleiche Millisekunde, Clockrollback und Restart dürfen keine unerkannte Noncekollision freigeben.
- Richtiger vollständiger nativer Batch positiv; vertauschte Antworten nach wirklicher Client-ID, doppelte/missing IDs, Teilannahme, 503, ACK-Verlust, Restart, IOC-Partial/Zero-Fill und verspäteter Fill negativ beziehungsweise sicher recoverbar. Kein künstliches Stop-ACK oder künstlicher Providercancel.
- Unbekannter wartender Strategie-Parent bei leerer normaler Orderliste: Admission und Globalrelease bleiben gesperrt, bis der alternative vollständige Sourcebeweis vorliegt. Eine Liste bekannter eigener IDs darf diesen Fall nicht bestehen lassen.
- Raw-Tiercap, Position-/Orderrest und echter Mark im richtigen Settlement; Sparse-/Overlap-Tier, veralteter Cache, flaches Symbol ohne Modusfeld, Hedge/MultiAsset drift sowie nicht dokumentierte Originalkontraktgröße ablehnen. Risikobudget und Entry-TTL unverändert.
- Income: identische `tranId` in verschiedenen Typen, Replay/Overlap, UTC-Wechsel, Revisionkonflikt, verspätete negative Buchung, volle 1000er-Seite, unteilbare 1000er-Millisekunde, fehlendes Asset/Datum, Fee/Rebate/Teil-PnL und unbekannter Bonus. Keine doppelte Buchung mit eigenem Fill. Native USDT positiv; fehlende USD-Bewertung ausdrücklich unresolved.
- Historische fremde oder ausgelistete Symbole, fehlende Seitenscopebelege und Retentionsende dürfen niemals bloß wegen leerem Ergebnis Accountfinalität ergeben.
- Pro-Reconnect/Expiry/Duplikate liefern nur Trigger. Alle Zusatzreads einschließlich Auth-/Quellenpfaden werden gezählt; kein eigener Funding-Fünfertopf. Sourcefehler stoppt nicht vorhandenen Schutz/Exit.

Offen für den nächsten Auftrag ist somit eine konkrete Providerzusicherung zur wartenden Strategy-Sicht plus die vollständige Umsetzung/Paritätsprüfung der genannten kleinen Helfer. Kein neuer allgemeiner Auditplan, kein freigeschaltetes Profil.
