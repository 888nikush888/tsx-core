# TSX Core – GitHub Repository Governance

## Veröffentlichtes Modell

TSX Core wird in diesem persönlichen, privaten Repository direkt über den einzigen Branch `main` ausgeliefert. Es gibt keine zusätzliche GitHub-App, keinen privilegierten PR-Status-Publisher und keinen automatischen GitHub-Release- oder GHCR-Publisher.

Der Verzicht auf diese Zusatzautomation verändert weder den Programmumfang noch den Werkseinstellungszustand. Er bedeutet lediglich:

- Änderungen werden direkt nach lokaler Vollprüfung auf `main` veröffentlicht.
- GitHub Actions prüft den veröffentlichten Commit anschließend erneut.
- Release-Tags, GitHub Releases und Registry-Images werden nicht automatisch erzeugt.
- Automatische Dependabot-PRs sind deaktiviert, damit dauerhaft kein zusätzlicher Branch entsteht.

Security Alerts bleiben aktiviert. Abhängigkeiten werden weiterhin über die Lockfiles, `npm audit`, die Dependency-Policy, SBOMs und Trivy geprüft. CodeQL, Secret-History, Browser-/WCAG-Tests, Mutationstests und die übrigen Quality-OS-Gates bleiben unverändert aktiv. Staging-, Synthetic- und 30-Tage-Workflows sind bis zur Einrichtung realer Self-hosted Runner ausschließlich manuell auslösbar und erzeugen deshalb keine dauerhaft wartenden Zeitplanläufe.

## Aktueller Plattformstatus

Stand 09.08.2026 für `888nikush888/tsx-core`:

| Kontrolle | Status |
| --- | --- |
| Sichtbarkeit | privat |
| Default Branch | `main` |
| Branch-Modell | genau ein veröffentlichter Branch: `main` |
| CODEOWNERS | globaler, auflösbarer Owner `@888nikush888` |
| Quality OS | läuft auf `main`, Zeitplan und manueller Auslösung |
| Automatische Update-Branches | deaktiviert; `.github/dependabot.yml` wird nicht ausgeliefert |
| Automatischer Release-Publisher | nicht vorhanden |
| Zusätzliche GitHub Apps | nicht erforderlich und nicht vorhanden |
| Branch Protection/Rulesets | im aktuellen privaten Free-Repository nicht verfügbar |

Da Branch Protection im aktuellen Tarif nicht erzwungen werden kann, ist der direkte Push auf `main` eine bewusste Betreiberentscheidung. Vor jedem finalen Push müssen deshalb alle lokalen Gates auf demselben Snapshot grün sein; danach muss der Main-Lauf in GitHub Actions kontrolliert werden.

## Quality-Checks

`scripts/verify_github_governance.js` beschreibt den strengeren Zielzustand für eine spätere Plattform mit Branch Protection. Er erwartet dreizehn normale GitHub-Actions-Checks:

1. Hauptqualität, Tests, Coverage, Build und Supply Chain
2. vier Mutation-Shards
3. vier Browser-/Accessibility-Ziele
4. CodeQL
5. Secret-History
6. Dependency Review beziehungsweise den privaten Audit-Fallback
7. Container-, SBOM- und Vulnerability-Scan

Zusätzlich prüft das Skript CODEOWNERS, Reviewregeln, Repository-Security-Einstellungen und die Beschränkung des `production-observer`-Environments auf den Branch `main`. Es verwendet ausschließlich einen normalen, lesenden GitHub-Token. Benutzerverwaltete App-IDs oder Private Keys sind nicht vorgesehen; bei Required Checks wird lediglich GitHubs eingebaute Actions-Quelle erkannt.

```bash
npm run quality:github-governance
```

Auf dem aktuellen Tarif schlägt die Live-Abfrage der nicht verfügbaren Branch-Protection-API erwartungsgemäß fehl. Das ist transparent dokumentiert und kein Bestandteil des Programmstarts.

## Risikoanalyse

`scripts/calculate_pr_risk.js` und `scripts/check_risk_acceptances.js` bleiben als lokale Analysewerkzeuge erhalten. Sie bewerten kritische Domänen, Authentifizierung, Persistenz, Nebenwirkungen, Abhängigkeiten, Änderungsumfang und Governance-Dateien. Die tatsächliche Testabdeckung wird unabhängig davon durch Coverage- und Mutation-Gates gemessen. Es gibt keinen GitHub-Workflow, der daraus einen eigenen Commit-Status veröffentlicht.

Für umfangreiche oder sicherheitskritische Änderungen gilt organisatorisch:

- Diff und Rollback-Plan vor dem Push prüfen.
- einen zweiten fachkundigen Menschen einbeziehen, wenn verfügbar;
- Quality OS, Factory-Empty-Test und Container-Scans vollständig ausführen;
- Tokens niemals in Commits, Logs oder Dokumentation aufnehmen;
- einen fehlgeschlagenen Main-Lauf sofort korrigieren oder den Commit nachvollziehbar zurücknehmen.

## Branch- und Update-Betrieb

Das Repository hält nur `main`. Automatische Tools dürfen keine Update-Branches oder PRs erzeugen. Abhängigkeitsupdates werden gesammelt, lokal geprüft und direkt als getesteter Main-Commit veröffentlicht. GitHub Security Alerts dienen dabei als Hinweisquelle, erzeugen aber keine automatischen Änderungen.

Wenn später wieder mit mehreren Entwicklern, Pull Requests oder automatischen Releases gearbeitet werden soll, muss das Branch-Modell zuerst bewusst geändert und mit einem passenden GitHub-Tarif, Branch Protection, unabhängigen Reviews und einer getrennten Release-Pipeline neu entworfen werden.
