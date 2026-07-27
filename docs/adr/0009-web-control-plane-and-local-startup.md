# ADR 0009: Vollständige Web-Control-Plane und integrierter lokaler Start

## Status

Accepted

## Kontext

Der Docker-Standardbetrieb las weiterhin `.env`, markierte dadurch Dashboard-Secrets als extern und verlangte nach Verlust des flüchtigen Browserzustands die manuelle Eingabe eines Bearer-Tokens. Default-Prompt, Enterprise-Runtime-Parameter, Key-Rotation und ein vollständiger Factory Reset waren nicht über dieselbe Control Plane verfügbar.

## Entscheidung

- Das Standard-Compose liest keine `.env` ein und veröffentlicht Dashboard sowie Metriken ausschließlich auf Host-Loopback.
- `DASHBOARD_LOCAL_TRUST` wird im Standalone-Profil aktiviert. Ein Origin- und Header-geschützter lokaler Session-Endpunkt erzeugt den verwalteten Admin-Zugang beim Erststart automatisch. Wenn dieser bereits existiert, erzeugt der Endpunkt stattdessen einen separaten, höchstens zwölf Stunden gültigen In-Memory-Session-Token und legt den dauerhaften Admin-Token nicht erneut offen. Browser halten beide Tokenarten nur im Session Storage. Dieser Modus vertraut ausdrücklich allen lokalen Prozessen des dedizierten Single-User-Hosts und ist kein Remote-/Shared-Host-Sicherheitsmodell.
- Das mitgelieferte Compose aktiviert zusätzlich `DASHBOARD_RECOVERY_LOCAL_TRUST` nur hinter seiner festen Host-Loopback-Portfreigabe. Bei beschädigter Konfiguration, Runtime-Einstellung oder Secret-Datei bleibt ausschließlich eine Repair-Plane für diese drei Zustände und einen Neustart aktiv; ihre bewusst unauditierten Mutationen werden als kritisch geloggt. Diese Ausnahme ist für remote veröffentlichte oder Enterprise-OIDC-Dashboards verboten.
- Admin- und Viewer-Bearer-Keys werden serverseitig erzeugt, write-only persistiert und nach Erzeugung genau einmal angezeigt.
- Alle nicht geheimen Runtime-/Enterprise-Parameter werden atomar in `runtime-settings.json` gespeichert und erst nach kontrolliertem Neustart aktiviert. Enterprise-Modus erzwingt OIDC, deaktiviert Local Trust und verlangt Remote-Audit und Off-site-Backup.
- Das Default-Template darf überschrieben werden. Der unveränderliche Safety-Suffix gegen Prompt Injection und Schemaabweichungen wird weiterhin serverseitig angehängt.
- Factory Reset prüft Pfade und Secret-Quellen vor der Stilllegung, löscht den vollständigen lokal verwalteten Zustand einschließlich Audit-Kette und startet den Container neu. Der entfernte AES-Schlüssel bewirkt Crypto-Erasure nicht separat löschbarer Off-site-Objekte; ein Enterprise-Audit-Empfänger besitzt seine bereits zugestellte externe Evidenz unabhängig weiter.

## Konsequenzen

Der normale Docker-Erststart, spätere lokale Browser-Sitzungen und die lokal begrenzte Recovery benötigen weder `.env` noch manuelle Bearer-Eingabe. Extern gemountete Orchestrator-Secrets bleiben möglich, sind dann aber im Web schreibgeschützt. Remote-Zugriff und Enterprise-OIDC benötigen weiterhin einen TLS-/Identity-Provider außerhalb dieses Containers.

## Abnahme und Traceability

Owner sind Security und SRE, für Backup/Reset zusätzlich der Data Owner. Akzeptiert ist die Entscheidung nur bei grünen Tests `test_web_server.js`, `test_secret_store.js`, `test_runtime_settings.js`, `test_backup_replication.js`, `test_dashboard_auth.js` und `frontend/tests/system-tab.test.tsx`, erfolgreichem Docker-Startup-/Reset-/Restore-Smoke sowie erfüllten SLOs aus `docs/QUALITY_OS.md`. Rollback erfolgt über den vorherigen Image-Digest und das vor Restore bewahrte DB-/Config-Paar.

Ergänzung 26.07.2026: ADR 0011 ergänzt Tailscale-Identity, dynamische Verträge/Analytics und einen optionalen unabhängigen MCP-Dienst. Factory Reset und Restore koordinieren dessen SQLite-Handle über einen gemeinsamen Wartungsmarker; die Web-first- und Loopback-Grundsätze bleiben bestehen.
