# 001–003: begrenzter Anforderungsnachlauf

Stand: 2026-09-02. Originalpläne 001, 002 und 003 vollständig gelesen; aktueller lokaler Worktree, nicht bloß HEAD, geprüft. Dies ist die ausdrücklich begrenzte Nachprüfung der Legacy-/Pending-/Crash- und SafetyProof-Pflichten, kein neues Architekturaudit und keine Providerabnahme. Keine externen Kontakte, Produktivänderungen oder Migrationen in dieser Analyse. Der Improve-Skill wurde ausschließlich für die lesende Quellen-/Anforderungszuordnung verwendet.

## Entscheidung

Die historischen Aussagen „andere Proof-Verbraucher offen“, „weitere Crashphasen offen“ und „vollständige Legacy-Restore-/Pending-Generation-Abdeckung offen“ sind heute zu pauschal. Die konkret geforderten Hauptpfade sind umgesetzt und ihre vorhandenen lokalen Regressionen bestanden. Zwei engere, zuvor nicht abgedeckte Fehler wurden tatsächlich reproduziert und anschließend ausdrücklich beauftragt behoben: unzulässiger No-Send-Reset eines vorbereiteten Exits mit widersprüchlicher Journalhistorie und Verhungern neuer Intents hinter einer dauerhaft ungeklärten ersten Warteschlangenseite. Die unten erhaltenen Rotbefunde dokumentieren den Ausgangszustand; der abschließende Nachlauf belegt beide Korrekturen. Keine Behauptung über eine tatsächlich doppelt ausgeführte Providerorder.

Ein parallel durch Root gefundener dritter Fehler (TTL-Fehler nach Adapterübergabe trotz ungeklärtem Journal als terminal `blocked`) wurde während des Nachlaufs behoben und durch den eigenen Nachlauf von `test_trading_entry_expiry.js` bestätigt. Die Übergabegrenze bleibt konservativ: Ein lokaler Fehler vor einem tatsächlichen Fetch ist ohne eigenständigen originalgebundenen Nichtversandbeleg kein Beweis, dass die Operation aufgegeben werden darf.

## Abschlussmatrix

| Ursprüngliche Pflicht | Konkreter aktueller Produktionspfad | Konkrete lokale Nachweise | Entscheidung für diesen Nachlauf |
| --- | --- | --- | --- |
| 001: Konto-Serialisierung, Fence, versionierte Zustände und unveränderliche Order-/Journalidentität | `trading_mutation_coordinator.ts`, `trading_state_transitions.ts`, `trading_order_repository.ts`, `trading_recovery.ts:prepareTradingOperation/runJournaledExchangeWrite` | `test_trading_mutation_coordinator.js`, `test_trading_state_transitions.js`, `test_trading_order_repository.js`, `test_trading_recovery.js`, `test_trading_control_races.js` | Geforderte lokale Grundpfade belegt. Nicht als pauschal offen führen. |
| 001/002: vorbereiteter Protected-Entry, Dispatchgrenze, verlorener ACK, Wiederanlauf | `trading_recovery.ts:hasUndispatchedPlanProof/unsentPlanOperation`, `trading_engine.ts:recoverUndispatchedPlan/retireUnauthorizedPreparations` | `test_trading_protected_entry_crash.js:hardCrashCases`, echte Kindprozessabbrüche vor Plancommit, nach Plan, vorbereitet, dispatching, vor Accept, nach Paper-Accept, im ACK-Commit, nach ACK und bereits abgeschlossenem Roundtrip; insgesamt 28 Crash-/Adversarial-Szenarien der Datei | Vorhandene Crashmatrix grün. Nur explizit belegtes No-Send wird wieder aufgenommen; unbekannte Übergabe wird nicht blind wiederholt. |
| 002: importierter Altcheckpoint und unterstützter Restorepfad | `backup.ts:stageRestore` erzwingt `requireRestoreEligibility`; Protected-Entry-Recovery erhält Originale | `test_trading_protected_entry_crash.js:importedOldCheckpointStaysStopped` (ab Zeile 180), `test_backup.js` | Belegt: unterstützter Restore verweigert das unsichere Artefakt. Separate importierte Altstand-Fixture bleibt Entry-gesperrt und wird nicht als genehmigter Restore ausgegeben. Kein Anlass, Restore für offene Verpflichtungen zu lockern. |
| 002: nachweisbare Legacy-Fillidentität, unveränderte Originale, Konflikt-/Restartverhalten | `trading_fill_identity_repository.ts`, `trading_evidence_repository.ts`, Migration 40 | `test_trading_fill_identity_backfill.js`, `test_trading_fill_identity_migration.js` (39→41), `test_trading_evidence_repository.js`, `test_trading_account_baseline.js` | Bestehende Originale/IDs/Valuations bleiben erhalten; widersprüchliche/unbelegte Altdaten bleiben sichtbar ungeklärt. Lokale Nachweise grün; keine rückwirkende Providerfinalität erfunden. |
| 002: Schutzworker trotz deaktiviertem oder fehlerhaftem anderem Konto | `trading_runtime.ts:reconcileAccounts`, `trading_account_targets.ts` | `test_trading_recovery_worker.js:disabledExposureStillNeedsWorker/acceptedEntryIsNotImplicitlyDrained`; `test_trading_account_retirement.js` | Startup und periodischer Schutz aktiver Exposure belegt, Execution-off storniert angenommene Entries nicht implizit. Sauber stillgelegte Historie blockiert andere Konten nicht. |
| 002: faire begrenzte Verarbeitung neuer/alter Intents | `trading_runtime.ts:processPendingEntries/pendingEntryBatch` verwendet jetzt `(created_at,id)`-Rotation; pro Zyklus weiterhin höchstens 100 Versuche | `test_trading_pending_fairness.js`: sechs Szenariogruppen einschließlich echtem gesunden anderen Konto; die ursprüngliche `002-pending-worker-fairness-probe.mjs` jetzt ebenfalls grün | **F2 lokal behoben.** Faire Vorbereitungsauswahl und globale Entry-Warteschlange sind getrennt nachgewiesen. Neustart verwirft nur den flüchtigen Cursor, keine dauerhaften Intents. |
| 003: kontoweite `entryAdmission` samt enger Kandidatenausnahme | `trading_entry_safety.ts:proveEntrySafety/assertEntrySafetyFresh`; ursprünglicher No-Send-Beweis; finale Engine-Fences | `test_trading_entry_safety.js` (fehlende Quellen, andere Trades, alte dispatching/unresolved, Identität/Version/Fence/Frische), `test_trading_entry_expiry.js` | Integriert und grün, nicht mehr bloß reiner Proof-Typ. Kandidatenausnahme ist keine Ausnahme für fremde/andere Exposure. |
| 003: `entriesDrained` und `tradeClosed` | `trading_engine.ts:collectLifecycleProof/assertLifecycleCommitCurrent`; Drain und beide tatsächlichen Closure-Commits; `trading_safety_repository.ts:collectAccountSafetyEvidence` | `test_trading_lifecycle_safety.js:drainCases/rejectIncompleteClosure/finalCommitRace`, `test_trading_entry_commitment.js`, `test_trading_emergency.js` | Nullposition allein reicht nicht; Drain/Closure benötigen Quellen, eigene Bilanz und keine offene Entryverpflichtung. Finale Versions-/Epoch-/Zeitänderungen rollen den Commit zurück. |
| 003: `positionProtected`, tatsächlicher Stop-Restbedarf und identische Betriebsprojektion | `trading_protection_proof.ts:collectProtectionReceipt`; `trading_protection_projection.ts:readProtectionProjection/validatedReceipt`; gemeinsames Stop-Prädikat | `test_trading_protection_receipt.js:freshnessAndPersistedVerdict/localDriftCannotRevive/timeoutReopenAndCorruption/noDutyRequiresPositiveNoSend/sourceGenerationInvalidation/accountIsolation` | Integriert und grün: Betriebsanzeige verbraucht denselben Receipt, keine zweite heuristische Schutzentscheidung. Fehlende Historie entfernt nicht die unabhängige Stop-Pflicht. |
| 003: Exit-Cancel-Fortsetzung, Emergency und TP-Generationen einschließlich Legacy | `trading_exit_cancel.ts`, `trading_take_profit_recovery.ts:recoverTakeProfitBasis`, `trading_recovery.ts:recoverPreparedExits` mit zusätzlicher ACK-/Phasen-/Originalorderprüfung | `test_trading_exit_cancel_recovery.js`, `test_trading_exit_cancel_engine.js`, `test_trading_emergency.js`; `test_trading_take_profit.js:proveActiveLegacyRecovery/proveAmbiguousLegacyReview` und harte TP-Crashfixtures; neuer `test_trading_prepared_exit_recovery.js` mit 51 Fällen | **F1 lokal behoben.** Positive rekonstruierbare Legacyfälle und bewusst unentscheidbare Fälle belegt; ursprüngliche IDs/Requests/Evidenz bleiben erhalten. |
| 003: Account- und Global-Release aus frischem gemeinsamen Proof | `trading_runtime_release.ts:releaseGlobalTradingKillSwitch`, `trading_web_control.ts` Accountfreigabe; `collectAccountReleaseEvidence` | `test_trading_global_release.js` (beide Sperrscopes, Konto hinzugefügt, Uhr, Konto-/Runtimeversion, geschützte aktive Position), `test_trading_safety_proof.js`, `test_trading_web_control.js`, `test_trading_control_races.js` | Account- und globale Owner bleiben bis zum abschließenden synchronen Commit-Fence gehalten. Frische Verify-/Balance-/History-/Ownershipbedingungen integriert und grün. Nicht mehr „Globalfreigabe offen“ schreiben. |
| 003/AUX-01: terminale Historie versus Credential-Wartung | `trading_web_control.ts:replaceAccountCredentialsOwned`, Zeilen 529–559: alte echte Bindung vor Cancel, Drain/Reconcile, danach Filter `!['filled','cancelled','rejected'].includes(status)`, Kandidatenbindung vor Promotion | `test_trading_web_control.js:terminalHistoryAllowsCredentialRotation/openOrderPreventsCredentialPromotion`: kombinierte echte Baseline-/Reconcile-/Drain-/CredentialStore-Kette mit klassifizierten terminalen Originalen und offenem finalem Gegenbefund; zusätzlich Fremdkontoabweisung/Bybit-Quellenlücke | **Kombinierter Abschlussnachweis ergänzt und grün.** Drei alte `filled/cancelled/rejected`-Originale werden erst tatsächlich `external` klassifiziert; Rotation bei gleicher Kontoidentität auf neue Generation gelingt ohne Originalverlust. Eine danach neu auftauchende offene Order verhindert die Kandidatenübernahme. Kein Produktionsfix nötig; In-Memory-Mutation des alten `orders.length`-Fehlers wird vom neuen Test erkannt. |

## F1 — widersprüchlich vorbereiteter Exit wird zu `created`

Analysequelle: `src/trading_recovery.ts:recoverPreparedExits` (ab Zeile 259), `provesUnsentExit` (ab Zeile 281) im Stand vor Root-Korrektur. Die Auswahl enthält Request, Hash, erwartete IDs und Identität, aber weder `evidence_json` noch `state_version`. Deshalb wird eine lokale `submitting`-TP-Order ohne Exchange-ID/Fill nach Restart auch dann auf `created` gesetzt, wenn ihr `prepared`-Journal bereits einen echten ACK trägt oder eine zu `prepared` unmögliche Phasehistorie (`state_version=2`) aufweist.

Tatsächlich ausgeführt:

```text
node --import tsx plans/003-prepared-exit-no-send-probe.mjs
pristine: expected created, actual created
dispatching: expected submitting, actual submitting
prepared-with-ack: expected submitting, actual created
prepared-with-history: expected submitting, actual created
exit 1
```

Jeder Fall erstellt und öffnet eine eigene temporäre SQLite-DB erneut. Originaljournal bleibt unverändert, Paperorderzahl bleibt 0, Foreign Keys bleiben gültig. Belegt war die falsche Wiederaufnahmeberechtigung; kein zweiter Send und kein echter Trade wurden ausgelöst. **Root hat den Fix umgesetzt:** zulässige Phase/Version ohne ACK, originaler `created`-Orderzustand ohne Remote-ID, keine lokale Response-/Fillpreis-Evidenz. 51 permanente Fälle über TP/SL/Flatten bestehen, darunter ursprünglich 30 falsche Resets. Root bestätigt zusätzlich echte TP-/Emergency-HardCrash-Gegenproben.

Die Probe bleibt erhalten; ihr positiver Control wurde auf die tatsächlich originale Reihenfolge `created → prepareTradingOperation → submitting` präzisiert. Ihre allererste Fassung bereitete erst auf `submitting` vor; dieser alte Control war kein ausreichender Nachweis eines ursprünglich ungesendeten Exits. Mit korrektem Control und aktuellen Produktionsprüfungen bestehen alle vier Probevarianten: nur pristine wird `created`, die drei negativen Varianten bleiben `submitting`. Dies ist die dokumentierte Grünphase, kein Rückdatieren des ursprünglichen Befunds.

## F2 — erste ungeklärte Seite blockiert unabhängiges gesundes Konto

Analysequelle: `src/trading_runtime.ts:processPendingEntries` (ab Zeile 248 im Ausgangsstand). `pending/planned/submitting` werden immer von derselben globalen ersten Seite ausgewählt. Dass `processIntent` unaufklärbare Legacyvorbereitung nicht terminalisiert, ist korrekt; zusammen mit der statischen Auswahl verhindert es aber jeden Fortschritt nach dieser Seite.

Tatsächlich ausgeführt:

```text
node --import tsx plans/002-pending-worker-fairness-probe.mjs
workerCycles=3, attempted=300, healthyAttempted=false
healthyStatusAfterWorker=pending
directEngineCountercontrol=monitoring
exit 1
```

100 explizit unvollständige importierte `submitting`-Intents mit `plan_json=NULL` bleiben mit gültigen FKs unverändert. Ein neuer gesunder Intent eines zweiten Paperkontos wird durch drei echte Worker-Wakes nie aufgerufen. Direkt durch dieselbe Engine verarbeitet erfüllt exakt derselbe Intent alle echten Entry-/Paperprüfungen und erreicht `monitoring`. Kein Fake-Green durch abgeschaltete Safetyprüfung.

**Die anschließend freigegebene Runtime-Folgearbeit ist lokal umgesetzt:** stabile Rotation ohne Legacydatenänderung oder Gateumgehung. `test_trading_pending_fairness.js` scheiterte vor dem Produktivhunk tatsächlich an `pending` statt `monitoring`. Danach bestehen sechs aufgerufene Szenariogruppen mit Mehrkonto, Restart, verschwundenen IDs, gleichen Zeitstempeln, Seitenende, früherer Neueinfügung, Midpage-Pause und unerwartetem Versuchfehler. Die ursprüngliche Probe besteht ebenfalls: 201 Versuche in drei Zyklen, gesunder Intent `monitoring`. Details und Cursorgrenze in `002-PENDING-WORKER-FAIRNESS-NOTES.md`. Keine DB-Migration, Strategieänderung oder externe Verbindung.

## Während des Nachlaufs behoben: TTL nach Adapterübergabe

Root reproduzierte einen originalen Deadlinefehler nach `sent=true`, während das Journal folgerichtig `unresolved` blieb. Der ursprüngliche bekannte Risikofehlertyp führte dennoch zu terminalem `blocked`. Aktueller `trading_engine.ts:handleIntentFailure` liest eigene `dispatching/unresolved`-Operationen und übergibt diese Information an `classifyIntentFailure`; solche Fälle bleiben `unknown` und durchlaufen `isolateUnresolvedDispatch`, statt die Reservierung oder Fallback freizugeben. Echte belegte Vor-Send-Aufgaben bleiben blockierbar. Eigener aktueller Nachlauf von `test_trading_entry_expiry.js:assertAdapterDeadlineRetainsUncertainty` einschließlich Restart grün. Kein No-Send-Beleg und keine Remote-422-Nichtausführung werden daraus erfunden.

## Ausgeführte bestehende Regressionen

Node 22.23.2, ausschließlich temporäre SQLite-DBs, abgefangene Adapter beziehungsweise Paper. Die beiden separaten Probes waren absichtlich rot; sie gehören nicht zu den folgenden bestandenen 26 registrierten Dateien:

```text
node tests/run_all.js test_trading_mutation_coordinator.js test_trading_state_transitions.js test_trading_order_repository.js test_trading_recovery.js test_trading_preparation_recovery.js test_trading_protected_entry_crash.js test_trading_recovery_worker.js test_trading_entry_safety.js test_trading_lifecycle_safety.js test_trading_protection_receipt.js test_trading_global_release.js test_trading_safety_proof.js test_trading_entry_commitment.js test_trading_emergency.js test_trading_take_profit.js test_trading_exit_cancel_recovery.js test_trading_exit_cancel_engine.js test_trading_web_control.js test_trading_account_retirement.js test_backup.js
ALL 20 TEST FILES PASSED

node tests/run_all.js test_trading_entry_expiry.js test_trading_fill_identity_backfill.js test_trading_fill_identity_migration.js test_trading_control_races.js test_trading_evidence_repository.js test_trading_account_baseline.js
ALL 6 TEST FILES PASSED
```

Nicht behauptet: Gesamtprojekt-/Providerabnahme, Auflösung unbekannter historischer Ereignisse, vollständige Kontoquellenfinalität aus Endpoint-EOF, neue Liveberechtigung oder pauschales DONE für 001–003. Die hierfür schon dokumentierten Provider-/Identitätsgrenzen bleiben unverändert. Historische Notes dürfen dagegen nicht länger bereits grün belegte lokale Proof-Verbraucher und konkrete Crashphasen erneut als unerledigte Implementierung ausgeben.

## Abschlussnachlauf nach F1/F2

```text
node tests/run_all.js test_trading_pending_fairness.js test_trading_prepared_exit_recovery.js test_trading_recovery_worker.js test_trading_preparation_recovery.js test_trading_protected_entry_crash.js test_trading_entry_expiry.js test_trading_control_races.js test_trading_entry_safety.js test_trading_lifecycle_safety.js test_trading_global_release.js test_startup_trading.js test_test_registry.js
ALL 12 TEST FILES PASSED
```

Zusätzlich beide oben genannten isolierten Probes grün; Backend-Typecheck grün; fokussiertes ESLint mit `--max-warnings 0` grün; Architektur 150 Module/648 interne Imports/0 Zyklen; gesamter Complexity-Gate 0 Warnungen/0 Budgetverletzungen, maximale zyklomatische Komplexität unverändert 15; `git diff --check` grün. Sechs permanente Fairness-Szenariogruppen, nicht unqualifiziert „sieben Tests“. Root führt die getrennte Gesamt-/Coverageabnahme durch. In dem ausdrücklich geprüften lokalen Pflichtenbereich bleibt nach F1/F2, dem TTL-Klassifikationsfix und dem folgenden AUX-01-Testnachtrag keine weitere konkret reproduzierte Produktionslücke offen; externe Beweisgrenzen bleiben unverändert.

## AUX-01: kombinierter terminaler Credential-Positivfall nachgetragen

Enger anschließender Root-Auftrag, umgesetzt ausschließlich in der bereits registrierten `tests/test_trading_web_control.js`; keine neue Datei, kein Runner-Hunk und keine Produktionsänderung. Der aktuelle Produktionspfad bestand den neuen Test direkt. Seine Testwirkung wurde zusätzlich mit einer nur im Node-Modullader vorgenommenen Rückmutation geprüft, nicht durch Änderung einer Quelldatei.

Positiver Fall `terminalHistoryAllowsCredentialRotation`:

- Zwei echte Engine-Reconciliations über ein ausdrücklich synthetisches, vollständig gescoptes lokales Adapterprofil etablieren durch den vorhandenen Baseline-Consumer eine flache Kontogrenze. Die zweite Beobachtung beginnt nach Abschluss der ersten; keine manuell als fertig gesetzte Baseline.
- Drei ursprüngliche Orders (`filled`, `cancelled`, `rejected`) liegen zeitlich vor dieser Grenze und tragen konkrete Provider-IDs, Markt und Mengen. Der echte Reconcile-/Baseline-Consumer klassifiziert sie ausdrücklich als externe Altgeschichte. Sie sind keine behaupteten eigenen Fills und werden nicht gelöscht oder als unbekannte Nullbilanz ignoriert.
- Die vollständige Wartungskette verifiziert die alte Kontoidentität, führt den echten Entry-Drain und Reconcile aus und erhält auch im abschließenden Adapterabruf ausschließlich diese terminalen Orders. Danach wird der Kandidat mit gleicher Kontoidentität und tatsächlich anderer Credentialgeneration verifiziert und in der temporären Credential-Datei übernommen.
- Original-Evidenz-IDs, Identitätsschlüssel, Hashes, Payloads, ursprüngliche Beobachtungszeit und Baselineklassifikation bleiben gleich. Konto bleibt deaktiviert, globale Sperre bleibt aktiv und Execution bleibt aus; gültige FKs.

Negativer Fall `openOrderPreventsCredentialPromotion`:

- Nach dem tatsächlichen Reconcile, aber vor dem finalen Wartungsabruf erscheint eine neue konkrete offene Order im lokalen Adapter. Der abschließende Abruf enthält diese offene Verpflichtung zusätzlich zur unveränderten terminalen Historie.
- Der exakte Wartungsfehler `Credentials cannot be replaced while the exchange account has open orders or positions` wird erwartet. Nur die alten Credentials werden verifiziert; kein Kandidat wird verifiziert oder übernommen. Die Credential-Datei bleibt bytegleich, es verbleibt keine Kandidatendatei, Generation bleibt unverändert, Entries bleiben gesperrt.
- Der Test ersetzt weder Drain noch Reconcile durch einen leeren Erfolg. Der Wrapper lässt den tatsächlichen Reconcile vollständig laufen und modelliert nur das anschließende neue Remote-Ereignis vor dem unabhängigen letzten Read.

Tatsächliche Ergebnisse:

```text
node tests/run_all.js test_trading_web_control.js test_trading_safety_proof.js test_trading_account_baseline.js test_trading_global_release.js test_trading_control_races.js test_trading_account_retirement.js
ALL 6 TEST FILES PASSED

node node_modules/eslint/bin/eslint.js tests/test_trading_web_control.js --max-warnings 0
exit 0
git diff --check
exit 0
```

Zusätzliche gezielte Test-Sensitivität: `node --import tsx --input-type=module` registrierte einen rein flüchtigen `node:module.registerHooks`-Loadhook. Genau ein Vorkommen von `activeOrders.length > 0` in `trading_web_control.ts` wurde ausschließlich im geladenen Modul durch das historische `oldState.orders.length > 0` ersetzt. Danach wurde die echte komplette `test_trading_web_control.js` importiert. Erwartetes tatsächliches Resultat: `EXPECTED MUTATION KILLED: original orders.length guard wrongly rejects classified terminal history.`, Exit 1 mit exakt dem genannten Credential-Guardfehler. Keine Datei wurde für diese Rückmutation geändert; der unveränderte Produktionspfad ist grün. Damit ist der zuvor nur als kombinierter Test fehlende AUX-01-Nachweis lokal geschlossen, ohne eine neue Provider-/Livefreigabe zu behaupten.
