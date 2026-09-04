# 005: Kraken-Originalcashlegs und bestehende Fill-Gebühren

Stand: 2026-09-02. Teilauftrag innerhalb 005; keine allgemeine Live-FX-Route. Die maximale 10-s-As-of-Policy aus `005-FX-FOLLOWUP-PLAN.md` ist weiterhin nicht entschieden und wird hier nicht implementiert. Kraken-Spot/Cross-Venue bleibt ausgeschlossen.

## Nachgewiesene Ausgangslage

Kraken beschreibt für jeden Trade zwei Logbuchungen: die Positionsänderung und die Änderung des Walletbestands. Die Bestandsänderung enthält Gebühr, realisierten Preis-PnL und Funding. Das Positionssymbol ist kein Cashasset. Konversionen, Kfee, Zinsen und Steuern haben eigene Buchungstypen und dürfen nicht still als normale Handelsgebühr behandelt werden. [Kraken: Interpreting the logs](https://support.kraken.com/articles/360057072571-interpreting-the-logs-derivatives), beim Abruf als aktualisiert am 22.04.2026 ausgewiesen.

Im REST-v3-Accountlog bezeichnet `execution` die zugehörige Ausführung bzw. Übertragung, `booking_uid` dagegen die einzelne Logbuchung. `asset`, `collateral`, `contract`, `margin_account`, `date`, `fee`, `realized_pnl`, `realized_funding` und alte/neue Bestände sind originale Belege. `conversion_fee` sowie `conversion_spread_percentage` sind Prozentwerte, keine Cashbeträge. `exchange_rate` ist ein USD-Quotenkurs mit `exchange_rate_from` als Basiseinheit; dies allein beweist noch keine vollständig zuordenbare Konversion. [Kraken: Get account log](https://docs.kraken.com/api-reference/account-history/get-account-log).

Die Execution-History enthält eine eigene Ausführungs-UUID, Order-/Account-UUID, Instrument, Zeit, Menge, Preis und `orderData.fee`, aber keine zugehörige Gebührenwährung. Die äußere Event-UID ist nicht die Ausführungs-UUID. [Kraken: Get execution events](https://docs.kraken.com/api-reference/account-history/get-execution-events). Das originale Positionsleg-Beispiel im [WebSocket-Accountlog-Vertrag](https://docs.kraken.com/exchange/api-reference/futures-websocket/account_log) zeigt außerdem, dass ein Positionsleg Funding enthalten kann: Dieses Feld ist keine zweite Cashbuchung.

Lokal geprüft: CCXT **4.5.75**, `ccxt/async_support/krakenfutures.py`, `fetch_ledger`/`parse_ledger`. Der SDK-Pfad filtert Positionslegs aus und rechnet bei der vereinheitlichten Ledgerdarstellung bereits mit Bestandsdifferenz/Gebühr. TSX verwendet weiterhin seinen vorhandenen Originalseiten-Leser, nicht diese verlustbehaftete Vereinheitlichung. Der abgefangene echte SDK-Signing-/Transportpfad wird ausschließlich mit synthetischen Antworten getestet; dies ist ausdrücklich kein Live-Kontobeleg.

## Tatsächlich ausgeführte rote Regressionen

Produktionsdateien wurden für diese erste Vertrags-/Rotphase noch nicht geändert.

1. `tests/test_trading_kraken_cashlegs.js`: temporäre Datenbank, eigener Fill über den bestehenden `persistCorrelatedFill`- und Migration-40-Identitätspfad. Originalgebühr `0.01`, Originalasset `null`. Zwei originale synthetische Logs mit derselben Execution: Position `0 → 1`, USD-Cash `100 → 99.99`, expliziter Preis-PnL und Funding jeweils `0`. Nach dem bestehenden Consumer ist die erwartete Bewertung `-0.01 USD` tatsächlich `null`; Assertion beim erwarteten `valued.reportingAmount` schlägt fehl. Nachgelagerte Sollprüfungen verlangen unverändertes Originalasset/Original-JSON, genau eine Gebührenbuchung, Replay und Neustart.
2. `exchange_executor/tests/test_kraken_cashleg_sources.py`: echter gepinnter SDK-Aufruf, dessen Transport vollständig durch einen lokalen Fake ersetzt ist. Signing/GET/v3-Pfad, unveränderte Filter, exakt **ein** gemeinsamer Budgetaufruf, int64-ID über JavaScript-Safe-Integer und präzise Dezimalstrings sind grün. Der zweite Test ist rot, weil `conversion_spread_percentage = 0.050000000000000001` vor dem Consumer verloren geht. Ein echtes Konversionsfeld darf nicht verschwinden und dadurch eine scheinbar reine native Buchung erzeugen.

Die Dateien sind während der bewussten Rotphase noch nicht im gemeinsamen JS-Runner registriert. Der parallele vollständige Pythonlauf meldete 218 grüne Tests und ausschließlich diese neue rote Konversionsfeld-Regression.

## Enger Implementierungsvertrag zur Abstimmung

### Identität und unveränderte Quellen

- Kein neuer History-Loop, Request oder Calltopf. Namespace, Filterhash, vollständige Originalreceipts, Producerrevision, Restart-/Audit-Fairness und gemeinsames Maximum von fünf zusätzlichen Reads bleiben unverändert.
- Python- und Node-Allowlist erhalten `conversion_spread_percentage` additiv. `conversion_details` wird nicht eingeschaltet; ein vorhandener Prozentwert wird weder multipliziert noch als Cashabzug gebucht.
- Grundlage ist ausschließlich ein bereits als eigener Fill persistierter und nativ bewiesener Kraken-Execution-Datensatz. Kein Log erzeugt Ownership, Fill-ID oder Order-ID. Migration 40, Legacy-Money-ID und bestehende Originalbytes bleiben unangetastet.
- Korrelation über die echte Execution-UUID und gebundene Account-UID/Fingerprint/Generation, Instrument und Wallet. `booking_uid` und Log-`id` bleiben unabhängige Originalidentitäten. Keine Gleichsetzung mit der Execution und keine Paarung anhand benachbarter Zeilen, bloßer Zeitnähe oder gleicher Beträge.
- Crosspage-/Overlap-Suche muss alle gefundenen Vorkommen erhalten. Identische Wiederbeobachtungen sind dieselbe Originalbuchung; andere Inhalte bei gleicher Buchungsidentität oder mehrere unvereinbare Cash-/Positionslegs bleiben Konflikte. Ein späterer Widerspruch darf eine alte positive Bewertung nicht überschreiben oder durch einen alten vollständigen Consumerstatus verdeckt werden.

### Native Geldprüfung

- Erster positiver Vertrag: genau ein konsistentes Positionsleg und ein konsistentes Cashleg, normaler `futures trade`, eigene Ausführung, passender Positionsdelta/Side/Menge/Preis und übereinstimmende originale Gebühr.
- Cashasset und Collateral müssen konkret übereinstimmen; nur ASCII-Groß-/Kleinschreibung wird normalisiert. Keine Stablecoinparität, XBT/BTC-Aliasannahme oder Ableitung der Gebührenwährung aus der Markt-Settlementwährung.
- Explizite Dezimalfelder prüfen exakt: `new_balance - old_balance = realized_pnl + realized_funding - fee`. Fehlende oder `null`-Komponenten werden im ersten positiven Vertrag **nicht** als null Geld interpretiert. Ein partiell beweisbarer Gebührenteil und die Vollständigkeit der gesamten Logbuchung sind getrennte Aussagen; keine pauschale Vollständigkeit aus einer erfolgreichen Gebührenbewertung.
- Zusätzliche unaufgeklärte Konversions-/Liquidationskosten, Kfee, Steuer, anderer Cashasset, abweichende Fee oder mehrdeutige Cashlegs bleiben konkret `unresolved`. Prozentwerte werden nicht zu erfundenen Cashbeträgen.
- Preis-PnL ist nur Gegenprüfung zur bereits aus eigenen Fills abgeleiteten Buchung, nie eine zweite Provider-PnL-Buchung. Bei Entry muss der Preis-PnL explizit null sein; bei Exit/Teilrealisierung muss er zum vorhandenen kanonischen Fill-PnL passen.
- Funding wird ausschließlich am Cashleg unter der **bestehenden** Funding-Provider-ID gebucht. Ein Positionsleg mit demselben Fundingbetrag erzeugt keine weitere Buchung. Andere native Fundingpfade werden nicht verändert.
- Eine native Bewertung ist nur bei exakt demselben Asset wie dem bereits belegten Reportingasset zulässig. Im USD-Fall bedeutet dies USD→USD, nicht USDT/USDC→USD. Die Fee bleibt am ursprünglichen Execution-Ereigniszeitpunkt; originale Buchungszeit und spätere Empfangszeiten werden zusätzlich bewahrt. Hier entsteht kein FX-Zeitfenster und kein nachträglicher Marktkurs.

### Ursprünglicher API-Vorschlag der Rotphase

Der Ledger wird parallel durch den Migration-40-Agenten final geprüft und bleibt bis zu dessen Übergabe unangetastet. Vorgeschlagener neuer enger Eingang:

```ts
valueKrakenCashlegFee({
  eventId,
  cashOccurrence: { receiptId, ordinal },
  positionOccurrence: { receiptId, ordinal },
}): Promise<NativeCashlegValuationResult>
```

Der Eingang akzeptiert **keine** frei gesetzten Assets, Beträge oder Kurse. Er liest Originalreceipts, eigenen Fill, kanonisches Moneyevent und Reportingbindung selbst innerhalb des vorhandenen Transaktionsvertrags. Eine getrennte immutable NativeAssetEvidence bindet Vorkommensreferenzen/Originalhashes, echte Buchungs-/Execution-Identitäten, Einheiten, Originalzeiten und geprüfte Cashzerlegung an `event.id`. Das ursprüngliche `asset=null`, `content_json`, `source` und `provider_event_id` bleiben unverändert. Eine bereits belegte identische native Bewertung wird wiederverwendet, nicht wegen eines anderen Beweispfads künstlich als Konflikt behandelt; tatsächliche widersprüchliche Einheiten/Beträge bleiben dauerhaft sichtbar.

Für indexierte Crosspage-Suche und dauerhaft referenzierte native Beweise ist eine additive Migration sinnvoll. **Noch keine Nummer reserviert, keine Migration angelegt.** Root muss den engen Ledger-Vertrag und eine freie Nummer zunächst bestätigen; Migration 40 gehört dem anderen Agenten. Alternativ wäre ein ausdrücklich beschränkter schemafreier Zwischenvertrag möglich, aber nicht still als vollständiger, beliebig skalierender Replaypfad auszugeben.

## Weitere verbindliche Regressionen für die Umsetzung

- Fee-Rebate mit negativem Provider-Feevorzeichen; exakt eine positive Ledgerwirkung.
- Andere Execution-/Account-UID, falsche Generation, Instrument, Betrag, Seite/Menge oder widersprüchliches bekanntes Gebührenasset: keine positive native Bewertung.
- Fehlendes Cashleg/Positionsleg; über zwei Seiten und Neustart später vervollständigtes Paar; identische Überlappung; widersprüchliche Wiederbeobachtung nach ursprünglichem Erfolg.
- `null` Funding/PnL, nicht erklärter Cashrest, Konversionsprozente, Kfee, Liquidationsgebühr, anderes Asset: Originale bleiben erhalten und Grund bleibt sichtbar; keine Nullannahme.
- Teil-Exit mit geprüftem vorhandenem Fill-PnL und Cashfunding: eine Fee, ein vorhandenes Preis-PnL-Event, nur Cashfunding; zeitgerechter Teil-PnL bei offenem Trade.
- Beweis/Bewertung/Consumer-Übergang crashfest, idempotent und FK-sauber; späte negative Korrektur invalidiert finanzielle Coverage/Risk, ohne Schutzorder/Exit abzuschalten.
- Bestehende Kraken/Bybit/Hyperliquid-Funding-, Accountlog-Budget-, Namespace- und Legacy-Tests unverändert grün; keine Gategrenzen anheben.

## Umgesetzter enger Vertrag nach Root-Freigabe

Root hat den nativen API-Vertrag und Migration **41** nach eigener Quellenprüfung freigegeben. Der Migration-40-Agent hat `db.ts` und den Ledger direkt übergeben. Die oben beschriebene Rotphase ist abgeschlossen; die dort noch offenen Freigaben sind damit erfüllt. Migration 40 und deren kanonische Fill-/Moneyidentitäten wurden nicht verändert.

Produktionsänderungen dieses Teilauftrags:

- `exchange_executor/account_log_sources.py` und `src/trading_account_log_contract.ts`: das dokumentierte `conversion_spread_percentage` bleibt als exakter Originalstring erhalten. Keine Request-/Filter-/Cursoränderung.
- `src/db.ts`: Migration 41 ergänzt `trading_kraken_log_occurrences` und `trading_kraken_cashleg_evidence`. Occurrences verweisen per zusammengesetztem FK auf Originalreceipt/-ordinal. Drei account-/fingerprintgebundene Indizes erlauben Execution-/Booking-/Log-ID-Suche. Eine additive Insert-Verknüpfung und ein verlustfreier Originalbackfill bedienen Neu- und Altbelege. NativeAssetEvidence referenziert genau das bestehende kanonische Moneyevent, den echten Fill und beide Originalvorkommen. Update/Delete der Beweiszeilen sind untersagt; FK-RESTRICT bleibt erhalten.
- `src/trading_kraken_cashleg_contract.ts`: reine Quellen-/Cash-/Einheitenprüfung, keine I/O- oder Geldbewegung. ASCII-Zeichen werden **vor** Großschreibung geprüft; Unicodeähnlichkeiten wie langes `ſ` werden nicht zu USD normalisiert.
- `src/trading_kraken_cashleg_repository.ts`: Originale selbst lesen; echte native Fillidentität, eigene Order, Originalpreis/Fee/Side, Account-Fingerprint/UID, Reportingbindung und Preis-PnL vergleichen. Identische Audit-Wiederholungen verbrauchen nicht das Maximum von 1.000 verschiedenen Originalformen je Korrelationssuche. Überlauf bedeutet konkretes `distinct_original_budget_exhausted`, nie Vollständigkeit. Originalfelder und alle Vorkommen bleiben gespeichert.
- `src/trading_kraken_cashlegs.ts` und enger Hook in `src/trading_account_log_money.ts`: existierende Receipt-Moneyprojektion vervollständigt eigene Kraken-Tradepaare. Keine fremde Ausführung wird übernommen. Der Positionsleg ist nur Beleg; Funding wird allein am Cashleg unter der unveränderten `kraken-account-log:<id>`-Legacy-ID gebucht. Preis-PnL wird nur geprüft, nicht erneut gebucht.
- `src/trading_money_ledger.ts`: die neue `valueKrakenCashlegFee`-API nimmt ausschließlich Event-ID und beide Originalreferenzen an und liefert das bestehende `MoneyEvent`; ungeklärte/konfliktbehaftete Eingaben schlagen fehl. Keine freie Rate/Asset/Betragsangabe. Originalasset `null`, ursprünglicher Betrag, Provider-ID, Source, Event-ID und Original-JSON bleiben unverändert. Vorhandene wirtschaftlich identische Nativebewertungen werden wiederverwendet. `getMoneyEvent` erhält einen vorhandenen Original-Reportingbetrag auch bei Konflikten zur Einsicht, meldet dann aber **valuationStatus='unresolved'**. Der Konflikt ist dauerhaft; korrekt wiederholte Originale heben ihn nicht auf.
- `src/trading_funding_observation.ts`: ein zweiter begrenzter lokaler Projektionspass verarbeitet durch die neue Bewertung erneut vorgemerkte Intents vor Rückgabe derselben finanziellen Beobachtung. Kein zusätzlicher Provideraufruf; Recovery-/Accountlog-/Mode-Fünf-Read-Gesamtbudget und Deadline bleiben unverändert.

### Präzisierte Generationen-/Einheitengrenze

Jedes Receipt ist bereits beim bestehenden atomaren Ingest gegen die damals aktuelle Account-/Credentialbindung geprüft. Bei **unverändertem verifiziertem Account-Fingerprint und derselben originalen Provider-Account-UID** sind identische Originalbuchungen aus zwei unabhängig gebundenen Credentialgenerationen nicht verschiedene Geldereignisse. Beide Receiptgenerationen bleiben als Provenienz erhalten; Generationen allein erzeugen keinen wirtschaftlichen Konflikt und keinen neuen Kurs. Die API prüft weiterhin den aktuellen Account-Fingerprint. Eine echte Fingerprint-/UID-Änderung wird abgewiesen. Dies implementiert **keine neue Schlüssel- oder Kontomigration**.

Native Feeeinheit muss der belegten Reportingwährung exakt entsprechen. Bei explizit null Preis-PnL ist beispielsweise eine originale BTC-Gebühr mit BTC-Reporting bewertbar, ohne USD/BTC zu konvertieren. Ein **nichtnull** Preis-PnL muss zusätzlich die tatsächliche Settlementeinheit des Fill-PnL behalten; anderes Cashasset bleibt `price_pnl_unit_unresolved`.

Der tatsächliche Sidecar normalisiert Provider-Kontraktmenge mit `contractSize` auf Base-Menge. Im vorhandenen Fill-Accountingoriginal wird der Kontraktfaktor noch nicht dauerhaft mitgeführt. Der positive enge Vertrag verlangt daher übereinstimmende native/normalisierte Menge. Bei Ungleichheit wird **contract_quantity_unit_unproven** gemeldet, nicht pauschal eine echte Geldkontradiktion gespeichert. Es wird weder ein Faktor geraten noch Originalprovenienz nachträglich erfunden. Native Preis-/Fee-/Währungswidersprüche bleiben dagegen echte Konflikte. Märkte/Fills, deren Nicht-1-Kontraktfaktor so nicht belegt werden kann, sind nicht durch diesen Teilauftrag freigeschaltet.

### Abschließende lokale Nachweise

Vier neue Dateien sind nach tatsächlicher Grünphase im JS-Runner registriert:

- `tests/test_trading_kraken_cashlegs.js`: ursprüngliche rote USD-Paarung jetzt grün; unverändertes Original, genau eine Fee und Neustart.
- `tests/test_trading_kraken_cashleg_failures.js`: 22 tabellarische Fehlfälle plus direkte API-/Quellbindungen, Unicodeeinheiten, echter Unitkonflikt und widersprüchliche Originalpreis-/Mengen-/Feefelder. Der zusätzliche Originalpreisfall wurde ebenfalls zuerst real rot gezeigt (`raw.price=101`, normalisierter Fillpreis `100`, trotzdem zuvor `-0.01` bewertet), danach kontrolliert behoben. Unbelegter Kontraktfaktor erzeugt ausdrücklich keinen falschen dauerhaften Geldkonflikt.
- `tests/test_trading_kraken_cashleg_replay.js`: Fee-Rebate, gleiche bestehende Nativebewertung aus anderem Pfad, identische native BTC-Einheit, Teilrealisierung bei offenem Trade, einmaliges Cashfunding, Crosspage/Restart/Overlap, gleiche Originale über gebundene Generationen, Legacy-Money-ID, UTC und spätere Widersprüche einschließlich veränderter Execution bei gleicher Booking-ID. Für Teil-Exit ist exakt `Preis-PnL=-10`, `Fees=-0.05`, `Funding=-0.5`, `Gesamt=-10.55` belegt. Der direkte Entry-Riskaufruf scheitert beim echten Konflikt mit `ACCOUNTING_INCOMPLETE`; vorhandene Stopzeile bleibt bytegleich. Ursprüngliche Valuation bleibt auch nach Neustart lesbar, ihr Status ungeklärt.
- `tests/test_trading_kraken_cashleg_migration.js`: tatsächliches 40→41-Upgrade mit belegtem Altbestand, identische Originalbytes, indexierte Suche, Immutable-/FK-RESTRICT-Tests, zweimalige Retention, atomarer Producer-/Bewertungsabbruch, Nested-Transaction und Neustart. Ein absichtlich kollidierender Migrationstisch führt zum Rollback auf Version 40 mit erhaltenen Originalen.

Der abschließende fokussierte JS-Lauf umfasst diese vier sowie `test_trading_money_ledger`, `test_trading_money_migration`, `test_trading_fill_accounting`, `test_trading_fill_identity_migration`, `test_trading_account_log`, `test_trading_account_log_audit`, `test_trading_funding_observation`, `test_trading_funding_risk`, `test_trading_risk_repository`, `test_trading_risk_engine`, `test_trading_risk_reservations`, `test_trading_accounting_gate`, `test_retention_accounting`, `test_trading_analytics`, `test_ccxt_exchange`: **19 Dateien grün** unter Node 22.23.2. Der bestehende Funding-/Risk-Integrationstest belegt auch verzögerte negative native Finanzierung → neue Risikobewertung/Entrydrain bei erhaltenem bestätigtem Stop.

Python 3.12/CCXT 4.5.75: **2 neue Cashleg-SDK-Tests und 13 bestehende Accountlogtests grün**; Ruff der berührten Pythondateien grün. TSC, Architektur (149 Module, 646 interne Imports, 0 Zyklen), unverändertes Complexity-Gate (0 Warnungen, Maximum 15), fokussierter ESLint und Diffcheck grün. Der volle gemeinsame JS-/Python-/Release-Gesamtnachlauf gehört Root; diese Notiz ersetzt dessen revisionsgenaue Gesamtprüfung nicht.

## Status / verbleibende Grenzen

**Enger nativer Cashleg-Teil lokal implementiert und fokussiert verifiziert. Plan 005 bleibt insgesamt offen.** Fehlende Cashkomponenten, zusätzliche unaufgeklärte Gebühren/Steuer/Kfee/Konversionen, fremde Assets ohne identische Reportingeinheit, nicht bewiesener Kontraktfaktor und widersprüchliche Originale bleiben konkret unaufgeklärt. Eine allgemeine Live-FX-/As-of-Route ist nicht implementiert; die Nutzerentscheidung dazu bleibt offen. Keine Providerkonto-/Server-/Appverbindung, kein Trade, Commit oder Deployment. Lokale synthetische USD-Tests sind ausdrücklich keine Provider-/Livefreigabe.
