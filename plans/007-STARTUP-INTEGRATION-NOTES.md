# 007: lokale Startup- und DB-Lifecycle-Integration

Stand 2026-09-02. Teilumsetzung, **007 bleibt offen**. Kein Commit, keine Verbindung zur laufenden Anwendung oder zum Server, keine echten Orders. HTTP-Prüfungen ausschließlich über lokale Testserver; sämtliche DB-/Restore-Tests in temporären Fixture-Verzeichnissen.

> Historische Teilübergabe: Die hier noch als offen genannten Owner-/Offline-Leases und der boolesche Restore-Bypass wurden anschließend bearbeitet, siehe [007-MAINTENANCE-NOTES.md](007-MAINTENANCE-NOTES.md). Die kohärente echte Writer-/Backupgeneration einschließlich SIGKILL-Nachweisen steht in [007-GENERATION-IMPLEMENTATION-NOTES.md](007-GENERATION-IMPLEMENTATION-NOTES.md). Getrennte Backup-/Offsite-/Drillbelege werden in der folgenden 007/5-Integration abgeschlossen; diese ältere Notiz ist kein aktueller vollständiger Restpunktkatalog.

## Produktiv angeschlossen

- Eine gemeinsame `StartupAuthority` verbindet Forwarder, MCP-Worker, TradingRuntime, finale Entry-Admission und den synchronen Dispatch-Fence. Fehler sind pro Prozess endgültig; ein später erfolgreiches Startup-Gate hebt sie nicht auf.
- ProcessLock und Crash-Prüfung kommen vor verwalteter Initialisierung, SQLite-Öffnung und MCP-Start. Der Crash-Guard erhält die echte Ownership-Capability und denselben kanonischen Session-Scope. Abweichende DB-/Counter-Verzeichnisse werden nicht automatisch migriert.
- Gemeinsame Pflichtgates: Konfiguration, Crash, Datenbank, erster Schutzscan, Retention, Dashboard-Listener, Monitoring-Listener und Backup. `listen()` ist erst mit tatsächlichem Listening-Ereignis erfolgreich; Portfehler schlagen das Gate fehl.
- Telegram-Routing ist eine getrennte Entry-Voraussetzung. Eine leere, ansonsten gesunde Installation bleibt über die UI konfigurierbar, ohne schon Entries ausführen zu dürfen. Erfolgreicher späterer Routingstart kann die persistierte Execution-Präferenz erst nach allen Gates anwenden.
- HTTP-Adminmutationen werden nach Authentifizierung/Audit und nochmals nach Empfang des Requestbodys geprüft. Status bleibt lesbar. Explizite Konfigurations-, Secret- und Runtime-Reparaturen im vorhandenen Konfigurations-Recovery-Modus sowie bestätigter Neustart bleiben möglich; Domain-Resets und Imports erhalten dadurch keine Sonderfreigabe. Bestehende Rollen-/Authentifizierungsprüfungen bleiben unverändert.
- Bei Konfigurations-Recovery darf vorhandene Exposure mit verfügbaren Kontocredentials weiterhin abgeglichen werden; neue Entries und allgemeine MCP-Arbeit bleiben gesperrt. Späte Infrastrukturfehler stoppen nicht den bestehenden Positionsschutz.
- Shutdown und Wartung entziehen Entry-/Mutationsautorität vor dem Drain. Wartungsholds besitzen lokale, einzeln freigebbare Capabilities; eine verspätete Freigabe kann weder einen anderen Hold noch einen endgültigen Startupfehler aufheben.
- Ein gescheiterter Start entfernt keinen alten Routingmarker: nur der Prozess, der den Marker selbst unter belegter Ownership geschrieben hat, räumt ihn wieder auf.

## DB-/Wartungsanbindung

- `initDb` und `closeDb` sind gemeinsam serialisiert. Vor SQLite-open wird der Prozess als Teilnehmer registriert; nach open und vor Veröffentlichung erfolgen Wartungsprüfungen.
- `closeDb` bestätigt nur einen tatsächlich erfolgreich abgeschlossenen nativen Close. Bei Fehler bleibt das reale Handle für einen späteren Close-Versuch erhalten, ist aber nicht mehr für normale Anwendungsabfragen erreichbar. Kein zweites Handle darf darüber hinweg geöffnet werden. Fehlgeschlagene dauerhafte Closed-Acks können nachgeholt werden.
- Forwarder veröffentlicht die noncegebundene Wartungsanforderung mit ProcessLock-Capability, schließt das eigene Handle und wartet auf bestätigte Quiescence vor Restore/Reset. Reset erhält Marker, Teilnehmer-/Ackverzeichnisse, Generation und Prozesslock. Startup löscht keinen vorhandenen Wartungsmarker.
- Das neue Teilnehmerprotokoll und die MCP-Service-Integration werden parallel weiter adversarial geprüft. Sämtliche direkten SQLite-Öffner müssen noch gegen dieses Protokoll inventarisiert werden. Der alte boolesche `allowCurrentProcessLock`-Bypass im Backupmodul muss durch einen echten, direkt vor dem Dateiaustausch geprüften Capability-Vertrag ersetzt werden; die neue Forwarder-Vorprüfung allein ist kein Abschluss dieses Restpunkts.

## Tatsächliche Nachweise

- HTTP-Regressionsfall zuerst rot: Admin konnte vor Startup-Freigabe Runtime-Einstellungen ändern (200 statt 503). Nach Gate-Anschluss grün, einschließlich Entzug während des asynchronen Audits und begrenzter Recovery-Ausnahmen.
- Neue Startup-Gate-/Hold-/Listener-Tests grün; fehlendes Gate, späte Portfehler, verschachtelte Holds und späte Freigaben lassen keine falsche Autorität entstehen.
- Echte Paper-Engine-/Runtime-Sequenz grün: Pending bleibt unverändert bis Freigabe; nach späterem Gatefehler bleibt das nächste Signal pending, während die bestehende Position per Stop abgeschlossen wird. Entzug nach dem letzten Journal-Await erzeugt null Provider-Submits und eine nachvollziehbar aufgegebene Operation.
- Echte SQLite-Lifecycle-Fälle grün: Wartungsmarker ohne Close reicht nicht; erfolgreicher Close liefert Ack; Reinitialisierung während Wartung verweigert; nativer Close-Fehler erzeugt `close_failed`, Quiescence läuft aus, späterer echter Close funktioniert.
- Zehn fokussierte Testdateien im gemeinsamen Zwischenstand grün: Startup Authority, Startup HTTP, Startup Trading, Crashguard, ProcessLock, MCP Control Plane, Trading Control Races, Web Server, Backup und Migration CLI. Zusätzlicher DB-Lifecycle-Test danach separat grün. Node 22.23.2; Root-Typecheck und fokussiertes ESLint ebenfalls grün. Kein aktueller vollständiger Gesamtlauf aus diesen Teilprüfungen ableiten.

Offen bleiben insbesondere finaler Wartungs-/Restore-Capability-Nachweis, vollständige Recovery-/Timeout-/Prozessrennen, kohärente Backupgeneration, getrennte Integritäts-/Offsite-/Restoreaussagen sowie gesamter Quality-/Providerabschluss. Keine Absenkung der Gates und keine abgeschlossene Freigabe behauptet.
