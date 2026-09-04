# 001/002/005: enger Review der additiven Legacy-Fill-Bindung

Stand 2026-09-02; HEAD `f808927`, umfangreiche koordinierte lokale Änderungen. Read-only-Review der produktiven Sources, keine Migration implementiert. Der Improve-Skill begrenzt eigene Dateien auf `plans/`; daher liegen auch die zwei isolierten Beweisfälle hier. Root/HL-Agent besitzen Implementierung und Abnahme. Keine echte Datenbank, Providerverbindung, Credentials, Runtime, Server oder Git-Mutation verwendet.

## Ergebnis

Eine alte **bereits gebuchte lokale Fill-ID** darf bei vollständigen Originalbelegen zusätzliche Namespace-Metadaten bekommen. Ihre ID, `raw_json`, Preis/Menge/Gebühr/Zeit und vorhandene Money-Originale bleiben unverändert. Fehlende neue M40-Bindingtabellen allein sind kein Negativbeweis: Die Tabelle existierte in M39 noch nicht. Umgekehrt genügen ein aktuelles Konto, aktuelle Marktdaten oder ähnliche Economics nicht zum Rückdatieren einer Bindung.

Der entscheidende unabhängig entdeckte Gegenbeleg betrifft Bybit: **`ccxt-market-v1.linear=true` allein bedeutet nicht Namespace `linear`**. Die gepinnte CCXT-Implementierung kennzeichnet auch Optionen so. Der HL-Agent wurde vor Freigabe informiert und korrigiert den Entwurf samt negativem Optionstest.

## Geprüfte Quellen und unveränderte Daten

- `src/db.ts:2337`: M40 baut Fills/Moneytabellen neu auf, kopiert alle bisherigen Fillspalten unverändert und setzt zunächst `legacy_unresolved`. Native Eindeutigkeit ist anschließend `(account_id, remote_fill_key)`; Money-Identität bei `basis='fill'` ist `(account_id, account_fingerprint, fill_id, kind)`. Der Preflight ab Zeile 2475 verweigert mehrdeutige alte Buchungen statt sie zu löschen.
- `src/trading_money_ledger.ts:187`: Wiederholung eines Fill-Moneyereignisses darf Quelle/Transportlabel abweichend melden, erhält aber bestehende Event-ID, Original-JSON und Bewertungen. Andere Economics, Fill-ID, Accountbindung oder Ableitung sind Konflikte. `canonicalMoneyIdentity` ab Zeile 195 macht die lokale Fill-ID zur deduplizierenden Basis, nicht eine neu erzeugte native Label-ID.
- `src/trading_fill_accounting.ts:30`: Originaler Fill-Fingerprint und Accountingmetadaten wurden beim korrelierten Empfang gespeichert. M36 ergänzte die Spalten; alte Nullwerte werden bei echten Konten nicht dadurch historisch bewiesen, dass das Konto heute verifiziert ist.
- `src/trading_order_repository.ts:83`: Tatsächliche Orderresultate werden gegen die erwartete Client-ID validiert und mit `response_json = JSON.stringify(result.raw)` gespeichert. Diese Row ist später aktualisierbar; ihre gegenwärtige ID allein ist kein unabhängiger Originalbeweis.
- `src/trading_recovery.ts:137,238`: Journal-ACKs besitzen eine Arrayform; spätere positive Auflösung speichert `{source:'authoritative_order_snapshot', orders:[...]}`. Ein echter `resolved`-Originalbeleg darf bei historischem Backfill nicht nur wegen seiner Phase ausgeschlossen werden.
- `src/trading_fill_identity.ts`: Geschlossene profilbezogene Schlüssel; native Originalfelder werden gegen die unveränderten normalisierten IDs, den Markt und die Ausführungszeit geprüft. `provenFillIdentity` ist kein Ersatz für die zusätzliche historische lokale Order-/Kontobindung.
- `src/trading_fill_identity_repository.ts` entstand während dieses Reviews beim HL-Agenten. Der erste gelesene Entwurf ist **nicht** pauschal abgenommen; Hinweise zu Bybit, vollständigem Journalvergleich, mehreren Originalen und beiden echten ACK-Formen wurden direkt übergeben.

## Positive Datenbedingungen

Alle Bedingungen müssen gemeinsam vorliegen; ein einzelnes Flag genügt nicht.

1. **Identische alte Row:** Genau die alte lokale `trading_fills.id` wird adressiert. Account/Order/Intent gehören konsistent zusammen. Es existiert noch keine andere Row für denselben vollständig abgeleiteten nativen Schlüssel. Widersprüche werden nicht durch Auswahl einer bequem passenden Row übergangen.
2. **Historische Kontobindung:** Der damalige nichtleere Fill-Fingerprint stimmt mit der ursprünglichen Order-/Operationsbindung und dem heute angesprochenen identischen Konto überein. Ursprüngliche Credentialgeneration bleibt erhalten. Eine andere aktuelle Generation darf nur entlang eines bereits zulässigen identitätserhaltenden Bindungsweges verwendet werden; dieser Review schafft keinen neuen Keywechselvertrag.
3. **Native ursprüngliche Fillbelege:** Gespeicherte Originale binden echte Provider-Fill-ID, Order-ID, vollständigen Markt und erforderliche Zeit. Normalisierte ID/Order/Symbol/Zeit widersprechen ihnen nicht. Ein gleichwertiger bereits gespeicherter Originalbeleg darf theoretisch auch in einem originalen Order-Trade-Envelope liegen; bloß neu eingehende passende Werte ersetzen einen fehlenden alten Identitätsbeweis nicht. Die geprüfte negative Fixture enthält keinen solchen alternativen Originalbeleg.
4. **Ursprüngliche lokale Orderbindung:** Vollständiger Request mit korrektem Hash, Konto/Fingerprint/Generation, logischem Schlüssel und genauem erwarteten Legset. Der relevante Leg stimmt einschließlich Rolle, Seite, Orderart, Reduce-only, Menge, Preis und Trigger mit seinem unveränderten lokalen Original überein. Ein tatsächlich gespeicherter nativer Client-ID-Echo oder eine bereits belegte ursprüngliche Parent-/Batch-/Lookupbindung verbindet ihn mit der echten Remote-ID und dem exakten Providersymbol. Ein `dispatching`-Marker allein beweist keine Annahme; `prepared`/`abandoned` beweist keine Fill-Ownership. `acknowledged`, `unresolved` oder `resolved` können bei zusätzlichem positivem Ergebnisbeleg geeignet sein.
5. **Keine Auswahl trotz Gegenbeleg:** Mehrere einander widersprechende Requests/ACKs dürfen nicht durch `operations.some(valid)` ausgeblendet werden. Mehrere historische Generationen benötigen die eindeutige unveränderliche Bindung an genau die betroffene Operation; Generationen nicht neu nummerieren.
6. **Ökonomische Identität erhalten:** Preis, Ausführungszeit, signierte Gebühr/Asset und normalisierte Menge bleiben exakt. `raw.amount` ist nicht allgemein dieselbe Einheit wie die gespeicherte Basismenge: Der Python-Normalizer multipliziert mit Contractsize. Ein Vergleich benötigt den ursprünglichen Einheiten-/Contractsizebeleg, nicht `Number`-Arithmetik oder heutige Marktparameter. Namespace-Nachtrag ist keine Genehmigung, alte Economics zu reparieren.
7. **Additiver Commit:** In einer kurzen Transaktion nur `provider_symbol`, `remote_fill_key`, `identity_json` und den bewiesenen Identitätsstatus ergänzen. CAS/Originalvergleich und Unique-Index erhalten. Kein Löschen/Wiederanlegen der Fillrow, keine neue lokale Fill-ID, keine Neubuchung alter Fees/PnL. Normale Accounting-Pending-Invalidierung darf stattfinden; alte Event-/Valuation-/Conflict-Originale bleiben erhalten.

## Profilbezogene Herkunft

| Profil | Erforderlicher alter Beleg | Nicht ausreichend |
|---|---|---|
| Bybit | `execId`, `orderId`, nativer `symbol`, `execTime`; eindeutiger ursprünglicher Produktnamespace und vollständiges CCXT-Symbol | `linear:true` allein; Canonical-Symbol; aktuelle Instrumentliste |
| Hyperliquid | `tid`, `oid`, vollständiges ursprüngliches `coin`, `time`; Konto-/Orderbindung; Schlüssel enthält `coin/tid/time` im Accountscope | nackte `tid`; gleichzeitige ähnliche Fills; abgeschnittener DEX-Marktname |
| Kraken Futures | ausdrücklich ursprünglicher `kraken_history_execution_v3`-Beleg mit `executionUid`, `orderUid`, `tradeable`, `accountUid`, Executionzeit und konsistenter Kontobindung | Alias zwischen Recent-Fill-ID und Execution-UID nur aus Menge/Zeit/Preis; nachträglich angeklebter V3-Marker |
| Paper | exakter alter Simulator-Fill samt zugehöriger Simulatororder in derselben temporären/stabilen Paperdatenbank | Verallgemeinerung der Paper-IDs auf echte Provider |

### Präziser CCXT-4.5.75-Nachweis zu Bybit

Gelesene gepinnte Datei: `C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Lib/site-packages/ccxt/async_support/bybit.py`.

- Zeilen 2142, 2161–2164: Nichtoptions-Kontrakte erzeugen `BASE/QUOTE:SETTLE`, bei tatsächlicher Expiry zusätzlich `-YYMMDD`; `option=False` folgt im Marketobjekt. Lineare Contractsize ist dort 1.
- Zeilen 1592/1602/1607 sowie 2310/2323/2326: Optionen erzeugen stets `BASE/QUOTE:SETTLE-expiry-strike-C/P`, besitzen `option=True`, aber ebenfalls `linear=True`, wenn Settlement nicht Base ist.
- `exchange_executor/ccxt_adapter.py:256` übernimmt `linear=True` in Accountingmetadaten, ohne `type`/`option` zu speichern.

Eine **enge** nachträgliche Ableitung für tatsächlich gespeicherte suffixfreie `BASE/QUOTE:SETTLE`-Originale ist daher zusammen mit validem ursprünglichem `ccxt-market-v1`, `linear=true`, übereinstimmendem Settlement, nativen Fillfeldern und vollständigem Journal möglich. Nicht nur nach „enthält Doppelpunkt“ prüfen; Optionen/Expiry-Suffixe und widersprechende ursprüngliche Categoryfelder ausschließen. ProviderMarketId bleibt das native Original und wird niemals aus Base/Quote zusammengebaut. Unbekannte ältere SDK-/Normalisierungsformen bleiben außerhalb dieses belegten Teilfalls.

## Negative Bedingungen / Gategrenze

- Fehlende native Original-ID, alter Konto-Fingerprint null/fremd, fehlende Originaloperation, Hash-/Generation-/Legkonflikt oder zwei nicht eindeutig auflösbare Ursprungskandidaten: keine automatische Bindung.
- Neue frische Filldaten mit passenden Economics allein dürfen diese fehlende Vergangenheit nicht ersetzen. Keine Aliasse aus Timestamp/Preis/Menge; insbesondere keine Kraken-Recent-/History-Vereinigung.
- Ein bereits `conflict` markierter Fill wird nicht durch einen passenden späteren Beleg still `proven`.
- Moneybewertung und Identität bleiben unterschiedliche Tatsachen: Ein Valuation-/FX-Problem wird durch Namespacebindung nicht geheilt und darf keine neue Entryfreigabe erzeugen. Umgekehrt ist ein reines Geldbewertungsproblem kein Anlass, beweisbar eigene risikoreduzierende Stops zu entfernen oder eine echte Orderidentität zu vergessen.
- Ein Read-only-Safety-Gate muss fehlende/defekte Identitätsdaten explizit als Unsicherheit zählen; es darf keine Backfills, Buchungen oder Credentialübernahmen ausführen. Ein gespeichertes `proven`-Label ohne erneuten überprüfbaren Bezug auf seine Originalquellen reicht nicht.

## Zwei lokale Beweisfälle und Ergebnisse

`plans/002-legacy-fill-review-probe.mjs` erzeugt ausschließlich neue temporäre DBs. Es verwendet die produktiven Journal-/ACK-/Moneyfunktionen mit synthetischen lokalen Bybitdaten, aber **keinen Adapter**. Die Fillrow enthält exakt die M39-Originalspalten im M40-Legacyzustand; dies ist kein zweiter selbst erfundener Migrationsablauf.

1. Vollständige native Originale, suffixfreies originales `BTC/USDT:USDT`, passendes ursprüngliches Accounting, real persistierter gehashter Request und `resolved`-Beleg: nativer Originalvalidator positiv, erste geprüfte Persistenz trotzdem `legacy_unresolved`, `resultFillId=null`. Genau eine alte Fillrow/eine Moneyrow; alle Originalbytes unverändert. Das zeigt den fehlenden positiven Anschluss im zuerst geprüften Stand, nicht die Freigabe des inzwischen bearbeiteten Nachfolgecodes.
2. Dieselben Economics/Order-/Geldbelege, aber native Fill-Originalfelder fehlen: nativer Originalvalidator negativ und Persistenz korrekt `legacy_unresolved`. Wiederholte Feeaufnahme unter anderem Transportlabel erzeugt keine zweite Buchung und schreibt das Original nicht um.

Beide Probes: Exit 0. Im abschließenden Nachlauf war der inzwischen vom HL-Agenten integrierte positive Anschluss sichtbar: Fall 1 liefert nun `resultFillId="old-local-fill"`, `identityStatus="proven"`, weiterhin genau eine Fillrow/eine Moneyrow und unveränderte Originalbytes. Fall 2 bleibt korrekt `legacy_unresolved`. Das ist ein gezielter positiver/negativer Integrationsnachweis, keine pauschale Abnahme sämtlicher neuer Repositoryzweige.

Zusätzlich vorhandener `tests/test_trading_fill_identity_migration.js`: Exit 0, tatsächliches M39→40 mit bytegleichen Fill-/Money-/Valuation-/Conflict-/Pendingoriginalen, Wiederöffnung und atomarem Rollback bei mehrdeutiger alter Moneyidentität. Syntaxprüfung der Probe und `git diff --check` ebenfalls grün. Kein Fullsuite gestartet.

Aus Repo-Root mit gepinntem Node 22:

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' --import tsx plans/002-legacy-fill-review-probe.mjs
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' --import tsx tests/test_trading_fill_identity_migration.js
```

## Umsetzungshandoff / Umfang

P1, Confidence HIGH für den gelesenen Stand; begrenzter positiver Backfill einschließlich Tests: Aufwand M, Änderungsrisiko HIGH (Ownership und Geld-Deduplizierung). HL-Agent implementiert die enge Originalvalidierung; Root koordiniert aktuelle Safety-Consumer. Der Bybit-Optionsgegenbeleg und die Originaljournalbedingungen wurden unmittelbar übergeben. Nach Implementierung müssen positive Bindung auf **derselben** alten Fill-ID, negative Optionen/fehlende Originale, Konflikte und Restart geprüft werden; der bestehende Migrationsnachweis ersetzt diese Consumerfälle nicht.

Nicht geprüft/abgenommen: tatsächliche Kundenaltbestände, reale Provider-Retention oder Kontohistorie, Live-Keymigration, neue Provider, vollständige Money-/Cashlegimplementierung, Release. Keine neue unabhängige Planfläche eröffnet und kein vorhandenes Recoverytest-/Sourcefile verändert. Dieses Dokument ergänzt die bereits beauftragten Originalpläne 001/002/005, keine Gesamt-DONE-Erklärung.
