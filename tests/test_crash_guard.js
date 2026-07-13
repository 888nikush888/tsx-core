import assert from 'assert';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { checkCrashLoopFiles, CrashLoopBlockedError } from '../src/crash_guard.js';

async function runTests() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'forwarder-crash-guard-'));
  try {
    assert.deepStrictEqual(await checkCrashLoopFiles(stateDir, 10_000), { count: 0, lastCrash: 0 });
    await writeFile(path.join(stateDir, '.routing_active'), 'active', 'utf8');
    assert.deepStrictEqual(await checkCrashLoopFiles(stateDir, 20_000), { count: 1, lastCrash: 20_000 });
    assert.deepStrictEqual(await checkCrashLoopFiles(stateDir, 21_000), { count: 2, lastCrash: 21_000 });
    await assert.rejects(
      checkCrashLoopFiles(stateDir, 22_000),
      error => error instanceof CrashLoopBlockedError && error.count === 3
    );
    const block = JSON.parse(await readFile(path.join(stateDir, '.crash_blocked'), 'utf8'));
    assert.strictEqual(block.count, 3);
    await assert.rejects(checkCrashLoopFiles(stateDir, 1_000_000), CrashLoopBlockedError, 'Block must persist outside the crash window');

    await unlink(path.join(stateDir, '.crash_blocked'));
    await unlink(path.join(stateDir, '.routing_active'));
    assert.deepStrictEqual(await checkCrashLoopFiles(stateDir, 1_000_001), { count: 0, lastCrash: 0 });
    console.log('ALL CRASH-LOOP GUARD TESTS PASSED!');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
