// Fixture-only rewind: new exact evidence or absent legacy aliases cannot be represented in v45.
// Check before any DDL, rather than discard evidence or invent a zero/rounded legacy amount.
export const dropAdaptiveMoneySchema = `SELECT json(CASE WHEN EXISTS(
  SELECT 1 FROM trading_channel_risk_evaluations WHERE realized_pnl IS NULL OR return_percent IS NULL
    OR realized_pnl_value_json IS NOT NULL OR return_percent_value_json IS NOT NULL OR reporting_currency IS NOT NULL
    OR source_hash IS NOT NULL OR source_json IS NOT NULL OR invalidated_at IS NOT NULL OR invalidation_reason IS NOT NULL
  UNION ALL
  SELECT 1 FROM workflow_adaptive_risk_evaluations WHERE realized_pnl IS NULL OR return_percent IS NULL
    OR realized_pnl_value_json IS NOT NULL OR return_percent_value_json IS NOT NULL OR reporting_currency IS NOT NULL
    OR source_hash IS NOT NULL OR source_json IS NOT NULL OR invalidated_at IS NOT NULL OR invalidation_reason IS NOT NULL
) THEN 'M46 fixture rewind would lose adaptive monetary evidence' ELSE 'null' END);
SAVEPOINT adaptive_money_fixture_rewind;
CREATE TABLE trading_channel_risk_evaluations_v45 (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, policy_version INTEGER NOT NULL,
  week_started_at INTEGER NOT NULL, week_ended_at INTEGER NOT NULL,
  closed_trades INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL,
  realized_pnl TEXT NOT NULL, starting_equity TEXT NOT NULL, return_percent TEXT NOT NULL,
  previous_tier INTEGER NOT NULL, recommended_tier INTEGER NOT NULL, applied_tier INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('hold', 'increase', 'decrease', 'block')),
  reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(channel_id, policy_version, week_started_at)
);
INSERT INTO trading_channel_risk_evaluations_v45
  (rowid,id,channel_id,policy_version,week_started_at,week_ended_at,closed_trades,wins,losses,
   realized_pnl,starting_equity,return_percent,previous_tier,recommended_tier,applied_tier,action,reason,created_at)
SELECT rowid,id,channel_id,policy_version,week_started_at,week_ended_at,closed_trades,wins,losses,
  realized_pnl,starting_equity,return_percent,previous_tier,recommended_tier,applied_tier,action,reason,created_at
FROM trading_channel_risk_evaluations;
DROP TABLE trading_channel_risk_evaluations;
ALTER TABLE trading_channel_risk_evaluations_v45 RENAME TO trading_channel_risk_evaluations;
CREATE INDEX idx_channel_risk_evaluation_week ON trading_channel_risk_evaluations(channel_id, week_started_at DESC);
CREATE TABLE workflow_adaptive_risk_evaluations_v45 (
  id TEXT PRIMARY KEY,
  state_key TEXT NOT NULL REFERENCES workflow_adaptive_risk_state(state_key) ON DELETE RESTRICT,
  policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256) = 64),
  week_started_at INTEGER NOT NULL, week_ended_at INTEGER NOT NULL,
  closed_trades INTEGER NOT NULL, wins INTEGER NOT NULL, losses INTEGER NOT NULL,
  realized_pnl TEXT NOT NULL, starting_equity TEXT NOT NULL, return_percent TEXT NOT NULL,
  previous_tier INTEGER NOT NULL, recommended_tier INTEGER NOT NULL, applied_tier INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('hold', 'increase', 'decrease', 'block')),
  reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(state_key, policy_sha256, week_started_at)
);
INSERT INTO workflow_adaptive_risk_evaluations_v45
  (rowid,id,state_key,policy_sha256,week_started_at,week_ended_at,closed_trades,wins,losses,
   realized_pnl,starting_equity,return_percent,previous_tier,recommended_tier,applied_tier,action,reason,created_at)
SELECT rowid,id,state_key,policy_sha256,week_started_at,week_ended_at,closed_trades,wins,losses,
  realized_pnl,starting_equity,return_percent,previous_tier,recommended_tier,applied_tier,action,reason,created_at
FROM workflow_adaptive_risk_evaluations;
DROP TABLE workflow_adaptive_risk_evaluations;
ALTER TABLE workflow_adaptive_risk_evaluations_v45 RENAME TO workflow_adaptive_risk_evaluations;
CREATE INDEX idx_workflow_adaptive_risk_evaluations ON workflow_adaptive_risk_evaluations(state_key, week_ended_at DESC);
DELETE FROM schema_migrations WHERE version=46;
RELEASE adaptive_money_fixture_rewind;`;
export const dropFxMoneySchema = `${dropAdaptiveMoneySchema}
DROP TRIGGER decimal_money_valuation_exclusive;
DROP TRIGGER fx_original_variant_projection_pending;
DROP TABLE trading_fx_valuation_work;
DROP TABLE trading_fx_money_valuations;
DROP INDEX uq_money_event_account;
ALTER TABLE trading_accounting_projections DROP COLUMN value_json;
ALTER TABLE trading_positions DROP COLUMN ledger_realized_value_json;
DELETE FROM schema_migrations WHERE version=45;`;
export const dropRecoveryScheduleSchema = `${dropFxMoneySchema}
DROP TABLE trading_recovery_schedule_attempts;
DROP TABLE trading_recovery_schedules;
DELETE FROM schema_migrations WHERE version=44;`;
export const dropFxSchema = `${dropRecoveryScheduleSchema}
DROP TABLE trading_fx_conversion_receipts;
DROP TABLE trading_fx_conversions;
DROP TABLE trading_fx_receipts;
DELETE FROM schema_migrations WHERE version=43;`;
