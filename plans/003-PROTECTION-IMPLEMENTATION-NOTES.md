# 003: produktiver Positionsschutz und identische Monitoring-Projektion

Stand: 2. September 2026. Begrenztes lokales Teilpaket, keine vollständige 003-/Provider-/Release-Abnahme. Keine neue Migration, kein Konto-/Providerzugriff, kein Deployment und kein Commit. Bestehende Änderungen anderer Auditpakete bleiben erhalten.

## Befunde und Entscheidungsweg

Zuvor konnte `ensureExitProtection` nach einer lokal gespeicherten Stop-ACK vorzeitig „geschützt“ melden. Der Operational Snapshot benutzte einen ähnlichen, aber unabhängigen lokalen Stop-Status-/Mengencheck ohne Alter, Kontoversion oder Laufzeitgeneration. Der neue Regressionstest bewies zunächst rot: Nach 30.001 ms blieb der alte lokale Status weiterhin grün (`0` statt `1` unbewiesene Schutzpflicht).

Jetzt sammeln ausschließlich produktive Collector-Eingaben nach unabhängigen risikoreduzierenden Aktionen und stabiler frischer Beobachtung die ursprünglichen `positionProtected`-Proofs. Jeder tatsächlich relevante Intent erhält denselben reinen SafetyProof wie die anderen Safety-Verbraucher; negativer Proof verhindert einen erfolgreichen Schutz-Reconciliationabschluss. Teilgefüllte Stops zählen nur mit exakt bestätigter Semantik und ausreichender Restmenge einschließlich möglicher weiterer Entryfills. Negative History-/Identitäts-/Mengenbelege werden nicht in positive Urteile umetikettiert.

`ensureExitProtection` verwendet auch für eine teilweise gefüllte Entry-ACK den normalen begrenzten Reconciliationpfad; eine fehlende abschließende Safetybestätigung löst nicht selbst ein zusätzliches Flatten aus. Das bestehende Drei-Pass-Limit und der gemeinsame Fünfer-Cancelkontext bleiben unverändert. Bei benötigter Fortsetzung bleiben dauerhafte Orders/Incidents bestehen.

Ein zweiter neuer roter Fall zeigte: Unklassifizierte historische Ereignisse blockierten in `ingestOwnedState` noch vor dem eigenen Stop. Ausschließlich `applyRemoteState` kann nun die globale Unknown-History-Ablehnung bis nach den unabhängig exakt besitzbewiesenen Positionsaktionen verschieben. Sämtliche vorhandenen Identitäts-, Fremdpositions-, Namespace- und Mengenprüfungen bleiben davor aktiv. Andere Aufrufer, insbesondere direkte Emergency-/Lifecycle-Aktionen, behalten den strikten Default. Die globale Reconciliation bleibt bei ungelöster History negativ; es wird kein erfolgreicher Proof erfunden. Unbekannte/fremde aktuelle Menge wird nicht übernommen oder reduziert.

## Speicherung und abgestimmte Commitgrenze

Die bestehenden `trading_reconciliation_runs.local_snapshot_json` speichern ein versioniertes kompaktes Receipt mit unveränderten Originalproofs, Quellenhash, Beobachtungsidentität und separatem Commitbeleg. Keine zusätzlichen erfolgreichen Hilfs-Reconciliations und keine Provider-Rohantworten. Die bestehende Remote-Kompaktprojektion v2, Coalescing unveränderter Remotezustände und höchstens 256 Reconciliationzeilen je Konto bleiben bestehen.

Die Transaktionsgrenze wurde vor Umsetzung mit Root abgestimmt:

1. Originale Accountversion/Epoch aus dem Beginn des tatsächlichen Reads, Collector und Proofs binden; positive dauerhafte NoSend-Ausnahmen separat feststellen.
2. Bekannte Reconciliation-Incidents auflösen und ausschließlich das bereits bestehende `lastReconciledAt`-Metadatenupdate durchführen. Accountdaten müssen bis auf `last_reconciled_at`, `updated_at` und exakt einen Stateversion-Schritt unverändert bleiben.
3. Originalproof-Binding bleibt bei seiner ursprünglichen Accountversion. Das separate `commit.accountVersion` ist exakt diese Version plus eins; genau diese resultierende Version erhält weiterhin `ReconciledAccountEvidence` für die Root-Entry-/Freigabeverbraucher.
4. Receipt und echte/coalesced erfolgreiche Reconciliationzeile atomar schreiben. Alle relevanten Quellen, Accountversion, Frische und Epoch unmittelbar vor Commit erneut prüfen. Eine unerwartete Änderung rollt auch das Coalescing zurück.
5. Erst nach dem Commit den serialisierten Receipt-Hash im lebenden Beobachtungsregister veröffentlichen. Ein verspäteter Fence verhindert die Veröffentlichung und erzeugt eine fehlgeschlagene Reconciliation; derselbe Run-ID-Konflikt kann keine grüne Zeile retten.

Negative Proofs stehen unverändert mit `commit: null` im tatsächlich fehlgeschlagenen Run. Fehler invalidieren immer eine zuvor veröffentlichte positive Projektion. Ein vor einem Rollback gültiger alter Beleg bleibt zu Auditzwecken gespeichert, wird aber nicht wieder aktiviert.

## Invalidierung und NoDuty

Neue Module:

- `trading_protection_observation.ts`: lebende Beobachtung pro tatsächlichem DB-Handle und Account, zufällige Producer-/Observation-IDs sowie Epoch-Callback. Neues Read invalidiert vor dem Transport-Await; Timeout kann alten Schutz nicht erhalten. JSON allein kann keine lebende Producerbindung herstellen.
- `trading_protection_sources.ts`: Schutz-/Scopequellen mit Accountbindung, Runtimezustand, Intent-/Orderzuständen, eigenen Positions- und Fillmengen, Journal, Klassifikation der Remote-Ereignisse, aktueller Acquisition sowie History-/Baseline-/Accountmodegenerationen. Reine Fee/PnL-Projektionswerte sind keine Stopentscheidung. Incidentauflösung und bekannte Reconciliationzeitstempel werden nicht als beliebiger Sicherheitsdelta freigegeben.
- `trading_protection_proof.ts`: produktive Collector-Auswertung und separate positive NoDuty-Belege. Keine synthetischen Balance-/History-/Remoteannahmen.
- `trading_protection_projection.ts`: Monitoring liest ausschließlich den gespeicherten ursprünglichen Proof beziehungsweise den separaten NoDuty-Beleg und prüft Gültigkeit. Kein eigener SQL-Stopprädikat-Fallback. DB-Neuöffnung, Producerwechsel bei neuer Beobachtung, Timeout, mehr als 30 Sekunden Alter, zukünftige Zeit, Epoch, Kontoversion oder Quellenänderung verhindern Grün. Eine bereits erkannte Invalidierung bleibt auch nach lokalem Zurücksetzen bestehen.

NoDuty verwendet genau Roots `assertCandidateNeverSent` ohne Dispatch-Witness. Ein `opening/0`-Plan muss tatsächlich ungesendet und exakt gebunden sein. Prepared mit ACK-Evidence oder unerlaubter Stateversion sowie alte dispatching/unresolved werden nicht ausgenommen. Es wird **kein** positiver `positionProtected` für eine noch nicht vorhandene Pflicht erfunden. Bereits mögliche Entryreste bleiben echte Pflichten, auch bei lokaler Menge null.

Monitoring vereinigt aktuelle Pflichten mit den Intent-Scopes des jüngsten gespeicherten Receipts: Eine falsche lokale `closed`-Markierung kann alte Exposure nicht verstecken. Ein echter folgender erfolgreicher Lifecycle-Reconcile mit leerer Pflichtmenge entfernt diese alte Pflicht. Kontoweise Invalidierung bleibt getrennt; der letzte synchrone Check berücksichtigt auch einen Fence von Konto A während der Quellenabfrage für B.

## Lokale Verifikation

Neu registriert: `tests/test_trading_protection_receipt.js`. Zehn fokussierte Fallgruppen, darunter:

- echte identische Originalverdict-/Hash-Projektion; getrennter +1-Metadatenschritt;
- Ablauf/future time, lokaler Order-/Positions-/Fill-/Journal-/Kontodrift und kein Wiedergrün durch Zurücksetzen;
- Pending-Read/Timeout, DB-Reopen, JSON-Korruption, History-/Baseline-/Credentialgeneration und Kontoisolation;
- unbekannte Moneywerte ändern nicht die Stopentscheidung; Execution AUS schützt weiter;
- neue eigene Stops vor negativem Teilquellen-/Unknown-History-Abschluss, ohne pauschales Flatten;
- pristine planned/prepared NoDuty versus ACK-corrupt/dispatching; keinerlei Paper-Entryversand im NoDuty-Test;
- finaler Quellenrace rollt die Schutz-/Metadatenpublikation zurück; falscher lokaler Abschluss entfernt keine Pflicht.

Nach Integration **22/22 fokussierte Node-Dateien Exit 0**: ProtectionReceipt, Protection, Engine, Failures, GlobalRelease, LifecycleSafety, EntrySafety, ExitCancelEngine, ExitCancelRecovery, CancelBudget, EntryCommitment, Emergency, TakeProfit, Recovery, EntryExpiry, EntryPriceEngine, TierFence, RiskEngine, AccountingGate, ControlRaces, DispatchFence und PaperPartialFills.

Typprüfung grün; ESLint für geänderte Dateien mit `--max-warnings 0` grün; Architektur zuletzt 139 Module / 596 interne Imports / 0 Zyklen; globale Komplexität 0 Warnungen / 0 Überschreitungen, Maximum 15 und maximal 100 Funktionszeilen. Kein Budget/Threshold gelockert. `git diff --check` grün. Root übernimmt den vollständigen Gesamtlauf und weitere parallele Integrationsfixtures; diese Notiz behauptet keinen unveränderlichen Full-Tree-Gesamtabschluss.

## Offene Pflichten

Echte Provider-Pagination, Retention-/Konto-Baselines, Account-/Orderquellen, Crash-/Restore-Gesamtabnahme und kontrollierte Releaseabnahme bleiben separat nachzuweisen. Lokale Paper-/Fehlerfixtures sind kein Providerbeweis. Mehrere Providerreads sind zeitbegrenzte Beobachtungen, keine atomare Börsentransaktion. Das Receipt ist ein gespeichertes aktuelles Schutzurteil, keine Freigabe neuer Entries, kein Credential-Verify und keine Autorisierung fremder Stops oder Positionen.
