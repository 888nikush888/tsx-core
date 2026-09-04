# Plan 002: Vollständige Evidenz, Ownership und deterministischen Wiederanlauf herstellen

> IN PROGRESS. Evidenz-Persistenz, erste strenge Fill-/Ownership-Prüfungen, Operationsjournal, persistierte History-Checkpoints und Wiederanlauf nachweislich ungesendeter Pläne sind integriert. Vollständige profilübergreifende Historie/SafetyProof, Recovery-Worker und harte Prozessabbruchtests bleiben offen. Gesamtfreigabe unverändert gesperrt; aktueller Nachweis in IMPLEMENTATION-STATUS.md. Ergänzter Scope: `exchange_executor/remote_evidence.py`, `history_pagination.py`, `src/exchange_history_contract.ts`, `src/trading_history_repository.ts` und deren Tests; Paper-Snapshots ergänzen Symbolkontext ohne Änderung der Handelsparameter.

> Schrittweise ausführen, jedes Gate prüfen; bei STOP nicht improvisieren. Keine Providerkonten für Unit-Tests benutzen.
> Arbeitskopie `C:/Users/nikla/Desktop/tsx-core`; Planstand `f8089277d0667dd45bcf070037800d423fd89254`, 2026-09-02.
> Drift: `git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- src exchange_executor tests`. Erwartete Änderungen aus Voraussetzung 001 anhand dessen Abnahme prüfen; sonst Plan neu abgleichen.

## Status / Zusammenhang

Priorität P1 · Aufwand L · Risiko HOCH · Sicherheit/Recovery.
Voraussetzung: Plan 001 abgenommen. Benötigte Schnittstellen: gemeinsamer Account-Coordinator; versionierte Intent-/Order-Transitions; strikte normalisierte Identitäten; Unknown-Dispatch statt erfundener Exchange-ID.
IDs: P1-01, P1-02, P1-03, P1-04, P1-05, P1-06, P1-07, P1-08, P1-13, P1-19, P1-26, P2-06, P2-07, P2-08, P2-16, P2-25.

REST-Orders, Positionen und Fills entstehen aus getrennten Abfragen. Ein leeres Ergebnis kann unvollständige Historie sein. Wiederanlauf darf nur belegte eigene Verpflichtungen fortführen und niemals einen unsicheren Submit als „nicht gesendet“ deuten.

## Aktueller Code / zu erhaltende Entscheidungen

- `src/trading_engine.ts:485` persistiert planned + opening/0 + created-Orders; Runtime verarbeitet regulär nur pending.
- `src/trading_engine.ts:1875,1912` ordnet Positionen per Symbol/Seite zu und kopiert ganze Remote-Mengen.
- `src/ccxt_exchange.ts:299,325` zieht für Attached Stops auch historische lokale Orders heran.
- `exchange_executor/ccxt_adapter.py:653,690` liest begrenzte Historie ohne Vollständigkeitsvertrag.
- `exchange_executor/ccxt_adapter.py:252`:
```python
if not exchange_order_id:
    return None
```
Ein reales Ereignis ohne Order-ID verschwindet damit.
- `src/trading_engine.ts:1732`: Fill-Persistenz verwendet INSERT OR IGNORE.
- `tests/test_trading_failures.js:680,1046` dokumentiert unabhängige Account-Sperren. Dies **beibehalten**, nicht wegen eines gestörten Kontos global abschalten.
- ADR 0012: ausschließlich TSX-eigene Exposure verwalten; REST autoritativ; kein Blind-Fallback nach unbekanntem Submit.

Teststil: `tests/test_ccxt_exchange.js` verwendet `import assert from 'node:assert/strict';`, lokalen HTTP-Fake und temporäre DB. Python-Fixtures aus `exchange_executor/tests/test_contracts.py` erweitern. Kein Request darf zu einem echten Exchange-Host gehen.

## Scope

Bestand: `src/trading_engine.ts`, `src/trading_runtime.ts`, `src/ccxt_exchange.ts`, `src/trading_types.ts`, `src/trading_repository.ts`, `src/trading_incidents.ts`, `src/db.ts`; `exchange_executor/ccxt_adapter.py`, `ccxt_client.py`, `server.py`, `common.py`, `ccxt_profiles.py`.
Neue Module: `src/trading_recovery.ts`, `src/trading_ownership.ts`, `src/trading_evidence_repository.ts`, `exchange_executor/history_reader.py`.
Tests: bestehende `test_trading_failures.js`, `test_trading_engine.js`, `test_ccxt_exchange.js`, `test_backup.js`, `run_all.js`; neue `tests/test_trading_recovery.js`, `tests/test_trading_ownership.js`; Python `exchange_executor/tests/test_contracts.py`, neue `test_history_reader.py`.
Plan-001-Module nur an den bereits vorgesehenen Evidenz-Schnittstellen ergänzen.

Nicht im Scope: neue Börsen; generischer IP-Limiter-Umbau aller REST-/Pro-Requests; UI-Redesign; automatische Kontoentsperrung; Handel/Deployment; automatisches Schließen manueller Positionen.

## Befehle und Git

Node 22/npm 10.9, Python 3.12/CCXT 4.5.75. Jeweils Repo-Root, isolierte Testfixtures:
- `node --import tsx tests/test_trading_recovery.js`
- `node --import tsx tests/test_trading_ownership.js`
- `node --import tsx tests/test_trading_failures.js`
- `node --import tsx tests/test_ccxt_exchange.js`
- `node --import tsx tests/test_backup.js`
- `python -B -m unittest discover -s exchange_executor/tests -v`
- `npm run typecheck`, `npm run lint`, `npm run lint:python`, `npm run quality:architecture`, `npm run quality:complexity`, `npm run test:js`.

Erwartung nach jeweiliger Implementierungsstufe: Exit 0 und alle betreffenden neuen Fälle grün. Tests in run_all registrieren. Langfristiger Branch main; keine Commit-/Push-/Deployment-Erlaubnis durch diesen Plan.

## Schritte

### 1. Vollständigkeit und ungeklärte Ereignisse persistieren

OpenState-Vertrag erweitern um acquisitionStart/End, Datenquellen, Cursor-/Zeitfenster, Completeness pro Orders/Positions/Fills und unresolvedEvents. Lokale Empfangszeit ist keine Exchange-Sequenz. Unknown-Order-/Fill-Rohbelege nur redigiert und größenbegrenzt speichern, niemals Credential-/Headerdaten.

Persistente Ereignisse besitzen Account, Provider, Quelle, echte ID falls vorhanden, unveränderte relevante Payload, firstSeen/lastSeen/count und Klassifikation. Fehlende Order-ID/Trade-ID bleibt sichtbar. Provider-ID ist primärer Dedup-Schlüssel. Ohne diese: Fingerprint über vollständige normalisierte ökonomische Daten plus Herkunft nur als Wiedererkennungsindiz nutzen; unentscheidbare identische Mehrfachereignisse in Quarantäne, nicht als genau ein sicherer Fill buchen.

Auch ein Fill mit nichtleerer, aber unbekannter Client-ID muss in die ungeklärte Menge eingehen. Historische manuelle Fills können nach Beweis einer abgegrenzten Konto-Baseline als extern klassifiziert werden. Ungeklärte Ereignisse, die aktuelle Ownership, Reserve oder PnL betreffen, sperren Neueinstiege. Eine bloße Benutzerquittierung erzeugt keinen Eigentumsbeweis.

**Gate:** test_trading_ownership + Python-Tests: orderlose und unbekannte Client-ID-Fills gehen nicht verloren; identische Provider-ID mit anderem Inhalt wird Konflikt; gleiche Timestamp/Menge mit verschiedenen tatsächlichen Fills bleibt unterscheidbar oder ausdrücklich ungeklärt.

### 2. Historie fortsetzen statt abschneiden

Persistente Watermarks je Account, Provider-Symbol und Datenquelle. Bei Erstaufnahme explizite Baseline und vollständiges benötigtes Zeitfenster beweisen; relevante lokale offene/ungeklärte Order-IDs immer gezielt nachladen, auch älter als 30 Tage. Kraken-Symbolliste zusätzlich aus lokalen ungelösten Verpflichtungen ableiten, nicht nur aktuellen Remote-Positionen.

Profilgebundene Cursor-/since-/limit-Pagination mit Überlappung und wiederholbarer Deduplizierung. Fehlende unterstützte Pagination ist completeness=unknown, nicht empty. Maximal fünf zusätzliche Historienseiten pro Request, innerhalb bestehender absoluter Deadline mit mindestens einer Sekunde Antwortreserve. Unfertigen Cursor persistieren, nächster Durchlauf setzt fort. Frische Positionen/aktive Orders und konkrete Unsicherheitsauflösung vor altem Backfill priorisieren.

Zusätzliche Historienarbeit pro Provider/Umgebung seriell budgetieren, CCXT-eigene Limiter erhalten; keine fünf parallelen Seiten je Konto. 429/Retry-After und transiente Fehler lassen Cursor stehen und senken Nachladefrequenz. Dieser Umfang löst nicht automatisch alle geteilten IP-Limits mehrerer unabhängiger Prozesse; entsprechende Betriebsvoraussetzung explizit dokumentieren, keine Vollständigkeit behaupten, wenn Deadline/Limit abbrechen.

**Gate:** test_history_reader mit >500 Orders, >1000 Trades, 45 Tage alter offener Order, überlappenden Seiten, leeren Zwischen-/Endseiten, 429 und Deadline; keine verlorenen IDs, keine Cursor-Fortschreibung über fehlende Seite, nachweislich begrenzte Requestzahl.

### 3. Ownership aus ausgeführten eigenen Orders ableiten

Eigene Positionsmenge aus korrelierten Entry-/Exit-Fills rekonstruieren. Vergleiche unter Account-Coordinator Remote-Symbol/Seite/Nettoquantity mit diesem Ledger; ganze Remotequantity niemals nur wegen Symbol+Seite übernehmen. Unvollständige Fills oder fremde Differenz: Konto isolieren, fremde Menge unangetastet.

Attached Stop ohne Client-ID nur zuordnen, wenn genau ein *aktiver* lokaler Pending-Lifecycle passt **und** ein belegter Parent-/Batch-Zusammenhang vorliegt. Konto, Symbol, Seite, Reduce-only, Trigger und Menge zusätzlich prüfen. Historischer filled/cancelled Stop ausgeschlossen. Reine Parameterähnlichkeit genügt nicht.

Preflight prüft fremde aktive Orders und Exposure am Symbol. Auch nach sauberem Preflight kann extern gehandelt werden: fehlerhafte Protected-Batch-Bereinigung darf ausschließlich belegte eigene ausgeführte Menge reduzieren, niemals gesamte neue Symbolposition. Ohne Beweis Recovery/Incident, kein automatischer Flatten. Sofortige Schutzmaßnahmen müssen über den gemeinsamen Engine-Pfad journalisiert sein; keine anonymen Cleanup-Orders aus Python.

Fill-Summen gegen Ordermenge und kumulative Ausführung prüfen. Zeitversetzte Endpoints erzeugen zunächst Evidence-Konflikt, nicht stille Korrektur; negative/überhöhte Mengen sind Vertragsfehler. Weder unterschiedliche IDs blind zusammenzählen noch vermeintliche Duplikate ohne Beweis löschen.

**Gate:** test_trading_ownership: manuelle Same-side-Zukäufe, Fremdorder-Fill nach Preflight, alte ähnliche Stops, identische Order-ID-Konflikte, verspätete Fills und doppelte ökonomische Meldungen. Assert: kein unbewiesener Cancel/Flatten und keine abgeschlossene Position bei Summenkonflikt.

### 4. Recovery-State-Machine vor Neueinstieg starten

Ein persistentes Dispatch-/Cancel-Journal mit stabiler Operation-ID, erwarteter Orderidentität, Generation, Phase und Belegreferenzen einführen. Phasen mindestens prepared, dispatching, acknowledged, unresolved, resolved; Marker vor externer Übergabe committen. Harte Prozessabbrüche müssen zwischen jeder Phase testbar sein.

Start und periodischer Recovery-Worker behandeln:
- planned/created, eindeutig noch nicht dispatched: Originalplan und IDs erneut validieren; nur bei weiterhin erlaubter Runtime und gültiger ursprünglicher TTL fortsetzen, sonst sicher lokal terminalisieren.
- submitting/cancel_pending/unknown oder dispatching: Remote gezielt korrelieren; kein neues Submit nur weil die erste Abfrage leer ist. Nichtbeweisbarkeit bleibt gesperrt.
- acknowledged/open/partial: Ausführung/Schutz fortsetzen, kumulative Menge erhalten.
- opening/0, Entry+Exit remote bereits vollständig: Abschluss aus vollständiger Historie und terminalen Entries beweisen, nicht auf eine zwischenzeitlich beobachtete Position angewiesen sein.
- Restore alter planned/opening/0/created: gleicher Recoverypfad; Restore aktiviert Runtime nicht automatisch.

Unsichere lokale Orderstates selbst blockieren betroffenen Account, unabhängig von zusätzlich geschriebenen Incidents. Runtime bekommt startupScanCompleted getrennt von accountReadiness; protectionHealthy nicht länger als globale Gesundheitsaussage missbrauchen. Gesunde andere Konten bleiben unabhängig.

**Gate:** test_trading_recovery startet neue Engine-Instanz aus jeder persistierten Phase, einschließlich Restore-Fixture. Genau ein wirtschaftlicher Submit oder ausdrücklich unresolved; niemals blind zweite Order. Zwei Reconciles/Restart mehrfach wiederholen: kein Statusrückschritt, keine wachsenden Zombie-Reservierungen.

### 5. Widersprüchliche REST-Sichten abfangen

Acquisition-Fenster und Quellen prüfen. Bei Konflikt gezielte betroffene Order und Fills erneut lesen, begrenzt durch Request-/Accountbudget. Zwei gleich aussehende Antworten nicht als universellen Atomizitätsbeweis behandeln. Erst konsistente Mengen-, Ownership-, Schutz- und Entry-Verpflichtungsbelege erlauben spätere Closure/Freigabe.

**Gate:** zeitversetzte Order-/Position-/Fill-Fixtures bleiben bis zur belegten Auflösung gesperrt. Alle Befehle dieses Plans grün; unbekannte Ereignisse bleiben in wiederholten Snapshots sichtbar, ohne alle Sekunden neue identische Incidents zu erzeugen.

## Done / STOP / Wartung

Done: Recovery-, Ownership- und Historientests registriert, alle Gates Exit 0, migrationssicherer Re-Run, keine Secretwerte/realen Requests, Scope eingehalten.

STOP: Provider kann benötigte Historie oder Eigentumsnachweis nicht liefern; Altbestand lässt sich nicht eindeutig backfillen; Lösung würde Fremdexposure schließen oder Ungewissheit als Null behandeln; Gate scheitert zweimal; Scope müsste erweitert werden. Betroffenen Account ungeklärt lassen und konkrete Evidenzlücke melden.

Wartung: Neue Provider brauchen eigene Cursor-/Identitäts-/Mengenfixtures. Beendete Positionen dürfen erst nach Paket 003 vollständig abgeschlossen werden. Keine Garantie von „genau einmal an der Börse“ formulieren: garantiert wird eine persistente Absicht mit konservativer Auflösung unbekannter externer Ergebnisse.

## Geprüfte Schnittstellendetails während der Umsetzung, 2026-09-02

- Fortgesetzter Coverage-Nachweis in `history_coverage.py`, `exchange_history_coverage.ts` und erweiterten Checkpoints: zusammenhängender, profilgebundener Zeitraum statt bloßer Traversierung. Neu gelesene Zeitgrenze und tatsächliche Seiten sind für eine frische Fills-Quelle Pflicht; Node prüft dieselben Voraussetzungen vor Konto-Freigabe und verlangt bei Kraken die UID. Legacy-/Baseline-/Earlier-obligation-Reset löscht alte Coverage ausdrücklich. Neue Python-/Node-/HTTP-/Persistenztests; Restpflichten im aktuellen Statusdokument.
- Unabhängiger Review: [Bybit Execution](https://bybit-exchange.github.io/docs/v5/order/execution) defaultet `option` ohne `baseCoin` auf BTC; [Pre-upgrade Execution](https://bybit-exchange.github.io/docs/v5/pre-upgrade/execution) liegt separat. Deshalb ist V5-Linear-Endpunktcoverage **keine Konto-Coverage**, und das Konto-Freigabegate bleibt diesbezüglich geschlossen. Eine vollständigere, identitäts-/modusspezifische Einbindung etwa der [Transaktionshistorie](https://bybit-exchange.github.io/docs/v5/account/transaction-log) bleibt zu prüfen. Aktuelle Marktlisten sind dafür kein Ersatz.
- Hyperliquid-Retention-Zeuge muss strikt vor der Startmillisekunde liegen; Gleichheit genügt wegen des Last-10.000-Limits nicht. Eine vollständige Regression mit 10.001/10.000 Fills bestätigt diesen Schutz. Der legitime erste Fill nach einer leeren Kontoaufnahme braucht noch einen restartfähigen Total-Retention-Probe; diese Liveness-Lücke ist offen und darf nicht durch `len < limit` ohne beweisbares Quellenende übergangen werden.

- Weiterer integrierter Teil: Migration 33, `trading_account_baseline.ts`, `trading_baseline_classification.ts` und `test_trading_account_baseline.js`. Eine flache externe Ausgangsbasis benötigt aktuelle vollständige scoped Quellen, zwei nicht überlappende Beobachtungen, identitätsgleiche Credentials und einen terminalen eigenen Null-Ledger ohne ungelöste Operationen. Der gespeicherte Grenzzeitpunkt ist unveränderlich; nur ältere beweisbar ungebundene Ereignisse werden extern klassifiziert, nicht als eigene Fills gebucht. Spätere/konfliktäre/anonyme/ungebundene Legacy-Evidenz bleibt ungeklärt. Konto-Kill bleibt unverändert, Provenienz erscheint einmalig im Journal. Wiedergefundene ältere lokale Orders erweitern History-/Release-Scope zurück; alte Cursorantworten verlieren ihre Revision. Diese Baseline ersetzt noch nicht die laufende Provider-Fill-Coverage oder die vollständige Recovery-/Release-Abnahme.

- Aktuelle Kontobereiche sind jetzt separat in `exchange_executor/current_state.py` angebunden: Bybit-Cursor/Settlement-Bereiche und unverwaltete Produktbereiche, Kraken-Accountlisten sowie Hyperliquid-DEX-Discovery mit Bereichsbindung. Originalantworten werden vor CCXT-Normalisierung auf Pflichtsammlungen, Fortsetzung, Providerzeit und Scope geprüft. Scope-/Seitenbelege bleiben im Node-Vertrag und in der persistierten Acquisition erhalten. Ein unvollständiger frischer Abruf endet als strukturierte 503 statt mit einer abgeschnittenen Erfolgsliste. Maximal 64 aktuelle SDK-Aufrufe, bestehende Deadline/Antwortreserve; zusätzliche Recovery-/Historienarbeit weiterhin zusammen maximal fünf Aufrufe. Keine kumulierten historischen Seiten als frischen Orders-Vollständigkeitsbeweis ausgeben.
- Nachgewiesene Korrektur an der gemeinsamen Ownership-Grenze: exakter Provider-Markt wird auch für Positionen transportiert und gegen alle ausgeführten eigenen Entry-Märkte geprüft. Gleiches Canonical-Symbol/Seite/Menge in einem anderen Settlement bleibt unverwaltet; keine neue Stop-/Cancel-/Flatten-Mutation. Fehlender alter Namespace ist kein rückwirkender Ownership-Beweis.
- Zusätzliche Fixtures: `test_current_state.py`, `test_current_state_profiles.py`; echte CCXT-4.5.75-Parser mit abgefangenen Netzaufrufen, 506 Bybit-Orders/206 Positionen, 605 Kraken-Orders, leere Zwischenseiten, Überlappung, Cursorzyklen, Scopefehler, konditionale Stops, fehlende Client-ID, Deadline/Budget und veraltete Providerzeit. Externe Fill-Baseline, Retention, vollständiger Recovery-Worker und durchgängiger SafetyProof bleiben offen.
- Primärquellen für diese Abfragen: [Bybit offene Orders](https://bybit-exchange.github.io/docs/v5/order/open-order), [Bybit Positionen](https://bybit-exchange.github.io/docs/v5/position), [Kraken offene Orders](https://docs.kraken.com/api-reference/order-management/get-open-orders), [Kraken offene Positionen](https://docs.kraken.com/api-reference/account-information/get-open-positions), [Hyperliquid Perpetual-Info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals) und [offizielles Hyperliquid-SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/info.py). Zusätzlich gegen die lokal gepinnte CCXT-Implementierung geprüft. Keine Live-/Testnetkontoabnahme daraus ableiten.

- Ergänzter Implementierungsumfang: `exchange_executor/kraken_history.py`, `src/trading_history_evidence.ts`, `test_kraken_history.py` und `test_cancel_recovery.py`. Die offiziellen Kraken-v3-Quellen [Executions](https://docs.kraken.com/api-reference/account-history/get-execution-events), [Orders](https://docs.kraken.com/api-reference/account-history/get-order-events) und [Triggers](https://docs.kraken.com/api-reference/account-history/get-trigger-events) ersetzen die inzwischen ungültigen alten Dokumentationspfade. Account-UID, `elements`/`len`, `continuationToken` beziehungsweise `Next-Continuation-Token` und die genaue Ereignisverschachtelung werden explizit validiert. Der tatsächliche CCXT-Signing-Pfad für `version=v3` ist lokal getestet. Historienereignisse werden vor Fortsetzen des Cursors dauerhaft aufgenommen; sie sind keine aktuellen Positions-/Stopbeweise. Grundlegende Quellen-/Baseline-/SafetyProof-Lücken bleiben im Statusdokument offen.

- Die installierten Python-Adapter von CCXT **4.5.75** wurden direkt gelesen. Kraken Futures `fetch_orders` ruft einen Orderstatus-Endpunkt auf; `fetch_my_trades` filtert `since` erst lokal. Es ist daher kein vollständiger historischer Backfill. Gezielt bekannte IDs werden separat geladen; Client-only-Lookups bei Kraken bleiben bis zu einem belegten Profil unsupported.
- [CCXT: Historie und Pagination](https://docs.ccxt.com/docs/manual) dokumentiert die providerspezifischen Zeit-/Limit-Grenzen. Ein mit `since` gefiltertes Ergebnis beweist allein keine Vollständigkeit.
- [Bybit: Ausführungshistorie](https://bybit-exchange.github.io/docs/v5/order/execution) begrenzt Seiten auf 100 Einträge und gemeinsame Start-/Endfenster auf sieben Tage. `nextPageCursor` muss auch bei leeren Zwischenantworten erhalten bleiben. Der installierte CCXT-Wrapper hängt den Cursor an ein Listenelement; eine leere Seite kann diesen Beleg daher nicht transportieren. Vollständige Pagination muss den Response-Envelope nachweisen, nicht `len(page) < limit` als allgemeine Endbedingung erfinden.
- [Hyperliquid: Info-Endpunkte](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) dokumentiert begrenzte historische Orders und Fill-Retention. Durch weitere Abfragen kann keine bereits nicht mehr verfügbare Historie wiederhergestellt werden; solche Lücken bleiben ausdrücklich unknown.
- `history_reader.py` löst gezielte Orderabfragen/Budgetierung. Das ergänzte `history_pagination.py` setzt Bybit-Linearkontrakt-Historie und Hyperliquid-Fills unter demselben Budget fort; SQLite-Checkpoints sind an Kontoidentität und Revision gebunden. Neustart, frühere lokale Verpflichtungen, leere Zwischenantworten, überlappende Seiten, 1.205 Orders/Fills und Retry-After sind lokal geprüft. Die verbleibenden Quellenabdeckungs-/Baseline-/Kraken-/Recovery-Lücken und SafetyProof aus 003 sind damit nicht DONE.
- [Bybit: aktuelle offene Orders](https://bybit-exchange.github.io/docs/v5/order/open-order) erlaubt maximal 50 Elemente je Seite, nicht 500. Die begrenzte jüngste Closed-Order-Cachegröße darf nicht mit der Seitengröße verwechselt werden. Der aktuelle Code verwendet 50; vollständige frische accountweite Pagination inklusive Settlement-Scopes bleibt als Pflichtaufgabe offen.
- [Bybit: Orderhistorie](https://bybit-exchange.github.io/docs/v5/order/order-list) bewahrt ungefüllte abgebrochene/abgewiesene Orders kürzer als ausgeführte Orders auf. Ein leerer Endcursor hebt diese Aufbewahrungsgrenze nicht auf. Alle unzugeordneten terminalen Orders bleiben jetzt als ungeklärte Belege gespeichert, statt während eines Backfills zu verschwinden.
