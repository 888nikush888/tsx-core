# Plan 004 – ursprüngliche absolute Entry-TTL (Schritt 4)

Stand: 2026-09-02. Ausschließlich lokale Implementierung und Paper-/Fake-Nachweise. Keine Providerverbindung, Kontoänderung, Veröffentlichung oder Releasefreigabe. Schritte 1–3 (Modus, Preisgrenze, Leverage-Tiers) sind durch diese Notiz nicht erledigt.

## Implementiert

- `TradingPlan.entryExpiresAt` ist eine absolute Millisekunden-Deadline. Neue Engine-Pläne persistieren sie im vorhandenen Plan-JSON; optional/null dient ausschließlich dem Lesen alter Pläne. Keine Datenbankmigration und keine Änderung der gewünschten Strategieparameter.
- Ursprung ist der belegte Intent-Zeitpunkt; bei gepinntem Workflow gewinnt zusätzlich der frühere zugehörige Run-Zeitpunkt. Ein fehlender/ungültiger referenzierter Run ist kein Ersatzursprung. Ein vorhandenes früheres Plan-Ablaufdatum gewinnt; spätere Werte verlängern die konfigurierte ursprüngliche TTL nicht.
- Preflight, erneute Prüfung nach Marktlesen, finale Admission und der synchrone Fence nach dem letzten Journal-Await verwenden diese Deadline. Zwischen synchronem Fence und tatsächlichem Adapteraufruf liegt weiterhin kein Await. Startup-Autorität und Coordinator-Epoche bleiben eigenständige zusätzliche Gates.
- `cancelExpiredEntries` verwendet Intent-/Run-Provenienz und Plan-Deadline, nicht die spätere Order-Erstellungszeit. Noch nicht sicher terminale Entry-Zustände werden über den persistenten, konto-serialisierten Drain aus 003 behandelt; die bestehende Begrenzung pro Konto bleibt unverändert.
- Nach positivem lokalen No-Dispatch-Beweis kann ein Legacy-Plan mit belegbarem Ursprung ausschließlich um die Deadline ergänzt/verkürzt werden. Sonstige Änderungen an Markt-/Sizing-/Risikoplan führen weiterhin zum Abbruch. Der Plan-JSON-Update ist vergleichend abgesichert und erneuert `createdAt` nicht.
- Unklare Legacy-Zeitprovenienz gibt niemals eine frische Laufzeit: neue Entries blockieren; aktive Entries erhalten einen Drain. Fehlende aktive Orderidentität bleibt dabei ungelöst statt blind zu canceln. Nie gesendete abgelaufene Pläne werden lokal aufgegeben. Stops/TP und bestehende Exposure werden durch den Zeitablauf nicht beendet.

## Voraussetzungen und bewusste Grenzen

- 001–003 liefern die vorhandenen Schnittstellen `runJournaledExchangeWrite`, `recoverUndispatchedPlan`, `abandonUndispatchedPlan`, persistente Entry-Drain-Anforderungen und exakt identifizierte Cancels. Die fokussierten Lifecycle-Regressionen prüfen deren Zusammenspiel; dies ersetzt weder vollständige Paketabnahme noch echte Provider-Evidenz.
- 006 liefert bereits dauerhafte Eingangs-/Run-Zeitanker einschließlich Fallback-Promotion. Deshalb ist keine zusätzliche Änderung in `workflow_repository.ts` nötig.
- Das derzeitige `ExecutableSignal`-/Parser-Schema besitzt kein eigenes Signalgültigkeitsende. Ein vorhandenes früheres Plan-Deadline-Feld wird beachtet; keine neue Signal-/Parsersemantik wird behauptet oder in diesem Teilschritt erfunden.
- Laufende Schutzmaßnahmen bleiben zulässig. Ein absoluter Entry-Ablauf ist keine Positionslaufzeit und keine Erlaubnis, Stops zu entfernen oder fremde Orders anzufassen.
- Für aktive Altpläne wird die konservative Deadline beim Lesen abgeleitet, ohne historische Ausführungspläne pauschal umzuschreiben. Ein unklarer Altbestand wird nicht automatisch repariert.

## Dateien und lokale Prüfung

Produktionscode: `src/trading_types.ts` (nur Plan-Feld), `src/trading_risk.ts` (Zeitanker/Deadline), `src/trading_engine.ts` (nur TTL- und eng zugehörige Legacy-Revalidierung).

Tests: neue `tests/test_trading_entry_expiry.js`, enge Ergänzungen in `tests/test_workflow_fallback.js` und Registrierung in `tests/run_all.js`.

- TDD: Der neue Zeitanker-Test scheiterte zunächst mit fehlendem `entryExpiresAt`; danach grün.
- Neue fokussierte Fälle: 90 Prozent verbrauchte TTL, exakte Grenze, Restart, frühere/spätere explizite Deadline, ungültiger Ursprung, Legacy-Plan-Recovery ohne neue Uhr, aktive Legacy-Orders mit jüngerer Orderzeit, unklare Provenienz, nie gesendeter abgelaufener Plan, Deadline-Ablauf nach dem letzten Journal-Await und unveränderter Stop einer tatsächlich gefüllten Paper-Position.
- Fallback-Regression: Promotion nach 90 Prozent Laufzeit; ursprünglicher Run gewinnt auch gegen einen künstlich jüngeren Legacy-Intent-Zeitstempel. Vorhandener abgelaufener Fallback-Fall bleibt ohne weitere Kandidaten/Orders.
- Node 22.23.2: erweiterter Schlusslauf mit allen zwölf fokussierten Dateien grün: `test_trading_core.js`, `test_workflow_fallback.js`, `test_trading_engine.js`, `test_trading_failures.js`, `test_trading_entry_commitment.js`, `test_trading_recovery.js`, `test_trading_entry_expiry.js`, `test_trading_mutation_coordinator.js`, `test_trading_protection.js`, `test_trading_take_profit.js`, `test_trading_emergency.js`, `test_startup_authority.js`. Gesamttypecheck erneut grün; `git diff --check` grün.
- Fokussiertes ESLint mit `--max-warnings 0`: grün. Architektur: 100 Module, 358 interne Imports, 0 Zyklen. Complexity: 0 Warnungen, Maximum 15; keine Budgetlockerung.

Offen: abschließende integrierte Tests nach den parallelen Änderungen, 004-Schritte 1–3, die Paket-008-Provider-/Release-Abnahme und sämtliche externen Betriebsnachweise. Diese lokale TTL-Änderung erzeugt keine Livefreigabe.

## Nachtrag: ursprüngliche Frist bis zum Sidecar-/SDK-Transport

Der ursprüngliche Bericht oben belegt den synchronen Engine-Fence, nicht die nachfolgenden asynchronen Transportgrenzen. Der erneute 004-Abgleich fand eine reale Lücke: `requestFromOrder` transportierte `entryExpiresAt` noch nicht; nach dem Tokenlesen begann `ccxt_exchange.post` eine neue Transportfrist. Ein später freigewordener Python-Mutationslock oder ein langsamer Modus-/Tierread konnte deshalb noch nach dem ursprünglichen Signalablauf senden.

Zwei reine In-Memory-Reproduktionen mit unveränderter ursprünglicher Frist zeigten jeweils genau einen Batch-Send 100 ms nach Ablauf: einmal nach verzögerter Mutationsübernahme, einmal nach finalem Modusread. Kein Providertransport und keine Originaldatei wurden dafür verändert. Anschließend wurden neue Regressionen zunächst rot ausgeführt; der Root hat den engen Implementierungsumfang ausdrücklich freigegeben.

Jetzt implementiert:

- `ExchangeOrderRequest.entryExpiresAt` übernimmt ausschließlich für Entry-Legs das bereits persistierte Originaldatum. Die Typoptionalität dient alten Originalen; neue nicht-reduceOnly-Sends ohne sichere positive Ganzzahl werden verweigert. Kein frischer TTL-Start, keine Schemaänderung.
- `exchange_entry_deadline.ts` erfasst Datum und ursprünglichen Request vor jedem Await. Node prüft vor Tokenzugriff, nach Tokenzugriff und vor HTTP. Der Body wird vor dem Await kopiert; eine geänderte Originalfrist wird nicht versandt. Der Transportdeadline ist das Minimum aus dem einmal gestarteten Transportbudget und der Originalfrist.
- Python `entry_deadline.py` erfasst die unveränderte Frist bereits vor dem Mutationslock, kopiert die auszuführenden Requests vor dem Lock und begrenzt auch ein zu großzügig geliefertes Transportbudget selbst. Nach Lock, Modus-/Tierreads und vor Leverage-/Ordermutation wird die Originalbindung geprüft. Manipulation sowohl des Originalrequests als auch der privaten Vorbereitungskopie scheitert.
- `ccxt_sdk_policy.py` prüft in einer tasklokalen `ContextVar` zusätzlich nach dem realen CCXT-Rate-Limiter und Signing, unmittelbar vor `fetch`. Nur der betreffende Entry-Auftrag trägt den Context; nach Rückkehr/Exception wird er zurückgesetzt. Kein globaler Account-Timer, keine Monkeypatches am gemeinsam benutzten Client während eines Requests.
- `server.py` prüft ein bereits abgelaufenes Entrydatum vor dem allgemeinen Transportdeadline und liefert `ENTRY_INTENT_EXPIRED`, `ENTRY_DEADLINE_UNPROVEN` oder `ENTRY_DEADLINE_CHANGED`. Kein pauschales `sideEffects=false`: ein Fehler kann nach einer bereits autorisierten Leverageänderung auftreten.
- Ein mögliches Order-Send mit späterem Antwortverlust bleibt `ORDER_OUTCOME_UNRESOLVED`; keine Umdeutung in sichere Abwesenheit, kein Wiederholen/Fallback/Flatten. Eine echte spätere ACK bleibt echte Evidenz. Cancel, Stop und Emergency-Reducing ohne neue Entrybindung behalten ihr eigenes Budget.
- Root hat den rein lesenden Originalplanvergleich ergänzt: Nur tatsächlich fehlendes Feld in einem alten Original darf aus einer neuen erwarteten Vergleichskopie entfernt werden. Vorhandene falsche/null-Fristen bleiben Widersprüche; alte Journalbytes werden nicht verändert. Das echte Outboundmatching bleibt streng und bekommt keine Altfrist-Ausnahme.

Neue Tests: `tests/test_entry_deadline_transport.js`, `exchange_executor/tests/test_entry_deadline.py`, `exchange_executor/tests/test_entry_deadline_sdk.py`; explizite neue Entryfelder in den bisherigen CCXT-/Python-Fixtures. Runner registriert den Node-Test. Root pflegt den Sonar-Python-Quellscope.

Lokale Nachweise: zwölf neue Python-Fälle einschließlich beider Wartepfade, erster/finaler Modus und Tier, beide Manipulationspunkte, fehlende/ungültige/abgelaufene Originale, präzise HTTP-Klassifikation, gültiger Send, Late-ACK/Unknown, unabhängiger Schutzstop, danach echter signierter Cancel und paralleler anderer Task. Der echte CCXT-4.5.75-Signer wird mit ausschließlich synthetischen Schlüsseln/Märkten durchlaufen; Transport ist unterhalb des Produktions-Fetch-Fence abgefangen. Die neue Frist wird nicht als erfundener SDK-/Providerparameter in den Orderbody geschoben.

Grenze: Dies begrenzt den lokalen Dispatch und sein Transportbudget. Ein vor Fristablauf begonnenes Netzgeschehen kann nicht nachträglich als sicher ungesendet gelten; die spätere Providerannahme ist kein atomarer lokaler Zeitpunkt. Es wird keine providerseitige Annahme-/Ausführungsgarantie oder neue native `processBefore`/`expiresAfter`-Semantik behauptet. Der bestehende 003-Drain bleibt für mögliche/aktive Entries erforderlich.

Die aktuelle anforderungsgenaue Gesamtabgrenzung einschließlich historisch überholter Restverweise steht in [004-REQUIREMENTS-REVIEW.md](004-REQUIREMENTS-REVIEW.md).
