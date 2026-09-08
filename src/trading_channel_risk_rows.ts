import type { ChannelRiskMode, WeakChannelAction, ChannelRiskEvaluation } from './trading_types.js';

export interface ChannelRiskPolicyRow {
  channel_id: string; mode: ChannelRiskMode; tiers_json: string; current_tier: number;
  lookback_weeks: number; minimum_closed_trades: number; loss_threshold_percent: string;
  profit_threshold_percent: string; weak_channel_action: WeakChannelAction; weak_weeks_before_block: number;
  manually_blocked: number; blocked: number; block_reason: string | null; locked_tier: number | null;
  policy_version: number; created_at: number; updated_at: number;
}

export interface RiskEvaluationRow {
  id: string; week_started_at: number; week_ended_at: number; closed_trades: number; wins: number; losses: number;
  realized_pnl: string | null; starting_equity: string; return_percent: string | null;
  previous_tier: number; recommended_tier: number; applied_tier: number;
  action: ChannelRiskEvaluation['action']; reason: string; created_at: number;
  realized_pnl_value_json: string | null; return_percent_value_json: string | null;
  reporting_currency: string | null; source_hash: string | null; source_json: string | null;
  invalidated_at: number | null; invalidation_reason: string | null;
}
export interface ChannelRiskEvaluationRow extends RiskEvaluationRow { channel_id: string; policy_version: number }
export interface WorkflowRiskEvaluationRow extends RiskEvaluationRow { state_key: string; policy_sha256: string }
export interface WorkflowRiskStateRow {
  state_key: string; channel_id: string; account_id: string; resource_id: string; current_tier: number;
  locked_tier: number | null; blocked: number; block_reason: string | null; policy_sha256: string; updated_at: number;
}
export type WorkflowRiskStateResult = WorkflowRiskStateRow & { warning?: string };
export type WorkflowRiskStateAnalyticsRow = WorkflowRiskStateRow & { resource_name: string };
export type WorkflowRiskEvaluationAnalyticsRow = WorkflowRiskEvaluationRow & {
  channel_id: string; account_id: string; resource_id: string; resource_name: string;
};
