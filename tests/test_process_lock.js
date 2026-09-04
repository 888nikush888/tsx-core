import assert from 'assert';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { acquireProcessLock, assertProcessLockOwner, ProcessLockActiveError, ProcessLockRecoveryRequiredError } from '../src/process_lock.js';
import { promises as fs } from 'node:fs';

async function staleReadSwapCannotDeleteNewOwner(lockPath, stale) {
  const replacement = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: 'new-live-owner-token-1234' });
  await writeFile(lockPath, stale, 'utf8');
  const read = fs.readFile;
  let swapped = false;
  fs.readFile = async (...args) => {
    const result = await read(...args);
    if (args[0] === lockPath && !swapped) {
      swapped = true;
      await writeFile(lockPath, replacement, 'utf8');
    }
    return result;
  };
  try {
    await assert.rejects(acquireProcessLock(lockPath), ProcessLockRecoveryRequiredError);
    assert.equal(await read(lockPath, 'utf8'), replacement, 'A stale read must never delete a subsequent live owner.');
  } finally {
    fs.readFile = read;
  }
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'forwarder-process-lock-'));
const lockPath = path.join(directory, '.process_active');

try {
  console.log('1. Testing exclusive process lock acquisition...');
  const lock = await acquireProcessLock(lockPath);
  await assertProcessLockOwner(lock, directory);
  await assert.rejects(assertProcessLockOwner({ ...lock }, directory), /ownership capability/);
  await assert.rejects(
    acquireProcessLock(lockPath),
    error => error instanceof ProcessLockActiveError && error.message.includes(String(process.pid))
  );
  await lock.release();
  await assert.rejects(assertProcessLockOwner(lock, directory), /was released/);
  const replacement = await acquireProcessLock(lockPath);
  await replacement.release();
  console.log('   -> OK');

  console.log('2. Testing stale-lock recovery requires explicit ownership review...');
  const stale = JSON.stringify({ pid: 2_147_483_647, startedAt: '2000-01-01T00:00:00.000Z', token: 'stale-lock-token-1234' });
  await writeFile(lockPath, stale, 'utf8');
  const attempts = await Promise.allSettled([acquireProcessLock(lockPath), acquireProcessLock(lockPath)]);
  assert.ok(attempts.every(result => result.status === 'rejected' && result.reason instanceof ProcessLockRecoveryRequiredError));
  assert.equal(await readFile(lockPath, 'utf8'), stale, 'Concurrent stale readers must never remove or replace the lock.');
  await staleReadSwapCannotDeleteNewOwner(lockPath, stale);
  await rm(lockPath, { force: true }); // Explicit cleanup of this test-owned temporary fixture only.
  console.log('   -> OK');

  console.log('3. Testing ownership changes fail closed...');
  const guarded = await acquireProcessLock(lockPath);
  await writeFile(lockPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: 'ownership-changed-token-1234'
  }), 'utf8');
  await assert.rejects(guarded.release(), /ownership changed/);
  await rm(lockPath, { force: true });
  console.log('   -> OK');

  console.log('4. Testing malformed locks fail closed...');
  await writeFile(lockPath, '{not-json', 'utf8');
  await assert.rejects(acquireProcessLock(lockPath), /cannot be interpreted safely/);
  console.log('   -> OK');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('ALL PROCESS LOCK TESTS PASSED!');
