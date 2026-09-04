# ADR 0001: Durable Outbox mit bestätigter Zustellung

- Status: Accepted
- Datum: 2026-07-13

## Kontext

Eine JSON-Queue konnte beim Prozessabbruch beschädigt werden und ein API-Aufruf allein beweist keine Telegram-Zustellung. Automatische Wiederholung nach unklarem Sendestatus kann Duplikate erzeugen.

## Entscheidung

Inbox-Deduplizierung und Outbox liegen transaktional in SQLite. Der Zustandsautomat ist `pending → preparing → sending → completed`; nur TDLib-Sendebestätigung schließt ab. Ein Neustart aus `sending` erzeugt `unknown` und blockiert automatische Wiederholung bis zur Operator-Reconciliation.

Seit Migration 34 werden Inbox und dauerhafter Klassifizierungsauftrag mit identischem Telegram-Quellschlüssel gemeinsam gespeichert. Die Workflowrevision, nichtgeheime fachliche Ressourcen und der ursprüngliche Zeitanker werden innerhalb derselben Transaktion festgelegt. Der Klassifizierer schreibt alle Routingfolgen und seinen Abschluss atomar; Albumabschluss und Weiterleitungsauftrag teilen ebenfalls eine Transaktion. Einzelne externe Telegramausgaben erhalten deterministische Child-IDs und behalten den bestehenden bestätigten Outbox-Zustandsautomaten.

Unbelegter Altbestand bleibt in `needs_review`; bereits unklare Sendungen bleiben `unknown`. Kein Upgrade ermächtigt zur historischen Wiederholung. Die gepinnte Workflowdefinition ersetzt keine aktuelle Kontosperre oder strukturelle Pfadfreigabe. Ein anderer aktiver Pfad zum selben Konto autorisiert keinen entfernten ursprünglichen Pfad.

AI-Reservierungen besitzen je Providerattempt eine ID; Settlement ist unter dieser ID idempotent. Bekannte Nutzung bleibt bei Datenbankfehlern bekannt, statt durch eine pauschale zweite Belastung ersetzt zu werden. Harte Abstürze ohne Nutzungsbeleg halten die Reserve konservativ fest. Legacy-Tagesaggregate werden ohne erfundene Requests übernommen.

## Konsequenzen

Recovery ist fail closed und auditierbar. Operatoren müssen `unknown`-Tasks gegen den Zielkanal prüfen; der Dashboard-Endpunkt verlangt Admin-Authentifizierung und Destructive-Confirmation.

Es wird lokale Dauerhaftigkeit und Idempotenz zugesichert, kein Exactly-once für Telegram, AI oder Exchange-Provider. Noch referenzierte Revisionen und ungeklärte AI-Reserven dürfen bei Retention nicht verschwinden.
