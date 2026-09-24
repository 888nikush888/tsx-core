# Hyperliquid Testnet: öffentliche Konto-Vorprüfung

`scripts/hyperliquid_testnet_preflight.py` liest ausschließlich öffentliche Kontodaten über die [offizielle Testnet-Info-API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint). Beispiel:

```sh
python scripts/hyperliquid_testnet_preflight.py --address-file /path/to/public-address.txt
```

Die Datei muss genau eine öffentliche `0x`-Adresse enthalten. Die Alternative `--address` ist möglich, macht die Adresse aber in Prozessargumenten sichtbar. **Keinen Private Key oder Agent-Key angeben.** Das Programm lädt keine Credentials und unterstützt weder die Exchange-API noch Orders. Es stellt nacheinander nur `userRole`, `clearinghouseState` und `openOrders` an `https://api.hyperliquid-testnet.xyz/info`. Der HTTPS-Client verwendet keinen Proxy und folgt keinen Redirects; jede Antwort ist auf 64 KiB begrenzt. Der Socket hat ein Timeout von fünf Sekunden pro blockierendem Netzwerkvorgang; das ist kein harter Gesamtlaufzeit- oder Momentaufnahmegrenzwert.

Die JSON-Ausgabe enthält Rolle, Positions- und Orderanzahl sowie boolesche Angaben zu Kontowert und abziehbarem Betrag. Sie enthält weder Adresse noch Geldbeträge. `flat` kombiniert Positionsgrößen und den Provider-Wert `totalNtlPos`, sodass ein widersprüchlicher Restnotional nicht als flach gilt. Ein Lesefehler oder unerwartetes Antwortformat beendet den Check mit Fehlerstatus.

Dies ist eine **diagnostische Momentaufnahme**, keine Providerabnahme, kein Besitz- oder Cleanupnachweis und keine Livefreigabe. Die drei Antworten sind nicht atomar; zwischen den Lesevorgängen können Positionen oder Orders entstehen. Master-Wallet-Bindung an einen Schlüssel, Kontomodus, Ordersemantik und alle Fälle aus [exchange-acceptance.md](exchange-acceptance.md) bleiben separat nachzuweisen. Die bestehenden Offline-Schutzgates und der Realtransport-Entwurf bleiben unverändert.
