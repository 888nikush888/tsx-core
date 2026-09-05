import { getDatabase, saveSignal } from '../../src/db.js';
import { createHash } from 'node:crypto';
import { addDecimal, compareDecimal, subtractDecimal } from '../../src/trading_decimal.js';
import { getTradingAccount, listTradingStrategies } from '../../src/trading_repository.js';
import { completeSafetyState } from './safety_acquisition.js';
import { historyCheckpoints } from '../../src/trading_history_repository.js';
import { nativeFillFixture } from './native_fill_identity.js';

export async function emergencyFixture(id, { partial = true, exchange = 'paper', localQuantity = '0' } = {}) {
  const fixtureSince = Date.now() - 1_000;
  const [strategy] = await listTradingStrategies();
  const mode = exchange === 'paper' ? 'paper' : 'testnet';
  const fingerprint = createHash('sha256').update(id).digest('hex');
  const providerSymbol = { paper: 'BTCUSDT', bybit: 'BTC/USDT:USDT', hyperliquid: 'BTC/USDC:USDC', krakenfutures: 'BTC/USD:USD' }[exchange];
  await getDatabase().run(
    `INSERT INTO trading_accounts (id, name, exchange, mode, status, enabled, credential_ref, external_account_id, credential_generation, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ready', 1, ?, ?, ?, 1, 1)`, [id, id, exchange, mode, exchange === 'paper' ? null : `fixture:${id}`, fingerprint, 'b'.repeat(64)]);
  const entry = { clientOrderId: `${id}-entry`, role: 'entry', side: 'buy', orderType: 'limit', quantity: partial ? '2' : '1', price: '100',
    triggerPrice: null, reduceOnly: false, postOnly: false, targetIndex: null };
  const stop = { ...entry, clientOrderId: `${id}-stop`, role: 'stop_loss', side: 'sell', orderType: 'stop_market', price: null,
    triggerPrice: '90', reduceOnly: true };
  const plan = { version: 1, symbol: 'BTCUSDT', leverage: 1, orders: [entry, stop], createdAt: Date.now(), entryOrderTtlSeconds: 900,
    entryTimeoutSeconds: 12, maxSlippagePercent: '1', quantityStep: '0.1' };
  await saveSignal(id, '-emergency', 1, '<signal/>', '<signal/>');
  await getDatabase().run(
    `INSERT INTO trading_trade_intents (id, source_signal_id, root_source_signal_id, channel_id, strategy_version_id, account_id,
     exchange, mode, symbol, side, status, signal_json, plan_json, created_at, updated_at)
     VALUES (?, ?, ?, '-emergency', ?, ?, ?, ?, 'BTCUSDT', 'LONG', 'monitoring', '{}', ?, 1, 1)`,
    [id, id, id, strategy.id, id, exchange, mode, JSON.stringify(plan)]);
  await getDatabase().run(
    `INSERT INTO trading_positions (id, intent_id, account_id, strategy_version_id, channel_id, symbol, side, status,
     quantity, average_entry_price, stop_price, updated_at)
     VALUES (?, ?, ?, ?, '-emergency', 'BTCUSDT', 'LONG', 'open', ?, '100', '90', 1)`, [id, id, id, strategy.id, localQuantity]);
  const state = { exchange, providerSymbol, entries: '1', foreign: '0', orders: new Map(), foreignOrders: [], foreignPositions: [], fills: [], flattenCalls: [], cancelCalls: [],
    cancelEntry: false, hideFlattens: false, loseNextFlattenAck: false };
  for (const order of [entry, stop]) {
    const isEntry = order.role === 'entry';
    const remote = { ...order, exchangeOrderId: `remote-${order.clientOrderId}`, providerSymbol, symbol: 'BTCUSDT',
      status: isEntry ? partial ? 'partially_filled' : 'filled' : 'open', filledQuantity: isEntry ? '1' : '0',
      averagePrice: isEntry ? '100' : null, error: null, raw: {} };
    state.orders.set(order.clientOrderId, remote);
    await getDatabase().run(
      `INSERT INTO trading_orders (id, intent_id, account_id, client_order_id, exchange_order_id, provider_symbol, role, side,
       order_type, status, quantity, filled_quantity, average_price, price, trigger_price, reduce_only, request_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
      [order.clientOrderId, id, id, order.clientOrderId, remote.exchangeOrderId, providerSymbol, order.role, order.side,
        order.orderType, remote.status, order.quantity, remote.filledQuantity, remote.averagePrice, order.price, order.triggerPrice,
        order.reduceOnly ? 1 : 0, JSON.stringify(order)]);
  }
  await getDatabase().run('UPDATE trading_accounts SET created_at = ? WHERE id = ?', [fixtureSince, id]);
  await getDatabase().run('UPDATE trading_orders SET created_at = ? WHERE account_id = ?', [fixtureSince, id]);
  const fill = (order, quantity) => nativeFillFixture(exchange, { clientOrderId: order.clientOrderId, exchangeOrderId: order.exchangeOrderId,
    exchangeFillId: `${id}-fill-${state.fills.length}`, symbol: 'BTCUSDT', providerSymbol, price: '100', quantity, fee: '0',
    feeAsset: 'USDT', filledAt: Date.now(), raw: {} }, `${id}-provider-account`);
  state.fills.push(fill(state.orders.get(entry.clientOrderId), '1'));
  state.addEntryFill = quantity => {
    const order = state.orders.get(entry.clientOrderId);
    state.entries = addDecimal(state.entries, quantity);
    order.filledQuantity = state.entries;
    if (state.entries === order.quantity) order.status = 'filled';
    state.fills.push(fill(order, quantity));
  };
  state.owned = () => subtractDecimal(state.entries, state.flattenCalls.reduce((total, order) => addDecimal(total, order.quantity), '0'));
  const adapter = {
    exchange,
    openState: async () => {
      const quantity = addDecimal(state.owned(), state.foreign);
      const checkpoints = exchange === 'hyperliquid' || exchange === 'krakenfutures'
        ? await historyCheckpoints(await getTradingAccount(id), fixtureSince) : [];
      const snapshot = completeSafetyState({ orders: [
        ...[...state.orders.values()].filter(order => !state.hideFlattens || order.role !== 'flatten').map(order => ({ ...order })),
        ...state.foreignOrders.map(order => ({ ...order })),
      ],
        fills: state.fills.filter(row => !state.hideFlattens || row.clientOrderId === entry.clientOrderId).map(row => ({ ...row })),
        positions: [
          ...(compareDecimal(quantity, '0') > 0 ? [{ symbol: 'BTCUSDT', providerSymbol, side: 'LONG', quantity, averageEntryPrice: '100', unrealizedPnl: '0' }] : []),
          ...state.foreignPositions.map(position => ({ ...position })),
        ],
        accountFingerprint: fingerprint });
      if (exchange === 'hyperliquid' || exchange === 'krakenfutures') {
        const through = snapshot.acquisition.completedAt;
        const previous = checkpoints.find(checkpoint => checkpoint.source === 'fills');
        snapshot.acquisition.history = [{ baseRevision: previous.revision, pages: 1, checkpoint: { ...previous,
          providerAccountUid: exchange === 'krakenfutures' ? `${id}-provider-account` : null,
          revision: previous.revision + 1, cursor: null, scannedThrough: through,
          completeness: 'complete', reason: null, coverage: { version: 1,
            profile: exchange === 'hyperliquid' ? 'hyperliquid_retained_fills_v1' : 'kraken_v3_executions_v1', since: fixtureSince, through } } }];
      }
      return snapshot;
    },
    cancelOrder: async (_account, clientId) => {
      state.cancelCalls.push(clientId);
      const order = state.orders.get(clientId);
      if (order.role !== 'entry' || state.cancelEntry) order.status = 'cancelled';
      return { ...order };
    },
    submitOrder: async (_account, request) => {
      if (request.role !== 'flatten' || !request.reduceOnly || request.side !== 'sell') throw new Error('Emergency must only reduce owned exposure.');
      if (compareDecimal(request.quantity, state.owned()) > 0) throw new Error('Emergency attempted to reduce more than owned.');
      if (state.orders.has(request.clientOrderId)) throw new Error('Duplicate economic submission.');
      state.flattenCalls.push({ ...request });
      const order = { ...request, exchangeOrderId: `remote-${request.clientOrderId}`, providerSymbol, symbol: 'BTCUSDT',
        status: 'filled', filledQuantity: request.quantity, averagePrice: '100', error: null, raw: {} };
      state.orders.set(request.clientOrderId, order);
      state.fills.push(fill(order, request.quantity));
      if (state.loseNextFlattenAck) { state.loseNextFlattenAck = false; throw new Error('Connection lost after flatten acceptance.'); }
      return { ...order };
    },
  };
  return { id, account: await getTradingAccount(id), state, adapter };
}
