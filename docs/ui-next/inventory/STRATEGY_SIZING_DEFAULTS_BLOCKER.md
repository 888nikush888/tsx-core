# Strategy sizing defaults: operational proof blocker

Reviewed at integration commit `c5d5690a99c4ed51d741c222a4c7f6382b33bfd5` on 2026-09-24. This is a design and evidence report. It changes no sizing behavior or inventory status.

## Decision

None of the six `strategy.sizing.*` rows can be promoted as an effective graph-backed operational setting. A strategy draft can save and publish `positionSizingMode`, `riskPerTradePercent`, `maxAdaptiveRiskPercent`, `maxPositionNotional`, `defaultLeverage`, and `maxLeverage`, but changing any of them alone cannot alter sizing for a new intent on an executable workflow path. The effective controls are the corresponding six `resource.sizing.*` rows, which already have their own bounded evidence slice.

## Evidence and boundary

1. `src/workflow_repository.ts` includes `sizing` in `REQUIRED_EXECUTION_KINDS`. A graph lineage without it is inert and creates no executable path.
2. `validateSizingConfiguration` normalizes all six values of the sizing resource. `compiledEffectiveConfiguration` overlays that complete normalized object onto the published strategy sizing object. Thus no one of the six strategy values survives as an effective value on a compiled path.
3. The compiled path pins `sizingResourceVersionId` and its `effectiveConfiguration`. `src/trading_engine.ts:executionPathConfiguration` reads that pinned configuration when an intent has an execution path, and the plan uses the resulting strategy.
4. `tests/test_workflow_builder.js` publishes a strategy with six changed defaults, activates its strategy resource in a graph, creates new pinned intents, and verifies that the effective sizing and synthetic plan remain those of the old sizing resource. It then publishes and activates a changed sizing resource, verifies the six effective values, probes each field with bounded synthetic trade plans, and checks persistence and historical intent/graph isolation after database reopen. `frontend/tests/workflow-resource-editor.test.tsx` checks submission of all six strategy defaults and the visible override warning. `tests/test_web_server.js` checks authorized, audited strategy publication.
5. A separate legacy route exists: `src/trading_engine.ts:executionPathConfiguration` reads a published strategy directly when `executionPathId` is absent, and `src/forwarder.ts:createLegacyIntentForSignal` can create such an intent. The migration in `src/workflow_repository.ts` also seeds an initial sizing resource from legacy strategy sizing. These compatibility paths do not make a later strategy-only edit effective on a compiled workflow. They require a separate route-specific proof if retained as operator controls; they must not be used to promote these six workflow inventory rows.

| Strategy field | Effective graph source | Consequence of strategy-only edit |
| --- | --- | --- |
| `positionSizingMode` | `resource.sizing.positionSizingMode` | No change to new path intent sizing mode |
| `riskPerTradePercent` | `resource.sizing.riskPerTradePercent` | No change to baseline risk |
| `maxAdaptiveRiskPercent` | `resource.sizing.maxAdaptiveRiskPercent` | No change to adaptive ceiling |
| `maxPositionNotional` | `resource.sizing.maxPositionNotional` | No change to notional cap |
| `defaultLeverage` | `resource.sizing.defaultLeverage` | No change to fallback leverage |
| `maxLeverage` | `resource.sizing.maxLeverage` | No change to leverage cap |

## Safe product direction

Keep the sizing resource as the canonical graph control. The strategy editor should continue to describe these values as source/template defaults and direct the operator to the sizing resource for an active change. If the product requires a strategy sizing edit to change execution, design an explicit coordinated operation that selects each affected account path, creates and publishes a new sizing resource version for it, and activates a new graph revision with impact confirmation. Its review must show the old and proposed effective six-value set for each path. Preserve the existing authorization, audit, immutable version pins, validation, and graph confirmation gates; do not silently change compiler precedence or mutate an existing published version.

Acceptance evidence for that separate implementation would include field-specific browser submission; authorized and rejected API/audit cases; draft and published persistence; before/after effective reads for multiple independently sized paths; new intent pins; bounded trade-plan effect for each field; historical graph and intent stability across restart and rollback; and a no-order engine preparation. If the legacy route remains operator-facing, document and test its separate strategy-direct semantics before counting it toward any UI coverage claim.

## Validation of this review

- `node --import tsx tests/test_workflow_builder.js`: passed.
- `node --import tsx tests/test_operational_field_inventory.js`: passed; all six rows remain `unverified`.
- `node --import tsx tests/test_web_server.js`: passed.
- `node node_modules/vitest/vitest.mjs run --configLoader runner --environment jsdom tests/workflow-resource-editor.test.tsx` from `frontend`: 22/22 passed.
- `npm run typecheck`, `npm run lint`, `npm run lint:frontend`, and `npm run quality:complexity`: passed.
- An earlier broad frontend invocation ran 417 tests: 414 passed and three unrelated tests timed out at the default five-second limit (`telegram-settings-coverage`, `trade-relations`, `workflow-fallback-policy`). The targeted sizing editor suite passed when run alone.

No real order, live trading, host sign-off, key change, gate change, or inventory promotion was performed.
