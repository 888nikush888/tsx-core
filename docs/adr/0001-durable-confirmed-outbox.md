# ADR 0001: Durable Outbox mit bestätigter Zustellung

- Status: Accepted
- Datum: 2026-07-13

## Kontext

Eine JSON-Queue konnte beim Prozessabbruch beschädigt werden und ein API-Aufruf allein beweist keine Telegram-Zustellung. Automatische Wiederholung nach unklarem Sendestatus kann Duplikate erzeugen.

## Entscheidung

Inbox-Deduplizierung und Outbox liegen transaktional in SQLite. Der Zustandsautomat ist `pending → preparing → sending → completed`; nur TDLib-Sendebestätigung schließt ab. Ein Neustart aus `sending` erzeugt `unknown` und blockiert automatische Wiederholung bis zur Operator-Reconciliation.

## Konsequenzen

Recovery ist fail closed und auditierbar. Operatoren müssen `unknown`-Tasks gegen den Zielkanal prüfen; der Dashboard-Endpunkt verlangt Admin-Authentifizierung und Destructive-Confirmation.
