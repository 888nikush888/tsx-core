# 009 — normalized execution-symbol scope

## Narrow implementation, not provider certification

`resolve_symbol` now treats the profile's settlement preference as both a
whitelist and its ranking. The quote and settlement units must be explicit
USD/USDT/USDC; settlement must additionally belong to that profile's whitelist.
Quote is never substituted for missing settlement. Root separately restricted
the existing profile declarations to HL USDC, Bybit USDT/USDC and Kraken USD.

The execution candidate needs a consistent normalized swap identity: explicit
contract/swap/linear true, spot/future/option/inverse false, type swap, active
true, explicit null expiry, nonempty normalized market ID, consistent unified symbol and a
positive finite normalized multiplier bounded to 36 integer / 18 fractional
digits. The multiplier check does not round or change the market. Missing
values are not inferred. Multiple equally ranked complete candidates remain
ambiguous.

Known coherent spot/future/inverse/inactive or disallowed-unit markets are
outside this execution scope. Contradictory or missing relevant metadata uses
`SYMBOL_METADATA_UNPROVEN`, including when a different complete candidate
exists. Incomplete inventories, missing/unclassifiable base names and the
100,000-row read bound also fail with this code. Readable, different base names
are not adopted or treated as damaged BTC metadata; known SDK punctuation is
retained. No new symbol alias is constructed.

The existing adapter already converts this error to `ExchangeContractError`,
not the fallback-capable `SymbolUnavailableError`. `SYMBOL_UNAVAILABLE` remains
reserved for a readable inventory with no eligible candidate and known
exclusions. `linear_swap_markets` is intentionally unchanged: the registry uses
that broader prefilter for discovery, not executable market admission.

## Evidence and deliberate limits

The new permanent suite `test_symbol_resolver_scope.py` first failed against the
old resolver. It now checks scope/ranking, every required field, unknown and
conflicting metadata, exact exclusion versus unknown classification, ambiguous
candidates, incomplete/bounded inventory, preserved objects and adapter error
classification. All provider transports are local fakes.

The positive SDK fixtures execute the installed CCXT 4.5.75 Hyperliquid market
parser, Bybit `fetch_future_markets` parser and Kraken `fetch_markets` parser.
Kraken's omitted native `tradeable` becomes normalized `active=None` and is
rejected as unknown. The mixed Hyperliquid fixture parses BTC, native
`xyz:XYZ100` and `USDC.e`; the SDK emits `XYZ-XYZ100` and `USDC.E`, which do not
block BTC selection. Original rows remain byte/value unchanged.

This is only a normalized-metadata fence. It does **not** restore native fields
already defaulted/lost by the SDK. In the installed SDK, for example, HL can
default missing delisting state to active and missing collateral name to USDC;
Bybit can default settlement and hides a swap's delivery time in normalized
expiry. Native source-scope validation, first-DEX proof, provider history
finality, Kraken bounded-stop contract and receipt evidence remain independent
open work. No profile capability, attestation, receipt pin or account access is
granted by these tests.

Only explicitly positive normalized fields were added to the existing
`FakeProtectedRest` fixture; no original ACK, fill, history or provider payload
was invented. The two isolated old resolver tests now supply complete normalized
markets; their ambiguity case uses two genuine distinct IDs with the same valid
unified symbol rather than contradictory symbol suffixes.

## Verification

- New focused resolver suite: 14 tests passed, including actual pinned SDK
  parsers and the mixed inventory.
- Existing contract suite: 35 tests passed.
- Existing phase-2 registry suite: 11 tests passed.
- Ruff and focused complexity threshold (15): passed.
- First full pinned Python follow-up: 437 tests, 2 errors. One was the expected
  checked-in inventory drift after Root narrowed the profile declarations; the
  inventory validator correctly rejected the old declaration/source hash. The
  other was the isolated Kraken matrix's SDK market missing explicit
  future/option/expiry fields on its positive Cancel fixture. Both were reported
  before any additional file was changed. No production relaxation is needed.
- Root then regenerated only the three profile declarations and bound hashes in
  the inventory, preserving all 103 assessments and their evidence pins. The
  Kraken positive fixture received only `future=False`, `option=False` and
  `expiry=None`. Repeated full Python run 34426: 437 tests, 108.225 seconds,
  exit 0. Root Node follow-up 59931: all seven focused integration files passed.
  These are local follow-up tests, not provider or release acceptance.
