import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const configUrl = new URL('../stryker.config.mjs', import.meta.url);
const runnerPath = fileURLToPath(new URL('../scripts/run_mutation_shards.js', import.meta.url));
const shardSources = {
  queue: 'src/queue.ts', retry: 'src/tdlib_retry.ts',
  schema: 'src/signal_schema.ts', 'trading-risk': 'src/trading_risk.ts',
};

function loadConfig(shard, force) {
  const code = `import config from ${JSON.stringify(configUrl.href)}; console.log(JSON.stringify(config));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, '--', ...(force ? ['--force'] : [])], {
    env: { ...process.env, STRYKER_SHARD: shard }, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function testActualLoadedConfig() {
  for (const [shard, source] of Object.entries(shardSources)) {
    for (const force of [false, true]) {
      const config = loadConfig(shard, force);
      assert.deepEqual(config.mutate, [source], 'Critical source coverage must not depend on historical line numbers.');
      assert.equal(config.incremental, !force, '--force must disable historical report reuse in the actual loaded config.');
      assert.deepEqual(config.thresholds, { high: 80, low: 70, break: 70 });
      assert.equal(config.timeoutMS, 10_000);
      assert.equal(config.concurrency, 1);
      assert.equal(config.coverageAnalysis, 'off');
      assert.equal(config.testRunner, 'command');
      assert.deepEqual(config.reporters, ['clear-text', 'json']);
      assert.deepEqual(config.jsonReporter, { fileName: `reports/mutation/${shard}.json` });
      assert.equal(config.cleanTempDir, 'always');
      assert.ok(config.commandRunner.command.startsWith('node --import tsx tests/'));
    }
  }
  assert.equal(loadConfig('trading-risk', true).commandRunner.command,
    'node --import tsx tests/test_trading_core.js && node --import tsx tests/test_trading_leverage_tiers.js');
}

function testCiUsesOnlyFreshMutationEvidence() {
  const lines = readFileSync(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8').split(/\r?\n/);
  const start = lines.indexOf('  mutation:');
  assert.ok(start >= 0, 'The blocking mutation job must exist.');
  const nextJob = lines.findIndex((line, index) => index > start && /^ {2}[a-zA-Z][\w-]*:/.test(line));
  const job = lines.slice(start, nextJob < 0 ? undefined : nextJob).join('\n');
  assert.match(job, /run: npm run test:mutation -- \$\{\{ matrix\.shard \}\} --force(?:\n|$)/);
  assert.match(job, /timeout-minutes: 15/);
  assert.match(job, /shard: \[queue, retry, schema, trading-risk\]/);
  assert.doesNotMatch(job, /actions\/cache@|restore-keys:|incremental\.json/,
    'Historical mutation caches must not be restored or uploaded as current gate evidence.');
  assert.equal((job.match(/^\s+path:/gm) ?? []).length, 1);
  assert.match(job, /path: reports\/mutation\/\$\{\{ matrix\.shard \}\}\.json(?:\n|$)/);
  assert.match(job, /if-no-files-found: error/);
}

function capturedRun(runMutationShards, argumentsList, outcomes = []) {
  const calls = [];
  const logs = [];
  const errors = [];
  const status = runMutationShards(argumentsList, {
    environment: { PATH: 'fixture-path', STRYKER_SHARD: 'ambient-shard', FIXTURE: 'preserved' },
    spawnImpl: (...args) => { calls.push(args); return outcomes[calls.length - 1] ?? { status: 0 }; },
    log: value => logs.push(value), error: value => errors.push(value),
  });
  return { status, calls, logs, errors };
}

function testRunnerSelectionAndBudgets(runMutationShards) {
  const defaultRun = capturedRun(runMutationShards, []);
  assert.equal(defaultRun.status, 0);
  assert.deepEqual(defaultRun.calls.map(([, , options]) => options.env.STRYKER_SHARD), Object.keys(shardSources));
  const forced = capturedRun(runMutationShards, ['--force', 'trading-risk']);
  assert.equal(forced.status, 0);
  assert.equal(forced.calls.length, 1);
  const [executable, args, options] = forced.calls[0];
  assert.equal(executable, process.execPath, 'The runner must preserve the selected Node runtime.');
  assert.deepEqual(args, [path.resolve('node_modules/@stryker-mutator/core/bin/stryker.js'), 'run', '--force']);
  assert.equal(options.cwd, process.cwd());
  assert.equal(options.env.STRYKER_SHARD, 'trading-risk');
  assert.equal(options.env.FIXTURE, 'preserved');
  assert.equal(options.env.PATH, 'fixture-path');
  assert.equal(options.timeout, 20 * 60_000);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, 'inherit');
  const ordinary = capturedRun(runMutationShards, ['retry']);
  assert.equal(ordinary.calls[0][1].includes('--force'), false);
  assert.match(forced.logs.at(-1), /ALL 1 MUTATION SHARDS PASSED/);
  assert.deepEqual(forced.errors, []);
}

function testFailureCannotTurnIntoSuccess(runMutationShards) {
  const unknown = capturedRun(runMutationShards, ['not-a-shard']);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.calls.length, 0);
  assert.match(unknown.errors[0], /Unknown mutation shard/);
  for (const [outcome, expected] of [
    [{ status: 7 }, 7], [{ status: null }, 1],
    [{ status: null, error: new Error('fixture timeout') }, 1],
  ]) {
    const result = capturedRun(runMutationShards, ['queue', 'trading-risk'], [outcome]);
    assert.equal(result.status, expected);
    assert.equal(result.calls.length, 1, 'Do not advance to later shards after a failed or timed-out shard.');
    assert.equal(result.logs.some(value => value.includes('PASSED')), false);
    assert.equal(result.errors.length, 1);
  }
  const processResult = spawnSync(process.execPath, [runnerPath, 'not-a-shard'], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  assert.equal(processResult.status, 2);
  assert.match(processResult.stderr, /Unknown mutation shard/);
}

testActualLoadedConfig();
testCiUsesOnlyFreshMutationEvidence();
const { runMutationShards } = await import('../scripts/run_mutation_shards.js');
testRunnerSelectionAndBudgets(runMutationShards);
testFailureCannotTurnIntoSuccess(runMutationShards);
console.log('Mutation shard selection, fresh evidence and unchanged budget tests passed.');
