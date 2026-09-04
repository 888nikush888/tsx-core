# 001/002 Folgeplan: Belegte Orderbindung und namespace-sichere Fillidentität

> Ausführungsstatus: **PLAN, nicht implementiert. Migration 40 ist durch Root für
> diesen Entwurf vorgesehen; ihre Implementierung wartet auf Entwurfsfreigabe.**
> Auftrag vom Root: ursprüngliche Pläne 001/002 vollständig lesen und die noch
> offenen Parent-/Batch- und Fillidentitätspflichten konkret voranbringen.
> Nur diese Plandatei wurde angelegt. Keine Änderungen an Produktivcode, Tests,
> Migrationen oder Freigabegates. Root verwaltet den gemeinsamen Planindex.
>
> Vor Umsetzung jeden unten genannten Schnittstellen-/Migrationshunk mit Root
> und dem Besitzer der Geldbuchung abstimmen. Es gelten die STOP-Bedingungen.

## Status und Rahmen

- Priorität P1; Aufwand L; Risiko HIGH (Ownership und unveränderliche Geldbelege).
- Geplant an Commit `f808927`, 2026-09-02, **mit umfangreichen uncommitteten
  Paralleländerungen**. HEAD allein beschreibt den geprüften Quellstand nicht.
- Abhängigkeiten: `001-mutation-identity-state.md`,
  `002-evidence-ownership-recovery.md`, bestehendes Operationsjournal und
  005-Money-/Fill-Provenance ab Migration 35/36; gemeinsamer Historybudgetpfad.
- Kein Server-/Broker-/Kontozugriff, keine echten Trades, kein Commit/Push.
  Öffentliche Primärdokumente und installiertes CCXT **4.5.75** wurden gelesen.
- Nicht Bestandteil: neue Börsenprofile, eine neue Attached-Entry-Strategie,
  automatisches Übernehmen fremder Orders, Lockerung von Fillcoverage,
  gegenwärtige Accountfinalität, neue Fundingparser oder Baselineverschiebung.

Driftcheck vor Implementierung:

```powershell
git diff --stat f808927..HEAD -- src/trading_types.ts src/exchange_order_correlation.ts src/exchange_contract_validation.ts src/trading_evidence_repository.ts src/trading_order_repository.ts src/trading_recovery.ts src/trading_fill_accounting.ts src/trading_money_ledger.ts src/db.ts exchange_executor/order_identity.py exchange_executor/ccxt_adapter.py exchange_executor/history_reader.py exchange_executor/kraken_history.py
git diff --stat -- src exchange_executor tests
```

Die unten beschriebenen Funktionen mit dem aktuellen Code vergleichen. Für die
bereits schmutzige Ausgangsbasis wurden folgende SHA256 notiert:

| Datei | SHA256 |
|---|---|
| `src/exchange_order_correlation.ts` | `62B9927F743FB49D2A20AA4AD78E63B5C5F0A465BB230526AF6942086D469CD2` |
| `src/trading_evidence_repository.ts` | `E1780B7187D356C14EE7FB18A9C62C55C80003A255407BC514CB278EAD57587D` |
| `src/trading_fill_accounting.ts` | `FB5308BAE8AB2D25304DD4646F77DC35E5B305DC6BC3C28909F13E59556F2EB8` |
| `src/trading_money_ledger.ts` | `6DFFF79FB483A32D3A778BB23D23A872DCC2F44128A1FA1DD80E202079887B19` |
| `exchange_executor/order_identity.py` | `CF6628F0F3996A827419B77F4C8157F77D6B93232E1F163B4EED4EFB80E95C27` |
| `exchange_executor/ccxt_adapter.py` | `2CA2091B44756A789961C0BD82E658947AD39C8E1A5D738E136053F7E463EC57` |

## Ergebnis in Kürze

1. **Kraken hat einen sofort nutzbaren positiven Batchbeweis:** `order_tag`
   verbindet den gesendeten Auftrag mit `batchStatus[].order_id`, auch ohne
   `cliOrdId`. CCXT erhält den Tag in `order.info`; unser Korrelator ignoriert ihn.
2. **Bybit hat einen echten Attached-Parentbeleg:** `parentOrderLinkId` auf
   Realtime- und Historyorders. Er ist nur zusammen mit einem belegten ursprünglichen
   Attached-Auftrag zulässig. Ein normaler Zweiorderbatch ist kein Attached-Auftrag.
3. **Hyperliquid hat einen positiven gezielten Lookupweg:** Abfrage einer
   dauerhaft eigenen `cloid` liefert eine konkrete Order. Eine fehlende `cloid`
   in der Antwort darf nur mittels des tatsächlichen Anfrage-/Antwortbelegs
   überbrückt werden, nicht mittels Antwortindex oder Stopparametern.
4. **Fillidentität braucht mehr als einen neuen Index:** Original-ID und Konto
   werden heute gespeichert, der Marktbereich geht aber in Fill- und Money-Dedupe
   verloren. Bei Hyperliquid ist außerdem die echte Providerzeit Teil des
   dokumentierten Trade-Scopes. Beide inline-UNIQUE-Constraints müssen koordiniert
   und verlustfrei ersetzt werden; gespeicherte IDs und Geldoriginale bleiben gleich.
5. Nicht beweisbare Altbestände bleiben sichtbar. Eine Migration darf keine
   ursprünglichen Attached-Aufträge, Marktsymbole, Kontoidentitäten oder Provider-IDs
   nachträglich erfinden.

## Konkreter Iststand und lokal bestätigte Repros

### Orderbindung

- `exchange_executor/order_identity.py:52`, `correlate_batch`: akzeptiert nur
  eindeutig vorhandene erwartete Client-IDs; `Counter` über Remote-IDs; keine
  Indexheuristik. Das ist sicher, lässt reale alternative Belege aber ungenutzt.
- `exchange_executor/ccxt_adapter.py:281`, `_normalized_fill`: echte `trade.id`,
  `trade.order`, `trade.timestamp`; Orderlookup bereits `(providerSymbol, orderId)`.
- `src/exchange_order_correlation.ts:25`, `exactIdentity`: exakte Client-ID oder
  exakte Exchange-ID im Markt. Kein Parent-/Batchbeweis.
- `ccxt_adapter.py:216`, `_normalized_open_order`: bewahrt `raw`, aber kein
  validiertes Linkfeld. `ExchangeOrderSnapshot` und Node-Validator haben ebenfalls
  keinen expliziten Parent-/Batch-Belegvertrag.
- `trading_order_repository.ts:80`, `persistOrderEvidence`: CAS und unveränderter
  `remote_order_key`; `response_json` wird bei späterem Readback ersetzt. Deshalb
  darf die einzige ursprüngliche Bindungsurkunde nicht nur dort gespeichert werden.
- `trading_recovery.ts:84`, `prepareTradingOperation`: speichert Originalrequest,
  SHA, Konto-Fingerprint, Credentialgeneration, lokale erwartete Orders und Phase.
  Der Request beschreibt derzeit `{entry, protectiveStop}`; er enthält keinen
  expliziten nativen Attached-Request oder dauerhaft angegebenen Kraken-Batchtag.
- Alle drei Profile wählen derzeit `certified_batch`.
  `test_entry_price_sdk.py:66` beweist für Hyperliquid ausdrücklich `grouping='na'`.
  Der aktuelle Bybit-Request enthält einen unabhängigen Stopauftrag. Das darf der
  neue Consumer nicht nachträglich als parentgebundenes Attached TP/SL behandeln.

Lokaler CCXT-Parse-/Korrelationsversuch ohne Transport, 2026-09-02:

```text
ccxt 4.5.75 Kraken parsed [('entry-remote', None, 'owned-entry'), ('stop-remote', None, 'owned-stop')]
CURRENT: real tagged acknowledgements remain unresolved
Bybit parent raw preserved: actual-entry-client normalized parent present: False
```

Die Krakenfixture enthält zwei echte `order_tag`-Felder, je eine konkrete
`order_id`, passende `orderEvents[].order` mit Symbol/Seite/Menge, aber
`cliOrdId=null`. Das Ergebnis belegt einen nutzbaren Datenpfad, keine Providerabnahme.

### Fill- und Geldidentität

- `db.ts:762`: `trading_fills` enthält `UNIQUE(account_id, exchange_fill_id)`.
- `trading_evidence_repository.ts:173`: Lookup ausschließlich Konto/Fill-ID;
  abweichende lokale Order wird konservativ als Konflikt gespeichert.
- `trading_evidence_repository.ts:201`: Konfliktmarkierung trifft alle
  Belege derselben nackten Provider-ID, auch andere Märkte.
- `trading_fill_accounting.ts:30`: Provenance-Anreicherung sucht wieder nur
  Konto/Fill-ID; `postFees` und `postPricePnl` verwenden die nackte ID als Money-ID.
- `trading_money_ledger.ts:162`: Event-ID ist SHA von
  `[accountId, accountFingerprint, providerEventId, kind]`.
  `source` steht im Original, **nicht** im Identitätsschlüssel.
- `db.ts:2150`: Money-UNIQUE hat dieselben vier Felder und ignoriert `fill_id`.
- `trading_engine.ts:1883`: Benachrichtigungs-Dedupe `fill:${account.id}:${id}`;
  `remoteStateDigest` verwendet eine Liste nackter Fill-IDs. Diese Verbraucher
  müssen beim Wechsel geprüft werden, sonst bleibt die neue Identität unvollständig.
- `trading_remote_evidence` ist bereits stärker: Identity v2 enthält Provider,
  Fingerprint, Art und Providersymbol. Für Hyperliquid fehlt aber die
  providerspezifische Zeitkomponente; ein echter gleicher `tid` später im selben
  Markt würde erneut als Konflikt erscheinen.
- `trading_scope_execution.ts` arbeitet orderbezogen mit echten Bybit-Exec-IDs.
  Diese Original-IDs dürfen **nicht** durch zusammengesetzte IDs ersetzt werden.

Zweite isolierte Repro mit frischer temporärer DB, zwei lokalen Orders in
`BTCUSDT` und `ETHUSDT`, exakter Client-/Exchange-ID je Order und gleicher realer
Fill-ID:

```text
BTCUSDT inserted true
ETHUSDT inserted false
stored fills { n: 1 }
conflicts { n: 2 }
```

Das ist derzeit konservatives Blockieren, kein beobachtetes Übernehmen fremder
Fills. Die Sollregression muss zwei voneinander getrennte Fills speichern können.
Die temporäre DB wurde geschlossen und das eigens angelegte Verzeichnis entfernt.

## Verfügbare Primärbelege und tatsächliche Grenzen

### Bybit

Die offiziellen Realtime- und Historyschemas nennen `parentOrderLinkId` für
Attached TP/SL. Änderungen eines Futures-Attached-Stops erhalten den Link; ein
positionsweites TP/SL auf einer Position, die ursprünglich keines hatte, hat
keinen verwertbaren Parent-Link. Quelle: [Realtimeorder](https://bybit-exchange.github.io/docs/v5/order/open-order),
[Historyorder](https://bybit-exchange.github.io/docs/v5/order/order-list).
Die Einführung ist auf den 2026-01-07 datiert. [Changelog](https://bybit-exchange.github.io/docs/changelog/v5#2026-01-07)

Lokal: `ccxt/bybit.py:3722` / `parse_order` bewahrt das Original in `info`, liest
Clientidentität nur aus `orderLinkId`. Keine SDK-Aktualisierung nötig, um das echte
Parentfeld streng zu extrahieren. Den Requestkategoriescope beim Lesen binden,
weil Einzelrows nicht immer selbst `category` enthalten.

Positive Freigabebedingung für die neue **Orderbindung**, nicht für Accountfreigabe:
belegter eigener Parent + tatsächlich gespeicherter ursprünglicher Attachedauftrag
+ exakte passende aktuelle Childorder + genau ein zulässiger lokaler Pending-Slot.
`stopOrderType`, `createType`, `positionIdx`, `tpslMode`, Trigger und Menge sind
zusätzliche Prüfungen, **allein kein Eigentumsbeweis**. Options-Parentregeln und
positionweites TP/SL nicht stillschweigend in das erste lineare Profil aufnehmen.

Bei unabhängigen heutigen Batchlegs bleibt `orderLinkId`/gezielter Readback der
richtige Nachweis. Die Batchantwort enthält pro Resultat `orderId`, `orderLinkId`
und Symbol; ihr Erfolg quittiert zunächst die Anfrage, nicht den vollständigen
Lebenszyklus. [Batch Place](https://bybit-exchange.github.io/docs/v5/order/batch-place)

Für Fills sind `execId`, `orderId`, `symbol`, `execTime` Originalfelder;
`seq` ist kein Fill-ID-Ersatz und kann mehrere Ausführungen/Marktbereiche betreffen.
Konto- und Kategorie-/Marktscope mitführen. Transaktionslog-`tradeId` bleibt eine
andere Identität und kein Alias. [Execution](https://bybit-exchange.github.io/docs/v5/order/execution)

### Kraken Futures

`order_tag` wird vom Client zur Zuordnung eines gesendeten Batchauftrags gesetzt
und im Resultat neben `order_id` zurückgegeben. Dies ist explizite Korrelation,
nicht ein aus der Antwortposition abgeleiteter Tag. [Batchvertrag](https://docs.kraken.com/api-reference/order-management/batch-order-management)

Lokal: `ccxt/krakenfutures.py:1315` setzt ohne Vorgabe Tags `1`, `2`, ...;
`parse_order:1805` bewahrt die jeweilige Batchrow in `info`.
**Neue eigene Tags vor Dispatch explizit in den Originalrequest schreiben**;
z.B. derselbe bereits persistierte eindeutige Client-Identifier als `order_tag`.
Aufgezeichnete Request-/Antwortbindung prüfen. SDK-generierte numerische Tags
ohne erhaltene tatsächliche Requestabbildung nicht nachträglich als globale
Identität auslegen. Nie `zip(specs, parsedOrders)` verwenden.

History v3 liefert `accountUid`, native `tradeable`, `order.uid`, echte
`execution.uid` und Ereignis-UID separat. Triggerereignisse wie
`OrderTriggerActivated` liefern einen Triggerdatensatz, aber das geprüfte Schema
keine generische Parent-Entry→Child-Order-Kante. `positionUid`, gleicher Zeitpunkt
oder ein Activated-Event sind kein Ersatz dafür. [Executionevents](https://docs.kraken.com/api-reference/account-history/get-execution-events),
[Triggerevents](https://docs.kraken.com/api-reference/account-history/get-trigger-events)

Zusätzliche harte Fillgrenze: CCXT `fetch_my_trades:2270` liest derzeit
`/derivatives/api/v3/fills` (`fill_id`); der eigene Historyreader liest
`/history/v3/executions` (`execution.uid`). Die geprüften Schemata beweisen keinen
Alias zwischen **unterschiedlichen** IDs dieser Quellen.
[Recent-Fillschema](https://docs.kraken.com/api-reference/historical-data/get-your-fills)
Nicht beide Quellen durch verschiedene neue Namespaces zu zwei Buchungen machen!
Für den ersten strengen Buchungspfad v3-Execution als kanonische Quelle wählen;
andere Quellen als Originalbeobachtungen erhalten, solange ihre Gleichheit nicht
explizit belegt ist. Gleiche Zeit/Preis/Menge genügt nicht. Diese Providerentscheidung
vor Umsetzung mit Root freigeben lassen. Auch geschätzte CCXT-Gebühren sind keine
neue Originalgebührenquelle; dieser Plan zertifiziert sie nicht.

### Hyperliquid

`orderStatus` kann mit konkreter OID oder eigener 128-bit `cloid` abgefragt werden.
Der aktuelle gezielte Reader nutzt dies bereits, verlangt beim Client-only-Weg
aber anschließend nochmals eine zurückgegebene identische `clientOrderId`.
Ein eindeutig gebundener tatsächlicher Lookup ist ein positiver alternativer
Identitätsbeleg; `unknownOid` ist kein Beweis eines nie gesendeten Auftrags.
[Orderstatusvertrag](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#query-order-status-by-oid-or-cloid)

`ccxt/hyperliquid.py:2076` erhält bei Erstellung nur Statusobjekte mit OID oder
`waitingForTrigger`; `parse_order:3128` kennt die ursprünglichen Client-IDs dort
nicht. Die API zeigt `children: []`, das geprüfte öffentliche Schema belegt aber
keine belastbare vollständige Childobjekt-/Parentsemantik für unseren Fall.
**Keinen erfundenen children-Parser als fertig zertifizierten Parentpfad einbauen.**
Der aktuelle `grouping='na'`-Batch hat ohnehin keinen Attached-Parentvertrag.
[Exchangevertrag](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint)

Die Tradebeschreibung nennt `tid` einen 50-bit Hash und nennt die Kombination
Providerblockzeit, `coin`, `tid` als globalen Trade-Identifier. CCXT
`parse_trade:3380` gibt dagegen allein `tid` als `trade.id` aus.
Die Felder `time`, `coin`, `tid`, `oid` bleiben in `trade.info` erhalten.
[Datentypen](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)
Diese Dokumentation ist Identitätsevidenz, **keine Erlaubnis, Websocketdaten als
RESTfinalität zu verwenden**. Der neue REST-Fillprofilvertrag muss genau diese
Originalkomponenten prüfen; keine lokale Zeit einsetzen. `coin` inklusive
Dexpräfix bzw. Spotkennung erhalten. `aggregateByTime=false` bleibt Pflicht für
Einzelausführungsbelege.

## Minimaler vorgeschlagener Vertrag

### A. Eigener Identitätsbeleg, nicht ein `proved: true` aus Rohdaten

Neues kleines geschlossenes `ExchangeOrderIdentityEvidence` in einem eigenen
Vertragsmodul; Varianten zunächst:

- `kraken_batch_tag_v1`: eigener gespeicherter Batchtag, tatsächliche antwortende
  Order-ID und native Symbol-/Semantikfelder, requestHash, Operation-ID, ursprüngliche
  Credentialgeneration, Empfangs-/Providerzeit soweit tatsächlich geliefert.
- `hyperliquid_cloid_lookup_v1`: tatsächlich abgefragte eigene cloid, gebundene
  Benutzeradresse, konkrete Antwort-OID, native coin, Quelle `orderStatus`,
  Readbeginn/-ende. Zurückgegebene abweichende cloid ist ein Konflikt.
- `bybit_attached_parent_v1`: `parentOrderLinkId`, konkrete Child-ID, Kategorie,
  natives Symbol, Original-Stoptyp und -Semantik; Referenz auf den **wirklich
  vorhandenen** ursprünglichen Attachedrequest und Parentbindung.

Gemeinsamer Scope: Providerprofil/-version, accountId, accountFingerprint,
beobachtete Credentialgeneration, lokale Order, belegtes `providerSymbol`, Quelle,
kleines allowlistiertes Originalpayload und Hash. Keine Secrets, HTTP-Headers,
beliebige `info`-Objekte oder künstlichen Provider-IDs im Beleg.

Der Pythonreader liefert nur normalisierte **Evidenz**; Node beweist anhand des
Journals und der aktuellen DB die lokale Bindung. Wenn `remote.clientOrderId=null`
war, diese originale Tatsache erhalten; eine daraus abgeleitete lokale Client-ID
ist eine annotierte Bindung und keine angeblich vom Provider gelieferte Client-ID.

Eine kompakte neue Tabelle `trading_order_identity_bindings` genügt als dauerhafter
Anker: lokale Order-ID als PK/FK, Account/Fingerprint, Operation-ID, Profil,
ursprüngliche Generation, `remote_order_key`, Belegtyp, Beleghash, begrenztes
`evidence_json`, `created_at`. Kein automatisches UPSERT-Ersetzen. Wiederholung mit
identischer Bindung ist idempotent; andere Remote-ID/Parent/Request erzeugt
unaufgelösten Identitätskonflikt. Spätere REST-Snapshots dürfen die ursprüngliche
Bindungsurkunde nicht überschreiben. Ungültige/mehrdeutige Beobachtungen weiterhin
im bestehenden Remote-Evidenzbestand aufbewahren.

Die Beziehungen zu lokaler Order, Account und Operationsjournal sind RESTRICT-
Belegreferenzen. `prepareTradingRetentionCandidates` muss auch Intents mit einer
solchen Bindung erhalten, damit ein späterer Prunelauf nicht am neuen FK scheitert
oder den Ursprung entfernt. Keine zusätzliche automatische Archivierung/Löschung.

Für eine erstmalige Parentbindung müssen in **derselben Account-FIFO/DB-Transaktion** gelten:

1. Konto-Fingerprint und ursprüngliche Operation stimmen; kein freier Client-ID-
   String ohne Journal. Credentialrotation ist keine Übernahmeerlaubnis.
2. Der unveränderte Originalrequest enthält den Beweis der passenden Strategie.
   Für Attached also tatsächlich Attached, nicht nur zwei geplante Orders.
3. Genau ein noch ungebundener, nicht terminaler lokaler Stopslot gehört zu diesem
   Parent/Request/Generation. Ein alter `filled`/`cancelled`/`rejected`-Stop ist
   niemals Kandidat einer neu gefundenen Remoteorder.
4. Der Auftrag war tatsächlich möglicherweise abgesendet (`dispatching`/
   `acknowledged`/`unresolved` mit gültigem Journal), nicht nachweisbar No-Send oder
   ein beliebiger `created`-Plan. Bei Journalwiderspruch keine Bindung.
5. Kind/Seite, reduceOnly, Quantity, Trigger, exakter Provider-Markt und aktueller
   Lifecycle passen. `Full`-positionsweites TP/SL ist kein Ersatz für eine exakt
   geplante eigene Teilmenge. Nie Mengen umschreiben, damit sie passen.
6. Parentclient, Childclient und Remote-ID widersprechen keiner existierenden
   lokalen oder fremden Bindung. CAS `changes===1`, Unique-Key und Relation gemeinsam
   committen, bevor der Consumer lokale Rolle/Client-ID ergänzt.

Ein belegter Parent kann als Entry terminal `filled` sein; **das verbietet nicht
seinen noch aktiven Childstop**. Die Nichtterminalbedingung betrifft den zu bindenden
Child-Lifecycle. Die neue Bindung beweist außerdem nicht automatisch die heutige
Schutzwirkung; dafür bleiben aktuelle REST-Semantik und `positionProtected` zuständig.

### B. Fill-Original-ID erhalten, separaten Namespace berechnen

`exchangeFillId` bleibt unveränderte echte Provider-ID. Additiv erhält ein Fill
einen streng validierten kleinen Identitätszeugen:

```typescript
interface ExchangeFillIdentityEvidence {
  version: 1;
  profile: 'bybit_execution_v1' | 'hyperliquid_user_fill_v1'
    | 'kraken_history_execution_v3' | 'paper_fill_v1';
  marketNamespace: string; // geschlossen nach Profil, z.B. Bybit category=linear
  providerMarketId: string; // tatsächlich BTCUSDT, dex:COIN/@index, PF_XBTUSD, ...
  providerSymbol: string; // exakt geladenes, belegtes Providersymbol
  providerFillId: string; // muss exchangeFillId entsprechen
  scopeTimestamp: number | null; // nur HL: echtes info.time == filledAt
}
```

`profile`/Namespace werden aus dem tatsächlichen Reader gewählt, nicht aus einem
beliebigen Providerfeld. Node validiert gegen den Accountprovider und berechnet
selbst einen `remote_fill_key`, sinngemäß:

```text
['fill-v1', provider, accountFingerprint, identityProfile,
 marketNamespace, providerMarketId, providerFillId, scopeTimestamp]
```

`account_id` bleibt zusätzlicher DB-Unique-Scope. Das geladene `providerSymbol`
wird separat gespeichert, exakt gegen Order und Originalmarkt geprüft; eine spätere
abweichende Symbolabbildung ist kein automatischer neuer Fill. Der native Markt-ID-
Scope vermeidet eine Neuschöpfung der Identität durch einen geänderten CCXT-Anzeigenamen.

Wichtig:

- **Credentialgeneration nicht in den Fillkey** aufnehmen; sonst würde dieselbe
  Ausführung nach Schlüsselrotation neu gebucht. Beobachtungsgeneration separat
  aufbewahren, Fingerprint-/UID-Regeln nicht verändern.
- Bei Bybit/Kraken ist die Zeit Payload, nicht Ausweichschlüssel: gleiche Identität
  mit geänderter Zeit ist ein Konflikt. Bei HL ist echte Providerzeit selbst
  Bestandteil des dokumentierten Scopes; gleiche Zeit/coin/tid mit geändertem
  Order-/Economicpayload bleibt ebenfalls Konflikt.
- Keine Order-ID in den Key aufnehmen, um einen Orderwiderspruch zu kaschieren.
  Sie ist zu prüfendes Payload/Ownership, nicht ein Ausweg aus Konflikten.
- Keine Quell-Endpoint-ID als freie Namespacevariante zum Verdoppeln derselben
  Ausführung. History/Recent-Readbacks derselben bewiesenen Executionfamilie müssen
  denselben Key bilden. Unbewiesene Cross-Source-Aliase bleiben unresolved.
- Fehlende Identitätskomponenten → Original als ungelöste Evidenz, nicht Hash oder
  aktuelle Marktliste als künstliche Fill-ID. Unbewertete echte Fills dürfen als
  solche erhalten bleiben; Accountingbeweis ist eine getrennte Pflicht.

### C. Primäre Fillprofile und Cross-Source-Regeln

| Profil | Originale, die wirklich geprüft werden | Primärer Buchungspfad / Ausschluss |
|---|---|---|
| `bybit_execution_v1` | gebundene Envelopekategorie `linear`, `info.symbol`, `info.execId == exchangeFillId`, `info.orderId == exchangeOrderId`, ursprünglicher Fingerprint; Zeit/Economics gegen `execTime/execQty/execPrice/execFee` | Tatsächliche V5-Executionrows; Recent und History derselben Familie gleich adressieren. `seq`, Log-`tradeId`, Ledger-`id` und `blockTradeId` sind keine Exec-ID. Andere Kategorien benötigen ein ausdrücklich geprüftes Profil. |
| `hyperliquid_user_fill_v1` | Benutzeradresse/Fingerprint des tatsächlichen Requests; `info.coin`, `info.tid`, `info.time`, `info.oid`; native Coinkennung und belegtes Providersymbol | Nicht aggregierte `userFills`/`userFillsByTime` bilden denselben Key. Zeit ist Original-`time`, nicht Antwort-/Empfangszeit. TWAP-Hülle nicht als zusätzliche Ausführung buchen. |
| `kraken_history_execution_v3` | tatsächlich `event.execution.execution.uid`, `order.uid`, `order.accountUid`, native `order.tradeable`, Event-UID separat; outer/inner Account-UID gleich | Kanonischer History-v3-Executionpfad. `_execution` muss die nötigen allowlistierten Originalfelder zusätzlich erhalten; bisheriges `info={providerEventId}` reicht für neuen nativen Markt-/Quellbeweis nicht. `fill_id` aus Recent-REST wird nicht ohne Vertrag auf `execution.uid` umbenannt. |
| `paper_fill_v1` | Original `trading_paper_fills.exchange_fill_id`, Account, konkrete Originalpaperorder, Symbol und vollständige Economics | Einzige Quelle ist der lokale deterministische Paperprovider; separate Originalquelle erhalten. Kein Livelegacyfill bekommt allein wegen passender Economics ein Paperprofil. |

Ein neuer Key verlangt Originalbeleg und beweist nicht automatisch korrekte
Gebühren, vollständigen Fillbestand oder Terminalität. Bei vorhandenen Daten mit
unvollständiger Quellmarkierung wird keine Familie geraten. Ein späterer echter
Readback darf die bestehende lokale Fill-ID nur dann mit einem Key ergänzen, wenn
Original-Fill-ID, konkrete Orderbindung/Provider-Markt, Fingerprint und sämtliche
erhaltenen Economics genau einen widerspruchsfreien Legacykandidaten belegen.
Sonst bleiben neue Beobachtung und Altbestand ungelöst; es entsteht kein zweiter
Fill als vermeintliche Reparatur.

### D. Vollständige betroffene Dedupe-/Provenienzstellen

| Stelle | Erforderliche Änderung oder explizit zu erhaltende Grenze |
|---|---|
| `ccxt_adapter.py::_normalized_fill`, `remote_evidence.py::unresolved_trade`, `kraken_history.py::_execution`, bestehende History-/Recentreader | native Originalkomponenten/Quelle transportieren; Konto aus tatsächlichem gebundenem Request; keine generischen `id`-Aliase und keine Original-ID-Umschreibung |
| `trading_types.ts`, `exchange_contract_validation.ts::validateFill/validateUnresolvedEvent` | geschlossener profilbezogener Zeugenvertrag; Grenzen/SafeInteger; kein vom Adapter frei geliefertes `remoteFillKey` als vertrauenswürdige Identität |
| `exchange_order_correlation.ts::correlateRemoteFills` | bestehende exakte Orderbindung/Marktprüfung erhalten; Fillkey ist kein Eigentumsnachweis und kein Ersatz für eine Order-ID |
| `trading_evidence_repository.ts::persistCorrelatedFill/sameFill` | per bewiesenem Key bzw. eindeutiger belegter Legacyreferenz suchen; lokale Fill-ID an Folgeconsumer zurückgeben; neue Rows nur nach allen Bindungsprüfungen |
| `evidenceIdentity/fillEvidence/markProvenFill/evidenceMatchesProvenFill/recordFillConflict` im selben Modul | einheitlicher profilsicherer Key auch für unresolved/managed/conflict; Markierung nur dieses Scopes, nicht alle nackten IDs; vorhandene Originalkonto-/Zeitwerte verwenden, niemals aus dem eingehenden Konfliktbeleg rekonstruieren |
| `trading_fill_accounting.ts::captureFillAccounting` | reale persistierte Fill-ID statt erneuter Konto/Provider-ID-Abfrage; Provenance separat, Konfliktstatus sticky |
| `trading_fill_accounting.ts::readSource/postFees/postPricePnl` | Key/Identitätsstatus mitlesen; unveränderte echte Fill-ID an Money weitergeben; ursprüngliche Provider-ID/Quelle als Original erhalten |
| `trading_money_ledger.ts::cleanEvent/recordMoneyEvent/recordFeeEvent` | bei Fillbasis Konto/Fingerprint/echte Fillreferenz prüfen; Alt-Event über fill_id/kind genau wiederverwenden; Providerbasis/Funding unverändert |
| `db.ts::trading_fills/trading_money_events`, deren Indizes/Trigger, Migrationtests | Migration40-Rebuild mit unveränderten lokalen IDs/Originalen; FK-/Triggerprüfung und Legacy-Dedupe-Fence |
| `db.ts::prepareTradingRetentionCandidates/pruneTradingData` | Intents mit neuer Orderbindungsurkunde konservativ behalten; neue FK-Quelle nicht durch Löschen umgehen |
| `trading_engine.ts::persistRemoteFill` | Notificationkey aus neuer stabiler Fillidentität oder echter persistierter lokaler Fill-ID; Details behalten Original-ID plus Markt |
| `trading_engine.ts::remoteStateDigest/compactRemoteSnapshot` | nicht nur nackte Fill-ID-Liste hashen; Namespace und relevante Originalökonomie binden. Neue Digestversion ausdrücklich kennzeichnen, alte Snapshots nicht umschreiben |
| `trading_scope_execution.ts::observedOrderExecutions/assertIdentity` und `trading_account_scope.ts` | wirkliche Bybit-Exec-ID weiterhin original prüfen; Provenance/Identitystatus ergänzen, keine zweite Execution durch neuen Key; bestehende orderbezogene Korrelation nicht auf Ledger-ID umstellen |
| `trading_baseline_classification.ts`, Legacy-/Coverage-Restoretests | ungeklärte Originale/Konflikte nicht allein wegen neuer Keyversion extern/managed klassifizieren; keine neue Baseline oder Coveragequittierung |
| `trading_repository.ts` Monitoring-Fillquery und `trade_journal.ts::loadJournalFills` | lokale `id` bleibt stabil; tatsächliche Provider-ID anzeigen und Namespace/Status additiv mitgeben; DTOs nicht still auf zusammengesetzte IDs umbenennen |
| `paper_exchange.ts`, `trading_paper_fills` und `recoverPaperProvenance` | Originalpaper-IDs/-DB-Zeilen bleiben unverändert; unabhängigen Legacy-Beleg nicht abbauen |
| alle `exchangeFillId`/`exchange_fill_id`-Verwendungen in `src` und Fixtures | nach Handofffunktionen erneut mit `rg` kontrollieren; nackte ID als Anzeige erlaubt, als kontoweite deduplizierende Identität nicht |

Kostenbasis-Kompatibilität: `postPricePnl` verwendet bereits Providerzeit und
Economics in der versionierten Ableitung. Die bestehende Formel und ihre Hashversion
nicht beiläufig ändern, nur weil zusätzliche Identitätsfelder existieren. Sonst
würden unveränderte Alt-Events beim Replay wegen anderer `derivation` als Konflikt
erscheinen. Eine mathematisch gleiche alte Ableitung muss dieselbe Originalurkunde
behalten; ein tatsächlich nötiger Algorithmuswechsel wäre ein separater Auftrag.

## Migrationsvorschlag 40 — Implementierung erst nach Entwurfsfreigabe

Root hat nach Abschluss von 38/39 die **Migration 40** für diesen Entwurf benannt.
Vorgeschlagener Name: `proven_order_bindings_and_scoped_fill_money_identity`.
Zwei logische Änderungen werden in dieser koordinierten atomaren Migration
abgebildet; kein nachträglicher Hunk in Migration 38 oder 39.

1. Order-Bindungstabelle additiv. Keine historischen Links ohne Originalbeleg.
2. Fill-/Moneyidentität zusammen umstellen, damit ein neuer Fill nicht einen alten
   Moneykey trifft. Ein bloß zusätzlicher Index entfernt die alten inline-UNIQUE-
   Constraints nicht.

### Verlustfreier Fill-Rebuild

- Neue Version von `trading_fills` enthält **alle** bisherigen Spalten unverändert,
  plus `provider_symbol`, `remote_fill_key`, `identity_json`, `identity_status`
  (`proven`/`unresolved`/`conflict`, zunächst ungelöste Legacyrows).
- Alte `id`, `order_id`, `account_id`, `exchange_fill_id`, Zahlenstrings, Zeiten,
  `raw_json`, `accounting_json`, Fingerprint und sticky accounting_conflict exakt
  kopieren. Keine INSERT-IGNORE-Auswahl und keine neue UUID für vorhandene Rows.
- Den alten inline-UNIQUE-Constraint ersetzen durch partiellen Unique-Index
  `(account_id, remote_fill_key) WHERE remote_fill_key IS NOT NULL`.
- Einmalige Backfillprüfung nur aus belegter Originalprovenance: echte Fill-ID,
  Originalmarkt/Orderbindung, ursprünglicher Kontofingerprint, HL Originalzeit.
  Aktueller Accountdatensatz allein bindet keinen alten Livefill. Paper nutzt die
  schon vorhandene unabhängige `trading_paper_fills`-/Orderoriginalquelle.
- Fehlende Originale erhalten `remote_fill_key=NULL`. Diese Rows bleiben bei
  Ownership-/Accounting-/Freigabeprüfungen relevant und blockieren ihre unbewiesene
  Projektion. Auch nach Wegfall des alten UNIQUE darf ein eingehender Beleg mit
  möglicherweise gleicher ungelöster Altidentität nicht automatisch als neuer Fill
  neben dem alten gebucht werden: Legacy-Recovery prüfen oder ungelöst behalten.
- Bewiesene gleiche Keys mit widersprüchlichen Originalen: Diagnose mit betroffenen
  lokalen IDs, Transaktion abbrechen/Account blockieren; kein Merge nach Heuristik.
- Vor Rebuild die tatsächlichen Indizes/Trigger/FK-Verbraucher erfassen. Bestehende
  `idx_trading_fills_order` und `trading_accounting_fill_insert/update` wiederherstellen.
  Bisherige Referenzen bleiben gültig, weil lokale Fill-IDs erhalten werden.

### Money-Rebuild ohne Änderung alter Geldoriginale

- `basis='provider'` behält bisherige Dedupe/Source-/Aliasregeln unverändert;
  insbesondere Bybit-/HL-Fundingoriginale nicht neu adressieren.
- Für `basis='fill'` muss `fillId` auf einen tatsächlich bewiesenen Fill des
  Kontos/Fingerprints verweisen. Neue Eventidentität aus tatsächlicher lokaler
  Fill-ID + Konto/Fingerprint + Art; `provider_event_id` bleibt die Original-ID.
- Vorhandene Events zuerst über **dieselbe echte fill_id + kind** finden und nach
  vollständiger Original-/Ableitungs-/Asset-/Zeitprüfung wiederverwenden. Deren
  `id`, `source`, `provider_event_id`, `content_json`, Valuation und Konflikte
  unverändert lassen. Mehrere Kandidaten oder andere Ableitung → Konflikt, keine
  beliebige Auswahl und kein zweites Event.
- Alten Money-inline-UNIQUE-Constraint durch partielle Eindeutigkeit ersetzen:
  bisheriger Providerkey für `basis='provider'`; bewiesene `fill_id + kind` mit
  Konto/Fingerprint für Fillbasis. Legacy-Fillbasis ohne echte fill_id bleibt
  ungelöst; ihre Existenz muss beim Wiederbuchungsschutz berücksichtigt werden.
- Moneytabellen-Rebuild erhält alle Event-IDs, Original-JSON, Valuations und
  Konflikt-FKs. Bisheriges Schema enthält für `fill_id`/`intent_id` an dieser Stelle
  nicht selbst zwingend einen FK; keine unbeprüfte FK-Nachrüstung für Altbestände.
  Der Laufzeitvalidator muss dennoch echte referenzierte Ownership nachweisen.
- Der 005-Besitzer bestätigte am 2026-09-02 diese enge Richtung: Fill-ID-basiert,
  Legacyoriginale wiederverwenden, Konflikt statt Auswahl, Funding nicht ändern.

Migration nach bestehendem `applyPendingMigration`-Muster (`foreignKeysOff` vor
`BEGIN IMMEDIATE`, FK-Prüfung vor Commit, bei Fehler Rollback, FK danach wieder an).
Kein Umgehen von Wartungs-, Backup- oder Startupschutz. Schema-Rebuild ist keine
Berechtigung, Benutzerbelege zu löschen. Vor/nach Migration Row-/ID-/Originalhashes,
Trigger und FK-Prüfung vergleichen. Fehler nach dem Kopieren und vor/nach Rename
erzwingen, anschließend muss entweder der alte oder vollständig neue Zustand
konsistent vorhanden sein.

Vor Anlage der Fillbasis-Money-Unique-Regel die Bestandssuche
`GROUP BY account_id, account_fingerprint, fill_id, kind HAVING COUNT(*) > 1`
mit `basis='fill' AND fill_id IS NOT NULL` ausführen. Ein Treffer ist ein
Migrationskonflikt, nicht die Erlaubnis, eine der Geldoriginalzeilen zu löschen.
Neue RequiredTables-/Schema-Gates und Rewindfixtures auf Version40 abstimmen;
zugehörige Fixtures dürfen nur ihre eigenen neuen Tabellen/Trigger in FK-Reihenfolge
entfernen. Keine historische Migrationschecksum oder Backupintegritätsgrenze ändern.

## Umsetzungsreihenfolge nach Freigabe

### 1. Rote Identitätsfixtures und geschlossenen Vertrag anlegen

Neue `tests/test_trading_fill_identity.js`,
`tests/test_trading_order_identity_bindings.js`,
`exchange_executor/tests/test_provider_order_identity.py`; bestehende
`test_exchange_order_correlation.js`, `test_trading_evidence_repository.js` und
`test_entry_price_sdk.py` als Muster nutzen. Zuerst die unten genannten positiven
Fälle gegen den Iststand rot zeigen. Kein Umbau alter negativer Tests in positive
Adoptionsheuristik.

Verifizieren: neue gezielte Testbefehle müssen die ausdrücklich erwartete fehlende
Implementierung melden; bestehende drei Node-Regressionsdateien müssen weiter grün
sein. Dann geschlossene DTO-/Validatorfixtures unabhängig vom Produktivpfad grün.

### 2. Kraken-Tag und HL-Lookup als kleine positive Pfade integrieren

In Node den expliziten Kraken-Tag vor Journalhashbildung zum erwarteten Request
geben; Adapter reicht exakt ihn nach `params.order_tag` weiter. Originalanfrage
und Antwortbeleg werden dauerhaft zusammen gebunden. Python ordnet nach Tag zu,
prüft weiter konkrete Remote-ID/Clientwiderspruch/Symbol/Semantik; Einzellegfehler
dürfen den unabhängig bewiesenen anderen Leg nicht erfinden oder verlieren.

HL gezielten Lookup mit tatsächlicher Anfrageprovenance transportieren. Ein nicht
zurückgeliefertes cloid bleibt original null; nur der Readerbeleg kann die konkrete
OID der abgefragten lokalen cloid zuordnen. Belegfähige Originaldaten erhalten,
fehlende Orderstatus-/Cumulativefields bleiben unknown. Kein erneutes Create.

Nachweispersistenz und CAS-Bindung zuerst, anschließend bestehender monotone Merge.
Neustart nach Providerantwort, vor lokalem Commit muss REST-Recovery nutzen; ein
nur im Speicher verfügbarer verlorener Kraken-Tag ist kein neuer Retrybeweis.

Verifizieren: SDK-Transportfakes mit vertauschten Antworten, fehlenden Clients und
exakten Tags; HL zwei cloid-Lookups bei verlorenem Batch-ACK; keine Sideeffects,
maximal fünf zusätzliche Reads gemeinsam, kein Fortschritt bei Deadlineabbruch.

### 3. Bybit-Parentbeobachtung und enges Binding integrieren

Allowlistierte Parentfelder aus vorhandenen Realtime-/Historyoriginalen übernehmen.
Kein zweiter Historyparser, Cursor oder Budgettopf. Node-Consumer nutzt die
oben festgelegten sechs Bedingungen und die neue unveränderliche Bindungstabelle.

Die aktuelle Produktivstrategie **nicht** zu Attached ändern. Ein positiver
Consumerfixture muss einen wirklich gespeicherten nativen Attachedauftrag liefern.
Für tatsächliche ältere Fälle ohne solchen Originalbeleg lautet das Ergebnis
`attached_request_origin_unproven`, nicht success. Eine spätere neue
Attached-Entry-Strategie braucht eigenen abgestimmten Mutations-/Schutzauftrag.

Verifizieren: genau ein belegter Pendingstop bindet; zwei Kandidaten, alter
terminaler Stop, positionsweites TP/SL ohne Ursprung und falsche Parent-/Markt-/
Kontobindung bleiben ungelöst, ohne Order-/Mengen-/Ownershipänderung.

### 4. Fill-/Moneymigration und sämtliche Dedupe-Verbraucher zusammen umstellen

In neuem kleinem Python-/Node-Identitätsmodul jeweils dieselbe profilgebundene
Fixturematrix verwenden. `_normalized_fill`, History-/Recentprovenance und
Unresolvedoriginale transportieren die Identitätskomponenten; Node berechnet den
Key. `persistCorrelatedFill` gibt die tatsächliche lokale Fill-ID an
`captureFillAccounting` zurück, sodass diese nicht erneut nach nackter ID sucht.

Moneyrecording nach freigegebenem 005-Vertrag; Konfliktscope nach Remote-Fillkey
eingrenzen. Benachrichtigungs-Dedupe und `remoteStateDigest` verwenden den neuen
bewiesenen Key plus relevantes Originalpayload; Reihenfolge stabil sortieren.
Journalausgaben/Scopeprojektion behalten zusätzlich die unveränderte Provider-ID.
Baseline-/Legacybelegklassifikation prüft denselben Namespace und darf alte
Konfliktlabels nicht pauschal zurücksetzen. Belegter korrigierter Collision-Fall
bekommt gegebenenfalls einen separaten Resolutionbeleg, keine Löschung.

Verifizieren: Migration- und Moneyreplaytests einschließlich bestehender
Valuations/Conflicts, Accountrotation und Legacy ohne Originale; keine Doppelbuchung
oder verlorener Beleg. Aktuelle 002-/005-Gates bleiben geschlossen, wenn die
entsprechende Identität unbewiesen ist. Identitätserfolg allein erhöht keine Coverage.

## Rote Testmatrix und Negativgrenzen

| Fall | Erwartung nach Umsetzung |
|---|---|
| Kraken: zwei echte Tags, keine Clients, umgekehrte Antwortreihenfolge | Beide Legs exakt richtig gebunden, null Indexannahmen |
| Kraken: duplicate/unbekannter Tag, widersprechende `order_id`/Eventorder oder Client-ID | betroffene Bindung unresolved/conflict; keine Wiederholung |
| Kraken: SDK `1/2` ohne gespeicherte Abbildung aus altem Prozess | keine nachträgliche eigene Tagurkunde |
| Kraken: erfolgreich gebundener Batch, Neustart, Current-REST ohne Client-ID | bekannte Remote-ID/Marktbindung bleibt nutzbar |
| HL: Create liefert nur OIDs; gezielter eigener cloid-Read liefert OID, cloid null | echte Lookupbindung positiv, ohne Arrayposition |
| HL: fremde Benutzeradresse, abweichende coin/cloid, `unknownOid`, widersprüchliche OID | keine Bindung/keine Abwesenheitsbehauptung |
| Lookup: zwei eigene Legs + Mode/AccountLog/History | tatsächliche Summe ≤5; Reserve/Retry-After eingehalten |
| Abbruch nach erstem Lookup, vor zweitem oder vor Persistenz | restartfähig, kein erfundener zweiter Beleg/kein Submitretry |
| Bybit: echter ursprünglicher Attachedauftrag, ein gültiger Pendingstop, exakter Parent-Link | Bindung und unveränderliche Provenance positiv |
| Bybit: heutiger unabhängiger Batch + äußerlich passender Parent-Link | keine Umdeutung in Attached |
| Bybit: `set trading stop` ohne ursprüngliches Attached TP/SL | keine Adoption trotz passender Menge/Trigger |
| Bybit: Parent gefüllt, eigenes Child offen | Bindung prinzipiell möglich, Parentterminalität allein kein Verbot |
| Bybit: alter terminaler Child, zwei offene Kandidaten, neue Replacementgeneration | keine Wiederbelebung/Mehrdeutigkeit |
| Bybit: fehlendes Originalrequest, nachträglich mutierter Requesthash, No-Send-Journal | keine Bindung |
| Gleiche Fill-ID auf BTC und ETH, sonst korrekt eigene Orders | zwei lokale Fills, zwei je Fill deduplizierte Moneyevents |
| Gleiche Fill-ID auf verschiedenen Konten/Fingerprints | getrennt; keine Übernahme zwischen Kontobindungen |
| Gleiches Konto, gleicher Fill nach Credentialrotation | kein zweiter Fill/Event; Originalgeneration erhalten |
| HL: gleicher tid im selben coin zu zwei echten Providerzeiten | zwei Identitäten; gleiche Zeit+coin+tid mit anderer Menge bleibt Konflikt |
| HL: BTC vs dex:BTC vs @index, gleiche tid/time | getrennte native Marktscopes; kein canonical-symbol-Alias |
| Bybit: gleicher execId/scope mit geänderter Providerzeit | Konflikt, keine zweite Execution durch Zeitkey |
| Gleiches Providerkey mit anderer Order-ID, Fee oder Menge | Original unverändert und sticky Konflikt |
| Zwei unterschiedliche echte IDs, identische Zeit/Preis/Menge | zwei Fills; EconomicHash ist keine Dedupe-ID |
| Fehlender Markt/Fingerprint/HL-Originalzeit | unresolved Original; keine aktuelle Zeit/Marktannahme |
| Legacy-Fill ohne bewiesenen Key plus möglicherweise entsprechender neuer Readback | keine Doppelbuchung, erst gezielte Legacyauflösung |
| Kraken recent fill_id vs Historyexecution.uid ohne Aliasurkunde | keine heuristische Zusammenführung und keine zweite Buchungsquelle |
| Money: alter Event mit exakt derselben echten fill_id/kind | vorhandene ID/JSON/Valuation unverändert wiederverwendet |
| Money: zwei alte Kandidaten oder geänderte Ableitung/Asset/Zeit | expliziter Konflikt statt erster Treffer |
| Migrationsabbruch/Restart, bestehende Conflicts/Valuations/Accountingpending | alle Originale/Referenzen/Trigger erhalten, FKcheck leer |
| Vorbestehende bloße Namespacecollision | keine pauschale Konfliktlöschung oder Baselinefreigabe |
| Identitybindung erfolgreich, Bybit Option-/Preupgradefinalität fehlt | `fillCoverageReason` unverändert blockierend |

## Befehle und Abschlussgates

Arbeitsverzeichnis `C:/Users/nikla/Desktop/tsx-core`; keine Installation/Downloads.
PowerShell-Variablen nur für diese Aufgabe:

```powershell
$identityNode = 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe'
$identityPython = 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe'
$identityRuff = 'C:/Users/nikla/AppData/Local/Temp/tsx-core-ccxt-py312/Scripts/ruff.exe'
& $identityNode --import tsx tests/test_exchange_order_correlation.js
& $identityNode --import tsx tests/test_trading_evidence_repository.js
& $identityNode --import tsx tests/test_trading_money_ledger.js
& $identityNode --import tsx tests/test_trading_fill_accounting.js
& $identityNode --import tsx tests/test_trading_recovery.js
& $identityNode --import tsx tests/test_trading_account_scope.js
& $identityNode --import tsx tests/test_trading_order_identity_bindings.js
& $identityNode --import tsx tests/test_trading_fill_identity.js
& $identityPython -B -m unittest discover -s exchange_executor/tests -p test_provider_order_identity.py
& $identityPython -B -m unittest discover -s exchange_executor/tests -p test_contracts.py
& $identityPython -B -m unittest discover -s exchange_executor/tests -p test_history_reader.py
& $identityPython -B -m unittest discover -s exchange_executor/tests -p test_kraken_history.py
& $identityNode node_modules/typescript/bin/tsc --noEmit
& $identityNode scripts/check_architecture.js
& $identityNode scripts/check_complexity_budget.js
& $identityRuff check exchange_executor
```

Je Befehl Exit 0 / alle Fälle grün; nach Fehler nicht blind den nächsten Schritt
als erfolgreich werten. Neue Dateien sind **Vorschläge und existieren noch nicht**.
Root registriert spätere neue Tests im vorhandenen Gesamtrunner und ergänzt neue
Produktionsmodule im Sonar-Scope. Kein Lockern von Architektur-/Komplexitätsgates;
`db.ts` darf weiterhin keine internen Projektimporte bekommen.

Bereits bei dieser Recherche wirklich ausgeführt und grün: die drei vorhandenen
Node-Dateien `test_exchange_order_correlation`, `test_trading_evidence_repository`,
`test_trading_money_ledger`, plus die oben beschriebenen beiden rein lokalen
Gegenproben. **Kein vollständiger Gesamtlauf und keine Providerabnahme behauptet.**

## Scope, STOP und Done

Nach Freigabe mögliche engste Dateien: neue Identity-Vertrags-/Belegmodule,
`order_identity.py`, `history_reader.py`, `_normalized_fill`/Ordernormalisierung und
geschützte Requestverdrahtung in `ccxt_adapter.py`, `trading_types.ts`,
`exchange_contract_validation.ts`, `exchange_order_correlation.ts`,
`trading_order_repository.ts`, `trading_evidence_repository.ts`,
`trading_fill_accounting.ts`, `trading_money_ledger.ts`, die abgestimmte neue
Migration in `db.ts`, entsprechende Tests. `trading_recovery.ts`,
`trading_engine.ts`, `ccxt_exchange.ts`, Baseline- und Scopeconsumer ausschließlich
nach Absprache mit den aktuellen Besitzern. Root besitzt aktuell No-Send-/Journal-
Integration, der Quality-Agent `positionProtected`; dort nicht parallel ändern.

STOP und konkreten Befund melden bei:

- erforderlicher Alias-/Parent-/Kontobindung, die nicht in Originalen belegt ist;
- benötigtem Strategiewechsel von unabhängigem Batch zu Attached/positionweitem Stop;
- nicht dokumentierter HL-children-Semantik oder unbewiesenem Kraken-Cross-Source-Alias;
- Tabellen-/FK-/Triggerdrift, nicht beweisbaren Migrationsduplikaten, Verlust einer
  lokalen Fill-/Money-ID oder notwendiger Änderung eines Original-Geldpayloads;
- zusätzlichem nicht abgestimmtem Providerread/Budgettopf oder Lockerung eines Gates;
- zweimal fehlschlagendem fokussiertem Gate bzw. erforderlichen fremden Dateihunks.

Done dieses **Folgepakets**, erst nach späterer Implementierung:

- [ ] Kleine positive Kraken-Tag-/HL-Lookup-Pfade und Bybit-Parentconsumer samt Negativmatrix grün.
- [ ] Keine neue Remote-ID oder Parentkante aus Arrayindex/Parametern erzeugt.
- [ ] Schema-, Restart-, Moneyreplay- und Namespacefälle maschinenprüfbar grün.
- [ ] Jede Ausführung behält ihre Original-ID; abgeleitete Keys werden separat geführt.
- [ ] Alte Originale, Konflikte und ihre Referenzen sind unverändert erhalten.
- [ ] Extra-Reads gemeinsam ≤5, absolute Deadline/Reserve und Restartfortsetzung geprüft.
- [ ] Keine accountweite Coverage-/Finalitätsbehauptung durch Identitätserfolg.
- [ ] Root hat Runner/Sonar/Index nach Integration aktualisiert.

Dieses Paket würde zwei konkrete ursprüngliche Pflichten aus 001/002 schließen.
Es macht weder unbewiesene Bybit-Historienfinalität noch fehlende echte Provider-
Abnahme oder alle übrigen Startup-/Recovery-Crashpflichten automatisch DONE.
