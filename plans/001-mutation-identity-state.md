# Plan 001: Konto-Mutationen, Orderidentität und Zustandsübergänge absichern

> IN PROGRESS. Der Folgeauftrag autorisiert die lokale Umsetzung. Nachweise und verbleibende Arbeiten stehen in IMPLEMENTATION-STATUS.md. Noch keine Gesamt-, Provider- oder Release-Abnahme.
>
> Arbeitskopie: `C:/Users/nikla/Desktop/tsx-core`. Geplant gegen `f8089277d0667dd45bcf070037800d423fd89254`, 2026-09-02.
> Drift zuerst prüfen: `git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src exchange_executor tests`. Nicht zu diesem Plan gehörende Änderungen in den unten genannten Dateien erst fachlich abgleichen. Keine fremden Änderungen überschreiben.

## Status und Zweck

Priorität P0/P1 · Aufwand L · Änderungsrisiko HOCH · Kategorie Sicherheit/Korrektheit · Voraussetzung keine.
Audit-IDs: P0-02, P1-09, P1-10, P1-11, P1-12, P1-16, P1-17, P1-18, P1-20, P2-09, P2-13, P2-14, P2-19.

Ein früher Safety-Check reicht nicht, wenn während anschließender Netzwerkaufrufe eine Kontosperre aktiviert wird. Dieselbe Order darf außerdem nicht unter vertauschter Identität oder veraltetem Zustand gespeichert werden. Dieser Plan schafft die gemeinsame Grundlage; Entry-Abwicklung und Wiederanlauf werden anschließend in eigenen Paketen angeschlossen.

## Aktueller Zustand und Konventionen

- `src/trading_engine.ts:182`: setIntentState schreibt den Zielstatus ohne Expected-State.
- `src/trading_engine.ts:518`: storeOrderResult adressiert die vom Ergebnis gelieferte Client-ID; changes wird nicht universell geprüft.
- `src/trading_engine.ts:1709`: Remote-Persistenz überschreibt Ausführungsmenge und Status.
- `src/ccxt_exchange.ts:46`: accountPayload überträgt nur id, exchange, mode.
- `exchange_executor/ccxt_adapter.py:297`: Protected-Result-Zuordnung erfolgt nach Arrayposition.
- `src/db.ts:440`: lokale Eindeutigkeit besteht nur über account_id/client_order_id.

Belastender Ausschnitt, `exchange_executor/ccxt_adapter.py:149`:
```python
exchange_order_id = str(order.get("id") or client_order_id)
```
Fehlende Exchange-ID darf nicht durch eine erfundene, wie bestätigt wirkende ID ersetzt werden.

Testkonvention aus `tests/test_ccxt_exchange.js:1`:
```js
import assert from 'node:assert/strict';
```
Die Datei benutzt lokale HTTP-Fakes und temporäre SQLite-DBs. Diesen Stil übernehmen. Decimal-Strings und bestehende Fehlerklassen beibehalten; keine Float-Konvertierung der Geld-/Mengenwerte. ADR 0012 legt REST als Autorität fest; WebSocket-Ereignisse bleiben Wecksignale. Account-Fanout bleibt unabhängig.

## Scope

Nur folgende Bestandsdateien und neue, hier benannte Module:
- `src/trading_engine.ts`, `src/trading_runtime.ts`, `src/trading_web_control.ts`, `src/trading_repository.ts`, `src/trading_types.ts`, `src/trading_errors.ts`, `src/ccxt_exchange.ts`, `src/db.ts`.
- Neu: `src/trading_mutation_coordinator.ts`, `src/trading_state_transitions.ts`, `src/exchange_contract_validation.ts`.
- Ergänzung bei Umsetzung: `src/trading_order_repository.ts` kapselt kurze CAS-/Merge-Transaktionen, um die Engine nicht weiter zu vergrößern; zugehörige Repository-/Boundary-Tests und `exchange_executor/tests/test_mutation_identity.py`. Drei alte Migrationstest-Fixtures benötigen ihre zuvor fehlenden Trading-Tabellen. Keine produktive Migration wird wegen unvollständiger Fixtures abgeschwächt.
- `exchange_executor/server.py`, `common.py`, `ccxt_adapter.py`, `ccxt_client.py`, `ccxt_profiles.py`, jeweils unter exchange_executor.
- Neu: `exchange_executor/order_identity.py`, `exchange_executor/order_evidence.py`.
- `tests/test_ccxt_exchange.js`, `tests/test_trading_engine.js`, `tests/test_trading_failures.js`, `tests/test_trading_web_control.js`, `tests/test_trading_core.js`, `tests/run_all.js`.
- Neu: `tests/test_trading_mutation_coordinator.js`, `tests/test_trading_state_transitions.js`; `exchange_executor/tests/test_contracts.py`.

Nicht ändern: Handelsgrößen, Strategieparameter, Provider-Allowlist, Server, Credentials, Stream-Reconnect-Fix, UI-Neugestaltung. Keine neuen Börsen. Keine automatische Löschung historischer Orders.

## Ausführung und Befehle

Node 22.x, npm 10.9.x, Python 3.12, CCXT exakt 4.5.75 verwenden. Vorhandene Windows-Testumgebung: `C:/Users/nikla/AppData/Local/Temp/tsx-core-ccxt-py312/Scripts/python.exe`. Kein Produktions-Konfigurationspfad.
- `node --import tsx tests/test_ccxt_exchange.js` und `node --import tsx tests/test_trading_failures.js`: Exit 0.
- `node --import tsx tests/test_trading_mutation_coordinator.js` und `node --import tsx tests/test_trading_state_transitions.js`: nach Erstellung Exit 0.
- `python -B -m unittest discover -s exchange_executor/tests -v`: alle Fake-Tests grün.
- `npm run typecheck`, `npm run lint`, `npm run lint:python`, `npm run quality:architecture`, `npm run quality:complexity`: Exit 0.
- Schlussgate `npm run test:js`: Exit 0.

Git: langfristig nur main. Dieser Plan autorisiert weder Commit noch Push/Release/Deployment; erst bei ausdrücklichem Umsetzungsauftrag dessen Git-Vorgaben befolgen. Änderungen anderer Arbeit erhalten.

## Schritte

### 1. Regressionen und Zustandsmodell festhalten

Neue Coordinator-/Transition-Tests in tests/run_all.js registrieren. Ein Fake muss Submit nach einer unterbrochenen Snapshot-Abfrage fortsetzen können, während Kill/Execution-Aus/Live-Aus ausgelöst wird. Weitere Fakes: vertauschtes Batch, leere/falsche IDs, stale Snapshot, canceled mit anschließend belegtem Late-Fill, Retire-vs-Update.

Zustand und Ausführungsmenge getrennt modellieren:
- filled_quantity monoton, niemals kleiner; größer als bestätigte Ordermenge ist Konflikt.
- Terminale Orders werden nicht wieder open. Ein nach Cancel belegter Late-Fill darf die Menge erhöhen; canceled wird nur bei vollständigem belastbarem Ausführungsbeweis zu filled.
- Intent-Transition-Matrix mit CAS über erwarteten Status plus Versionszähler. completed/failed/cancelled werden nicht durch verspätete monitoring-Updates überschrieben.
- Fehlende Werte sind unknown, nicht automatisch 0.

**Gate:** Neue Tests müssen vor der Reparatur den jeweiligen Defekt gezielt zeigen; nach Schritt 2–5 laufen die oben genannten gezielten Testdateien mit Exit 0. Einen erwarteten roten Test dokumentieren, nicht den gesamten bestehenden Baseline-Lauf akzeptieren.

### 2. Einen gemeinsamen Mutationspfad schaffen

TradingMutationCoordinator als eine instanzgebundene FIFO-Queue pro Account einführen. Engine, Runtime und Web-/MCP-Control verwenden dieselbe Instanz; verschachtelte Operationen erhalten expliziten Kontext statt einen zweiten Lock zu nehmen. Mehrkontooperationen iterieren in stabiler Konto-ID-Reihenfolge, ohne gegenseitig verschachtelte Locks. SQLite-Transaktionen kurz halten; keine DB-Transaktion über Netzwerkawait.

Operator-Sperre veröffentlicht synchron einen Fence/Epoch, bevor sie auf laufende Kontoarbeit wartet. Neue Entry-Dispatches prüfen unmittelbar vor ihrer Übergabe Accountstatus, Identitätsgeneration, Runtime-Kill, Execution/Live-Gate, TTL und fortbestehende Ausführungsberechtigung gegen aktuelle Daten. Eine Sperre darf veraltete vorbereitete Pläne nicht nachträglich freigeben.

Bereits vor dem Fence an den Executor übergebene Requests können nicht „zurückgenommen“ werden: explizit als in-flight/draining verfolgen. Sperrantwort darf dann nicht behaupten, alle Entries seien bereits beendet. Plan 003 übernimmt deren Cancel/Proof. Protective Cancel/Stop/Flatten bleiben bei Entry-Sperre erlaubt, aber nur mit Ownership und Identitätsprüfung.

**Gate:** Coordinator-Test: verzögertes Prepare + Sperre => null neue Dispatches nach Fence; bereits vorher gestarteter Dispatch => draining; Konto B bleibt trotz blockiertem Konto A bedienbar; keine Deadlocks.

### 3. Side Effects an Identität binden

Alle Submit/Protected/Cancel-Schreibverträge erhalten verpflichtend expectedAccountFingerprint und credentialGeneration. Executor vergleicht sie vor jedem Side Effect mit dem unter demselben Account-Lock gepinnten Client/Credentialstand. Credential-Ersetzung darf einen noch benutzten Client nicht austauschen/schließen. Ungebundene Legacy-Konten benötigen zuerst Verify und persistierte Bindung, keine implizite Identitätsübernahme beim Submit.

Cancel erhält clientOrderId **und**, falls bekannt, exchangeOrderId plus kanonisches Providersymbol. Stimmen beide nicht überein: Konflikt, kein Cancel. Ist nur Client-ID vorhanden, gezielt auflösen; bei Nichtwissen nicht blind an einer anderen Order probieren.

Batchresultate nach exakter Client-ID zuordnen; fehlende IDs ausschließlich über belegte Order-/Parent-Identität nachlesen. Nie Index/Preisähnlichkeit. Erfolgsantwort verlangt echte Exchange-ID und die erwartete Request-ID. Separaten Typ für unklaren Dispatch mit nullable Remote-ID führen; dieser ist keine bestätigte Order und hält Recovery offen. Keine Schreibwiederholung nach Timeout.

**Gate:** CCXT-Node/Python-Tests: reversed batch richtig; doppelte/mismatched Antwort abgelehnt; missing ack bleibt unknown ohne erfundene Exchange-ID; Fingerprint-/Generationwechsel vor setLeverage/create/cancel bewirkt null Side Effects.

### 4. DB-Identität und monotones Merge migrieren

Einen normalisierten remote_order_key speichern: versioniertes Tupel aus Providerprofil, Providersymbol und unveränderter Exchange-ID; account_id ist zusätzlicher DB-Scope. Eindeutiger Partial-Index auf account_id/remote_order_key für belegte IDs. Client-ID bleibt separat eindeutig. Symbolkontext verhindert Annahmen über globale Provider-ID-Namespaces.

Migration prüft Duplikate vor Indexanlage. Konflikte vollständig melden, nicht Zeilen löschen oder IDs umschreiben. Alte Rows nur backfillen, wenn Providersymbol belegbar; sonst gezielte Recovery nötig und keine Freigabe. Schemaänderung transaktional und erneut ausführbar.

Order-Evidence-Merge in Python und Node mit derselben Fixture-Matrix: endpoint provenance und tatsächliche Providersequenz/-zeit berücksichtigen, kumulative Menge maximieren, widersprüchliche Terminalzustände als Konflikt erhalten. Lokale Empfangszeit ist kein kausaler Provider-Zeitstempel. DB-Updates CAS und changes===1; legitime idempotente Wiederholung ausdrücklich von „0 Zeilen gefunden“ unterscheiden. Account-Update erst nach erfolgreichem Commit benachrichtigen.

**Gate:** State-Transition-Tests plus test_trading_core: stale open kann canceled/filled nicht reaktivieren; Late-Fill nicht verlieren; doppelte Remote-ID verhindert; Migration wiederholt ohne Datenverlust; Retire-Race liefert kontrollierten Konflikt statt Erfolg/null.

### 5. Trust-Boundary schließen

In exchange_contract_validation Request-bezogene Validatoren für Market/Account/OpenState/WriteResult zentralisieren. Dezimalwerte endliche normale Strings, Mengen nicht negativ, Preis/Raster positiv, Enumwerte geschlossen, Zeitpunkte sichere Integer innerhalb definierter Uhrtoleranz, Symbol entspricht Anfrage beziehungsweise bekanntem Provider-Mapping. Keine erfundenen Defaults für fehlende Pflichtdaten.

Remote-clientOrderId bleibt nullable; exchangeOrderId für bestätigte Orders Pflicht. Fills ohne belastbare Orderzuordnung werden von Plan 002 als separate unresolvedEvents geliefert, nicht als ungültiger „normaler Fill“ kaschiert. Authentische Ordersemantik bleibt separat von lokaler Rolle. Zeitliche Cross-Object-Widersprüche nicht als Beweis für Betrug behandeln, sondern Evidenz unvollständig markieren.

**Gate:** test_ccxt_exchange enthält negative Fixtures für jedes Vertragsfeld und Request-Mismatch; alle Abschlussbefehle grün. Refactoring in kleine Module, keine Aufweichung der Architektur-/Komplexitätsgrenzen.

## Done / STOP / Wartung

Done: alle Befehle Exit 0; neue Race-/Identitäts-/Migrationsfälle registriert und grün; keine produktiven Side Effects; Änderungen ausschließlich im Scope; Indexstatus mit Testnachweisen aktualisiert.

STOP: unerwarteter Quellstand; unbekannter Order-ID-Namespace oder nicht rekonstruierbare Migrationsduplikate; fehlender vertrauenswürdiger Credential-Bindungsweg; notwendige Umgehung eines Safety-Gates; zweimal fehlschlagendes Gate; notwendige Änderung außerhalb Scope. Bericht statt automatischer Bereinigung.

Wartung: Jeder neue mutierende Endpoint muss Coordinator und Side-Effect-Identität nutzen. CCXT-Upgrades brauchen erneut die gemeinsame Status-/Batch-Fixture-Matrix. Dieser Plan allein macht noch keine Kill-Switch-Stornierung oder vollständige Restart-Recovery; Gesamtfreigabe erst nach Folgepaketen.
