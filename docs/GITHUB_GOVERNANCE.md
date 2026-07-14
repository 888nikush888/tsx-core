# GitHub Repository Governance

## Verbindlicher Zielzustand

Der Release-Workflow fragt die GitHub-API ab und blockiert, bis alle folgenden externen Kontrollen tatsächlich aktiv sind:

- `main` verlangt die sieben Quality-OS-Checks aus `scripts/verify_github_governance.js` auf dem aktuellen Base-Branch.
- Mindestens zwei Approvals, CODEOWNERS-Review, Last-Push-Approval, Dismissal veralteter Reviews und Conversation Resolution sind aktiv.
- Regeln gelten auch für Administratoren; Force Push und Branch-Löschung sind deaktiviert.
- Dependency Graph, Secret Scanning und Secret Push Protection sind aktiv.
- Die Environments `staging` und `production-observer` existieren und enthalten ausschließlich die in den Runbooks beschriebenen Secrets/Variablen.
- `.github/CODEOWNERS` enthält reale, auf GitHub auflösbare Benutzer oder Teams; `/codeowners/errors` liefert für den Default Branch keine Fehler.

Diese Einstellungen können nicht aus einem Repository ohne GitHub-Remote und ohne nachgewiesene Owner-Identität sicher erfunden werden. Vor dem ersten Release legt der Repository-Administrator `.github/CODEOWNERS` mit den realen Verantwortlichen an, aktiviert die Kontrollen in GitHub und führt den Release-Gate erneut aus. Ein Dummy-Owner, Shared Account oder eine nicht auflösbare Teambezeichnung erfüllt das Gate nicht.

## Ownership-Schnitt

Mindestens folgende Pfade erhalten zusätzlich zum globalen Owner fachliche Security-/Operations-Owner:

| Pfad | Erforderliche Verantwortung |
| --- | --- |
| `/src/dashboard_auth.ts`, `/src/web_server.ts`, `/src/audit_trail.ts`, `/.github/` | Security und Plattform |
| `/src/db.ts`, `/src/backup*.ts`, `/src/retention.ts` | Data Owner und SRE |
| `/src/signal_*.ts`, `/templates/`, `/tests/fixtures/signal_golden_set.json` | AI-/Domain-Owner |
| `/Dockerfile`, `/docker-compose*.yml`, `/monitoring/`, `/docs/runbooks/` | SRE/On-Call |

Owner-Änderungen erfolgen über einen PR und benötigen Review eines bereits gültigen Owners. Direkte Änderungen auf `main` bleiben gesperrt.

## Automatischer PR-Risikowert

`scripts/calculate_pr_risk.js` bewertet den tatsächlichen Git-Diff, nicht eine Selbsteinschätzung. Der Workflow speichert Score, Faktoren, geänderte Zeilen und erforderliches Verfahren unter `reports/pr-risk/`. Die Stufen entsprechen `docs/QUALITY_OS.md`; Änderungen ohne Regressionstest erhalten automatisch den Test-Gap-Zuschlag.

## Dependency- und Security-Betrieb

Dependabot öffnet wöchentlich getrennte Updates für Backend, Frontend, GitHub Actions und Docker. Jeder PR durchläuft unverändert alle Gates; Major-Updates werden nicht gruppiert. Sicherheitsmeldungen werden ausschließlich nach `SECURITY.md` privat behandelt. Ein automatisches Update ist kein Freigabenachweis und darf Quality-, Staging- oder Rollback-Gates nicht umgehen.

## Verifikation

Innerhalb eines GitHub Actions Release-Jobs:

```bash
npm run quality:github-governance
```

Das Ergebnis wird als `reports/governance/github-governance.json` in das unveränderliche Release aufgenommen. Lokal ohne `GITHUB_REPOSITORY` und ein berechtigtes `GH_TOKEN` schlägt die Prüfung absichtlich fehl und darf nicht als bestanden dokumentiert werden.
