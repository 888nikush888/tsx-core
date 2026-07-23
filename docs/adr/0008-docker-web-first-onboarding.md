# ADR 0008: Docker- und Web-First-Onboarding

- Status: Accepted
- Datum: 2026-07-14

## Kontext

Das frühere CLI-Menü duplizierte Konfiguration und Betrieb, erzwang für die erste TDLib-Anmeldung einen interaktiven Terminal-Lauf und machte Docker-Starts von vorbereiteten Host-Dateien und Verzeichnisrechten abhängig. Das widersprach dem Ziel eines reproduzierbaren Ein-Befehl-Starts und erzeugte unterschiedliche Verträge für Web und CLI.

## Entscheidung

Das interaktive CLI-Menü wird vollständig entfernt. Docker Compose ist der primäre Nutzungsweg und initialisiert persistente Volumes für Konfiguration, write-only Secrets, Templates, TDLib-Sitzung, SQLite, Signale, Logs und Backups. Der erste Browserzugriff erzeugt nach Origin- und Audit-Prüfung einmalig ein zufälliges Admin-Token. Telegram API Hash und OpenRouter-Key werden über einen authentifizierten, getrennten Secret-Endpunkt geschrieben und niemals zurückgegeben.

TDLib-Anforderungen für Telefonnummer, Code, E-Mail, 2FA und Gerätebestätigung werden als kurzlebige Web-Prompts abgebildet. Antworten existieren nur bis zur Übergabe an das aktive TDLib-Promise. Der Standalone-Modus bleibt sicher nutzbar; `ENTERPRISE_MODE=true` aktiviert unverändert die strengeren OIDC-, Remote-Audit- und Off-host-Backup-Gates. Eine inhaltliche Human-in-the-loop-Freigabe für automatische KI-Ergebnisse wird nicht eingeführt.

## Akzeptanzkriterien

- `docker compose up --build -d` funktioniert ohne `.env`, `config.json` oder vorbereitete Host-Verzeichnisse.
- Vor dem Token-Bootstrap ist nur der Bootstrap-Status öffentlich; der Bootstrap verlangt eine erlaubte Browser-Origin und den Dashboard-Mutationsheader.
- Secret-Status enthält nur `configured`, `editable` und `source`, nie einen Wert.
- Telegram-Codes und 2FA-Passwörter erscheinen weder in Statusantworten noch in Persistenz oder Logs.
- Container-Neuerstellung erhält alle benannten Volumes; `docker compose down -v` ist als destruktiver Total-Reset dokumentiert.
- Enterprise-Gates können durch den Standalone-Komfortmodus nicht umgangen werden.

ADR 0009 konkretisiert den später hinzugefügten bevorzugten anwendungsweiten Factory Reset. `docker compose down -v` bleibt lediglich der grobe Docker-Volume-Reset; für den Normalbetrieb ist die vorab geprüfte Web-Aktion unter **System & Backup → Factory Reset** maßgeblich.
