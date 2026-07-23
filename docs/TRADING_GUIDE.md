# Trading: vollständige Einrichtung und Nutzung

## Sicherheitsmodell in einem Satz

Jeder Telegram-Kanal pinnt eine immutable Strategieversion und ein verifiziertes Exchange-Konto; jeder Trade ist idempotent, exakt dezimal geplant, durch reduce-only TP/SL verwaltet und wird bei Unklarheit global fail-closed gestoppt.

## 1. Docker starten

```bash
docker compose up --build -d
docker compose ps
```

Öffne `http://127.0.0.1:8080`. Der lokale Standard veröffentlicht nur Host-Loopback und integriert die Admin-Session automatisch. Das interne `exchange-executor`-Sidecar besitzt keinen Host-Port. Für externe/mehrbenutzerfähige Enterprise-Nutzung zuerst OIDC und einen TLS-Reverse-Proxy gemäß `PRODUCTION_GUIDE.md` aktivieren.

## 2. Immer zuerst Paper

1. **Trading → Paper-Märkte** öffnen.
2. `paper-default`, Equity und Available Balance setzen.
3. Für jedes erwartete Symbol Mark Price, Price Tick, Quantity Step, Minimum Quantity, Minimum Notional und Max Leverage aus realistischen Testdaten setzen.
4. Speichern. Eine Mark-Price-Änderung wertet offene Paper-Orders deterministisch aus und erzeugt Fills.

Paper ist kein Profitabilitätsnachweis: Latenz, Orderbuch, Funding, Liquidation, Teilausführungsdynamik und reale Gebühren sind nur begrenzt abgebildet. Es beweist Zustandsmaschine, Sizing, TP/SL und Recovery, nicht Marktperformance.

## 3. Strategie/Plugin erstellen

Unter **Trading → Strategien**:

- **Signal-Schema-Profile:** Profile direkt im oberen Verwaltungsbereich anlegen, bearbeiten, aktivieren/deaktivieren oder nach expliziter Bestätigung löschen. Jedes Profil besitzt eine unveränderliche Kennung, einen Anzeigenamen, ein Parser-Template und einen geprüften ausführbaren XML-Vertrag (`standard`, `cryptodanielvip` oder `loma`).
- **Signalvertrag:** erlaubte XML-Schemas, Symbole (leer = jedes normalisierte Symbol) und LONG/SHORT.
- **Entry:** Market oder Limit, Preiswahl innerhalb der Signal-Range, Post-only und Timeout.
- **Sizing:** Risiko pro Trade in Prozent der Equity, maximales Positionsnotional und maximaler Hebel. Signalhebel und Exchange-Maximum können nur weiter begrenzen.
- **Exits:** Prozent je Signal-Target; die Summe muss exakt 100 sein und der letzte TP schließt den vollständigen Rest. Optional Break-even nach TP n und ein Trailing-Prozent, das den Stop nur in Gewinnrichtung verschiebt. Protective Stop ist immer zwingend.
- **Safety:** maximale gleichzeitige Positionen je Strategieversion, absoluter maximaler UTC-Tagesverlust, Slippage-Grenze und Entry-TTL.

**Entwurf speichern** validiert alle Grenzen. **Publizieren** macht die Version immutable und routingfähig. Für Änderungen die publizierte Version auswählen und **Neue Version** erstellen. Bestehende Trades behalten die alte Version; neue Signale nutzen erst nach explizitem Routing-Wechsel die neue.

Nur aktive Schema-Profile können in neuen Strategien verwendet werden. Ein Profil, das eine aktivierte Kanalroute verwendet, kann weder verändert noch gelöscht werden. Ein unbekanntes, deaktiviertes oder gelöschtes Profil bleibt zur Laufzeit fail-closed und erzeugt keinen ausführbaren Trade.

**Strategie löschen** entfernt eine unbenutzte Version nach einer expliziten Bestätigung endgültig. Eine Kanalroute muss vorher unter **Kanal-Routing** entfernt werden; Versionen mit aufbewahrter Trade-Historie können aus Audit- und Recovery-Gründen nur archiviert, nicht gelöscht werden. Die letzte verbleibende Strategieversion ist nicht löschbar – zuerst eine Ersatzstrategie erstellen.

Ein Plugin ist bewusst deklarativ. Die UI nimmt keinen ausführbaren Python-/JavaScript-Code an. Dadurch bleiben Rechte, Determinismus, Review, Rollback und Containerhärtung erhalten. Ein völlig neuer Algorithmus benötigt eine geprüfte Engine-/Schema-Version im Repository.

## 4. Exchange-Konto verbinden

### Hyperliquid

1. Auf Hyperliquid ein dediziertes API Wallet für das ausschließlich von diesem System verwendete Konto/Subkonto erzeugen.
2. Unter **Trading → Börsenkonten** `hyperliquid`, `testnet` oder `live`, API-Wallet Private Key und Master-Wallet-Adresse eingeben.
3. **Konto anlegen & prüfen**. Das offizielle `hyperliquid-python-sdk` liest Equity und bestätigt den Vertrag.

### Bybit

1. Einen separaten Bybit API Key mit ausschließlich benötigten Unified-Trading-/Futures-Rechten erzeugen. Keine Withdrawal-/Transfer-Rechte vergeben; IP-Allowlisting verwenden, sobald die Deployment-IP stabil ist.
2. `bybit`, `testnet` oder `live`, API Key und API Secret eingeben.
3. **Konto anlegen & prüfen**. Das offizielle `pybit` SDK validiert das Konto.

Secrets werden atomar als Modus `0600` im Secret-Volume gespeichert, nur read-only in den Executor gemountet und nie an Browser/API zurückgegeben. **Keys ersetzen** deaktiviert das Konto, überschreibt die Secret-Datei und verifiziert erneut. Löschen wird verweigert, solange Route, Historie, Order oder Position besteht.

## 5. Mehrere Kanäle parallel routen

Unter **Trading → Kanal-Routing** für jeden Quellkanal auswählen:

```text
Kanal A → Strategie Alpha v3 → Hyperliquid Testnet
Kanal B → Strategie Beta v1  → Bybit Testnet
Kanal C → Strategie Gamma v7 → Hyperliquid Live
```

Eine Kanal-ID besitzt genau eine Route. Beliebig viele unterschiedliche Kanäle können parallel laufen. Eine aktive Position besitzt jedoch exklusiv `(account, symbol)`: Zwei Strategien dürfen auf demselben Konto nicht gleichzeitig dieselbe Coin-Position steuern. Für getrennte gleichzeitige BTC-Strategien separate Exchange-Subkonten verwenden.

## 6. Ausführung aktivieren

Unter **Trading → Betrieb**:

1. **Jetzt reconciliieren**. Konten, lokale Orders/Fills/Positionen und Remote-State müssen übereinstimmen.
2. **Automatische Ausführung** aktivieren. Es gibt danach wie entschieden kein Approval je Trade.
3. Für Echtgeld exakt `ENABLE LIVE TRADING` eingeben. Ohne diese zweite Sperre bleiben live geroutete Signale blockiert, Paper/Testnet können weiterlaufen.

```text
validiertes XML → Kanalroute → immutable Strategie → Risk/Capacity
→ persistierter Plan → idempotenter Entry → bestätigter Protective Stop
→ TP-Staffel → Fill-Reconciliation → Stop auf Restmenge/Break-even
→ Position geschlossen + realisierter PnL
```

Ein Stop-Submit-Fehler nach gefülltem Entry löst automatisch einen reduce-only Emergency Flatten aus. Ist dessen Ausgang unklar, werden neue Entries gesperrt und der Kill-Switch gesetzt.

Eine Teilfüllung wird sofort mit einem reduce-only Stop bis zur maximal noch möglichen Entry-Menge geschützt. Solange der Entry weiter offen ist, werden noch keine TPs platziert. Sobald der Entry vollständig gefüllt oder mit Teilfüllung storniert ist, skaliert die Reconciliation Stop und sämtliche TP-Mengen exakt auf die tatsächlich bestehende Position.

## 7. Dashboard und Notfall

- **Executive Dashboard:** Der Portfolio-Filter zeigt alle Konten nominal zusammen, eine einzelne Börse oder ein einzelnes Konto. Paper, Hyperliquid Testnet/Mainnet und Bybit Testnet/Mainnet bleiben in der Account-Matrix getrennt erkennbar.
- **Zeiträume:** `24h`, `7 Tage`, `30 Tage` und `Gesamt` steuern PnL, Trades, Win Rate, Profit Factor, Volumen, Fills, Gebühren, Intents und Risk Events. Alle vier PnL-Zeiträume bleiben gleichzeitig sichtbar.
- **Datenherkunft:** Equity, verfügbarer Saldo, Margin und unrealisierter PnL kommen über die offiziellen Exchange-SDKs. Realisierter PnL und historische Kennzahlen kommen aus den vom System persistierten Managed Trades; externe/manuelle Trades werden nicht fälschlich als Managed Performance ausgegeben.
- **Aktualisierung:** Das Dashboard lädt lokale Statistiken alle zehn Sekunden. Exchange-Snapshots werden 60 Sekunden gecacht; **Alles aktualisieren** erzwingt sofort eine neue Abfrage aller angebundenen Konten und zeigt Teilfehler je Konto an.
- **Nominale Gesamtsicht:** Die gemeinsame Equity addiert Bybit-USD, Hyperliquid-USDC und Paper-Quote nominal. Sie ist keine FX-Bewertung und garantiert keine Stablecoin-Parität; für belastbare Bewertung immer zusätzlich den Konto-Drill-down verwenden.
- **Betrieb:** offene Positionen, aktive Routen, laufende Intents, Unknown Orders und letzter Abgleich.
- **Trades & Risiko:** Positionen mit Ursprungskanal/Strategie, Orderrollen, Fillmengen, Risk Events und Reconciliation-Runs.
- Prometheus: `tg_forwarder_trading_*`. Unknown Orders, ungeschützte Positionen, Kill-Switch oder >30 Sekunden alter Abgleich bei aktiver Execution machen `/readyz` rot und lösen kritische Alerts aus.

Im Notfall Kill-Switch aktivieren, Exchange read-only gegen Client Order IDs prüfen und bei fehlendem Schutz exakt `FLATTEN MANAGED POSITIONS` eingeben. Nur managed Positionen werden reduce-only geschlossen; fremde Exposure wird nie still übernommen. Unknown Submit-/Cancel-Ausgänge nie blind wiederholen. Der vollständige Ablauf steht in `runbooks/operations.md#trading-notfall-und-reconciliation`.

## 8. Neustart, Backup, Restore, Factory Reset

- Bei jedem Start reconciliert der Trading-Worker alle aktivierten Konten, bevor er Pending Intents bearbeitet.
- SQLite-Backups enthalten Strategien, Routen, Intents, Orders, Fills, Positionen und Risk Events. Exchange-Secrets sind absichtlich ausgeschlossen und müssen nach Restore neu bereitgestellt/verifiziert werden.
- Factory Reset stoppt den Worker, storniert offene Entries und fragt jedes reale Konto ab. Solange Exchange/Executor nicht erreichbar ist oder Remote-Exposure besteht, wird der Reset verweigert. Nach sicherem Nullzustand werden Datenbank, Keys, interner Executor-Token und der gesamte übrige lokale Zustand entfernt.
- **Betriebsdaten leeren** stoppt das Nachrichten-Routing und entfernt Nachrichten, Queue-/Medienpuffer sowie unreferenzierte Signale. Trading-Historie, Strategien, Konten, Exchange-Secrets und von Trades referenzierte Signale werden dabei bewusst nicht gelöscht.

## 9. Production-Freigabe

Live bleibt **NO-GO**, bis zusätzlich zu allen normalen Enterprise-Gates folgende reale Nachweise vorliegen:

- Hyperliquid- und Bybit-Testnet: Entry, mehrere TP-Fills, Stop-Resize, Break-even, Cancel, Timeout/Unknown und Neustart-Reconciliation.
- Exchange-separates Subkonto, minimale API-Rechte, IP-Allowlist und dokumentierte Key-Rotation.
- Staging-Last mit parallelen Kanälen und Symbolkonflikt-Test.
- Alarmzustellung für Unknown Order, ungeschützte Position, Kill-Switch und stale Reconciliation.
- Restore plus erneutes Secret-Provisioning, vorheriger Image-Digest plus beide Image-Attestierungen.
- 30 Tage Paper/Testnet-Soak ohne Unknown Order, ungeschützte Position, Drift oder Ressourcenwachstum; danach bewusst begrenzter Live-Canary mit festem maximalen Notional.
