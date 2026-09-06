# TSX Core UI Next – vollständiger Bedien- und Umsetzungsplan

**Prüfstand:** TSX Core 3.3.0, `main`, Commit `93ed1c41ca047c9ffc2af1028de869abd6e9284c`\
**Datum:** 5. September 2026\
**Status:** Spezifikation und quellcodebasierter Ist-/Soll-Abgleich; keine Implementierung, keine Änderung am Repository oder Deployment.

## 1. Entscheidung

Die Vermutung ist in wesentlichen Punkten bestätigt: Die Oberfläche bildet zahlreiche Einstellungen bereits ab, hält aber mit den fachlichen Abläufen und den neueren Sicherheits-, Abrechnungs- und Recovery-Modellen nicht durchgehend Schritt. Das Problem besteht nicht nur aus fehlenden Buttons. Es gibt falsche Statusverträge, nicht dargestellte Datenherkunft, versteckte globale Nebenwirkungen, unvollständige Detailansichten und empfindliche Lade-/Speicherabläufe.

**UI Next soll eine vollständige Bedienoberfläche für die unterstützten Operatorfunktionen werden – nicht ein grafischer Zugriff auf beliebige interne Funktionen.** Neue Einstiege, sichere Reduktion bestehenden Risikos, Konfiguration, Diagnose und Wiederherstellung bleiben getrennte Aufgaben mit unterschiedlichen Voraussetzungen.

Die bestehende Anwendung wird schrittweise weiterentwickelt. React-Oberfläche, vorhandene UI-Komponenten, Design-Tokens, Formlogik und fachlich richtige Schutzmechanismen bleiben Ausgangspunkt. Ein Frameworkwechsel oder vollständiger Neubau ist für dieses Ziel nicht erforderlich. Der Name „UI Next“ ist eine Planbezeichnung, keine bereits veröffentlichte Versionsnummer.

### Was „vollständig“ hier verbindlich bedeutet

Jede unterstützte Operatorfähigkeit erhält entweder eine bedienbare Ansicht/Aktion oder eine ausdrücklich begründete Einordnung als reine Diagnose, Legacy-Funktion, Deployment-Aufgabe, Engineering-Funktion oder unveränderliche Sicherheitsgrenze. Jede editierbare Einstellung erhält ein Feld mit zutreffendem Typ, Einheit, Geltungsbereich und Wirksamkeitszeitpunkt. Jede länger laufende Aktion erhält einen nachvollziehbaren Zustand und einen überprüfbaren Abschluss.

Ein vollständiger Eintrag in dieser Zuordnung ist noch kein Nachweis, dass die Oberfläche funktioniert. Zur Abnahme gehört für die jeweilige Fähigkeit ein Vertragstest und – bei interaktiver Bedienung – ein passender Browserablauf.

## 2. Umfang und Nachweisgrenzen

Für diesen Abgleich wurden 165 Backend-TypeScript-Dateien mit 45.736 Zeilen aus den commitgebundenen CI-Artefakten rekonstruiert und syntaktisch inventarisiert. Die Hauptoberflächen für Builder, Ressourcen, Betrieb, Konten, Journal, Analyse, MCP, Telegram Viewer, System und Anmeldung wurden anhand des aktuellen Repository-Codes untersucht. Die Backend-Handler, Validatoren, Konfigurationsverträge und die vorhandenen internen Diagnosemodelle wurden dazu abgeglichen.

Die Begleitdateien enthalten:

| Bestand | Umfang | Bedeutung |
|---|---:|---|
| Fachliche Arbeitspakete | 72 | Nachvollziehbare Umsetzungseinheiten, keine Anzahl aller Programmfunktionen |
| Authentifiziert registrierte Dashboard-Routen | 106 | Vollständige Zuordnung der erfassten `API_ROUTES`; zusätzlich drei öffentliche Bootstrap-/Session-Routen |
| Runtime-Einstellungen | 35 | Bereits heute explizit oder generisch erreichbar; Erklärung und Wirksamkeit verbessern |
| Workflow-Bausteinarten | 13 | Alle erhalten eine konkrete Bedien- und Abnahmezuordnung |
| Kuratierte Parameter-/Eingabe-/Anzeigefelder | 281 | Enthält auch Read-only- und Legacy-Felder, nicht 281 frei editierbare Einstellungen |
| Literal erkannte MCP-Werkzeugnamen | 48 | Discovery; kein generischer unbeschränkter Tool-Runner |

Die syntaktische Rohinventur erfasst außerdem 2.526 Funktions-/Methodendeklarationen und 3.305 Typ-/Inputfelder. Private Hilfsfunktionen zählen dort mit. Dynamische Objekte, `any`-Parameter und Konstruktoroptionen erfordern fachliche Einordnung und sind nicht automatisch öffentliche Funktionen.

**Nicht durchgeführt:** ein eigener Browserlauf gegen eine gestartete Installation, ein visueller Screenshotvergleich, Live- oder Testnet-Orders, Telegram-Versand und die vollständige lokale Anwendungstestsuite. Die Befunde dieses Plans sind deshalb als Quelltext-/Vertragsbefunde zu lesen, nicht als behauptete End-to-End-Reproduktionen. Bereits existierende CI- oder frühere Auditresultate werden nicht als neue eigene Browserprüfung ausgegeben.

Vor Umsetzung muss der Entwickler den dann aktuellen Commit erneut bestimmen. Bei einem neueren Stand ist zuerst ein Delta-Abgleich notwendig; dieser Plan darf nicht alte Fehler gegen einen inzwischen korrigierten Stand behaupten.

## 3. Konkrete Ist-Lücken

### U-01 – Journalfilter verwendet einen nicht erlaubten Status

Die UI bietet „Offen“ mit dem Wert `open` an. Die Journalvalidierung akzeptiert dagegen `pending`, `planned`, `submitting`, `monitoring`, `completed`, `blocked`, `failed` und `unknown`. Das ist ein konkreter Vertragsfehler, keine bloße Gestaltungsfrage. [S01, S02]

**Soll:** Getrennte Statusdimensionen für Intent, Position, Order, Versand und Vorfall. Eine Gruppe „Offene Trades“ braucht einen ausdrücklich unterstützten Gruppenfilter oder eine korrekt implementierte serverseitige Statusmenge. Nicht einen erfundenen Einzelstatus senden und nicht eine begrenzte Liste clientseitig so filtern, als wäre sie vollständig.

### U-02 – Das Journal besitzt Backend-Reviewfunktionen ohne entsprechende Bedienung

Notizen, Tags, Bewertung und Reviewstatus sind im Backend vorhanden. Die aktuelle Journalliste zeigt überwiegend Zusammenfassungen; der Reviewablauf fehlt. Der interne `intentId`-Filter wird vom heutigen HTTP-Listenhandler außerdem nicht einfach durchgereicht. Eine direkte Trade-Detailseite braucht daher einen passenden sicheren Detailvertrag. [S01, S03]

**Soll:** Trade-Detail, Reviewformular, `reviewed`-Filter, vollständige paginierte Listen und gleich gefilterte Exporte. Notes, Tags, Rating und Reviewed dürfen ausschließlich Reviewdaten ändern, nicht Orders, Fills, Plan oder Herkunft.

### U-03 – Adaptive Risikostufe kann nicht vollständig bedient werden

Das Backend kennt `lockedTier`. Im Ressourcenformular fehlen Fixieren und Aufheben dieser festen Stufe. Andere adaptive Parameter sind bereits vorhanden. [S04, S05]

**Soll:** „Stufe festhalten“ und „Automatische Stufenauswahl wieder zulassen“, inklusive aktiver/empfohlener Stufe, Herkunft, Zeitpunkt und Scope. Die UI zeigt Stufen 1 bis N; intern bleibt der bisherige Index 0 bis N−1 erhalten. Aufheben transportiert `null`, nicht `0`.

### U-04 – KI-Limits fehlen als verständliche Einstellungsgruppe

Die acht globalen AI-Limits existieren, aber das Systemformular bietet dafür keine vollständige dedizierte Bedienung. Zusätzlich begrenzt `saveCore()` beim Speichern den globalen Requesttimeout auf 120.000 ms – auch im gemeinsamen Speicherpfad für Secrets. Der globale Config-/Parservertrag lässt bis 300.000 ms zu; das einzelne Workflow-Parserzeitlimit ist ein anderes Feld. [S06, S07]

**Soll:** Alle acht Limits einzeln, geerbte Werte und tatsächlich wirksame Grenzen zeigen. Ein Secretwechsel darf nicht nebenbei Timeouts, Dateipfade oder andere Einstellungen verändern. Serverseitige Normalisierung muss vor bzw. nach dem Speichern als Diff sichtbar sein.

### U-05 – Erfolgreiche Tokenrotation kann durch den Folge-Refresh verloren gehen

`System.execute()` wartet nach erfolgreicher Mutation erst auf mehrere Neuladungen. `rotateToken()` übernimmt das neue Token erst danach. Bei Anmeldung mit dem gerade ersetzten Haupt-Admin-Bearer kann der Refresh bereits mit 401 scheitern und die erfolgreiche Antwort im gemeinsamen Fehlerpfad verloren gehen. Andere Authentifizierungsarten sind gesondert zu testen. [S06]

**Soll:** Neue einmalige Tokenantwort unmittelbar übernehmen und anzeigen, erst dann mit dem neuen Token nachladen. Mutationserfolg und Fehler beim Nachladen sind getrennte Zustände. Keine automatische erneute Rotation.

### U-06 – MCP-Polling kann ungespeicherte Formulare ersetzen

Der MCP-Bereich lädt regelmäßig neue Snapshots. Der Editor setzt seinen Formularzustand bei Änderung des ausgewählten Snapshotobjekts neu. Ohne Dirty-State-/Versionsschutz kann das laufende Änderungen überschreiben. [S08]

**Soll:** Entwurf und Serversnapshot trennen. Ein Poll aktualisiert Statusinformationen, aber nicht den bearbeiteten Entwurf. Fremde Änderungen erzeugen einen verständlichen Konflikt mit Vergleich und ausdrücklicher Entscheidung.

### U-07 – MCP-Genehmigung zeigt nicht den vollständigen Prüfgegenstand

Die aktuelle Warteschlange zeigt Aktion, Agent, Ablaufzeit und Blocker. Für sensible Änderungen reicht das nicht, um den konkreten Vorschlagsinhalt und die Auswirkungen zu prüfen. [S08]

**Soll:** Vor Freigabe vollständiger redigierter Inhalt, Vorher-/Nachher-Diff, betroffene Konten/Pfade, Risikoänderung, bestehender Preflight und dessen Alter. Der Server prüft bei Ausführung erneut. Eine alte grüne Vorschau ist keine aktuelle Freigabe.

### U-08 – Positionsanzeige stellt Plan- und Livewerte nicht sauber auseinander

Die Mark-Anzeige greift auf Paper-Marktdaten beziehungsweise einen Planwert zurück. Der PnL-Wert in dieser Liste ist realisierter PnL und kein verlässlich aktueller unrealized PnL. Die Anzeige erklärt diese Unterschiede nicht hinreichend. [S09]

**Soll:** Geplanter Einstieg, tatsächlicher Fill-Durchschnitt, aktueller Mark samt Beobachtungszeit, offene Restmenge, realisierter und unrealisierter PnL, offene Gebühren-/FX-Bewertung sowie aktueller Schutz separat. Fehlt eine Quelle, lautet die Anzeige „unbekannt“ oder „nicht verfügbar“ – nicht null und nicht gesund.

### U-09 – Recovery hängt von im Recovery-Modus gesperrten APIs ab

Die Systemseite lädt unter anderem `operations` und `access` gemeinsam mit Konfiguration und Recoverydaten. Der Backend-Recovery-Modus sperrt normale Routen und lässt nur eng begrenzte Reparaturen zu. Auch das normale Initialladen und die Anmeldung koppeln Erfolg teilweise an `/api/status`. Dadurch ist gerade die Reparaturoberfläche von normalen Betriebs-APIs abhängig. [S10, S11]

**Soll:** Eigenständige Recovery-Oberfläche mit separatem Minimal-Ladepfad. Authentifiziert ist nicht dasselbe wie betriebsbereit. Die Reparatur nutzt nur aktuell serverseitig zugelassene Aktionen; eine vorhandene Route allein setzt weitere Startup-/Auditgates nicht außer Kraft.

### U-10 – Relative Analysezeiträume bleiben beim Polling stehen

„Letzte 30 Tage“ wird mit `Date.now()` in einer Memo-Berechnung aufgelöst. Bei unveränderten Filtern können die periodischen Requests dieselbe festgehaltene Obergrenze weiterverwenden. [S12]

**Soll:** Relative Zeitbereiche bei jeder Abfrage aus einer expliziten Uhr neu berechnen. Historische feste Vergleichsperioden bleiben dagegen bewusst fest. Anzeigezeitzone und UTC-Risikotag unterscheiden.

### U-11 – Bestehende Kontoaktionen haben unzureichend erklärte globale Folgen

Der Credentialwechsel deaktiviert im Backend neue Entries und setzt den globalen Kill-Switch. Das Konto bleibt nach erfolgreicher Rotation zunächst deaktiviert. Ein kontobezogener Notausstieg besitzt ebenfalls globale Auswirkungen auf neue Handelsaktivität. Das darf eine lokale Kontokarte nicht verschweigen. [S13]

**Soll:** Vor jeder solchen Aktion betroffene Objekte und globale Nebenwirkungen anzeigen. „Konto ausgewählt“ bedeutet nicht automatisch „nur dieses Konto betroffen“. Wiederfreigaben erfolgen ausdrücklich und mit den bestehenden Nachweisen.

### U-12 – Navigation und Abschlussmeldungen sind zu stark an lokale UI-Zustände gekoppelt

Der bestehende Router lenkt auf `/dashboard`; Workspaces, Unterbereiche und Objekte liegen überwiegend im Komponentenstate. Mehrstufiges Publizieren, Aktivieren, Nachladen und der Neustart mit fester Verzögerung besitzen keine einheitliche Ergebnisdarstellung. [S14, S15]

**Soll:** Direkte Objektadressen, wiederherstellbare Filter, expliziter Entwurf/Publikation/Aktivierung und beobachteter Wartungsabschluss. Ein erfolgreicher Teilvorgang bleibt sichtbar, auch wenn der nächste Schritt scheitert.

## 4. Was bereits vorhanden ist und erhalten bleibt

Nicht neu zu erfinden sind die 13 Workflow-Bausteine, viele Strategie-/Sizingfelder, die weitreichenden Schema-/Vertragsformulare, Fallback-Ketten samt kanalbezogener Regeln, die fünf Schritte Builder-History, Kontenverwaltung, Verifizierung, globale Runtime-Steuerung, Kill-Switch-Freigaben, Risikoquittierung, Backuperstellung/-prüfung/-restore, Offsite-Rückholung, Setup-Bundles, MCP-Agentenrechte und die Telegram-Viewer-Einstellungen. [S04, S08, S15, S16]

Die 35 Runtimefelder sind bereits über explizite Eingaben und einen generischen Detailbereich erreichbar. Hier ist der wichtigste Umbau die Gruppierung, Erklärung, Validierung und Darstellung von gespeichertem versus aktivem Wert. Nicht alle sind schlicht „vergessen“ worden. [S16]

Bestehende Sicherheitsregeln bleiben unverändert: keine ungesicherten Entries, keine automatische Wiederholung unbekannter Order-/Versandergebnisse, keine erfundenen Fills oder Identitäten, keine frei editierbaren Schutzbeweise, keine automatische Live-Freigabe durch einen öffentlichen Börsentest und keine nachträgliche Veränderung gepinnter Handelspläne.

## 5. Informationsarchitektur

Die Navigation erhält sieben überschaubare Hauptbereiche mit objektbezogenen Unterseiten. Der Builder bleibt zentral für die Konfiguration, ist aber nicht mehr die technische Wurzel sämtlicher Betriebsansichten.

| Hauptbereich | Unterbereiche | Primäre Frage |
|---|---|---|
| **Cockpit** | Betriebszustand, Schutz, Blocker, aktuelle Aktivität | Läuft das System, und was braucht Aufmerksamkeit? |
| **Trading** | Konten, Positionen, Orders/Intents, Journal, Paper-Labor | Was wird auf welchem Konto gehandelt und wie ist es abgesichert? |
| **Workflows** | Builder, Pfadliste, Bibliothek, Versionen, Tests | Welcher Signalweg führt mit welchen Parametern wohin? |
| **Signale & Versand** | Telegram, Eingang/Alben, Parserergebnisse, Outbox, KI/Queue | Was kam an, wie wurde es verstanden und was wurde versendet? |
| **Risiko & Analyse** | Tagesrisiko, adaptive Policen, Performance, Geld/FX | Warum ist ein Trade erlaubt/blockiert und wie wurde das Ergebnis berechnet? |
| **Integrationen** | MCP, Freigaben, Telegram Viewer, Verbindungen | Welche Agenten und Dienste dürfen was tun? |
| **Betrieb & Sicherheit** | Einstellungen, Zugriff/Secrets, Backups, Setup-Transfer, Wartung, Diagnose | Wie wird das System sicher eingerichtet, geändert und wiederhergestellt? |

Vorgeschlagene UI-Adressen sind beispielsweise `/trading/accounts/:accountId`, `/trading/trades/:intentId`, `/signals/messages/:messageId`, `/workflows/resources/:resourceId/versions/:versionId`, `/integrations/mcp/proposals/:proposalId` und `/operations/backups/:artifactId`. Das sind neue Frontend-Routen, keine Behauptung vorhandener HTTP-Endpunkte. Der bestehende `basename` wird beachtet.

`/recovery` liegt außerhalb der normalen Datenabhängigkeiten. Beim Reload bleiben Objekt, Untertab und lesende Filter über URL/Navigation erhalten. Suchtexte dürfen keine Zugangsdaten oder unredigierten Signalvolltexte in URL oder Browserhistorie schreiben.

### Gemeinsamer Rahmen

Der Kopfbereich zeigt Identität und Rolle, Backend-/UI-Version, Verbindungszustand sowie eindeutig getrennte Paper-/Testnet-/Live-Kontexte. Die globale Live-Erlaubnis ist kein Beweis, dass jedes Konto live handelt. Neue Entry-Erlaubnis, bestehende Exposition und bestätigter Schutz werden getrennt angezeigt.

Eine globale Suche findet zulässige Konten, Signale, Intents, Ressourcen, Incidents und Einstellungen. Treffer führen direkt zum Objekt. Suche löst keine Handelsaktionen aus. Ein gut erreichbarer Sicherheitsbereich bietet nur bereits autorisierte Commands; riskante Aktionen sind niemals bloße Tastatur-Schnellbefehle ohne Kontextprüfung.

## 6. Fachliche Spezifikation der Bereiche

### 6.1 Cockpit: tatsächliche Betriebs- und Schutzlage

Das Cockpit trennt Dienstgesundheit von Handelssicherheit. Karten für Telegram, Eingang/Queue, Executor, REST-Abgleich, Streamzustand, Kontoidentität, Abrechnung/FX, Backup und Audit haben jeweils eigenen Status und Beobachtungszeitpunkt. Eine gestörte Teilquelle darf nicht sämtliche Karten leeren.

Eine priorisierte Blockerliste erklärt den betroffenen Scope, das fehlende Signal bzw. den fehlenden Nachweis, die letzte Beobachtung und die nächste zulässige Handlung. „Risikoereignis quittiert“ wird nicht als „Problem behoben“ dargestellt. „Kill-Switch freigegeben“ wird nicht als „Handel gestartet“ dargestellt. „Keine Fehler empfangen“ wird nicht als „Schutz bewiesen“ dargestellt.

Aktive Positionen erhalten zusammen mit dem Konto einen Schutzstatus: bestätigte Restmenge, wirksame Stopdeckung, Trigger, Alter des Belegs und ungeklärte Operationen. Tiefe Belege bleiben aufklappbar und schreibgeschützt. Das Cockpit zeigt Summen nur in belegbar vergleichbaren Währungen.

### 6.2 Konten und Börsen

Der Kontoassistent führt durch Börse, tatsächlich verfügbares Profil, Modus, dynamische Keyfelder, Name, Positionslimit und Verifizierung. Die bestehenden Credentialdefinitionen aus dem Börsenkatalog bleiben die Quelle. Nicht freigeschaltete Börsen werden auffindbar angezeigt, aber nicht durch eine Checkbox ausführbar gemacht.

Die Kontodetailseite umfasst Stammdaten und Modus, aktive Pfade, Kapazität, Bestände/Orders, Verifizierungszustand, Credentialgeneration, letzten REST-Abgleich, Streams und Verlauf. Identitätsbindungen werden nur redigiert angezeigt. Für historisch entfernte Konten bleiben Journalbezüge lesbar.

Alle bestehenden Kontocommands erhalten eine wirkungsgenaue Zusammenfassung: Aktivieren/Deaktivieren, Kontolimit ändern, verifizieren, abgleichen, sperren, nach Prüfung freigeben, Keys ersetzen und zulässig entfernen. Ein Kontoname oder Kontomodus wird nur editierbar, wenn der öffentliche Backendvertrag das tatsächlich unterstützt; Repositoryfelder allein genügen nicht.

Der Rotationsassistent zeigt vor dem Start die globale Handelspause, notwendige Entry-Stornierung, Flatheitsprüfung, Bindung an dasselbe externe Konto und die anschließend nötigen Freigaben. Schlägt die Rotation teilweise fehl, zeigt er den tatsächlich verbleibenden Kontostatus und nicht pauschal „keine Änderung“.

Im Börsenkatalog werden Discovery, öffentlicher Probe, geprüfte Implementierung, unabhängige Provider-Abnahme und aktuelle Ausführbarkeit separat dargestellt. Für Hyperliquid ist im untersuchten Receipt `providerAcceptanceVerified=false` hinterlegt. Ein Implementierungsnachweis ist daher nicht als erfolgreiche echte Börsenabnahme auszugeben. [S17]

### 6.3 Trade-, Order- und Positionsdetail

Ein Trade bekommt eine zusammenhängende Spur:

```text
Telegram-Nachricht / Album
→ dauerhafter Eingang
→ ursprüngliche Workflowrevision und Parsergruppe
→ Parser / Schema / Vertrag / Grounding / Duplikatentscheidung
→ Fan-out oder exklusiver Fallbacklauf
→ Intent
→ Plan, Positionsgröße, Hebel, Preisgrenze, TTL, Risiko- und FX-Prüfung
→ protokollierte Börsenoperation
→ Orders und einzelne/kumulative Fills
→ Restposition, Stopdeckung und TP-Restverteilung
→ Abschluss, Geldereignisse, Review und Benachrichtigungen
```

Jeder Schritt ist an Original-IDs und Originalversionen gebunden. Ein Klick darf nicht versehentlich die heutige Strategie anstelle der damals verwendeten Version öffnen.

Die Orderansicht trennt geplante Rolle, aktiven Orderstatus, bestätigte kumulative Füllung, einzelne Fills, ursprüngliche/ersetzte Stopgenerationen und offene Cancelverpflichtungen. Order-ACK, Fill, aktuelle Position und bestätigte Flatheit sind unterschiedliche Tatsachen.

Preisbegrenzte IOC-Einstiege zeigen Referenzpreis, ursprüngliche Grenze, Seite, Tick, maximale Slippage und ursprünglichen Ablaufzeitpunkt. Der Preisdeckel wird nicht bei jedem Refresh neu berechnet. Hebelanzeige: angefordert, Quelle Signal/Default, Strategiegrenze, Markt-/Tiergrenze und effektiv verwendet. Eine einfache Zahl „50×“ reicht nicht, wenn der tatsächliche Plan 10× verwendet.

Vorhandene Notfallcommands bleiben global oder kontobezogen gemäß ihrem Vertrag. Einzeltrade-Reduktion, beliebiger manueller Orderentry und manuelle SL-Änderung sind **keine** bereits vorhandenen allgemeinen Webcommands. Sie dürfen erst nach einer separaten Backend-Spezifikation angeboten werden. Insbesondere ist ein direkter Browserzugriff auf den Executor keine Lösung.

### 6.4 Journal und Reviews

Die Listenansicht erhält vollständige serverseitige Pagination, Filter und eindeutige Angaben zum Umfang. Die aktuelle Grenze von 500 Einträgen wird nicht still zur Gesamtheit des Journals erklärt. Exporte verwenden dieselben Filter und geben an, ob die gesamte Auswahl oder nur eine Seite exportiert wurde.

Das Reviewformular unterstützt `notes` bis 10.000 Zeichen, maximal 20 Tags mit jeweils höchstens 40 Zeichen, `rating` null oder 1–5 und `reviewed` als Boolean. Leere Notiz, keine Bewertung und nicht reviewed sind unterschiedliche Werte. Alle Reviewwerte werden ausdrücklich übertragen; ein optional neu hinzukommender Versionsschutz verhindert konkurrierendes Überschreiben.

Reviewdaten bleiben von Ausführungsdaten getrennt. Hinweise zu Retention erklären, welche vorhandenen Schutzregeln für besprochene Trades gelten. CSV-Formelschutz und Redigierung bleiben erhalten.

### 6.5 Workflows und Bibliothek

Der Builder bietet zwei gleichberechtigte Darstellungen desselben Graphen: Canvas und eine gut filterbare Pfad-/Tabellenansicht. Letztere ist auf schmalen Bildschirmen und per Tastatur vollständig bedienbar. Ein Kanalweg lässt sich unabhängig von den übrigen Spalten betrachten.

Alle 13 Typen werden abgedeckt:

| Baustein | Bedienung und Erklärung |
|---|---|
| `channel` | Kanalidentität, Alias/Name, tatsächliche Auflösung, abhängige Pfade |
| `content_filter` | Unterstützte Inhaltstypen statt unkommentierter Freitextliste |
| `keyword_filter` | Positiv-/Negativliste, leere Positivliste und tatsächliche Matchlogik |
| `regex` | Muster, All/Any, sichere Einzelprüfung, Fehlermeldung und Grenzen |
| `parser` | Prompt/Vorlage, globale oder eigene Modelle, eigenes Zeitlimit, keine Workflow-Dateiausgabe |
| `schema` | Normalisierte Parserstruktur, Felder, Typen und unveränderliche ID |
| `contract` | Gepinnte veröffentlichte Definition, Pfade, Grounding und Geometrie |
| `dedupe` | Aktivstatus, Cooldown, tatsächlicher Gruppenscope; 0 nicht mit deaktiviert verwechseln |
| `strategy` | Erlaubte Signale/Symbole/Seiten, Entry, Exits und Sicherheitsgrenzen |
| `sizing` | Risiko-, Kapital- oder Notionalmodus, Prozentwert, Obergrenze und Hebel |
| `adaptive_risk` | Modus, Stufen, Start/Lock, Lookback, Mindestdaten, Schwellen und Sperrregeln |
| `account` | Konto-/Modusbindung, Positionskapazität und Prüfstatus |
| `output` | Audit, Telegram-XML, Originalweiterleitung oder keine zusätzliche Ausgabe |

Pro Pfad zeigt eine effektive Konfigurationsansicht: Wert, Einheit, Ursprung, überschreibender Baustein und Geltungszeitpunkt. Sizingwerte aus der Strategie und aus einem nachgeschalteten Baustein werden nicht als zwei unabhängig wirksame Konfigurationen dargestellt. Parser-Schema und ausführbarer Signalvertrag bleiben getrennt erkennbar.

Fallback-Ketten erhalten explizite Rangfolge, Kanalscope und zulässige Gründe: Symbol fehlt, Kontokapazität erreicht oder Symbol bereits belegt, soweit durch die bestehende Policy erlaubt. Unbekannter Orderausgang, Timeout nach möglichem Versand und Schutzfehler sind kein Anlass, auf einer zweiten Börse dieselbe Exposition aufzubauen.

**Lifecycle:** Entwurf speichern, Version publizieren und Graph aktivieren werden klar getrennt. Die atomare Graphrevision existiert bereits; die ganze heutige Folge mehrerer HTTP-Schreibvorgänge ist dadurch nicht automatisch eine einzige Transaktion. Wenn Publikation gelingt und Aktivierung abgebrochen wird, bleibt die veröffentlichte, nicht referenzierte Version sichtbar. Persistente Graphentwürfe brauchen eine zusätzliche Backendfunktion.

Die bestehende History bleibt auf maximal fünf Schritte begrenzt. Graphänderungen zurücknehmen ist nicht dasselbe wie vergangene Trades zurücknehmen. Historische Revisionen bleiben lesbar; das Wiederherstellen einer Revision erzeugt eine geprüfte neue Aktivierung und schreibt alte Handelspläne nicht um.

### 6.6 Testlabor: vier klar getrennte Tests

1. **Filter-/Pfadtest:** Der bestehende Workflow-Simulationsendpunkt zeigt passende Filter/Pfade der aktiven Revision. Er ist kein vollständiger KI- oder Ordertest.
2. **XML-/Vertragstest:** Die vorhandene Vertragsvalidierung prüft Struktur und, soweit verfügbar, Grounding gegen bereitgestellte Quelle. Kein Börsenschreibzugriff.
3. **KI-Parsertest:** Neue begrenzte Operator-API für einen tatsächlichen Provideraufruf. Vorschau von Modell und Datenumfang, ausdrückliche Zustimmung, bestehende Tagesquoten/Reservierungen und Zeitgrenzen; kein versteckter kostenloser Test versprochen.
4. **Paper-Test:** Eigener Paperkontext mit simulierten Konten, Kursen und Ausführungen. Unverwechselbare Kennzeichnung und keine automatische Umstellung auf Live.

Die UI benennt immer, welche Stufen tatsächlich ausgeführt wurden. Ein erfolgreicher Filtertest darf nicht als erfolgreich validierter und handelbarer Börsenauftrag angezeigt werden.

### 6.7 Signale, Versand und KI

Telegram-Anmeldung erhält einen eigenen Bereich für Telefonnummer/Code/Passwort bzw. Gerätebestätigung gemäß vorhandener Loginsteuerung. Der Start/Stop des Telegram-Routings bleibt vom Start/Stop neuer Trading-Entries getrennt.

Eingang und Albumgruppen werden filterbar mit ihrem tatsächlichen Bearbeitungsstatus angezeigt. Ein Album wird nicht mehrfach als unabhängiger Handelsauftrag dargestellt. Die Verarbeitungsspur zeigt Quelle, dauerhaft gepinnte Auswahl, Parserergebnis, Ablehnungsgrund, Dedupeentscheidung und erzeugte Intents/Outboxaufträge.

Die Outbox bekommt eine Arbeitsansicht für Pending, Preparing, Sending, Completed, Failed, Unknown und Reviewzustände. Zu sehen sind Ziel, Versuche, Alter, Bestätigungen und Grund. Eine manuelle Wiederholung eines unklaren Versands benötigt die bestehenden Bestätigungen und eine unübersehbare Doppelversandwarnung. Quittieren ist nicht gleich erfolgreich zugestellt.

KI-Einstellungen bilden die acht Felder ab: `maxInputChars`, `maxOutputTokens`, `primaryAttempts`, `fallbackAttempts`, `dailyRequestLimit`, `dailyTokenLimit`, `requestTimeoutMs`, `backoffMs`. Dazu kommen globale Modelle, pfadbezogene Overrides und tatsächlicher Verbrauch einschließlich offener Reservierungen. Prozent- oder Währungsbeträge für Kosten werden nur mit nachvollziehbarer Preisquelle gezeigt; ohne diese Quelle genügt belastbarer Token-/Requestverbrauch.

Queue-Concurrency, Queue-Timeout und verwendete Weiterleitungsoptionen werden im aktiven Kontext angezeigt. Legacy-Konfigurationen bleiben sichtbar klassifiziert; es entstehen nicht zwei konkurrierende Editoren für denselben Workflow.

### 6.8 Risiko, Performance und Abrechnung

Die Risikoseite erklärt, warum ein Konto/Pfad/Intent zugelassen oder blockiert ist. Tagesverlust, offene Risikoreservierungen, erwartetes verbleibendes Stoprisiko, Gebühren, Funding, ungeklärte Vorgänge, FX-Bewertung und Kontokapazität werden getrennt aufgeführt. Die Oberfläche summiert dafür nicht eigenständig beliebige interne Tabellen.

Adaptive Policen zeigen Fixed/Shadow/Automatic, aktuelle und empfohlene Stufe, feste Stufe, manuelle Sperre, Datenbasis der letzten Auswertung und betroffene Pfade. Änderungen erfolgen über eine neue Ressourcen-/Policyversion, nicht durch Manipulation des abgeleiteten Runtime-States. Legacy-Channel-Risk-Policen bekommen eine eigene Kennzeichnung und einen überprüften Migrationsweg.

Money-/FX-Details unterscheiden Originalwährung, Reportingwährung, genaue Dezimalwerte, rationale Werte, begrenzte Wertebereiche und ungeklärte Beträge. USD, USDT und USDC werden nicht still als dieselbe Währung zusammengeführt. Kleine Beträge werden nicht aufgrund von Anzeige-Rundung zu „kein Verlust“. Diagramme dürfen näherungsweise sein, autoritative Beträge und Tooltips bleiben exakt bzw. klar als Grenzen gekennzeichnet.

Performancefilter betreffen die richtige Ebene: Konto, Börse, Kanal, Zeitraum, Modus, Intentstatus und gegebenenfalls Workflowpfad, soweit der bestehende oder neue Vertrag sie unterstützt. Der UTC-Risikotag wird neben der lokalen Anzeigezeit erkennbar. Vergleichskurven dürfen Datenlücken nicht als durchgängige sichere Beobachtung kaschieren.

### 6.9 MCP und Telegram Viewer

Die 19 bestehenden MCP-Rechte bleiben eigenständig und minimal. Agentenverwaltung bietet Erstellung, Aktivstatus, Rechte, Eventabonnements, Tokenrotation und Widerruf. Alle vorhandenen Funktionen bleiben erhalten; ungespeicherte Eingaben werden durch Polling nicht zurückgesetzt.

Die Freigabewarteschlange ist ein Reviewarbeitsplatz mit Agent, Aktion, Payload, Diff, Scope, Sicherheitswirkung, Ablaufzeit, Preflightbelegen und Ausführungsverlauf. Ein abgelehnter oder abgelaufener Vorschlag wird nicht durch einen Browserretry neu autorisiert. Sitzungsübersicht und Ereignishistorie zeigen auch Fehler, Dedupe und ausstehende Zustellungen.

Der Telegram Viewer bleibt ein lesender Bot. Seine bestehenden Nutzer-IDs, Locale, Zeitzone, Intervall, Darstellungsoptionen und 14 Benachrichtigungsschalter werden nicht reduziert. Testauftrag angenommen, tatsächlich versucht und zugestellt/fehlgeschlagen werden getrennt angezeigt. Die Bedienung erhält eine eigene übersichtliche Speichersektion für Benachrichtigungen sowie eine eindeutige Dirty-Anzeige.

Interne Viewer-Service-Tokens und MCP-Bearer dürfen nicht als Abkürzung in den Browser gelangen. Benötigte Anzeigeprojektionen werden über die eigene autorisierte Dashboard-Schnittstelle verfügbar gemacht, nicht durch direkte Nutzung interner Dienstendpunkte.

### 6.10 Einstellungen, Backups, Audit und Wartung

Die 35 Runtimefelder werden in Authentifizierung, Beobachtbarkeit, Audit/Alerts, Backups/Offsite, Retention und Laufzeit gruppiert. Für jedes Feld zeigt die Oberfläche gespeichert, aktiv, Quelle, editierbar und notwendiger Neustart. Die tatsächliche Präzedenz des Stores wird dargestellt; „Environment gewinnt immer“ darf nicht einfach angenommen werden.

Secrets bleiben write-only. Extern verwaltete Secrets sind sichtbar als konfiguriert, aber nicht fälschlich editierbar. Leeres Feld bedeutet beibehalten, wenn dies der Vertrag vorsieht. Löschen oder Rotieren ist eine separate bewusste Aktion. Ein Diagnoseexport enthält keine gespeicherten Tokens, API-Keys, Login-Codes oder unredigierten Providerantworten.

Backups zeigen getrennt Erstellung, Integritätsprüfung, gemeinsame Konfigurationsgeneration, Offsite-Rücklesebeleg, artefaktlokale Restore-Eignung und tatsächlich durchgeführten Restore-Drill. Ein grüner Hash bedeutet weder heute flaches Börsenkonto noch spätere Trading-Freigabe.

Restore, Neustart und größere Prüfungen bekommen einen dauerhaften Job-/Operationsstatus, soweit neu erforderlich. Die UI wartet auf belegte Zustände statt blind nach 2,5 Sekunden umzuleiten. Nach Restore bleibt Handel bis zur bestehenden erneuten Prüfung gesperrt. Verschlüsselungsschlüssel bleiben unabhängig gesichert; die UI kann einen verlorenen Schlüssel nicht durch ein neues Formular ersetzen.

Setup-Bundles zeigen einen inhaltlichen Diff statt nur Knotenanzahlen. Kontozuordnung, Vorschauhash, Ablauf und bestehende Revision sind Bestandteil der Freigabe. Bundleexport enthält keine Secrets oder Tradinghistorie. Allgemeiner Legacyimport bleibt separat vom sicheren Setup-Transfer.

Auditprüfung und Audit-Replay sind verschiedene Aktionen. Diagnose wird mit dem vorhandenen Bearer via API geladen und als redigierte Datei erzeugt, nicht durch `window.open()` auf eine unautorisierte Adresse. Logs haben sichtbaren Verbindungszustand, Cursorlücken und begrenzte Suche. Eine optionale Regexsuche muss begrenzt ausgeführt werden; ein ungebremster Regex auf Tausenden Zeilen gehört nicht in den UI-Hauptthread.

## 7. Parameter- und Capability-Vertrag als dauerhaftes Fundament

### 7.1 Ein Operatorregister statt auseinanderlaufender Formulare

Backend und Frontend bekommen ein versioniertes Register aller Operatorfähigkeiten. Es ist kein Ersatz für serverseitige Autorisierung. Für jede Fähigkeit stehen mindestens ID, Fachbereich, vorhandener Handler/Service, erforderliche Rolle, erlaubter Scope, aktuelle Blocker, Bestätigung, Wirksamkeit, Anzeige-/Formkomponente und Abnahmetest fest.

Ein Parameterregister enthält Pfad, Typ, Einheit, Validatorgrenzen, erlaubte Werte, Default, Null-/Leerwertbedeutung, Vererbungsregel, tatsächlichen Ursprung, Schreibschutz, Secretstatus, nötigen Neustart und betroffene Objekte. Alle editierbaren Felder müssen mit einem echten Consumer verbunden sein. Ein Feld, das nur gespeichert oder geparst wird, ist nicht automatisch eine ausgeführte Handelsfunktion.

Gemeinsame Verträge liegen in reinen Modulen ohne Datenbank-, Secret-, Dateisystem- oder Exchangeimports. Die UI importiert keine Backend-Adapter. Bestehende Validatoren bleiben maßgeblich; ein schrittweiser gemeinsamer Schemalayer reduziert Duplikation. Komplexe Fachformulare bleiben kuratiert. Das Ziel ist nicht, 3.305 Typfelder automatisch als Eingabemaske zu rendern.

### 7.2 Effektive Parameter zeigen

Ein Feld kann beispielsweise so dargestellt werden:

```text
Standard-Hebel: 5×
Ursprung: Positionsgrößen-Baustein „Kanal A / Standard“, Version 7
Überschreibt: Strategie „Momentum“, Version 3 → 3×
Gilt für: Kanal A → Konto X, künftige Intents nach Aktivierung
Signal-Hebel vorhanden: Der Signalwert wird innerhalb der Grenzen verwendet
Tatsächlicher Trade: zusätzlich begrenzt durch Markt-/Tiernachweis
```

Ein Beispiel ist ausdrücklich eine Anzeigevorlage, kein beobachteter Nutzerwert. Gespeicherte Quelle, effektive Konfiguration und ausgeführter Plan sind drei getrennte Ansichten.

### 7.3 Allgemeine Daten- und Formregeln

`0`, `false`, `null`, leere Zeichenkette und nicht gesetzt bleiben unterscheidbar. Geld- und Mengenwerte bleiben als geeignete Dezimal-/Rationalwerte erhalten; `Number()` ist kein Transport- oder Vergleichsformat für autoritative Geldrechnung. Eingabe mit deutschem Dezimalkomma braucht eindeutige Normalisierung und Rückanzeige, nicht stilles Ersetzen mehrdeutiger Formate.

Servernormalisierung wird als Ergebnis angezeigt. Teilupdates erhalten unbekannte bzw. nicht bearbeitete Felder und ersetzen nicht pauschal verschachtelte Objekte. Unbekannte neue sicherheitsrelevante Feldtypen führen zu einem Versionshinweis und gegebenenfalls Read-only statt zu einem falschen Textfeld.

Drafts werden nur beim ausdrücklichen Wechsel von Ressource/Version neu initialisiert. Bei Paralleländerungen wird mit `baseRevisionId` bzw. einem neu einzuführenden passenden Versionsschlüssel verglichen. Die UI bietet Verwerfen, Vergleich und bewusstes erneutes Anwenden – kein stilles Last-write-wins für riskante Einstellungen.

## 8. Bestehende API, benötigte Erweiterung und echte Neufunktion

Die komplette Ist-API steht in `02_API-Matrix.md`. Folgende Trennung ist für Aufwand und Sicherheit verbindlich:

| Aufgabe | Ist-Grundlage | Erforderliche Änderung |
|---|---|---|
| Journal-Review, reviewed-Filter, lockedTier, AI-Limits | Öffentliche Funktionen/Parameter existieren | Primär UI, Vertragstests und passende Statebehandlung |
| Outbox, Paper-Marktdaten, konto-spezifisches Cancel/Reconcile | Öffentliche Funktionen existieren | Eigene Arbeitsfläche, Scope-/Wirkungserklärung; Listen ggf. erweitern |
| Einheitliche Objekt-Details, vollständige Pagination | Repositories/Snapshots besitzen viele Daten, HTTP teilweise begrenzt | Neue begrenzte Dashboard-Leseverträge; keine Rohdatenbank-API |
| Schutz-/FX-/History-/Operationserklärung | Interne Belege und Projektionen existieren | Redigierte read-only Diagnose-DTOs mit Zeit und Herkunft |
| Capability-/Parametermetadaten | Verteilt über Controller/Validatoren | Versioniertes Metadaten-API bzw. generierte gemeinsame Verträge |
| Dauerhafte Graphentwürfe und konsistente Vorschau | Ressourcenentwürfe und atomare aktive Graphrevision existieren | Eigener Draftvertrag plus CAS/Ablauf; vorhandene Aktivierung wiederverwenden |
| Tatsächlicher KI-Test und isolierter Restore-Drill per UI | Parser/CLI-Funktion vorhanden, kein gleichwertiger kompletter Operator-HTTP-Ablauf | Begrenzter Command-/Jobvertrag mit bestehenden Schutz- und Quotengrenzen |
| Single-Trade-Reduktion oder manuelle SL-Anpassung | Kein allgemeiner öffentlicher Operatorcommand | Optionale neue Backendfunktion; nicht Teil behaupteter Ist-Parität |
| Offline-Rollback/Imagewechsel bei gestopptem Core | CLI/Deploymentaufgabe | Unabhängiger sicherer Wartungsweg nötig; nicht durch den gestoppten Core selbst |

Mögliche **neue** Routen heißen beispielsweise `GET /api/ui/capabilities`, `GET /api/ui/parameters`, `GET /api/trading/intents/:id`, `GET /api/trading/accounts/:id/safety`, `GET /api/operations/jobs/:id` und `POST /api/workflow/drafts`. Diese Namen sind Entwurfsbeispiele. Vor Implementierung müssen Routingstil, ID-Validierung, Rollen, Antwortbudget, Fehlervertrag und Versionsstrategie endgültig festgelegt werden. Sie sind nicht in der Ist-API-Matrix als bereits vorhanden eingetragen.

Neue Listenverträge benötigen stabile Cursor mit Filterbindung, eindeutige Sortierung einschließlich ID-Tiebreaker, eine `hasMore`-Aussage und einen Beobachtungs-/Snapshotkontext. Eine reine Frontend-Pagination über die ersten 500 Objekte erfüllt das Ziel nicht.

Commands liefern mindestens Auftrags-/Operations-ID, angenommenen Scope, tatsächlich bestätigte Teilwirkungen, Zustand und zulässige nächste Prüfung. Bei unbekanntem Transportergebnis wird nicht automatisch erneut mutiert. Neu entworfene idempotente Operator-Jobschlüssel dürfen nie als Erlaubnis zum erneuten Senden einer unbekannten Börsenorder missverstanden werden.

## 9. Technischer Umbau ohne neue Monolithen

Die heutigen großen Dateien werden nach Fähigkeiten aufgeteilt. Ein möglicher Aufbau:

```text
frontend/src/
  app/                    # Rahmen, Routing, Recovery-Einstieg
  features/
    cockpit/
    accounts/
    trades/               # Positionen, Orders, Intents, Lebenslauf
    journal/
    workflows/            # Canvas, Pfadliste, Bibliothek, Versionen
    signals/              # Eingang, Parser, Outbox, Telegram-Verbindung
    risk-analytics/
    mcp/
    telegram-viewer/
    operations/           # Einstellungen, Backups, Audit, Jobs
  shared/
    api/                  # typisierte Requests, Fehler, Abbruch, Refresh
    contracts/            # reine DTOs/Schemas, keine Adapterimports
    forms/                # Einheiten, Herkunft, Dirty/CAS
    components/           # Status, Money, Tabellen, sichere Dialoge
```

Die Zielverzeichnisstruktur ist ein Vorschlag. Die wichtige Regel lautet: Eine Funktion wird vollständig aus dem Monolithen herausgelöst und getestet, bevor dieselbe Funktion an anderer Stelle nochmals implementiert wird. Konto-Limit, Moneydarstellung, sichere Bestätigungen und Filterlogik besitzen jeweils eine gemeinsame Implementierung.

Lesende Requests werden dedupliziert und abgebrochen, wenn der Kontext wechselt. Veraltete Antworten überschreiben keine neuere Auswahl. Polling arbeitet ohne überlappende Requests, mit begrenztem Backoff und kontextabhängigem Intervall. Bei verborgenem Tab können normale Abfragen reduziert werden; nach Rückkehr ist die Frische neu zu prüfen. Aktive kritische Operationen verlieren dadurch ihren serverseitigen Fortschritt nicht.

Ein existierender Eventstrom kann Aktualisierungen beschleunigen, ersetzt aber keine autoritative REST-/Repositorybeobachtung. UI-SSE oder WebSocket ist eine mögliche spätere Transportentscheidung, keine notwendige Voraussetzung für Parität und kein Grund, fehlende Daten zu erfinden.

Fachseiten laden nur die tatsächlich benötigten Daten. Scheitert der Börsenkatalog, darf ein vorhandenes Journal nicht komplett verschwinden. Scheitert nach einer erfolgreichen Mutation das Nachladen, bleibt die erfolgreiche Mutation bekannt und die Anzeige wird als möglicherweise veraltet markiert.

## 10. Sicherheits- und Betriebsgrenzen

Die vorherigen Auditbefunde zur lokalen Admin-Sitzung, Isolation von Schutz-/Notausstiegspfaden und zur Break-even-Referenz sind Backend-Abhängigkeiten. Die neue UI kann sie erläutern und sicher bedienen, aber nicht durch bessere Dialoge beheben. Eine Produktionsfreigabe muss die Korrekturen oder eine ausdrücklich belastbare Risikobehandlung separat nachweisen.

Frontend-Capabilities sind Hinweise, keine Autorität. Der Backendpfad prüft Rolle, Runtime, Audit, Kontoidentität, Versionsbindung, Eigentum, Schutz und Frische bei jeder tatsächlichen Mutation erneut. Kein „trotzdem fortfahren“ bei unbekannten Eigentums-/Orderbelegen. Keine Imports, die publizierte Historie umschreiben. Keine Anzeige gespeicherter API-Secrets. Kein Docker-Socket, Terminalfeld oder freier Dateipfad als Ersatz für einen fehlenden Command.

### Offline-Aufgaben ausdrücklich entscheiden

Für den normalen Betrieb soll kein Terminal nötig sein. Ein vollständig ausgefallener oder für Rollback gestoppter Core kann seine eigene UI jedoch nicht ausführen. Der Plan sieht deshalb zwei klar deklarierte Produktebenen vor:

**Core-UI-Parität:** Alle zulässigen laufenden Operatorfunktionen sowie vorbereitete, erklärbare Wartungs-/Rollbackabläufe sind bedienbar. Deploymentwerte werden mit tatsächlicher Quelle angezeigt oder als geprüftes Konfigurationspaket exportiert.

**Optionale Host-Wartungserweiterung:** Soll auch Offline-Migrationsrestore, Imagewechsel und Wiederanlauf ausschließlich per UI funktionieren, braucht es einen unabhängigen minimalen Wartungsdienst. Er akzeptiert nur vorab definierte Jobs, geprüfte Artifact-/Imagedigests und servergeführte Pfade, hat eigenständige Authentifizierung und Besitz-/Wartungsnachweise und ist ausschließlich innerhalb der vorgesehenen privaten Zugriffsgrenze erreichbar. Keine freie Shell, keine beliebigen Docker-/Dateisystemoperationen, keine Handels-API. Diese Erweiterung hat ein separates Bedrohungsmodell und separate Abnahme. Ohne sie dürfen entsprechende Schaltflächen nicht als funktionsfähig versprochen werden.

Buildflags wie `VITE_BASENAME` oder optionales `VITE_GTM_ID` und Host-Port-/CPU-/RAM-Einstellungen sind keine normalen Laufzeitfelder. Ein Speichern im Core kann einen vorhandenen Browserbuild oder Compose-Stack nicht magisch neu konfigurieren. Der untersuchte GTM-Code ist bedingt; daraus folgt keine Behauptung, dass Tracking im Nutzerdeployment aktiv ist. Die neue UI soll standardmäßig keine zusätzliche sensible Telemetrie einführen. [S18]

## 11. Visuelle und interaktive Leitlinien

Die vorhandene reduzierte dunkle Gestaltung und Komponentenbasis kann bestehen bleiben. Funktionsfülle wird durch gute Unterteilung, Objektseiten und progressive Details bewältigt, nicht durch kleineres Schriftbild und noch mehr Karten auf derselben Seite.

Listen sind echte zugängliche Tabellen oder entsprechend vollständige semantische Strukturen. Filter bleiben sichtbar und rücksetzbar; aktive Filter sind in URL/Ansicht erkennbar. Status wird nie allein durch Farbe vermittelt. Dialoge besitzen Namen, Fokusführung, Tastaturbedienung und klaren Abschluss. Benutzer ohne Schreibrecht sehen entweder eine begründete deaktivierte Aktion oder eine reine Leseansicht, aber keine irreführend scheinbar ausführbare Schaltfläche.

Auf schmalen Displays bleiben Konten, Trades, Freigaben und Notfallstatus vollständig nutzbar. Der Canvas erhält eine Tabellen-/Pfadalternative; Vollständigkeit hängt nicht davon ab, 13 Spalten gleichzeitig sehen zu können. Bewegungen beachten reduzierte Animation. Leere, ladende, fehlerhafte und veraltete Daten sind eigenständige Ansichten.

Ein roher JSON-Inspektor darf als redigierte technische Ergänzung existieren. Er ersetzt weder das Fachformular noch die verständliche Darstellung von Risiko, Geld, Frische und nächster Handlung.

## 12. Umsetzung in verbindlicher Reihenfolge

### P0 – Korrektheit und gemeinsame Grenzen

Statusenum korrigieren; Tokenantwort vor Refresh übernehmen; MCP-Entwürfe schützen; Mutationserfolg von Nachladefehler trennen; unabhängige Recovery-Ladewege schaffen; unbekannte Werte nicht als gesund darstellen. Die vorherigen Backend-Sicherheitsbefunde als Freigabeabhängigkeiten aufnehmen. Inventar und Paritätsregister versionieren, ohne vorher alle bestehenden Produktverträge umzubauen.

### P1 – Vollständige Bedienung vorhandener Operatorfunktionen

Neue Navigation und Objektseiten, Journal-Review, lockedTier, AI-/Queue-Einstellungen, Outbox, Paper-Markteditor, präzise Kontoaktionen, vollständige Ressourcen-Lifecycle-Bedienung und einheitliche Filter. Zuerst vorhandene Services wiederverwenden. Fehlende Detail-/Paginationverträge gezielt ergänzen.

### P2 – Nachvollziehbarkeit und konsistente Abläufe

Schutz-/FX-/History-Read-Models, Trade-Lebenslauf, dauerhafte Jobzustände, inhaltliche MCP-/Setup-Diffs, Graphentwürfe, kontrolliertes Testlabor, Backup-Drill und Konfigurationswirkung. Alle neuen Verträge bleiben begrenzt und mit bestehender Sicherheit verbunden.

### P3 – Bewusst zusätzliche Backend-/Hostfähigkeiten

Nur separat freigeben: manuelle Einzeltrade-Befehle, erweiterte Paper-Fehlersimulation und unabhängiger Offline-Wartungsdienst. Diese Funktionen sind keine notwendige Kaschierung der UI-Lücken und dürfen den Abschluss der vorhandenen Kernparität nicht durch einen unkontrollierten Scope-Neubau ersetzen.

Die Arbeit erfolgt über kleine aufeinander aufbauende Änderungen, nicht durch einen einzigen umfassenden UI-/Engine-Refactor. Der konkrete PR-Backlog und die zugehörigen Abnahmeszenarien stehen in `04_Umsetzung_und_Abnahme.md`.

## 13. Definition of Done

Die Freigabe „UI Next vollständig“ setzt voraus:

- Jede bestehende registrierte Operatorroute und jede relevante Commandvariante besitzt eine geprüfte Zuordnung; nicht bedienbare Fälle haben eine dokumentierte fachliche Begründung. Jede neue Fähigkeit oder Einstellung muss diese Zuordnung und Tests mitbringen.
- Alle zulässigen editierbaren Parameter lassen sich lesen, ändern, validieren, speichern und in ihrer tatsächlichen Wirkung prüfen. Nichteditierbare Originale bleiben erkennbar read-only. Null/0/false/Dezimalpräzision bleiben erhalten.
- Die wesentlichen Arbeitsabläufe funktionieren vom Einstieg bis zum belegten Ende: Kontoanlage, kompletter Signalweg, nachvollziehbarer Trade, Review, Blockerbehandlung, Credentialrotation, sichere Freigabe, Backup/Restore, Agentengenehmigung und Recovery.
- Browsertests decken Admin, Viewer, Recovery, Paper, Testnet-/Live-Kontext sowie 401/403/409/412/503, langsame Antworten, veraltete Belege und unbekannte Mutationsergebnisse ab. Ein Timeout löst keinen unbeabsichtigten zweiten Schreibvorgang aus.
- Bestehende Trading-, Eigentums-, Audit-, Restore- und Supply-Chain-Gates bleiben mindestens so streng. Eine UI-Abnahme ersetzt keine unabhängige Börsen-/Provider-Abnahme.

**Kernziel:** Der Nutzer muss jederzeit beantworten können: *Was kann ich tun? Für welches Objekt? Mit welchen wirksamen Parametern? Warum ist etwas gesperrt? Was hat die letzte Aktion tatsächlich verändert? Welcher Nachweis bestätigt das?*

## 14. Quellen und Begleitdateien

Die Belege sind auf den geprüften Commit gepinnt. Relative Begleitdateien beziehen sich auf das Planpaket. Die Aussagen über aktuelle UI-Lücken stützen sich insbesondere auf:

- **S01:** [Operations – Journal](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/operations-panel.tsx#L1330)
- **S02:** [Journalstatus-Validierung](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/src/trade_journal.ts#L123)
- **S03:** [Journal-Review](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/src/trade_journal.ts#L510)
- **S04:** [Ressourcenformular einschließlich adaptiver Policy](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/resource-editor.tsx#L1870)
- **S05:** [Adaptive Policy-Validierung](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/src/workflow_repository.ts#L323)
- **S06:** [System-Speicherablauf, AI-Clamp, Tokenrotation](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/operations-panel.tsx#L2800)
- **S07:** [Globale AI-Konfigurationsgrenzen](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/src/config.ts#L326)
- **S08:** [MCP-Editor und Vorschlagsfreigabe](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/operations-panel.tsx#L2100)
- **S09:** [Aktive Positionsanzeige](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/operations-panel.tsx#L465)
- **S10:** [System-Ladeabhängigkeiten](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/operations-panel.tsx#L2750) und [Builder-Initialladen](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/workflow-builder.tsx#L1340)
- **S11:** [Recovery-Allowlist und Requestgates](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/src/web_server.ts#L2382)
- **S12:** [Analysezeitraum und Polling](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/operations-panel.tsx#L1470)
- **S13:** [Credential-Rotation](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/src/trading_web_control.ts#L500)
- **S14:** [Aktueller Router](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/components/router/app-router.tsx)
- **S15:** [Builder-Aktivierung und History](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/workflow-builder.tsx#L1470) sowie [Ressourcen speichern/publizieren](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/workflow-builder.tsx#L2130)
- **S16:** [Runtimeformular](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/app/workflow/operations-panel.tsx#L3095) und [Runtime-Verträge](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/src/runtime_settings.ts)
- **S17:** [Hyperliquid-Implementierungsreceipt](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/exchange_executor/certifications/hyperliquid.json)
- **S18:** [Deployment-Referenz](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/.env.example), [App-Buildkontext](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/App.tsx), [optionaler GTM-Code](https://github.com/888nikush888/tsx-core/blob/93ed1c41ca047c9ffc2af1028de869abd6e9284c/frontend/src/utils/analytics.ts)

Zusätzlich: `01_Funktionsmatrix.md`, `02_API-Matrix.md`, `03_Parameterkatalog.md`, `04_Umsetzung_und_Abnahme.md` und die maschinenlesbaren Dateien unter `inventar/`.
