# Zeitlich befristete Risikoakzeptanzen

Nur Dateien mit dem Namen `RA-<YYYYMMDD>-<slug>.md` sind Records. Kopiere die Vorlage, ersetze alle Werte und entferne den Record nach Behebung. Die Laufzeit darf 30 Tage nicht überschreiten; abgelaufene oder unvollständige Records blockieren CI.

```markdown
---
id: RA-20260713-example
owner: service-owner
approver: security-owner
created: 2026-07-13
expires: 2026-07-20
scope: exakte Komponenten und Versionen
gate: exakter Gate-Name
---

## Risk

Konkretes Schadensszenario und maximale Auswirkung.

## Evidence

Fundstelle, Test-/Scan-Ausgabe und Grund, warum das Gate derzeit nicht erfüllt ist.

## Compensating controls

Zeitlich wirksame Kontrollen, Monitoring und Stop-Bedingung.

## Exit criteria

Messbarer Nachweis, Verantwortlicher und spätester Fix-Termin.
```

Nicht akzeptierbar sind kritische Sicherheitslücken, ungetestete Migrationen, fehlender Rollback/Restore, kritische Flows ohne Test und ungeklärte irreversible KI-Aktionen.
