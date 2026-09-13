# Anonymous async callback review — 2026-09-13

Read-only review against HEAD d47ee41 of the in-progress triage reconciliation. No tracked file was edited. Reviewed source callback removals and async test mocks in `git diff HEAD`.

## Confirmed production regression

`src/delivery_tracker.ts`, `TelegramDeliveryTracker.waitForResult`, messages.map callback: restore async. The callback may first create a pending waiter, then throw synchronously for a later malformed message. With async removed, Array.map aborts before Promise.all attaches rejection handlers to already-created waiter promises. A handled outer rejection can therefore be followed by an unhandled rejection and process termination under default Node behavior.

Actual current module reproduction using Node22 + tsx: instantiate TelegramDeliveryTracker(10), call waitForResult({messages:[{id:1,sending_state:{_:"messageSendingStatePending"}},{sending_state:{}}]}), handle its rejection, wait30ms with temporary process unhandledRejection listener. Output: outer = Telegram send returned a message without an id.; unhandled = [Telegram delivery confirmation timed out after 10ms.]. The listener was confined to this standalone process. Add a regression that checks no unhandled rejection for this mixed batch.

## Test contract regression

`tests/test_trading_dispatch_fence.js`, failureMatrix: `reject-send` is now a synchronous throw, exactly like the separate `sync-send` case. Restore async or explicit Promise.reject to retain the distinct asynchronous provider rejection path. Likewise restore async on beforeSend rejection mocks and db.exec COMMIT failure mock to retain rejected-promise coverage in addition to synchronous guard coverage.

Other throwing mock replacements lose rejection coverage although current caller await/try can accept both. Restore original async signatures for changed rejecting mocks in:
- test_backup.js, test_backup_proofs.js (replication failures)
- test_deepsource_export.js (fetch failure)
- test_dynamic_exchange_registry.js (catalog/probe failures)
- test_signal_parser.js (requestCompletion retry failures; provider contract promises)
- test_startup_authority.js, test_test_scheduler.js
- test_telegram_viewer_service.js (projection failure)
- test_trading_failures.js (marketSnapshot, openState, reconciliation, cancellation outages)
- test_trading_entry_commitment.js, test_trading_protection_receipt.js
- test_trading_risk_repository.js, test_trading_mutation_coordinator.js
- test_ui_restart_recovery.js, test_workflow_fallback.js
These are not proven production defects; they are losses of previously tested asynchronous failure behavior. Pure async ()=>value changed to ()=>Promise.resolve(value) keeps a Promise contract. Plain-value returns substituted into adapter mocks should also retain their original Promise contract. Promise.resolve().then(body) changes when side effects run compared with async body and should not be considered exact restoration.

## Inspected production removals without established escaped-rejection regression

- backup_generation initializeConfigurationGeneration action: caller withProcessLockOwner uses try/return await action/finally; synchronous action errors stay contained in outer promise. Barrier finally remains.
- db drain: async ()=>undefined to ()=>Promise.resolve() is an equivalent resolved-Promise callback.
- mcp_server contract-preview callback: handler invoked under try/await in registerTool, so validation throw is caught and action recorded. Catch callback that exits process does not need async.
- trading_runtime_release and trading_web_control mutation callbacks: TradingMutationCoordinator.run contains operation under async/await/finally (or async outer run for inherited context), preserving cleanup and rejection boundary. No proved functional regression from callback async removal alone.
- signal_parser SDK wrapper: call is awaited under provider attempt try/finally. No escaped rejection established; SDK Promise subclass exposure differs internally but no caller reliance found.
- forwarder dashboard callbacks: list/retry/ack delegate async functions. runBackupNow/runBackupDrill can now throw before returning promise when unavailable or artifact resolution fails; safest contract preservation is restore async, though inspected outer job/HTTP callers have catches.
- metrics callback is extracted into an async helper with explicit catch/destroy. This improves containment rather than removing async semantics outright.
- telegram_viewer health callback still uses an async IIFE; only void operator was removed.
- ui_trade_relations callback delegates to async relationPage. No rejection escape established from that callback extraction alone. Broader refactor/timing review is outside this bounded callback review.

No certification of the whole triage merge or all semantics is implied.

## Authorized follow-up implementation

Parent subsequently authorized edits to delivery_tracker.ts and the two existing tests only. Restored async on delivery map; added mixedBatchFailureKeepsPendingRejectionsHandled using close() to reject the already-created waiter deterministically, one setImmediate turn to observe unhandledRejection, and finally cleanup of listener/tracker. Restored the four async rejection callbacks in test_trading_dispatch_fence.js (beforeSend source change, reject-send, db.exec COMMIT failure, revoked-witness beforeSend). Both test files passed with Node22 --import tsx, exit0. No commit made. Other tracked source files were not edited by this agent.
