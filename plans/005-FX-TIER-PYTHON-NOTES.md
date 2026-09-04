# 005: exaktes v2-Notionalbudget im Python-Tierfence

Stand: 3. September 2026. Freigegebener enger Python-Teil, kein Node-Sender-, Profil-, Konto-, Netzwerk-, Readbudget- oder Moduswechsel. Nur lokale Fakes mit Python 3.12.13 / CCXT 4.5.75. Keine Änderungen an Adapter, Originaljournal, Tierquellen oder Geld-/Mengenformeln.

## Dateien und Vertrag

- `exchange_executor/leverage_tier_evidence.py`: `assert_tier_entry` akzeptiert zusätzlich die ausdrücklich ganzzahlige Version 2. Die gemeinsamen bisherigen Account-/Market-/Credential-/Tier-/Frische-/Scope-/Quantity-/Leveragefences und die SDK-Kontraktmengenprüfung laufen weiterhin. Der originale v1-Notionalvergleich bleibt unverändert in seinem bisherigen Zweig.
- Neu `exchange_executor/fx_tier_budget.py`: strikter, rein mathematischer Validator und exakter Vergleich. Diese Datei ist additiv in `sonar.sources` registriert.
- Neu `exchange_executor/tests/test_fx_tier_budget.py`: zwölf permanente Tests.

Die v2 behält die vorhandenen Decisionfelder. Zusätzlich muss `maximumNotionalCurrency` exakt der bereits gebundenen `evidence.currency` entsprechen. `maximumNotional` muss ausdrücklich vorhanden und identisch zum `decimal`-Feld von `maximumNotionalValue` sein: exakt endlicher Decimalalias oder null, niemals gerundeter Ersatz.

`maximumNotionalValue` hat genau die sechs Node-MoneyValue-Felder `lower`, `upper`, `exact`, `decimal`, `precision`, `terms`. Nur ein strikt positiver, bereits gekürzter Bruch ist zulässig. Zähler und Nenner sind kanonische positive ASCII-Dezimalintegerstrings mit höchstens 256 Ziffern. Null, Vorzeichen, führende Nullen, Unicodeziffern, fehlende/zusätzliche Bruchfelder, Nenner null, nicht gekürzte Brüche und `bounded`-Werte werden verworfen. `terms` muss eine positive sichere Ganzzahl sein; Boolean, Float, null oder Nullterme sind nicht zulässig.

Die beiden Ausgabegrenzen werden ausschließlich durch ganzzahlige Division bei 18 Nachkommastellen erzeugt. Beide müssen die 36-Ziffern-Grenze für ihren Integerteil einhalten; auch ein Upperbound-Übertrag über diese Grenze wird abgewiesen. Die gelieferten Bounds, `decimal` und `precision` müssen exakt zum Bruch passen. Ein mathematisch positiver Wert unter einem Decimalquantum behält seine exakte Identität, auch wenn sein Lowerbound der Decimalstring `'0'` ist.

Der Vergleich verwendet ausschließlich den exakten Bruch:

`quantity × max(markPrice, tatsächlicher spec.price) <= maximumNotionalValue.exact`

Alle drei Decimaloperanden durchlaufen die bisherigen Tier-Decimalgrenzen. Danach wird mit exakten `Fraction`-Werten verglichen, ohne Zwischenrundung und ohne Quotientenbildung in einem begrenzten Decimalcontext. Der Helper trifft keine Entscheidung über FX-Quellen, Kontorechte oder die Zulässigkeit des ursprünglichen Budgets; deren Node-Provenienz und gehaltene Requestbindung bleiben eigene Pflichten.

Öffentliche reine Helper-Signaturen:

- `exact_positive_money_value(value) -> Fraction`
- `assert_fx_tier_budget(decision, currency, quantity, mark, spec_price) -> None`

Fehler verwenden den vorhandenen `TierEvidenceError` / `LEVERAGE_TIERS_UNPROVEN`. Es gibt keinen Fallback auf Bounds, Stablecoinparität oder v1, wenn ein v2-Beleg ungültig ist.

## Rot → Grün und SDK-Nachweis

Die positiven v2-Fälle wurden vor dem Quellhunk tatsächlich rot ausgeführt: die alte Versionsprüfung verweigerte sie. Nach der Implementierung sind insbesondere belegt:

- Exakte ganzzahlige, endliche und nicht endliche rationale Maxima, unveränderte Eingabeobjekte und verschiedene positive Termzahlen.
- Mark- oder tatsächlicher Specpreis knapp über `1000/3` wird abgewiesen; ein knapp darunter liegender Preis bleibt zulässig.
- Produkt `10^-18 × 10^-18` passt exakt unter `10^-36`; ein trotz identischer Anzeigegrenzen minimal kleineres rationales Budget wird abgewiesen.
- Unterschiede in 255-/256-stelligen Koeffizienten bleiben unter Decimalpräzision 2, 28 und 180 wirksam. Die 256-Ziffern-Eingabegrenze und beide 36/18-Ausgabegrenzen werden nicht gelockert.
- Currency-, Alias-, Reduktions-, Bounds-, Decimal-, Precision-, Terms- und Strukturmanipulationen werden verweigert.
- Bestehende Scope-/Credential-/Frische-/Tierwechsel und geänderte tatsächliche SDK-Kontraktmengen bleiben blockierend. V1 benötigt keine neuen Felder und behält seinen bisherigen Markanstiegsblock.
- Die echte gepinnte CCXT-Precision wird in der vorhandenen Adapter-Specbildung verwendet. Bei `quantity=5` und `contractSize=.001` prüft der Fence `amount=5000`; exakt `qty='5000'` und `price='100'` erreichen den tatsächlichen signierten Bybit-Batchbody. Nur der Transport wird lokal abgefangen. Eine tatsächlich gerundete SDK-Menge führt vor Setter/Batch zum Fehler.
- Ein v2-Decision schaltet die weiterhin ungeklärte geschützte Kraken-Batchfähigkeit ausdrücklich nicht frei; der reale Adapterpfad bleibt davor geschlossen.

## Fokussierte Gates und Restgrenze

Nach dem letzten Quellhunk grün:

- `test_fx_tier_budget.py`: 12 Tests.
- `test_leverage_tier_evidence.py`: 10 Tests.
- `test_leverage_tiers.py`: 4 Tests.
- `test_entry_price_sdk.py`: 5 Tests.
- `test_entry_price_constraints.py`: 11 Tests.
- Insgesamt 42 fokussierte Python-Tests, Ruff einschließlich C901 sowie `git diff --check`.
- Separater regulärer `test_sonar_evidence.js`: grün, einschließlich explizitem Python-Produktionsquellscope.

Kein neuer Gesamtlauf, keine Coverage- oder Mutationneuberechnung. Der zuvor vom Root berichtete Python-345-/86%-Nachweis liegt zeitlich vor diesem neuen Modul und muss für den Gesamtstand neu erhoben werden. Die abgestimmte Node-v2-Berechnung, DTOs, Budget-/FX-Provenienz, finale Request-/Journalbindung und gesamte Sizing-Einheitenintegration bleiben beim Root. Diese Pythonstufe allein ist weder eine neue Profilfreigabe noch ein abgeschlossener 005-Nachweis.
