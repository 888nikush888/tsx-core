# Ergänzende lesende Nachprüfung — 20.09.2026

## Sonar

Frisch per authentifizierter API: 1.307 Datensätze über drei Seiten, Identität/Status/Resolution/Regel unverändert gegenüber dem vollständigen Export vom17.09. Analyse `dc4e3d23-4cad-4d91-abaf-b8c1e239815e`, Revision `58c01bc74f83cc212849ddcd7e487412ff06b2b7`, Datum17.09.2026 13:39:29+02:00. OPEN79, RESOLVED/FALSE-POSITIVE7, RESOLVED/WONTFIX1, CLOSED/FIXED1217, CLOSED/REMOVED3. Keine Hotspots.

Die79offenen IDs verteilen sich überschneidungsfrei auf46Backend-,18UI- und15Fill/Python-Einträge;72Quellkorrekturen warten auf Scan, sieben Einzelfallentscheidungen auf Abschlussnachweis. Regeln: S6551=50, S8714=12, S4782=6, S6749=4, S2681/S4323/S6582 je2, S6845=1.

Alle1.220CLOSED-IDs wurden als Inventar abgeglichen, nicht alle erneut zeilenweise geprüft. Die acht alten FP-/WONTFIX-Entscheidungen und zweiNOSONAR-Stellen besitzen Einzelreviews; heute wurden Begründungen und ausgewählte kritische Quellen nachvollzogen. Diese Grenzen sind im Abschlussplan ausdrücklich erfasst.

ID-Vergleiche müssen case-sensitive sein. Der PowerShell-Standardvergleich würde hier fälschlich1.268 statt1.307eindeutiger IDs zählen.

## DeepSource

Frische vollständige statische Main-Inventur um10:08:13UTC:1.315IDs, unverändert gegenüber17.09.;1.178JS-R1005 ausgenommen,137relevante Vorkommen in19Regeln. Sanitisierten maschinenlesbaren Nachweis siehe `deepsource-fresh-read.json`.

137Vorkommen:49Quelländerungen,69erwartete Verträge,16FP-Kandidaten, drei zusätzliche Typchecker-FP-Kandidaten mit notwendigem Cloudnachweis. Beide Ledgers vollständig/disjunkt; alle137aktuellen Quellhashes geprüft. Auch alle370gespeicherten Quellbindungen der historischen lokalen Unterdrückungen stimmen. Das belegt keine Ausführung sämtlicher370Stellen und keinen vollständigen Export unbekannter Cloud-Unterdrückungshistorie.

Direkt nachvollzogene Vertragsbelege: native Promise-Grenzen in `src/trading_web_control.ts` und Fehler-/Adoptionstests in `tests/test_trading_control_error_types.js`; gezielte Instanzüberschreibung in `tests/test_trading_protection_receipt.js`; SDK-Koroutinen in `exchange_executor/ccxt_sdk_policy.py`; nullable-Overloads in `exchange_executor/kucoin_provider_common.py`. Keine pauschale Entfernung von async/Instanzbindung, keine Null-Fallbacks allein gegen Typcheckerdiagnosen.

## Unabhängige Planprüfung

Ein separater Reviewer prüfte Plan004. Zwei konkrete Verbesserungen wurden übernommen: Cloud-Gates aus Stufen2–4 ausdrücklich nach autorisierter Kandidatenveröffentlichung einordnen; Receipt-Verifikation mit dem erforderlichen `--python`-Argument angeben. Zählungen und Plan-only-Grenze wurden bestätigt. Keine Programmcodeänderungen oder Remote-Statusänderungen in diesem Planungsdurchlauf.
