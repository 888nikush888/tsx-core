# 005 FX — begrenzter Python-Producer

Stand 2026-09-02. Beide ursprünglichen Pläne `005-money-risk-ledger.md` und `005-FX-FOLLOWUP-PLAN.md` wurden vollständig gelesen. Neuere ausdrückliche Root-Freigabe: nur USD/USDT/USDC; höchstens zehn Sekunden alte geeignete Beobachtung vor Event beziehungsweise aktuellem Sizing; Crosslegs höchstens eine Sekunde auseinander. Die schwächere Provider-Snapshotbeobachtung ist sichtbar zulässig, aber weder Tickzeit noch lokale Empfangszeit dürfen daraus erfunden werden. Exakte Rationalrechnung, Speicherung, Money-/Sizing-/Riskconsumer und M43 gehören Root.

## Fertige enge Helperstufe

Neue Produktionsdatei ausschließlich `exchange_executor/fx_evidence.py`:

```python
await read_fx_evidence(rest, mode, requested_leg_ids, existing_budget)
```

`existing_budget` ist der vorhandene `RecoveryReadBudget`, keine zweite Instanz. Null bis drei verschiedene explizite Leg-IDs sind zulässig:

| Leg-ID | Fester Request | Originalfeld | Geplante Node-Route |
| --- | --- | --- | --- |
| `bybit:btc-usd-index:v1` | inverse / BTCUSD | indexPrice | USDT→USD index-ratio |
| `bybit:btc-usdt-index:v1` | linear / BTCUSDT | indexPrice | USDT→USD index-ratio |
| `bybit:usdc-usd-index:v1` | spot / USDCUSDT | usdIndexPrice | USDC→USD index |

Keine dynamische Marktsuche, kein `load_markets`, kein Last-/Mark-/Parity-Fallback, keine andere Währung. Das Inversinstrument ist ausschließlich eine Indexquelle, kein freigegebenes Handelsprodukt. Der vorhandene Bybit-Client benutzt seinen realen öffentlichen CCXT-v5-Aufruf; keine Credentials werden angefordert. Live/Testnet-Origin wird gegen den tatsächlichen konfigurierten SDK-Public-Endpunkt vor und nach jedem Read geprüft: ausschließlich `https://api.bybit.com` beziehungsweise `https://api-testnet.bybit.com`. Keine automatische Regional-/Demo-/Crossvenue-Ausweichroute.

Die [offizielle Tickerbeschreibung](https://bybit-exchange.github.io/docs/v5/market/tickers) unterscheidet `indexPrice` und den für UTA-Assetbewertung bestimmten Spot-`usdIndexPrice`; die [UTA-FAQ](https://www.bybit.com/en/help-center/article/FAQ-Unified-Trading-Account) beschreibt den BTCUSD/BTCUSDT-Indexquotienten. Der [Integrationsvertrag](https://bybit-exchange.github.io/docs/v5/guide) benennt die beiden verwendeten Origins. Nur diese Dokumentationsseiten wurden öffentlich gelesen; kein API-/Kontozugriff wurde ausgeführt. Diese Quellen ersetzen keine Providerabnahme der späteren produktiven Integration.

## DTO und Zeit-/Hashgrenzen

Progress: `{version:1,calls,receipts,reason,nextReadAt}`. `reason` ist null, `budget_exhausted`, `transient`, `unsupported` oder `invalid_evidence`. Erfolgreiche einzelne Receipts bleiben bei späterem Fehler erhalten; ein Prefix ist niemals eine vollständige Crossrate. Es gibt keinen Python-Quotecache, Cursor oder Backgroundworker.

Jedes einzelne Receipt enthält genau die vereinbarten öffentlichen Herkunftsfelder: `version`, `provider`, `mode`, `origin`, `endpoint`, `source`, `ccxtVersion`, `profileVersion`, `profileHash`, `legId`, `routeId`, `category`, `symbol`, `field`, `value`, `providerQuoteAt`, `providerResponseAt`, `timeBasis`, `startedAt`, `completedAt`, `envelope`, `envelopeHash`, `receiptHash`.

- Quelle `bybit-v5-rest-index-snapshot-v1`, CCXT `4.5.75`, vorhandene Profilversion 1. Profilhash stammt vom bestehenden Profil; es wird keine neue Capability/Accountfreigabe gesetzt.
- `value` ist der originale positive Dezimalstring einschließlich erhaltenen Nullen, kein Float und kein gerundeter Quotient. Python berechnet keine Rate. `60000.000 / 60150.000` bleibt als beide Originale verfügbar; die genaue `400/401`-Ableitung gehört Node.
- `providerQuoteAt=null`. `providerResponseAt` ist ausschließlich das originale äußere `envelope.time`; `timeBasis='provider_snapshot_observation'`. Weder ein Feld `time` in einer Tickerzeile noch lokales `completedAt` wird als dokumentierte Quoteentstehung verwendet.
- Zeiten sind sichere nichtnegative Integer. `startedAt <= completedAt`, Spanne höchstens 10000 ms; Providerresponse liegt innerhalb `[startedAt-1000, completedAt+1000]`, Completion höchstens 1000 ms in der Zukunft des lokalen Prüfzeitpunkts. Diese Uhrtoleranz ist keine Erlaubnis, eine nach Event erzeugte Quote zu verwenden. Historische und aktuelle As-of-Auswahl sowie die 1s-Paarprüfung bleiben ausdrücklich Node-Aufgabe.
- Providerresponse muss `retCode===0`, passende Kategorie und exakt eine Zeile mit passendem Symbol sowie Originalfeld enthalten. Fehlende, leere, numerische oder exponentielle Werte werden nicht durch andere Tickerfelder ersetzt.
- Envelope wird unverändert als abgelöstes JSON-Objekt gehalten. Es ist die erhaltene SDK-JSON-Antwort, nicht ein vorgegebenes signiertes Original-HTTP-Byteprotokoll.
- SHA-256 von UTF-8(`domain + '\n' + canonicalJSON`). Domains `bybit-fx-envelope-v1` und `bybit-fx-receipt-v1`; Receipt ohne `receiptHash`. Rekursive Objektschlüsselreihenfolge nach Unicode-Codepoints, keine Whitespaces, Strings unverändert, Zahlen nur sichere Integer. Keine Float-Rekanonisierung oder Surrogates.
- Envelope-JSON ist strikt kleiner als 65536 UTF-8-Bytes. Stringwerte strikt kleiner als 32768 UTF-8-Bytes. Schlüssel maximal 256 Unicode-Codepoints, ohne C0-/DEL-/C1-Controlzeichen. Tiefe startet bei 0 und ist höchstens 12. Envelopebudget 256 Nodes, Hash-/Receiptbudget 512 Nodes; beide Zähler zählen jede Value-Node **und** jeden Objektschlüssel. Diese konservativen Grenzen wurden Root zum Node-Abgleich gemeldet.

Accountfingerprint und Credentialgeneration sind keine künstliche öffentliche Quoteidentität. Der spätere Aufruf-/Persistenzumschlag muss sie separat anhand der gehaltenen Accountbindung verifizieren. Der Helper nimmt keine freien Caller-Rates, Fee-Assets oder Money-IDs entgegen.

## Budgetbeweis und reale rote Fälle

Die erste neue permanente Testdatei wurde vor Produktionscode ausgeführt und scheiterte am noch fehlenden Producer-Modul. Das ist ein dokumentierter fehlender Implementierungspfad, keine Behauptung einer bereits vorhandenen FX-Verhaltensregression.

Danach tatsächlich rote echte SDK-Gegenprobe: `options.maxRetriesOnFailure=2` und abgefangener `RequestTimeout` ergaben **drei HTTP-Versuche bei nur einem gezählten Budget-Read**. Der neue FX-Request setzt deshalb SDK-intern `maxRetriesOnFailure:0`. CCXT 4.5.75 entfernt diesen Parameter vor Signierung; permanente Transporttests prüfen weiterhin ausschließlich `category` und `symbol` auf dem Draht. Die globale Clientoption wird nicht geändert. Damit entspricht ein FX-`budget.call` höchstens einem tatsächlichen SDK-HTTP-Versuch. Gemeinsamer Cooldown, Fünfergrenze, Deadline und Serialisierungsreserve bleiben unverändert.

Ebenso zuerst rot und danach grün: überlange beziehungsweise Controlzeichen enthaltende JSON-Schlüssel. Keine Anpassung von Gates oder Erwartungswerten zur Umgehung dieser Fälle.

## Lokale Tests / Crosslanguage-Handoff

`exchange_executor/tests/test_fx_evidence.py`: 22 fokussierte Methoden grün mit echter gepinnter SDK-Signierung/JSON-Verarbeitung und vollständig abgefangenem `fetch`. Belegt sind alle drei Routen, Originalstrings/-envelopes, Live/Testnet, falsche Kategorie/Symbole/Felder, leere/negative/numerische Werte, fehlende/Boolean-/falsche Providerzeit, exakte Zeitgrenzen, tiefe/übergroße/unsichere JSON-Daten, SDK-/Profil-/Origin-Drift, abgelöste Originale, Budget/Deadline/Cooldown/Retry-After, erfolgreiche Prefixe, Folgeaufruf ohne In-Memory-Cursor, ungültige Cross-Leg-Synchronität ohne falsche Pair-Freigabe und Hashbindung.

`exchange_executor/tests/fx_evidence_fixture.py` gibt ohne Argumente ein tatsächliches Progress-JSON mit allen drei Receipts für Root-Node-Tests aus. Es nutzt denselben echten Producer und SDK, ebenfalls ausschließlich lokale Fakes. Zeitstempel sind die kontrollierte aktuelle Fixturezeit; es werden keine heutigen Quotes als alte Ereignisquotes ausgegeben.

Fokussierter Lauf und Ruff über diese drei Dateien: Exit 0. Root hat nach Ende seines Mutation-Laufs den vollständigen Python-Nachlauf ausdrücklich freigegeben; dessen Ergebnis wird unten ergänzt. Kein Node-/Migrations-/Status-/Packageedit durch diesen Teilagenten.

## Bewusst noch nicht angeschlossen

Keine Änderungen an `ccxt_adapter.py`, `account_log_scheduler.py`, `ccxt_profiles.py`, Server, Stream oder Loader. Root hat den Produktionsanschluss ausdrücklich auf einen nächsten abgestimmten Schritt verschoben. Ein bloßer Hook wäre nicht ausreichend: bestehende Reihenfolge targeted→mode→account-log→history braucht dauerhafte und getestete FX-/History-Fairness; ein zweiter Fünfertopf oder ein unbegrenzter Quotecache ist ausgeschlossen. Historische Quotehaltung, Restart/CAS, Account-/Generationsbindung, Eventbewertung, Rational-/Rundungsvertrag, aktuelle Sizing-/Risk-/Tiertransformation und finaler Sendfence bleiben separate Root-Integrationspflichten. 005 ist durch diesen Helper nicht DONE.

Finaler freigegebener eigener Pythonlauf: `python -B -m unittest discover -s exchange_executor/tests` — **319/319 grün, 42.484 s, Exit 0**. Sämtliche bisherigen History-/Retention-/Mode-/Quantity-/Nativeidentity-/TTL-/Kraken-/Acceptance-Fälle bleiben enthalten. Danach keine weitere Produktionsänderung; diese Helperstufe wird für Root eingefroren. Neue Produktionsquelle für Sonar: `exchange_executor/fx_evidence.py`; neue Python-Testdatei wird durch die vorhandene Discovery erfasst.
