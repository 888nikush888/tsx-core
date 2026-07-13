## Requirement und Scope

- Requirement/Issue:
- Acceptance Criteria:
- Nicht-Ziele:
- Betroffene ADRs:
- Owner:

## Risiko

| Faktor                          | Punkte | Evidenz |
| ------------------------------- | -----: | ------- |
| Kritische Domäne                |    0/5 |         |
| Auth/AuthZ/Secrets              |    0/5 |         |
| KI/automatische Nebenwirkung    |    0/5 |         |
| DB/Persistenz                   |    0/4 |         |
| Concurrency/Retry/Shutdown      |    0/4 |         |
| Public Contract                 |    0/3 |         |
| Test-/Coverage-Gap              |    0/3 |         |
| Neue Prod-Dependency/Base Image |    0/2 |         |
| >500 LOC                        |    0/2 |         |
| **Summe**                       |        |         |

- Erforderliches Review-Level:
- Rollback-Plan oder begründetes N/A:
- Risikoakzeptanz-Record: keine / Link

## Evidenz

- [ ] Tests für Happy Path und Fehlerzustände
- [ ] Timeout, Neustart, Duplikat, Teilfehler und ungültiger Input bewertet
- [ ] Lint, Typecheck, Coverage, Mutation und Architektur-Gate grün
- [ ] Security-, Secret-, Dependency-, Lizenz- und Container-Gates grün
- [ ] Build/SBOM verlinkt
- [ ] Staging-/E2E-Evidenz oder begründetes N/A
- [ ] Monitoring, Runbook und Changelog konsistent
- [ ] Traceability-Kette vollständig

## Daten- und Betriebsfolgen

- Migrations-/Downgrade-Plan:
- Backup-/Restore-Auswirkung:
- Neue Metriken/Alerts:
- Sichere Reconciliation bei unklarer Zustellung:
