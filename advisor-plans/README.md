# Sonar backlog implementation

## Aktueller Abschlussplan vom 20.09.2026

[004 — Codacy, DeepSource und Sonar stabil abschließen](004-final-findings-stability.md) ist der aktuelle Plan gegen `1f21249adc48f74bf139562e89ca261b14aebc27`. Er führt die noch offenen Scanner-Abschlussarbeiten der historischen Pläne unten zusammen und ersetzt deren veraltete Bestandszahlen. Status: **IN PROGRESS / Umsetzung läuft; [aktueller Nachweis](../docs/testing/final-findings-followup-2026-09-20.md).**

Reihenfolge: bestehende Backend-/Python-Prüffehler beheben → vollständiger Einzelabgleich einschließlich ignorierter und historisch geschlossener Befunde → kleine verhaltensbewahrende Korrekturen → finaler Test-/Quellnachweis → vollständige Cloudanalysen → geschützter Merge nach Veröffentlichungsauftrag → main-Nachscan. Codacy-Analyzerfehler sind eine sichtbare externe Abhängigkeit. JS-R1005 ist ausdrücklich ausgenommen; andere Regeln und Qualitätsgrenzen bleiben bestehen.

Frische API-Nachprüfung und Grenzen der heutigen Quellprüfung: [Begleitnachweise](2026-09-20-final-findings/). Alle drei Dienste analysieren weiterhin main `58c01bc7`, nicht den lokalen Kandidaten. Frühere False Positives werden nicht pauschal übernommen. Die 1.220 geschlossenen Sonar-IDs sind inzwischen einzeln mit Quellenbelegen klassifiziert; Reparaturabnahmen und aktuelle Scanner-Messungen bleiben offen. Der Plan und der Umsetzungsnachweis unterscheiden historische Reviews, lokale Tests und finale Cloud-Abnahme.

Nicht weiterverfolgt: große Refactorings ausschließlich wegen JS-R1005; syntaktisches Entfernen von async/Instanzmethoden trotz notwendiger Verträge; Umformen gültiger finally-Blöcke zur Umgehung von Analyzerabstürzen. Diese Ansätze erhöhen das Stabilitätsrisiko ohne belegten fachlichen Nutzen.

## Historische Pläne 001–003

Planned at `e03eacfa3ea482d3be56f731f970b58761dd2510` on 2026-09-07. The user explicitly requested all 672 open Sonar findings to be resolved and the GitHub repository to be brought up to date. These are three independent execution scopes; integration, receipts, publication and live Sonar verification belong to the root reviewer.

| Plan | Scope | Findings | Dependencies | Status |
| --- | --- | ---: | --- | --- |
| 001 | Frontend source and tests | 280 | none | IMPLEMENTED; browser follow-up and live Sonar pending |
| 002 | Backend TypeScript and JavaScript tests | 223 | none | IMPLEMENTED; integration and live Sonar pending |
| 003 | Python executor and tests | 169 | none | IMPLEMENTED; 542 tests passed, live Sonar pending |

Existing `plans/` contains unrelated implementation evidence and is preserved. The initial inventory is the verified final-main Sonar export from run 34104645000. Exact issue IDs and original locations are retained in each executor worktree's ignored `tmp/sonar-baseline.json`.

No quality threshold, licensed Sonar scope, existing acceptance policy, certification status, required GitHub review or branch protection may be weakened. No live exchange action or production deployment is part of this source cleanup. Real-provider acceptance remains separate. Root will independently review changes, rerun the relevant checks, renew truthful source/SDK implementation evidence and confirm the original issue IDs in a fresh Sonar analysis.

Individually evidenced analyzer false positives are handled separately from code fixes. The deprecated `beforeunload.returnValue` API is retained as an explicitly documented compatibility exception for browsers that need it; it is not described as an analyzer false positive. Source and regression-test hashes bind each reviewed decision before any Sonar issue transition. The final accounting must distinguish source fixes, false positives, this compatibility exception and any remaining open findings.
