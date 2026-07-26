const shardDefinitions = {
  queue: {
    mutate: ['src/queue.ts'],
    command: 'node --import tsx tests/test_queue.js',
  },
  retry: {
    mutate: ['src/tdlib_retry.ts'],
    command: 'node --import tsx tests/test_tdlib_retry.js',
  },
  schema: {
    mutate: ['src/signal_schema.ts'],
    command: 'node --import tsx tests/test_signal_parser.js && node --import tsx tests/test_signal_contract_validation.js',
  },
  'trading-risk': {
    mutate: ['src/trading_risk.ts:45-146'],
    command: 'node --import tsx tests/test_trading_core.js',
  },
};

const shardName = process.env.STRYKER_SHARD || 'queue';
const shard = shardDefinitions[shardName];
if (!shard) throw new Error(`Unknown STRYKER_SHARD ${shardName}.`);

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  mutate: shard.mutate,
  testRunner: 'command',
  commandRunner: {
    command: shard.command,
  },
  coverageAnalysis: 'off',
  incremental: true,
  incrementalFile: `reports/stryker-${shardName}${shardName === 'trading-risk' ? '-sizing-v1' : ''}-incremental.json`,
  concurrency: 1,
  timeoutMS: 10_000,
  cleanTempDir: 'always',
  tempDirName: `.stryker-tmp-${shardName}`,
  reporters: ['clear-text', 'json'],
  jsonReporter: { fileName: `reports/mutation/${shardName}.json` },
  thresholds: { high: 80, low: 70, break: 70 },
  ignorePatterns: [
    'backups',
    'coverage',
    'dist',
    'frontend',
    'logs',
    'reports',
    'scratch',
    'session_data',
    'session_files',
    'signals',
  ],
};

export default config;
