# TSX Core – Changelog

Alle relevanten Änderungen werden in dieser Datei dokumentiert. Das Format folgt Keep a Changelog; Versionen folgen Semantic Versioning.

## [Unreleased]

### Added

- Exklusive, kanalbezogene Börsenkonto-Fallback-Ketten im visuellen Builder. Kontobausteine können in einer festen Reihenfolge verbunden werden; TSX Core erzeugt erst dann den nächsten Intent, wenn der CCXT-Executor für das aktuelle Konto das normalisierte Futures-Paar eindeutig als nicht verfügbar bestätigt.
- Persistente Fallback-Läufe mit Kandidatenrang, ausgewähltem Konto, Erschöpfungs-/Stoppgrund sowie Anzeige in Dashboard, Analytics, Workflow-Snapshot und MCP.

### Changed

- Workflow-Graph und portable Setup-Bundles verwenden Schema v2 mit typisierten `flow`- und `account_fallback`-Kanten; bestehende Schema-v1-Workflows bleiben lesbar und werden beim Bearbeiten sicher hochgestuft.

### Security

- Nur eine identitätsgebundene, nebenwirkungsfreie `SYMBOL_UNAVAILABLE`-Antwort des Read-only-Market-Snapshot-Endpunkts darf eine Fallback-Stufe aktivieren. Konto-/Executorfehler, 502/503/Timeouts, Risiko- und Vertragsgates sowie unklare Submit-Ergebnisse stoppen die Kette fail-closed; die ursprüngliche Entry-TTL wird nie zurückgesetzt.
- Das Exchange-Executor-Image pinnt `libcrypto3` und `libssl3` auf 3.5.8-r0 und schließt damit `CVE-2026-14456`; der Supply-Chain-Test erzwingt diese Mindestversion.

## [3.2.0] - 2026-08-26

### Fixed

- Workflow-Operationen korrigiert: Overview-Zugriff bereinigt, Journalsymbole normalisiert (BTC/USDT), Regex-Flags (g/y) gestrippt und Cache auf FIFO umgestellt, ReDoS-Dokumentation präzisiert, Queue-Timeout nur bei aktivem XML-Parsing erhöht sowie NaN/Infinity-Validierung im Queue-Settings.
- Build- und CI-Härtung: UTF-8-BOM aus Paketmanifesten entfernt, Reduced-Motion-Transitions auf 0s gestellt für a11y-Testvertrag, Lockfiles auf 3.2.0 synchronisiert.

### Changed

- Unerreichter Code entfernt (TradingOrderStatus/PositionStatus, TradingStrategyConfigurationInput), zentrale `jsonRequest`-Kapselung, einheitliche Dashboard-Karten (5 Einträge).
- UI-Polish: kantiges Design (--radius 0), Tab-Indicator-Slide über Base UI Indicator, Motion-Safety, Tabular-Nums und Scrollbar/Selection-Konsistenz.
- Dokumentation gestrafft: README gekürzt, SECURITY 3.x, QUALITY_OS korrigiert, Designsystem in frontend/DESIGN.md extrahiert.

## [3.1.1] - 2026-08-26

### Fixed

- Hyperliquid Market- und Stop-Market-Orders erhalten den von CCXT verlangten Referenzpreis und verwenden das in der Strategie festgelegte Slippage-Limit. Auch die isolierte Notfallbereinigung verwendet nun einen aktuellen Richtungsreferenzpreis mit begrenzter Slippage.

## [3.1.0] - 2026-08-25

### Added

- Globale visuelle Workflow-Control-Plane mit typisierten Spaltenbausteinen, wiederverwendbarer Ressourcenbibliothek, Popup-Editoren, gerichteten Fan-out-Verbindungen, Simulation, atomaren Revisionen, Revisionskonfliktschutz und explizitem Impact-Preflight.
- Parallele Ausführung eines Signals auf mehreren Börsenkonten mit eigenem Strategie-/Sizing-/Risiko-Zweig und pro Kanal/Konto/logischem Baustein isoliertem adaptivem Zustand.
- Kraken-Futures-Konten sowie ein integrierter Betriebsbereich für Live-Gates, Konten, Journal, Analytics, Logs, Backups, MCP und System.
- Portables, prüfsummengesichertes Setup-Bundle mit Diff-Vorschau, einmaligem 15-Minuten-Schlüssel, lokaler Kontozuordnung, verifiziertem Backup und transaktionalem Replace/Rollback.
- Servergefilterte Trading-Analytics mit Equity, Drawdown, PnL, Gebühren, Slippage, Funnel, Latenzen und adaptiven Risikostufen.
- Dauerhafte, deduplizierte Konto-Incidents sowie eine gesonderte, erneute Reconciliation verlangende Kill-Switch-Freigabe.

### Changed

- Die Exchange-Grenze verwendet jetzt ausschließlich das gepinnte `ccxt==4.5.75`; CCXT Pro beschleunigt private und öffentliche Streams, während CCXT REST alleinige Order- und Reconciliation-Autorität bleibt.
- Das maximale Positionslimit liegt am konkreten Börsenkonto (1–20) und umfasst alle Strategien, Kanäle und Workflowpfade dieses Kontos.
- Bestehende aktivierte Routen werden einmalig in eine immutable visuelle Workflowrevision migriert. Die frühere Trading-Menüoberfläche wurde entfernt.
- Parser-Signale werden nur in SQLite gespeichert; neue und migrierte Workflow-Parser erzwingen `saveToFile=false`.
- Die Hauptnavigation lautet Dashboard, Builder, Analytics und Betrieb. Bereichsspezifisches Polling ist serialisiert, pausiert in inaktiven Bereichen und zeigt den Aktualisierungszustand sichtbar an.
- Direkte Builder-Verbindungen übernehmen ihren Kanal automatisch; Kanten, Pfade, Kontenentwürfe und Viewport-Verhalten verwenden die neuen responsiven Dialog- und Stabilitätsregeln.

### Fixed

- Contract-Size-, Trigger-, Reduce-only-, Teilfüllungs- und stabile Kontoidentitäts-Normalisierung an der CCXT-Grenze sowie separates Notfallzeitfenster für unklare geschützte Entry-Batches.
- Kraken-Ledger-PnL wird nicht mehr als Funding fehlklassifiziert. Kontofehler und Kapazitätssperren bleiben auf den betroffenen Fan-out-Zweig isoliert.
- SonarCloud-Zuverlässigkeits- und Sicherheitsbefunde zu Schaltflächen-Semantik, deterministischer Sortierung, Lockdatei-Parsing und komplexen Kontrollpfaden wurden behoben; die mobile Statusleiste bleibt dabei tastaturzugänglich.
- Alertmanager-Sicherheitsabhängigkeiten und das von Prometheus/Alertmanager verwendete `govulncheck` werden aus eingecheckten Go-Modul-Locks ausschließlich im Read-only-Modus gebaut.
- Eingelesene CCXT-Orders und Fills dürfen eine fehlende `clientOrderId` besitzen und werden sicher über Client-ID, Exchange-ID oder genau einen passenden Attached Stop korreliert. Unbekannte oder mehrdeutige Börsenereignisse bleiben fail-closed.
- Vorübergehende 502/503/504- und Transportfehler blockieren Neueinstiege mit begrenzten Read-only-Retries, ohne einen permanenten Konto-Kill-Switch zu erzeugen; Vertrags- und Zuordnungsfehler bleiben harte Schutzsperren.

### Security

- Setup-Importe prüfen rekursiv Feldnamen und typische Secret-Werte; Tokens, Schlüssel, Sitzungen, Nachrichten, Logs, Journal und Kontohistorie werden weder exportiert noch übernommen.
- SonarQube Cloud analysiert JavaScript/TypeScript, Frontend und Python am exakten Main-Revisionsstand, importiert LCOV/Python-Coverage und exportiert Findings sowie Security Hotspots als CI-Artefakt.

## [2.1.0] - 2026-08-09

### Added

- Projektweite Umbenennung zu **TSX Core** einschließlich Web-UI, Container-Metadaten, Monitoring, Dokumentation und des vom Projekteigentümer gelieferten Logos.
- Benutzerverwaltete Trading-Signal-Schema-Profile mit vollständigem Create/Update/Enable/Disable/Delete-Workflow in Web-UI und API; aktive Kanalrouten schützen verwendete Profile vor Änderung oder Löschung.
- Adaptive TP-Halbierungsstaffel für 1 bis 20 Signal-Targets sowie adaptives SL-Nachziehen: nach TP1/TP2 Break-even, danach TP(i-2), ausschließlich in Gewinnrichtung.
- Multi-Exchange-Portfolioanalyse mit Konto-/Börsenfilter, 24h/7d/30d/Gesamt-Kennzahlen und klar getrennter nominaler USD-/USDC-/USDT-Sicht.
- Einheitliches **Signale & Nachrichten** Control Center und Browser-/Accessibility-Gates für Chromium, Firefox, WebKit und Mobile Chromium.
- Vollständiges, versioniertes CRUD für deklarative Signalverträge mit visuellem Builder, Geometry-/Grounding-Regeln, Vorschau, Duplikation und frei verknüpfbaren Schema-Profilen.
- Getrenntes Live-Cockpit und Analytics-Labor mit Equity/Drawdown, Tages-/Wochenwerten, Kanalranking, Slippage-/Exchange-Vergleich, Execution-Funnel/-Latenz und Erwartungswert-Rechner.
- Kanalbezogenes dynamisches Risiko mit festen, beobachtenden oder automatisch angewendeten Stufen, wöchentlicher Performance-Evaluation, manueller Sperre/Fixierung und Weak-Channel-Aktionen.
- Virtuelle, zusammenhängende Live-Log-Konsole mit Cursor/Ringpuffer und Text-/Regex-Suche sowie globale dynamische `Strg+K`/`⌘K`-Command-Palette.
- Tailscale-Serve-Identity-Modus mit sichtbarem Remote-Status und sicherem Setup-Script, das Funnel deaktiviert.
- Unabhängiger MCP-Streamable-HTTP-Dienst mit gehashten Einmal-Tokens, dauerhaften Minimalrechten, Agenten-/Sitzungs-/Aktions-UI, Ereignis-Push und auditierter Kontrollbrücke.
- Persistente, vollständig im Dashboard steuerbare MCP-Betriebsmodi `active`, `standby` und `disabled` mit sicherer Werkseinstellung, Sitzungsentzug, Queue-Pause/-Widerruf und sichtbarem Modusstatus.
- Native private und öffentliche Bybit-/Hyperliquid-WebSocket-Streams über die offiziellen SDKs; zustandsändernde Events beschleunigen eine erzwungene REST-Reconciliation, ohne selbst autoritativen Trading-Zustand zu erzeugen.
- Vollständiges Trade Journal unter **Trading → Journal** mit Strategie-/Vertrags-Provenienz, Orders, Fills, Gebühren, PnL, Timeline, Notizen, Tags, Bewertung sowie PII-redigiertem CSV-/JSON-Export.
- MCP-Parität für Verträge, Signal-Schema-Profile, Strategien, Routen, Kanalrisiko, Analytics und Trade Journal einschließlich Preflight und persistenter, im Dashboard freizugebender Änderungsvorschläge.

### Changed

- Strategien steuern handelbare normalisierte Symbole jetzt explizit als **alle**, **keine** oder Allowlist. Bei **alle** bestätigt der Börsenadapter die Marktverfügbarkeit vor einer Order.
- SonarCloud analysiert Produktions- und Testpfade ohne Überlappung, mit festgelegter Python-Version und UTF-8-Quellkodierung.
- Der Factory Reset stellt Konfiguration und Runtime-Templates reproduzierbar auf die integrierten Defaults zurück und räumt verwalteten Trading-/Secret-Zustand nur nach erfolgreichem Exposure-Preflight auf.
- Monitoring-Images und GitHub Actions wurden aktualisiert; die Actions verwenden geprüfte Node-24-Commits, Trivy 0.70.0 und eine explizite Allowlist, die aktuellen Monitoring-Images passieren den Container-Gate ohne VEX-Ausnahme.
- Der Risikorechner ist auf eine lokale, diffbasierte Analyse ohne GitHub-API, Signaturdienst oder eigenen Commit-Status reduziert.
- Die Auslieferung ist auf einen einzigen `main`-Branch vereinfacht; automatische Release-, Registry- und Dependabot-Branch-Publisher sind entfernt. Quality OS bleibt als vollständige Nachprüfung des veröffentlichten Main-Commits aktiv.
- Die operative Oberfläche verwendet ein minimalistisches monochromes TSX-Core-Design; Farbe ist keine alleinige Statuscodierung.
- Der normale Compose-Stack startet Forwarder, Exchange-Executor und den gehärteten MCP-Prozess gemeinsam; die Agentenschnittstelle bleibt bis zur auditierten Aktivierung logisch `disabled` und benötigt keinen Docker-Socket.
- Neue Installationen und Factory Resets liefern einen fachlich vollständig leeren Zustand: keine Beispielkanäle, Verträge/Profile/Strategien, Konten, Paper-Bilanz/-Märkte, Routen oder MCP-Agenten; Paper-Konten verlangen eine explizite Startbilanz.

### Fixed

- Der verpflichtende Dependency-Review-Check besitzt für private Repositories ohne GitHub Code Security einen fail-closed Audit-/Lockfile-Fallback, statt an einer nicht verfügbaren Plattformfunktion zu scheitern.
- Die Quality-OS-Gates sind wieder vollständig freigabefähig: Frontend-Testinventar, Modul-Coverage und Komplexitätsbudgets wurden mit fachlichen Regressionstests korrigiert und die Windows-Lizenzprüfung akzeptiert LF sowie CRLF.
- Publizierte oder archivierte XML-Vertragsversionen können nach expliziter Bestätigung endgültig gelöscht werden, sobald kein Signal-Schema-Profil mehr darauf verweist.
- Lokaler Docker-Zugriff sperrt die Komfortsession bis zur sichtbaren Erststartaktion, zeigt den serverseitig erzeugten dauerhaften Admin-Bearer genau einmal an und verwendet erst bei späteren Browser-Sitzungen kurzlebige lokale Session-Tokens.
- XML-Verträge werden ohne redundanten Sidebar-Eintrag zentral unter **Trading → Verträge** verwaltet; Erstellen, Versionieren, Bearbeiten, Duplizieren und Löschen bleiben vollständig in der Web-UI steuerbar.
- MCP-Agenten können nach expliziter Bestätigung gelöscht werden; Token, Rechte, Sitzungen und wartende Kontrollanforderungen werden sofort widerrufen, während anonymisierte Audit-Referenzen erhalten bleiben.
- **Betriebsdaten leeren** bewahrt Trading-Historie, Strategien, Konten, Exchange-Secrets und von Trades referenzierte Signale.
- Strategieversionen können nur ohne aktive Route beziehungsweise aufbewahrte Trade-Historie sicher gelöscht werden.
- Exchange-Order-Historie, Trading-Safety-Halt, Clock-Drift-Gates und Recovery-Pfade bleiben nach Fehlern fail-closed und nachvollziehbar.
- Sonar-, CodeQL- und Aikido-Funde in Audit-, Backup-, Datenbank-, Process-Lock-, Executor- und Vergleichspfaden wurden behoben und mit Regressionstests abgesichert.
- Factory Reset und Restore quiescen nun auch interne und unabhängige MCP-Zugriffe über einen gemeinsamen Wartungsmarker, bevor SQLite ersetzt oder gelöscht wird.

### Security

- Alertmanager 0.33.1 wird aus dem verifizierten Upstream-Commit mit checksum-geprüften Release-Assets, Go 1.26.6 sowie korrigierten `x/text`-, gRPC-, `x/crypto`-, `klauspost/compress`- und OpenTelemetry-Versionen statisch in eine digest-gepinnte Non-Root-Distroless-Runtime gebaut. Deterministische Zeitstempel und getrennt gescannte `amd64`-/`arm64`-Artefakte sichern die reproduzierbaren Kandidaten; die frühere Alertmanager-VEX-Ausnahme wurde vollständig entfernt.
- Verwundbare transitive Node-Abhängigkeiten wurden auf abgesicherte Versionen angehoben; Backend- und Frontend-Audit-Gates melden keine Schwachstellen mehr.
- Prometheus wurde auf das digest-gepinnte Security-Release 3.13.2 aktualisiert; die frühere VEX-Ausnahme entfällt, weil die korrigierten `x/text`- und gRPC-Versionen direkt im Image enthalten sind.
- Schutz vor Symlink-/Junction-Ausbruch, manipulierten Backup-/Audit-Dateien, unsicheren Vergleichen und ungebundenen Exchange-/DB-Zuständen wurde verschärft.
- CodeQL, Secret-History, Container-SBOM/Vulnerability Scan und vier kritische Mutation-Gates laufen im verpflichtenden Quality-Workflow.
- MCP-Agenten besitzen keine Exchange-Secrets oder direkten Adapter; jede Mutation prüft aktuelle Rechte erneut und benötigt einen erfolgreichen Vorab-Audit-Record sowie die bestehende Trading-Sicherheitslogik.
- Dashboard, Metriken und MCP bleiben Host-Loopback-only; Tailscale Serve ist tailnet-intern und Funnel für diese Endpunkte ausdrücklich verboten.
- Die lokale PR-Risikoanalyse und der Risikoakzeptanz-Validator bleiben als optionale Prüfwerkzeuge erhalten, ohne eigenen GitHub-Status-Publisher oder zusätzliche App-Credentials.
- Risikoakzeptanz-Records verlangen konkrete Inhalte in allen vier Pflichtabschnitten; leere Überschriften, Platzhalter, ungültige Laufzeiten und identische Owner-/Approver-Namen werden abgelehnt.

## [2.0.0] - 2026-07-21

### Security

- Existing dashboard administrator tokens are no longer recoverable through the unauthenticated local-session bootstrap route; managed secrets default outside the checkout and build contexts reject runtime secret paths.
- Dashboard mutations persist secret-redacted semantic before/after outcomes before acknowledging success.
- High-risk pull requests, unsigned or off-main release tags, unpinned executor deployments, dependency drift, and missing ownership now fail their respective release gates.

### Changed

- Frontend polling is serialized, abortable, and background-aware; keyboard and accessible-name coverage was added to dynamic controls.
- Trading starts protection-only and enables new entries only after reconciliation, monitoring, backup, routing and persisted-runtime gates pass.
- Backup manifests now bind the complete application/database feature set and reject legacy or exposure-bearing restores.

### Fixed

- Exchange account identity is bound across credential rotation and reconciliation; missing or unmanaged exposure is fail-closed.
- Daily trading limits include realized fees, unrealized PnL, live funding payments and active-plan risk reservations.
- Live entries register a provider-native reduce-only stop atomically, stop replacement establishes the new protection first, and emergency flatten remains unresolved until reconciliation proves closure.
- SQLite transactions, maintenance, restore, retention and paper-exchange writes now share one serialized ownership coordinator.
- AI execution values must be uniquely grounded in the labelled source segment and reject conflicting pairs, sides and decoy values.

### Added

- Vollständige Web-Control-Plane für Telegram-/OpenRouter-Secrets, Runtime-/Enterprise-Einstellungen, editierbare Default-Templates, Bearer-Key-Erzeugung, Monitoring-Secrets, lokale und verschlüsselte Off-site-Recovery sowie vollständigen Factory Reset.
- Integrierter Standalone-Start ohne Bearer-Dialog, sessiongebundener Browserzugang und ausführbare Frontend-Verhaltenstests für kritische Enterprise-Aktionen.
- Echte Readiness- und Pending-Alter-Metriken, serieller Mutations-Lock und gestreamtes Audit-Replay ohne unkontrollierte Speicherspitze.

- Fail-closed Kanonisierung von Telegram-Quellen für quellspezifische Filter, Aliase und KI-Templates.
- Begrenzte operative Daten-Retention mit Disk-/SQLite-Kapazitätsmetriken und Readiness-Gates.
- Isolierte, terminierende Mutation-Shards für Queue, Retry und KI-Schema mit eigenständiger Evidenz.
- Wöchentliche Vollprüfung, harte Container-CVE-Policy und ein attestiertes, nur nach allen Quality-Gates publizierbares Release-Image.
- Fail-closed Secret-File-Unterstützung für Orchestrator-/Vault-Mounts mit sicherer Umgebungspriorität.
- Verschlüsselte Off-host-Backups mit erzwungenem Download, Authentizitätsprüfung und vollständiger Restore-Verifikation vor Erfolgsmeldung.
- Gepinnter Prometheus-/Alertmanager-Stack mit getesteten Sicherheitsalarmen, authentifiziertem HTTPS-Incident-Relay und synthetischem Zustelltest.
- Reales Staging-Telegram-E2E, viertelstündliche synthetische Prüfung und inhaltsfreie Evidence-Artefakte ohne Human-in-the-loop.
- Gemessene Delivery-SLIs, getestete SLO-Burn-Alarme und ein verpflichtendes automatisiertes 30-Tage-Produktionsfenster vor Release.
- Lückenlose, checksum-geschützte SQLite-Migrationen mit verifiziertem Pre-Migration-Snapshot und forensisch sicherem Downgrade-Restore.
- Fail-closed, hashverketteter Control-Plane-Audit-Trail mit verpflichtender externer HTTPS-Persistenz im Produktions-Container.
- OIDC-/JWKS-Authentifizierung mit geprüftem Issuer, Audience, Zeitgrenzen und Admin-/Viewer-Rollen für die Production-Control-Plane.
- Automatischer Diff-basierter PR-Risikoscore, Dependabot-Matrix und API-verifiziertes GitHub-Governance-Release-Gate.

## [1.0.0] - 2026-07-13

### Added

- Durable SQLite-Inbox/Outbox mit bestätigter TDLib-Zustellung und fail-closed `unknown`-Reconciliation.
- Strikte, geerdete KI-Signalverträge, Provider-Budgets, Provenance und adversariales Golden Set ohne Runtime-Human-in-the-loop.
- Rollenbasierte Loopback-Control-Plane, ehrliche Health-/Readiness-Metriken und korrelierte Zustelllogs.
- Verifizierte Backups, Offline-Restore, Crash-Loop-Schutz und Graceful Shutdown.
- Quality-OS mit Coverage-, Mutation-, Architektur-, Secret-, SAST-, Dependency-, Lizenz-, SBOM- und Container-Gates.

### Changed

- Container läuft non-root mit read-only Root-Dateisystem, begrenzten Ressourcen, gepinntem Base-Image und ohne npm im Runtime-Layer.
- Konfiguration wird atomar und ohne Secret-Persistenz geschrieben.
- Frontend enthält nur erreichbare Produktivmodule und tatsächlich verwendete Dependencies; große Chart-Abhängigkeiten werden separat gebündelt.

### Security

- Dashboard-Authentifizierung, exakte CORS-Origin, Security Header, Request-Limits und Bestätigung destruktiver Aktionen.
- GitHub Actions sind per vollständigem SHA gepinnt; Trivy verwendet den nach GHSA-69fq-xp46-6x23 sicheren Action-/Scanner-Stand.
- Container- und npm-Scans blockieren bekannte moderate beziehungsweise HIGH/CRITICAL-Funde.
