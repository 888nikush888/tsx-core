import type { WorkflowResourceVersion, WorkflowRevision } from './trading_types.js';

/** Stored SQLite columns; JSON is decoded and checked by the repository. */
export interface WorkflowResourceRow {
  id: string; resource_id: string; version: number; kind: WorkflowResourceVersion['kind']; edit_revision: number;
  name: string; description: string; status: WorkflowResourceVersion['status']; configuration_json: string;
  configuration_sha256: string; created_at: number; published_at: number | null; archived_at: number | null;
}

export interface WorkflowPathRow {
  id: string; workflow_revision_id: string; path_key: string; channel_id: string; account_id: string;
  strategy_version_id: string; parser_resource_version_id: string | null; schema_resource_version_id: string | null;
  contract_resource_version_id: string | null; sizing_resource_version_id: string | null;
  adaptive_risk_resource_version_id: string | null; route_group_key: string; fallback_rank: number;
  fallback_on_json: string; node_ids_json: string; effective_configuration_json: string; enabled: number; created_at: number;
}

export interface WorkflowRevisionRow {
  id: string; revision: number; status: WorkflowRevision['status']; graph_json: string; compiled_json: string;
  definition_sha256: string; base_revision_id: string | null; created_by: string; created_at: number; archived_at: number | null;
}

export interface LegacyWorkflowRouteRow {
  channel_id: string; strategy_version_id: string; account_id: string;
  strategy_name: string; configuration_json: string; account_name: string;
}

export interface LegacyRiskPolicyRow {
  channel_id: string; mode: 'fixed' | 'shadow' | 'automatic'; tiers_json: string; current_tier: number;
  locked_tier: number | null; lookback_weeks: number; minimum_closed_trades: number;
  loss_threshold_percent: string; profit_threshold_percent: string; weak_channel_action: 'none' | 'reduce' | 'block';
  weak_weeks_before_block: number; manually_blocked: number; blocked: number;
}
