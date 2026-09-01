# UI consistency and account retirement — TDD record

## Scope

- Replace every browser-native confirmation or prompt with one accessible application dialog.
- Remove inactive trading accounts from the active setup without deleting retained audit history.
- Keep equity series separated by account reporting currency and use one chart implementation on Dashboard and Analytics.
- Make account incidents discoverable and actionable.
- Restore square surfaces and one shared horizontal shell alignment.
- Stop attaching the full Telegram Viewer menu to unsolicited notifications, tests and unknown-command hints.

## Red

The initial regression suite failed for the intended reasons:

- `confirmation-policy.test.ts` found native `window.confirm` and `window.prompt` calls.
- `operations-panel-helpers.test.ts` had no currency-safe equity grouping implementation.
- `test_trading_core.js` rejected deletion when only retained reconciliation history referenced an account.
- `test_telegram_viewer_core.js` expected the new schema migration.
- `test_telegram_viewer_service.js` observed an inline menu on every automatic delivery.
- the mobile browser assertion still required rounded cards.

## Green

- Added a reusable typed-confirmation dialog and a source policy test preventing browser-native confirmations from returning.
- Added schema migration 24 and safe account retirement. Active routes, active workflow paths, unresolved intents, open positions and remote exposure remain hard blockers; terminal history remains queryable.
- Added deterministic equity grouping by reporting currency and account, shared by Dashboard and Analytics.
- Added a direct Dashboard incident action and an account-level incident overview with reconciliation guidance.
- Unified desktop/mobile shell insets and reset the design radius to zero.
- Kept Telegram menus on explicit `/start`, `/help`, projections and callbacks only.

## Verification

- Frontend unit/component tests: 124 passed.
- Playwright: 52 passed across Chromium, Firefox, WebKit and mobile Chromium.
- Trading core, Telegram Viewer core and Telegram Viewer service regression tests passed.
- Full repository quality gates are run before release and deployment.
