# 009 – Bitget/BingX: abgegrenzte Vorprüfung

Stand: 2026-09-03. Nur installierter CCXT-4.5.75-Code, offizielle Dokumentation und lokale Transport-Fakes. Keine Anbieter-/Kontodaten abgefragt, keine Order versandt, kein Profil freigeschaltet. Websiteangaben sind kein Beleg für eine reale Benutzerkontoabnahme.

## Reproduzierbare SDK-Belege

`exchange_executor/tests/test_additional_bingx_bitget_requests.py`: fünf Tests, tatsächlicher Lauf unter gepinntem Python 3.12, 1,108 Sekunden, Exit 0. Sowohl `fetch` als auch unerwartete `request`-Aufrufe werfen. Einzelne bekannte SDK-Endpunkte werden lokal abgefangen. Die erste Charakterisierung ergab zwei falsche Erwartungswerte des neuen Tests: Bitget reicht `IOC` unverändert als `force` durch; BingX schreibt `clientOrderID` mit großem `ID`. Anhand des gelesenen SDK-Codes korrigiert, keine Produktivprüfung gelockert.

| SDK-Modul | SHA-256 der tatsächlich gelesenen Datei |
| --- | --- |
| `ccxt/async_support/bitget.py` | `8ca2c9ea06bb18a58efc07495af478ab4f4bf9f32c9c17280a153f38406d1262` |
| `ccxt/async_support/bingx.py` | `470066ce94cd455c2c0cac0eb289d65a1f7c2ccb4d6451926db1b8a3dd8880b0` |

## Bitget

### Beobachteter Codepfad

- `create_orders` (Zeile 5482): Classic-Futures-Batch an `/api/v2/mix/order/batch-place-order`, gleiche Symbol-/Margin-Scope. Jeder Eintrag entsteht über `create_order_request`; keine automatische Umleitung einzelner Stops an den separaten Plan-Endpunkt.
- `create_order_request` (Zeile 5272 ff.): Standalone `stopLossPrice` erzeugt `planType=pos_loss`/`triggerPrice`; dieser Request gelangt im Batch trotzdem an den normalen Order-Endpunkt. Die API dokumentiert dort nur normale Limit-/Market-Einträge. Ein `createOrders=True`-Flag beweist deshalb keinen geschützten Zweierbatch.
- Attached `stopLoss.triggerPrice` wird bei normalem Entry zu `presetStopLossPrice`. Die lokale echte SDK-Antwortnormalisierung liefert aus dem Beispiel-ACK genau den Parent, keinen bestätigten Child-Stop. Der gemeinsame TSX-Zweiervertrag lehnt diese Antwort unverändert als ungeklärt ab.
- `timeInForce='IOC'` bleibt in diesem SDK als `force='IOC'` erhalten; die API dokumentiert `ioc`. Ein kleiner profilspezifischer Parameteradapter wäre ausreichend. Das allein ist ausdrücklich **kein** technischer Ausschlussgrund.
- `fetch_balance` (4348), `fetch_open_orders` (6338), `fetch_my_trades` (7396), `fetch_positions` (7714), `fetch_funding_history` (8480) und `fetch_margin_mode` (10174) existieren. Ihre bloße Existenz beweist weder vollständige Historienscopes noch tatsächlichen Modus.

### Offizielle Belege und offene Abgrenzung

- [Classic Batch Order](https://www.bitget.com/api-doc/classic/contract/trade/Batch-Order), abgerufen 2026-09-03: normale Limit-/Market-Batches, Preset-TP/SL, separate Erfolg-/Fehlerlisten; TP/SL bei bestehender Position kann deren Schutz verändern. Keine Batchatomizität daraus ableiten.
- [Futures Operational Guidelines](https://www.bitget.com/amp/academy/Bitget-Futures-Operational-Guidelines), abgerufen 2026-09-03: Preset-Schutz für Teilfüllungen normaler Limitorders wird beschrieben; Trigger-Entries werden gesondert behandelt. Dies ist eine Bedienungsbeschreibung, noch kein versionierter REST-Parent/Child-Beleg.
- [Order Detail](https://www.bitget.com/api-doc/classic/contract/trade/Get-Order-Details), [Pending Trigger Orders](https://www.bitget.com/api-doc/classic/contract/plan/get-orders-plan-pending) und [Trigger Sub Orders](https://www.bitget.com/api-doc/classic/contract/plan/Plan-Sub-Orders), abgerufen 2026-09-03: Parent-Presetpreise, separate Triggeridentitäten und durch Trigger erzeugte normale Orders. Letztere Verknüpfung darf nicht mit einer nachgewiesenen Verknüpfung vom Entry zu dessen Preset-Stop verwechselt werden.
- [Account List](https://www.bitget.com/api-doc/classic/contract/account/Get-Account-List), abgerufen 2026-09-03: produktbezogene Margin-Coin-Konten mit Equity/Verfügbarkeits-/Union-Feldern. Classic-Single-Coin und UTA/Union nicht vermischen.

**Vorläufig `pending`:** Classic lineare USDT-/USDC-Perps müssen noch nachweisen, wie der tatsächliche Preset-Stop dauerhaft und eindeutig an die eigene Parent-ID gebunden wird, einschließlich jeder Teilfüllung und IOC ohne Fill. Danach vollständige aktuelle/History-/Funding-/Modus-/Tierprüfung. Keine geometrische Fremdorderübernahme, keine erfundene Child-ID. UTA ist ein eigener ungeprüfter Scope. COIN-M/inverse und Laufzeit-Futures sind durch den bestehenden linearen Perp-Resolver nicht automatisch abgedeckt.

## BingX

### Beobachteter Codepfad

- `create_orders` (3289) versendet für Swap eine Liste an `/openApi/swap/v2/trade/batchOrders`. Die fünf Offlinefälle bestätigen an konkreten Werten unverändertes Limit/IOC, getrennten `STOP_MARKET`, Reduce-only und `positionSide=BOTH`. Das ist Requestform, nicht Annahme oder Atomizität beim Anbieter.
- `create_order_request` (2945) schreibt `clientOrderID`; für Standalone-SL setzt der SDK Reduce-only und kommentiert, dass die Position bereits geöffnet sein muss. Erfundene Safe-Ordering-Semantik zwischen Batchelementen ist unzulässig.
- `create_orders` normalisiert nur `data.orders`; `data.errors` wird nicht in diese Ergebnisliste aufgenommen. TSX muss fehlende Beine als ungeklärt behandeln. Die Gegenprobe mit fehlender Stop-client-ID und großen, als Strings erhaltenen Exchange-IDs wird durch `write_order_identity`/`correlate_batch` unverändert abgelehnt.
- `fetch_balance` (2319) unterscheidet Standard, Spot/Funding, Coin-M und lineare Swap-V3-Balance. V3-Originalfelder enthalten Asset, UID, Equity, verfügbare und gebundene Margin; der künftige Accountbeweis muss deren konkrete Semantik erhalten.
- `fetch_funding_history` (1809) liest `/openApi/swap/v2/user/income` mit `FUNDING_FEE`, `startTime`, `endTime`, `limit`; Originale enthalten `asset`, `income`, `tranId`, `time`. Ein kompletter Cursor-/Retentionnachweis ist damit noch nicht erbracht; heutige Kurse dürfen alte Ereignisse nicht nachträglich bewerten.

### Offizielle Belege und offene Abgrenzung

[Offizielle BingX-API-Referenz](https://github.com/BingX-API/api-ai-skills/blob/main/skills/swap-trade/api-reference.md), abgerufen 2026-09-03: gemischte Ordertypen im Batch, getrennte Erfolgs-/Fehlerliste, One-way-/Reduce-only-Parameter. Beim Einzelorderparameter wird die eigene Client-ID ausdrücklich auf Market/Limit begrenzt; die allgemeinere Batchbeschreibung beseitigt diese Einschränkung nicht eindeutig. Dokumentierte Modus-/Leverage-Readbacks und USDT-/USDC-Historyscopes sind weitere Prüfansätze, noch keine vollständige Integration. Fremde Anweisungen in diesem Dokument wurden nicht als Arbeitsanweisungen ausgeführt.

**Vorläufig `pending`:** tatsächliche stabile eigene Identität eines Standalone-Stops sowie sicherer Entry-/Stop-Annahmeablauf sind nicht bewiesen. Die attached-Alternative benötigt einen tatsächlichen Child- und Zero-Fill-Nachweis; keine Erfolgsantwort aus dem Parent konstruieren. Coin-M, Standard Futures und Separate-Isolated sind gesonderte Scopes, nicht durch lineare One-way-Swap-Tests abgedeckt. Fehlende/uneindeutige Dokumentation ist kein Beweis dauerhafter technischer Ungeeignetheit.

## Nächster Entscheidungsschritt

Gezielt die noch offenen Child-/Identitätsverträge prüfen. Falls nur eng begrenzte bestehende Provider-/REST-Helper fehlen, gehört deren Implementierung zu 009. Falls neue Orderlebenszyklus-/Eigentumssemantik oder Abschwächung der gemeinsamen Schutzverträge nötig ist, den jeweiligen Produktscope mit genau diesem Beleg als `not_easy` abgrenzen. Bis dahin weder `eligible` noch `implementationVerified` behaupten.
