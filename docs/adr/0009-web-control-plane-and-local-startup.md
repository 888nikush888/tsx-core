# ADR 0009: Vollständige Web-Control-Plane und integrierter lokaler Start

## Status

Accepted

## Kontext

Der Docker-Standardbetrieb las weiterhin `.env`, markierte dadurch Dashboard-Secrets als extern und verlangte nach Verlust des flüchtigen Browserzustands die manuelle Eingabe eines Bearer-Tokens. Default-Prompt, Enterprise-Runtime-Parameter, Key-Rotation und ein vollständiger Factory Reset waren nicht über dieselbe Control Plane verfügbar.

## Entscheidung

- Das Standard-Compose liest keine `.env` ein und veröffentlicht Dashboard sowie Metriken ausschließlich auf Host-Loopback.
- `DASHBOARD_LOCAL_TRUST` wird im Standalone-Profil aktiviert. Beim Erststart bleibt der lokale Session-Endpunkt gesperrt, bis der Operator die sichtbare Bootstrap-Aktion ausführt, den serverseitig erzeugten Admin-Bearer einmalig erhält und dessen Speicherung bestätigt. Erst wenn dieser dauerhafte Zugang existiert, erzeugt der Session-Endpunkt einen separaten, höchstens zwölf Stunden gültigen In-Memory-Session-Token und legt den dauerhaften Admin-Token nicht erneut offen. Browser halten beide Tokenarten nur im Session Storage. Dieser Modus vertraut ausdrücklich allen lokalen Prozessen des dedizierten Single-User-Hosts und ist kein Remote-/Shared-Host-Sicherheitsmodell.
- Das mitgelieferte Compose aktiviert zusätzlich `DASHBOARD_RECOVERY_LOCAL_TRUST` nur hinter seiner festen Host-Loopback-Portfreigabe. Bei beschädigter Konfiguration, Runtime-Einstellung oder Secret-Datei bleibt ausschließlich eine Repair-Plane für diese drei Zustände und einen Neustart aktiv; ihre bewusst unauditierten Mutationen werden als kritisch geloggt. Diese Ausnahme ist für remote veröffentlichte oder Enterprise-OIDC-Dashboards verboten.
- Admin- und Viewer-Bearer-Keys werden serverseitig erzeugt, write-only persistiert und nach Erzeugung genau einmal angezeigt.
- Alle nicht geheimen Runtime-/Enterprise-Parameter werden atomar in `runtime-settings.json` gespeichert und erst nach kontrolliertem Neustart aktiviert. Enterprise-Modus erzwingt OIDC, deaktiviert Local Trust und verlangt Remote-Audit und Off-site-Backup.
- Das Default-Template darf überschrieben werden. Der unveränderliche Safety-Suffix gegen Prompt Injection und Schemaabweichungen wird weiterhin serverseitig angehängt.
- Factory Reset prüft Pfade und Secret-Quellen vor der Stilllegung, löscht den vollständigen lokal verwalteten Zustand einschließlich Audit-Kette und startet den Container neu. Der entfernte AES-Schlüssel bewirkt Crypto-Erasure nicht separat löschbarer Off-site-Objekte; ein Enterprise-Audit-Empfänger besitzt seine bereits zugestellte externe Evidenz unabhängig weiter.

## Konsequenzen

Der normale Docker-Erststart benötigt weder `.env` noch einen vom Benutzer erfundenen Bearer-Wert, macht die Erzeugung und einmalige Ausgabe des serverseitigen Tokens aber ausdrücklich sichtbar. Spätere lokale Browser-Sitzungen und die lokal begrenzte Recovery benötigen keine erneute Bearer-Eingabe. Extern gemountete Orchestrator-Secrets bleiben möglich, sind dann aber im Web schreibgeschützt. Remote-Zugriff und Enterprise-OIDC benötigen weiterhin einen TLS-/Identity-Provider außerhalb dieses Containers.

Ergänzung 28.07.2026: Die Auslieferung erzeugt keine fachlichen Beispieldaten mehr. Eine neue oder vollständig zurückgesetzte Installation besitzt weder Verträge/Profile/Strategien noch Konten, Paper-Guthaben, Routen oder MCP-Agenten. Benannte Docker-Volumes bleiben als installationsbezogener Zustand ausdrücklich von GitHub-Checkout und Image getrennt.

## Abnahme und Traceability

Owner sind Security und SRE, für Backup/Reset zusätzlich der Data Owner. Akzeptiert ist die Entscheidung nur bei grünen Tests `test_web_server.js`, `test_secret_store.js`, `test_runtime_settings.js`, `test_backup_replication.js`, `test_dashboard_auth.js` und `frontend/tests/system-tab.test.tsx`, erfolgreichem Docker-Startup-/Reset-/Restore-Smoke sowie erfüllten SLOs aus `docs/QUALITY_OS.md`. Rollback erfolgt über den vorherigen Image-Digest und das vor Restore bewahrte DB-/Config-Paar.

Ergänzung 26.07.2026, aktualisiert 28.07.2026: ADR 0011 ergänzt Tailscale-Identity, dynamische Verträge/Analytics und einen unabhängigen MCP-Dienst. Dieser startet nun standardmäßig, bleibt fachlich ab Werk `disabled` und wird persistent über das Dashboard gesteuert. Factory Reset und Restore koordinieren dessen SQLite-Handle über einen gemeinsamen Wartungsmarker; die Web-first- und Loopback-Grundsätze bleiben bestehen.
