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
  return `0x${createHash('sha256').update(`${intentId}:${role}:${index}`).digest('hex').slice(0, 32)}`;
}

function entryPrice(signal: ExecutableSignal, strategy: StrategyConfiguration, market: TradingMarketSnapshot): string {
  if (strategy.entry.orderType === 'market' || signal.entry.type === 'market') return market.markPrice;
  if (strategy.entry.rangePrice === 'midpoint') return midpointDecimal(signal.entry);
  const near = signal.action === 'LONG' ? signal.entry.max : signal.entry.min;
  const far = signal.action === 'LONG' ? signal.entry.min : signal.entry.max;
  return strategy.entry.rangePrice === 'near' ? near : far;
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
  if (strategy.exits.targetAllocationsPercent.length !== signal.targets.length) {
    throw new TradingRiskError(
      'TARGET_COUNT_MISMATCH',
      `Strategy defines ${strategy.exits.targetAllocationsPercent.length} exits but the signal contains ${signal.targets.length} targets.`,
    );
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

function targetQuantities(quantity: string, allocations: string[], step: string): string[] {
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

function plannedOrders(input: {
  intentId: string;
  signal: ExecutableSignal;
  strategy: StrategyConfiguration;
  market: TradingMarketSnapshot;
  entry: string;
  quantity: string;
}): PlannedOrder[] {
  const openingSide = input.signal.action === 'LONG' ? 'buy' : 'sell';
  const closingSide = openingSide === 'buy' ? 'sell' : 'buy';
  const entryType = input.strategy.entry.orderType === 'market' || input.signal.entry.type === 'market' ? 'market' : 'limit';
  const targets = targetQuantities(
    input.quantity,
    input.strategy.exits.targetAllocationsPercent,
    input.market.quantityStep,
  );
  const entry: PlannedOrder = {
    clientOrderId: clientOrderId(input.intentId, 'entry'),
    role: 'entry',
    side: openingSide,
    orderType: entryType,
    quantity: input.quantity,
    price: entryType === 'limit' ? quantizeDecimalDown(input.entry, input.market.priceTick) : null,
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
    triggerPrice: quantizeDecimalDown(input.signal.stopLoss, input.market.priceTick),
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
    price: quantizeDecimalDown(midpointDecimal(target), input.market.priceTick),
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
  now?: number;
}): TradingPlan {
  assertStrategyAllows(input.signal, input.strategy);
  const price = decimal(entryPrice(input.signal, input.strategy, input.market), { positive: true });
  const distance = riskDistance(input.signal, price);
  const configuredRisk = input.signal.suggestedRiskPercent
    ? minDecimal(input.strategy.sizing.riskPerTradePercent, input.signal.suggestedRiskPercent)
    : input.strategy.sizing.riskPerTradePercent;
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
    stopPrice: input.signal.stopLoss,
    quantity,
    notional,
    riskAmount,
    leverage,
    orders: plannedOrders({ ...input, entry: price, quantity }),
    createdAt: input.now ?? Date.now(),
  };
}
