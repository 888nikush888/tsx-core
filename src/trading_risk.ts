import { createHash } from 'node:crypto';
import {
  addDecimal,
  compareDecimal,
  decimal,
  divideDecimal,
  midpointDecimal,
  minDecimal,
  multiplyDecimal,
  quantizeDecimalDown,
  subtractDecimal,
} from './trading_decimal.js';
import type {
  ExecutableSignal,
  PlannedOrder,
  StrategyConfiguration,
  TradingAccountSnapshot,
  TradingMarketSnapshot,
  TradingPlan,
} from './trading_types.js';

export class TradingRiskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TradingRiskError';
  }
}

function clientOrderId(intentId: string, role: PlannedOrder['role'], index = 0): string {
  const identity = `${intentId}:${role}:${index}`;
  return `0x${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

function entryPrice(signal: ExecutableSignal, strategy: StrategyConfiguration, market: TradingMarketSnapshot): string {
  if (strategy.entry.orderType === 'market' || signal.entry.type === 'market') return market.markPrice;
  if (strategy.entry.rangePrice === 'midpoint') return midpointDecimal(signal.entry);
  const near = signal.action === 'LONG' ? signal.entry.max : signal.entry.min;
  const far = signal.action === 'LONG' ? signal.entry.min : signal.entry.max;
  return strategy.entry.rangePrice === 'near' ? near : far;
}

function quantizeDecimalUp(value: string, increment: string): string {
  const down = quantizeDecimalDown(value, increment);
  return compareDecimal(down, value) === 0 ? down : addDecimal(down, increment);
}

function quantizedEntryPrice(
  signal: ExecutableSignal,
  strategy: StrategyConfiguration,
  market: TradingMarketSnapshot,
): string {
  const raw = decimal(entryPrice(signal, strategy, market), { positive: true });
  const isMarket = strategy.entry.orderType === 'market' || signal.entry.type === 'market';
  if (isMarket) {
    // Conservatively model a market buy one tick upward and a market sell downward.
    return signal.action === 'LONG'
      ? quantizeDecimalUp(raw, market.priceTick)
      : quantizeDecimalDown(raw, market.priceTick);
  }
  // Limit prices must be executable without silently crossing the requested bound.
  return signal.action === 'LONG'
    ? quantizeDecimalDown(raw, market.priceTick)
    : quantizeDecimalUp(raw, market.priceTick);
}

function quantizedStopPrice(signal: ExecutableSignal, market: TradingMarketSnapshot): string {
  // Use the adverse tick in both the submitted stop and the risk calculation.
  return signal.action === 'LONG'
    ? quantizeDecimalDown(signal.stopLoss, market.priceTick)
    : quantizeDecimalUp(signal.stopLoss, market.priceTick);
}

function assertStrategyAllows(signal: ExecutableSignal, strategy: StrategyConfiguration): void {
  if (!strategy.allowedSignalSchemas.includes(signal.schema)) {
    throw new TradingRiskError('SIGNAL_SCHEMA_BLOCKED', `Strategy does not allow ${signal.schema} signals.`);
  }
  if (!strategy.allowedSides.includes(signal.action)) {
    throw new TradingRiskError('SIDE_BLOCKED', `Strategy does not allow ${signal.action} positions.`);
  }
  if (strategy.allowedSymbols.length > 0 && !strategy.allowedSymbols.includes(signal.symbol)) {
    throw new TradingRiskError('SYMBOL_BLOCKED', `Strategy does not allow ${signal.symbol}.`);
  }
}

function riskDistance(signal: ExecutableSignal, price: string): string {
  if (signal.action === 'LONG') {
    if (compareDecimal(signal.stopLoss, price) >= 0) throw new TradingRiskError('INVALID_STOP', 'LONG stop must be below entry.');
    return subtractDecimal(price, signal.stopLoss);
  }
  if (compareDecimal(signal.stopLoss, price) <= 0) throw new TradingRiskError('INVALID_STOP', 'SHORT stop must be above entry.');
  return subtractDecimal(signal.stopLoss, price);
}

function selectedLeverage(signal: ExecutableSignal, strategy: StrategyConfiguration, market: TradingMarketSnapshot): number {
  return Math.min(strategy.sizing.maxLeverage, market.maxLeverage, signal.suggestedLeverage || strategy.sizing.maxLeverage);
}

function positionQuantity(input: {
  account: TradingAccountSnapshot;
  market: TradingMarketSnapshot;
  entry: string;
  riskAmount: string;
  riskDistance: string;
  maxNotional: string;
  leverage: number;
}): string {
  const byRisk = divideDecimal(input.riskAmount, input.riskDistance);
  const byNotional = divideDecimal(input.maxNotional, input.entry);
  const buyingPower = multiplyDecimal(input.account.availableBalance, String(input.leverage));
  const byBuyingPower = divideDecimal(buyingPower, input.entry);
  const quantity = quantizeDecimalDown(
    minDecimal(byRisk, byNotional, byBuyingPower),
    input.market.quantityStep,
  );
  if (compareDecimal(quantity, input.market.minimumQuantity) < 0) {
    throw new TradingRiskError('QUANTITY_BELOW_MINIMUM', 'Risk-limited quantity is below the exchange minimum.');
  }
  if (compareDecimal(multiplyDecimal(quantity, input.entry), input.market.minimumNotional) < 0) {
    throw new TradingRiskError('NOTIONAL_BELOW_MINIMUM', 'Risk-limited notional is below the exchange minimum.');
  }
  return quantity;
}

export function allocateTargetQuantities(quantity: string, allocations: string[], step: string): string[] {
  let allocated = '0';
  return allocations.map((allocation, index) => {
    if (index === allocations.length - 1) return subtractDecimal(quantity, allocated);
    const target = quantizeDecimalDown(
      divideDecimal(multiplyDecimal(quantity, allocation), '100'),
      step,
    );
    if (compareDecimal(target, '0') <= 0) {
      throw new TradingRiskError('TARGET_QUANTITY_BELOW_MINIMUM', 'A take-profit allocation rounds to zero.');
    }
    allocated = addDecimal(allocated, target);
    return target;
  });
}

export function adaptiveTargetAllocations(targetCount: number): string[] {
  if (!Number.isSafeInteger(targetCount) || targetCount < 1 || targetCount > 20) {
    throw new TradingRiskError('INVALID_TARGET_COUNT', 'Adaptive target count must be between one and twenty.');
  }
  const allocations: string[] = [];
  let remaining = '100';
  for (let index = 0; index < targetCount - 1; index += 1) {
    const allocation = divideDecimal(remaining, '2');
    allocations.push(allocation);
    remaining = subtractDecimal(remaining, allocation);
  }
  allocations.push(remaining);
  return allocations;
}

export function resolveTargetAllocations(strategy: StrategyConfiguration, targetCount: number): string[] {
  const mode = strategy.exits.targetAllocationMode ?? 'manual';
  if (mode === 'adaptive_halving') return adaptiveTargetAllocations(targetCount);
  if (mode !== 'manual') throw new TradingRiskError('INVALID_TARGET_ALLOCATION_MODE', 'Unsupported target allocation mode.');
  if (strategy.exits.targetAllocationsPercent.length !== targetCount) {
    throw new TradingRiskError(
      'TARGET_COUNT_MISMATCH',
      `Strategy defines ${strategy.exits.targetAllocationsPercent.length} exits but the signal contains ${targetCount} targets.`,
    );
  }
  return [...strategy.exits.targetAllocationsPercent];
}

export interface AdaptiveStopLossDecision {
  trigger: string;
  reason: 'initial' | 'break_even_after_target' | 'target_ladder_after_target' | 'final_target_complete';
  referenceTargetIndex: number | null;
}

export function adaptiveStopLossDecision(plan: TradingPlan, filledTargets: number): AdaptiveStopLossDecision {
  const takeProfits = plan.orders
    .filter(order => order.role === 'take_profit')
    .sort((left, right) => Number(left.targetIndex) - Number(right.targetIndex));
  const finalTargetComplete = filledTargets >= takeProfits.length;
  const managedTargetCount = finalTargetComplete ? Math.max(0, takeProfits.length - 1) : filledTargets;
  if (managedTargetCount <= 0) {
    return {
      trigger: plan.stopPrice,
      reason: finalTargetComplete ? 'final_target_complete' : 'initial',
      referenceTargetIndex: null,
    };
  }
  const referenceTargetIndex = managedTargetCount - 2;
  if (referenceTargetIndex <= 0) {
    return {
      trigger: plan.entryPrice,
      reason: finalTargetComplete ? 'final_target_complete' : 'break_even_after_target',
      referenceTargetIndex: null,
    };
  }
  const reference = takeProfits.find(order => order.targetIndex === referenceTargetIndex);
  if (!reference?.price) throw new TradingRiskError('MISSING_REFERENCE_TARGET', 'Adaptive stop reference target is missing.');
  return {
    trigger: reference.price,
    reason: finalTargetComplete ? 'final_target_complete' : 'target_ladder_after_target',
    referenceTargetIndex: finalTargetComplete ? null : referenceTargetIndex,
  };
}

function plannedOrders(input: {
  intentId: string;
  signal: ExecutableSignal;
  strategy: StrategyConfiguration;
  market: TradingMarketSnapshot;
  entry: string;
  stop: string;
  quantity: string;
  targetAllocations: string[];
}): PlannedOrder[] {
  const openingSide = input.signal.action === 'LONG' ? 'buy' : 'sell';
  const closingSide = openingSide === 'buy' ? 'sell' : 'buy';
  const entryType = input.strategy.entry.orderType === 'market' || input.signal.entry.type === 'market' ? 'market' : 'limit';
  const targets = allocateTargetQuantities(
    input.quantity,
    input.targetAllocations,
    input.market.quantityStep,
  );
  const entry: PlannedOrder = {
    clientOrderId: clientOrderId(input.intentId, 'entry'),
    role: 'entry',
    side: openingSide,
    orderType: entryType,
    quantity: input.quantity,
    price: entryType === 'limit' ? input.entry : null,
    triggerPrice: null,
    reduceOnly: false,
    postOnly: entryType === 'limit' && input.strategy.entry.postOnly,
    targetIndex: null,
  };
  const stop: PlannedOrder = {
    clientOrderId: clientOrderId(input.intentId, 'stop_loss'),
    role: 'stop_loss',
    side: closingSide,
    orderType: 'stop_market',
    quantity: input.quantity,
    price: null,
    triggerPrice: input.stop,
    reduceOnly: true,
    postOnly: false,
    targetIndex: null,
  };
  const takeProfits = input.signal.targets.map((target, index): PlannedOrder => ({
    clientOrderId: clientOrderId(input.intentId, 'take_profit', index + 1),
    role: 'take_profit',
    side: closingSide,
    orderType: 'limit',
    quantity: targets[index]!,
    price: input.signal.action === 'LONG'
      ? quantizeDecimalDown(midpointDecimal(target), input.market.priceTick)
      : quantizeDecimalUp(midpointDecimal(target), input.market.priceTick),
    triggerPrice: null,
    reduceOnly: true,
    postOnly: false,
    targetIndex: index + 1,
  }));
  return [entry, stop, ...takeProfits];
}

export function createTradingPlan(input: {
  intentId: string;
  signal: ExecutableSignal;
  strategy: StrategyConfiguration;
  account: TradingAccountSnapshot;
  market: TradingMarketSnapshot;
  effectiveRiskPercent?: string;
  now?: number;
}): TradingPlan {
  assertStrategyAllows(input.signal, input.strategy);
  const targetAllocations = resolveTargetAllocations(input.strategy, input.signal.targets.length);
  const price = quantizedEntryPrice(input.signal, input.strategy, input.market);
  const stop = quantizedStopPrice(input.signal, input.market);
  const distance = riskDistance({ ...input.signal, stopLoss: stop }, price);
  const adaptiveCeiling = input.strategy.sizing.maxAdaptiveRiskPercent
    ?? input.strategy.sizing.riskPerTradePercent;
  const selectedRisk = input.effectiveRiskPercent
    ? minDecimal(decimal(input.effectiveRiskPercent, { positive: true, max: '10' }), adaptiveCeiling)
    : input.strategy.sizing.riskPerTradePercent;
  const configuredRisk = input.signal.suggestedRiskPercent
    ? minDecimal(selectedRisk, input.signal.suggestedRiskPercent)
    : selectedRisk;
  const riskAmount = divideDecimal(multiplyDecimal(input.account.equity, configuredRisk), '100');
  const leverage = selectedLeverage(input.signal, input.strategy, input.market);
  const quantity = positionQuantity({
    account: input.account,
    market: input.market,
    entry: price,
    riskAmount,
    riskDistance: distance,
    maxNotional: input.strategy.sizing.maxPositionNotional,
    leverage,
  });
  const notional = multiplyDecimal(quantity, price);
  return {
    version: 1,
    symbol: input.signal.symbol,
    side: input.signal.action,
    entryPrice: price,
    stopPrice: stop,
    quantity,
    notional,
    riskAmount,
    leverage,
    entryTimeoutSeconds: input.strategy.entry.timeoutSeconds,
    entryOrderTtlSeconds: input.strategy.safety.entryOrderTtlSeconds,
    maxSlippagePercent: input.strategy.safety.maxSlippagePercent,
    quantityStep: input.market.quantityStep,
    targetAllocationMode: input.strategy.exits.targetAllocationMode ?? 'manual',
    targetAllocationsPercent: targetAllocations,
    stopLossMode: input.strategy.exits.stopLossMode ?? 'configured',
    orders: plannedOrders({ ...input, entry: price, stop, quantity, targetAllocations }),
    createdAt: input.now ?? Date.now(),
  };
}
