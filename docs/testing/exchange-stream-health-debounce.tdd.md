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
- Eine erfolgreiche Antwort desselben Kanals löscht dessen Fehlerzustand.
- Bei reinen CCXT-Netzwerkfehlern reicht alternativ die nachgewiesene erneute
  Versendung derselben Subscription auf einer verbundenen, fehlerfreien Verbindung
  mit noch wartendem Watch-Future. Ein offener Socket allein, andere Topics,
  Authentifizierung oder Daten eines anderen Watchers reichen nicht.
- Authentifizierungs- und Vertragsfehler bleiben bis zu einer erfolgreichen
  Antwort desselben Watchers sichtbar, auch nach weiteren Netzwerkfehlern.
- Ein Cursor-Gap bleibt von der Entprellung ausgenommen und wird in der
  Node-Schicht sofort als `degraded` persistiert.
- CCXT Pro bleibt ausschließlich Beschleuniger; der REST-Abgleich bleibt
  autoritativ und läuft während jeder Streamstörung weiter.

## Nachweis

Die erste reine Ereignis-Entprellung war unvollständig: Nach einer Wiederverbindung
kann `watch_orders` auf einem ruhigen Konto stundenlang auf die nächste Änderung
warten. Diese ausbleibende Nutzlast ist kein Nachweis einer weiterhin unterbrochenen
Verbindung. Die anschließende Laufzeitprüfung hat dieses Problem aufgedeckt.

`test_stream_health.py` führt tatsächliche CCXT-`watch`-/`watch_multiple`-Aufrufe
mit simulierten Sockets für sämtliche zertifizierten Profile aus. Getestet werden
kurze und lange Ausfälle, stille Wiederverbindungen ohne künstliche Orders,
blockiertes Senden, falsche Topics, kaputte Sockets, Auth-/Vertragsfehler,
begrenzter Retry, Cleanup und Keyword-Aufrufe. Die vorhandenen `StreamTests`
prüfen zusätzlich die 15-Sekunden-Grenze und sofortige Cursor-Gap-Erkennung.

Die Transportbeobachtung interpretiert keine börsenspezifischen Nutzlasten und
bestätigt keinen Order- oder Kontozustand. Die Versionsbindung von CCXT und diese
Integrationstests sichern die verwendeten generischen Hooks ab; REST bleibt
die fachliche Autorität.

`test_trade_journal_streams.js` prüft mehrere Ausfall-/Erholungsepisoden mit
identischem Cursor sowie einen Executor-Neustart mit Cursor 0. Jede tatsächliche
Statusänderung erhält eine eigene Benachrichtigungs-ID; wiederholte Polls im
gleichen Zustand erzeugen keine neue Meldung. Der angezeigte Cursor folgt der
aktuellen Executor-Session und darf nach einem Neustart sinken.
