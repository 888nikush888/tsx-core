import assert from 'node:assert/strict';
import { createTradingPlan } from '../src/trading_risk.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { deriveFxConversion } from '../src/trading_fx_quotes.ts';
import { assertPlanTierDecision } from '../src/trading_leverage_admission.js';
import { assertTierDecisionBudget } from '../src/trading_leverage_tiers.js';
import { fxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const now = Date.now(), at = now - 20;
const usd = fxReceipt('usd', at, { value: '75000', envelope: { retCode: 0, retMsg: 'OK', result: { category: 'inverse',
  list: [{ symbol: 'BTCUSD', indexPrice: '75000' }] }, retExtInfo: {}, time: at } });
const usdt = fxReceipt('usdt', at, { value: '60000', envelope: { retCode: 0, retMsg: 'OK', result: { category: 'linear',
  list: [{ symbol: 'BTCUSDT', indexPrice: '60000' }] }, retExtInfo: {}, time: at } });
const fx = { id: 'e'.repeat(64), conversion: deriveFxConversion([usd, usdt], 'USDT', 'USD', now, FX_CONTEXT) };
const strategy = structuredClone(DEFAULT_STRATEGY_CONFIGURATION);
strategy.allowedSignalSchemas = ['standard'];
strategy.sizing = { ...strategy.sizing, positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '10',
  maxAdaptiveRiskPercent: '10', maxPositionNotional: '1000000', maxLeverage: 2, defaultLeverage: 2 };
strategy.entry = { ...strategy.entry, orderType: 'limit', rangePrice: 'midpoint' };
strategy.exits = { ...strategy.exits, targetAllocationMode: 'manual', targetAllocationsPercent: ['100'] };
const input = { intentId: 'fx-sizing', now, strategy, signal: { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT',
  entry: { type: 'range', min: '100', max: '100' }, stopLoss: '90', targets: [{ min: '110', max: '110' }], suggestedLeverage: 2 },
account: { equity: '1000', availableBalance: '1000', accounting: { reportingCurrency: 'USD' } },
market: { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.01', quantityStep: '0.001', minimumQuantity: '0.001',
  minimumNotional: '1', maxLeverage: 50, accounting: { version: 1, source: 'ccxt-market-v1', providerSymbol: 'BTC/USDT:USDT',
    settlementAsset: 'USDT', quantityUnit: 'base', linear: true } } };

assert.throws(() => createTradingPlan(input), /FX/, 'USD capital must not be silently divided by a USDT price.');
let plan = createTradingPlan({ ...input, fxConversion: fx });
assert.equal(plan.quantity, '1.6', '100 USD capital * 2 leverage / 1.25 USD-per-USDT / 100 USDT = 1.6 BTC.');
assert.equal(plan.fxSizing.reportingCurrency, 'USD');
assert.equal(plan.fxSizing.notionalCurrency, 'USDT');
assert.equal(plan.fxSizing.strategyMaximumNotionalCurrency, 'USDT');
assert.equal(plan.fxSizing.conversionId, fx.id);
assert.equal(plan.orders[1].triggerPrice, '90');

const riskStrategy = structuredClone(strategy);
riskStrategy.sizing.positionSizingMode = 'risk_percent'; riskStrategy.sizing.riskPerTradePercent = '2';
assert.equal(createTradingPlan({ ...input, strategy: riskStrategy, fxConversion: fx }).quantity, '1.6');
const notionalStrategy = structuredClone(strategy); notionalStrategy.sizing.positionSizingMode = 'equity_percent_notional';
assert.equal(createTradingPlan({ ...input, strategy: notionalStrategy, fxConversion: fx }).quantity, '0.8');
assert.equal(createTradingPlan({ ...input, account: { ...input.account, availableBalance: '10' }, fxConversion: fx }).quantity, '0.16');
const capStrategy = structuredClone(strategy); capStrategy.sizing.maxPositionNotional = '100';
assert.equal(createTradingPlan({ ...input, strategy: capStrategy, fxConversion: fx }).quantity, '1', 'Strategy notional cap retains explicit market-settlement units.');

const fractional = { id: 'f'.repeat(64), conversion: deriveFxConversion([fxReceipt('usd', at), fxReceipt('usdt', at)], 'USDT', 'USD', now, FX_CONTEXT) };
plan = createTradingPlan({ ...input, fxConversion: fractional });
assert.equal(plan.quantity, '2.005', 'Exact fraction survives through the final exchange quantity step.');
assert.throws(() => createTradingPlan({ ...input, fxConversion: { ...fx, conversion: { ...fx.conversion, baseAsset: 'USDC' } } }), /FX/);
assert.throws(() => createTradingPlan({ ...input, fxConversion: { ...fx, conversion: { ...fx.conversion, rate: { numerator: '1', denominator: '1' } } } }), /FX/);
assert.throws(() => createTradingPlan({ ...input, account: { ...input.account, accounting: { reportingCurrency: 'USDT' } }, fxConversion: fx }), /FX/);
const native = createTradingPlan({ ...input, account: { ...input.account, accounting: { reportingCurrency: 'USDT' } } });
assert.equal(native.quantity, '2');
assert.equal(native.fxSizing, undefined);
const tierMarket = { ...input.market, maxLeverage: 2, leverageTiers: { version: 1, exchange: 'bybit', symbol: 'BTCUSDT',
  providerSymbol: 'BTC/USDT:USDT', accountFingerprint: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64),
  ccxtVersion: '4.5.75', profileHash: FX_CONTEXT.profileHash, source: 'bybit_v5_risk_limit_mark_authenticated_scope_v1',
  currency: 'USDT', contractSize: '1', markPrice: '100', observedAt: now - 10, expiresAt: now + 9990,
  scope: { complete: true, positionQuantity: '0', openOrderCount: 0 }, tiers: [{ lowerBound: '0', upperBound: null, maxLeverage: 2 }] } };
const tierAccount = { exchange: 'bybit', externalAccountId: 'a'.repeat(64), credentialGeneration: 'b'.repeat(64),
  capabilities: { executionProfileHash: FX_CONTEXT.profileHash } };
const oddUsd = fxReceipt('usd', at, { value: '60001', envelope: { retCode: 0, retMsg: 'OK', result: { category: 'inverse',
  list: [{ symbol: 'BTCUSD', indexPrice: '60001' }] }, retExtInfo: {}, time: at } });
const oddFx = { id: 'd'.repeat(64), conversion: deriveFxConversion([oddUsd, fxReceipt('usdt', at)], 'USDT', 'USD', now, FX_CONTEXT) };
const tierPlan = createTradingPlan({ ...input, market: tierMarket, fxConversion: oddFx });
assert.equal(tierPlan.leverageTierDecision.version, 2);
assert.equal(tierPlan.leverageTierDecision.maximumNotional, null);
assert.deepEqual(tierPlan.leverageTierDecision.maximumNotionalValue.exact, { numerator: '12030000', denominator: '60001' });
assertPlanTierDecision(tierAccount, tierPlan, tierMarket);
assert.throws(() => assertTierDecisionBudget({ ...tierPlan.leverageTierDecision, maximumNotional: '201' }, 'USDT', tierPlan.quantity, '100', '100'));
assert.throws(() => assertTierDecisionBudget(tierPlan.leverageTierDecision, 'USD', tierPlan.quantity, '100', '100'));
assert.throws(() => assertTierDecisionBudget(tierPlan.leverageTierDecision, 'USDT', '2.005', '100', '100'), /budget/);
const realNow = Date.now;
try {
  Date.now = () => fx.conversion.expiresAt + 1;
  assert.throws(() => createTradingPlan({ ...input, fxConversion: fx }), /FX.*EXPIRED/);
} finally { Date.now = realNow; }
console.log('FX capital/risk/notional sizing, buying power, explicit cap currency and exact final quantization passed.');
