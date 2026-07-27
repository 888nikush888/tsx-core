# TSX Core – Architektur und Fitness Functions

## Systemkontext

```mermaid
flowchart LR
  TG["Telegram/TDLib"] --> F["Forwarder"]
  F --> FL["Filter + Deduplizierung"]
  FL --> O["SQLite Inbox/Outbox"]
  O --> Q["Begrenzte Queue"]
  Q --> AI["Schema-validierter AI Parser"]
  AI --> OP["OpenRouter/OpenAI-kompatible API"]
  Q --> TG
  DB[("SQLite State")] --- O
  B["Backup Scheduler"] --> DB
  R["Bounded Retention"] --> DB
  W["Loopback Dashboard: Cockpit / Analytics / Logs"] --> F
  M["Loopback Health/Metrics"] --> F
  TS["Tailscale Serve: tailnet-only"] --> W
  RP["Optional TLS/OIDC Reverse Proxy"] --> W
  Admin["Admin/Viewer"] --> RP
  Admin --> TS
  IDP["OIDC Identity Provider/JWKS"] --> RP
  IDP --> W
  W --> AT["Local hash-chained audit"]
  AT --> AG["Immutable HTTPS audit gateway"]
  F --> TC["Trading Core + Risk Engine"]
  W --> SC["Versioned declarative signal contracts + profiles"]
  SC --> AI
  SC --> TC
  SC --> DB
  TC --> DB
  TC --> EX["Internal official-SDK executor"]
  EX --> HL["Hyperliquid official API"]
  EX --> BY["Bybit V5 official API"]
  HL --> WS["Normalized bounded WebSocket event stream"]
  BY --> WS
  WS --> TC
  TC --> J["Trade Journal + redacted export"]
  A["MCP Agent"] --> MS["Optional loopback MCP service"]
  MS --> DB
  MS --> CQ["Persistent MCP control requests"]
  CQ --> MB["Audited MCP control bridge"]
  MB --> TC
  TC --> EV["Execution-event stream"]
  EV --> MS
```

Trust Boundaries liegen an Telegram/TDLib, der externen KI-API, OIDC/JWKS beziehungsweise Tailscale Serve Identity, allen HTTP-Anfragen an Dashboard/Metriken/MCP, Agenten-Tokens, Prozessumgebung/Secrets, Host-Volumes und Backup-Replikation. Externe Eingaben werden vor einer Nebenwirkung validiert; ein unklarer Zustellstatus wird `unknown` und nie automatisch erneut gesendet. Dashboard, Metriken und MCP bleiben auf Host-Loopback; Tailscale Serve darf sie nur innerhalb des Tailnets veröffentlichen, Funnel ist ausgeschlossen.

## Komponenten und Verantwortungen

| Bereich      | Module                                                                                                                        | Verantwortung                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Entry Points | `forwarder.ts`, `mcp_server.ts`, `backup_cli.ts`, `migration_cli.ts`, `audit_cli.ts` | Lifecycle und Composition Roots |
| Core | `queue.ts`, `filters.ts`, `signal_schema.ts`, `signal_contract.ts`, `tdlib_retry.ts`, `delivery_tracker.ts`, `dashboard_auth.ts`, `crash_guard.ts`, `metrics_tracker.ts` | deterministische Regeln, Vertragsinterpreter und Zustandsmaschinen |
| State/Config | `db.ts`, `config.ts`, `env.ts`, `runtime_settings.ts`, `secret_store.ts` | persistente Verträge, Migrationen und Konfigurationsgrenzen |
| Adapter | `signal_parser.ts`, `web_server.ts`, `metrics.ts`, `logger.ts`, `backup.ts`, `backup_replication.ts`, `retention.ts`, `audit_trail.ts` | externe Provider, HTTP, Operator und Filesystem |
| Trading | `trading_types.ts`, `trading_strategy.ts`, `trading_risk.ts`, `trading_channel_risk.ts`, `trading_telemetry.ts`, `trading_engine.ts`, `trading_repository.ts`, `trading_runtime.ts`, `trading_web_control.ts`, `trading_credentials.ts`, `trade_journal.ts` | Verträge/Profile, adaptive Kanalgewichtung, Telemetrie, exakte Planung, Lifecycle, Reconciliation und Journal |
| Agenten | `mcp_repository.ts`, `mcp_control_bridge.ts`, `mcp_server.ts` | gehashte Agentenidentitäten, dauerhafte Minimalrechte, Preflight/Freigabe-Vorschläge, Streamable HTTP, Ereignis-Push und auditierte Befehlsübergabe |
| Exchange | `official_exchange.ts`, `exchange_stream_repository.ts`, `paper_exchange.ts`, `exchange_executor/` | Paper-Simulation, offizielle Hyperliquid-/Bybit-SDK-Grenze sowie deduplizierte Streambeschleunigung |

Erlaubte Richtung: `Entry Point → Adapter → Core/State`. Core importiert keine Adapter oder Entry Points. Kein Modul außerhalb des Composition Root importiert einen Entry Point. `db.ts` importiert kein internes Modul. Zirkuläre Imports sind verboten.

`npm run quality:architecture` prüft Auflösbarkeit lokaler Imports, diese Richtungen und Zyklen. Neue Schichten oder Ausnahmen benötigen vorab einen ADR und eine Erweiterung des ausführbaren Gates.

`npm run quality:frontend` startet beim einzigen Browser-Entry-Point `frontend/src/main.tsx`, verlangt Erreichbarkeit jedes produktiven TS/TSX-Moduls und gleicht alle Frontend-Produktivabhängigkeiten mit den tatsächlich erreichbaren Imports ab. Ambient-`*.d.ts`-Dateien und Build-Dependencies sind davon ausgenommen.

## Daten- und Zustellfluss

```text
Telegram update
  -> Inbox-Deduplizierung (chat_id, message_id)
  -> persistenter Outbox-Task: pending
  -> preparing
  -> optionaler AI-Aufruf: strikt validiertes + geerdetes XML
  -> sending
  -> TDLib send-succeeded: completed
  -> Prozessabbruch in sending: unknown (manuelle Reconciliation, kein Auto-Retry)
```

Konfiguration und Runtime-Einstellungen werden atomar via temporärer Datei, `fsync` und Rename geschrieben. Secrets kommen entweder aus externen Environment-/File-Mounts oder aus dem write-only `ManagedSecretStore`; extern verwaltete Werte bleiben im Web schreibgeschützt. Backups enthalten SQLite plus bereinigte Routing-Konfiguration, werden gehasht und vor Veröffentlichung geprüft; verschlüsselte Off-site-Objekte können über die Web-Control-Plane heruntergeladen, entschlüsselt und restore-verifiziert werden. Die Retention bereinigt nur finale Daten in begrenzten Transaktionen; ungeklärte Zustellzustände sind von automatischer Löschung ausgeschlossen.

## Trading-Zustandsfluss

Ein Signalvertrag ist ein eigenständiger, versionierter SQLite-Baustein. Seine deklarative Definition beschreibt XML-Pfade und Typen, Entry-/Target-Form, Zusatzfelder, Long-/Short-Geometrie und die gegen die Telegram-Quelle zu erdenden Werte. Entwürfe sind editier- und löschbar; publizierte Versionen bleiben immutable, können archiviert und ohne verbleibende Schema-Profilreferenz nach expliziter Bestätigung endgültig gelöscht werden. Ein benutzerverwaltetes Signal-Schema-Profil verbindet Parser-Template und Vertrag frei miteinander. Unbekannte, deaktivierte oder nicht publizierte Verknüpfungen sind fail-closed. Der XML-Validator akzeptiert für ausführbare Signale ausschließlich normalisierte Symbole mit `USD`, `USDC` oder `USDT` als Quote-Asset.

Trading-Signale werden nach persistierter Signalvalidierung über eine immutable Kanalroute in einen Trade Intent überführt. Der Intent wird exakt einmal geplant, jede Order besitzt eine deterministische Client-ID, und eine Position wird gemeinsam mit Entry, TP-Staffel und zwingendem Stop persistiert. Im adaptiven TP-Modus halbiert jeder TP bis zum vorletzten das verbleibende Volumen; der letzte schließt den Rest. Im adaptiven SL-Modus folgt nach TP1/TP2 Break-even und danach TP(i-2). Der konfigurierte Alternativmodus verwendet feste TP-Prozente, einen Break-even-Schwellwert und optionales Prozent-Trailing.

Teilgefüllte Entries werden bis zur maximal möglichen Entry-Menge geschützt; nach terminaler Füllung werden Stop und TPs exakt auf die reale Position skaliert. Der Reconciler gleicht Orders, Fills und Positionen mit der Exchange ab, passt den Stop an die Restmenge an und verschiebt ihn unabhängig vom Modus nur in Gewinnrichtung. Unbekannte Orderausgänge oder nicht vom System verwaltete Exchange-Exposure sperren neue Entries global.

Private Exchange-WebSockets liefern normalisierte Order-, Execution- und Positionsereignisse; öffentliche Ticker/Kerzen dienen der Beobachtung. Die Streams besitzen pro Konto einen begrenzten Cursorpuffer. Event-Schlüssel deduplizieren Wiederholungen, Cursor-Lücken markieren den Zustand als degradiert. Ein zustandsrelevantes Ereignis darf ausschließlich eine erzwungene REST-Reconciliation vorziehen; es darf niemals direkt den persistierten Order-/Fill-/Positionszustand mutieren. Periodische REST-Reconciliation bleibt auch bei Socket-Ausfall aktiv und autoritativ.

Das Trade Journal ist eine abgeleitete, read-mostly Sicht über Intents, Signal-/Vertrags-/Strategie-Provenienz, Positionen, Orders, Fills und Execution Events. Nur Review-Notizen, Tags, Bewertung und Review-Status werden separat gespeichert. Exporte hashen Chat-Identitäten, redigieren Quelltext-PII und neutralisieren Tabellenformeln. Ein vorhandener manueller Review schützt die zugehörige Trade-Historie vor operativer Standard-Retention.

Je Quellkanal kann eine feste, beobachtende oder automatische Risikopolice hinterlegt werden. Wöchentliche, aus geschlossenen managed Trades berechnete Evaluationen empfehlen beziehungsweise setzen eine Risikostufe, reduzieren schwache Kanäle oder blockieren sie nach der konfigurierten Serie. Manuelle Sperre und Stufenfixierung haben Vorrang. Das resultierende Kanalrisiko kann die Strategie nur weiter begrenzen, niemals globale Caps, Protective-Stop-Pflicht, Kill-Switch oder Exchange-Reconciliation aufheben.

## MCP-Kontrollfluss

```text
Bearer-Token -> SHA-256-Agentenprüfung -> aktuelles dauerhaftes Recht
  -> read-only Tool: begrenzte Repository-Abfrage
  -> ungefährliche Entwurfsänderung: Preflight -> auto-genehmigter persistenter Vorschlag
  -> sensible Konfigurationsänderung: Preflight -> wartender Vorschlag -> Admin-Freigabe
  -> unmittelbare Notfallaktion: persistente mcp_control_request
     -> Forwarder-Bridge prüft Agent/Recht erneut
     -> Vorab-Audit muss erfolgreich sein
     -> bestehende TradingWebControl-Sicherheitslogik
     -> Abschluss-Audit + persistentes Ergebnis
     -> MCP-Antwort und Agenten-Aktionshistorie
```

Der MCP-Prozess darf keine Exchange-Adapter instanziieren. Pro Sitzung werden Clientname, Version, Verbindungs-/Heartbeat-Zeit und Ende erfasst. Vorschläge sind 24 Stunden gültig, werden atomar geclaimt und behalten Preflight, Entscheider, Ergebnis und Fehler dauerhaft. Nach Prozessabbruch werden laufende Vorschläge als fehlgeschlagen markiert und nicht automatisch erneut ausgeführt. Wichtige persistierte Trading-Events werden anhand der Agenten-Abonnements als MCP-Logging-Nachrichten aktiv versendet und pro Ereignis/Agent/Sitzung dedupliziert. Fehlgeschlagene Zustellungen bleiben retryfähig.

## Versionsregeln

- Persistente Schemaänderungen brauchen Migrationstest, Downgrade-/Rollback-Plan und ADR.
- Neue externe HTTP-/Event-Verträge brauchen explizite Versionierung. Das Dashboard-HTTP-API bleibt intern; MCP ist die freigegebene, authentifizierte Agentenschnittstelle und verhandelt seine Protokollversion beim Handshake.
- Prompt, Template, Modell, Schema und Parser-Version bilden gemeinsam den KI-Vertrag.
- Container-Basis und GitHub Actions werden per vollständigem Digest/SHA gepinnt.
