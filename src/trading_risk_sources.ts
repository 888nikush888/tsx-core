import { createHash } from 'node:crypto';
import { getDatabase } from './db.js';
import { compareDecimal } from './trading_decimal.js';
import { proveOwnedQuantity, type OwnershipOrder, type OwnershipFill } from './trading_ownership.js';
import { protectiveStopCoverage, requiredStopQuantity, type ProtectionOrder } from './trading_protection.js';
import { unresolvedRiskAmounts, type RiskEntryRemainder } from './trading_risk_reservations.js';
import { calculateFxRiskReservation } from './trading_fx_risk.js';
import type { ExchangeFillAccounting, ExchangeOpenState, TradingAccount, TradingSide } from './trading_types.js';

export const riskHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const riskFingerprint = (account: TradingAccount): string => account.exchange === 'paper' ? `paper:${account.id}` : account.externalAccountId!;
interface RiskOrder extends OwnershipOrder { intent_id: string; client_order_id: string; exchange_order_id: string | null;
  provider_symbol: string | null; generation: number; status: string; price: string | null; trigger_price: string | null;
  order_type: string; request_json: string; entry_drain_requested_at: number | null }
interface RiskFill extends OwnershipFill { id: string; account_fingerprint: string | null; accounting_json: string | null; price: string; filled_at: number;
  identity_status: string; identity_json: string | null; remote_fill_key: string | null; provider_symbol: string | null }
interface RiskPosition { id: string; status: string; quantity: string; stop_price: string | null; average_entry_price: string }
interface RiskOperation { id: string; phase: string; expected_orders_json: string; request_hash: string }
export interface RiskIntentSource { id: string; symbol: string; side: TradingSide; plan_json: string | null;
  orders: RiskOrder[]; fills: RiskFill[]; positions: RiskPosition[]; operations: RiskOperation[]; contract: { metadata_json: string; account_fingerprint: string; credential_generation: string | null } | undefined }

async function intentSource(row: Pick<RiskIntentSource, 'id' | 'symbol' | 'side' | 'plan_json'>): Promise<RiskIntentSource> {
  const db = getDatabase();
  const [orders, fills, positions, operations, contract] = await Promise.all([
    db.all<RiskOrder[]>(`SELECT id, intent_id, client_order_id, exchange_order_id, provider_symbol, role, side, reduce_only,
      quantity, filled_quantity, status, price, trigger_price, order_type, request_json, entry_drain_requested_at,
      COALESCE((SELECT generation FROM trading_order_generations g WHERE g.intent_id = trading_orders.intent_id AND g.client_order_id = trading_orders.client_order_id), 0) AS generation
      FROM trading_orders WHERE intent_id = ? ORDER BY id`, [row.id]),
    db.all<RiskFill[]>(`SELECT fills.id, fills.order_id, fills.account_fingerprint, fills.accounting_json, fills.price, fills.quantity, fills.filled_at,
      fills.identity_status, fills.identity_json, fills.remote_fill_key, fills.provider_symbol
      FROM trading_fills fills JOIN trading_orders orders ON orders.id = fills.order_id WHERE orders.intent_id = ? ORDER BY fills.id`, [row.id]),
    db.all<RiskPosition[]>('SELECT id, status, quantity, stop_price, average_entry_price FROM trading_positions WHERE intent_id = ? ORDER BY id', [row.id]),
    db.all<RiskOperation[]>('SELECT id, phase, expected_orders_json, request_hash FROM trading_operations WHERE intent_id = ? ORDER BY id', [row.id]),
    db.get<RiskIntentSource['contract']>('SELECT metadata_json, account_fingerprint, credential_generation FROM trading_risk_contracts WHERE intent_id = ?', [row.id]),
  ]);
  return { ...row, orders, fills, positions, operations, contract };
}

/** An absent plan or missing fill cannot make a surviving order obligation disappear. */
export async function loadRiskSources(accountId: string, excludeIntent = ''): Promise<RiskIntentSource[]> {
  const rows = await getDatabase().all<Array<Pick<RiskIntentSource, 'id' | 'symbol' | 'side' | 'plan_json'>>>(
    `SELECT intent.id, intent.symbol, intent.side, intent.plan_json FROM trading_trade_intents intent WHERE intent.account_id = ? AND intent.id <> ? AND (
      EXISTS (SELECT 1 FROM trading_positions p WHERE p.intent_id = intent.id AND p.status <> 'closed') OR
      EXISTS (SELECT 1 FROM trading_orders o WHERE o.intent_id = intent.id AND o.role = 'entry' AND o.status NOT IN ('filled', 'cancelled', 'rejected')) OR
      EXISTS (SELECT 1 FROM trading_operations op WHERE op.intent_id = intent.id AND op.phase IN ('dispatching', 'unresolved')) OR
      (EXISTS (SELECT 1 FROM trading_orders o WHERE o.intent_id = intent.id AND o.filled_quantity <> '0') AND
       NOT EXISTS (SELECT 1 FROM trading_positions p WHERE p.intent_id = intent.id AND p.status = 'closed')))
     ORDER BY intent.id`, [accountId, excludeIntent]);
  return Promise.all(rows.map(intentSource));
}

function entryRemainders(source: RiskIntentSource): RiskEntryRemainder[] {
  return source.orders.filter(order => order.role === 'entry').map(order => ({
    id: order.id, generation: order.generation, status: order.status, quantity: order.quantity, filledQuantity: order.filled_quantity,
    price: order.order_type === 'limit' ? order.price : null,
    operationUnresolved: (order.entry_drain_requested_at !== null && !['filled', 'cancelled', 'rejected'].includes(order.status))
      || source.operations.some(operation => ['dispatching', 'unresolved'].includes(operation.phase)
      && JSON.parse(operation.expected_orders_json).some((expected: { client_order_id: string }) => expected.client_order_id === order.client_order_id)),
  }));
}

function currentStop(source: RiskIntentSource, remote: ExchangeOpenState, accountId: string, quantity: string): string {
  const local = source.positions.filter(position => position.status !== 'closed');
  const minimum = local[0]?.stop_price ?? null;
  const stopPrices: string[] = [];
  for (const order of source.orders.filter(row => row.role === 'stop_loss')) {
    const matches = remote.orders.filter(row => row.clientOrderId === order.client_order_id && row.exchangeOrderId === order.exchange_order_id
      && row.providerSymbol === order.provider_symbol && row.symbol === source.symbol);
    if (matches.length !== 1) continue;
    const current = matches[0];
    const protection = { ...current, accountId, intentId: source.id, symbol: source.symbol } as ProtectionOrder;
    if (protectiveStopCoverage(protection, { accountId, intentId: source.id, symbol: source.symbol, side: source.side,
      quantity, minimumTrigger: minimum }).protected) stopPrices.push(current.triggerPrice!);
  }
  if (!stopPrices.length) throw new Error('Risk stop coverage is unproven.');
  return stopPrices.reduce((best, price) => (compareDecimal(price, best) > 0) === (source.side === 'LONG') ? price : best);
}

function marketMetadata(source: RiskIntentSource, account: TradingAccount, remote: ExchangeOpenState): ExchangeFillAccounting | null {
  const position = remote.positions.find(row => row.symbol === source.symbol);
  if (position?.accounting) return position.accounting;
  if (source.contract?.account_fingerprint === riskFingerprint(account) && source.contract.credential_generation === account.credentialGeneration) {
    return JSON.parse(source.contract.metadata_json) as ExchangeFillAccounting;
  }
  const fill = source.fills.find(row => row.account_fingerprint === riskFingerprint(account) && row.accounting_json);
  return fill ? JSON.parse(fill.accounting_json!) as ExchangeFillAccounting : null;
}

function assertRiskMarketBinding(source: RiskIntentSource, account: TradingAccount, metadata: ExchangeFillAccounting | null,
  position: ExchangeOpenState['positions'][number] | undefined): void {
  if (!metadata || metadata.source !== (account.exchange === 'paper' ? 'paper-contract-v1' : 'ccxt-market-v1')
    || (position && position.providerSymbol !== metadata.providerSymbol)
    || source.fills.some(fill => fill.account_fingerprint !== riskFingerprint(account))
    || source.orders.some(order => order.role === 'entry' && order.provider_symbol !== metadata.providerSymbol)) {
    throw new Error('Risk market or fill identity is unproven.');
  }
}

function ownedRemotePosition(source: RiskIntentSource, remote: ExchangeOpenState, ownedQuantity: string) {
    const positions = remote.positions.filter(row => row.symbol === source.symbol);
    const position = positions[0];
    if (positions.length > 1 || (position && (position.side !== source.side || compareDecimal(position.quantity, ownedQuantity) !== 0))
      || (!position && ownedQuantity !== '0')) {
      throw new Error('Risk owned quantity is unproven.');
    }
    return position;
}

export async function deriveRiskReservation(source: RiskIntentSource, account: TradingAccount, remote: ExchangeOpenState, currency: string) {
  let entries: RiskEntryRemainder[] = [];
  try {
    entries = entryRemainders(source);
    const own = proveOwnedQuantity(source.orders, source.fills, source.side);
    const position = ownedRemotePosition(source, remote, own.netQuantity);
    const quantity = requiredStopQuantity(own.netQuantity, entries.map(entry => ({ ...entry, filledQuantity: entry.filledQuantity })));
    const stop = quantity === '0' ? source.positions[0]?.stop_price ?? '' : currentStop(source, remote, account.id, quantity);
    const metadata = marketMetadata(source, account, remote);
    assertRiskMarketBinding(source, account, metadata, position);
    const input = { side: source.side, ownedQuantity: own.netQuantity, averageEntryPrice: position?.averageEntryPrice ?? null,
      markPrice: position?.markPrice ?? null, stopPrice: stop, reportingCurrency: currency, market: metadata, entries, protectionProven: true };
    return { intentId: source.id, sourceHash: riskHash(source), entries, input,
      ...await calculateFxRiskReservation(account, input, remote.observedAt) };
  } catch (error) {
    return { intentId: source.id, sourceHash: riskHash(source), entries, input: null, fx: null,
      amounts: unresolvedRiskAmounts(currency, error) };
  }
}
