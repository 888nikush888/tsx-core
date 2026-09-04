# 009 – Kandidatengruppe B: Extended, Gate und KuCoin

Stand: 2026-09-04. Geprüft wurden ausschließlich die installierten CCXT-/CCXT-Pro-4.5.75-Quellen, offizielle Primärdokumentation und lokale Fakes. Es gab keine DNS-/Providerverbindung, keine Kontodaten, keine Secrets, keine Order und keine Profil-, Receipt- oder Providerfreigabe.

## Entscheidung

| CCXT-ID | Entscheidung für 009 | Enger Grund |
| --- | --- | --- |
| `extended` | `not_easy` | Der native Attached-Stop hat beim Submit keine eigene Kindidentität. Der Parent-ACK ist asynchron; zugleich kann terminale Nullfüllungs-Historie abhängig von der Kontoklasse nach sieben Tagen oder sogar sofort fehlen. Der vorhandene TSX-Adapter verlangt dagegen zwei dauerhaft korrelierbare Legs. Das erfordert einen neuen gemeinsamen Attached-Child-/Stream-Lifecycle und ist kein kleiner Provideradapter. |
| `gate` | `not_easy` | Der gepinnte normale CCXT-Batch lehnt das bestehende separate Stop-Leg vor jedem Send ab. Native `tpsl_*`-Felder passieren zwar den Parentrequest, liefern in diesem Modell aber keine zweite eigene ACK-/Kindidentität. Separate Price-Orders wären zwei ungeschützte Writes. Auch hier wäre ein neuer gemeinsamer Attached-Child-Lifecycle erforderlich. |
| `kucoin` | `eligible`, ausschließlich Classic linearer USDT-Perp | Der dokumentierte Classic-Batch und die installierte Implementierung können begrenzten IOC-Entry und separat identifizierten Reduce-only-Stop in **einem** Request mit per-Leg `clientOid`/`orderId` abbilden. Alle nötigen privaten Readbackbereiche existieren; gefährliche Normalisierungen können durch enge Raw-Helper umgangen werden. |
| `kucoinfutures` | `eligible`, derselbe enge Classic-USDT-Perp-Vertrag | Die Klasse erbt genau dieselbe Classic-Ausführung und dieselben Pro-Streams, setzt aber Futures-/Swap-Discovery als Default und deaktiviert Spot. Sie ist ein eigener CCXT-Identifier, kein zweiter Handelsplatz. Implementierungsbelege können gemeinsame Providerhelper verwenden, die Kontobindung muss Doppel-Ausführung desselben realen Kontos verhindern. |

`eligible` bedeutet hier nur: vollständig lokal innerhalb der bestehenden TSX-Architektur implementierbar. Beide KuCoin-IDs bleiben bis zu Profil, vollständiger Paritätsmatrix, unabhängiger Receipt-Bindung und späterer separat autorisierter Providerabnahme gesperrt. UTA, Isolated, USDC, inverse/Quanto-Erweiterungen, Ablauf-Futures und Copy-Trading sind nicht umfasst.

## Extended: warum der offene Punkt jetzt `not_easy` ist

Die [offizielle Extended-Dokumentation](https://api.docs.extended.exchange/#create-or-edit-order) verlangt für jede Order einschließlich Market-/TPSL-Ausführung einen Preis; Market arbeitet als begrenzter IOC. Attached-SL und Parent tragen getrennte Settlement-Signaturen, die Create-Antwort enthält jedoch nur Parent-`id` und Parent-`externalId`. Orderanlage und Cancel sind ausdrücklich asynchron. Die Dokumentation zur [Orderhistorie](https://api.docs.extended.exchange/#get-orders-history) begrenzt geschlossene, ungefüllte Orders auf sieben Tage; bei als High-Volume klassifizierten Konten werden terminale Nullfüllungen laut offizieller Rate-Limit-/Retention-Beschreibung gar nicht archiviert. REST allein kann daher ein verlorenes ACK bzw. eine späte Ablehnung nicht dauerhaft beweisen.

Der tatsächliche Pin bestätigt die entscheidende Formgrenze: `create_extended_order_request` erzeugt einen Parent mit `id`, aber im `stopLoss`-Objekt weder `id` noch `externalId`; `create_order` gibt genau einen Parent-ACK zurück und setzt lokal zunächst `NEW`. Der vorhandene `CcxtAdapter.submit_protected_entry` übermittelt und korreliert hingegen zwei eigenständige Specs/Ergebnisse. Eine sichere Extended-Integration müsste deshalb mindestens:

1. einen neuen typisierten Attached-Child-Receipt samt Provider-Lifecycle einführen;
2. Parent-/Kindstatus, Partial-/Zero-Fill und Replace/Cancel über einen dauerhaft ingestierten privaten Stream plus REST-Snapshot beweisen;
3. den preisgebundenen Marketstop ohne Änderung des Nutzer-Triggerpreises als eigenes Ausführungslimit planen;
4. Restart, Streamlücke und kontoklassenabhängige fehlende Nullfill-Historie fail-closed behandeln.

Das ändert gemeinsame Schutz-, Recovery- und Receiptsemantik. Es liegt damit außerhalb der Definition „kleiner Provideradapter“, obwohl die Stark-Signierung selbst im gepinnten CCXT enthalten ist.

## Gate: Syntax ist kein Kind-Lifecycle

Die [offizielle Gate-Futures-Referenz](https://www.gate.com/docs/developers/apiv4/en/) dokumentiert seit Mai 2026 `tpsl_tp_trigger_price` und `tpsl_sl_trigger_price` auf Futures-Orders. Diese aktuelle API-Syntax ist kein Beleg für einen zum TSX-Zweierjournal passenden Kindauftrag. Im Pin verhält sich der Standardpfad zweigeteilt:

- `create_orders_request` lehnt `triggerPrice`, `stopPrice`, `takeProfitPrice` oder `stopLossPrice` in einem normalen Batch mit `NotSupported` ab, bevor Transport möglich ist;
- `create_order_request` reicht ein unbekanntes natives `tpsl_sl_trigger_price` am Parent durch, besitzt dort aber nur das Parentfeld `text`, keine zweite Client-/Exchange-ID;
- eine einheitliche CCXT-Stoporder wird über den separaten `/futures/{settle}/price_orders`-Pfad erzeugt und ist daher kein gemeinsamer geschützter Send.

Gate kann erst nach einem neuen Attached-Child-Vertrag erneut bewertet werden: native Kind-ID/Existenz nach Parent-ACK, Partial-/Zero-Fill-Aktivierung, Mengenänderung, Cancel-/Late-Fill-Finalität sowie vollständige Current-State-/History-/Accountbook-Korrelation müssen dann separat nachgewiesen werden. Bloßes Durchreichen der neuen Felder oder zwei sequenzielle Writes bleibt verboten.

## KuCoin: konkreter enger Implementierungsvorschlag

Die [offizielle Classic-Batch-API](https://www.kucoin.com/docs-new/rest/futures-trading/orders/batch-add-orders) erlaubt bis zu 20 Limit-, Market- und Stoporders in einem Request und antwortet je Leg mit `orderId`, `clientOid`, `symbol`, `code` und `msg`. Das ist keine Atomizität; es passt aber zum bestehenden TSX-Vertrag, der gemischte Annahme, verlorenen ACK und nachfolgenden autoritativen Readback bereits als eigene Zustände modelliert. Die installierte `kucoinfutures`-Klasse erbt `create_contract_orders`, Order-/Fill-/Fundingparser und Pro-Streams unverändert von `kucoin`; nur Discovery/Defaults unterscheiden sich.

### Exakter Profilscope

- `defaultType=swap`, Quote und Settlement ausschließlich `USDT`, nur Classic;
- original belegt: aktiver linear ausgezahlter Perpetual, kein Ablaufdatum, keine inverse oder andere Settlementform;
- `positionSide=BOTH`, tatsächlich roh gelesener One-Way-Modus;
- tatsächlich roh gelesener `CROSS`-Marginmodus und symbolgebundener Cross-Leverage-Readback;
- Schutz: `certified_batch` aus begrenztem Limit-IOC-Entry plus gegengerichtetem Reduce-only-Marketstop, beide mit eigener TSX-Client-ID;
- SDK-Menge ausschließlich über den vorhandenen exakten Integer-/ContractSize-Helper; keine Float-, Rundungs- oder Truncationkonvertierung;
- Credentials `apiKey`, `secret`, `password`; zusätzliche UID/Subaccount-/Generationbindung aus der authentifizierten API-Key-Info, nie aus UI-Eingaben;
- Modus vorerst nur `live`, weil der Pin keinen belegten fillfähigen Classic-Futures-Testnethost deklariert. `/orders/test` ist keine Providerabnahme.

### Kleine Providerhelper, vorhandene gemeinsame Engines

1. **Mode/Identity/Execution:** Rohantworten für API-Key-Info, Accountmode `CLASSIC`, Positionmode `0`, Marginmode `CROSS` und tatsächlichen Cross-Leveragewert strikt prüfen. Fehlende Felder bleiben unbekannt. Per-Leg-ACK exakt nach `clientOid`, `symbol`, `code` und `orderId` klassifizieren; Cancel-ACK nie als terminal ausgeben.
2. **Current State:** Unter einem bestehenden `CurrentRead` die accountweite Positionsliste, paginierte normale aktive Orders und paginierte ungetriggerte Stoporders lesen. Keine aktuelle Marktliste als historische Scopequelle verwenden.
3. **History/Ownership:** Normale Orderhistorie, Stop-Lookup und Fills mit Original-IDs/-zeiten, festen Zeitfenstern, Cursor und bestehendem Fünf-Read-/Deadlinebudget. Exchange-ID vor Client-ID; keine Ähnlichkeitskorrelation.
4. **Money:** Funding und Futures-Ledger roh lesen. Die [Funding-Referenz](https://www.kucoin.com/docs-new/rest/futures-trading/funding-fees/get-private-funding-history) nennt sechs Monate Retention und höchstens drei Monate pro Zeitfenster. Original-ID, exakte Dezimalstrings, USDT, Vorzeichen und `hasMore` erhalten; nicht den CCXT-Floatwert verwenden.
5. **Capacity:** Symbol-/Preis-/Hebel-gebundene Cross-Limits in die vorhandenen Constraint-/Tier-Fences überführen; Quote und Send an Originalplan, TTL, Credentialgeneration und dieselbe Modusbeobachtung binden.
6. **Streams:** CCXT Pro bleibt nur Aktualisierungstrigger; REST bleibt Autorität. `kucoin` und `kucoinfutures` teilen Provider-Namespace und External-Account-Identität, damit dieselben Credentials nicht als zwei unabhängige Konten doppelt handeln.

Das sind begrenzte Providerübersetzer in bereits vorhandene Current-State-, History-, Money-, Constraint- und Stream-Schnittstellen. Weder ein neues SDK noch eine neue Execution Engine, Datenbankarchitektur oder Signaturinfrastruktur ist nötig. Deshalb `eligible`, nicht bereits `implementationVerified`.

## Permanente lokale Evidenz

Neue Datei: `exchange_executor/tests/test_candidate_group_b_boundaries.py`.

- bindet REST und Pro für alle vier IDs an die tatsächlichen acht CCXT-4.5.75-Dateihashes;
- bestätigt für Extended den einzelnen asynchronen Parent-ACK ohne eigene Attached-Stop-ID;
- bestätigt für Gate sowohl die Null-Send-Ablehnung des Unified-Stop-Batches als auch den identitylosen nativen Parent-Passthrough;
- bestätigt die tatsächliche REST-/Pro-Vererbung und unterschiedlichen Defaults der beiden KuCoin-IDs;
- reproduziert, dass KuCoins Unified-Modeparser bei leeren Originaldaten sicher aussehende Werte `hedged=false` und `cross` erfinden;
- reproduziert den Präzisionsverlust einer originalen Funding-ID oberhalb `2^53`, während `info.id` noch exakt vorhanden ist.

Fokussierter Lauf: **7/7 Tests grün**, anschließend Ruff grün. Alle Clients sperren DNS, Sockettransport, unerwartetes `fetch` und unerwartetes `request`. Die vorhandenen 13 KuCoin-Unit-/SDK-Tests bleiben der separate Beleg für exakte Contractmenge und den realen signierten Zweierbatch. Keine der Prüfungen behauptet Konto-, Testnet-, Live-, Profil- oder Providerfreigabe.

## Versionsbindung

| Datei relativ zum installierten `ccxt/` | SHA-256 |
| --- | --- |
| `async_support/extended.py` | `44b79c4457110ddccb0a4092a11e17b8a47ccc42eea5f6dcf0a066a2c7320ad7` |
| `pro/extended.py` | `9625b78aff71b3672ddd65d01d3d7b70d02224afd58f138f00d36221dc8707f2` |
| `async_support/gate.py` | `3e6bd51b06345c6a592a6c031c601c77952f0ae0c0fde628e449f886bde9a2ac` |
| `pro/gate.py` | `8585879210cfee32bdb0d27f2be341c744ff4606ab8311b6adf2f79105e9bd65` |
| `async_support/kucoin.py` | `26d6c99e03a4a0c7a050df62aa668896abce5fe2de3787f2be7c43b4ccbcdd9f` |
| `async_support/kucoinfutures.py` | `a380fd2a4b038c23ac3ebf69c282fa6287c13cd0b82a681f850da09901bfecd3` |
| `pro/kucoin.py` | `9e5d3ee27d5daa15168deb5215435755813a3ae70e1c2a7174525cff2d23111d` |
| `pro/kucoinfutures.py` | `2f1a04ed8e112698eb06bcf99c5d03aa6666169df9ef3a1ba0d3e88a9c1eec20` |

Ändert sich einer dieser Bytes, die Bewertung und alle darauf aufbauenden Receipts neu prüfen. Die heutige Dokumentation kann dem Pin voraus sein; neue Gate-Felder wurden deshalb bewusst nur als Syntax, nicht als vom Pin vollständig modellierter Lifecycle bewertet.
