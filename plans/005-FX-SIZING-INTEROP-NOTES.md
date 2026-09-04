# 005 — Node/Python FX sizing interoperability

## Scope and result (2026-09-03)

Test-only addition: `tests/test_trading_fx_sizing_python.js`, the isolated child-process fixture
`exchange_executor/tests/fixtures/fx_sizing_interop.py`, and its normal test-runner registration.
No production, schema, dependency, scheduler, provider-profile or credential changes.

Python first emits account/credential/profile-bound TierEvidence from the production
`read_tier_evidence` reader over existing local Bybit fakes. Node uses that evidence, the
real `deriveFxConversion` result for **60001 / 60150 USD per USDT**, `createTradingPlan`,
`assertPlanTierDecision`, and `requestFromOrder`. The resulting request, including its
original deadline and v2 decision, crosses JSON stdin into a second Python process.
Python does not reconstruct or replace the decision/hash. Its fresh local tier reads use
the same original account/profile/table; current mark changes are deliberately separate.

The real pinned **CCXT 4.5.75** precision and signing path is exercised after the real
`CcxtAdapter._order_spec` validation. Every transport is intercepted. SDK account-mode
initialization is supplied explicitly by a local fake; it is not a real account witness.
No provider requests, loaded secret files, database files or running services are used.

## Permanent cases

The new runner contains 19 cases, covering:

- Genuine v2 maximum `12030000 / 60001` USDT, quantity `2.004`, and a required null
  decimal alias. Exact Node tier hash and native Python binding agree.
- Genuine capped v2 exact-decimal maximum `200` with alias `200`; native v1 remains
  field-for-field free of the new MoneyValue/currency properties.
- Contract sizes `1` and `0.001`: the signed SDK body carries respectively `2.004` and
  `2004` contracts, unchanged from the validated actual SDK spec. Exact original client
  ID, price, category and position index are asserted; the SDK signature must exist.
- Adjacent 18-decimal prices immediately below/above the exact maximum divided by
  quantity. Direct `assert_tier_entry` checks the actual spec price without intermediate
  decimal rounding; actual `_order_spec` checks the equally precise changed mark.
- A higher actual SDK entry price and a one-quantum-higher native-v1 mark are rejected.
- Oversized quantity (`2.005`) and a quantity that the actual SDK rounds (`2.0045`) are
  rejected. The latter is still below the rational budget, so it specifically proves the
  independent exact SDK-quantity fence.
- Table-hash, currency, decimal alias, missing null alias, upper bound, unreduced rational,
  and original decision/request quantity tampering are rejected.

All negative cases assert `LEVERAGE_TIERS_UNPROVEN`, the expected distinct cause, **zero
setter calls and zero SDK batch transport calls**, and unchanged original request data.
Positive SDK cases also assert that the local setter branch and signed batch really ran,
so a fixture that merely rejects everything cannot pass.

## Focused verification

- Three registered Node files pass: the new interoperability test, `test_trading_fx_sizing.js`,
  and `test_fill_quantity_python_roundtrip.js` (the existing reverse-direction contract).
- Existing `test_fx_tier_budget.py`: all 12 tests pass unchanged.
- ESLint with zero warnings for the new JS test and runner; Ruff including C901 for the
  new Python fixture; whitespace/diff check all pass.
- Node 22.23.2; Python 3.12.13 selected via `TSX_TEST_PYTHON`; CCXT 4.5.75 is asserted
  inside the fixture. No full suite or new coverage claim was run for this narrow task.

This proves the local wire/units/arithmetic interoperability only. It does not authorize
a provider profile, turn snapshot observation into stronger FX timing evidence, certify
an actual account, or replace the separately integrated Engine/Journal/dispatch fences.
