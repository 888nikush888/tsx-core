# TSX Core: geprüfte Auditpunkte und Reparaturplan

Stand 2. September 2026 · ursprüngliche Improve-Prüfung, anschließend lokale Umsetzung beauftragt.
Arbeitskopie: `C:/Users/nikla/Desktop/tsx-core`.
Geprüfter Commit: `f8089277d0667dd45bcf070037800d423fd89254`.
Ursprünglicher Auftrag: den hochgeladenen Auditbericht am aktuellen Code prüfen und Lösungen für **alle bestätigten Punkte** planen. Folgeauftrag: **„Setze vollständig um“**, aktuell lokal in Arbeit. Keine Server-/Provider-Schreibaktionen oder Veröffentlichung ausgeführt. Aktueller Nachweis und Restarbeit: [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md). Historische Prüfresultate unten sind keine Abschlussbehauptung für die laufende Umsetzung.

## Ergebnis zuerst

Der kritische Kern des Berichts bestätigt sich: Ein noch offener Entry kann nach Sperre oder scheinbarem Trade-Ende weitere Exposure erzeugen. Außerdem benötigen Identitätszuordnung, Restart-Recovery und Behandlung verspäteter/unvollständiger Börsendaten gemeinsame robuste Regeln.

Nicht jede Formulierung des Berichts ist uneingeschränkt richtig. Deshalb enthält die [vollständige Prüfliste](AUDIT-VERIFICATION.md) für jede der 64 Positionen Beleg, Einstufung, Korrektur und zuständigen Plan:

- 56 OFFEN;
- 5 TEILWEISE;
- 3 DESIGN/GRENZE.
- Alle 7 P0 mit bestätigtem Kern; keine durch diese Prüfung behoben.
- Ein zusätzlicher konkreter Befund: terminale Orderhistorie kann Credential-Wartung unnötig blockieren (AUX-01, Plan 003).

Dies sind teilweise überlappende Prüfpositionen, nicht 64 unabhängige Reparaturprojekte. Der Improve-Skill hat die Planung bewusst nach gemeinsamen Ursachen gebündelt und dokumentierte Schutzentscheidungen von tatsächlichen Defekten getrennt.

## Reihenfolge und Status

| Plan | Ergebnis der Umsetzung | Priorität | Aufwand | Änderungsrisiko | Abhängigkeit | Status |
|---|---|---|---|---|---|---|
| [001](001-mutation-identity-state.md) | Ein Mutationspfad pro Konto; finaler Sperr-/Identitätscheck; korrekte IDs und monotone Zustände | P0/P1 | L | hoch | — | IN PROGRESS |
| [002](002-evidence-ownership-recovery.md) | Vollständige/revidierbare Evidenz, keine fremde Exposure-Übernahme, deterministischer Neustart | P1 | L | hoch | 001 | IN PROGRESS |
| [003](003-entry-protection-lifecycle.md) | Kill/Flatten/Abschluss berücksichtigen Entryreste; einheitlicher Stop-/TP-/Freigabebeweis | P0 | L | hoch | 001, 002 | IN PROGRESS |
| [004](004-execution-constraints.md) | Belegter Kontomodus, Entry-Preisgrenze, größenabhängiger Hebel, gemeinsame Fallback-TTL | P1/P2 | L | hoch | 001, 002, 003 | IN PROGRESS |
| [005](005-money-risk-ledger.md) | Einheitliche Fees/Funding/PnL; dynamische tatsächliche Risikoreserven | P1/P2 | L | hoch | 001, 002, 003, 004 | IN PROGRESS |
| [006](006-ingress-workflow-budget.md) | Crashsicherer Telegram-Eingang, gepinnte Revision, idempotente Signals/AI-Abrechnung | P1/P2 | L | hoch | fachlich unabhängig | IN PROGRESS |
| [007](007-startup-backup-maintenance.md) | Richtige Startfreigabe, echte Wartungs-Acks, kohärente Backups und ehrliche Restore-Nachweise | P1/P2 | L | hoch | 001, 002, 003, 006 | IN PROGRESS |
| [009](009-additional-ccxt-derivatives.md) | Alle leicht integrierbaren CCXT-Futures-/Perp-Profile mit gleicher TSX-Prüftiefe ergänzen | beauftragte Erweiterung | L | hoch | 001–007; Acceptance-Werkzeuge aus 008 | IN PROGRESS |
| [008](008-quality-provider-acceptance.md) | Robuster Sonar-Export, Regressionen und getrennte Code-/Provider-/Release-Abnahme | P2 + Freigabegate | M/L | mittel/hoch | 001–007 und 009 für Endabnahme | IN PROGRESS |

L bedeutet mehrstufige Änderung mit Migrationen und umfassenden Regressionstests, keine seriöse „Schnellkorrektur“. Die Codebelege haben hohe Sicherheit; reale Providerwirkungen sind noch nicht am Konto reproduziert.

001/002 stehen vor 003, obwohl 003 P0 enthält: Sichere Cancels und Freigaben benötigen zuerst gemeinsame Identität, serialisierte Mutation und belastbare Evidenz. Diese Pakete sind als **eine Sicherheitsfreigabe** zu betrachten, nicht einzeln als „Live jetzt sicher“.
006 kann parallel konzipiert werden, aber db.ts-/Schemaänderungen müssen nacheinander integriert werden. Der kleine Sonar-Read-Retry aus 008 kann früher erfolgen; die Gesamtabnahme niemals.

Zusatzauftrag vom 2. September 2026: **009 kommt nach den laufenden Reparaturen und unmittelbar vor die Gesamtprüfung in 008.** Bestehende Nummern bleiben erhalten. 009 inventarisiert alle CCXT-Derivatekandidaten, implementiert alle nachweislich leicht integrierbaren Profile und unterscheidet lokale TSX-Verifikation von echter Providerabnahme. Keine bloße Auswahl einiger bekannter Börsen und keine niedrigeren Sicherheitsanforderungen. Die bisherige Arbeit wird dafür nicht vorgezogen oder unterbrochen.

## Unverrückbare Grenzen

- Anwendung auf die gemeinsamen Engine-/CCXT-Verträge; nicht nur ein Hyperliquid-Sonderfix. Gegenwärtige Profile: Hyperliquid, Bybit, Kraken Futures; Paper bekommt passende Partial-Fill-Tests.
- Weitere Futures-/Perp-Profile werden ausschließlich im ausdrücklich ergänzten Paket 009 auf demselben reparierten Standard aufgenommen; reine Spot-Integration und neue Handelsarchitekturen sind nicht Teil dieser Erweiterung.
- Keine fremden/unbewiesenen Orders übernehmen, stornieren oder flatten.
- Kein Blind-Retry oder Börsenfallback nach unklarem Submit.
- Bestehende Schutzorders und Telegram-Durable-Ingress nicht pauschal abschalten, wenn Neueinstiege gesperrt werden.
- Kontofehler isolieren; gesunde andere Konten nicht ohne globalen Grund blockieren.
- Margin-Prozent bleibt eingesetztes Kapital; Max-Leverage 50 und tatsächliche Nutzerkonfiguration nicht ungefragt verändern.
- Signal-SL/TP-Preise nicht umdeuten; adaptive Stops dürfen nicht lockern.
- Daily-Loss-Prozentsatz auf aktueller Equity bleibt beabsichtigt.
- Keine Datenbankrücksetzung, historische Signal-Neueinspeisung, pauschale Reservelöschung oder Änderung produktiver Konten.
- Keine Nebenfeature-/UI-Neuentwicklung; bestehende Builder-/Auth-/Tailscale-Architektur erhalten.

## Vorhandener Nachweis und offene Abnahme

Bereits grün: gezielte lokale Engine-, Web-Control-, CCXT- und Failuretests. Die lokale Node-Version war 24.14.1 statt erforderlicher 22.x; diesen Lauf nicht als vorgeschriebene Runtime-Abnahme ausgeben. Python-Fake-Probes wurden mit Python 3.12 und CCXT 4.5.75 ausgeführt.

[Quality OS 33598183626](https://github.com/888nikush888/tsx-core/actions/runs/33598183626) ist auf dem exakten geprüften SHA einschließlich Sonar erfolgreich. Das korrigiert den alten roten CI-Status im Bericht. **Die fehlenden neuen Regressionstests sind dadurch nicht nachträglich abgedeckt.**

Seit dem Folgeauftrag werden die Reparaturpakete lokal umgesetzt. Der laufende, genaue Implementierungs- und Teststand steht in [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md); die historische Erstprüfung oben ist kein aktueller Abschlussnachweis. Vollständige Umsetzung der ursprünglichen acht Pakete plus Zusatzpaket 009, echte geeignete Provider-Evidenz und ein gesondert autorisierter Rollout stehen weiterhin aus. Keine zusätzliche Livefreigabe aus grünen lokalen Tests ableiten.

## Dokumentierte Grenzen statt falscher „Fixes“

- **P1-19:** echte Börsen-Atomizität über mehrere REST-Endpunkte kann der Adapter nicht erfinden. Geplant sind Vollständigkeit, Provenienz, Konflikterkennung und gezielte Nachprüfung.
- **P1-21:** Bybit-/Kraken-API-Key-Bindung ist eine bewusste erste Ausbaustufe. Sicheres kontoidentisches Schlüsselwechseln benötigt eine eigene belegte Identitätsmigration; die Prüfung bleibt bestehen.
- **P2-21:** statische Implementierungs-Allowlist ist laut ADR ausdrücklich keine Live-/Testnetzertifizierung. Plan 008 ergänzt Nachweisdisziplin, nicht eine falsche Behauptung „bisher war alles echt zertifiziert“.
- **P2-16:** protectionHealthy ist missverständlich; Account-Isolation ist jedoch ausdrücklich beabsichtigt. Keine globale Abschaltung allein wegen eines einzelnen Kontofehlers.
- **P2-24:** Restoreverweigerung bei Exposure bleibt; unpräzise Backup-/RPO-Aussagen werden korrigiert.
- **P2-27:** konservatives Festhalten unbekannter AI-Nutzung bis Tagesende bleibt; defekte Commit-Abrechnung wird separat korrigiert.
- **P0-07:** nichtterminale Cancels zählen aktuell nicht als erfolgreicher Cancel. Die reale Lücke ist ihre fehlende zwingende Behandlung als weiterhin ungelöste Verpflichtung.
- Weitere verworfene Verdachtsfälle stehen am Ende der vollständigen Prüfliste.

## Arbeitsregeln für spätere Umsetzung

Jeder Plan ist einzeln lesbar mit aktuellem Codeauszug, Scope, Testbefehlen, Sollverhalten und STOP-Bedingungen. Vor Beginn HEAD/Drift prüfen. Nach akzeptierter Vorgängerstufe die erwarteten Schnittstellenänderungen abgleichen; nicht einfach ursprüngliche Zeilennummern blind patchen.

Neue Migrationen transaktional und wiederholbar, widersprüchliche Altbestände nicht löschen. Tests müssen zuerst den jeweiligen Fehler zeigen und anschließend grün sein. Bei fehlendem Providerbeweis Unsupported/Unresolved sichtbar lassen statt einen Sicherheitscheck zu entfernen.

Projekt-Runtime: Node 22.x, npm 10.9.x, Python 3.12, CCXT 4.5.75. Keine ungeprüften Upgrades. main bleibt der langfristige Branch; aktuelle Planung veröffentlicht nichts.

Statuswerte für spätere Bearbeiter: TODO, IN PROGRESS, DONE, BLOCKED (konkreter Grund), REJECTED (Begründung). DONE nur mit passenden Befehls-/Testnachweisen; Implementierung, Fake-Test, Providerabnahme und Release sind getrennte Zustände.

## Grenzen der ursprünglichen Prüfarbeit

Die ursprüngliche Prüfung war kein neues Vollaudit aller UI-/Authfunktionen und legte nur Planunterlagen an. Die anschließend beauftragte Implementierung verändert jetzt lokalen Programmcode und Tests. Weiterhin keine produktive Konto-/Orderprüfung, keine Verbindung zum TSX-Server oder zur laufenden Anwendung, keine echten Trades und kein produktiver Restore.
