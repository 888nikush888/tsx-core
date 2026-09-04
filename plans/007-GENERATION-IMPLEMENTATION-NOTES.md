# 007: gemeinsame Konfigurationsgeneration und Backup-Anschluss

Stand 2026-09-02, lokale Teilumsetzung. **007 und Gesamtauftrag bleiben offen.** Keine echten Server-/Konto-/Telegramverbindungen, kein Commit/Push/Release. Restore, Reset und Prozessabbrüche nur mit temporären Fixtures; der echte Forwarder wurde nicht gestartet.

## Implementierte Verträge

- `backup_generation.ts` besitzt eine kurze gemeinsame Dateibarriere für `config.ts` und `runtime_settings.ts`. Ein unterbrochener oder fremder Lock wird nicht anhand PID/Alter entfernt. Synchrone konkurrierende Writer erhalten einen expliziten Busy-Fehler, statt während eines Snapshots weiterzuschreiben.
- Eine gespeicherte Generation bindet den DB-/Config-/Runtime-/Template-Scope, monotonen Zähler, zufällige Commit-ID, Zeit und kanonische Digests. Bereinigte Config/Runtime und Templatebytes liegen als geprüfte inhaltsadressierte Objekte vor. Geheimnisse werden nicht neu in Manifeste geschrieben. Eine neue Factory-Reset-Installation bekommt eine neue Commit-ID, nicht die Identität der alten Generation.
- Erste Adoption verlangt echte ProcessLock-Ownership und läuft über deren gemeinsame Queue. Ein normaler Neustart übernimmt keine extern geänderten Quellen und ersetzt kein fehlgeschlagenes Commit stillschweigend.
- Managed Writer binden die **vor dem Schreiben serialisierten Zielbytes**. Commit prüft das Ziel gegen genau diesen Digest und alle anderen Quellen gegen die vorige Generation. Ein fremder Austausch der eigentlich bearbeiteten Runtime-Datei wird nicht als eigene Änderung übernommen; der In-Memory-Wert wird bei gescheitertem Commit nicht publiziert.
- `configuration_paths.ts` liefert Parser und Backup denselben tatsächlichen Templatepfad. Ein eigener CONFIG_PATH verschiebt keine Templates implizit. Der bisherige Backup-Pfadfehler wurde ohne Verschiebung bestehender Dateien korrigiert. Der Default-Runtimepfad entspricht jetzt dem tatsächlich verwendeten Settings-Store.
- `createBackupArtifact` verlangt eine zum echten SQLite-Hauptdateipfad passende Generation und einen passenden Config-Provider. Nur das Pinning plus lokale SQLite-Kopie hält die Konfigurationsbarriere; Artefaktschreiben, Prüfung und Offsite-Upload liegen danach. Kopiert werden die gepinnten Objektbytes, nicht später separat gelesene Quelldateien. Vor Veröffentlichung werden Generation und Hashes geprüft. Altartefakte ohne Generation werden nicht nachträglich als kohärent bezeichnet.
- Forwarder enrollt vor Startupfreigabe; Drift führt in Konfigurations-Recovery. Der CLI-Create-Pfad ist ausdrücklich offline und hält den ProcessLock. Online-Backups bleiben über den laufenden Scheduler/UI verfügbar.
- Nach tatsächlichem Restore bleiben die alten Dienste aus. Eine neue Maintenance-Lease gegen die **neue DB-Dateiidentität** bestätigt erneut Quiescence, bevor die installierten Quellen ausdrücklich re-enrollt werden. Erfolgreicher Restore/Reset gibt seinen eigenen Marker frei; Startup löscht weiterhin keine alten Marker. Fehler nach physischer Installation starten niemals die alten Runtimeobjekte wieder.
- Factory Reset retiert genau seinen Generationsspeicher unter belegter Wartung, prüft ihn mit den vorhandenen Pfadgrenzen und behandelt ihn als explizites Reset-Ziel. Neue Defaultquellen werden erst danach neu enrollt. Kein pauschaler Bypass für gewöhnliche Config-Writer.

## Nachweise

- Echte gemeinsame Config-/Runtime-Writer, pinned SQLite-Snapshot, externe Änderungen vor/während Snapshot, Zielaustausch während Rename/Fsync, fremder Scope, fehlerhafter Commit und manipuliertes Objekt: `test_backup_generation.js` grün.
- Tatsächliche Backup-Erstellung: Änderung exakt beim nativen SQLite-Backupaufruf wird abgewiesen; kein gemischtes veröffentlichtes Artefakt und keine temporären Reste. Manifestgeneration-Manipulation wird verworfen. Staler Config-Provider wird abgewiesen.
- Tatsächlicher Offline-Restore-CLI in `test_backup.js`: installiertes Setup lässt sich anschließend wieder gegen seine lokale Generation pinnen. Factory-Retirement und explizites Reenrollment mit echter Lease sind ebenfalls lokal geprüft; eine strukturelle Lease-Attrappe genügt nicht.
- Gemeinsamer Lauf zuletzt sieben Dateien grün: Generation, Backup, verschlüsselte Replikation, Config, Runtime, Reset-Pfadgrenzen, Startup-HTTP. Typecheck, fokussiertes ESLint und Architektur109Module/421Imports/0Zyklen grün. Ein früherer kombinierter Lauf bestand zwölf Startup-/Wartungs-/Backup-/Retentiondateien. Daraus folgt keine aktuelle Gesamtfreigabe des parallel veränderten Baums.
- Ergänzend eigenständige Agenten-Nachweise: `test_backup_generation_crash.js` mit zehn echten SIGKILL-Grenzen und `test_backup_generation_ownership.js` mit Enrollment/Owner-release-Race. Root hat diese registriert; gemeinsamer Nachlauf erfolgt separat. Windows-Verzeichnis-Fsync mit EPERM ist ausdrücklich kein nachgewiesener Powerloss-Schutz.

## Weiter offen

- Getrennte Integritäts-/Kohärenz-/Offsite-/Restore-Eignungs-/echte Drill-Aussagen, unabhängige Aktualitätszeitpunkte und ehrlicher RPO-Scope aus007/5.
- Durchgängiger Restore-/Startup-Prozessabschluss und kompletter Quality-/Provider-Run nach den parallelen004/005Änderungen; keine echte Anwendung als Test starten.
- Externe Template-/Configbearbeitung ist ein expliziter Offline-Wartungsvorgang, kein unterstützt unkoordinierter Livewriter. Die Wiederaufnahme unbewiesener Locks verlangt erhaltene Ownership-/Crashbelege und kontrollierte Recovery, niemals automatische Altersheuristik.
