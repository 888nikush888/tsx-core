import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import {
  closeDb,
  expectedDatabaseMigrations,
  getDatabase,
  initDb,
  LATEST_SCHEMA_VERSION,
} from '../src/db.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fallback-policy-migration-'));
const databasePath = path.join(directory, 'version-21.db');
try {
  const fixture = await open({ filename: databasePath, driver: sqlite3.Database });
  try {
    await fixture.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
      );
      CREATE TABLE workflow_execution_paths (
        id TEXT PRIMARY KEY,
        workflow_revision_id TEXT NOT NULL,
        route_group_key TEXT,
        fallback_rank INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE trading_fallback_candidates (
        fallback_run_id TEXT NOT NULL,
        rank INTEGER NOT NULL,
        execution_path_id TEXT NOT NULL,
        PRIMARY KEY(fallback_run_id, rank)
      );
      INSERT INTO workflow_execution_paths VALUES ('primary', 'revision', 'route', 0);
      INSERT INTO workflow_execution_paths VALUES ('fallback', 'revision', 'route', 1);
      INSERT INTO workflow_execution_paths VALUES ('direct', 'revision', 'direct-route', 0);
      INSERT INTO trading_fallback_candidates VALUES ('run', 0, 'primary');
      INSERT INTO trading_fallback_candidates VALUES ('run', 1, 'fallback');
    `);
    for (const migration of expectedDatabaseMigrations().slice(0, 21)) {
      await fixture.run(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, 1)',
        migration.version,
        migration.name,
        migration.checksum,
      );
    }
  } finally {
    await fixture.close();
  }

  await initDb(databasePath);
  assert.equal(
    (await getDatabase().get('SELECT MAX(version) AS version FROM schema_migrations')).version,
    LATEST_SCHEMA_VERSION,
  );
  assert.deepEqual(
    await getDatabase().all('SELECT id, fallback_on_json AS fallbackOn FROM workflow_execution_paths ORDER BY id'),
    [
      { id: 'direct', fallbackOn: '[]' },
      { id: 'fallback', fallbackOn: '[]' },
      { id: 'primary', fallbackOn: '["SYMBOL_UNAVAILABLE"]' },
    ],
  );
  assert.deepEqual(
    await getDatabase().all(
      'SELECT rank, fallback_on_json AS fallbackOn FROM trading_fallback_candidates ORDER BY rank',
    ),
    [
      { rank: 0, fallbackOn: '["SYMBOL_UNAVAILABLE"]' },
      { rank: 1, fallbackOn: '[]' },
    ],
  );
  assert.deepEqual(await getDatabase().all('PRAGMA foreign_key_check'), []);
  console.log('Configurable fallback migration test passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
