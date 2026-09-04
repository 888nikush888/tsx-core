# Hyperliquid – unabhängige lokale Implementierungsprüfung

Stand: 2026-09-04. Scope: CCXT 4.5.75, erster nativer Hyperliquid-Perp-DEX, lineare USDC-Perpetuals, One-way, Cross, Testnet und Live. Dies ist ausschließlich eine lokale Implementierungsprüfung mit isolierten Fakes und Original-SDK-Quellbindung. Sie ist **keine** Provider-, Konto- oder Releaseabnahme.

## Entscheidung

Der enge Scope ist lokal implementierungsverifizierbar, nachdem die Identitätsgrenze auf **Master-Key-only** verengt wurde. Vor Erzeugung eines REST-/Pro-Clients und damit vor jedem Read oder Write wird aus dem Private Key über die kryptografische Funktion der fest gepinnten CCXT-Laufzeit die EVM-Adresse abgeleitet und exakt, case-insensitiv, mit `walletAddress` verglichen. Ein fremder, malformed oder Null-Key wird geheimnisfrei abgewiesen. Agent-Wallets bleiben gesperrt, bis eine aktuelle, an dieselbe Credential-Generation gebundene Grant-Beobachtung implementiert ist.

Bybit und Kraken Futures sind nicht Bestandteil dieser Freigabe. Ihre bereits dokumentierten Scope-/Providerlücken bleiben quarantined.

## Zehn verpflichtende Paritätsklassen

| Klasse | Positive lokale Belege | Adversariale lokale Belege |
| --- | --- | --- |
| Identität/Secrets | `test_hyperliquid_master_key_binding_accepts_exact_address_case_insensitively`, Credential-Generation und Account-Fingerprint | `test_hyperliquid_master_key_binding_precedes_client_construction`, Foreign-/Malformed-/Null-Key, Rotation und stale Write |
| Symbol/Produkt | `test_profile_settlement_policy.py`, `test_symbol_resolver_scope.py` für first-DEX/USDC/linear/Perp/ContractSize | Mixed-DEX, Spot/Future/inverse, fehlend, inaktiv und mehrdeutig bleiben fail-closed |
| Kontomodus/Admission | `test_execution_constraints.py`, `test_leverage_tier_evidence.py`, `test_leverage_tiers.py` | fremder User/Coin, Abstraction nicht `disabled`, isolated oder inkonsistentes Leverage/Tier blockiert Entry |
| Entry/Schutz | `test_entry_price_sdk.py` belegt gebundenes IOC+Stop-Batch und SDK-Serialisierung | Teilannahme, unbekannter Submit, falsches Reduce-only/Trigger und Builderwrites werden nicht als geschützt behauptet |
| Ownership/Abgleich | `test_provider_order_identity.py`, `test_current_state.py`, `test_order_evidence.py` | nullable fremde Client-ID, unbekannte/mehrdeutige IDs und fremde Exposure werden weder übernommen noch gelöscht |
| Historie | `test_history_pagination.py`, `test_history_coverage.py`, `test_hyperliquid_retention.py` | Sättigung, Retention-Grenzen, leere/volle Seiten, Zeitkollisionen und Budgetende bleiben unvollständig |
| Lebenszyklus | Node-Schutz-, Recovery-, Late-Fill-, Cancel- und Take-Profit-Suiten im Root-Runner | kein Stop-Lösen ohne gedeckten Ersatz, kein zweiter Entry nach unbekanntem Submit, kein künstlicher lokaler Abschluss |
| Geld/Risiko | Hyperliquid-Fill-, Funding-, Accountlog-, FX- und Ledgertests erhalten USDC-Originale und Vorzeichen | fehlender USD/USDT/USDC-Beleg sperrt nur neue riskante Entries; Schutz bestehender Positionen bleibt aktiv |
| Fehler/Streams | REST bleibt Autorität; Stream-, Reconnect- und Transient-Error-Tests | kein Blind-Submit-Retry, Vertragsfehler bleiben hart, Duplikate erzeugen keine zweite Buchung |
| Cross-Layer | TTL-, Account-Isolation-, Maintenance-, Crash- und Dispatch-Fence-Tests | ursprüngliche Frist/Requests/IDs/Credential-Generation dürfen nicht nachträglich umgebunden werden |

## Reviewgrenzen

- Keine Secret-, Konto-, Server-, Telegram- oder Börsenverbindung wurde aufgebaut.
- Der Nutzer hat die Geldwährungsgrenze auf USD, USDT und USDC beschränkt. Es wird keine Parität unterstellt; eine fremde Gebührenwährung benötigt einen belegten, höchstens zehn Sekunden alten Kurs mit kohärenten Legs. Ohne Kurs keine neuen Entries, aber weiter Schutz für bestehende Positionen.
- Die Implementierungsakte muss zusätzlich durch den vollständigen Root-Quellhash, den vollständigen Executor-/SDK-Hash, einen revisionsgenauen lokalen Gatebericht und einen unabhängig im Code gepinnten V2-Receipt gebunden werden.
- `providerAcceptanceVerified` bleibt zwingend `false`.
