# 005 – lokale Übergabe: Vorzeichen, Ledger-Vertrag und Entry-Accounting-Gate

Neuester Funding-/Coverage-Stand: [005-FUNDING-COVERAGE-NOTES.md](005-FUNDING-COVERAGE-NOTES.md). Die folgenden Abschnitte sind chronologische Übergaben; insbesondere der dort historisch genannte unabhängige Fundingreader ist inzwischen entfernt und durch einen dauerhaften, gemeinsam budgetierten Producer ersetzt. Gesamt005 bleibt für die ausdrücklich unbelegten Live-Bewertungsfähigkeiten offen.

Stand: 2026-09-02. **IN PROGRESS, nicht DONE.** Paket 006 ist separat übergeben. Diese Stufe implementiert die vom Hauptagenten freigegebenen vorbereitenden Schritte 1/2 und den engen Neueinstiegs-Gate. Keine Konten, Strategieprozente oder Preise geändert; keine externe Konto-/Brokerverbindung, echte Trades, Deployments, Commits oder Pushes.

## Implementiert

- Migration 35 `immutable_monetary_events_and_currency_valuations`: `trading_money_bindings`, `trading_money_events`, `trading_money_valuations`, `trading_money_conflicts`. Kein erfundener historischer Backfill. Originalevents und Bewertungen separat; keine historische Buchung gelöscht. Referenzen auf Intent/Fill sind Beleg-IDs ohne Löschkaskade.
- `trading_decimal`: zentrale signierte Negation/Subtraktion/Multiplikation; exakte Bewertungsmultiplikation verweigert nicht darstellbare Nachkommastellen, statt einen Nichtnullbetrag unbemerkt auf 0 zu kürzen. Rebate bleibt positiver Cashflow, `-0` wird `0`.
- `trading_money_ledger`: eindeutige ID je Konto, Fingerprint, Providerereignis und Buchungsart; kanonischer Inhaltsvergleich, wiederholbare Events/Bewertungen; widersprüchliche Originaldaten bleiben in einer eigenen Konflikttabelle. Preis-PnL-Vertrag derzeit ausschließlich `basis=fill`, keine zusätzlichen Provider-PnL-Buchungen.
- Reportingbindung vergleicht den tatsächlich verifizierten DB-Fingerprint (Paper explizit `paper:<accountId>`). Native gleiche Assets können 1:1 bewertet werden, Nullgebühr benötigt keine Assetumrechnung. Nichtnull ohne Asset oder ohne erlaubten Ereigniskurs bleibt `unresolved`. USDT, USDC und USD sind nicht gleichgesetzt. Die einzige implementierte Fremdassetquote ist eine feste Paper-Simulationsroute; keine Live-FX-Quelle zertifiziert.
- Ledger-Snapshot liefert bei Unvollständigkeit/Konflikt `amount=null`, daneben ausdrücklich nur `valuedSubtotal`. `historyCompleteness=unproven` ist unabhängig vom Bewertungsstatus und wird niemals aus einem leeren Ledger auf complete gesetzt.
- Python `accounting_evidence`: Bybit-Funding liest Original-Transaktionslogs mit explizitem Cursor, 50er-Seiten und ohne Währungsfilter. Nur `funding`, niemals `cashFlow` oder `change`; USDC-Session-PnL wird nicht als Funding gebucht. Hyperliquid liest `userFunding` mit verifiziertem Konto-Wallet, inklusiven überlappenden Zeitgrenzen und Beleg-ID aus Hash/Coin/Eventzeit (Nullhash allein ist nicht eindeutig). HIP-3-Collateral wird nicht aus dem Feldnamen `usdc` geraten.
- Funding nutzt das bestehende `RecoveryReadBudget`: maximal fünf Calls, bestehende absolute Deadline/Antwortreserve, Cooldown bei transienten Fehlern. Status, Fenster, Cursor, Quelle, Reason, `nextReadAt` und einzelne Events werden zurückgegeben. BadRequest/InvalidOrder/Timeout/unsupported ergeben niemals synthetisches 0.
- Bybit-Reporting verwendet die dokumentierten USD-Gesamtsummen `totalEquity`, `totalAvailableBalance`, `totalPerpUPL`, `totalInitialMargin`; keine erste Coin-Balance als Account-Equity. Hyperliquid verlangt das originale `marginSummary`/`withdrawable` in USDC. Kraken-Gesamtaccount-Reporting bleibt ausdrücklich unzertifiziert statt aus `settlement_preference` geraten.
- Additiver TypeScript-/HTTP-Vertrag: `fundingPnlToday:string|null`, optionales `accounting` mit Fingerprint, Reporting-/Settlementmetadaten, Quelle/Zeit, Unrealized-Semantik und Funding-Evidenz. Optional nur für alte Read-only-Consumer; **Entry verlangt Evidenz**. Validator prüft exakte Summe gegen Currency/Completeness und der CCXT-Client den angefragten Account-Fingerprint.
- `trading_accounting`: Aufnahme vorhandener Fundingevents, sichere Reportingbindung, frische UTC-Fenster und bekannte Unrealized-Semantik; ungeklärte Kosten sperren nur Neueinstiege im Konto. Vor tatsächlichem Dispatch erneut Frische und persistierte Geldkonflikte prüfen. Keine Accounting-Prüfung in Schutz-, Cancel-, Flatten- oder Reconcile-Pfaden.
- Engine bisher nur enger Accounting-Preflight/finaler Gate und sichere Fee-Negation. Sämtliche vorhandenen Coordinator-, Startup-, TTL-, Identitäts-, Revocation- und Schutzprüfungen bleiben erhalten.

## Schnittstellen für die nächste Stufe

- `bindAccountReportingCurrency(ReportingCurrencyBinding)`
- `recordMoneyEvent(MoneyEventInput)`, `recordFeeEvent({...input,fee})`; Originalbetrag von Fee-Events ist signierter Cashflow, nicht Kostenbetrag.
- `valueMoneyEvent(EventTimeValuation)`; unabhängige exakte Ereigniszeit-/Währungs-/Quellenprovenienz, gleiche Wiederholung no-op, Widerspruch dauerhaft und blockierend.
- `getMoneyEvent(id)`, `getReportingCurrencyBinding(accountId,fingerprint)`, `moneyLedgerSnapshot(accountId,sinceInclusive,untilExclusive)`.
- `assertEntryAccountingReady(account,snapshot)` liefert normalisierte Evidenz; `assertAccountingFresh(evidence)`, `assertPersistedMoneyReady(accountId)` für finalen Neueinstiegscheck.
- `read_funding_evidence(rest,exchange,deadline,since,until,user?)`: Fenster einschließlich beider Providergrenzen. `funding_total(evidence,reportingCurrency)` liefert nur bei vollständiger Traversierung und eindeutiger Bewertung eine Zeichenkette, sonst `None`.

## Historischer Zwischenstand vor der folgenden Fill-/Consumerintegration

1. Fills/Fees und Preis-PnL werden noch nicht durchgehend automatisch ins Ledger übernommen; der alte Engine-Positions-PnL-Consumer rechnet weiterhin aus Fills (nur Negation repariert). Fehlendes Asset einer echten neuen Fee ist deshalb erst mit der folgenden Fill→Ledger-Integration vollständig abgefangen.
2. Gemeinsamer Daily-PnL-/Analytics-Consumer, Teilverkaufsbuchung am Filltag, alle heutigen Fees bei offenen Positionen und die Ablösung des alten Closed-PnL-Pfads sind noch offen (Schritte 3/5).
3. Dynamische Reserven nach echten Fills, Entry-Resten, aktuellem Mark und Stop; kein Doppelzählen von Unrealized-Verlusten; Slippage/Cancel-Late-Fill/Restart-Matrix (Schritt 4) sind noch offen.
4. Persistierte Funding-Quellen-Coverage und längerfristiges Resume des zurückgegebenen Cursors sind noch nicht integriert. Bei mehr als fünf Seiten bleibt die Antwort incomplete; ein neuer heutiger Snapshot beginnt derzeit erneut am UTC-Tagesanfang. Keine Behauptung vollständiger Historie aus dem Ledger. Providerverzögerungen/Finalität bleiben separate Evidenzfragen.
5. Keine zertifizierte Live-FX-Ereignisquelle. Bybit-USDT/USDC-Funding ist in USD ohne belastbaren Ereigniskurs unresolved. Kraken Cashleg-/Account-Reporting-/Funding-Coverage-Vertrag bleibt unsupported/unverified; Hyperliquid-Unrealized-Semantik aktuell `unverified`. Diese Konten dürfen dadurch nicht fälschlich neue Entries erhalten.
6. Deterministischer Legacy-Backfill mit unveränderten Beleg-IDs und eigener Completeness-Dokumentation (Schritt 5) fehlt noch. Schema 35 erfindet keine alten Buchungen, Assetnamen oder Kurse.
7. Gesamtpaket 005 und alle acht Pläne erst nach diesen Restpflichten und gemeinsamen finalen Gates abschließen. Lokale Fakes sind keine Provider-/Releasefreigabe.

## Regressionen und lokale Gates

Vor Implementierung rot gezeigt:

- fehlende zentrale Rebate-Negation;
- echte Engine-Abschlussabstimmung mit `fee=-0.125` wirft wegen doppeltem Minus;
- Funding BadRequest liefert synthetisches `0`;
- unbekanntes Funding besitzt vor der Änderung keinen `ACCOUNTING_INCOMPLETE`-Entry-Gate;
- Fremdassetbewertung `1e-18 × 1e-18` wird vor exakter Multiplikation unbemerkt 0.

Danach grün:

- `test_trading_money_ledger.js`, `test_trading_accounting_gate.js`, `test_trading_fee_rebate.js`.
- Zusammen elf JS-Dateien: diese drei plus `test_trading_core.js`, `test_trading_engine.js`, `test_trading_failures.js`, `test_trading_entry_expiry.js`, `test_ccxt_exchange.js`, `test_ingress_migration.js`, `test_trading_order_migration.js`, `test_telegram_viewer_core.js`.
- Python Accounting-/Vertragstests: erster gemeinsamer Lauf 41 Tests grün; zusätzliche drei Reporting-/HIP-3-Regressionen und anschließend alle neun Accountingtests grün. Ruff der eigenen neuen/geänderten Pythondateien grün.
- ESLint aller eigenen 005-Dateien ohne Warnungen; Architektur 103 Module, 370 interne Imports, 0 Zyklen an diesem Zwischenstand.
- Gemeinsamer Typecheck/Komplexitätsgate war während laufender 007-Wiringänderungen im `forwarder.ts` blockiert; Hauptagent informiert. Nicht als finale globale Abnahme ausgeben. Keine Budgetlockerung.
- Letzter eigener Recheck: alle elf JS-Dateien erneut grün, alle neun Accounting-Pythontests erneut grün, eigene ESLint-/Ruffprüfungen grün. Der danach versuchte gemeinsame 44er-Pythonlauf traf zwei bereits parallel geänderte 004-Mode-Readback-Fixtures (`ProtectedEntryTests`, fehlendes `EXECUTION_MODE_NOT_PROVEN`-Fixture); zuständiger Agent informiert und bearbeitet sie. Typecheck zu diesem Zeitpunkt ausschließlich laufende 007-Aufrufer in `forwarder.ts` (1756/1840). Diese Integrationsrennen sind keine grünen Gesamtgates.

## Geänderte Dateien dieser Stufe

Neue Source: `src/trading_money_ledger.ts`, `src/trading_accounting.ts`, `src/trading_accounting_contract.ts`, `exchange_executor/accounting_evidence.py`.

Schmale gemeinsame Source-Hunks: `src/db.ts` (nur Migration/Tabellenliste), `trading_decimal.ts`, `trading_types.ts`, `exchange_contract_validation.ts`, `ccxt_exchange.ts` (Account-Snapshot), `paper_exchange.ts` (explizite Paper-Accounting-Evidenz), `trading_engine.ts` (oben beschriebene Gates/Negation), `exchange_executor/ccxt_adapter.py` (Reporting/Funding; Modus-/History-Hunks anderer Agenten nicht übernommen).

Tests: neue drei `test_trading_*` oben, `exchange_executor/tests/test_accounting_evidence.py`; angepasst `tests/test_ccxt_exchange.js`, `test_trading_failures.js` (belegtes Fundingfixture), `test_ingress_migration.js` (V35 beim echten V33-Rewind berücksichtigen), `test_telegram_viewer_core.js` (Schema 35), `tests/run_all.js` (isolierte Registrierung).

## Primärquellen

- [Bybit Transaktionslogs](https://bybit-exchange.github.io/docs/v5/account/transaction-log): separates Funding-/Preis-PnL-/Fee-Feld und Cursorvertrag.
- [Bybit Wallet Balance](https://bybit-exchange.github.io/docs/v5/account/wallet-balance): explizite USD-Einheit der Account-Gesamtsummen.
- [Hyperliquid Info Pagination](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) und [Perpetual-Funding](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals): inklusive Grenzen, Fundingfelder, erster DEX/HIP-3.
- [Kraken Account Log, offizieller Legacy-Host](https://docs-legacy.kraken.com/api/docs/futures-api/history/account-log/): Zeit-/ID-Range. Dies allein zertifiziert noch keine vollständige Cashleg-/Fundingsemantik.
- Lokal installierte CCXT 4.5.75-Implementierungen `bybit.py`, `hyperliquid.py`, `krakenfutures.py` gelesen; keine Provider-Endpunkte abgefragt. Insbesondere darf Bybits generisches CCXT-Funding-Parsing (`execFee`, angenommener USDT-Code) den hier expliziten Transaktionslogvertrag nicht ersetzen.

## Aktueller Stand: Fill-/Fee-/Teil-PnL-Integration und gemeinsame Geldkonsumenten

Diese Stufe ersetzt die historischen offenen Punkte 1/2/6 oben im hier nachgewiesenen Umfang. Paket 005 insgesamt bleibt IN PROGRESS; dynamische Reserven und persistentes Funding-Resume sind ausdrücklich nächste Arbeit, keine implizite Erledigung.

- Migration 36 `fill_accounting_provenance_and_replayable_money_projection`: Fill-Kontobindung/Settlementprovenienz, sticky Konfliktkennzeichen, nullable Ledger-Positions-PnL, dauerhafte begrenzte Projektionswarteschlange und unveränderliche Ableitungsbelege. Trigger auf neue/geänderte Fills, wirtschaftliche Orderänderungen, Positionsanlage, Kontobindung, Bewertung und Bewertungs-/Ereigniskonflikte. Indizes für Konto-/Intentzugriff. Init/Close/Wartungshooks bleiben beim zuständigen Agenten.
- `persistCorrelatedFill` bindet Accountingmetadaten innerhalb der bestehenden Eigentums-/Idempotenztransaktion an. Unbekannte Metadaten verhindern keine Beweisaufnahme. Engine-Abgleiche posten echte Fees/Rebates automatisch; Preis-PnL entsteht ausschließlich aus eigenen linearen Exitfills, nicht zusätzlich aus Provider-PnL.
- Gleitende exakte Kostenbasis benutzt nur vorhergehende Fills. Spätere Entries ändern frühere Realisierung nicht. Originalbetrag, Asset, Ausführungszeit, Fill-/Intent-ID und Ableitungshash bleiben unveränderlich. Widersprüchliche spät entdeckte Belege erhalten den alten Wert plus Konflikt und machen aktuelle Summen unresolved. Nicht darstellbare Quotienten und nicht beweisbare gemischte Same-Millisecond-Reihenfolge werden nicht gerundet/erraten.
- Ledger-Projektionen laufen pro Konto begrenzt (Standard 100 Intents). Ausstehende/ungeklärte Projektionen blockieren nur Entry-Geldfreigabe. Schutz, Cancel und Abschluss eigener Exposure bleiben verfügbar; ein solcher Abschluss kann bewusst `ledger_realized_pnl=null` tragen.
- Verifizierte ursprüngliche Paperorder-/Paperfill-Belege erlauben deterministischen Legacybackfill; fehlende alte Live-Kontobindung, fehlendes Asset oder sonst nicht rekonstruierbare Historie bleibt ungeklärt. Alte Positionswerte werden nicht als Quellen benutzt und bei Unklarheit nicht überschrieben. Bestehende Fundingereignisse bleiben genau einmal erhalten.
- DailyRisk liest Preis-PnL + signierte Fees/Rebates/Funding aus demselben Zeitfenster-Ledger; Funding wird nicht doppelt addiert. Aktuelle Remote-Unrealized-PnL bleibt zusätzlich in der bisherigen konservativen Semantik. Alte Engine-Closed-PnL-/direkte Fill-PnL-Berechnung entfernt. Statische Planreserven sind weiterhin vorhanden und müssen in der nächsten Stufe ersetzt werden.
- Account-/Kanal-/Exchange-Analytics, adaptive Closed-Trade-Auswertungen, Position-/Intent-Viewer und Journal sind auf Ledgerwerte umgestellt. Teilrealisierung zählt vor Gesamtabschluss. Geldsummen verwenden zentrale exakte Decimalfunktionen; Originalgebühren bleiben pro Asset, Volumen pro Settlement getrennt. Gemischte/ungeklärte Gesamtsummen werden null, nicht 0. Bestehende Frontendmetrik zeigt null als Strich und übernimmt die serverseitige exakte Gesamtsumme; keine neue UI.
- Retention-Kopplung an Root und den DB-Retention-Agenten übergeben: sämtliche Ledger-/Projektions-/pending-/Fillquellen einschließlich ungeklärter Legacybelege müssen konservativ erhalten bleiben. Keine FKLockerung und keine Beleglöschung autorisiert. Dieser eng verknüpfte Retentionshunk liegt ausdrücklich außerhalb meiner Dateiownership.

### Neue Regressionen / Gates dieser Stufe

Vor Fix rot: Gebührenledger blieb bei offenem echten Papertrade leer; `_normalized_fill` machte fehlende tatsächliche Gebühren zu 0 und besaß keine Settlementprovenienz. Danach grün:

- Neue `test_trading_fill_accounting.js`: gestriger Entry/heutige Teilrealisierung, Rebate, spätere Entries, exakte Kostenbasis, Neustart/Idempotenz, identische Ledger-/Analyticswerte, Ereigniskursnachtrag, Konflikterhalt.
- Neue `test_trading_money_migration.js`: echte V35→V36-Migration und zweiter Start, alter Rebate aus bewiesener Paperquelle, fehlendes Asset, nicht rekonstruierbare Quelle, bestehendes Funding, 105 dauerhaft wartende Intents in 100+5-Budget über Neustart; keine Quelllöschung.
- `test_trading_accounting_gate.js` jetzt mit automatisch aufgenommenen echten eigenen Fills mit Nichtnullfee/fehlendem Asset: Entry danach blockiert; vorhandener Stop schließt Exposure trotzdem.
- `test_dashboard_analytics.js` zuerst unresolved ohne USDC-Kurs, dann belegte simulierte Ereigniskurse 1.02 statt Paritätsannahme; vollständig belegte Standardwerte wieder identisch.
- Fokussierte Serie: 19 von 20 JS-Dateien grün (MoneyLedger, FillAccounting, MoneyMigration, AccountingGate, FeeRebate, Engine, Failures, TradingAnalytics, DashboardAnalytics, JournalStreams, WorkflowFallback, ExchangeContractValidation, EvidenceRepository, CcxtExchange, OrderMigration, IngressMigration, TelegramViewerCore, ConfigurableFallbackMigration, SignalSchemaMigration). Einziger roter Lauf: laufende parallele 004-IOC-Umstellung in `test_trading_core.js:418` (limit statt bisher market), zuständigen Agenten informiert; nicht als grün ausgegeben.
- Neun Accounting-Pythontests und zwei neue `test_fill_accounting.py` grün; Ruff eigener Accounting-/Normalisierungsdateien grün. Node-Typecheck grün, eigene ESLint-Dateien 0 Warnungen, Frontend-Typecheck und Oxlint der geänderten bestehenden Darstellung grün. Architektur 108 Module/418 interne Imports/0 Zyklen. Globales Komplexitätsgate zu diesem Zeitpunkt ausschließlich paralleler `testTradingPlanContracts` mit 102 statt 100 LOC; gemeldet, keine Budgetlockerung.
- Neue zwei JS-Dateien isoliert in `tests/run_all.js` registriert. Gesamt-JS-/Python-Abnahme startet weiterhin der Hauptagent, nicht als durchgeführt behauptet.

### Dateiberührungen dieser Stufe

Neu: `src/trading_fill_accounting.ts`, `src/trading_money_reporting.ts`, `tests/test_trading_fill_accounting.js`, `tests/test_trading_money_migration.js`, `tests/fixtures/accounted_trades.js`, `exchange_executor/tests/test_fill_accounting.py`.

Geändert: `db.ts` nur Migration36/RequiredTables/Allowlist; `trading_decimal.ts`, `trading_types.ts`, `trading_accounting_contract.ts`, `trading_accounting.ts`, `trading_money_ledger.ts`, `trading_evidence_repository.ts`, `exchange_contract_validation.ts`, `paper_exchange.ts`, `trading_engine.ts` ausschließlich Fee/PnL/Entry-Geldgate; `trading_repository.ts`, `trading_telemetry.ts`, `trading_channel_risk.ts`, `trade_journal.ts`, `viewer_projection.ts`, `telegram_viewer/formatters.ts`, bestehende `frontend/src/app/workflow/operations-panel.tsx` nur Geldtotal-/null-Anzeige; `ccxt_adapter.py` nur `_normalized_fill` dieser Stufe. Relevante bereits genannte Fixtures/Tests und `docs/TRADING_GUIDE.md` angepasst. Parallele Mode-/IOC-/TTL-/History-/Startupänderungen nicht übernommen oder überschrieben.

Zusätzliche Primärquelle: [CCXT Market Structure](https://github.com/ccxt/ccxt/wiki/Manual#market-structure) definiert `settle`, `linear` und `contractSize`; diese echte Marktmetadatenquelle trägt den additiven `ExchangeFill.accounting`-Vertrag. Missing/inverse/unbekannt schaltet keine generische Preis-PnL-Fähigkeit frei.

## Aktueller Stand: dynamische tatsächliche Reserven (Schritte 3–4)

Diese nachfolgende Stufe ersetzt die oben noch offene statische Planreserve. Paket 005 bleibt wegen des separat beauftragten nächsten Funding-Resume-/Coverage-Schritts und unbelegter Live-Bewertungsfähigkeiten IN PROGRESS; keine Provider-/Release-Abnahme behauptet.

- Neue reine Decimalberechnung: `dayPnl = Ledger heute UTC + aktuelle price_only UPL`; verbrauchter Verlust `max(0,-dayPnl)`. LONG-Reserve `max(0,Mark−belegterStop)×eigeneRestmenge`, SHORT entsprechend umgekehrt; noch ausführbare Entry-Reste verwenden ihren tatsächlichen ursprünglichen Limit-/IOC-Preis. Fill-zu-Stop-Risiko ist separat diagnostisch und wird nicht doppelt addiert. Kandidaten verwenden endgültige Menge/Preis statt `plan.riskAmount`; konfigurierte Equity-/Marginprozente bleiben unverändert.
- Migration 37 `derived_current_risk_reservations_with_provenance`: unveränderliche ursprüngliche `trading_risk_contracts`, unveränderliche `trading_risk_observations` und aktueller Pointer `trading_risk_current` mit nullable Balancebeleg/Unklarheitsgrund. Beobachtungen enthalten pro Intent/stabiler Order-/Entrygeneration tatsächliche Mengen, Preise, Reserve, Kostenstatus, Ledgergeneration und Originalquellen. Kein erfundener Backfill alter Reserven. Alte Fills, Orders und Positionen bleiben byte-identisch.
- Quelle ist die abschließende vorhandene Ownership-/Stopabstimmung: eigene kumulative Fillmengen müssen exakt passen, Stopidentität/Reduce-only/Trigger/Restdeckung wird aus derselben vorhandenen Remoteantwort geprüft. Explizite lineare Settlementmetadaten und tatsächlicher Mark werden additiv transportiert. Keine Symbolsuffix-Ableitung, keine Stablecoinparität, keine zusätzliche Marktsuche. Unterschiedliche Reporting-/Settlementwährung bleibt ohne zertifizierten Umrechnungspfad unresolved.
- Für vorhandene eigene Verpflichtungen folgt genau ein normal begrenzter Account-Snapshot nach dem vollständigen Reconcilelauf, nicht nach jedem der höchstens drei Zwischenpässe. Read-/Kostenfehler annotieren ausschließlich Risiko und verhindern niemals vorhandene Schutz-/Exitverwaltung. Bei belegter Überschreitung wird nur der bestehende dauerhafte Entry-Drain angefordert; der nächste reguläre Lifecycle-Pass nutzt das bisherige gemeinsame Fünf-Versuche-Budget. Keine zweite Cancelserie, keine neue Liquidationsregel.
- Entry-Gate prüft höchstens 60 Sekunden alte Account-/Mark-/Reservebelege und identischen UTC-Tag, Fingerprint, Credentialgeneration, Coordinator-Epoch, persistierte Kandidatenwirtschaft und Quellen-/Ledgerhash. Ein zwischenzeitlich geänderter Beleg führt nicht zu einer stillen Freigabe. Der ursprüngliche Entryplan bleibt Auditspur.
- Enger generischer Dispatch-Fence: `dispatching` ist vorher durable committed. Danach read-only Quellenprüfung unter SQLite-Transaktionsowner, letzter synchroner Guard und unmittelbarer Adapteraufruf. Der Netzwerkpromise wird außerhalb awaited. Der Adapter erbt ausdrücklich keinen AsyncLocalStorage-Datenbankowner; verschachtelter Dispatch unter einem alten Transaktionsowner wird verweigert. Guard wird vor den breiteren Geldprüfungen und zwingend nochmals unmittelbar vor Send ausgeführt, damit TTL-/Operatorursachen präzise bleiben.
- Paper-Regression beseitigt den bisherigen synthetischen UPL-Wert 0: aktuelle Mark-PnL pro echter simulierter Position, aktuelle Equity einschließlich UPL und konservatives FreeCollateral; gespeicherte gebundene Margin wird nicht aus UPL geschätzt. Fehlender Mark blockiert Accountbewertung, aber lässt Position/Schutz mit nullable UPL lesbar. Nichtpositive Equity wird nicht in eine erfundene positive Zahl verwandelt.
- Eng autorisierter Retention-Zusatz schließt jeden Intent mit ursprünglichem Risk-Contract VOR dem Batchlimit aus. Keine FKLockerung/Beleglöschung. Vor Änderung reproduzierter FK-Fehler, danach wiederholtes Pruning und Foreign-Key-Prüfung grün.

### Nachweis dieser Reservestufe

Vor Implementierung rot: fehlendes Reservemodul/Repository, fehlendes tatsächliches Positions-Markfeld im Pythonvertrag; Paper-UPL 0 statt exakt 12; Retention-FK-Fehler für alten Risk-Contract. Danach:

- Neue `test_trading_risk_reservations.js`: tabellarische exakte LONG-/SHORT-/Gewinnstop-/Markbewegungs-/Restentry-/Unknownfälle; UTC-Wechsel, exakte Budgetgrenze und tatsächliche Kandidatenwerte. 50 Verlust + 49.05 tatsächliches Risiko ist zulässig; 51 + 49.05 nicht. Das alte allgemeine Failurefixture wurde mit echtem Exitfill 49 statt50 entsprechend auf die tatsächlich überschrittene Grenze gestellt.
- Neue `test_trading_risk_repository.js`: echter V36→V37-Übergang ohne Quelländerung, fehlender Altbeleg fail-closed, Replay, Neustart, Epoch-/Stopänderung, fehlender Mark, genau ein Balanceabruf, Kontostandfehler ohne Stopentfernung, Kandidatenmutation, neue (auch Null-)Ledgerereignisse, Partialfill/CancelPending/terminaler Cancel/LateFill.
- Neue `test_trading_risk_engine.js`: reale lokale Paper-Teilfüllung mit späterem Fundingverlust überschreitet Gesamtbudget; bestehender Stop bleibt aktiv, Drain wird dauerhaft angefordert, nächster regulärer Abgleich cancelt nur den Rest und lässt die geschützte eigene Menge bestehen; Funding genau einmal.
- Neue `test_trading_dispatch_fence.js`: unabhängiger SQLite-Leser sieht committed `dispatching` vorSend; Vorprüfung/Guard→abandoned, synchroner/asynchroner Sendfehler→unresolved; injizierter COMMIT-Fehler nach Sendbeginn→unresolved und spät abgelehnter Netzwerkpromise bleibt beobachtet; kein vererbter DBowner und keine Nested-Dispatch-Lücke.
- Neue `test_paper_accounting.js` und erweiterter `test_paper_partial_fills.js`: LONG/SHORT-Gewinn und Verlust, exakte Equity/freeBalance bei unveränderter Margin, partielle Kostenbasis, fehlenderMark, nichtpositive Equity und Neustart.
- Zuletzt grün: diese fünf neuen JS-Dateien plus PaperPartial, AccountingGate, Engine, Failures, WorkflowFallback, Core, CcxtExchange, ExchangeContractValidation, TradingAnalytics, DashboardAnalytics, JournalStreams, RetentionAccounting, EntryExpiry, ControlRaces und Migration-/Viewerfixtures. Risk-/Paper-/Recovery-ESLint ohne Warnungen; Typecheck grün. Zwölf gezielte Accounting-/Fill-Pythontests und eigene Ruffprüfung grün. Architektur119Module/475Imports/0Zyklen an diesem Zwischenstand.
- Laufende parallele 004-Tiers erzeugten beim gemeinsamen Complexity-Gate zwei bekannte Warnungen (`assertTierEvidence`27, `createTradingPlan`21); Agent informiert, keine Schwelle geändert. Dessen IOC-Lifecyclefixture war korrekt wegen realem Caprisiko420>Budget400 gesperrt. Der Agent korrigiert den Risk-Prozent-Solver auf tatsächlichen IOC-Preis→Stop; die Fixture/Budgetgrenze wird ausdrücklich nicht gelockert. Nicht als bestandene globale Gesamtabnahme ausgeben. Hauptagent startet abschließende gemeinsame Gates.

### Dateiberührungen der Reservestufe

Neu: `src/trading_risk_reservations.ts`, `trading_risk_sources.ts`, `trading_risk_repository.ts`, `trading_risk_admission.ts`, `trading_risk_reconciliation.ts`; fünf oben genannte JS-Testdateien.

Geändert: `db.ts` nur Migration37/RequiredTables, enger DB-Owner-exit/Dispatch-Fence neben Transaktionsfunktion und explizit freigegebener Risk-Contract-Retentionfilter; `trading_recovery.ts` optionaler read-only beforeSend-Fence; `trading_engine.ts` nur tatsächliches Geld-/Reservegate und enger Post-Protection-Riskhook; `trading_accounting.ts` präzisierter Kommentar. `trading_types.ts`, `exchange_contract_validation.ts`, `paper_exchange.ts` tatsächliche Mark-/Settlement-/nullablePositions-UPL-/Paper-Bewertungsfelder; `ccxt_adapter.py` ausschließlich additive Markt-/Positions-/Fillmetadaten und Unknown-UPL-Normalisierung, keine Tier-/Mode-/History-Hunks. `exchange_executor/tests/test_fill_accounting.py`, `test_paper_partial_fills.js`, `test_retention_accounting.js`, `test_trading_failures.js`, `test_workflow_fallback.js`, `fixtures/accounted_trades.js`, V33-/V35-/Viewer-Migrationsfixtures, isolierte run_all-Registrierung, diese Notes und TradingGuide.

Zusätzliche Primärquelle: [CCXT Positions-/Marktstruktur](https://docs.ccxt.com/docs/manual) bestätigt `markPrice`, `linear`, `settle` und `contractSize`; installierte CCXT4.5.75-Quelle gegengeprüft. Tatsächlich fehlende Felder bleiben unbekannt. Keine Konten/Provider abgefragt.
