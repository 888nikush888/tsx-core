# Plan 004: Börsenmodus, Entry-Preisgrenze, Leverage-Tiers und Fallback-Laufzeit belegen

> Umsetzungsplan ohne Ausführungserlaubnis für reale Konten. Schritte und Gates vollständig lesen.
> Repo `C:/Users/nikla/Desktop/tsx-core`; Stand `f8089277d0667dd45bcf070037800d423fd89254`, 2026-09-02.
> Drift: `git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src exchange_executor tests docs`. Änderungen aus 001–003 als abgenommene Voraussetzungen abgleichen.

## Status / Voraussetzungen

P1/P2 · Aufwand L · Risiko HOCH · Providerverträge/Risikogrenzen.
Voraussetzungen 001, 002, 003: strikt identifizierte Side Effects, vollständige Evidenz, sichere Entry-/Cancel-/Protection-Lifecycle.
IDs: P1-22, P1-23, P2-01, P2-15.

Ein im UI angezeigtes Maximum muss vor der Ausführung wirken. Ein Check nach schlechtem Fill begrenzt dessen Preis nicht. Gleichzeitig darf eine Entry-Preisgrenze nie stillschweigend die Ausführung eines schützenden Stops verhindern.

## Aktueller Stand / Konventionen

`exchange_executor/ccxt_adapter.py:426`:
```python
value = tiers[0].get("maxLeverage")
```
Der erste Tier ist kein ausreichender Nachweis für große Notional.

`src/trading_engine.ts:903`:
```ts
return now - Number(row.created_at) >= plan.entryOrderTtlSeconds * 1_000;
```
Bei Fallback beginnt die Börsenorderlaufzeit dadurch erneut.

Weitere Belege: `ccxt_adapter.py:343` Verify; `447` Order-Spec; `ccxt_profiles.py` Modus- und Market-Semantik. Hyperliquid hat eine spezielle Slippage-Umsetzung; Bybit/Kraken native_market bisher nicht gleichwertig preisbegrenzt.
Konventionen: `src/trading_risk.ts:68` quantisiert risikobewusst; Decimal-Strings beibehalten. `tests/test_ccxt_exchange.js`: Node assert + HTTP-Fake, keine Exchangeverbindung. ADR 0012: nur Hyperliquid, Bybit, Kraken Futures für den bestehenden Ausführungspfad; Unsupported bleibt blockiert.

## Scope

`exchange_executor/ccxt_adapter.py`, `ccxt_profiles.py`, `ccxt_capabilities.py`, `common.py`, `server.py`; neu `exchange_executor/execution_constraints.py`.
`src/trading_risk.ts`, `trading_types.ts`, `trading_engine.ts`, `ccxt_exchange.ts`, `workflow_repository.ts`, `db.ts`.
`tests/test_trading_core.js`, `test_trading_engine.js`, `test_workflow_fallback.js`, `test_ccxt_exchange.js`, `run_all.js`; `exchange_executor/tests/test_contracts.py`; neu `test_execution_constraints.py`.
`docs/TRADING_GUIDE.md`, `docs/adr/0012-ccxt-visual-workflow-control-plane.md` nur zur Beschreibung der verschärften Verträge.

Nicht ändern: Strategie-/Kanalzuordnungen, gewünschte Margin-Prozente, SL-/TP-Zahlen, normale Limit-/Post-only-Entscheidung, globale Max-Leverage 50, zusätzliche Exchanges, bestehende echte Accountmodi. Kein automatisches Umschalten eines fremden Hedgekontos.

## Befehle / Git

Node 22/npm 10.9, Python 3.12/CCXT 4.5.75:
- `node --import tsx tests/test_trading_core.js`
- `node --import tsx tests/test_workflow_fallback.js`
- `node --import tsx tests/test_ccxt_exchange.js`
- `python -B -m unittest discover -s exchange_executor/tests -v`
- `npm run typecheck`, `npm run lint`, `npm run lint:python`, `npm run quality:architecture`, `npm run quality:complexity`, `npm run test:js`.

Alle Exit 0 nach den betreffenden Schritten. main als langfristiger Branch; keine Commits/Push/Deployments ohne Ausführungsauftrag.

## Schritte

### 1. Tatsächliche Accountfähigkeit nachweisen

Für jedes vorhandene Profil Fähigkeiten getrennt deklarieren: one-way readback, margin-mode readback, leverage set/readback, protected bounded-entry support. Ein Flag allein ist kein Beleg. Verify liest authentifizierten aktuellen Modus mit offiziellen CCXT-/Providerfeldern aus; bei fehlender sicherer Information verified=false mit präzisem Grund.

Cross/One-way nur im expliziten Wartungsprozess ohne Exposure ändern, niemals unbemerkt beim Signal. Bestehender Stop-Schutz wird wegen eines Entry-Verifyfehlers nicht blind entfernt. Ergebnis an Accountfingerprint, Credentialgeneration und geprüfte Provider-/CCXT-Version binden; final vor Entry unter Coordinator veraltete/unpassende Information verwerfen.

**Gate:** test_execution_constraints mit korrektem Modus, Hedge, isolated, fehlendem Readback und Moduswechsel vor Dispatch: nur sicher unterstützter Modus erzeugt Entry; Verify selbst ändert kein reales Konto.

### 2. Harte Entry-Preisgrenze umsetzen

Für marktbasierte Entries Preisobergrenze LONG bzw. Preisuntergrenze SHORT aus dem bereits validierten Referenzpreis und maxSlippagePercent berechnen. Tick-Rundung darf den erlaubten Bereich nicht erweitern. Reguläre Signal-Limit-Orders behalten ihre Entrygrenzen.

Profil verwendet entweder nachweislich nativen Preisdeckel oder preisgebundene IOC-Limit-Entry innerhalb des geschützten Entry+Stop-Pfads. Provider-/CCXT-Parameter pro Profil fest implementieren und testen. Kein stiller Rückfall zu unbeschränktem Market und kein ungeschützter Einzel-Entry, wenn Protected-Batch mit dieser Orderform nicht belegbar ist.

IOC-Teilfüllung folgt dem Lifecycle aus 003; ungefüllter Rest darf nach Ablauf nicht neu „hinterhergejagt“ werden. Preisgrenze gilt **nur Entries**. Protective Stops und ausdrücklich angefordertes Emergency-Reducing erhalten ihre eigene bisherige Ausführungssemantik; ein Entry-Slippage-Limit darf Exit nicht blockieren. Nachträgliche Slippageüberwachung bleibt ergänzend.

**Gate:** Testfälle für adverse Tick, Sprung über Cap, Partial-IOC, fehlende Batchfähigkeit und Providerablehnung. Assert auf tatsächlich an Fake-CCXT übergebene Preise/Parameter; keine fills außerhalb Cap in simuliertem passenden Contract. Realer Providernachweis erst Paket 008.

### 3. Leverage und Menge gemeinsam bestimmen

Verfügbare Tiers vollständig validieren und als Größenbereiche behandeln. Ausgangspunkt bleibt gewünschte **eingesetzte Margin**, nicht Positionsnotional: marginBudget = aktuelle Equity × effektiver Strategie-/Kanalprozentsatz. Notional = marginBudget × erlaubter Hebel; Contractsize/Step in zentralen Decimal-Helfern anwenden.

Hebel begrenzen durch Signal-/Strategiegrenze, Programmmaximum 50 und relevanten Provider-Tier einschließlich bestehender Exposition/Reservierungen im vorgesehenen Tier-Scope. Kandidat vermindert sich monoton; bei kleinerem Tiermaximum Notional/Menge neu berechnen, Tier wieder prüfen. Abbruch nach Zahl der vorhandenen Tiergrenzen plus einem finalen Check; keine Endlosschleife. Fehlender oder widersprüchlicher Tier => Entry blockiert. Nicht die Margin erhöhen, um nach Hebelreduktion alte Notional zu halten.

Geringere verfügbare Margin darf nicht allein durch Leverageanhebung kompensiert werden. Bestehende Kapazitäts-/Budgetprüfungen erneut mit quantisiertem Endplan durchführen.

**Gate:** Größen exakt auf Tiergrenze, große Notional, Tierwechsel nach Rundung, zwei Tiers, fehlende Tiers, abweichende Contractsize, maximale 50x. Margin-Prozent bleibt invariant, resultierende Menge erfüllt Providergrenzen.

### 4. Einen ursprünglichen absoluten Entryablauf verwenden

Im Intent/Plan absolute entryExpiresAt aus ursprünglichem Signal-/Workflow-Run-Zeitpunkt und konfigurierter Entry-TTL persistieren; vorhandenes früheres Signalgültigkeitsende gewinnt. Alle Fallback-Kandidaten erben denselben Ursprung/Deadline. Preflight, Queue-Wartezeit, Restart und cancelExpiredEntries verwenden dieselbe Deadline, nicht created_at einer späteren Order.

Migration nur aus vorhandener belegter Provenienz; unklare alte Deadline nicht verlängern. Abgelaufene nie abgesendete Pläne lokal stoppen; bereits aktive Entries über 003 cancel/drain. Ablauf darf Positionenschutz nicht beenden.

**Gate:** test_workflow_fallback: 90 Prozent TTL vor Promotion verbraucht => nur restliche Zeit nach Submit; Neustart setzt Uhr nicht zurück; abgelaufener Kandidat sendet nichts; Stop einer gefüllten Position bleibt aktiv. Abschlussbefehle alle grün.

## Done / STOP / Wartung

Done: jeder vorhandene Provider hat explizite Contract-Fixtures; keine Entry-Preisgrenze nur post-factum; notional-aware Hebeltest; gemeinsame TTL; aktuelle Strategieparameter unverändert; Scope eingehalten.

STOP: CCXT 4.5.75/Provider unterstützt die geplante geschützte begrenzte Entryform nicht oder Modus ist nicht sicher lesbar. Dann betroffene Fähigkeit als nicht freigegeben kennzeichnen, keine Ersatzbehauptung erfinden. Ebenso STOP bei Scopebedarf, unklarem Legacy-Zeitpunkt oder zweimal fehlschlagendem Gate.

Wartung: Jede Änderung am Provider-/CCXT-Profil invalidiert den bisherigen Abnahmenachweis. Dokumentation zwischen „implementiert“, „mit Fakes geprüft“ und „am Provider belegt“ unterscheiden. Offizielle CCXT-Methodenreferenz/Provider-Dokumentation während Umsetzung erneut mit der festgehaltenen Version abgleichen; kein ungeprüftes Dependency-Upgrade.
