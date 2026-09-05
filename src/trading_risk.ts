import { createHash } from 'node:crypto';
import { solveTierQuantity, tierDecision } from './trading_leverage_tiers.js';
import { fxNotionalBudget, fxSizedQuantity, fxSizingContext } from './trading_fx_sizing.js';
import type { StoredFxConversion } from './trading_fx_repository.js';
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
  LeverageDecision,
  PlannedOrder,
  StrategyConfiguration,
  TradingAccountSnapshot,
  TradingMarketSnapshot,
  TradingPlan,
  TradingEntryPriceBoundary,
} from './trading_types.js';

export class TradingRiskError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'TradingRiskError';
  }
}

function priceQuantum(value: string): bigint {
  const [whole, fraction = ''] = decimal(value, { positive: true }).split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
}

function formatPriceQuantum(value: bigint): string {
  const digits = value.toString().padStart(19, '0');
  return decimal(`${digits.slice(0, -18)}.${digits.slice(-18)}`, { positive: true });
}

/** Exact rational arithmetic: do not truncate a SHORT floor before rounding it to the tick. */
export function createEntryPriceBoundary(input: {
  side: 'LONG' | 'SHORT'; referencePrice: string; priceTick: string; maxSlippagePercent: string;
}): TradingEntryPriceBoundary {
  const referencePrice = decimal(input.referencePrice, { positive: true });
  const priceTick = decimal(input.priceTick, { positive: true });
  const maxSlippagePercent = decimal(input.maxSlippagePercent, { positive: true, max: '5' });
  if (!['LONG', 'SHORT'].includes(input.side)) throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Entry boundary side is invalid.');
  const hundred = 100n * 10n ** 18n;
  const factor = input.side === 'LONG' ? hundred + priceQuantum(maxSlippagePercent) : hundred - priceQuantum(maxSlippagePercent);
  const numerator = priceQuantum(referencePrice) * factor;
  const denominator = hundred * priceQuantum(priceTick);
  const ticks = input.side === 'LONG' ? numerator / denominator : (numerator + denominator - 1n) / denominator;
  return { version: 1, referencePrice, maxSlippagePercent, priceTick, limitPrice: formatPriceQuantum(ticks * priceQuantum(priceTick)) };
}

function assertBoundaryContract(boundary: TradingEntryPriceBoundary, side: TradingPlan['side'], slippage: string): void {
  const expected = createEntryPriceBoundary({ ...boundary, side, maxSlippagePercent: slippage });
  for (const key of Object.keys(expected) as Array<keyof TradingEntryPriceBoundary>) {
    if (boundary[key] !== expected[key]) throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Original entry price boundary is invalid or changed.');
  }
}

export function assertEntryPriceBoundary(plan: Pick<TradingPlan, 'side' | 'maxSlippagePercent' | 'entryPriceBoundary'>, entry: PlannedOrder): void {
  const boundary = plan.entryPriceBoundary;
  if (!boundary) {
    if (entry.orderType === 'market' || entry.timeInForce !== undefined) {
      throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Market-based entry requires its original price boundary.');
    }
    return;
  }
  assertBoundaryContract(boundary, plan.side, plan.maxSlippagePercent);
  if (entry.role !== 'entry' || entry.reduceOnly || entry.orderType !== 'limit' || entry.timeInForce !== 'IOC'
    || entry.postOnly || entry.price !== boundary.limitPrice || entry.side !== (plan.side === 'LONG' ? 'buy' : 'sell')) {
    throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Entry must retain its original price-limited IOC contract.');
  }
}

function planPriceBoundary(input: {
  signal: ExecutableSignal; strategy: StrategyConfiguration; market: TradingMarketSnapshot;
  entryPriceBoundary?: TradingEntryPriceBoundary | null;
}): TradingEntryPriceBoundary | undefined {
  const isMarket = input.signal.entry.type === 'market' || input.strategy.entry.orderType === 'market';
  if (!isMarket) {
    if (input.entryPriceBoundary) throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Ordinary signal limits must not become market IOC entries.');
    return undefined;
  }
  const boundary = input.entryPriceBoundary ?? createEntryPriceBoundary({ side: input.signal.action,
    referencePrice: input.market.markPrice, priceTick: input.market.priceTick, maxSlippagePercent: input.strategy.safety.maxSlippagePercent });
  assertBoundaryContract(boundary, input.signal.action, input.strategy.safety.maxSlippagePercent);
  if (boundary.priceTick !== decimal(input.market.priceTick)) throw new TradingRiskError('ENTRY_PRICE_BOUND_UNPROVEN', 'Market tick changed since original entry planning.');
  return boundary;
}

export function resolveEntryExpiresAt(originAt: number, ttlSeconds: number, earlierDeadline?: number | null): number {
  const deadline = originAt + ttlSeconds * 1_000;
  if (!Number.isSafeInteger(originAt) || originAt <= 0 || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < 10 || ttlSeconds > 86_400 || !Number.isSafeInteger(deadline)) {
    throw new TradingRiskError('ENTRY_DEADLINE_UNPROVEN', 'Original entry origin or deadline cannot be proven.');
  }
  if (earlierDeadline === undefined || earlierDeadline === null) return deadline;
  if (!Number.isSafeInteger(earlierDeadline) || earlierDeadline <= 0) {
    throw new TradingRiskError('ENTRY_DEADLINE_UNPROVEN', 'Persisted entry deadline is invalid.');
  }
  return Math.min(deadline, earlierDeadline);
}

export function assertEntryNotExpired(deadline: number | null | undefined, now = Date.now()): void {
  if (!Number.isSafeInteger(deadline) || Number(deadline) <= 0 || !Number.isSafeInteger(now)) {
    throw new TradingRiskError('ENTRY_DEADLINE_UNPROVEN', 'Absolute entry deadline cannot be proven.');
  }
  if (now >= Number(deadline)) throw new TradingRiskError('ENTRY_INTENT_EXPIRED', 'Original entry deadline has expired.');
}

function planEntryTiming(input: {
  now?: number; entryOriginAt?: number; entryExpiresAt?: number | null; strategy: StrategyConfiguration;
}): Pick<TradingPlan, 'createdAt' | 'entryExpiresAt'> {
  const createdAt = input.now ?? Date.now();
  const originAt = input.entryOriginAt ?? createdAt;
  return { createdAt, entryExpiresAt: resolveEntryExpiresAt(originAt, input.strategy.safety.entryOrderTtlSeconds, input.entryExpiresAt) };
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

export function resolveLeverageDecision(
  signal: ExecutableSignal,
  strategy: StrategyConfiguration,
  market: TradingMarketSnapshot,
): LeverageDecision {
  const requestedSource = signal.suggestedLeverage !== undefined ? 'signal' : 'strategy_default';
  const requested = signal.suggestedLeverage
    ?? strategy.sizing.defaultLeverage
    ?? strategy.sizing.maxLeverage;
  const strategyMaximum = strategy.sizing.maxLeverage;
  const marketMaximum = market.maxLeverage;
  const effective = Math.min(requested, strategyMaximum, marketMaximum, 50);
  const strategyCaps = requested > strategyMaximum && strategyMaximum === effective;
  const marketCaps = requested > marketMaximum && marketMaximum === effective;
  const cappedBy = strategyCaps && marketCaps
    ? 'strategy_and_market'
    : strategyCaps
      ? 'strategy'
      : marketCaps
        ? 'market'
        : null;
  return { requested, requestedSource, strategyMaximum, marketMaximum, effective, cappedBy };
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

function equityPercentPositionQuantity(input: {
  account: TradingAccountSnapshot;
  market: TradingMarketSnapshot;
  entry: string;
  positionPercent: string;
  maxNotional: string;
  leverage: number;
}): string {
  const portfolioNotional = divideDecimal(
    multiplyDecimal(input.account.equity, input.positionPercent),
    '100',
  );
  const buyingPower = multiplyDecimal(input.account.availableBalance, String(input.leverage));
  const allowedNotional = minDecimal(portfolioNotional, input.maxNotional, buyingPower);
  const quantity = quantizeDecimalDown(
    divideDecimal(allowedNotional, input.entry),
    input.market.quantityStep,
  );
  if (compareDecimal(quantity, input.market.minimumQuantity) < 0) {
    throw new TradingRiskError('QUANTITY_BELOW_MINIMUM', 'Portfolio-sized quantity is below the exchange minimum.');
  }
  if (compareDecimal(multiplyDecimal(quantity, input.entry), input.market.minimumNotional) < 0) {
    throw new TradingRiskError('NOTIONAL_BELOW_MINIMUM', 'Portfolio-sized notional is below the exchange minimum.');
  }
  return quantity;
}

function equityPercentMarginQuantity(input: {
  account: TradingAccountSnapshot;
  market: TradingMarketSnapshot;
  entry: string;
  capitalPercent: string;
  maxNotional: string;
  leverage: number;
}): string {
  const deployedCapital = divideDecimal(
    multiplyDecimal(input.account.equity, input.capitalPercent),
    '100',
  );
  const leveragedNotional = multiplyDecimal(deployedCapital, String(input.leverage));
  const buyingPower = multiplyDecimal(input.account.availableBalance, String(input.leverage));
  const allowedNotional = minDecimal(leveragedNotional, input.maxNotional, buyingPower);
  const quantity = quantizeDecimalDown(
    divideDecimal(allowedNotional, input.entry),
    input.market.quantityStep,
  );
  if (compareDecimal(quantity, input.market.minimumQuantity) < 0) {
    throw new TradingRiskError('QUANTITY_BELOW_MINIMUM', 'Capital-sized quantity is below the exchange minimum.');
  }
  if (compareDecimal(multiplyDecimal(quantity, input.entry), input.market.minimumNotional) < 0) {
    throw new TradingRiskError('NOTIONAL_BELOW_MINIMUM', 'Capital-sized notional is below the exchange minimum.');
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

function resolveTargetAllocations(strategy: StrategyConfiguration, targetCount: number): string[] {
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

export function resolveDailyLossLimit(
  safety: StrategyConfiguration['safety'],
  accountEquity: string,
): string {
  if ((safety.maxDailyLossMode ?? 'absolute') === 'absolute') return safety.maxDailyLoss;
  return divideDecimal(multiplyDecimal(accountEquity, safety.maxDailyLoss), '100');
}

export interface AdaptiveStopLossDecision {
  trigger: string;
  reason: 'initial' | 'break_even_after_target' | 'target_ladder_after_target' | 'final_target_complete';
  referenceTargetIndex: number | null;
}

export function breakEvenStopPrice(
  side: TradingPlan['side'],
  averageEntryPrice: string,
  priceTick: string,
): string {
  return side === 'LONG'
    ? quantizeDecimalUp(averageEntryPrice, priceTick)
    : quantizeDecimalDown(averageEntryPrice, priceTick);
}

export function adaptiveStopLossDecision(
  plan: TradingPlan,
  filledTargets: number,
  breakEvenPrice = plan.entryPrice,
): AdaptiveStopLossDecision {
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
      trigger: breakEvenPrice,
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
  entryPriceBoundary?: TradingEntryPriceBoundary;
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
    orderType: input.entryPriceBoundary ? 'limit' : entryType,
    ...(input.entryPriceBoundary ? { timeInForce: 'IOC' as const } : {}),
    quantity: input.quantity,
    price: input.entryPriceBoundary?.limitPrice ?? (entryType === 'limit' ? input.entry : null),
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

interface TradingPlanInput {
  intentId: string;
  signal: ExecutableSignal;
  strategy: StrategyConfiguration;
  account: TradingAccountSnapshot;
  market: TradingMarketSnapshot;
  fxConversion?: StoredFxConversion;
  effectiveRiskPercent?: string;
  entryOriginAt?: number;
  entryExpiresAt?: number | null;
  entryPriceBoundary?: TradingEntryPriceBoundary | null;
  now?: number;
}

function configuredPlanRisk(input: TradingPlanInput): string {
  const adaptiveCeiling = input.strategy.sizing.maxAdaptiveRiskPercent
    ?? input.strategy.sizing.riskPerTradePercent;
  const selectedRisk = input.effectiveRiskPercent
    ? minDecimal(decimal(input.effectiveRiskPercent, { positive: true, max: '10' }), adaptiveCeiling)
    : input.strategy.sizing.riskPerTradePercent;
  const sizingMode = input.strategy.sizing.positionSizingMode ?? 'risk_percent';
  return sizingMode === 'risk_percent' && input.signal.suggestedRiskPercent
    ? minDecimal(selectedRisk, input.signal.suggestedRiskPercent)
    : selectedRisk;
}

function quantityForPlan(input: TradingPlanInput, entry: string, riskPercent: string, distance: string, leverage: number): string {
  if (input.fxConversion) return fxSizedQuantity({ ...input, entry, percent: riskPercent, distance, leverage });
  const common = { account: input.account, market: input.market, entry,
    maxNotional: input.strategy.sizing.maxPositionNotional, leverage };
  if (input.strategy.sizing.positionSizingMode === 'equity_percent_notional') {
    return equityPercentPositionQuantity({ ...common, positionPercent: riskPercent });
  }
  if (input.strategy.sizing.positionSizingMode === 'equity_percent_margin') {
    return equityPercentMarginQuantity({ ...common, capitalPercent: riskPercent });
  }
  return positionQuantity({ ...common, riskAmount: divideDecimal(multiplyDecimal(input.account.equity, riskPercent), '100'), riskDistance: distance });
}

function originalNotionalBudget(input: TradingPlanInput, capital: string, leverage: number): string {
  const mode = input.strategy.sizing.positionSizingMode;
  const sized = mode === 'equity_percent_margin' ? multiplyDecimal(capital, String(leverage))
    : mode === 'equity_percent_notional' ? capital : input.strategy.sizing.maxPositionNotional;
  return minDecimal(input.strategy.sizing.maxPositionNotional, multiplyDecimal(input.account.availableBalance, String(leverage)), sized);
}

function solvePlanSizing(input: TradingPlanInput, price: string, distance: string, limitPrice: string) {
  const fxSizing = fxSizingContext(input);
  const configuredRisk = configuredPlanRisk(input);
  const leverageDecision = resolveLeverageDecision(input.signal, input.strategy, input.market);
  const configuredRiskAmount = divideDecimal(multiplyDecimal(input.account.equity, configuredRisk), '100');
  const sizingPrice = input.market.leverageTiers
    ? (compareDecimal(input.market.markPrice, limitPrice) > 0 ? input.market.markPrice : limitPrice) : price;
  const quantityAtLeverage = (leverage: number) => quantityForPlan(input, sizingPrice, configuredRisk, distance, leverage);
  const solved = input.market.leverageTiers
    ? solveTierQuantity(input.market.leverageTiers, leverageDecision.effective, quantityAtLeverage)
    : { leverage: leverageDecision.effective, quantity: quantityAtLeverage(leverageDecision.effective), tierIndex: 0 };
  const { leverage, quantity } = solved;
  const maximumNotional = fxSizing ? fxNotionalBudget({ ...input, entry: sizingPrice, percent: configuredRisk, distance, leverage })
    : originalNotionalBudget(input, configuredRiskAmount, leverage);
  if (leverage < leverageDecision.effective) leverageDecision.cappedBy = 'market';
  leverageDecision.effective = leverage;
  const sizingMode = input.strategy.sizing.positionSizingMode;
  const riskAmount = sizingMode === 'equity_percent_notional' || sizingMode === 'equity_percent_margin'
    ? multiplyDecimal(quantity, distance)
    : configuredRiskAmount;
  return { quantity, leverage, leverageDecision, riskAmount,
    ...(fxSizing ? { fxSizing } : {}),
    ...(input.market.leverageTiers ? { leverageTierDecision: tierDecision(input.market.leverageTiers, solved, maximumNotional) } : {}) };
}

export function createTradingPlan(input: TradingPlanInput): TradingPlan {
  assertStrategyAllows(input.signal, input.strategy);
  const targetAllocations = resolveTargetAllocations(input.strategy, input.signal.targets.length);
  const entryPriceBoundary = planPriceBoundary(input);
  const pricingMarket = entryPriceBoundary ? { ...input.market, markPrice: entryPriceBoundary.referencePrice } : input.market;
  const price = quantizedEntryPrice(input.signal, input.strategy, pricingMarket);
  const stop = quantizedStopPrice(input.signal, input.market);
  const limitPrice = entryPriceBoundary?.limitPrice ?? price;
  const distance = riskDistance({ ...input.signal, stopLoss: stop }, limitPrice);
  const sizing = solvePlanSizing(input, price, distance, limitPrice);
  const { quantity } = sizing;
  return {
    version: 1,
    symbol: input.signal.symbol,
    side: input.signal.action,
    entryPrice: price,
    ...(entryPriceBoundary ? { entryPriceBoundary } : {}),
    stopPrice: stop,
    ...sizing,
    notional: multiplyDecimal(quantity, price),
    entryTimeoutSeconds: input.strategy.entry.timeoutSeconds,
    entryOrderTtlSeconds: input.strategy.safety.entryOrderTtlSeconds,
    maxSlippagePercent: input.strategy.safety.maxSlippagePercent,
    quantityStep: input.market.quantityStep,
    targetAllocationMode: input.strategy.exits.targetAllocationMode ?? 'manual',
    targetAllocationsPercent: targetAllocations,
    stopLossMode: input.strategy.exits.stopLossMode ?? 'configured',
    orders: plannedOrders({ ...input, entry: price, stop, quantity, targetAllocations, entryPriceBoundary }),
    ...planEntryTiming(input),
  };
}
