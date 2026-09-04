# 001/002 – Originalgebundene Order- und Fill-Identität

Stand: 2026-09-02. Lokales freigegebenes Implementierungspaket nach
`002-order-fill-identity-followup.md`; keine Provider-/Produktionsabnahme.
Produktionshunks dieses Pakets sind nach dem untenstehenden Nachlauf eingefroren.
Root integriert den Gesamtlauf nach Abschluss des parallelen Pakets 005/M41.

## Umgesetzt und positiv lokal belegt

- Neue Kraken-Batches erhalten explizite String-`order_tag` aus genau der eigenen
  `clientOrderId`, **vor** ursprünglichem Requesthash/Journaleintrag. Der identische
  read-only Helper wird auch bei der Originalplan-/No-Send-Prüfung verwendet.
  Vorbestehende taglose Journale bleiben bytegleich taglos. Ein beliebiges
  Zusatzfeld, SDK-Index oder späterer Tag ist kein Originalbeleg.
- Reale gepinnte CCXT-4.5.75-Signierung, ausschließlich mit abgefangenem `fetch`,
  bestätigt Stringtags im signierten Batchbody. Die Negativkontrolle bestätigt
  numerische SDK-Defaulttags. Umgekehrte Antwortreihenfolge ist erlaubt, doppelte,
  fremde oder widersprechende native Tags/IDs nicht. Auch ein passender unified
  Client überstimmt keinen widersprechenden explizit journalisierten Tag.
- Hyperliquid kann nach fehlender Create-Antwort die eigene ursprüngliche cloid
  mit exaktem Walletscope lesen. Echte OID/coin, unverfälschte Antwort mit
  `cloid=null`, Requestintervall und Kontofingerprint werden gebunden. Erst Node
  mit dem originalen möglicherweise versandten Journal darf die lokale
  Remote-ID-Zuordnung persistieren. Keine Arrayposition oder `children`-Heuristik.
- Neue native Bindungsurkunden halten Operation, Requesthash, historische
  Credentialgeneration, ursprüngliche Operationsgeneration/logischen Schlüssel,
  echtes Beleg-JSON und dessen Hash fest. Wiederholte Beobachtungen prüfen diese
  Originale erneut. Gleiche Accountrotation überschreibt historische Generationen
  nicht. Änderung/Verlust invalidiert den Protection-Sourcehash.
- Fill-Keys sind abgeleitete Metadaten, nicht Ersatz für Original-IDs. Sie binden
  Accountfingerprint, Providerprofil, Produktnamespace, nativen Markt und echte
  Fill-ID; Hyperliquid zusätzlich die tatsächliche Providerzeit. Bybit/Kraken
  verwenden Zeitänderungen als Widerspruch derselben ID, nicht als neue Buchung.
- Kraken v3 `execution.uid` ist die einzige neue kanonische Kraken-Fillquelle.
  Recent-`fill_id` bleibt als Originalbeobachtung sichtbar/unresolved und wird
  weder heuristisch umbenannt noch zusätzlich gebucht.
- Fill-Persistenz, Evidenzkeys, Accounting-Übergabe, Notifications und Money-Dedupe
  benutzen den tatsächlichen persistierten lokalen Fill. Fee/PnL-Geldformeln,
  Funding-Provider-Identität, Original-Event-ID/JSON und bestehende Valuations sind
  unverändert. Derselbe echte `fill_id + kind` verwendet den bisherigen Moneyevent;
  mehrere Kandidaten oder abweichende Originaleconomics bleiben Konflikt.
- Reconciliation-Digest v3 enthält namespace-sichere Fillidentität und echte
  Providersymbole. V2-Originale werden nicht umgeschrieben oder als V3 gleichgesetzt;
  das ist auch bei zufällig identischem Hashtext regressionsgetestet.
- Activity/Tradejournal führen Original-ID plus Namespacekey/Identitätsstatus.
  Accounting-Sourcebelege, Risiko-Sourcehash und Protection-Sourcehash führen die
  neuen Identitätsfelder ausdrücklich mit, ohne generisches fehlend→0.

## Migration40 und Altbestand

M40 (`native_fill_namespaces_and_original_order_bindings`) erhält sämtliche alten
Fill-/Moneyspalten, lokalen IDs, `raw_json`/`content_json`, Valuations, Konflikte,
Pending-Arbeit und FK-Referenzen. Neue Fillfelder sind `provider_symbol`,
`remote_fill_key`, `identity_status`, `identity_json`. Alte Zeilen beginnen als
`legacy_unresolved`, nicht mit erfundenem Namespace. Native Uniqueness ist
`account_id + remote_fill_key`; bei Money trennt der Index Fill- und Providerbasis.
Mehrdeutige alte Moneybuchungen führen zu einem präzisen Migrationsstopp, nicht zu
Löschung oder willkürlicher Zusammenführung. Die echten temporären SQLite-Rewinds
prüfen FK-Konsistenz, alle extern referenzierenden Trigger und den vollständigen
Rollback auf Version39. Der aktuelle positive Nachlauf migriert 39→40→41.

Ein fehlender M40-Bindingrow allein darf einen echten M39-Fill nicht dauerhaft
sperren. Der additive Backfill verwendet ausschließlich den alten nichtnull
Fill-Fingerprint, eigene exakte Order, ursprüngliches gehashtes Journal samt
Generation/logischem Schlüssel/Legset und echte ACK-/resolved-Snapshotbelege mit
Remote-ID und originalem Providersymbol. `resolved` ist historisch zulässig;
`prepared`, `abandoned`, mehrere mögliche Originale, veränderte Legs/ACKs oder bloß
heutige Credentials sind es nicht. Fill-ID/Economics/Raw und alle Moneyoriginale
bleiben bytegleich. Eine korrelierte Wiederholung verwendet genau dieselbe alte ID.

Bybit-Legacy benötigt zusätzlich den tatsächlich gespeicherten vollständigen
CCXT-Perpetualsymbolbeleg, altes `ccxt-market-v1`-Accounting und settlementAsset.
`linear=true` allein beweist nichts: Auch CCXT-Optionen können linear sein.
Die enge suffixfreie Originalgrammatik schließt Spot/Expiry/Options aus; der native
Markt kommt weiterhin aus tatsächlichem `info.symbol`, nicht aus zusammengeklebten
Währungscodes. Eine vorhandene widersprechende native `category` wird nie von der
Symbolgrammatik überstimmt. Fehlende Originale sowie Kraken Recent↔v3 bleiben offen.

Backfill läuft nur beim Evidence-Ingest, nie im finalen Safety-Fence. Pro Aufruf
werden maximal **500 Rows untersucht**, nicht nur 500 erfolgreiche Änderungen
gezählt. Eine pro DB-Handle/Konto lokale Keyset-Rotation erreicht spätere gültige
Rows hinter frühen unaufklärbaren Originalen. Restart beginnt konservativ neu;
kein zusätzliches Cursor-/Migrationsschema. Die Regression verwendet 501
unaufklärbare Rows vor einem echten späteren Original. Der abschließende rein
lesende `unresolvedFillIdentityCount` bleibt davon getrennt **kontoweit**.

Safety-Evidence verlangt den definierten `fillIdentityUnresolved`-Status;
fehlend/ungültig/nichtnull erzeugt `FILL_IDENTITY_UNPROVEN`. Für Paper reicht kein
pauschaler Modus-Bypass: vorhandene neue native Simulatorbindung oder unabhängige
exakte alte Paper-Order-/Fillquelle sind nötig. Ungewissheit löscht keine
Schutzorders und veranlasst kein unbewiesenes Flatten; Geldbewertung bleibt separat.

## Explizite NOT_PROVEN- und Restgrenzen der Originalpläne

1. **Bybit Attached Stop bleibt NOT_PROVEN.** Aktueller und geprüfter Basisquellstand
   `f808927` persistieren `PlannedOrder` / `{entry, protectiveStop}` für
   `certified_batch`, keinen belegten alten Attached-Requestvertrag.
   `parentOrderLinkId`, nativer Markt und Stoptyp werden beobachtet und erhalten,
   aber daraus entsteht weder Parentkante noch Ownership. Kein nachträglicher
   `requestWitness`, keine Übernahme eines unabhängigen heutigen Batchstops oder
   eines bloß ähnlichen positionweiten Trading-Stops. Ein positiver Attached-Pfad
   benötigt einen tatsächlich verfügbaren ursprünglichen Auftrag; diesen Beleg
   gibt der geprüfte Bestand nicht her. Strategiewechsel ist nicht Teil des Pakets.
2. **Kraken verlorene taglose Create-Antwort / fehlende Exchange-ID** ist nicht durch
   zukünftige Stringtags rückwirkend lösbar. Fehlende UID/Cursor-/Retentionsbelege
   bleiben lückenhaft. Recent↔v3-Alias ist nicht dokumentiert; bereits gebuchte
   alte Fills bleiben erhalten und blockieren eine möglicherweise doppelte neue
   Buchung. Echte originale v3-Rows können dagegen additiv gebunden werden.
3. **002 accountweite historische Finalität** folgt nicht aus Identität. Bybit
   Options-/Preupgrade-/Verzögerungsgrenzen und der Unterschied zwischen
   UTA-Logbeobachtung und finaler Fillcoverage bleiben wie in
   `002-BYBIT-UTA-RESEARCH.md` / `002-SCOPE-IMPLEMENTATION-NOTES.md` beschrieben.
   Kein `fillCoverageReason` wurde gelockert, keine Baseline erfunden/verschoben,
   kein Transfer/Fundinglog zur Execution erklärt und kein neuer Budgettopf angelegt.
4. **Retentionslücken/fehlende Altbelege** werden nicht durch Identitätserfolg geheilt.
   Der HL-Total-Retention-Pfad, gemeinsame fünf Zusatzreads und absolute Deadline
   mit Reserve bleiben erhalten. Eine fehlgeschlagene cloid-Abfrage ist kein
   No-Send- oder Abwesenheitsbeweis.
5. **001/002 Gesamtabschluss** erfordert weiterhin Root-Gesamtintegration mit den
   ursprünglichen Recovery-/Drain-/Closure-/Startup-/Crashpflichten und der
   expliziten Providerabnahme. Dieses Paket bescheinigt keine echte Orderannahme,
   Tradeausführung oder accountweite Zertifizierung. Weitere ursprüngliche Pläne
   und parallele 005/008-Arbeit werden hier nicht auf DONE gesetzt.

## Dateien und Übergabe

Neue Produktionsmodule:

- Python: `provider_order_identity.py`, `fill_identity.py` (beide bereits in Sonar).
- TypeScript: `trading_order_identity.ts`, `exchange_order_identity_contract.ts`,
  `trading_order_identity_bindings.ts`, `trading_fill_identity.ts`,
  `trading_fill_identity_repository.ts` (`src` wird vollständig von Sonar erfasst).

Enge bestehende Hunks: Python `order_identity.py`, `history_reader.py`,
`ccxt_adapter.py`, `kraken_history.py`; Node `trading_types.ts`,
`exchange_contract_validation.ts`, `trading_order_repository.ts`, `ccxt_exchange.ts`,
`trading_evidence_repository.ts`, `trading_fill_accounting.ts`,
`trading_money_ledger.ts`, M40 in `db.ts`, Fill-Digest/Persistenz in
`trading_engine.ts`, `trading_safety_proof.ts`, `trading_safety_repository.ts`,
`trading_risk_sources.ts`, `trading_protection_sources.ts` sowie reine Fill-SELECTs
in `trading_repository.ts` / `trade_journal.ts`. Root besitzt die eigentliche
Request-/No-Send-/Dispatchintegration; bestehende fremde Hunks sind erhalten.

**db.ts und trading_money_ledger.ts sind an ingress_ai für M41/Cashleg-API
übergeben.** Keine weiteren Änderungen an diesen Dateien durch dieses Paket.
Die eigenen Rewindfixtures entfernen M41 ausschließlich in ihren temporären
DBs in FK-Reihenfolge (cashleg_evidence, occurrences, fremder Inserttrigger).

## Tatsächlicher Abschlussnachlauf

Sechs neue JS-Dateien sind regulär in `tests/run_all.js` registriert und grün:
`test_trading_order_identity_requests`, `test_trading_order_identity_bindings`,
`test_exchange_fill_identity`, `test_trading_fill_identity`,
`test_trading_fill_identity_migration`, `test_trading_fill_identity_backfill`.

Zusätzlich grün: MoneyMigration, MoneyLedger, FillAccounting, RiskRepository,
IngressMigration, Engine, SafetyProof, ExchangeHistoryCoverage, ProtectionReceipt,
TradeJournalStreams, TradingCore, AccountingGate, Emergency,
ExchangeOrderCorrelation, EvidenceRepository, OrderRepository, Recovery,
AccountScope. Insgesamt **24 verschiedene fokussierte JS-Dateien** im letzten
Nachlauf; kein eigener kompletter RunAll behauptet. Die Protection-Receiptprobe
bestätigt tatsächliche Invalidierung nach Identitätswiderspruch und keine
Wiederbelebung allein durch Zurücksetzen lokaler Felder. Sourcehash-Bindingverlust
und native Neustarts sind separat positiv/negativ getestet.

Echte Rot→Grün-Fälle dieses Pakets enthalten: Namespacecollision, alte Money-ID,
ursprünglich fehlender Altbestandspfad, Risiko-Hash ohne Identität, unbeschränkte
503+ Rowreads, widersprechende Bybit-category und widersprechender Kraken-Tag trotz
passendem Unifiedclient. Der unabhängige Review
`002-LEGACY-FILL-IDENTITY-REVIEW.md` bestätigt zusätzlich zwei isolierte
Original-/Missing-original-Probes und den tatsächlichen M39→40-Migrationstest.

Letzte Gates: Typecheck **grün**; vollständiges ESLint **grün, 0 Meldungen**;
Architektur **149 Module / 646 interne Imports / 0 Kreise**; Complexity
**0 Warnungen / 0 Verstöße / max.15**; Ruff für gesamten Executor **grün**.
Python-Gesamtlauf: **220 Tests, ein Importfehler** im parallel entstehenden fremden
`test_acceptance_journal` (`journal_binding` noch nicht aus
`provider_acceptance_runner` importierbar), übrige **219 grün**. Root/quality sind
informiert; kein fremder Test/Gate wurde umgangen. Die sechs eigenen nativen
Provider-Identity-Tests einschließlich tatsächlicher SDK-Signierung sind separat
grün. Alle Daten/Prozesse waren isolierte lokale Fixtures; keine echten Konten,
Provider-Verbindungen, Trades, Serverstarts, Commits oder Pushes.
