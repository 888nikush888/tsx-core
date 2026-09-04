import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { TelegramViewerStateRepository } from '../src/telegram_viewer/state_repository.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'viewer-database-scope-'));
try {
  const databasePath = path.join(root, 'operational.db');
  const source = await open({ filename: databasePath, driver: sqlite3.Database });
  await source.exec('CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(1);');
  await source.close();
  const before = await readFile(databasePath);
  const alias = path.join(root, 'viewer_state.db');
  await link(databasePath, alias);
  for (const candidate of [databasePath, alias]) {
    const repository = new TelegramViewerStateRepository(candidate);
    await assert.rejects(repository.initialize(), /unrelated tables/);
    await assert.rejects(repository.eventCursor(), /not initialized/);
    assert.deepEqual(await readFile(databasePath), before, 'Scope rejection must precede any schema or WAL write.');
    await repository.close();
  }
  const separate = new TelegramViewerStateRepository(path.join(root, 'actual-viewer.db'));
  await separate.initialize();
  await separate.setEventCursor(12);
  assert.equal(await separate.eventCursor(), 12);
  await assert.rejects(separate.initialize(), /already initialized/);
  await separate.close();
  await separate.initialize();
  assert.equal(await separate.eventCursor(), 12);
  await separate.close();
  console.log('Viewer database scope: operational path and hard-link rejection without writes; isolated state reopens.');
} finally { await rm(root, { recursive: true, force: true }); }
