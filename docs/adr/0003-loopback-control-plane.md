# ADR 0003: Loopback-Control-Plane mit Rollen

- Status: Accepted
- Datum: 2026-07-13

## Kontext

Das Dashboard kann Routing, Konfiguration, Outbox und Datenbank beeinflussen. Direkte Netzexposition ohne Authentifizierung würde Remote-Control, Datenverlust und Secret-Leaks ermöglichen.

## Entscheidung

Dashboard und Metriken binden standardmäßig an Loopback. `/api/*` verlangt konstante Bearer-Token-Prüfung mit `admin`/`viewer`; mutierende und destruktive Aktionen sind rollen- und bestätigungsgebunden. Remote-Zugriff erfolgt nur über einen TLS-Reverse-Proxy mit exakter Origin-Allowlist.

## Konsequenzen

Secrets werden nie angezeigt oder in die normale Konfiguration/Backups aufgenommen. Die spätere webbasierte write-only Verwaltung und der Erststart-Token sind in ADR 0008 konkretisiert. Ein extern exponierter Port ohne den dokumentierten Proxy ist nicht unterstützt und macht Readiness nicht zur Sicherheitsgarantie.
