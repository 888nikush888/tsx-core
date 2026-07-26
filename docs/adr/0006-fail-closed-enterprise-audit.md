# ADR 0006: Fail-closed Enterprise-Audit-Trail

## Status

Akzeptiert am 2026-07-14.

## Kontext

Normale Prozesslogs sind rotierbar und auf demselben Host veränderbar. Sie beweisen deshalb weder vollständig noch manipulationssicher, wer eine Control-Plane-Nebenwirkung ausgelöst hat. Da Dashboard-Aktionen Routing, Konfiguration, Retry, Acknowledge und Löschung beeinflussen, ist eine nicht auditierte Mutation im Enterprise-Betrieb unakzeptabel.

## Entscheidung

Jede authentifizierte Mutation erzeugt vor der Nebenwirkung einen synchronen, lokal hashverketteten Audit-Record. In Produktion wird derselbe Record zusätzlich an einen authentifizierten HTTPS-Sink geliefert; nur ein 2xx nach dauerhafter externer Speicherung erfüllt den Vertrag. Scheitert lokale Persistenz, Kettenprüfung, Kapazitätsgrenze oder Vorabzustellung, wird die Mutation mit HTTP 503 blockiert. Das Ergebnis wird als zweiter Record geschrieben; ein Ergebnisfehler setzt Audit-Health und Readiness auf rot.

Actor-IDs werden aus dem Credential nur als gekürzter SHA-256-Fingerprint abgeleitet. Token, Request-Body, Nachrichteninhalt und Konfiguration werden nicht in Audit-Records geschrieben. Die lokale Kette ist ein Manipulationsnachweis und Kurzzeitpuffer, kein Ersatz für den unveränderlichen Off-host-Store.

## Akzeptanzkriterien

- Gleichzeitige Records sind lückenlos geordnet und kryptografisch verkettet.
- Änderung eines historischen Feldes wird beim nächsten Start erkannt.
- Fehlender oder ablehnender Produktions-Sink blockiert die Mutation vor ihrer Nebenwirkung.
- Abschlussstatus und Request-ID sind extern korrelierbar, ohne Secrets oder Payload zu persistieren.
- Audit-Ausfall ist Readiness- und Alert-relevant; lokales Wachstum ist hart begrenzt.

Ergänzung 26.07.2026: MCP-Schreibaktionen verwenden dieselbe Kette. Die Forwarder-Brücke muss `authorized` erfolgreich persistieren, bevor sie `TradingWebControl` aufruft, und schreibt danach `completed`; Agent, Sitzung und Kontrollanforderung bleiben zusätzlich in SQLite korrelierbar.
