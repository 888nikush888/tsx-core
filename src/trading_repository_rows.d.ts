import type {
  SignalContractVersion, TradingAccount, TradingIntent, TradingSignalSchema, TradingStrategyVersion,
} from './trading_types.js';

/** SQLite row shapes. JSON columns remain serialized until their existing validators run. */
export interface StrategyRow {
  id: string; strategy_id: string; version: number; name: string; description: string;
  status: TradingStrategyVersion['status']; configuration_json: string; configuration_sha256: string;
  created_at: number; published_at: number | null;
}

export interface AccountRow {
  id: string; name: string; exchange: TradingAccount['exchange']; mode: TradingAccount['mode'];
  status: TradingAccount['status']; enabled: number; credential_ref: string | null;
  external_account_id: string | null; credential_generation: string | null; max_concurrent_positions: number;
  kill_switch_active: number; kill_switch_reason: string | null; capabilities_json: string | null;
  last_verified_at: number | null; last_reconciled_at: number | null; last_error: string | null;
  created_at: number; updated_at: number;
}

export interface RouteRow {
  channel_id: string; strategy_version_id: string; account_id: string; enabled: number;
  created_at: number; updated_at: number;
}

export interface RuntimeRow {
  execution_enabled: number; live_trading_enabled: number; kill_switch_active: number;
  kill_switch_reason: string | null; updated_at: number;
}

export interface IntentRow {
  id: string; source_signal_id: string; root_source_signal_id: string | null; signal_run_id: string | null;
  workflow_revision_id: string | null; execution_path_id: string | null; channel_id: string;
  strategy_version_id: string; account_id: string; exchange: TradingIntent['exchange']; mode: TradingIntent['mode'];
  symbol: string; side: TradingIntent['side']; status: TradingIntent['status']; signal_json: string;
  plan_json: string | null; block_reason: string | null; last_error: string | null; created_at: number; updated_at: number;
}

export interface ContractRow {
  id: string; name: string; description: string; archived: number; created_at: number; updated_at: number;
}

export interface ContractVersionRow {
  id: string; contract_id: string; version: number; status: SignalContractVersion['status'];
  definition_json: string; definition_sha256: string; created_at: number;
  published_at: number | null; archived_at: number | null;
}

export interface SignalSchemaRow {
  id: string; name: string; description: string; parser_schema: TradingSignalSchema['parserSchema'];
  definition_json: string; definition_sha256: string; contract_version_id: string | null;
  contract_definition_json: string | null; contract_definition_sha256: string | null;
  template_name: string; enabled: number; created_at: number; updated_at: number;
}

export type IntentRouteRow = RouteRow & Pick<AccountRow, 'exchange' | 'mode'> &
  Pick<RuntimeRow, 'execution_enabled' | 'live_trading_enabled' | 'kill_switch_active'> & {
    strategy_status: StrategyRow['status']; account_status: AccountRow['status']; account_enabled: number;
  };

export type ActivityOrderRow = {
  id: string; intentId: string; accountId: string; clientOrderId: string; exchangeOrderId: string | null;
  role: string; side: string; orderType: string; status: string; price: string | null; triggerPrice: string | null;
  quantity: string; filledQuantity: string; reduceOnly: number; error: string | null; createdAt: number; updatedAt: number;
};
export type ActivityFillRow = {
  id: string; orderId: string; accountId: string; exchangeFillId: string; providerSymbol: string | null;
  remoteFillKey: string | null; identityStatus: string; price: string; quantity: string;
  fee: string; feeAsset: string; filledAt: number;
};
export type PositionMoneyRow = {
  accountId: string; realizedPnl: string | null; reportingCurrency: string | null;
  realizedPnlValueJson: string | null; accountingStatus: string;
};
export type ActivityPositionRow = PositionMoneyRow & {
  id: string; intentId: string; strategyVersionId: string; channelId: string; symbol: string; side: string;
  status: string; quantity: string; averageEntryPrice: string | null; stopPrice: string | null;
  openedAt: number | null; closedAt: number | null; updatedAt: number;
};
export type ActivityRiskRow = {
  id: string; severity: string; code: string; accountId: string | null; intentId: string | null;
  detailsJson: string; createdAt: number; acknowledgedAt: number | null;
};
export type ActivityReconciliationRow = {
  id: string; accountId: string; status: string; error: string | null; startedAt: number; completedAt: number | null;
};
export type PaperAccountRow = {
  accountId: string; equity: string; availableBalance: string; realizedPnl: string; updatedAt: number;
};
export type PaperMarketRow = {
  accountId: string; symbol: string; markPrice: string; priceTick: string; quantityStep: string;
  minimumQuantity: string; minimumNotional: string; maxLeverage: number; updatedAt: number;
};
export type WindowFillRow = {
  accountId: string; feeAsset: string; fee: string; price: string; quantity: string; settlementAsset: string | null;
};
export type WindowIntentCountRow = { accountId: string; intents: number; completedIntents: number; rejectedIntents: number };
export type WindowRiskCountRow = { accountId: string; riskEvents: number; criticalRiskEvents: number };
