# 002 — Bybit UTA-/Options-/Pre-upgrade-Historie: Quellen- und Schnittstellenentscheidung

Stand 2026-09-02, untersuchter HEAD `f808927`; der gemeinsame Worktree enthält die laufenden Änderungen aus 001–008. Auftrag: begrenzte Recherche und Implementierungsübergabe, **kein Produktionscode und keine Guardänderung**. P1, Risiko hoch. Der Improve-Skill wurde ausschließlich lesend verwendet; dieses Dokument ist kein Provider-Abnahmenachweis.

Koordination nach Abschluss der Recherche: Root hat dem 005-Agenten den gemeinsamen Producer, dessen Money-Projektion und **Migration 38** freigegeben. Vorgesehene Module: `exchange_executor/account_log_reader.py` und `src/trading_account_log_contract.ts`, öffentliche Typen `AccountLogCheckpoint`/`AccountLogPageReceipt`/Record. Dessen verbindliche Typdatei ist vor einem 002-Consumerauftrag zu lesen; untenstehende Skizze ist kein konkurrierender Schemaauftrag. Dieser Agent ändert weder Producer noch db38. Finale Mode-/Finalitätsfelder gehören gegebenenfalls in den gesonderten 002-Consumerbeleg.

## Ergebnis und konkrete Entscheidung

Ein ungefilterter UTA-Transaktionslog-Reader ist lokal implementierbar und fachlich sinnvoll: Er liefert eine von aktuellen Instrumentlisten unabhängige zusätzliche Ereignisquelle für alle dokumentierten UTA-Produktkategorien. Er kann den heutigen BTC-only-Optionsprobe ersetzen und zugleich den Funding-Consumer bedienen. **Er liefert aus dem dokumentierten Vertrag aber keinen garantierten vollständigen Ereignishorizont bis zur aktuellen Acquisition.** Dies sind zwei unterschiedliche Aussagen.

Empfehlung: gemeinsamer, persistenter Rohseiten-Producer mit getrennten Projektionen für Funding und historische Scope-/Korrelationsbelege; daneben die vorhandenen echten Execution-Fills. Drei Nachweise getrennt führen: (1) angefragter Kontobereich und Modus, (2) tatsächlich traversierte Seiten/Intervalle, (3) Finalität/Vollständigkeit bis zu einem Zeitpunkt. Der heutige pauschale Bybit-Blocker darf erst nach genehmigtem Nachweis für alle drei Teile entfallen. Ein neues Feld oder Profil darf die dritte Aussage nicht aus den ersten beiden ableiten.

Das ist keine Empfehlung, frische UTA-Konten pauschal mit sämtlicher Classic-Historie zu belasten: Ein belegter, nach beobachtetem UTA2-Modus entstandener Konto-Baselinebereich kann den benötigten Pre-upgrade-Scope tatsächlich ausschließen. Positive Auflösung bekannter eigener Orders ist ebenfalls möglich. Die verbleibende accountweite Echtzeit-Finalität darf dabei nicht unsichtbar werden.

## Gelesener Iststand und reproduzierbarer Befund

- `exchange_executor/history_pagination.py:95`: accountweiter Linear-Execution-Scan; sieben Tage; roher Envelope; Cursor; anschließend inverse/spot/option mit `limit=1`. Der option-Aufruf hat kein `baseCoin`. Budgetabbruch innerhalb dieser drei Hilfsprobes verwirft deren Zwischenfortschritt; ein neuer zusammengesetzter Reader braucht persistente Phasen statt immer neuer Probes vom Anfang.
- `exchange_executor/history_coverage.py:41` sowie `src/exchange_history_coverage.ts:51`: Bybit bleibt absichtlich `option_history_scope_unproved`/`FILL_OPTION_SCOPE_UNPROVED`. Die bestehende `bybit_v5_linear_endpoint_v1`-Coverage ist kein Konto-Profil.
- `src/exchange_history_coverage.ts:60`: aktuelle Freigabe verlangt `coverage.through >= evidence.startedAt`, tatsächliche neue Seiten und keine Zukunftsgrenze. Ein einfacher Horizont `now - L` würde daher **auch mit einem echten Latenzlimit** bei jedem neuen Abruf wieder als nicht frisch scheitern. Prüfzeit und abgedeckte Ereigniszeit müssten explizit getrennte Verträge werden; nicht die vorhandene Prüfung still lockern.
- `exchange_executor/accounting_evidence.py:54`: bereits **ungefiltertes** `accountType=UNIFIED`, nicht `category=linear,type=SETTLEMENT`. Es bleiben jedoch nur Funding-Projektionen übrig; Scopezeilen werden nicht als gemeinsame Rohbelege übergeben. `read_funding_evidence` hat einen eigenen Budgetkontext und keinen persistenten Cursorinput. Mit dem zuständigen 005-Agenten abgeglichen; zwei konkurrierende Producer/Budgetpfade vermeiden.
- `src/trading_types.ts:709`, `src/db.ts` (Migration 29/History-Tabelle): Checkpointquelle ist nur `orders|fills`. Remote-Evidenz erlaubt nur `order|fill`. Transaktionsbuchungen sind kein legitimer künstlicher Fill und sollen nicht unter falschem `fetchMyTrades`-Label eingeschleust werden. Ein eigener Ledger-DTO/Persistenzbereich ist eine **explizite** Schnittstellen-/Migrationsentscheidung.
- `src/trading_account_baseline.ts:25,106`, `src/trading_history_repository.ts:32`: Baseline ist eine belegte lokale Grenze, nicht Provider-Kontogeburt. Ältere eigene Verpflichtungen ziehen den Bereich wieder zurück. Legacy- und Baseline-Reset dürfen keinen neuen Scope-/Mode-/Finalitätsbeweis erben.
- `exchange_executor/ccxt_client.py:35` und `ccxt_profiles.py`: Bybit bleibt aktuell `credential_binding` an den API-Key. Eine zusätzlich gelesene UID darf diesen Bestand nicht automatisch umschreiben. UID-gleicher Keywechsel braucht weiter die separat genehmigte Identitätsmigration; vollständige History allein löst das nicht.

Gelesen: Plan 002 vollständig, relevante aktuelle Status-/Retentionnotizen, ADR 0012, Python-/Node-Historyverträge und Tests, Account-Baseline/Current-State, Accounting-Reader, Runtime-Pin und CI-/Paketbefehle. Keine anwendbare zusätzliche AGENTS-Datei im untersuchten Repo gefunden.

### Gepinntes CCXT 4.5.75

Direkt gelesen: `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/async_support/bybit.py` und `ccxt/abstract/bybit.py`. Der Pin ist zusätzlich in `exchange_executor/requirements.in` und ADR 0012 festgelegt. Ein rein lokaler Python-3.12-Lauf mit ersetzter `request`-Methode bestätigte genau diese privaten GET-Routen, jeweils ohne versteckte Zusatzrequests:

| Methode | Raw-Route |
|---|---|
| `privateGetV5AccountTransactionLog` | `v5/account/transaction-log` |
| `privateGetV5PreUpgradeAccountTransactionLog` | `v5/pre-upgrade/account/transaction-log` |
| `privateGetV5PreUpgradeExecutionList` | `v5/pre-upgrade/execution/list` |
| `privateGetV5AccountInfo` | `v5/account/info` |
| `privateGetV5UserQueryApi` | `v5/user/query-api` |

Der Fake setzte `list=[]` mit nichtleerem `nextPageCursor`: Raw-Methoden erhalten ihn, `add_pagination_cursor_to_result` gibt nur `[]` zurück. `fetch_my_trades` setzt außerdem standardmäßig `execType=Trade`; `fetch_ledger` normalisiert und filtert nachgelagert. Daher keine Collection-/Autopagination-Helper für Coverage.

Ein künstlicher Options-Log mit `id=ledger-id`, `tradeId=execution-link`, `qty=0.5`, `size=0`, `transactionTime` und `tradePrice` ergab über `parse_trade`: ID `ledger-id`, Timestamp `None`, Amount `0`, Price `None`. Der Log ist **nicht** das Execution-Schema. `parse_ledger_entry_type` fasst unter anderem TRADE/SETTLEMENT/DELIVERY zu `trade` zusammen; diese Normalisierung verliert gerade die benötigte Abgrenzung. `safe_market` kann bekannte abgelaufene Optionsnamen synthetisch normalisieren; das ist weder Scope-Discovery noch ein belastbarer historischer Instrumentbeleg. Originalsymbol erhalten, unsupported Produkte nicht durch einen Linear-Parser buchen.

`is_unified_enabled` darf kein Modusbeweis sein: Es kann zwei zusätzliche Calls auslösen, cached Werte verwenden, im Demo-Modus UTA annehmen und bei fehlendem Status auf 6 defaulten. Verwendbar sind nur validierte rohe Antworten. Die fünf Raw-Calls und Parserprobe liefen ausschließlich gegen den lokalen Fake; es wurde kein Exchange-Host angesprochen.

## Primärquellen und ihre engen Aussagen

1. **UTA-Log:** zwei Jahre, optionaler Kategorie-/Basis-/Währungs-/Typfilter; alle dokumentierten Kategorien einschließlich option/event; feste Anfragefenster höchstens sieben Tage, bis 50 Zeilen und expliziter Folgecursor. Kein BTC-Default ist hier dokumentiert. Pro Zeile stehen Buchungsidentität und optionale Trade-/Orderkorrelation bereit. Die Seite warnt ausdrücklich vor verzögerter Datenlieferung, nennt aber weder maximales Lag noch einen Processed-Watermark. [Bybit UTA Transaction Log](https://bybit-exchange.github.io/docs/v5/account/transaction-log)
2. **Executions:** Kategorie ist Pflicht; option ohne Basis defaultet BTC. Order-ID und Client-Order-ID haben vor Symbol/Basis Priorität. Bis 100 Zeilen, sieben Tage, Cursor; identische Ausführungszeiten sind nicht zuverlässig sortiert. Der native Execution-Identifier ist `execId`, nicht die Ledger-ID. [Bybit Trade History](https://bybit-exchange.github.io/docs/v5/order/execution)
3. **Modus:** `account/info` beschreibt aktuellen Account-/Marginmodus; `updatedTime` ist eine Datenänderungszeit, keine zugesagte Kontogeburts-/Upgradegrenze. [Account Info](https://bybit-exchange.github.io/docs/v5/account/account-info) Die Modusübersicht unterscheidet 3/4 (UTA1) und 5/6 (UTA2); bei UTA1 liegt inverse außerhalb des Unified-Wallets, bei UTA2 darin. Inverse Pre-upgrade-Transaktionen liegen separat. Für ab 2025 registrierte Konten erklärt Bybit die alte Upgrade-Anleitung für entbehrlich; daraus folgt **kein** API-Key-Geburtsbeweis. [Account Modes](https://bybit-exchange.github.io/docs/v5/acct-mode)
4. **Identität:** `query-api` ist mit jedem API-Permission-Set erreichbar und liefert `userID`, `isMaster`, `parentUid`, `uta` sowie Keydaten. `createdAt` gehört zum **Key**. Die Liste der Keyberechtigungen beweist nicht, dass kein zweiter Schlüssel/Benutzer andere Produkte handeln kann. `apiKey`, `secret`, IPs und sonstige nicht benötigte Accountdaten nicht persistieren. [API Key Information](https://bybit-exchange.github.io/docs/v5/user/apikey-info)
5. **Pre-upgrade-Log:** Classic-USDC-Derivate, nur linear und option, Kategorie Pflicht, Basis optional; sechs Monate für USDC/Option. Der Responsevertrag hat **kein `id`**; die dokumentierte Delivery-Antwort hat leere Trade-/Order-IDs. Keine eindeutige Buchungs-ID erfinden. [Pre-upgrade Transaction Log](https://bybit-exchange.github.io/docs/v5/pre-upgrade/transaction-log)
6. **Pre-upgrade-Executions:** getrennte Kategorien; inverse umfasst Classic/UTA1, USDC/Option sechs Monate. Für USDT/inverse hier kein neues unbelegtes Zwei-Jahre-Versprechen erfinden. Die Seite kündigt spot für Ende August 2026 ab; am Recherchetag September 2026 ist eine neue Abnahme dieser Route zwingend, nicht ein stiller Success/empty-Fallback. Der Options-Basisparameter hat dort keinen dokumentierten BTC-Default; das ist kein Beleg, dass der aktuelle Execution-Endpunkt denselben Scope hat. [Pre-upgrade Trade History](https://bybit-exchange.github.io/docs/v5/pre-upgrade/execution)
7. **Alternative Options-Discovery:** Orderhistorie unterstützt option mit optionalem Basisfilter und behaltene gefüllte Orders; sie hat jedoch ebenfalls explizite Verzögerung. Ungefüllte terminale Orders haben kürzere Retention. Die Liste ist eine weitere positive Orderquelle, keine zeitlich lückenlose Account-Execution-Sequenz. [Order History](https://bybit-exchange.github.io/docs/v5/order/order-list) Die aktuelle Orders-Route liefert Optionen accountweit ohne Basis, aber der Closed-Bestand ist auf 500 begrenzt und kann bei Serverneustart verschwinden. [Open & Closed Orders](https://bybit-exchange.github.io/docs/v5/order/open-order)
8. **Kein Instrumentlisten-Ersatz:** Der Instrument-Endpunkt beschreibt Online-Märkte; Optionsdefaults enthalten PreLaunch/Trading/Delivering und BTC. Selbst vollständige aktuelle Pagination sagt nichts über verschwundene historische Basiswerte. [Instruments](https://bybit-exchange.github.io/docs/v5/market/instrument)
9. **Ledgersemantik:** TRADE, SETTLEMENT, DELIVERY, LIQUIDATION und ADL sind verschiedene Typen; DELIVERY umfasst auch Event-Settlement. Neue unbekannte Typen nicht als Transfers oder Nullwerte freigeben. [UTA Log Enums](https://bybit-exchange.github.io/docs/v5/enum#typeuta-translog) Die alte Contract-Log-Route liegt unter Abandoned und hat gegenüber UTA eine andere Funding-Vorzeichenbedeutung; kein gemeinsamer ungeprüfter Parser. [Classic/UTA1 Contract Log](https://bybit-exchange.github.io/docs/v5/abandon/contract-transaction-log)
10. **Weitere Scopegrenzen:** Die Event-OpenAPI ist laut Introduction nur Market Makern zugänglich; fehlende API-Berechtigung beweist keine fehlende Benutzeraktivität. [Event Access](https://bybit-exchange.github.io/docs/v5/event/introduction) Während eines Account-Upgrades können REST-/WS-Daten ungenau sein. Status-/Modusdrift verwirft einen laufenden Beweis statt ihn über die Umstellung hinweg fortzusetzen. [Upgrade Guidance](https://bybit-exchange.github.io/docs/v5/account/upgrade-unified-account)

Die Schlussfolgerungen zu fehlender Finalität sind unsere Ableitung aus den genannten Responsefeldern und Warnungen, keine behauptete zusätzliche Bybit-Garantie. Es gibt in den geprüften Quellen weder ein dokumentiertes all-base-Execution-Wildcard noch eine Zusage, dass `time`, `updatedTime`, ein Cursor oder eine zuletzt sichtbare Buchung alle früheren Ereignisse abschließen.

## Vorschlag: gemeinsamer Rohseitenvertrag für 002/005

### Scope und Budget

- Namespace `bybit_uta_transaction_log_scope_v1`. Request exakt `accountType=UNIFIED`, `startTime`, `endTime`, `limit=50`, optional der gespeicherte Cursor. **Kein** Kategorie-, Basis-, Währungs-, Typ- oder Subtypfilter. Filterhash über die gesamte kanonische Anfrage ohne Cursor, plus Endpoint/Umgebung/Version; ein Funding-Subset darf nie diesen Scope behaupten.
- Eigenständige Profile für Pre-upgrade-Log und Execution. Der ursprüngliche Linear-Fill-Checkpoint bleibt getrennt. Nicht den bestehenden Profilstring umdeuten oder die `source`-/`kind`-CHECKs pauschal lockern. Gemeinsame Ledger-Tabelle/DTO ist inzwischen 005 zugewiesen (db38); vor einem Consumerhunk dessen verbindlichen Vertrag lesen, keine alte Migration nachträglich verändern.
- Genau **ein** `RecoveryReadBudget` pro zusammengesetzter Historien-/Recovery-Acquisition. Jeder Identity-/Mode-/Log-/Pre-upgrade-/Order-/Execution-/Replay-HTTP-Call zählt einmal; vorhandene CCXT-Limiter bleiben aktiv. Current-State-Budget nicht zum Umdeklarieren zusätzlicher Historienreads benutzen. Fundingprojektion aus bereits gelesenen Rohseiten kostet keinen weiteren Call. Bei separatem Accounting-HTTP-Vertrag seine Grenze ausdrücklich ausweisen, nicht zwei Kontingente innerhalb derselben Acquisition verstecken.
- Frische Positionen/aktive Orders und konkrete unsichere lokale Orders bleiben vor altem Backfill. Anschließend round-robin über persistierte Arbeitsphasen; eine Phase führt höchstens einen zusätzlichen HTTP-Read aus und gibt ihren Fortschritt zurück. Bootstrap kann fünf Reads brauchen (UID, Mode, Linear-Execution, UTA-Log, optionaler Mode-Readback); benötigte Folge-/Pre-upgrade-Seiten gehen im nächsten Request weiter. Nicht den Bootstrap blind vor jeder Seite wiederholen; Identitätsbeobachtung separat revisions-/credentialgebunden speichern, Readback erneut vor positiver Beweisverwendung.
- Vor jedem Aufruf bestehende absolute Deadline prüfen: keine Erstellung unawaitbarer Coroutines, kein Call bei höchstens 1.250 ms Rest, maximal 10 s SDK-Wartezeit und mindestens 1 s Antwortreserve. Kein eigener versteckter Retry oder CCXT-Autopagination. 429/Retry-After und transiente Fehler lassen den letzten bestätigten Cursor stehen.

### Begrenzter Checkpoint, explizit noch kein fertiges TS-API

Die anfängliche Forschungs-Skizze umfasst folgenden Zustand; der inzwischen zugewiesene gemeinsame `AccountLogCheckpoint` trägt den generischen Traversierungsteil, der 002-Consumer ergänzt gegebenenfalls Mode-/Finalitätsbelege. JSON weiterhin strikt unter 8.192 Bytes, nicht vollständige Seiten/ID-Sets darin speichern:

```text
version: 1
namespace, endpointFamily, environment, requestScopeHash
accountFingerprint, credentialGeneration, providerAccountUid, modeProofHash
revision, baselineSince, windowSince, windowUntil
phase: scan | replay | observed
cursor: string | null                # opaque, begrenzt; kein Zeit-/ID-Ersatz
traversedThrough: integer | null     # nur bestätigte lückenlose Traversierung
lastReadStartedAt, lastReadCompletedAt, providerResponseAt
lastPageReceiptId, pageChainSha256
finalizedThrough: null              # im hier belegten Vertrag NICHT ableitbar
finalityReason: provider_latency_unbounded
nextReadAt
```

Pre-upgrade-Profile binden zusätzlich die feste Kategorie. UTA-Scopes sind nicht von einer Liste gerade bekannter Symbole/Basiswerte abhängig. Seite, Scope-Hash und Modusbeweis müssen zur exakt angefragten Revision passen. `pages=0` darf keine Cursor-/Fenster-/Mode-/UID-/Coveragefortschreibung erlauben. Kein `max(timestamp)` als Cursor, keine `len < limit`-EOF-Annahme, auch leere Seiten mit Cursor fortsetzen. Cursorzyklen nicht nur innerhalb eines HTTP-Requests erkennen: bestätigte PageReceipts/Cursoreingänge im Fenster dauerhaft erfassen. Ungültiger/abgelaufener Cursor kann das **gleiche** Fenster mit Dedupe neu starten, nie ungeprüft zur nächsten Zeit springen.

Ein Fenster bleibt beim Restart identisch, höchstens sieben Tage, inklusive definierter Grenzüberlappung. EOF bedeutet nur den expliziten leeren Folgecursor nach erfolgreicher Envelopeprüfung. `traversedThrough` darf nach atomarer Seitenaufnahme bis zum Fensterende wachsen; `finalizedThrough` nicht. Ein Replay desselben Fensters kann verspätete Belege finden und die Prüfzeit aktualisieren. Zwei gleiche Replays erzeugen keinen Finalitätsbeweis.

### Dauerhafte Rohbelege und Consumer

PageReceipt: Konto-/Credential-/Modus-/Filterbindung, Anfragefenster, Eingangs- und Folgecursor, Empfangsintervall, Provider-Antwortzeit, Zahl der Originalzeilen und Hash über erlaubte kanonische Roh-Economics. Providerzeit auf Integer/Skew plausibilisieren; sie ist kein Processed-Watermark. Malformed Envelope, fehlende Liste/Cursor oder Out-of-window-Ereignis wird nicht als leer behandelt.

LedgerEvent: eigene Quellenfamilie; echte Buchungs-ID oder ausdrücklich fehlende ID; Originalkategorie/Symbol/Typ/Subtyp, Transaktionszeit, originale Dezimalstrings für Menge/Preis/Geldkomponenten, Währung, Trade-/Order-/Clientkorrelation und kanonischer EconomicPayloadHash. Keine Header, Secrets, vollständigen Query-API-Antworten oder SDK-Objekte speichern. Unbekannte Pflichtsemantik in Quarantäne; das Rohereignis bleibt sichtbar.

Persistenz in **einer** DB-Transaktion: erlaubte Rohbelege und Konflikte → PageReceipt → beide Consumerfortschritte beziehungsweise deren Pending-Referenzen → optimistisches Cursor-Update. Crash davor wiederholt dieselbe Seite, Crash danach übernimmt sie idempotent; kein Cursor vor dauerhaftem Beleg. Separate Tabellen/DTOs sind sauberer als fremde Buchungsarten in `trading_remote_evidence.kind='fill'` umzubenennen. Bestehende immutable Accounting-/Fill-Belege bleiben erhalten.

002-Consumer: Scopebeobachtung plus unerwartete nichtlineare Aktivität; neue Ledgerereignisse niemals automatisch in eigene Fills umwandeln. 005-Consumer: ausschließlich verifizierte Geldkomponenten, eigene Bewertungs-/Zurechnungsregeln. Eine bereits geschlossene Fundingprojektion wird durch eine später eintreffende abweichende Buchung nicht still überschrieben; Konflikt/Invalidierung nach 005-Vertrag. Die jeweiligen benötigten Zeitbereiche bleiben getrennt, obwohl identische physische Seiten geteilt werden können.

Abstimmung mit 005: bereits gebuchte identische Legacy-Fundingbelege behalten ihre ökonomische Ereignisidentität/Quellenzuordnung. Der neue Producer-Namespace darf keine zweite Geldbuchung desselben Ereignisses erzeugen. Receipt speichert jede tatsächliche Vorkommensposition; eine reine Payloadhash-Deduplizierung ersetzt keine Provider-ID.

## Identitäten, Mengen und Deduplizierung

- UID authentifiziert aus `query-api`, positive ganzzahlige Rohwerte verlustfrei in kanonischen Text überführen, bevor sie Node passieren. `parentUid` ist Kontext, nicht Ersatz für die tatsächliche Subaccount-UID. Umgebung, bestehender Fingerprint und Credentialgeneration bleiben Teil jeder Bindung. Fehlender/abweichender UID-Beleg ist kein Empty-Success.
- UTA-Buchungs-ID: eindeutiger Namespace aus Konto/Umgebung/Quellenfamilie plus Original-`id`. Gleiche ID und gleiche unveränderliche Economics sind Replay; gleiche ID mit anderen Economics ist Konflikt, kein `INSERT OR IGNORE`. Das offizielle Beispiel wiederholt sogar eine `id` bei verschiedenen Zeilen: diesen Beispieldatensatz nicht als Dedupe-Freigabe verwenden.
- Execution: eigenes Namespace mit Kategorie/Originalsymbol und tatsächlicher `execId`. Nicht nach Zeit+Menge deduplizieren; mehrere echte Fills derselben Millisekunde bleiben getrennt. Ledger-`tradeId` ist nur eine Korrelationsreferenz. Die geprüften Seiten garantieren nicht pauschal dessen Identität mit `execId`; ein Cross-source-Merge braucht einen eigenen geprüften Korrelationsvertrag und übereinstimmende Economics. Keinen Trade zweimal als Ausführung buchen.
- Pre-upgrade ohne stabile ID: Payloadhash ist Wiedererkennung, kein Beweis, dass zwei identische echte Ereignisse eines sind. Page-/Row-Provenienz und Ambiguität erhalten; positive Ausführungen, soweit vorhanden, über echte Execution-IDs korrelieren. ID-lose Delivery/Funding nicht in sichere eindeutige Fills verwandeln.
- Spot-Währungsbeine, Options-/Event-Delivery, Funding/Session-PnL, Liquidation/ADL, Moves und Transfers bleiben verschiedene Ereignisse. Ein symbol-/tradeId-haltiger SETTLEMENT-Datensatz ist deshalb noch kein Fill. Bekannte harmlose Ein-/Auszahlung darf nicht wie unbekannte Optionsaktivität blockieren, braucht aber eine explizite enge Typklassifikation. Unbekannter Typ/Kategorie wird niemals als harmlose Null klassifiziert.

## Pre-upgrade, Legacy und ein tatsächlich nützlicher Fresh-UTA-Pfad

1. **Neue saubere Aufnahme:** aktuelle Bindung und rohe UTA2-Statusbeobachtung (5/6) vor der späteren Baselinegrenze dauerhaft festhalten. Existierende Baselinebedingungen beibehalten: getrennte vollständige aktuelle Scopes, zwei nicht überlappende Beobachtungen, terminaler flacher lokaler Ledger, keine unresolved Operations. UTA2-Bindung in beiden Beobachtungen prüfen; beobachtete Umstellung bricht den Kandidaten ab. Keine Trading-/Account-Upgrade-Mutation auslösen.
2. **Benötigter Beginn ist nach diesem Beleg:** als explizite Scopeableitung ist Pre-upgrade für dieses benötigte Intervall ausgeschlossen, nicht für die gesamte Lebenszeit des Kontos. Eine frühere alte Order/Restorepflicht macht diese Ableitung wieder ungültig. Bestandsbaselines ohne Modebeleg werden nicht nachträglich mit einem heutigen `updatedTime` versehen. Der erste Eintritt kann bei flachem Legacykonto durch einen neuen, separat genehmigten Baselinebeweis erfolgen, niemals durch schlichtes Setzen von `since=now`.
3. **Nutzbarer Rohscan:** moderne UTA2 benötigt ab dann keine Classic-Scans pro Request. Linear-Execution und all-category-Log werden fortgesetzt; reine Transfers/Funding sind nicht automatisch manuelle Trades. Bekannte nichtlineare Ereignisse werden sichtbar und separat klassifiziert. Kein aktuelles BTC/ETH/SOL-Verzeichnis ist nötig. Diese Strecke ist lokal implementierbar und beseitigt Scope-/Restart-/Belegverlust, auch wenn der Finalitätsstatus offen bleibt.
4. **Bekannte eigene Orders positiv auflösen:** gezielte rohe Execution-Abfrage nach echter Order-ID, insbesondere auch Nicht-BTC-Symbole, unter demselben Budget. Nach EOF die verschiedenen Execution-IDs und Mengen mit der tatsächlich terminalen eigenen Order/kumulativen Ausführung abgleichen. Das kann konkrete eigene Verpflichtungen vervollständigen; es ist kein Negativbeweis für alle unbekannten fremden Orders. Options-Orderhistorie und Ledger dürfen weitere **Kandidaten** liefern; deren Discovery bleibt wegen Retention/Verzögerung keine vollständige Universe-Liste.
5. **Alte/unklare Herkunft:** UTA1 verlangt getrennten inverse-Scope, Classic eigene Produktquellen; für Bereiche über eine unbelegte Upgradegrenze passende Pre-upgrade-Endpunkte hinzunehmen. Ausgelaufene sechs Monate, abgekündigtes spot, unbekannte USD(T)/inverse-Retention oder fehlende stabile Ereignisidentität bleiben NOT_PROVEN. Eventzugang und heutiger Current-State-Scope sind gesondert zu behandeln: der vorhandene Current-State-Reader umfasst kein `event`; ein Ledger-Nullresultat darf diese Lücke nicht rückwirkend als aktuelle Scopefreigabe ausgeben.

**Liveness-Grenze ausdrücklich:** Die Schritte 1–4 ermöglichen echten Fortschritt und gezielte Recovery für ein frisch belegtes UTA2-Konto, ohne endlose Pre-upgrade-Probes. Sie beweisen anhand der heute geprüften Quellen **nicht** die aktuell geforderte vollständige accountweite Fillgrenze bis zu jeder neuen Acquisition. Ein frischer leerer Log kann verspätete Buchungen noch nicht enthalten. Identische Folgescans, neuester sichtbarer Eintrag, aktuelle Nullpositionen, Account-/Keyalter und willkürlich gewählte 30 s/24 h/7 d Wartezeit schließen diese Lücke nicht.

Für eine automatische vollständige Freigabe bleibt eine konkrete Architektur-/Providerentscheidung nötig: entweder ein zusätzlich belegter accountweiter Abschluss-/Sequenz-/Latenzvertrag, oder ein **anders benannter und separat genehmigter** Safetyvertrag für einen festen abgeschlossenen Verpflichtungshorizont. Der zweite Weg darf keine vollständige Konto-Fillhistorie behaupten und ist keine kleine Profiländerung in `fillCoverageReason`. Unter unverändertem aktuellen Vertrag ist eine garantierte Fresh-UTA-Freigabe aus diesen öffentlichen APIs allein derzeit nicht belegbar. Das ist keine behauptete universelle Unmöglichkeit jeder künftigen Bybit-Lösung.

## Implementierungsreihenfolge und Abnahmetests für den Folgeauftrag

Kein zusätzlicher Codeauftrag durch dieses Dokument. Producer/005/db38 sind separat freigegeben; für den 002-Consumer vor Beginn Root-Freigabe und endgültige DTOs abgleichen, insbesondere die Bedeutung des neuen Coverage-Status. Danach:

1. Lokale Raw-CCXT-Contractfixtures für die fünf oben geprüften Routen, erlaubte Felder, leere Zwischen-/Endseiten, Filterhash und Modus-/UIDbindung. Die beobachteten Helper-/Parserverluste explizit als Negativtests konservieren.
2. Bounded Producer und atomare PageReceipt-/Consumerpersistenz; Restart in jeder Phase, Budgetabbruch vor finalem Readback, >50/mehrere hundert Zeilen, leere Zwischenantwort, Cursorzyklus über Prozessrestart, 429 und Deadline mit gemeinsam höchstens fünf tatsächlich gezählten zusätzlichen Reads. Lokale Verarbeitung zweier Consumer zählt nicht doppelt; physischer Zweitread zählt.
3. Neue/deprecated Kategorien und Semantik: historische Nicht-BTC-Option, USDT-Optionssuffix, aus heutiger Marktmap verschwundenes Symbol, Eventtrade/-settlement, Spot-Beine, Nullgebühr, Funding mit Session-PnL, LIQUIDATION/ADL, unbekannter Typ, gleiche Ledger-ID mit anderer Payload, ID-lose identische Mehrfachbuchungen. Keine eigene Ownership/Menge aus fremdem Ledgerereignis.
4. Fresh-UTA-Baselinebeleg gegen Legacy: Modebeweis fehlt/ist zu neu, UTA1/2-Wechsel, 5→6-Übergangsantwort, anderes Subkonto, Credentialrotation, früher wiedergefundene eigene Order, altes Originalfenster mit neuerem Datenbestand, sechs-Monats- und Zwei-Jahre-Rand. Nicht 730 Tage pauschal als jede Kalender-/Providergrenze behandeln; konservativer dokumentierter Rand mit Fehlerpfad.
5. Latenz-Fakes: Seite meldet heute EOF, später erscheint eine alte Buchung; zweimal gleiche EOFs; neuere sichtbare Zeile bei noch fehlender älterer Zeile; Reportzeit frisch aber `finalizedThrough=null`. **Niemals vollständige Konto-Coverage.** Auch ein aus einer festen vergangenen Grenze frisch wieder gelesener Scan darf nicht als aktuelle Ereignisgrenze umetikettiert werden.
6. Positive Gegenfälle: nachweislich post-UTA2-baseline braucht keine unendlichen Pre-upgrade-Scans; Funding-/Transfer-only-Log kann als beobachteter Scope vorankommen; eigene terminale Order mit allen echten korrelierten Execution-IDs wird im engen Orderbeleg vervollständigt. Vollständige Konto-Freigabe bleibt ein separater Test, der bis zum autorisierten Quellen-/Consumervertrag bewusst negativ ist.

Betroffene spätere Produktionsmodule: die an 005 zugewiesenen `account_log_reader.py`/`trading_account_log_contract.ts` und Ledgerpersistenz; für 002 ausschließlich ein kleiner eigenständiger Scope-/Korrelationsconsumer sowie klar abgegrenzte History-/Account-Baseline-Integrationsstellen. Keine Guards, Zertifizierungsattestationen, ADR-REST-Autorität oder Identitätsbestände ohne gesonderte Freigabe ändern. Der heute gelesene `historyScope`-Schlüssel bleibt für vorhandene Orders/Fills unverändert; neuer Ledger hat seinen eigenen Schlüssel.

Lokale Gatebefehle für den Folgeauftrag (Repo-Root, exakte oben dokumentierte Runtimes, keine Netzfixtures):

```text
python -B -m unittest discover -s exchange_executor/tests -p "test_history*.py" -v
python -B -m unittest discover -s exchange_executor/tests -p "test_accounting*.py" -v
python -B -m unittest discover -s exchange_executor/tests -p "test_bybit_ledger*.py" -v
node --import tsx tests/test_exchange_history_coverage.js
node --import tsx tests/test_trading_history.js
node --import tsx tests/test_trading_account_baseline.js
node --import tsx tests/test_trading_safety_proof.js
node node_modules/typescript/bin/tsc --noEmit
node scripts/check_architecture.js
node scripts/check_complexity_budget.js
```

Neue Tests im gemeinsamen Runner und Quellen in nötigem Sonar-/Coverage-Scope registrieren; keine Limits/Baselines lockern. Gesamt-JS-/Pythonlauf gehört anschließend zu Root. Die neue Recherche selbst führte nur den oben beschriebenen rein lokalen CCXT-Fake aus, keine neue Produktionssuite und keine Providerabnahme.

STOP genau dort, wo ein Abschluss-/Latenz-/Identitätsbeweis erfunden, eine fremde Position übernommen, ein altes Baselinefenster unbelegt übersprungen oder ein inkompatibler Ledger als Fill gebucht werden müsste. Quellen-/Profiländerungen neu versionieren. Dieses Dokument schließt weder Plan 002 noch die offene Bybit-Livefreigabe ab.
