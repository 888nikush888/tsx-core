# Plan 007 Schritt 2 — Crash-Guard / Prozess-Ownership

Stand 2026-09-02. Lokale Teilumsetzung; **007 ist nicht DONE**. Keine Server-, App-, Broker- oder Kontoverbindung, keine realen Betriebsdateien gelöscht, kein Commit/Push/Deployment.

## Zuerst gemeldeter Pfad-STOP und ausdrückliche Entscheidung

Der Produktionscode hatte drei potentiell verschiedene Bereiche: Crashcounter/Crashblock unter `__dirname/../session_data`, `.process_active` neben `FORWARDER_DB_PATH` beziehungsweise `cwd/session_data/forwarder.db`, Routingmarker relativ zu `cwd/session_data`. Verschiedene DB-Verzeichnisse könnten deshalb unterschiedliche übergeordnete Locks halten und trotzdem denselben statischen Crashcounter ändern.

Dieser Befund wurde **vor Produktionsänderungen** an Root gemeldet. Freigegeben wurde ausschließlich fail-closed Gleichheitsbindung auf denselben realpath, keine Counter-/Block-/Legacy-Lock-Migration und keine neue Mehrdatenverzeichnis-Unterstützung. Root vereinheitlicht die produktiven Pfadübergaben innerhalb des vorhandenen Session-Scope und übergibt die bereits gehaltene ProcessLock-Capability. Abweichende Datenpfade bleiben eine offene ausdrückliche Pfad-/Migrationsentscheidung.

## Implementierte lokale Grenzen

- `checkCrashLoopFiles(stateDirectory, owner, now?, maximumCrashes?, windowMs?)` verlangt jetzt zwingend eine tatsächlich von `acquireProcessLock` ausgegebene, noch nicht freigegebene Capability. Strukturell gleich aussehende Objekte und fremde/fehlende Besitzer reichen nicht.
- `assertProcessLockOwner(owner, stateDirectory?)` prüft die intern registrierte Capability, aktuelle PID, Startzeit und Token sowie regulären nicht-symbolischen Lockpfad. Für Counterzugriff muss dieser exakt `realpath(stateDirectory)/.process_active` sein. Kein neuer Counterbereich wird hierfür erzeugt oder gewählt.
- Counterarbeit und Besitzerfreigabe laufen in einer gemeinsamen internen Queue je Capability. Vor und nach der Counterarbeit wird Ownership geprüft; eine parallele Freigabe wartet auf laufende Arbeit, spätere Arbeit mit freigegebenem Owner scheitert. Der einmal bestätigte kanonische Bereich wird an die Operation weitergereicht, statt danach erneut einen möglicherweise anderen Alias auszuwählen.
- `.crash_guard.lock` wird nicht mehr neu angelegt. Ein vorhandenes Legacy-Artefakt bleibt vollständig erhalten und blockiert den Start bis zu einer ausdrücklich geprüften Offline-Versionsumstellung. Kein Alters-, Zeitablauf- oder PID-Wiederverwendungs-Trick entfernt es. Counter und Crashblock bleiben unverändert.
- Crash-/Block-/Aktivmarker an nicht regulären oder symbolischen Dateipfaden werden abgewiesen. Atomische Counterersetzung und persistenter Crashblock bleiben erhalten.

## Separat gemeldeter Stale-TOCTOU und sichere Einschränkung

Die alte ProcessLock-Übernahme las einen toten PID-Payload und führte anschließend ein blindes Rename/Delete des gemeinsamen Lockpfads aus. Zwei Starter konnten denselben alten Payload lesen; der zweite konnte später bereits den neu erzeugten lebenden Lock des ersten löschen. Ein zusätzlicher Tokencheck vor oder nach Rename liefert kein atomares Compare-and-delete.

Root hat deshalb ausdrücklich die konservative Alternative freigegeben: **Keine automatische Stale-Übernahme mehr.** Auch eindeutig abwesende alte PIDs führen jetzt zu `ProcessLockRecoveryRequiredError`; der genaue Lockpfad und sein Inhalt bleiben erhalten. Aktive oder nicht eindeutig beurteilbare PIDs bleiben ebenfalls blockiert. Es wurde kein neues OS-Locking-Protokoll und kein Dateiformatwechsel eingeführt. Die echte noch gehaltene Capability kann ihren eigenen Lock weiterhin freigeben.

Bewusste Betriebsgrenze: Nach unerwartetem Prozessabbruch ist belegte Recovery erforderlich. Alle betroffenen Teilnehmer und automatischen Starter müssen zunächst sicher gestoppt sein; DB-/Session-Scope, konkrete Lockdatei und Besitzerzustand müssen geprüft werden. Nur eine separat autorisierte, gezielte Recovery dieser einzelnen Datei darf dann erfolgen, vorzugsweise mit wiederherstellbarer Quarantäne. `.crash_counter`, `.crash_blocked` und `.routing_active` werden dadurch **nicht** quittiert oder gelöscht. In dieser Umsetzung wurde keine solche reale Recovery ausgeführt.

## Nachweise

- Missing-Owner-Regression zuerst rot: alter Guard änderte ohne Prozessbesitz den Counter. Danach grün.
- Echte Capability, gefälschtes Objekt, fremder DB-Verzeichnisbesitzer, freigegebener Besitzer, normalisierte Pfadaliase, unveränderte fremde Counter und falsche Dateitypen werden getestet.
- Gleichzeitige Counteraufrufe konvergieren auf denselben persistenten Crashblock; parallel angeforderte Besitzerfreigabe wartet auf autorisierte Counterarbeit.
- Harte Kindprozessbeendigung sowohl unmittelbar vor atomischer Counterersetzung als auch unmittelbar nach persistentem Crashblock. Zweiter aktiver Prozess erhält keinen Lock. Nach SIGKILL bleibt der verlassene Lock unverändert und erfordert explizite Recovery; nur in der eigenen isolierten Testfixture wird diese gezielt durchgeführt. Anschließend bleibt der Crashblock erhalten beziehungsweise entsteht beim nächsten belegten Crash korrekt.
- Zwei konkurrierende Stale-Leser verändern die Datei nicht. Zusätzlicher gezielter TOCTOU-Test tauscht nach einem alten Stale-Read den Payload gegen einen lebenden neuen Besitzer: dessen Datei bleibt unverändert.
- `test_crash_guard.js`, `test_process_lock.js`, gezieltes ESLint, `git diff --check` und gemeinsames Komplexitätsgate grün (0 Warnungen, Maximum 15). Der produktive `forwarder.ts`-Caller und damit abschließender Typecheck/Gesamtlauf liegen bei Root.

Die übrigen Schritte von 007 (Startup-Autorität, Wartungs-Quiescence, Backupgeneration und getrennte Restore-/Integritätsnachweise) sind hiervon nicht abgeschlossen. Kein universeller Schutz gegen unkoordinierte fremde Dateisystemwriter behauptet.
