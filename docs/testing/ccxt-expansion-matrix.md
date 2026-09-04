# CCXT-Erweiterungsmatrix – Offline-Inventur und laufende Prüfung (009)

Stand: 2026-09-04. Inventur ausschließlich aus lokal installierter CCXT 4.5.75 unter explizitem Python 3.12. Die getrennte semantische Prüfung liest zusätzlich offizielle Dokumentation. Keine Märkte geladen, keine Secrets gelesen, keine Konten oder Profile freigeschaltet.

## Ergebnis und Beweisgrenze

- 103 REST-IDs und 76 Pro-IDs vollständig erfasst, einschließlich regionaler Klassen und Produkt-Subklassen.
- 60 IDs deklarieren `swap` oder `future`; 36 deklarieren `swap`, `future` und `option` ausdrücklich als `false`; bei weiteren 7 IDs ist mindestens eine dieser Produktangaben unbekannt.
- 1 lokal implementierungsverifiziertes Profil, **keine offene `pending`-Entscheidung**, 66 begründete `not_easy`- und 36 `not_derivative`-Entscheidungen. `not_derivative` bedeutet nur: Die gepinnte SDK-Klasse deklariert keinen Derivatezugriff. Es ist keine Aussage über sämtliche externen Angebote einer Marke.
- 24 IDs bestehen den unveränderten REST-/Pro-/Credential-Vorfilter. Ein positives SDK-Flag belegt weder geschützten Entry noch Kontomodus, Historyvollständigkeit, Geldpfad oder leichte Integrierbarkeit. Die 41 Vorfilterausschlüsse beruhen auf der getrennten, dateigehashten Prüfung des unverändert vorgeschriebenen Pins und Registry-Vertrags in [009-PINNED-CAPABILITY-BOUNDARIES.md](../../plans/009-PINNED-CAPABILITY-BOUNDARIES.md), nicht auf einer vermeintlichen generellen Unfähigkeit der Börsen-API. Die rohe Inventur generiert weiterhin `pending`, bis eine begründete Bewertung ergänzt wurde.
- Sämtliche Inventurfelder `implementationVerified` und `providerAcceptanceVerified` sind `false`. Auch vorhandene einfache Bool-Attestationen bestehen den neuen Completionnachweis nicht.

Vorfiltermenge (inklusive bestehender Profile, keine neue Zulassung):

`apex`, `aster`, `binance`, `binancecoinm`, `binanceusdm`, `bingx`, `bitget`, `bitmex`, `bybit`, `deepcoin`, `extended`, `gate`, `grvt`, `hyperliquid`, `krakenfutures`, `kucoin`, `kucoinfutures`, `modetrade`, `myokx`, `okx`, `weex`, `woo`, `woofipro`, `xt`.

## Semantischer Nachlauf

Neben den 41 unverändert pflichtbedingten Ausgrenzungen sind alle vorgefilterten Kandidaten anhand konkreter Produkt-, Schutz-, Identitäts-, History- und SDK-Grenzen entschieden. Belege mit echten Dateihashes stehen pro ID im JSON: [Binance/OKX](../../plans/009-BINANCE-OKX-RESEARCH.md), [Aster/BitMEX](../../plans/009-ASTER-BITMEX-RESEARCH.md), [MyOKX/Aster-Folgebeleg](../../plans/009-MYOKX-ASTER-FOLLOWUP.md), [ApeX/Regionalklassen/GRVT](../../plans/009-ADDITIONAL-CANDIDATE-BOUNDARIES.md), [Bitget/BingX](../../plans/009-BITGET-BINGX-RESEARCH.md), [WOO/Orderly/Mode Trade/XT](../../plans/009-WOO-XT-RESEARCH.md), die drei Kandidatengruppen und die [unabhängige KuCoin-Futures-Schlussprüfung](../../plans/009-KUCOINFUTURES-INDEPENDENT-FINAL-REVIEW.md). Fehlende Dokumentationszusicherungen wurden nicht als Fähigkeit erfunden; jede `not_easy`-Entscheidung benennt eine konkret belegte größere Vertragsgrenze.

Acht zusätzliche permanente SDK-Grenztests, fünf Bitget-/BingX-, zehn Binance-/OKX- und 27 Kandidatengruppen-Charakterisierungen sind lokal grün. Das isolierte KuCoin-Teilpaket ergänzt 22 Raw-/SDK-Grenztests; zusammen mit den 13 bestehenden KuCoin-Contracttests waren **35/35** grün. Der letzte vollständige Python-Nachlauf vor diesem eingefrorenen KuCoin-Teilpaket bestand mit 479 Tests; ein erneuter Gesamtlauf folgt nach dem Source-Freeze. MyOKX ist kein vollständiger OKX-Alias: regionale Vererbung, signierter Parent-only-ACK und Ablaufdatum sind separat belegt. KuCoin und KuCoin Futures bleiben getrennt gesperrt: parallele IDs würden dieselbe reale Classic-Identität doppelt abbilden; der einzig denkbare kanonische Futurespfad benötigt einen neuen Kapazitätsvertrag und kann vollständige accountweite Funding-Finalität für ausgelistete Symbole nicht belegen. Kein zusätzliches Profil ist freigegeben; echte Providerabnahme bleibt davon getrennt.

Der lokale Runtime-Reviewanker enthält ausschließlich den revisions- und quellgenau gebundenen Hyperliquid-V2-Receipt im verengten Master-Key-only-/USDC-Perp-Scope. Bybit und Kraken Futures bleiben trotz vorhandener Profildeklarationen quarantined: Bybit wegen unbewiesener accountweiter Option-/Pre-upgrade-/delisteter Fillfinalität, Kraken wegen des unbewiesenen geschützten IOC+Stop-Vertrags und weiterer Quellenlücken. Alte Sieben-Bool-Dateien erteilen keine Freigabe. Der Server wurde nicht geändert; Providerabnahme bleibt getrennt. Runtime-/Build-/Providergrenzen stehen im [Bridge-Review](../../plans/009-CERTIFICATION-BRIDGE-REVIEW.md).

## Maschinenlesbarer Vertrag

`ccxt-expansion-matrix.json` hat `schemaVersion: 1`, eine getrennte statische `inventory`, deren `inventoryHash`, und genau eine `assessment` pro REST-ID. Die statische Inventur wird beim Prüfen vollständig aus dem installierten Pin rekonstruiert; unbekannte Zusatzfelder, Mengenverlust, Duplikate, falsche Aliase, Flag-/Methoden-/Quellhashdrift oder selbst behauptete Zertifizierung werden verweigert.

Die globale Tabelle enthält 291 deduplizierte Quelldateien und 1.694 Methodenbelege: relativer Pfad, echte installierte Dateibytes/SHA256 sowie Methoden-Zeilenbereich und SHA256 der tatsächlich installierten Originalzeilen. Der gemeinsame Sourcehash erfasst auch unveränderte lokale Profil-, Pflicht- und Credentialverträge und dieses Inventurwerkzeug. Kein `describe()`- oder API-Endpunktbaum wird kopiert.

Pro ID werden die ausgewählten relevanten REST-/Pro-Flags unverändert gespeichert: `true` → `native`, `'emulated'` → `emulated`, `false`/`null` → `missing`. `declared` trennt vorhandene Nullangaben von fehlenden Keys. `native` ist hier nur die genaue CCXT-Deklaration, keine unabhängige Providerzertifizierung. Methodenbelege schließen generische/inherited Implementierungen ausdrücklich ein.

Produkt-Slices entstehen nur für tatsächlich deklarierte `swap`-/`future`-Typen. Linear-/Inverse-Untertypen stammen ausschließlich aus vorhandenen SDK-Featurezweigen; andernfalls heißt der Typ `unknown`. Sie sind `sdk_declared_only`, nicht tatsächlich beobachtete Angebote. Settlement, ContractSize, Ablaufdetails, Quanto, effektiver Kontomodus, Live-/Testnet-Produktkombinationen sowie Fee-/Fundingwährungen bleiben offen. Keine kartesisch erfundenen Produktangebote, aktuellen Instrumentlisten oder impliziten Perp/Future-Aliase.

REST-/Pro-Hostlisten sind deduplizierte wörtliche SDK-URLdeklarationen samt getrenntem `hostname`. Geerbte globale Endpunkte können auch in regional eingeschränkten Klassen stehen; `productApplicability: unknown` und `reachable: null` verhindern eine Host-/Zulassungsbehauptung. `documents[].fetchedAt: null` bedeutet ungeprüfte Dokument-URL aus dem SDK, keinen Abrufbeleg.

`canonicalId` bleibt jede tatsächliche ID selbst. `inheritsFrom` plus Klassen-/Sourcebeleg dokumentiert Implementierungsvererbung, niemals eine beleglose Markenaliasbeziehung. Insbesondere `bybiteu`, `gateeu`, `myokx`, `okxus`, `binanceus`, `binancecoinm`, `binanceusdm` und `kucoinfutures` bleiben getrennt. `aliasOf` ist mangels darüber hinaus belegter Identität `null`.

## Prüfbefehle

Im Repository, stets mit dem expliziten isolierten Interpreter:

```powershell
$tsxPython = 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe'
& $tsxPython -B exchange_executor/tools/audit_derivatives_candidates.py --offline
& $tsxPython -B exchange_executor/tools/audit_derivatives_candidates.py --offline --verify-inventory docs/testing/ccxt-expansion-matrix.json
& $tsxPython -B exchange_executor/tools/audit_derivatives_candidates.py --offline --verify-complete docs/testing/ccxt-expansion-matrix.json
& $tsxPython -B -m unittest discover -s exchange_executor/tests -p test_additional_exchange_profiles.py
```

Der erste Befehl emittiert die reproduzierbare JSON-Inventur nur nach stdout. Das Werkzeug schreibt keine Dateien. `--offline` ist auch ohne Argument Standard; `--public-markets` wird in dieser ersten Stufe abgewiesen. JSON bleibt auf 8 MiB begrenzt; doppelte Keys und nichtendliche Werte werden verweigert.

`--verify-inventory` und der fest im Code gebundene `--verify-complete`-Pfad wurden nach der letzten Kandidatenentscheidung erfolgreich ausgeführt. Der Completionpfad prüft den vollständigen Assessmenthash, alle 84 dateigebundenen Belege und für `existing` zusätzlich den echten V2-Receipt; Manifest-Bools oder ein frei injizierter CLI-Verifier können keine Freigabe erzeugen. Providerabnahme wird weiterhin nie daraus abgeleitet.

Die spätere feste Root-Komposition kann `validate_complete(document, completion_verifier=...)` verwenden. Der vertrauenswürdige, ausschließlich durch Code eingesetzte Verifier muss für jeden nicht rein nichtderivativen Fall einen typisierten `CompletionVerdict` mit exaktem Inventurhash und Exchange-ID, geprüfter Entscheidung und gegebenenfalls echter Implementierungsverifikation zurückgeben. Formatprüfung allein genügt nicht. Es gibt keine dynamischen Imports oder Commands aus Manifestpfaden, keinen CLI-Bypass und keine Providerfreigabe aus diesem Hook. Die positive Hook-Fixture demonstriert nur die zukünftige Schnittstelle, keine erfolgreiche reale Paritätsprüfung.

## Permanente lokale Prüfungen

Die fokussierten Tests prüfen reale installierte Mengenabdeckung/Pin, reproduzierbare Daten, rohe emulierte Flags, regionale Vererbung, nachvollziehbare Spot-Ausgrenzung, offene fehlende Pflichtfähigkeiten, Produkt-Ungewissheit, Source-/Methodenbindung, fehlende oder manipulierte Inventurteile, striktes JSON, fehlende echte Completionbelege sowie gebundene zukünftige Verifierausgaben.

Der Null-Netzwerk-Test blockiert tatsächliche Socket-/DNS-/Child-Prozess-/CCXT-Fetch-/Market-/Credentialcheckpfade und gestattet Dateilesen nur unter dem installierten CCXT-Paket, dessen exakter METADATA und den vier benannten lokalen Inventurvertragsdateien. Separat wird ein absichtlich netzwerkaufrufender Konstruktor durch den eingebauten Offlineguard abgefangen. Das ist Python-Prozessisolation als Testnachweis, keine behauptete OS-Sandbox.

## Vollständige ID-Entscheidungen

`S/W/F/O` bezeichnet die rohen Spot/Swap/Future/Option-Flags (`1`, `0`, `?`). Die letzte Spalte nennt fehlende native gemeinsame Pflichten. Ein `not_easy`-Entscheid benötigt zusätzlich den in `assessments[].evidence` gebundenen Ausschlussbeleg. Alle Detailbelege stehen im JSON.

| ID | S/W/F/O | Entscheidung | Fehlende native Pflichten |
| --- | --- | --- | --- |
| alpaca | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchPositions |
| apex | 0/1/0/0 | not_easy | — |
| aster | 1/1/0/0 | not_easy | — |
| backpack | 1/1/0/0 | not_easy | rest.setLeverage, pro.watchMyTrades |
| bequant | 1/0/?/? | not_easy | pro.watchMyTrades, pro.watchPositions |
| bigone | 1/1/?/0 | not_easy | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| binance | 1/1/1/1 | not_easy | — |
| binancecoinm | 0/1/1/? | not_easy | — |
| binanceus | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchPositions |
| binanceusdm | 0/1/1/? | not_easy | — |
| bingx | 1/1/0/0 | not_easy | — |
| bit2c | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| bitbank | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| bitbns | 1/0/0/? | not_easy | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| bitfinex | 1/1/0/0 | not_easy | rest.setLeverage, pro.watchPositions |
| bitflyer | 1/?/?/0 | not_easy | rest.fetchOpenOrders (emulated), rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| bitget | 1/1/1/0 | not_easy | — |
| bithumb | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchMyTrades, rest.setLeverage, pro.watchMyTrades, pro.watchPositions |
| bitmex | 1/1/1/0 | not_easy | — |
| bitopro | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchPositions |
| bitrue | 1/1/0/0 | not_easy | rest.fetchPositions, pro.watchMyTrades, pro.watchPositions |
| bitso | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| bitstamp | 1/1/0/0 | not_easy | rest.fetchPositions, rest.setLeverage, pro.watchMyTrades, pro.watchPositions |
| bitteam | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| bittrade | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| bitvavo | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchPositions |
| blockchaincom | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchMyTrades, pro.watchPositions |
| blofin | 0/1/0/0 | not_easy | pro.watchMyTrades |
| btcbox | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchMyTrades, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| btcmarkets | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| btcturk | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| btse | 1/1/1/0 | not_easy | pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| bullish | 1/1/1/1 | not_easy | rest.setLeverage |
| bybit | 1/1/1/1 | not_easy | accountweite Option-/Pre-upgrade-/delistete Fillfinalität unbewiesen |
| bybiteu | 1/0/0/? | not_easy | — |
| bydfi | 0/1/0/0 | not_easy | rest.cancelOrder, pro.watchMyTrades |
| cex | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchMyTrades, rest.setLeverage, pro.watchPositions |
| coinbase | 1/1/1/0 | not_easy | rest.setLeverage, pro.watchMyTrades, pro.watchPositions |
| coinbaseexchange | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchPositions |
| coinbaseinternational | 1/1/0/0 | not_easy | rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| coincheck | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| coinex | 1/1/0/0 | not_easy | pro.watchPositions |
| coinmate | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| coinone | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| coinsph | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| coinspot | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchOpenOrders, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| cryptocom | 1/1/1/0 | not_easy | rest.setLeverage |
| cryptomus | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchMyTrades, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| deepcoin | 1/1/0/0 | not_easy | — |
| delta | 1/1/0/1 | not_easy | pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| deribit | 1/1/1/1 | not_easy | rest.setLeverage, pro.watchPositions |
| derive | 1/1/0/1 | not_easy | rest.setLeverage, pro.watchPositions |
| digifinex | 1/1/0/0 | not_easy | pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| dydx | 0/1/0/0 | not_easy | rest.fetchMyTrades, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| extended | 1/1/0/0 | not_easy | — |
| fmfwio | 1/1/0/0 | not_easy | pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| foxbit | 1/?/?/? | not_easy | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| gate | 1/1/1/1 | not_easy | — |
| gateeu | 1/0/0/? | not_easy | — |
| gemini | 1/1/0/0 | not_easy | rest.fetchPositions, rest.setLeverage, pro.watchMyTrades, pro.watchPositions |
| grvt | 0/1/0/0 | not_easy | — |
| hashkey | 1/1/0/0 | not_easy | pro.watchPositions |
| hibachi | 0/1/0/0 | not_easy | rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| hitbtc | 1/1/0/0 | not_easy | pro.watchMyTrades, pro.watchPositions |
| hollaex | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchMyTrades, pro.watchPositions |
| htx | 1/1/1/? | not_easy | pro.watchPositions |
| hyperliquid | 1/1/0/0 | existing | — |
| independentreserve | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| indodax | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchMyTrades, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| kraken | 1/0/0/0 | not_derivative | rest.setLeverage, pro.watchPositions |
| krakenfutures | 0/1/1/0 | not_easy | geschützter IOC+Stop-Providervertrag und Client-only-Recovery unbewiesen |
| kucoin | 1/1/1/0 | not_easy | — |
| kucoinfutures | 0/1/1/? | not_easy | — |
| latoken | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| lbank | 1/?/0/0 | not_easy | rest.fetchPositions, rest.setLeverage, pro.watchMyTrades, pro.watchPositions |
| lighter | 1/1/0/0 | not_easy | pro.watchPositions |
| luno | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| mercado | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchMyTrades (emulated), rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| mexc | 1/1/0/0 | not_easy | pro.watchPositions |
| modetrade | 0/1/0/0 | not_easy | — |
| mudrex | 0/1/0/0 | not_easy | pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| myokx | 1/1/0/0 | not_easy | — |
| nado | 1/1/0/0 | not_easy | rest.setLeverage |
| ndax | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| okx | 1/1/1/1 | not_easy | — |
| okxus | 1/0/0/0 | not_derivative | — |
| onetrading | 1/1/0/0 | not_easy | rest.fetchPositions, rest.setLeverage, pro.watchPositions |
| p2b | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| pacifica | 1/1/0/0 | not_easy | pro.watchPositions |
| paradex | 0/1/0/0 | not_easy | pro.watchMyTrades, pro.watchPositions |
| paymium | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchOpenOrders, rest.fetchMyTrades, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| phemex | 1/1/0/0 | not_easy | pro.watchPositions |
| poloniex | 1/1/0/0 | not_easy | pro.watchPositions |
| tokocrypto | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| toobit | 1/1/0/0 | not_easy | pro.watchPositions |
| upbit | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchMyTrades, rest.setLeverage, pro.watchPositions |
| weex | 1/1/0/0 | not_easy | — |
| whitebit | 1/1/0/0 | not_easy | pro.watchPositions |
| woo | 1/1/0/0 | not_easy | — |
| woofipro | 0/1/0/0 | not_easy | — |
| xt | 1/1/1/0 | not_easy | — |
| zaif | 1/0/0/0 | not_derivative | rest.fetchPositions, rest.fetchMyTrades, rest.setLeverage, pro.watchOrders, pro.watchMyTrades, pro.watchPositions |
| zebpay | 1/1/0/? | not_easy | pro.watchOrders, pro.watchMyTrades, pro.watchPositions |

Offene Arbeiten nach 009: abschließende Gesamtprüfung 008 und – nur nach gesonderter Autorisierung – reale Provider-/Testnetabnahme. Die 66 `not_easy`-Kandidaten werden erst nach Umsetzung ihrer jeweils benannten größeren Architekturverträge erneut bewertet. Bybit und Kraken Futures bleiben bis dahin ebenso fail-closed wie neue Kandidaten.
