import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { persistCorrelatedFill } from '../src/trading_evidence_repository.js';
import { projectAccountFillAccounting } from '../src/trading_fill_accounting.js';
import { projectAccountLogMoney } from '../src/trading_account_log_money.js';
import { accountLogCheckpoint, persistAccountLogProgress } from '../src/trading_account_log_repository.js';
import { bindAccountReportingCurrency, getMoneyEvent, moneyLedgerSnapshot } from '../src/trading_money_ledger.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { logProgress } from './fixtures/account_log.js';

// Synthetic originals following Kraken v3 execution/account-log shapes; never provider requests.
const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-kraken-cashlegs-'));
const filename = path.join(directory, 'test.db');
const now = Date.now(), occurredAt = now - 2000;
const uid = '11111111-1111-4111-8111-111111111111';
const execution = '22222222-2222-4222-8222-222222222222';
const remoteOrder = '33333333-3333-4333-8333-333333333333';

async function seedNativeTrade() {
  await seedTradingFixtures();
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,created_at,updated_at)
    VALUES ('cashleg','Cashleg','krakenfutures','testnet','ready',1,'fixture',?,?,?,?)`,
  ['a'.repeat(64), 'b'.repeat(64), occurredAt, now]);
  const account = await getTradingAccount('cashleg');
  await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: account.externalAccountId,
    profile: 'krakenfutures', reportingCurrency: 'USD', settlementAssets: ['USD'],
    source: 'fixture-explicit-native-usd-account-binding', verifiedAt: now });
  const [strategy] = await listTradingStrategies();
  await saveSignal('cashleg-signal', '-cashleg', 1, '<signal/>', '<cashleg/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES ('cashleg-intent','cashleg-signal','cashleg-signal','-cashleg',?,'cashleg','krakenfutures',
      'testnet','BTCUSD','LONG','monitoring','{}',?,?)`, [strategy.id, occurredAt, now]);
  await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,exchange_order_id,
    provider_symbol,role,side,order_type,status,price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES ('cashleg-order','cashleg-intent','cashleg','cashleg-client',?,'BTC/USD:USD','entry','buy','limit',
      'filled','100','1','1',0,'{}',?,?)`, [remoteOrder, occurredAt, now]);
  const raw = { id: execution, order: remoteOrder, clientOrderId: 'cashleg-client', symbol: 'BTC/USD:USD',
    side: 'buy', timestamp: occurredAt, price: '100', amount: '1', fee: { cost: '0.01', currency: null },
    info: { providerEventId: '44444444-4444-4444-8444-444444444444', identitySource: 'kraken_history_execution_v3',
      executionUid: execution, orderUid: remoteOrder, tradeable: 'PF_XBTUSD', accountUid: uid, executionTimestamp: occurredAt } };
  const fill = { exchangeFillId: execution, clientOrderId: 'cashleg-client', exchangeOrderId: remoteOrder,
    symbol: 'BTCUSD', providerSymbol: 'BTC/USD:USD', price: '100', quantity: '1', fee: '0.01', feeAsset: null,
    filledAt: occurredAt, raw, accounting: { version: 1, source: 'ccxt-market-v1', providerSymbol: 'BTC/USD:USD',
      settlementAsset: 'USD', linear: true, quantityUnit: 'base' },
    identity: { version: 1, profile: 'kraken_history_execution_v3', marketNamespace: 'futures', providerMarketId: 'PF_XBTUSD',
      providerSymbol: 'BTC/USD:USD', providerFillId: execution, scopeTimestamp: null } };
  const persisted = await persistCorrelatedFill(account, fill);
  assert.equal(persisted.inserted, true, 'The existing native identity/ownership path must establish the real fill first.');
  return { account, fillId: persisted.fillId };
}

function originalLegs() {
  const shared = { date: new Date(occurredAt).toISOString(), contract: 'PF_XBTUSD', info: 'futures trade',
    margin_account: 'flex', execution, collateral: 'usd', trade_price: '100', mark_price: '100',
    realized_pnl: '0', realized_funding: '0', liquidation_fee: '0' };
  return [
    { ...shared, id: '1', booking_uid: '55555555-5555-4555-8555-555555555555', asset: 'PF_XBTUSD',
      old_balance: '0', new_balance: '1', fee: '0' },
    { ...shared, id: '2', booking_uid: '66666666-6666-4666-8666-666666666666', asset: 'usd',
      old_balance: '100', new_balance: '99.99', fee: '0.01' },
  ];
}

try {
  await initDb(filename);
  const { account, fillId } = await seedNativeTrade();
  await projectAccountFillAccounting(account.id);
  const originalEvent = await getDatabase().get("SELECT * FROM trading_money_events WHERE fill_id=? AND kind='fee'", [fillId]);
  assert.equal((await getMoneyEvent(originalEvent.id)).valuationStatus, 'unresolved');
  assert.equal(originalEvent.asset, null, 'The execution source itself does not document its fee currency.');
  const checkpoint = await accountLogCheckpoint(account);
  const progress = logProgress(checkpoint, originalLegs(), now);
  progress.receipts[0].providerAccountUid = uid;
  progress.checkpoint.providerAccountUid = uid;
  await persistAccountLogProgress(account, progress);
  await projectAccountLogMoney(account);
  await projectAccountFillAccounting(account.id);
  const valued = await getMoneyEvent(originalEvent.id);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_account_log_consumers WHERE status<>'complete'")).n, 0,
    JSON.stringify(await getDatabase().all('SELECT result_json FROM trading_account_log_consumers')));
  assert.equal(valued.reportingAmount, '-0.01',
    'A unique original USD cash leg bound to the actual owned execution must value its existing fee once.');
  assert.equal(valued.asset, null, 'Later native valuation evidence must not rewrite the original unknown fee asset.');
  const preserved = await getDatabase().get('SELECT content_json FROM trading_money_events WHERE id=?', [originalEvent.id]);
  assert.equal(preserved.content_json, originalEvent.content_json);
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_money_events WHERE account_id=? AND kind='fee'", [account.id])).n, 1);
  assert.equal((await moneyLedgerSnapshot(account.id, occurredAt - 1, now + 1)).fees, '-0.01');
  assert.equal((await getDatabase().get("SELECT COUNT(*) AS n FROM trading_account_log_consumers WHERE status<>'complete'")).n, 0);
  await closeDb(); await initDb(filename);
  await projectAccountLogMoney(account); await projectAccountFillAccounting(account.id);
  assert.equal((await getMoneyEvent(originalEvent.id)).reportingAmount, '-0.01');
  assert.equal((await getDatabase().all('PRAGMA foreign_key_check')).length, 0);
  console.log('Kraken original execution/cash-leg fee correlation, immutable valuation and restart replay passed.');
} finally { await closeDb(); await rm(directory, { recursive: true, force: true }); }
