# Repository-Pflege am 07.09.2026

Auf ausdrücklichen Auftrag des Repository-Inhabers wurden 286 veraltete GitHub-Deploymentdatensätze entfernt: 269 für `staging` und 17 für `production-observer`. Jeder Datensatz hatte als letzten Zustand `ERROR`; in keinem Datensatz war eine Deployment-URL hinterlegt. Die Datensätze stammten aus fehlgeschlagenen bzw. abgebrochenen Actions-Läufen bis zum 09.08.2026.

Vor der Löschung wurden sämtliche 286 Datensätze und ihre 574 Statusereignisse vollständig lokal archiviert. Die gelöschten IDs wurden einzeln protokolliert und anschließend über die GitHub-API auf null verbleibende Datensätze geprüft. Dies bereinigt die GitHub-Anzeige. Server, Container, Volumes, Environment-Konfigurationen und historische Release-Tags wurden dabei nicht verändert.

Die lokalen Archive tragen folgende SHA-256-Prüfsummen:

| Archiv | SHA-256 |
| --- | --- |
| `github-deployment-metadata-archive.json` | `41af6beb94c96ecdcf75f8468e0483ebd42e0b8e19b02b5fe6edc05c0455af82` |
| `github-deployment-status-archive.json` | `d1d20bc6f4325fb7d387a1dc1ec39f6dfdfd4b57965cfb36ba346c4e0dadd9d0` |
| `github-deployment-cleanup-ledger.json` | `d60d0ef634744144563752bac6f16420d1d24c8e9e284519a89fc7d0bf9c0816` |

Die Workflows für Staging-, Synthetic- und Produktionsnachweise bleiben bewusst manuell auslösbar. Ihre Ergebnisse sind anhand des jeweiligen Actions-Laufs und des tatsächlich untersuchten Systems zu beurteilen. Das Repository veröffentlicht durch einen normalen Quellcode-Push keinen neuen Serverstand.

Die README verweist auf die aktuellen CI- und Sonar-Ergebnisse und beschreibt die vorhandene konfigurierbare Fallback-Policy. Historische Releases behalten ihre ursprünglichen Versionen und Commits.

Für die Sonar-Bestandsbereinigung wird vor dem geschützten Merge eine vollständige Analyse des tatsächlichen Arbeitsbranches verwendet. Sonar muss ihn als `LONG` ausweisen; Commit, Compute Task, Analyse-ID und Branchidentität müssen zusammenpassen. PR- und `SHORT`-Analysen betrachten nur neu eingeführte Meldungen und reichen zur Bestätigung eines abgearbeiteten Altbestands nicht aus. Die abschließende Bestätigung erfordert zusätzlich null offene Meldungen im vollständigen Export.
