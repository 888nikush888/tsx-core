import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { bindAccountReportingCurrency } from '../src/trading_money_ledger.js';
import { captureFxReceipts } from '../src/trading_fx_repository.js';
import { prepareSizingFx } from '../src/trading_fx_sizing.js';
import { createTradingPlan } from '../src/trading_risk.js';
import { createRiskAdmission, verifyRiskAdmission, assertRiskAdmissionFresh } from '../src/trading_risk_admission.js';
import { DEFAULT_STRATEGY_CONFIGURATION } from '../src/trading_strategy.js';
import { runJournaledExchangeWrite } from '../src/trading_recovery.js';
import { requestFromOrder } from '../src/trading_order_request.js';
import { fxReceipt, sealFxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-sizing-admission-'));
const filename = path.join(directory, 'test.db'), realNow = Date.now;
const intentId = 'sizing-intent';
const now = realNow(), at = now - 100;
const strategy = structuredClone(DEFAULT_STRATEGY_CONFIGURATION);
strategy.allowedSignalSchemas = ['standard'];
strategy.sizing = { ...strategy.sizing, positionSizingMode: 'equity_percent_margin', riskPerTradePercent: '10',
  maxAdaptiveRiskPercent: '10', maxPositionNotional: '100000', maxLeverage: 2, defaultLeverage: 2 };
strategy.entry = { ...strategy.entry, orderType: 'limit', rangePrice: 'midpoint' };
strategy.exits = { ...strategy.exits, targetAllocationMode: 'manual', targetAllocationsPercent: ['100'] };
const signal = { schema: 'standard', action: 'LONG', symbol: 'BTCUSDT',
  entry: { type: 'range', min: '100', max: '100' }, stopLoss: '90', targets: [{ min: '110', max: '110' }], suggestedLeverage: 2 };
const market = { symbol: 'BTCUSDT', markPrice: '100', priceTick: '0.01', quantityStep: '0.001', minimumQuantity: '0.001',
  minimumNotional: '1', maxLeverage: 50, observedAt: now, accounting: { version: 1, source: 'ccxt-market-v1',
    providerSymbol: 'BTC/USDT:USDT', settlementAsset: 'USDT', quantityUnit: 'base', linear: true } };
function receipt(kind, value, time = at) {
  const result = fxReceipt(kind, time); result.value = value;
  result.envelope.result.list[0].indexPrice = value;
  return sealFxReceipt(result);
}
async function storePlan(account, plan) {
  const [published] = await listTradingStrategies();
  await saveSignal(intentId, '-fx-sizing', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,plan_json,created_at,updated_at)
    VALUES (?,?,?,'-fx-sizing',?,?,'bybit','testnet','BTCUSDT','LONG','submitting',?,?,?,?)`,
  [intentId, intentId, intentId, published.id, account.id, JSON.stringify(signal), JSON.stringify(plan), now, now]);
  for (const order of plan.orders.filter(row => ['entry', 'stop_loss'].includes(row.role))) {
    await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,role,side,order_type,
      status,quantity,filled_quantity,price,trigger_price,reduce_only,request_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'created',?,'0',?,?,?,'{}',?,?)`, [order.clientOrderId, intentId, account.id,
    order.clientOrderId, order.role, order.side, order.orderType, order.quantity, order.price, order.triggerPrice,
    Number(order.reduceOnly), now, now]);
  }
}
try {
  Date.now = () => now;
  await initDb(filename); await seedTradingFixtures();
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES ('fx-sizing','Local sizing proof','bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`,
  ['b'.repeat(64), 'c'.repeat(64), JSON.stringify({ profileVersion: 1, executionProfileHash: FX_CONTEXT.profileHash,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), now - 2000, now - 3000, now]);
  const account = await getTradingAccount('fx-sizing');
  await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: account.externalAccountId, profile: 'bybit',
    reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: now });
  const snapshot = { equity: '1000', availableBalance: '1000', unrealizedPnl: '0', marginUsed: '0', fundingPnlToday: '0',
    accounting: { accountFingerprint: account.externalAccountId, reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'],
      source: 'bybit-wallet-balance-v1', observedAt: now, unrealizedPnlSemantics: 'price_only',
      funding: { status: 'complete', since: new Date(now).setUTCHours(0, 0, 0, 0), until: now, events: [] } } };
  await assert.rejects(prepareSizingFx(account, snapshot, market), /FX/, 'No rate is not parity.');
  await captureFxReceipts(account, [receipt('usd', '75000'), receipt('usdt', '60000')], { startedAt: at - 20, completedAt: at + 20 });
  const sizingFx = await prepareSizingFx(account, snapshot, market);
  const plan = createTradingPlan({ intentId, signal, strategy, account: snapshot, market, fxConversion: sizingFx });
  assert.equal(plan.quantity, '1.6'); assert.equal(plan.stopPrice, '90');
  await storePlan(account, plan);
  const proof = await createRiskAdmission({ account, intentId, plan, market, snapshot, budget: '100', epoch: '0:0', sizingFx });
  assert.equal(proof.candidateCommitment, '20', '16 USDT stop exposure is 20 USD, not 16 USD.');
  await verifyRiskAdmission(proof, plan);
  await closeDb(); await initDb(filename);
  assert.deepEqual(await prepareSizingFx(account, snapshot, market, plan.fxSizing), sizingFx);
  await verifyRiskAdmission(proof, plan);
  await captureFxReceipts(account, [receipt('usd', '72000', at + 50), receipt('usdt', '60000', at + 50)],
    { startedAt: at + 30, completedAt: at + 70 });
  assert.deepEqual(await prepareSizingFx(account, snapshot, market, plan.fxSizing), sizingFx,
    'A prepared plan never silently switches to a later, more convenient rate.');
  const newSelection = await prepareSizingFx(account, snapshot, market);
  assert.notEqual(newSelection.id, sizingFx.id);
  await verifyRiskAdmission(proof, plan);
  const entry = plan.orders.find(order => order.role === 'entry'), stop = plan.orders.find(order => order.role === 'stop_loss');
  let sends = 0, checks = 0;
  await assert.rejects(runJournaledExchangeWrite({ account, intentId, kind: 'protected_entry',
    clientOrderIds: [entry.clientOrderId, stop.clientOrderId], request: { entry: requestFromOrder(account, plan, entry),
      protectiveStop: requestFromOrder(account, plan, stop) }, beforeDispatch: async () => {},
    beforeSend: async () => { await verifyRiskAdmission(proof, plan); checks += 1; Date.now = () => sizingFx.conversion.expiresAt + 1; },
    guard: () => assertRiskAdmissionFresh(proof), send: async () => { sends += 1; return []; }, persist: async rows => rows }),
  error => error.code === 'RISK_EVIDENCE_UNRESOLVED');
  assert.equal(checks, 1); assert.equal(sends, 0, 'Expiry between the DB proof and final synchronous fence prevents the send.');
  assert.equal((await getDatabase().get('SELECT phase FROM trading_operations WHERE intent_id=?', [intentId])).phase, 'abandoned');
  await assert.rejects(prepareSizingFx(account, snapshot, market, plan.fxSizing), /FX.*EXPIRED/);
  Date.now = () => now;
  await captureFxReceipts(account, [receipt('usd', '74000')], { startedAt: at - 20, completedAt: at + 20 });
  await assert.rejects(verifyRiskAdmission(proof, plan), error => error.code === 'RISK_EVIDENCE_UNRESOLVED');
  await assert.rejects(prepareSizingFx(account, snapshot, market, plan.fxSizing), /FX/);
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE intent_id=? AND role='stop_loss'", [intentId])).status, 'created');
  console.log('Stored FX originals bind sizing, risk and the final journal time fence; no provider or account-safety bypass.');
} finally {
  Date.now = realNow; await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
