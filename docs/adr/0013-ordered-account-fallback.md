# ADR 0013: Geordnete, exklusive Börsenkonto-Fallbacks

## Status

Akzeptiert am 2026-08-27.

## Kontext

Ein Signal kann ein Futures-Paar enthalten, das nicht auf jedem verbundenen Börsenkonto handelbar ist. Parallele Kontozweige lösen dieses Problem nicht: Sie würden jedes unterstützende Konto gleichzeitig handeln und benötigen für jeden Zweig eigenes Kapital. Ein stiller Wechsel nach beliebigen Fehlern wäre noch gefährlicher, weil ein Timeout oder unbekannter Submit-Ausgang denselben Trade auf mehreren Konten eröffnen könnte.

## Entscheidung

Workflow-Schema v2 führt den Kantentyp `account_fallback` ein. Er verbindet konkrete Kontobausteine pro Ursprungskanal zu einer strikt linearen, zyklenfreien und exklusiven Rangfolge. Der Compiler übernimmt Parser, Schema, Vertrag, Strategie, Sizing und adaptiven Risikobaustein des Primärpfads und ersetzt je Kandidat ausschließlich das Konto. Direkte parallele Route und Fallback-Kandidat dürfen für denselben Kanal nicht kollidieren.

Zur Laufzeit existiert pro Routengruppe ein persistenter Fallback-Lauf. Zunächst wird nur Rang 0 als Trade Intent angelegt. Der nächste Rang wird atomar und lazy erzeugt, ausschließlich wenn `/v1/market-snapshot` mit HTTP 422, `code=SYMBOL_UNAVAILABLE`, `sideEffects=false` und exakt passender Börsen-, Konto- und Symbolidentität antwortet. Konto-, Transport-, 502/503/504-, Timeout-, Risiko-, Vertrags- und Submitfehler stoppen die Kette. Sobald ein Markt unterstützt wird, gilt das Konto vor dem Submit als ausgewählt; ein später unbekannter Ausgang aktiviert kein weiteres Konto. Jeder Rang verwendet den ursprünglichen Laufzeitpunkt als Entry-TTL-Ursprung.

Migration 18 ergänzt die kompilierten Pfade um Routengruppe und Rang sowie die Tabellen `trading_fallback_runs` und `trading_fallback_candidates`. Bestehende Schema-v1-Graphen bleiben lesbar; beim Hinzufügen der neuen Kante werden alle Kanten explizit typisiert und der Graph als v2 gespeichert. Portable Setup-Bundles verwenden entsprechend Schema v2, akzeptieren während der Übergangszeit aber v1.

## Verworfene Alternativen

- Stringvergleich auf Exchange-Fehlermeldungen: nicht stabil, nicht identitätsgebunden und spoofbar.
- Vorab-Intents für alle Konten: erhöht Race-, Retry- und Doppelorder-Risiko.
- Wechsel bei jedem technischen Fehler: kann nach einem tatsächlich erfolgreichen, aber unbeantworteten Submit doppelte Exposure erzeugen.
- Globale Börsenrangfolge: kann die je Kanal gewünschte Strategie und Kontozuordnung nicht ausdrücken.

## Folgen und Rückweg

Fallback-Läufe, Kandidaten und der gewählte Rang sind in Dashboard, Analytics, MCP und Backups sichtbar. Retention löscht nur terminale vollständige Ketten zusammen mit ihren alten Intents; aktive Ketten bleiben erhalten. Ein Rollback auf eine ältere Binärversion ist wegen des versionierten Datenmodells nicht zulässig. Der sichere Rückweg besteht darin, die Fallback-Kanten in einer neuen Workflowrevision zu entfernen; Migration 18 und vorhandene Auditdaten bleiben dabei bestehen.

## Akzeptanzkriterien

- A → B → C kompiliert als eine exklusive Route mit den Rängen 0, 1 und 2.
- Nur exaktes, nebenwirkungsfreies `SYMBOL_UNAVAILABLE` erzeugt den nächsten Intent.
- Unterstützter Markt, Risk Gate, Kontofehler, 502/503/Timeout und Submitfehler erzeugen keinen weiteren Kandidaten.
- Equity, Kapazität und adaptiver Zustand stammen vom tatsächlich geprüften Konto; Entry-TTL und übrige Pfadkonfiguration bleiben geerbt.
- Sind alle Märkte nicht verfügbar, entsteht keine Order und der Lauf endet nachvollziehbar als `exhausted`.
- Migration, Backup, Retention, Setup-Bundle, API/MCP, Builder und Browserbedienung sind regressionsgetestet.
