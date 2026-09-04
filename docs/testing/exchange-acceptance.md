# Implementierung, Providerabnahme und Release getrennt prüfen

Stand: 2026-09-03. Diese Anleitung erteilt keine Freigabe für Testnet, Livehandel, Veröffentlichung oder Deployment.

## Aktueller Nachweisstatus

Die lokalen Tests verwenden ausschließlich synthetische Daten. `scripts/verify_exchange_acceptance.js` prüft Format, Bindung, Limits, Pflichtfälle und Cleanup einer vorgelegten Akte offline. Es lädt keine Kontozugangsdaten und kontaktiert keine Börse. Die früheren Sieben-Bool-Dateien bleiben als alte Datensätze auf Disk, genügen dem neuen lokalen Runtime-Vertrag aber nicht mehr.

**Lokaler Zwischenstand, nicht ausrollen:** Der unabhängige Reviewanker `exchange_executor/ccxt_implementation_reviews.py` ist noch leer. Damit zeigt diese Arbeitskopie die drei bestehenden Profile als `quarantined` und bietet keine freigegebenen Modi an. Konten, Trades und Server wurden nicht verändert. Erst tatsächliche gebundene Profilabnahme, unabhängiger Review und Root-Buildgate erlauben neue Pins; auch dadurch entsteht keine echte Providerabnahme.

## Implementierungs-Receipt v2 (009, noch ohne freigegebene Akte)

`ccxt_certification.py` akzeptiert ausschließlich einen exakten Bytehash aus dem festen, nicht automatisch befüllbaren Repository-Reviewanker. `ccxt_certification_evidence.py` prüft anschließend Schema, Exchange-/CCXT-/Profilbindung, vollständigen deklarierten linearen Perp-/One-way-/Cross-/Asset-/Modusscope sowie tatsächliche Sourcebytes. `profileHash` dieses Receipts ist der kanonische `asdict`-Ausführungsprofilhash; der vollständige `executorTreeHash` bindet zusätzlich die Bytes der ganzen Profildatei. Nicht mit dem unten beschriebenen Profilbytehash der Providerakte verwechseln.

- Executorbaum: alle tatsächlich vorhandenen Root-Pythondateien; nur die explizite Reviewanker-Datei ist zur Vermeidung einer zirkulären Hashdefinition ausgenommen.
- SDK-Baum: alle tatsächlich installierten CCXT-Pythondateien einschließlich statischer Abhängigkeiten, nicht nur der Versionsstring.
- Feste begrenzte Datei-/Baumgrößen, keine Symlinks/Reparsepoints/Hardlinks, Descriptor-/Änderungsprüfung; JSON-Duplikate und nichtendliche Werte werden abgewiesen.
- `sourceRevision` ist der im unabhängig gepinnten Receipt angegebene historische Ursprungscommit, nicht eine Behauptung über den aktuellen HEAD. Der Root-Gate verlangt einen lokal vorhandenen Vorfahren des aktuellen Checkouts und gibt beide Revisionen getrennt aus. Andernfalls würde schon der Commit des Receipts und seines Pins einen zirkulär unmöglichen HEAD-Nachweis verlangen. Der vollständige aktuelle `sourceTreeHash` und die Node-/Test-/Fixture-/Executor-/SDK-Bytehashes sind die eigentliche Sourcebindung; eine passende Herkunft allein reicht niemals.
- `parityEvidenceHash` und `executionReportHash` binden die zuvor tatsächlich geprüfte Akte und ihre Ausführung getrennt. Im Executor-Image fehlen Root-Nodequellen und Tests absichtlich. Die Runtime behauptet daher nicht, deren aktuelle Bytes selbst geprüft zu haben; dafür ist der Root-Buildgate verpflichtend.
- `providerAcceptanceVerified` muss in einer solchen Implementierungsakte **false** sein. Synthetische PASS-Berichte und Formaterfolg erzeugen weder Reviewpin noch Providerautorität.

Eine einzelne USDT-/Testnet-/ContractSize-1-Fixture deckt kein breiteres Profil ab. Resolverpräferenzen sind keine beobachteten Produktangebote: Bevor der vollständige deklarierte Scope gepinnt wird, muss jeder angebotene Slice tatsächlich belegt oder der Profilumfang bewusst enger abgegrenzt sein. Keine neue Sourcefreigabe aus einem passenden JSON allein. [Unabhängiger Bridge-Review](../../plans/009-CERTIFICATION-BRIDGE-REVIEW.md), [Inventur und offene Profile](ccxt-expansion-matrix.md).

### Root-Buildvergleich und CI-Anschluss

`scripts/verify_exchange_implementation.js --python <absoluter-Python-3.12-Pfad>` prüft den tatsächlichen vollständigen Checkout. Dateilisten, Trustroot, Imports und Prüfkommandos kommen ausschließlich aus festem Programmcode. Unversionierte neue Quelldateien zählen mit. Erzeugte Reports/Receipts und genau die unabhängige Approvaldatei sind aus dem Selbsthash ausgenommen; Validator, Runner, Tests, Fixtures und Build-/Dependencykonfiguration bleiben gebunden. Keine Befehle oder Freigabeparameter aus einem Artefakt werden ausgeführt.

Das Werkzeug ist **kein Testrunner und kein Pin-Generator**. Vergleichserfolg bedeutet nur, dass zuvor unabhängig genehmigte Receiptbytes zur aktuellen Source und zum geprüften Python-/SDK-Stand passen. `performedGateExecution` und `providerAcceptanceVerified` bleiben false. Der explizite Testvergleich meldet außerdem sämtliche Runtime-/Implementierungsfreigaben false. Echte Profilabnahmeakten und deren unabhängige Pins fehlen weiterhin; die produktive CLI muss aktuell No-Go liefern.

Der Containerjob in `quality.yml` hängt nun vom vollständigen `verify`-Job ab, lädt die vollständige Git-Historie und führt denselben Root-Gate vor dem Imagebau mit gesperrten Dependencyversionen aus. Es gibt keinen Fehler- oder Profilskip. Das Ergebnis wird als Containerprüfartefakt aufbewahrt. Dies ist der lokal implementierte Workflowanschluss, **kein ausgeführter erfolgreicher CI-Lauf**. Ein direkter, außerhalb dieses Workflows gestarteter `docker build exchange_executor` ersetzt diesen Root-Nachweis nicht.

Der vollständige positive CLI-Test verwendet ausschließlich ein eigenes temporäres Git-Repository, Testpins und eine bytegeprüfte, nicht hartverlinkte Kopie des installierten SDK. Negative Fälle zeigen zusätzlich: Node-Drift kann trotz gültigem Runtime-Receipt den Root-Gate sperren; ein falscher SDK-Hash sperrt beide Ebenen. Diese Testpins werden nicht in den wirklichen Reviewanker übernommen. Das lokale Entwicklungs-SDK hat derzeit Hardlinks (`nlink=4`); seine Installation erfüllt den strikten Runtime-Dateivertrag noch nicht. Ein grüner temporärer Test ist kein Nachweis einer bereits geeigneten Entwicklungs- oder Containerinstallation.

Der zusätzliche argumentlose `verify_implementation_runtime.py` prüft deshalb auch den **fertigen** Executor: Python-/CCXT-Version, nichtleeres vollständiges Profilinventar und für jedes Profil die tatsächliche `certification_result`-Prüfung. CI führt ihn unter dem zuvor geprüften Imagebenutzer 65532, mit `--network none --read-only` und ohne Quellmounts aus. Root-Sourceprüfung und Providerabnahme werden dadurch ausdrücklich nicht ersetzt. Reguläre pip-Extraktion kann unabhängige Dateien erzeugen; weder `--require-hashes` noch ein Versionsimport ist jedoch ein Beleg für den finalen Dateizustand. Ein entsprechender echter Image-/CI-Lauf bleibt ausstehend.

Die anschließende vollständige Python-Suite erhält nur ihre erforderlichen Test-/Werkzeug-/Originalfixturepfade schreibgeschützt. Produktive Executorquellen und Zertifikate bleiben die gebackenen Dateien. Negativtests verwenden ausdrücklich eigene leere oder ungültige Testfreigaben, damit spätere echte gültige Receipts die Tests nicht widersprüchlich machen.

`exchange_executor/tests/provider_acceptance_runner.py` ist derzeit **nur ein Offline-Preflight und ein getesteter Sicherheitsrahmen**, kein vollständiger echter Provider-Acceptance-Runner. Ohne Argumente meldet es `DRY_RUN`, null Netzwerkzugriffe und null Secretzugriffe. Selbst mit ausdrücklichem `--execute`, korrekter Autorisierung und gültigem Plan verweigert es die Ausführung, solange der überprüfte reale Transport fehlt. Es gibt weder einen versteckten SDK-Fallback noch eine Aktivierung über Umgebungsvariablen. Der fehlende reale Transport sowie die kontrollierten Börsen-Testsequenzen sind offene Implementierung, nicht bloß ausstehende Credentials.

Der Sicherheitsrahmen prüft vor der Vergabe einer Orderreservierung: exakte Version/Revision/Profilbindung, bekannte und zusätzlich explizit erlaubte Testnet-Origin, bestätigte Kontoidentität und `oneway`/`cross`, positive Notional-/Order-/Zeitlimits und ein erfolgreich geschriebenes Cleanupjournal. Unbewiesene fremde Order-IDs erhalten keine Cancel-Freigabe. Eine Reservierung vor unbekanntem Submit bleibt ungeklärt, bis die eigene Orderidentität belegt ist. Der Rahmen selbst sendet keine Orders. Sein injizierter Journal-Callback muss in einem späteren echten Runner dauerhaft schreiben; die Fake-Tests beweisen keine Festplatten-Durabilität.

## Evidenzformat, Version 1

Die vollständige Form wird durch `scripts/exchange_acceptance_contract.js` und die ausschließlich synthetischen Fixtures in `tests/test_exchange_acceptance.js` definiert. Unbekannte Felder werden abgewiesen, damit keine Rohantworten oder Credentials versehentlich in die Akte gelangen.

Pflichtdaten:

- `evidenceKind`: `synthetic` oder `provider`; `schemaVersion: 1`.
- `sourceSha`: exakter 40-stelliger Commit; `ccxtVersion: 4.5.75`; `exchange`: unveränderte bestehende Profil-ID.
- `profileHash`: SHA-256 der **exakten Bytes** von `exchange_executor/ccxt_profiles.py`. Damit invalidiert jede Änderung dieser Datei konservativ die Nachweise aller drei Profile. Abweichende Zeilenenden verändern ebenfalls den Hash.
- `environment: testnet`, exakte `host`-Origin und SHA-256 einer nichtgeheimen, fachlich stabilen Kontoreferenz (`accountReferenceHash`). API-Key oder Secret sind keine zulässigen Referenzwerte. Die spätere Laufzeit muss den Hash gegen authentifizierte Kontoevidenz prüfen.
- `accountMode`: belegtes `oneway`/`cross`, `verified: true`, redigierter Antwort-Hash.
- UTC-Start-/Endzeit; explizite `limits.maxNotionalUsd` als positiver Dezimalstring, `maxOrderCount` und `timeBudgetSeconds` als positive Ganzzahlen; dazu gemessene Nutzung in `observed`. Dezimalbeträge werden ohne Gleitkomma-Rundung verglichen.
- Alle Pflichtfälle mit `PASS`, `FAIL` oder `NOT_PROVEN`; jeder PASS besitzt mindestens ein Paar aus SHA-256 der bereits redigierten Anfrage und Antwort. Hashes sind keine vollständigen Ersatzbelege: die separat aufbewahrten redigierten Rohbelege müssen beim unabhängigen Review einsehbar sein.
- Eigene `ownedOrderIds` (mindestens Entry und Stop), vollständiges Cleanupjournal mit Hash, terminale eigene Order-IDs, keine offenen eigenen Orders, exakt null Restexposure und Hash des Positionsnachweises. Cleanup muss innerhalb des dokumentierten Erfassungsfensters abgeschlossen sein.

Pflichtfälle sind `accountIdentity`, `accountMode`, `entryStopCorrelation`, `cancelTerminality`, `partialFill`, `lateFill`, `feesFunding`, `priceBounds` und `leverageQuantityLimits`. Nicht sicher reproduzierbare Partial-/Late-Fills oder Fundingfälle sind ausdrücklich `NOT_PROVEN`, niemals aus Fake-Erfolg abgeleitet. Fehlende Fälle oder fehlendes Cleanup sind ungültige Akten. Ein vollständiges Format mit `NOT_PROVEN` bleibt ohne Providerfreigabe.

Die erlaubten Origins sind ausschließlich die offiziell beschriebenen Testumgebungen: [Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api), [Bybit](https://bybit-exchange.github.io/docs/v5/guide) und [Kraken Futures](https://support.kraken.com/en-de/articles/360024809011-api-testing-environment-derivatives). Der Aufrufer muss die passende Origin zusätzlich explizit erlauben. Subdomainsuffixe, andere Ports, Mainnet, URL-Credentials, Queryparameter und bloße `testnet: true`-Behauptungen erfüllen diesen Vergleich nicht.

## Offlineprüfung und unabhängige Freigabe

Nur die Form prüfen, mit einer vorhandenen redigierten Akte und deren tatsächlicher Revision:

```text
node scripts/verify_exchange_acceptance.js --evidence <akte.json> --source-sha <exakter-sha> --exchange bybit --allow-testnet-origin https://api-testnet.bybit.com
```

Der Profilhash wird dabei aus der lokalen Datei berechnet. Die Ausgabe enthält den `evidenceSha256`: SHA-256 von `JSON.stringify(parsedArtifact)` in UTF-8 (ohne Whitespace, aber mit vorhandener JSON-Feldreihenfolge). Dieser Digest identifiziert die zu prüfende Akte; ihn bloß abzuschreiben ist **keine unabhängige Abnahme**.

Für eine spätere Freigabeprüfung benötigt der Aufrufer zusätzlich `--require-provider` und `--approved-evidence-sha256 <separat-freigegebener-digest>`. Der zweite Wert darf ausschließlich aus einem tatsächlich autorisierten unabhängigen Review kommen, nicht aus einem Feld derselben Akte. Der Validator prüft die exakte Bindung, kann aber weder die Wahrheit einer Börsenantwort noch die Identität/Autorisierung des Reviewers aus JSON authentifizieren. Dafür bleibt der Freigabeprozess verantwortlich. Synthetische Akten bleiben auch mit einem passenden Reviewdigest abgewiesen.

`implementationVerified` wird nicht aus der Providerakte abgeleitet; dieser Validator lässt es auch bei übergebener Behauptung `false`. Eine spätere feste Integration muss den getrennten tatsächlichen Implementierungsnachweis eigenständig prüfen. Ein erfolgreicher Providercheck ersetzt niemals CI, Sonar, Migrations-/Restore-Drill oder Releasefreigabe.

## Sonar- und Releaseakte

Der Sonar-Export ist ausschließlich lesend. Jede Anfrage erhält höchstens drei Versuche bei Netzwerkfehlern, Timeout, 429 oder 502/503/504. Kurze exponentielle Wartezeiten, begrenzter Jitter und `Retry-After` teilen sich ein **60-Sekunden-Budget für den gesamten Abruf**. Einzelrequests erhalten höchstens 30 Sekunden beziehungsweise das Restbudget. Nach Frist beginnt kein neuer Request. 401/403, ungültiges JSON/Schema, doppelte oder unvollständige Pagination und falsche Revision scheitern hart.

`reports/sonarcloud/` enthält `issues.json`, `hotspots.json`, vollständige `issues.tsv`/`hotspots.tsv` sowie die Gate-Ansichten `open-issues.tsv` und `to-review-hotspots.tsv`. Unaufgelöste und aufgelöste Issues sowie `TO_REVIEW` und `REVIEWED` werden ausdrücklich separat paginiert. Die JSON-Dateien enthalten die vollständigen gelieferten Suchdatensätze; Detail-/Kommentar-Endpunkte werden nicht zusätzlich abgefragt. Ein API-Limit, das einen vollständigen Abruf verhindert, bleibt ein Fehler.

`summary.json` ist der letzte Erfolgsmarker mit Statuspartitionen, exakter Analyse-/Revisionsbindung und SHA-256/Dateigrößen aller sechs Artefakte. Der alte Marker wird vor einem neuen Abruf entfernt; Fehler hinterlassen damit keinen aktuellen Erfolgsmarker. Der Export prüft die neueste Analyse vor und nach dem Erfassen und bindet das Qualitätsgate an deren Analyse-ID. Das ist ein **Erfassungsfenster mit Stabilitätsprüfung, kein atomarer serverseitiger Snapshot**: gleichzeitige manuelle Änderungen an Findings können damit nicht vollständig ausgeschlossen werden.

`node scripts/verify_sonar_evidence.js` verlangt in CI: exaktes erwartetes `main`, richtigen Compute-Task, vollständige konsistente Artefakte, Quality Gate `OK`, null ungeprüfte Hotspots und null Blocker/Critical. Die neue Impact-Darstellung `HIGH`/`BLOCKER` wird konservativ ebenfalls blockiert. Ein gescheiterter Scanner bleibt unabhängig vom Export ein gescheiterter CI-Schritt. Token, Authorization-Header und URL-Secrets aus Transport-/Compute-Task-Fehlern werden nicht ausgegeben. Exportartefakte und Akten gehören in den vorgesehenen zugriffsbeschränkten Evidenzspeicher, nicht in öffentliche Logs.

Vor **jeder separat autorisierten Veröffentlichung** muss die Akte zusätzlich enthalten:

1. Exakten finalen Main-SHA und den tatsächlich grünen Quality-OS-/Sonar-Lauf mit CI-URL für genau diesen Stand; lokaler Dirty-Worktree ist kein solcher Nachweis.
2. Vollständige lokale/CI-Test-, Coverage-, Architektur-, Komplexitäts-, Mutations-, Browser-, Build- und Sicherheitsnachweise ohne abgeschwächte Budgets oder ausgelassene neue Tests.
3. Die geprüften Sonar-Dateien, Migration-/Restore-Drill und aktuelle Klarheit über alle offenen Konto-/Orderzustände; kein ungeklärter Zustand darf als Erfolg verschwinden.
4. Getrennten Providerstatus je relevantem Profil, vollständige echte redigierte Belege und unabhängige Freigabe; fehlende Abnahme verhindert die zugehörige Providerfreigabe.
5. Gültige ausdrückliche Release-/Rolloutautorisierung und einen zuständigen Operator.

Diese Arbeit erstellt keine Releaseveröffentlichung, keine neue Providerfreischaltung und keinen Deployment-Workflow. Fehlende reale Nachweise bleiben **ausstehend / NO-GO für die zugehörige Freigabe**. Der Umsetzungsstand aller Auditpakete wird gesondert in den Planunterlagen geführt.

## Beibehaltene Sicherheitsgrenzen

P1-21: Bybit und Kraken Futures bleiben an ihre bestehende API-Key-basierte Identitätsstrategie gebunden. Schlüsselrotation darf nicht durch Abschalten der Accountprüfung „repariert“ werden. Eine bessere Rotation benötigt eine eigene stabile authentifizierte Account-/Subaccount-ID, belegte Migration und Freigabe.

P1-19: Mehrere REST-Abrufe werden nicht nachträglich atomar. Zu dokumentieren sind Erfassungsfenster, Quellen, Vollständigkeit und Konfliktauflösung. P2-24: Backupintegrität, tatsächlich vorhandene Offsite-Kopie und gemessene Restore-Eignung sind drei verschiedene Belege. Keiner ersetzt die anderen.
