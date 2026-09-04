# 003: gemeinsamer, belegter Exit-Cancel-Retry

Stand: 2. September 2026. Begrenztes lokales Teilpaket; **keine vollständige 003-, Provider- oder Release-Abnahme**. Keine Konto-/Börsenverbindung, kein Deployment, kein Commit, keine neue Migration.

## Befund und Umsetzung

Vorher konnten Entry-Cancels nach einem frischen „weiter aktiv“-Beleg fortgesetzt werden. TP-Rebalance blockierte dagegen `cancel_pending` schon vor der Auswahl; Closure-Siblings akzeptierten nur `open`/`partially_filled`; alte Stops scheiterten erneut am ungelösten Journal. Außerdem existierten separate Fünferlimits für Entry-Drain, TP und Closure, während Stopcleanup kein gemeinsames Limit hatte.

Neue kleine Module:

- `src/trading_cancel_budget.ts`: genau fünf Versuche pro lebendem äußerem Account-Mutationskontext. Alle Reconcile-Pässe, Entry-/Exit-/Emergency-Unteraufrufe und explizit weitergereichten Kontexte teilen diesen Topf. Einmalige Permits sind an Konto, Client-ID und den konkreten lebenden Besitzer gebunden. `@runtime` vermischt keine Kontotöpfe. Auch ein unauflösbarer Entry verbraucht weiterhin einen Scheduling-Versuch, damit die bestehende faire Rotation erhalten bleibt.
- `src/trading_cancel_evidence.ts`: maximal zehn Sekunden alte vollständige Quellen (`orders`, `positions`, `fills`, `targeted_orders`), kein zukünftiges/umgekehrtes Zeitfenster. Der Read muss nach dem vorherigen Versuch begonnen haben. Genau eine passende Client-/echte Exchange-ID im richtigen Provider-Symbol, Rolle, Seite, reduceOnly, Preis/Trigger und Gesamtmenge; bekannte monotone kumulative Ausführung und positive Restmenge. Fremde Bindung, Duplikate, Abwesenheit, unbekannte/verbrauchte Menge und Teilquellen verweigern die Autorisierung.
- `src/trading_cancel_recovery.ts`: gemeinsamer Journal-Recoverypfad; bestehende Entry-Exports sind Wrapper. `dispatching`/`unresolved` wird ausschließlich als `fresh_exact_cancel_still_active` aufgelöst. Ein belegbar ungesendetes `prepared` wird aufgegeben und anschließend als neue Generation sicher vorbereitet. Request-Hash, Originalrequest, erwartete IDs und Konto-/Credential-Bindung müssen übereinstimmen. Ein neuer tatsächlicher Wiederholungsversand wartet mindestens zehn Sekunden nach dem vorherigen Versuch; ungesendete Prepared-Arbeit ist kein früherer Versand. Die Frist wird nicht durch eine neue Beobachtung zurückgesetzt.
- `src/trading_exit_cancel.ts`: nach dem Journal, innerhalb des bestehenden Datenbank-Dispatch-Fence, erneute Prüfung des Targets sowie der Stop-/Ownership-Bedingungen. Nach den asynchronen Schutzreads werden Target und Kontobindung nochmals geprüft; unmittelbar vor dem Send bleiben Frische und unveränderte Request-Bindung zwingend. Ein Permit ist nach Verbrauch, Kontextende oder Kontextwechsel nicht wiederverwendbar.

Persistiert wird ausdrücklich nur eine `projection: exact_target_only` mit normiertem Ziel und Herkunft, kein erfundener leerer Gesamtaccount. Diese Zielprojektion darf ausschließlich die bestehende Entry-Drain-Recovery unterstützen. Exit-Cancels benötigen immer eine neu übergebene vollständige Accountbeobachtung. Die erste Entry-Stornierung behält den bisherigen eigenen Drain-/Adapterpfad; der CCXT-Adapter führt bereits einen positiven gezielten Orderlookup vor seinem Cancel aus. Es wurde kein zusätzlicher globaler Fill-History-Vorbehalt vor diesen risikoreduzierenden ersten Entry-Cancel gesetzt.

## Schutz- und Lifecycle-Invarianten

- Die Auflösung des alten Cancelversuchs beendet **nicht** die Order-/Drain-/Exitverpflichtung. `cancel_pending` bleibt erhalten. Erst echte terminale Orderbelege und die separaten Lifecycle-Proofs dürfen terminalisieren.
- TP-Cancels werden auch dann fortgesetzt, wenn die alte Order zwischenzeitlich wieder rechnerisch zum Ziel passt: der persistierte Cancelwunsch wird nicht still zurückgenommen. Neue TP-Mengen entstehen erst nach dem folgenden Accountread mit aktualisierten Fills/Ownership.
- Ein alter Stop darf nur verschwinden, wenn die Position einschließlich aller Entryreste durch einen anderen exakt bestätigten eigenen Stop gedeckt ist. Ein selbst zur Stornierung vorgesehener Ersatz ist kein dauerhaft verfügbarer Schutz. Der Trigger darf nicht lockerer sein.
- Ein neuer Stop-ACK allein reicht nicht: zuerst ein neuer Accountread, dann gegebenenfalls der Stale-Stop-Cancel. Auf eine unmittelbar gefüllte/teilgefüllte Ersatzorder folgt ebenfalls zuerst die aktuelle Fill-/Ownership-Prüfung.
- Die Alternative zum Ersatz ist bewiesene eigene Flatness **plus** terminale Entries mit exakten positiven Remote-Belegen. Bloße Positions- oder Orderabwesenheit genügt nicht. Auch der frühere direkte Stopcleanup nach Entry-Rejection wurde auf diesen Lifecycle-Pfad verlagert.
- Das gemeinsame Budget ist keine Schutzsperre: bei Erschöpfung werden weitere eigene Positionen weiterhin auf notwendigen Schutz geprüft. Anschließend wird eine transiente weitere Reconciliation verlangt, kein neuer Fünferdurchlauf innerhalb desselben Besitzers gestartet.
- Strukturierte `ACQUISITION_MISSING`, `ACQUISITION_NOT_FRESH` und `SOURCE_INCOMPLETE` bleiben auch durch den Stop-/TP-Fehlerpfad erkennbar. Konto-Isolation und bestehende Entry-, Preis-, TTL-, Tier-, Accounting- und Risiko-Fences bleiben erhalten.

## Bewusst zusätzliche Bestätigungsrunde

Das unveränderte Drei-Pass-Limit kann nach einem Entry-Drain nun erreicht werden: Pass 1 verkleinerten Stop einreichen; Pass 2 Ersatz frisch bestätigen und alten Stop stornieren; Pass 3 TPs einreichen; der nächste äußere Aufruf bestätigt deren Zustand. Der Risikotest beweist während der Fortsetzung exakt einen aktiven Stop für Menge 1, genau zwei Cancels (Entry und alter Stop), keine neue Liquidation und im Folgeaufruf keinen weiteren Cancel. Erst die abgeschlossene Runde erstellt einen neuen vollständigen Risikobeobachtungsstand. Weder Pass-, Zeit-, Qualitäts- noch Risikobudgets wurden erweitert.

Eine ältere Failurefixture meldete nur den jeweils neuesten Stop und ließ den alten nach Ersatz-Submit aus einer angeblich vollständigen Quelle verschwinden. Diese Fixture spiegelt jetzt alle bestätigten Stops samt terminalem Cancelstatus und alle bestätigten TPs, jeweils mit explizitem Provider-Symbol. Der erwartete eine Stale-Stop-Cancel und die Mengenaussagen bleiben unverändert. Fehlende Quellen im Lifecycle-Negativtest bleiben absichtlich fehlend; nur der strukturierte Fehlercode wird zusätzlich erkannt.

## Lokaler Testnachweis

Runtime: Node 22.23.2, bestehende Abhängigkeiten. Die neuen Budget-/Evidenz-Tests begannen rot. Zusätzliche echte Rot→Grün-Nachweise: sechster Exit verursachte zunächst den falschen harten Budgetabbruch; Credential- und Mengenänderung während letzter Schutzreads führten zunächst jeweils zu einem unzulässigen Send, nach abschließendem Fence zu null Sends.

Vier neue registrierte Testdateien:

- `test_trading_cancel_budget.js`: fünf gemeinschaftliche Versuche, verschachteltes `@runtime → Konto A → Konto B`, explizite Wiedereintrittskontexte, getrennte Kontotöpfe, Verbrauch und Ablauf der Permits.
- `test_trading_cancel_evidence.js`: aktive Teilrestmenge; falsche IDs/Märkte/Rolle/Seite/reduceOnly/Trigger/Gesamtmenge; rückläufige, fehlende und erschöpfte Ausführung; doppelte/alte/fehlende/teilweise Quelle; Abwesenheit.
- `test_trading_exit_cancel_recovery.js`: Prepared-/Dispatching-/Unresolved-Crashzustände plus DB-Neustart, nur positiver Aktivbeleg erlaubt Fortsetzung; Request-Veränderung, Intervall, Quelle und Restmenge; sechs Siblings teilen fünf Versuche; unabhängiger Ersatz muss auch Entryreste abdecken und darf nicht selbst cancel_pending sein.
- `test_trading_exit_cancel_engine.js`: echte lokale Paper-/Engine-Pfade für TP- und Stale-Stop-Timeout, Neustart, unmittelbare Verweigerung, nach zehn Sekunden frischer zulässiger Retry; verspätete Credential-/Mengenänderung verhindert Dispatch.

20-Dateien-Fokusserie grün: die vier neuen Tests sowie EntryCommitment, TakeProfit, Engine, Emergency, LifecycleSafety, PaperPartialFills, MutationCoordinator, ControlRaces, DispatchFence, Recovery, Protection, EntryPriceEngine, TierFence, RiskEngine, AccountingGate, GlobalRelease. Zusätzlich ist die vollständige `test_trading_failures.js` grün. Die bestehenden Entry-Hard-Crash-, Fairness-, Cancel/Fill-Race- und unbekannte-Operation-Fälle bleiben abgedeckt.

Geänderte Dateien: gezieltes ESLint `--max-warnings 0`, Typecheck und `git diff --check` grün. Architektur zuletzt 135 Module, 574 interne Imports, 0 Zyklen. Das globale Complexity-Gate hatte beim Handoff noch zwei parallel bearbeitete 005-Warnungen in `trading_accounting_contract.ts` (`validateFundingEvidence` 20, `fundingObservation` 16); die eigenen Cancel-/Engine-Funktionen liegen innerhalb der unveränderten Budgets. Dies ist ausdrücklich kein behaupteter grüner Gesamtbaum/CI-Lauf.

## Weiter offen

Ein neuer REST-Read und ein folgender Cancel sind keine atomare Providertransaktion. Das Paket verspricht keine gleichzeitige CAS-Operation über Order-/Positions-/Fill-Endpunkte; es begrenzt Alter und Quellen und prüft lokale Bindung unmittelbar vor dem Versand. Reale Providerbelege für Cancel/Fill-Races, Stoprestverhalten und die gesamte Reparaturfreigabe bleiben Aufgabe von 008. `positionProtected` als identische Produktions-/Monitoring-SafetyProof-Projektion ist ein getrenntes verbleibendes 003-Teilpaket, nicht durch diese Änderung erledigt.
