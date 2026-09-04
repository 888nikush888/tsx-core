import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { resolveEffectiveChannelRisk, resolveWorkflowAdaptiveRisk, getWorkflowAdaptiveRiskAnalytics,
  listChannelRiskEvaluations, upsertChannelRiskPolicy } from '../src/trading_channel_risk.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { addSignedDecimal } from '../src/trading_decimal.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { insertAccountedFill } from './fixtures/accounted_trades.js';
import { bindAccountReportingCurrency, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { captureFxReceipts } from '../src/trading_fx_repository.js';
import { valueFxAccountMoney, valueFxMoneyEvent } from '../src/trading_fx_valuation.js';
import { captureFillAccounting, projectAccountFillAccounting } from '../src/trading_fill_accounting.js';
import { provenFillIdentity } from '../src/trading_fill_identity.js';
import { nativeFillFixture } from './fixtures/native_fill_identity.js';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';
import { createWorkflowResourceDraft, publishWorkflowResource } from '../src/workflow_repository.js';
import { channelReturnThreshold, channelReturnValue } from '../src/trading_channel_risk_math.js';
import { moneyValueFromDecimal, moneyValueFromRational } from '../src/trading_money_value.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-channel-risk-'));
const filename = path.join(directory, 'risk.db');
const now = Date.UTC(2026, 7, 31, 12);
const closedAt = now - 86400000;
let strategyId;
const strategy = { ...structuredClone(DEFAULT_STRATEGY_CONFIGURATION), sizing: {
  ...DEFAULT_STRATEGY_CONFIGURATION.sizing, maxAdaptiveRiskPercent: '10' } };
const policy = (channelId, changes = {}) => ({ channelId, mode: 'automatic',
  tiers: [{ riskPercent: '0.5' }, { riskPercent: '1' }, { riskPercent: '1.5' }], currentTier: 1,
  lookbackWeeks: 1, minimumClosedTrades: 1, lossThresholdPercent: '0.000000000000000001',
  profitThresholdPercent: '0.000000000000000001', weakChannelAction: 'none', weakWeeksBeforeBlock: 2, ...changes });

async function closedPaper(channel, pnl) {
  const id = `intent-${channel}`, account = await getTradingAccount('paper-default');
  await saveSignal(id, channel, 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'paper','paper','BTCUSDT','LONG','completed','{}',?,?)`,
  [id, id, id, channel, strategyId, account.id, closedAt - 1000, closedAt]);
  await insertAccountedFill({ intentId: id, id: `${channel}-entry`, price: '100', quantity: '1', fee: '0', filledAt: closedAt - 100 });
  await insertAccountedFill({ intentId: id, id: `${channel}-exit`, role: 'flatten', price: addSignedDecimal('100', pnl),
    quantity: '1', fee: '0', filledAt: closedAt });
  await getDatabase().run(`INSERT INTO trading_positions(id,intent_id,account_id,strategy_version_id,channel_id,symbol,side,status,
    quantity,average_entry_price,stop_price,realized_pnl,opened_at,closed_at,updated_at)
    VALUES (?,?,?, ?,?,'BTCUSDT','LONG','closed','0','100','90','777',?,?,?)`,
  [`position-${channel}`, id, account.id, strategyId, channel, closedAt - 1000, closedAt, closedAt]);
  return account;
}

async function tinyNegativeRemainsNeutral() {
  const channelId = 'tiny-native-loss', account = await closedPaper(channelId, '-0.000000000000000001');
  await upsertChannelRiskPolicy(policy(channelId), now);
  const result = await resolveEffectiveChannelRisk({ channelId, accountId: account.id, reportingCurrency: 'USDT',
    currentEquity: '1000', strategy, now });
  assert.equal(result.blocked, false);
  assert.equal(result.riskPercent, '1');
  const evaluation = (await listChannelRiskEvaluations()).find(item => item.channelId === channelId);
  assert.equal(evaluation.action, 'hold');
  assert.deepEqual(evaluation.realizedPnlValue.exact, { numerator: '-1', denominator: '1000000000000000000' });
  assert.deepEqual(evaluation.returnPercentValue.exact, { numerator: '-1', denominator: '10000000000000000000' });
  assert.equal(evaluation.returnPercent, null, 'A tiny negative percent is neither zero nor a positive threshold magnitude.');
}

const evaluations = () => getDatabase().all('SELECT * FROM trading_channel_risk_evaluations ORDER BY id');
const resolve = (channelId, account, overrides = {}) => resolveEffectiveChannelRisk({ channelId, accountId: account.id,
  reportingCurrency: account.exchange === 'paper' ? 'USDT' : 'USD', currentEquity: '100', strategy, now, ...overrides });

async function fxAccount(id) {
  await getDatabase().run(`INSERT INTO trading_accounts(id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES (?,?,'bybit','testnet','ready',1,'fixture-only',?,?,?,?,?,?)`, [id, id,
  createHash('sha256').update(id).digest('hex'), 'c'.repeat(64), JSON.stringify({ profileVersion: 1,
    executionProfileHash: FX_CONTEXT.profileHash, executionCapabilities: { provider_api_version: 'bybit-v5' } }), closedAt - 1000, closedAt - 1000, closedAt]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: closedAt });
  return account;
}

async function quotes(account, at = closedAt - 200, usd = '60000', usdt = '60150') {
  const originals = ['usd', 'usdt'].map(kind => {
    const receipt = fxReceipt(kind, at), value = kind === 'usd' ? usd : usdt;
    receipt.value = value; receipt.envelope.result.list[0].indexPrice = value;
    return sealFxReceipt(receipt);
  });
  await captureFxReceipts(account, originals, { startedAt: at - 20, completedAt: at + 20 });
}

async function fxClosedTrade(account, channel, id, fee, at = closedAt) {
  await saveSignal(id, channel, 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents(id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'bybit','testnet','BTCUSDT','LONG','completed','{}',?,?)`, [id, id, id, channel, strategyId, account.id, at - 1000, at]);
  for (const role of ['entry', 'flatten']) {
    const key = `${id}-${role}`, timestamp = role === 'entry' ? at - 100 : at;
    const raw = nativeFillFixture('bybit', { exchangeFillId: key, exchangeOrderId: `remote-${key}`, clientOrderId: key,
      symbol: 'BTCUSDT', providerSymbol: 'BTC/USDT:USDT', price: '100', quantity: '1', fee: role === 'entry' ? fee : '0', feeAsset: 'USDT', filledAt: timestamp });
    raw.accounting = { version: 1, source: 'ccxt-market-v1', providerSymbol: 'BTC/USDT:USDT', settlementAsset: 'USDT', linear: true, quantityUnit: 'base' };
    const identity = provenFillIdentity(account, raw); assert.ok(identity);
    await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,exchange_order_id,provider_symbol,
      role,side,order_type,status,price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
      VALUES (?,?,?,?,?,'BTC/USDT:USDT',?,?,'limit','filled','100','1','1',?,'{}',?,?)`,
    [key, id, account.id, key, raw.exchangeOrderId, role, role === 'entry' ? 'buy' : 'sell', Number(role !== 'entry'), timestamp, timestamp]);
    await getDatabase().run(`INSERT INTO trading_fills(id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,
      filled_at,raw_json,remote_fill_key,provider_symbol,identity_status,identity_json)
      VALUES (?,?,?,?,'100','1',?,'USDT',?,?,?,'BTC/USDT:USDT','proven',?)`,
    [`fill-${key}`, key, account.id, key, raw.fee, timestamp, JSON.stringify(raw.raw), identity.key, JSON.stringify(identity.identity)]);
    await captureFillAccounting(account, raw, `fill-${key}`);
  }
  await getDatabase().run(`INSERT INTO trading_positions(id,intent_id,account_id,strategy_version_id,channel_id,symbol,side,status,
    quantity,average_entry_price,stop_price,realized_pnl,opened_at,closed_at,updated_at)
    VALUES (?,?,?,?,?,'BTCUSDT','LONG','closed','0','100','90','777',?,?,?)`,
  [`position-${id}`, id, account.id, strategyId, channel, at - 1000, at, at]);
  await projectAccountFillAccounting(account.id);
  await valueFxAccountMoney(account);
  await projectAccountFillAccounting(account.id);
}

async function rationalThresholdAndCurrency() {
  const account = await fxAccount('fx-channel-rational'), channel = 'rational-return';
  await quotes(account); await fxClosedTrade(account, channel, 'rational-trade', '-1');
  await upsertChannelRiskPolicy(policy(channel, { profitThresholdPercent: '0.9975' }), now);
  const result = await resolve(channel, account);
  assert.equal(result.riskPercent, '1.5', JSON.stringify(result));
  const evaluation = (await listChannelRiskEvaluations()).find(row => row.channelId === channel);
  assert.equal(evaluation.realizedPnl, null); assert.equal(evaluation.returnPercent, null);
  assert.deepEqual(evaluation.realizedPnlValue.exact, { numerator: '400', denominator: '401' });
  assert.deepEqual(evaluation.returnPercentValue.exact, { numerator: '400', denominator: '401' });
  assert.equal(evaluation.reportingCurrency, 'USD');
  const before = (await evaluations()).find(row => row.id === evaluation.id);
  assert.equal(JSON.parse(before.source_json).capital.basis, 'current_bound_input');
  assert.equal((await resolve(channel, account, { currentEquity: '100000' })).riskPercent, '1.5', 'Replay keeps its original capital anchor.');
  assert.deepEqual((await evaluations()).find(row => row.id === evaluation.id), before);
  await upsertChannelRiskPolicy(policy('wrong-input-currency'), now);
  assert.equal((await resolve('wrong-input-currency', account, { reportingCurrency: 'USDC' })).blocked, true);
  return { account, channel, before };
}

async function exactEqualityAndLegacyProvenance() {
  const channel = 'equal-profit', account = await closedPaper(channel, '1');
  await upsertChannelRiskPolicy(policy(channel, { profitThresholdPercent: '1' }), now);
  assert.equal((await resolve(channel, account)).riskPercent, '1.5');
  const row = (await evaluations()).find(item => item.channel_id === channel);
  await getDatabase().run(`UPDATE trading_channel_risk_evaluations SET realized_pnl_value_json=NULL,return_percent_value_json=NULL,
    reporting_currency=NULL,source_hash=NULL,source_json=NULL WHERE id=?`, [row.id]);
  const legacy = (await listChannelRiskEvaluations()).find(item => item.id === row.id);
  assert.equal(legacy.realizedPnl, '1'); assert.equal(legacy.realizedPnlValue.decimal, '1');
  assert.equal(legacy.sourceHash, null);
  const blocked = await resolve(channel, account);
  assert.equal(blocked.blocked, true); assert.match(blocked.reason, /provenance/);
  const invalidated = (await evaluations()).find(item => item.id === row.id);
  assert.equal(invalidated.source_hash, null); assert.equal(invalidated.source_json, null);
  assert.equal(invalidated.realized_pnl, '1'); assert.equal(invalidated.invalidated_at, now);
}

async function originalCacheInvalidation({ account, channel, before }) {
  await closeDb(); await initDb(filename);
  assert.equal((await resolve(channel, account)).blocked, false);
  await quotes(account, closedAt + 1, '61000');
  assert.equal((await resolve(channel, account)).blocked, false, 'A later quote cannot reprice historical originals.');
  await quotes(account, closedAt - 200, '61000');
  assert.equal((await resolve(channel, account)).blocked, true);
  const after = (await evaluations()).find(row => row.id === before.id);
  assert.equal(after.source_json, before.source_json); assert.equal(after.source_hash, before.source_hash);
  assert.equal(after.realized_pnl_value_json, before.realized_pnl_value_json);
  assert.equal(after.return_percent_value_json, before.return_percent_value_json);
  assert.equal(after.invalidated_at, now); assert.match(after.invalidation_reason, /unresolved|incomplete/);
  assert.equal((await resolve(channel, account, { now: now + 7 * 86400000 })).blocked, true, 'No weekly revival of an invalidated aggressive tier.');
}

function boundedAndLargeMath() {
  const interval = (lower, upper) => ({ lower, upper, exact: null, decimal: null, precision: 'bounded', terms: 2 });
  assert.equal(channelReturnThreshold(interval('1', '1.000000000000000001'), '100', '1'), 'reached');
  assert.equal(channelReturnThreshold(interval('0.999999999999999999', '1'), '100', '1'), 'uncertain');
  assert.equal(channelReturnThreshold(interval('-1.000000000000000001', '-1'), '100', '1', true), 'reached');
  assert.equal(channelReturnThreshold(interval('-1', '-0.999999999999999999'), '100', '1', true), 'uncertain');
  assert.equal(channelReturnValue(interval('1', '1.000000000000000001'), '0.01').value, null, 'Do not inflate terms to disguise scaled interval width.');
  const large = moneyValueFromRational({ numerator: String(10n ** 255n + 1n), denominator: String(10n ** 255n + 3n) });
  assert.deepEqual(channelReturnValue(large, '100').value?.exact, large.exact, 'Final identity scaling must not fail on an oversized public intermediate.');
  assert.equal(channelReturnThreshold(moneyValueFromDecimal('999999999999999999999999999999999999'),
    '999999999999999999999999999999999999', '100'), 'reached');
}

async function boundedOriginalHistory() {
  const account = await fxAccount('fx-channel-bounded'), channel = 'bounded-history';
  for (let index = 0; index < 10; index++) {
    const at = closedAt + index * 500;
    await quotes(account, at - 200, '1', String(10n ** 35n + BigInt(index * 2 + 1)));
    await fxClosedTrade(account, channel, `bounded-${index}`, '-1', at);
  }
  await upsertChannelRiskPolicy(policy(channel), now);
  const automatic = await resolve(channel, account);
  assert.equal(automatic.blocked, true); assert.match(automatic.reason, /RISK_PRECISION_UNCERTAIN/);
  const evaluation = (await listChannelRiskEvaluations()).find(row => row.channelId === channel);
  assert.equal(evaluation.realizedPnlValue.precision, 'bounded'); assert.equal(evaluation.realizedPnl, null);
  assert.equal(evaluation.returnPercentValue, null); assert.match(evaluation.returnPercentReason, /bounded/);
  assert.equal(evaluation.recommendedTier, 1); assert.equal(evaluation.action, 'hold');
  await upsertChannelRiskPolicy(policy(channel, { mode: 'shadow' }), now);
  const shadow = await resolve(channel, account);
  assert.equal(shadow.blocked, false); assert.equal(shadow.riskPercent, strategy.sizing.riskPerTradePercent);
  assert.match(shadow.reason, /RISK_PRECISION_UNCERTAIN/);
  assert.match((await resolve(channel, account)).reason, /RISK_PRECISION_UNCERTAIN/, 'Cached shadow evaluations keep their uncertainty visible.');
}

async function mixedAndManualModes() {
  const channel = 'mixed-channel', paper = await closedPaper(channel, '1'), account = await fxAccount('fx-mixed');
  await quotes(account); await fxClosedTrade(account, channel, 'mixed-fx-trade', '-1');
  await upsertChannelRiskPolicy(policy(channel), now);
  assert.equal((await resolve(channel, paper)).blocked, true, 'USD and USDT histories cannot share an implicit scalar sum.');
  await upsertChannelRiskPolicy(policy(channel, { mode: 'shadow' }), now);
  const shadow = await resolve(channel, paper);
  assert.equal(shadow.blocked, false); assert.match(shadow.reason, /Shadow only:.*unresolved/);
  await upsertChannelRiskPolicy(policy(channel, { mode: 'fixed' }), now);
  assert.equal((await resolve(channel, paper)).blocked, false);
  await upsertChannelRiskPolicy(policy(channel, { lockedTier: 2 }), now);
  const locked = await resolve(channel, paper);
  assert.equal(locked.blocked, false); assert.equal(locked.riskPercent, '1.5', 'A deliberate manual tier does not claim automatic history authority.');
  await upsertChannelRiskPolicy(policy(channel, { manuallyBlocked: true }), now);
  assert.equal((await resolve(channel, paper)).blocked, true);
  await assert.rejects(upsertChannelRiskPolicy(policy('above-ten', { tiers: [{ riskPercent: '10.000000000000000001' }] })), /must not exceed 10/);
  const other = await fxAccount('fx-same-currency-other');
  await quotes(other);
  await fxClosedTrade(account, 'same-units-two-accounts', 'same-units-first', '-1');
  await fxClosedTrade(other, 'same-units-two-accounts', 'same-units-second', '-1');
  await upsertChannelRiskPolicy(policy('same-units-two-accounts'), now);
  const ambiguous = await resolve('same-units-two-accounts', account);
  assert.equal(ambiguous.blocked, true); assert.match(ambiguous.reason, /ambiguous account/);
  return { channel, paper, account };
}

async function workflowInput(channelId, account, changes = {}) {
  const configuration = { enabled: true, mode: 'automatic', tiers: policy(channelId).tiers, startingTier: 1, lockedTier: null,
    lookbackWeeks: 1, minimumClosedTrades: 1, lossThresholdPercent: '1', profitThresholdPercent: '1',
    weakChannelAction: 'none', weakWeeksBeforeBlock: 2, manuallyBlocked: false, ...changes };
  const draft = await createWorkflowResourceDraft({ kind: 'adaptive_risk', name: `Local ${channelId}`, configuration });
  const resource = await publishWorkflowResource(draft.id);
  return { channelId, accountId: account.id, reportingCurrency: account.exchange === 'paper' ? 'USDT' : 'USD',
    adaptiveResourceVersionId: resource.id, configuration, strategy, currentEquity: '100', now };
}

async function workflowUnitsAndMaximum({ channel, paper, account }) {
  const input = await workflowInput(channel, paper);
  const boundedStrategy = { ...strategy, sizing: { ...strategy.sizing, riskPerTradePercent: '0.25', maxAdaptiveRiskPercent: '0.75' } };
  const automatic = await resolveWorkflowAdaptiveRisk({ ...input, strategy: boundedStrategy });
  assert.equal(automatic.blocked, false); assert.equal(automatic.riskPercent, '0.75');
  const analytics = await getWorkflowAdaptiveRiskAnalytics();
  const evaluation = analytics.evaluations.find(row => row.accountId === paper.id && row.channelId === channel);
  assert.equal(evaluation.reportingCurrency, 'USDT'); assert.equal(evaluation.realizedPnlValue.decimal, '1');
  assert.ok(evaluation.sourceHash);
  const wrong = await workflowInput(channel, account);
  const wrongResult = await resolveWorkflowAdaptiveRisk({ ...wrong, reportingCurrency: 'USDC' });
  assert.equal(wrongResult.blocked, true); assert.match(wrongResult.reason, /currency/);
  const fixed = await workflowInput(channel, account, { mode: 'fixed' });
  assert.equal((await resolveWorkflowAdaptiveRisk({ ...fixed, reportingCurrency: undefined })).blocked, false);
  const locked = await workflowInput(channel, account, { lockedTier: 2 });
  assert.equal((await resolveWorkflowAdaptiveRisk(locked)).riskPercent, '1.5');
}

async function lateFeesInvalidateWorkflow() {
  const account = await fxAccount('fx-channel-late'), channel = 'late-fee-channel', intentId = 'late-fee-trade';
  await quotes(account); await fxClosedTrade(account, channel, intentId, '-1');
  await getDatabase().run(`INSERT INTO trading_orders(id,intent_id,account_id,client_order_id,exchange_order_id,provider_symbol,
    role,side,order_type,status,trigger_price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES ('remaining-stop',?,?,'remaining-stop','remote-remaining-stop','BTC/USDT:USDT',
    'stop_loss','sell','stop_market','open','90','1','0',1,'{}',?,?)`, [intentId, account.id, closedAt, closedAt]);
  const input = await workflowInput(channel, account, { profitThresholdPercent: '0.99' });
  assert.equal((await resolveWorkflowAdaptiveRisk(input)).riskPercent, '1.5');
  const before = await getDatabase().get('SELECT * FROM workflow_adaptive_risk_evaluations WHERE state_key IN (SELECT state_key FROM workflow_adaptive_risk_state WHERE account_id=?)', [account.id]);
  const orders = await getDatabase().all('SELECT * FROM trading_orders ORDER BY id');
  const event = await recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId, intentId,
    providerEventId: 'actual-late-fee-adjustment', kind: 'fee', source: 'fixture-provider-adjustment', basis: 'provider',
    occurredAt: closedAt - 50, amount: '-2', asset: 'USDT' });
  await valueFxMoneyEvent(account, event.id);
  const failed = await resolveWorkflowAdaptiveRisk(input);
  assert.equal(failed.blocked, true); assert.match(failed.reason, /sources changed/);
  const after = await getDatabase().get('SELECT * FROM workflow_adaptive_risk_evaluations WHERE id=?', [before.id]);
  assert.equal(after.source_json, before.source_json); assert.equal(after.realized_pnl_value_json, before.realized_pnl_value_json);
  assert.equal(after.invalidated_at, now);
  await closeDb(); await initDb(filename);
  assert.equal((await resolveWorkflowAdaptiveRisk({ ...input, now: now + 7 * 86400000 })).blocked, true);
  assert.deepEqual(await getDatabase().all('SELECT * FROM trading_orders ORDER BY id'), orders);
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE id='remaining-stop'")).status, 'open');
}

try {
  await initDb(filename); await seedTradingFixtures();
  strategyId = (await listTradingStrategies())[0].id;
  await tinyNegativeRemainsNeutral();
  boundedAndLargeMath();
  const rational = await rationalThresholdAndCurrency();
  await exactEqualityAndLegacyProvenance();
  await originalCacheInvalidation(rational);
  await boundedOriginalHistory();
  await workflowUnitsAndMaximum(await mixedAndManualModes());
  await lateFeesInvalidateWorkflow();
  console.log('Adaptive channel risk: tiny/rational thresholds, exact equality, currency/provenance binding and restart invalidation passed.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
