# Begrenzter unabhängiger Review: Entry-No-Send-Ausnahme

2026-09-02, Arbeitskopie `C:/Users/nikla/Desktop/tsx-core`, HEAD `f808927` plus laufende gemeinsame Änderungen. Rein lesender Improve-Review, keine Produktionscodeänderungen. Scope: `trading_entry_candidate.ts`, `trading_entry_safety.ts`, `beforeSend` in `trading_recovery.ts` und direkte Collector-/Engine-/Dispatch-Fence-Aufrufer. Nur temporäre SQLite-/Paper-Fixtures ohne Provideraufrufe oder simulierte wirtschaftliche Sends.

## Bestätigte Befunde

### 1. Fremdposition kann durch die ausgenommene Null-Kandidatenposition verdeckt werden

- Evidenz: `trading_safety_repository.ts:144` zählt Fremdpositionen nach irgendeiner lokalen Symbolübereinstimmung. `trading_entry_safety.ts:24` entfernt danach die Kandidatenposition und damit deren negativen Ownership-/Remote-Abgleich.
- Lokaler Repro: echte `preparePendingIntent` erzeugt einen nie gesendeten `opening/0`-Kandidaten. Die an `proveEntrySafety` übergebene Observation enthält eine fremde positive Position desselben Symbols. Ergebnis vor Korrektur: `safe=true`, keine Gründe, Kandidatenmenge 0, Remote-Menge 1, gesendete Paperorders 0.
- Auswirkung: Der eigenständige EntryAdmissionProof kann vorhandene Fremdexposure nicht korrekt zurückweisen. Der normale Engine-Reconcile besitzt zusätzlich `assertAccountOwnership`; daher ist aus diesem direkten Proof-Repro ausdrücklich noch kein normaler tatsächlicher Provider-Submit bewiesen.
- Fixskizze: Die ausgenommene Null-Kandidatenposition darf keine Remote-Position als „lokal abgedeckt“ maskieren. Fremdpositionsnachweis gegen die verbleibenden wirklich belegten eigenen Positionen neu prüfen; andere tatsächliche eigene Positionen bleiben gültig.
- Tests: direkter Proof mit Same-Symbol-/Side-Fremdmenge, anderer Settlement-Namespace/Gegenseite sowie Engine-Resume eines planned-Kandidaten. Erwartung: Ablehnung, keine neue Order/Mutation.
- Priorität P1, Aufwand S, Änderungsrisiko MED (legitime andere geschützte Positionen müssen weiterhin zulässig bleiben), Konfidenz HIGH. Root bestätigt und bearbeitet die Gegenproben/Korrektur.

### 2. Persistierte operationId ist allein kein Beweis einer lebenden lokalen No-Send-Ausnahme

- Evidenz vor Korrektur: `trading_entry_candidate.ts:53`, `trading_recovery.ts:270` erlauben die `dispatching`-Ausnahme anhand Stringgleichheit und Phase; kein lokaler Ausgabe-/Lebenszeitnachweis.
- Lokaler Repro: originale passende Operation vorbereiten, `dispatching` dauerhaft aufnehmen, DB neu öffnen. `assertCandidateNeverSent` ohne ID weist korrekt ab; mit der alten gespeicherten ID akzeptiert es, obwohl kein aktueller Writer/Fence existiert.
- Auswirkung: Die öffentliche Proof-API kann den behaupteten aktuellen No-Send-Kontext nicht eigenständig beweisen. Der derzeitige normale Engine-Aufrufer liefert die ID zwar aus `runJournaledExchangeWrite`, dessen vorheriges Prepare/Transition einen alten dispatching-Vorgang abweist. Kein nachgewiesener normaler Engine-Replay; trotzdem eine echte Lücke im positiven Beweisvertrag und eine gefährliche spätere API-Falle.
- Fixskizze: Nichtserialisierbare, nur innerhalb des aktiven finalen `beforeSend`-Kontexts ausgegebene Capability an Operation/Konto/Request binden. Nach Ende der Prüfung beziehungsweise spätestens vor Send widerrufen; historische IDs und außerhalb des aktiven Kontextes verwendete Objekte weisen ab. SQLite-Dispatch-Fence und dauerhafter dispatching-Marker bleiben zusätzlich nötig.
- Tests: alte ID nach Restart, strukturelles Fake, Capability des anderen Writers/Kontos, Wiederverwendung nach Callback/Send/Fehler; aktuelle echte Writer-Ausnahme bleibt positiv.
- Priorität P2 (Vertragsgrenze, bestehender Produktionsaufrufer hat zusätzliche Absicherung), Aufwand S/M, Änderungsrisiko MED, Konfidenz HIGH. Root hat den direkten Regressionsfall bereits zunächst rot eingefügt.

### 3. Prepared-Journal mit expliziter Provider-Gegenevidenz wird als nie gesendet akzeptiert

- Evidenz: `CandidateOperation`/`operationMatchesPlan` prüfen `evidence_json` und den ursprünglichen Stateversionverlauf nicht. Eine matching Request-/Plan-/ExpectedOrders-Bindung allein überstimmt dadurch widersprüchliche gespeicherte ACK-Evidenz.
- Lokaler Repro einer inkonsistenten Restore-/Journalfixture: passende `prepared`-Operation trägt in `evidence_json` bereits einen Provider-Ack mit nichtleerer Exchange-Order-ID und Status open. `assertCandidateNeverSent` akzeptiert dennoch. Keine tatsächliche Exchangeorder wurde im Test gesendet.
- Auswirkung: Explizite Gegenevidenz wird aus dem Kandidatenkontext weggefiltert. Dies ist kein behaupteter regulärer atomarer Phasenübergang der jetzigen Implementierung, sondern die verlangte fail-closed Behandlung widersprüchlicher Original-/Restore-Daten.
- Fixskizze: Für die enge `protected_entry`-Ausnahme ausschließlich evidenzfreie originale Preparation mit plausibler Phase/Stateversion zulassen (`prepared`/0 beziehungsweise lebende erste `dispatching`/1). Gespeicherte ACK-/Outcome-Evidenz bleibt ein Ablehnungsgrund. Nicht pauschal auf Cancel-/Exit-Journalregeln übertragen; deren belegte Wiederholungen sind andere Verträge.
- Tests: prepared+ACK, aktuelle dispatching-Ausnahme+ACK und zurückgesetztes prepared bei verbrauchter Stateversion; jeweils keine Kandidatenausnahme/kein Send. `last_error` allein nicht als erfundener Provider-Ack behandeln.
- Priorität P2, Aufwand S, Änderungsrisiko MED (Originalzustände/Legacy sauber trennen), Konfidenz HIGH. Root informiert.

## Auditbindung des positiven Admissionbelegs

`evaluateTradingSafety` hasht die Evidenz nach Herausnahme des Kandidaten. Der daraus erzeugte accountweite Proof benennt daher bislang nicht selbst, welcher konkrete Plan/Journalvorgang unter welchem No-Send-Nachweis ausgenommen wurde. Der separate RiskProof bindet den Plan, ersetzt aber ohne expliziten Link nicht den Kontext dieses eigenständigen Admissionbelegs.

Empfehlung: gehashten `candidateExemption`-Kontext innerhalb der gleichen finalen DB-Fence aus der tatsächlich geprüften Evidenz erzeugen: Kandidaten-Intent, Planhash, konkrete Operation/Generation/Requesthash falls vorhanden und Hash der lokalen No-Send-Belege. `proof.intentId=null` bleibt korrekt, weil der übrige Nachweis accountweit ist. Das ist eine nachvollziehbare Belegbindung, kein nachgewiesener zusätzlicher aktueller Dispatch-Bypass. Root bestätigt die Ergänzung.

## Geprüft und nicht als weitere Fehler gemeldet

- Andere Intents/Operations werden nicht durch den reinen `intentId`-Filter ausgenommen; globale ungelöste Remote-Evidenz, Incidents, kritische Risiken und andere historische Beweisfehler bleiben im Accountproof. Foreign-account Orders/Positions im Kandidaten werden explizit abgewiesen. Kandidatenfills verhindern den lokalen No-Send-Nachweis.
- `withDatabaseDispatchFence` hält die kurze SQLite-Transaktion durch Verifikation und synchronen Send-Start; nach dem letzten Guard gibt es keinen zusätzlichen Await. Der langlebige Provider-Promise erbt den DB-Owner nicht. Commit-/Sync-/Async-Sendfehler behalten die konservative unresolved/abandoned-Trennung. Bestehender `test_trading_dispatch_fence.js` im Review grün.
- Nicht behauptet: Ein alter operationId wird vom gegenwärtigen normalen Enginepfad bereits automatisch wiederverwendet. Dessen Prepare-Gate verhindert das; Befund 2 betrifft den unabhängigen Ausnahme-/Proofvertrag.
- Keine Gesamtfreigabe von Plan 002/003, kein auditierter Liveprovider, keine Vollständigkeitsentscheidung für Bybit, kein vollständiger Architektur-/Dependency-/UI-Audit. Root korrigiert parallel; nach seinen Änderungen sind die neuen direkten und Enginefälle sowie die breitere Suite erneut auszuführen.

## Nachtrag des Hauptagenten: lokale Korrekturen und gezielte Gegenproben

Alle drei obigen Befunde und die Auditbindung sind lokal korrigiert: Fremdpositionsrecount nach der engen Kandidatenausnahme, privater lebender WeakMap-Witness mit Widerruf vor Send und ACK-/Stateversion-Vertrag im gemeinsamen Recovery-/No-Send-Pfad. Widersprüchliche Journalzustände werden auch im Fehler-/Abandonpfad nicht als sicher ungesendet terminalisiert. Der accountweite Proof bindet den konkreten Kandidaten-/Request-/No-Send-Kontext gehasht.

`test_trading_entry_safety.js`, `test_trading_dispatch_fence.js`, `test_trading_recovery.js` und `test_trading_entry_expiry.js` nach den jeweiligen Korrekturen grün. Die direkten alten-ID-/Fremdposition-/ACK-Repros waren zuvor rot. Das sind lokale Proof-/Engine-/DB-Neustartnachweise, keine Behauptung eines zuvor nachgewiesenen realen Provider-Exploits und keine Gesamtfreigabe. Details: [003-ENTRY-SAFETY-IMPLEMENTATION-NOTES.md](003-ENTRY-SAFETY-IMPLEMENTATION-NOTES.md).
