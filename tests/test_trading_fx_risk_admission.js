import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDatabase, initDb, saveSignal } from '../src/db.js';
import { seedTradingFixtures } from './trading_fixtures.js';
import { getTradingAccount, listTradingStrategies } from '../src/trading_repository.js';
import { bindAccountReportingCurrency, recordMoneyEvent } from '../src/trading_money_ledger.js';
import { captureFxReceipts } from '../src/trading_fx_repository.ts';
import { valueFxMoneyEvent } from '../src/trading_fx_valuation.ts';
import { createRiskAdmission, verifyRiskAdmission } from '../src/trading_risk_admission.js';
import { fxReceipt, FX_CONTEXT } from './fixtures/fx_receipts.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'tsx-fx-risk-admission-'));
try {
  await initDb(path.join(directory, 'test.db')); await seedTradingFixtures();
  const now = Date.now(), at = now - 100;
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,capabilities_json,last_verified_at,created_at,updated_at)
    VALUES ('fx-risk','Local synthetic risk fixture','bybit','testnet','ready',1,'fixture',?,?,?,?,?,?)`,
  ['a'.repeat(64), 'b'.repeat(64), JSON.stringify({ executionProfileHash: FX_CONTEXT.profileHash, profileVersion: 1,
    executionCapabilities: { provider_api_version: 'bybit-v5' } }), now - 2000, now - 3000, now]);
  const account = await getTradingAccount('fx-risk'), [strategy] = await listTradingStrategies();
  await bindAccountReportingCurrency({ accountId: account.id, accountFingerprint: account.externalAccountId,
    profile: 'bybit', reportingCurrency: 'USD', settlementAssets: ['USDT', 'USDC'], source: 'bybit-wallet-balance-v1', verifiedAt: now });
  const funding = await recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId,
    providerEventId: 'funding-local', amount: '-10', asset: 'USDT', occurredAt: at, kind: 'funding', basis: 'provider', source: 'fixture' });
  await captureFxReceipts(account, [fxReceipt('usd', at), fxReceipt('usdt', at)], { startedAt: at - 20, completedAt: at + 20 });
  await valueFxMoneyEvent(account, funding.id);
  const orders = [{ role: 'entry', clientOrderId: 'fx-entry', quantity: '1', price: '95', triggerPrice: null,
    orderType: 'limit', side: 'buy', reduceOnly: false }, { role: 'stop_loss', clientOrderId: 'fx-stop', quantity: '1', price: null,
    triggerPrice: '90', orderType: 'stop_market', side: 'sell', reduceOnly: true }];
  // A synthetic native USD market isolates historical FX risk. It does not attest an actual Bybit market.
  const plan = { version: 1, side: 'LONG', symbol: 'SYNTHUSD', stopPrice: '90', quantity: '1', orders, createdAt: now };
  await saveSignal('fx-risk-signal', '-fx-risk', 1, '<signal/>', '<signal/>');
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,plan_json,created_at,updated_at)
    VALUES ('fx-candidate','fx-risk-signal','fx-risk-signal','-fx-risk',?,?,'bybit','testnet','SYNTHUSD','LONG','submitting','{}',?,?,?)`,
  [strategy.id, account.id, JSON.stringify(plan), now, now]);
  for (const order of orders) await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,
    role,side,order_type,status,quantity,filled_quantity,price,trigger_price,reduce_only,request_json,created_at,updated_at)
    VALUES (?,'fx-candidate',?,?,?,?,?,'created',?,'0',?,?,?,'{}',?,?)`, [order.clientOrderId, account.id,
  order.clientOrderId, order.role, order.side, order.orderType, order.quantity, order.price, order.triggerPrice, Number(order.reduceOnly), now, now]);
  const accounting = { accountFingerprint: account.externalAccountId, reportingCurrency: 'USD', settlementAssets: ['USD'],
    source: 'fixture', observedAt: now, unrealizedPnlSemantics: 'price_only', funding: { status: 'complete',
      since: new Date(now).setUTCHours(0, 0, 0, 0), until: now, events: [] } };
  const input = { account, intentId: 'fx-candidate', plan, epoch: '0:0', budget: '15',
    market: { observedAt: now, accounting: { version: 1, source: 'ccxt-market-v1', providerSymbol: 'SYNTHUSD',
      settlementAsset: 'USD', linear: true, quantityUnit: 'base' } },
    snapshot: { equity: '1000', availableBalance: '1000', unrealizedPnl: '0', fundingPnlToday: null, accounting } };
  const proof = await createRiskAdmission(input);
  assert.equal(proof.candidateCommitment, '5');
  await verifyRiskAdmission(proof, plan);
  await assert.rejects(createRiskAdmission({ ...input, budget: '14.97' }), error => error.code === 'MAX_DAILY_RISK');
  await assert.rejects(createRiskAdmission({ ...input, budget: '9.97' }), error => error.code === 'MAX_DAILY_LOSS');
  const later = await recordMoneyEvent({ accountId: account.id, accountFingerprint: account.externalAccountId,
    providerEventId: 'new-tiny-fee', amount: '-0.000000000000000001', asset: 'USDT', occurredAt: at,
    kind: 'fee', basis: 'provider', source: 'fixture' });
  await assert.rejects(verifyRiskAdmission(proof, plan), error => error.code === 'ACCOUNTING_INCOMPLETE');
  await valueFxMoneyEvent(account, later.id);
  await assert.rejects(verifyRiskAdmission(proof, plan), /monetary evidence changed/);
  assert.equal((await getDatabase().get("SELECT status FROM trading_orders WHERE id='fx-stop'")).status, 'created');
  console.log('Exact rational historical costs affect risk admission; late valuation invalidates proofs without changing stop orders.');
} finally {
  await closeDb(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
