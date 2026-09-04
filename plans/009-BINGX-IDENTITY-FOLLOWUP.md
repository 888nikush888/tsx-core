# 009 – BingX: eigene Stop-Identität und aktueller Orderscope

Stand: 2026-09-03; eingefrorene Read-only-Nachprüfung gegen HEAD `f8089277d0667dd45bcf070037800d423fd89254` plus bestehenden Arbeitsstand. Keine Provider-API, Konten, Server oder Trades angesprochen; keine Source-, Profil-, Test- oder Schemaänderung. Untersucht: lineare Swap-Orders im One-way-Modus, LONG und SHORT als Handelsrichtung, nicht Hedge-Positionsmodus. Status bleibt **`pending`**, weder Providerabnahme noch grundsätzlicher BingX-Ausschluss.

## Entscheidung und aktuelle Primärbelege

Die offizielle [Swap-Referenz](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-trade/api-reference.md) beschränkt eigene `clientOrderId` bei Orderanlage auf MARKET/LIMIT. Batchelemente verwenden dieselbe Orderstruktur. Allgemeine Client-ID-Abfragen belegen keine abweichende Zuweisungsregel für STOP_MARKET. Die Referenz nennt außerdem separate Erfolgs-/Fehlerlisten, One-way-Reduce-only und eine eigenständige TWAP-Liste. Abruf: 2026-09-03.

Die aktuelle [docs-v3-Seite](https://bingx-api.github.io/docs-v3/) bestätigt die MARKET/LIMIT-Grenze in den englischen **und** chinesischen Parametertabellen für `POST /openApi/swap/v2/trade/order` und `POST /openApi/swap/v1/trade/cancelReplace`. Batchverarbeitung ist parallel, die Ausführungsreihenfolge ungesichert; ausstehende SL-Menge darf die offene Position nicht übersteigen. `GET /openApi/swap/v2/trade/openOrders` ohne Symbol-/Typfilter umfasst normale und bedingte Orders. TWAP-Parents haben eine separate Liste. Der Changelog vom 2025-08-21 berichtet allerdings korrigierte leere TP-Client-IDs bei Query/Cancel. Das ist ein relevanter Gegenhinweis, aber kein expliziter STOP_MARKET-Anlage-/Timeoutvertrag. Abruf: 2026-09-03.

Nachvollziehbarer Originalbeleg: Die SPA-Daten wurden aus ihrer [offiziell ausgelieferten statischen Datei](https://bingx-api.github.io/docs-v3/static/js/app.1c4e17c5fda5689e3a46.js) als TypeScript-AST gelesen, **nicht ausgeführt**. UTF-8-Datei: 1.247.597 Bytes; SHA-256 `71c6cbea80601051b29ae2e95ff4a13f12764f3e785bc018179ccb588ae75077`. Selektiert wurden die oben genannten URI-/Methodenobjekte, `request.list`/`request.info_en` und der datierte Changelog. Ergänzend gelesen: `GET .../trade/openOrder`, `GET .../trade/order`, `GET .../trade/fullOrder`, `GET /openApi/swap/v1/twap/openOrders`. Kein zweiter dokumentierter immutable Request-Tag für einen unbekannten Standalone-Stop gefunden. Dieser Befund ist begrenzt auf die gelesenen Verträge, kein Beweis, dass eine solche API prinzipiell unmöglich ist.

## Gepinnter SDK und bestehende TSX-Grenze

Gelesene Datei: `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/async_support/bingx.py`, CCXT **4.5.75**, SHA-256 `470066ce94cd455c2c0cac0eb289d65a1f7c2ccb4d6451926db1b8a3dd8880b0`.

| Symbol / Stelle | Tatsächlicher lokaler Befund |
| --- | --- |
| `create_order_request`, 2945; `create_orders`, 3289 | Native Zweierliste an `swapV2PrivatePostTradeBatchOrders`: LIMIT/IOC mit Cap, gegenüberliegender STOP_MARKET ohne Ausführungspreis, `reduceOnly=true`, `positionSide=BOTH`. SDK sendet eigene ID als `clientOrderID`; dies ist nicht identisch geschrieben wie die aktuelle Parameterreferenz. Keine Providerannahme aus SDK-Serialisierung ableiten. |
| `create_orders`, 3382 ff.; `parse_order`, 3410/3747 | Nur `data.orders` wird normalisiert, `data.errors` nicht zurückgegeben. Eigene ID wird aus Originalfeldern gelesen, fehlende ID bleibt fehlend. Große Exchange-IDs aus String-Originalen bleiben exakt. |
| `fetch_order`, 4252/4394; `sign`, 6614 | `fetch_order(None, symbol, {clientOrderId: ...})` nimmt den richtigen nativen Query-Endpunkt, schreibt aber zusätzlich `orderId=None` in den **signierten** Querystring. Ein client-only Raw-Aufruf über den vorhandenen SDK-Endpunkt kann diesen kleinen Fehler umgehen; kein zweiter SDK nötig. |
| `fetch_open_orders`, 4513/4547 | Ohne Symbol: normaler Swap-Orderscope. `params.twap=true` wählt stattdessen den separaten TWAP-Endpunkt. Ein einzelner Standardaufruf liest nicht automatisch beide. |

TSX `exchange_executor/order_identity.py:18/53` verlangt echte eigene Client- und Exchange-ID und korreliert nicht nach Batchindex. `cancel_target:28` kann eine **bereits belegte** Exchange-ID wiederfinden, auch wenn die spätere Antwort ihre Client-ID nicht wiederholt. Nach verlorenem Submit-ACK fehlt aber gerade diese erste Eigentumsbindung. Gleicher Preis, Menge, Seite oder zeitliche Nähe ersetzt sie nicht.

`exchange_executor/ccxt_adapter.py:647/666` verlangt vor Entry keine Position/offene Order am Symbol und sendet danach genau einen Batch. Daraus folgt keine Reihenfolge zwischen seinen Beinen. Bei Zero-/Teilfüllung oder Stopablehnung darf weder vollständiger Schutz noch Nichterzeugung des unbekannten Stops erfunden werden. Der bisherige Unknown-/Recovery-Vertrag bleibt notwendig; wiederholtes Unknown ohne jemals beweisbare Stopidentität wäre keine fertige Integration.

## Tatsächlich ausgeführte Offline-Nachweise

Bestehende fünf Tests erneut grün, **1,167 Sekunden, Exit 0**:

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe' -B -m unittest discover -s exchange_executor/tests -p test_additional_bingx_bitget_requests.py -v
```

Zusätzlich fünf in-memory Probegruppen mit derselben `candidate_client`-Fixture, Exit 0; `fetch` und unerwartete `request`-Aufrufe werfen, nur bekannte native Methoden sind lokale `AsyncMock`s:

1. LONG: Entry BUY/100.5, Stop SELL/90; IOC, BOTH, Reduce-only, kein Stop-Ausführungspreis. Umgekehrte Antwortreihenfolge korrekt über tatsächlich gelieferte IDs korreliert.
2. SHORT: Entry SELL/99.5, Stop BUY/110; dieselben Gegenprüfungen. Große IDs `90071992547409931`/`90071992547409932` bleiben exakt.
3. Client-ID-Query samt echter lokaler Signierung: Query enthält `clientOrderId=tsx-stop`, `symbol=BTC-USDT` und unerwünscht `orderId=None`. Nur erfundene Testcredentials im Speicher, kein Transport; Signatur nicht ausgegeben.
4. Normal-/STOP_MARKET-Originale bleiben im normalen accountweiten Ergebnis erkennbar; zunächst **kein** TWAP-Call. Explizite TWAP-Abfrage macht genau den getrennten symbolfreien Call.
5. Nativer Batch wirft `RequestTimeout`: genau ein Aufruf, keine Erfolgserfindung und kein blinder Retry.

Die permanente bestehende Negativprobe liefert einen Stop ohne Client-ID: `write_order_identity` und `correlate_batch` lehnen ihn als ungeklärt ab. Positive ACK-/Query-Fakes sind ausdrücklich **nur Parser-/Routingbeweise**, keine bestätigten BingX-Antworten.

## Engster nächster Schritt, kein Produktionsauftrag

Erforderlich ist ein konkreter offizieller Vertrag für **STOP_MARKET im Batch**: vorab gesetzter stabiler eigener Schlüssel, erlaubte Schreibweise/Normalisierung, Echo und eindeutiger Lookup nach Timeout einschließlich bereits gefüllter/stornierter Orders; Sichtbarkeits-/Retentiongrenze. Der generische Querytext und die TP-Changelogkorrektur genügen dafür noch nicht. Ebenso muss der bekannte Zero-/Teilfill- und Stopablehnungsfall nachweisbar aufklärbar sein; keine atomare oder geordnete Verarbeitung unterstellen.

Wenn dieser Vertrag bestätigt wird, sind kleine isolierte Helfer plausibel: `bingx_order_identity.py` für korrekt signierten client-only Lookup und Original-ID-Belege; `bingx_current_state.py` für normalen/bedingten **plus** TWAP-Scope ohne Filterverlust, mit bestehendem gemeinsamen Deadline-/Recoverybudget. Eingriffe ausschließlich an vorhandenen Providerhooks, nicht zweite Engine oder separate Entry-dann-Stop-Architektur. Neue dauerhafte Tests müssen die fünf Gruppen oben sowie ID-Duplikate, fremde Symbol-/Kontobindung, fehlende/konfliktierende Stop-ID, Partial-ACK, Timeout/Restart und beide unvollständigen Orderscopes abdecken.

Falls der Anbieter die Client-ID-Zuweisung ausdrücklich ausschließt **und** keinen alternativen immutable Identitätsbeleg bereitstellt, kann kein lokaler Profilflag das verlorene Stop-ACK reparieren. Dann wäre mindestens ein belegbarer neuer Provider-Identitäts-/Parent-Child-Vertrag samt Lifecycle nötig; synthetische Child-ID, geometrische Übernahme oder dauerhafte Sperre sind kein Ersatz. Erst diese bestätigte Grenze rechtfertigt `not_easy` für genau diesen Slice. Gegenwärtig bleibt die widersprüchlich dokumentierte Stopidentität `pending`. Funding, Modus-/Tierabnahme und andere Produktfamilien wurden in diesem Nachlauf nicht erneut geprüft.
