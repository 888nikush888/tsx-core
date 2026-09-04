# 009 – KuCoin Classic: isoliertes Raw-Provider-Teilpaket

Stand: 2026-09-04. Ziel-SDK ist ausschließlich das lokal installierte und in
permanenten Tests auf `ccxt==4.5.75` gepinnte Paket. Diese Implementierung ist
**keine Profil-, Konto-, Provider- oder Releasefreigabe**. Es gab keine
Netzwerkverbindung, kein echtes Konto, keine Secrets und keine Order. Die
gemeinsamen Dispatch-, Profil-, Registry-, Receipt-, DB- und Node-Dateien
blieben absichtlich unverändert.

## Implementierter enger Scope

Der Code gilt nur für KuCoin Classic Futures, one-way/`BOTH`, `CROSS`, aktive
lineare USDT-Perpetuals und die beiden CCXT-Katalog-IDs `kucoin` und
`kucoinfutures`, die denselben Classic-Contractpfad erben. Andere Produkte,
UTA, Isolated, Hedge, inverse/dated Contracts, USDC und andere Settlements sind
nicht abgedeckt.

| Neue Datei | Abgegrenzeter Vertrag |
|---|---|
| `exchange_executor/kucoin_provider_common.py` | Verlustfreie Token-/Integer-/Decimal-, Envelope-, Markt- und Page-Grenzen. Float und Bool werden für wirtschaftliche Werte abgewiesen. Page-Zähler und Declared Total müssen exakt zusammenpassen. |
| `exchange_executor/kucoin_identity.py` | Genau fünf budgetierte Raw-Reads: signierte API-Key-UID/Permission, `CLASSIC`, Positionmode `0`, symbolgebundenes `CROSS`, symbolgebundener ganzzahliger Leverage. Die Antwort enthält keine API-Key-/Remark-Secrets. |
| `exchange_executor/kucoin_execution.py` | Per-Leg-Klassifikation des Batch-ACK anhand eigener `clientOid`, nativem Symbol und exakter `orderId`. Missing/Duplicate/Foreign/Unknown/Transient bleibt `UnresolvedOrderOutcome`. Nur dokumentierte eindeutige Validation-/Capacity-Codes gelten als definite Rejection. |
| `exchange_executor/kucoin_current_state.py` | Providerzeit, vollständige Positionsliste, paginierte normale aktive Orders und paginierte ungetriggerte Stoporders. Nur USDT/CROSS/BOTH; Seiten-/Zählerdrift und fremde Produkte sperren. Remote-`clientOid` darf fehlen, Exchange-ID nicht. |
| `exchange_executor/kucoin_history.py` | Je Aufruf genau eine rohe Order- oder Fillseite innerhalb eines festen maximal siebentägigen Fensters. Cursor bindet nächste Seite und ursprüngliches Total. Accountweiter Scan ohne erfundenen Symbolfilter ist möglich. `tradeTime` liefert ohne Floatdivision die Eventzeit; `createdAt` bleibt zusätzlicher Originalbeleg. EOF bleibt wegen Retention/Nachlieferung `unknown`. |
| `exchange_executor/kucoin_money.py` | Exakte USDT-Accountübersicht, Funding in festen eintägigen Zeit-Slices ohne unsichere Offsetpagination und Futures-Ledger mit dokumentiertem `dataList/hasMore/min(offset)`-Vertrag. Pending-Ledgerstatus bleibt sichtbar. Alles bleibt `provider-as-observed/unknown`. |

Alle Provideroriginale werden per Deep Copy erhalten. IDs größer als `2^53`
bleiben als exakte Strings erhalten; nirgends wird über Float gerechnet. Mengen,
Seiten, Deadline und Calls nutzen die vorhandenen `CurrentRead`- und
`RecoveryReadBudget`-Grenzen. Die Helpers verändern die übergebenen Antworten
und Checkpoints nicht.

## Permanente lokale Tests

Neu:

- `exchange_executor/tests/test_kucoin_provider_control.py`
- `exchange_executor/tests/test_kucoin_provider_data.py`
- `exchange_executor/tests/test_kucoin_provider_sdk_boundaries.py`

Die Tests decken positive und fail-closed Fälle für UID-/Generation-/Modusdrift,
fehlende Permissions, Float/Bool, ACK-Mischfälle, unbekannte/transiente
Fehlercodes, große IDs, Seitendrift, normale Orders plus Stops, fremde
Settlement-/Margin-Sichten, autoritative Fillzeit, Accountscan, Balance,
Funding-Zeitslices und Ledger-Offsets ab. Socket/DNS sind blockiert.

Die SDK-Grenztests führen für **beide** Katalog-IDs die echten generierten
CCXT-Raw-Accessors und den echten Signer bis zu einem lokalen `fetch`-Interceptor
aus. Dabei werden unter anderem diese Pfade und Querygrenzen geprüft:

- `/api/v1/user/api-key`, `/api/ua/v1/account/mode`;
- `/api/v2/position/getPositionMode`, `getMarginMode`,
  `getCrossUserLeverage`;
- `/api/v1/positions`, `/api/v1/orders?status=active`,
  `/api/v1/stopOrders`;
- `/api/v1/fills`, `/api/v1/account-overview`,
  `/api/v1/funding-history`, `/api/v1/transaction-history`.

Letzter fokussierter Lauf: 22 Tests, alle erfolgreich. Ruff und C901 werden für
alle neun neuen Dateien separat ausgeführt.

## Verbleibende STOP-Grenzen und Integrationshaken

1. **Exakte HTTP-Originale:** Der normale CCXT-JSON-Pfad dekodiert viele
   Providerzahlen als Python-`float`; KuCoin dokumentiert genau solche
   numerischen JSON-Felder. Die Helpers lehnen diese Werte absichtlich ab. Vor
   Live-Wiring braucht jede zugehörige Raw-Anfrage einen requestlokal gebundenen
   verlustfreien Response-Capture (`parse_float=Decimal`) samt Request-/Response-
   Korrelation. Ohne ihn bleibt der Provider fail-closed.
2. **Keine gemeinsame Verdrahtung:** `current_state`, `history_pagination`,
   `history_coverage`, Accountlog/Moneyconsumer, Credentialclient, Adapter,
   Profile, Registry, Receipts und Node kennen diese Helpers noch nicht. Die
   fünf Mode-/UID-Reads brauchen dort eine kurze TTL, Account-/Generation- und
   Market-Scope-Bindung; lokales `observedAt` ist keine Providerzeit.
3. **Historische Stoporders:** Aktuelle ungetriggerte Stops sind abgedeckt.
   Historische Stoporders sind ein eigener Providerstream, während der heutige
   gemeinsame History-Checkpoint nur `orders|fills` kennt. Normale History wird
   nicht fälschlich als vollständige Stophistory ausgegeben.
4. **Finalität:** KuCoin-Fills sind ausdrücklich nicht Echtzeit und haben
   begrenzte Retention. Page-EOF ist nur as-observed. Es gibt weiterhin keinen
   dokumentierten maximalen Nachlieferungshorizont und daher keine automatische
   accountweite Fill-Coverage.
5. **Funding-Scope:** Funding ist symbolpflichtig. Ein dauerhaftes Universum aus
   Journal, offenen/alten Positionen und historischen Fills – inklusive später
   delisteter Symbole – fehlt im gemeinsamen Consumer. Gesättigte eintägige
   Zeitslices sperren, statt mit der vom Provider als ungenau beschriebenen
   Offsetpagination fortzufahren.
6. **Ledger-Semantik:** Pending-/aggregierte `RealisedPNL`-Einträge werden nur
   beobachtet, nicht als einzelne Fills oder Fundingevents verbucht und nicht
   doppelt gezählt. Diese Consumerentscheidung bleibt offen.
7. **Capacity:** Der belegte Cross-Capacity-Quote passt nicht in den bestehenden
   Tiervertrag. `provider_capacity_quote_v1`, Planhash-/Mengen-/Preis-/Margin-
   Bindung und beide Providergrenzen müssen gemeinsam entschieden werden; hier
   wurde kein Fantasietier implementiert.
8. **Lifecycle/Abnahme:** Positiver Orderreadback, Cancel-/Late-Fill-Lifecycle,
   Stream-Trigger für normale und Stoporders, echte Region-/Permission-
   Verträglichkeit und autorisierte Providerabnahme fehlen. Weder Testendpoint
   noch ein Mainnetkonto wurden verwendet.

Erst nach Auflösung dieser STOPs, gemeinsamer Verdrahtung und den vorhandenen
cross-layer Acceptance-/Receipt-Gates darf über ein Profil oder eine Freigabe
entschieden werden.
