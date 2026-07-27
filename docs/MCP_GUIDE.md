# TSX Core – MCP-Agenten einrichten und betreiben

## Zweck und Sicherheitsgrenze

Der optionale TSX-Core-MCP-Server stellt Systemstatus, Signalverträge, Positionen, Signale, Kanalrisiko und ausdrücklich freigegebene Kontrollaktionen über **Model Context Protocol / Streamable HTTP** bereit. Er ist ein eigener Prozess und kann mit unterschiedlichen MCP-fähigen Agenten-Frameworks kombiniert werden.

Der MCP-Server besitzt keine Telegram-, Dashboard- oder Exchange-Secrets. Lesezugriffe verwenden die gemeinsame SQLite-Datenbank. Schreibzugriffe werden als persistente Kontrollanforderung an den laufenden `forwarder` übergeben. Erst dessen Kontrollbrücke prüft den Agenten erneut, schreibt den Vorab-Audit-Record und ruft dieselbe `TradingWebControl`-Sicherheitslogik wie das Web-Dashboard auf. Ein Agent kann deshalb keine Exchange-Aktion durch direktes Ändern einer Datenbankzeile auslösen.

## Dienst starten

Der normale Stack bleibt bei zwei Services. MCP wird als optionales Compose-Profil ergänzt:

```bash
docker compose --profile mcp up --build -d
docker compose --profile mcp ps
curl --fail http://127.0.0.1:8091/healthz
```

Der Endpunkt ist standardmäßig `http://127.0.0.1:8091/mcp`. Die Host-Portfreigabe ist absichtlich Loopback-only. `mcp-server` wartet auf einen gesunden `forwarder`, teilt ausschließlich `forwarder_session_data` und besitzt ein schreibgeschütztes Root-Dateisystem ohne Linux-Capabilities.

Relevante Orchestrator-Parameter:

| Variable | Bedeutung |
| --- | --- |
| `HOST_MCP_PORT` | Host-Loopback-Port, Standard `8091` |
| `MCP_ENDPOINT_URL` | Adresse, die das Dashboard dem Operator zeigt |
| `MCP_ALLOWED_HOSTS` | exakte Hostnamen ohne Port; DNS-Rebinding-Schutz |
| `MCP_ALLOWED_ORIGINS` | kommagetrennte, exakte Browser-Origins; leer weist Browser-Origin-Aufrufe ab |
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
| `contracts.write` | Vertragsentwurf erstellen/ändern/publizieren/archivieren/löschen |
| `risk.write` | kanalbezogene Risikopolice erstellen/ändern/löschen |
| `trading.reconcile` | Exchange-Abgleich anfordern |
| `trading.cancel_entries` | managed Entry-Orders stornieren |
| `trading.kill_switch` | Kill-Switch setzen oder nach erfolgreicher Reconciliation lösen |
| `trading.flatten` | Kill-Switch setzen und managed Positionen reduce-only glattstellen |

Rechte gelten dauerhaft, bis ein Dashboard-Admin sie ändert, den Agenten deaktiviert oder löscht. Bei jedem Tool-Aufruf liest der Server den aktuellen Agentenstatus erneut. Bereits verbundene Sitzungen behalten deshalb keine entzogenen Rechte.

## Tools

Lese-Tools:

- `tsx_system_status`
- `tsx_contracts_list`
- `tsx_positions_list`
- `tsx_signals_list`
- `tsx_risk_status`

Schreib- und Kontroll-Tools:

- `tsx_contract_create`
- `tsx_contract_update`
- `tsx_contract_publish`
- `tsx_contract_archive`
- `tsx_contract_delete_draft`
- `tsx_risk_policy_update`
- `tsx_risk_policy_delete`
- `tsx_reconcile`
- `tsx_cancel_open_entries`
- `tsx_set_kill_switch`
- `tsx_emergency_flatten`

Jeder Aufruf erzeugt einen Eintrag unter **MCP-Agenten → Agenten-Aktionen** mit Agent, Sitzung, Tool, benötigtem Recht, Ergebnis und Dauer. Schreibende Aufrufe erzeugen zusätzlich `authorized` und `completed` in der hashverketteten Enterprise-Audit-Kette. Requests und Ergebnisse sind größenbegrenzt; Tokens und Credentials werden nicht aufgezeichnet.

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

Vor Backup-Restore, Migration-Rollback oder Factory Reset den MCP-Profil-Dienst gemeinsam mit dem Forwarder stoppen. Backups enthalten Agenten, Rechte, Sitzungs-/Aktionshistorie und Kontrollanforderungen, aber niemals Klartext-Tokens. Nach Restore müssen Agenten-Tokens vorsorglich rotiert werden.
