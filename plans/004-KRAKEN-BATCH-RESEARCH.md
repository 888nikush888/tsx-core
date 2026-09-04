# 004: Kraken Futures — IOC-Einstieg und Stop-Market im selben Batch

## Status und Auftrag

- Stand: 2. September 2026; Arbeitskopie `C:/Users/nikla/Desktop/tsx-core`, HEAD `f8089277d0667dd45bcf070037800d423fd89254` plus umfangreiche laufende Änderungen.
- Priorität P1, Umsetzungsrisiko hoch; Teil von `004-execution-constraints.md`, abhängig vom Identitäts- und Schutz-Lifecycle aus 001–003.
- Ergebnis: Recherche abgeschlossen, notwendiger **Providervertrag weiterhin NOT_PROVEN**. Keine neue Freigabe, keine Source-/Profil-/Schemaänderung durch diese Recherche.
- Gegenstand ist ausschließlich ein hart preisbegrenzter IOC-Einstieg und ein Stop-Market ohne zusätzlichen TSX-Limitpreis in **derselben** Futures-Batch-Anfrage. Keine alternative Handelsarchitektur, kein Entry-dann-Stop-Einzelpfad und kein künstlicher Preisdeckel auf dem Stop.
- „Ohne zusätzlichen Limitpreis“ bedeutet ausdrücklich **keine Garantie vollständiger oder preislich unbegrenzter Ausführung**. Native Börsenregeln bleiben bestehen; Signal-SL/TP und Nutzerkonfiguration bleiben unverändert.
- Nur offizielle öffentliche Dokumentation/SDK-Quellen sowie lokale abgefangene Tests wurden benutzt. Kein Konto, kein TSX-Server, keine laufende App, keine Provider-API und kein Trade wurden angesprochen.
- Der Improve-Skill begrenzt diese Untersuchung auf Recherche und dieses Planartefakt. Der Hauptagent pflegt den gemeinsamen Index; `plans/README.md` wird hier nicht geändert.

## Belastbare Schlussfolgerung

Der gepinnte CCXT-Code kann die gewünschte Form herstellen. Die aktuell öffentlich zugängliche Kraken-Batch-Beschreibung verlangt für `stp` jedoch weiterhin einen `limitPrice`, während die Single-Order-Beschreibung bei dessen Fehlen einen Market-Stop definiert. Es wurde keine eindeutige aktuelle Kraken-Primärklärung gefunden, die diesen Widerspruch für **BatchOrderSend** auflöst. Das ist ein fehlender Zulassungsnachweis, kein Beweis, dass der Provider die Form technisch niemals unterstützt.

Optionale SDK-Felder oder ein erfolgreich serialisiertes Mock-Paket ersetzen diese Klärung nicht. Insbesondere ist `limitPrice` auch deshalb kein allgemeines Pflichtfeld eines gemeinsamen Batch-DTOs, weil andere Instruktionen/Ordertypen ohne dieses Feld auskommen. Daraus folgt keine bedingte Zulässigkeit für `stp`.

## Primärquellen und genaue Beweisgrenzen

### 1. Aktuelle Futures-Batch-Referenz

[Kraken Batch order management](https://docs.kraken.com/api-reference/order-management/batch-order-management) und [maschinenlesbare Markdown-/OpenAPI-Fassung](https://docs.kraken.com/api-reference/order-management/batch-order-management.md), gelesen am 2. September 2026.

- Operation `POST /derivatives/api/v3/batchorder`, `json`-Parameter mit `batchOrder`.
- `BatchOrderSend.orderType` referenziert `OrderType`; dessen Enum enthält `ioc` und `stp`.
- Die Beschreibung von `BatchOrderSend.stopPrice` fordert für `stp` zusätzlich `limitPrice` als schlechtesten Ausführungspreis. Derselbe Vorbehalt steht im Edit-Schema.
- Die allgemeine `required`-Liste enthält nicht alle typabhängigen Anforderungen. Ihre fehlende `limitPrice`-Zeile widerlegt daher die ausdrückliche Bedingung nicht.
- Das dokumentierte Stop-Beispiel enthält **beide** Preise. Es belegt keinen preislosen Market-Stop im Batch.
- `order_tag` ist als String beschrieben. Batch-Instruktionen sind nicht als garantierte Entry-vor-Stop-Sequenz dokumentiert; einzelne Resultate können unterschiedlich ausfallen. Keine Atomizitäts-/Alles-oder-nichts-Garantie ableiten.

SHA-256 der an diesem Tag gelesenen UTF-8-Markdown-Zeichenfolge: `e7fc7b477553727043e8ea326b04dd1edcc634009c49159fc5c6a6707d9ee841`. Der Hash dient dem späteren Driftvergleich, nicht als Providerannahmebeweis.

### 2. Single-Order-Referenz: anderes dokumentiertes Verhalten

[Kraken Send order](https://docs.kraken.com/api-reference/order-management/send-order) und [Markdown-/OpenAPI-Fassung](https://docs.kraken.com/api-reference/order-management/send-order.md), gelesen am selben Tag.

Die `limitPrice`-Beschreibung definiert für `stp`/`take_profit` bei fehlendem Preis die Auslösung einer Marketorder. Das belegt die Single-API-Semantik, nicht stillschweigend dieselbe Ausnahme im widersprechenden Batch-Schema. Dieser Rechercheauftrag erlaubt **keinen** Wechsel auf Einzelanfragen.

SHA-256 der gelesenen UTF-8-Markdown-Zeichenfolge: `e55c6d50bcb09ad985ec7590202dcb1f23a52e4ccdc2225c90d77360e06e32d7`.

### 3. Kraken-eigenes Go-SDK: Optionalität, kein Stop-Batch-Beispiel

Geprüft wurde `krakenfx/api-go` am Commit `a8484bc5ec985fd5ce5bcc0580f659727d8f7603`:

- [`BatchOrderInstruction`](https://github.com/krakenfx/api-go/blob/a8484bc5ec985fd5ce5bcc0580f659727d8f7603/pkg/derivatives/entities.go) führt `LimitPrice` und `StopPrice` als String mit `omitempty`; derselbe Typ dient Send/Edit/Cancel.
- [`BatchOrder`](https://github.com/krakenfx/api-go/blob/a8484bc5ec985fd5ce5bcc0580f659727d8f7603/pkg/derivatives/rest.go) transportiert diesen DTO zur Batch-Operation. Die Methode enthält keinen Nachweis einer akzeptierten preislosen `stp`-Anfrage.
- Das [offizielle Batch-Beispiel](https://github.com/krakenfx/api-go/blob/a8484bc5ec985fd5ce5bcc0580f659727d8f7603/examples/futuresrest/batchorder/batchorder.go) kombiniert Limit-Send und Cancel. Es ist kein Stop-Market-/IOC-Abnahmetest. Es wurde ausschließlich gelesen, **nicht ausgeführt**.

Auch die offizielle [`krakenfx/kraken-cli`-Implementierung](https://github.com/krakenfx/kraken-cli/blob/aa56e5976be5afa6d8267eb6741f3a8844678fe9/src/commands/futures.rs) am Commit `aa56e5976be5afa6d8267eb6741f3a8844678fe9` reicht Batch-JSON ohne semantische Stopprüfung durch. Ihre generische Batch-Unterstützung und Single-Stop-Beispiele klären den Vertrag nicht. Ein allgemeiner Hinweis auf „atomare“ Batches in einer CLI-Anleitung wird nicht zu einer Matching-Engine-Garantie aufgewertet.

### 4. Native Market-Stop-Grenze getrennt erhalten

[Kraken Derivatives order types](https://support.kraken.com/au/articles/360031471211-derivatives-order-types), Artikelstand 13. Februar 2026, Abschnitt „Stop Loss Market Orders“:

Nach dem Trigger begrenzt Kraken die Ausführung nativ auf 1 % über dem besten Ask beziehungsweise unter dem besten Bid. Ein Stop kann deshalb gar nicht oder nur teilweise füllen; der nicht ausgeführte Rest wird storniert. Das ist kein TSX-SL-/Entry-Cap und darf weder umgerechnet noch durch eine selbst gesetzte Stop-Limitorder ersetzt werden. Native Margin-/Aktivierungsprüfungen bestehen ebenfalls fort.

Der bestehende 003-Lifecycle muss reale kumulative Fills, einen terminal stornierten Stoprest und verbleibende Exposure getrennt behandeln. Ein früheres Stop-Placement oder terminales `cancelled` darf nie automatisch „Position vollständig geschlossen“ oder „Schutz weiterhin gesund“ beweisen.

## Lokaler Istzustand und SDK-Belege

Runtime: Python 3.12, CCXT **4.5.75**. Installationspfad: `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt`.

`async_support/krakenfutures.py:create_order_request`, ab Zeile 1162:

```python
elif timeInForce == 'ioc':
    type = 'ioc'
# stopLossPrice setzt später type='stp' und stopPrice.
if price is not None:
    request['limitPrice'] = self.price_to_precision(symbol, price)
```

`create_orders`, ab Zeile 1315, nutzt diesen Request-Builder für jedes Leg und ruft einmal `privatePostBatchorder` auf. Der reale Signierpfad kapselt `batchOrder` in den `json`-Formparameter. **Uppercase `IOC` wird hier nicht als IOC erkannt**, obwohl der übergeordnete gemeinsame TSX-Vertrag uppercase verwendet; `entry_price_constraints.py:IOC` bildet Kraken bereits auf lowercase `ioc` ab.

Aktuelle schützende Grenzen:

- `exchange_executor/ccxt_profiles.py`: Kraken `protected_bounded_entry` bleibt beim Standard `not_proven`.
- `exchange_executor/entry_price_constraints.py:apply_entry_boundary`: verweigert den unbelegten Profileintrag vor Dispatch.
- `src/trading_execution_constraints.ts:assertBoundedEntryProfile`: akzeptiert die gebundene IOC-Form nicht allein aufgrund einer behaupteten Kraken-Capability.
- `exchange_executor/tests/test_entry_price_sdk.py`: bestehender Kraken-Test belegt Serialisierung, ausdrücklich **keine** Capability-Freigabe.
- `exchange_executor/tests/test_entry_price_constraints.py`: bestehender Kraken-Negativtest fordert keinen Batch und keinen Leverage-Write.

### Parallel gelöste Tag-Identität nicht duplizieren

Ein zusätzlicher reiner SDK-Probe zeigte: Ohne explizites `order_tag` erzeugt CCXT 4.5.75 im Batch numerisch `0`/`1`; explizite Stringtags bleiben dagegen unverändert. Dieser Befund ist **keine neue offene zweite Tag-Implementierung**:

- Das parallele 001/002-Paket persistiert bereits `providerBatchTag: { version: 1, tag: leg.clientOrderId }` mittels `src/trading_order_identity.ts:prepareProtectedOrderIdentityRequests`.
- `exchange_executor/provider_order_identity.py:batch_tag_params` reicht genau diesen gebundenen String als `order_tag` weiter.
- Die dortige Rückkorrelation nutzt echte zurückgelieferte Tags, keine Arrayposition und keinen erfundenen rohen Client-Identifier.

Diese Schnittstelle übernehmen und deren Tests erhalten; keine eigenen Tags, kein zweites Namespace, kein Umschreiben alter Orderidentitäten. Sie löst den Stopvertrag nicht.

## Ausgeführte lokale Prüfungen

Arbeitsverzeichnis für alle Befehle: `C:/Users/nikla/Desktop/tsx-core`.

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe' -B -m unittest discover -s exchange_executor/tests -p test_entry_price_sdk.py -v
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe' -B -m unittest discover -s exchange_executor/tests -p test_entry_price_constraints.py -v
```

Ergebnis dieses Rechercheblocks: **5 SDK-Tests und 11 Entry-Contract-Tests grün**. Dazu **10 In-Memory-Charakterisierungsfälle grün** (je fünf für LONG/SHORT), ohne neue Testdatei. Die In-Memory-Fälle durchlaufen echte CCXT-Signierung; `rest.fetch` ist vollständig durch `AsyncMock` ersetzt. Märkte und Antworten sind synthetisch. Keine Betriebssystem-/Provider-Netzwerktransporte werden vom SDK ausgeführt; der Mock-Erfolg beweist keine Providerannahme.

| Fall je Richtung | Exaktes lokales Soll / beobachtetes Resultat |
|---|---|
| Preisbegrenzter Batch, feste Stringtags | Genau ein abgefangener `POST .../batchorder`; dekodierter `json.batchOrder` enthält Entry `orderType=ioc`, LONG `limitPrice=100.5` / SHORT `99.5`, und Gegenrichtung-Stop `orderType=stp`, `stopPrice=90` / `110`, `reduceOnly=true`, **kein** Stop-`limitPrice`; beide `order=send`, Symbol `PF_XBTUSD`, Tags exakt ursprüngliche Leg-IDs. |
| Uppercase-Fehlform | Direkter SDK-Builder mit `timeInForce='IOC'` ergibt `orderType='lmt'`, also keinen IOC. Dies ist eine Negativkontrolle, kein erlaubtes Produktionsformat. |
| Zusätzlicher Stoppreis | Direkter SDK-Builder mit `price=triggerPrice` und `stopLossPrice=triggerPrice` erzeugt ausdrücklich `limitPrice`. Diese Änderung verletzt das gewünschte Stop-Market-Format. |
| Post-only und IOC | `timeInForce='ioc'` plus `postOnly=true` wirft `ccxt.InvalidOrder`; kein Send. |
| Implizite SDK-Tags | Ohne `order_tag` werden `0`/`1` als Zahlen erzeugt; mit expliziten Tags bleiben Strings erhalten. Die Produktionskorrektur gehört ausschließlich dem bestehenden 001/002-Vertrag. |

## Exakte zusätzliche Red-/Regressionstests für einen späteren Umsetzungsauftrag

Noch **nicht** als neue Source-/Testdateien angelegt; vorhandene Tests oben bleiben verbindlich. Neue Tests nach dem Stil von `test_entry_price_sdk.py` und `test_entry_price_constraints.py`, mit `IsolatedAsyncioTestCase`, ausschließlich lokalen Fakes:

1. `test_kraken_full_signed_batch_keeps_ioc_entry_and_unpriced_stop`: die erste Tabellenzeile für beide Richtungen durch den **produktiven** versionierten Tag-/Order-Spec-Pfad bis zum abgefangenen finalen `fetch` prüfen, nicht nur `create_order_request`.
2. `test_kraken_ioc_requires_lowercase_sdk_mapping`: mutierter Mapper auf `IOC` muss das Wire-Soll `ioc` verletzen; keine stillschweigende Gleichsetzung.
3. `test_kraken_entry_boundary_never_leaks_into_stop_limit`: Stop-Spec mit eingeschleustem `price`, `limitPrice` oder Entry-Cap darf die spätere Freigabeprüfung nicht passieren. Trigger bleibt der vom Nutzer vorgegebene Stop, nicht der Entry-Cap.
4. `test_kraken_unknown_batch_stop_contract_never_sends`: solange Quellenlage unverändert, muss der aktuelle Negativtest weiterhin vor Batch/Leverage-/Einzelorder-Write stoppen. Ein bloßer Fake-Capability-Wert ist kein Gegenbeweis.
5. `test_kraken_mixed_batch_result_remains_unresolved`: Entry gefüllt, Stop mit `requiredArgumentMissing`/anderer Ablehnung oder fehlendem Leg => unklarer Schutzstatus und 003-Reconcile; kein Einzelorder-Fallback, kein erneuter Entry und kein fremdes Flatten. Resultate über die bestehende Leg-Identität zuordnen.
6. `test_kraken_stop_market_partial_then_cancel_is_not_flat`: eigener Fill `0.4` auf Stopmenge `1`, Stop terminal `cancelled`, nachgewiesene Restposition `0.6` => keine Trade-Closure, keine gesunde Vollschutzbehauptung, kein Wiederaufleben des Entryrests. Schutz-/Drain-Verhalten exakt aus 003 verwenden; keine neue Cancelserie/-architektur.
7. `test_kraken_empty_ioc_and_resting_stop_requires_cleanup_proof`: Entry terminal ohne Fill plus bestehender Stop ist noch kein beweislos abgeschlossener Lifecycle; bestehende begrenzte Cleanup-/Nachweisregeln erhalten.

Ein simuliertes erfolgreiches Stop-Batch-Resultat prüft ausschließlich lokale Resultatverarbeitung. Es darf den roten **Quellen-Gate** aus Nummer 4 nicht grün machen.

## Engster möglicher Folge-Hunk — derzeit nicht freigegeben

Es gibt jetzt keinen ehrlichen produktiven Freigabe-Hunk. Zuerst ist eine eindeutige aktuelle Kraken-Primärquelle erforderlich, die für `POST /derivatives/api/v3/batchorder`, `order='send'`, `orderType='stp'` das **Fehlen** von `limitPrice` ausdrücklich als Market-Stop definiert und den gegenteiligen Schemahinweis ersetzt oder klarstellt. Eine bestätigte Kraken-Vertragskorrektur, konkrete offizielle Batch-Stop-Dokumentation oder ein gleichwertiger offizieller API-Vertrag wäre geeignet; generische `omitempty`-Felder nicht.

Erst nach erneuter Prüfung und ausdrücklichem Umsetzungsauftrag wäre der minimale Scope:

1. Den exakten Quellen-/Versionsnachweis und die Wire-/Failurefälle dauerhaft pinnen.
2. Die vorhandene Kraken-lowercase-IOC-Zuordnung und den bestehenden versionierten Stringtag-Vertrag verwenden; Stop-`price`/`limitPrice` strikt abwesend halten. Kein Eingriff in gemeinsamen Identity-Code ohne Abstimmung.
3. Ausschließlich den geprüften Kraken-Profileintrag und das entsprechende Node-Gate anpassen, **zusammen** mit den nachweisgebundenen Tests. Nicht nur ein Flag umstellen. Profil-/Evidencehash-Drift und notwendige frische Kontoprüfung berücksichtigen.
4. Native Stop-Partial-/Restcancel-Ereignisse durch den bestehenden 003-Lifecycle prüfen. Keine Signalpreisänderung, keine garantierte Füllung und keine Batch-Atomizität behaupten.

Keine Migration erforderlich oder reserviert. FX, Funding, History-Cursor, Risikoformeln, Margin-Prozente, Leverage-/Tierlogik und TTL sind außerhalb dieses Folge-Hunks. Migration 40 und parallele Identity-Arbeit bleiben unberührt.

## Nachtrag: dauerhafte kombinierte lokale Matrix

Nach gesonderter Root-Freigabe wurde ausschließlich `exchange_executor/tests/test_kraken_bounded_matrix.py` ergänzt. Keine Produktions-, Profil-, SDK-, Abhängigkeits- oder Schemaänderung; kein reales Providerkonto. Automatische Python-Testdiscovery erfasst die neue Datei. **Der ungelöste Batch-Stopvertrag bleibt NOT_PROVEN.**

Die Matrix ersetzt keine Zulassungsprüfung: Ein eigener Test ruft den tatsächlichen `CcxtAdapter.submit_protected_entry` für LONG und SHORT auf und verlangt unverändert `ENTRY_PRICE_BOUND_UNPROVEN` vor jedem Batch-/Einzelorder-/Leverage-Write. Kein Test überschreibt dafür die Capability. Separat untersuchen reine diagnostische Specimens die bereits vorhandenen Funktionen unterhalb dieses geschlossenen Gates: Originalrequests → `batch_tag_params`/`_base_order_spec` → `assert_boundary`/vorhandenes `IOC['krakenfutures']`/`assert_final_entry_spec` → echter CCXT-4.5.75-`create_orders`/Signer/Parser. Nur diese begrenzte Syntax-/Consumerkette wird positiv geprüft, nicht ein fiktiv freigeschalteter vollständiger Entryadapter.

Sieben neue dauerhafte Fälle:

1. LONG und SHORT mit Originalcap `100.5` beziehungsweise `99.6`, unveränderter Entryfrist, tatsächlichen ursprünglichen Stringtags und Gegenrichtungsstop `90` beziehungsweise `110`. Dekodierter signierter `json.batchOrder` enthält `ioc`, exakten Entry-Limitpreis, `stp`, Reduce-only, **keinen Stop-Limitpreis** und genaue `cliOrdId`/`order_tag` je Leg. Umgekehrt gelieferte native ACKs werden anhand der echten Tags korreliert; originale SDK-`clientOrderId=null` und Provider-JSON bleiben erhalten.
2. Vollständiger produktiver Adapterpfad für beide Richtungen weiterhin gesperrt, null Writes/Leverageänderungen.
3. Gefüllter Entry aus einem tatsächlichen CCXT-EXECUTION-Parserpfad, kombiniert mit fehlender, nativ abgelehnter, fremd getaggter oder duplizierter Stopantwort: nur der tatsächlich identifizierte Entry mit Menge `2` bleibt bestätigt; Stop unresolved, kein weiterer Transport.
4. Bewusst widersprüchliche, aber identifizierte Mixed-Antwort mit gefülltem Entry und abgelehntem Stop: der bestehende Resultatconsumer gibt keinen Erfolg aus, sondern behält beide bestätigten Legs in `UnresolvedOrderOutcome`. Dies ist ein Negativtest, keine behauptete echte Providerantwort.
5. Natives `iocWouldNotExecute` ohne tatsächliche Order-ID plus akzeptierter Stop: keine erfundene Entry-ID/Abwesenheit; nur Stop bestätigt, Entry unresolved.
6. Tatsächlich identifizierter terminaler Empty-IOC plus ursprünglicher Live-Stop: Entry `cancelled/0`, Stop weiterhin `open`, kein Cleanup-/Closurebeweis und keine automatische erneute Sendung. Beide Richtungen geprüft.
7. Native REST-Order `PARTIALLY_FILLED` mit Stopmenge `2`, echtem kumulativem Fill `0.4`, danach tatsächlicher SDK-/Adapter-Cancel auf exakt diese Exchange-ID; `cancelled/0.4` bleibt erhalten. Frischer nativer Positionsparser liefert weiter `1.6`. Genau ein Cancel-Write, kein neuer Entry/Stop, kein Fallback und kein symbolweites Flatten. Die Python-Adaptergrenze endet bei korrekt erhaltener Restposition; Node-Closure/Protection bleibt der separat getestete 003-Consumer.

Erster Lauf: sechs Fälle grün, ein reiner Fixturefehler am abschließenden Cancel-Wire-Assert. CCXT 4.5.75 signiert bei Kraken Nicht-Batch-Parameter auch für POST in der URL-Query; der Test hatte `order_id` fälschlich im Body erwartet. Die Fixture wurde an den tatsächlich gelesenen Signer angepasst (`query.order_id` exakt, Body `None`), **keine Produktionslogik geändert**. Kein roter Produktionsfehler aus dieser Matrix festgestellt.

Abschluss dieses Zusatzes: neue Matrix **7/7 grün**, vorhandene Preis-/SDK-Dateien **16/16 grün**, vorhandene native Orderidentität **6/6 grün**, Ruff grün. Nur synthetische lokale Märkte/Schlüssel/Antworten; jeder SDK-Transport wird vollständig abgefangen, unbekannte zusätzliche Requests scheitern am Fixture. Diese 29 lokalen Tests sind keine neue Gesamt-CI-/Coverage- oder Providerabnahme.

## Prüfgates und STOP-Bedingungen

Für diese Recherche ist prüfbar: nur diese Plandatei wurde neu geschrieben; die beiden oben genannten vorhandenen Python-Testdateien sind grün; kein Profil wurde freigegeben. Kein gemeinsamer Gesamtsuiten-/Provider-/Release-Abschluss wird behauptet.

Nach einer separat erlaubten Implementierung zusätzlich:

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' --import tsx tests/test_trading_entry_price.js
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' node_modules/typescript/bin/tsc --noEmit
& 'C:/Users/nikla/AppData/Local/Temp/tsx-core-ccxt-py312/Scripts/ruff.exe' check exchange_executor/entry_price_constraints.py exchange_executor/ccxt_adapter.py exchange_executor/ccxt_profiles.py exchange_executor/tests/test_entry_price_sdk.py exchange_executor/tests/test_entry_price_constraints.py
```

Alle Befehle müssen ohne neue Fehler bestehen; zugehörige 003-Lifecycle-/001-Identity-Regressionsläufe mit deren Eigentümern abstimmen. Neue Tests registrieren, falls eine neue Testdatei nötig ist. Keine Qualitätsgrenze lockern. Die gesamte gemeinsame Suite startet der Hauptagent.

STOP und konkrete Rückmeldung statt Freigabe bei weiterhin widersprüchlicher Primärdokumentation; erforderlichem zusätzlichen Stop-Limitpreis; nur Single-/Spot-API-Belegen; erforderlicher Entry-vor-Stop-Einzelarchitektur; SDK-/Profilversion außerhalb des geprüften Vertrags; neuen Provider- oder Kontoaufrufen; oder Änderung einer anderen laufenden Agenten-Schnittstelle. Eine spätere Providerabnahme und ein Rollout benötigen weiterhin separate Autorisierung gemäß Paket 008.

## Wartungsnotiz

Bei jedem CCXT- oder Kraken-API-Wechsel sind Lowercase-IOC, finaler Form-Body, Stoppreis-Abwesenheit, echte Leg-Identität und native terminale Partialfälle gemeinsam zu prüfen. Neue Dokumentation kann die heute offene Quellenfrage schließen, aber nicht rückwirkend aus heutigen Fakes eine Live-Abnahme machen. Die Sperre ist hier eine eng benannte Vertragslücke, kein Ersatz für die Integration aller bereits nachweisbaren Standardfälle anderer Profile.
