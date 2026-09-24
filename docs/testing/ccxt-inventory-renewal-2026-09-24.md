# CCXT-Inventarbindung nach lesender Katalogergänzung

Basis: Integrationscommit `3e22d06` vom 24.09.2026, Python 3.12, lokal installiertes CCXT 4.5.75. Der Offline-Builder `exchange_executor/tools/audit_derivatives_candidates.py` führte unter seinem Netzwerk- und Credential-Guard einen frischen Vergleich mit `docs/testing/ccxt-expansion-matrix.json` aus. Die einzige Abweichung innerhalb der Inventur war der Eintrag `sources["exchange_executor/ccxt_registry.py"]`:

| Feld | Bisher | Neu |
| --- | --- | --- |
| Registry-Datei, Bytes | 10.256 | 10.491 |
| Registry-Datei, SHA256 | `bc265415bc30caf600f99a00f1b9ac70883c44722f0960885b69c4e8df5f939c` | `84dd101b51d64166dbf5024256b2dd9c96789e7596a98de41a3c35875b22a50d` |
| `inventory.sourceHash` | `8c1255637427de68772fa670d048e4cd3dc6fc2bc9de0585538270eb95efadfd` | `39b3fb28594e088d3ff80909ce21d9811fd9679bf9d5ac3f5bb7c212bfd672a8` |
| `inventoryHash` | `5a76c0381e97811ce155f2eaa523570cabdd0bc0d8e81b72c8950f0d8f0dd69f` | `7c0ab01cf1e2629cee66528959e0c45ffe01a6111697294e5ca528116f247e54` |

Der Registry-Diff zur früheren Bindung fügt ausschließlich den Import des festen Inventarhashs und das lesende Feld `implementation.reviewedInventoryHash` in `catalog()` hinzu. Der Eintrag erscheint nur für die installierte CCXT-Version 4.5.75. Es gab keine Änderung an Adapter, Orderpfaden, Profilen, Credential-Allowlist oder Capability-Prädikaten. Der kanonische Vergleich der alten und frisch gebauten Inventuren ergab: alle 103 Exchange-Zeilen identisch; alle installierten SDK-Datei- und 1.694 Methodenbelege identisch; sämtliche anderen lokalen Quelldateieinträge identisch. Die 103 Assessments sind ebenfalls unverändert, gebunden durch denselben SHA256 `48920351be5a4cae85508e469aab0d9c91b8b805c29d639218fd49014bcc2bff`. Es bleiben 1 `existing`, 66 `not_easy` und 36 `not_derivative`, mit `implementationVerified: false` und `providerAcceptanceVerified: false` in jedem Assessment.

Die Matrix wurde nur an diesen drei abgeleiteten Hashfeldern und der Bytezahl der Registry-Datei erneuert. Die fest codierten Inventarbindungen im Kandidatenverifier, dem Generator und dem lesenden UI-Vergleich sowie die generierte UI-Projektion wurden auf denselben Wert gesetzt. Historische Receipts/Reviews werden nicht rückwirkend umgeschrieben. Der bestehende Implementierungs-Receipt bleibt bis zur separaten quellenexakten Prüfung und unabhängigen Erneuerung ungültig; diese Inventuränderung verleiht weder einem weiteren Profil noch einem Provider die Freigabe.

Lokale Prüfung auf diesem Stand: `--offline --verify-inventory` bestand mit 103 REST-IDs; `scripts/generate_ccxt_catalog_assessments.py --check` bestand; alle drei Tests in `test_candidate_review_policy.py` und der vollständige Executor-Lauf mit **556/556 Tests** bestanden. `--offline --verify-complete` verweigert weiterhin erwartungsgemäß die Freigabe: `Existing profile implementation review is incomplete.` Der separate Receipt-Prüfer nennt `Implementation executor source drifted.` Dies darf nicht durch die Inventarerneuerung übergangen werden.

Für die unabhängige Abnahme: Diff des Registry-Moduls gegen die vorangegangene Bindung prüfen, die vier oben genannten Werte aus einem frischen Offline-Build nachrechnen, `--verify-inventory` und die Kandidatenpolicy-Tests ausführen, die unveränderten Assessment-/Exchange-Digests bestätigen. Jede nachfolgende Änderung an `exchange_executor/ccxt_registry.py` macht diese neue Bindung wieder ungültig.
