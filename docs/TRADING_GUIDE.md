# TSX Core – Trading und visueller Workflow-Builder

Diese Anleitung beschreibt den neuen verbindlichen Trading-Pfad. Die frühere Einrichtung über getrennte Trading-Untermenüs und eine einzelne Kanalroute ist nicht mehr die fachliche Oberfläche.

## Sicherheitsmodell

- Eine Neuinstallation enthält keine Konten, Guthaben, Verträge, Schemas, Strategien, Workflows oder MCP-Agenten.
- Ausführung und Live-Trading sind zunächst deaktiviert.
- Ein Pfad ist nur ausführbar, wenn alle erforderlichen Bausteine veröffentlicht, verbunden und gültig sind. Unvollständige Pfade sind inert.
- Zugangsdaten sind write-only. Die UI zeigt nur Konfigurations- und Verifikationsstatus.
- Jede Position benötigt einen Protective Stop. Unbekannte Orderausgänge, fremde Exposure, fehlender Schutz, Kontosperre oder globale Sperre blockieren neue Entries fail-closed.
- REST-Reconciliation ist autoritativ. CCXT-Pro-Ereignisse beschleunigen ausschließlich den Zeitpunkt des nächsten Abgleichs.
- Workflow-Parser speichern Signale nur in SQLite; `saveToFile` ist zwingend `false`.

## Oberfläche

Die Hauptansicht ist eine horizontale Arbeitsfläche. Jede fachliche Stufe besitzt eine Spalte:

1. Telegram-Kanal
2. Inhaltstyp
3. Schlüsselwörter
4. Regex
5. KI-Parser
6. Signal-Schema
7. Signal-Vertrag
8. Duplikatschutz
9. Strategie
10. Positionsgröße
11. Adaptives Risiko
12. Börsenkonto
13. Ausgabe

Karten lassen sich innerhalb ihrer Spalte vertikal anordnen. Verbindungen laufen ausschließlich von einer früheren zu einer späteren Spalte. Direkte Kanten dürfen optionale Stufen überspringen; ein ausführbarer Pfad muss trotzdem Kanal, Parser, Schema, Vertrag, Strategie, Sizing und Konto enthalten. Der Konto-Knoten ist das fachliche Ende; ein Ausgabe-Knoten kann folgen.

Ein Klick auf eine Karte öffnet ihren Editor. **Baustein** öffnet die Bibliothek: Dort kann eine bereits veröffentlichte logische Ressource wiederverwendet oder eine neue erstellt werden. Änderungen erzeugen eine neue immutable Version. Eine ältere aktive Revision wird niemals in-place verändert.

Jede Änderung wird zuerst validiert und dann atomar als neue aktive Revision gespeichert. Sobald ein ausführbarer Pfad hinzugefügt, geändert oder entfernt würde, zeigt TSX Core die Auswirkung und verlangt die exakte Eingabe `ACTIVATE WORKFLOW IMPACT`. Abbrechen oder eine abweichende Eingabe lässt die bisherige aktive Revision unverändert. Parallele Browseränderungen werden über einen Revisionskonflikt abgefangen.

## Bausteine

### Kanal und Filter

Der Kanal verwendet die numerische Telegram-Chat-ID. Ein Kanal aus der aktiven Workflowrevision wird direkt als Quelle akzeptiert; ein Neustart des Routings ist für eine neu verbundene, bereits zugängliche Telegram-Quelle nicht erforderlich.

Inhaltstyp, Keyword- und Regex-Filter laufen vor dem KI-Aufruf. Regex erhält ReDoS-Prüfung, begrenzten Eingang und Zeitlimit. `all` verlangt alle Muster, `any` mindestens eines. Fotos oder Videos können über ihren Caption-Text in denselben Einzel-Signalpfad gelangen; Media-Groups umgehen den Workflow nicht.

### Parser

Der Parser-Dialog verwaltet Prompt-Vorlage, Primär-/Fallbackmodell und ein Zeitlimit zwischen 2 und 120 Sekunden. Der konkrete Prompttext wird direkt im Parser-Baustein gespeichert und durch dessen Konfigurationshash unveränderlich an die Revision gebunden. Eine spätere Änderung der gleichnamigen globalen Vorlage verändert einen aktiven Workflow nicht. Serverseitige Schutz- und Grounding-Regeln bleiben nicht editierbar und werden zusätzlich angehängt. Der Parser-Baustein erzwingt Datenbankspeicherung.

Identische Parser-, Schema-, Vertrags- und Dedupe-Konfigurationen mehrerer Börsenzweige werden gruppiert. Das Telegram-Signal wird einmal geparst und erst danach in unabhängige Trade Intents aufgefächert.
Duplikate werden innerhalb dieser unveränderlichen Pfadgruppe erkannt. Zwei bewusst unterschiedliche Parser- oder Vertragszweige blockieren sich daher nicht gegenseitig.

### Schema und Vertrag

Das Schema bestimmt die ausführbare Parserform (`standard`, `cryptodanielvip` oder `loma`). Eine fachliche Schemaänderung erhält eine neue eindeutige Schema-ID; verwendete Profile werden nicht still mutiert. Die ausgewählte Strategieversion muss diese ID in `allowedSignalSchemas` erlauben.

Der Vertrag ist ein unabhängiger, versionierter Baustein. Seine Definition legt XML-Pfade, Entry-Form, Target-Form und -Anzahl, Stop, Leverage, Zusatzfelder, Geometrie und Quelltext-Grounding fest. Eine Bearbeitung im Dialog erzeugt eine neue veröffentlichte Vertragsversion. Im visuellen Workflow bestimmt der verbundene Vertrag die Definition; die im Schema gespeicherte Vertragsversion ist nur der Default für Alt-/Nicht-Workflow-Pfade.

### Strategie

Eine Strategieversion enthält:

- erlaubte Schema-IDs, Symbole und Seiten;
- Entry-Typ, Range-Auswahl, Post-only und Entry-Timeout;
- Default-Sizing für Legacy-Pfade;
- TP-Verteilung, Break-even/Trailing beziehungsweise adaptive Targets;
- tägliches Verlustlimit, Slippage, Entry-TTL und Protective-Stop-Pflicht.

Die Definition kann als deklaratives JSON im Dialog bearbeitet werden. Speichern erzeugt eine neue veröffentlichte Version. `maxConcurrentPositions` gehört seit Schema v3 nicht mehr zur Strategie.

### Positionsgröße

Der Pfadbaustein überschreibt das Strategy-Sizing für genau diesen Zweig:

- `equity_percent_margin`: Prozent des Portfoliowerts als eingesetztes Margin-Kapital; Notional = Margin × tatsächlich erlaubter Hebel.
- `equity_percent_notional`: Prozent des Portfoliowerts als gesamter Positionswert.
- `risk_percent`: Prozent des Portfoliowerts als maximaler Verlust zwischen Entry und Stop.

`riskPerTradePercent`, `maxAdaptiveRiskPercent`, Notional-Obergrenze und maximaler Hebel werden strikt validiert. Der Hebel wird auf das kleinere Limit aus Signal, Strategie/Pfad und Börsenmarkt heruntergestuft. Ein im Signal fehlender Hebel verwendet die Strategie-/Pfadgrenze; ein nicht verfügbarer Markt wird vor der Order abgelehnt.

### Adaptives Risiko

Der optionale Baustein unterstützt `fixed`, `shadow` und `automatic`, gestaffelte Prozentwerte, Start-/Fixstufe, Lookback, Mindestzahl geschlossener Trades, Gewinn-/Verlustschwellen, schwache Wochen und manuelle Sperre. Zustand und Auswertung sind durch Kanal, konkretes Börsenkonto und logischen Risiko-Baustein getrennt. Derselbe Kanal kann daher auf Konto A starr mit 10 Prozent und auf Konto B adaptiv ab 5 Prozent laufen.

### Börsenkonto und Kapazität

Das Positionslimit wird im Kontobaustein beziehungsweise unter **Betrieb → Konten** auf 1 bis 20 gesetzt. Es gilt für das gesamte konkrete Konto über alle Kanäle, Strategien und Workflowpfade. Zusätzlich kann dasselbe Konto/Symbol nur eine aktive verwaltete Position besitzen.

Wenn das Limit oder verfügbare Kapital erreicht ist, wird nur der betreffende neue Intent blockiert; andere Kontozweige desselben Signals bleiben unabhängig. TSX Core erhöht weder automatisch den Hebel noch verwendet es Kapital eines anderen Kontos, um das Limit zu umgehen.

Unterstützte Kontotypen:

| Typ | Modi | Zugangsdaten |
| --- | --- | --- |
| Paper | Paper | eigene Startbilanz |
| Hyperliquid | Testnet, Live | dedizierter API-Wallet Private Key und Master-Wallet-Adresse |
| Bybit | Testnet, Live | API Key und API Secret |
| Kraken Futures | Testnet, Live | API Key und API Secret |

Nur Futures-/Derivate-Handelsrechte vergeben. Withdrawal-Rechte sind unnötig und verboten. Hyperliquid-Builder-Fees sind deaktiviert. Eine Secret-Rotation ist nur für dieselbe stabile Exchange-Kontoidentität erlaubt; ein anderer API-Key beziehungsweise eine andere Wallet-Adresse wird als Rebinding abgelehnt.

## CCXT und CCXT Pro

Das Sidecar pinnt `ccxt==4.5.75`. Dieselbe Distribution liefert CCXT Pro. Pro wird verwendet, weil private Order-/Trade-/Positionsereignisse und öffentliche Marktströme schneller als Polling eintreffen. Es ersetzt REST nicht:

```text
CCXT Pro Event → deduplizierter Cursor → erzwungene Reconciliation → CCXT REST Snapshot → SQLite
```

Alle zustandsändernden Orders laufen über CCXT REST. Preis- und Mengenpräzision, Contract Size, Trigger, Reduce-only, Client-ID und Providerstatus werden normalisiert. Ein geschützter Entry wird als validierter Entry plus gleich großer Reduce-only-Stop im Batch gesendet. Vor Leverage- oder Orderänderungen verlangt das Sidecar per REST null bestehende Exposure auf Konto/Symbol. Bei unvollständigem oder unbekanntem Ergebnis versucht es mit eigenem Notfallzeitfenster beide Legs zu stornieren und ausschließlich die seit diesem Null-Preflight neu entstandene Exposure zu reduzieren; anschließend bleibt das Konto bis zur autoritativen Reconciliation gesperrt.

Ein CCXT-Upgrade ist keine gewöhnliche Dependency-Aktualisierung. Es benötigt erneut Unit-/Contracttests, Containerbuild, Testnet-Nachweis je implementierungsseitig freigegebener Börse und Reconciliation-/Timeoutprüfung. Die interne CCXT-Allowlist allein ist ausdrücklich kein Testnet- oder Produktionsnachweis.

## Mehrere Börsen aus einem Signal

Für das Beispiel „VIP Coinsignals gleichzeitig Hyperliquid 10 Prozent starr und Kraken 5 Prozent adaptiv“ wird der gemeinsame Pfad bis Strategie geführt und danach verzweigt:

```text
VIP → Filter → Parser → Schema → Vertrag → Strategie
                                         ├→ Sizing 10 % fixed → Hyperliquid
                                         └→ Sizing 5 % → Adaptive Risk → Kraken Futures
```

Beide Intents referenzieren dieselbe Signal- und Workflow-Provenienz, besitzen aber eigene Pfad-ID, Strategieversion, Konto, Plan, Order-IDs und Fehlerzustände. Ein nicht bereites Kraken-Konto verhindert den Hyperliquid-Zweig nicht.

## Simulation und Aktivierung

**Simulieren** schickt Beispieltext und Inhaltstyp ohne Parser-/Exchange-Nebenwirkung durch die Filter der aktiven Revision. Für jeden passenden Pfad werden Konto, Aktivierungszustand und Blockgrund angezeigt. Die Simulation ersetzt keinen Paper-/Testnet-End-to-End-Test.

Unter **Betrieb → Live**:

1. alle aktivierten Konten reconciliieren;
2. Unknown Orders, fremde Exposure, offene Risk Events und Streamlücken prüfen;
3. automatische Ausführung aktivieren;
4. für Live einmal exakt `ENABLE LIVE TRADING` bestätigen.

Ausführung kann global pausiert werden, ohne bestehende Stops/TPs zu entfernen. Der globale Kill-Switch storniert Entries und blockiert neue. Ein Kontoschalter isoliert ein einzelnes Konto; seine Freigabe verlangt `RELEASE ACCOUNT KILL SWITCH` und zwei erzwungene Reconciliations.

## Betrieb, Journal und Analytics

Der integrierte Bereich enthält:

- **Live**: Runtime-Gates, Reconciliation, Cancel Entries, Kill-Switch und Emergency Flatten;
- **Konten**: Erstellung, Limits, Status, Verifikation, Secret-Rotation und Löschung ohne Exposure;
- **Journal**: Signal-/Workflow-/Schema-/Vertrags-/Strategie-Provenienz, Orders, Fills, Gebühren, PnL und Reviews;
- **Analyse**: Equity, Drawdown, Kanalranking, Börsenvergleich, Latenz und adaptive Pfadzustände;
- **Logs**: begrenzter zusammenhängender Betriebsstrom;
- **Backups**: Erstellen, Prüfen, Restore und Off-site-Recovery mit exakten Bestätigungen;
- **MCP**: Runtime, Agenten, Minimalrechte, Tokens, Vorschläge, Sitzungen und Aktionen;
- **System**: Telegram-Anmeldung, Parserprovider, Routing, Remote-Zugriff, OIDC/Tailscale, Secrets und Enterprise-Parameter.

## Migration bestehender Installationen

Wenn noch keine aktive Workflowrevision vorhanden ist, werden aktivierte Alt-Routen beim Start automatisch übernommen. Für jede Route entstehen typisierte Ressourcen einschließlich Filter, Parser, Schema, Vertrag, Strategie, Sizing, optional adaptivem Risiko, Konto und Ausgabe. Promptzeitlimit und `saveToFile=false` werden übernommen beziehungsweise sicher normalisiert. Danach ist die Workflowrevision die Quelle für Telegram-Kanäle und Ausführung.

Die Migration verändert keine offene Exchange-Position. Ein späterer Produktions-Cutover benötigt ein verifiziertes Backup, gestoppte Entries, vollständige Reconciliation und eine gesonderte Bestätigung für das Schließen aller Exposure auf betroffenen Konten. Ohne diese Bestätigung findet kein Server-/Exchange-Cutover statt.
