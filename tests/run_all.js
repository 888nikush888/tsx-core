import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const allTests = [
  'test_modules.js',
  'test_queue.js',
  'test_filters.js',
  'test_config.js',
  'test_tdlib_retry.js',
  'test_dupe_blocker.js',
  'test_outbox.js',
  'test_delivery_tracker.js',
  'test_crash_guard.js',
  'test_backup.js',
  'test_metrics.js',
  'test_web_server.js',
  'test_integration.js',
  'test_signal_parser.js',
  'test_supply_chain.js',
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
    env: process.env,
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
