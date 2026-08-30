# Phase 4 – Getrennter Telegram Viewer

## Phase

Phase 4 der Master-Gesamtspezifikation: separater, read-only Telegram-Bot mit eigener Delivery-State-DB, dediziertem Secret- und Netzwerkbereich sowie einer ausschließlich lesenden internen Core-API.

## Ausgangs- und Endstand

- Ausgangsstand: `9351026` (abgeschlossene Phase 3).
- Funktions- und Qualitätsstand: `8217ff3`.
- Diese Übergabe folgt als eigener Dokumentationscommit.

## Architektur und Sicherheitsgrenzen

```text
Telegram Bot API
        │ Long Polling
        ▼
telegram-viewer ── authenticated GET ──► forwarder /internal/viewer/v1/*
        │                                      │
        │                                      ├─ persistierte Read-Models
        │                                      ├─ Settings
        │                                      └─ Notification-/Testevents
        ├─X exchange-executor
        ├─X MCP
        ├─X Trading-/Exchange-Secrets
        └─X Handels- oder Konfigurationsmutationen
```

- Der Viewer hängt ausschließlich im `viewer-network`; Executor und MCP bleiben im `core-network`.
- Das dedizierte Secret-Volume enthält nur `bot_token` und `viewer_service_token` und ist im Viewer read-only.
- Der Container ist read-only, nutzt `/tmp` als tmpfs, verliert alle Capabilities, setzt `no-new-privileges`, besitzt Ressourcenlimits und veröffentlicht keinen Host-Port.
- Die interne API akzeptiert ausschließlich das getrennte Service-Token, vergleicht es constant-time und erlaubt nur GET.
- Dashboard-Tokens funktionieren nicht auf der internen API; das Viewer-Token funktioniert weder auf `/api/*` noch auf Trading-, Executor- oder MCP-Pfaden.
- Telegram-Netzwerkzugriffe existieren nur im separaten Viewer-Prozess, nie in Trading-Transaktionen.

## Datenhaltung und Contracts

- Migration 21 ergänzt `trading_notification_events` und `telegram_viewer_test_events` inklusive Indizes und DB-Feature-Metadaten.
- Notification-Events besitzen einen monotonen `seq`-Cursor, strikt validierte Event-Typen, begrenzte Details und deterministische Dedupe-Keys.
- Bestehende `trading_execution_events` und Analytics bleiben unverändert.
- `ManagedTelegramViewerSettingsStore` schreibt begrenzt, symlink-sicher, per temporärer Datei, fsync und atomarem Rename.
- `TelegramViewerSecretStore` erzeugt und rotiert das Service-Token serverseitig; Klartext wird nie an UI, Status oder Audit zurückgegeben.
- `/app/state/viewer_state.db` speichert Telegram-Offset, Event-/Test-Cursor, per-user Delivery-Keys, Retries und letzten Testzustand.
- Delivery erfolgt at least once, wird erst nach Telegram-Bestätigung erledigt und nutzt begrenzten Backoff.

## APIs

Web-Control:

- `GET /api/telegram-viewer`
- `POST /api/telegram-viewer/settings`
- `POST /api/telegram-viewer/token`
- `DELETE /api/telegram-viewer/token`
- `POST /api/telegram-viewer/service-token/rotate`
- `POST /api/telegram-viewer/test`

Interne, strikt GET-only Projektionen:

- `/internal/viewer/v1/config`, `/summary`, `/system`
- `/accounts`, `/accounts/:id`
- `/positions`, `/positions/:id`
- `/orders`, `/orders/:id`
- `/trades`, `/trades/:id`
- `/performance`, `/risk`, `/incidents`
- `/events`, `/test-events`

Listen sind serverseitig begrenzt und paginiert. Read-Models enthalten weder Credential-Referenzen noch API-/Wallet-/Dashboard-/Executor-/MCP-Secrets oder rohe authentifizierte Börsenantworten.

## Bot-Verhalten

- Ausschließlich numerische User-ID-Allowlist und private Chats.
- Long Polling mit persistentem Offset; kein Webhook.
- Menü für Übersicht, Konten, Positionen, Orders, Trades, Performance, Risiko, System, Events und Aktualisieren.
- Keine Action-Buttons und keine frei interpretierbaren Callback-Kommandos.
- Unbekannte Befehle liefern nur einen neutralen Viewer-Hinweis.
- Formatter sind rein, begrenzen Telegram-Nachrichten auf 4096 Zeichen und unterstützen Pagination.
- Dynamische Börsen bleiben opaque Strings. Reporting Currency kommt aus Account-Capabilities.
- Neue Hebelpläne zeigen Effective, Requested, Source und CappedBy; Legacy-Pläne zeigen weiterhin `leverage`.

## Benachrichtigungen

Erfasst werden unter anderem Positionseröffnung/-schluss, Partial-/TP-/SL-Fills, Stop-Verschiebung, blockierte Intents, Ausführungs- und Reconciliation-Fehler, Account-Incidents, Stream-Degraded/Recovered, Kill-Switch sowie optionale Signal-/Intent-/Exchange-Ack-Ereignisse.

Die zentrale Persistenz ist best-effort: Ein ungültiges oder nicht speicherbares Viewer-Event wird protokolliert, verändert aber nie den autoritativen Trading-Zustand. Fills behalten ihre Exchange-Fill-ID in der Dedupe-Identität.

## Web UI

Der Bereich `Betrieb` enthält den Telegram-Viewer mit getrennten Abschnitten:

- Status
- Allgemein
- Zugriff
- Benachrichtigungen
- Darstellung
- Bot-Token
- Diagnose
- Testnachricht

Viewer-Rollen dürfen ungefährlichen Status lesen. Aktivieren, Deaktivieren, Tokenverwaltung, Allowlist, Notification-Schalter, Service-Token-Rotation und Testevents sind Admin-only und auditiert.

## Testergebnisse

- Backend: 70/70 Testdateien bestanden.
- Frontend: 17/17 Testdateien, 101/101 Tests bestanden.
- Python-Executor: 41/41 Tests bestanden.
- Kritische Backend-Coverage: 97,47/89,03/100/97,47 %.
- Modul-Coverage lokal: 95,37/83,35/99,20/95,37 %; gemeinsamer Ratchet 95,01/83,33/99,09/95,01 %.
- Frontend-Coverage: 62,43/56,10/54,49/63,27 %.
- Python-Coverage: 74 %.
- Architektur: 73 Module, 228 interne Imports, 0 Zyklen.
- Komplexität: 0 Warnungen, Worst-Case 15, keine Funktion über 100 Zeilen.
- Duplikation: 0,97 % bei 5-%-Grenze.
- Build, Lint, Typecheck, SBOM, Audits und Compose-Konfiguration: PASS.

Die vollständige TDD- und Anforderungsmatrix steht in `docs/testing/phase-4-telegram-viewer.tdd.md`.

## Betriebs- und Rollout-Hinweise

- Vor einem späteren Server-Rollout ein verifiziertes Backup erzeugen.
- Viewer-Secret-Volume und Viewer-State-Volume persistent bereitstellen; keine Trading-Secrets hinein kopieren.
- Service-Token wird intern erzeugt. Betreiber müssen ihn nicht kennen.
- Bot-Token und numerische Telegram-User-ID werden ausschließlich im Web-UI gesetzt.
- Nach Aktivierung Testnachricht auslösen und `lastTestEventId`/`lastTest` im Status prüfen.
- Ein deaktivierter oder gestörter Viewer beeinträchtigt Telegram-Signalempfang und Trading nicht.
- Für diese Phase wurde kein Server verändert und kein Release/Tag angelegt.

## Offene TODOs

Keine funktionalen Phase-4-TODOs. Container-, Browser-, Mutation-, CodeQL- und Sonar-Nachweise werden durch den exakten GitHub-`main`-Workflow abgeschlossen.

