# ADR 0010: Integriertes deklaratives Trading mit offiziellen Exchange-SDKs

## Status

Akzeptiert, 2026-07-17.

## Kontext

Validierte Telegram-XML-Signale sollen kanalweise und parallel in Futures-Trades auf Hyperliquid und Bybit umgesetzt werden. Die rohe Python-Fassung in `cb2.2` enthielt CLI-Menüs, frei gekoppelte Plugins, Float-Arithmetik, lokale Konfiguration und exchange-spezifische Clients. Das bestehende Produkt ist dagegen eine TypeScript-Control-Plane mit SQLite-Outbox, Web-UI, Audit, Docker, Backup und fail-closed Betriebsmodell. Ein zweites unabhängiges Programm hätte Identitäten, Zustände, Recovery und Observability geteilt und damit stille Doppelorders sowie unklare Positionshoheit ermöglicht.

## Entscheidung

- Trading ist Teil derselben TypeScript-Domäne, SQLite-Zustandsmaschine, Web-Control-Plane, Audit-Kette, Backup- und Monitoring-Landschaft.
- Ein „Plugin“ ist eine strikt validierte, versionierte und nach Publikation unveränderliche deklarative Strategie. Beliebiger Browser-Code, `eval`, dynamische Module und hochgeladene Python-/JavaScript-Dateien sind verboten. Neue Ausführungsalgorithmen werden als geprüfte Engine-Version implementiert; ihre Parameter bleiben vollständig über das Web steuerbar.
- Eine aktive Route pinnt genau `channel_id → strategy_version_id → account_id`. Mehrere Kanäle können parallel unterschiedliche Versionen nutzen. Pro Konto/Symbol darf nur eine aktive Position Owner sein.
- Geldwerte, Preise und Mengen bleiben kanonische Dezimalstrings. Ein Trade benötigt einen bestätigten Protective Stop; unklare Orderausgänge, fremde Exposure oder fehlgeschlagene Reconciliation aktivieren fail-closed den Kill-Switch.
- Der Kern bleibt TypeScript. Ein internes, nicht veröffentlichtes Python-Sidecar kapselt ausschließlich die offiziellen SDKs `hyperliquid-python-sdk` und `pybit`, weil hierfür keine gleichwertigen offiziellen TypeScript-SDKs freigegeben sind. Das Sidecar erhält Exchange-Secrets über ein read-only Volume, besitzt keine Host-Ports und akzeptiert nur einen rotierbaren internen Bearer-Key.
- Echtgeld benötigt eine einmalige explizite Web-Freigabe. Danach gibt es entsprechend der Produktentscheidung kein Human-in-the-loop pro Trade. Paper und Testnet bleiben der Standard.

## Konsequenzen

Strategieänderungen sind reproduzierbar, auditierbar und rollback-fähig; beliebiger User-Code kann nicht die Container- oder Exchange-Rechte übernehmen. Das Hinzufügen eines grundsätzlich neuen Algorithmus benötigt Code-Review, Tests, eine neue Engine-/Schema-Version und ein Release. Backups enthalten Strategie-, Routing-, Order- und Positionszustand, aber bewusst keine Exchange-Secrets; Restore erfordert daher erneutes Provisionieren und Verifizieren der Keys.
