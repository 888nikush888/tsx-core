# Plan 004: Codacy, DeepSource und Sonar stabil abschlieÃŸen

Stand: 20.09.2026. Geplant gegen `1f21249adc48f74bf139562e89ca261b14aebc27`, Branch `codex/final-findings-2026-09-17`. Remote-main wurde am selben Tag lesend als `58c01bc74f83cc212849ddcd7e487412ff06b2b7` bestÃ¤tigt; keine offenen PRs. Status: **TODO â€” Planung, keine neue Umsetzung oder VerÃ¶ffentlichung in diesem Durchlauf.** Aufwand L; Ã„nderungsrisiko hoch im Trading-Kern, niedrig bei rein mechanischen Ã„nderungen.

Dieser Plan ersetzt die offenen Abschlussanweisungen der alten Scanner-PlÃ¤ne 001â€“003 fÃ¼r diesen Arbeitsstand. Bereits vorhandene Ã„nderungen bleiben erhalten und werden geprÃ¼ft, nicht nochmals blind angewendet. AusfÃ¼hrende mÃ¼ssen den gesamten Plan lesen. Pfade und Befehle sind relativ zum Repository, sofern nicht anders angegeben.

## Ziel und unverrÃ¼ckbare Grenzen

Alle Codacy-, DeepSource- und Sonar-Befunde einschlieÃŸlich frÃ¼herer False Positives erhalten eine aktuelle, einzeln belegte Entscheidung. Echte Defekte werden behoben. Ein Scannerstatus allein ist kein Funktionsnachweis. StabilitÃ¤t, unverÃ¤nderte VertrÃ¤ge und nachgewiesene Kontozuordnung haben Vorrang vor kosmetischen Verbesserungen.

- AusschlieÃŸlich DeepSource **JS-R1005** ist auf ausdrÃ¼cklichen Nutzerwunsch ausgenommen. Die Ausnahme gilt fÃ¼r diese Regel einschlieÃŸlich neu auftretender Vorkommen, nicht fÃ¼r andere KomplexitÃ¤tsregeln, Testabdeckung oder bestehende lokale QualitÃ¤tsbudgets. Keine groÃŸen Zerlegungen allein dafÃ¼r; Schwellen unverÃ¤ndert lassen.
- Aikido bleibt ausgeschlossen. Snyk bleibt bei Actions-Scans; die vier bereits akzeptierten internen HTTP-Risiken bleiben getrennt sichtbar und werden nicht zu False Positives umetikettiert. Bestehende Befristungen beachten.
- Keine Live-Trades, Provider-Mutationen, produktiven Restores, DatenbankrÃ¼cksetzungen oder neuen Features. Keine neuen Live-/Testnetfreigaben aus Offline-Tests ableiten.
- Keine pauschalen Regel-/DateiausschlÃ¼sse, abgeschwÃ¤chten Assertionen, niedrigeren Coverage-Grenzen oder catch-and-ignore-Workarounds.
- Kein pauschales Entfernen von `async`: synchrone AusfÃ¼hrung bis zum ersten await, Promise-Rejection, Promise-Adoption und AufrufervertrÃ¤ge mÃ¼ssen erhalten bleiben.
- Branchschutz bleibt bestehen. Die frÃ¼here Sondergenehmigung fÃ¼r PR72 autorisiert keine erneute Ausnahme.

## VollstÃ¤ndigkeit und heutiger Erkenntnisstand

| Dienst / Bestand | Anzahl | Heutige Aussage |
|---|---:|---|
| Codacy aktiv / ignoriert | 92 / 347 | VollstÃ¤ndig paginiert am 20.09.; alle 439 IDs unverÃ¤ndert. 116 gebundene Kontextdateien lokal verifiziert; Trivy-/ESLint-AbbrÃ¼che weiterhin vorhanden. |
| DeepSource aktiv | 1.315 | VollstÃ¤ndig paginiert am 20.09.; dieselben IDs wie Baseline, main `58c01bc7`. |
| DeepSource JS-R1005 | 1.178 | Explizit ausgenommen, keine Behebungsbehauptung. |
| DeepSource Ã¼brige | 137, 19 Regeln | 49 lokale Quellkorrekturen warten auf Scan; 88 einzelne Entscheidungen erfordern aktuellen Abschlussnachweis. |
| DeepSource lokale AltunterdrÃ¼ckungen | 370 Kommentare / 389 Regelverweise | 368 / 387 erhalten, zwei obsolete Kommentare entfernt; separate PrÃ¼fung, nicht zu aktiven IDs addieren. |
| Sonar insgesamt | 1.307 | Frisch am 20.09. vollstÃ¤ndig gelesen; 79 OPEN, 8 RESOLVED, 1.220 CLOSED; keine Hotspots. Analyse weiterhin `58c01bc7`. |
| Sonar OPEN | 79 | 72 lokale Ã„nderungen, sieben einzelne Erhaltungsentscheidungen; vollstÃ¤ndig in drei aktuellen Ledgers enthalten. |
| Sonar frÃ¼here Entscheidungen | 7 FP + 1 akzeptiert, 2 NOSONAR-Stellen | Separate erneute VertragsprÃ¼fung vorhanden. Kein automatischer Freibrief fÃ¼r FolgeÃ¤nderungen. |

**Grenze der Aussage:** Die 1.220 geschlossenen Sonar-Befunde wurden heute vollstÃ¤ndig nach IdentitÃ¤t/Status abgeglichen, aber nicht sÃ¤mtlich erneut zeilenweise beurteilt. Die lokale DeepSource-UnterdrÃ¼ckungsliste beweist nicht die VollstÃ¤ndigkeit aller historischen Cloud-UnterdrÃ¼ckungen. Diese LÃ¼cken werden in Stufe 1 ausdrÃ¼cklich geschlossen. Kein â€žalle untersucht/behobenâ€œ allein aus einer SummenÃ¼bereinstimmung.

Auch bei Codacy wurden heute alle IDs und gespeicherten Kontextbindungen geprÃ¼ft und kritische Kontrollpfade direkt nachvollzogen; nicht alle 439 vollstÃ¤ndigen Aufrufketten unabhÃ¤ngig neu gelesen. FrÃ¼here Einzelreviews sind Vorarbeit, keine Befreiung vom finalen Quellenabgleich. Von Sonars 1.220 CLOSED-Meldungen sind 1.217 FIXED und drei REMOVED; letztere nicht als Reparatur zÃ¤hlen.

Belege: `docs/testing/final-{codacy,deepsource-backend,deepsource-ui-python,deepsource-suppressions,sonar-backend,sonar-fill-python}-2026-09-17.*`; originale Exporte unter `reports/final-findings/`; heutige ergÃ¤nzende PrÃ¼fungen unter `advisor-plans/2026-09-20-final-findings/`. Original-IDs **case-sensitive** vergleichen: JavaScript `Set` oder ordinaler Vergleich, nicht PowerShell `Sort-Object -Unique` mit Standardvergleich.

## Befunde, die zuerst abgearbeitet werden mÃ¼ssen

| PrioritÃ¤t | Problem / Beleg | Wirkung und Vorgehen | Aufwand / Risiko / Sicherheit |
|---|---|---|---|
| P0 Abnahme | Backend-Logs `verification-backend-coverage-retry1.log` und `verification-backend-module-coverage-retry1.log`: `CUMULATIVE_EXECUTION_MISMATCH` beim Hyperliquid-Profil | Beide GesamtlÃ¤ufe brechen ab. Native numerische Provider-IDs und synthetische Fixture-IDs stimmen nicht Ã¼berein. Fixture-Vertrag zuerst prÃ¼fen; ProduktionsprÃ¼fung nicht lockern. | Sâ€“M / mittel / hoch fÃ¼r Fehler, Ursache durch Gegenprobe bestÃ¤tigen |
| P0 Abnahme | `exchange_executor/ccxt_candidate_reviews.py:_evidence_bytes`; zwei Fehler in 548 Python-Tests | PrÃ¼fsiegel erkennt echte Dateidrift: `test_history_coverage.py` im Bybit-Assessment. Inhalt semantisch neu prÃ¼fen, danach Manifest und unabhÃ¤ngige Freigabe erneuern. | Sâ€“M / hoch bei falscher Neufreigabe / hoch |
| P1 Nachweis | Codacy Trivy-/ESLint-AusfÃ¼hrungsfehler | 33 alte Go-Meldungen sind weder verlÃ¤sslich aktuell noch nachweislich erledigt. Analyzer vervollstÃ¤ndigen, keine gÃ¼ltigen finally-BlÃ¶cke umbauen, um einen Plugin-Crash zu kaschieren. | extern abhÃ¤ngig / mittel / hoch gemÃ¤ÃŸ bisherigen Logs |
| P1 Nachweis | Monitoring-ContainerprÃ¼fung ohne Docker fehlgeschlagen | Native KonfigurationsprÃ¼fung bestanden; sie ersetzt keinen Test der ausgelieferten Container. ContainerprÃ¼fung in CI erforderlich. | S / niedrig / hoch |
| P1 Abschluss | QuellÃ¤nderungen nicht auf dem von Clouds analysierten SHA; Ã¤ltere Receipts/Entscheidungsbindungen | Lokale Verbesserungen sind noch kein Cloud-Abschluss. Ein finaler Stand, vollstÃ¤ndige Tests und frische Scans mÃ¼ssen zusammenpassen. | Mâ€“L / hoch bei falscher Attestierung / hoch |

## Arbeitsweise und Reihenfolge

Eine Integrationsbranch, kleine logisch getrennte Commits, keine erneute Sammlung konkurrierender Fixer-Branches. Read-only Reviews dÃ¼rfen parallel laufen. Ã„nderungen an Trading-Engine, Fill-IdentitÃ¤t und Nachweisfreigaben nacheinander integrieren. Vor jedem Paket Baseline-gegen-HEAD-Diff lesen und Scope festlegen. Wiederverwendung vorhandener Ergebnisse nur mit nachgewiesen unverÃ¤nderten relevanten Eingaben; fehlgeschlagene Versuche behalten.

Die Stufen 2â€“4 beschreiben lokale Arbeiten **und** deren spÃ¤tere Cloud-Abnahme. Ihre Cloud-Gates kÃ¶nnen erst nach autorisierter VerÃ¶ffentlichung des Kandidaten in Stufe 6 erfÃ¼llt werden: zunÃ¤chst lokale Pakete bearbeiten, Stufe 5 prÃ¼fen, dann Kandidaten verÃ¶ffentlichen und die Cloud-Gates aus 2â€“4 ausfÃ¼hren. Offene externe Analyzerfehler bleiben dabei separat blockiert. Ein Cloud-Gate darf weder lokale unabhÃ¤ngige Vorarbeit verhindern noch als bereits erfÃ¼llt gelten. Erst nach diesen KandidatenprÃ¼fungen folgen Merge und main-Nachscan.

### Stufe 0 â€” Reproduzierbare grÃ¼ne Funktionsbasis herstellen

ZunÃ¤chst `git status --short` und `git diff 1f21249adc48f74bf139562e89ca261b14aebc27..HEAD -- src tests exchange_executor docs/testing` prÃ¼fen. Unerwartete Ã„nderungen in betroffenen VertrÃ¤gen vor der Umsetzung klÃ¤ren. Fremde Arbeit nicht zurÃ¼cksetzen.

**A. Notausstiegsfixture:** Scope zunÃ¤chst `tests/fixtures/trading_emergency_fixture.js`, `tests/test_trading_emergency.js`, direkte Fixture-Aufrufer. Zum Vergleich `tests/fixtures/native_fill_identity.js`, `src/trading_fill_identity.ts` und `exchange_executor/fill_identity.py` nur lesen.

Aktuell erzeugt die Fixture `exchangeOrderId: \`remote-${order.clientOrderId}\`` und `exchangeFillId: \`${id}-fill-${state.fills.length}\``. Der native Builder Ã¼bernimmt sie unverÃ¤ndert als Hyperliquid `oid`/`tid`. Dagegen akzeptiert die Produktionsgrenze nur primitive dezimale IDs:

```ts
const tradeId = nativeIntegerText(info.tid), orderId = nativeIntegerText(info.oid);
return tradeId !== null && orderId !== null && tradeId === fill.exchangeFillId && orderId === fill.exchangeOrderId
```

Die Python-Produzentengrenze verwendet ebenfalls `re.fullmatch(r"(?a)\d{1,256}", str(value))`. Erst mit dem vorhandenen Test rot reproduzieren. Dann nur Hyperliquid-Fixture-Provider-IDs eindeutig/dezimal erzeugen, konsistent fÃ¼r Entry, Schutzorder, Flatten, DB und Fills. Beschreibende Client-IDs und Verhalten anderer Profile erhalten. Keine generelle Normalisierung historischer Rohdaten und keine erfundenen Providerbeweise. Die bestehenden Tests fÃ¼r fremde Exposure, verlorene Antworten, spÃ¤te Fills und Neustart mÃ¼ssen grÃ¼n bleiben. Negative IdentitÃ¤tsfÃ¤lle dÃ¼rfen weiterhin keine finanziellen Zeilen erzeugen.

**PrÃ¼fung:** `node tests/run_all.js test_trading_emergency.js test_exchange_fill_identity.js test_trading_fill_identity.js test_trading_fill_identity_backfill.js test_fill_identity_contract_guards.js test_trading_evidence_repository.js test_fill_quantity_persistence.js test_trading_fx_fill_accounting.js` â†’ alle ausgefÃ¼hrten Dateien bestanden. Bei weiterer Vertragsabweichung Ursache neu beurteilen, nicht Produktionsguard abschwÃ¤chen.

**B. Kandidaten-Nachweise:** Scope `docs/testing/ccxt-expansion-matrix.json`, `exchange_executor/ccxt_candidate_reviews.py`, die referenzierte Bybit-Evidenz und zugehÃ¶rige Reviewdokumentation. Die gefundene Drift betrifft ausschlieÃŸlich den referenzierten Inhalt von `exchange_executor/tests/test_history_coverage.py`: try/except-StopIteration wurde durch unique-object-Sentinel und `assertIsNot` ersetzt, gleiche Fehlermeldung und folgende Assertion bleiben bestehen. VollstÃ¤ndigen Referenzsatz aller Assessments erneut auf Hash, Pfad und fachliche Aussage prÃ¼fen. Nach unabhÃ¤ngiger PrÃ¼fung den einzelnen Evidenzverweis und den festen Assessment-Commitment erneuern. Inventory-/Entscheidungsinhalt nicht nebenbei Ã¤ndern. Nicht bloÃŸ neue Hashes einsetzen, Tests mocken oder den Driftcheck entfernen.

**PrÃ¼fung:** `python -B -m unittest discover -s exchange_executor/tests -p test_candidate_review_policy.py -v` und entsprechend `-p test_history_coverage.py` â†’ vollstÃ¤ndig grÃ¼n; mutierte Evidenz und ungÃ¼ltige Receipts werden weiterhin abgelehnt. AnschlieÃŸend beide Backend-Coverage-LÃ¤ufe und den vollstÃ¤ndigen Python-Lauf durchfÃ¼hren (Befehle unten). Die ursprÃ¼nglichen Fehler bleiben als historischer Nachweis erhalten.

### Stufe 1 â€” Gesamten Bestand einschlieÃŸlich frÃ¼herer Ausnahmen abgleichen

Vor weiterer Bereinigung alle drei Dienste vollstÃ¤ndig paginiert lesen: aktiver, ignorierter, akzeptierter, behobener Bestand; lokale `skipcq`, `NOSONAR` und sonstige AnalysenausschlÃ¼sse separat erfassen. Analyzer-Versionen, Konfiguration, Branch, Commit, Analyse-ID, Zeit und VollstÃ¤ndigkeit binden. Bei API-Scope-Limit UI/Export zur ErgÃ¤nzung nutzen; fehlenden Zugang als konkrete LÃ¼cke ausweisen, nicht â€ž0â€œ eintragen.

Je Befund: Dienst + exakte ID + Regel + Datei/Ort + Status + Analyserevision + aktuelle Quelle + tatsÃ¤chlicher Aufrufer/Datenfluss + Entscheidung + begrÃ¼ndeter Test/Beleg + Reviewer. ZulÃ¤ssige ZustÃ¤nde: `fix_pending`, `fixed_verified`, `false_positive_reviewed`, `expected_behavior_reviewed`, `accepted_risk`, `excluded_JS-R1005`, `blocked_analyzer`, `needs_investigation`. Derselbe Befund darf nur einen Zustand haben. GruppenbegrÃ¼ndungen benÃ¶tigen weiterhin eine individuelle Zuordnung; keine pauschale Ãœbernahme alter FPs.

Geschlossene Sonar-IDs ebenfalls mit aktuellem Code verknÃ¼pfen: ursprÃ¼nglicher Fix noch vorhanden, Code entfernt oder Befund lediglich durch Scope/RegelÃ¤nderung verschwunden? Bei nicht mehr reproduzierbarer Zuordnung ausdrÃ¼cklich untersuchen; verlorene Fixes wieder Ã¶ffnen. Cloud-seitige DeepSource-Suppressionshistorie gegen die 370 lokalen Altkommentare abgleichen, zusÃ¤tzliche IDs ergÃ¤nzen. UnverÃ¤nderte source hashes allein beweisen keine unverÃ¤nderten importierten Validatoren oder Aufrufer.

**Gate:** Exporte vollstÃ¤ndig; eindeutige ID-Mengen, keine Duplikate oder unzugeordneten IDs; aktuelle Revision belegt. `node scripts/check_final_codacy_review.js` muss weiterhin 439 Baseline-IDs und aktuelle Kontextbindungen bestÃ¤tigen; bei neuer Inventarmenge Validator/Evidenz gezielt erweitern, nicht neue IDs wegfiltern. Den vorhandenen `reports/final-findings/reconcile-inventories.mjs` vor Nutzung lesen: er prÃ¼ft nur 137 DS-/79 offene Sonar-Baseline-IDs und ersetzt diese erweiterte PrÃ¼fung nicht.

### Stufe 2 â€” Codacy einschlieÃŸlich aller ignorierten Meldungen abschlieÃŸen

Die 439 Baseline-IDs zerfallen in 59 aktive FP-Kandidaten (50 lokale SSRF-Testgrenzen, acht private temporÃ¤re Pfade, eine Kontrollzeichenvalidierung), 343 erneuerte frÃ¼here FPs, vier Ã¼berholte Altmeldungen und 33 unvollstÃ¤ndig/stale Trivy-Meldungen.

- SSRF: tatsÃ¤chliche Zielherkunft, Bindung an Loopback, Redirect-/URL-Verarbeitung und Erreichbarkeit prÃ¼fen. Eine Testdatei allein begrÃ¼ndet kein FP. Pfade: Erzeugung privater Tempverzeichnisse, kontrollierte Unterpfade und Bereinigung prÃ¼fen. Kontrollzeichenregex: ablehnende Validierung von gefÃ¤hrlichen Eingaben nicht entfernen.
- Jeden der 347 ignorierten DatensÃ¤tze gegen Quelle und unterstÃ¼tzende VertrÃ¤ge neu beurteilen; vier Ã¼berholte Vorkommen als superseded mit Nachfolger/Entfernungsbeleg fÃ¼hren.
- Codacy-Providerfehler getrennt bearbeiten: gÃ¼ltiges `try/finally` in `restoreOfflineBackup`, `withDispatchWitness`, `withTimeout` erhalten. Trivy muss den tatsÃ¤chlichen Go-Stand analysieren; 33 Meldungen zu Go1.26.0 nicht durch reine Dokumentation schlieÃŸen, wenn analysierter Code bereits1.26.6 verwendet.
- Vorhandenen konkreten Providerbericht `docs/testing/final-codacy-2026-09-17.provider.md` verwenden. Keine Supportnachricht ohne Nutzerauftrag senden. Falls nur Anbieter-Korrektur hilft, bleibt der Abschluss dieses Teilbereichs sichtbar blockiert; lokale Trivy-/ESLint-Ergebnisse als Zusatznachweis, nicht als Codacy-Erfolg ausgeben.

**Gate:** Trivy und ESLint laufen auf finalem SHA ohne Analysis-Errors; Datei- und Repository-ZÃ¤hlungen stimmen; Vollbestand neu exportiert; alle echten Defekte behoben oder einzeln begrÃ¼ndet entschieden; Validator grÃ¼n. Keine ungeprÃ¼ften Massen-Ignores.

### Stufe 3 â€” DeepSource: 137 Vorkommen und alle AltunterdrÃ¼ckungen

Die beiden Ledgers `final-deepsource-ui-python-2026-09-17.json` (57 DS-IDs) und `final-deepsource-backend-2026-09-17.json` (80) bilden die vollstÃ¤ndige aktuelle Nicht-JS-R1005-Menge.

- 49 vorhandene Quellkorrekturen Ã¼berprÃ¼fen statt erneut anwenden: Template-Literal-Werte/AST erhalten, einzelne React-Fragmente entfernen ohne DOM-/Fokuswechsel, Anzeige-Komponente mit stabiler IdentitÃ¤t, korrekte Typen und optionale RÃ¼ckgaben, zwei private statische Engine-Helfer ohne Aufruf-/VererbungsÃ¤nderung, Python-Vergleich.
- 56 JS-0116-VertrÃ¤ge im Backend einzeln erhalten oder nur nach belegter Ã„quivalenz Ã¤ndern. Tests mÃ¼ssen Originalfehler-Rejection, immediate invocation, native Promise-Adoption und Mutation-Fencing belegen. Hinzu kommen die separat dokumentierten UI-Async-VertrÃ¤ge.
- JS-0105/ PYL-R0201: Adapter-/SDK-Instanzschnittstellen, Overrides, Initialisierung und Fault-Injection-Seams erhalten. Keine rein syntaktische static-Konversion.
- 15 SCT-A000-Beispiele und weiterer UI-Secret-Kandidat: Herkunft/Fixture-/Typkontext prÃ¼fen, keine Secretwerte in Reviewmaterial kopieren. Ein echter Fund lÃ¶st sichere Entfernung/Rotation aus und darf nicht unter Fixture-BegrÃ¼ndungen verschwinden.
- Drei KuCoin-Mypy-Diagnosen: eingesetzte DeepSource-Version/Konfiguration und genaue Overload-AuflÃ¶sung reproduzieren. Lokaler Erfolg mit mypy2.3.1 allein ist kein endgÃ¼ltiger FP-Beweis.
- 370 historische Kommentare individuell gegen aktuelle AST-Ziele/VertrÃ¤ge prÃ¼fen, entfernte zwei JS-W1042-Kommentare als obsolete ausweisen. Alle zusÃ¤tzlich gefundenen Cloud-Ausnahmen mit einbeziehen.

**Gate:** Frischer vollstÃ¤ndiger finaler Scan; jede Nicht-JS-R1005-ID final zugeordnet, echte Defekte verschwunden; individuelle Ausnahmen belegt. Occurrence-ID ist nicht automatisch eine mutierbare CheckIssue-ID: vor Remoteentscheidung exakt Analysis/CheckIssue/Quellstand zuordnen. Keine Mutation anhand bloÃŸ gleicher Zeile oder Regel. JS-R1005 darf als ausdrÃ¼cklich ausgenommener Rest sichtbar bleiben; ein deswegen roter Gesamtstatus wird transparent berichtet.

### Stufe 4 â€” Sonar: alle offenen und historischen Entscheidungen

79 offene IDs: Backend-Ledger46, UI-Ledger18, Fill/Python-Ledger15. Davon72 QuellÃ¤nderungen, sieben aktuelle Erhaltungsentscheidungen. AuÃŸerdem sieben frÃ¼hereFPs, eine akzeptierte BrowserkompatibilitÃ¤t und zweiNOSONAR-Stellen erneut beurteilen; den vollstÃ¤ndigen CLOSED-Abgleich aus Stufe1 abschlieÃŸen.

- SQL-Typisierung gegen tatsÃ¤chliche SELECT-Projektionen, INNER/LEFT JOIN, nullable Spalten und Laufzeitform prÃ¼fen. Querytext, Transaktionen, GeldreprÃ¤sentationen und Ã¶ffentliche API nicht fÃ¼r Typkosmetik Ã¤ndern.
- Fill-/TDLib-/Kontrakt-/Paper-Grenzen: strukturierte Werte ablehnen; gÃ¼ltige primitive IDs, fÃ¼hrende Nullen, exakte groÃŸe Dezimalstrings,0 und Originalfehlerverhalten erhalten. Kein Verlust von Fill-Deduplikation, Besitznachweis oder Recovery.
- Python-S8714: unique-object-Sentinel und klare Assertion erhalten. Fehlender Eintrag bleibt Testfehler, kein erfolgreicher Default. Alle nachgelagerten Referenznachweise erneuern.
- UI: Typ-/Fragmentbereinigung durch Fokus-/DOM-/Revisionstest absichern. Keyboard-Fokusregion und Browser-Unload-Fallback nach tatsÃ¤chlichem Vertrag entscheiden; akzeptierte KompatibilitÃ¤t nicht als FP bezeichnen.
- Sechs Backend-Erhaltungsentscheidungen zu Legacy-Diagnostik/Coercion nur fÃ¼r belegte unterstÃ¼tzte Werte; keine Behauptung, beliebige Objekte seien sicher. Bei geÃ¤nderter Eingangsvalidierung neu Ã¶ffnen.

**Gate:** `npm run quality:sonar-export` und `node scripts/verify_sonar_evidence.js` mit den von CI vorgegebenen SHA-/Branch-/Analyseparametern erfolgreich; OPEN/REOPENED/CONFIRMED und Hotspots vollstÃ¤ndig geprÃ¼ft, jede alte ID abgeglichen. CloudÃ¤nderungen erst nach independent review und gÃ¼ltigen aktuellen Bindungen Ã¼ber vorhandene `scripts/sonar_review_decisions.js`-Verfahren; alte Freigabedateien nicht ungeprÃ¼ft wiederverwenden.

### Stufe 5 â€” Finalen Quellstand festlegen, vollstÃ¤ndig prÃ¼fen, Nachweise erneuern

Alle Quell-, Test-, Plan- und Reviewdokumente vor dem finalen Eingabesnapshot fertigstellen. Auch Dokumente kÃ¶nnen in den kryptografischen Build-Eingaben liegen. NachtrÃ¤gliche Ã„nderungen erfordern erneute Eingabebindung und betroffene Nachweise. Testlogs im ignorierten Reportbereich, niemals Tokenwerte in Logs.

PowerShell aus dem Repository; zuerst unterstÃ¼tzte Runtime sicherstellen:

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

| PrÃ¼fung | Exakte Befehle | Erwartet |
|---|---|---|
| Backend | `npm run test:coverage`; `npm run test:coverage:modules` | Beide vollstÃ¤ndigen LÃ¤ufe Exit0, bestehende Grenzen erfÃ¼llt |
| Python | `python -B -m coverage run --branch --source=exchange_executor -m unittest discover -s exchange_executor/tests -v`; `python -m coverage report --fail-under=60`; `python -m coverage xml -o exchange_executor/coverage.xml` | Keine Testfehler; Bericht/XML gehÃ¶ren zum erfolgreichen Lauf |
| Frontend | `npm --prefix frontend run test:coverage`; `npm --prefix frontend run test:e2e -- --workers=2` | Vitest und sÃ¤mtliche Browser-/A11y-Projekte grÃ¼n; fÃ¼r CI-Modus `CI=true` setzen |
| Typen/Build/Lint | `npm run typecheck`; `npm run lint`; `npm run lint:frontend`; `npm run lint:python`; `npm run build` | Jeweils Exit0 |
| Mutationen | `npm run test:mutation -- --force` | Alle vier Gruppen erfÃ¼llen bestehende Grenzen |
| Struktur | `npm run quality:architecture`; `npm run quality:complexity`; `npm run quality:frontend`; `npm run quality:duplicates` | Keine neue Ausnahme oder Grenzwertabsenkung |
| Artefakte/Sicherheit | `npm run quality:release`; `npm run quality:build-context`; `npm run quality:licenses`; `npm run quality:dependencies`; `npm run quality:risk-acceptances`; `npm run quality:sbom`; `npm audit --audit-level=moderate`; `npm --prefix frontend audit --audit-level=moderate` | Exit0, SBOM/Audits an finalen Stand gebunden |
| Monitoring/Container | `npm run quality:monitoring`; `npm run quality:deployment-images` in geeigneter Docker-/CI-Umgebung | Reale Zielimages und Regeln erfolgreich geprÃ¼ft |

Vorhandener Stand1f21249: Frontend45Suites/403Tests, Browser196Tests, Build, DependencyprÃ¼fungen und vierMutationsgruppen bestanden. Backend/Python nicht bestanden. Foundation nur wegen Docker-Monitoring fehlgeschlagen. Native Prometheus-/Alertmanager-Konfiguration erfolgreich, aber andere Toolchain als gehÃ¤rtete Zielimages; keine Container-Abnahme daraus ableiten.

FÃ¼r protokollierte Wiederholungen kann nach PrÃ¼fung `node reports/final-findings/run-verification.mjs <group> <eindeutiger-versuch>` genutzt werden; Gruppen foundation/backend/python/frontend/build/browser/mutations/dependencies. Dieses lokale Hilfsskript ist ignoriert und nicht automatisch auf einem frischen Checkout verfÃ¼gbar. Fehlende Datei nicht als abgeschlossene PrÃ¼fung behandeln; obige Befehle und gleichwertige Vorher-/Nachher-Eingabeprotokolle verwenden. Alte Fehlversuche nie Ã¼berschreiben.

Danach Implementierungs-Receipts, vollstÃ¤ndiges Quellarchiv, aktuelle SDK-/Executor-Hashes, Kandidatenfreigaben und Scannerentscheidungen auf Basis tatsÃ¤chlicher Quellreviews/Testlogs erneuern. Die unabhÃ¤ngige PrÃ¼fung muss zwischen inhaltlicher QuellenprÃ¼fung und tatsÃ¤chlicher TestausfÃ¼hrung unterscheiden. PrÃ¼fer darf seine Freigabe nicht aus dem eigenen generierten Manifest ableiten. `node scripts/verify_exchange_implementation.js --python "$env:TSX_TEST_PYTHON"` ausfÃ¼hren und CI-Verfahren fÃ¼r die unabhÃ¤ngige Quelle einhalten. Keine reine Hashsubstitution, um ein altes Zertifikat passend aussehen zu lassen.

### Stufe 6 â€” GeprÃ¼fte VerÃ¶ffentlichung und main-Abschluss

Erst nach Umsetzung und ausdrÃ¼cklichem VerÃ¶ffentlichungsauftrag: einen PR mit konkretem Fixumfang, offenen externen AbhÃ¤ngigkeiten, Tests und Rollback erstellen. Verpflichtende CI-/Security-/Snyk-Actions-PrÃ¼fungen fÃ¼r den exakten Head abwarten. Aktuellen Branchschutz/Reviewbedarf lesen; keine pauschale Ableitung aus frÃ¼heren14Checks. Ausstehende Reviews nicht technisch umgehen. Mergekonflikte oder aktualisierte main-Basis erzeugen neue PrÃ¼farbeit.

Rollback: zusammenhÃ¤ngendes fehlerhaftes Ã„nderungspaket Ã¼ber normalen Revert-PR zurÃ¼cknehmen; keine Produktionsdaten lÃ¶schen, historische Fill-IdentitÃ¤t umschreiben oder alte Receipts auf neuen Code umhÃ¤ngen. Kein Deploy Teil dieser Scannerbereinigung.

Nach freigegebenem Merge alle drei Dienste vollstÃ¤ndig auf **dem tatsÃ¤chlichen main-Merge-SHA** auswerten. PR-Neucode-Gates ersetzen keine Gesamtrepoanalyse. Neue Findings zurÃ¼ck in Stufe1â€“4; danach betroffene Regressionen und finalen Stand erneut prÃ¼fen.

## MaschinenprÃ¼fbare Abschlusskriterien

- [ ] VollstÃ¤ndige final-main-Exporte aller drei Dienste mit korrektem SHA, stabilen Analyse-IDs und erfolgreicher Analyzer-AusfÃ¼hrung vorhanden.
- [ ] Alle alten und neuen IDs exakt/case-sensitive zugeordnet, keine unbegrÃ¼ndete UnterdrÃ¼ckung oder verlorene Altbehebung; historische PrÃ¼fungslÃ¼cken geschlossen.
- [ ] Keine ungeklÃ¤rten echten Defekte und keine unbestÃ¤tigten `fix_pending`/`needs_investigation` auÃŸerhalb JS-R1005.
- [ ] BestÃ¤tigte FPs und beabsichtigte VertrÃ¤ge einzeln aktuell begrÃ¼ndet; akzeptierte Risiken separat sichtbar. Kein â€žalles behobenâ€œ fÃ¼r Ausnahmen.
- [ ] Backend, Python, Frontend, Browser, Mutationen, Build, Lint, Typen, Monitoring, Container- und Security-Gates auf passendem finalen Quellstand grÃ¼n.
- [ ] Receipts und Scannerentscheidungen unabhÃ¤ngig geprÃ¼ft; Quellen, Archiv, Runtime und Logs stimmen Ã¼berein.
- [ ] GeschÃ¼tzter Merge und vollstÃ¤ndige main-Nachkontrolle abgeschlossen; kein produktiver Rollout behauptet.

## Stop- und Eskalationspunkte

Fehlende Analyzerergebnisse, unerklÃ¤rte InventarlÃ¼cken, Beweis-/Quellhashdrift oder rote fachliche Tests verhindern die jeweilige Abschlussbehauptung. UnabhÃ¤ngige Pakete dÃ¼rfen weiterlaufen. Nach zwei erfolglosen zielgerichteten Reparaturversuchen Ursache/Scope neu prÃ¼fen statt weitere Autofixes stapeln. Ã„nderungen an Ownership, Schema, Ã¶ffentlichem API, Zertifizierungspolitik oder BÃ¶rsenverhalten, die Ã¼ber die genannten Korrekturen hinausgehen, brauchen einen neuen konkreten Review. Zugang/Anbieterkorrektur erst mit exakt benanntem benÃ¶tigten Schritt anfordern; keine Tokens im Chat.

Wartung: Ã„nderungen an Validatoren, Aufrufern, Promise-Verhalten, SDK-Version oder Scanner-Regelversion kÃ¶nnen eine bisher richtige Ausnahme ungÃ¼ltig machen. Darum Entscheidung an solche AbhÃ¤ngigkeiten binden und beim nÃ¤chsten relevanten Diff erneut prÃ¼fen. Ziel ist ein funktionierendes, nachvollziehbar geprÃ¼ftes Programm, nicht eine kÃ¼nstliche Null im Dashboard.
