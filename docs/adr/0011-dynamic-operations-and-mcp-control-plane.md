# ADR 0011: Dynamische Betriebs- und Agenten-Control-Plane

- Status: Accepted
- Datum: 2026-07-26
- Entscheider: Product Owner, Trading Domain, Security, SRE

## Kontext

TSX Core besaß geprüfte, aber fest benannte Signalverträge, eine analytisch überladene Hauptansicht, starres beziehungsweise nur strategiebezogenes Risiko und ausschließlich Dashboard-/HTTP-gesteuerte Administration. Für wechselnde Telegram-Quellen, operativen Remote-Betrieb und Agenten-Frameworks wurden neun zusammenhängende Fähigkeiten benötigt: frei verwaltete Verträge, tailnet-interner Zugriff, monochromes UI, Trennung von Cockpit und Analytics, kanalbezogenes adaptives Risiko, dedizierte Analytics, durchgehende Logs, Command Palette und ein unabhängiger MCP-Server.

## Entscheidung

1. Signalverträge werden als versionierte, deklarative Datenbankbausteine behandelt. Der generische Interpreter akzeptiert ausschließlich begrenzte Pfade, Typen, Strukturen, Geometrie-, Grounding- und sichere Regex-Primitiven. Es gibt keinen ausführbaren Benutzer-Code.
2. Schema-Profile verbinden Parser-Templates frei mit publizierten Vertragsversionen. Publizierte Versionen sind immutable; Entwürfe sind editier-/löschbar; Referenzen blockieren Archivierung.
3. Das Cockpit enthält nur Live-Sicherheit, Positionen/PnL, Signalstrom und Notfallaktionen. Historische und vergleichende Kennzahlen liegen im eigenen Analytics-Bereich.
4. Risiko wird optional je Quellkanal wöchentlich aus managed Performance bewertet. `shadow` beobachtet, `automatic` passt innerhalb fester Stufen an. Manuelle Sperren und alle vorhandenen globalen Safety-Gates haben Vorrang.
5. Execution-Ereignisse werden entlang Signalempfang, Validierung, Intent, Submit, Exchange-Ack, Fill und Positionsschluss persistiert. Sie speisen Kanal-/Slippage-/Latenzanalysen und aktive Ereignisbenachrichtigungen.
6. Logs werden als zusammenhängender, cursorbasierter Ringstrom mit virtueller UI und Freitext-/Regex-Suche präsentiert. Level-Filter sind keine primäre Ablaufansicht mehr.
7. Eine globale `Strg+K`/`⌘K`-Palette erschließt Navigation, Verträge, Kanäle, Positionen und explizit erlaubte Aktionen.
8. Tailscale Serve ist der bevorzugte Remote-Zugriff für Standalone. Dashboard/MCP bleiben auf Host-Loopback; Funnel ist verboten. Verifizierte Serve-Identitäten werden nur bei explizitem Trusted-Proxy-Modus und exakter Tailnet-Origin akzeptiert. Enterprise behält OIDC sowie externe Audit-/Backup-Pflichten.
9. MCP läuft optional als unabhängiger Prozess über Streamable HTTP. Jeder Agent besitzt einen nur einmal ausgegebenen Token, dessen SHA-256, dauerhafte Minimalrechte und Event-Abonnements persistiert werden. Read-Tools greifen begrenzt auf Repositories zu. Write-Tools erzeugen Kontrollanforderungen; ausschließlich die Forwarder-Brücke darf nach erneuter Rechteprüfung, erfolgreichem Vorab-Audit und über `TradingWebControl` Nebenwirkungen ausführen.
10. Dashboard, MCP und Analytics bleiben an die Quote-Invariante `USD`/`USDC`/`USDT` gebunden. Bestehende TP-/SL-/Exchange-Sicherheitslogik wird nicht abgeschwächt.
11. Factory Reset und Restore koordinieren beide SQLite-Prozesse über einen gemeinsamen Wartungsmarker. Der MCP-Prozess schließt bei Marker, fehlendem Pfad oder Dateiaustausch fail-closed und startet erst gegen die vom Forwarder verifizierte neue Datenbank.

## Folgen

- Fachliche Signalvarianten erfordern keine neue Parserklasse, solange sie durch die deklarativen Primitiven ausdrückbar sind.
- Vertrag, Profil und Strategie bleiben getrennte Versionierungs- und Freigabeobjekte.

Ergänzung 27.07.2026: Publizierte Definitionen bleiben unveränderlich, dürfen aber nach expliziter Bestätigung endgültig gelöscht werden, wenn kein aktiviertes oder deaktiviertes Signal-Schema-Profil mehr auf die Version verweist. Die Referenzprüfung verhindert gebrochene Laufzeit- und Verwaltungsverknüpfungen; Löschversuche bleiben auditiert.
- Kanalautomatik kann Risiko reduzieren oder innerhalb der konfigurierten Stufen erhöhen, aber keine Strategie-/Systemgrenze überschreiten.
- Der normale Stack bleibt bei zwei Services; MCP ist ein bewusst aktiviertes drittes Compose-Profil und verwendet dasselbe attestierte Node-Image.
- MCP-Agenten erhalten keine Exchange-Secrets und keinen direkten Exchange-Adapter. Jede Mutation ist sowohl in der Agenten-Historie als auch in der Enterprise-Audit-Kette nachvollziehbar.
- Tailnet-Zugriff beseitigt nicht die Anwendungsauthentifizierung des MCP-Dienstes.
- Backups enthalten Verträge, Risiko-/Analytics- und MCP-Zustand einschließlich Token-Hashes, aber keine Klartext-Tokens oder Exchange-Secrets.

## Verifikation und Rollback

Akzeptanz verlangt Datenbankmigrations-/Restore-Tests, Vertrags-/Grounding-/Geometrie-Regression, Kanalrisiko- und Telemetrietests, Cockpit-/Analytics-/Log-/Palette-Frontendtests, Tailscale-Authentifizierungstests, MCP-Repository-/Brücken-/Protokolltests, Dependency-Audit und alle bestehenden Trading-Safety-Gates.

Rollback verwendet den vorherigen Image-Digest und bei inkompatibler Persistenz ausschließlich den automatisch erzeugten Pre-Migration-Snapshot. Vor Restore werden Forwarder und MCP gestoppt. Token-Hashes aus einem Restore dürfen nicht als fortdauernde Vertrauensannahme gelten; Agenten-Tokens werden anschließend rotiert.
