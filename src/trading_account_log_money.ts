import { getDatabase } from './db.js';
import { signedDecimal } from './trading_decimal.js';
import { recordMoneyEvent } from './trading_money_ledger.js';
import { pendingAccountLogReceipts, setAccountLogConsumerResult } from './trading_account_log_repository.js';
import { accountLogDigest, type AccountLogRecord, type StoredAccountLogReceipt } from './trading_account_log_contract.js';
import type { TradingAccount } from './trading_types.js';
import { executionMatches, observedOrderExecutions, type ScopeOrder } from './trading_scope_execution.js';
import { projectKrakenCashleg } from './trading_kraken_cashlegs.js';

interface FundingEvent { id: string; timestamp: number; amount: string; asset: string | null; source: string }
function text(value: string | null | undefined): string {
  if (!value || value.trim() !== value) throw new Error('missing_monetary_identity');
  return value;
}
function stamp(value: string | null | undefined): number {
  const result = Number(text(value));
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('invalid_event_time');
  return result;
}
function asset(value: string | null | undefined): string {
  const result = text(value).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,31}$/.test(result)) throw new Error('invalid_native_asset');
  return result;
}
function bybitFunding(row: AccountLogRecord): FundingEvent | null {
  if ((row.funding === undefined || row.funding === null || row.funding === '') && row.type !== 'SETTLEMENT') return null;
  return { id: text(row.id), timestamp: stamp(row.transactionTime), amount: signedDecimal(text(row.funding)),
    asset: asset(row.currency), source: 'bybit:funding-v1' };
}
function hyperliquidFunding(row: AccountLogRecord): FundingEvent {
  if (row.type !== 'funding') throw new Error('unknown_monetary_event');
  const coin = text(row.coin), timestamp = stamp(row.time);
  return { id: accountLogDigest([text(row.hash), coin, timestamp]), timestamp, amount: signedDecimal(text(row.usdc)),
    asset: coin.includes(':') ? null : 'USDC', source: 'hyperliquid:funding-v1' };
}
function krakenFunding(row: AccountLogRecord): FundingEvent | null {
  if (row.realized_funding === null || row.realized_funding === undefined) {
    if (row.info === 'funding rate change') throw new Error('missing_realized_funding');
    return null;
  }
  const timestamp = Date.parse(text(row.date));
  if (!Number.isSafeInteger(timestamp)) throw new Error('invalid_event_time');
  return { id: `kraken-account-log:${text(row.id)}`, timestamp, amount: signedDecimal(text(row.realized_funding)),
    asset: asset(row.collateral || row.asset), source: 'krakenfutures:account-log-funding-v1' };
}

async function matchesKnownFill(account: TradingAccount, row: AccountLogRecord): Promise<boolean> {
  if (!row.tradeId || !row.orderId) return false;
  const order = await getDatabase().get<ScopeOrder>('SELECT * FROM trading_orders WHERE account_id=? AND exchange_order_id=?', [account.id, row.orderId]);
  if (!order || row.side !== (order.side === 'buy' ? 'Buy' : 'Sell') || (row.orderLinkId && row.orderLinkId !== order.client_order_id)) return false;
  const observed = await observedOrderExecutions(account, order);
  // The ledger tradeId is NOT an execution ID. A unique original execution with
  // matching owned order, symbol, time, quantity, price and fee corroborates cost.
  return observed.executions.filter(execution => executionMatches(row, execution)).length === 1;
}

async function validateOtherBybitMoney(account: TradingAccount, row: AccountLogRecord): Promise<void> {
  const fee = optionalAmount(row.fee), cash = optionalAmount(row.cashFlow);
  if (nonzero(fee) || (nonzero(cash) && row.type === 'TRADE')) {
    if (!await matchesKnownFill(account, row)) throw new Error('unmatched_fee_or_price_pnl');
  }
  if (row.type === 'SETTLEMENT' && cash !== null && cash !== '0') throw new Error('session_settlement_pnl_unresolved');
  if (!['TRADE', 'SETTLEMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'DEPOSIT', 'WITHDRAW'].includes(row.type ?? '')) throw new Error('unclassified_account_movement');
  if (row.type === 'TRADE' && fee === null) throw new Error('missing_trade_fee');
}
function optionalAmount(value: string | null | undefined): string | null { return value == null || value === '' ? null : signedDecimal(value); }
function nonzero(value: string | null): boolean { return value !== null && value !== '0'; }

function validateOtherKrakenMoney(row: AccountLogRecord): void {
  // Position-size legs are not a second cash booking. Preserve them as evidence.
  if (row.asset === row.contract) throw new Error('position_leg_requires_cash_correlation');
  const nonTrading = ['deposit', 'withdrawal', 'transfer', 'subaccount transfer', 'cross-exchange transfer'];
  if (row.info !== 'funding rate change' && !nonTrading.includes(row.info ?? '')) throw new Error('unclassified_account_movement');
  if (row.fee != null && signedDecimal(row.fee) !== '0') throw new Error('unmatched_account_fee');
}

async function projectRecord(account: TradingAccount, stored: StoredAccountLogReceipt, row: AccountLogRecord): Promise<void> {
  if (account.exchange === 'krakenfutures' && row.info === 'futures trade') {
    await projectKrakenCashleg(account, row);
    if (row.asset?.toUpperCase() === row.contract?.toUpperCase()) return;
    await postFunding(account, stored, krakenFunding(row));
    return;
  }
  if (account.exchange === 'krakenfutures' && row.asset === row.contract) throw new Error('position_leg_requires_cash_correlation');
  const event = account.exchange === 'bybit' ? bybitFunding(row)
    : account.exchange === 'hyperliquid' ? hyperliquidFunding(row) : krakenFunding(row);
  await postFunding(account, stored, event);
  if (account.exchange === 'bybit') await validateOtherBybitMoney(account, row);
  if (account.exchange === 'krakenfutures') validateOtherKrakenMoney(row);
}

async function postFunding(account: TradingAccount, stored: StoredAccountLogReceipt, event: FundingEvent | null): Promise<void> {
  if (event) {
    if (event.timestamp < stored.receipt.since || event.timestamp > stored.receipt.until) throw new Error('event_outside_source_window');
    await recordMoneyEvent({ accountId: account.id, accountFingerprint: stored.receipt.accountFingerprint,
      providerEventId: event.id, kind: 'funding', source: event.source, basis: 'provider', occurredAt: event.timestamp,
      amount: event.amount, asset: event.asset });
  }
}

/** Each event transaction preserves conflicts even when a later row is unresolved. */
export async function projectAccountLogMoney(account: TradingAccount): Promise<void> {
  const receipts = await pendingAccountLogReceipts(account.id, 'money');
  for (const stored of receipts) {
    const reasons = new Set<string>();
    if (stored.receipt.accountFingerprint !== account.externalAccountId) reasons.add('account_binding_changed');
    else for (const row of stored.receipt.records) {
      try { await projectRecord(account, stored, row); }
      catch (error) { reasons.add(error instanceof Error ? error.message.slice(0, 120) : 'unresolved_monetary_event'); }
    }
    await setAccountLogConsumerResult(stored.id, 'money', reasons.size ? 'unresolved' : 'complete',
      { version: 1, reasons: [...reasons].slice(0, 100) });
  }
}
