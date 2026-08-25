import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const testEnvironment = {
  ...process.env,
  CONFIG_PATH: path.resolve(testsDirectory, '..', 'config.json.example'),
};
const allTests = [
  'test_modules.js',
  'test_logger_file.js',
  'test_queue.js',
  'test_outbox_scheduler.js',
  'test_filters.js',
  'test_config.js',
  'test_env.js',
  'test_secret_store.js',
  'test_factory_reset_paths.js',
  'test_mcp_maintenance.js',
  'test_runtime_settings.js',
  'test_telegram_login.js',
  'test_tdlib_retry.js',
  'test_dupe_blocker.js',
  'test_outbox.js',
  'test_process_lock.js',
  'test_migration_cli.js',
  'test_delivery_tracker.js',
  'test_crash_guard.js',
  'test_clock_guard.js',
  'test_backup.js',
  'test_backup_replication.js',
  'test_retention.js',
  'test_metrics.js',
  'test_dashboard_analytics.js',
  'test_slo_tracker.js',
  'test_audit_trail.js',
  'test_audit_cli.js',
  'test_dashboard_auth.js',
  'test_alert_relay.js',
  'test_monitoring_artifacts.js',
  'test_staging_e2e.js',
  'test_soak_window.js',
  'test_web_server.js',
  'test_integration.js',
  'test_signal_parser.js',
  'test_signal_contract_validation.js',
  'test_trading_core.js',
  'test_workflow_builder.js',
  'test_workflow_migration.js',
  'test_setup_bundle.js',
  'test_trading_engine.js',
  'test_trading_failures.js',
  'test_trading_credentials.js',
  'test_ccxt_exchange.js',
  'test_trading_web_control.js',
  'test_trading_analytics.js',
  'test_trade_journal_streams.js',
  'test_mcp_control_plane.js',
  'test_mcp_server.js',
  'test_supply_chain.js',
  'test_repository_governance.js',
  'test_sonarcloud_export.js',
  'test_architecture.js',
  'test_risk_acceptances.js',
  'test_frontend_quality.js',
  'test_frontend_behavior.js',
  'test_release_artifacts.js',
  'test_complexity_budget.js',
  'test_module_coverage.js',
];

const requestedTests = process.argv.slice(2);
const selectedTests = requestedTests.length > 0 ? requestedTests : allTests;
for (const test of selectedTests) {
  if (!allTests.includes(test)) {
    console.error(`Unknown test file: ${test}`);
    process.exit(2);
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(testsDirectory, test)], {
    cwd: path.join(testsDirectory, '..'),
    env: testEnvironment,
    stdio: 'inherit',
    shell: false,
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`Failed to run ${test}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `${test} failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.status}`}.`
    );
    process.exit(result.status || 1);
  }
}

console.log(`ALL ${selectedTests.length} TEST FILES PASSED!`);
