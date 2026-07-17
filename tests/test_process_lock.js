import assert from 'assert';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { acquireProcessLock, ProcessLockActiveError } from '../src/process_lock.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'forwarder-process-lock-'));
const lockPath = path.join(directory, '.process_active');

try {
  console.log('1. Testing exclusive process lock acquisition...');
  const lock = await acquireProcessLock(lockPath);
  await assert.rejects(
    acquireProcessLock(lockPath),
    error => error instanceof ProcessLockActiveError && error.message.includes(String(process.pid))
  );
  await lock.release();
  const replacement = await acquireProcessLock(lockPath);
  await replacement.release();
  console.log('   -> OK');

  console.log('2. Testing safe stale-lock recovery...');
  await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, startedAt: '2000-01-01T00:00:00.000Z', token: 'stale-lock-token-1234' }), 'utf8');
  const recovered = await acquireProcessLock(lockPath);
  await recovered.release();
  console.log('   -> OK');

  console.log('3. Testing malformed locks fail closed...');
  await writeFile(lockPath, '{not-json', 'utf8');
  await assert.rejects(acquireProcessLock(lockPath), /cannot be interpreted safely/);
  console.log('   -> OK');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('ALL PROCESS LOCK TESTS PASSED!');
