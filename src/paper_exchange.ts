import { randomUUID } from 'node:crypto';
import { getDatabase } from './db.js';
import {
  addSignedDecimal,
  compareDecimal,
  decimal,
  divideDecimal,
  minDecimal,
  multiplyDecimal,
  signedDecimal,
  signedDifference,
  subtractDecimal,
} from './trading_decimal.js';
import type {
  ExchangeOpenState,
  ExchangeOrderRequest,
  ExchangeOrderResult,
  TradingAccount,
  TradingAccountSnapshot,
  TradingExchangeAdapter,
  TradingMarketSnapshot,
} from './trading_types.js';

function assertPaperAccount(account: TradingAccount): void {
  if (account.exchange !== 'paper' || account.mode !== 'paper') throw new Error('Paper adapter only accepts paper accounts.');
}

function boolean(value: unknown): boolean {
  return Number(value) === 1;
}

function signedMultiply(value: string, multiplier: string): string {
  const normalized = signedDecimal(value);
  const negative = normalized.startsWith('-');
  const result = multiplyDecimal(negative ? normalized.slice(1) : normalized, multiplier);
  return negative && result !== '0' ? `-${result}` : result;
}

function orderResult(row: any): ExchangeOrderResult {
  return {
    clientOrderId: String(row.client_order_id),
    exchangeOrderId: String(row.exchange_order_id),
    status: row.status,
    filledQuantity: String(row.filled_quantity || '0'),
    averagePrice: row.average_price || null,
    error: null,
    raw: { paper: true, updatedAt: Number(row.updated_at) },
  };
}

function orderCanFill(row: any, markPrice: string): boolean {
  if (row.order_type === 'market') return true;
  if (row.order_type === 'stop_market') {
    return row.side === 'sell'
      ? compareDecimal(markPrice, row.trigger_price) <= 0
      : compareDecimal(markPrice, row.trigger_price) >= 0;
  }
  return row.side === 'buy'
    ? compareDecimal(markPrice, row.price) <= 0
    : compareDecimal(markPrice, row.price) >= 0;
}

async function transaction<T>(operation: () => Promise<T>): Promise<T> {
  const database = getDatabase();
  await database.exec('BEGIN IMMEDIATE');
  try {
    const result = await operation();
    await database.exec('COMMIT');
    return result;
  } catch (error) {
    await database.exec('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function updateOpeningPosition(row: any, fillQuantity: string, fillPrice: string, now: number): Promise<void> {
  const database = getDatabase();
  const account = await database.get<any>('SELECT * FROM trading_paper_accounts WHERE account_id = ?', [row.account_id]);
  if (!account) throw new Error('Paper account balance is missing.');
  const margin = divideDecimal(multiplyDecimal(fillQuantity, fillPrice), String(row.leverage || 1));
  if (compareDecimal(account.available_balance, margin) < 0) throw new Error('Paper account has insufficient available balance.');
  const existing = await database.get<any>(
    'SELECT * FROM trading_paper_positions WHERE account_id = ? AND symbol = ?',
    [row.account_id, row.symbol],
  );
  const side = row.side === 'buy' ? 'LONG' : 'SHORT';
  if (existing && existing.side !== side) throw new Error('Paper exchange refuses implicit position reversal.');
  if (existing) {
    const quantity = addSignedDecimal(existing.quantity, fillQuantity);
    const weighted = addSignedDecimal(
      multiplyDecimal(existing.quantity, existing.average_entry_price),
      multiplyDecimal(fillQuantity, fillPrice),
    );
    await database.run(
      `UPDATE trading_paper_positions
       SET quantity = ?, average_entry_price = ?, margin_used = ?, updated_at = ?
       WHERE account_id = ? AND symbol = ?`,
      [
        quantity,
        divideDecimal(weighted, quantity),
        addSignedDecimal(existing.margin_used, margin),
        now,
        row.account_id,
        row.symbol,
      ],
    );
  } else {
    await database.run(
      `INSERT INTO trading_paper_positions (
         account_id, symbol, side, quantity, average_entry_price, margin_used, realized_pnl, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, '0', ?)`,
      [row.account_id, row.symbol, side, fillQuantity, fillPrice, margin, now],
    );
  }
  await database.run(
    `UPDATE trading_paper_accounts SET available_balance = ?, updated_at = ? WHERE account_id = ?`,
    [subtractDecimal(account.available_balance, margin), now, row.account_id],
  );
}

async function cancelOrphanedReduceOrders(accountId: string, symbol: string, now: number): Promise<void> {
  await getDatabase().run(
    `UPDATE trading_paper_orders SET status = 'cancelled', updated_at = ?
     WHERE account_id = ? AND symbol = ? AND reduce_only = 1 AND status IN ('open', 'partially_filled')`,
    [now, accountId, symbol],
  );
}

async function updateClosingPosition(row: any, requestedQuantity: string, fillPrice: string, now: number): Promise<string> {
  const database = getDatabase();
  const position = await database.get<any>(
    'SELECT * FROM trading_paper_positions WHERE account_id = ? AND symbol = ?',
    [row.account_id, row.symbol],
  );
  if (!position) return '0';
  const expectedSide = position.side === 'LONG' ? 'sell' : 'buy';
  if (row.side !== expectedSide) throw new Error('Reduce-only paper order has the wrong side.');
  const fillQuantity = minDecimal(requestedQuantity, position.quantity);
  const priceDifference = position.side === 'LONG'
    ? signedDifference(fillPrice, position.average_entry_price)
    : signedDifference(position.average_entry_price, fillPrice);
  const pnl = signedMultiply(priceDifference, fillQuantity);
  const releasedMargin = divideDecimal(multiplyDecimal(position.margin_used, fillQuantity), position.quantity);
  const remaining = subtractDecimal(position.quantity, fillQuantity);
  const remainingMargin = subtractDecimal(position.margin_used, releasedMargin);
  const account = await database.get<any>('SELECT * FROM trading_paper_accounts WHERE account_id = ?', [row.account_id]);
  if (!account) throw new Error('Paper account balance is missing.');
  await database.run(
    `UPDATE trading_paper_accounts
     SET equity = ?, available_balance = ?, realized_pnl = ?, updated_at = ?
     WHERE account_id = ?`,
    [
      addSignedDecimal(account.equity, pnl),
      addSignedDecimal(addSignedDecimal(account.available_balance, releasedMargin), pnl),
      addSignedDecimal(account.realized_pnl, pnl),
      now,
      row.account_id,
    ],
  );
  if (remaining === '0') {
    await database.run('DELETE FROM trading_paper_positions WHERE account_id = ? AND symbol = ?', [row.account_id, row.symbol]);
    await cancelOrphanedReduceOrders(row.account_id, row.symbol, now);
  } else {
    await database.run(
      `UPDATE trading_paper_positions
       SET quantity = ?, margin_used = ?, realized_pnl = ?, updated_at = ?
       WHERE account_id = ? AND symbol = ?`,
      [remaining, remainingMargin, addSignedDecimal(position.realized_pnl, pnl), now, row.account_id, row.symbol],
    );
  }
  return fillQuantity;
}

async function fillOrder(row: any, markPrice: string, now: number): Promise<any> {
  const fillPrice = row.order_type === 'limit' ? row.price : markPrice;
  let fillQuantity = row.quantity;
  if (boolean(row.reduce_only)) fillQuantity = await updateClosingPosition(row, row.quantity, fillPrice, now);
  else await updateOpeningPosition(row, fillQuantity, fillPrice, now);
  const status = fillQuantity === '0' ? 'cancelled' : 'filled';
  await getDatabase().run(
    `UPDATE trading_paper_orders
     SET status = ?, filled_quantity = ?, average_price = ?, updated_at = ?
     WHERE exchange_order_id = ?`,
    [status, fillQuantity, fillQuantity === '0' ? null : fillPrice, now, row.exchange_order_id],
  );
  if (fillQuantity !== '0') {
    const fillId = `paper-fill-${randomUUID()}`;
    const raw = { paper: true, orderId: row.exchange_order_id, markPrice };
    await getDatabase().run(
      `INSERT INTO trading_paper_fills (
         exchange_fill_id, exchange_order_id, account_id, client_order_id,
         price, quantity, fee, fee_asset, filled_at, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, '0', NULL, ?, ?)`,
      [fillId, row.exchange_order_id, row.account_id, row.client_order_id, fillPrice, fillQuantity, now, JSON.stringify(raw)],
    );
  }
  return getDatabase().get('SELECT * FROM trading_paper_orders WHERE exchange_order_id = ?', [row.exchange_order_id]);
}

async function settleOpenOrders(accountId: string, symbol: string, markPrice: string, now: number): Promise<void> {
  const orders = await getDatabase().all<any[]>(
    `SELECT * FROM trading_paper_orders
     WHERE account_id = ? AND symbol = ? AND status IN ('open', 'partially_filled')
     ORDER BY CASE role WHEN 'stop_loss' THEN 0 WHEN 'take_profit' THEN 1 ELSE 2 END, created_at`,
    [accountId, symbol],
  );
  for (const order of orders) {
    const current = await getDatabase().get<any>(
      'SELECT * FROM trading_paper_orders WHERE exchange_order_id = ?',
      [order.exchange_order_id],
    );
    if (current?.status === 'open' && orderCanFill(current, markPrice)) await fillOrder(current, markPrice, now);
  }
}

export class PaperExchangeAdapter implements TradingExchangeAdapter {
  readonly exchange = 'paper' as const;

  async setBalance(accountId: string, equity: string, availableBalance = equity, now = Date.now()): Promise<void> {
    const normalizedEquity = decimal(equity, { positive: true });
    const normalizedAvailable = decimal(availableBalance);
    if (compareDecimal(normalizedAvailable, normalizedEquity) > 0) throw new Error('Available paper balance cannot exceed equity.');
    await getDatabase().run(
      `UPDATE trading_paper_accounts SET equity = ?, available_balance = ?, updated_at = ? WHERE account_id = ?`,
      [normalizedEquity, normalizedAvailable, now, accountId],
    );
  }

  async setMarket(accountId: string, market: Omit<TradingMarketSnapshot, 'observedAt'>, now = Date.now()): Promise<void> {
    const symbol = market.symbol.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw new Error('Invalid paper market symbol.');
    const values = [market.markPrice, market.priceTick, market.quantityStep, market.minimumQuantity, market.minimumNotional]
      .map(value => decimal(value, { positive: true }));
    if (!Number.isSafeInteger(market.maxLeverage) || market.maxLeverage < 1 || market.maxLeverage > 125) {
      throw new Error('Paper market max leverage must be between 1 and 125.');
    }
    await transaction(async () => {
      await getDatabase().run(
        `INSERT INTO trading_paper_markets (
           account_id, symbol, mark_price, price_tick, quantity_step,
           minimum_quantity, minimum_notional, max_leverage, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, symbol) DO UPDATE SET
           mark_price = excluded.mark_price, price_tick = excluded.price_tick,
           quantity_step = excluded.quantity_step, minimum_quantity = excluded.minimum_quantity,
           minimum_notional = excluded.minimum_notional, max_leverage = excluded.max_leverage,
           updated_at = excluded.updated_at`,
        [accountId, symbol, ...values, market.maxLeverage, now],
      );
      await settleOpenOrders(accountId, symbol, values[0]!, now);
    });
  }

  async accountSnapshot(account: TradingAccount): Promise<TradingAccountSnapshot> {
    assertPaperAccount(account);
    const row = await getDatabase().get<any>('SELECT * FROM trading_paper_accounts WHERE account_id = ?', [account.id]);
    if (!row) throw new Error('Paper account state is missing.');
    return {
      equity: decimal(row.equity, { positive: true }),
      availableBalance: decimal(row.available_balance),
    };
  }

  async marketSnapshot(account: TradingAccount, symbol: string): Promise<TradingMarketSnapshot> {
    assertPaperAccount(account);
    const row = await getDatabase().get<any>(
      'SELECT * FROM trading_paper_markets WHERE account_id = ? AND symbol = ?',
      [account.id, symbol],
    );
    if (!row) throw new Error(`Paper market ${symbol} is not configured.`);
    return {
      symbol: row.symbol,
      markPrice: row.mark_price,
      priceTick: row.price_tick,
      quantityStep: row.quantity_step,
      minimumQuantity: row.minimum_quantity,
      minimumNotional: row.minimum_notional,
      maxLeverage: Number(row.max_leverage),
      observedAt: Number(row.updated_at),
    };
  }

  async submitOrder(account: TradingAccount, request: ExchangeOrderRequest): Promise<ExchangeOrderResult> {
    assertPaperAccount(account);
    return transaction(async () => {
      const existing = await getDatabase().get<any>(
        'SELECT * FROM trading_paper_orders WHERE account_id = ? AND client_order_id = ?',
        [account.id, request.clientOrderId],
      );
      if (existing) return orderResult(existing);
      const market = await this.marketSnapshot(account, request.symbol);
      const now = Date.now();
      const exchangeOrderId = `paper-order-${randomUUID()}`;
      await getDatabase().run(
        `INSERT INTO trading_paper_orders (
           exchange_order_id, account_id, client_order_id, symbol, role, side,
           order_type, status, quantity, filled_quantity, average_price, price,
           trigger_price, reduce_only, target_index, leverage, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, '0', NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [
          exchangeOrderId, account.id, request.clientOrderId, request.symbol, request.role,
          request.side, request.orderType, decimal(request.quantity, { positive: true }),
          request.price, request.triggerPrice, request.reduceOnly ? 1 : 0,
          request.targetIndex, request.leverage, now, now,
        ],
      );
      let row = await getDatabase().get<any>('SELECT * FROM trading_paper_orders WHERE exchange_order_id = ?', [exchangeOrderId]);
      if (orderCanFill(row, market.markPrice)) row = await fillOrder(row, market.markPrice, now);
      return orderResult(row);
    });
  }

  async cancelOrder(account: TradingAccount, clientOrderId: string): Promise<ExchangeOrderResult> {
    assertPaperAccount(account);
    const now = Date.now();
    await getDatabase().run(
      `UPDATE trading_paper_orders SET status = 'cancelled', updated_at = ?
       WHERE account_id = ? AND client_order_id = ? AND status IN ('open', 'partially_filled')`,
      [now, account.id, clientOrderId],
    );
    const row = await getDatabase().get<any>(
      'SELECT * FROM trading_paper_orders WHERE account_id = ? AND client_order_id = ?',
      [account.id, clientOrderId],
    );
    if (!row) throw new Error('Paper order does not exist.');
    return orderResult(row);
  }

  async openState(account: TradingAccount): Promise<ExchangeOpenState> {
    assertPaperAccount(account);
    const [orders, positions, fills] = await Promise.all([
      getDatabase().all<any[]>('SELECT * FROM trading_paper_orders WHERE account_id = ? ORDER BY created_at', [account.id]),
      getDatabase().all<any[]>('SELECT * FROM trading_paper_positions WHERE account_id = ? ORDER BY symbol', [account.id]),
      getDatabase().all<any[]>('SELECT * FROM trading_paper_fills WHERE account_id = ? ORDER BY filled_at', [account.id]),
    ]);
    return {
      orders: orders.map(row => ({
        ...orderResult(row),
        symbol: row.symbol,
        role: row.role,
        side: row.side,
        quantity: row.quantity,
        price: row.price || null,
        triggerPrice: row.trigger_price || null,
        reduceOnly: boolean(row.reduce_only),
      })),
      positions: positions.map(row => ({
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        averageEntryPrice: row.average_entry_price,
        unrealizedPnl: '0',
      })),
      fills: fills.map(row => ({
        exchangeFillId: row.exchange_fill_id,
        clientOrderId: row.client_order_id,
        price: row.price,
        quantity: row.quantity,
        fee: row.fee,
        feeAsset: row.fee_asset || null,
        filledAt: Number(row.filled_at),
        raw: JSON.parse(row.raw_json),
      })),
      observedAt: Date.now(),
    };
  }
}
