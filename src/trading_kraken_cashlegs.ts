import { getDatabase } from './db.js';
import { valueKrakenCashlegFee } from './trading_money_ledger.js';
import { cashlegAsset, KrakenCashlegError, type KrakenCashlegOccurrence } from './trading_kraken_cashleg_contract.js';
import { relatedKrakenOccurrences } from './trading_kraken_cashleg_repository.js';
import type { AccountLogRecord } from './trading_account_log_contract.js';
import type { TradingAccount } from './trading_types.js';

/** Existing own execution first. A ledger occurrence never creates a fill or an order identity. */
export async function projectKrakenCashleg(account: TradingAccount, row: AccountLogRecord): Promise<void> {
  const related = await relatedKrakenOccurrences(account.id, account.externalAccountId!, [row]);
  const executions = [...new Set(related.map(item => item.record.execution).filter((value): value is string => !!value))];
  if (!executions.length || executions.length > 1000) throw new KrakenCashlegError('missing_execution');
  const events = await getDatabase().all<Array<{ id: string; execution: string }>>(`SELECT event.id,fills.exchange_fill_id AS execution
    FROM trading_money_events event JOIN trading_fills fills ON fills.id=event.fill_id
    WHERE event.account_id=? AND event.account_fingerprint=? AND event.kind='fee' AND event.basis='fill'
      AND fills.exchange_fill_id IN (${executions.map(() => '?').join(',')}) LIMIT 2`, [account.id, account.externalAccountId, ...executions]);
  if (events.length !== 1) throw new KrakenCashlegError('own_execution_fee_unproven');
  const event = events[0]!;
  const originals = await relatedKrakenOccurrences(account.id, account.externalAccountId!, [{ execution: event.execution }, row]);
  const { cash, position } = candidatePair(originals, event.execution);
  await valueKrakenCashlegFee({ eventId: event.id, cashOccurrence: { receiptId: cash.receiptId, ordinal: cash.ordinal },
    positionOccurrence: { receiptId: position.receiptId, ordinal: position.ordinal } });
}
function candidatePair(originals: KrakenCashlegOccurrence[], execution: string) {
  const trades = originals.filter(item => item.record.execution === execution && item.record.info === 'futures trade');
  const position = trades.find(item => cashlegAsset(item.record.asset) === cashlegAsset(item.record.contract));
  const cash = trades.find(item => cashlegAsset(item.record.asset) !== cashlegAsset(item.record.contract));
  if (!cash || !position) throw new KrakenCashlegError('missing_cash_or_position_leg');
  // The ledger API checks ALL original occurrences for ambiguity/contradictions, not just this candidate.
  return { cash, position };
}
