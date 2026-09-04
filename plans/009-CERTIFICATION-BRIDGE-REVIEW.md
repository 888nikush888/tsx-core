# 009.4: Minimale Brücke zwischen Implementierungsevidenz und Runtime-Zertifizierung

Stand: 2026-09-03. Read-only-Prüfung der lokalen Arbeitskopie auf Basis von `f8089277d0667dd45bcf070037800d423fd89254` einschließlich der vorhandenen uncommitteten Reparaturen. Dies ist ein eng begrenzter Umsetzungsvorschlag, keine Implementierung, Providerabnahme oder Deploymentfreigabe. In diesem Teilauftrag wurde ausschließlich diese Datei neu angelegt. Der Hauptagent pflegt den gemeinsamen Status.

## Entscheidung

Die kleinste sinnvolle Brücke ist eine **im vertrauenswürdigen Repository-Code festgelegte Review-Allowlist `exchange -> erwarteter Receipt-SHA256`**, kombiniert mit:

1. tatsächlicher lokaler Gateausführung gegen unabhängig ausgewählte Repository-Dateien;
2. anschließendem, unabhängigem Review des exakten Receipt-Inhalts und expliziter Aufnahme seines Hashes in die Allowlist;
3. Python-Prüfung des gepinnten Receipts und der tatsächlich vorhandenen Runtime-, Profil- und SDK-Bytes;
4. einem verpflichtenden Root-Buildgate für Node-Quellen, Tests und Fixtures, die das Executor-Image nicht enthält.

Das benötigt keine Signaturdienste, Schlüsselverwaltung oder neue externe Vertrauensinstanz. Die Vertrauensgrenze bleibt dieselbe wie bei einer geprüften Änderung an `PROFILES` oder am Validator selbst: überprüfter Repository-/Buildcode. Ein selbst behaupteter PASS-Bericht oder ein vom selben untrusted Artefakt mitgelieferter „erwarteter Hash“ ist dagegen keine Freigabe.

Die drei bestehenden Profile erhalten **keinen Legacy-Bypass**. Ihre bisherigen Sieben-Bool-Dateien werden mit dem neuen Vertrag `quarantined`, bis derselbe neue Nachweis tatsächlich vorliegt. Das ist kein Auftrag zum Abschalten laufender Konten: Ein solcher Zwischenstand darf nicht als betriebsfähiger Cutover aller drei Profile ausgegeben oder ungefragt ausgerollt werden.

## 1. Belegter aktueller Pfad

| Stelle | Tatsächliche Aussage |
|---|---|
| `scripts/verify_exchange_acceptance.js:193`, `verifyExchangeImplementation` | Liest und bindet Daten, führt keine referenzierten Tests aus. `implementationVerified` bleibt auch mit gültiger Reviewreferenz ausdrücklich `false`. |
| `scripts/verify_exchange_acceptance.js:97`, `verifiedFiles` | Prüft gegen unabhängig übergebene Dateilisten echte Bytehashes, vollständige Mengen, reguläre Dateien, Pfadbindung und Grenzen. |
| `scripts/verify_exchange_acceptance.js:118`, `validateFixtureReferences` | Die benannten Quellen-/Testsymbole werden mittels Textvorkommen geprüft. Das ist kein Beleg, dass eine Testfunktion ausgeführt wurde. |
| `scripts/verify_exchange_acceptance.js:177`, `reviewBinding` | Die separat erwartete Reviewdatei muss exakt dieselbe Evidenz und Inventare referenzieren. Auch dieser Hashabgleich erteilt allein keine Autorität. |
| `scripts/exchange_acceptance_contract.js:13` | Zehn Paritätsklassen mit verpflichtenden normalen und adversarialen Nachweisen. Der Vertrag ist bereits dynamisch bezüglich der Exchange-ID. |
| `tests/test_exchange_profile_parity.js:41`, `contextFixture` | Schreibt absichtlich `cases.js` mit `throw new Error("MUST NOT EXECUTE")`; der vollständige Formatnachweis besteht trotzdem korrekt. Die „bestehenden Profile“ in dieser Testdatei verwenden dieselbe synthetische Validatorfixture, keine vollständige reale TSX-Profilabnahme. |
| `exchange_executor/ccxt_certification.py:27`, `certification_result` | Akzeptiert bisher ausschließlich Exchange, Status, CCXT-Version, Profilversion und sieben `True`-Flags. Keine Source-, Profilbyte-, SDK-, Test- oder Reviewhashbindung. |
| `exchange_executor/ccxt_registry.py:132`, `_initial_status` | Nach Capability-/Profilvorprüfung führt ein positives `certification_result` zu `certified`; nur dann werden die Profilmodi angeboten. |
| `exchange_executor/ccxt_client.py:183`, `_account_locked` | Verlangt tatsächlich `descriptor.status == certified`, bevor Credentials geladen und Clients verwendet werden. Der Zertifizierungsstatus ist produktiv wirksam, nicht bloß Anzeige. |
| `tests/test_supply_chain.js:185` | Verlangt bisher für alle drei JSON-Dateien gerade die sieben Wahrheitswerte. Dieser Test muss beim Vertragswechsel mit geändert werden, nicht als Nachweis des neuen Standards weitergelten. |

Die bestehenden Registrytests prüfen Discovery ohne Netzwerk, drei alte zertifizierte Profile, CCXT-Versionsdrift, Deprecated und einen nicht zertifizierenden öffentlichen Probe. Sie beweisen noch keine gemeinsame Source-/Testhashbindung oder echte Gateausführung für einen neuen Receipt.

## 2. Docker: Welche Prüfung ist wo überhaupt möglich?

Aktuelle, direkt gelesene Grenzen:

- `docker-compose.yml:80`: Executor-Buildcontext ist `./exchange_executor`.
- `exchange_executor/.dockerignore:3`: `tests` werden bereits aus diesem Context ausgeschlossen; ebenfalls Reports und Python-Cachedateien.
- `exchange_executor/Dockerfile:7`: Nur der Dependency-Lock wird zum Installationsschritt kopiert.
- `exchange_executor/Dockerfile:26–27`: Runtime enthält die Root-`*.py` und `certifications`, nicht Node, Root-`src`, Testdateien oder Dokumente. Runtime-Dateien sind root-owned; der Prozess läuft als UID/GID 65532. Compose setzt `read_only: true`.
- `.github/workflows/quality.yml:318`: Der Containerjob hat aktuell kein `needs: verify`. Er baut den Executor in Zeile 335 direkt aus dessen Unterverzeichnis.
- Erst **nach** dem Imagebau mountet Zeile 359 Python-Tests schreibgeschützt nach `/app/tests` und führt sie aus. Das ist ein zusätzlicher Testlauf, keine vor dem Build verifizierte Node-/Fixture-Provenienz.

Konsequenz: Bei unverändertem Executor-Context kann Python im Image unmöglich die aktuellen Bytes von `src/trading_engine.ts` oder `tests/test_exchange_profile_parity.js` prüfen. Ein Receipt darf dort nur deren unabhängig geprüfte Buildbindung dokumentieren. Das Fehlen dieser Dateien ist im Runtime-Modus erwartbar, im Root-Buildgate hingegen ein Fehler.

**Minimaler Buildanschluss:** Vor einem als verifiziert verwendeten Executor-Build im vollständigen Root-Checkout das neue Buildgate verpflichtend ausführen. Es prüft den unabhängig gepinnten Receipt gegen die aktuellen Root-Dateien. Der Containerjob muss von diesem erfolgreichen Nachweis für exakt denselben Source-/Inputstand abhängen oder das Gate selbst mit den gepinnten lokalen Runtimes ausführen. Ein bloßes `needs: verify` ohne Receipt-/Inputabgleich genügt nicht. Kein beliebiges heruntergeladenes JSON als erfolgreiche Gateausführung akzeptieren.

Ein direkter `docker build exchange_executor` kann weiterhin ein Image bauen, aber **nicht selbst die fehlenden Root-Dateien neu verifizieren**. Solange dieser direkte Weg unverändert existiert, darf seine Runtime-Zertifizierung nicht als unabhängiger vollständiger Buildnachweis bezeichnet werden. Falls später verlangt wird, dass jeder direkte Docker-Build Root-Testdrift selbst abweist, ist eine zusätzliche Context-/Buildstage-Änderung erforderlich. Diese stärkere Eigenschaft ist mit dem heutigen Unterverzeichnis-Context nicht implementierbar.

## 3. Verträge und minimale Dateien

### 3.1 Unabhängiger Reviewanker

Neue kleine Datei, vorgeschlagener Name: `exchange_executor/ccxt_certification_reviews.py`.

```python
# Trusted, explicitly reviewed repository policy; never populated from a receipt.
REVIEWED_IMPLEMENTATIONS: dict[str, str] = {
    # exchange id: SHA-256 of the exact reviewed runtime receipt bytes
}
```

- Keine automatisch generierten `True`-Einträge, keine drei eingebauten Ausnahmen und kein Ableiten aus `PROFILES`.
- Der normale Prüf-/Receipt-Runner darf diese Datei **nicht** aktualisieren. Er liefert einen Kandidaten und dessen Hash für den unabhängigen Review.
- `certifications_directory` darf Testdaten umleiten, aber nicht zugleich den vertrauenswürdigen Reviewanker bestimmen. Produktiv keine Request-, Environment- oder JSON-Option zum Umleiten des Ankers.
- Ein Test darf den erwarteten Kontext ausdrücklich über eine interne Test-Schnittstelle injizieren; dieser Weg darf nicht als öffentlicher Runtime-Bypass auftauchen.
- Die Review-Allowlist ist selbst Teil der vertrauten Policy, nicht Bestandteil des Receipts, dessen Hash sie enthält. Sonst entsteht ein zirkulärer Hash. Auch erzeugte Receipts gehören nicht zu ihren eigenen Hashinputs. **Validator, Registry, Gatecode und übriger Sharedcode bleiben dagegen vollständig gebunden.**
- Ein altes, exakt bereits akzeptiertes Receipt kann bei identischen Inputs wiederverwendet werden. Ein beliebiger neuer Receipt mit selbst aktualisierten Sourcehashes darf nicht durch den alten Reviewanker passieren.

### 3.2 Runtime-Receipt v2

`exchange_executor/certifications/<exchange>.json` wird ein streng begrenzter, exact-key Datenvertrag. Die endgültigen Feldnamen dürfen bei Implementierung angepasst werden; die folgenden Bindungen dürfen nicht fehlen:

| Bereich | Inhalt und Prüfung |
|---|---|
| Version/Art | Neue Schemaversion, eindeutige Art `tsx-implementation-review`; alte Sieben-Bool-Form wird abgewiesen. Keine Providerfreigabe aus diesem Typ. |
| Binding | Exchange-ID, CCXT-Version, Profilversion, exakte Profilbytehashbindung sowie expliziter Produkt-/Modusumfang. Erwarteter Umfang kommt aus der geprüften Policy, nicht allein aus dem Receipt. |
| Eingabestand | Provenienz-SHA und Hash des tatsächlichen, sortierten Datei-/Byteinventars. Ein HEAD-SHA allein identifiziert den hier vorhandenen dirty Worktree nicht. |
| Runtime-Inventar | Pfad/Bytehash aller relevanten Executor-Quelldateien einschließlich gemeinsamem Adapter, Current-State, History, Identity, Funding, FX, Constraints, Registry und Validator. Eine neu hinzugefügte Shareddatei darf nicht unbeachtet bleiben. |
| SDK-Inventar | Tatsächliche installierte CCXT-Quelldateien oder ein unabhängig festgelegtes vollständiges Dependency-Inventar; Pfad-/Bytehashbindung zusätzlich zum Versionsstring. |
| Build-Inventar | Root-Node-Quellen, ausgeführte Tests, deren Fixtures, Runner/Registry, Gatecode und relevante Config-/Dependencylocks. Runtime prüft dessen Commitments; Root-Buildgate prüft die vorhandenen Bytes. |
| Paritätsevidenz | Hash der von `verifyExchangeImplementation` geprüften Akte und ihrer separat gebundenen Reviewreferenz; vollständige normale/adversariale Matrix. |
| Ausführung | Tatsächlich beobachtete Gate-IDs, Runtimeversionen, Start/Ende, terminale Ergebnisse und ausgeführte Testdateien beziehungsweise echte Test-IDs. Keine vom Eingangsdokument übernommenen PASS-Flags. |

Wichtige Namensraumgrenze: `execution_constraints.profile_hash(profile)` hasht kanonisches `asdict(profile)`; die vorhandene Acceptance-`profileHash` ist der Hash der **ganzen Datei** `ccxt_profiles.py`. Das sind unterschiedliche Werte. Getrennt benennen beziehungsweise speichern, nicht einen mit dem anderen vergleichen. Der vollständige Bytehash bindet zusätzlich deklarierte und zukünftige Felder.

Pfad-/Datenvalidierung übernimmt den bestehenden strikten Standard: begrenzte Größen und Anzahlen, sichere relative Pfade, keine Traversierung/ADS/absoluten Pfade, keine Symlinks oder überraschenden Dateitypen, keine Duplikate, strikt typisierte Integer statt Python-`True == 1`, keine unbekannten Felder. JSON-Duplikatschlüssel bei der Python-Einlesung ablehnen. Hashes sind lowercase Hex mit exakt 64 Zeichen. Fehlende Daten bleiben ein konkreter Ablehnungsgrund.

Ein produktives Profil ist breiter als eine einzelne synthetische `contractSize='1'`-Fixture. Ein belegter USDT-/Testnet-Slice erlaubt weder automatisch USDC, inverse Produkte noch Live. Die bestehende `productScope`-Form beschreibt einen einzelnen Slice; mehrere notwendige Slices brauchen getrennte gebundene Akten oder eine ausdrücklich geprüfte Scope-Liste. Keine Scope-Ausweitung allein durch neue JSON-Felder.

### 3.3 Lokaler Gate-Runner und Root-Buildgate

Neue Datei, vorgeschlagener Name: `scripts/verify_exchange_implementation.js`. Den vorhandenen Formatprüfer nicht in einen Artefakt-Codeausführer verwandeln.

Zwei logisch getrennte Wege:

1. **Ausführen und Kandidat erstellen:** Unabhängig festgelegte Datei-/Gatepolicy laden, vollständige Evidenz mittels bestehendem Validator prüfen, tatsächlich ausgewählte lokale Gates starten, Resultate selbst beobachten, identische Inputs danach erneut nachweisen, erst dann einen Kandidaten ausgeben. Kein automatischer Allowlist-Eintrag.
2. **Build prüfen:** Bereits unabhängig gepinnten Receipt gegen aktuellen vollständigen Checkout, Test-/Fixture-/Runnerinventar und Dependencylocks prüfen. Dieser Weg beweist Übereinstimmung mit einer früher wirklich ausgeführten und akzeptierten Prüfung; er behauptet keinen neuen Testlauf.

Der Runner übernimmt niemals Shellkommandos, Environment-Overrides, Importpfade oder `expected`-Dateilisten aus untrusted Evidenz. Er verwendet feste beziehungsweise code-reviewte Gate-IDs, `shell:false`, bekannte Runtimes und bestehende Testbudgets. Unbekannte Profil-/Scope-/Gate-IDs werden abgewiesen. Das Artefakt darf weder einen Test überspringen noch einen alternativen „erfolgreichen“ Runner bestimmen.

Die tatsächlichen Gates aus 009 bleiben erhalten: vollständige Python-Suite, Profil-/Paritätsregressionen, Typecheck, Ruff, Architektur und Complexity; weitere in der Akte referenzierte Node-Tests müssen ebenfalls wirklich ausgeführt werden. Shared-Contractänderungen regressieren alle bereits integrierten Profile. Die spätere komplette 008-Abnahme einschließlich Coverage/Mutation/Build/Sonar bleibt separat und wird nicht durch diesen Receipt ersetzt.

Bei Node-Skripttests ist aktuell vor allem der Dateiprozess terminal beobachtbar. Das Receipt muss diese Granularität ehrlich angeben. `testReference.name` plus Textvorkommen darf nicht als einzeln ausgeführte Assertion ausgegeben werden. Wenn eine konkrete Pflichtklasse einzelne Test-IDs verlangt, braucht der betreffende vertrauenswürdige Testtreiber eine wirkliche Ausführungszuordnung. Nicht einfach vorhandene Namen in einen PASS-Report kopieren.

Die Format-Selbsttests mit `MUST NOT EXECUTE` bleiben unverändert Format-Selbsttests. Eine vollständige Akte mit diesen künstlichen Quellen darf keine produktive Profilfreigabe bekommen. Die produktspezifische Reviewpolicy muss tatsächliche TSX-/SDK-Fakes und relevante gemeinsame Regressionen referenzieren.

Drift vor, während oder nach den Gates macht den Kandidaten ungültig. Am sichersten laufen Gates und spätere Verpackung gegen dieselbe explizit abgegrenzte temporäre Eingabekopie; mindestens ist ein vollständiger Vorher-/Nachher-Hashabgleich erforderlich. Neue, fehlende und umbenannte Dateien im unabhängig bestimmten Inventar zählen als Drift. Ein Test darf nicht seine eigene erwartete Quellliste verkleinern. Erzeugte Reports, Coverage, Cachedateien und Receipts bleiben außerhalb des Eingabeinventars.

### 3.4 Python und Katalog

`ccxt_certification.py` prüft in dieser Reihenfolge:

1. Exchange-ID/Profil bekannt, unabhängiger Reviewpin vorhanden;
2. begrenzte Receipt-Datei lesen und **exakten Bytehash** mit dem Reviewpin vergleichen;
3. Schema, Scope, Versionen und vollständige bindende Inventare prüfen;
4. aktuelle Runtime-/Profil-/SDK-Bytes prüfen;
5. erst danach positives `CertificationResult` mit nachgewiesenem Implementierungsstatus liefern.

Der Reviewpin ersetzt nicht die letzte Driftprüfung. Sonst bliebe ein altes korrekt gepinntes Receipt nach Änderung von `ccxt_adapter.py` gültig. Umgekehrt ersetzen neu passende Sourcehashes nicht den unabhängigen Pin.

Für eine erste konservative Implementierung ist das Inventar aller produktiven Root-`*.py` des Executors einfacher und sicherer als eine manuell verkleinerte transitive Closure. Nur die ausdrücklich definierte Reviewanker-Datei wird als Trustroot separat behandelt. SDK-seitig enthalten die hier installierten CCXT-4.5.75-Quellen 829 Pythondateien mit insgesamt 37.648.687 Bytes. Ein vollständiger streamingbasierter Bytehash ist lokal möglich; nicht pro Katalogeintrag oder Order erneut den gesamten SDK-Baum lesen. Hashprüfung pro immutable Runtime-Generation amortisieren. Keine neue Latenzschleife auf dem Orderpfad.

Der heutige Registry-Konstruktor entdeckt Deskriptoren einmal. Eine Startup-Prüfung reicht für das unveränderliche, read-only Image; sie ist keine Behauptung, beliebige nachträgliche In-place-Manipulationen an einem laufenden Pythonprozess zu erkennen. Tests müssen mindestens neuen Registry-Start nach Dateidrift prüfen. Für später unterstützte mutable Runtimequellen wäre eine explizite Invalidierungsregel nötig, nicht stilles Wiederverwenden des Startup-Ergebnisses.

`ccxt_registry.py` leitet `certified` ausschließlich aus dem neuen Resultat ab; alle bisherigen Capability-/Credential-/Profilvorbedingungen bleiben. Fehlender/ungültiger Nachweis ergibt `quarantined` und keine freigegebenen Modi, nicht `candidate` mit Freigabe. Öffentliche Marktabfragen bleiben unfähig, eine Zertifizierung herzustellen.

Wenn der neue Status bis in den bestehenden Node-Katalog transportiert werden soll, passen flache Zusatzwerte wie `implementationVerified`, `implementationEvidenceSha256` und `providerAcceptanceVerified:false` in den schon vorhandenen `capabilities`-Vertrag (`src/exchange_catalog.ts:81`). Keine verschachtelte Evidence ungeprüft in diesen Scalar-Vertrag stecken. Ein eigener detaillierter DTO wäre eine zusätzliche, gesondert abzustimmende Änderung. Status und Provenienz müssen jedenfalls getrennt bleiben; ein Runtimeprofil ist niemals dadurch ein verifiziertes Benutzerkonto.

## 4. Notwendiger enger Dateiumfang bei Umsetzung

- Neu: `scripts/verify_exchange_implementation.js` für unabhängige Ausführung/Buildprüfung und Kandidatenerzeugung.
- Neu: `exchange_executor/ccxt_certification_reviews.py` als expliziter, nicht automatisch veränderter Reviewanker.
- Ändern: `exchange_executor/ccxt_certification.py`, `ccxt_registry.py` und später die konkret akzeptierten `certifications/*.json`.
- Neu: `tests/test_exchange_implementation_bridge.js` und `exchange_executor/tests/test_certification.py`; Registrierung der Node-Datei in `tests/run_all.js`.
- Eng aktualisieren: `tests/test_supply_chain.js`, `exchange_executor/tests/test_phase2_registry.py`, gegebenenfalls bestehende Katalogtests für zusätzliche reine Statusfelder. Bestehende Format- und Provider-Acceptance-Gegenproben erhalten.
- Buildanschluss: `.github/workflows/quality.yml` und gegebenenfalls ein expliziter Package-/Makefile-Einstieg für denselben lokalen Root-Buildgate. Wenn der Executor-Context unverändert bleibt, keine Tests/Node ins Runtime-Image kopieren.
- Dokumentation: `docs/testing/exchange-acceptance.md`, ADR 0012 und 009-Matrix müssen den neuen Implementierungsstatus und weiterhin ausstehende Providerabnahme korrekt benennen.

Nicht erforderlich: Datenbankmigration, neue Credentialform, Signatur-/PKI-Infrastruktur, Providerrequests, SDK-Upgrade, Order-/Lifecycleumbau oder automatische Profil-/Kontofreischaltung. Kein Grund, vorhandene Test-/Coverage-/Zeitgrenzen zu senken.

## 5. Konkrete normale und adversariale Regressionen

Vor Produktionsänderung zunächst mindestens die bislang akzeptierte Sieben-Bool-Datei und passenden Receipt mit driftenden Sharedbytes rot reproduzieren. Alle Fixturebäume in eigenen temporären Verzeichnissen; kein echtes Repositoryfile für Driftproben überschreiben.

| Fall | Erwartetes Ergebnis |
|---|---|
| Richtige unabhängige Policy, tatsächliche positive lokale Testprozesse, vollständige normale/adversariale Profilmatrix, identische Inputs | Kandidat entsteht; **ohne** Reviewpin noch keine Runtime-Zertifizierung. |
| Derselbe Kandidat nach explizitem unabhängigen Reviewpin, passende Runtime-/SDK-Dateien | `implementationVerified=true`, `providerAcceptanceVerified=false`; zulässiger Scope unverändert. Für alle drei Bestandsprofile nach demselben Verfahren parametrisieren. |
| Alte sieben `True`-Flags, kopierter Formatresultat-JSON oder selbst behauptetes `implementationVerified:true` | `quarantined`; kein Legacy-Fallback. |
| Vollständige Formatfixture mit künstlichem `MUST NOT EXECUTE`-Test | Formatcheck bleibt erfolgreich und nicht ausführend; unabhängige produktive Testpolicy verweigert diese Quelle als Profilabnahme. |
| Artefakt enthält Shell-/Importkommando, andere Testpfade oder einen selbst mitgelieferten Approvalhash | Keine Ausführung dieses Inhalts; Kandidat/Build abgewiesen. Sentineldatei bleibt unberührt. |
| Echter Testprozess schreibt PASS und beendet sich mit Exit 1; Prozess startet nicht, wird abgebrochen oder erreicht Timeout | Kein Kandidat; vorhandener Reviewpin wird nicht verändert. Keine Wiederverwendung eines früheren Ergebnisses als aktueller Erfolg. |
| Erfolgreicher Prozess, aber erwartetes Testfile oder erforderliche Testzuordnung fehlt | Kein vollständiger Ausführungsnachweis. Ausgelassene Assertions nicht durch Format-PASS ersetzen. |
| Nur `ccxt_profiles.py`-Bytes geändert, Profilversion bleibt 1 | Runtime ungültig. Zusätzlich strukturierter `executionProfileHash` darf nicht versehentlich an Stelle des Bytehashs genügen. |
| Shared-Python-Helfer geändert, neu angelegt oder entfernt | Alle davon über das gemeinsame Inventar betroffenen Receipts ungültig, auch wenn die individuelle Profildatei unverändert ist. |
| Installierte CCXT-Version geändert oder SDK-Datei bei unverändertem `4.5.75` gepatcht | Runtime ungültig. Test mit temporärem SDK-Baum, nicht mit veränderter installierter SDK. |
| Nur Node-Quelle, registriertes Testfile, Fixture, Testrunner oder Lockfile geändert | Root-Buildgate ungültig; Runtime darf nicht vortäuschen, diese dort fehlenden Dateien neu gelesen zu haben. |
| Artefakt plus seine eigenen Hashangaben passend gefälscht | Unveränderter unabhängiger Reviewpin weist es ab. Prüfung darf den erwarteten Hash nicht aus diesem Artefakt beziehen. |
| Datei mutiert während des Gateablaufs oder zwischen Prüfung und Verpackung | Kein erfolgreiches Buildhandoff für abweichende Bytes. |
| Fremde Exchange, anderer Modus/Settlement/ContractSize/Produkttyp, Scope nur teilweise belegt | Keine Ausweitung des zertifizierten Scopes; fehlende notwendige Slices bleiben unbewiesen. |
| Symlink/Traversal/ADS, doppelte Pfade oder JSON-Schlüssel, Boolean als Integer, übergroßes Dokument | Begrenzte, secrets-freie Ablehnung; keine Fremddatei lesen. |
| Runtime-Fixture enthält nur produktive Pythondateien, SDK und akzeptiertes Receipt/Reviewanker, keine Tests/docs/Node | Runtime-Nachweis funktioniert ohne Netzwerk/Subprozess; Buildmodus gegen denselben unvollständigen Baum muss dagegen scheitern. |
| Neue Registry nach Source-/Receipt-Drift und öffentlicher Probe danach | `quarantined` bleibt gesperrt; Probe kann den Reviewpin nicht ersetzen. |
| Synthetic- oder lokale Gate-Erfolge mit kopiertem Provider-PASS | Weiterhin keine Providerabnahme. Bestehende separat autorisierte Providerprüfung bleibt unabhängig. |

Test-Bootstrap bewusst lösen: Die Unit-Tests des neuen Zertifizierungsvertrags verwenden einen temporären **explizit injizierten** Reviewkontext. Sie dürfen nicht davon abhängen, dass die gerade erst zu erzeugende produktive Akte bereits gepinnt ist. Die heutige Assertion „alle drei alten JSONs sind zertifiziert“ wird entsprechend auf echte neue Fixtures beziehungsweise einen gesonderten Nach-Review-Buildtest umgestellt. Keine Environmentvariable zum pauschalen Freischalten der Produktion einführen und keine selbstreferenzielle Receipt-Erzeugung durch Tests.

## 6. In diesem Review wirklich ausgeführte Nachweise

Arbeitsverzeichnis jeweils `C:/Users/nikla/Desktop/tsx-core`:

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' tests/run_all.js test_exchange_profile_parity.js test_exchange_acceptance.js
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe' -B -m unittest discover -s exchange_executor/tests -p test_phase2_registry.py
```

Ergebnis am 2026-09-03: beide Node-Testdateien grün; zehn Python-Registry-/Resolver-/Credentialtests grün. Keine schweren Gesamt-/Coverage-/Dockerläufe und keine Netzwerk-/Provider-/Kontozugriffe. Die SDK-Dateizählung war ausschließlich lokales Lesen der installierten 4.5.75-Dateien.

Diese grünen Tests bestätigen den **aktuellen** begrenzten Vertrag. Die oben vorgeschlagenen neuen Bridge-/Drift-/Ausführungsregressionen wurden nicht implementiert oder als bereits grün ausgegeben.

## Abschluss- und STOP-Grenzen

Die Brücke ist erst vollständig, wenn ein wirklich ausgeführter, unabhängig gepinnter Nachweis durch Runtime **und** verpflichtenden Root-Buildgate bis zum Katalog verfolgt werden kann, während Manipulation/Drift reproduzierbar sperrt. Leere Review-Allowlist plus korrekt quarantinierte Altdateien ist ein sicherer Implementierungszwischenstand, nicht der Abschluss sämtlicher Bestandsprofilabnahmen.

Stoppen und Hauptagenten informieren, wenn zur Scopefreigabe nur ein Flag/Formatnachweis vorhanden ist, wenn ein erforderlicher echter Profilfall weiterhin `not_proven` ist, wenn der geplante Buildweg keinen vollständigen Root-Dateistand sehen kann oder wenn eine Änderung am Reviewanker automatisch aus dem untrusted Artefakt abgeleitet werden soll. Keine bekannten Schutz-/Produktgrenzen durch diese Zertifizierungsbrücke aufheben.
