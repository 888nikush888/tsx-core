# ADR 0010: Integriertes deklaratives Trading mit offiziellen Exchange-SDKs

## Status

Akzeptiert, 2026-07-17.

## Kontext

Validierte Telegram-XML-Signale sollen kanalweise und parallel in Futures-Trades auf Hyperliquid und Bybit umgesetzt werden. Die rohe Python-Fassung in `cb2.2` enthielt CLI-Menüs, frei gekoppelte Plugins, Float-Arithmetik, lokale Konfiguration und exchange-spezifische Clients. Das bestehende Produkt ist dagegen eine TypeScript-Control-Plane mit SQLite-Outbox, Web-UI, Audit, Docker, Backup und fail-closed Betriebsmodell. Ein zweites unabhängiges Programm hätte Identitäten, Zustände, Recovery und Observability geteilt und damit stille Doppelorders sowie unklare Positionshoheit ermöglicht.

## Entscheidung

- Trading ist Teil derselben TypeScript-Domäne, SQLite-Zustandsmaschine, Web-Control-Plane, Audit-Kette, Backup- und Monitoring-Landschaft.
- Ein „Plugin“ ist eine strikt validierte, versionierte und nach Publikation unveränderliche deklarative Strategie. Beliebiger Browser-Code, `eval`, dynamische Module und hochgeladene Python-/JavaScript-Dateien sind verboten. Neue Ausführungsalgorithmen werden als geprüfte Engine-Version implementiert; ihre Parameter bleiben vollständig über das Web steuerbar.
- Erlaubte Signal-Schemas sind persistente, benutzerverwaltete Profile. Eine unveränderliche Profil-ID verbindet ein Parser-Template ausschließlich mit einem der im Binary geprüften XML-Verträge. Profile können über Web-UI/API angelegt, bearbeitet, aktiviert/deaktiviert und gelöscht werden; aktive Routen schützen sie gegen Änderung/Löschung, unbekannte oder deaktivierte Profile sind fail-closed.
- Eine aktive Route pinnt genau `channel_id → strategy_version_id → account_id`. Mehrere Kanäle können parallel unterschiedliche Versionen nutzen. Pro Konto/Symbol darf nur eine aktive Position Owner sein.
- Geldwerte, Preise und Mengen bleiben kanonische Dezimalstrings; ausführbare Signalpaare benötigen `USD`, `USDC` oder `USDT` als Quote-Asset. Ein Trade benötigt einen bestätigten Protective Stop; unklare Orderausgänge, fremde Exposure oder fehlgeschlagene Reconciliation aktivieren fail-closed den Kill-Switch.
- Exits unterstützen zwei deklarative Modi: manuell exakt 100 Prozent plus konfiguriertes Break-even/Prozent-Trailing oder adaptive Halbierung der verbleibenden Position plus SL-Leiter (TP1/TP2 → Break-even, danach TP(i-2)). Der letzte TP schließt den Rest und der Stop darf sich nie verschlechtern.
- Der Kern bleibt TypeScript. Ein internes, nicht veröffentlichtes Python-Sidecar kapselt ausschließlich die offiziellen SDKs `hyperliquid-python-sdk` und `pybit`, weil hierfür keine gleichwertigen offiziellen TypeScript-SDKs freigegeben sind. Das Sidecar erhält Exchange-Secrets über ein read-only Volume, besitzt keine Host-Ports und akzeptiert nur einen rotierbaren internen Bearer-Key.
- Echtgeld benötigt eine einmalige explizite Web-Freigabe. Danach gibt es entsprechend der Produktentscheidung kein Human-in-the-loop pro Trade. Paper und Testnet bleiben der Standard.

## Konsequenzen

Strategie- und Schema-Profiländerungen sind reproduzierbar, auditierbar und rollback-fähig; beliebiger User-Code kann nicht die Container- oder Exchange-Rechte übernehmen. Ein Profilname oder Template allein erweitert niemals den ausführbaren Vertragsraum. Das Hinzufügen eines grundsätzlich neuen Algorithmus oder XML-Vertrags benötigt Code-Review, Tests, eine neue Engine-/Schema-Version und ein Release. Backups enthalten Schema-Profile, Strategie-, Routing-, Order- und Positionszustand, aber bewusst keine Exchange-Secrets; Restore erfordert daher erneutes Provisionieren und Verifizieren der Keys.

Die Profilverwaltung und adaptiven TP-/SL-Modi wurden am 22./23.07.2026 als additive Konkretisierung dieser Entscheidung umgesetzt. Der weiterhin offene Gesamtvergleich zum ursprünglichen Blueprint steht in `docs/TRADING_BLUEPRINT_V4_GAP_ANALYSIS.md`.
