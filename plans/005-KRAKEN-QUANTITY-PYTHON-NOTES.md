# 005: additive Kraken-Normalisierungsbeobachtung — Python-Handoff

Stand: 2026-09-02. Root hat nach vollständiger Lektüre von `005-money-risk-ledger.md` und `005-KRAKEN-QUANTITY-PROVENANCE-PLAN.md` ausschließlich diese Python-Vorarbeit freigegeben. Die ursprüngliche Analyse und ihre Nicht-1-/FX-Grenzen bleiben unverändert. Node-Vertrag, dauerhafte Bindung und Migration 42 werden getrennt von Root implementiert und abgenommen.

## Implementierter Umfang

- `exchange_executor/fill_quantity_provenance.py`: reiner Helper ohne I/O, Providerclient, Uhrzugriff oder Marktlookup. Er beobachtet die bereits verwendeten Decimal-Operanden und das bereits berechnete Ergebnis. Unabhängige Integerkoeffizienten prüfen, ob dieses Ergebnis mathematisch exakt ist; weder Präzision, Rundungsmodus noch Decimal-Flags werden verändert.
- `exchange_executor/ccxt_adapter.py`: ausschließlich Import und enger `_normalized_fill`-Hook. Die vorherige Multiplikation ist in dieselben Eingangs-/Faktor-/Ergebnisvariablen aufgeteilt, nicht neu formuliert. `_contract_size` wird genau einmal für die tatsächliche Rechnung aufgerufen; der Helper liest `contractSize` nicht erneut. Die ausgegebene Quantity, Fee, Accountingmetadata, native Identität und vorhandenes `raw` bleiben unverändert.
- Optionales Sibling `quantityNormalization`, ausschließlich bei vorhandener nativer `kraken_history_execution_v3`-Identität und exakt `contract is True`, `linear is True`, `inverse is False`. Fehlende Flags werden nicht inferiert. Fehlende Identität/Marktmetadaten ergeben keinen Normalisierungsbeleg; sie werden nicht aus einer aktuellen Kontobindung ersetzt.
- `normalizedAt` ist der aktuelle Normalisierungszeitpunkt. `market.observedAt` und `market.providerContractSize` sind immer `null`; `providerOriginalStatus` ist immer `not-retained`. Die Marktquellversion lautet `ccxt-4.5.75-loaded-market`. Das ist keine historische Instrumentversion und keine gegenwärtige oder rückwirkende Cashlegfreigabe.

## Abgestimmter DTO-/Hashvertrag

`quantityNormalization` enthält exakt:

```text
version: 1
source: kraken-execution-normalization-v1
inputField: execution.quantity
inputQuantity: tatsächliche Decimal-Eingangsmenge als Dezimaltext
inputUnit: kraken_native_execution_quantity
appliedFactor: tatsächlich verwendete Decimal-Faktorvariable als Dezimaltext
outputQuantity: bereits vorhandenes Ergebnis als Dezimaltext
outputUnit: base
arithmetic: { operation: multiply, decimalPrecision, decimalRounding, exactProduct }
market: {
  providerMarketId, providerSymbol, base, quote, settlementAsset,
  contract: true, linear: true, inverse: false,
  appliedContractSize, source: ccxt-4.5.75-loaded-market,
  observedAt: null, providerContractSize: null,
  providerOriginalStatus: not-retained, sourceHash
}
nativeIdentity: unveränderte vorhandene ExchangeFillIdentity
originalExecutionHash
normalizedAt
```

Beide Hashes sind SHA-256 über UTF-8 von `domain + '\n' + canonicalJSON(value)`. Domains: `kraken-normalization-original-v1` und `kraken-normalization-market-v1`. JSON-Objektschlüssel werden rekursiv nach Unicode-Codepoints sortiert; keine Whitespaces. Strings behalten ihren Unicodeinhalt; Surrogates werden verworfen. Zahlen sind ausschließlich sichere Integer, keine Float-Rekanonisierung. Null, Boolean, Arrays und JSON-Objekte sind erlaubt. Der Markthash bindet das vollständige obige `market`-Objekt ohne `sourceHash`.

**Wichtige Originalgrenze:** `originalExecutionHash` bindet exakt das bereits vorhandene normalisierte `fill.raw`, nicht das nicht erhaltene vollständige HTTP-/Executionenvelope. Bereits `_execution` kanonisiert mit `common.decimal_string` einen nativen Token `4.000` zu erhaltenem `raw.amount='4'`; die neue Beobachtung erfindet die verlorene Schreibweise nicht. Ebenso parst das gepinnte SDK den synthetischen Instrumenttoken `0.10000000000000001` als angewandten Wert `0.1`; behauptet wird nur dieser tatsächliche Faktor. Weder `market.info` noch `normalizedAt` liefern den fehlenden ursprünglichen Instrumentbeleg.

Der Helper versieht keine freie Caller-Account-ID mit Autorität. Fingerprint, Credentialgeneration, persistierte Fill-ID und Acquisitionbindung müssen vom Node-Ingest anhand der tatsächlichen Originale gebunden werden. Gleiche Quelle/Execution über mehrere Beobachtungen ist keine zweite wirtschaftliche Buchung.

## Dauerhafte lokale Tests und Rotbeleg

`exchange_executor/tests/test_fill_quantity_provenance.py`: vor Sourceänderung tatsächliches Rot im echten `_execution → _normalized_fill`-Pfad: `4 × 0.25 = 1` war korrekt, aber `quantityNormalization` fehlte. Erste permanente Fassung: elf Testmethoden, ein ausdrückliches fehlendes-Feld-FAIL plus elf davon abhängige Subtesterrors. Bestehende negative Kontrollen und Mengen-/Kontextkontrolle waren grün. Nach Umsetzung und Erweiterung: vierzehn fokussierte Methoden grün.

Abgedeckt sind synthetische Faktoren 1/0.25/2.5, Long/Short, fraktionale native Menge, tatsächliche gerundete Multiplikation, ursprüngliche native Identität und Rohdaten, Tokenverlust im bestehenden Parser, gerundeter SDK-Instrumenttoken, kein nachträglicher Faktorlookup, später geänderter Markt ohne Rewrite des ersten Belegs, ungültige Faktoren, fehlende/Boolean-numerisch verwechslungsfähige Marktflags, Account-/Order-/Execution-/Economics-Hashbindung, Unicode-Codepoint-Sortierung, Domaintrennung und Ablehnung unsicherer JSON-Zahlen/Surrogates. Rundungsmodus und Präzision werden aus dem tatsächlich aktiven Kontext erwartet, nicht aus einem global angenommenen Standard. Im Gesamtlauf hatten vorherige SDK-Tests `ROUND_HALF_UP` hinterlassen; die Beobachtung erfasste das korrekt. Nur die anfänglich zu feste neue Test-Erwartung `ROUND_HALF_EVEN` wurde korrigiert, keine Produktionsarithmetik.

`exchange_executor/tests/quantity_provenance_fixture.py` liefert echtes aktuelles Python-Output für den Node-Roundtrip: JSON-Array `{name, fill}` mit sieben Fällen. Aufruf mit gepinntem Python, keine Argumente. SDK-Marktparser und vorhandene History-/Fillnormalisierung laufen wirklich; `fetch` ist vollständig durch einen lokalen Fake ersetzt. Die Fälle verwenden absichtlich dieselbe kontrollierte native Execution-ID für unabhängige Varianten und dürfen nicht gemeinsam als verschiedene Fills desselben Kontos gebucht werden. Der Emitter fixiert nur seinen eigenen lokalen Test-Dezimalkontext (28/ROUND_HALF_EVEN), niemals den Produktionskontext.

## Abnahme / offene Grenzen

Fokussiert: 14/14 grün; Ruff über das vollständige `exchange_executor` grün; `git diff --check` grün. Der vollständige Python-Nachlauf wird nach der genannten Test-Kontextkorrektur separat unten festgehalten. Keine Aussage zum parallelen Node-/M42-Gesamtlauf. Neues Produktionsmodul `exchange_executor/fill_quantity_provenance.py` wurde Root für den Sonar-Quellscope gemeldet; keine Gates oder Schwellwerte wurden geändert.

Nicht implementiert und nicht als erledigt erklärt: neue native Nicht-1-Unitdefinition, positive Nicht-1-Cashlegbewertung, FX-/Preis-/Fee-/Mengenänderung, historische Instrumentgültigkeit, Original-HTTP-/Loaderaufnahme, rückwirkendes Legacy-Backfill, neue Providerreads oder Kontoverbindungen. Cashleg-/Money-/Fundingconsumer bleiben in diesem Teilstück unberührt. Die ausschließlich synthetischen Fakes erteilen keine neue Kraken-Produkt- oder Providerfreigabe.

Finaler eigener Nachlauf: `python -m unittest discover -s exchange_executor/tests` mit Python 3.12.13 / CCXT 4.5.75: **297/297 grün, 37.711 s, Exit 0**. Enthält die vorhandenen History-/Retention-/Originalidentity-/Cashleg-/Deadline-/Kraken-Matrix-/Acceptance-Journal-Tests. Ruff vollständig und Whitespaceprüfung ebenfalls Exit 0. Keine Produktionsänderung nach diesem grünen Gesamtlauf.
