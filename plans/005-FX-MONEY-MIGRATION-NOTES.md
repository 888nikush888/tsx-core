# 005: lokale M45-Migrationsnachweise

Stand: 3. September 2026, aktuelles Schema 45. Ausschließlich freigegebene Tests, Testregistrierung und diese Notiz; keine Änderungen an `db.ts`, Valuation, Ledger, Python oder anderen Produktionsquellen. Keine Kontakte zu Konten, Providern oder Services. Sämtliche SQLite-Dateien entstanden in eindeutig benannten temporären Testverzeichnissen und wurden nach dem Test entfernt.

## Neuer Test

`tests/test_trading_fx_money_migration.js` ist in `tests/run_all.js` registriert. Er rekonstruiert mit der vorhandenen `dropFxMoneySchema`-Fixture das echte Schema 44 und öffnet es anschließend durch die unveränderte produktive Migration.

Nachgewiesen sind:

- Nichtleere ursprüngliche Fill-, Order-, Geld-, Native-Bewertungs-, Reportingbindungs-, FX-Receipt-/Conversion-/Referenz- und Schedulingdatensätze bleiben unverändert. Die gespeicherten JSON- und Dezimalstrings werden als Originalstrings verglichen, nicht neu normalisiert. Auch alte Projektions- und Positionsfelder sowie Migrationsdeskriptoren bleiben erhalten.
- `value_json` und `ledger_realized_value_json` entstehen ausschließlich als NULL. Migration erzeugt keine historische FX-Bewertung, keine Replayversuche und keine zusätzliche Pendingrevision.
- Erst eine echte lokale `valueFxMoneyEvent`-Ausführung erzeugt die exakte Bewertung `-4000/401` am bestehenden Event und erhöht die zugehörige Pendingrevision. Ein nicht belegbares früheres Event erzeugt über den vorhandenen Replayconsumer dauerhafte offene Arbeit, keine rückdatierte Quote.
- Die Datenbank blockiert Native→FX und FX→Native-Doppelbewertung in beiden Richtungen. Getrennte negative Fälle prüfen Event-/Account- und Conversion-/Account-FKs sowie Work-/Event-/Account-FKs. FX-Bewertungen bleiben unveränderlich und dürfen nicht gelöscht werden.
- Echte SQLite-Backupkopien des alten Schemas und des aktuellen Schemas werden wieder geöffnet. Originalwerte, neue Bewertungsbelege, Replayarbeit, Pendingstatus sowie alte/neue Projektions- und Positionsfelder bleiben erhalten; die FX-Bewertung wird nach Restore über ihren echten Reader erneut geprüft. Das ist ein SQLite-Migrations-/Backup-Reopen-Nachweis, keine zusätzliche Behauptung über vollständige Konfigurations-/Offsite-Restoreabnahme aus Plan 007.
- Fehler bei der ersten neuen Tabelle und erst beim letzten neuen Index führen zu vollständigem Transaktionsrollback. Der Vergleich der gesamten `sqlite_master`-Definitionen belegt, dass auch beide Zusatzspalten, bereits erzeugte Indizes und tabellenübergreifende Trigger zurückgerollt werden. Der vorbestehende gezielte Testkonflikt und seine Markerbytes bleiben erhalten. Nach Entfernen ausschließlich dieses Fixturekonflikts gelingt derselbe Upgrade erneut.

## Notwendige Korrektur alter Downgrade-Fixtures

Die älteren Tests entfernten pauschal spätere `schema_migrations`-Zeilen, ließen aber neu hinzugekommene Tabellen/Trigger stehen. Dadurch war das behauptete Altschema inkonsistent: insbesondere `fx_money_projection_pending` referenzierte beim späteren M40-Moneytabellentausch einen bereits entfernten Namen. Das ist ein Fehler des heutigen Test-Teardowns, kein Grund, historische Produktionsmigrationen oder deren Schutztrigger zu verändern.

Enge Imports-/Teardown-Hunks verwenden deshalb die vorhandene `dropFxSchema`-Fixture. Diese entfernt transitiv zuerst M45 über `dropFxMoneySchema`, danach M44/M43, und erst anschließend läuft der bisherige ältere Teardown:

- `tests/test_trading_risk_repository.js`
- `tests/test_ingress_migration.js`
- `tests/test_trading_money_migration.js`
- `tests/test_trading_fill_identity_migration.js`
- `tests/test_trading_kraken_cashleg_migration.js`

M44- und M43-Test erwarten bei erfolgreichem Öffnen nun `LATEST_SCHEMA_VERSION`. Der M44-Test vergleicht die acht ursprünglichen Projektionsspalten ausdrücklich; die spätere zusätzliche NULL-Spalte wird nicht als Änderung alter Evidenz ausgegeben. Seine erwarteten echten Ausgangs-/Rollbackversionen bleiben 43. M42 benötigte keinen neuen Hunk und bleibt unverändert grün.

## Ausgeführte Gates und Grenze

Der reguläre Runner bestand fokussiert alle neun Dateien: M45, M44, M43, M42 sowie die fünf oben genannten Altdowngrades. ESLint für alle bearbeiteten Testdateien und die Registrierung bestand mit `--max-warnings 0`; `git diff --check` ist grün. Kein vollständiger Lauf, kein Coverage-/Mutationlauf und keine Produktionslogikänderung durch diesen Teilauftrag.

Der Testscope ist nach diesem Handoff eingefroren. Die übrige exakte FX-/Sizing-/Risikoconsumerintegration und gemeinsame Gesamtabnahme bleiben beim Root; grüne Migrationstests allein stellen keine gesamte 005-Fertigstellung oder Konto-/Entryfreigabe dar.
