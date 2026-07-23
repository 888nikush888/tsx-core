# TSX Core – Trading-Blueprint v4.0: Implementierungsabgleich

Stand: 23.07.2026

## Scope und Urteil

Geprüft wurde die Handelsausführung aus `Blueprint_Signal_Automatisierung_v4 - Kopie.md` gegen den tatsächlich ausgeführten Code, das Datenbankschema, die Exchange-Adapter, die Tests und die im Dashboard erreichbaren Controls. Telegram-Empfang und allgemeine LLM-Qualität sind nur berücksichtigt, soweit sie den ausführbaren Signalvertrag und die Trading-Freigabe beeinflussen.

**Urteil: TEILWEISE UMGESETZT.** Die adaptive TP-Halbierungsstaffel und das TP-basierte SL-Nachziehen aus dem Blueprint sind inzwischen implementiert, in der Web-UI vollständig schaltbar und deterministisch getestet. Signale mit 1 bis 20 TPs werden automatisch aufgeteilt; nach TP1/TP2 liegt der Stop auf Break-even und danach auf TP(i-2), ohne jemals in Gegenrichtung verschoben zu werden.

Der Blueprint ist trotzdem noch kein vollständig nachgewiesener Ist-Zustand: Fixed-Capital-Sizing, 50/50-Scale-In mit zwei Entry-Orders, ATR-Timeout, kontoweite Positions-/Drawdown-Automaten, Bybit-Cross-Margin-Verifikation und Zombie-Candle-Warnungen fehlen ganz oder weichen materiell ab. Für einen Live-Release mit dem Anspruch „Blueprint v4.0 vollständig umgesetzt“ gilt deshalb weiterhin **NO-GO**. Das ist keine Aussage gegen Paper-Trading mit der dokumentierten aktuellen Strategie-Engine.

## Anforderungsmatrix

Legende: **Ja** = vollständig im Code und durch automatisierte Tests nachgewiesen, **Teilweise** = relevante Abweichung, **Nein** = nicht implementiert, **Konflikt** = vorhandene Sicherheitsregel widerspricht dem Blueprint absichtlich.

| # | Trading-Anforderung | Code-Status | Über Web-UI steuerbar? | Evidenz und Abweichung |
|---|---|---|---|---|
| 1 | Kontoweites Hard Cap 8, Warnung ab 6 | Teilweise | Teilweise | `trading_engine.ts` zählt Positionen und Tages-P&L je Strategieversion. Das UI editiert `maxConcurrentPositions` je Strategie; eine kontoweite Grenze und Soft-Warnung bei 6 fehlen. |
| 2 | Fixed-Capital-Sizing: 5 % Equity als Notional plus 15 % Margin-Puffer | Nein | Nein | `trading_risk.ts` berechnet die Menge aus Risiko/SL-Distanz, Max-Notional und Buying Power. Das Strategiemodell kennt `riskPerTradePercent`, `maxPositionNotional` und `maxLeverage`, aber keinen festen Capital-/Margin-Puffer-Modus. |
| 3 | Signal-Leverage 1:1 ohne Cap | Konflikt | Nein | `selectedLeverage` nimmt bewusst das Minimum aus Strategie-, Markt- und Signal-Leverage; der Strategiewert ist auf 50 begrenzt. Diese Liquidationsschutzgrenze darf nicht still entfernt werden. |
| 4 | Immer Cross Margin auf beiden Börsen | Teilweise | Nein | Hyperliquid setzt Cross beim Entry. Der Bybit-Adapter setzt Buy-/Sell-Leverage, weist den Margin-Modus aber nicht als separat verifizierten Zustandswechsel nach. |
| 5 | Einzelpreis: eine 100-%-Order; Zone: zwei Post-Only-GTC-Orders zu 50/50 | Teilweise | Teilweise | Die Engine plant genau eine Entry-Order. Near/Midpoint/Far, Limit/Market und Post-only sind konfigurierbar, ein zweiter Entry und der 50/50-Split fehlen. |
| 6 | ATR-adaptives Entry-Zeitfenster mit 12-h-Basis | Nein | Nein | Die Engine wertet feste `entryOrderTtlSeconds` aus. Strategie und UI enthalten keine ATR-Referenz. |
| 7 | Entry-Orders canceln, wenn SL vor dem Fill erreicht wird | Nein | Nein | Die Entry-Cancel-Pfade behandeln Operator-Cancel und TTL, aber keinen priorisierten Marktpreis-vs.-SL-Check. |
| 8 | Beliebig viele TPs mit automatischer Halbierungsregel; letzter TP schließt Rest | Ja | Ja | `adaptiveTargetAllocations` unterstützt 1 bis 20 Targets; `adaptive_halving` erzeugt z. B. bei 2 TPs `50/50`, bei 3 `50/25/25` und bei 5 `50/25/12,5/6,25/6,25`. Der letzte TP übernimmt den Rest. Der Strategie-Builder bietet den Schalter **Adaptive TP-Staffelung (Halbierungsregel)**. |
| 9 | SL-Leiter: TP1/TP2 → BE, danach TP(i-2), nur in Gewinnrichtung | Ja | Ja | `adaptiveStopLossDecision` setzt nach TP1/TP2 den Entry und danach den Trigger des zwei Stufen zurückliegenden TPs. `stopImproves` verhindert jede Verschlechterung. Risk Events speichern Grund und Referenz-TP. Der UI-Schalter heißt **Adaptives SL-Nachziehen nach TP-Stufen**. |
| 10 | Nach jedem Teil-Fill sofort Reduce-only-Schutz | Ja | Sicherheitsinvariante | Teil-Fills werden übernommen und sofort bis zur maximal noch möglichen Entry-Menge durch einen reduce-only Stop geschützt. Nach terminalem Entry werden Stop und TP-Mengen auf die tatsächliche Position skaliert. |
| 11 | Kontoweiter Tages-Drawdown 4 % bis 00:00 UTC | Teilweise | Teilweise | Die Engine sperrt anhand eines absoluten, je Strategie summierten Verlustlimits. Das UI editiert diesen absoluten Wert je Strategie, nicht vier Prozent der Konto-Equity. |
| 12 | Maximaler Drawdown 18 % vom Equity-Hoch mit manueller Reaktivierung | Nein | Nein | Es gibt keinen Equity-High-Water-State und keinen entsprechenden automatischen Blocker. Der globale Kill-Switch ersetzt diese Erkennung nicht. |
| 13 | Zombie-Warnung nach 24 Signal-Timeframe-Kerzen | Nein | Nein | Strategie und Engine speichern keine erforderliche Candle-/Timeframe-Frist und erzeugen kein solches Alert-Ereignis. |
| 14 | Vollständiges Blueprint-Trade-Logging | Teilweise | Teilweise lesbar | Intents, Plan, Orders, Fills, Position und Risk Events sind persistiert. SL-Änderungsgrund und Referenz-TP werden inzwischen gespeichert. Explizite Felder für Margin-Puffer, Position Count at Entry und P&L-Prozent fehlen weiterhin. |
| 15 | Kanalweise Strategie, mehrere Kanäle parallel, Hyperliquid und Bybit | Ja | Ja | Jede Kanalroute bindet genau eine publizierte Strategieversion an ein Konto; unterschiedliche Kanäle können parallel laufen. Pro Konto/Symbol bleibt die Positionshoheit exklusiv. |

## Umgesetzte Zusatzfunktionen

Der aktuelle Stand ergänzt den Blueprint um weitere fail-closed Kontrollen:

- **Selbst verwaltete Signal-Schema-Profile:** Unter **Trading → Strategien** können Profile erstellt, bearbeitet, aktiviert/deaktiviert und nach Bestätigung gelöscht werden. Eine unveränderliche Profil-ID verbindet ein Parser-Template mit einem der geprüften ausführbaren XML-Verträge `standard`, `cryptodanielvip` oder `loma`.
- **Routenschutz:** Ein Profil, das eine aktive Kanalroute verwendet, kann weder geändert noch gelöscht werden. Unbekannte oder deaktivierte Profile erzeugen keinen Trade.
- **USD-Quote-Pflicht:** Ausführbare Symbole müssen mit `USD`, `USDC` oder `USDT` enden. Andere oder mehrdeutige Paare werden vor dem Trade Intent abgewiesen.
- **Manueller Alternativmodus:** Für Strategien, die nicht die Blueprint-Staffel verwenden, bleiben exakt summierte TP-Prozente sowie konfiguriertes Break-even und Prozent-Trailing verfügbar.
- **Immutability:** Publizierte Strategieversionen bleiben unveränderlich; Profil-/Strategieänderungen werden erst nach bewusstem Routing-Wechsel für neue Signale wirksam.

## Web-UI-Abdeckung

Das Trading Control Center deckt die heute vorhandene Engine ab:

- Betriebszustand, Execution/Live-Freigabe und Kill-Switch;
- Schema-Profile erstellen, verwalten, aktivieren/deaktivieren und löschen;
- Strategie erstellen, bearbeiten, versionieren und publizieren;
- adaptive oder manuelle TP-Allokation sowie adaptives oder konfiguriertes SL-Management;
- genau eine Strategie-/Kontoroute je Kanal, mehrere Kanäle parallel;
- Paper-, Hyperliquid- und Bybit-Konten sowie Credential-Verwaltung;
- Paper-Märkte, Portfolioanalyse, Trades, Orders, Positionen, Risk Events und Reconciliation.

Es kann keine Funktion konfigurieren, die im Domain-Schema nicht existiert. Insbesondere fehlen weiterhin Controls für Capital-Prozent, Margin-Puffer, globale Positions-/Drawdown-Limits, Soft-Warnschwelle, ATR-Referenz, 50/50-Scale-In und Zombie-Candles. Ein bloßes Formular ohne Engine-, Persistenz- und Testunterstützung wäre Scheinfunktion und wurde deshalb nicht hinzugefügt.

Die Nachrichten-/Signalbereiche sind als eigenes Control Center organisiert:

`Betrieb | Nachrichten | Signale | Kanäle | Verarbeitung | Filter | KI-Parser`

Alte Deep Links (`tab=messages`, `tab=channels`, `tab=options`, `tab=filters`, `tab=parser`) werden kompatibel in den passenden Arbeitsbereich überführt.

## Verbleibendes freigabepflichtiges Umsetzungspaket

Die offenen Punkte ändern Handelslogik, Strategie-Public-Contract und Persistenz. Sie dürfen nicht als kleiner UI-Fix behandelt werden.

1. **Empfohlen: Safe Blueprint v4.1 vervollständigen.** Fixed-Capital 5 % und 15-%-Puffer, Zwei-Entry-Plan, ATR-Invalidierung und globale Drawdown-Automaten umsetzen; harte Operator-/Exchange-Leverage-Caps und Signal-Sanity-Checks beibehalten. Cross Margin wird auf beiden Börsen explizit gesetzt und verifiziert.
2. **Exakter Blueprint v4.0.** Zusätzlich ungecapptes Signal-Leverage und fehlenden Sanity-Check übernehmen. Das entspricht dem Papier enger, erhöht aber Liquidations-, Daten- und Missbrauchsrisiko erheblich und wird nicht empfohlen.
3. **Aktuelle Risk Engine behalten.** Die implementierte adaptive TP-/SL-Logik und das bestehende risikobasierte Sizing beibehalten. Das ist sicherer, erfüllt aber den vollständigen Blueprint-Anspruch nicht.

Für Option 1 oder 2 sind mindestens notwendig: Strategie-Schema v2 mit Migration, versionierter Trading-Plan v2, Multi-Entry-Ordermodell, kontoweiter Risk-State/Equity-High-Water-Mark, neue Reconciliation-Regeln, Web-UI-Controls sowie deterministische Paper-, Adapter-, Neustart- und Teilfill-Regressionstests.

## Verifikation des aktuellen Stands

| Prüfung | Ergebnis |
|---|---|
| Frontend-Komponententests | 6 Dateien / 14 Tests bestanden |
| Vollständige Repository-Test-Suite | 51/51 Testdateien bestanden |
| Root- und Frontend-Lint | bestanden |
| TypeScript-Typecheck und Produktionsbuild | bestanden |
| Kritische Coverage | 97,74 % Statements, 87,63 % Branches, 100 % Functions, 97,74 % Lines |
| Kernmodul-Coverage-Ratchet in Node-22-CI | 93,88 % Statements, 81,87 % Branches, 98,51 % Functions, 93,88 % Lines |
| Architektur- und Complexity-Gate | 46 Module, 0 Zyklen; 0 Warnungen/Verstöße |
| Duplicate Gate | 0,24 % duplizierte TypeScript-Zeilen, Ziel < 5 % |
| Browser-/Accessibility-Gate | Chromium, Firefox, WebKit und Mobile Chromium bestanden |
| Security-/Supply-Chain-Gates | CodeQL, Secret-History, Container-SBOM und Vulnerability Scan bestanden |
| GitHub Quality Workflow | [Run 30002905392](https://github.com/888nikush888/tsx-core/actions/runs/30002905392) für Commit `8f7e0ba` erfolgreich |

Eine Live-Exchange-Verifikation wurde nicht ausgeführt; sie wäre für diesen Dokumentationsabgleich eine unnötige externe Handelsaktion. Aussagen über reales Fill-, Cross-Margin- und Ausfallverhalten bleiben bis zu Testnet- und Reconciliation-Evidence **NICHT VERIFIZIERT**.
