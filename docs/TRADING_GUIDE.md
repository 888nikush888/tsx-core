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

Der Parser-Dialog verwaltet den Prompt direkt im Baustein sowie Primär-/Fallbackmodell und ein Zeitlimit zwischen 2 und 120 Sekunden. Eine separate globale Prompt-Vorlagenverwaltung gibt es nicht mehr. Der konkrete Prompttext wird durch den Konfigurationshash unveränderlich an die Bausteinrevision gebunden. Serverseitige Schutz- und Grounding-Regeln bleiben nicht editierbar und werden zusätzlich angehängt. Der Parser-Baustein erzwingt Datenbankspeicherung.

Signal-Schema, Signal-Vertrag und Strategie werden ebenfalls direkt in ihrem jeweiligen Baustein erstellt und bearbeitet. Beim Speichern erzeugt TSX Core die notwendige unveränderliche Fachversion und trägt deren ID automatisch in den Baustein ein; eine bereits vorhandene Version muss beim Anlegen nicht mehr ausgewählt werden. Änderungen an einem verwendeten Signal-Schema erzeugen automatisch eine neue eindeutige Schema-ID, statt das bestehende Profil rückwirkend zu verändern.

Der Parser wird nicht im Schema-Dialog aus einer fest eingebauten Profilliste ausgewählt. Quelle ist ausschließlich der tatsächliche Parser-Baustein im Canvas: Eine Verbindung `KI-Parser → Signal-Schema` bindet dessen Prompt, Modelle und Zeitlimit an den kompilierten Ausführungspfad. Der Schema-Dialog zeigt die im Builder vorhandenen Parser und kennzeichnet die direkt verbundene Quelle. Ohne verbundenen Parser bleibt das Schema inert.

Für gespeicherte Bausteine sind drei Aktionen bewusst getrennt: **Nur vom Canvas lösen** entfernt ausschließlich die aktive Platzierung, **Archivieren** entfernt die Familie aus der aktiven Bibliothek und erhält die Audit-Historie, **Endgültig löschen** entfernt alle Versionen der Familie. Eine endgültige Löschung ist nur zulässig, solange keine aktive oder historische Workflowrevision eine dieser Versionen referenziert; andernfalls bleibt der Vorgang fail-closed und der Baustein kann nur archiviert werden.

Identische Parser-, Schema-, Vertrags- und Dedupe-Konfigurationen mehrerer Börsenzweige werden gruppiert. Das Telegram-Signal wird einmal geparst und erst danach in unabhängige Trade Intents aufgefächert.
Duplikate werden innerhalb dieser unveränderlichen Pfadgruppe erkannt. Zwei bewusst unterschiedliche Parser- oder Vertragszweige blockieren sich daher nicht gegenseitig.

### Schema und Vertrag

Das Schema beschreibt direkt die normalisierte Parserausgabe: Root-Element, XML-Pfade für Richtung, Paar, Entry, Targets, Stop und optionale Werte, Target-Elementform sowie Zusatzfelder. Eine fachliche Schemaänderung erhält eine neue eindeutige Schema-ID; verwendete Definitionen werden nicht still mutiert. Die ausgewählte Strategieversion muss diese ID in `allowedSignalSchemas` erlauben.

Der Vertrag ist ein unabhängiger, versionierter Sicherheitsbaustein. Im visuellen Workflow darf er die vom Schema festgelegten Feldnamen und Pfade nicht umbenennen. Er verschärft die zulässige Target-Anzahl, passende Zusatzfeldregeln, Preisgeometrie und Quelltext-Grounding. Schema und Vertrag werden beim Aktivieren des Workflows vorab zusammengesetzt und vollständig validiert; eine inkompatible Kombination bleibt fail-closed. Die gespeicherte Parserprofil- und Vertragsreferenz existiert nur noch für kompatible Alt-/API-Pfade und entscheidet nicht über die Parserquelle des Builders.

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

Alle zustandsändernden Orders laufen über CCXT REST. Preis- und Mengenpräzision, Contract Size, Trigger, Reduce-only, Client-ID und Providerstatus werden normalisiert. Ein geschützter Entry wird als validierter Entry plus gleich großer Reduce-only-Stop im Batch gesendet. Vor Leverage- oder Entryänderungen verlangt das Sidecar vollständige aktuelle Belege ohne bestehende Exposure oder Orders auf Konto/Symbol. Ein vorher leerer Kontoscope beweist bei unvollständigem Batch-Ergebnis nicht die spätere Eigentümerschaft: Es gibt keinen Blind-Retry, pauschalen Leg-Cancel oder Flatten einer nur zufällig passend großen Position. Bestätigte Legs und unklare Ergebnisse bleiben dauerhaft gespeichert und werden über identitäts-/evidenzgebundene Reconciliation geklärt; neue Entries bleiben solange gesperrt. Bereits bewiesener eigener Schutz wird weiter verwaltet.

Ein CCXT-Upgrade ist keine gewöhnliche Dependency-Aktualisierung. Es benötigt erneut Unit-/Contracttests, Containerbuild, Testnet-Nachweis je implementierungsseitig freigegebener Börse und Reconciliation-/Timeoutprüfung. Die interne CCXT-Allowlist allein ist ausdrücklich kein Testnet- oder Produktionsnachweis.

### Tatsächlicher Kontomodus vor neuen Entries

Eine Kontoverifikation ist keine pauschale Entry-Erlaubnis: Sie liefert eine aktuelle Konto-Modusbeobachtung und verlangt zusätzlich einen symbolbezogenen Readback. Vor Vorbereitung und nochmals unmittelbar vor Dispatch muss `/v1/entry-constraints` den vorhandenen Cross-/One-way-Modus belegen. Der höchstens zehn Sekunden alte Nachweis ist an Konto-Fingerprint, Credentialgeneration, Symbol, CCXT 4.5.75 und Ausführungsprofilhash gebunden. Ein synchroner letzter Guard prüft ihn nach dem Journal-Schreibschritt; das Sidecar liest vor dem tatsächlichen Entry erneut. Fehlende, widersprüchliche, veraltete oder nicht passende Angaben blockieren nur neue Entries.

Bybit verwendet authentifizierte Account- und symbolbezogene Positionsfelder. Kraken Futures liest authentifizierte Leverage-Präferenzen und offene Positionen; im Cross-Modus wird **kein** `set_leverage` aufgerufen, weil dessen `maxLeverage`-Parameter den Modus auf Isolated umstellen würde. Hyperliquid verwendet öffentliche, exakt an die bereits gebundene Wallet und Credentialgeneration gekoppelte Konto-/Asset-Daten (`public_bound_account`), keine behauptete HTTP-Authentifizierung. HIP-3-/andere Perp-Dex-Scope sind hier nicht freigegeben. Verify schaltet keine Modi um; ein vorgefundener Hedge-/Isolated-Modus wird nicht automatisch korrigiert.

Zusätzlich liest Hyperliquid den gebundenen `userAbstraction`-Zustand. Nur explizit `disabled` ist in diesem Profil für Entries belegt; Portfolio-/Unified-/DEX-Abstraktion sowie ein nicht aufgelöster `default` werden nicht als konventioneller Cross-Modus angenommen.

Bestehende Schutz-, Cancel- und Reduce-only-Pfade hängen nicht von dieser Entry-Verifikation ab. Mehrere REST-Lesevorgänge bleiben zeitlich begrenzte Beobachtungen, kein atomarer Snapshot gegenüber externen Kontoveränderungen. Modus-, Preisdeckel- und Tierverträge sind lokal mit Fakes beziehungsweise abgefangenem CCXT-Transport geprüft; die echte Providerabnahme bleibt offen. Details und Quellen: [004 Modus-Nachweis](../plans/004-MODE-IMPLEMENTATION-NOTES.md).

### Harte Preisgrenze für marktbasierte Entries (lokaler Entwicklungsstand)

Marktbasierte Entries speichern jetzt ihren ursprünglichen Referenzpreis und die daraus tick-konservativ abgeleitete Obergrenze LONG beziehungsweise Untergrenze SHORT. Tatsächlich gesendet wird eine preisgebundene IOC-Limit-Order im bestehenden Entry-plus-Stop-Pfad. Revalidation, Wartezeit und Neustart verschieben die Grenze nicht. Ein ungefüllter IOC-Rest ist beendet und wird nicht später nachgeholt; tatsächliche Teilfüllungen werden über die bestehende Fill-/Schutzabstimmung weitergeführt.

Normale Signal-Limits/Post-only und Schutz-/Emergency-Exits behalten ihre eigene Ausführungsform. Die Entry-Grenze wird niemals auf einen Stop übertragen. Bybit-/Hyperliquid-Payloads sind lokal mit CCXT 4.5.75 geprüft; Kraken bleibt für diese geschützte begrenzte Form gesperrt, weil Batch- und Einzelorder-Dokumentation zur Stop-Market-Form widersprechen. Das ist keine reale Providerabnahme. Details: [004 Preisgrenzen-Nachweis](../plans/004-PRICE-IMPLEMENTATION-NOTES.md).

Zusätzlich verhindert eine eng begrenzte SDK-Subclass bei jedem Hyperliquid-REST-/Streaming-Client automatische Builder-Genehmigungen und Referrer-Änderungen, die CCXT sonst sogar beim lesenden Marktladen auslösen kann. Die normale lesende Kontoabstraktionsprüfung bleibt aktiv. Es werden weder Genehmigungen vorgetäuscht noch Builderfelder an Orders angehängt.

### Größenabhängiger Hebel und unverändertes Marginbudget (lokaler Entwicklungsstand)

Vor einem Entry werden vollständige, kontogebundene Leverage-Tiers mit Contractsize, Währung und aktuellem Mark gelesen. Ein einzelnes Marktmaximum genügt nicht. Margin-Prozent bleibt eingesetztes Kapital: Bei nötiger Hebelreduktion wird die Menge neu abgerundet, nicht die Margin erhöht. Andere Sizingmodi behalten ihren Zweck; Risk-Prozent verwendet den tatsächlichen erlaubten Entry-Limitpreis bis zum unveränderten Stop. Programmmaximum 50x bleibt bestehen.

Tierbewertung erfolgt exakt zum Provider-Mark; Mengen-/Marginbudget berücksichtigen zusätzlich den ursprünglichen Entry-Grenzpreis. Vor Setter und Orderversand folgen frische Tier-/Mark-/Scopeprüfungen. Eine neue oder ungeklärte Position, fremde lokale Entryreservierung, geänderte Tabelle oder nicht mehr tragbare Margin verhindert den neuen Entry. Die ursprüngliche Preisgrenze wird dabei nicht neu berechnet. Normale Schutz- und Exitpfade bleiben unabhängig verfügbar.

Bybit benötigt alle Risk-limit-Cursorseiten und authentifizierten Kontoscope. Hyperliquid benötigt den belegten ersten Perp-DEX, exakt gebundene Wallet und passende vollständige Margin-Tabelle; fehlende Daten werden nicht zu einem angenommenen 50x-Tier. Kraken verwendet den authentifizierten accountabhängigen Trading-Instruments-Plan statt einer angenommenen Professional-Tabelle; seine bislang nicht bewiesene geschützte IOC-/Stop-Form bleibt trotzdem gesperrt. Paper-Belege sind ausdrücklich Simulation. Details, Grenzen und lokale Testnachweise: [004 Tier-Nachweis](../plans/004-TIER-IMPLEMENTATION-NOTES.md). Dies ersetzt keine reale Provider- oder Releasefreigabe.

## Mehrere Börsen aus einem Signal

Für das Beispiel „VIP Coinsignals gleichzeitig Hyperliquid 10 Prozent starr und Kraken 5 Prozent adaptiv“ wird der gemeinsame Pfad bis Strategie geführt und danach verzweigt:

```text
VIP → Filter → Parser → Schema → Vertrag → Strategie
                                         ├→ Sizing 10 % fixed → Hyperliquid
                                         └→ Sizing 5 % → Adaptive Risk → Kraken Futures
```

Beide Intents referenzieren dieselbe Signal- und Workflow-Provenienz, besitzen aber eigene Pfad-ID, Strategieversion, Konto, Plan, Order-IDs und Fehlerzustände. Ein nicht bereites Kraken-Konto verhindert den Hyperliquid-Zweig nicht.

## Geordnete Börsen-Fallbacks

Parallele Kontozweige und eine Fallback-Reihenfolge sind zwei unterschiedliche Betriebsarten. Für eine exklusive Reihenfolge wird am ersten Kontobaustein **Nächstes Fallback-Konto** gewählt und Konto A mit Konto B, anschließend B mit C verbunden. Die spezielle gestrichelte Verbindung wird pro Ursprungskanal gespeichert. **Pfade** zeigt die Kette als genau eine Route, zum Beispiel `Hyperliquid → Bybit → Kraken Futures`.

TSX Core legt zunächst ausschließlich für Konto A einen Intent an. Nur wenn der interne CCXT-Executor über den Read-only-Market-Snapshot exakt `SYMBOL_UNAVAILABLE`, `sideEffects=false` und die passende Börsen-, Konto- und Symbolidentität meldet, wird Konto B angelegt und geprüft. Dasselbe gilt danach für Konto C. Sobald ein Konto das Paar unterstützt, endet die Auswahl dort – auch wenn die spätere Planung oder Orderübermittlung scheitert. Es wird daher niemals derselbe Trade wegen eines Timeouts oder unklaren Orderausgangs auf einem weiteren Konto dupliziert.

Kein Fallback findet statt bei:

- 502/503/504, Transportfehler oder Timeout;
- nicht bereitem, gesperrtem oder nicht abgleichbarem Konto;
- Kapital-, Positions-, Tagesverlust-, Strategie-, Vertrags- oder sonstigem Risikogate;
- abgelaufener Entry-TTL;
- Submit-, Cancel- oder Reconciliation-Fehlern.

Alle Kandidaten erben Parser, Schema, Vertrag, Strategie, Positionsgröße und adaptiven Risiko-Baustein vom ursprünglichen Pfad. Das tatsächlich ausgewählte Konto verwendet jedoch immer sein eigenes Equity, sein kontoweites Positionslimit und seinen eigenen adaptiven Zustand. Die Zeitgrenze beginnt mit dem ursprünglichen Signal und wird beim Wechsel nicht neu gestartet. Ist das Paar auf keinem Konto vorhanden, endet die Route ohne Order als **Überall nicht verfügbar**. Dashboard, Analytics und MCP zeigen jeden Versuch und den abschließenden Grund.

## Simulation und Aktivierung

**Simulieren** schickt Beispieltext und Inhaltstyp ohne Parser-/Exchange-Nebenwirkung durch die Filter der aktiven Revision. Für jeden passenden Pfad werden Konto, Aktivierungszustand und Blockgrund angezeigt. Die Simulation ersetzt keinen Paper-/Testnet-End-to-End-Test.

Unter **Betrieb → Live**:

1. alle aktivierten Konten reconciliieren;
2. Unknown Orders, fremde Exposure, offene Risk Events und Streamlücken prüfen;
3. automatische Ausführung aktivieren;
4. für Live einmal exakt `ENABLE LIVE TRADING` bestätigen.

Ausführung kann global pausiert werden, ohne bestehende Stops/TPs zu entfernen. Der globale Kill-Switch storniert Entries und blockiert neue. Ein Kontoschalter isoliert ein einzelnes Konto; seine Freigabe verlangt `RELEASE ACCOUNT KILL SWITCH`, zwei erzwungene Reconciliations, einen neuen Kontostand und einen ausdrücklichen Sicherheitsnachweis. Zwei erfolgreiche HTTP-/Abgleichantworten allein reichen nicht.

### Nachgewiesene Kontoentsperrung (lokaler Audit-Entwicklungsstand)

Der Freigabenachweis ist an Kontoidentität, Credential-Generation, Kontoversion und Operator-Sperrgeneration gebunden. Er prüft frische vollständige Quellen für Orders, Positionen und das benötigte Fill-Zeitfenster, offene Schreiboperationen, eigene Entry-Verpflichtungen, ungeklärte Remote-Ereignisse, fremde Positionen/Orders, kritische Risiken und tatsächliche eigene Stop-Restdeckung. Der Kontostand muss aktuell und gültig vorliegen. Fehlende, veraltete oder unvollständige Belege liefern konkrete Codes wie `ACQUISITION_MISSING`, `SOURCE_ORDERS_INCOMPLETE`, `FILL_BASELINE_UNPROVED` oder `POSITION_NOT_PROTECTED`; das Konto bleibt gesperrt.

Prüfung und Entsperrung teilen sich eine Datenbanktransaktion unter der Kontensperre. Eine zwischenzeitliche Kontoveränderung oder erneute Operator-Sperre verhindert die Freigabe, auch am letzten Schreibschritt. Terminale klassifizierte Historie allein ist kein offener Auftrag; eine noch eigene belegte, ausreichend geschützte Position darf bestehen bleiben. Paper liest seine vollständigen Order-/Positions-/Fill-Tabellen jetzt innerhalb einer gemeinsamen Transaktion. Das ist keine Zusicherung eines atomaren Snapshots einer echten Börse.

Die globale Freigabe verlangt im Dialog die exakte Eingabe `RELEASE GLOBAL KILL SWITCH`. Alle aktivierten Konten sowie deaktivierte Konten mit noch offenen Verpflichtungen, Positionen oder ungeklärten Ereignissen gehören zur Prüfung. Ungenutzte deaktivierte Konten werden weder aktiviert noch zur Einrichtung gezwungen. Die relevanten Konten werden in stabiler Reihenfolge gesperrt, frisch abgeglichen und einzeln mit demselben Account-Release-Proof geprüft. Kontenbestand, Versionen, Sperrgenerationen, Quellen und Frische werden vor dem Commit nochmals geprüft; ein Konflikt rollt Freigabe und positiven Journaleintrag `GLOBAL_KILL_SWITCH_RELEASE_PROVED` gemeinsam zurück. Einzelne Kontosperren bleiben unverändert. Die globale Freigabe startet die Ausführung **nicht** automatisch. MCP erreicht diesen Pfad nur über den bestehenden vom Operator genehmigten Vorschlag.

Ein deaktiviertes Konto mit bestehender eigener Position bleibt auch beim Start und im regelmäßigen Schutzlauf berücksichtigt. Dadurch wird weder das Konto reaktiviert noch ein neuer Trade freigegeben. Sauber stillgelegte Konten mit ausschließlich abgeschlossener Historie werden nicht mehr angesprochen; verbleibende Verpflichtungen oder ungeklärte Fehler eines widersprüchlichen Altbestands bleiben dagegen sichtbar und sperren die Freigabe.

Auch als abgeschlossen markierte alte Trades brauchen eine belegte eigene Nullbilanz. Fehlende Entryhistorie, widersprüchliche kumulative Ausführung oder eine angeblich geschlossene Position mit Restmenge verhindern Account-/Global-Freigabe mit konkreten historischen Reason-Codes. Ein sauber belegter alter Roundtrip wird hingegen nicht mit einer späteren offenen Position desselben Symbols verwechselt. Bei der einzelnen Kontofreigabe werden Frische und erwartete Kontoversion auch nach dem Freigabe-Write innerhalb derselben Transaktion erneut geprüft.

Der gemeinsame Proof-Baustein wird für neue Entry-Zulassung, Account-/Global-Freigabe, den nachgelagerten Operator-/TTL-Entry-Abbau, den transaktionalen Trade-Abschluss und den abschließenden Positionsschutz verwendet. Monitoring liest den identischen gespeicherten `positionProtected`-Nachweis; ein lokaler offener Stop allein hält den Schutzstatus nicht auf Grün. Nach spätestens 30 Sekunden, einem neuen noch unbeantworteten Accountread, einer Konto-/Sperrgenerationsänderung, relevanter lokaler Änderung oder DB-Neuöffnung ist frische Bestätigung nötig. „Nicht frisch bewiesen“ bedeutet dabei nicht automatisch „Stop fehlt“ und ist kein Flattenauftrag.

Eigene risikoreduzierende Schutzaktionen bleiben vor der abschließenden Gesundheitsentscheidung verfügbar: Unvollständige historische Quellen oder unbekannte Geldbewertung ersetzen keinen positiven Schutzbeweis, entfernen aber auch keinen nachweisbar eigenen Stop. Ein exakt belegter, tatsächlich nie gesendeter Plan ohne Exposure hat noch keine bestehende Schutzpflicht; alte unklare Dispatches fallen nicht unter diese Ausnahme. Externe Konto-Baselines, Provider-Retention, vollständige frische Provider-Pagination und echte Abnahme bleiben Pflichtaufgaben. Ein unbekannter Quellenstatus wird nicht durch zwei gleiche Antworten geheilt; dieser lokale Stand ist keine Produktionsfreigabe. Details: [003 Schutzprojektion](../plans/003-PROTECTION-IMPLEMENTATION-NOTES.md).

### Nachgewiesene Entry-Zulassung (lokaler Audit-Entwicklungsstand)

Vor einer neuen Order wird das ganze Konto frisch abgeglichen. Balance, Kontoidentität, eigene bestehende Positionen samt Schutz, Orders/Fills, historische Nullbilanzen und offene Fehler müssen zusammen passen. Fehlende oder unvollständige Quellen sperren den neuen Einstieg mit `ENTRY_SAFETY_UNPROVEN`; transiente Executorfehler bleiben davon getrennt. Der letzte Datenbankcheck unmittelbar vor dem geschützten Versand wiederholt Risiko- und Accountnachweis. Auch eine zwischenzeitliche Kontenänderung, ein neu eingetragenes kritisches Risiko oder eine inzwischen zu alte Quelle verhindert den Versand.

Die eigene noch ungesendete Vorbereitung zählt dabei nicht fälschlich als ungeklärte Börsenorder: Dafür müssen Plan, lokale Nullfüllung, Request und Journal exakt zusammenpassen. Nach einem Neustart kann eine wirklich ungesendete Vorbereitung fortgesetzt werden; möglicherweise schon gesendete Versuche werden nicht wiederholt. Diese Ausnahme gilt ausschließlich für den aktuellen Kandidaten, niemals für andere ungeklärte Trades. Ein bestehender sauber geschützter Trade verhindert weitere zulässige Trades nicht. `ENTRY_SAFETY_PROVED` dokumentiert nach dem bestätigten geschützten Versand den verwendeten Nachweis; spätere Schutz- und Abschlussprüfungen bleiben eigenständig.

Fehlt inzwischen die ursprüngliche Runtime-, Konto- oder Routenfreigabe, beendet der Wiederanlauf eine nachweislich nie gesendete Vorbereitung auch im reinen Schutzbetrieb lokal. Dafür werden Originalrequest, Konto-/Credentialbindung, Generation und lokale Orders gemeinsam geprüft; ein beschädigtes oder möglicherweise schon gesendetes Journal bleibt ungeklärt. Dies ist kein allgemeines Stornieren bereits gesendeter Entries beim Pausieren. Die begrenzte Nacharbeit rotiert durch den Altbestand, damit unklare frühe Einträge andere sichere lokale Bereinigungen nicht dauerhaft verdrängen.

### Dauerhafter Entry-Abbau (lokaler Audit-Entwicklungsstand)

Kill-Switch und „Entries abbrechen“ erfassen auch Entry-Verpflichtungen bei noch leerer lokaler Position. Der Abbruchwunsch wird vor dem Börsenaufruf gespeichert und bei der Kontenüberwachung fortgesetzt. Eine offene Cancel-Antwort oder ein Timeout bedeutet **weiter ungeklärt**, nicht „alles storniert“. Die Sperre bleibt bestehen; bei der globalen Aktion werden andere Konten trotzdem bearbeitet. Pro Konto/Durchlauf werden höchstens fünf Verpflichtungen bearbeitet, mit zehn Sekunden Abstand je Verpflichtung. Ein erneuter Cancel derselben Order benötigt einen neuen exakten aktiven Orderbeleg, keine bloße leere Liste.

„Ausführung aus“ und „Live aus“ sperren neue Entries; sie bedeuten weder Entry-Cancel noch Flatten. Kill ist Entry-Abbau, nicht automatisch Positionsschließung. Operator-Flatten speichert für alle ausgewählten Konten zuerst den Emergency-/Entry-Abbauwunsch, auch bei Positionsmenge null. Ein ungeklärter Entry-Cancel verhindert nicht die Reduktion einer unabhängig frisch belegten eigenen Menge. Die Aktion bleibt aber ungeklärt, solange ein Entry nachfüllen oder eine Order unaufgelöst sein kann. Weitere eigene Fills werden unter einer neuen dauerhaften Flatten-Generation reduziert; ein möglicherweise bereits gesendeter Flatten wird nicht blind wiederholt. Fremde Mehrmengen werden weder übernommen noch reduziert. Keine produktive Sicherheitsfreigabe aus diesem Entwicklungsstand ableiten.

Der lokale Abschluss verlangt terminale Entries, terminale eigene Exit-Siblings, geklärte Schreiboperationen und eine belegte eigene Nullbilanz. Übrige eigene Exits werden vor Abschluss bereinigt und danach frisch abgeglichen. Ein gefüllter Stop allein beendet keinen weiterhin offenen Entry. Der gemeinsame `tradeClosed`-Nachweis ist in die Transaktion eingebunden; vollständige Provider-Quellenabdeckung und die gemeinsame Abschlussprüfung bleiben zusätzliche Audit-Arbeiten.

Teilweise ausgeführte Stops bleiben Schutzorders, wenn Konto-/Trade-Zuordnung, Symbol, Gegenseite, Reduce-only, Trigger und positive Restmenge belegt sind. Benötigt wird die aktuelle eigene Menge plus noch ausführbare Entry-Reste. Bereits ausgeführte Stop-Mengen zählen nicht erneut als Schutz. Engine und lokale Betriebsanzeige verwenden dieselbe Mengen-/Semantikprüfung; die Anzeige ist der zuletzt gespeicherte Stand und kein aktueller Freigabebeweis. Ein bereits nachgezogener Stop wird beim Ersatz einer fehlenden Order nicht gelockert. Ausführung einer Ersatzorder oder Stornierung eines alten Stops verlangt vor weiteren Änderungen einen frischen Abgleich; ein Durchlauf liest höchstens drei Snapshots.

Das Paper-Modell bucht Teilfüllungen kumulativ mit gewichtetem Durchschnittspreis und jeweils eigener Fill-ID. Test-Fixtures können deterministische Mengenlimits sowie „Reduce-only-Rest behalten“ oder „bei Nullposition stornieren“ wählen. Standard bleibt unmittelbare Ausführung ohne künstliches Liquiditätslimit und Stornierung überhängender Reduce-only-Reste bei Nullposition. Eine nur teilweise ausgeführte und anschließend stornierte Order wird nicht als vollständig gefüllt ausgegeben. Diese Simulationsvarianten sind kein Nachweis identischer Regeln einer echten Börse.

### TP-Restverteilung (lokaler Audit-Entwicklungsstand)

TP-Mengen verwenden belegte eigene Fills und die aktuelle Restposition. Nach Stop-/anderen eigenen Exit-Teilfüllungen wird nur das noch unverbrauchte TP-Budget proportional verkleinert. Bereits erledigte gespeicherte Zielbudgets werden nicht wieder aufgefüllt. Preise bleiben unverändert; Rundungsreste unter dem Mengenschritt werden separat gespeichert. Ein auf null gerundetes Restbudget allein beweist keinen TP-Treffer und darf keinen zusätzlichen adaptiven Stop-Schritt auslösen.

Nach einem TP-Cancel gibt es vor jeglicher Ersatzorder einen neuen Account-Abgleich. Eine unvollständige Cancel-Antwort oder fehlende passende Fill-Evidenz bleibt ungeklärt. Auch wenn ein neuer TP sofort ausgeführt wird, werden weitere Ziele erst nach neuem Abgleich bearbeitet. Gespeicherte Generations-IDs und das Operationsjournal verhindern blindes Wiederholen nach Neustart. Benötigt ein nachweislich vorankommender Ablauf mehr als drei Snapshots, setzt er im nächsten begrenzten Durchlauf fort; Neueinstiege bleiben bis zum erfolgreichen Abgleich blockiert, ohne allein deshalb einen harten Kill-Switch auszulösen.

Die TP-Verteilung ist an den unveränderten Tradeplan gebunden. Fehler darin isolieren das Konto, dürfen jedoch nicht die unabhängige Verwaltung belegbar eigener Schutz-Stops abschalten.

Fehlen einem Alt-Trade die TP-Metadaten, wird nicht pauschal die ursprüngliche Gesamtverteilung neu erzeugt. Ein vollständig ungesendeter Originalplan kann initialisiert werden. Bereits laufende Ziele benötigen exakte aktuelle Orderbelege; ein erledigtes kleineres Ziel benötigt vollständige eigene Fills und eine eindeutig abschließende Ordergeneration. Preise, Requests und Zielzuordnung müssen unverändert nachvollziehbar sein. Die Wiederherstellung protokolliert `TP_ALLOCATION_RECOVERED` mit den zugrunde liegenden Orders/Budgets. Ein erledigtes kleineres Ziel wird nicht noch einmal gehandelt.

Ein abgebrochenes Ziel ohne eindeutigen Nachfolger, widersprüchliche Requests, unaufgelöste Operationen oder mehrdeutige Abschlussreihenfolge bleiben `TP_ALLOCATION_REVIEW_REQUIRED`. Dabei werden keine fehlenden TP-Budgets geraten und keine fremden Orders übernommen. Eine reine Quittierung ist kein Ersatz für den fehlenden Beleg; Wiederherstellung eines unabhängig bewiesenen eigenen Stops bleibt möglich. Weitere Legacy-Restore-/Pending-Generationsfälle und die vollständige Provider-Baseline-Prüfung sind offen. Dies ist noch keine Produktionsfreigabe.

### Vollständige aktuelle Kontobereiche (lokaler Audit-Entwicklungsstand)

Der Executor liest aktuelle Orders und Positionen getrennt von der historischen Nachladung. Bybit wird über alle Cursorseiten der linearen Settlement-Bereiche gelesen (mindestens USDT und USDC); zusätzliche inverse/Optionspositionen sowie Spot-/inverse/Optionsorders werden nicht still ausgeblendet. Nicht vom Ausführungsprofil verwaltbare Exposure verlangt eine ausdrückliche Kontoprüfung, ohne sie zu übernehmen oder zu schließen. Konditionale Orders werden nicht durch einen Ordertyp-Filter ausgeschlossen.

Kraken Futures liefert accountweite Listen, deren Antwortsammlungen und Providerzeit geprüft werden. Bei Hyperliquid wird zuerst die Liste der Perpetual-DEX-Bereiche ermittelt; anschließend werden Positionen und offene Orders je Bereich gelesen. Coin-Präfix und angefragter DEX müssen übereinstimmen. Das erweitert nicht automatisch die ausführbaren Produkte oder die Symbolauflösung.

Die aktuelle Abfrage hat maximal 64 SDK-Aufrufe innerhalb der vorhandenen absoluten Deadline und behält mindestens eine Sekunde Antwortreserve. Fehlende Seiten, erschöpftes Budget oder veraltete Providerzeit liefern keinen leeren Erfolgs-Snapshot: `CURRENT_STATE_INCOMPLETE` mit HTTP 503 blockiert Neueinstiege vorübergehend. Fehlende Pflichtfelder, wiederholte Cursor oder widersprüchliche Kontobereiche sind Vertragsfehler. Die fünf zusätzlichen Recovery-/Historienaufrufe bleiben separat begrenzt. Allgemeine CCXT-Fallbacklisten ohne belegte Pagination bleiben ausdrücklich `unknown`.

Die bereinigten Bereichs-/Seitenbelege werden mit der Acquisition-Evidenz gespeichert und über Neustarts erhalten. Sie belegen Traversierung, keine Atomizität zwischen REST-Endpunkten und keine vollständige historische Fill-Baseline. Die Freigabe darf deshalb nicht allein auf diesen neuen Listen beruhen. Eine Remote-Position muss zudem exakt zum Provider-Markt ihrer ausgeführten eigenen Entry-Orders gehören: gleicher Coin, gleiche Richtung und gleiche Menge genügen bei abweichendem Settlement oder Kontrakt nicht.

### Ausgangsbasis für alte Fremdtrades (lokaler Audit-Entwicklungsstand)

Ein altes fremdes Ereignis darf nicht allein wegen seines Alters verschwinden. Für seine Einordnung wird eine Konto-Baseline gespeichert: zwei vollständige, frische und nicht überlappende aktuelle Beobachtungen zeigen keine Position und keine aktive Order. Parallel müssen die eigenen gespeicherten Orders, Fill-Bilanzen und Operationen vollständig beendet sein. Kontobindung und eigene Mengen-/Marktbelege müssen passen. Der Nachweis erscheint als `ACCOUNT_BASELINE_ESTABLISHED` im Journal.

Eindeutig identifizierte fremde Ereignisse vor dieser Grenze bleiben als externe Historie gespeichert. Sie werden nicht zu eigenen Trades oder PnL. Ereignisse ab der Grenze, Konflikte, fehlende Identitäten/Zeitpunkte und alte Belege ohne nachgewiesene Kontobindung bleiben ungeklärt. Weitere leere Snapshots verschieben die Grenze nicht. Ein Neustart erhält den Nachweis; neu gefundene eigene historische Orders müssen erneut abgeglichen werden und können das Prüfungsfenster nach hinten erweitern.

Das Verfahren hebt keine Kontosperre auf und erteilt keine Handelsfreigabe. Insbesondere müssen die vollständige laufende Fill-Historie, Schutzprüfung und ausdrückliche Kontofreigabe unabhängig davon bestehen. Dieser lokale Entwicklungsstand ist noch nicht zur Ausrollung freigegeben.

## Betrieb, Journal und Analytics

### Geldbewertung und Neueinstiege (lokaler Audit-Entwicklungsstand)

Ein positives Fee-Feld bedeutet Kosten, ein negatives Fee-Feld einen Rebate; der signierte Cashflow ist die sichere Negation dieses Betrags. Das neue Ledger speichert Originalereignis und Währung getrennt von einer späteren Bewertung. Identische Wiederholungen buchen nicht doppelt; Widersprüche bleiben gespeichert. USDT, USDC und USD sind unterschiedliche Währungen. Nichtnullgebühren ohne Asset oder ohne belegten Ereigniskurs bleiben ungeklärt, ebenso Funding-Fehler oder unvollständige Seiten.

Neue Entries benötigen frische, kontogebundene Reporting-/Funding-Evidenz; ungeklärte Geldbeträge sperren nur das betroffene Konto für neue Entries. Bestehende Stops, Cancels, Flatten und Abstimmungen bleiben verfügbar. Bybit-Account-Gesamtsummen werden in ihrer dokumentierten Einheit USD übernommen. Ohne erlaubte Live-Bewertung wird ein Fremdasset nicht auf 1:1 gesetzt. Paper verwendet ein ausdrücklich simuliertes USDT-Reporting und hat keine Fundingzahlungen.

Die lokale Erweiterung erlaubt ausschließlich belegte Umrechnungen zwischen USD, USDT und USDC. Für das unterstützte Bybit-Profil werden feste, konten-/profilgebundene Originalquellen verwendet; der jüngste kohärente Kurs muss vor oder am Geldereignis liegen und höchstens zehn Sekunden alt sein. Die Zeiten der einzelnen Quellen dürfen höchstens eine Sekunde auseinanderliegen. Eine Provider-Antwortzeit ist dabei ausdrücklich kein Beweis der ursprünglichen Tickzeit. Fehlende alte Kurse werden weder aus heutigen Preisen rekonstruiert noch durch Stablecoin-Parität ersetzt. Automatische Nachbewertung nutzt ausschließlich bereits gespeicherte passende Originale.

Rationale Geldwerte bleiben exakt, auch wenn sie nicht als endlicher Dezimalstring darstellbar sind. Der alte Dezimalwert darf dann leer sein, ohne dass der Betrag Null oder zwangsläufig ungeklärt wäre. Nur bei nachgewiesenem Größenlimit einer Summe werden konservative Unter-/Obergrenzen verwendet. Journal, Analytics und Benachrichtigungen geben Währung und Bewertungsstatus mit aus; ein `≈` in der Oberfläche bezeichnet nur die Anzeige, deren Details den exakten Bruch enthalten. Ungeklärte oder gemischte Summen werden nicht als Null dargestellt; Diagramme trennen Währungen und lassen nicht abschließend bewertete Punkte weg.

Sizing rechnet Kapital und Kaufkraft von der Kontoreportingwährung in das Settlement des gewählten Marktes um. Absolute Notional-Grenzen und Exchange-Tiers bleiben in ihrer ausgewiesenen Settlement-Einheit. Die endgültige quantisierte Menge und Stopdistanz werden für den Risikovergleich wieder in Kontoeinheiten bewertet. Gespeicherte Pläne behalten ihre ursprünglichen Kursbelege; erneutes Lesen der Originale und ein letzter synchroner Frischecheck liegen vor dem Versand. Ein neuer Kurs ersetzt nicht unbemerkt einen vorbereiteten Plan. Die gewünschten Marginprozente, Signalpreise, Stopregeln und Hebelobergrenzen werden dadurch nicht geändert.

Eigene Fills erzeugen Gebühren-/Rebatebuchungen sofort, auch bei noch offener Position. Teilverkäufe buchen realisierte Preis-PnL am tatsächlichen UTC-Ausführungszeitpunkt. Lineare Kontrakte benötigen belegtes Settlement und bereits in Basismenge normalisierte Fills; das Gebührenasset oder ein Symbolsuffix genügt dafür nicht. Die genaue fortgeschriebene Kostenbasis benutzt nur zeitlich davor bewiesene Entries. Nicht exakt darstellbare Kostenaufteilungen oder eine unbelegte Reihenfolge gleichzeitiger Ein-/Ausstiege bleiben ungeklärt, statt still gerundet zu werden.

Tagesverlustprüfung, Positions-/Intentansichten, Journal und Analytics verwenden denselben Ledger: heutige Preis-PnL plus heutige signierte Fees/Rebates/Funding und aktuelle offene Unrealized-PnL. Funding wird nicht nochmals aus dem Remote-Summenfeld addiert. Rollierende 24-Stunden-Analytics und ein UTC-Kalendertag sind unterschiedliche Filter auf dieselben Ereigniszeiten. Währungen werden getrennt dargestellt; eine gemischte oder ungeklärte Gesamtsumme ist kein Nullbetrag. Gewinn-/Verlustquoten abgeschlossener Trades beziehen sich weiterhin auf deren vollständige belegte Lebenszeit.

Migration 36 plant begrenzte, wiederaufnehmbare Nachbearbeitung. Nur vorhandene, kontogebundene Originalbelege werden nachgebucht. Alte Paper-Fills benötigen zusätzlich die exakt passende ursprüngliche simulierte Order-/Fillquelle. Fehlt die alte Kontobindung, das Asset oder der Ereigniskurs, bleibt der Bereich ungeklärt; alte Positionswerte und widersprüchliche Buchungen werden nicht gelöscht. Eine ausstehende Nachbearbeitung erteilt keine Entryfreigabe.

Die aktuelle Reserve verwendet eigene belegte Restmenge × zusätzlichen Verlust vom Mark bis zum tatsächlich gedeckten Stop, zuzüglich noch ausführbarer Entry-Reste × Verlust vom ursprünglichen Limit-/IOC-Grenzpreis bis Stop. Bereits im Unrealized enthaltene Verluste werden nicht nochmals als volle Entry-zu-Stop-Distanz addiert. Die tatsächliche Fill-zu-Stop-Distanz bleibt als Diagnose sichtbar. Neue Kandidaten zählen mit ihrer endgültigen quantisierten Menge und tatsächlichem erlaubtem Preis, nicht pauschal mit dem konfigurierten Planrisiko. Unklare Fills, Cancels, Stops, Markt-/Währungsbelege, ein UTC-Wechsel oder veraltete Belege erlauben keine Freigabe der Reserve.

Die Reserve samt Konto-/Credentialbindung, Sperrgeneration, Zeitfenster, Quellenhash und Ledgergeneration wird dauerhaft abgeleitet; der ursprüngliche Plan bleibt erhalten. Nach vollständiger Schutzabstimmung erfolgt bei eigenen Verpflichtungen genau ein begrenzter aktueller Kontostand-Abruf. Eine belegte Budgetüberschreitung fordert dauerhaft den sicheren Entry-Rest-Cancel an; der nächste reguläre Lifecycle-Pass teilt das bestehende Cancelbudget. Stopverwaltung läuft weiter, eine zweite pauschale Liquidation wird nicht eingeführt. Unmittelbar vor Dispatch werden nach dem dauerhaft geschriebenen Journal die Quellen unter einer kurzen Datenbanksperre erneut geprüft; Netzwerkwartezeit hält diese Sperre nicht.

Paper meldet aktuelle Mark-PnL und Equity einschließlich dieser PnL; tatsächlich gebundene Margin bleibt unverändert. Fehlender Mark oder nichtpositive Equity erzeugt keine erfundene sichere Kontozahl. Offene Positionsmengen bleiben für Schutzabstimmung auch bei unbekannter Bewertung verfügbar.

Funding wird über dauerhaft gespeicherte Quellseiten nachgeladen. Orderwiederherstellung, Modusbeleg, Geld- und Order-/Fillhistorie teilen höchstens fünf zusätzliche Abrufe und dieselbe Deadline. Originalseiten, jedes Rohvorkommen und getrennte Auswertungsstände werden vor dem Cursor atomar gespeichert. Neustart und UTC-Wechsel verlieren keine alten Fenster; aktuelle/vorherige UTC-Tage werden wiederholt gelesen und ältere Fenster zusätzlich fair durchlaufen. Historische Provider-IDs bleiben beim Nachbuchen erhalten.

Der finanzielle Nachweis ist ausdrücklich eine zeitgebundene Beobachtung (`provider_as_observed`, mögliche Lieferverzögerung), keine garantierte Kontofinalität. Neue oder widersprüchliche Quellseiten invalidieren ältere Risikonachweise. Ein nachgelieferter negativer Fundingbetrag wirkt an seinem ursprünglichen Ereignistag; eine aktuelle Budgetüberschreitung fordert den Entry-Rest-Drain an, nicht die Entfernung des Stops. Historien-EOF allein beweist niemals den negativen Ausgang eines Order-/Cancelversuchs.

Native Hyperliquid-USDC-Fundingbeträge und reine Preis-PnL sind belegbar, wenn die originalen Clearinghouse-Positionswerte exakt zusammenpassen; kumuliertes Funding wird nicht in die Preis-PnL gemischt. Fehlende oder widersprüchliche Werte, nicht belegtes HIP-3-Collateral und unbekannte Währungskurse bleiben ungeklärt. Bybits UNIFIED-Quelle benötigt einen belegten post-UTA2-Ursprung für den Finanzzeitraum; sie beweist keine Null vor einer unbekannten Umstellung oder außerhalb ihrer dokumentierten Aufbewahrung.

Offen bleiben nicht zertifizierte Live-Fremdassetkurse sowie Kraken-Gesamtaccount-Reporting und ungeklärte Cash-/Positionsbeziehungen. Solche Bereiche werden konkret ausgewiesen und erlauben keine neuen Entries. Ein vollständig bewerteter oder leerer Ledger beweist keine vollständige Providerhistorie. Diese Entwicklungsstufe ist keine Livefreigabe.

Adaptive Kanal-/Pfadentscheidungen verwenden dieselben belegten Geldwerte und vergleichen die Schwelle exakt gegen das gebundene Kapital; eine gerundete Prozentanzeige entscheidet nicht über die Risikostufe. Frühere Auswertungen behalten ihre Originalwerte. Ändern sich ihre Quellen durch verspätete Gebühren oder einen ursprünglichen Kurskonflikt, werden sie als ungültig gekennzeichnet; Automatic bleibt bis zu einer ausdrücklich neuen Policy gesperrt. Shadow zeigt die Unsicherheit ohne automatische Risikosteigerung, manuell feste/gelockte Einstellungen bleiben eigene Entscheidungen. Historische Auswertungen ohne Quellenbeleg werden nicht nachträglich zu belegten Freigaben erklärt. Konten mit verschiedenen Reportingwährungen werden nicht zu einer scheinbar einheitlichen Kanalperformance addiert.

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
