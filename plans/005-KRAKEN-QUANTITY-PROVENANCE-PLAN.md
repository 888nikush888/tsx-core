# 005: Kraken-Fillmenge und tatsächlich angewandter Kontraktfaktor

Ursprünglicher Analysestand: 2026-09-02. Dieser Folgeblock präzisiert ausschließlich `contract_quantity_unit_unproven` aus `005-KRAKEN-CASHLEG-NOTES.md`. Originalplan `005-money-risk-ledger.md` bleibt fachliche Grundlage; die offene FX-/As-of-Politik aus `005-FX-FOLLOWUP-PLAN.md` wird nicht verändert.

**Späterer lokaler Umsetzungsnachlauf:** Root hat die hier beschriebene additive Aufnahme separat freigegeben und mit Migration 42 umgesetzt. Aktueller Nachweis: [Node-/Migrationsintegration](005-KRAKEN-QUANTITY-NODE-NOTES.md) und [Python-Handoff](005-KRAKEN-QUANTITY-PYTHON-NOTES.md). Die folgenden Analyse-/Freigabeformulierungen beschreiben den damaligen Planstand. Die Nicht-1-Cashlegbewertung, historische Instrumentgültigkeit und FX-Policy sind ausdrücklich weiterhin nicht freigegeben oder als gelöst nachgewiesen.

## Ergebnis und verbleibende Beweisgrenze

**Entscheidung:** Mit den tatsächlich geprüften Originalquellen ist **kein positiver Kraken-Nicht-1-Cashlegfall bewiesen**. Der Fall `4 × 0.25 = 1` beweist nur die lokale SDK-/TSX-Normalisierung an einer synthetischen Instrumentsantwort. Der unverändert positive native Kontrollfall hat Faktor 1. Ein gespeicherter SDK-Faktor und eine interne Zustimmung zu einem DTO ersetzen keine fehlende Provider-Einheitenklärung.

**Engster nächster Implementierungsschritt:** ausschließlich die additive Normalisierungsbeobachtung aufnehmen und originalgebunden am kanonischen Fill persistieren, falls Root diese Vorarbeit separat freigibt. Der Nicht-1-Cashlegconsumer bleibt dabei unverändert `unresolved`. Diese Vorarbeit schließt den Informationsverlust, **nicht** die noch offene finanzielle Zulassungsgrenze. Keine neue Quelle, keine neue Marktfreigabe und keine implizite Erweiterung des Produktivauftrags.

Der konkrete Informationsverlust ist reproduziert: Der originale Kraken-Execution-Datensatz liefert eine native Menge. `_normalized_fill` multipliziert sie tatsächlich mit `Decimal(str(market.contractSize))`, bewahrt anschließend aber nur die normalisierte Base-Menge und Accountingmetadata ohne Faktor. Bei `4 × 0.25 = 1` kann der Cashlegconsumer deshalb nicht nachvollziehen, warum originales Positionsdelta `4` und gespeicherte Menge `1` verschieden sind. Die bestehende Einstufung als **unbewiesen statt echter Geldkonflikt** ist für solche Altbelege richtig.

Ein additiver Originalbeleg kann künftig dauerhaft beweisen, **welcher Faktor bei genau dieser Normalisierung angewandt wurde**. Das ist nicht automatisch der Beweis, dass ein später geladenes Marktobjekt die historische Instrumentdefinition zum Ausführungszeitpunkt wiedergibt. Ebenso darf die native Positionslog-Einheit eines hypothetischen Nicht-1-Instruments nicht allein aus dem allgemeinen Wort „Positionsgröße“ als Base-Einheit festgelegt werden.

Die gefundene Quellenlage trägt einen engen Normalisierungsbeleg. Sie trägt **keine neue Markt-/Produktfreigabe**, keinen pauschalen Altfillbackfill und keine automatische Gleichsetzung aller Kraken-Positionslogmengen mit Base-Mengen. Die spätere finanzielle Verwendung benötigt einen zusätzlichen tatsächlichen Unitbeleg, nicht lediglich eine interne Entscheidung zur Umsetzung.

Einordnung: bestätigte bestehende Provenienzlücke, hohe Sicherheit des Code-/Reproduktionsbefunds; mittlerer Umsetzungsaufwand, hohes Risiko einer falschen Geldfreigabe bei vermischten Einheiten. Nicht neu auditiert wurden andere Auditpakete, Tradingstrategien, allgemeine Währungsumrechnung oder Providerfähigkeit. Die additive Umsetzung folgt den bereits bestehenden einseitigen Contract → Repository → Consumer-Schichten; keine zyklischen Ledgerimports und keine Gateausnahme.

## Revisions- und Quellenstand

Repository: `C:/Users/nikla/Desktop/tsx-core`, HEAD `f8089277d0667dd45bcf070037800d423fd89254`, großer gemeinsam bearbeiteter Dirty-Worktree. HEAD allein identifiziert deshalb nicht den geprüften Arbeitsstand. SHA-256 zum Analysezeitpunkt:

| Datei | SHA-256 |
| --- | --- |
| `exchange_executor/ccxt_adapter.py` | `BAAF081F7F125465A7D24216C3528DEF5AB389270B5603ED481AF184650A477A` |
| `exchange_executor/kraken_history.py` | `C96D9A8CC00C8A6D6195573E5A15AAC56EFA72A06E887FFE04A80E93DD55279C` |
| `src/trading_accounting_contract.ts` | `562AACE4FD2A0B69E63B0537F6CF8FF2B6406F82B9842952FFA2A2A01FFA2872` |
| `src/trading_kraken_cashleg_repository.ts` | `D155F3FE7DF36D465B679C8D1F51AE29407B8FD787B5230909E17F36069CF9A0` |
| `src/trading_kraken_cashleg_contract.ts` | `559C6EAFE31ACF581227A3F116A5F3D9527A23FA93F8A564C1A9BE064815C4A1` |
| Installiertes `ccxt/async_support/krakenfutures.py` | `4E8D5E4A2A449F3353F6B60EE66529D0AD11575EC90F9555897913BCCEB14AF6` |

Gepinnt und im Test behauptungsfrei geprüft: **CCXT 4.5.75**, Python 3.12, Node 22.23.2. Die parallele TTL-Arbeit besitzt unter anderem `ccxt_adapter.py`, `ccxt_exchange.ts` und `trading_types.ts`; vor einer späteren Umsetzung erneut koordinieren und diese Hunks erhalten. Keine Produktionsdatei wurde für diese Analyse geändert.

### Aktuelle öffentliche Primärquellen

- [Kraken Instruments](https://docs.kraken.com/api-reference/instrument-details/get-instruments), einschließlich der auf derselben Dokumentationsroute angebotenen `.md`-OpenAPI-Darstellung: `contractSize` ist die Kontraktgröße; `contractValueTradePrecision` dagegen die Handelspräzision. Das dokumentierte PF_XBTUSD-Beispiel hat Faktor **1** und Präzision **4**. Präzision 4 bedeutet nicht Faktor 0.0001. Der Endpunkt beschreibt aktuelle Instrumente, keine historisch gültige Versionsfolge.
- [Kraken Execution Events](https://docs.kraken.com/api-reference/account-history/get-execution-events): native `execution.quantity`, echte Execution-/Order-/Account-UID, Instrument und Ausführungszeit. `orderData.positionSize` ist vorhanden, liefert hier aber weder einen Kontraktfaktor noch eine ausdrücklich dokumentierte Vorher-/Nachher-Zuordnung, die TSX still voraussetzen dürfte.
- [Kraken Accountlog](https://docs.kraken.com/api-reference/account-history/get-account-log) und [Interpretation der Logs](https://support.kraken.com/articles/360057072571-interpreting-the-logs-derivatives): getrennte Positions- und Cashbuchungen; Positionsänderung und neuer Positionsbestand sind keine Geldbeträge. Der gelesene Vertrag benennt bei einem Nicht-1-Instrument nicht ausdrücklich „Base-Menge“ oder den Faktor zum Eventzeitpunkt.
- [Kraken Send Order](https://docs.kraken.com/api-reference/order-management/send-order): die Ordergröße ist instrumentspezifisch; unterschiedliche Futures können unterschiedliche Kontraktgrößen haben. Dies ersetzt keinen Beleg einer konkreten historischen Ausführung.
- [CCXT Manual](https://github.com/ccxt/ccxt/wiki/Manual): allgemeine Normalisierung für Kontraktmärkte mittels Kontraktzahl × Kontraktgröße. Die tatsächliche Version-4.5.75-Krakenimplementierung wurde zusätzlich lokal gelesen und abgefangen getestet; die allgemeine Anleitung allein ist keine Bestätigung einer Kraken-Accountlog-Spezialsemantik.
- [Kraken lineare Kontraktspezifikationen](https://support.kraken.com/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications): Mindestlose und maximale Basepositionen sind eigene Angaben. Ein kleines Mindestlos darf nicht zum Kontraktfaktor umgedeutet werden. Die Recherche identifiziert keinen aktuell gelisteten Nicht-1-PF-Markt als Livebeleg.

Die zusätzliche [Position-Events-Dokumentation](https://docs.kraken.com/api-reference/account-history/get-position-update-events) zeigt korrelierte `executionUid`, `executionSize`, `oldPosition`, `newPosition` und `feeCurrency`. Dieser Endpunkt wird hier **nicht** integriert oder abgefragt; er wäre eine neue, getrennt zu genehmigende Quelle. Optionale Felder und Stringbeispiele sind kein Ersatz für einen geprüften Originalbeleg. Alle Rechercheaufrufe gingen ausschließlich an öffentliche Dokumentationsseiten, nie an Provider-API-/Kontorouten.

## Tatsächlicher Codepfad

1. Gepinntes `krakenfutures.fetch_markets` liest Instruments. Es übernimmt `contractSize` durch `safe_number`, berechnet `precision.amount` separat aus `contractValueTradePrecision` und behält das bereits JSON-geparste Instrument in `market.info`.
2. `AccountClients.load_markets`/`_load_markets` in `exchange_executor/ccxt_client.py` laden und cachen die Marktobjekte. Es existiert derzeit kein pro Originalfill gebundener Marktladereceipt mit Faktor, Originaldezimaltext und Beobachtungszeit.
3. `exchange_executor/kraken_history.py:_execution` kopiert die originale Executionmenge als Dezimalstring in `trade.amount`. Der native UID-/Kontoscope bleibt separat erhalten. `orderData.positionSize` wird derzeit nicht ins normalisierte Raw-Objekt übernommen; eine spätere Ergänzung darf bestehende Raw-Originalbytes nicht rückschreiben.
4. `exchange_executor/ccxt_adapter.py:_normalized_fill` berechnet Base-Menge aus `trade.amount × _contract_size(market)`. `_linear_accounting_metadata` liefert nur Version, Quelle, Symbol, Settlementasset, linear=true und quantityUnit=base.
5. `src/trading_accounting_contract.ts:validateFillAccounting` konstruiert genau diese bekannten Felder neu. Eine bloße zusätzliche Factor-Eigenschaft im vorhandenen Accountingobjekt würde derzeit verworfen. Eine unkoordinierte Versionserweiterung würde außerdem `captureFillAccounting` beim Vergleich alter/neuer `accounting_json` in einen künstlichen Konflikt führen.
6. `src/trading_evidence_repository.ts:persistCorrelatedFill` beweist zuerst native Identität und Orderownership, speichert/reverifiziert den echten Fill und ruft danach `captureFillAccounting` im bestehenden atomaren Vorgang auf. Hier ist der geeignete spätere additive Persistenzpunkt.
7. `expectedEconomics` im Cashlegrepository verlangt aktuell `raw.amount == fill.quantity`. Die separate Positionsprüfung vergleicht das Logdelta mit `fill.quantity`. Nur die erste Prüfung zu entfernen wäre falsch: Auch die zweite müsste eindeutig im nativen Raum arbeiten und ihre Verbindung zur Base-Menge dauerhaft referenzieren.

Vorhandene `TradingLeverageTierDecision.contractSize`-Werte sind Plan-/Sizingbelege, nicht der Nachweis des später in `_normalized_fill` tatsächlich verwendeten Marktobjekts. `trading_risk_contracts.metadata_json` enthält wiederum nur die bisherige Accountingmetadata. Keiner dieser Pfade rechtfertigt einen rückwirkend behaupteten Fillfaktor.

## Echte lokale Proben dieses Analyseblocks

Dateien nur unter `plans/`, absichtlich nicht als fertig implementierte Tests im gemeinsamen Runner registriert:

- `005-kraken-quantity-probe.py`: echter installierter SDK-Aufruf und dessen JSON-Parser; `fetch` vollständig durch lokalen Fake ersetzt. Danach echter TSX-Executionparser und Fillnormalisierer. **Acht Tests: sieben Kontrollen grün, genau eine beabsichtigte rote Regression** wegen fehlendem `quantityNormalization`.
- `005-kraken-quantity-cashleg-probe.js`: neue temporäre Datenbank, vorhandener nativer Ownership-/Fill-/Money-/Cashlegpfad. **Grün**: Faktor-1-Kontrolle bewertet `-0.01 USD`; native Menge 4 mit Base-Menge 1 beziehungsweise 10 bleibt `contract_quantity_unit_unproven`, ohne Geldkonflikt. Originalfill/-Accounting/-Moneyevent, Neustart und Foreign Keys bleiben erhalten. Die Testdatenbank wird nach Prüfung entfernt.

Nachgewiesene SDK-/Normalisierungssollwerte:

| Nativer Input | Angewandter Faktor | Normalisierter Output | Nachweis |
| --- | --- | --- | --- |
| 4 | 1 | 4 | positive Kontrolle |
| 4 | 0.25 | 1 | positive Arithmetikkontrolle; fehlender Metadatenbeleg rot |
| 4 | 2.5 | 10 | positive Short-Kontrolle |
| 0.2 | 0.25 | 0.05 | positive fraktionale Short-Kontrolle |
| 4 | null, 0, -1, NaN oder Infinity | keine zulässige Normalisierung | Ablehnung, kein Faktor-1-Default |

Weitere **wirklich ausgeführte** Kontrollen zeigen zwei unmittelbar relevante Beleggrenzen:

- Dasselbe Original unter einem später geänderten Marktobjekt liefert Menge 1 beziehungsweise 2, obwohl die vorhandene Accountingmetadata gleich bleibt. Deshalb ist ein späterer Marktread kein ursprünglicher Rechenbeleg.
- Originaler JSON-Zahlentext `0.10000000000000001` wird durch den tatsächlichen SDK-Parser zu `0.1`. Das ist der real angewandte Wert, aber nicht derselbe exakte Providerdezimaltext. Beide Aussagen müssen getrennt gespeichert werden; der spätere Beleg darf die Rechnung nicht heimlich auf den präziseren Wert umstellen.
- Die Multiplikation verwendet momentan den laufenden Python-Decimal-Kontext. Bei Präzision 28 kann eine hinreichend lange, gültige Eingabemenge gerundet werden. Der konkrete Probeinput `12345678901234567890.12345679` × `0.25` zeigt dies. Ein Beleg darf eine tatsächlich gerundete Rechnung nicht als exakte Gleichheit deklarieren. Dieser Auftrag ändert weder Mengen noch Rundungsregeln.

Reproduktion in PowerShell aus dem Repository:

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/ccxt-py312/Scripts/python.exe' plans/005-kraken-quantity-probe.py
# Erwartet: Exit 1, genau ein fehlender-Provenienz-Test rot; sieben Kontrollen grün.

& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' --import tsx plans/005-kraken-quantity-cashleg-probe.js
# Erwartet: Exit 0; ausschließlich neue lokale temporäre DB.
```

Die synthetischen Nicht-1-Instrumentsantworten sind bewusst keine Behauptung, Kraken biete genau diesen Markt mit diesem Faktor an. Die isolierte Rundungskontrolle verwendete zunächst einen Wert mit abschließender exakter Null; das war kein Rundungsverlust und die Testannahme wurde korrigiert. Der oben ausgewiesene Endlauf enthält nur das beabsichtigte Provenienz-Rot.

## Vorschlag: additive, originalgebundene Normalisierungsbeobachtung

Noch nicht freigegebene API-Skizze, **kein bereits bestehender Vertrag**:

```ts
ExchangeFill.quantityNormalization?: {
  version: 1;
  source: 'kraken-execution-normalization-v1';
  inputField: 'execution.quantity';
  inputQuantity: string;
  inputUnit: 'kraken_native_execution_quantity';
  appliedFactor: string;
  outputQuantity: string;
  outputUnit: 'base';
  arithmetic: {
    operation: 'multiply';
    decimalPrecision: number;
    decimalRounding: string;
    exactProduct: boolean;
  };
  market: {
    providerMarketId: string;
    providerSymbol: string;
    base: string;
    quote: string;
    settlementAsset: string;
    contract: true;
    linear: true;
    inverse: false;
    appliedContractSize: string;
    source: 'ccxt-4.5.75-loaded-market';
    sourceHash: string;
    observedAt: number | null;
    providerContractSize: string | null;
    providerOriginalStatus: 'exact-token-bound' | 'not-retained';
  };
  nativeIdentity: /* unveränderte bestehende ExchangeFillIdentity */;
  originalExecutionHash: string;
  normalizedAt: number;
}
```

Verbindliche Semantik für einen späteren Auftrag:

- Faktor **aus derselben lokalen Variable** nehmen, die die vorhandene Multiplikation tatsächlich ausführt. Kein Quotient `output/input`, keine Precision-/Mindestlosableitung, kein zweiter Marktread und kein geratenes `1`. Die Beobachtung wird bei der Rechnung erzeugt, nicht beim späteren Cashlegvergleich.
- `inputUnit` bleibt zunächst der spezifische native Quellenraum, nicht pauschal „Base“ oder „Kontrakte eines beliebigen Providers“. Die Ausgabe bezeichnet die tatsächlich vom bestehenden linearen TSX-Adapter verwendete Base-Normalisierung. Dies darf weder Inverse-/Options-/Spotprodukte noch neue Märkte zulassen.
- Exakte Dezimalvalidierung; Ausgabe muss der beobachteten ursprünglichen `fill.quantity` entsprechen. Die genaue Multiplikation unabhängig mit ausreichend großen Integerkoeffizienten oder ausreichend begrenzter Präzision gegenprüfen. `exactProduct=false` bleibt als Rechenbeobachtung aufbewahrbar, aber nicht als positive exakte Unitfreigabe verwendbar. Keine Epsilonvergleiche und keine Reparatur der Originalmenge.
- SDK-Version, konkrete native Marktidentität, Base-/Quote-/Settlementattribute und Hash der tatsächlich konsumierten erlaubten Marktmetadaten binden. Generischer Symbolsuffix oder die aktuelle Spot-/Perp-Bezeichnung genügen nicht. Der Hash beweist Integrität des gespeicherten Beobachtungsobjekts, nicht von allein historische Providerfinalität.
- `observedAt=null` darf fehlende damalige Marktbeobachtungszeit ehrlich kennzeichnen. `normalizedAt` ist nicht `filledAt`. Kein rückwirkendes Frischefenster, keine zehnsekündige FX-As-of-Ausnahme und keine erfundene historische Gültigkeit.
- Exakter ursprünglicher Providerfaktor ist nur mit zum verwendeten Instrument gebundenem Original-JSON-Token/Receipt behauptbar. `market.info.contractSize` allein kann bereits durch JSON-Float-Konversion verändert sein. Optionale spätere Originalaufnahme muss beim vorhandenen Instruments-Laden erfolgen, ohne neuen Read; dafür ist ein gesondert freizugebender schmaler Loader-/Transporthunk nötig. Vorher `providerOriginalStatus='not-retained'`.
- Account-Fingerprint, Credentialgeneration und aktueller Read-/Acquisitionscope werden am vertrauenswürdigen Ingest gegen das angeforderte Konto gebunden, nicht aus beliebigen Callerfeldern akzeptiert. Native UID/Markt/Execution/Order und Originalhash müssen dem bereits bewiesenen persistierten Fill entsprechen. M40-IDs, Originale und Ownershipmechanik werden unverändert wiederverwendet.

### Dauerhafte Ablage und Altbestand

Vorgeschlagene neue immutable Evidence-Relation mit FK auf **den tatsächlichen `trading_fills.id`**, nicht auf nackte Provider-Fill-ID. Beispielname `trading_fill_quantity_evidence`; **keine Migrationnummer vergeben oder reserviert**. Finaler Tabellen-/APIvertrag und freie Nummer brauchen Root-Freigabe.

Sie speichert getrennt:

1. kanonische Fill-ID, Konto/Fingerprint, native Identität und exakte Hashreferenzen auf vorhandene Originale;
2. die beobachtete Rechnung, Marktprovenienz, Ereignis- und Beobachtungszeiten;
3. Herkunftsgeneration und ursprünglichen Readbezug; mehrere identische Beobachtungen dürfen keine zweite wirtschaftliche Buchung erzeugen;
4. eventuell widersprüchliche Nachbeobachtungen als eigene erhaltene Beweise, nicht durch Überschreiben des ersten Belegs.

Ein vorgeschlagener `captureFillQuantityEvidence(account, fill, fillId, acquisitionBinding)` wird im bestehenden korrelierten Fill-Transaktionspfad **nach** Ownership-/Nativeidentityprüfung aufgerufen. Alle Aussagen werden mit den Originalzeilen selbst verglichen. Keine Änderung an `raw_json`, `accounting_json`, `quantity`, M40-Identitäten, Moneyoriginalen oder bestehenden Valuations.

Identische Originale über zulässig neu gebundene Credentialgenerationen erzeugen bei identischem Account-Fingerprint/Provider-UID keinen künstlichen Geldkonflikt. Jede Beobachtung behält aber ihre tatsächliche Generation. Eine neue Kontobindung wird nicht erfunden. Abweichende Faktoren allein ohne passenden Originalzeit-/Marktbezug beweisen noch keine Geldkontradiktion; eine tatsächlich anders normalisierte eigene Ausführung bleibt im bestehenden Konfliktpfad sichtbar.

Altbestand ohne ursprünglichen Normalisierungsbeleg bleibt `contract_quantity_unit_unproven`. Ein später identisches Original kann eine **neue** Rechenbeobachtung erhalten, beweist jedoch nicht automatisch die alte Berechnung oder historische Marktgültigkeit. Rückwirkendes Auflösen wäre nur mit tatsächlich vorhandenem ursprünglichem, identitätsgebundenem Nachweis erlaubt. Weder aktuelle Tiers noch ein rechnerisch passender Quotient sind dieser Nachweis.

Retention muss Evidence-FKs und zugehörige Fill-/Originalbelege erhalten; keine RESTRICT-Lockerung. Backup-/Restore und echte Vorversionsmigrationen benötigen eigene Tests. Schemaänderung und neue Testregistrierung erst nach abgestimmter Umsetzung.

## Bedingter späterer Cashleg-Consumerhunk — derzeit nicht implementierbar freigegeben

Erst nach einem zusätzlichen tatsächlich quellenbasiert nachgewiesenen nativen Einheitenbeleg liest der Consumer die Normalisierungsbeobachtung selbst über die kanonische Fill-ID. Dieser zusätzliche Unitbeleg liegt nach dieser Analyse noch nicht vor. `valueKrakenCashlegFee` bliebe bei `{eventId, cashOccurrence, positionOccurrence}`; der Caller dürfte keinen Faktor oder freie Einheit beisteuern.

Die Prüfungen werden getrennt:

```text
nativeQuantity = originales execution.quantity
nativePositionDelta = originales Positions-new_balance - old_balance
nativePositionDelta == Vorzeichen(side) × nativeQuantity
gespeicherte Base-Menge == nativeQuantity × tatsächlich angewandter Faktor
```

Die erste Gleichheit muss im **nachgewiesenen gleichen nativen Einheitenraum** gelten. Sie ist nicht durch den zweiten Rechenschritt allein bewiesen. Die vorliegenden Quellen beschreiben Positionsänderung/Positionsgröße, aber geben keine ausdrückliche Nicht-1-Unitdefinition oder historische Faktorversion. Deshalb muss vor einer positiven Nicht-1-Cashlegfreigabe eine eindeutige primäre Unitdefinition oder eine tatsächlich korrelierte, semantisch eindeutig dokumentierte Originalquelle vorliegen. Weder eine numerische Gleichheit synthetischer Zeilen noch eine interne Vertragsannahme reicht aus. Dies ist eine konkrete Zulassungsgrenze, keine Aufforderung zu einem neuen Historyloop.

Keine alternative Fallbackregel „Logdelta passt zufällig zu raw **oder** normalisiert“; keine Wahl des passenden Faktors nach Ergebnis. Bei unklarer Unit weiterhin konkretes unresolved. Cashasset, Cashzerlegung, Originalfee, PnL, vorhandene Money-ID, native USD-/identischeAsset-Regeln und Fundingdedupe bleiben vollständig unverändert. Eine positive Feeprüfung bucht weder PnL noch Funding erneut.

## Vorgesehene Dateien und Abnahme

Erst nach neuer Umsetzungsfreigabe:

- `exchange_executor/ccxt_adapter.py` plus optional neues reines `fill_quantity_provenance.py`: eng an der tatsächlichen Rechnung; TTL-/Identity-Hunks erhalten. Optionaler Loaderoriginalhunk in `ccxt_client.py` nur nach gesonderter Abstimmung.
- `src/trading_types.ts`, `src/exchange_contract_validation.ts`, neue reine Contractdatei und eigene Evidence-Repositorydatei: additive Sibling-DTO, vollständiger Roundtrip und strenge Herkunftsbindung. Vorhandenes Accounting-v1-JSON nicht erweitern/umschreiben.
- `src/trading_evidence_repository.ts`: schmaler atomarer Persistenzhook; keine neue Korrelation oder Fill-ID.
- `src/db.ts`: ausschließlich eine vorher reservierte additive Migration plus RequiredTables/Retentionabhängigkeiten, keine Änderung an M40/M41 oder DB-Lifecycle.
- `src/trading_kraken_cashleg_repository.ts` und `src/trading_kraken_cashleg_contract.ts`: **nicht Teil der derzeit vorgeschlagenen reinen Aufnahmevorarbeit**. Erst nach zusätzlichem tatsächlichem Unitquellennachweis wäre native Menge von normalisierter Menge zu trennen und Evidence selbst zu laden.
- Eigene neue Python-/Node-Vertrags-, Roundtrip-, Replay- und Migrationstests; Einträge im gemeinsamen Runner nach Grünphase. Neue Produktionsmodule dem Sonar-/Architekturgate melden; keine Schwelle ändern.

Verbindliche rote Tests vor Produktivhunks und spätere Grünabnahme:

1. Bereits vorhandene fehlende-Metadata-Rotprobe in echte Tests überführen; 1, 0.25, 2.5, fraktionale Mengen, Long/Short/Teilfill und genaue Dezimalwerte prüfen.
2. DTO-Roundtrip erhält alle erlaubten Beweisfelder; Null/Boolean/exponentielle/negative/überlange Faktoren, falsches Input-/Output-/Markt-/Originalhash-/Account-/UID-/Generationsbinding ablehnen. Aktuelle Marktpräzision ersetzt niemals Faktor.
3. Exakter Providerdezimaltext versus bereits gerundeter SDK-Wert; tatsächliche Decimal-Rundung versus exaktes Produkt bleiben getrennte Status. Keine stille Mengenänderung.
4. Erster Originalfill, identischer Replay, Crosspage und Neustart erzeugen eine konsistente eigene Evidencebeziehung; alte Originalbytes und M40-/Money-IDs bleiben bytegleich. Kein Altbestand aus einem Quotienten „reparieren“.
5. Wirtschaftlich identische Wiederbeobachtung über unabhängig validierte Generationen ist kein Konflikt. Wirklich andere native Identität/Quelle oder widersprüchliche Wirtschaftsdaten bleiben erhalten und invalidieren positive Verbraucherbeweise angemessen.
6. Native Nicht-1-Cashlegpaarung erst nach tatsächlichem zusätzlichem Unitquellennachweis positiv; bis dahin wie heute unresolved. Ein späterer positiver Test muss den dann nachgewiesenen Originalvertrag abbilden, nicht nur einen Wunschfall. Exakt eine Fee, vorhandener Teil-PnL/Funding unverändert. Falsches native Delta, Base-/Contract-Verwechslung und bewusst passender Zufallsquotient negativ.
7. Atomarer Ingestabbruch, Evidence-FK, Immutable-Regeln, Retention, Backup/Restore und tatsächliches Altversionsupgrade. Keine separat fortgeschriebene Coverage bei verworfenem Originalbeleg.
8. Bestehende M40/M41-, Cashleg-, FillAccounting-, Risk-/Funding-, Accountlogbudget-/Fairness- und TTL-Tests grün; kein zusätzlicher Providerread oder Netzawait unter DB-Lock.

Empfohlene Reihenfolge: (1) nach separater Root-Freigabe Normalisierungsbeobachtung und positive/negative Python-/DTO-Verträge, (2) separat freigegebene additive Migration samt Originalerhaltung/Replay. **Danach endet die hier konkret vorgeschlagene Vorarbeit.** (3) Ein Cashlegconsumerhunk setzt einen erst noch zu erbringenden nativen Unitquellennachweis und einen neuen Auftrag voraus. (4) Gemeinsame Abnahme ohne Behauptung, die Nicht-1-Bewertung sei schon gelöst. Nach jeder Stufe relevante neue Tests ausführen; Produktions-/Schemaänderungen beginnen nicht allein durch das Vorliegen dieses Plans.

Bestehende fokussierte Integrationsgates nach Umsetzung, jeweils Exit 0 erwartet:

```powershell
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' tests/run_all.js test_trading_kraken_cashlegs.js test_trading_kraken_cashleg_failures.js test_trading_kraken_cashleg_replay.js test_trading_kraken_cashleg_migration.js test_trading_fill_accounting.js test_trading_fill_identity_migration.js test_trading_money_ledger.js test_trading_account_log.js test_trading_funding_risk.js
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' node_modules/typescript/bin/tsc --noEmit
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' scripts/check_architecture.js
& 'C:/Users/nikla/AppData/Local/tsx-core-dev-runtime/node-v22.23.2/node.exe' scripts/check_complexity_budget.js
git diff --check
```

Neue Tests zunächst isoliert rot zeigen, anschließend unter genehmigten `tests/`-/`exchange_executor/tests/`-Namen implementieren und nach Grünphase vollständig registrieren. Die heutigen Analyseproben bleiben als historische Reproduktion gekennzeichnet; nicht als neue Release-Ausnahme behandeln. Der vollständige JS-/Python-/Release-Nachlauf gehört Root. Wartung: SDK-/Providerprofilwechsel, neue native Fillquellen und geänderte Markt-Metadatenpfade müssen die Originalbelegversion und ihre Negativfälle erneut prüfen; niemals still eine alte Belegversion umdeuten.

**Stop-Bedingung:** Fehlende Schemafreigabe, ungeklärter nativer Nicht-1-Einheitenraum oder fehlender ursprünglicher Altbeleg wird konkret berichtet. Nicht-1-Märkte werden nicht allein deshalb freigegeben, weil der neue Metadatenparser synthetische Fakes akzeptiert. Der abgeschlossene Analyseblock lässt Produktionsflags, Mengen, Geldbeträge, Schema und offene FX-Politik unverändert.
