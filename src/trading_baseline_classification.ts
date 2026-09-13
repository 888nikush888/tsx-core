import { getDatabase } from './db.js';
import { decimal, signedDecimal } from './trading_decimal.js';
import type { TradingAccount } from './trading_types.js';

interface HistoricalEvidence {
  id: string; kind: string; reason: string; provider_id: string | null; provider_symbol: string | null; payload_json: string;
}
const knownReference = `EXISTS (SELECT 1 FROM trading_orders AS orders WHERE orders.account_id = evidence.account_id
  AND ((orders.provider_symbol = evidence.provider_symbol AND orders.exchange_order_id = json_extract(evidence.payload_json, '$.exchangeOrderId'))
    OR orders.client_order_id = json_extract(evidence.payload_json, '$.clientOrderId')))`;

function historicalEventTimestampValid(event: Record<string, unknown>, kind: string, boundary: number): boolean {
  const stamp = kind === 'fill' ? event.filledAt : event.providerTimestamp;
  return typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp > 0 && stamp < boundary;
}

function historicalOrderReasonValid(reason: unknown, status: unknown): boolean {
  if (reason === 'historical_order_event') return true;
  return reason === 'unmanaged_order' && typeof status === 'string'
    && ['filled', 'cancelled', 'rejected'].includes(status);
}

function historicalFillIdentityValid(row: HistoricalEvidence, event: Record<string, unknown>): boolean {
  return row.reason === 'unmapped_fill' && event.exchangeFillId === row.provider_id;
}

function historicalFillMoneyValid(event: Record<string, unknown>): boolean {
  const { price, quantity, fee } = event;
  if (typeof price !== 'string' || typeof quantity !== 'string' || typeof fee !== 'string') return false;
  try { decimal(price, { positive: true }); decimal(quantity, { positive: true }); signedDecimal(fee); }
  catch { return false; }
  return true;
}

function historicalBeforeBoundary(row: HistoricalEvidence, boundary: number): boolean {
  const event: Record<string, unknown> = JSON.parse(row.payload_json);
  if (!historicalIdentity(row, event) || !historicalEventTimestampValid(event, row.kind, boundary)) return false;
  if (row.kind === 'order') return historicalOrderReasonValid(row.reason, event.status);
  if (!historicalFillIdentityValid(row, event)) return false;
  return historicalFillMoneyValid(event);
}

function historicalIdentity(row: HistoricalEvidence, event: Record<string, unknown>): boolean {
  return Boolean(row.provider_id && row.provider_symbol) && event.providerSymbol === row.provider_symbol
    && typeof event.exchangeOrderId === 'string' && event.exchangeOrderId.length > 0;
}

/** A proof only classifies old external history. Never books fills, releases a kill switch or mutates orders. */
export async function classifyPreBaselineHistory(account: TradingAccount, baselineId: string, boundary: number): Promise<void> {
  const database = getDatabase();
  // A restore can reveal a previously unknown managed order. Revoke the external label;
  // subsequent exact fill/history correlation must establish ownership again.
  await database.run(`UPDATE trading_remote_evidence AS evidence SET classification = 'unresolved', external_baseline_id = NULL
    WHERE account_id = ? AND account_fingerprint = ? AND classification = 'external' AND ${knownReference}`,
  [account.id, account.externalAccountId]);
  const rows = await database.all<HistoricalEvidence[]>(`SELECT evidence.* FROM trading_remote_evidence AS evidence
    WHERE evidence.account_id = ? AND evidence.account_fingerprint = ? AND evidence.classification = 'unresolved'
      AND NOT ${knownReference} ORDER BY baseline_reviewed_at, first_seen_at, id LIMIT 500`, [account.id, account.externalAccountId]);
  for (const row of rows) {
    const external = historicalBeforeBoundary(row, boundary);
    await database.run(`UPDATE trading_remote_evidence SET baseline_reviewed_at = ?, classification = ?, external_baseline_id = ?
      WHERE id = ? AND classification = 'unresolved'`, [Date.now(), external ? 'external' : 'unresolved', external ? baselineId : null, row.id]);
  }
}
