# Plan 005: Gebühren, Funding, PnL und Risikoreserven in einem Ledger zusammenführen

> Plan, keine Änderung von Konten oder Strategieparametern. Schritte und Prüfgates vollständig befolgen.
> Repo `C:/Users/nikla/Desktop/tsx-core`, Commit `f8089277d0667dd45bcf070037800d423fd89254`, Datum 2026-09-02.
> Drift: `git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src exchange_executor tests docs`; freigegebene Vorgängeränderungen ausdrücklich abgleichen.

## Status / Voraussetzungen

P1/P2 · Aufwand L · Risiko HOCH · Finanzielle Korrektheit.
Voraussetzungen 001–004: monotone Identitäten/Fills, vollständige Evidenz, korrekter Lifecycle und endgültiger quantisierter Entryplan.
IDs: P1-24, P2-02, P2-03, P2-04, P2-05.

Geldwerte verschiedener Währungen dürfen nicht addiert werden. Kosten müssen zum Ereigniszeitpunkt und genau einmal wirken, auch wenn ein Trade noch offen ist. Reserven müssen tatsächliche Fills und noch mögliche Entry-Fills widerspiegeln.

## Aktueller Stand und Konventionen

`src/trading_engine.ts:400–415` berechnet PnL aus Fills, berücksichtigt feeAsset dabei nicht und negiert Gebühren mittels dieses Ausdrucks:
```ts
`-${fill.fee}`
```
Eine negative Gebühr führt so zu ungültigem doppeltem Minus.

`src/trading_engine.ts:295` reserviert plan.riskAmount; `377` kombiniert Closed-PnL, Remote-Unrealized, Funding und diese Planreserve.
`exchange_executor/ccxt_adapter.py:388` behandelt bestimmte Funding-History-Fehler als "0".
`src/trading_decimal.ts` enthält String-Decimal-Helfer; diese erweitern statt Number-/Floatgeldarithmetik einzuführen. Tests im Muster `tests/test_trading_core.js` mit assert und isolierter DB.

**Beabsichtigt:** Daily-Loss-Grenze pro Konto als konfigurierter Prozentsatz der aktuellen Equity. Margin-Prozent bleibt eingesetztes Kapital, Hebel bestimmt Notional. Signal-SL bleibt Ausgangspunkt, adaptive Stopverschiebung darf ihn nicht lockern. Keine Änderung dieser Nutzerentscheidungen.

## Scope

`src/trading_engine.ts`, `trading_risk.ts`, `trading_decimal.ts`, `trading_repository.ts`, `trading_types.ts`, `ccxt_exchange.ts`, `db.ts`; neue `src/trading_money_ledger.ts`, `src/trading_risk_reservations.ts`.
`exchange_executor/ccxt_adapter.py`, `ccxt_profiles.py`, `server.py`, `common.py`; neue `exchange_executor/accounting_evidence.py`.
Tests `tests/test_trading_core.js`, `test_trading_engine.js`, `test_trading_analytics.js`, `test_ccxt_exchange.js`, `run_all.js`; neu `tests/test_trading_money_ledger.js`; Python `exchange_executor/tests/test_contracts.py`.
`docs/TRADING_GUIDE.md` für eindeutige Definitionen.

Nicht ändern: aktuelle Prozentsätze, Maxpositionen, Kontokonfiguration, bestehende Signalpreise, Broker-/Geldbewegungen, pauschale 1:1-Währungsannahmen, neue UI. Kein automatisches Löschen alter Buchungen.

## Befehle / Git

Node 22/npm 10.9, Python 3.12/CCXT 4.5.75:
- `node --import tsx tests/test_trading_money_ledger.js`
- `node --import tsx tests/test_trading_core.js`
- `node --import tsx tests/test_trading_engine.js`
- `node --import tsx tests/test_trading_analytics.js`
- `python -B -m unittest discover -s exchange_executor/tests -v`
- `npm run typecheck`, `npm run lint`, `npm run lint:python`, `npm run quality:architecture`, `npm run quality:complexity`, `npm run test:js`.

Erwartet Exit 0; neue Tests in run_all. Langfristig main; keine Push-/Commit-/Rollout-Erlaubnis durch dieses Dokument.

## Schritte

### 1. Vorzeichen und Herkunft der Beträge spezifizieren

Signed-Decimal-Negation/Subtraktion in trading_decimal zentral verwenden. Gebührenbetrag >0 = Kosten, <0 = Rebate; im Ledger signierter Cashflow = Negation der Gebühr. Funding als signierter Cashflow normalisieren und Quelle/Dedupe-ID speichern. Fehlende feeAsset bei Nichtnullgebühr bedeutet Bewertung unbekannt; bei Nullgebühr ist keine Umrechnung nötig.

Ledgerbuchung besitzt Account, Ereignis-ID, Typ, Eventzeit UTC, Originalbetrag/-asset, Reportingbetrag/-currency, Bewertungsquelle/-zeit und Status valued/unresolved. Unique-Key je Account/Providerereignis/Buchungsart. Provider-Realized-PnL und aus Fills berechneten PnL nicht doppelt buchen.

**Gate:** test_trading_money_ledger: positive Fee, negative Fee, -0, Fundingzu-/abfluss, wiederholte Event-ID, widersprüchlicher Inhalt. Exakte Decimalwerte, keine doppelten Buchungen.

### 2. Bewertungs- und Vollständigkeitsvertrag ergänzen

Reportingwährung aus verifizierten Account-/Settlement-Metadaten festlegen und mit der Kontobindung persistieren. Für andere Assets belastbare Umrechnung zum Buchungszeitpunkt dokumentieren; nur feste profilgebundene unterstützte Bewertungswege, keine dynamische beliebige Tickersuche. USD/USDT/USDC nicht pauschal als identisch behandeln. Fehlender Kurs => unresolved; Schutz bestehender Positionen weiter, neue Entries im betroffenen Konto gesperrt.

Funding-History-Fehler nicht nullen. Rückgabe beinhaltet vollständiges Zeitfenster, Cursor, source und status. Unsupported ist nur dann nachweislich 0, wenn der konkrete Markt/Account kein Funding haben kann, nicht weil ein Request BadRequest liefert. Nachlade- und Deadline-Regeln von Paket 002 benutzen.

**Gate:** Python + Ledger-Tests: Fremdassetfee, fehlende Bewertung, späterer Kursnachtrag, Funding BadRequest/InvalidOrder/Timeout. Entry-Gate blockiert incomplete, bestehender Stop wird nicht entfernt.

### 3. Daily-Loss auf eindeutigen Kontogrößen aufbauen

Ein gemeinsamer Snapshot liefert Ledger-Completeness, heutige realisierte Preis-PnL nach tatsächlichem Ausführungszeitpunkt, heutige signierte Fees/Rebates/Funding sowie aktuelle offene Unrealized-PnL. Die bestehende konservative Semantik mit **aktueller** Unrealized-PnL beibehalten, nicht ungefragt auf Tagesdelta umstellen. Teilverkäufe werden am Filltag gebucht, nicht erst beim Gesamtabschluss. Verifizierter Providervertrag muss klarstellen, ob Unrealized Gebühren/Funding schon enthält; sonst keine doppelte Berücksichtigung.

Definierte Größen in Kontoreportingwährung:
- budget = aktuelle Equity × konfigurierte maxDailyLoss-Prozent / 100.
- dayPnl = realisierte Preis-PnL heute + signierte Fees/Rebates heute + Funding heute + aktuelle Unrealized-PnL.
- verbrauchter Verlust = max(0, -dayPnl).
- zusätzliche Verpflichtung = Verlust bis zum Stop für **verbleibende unbefüllte Entries** plus zusätzlicher Verlust von **aktuellem Mark bis Stop** für bereits offene eigene Menge.
- Zulassung nur, wenn verbrauchter Verlust + zusätzliche Verpflichtung + neue Kandidatenverpflichtung innerhalb budget liegt und Margin-/Kapazitätsgates ebenfalls bestehen.

Kein Doppelzählen von bereits im Unrealized enthaltenem Verlust durch erneutes Addieren der gesamten Entry-zu-SL-Distanz. Actual-Fill-zu-SL-Risiko zusätzlich als erklärbare Kennzahl berechnen, aber nicht nochmals auf dieselbe Budgetsumme schlagen. Gewünschte Prozentwerte unverändert lassen.

**Gate:** Verlusttrade noch offen, heutige Teilverkäufe aus gestrigem Entry, Rebate, Funding, Markbewegung, Stop im Gewinn, Konto ohne Trades, Datumssprung UTC. Beispieltabelle mit exakten Sollwerten in Test festschreiben; Engine und Analytics lesen denselben Datenstand.

### 4. Reservierungen dynamisch und idempotent fortschreiben

Reservation je Intent/Entrygeneration mit pendingquantity, ownedquantity, Stop, Referenz-/Markpreis, Kostenstatus, Ledger-/Evidencegeneration. Bei Fill, Cancel, Stopnachzug, Abschluss und Restart unter Coordinator aktualisieren. Ursprünglicher Plan bleibt unverändert als Auditspur; neue Reserve ist abgeleiteter aktueller Zustand.

Schlechter Fill kann verbleibendes Budget überschreiten: Neueinstiege sofort sperren, offene Entry-Reste über sicheren Cancelpfad begrenzen und geschützte bestehende Position nach bestehender Risikoregel behandeln. Keine automatische Stoplockerung und keine unautorisierte pauschale Liquidation. Jede reale Aktion folgt 003, nicht einer zweiten Ledger-eigenen Tradingengine.

**Gate:** partielle/negative Slippage, Cancel mit Late-Fill, SL-Nachzug, Restart und wiederholter Fill. Exakte Reserve, keine doppelten Summen, keine freigegebene Reserve solange Entry unklar.

### 5. Altbestand ohne erfundene Historie migrieren

Buchungen deterministisch aus vorhandenen belegten Fills und Fundingdaten backfillen. Keine Behauptung kompletter historischer Gebührenbewertung, wenn Originalasset/Kurs fehlen. Solche Bereiche explizit incomplete markieren; manuelle Aufklärung statt synthetischer Nullbeträge. Backfill wiederholbar mit gleicher ID und kanonischem Inhaltsvergleich.

Daily-Risk, Position-/Intent-PnL und Analytics auf denselben Ledger umstellen. Alte Berechnung erst entfernen, wenn alle aktuellen Consumer migriert und Tests auf Parität für vollständig belegte Standardfälle grün sind.

**Gate:** Migration zweimal, alte negative Fee, fehlendes Asset, vorhandene Fundingbuchung, Tagesgrenze und großer Datenbestand. Alle Schlussbefehle Exit 0; keine außerhalb Scope geänderten Strategieparameter.

## Done / STOP / Wartung

Done: signed Fees funktionieren; keine währungsfremde Addition; Funding unknown bleibt unknown; tatsächliche Fills/Entryreste bestimmen Reserve; Ledger genau einmal; vollständige Testmatrix und Migrationsnachweis; Index aktualisiert.

STOP: Reportingwährung/Provider-PnL-Semantik nicht belegbar; notwendiger Kurs fehlt; Legacy-Daten nicht rekonstruierbar; Lösung würde echte Historie erfinden oder Schutz lockern; Scopeüberschreitung bzw. zweimal fehlgeschlagenes Gate. Konkrete Einschränkung ausweisen statt Default 0.

Wartung: Neue Fee-Assets, inverse Kontrakte oder Quanto-Märkte sind neue Accountingfähigkeiten und dürfen nicht durch generische Casts freigeschaltet werden. Bestehende unterstützte lineare Märkte zuerst korrekt halten.
