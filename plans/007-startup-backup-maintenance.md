# Plan 007: Startfreigabe, Wartungsbarrieren und wiederherstellbare Sicherungen absichern

> Nur Planunterlagen. Keine echte Sicherung einspielen, Dateien löschen oder Dienste neu starten.
> Arbeitskopie `C:/Users/nikla/Desktop/tsx-core`, Basis `f8089277d0667dd45bcf070037800d423fd89254`, 2026-09-02.
> Drift: `git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src tests README.md docs`.

## Status / Voraussetzungen

P1/P2 · Aufwand L · Risiko HOCH · Betrieb/Recovery.
Voraussetzungen 001–003 und 006: gemeinsamer Mutationszaun, Recovery-Proof, persistente Nachrichtennacharbeit. Schemaänderungen aus 005 ebenfalls vor gemeinsamer Release-Abnahme integrieren.
IDs: P1-27, P2-22, P2-23, P2-24, P2-26.

Eine intakte Backup-Datei ist nicht automatisch ein zulässiger Restore mit offenen Börsenverpflichtungen. Ebenso darf ein wegen Crash-Loop gesperrter Start nicht vorher schon mutierende MCP-Aufträge ausführen.

## Aktueller Stand und Muster

`src/forwarder.ts:1611` startet mcpControlBridge vor `checkCrashLoop()` in Zeile 1619. Bereits in `1586` wird der übergeordnete ProcessLock gehalten.
`src/mcp_maintenance.ts:47`:
```ts
await new Promise(resolve => setTimeout(resolve, 1_000));
```
Diese Zeitspanne beweist kein geschlossenes DB-Handle.

`src/backup.ts:476`:
```ts
await backupDatabase(databasePath);
```
Config und externe Runtime-/Template-Dateien werden erst danach unabhängig kopiert.
`src/crash_guard.ts:82` verwendet eine leere wx-Lockdatei ohne Ownernachweis; `src/process_lock.ts` hat bereits Owner-/Token-Logik.
`src/backup.ts:635` und `tests/test_backup.js:214` verweigern bewusst Restore mit aktiver/unklarer Exposure. Diese Sicherheitsentscheidung erhalten.

Tests folgen `tests/test_backup.js`, `test_crash_guard.js`, `test_mcp_maintenance.js`: ausschließlich temporäre Verzeichnisse und Fixture-DBs, keine echten Backups oder Betriebsdaten. Bestehende Dateirechte, Symlink-/Pfadgrenzen und Hashprüfungen behalten.

## Scope

`src/forwarder.ts`, `src/mcp_control_bridge.ts`, `src/mcp_server.ts`, `src/mcp_maintenance.ts`, `src/crash_guard.ts`, `src/process_lock.ts`, `src/backup.ts`, `src/backup_replication.ts`, `src/backup_cli.ts`, `src/config.ts`, `src/runtime_settings.ts`, `src/db.ts`, `src/trading_web_control.ts`.
Notwendige gemeinsame Startup-Anbindung: `src/web_server.ts`, `src/trading_runtime.ts`, Entry-Authority-Hunks in `src/trading_engine.ts`; keine UI-Neuentwicklung. Ergänzende lokale Tests `tests/test_startup_web.js`, `tests/test_startup_trading.js`, `tests/test_database_maintenance.js`.
Neu `src/startup_authority.ts`, `src/backup_generation.ts`.
Tests `tests/test_backup.js`, `test_backup_replication.js`, `test_crash_guard.js`, `test_process_lock.js`, `test_mcp_maintenance.js`, `test_mcp_control_plane.js`, `run_all.js`; neu `tests/test_startup_authority.js`.
`README.md`, `docs/adr/0004-verified-backup-recovery.md`.

Nicht ändern: Restore trotz offener Exposure erlauben, ganze DB zurücksetzen, historische Trades löschen, Rollen-/Backup-Bestätigungen umgehen, externe Dienste automatisch abschalten, Konfigurationen anderer Programme anfassen.

## Befehle / Git

Node 22/npm 10.9:
- `node --import tsx tests/test_startup_authority.js`
- `node --import tsx tests/test_crash_guard.js`
- `node --import tsx tests/test_process_lock.js`
- `node --import tsx tests/test_mcp_maintenance.js`
- `node --import tsx tests/test_backup.js`
- `node --import tsx tests/test_backup_replication.js`
- `node --import tsx tests/test_mcp_control_plane.js`
- `npm run typecheck`, `npm run lint`, `npm run quality:architecture`, `npm run quality:complexity`, `npm run test:js`.

Jeweils Exit 0; neue Tests registrieren. Langfristig main; kein Commit, Push oder Server-Rollout durch diesen Plan erlaubt.

## Schritte

### 1. Startup-Autorität vor mutierender Arbeit erzwingen

Startupzustände initial/recovery-only/ready/blocked zentralisieren. Schutz bereits bestehender belegter Exposure darf in recovery-only laufen. Entry-Dispatch, mutierende MCP-Proposals und allgemeine Adminänderungen bleiben bis Crash-, DB-, Account-/Schutz- und übrigen vorhandenen Startupgates gesperrt.

MCP darf früh read-only/status verfügbar sein, darf aber keine mutierende persistierte Arbeit claimen/ausführen. Erst nach erfolgreicher Startfreigabe Worker aktivieren. Gatefehler wird als blocked gemeldet; kein kurzes ready-Fenster. Beim Shutdown/Maintenance Autorität vor dem Drain entziehen.

**Gate:** test_startup_authority mit vorhandenem mutierendem MCP-Request + Crashblock: null Mutationen, Request bleibt dauerhaft nachvollziehbar; Schutz-only zulässig; nach Freigabe genau einmal bearbeitet; spätes Gatefail wird nie ready.

### 2. Crash-Guard an belegte Prozess-Ownership binden

Keinen zweiten unverwalteten Lock mit eigener unendlicher Stale-Gefahr erfinden. Bestehenden übergeordneten ProcessLock als erforderliche Capability an den Crash-Guard übergeben; Crashcounterzugriff innerhalb desselben Prozesses serialisieren. Production-Caller hält den Lock bereits vor checkCrashLoopFiles. Alle weiteren Aufrufer/Tests müssen denselben Besitzvertrag erfüllen.

Vor Entfernung der zusätzlichen Locklogik nachweisen, dass alle Counterdateien genau diesem Betriebs-/Prozess-Scope gehören. Bei abweichendem FORWARDER_DB_PATH und gemeinsamem statischen session_data-Verzeichnis nicht still annehmen, es gebe nur einen Besitzer: zuerst Pfad-/Migrationsentscheidung melden. Legacy-.crash_guard.lock wird nur bei belegtem exklusivem Besitzer und abgeschlossenem Versionswechsel kontrolliert als Altartefakt behandelt; nie bloß nach Alter entfernen. Crashcounter und .crash_blocked bleiben erhalten.

Keine PID-wurde-wiederverwendet-Heuristik verwenden. Unlesbare oder unbewiesene aktive übergeordnete Ownership bleibt fail-closed; genaue Recovery-Anleitung statt breiter rekursiver Löschung.

**Gate:** harte Prozessbeendigung im Counterabschnitt, zweiter aktiver Prozess, parallele Aufrufe, fremder/fehlender Owner, abweichender Datenpfad, Legacy-Lock. Keine gleichzeitigen Writer und kein verlorener Crashblock.

### 3. Wartung über Quiescence-Acknowledgements koordinieren

Maintenance-Request besitzt unvorhersagbare Nonce, Owner/DB-Dateiidentität, Generation und Deadline. Jeder aktive registrierte DB-/MCP-Teilnehmer stoppt neue Arbeit, beendet/klärt laufende Mutationen und schließt DB-Handles; erst danach Ack mit derselben Nonce/Generation/Prozessidentität.

Coordinator wartet begrenzt, maximal 30 Sekunden, auf alle Teilnehmer oder belegtes Prozessende. Ein fehlendes Ack/unklarer Prozess verhindert Restore/Reset; Daten bleiben unverändert. Neue Teilnehmer sehen Maintenance vor DB-Öffnung. Verspätete Acks einer alten Nonce gelten nicht. Aufheben darf nur der Besitzer; kein pauschales Marker-Löschen beim Startup vor Prüfung.

**Gate:** langsames MCP >1 Sekunde, nie bestätigender Teilnehmer, Prozessabsturz, neue Verbindung während Wartung, alte Ackdatei, falscher Owner. DB-Dateiaustausch erst nach tatsächlicher Quiescence; Timeout tauscht nichts aus.

### 4. Eine logische Konfigurationsgeneration sichern

Runtime-/Configänderungen erhalten eine gemeinsame persistierte Generation samt kanonischen Digests der nichtgeheimen Config und referenzierten Templateversionen. Zentrale Writer in config.ts/runtime_settings.ts verwenden dieselbe kurze Konfigurationsbarriere. Backup pinnt eine committed Generation, erstellt dazu den SQLite-Snapshot und kopiert exakt deren unveränderliche Ressourcen. Hash/Generation anschließend erneut prüfen.

Während dieser Barriere keine externe Netzwerkabfrage. Telegram-Durable-Ingress und Positionsschutz nicht für den gesamten Backup-/Uploadvorgang pausieren. Nur nötige Konfigurationsmutation kurz sperren; Verpackung/Offsite danach ohne Schreibsperre. Fehler oder Generationwechsel => unvollständiges temporäres Artefakt nicht als verified veröffentlichen, begrenzt erneut versuchen.

Unkoordinierte externe Template-/Configänderungen sind nicht durch einfache Vorher/Nachher-Dateimtimes atomar lösbar. Solche Änderungen nur im Wartungsmodus zulassen oder als nicht belegbar melden; keinen gemeinsamen Snapshot behaupten. Keine Geheimnisse in neue Manifeste kopieren; vorhandene Secret-Sanitization erhalten.

**Gate:** Fixture mutiert Config/Runtime/Template an jeder Backupgrenze; Resultat entweder vollständig gleiche Generation oder abgelehnt, niemals gemischtes verified-Artefakt. SQLite-Integrität, Dateihashes und Rechte weiterhin gültig.

### 5. Backupnachweise und RPO korrekt unterscheiden

Manifest/CLI unterscheiden:
- integrityVerified: Struktur, Hashes, SQLiteintegrität;
- configurationCoherent: gemeinsame Konfigurationsgeneration;
- offsiteVerified: entfernte Kopie geprüft;
- restoreEligibility: eligible/blocked/unknown plus Gründe;
- restoreDrill: tatsächlich in isolierter Umgebung geprüfter Restore mit Datum/SHA.

Exposure-Refusal bleibt. Ein Backup mit offener Position kann integritätsgeprüft und offsite sein, aber für den derzeitigen integrierten Restore blockiert. Jüngsten Zeitpunkt je Nachweis separat führen. Dokumentiertes „15 Minuten RPO“ auf tatsächlich belegten Scope beschränken; keine Garantie für wiederherstellbaren Tradingzustand, solange nur ältere snapshots restore-eligible sind.

Restore-Drill ausschließlich in eigener temporärer Umgebung ohne echte Secrets, Netzwerkzugriff oder Tradingautorität. Runtime nach Restore immer aus/gesperrt; Recovery aus 002 prüft planned/opening/0/created, bevor später eine explizite Freigabe möglich wäre.

**Gate:** test_backup: intaktes Backup mit Exposure => integrityVerified, restore blocked; eligible Fixture => isolierter Drill erfolgreich; manipuliertes Artefakt abgelehnt; Offsite allein erzeugt keinen Drillnachweis. Alle Schlussbefehle Exit 0.

## Done / STOP / Wartung

Done: kein früher mutierender MCP-Start; belegte Crashcounter-Ownership; noncegebundene echte Quiescence; gemeinsame Backupgeneration; getrennte Restore-/Integritäts-/Offsiteaussagen; Gates und Scope geprüft; Index aktualisiert.

STOP: nicht exklusiver Prozess-/Counter-Scope, externer Writer ohne Barriere, Teilnehmer ohne nachweisbares Handle-Close, Scopeänderung oder zweimal fehlgeschlagene Gates. Keine physische Restore-/Resetaktion als „Test“ am laufenden System.

Wartung: Jeder neue DB-Teilnehmer muss Startup-/Maintenanceprotokoll implementieren. Neue Restoreformate dürfen Exposure-/Identitätsgrenzen nicht still lockern. Produktive Disaster-Recovery mit offenen Positionen wäre ein separater autorisierter Entwurf, nicht ein Schalter in diesem Paket.
