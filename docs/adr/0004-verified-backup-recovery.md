# ADR 0004: Verifiziertes Backup und Offline-Restore

- Status: Accepted
- Datum: 2026-07-13

## Kontext

SQLite, Outbox und Konfiguration sind für Recovery erforderlich. Eine bloße Dateikopie während Schreibaktivität oder ein Backup auf derselben Platte beweist keine Wiederherstellbarkeit.

## Entscheidung

Der Dienst plant beim Start und im konfigurierten Intervall von höchstens 15 Minuten einen SQLite-Online-Snapshot. Eine gepinnte, committed Konfigurationsgeneration bindet bereinigte Config, Runtime-Einstellungen und Templates an denselben Snapshotvorgang. Hashes, Größen, `integrity_check`, Fremdschlüssel, Pflicht-Tabellen und Secret-Ausschluss werden vor atomarer Veröffentlichung geprüft. Das unveränderliche Manifest bleibt auf 64 KiB begrenzt; das kompakte Generation-Unterformat v2 bindet die Konfigurationsdateien per Digest, ohne die Dateiliste zu duplizieren. Das bisherige Generation-Unterformat v1 bleibt prüfbar; ein Artefakt ohne Generation erhält keinen Kohärenznachweis.

Die Nachweise sind ausdrücklich getrennt:

| Nachweis | Belegte Aussage | Nicht daraus ableitbar |
| --- | --- | --- |
| `integrityVerified` | Struktur, Dateihashes und SQLite geprüft | Restore-Zulässigkeit |
| `configurationCoherent` | Gemeinsame committed Konfigurationsgeneration geprüft | Heutiger Börsen-/Tradingzustand |
| `offsiteVerified` | Hochgeladenes Objekt zurückgelesen, entschlüsselt und geprüft | Durchgeführter Restore |
| `restoreEligibility` | `eligible`, `blocked` oder `unknown` samt Gründen für `artifact-local-integrated-restore` | Aktuelle Börsenflatheit oder Zielautorisierung |
| `restoreDrill` | Echter isolierter Datei-Restore mit Datum und Artefakt-SHA abgeschlossen | Produktions-Recovery oder spätere Tradingfreigabe |

Artefakt-SHA ist SHA-256 der unveränderten Manifestbytes, deren Dateimap alle enthaltenen Nutzbytes bindet. Jeder spätere Proof enthält zusätzlich `artifactCreatedAt`: eine heute wiederholte Prüfung verjüngt nicht den gesicherten Datenstand. Spätere Offsite- und Drillbelege ändern dieses Manifest nicht. Der Offsite-SHA stammt aus dem tatsächlich heruntergeladenen und entschlüsselten Manifest. Ein frisches `verify` prüft lokal erneut und erfindet weder einen früheren Offsite- noch einen Drillbeleg. Schedulerstatus hält die letzten tatsächlich erbrachten Nachweise mit jeweils eigener Zeit/SHA getrennt; er ist wie bisher prozesslokal. CLI-Ausgaben sind für die operative Nachweisablage zu archivieren, nicht als neue vertrauenswürdige Evidenzdatenbank zu verstehen.

Zulässigkeitsbericht und echter Stage-Restore verwenden denselben Prüfer. Nichtterminale Intents (einschließlich pending/planned), nichtgeschlossene oder mengenmäßig widersprüchliche Positionen (einschließlich opening/0), nichtterminale Orders (einschließlich created), nicht aufgelöste Operationen und ungeklärte/konfliktäre Remote-Evidenz blockieren. Fehlende/ungültige Quellen bleiben unknown. Ein intaktes, offsite bestätigtes Backup kann deshalb für den integrierten Restore blockiert sein. Stage akzeptiert ausschließlich manifestierte Mitglieder und prüft ihre Hashes vor der absichtlichen Runtime-Sicherheitsänderung.

Restore benötigt zusätzlich echte Prozess-Ownership, die nonce-/generationgebundene Ziel-Wartungsfreigabe und tatsächliche Quiescence. Role, ausgeschriebene Bestätigung und heutige Safety-/Recovery-Prüfung bleiben bestehen. Der bisherige Zustand wird für Rollback erhalten; Runtime bleibt execution/live aus und Kill-Switch an. Ein aktueller, SHA-gleicher Integritäts-/Kohärenz-/eligible-Nachweis ist zusätzliche Voraussetzung für die bestehenden destruktiven Dashboardaktionen.

`node dist/backup_cli.js drill <artifact>` startet ausschließlich auf ausdrücklichen Auftrag einen kurzlebigen Child-Prozess, ein eigenes lokales `mkdtemp` und die echten Restore-/Lease-/Reenrollmentpfade. Die Umgebung enthält keine Credentials/Secretstores; Netzwerk- und Subprozess-APIs werden vor Appimports gesperrt und selbstgeprüft. Keine Runtime, kein Provider und kein Forwarder wird gestartet, Artefaktinhalt wird nicht als Code ausgeführt, UNC-Ziele werden verweigert. Das ist begrenzte Code-/Testisolation, **keine OS-Sandbox**. Temporäre Ergebnisse werden nach Prüfung entfernt; erst erfolgreicher Child-Abschluss ergibt einen datierten SHA-Beleg. Scheduling und Offsite-Replikation führen niemals automatisch einen Drill aus.

## Konsequenzen

15 Minuten sind ein **Planungsziel für neue lokale Snapshots**, keine garantierte Trading-RPO. Tatsächlich belegter Scope und Alter sind für Integrität, Konfigurationskohärenz, Offsite, letzte artifact-local-eligible Prüfung und echten Drill separat zu betrachten. Die bestehende Health-Toleranz von zwei Intervallen kann größer als 15 Minuten sein; `healthy` ist keine Restore-Freigabe. Sind nur ältere Snapshots eligible oder verfügbar, ist daraus kein 15-Minuten-RPO für wiederherstellbaren Tradingzustand ableitbar. Ziel-RTO 60 Minuten bleibt ein operatives Ziel, das nur eine gemessene geeignete Recovery belegen kann.

Verwaltete Secrets, Exchange-Keys und TDLib-Sitzungsdaten bleiben absichtlich ausgeschlossen und müssen getrennt bereitgestellt werden. Off-host-Replikation, monatlicher isolierter Restore und TDLib-Reauthentifizierung bleiben operative Pflichten; lokale Artefakte allein sind kein Disaster Recovery. Vor jeder späteren Handelsfreigabe ist die aktuelle Recovery-/Account-Evidenz erneut erforderlich.

Ergänzung 26.07.2026: SQLite-Backups umfassen nun auch dynamische Verträge, Kanalrisiko/-telemetrie und MCP-Agentenzustand einschließlich Token-Hashes, jedoch nie Klartext-Agententokens. Restore koordiniert den unabhängigen MCP-Prozess über `.mcp-maintenance`; anschließend sind Agenten-Tokens zu rotieren.
