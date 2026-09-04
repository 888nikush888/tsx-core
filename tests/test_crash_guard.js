import assert from 'assert';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { checkCrashLoopFiles, CrashLoopBlockedError } from '../src/crash_guard.js';
import { acquireProcessLock, ProcessLockActiveError, ProcessLockRecoveryRequiredError, withProcessLockOwner } from '../src/process_lock.js';

async function testScopeAndLifetime(stateDir, owner) {
  const original = await readFile(path.join(stateDir, '.crash_counter'), 'utf8');
  const foreignDir = path.join(stateDir, 'foreign-db');
  const foreign = await acquireProcessLock(path.join(foreignDir, '.process_active'));
  try {
    await assert.rejects(checkCrashLoopFiles(stateDir, { ...owner }), /ownership capability/);
    await assert.rejects(checkCrashLoopFiles(stateDir, foreign), /different realpath scopes/);
    assert.equal(await readFile(path.join(stateDir, '.crash_counter'), 'utf8'), original);
    const ownWork = withProcessLockOwner(foreign, foreignDir, async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'counter-finished';
    });
    const releasing = foreign.release();
    assert.equal(await ownWork, 'counter-finished', 'Release must wait for already authorized counter work.');
    await releasing;
    await assert.rejects(checkCrashLoopFiles(foreignDir, foreign), /was released/);
    assert.deepEqual(await readdir(foreignDir), [], 'Rejected released ownership must not create counter state.');
  } finally {
    await foreign.release();
  }
  const alias = path.join(stateDir, '.', 'unused', '..');
  await checkCrashLoopFiles(alias, owner, 10001);
}

async function testNonFileStatePaths(stateDir) {
  for (const file of ['.routing_active', '.crash_counter', '.crash_blocked']) {
    const directory = path.join(stateDir, `wrong-type-${file}`);
    const owner = await acquireProcessLock(path.join(directory, '.process_active'));
    try {
      await mkdir(path.join(directory, file));
      await assert.rejects(checkCrashLoopFiles(directory, owner), /not a regular, non-symlink file/);
      assert.ok((await readdir(directory)).includes(file), 'Rejected paths must not be removed or converted.');
    } finally {
      await owner.release();
    }
  }
}

function startFixture(directory, mode) {
  const fixture = fileURLToPath(new URL('./fixtures/crash_guard_owner_child.js', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, directory, mode], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child fixture did not reach its boundary.')), 10000);
    child.once('message', message => { clearTimeout(timeout); resolve(message); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Child fixture exited before its boundary.')); });
  });
  return { child, ready };
}

async function killFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

async function testHardCrashes(stateDir) {
  for (const mode of ['counter-paused', 'block-paused']) {
    const directory = path.join(stateDir, mode);
    await mkdir(directory);
    const before = JSON.stringify({ count: 2, lastCrash: 123000 });
    await writeFile(path.join(directory, '.crash_counter'), before);
    await writeFile(path.join(directory, '.routing_active'), 'active');
    const { child, ready } = startFixture(directory, mode);
    try {
      assert.equal((await ready).state, mode);
      await assert.rejects(acquireProcessLock(path.join(directory, '.process_active')), ProcessLockActiveError);
      await killFixture(child);
      const abandoned = await readFile(path.join(directory, '.process_active'), 'utf8');
      await assert.rejects(acquireProcessLock(path.join(directory, '.process_active')), ProcessLockRecoveryRequiredError);
      assert.equal(await readFile(path.join(directory, '.process_active'), 'utf8'), abandoned);
      if (mode === 'counter-paused') assert.equal(await readFile(path.join(directory, '.crash_counter'), 'utf8'), before);
      // Explicit reviewed recovery in this isolated, test-owned directory only.
      await unlink(path.join(directory, '.process_active'));
      const recovered = await acquireProcessLock(path.join(directory, '.process_active'));
      try {
        await assert.rejects(checkCrashLoopFiles(directory, recovered, 123002), CrashLoopBlockedError);
        assert.equal(JSON.parse(await readFile(path.join(directory, '.crash_blocked'), 'utf8')).count, 3);
      } finally {
        await recovered.release();
      }
    } finally {
      await killFixture(child);
    }
  }
}

async function runTests() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'forwarder-crash-guard-'));
  let owner;
  try {
    await assert.rejects(checkCrashLoopFiles(stateDir), /ownership capability/i,
      'Missing process ownership must not create/reset crash files.');
    owner = await acquireProcessLock(path.join(stateDir, '.process_active'));
    const check = (now, maximumCrashes, windowMs) => checkCrashLoopFiles(stateDir, owner, now, maximumCrashes, windowMs);
    await assert.rejects(check(-1), /timestamp is invalid/);
    await assert.rejects(check(1, 1), /at least 2/);
    await assert.rejects(check(1, 3, 999), /at least one second/);
    assert.deepStrictEqual(await check(10_000), { count: 0, lastCrash: 0 });
    await testScopeAndLifetime(stateDir, owner);
    await testNonFileStatePaths(stateDir);
    await testHardCrashes(stateDir);
    await writeFile(path.join(stateDir, '.routing_active'), 'active', 'utf8');
    assert.deepStrictEqual(await check(20_000), { count: 1, lastCrash: 20_000 });
    assert.deepStrictEqual(await check(21_000), { count: 2, lastCrash: 21_000 });
    await assert.rejects(
      check(22_000),
      error => error instanceof CrashLoopBlockedError && error.count === 3
    );
    const block = JSON.parse(await readFile(path.join(stateDir, '.crash_blocked'), 'utf8'));
    assert.strictEqual(block.count, 3);
    await assert.rejects(check(1_000_000), CrashLoopBlockedError, 'Block must persist outside the crash window');

    await unlink(path.join(stateDir, '.crash_blocked'));
    await writeFile(path.join(stateDir, '.crash_counter'), JSON.stringify({ count: -5, lastCrash: 'invalid' }), 'utf8');
    assert.deepStrictEqual(await check(1_000_000), { count: 1, lastCrash: 1_000_000 });
    await writeFile(path.join(stateDir, '.crash_counter'), JSON.stringify({ count: 2, lastCrash: 'invalid' }), 'utf8');
    assert.deepStrictEqual(await check(1_000_001), { count: 1, lastCrash: 1_000_001 });
    await writeFile(path.join(stateDir, '.crash_counter'), JSON.stringify({ count: 'invalid', lastCrash: 1_000_001 }), 'utf8');
    assert.deepStrictEqual(await check(1_000_002), { count: 1, lastCrash: 1_000_002 });
    await unlink(path.join(stateDir, '.routing_active'));
    assert.deepStrictEqual(await check(1_000_003), { count: 0, lastCrash: 0 });

    await writeFile(path.join(stateDir, '.crash_blocked'), '{invalid-json', 'utf8');
    await assert.rejects(check(1_000_004), /block file cannot be read safely/);
    await unlink(path.join(stateDir, '.crash_blocked'));
    await writeFile(path.join(stateDir, '.routing_active'), 'active', 'utf8');
    await writeFile(path.join(stateDir, '.crash_counter'), '{invalid-json', 'utf8');
    await assert.rejects(check(1_000_005), /Crash counter cannot be read safely/);

    await unlink(path.join(stateDir, '.crash_counter'));
    await writeFile(path.join(stateDir, '.crash_counter'), JSON.stringify({ count: 2, lastCrash: 2_000_000 }), 'utf8');
    const simultaneousBlocks = await Promise.allSettled([
      check(2_000_001),
      check(2_000_001)
    ]);
    assert.ok(simultaneousBlocks.every(result =>
      result.status === 'rejected' && result.reason instanceof CrashLoopBlockedError
    ), `Concurrent crash detections must converge on the same persistent block: ${simultaneousBlocks.map(result =>
      result.status === 'rejected' ? `${result.reason.name}: ${result.reason.message}` : `fulfilled: ${JSON.stringify(result.value)}`
    ).join(' | ')}`);

    const lockFile = path.join(stateDir, '.crash_guard.lock');
    await writeFile(lockFile, 'held', 'utf8');
    await assert.rejects(check(2_000_002), /Legacy crash-guard lock.*startup is blocked to protect state integrity/);
    assert.equal(await readFile(lockFile, 'utf8'), 'held', 'Legacy artifacts are preserved, not aged out or silently migrated.');
    await unlink(lockFile);
    console.log('ALL CRASH-LOOP GUARD TESTS PASSED!');
  } finally {
    if (owner) await owner.release();
    await rm(stateDir, { recursive: true, force: true });
  }
}

await runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
