# Plan 003: Kill-Switch, Flatten, Teilfüllungen und Trade-Abschluss korrekt verbinden

> Aktueller Teilstand: [003-LIFECYCLE-SAFETY-NOTES.md](003-LIFECYCLE-SAFETY-NOTES.md) dokumentiert Closure, Drain und globale Freigabe. [003-ENTRY-SAFETY-IMPLEMENTATION-NOTES.md](003-ENTRY-SAFETY-IMPLEMENTATION-NOTES.md) ergänzt echten kontoweiten Admission-/No-Send-Nachweis; [003-EXIT-CANCEL-IMPLEMENTATION-NOTES.md](003-EXIT-CANCEL-IMPLEMENTATION-NOTES.md) den gemeinsamen begrenzten Cancel-Retry. Schutz-/Monitoring-Projektion, restliche Crash-/Restore-/Providerabnahme bleiben offen; kein Gesamt-DONE. Frühere Zwischenstände darunter sind historisch.

> IN PROGRESS. Entry-Abbruchwünsche (Migration 30), Emergency-Exit-Wünsche (Migration 31) und TP-Restverteilung/Fortschrittsbelege (Migration 32) sind dauerhaft. Eigene Late-Fills erzeugen erst nach belegter vorheriger Ausführung eine neue Flatten-Generation. Shared Stop-Restmengenprüfung, lokale Monitoring-Projektion und kumulative Paper-Teilfüllungen sind integriert. TP-Cancel verlangt einen neuen Account-Snapshot vor Ersatzorders; gespeicherte erledigte Ziele werden nicht wieder aufgefüllt. Harte Abbrüche vor/nach Flatten-Accept, während Cancel sowie bei erstelltem/vorbereitetem/angenommenem TP-Ersatz sind getestet. Ergänzter Scope: `src/trading_entry_commitment.ts`, `src/trading_lifecycle.ts`, `src/trading_emergency.ts`, `src/trading_protection.ts`, `src/trading_take_profit.ts`, `tests/test_trading_entry_commitment.js`, `tests/test_trading_emergency.js`, `tests/test_trading_protection.js`, `tests/test_paper_partial_fills.js`, `tests/test_trading_take_profit.js` und zugehörige `tests/fixtures/*crash.js`. Gesamter SafetyProof, Legacy-Allokationsnachweise, gemeinsamer Exit-Cancel-Retry, weitere Crashphasen und Freigabe bleiben offen; keine Gesamtfreigabe.

> Vollständig lesen, Schritte/Gates abarbeiten; STOP respektieren. Dieser Plan ist kein Auftrag, echte Orders zu stornieren.

> Weiterer Zwischenstand: `trading_safety_proof.ts` und `trading_safety_repository.ts` definieren die fünf Proof-Zwecke; Account-Release verwendet frische Quellen-/Balance-/Ownership-/Operations-/Generationsbelege in gemeinsamer Schreibtransaktion. `test_trading_safety_proof.js` prüft Tabellen, fehlende/unvollständige Quellen, aktive geschützte Position und finale Fence-Rollbacks. Andere Proof-Verbraucher und externe Baselines sind weiterhin offen. `trading_take_profit_recovery.ts` rekonstruiert fehlende Budgets nur aus pristine No-Send-Plänen oder exakt belegten Zielgenerationen; mehrdeutige Altstände bleiben ausdrücklich im Review mit unabhängiger Stop-Verwaltung. Noch keine vollständige Legacy-/Provider-/Paketabnahme.
> Kopie `C:/Users/nikla/Desktop/tsx-core`, Basis `f8089277d0667dd45bcf070037800d423fd89254`, 2026-09-02.
> Drift: `git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src tests docs/TRADING_GUIDE.md`. Abgenommene Änderungen aus 001/002 berücksichtigen; andere Drift vor Arbeit auflösen.

## Status und Voraussetzungen

P0 · Aufwand L · Risiko HOCH · Sicherheit/Korrektheit.
Voraussetzungen: 001 und 002. Verfügbare Grundlage: Account-Coordinator/Fence, monotone Orderzustände, identitätsgeprüfte Schreibaufrufe, persistentes Recoveryjournal, vollständige Ownership-/Mengenbelege.
IDs: P0-01, P0-03, P0-04, P0-05, P0-06, P0-07, P1-14, P1-15, P1-25, P2-10, P2-11, P2-12, P2-17, P2-18; zusätzlich AUX-01.

Solange ein Entry noch fillen kann, ist der Trade nicht fertig. Ein gefüllter Stop oder Position quantity=0 ändert daran nichts. Kill-Switch bedeutet neue Entries sperren und eigene offene Entry-Verpflichtungen abbauen; Flatten ist eine getrennte explizite Handlung.

## Codebelege der ursprünglichen Auditbasis und Muster

Die folgenden Zeilennummern/Auszüge stammen aus der ursprünglichen Basis, nicht sämtlich aus dem inzwischen geänderten Worktree. Den verifizierten Fortschritt und verbleibende Lücken dokumentiert `IMPLEMENTATION-STATUS.md`.

`src/trading_engine.ts:1416`:
```ts
if (!position || compareDecimal(position.quantity, '0') <= 0) return;
```
Dieser frühe Rücksprung übersieht offene Entry-Verpflichtung.

`src/trading_engine.ts:146–147`:
```ts
const identity = `${intentId}:take-profit:${targetIndex}:${quantity}:${price}:${randomUUID()}`;
```
Neue Zufalls-ID bei jedem TP-Replacement verhindert deterministische Wiederaufnahme.

Weitere Stellen:
- `trading_web_control.ts:721`: globaler Kill ohne Entry-Cancel.
- `trading_engine.ts:434`: Closure berücksichtigt offene/teilgefüllte Entries nicht vollständig.
- `trading_engine.ts:803`: aktive Stops nur open; `1260`: filled Stop beendet Schutzpfad.
- `trading_engine.ts:923`: nur terminale Cancel-Ergebnisse zählen, Nichtterminale eskalieren aber nicht zwingend.
- `trading_repository.ts:1529`: Operational-Schutzprüfung nur open.
- `paper_exchange.ts:171`: jede positive Fillmenge wird filled.
- `trading_web_control.ts:508`: orders.length > 0 zählt auch terminale Historie als Wartungshindernis.

Muster: temporäre DB/Fake-Adapter in `tests/test_trading_failures.js` und `tests/trading_fixtures.js`; `import assert from 'node:assert/strict';`. Decimal-Strings, Schutzstop niemals lockern. Signal-TP-Preise unverändert lassen. Per-Account-Isolation und bestehende Rollenprüfung erhalten.

## Scope und Grenzen

Bestand: `src/trading_engine.ts`, `trading_runtime.ts`, `trading_web_control.ts`, `trading_repository.ts`, `trading_types.ts`, `paper_exchange.ts`, `db.ts`; die in 001/002 neu geschaffenen Safety-/Recoverymodule nur für die definierten Schnittstellen.
Neu: `src/trading_safety_proof.ts`, `src/trading_entry_commitment.ts`.
Tests: `tests/test_trading_engine.js`, `test_trading_failures.js`, `test_trading_web_control.js`, `test_trading_core.js`, `run_all.js`; neu `tests/test_trading_entry_commitment.js`. Dokumentation `docs/TRADING_GUIDE.md`.

Kein neues Strategiemodell, keine Änderung der Prozentgrößen, SL-/TP-Preise oder Account-ID-Bindung; keine realen Cancels/Flattens; keine Aufhebung fremder/unbewiesener Orders.

## Befehle / Git

Node 22/npm 10.9. Nach Erstellung:
- `node --import tsx tests/test_trading_entry_commitment.js`
- `node --import tsx tests/test_trading_engine.js`
- `node --import tsx tests/test_trading_failures.js`
- `node --import tsx tests/test_trading_web_control.js`
- `npm run typecheck`, `npm run lint`, `npm run quality:architecture`, `npm run quality:complexity`, `npm run test:js`.

Erfolg: alle Exit 0. Neue Datei in run_all registrieren. Langfristig main; Commit/Push/Release/Server nur mit separater Autorisierung.

## Schritte

### 1. EntryCommitment und SafetyProof zentral definieren

EntryCommitment umfasst created mit noch gültiger Dispatchabsicht sowie submitting/open/partially_filled/cancel_pending/unknown und ungeklärte Journaloperationen. created darf nur ohne jemals erfolgten Dispatch lokal beendet werden. Abwesenheit in einer Liste ist kein terminaler Beweis.

SafetyProof als strukturiertes Ergebnis mit Account-/Runtime-Generation, Evidenzstand, unerledigten Operationen, Fremdorders, Mengenunsicherheit, Stopabdeckung und blockierenden Risiken. Separate Zwecke:
- entryAdmission: darf eine neue Entryverpflichtung entstehen?
- entriesDrained: kann kein eigener alter Entry weitere Exposure erzeugen?
- positionProtected: ist bestätigte eigene Exposure ausreichend geschützt?
- tradeClosed: Entries terminal, eigene Nettomenge 0, alle eigenen Exit-Siblings terminal, vollständige Mengenbilanz.
- accountRelease: aktuelle Identität, vollständige Recovery, kein ungeklärter aktiver Besitz/Fill, keine ungeschützte Position oder ungelöste kritische Ursache.

Bestätigte historische cancelled/filled Orders allein blockieren weder Credential-Wartung noch Freigabe. Alte Fills müssen klassifiziert sein, nicht pauschal verschwinden.

**Gate:** neue Testdatei mit reinen Proof-Tabellen: alle States, 0-Position plus offener Entry, klassifizierte Historie, fremde Order, partielle Stops. Jeder Negativfall liefert konkreten stabilen Reason-Code.

### 2. Kill-Switch und Cancel als dauerhaften Abbau implementieren

Beim globalen/Account-Kill zuerst Fence publizieren und Entry-Admission sperren. Alle eigenen Entry-Verpflichtungen, einschließlich zero-position, iterieren. Cancel-intent vor Request persistieren. Ergebnis terminal cancelled/filled plus aktuelle Mengen-/History-Evidenz => beendet. open/partial/fehlende Menge/Timeout => cancel_pending oder unresolved, Schutz weiterführen, Operation bleibt draining und Account gesperrt.

Ein gefüllter Entry nach Cancel-Race ist nicht einfach Erfolg „keine Position“: neue eigene Exposure anschließend schützen. Wiederholte Kill-Anforderung greift dieselbe Operation auf, statt neue IDs zu erzeugen. Globaler Kill versucht alle Konten; ein Fehler in A verhindert nicht, dass B ebenfalls gesperrt und abgearbeitet wird. Keine unbegrenzten Schleifen: einzelne Läufe durch bestehende Deadline begrenzen, persistente Fortsetzung.

Execution AUS und Live AUS verhindern neue Dispatches durch 001. Ihre Semantik nicht heimlich zu Flatten ändern; offene Positionen bleiben geschützt. Unterschied zu Kill-Switch in TRADING_GUIDE ausdrücklich erklären.

**Gate:** verzögerter Submit, Cancel liefert open, Cancel-Timeout, Cancel-vs-Fill, wiederholter Kill und zwei Konten: keine fälschliche drained-Antwort, kein späterer neuer Dispatch, keine verlorene Position.

### 3. Flatten inklusive quantity=0 und Late-Fills

Emergency-Operation startet unabhängig von lokaler Menge mit Entry-Drain. Frische Ownership-Evidenz einholen; ausschließlich belegte eigene Nettomenge reduzieren. Ist Cancel ungeklärt, darf bereits eindeutig eigene Exposure risikoreduzierend behandelt werden, aber Operation bleibt emergency/draining; jeder spätere nachgewiesene eigene Fill löst erneute Schutz-/Reduktionsprüfung aus. Kein blindes Flatten fremder Differenz und kein „fertig“, solange ein Entry noch entstehen kann.

Flattenorder stabil und journalisiert erzeugen. Unknown-Flatten zuerst auflösen; nicht zusätzliche zufällige Market-Orders senden. Abschluss erst über tradeClosed-Proof, nicht quantity allein.

**Gate:** Crash vor/nach Cancel/Flatten-Accept; lokales quantity=0 bei Remote-Entry; später Fill nach erstem Flatten; fremde Same-side-Menge. Assert: keine fremde Reduktion, kein doppelter unbewiesener Flatten, Endzustand erst nach Drain und belegter Nullbilanz.

### 4. Schutz, TP-Replacement und Cleanup vereinheitlichen

Shared ProtectiveStopPredicate prüft echte Remote-Semantik: Account, Symbol, Gegenseite, Reduce-only, gültiger Trigger und ausreichende **Restmenge** quantity minus filledQuantity; Ownership/aktive Zugehörigkeit Pflicht. open und partially_filled sind bei positiver verbleibender Menge aktiv. Bedarf berücksichtigt aktuelle eigene Exposure und noch mögliche Entry-Fills gemäß bestehendem Schutzmodell. Ein filled Stop deckt keine zukünftige Menge ab: Entry-Drain und erneute Schutzprüfung.

TP-Replacement-Generation pro Intent/Target transaktional persistieren; Client-ID deterministisch aus Intent, Target und persistierter Generation, niemals Zufall bei Retry. created Replacement wiederverwenden. Nach Cancel und möglichem Parallel-Fill frische authoritative Evidenz einholen, dann Restmenge neu allokieren. Preisziele/Verteilung beibehalten.

Terminaler Abschluss storniert/verifiziert sämtliche verbliebenen eigenen TP-/SL-Siblings. Unknown-Cancel verhindert clean-close. Engine und Monitoring verwenden denselben Proof beziehungsweise dessen persistierte Projektion, nicht abweichende SQL-Statusannahmen.

Papermodell um deterministische Partial-Fill-Fakes erweitern: kumulative Mengen, verbleibende Orders, teilweise ausgelöste Stops und nachträgliche Entry-Fills. Nicht behaupten, alle Provider lassen Reduce-only-Reste identisch bestehen; je Provider explizite Fixturevarianten, einschließlich auto-cancel.

**Gate:** Stop teilweise gefüllt => kein doppelter Stop; falsche Seite/Reduce-only trotz bekannter ID => nicht geschützt; TP-Cancel mit unvollständiger Filled-Angabe => kein voreiliges Replacement; Crash nach created Replacement => identische ID; Exit-Siblings nicht vergessen. Engine und Operational Snapshot liefern identische Schutzentscheidung.

### 5. Freigabe und Wartung auf Proof umstellen

Account-/Global-Freigabe unter Coordinator aus aktuellem Stand beweisen. Bestätigung, Rolle und aktuelles Verify beibehalten. Reconcile/Recovery/Proof bilden eine versionierte Entscheidung; zwischen Proof und Commit veränderte Generation => Konflikt, keine Freigabe. Zwei Reconciliations ohne Proof genügen nicht.

Keine generischen Konto-Updates dürfen Kill-Switch still lösen. Credential-Wartung ersetzt `orders.length > 0` durch relevante aktive/unaufgelöste Verpflichtungen; API-Key-Bindung bleibt strikt. Vollständig terminale Historie darf nicht als offene Order gelten.

**Gate:** Freigabe negativ für submitting/cancel_pending/unknown, unaufgelöste aktuelle Fills, Fremdposition, falschen Stop, kritische Ursache, Generationrace; positiv für sauber geschützte zulässige Position und klassifizierte terminale Historie. Alle Schlussbefehle Exit 0.

## Done / STOP / Wartung

Done: explizite Regressionsfälle für alle sieben P0 im Gesamttestsatz (P0-02 aus 001); keine Status-/Mengenrückschritte; Proof-Reasons maschinenlesbar; keine Terminalisierung ohne Entry-/Sibling-Proof; Scope sauber; Index aktualisiert.

STOP: Provider-Cancel kann nicht terminal belegt werden; Ownership nicht beweisbar; vorgeschlagene Lösung verlangt fremde Orderlöschung, nackte Position oder Schleife ohne Deadline; Gates scheitern zweimal; Scope müsste erweitert werden. Unklaren Zustand konservativ stehen lassen, nicht durch neues Submit „reparieren“.

Wartung: Jede spätere Stop-/TP-/Flatten-Funktion muss denselben Commitment-/Proof-Pfad benutzen. Dieser Plan ändert **nicht** die gewünschten Signalpreise, Margin-Prozente oder Max-Leverage.
