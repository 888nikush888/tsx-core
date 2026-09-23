# Plan 005: Futures-Börsen maximal sicher erschließen und TSX Core vollständig per UI betreiben

> **Ausführungsauftrag:** Dies ist ein mehrstufiges Produkt- und Releaseziel, keine pauschale Handelsfreigabe. Jeder Abschnitt wird in kleinen, eigenständig getesteten PRs umgesetzt. Vor jedem Schritt `git diff --stat 7b660b90ce70bd9d76852fa7e6d6135367921928..HEAD -- <betroffene Pfade>` ausführen und bei Abweichungen die hier genannten Verträge neu prüfen. Nach jedem PR die angegebenen Checks auf dessen exaktem SHA ausführen. Bei einer STOP-Bedingung bleibt die betroffene Börse oder Betriebsfunktion gesperrt; andere unabhängig geprüfte Slices dürfen weiterbearbeitet werden.

## Status und Ziel

- **Status:** TODO; Ziel konkretisiert am 2026-09-23 auf Commit `7b660b90ce70bd9d76852fa7e6d6135367921928`.
- **Priorität/Risiko/Aufwand:** P1 / hoch / Programm aus mehreren PRs und echten Providerabnahmen.
- **Abhängigkeit:** [Plan 004](004-final-findings-stability.md), Draft-PR [#73](https://github.com/888nikush888/tsx-core/pull/73), exakte CI-/Scanner- und geschützte Main-Abnahme. Keine Live-Freigabe aus diesem Plan allein.
- **Betreiberentscheidung:** So viele von der gepinnten CCXT-Version tatsächlich sicher unterstützbare **Futures-Produkte** wie möglich. Spot und Optionen bleiben außerhalb dieses Ziels. Perpetual Swaps und Futures mit Verfall werden als getrennte Produktslices behandelt; linear, inverse, quanto, Margin-/Settlementwährung, Kontomodus und Region können separate Slices erfordern.
- **UI-Entscheidung:** 100 % der im laufenden Betrieb änderbaren Börsen-, Konto-, Strategie-, Risiko-, Signal-/KI-, Secret-, Monitoring-, Backup- und Infrastrukturwerte müssen über eine typisierte, berechtigte UI verfügbar sein. Harte Sicherheitsinvarianten, Implementierungs-/Providerabnahme, Rollen-/Trust-Root-Grenzen sowie Review- und CI-Gates bleiben im Code beziehungsweise außerhalb der Laufzeit-UI fest und sind dort nicht abschaltbar.

**Erfolg heißt nicht „alle CCXT-IDs aktiviert“.** Erfolg heißt: Jede ID und jeder Derivate-Produktslice ist vollständig inventarisiert und hat entweder eine belegte, getestete, providerabgenommene Zulassung oder einen konkreten sichtbaren Blockgrund. Die Zahl der zugelassenen Slices wächst nur mit vollständigem Nachweis. Für Livehandel sind zusätzlich Konto-, Betriebs- und Releasegates erfüllt.

## Ausgangszustand und verbindliche Grenzen

- `docs/testing/ccxt-expansion-matrix.md` und `.json`: CCXT **4.5.75**, 103 REST-/76 Pro-IDs, 60 mit deklariertem `swap` oder `future`; 24 erfüllen nur den bisherigen nativen REST-/Pro-/Credential-Vorfilter. Das Inventar hat 1 `existing` (Hyperliquid), 66 `not_easy`, 36 `not_derivative`, 0 `pending`. Diese Bewertungen beschreiben den **jetzigen** Integrationsvertrag und sind keine dauerhaften Verbote. `not_derivative` sagt nur etwas über die gepinnte SDK-Klasse aus. Die 24 Vorfilter-IDs stehen vollständig in der Matrix; ein positives SDK-Flag ist keine Handelsfreigabe.
- `exchange_executor/ccxt_profiles.py:74-151` enthält Hyperliquid, Bybit und Kraken Futures. `exchange_executor/ccxt_implementation_reviews.py` pinnt nur einen verengten Hyperliquid-Implementierungsreceipt. Bybit und Kraken Futures bleiben quarantined. `exchange_executor/ccxt_registry.py:137-160` gibt `certified` ausschließlich bei gültigem Profil, Fähigkeiten und bytegebundenem Receipt zurück; ohne Profil `discovered`, bei ungültigem Beleg `quarantined`. `exchange_executor/ccxt_client.py:203-271` setzt Status und Kontomodus vor Ausführung durch.
- `exchange_executor/symbol_resolver.py:30-39,85-125` entdeckt nur aktive **lineare Perpetuals** mit USD/USDT/USDC-Regeln. Ein `future` mit Verfall oder inverser Kontrakt passt nicht stillschweigend in diesen Resolver. Erst eine explizite Produkt- und Geldpfadarchitektur darf ihn erweitern.
- `docs/testing/exchange-acceptance.md` trennt synthetischen Implementierungsbeleg, echten Testnet-/Providerbeleg und Release. Der Realtransport im `exchange_executor/tests/provider_acceptance_runner.py` ist noch unimplementiert; `providerAcceptanceVerified` ist false. Ein bestandener Offline-Validator und ein öffentlicher Markt-Probe sind kein Provider-PASS.
- `docs/ui-next/REGISTER.md` erfasst 138 authentifizierte Routen und 311 typisierte Parameter. `docs/ui-next/inventory/{api-routes,capabilities,parameters}.json` sind die prüfbaren Register. Bestehende UI: Konten/Katalog/Secrets/Verifikation/Rotation/Kill, Workflows/Strategie/Risiko, 35 Runtimefelder, 33 Konfigurationsfelder, Viewer, MCP, Backups. `tests/test_ui_register.js` schützt Routen-/Parameterdrift. In `parameters.json` bedeutet „editierbar“ bei `account.name/exchange/mode` **nur bei Anlage**, nicht nachträgliches Rebinding.
- Die Core-UI beobachtet bisher Host-Image-Digests, Ports, CPU/RAM und Browser-Buildflags nur lesend (`frontend/src/features/operations/deployment.tsx`). Prometheus-/Alertmanagerdateien und Bootstrap-/Reverse-Proxy-/externe Mount-Konfiguration werden am Host verwaltet. Ein gestoppter Core kann sich selbst nicht wiederherstellen. Diese Lücken dürfen nicht durch eine freie Shell, Docker-Socket-Zugriff im Browser oder Secret-Rückgabe geschlossen werden.
- Der Betreiber hat fünf interne HTTP-Risiken ausdrücklich akzeptiert; Akzeptanz und Frist bleiben in der Risikodokumentation. Aikido ist aus dem Scannerziel ausgenommen; DeepSource JS-R1005 ebenfalls. Snyk hat ein privates Testkontingentproblem, Codacy Analyzer-/historische Befundgrenzen. Nichts davon wird still als grün umgedeutet.

## Arbeitsfolge und Abnahme je Etappe

### 0. Scanner-, Source- und Releasebasis festziehen

Plan 004 auf dem exakten Kandidaten abschließen: 14 Quality-OS-Pflichtchecks, CodeQL, Browser, Mutation, Builds, SBOM, DeepSource, Codacy, Sonar und verfügbare Snyk-Scans einzeln nachweisen; Providerfehler/Quoten klar von Codebefunden trennen. Offene Findings (einschließlich früherer False-Positive-Klassifikationen) auf exakt analysierte SHAs binden, keine stillen Ausnahmen ergänzen. Die bestehende Draft-PR #73 nur nach gültiger Betreiber-/Branchschutzfreigabe mergen; danach `main` erneut analysieren. Keine Derivate-Freigabe, solange dieser Baselinezustand unbekannt ist.

**Verifikation:** `gh pr view 73 --json headRefOid,statusCheckRollup,mergeStateStatus` → exakter SHA und jeder Pflichtcheck dokumentiert; `node scripts/verify_exchange_implementation.js --python <absoluter-Python-3.12-Pfad>` → `buildInputsMatch=true` und `runtimeReceiptsVerified=true`; Cloud-Exports/Quality-Gate beziehen sich auf den finalen Main-SHA. Snyk-Limit bleibt explizit offen, bis erneuter Scan möglich ist.

### 1. Vollständiges Produkt-/UI-Register als Source of Truth

`docs/testing/ccxt-expansion-matrix.json`, Registry und UI-Capability-Register so erweitern, dass jede der 103 gepinnten CCXT-REST-IDs nach Produkt (`swap`/`future`), linear/invers/quanto, Settlement, Region, Konto-/Positionsmodus und Evidenzstatus sichtbar ist. `unknown` bleibt ein eigener Zustand. Jede der 60 deklariert derivativen IDs und jede neue SDK-ID erhält einen aktuellen Bewertungsbeleg, nicht automatisch ein Profil. Zielmetrik: **100 % inventarisierte IDs und 0 unbegründete oder automatisch zertifizierte Kandidaten**. SDK-Upgrade ist ein eigenes PR mit vollständiger Re-Inventur, Quellhash-/API-Diff, Regression und Requalifikation aller betroffenen Receipts.

`docs/ui-next/inventory/parameters.json` um Wirkungsklassen `create-only`, `runtime-editable`, `read-only-evidence`, `host-bootstrap`, `immutable-gate` und exakte Quelle, Rolle, Gültigkeitsbereich, Einheit, Default, gespeicherten/aktiven Wert, Neustartwirkung, Konfliktverhalten und Geheimhaltungsstatus ergänzen. Eine maschinenlesbare Coverage-Matrix verbindet **jeden** laufend änderbaren Parameter mit UI-Control, Backend-Validator, Test und Auditereignis. Zielmetrik: **100 % `runtime-editable` mit realem UI- und Backendpfad; 0 undokumentierte Env-/Datei-only-Betriebswerte**. Bootstrap und Offline-Recovery sind als physisch notwendige Ausnahme getrennt sichtbar und bekommen einen eigenen Wartungsdienst/Recovery-UI-Entwurf, falls sie im normalen Betrieb geändert werden sollen.

**Verifikation:** `node --test tests/test_ui_register.js` → Register-/Route-/Parameterdrift 0; `& <Python-3.12> -B exchange_executor/tools/audit_derivatives_candidates.py --offline --verify-inventory docs/testing/ccxt-expansion-matrix.json` und `--verify-complete` → exit 0 mit **nicht hartverlinkter** CCXT-4.5.75-Installation. Ein positiver Inventurcheck setzt keine Livefähigkeit.

### 2. Sichere UI-Konfigurationsverträge statt freier Infrastruktursteuerung

Vorhandene Konten-, Workflow-, Risiko-, Signal-, Secret-, Runtime-, Backup- und Monitoringflächen gegen die Matrix prüfen. Fehlende normale Operatoraktionen erhalten kleine, typisierte API-Verträge und UI-Formulare. Jeder schreibende Pfad verlangt serverseitig Rolle, aktuellen Objektstand/ETag, Validierung, Impact-Preview bei Tradingwirkung, idempotente oder eindeutig auflösbare Mutation, atomare Persistenz, Audit und eine geprüfte Rücknahme-/Recoverystrategie. Secret-Werte bleiben write-only und werden nie in Preview/Logs/API-Reads gespiegelt. Anzeige `unbekannt`/`stale` darf keine implizite Freigabe auslösen.

Für Host-/Infrastrukturwerte einen **separat authentifizierten, eng erlaubnisgebundenen Wartungs-/Deploymentdienst** entwerfen: UI wählt nur versionierte, signierte/freigegebene Images und validierte Ressourcen-/Port-/Monitoring-/Backup-Profile; der Dienst prüft erneut, bietet Preview, Healthcheck, Rollback und Audit. Keine freie Shell, Docker-Socket-Weitergabe, beliebige Image-URL oder Bearbeitung von CI-/Trust-Root-Dateien. Einen zerstörten/gestoppten Core muss ein davon unabhängiger Recoverypfad starten können. Änderungen an externen IdP-/Börsenrechten bleiben beim jeweiligen Provider; die UI zeigt deren Nachweis-/Prüfstatus und klare Anleitung.

**Verifikation:** `npm run typecheck`, `npm run lint`, `npm run lint:frontend`, `node --test tests/test_ui_register.js`, `npm --prefix frontend run test:coverage`, Browser-/Rollenfälle → alle grün. Tests müssen Admin/Viewer/Recovery, Paper/Testnet/Live, 401/403/409/412/503, stale/unknown, Secret-Redaktion, Neustartwirkung, atomare Rollbacks und unbekannte Mutationsergebnisse abdecken. `git diff` darf keine Abschwächung von Kill-Switch, Protective-Stop, Auth, Audit, Branchschutz oder CI zeigen.

### 3. Börsen in kleine, getrennte Produktslices aufnehmen

**Reihenfolge nach Beweislage, nicht nach Marketingreichweite:**

1. Hyperliquid als enger Referenzslice (Master-Key, USDC-Perp) erst mit echtem Provider-/Kontobeleg abschließen; das Offline-Receipt ist bereits vorhanden, aber keine Liveabnahme.
2. Bereits deklarierte Bybit- und Kraken-Futures-Profile nur nach Schließen ihrer dokumentierten Quarantänegründe: Bybit accountweite Option-/Pre-upgrade-/delistete Fillfinalität; Kraken geschützter IOC+Stop und Recovery/History. Keine automatische Freigabe aus alten Bool-Dateien.
3. Nach eigener Architektur für attached/optionale Child-Stops: OKX, Bitget, Gate, Extended, WEEX und WOO **jeweils einzeln** prüfen. Binance USDⓈ-M benötigt vorher getrennte Algo-/Conditional-Order- und Historydomäne. KuCoin Futures, Aster, BingX und GRVT brauchen jeweils eigene Konto-/Kapazitäts-/Historyklärung. Weitere der 24 Vorfilter-IDs werden danach gemäß Matrix einzeln untersucht.
4. Inverse/quanto und Futures mit Verfall erst nach explizitem Kontrakt für Multiplikator, Notional, PnL-/Gebühren-/Funding-/Deliverywährung, Verfalls-/Rollover-/Liquidationsrisiko und Positions-/Orderhistorie. Keine Wiederverwendung des linearen Perp-Geldpfads ohne Beleg.

Für **jeden** Slice zehn prüfbare Verträge liefern: (1) Identität/Secret/Signatur, (2) Symbol/Produkt, (3) Account-/Margin-/Positionsmodus und Admission, (4) atomar geschützter Entry+Stop, (5) Ownership/Reconciliation, (6) lückenlose Order-/Fill-/Fee-/Funding-/Delivery-History, (7) Kill/Cancel/Recovery nach Partial-/Late-Fill, (8) Menge/Preis/Leverage/Notional/PnL, (9) Fehler-/Rate-limit-/Stream-Verhalten, (10) TTL/Fallback/Restart über alle Schichten. Quelle, SDK-Bytes, Fixtures, Normal- und adversariale Tests, Anfragezählung sowie persistierter Ergebnisstatus gehören in den unabhängigen Review. `PROFILES`/Registry/Resolver erst nach bestandenem Implementierungsreview ändern. Eine fehlende Pflichtantwort ist `NOT_PROVEN`, nie PASS.

**Verifikation je PR:** CCXT-Inventur `--verify-complete`; gezielte Python-Contracttests und `& <Python-3.12> -B -m coverage run --branch --source=exchange_executor -m unittest discover -s exchange_executor/tests -v` → alle grün; `node scripts/verify_exchange_implementation.js --python <Python-3.12>` → gebundener Receipt gültig. Negativtests für unvollständige History, stale Status, falschen Modus, partial/late fill, verlorenen Stop, Rate-limit und Restart müssen fail-closed bleiben. Keine Änderung anderer Slices durch gemeinsame Fallbacks.

### 4. Echte Providerabnahme je Exchange/Product/Mode/Region

Den noch fehlenden Realtransport im Provider-Acceptance-Runner als getrennte, explizit autorisierte Testnet-Funktion implementieren. Nur offizielle testnet origins, temporäre eng berechtigte Schlüssel, benannte Accounts und minimale Testnotionals. Reale ACKs, Orders, Stops, Fills, Gebühren/Funding, Cleanup und Null-Restexposure mit redigierten Originalantworten/Hashes erfassen. Die neun Pflichtfälle aus `docs/testing/exchange-acceptance.md` und die zehn Slice-Verträge müssen abgedeckt sein; nicht sicher reproduzierbare Fälle bleiben `NOT_PROVEN`. Unabhängige Prüfung bindet Evidence-Digest, SDK-/Source-SHA, Profil-/Produkt-/Modus-/Region-Scope und Cleanup. Providerstatus muss gesondert vom Offline-Implementierungsstatus geführt werden; UI zeigt beide plus Ablauf/Drift.

**Verifikation:** `node scripts/verify_exchange_acceptance.js --evidence <redigierte-akte.json> --source-sha <exakter-SHA> --exchange <ID> --allow-testnet-origin <offizielle-Origin>` → Format/Binder/Limit/Cleanup PASS. `--require-provider --approved-evidence-sha256 <unabhängig-freigegebener-Digest>` darf nur nach echtem Review PASS liefern. Fehlende Liveproviderbelege sperren `Live aktivieren` serverseitig und in der UI.

### 5. Betriebsreife, Staging und gestufter Livebetrieb

Je zugelassenem Slice/Konto: getrennte Paper-, Testnet- und Livekonten; API-Rechte nur Futures/Trade/Read, keine Withdrawal-Rechte; IP-Allowlist und externe Providerrechte nachweisbar; Positions-/Exposure-/Hebel-/Order-/Tagesverlustlimits in UI; persistente Eigentümerschaft und Reconciliation; Notfall-Kill und manueller Recoveryablauf. OIDC/TLS oder Tailnet, unveränderliche externe Auditkette, Offsite-Backup samt Restore-Drill, Prometheus/Alertmanager/On-Call und Runbooks müssen auf der tatsächlich betriebenen Installation geprüft sein. Die fünf akzeptierten internen HTTP-Risiken bleiben mit Fälligkeit sichtbar; eine Akzeptanz ersetzt keine andere Betriebsprüfung.

Saubere Neuinstallation/Upgrade/Rollback und Migration mit produktionsnahen redigierten Daten in Staging prüfen. Danach mindestens **30 Tage** Paper/Testnet-Soak mit vollständig beobachteten Signalen, Orders, Stops, Fills, Fees/Funding, Reconnects, Restart/Backup/Restore und Incidentproben; jede ungeklärte Exposition oder PnL-Abweichung setzt die Soak-Uhr für den betroffenen Slice zurück. Erst danach ein einzeln autorisierter Canary mit kleinstem Limit und klaren Stop-/Rollbackkriterien, dann schrittweise Erhöhung pro Börse/Konto. Es gibt keinen globalen „alle Börsen live“-Schalter.

**Verifikation:** `npm run build`, `npm run test:coverage`, `npm run test:coverage:modules`, `npm run quality:architecture`, `npm run quality:complexity`, `npm run quality:frontend`, `npm run quality:release`, `npm run quality:monitoring`, `npm run quality:dependencies`, `npm run quality:licenses`, `npm run quality:sbom`, `npm run quality:deployment-images` und die CI-Matrix auf exakt dem Release-SHA → alle erforderlichen Checks grün. Staging-, Restore-, Soak-, Canary-, Incident- und Providerakten nennen SHA, Account/Slice, Zeitfenster und unabhängigen Reviewer. Nur freigegebene Slice/Konto-Kombinationen können live aktiviert werden.

## Globale Fertigkriterien

- [ ] Plan 004 und Main-Nachscan abgeschlossen; jeder Scannerbefund entweder behoben oder einzeln begründet mit vom Betreiber akzeptierter Restgrenze, keine verdeckten Quoten-/Analyzerfehler.
- [ ] 100 % der gepinnten CCXT-IDs/Produktslices bewertet; jede Zulassung mit gültigem Source-/SDK-/Implementierungs- **und** Providerbeleg, alle anderen mit präzisem UI-Blockgrund.
- [ ] 100 % der laufend änderbaren Parameter haben typisierte UI, serverseitige Autorisierung/Validierung, Audit, Test und sichere Wirkung; Host-/Bootstrap-/Offline-Recovery-Grenzen sind sichtbar und über einen gesicherten Wartungspfad bedienbar.
- [ ] CI-/Review-, Auth-, Stop-, Risk-, Evidence- und Provider-Gates können weder durch UI noch Konfigurationsdatei ausgeschaltet werden.
- [ ] Staging, 30-Tage-Soak, Restore-/Incidentproben, Providerabnahme und begrenzter Canary sind für **jede** freizugebende Slice/Konto-Kombination nachgewiesen; Live-Rollout bleibt gesondert autorisiert.

## STOP-Bedingungen

- Ein Produkt ist nur durch CCXT-Flags, Katalog-Probe oder synthetische Tests belegt; geschützter Entry/Stop, Ownership, History, Geldpfad, Mode, Settlement oder Providerantwort sind unsicher.
- Ein UI-Wunsch würde Sicherheitsinvarianten, CI-/Reviewpflicht, Rollenprüfung, Audit, Secret-Grenze oder Providerfreigabe veränderbar machen.
- Eine Infrastrukturfunktion braucht freie Host-/Docker-/Shell-Berechtigung aus dem Core-Webprozess oder kann bei UI-Ausfall keinen sicheren Recoverypfad anbieten.
- Build-/Receipt-/SDK-Hashes, exakter CI-SHA, Scanneranalyse oder Inventur driften; ein Test schlägt zweimal nach begrenztem Fixversuch fehl.
- Ein Testnetfall hinterlässt offene Orders, Exposure oder ungeklärte Zustellung; reale Börsenbedingungen oder Kontorechte sind nicht nachweisbar.

## Wartung und Bericht

Nach jedem CCXT-Pin, Exchange-API-, UI-Parameter- oder Sicherheitsregelwechsel die betroffenen Inventar-/Review-/Providerbelege erneuern; alte Erfolge gelten nicht automatisch. Fortschritt separat berichten als **(a)** Scanner-/Main-Basis, **(b)** UI-Abdeckung `abgedeckte runtime-editable / alle runtime-editable`, **(c)** Derivate-Inventur `bewertete / alle IDs` und **(d)** Livezulassung `providerabgenommene Slices / relevante Slices`, jeweils mit exaktem SHA. Aus diesen verschiedenen Nennern keine scheinpräzise gemeinsame Prozentzahl bilden.
