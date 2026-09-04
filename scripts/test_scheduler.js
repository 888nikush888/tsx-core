import { spawn } from 'node:child_process';
import path from 'node:path';

// Reviewed process-local contracts or uniquely rooted temporary-DB fixtures.
// New tests are serial until explicitly reviewed; never infer permission from a prefix.
export const MODULE_COVERAGE_PARALLEL_TESTS = Object.freeze([
  // M43-M46 review: process-local arithmetic, explicit -B Python fakes, or owned mkdtemp roots.
  // The transport fixture binds port 0 itself and keeps its credential token under its own root.
  'test_trading_money_value.js',
  'test_trading_money_risk.js',
  'test_trading_recovery_schedule_contract.js',
  'test_trading_recovery_schedule_transport.js',
  'test_trading_fx_repository.js',
  'test_trading_fx_valuation.js',
  'test_trading_fx_fill_accounting.js',
  'test_trading_fx_risk_admission.js',
  'test_trading_fx_risk_reservations.js',
  'test_trading_fx_sizing.js',
  'test_trading_fx_sizing_python.js',
  'test_trading_fx_sizing_admission.js',
  'test_trading_fx_engine.js',
  'test_trading_fx_funding.js',
  'test_trading_fx_automatic_valuation.js',
  'test_trading_fx_money_reporting.js',
  'test_trading_fx_analytics.js',
  'test_trading_fx_journal_viewer.js',
  'test_trading_fx_migration.js',
  'test_trading_fx_money_migration.js',
  'test_trading_adaptive_money_migration.js',
  'test_trading_recovery_schedule.js',
  'test_trading_recovery_schedule_commit.js',
  'test_trading_recovery_schedule_migration.js',
  'test_trading_state_transitions.js',
  'test_trading_mutation_coordinator.js',
  'test_trading_control_races.js',
  'test_trading_order_repository.js',
  'test_trading_order_identity_requests.js',
  'test_trading_order_identity_bindings.js',
  'test_trading_fill_identity.js',
  'test_trading_fill_identity_migration.js',
  'test_trading_fill_identity_backfill.js',
  'test_trading_order_migration.js',
  'test_trading_evidence_repository.js',
  'test_trading_ownership.js',
  'test_trading_account_baseline.js',
  'test_trading_recovery.js',
  'test_trading_prepared_exit_recovery.js',
  'test_trading_recovery_worker.js',
  'test_trading_pending_fairness.js',
  'test_trading_preparation_recovery.js',
  'test_trading_protected_entry_crash.js',
  'test_trading_dispatch_fence.js',
  'test_trading_risk_reservations.js',
  'test_trading_risk_repository.js',
  'test_trading_risk_engine.js',
  'test_trading_history.js',
  'test_trading_entry_commitment.js',
  'test_trading_cancel_budget.js',
  'test_trading_cancel_evidence.js',
  'test_trading_exit_cancel_recovery.js',
  'test_trading_exit_cancel_engine.js',
  'test_trading_entry_expiry.js',
  'test_trading_execution_constraints.js',
  'test_trading_execution_mode_fence.js',
  'test_trading_entry_price.js',
  'test_trading_entry_price_engine.js',
  'test_trading_leverage_tiers.js',
  'test_trading_tier_fence.js',
  'test_trading_emergency.js',
  'test_trading_protection.js',
  'test_trading_protection_receipt.js',
  'test_trading_take_profit.js',
  'test_trading_safety_proof.js',
  'test_trading_lifecycle_safety.js',
  'test_trading_global_release.js',
  'test_trading_account_retirement.js',
  'test_trading_entry_safety.js',
  'test_trading_account_mode.js',
  'test_trading_uta_baseline.js',
  'test_trading_account_scope.js',
  'test_trading_account_log.js',
  'test_trading_account_log_audit.js',
  'test_trading_funding_observation.js',
  'test_trading_funding_risk.js',
  'test_trading_kraken_cashlegs.js',
  'test_trading_kraken_cashleg_failures.js',
  'test_trading_kraken_cashleg_replay.js',
  'test_trading_kraken_cashleg_migration.js',
  'test_trading_core.js',
  'test_trading_money_ledger.js',
  'test_trading_fill_accounting.js',
  'test_trading_money_migration.js',
  'test_trading_accounting_gate.js',
  'test_trading_fee_rebate.js',
  'test_trading_engine.js',
  'test_trading_failures.js',
  'test_trading_credentials.js',
  'test_trading_web_control.js',
  'test_trading_analytics.js',
  // Each of these fixtures owns its temporary root and any local listening port.
  'test_fill_quantity_persistence.js',
  'test_fill_quantity_migration.js',
  'test_paper_accounting.js',
  'test_paper_bounded_ioc.js',
  'test_paper_partial_fills.js',
  'test_logger_file.js',
  'test_config.js',
  'test_env.js',
  'test_secret_store.js',
  'test_factory_reset_paths.js',
  'test_mcp_maintenance.js',
  'test_database_maintenance.js',
  'test_runtime_settings.js',
  'test_dupe_blocker.js',
  'test_outbox.js',
  'test_ingress_atomicity.js',
  'test_ingress_workflow_pinning.js',
  'test_ingress_migration.js',
  'test_signal_idempotence.js',
  'test_ai_usage_reservations.js',
  'test_process_lock.js',
  'test_startup_authority.js',
  'test_startup_web.js',
  'test_startup_trading.js',
  'test_migration_cli.js',
  'test_migration_recovery.js',
  'test_crash_guard.js',
  'test_backup.js',
  'test_backup_evidence.js',
  'test_backup_proofs.js',
  'test_backup_generation.js',
  'test_backup_generation_crash.js',
  'test_backup_generation_ownership.js',
  'test_backup_replication.js',
  'test_retention.js',
  'test_retention_accounting.js',
  'test_dashboard_analytics.js',
  'test_audit_trail.js',
  'test_alert_relay.js',
  'test_signal_parser.js',
  'test_signal_schema_migration.js',
  'test_workflow_builder.js',
  'test_workflow_history.js',
  'test_workflow_history_barriers.js',
  'test_workflow_fallback.js',
  'test_configurable_fallback_migration.js',
  'test_workflow_migration.js',
  'test_telegram_viewer_core.js',
  'test_telegram_viewer_api.js',
  'test_telegram_viewer_service.js',
  'test_viewer_database_scope.js',
  'test_telegram_viewer_runtime.js',
  'test_setup_bundle.js',
  'test_dynamic_exchange_registry.js',
  'test_ccxt_exchange.js',
  'test_trade_journal_streams.js',
  'test_mcp_control_plane.js',
  'test_test_registry.js',
  'test_test_scheduler.js',
  'test_sonarcloud_export.js',
  'test_sonar_evidence.js',
  'test_exchange_acceptance.js',
  // Read-only contracts, process-local fakes, or SDK bridges on an owned port 0.
  'test_mutation_shards.js',
  'test_trading_rational.js',
  'test_trading_fx_contract.js',
  'test_exchange_contract_validation.js',
  'test_fill_quantity_contract.js',
  'test_fill_quantity_python_roundtrip.js',
  'test_exchange_order_correlation.js',
  'test_exchange_fill_identity.js',
  'test_exchange_history_coverage.js',
  'test_hyperliquid_retention.js',
  'test_entry_deadline_transport.js',
  'test_modules.js',
  'test_queue.js',
  'test_outbox_scheduler.js',
  'test_filters.js',
  'test_telegram_login.js',
  'test_tdlib_retry.js',
  'test_delivery_tracker.js',
  'test_clock_guard.js',
  'test_metrics.js',
  'test_slo_tracker.js',
  'test_audit_cli.js',
  'test_dashboard_auth.js',
  'test_monitoring_artifacts.js',
  'test_staging_e2e.js',
  'test_soak_window.js',
  'test_integration.js',
  'test_signal_contract_validation.js',
  'test_telegram_viewer_deployment.js',
  'test_supply_chain.js',
  'test_repository_governance.js',
  'test_coverage_perfektion.js',
  'test_architecture.js',
  'test_risk_acceptances.js',
  'test_frontend_quality.js',
  'test_release_artifacts.js',
  'test_complexity_budget.js',
  'test_module_coverage.js',
]);
export const MODULE_COVERAGE_SERIAL_BARRIERS = Object.freeze([
  'test_web_server.js', // Writes fixed frontend/dist response fixtures.
  'test_frontend_bundle.js', // Owns the real frontend build and compiler artifacts.
  'test_frontend_behavior.js', // Owns the frontend worker/cache resource budget.
  'test_mcp_server.js', // Selects a port before its subprocess can bind it.
]);
const parallelTests = new Set(MODULE_COVERAGE_PARALLEL_TESTS);

export function moduleCoverageConcurrency(requestedTests, environment) {
  if (requestedTests.length > 0 || environment.TSX_MODULE_COVERAGE_WORKERS === undefined) return 1;
  if (!['2', '4'].includes(environment.TSX_MODULE_COVERAGE_WORKERS)) {
    throw new Error('Module coverage workers must be 2 or 4 when explicitly enabled.');
  }
  return Number(environment.TSX_MODULE_COVERAGE_WORKERS);
}

function failedProcess(test, child, code, signal, failure, error) {
  if (failure) error(`Failed to run ${test}: ${failure.message}`);
  else if (signal) error(`${test} failed with signal ${signal}.`);
  else if (child.killed) error(`${test} timed out or was killed before successful completion.`);
  else error(`${test} failed with exit code ${code}.`);
  return Number.isInteger(code) && code > 0 ? code : 1;
}

/** Keep the original per-file runtime, environment, isolation and 120-second limit. */
export function runTestFile(test, { testsDirectory, environment, spawnImpl = spawn, error = console.error }) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl(process.execPath, ['--import', 'tsx', path.join(testsDirectory, test)], {
        cwd: path.join(testsDirectory, '..'), env: environment, stdio: 'inherit', shell: false,
        timeout: 120_000, windowsHide: true,
      });
    } catch (failure) {
      error(`Failed to run ${test}: ${failure.message}`);
      resolve(1);
      return;
    }
    let failure;
    child.once('error', cause => { failure = cause; });
    // close, not exit: observe streams and coverage flushes before releasing a slot/barrier.
    child.once('close', (code, signal) => {
      if (!failure && !signal && !child.killed && code === 0) resolve(0);
      else resolve(failedProcess(test, child, code, signal, failure, error));
    });
  });
}

async function runGroup(tests, concurrency, runTest, error) {
  let next = 0;
  let status = 0;
  async function worker() {
    while (status === 0 && next < tests.length) {
      const test = tests[next++];
      try {
        const result = await runTest(test);
        if (result !== 0 && status === 0) status = Number.isInteger(result) && result > 0 ? result : 1;
      } catch (failure) {
        error(`Failed to run ${test}: ${failure.message}`);
        if (status === 0) status = 1;
      }
    }
  }
  // A failure stops new work; already running children remain observed until close.
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return status;
}

export async function runTestSchedule(tests, { concurrency = 1, runTest, error = console.error }) {
  if (![1, 2, 4].includes(concurrency)) throw new Error('Test concurrency must be 1, 2 or 4.');
  let cursor = 0;
  while (cursor < tests.length) {
    const parallel = concurrency > 1 && parallelTests.has(tests[cursor]);
    let end = cursor + 1;
    if (parallel) while (end < tests.length && parallelTests.has(tests[end])) end++;
    const status = await runGroup(tests.slice(cursor, end), parallel ? concurrency : 1, runTest, error);
    if (status !== 0) return status;
    cursor = end;
  }
  return 0;
}
