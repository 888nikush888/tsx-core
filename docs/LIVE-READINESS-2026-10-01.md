# TSX Core: Live-Readiness bis 01.10.2026

Stand: 24.09.2026, 11:45 UTC. Owner: Betreiber `888nikush888`; technische Umsetzung: Codex. **Zieltermin ist der 01.10.2026, nicht eine Freigabe.** Der Betreiber hat die verpflichtende 30-Tage-Wartezeit aufgehoben. Jeder unten genannte Sicherheits-, Provider- und Betriebsnachweis bleibt ein eigenes GO-Gate. Fehlende Evidenz bedeutet NO-GO für den betroffenen Handels-Scope, auch am Zieltag. Es gibt keine automatische Live-Freischaltung und keine fingierten Testnet- oder Börsennachweise.

## Fortschritt auf einen Blick

| Bereich | Momentaufnahme | Nächster messbarer Zustand |
| --- | --- | --- |
| Code-/CI-Stabilisierung | ca. 70 % Planungswert; PR #79 auf `36c34d0` hat 13/14 GitHub-Pflichtchecks grün, Container-/SBOM-Job stoppt am veralteten Implementierungs-Receipt. Sonar-Gate grün mit fünf neuen Code-Smells. | Integrierter finaler SHA mit 14/14 Pflichtchecks, vollständigem Image-/SBOM-/Vulnerability-Lauf und unabhängiger Receipt-Freigabe. |
| Scanner | `main` `58c01bc7`: DeepSource 121 aktive Befunde ohne die ausdrücklich ausgenommene JS-R1005-Regel. PR #79 löst 54, PR #80 weitere drei gegenüber #79; erst ein neuer `main`-Scan beweist Restzahlen. Sonar-Baseline 79 offene Befunde; S6845 wurde am 24.09. individuell und begründet als False Positive markiert. Codacy PR #79: zwei TLS-Dateipfadmeldungen; ESLint-Providerfehler und fehlende Coverage-Berichte. | Vollständige exakte Analysen des finalen Stands; jede verbleibende ID einzeln behoben oder nach erneuter Quellprüfung begründet dispositioniert, ohne Analyzer-/Gate-Abschaltung. |
| Staging | WSL Ubuntu 26.04 mit `systemd`, Docker Engine 29.8.1 und Compose 5.5.1 installiert; TLS-Bundle, Compose-Smoke, echte Konten und externe Dienste noch offen. | Fünf TLS-Wege mit gültiger CA/ACL/Health, isolierte Paper-/Testnet-Konten, E2E, Restore, Alarm und Rollback auf genau dem Release-SHA. |
| Live-Host | Noch nicht ausgewählt; der Betreiber entscheidet später. WSL ist zunächst Staging auf diesem PC. | Vor Live-Release ausgewählter, erreichbarer und unabhängig geprüfter Zielhost mit gleicher Digest-/Konfigurationsbindung. |
| Börsen | Pinned CCXT-Inventur 103 IDs, davon etwa 60 mit deklariertem Derivate-Signal. Ein enges Hyperliquid-Offline-Implementierungsprofil ist vorhanden, dessen Receipt nach Source-Änderungen veraltet ist. **0 Provider-/Kontoslices abgenommen.** | Für jede tatsächlich freigegebene Futures-Börse gesonderte Produkt-, Konto-, Modus-, Testnet-, Implementierungs- und Providerakte; keine pauschale Freigabe aus SDK-Flags. |
| UI-Abdeckung | Read-only Börsenkatalog in Draft-PR #81; bestehende maschinelle Parameter-Matrix weist 52/311 Verträge nach und ist selbst noch keine vollständige UI-Inventur. | Jeder betriebliche Parameter hat eine sichere UI-Bedienung, Validierung, Persistenz, Rechte-, Audit-, Secret- und Reload-Prüfung. Feste Sicherheits- und CI-Gates bleiben codegebunden. |

Die Prozentwerte sind **Schätzungen zur Planung**, keine GO-Metrik. Ab jetzt zählt für den Live-Entscheid ausschließlich die unten genannte prüfbare Evidenz auf demselben Release-Commit und Host.

**Gate-Zähler:** 0/23 Pflichtgates sind bereits für einen finalen Release-SHA und den tatsächlichen Live-Host als `ERLEDIGT` nachgewiesen; zehn sind `IN ARBEIT`, dreizehn `BLOCKIERT`. Das ergibt derzeit 0 % *formale Live-Freigabe*, obwohl erhebliche Codearbeit abgeschlossen ist. Bei jedem Tagesbericht werden dieser Zähler, die exakten Scannerzahlen und die Links zum geprüften Commit aktualisiert. Teilprüfungen erhöhen den Gate-Zähler erst nach vollständigem Nachweis.

## Pflichtgates und Verantwortliche

Status: `ERLEDIGT` bedeutet Evidenz für den vorgesehenen finalen SHA/Host liegt vor; `IN ARBEIT` bedeutet noch nicht freigegeben; `BLOCKIERT` benötigt eine externe Entscheidung oder Infrastruktur. Teilresultate zählen nicht als bestanden.

| ID | Pflichtgate / Done-Kriterium | Status 24.09. | Verantwortlich / Evidenz |
| --- | --- | --- | --- |
| C1 | PRs #73–#81 und nachfolgende geprüfte Fixes konfliktfrei in **einen** Main-Kandidaten; keine verlorenen Branch-Fixes. | IN ARBEIT | Codex; Git-Diff, PR-Links, exakter SHA. |
| C2 | Auf dem finalen SHA alle 14 verpflichtenden GitHub-Checks grün, inklusive Browser, Mutation, CodeQL, Secret-History, Dependency, Sonar und Container/SBOM/Trivy. | IN ARBEIT | Codex; Quality-OS-Lauf und Artefakte. |
| C3 | Hyperliquid-Implementierungs-Receipt nach eingefrorenem Sourcebaum und SDK 4.5.75 mit tatsächlichen Test-/Fixture-/Ausführungsbelegen erneuert, unabhängig begutachtet und separat gepinnt; `providerAcceptanceVerified=false` bleibt bis zur echten Providerakte. | BLOCKIERT | Codex + unabhängiger Reviewer; Root- und Runtime-Gate. |
| C4 | CCXT-Inventarbindung nach der read-only Katalogänderung bytegenau und unabhängig erneuert; alle 103 Entscheidungen, SDK-Methoden und Ausschlüsse unverfälscht. | IN ARBEIT | Codex; Matrix-Diff, Hashes, 556er Python-Suite. |
| C5 | Sonar: fünf neue PR-#79-Code-Smells beseitigt und erneut gescannt; Bestandsbefunde nach Main-Analyse einzeln geprüft. | IN ARBEIT | Codex; exakter Sonar-Report. |
| C6 | DeepSource: JS-R1005 allein bleibt ausgenommen; alle anderen aktiven IDs nach Integration erneut paginiert und einzeln behoben oder mit aktueller Quellbindung fachlich entschieden. | IN ARBEIT | Codex; vollständiger Main-Export und Reviewledger. |
| C7 | Codacy: zwei TLS-Dateizugriffe am echten Host durch ACL-/Mount-/Preflight-Evidenz geprüft; Provider-ESLint-Absturz und Coverage-Lücke behoben oder offen als NO-GO ausgewiesen. | BLOCKIERT | Codex, Codacy-Provider, Betreiber für Host-/Projekt-Token; exakte Neuanalyse. |
| C8 | `uri-js`-Ersatz, Snyk-Entfernung und fünf interne HTTPS-Wege im finalen Build und mit Negativtests bestätigt. | IN ARBEIT | Codex; Lockfile-, TLS-, Supply-Chain- und Compose-Nachweise. |
| H1 | WSL-Staging mit externem `INTERNAL_TLS_DIR`, CA, fünf SAN-korrekten Leaf-Paaren und UID-65532-Dateirechten; Preflight und Compose-Konfigurationscheck grün. | IN ARBEIT | Codex; `scripts/check_internal_tls.py`, `docker compose config`. |
| H2 | Exakter Kandidat in WSL-Staging installiert; alle fünf HTTPS-Healthchecks, Dashboard, Viewer, Executor, Prometheus und Alarmweiterleitung grün; ungültige Zertifikate scheitern geschlossen. | BLOCKIERT | Codex; reale Smoke- und Negativtestartefakte. |
| H3 | Separater **Live-Host** ausgewählt und vor dem 01.10. mit Docker, TLS, Zugriff, Ressourcen, Strom-/Uptime-Plan und Image-Digests geprüft. WSL-Staging allein ersetzt dies nicht. | BLOCKIERT | Betreiber wählt/provisioniert; Codex prüft. |
| H4 | Externer unveränderlicher Audit-Empfänger, verschlüsselter Off-host-Backup-Store mit getrenntem Schlüssel, Rücklesen/Restore und gemessenem Rollback installiert und getestet. | BLOCKIERT | Betreiber stellt Ziele/Zugänge als lokale Secrets bereit; Codex prüft. |
| H5 | Prometheus/Alertmanager, Incident-Empfänger, benannter On-Call und Alarmzustellung mit gleicher `correlation_id` nachgewiesen. | BLOCKIERT | Betreiber benennt Empfänger/On-Call; Codex führt Test aus. |
| H6 | Echter Telegram-Staging-E2E und Live-AI-Golden-Set für denselben Release-SHA, begrenzte Budgets und genau eine bestätigte Zielzustellung. | BLOCKIERT | Betreiber stellt isolierte Telegram-/AI-Zugänge bereit; Codex prüft. |
| T1 | Pro Futures-Börse: tatsächliche CCXT-/Produkt-/Settle-/Margin-/Position-Mode-Fähigkeit, Testnet-Origin, native IDs, History und Fehlermodi belegt. Nicht belegte IDs bleiben unfreigegeben. | BLOCKIERT | Codex + Betreiberkonto; je Exchange separater Scope-Record. |
| T2 | Pro Konto: dediziertes Subkonto, minimale Trading-Rechte **ohne Withdrawal**, IP-Allowlist, Rotation, Limits, vollständige Credential-/Account-Identität. | BLOCKIERT | Betreiber richtet Konten ein; Codex prüft ohne Secret-Ausgabe. |
| T3 | Reale isolierte Testnet-Lifecycle-Matrix: Entry, Stops, 1/2/3/5-TP, Partial-/Late-Fill, Cancel, Timeout/Unknown, Neustart-Reconciliation, Notfall-Flatten, Positions- und Geldparität; keine ungeschützte Position. | BLOCKIERT | Codex + Betreiber-Testnetkonto; redigierte Originalantworten und Cleanup. |
| T4 | Risiko- und Kill-Switch-Gates einschließlich Max-Notional, Tagesbudget, reduce-only, Order-/Positionsdrift, Panic-Recovery und UI-Berechtigungen bestanden. | IN ARBEIT | Codex; Tests plus Staging-Übung. |
| T5 | Vor jedem erweiterten Live-Scope zunächst begrenzter, vom Betreiber ausgelöster Canary mit echter Börsenquittung, Stop, Reconciliation und Cleanup; ein Fehler sperrt weitere Entries. | BLOCKIERT | Betreiber löst finanzielle Transaktion aus; Codex verifiziert. |
| U1 | Vollständiges Inventar aller betrieblichen Einstellungen: Börsen/Konten/Secrets, Strategie/Workflow, Risiko, AI, Telegram, TLS-Zertifikatsstatus/-Rotation, Monitoring/Alarm, Backup/Retention, Infrastruktur. | IN ARBEIT | Codex; Feld-zu-UI-Matrix ohne blinde 52/311-Annahme. |
| U2 | Jede betriebliche Einstellung in der UI veränderbar oder ein bewusstes sicheres Bootstrap-Feld mit UI-Lifecycle; Validierung, Rollen, write-only Secrets, Audit, Persistenz, Reload, Import/Export und Negativtests. | BLOCKIERT | Codex; UI-E2E + Backend-Vertragstests. Sicherheitsinvarianten nicht abschaltbar. |
| R1 | 30-Tage-Wartebedingung aus GO-Logik entfernt, ohne Monitoring-, Provider-, Restore-, Unknown-/Stop- oder Review-Gates zu lockern; neue Entscheidungsvorlage getestet. | IN ARBEIT | Codex; Diff und Gate-Tests. |
| R2 | Release-Commit, Digest, CI-/Scanner-/Staging-/Provider-/Backup-/Alarm-/UI-Evidenz in einer Akte; unabhängiger Review und ausdrücklicher GO/NO-GO für **jeden** zugelassenen Scope. | BLOCKIERT | Betreiber + Codex; signierter/gebundener Release-Record. |

## Täglicher Pfad bis zum Zieltermin

| Datum | Ergebnis, das am Tagesende überprüfbar sein muss |
| --- | --- |
| 24.–25.09. | Alle isolierten Fixes in einem Kandidaten, Inventarbindung korrekt, WSL-Docker/TLS-Preflight/Compose-Konfiguration grün; neue Sonar-/DeepSource-/Codacy-Deltas gesichtet. |
| 26.09. | Source-Freeze, unabhängiger Implementierungsreview/Receipt, exakter vollständiger CI-/Image-/SBOM-/Vulnerability-Lauf. Keine neuen Quelländerungen ohne erneute Bindung. |
| 27.–28.09. | WSL-Staging-E2E, fünf TLS-Wege, Telegram/AI, Testnet-Lifecycle, Restore/Rollback, Audit/Monitoring/Alarm und UI-Abdeckung gegen echte Dienste. |
| 28.09. | Späteste Wahl eines Live-Hosts und Bereitstellung isolierter Testnet-/Live-Konten, Off-host-Ziele und Alarmempfänger durch den Betreiber. Ohne diese Inputs bleibt 01.10. ein NO-GO-Termin. |
| 29.–30.09. | Finalen SHA/Digest auf Live-Host prüfen, alle offenen Providerfälle schließen, unabhängige Release-Akte und GO/NO-GO-Entscheid je Exchange-/Produkt-/Konto-Scope. |
| 01.10. | Nur bei vollständigen Pflichtbelegen: Betreiber startet kontrollierten Live-Canary; nach bestätigter Order-/Stop-/Cleanup-Parität sukzessive die einzeln freigegebenen Scopes. Andere CCXT-IDs bleiben gesperrt. |

Ein am 01.10. fehlender Host, fehlender Providerbeleg, nicht grüner Pflichtcheck, ungeklärter Scannerabbruch, fehlender Restore, ungeschützte Position oder ungeklärte Order bedeutet **NO-GO**. Der Termin rechtfertigt keine Umgehung dieser Grenzen. Nach einem späteren VPS-Umzug müssen TLS-, Mount-, Restore-, Monitoring- und Provider-/Kontonachweise auf dem tatsächlichen VPS erneut erbracht werden.
