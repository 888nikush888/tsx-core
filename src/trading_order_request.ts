import type { ExchangeOrderRequest, PlannedOrder, TradingAccount, TradingPlan } from './trading_types.js';

/** Shared request construction binds the durable journal and the actual adapter invocation to the same plan. */
export function requestFromOrder(
  account: Pick<TradingAccount, 'id'>, plan: TradingPlan, order: PlannedOrder,
): ExchangeOrderRequest & { maxSlippagePercent: string } {
  return {
    ...order,
    ...(order.role === 'entry' && plan.entryExpiresAt != null ? { entryExpiresAt: plan.entryExpiresAt } : {}),
    ...(order.role === 'entry' && plan.entryPriceBoundary ? { entryPriceBoundary: structuredClone(plan.entryPriceBoundary) } : {}),
    ...(order.role === 'entry' && plan.leverageTierDecision ? { leverageTierDecision: structuredClone(plan.leverageTierDecision) } : {}),
    accountId: account.id,
    symbol: plan.symbol,
    leverage: plan.leverage,
    timeoutSeconds: order.role === 'entry' ? plan.entryTimeoutSeconds : 12,
    maxSlippagePercent: plan.maxSlippagePercent,
  };
}
