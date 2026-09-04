# 005 FX: expliziter Python-Recovery-Schedule

Stand: 2. September 2026. Enger, vom Root freigegebener Python-Teil; keine Node-, Datenbank-, Worker-, Intervall-, Account- oder Profilfreigabe durch diese Notiz. Ausschließlich lokale Fakes, Python 3.12.13 und CCXT 4.5.75. Kein Providerkontakt, kein Commit. Python-Quellscope nach dem unten genannten Fokuslauf eingefroren.

## Dateien und Schnittstelle

- Neu: `exchange_executor/recovery_schedule.py` für strikten Requestvertrag, gehaltene Account-/Profilbindung, fünf explizite Grants und gemeinsame Aufrufzählung.
- Eng geändert: `exchange_executor/ccxt_adapter.py`, nur Parser-/Binding-/Schedulezweig von `open_state` und `_read_open_state`. Ohne `recoverySchedule` bleibt der vorhandene Readerpfad erhalten.
- Eng geändert: `exchange_executor/account_log_scheduler.py`, expliziter Grant statt alter Mode-Parität und exakter No-op bei einem tatsächlich ungelesenen geplanten Logturn. Standardparameter `scheduled=False` bewahrt die bisherigen Aufrufer.
- Neu: `exchange_executor/tests/test_recovery_schedule.py` und `exchange_executor/tests/recovery_schedule_fixture.py`. Der Emitter liefert sieben tatsächliche SDK-Fake-Antworten für den getrennten TypeScript-Vertrag: vier Phasen, All-zero ohne Modeflag, partieller FX-Präfix und History4 mit anschließendem Log0-No-op.
- Unverändert wiederverwendet: FX-Producer und Originalreceipts, History-/Mode-/Logreader sowie genau eine bestehende `RecoveryReadBudget`-Instanz. Neues Produktionsmodul für den Sonar-Quellscope: ausschließlich `exchange_executor/recovery_schedule.py`.

`recovery.recoverySchedule` hat exakt `version:1`, `profile:'bybit-usd-fx-recovery-v1'`, `attemptId`, `revision`, `phase`, `binding`, `cooldownUntil` und `grants`. Binding enthält Konto-ID, ursprünglichen Accountfingerprint, Credentialgeneration, Live/Testnet-Modus und executionProfileHash. Der Hash wird gegen die installierte geprüfte Profilversion und den tatsächlichen gehaltenen Client geprüft, nicht aus einem selbst behaupteten FX-Receipt übernommen. Account-/Credentialbindung wird vor und nach den Lesebereichen sowie um jeden zusätzlichen Aufruf erneut geprüft.

Alle fünf Lanes erscheinen genau einmal; Arrayreihenfolge ist Ausführungsreihenfolge. Zulässige positive Grants sind targeted2, mode2, logs1, history4 und fx1..3, insgesamt höchstens fünf. Phase 0/2 erlaubt ausschließlich FX und Targeted, Phase 1 History und Logs, Phase 3 Mode, Logs und Targeted. Es gibt keine implizite Restbudget-Umverteilung. Positive Grants haben keinen Deferralgrund, Nullgrants genau einen aus `phase_deferred`, `not_due`, `not_needed`, `cooldown`. All-zero bleibt für erzwungene Schutzreads gültig; ohne Modeflag wird keine Modeantwort erfunden.

Positive Historygrants benötigen genau einen originalen Checkpoint; Nullgrants keinen. Logrequest und FXrequest sind nur bei positivem zugehörigen Grant vorhanden. `fxEvidence` ist request-only, exakt `{version:1,legIds:[...]}` mit eindeutigem, statisch erlaubtem Legset und Anzahl gleich Grant. Preise, Quellen-URLs, empfangene Receipts oder neue Zeiten werden nicht als Requestdaten akzeptiert. Unbekannte Felder, falsche Version, unsichere Zahlen, Kontrollzeichen, fremde Bindungen und übergroße Schedules werden abgewiesen.

`acquisition.recoverySchedule` bindet denselben Attempt, dieselbe Phase/Bindung und `baseRevision`; es enthält `calls`, `cooldownUntil` und fünf geordnete Laneergebnisse mit tatsächlichem Aufrufdelta und Grund. `targetedCalls` ist immer explizit. FX-Antworten erhalten unveränderte gültige Originalreceipts als Präfix des angefragten Legsets; ein fehlgeschlagenes zweites Leg löscht kein erfolgreiches erstes. Schedule-Revision, Phase und Readgrund sind weder Historienfinalität noch Coveragebeweis.

## Tatsächlich ungelesene Logturns

Ein echter Gegenfall war Phase 1 mit vier Historyreads bis zur Deadline, anschließend Log0: Eine rein versuchsweise Erhöhung der Logrevision hätte bei wiederholten Phasen eine der Forward-/Audit-Lanes dauerhaft verdrängt. Im neuen Schedulepfad ist bei `calls===0` und keinem Receipt deshalb der gesamte originale Checkpoint einschließlich Revision unverändert. Zusätzlich erscheint `readSkipped` mit `budget_exhausted`, `transient`, `unsupported` oder `invalid_evidence`. Weder alte `checkpoint.reason`-Werte noch ein weitergereichter Cooldown überschreiben diesen No-op. Bezahlte Fortschritte und der Legacy-Pfad erhalten keinen Marker.

Der permanente Test wiederholt Phase1/Log0 und Phase3/Log1 viermal und belegt die bezahlte Folge `audit, forward, audit, forward`. Der Node-Consumer muss den Marker, Basisrevision und byte-/strukturidentischen Originalcheckpoint weiterhin prüfen und darf daraus keinen Sourcecursorfortschritt erzeugen; dieser Node-Hunk liegt beim Root.

## Tatsächliche SDK-Aufrufe statt nur logischer Aufrufe

Die echte gepinnte SDK-Probe wurde zunächst rot ausgeführt. Mit `maxRetriesOnFailure=1` erzeugte eine einzige rohe Anfrage zwei Fake-HTTP-Aufrufe innerhalb eines Budgetcalls. Die echte Sammelmethode folgte mit explizitem `paginate:true` drei Cursorseiten. Global aktivierte Pagination konnte außerdem intern scheitern und einen ungelesenen positiven Bestand als leere Sammlung liefern. Der ursprüngliche Schedule war für beide Fälle rot.

Die nun ausschließlich im Schedulezweig verwendete `ScheduledReadClient`-Fassade setzt pro tatsächlichem SDK-Aufruf `maxRetriesOnFailure:0`. Sie ändert keine shared SDK-Optionen. Für `fetch_open_orders` / `fetch_canceled_and_closed_orders` wird zusätzlich `paginate:false` gesetzt; beide benötigen bereits geladene Märkte, damit kein impliziter Marktbootstrap zusätzliche HTTP-Anfragen startet. Das vorhandene SDK konsumiert diese internen Optionen vor der Signierung. Die Pins bleiben auch dann maßgeblich, wenn sich globale Optionen während `fetch2`-Throttle ändern. Ein reiner Profilhash hätte diese mutable SDK-Optionen nicht belegt.

Geprüfte Methoden und Transportpfade:

| Methode | Genau begrenzter Transport |
| --- | --- |
| `fetch_open_orders` | `/v5/order/realtime` |
| `fetch_canceled_and_closed_orders`, `privateGetV5OrderHistory` | `/v5/order/history` |
| `privateGetV5ExecutionList` | `/v5/execution/list` |
| `privateGetV5UserQueryApi` | `/v5/user/query-api` |
| `privateGetV5AccountInfo` | `/v5/account/info` |
| `privateGetV5AccountTransactionLog` | `/v5/account/transaction-log` |
| `publicGetV5MarketTickers` | `/v5/market/tickers` |

Die Regressionen prüfen globale und methodenspezifische Optionen einschließlich `defaultMaxRetriesOnFailure` / `defaultPaginate`, beide Targeted-Sammelmethoden, Retryfehler in jedem der sieben Endpunkte, Optionsdrift während SDK-Throttle sowie den verweigerten Marktbootstrap. Die echten SDK-Parser und Signierer bleiben aktiv, ausschließlich `fetch` ist lokal abgefangen. Die aktuelle State-/Schutzabfrage wird nicht durch eine erfundene leere Antwort ersetzt; All-zero läuft weiterhin durch die vorhandenen Pflichtreads. Ein harter Bindungs-/Vertragsfehler liefert überhaupt keinen erfundenen Fortschritt.

Das Fünferlimit betrifft die bestehenden zusätzlichen Recoveryreads. Die bereits vorhandenen Current-State-/Schutz-/Recent-Reads sind dadurch weder neu hinzugefügt noch als Teil dieser fünf umdeklariert. Die originale absolute Deadline, Reserve und gemeinsame Suspend-/Cooldownlogik bleiben bestehen; keine zweite Queue und kein zweiter Budgettopf.

## Lokale Nachweise und verbleibende Integration

Neue Tests waren zunächst rot wegen fehlendem Vertrag, später zusätzlich wegen tatsächlicher SDK-Aufrufvermehrung. Abschließender Fokuslauf nach dem letzten Quellhunk:

- `test_recovery_schedule.py`: 26 Tests grün.
- `test_account_log_reader.py`: 13 Tests grün.
- `test_history_reader.py`: 10 Tests grün.
- `test_history_pagination.py`: 8 Tests grün.
- `test_fx_evidence.py`: 22 Tests grün.
- Insgesamt 79 fokussierte Tests; Ruff für alle fünf Pythondateien und C901 für das neue Produktionsmodul grün. `git diff --check` grün.

Kein neuer vollständiger Python-/Node-/Coverage-/Mutationlauf durch diesen Teilauftrag. Der separate Node-Vertragsagent bestätigte seine sechs bisherigen tatsächlichen Emitterfälle und den strikten `readSkipped`-Zweig; der siebte Emitterfall wurde ihm anschließend gemeldet. Ein gemeinsamer Gesamtnachweis bleibt Aufgabe des Root.

Beim Root verbleiben M43-Originalpersistenz, M44-Attemptreservation und Phasen-/CAS-Fortschritt, Transport genau eines Versuchs, die due-basierte Integration in den bestehenden Runtime-/Coordinatorpfad und die konservativen FX-Consumer. Ein fehlgeschlagener Versuch darf höchstens den getrennten Schedule fortsetzen, niemals Sourcecursor/Coverage. Erzwungene All-zero/not_due-/cooldown-Reads dürfen keine Phase fortsetzen. Quoteoriginale müssen vor dem zugehörigen Fortschritt dauerhaft sein.

Die nominale Vierphasenrotation ist keine Echtzeitgarantie: lange Requests, viele Konten, Cooldowns oder fehlende Legbelege können geeignete Quotes verhindern. Die freigegebenen Grenzen bleiben höchstens 10 Sekunden vor Event/Sizing und höchstens 1 Sekunde Cross-Leg-Abstand, mit sichtbarer Provider-Snapshotzeit statt erfundener Tickzeit. Keine Stablecoin-Parität, keine weitere Währung oder Quelle, keine rückdatierte Quote, keine neue Bybit-Options-/Pre-upgrade-Fillfinalität und keine Konto-/Entry-Freigabe durch diese Pythonstufe.
