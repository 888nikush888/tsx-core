import { getDatabase } from './db.js';
import { signedDecimal, negateSignedDecimal } from './trading_decimal.js';
import { accountLogDigest, type AccountLogRecord } from './trading_account_log_contract.js';
import { validateFillAccounting } from './trading_accounting_contract.js';
import { provenFillIdentity } from './trading_fill_identity.js';
import { cashlegRecordHash, KrakenCashlegError, validateKrakenCashlegPair,
  type CashlegOccurrenceRef, type KrakenCashlegEconomics, type KrakenCashlegOccurrence,
  type CashlegMoneyOriginal, type CashlegReportingBinding } from './trading_kraken_cashleg_contract.js';
import type { TradingAccount, ExchangeFill } from './trading_types.js';

export interface KrakenCashlegRequest { eventId: string; cashOccurrence: CashlegOccurrenceRef; positionOccurrence: CashlegOccurrenceRef }
interface OccurrenceRow { receipt_id: string; ordinal: number; account_id: string; receipt_json: string; record_json: string }
interface CashlegFill {
  id: string; account_id: string; account_fingerprint: string | null; exchange_fill_id: string; exchange_order_id: string;
  client_order_id: string; provider_symbol: string; price: string; quantity: string; fee: string; fee_asset: string | null;
  filled_at: number; raw_json: string; identity_json: string | null; remote_fill_key: string | null; identity_status: string;
  accounting_json: string | null; accounting_conflict: number; role: string; side: string; intent_id: string;
}
function occurrence(row: OccurrenceRow): KrakenCashlegOccurrence {
  return { receiptId: row.receipt_id, ordinal: row.ordinal, accountId: row.account_id,
    receipt: JSON.parse(row.receipt_json), record: JSON.parse(row.record_json) };
}
export async function readKrakenOccurrence(ref: CashlegOccurrenceRef): Promise<KrakenCashlegOccurrence> {
  if (!ref || typeof ref.receiptId !== 'string' || !Number.isSafeInteger(ref.ordinal) || ref.ordinal < 0) throw new KrakenCashlegError('invalid_occurrence_reference');
  const row = await getDatabase().get<OccurrenceRow>(`SELECT original.receipt_id,original.ordinal,receipt.account_id,
    receipt.payload_json AS receipt_json,original.payload_json AS record_json FROM trading_kraken_log_occurrences occurrence
    JOIN trading_account_log_records original ON original.receipt_id=occurrence.receipt_id AND original.ordinal=occurrence.ordinal
    JOIN trading_account_log_receipts receipt ON receipt.id=original.receipt_id
    WHERE occurrence.receipt_id=? AND occurrence.ordinal=?`, [ref.receiptId, ref.ordinal]);
  if (!row) throw new KrakenCashlegError('missing_original_occurrence');
  return occurrence(row);
}

/** The indexes bound lookup by execution/booking identity. Duplicate audit receipts do not exhaust the distinct-original budget. */
export async function relatedKrakenOccurrences(accountId: string, fingerprint: string, records: AccountLogRecord[]): Promise<KrakenCashlegOccurrence[]> {
  const keys = records.flatMap(row => [['execution_uid', row.execution], ['booking_uid', row.booking_uid], ['log_id', row.id]])
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]);
  if (!keys.length || keys.length > 6) throw new KrakenCashlegError('invalid_lookup_identity');
  const unions = keys.map(([column]) => `SELECT receipt_id,ordinal FROM trading_kraken_log_occurrences
    WHERE account_id=? AND account_fingerprint=? AND ${column}=?`).join(' UNION ');
  const rows = await getDatabase().all<OccurrenceRow[]>(`WITH refs AS (${unions}), originals AS (
    SELECT original.receipt_id,original.ordinal,receipt.account_id,receipt.payload_json AS receipt_json,
      original.payload_json AS record_json,ROW_NUMBER() OVER(PARTITION BY original.payload_json,receipt.credential_generation,
        json_extract(receipt.payload_json,'$.providerAccountUid') ORDER BY receipt.sequence,original.ordinal) AS duplicate
    FROM refs JOIN trading_account_log_records original USING(receipt_id,ordinal)
      JOIN trading_account_log_receipts receipt ON receipt.id=original.receipt_id)
    SELECT * FROM originals WHERE duplicate=1 LIMIT 1001`, keys.flatMap(([, value]) => [accountId, fingerprint, value]));
  if (rows.length > 1000) throw new KrakenCashlegError('distinct_original_budget_exhausted');
  return rows.map(occurrence);
}

async function originalFill(event: CashlegMoneyOriginal): Promise<CashlegFill> {
  if (event.kind !== 'fee' || event.basis !== 'fill' || !event.fillId) throw new KrakenCashlegError('not_an_owned_fill_fee');
  const fill = await getDatabase().get<CashlegFill>(`SELECT fills.*,orders.exchange_order_id,orders.client_order_id,
    orders.role,orders.side,orders.intent_id FROM trading_fills fills JOIN trading_orders orders ON orders.id=fills.order_id
    WHERE fills.id=? AND fills.account_id=?`, [event.fillId, event.accountId]);
  if (!fill || fill.account_fingerprint !== event.accountFingerprint || fill.intent_id !== event.intentId
    || fill.filled_at !== event.occurredAt || fill.identity_status !== 'proven' || !fill.identity_json
    || fill.accounting_conflict || !fill.accounting_json) throw new KrakenCashlegError('own_fill_not_proven');
  if (signedDecimal(event.amount) !== negateSignedDecimal(fill.fee) || event.asset !== fill.fee_asset) throw new KrakenCashlegError('original_fee_conflict', true);
  return fill;
}
async function originalAccount(event: CashlegMoneyOriginal): Promise<TradingAccount> {
  const row = await getDatabase().get<{ id: string; exchange: string; mode: string; external_account_id: string; credential_generation: string }>(
    'SELECT id,exchange,mode,external_account_id,credential_generation FROM trading_accounts WHERE id=?', [event.accountId]);
  if (row?.exchange !== 'krakenfutures' || row.external_account_id !== event.accountFingerprint || !row.credential_generation) throw new KrakenCashlegError('account_binding_unproven');
  return { id: row.id, exchange: row.exchange, mode: row.mode, externalAccountId: row.external_account_id,
    credentialGeneration: row.credential_generation } as TradingAccount;
}
async function expectedEconomics(event: CashlegMoneyOriginal, binding: CashlegReportingBinding): Promise<KrakenCashlegEconomics> {
  const fill = await originalFill(event), account = await originalAccount(event);
  const raw = JSON.parse(fill.raw_json);
  const source: ExchangeFill = { exchangeFillId: fill.exchange_fill_id, exchangeOrderId: fill.exchange_order_id,
    clientOrderId: fill.client_order_id, providerSymbol: fill.provider_symbol, price: fill.price, quantity: fill.quantity,
    fee: fill.fee, feeAsset: fill.fee_asset, filledAt: fill.filled_at, identity: JSON.parse(fill.identity_json!), raw };
  const identity = provenFillIdentity(account, source);
  if (!identity || identity.key !== fill.remote_fill_key || !nativeEconomicsMatch(raw, fill)) {
    throw new KrakenCashlegError('native_execution_original_mismatch', true);
  }
  // The native amount is contracts; TSX quantity is base units. Without a
  // persisted contract-size proof, inequality is unknown, not a cash contradiction.
  if (typeof raw.amount !== 'string' || signedDecimal(raw.amount) !== signedDecimal(fill.quantity)) {
    throw new KrakenCashlegError('contract_quantity_unit_unproven');
  }
  const market = validateFillAccounting(JSON.parse(fill.accounting_json!), fill.provider_symbol);
  if (market.source !== 'ccxt-market-v1') throw new KrakenCashlegError('settlement_source_unproven');
  const pricePnl = await originalPricePnl(event, fill);
  return { accountId: account.id, fingerprint: event.accountFingerprint,
    providerAccountUid: raw.info.accountUid, executionUid: fill.exchange_fill_id, contract: identity.identity.providerMarketId,
    side: fill.side, quantity: signedDecimal(fill.quantity), price: signedDecimal(fill.price), fee: signedDecimal(fill.fee),
    feeAsset: event.asset, pricePnl, settlementAsset: market.settlementAsset, reportingAsset: binding.reportingCurrency };
}
function nativeEconomicsMatch(raw: Record<string, any>, fill: CashlegFill): boolean {
  if (raw.side !== fill.side || raw.fee?.currency !== fill.fee_asset) return false;
  return [[raw.price, fill.price], [raw.fee?.cost, fill.fee]]
    .every(([original, persisted]) => typeof original === 'string' && signedDecimal(original) === signedDecimal(persisted));
}
async function originalPricePnl(event: CashlegMoneyOriginal, fill: CashlegFill): Promise<string> {
  if (fill.role === 'entry') return '0'; // Classification, not an invented provider cash component: the cash row must explicitly agree.
  const rows = await getDatabase().all<Array<{ amount: string; asset: string | null; conflict: number }>>(`SELECT event.amount,event.asset,
    EXISTS(SELECT 1 FROM trading_money_conflicts WHERE event_id=event.id) AS conflict FROM trading_money_events event
    WHERE event.account_id=? AND event.account_fingerprint=? AND event.fill_id=? AND event.kind='realized_price_pnl' AND event.basis='fill'`,
  [event.accountId, event.accountFingerprint, fill.id]);
  const market = validateFillAccounting(JSON.parse(fill.accounting_json!), fill.provider_symbol);
  if (rows.length !== 1 || rows[0]!.conflict || rows[0]!.asset !== market.settlementAsset) throw new KrakenCashlegError('price_pnl_original_unproven');
  return signedDecimal(rows[0]!.amount);
}
function assertUniquePair(related: KrakenCashlegOccurrence[], cash: KrakenCashlegOccurrence, position: KrakenCashlegOccurrence): void {
  const expected = new Set([cashlegRecordHash(cash.record), cashlegRecordHash(position.record)]);
  for (const item of related) {
    if (item.receipt.providerAccountUid !== cash.receipt.providerAccountUid || !expected.has(cashlegRecordHash(item.record))) {
      throw new KrakenCashlegError('contradictory_or_ambiguous_original_legs', true);
    }
  }
}
export async function readKrakenCashlegProof(request: KrakenCashlegRequest, event: CashlegMoneyOriginal, binding: CashlegReportingBinding) {
  const cash = await readKrakenOccurrence(request.cashOccurrence), position = await readKrakenOccurrence(request.positionOccurrence);
  const expected = await expectedEconomics(event, binding);
  const result = validateKrakenCashlegPair(cash, position, expected);
  const related = await relatedKrakenOccurrences(event.accountId, event.accountFingerprint, [cash.record, position.record]);
  assertUniquePair(related, cash, position);
  const economics = { version: 1 as const, source: 'kraken-native-cashleg-v1', eventId: event.id, fillId: event.fillId!,
    ...expected, ...result, occurredAt: event.occurredAt, cashHash: cashlegRecordHash(cash.record), positionHash: cashlegRecordHash(position.record) };
  return { id: accountLogDigest(economics), ...economics, cashOccurrence: { receiptId: cash.receiptId, ordinal: cash.ordinal },
    positionOccurrence: { receiptId: position.receiptId, ordinal: position.ordinal },
    cashCredentialGeneration: cash.receipt.credentialGeneration, positionCredentialGeneration: position.receipt.credentialGeneration,
    cashReceivedAt: cash.receipt.completedAt, positionReceivedAt: position.receipt.completedAt };
}
export async function persistKrakenCashlegProof(proof: Awaited<ReturnType<typeof readKrakenCashlegProof>>): Promise<void> {
  const existing = await getDatabase().get<{ id: string }>('SELECT id FROM trading_kraken_cashleg_evidence WHERE event_id=?', [proof.eventId]);
  if (existing) {
    if (existing.id !== proof.id) throw new KrakenCashlegError('native_asset_proof_conflict', true);
    return;
  }
  await getDatabase().run(`INSERT INTO trading_kraken_cashleg_evidence
    (id,event_id,fill_id,cash_receipt_id,cash_ordinal,position_receipt_id,position_ordinal,proof_json,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, [proof.id, proof.eventId, proof.fillId, proof.cashOccurrence.receiptId, proof.cashOccurrence.ordinal,
    proof.positionOccurrence.receiptId, proof.positionOccurrence.ordinal, JSON.stringify(proof), Date.now()]);
}
