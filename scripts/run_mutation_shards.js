import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const supportedShards = ['queue', 'retry', 'schema', 'trading-risk'];

export function runMutationShards(argumentsList, {
  spawnImpl = spawnSync, log = console.log, error = console.error, environment = process.env,
} = {}) {
  const force = argumentsList.includes('--force');
  const requestedShards = argumentsList.filter(argument => argument !== '--force');
  const shards = requestedShards.length > 0 ? requestedShards : supportedShards;
  const unknown = shards.filter(shard => !supportedShards.includes(shard));

  if (unknown.length > 0) {
    error(`Unknown mutation shard(s): ${unknown.join(', ')}`);
    return 2;
  }

  const strykerBinary = path.resolve('node_modules/@stryker-mutator/core/bin/stryker.js');
  for (const shard of shards) {
    log(`=== Mutation shard: ${shard} ===`);
    const result = spawnImpl(
      process.execPath,
      [strykerBinary, 'run', ...(force ? ['--force'] : [])],
      {
        cwd: process.cwd(),
        env: { ...environment, STRYKER_SHARD: shard },
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
        timeout: 20 * 60_000,
      }
    );
    if (result.error) {
      error(`Mutation shard ${shard} failed to execute: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) {
      error(`Mutation shard ${shard} failed with exit code ${result.status}.`);
      return result.status || 1;
    }
  }

  log(`ALL ${shards.length} MUTATION SHARDS PASSED!`);
  return 0;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = runMutationShards(process.argv.slice(2));
}
