# 005 — Aufbewahrung der Accounting-Evidenz

Stand 2026-09-02. Eng mit dem Accounting-Implementierer abgestimmte Kopplung der bestehenden operativen Retention, kein eigenständiger Archivierungsentwurf. Keine Konten/Strategieparameter geändert, keine reale Datenbereinigung ausgeführt.

Migration 36 bindet Accounting-Projektionen per FK-RESTRICT an ihre Intents. Der alte Prunepfad nahm abgeschlossene alte Intents trotzdem als Kandidaten auf, löschte zuvor eigene Fill-/Orderdaten und scheiterte anschließend am Fremdschlüssel. Neben dieser Sperre konnten noch nicht projizierte Legacy-Fills beziehungsweise Paper-Originaldaten verschwinden.

Die Kandidatenabfrage schließt jetzt vor dem Batchlimit Intents mit `trading_accounting_pending`, irgendeiner `trading_accounting_projections`-Zeile (auch complete), unveränderlicher `trading_accounting_projection_evidence`, direktem `trading_money_events`-Bezug oder eigenen `trading_fills` aus. Nicht exakt null befüllte eigene Orders gelten ebenfalls als weiter aufzuklärender Legacy-Beleg. Verbundene Signale sowie die vorhandenen Fallback-Schutzregeln bleiben damit wirksam. Keine FK-Regel gelockert; die explizite automatische Fill-Löschanweisung wurde entfernt.

Alte Paperorders werden nur ohne Befüllung, ohne `trading_paper_fills` und ohne verbleibenden eigenen Orderbezug im selben Account gelöscht. Remoteorder-ID oder Clientorder-ID reichen hier jeweils zum konservativen Aufbewahren; daraus entsteht keine neue Ownership. Vorhandene Paper-Fills bleiben als unabhängige Originalquelle für spätere Bewertung/Replay bestehen. Die frühere löschbare Testfixture war fälschlich filled/1; sie stellt jetzt den tatsächlich belegfreien cancelled/0-Fall dar.

`tests/test_retention_accounting.js` wurde zuerst am echten FK-RESTRICT-Prunefehler rot und danach grün. Der Test erhält sowohl vollständige als auch ungelöste Projektionen, Pendingarbeit, Money-Events, immutable Provenance, unbewertete Legacy-Fills ohne verfügbaren Pendingrecord sowie ursprüngliche Paperdaten unverändert über zwei Durchläufe. Ein tatsächlich belegfreier alter Intent und Paperorder werden weiterhin gelöscht. Der bestehende Retention-/Fallback-Test bleibt grün. Gezielt ESLint grün; Testregistrierung und gemeinsame Fullsuite bei Root.

Diese konservative Änderung archiviert und löscht keine Finanzbelege. Langfristiges Archivieren ganzer zusammenhängender Belegsätze erfordert einen separaten nachweisbaren Entwurf; complete ist keine automatische Löschfreigabe.
