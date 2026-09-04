# 001/002: tatsächlicher Recovery-Worker und harte Protected-Entry-Abbrüche

Stand 2. September 2026. Begrenztes lokales Test-/Anschlusspaket; **keine vollständige 001-/002-, Provider- oder Release-Abnahme**. Kein Server-/Providerzugriff, kein Deployment, keine echte Restoreaktion und kein Commit.

## Bestandsprüfung vor neuen Tests

Originalpläne 001 und 002 wurden vollständig gelesen. Bereits vorhanden und nicht nochmals identisch gebaut:

- `test_trading_recovery.js`: Journal-/Transition-/Wiederöffnungstests, überwiegend gezielt gesetzte Zustände und geordnetes DB-Schließen.
- `test_trading_failures.js`, `test_trading_entry_safety.js`, `test_trading_entry_expiry.js`: unveränderte Pläne/IDs, strikte NoSend-Vorbedingungen, TTL-/Account-/Workflow-/Marktdrift und Wiederöffnung nach sauberem `closeDb`.
- Child-Fixtures `entry_drain_crash.js`, `emergency_crash.js`, `take_profit_crash.js`: echte harte Prozessabbrüche für Entry-Cancel, Emergency-Flatten und TP-Replacement. Diese wirtschaftlichen Pfade bleiben eigenständige bestehende Tests.

Neu fehlte der harte **Protected-Entry**-Pfad mit tatsächlichem `processIntent`, persistierter wirtschaftlicher Paper-Akzeptanz, geöffneter ACK-Transaktion beim Abbruch und anschließendem echten Runtime-Worker statt nur direktem `processIntent`/privater Recovery-Methode.

## Tatsächlicher Worker

`TradingRuntime.startProtectionOnly()` führt den Startupscan aus. Periodische `wake()`-Läufe reconciliieren Konten, bearbeiten abgelaufene Entries und verarbeiten nur nach expliziter Entryfreigabe `pending`/`planned`/`submitting`. Unbekannte Dispatches werden durch Reconciliation und Journalbelege bearbeitet, nicht als ungesendet neu gesendet. Scanabschluss ist ausdrücklich nicht die Behauptung, jedes Konto sei gesund.

Ein neuer echter Paper-/Runtime-Test zeigte zunächst rot: `reconcileAccounts` selektierte nur `enabled = 1 AND status = 'ready'`. Ein deaktiviertes Konto mit tatsächlicher eigener Position und weggefallenem Stop bekam keinen Ersatz; ein unabhängig gesundes zweites Konto wurde im selben Scan korrekt repariert. **Root** änderte daraufhin ausschließlich die Auswahl auf den gemeinsamen obligationsbezogenen `tradingAccountTargetIds()`-Pfad. Der Test ist danach grün für Startup und tatsächlichen periodischen Wake. Neue Entries werden nicht aktiviert; clean retired und unused disabled erzeugen keine unnötigen Reads.

## Neue harte Abbruchmatrix

`tests/fixtures/protected_entry_crash_child.js` führt echte Engine-/Paperarbeit in einem separaten Node-22-Prozess aus. Der Parent wartet auf den konkret erreichten Marker und beendet den Child hart mit `SIGKILL` (Windows verborgen gestartet). Kein sauberer Fehlerwurf/Shutdown ersetzt den Abbruch. Testhooks stehen ausschließlich in Fixtures, nicht im produktiven Code.

| Abbruchstelle | Dauerhafter Zustand nach Wiederöffnung | Erwartetes Verhalten |
|---|---|---|
| Plantransaktion vor Commit | pending, keine halben Positionen/Orders | ursprüngliche Intentzeit bleibt; erst explizit erlaubter Einstieg |
| kompletter Plancommit | planned / opening 0 / created | positiver NoSend-Nachweis, identischer Plan/IDs/Deadline |
| Journal prepared | prepared / submitting / opening 0 | identischer Request und dieselbe Operationgeneration können sicher fortgesetzt werden |
| dispatching vor tatsächlichem Send | dispatching, kein Paper-Accept | ausdrücklich ungeklärt; keine negative Remoteabsence als NoSend |
| Providerhandoff vor Accept | dispatching, ein Adapteraufruf, kein wirtschaftlicher Accept | kein zweiter Adapteraufruf; anderes Konto bleibt unabhängig |
| Paper akzeptiert, ACK noch nicht zurückgegeben | dispatching, echte Paper-Entry-/Stoporders | frische positive Remote-Korrelation, kein zweites Submit |
| ACK-Transaktion vor Commit | lokale ACK-Order-/Journaländerungen rollen zurück | Remote-Accept bleibt; frische Recovery statt Blind-Retry |
| ACK committed, lokale Position noch opening 0 | acknowledged, echte lokale Legs, noch keine Mengenprojektion | normale Ownership-/Stopabstimmung |
| Entry und Stop bereits vollständig ausgeführt | lokale Position weiterhin opening 0, echte Remote-Fills, remote flat | vollständiger Tradeabschluss ohne erfundene zwischenzeitliche lokale Exposure |

Ein separater lokaler Fixture-Aufruflog zählt jeden `submitProtectedEntry`-Versuch; damit kann Papers Idempotenz bei gleicher Client-ID keinen Blind-Retry verstecken. Zusätzlich prüft der Test die tatsächlich persistierte Zahl wirtschaftlicher Paper-Entries, Originalplan/Deadline/IDs, stabile Operation-ID/Generation, wiederholte Runtime-Wakes und FK-Integrität. Dies ist ein Prozessabbruchtest, kein Stromausfall-/Datenträger-Durabilitybeweis und keine Garantie „exactly once an einer echten Börse“.

## Zweiter Anschlussbefund: abgelaufenes Prepared

Eine weitere neue rote Hard-Crash-Fixture zeigte: Nach `prepared` plus lokalen `submitting`-Legs konnte `startProtectionOnly()` nach der **ursprünglichen** Deadline die belegbar nie gesendete Vorbereitung nicht lokal beenden. `opening` blieb statt `closed`; das Vergleichsszenario `planned/created` wurde korrekt beendet. Ursache: `drainEntryCommitment` versuchte `abandonUndispatchedPlan` nur für `created`, nicht für positiv belegtes prepared/submitting.

Dieser konkrete Sourcebefund wurde an Root übergeben. **Root** erweiterte den bestehenden positiven `abandonUndispatchedPlan`-Transaktionspfad eng auf `created` **oder** `submitting`; bei fehlendem positivem NoSend-Nachweis bleibt der exakte bisherige Remote-Cancelpfad bestehen. Danach ist der harte Ablauf-/Restartfall grün. Die Tests selbst ändern keinen produktiven Recovery-/NoSendpfad.

Drei zusätzliche adversariale Hard-Crash-/Expiryfälle beweisen bei wiederholten echten Runtime-Wakes: `dispatching`, Providerhandoff vor Accept und ein nach dem harten Prepared-Abbruch ausdrücklich mit widersprüchlicher ACK-Evidence versehenes Journal bleiben ungeklärt. Kein lokales Abandon/Close, keine erfundenen terminalen Orderstates, keine neue Operationgeneration und kein zweiter Adapter-/wirtschaftlicher Submit. Die ursprünglichen IDs, Deadline und widersprüchlichen Belege bleiben erhalten. Zusätzlich ist geprüft, dass ein vor dem Crash bereits akzeptierter Entry auch nach Ablauf seiner Entrydeadline weiterhin seine eigene Position/Stops verwaltet, statt sie lokal verschwinden zu lassen.

## Restoregrenze

Der tatsächlich unterstützte Restore-Gate `assessRestoreEligibility`/`requireRestoreEligibility` verweigert Backups mit diesen offenen Intent-/Order-/Positions-/Operationspflichten. Der Test bestätigt diese Verweigerung. Eine separate **importierte Altcheckpoint-Fixture** kopiert ausschließlich eine sauber geschlossene temporäre Testdatenbank und startet mit Execution/Live AUS und globalem Kill. Sie prüft denselben konservativen Recoverypfad, unveränderte Originalpläne und keine Aktivierung durch Reopen. Das ist ausdrücklich kein behaupteter erfolgreicher Restore durch den produktiven Restoreworkflow; dessen Schutzgrenzen werden nicht umgangen.

## Nachträglicher adversarialer NoSend-Bindungsbefund

Root beauftragte zusätzlich den Vergleich des Abandon-Prädikats mit dem strengeren Candidate-Admission-Vertrag. Zwei weitere echte Runtime-Regressionsfälle beginnen mit einem tatsächlichen hard-crashed Prepared/Submitting-Plan und beschädigen danach gezielt genau `request_hash` beziehungsweise `account_fingerprint`. Nach der ursprünglichen Deadline darf daraus kein positiver NoSend-/Abschlussnachweis entstehen.

Der erste Lauf zeigte beide Fälle rot: `position=closed` und `operation=abandoned` statt unverändert `opening`/`prepared`. Ursache war der zuvor engere Prüfbereich von `hasUndispatchedPlanProof`: Phase/Evidence/Stateversion und lokale Legs genügten, ohne den ursprünglichen Request-/Kontobindungsvertrag zu prüfen. **Root** extrahierte den bereits strengeren Candidate-Vertrag nach `trading_plan_identity.ts` und verwendet ihn nun auch für Recovery/Abandon mit der tatsächlich aus der Datenbank gelesenen Kontoidentität. Der gemeinsame Nachweis bindet Originalrequest einschließlich Hash, Accountfingerprint/Credentialgeneration, Logical-Key, Operationgeneration und ursprüngliche erwartete Legs. Er repariert keine Belege und nimmt keine Ersatzidentität an.

Danach sind beide Fälle im unabhängigen Nachlauf grün: Die beschädigten Vorbereitungen bleiben `opening`/`prepared`, ohne Versand und ohne Änderung des Originalplans. Vier zusätzliche Varianten prüfen eine fremde `credential_generation`, einen veränderten `logical_key`, `generation = 2` sowie eine geänderte Requestmenge bei **korrekt neu berechnetem** `request_hash`. Alle sechs Bindungsfälle bleiben konservativ offen; die vollständige gespeicherte Journalzeile wird weder repariert noch umetikettiert. Ein Phase-/ACK-Prädikat allein ist ausdrücklich unzureichend: Der ursprüngliche Request sowie Account-, Credential-, Generation- und Leg-ID-Bindungen sind bei Recovery/Abandon genauso erforderlich wie bei Admission. Die regulären 16 anderen harten Crash-/Expiryfälle bleiben ebenfalls grün. Die neuen Tests selbst ändern keine produktive Quelle.

## Verifikationsstand / Restpflichten

Neue Dateien: `tests/test_trading_recovery_worker.js`, `tests/test_trading_protected_entry_crash.js`, `tests/fixtures/protected_entry_crash_child.js`. Beide neuen Testdateien wurden nach grünem Abschluss mit von Root freigegebenen engen Einträgen in `tests/run_all.js` registriert.

Worker-Startup/periodic/no-read ist grün nach Roots Targetfix. Die neue Crashdatei ist nach Roots beiden Recoverykorrekturen auf Schema 40 grün: neun Grundphasen, zwei expired-NoSend-Phasen, ein importiertes Altcheckpoint mit realer Restoreverweigerung, eine akzeptierte Position nach TTL-Ablauf, drei adversariale Expiryphasen sowie sechs beschädigte Originalbindungsfälle: **22 tatsächliche Child-Prozessabbrüche insgesamt**.

Der unabhängige fokussierte Nachlauf nach der Vertragskorrektur ist für neun Dateien grün: Worker, ProtectedEntryCrash, Recovery, EntryExpiry, EntrySafety, EntryCommitment, Failures, DispatchFence und ProtectionReceipt. Die zusätzlich geprüfte bestehende `test_trading_emergency.js` war in diesem Lauf bei `profile-hyperliquid-entry` mit `CUMULATIVE_EXECUTION_MISMATCH` rot (Zeile 142; Fillledger und kumulative Ausführung stimmen nicht überein). Dieser separate laufende Namespace-/Migration40-Integrationsbefund wurde an Root und den zuständigen Agenten gemeldet, nicht durch eine abgeschwächte Fixture oder Sourceänderung in diesem Paket verdeckt. Der frühere fokussierte Lauf vor diesen parallelen Consumeränderungen war einschließlich Emergency 9/9 grün; das ersetzt keinen aktuellen grünen Nachweis für Emergency.

Eigenes ESLint mit `--max-warnings 0` und `git diff --check` sind grün; keine Test-/Qualitätsgrenzen geändert. Der vollständige Projektgesamtlauf gehört weiterhin Root und wird wegen paralleler Schema40-Consumerarbeit nicht aus diesem Teilpaket behauptet.

Zuordnung der durch diese Tests belegten produktiven Korrekturen: Root verantwortet den Targetwechsel in `trading_runtime.ts` auf `trading_account_targets.ts`, den engen Prepared/Submitting-Abandon-Anschluss in `trading_engine.ts` sowie den neuen gemeinsamen Vertrag `trading_plan_identity.ts` mit dessen Consumers `trading_recovery.ts` und `trading_entry_candidate.ts`. Der Testauftrag veränderte diese Sourcehunks nicht.

## Letzte Anschlussprüfung: entzogene Autorität vor Ablauf der Original-TTL

Ein nachfolgender enger Testauftrag zu Original-002/Schritt 4 ergänzt sechs Hard-Crash-Fälle: `planned` beziehungsweise `prepared`, danach vor dem tatsächlichen `Runtime.startProtectionOnly()` jeweils Execution AUS **ohne** Kill, das Konto deaktiviert oder die ursprüngliche Route deaktiviert. Der ursprüngliche NoSend-Vertrag bleibt positiv prüfbar; weder Remoteabsence noch ein fiktives ACK dienen als Grundlage. Start und periodischer Wake nach 10.001 ms liegen ausdrücklich noch vor der ursprünglichen Deadline. Eine zuvor tatsächlich eröffnete BTC-Paperposition desselben Kontos mit ihrem exakt bestehenden eigenen Stop bleibt daneben aktiv. Der Test ruft niemals `enableEntries()` auf.

**Zunächst bestätigte rote Anschlusslücke:** Alle sechs Fälle blieben bei Startup und periodischem Wake `opening`; Prepared blieb `prepared`, statt lokal ohne Side Effect terminalisiert zu werden. Bestehende direkte `processIntent`-Tests deckten das nicht ab: Der echte Worker erreicht diesen Pfad unter `startProtectionOnly()` nicht; bei Execution AUS beendet auch `processPendingEntries` seine Arbeit vor `processIntent`. Sein unbedingter lokaler Abschlussanschluss betrachtete zuvor nur abgelaufene TTLs. Die Erweiterung war gezielt rot, bevor Root den Anschluss korrigierte; die vorherigen 22 grünen Hard-Crash-Fälle ersetzten diesen Nachweis nicht.

Root integrierte dafür `TradingEngine.retireUnauthorizedPreparations`: ein auch ohne Entryfreigabe laufender, rein lokaler Invalid-Preparation-Recoveryschritt unter dem Account-Coordinator mit einer DB-Transaktion je Plan. Nur nach positivem gemeinsamem Original-NoSend-Vertrag und aktuell fehlender ursprünglicher Runtime-/Konto-/Strategie-/Routenberechtigung erfolgt der bestehende Failure-/Abandonpfad einschließlich lokaler Orderterminalisierung und terminalem Intentstatus. Die Runtime führt den Schutzscan auch dann separat weiter, wenn dieser lokale Recoveryschritt fehlschlägt. Kein Aufruf des versendenden `processIntent` als Workaround, kein allgemeiner Drain bereits gesendeter Entries und keine automatische Runtime-/Kontofreigabe. Produktionscode bleibt in diesem Testauftrag unverändert; Root verantwortet auch die gesonderte Prüfung fairer begrenzter Auswahl und beschädigter Altpläne.

Die ergänzende echte Worker-Gegenprobe ist grün: Ein tatsächlich akzeptierter, noch offener ETH-Limitentry mit seinem aktiven eigenen Stop bleibt unter Execution AUS und Kill AUS bei Startup und periodischem Wake bestehen. Null Cancel- und ProtectedEntry-Aufrufe, Originalplan unverändert. Execution-Aus wird nicht in eine nie angeforderte Stornierung umgedeutet.

**Aktueller unabhängiger Nachlauf nach Roots Anschlussfix: 28 tatsächliche Hard-Crash-Szenarien grün**, einschließlich der sechs Startup-/Periodic-Widerrufsfälle und aller zuvor geprüften 22 Fälle. Terminaler Intent, `closed`-Position, abgebrochene lokale Legs beziehungsweise `abandoned`-Preparedjournal verhindern das spätere Revival desselben Plans; der Originalplan selbst bleibt unverändert. Der separate Worker samt BereitsGesendet-Gegenprobe ist ebenfalls grün. Neun fokussierte Dateien grün: ProtectedEntryCrash, RecoveryWorker, Recovery, EntryExpiry, EntrySafety, ControlRaces, Failures, DispatchFence und StartupTrading. Eigenes ESLint mit null Warnungen und `git diff --check` grün. Kein Fullsuite-/Provider-/Releasebeweis daraus ableiten.

Echte Provider-Retention/Pagination/Identitätsbelege, globale Startup-/Restore-/Crashabnahme und gesondert autorisierter Release bleiben offen. Die Tests benutzen ausschließlich lokale Paperdaten und temporäre Dateien. Parallele Namespace-/Migration40-Arbeit und Roots Produktions-Dispatch/NoSend-Änderungen werden nicht überschrieben.
