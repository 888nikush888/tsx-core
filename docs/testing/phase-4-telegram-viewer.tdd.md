# Phase 4: TDD-Nachweis für den Telegram Viewer

## Quelle und Ziel

Quelle ist Phase 4 der Master-Gesamtspezifikation `TSX-Core_4-Plans_MASTER-Gesamtspezifikation_KEINE-SUBAGENTS.md`.

Der Telegram Viewer ist ein technisch getrennter, ausschließlich lesender Dienst. Er zeigt persistierten TSX-Core-Zustand und Benachrichtigungen an, besitzt aber weder Handels- noch Konfigurationsbefehle, Executor-/MCP-Zugriff oder Börsenzugang. Telegram-Ausfälle dürfen den Trading-Pfad niemals blockieren.

## RED/GREEN-Checkpoints

| Vertrag | RED | GREEN |
|---|---:|---:|
| Event-, Settings-, Secret- und Read-Model-Grundverträge | `0394e88` | `36ee7e8` |
| Authentifizierte, strikt GET-only interne Viewer-API | `0aaf327` | `2a825e5` |
| Persistente At-least-once-Auslieferung und Retry-Vertrag | `d69cac1` | `4738d82` |
| Prozess-, Runtime- und Architekturgrenzen | `39a9133`, `ac783e5` | `4738d82`, `eb9bcf2` |
| Operations-UI | `9af7678` | `3299e72` |
| Nicht blockierende Notification-Aufzeichnung | `e2cda0f` | `4739ad7` |
| Trading-Lifecycle-Ereignisse | `7d06829` | `fbeae5d` |
| Runtime, Health, Menü und Formatter | `f4c5dde` | `2592b03` |
| Vollständige Sicherheitsmatrix und Kill-Switch-Ereignisse | `60b2b9c` | `30408bc` |
| Serverseitige Pagination und getrennte UI-Abschnitte | `b20313d` | `b121a04` |
| Secret-Mount- und Runtime-Grenzen | `fa6bdec` | `332dcae` |
| Begrenzte, resiliente Laufzeitschleifen | `3b88758` | `332dcae` |
| Komplexitäts-, Struktur- und Qualitätsgrenzen | bestehende Quality-Gates | `cf019c9`, `8217ff3` |
| Vertrauensgebundener interner Transport und Sonar-Abschluss | `f4dabc0` | `e1b41f7` |

Die RED-Tests wurden vor den jeweiligen Produktionsänderungen festgehalten. Der abschließende Refactor verändert keine Handelssemantik; er hält das bestehende Null-Warnungen-Komplexitätsbudget ein und wird durch dieselben Integrations- und Coverage-Tests abgesichert. Die internen Viewer-Endpunkte sind nun zwingend explizit konfiguriert: HTTPS ist allgemein zulässig, Klartext-HTTP ausschließlich für die eng begrenzten Container- und Loopback-Peers. Eingebettete URL-Zugangsdaten, fremde Klartext-Hosts und andere Protokolle werden fail-closed abgewiesen.

## Anforderungsabdeckung 1–58

| # | Erfüllte Anforderung | Nachweis |
|---:|---|---|
| 1 | Viewer-only Scope ohne Trading-, Config-, Kill-Switch-, Close- oder Cancel-Befehle | Menü-/Callback-Allowlist, Architektur- und Security-Tests |
| 2 | Separater Datenfluss Bot API → Viewer → authentifizierte Core-Read-API | `src/telegram_viewer/*`, interne API-Tests |
| 3 | Getrennte `core-network`/`viewer-network`-Grenzen; Viewer nur im Viewer-Netz | Compose- und Deployment-Boundary-Test |
| 4 | Keine neue Forwarder/Executor-Startup-Verklemmung | Compose-Vertragstest |
| 5 | Kleiner Node-/TypeScript-Dienst mit nativem `fetch`, ohne Telegram-Bibliothek | Runtime- und Dependency-Gate |
| 6 | Dediziertes Secret-Volume nur für Bot- und Service-Token | Compose-/Secret-Boundary-Test |
| 7 | Eigene Secret-Pfade, kein Trading-Secret-Store | Secret-Store- und Runtime-Test |
| 8 | Zufälliges, rotierbares und nie offengelegtes Service-Token | Secret- und API-Tests |
| 9 | Constant-time Bearer-Prüfung, GET-only und keine Dashboard-Token-Substitution | API-Sicherheitsmatrix |
| 10 | Separater atomarer, begrenzter und symlink-sicherer Settings-Store | Core-Vertragstests |
| 11 | Vollständiger Settings-Contract mit Notifications und Darstellung | Validierungs-Grenzfalltests |
| 12 | Ausschließlich numerische Telegram-User-IDs | Settings- und Bot-Auth-Tests |
| 13 | Nur private Chats und passende `from.id` | Bot-Auth-Matrix für private/group/supergroup/channel |
| 14 | Bot-Token setzen, ersetzen, löschen; Status ohne Token | API- und UI-Tests |
| 15 | Bot-Token wird ohne Viewer-Neustart neu gelesen | Runtime-Integrationstest |
| 16 | Vollständige Web-UI-Endpunkte, Mutationen Admin-only und auditiert | API-/Rollen-/Audit-Tests |
| 17 | Alle geforderten internen GET-Routen inklusive Detail- und Event-Routen | API-Read-Model-Test |
| 18 | Eigene begrenzte Viewer-Read-Models statt DB-Rows oder Trading-Snapshot | Projection- und Secret-Leak-Tests |
| 19 | Dynamische Börsenkennung als opaque `string` | Dynamic-Exchange-Test |
| 20 | Reporting Currency aus Capabilities, ohne Drei-Börsen-Hardcoding | Projection-Test |
| 21 | Neue `leverageDecision`- und Legacy-`leverage`-Darstellung | Formatter-Kompatibilitätstest |
| 22 | Generische `trading_notification_events`, bestehende Execution Events unverändert | Migration-/Repository-Test |
| 23 | Append-only Migration 21 mit Indizes und Event-Allowlist | DB-Feature-/Migrationstest |
| 24 | Eigene `telegram_viewer_test_events` und aktualisierte DB-Feature-Metadaten | DB- und Test-Flow-Test |
| 25 | Monotoner `afterSeq`-Cursor und serverseitig begrenztes Limit | Repository-/API-Test |
| 26 | Geforderte Notification-Event-Typen vorbereitet | Event-Allowlist-Test |
| 27 | Deterministische Dedupe-Keys für Lifecycle-, Fill-, Incident- und Stream-Events | Trading-/Repository-Tests |
| 28 | Zentrale, validierende und duplicate-sichere Event-Aufzeichnung | Core-Vertragstest |
| 29 | Bestehender Execution Funnel und Analytics bleiben erhalten | Trading- und Telemetrie-Regressionssuite |
| 30 | Notification-Persistenz ist best-effort; kein Telegram-Netz im Trading-Pfad | Trading-Notification-Fehlertest und Architekturtest |
| 31 | Eigene Viewer-State-DB für Offset, Cursor, Delivery, Retry und Teststatus | State-Repository-/Restart-Test |
| 32 | At least once + per-user/event-Dedupe + bounded Backoff | Service-/State-Tests |
| 33 | Trading wartet niemals auf Telegram | Prozessgrenze und Trading-Engine-Test |
| 34 | Testevent via Web-POST, Abruf via Viewer-GET, Status ohne Rück-POST | API-/Service-/Status-Test |
| 35 | `/healthz`, `/readyz`, token-geschütztes `/status`, secret-freie Antworten | Runtime-Test |
| 36 | Vollständiges Viewer-Menü ohne Action-Buttons | Formatter-/Callback-Test |
| 37 | Long Polling, persistentes Offset, nur Message/Callback und neutraler Unknown-Hinweis | Service-/Restart-Test |
| 38 | Kein Webhook und kein öffentlicher Host-Port | Runtime-/Compose-Test |
| 39 | Reine Formatter für alle geforderten Ansichten und Notifications | Formatter-Tests ohne Telegram-Netz |
| 40 | 4096-Zeichen-Grenze, Pagination und validierte Callback-Daten | Formatter-/Pagination-/API-Test |
| 41 | Keine Credentials, Keys, Tokens oder rohen Exchange-Payloads in Read-Models | Security-/Leak-Tests |
| 42 | Operations-Tab mit Status, Allgemein, Token, Zugriff, Notifications, Darstellung, Diagnose, Test | Frontend-Test |
| 43 | Alle Mutationen Admin-only; Viewer darf nur ungefährlichen Status lesen | Rollenmatrix-Test |
| 44 | Deaktivierter Viewer sendet und verarbeitet keine sensitiven Bot-Daten | Service-Test |
| 45 | Standard 2000 ms und validierter Bereich 1000–60000 ms | Settings-Test |
| 46 | Konto-/Positionsdaten ausschließlich aus persistiertem TSX-Zustand | Projection-/Architekturtest |
| 47 | Begrenzte Performance-Projektion ohne Vollhistorienabruf | Projection-Test |
| 48 | Read-only Container, tmpfs, Cap-Drop, no-new-privileges, Limits, keine Host-Ports | Compose-/Deployment-Test |
| 49 | Automatische Prüfung aller Netzwerk-, Volume-, URL- und Port-Grenzen | `tests/test_telegram_viewer_deployment.js` |
| 50 | Vollständige API-Sicherheitsmatrix | `tests/test_telegram_viewer_api.js` |
| 51 | Vollständige Bot-Authentifizierungsmatrix | `tests/test_telegram_viewer_service.js` |
| 52 | Dedupe, Cursor, Restart, Retry, Mute und Disable getestet | Core-/Service-/Trading-Tests |
| 53 | Neue und Legacy-Hebelpläne getestet | Projection-/Formatter-Test |
| 54 | Zertifizierte dynamische Börsen wie `okx` funktionieren ohne Union-Crash | API-/Formatter-Test |
| 55 | Testnachricht vollständig ohne Execution-Event oder Trading-Mutation | API-/Repository-/Service-Test |
| 56 | Alle verpflichtend genannten Bestandsdateien und neue Viewer-Dateien geprüft | Diff-, Architektur- und Gesamtsuite |
| 57 | Alle ausdrücklich verbotenen Viewer-Aktionen technisch ausgeschlossen | Callback-/API-/Compose-/Architekturtests |
| 58 | Viewer-only, getrennte Laufzeit, robuste Events, Full Gate, Handoff und sauberer Git-Stand | Abschlussgates und Handoff |

## Lokale Abschlussgates

- `npm run test:coverage`: PASS, 70/70 Testdateien; 97,47/89,03/100/97,47 %.
- `npm run test:coverage:modules`: PASS; 95,36/83,40/99,21/95,36 %, gemeinsamer Windows-/Linux-Ratchet unverändert 95,01/83,33/99,09/95,01 %.
- `npm run test:coverage --prefix frontend`: PASS, 17/17 Dateien und 101/101 Tests; 62,43/56,10/54,49/63,27 %.
- Python-Executor: PASS, 41/41 Tests, 74 % Coverage bei 60-%-Grenze.
- Typecheck, Backend-/Frontend-Lint und Build: PASS.
- Architektur: PASS, 74 Module, 230 interne Imports, 0 Zyklen.
- Komplexität: PASS, 0 Warnungen, Worst-Case 15, keine Funktion über 100 Zeilen.
- Frontend-Erreichbarkeit: PASS, 37/37 Module.
- Duplikate: PASS, 0,97 % bei 5-%-Grenze.
- NPM-Audits: PASS, 0 Schwachstellen in Backend und Frontend.
- Lizenz-, Dependency-, Release-, Risk-Acceptance-, Build-Context- und SBOM-Gates: PASS.
- SBOM: 116 Backend- und 60 Frontend-Komponenten.
- `docker compose config --quiet`: PASS.

Die Coverage-Reihenfolge ist Statements/Branches/Functions/Lines. Der höhere lokale Windows-Wert ersetzt bewusst nicht den zuvor gemeinsam auf Windows und Linux verifizierten Ratchet.

`npm run quality:monitoring` konnte lokal nicht vollständig laufen, weil Docker Desktop nicht aktiv war. Das ist **NOT RUN**, nicht PASS. Der GitHub-Linux-Lauf ist für Container-Build, Monitoring-Image, Browsermatrix, Mutation, CodeQL und SonarQube Cloud maßgeblich.

## Bewusste Grenzen

- Viewer-State ist ausschließlich Delivery-Technik und niemals Trading-Wahrheit.
- V1 nutzt Long Polling, keinen Webhook.
- Der Viewer führt keine Konfigurations- oder Handelsaktionen aus.
- Notification-Auslieferung ist at least once; deterministische Delivery-Keys verhindern Duplikate nach erfolgreicher Bestätigung.
- Keine Serverbereitstellung ist Bestandteil dieser lokalen Phase; GitHub `main` ist das Ziel.
