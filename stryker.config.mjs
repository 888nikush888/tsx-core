/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  mutate: ['src/queue.ts', 'src/tdlib_retry.ts', 'src/signal_schema.ts'],
  testRunner: 'command',
  commandRunner: {
    command: 'node tests/run_all.js test_queue.js test_tdlib_retry.js test_signal_parser.js',
  },
  coverageAnalysis: 'off',
  incremental: true,
  concurrency: 2,
  timeoutMS: 20_000,
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 80, low: 70, break: 70 },
  ignorePatterns: [
    'backups',
    'coverage',
    'dist',
    'frontend',
    'logs',
    'reports',
    'session_data',
    'session_files',
    'signals',
  ],
};

export default config;
