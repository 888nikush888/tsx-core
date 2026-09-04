# Plan 006: Telegram-Aufnahme, Workflow-Pinning und AI-Budget crashsicher machen

> Nur bei separatem Umsetzungsauftrag ausführen. Keine Telegram-Nachrichten versenden oder historische Signale neu einspeisen.
> Arbeitskopie `C:/Users/nikla/Desktop/tsx-core`, Planstand `f8089277d0667dd45bcf070037800d423fd89254`, 2026-09-02.
> Drift: `git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src tests docs README.md`.

## Status / Voraussetzungen

P1/P2 · Aufwand L · Risiko HOCH · Verarbeitung/Idempotenz.
Fachlich unabhängig von 001–005; gemeinsame Änderungen an db.ts müssen sequenziell integriert und Migrationsstände abgeglichen werden.
IDs: P1-28, P1-29, P1-30, P2-27.

Ein erfolgreich gespeicherter Telegram-Eingang muss nach Crash wiederverarbeitbar bleiben. Derselbe Eingang muss dieselben fachlichen Workflowversionen benutzen. AI-Reservierungen müssen eindeutig abrechenbar sein, ohne unbekannte tatsächliche Nutzung kostenlos freizugeben.

## Aktueller Zustand und Muster

`src/db.ts:1962`:
```sql
INSERT OR REPLACE INTO signals (
```
Referenzierte Signals besitzen FK RESTRICT; Wiederholung kann am impliziten Delete scheitern.

`src/signal_parser.ts:491–492`:
```ts
committed = true;
await context.budget.commit(usageDay, context.tokenAllowance, usage.total);
```
Ein fehlschlagender Commit wird bereits als erledigt markiert.

Weitere Stellen: `src/forwarder.ts:1197` speichert Inbox getrennt vom Enqueue; `333` pinnt Config, aber keine vollständige Workflowrevision; `src/workflow_repository.ts:1862,2115` lädt aktive Revision neu. `src/db.ts:1974,2004` aggregiert AI-Reserve ohne Reservation-ID.

Konvention: durable Outbox, bestätigte Zustellung und konservatives Unknown-Retry aus ADR 0001 bleiben bestehen. Workflowversionen sind unveränderlich. README.md:185 hält nach Crash unklare AI-Nutzung absichtlich bis zum UTC-Tagesende reserviert. Diese Grenze nicht als angeblichen Defekt entfernen.
Testmuster: `tests/test_outbox.js`, `tests/test_signal_parser.js`; Node assert, temporäre DB, injizierte Fakes.

## Scope

`src/forwarder.ts`, `src/db.ts`, `src/workflow_repository.ts`, `src/outbox_scheduler.ts`, `src/signal_parser.ts`, `src/trading_types.ts`.
Neu `src/incoming_work_repository.ts`, `src/ai_usage_reservations.ts`.
Tests `tests/test_outbox.js`, `test_outbox_scheduler.js`, `test_workflow_history.js`, `test_workflow_history_barriers.js`, `test_workflow_fallback.js`, `test_signal_parser.js`, `run_all.js`; neu `tests/test_ingress_atomicity.js`, `tests/test_signal_idempotence.js`, `tests/test_ai_usage_reservations.js`.
`README.md`, `docs/adr/0001-durable-confirmed-outbox.md` nur für präzise Garantien.

Nicht im Scope: neue Prompts/Regex/Tradingstrategien; echte Nachrichten nachträglich handeln; Telegram-Session neu anmelden; automatisches Freigeben unbekannter AI-Kosten; Exactly-once-Versprechen für externe Provider.

## Befehle und Git

Node 22/npm 10.9, ausschließlich lokale Fake-Daten:
- `node --import tsx tests/test_ingress_atomicity.js`
- `node --import tsx tests/test_signal_idempotence.js`
- `node --import tsx tests/test_ai_usage_reservations.js`
- `node --import tsx tests/test_outbox.js`
- `node --import tsx tests/test_workflow_history.js`
- `node --import tsx tests/test_workflow_fallback.js`
- `node --import tsx tests/test_signal_parser.js`
- `npm run typecheck`, `npm run lint`, `npm run quality:architecture`, `npm run quality:complexity`, `npm run test:js`.

Alle Exit 0 nach Implementierung. Neue Tests in run_all registrieren. Langfristig main; kein Commit/Push/Deployment durch diesen Plan autorisiert.

## Schritte

### 1. Durable Ingress und Nacharbeit atomar verbinden

In einer SQLite-Transaktion Incoming-Message mit eindeutigem Telegram-Quellschlüssel und genau einen dauerhaften Klassifizierungs-/Routingauftrag speichern. Workflowrevision innerhalb derselben Transaktion auswählen und pinnen. Filterentscheidung kann der Worker nachholen; sie darf nicht in einem ungeschützten Fenster zwischen endgültigem Inbox-Dedupe und Enqueue liegen.

Doppelte Telegramzustellung liefert vorhandene Work-ID. received ohne Auftrag aus altem Bestand wird anhand vorhandener Provenienz als orphan angezeigt und kontrolliert migriert, nicht still ignoriert und nicht ungefragt neu gehandelt. Nachrichten mit bereits existierendem eindeutigem Auftrag nicht neu erzeugen.

Single-/Album-/Caption-Pfade müssen denselben Durable-Ingress benutzen. Albumteile je Nachricht deduplizieren; Gruppenabschluss und daraus abgeleitete Child-Aufträge besitzen deterministische IDs. Routing-Fanout atomar mit dem Abschluss der Klassifizierung speichern. Gefilterte Nachrichten mit dauerhaftem Grund terminal markieren.

**Gate:** test_ingress_atomicity mit Prozessabbruch vor/innerhalb/nach Transaktion, doppeltem Incoming, Albumteilwiederholung und mehreren Ausführungs-/Weiterleitungspfaden. Nach Neustart genau ein logischer Auftrag pro vorgesehener Wirkung, kein received-ohne-recoverbare-Arbeit.

### 2. Workflow und Ressourcen durch alle Phasen pinnen

Outbox speichert workflowRevisionId und die unveränderlichen Referenzen auf Kanalpfad, Filter, Prompt, Schema, Vertrag, Strategie und Risikoressourcen der Revision. Parsing und Intent-Erstellung bekommen diese explizit; dort kein getActiveWorkflowRevision als Ersatz bei Retry. Original-Run-ID und Zeitanker über Fallback erhalten.

Nur nichtgeheime fachliche Ressourcen pinnen. Aktuelle Credentials, Kontosperren, Ausführungsberechtigung und Gefahrenzonen werden weiterhin frisch geprüft. Eine historische Revision darf ein inzwischen abgeschaltetes Konto/einen widerrufenen Ausführungspfad nicht reaktivieren. Archivierte Versionen bleiben für Audit lesbar.

Legacy-Outbox ohne Revision: nur mit bereits vorhandener eindeutiger Provenienz binden. Andernfalls needs_review statt „aktuelle Revision nehmen“. Migration aktiviert oder replayt keinen Altauftrag automatisch.

**Gate:** Workflow-Wechsel zwischen Eingang, Parsing, Intent und Retry. Parser/Contract bleiben ursprüngliche Version; frische Kontosperre verhindert dennoch Dispatch. Fehlende Legacy-Provenienz wird sichtbar blockiert; Fallback ändert Revision/Zeitanker nicht.

### 3. Signalpersistenz unveränderlich und idempotent machen

INSERT-if-absent plus kanonischer Vergleich fachlich unveränderlicher Inhalte. Gleiche Signal-ID und gleicher normalisierter Inhalt/Quelle/Workflowbezug => bestehendes Signal zurückgeben, kein Delete/Update von created_at/Originalprovenienz. Gleiche ID mit anderem Inhalt => expliziter Konflikt und Review.

Provider-Request-ID oder Tokenzahlen eines erneuten Parserversuchs sind keine Rechtfertigung, das fachliche Signal zu überschreiben. Versuchsprovenienz separat append-only speichern. Intenterzeugung besitzt ihren eigenen deduplizierten Signal-/Pfad-/Accountschlüssel, damit erfolgreiche erste Fanout-Teile bei Retry nicht neu entstehen.

**Gate:** test_signal_idempotence: Signal mit bestehenden Intent-FKs erneut speichern => keine SQLITE_CONSTRAINT, identische Row/Intents; anderes Signal unter gleicher ID => Konflikt; teilweiser Fanout-Retry erstellt nur fehlende logische Wirkung.

### 4. AI-Reservierungen mit ID und idempotenter Abrechnung

Reserve liefert Reservation-ID je tatsächlichem Providerattempt, usageDay UTC, allowance und Status. Tagesaggregate aus aktiven Reserven/Settlement ableiten oder in derselben Transaktion aktualisieren. Settlement unter ID einmalig: bekannt tatsächliche Nutzung oder konservativ volle allowance bei unbekannter Nutzung. Wiederholung mit identischer Abrechnung wirkungslos; widersprüchliche zweite Abrechnung kontrollierter Konflikt.

committed-Flag erst nach bestätigtem Commit setzen; bei unklarer DB-Commitantwort denselben Settlement-Key erneut prüfen statt zweites Mal belasten. Bereits bekannte Nutzungsdaten nicht wegen DB-Fehler durch volle Pauschale ersetzen. Kein neuer AI-Request nur um Buchungsfehler zu reparieren.

Harter Crash ohne sichere Usage: Reservierung bewusst halten; erst belegte Nachinformation oder dokumentierter UTC-Tagesabschluss ändert die Abrechnung. Bei Retry mit tatsächlichem neuen Providerattempt separate Reserve. Keine Erstattung nur weil Prozess gestorben ist.

**Gate:** reserve->Crash, Completion->Commitfehler vor/nach DB-Commit, zweimal identisches Settlement, neues Providerattempt, Tageswechsel. Budgetsumme niemals negativ oder doppelt erhöht; konservativ unbekannte Nutzung bleibt sichtbar gebunden.

### 5. Migration, Integration und Garantie dokumentieren

Schemaänderungen transaktional und wiederholbar; alte aggregierte AI-Reserven als konservative Legacy-Position erhalten, nicht erfundene einzelne Requests erzeugen. Neue Version startet mit blockierten/Needs-review-Altaufträgen sichtbar statt einer automatischen Wiederholung. Tests für Migration + Worker-Restart im Gesamtsatz.

**Gate:** alle genannten Befehle Exit 0; FK-Integrität vor/nach Retry; keine unerlaubten Live-Endpunkte in Tests. Dokumentation verspricht durable/idempotente lokale Verarbeitung, nicht mathematisch Exactly-once externer Telegram-/AI-/Exchangeaktionen.

## Done / STOP / Wartung

Done: keine Inbox/Outbox-Crashlücke; Revision bis zum Intent gepinnt; Signal-REPLACE entfernt; Reservation-ID und idempotentes Settlement; alle neuen Tests registriert; Index aktualisiert.

STOP: Altauftrag lässt sich nicht eindeutig einer Revision zuordnen; bisherige Outbox-Unknown-Garantien würden geschwächt; Versuch erfordert historische Trades auszuführen; Scopebedarf; zweimal fehlschlagende Gates. Altbestand zur Prüfung markieren statt interpretieren.

Wartung: Jede neue Eingangsklasse und jeder neue Parserprovider muss Durable-Ingress/Attempt-ID benutzen. Retention muss noch referenzierte Workflowversionen und ungeklärte Reservierungen erhalten.
