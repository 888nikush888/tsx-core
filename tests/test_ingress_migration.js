import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, getAiUsage, initDb, listOutboxTasks, recoverInterruptedOutboxTasks, reserveAiUsage } from '../src/db.js';
import { dropFxSchema } from './fixtures/fx_schema.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-ingress-migration-'));
const databasePath = path.join(directory, 'v33.db');
try {
  await initDb(databasePath);
  // Reconstitute the complete immediately preceding schema, retaining all unrelated migrations.
  await getDatabase().exec(`${dropFxSchema}
    DROP TRIGGER trading_kraken_occurrence_insert;
    DROP TABLE trading_fill_quantity_evidence;
    DROP TABLE trading_kraken_cashleg_evidence;
    DROP TABLE trading_kraken_log_occurrences;
    DROP TABLE trading_order_identity_bindings;
    DROP TABLE trading_account_baseline_bindings;
    DROP TABLE trading_account_mode_observations;
    DROP TABLE trading_account_log_consumers;
    DROP TABLE trading_account_log_records;
    DROP TABLE trading_account_log_receipts;
    DROP TABLE trading_account_log_checkpoints;
    DROP TABLE trading_risk_current;
    DROP TABLE trading_risk_observations;
    DROP TABLE trading_risk_contracts;
    DROP TRIGGER trading_accounting_fill_insert;
    DROP TRIGGER trading_accounting_fill_update;
    DROP TRIGGER trading_accounting_order_update;
    DROP TRIGGER trading_accounting_position_insert;
    DROP TRIGGER trading_accounting_binding_insert;
    DROP TRIGGER trading_accounting_valuation_insert;
    DROP TRIGGER trading_accounting_conflict_insert;
    DROP TABLE trading_accounting_projection_evidence;
    DROP TABLE trading_accounting_projections;
    DROP TABLE trading_accounting_pending;
    DROP INDEX idx_money_events_intent;
    ALTER TABLE trading_fills DROP COLUMN account_fingerprint;
    ALTER TABLE trading_fills DROP COLUMN accounting_json;
    ALTER TABLE trading_fills DROP COLUMN accounting_conflict;
    ALTER TABLE trading_positions DROP COLUMN ledger_realized_pnl;
    ALTER TABLE trading_positions DROP COLUMN accounting_status;
    ALTER TABLE trading_positions DROP COLUMN reporting_currency;
    DROP TABLE trading_money_conflicts;
    DROP TABLE trading_money_valuations;
    DROP TABLE trading_money_events;
    DROP TABLE trading_money_bindings;
    DROP TABLE incoming_work;
    DROP TABLE incoming_album_groups;
    DROP TABLE signal_parser_attempts;
    DROP TABLE ai_usage_reservations;
    DROP TABLE ai_usage_legacy;
    ALTER TABLE signals DROP COLUMN workflow_revision_id;
    ALTER TABLE pending_tasks DROP COLUMN workflow_revision_id;
    ALTER TABLE pending_tasks DROP COLUMN ingress_work_id;
    DELETE FROM schema_migrations WHERE version >= 34;
    INSERT INTO ai_usage_daily VALUES ('2026-09-01', 4, 300, 1200, 1);
    INSERT INTO incoming_messages (chat_id, message_id, status, created_at)
      VALUES ('-1001', 1, 'received', 1);
    INSERT INTO pending_tasks (id, type, chat_id, message_id, added_at, status, updated_at)
      VALUES ('unproven', 'single', '-1001', 1, 1, 'pending', 1),
             ('interrupted-send', 'single', '-1001', 2, 1, 'sending', 1);
  `);
  await closeDb();
  await initDb(databasePath);
  assert.deepEqual(await getAiUsage('2026-09-01'), { requestCount: 4, usedTokens: 300, reservedTokens: 1200 });
  assert.deepEqual(await getDatabase().get('SELECT * FROM ai_usage_legacy'), {
    usage_day: '2026-09-01', request_count: 4, used_tokens: 300, reserved_tokens: 1200, updated_at: 1,
  });
  assert.equal((await getDatabase().get('SELECT COUNT(*) AS n FROM ai_usage_reservations')).n, 0, 'Legacy aggregates must not manufacture provider attempts.');
  assert.equal(await reserveAiUsage('2026-09-01', 100, 10, 1550), false);
  assert.equal((await getDatabase().get('SELECT status FROM incoming_work')).status, 'needs_review');
  const tasks = await listOutboxTasks();
  assert.equal(tasks.find(task => task.id === 'unproven').status, 'needs_review');
  assert.equal(tasks.find(task => task.id === 'unproven').workflowRevisionId, null);
  assert.equal(tasks.find(task => task.id === 'interrupted-send').status, 'sending');
  await recoverInterruptedOutboxTasks();
  assert.equal((await listOutboxTasks()).find(task => task.id === 'interrupted-send').status, 'unknown');
  await closeDb();
  await initDb(databasePath);
  assert.deepEqual(await getAiUsage('2026-09-01'), { requestCount: 4, usedTokens: 300, reservedTokens: 1200 });
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Ingress/AI migration retains legacy evidence and blocks historical replay.');
} finally {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
}
