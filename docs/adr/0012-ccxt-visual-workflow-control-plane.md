# ADR 0012: CCXT-Ausführung und visuelle Workflow-Control-Plane

Status: akzeptiert 24.08.2026

## Kontext

Die bisherige Ausführung besaß börsenspezifische SDK-Adapter und ordnete einen Telegram-Kanal genau einer Strategie und einem Konto zu. Die maximale Positionszahl lag in der Strategie. Dadurch konnte dieselbe Kontogrenze bei mehreren Strategien nicht zuverlässig durchgesetzt werden; außerdem war eine parallele, unterschiedlich gewichtete Ausführung desselben Signals auf mehreren Konten nicht modellierbar. Die Web-Oberfläche verteilte einen fachlich zusammengehörenden Ablauf auf viele Menüs.

Als Referenz für die neue Interaktion wurde `kanbn/kan` untersucht. Der untersuchte Stand `0e1f25f` steht unter AGPL-3.0. TSX Core übernimmt deshalb weder Quellcode noch Assets. Verwendet werden ausschließlich allgemeine Produktmuster – Spalten, Karten, Detaildialoge und eine visuelle Arbeitsfläche – in einer eigenständigen Implementierung mit React Flow.

## Entscheidung

### Exchange-Grenze

- Das interne Python-Sidecar verwendet ausschließlich `ccxt==4.5.75` einschließlich des im Paket enthaltenen CCXT Pro.
- Die implementierungsseitige Fail-Closed-Allowlist umfasst zunächst Hyperliquid, Bybit und Kraken Futures; Paper Trading bleibt ein interner deterministischer Adapter. Der interne Bezeichner `CERTIFIED_EXCHANGES` meint ausschließlich diese statisch und durch Contracttests abgesicherte Implementierungsfreigabe. Er ist kein Testnet-, Staging- oder Produktionsnachweis; dieser muss je Börse und Markttyp vor einem Live-Cutover separat erbracht werden.
- REST ist die einzige Autorität für Orders, Positionen, Fills, Kontostand und Reconciliation. CCXT Pro beschleunigt private Order-/Trade-/Positionsereignisse und öffentliche Marktdaten, darf aber den persistenten Zustand niemals direkt ändern.
- Jede relevante Stream-Nachricht stößt lediglich eine erzwungene REST-Reconciliation an. Cursorlücken oder Streamausfall degradieren die Beschleunigung, nicht die REST-Schutzschleife.
- Markt-, Preis-, Mengen-, Contract-Size-, Trigger- und Reduce-only-Unterschiede werden an der CCXT-Grenze normalisiert. Client-Order-IDs bleiben deterministisch.
- Ein geschützter Entry wird als validiertes Zweierpaket aus Entry und gleich großem Reduce-only-Stop über `createOrders` gesendet. Vor Leverage- oder Ordermutation muss ein autoritativer REST-Snapshot für Konto/Symbol exakt null Exposure zeigen. Ein unvollständiges oder transportseitig unbekanntes Ergebnis löst eine zeitlich getrennte Notfallbereinigung aus. Weil der Null-Exposure-Preflight bereits bestanden hat, darf diese Bereinigung nur danach neu entstandene Exposure reduzieren und kann keine vorherige manuelle oder fremde Position schließen; anschließend bleibt der Ausgang bis zur REST-Reconciliation fail-closed.
- Hyperliquid-Builder-Fees sind ausdrücklich deaktiviert. Zugangsdaten werden weiterhin write-only verwaltet; stabile Kontoidentität und Secret-Fingerprint sind getrennt, damit Secret-Rotation erlaubt, Konto-Rebinding aber gesperrt bleibt.

### Kontoweite Kapazität und Fan-out

- `maxConcurrentPositions` gehört zum konkreten Börsenkonto und ist dort zwischen 1 und 20 konfigurierbar.
- Die Engine zählt sämtliche verwalteten Positionen eines Kontos unabhängig von Kanal, Strategie oder Workflowpfad. Ein Konto/Symbol bleibt zusätzlich exklusiv.
- Ein Kanal darf in mehrere vollständige Ausführungspfade verzweigen. Jeder Pfad besitzt eigenes Konto, Strategie, Sizing und optional eigenes adaptives Risiko.
- Fehler, Sperre oder fehlende Bereitschaft eines Pfads dürfen andere Kontopfade nicht zurückrollen. Deduplizierung, Parser, Schema und Vertrag werden bei identischer Konfiguration gruppiert, sodass ein Signal nur einmal geparst und danach kontrolliert aufgefächert wird.
- Adaptiver Zustand ist durch Kanal, Konto und logischen Risiko-Baustein isoliert. So kann derselbe Kanal beispielsweise auf Hyperliquid starr mit 10 Prozent Margin und auf Kraken adaptiv ab 5 Prozent laufen.

### Visueller Builder

- Die bisherige Trading-Navigation wird durch einen globalen Workflow-Builder ersetzt.
- Fachliche Aspekte sind typisierte, versionierte Bausteine: Kanal, Inhaltstyp, Schlüsselwörter, Regex, Parser, Schema, Vertrag, Duplikatschutz, Strategie, Positionsgröße, adaptives Risiko, Börsenkonto und Ausgabe.
- Der Duplikatschutz verwendet den SHA-256-Hash der unveränderlichen Parser-/Schema-/Vertrags-/Dedupe-Pfadgruppe als Bereich. Unterschiedliche Pfadgruppen desselben Telegram-Signals bleiben unabhängig ausführbar.
- Spalten bilden die feste Verarbeitungsreihenfolge. Karten sind innerhalb ihrer Spalte vertikal verschiebbar; gerichtete Verbindungen bestimmen Verzweigung und Wiederverwendung.
- Veröffentlichte Bausteine können aus einer Bibliothek wiederverwendet werden. Änderungen erzeugen immutable Versionen. Strategie- und Vertragsdefinitionen sowie Parser-Prompts werden im jeweiligen Dialog bearbeitet; der konkrete Parser-Prompt wird mit der Ressourcenrevision gespeichert und gehasht. Globale Template-Änderungen können einen aktiven Pfad deshalb nicht nachträglich verändern. Nicht editierbare serverseitige Schutzregeln werden erst bei der Ausführung angehängt. Ein verwendetes Schema wird bei fachlicher Änderung unter einer neuen ID angelegt.
- Ein vollständiger Pfad endet am Kontobaustein, optional gefolgt von Ausgabe. Unvollständige Pfade sind sichtbar, aber inert.
- Graphen sind typisiert, azyklisch, links-nach-rechts, begrenzt und revisionsgebunden. Aktivierung ist atomar und verwendet optimistische Revisionserkennung. Jedes Hinzufügen, Ändern oder Entfernen eines ausführbaren Pfads benötigt die exakte, serverseitig ausgegebene Bestätigung `ACTIVATE WORKFLOW IMPACT`; die UI setzt sie nie selbst ein.
- Signalverträge sind im Workflow echte unabhängige Bausteine. Das Schema bestimmt die Parserform; der verbundene veröffentlichte Vertrag bestimmt die konkrete deklarative Definition. Das im Schema gespeicherte Vertragsfeld bleibt nur der Legacy-/Nicht-Workflow-Default.
- Bestehende aktivierte Kanalrouten werden beim ersten Start verlustfrei in eine visuelle Revision migriert. Ab diesem Zeitpunkt ist die aktive Workflowrevision die Quelle für Telegram-Quellen und Ausführungspfade.

### Betrieb

- Live-Steuerung, Konten, Journal, Analytics, Logs, Backups, MCP und System bleiben in einem integrierten Betriebsbereich des Builders erreichbar.
- Parser-Signale werden ausschließlich in SQLite gespeichert. Workflow-Parser erzwingen `saveToFile=false`; der Standard der globalen Konfiguration ist ebenfalls `false`.
- MCP kann Workflowressourcen und Revisionen lesen sowie über denselben Preflight-/Freigabeweg ändern; es umgeht weder Audit noch Trading-Sicherheitsgates.

## Migration und Cutover

Migration 15 legt Workflowressourcen/-revisionen/-pfade, kontoweite Positionslimits, Kontosperren, Fähigkeiten, Reconciliation-Metadaten, Kraken Futures und die Workflow-Provenienz der Intents an. Migration 16 isoliert adaptiven Zustand pro Workflowpfad.

Das Schema-Upgrade und die Alt-Routen-Migration verändern keine offenen Exchange-Positionen. Ein Produktions-Cutover erfolgt separat: Backup und Restore-Probe, Ausführung stoppen, Entries stornieren, betroffene Konten vollständig reconciliieren, offene Positionen nach gesonderter Operatorfreigabe auf der Exchange schließen, neue Images starten, zwei autoritative Reconciliations pro Konto, anschließend Testnet/Paper und erst danach Live-Gates. Manuelle Exposure auf einem betroffenen Konto wird beim später bestätigten vollständigen Flatten ausdrücklich mit erfasst. Diese ADR autorisiert diesen destruktiven Schritt nicht.

## Konsequenzen

Vorteile sind eine einheitliche Exchange-Grenze, CCXT-Pro-Streamabdeckung, echte kontoübergreifende Fan-outs, korrekte kontoweite Kapitalgrenzen und ein sichtbarer, revisionsfähiger Signalfluss. Kosten sind eine größere Abhängigkeit von CCXT-Normalisierung, notwendige Zertifizierung je Exchange/Markttyp und die Pflicht, CCXT-Upgrades wie eine Provider-Migration zu testen und zu pinnen.

Rollback erfolgt über den vorherigen Image-Digest und das vor Migration/Cutover verifizierte Backup. Da neue Workflowrevisionen alte Revisionen und Ressourcen nicht überschreiben, kann die vorherige fachliche Definition nachvollzogen werden; offene Exchange-Exposure bleibt jedoch immer über REST zu reconciliieren und darf nicht durch einen reinen Datenbank-Rollback angenommen werden.

## Ergänzung 2026-09-02: getrennte Abnahmenachweise

Die vorhandene Implementierungs-Allowlist und ihre statischen Attestationen werden nicht erweitert und bleiben ausdrücklich von realen Providerbelegen getrennt. Der neue [Offline-Nachweisvertrag](../testing/exchange-acceptance.md) bindet Akten an Quell-SHA, CCXT-Pin und Profilhash; synthetische Akten können niemals selbst eine Providerfreigabe erteilen. Ein realer Transport und kontrollierte Provider-Abnahmesequenzen fehlen dem aktuell netzwerkfreien Runner noch. Lokale grüne Tests sind deshalb keine vollständige Umsetzung der echten Abnahme und kein Release-/Rolloutauftrag.

Die API-Key-Bindung von Bybit/Kraken Futures (P1-21) bleibt bestehen. Stabile authentifizierte Account-/Subaccount-Identität und eine separat genehmigte Migration sind Voraussetzungen für einen späteren identitätserhaltenden Keywechsel. Die Prüfung wird nicht gelockert. Mehrere REST-Endpunkte ergeben weiterhin keinen atomaren Snapshot (P1-19); Erfassungsfenster, Vollständigkeit und Konfliktauflösung müssen als solche belegt werden. Backupintegrität, Offsite-Verfügbarkeit und Restore-Eignung (P2-24) bleiben getrennte Nachweise.

## Ergänzung 2026-09-02: beobachteter Modus statt Profilflag

Deklarative Fähigkeiten und aktuelle Konto-/Symbolbeobachtungen sind getrennte Verträge. Generisches Verify liefert ausdrücklich keine pauschale Entry-Erlaubnis. Der neue nur lesende `/v1/entry-constraints`-Vertrag bindet Cross-/One-way-/Leverage-Beobachtungen an bestehende Kontoidentität, Credentialgeneration, Symbol, CCXT-Version, Provider-API und Ausführungsprofilhash. Node prüft vor Vorbereitung, unter dem Coordinator vor Dispatch sowie synchron nach dem letzten Journal-Await; der Executor liest zusätzlich vor dem Entry unter seiner bestehenden Mutation-Lease. Schutz/Reduktion bleiben davon unabhängig.

Bybit/Kraken verwenden authentifizierte Endpunkte. Hyperliquid wird korrekt als `public_bound_account` gekennzeichnet: feste bestehende Wallet-/Credentialbindung, exakter Asset-Readback und Gegenprüfung der Positionen; das ist kein neuer HTTP-Authentifizierungs- oder Agentberechtigungsnachweis. Kraken Cross verwendet keinen Leverage-Setter, dessen Implementierung Isolated aktivieren würde. Moduswechsel sind kein automatischer Reparaturschritt. Keine Erweiterung der alten allgemeinen Implementierungs-Allowlist und keine reale Provider-/Releasefreigabe: [Nachweisgrenzen und Quellen](../../plans/004-MODE-IMPLEMENTATION-NOTES.md).

## Ergänzung 2026-09-03: neue gebundene Implementierungsprüfung, lokaler Zwischenstand

Die ursprünglichen Sieben-Bool-Attestationen sind keine ausreichende Implementierungsfreigabe mehr. Der neue feste Repository-Reviewanker bindet exakte Receiptbytes; die Runtime prüft danach tatsächliche Executor-/SDK-Bytes, Profil und Scope. Root-Node-/Test-/Fixturebindungen müssen separat im vollständigen Buildcheckout geprüft werden und werden im schlanken Executor-Image nicht vorgetäuscht. Ein Artefakt kann weder seinen eigenen erwarteten Approvalhash liefern noch Testkommandos einschleusen.

Der Reviewanker ist derzeit leer: alle drei bisherigen Profile sind in dieser **lokalen Arbeitskopie** bis zum Abschluss der neuen gemeinsamen Abnahme quarantined. Das ist ausdrücklich kein betriebsfähiger Cutover und wurde nicht auf den Server übertragen. Die Erweiterungsinventur enthält 103 CCXT-IDs; keine zusätzliche Börse wurde allein wegen eines Flags freigegeben. Konkrete SDK-/Produkt-/Schutzgrenzen und ungeklärte Kandidaten bleiben getrennt in der [Prüfmatrix](../testing/ccxt-expansion-matrix.md). Konto-/Provider-/Releasefreigabe bleiben unabhängige, separat zu autorisierende Schritte.
