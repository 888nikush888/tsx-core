import { spawnSync } from 'node:child_process';
import path from 'node:path';

const supportedShards = ['queue', 'retry', 'schema'];
const argumentsList = process.argv.slice(2);
const force = argumentsList.includes('--force');
const requestedShards = argumentsList.filter(argument => argument !== '--force');
const shards = requestedShards.length > 0 ? requestedShards : supportedShards;
const unknown = shards.filter(shard => !supportedShards.includes(shard));

if (unknown.length > 0) {
  console.error(`Unknown mutation shard(s): ${unknown.join(', ')}`);
  process.exit(2);
}

const strykerBinary = path.resolve('node_modules/@stryker-mutator/core/bin/stryker.js');
for (const shard of shards) {
  console.log(`=== Mutation shard: ${shard} ===`);
  const result = spawnSync(
    process.execPath,
    [strykerBinary, 'run', ...(force ? ['--force'] : [])],
    {
      cwd: process.cwd(),
      env: { ...process.env, STRYKER_SHARD: shard },
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      timeout: 20 * 60_000,
    }
  );
  if (result.error) {
    console.error(`Mutation shard ${shard} failed to execute: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Mutation shard ${shard} failed with exit code ${result.status}.`);
    process.exit(result.status || 1);
  }
}

console.log(`ALL ${shards.length} MUTATION SHARDS PASSED!`);
