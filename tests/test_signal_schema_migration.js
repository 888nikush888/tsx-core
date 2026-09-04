import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { completeLegacyIngressFixture } from './fixtures/legacy_ingress_schema.js';
import {
  closeDb,
  expectedDatabaseMigrations,
  getDatabase,
  initDb,
  LATEST_SCHEMA_VERSION,
} from '../src/db.js';
import { BUILTIN_SIGNAL_CONTRACTS, signalContractDefinitionSha256 } from '../src/signal_contract.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-signal-schema-migration-'));
const databasePath = path.join(directory, 'version-22.db');
const definition = structuredClone(
  BUILTIN_SIGNAL_CONTRACTS.find(contract => contract.id === 'standard').definition,
);
const definitionJson = JSON.stringify(definition);
const definitionSha256 = signalContractDefinitionSha256(definition);

try {
  const fixture = await open({ filename: databasePath, driver: sqlite3.Database });
  try {
    await fixture.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL
      );
      -- The v22 fixture must also contain the tables touched by subsequent
      -- identity migrations; a missing trading table is real database damage.
      CREATE TABLE trading_accounts (id TEXT PRIMARY KEY, exchange TEXT NOT NULL);
      CREATE TABLE trading_trade_intents (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE trading_orders (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, exchange_order_id TEXT, response_json TEXT, role TEXT NOT NULL DEFAULT 'entry'
      );
      CREATE TABLE trading_positions (id TEXT PRIMARY KEY, account_id TEXT, status TEXT, updated_at INTEGER);
      CREATE TABLE trading_signal_contract_versions (
        id TEXT PRIMARY KEY,
        definition_json TEXT NOT NULL,
        definition_sha256 TEXT NOT NULL
      );
      CREATE TABLE trading_signal_schemas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        parser_schema TEXT NOT NULL,
        contract_version_id TEXT,
        template_name TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    await fixture.run(
      'INSERT INTO trading_signal_contract_versions VALUES (?, ?, ?)',
      'legacy:v1', definitionJson, definitionSha256,
    );
    await fixture.run(
      `INSERT INTO trading_signal_schemas (
        id, name, description, parser_schema, contract_version_id, template_name,
        enabled, created_at, updated_at
      ) VALUES (?, ?, '', 'standard', ?, ?, 1, 1, 1)`,
      'legacy-schema', 'Legacy schema', 'legacy:v1', 'legacy-template',
    );
    await completeLegacyIngressFixture(fixture);
    for (const migration of expectedDatabaseMigrations().slice(0, 22)) {
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
    await getDatabase().get(
      `SELECT definition_json AS definitionJson, definition_sha256 AS definitionSha256
       FROM trading_signal_schemas WHERE id = 'legacy-schema'`,
    ),
    { definitionJson, definitionSha256 },
  );
  console.log('Builder signal schema migration test passed.');
} finally {
  await closeDb().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
