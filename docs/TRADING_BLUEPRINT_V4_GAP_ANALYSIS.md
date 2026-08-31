# TSX Core – Trading-Blueprint v4.0: Implementierungsabgleich

Stand: 24.08.2026

## Scope und Urteil

Geprüft wurde die Handelsausführung aus `Blueprint_Signal_Automatisierung_v4 - Kopie.md` gegen den tatsächlich ausgeführten Code, das Datenbankschema, die Exchange-Adapter, die Tests und die im Dashboard erreichbaren Controls. Telegram-Empfang und allgemeine LLM-Qualität sind nur berücksichtigt, soweit sie den ausführbaren Signalvertrag und die Trading-Freigabe beeinflussen.

**Urteil: TEILWEISE UMGESETZT.** Die adaptive TP-Halbierungsstaffel und das TP-basierte SL-Nachziehen aus dem Blueprint sind inzwischen implementiert, in der Web-UI vollständig schaltbar und deterministisch getestet. Signale mit 1 bis 20 TPs werden automatisch aufgeteilt; nach TP1/TP2 liegt der Stop auf Break-even und danach auf TP(i-2), ohne jemals in Gegenrichtung verschoben zu werden.

Der Blueprint ist trotzdem noch kein vollständig nachgewiesener Ist-Zustand: 50/50-Scale-In mit zwei Entry-Orders, ATR-Timeout, kontoweite Drawdown-Automaten, Bybit-Cross-Margin-Verifikation und Zombie-Candle-Warnungen fehlen ganz oder weichen materiell ab. ADR 0012 ergänzt CCXT/CCXT Pro, `equity_percent_margin`, kontoweite Positionslimits und visuelle Workflow-Fan-outs; diese Änderungen schließen die übrigen bewusst getrennten Blueprint-Lücken nicht. Für einen Live-Release mit dem Anspruch „Blueprint v4.0 vollständig umgesetzt“ gilt deshalb weiterhin **NO-GO**. Das ist keine Aussage gegen Paper-/Testnet-Trading mit der dokumentierten aktuellen Engine.

## Anforderungsmatrix

Legende: **Ja** = vollständig im Code und durch automatisierte Tests nachgewiesen, **Teilweise** = relevante Abweichung, **Nein** = nicht implementiert, **Konflikt** = vorhandene Sicherheitsregel widerspricht dem Blueprint absichtlich.

| # | Trading-Anforderung | Code-Status | Über Web-UI steuerbar? | Evidenz und Abweichung |
|---|---|---|---|---|
| 1 | Kontoweites Hard Cap 8, Warnung ab 6 | Teilweise | Ja | Das harte Limit ist am konkreten Börsenkonto zwischen 1 und 20 konfigurierbar und zählt alle verwalteten Positionen über Kanäle, Strategien und Workflowpfade. Der Blueprint-spezifische fixe Wert 8 und die separate Soft-Warnung ab 6 sind bewusst nicht vorgegeben. |
| 2 | Fixed-Capital-Sizing: 5 % Equity als Notional plus 15 % Margin-Puffer | Teilweise | Ja | `equity_percent_margin` verwendet den konfigurierten Equity-Anteil als eingesetztes Margin-Kapital und multipliziert ihn mit dem tatsächlich zulässigen Hebel. Ein zusätzlicher 15-%-Margin-Puffer des Blueprints fehlt weiterhin. `equity_percent_notional` und `risk_percent` bleiben separate, explizite Modi. |
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
| 15 | Kanalweise Strategie, mehrere Kanäle parallel, Hyperliquid und Bybit | Ja | Ja | Ein Kanal kann im visuellen Workflow in mehrere vollständige Kontopfade verzweigen. Jeder Zweig besitzt eigenes Konto, Sizing und optional eigenes adaptives Risiko. Mehrere Kanäle und die implementierungsseitig freigegebenen CCXT-Adapter Hyperliquid, Bybit und Kraken Futures können parallel verwendet werden; pro Konto/Symbol bleibt die Positionshoheit exklusiv. Testnet-/Produktionsnachweise bleiben davon getrennte Release-Gates. |

## Umgesetzte Zusatzfunktionen

Der aktuelle Stand ergänzt den Blueprint um weitere fail-closed Kontrollen:

- **Dynamische Signalverträge:** Im Vertragsbaustein können beliebige deklarative Verträge ausgewählt und als neue Version bearbeitet werden. Geometrie und Quelltext-Erdung sind pro Vertrag steuerbar; publizierte Versionen bleiben immutable.
- **Frei verknüpfte Schema-Profile:** Eine unveränderliche Profil-ID verbindet ein Parser-Template mit jeder publizierten Vertragsversion. Die Auslieferungsdatenbank bleibt leer; vorhandene Parser-Primitiven sind ausschließlich Engine-Fähigkeiten und keine vorinstallierten Verträge oder Profile.
- **Routenschutz:** Ein Profil, das eine aktive Kanalroute verwendet, kann weder geändert noch gelöscht werden; eine von einem aktivierten Profil verwendete Vertragsversion kann nicht archiviert werden. Unbekannte oder deaktivierte Profile erzeugen keinen Trade.
- **Symbolrichtlinie:** Jede Strategie legt explizit **alle**, **keine** oder eine Symbol-Allowlist fest. Normalisierte Symbole außerhalb einer Allowlist werden vor dem Trade Intent abgewiesen; bei **alle** bestätigt der Börsenadapter die Marktverfügbarkeit vor einer Order.
- **Dynamisches Kanalrisiko:** `fixed`, `shadow` und `automatic` bewerten geschlossene Trades je Kanal, staffeln Risiko wöchentlich und können schwache Quellen reduzieren oder blockieren. Manuelle Sperre/Stufenfixierung und globale Safety-Gates haben Vorrang.
- **Execution-Telemetrie:** Persistierte Ereignisse messen die Kette von Signalempfang über Exchange-Ack/First Fill bis Positionsschluss und speisen Latenz-/Funnel-Auswertung.
- **Tailnet und Agenten:** Tailscale Serve ermöglicht Remote-Zugriff ohne öffentlichen Port; der standardmäßig mitgestartete, ab Werk logisch deaktivierte MCP-Dienst besitzt gehashte Agenten-Tokens, dauerhafte Rechte, persistente Aktiv-/Standby-/Deaktiviert-Modi, Ereignis-Push und eine auditierte Kontrollbrücke.
- **Manueller Alternativmodus:** Für Strategien, die nicht die Blueprint-Staffel verwenden, bleiben exakt summierte TP-Prozente sowie konfiguriertes Break-even und Prozent-Trailing verfügbar.
- **Immutability:** Publizierte Workflowressourcen, Strategie- und Vertragsversionen bleiben unveränderlich. Auch der konkrete Parser-Prompt liegt in der gehashten Ressourcenrevision; eine separate globale Prompt-Vorlagenverwaltung existiert nicht mehr.

## Web-UI-Abdeckung

Die Web-Oberfläche bildet die heute vorhandene Engine in zwei zusammengehörenden Flächen ab:

- Der visuelle Builder stellt Kanal, Inhalts-/Keyword-/Regex-Filter, Parser samt revisionsfestem Prompt, Schema, Vertrag, Deduplizierung, Strategie, Sizing, adaptives Risiko, Konto und Ausgabe als versionierte Bausteine dar. Verbindungen bilden Wiederverwendung und Fan-out ab.
- **Betrieb** bündelt Live-Gates, kontoweite Positionslimits, Kontosperren, Credential-Verwaltung, Journal, Equity/Drawdown/Kanal-/Börsenanalyse, Logs, Backups, MCP und System-/Tailscale-Konfiguration.
- Paper-, Hyperliquid-, Bybit- und Kraken-Futures-Konten sind modelliert; Exchange-Mutationen laufen über die gepinnte CCXT-Grenze.
- Jede neu ausführbare oder veränderte/entfernte Route verlangt vor atomarer Aktivierung die exakte Wirkungsbestätigung.

Die Oberfläche bietet keine Scheinfunktionen für fachlich nicht implementierte Blueprint-Teile. Es fehlen weiterhin Controls und Domainlogik für den 15-%-Margin-Puffer, eine separate Warnschwelle ab sechs Positionen, ATR-Referenz, 50/50-Scale-In, kontoweite Drawdown-Automaten und Zombie-Candles.

## Verbleibendes freigabepflichtiges Umsetzungspaket

Die offenen Punkte ändern Handelslogik, Strategie-Public-Contract und Persistenz. Sie dürfen nicht als kleiner UI-Fix behandelt werden.

1. **Empfohlen: Safe Blueprint v4.1 vervollständigen.** Den bereits vorhandenen Fixed-Margin-Capital-Modus um 15-%-Puffer, Zwei-Entry-Plan, ATR-Invalidierung und globale Drawdown-Automaten ergänzen; harte Operator-/Exchange-Leverage-Caps und Signal-Sanity-Checks beibehalten. Cross Margin wird auf allen betroffenen Börsen explizit gesetzt und verifiziert.
2. **Exakter Blueprint v4.0.** Zusätzlich ungecapptes Signal-Leverage und fehlenden Sanity-Check übernehmen. Das entspricht dem Papier enger, erhöht aber Liquidations-, Daten- und Missbrauchsrisiko erheblich und wird nicht empfohlen.
3. **Aktuelle Risk Engine behalten.** Die implementierte adaptive TP-/SL-Logik und die getrennten Margin-, Notional- und Stop-Risiko-Sizingmodi beibehalten. Das ist sicherer, erfüllt aber den vollständigen Blueprint-Anspruch nicht.

Für Option 1 oder 2 sind mindestens notwendig: eine neue rückwärtskompatible Strategie-/Plan-Version oberhalb des heutigen Schemas v2, Multi-Entry-Ordermodell, kontoweiter Risk-State/Equity-High-Water-Mark, neue Reconciliation-Regeln, Web-UI-Controls sowie deterministische Paper-, Adapter-, Neustart- und Teilfill-Regressionstests.

## Verifikation des aktuellen Stands

| Prüfung | Ergebnis |
|---|---|
| Frontend-Komponententests | Ergebnis ist dem Release-Gate-Lauf für die exakte Revision zu entnehmen; keine historische Zahl wird als aktuelle Evidenz wiederverwendet. |
| MCP-Protokoll und Kontrollbrücke | Streamable-HTTP-Handshake, Bearer, Rechte, Persistenz, Audit-Brücke, Event-Retry und Wartungsstopp bestanden |
| Vollständige Repository-Test-Suite | siehe aktueller lokaler/CI-Release-Gate-Lauf für exakt diesen Commit |
| Root- und Frontend-Lint | bestanden |
| TypeScript-Typecheck und Produktionsbuild | bestanden |
| Kritische Coverage | Muss für die exakte Revision das unveränderte Repository-Gate erfüllen. |
| Kernmodul-Coverage-Ratchet in Node-22-CI | Muss für die exakte Revision das unveränderte Ratchet erfüllen; eine lokale Verbesserung ändert die Baseline nicht ohne plattformübergreifenden Nachweis. |
| Architektur- und Complexity-Gate | Ausführbare Ratchets; 0 Zyklen und 0 neue Warnungen/Verstöße erforderlich. |
| Duplicate Gate | Ausführbares Ziel < 5 %. |
| Browser-/Accessibility-Gate | Chromium, Firefox, WebKit und Mobile Chromium müssen für die exakte Revision bestehen. |
| Security-/Supply-Chain-Gates | CodeQL/SAST, Secret-History, Dependency-Audits, Container-SBOM und Vulnerability Scan müssen für die exakte Revision bestehen. |
| GitHub Quality Workflow | muss nach Veröffentlichung für den finalen Commit erneut grün sein; frühere Runs sind keine Evidenz für diese Änderung |

Eine Live-Exchange-Verifikation wurde nicht ausgeführt; sie wäre für diesen Dokumentationsabgleich eine unnötige externe Handelsaktion. Aussagen über reales Fill-, Cross-Margin- und Ausfallverhalten bleiben bis zu Testnet- und Reconciliation-Evidence **NICHT VERIFIZIERT**.
