# 005/009 – Kraken Flex-Reporting: kleinster sicherer Anschluss

Stand: 2026-09-03, HEAD `f8089277d0667dd45bcf070037800d423fd89254` plus laufender Arbeitsstand. Reiner Quellen-/Code-Nachlauf; **keine Produktionsimplementierung, Schemaänderung, Provider-/Konten-/Serververbindung oder Freigabe**. Gelesen: Originalplan 005, Funding-/Cashleg-Notizen und aktuelle Balance-, SDK-, Accounting-, Ledger- und Riskpfade. Alte offene Notizformulierungen wurden nicht als heutige Implementierungslücken vorausgesetzt.

## Ergebnis

Native USD-Berichtsgrößen für das **Flex-/Multi-M-Wallet** sind inzwischen klar dokumentiert. Sie sind weder die Summe vereinheitlichter Coinbestände noch eine USD/USDT/USDC-Paritätsannahme. Ein kleiner requestlokaler Originaltext-Capture plus reiner Flex-Parser ist möglich. Für eine vollständige positive Entryintegration müssen zusätzlich Walletscope und aktuelles Fundingaccrual durch den bestehenden Node-Accounting-/Riskvertrag geführt werden. Nur einen weiteren Zweig in `reporting_balance` einzubauen wäre unvollständig.

## Primärquellen und exakte Zuordnung

[Get wallets](https://docs.kraken.com/api-reference/account-information/get-wallets.md), vollständig über öffentlichen Dokumentabruf gelesen am 2026-09-03, beschreibt `GET /derivatives/api/v3/accounts`. Die Antwort enthält `cash`, `flex` und weitere benannte Margin-Accounts. `flex.type` ist `multiCollateralMarginAccount`; Coinmengen, deren USD-Werte und verfügbare Coinmengen sind unterschiedliche Felder. Die Zuordnung ist:

| Original `accounts.flex` | Ziel / Bedeutung |
| --- | --- |
| `portfolioValue` | `equity`: USD-Portfoliowert unverändert |
| `availableMargin` | `availableBalance`: verfügbare USD-Margin, keine Coinmenge |
| `initialMarginWithOrders` | `marginUsed`: gebundene USD-Margin einschließlich offener Orders |
| `initialMargin` | Separat erhaltene Positionsmargin, nicht Ersatz für die vorige Zeile |
| `pnl` | `unrealizedPnl`, ausschließlich aktueller USD-Preis-PnL |
| `unrealizedFunding` | Separates aktuelles USD-Fundingaccrual, kein Tages-Cashflow |
| `totalUnrealized` | Preis-PnL plus Fundingaccrual; kein `price_only`-Feld |
| `currencies[asset].quantity/value/available` | Coinmenge / USD-Wert / verfügbare Coinmenge; nicht austauschbar |

`balanceValue`, `collateralValue`, `marginEquity` und `totalUnrealizedAsMargin` ebenfalls als unterschiedliche Originalgrößen behalten, nicht selbst aus angenommenen Haircuts oder FX-Kursen berechnen. Dokumenttext-SHA-256 (UTF-8): `1c50b024bb0d6b05ebefe9c655afcbec8bed0ff17047dc6b5c3e54f390b13cad`.

[Portfolio Management](https://support.kraken.com/articles/4871775312276-portfolio-management-derivatives), aktualisiert 2026-02-26, präzisiert: Portfolio-Wert wird pro Margin-Wallet berechnet und enthält auch laufendes Funding. Multi-M ist ein Omnibus-Wallet, während Holding-Cash kein aktives Tradingcollateral ist und Coin-M-Wallets getrennt sind. Somit weder Cash zuschlagen noch aktuelle Fundingbeträge nochmals zur Equity addieren.

[Linear Multi-Collateral Contract Specifications](https://support.kraken.com/in/articles/4844359082772-linear-multi-collateral-derivatives-contract-specifications) und [Profit/Loss calculations](https://support.kraken.com/articles/360022835511-calculation-of-profit-and-loss-derivatives?mode=consumerapp), abgerufen 2026-09-03: Multi-M-Preis-PnL wird in USD berechnet; tatsächliche Gewinnauszahlung kann eine andere gewählte Collateralwährung benutzen. Funding akkumuliert während der Stunde und wird am Stundenende bzw. bei Netto-Positionsänderung realisiert. Daher beweist ein aktueller USD-Summary weder die Währung jeder alten Gebühr noch einen historischen Ereigniskurs. Bestehende Cashleg-/Konversions-/Kfee-Grenzen bleiben bestehen.

## Lokaler Iststand und echte Gegenproben

Gepinnter SDK: CCXT **4.5.75**, Datei `ccxt/async_support/krakenfutures.py`, SHA-256 `4e8d5e4a2a449f3353f6b60ee66529d0ad11575ec90f9555897913bcceb14af6`.

- `fetch_balance:2469` ruft `privateGetAccounts` auf. Ohne Typ/Symbol wird nur die vereinheitlichte Balance aus Flex gebildet; `balance.info` enthält weiterhin die **gesamte** Accounts-Antwort. `parse_balance:2597` benutzt bei Flex `quantity`/`available`, nicht `portfolioValue`/`availableMargin`.
- `exchange_executor/accounting_evidence.py:77` besitzt aktuell keinen Kraken-Zweig. `verify:398` und `account_snapshot:461` in `ccxt_adapter.py` verwenden diese Funktion; der Snapshot liest Balance und Positionen per `asyncio.gather`.
- `account_log_sources._exact_kraken_response:103` ist kein geeigneter Copy-and-paste-Balance-Capture: Er benutzt das gemeinsame `last_http_response` und Vergleich nach normalem JSON-Parsing. Der Historylock im Open-State-Pfad schützt nicht alle parallelen Balance-/Positionsreads.
- CCXT `async_support/base/exchange.py:265` ruft synchron `on_rest_response(...)`, dann `parse_json(...)`, dann aktualisiert es `last_http_response`. `base/exchange.py:547/706` bietet den unveränderten Hook/Parser. Der bestehende lokale Mixin-Einstieg ist `exchange_executor/ccxt_sdk_policy.client_class`.

Drei in-memory Probegruppen tatsächlich ausgeführt, Exit 0; echter gepinnter SDK mit abgefangenem `privateGetAccounts`, `fetch` wirft bei jedem Netzwerkversuch:

1. Flex enthält `USDT.quantity=1`, `value=1.0001`: der SDK liefert `total.USDT=1`, nicht den USD-Wert. `info` enthält zugleich Cash und Flex. JSON-Zahl `portfolioValue=100.000000000000000001` wird bereits `100.0`. Der heutige Reportingzweig weist Kraken erwartungsgemäß zurück.
2. Zwei Antworttexte mit `portfolioValue=100.000000000000000001` bzw. `...002` sind nach Standard-Floatparsing gleich. `_exact_kraken_response(last_http_response=B, response=A)` übernimmt tatsächlich den falschen exakten B-Token. Daher ist Floatobjektgleichheit allein kein Originalbindungsbeweis.
3. Ein kontrolliert nach dem Balance-Read abgeschlossener Positionsread überschreibt `last_http_response`. Der alte Helper fällt auf bereits gerundete Balancefloats zurück. Rein sequenzielles Lesen in **einer** Funktion schützt nicht vor anderen Tasks desselben Clients.

Bestehende `test_accounting_evidence.py`: **10 Tests grün, 0,102 Sekunden**, Python 3.12. Diese Nachweise charakterisieren die Lücke; sie sind keine bereits grüne Implementierung eines Kraken-Reportingvertrags.

## Minimaler Python-Vertrag nach gesonderter Freigabe

1. Neues kleines `exchange_executor/kraken_reporting.py`; schmaler Kraken-Mixin-Hook in `ccxt_sdk_policy.py`. Kein SDK-Patch, neues SDK, zweiter HTTP-Read, globales Parseroverride oder WS-Modell. Ein Helper `read_kraken_reporting_balance(clients, deadline)` setzt **innerhalb seines eigenen Balance-Tasks** einen ContextVar-Capture, bevor er einmal `fetch_balance` aufruft. Nicht außerhalb von `gather` setzen, damit Geschwistertasks den Capture nicht erben.
2. Capture bindet gehaltene Clientinstanz, aktuelle interne Credentialgeneration/Accountidentität, Modus, Profilhash, eindeutigen lokalen Request und Owner-Task. Nur HTTP-Erfolg für exakt den konfigurierten Kraken-Host und `GET /derivatives/api/v3/accounts` akzeptieren. Requestheaders/Authent/Secrets nicht speichern. Hook lässt SDK-Rückgabe und Standardparser unverändert. Originaltext/Empfangsintervall werden synchron vor Weiterverarbeitung aufgenommen; fehlender, mehrfacher oder nicht passender Capture ist unbewiesen. Abbruch/Cancellation setzt ContextVar und aktive Besitzmarke im `finally` zurück; kein später geerbter Task darf ihn weiterverwenden.
3. Der Helper prüft nach Rückkehr Client-/Credentialbindung erneut. Erstverifikation verwendet die aus dem gehaltenen Client abgeleitete Bindung, nicht eine vom unverifizierten Caller erfundene Fingerprint-/UID-Angabe. Die Walletantwort enthält keine Account-UID: keine synthetische Provider-UID ergänzen.
4. Reparse ausschließlich des requestgebundenen Originaltexts mit exakten Dezimal-Zahlentokens. JSON-Duplikatschlüssel, NaN/Infinity, bools als Zahlen, ungültiges UTF-8/Ersatzzeichen, übergroße Sammlung/Antwort und unzulässige Zahlenlängen ablehnen. Integer bleiben exakt; Dezimal-/Exponenttoken werden ohne Float und ohne Rundung in kanonische Strings umgesetzt. Die vollständigen Originallexeme bleiben im gebundenen Text erhalten. Die bestehenden 36/18-Ausgabegrenzen gelten; darüber nicht runden oder zu null Geld machen. Bereits vorhandene Floatobjekte allein genügen nie.
5. Reiner Parser verlangt `result=success`, gültiges `serverTime`, vollständige Flex-Pflichtfelder/Typen und getrennte Walletstruktur. Quelle `kraken-futures-accounts-flex-v1`, Reporting USD. Negative echte Equity/Available nicht auf erfundene positive/Nullwerte ändern: Rohbeleg behalten, Entryvertrag explizit sperren, wenn bestehende nichtnegative Scalar-DTOs sie nicht darstellen können.
6. `verify` und `account_snapshot` benutzen denselben Helper. Die Positionsabfrage kann parallel bleiben. Reportingzeit wird an den Balance-Capture gebunden, nicht nach einem langsameren Positionsread neu gestempelt. Alle Felder, `responseHash`, Walletscope, Konto-/Generation-/Profilbindung und Readzeiten bleiben durch die Boundary erhalten. Keine Frische oder Eventzeitbewertung aus einem nachträglich berechneten Hash allein ableiten.

Native Summarywerte direkt übernehmen; keine Neuschätzung von Margin/Equity. Konsistenzprüfungen der originalen Preis-/Fundingzerlegung benötigen exakte Arithmetik; bei widersprüchlichen Originalen keine Epsilon-Toleranz erfinden. Falls die reale API unabhängig gerundete Aggregate liefert, diese Grenze zunächst belegen statt ungefragt Rundungsspielraum einzubauen.

## Zwingende Node-Schnittstellen, nicht durch den Parser erledigt

### Walletscope

`TradingAccount` repräsentiert bislang ein Accountbinding, keinen frei wählbaren Multiwallet-Portfolioverbund. `trading_account_log_money.krakenFunding` und `trading_funding_observation.observedProof` summieren accountweit. Eine neue Flexquelle darf diese Summe deshalb nicht ungeprüft mit Flex-Equity kombinieren.

Enger erster positiver Slice: tatsächlich unterstützter PF-/Flex-Handel; vollständiger aktueller Orders-/Positionsscope schließt andere aktive Wallet-/Produktverpflichtungen aus. Alle in der relevanten Tages-/Risikorechnung benutzten Geldbelege müssen anhand vorhandener Originale zum Flex-Wallet gehören. `margin_account` aus den Accountlogreceipts und native Fill-/Marktbelege bleiben dafür erhalten; fehlende Walletzuordnung wird nicht geraten. Nicht-Flex-Geldbelege weder löschen noch umetikettieren. Ein gleicher USD-Betrag ist kein Walletbeweis. Unbewiesene oder andere Walletverpflichtungen bleiben für diesen Slice konkret unresolved.

Nichtnull Holding-Cash ist zulässig als separat ausgewiesener, nicht marginwirksamer Bestand; er erhöht Flex-Equity nicht. Auch nicht aktive fremde Margin-Walletbestände werden nicht zugeschlagen. Ein echter Gesamtvermögensreport über alle Wallets wäre ein eigener Einheiten-/Portfoliovertrag, nicht dieser kleine Anschluss. Die vorhandene Ledger-Berichtsbindung muss den versionierten Flexquellscope tragen. Collateral-Assets, berechnete USD-Reportingeinheit und reale Auszahlungs-/Fee-Assets sind verschiedene Metadaten; nicht bloß dynamische `currencies.keys()` als Settlementvertrag speichern.

### Preis-PnL versus aktuelles Funding

Vorgeschlagene additive Größe: `currentFundingAccrual` mit signiertem USD-Betrag, Walletscope, Semantik `unrealized_excludes_realized`, denselben Original-/Readbindungen und explizitem Status. `unrealizedPnl` bleibt Preis-PnL; `fundingPnlToday` bleibt ausschließlich bereits belegtes realisiertes Tagesfunding. Accrual wird **nicht** als neues Ledgerereignis pro Snapshot gebucht und nicht nochmals zur bereits inklusiven Equity addiert.

Für vollständiges 005-Risiko: `dayPnl = ledgerRealizedPriceFeesFundingToday + priceUPL + currentFundingAccrual`. Ein gemeinsamer geprüfter Helper muss diese Größe in Admission, finalem Recheck und Post-Protection-Reconcile verwenden. Heute benutzen `trading_money_risk.calculateMonetaryDailyRisk`, `trading_risk_admission` und `trading_risk_reconciliation` nur Ledger plus `snapshot.unrealizedPnl`. Ein Mapping auf `totalUnrealized` mit behauptetem `price_only` wäre falsch; Nichtnull-Accrual still zu ignorieren ebenfalls.

Stunden-/Positionswechsel brauchen einen expliziten Übergangstest: Accrual fällt weg, derselbe Betrag erscheint genau einmal als realisierter Cashflow. Wallet-Snapshot und verzögert gelieferte History sind nicht atomar. Neuer Snapshot, Ledgerrevision und bekannte Realisierungsgrenzen müssen zusammenpassen; bei bekanntem Reset ohne passenden finanziellen Nachweis kein scheinbar vollständiger Tageswert. Bestehendes `provider_as_observed` bleibt als solche Beobachtung gekennzeichnet, keine erfundene Historyfinalität. Schutz/Exit weiterführen, nur Entry und dessen finanzielle Freigabe sperren. Keine zusätzlichen Historycalls oder zweiter Fünferpool.

## Eng begrenzte Umsetzung / verbindliche Rotfälle

Erste Quellenstufe: neues Pythonmodul, `ccxt_sdk_policy.py`, `accounting_evidence.py`, ausschließlich Verify-/Snapshot-Hunks in `ccxt_adapter.py`; neue `test_kraken_reporting.py`. Zweite, separat abzustimmende Boundary-/Riskstufe: `trading_types.ts`, `exchange_contract_validation.ts`, `trading_accounting_contract.ts`, `ccxt_exchange.ts`, gemeinsame Accrualberechnung und die oben genannten Riskconsumer; Quellen-/Walletprüfung neben bestehender Kraken-Moneyprojektion. Keine Sourceänderung ist durch diese Notiz freigegeben. Für Capture/Scalartransport ist keine DB-Migration erforderlich; dauerhafte zusätzliche immutable Walletbelege vorab abstimmen. `trading_risk_current.balance_json` allein ist nur der aktuelle Zustand, kein historisches Receiptarchiv.

Permanente Tests müssen **vor** dem jeweiligen Produktionshunk rot sein:

- Native USD-Summary mit ausschließlich USDT-Collateral ungleich Parität; positive/negative Preis-PnL und Funding, Positionen plus offene Ordermargin, Cashbestand darf Equity nicht erhöhen.
- Exakte Zahl `100.000000000000000001`, Exponent-/Integerform, zwei floatgleiche Originale; Duplicate-JSON, bool/null/NaN, Überlänge, fehlendes Flex, falscher Typ/Status/Modus/Host/Generation.
- Zwei parallele Balancecalls mit unterschiedlichen Originaltokens, gleichzeitig Positions-/Historyread; kein Capturetausch. Timeout, Cancellation, Credentialrotation, fehlender/doppelter Hook und später geerbter Task bleiben unbewiesen. Genau ein Accounts-Read je Aufruf, keine neue Schleife.
- Nicht-Flex-Exposure, gleicher USD-Cashflow aus anderem Wallet, unbekannte Legacy-Walletzuordnung: keine Flex-Vollständigkeit. Reine Holdingbestände bleiben separat zulässig.
- Beispiel: heutiger Ledger `-4`, Preis-UPL `-2`, Accrual `-1` ergibt Tages-PnL `-7`, nicht `-6` oder `-8`. Nach belegter Realisation Ledger `-5`, unveränderter Preis-UPL `-2`, Accrual `0` ergibt weiterhin `-7`. Negative Beträge niemals nullen; positive Accrual nicht doppelt in Equity aufnehmen.
- Stundenwechsel, Teilfill-Nettoänderung, UTC-Wechsel, verspäteter Fundingnachtrag, Restart und finaler Quellen-/Zeitwechsel. Überschreitung führt über vorhandenen Entrydrain, nicht zu Stopverlust oder pauschaler Liquidation. Fehlende Alt-Fee-/FX-Belege bleiben ungelöst.

Fokusbefehle nach Freigabe: gepinntes Python `-B -m unittest discover -s exchange_executor/tests -p test_kraken_reporting.py -v`, bestehende `test_accounting_evidence.py`/`test_kraken_cashleg_sources.py`; Node-Fokus für Accounting, Funding, Risk Admission/Reconcile und CCXT-Snapshot; anschließend betroffene Ruff-/Typecheck-/Architektur-/Complexitygates ohne Grenzänderung. Kein schwerer Gesamtlauf in diesem Rechercheauftrag.

**Abschluss dieser Note:** native USD-Feldsemantik, konkrete Originaltextgefahr und kleinste Capture-/Scope-/Accrualschnittstellen belegt. Kraken-Reporting ist damit planbar, aber noch nicht implementiert oder zertifiziert; die unabhängige Protected-IOC-/Stop-Abnahme bleibt davon unberührt.
