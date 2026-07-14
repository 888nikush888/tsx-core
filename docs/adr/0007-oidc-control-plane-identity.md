# ADR 0007: OIDC-Identität für die Production-Control-Plane

## Status

Akzeptiert am 2026-07-14.

## Kontext

Zwei langlebige Shared Tokens unterscheiden zwar Administrator und Viewer, liefern aber keine Enterprise-Identität, zentrale Deaktivierung oder kurzlebige Credentials. Ein Audit-Record mit Shared-Token-Fingerprint kann keine konkrete IdP-Identität belegen.

## Entscheidung

Standalone-Prozesse verwenden den serverseitig erzeugten Token-Modus. `ENTERPRISE_MODE=true` wählt OIDC und startet nur mit HTTPS-Issuer, HTTPS-JWKS-URL, Audience und eindeutigem Admin-/Viewer-Rollenmapping. JWTs werden ausschließlich mit `RS256`, `PS256` oder `ES256` akzeptiert; Signatur, Issuer, Audience, Zeitgrenzen, `sub` und Rollen werden bei jeder Anfrage validiert. JWKS wird begrenzt gecacht und mit festen Timeouts geladen.

Es gibt keinen OIDC-Client-Secret im Forwarder. Ein TLS-/OIDC-Proxy darf ein Access-Token injizieren, muss dann aber jeden vom Client gelieferten `Authorization`-Header entfernen. Actor-IDs im Audit sind stabile SHA-256-Pseudonyme aus Issuer und Subject. Das Runtime-AI-System bleibt vollständig automatisch; OIDC betrifft nur Operatorzugriffe.

## Akzeptanzkriterien

- Falscher Issuer, Audience, Algorithmus, Signatur, Ablaufzeit oder Rolle ergibt HTTP 401.
- Admin- und Viewer-Rollen bleiben serverseitig getrennt; Viewer mutieren nie.
- Enterprise-Modus fällt ohne vollständige OIDC-Konfiguration beim Start aus.
- Browser speichert Access-Tokens höchstens im `sessionStorage`; ein Proxy-Modus benötigt dort kein Token.
- Audit-Records unterscheiden IdP-Subjects stabil, ohne das rohe Subject zu persistieren.
