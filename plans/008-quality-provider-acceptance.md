# Plan 008: CI robuster machen und Provider-/Release-Nachweise sauber trennen

> Dieser Plan erteilt keine Erlaubnis zu echten Testnet-Trades, Veröffentlichung oder Deployment. Reale Abnahme braucht einen eigenen freigegebenen Umfang.
> Repo `C:/Users/nikla/Desktop/tsx-core`; Planstand `f8089277d0667dd45bcf070037800d423fd89254`, 2026-09-02.
> Drift: `git diff --stat f8089277d0667dd45bcf070037800d423fd89254..HEAD -- scripts tests exchange_executor .github docs README.md`.

## Status / Voraussetzungen

Lokale Werkzeuge und Offline-Gates implementiert; externe Endabnahme weiterhin BLOCKIERT durch fehlende Docker-Engine sowie fehlende GitHub-/Sonar-Laufzeitnachweise. P2 für Export-Robustheit, zwingendes Release-Gate für Gesamtreihe · Aufwand M/L · Risiko MITTEL, bei realen Kontotests HOCH.
Voraussetzung für Endabnahme: 001–007 sowie die nachträglich beauftragte Erweiterung [009](009-additional-ccxt-derivatives.md) lokal abgenommen. Export-Retry und Acceptance-Werkzeuge können unabhängig früher implementiert werden; 009 benötigt das Artefaktformat, nicht die schon abgeschlossene Gesamtprüfung. Reihenfolge: Reparaturen → zusätzliche geeignete Börsen → Gesamtprüfung.
IDs: P2-20, P2-21, P1-21; Integration und Abnahmenachweis aller Pakete.

Aktueller HEAD besitzt bereits einen erfolgreichen Quality-OS-Lauf. Das beseitigt weder fehlende Regressionsfälle noch die Einmaligkeit des Sonar-Exports. Implementierte Providerfähigkeiten und echte Exchange-Abnahme bleiben unterschiedliche Aussagen.

## Aktueller Stand / dokumentierte Entscheidungen

`scripts/export_sonarcloud_findings.js:17–20`:
```js
const response = await options.fetchImpl(url, {
  headers: { accept: 'application/json', authorization: `Bearer ${options.token}` },
  signal: AbortSignal.timeout(30_000)
});
```
Ein einmaliger transienter Lesefehler beendet den Export.

[Quality OS Run 33598183626](https://github.com/888nikush888/tsx-core/actions/runs/33598183626) ist für exakt `f8089277d0667dd45bcf070037800d423fd89254` grün. Der im Eingangsbericht genannte fehlgeschlagene Lauf 33503052682 betrifft den älteren Stand.

ADR 0012 trennt ausdrücklich Implementierungs-Allowlist von Testnet-/Produktionsabnahme. `ccxt_certification.py` plus JSON-Attestationen sind kein echter Börsentest und behaupten laut ADR auch keinen.
`exchange_executor/ccxt_client.py:37`:
```python
if profile.identity_strategy == "credential_binding":
    return secret["apiKey"]
```
Diese Bybit-/Kraken-Bindung bleibt, bis ein separat belegtes Identitätsmigrationsmodell vorliegt. Eine API-Key-Rotation nicht durch Abschalten der Accountprüfung „lösen“.

Konvention: `tests/test_sonarcloud_export.js` injiziert fetch; dieses Muster erhalten. CI-Runtime ist Node 22 / Python 3.12, CCXT-Pin 4.5.75. Lokale grüne Node-24-Tests sind kein Ersatz für diesen Nachweis.

## Scope

`scripts/export_sonarcloud_findings.js`, `tests/test_sonarcloud_export.js`, `.github/workflows/quality.yml`.
Neue `scripts/verify_exchange_acceptance.js`, `tests/test_exchange_acceptance.js`; `tests/run_all.js`.
Neue `exchange_executor/tests/provider_acceptance_runner.py` und ausschließlich Fake-Tests seiner Sicherheitsgates in `exchange_executor/tests/test_provider_acceptance.py`.
`docs/adr/0012-ccxt-visual-workflow-control-plane.md`, `docs/TRADING_GUIDE.md`, `README.md`; neues `docs/testing/exchange-acceptance.md`.
Bestehende Profile/Attestationen nur um getrennte Nachweisreferenzen ergänzen, nicht Provider-Allowlist erweitern.

Diese Scopegrenze gilt für Arbeiten **innerhalb von 008**. Der Zusatzauftrag 009 autorisiert die separate lokale Profil-Erweiterung vor dieser Endabnahme. Alle nach 009 hinzugekommenen Profile gehören anschließend vollständig zur hier geprüften Matrix; kein auf drei Börsen festgeschriebener Validator darf sie auslassen.

Nicht ändern: Sonar-Schwellen herabsetzen, Findings unterdrücken, kritische Pfade aus Coverage entfernen, neue Börsen zertifizieren, API-Key-Identitätsbindung lockern, Testnet per bloßem Bool aus einer echten Mainnet-URL ableiten, Livehandel ausführen.

## Befehle / Git

Node 22/npm 10.9, Python 3.12/CCXT 4.5.75. Installationen nur in separater Implementierungs-/CI-Umgebung, nicht als Teil dieses Audits.
- `node tests/test_sonarcloud_export.js`
- `node tests/test_exchange_acceptance.js` (nach Anlage)
- `python -B -m unittest discover -s exchange_executor/tests -v`
- `npm run typecheck`, `npm run lint`, `npm run lint:frontend`, `npm run lint:python`
- `npm run test:coverage`, `npm run test:coverage:modules`
- `python -m coverage run --branch --source=exchange_executor -m unittest discover -s exchange_executor/tests -v`
- `python -m coverage report --fail-under=60`
- `npm run quality:architecture`, `npm run quality:complexity`, `npm run quality:frontend`, `npm run quality:release`, `npm run quality:risk-acceptances`, `npm run quality:monitoring`, `npm run quality:build-context`
- `npm run build`, `npm run test:browser`
- `npm run test:mutation -- queue`, `npm run test:mutation -- retry`, `npm run test:mutation -- schema`, `npm run test:mutation -- trading-risk`
- `npm run quality:sonar-export` ausschließlich mit vorgesehenem CI-Secret und erwarteter exakter Revision, niemals Token in Kommandoausgabe.

Erwartet Exit 0 innerhalb der bestehenden Gate-Schwellen; keine neuen Ausnahmen. main bleibt einziger langfristiger Branch. Commit/Push/Release/Rollout erst nach separater aktueller Autorisierung; Testnet-/Produktionscredentials nie im Repo.

## Schritte

### 1. Sichere Sonar-Read-Retries ergänzen

Nur lesende Requests wiederholen: Netzwerkfehler, Timeout, 429, 502/503/504. Maximal drei Versuche, exponentielle kurze Wartezeiten mit injizierter Uhr/Jitter für Tests, Retry-After respektieren innerhalb eines Gesamtabrufbudgets von 60 Sekunden. Restbudget vor jedem Request prüfen; kein Versuch nach Frist. Pagination darf bereits erfasste Seiten nicht doppelt exportieren.

401/403, ungültige JSON-/Schemaantwort und falscher SHA sind harte Fehler ohne Wegretry. Kein Token/Header/URL-Secret loggen. Exportfehler bleibt ein echtes fehlgeschlagenes Gate, nicht success mit leeren Issues.

**Gate:** test_sonarcloud_export mit transient->success, ausgeschöpften Retries, zu langem Retry-After, 401 ohne Retry, invalid JSON, falscher Revision und zwei Seiten. Exakte Requestzahlen und fehlerfreier deduplizierter Export.

### 2. Gemeinsame adversariale Regressionen in CI verankern

Tests aus 001–007 und 009 vollständig registrieren. Contractfixtures für alle bestehenden und neu integrierten Profile enthalten dieselben Problemklassen: Batchreihenfolge, fehlende IDs, Partial Entry/Stop, sparse Cancel, verspätete Fills, Historiengrenzen, Modus, Leverage-Tier, Fundingfehler und Preisgrenzen. Produkt-/Modusumfang und sachlich belegte Nicht-Anwendbarkeit aus der Erweiterungsmatrix berücksichtigen; keine stillen Testausnahmen. Normale Unit-/CI-Läufe müssen Fake-only bleiben, auch wenn zufällig Credentials in der Umgebung existieren.

Cross-Layer-Sequenzen: Eintritt vorbereitet -> Kill-Fence -> möglicher Accept -> Cancel -> Partial-Fill -> Stop -> Recovery -> Abschluss; Inbox->Revisionwechsel->Crash->Retry; Backup->Restorefixture->planned-Recovery. Assertions auf tatsächliche persistierte Zustände und Anzahl/Identität externer Fake-Aufrufe, nicht nur Logtext.

**Gate:** alle lokalen/CI-Befehle oben mit vorgeschriebener Runtime grün; Coverageimporte auch für neue Module. Architektur-/Komplexitäts-/Mutation-Gates nicht umgehen. Fehlende oder übersprungene neue Tests blockieren Abnahme.

### 3. Provider-Abnahme separat maschinenprüfbar erfassen

Evidenzformat mit source SHA, CCXT-Version, Profilhash, Testnet-Environment/Host, nichtgeheimer Accountreferenz, Zeitpunkt, Testfällen, Resultaten, redigierten Request-/Response-Hashes, eigenen Order-IDs und Cleanup-Proof. Status implementationVerified / providerAcceptanceVerified getrennt.

Runner standardmäßig dry-run, ohne Netzwerk und ohne Secretzugriff. Echte Ausführung nur nach ausdrücklichem Auftrag und expliziter Testnet-Host-Allowlist, verifiziertem Konto/Modus, abgesprochenem maximalem Betrag, maximaler Orderzahl und Zeitbudget. Diese Werte sind Pflichtinputs, keine großzügigen Defaults. Eigentumsprüfung und eigenes Cleanupjournal Pflicht; unbekannte Orders nicht anfassen. Mainnet-/unklarer Host => vor erster Netzwerkmutation stoppen.

Erforderliche reale Nachweise pro freizugebendem Profil: Identität, echter Modus, Entry+Stop-Korrelation, Cancelterminalität, Partial-/Late-Fill-Behandlung soweit kontrolliert reproduzierbar, Gebühren/Funding, Preisbegrenzung und Tier-/Mengenrestriktionen. Nicht sicher reproduzierbare Fälle ausdrücklich NOT_PROVEN; Fake-Erfolg ersetzt das nicht. Ausgefallenes Testnet bleibt ausstehende Abnahme.

**Gate:** test_exchange_acceptance plus Python-Sicherheitsgates lehnen fehlende Limits, Mainnet, falschen SHA/Profilhash, fehlendes Cleanup und unvollständige Pflichtfälle ab. Ein synthetisches vollständiges Artefakt wird als Format akzeptiert, aber nicht als realer Providernachweis etikettiert.

### 4. Dokumentationskorrekturen und finale Releaseprüfung

P1-21 als bekannte API-Key-Bindungsgrenze dokumentieren. Bessere Rotation ist ein separates Vorhaben mit stabiler authentifizierter Account-ID/Subaccount-Abbildung und Migrationsfreigabe. Kein Umdeuten des bestehenden Fingerprints.

P1-19 nicht als „atomarer Snapshot repariert“ vermarkten; dokumentiert werden Erfassungsfenster, Vollständigkeit und Konfliktauflösung. P2-24: Integrität, Offsite und Restore-Eignung getrennt nennen. Status aller 64 Auditpositionen anhand neuer Tests/Belege aktualisieren; die ursprünglichen IDs erhalten.

Vor einer später genehmigten Releaseveröffentlichung: exakter Main-SHA grün in CI/Sonar, keine offenen Blocker/Critical und keine ungeprüften Security-Hotspots gemäß bestehender Policy; keine ungeklärten Kontozustände als Erfolg verschweigen. Providerfähigkeit ohne ausreichenden Nachweis nicht zusätzlich freischalten. Tatsächliche Testnet-/Rolloutausführung ist nicht Teil der aktuellen Planerstellung.

**Gate:** vollständige Abnahmeakte nennt SHA, CI-URL, Tests, Issues-/Hotspotexport, Migrations-/Restore-Drill und Providerstatus. Fehlende Evidence steht als ausstehend und verhindert die zugehörige Freigabe.

## Späterer Rollout, nur nach eigenem Auftrag

Verifiziertes kohärentes Backup erstellen, Zustand/Orders journalisieren, neue Entry-Ausführung über sicheren Fence/Drain anhalten. Telegram-Ingress/Outbox erhalten. DB und Executor/Core gemeinsam kompatibel migrieren; Recovery- und Schutz-Smokes ausführen. Erst dann Operatorfreigabe. Bei Problemen nicht alte DB blind über neu entstandene Exchangezustände zurückspielen; gesperrt bleiben und belegtes Recovery verwenden.

## Done / STOP / Wartung

Done (Code): Exportretry-/Acceptancevalidator-Tests und gesamter Qualitätslauf grün, Dokumentation korrekt. Done (Release): zusätzlich reale zutreffende Evidence, explizite Freigabe und exakter Revisionsnachweis. Diese Status niemals zusammenwerfen.

STOP: fehlende aktuelle Autorisierung für Testnet/Deployment, fehlende Pflichtlimits/Secrets, Providerstörung, ungeklärte Ownership, falscher Revisionsstand, Gate zweimal fehlgeschlagen. Nichts als erfolgreich markieren, was lediglich geplant oder mit Fakes getestet wurde.

Wartung: CCXT-/Profil-/Protokolländerung invalidiert relevante Providerabnahme; Artefakte versionieren. Sonar-Netzwerkretry darf keine fachlich fehlgeschlagene Qualitätsprüfung verdecken.
