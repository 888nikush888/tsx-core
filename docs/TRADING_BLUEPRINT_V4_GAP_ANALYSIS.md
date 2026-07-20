# Trading-Blueprint v4.0: Implementierungsabgleich

Stand: 20.07.2026

## Scope und Urteil

Geprueft wurde ausschliesslich die Handelsausfuehrung aus
`Blueprint_Signal_Automatisierung_v4 - Kopie.md`, nicht Telegram-Empfang oder
Signal-Parsing. Massgeblich waren der ausgefuehrte Code, Datenbankschema,
Exchange-Adapter, Tests und die im Dashboard erreichbaren Controls.

**Urteil: TEILWEISE UMGESETZT.** Die bestehende Engine hat eine belastbare
fail-closed Basis mit Strategieversionen, kanalweisem Routing, Paper/Testnet/Live,
Kill-Switch, Reconciliation und unmittelbarem Schutz teilgefüllter Positionen.
Der Blueprint ist dennoch kein nachgewiesener Ist-Zustand: Fixed-Capital-Sizing,
50/50-Scale-In, ATR-Timeout, die adaptive TP/SL-Staffel und kontoweite
Drawdown-Sperren fehlen ganz oder weichen materiell ab. Diese fehlenden
Mechanismen sind folglich auch nicht im Web-UI steuerbar.

Fuer einen Live-Release mit dem Anspruch "Blueprint v4.0 umgesetzt" gilt daher
**NO-GO**. Das ist keine Aussage gegen Paper-Trading mit der aktuell
dokumentierten Strategie-Engine.

## Anforderungsmatrix

Legende: **Ja** = vollstaendig nachgewiesen, **Teilweise** = relevante
Abweichung, **Nein** = nicht implementiert, **Konflikt** = vorhandene
Sicherheitsregel widerspricht dem Blueprint absichtlich.

| # | Trading-Anforderung | Code-Status | Ueber Web-UI steuerbar? | Evidenz und Abweichung |
|---|---|---|---|---|
| 1 | Kontoweites Hard Cap 8, Warnung ab 6 | Teilweise | Teilweise | `src/trading_engine.ts:121-149` zaehlt Positionen und Tages-P&L je `strategy_version_id`, nicht kontoweit. Das UI editiert nur `maxConcurrentPositions` je Strategie (`frontend/src/app/dashboard/components/trading-tab.tsx:160`). Eine Soft-Warnung bei 6 fehlt. |
| 2 | Fixed-Capital-Sizing: 5 % Equity als Notional plus 15 % Margin-Puffer | Nein | Nein | `src/trading_risk.ts:174-205` berechnet die Menge aus Risiko/SL-Distanz, Max-Notional und Buying Power. Das Schema kennt nur `riskPerTradePercent`, `maxPositionNotional` und `maxLeverage` (`src/trading_strategy.ts:99-106`). |
| 3 | Signal-Leverage 1:1 ohne Cap | Konflikt | Nein | `src/trading_risk.ts:68-70` nimmt bewusst das Minimum aus Strategie-, Markt- und Signal-Leverage; `src/trading_strategy.ts:105` begrenzt das Strategie-Cap auf 50. Das ist sicherer als der Blueprint und darf nicht unbemerkt entfernt werden. |
| 4 | Immer Cross Margin auf beiden Boersen | Teilweise | Nein | Hyperliquid erzwingt Cross beim Entry (`exchange_executor/hyperliquid_adapter.py:78-81`). Bybit setzt nur Buy-/Sell-Leverage (`exchange_executor/bybit_adapter.py:61-70`); ein nachgewiesener Margin-Mode-Wechsel fehlt. |
| 5 | Einzelpreis: eine 100-%-Order; Zone: zwei Post-Only-GTC-Orders zu 50/50 | Teilweise | Teilweise | `src/trading_risk.ts:114-161` plant genau eine Entry-Order. Near/Midpoint/Far, Limit/Market und Post-Only sind konfigurierbar (`src/trading_strategy.ts:84-96`), aber ein zweiter Entry und der 50/50-Split existieren nicht. |
| 6 | ATR-adaptives Entry-Zeitfenster mit 12-h-Basis | Nein | Nein | `src/trading_engine.ts:418-439` wertet ausschliesslich `entryOrderTtlSeconds` aus; `src/trading_risk.ts:205-206` speichert feste Sekunden. Das UI bietet entsprechend nur eine feste Entry-TTL (`trading-tab.tsx:160`). |
| 7 | Entry-Orders canceln, wenn SL vor dem Fill erreicht wird | Nein | Nein | Die Entry-Cancel-Pfade in `src/trading_engine.ts:399-439` behandeln Operator-Cancel und TTL, aber keinen Marktpreis-vs.-SL-Priority-Check. |
| 8 | Beliebig viele TPs mit automatischer Halbierungsregel; letzter TP schliesst Rest | Teilweise | Teilweise | Der letzte Restschluss ist als Invariante erzwungen (`src/trading_strategy.ts:128-139`). Anzahl und Allokationen muessen jedoch manuell zur Signalanzahl passen (`src/trading_risk.ts:41-56`, `src/trading_strategy.ts:115-127`) und werden im UI als Prozentliste editiert (`trading-tab.tsx:159`). |
| 9 | SL-Leiter: TP1/TP2 -> BE, danach TP(i-2), nur in Gewinnrichtung | Nein | Nein | `src/trading_engine.ts:332-366` kennt einen konfigurierbaren BE-Schwellwert und optionales Prozent-Trailing, aber keine Referenz auf TP(i-2). |
| 10 | Nach jedem Teil-Fill sofort Reduce-Only-Schutz | Ja | Sicherheitsinvariante | `src/trading_engine.ts:255-288` uebernimmt Teil-Fills und passt Exit-Mengen an; `src/trading_engine.ts:554-558` ruft fuer Teil-Fills sofort `ensureExitProtection` auf. Stop-Orders werden Reduce-Only geplant (`src/trading_risk.ts:142-152`). |
| 11 | Kontoweiter Tages-Drawdown 4 % bis 00:00 UTC | Teilweise | Teilweise | `src/trading_engine.ts:112-149` sperrt anhand eines absoluten, je Strategie summierten Verlustlimits. Das UI editiert diesen absoluten Wert je Strategie (`trading-tab.tsx:160`), nicht vier Prozent des Kontos. |
| 12 | Maximaler Drawdown 18 % vom Equity-Hoch mit manueller Reaktivierung | Nein | Nein | In Trading-Schema und Engine gibt es keinen Equity-High-Water-State und keinen entsprechenden Blocker. Der globale Kill-Switch ersetzt die automatische 18-%-Erkennung nicht. |
| 13 | Zombie-Warnung nach 24 Signal-Timeframe-Kerzen | Nein | Nein | Weder Strategie-Schema noch Engine speichern die erforderliche Candle-/Timeframe-Frist oder erzeugen dieses Alert-Ereignis. |
| 14 | Vollstaendiges Blueprint-Trade-Logging | Teilweise | Teilweise lesbar | Intents, Plan, Orders, Fills, Position und Risk Events sind persistiert (`src/db.ts:227-305`). Explizite Felder bzw. Events fuer Margin-Puffer, Position Count at Entry, Entry-Modus, SL-Aenderungsgrund/Referenz-TP und P&L-Prozent fehlen. |
| 15 | Kanalweise Strategie, mehrere Kanaele parallel, Hyperliquid und Bybit | Ja | Ja | `src/db.ts:211-217` bindet je Kanal genau eine Strategieversion und ein Konto; unterschiedliche Kanaele koennen unterschiedliche Routen haben. Intents erlauben Paper, Hyperliquid und Bybit (`src/db.ts:227-244`); Verwaltung und Betrieb liegen im Trading Control Center. |

## Web-UI-Abdeckung

Das Trading Control Center deckt die **heute vorhandene** Engine ab:

- Betriebszustand, Execution/Live-Freigabe und Kill-Switch
- Strategie erstellen, bearbeiten, versionieren und publizieren
- genau eine Strategie-/Kontoroute je Kanal; mehrere Kanaele parallel
- Paper-, Hyperliquid- und Bybit-Konten sowie Credential-Verwaltung
- Paper-Maerkte, Trades, Orders, Positionen, Risk Events und Reconciliation

Es kann keine Funktion konfigurieren, die im Domain-Schema nicht existiert.
Insbesondere fehlen Controls fuer Capital-Prozent, Margin-Puffer, globale
Positions-/Drawdown-Limits, Soft-Warnschwelle, ATR-Referenz, 50/50-Scale-In,
TP-Halbierungsmodus, TP-basierte SL-Leiter und Zombie-Candles. Ein blosses
Formular ohne Engine-, Persistenz- und Testunterstuetzung waere Scheinfunktion
und wurde deshalb nicht hinzugefuegt.

## Bereits umgesetzte UI-Organisation

Alle Nachrichten-/Signalbereiche sind jetzt wie der Trading-Tab als ein
Control Center mit internen Arbeitsbereichen organisiert:

`Betrieb | Nachrichten | Signale | Kanaele | Verarbeitung | Filter | KI-Parser`

Die bestehende Sidebar enthaelt nur noch einen Einstieg "Signale & Nachrichten".
Alte Deep Links (`tab=messages`, `tab=channels`, `tab=options`, `tab=filters`,
`tab=parser`) werden kompatibel in den passenden Arbeitsbereich ueberfuehrt.
Die Konfigurations-Arbeitsbereiche behalten ihre Speichern-Aktion.

Evidenz:

- `frontend/src/app/dashboard/components/signal-center-tab.tsx:13-25,76-119`
- `frontend/src/app/dashboard/page.tsx:34-80,300-324`
- `frontend/src/components/app-sidebar.tsx:28-54`
- `frontend/src/components/command-search.tsx:119-131`
- `frontend/tests/signal-center-tab.test.tsx`

## Freigabepflichtiges Umsetzungspaket fuer den Blueprint

Die folgenden Punkte aendern Handelslogik, Strategie-Public-Contract und
Persistenz. Sie duerfen nicht als kleiner UI-Fix behandelt werden.

1. **Empfohlen: Safe Blueprint v4.1.** Fixed-Capital 5 % und 15-%-Puffer,
   Zwei-Entry-Plan, ATR-Invalidierung, automatische TP/SL-Leiter und globale
   Drawdown-Automaten umsetzen; dabei harte Operator-/Exchange-Leverage-Caps
   und Signal-Sanity-Checks beibehalten. Cross Margin wird auf beiden Boersen
   explizit gesetzt und verifiziert. Hoechster Sicherheitsgrad, aber bewusst
   nicht wortgleich mit den riskanten Blueprint-Punkten "kein Cap/kein Check".
2. **Exakter Blueprint v4.0.** Auch ungecapptes Signal-Leverage und fehlenden
   Sanity-Check uebernehmen. Geringere Abweichung vom Dokument, aber wesentlich
   hoeheres Liquidations-, Daten- und Missbrauchsrisiko; nicht empfohlen.
3. **Aktuelle Risk Engine behalten.** Nur UI-Organisation und Dokumentation
   ausliefern. Geringster Umbau, erfuellt aber den Blueprint-Anspruch nicht.

Fuer Option 1 oder 2 sind mindestens notwendig: Strategie-Schema v2 mit
Migration, versionierter Trading-Plan v2, Multi-Entry-Ordermodell,
kontoweiter Risk-State/Equity-High-Water-Mark, neue Reconciliation-Regeln,
Web-UI-Controls sowie deterministische Paper-, Adapter-, Neustart- und
Teilfill-Regressionstests.

## Verifikation dieser Aenderung

| Pruefung | Ergebnis |
|---|---|
| Frontend-Komponententests | 5/5 bestanden |
| Vollstaendige Repository-Test-Suite | 47/47 Testdateien bestanden |
| Frontend-Lint | bestanden |
| Root-Lint | bestanden |
| TypeScript-Typecheck | bestanden |
| Frontend-Produktionsbuild | bestanden |
| Statische Frontend-Behavior-/Reachability-Tests | 2/2 Dateien bestanden |
| Isolierter Browser-Smoke-Test | Control-Center, Workspace-URL, Save-Control und Legacy-Parser-Link verifiziert |
| Kritische Coverage | 98,59 % Statements, 85,95 % Branches, 100 % Functions |
| Complexity Gate | 0 Verstoesse; Cyclomatic Complexity Durchschnitt/Maximum 3,41/15 |
| Duplicate Gate | 0,46 % duplizierte TypeScript-Zeilen, Ziel < 5 % |

Eine Live-Exchange-Verifikation wurde nicht ausgefuehrt; sie waere fuer diesen
UI-/Audit-Auftrag eine unnoetige externe Handelsaktion. Aussagen ueber reales
Fill-, Cross-Margin- und Ausfallverhalten bleiben bis zu Testnet- und
Reconciliation-Evidence **NICHT VERIFIZIERT**.
