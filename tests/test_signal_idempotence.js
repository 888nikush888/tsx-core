import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-signal-idempotence-'));
try {
  await initDb(path.join(directory, 'test.db'));
  const db = getDatabase();
  await saveSignal('signal', '-1001', 1, '<signal/>', 'canonical');
  await db.exec('CREATE TABLE test_signal_reference (id TEXT REFERENCES signals(id) ON DELETE RESTRICT)');
  await db.run('INSERT INTO test_signal_reference VALUES (?)', ['signal']);
  const before = await db.get('SELECT * FROM signals WHERE id = ?', ['signal']);
  await saveSignal('signal', '-1001', 1, '<signal />', 'canonical');
  assert.deepEqual(await db.get('SELECT * FROM signals WHERE id = ?', ['signal']), before);
  await assert.rejects(saveSignal('signal', '-1001', 1, '<changed/>', 'different'), /Signal.*conflict/i);
  assert.equal((await db.all('PRAGMA foreign_key_check')).length, 0);
  console.log('Signal immutable/idempotent persistence passed.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
