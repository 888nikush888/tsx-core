# TSX Core – Trading: vollständige Einrichtung und Nutzung

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

## 3. Signalverträge, Schema-Profile und Strategien erstellen

Unter dem eigenen Sidebar-Punkt **XML-Verträge** oder alternativ **Trading → Verträge**:

- **Vertrag erstellen oder duplizieren:** Kennung, Name und Beschreibung festlegen; `standard`, `cryptodanielvip` und `loma` sind nur initiale Beispiele und keine feste Laufzeit-Allowlist.
- **Visueller Vertrags-Builder:** XML-Pfade für Aktion, Paar, Entry, Targets, Stop-Loss sowie optionale Leverage-/Risiko-/Averaging-Felder; Entry-Modus, scalar/range Targets, 1 bis 20 Targets, sequenzielle IDs und bis zu 30 zusätzliche typisierte Felder.
- **Geometrie:** Stop auf der Verlustseite, Targets auf der Gewinnseite, geordnete Targets und geordnete Ranges für LONG und SHORT getrennt durch die Signalrichtung erzwingen.
- **Quelltext-Erdung:** pro Kernfeld bestimmen, ob der extrahierte Wert in der ursprünglichen Telegram-Nachricht nachweisbar sein muss.
- **Vorschau:** XML plus Originaltext gegen genau den noch nicht publizierten Entwurf testen.
- **Versionen:** Nur Entwürfe sind editier- oder löschbar. Publizieren macht die Definition samt SHA-256 immutable. Für Änderungen aus einer vorhandenen Version einen neuen Entwurf erzeugen. Eine von einem aktivierten Profil verwendete Version kann nicht archiviert werden.

Unter **Trading → Strategien**:

- **Signal-Schema-Profile:** Profile anlegen, bearbeiten, aktivieren/deaktivieren oder nach expliziter Bestätigung löschen. Jedes Profil besitzt eine unveränderliche Kennung, einen Anzeigenamen, ein Parser-Template und `contractVersionId` als frei wählbare Verknüpfung zu einer publizierten Vertragsversion.
- **Signalvertrag in der Strategie:** erlaubte Schema-Profil-IDs, Symbole (leer = jedes normalisierte Symbol) und LONG/SHORT.
- **Entry:** Market oder Limit, Preiswahl innerhalb der Signal-Range, Post-only und Timeout.
- **Sizing:** Risiko pro Trade in Prozent der Equity, maximales Positionsnotional und maximaler Hebel. Signalhebel und Exchange-Maximum können nur weiter begrenzen.
- **Exits:** manuelle Prozentwerte oder adaptive TP-Halbierungsstaffel; konfigurierbares Break-even/Prozent-Trailing oder adaptives SL-Nachziehen nach erreichten TP-Stufen. Der letzte TP schließt immer den vollständigen Rest. Ein Protective Stop ist zwingend.
- **Safety:** maximale gleichzeitige Positionen je Strategieversion, absoluter maximaler UTC-Tagesverlust, Slippage-Grenze und Entry-TTL.

**Entwurf speichern** validiert alle Grenzen. **Publizieren** macht die Version immutable und routingfähig. Für Änderungen die publizierte Version auswählen und **Neue Version** erstellen. Bestehende Trades behalten die alte Version; neue Signale nutzen erst nach explizitem Routing-Wechsel die neue.

Nur aktive Schema-Profile können in neuen Strategien verwendet werden. Ein Profil, das eine aktivierte Kanalroute verwendet, kann weder verändert noch gelöscht werden. Ein unbekanntes, deaktiviertes oder gelöschtes Profil bleibt zur Laufzeit fail-closed und erzeugt keinen ausführbaren Trade.

### Verträge und Signal-Schema-Profile sicher verwalten

Ein Vertrag ist ausschließlich deklarativ. Pfade sind auf ein bis vier kleingeschriebene XML-Segmente begrenzt, Feldtypen und Strukturen stammen aus festen Interpreter-Primitiven, und risikoreiche Regex-Konstrukte werden abgewiesen. Der Builder akzeptiert weder XML-Schema-Code noch Python oder JavaScript. Dadurch kann ein Benutzer beliebige fachliche Verträge modellieren, ohne den Container- oder Exchange-Berechtigungsraum zu erweitern.

Ein Profil bleibt die deklarative Zuordnung zwischen quellspezifischem Parser-Template und publiziertem Vertrag. Das wirksame Profil wird zur Laufzeit über das der Telegram-Quelle zugeordnete Parser-Template ermittelt. Für jedes aktiv verwendete Template sollte genau ein aktives Profil existieren. Vor einer Änderung an einem gerouteten Profil zuerst eine Ersatzstrategieversion mit dem neuen Profil publizieren, die Kanalroute umstellen und anschließend das alte Profil bearbeiten, deaktivieren oder löschen.

Die authentifizierte Admin-API entspricht den UI-Aktionen. Mutationen benötigen zusätzlich zum Admin-Bearer `X-Requested-With: forwarder-dashboard`; die Löschung verlangt außerdem die unten genannte destruktive Bestätigung:

| Aktion | Methode und Pfad | Zusatzbedingung |
| --- | --- | --- |
| Trading-Snapshot einschließlich Verträgen/Profile lesen | `GET /api/trading` | Viewer oder Admin |
| Vertrag anlegen | `POST /api/trading/signal-contracts` | Admin; Metadaten plus deklarative `definition`; Ergebnis ist `v1` als Entwurf |
| Vertragsentwurf aktualisieren | `POST /api/trading/signal-contracts/update` | Admin; `contractId`, `versionId`, Metadaten und vollständige Definition |
| Neue Version / Duplikat | `POST /api/trading/signal-contracts/versions` / `duplicate` | Admin; Quelle bleibt unverändert |
| Vertrag publizieren / archivieren | `POST …/publish` / `archive` | Admin; Archivierung nur ohne aktiviertes Profil |
| Vertragsentwurf löschen | `DELETE /api/trading/signal-contracts/drafts` | Admin plus `X-Destructive-Confirmation: delete-signal-contract-draft` |
| Vertrag in Vorschau validieren | `POST /api/trading/signal-contracts/validate` | Admin; keine Persistenz |
| Profil anlegen | `POST /api/trading/signal-schemas` | Admin; Body mit `id`, `name`, `description`, `contractVersionId`, `templateName`, `enabled` |
| Profil bearbeiten/aktivieren/deaktivieren | `POST /api/trading/signal-schemas/update` | Admin; Body zusätzlich mit unveränderlicher `id`; keine aktive Route darf das Profil verwenden |
| Profil löschen | `DELETE /api/trading/signal-schemas` | Admin; Body `{"id":"..."}` und `X-Destructive-Confirmation: delete-trading-signal-schema` |

| Profilfeld | Vertrag |
| --- | --- |
| `id` | 1 bis 40 Zeichen; beginnt mit `a-z`, danach nur `a-z`, `0-9`, `_` oder `-`; wird kleingeschrieben und bleibt nach Erstellung unveränderlich |
| `name` | 1 bis 80 Zeichen |
| `description` | optional, höchstens 500 Zeichen |
| `contractVersionId` | Kennung einer vorhandenen publizierten Vertragsversion, beispielsweise `desk-alpha:v3` |
| `parserSchema` | wird aus dem verknüpften Vertrag abgeleitet und dient nur der rückwärtskompatiblen Anzeige |
| `templateName` | 1 bis 64 Zeichen aus Buchstaben, Ziffern, `_` oder `-`; muss zum quellspezifisch ausgewählten Parser-Template passen |
| `enabled` | echter JSON-Boolean, kein String |

Fehlerhafte oder bereits vorhandene Kennungen, unpublizierte Verträge und ungültige Definitionen werden abgewiesen. Unbekannte oder deaktivierte Profile führen nicht zu einem Fallback-Trade.

### Ausschließlich USD-notierte Signalpaare

Ausführbare Signale werden immer gegen eine USD-Quote gehandelt. Zulässig sind normalisierte Symbole mit `USD`, `USDC` oder `USDT` am Ende, beispielsweise `BTCUSD`, `ETHUSDC` und `SOLUSDT`. Paare wie `BTCEUR`, fehlende Quotes oder uneindeutige Paare werden vor jeder Trading-Nebenwirkung abgewiesen. Die gemeinsame Portfolioansicht addiert diese Quotes nur nominal und ist keine FX- oder Stablecoin-Paritätsbewertung.

### Adaptive TP-Staffelung

Bei **Adaptive TP-Staffelung (Halbierungsregel)** passt sich die Allokation automatisch an jedes Signal mit 1 bis 20 Targets an. Jeder TP bis zum vorletzten schließt die Hälfte des verbleibenden Volumens; der letzte TP schließt den gesamten Rest:

| Anzahl TPs | Allokation |
| ---: | --- |
| 1 | `100 %` |
| 2 | `50 % / 50 %` |
| 3 | `50 % / 25 % / 25 %` |
| 4 | `50 % / 25 % / 12,5 % / 12,5 %` |
| 5 | `50 % / 25 % / 12,5 % / 6,25 % / 6,25 %` |

Damit funktionieren Signale mit wechselnder TP-Anzahl ohne separate Strategieversion. Im manuellen Modus muss die Prozentliste dagegen exakt so viele Einträge wie das Signal Targets enthalten und exakt 100 Prozent ergeben; andernfalls wird der Trade blockiert. Exchange-Schrittweiten werden beim Planen berücksichtigt, und eine auf null gerundete TP-Menge wird abgewiesen.

### Adaptives SL-Nachziehen

Bei **Adaptives SL-Nachziehen nach TP-Stufen** gilt die Blueprint-Leiter:

- vor TP1 bleibt der ursprüngliche Stop bestehen;
- nach TP1 und TP2 liegt der Stop auf Break-even, also dem geplanten Entry;
- nach TP3 wird der Stop auf TP1 nachgezogen, nach TP4 auf TP2, allgemein nach `TP n` auf `TP (n-2)`;
- der Stop wird niemals in Verlust- beziehungsweise Gegenrichtung verschoben;
- nach dem letzten TP ist die Position geschlossen; ein verbliebener Schutz wird im Reconciliation-Lauf nur noch sicher abgewickelt.

Im Modus **Konfiguriert** gelten stattdessen der frei wählbare Break-even-Schwellwert und optional das prozentuale Trailing. Die prozentuale Trailing-Regel wird im adaptiven TP-Stufenmodus nicht zusätzlich ausgeführt. Jede Stop-Ersetzung legt zuerst den neuen reduce-only Schutz an und entfernt erst danach veraltete Stops.

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

### Dynamisches Risiko je Quellkanal

Unter **Trading → Kanal-Routing → Dynamisches Kanalrisiko** erhält jeder Quellkanal eine eigene Police:

- `fixed`: aktuelle oder manuell fixierte Stufe bleibt konstant;
- `shadow`: wöchentliche Performance erzeugt eine Empfehlung, ändert das Trade-Risiko aber nicht;
- `automatic`: Verlustwochen reduzieren stufenweise, Gewinnwochen erhöhen stufenweise;
- `weakChannelAction`: nur staffeln, zusätzlich reduzieren oder nach der konfigurierten Anzahl schwacher Wochen blockieren;
- `manuallyBlocked` und `lockedTier`: unmittelbarer Operator-Vorrang.

Die Auswertung verwendet nur abgeschlossene managed Trades des Kanals und speichert Zeitraum, Trades, Wins, Losses, realisierten PnL, Return, vorige/empfohlene/angewendete Stufe, Entscheidung und Begründung. Lookback, Mindestzahl geschlossener Trades, Gewinn-/Verlustschwellen und Risikostufen sind vollständig im Web steuerbar. Trefferquote, Win/Loss, Slippage und PnL-Beitrag erscheinen im Analytics-Kanalranking.

Das wirksame Risiko ist stets das Minimum aus Strategie-Risiko, optionalem Signal-Cap und Kanalpolice. Automatik kann keine Strategie- oder globale Sicherheitsgrenze erhöhen, keine manuelle Sperre aufheben und keinen Kill-Switch umgehen.

## 6. Ausführung aktivieren

Unter **Trading → Betrieb**:

1. **Jetzt reconciliieren**. Konten, lokale Orders/Fills/Positionen und Remote-State müssen übereinstimmen.
2. **Automatische Ausführung** aktivieren. Es gibt danach wie entschieden kein Approval je Trade.
3. Für Echtgeld exakt `ENABLE LIVE TRADING` eingeben. Ohne diese zweite Sperre bleiben live geroutete Signale blockiert, Paper/Testnet können weiterlaufen.

```text
validiertes XML → Kanalroute → immutable Strategie → Risk/Capacity
→ persistierter Plan → idempotenter Entry → bestätigter Protective Stop
→ TP-Staffel → Fill-Reconciliation → Stop auf Restmenge/Break-even/TP-Leiter
→ Position geschlossen + realisierter PnL
```

Ein Stop-Submit-Fehler nach gefülltem Entry löst automatisch einen reduce-only Emergency Flatten aus. Ist dessen Ausgang unklar, werden neue Entries gesperrt und der Kill-Switch gesetzt.

Eine Teilfüllung wird sofort mit einem reduce-only Stop bis zur maximal noch möglichen Entry-Menge geschützt. Solange der Entry weiter offen ist, werden noch keine TPs platziert. Sobald der Entry vollständig gefüllt oder mit Teilfüllung storniert ist, skaliert die Reconciliation Stop und sämtliche TP-Mengen exakt auf die tatsächlich bestehende Position.

## 7. Cockpit, Analytics, Logs und Notfall

- **Cockpit:** zeigt ausschließlich System-/Sicherheitsstatus, Kill-Switch, Execution-/Live-/Paper-Zustand, aktive Positionen mit PnL, kompakten Signalstrom und Notfallaktionen.
- **Analytics:** enthält Equity-/Drawdown-Verlauf, tägliche/wöchentliche Auswertung, Kanalranking, Treffer-/Win-Loss-/Slippage-/PnL-Beitrag, Exchange-Vergleich, Ausführungslatenzen und Erwartungswert-Simulation.
- **Dynamisches Kanalrisiko:** `fixed` hält die gewählte Stufe, `shadow` berechnet nur Empfehlungen, `automatic` wendet wöchentliche Stufenänderungen an. Anhaltend schwache Kanäle können reduziert oder blockiert werden; manuelle Sperre und Stufenfixierung bleiben möglich.
- **Datenherkunft:** Equity, verfügbarer Saldo, Margin und unrealisierter PnL kommen über die offiziellen Exchange-SDKs. Realisierter PnL und historische Kennzahlen kommen aus den vom System persistierten Managed Trades; externe/manuelle Trades werden nicht fälschlich als Managed Performance ausgegeben.
- **Aktualisierung:** Das Cockpit lädt lokale Zustände regelmäßig. Exchange-Snapshots werden 60 Sekunden gecacht; ein expliziter Abgleich erzwingt eine neue Abfrage der angebundenen Konten und zeigt Teilfehler je Konto.
- **Nominale Gesamtsicht:** Die gemeinsame Equity addiert Bybit-USD, Hyperliquid-USDC und Paper-Quote nominal. Sie ist keine FX-Bewertung und garantiert keine Stablecoin-Parität; für belastbare Bewertung immer zusätzlich den Konto-Drill-down verwenden.
- **Logs:** ein ununterbrochener, virtueller Terminalstrom mit Freitext- und sicherer Regex-Suche; keine Level-Filter zerreißen zusammengehörige Abläufe.
- **Command Palette:** `Strg+K`/`⌘K` durchsucht Navigation, Verträge, Kanäle und Positionen und bietet den erlaubten Exchange-Abgleich als Schnellaktion.
- Prometheus: `tg_forwarder_trading_*`. Unknown Orders, ungeschützte Positionen, Kill-Switch oder >30 Sekunden alter Abgleich bei aktiver Execution machen `/readyz` rot und lösen kritische Alerts aus.

Im Notfall Kill-Switch aktivieren, Exchange read-only gegen Client Order IDs prüfen und bei fehlendem Schutz exakt `FLATTEN MANAGED POSITIONS` eingeben. Nur managed Positionen werden reduce-only geschlossen; fremde Exposure wird nie still übernommen. Unknown Submit-/Cancel-Ausgänge nie blind wiederholen. Der vollständige Ablauf steht in `runbooks/operations.md#trading-notfall-und-reconciliation`.

## 8. Neustart, Backup, Restore, Factory Reset

- Bei jedem Start reconciliert der Trading-Worker alle aktivierten Konten, bevor er Pending Intents bearbeitet.
- SQLite-Backups enthalten Signalverträge/Profile, Strategien, Kanalrisiko und Evaluationen, Equity-/Execution-Telemetrie, MCP-Agenten samt Hash/Rechten/Historie, Routen, Intents, Orders, Fills, Positionen und Risk Events. Klartext-Agenten- und Exchange-Secrets sind absichtlich ausgeschlossen beziehungsweise nie vorhanden und müssen nach Restore neu provisioniert oder rotiert werden.
- Factory Reset stoppt MCP-Kontrollbrücke und Trading-Worker, storniert offene Entries und fragt jedes reale Konto ab. Solange Exchange/Executor nicht erreichbar ist oder Remote-Exposure besteht, wird der Reset verweigert. Nach sicherem Nullzustand werden Datenbank einschließlich Verträgen, Kanalrisiko, Analytics und MCP-Agenten, Keys, interner Executor-Token und der gesamte übrige lokale Zustand entfernt.
- **Betriebsdaten leeren** stoppt das Nachrichten-Routing und entfernt Nachrichten, Queue-/Medienpuffer sowie unreferenzierte Signale. Trading-Historie, Strategien, Konten, Exchange-Secrets und von Trades referenzierte Signale werden dabei bewusst nicht gelöscht.

## 9. Production-Freigabe

Live bleibt **NO-GO**, bis zusätzlich zu allen normalen Enterprise-Gates folgende reale Nachweise vorliegen:

- Hyperliquid- und Bybit-Testnet: Entry, Signale mit 1/2/3/5 TPs, adaptive Allokation, mehrere TP-Fills, Stop-Resize, Break-even, TP(i-2)-Nachziehen, Cancel, Timeout/Unknown und Neustart-Reconciliation.
- Exchange-separates Subkonto, minimale API-Rechte, IP-Allowlist und dokumentierte Key-Rotation.
- Staging-Last mit parallelen Kanälen und Symbolkonflikt-Test.
- Alarmzustellung für Unknown Order, ungeschützte Position, Kill-Switch und stale Reconciliation.
- Restore plus erneutes Secret-Provisioning, vorheriger Image-Digest plus beide Image-Attestierungen.
- 30 Tage Paper/Testnet-Soak ohne Unknown Order, ungeschützte Position, Drift oder Ressourcenwachstum; danach bewusst begrenzter Live-Canary mit festem maximalen Notional.
