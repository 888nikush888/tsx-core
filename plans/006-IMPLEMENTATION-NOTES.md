# Paket 006 – lokale Implementierungsnachweise

Stand: 2026-09-02. Umsetzung und gezielte Offline-Abnahme abgeschlossen; gemeinsame Gesamtsuite wird vom Hauptagenten durchgeführt. Keine Live-/Provider-/Releasefreigabe.

## Implementierung

- Migration 34: dauerhafte `incoming_work`-/Albumabschlüsse, gepinnter Outbox-/Signalbezug, getrennte Parserattempts, AI-Reservierungen und konservative Legacy-Tagespositionen.
- Telegram-Inbox und Klassifizierungsauftrag werden gemeinsam mit Originalinhalt, Eingangzeit, aufgelöstem Telegramziel und vollständiger fachlicher Workflowprovenienz gespeichert. Klassifizierung, deterministischer Fanout und Albumabschluss sind wiederholbar/transaktional; ausstehende Arbeit wird durch den begrenzten Outbox-Scheduler nachgeladen.
- Workflow-Parser lesen die gepinnten Schemas, Verträge und Prompts; vorhandene unveränderte Signals werden vor erneutem Parseraufruf geladen. Intent-Erzeugung benötigt eine explizite Revision. Original-Run-Zeit bleibt auch bei partiellem Fanout und Fallback erhalten.
- Aktuelle Kontosperren gelten weiterhin. Der finale Engine-Einstiegscheck prüft zusätzlich dieselbe geordnete strukturelle Pfadlinie im aktuellen Graphen; ein anderer Pfad zum gleichen Konto genügt nicht. Reine Ressourcenversionswechsel an unveränderten Nodes lassen das fachliche Pinning bestehen.
- Signal-REPLACE entfernt. Identische ID/Inhalt/Quelle/Workflow gibt die bestehende unveränderte Row zurück; Konflikt wird sichtbar zum Review. Providerattempt-Provenienz wird separat gespeichert.
- AI-Abrechnung verwendet eine ID pro tatsächlichem Request. Gleiches Settlement ist idempotent, widersprüchliches Settlement ein Fehler. Commitfehler werden mit derselben bekannten Usage/ID geprüft, ohne Providerfallback. Ungeklärte Abrechnung erhält `needs_review`; unbekannte Reserven bleiben erhalten, auch über Retention/Tageswechsel.
- Altbestand ohne Provenienz wird blockiert statt neu gehandelt. Eindeutige historische Signal-/Run-Provenienz kann eine Revision binden, aktiviert aber keinen Auftrag. Historische Albumpuffer bleiben zur Prüfung erhalten. Rekursive Geheimnisredaktion enthält weiterhin insbesondere `BACKUP_ENCRYPTION_KEY`, API-Hashes/-Keys, Tokens und private Schlüssel.

## Regressionen und Verifikation

Vor der Änderung reproduziert: Signalwiederholung mit existierender Fremdschlüsselreferenz scheitert an `SQLITE_CONSTRAINT`; AI-Reserve liefert keine Reservation-ID.

Node 22.23.2, ausschließlich temporäre SQLite-Datenbanken und lokale Fakes:

- Neue Tests: `test_ingress_atomicity`, `test_ingress_workflow_pinning`, `test_ingress_migration`, `test_signal_idempotence`, `test_ai_usage_reservations` – grün, alle in `tests/run_all.js` registriert.
- Echte Subprozessabbrüche vor/innerhalb/nach Eingangstransaktion sowie während Routing-Fanout und Albumabschluss; Restart erzeugt genau eine lokale Wirkung.
- Verlorene Commitantwort vor/nach erfolgreichem Settlement, dauerhaft fehlschlagendes Settlement, identische/widersprüchliche Wiederholung, separater Providerattempt, Tageswechsel und Retention.
- Workflowwechsel vor Parsing/Intent, archivierter Vertrag, alter Prompt/Originalzeit, teilweise bereits vorhandener Fanout, aktuelle Kontosperre und widerrufene strukturelle Route mit weiter aktivem gleichen Konto.
- Bestandstests `outbox`, `outbox_scheduler`, `workflow_builder`, `workflow_history`, `workflow_history_barriers`, `workflow_fallback`, `signal_parser`, `retention`, `metrics` – grün.
- Aktualisierte Legacyfixtures und Tests `trading_order_migration`, `dynamic_exchange_registry`, `signal_schema_migration`, `configurable_fallback_migration`, `telegram_viewer_core` – grün. Die reduzierte Teststruktur wurde vervollständigt, nicht die Migrationsvoraussetzungen geschwächt.
- Typecheck grün. ESLint für sämtliche 006-Source-/Testdateien ohne Fehler/Warnungen. Architekturcheck grün (99 Module, 356 interne Imports, keine Zyklen zum Prüfzeitpunkt). Gemeinsames Complexity-/Gesamtsuiten-Gate verbleibt beim Hauptagenten.

## Grenzen / Weitergabe

Keine bekannte offene lokale Teilpflicht aus 006; vollständige gemeinsame Regression nach parallelen Paketen bleibt nötig. Keine Telegram-/AI-/Brokerverbindung, kein echtes Replay, kein Trade, Commit, Push oder Deployment. Externe Exactly-once-Zustellung wird nicht behauptet.

Zusätzliche ausdrücklich abgestimmte Dateiberührung: schmaler finaler Autorisierungscheck in `src/trading_engine.ts`. Root erhielt `src/db.ts` und `src/forwarder.ts` zur weiteren koordinierten Arbeit zurück. Bei späteren Migrationen müssen die expliziten Last-Version-Erwartungen im Viewer-Test sowie der vollständige v33→v34-Rückbaufixture in `test_ingress_migration.js` wie üblich mitgeführt werden.
