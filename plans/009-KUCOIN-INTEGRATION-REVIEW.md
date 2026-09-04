# Phase 009 — Unabhängiger Architekturreview: enge KuCoin-Integration

## Review-Rahmen

Dieser Review ist eine ausschließlich lokale, read-only abgeleitete Architekturprüfung der geplanten engen Integration auf Basis von CCXT 4.5.75, der vorhandenen Phase-009-Forschung, der bestehenden KuCoin-Contract-Helper und -Tests sowie der aktuellen Python- und Node-Verträge. Es wurden keine Konten, Secrets, Providerkontakte oder Orders verwendet. Die vorhandene Evidenz erlaubt weitere Implementierungsarbeit, aber keine Zertifizierung oder Freigabe.

## Unabhängige Profilentscheidung

`kucoin` ist im parallelen Profilmodell **not_easy**. `kucoin` und `kucoinfutures` verwenden in CCXT 4.5.75 dieselbe KuCoin-Classic-Vertragsimplementierung und dieselben Classic-Hosts; `kucoinfutures` erbt von `kucoin` und grenzt primär den Standard-/Discovery-Scope auf Swaps ein. Sie sind deshalb keine voneinander unabhängigen Provider-Identitäten.

Die aktuelle TSX-Identität ist dafür nicht sicher genug:

- `_account_identity()` bindet ein Profil mit `credential_binding` an den API-Key statt an eine authentifiziert gelesene kanonische Provider-Konto-ID.
- `external_account_id()` salzt den Fingerprint zusätzlich mit der Exchange-ID.
- Dasselbe reale KuCoin-Konto wird dadurch unter `kucoin` und `kucoinfutures` als zwei verschiedene TSX-Konten behandelt.
- Auch zwei API-Keys desselben realen Kontos können als getrennte Konten erscheinen.
- Das ermöglicht getrennte Positions-/Risikobudgets und potenziell eine doppelte Ausführung desselben Signals.

Klare Entscheidung: **Nur `kucoinfutures` ist als erster kanonischer Kandidat weiterzuverfolgen.** `kucoin` bleibt Kandidat beziehungsweise quarantined und darf nicht parallel als aktives Trading-Profil angeboten werden. Eine spätere parallele Freigabe setzt eine authentifiziert gelesene, dauerhaft gebundene kanonische Classic-UID und eine Cross-ID-Duplikatsperre voraus. `identity_strategy="exchange_account_uid"` darf dafür nicht vorzeitig verwendet werden, weil der aktuelle Client diese Identität aus benutzerseitigen Credential-Feldern (`uid`, `accountId`, `login`) ableitet und nicht aus einem authentifizierten Provider-Read.

## Minimales enges Profil für den ersten Kandidaten

Für `kucoinfutures` ist ausschließlich folgender Scope weiterzuverfolgen:

- `profile_version=1`
- `default_type="swap"`
- `default_sub_type="linear"`
- `settlement_preference=("USDT",)`
- `modes=("live",)`; beide gepinnten Klassen besitzen kein CCXT-`urls.test`
- KuCoin Classic, linearer USDT-Perpetual, tatsächliches Cross-Margin und BOTH/One-way
- `protected_entry_strategy="certified_batch"` erst nach vollständiger ACK- und Recovery-Evidenz
- `position_mode="oneway"`
- `margin_mode="cross"`
- `my_trades_requires_symbol=False`
- `market_order_strategy="native_market"`
- `builder_fee_enabled=None`
- erforderliche geheime Credential-Felder: `apiKey`, `secret`, `password` (API-Passphrase)
- keine automatische Konto-, Margin- oder Positionsmodus-Änderung

`credential_binding` kann bis zu einer Identitätsmigration höchstens die lokale Client-/Credential-Generation binden. Die authentifiziert gelesene KuCoin-UID muss zusätzlich als Verifikations- und Kollisionsbeweis geführt werden und darf nicht durch den API-Key ersetzt werden.

## Shared Switches mit aktuell nur drei Profilen

### Python

1. `exchange_executor/current_state.py`
   - Methoden- und Reader-Maps kennen nur `bybit`, `krakenfutures` und `hyperliquid`.
   - Der generische Fallback bleibt absichtlich `unknown/history_pagination_not_proven`.
   - KuCoin benötigt einen expliziten Reader für accountweite Positionen, aktive normale Orders und aktive Stop-Orders mit begrenzter vollständiger Pagination, Duplikat- und Page-Drift-Erkennung.

2. `exchange_executor/history_pagination.py`
   - Die Page-Dispatches kennen nur die drei bestehenden Profile.
   - KuCoin benötigt begrenzte, gepinnte Sieben-Tage-Fenster und exakte Fortsetzungen.

3. `exchange_executor/history_coverage.py`
   - `PROFILES` enthält nur die drei bestehenden History-Profile.
   - Die dokumentierte dreimonatige Retention und Sieben-Tage-Fenster beweisen keinen maximalen Lieferverzug beziehungsweise keine Finalität. Ein KuCoin-Profil darf deshalb nicht allein durch Aufnahme in die Map als vollständig gelten.

4. `exchange_executor/history_reader.py`
   - Bybit besitzt einen Spezialpfad; ein Exchange-ID-Lookup fällt sonst auf generisches `fetch_order`, und nur Hyperliquid besitzt einen Client-ID-Lookup.
   - KuCoin benötigt explizite positive Lookups für normale und Stop-Order-Endpunkte. Sobald vorhanden, ist die Exchange-Order-ID zu bevorzugen; `clientOid` ist nur innerhalb seiner kürzeren Retention verwendbar. Ein fehlender Treffer beweist niemals Abwesenheit.

5. `exchange_executor/account_log_sources.py` und `exchange_executor/account_log_reader.py`
   - Specs, Felder und Dispatches kennen nur drei Profile.
   - Der Reader-`else`-Zweig führt derzeit zu Kraken; KuCoin benötigt deshalb einen expliziten Zweig, bevor ein Spec ergänzt wird.

6. `exchange_executor/account_log_scheduler.py`
   - Account-Mode-Read und die Zwei-Call-Priorität sind Bybit-spezifisch.
   - KuCoin benötigt einen eigenen begrenzten Mode-/UID-Read innerhalb desselben Fünf-Call-Budgets; die UTA-Logik darf nicht wiederverwendet werden.

7. `exchange_executor/execution_constraints.py`
   - Entry-Reader kennen nur drei Profile; der Account-Observation-`else`-Zweig nimmt Hyperliquid an.
   - KuCoin benötigt authentifizierte API-Key-Informationen für UID, Berechtigungen und `siteType`, explizit `CLASSIC`, rohen Positionsmodus `0`, rohes `CROSS` und einen konto-/symbolgebundenen Leverage-Read. Fehlende Werte bleiben unbekannt und sperren Entries.

8. `exchange_executor/leverage_tier_evidence.py`
   - Quellen, Bindings und Reader kennen nur drei Profile.
   - Öffentliche KuCoin-Tiers gelten für isolated und sind kein Cross-Kapazitätsbeweis. Der bestehende `read_tier_evidence(clients, market, deadline)`-Vertrag hat nicht die benötigten Plan-/Margin-/Mengen-/Preis-/Leverage-Eingaben. Erforderlich ist ein neuer diskriminierter Provider-Capacity-Quote-Vertrag auf Basis von Cross Risk und Max Open Size.

9. `exchange_executor/fill_identity.py`
   - Native Fill-Identitäten existieren nur für Bybit, Hyperliquid und Kraken Futures.
   - KuCoin benötigt `kucoin_classic_futures_fill_v1` mit exaktem `tradeId`, `orderId`, nativem Symbol, `tradeTime` und authentifizierter Provider-UID-Bindung.

10. `exchange_executor/accounting_evidence.py`
    - Accountweite Reporting-Balances sind nur für Bybit und Hyperliquid implementiert; andere Profile werden abgewiesen.
    - KuCoin benötigt einen exakten rohen USDT-Futures-Kontosnapshot. USD und USDT dürfen nicht gleichgesetzt und float-decodierte Werte nicht zu Originals erklärt werden.

11. `exchange_executor/ccxt_adapter.py`
    - Der generische Amount ist ein String; der KuCoin-SDK-Wire verlangt eine ganzzahlige Contract-Anzahl.
    - Leverage-Zweige behandeln jeden Nicht-Kraken-Provider generisch.
    - Der Order-History-Fallback trägt Kraken-Semantik.
    - Fill-Normalisierung und Recent-Trade-Routing besitzen keine KuCoin-Identität.
    - Diese Stellen müssen über enge Provider-Helper geroutet werden, bevor der Signer erreicht wird.

12. `exchange_executor/provider_order_identity.py` und `exchange_executor/order_identity.py`
    - Es existieren Kraken-spezifische Batch-Tags und ansonsten generische Client-ID-Korrelation.
    - KuCoin benötigt eine strikte native Per-Leg-ACK-Klassifikation über Code, Nachricht, `clientOid`, `orderId` und Symbol. Zwei verschiedene erwartete Legs müssen eindeutig bestätigt werden; fehlende, duplizierte oder gemischte Ergebnisse bleiben unresolved.

13. `exchange_executor/recovery_schedule.py`
    - Der Scheduler ist vollständig Bybit-spezifisch.
    - Er darf nicht generisch erweitert werden. KuCoin benötigt entweder einen eigenen versionierten Schedule oder bleibt für Scheduled Recovery unsupported; unresolved Entries bleiben dann gesperrt.

14. `exchange_executor/ccxt_sdk_policy.py`
    - Die allgemeine Entry-Deadline kann bestehen bleiben.
    - Nur wenn CCXT rohe Dezimalwerte oder IDs nicht verlustfrei erhält, ist ein enger request-lokaler KuCoin-Response-Capture erforderlich. Ein gemeinsames `last_http_response` ist unzulässig.

### Node

15. `src/trading_fill_identity.ts`
    - Profil-Union, Provider-Map und Native-Matcher kennen nur die drei produktiven Profile sowie Paper.

16. `src/trading_account_log_contract.ts`
    - Source-Specs und Feld-Allowlist kennen nur drei Provider und müssen mit Python im Gleichschritt erweitert werden.

17. `src/trading_account_log_money.ts`
    - Der Ternary-Dispatch behandelt jeden Nicht-Bybit-/Nicht-Hyperliquid-Provider als Kraken.
    - Ein expliziter KuCoin-Projektor und ein explizit fail-closed unbekannter Provider sind zwingend.

18. `src/exchange_history_coverage.ts`
    - Die Coverage-Profile kennen nur drei Provider. Auch hier darf KuCoin ohne Finalitätsvertrag nicht als vollständig erklärt werden.

19. `src/trading_account_mode.ts` und der zugehörige Contract
    - Die Persistenz ist Bybit-UTA-spezifisch und darf nicht für KuCoin umgedeutet werden.
    - Falls KuCoin-UID-/Mode-Evidenz persistent benötigt wird, ist ein eigener diskriminierter Vertrag erforderlich.

20. `tests/test_exchange_implementation_bridge.js`
    - Ein Test erwartet exakt `bybit`, `hyperliquid`, `krakenfutures` und muss erst bei einer tatsächlichen Profilaufnahme angepasst werden.
    - `src/exchange_catalog.ts` sowie allgemeine Exchange-Strings sind dynamisch und benötigen abgesehen von neuen Evidenz-Unions keinen Provider-Hardcode.

## Wirklich erforderliche Provider-Helper

- `exchange_executor/kucoin_contracts.py` bleibt der pure Helper für native Classic-USDT-Vertragsvalidierung und exakte Integer-Konvertierung.
- Ein enger `kucoin_execution.py` muss verlustfreie native Contract-Evidenz einlesen, Cross/BOTH/Leverage und originale `clientOid` auf beide Legs anwenden, Contract-Counts exakt in Integer überführen, den finalen tatsächlichen Spec/Wire prüfen, Batch-ACKs klassifizieren und nach einem Cancel-ACK einen gezielten terminalen Read erzwingen.
- `kucoin_current_state.py` muss Positionen, aktive normale Orders und aktive Stop-Orders vollständig und begrenzt erfassen.
- `kucoin_history.py` muss accountweite Fills in gepinnten Sieben-Tage-Fenstern lesen, originale IDs und Zeiten erhalten und positive Recovery für normale und Stop-Orders anbieten.
- `kucoin_money.py` muss exakten USDT-Balance-Scope, Fill-Gebühren und Funding-Historie mit exakten großen IDs liefern. Ledger- und Funding-Ereignisse dürfen nicht doppelt gebucht werden. Vollständige Funding-Abdeckung benötigt ein dauerhaftes historisches Symboluniversum einschließlich delisteter Kontrakte.
- `kucoin_capacity.py` muss einen neuen Provider-Capacity-Quote-DTO auf Basis von Cross Risk und Max Open Size implementieren; eine synthetische Umdeutung als öffentliche Tier-Tabelle ist unzulässig.
- Eine request-lokale verlustfreie JSON-Erfassung ist nur dort einzuführen, wo die SDK-Decodierung native Dezimalwerte oder IDs oberhalb `2^53` zerstört.
- Ein authentifizierter Identity-/Mode-Helper muss UID, Berechtigungen, `siteType`, CLASSIC, One-way (`0`), CROSS und konfigurierten Leverage mit derselben TTL- und Binding-Strenge wie die bestehenden Zehn-Sekunden-Fences liefern.

## Sonar-, Runner- und Receipt-Anforderungen

- `sonar-project.properties` führt produktive Python-Dateien explizit auf. Jeder neue produktive KuCoin-Helper muss dort ergänzt werden.
- Tests unter `exchange_executor/tests` werden bereits automatisch entdeckt.
- Das Executor-Dockerfile kopiert `*.py`; neue Helper im Executor-Root werden daher automatisch in das Image übernommen. Der Final-Image-Runtime-Check bleibt trotzdem verpflichtend.
- Permanente Zero-Network-Tests müssen die tatsächlichen CCXT-4.5.75-Klassen `kucoin` und `kucoinfutures` für beide Seiten ausführen: Integer-, Fraction-, Overflow- und Zero-Send-Grenzen, rohe Mode-/UID-Ambiguität, gemischte/fehlende/duplizierte ACKs, Current-State-Pagination, Stop-/Normal-Lookup, Cancel-Terminalität, späte/duplizierte Fills, exakte Money-IDs/-Dezimalwerte und Stream-Reconnect bei REST-Autorität.
- Danach sind Python-/Node-Paritätstests, Ruff, Coverage und Sonar erforderlich.
- Implementation- und Runtime-Verifier iterieren alle `PROFILES`. Die Aufnahme eines Profils ohne gültiges Receipt lässt den Build scheitern.
- Jede Exchange-ID benötigt ein eigenes Receipt und einen eigenen unabhängigen Approval-Pin. Gemeinsame Helper-Evidenz darf referenziert werden, ersetzt aber keine getrennte Identität.
- Jede produktive Executor-Python-Änderung verändert den `executorTreeHash`; Source-, Test- und Fixture-Hashes ändern sich ebenfalls. Nach dem Source Freeze müssen betroffene Receipts und Pins koordiniert neu erzeugt und unabhängig geprüft werden.
- Ein Receipt muss `profileHash`, den exakten installierten CCXT-4.5.75-SDK-Tree, Source-/Executor-/Test-/Fixture-Hashes, Execution Report und Paritätsevidenz pinnen. Ohne reale Provider-Verifikation bleibt `providerAcceptanceVerified=false`.

## Harte Blocker vor Zertifizierung oder Entry-Freigabe

1. Kanonische Cross-ID-/Provider-UID-Identität und eine Duplikatsperre.
2. Verlustfreie rohe Quelle für Contract- und Money-Dezimalwerte sowie große Event-IDs.
3. Expliziter CLASSIC-/One-way-/CROSS-/Leverage-/Permission-Readback; fehlend bedeutet unbekannt.
4. Nachweislich vollständiger Current State für Positionen, normale Orders und Stop-Orders.
5. Exakte ganzzahlige Ordermenge und Gleichheit des finalen Wire mit der ursprünglichen Menge.
6. Strikter Zwei-Leg-Batch-ACK sowie Recovery für Partial-, Mixed- und Timeout-Fälle und terminaler Cancel-Read.
7. Neuer Cross-Capacity-Vertrag und konto-/symbolgebundene Kapazitätsevidenz.
8. Native Fill-Identität, begrenzte History-Pagination und eine Entscheidung zum bislang ungeklärten maximalen Lieferverzug beziehungsweise zur Finalität.
9. Exakte USDT-Balance, Gebühren und Funding, dauerhaftes Symboluniversum einschließlich delisteter Kontrakte und Ausschluss von Doppelbuchungen.
10. REST-autoritative Stream-Reconnect-Tests.
11. Sonar-, Runner-, Cross-Layer-Tests und unabhängig geprüfte Receipts/Pins.

## Ergebnis

Die vorhandene lokale Evidenz trägt eine weitere enge Implementierung, aber keine Freigabe. Der minimale sichere Weg ist `kucoinfutures` als live-only kanonischer erster Kandidat. Die tatsächlichen SDK-Formen beider Klassen sollen weiterhin offline getestet werden; `kucoin` darf daraus jedoch nicht als zweites aktives Trading-Profil abgeleitet werden.
