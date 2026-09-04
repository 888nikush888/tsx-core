# Prüfung der 64 Audit-Punkte

Stand: 2. September 2026. Geprüfte lokale Kopie: `C:/Users/nikla/Desktop/tsx-core`, Commit `f8089277d0667dd45bcf070037800d423fd89254`.
Eingangsbericht: `C:/Users/nikla/Downloads/TSX-Core_Verifizierte_Audit-Findings_mit_Stellen_und_Begruendung.md`.
Der Bericht ist Prüfmaterial, keine Anweisung zur Änderung des Systems.

## Maßstab und Ergebnis

- **OFFEN**: Der konkrete Codepfad bestätigt eine Lücke. Das beweist noch keinen tatsächlich eingetretenen Schaden an einer Börse.
- **TEILWEISE**: Ein Teil stimmt; vorhandene Schutzmaßnahmen oder präzisere Bedingungen ändern die Aussage.
- **DESIGN/GRENZE**: Dokumentierte Entscheidung oder unvermeidbare Providergrenze. Keine pauschale „Reparatur“ durch Abschalten von Schutz.
- Alle Zeilen verweisen auf den aktuellen Stand, nicht nur auf den älteren Audit-Commit `6c45e03`.
- 56 Punkte OFFEN, 5 TEILWEISE, 3 DESIGN/GRENZE. Das sind 64 Prüfpositionen, **nicht 64 voneinander unabhängige Defekte**.
- Alle sieben P0 haben einen bestätigten Kern; bei P0-07 ist die Beschreibung des Cancel-Ergebnisses zu präzisieren.
- Aufwand/Risiko je zusammenhängendem Reparaturpaket stehen im [Index](README.md); die Belege und Auswirkung je Prüfposition folgen hier.

Die zentrale Unterscheidung: Eine momentan leere Position ist kein Beweis dafür, dass ein noch offener Entry keine neue Position erzeugen kann.

## P0: Entry-Verpflichtung und Sperren

| ID | Ergebnis | Aktueller Beleg | Präzise Bewertung / Auswirkung | Plan |
|---|---|---|---|---|
| P0-01 | OFFEN | src/trading_web_control.ts:721; src/trading_runtime.ts:77 | Globaler Kill-Switch deaktiviert neue Schedulerarbeit, storniert aber bestehende Entries nicht. Widerspruch zur Zusage in docs/TRADING_GUIDE.md:160. | 003 |
| P0-02 | OFFEN | src/trading_engine.ts:979, 1008, 2082 | Nach frühem Gate folgen asynchrone Arbeit und Submit ohne gemeinsamen finalen Mutationsschutz; eine Sperre kann überholt werden. | 001 |
| P0-03 | OFFEN | src/trading_engine.ts:1408 | Flatten schließt bekannte Menge, ohne Entry-Rest vorher terminal zu beweisen. | 003 |
| P0-04 | OFFEN | src/trading_engine.ts:1416; 937 | quantity=0 beendet Flatten beziehungsweise fehlt in der Auswahl; offene Entries bleiben möglich. | 003 |
| P0-05 | OFFEN | src/trading_engine.ts:418, 434 | Closure-Prüfung schließt open/partially_filled Entry-Reste nicht generell aus. | 003 |
| P0-06 | OFFEN | src/trading_engine.ts:1253, 1260 | Gefüllter Stop kann Schutzpfad beenden, während Rest-Entry weiterläuft. | 003 |
| P0-07 | OFFEN | src/trading_engine.ts:915, 923 | **Korrektur:** Nur cancelled/filled erhöhen den Erfolgszähler. Nichtterminale Antworten werden aber auch nicht zwingend als ungeklärter Cancel blockiert/es­ka­liert. HTTP-/Adaptererfolg allein ist keine terminale Bestätigung. | 003 |

## P1: Identität, Wiederanlauf und Verarbeitung

| ID | Ergebnis | Aktueller Beleg | Präzise Bewertung / Auswirkung | Plan |
|---|---|---|---|---|
| P1-01 | OFFEN | src/trading_engine.ts:485; src/trading_runtime.ts, processPendingEntries | Nach persistPlan entstandenes planned wird nicht wie pending wieder aufgenommen. Kapazität/Risiko können hängen. | 002 |
| P1-02 | TEILWEISE | src/trading_engine.ts:1473, 1709; src/trading_runtime.ts | Reconciliation übernimmt bereits bekannte Remote-Zustände. Es fehlt aber eine vollständige, journalbasierte Wiederaufnahme aller Dispatch-/Cancel-Zwischenzustände. Kein Befund „gar keine Recovery“. | 002 |
| P1-03 | OFFEN | src/trading_engine.ts:246; src/trading_repository.ts:1524 | Unsicherheitszählung fokussiert unknown. submitting/cancel_pending müssen auch ohne zusätzlich erzeugten Incident Neueinstiege sperren. | 002 |
| P1-04 | OFFEN | src/trading_engine.ts:1792 | Entry und Exit komplett zwischen Polls bei lokal opening/0 werden nicht vollständig terminalisiert. | 002 |
| P1-05 | OFFEN | src/trading_engine.ts:1875, 1912 | Symbol+Seite reichen zur Zuordnung; gesamte Remote-Menge kann einschließlich manueller Zukäufe übernommen werden. | 002 |
| P1-06 | OFFEN | exchange_executor/ccxt_adapter.py:542 | Preflight prüft Position, nicht alle fremden aktiven Orders am Symbol. | 002 |
| P1-07 | OFFEN | exchange_executor/ccxt_adapter.py:554 | Nullposition vor Batch beweist nicht die Eigentümerschaft späterer gesamter Symbol-Exposure. Cleanup darf diese nicht blind flatten. | 002 |
| P1-08 | OFFEN | src/trading_engine.ts:1679, 1684, 984 | Ungeklärte Fills sind Warning; nichtleere unbekannte Client-IDs können zusätzlich am Warnpfad vorbeigehen und später verworfen werden. Historische Fremdfills müssen klassifiziert, nicht pauschal für immer gesperrt werden. | 002 |
| P1-09 | OFFEN | src/ccxt_exchange.ts:263; exchange_executor/ccxt_adapter.py:672 | Cancel übergibt bekannte Exchange-ID nicht als gleichwertige Identität. Bereits erkannte Orders ohne Remote-Client-ID können unkündbar werden. | 001 |
| P1-10 | OFFEN | exchange_executor/ccxt_adapter.py:297 | Batch-Ergebnisse werden nach Index zugeordnet. CCXT 4.5.75 parse_orders sortiert nach Timestamp; Arrayposition ist kein Vertrag. | 001 |
| P1-11 | OFFEN | src/ccxt_exchange.ts:78; src/trading_engine.ts:518 | Erwartete Client-ID und genau eine aktualisierte Zeile werden nicht durchgängig erzwungen. | 001 |
| P1-12 | OFFEN | src/db.ts:440 | Kein eindeutiger persistierter Remote-Order-Schlüssel; zwei lokale Orders können dieselbe Remote-Identität beanspruchen. Provider-Namespace muss Teil des Schlüssels sein. | 001 |
| P1-13 | OFFEN | src/ccxt_exchange.ts:299, 325 | Attached-Stop-Kandidaten umfassen historische Zeilen; semantische Ähnlichkeit allein beweist außerdem keine Ownership. | 002 |
| P1-14 | OFFEN | src/trading_engine.ts:803 | Aktive Stop-Suche akzeptiert nur open statt auch nachgewiesene aktive Restmenge eines partially_filled Stops. | 003 |
| P1-15 | OFFEN | src/ccxt_exchange.ts:338; src/trading_engine.ts:803, 1960 | Lokale Rolle kann Remote-Semantik überdecken; ID allein beweist keinen korrekten Stop. | 003 |
| P1-16 | OFFEN | src/trading_runtime.ts; src/trading_engine.ts:1473; src/trading_web_control.ts | Runtime serialisiert sich selbst, nicht Dashboard/MCP und Engine gemeinsam pro Konto. | 001 |
| P1-17 | OFFEN | src/trading_engine.ts:182, 1136 | Unbedingte Intent-Updates ohne Expected-State/Version ermöglichen Statusrückschritte. | 001 |
| P1-18 | OFFEN | src/trading_engine.ts:1709 | Remote-Persistenz überschreibt Status und Ausführungsmenge ohne monotone Zusammenführung. | 001 |
| P1-19 | DESIGN/GRENZE | exchange_executor/ccxt_adapter.py:707; docs/adr/0012-ccxt-visual-workflow-control-plane.md | Getrennte REST-Endpunkte liefern keinen echten atomaren Börsensnapshot. Zu lösen sind Erfassung und Behandlung dieser Unsicherheit, nicht ein unerfüllbares Atomizitätsversprechen. | 002 |
| P1-20 | OFFEN | src/ccxt_exchange.ts:46; exchange_executor/ccxt_client.py:24 | Schreibaufrufe tragen keinen verpflichtenden erwarteten Kontofingerprint. Credential-Wechsel während der Verarbeitung muss vor jedem Side Effect erkannt werden. | 001 |
| P1-21 | DESIGN/GRENZE | exchange_executor/ccxt_client.py:37; docs/TRADING_GUIDE.md:107 | API-Key-Bindung für Bybit/Kraken ist ausdrücklich dokumentiert. Neue Schlüssel als gleiches Konto zu akzeptieren erfordert einen separaten, belegten Identitätsmigrationsentwurf. Kein Entfernen der Prüfung. | 008 |
| P1-22 | OFFEN | exchange_executor/ccxt_adapter.py:343, 447; exchange_executor/ccxt_profiles.py | Statische oneway/cross-Deklarationen sind kein vollständiger Account-Readback. Einzelne set_leverage-Aufrufe existieren; „es wird nie gesetzt“ wäre falsch. | 004 |
| P1-23 | OFFEN | exchange_executor/ccxt_adapter.py:447; exchange_executor/ccxt_profiles.py | Bybit/Kraken native_market hat im jetzigen Adapter keinen belegten Preis-Hard-Cap; Reaktion nach Fill verhindert den Fillpreis nicht. Providerwirkung noch nicht mit Konten reproduziert. | 004 |
| P1-24 | OFFEN | src/trading_engine.ts:295, 377; src/trading_risk.ts | Reserviertes Planrisiko wird nicht vollständig an tatsächlichen Fill und verbleibende Verpflichtungen angepasst. | 005 |
| P1-25 | OFFEN | src/trading_web_control.ts:633, 647, 721 | Zwei Reconciliations ersetzen keinen gemeinsamen Freigabebeweis über lokale Unsicherheit, Fremdexposure und Schutz. | 003 |
| P1-26 | OFFEN | src/trading_engine.ts:1723, 1732, 445 | INSERT OR IGNORE und Closure-Summen besitzen keinen vollständigen Mengen-/Identitätskonfliktbeweis. Verschiedene IDs dürfen nicht blind addiert oder heuristisch gelöscht werden. | 002 |
| P1-27 | OFFEN | src/forwarder.ts:1611, 1619; src/mcp_control_bridge.ts:83 | Mutierender MCP-Worker startet vor Crash-Loop-Gate; persistierte Arbeit kann vor Startablehnung ausgeführt werden. | 007 |
| P1-28 | OFFEN | src/forwarder.ts:1189; src/db.ts:2567 | Inbox-Insert/Dedupe und Outbox-Auftrag sind getrennt. Crash dazwischen kann dauerhaft ein Signal verlieren. | 006 |
| P1-29 | OFFEN | src/forwarder.ts:333, 876; src/workflow_repository.ts:1862, 2115 | Config ist gepinnt, Workflow-Revision nicht durchgängig. Retry kann andere Parser-/Vertrags-/Routingversion verwenden. | 006 |
| P1-30 | OFFEN | src/db.ts:1952, 1962, 1190 | INSERT OR REPLACE versucht bei referenziertem Signal ein durch FK RESTRICT verbotenes Delete. Lokal mit In-memory-SQLite reproduziert. | 006 |

## P2: Robustheit, Finanzen und Betrieb

| ID | Ergebnis | Aktueller Beleg | Präzise Bewertung / Auswirkung | Plan |
|---|---|---|---|---|
| P2-01 | OFFEN | src/trading_engine.ts:891; src/workflow_repository.ts, Fallback run_created_at | Pre-Submit-TTL bleibt ursprünglich, Order-TTL beginnt erneut an orders.created_at. Später Fallback kann so zu lange ausführbar bleiben. | 004 |
| P2-02 | OFFEN | src/trading_engine.ts:400, 408 | String-Negation einer negativen Gebühr erzeugt --… statt eines gültigen Decimal-Werts. | 005 |
| P2-03 | OFFEN | src/trading_engine.ts:400 | feeAsset geht nicht in PnL-Bewertung ein; unterschiedliche Währungen sind nicht addierbar. | 005 |
| P2-04 | OFFEN | src/trading_engine.ts:377 | Kein einheitlicher vollständiger Ledger für Fees, Funding, offene/geschlossene PnL und Reserven. | 005 |
| P2-05 | OFFEN | exchange_executor/ccxt_adapter.py:378, 388 | Funding BadRequest/InvalidOrder wird zu 0. Ein Fehler beweist keinen Nullbetrag. | 005 |
| P2-06 | OFFEN | exchange_executor/ccxt_adapter.py:653, 690 | 30 Tage / 500 Orders / 1000 Trades ohne vollständige Fortsetzung. Fehlende Daten werden nicht zuverlässig als unvollständig markiert. | 002 |
| P2-07 | OFFEN | exchange_executor/ccxt_adapter.py:258 | Ersatz-Fill-ID order:timestamp:amount kann verschiedene echte Fills zusammenfallen lassen. | 002 |
| P2-08 | OFFEN | exchange_executor/ccxt_adapter.py:252 | Fill ohne Order-ID verschwindet beim Normalisieren, statt als ungeklärtes Ereignis sichtbar zu bleiben. | 002 |
| P2-09 | OFFEN | exchange_executor/ccxt_adapter.py:653 | Letzter Endpoint gewinnt beim Merge; alter offener Zustand kann neuere Informationen verdrängen. | 001 |
| P2-10 | OFFEN | src/trading_engine.ts:1815 | Kein generischer Abschluss erst nach Klärung/Storno aller verbliebenen eigenen Exit-Siblings. | 003 |
| P2-11 | OFFEN | src/trading_engine.ts:146, 714, 1307 | TP-Replacement-Client-ID enthält Zufall. created nach Crash kann durch weitere neue Zeile ersetzt statt wiederaufgenommen werden. | 003 |
| P2-12 | OFFEN | src/trading_engine.ts:1366; exchange_executor/ccxt_adapter.py:153 | Cancel verlangt terminalen Status, aber sparse Cancel-Antwort kann filled=0 liefern; ohne frische Evidenz wird Restallokation falsch. Eine vollständige wahrheitsgemäße Cancel-Antwort ist nicht per se unsicher. | 003 |
| P2-13 | OFFEN | src/ccxt_exchange.ts:278 | Arrays/Fingerprint reichen als Trust-Boundary nicht; verschachtelte Objekte und Relationen sind untervalidiert. | 001 |
| P2-14 | OFFEN | src/ccxt_exchange.ts:221 | Market-Snapshot wird weitgehend gecastet; Requestsymbol, Mengenraster, Preis und Zeit benötigen semantische Prüfung. | 001 |
| P2-15 | OFFEN | exchange_executor/ccxt_adapter.py:420 | Früher Leverage-Tier/Marktlimit statt größenabhängiger Bewertung. | 004 |
| P2-16 | TEILWEISE | src/trading_runtime.ts, runOnce; tests/test_trading_failures.js:680, 1046 | protectionHealthy wird trotz Fehler true. Tests dokumentieren aber bewusst Account-Isolation; kein pauschaler globaler Fail-open-Beweis. Per-Account-Readiness und klare Benennung statt alle Konten sperren. | 002 |
| P2-17 | OFFEN | src/paper_exchange.ts:166, 171, 204 | Positive Teilfüllung wird als filled markiert; teilweise ausgeführte Orders werden im Settle-Pfad nicht konsistent weitergeführt. Verbirgt kritische Lifecycle-Testfälle. | 003 |
| P2-18 | OFFEN | src/trading_repository.ts:1529 | Monitoring zählt nur offene Stops, statt denselben Restschutzbeweis wie die Engine zu verwenden. | 003 |
| P2-19 | OFFEN | src/trading_repository.ts:796 | Account-Update kann beim Retire-Race 0 Zeilen treffen und trotzdem benachrichtigen/fehlerhaft zurückgeben. | 001 |
| P2-20 | TEILWEISE | scripts/export_sonarcloud_findings.js:14; GitHub Actions Run 33598183626 | Alter CI-Ausfall ist überholt: exakter aktueller HEAD grün. Export besitzt weiterhin keinen begrenzten Retry gegen transiente Lesefehler. | 008 |
| P2-21 | DESIGN/GRENZE | docs/adr/0012-ccxt-visual-workflow-control-plane.md; exchange_executor/ccxt_certification.py | Implementierungs-Allowlist wird ausdrücklich von realer Testnet-/Produktionsabnahme getrennt. Zusätzliche Provider-Evidenz ist ein Abnahme-Gate, kein Beweis für irreführende behauptete Live-Zertifizierung. | 008 |
| P2-22 | OFFEN | src/crash_guard.ts:82, 140 | Leere wx-Lockdatei kann nach hartem Crash dauerhaft bleiben. Keine unbewiesene PID-/Alterslöschung erlauben. | 007 |
| P2-23 | OFFEN | src/backup.ts:459, 476, 482 | SQLite-Snapshot ist konsistent; DB, externe Config und Templates sind aber nicht gemeinsam auf eine logische Generation gepinnt. | 007 |
| P2-24 | TEILWEISE | src/backup.ts:358, 635; tests/test_backup.js:214; README.md:129 | Integrität bedeutet nicht Restore-Zulässigkeit. Exposure-Refusal ist bewusst und bleibt. Kennzeichnungen/Restore-Evidence und RPO-Aussage müssen präzisiert werden. | 007 |
| P2-25 | OFFEN | src/backup.ts:635; src/trading_engine.ts:232; src/trading_runtime.ts | planned/opening=0/created kann Restore passieren und danach ohne Recovery Reserven dauerhaft blockieren. | 002 |
| P2-26 | OFFEN | src/mcp_maintenance.ts:47 | Feste Wartezeit ersetzt keinen Nachweis geschlossener DB-Handles anderer Prozesse. | 007 |
| P2-27 | TEILWEISE | src/signal_parser.ts:491; src/db.ts:1992, 2004; README.md:185 | Crash-Reserve bis UTC-Tagesende ist ausdrücklich konservativ beabsichtigt. committed=true vor fehlgeschlagenem Commit und fehlende idempotente Abrechnung sind dagegen zu beheben. | 006 |

## Zusätzlich beim Gegenprüfen gefunden

**AUX-01, hohe Sicherheit, Aufwand M, Änderungsrisiko hoch:** `src/trading_web_control.ts:507–509` verbietet Credential-Wartung bei *beliebiger* Orderhistorie. `open_state` liefert aber auch terminale historische Orders. Eine vollständig geschlossene alte Order kann so Wartung dauerhaft verhindern. Plan 003 verwendet den gemeinsamen Safety-Proof statt `orders.length > 0`. Das ist getrennt von der beabsichtigten API-Key-Bindung P1-21.

**Integrationsanforderung, nicht als zusätzlicher Audit-Bug gezählt:** Historien-Pagination muss ein gemeinsames begrenztes Requestbudget besitzen. `exchange_executor/ccxt_client.py:49` aktiviert CCXT-Limits pro Client; REST- und Pro-Instanzen sind getrennt. Plan 002 darf daraus keine unbeschränkte zusätzliche REST-Last erzeugen. Eine umfassende Provider-IP-Budget-Neugestaltung ist nicht ungefragt Teil dieser Reparaturserie.

## Belege aus Tests und CI

Bereits vorhandene lokale Tests waren grün:
- `node --import tsx tests/test_trading_engine.js`
- `node --import tsx tests/test_trading_web_control.js`
- `node --import tsx tests/test_ccxt_exchange.js`
- `node --import tsx tests/test_trading_failures.js`

Lokaler Node war 24.14.1; Projekt verlangt Node 22. Diese lokalen Resultate ersetzen deshalb nicht den vorgesehenen Runtime-Nachweis. Zusätzlich wurden Fake-Probes unter Python 3.12 / CCXT 4.5.75 ausgeführt; unter anderem Batch-Reihenfolge, Funding-Fehler, Fill-ID-Kollision und Order-Merge bestätigten die Code-Lücken. Es gab **keine Börsenorders und keine Serververbindung** für diese Prüfung.

[Quality OS 33598183626](https://github.com/888nikush888/tsx-core/actions/runs/33598183626) ist für exakt `f8089277d0667dd45bcf070037800d423fd89254` erfolgreich, einschließlich Sonar. Ein grüner Lauf bedeutet: vorhandene Tests/Gates bestanden. Er bedeutet nicht, dass die hier beschriebenen fehlenden Tests bereits existieren.

## Nicht bestätigt / nicht erneut zur Reparatur vorgesehen

Kein neuer pauschaler Float-Fehler der Decimal-Risikorechnung; kein bestätigtes normales Scheduler-Capacity-Race; kein verlorenes Workflow-baseRevision-CAS; kein Partial-Apply des Setup-Bundles; keine nichtatomare Fallback-Promotion; kein Blind-Fallback nach unklarem Submit. Bestehende Fail-closed-, Retention-, Auth-, Approval- und Backup-Integritätsregeln bleiben erhalten. Daily-Loss-Prozentsatz auf aktueller Equity ist beabsichtigt.

## Grenzen der Prüfung

Schwerpunkt war die vollständige Gegenprüfung dieses Berichts und seiner direkt betroffenen Aufrufketten, nicht ein neues Vollaudit jeder UI-/Authentifizierungsdatei. Keine realen Konten, aktuelle Orders, Telegram-Sitzungen oder produktiven Backup-Artefakte wurden geprüft. Reale Providerwirkung und Rollout-Eignung müssen erst durch die geplanten Freigabegates belegt werden.
