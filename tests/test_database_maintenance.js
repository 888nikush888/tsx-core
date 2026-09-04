import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { initDb, closeDb, getDatabase } from '../src/db.js';
import { acquireProcessLock } from '../src/process_lock.js';
import { beginMcpSharedMaintenance } from '../src/mcp_maintenance.js';

async function records(directory) {
  const root = path.join(directory, '.mcp-participants');
  const files = await readdir(root);
  return Promise.all(files.filter(file => file.endsWith('.json')).map(async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))));
}

async function successfulClosure(directory) {
  const file = path.join(directory, 'live.db');
  const owner = await acquireProcessLock(path.join(directory, '.process_active'));
  let lease;
  try {
    await initDb(file);
    assert.equal((await records(directory))[0].state, 'open');
    lease = await beginMcpSharedMaintenance('fixture restore', file, owner, { timeoutMs: 3000 });
    let resolved = false;
    const waiting = lease.waitForQuiescence().then(() => { resolved = true; });
    await delay(80);
    assert.equal(resolved, false, 'Publishing a marker or waiting a fixed interval does not prove native handle closure.');
    await closeDb();
    await waiting;
    await lease.assertQuiescent();
    assert.equal((await records(directory))[0].state, 'closed');
    await assert.rejects(initDb(file), /maintenance.*active/i, 'Reinitialization must refuse before opening SQLite.');
    await lease.release();
    await initDb(file);
    await closeDb();
  } finally {
    await closeDb();
    await lease?.release();
    await owner.release();
  }
}

async function failedNativeClosure(directory) {
  const file = path.join(directory, 'live.db');
  const owner = await acquireProcessLock(path.join(directory, '.process_active'));
  let lease;
  let native;
  let originalClose;
  try {
    await initDb(file);
    native = getDatabase().getDatabaseInstance();
    originalClose = native.close;
    native.close = callback => { queueMicrotask(() => callback(new Error('native close failed fixture'))); return native; };
    lease = await beginMcpSharedMaintenance('failed close fixture', file, owner, { timeoutMs: 180 });
    await assert.rejects(closeDb(), /native close failed/);
    assert.equal((await records(directory))[0].state, 'close_failed');
    await assert.rejects(lease.waitForQuiescence(), /deadline expired/);
    assert.throws(() => getDatabase(), /not initialized/i, 'A failed closing handle must not remain generally usable.');
    await assert.rejects(initDb(file), /already initialized/i, 'Retained native handle prevents silently opening a second connection.');
    native.close = originalClose;
    await closeDb();
    assert.equal((await records(directory))[0].state, 'closed');
    await lease.release();
    await initDb(file);
    await closeDb();
  } finally {
    if (native && originalClose) native.close = originalClose;
    await closeDb();
    await lease?.release();
    await owner.release();
  }
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-database-maintenance-'));
try {
  await successfulClosure(path.join(directory, 'success'));
  await failedNativeClosure(path.join(directory, 'failure'));
  console.log('Real SQLite participant registration, native closure acknowledgement, timeout and failed-close retry passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
