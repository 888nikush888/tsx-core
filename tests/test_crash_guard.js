import assert from 'assert';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { checkCrashLoopFiles, CrashLoopBlockedError } from '../src/crash_guard.js';

async function runTests() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'forwarder-crash-guard-'));
  try {
    await assert.rejects(checkCrashLoopFiles(stateDir, -1), /timestamp is invalid/);
    await assert.rejects(checkCrashLoopFiles(stateDir, 1, 1), /at least 2/);
    await assert.rejects(checkCrashLoopFiles(stateDir, 1, 3, 999), /at least one second/);
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
    await writeFile(path.join(stateDir, '.crash_counter'), JSON.stringify({ count: -5, lastCrash: 'invalid' }), 'utf8');
    assert.deepStrictEqual(await checkCrashLoopFiles(stateDir, 1_000_000), { count: 1, lastCrash: 1_000_000 });
    await unlink(path.join(stateDir, '.routing_active'));
    assert.deepStrictEqual(await checkCrashLoopFiles(stateDir, 1_000_001), { count: 0, lastCrash: 0 });

    await writeFile(path.join(stateDir, '.crash_blocked'), '{invalid-json', 'utf8');
    await assert.rejects(checkCrashLoopFiles(stateDir, 1_000_002), /block file cannot be read safely/);
    await unlink(path.join(stateDir, '.crash_blocked'));
    await writeFile(path.join(stateDir, '.routing_active'), 'active', 'utf8');
    await writeFile(path.join(stateDir, '.crash_counter'), '{invalid-json', 'utf8');
    await assert.rejects(checkCrashLoopFiles(stateDir, 1_000_003), /Crash counter cannot be read safely/);
    console.log('ALL CRASH-LOOP GUARD TESTS PASSED!');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
