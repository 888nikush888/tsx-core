# 002: faire begrenzte Entry-Warteschlange

Stand: 2026-09-02. Enger Folgeauftrag aus der Anforderungsmatrix `001-003-REQUIREMENTS-RECONCILIATION.md`, Befund F2. Ausschließlich lokale Umsetzung; keine Providerkontakte, Kontoeinstellungen, Strategieänderungen, DB-Migrationen oder Git-Commits.

## Fehler und tatsächliche Rotphase

Die Runtime las in jedem Durchlauf dieselben ersten 100 `pending/planned/submitting`-Intents. Eine vollständige Seite ungeklärter importierter Legacyvorbereitungen darf zwar nicht erfunden terminalisiert werden, konnte dadurch aber neue Intents eines anderen gesunden Kontos dauerhaft verdrängen.

Zuerst entstand die isolierte `plans/002-pending-worker-fairness-probe.mjs`: drei echte Worker-Wakes, 300 Versuche, kein Aufruf des gesunden Intents; derselbe Intent erreichte bei direktem Aufruf derselben Engine mit echtem Paperadapter `monitoring`. Anschließend wurde **vor** der Produktionskorrektur der permanente `tests/test_trading_pending_fairness.js` angelegt und ausgeführt. Tatsächliches rotes Ergebnis:

```text
AssertionError: Unprovable legacy preparations cannot starve a genuinely admissible independent account.
actual: pending
expected: monitoring
exit 1
```

## Implementierter Vertrag

Nur `src/trading_runtime.ts` wurde produktiv geändert:

- Stabile Keyset-Reihenfolge `(created_at,id)` statt immer erster Seite; weiterhin höchstens 100 Versuche je Runtimezyklus.
- Der Cursor wird erst für den wirklich versuchten Datensatz weitergesetzt. Ein Abbruch/Pause mitten in einer ausgewählten Seite überspringt keine unversuchten Datensätze.
- Ein inzwischen gelöschter Datensatz oder ein unerwarteter Versuchfehler fixiert den nächsten Lauf nicht auf dieselbe Zeile. Die bestehende Fehlerbehandlung bleibt erhalten; keine lokale Outcome-Erfindung.
- Am leeren Seitenende wird einmal zum Anfang zurückgekehrt. Höchstens zwei lokale begrenzte Auswahlabfragen; keine zusätzliche Provider-/Historyschleife.
- Vor dem Cursor neu eingefügte Zeilen werden beim nächsten Umlauf erreicht. Gleiche Zeitstempel besitzen durch `id` eine eindeutige Reihenfolge.
- Der Cursor ist nur flüchtiger Schedulingzustand. `stop()` löscht ihn; neuer Prozess/neue Runtime beginnt sicher am Anfang und erreicht spätere Seiten in begrenzt vielen regulären Zyklen. Kein Anspruch auf durable Fortschrittsfortsetzung bei ständigem Prozessabbruch vor der nächsten Seite; kein Daten- oder Beweisverlust, kein ungefragtes Wiederverwenden wirtschaftlicher DB-Spalten als Schedulerzustand.
- Bereits vorhandene Startup-/Clock-/Execution-/Kontogates, Mutationscoordinator, Journal, Schutzreconciliation und Entry-Engine bleiben unverändert. Legacyzeilen werden nicht geändert oder gelöscht.

## Sechs permanente Szenariogruppen

1. **Echter Mehrkontopfad:** 100 ursprüngliche ungeklärte Legacyvorbereitungen bleiben byte-/feldgleich. Ein unabhängiger gesunder Paperaccount erreicht über den tatsächlichen Worker im nächsten Zyklus `monitoring`; genau eine wirtschaftliche Paperentryorder, gültige FKs.
2. **Stabile Seiten und Restart:** 205 Zeilen mit identischem Zeitstempel ergeben Seiten 100/100/5, anschließend 100 beim Wrap. Nach echtem DB-Close/Open und neuer Runtime werden alle 205 dauerhaften Zeilen wieder erreicht.
3. **Gelöschte Cursor-ID und frühere Neueinfügung:** verschwundener Cursoranker blockiert die nächste Seite nicht; ältere Neueinfügung wird beim Wrap gefunden.
4. **Midpage-Pause:** nach genau einem Versuch Eintritte sperren; nach Freigabe folgen die tatsächlich noch nicht versuchten Zeilen ohne Sprung an das ursprüngliche Seitenende.
5. **Inzwischen gelöschte Auswahl-ID, leere Queue, neue Arbeit:** fehlende IDs bleiben No-op, leere Queue verursacht keinen Engineaufruf; spätere neue Zeile wird gefunden.
6. **Unerwarteter Versuchfehler:** der bestehende Runtimefehlerpfad bleibt wirksam; der nächste Zyklus erreicht trotzdem die folgende Zeile.

Die erste Gruppe verwendet echte Engine/Paper-Sicherheitsbedingungen. Die übrigen Gruppen verwenden ausdrücklich lokale Scheduler-Fakes für unabhängige Zustands-/Cursorgegenproben, keine simulierte Providerabnahme.

## Verifikation und Übergabe

Die permanente Testdatei besteht und wurde in `tests/run_all.js` registriert. Im selben kleinen Registrierungshunk wurde auf Root-Anweisung dessen `test_trading_prepared_exit_recovery.js` aufgenommen; dessen Produktion/Testfälle gehören Root, nicht diesem Fairnesshunk.

```text
node tests/run_all.js test_trading_pending_fairness.js test_trading_prepared_exit_recovery.js test_trading_recovery_worker.js test_trading_preparation_recovery.js test_trading_protected_entry_crash.js test_trading_entry_expiry.js test_trading_control_races.js test_trading_entry_safety.js test_trading_lifecycle_safety.js test_trading_global_release.js test_startup_trading.js test_test_registry.js
ALL 12 TEST FILES PASSED
```

Node 22.23.2. Backend-TSC grün; fokussiertes ESLint (`src/trading_runtime.ts`, neue Testdatei, Runner) `--max-warnings 0` grün; voller Architektur- und Complexity-Gate grün, unverändertes Maximum 15; Diffcheck grün. Ursprüngliche Probe jetzt grün (`healthyAttempted=true`, `monitoring`, 201 Versuche über drei Zyklen). Keine neue produktive Datei und daher kein zusätzlicher Sonar-Dateieintrag nötig. Source/Test/Registrierung eingefroren; getrennte Gesamt-/Coverageabnahme beim Hauptagenten.
