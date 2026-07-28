# TSX Core – MCP-Agenten einrichten und betreiben

## Zweck und Sicherheitsgrenze

Der TSX-Core-MCP-Server stellt Systemstatus, Signalverträge, Signal-Schema-Profile, Strategien, Routen, Positionen, Signale, Kanalrisiko, Analytics, Exchange-Stream-Status, Trade Journal und ausdrücklich freigegebene Kontrollaktionen über **Model Context Protocol / Streamable HTTP** bereit. Er ist ein eigener Prozess, startet mit dem normalen Compose-Stack und kann mit unterschiedlichen MCP-fähigen Agenten-Frameworks kombiniert werden. Seine fachliche Schnittstelle ist in der Werkseinstellung deaktiviert.

Der MCP-Server besitzt keine Telegram-, Dashboard- oder Exchange-Secrets. Lesezugriffe verwenden die gemeinsame SQLite-Datenbank. Schreibzugriffe werden als persistente Kontrollanforderung oder Änderungsvorschlag an den laufenden `forwarder` übergeben. Erst dessen Kontrollbrücke prüft Agent, aktuellen Status und Rechte erneut, schreibt den Vorab-Audit-Record und ruft dieselbe `TradingWebControl`-Sicherheitslogik wie das Web-Dashboard auf. Ein Agent kann deshalb keine Exchange-Aktion durch direktes Ändern einer Datenbankzeile auslösen.

## Dienst starten und Betriebsmodus wählen

Der normale Stack startet `forwarder`, `exchange-executor` und `mcp-server` gemeinsam:

```bash
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:8091/healthz
```

Der Endpunkt ist standardmäßig `http://127.0.0.1:8091/mcp`. Die Host-Portfreigabe ist absichtlich Loopback-only. `mcp-server` wartet auf einen gesunden `forwarder`, teilt ausschließlich `forwarder_session_data` und besitzt ein schreibgeschütztes Root-Dateisystem ohne Linux-Capabilities. Er erhält weder den Docker-Socket noch Telegram- oder Exchange-Secrets.

Der Healthcheck bleibt in allen drei Betriebsmodi grün, solange Prozess und Datenbank gesund sind. Seine JSON-Antwort enthält `mode`, `acceptingConnections` und `activeSessions`. Der MCP-Endpunkt selbst antwortet außerhalb von `active` mit HTTP 503.

| Modus | Verhalten | Warteschlangen |
|---|---|---|
| `active` | Neue Agentensitzungen, Tools und Ereignis-Push sind erlaubt. | Kontrollanforderungen und genehmigte Vorschläge werden ausgeführt. |
| `standby` | Bestehende Sitzungen werden beendet; der Dienst und Healthcheck bleiben für schnelle Reaktivierung aktiv. | Noch nicht gestartete Anforderungen und Vorschläge bleiben persistent pausiert. |
| `disabled` | Werkseinstellung. Bestehende Sitzungen werden beendet und der MCP-Endpunkt verweigert alle Agenten. | Noch nicht gestartete Kontrollanforderungen und bereits genehmigte, noch nicht gestartete Vorschläge werden als fehlgeschlagen abgeschlossen. Offene menschliche Vorschläge bleiben als Audit-/Entscheidungsbestand erhalten. |

Der Modus wird unter **MCP-Agenten → MCP-Server** gewählt, in SQLite gespeichert, auditiert und nach Container-/Host-Neustarts wieder angewendet. Das Aktivieren und vollständige Deaktivieren benötigen eine zusätzliche ausdrückliche Bestätigung. Ein Wechsel aus `active` unterbricht keine bereits in der eigentlichen Trading-Nebenwirkung befindliche Operation; die Kontrollbrücke prüft den Modus jedoch beim Claim, vor dem Audit und unmittelbar vor der Nebenwirkung erneut, sodass das Race-Fenster auf bereits laufende atomare Operationen begrenzt bleibt.

Relevante Orchestrator-Parameter:

| Variable | Bedeutung |
| --- | --- |
| `HOST_MCP_PORT` | Host-Loopback-Port, Standard `8091` |
| `MCP_ENDPOINT_URL` | Adresse, die das Dashboard dem Operator zeigt |
| `MCP_ALLOWED_HOSTS` | exakte Hostnamen ohne Port; DNS-Rebinding-Schutz |
| `MCP_ALLOWED_ORIGINS` | kommagetrennte, exakte Browser-Origins; leer weist Browser-Origin-Aufrufe ab |
| `MCP_RUNTIME_POLL_MS` | Reaktionszeit des MCP-Prozesses auf persistente Moduswechsel, Standard `500` ms |
| `MCP_MEMORY_LIMIT`, `MCP_CPU_LIMIT` | Containergrenzen |

## Agent anlegen

1. Im Dashboard **MCP-Agenten** öffnen.
2. **Neuer Agent** wählen und einen eindeutigen Namen vergeben.
3. Nur die benötigten Rechte und Ereignisse aktivieren.
4. **Agent erstellen** wählen.
5. Den einmal angezeigten `tsx_mcp_…`-Token sofort in den Secret Store des Agenten kopieren.

TSX Core speichert nur SHA-256 und ein nicht geheimes Präfix. Der Token kann nicht wieder angezeigt oder rekonstruiert werden. **Token rotieren** widerruft den bisherigen Token und alle aktiven Sitzungen. **Agent aktiv** ausschalten widerruft ebenfalls alle Sitzungen; der Datensatz bleibt administrierbar. **Agent löschen** widerruft Token, Rechte, aktive Sitzungen und noch wartende Kontrollanforderungen sofort und entfernt den Agenten aus dem aktiven Inventar. Referenzierte Sicherheits- und Aktionshistorie bleibt unter einer anonymisierten Tombstone-Kennung erhalten, damit Löschen nicht zur Audit-Manipulation wird.

Die entsprechende Admin-API verwendet `DELETE /api/mcp/agents` mit `{"id":"…"}` und verlangt zusätzlich `X-Destructive-Confirmation: delete-mcp-agent`.

Der MCP-Client sendet auf jeder Anfrage:

```http
Authorization: Bearer tsx_mcp_…
```

Die Protokollversion wird beim MCP-Handshake ausgehandelt. Clients dürfen keine feste, vom Server abweichende Version erzwingen.

## Dauerhafte Rechte

| Recht | Wirkung |
| --- | --- |
| `system.read` | Runtime-/Safety-Status und Ausführungslatenzen lesen |
| `contracts.read` | versionierte Signalverträge lesen |
| `positions.read` | managed Positionen, Orders und Fills lesen |
| `signals.read` | jüngste Trade-Intents lesen |
| `risk.read` | Kanalrisiko, Auswertungen, Konten ohne Credential-Referenz und Routen lesen |
| `strategies.read` | versionierte Strategien lesen |
| `routes.read` | Kanalrouten lesen |
| `analytics.read` | Performance, Ausführungslatenzen und Exchange-Stream-Gesundheit lesen |
| `journal.read` | PII-redigiertes Trade Journal lesen |
| `contracts.write` | Vertragsentwurf erstellen/ändern/publizieren/archivieren/löschen |
| `risk.write` | kanalbezogene Risikopolice erstellen/ändern/löschen |
| `strategies.write` | Strategieentwürfe erstellen/ändern/publizieren/archivieren/löschen |
| `routes.write` | Kanalrouten setzen oder entfernen |
| `trading.reconcile` | Exchange-Abgleich anfordern |
| `trading.cancel_entries` | managed Entry-Orders stornieren |
| `trading.kill_switch` | Kill-Switch setzen oder nach erfolgreicher Reconciliation lösen |
| `trading.flatten` | Kill-Switch setzen und managed Positionen reduce-only glattstellen |

Rechte gelten dauerhaft, bis ein Dashboard-Admin sie ändert, den Agenten deaktiviert oder löscht. Bei jedem Tool-Aufruf liest der Server den aktuellen Agentenstatus erneut. Bereits verbundene Sitzungen behalten deshalb keine entzogenen Rechte.

## Tools

Lese-Tools:

- `tsx_system_status`
- `tsx_contracts_list`
- `tsx_contract_validate`
- `tsx_positions_list`
- `tsx_signals_list`
- `tsx_risk_status`
- `tsx_signal_schemas_list`
- `tsx_strategies_list`
- `tsx_routes_list`
- `tsx_analytics`
- `tsx_trade_journal`
- `tsx_preflight`
- `tsx_proposals_list`
- `tsx_proposal_status`

Schreib- und Kontroll-Tools:

- `tsx_contract_create`, `tsx_contract_update`, `tsx_contract_create_version`, `tsx_contract_duplicate`
- `tsx_contract_publish`
- `tsx_contract_archive`
- `tsx_contract_delete_draft`, `tsx_contract_delete_version`
- `tsx_signal_schema_create`, `tsx_signal_schema_update`, `tsx_signal_schema_delete`
- `tsx_strategy_create`, `tsx_strategy_update`, `tsx_strategy_publish`, `tsx_strategy_archive`, `tsx_strategy_delete`
- `tsx_route_set`, `tsx_route_delete`
- `tsx_risk_policy_update`
- `tsx_risk_policy_delete`
- `tsx_reconcile`
- `tsx_cancel_open_entries`
- `tsx_set_kill_switch`
- `tsx_emergency_flatten`

Jeder Aufruf erzeugt einen Eintrag unter **MCP-Agenten → Agenten-Aktionen** mit Agent, Sitzung, Tool, benötigtem Recht, Ergebnis und Dauer. Schreibende Aufrufe erzeugen zusätzlich `authorized` und `completed` in der hashverketteten Enterprise-Audit-Kette. Requests und Ergebnisse sind größenbegrenzt; Tokens und Credentials werden nicht aufgezeichnet.

## Preflight und Freigabe-Warteschlange

`tsx_preflight` prüft eine Änderung ohne Persistenz oder Nebenwirkung gegen den aktuellen Datenbestand. Es liefert Blocker, erwartete Wirkung und die Information, ob menschliche Freigabe nötig ist. Sichere Entwurfsaktionen können nach erfolgreichem Preflight automatisch freigegeben werden. Publizieren, Archivieren, Löschen, Profiländerungen, Strategie-Lifecycle, Routing, Risikoänderungen und das Lösen des Kill-Switches erzeugen dagegen einen 24 Stunden gültigen, persistenten Vorschlag.

Der Agent erhält sofort `proposalId`, Status, Ablaufzeit und Preflight-Ergebnis. Ein Admin genehmigt oder verwirft den Vorschlag unter **MCP-Agenten → Freigabe-Warteschlange**. Erst nach Genehmigung claimt die Forwarder-Brücke den Vorschlag atomar, prüft die inzwischen gültigen Rechte erneut und führt ihn auditiert aus. Nach Neustart werden unterbrochene Ausführungen als fehlgeschlagen markiert; sie werden nie blind wiederholt. `tsx_proposal_status` und `tsx_proposals_list` liefern den dauerhaften Ausgang.

Sofortige Notfallaktionen bleiben bewusst getrennt: Reconciliation, Stornieren managed Entries, Aktivieren des Kill-Switches und reduce-only Flatten benötigen das jeweilige dauerhafte Recht und laufen direkt durch die auditierte Kontrollbrücke. Das Lösen des Kill-Switches ist stets freigabepflichtig. Tools für Secrets, Factory Reset oder das Aktivieren von Live-Trading existieren nicht.

## Ereignis-Benachrichtigungen

Ein Agent kann folgende Ereignisse abonnieren:

`signal_received`, `signal_validated`, `intent_created`, `submit_started`, `exchange_ack`, `first_fill`, `fully_filled`, `position_closed`, `kill_switch_activated`, `contract_changed`, `risk_policy_changed`.

TSX Core sendet neue Ereignisse aktiv als MCP-Logging-Nachricht des Loggers `tsx-core.events`; der Payload enthält `type: "tsx_core_event"` und das persistierte Ereignis. Fehlgeschlagene Übermittlungen bleiben retryfähig. Zustellungen werden pro Ereignis, Agent und Sitzung dedupliziert. Der Server versendet nur Ereignisse, die nach Beginn der jeweiligen Sitzung aufgetreten sind.

Die Trading-Telemetrie persistiert Zeitpunkte entlang der Signal-Kette. Der Analytics-Bereich berechnet daraus insbesondere Signal-zu-Submit- und Signal-zu-First-Fill-Latenz mit Anzahl, p50, p95 und p99.

## Tailscale statt öffentlichem Port

Für entfernte Agenten Tailscale Serve auf einen separaten HTTPS-Port legen; **Funnel niemals aktivieren**:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure_tailscale_serve.ps1 `
  -DashboardPort 8091 -HttpsPort 8443
```

Danach den ausgegebenen MagicDNS-Host in `MCP_ALLOWED_HOSTS`, die HTTPS-Adresse in `MCP_ENDPOINT_URL` und – nur für einen Browser-basierten MCP-Client – dessen exakte Origin in `MCP_ALLOWED_ORIGINS` aufnehmen. Der Bearer-Token bleibt auch innerhalb des Tailnets zwingend.

## Incident und Widerruf

Bei verdächtigem Agentenverhalten:

1. Agent im Dashboard sofort deaktivieren oder bei endgültigem Widerruf über **Agent löschen** entfernen.
2. Kill-Switch und offene Positionen im Cockpit prüfen.
3. MCP-Sitzungen, Agenten-Aktionen, Audit-Kette und Trading-Events anhand der Request-/Agenten-ID sichern.
4. Exchange-Zustand read-only reconciliieren; unbekannte Ausgänge nicht blind wiederholen.
5. Erst nach Ursachenklärung Rechte minimal neu vergeben und einen neuen Token ausstellen.

Vor Backup-Restore oder Migration-Rollback den gesamten Compose-Stack einschließlich `mcp-server` stoppen. Der integrierte Factory Reset koordiniert den MCP-Prozess über den gemeinsamen Wartungsmarker selbst. Backups enthalten den persistenten MCP-Modus, Agenten, Rechte, Sitzungs-/Aktionshistorie und Kontrollanforderungen, aber niemals Klartext-Tokens. Nach Restore müssen Agenten-Tokens vorsorglich rotiert und der wiederhergestellte Modus vor einer Freigabe geprüft werden. Ein Factory Reset erzeugt erneut `disabled` und keine Agenten.
