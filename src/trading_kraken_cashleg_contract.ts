import { accountLogDigest, accountLogSource, type AccountLogPageReceipt, type AccountLogRecord } from './trading_account_log_contract.js';
import { addSignedDecimal, negateSignedDecimal, signedDecimal } from './trading_decimal.js';

export interface CashlegOccurrenceRef { receiptId: string; ordinal: number }
export interface CashlegMoneyOriginal {
  id: string; accountId: string; accountFingerprint: string; kind: string; basis: string; occurredAt: number;
  amount: string; asset: string | null; fillId?: string | null; intentId?: string | null;
}
export interface CashlegReportingBinding { reportingCurrency: string }
export interface KrakenCashlegOccurrence extends CashlegOccurrenceRef {
  accountId: string; receipt: AccountLogPageReceipt; record: AccountLogRecord;
}
export interface KrakenCashlegEconomics {
  accountId: string; fingerprint: string; providerAccountUid: string;
  executionUid: string; contract: string; side: string; quantity: string; price: string;
  fee: string; feeAsset: string | null; pricePnl: string; settlementAsset: string; reportingAsset: string;
}
export class KrakenCashlegError extends Error {
  constructor(message: string, public readonly conflict = false) { super(`kraken_cashleg:${message}`); }
}
export function cashlegText(value: string | null | undefined): string {
  if (!value || value.trim() !== value || value.length > 256) throw new KrakenCashlegError('missing_original_identity');
  return value;
}
export function cashlegAsset(value: string | null | undefined): string {
  const original = cashlegText(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(original)) throw new KrakenCashlegError('invalid_asset');
  return original.toUpperCase();
}
function amount(value: string | null | undefined): string {
  if (value == null || value === '') throw new KrakenCashlegError('missing_cash_component');
  return signedDecimal(value);
}
function difference(after: string | null | undefined, before: string | null | undefined): string {
  return addSignedDecimal(amount(after), negateSignedDecimal(amount(before)));
}
function equal(actual: unknown, expected: unknown, reason: string): void {
  if (actual !== expected) throw new KrakenCashlegError(reason, true);
}
function originalTime(row: AccountLogRecord, receipt: AccountLogPageReceipt): number {
  const timestamp = Date.parse(cashlegText(row.date));
  if (!Number.isSafeInteger(timestamp) || timestamp < receipt.since || timestamp > receipt.until) throw new KrakenCashlegError('invalid_original_time');
  return timestamp;
}
function assertBound(occurrence: KrakenCashlegOccurrence, expected: KrakenCashlegEconomics): number {
  const { receipt, record } = occurrence;
  const source = accountLogSource('krakenfutures')!;
  if (occurrence.accountId !== expected.accountId || receipt.accountFingerprint !== expected.fingerprint
    || !/^[a-f0-9]{64}$/.test(receipt.credentialGeneration) || receipt.providerAccountUid !== expected.providerAccountUid
    || receipt.namespace !== source.namespace || receipt.filterHash !== source.filterHash) throw new KrakenCashlegError('source_binding_mismatch');
  equal(record.execution, expected.executionUid, 'execution_mismatch');
  equal(cashlegAsset(record.contract), expected.contract.toUpperCase(), 'contract_mismatch');
  if (record.info !== 'futures trade') throw new KrakenCashlegError('non_trade_movement');
  for (const key of ['id', 'booking_uid', 'margin_account']) cashlegText(record[key]);
  return originalTime(record, receipt);
}
function assertNoConversion(row: AccountLogRecord): void {
  for (const field of ['conversion_fee', 'conversion_spread_percentage', 'liquidation_fee']) {
    if (row[field] != null && amount(row[field]) !== '0') throw new KrakenCashlegError('conversion_or_liquidation_unresolved');
  }
  // An observed exchange-rate pair is conversion evidence, not a native-asset quote.
  if (row.exchange_rate != null || row.exchange_rate_from != null) throw new KrakenCashlegError('conversion_route_unresolved');
}
function assertCash(row: AccountLogRecord, expected: KrakenCashlegEconomics): { asset: string; funding: string; delta: string } {
  const asset = cashlegAsset(row.asset);
  equal(asset, cashlegAsset(row.collateral), 'cash_asset_collateral_mismatch');
  if (expected.feeAsset !== null) equal(asset, expected.feeAsset, 'original_fee_asset_mismatch');
  if (asset !== expected.reportingAsset) throw new KrakenCashlegError('non_native_reporting_asset');
  if (expected.pricePnl !== '0' && asset !== expected.settlementAsset) throw new KrakenCashlegError('price_pnl_unit_unresolved');
  equal(amount(row.fee), expected.fee, 'fee_mismatch');
  equal(amount(row.realized_pnl), expected.pricePnl, 'price_pnl_mismatch');
  const funding = amount(row.realized_funding), delta = difference(row.new_balance, row.old_balance);
  equal(delta, addSignedDecimal(addSignedDecimal(expected.pricePnl, funding), negateSignedDecimal(expected.fee)), 'cash_delta_mismatch');
  return { asset, funding, delta };
}

/** Native same-unit cash evidence only; no quote, rate search, or inferred null component. */
export function validateKrakenCashlegPair(cash: KrakenCashlegOccurrence, position: KrakenCashlegOccurrence, expected: KrakenCashlegEconomics) {
  const cashAt = assertBound(cash, expected), positionAt = assertBound(position, expected);
  const first = cash.record, second = position.record;
  equal(cashlegAsset(second.asset), expected.contract.toUpperCase(), 'position_asset_mismatch');
  equal(first.margin_account, second.margin_account, 'wallet_mismatch');
  equal(cashlegAsset(second.collateral), cashlegAsset(first.collateral), 'position_collateral_mismatch');
  if (first.id === second.id || first.booking_uid === second.booking_uid) throw new KrakenCashlegError('leg_identity_collision', true);
  equal(amount(first.trade_price), expected.price, 'cash_trade_price_mismatch');
  equal(amount(second.trade_price), expected.price, 'position_trade_price_mismatch');
  equal(difference(second.new_balance, second.old_balance), expected.side === 'buy' ? expected.quantity : negateSignedDecimal(expected.quantity), 'position_delta_mismatch');
  assertNoConversion(first); assertNoConversion(second);
  return { ...assertCash(first, expected), cashAt, positionAt };
}

/** Missing fields remain missing; identical overlap differs only in receipt provenance. */
export function cashlegRecordHash(record: AccountLogRecord): string {
  return accountLogDigest(Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))));
}
