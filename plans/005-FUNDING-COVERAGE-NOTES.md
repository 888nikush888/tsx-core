# 005 – dauerhafte Fundingtraversierung und finanzielle Beobachtung

Stand 2026-09-02; lokale Implementierungsstufe, keine Provider-/Deploymentfreigabe. Diese Stufe ersetzt den früheren unabhängigen `read_funding_evidence`-/`_funding_today`-Abruf vollständig. Die früheren offenen Punkte zu dauerhaftem Fundingcursor/Restart sind im nachstehenden Umfang umgesetzt; Gesamtpaket 005 bleibt wegen ausdrücklich unbelegter Bewertungs-/Providerfähigkeiten offen.

## Vertrag und Quellen

- Ein Producer je Konto/Fingerprint/Namespace, monotoner CAS-Revision und Filterhash. Namespaces: `bybit_uta_transaction_log_scope_v1` (UNIFIED, keine category/type/baseCoin/currency-Filter), `hyperliquid_user_funding_v1`, `kraken_account_log_v3` (aufsteigende Roh-Log-IDs). Die installierte CCXT-Version 4.5.75 wurde direkt geprüft; generische, teilweise float-/währungsratende Fundingnormalisierung wird nicht verwendet.
- Migration38 speichert Checkpoints, unveränderliche Receipts, jedes Originalvorkommen mit ordinal und getrennte `money`-/`scope`-Consumerstände. Originalseiten/Consumerarbeit/Cursorfortschritt sind eine Transaktion. Kein Transaktionslog wird künstlich zum Fill. Migration39/Bybit-Modus- und Scopeconsumer stammen vom zuständigen 002-Agenten.
- `AccountLogCheckpoint.audit` hält neben dem Vorwärtscursor ein kompaktes historisches Festfenster samt Cursor. Beide Spuren gehören demselben Producer; `receipt.lane` unterscheidet ausschließlich die Traversierung. Ein historisches EOF erhöht niemals `scannedThrough` des aktuellen Fensters. Alte Belege/Obligationen werden beim Tageswechsel nicht abgeschnitten.
- Bestehende exakte Orderwiederherstellung erhält bei fälliger Zusatzarbeit zwei Calls. Ein Modusbeleg kostet tatsächlich zwei weitere Calls; der persistierte Revisionswechsel lässt bei wiederholt fehlendem Modus jede zweite Runde auch alte Order-/Fillseiten vorankommen. Funding erhält höchstens eine Seite je regulärem Lauf. Gesamtsumme aus Targeted/Mode/AccountLog/History bleibt maximal fünf; eine gemeinsame Deadline/Antwortreserve und providerseitiger Cooldown gelten für alle. Kein unabhängiger Fundingworker, HTTP-Retry-Fünfertopf oder Netzwerkawait unter SQLite-Lock.
- Bybit: feste Fenster maximal sieben Tage, EOF nur leerer expliziter `nextPageCursor`; widersprüchliche gleiche IDs bleiben als getrennte Originalvorkommen erhalten. Dokumentierte Zweijahresretention wird nicht mit leerer Antwort übergangen. Quelle kann verzögert liefern. Der 002-Ursprungsbeleg wird für den tatsächlichen UTC-Finanzzeitraum geprüft; eine spätere Baseline erfindet keine frühere Konto-/UTA-Historie.
- Hyperliquid: auch eine kurze Seite ist kein EOF. Inklusive letzte Zeit wird erneut gelesen; eine volle identische Millisekunde bleibt `timestamp_saturated`. Hash/Coin/Eventzeit erhalten die bisherigen Funding-IDs, auch bei gemeinsamem Nullhash. HIP-3-Währung bleibt ohne eigenen Collateralbeleg unbekannt.
- Kraken: UID, exakte Originaldezimalstrings und beliebig große Log-ID-Zeichenketten bleiben erhalten. Das ursprüngliche JSON wird nur verwendet, wenn es exakt zum tatsächlich zurückgegebenen CCXT-Resultat gehört; bereits gerundete Floats werden verworfen. Aufsteigende ID-Fortsetzung braucht auch nach einer kurzen Seite das folgende leere EOF. Cash-/Positionlegs werden nicht doppelt gebucht; unkorrelierte Beziehungen bleiben offen.

## Trennung der Nachweise

1. Producer-EOF bestätigt nur die abgefragte Traversierung.
2. Quellscope benötigt das jeweilige Provider-/Konto-/Ursprungsprofil.
3. `FundingObservationProof` ist `provider_as_observed`, `delivery=may_be_delayed`, nicht Account-Fillfinalität. Status `observed` bedeutet eine frische finanzielle Beobachtung im ausdrücklich so benannten Vertrag. Das alte Funding-Envelope kann nur zusammen mit diesem eigenen Proof `complete` liefern; keine pauschale Completeness des gesamten Kontos.
4. Bewertung ist separat: individuelle Ledgerereignisse brauchen Originalasset und Reportingkurs. Native gleiche Währung ist keine Stablecoinparitätsannahme. Bei fehlenden Kursen ist amount null.

Die Proofprüfung bindet nicht nur einen kopierten Hash, sondern sämtliche tatsächlichen Proofwerte (Betrag/Währung/Fenster/Identität/Generation/Quelle). Neue unconsumierte, widersprüchliche, nachgelieferte oder bewertete Quellen ändern die finale Riskgeneration vor Send. Order-/Cancel-Negativbeweise werden aus diesem EOF niemals erzeugt.

## Finanzfluss und Standardfälle

- Rohfunding wird nach der dauerhaften Aufnahme automatisch idempotent gebucht. Bybit-Quelle und vorhandene Legacy-ID bleiben unverändert; cashFlow/change sind kein Funding. Eigene Tradefees/Preis-PnL werden nur durch echte, eindeutig passende gespeicherte Ausführungen repräsentiert, nicht durch Annahme `tradeId=execId`.
- Bereits vor dem ersten Reportingbinding gespeicherte native Events werden begrenzt nachbewertet. Eigene ausstehende Fillprojektionen werden vor Erzeugung des finanziellen Proofs abgearbeitet. Dadurch entsteht keine dauerhafte Selbstblockade beim ersten Kontoabgleich; größere Warteschlangen bleiben bis zum tatsächlichen Abschluss incomplete.
- Native USDC-Funding und Paper sind lokal vollständig nachgewiesen. Bei Hyperliquid werden Original-szi, entryPx, positionValue, unrealizedPnl und summiertes totalNtlPos exakt gegengeprüft. Nur passende native Erst-DEX-Positionen liefern `price_only`; separates cumFunding wird nicht ein zweites Mal eingebucht. Es gibt keine Float-Default0-Summe, keine Fehlertoleranz und keine Änderung von Equity oder gebundener Margin.
- Ein verspäteter aktueller Fundingverlust erreicht den produktiven Post-Protection-Riskhook, verändert die tatsächliche Tagesrisikoprüfung und fordert bei Überschreitung dauerhaft Entrydrain an. Der bestätigte Stop bleibt offen; keine zweite Cancelserie oder neue Liquidationsregel.

## Konkrete verbleibende Fähigkeiten, nicht durch Defaults ersetzt

- Keine zertifizierte Live-FX-Ereignisquelle. Nichtnull USDT/USDC in Bybits USD-Report sowie fremde Fee-Assets bleiben ungeklärt; keine Parität wird unterstellt. Die schon vorhandene Paper-Ereigniskursroute ist keine Livefreigabe.
- Bybit-Finanzzeit vor belegtem post-UTA2-Ursprung oder außerhalb der Retention kann dieser Rohstream nicht garantieren; heutiges EOF entfernt diese Lücke nicht. Bei vorhandenem unbelegtem Altbestand bleibt Aufklärung nötig.
- Kraken-Gesamtaccount-Reporting bleibt nicht zertifiziert. Nicht eindeutig korrelierte Cash-/Positionlegs, externe Fees/Preis-PnL, USDC-Session-Resets und unbekannte Bewegungsarten bleiben konkret unresolved. Ein Rohlog ist keine Lizenz, Preis-PnL zusätzlich zu eigenen Fills zu posten.
- Hyperliquid-HIP3 oder gerundete/widersprüchliche UPL-Originale ohne exakt nachgewiesene Preissemantik bleiben unbewiesen. Diese Grenzen verhindern neue Entries, nicht bestehenden Schutz/Exit.

## Lokale Regressionen und Gates

Vor Korrektur rot: manipulierter Proofbetrag bei kopiertem Hash akzeptiert; historischer eigener Auditcursor fehlt; native Events vor erstem Balancebinding bleiben dauerhaft unbewertet; wartende Fillprojektionen verhindern die Erzeugung ihres eigenen Finanznachweises; originaler HL-Preis-PnL-Nachweis fehlt. Danach gezielt grün.

- Neue JS-Dateien: `test_trading_account_log`, `test_trading_account_log_audit`, `test_trading_funding_observation`, `test_trading_funding_risk`. Registriert in run_all. Testen atomaren Cursor-Rollback, Neustart vor Consumer, Legacyaliases, Nullhashmehrdeutigkeit, unbekanntes Collateral, Proofmanipulation, Credentialrotation, alte Auditseiten über UTC, spätere Verluste und produktiven Riskhook ohne Stopverlust.
- `test_account_log_reader.py`: echter Adapterdurchlauf über sieben Fundingseiten mit Neustart und gemeinsamer Fünfergrenze, Mode kostet echte zwei Calls, alte History kommt alternativ voran; EOF-/Zeitgrenzen, RateLimit-Cooldown, Deadline, exakte Kraken-Dezimal-/Groß-ID-Quelle, Retention und Auditrotation.
- `test_accounting_evidence.py` ist auf den neuen gemeinsamen Producer umgestellt; Balance/UPL-Originale und Fundingfehler bleiben geprüft. Alter unsicherer separater Reader ist entfernt, nicht nur unbenutzt.
- 25 fokussierte JS-Dateien zuletzt vollständig grün, einschließlich neuer vier, Mode/Scope/UTA, CCXT, Money/Fill/Accounting, Risk/Engine/Failures, Recovery/History/Evidence, Analytics, Paper, DispatchFence und Ingressmigration. V33/V35/V36-Rewindfixtures bilden jetzt tatsächliche zusammenhängende Altschemata vor38/39 ab.
- Abschließende gesamte Python-Suite: 211 Tests grün; gezielter 23er-Accounting-/Producerlauf ebenfalls grün.
- Eigene ESLint-/Ruffdateien ohne Warnungen. Abschließender globaler Complexity-Gate grün: 0 Warnungen, maximale Komplexität15, maximale Funktion100Zeilen, Nestingtiefe4. Typecheck war vor den letzten parallelen003-Hunks grün; letzter Nachlauf traf ausschließlich den neuen `trading_protection_proof.ts`-Hunk (unknown→TradingPlan), Hauptagent informiert. Architektur zuletzt ohne Zyklen; keine Grenze geändert. TelegramViewer-Schemafixture ist zusätzlich grün auf39. Gesamt-JS-Abnahme liegt beim Hauptagenten.

## Dateiberührungen / APIs

Neue Source: `exchange_executor/account_log_sources.py`, `account_log_reader.py`, `account_log_scheduler.py`; `src/trading_account_log_contract.ts`, `trading_account_log_repository.ts`, `trading_account_log_money.ts`, `trading_funding_observation.ts`.

Gemeinsame schmale Source-Hunks: db.ts ausschließlich Migration38/RequiredTables; trading_types.ts DTOs; exchange_contract_validation.ts gemeinsames Budget; ccxt_exchange.ts gebundener Accountpayload/Fundinghydration/Modeantwortfence; trading_recovery.ts Anfragecheckpoint/Modebedarf; trading_evidence_repository.ts Logpersistenz vor bestehender Historypersistenz; trading_engine.ts Log-Moneyprojektion unmittelbar nach Evidenzcommit; trading_accounting_contract.ts Beobachtungsvertrag; trading_accounting.ts finaler Proofcheck; trading_risk_admission.ts dauerhafte Quellgeneration; trading_money_ledger.ts begrenzte native Nachbewertung; accounting_evidence.py Reporting/UPL und Entfernung des alten Readers; ccxt_adapter.py Shared-Scheduler/Accountinghunks, kein Rewrite fremder Tier-/Safety-/Cancelbereiche. Zugehörige neue Fixtures, vier neue JS-Tests, zwei Pythondateien, angepasste CCXT-/Rewindfixtures, isolierte run_all-Registrierung und TradingGuide.

Stabile APIs: `accountLogCheckpoint`, `storedAccountLogCheckpoint`, `persistAccountLogProgress`, `pendingAccountLogReceipts(accountId,consumer,limit<=100)`, `setAccountLogConsumerResult`, `projectAccountLogMoney`, `observedFundingEvidence`, `assertFundingObservationCurrent`, `valueNativeAccountMoney`. Der 002-Consumer benutzt dieselben Receipts ohne zusätzliche Provideraufrufe.

## Primärquellen

- [Bybit Transaktionslog](https://bybit-exchange.github.io/docs/v5/account/transaction-log) und [Pre-upgrade-Log](https://bybit-exchange.github.io/docs/v5/pre-upgrade/transaction-log): Scope-/Cursor-/Retention-/Latenzgrenzen. Pre-upgrade wird nicht still als vollständig vorgelogen.
- [Hyperliquid Info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) und [Perpetuals](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals): inklusive Grenzseiten, Clearinghouse-Originalpositionen, Funding separat. Dokumentiertes Beispiel: 100.02765 − 0.0335 × 2986.3 = −0.0134, unabhängig von cumFunding 514.085417.
- [Kraken Account Log](https://docs.kraken.com/api-reference/account-history/get-account-log), [Feldvertrag](https://docs.kraken.com/exchange/api-reference/futures-websocket/account_log) und [offizielle Loginterpretation](https://support.kraken.com/articles/360057072571-interpreting-the-logs-derivatives): UID, Cash-/Positionlegs und Fundingrealisation.

Alle Tests nutzen ausschließlich temporäre Datenbanken und lokale Fakes. Kein echter Provider-/Server-/Telegramzugriff, keine geänderten Konten/Strategieprozente, kein Commit/Push/Deployment.
