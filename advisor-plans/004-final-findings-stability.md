# Plan 004: Codacy, DeepSource und Sonar stabil abschließen

> **Änderung am 24.09.2026:** Auf Betreiberwunsch wird Snyk als aktive GitHub-/CI-Integration entfernt. Die unten stehenden älteren Snyk-Anweisungen beschreiben den damaligen Plan und gelten nicht mehr als Freigabekriterium. Frühere Befunde und Nachweise bleiben als Audit-Historie erhalten. Für die zwei `uri-js`-Schwachstellen liegt eine lokal verhaltensbasiert geprüfte Ersatzbibliothek vor; bis zu exakter CI- und Staging-Abnahme bleibt der Start blockiert. Die fünf früher akzeptierten internen HTTP-Wege werden in PR #75 auf TLS umgestellt; die Akzeptanz ersetzt keine Prüfung des tatsächlich ausgerollten Systems.

Stand: 20.09.2026. Geplant gegen `1f21249adc48f74bf139562e89ca261b14aebc27`, Branch `codex/final-findings-2026-09-17`. Remote-main wurde am selben Tag lesend als `58c01bc74f83cc212849ddcd7e487412ff06b2b7` bestätigt; keine offenen PRs. Status: **IN PROGRESS / Umsetzung läuft; [aktueller Nachweis](../docs/testing/final-findings-followup-2026-09-20.md).** Aufwand L; Änderungsrisiko hoch im Trading-Kern, niedrig bei rein mechanischen Änderungen.

Dieser Plan ersetzt die offenen Abschlussanweisungen der alten Scanner-Pläne 001–003 für diesen Arbeitsstand. Bereits vorhandene Änderungen bleiben erhalten und werden geprüft, nicht nochmals blind angewendet. Ausführende müssen den gesamten Plan lesen. Pfade und Befehle sind relativ zum Repository, sofern nicht anders angegeben.

## Aktueller Abschlussstand des lokalen Laufs

Der eingefrorene Quellstand `28cfa93870323f835458bd00e8ce6932b7d06853` besteht alle acht lokalen Prüfgruppen: Foundation, beide Backend-Coverage-Läufe mit jeweils 229 Testdateien, Python mit 550 Tests, Frontend mit 403 Tests, Build, Browser mit 196 Fällen, Abhängigkeiten und alle vier Mutationsgruppen. Bestehende Grenzen wurden nicht abgesenkt. Die strengere Modul-Coverage ist auf Windows nachgewiesen; Linux bleibt erforderlich. Monitoring wurde nativ als Konfiguration geprüft, noch nicht als ausgeliefertes Containerimage.

Der Implementierungsnachweis wurde unabhängig gegen vollständige aktuelle Quellen, historische Belege und tatsächliche Ausführungen geprüft. Archiv und Review liegen unter `exchange_executor/certifications/reviews/final-28cfa93-*`. Der Produktionsvergleich bestätigt identische Build-Eingaben und gültige Runtime-Receipts; das ist keine Provider- oder Live-Trading-Freigabe. Die weiter unten beschriebenen ursprünglichen Fehler sind historische Ausgangsbefunde.

**Verbleibende Reihenfolge:** Lokale Nachweis-/Bridge-Nachprüfung ist bestanden; die veröffentlichten Draft-PRs #73–#78 auf einen exakten Kandidatenstand integrieren; Linux-/Docker-CI und vollständige Codacy-, DeepSource- und Sonar-Scans auf genau diesem Stand durchführen; alle alten/neuen IDs abgleichen; verbleibende Defekte in kleinen Paketen mit Regressionstests schließen; erst danach geschützter Merge und vollständiger main-Nachscan. Codacy-Analyzerabbrüche und neue Warnungen bleiben sichtbar. Der zusätzliche Executor-HTTP-Weg gehört inzwischen zum TLS-Umbau in PR #75; erst ein Betriebsnachweis schließt ihn ab.

Lokale SonarJS-Messung: 43 TypeScript-Komplexitäts- und sechs Regex-Fälle unterschreiten die jeweiligen Grenzen 15/20, ohne Parserfehler. Das ersetzt weder SonarCloud noch die 23 noch dort zu messenden Python-Komplexitätsfälle. Ausschließlich DeepSource JS-R1005 ist ausgenommen. Der Gesamtplan bleibt IN PROGRESS, bis die externen Abschlusskriterien erfüllt sind.

## Ziel und unverrückbare Grenzen

Alle Codacy-, DeepSource- und Sonar-Befunde einschließlich früherer False Positives erhalten eine aktuelle, einzeln belegte Entscheidung. Echte Defekte werden behoben. Ein Scannerstatus allein ist kein Funktionsnachweis. Stabilität, unveränderte Verträge und nachgewiesene Kontozuordnung haben Vorrang vor kosmetischen Verbesserungen.

- Ausschließlich DeepSource **JS-R1005** ist auf ausdrücklichen Nutzerwunsch ausgenommen. Die Ausnahme gilt für diese Regel einschließlich neu auftretender Vorkommen, nicht für andere Komplexitätsregeln, Testabdeckung oder bestehende lokale Qualitätsbudgets. Keine großen Zerlegungen allein dafür; Schwellen unverändert lassen.
- Aikido bleibt ausgeschlossen. Snyk ist als aktive Integration entfernt; seine historischen Belege bleiben nachvollziehbar. Alle fünf früher akzeptierten internen HTTP-Wege werden mit TLS abgesichert; bis zum geprüften Rollout bleibt das Betriebsrisiko offen.
- Keine Live-Trades, Provider-Mutationen, produktiven Restores, Datenbankrücksetzungen oder neuen Features. Keine neuen Live-/Testnetfreigaben aus Offline-Tests ableiten.
- Keine pauschalen Regel-/Dateiausschlüsse, abgeschwächten Assertionen, niedrigeren Coverage-Grenzen oder catch-and-ignore-Workarounds.
- Kein pauschales Entfernen von `async`: synchrone Ausführung bis zum ersten await, Promise-Rejection, Promise-Adoption und Aufruferverträge müssen erhalten bleiben.
- Branchschutz bleibt bestehen. Die frühere Sondergenehmigung für PR72 autorisiert keine erneute Ausnahme.

## Vollständigkeit und heutiger Erkenntnisstand

| Dienst / Bestand | Anzahl | Heutige Aussage |
|---|---:|---|
| Codacy aktiv / ignoriert | 92 / 347 | Vollständig paginiert am 20.09.; alle 439 IDs unverändert. Nach den Reparaturen 122 gebundene Kontextdateien lokal verifiziert; Trivy-/ESLint-Abbrüche weiterhin vorhanden. |
| DeepSource aktiv | 1.315 | Vollständig paginiert am 20.09.; dieselben IDs wie Baseline, main `58c01bc7`. |
| DeepSource JS-R1005 | 1.178 | Explizit ausgenommen, keine Behebungsbehauptung. |
| DeepSource übrige | 137, 19 Regeln | 49 lokale Quellkorrekturen warten auf Scan; 88 einzelne Entscheidungen erfordern aktuellen Abschlussnachweis. |
| DeepSource lokale Altunterdrückungen | 370 Kommentare / 389 Regelverweise | 368 / 387 erhalten, zwei obsolete Kommentare entfernt; separate Prüfung, nicht zu aktiven IDs addieren. |
| Sonar insgesamt | 1.307 | Frisch am 20.09. vollständig gelesen; 79 OPEN, 8 RESOLVED, 1.220 CLOSED; keine Hotspots. Analyse weiterhin `58c01bc7`. |
| Sonar OPEN | 79 | 72 lokale Änderungen, sieben einzelne Erhaltungsentscheidungen; vollständig in drei aktuellen Ledgers enthalten. |
| Sonar frühere Entscheidungen | 7 FP + 1 akzeptiert, 2 NOSONAR-Stellen | Separate erneute Vertragsprüfung vorhanden. Kein automatischer Freibrief für Folgeänderungen. |

**Aktualisierung nach der Quellenprüfung:** Alle 1.220 geschlossenen Sonar-Befunde sind inzwischen einzeln klassifiziert und mit Quellenbelegen verknüpft: 286 zuerst geprüfte Fälle, 193 Python-, 364 Frontend- und 377 Backend-Fälle; keine fehlenden, zusätzlichen oder doppelt gezählten IDs. Maßgeblich ist `reports/final-findings/sonar-closed-consolidated-coverage-20260920-v2.json`. Die historische Klassifikation bleibt an ihren geprüften Stand gebunden; spätere Reparaturen und ihre Abnahme werden separat erfasst. 66 kognitive Komplexitätsbefunde und sechs Regex-Komplexitätsbefunde benötigen weiterhin eine aktuelle Sonar-Messung. Ausschließlich JS-R1005 ist ausgenommen.

**Grenze der Aussage:** Vollständige Zuordnung und Quellenprüfung bedeuten keine finale Behebung oder Cloud-Abnahme. Die lokale DeepSource-Unterdrückungsliste beweist nicht die Vollständigkeit aller historischen Cloud-Unterdrückungen. Alle 225 API-seitig erhaltenen DeepSource-Läufe und 900 Checks wurden inzwischen paginiert geprüft; abgelaufene/gelöschte Historie und nicht verfügbare Auditgründe bleiben als Grenze sichtbar. Kein „alle behoben“ allein aus einer Summenübereinstimmung.

Auch bei Codacy wurden heute alle IDs und gespeicherten Kontextbindungen geprüft und kritische Kontrollpfade direkt nachvollzogen; nicht alle 439 vollständigen Aufrufketten unabhängig neu gelesen. Frühere Einzelreviews sind Vorarbeit, keine Befreiung vom finalen Quellenabgleich. Von Sonars 1.220 CLOSED-Meldungen sind 1.217 FIXED und drei REMOVED; letztere nicht als Reparatur zählen.

Belege: `docs/testing/final-{codacy,deepsource-backend,deepsource-ui-python,deepsource-suppressions,sonar-backend,sonar-fill-python}-2026-09-17.*`; originale Exporte unter `reports/final-findings/`; heutige ergänzende Prüfungen unter `advisor-plans/2026-09-20-final-findings/`. Original-IDs **case-sensitive** vergleichen: JavaScript `Set` oder ordinaler Vergleich, nicht PowerShell `Sort-Object -Unique` mit Standardvergleich.

## Ausgangsbefunde und Umsetzungsschwerpunkte

Die unten beschriebenen Fixture- und Bybit-Nachweisfehler wurden inzwischen gezielt behoben und geprüft. Der vollständige eingefrorene Lauf auf `8dad2b1` bestand Python, Frontend, Browser, Build, Abhängigkeitsprüfungen und alle vier Mutationsgruppen; Backend scheiterte an beschädigter Dokumentkodierung. Die Dokumentreparatur besteht jetzt die Governance-Prüfung. Alle späteren Änderungen benötigen ihren eigenen finalen Gesamtnachweis.

Die vertiefte historische Prüfung ergab weitere konkrete Reparaturen: frühe skalare Setup-Validierung, vollständige Python-Recovery-Traversierung, Deadline-Ablehnung vor Credential-Zugriff, lesbare historische Workflow-Hashes mit unveränderter Integritätsprüfung, ursprüngliche Backup-Aufbewahrungsreihenfolge sowie UI-Kontrast und Testkorrekturen. Kleine Pakete und gezielte rote/grüne Regressionen haben Vorrang vor umfassenden Refactorings. Details und echte Ausführungsgrenzen stehen im verlinkten Umsetzungsnachweis.

| Priorität | Problem / Beleg | Wirkung und Vorgehen | Aufwand / Risiko / Sicherheit |
|---|---|---|---|
| P0 Abnahme | Backend-Logs `verification-backend-coverage-retry1.log` und `verification-backend-module-coverage-retry1.log`: `CUMULATIVE_EXECUTION_MISMATCH` beim Hyperliquid-Profil | Beide Gesamtläufe brechen ab. Native numerische Provider-IDs und synthetische Fixture-IDs stimmen nicht überein. Fixture-Vertrag zuerst prüfen; Produktionsprüfung nicht lockern. | S–M / mittel / hoch für Fehler, Ursache durch Gegenprobe bestätigen |
| P0 Abnahme | `exchange_executor/ccxt_candidate_reviews.py:_evidence_bytes`; zwei Fehler in 548 Python-Tests | Prüfsiegel erkennt echte Dateidrift: `test_history_coverage.py` im Bybit-Assessment. Inhalt semantisch neu prüfen, danach Manifest und unabhängige Freigabe erneuern. | S–M / hoch bei falscher Neufreigabe / hoch |
| P1 Nachweis | Codacy Trivy-/ESLint-Ausführungsfehler | 33 alte Go-Meldungen sind weder verlässlich aktuell noch nachweislich erledigt. Analyzer vervollständigen, keine gültigen finally-Blöcke umbauen, um einen Plugin-Crash zu kaschieren. | extern abhängig / mittel / hoch gemäß bisherigen Logs |
| P1 Nachweis | Monitoring-Containerprüfung ohne Docker fehlgeschlagen | Native Konfigurationsprüfung bestanden; sie ersetzt keinen Test der ausgelieferten Container. Containerprüfung in CI erforderlich. | S / niedrig / hoch |
| P1 Abschluss | Quelländerungen nicht auf dem von Clouds analysierten SHA; ältere Receipts/Entscheidungsbindungen | Lokale Verbesserungen sind noch kein Cloud-Abschluss. Ein finaler Stand, vollständige Tests und frische Scans müssen zusammenpassen. | M–L / hoch bei falscher Attestierung / hoch |

## Arbeitsweise und Reihenfolge

Eine Integrationsbranch, kleine logisch getrennte Commits, keine erneute Sammlung konkurrierender Fixer-Branches. Read-only Reviews dürfen parallel laufen. Änderungen an Trading-Engine, Fill-Identität und Nachweisfreigaben nacheinander integrieren. Vor jedem Paket Baseline-gegen-HEAD-Diff lesen und Scope festlegen. Wiederverwendung vorhandener Ergebnisse nur mit nachgewiesen unveränderten relevanten Eingaben; fehlgeschlagene Versuche behalten.

Die Stufen 2–4 beschreiben lokale Arbeiten **und** deren spätere Cloud-Abnahme. Ihre Cloud-Gates können erst nach autorisierter Veröffentlichung des Kandidaten in Stufe 6 erfüllt werden: zunächst lokale Pakete bearbeiten, Stufe 5 prüfen, dann Kandidaten veröffentlichen und die Cloud-Gates aus 2–4 ausführen. Offene externe Analyzerfehler bleiben dabei separat blockiert. Ein Cloud-Gate darf weder lokale unabhängige Vorarbeit verhindern noch als bereits erfüllt gelten. Erst nach diesen Kandidatenprüfungen folgen Merge und main-Nachscan.

### Stufe 0 — Reproduzierbare grüne Funktionsbasis herstellen

Zunächst `git status --short` und `git diff 1f21249adc48f74bf139562e89ca261b14aebc27..HEAD -- src tests exchange_executor docs/testing` prüfen. Unerwartete Änderungen in betroffenen Verträgen vor der Umsetzung klären. Fremde Arbeit nicht zurücksetzen.

**A. Notausstiegsfixture:** Scope zunächst `tests/fixtures/trading_emergency_fixture.js`, `tests/test_trading_emergency.js`, direkte Fixture-Aufrufer. Zum Vergleich `tests/fixtures/native_fill_identity.js`, `src/trading_fill_identity.ts` und `exchange_executor/fill_identity.py` nur lesen.

Aktuell erzeugt die Fixture `exchangeOrderId: \`remote-${order.clientOrderId}\`` und `exchangeFillId: \`${id}-fill-${state.fills.length}\``. Der native Builder übernimmt sie unverändert als Hyperliquid `oid`/`tid`. Dagegen akzeptiert die Produktionsgrenze nur primitive dezimale IDs:

```ts
const tradeId = nativeIntegerText(info.tid), orderId = nativeIntegerText(info.oid);
return tradeId !== null && orderId !== null && tradeId === fill.exchangeFillId && orderId === fill.exchangeOrderId
```

Die Python-Produzentengrenze verwendet ebenfalls `re.fullmatch(r"(?a)\d{1,256}", str(value))`. Erst mit dem vorhandenen Test rot reproduzieren. Dann nur Hyperliquid-Fixture-Provider-IDs eindeutig/dezimal erzeugen, konsistent für Entry, Schutzorder, Flatten, DB und Fills. Beschreibende Client-IDs und Verhalten anderer Profile erhalten. Keine generelle Normalisierung historischer Rohdaten und keine erfundenen Providerbeweise. Die bestehenden Tests für fremde Exposure, verlorene Antworten, späte Fills und Neustart müssen grün bleiben. Negative Identitätsfälle dürfen weiterhin keine finanziellen Zeilen erzeugen.

**Prüfung:** `node tests/run_all.js test_trading_emergency.js test_exchange_fill_identity.js test_trading_fill_identity.js test_trading_fill_identity_backfill.js test_fill_identity_contract_guards.js test_trading_evidence_repository.js test_fill_quantity_persistence.js test_trading_fx_fill_accounting.js` → alle ausgeführten Dateien bestanden. Bei weiterer Vertragsabweichung Ursache neu beurteilen, nicht Produktionsguard abschwächen.

**B. Kandidaten-Nachweise:** Scope `docs/testing/ccxt-expansion-matrix.json`, `exchange_executor/ccxt_candidate_reviews.py`, die referenzierte Bybit-Evidenz und zugehörige Reviewdokumentation. Die gefundene Drift betrifft ausschließlich den referenzierten Inhalt von `exchange_executor/tests/test_history_coverage.py`: try/except-StopIteration wurde durch unique-object-Sentinel und `assertIsNot` ersetzt, gleiche Fehlermeldung und folgende Assertion bleiben bestehen. Vollständigen Referenzsatz aller Assessments erneut auf Hash, Pfad und fachliche Aussage prüfen. Nach unabhängiger Prüfung den einzelnen Evidenzverweis und den festen Assessment-Commitment erneuern. Inventory-/Entscheidungsinhalt nicht nebenbei ändern. Nicht bloß neue Hashes einsetzen, Tests mocken oder den Driftcheck entfernen.

**Prüfung:** `python -B -m unittest discover -s exchange_executor/tests -p test_candidate_review_policy.py -v` und entsprechend `-p test_history_coverage.py` → vollständig grün; mutierte Evidenz und ungültige Receipts werden weiterhin abgelehnt. Anschließend beide Backend-Coverage-Läufe und den vollständigen Python-Lauf durchführen (Befehle unten). Die ursprünglichen Fehler bleiben als historischer Nachweis erhalten.

### Stufe 1 — Gesamten Bestand einschließlich früherer Ausnahmen abgleichen

Vor weiterer Bereinigung alle drei Dienste vollständig paginiert lesen: aktiver, ignorierter, akzeptierter, behobener Bestand; lokale `skipcq`, `NOSONAR` und sonstige Analysenausschlüsse separat erfassen. Analyzer-Versionen, Konfiguration, Branch, Commit, Analyse-ID, Zeit und Vollständigkeit binden. Bei API-Scope-Limit UI/Export zur Ergänzung nutzen; fehlenden Zugang als konkrete Lücke ausweisen, nicht „0“ eintragen.

Je Befund: Dienst + exakte ID + Regel + Datei/Ort + Status + Analyserevision + aktuelle Quelle + tatsächlicher Aufrufer/Datenfluss + Entscheidung + begründeter Test/Beleg + Reviewer. Zulässige Zustände: `fix_pending`, `fixed_verified`, `false_positive_reviewed`, `expected_behavior_reviewed`, `accepted_risk`, `excluded_JS-R1005`, `blocked_analyzer`, `needs_investigation`. Derselbe Befund darf nur einen Zustand haben. Gruppenbegründungen benötigen weiterhin eine individuelle Zuordnung; keine pauschale Übernahme alter FPs.

Geschlossene Sonar-IDs ebenfalls mit aktuellem Code verknüpfen: ursprünglicher Fix noch vorhanden, Code entfernt oder Befund lediglich durch Scope/Regeländerung verschwunden? Bei nicht mehr reproduzierbarer Zuordnung ausdrücklich untersuchen; verlorene Fixes wieder öffnen. Cloud-seitige DeepSource-Suppressionshistorie gegen die 370 lokalen Altkommentare abgleichen, zusätzliche IDs ergänzen. Unveränderte source hashes allein beweisen keine unveränderten importierten Validatoren oder Aufrufer.

**Gate:** Exporte vollständig; eindeutige ID-Mengen, keine Duplikate oder unzugeordneten IDs; aktuelle Revision belegt. `node scripts/check_final_codacy_review.js` muss weiterhin 439 Baseline-IDs und aktuelle Kontextbindungen bestätigen; bei neuer Inventarmenge Validator/Evidenz gezielt erweitern, nicht neue IDs wegfiltern. Den vorhandenen `reports/final-findings/reconcile-inventories.mjs` vor Nutzung lesen: er prüft nur 137 DS-/79 offene Sonar-Baseline-IDs und ersetzt diese erweiterte Prüfung nicht.

### Stufe 2 — Codacy einschließlich aller ignorierten Meldungen abschließen

Die 439 Baseline-IDs zerfallen in 59 aktive FP-Kandidaten (50 lokale SSRF-Testgrenzen, acht private temporäre Pfade, eine Kontrollzeichenvalidierung), 343 erneuerte frühere FPs, vier überholte Altmeldungen und 33 unvollständig/stale Trivy-Meldungen.

- SSRF: tatsächliche Zielherkunft, Bindung an Loopback, Redirect-/URL-Verarbeitung und Erreichbarkeit prüfen. Eine Testdatei allein begründet kein FP. Pfade: Erzeugung privater Tempverzeichnisse, kontrollierte Unterpfade und Bereinigung prüfen. Kontrollzeichenregex: ablehnende Validierung von gefährlichen Eingaben nicht entfernen.
- Jeden der 347 ignorierten Datensätze gegen Quelle und unterstützende Verträge neu beurteilen; vier überholte Vorkommen als superseded mit Nachfolger/Entfernungsbeleg führen.
- Codacy-Providerfehler getrennt bearbeiten: gültiges `try/finally` in `restoreOfflineBackup`, `withDispatchWitness`, `withTimeout` erhalten. Trivy muss den tatsächlichen Go-Stand analysieren; 33 Meldungen zu Go1.26.0 nicht durch reine Dokumentation schließen, wenn analysierter Code bereits1.26.6 verwendet.
- Vorhandenen konkreten Providerbericht `docs/testing/final-codacy-2026-09-17.provider.md` verwenden. Keine Supportnachricht ohne Nutzerauftrag senden. Falls nur Anbieter-Korrektur hilft, bleibt der Abschluss dieses Teilbereichs sichtbar blockiert; lokale Trivy-/ESLint-Ergebnisse als Zusatznachweis, nicht als Codacy-Erfolg ausgeben.

**Gate:** Trivy und ESLint laufen auf finalem SHA ohne Analysis-Errors; Datei- und Repository-Zählungen stimmen; Vollbestand neu exportiert; alle echten Defekte behoben oder einzeln begründet entschieden; Validator grün. Keine ungeprüften Massen-Ignores.

### Stufe 3 — DeepSource: 137 Vorkommen und alle Altunterdrückungen

Die beiden Ledgers `final-deepsource-ui-python-2026-09-17.json` (57 DS-IDs) und `final-deepsource-backend-2026-09-17.json` (80) bilden die vollständige aktuelle Nicht-JS-R1005-Menge.

- 49 vorhandene Quellkorrekturen überprüfen statt erneut anwenden: Template-Literal-Werte/AST erhalten, einzelne React-Fragmente entfernen ohne DOM-/Fokuswechsel, Anzeige-Komponente mit stabiler Identität, korrekte Typen und optionale Rückgaben, zwei private statische Engine-Helfer ohne Aufruf-/Vererbungsänderung, Python-Vergleich.
- 56 JS-0116-Verträge im Backend einzeln erhalten oder nur nach belegter Äquivalenz ändern. Tests müssen Originalfehler-Rejection, immediate invocation, native Promise-Adoption und Mutation-Fencing belegen. Hinzu kommen die separat dokumentierten UI-Async-Verträge.
- JS-0105/ PYL-R0201: Adapter-/SDK-Instanzschnittstellen, Overrides, Initialisierung und Fault-Injection-Seams erhalten. Keine rein syntaktische static-Konversion.
- 15 SCT-A000-Beispiele und weiterer UI-Secret-Kandidat: Herkunft/Fixture-/Typkontext prüfen, keine Secretwerte in Reviewmaterial kopieren. Ein echter Fund löst sichere Entfernung/Rotation aus und darf nicht unter Fixture-Begründungen verschwinden.
- Drei KuCoin-Mypy-Diagnosen: eingesetzte DeepSource-Version/Konfiguration und genaue Overload-Auflösung reproduzieren. Lokaler Erfolg mit mypy2.3.1 allein ist kein endgültiger FP-Beweis.
- 370 historische Kommentare individuell gegen aktuelle AST-Ziele/Verträge prüfen, entfernte zwei JS-W1042-Kommentare als obsolete ausweisen. Alle zusätzlich gefundenen Cloud-Ausnahmen mit einbeziehen.

**Gate:** Frischer vollständiger finaler Scan; jede Nicht-JS-R1005-ID final zugeordnet, echte Defekte verschwunden; individuelle Ausnahmen belegt. Occurrence-ID ist nicht automatisch eine mutierbare CheckIssue-ID: vor Remoteentscheidung exakt Analysis/CheckIssue/Quellstand zuordnen. Keine Mutation anhand bloß gleicher Zeile oder Regel. JS-R1005 darf als ausdrücklich ausgenommener Rest sichtbar bleiben; ein deswegen roter Gesamtstatus wird transparent berichtet.

### Stufe 4 — Sonar: alle offenen und historischen Entscheidungen

79 offene IDs: Backend-Ledger46, UI-Ledger18, Fill/Python-Ledger15. Davon72 Quelländerungen, sieben aktuelle Erhaltungsentscheidungen. Außerdem sieben frühereFPs, eine akzeptierte Browserkompatibilität und zweiNOSONAR-Stellen erneut beurteilen; den vollständigen CLOSED-Abgleich aus Stufe1 abschließen.

- SQL-Typisierung gegen tatsächliche SELECT-Projektionen, INNER/LEFT JOIN, nullable Spalten und Laufzeitform prüfen. Querytext, Transaktionen, Geldrepräsentationen und öffentliche API nicht für Typkosmetik ändern.
- Fill-/TDLib-/Kontrakt-/Paper-Grenzen: strukturierte Werte ablehnen; gültige primitive IDs, führende Nullen, exakte große Dezimalstrings,0 und Originalfehlerverhalten erhalten. Kein Verlust von Fill-Deduplikation, Besitznachweis oder Recovery.
- Python-S8714: unique-object-Sentinel und klare Assertion erhalten. Fehlender Eintrag bleibt Testfehler, kein erfolgreicher Default. Alle nachgelagerten Referenznachweise erneuern.
- UI: Typ-/Fragmentbereinigung durch Fokus-/DOM-/Revisionstest absichern. Keyboard-Fokusregion und Browser-Unload-Fallback nach tatsächlichem Vertrag entscheiden; akzeptierte Kompatibilität nicht als FP bezeichnen.
- Sechs Backend-Erhaltungsentscheidungen zu Legacy-Diagnostik/Coercion nur für belegte unterstützte Werte; keine Behauptung, beliebige Objekte seien sicher. Bei geänderter Eingangsvalidierung neu öffnen.

**Gate:** `npm run quality:sonar-export` und `node scripts/verify_sonar_evidence.js` mit den von CI vorgegebenen SHA-/Branch-/Analyseparametern erfolgreich; OPEN/REOPENED/CONFIRMED und Hotspots vollständig geprüft, jede alte ID abgeglichen. Cloudänderungen erst nach independent review und gültigen aktuellen Bindungen über vorhandene `scripts/sonar_review_decisions.js`-Verfahren; alte Freigabedateien nicht ungeprüft wiederverwenden.

### Stufe 5 — Finalen Quellstand festlegen, vollständig prüfen, Nachweise erneuern

Alle Quell-, Test-, Plan- und Reviewdokumente vor dem finalen Eingabesnapshot fertigstellen. Auch Dokumente können in den kryptografischen Build-Eingaben liegen. Nachträgliche Änderungen erfordern erneute Eingabebindung und betroffene Nachweise. Testlogs im ignorierten Reportbereich, niemals Tokenwerte in Logs.

PowerShell aus dem Repository; zuerst unterstützte Runtime sicherstellen:

```powershell
$nodeDir = 'C:/Users/nikla/AppData/Local/Programs/node22/node-v22.23.2-win-x64'
$pythonDir = (Resolve-Path '../tsx-security-python-env/Scripts').Path
$env:PATH = "$pythonDir;$nodeDir;$env:PATH"
$env:TSX_TEST_PYTHON = Join-Path $pythonDir 'python.exe'
node --version
python --version
python -c "import ccxt; print(ccxt.__version__)"
```

Erwartet Node22.x, Python3.12.x, CCXT4.5.75. Explizites `TSX_TEST_PYTHON` ist erforderlich: der erste alte Backendversuch scheiterte an dieser fehlenden Runtimebindung.

| Prüfung | Exakte Befehle | Erwartet |
|---|---|---|
| Backend | `npm run test:coverage`; `npm run test:coverage:modules` | Beide vollständigen Läufe Exit0, bestehende Grenzen erfüllt |
| Python | `python -B -m coverage run --branch --source=exchange_executor -m unittest discover -s exchange_executor/tests -v`; `python -m coverage report --fail-under=60`; `python -m coverage xml -o exchange_executor/coverage.xml` | Keine Testfehler; Bericht/XML gehören zum erfolgreichen Lauf |
| Frontend | `npm --prefix frontend run test:coverage`; `npm --prefix frontend run test:e2e -- --workers=2` | Vitest und sämtliche Browser-/A11y-Projekte grün; für CI-Modus `CI=true` setzen |
| Typen/Build/Lint | `npm run typecheck`; `npm run lint`; `npm run lint:frontend`; `npm run lint:python`; `npm run build` | Jeweils Exit0 |
| Mutationen | `npm run test:mutation -- --force` | Alle vier Gruppen erfüllen bestehende Grenzen |
| Struktur | `npm run quality:architecture`; `npm run quality:complexity`; `npm run quality:frontend`; `npm run quality:duplicates` | Keine neue Ausnahme oder Grenzwertabsenkung |
| Artefakte/Sicherheit | `npm run quality:release`; `npm run quality:build-context`; `npm run quality:licenses`; `npm run quality:dependencies`; `npm run quality:risk-acceptances`; `npm run quality:sbom`; `npm audit --audit-level=moderate`; `npm --prefix frontend audit --audit-level=moderate` | Exit0, SBOM/Audits an finalen Stand gebunden |
| Monitoring/Container | `npm run quality:monitoring`; `npm run quality:deployment-images` in geeigneter Docker-/CI-Umgebung | Reale Zielimages und Regeln erfolgreich geprüft |

Vorhandener Stand1f21249: Frontend45Suites/403Tests, Browser196Tests, Build, Dependencyprüfungen und vierMutationsgruppen bestanden. Backend/Python nicht bestanden. Foundation nur wegen Docker-Monitoring fehlgeschlagen. Native Prometheus-/Alertmanager-Konfiguration erfolgreich, aber andere Toolchain als gehärtete Zielimages; keine Container-Abnahme daraus ableiten.

Für protokollierte Wiederholungen kann nach Prüfung `node reports/final-findings/run-verification.mjs <group> <eindeutiger-versuch>` genutzt werden; Gruppen foundation/backend/python/frontend/build/browser/mutations/dependencies. Dieses lokale Hilfsskript ist ignoriert und nicht automatisch auf einem frischen Checkout verfügbar. Fehlende Datei nicht als abgeschlossene Prüfung behandeln; obige Befehle und gleichwertige Vorher-/Nachher-Eingabeprotokolle verwenden. Alte Fehlversuche nie überschreiben.

Danach Implementierungs-Receipts, vollständiges Quellarchiv, aktuelle SDK-/Executor-Hashes, Kandidatenfreigaben und Scannerentscheidungen auf Basis tatsächlicher Quellreviews/Testlogs erneuern. Die unabhängige Prüfung muss zwischen inhaltlicher Quellenprüfung und tatsächlicher Testausführung unterscheiden. Prüfer darf seine Freigabe nicht aus dem eigenen generierten Manifest ableiten. `node scripts/verify_exchange_implementation.js --python "$env:TSX_TEST_PYTHON"` ausführen und CI-Verfahren für die unabhängige Quelle einhalten. Keine reine Hashsubstitution, um ein altes Zertifikat passend aussehen zu lassen.

### Stufe 6 — Geprüfte Veröffentlichung und main-Abschluss

Für den veröffentlichten Draft-PR-Stapel einen integrierten PR mit konkretem Fixumfang, offenen externen Abhängigkeiten, Tests und Rollback erstellen. Verpflichtende CI-/Security-Prüfungen und provider-unabhängige Abhängigkeitsnachweise für den exakten Head abwarten. Aktuellen Branchschutz/Reviewbedarf lesen; keine pauschale Ableitung aus früheren 14 Checks. Ausstehende Reviews nicht technisch umgehen. Mergekonflikte oder aktualisierte main-Basis erzeugen neue Prüfarbeit.

Rollback: zusammenhängendes fehlerhaftes Änderungspaket über normalen Revert-PR zurücknehmen; keine Produktionsdaten löschen, historische Fill-Identität umschreiben oder alte Receipts auf neuen Code umhängen. Kein Deploy Teil dieser Scannerbereinigung.

Nach freigegebenem Merge alle drei Dienste vollständig auf **dem tatsächlichen main-Merge-SHA** auswerten. PR-Neucode-Gates ersetzen keine Gesamtrepoanalyse. Neue Findings zurück in Stufe1–4; danach betroffene Regressionen und finalen Stand erneut prüfen.

## Maschinenprüfbare Abschlusskriterien

- [ ] Vollständige final-main-Exporte aller drei Dienste mit korrektem SHA, stabilen Analyse-IDs und erfolgreicher Analyzer-Ausführung vorhanden.
- [ ] Alle alten und neuen IDs exakt/case-sensitive zugeordnet, keine unbegründete Unterdrückung oder verlorene Altbehebung; historische Prüfungslücken geschlossen.
- [ ] Keine ungeklärten echten Defekte und keine unbestätigten `fix_pending`/`needs_investigation` außerhalb JS-R1005.
- [ ] Bestätigte FPs und beabsichtigte Verträge einzeln aktuell begründet; akzeptierte Risiken separat sichtbar. Kein „alles behoben“ für Ausnahmen.
- [ ] Backend, Python, Frontend, Browser, Mutationen, Build, Lint, Typen, Monitoring, Container- und Security-Gates auf passendem finalen Quellstand grün.
- [ ] Receipts und Scannerentscheidungen unabhängig geprüft; Quellen, Archiv, Runtime und Logs stimmen überein.
- [ ] Geschützter Merge und vollständige main-Nachkontrolle abgeschlossen; kein produktiver Rollout behauptet.

## Stop- und Eskalationspunkte

Fehlende Analyzerergebnisse, unerklärte Inventarlücken, Beweis-/Quellhashdrift oder rote fachliche Tests verhindern die jeweilige Abschlussbehauptung. Unabhängige Pakete dürfen weiterlaufen. Nach zwei erfolglosen zielgerichteten Reparaturversuchen Ursache/Scope neu prüfen statt weitere Autofixes stapeln. Änderungen an Ownership, Schema, öffentlichem API, Zertifizierungspolitik oder Börsenverhalten, die über die genannten Korrekturen hinausgehen, brauchen einen neuen konkreten Review. Zugang/Anbieterkorrektur erst mit exakt benanntem benötigten Schritt anfordern; keine Tokens im Chat.

Wartung: Änderungen an Validatoren, Aufrufern, Promise-Verhalten, SDK-Version oder Scanner-Regelversion können eine bisher richtige Ausnahme ungültig machen. Darum Entscheidung an solche Abhängigkeiten binden und beim nächsten relevanten Diff erneut prüfen. Ziel ist ein funktionierendes, nachvollziehbar geprüftes Programm, nicht eine künstliche Null im Dashboard.
