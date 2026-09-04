import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, saveSignal } from '../../src/db.js';
import { getTradingAccount, listTradingStrategies } from '../../src/trading_repository.js';
import { persistCorrelatedFill } from '../../src/trading_evidence_repository.js';
import { projectAccountFillAccounting } from '../../src/trading_fill_accounting.js';
import { accountLogCheckpoint, persistAccountLogProgress } from '../../src/trading_account_log_repository.js';
import { bindAccountReportingCurrency } from '../../src/trading_money_ledger.js';
import { addSignedDecimal, negateSignedDecimal } from '../../src/trading_decimal.js';
import { seedTradingFixtures } from '../trading_fixtures.js';
import { logProgress } from './account_log.js';

export async function cashlegAccount(id, now = Date.now(), report = 'USD') {
  await seedTradingFixtures();
  const fingerprint = createHash('sha256').update(id).digest('hex');
  await getDatabase().run(`INSERT INTO trading_accounts (id,name,exchange,mode,status,enabled,credential_ref,
    external_account_id,credential_generation,created_at,updated_at)
    VALUES (?,?,'krakenfutures','testnet','ready',1,'fixture',?,?,?,?)`, [id, id, fingerprint, 'b'.repeat(64), now - 5000, now]);
  const account = await getTradingAccount(id);
  await bindAccountReportingCurrency({ accountId: id, accountFingerprint: fingerprint, profile: 'krakenfutures',
    reportingCurrency: report, settlementAssets: [report], source: 'fixture-explicit-native-reporting-binding', verifiedAt: now });
  const [strategy] = await listTradingStrategies();
  const intentId = `intent-${id}`;
  await saveSignal(id, '-cashleg', 1, '<signal/>', `<signal>${id}</signal>`);
  await getDatabase().run(`INSERT INTO trading_trade_intents (id,source_signal_id,root_source_signal_id,channel_id,
    strategy_version_id,account_id,exchange,mode,symbol,side,status,signal_json,created_at,updated_at)
    VALUES (?,?,?,'-cashleg',?,?,'krakenfutures','testnet','BTCUSD','LONG','monitoring','{}',?,?)`,
  [intentId, id, id, strategy.id, id, now - 5000, now]);
  return { account, intentId, strategyId: strategy.id, uid: randomUUID(), now };
}

export async function cashlegFill(context, options = {}) {
  const { account, intentId, uid, now } = context;
  const { fee = '0.01', feeAsset = null, quantity = '1', price = '100', occurredAt = now - 2000, role = 'entry' } = options;
  const execution = randomUUID(), remoteOrder = randomUUID(), orderId = randomUUID(), clientId = randomUUID();
  const side = role === 'entry' ? 'buy' : 'sell';
  await getDatabase().run(`INSERT INTO trading_orders (id,intent_id,account_id,client_order_id,exchange_order_id,
    provider_symbol,role,side,order_type,status,price,quantity,filled_quantity,reduce_only,request_json,created_at,updated_at)
    VALUES (?,?,?,?,?,'BTC/USD:USD',?,?,'limit','filled',?,?,?,?, '{}',?,?)`,
  [orderId, intentId, account.id, clientId, remoteOrder, role, side, price, quantity, quantity, Number(role !== 'entry'), occurredAt, now]);
  const raw = { id: execution, order: remoteOrder, clientOrderId: clientId, symbol: 'BTC/USD:USD',
    side, timestamp: occurredAt, price, amount: quantity, fee: { cost: fee, currency: feeAsset },
    info: { providerEventId: randomUUID(), identitySource: 'kraken_history_execution_v3', executionUid: execution,
      orderUid: remoteOrder, tradeable: 'PF_XBTUSD', accountUid: uid, executionTimestamp: occurredAt } };
  Object.assign(raw, options.rawPatch ?? {});
  const fill = { exchangeFillId: execution, clientOrderId: clientId, exchangeOrderId: remoteOrder, symbol: 'BTCUSD',
    providerSymbol: 'BTC/USD:USD', price, quantity, fee, feeAsset, filledAt: occurredAt, raw,
    accounting: { version: 1, source: 'ccxt-market-v1', providerSymbol: 'BTC/USD:USD', settlementAsset: 'USD', linear: true, quantityUnit: 'base' },
    identity: { version: 1, profile: 'kraken_history_execution_v3', marketNamespace: 'futures', providerMarketId: 'PF_XBTUSD',
      providerSymbol: 'BTC/USD:USD', providerFillId: execution, scopeTimestamp: null } };
  const stored = await persistCorrelatedFill(account, fill);
  assert.equal(stored.inserted, true);
  if (options.legacyMoneyId) {
    const original = { accountId: account.id, accountFingerprint: account.externalAccountId, providerEventId: 'legacy-envelope-id',
      kind: 'fee', source: 'krakenfutures:legacy-own-fill', basis: 'fill', occurredAt, amount: negateSignedDecimal(fee), asset: feeAsset,
      intentId, fillId: stored.fillId };
    await getDatabase().run(`INSERT INTO trading_money_events
      (id,account_id,account_fingerprint,provider_event_id,kind,source,basis,occurred_at,amount,asset,intent_id,fill_id,content_json,recorded_at)
      VALUES (?,?,?,'legacy-envelope-id','fee','krakenfutures:legacy-own-fill','fill',?,?,?,?,?,?,?)`,
    [options.legacyMoneyId, account.id, account.externalAccountId, occurredAt, original.amount, feeAsset, intentId, stored.fillId, JSON.stringify(original), now]);
  }
  await projectAccountFillAccounting(account.id);
  const event = await getDatabase().get("SELECT * FROM trading_money_events WHERE fill_id=? AND kind='fee'", [stored.fillId]);
  return { ...context, fill, fillId: stored.fillId, eventId: event.id, original: event, orderId };
}

export function cashlegRows(trade, options = {}) {
  const { fill } = trade;
  const { startId = 1, pnl = '0', funding = '0', asset = 'usd', oldPosition = '0', oldCash = '100' } = options;
  const shared = { date: new Date(fill.filledAt).toISOString(), contract: 'PF_XBTUSD', info: 'futures trade',
    margin_account: 'flex', execution: fill.exchangeFillId, collateral: asset, trade_price: fill.price, mark_price: fill.price,
    realized_pnl: pnl, realized_funding: funding, liquidation_fee: '0' };
  return [
    { ...shared, id: String(startId), booking_uid: randomUUID(), asset: 'PF_XBTUSD', old_balance: oldPosition,
      new_balance: addSignedDecimal(oldPosition, fill.raw.side === 'buy' ? fill.quantity : negateSignedDecimal(fill.quantity)), fee: '0' },
    { ...shared, id: String(startId + 1), booking_uid: randomUUID(), asset, old_balance: oldCash,
      new_balance: addSignedDecimal(oldCash, addSignedDecimal(addSignedDecimal(pnl, funding), negateSignedDecimal(fill.fee))), fee: fill.fee },
  ];
}

export async function appendCashlegs(context, records, options = {}) {
  const checkpoint = await accountLogCheckpoint(context.account);
  const cursor = Object.hasOwn(options, 'cursor') ? options.cursor : records.length ? String(BigInt(records.at(-1).id) + 1n) : null;
  const progress = logProgress(checkpoint, records, context.now, cursor);
  progress.receipts[0].providerAccountUid = options.uid ?? context.uid;
  progress.checkpoint.providerAccountUid = options.uid ?? context.uid;
  await persistAccountLogProgress(context.account, progress);
  const receipt = await getDatabase().get('SELECT id FROM trading_account_log_receipts WHERE account_id=? ORDER BY sequence DESC LIMIT 1', [context.account.id]);
  return receipt.id;
}
