# Exchange stream health debounce

## Regression

CCXT Pro betreibt Orders, Trades, Positionen und optional Ticker als parallele
Watcher. Zuvor schrieben alle Watcher in denselben globalen Status. Ein einzelner
kurzer Provider-Timeout erzeugte deshalb sofort `degraded`; die nächste Antwort
eines beliebigen anderen Watchers erzeugte unmittelbar `healthy`. Das verursachte
irreführende Degraded-/Recovered-Benachrichtigungspaare, obwohl kein Cursor-Gap
vorlag und der autoritative REST-Abgleich gesund blieb.

## Invarianten

- Der Zustand wird pro Watcher-Kanal geführt und gilt identisch für alle Börsen.
- Ein kanalspezifischer Fehler muss 15 Sekunden ununterbrochen bestehen, bevor der
  aggregierte Streamstatus auf `degraded` wechselt.
- Nur eine erfolgreiche Antwort desselben Kanals löscht dessen Fehlerzustand.
- Ein Cursor-Gap bleibt von der Entprellung ausgenommen und wird in der
  Node-Schicht sofort als `degraded` persistiert.
- CCXT Pro bleibt ausschließlich Beschleuniger; der REST-Abgleich bleibt
  autoritativ und läuft während jeder Streamstörung weiter.

## Nachweis

`StreamTests.test_transient_channel_failure_is_debounced_and_other_channels_cannot_recover_it`
prüft die zertifizierten Adapter Hyperliquid, Bybit und Kraken Futures. Der Test
beweist sowohl die 15-Sekunden-Frist als auch die kanalspezifische Recovery.
