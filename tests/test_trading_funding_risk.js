import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { TradingEngine } from '../src/trading_engine.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { bindAccountReportingCurrency } from '../src/trading_money_ledger.js';
import { accountLogCheckpoint, persistAccountLogProgress } from '../src/trading_account_log_repository.js';
import { observedFundingEvidence } from '../src/trading_funding_observation.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { logProgress } from './fixtures/account_log.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-funding-risk-'));
const now = Date.now(), fingerprint = 'a'.repeat(64), generation = 'b'.repeat(64);
const market = { version: 1, source: 'ccxt-market-v1', providerSymbol: 'BTC/USDC:USDC',
  settlementAsset: 'USDC', linear: true, quantityUnit: 'base' };
async function seedExposure() {
  await seedTradingFixtures();
  const [strategy] = await listTradingStrategies();
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,external_account_id,
    credential_generation,created_at,updated_at) VALUES ('funding-risk','Fixture','hyperliquid','testnet','ready',1,'fake',?,?,?,?)`,
  [fingerprint, generation, now - 1000, now]);
  const account = await getTradingAccount('funding-risk');
  await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: fingerprint, profile: 'hyperliquid',
    reportingCurrency: 'USDC', settlementAssets: ['USDC'], source: 'hyperliquid-clearinghouse-state-v1', verifiedAt: now });
  await saveSignal('funding-risk-signal', '-risk', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,strategy_version_id,
    account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES ('funding-intent','funding-risk-signal','funding-risk-signal','-risk',?,'funding-risk','hyperliquid','testnet','BTCUSDC','LONG','monitoring','{}',?,?)`,
  [strategy.id, now - 1000, now]);
  for (const role of ['entry', 'stop_loss']) await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,
    exchange_order_id,provider_symbol,role,side,order_type,status,price,trigger_price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES (?,'funding-intent','funding-risk',?,?,'BTC/USDC:USDC',?,?,?,?,?,?,'10',?,?,'{}',?,?)`,
  [role, `client-${role}`, `remote-${role}`, role, role === 'entry' ? 'buy' : 'sell', role === 'entry' ? 'limit' : 'stop_market',
    role === 'entry' ? 'partially_filled' : 'open', role === 'entry' ? '100' : null, role === 'entry' ? null : '90',
    role === 'entry' ? '1' : '0', role === 'entry' ? 0 : 1, now - 1000, now]);
  await getDatabase().run(`INSERT INTO trading_fills (id,order_id,account_id,exchange_fill_id,price,quantity,fee,fee_asset,filled_at,raw_json,account_fingerprint,accounting_json)
    VALUES ('own-fill','entry','funding-risk','exec-1','100','1','0','USDC',?,'{}',?,?)`, [now - 500, fingerprint, JSON.stringify(market)]);
  await getDatabase().run(`INSERT INTO trading_positions (id,intent_id,account_id,strategy_version_id,channel_id,symbol,side,status,quantity,
    average_entry_price,stop_price,opened_at,updated_at) VALUES ('position','funding-intent','funding-risk',?,'-risk','BTCUSDC','LONG','open','1','100','90',?,?)`,
  [strategy.id, now - 500, now]);
  return account;
}
async function append(account, records) {
  await persistAccountLogProgress(account, logProgress(await accountLogCheckpoint(account), records));
}
try {
  await initDb(path.join(directory, 'test.db'));
  const account = await seedExposure();
  const remote = { observedAt: now, positions: [{ symbol: 'BTCUSDC', providerSymbol: market.providerSymbol, side: 'LONG',
    quantity: '1', averageEntryPrice: '100', markPrice: '100', accounting: market }], orders: [{ symbol: 'BTCUSDC', providerSymbol: market.providerSymbol,
    clientOrderId: 'client-stop_loss', exchangeOrderId: 'remote-stop_loss', role: 'stop_loss', side: 'sell', orderType: 'stop_market',
    status: 'open', triggerPrice: '90', quantity: '10', filledQuantity: '0', reduceOnly: true }] };
  let reads = 0;
  const adapter = { exchange: 'hyperliquid', accountSnapshot: async () => {
    reads += 1;
    const funding = await observedFundingEvidence(account);
    return { equity: '10000', availableBalance: '9000', unrealizedPnl: '0', marginUsed: '1000', observedAt: Date.now(),
      fundingPnlToday: funding.observation.amount, accounting: { accountFingerprint: fingerprint, reportingCurrency: 'USDC',
        settlementAssets: ['USDC'], source: 'hyperliquid-clearinghouse-state-v1', observedAt: Date.now(), unrealizedPnlSemantics: 'price_only', funding } };
  } };
  const engine = new TradingEngine([adapter]);
  await append(account, []);
  await engine.refreshAccountRiskAfterProtection(account, adapter, remote);
  assert.equal((await getDatabase().get("SELECT entry_drain_requested_at FROM trading_orders WHERE id='entry'")).entry_drain_requested_at, null);
  await append(account, [{ type: 'funding', hash: `0x${'0'.repeat(64)}`, coin: 'BTC', time: String(now), usdc: '-1' }]);
  await engine.refreshAccountRiskAfterProtection(account, adapter, remote);
  assert.equal(reads, 2, 'One existing post-protection balance read per complete pass.');
  assert.equal((await getDatabase().get("SELECT balance_reason FROM trading_risk_current WHERE account_id='funding-risk'")).balance_reason, 'MAX_DAILY_RISK');
  assert.ok((await getDatabase().get("SELECT entry_drain_requested_at FROM trading_orders WHERE id='entry'")).entry_drain_requested_at);
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE id='stop_loss'")).status, 'open');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE kind='funding'")).n, 1);
  console.log('Late durable native funding revises actual risk, queues entry drainage and preserves the confirmed stop.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
