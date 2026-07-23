# TSX Core – GitHub Repository Governance

## Verbindlicher Zielzustand

Der Release-Workflow fragt die GitHub-API ab und blockiert, bis alle folgenden externen Kontrollen tatsächlich aktiv sind:

- `main` verlangt die 13 Quality-OS-Checks aus `scripts/verify_github_governance.js` auf dem aktuellen Base-Branch: Hauptqualität, vier Mutation-Shards, vier Browser-/Accessibility-Jobs, CodeQL, Secret-History, Dependency Review und Container/SBOM/Vulnerability Scan.
- Mindestens zwei Approvals, CODEOWNERS-Review, Last-Push-Approval, Dismissal veralteter Reviews und Conversation Resolution sind aktiv.
- Regeln gelten auch für Administratoren; Force Push und Branch-Löschung sind deaktiviert.
- Dependency Graph, Secret Scanning und Secret Push Protection sind aktiv.
- Die Environments `staging` und `production-observer` existieren und enthalten ausschließlich die in den Runbooks beschriebenen Secrets/Variablen.
- `.github/CODEOWNERS` enthält reale, auf GitHub auflösbare Benutzer oder Teams; `/codeowners/errors` liefert für den Default Branch keine Fehler.

Diese Einstellungen können nicht ohne nachgewiesene Owner-Identität sicher erfunden werden. Vor dem ersten Release legt der Repository-Administrator `.github/CODEOWNERS` mit den realen Verantwortlichen an, aktiviert die Kontrollen in GitHub und führt den Release-Gate erneut aus. Ein Dummy-Owner, Shared Account oder eine nicht auflösbare Teambezeichnung erfüllt das Gate nicht.

## Aktuell verifizierter Plattformstatus

Stand 23.07.2026 für das private Repository `888nikush888/tsx-core`:

| Kontrolle | Status |
| --- | --- |
| Remote und Default Branch | vorhanden; privat; `main` |
| Quality Workflow | Run `30002905392` für Commit `8f7e0ba` einschließlich CodeQL, Browsermatrix, Secret Scan und Container-Gate erfolgreich |
| Branch Protection | nicht verfügbar/prüfbar: GitHub antwortet mit HTTP 403 und verlangt für dieses private Repository GitHub Pro oder ein öffentliches Repository |
| CODEOWNERS | nicht gültig: die eingetragenen `@enterprise/*`-Teams existieren für dieses Repository nicht; `/codeowners/errors` meldet „Unknown owner“ |
| Environments | `staging` vorhanden; `production-observer` fehlt |
| Governance-Gate | fehlgeschlagen; damit kein Production-GO und kein attestierter Release |

Behebung: einen geeigneten GitHub-Tarif beziehungsweise eine Organisation mit den benötigten Private-Repository-Funktionen verwenden, reale Owner eintragen, `production-observer` anlegen, die 13 Required Checks und Review-Regeln aktivieren und anschließend `npm run quality:github-governance` erneut ausführen. Das erfolgreiche normale Quality-CI ersetzt diese Plattformkontrollen nicht.

## Ownership-Schnitt

Mindestens folgende Pfade erhalten zusätzlich zum globalen Owner fachliche Security-/Operations-Owner:

| Pfad | Erforderliche Verantwortung |
| --- | --- |
| `/src/dashboard_auth.ts`, `/src/web_server.ts`, `/src/audit_trail.ts`, `/.github/` | Security und Plattform |
| `/src/db.ts`, `/src/backup*.ts`, `/src/retention.ts` | Data Owner und SRE |
| `/src/signal_*.ts`, `/templates/`, `/tests/fixtures/signal_golden_set.json` | AI-/Domain-Owner |
| `/Dockerfile`, `/docker-compose*.yml`, `/monitoring/`, `/docs/runbooks/` | SRE/On-Call |

Owner-Änderungen erfolgen über einen PR und benötigen Review eines bereits gültigen Owners. Im verbindlichen Zielzustand bleiben direkte Änderungen auf `main` gesperrt. Der aktuell verifizierte Plattformstatus erfüllt diese Voraussetzung noch nicht.

## Automatischer PR-Risikowert

`scripts/calculate_pr_risk.js` bewertet den tatsächlichen Git-Diff, nicht eine Selbsteinschätzung. Der Workflow speichert Score, Faktoren, geänderte Zeilen und erforderliches Verfahren unter `reports/pr-risk/`. Die Stufen entsprechen `docs/QUALITY_OS.md`; Änderungen ohne Regressionstest erhalten automatisch den Test-Gap-Zuschlag.

## Dependency- und Security-Betrieb

Dependabot öffnet wöchentlich getrennte Updates für Backend, Frontend, GitHub Actions und Docker. Jeder PR durchläuft unverändert alle Gates; Major-Updates werden nicht gruppiert. Sicherheitsmeldungen werden ausschließlich nach `SECURITY.md` privat behandelt. Ein automatisches Update ist kein Freigabenachweis und darf Quality-, Staging- oder Rollback-Gates nicht umgehen.

## Verifikation

Innerhalb eines GitHub Actions Release-Jobs:

```bash
npm run quality:github-governance
```

Das Ergebnis wird als `reports/governance/github-governance.json` in das unveränderliche Release aufgenommen. Lokal ohne `GITHUB_REPOSITORY` und ein berechtigtes `GH_TOKEN` schlägt die Prüfung absichtlich fehl und darf nicht als bestanden dokumentiert werden. Scheitert bereits eine GitHub-API-Abfrage – beispielsweise Branch Protection mit HTTP 403 –, wird kein vollständiger Evidence-Record erzeugt; auch dieser Zustand ist ein fehlgeschlagenes Gate.
