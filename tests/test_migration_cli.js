import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { acquireProcessLock } from '../src/process_lock.js';
import { mcpMaintenanceActive, registerDatabaseMaintenanceParticipant } from '../src/mcp_maintenance.js';

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'src/migration_cli.ts', 'restore', 'snapshot.db', '--wrong-confirmation'],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 }
);

assert.equal(result.status, 1, 'Migration restore CLI must fail without the exact confirmation flag.');
assert.match(result.stderr, /Usage: node dist\/migration_cli\.js restore/);

async function seed(file, value) {
  const database = await open({ filename: file, driver: sqlite3.Database });
  try { await database.exec('CREATE TABLE proof (value TEXT)'); await database.run('INSERT INTO proof VALUES (?)', value); }
  finally { await database.close(); }
}

function startRestore(snapshot, target) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/migration_cli.ts', 'restore', snapshot, '--confirm-restore-pre-migration'], {
    cwd: process.cwd(), env: { ...process.env, FORWARDER_DB_PATH: target }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  return { child, done: once(child, 'exit').then(([code]) => ({ code, output })) };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'migration-cli-fixture-'));
const snapshot = path.join(root, 'snapshot.db');
const target = path.join(root, 'target.db');
try {
  await seed(snapshot, 'snapshot');
  const absent = startRestore(snapshot, target);
  assert.equal((await absent.done).code, 0, 'The actual CLI must acquire its own lease and prove the initially absent target.');
  assert.deepEqual(await readFile(target), await readFile(snapshot));
  const owner = await acquireProcessLock(path.join(root, '.process_active'));
  try {
    const rejected = await startRestore(snapshot, target).done;
    assert.equal(rejected.code, 1);
    assert.match(rejected.output, /already active/i);
  } finally { await owner.release(); }

  const participant = await registerDatabaseMaintenanceParticipant(target);
  const database = await open({ filename: target, driver: sqlite3.Database });
  await participant.afterOpen();
  const active = startRestore(snapshot, target);
  try {
    const deadline = Date.now() + 5000;
    while (!await mcpMaintenanceActive(target)) {
      assert.ok(Date.now() < deadline, 'CLI did not publish its bounded maintenance request.');
      assert.equal(active.child.exitCode, null);
      await delay(20);
    }
    await delay(1250);
    assert.equal(active.child.exitCode, null, 'A fixed one-second delay cannot authorize the CLI while its native participant remains open.');
    await assert.rejects(registerDatabaseMaintenanceParticipant(target), /before SQLite open/);
    await participant.closeStarted();
    await database.close();
    await participant.closeSucceeded();
    const restored = await active.done;
    assert.equal(restored.code, 0, restored.output);
    assert.equal(await mcpMaintenanceActive(target), false);
    assert.ok(!(await readdir(root)).includes('.process_active'));
  } finally {
    await database.close().catch(() => undefined);
    if (active.child.exitCode === null && active.child.signalCode === null) { active.child.kill('SIGKILL'); await active.done; }
  }
} finally { await rm(root, { recursive: true, force: true }); }

console.log('Migration CLI: confirmation, actual offline lease, active-owner refusal and delayed real handle-close acknowledgement passed.');
