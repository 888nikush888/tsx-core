import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { compareDecimal } from './trading_decimal.js';
import { fillAccountFingerprint, provenFillIdentity } from './trading_fill_identity.js';
import type { ExchangeFill, ExchangeFillIdentity, TradingAccount } from './trading_types.js';

interface FillRow {
  id: string; account_id: string; order_id: string; account_fingerprint: string | null; raw_json: string; accounting_json: string | null;
  identity_status: string; identity_json: string | null; remote_fill_key: string | null; provider_symbol: string | null;
  exchange_fill_id: string; price: string; quantity: string; fee: string; fee_asset: string | null; filled_at: number;
  client_order_id: string; exchange_order_id: string | null; order_provider_symbol: string | null; intent_id: string;
  symbol: string; role: string; side: string; order_quantity: string; response_json: string | null;
  order_type: string; reduce_only: number; order_price: string | null; trigger_price: string | null;
}
const SELECT_FILLS = `SELECT fills.*,orders.client_order_id,orders.exchange_order_id,orders.provider_symbol AS order_provider_symbol,
  orders.intent_id,orders.role,orders.side,orders.quantity AS order_quantity,orders.response_json,intent.symbol,
  orders.order_type,orders.reduce_only,orders.price AS order_price,orders.trigger_price
  FROM trading_fills fills JOIN trading_orders orders ON orders.id=fills.order_id
  JOIN trading_trade_intents intent ON intent.id=orders.intent_id`;
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function parse(value: string | null): Record<string, unknown> { return value === null ? {} : object(JSON.parse(value)); }
function codePointOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function snapshot(row: FillRow, identity?: ExchangeFillIdentity): ExchangeFill {
  if (!row.exchange_order_id) throw new Error('Fill has no original exchange order identity.');
  return { exchangeFillId: row.exchange_fill_id, exchangeOrderId: row.exchange_order_id, clientOrderId: row.client_order_id,
    symbol: row.symbol, providerSymbol: row.order_provider_symbol ?? undefined, price: row.price, quantity: row.quantity,
    fee: row.fee, feeAsset: row.fee_asset, filledAt: row.filled_at, raw: JSON.parse(row.raw_json), identity };
}

type IdentityBase = Pick<ExchangeFillIdentity, 'version' | 'providerSymbol' | 'providerFillId' | 'scopeTimestamp'>;
function bybitOriginalMetadata(row: FillRow, symbol: string): boolean {
  const metadata = parse(row.accounting_json);
  const original = { source: 'ccxt-market-v1', linear: true, quantityUnit: 'base', providerSymbol: symbol };
  return Object.entries(original).every(([key, expected]) => metadata[key] === expected)
    && bybitPerpetualSymbol(symbol, metadata.settlementAsset);
}
function bybitIdentity(base: IdentityBase, info: Record<string, unknown>, row: FillRow): ExchangeFillIdentity | null {
  if (typeof info.symbol !== 'string' || !bybitOriginalMetadata(row, base.providerSymbol)) return null;
  return { ...base, profile: 'bybit_execution_v1', marketNamespace: 'linear', providerMarketId: info.symbol };
}
function hyperliquidIdentity(base: IdentityBase, info: Record<string, unknown>): ExchangeFillIdentity | null {
  if (typeof info.coin !== 'string' || typeof info.time !== 'number') return null;
  return { ...base, profile: 'hyperliquid_user_fill_v1', marketNamespace: 'perpetual', providerMarketId: info.coin, scopeTimestamp: info.time };
}
function krakenIdentity(base: IdentityBase, info: Record<string, unknown>): ExchangeFillIdentity | null {
  if (info.identitySource !== 'kraken_history_execution_v3' || typeof info.tradeable !== 'string') return null;
  return { ...base, profile: 'kraken_history_execution_v3', marketNamespace: 'futures', providerMarketId: info.tradeable };
}
function providerIdentity(exchange: TradingAccount['exchange'], base: IdentityBase, info: Record<string, unknown>, row: FillRow): ExchangeFillIdentity | null {
  if (exchange === 'bybit') return bybitIdentity(base, info, row);
  if (exchange === 'hyperliquid') return hyperliquidIdentity(base, info);
  if (exchange === 'krakenfutures') return krakenIdentity(base, info);
  return null;
}
function legacyIdentity(account: TradingAccount, row: FillRow): ExchangeFillIdentity | null {
  const raw = parse(row.raw_json), info = object(raw.info);
  if (!row.order_provider_symbol || raw.symbol !== row.order_provider_symbol) return null;
  const base = { version: 1 as const, providerSymbol: row.order_provider_symbol, providerFillId: row.exchange_fill_id, scopeTimestamp: null };
  return providerIdentity(account.exchange, base, info, row);
}

function bybitPerpetualSymbol(symbol: string, settlementAsset: unknown): boolean {
  // Pinned CCXT4.5.75: spot has no ':'; futures/options always append an expiry suffix.
  // This classifies the exact ORIGINAL unified symbol. It never manufactures the native market ID.
  const match = /^([A-Z0-9]+)\/(USDT|USDC):(USDT|USDC)$/.exec(symbol);
  return match !== null && match[2] === match[3] && match[3] === settlementAsset;
}

function ackMatches(value: unknown, row: FillRow): boolean {
  const ack = object(value);
  return ack.clientOrderId === row.client_order_id && ack.exchangeOrderId === row.exchange_order_id
    && ack.providerSymbol === row.order_provider_symbol;
}
function legMatches(value: unknown, row: FillRow): boolean {
  const leg = object(value);
  if (typeof leg.quantity !== 'string') return false;
  const original = { accountId: row.account_id, clientOrderId: row.client_order_id, symbol: row.symbol,
    role: row.role, side: row.side, orderType: row.order_type, reduceOnly: row.reduce_only === 1,
    price: row.order_price, triggerPrice: row.trigger_price };
  return Object.entries(original).every(([key, expected]) => leg[key] === expected)
    && compareDecimal(leg.quantity, row.order_quantity) === 0;
}
interface OriginalOperation { kind: string; request_json: string; request_hash: string; evidence_json: string | null;
  expected_orders_json: string; credential_generation: string | null; logical_key: string; generation: number }
function originalOperationIntact(operation: OriginalOperation): boolean {
  return Boolean(operation.credential_generation) && Number.isSafeInteger(operation.generation) && operation.generation >= 1
    && digest(operation.request_json) === operation.request_hash;
}
function originalLegsProve(operation: OriginalOperation, row: FillRow): boolean {
  const request = JSON.parse(operation.request_json);
  const legs = operation.kind === 'protected_entry' ? [request.entry, request.protectiveStop] : [request];
  const expected = JSON.parse(operation.expected_orders_json);
  if (!Array.isArray(expected) || expected.length !== legs.length || legs.filter(leg => legMatches(leg, row)).length !== 1) return false;
  const ids = legs.map(leg => leg.clientOrderId).sort(codePointOrder);
  return originalLegIdsProve(operation, row.intent_id, ids, expected);
}
function originalLegIdsProve(operation: OriginalOperation, intentId: string, ids: string[], expected: { client_order_id: string }[]): boolean {
  return new Set(ids).size === ids.length
    && isDeepStrictEqual(expected.map(item => item.client_order_id).sort(codePointOrder), ids)
    && operation.logical_key === digest(JSON.stringify([operation.kind, intentId, ids]));
}
function operationProves(operation: OriginalOperation, row: FillRow, direct: boolean): boolean {
  if (!originalOperationIntact(operation) || !originalLegsProve(operation, row)) return false;
  return originalAcknowledgement(operation.evidence_json, row, direct);
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function acknowledgementOrders(payload: string): unknown {
  const envelope = JSON.parse(payload);
  if (Array.isArray(envelope)) return envelope;
  return envelope?.source === 'authoritative_order_snapshot' ? envelope.orders : null;
}
function originalAcknowledgement(payload: string | null, row: FillRow, direct: boolean): boolean {
  if (payload === null) return direct;
  const ack = acknowledgementOrders(payload);
  if (!Array.isArray(ack)) return false;
  const matches = ack.filter(item => item.clientOrderId === row.client_order_id);
  return matches.length === 1 && ackMatches(matches[0], row);
}
async function originalJournalProves(account: TradingAccount, row: FillRow): Promise<boolean> {
  const operations = await getDatabase().all<OriginalOperation[]>(`SELECT * FROM trading_operations WHERE account_id=? AND intent_id=?
    AND account_fingerprint=? AND phase IN ('dispatching','acknowledged','unresolved','resolved') AND kind IN ('submit','protected_entry')
    AND EXISTS(SELECT 1 FROM json_each(expected_orders_json) leg WHERE json_extract(leg.value,'$.client_order_id')=?)`,
  [account.id, row.intent_id, row.account_fingerprint, row.client_order_id]);
  const operation = operations[0];
  if (operations.length !== 1 || !operation) return false;
  const response = parse(row.response_json);
  const direct = response.id === row.exchange_order_id && response.clientOrderId === row.client_order_id && response.symbol === row.order_provider_symbol;
  return operationProves(operation, row, direct);
}

async function originalPaperProves(row: FillRow): Promise<boolean> {
  const matches = await getDatabase().all(`SELECT fill.exchange_fill_id FROM trading_paper_fills fill
    JOIN trading_paper_orders orders ON orders.exchange_order_id=fill.exchange_order_id AND orders.account_id=fill.account_id
    WHERE fill.account_id=? AND fill.exchange_fill_id=? AND fill.exchange_order_id=? AND fill.client_order_id=?
      AND orders.client_order_id=? AND orders.symbol=? AND orders.role=? AND orders.side=?
      AND fill.price=? AND fill.quantity=? AND fill.fee=? AND fill.fee_asset IS ? AND fill.filled_at=?`,
  [row.account_id,row.exchange_fill_id,row.exchange_order_id,row.client_order_id,row.client_order_id,row.order_provider_symbol,
    row.role,row.side,row.price,row.quantity,row.fee,row.fee_asset,row.filled_at]);
  return matches.length === 1;
}
async function legacyProof(account: TradingAccount, row: FillRow): Promise<ReturnType<typeof provenFillIdentity>> {
  if (account.exchange === 'paper' && account.mode === 'paper') {
    return await originalPaperProves(row) ? provenFillIdentity(account, snapshot(row)) : null;
  }
  return await originalLiveProof(account, row);
}
async function originalLiveProof(account: TradingAccount, row: FillRow): Promise<ReturnType<typeof provenFillIdentity>> {
  if (!originalAccountBound(account, row)) return null;
  const identity = legacyIdentity(account, row);
  if (!identity) return null;
  const proof = provenFillIdentity(account, snapshot(row, identity));
  return proof && await originalJournalProves(account, row) ? proof : null;
}

function originalAccountBound(account: TradingAccount, row: FillRow): boolean {
  return Boolean(row.account_fingerprint) && row.account_fingerprint === fillAccountFingerprint(account);
}
function isUnboundLegacyRow(row: FillRow | undefined): row is FillRow {
  return row?.identity_status === 'legacy_unresolved' && row.remote_fill_key === null;
}
async function safeLegacyProof(account: TradingAccount, row: FillRow): Promise<ReturnType<typeof provenFillIdentity>> {
  try { return await legacyProof(account, row); } catch { return null; }
}

/** Additive metadata only. Invalid originals are not repaired using current credentials or an incoming candidate. */
export async function bindLegacyFillIdentity(account: TradingAccount, fillId: string): Promise<boolean> {
  return await withDatabaseTransaction(async () => {
    const row = await getDatabase().get<FillRow>(`${SELECT_FILLS} WHERE fills.id=? AND fills.account_id=?`, [fillId, account.id]);
    if (!isUnboundLegacyRow(row)) return false;
    const proof = await safeLegacyProof(account, row);
    if (!proof) return false;
    const duplicate = await getDatabase().get('SELECT id FROM trading_fills WHERE account_id=? AND remote_fill_key=?', [account.id, proof.key]);
    if (duplicate) return false;
    const result = await getDatabase().run(`UPDATE trading_fills SET provider_symbol=?,remote_fill_key=?,identity_json=?,identity_status='proven'
      WHERE id=? AND remote_fill_key IS NULL AND raw_json=? AND account_fingerprint IS ?`,
    [proof.identity.providerSymbol,proof.key,JSON.stringify(proof.identity),row.id,row.raw_json,row.account_fingerprint]);
    return result.changes === 1;
  });
}

interface BackfillCursor { id: string; filled_at: number }
const backfillCursors = new WeakMap<object, Map<string, BackfillCursor>>();
const BACKFILL_ATTEMPTS = 500;

async function nextBackfillRows(accountId: string, cursor?: BackfillCursor): Promise<BackfillCursor[]> {
  const condition = cursor ? ' AND (filled_at>? OR (filled_at=? AND id>?))' : '';
  const parameters = cursor ? [accountId, cursor.filled_at, cursor.filled_at, cursor.id] : [accountId];
  return await getDatabase().all<BackfillCursor[]>(`SELECT id,filled_at FROM trading_fills
    WHERE account_id=? AND identity_status='legacy_unresolved'${condition} ORDER BY filled_at,id LIMIT ${BACKFILL_ATTEMPTS}`, parameters);
}

function databaseBackfillCursors(): Map<string, BackfillCursor> {
  const database = getDatabase();
  const existing = backfillCursors.get(database);
  if (existing) return existing;
  const cursors = new Map<string, BackfillCursor>();
  backfillCursors.set(database, cursors);
  return cursors;
}

function advanceBackfillCursor(cursors: Map<string, BackfillCursor>, accountId: string, rows: BackfillCursor[]): void {
  const last = rows.at(-1);
  if (rows.length === BACKFILL_ATTEMPTS && last) cursors.set(accountId, last);
  else cursors.delete(accountId);
}
/** At most 500 examined rows, with fair keyset rotation; restart conservatively starts a new pass. */
export async function backfillAccountFillIdentities(account: TradingAccount): Promise<void> {
  await withDatabaseTransaction(async () => {
    const cursors = databaseBackfillCursors();
    let rows = await nextBackfillRows(account.id, cursors.get(account.id));
    if (!rows.length && cursors.has(account.id)) rows = await nextBackfillRows(account.id);
    for (const row of rows) await bindLegacyFillIdentity(account, row.id);
    advanceBackfillCursor(cursors, account.id, rows);
  });
}

function storedIdentityProven(account: TradingAccount, row: FillRow): boolean {
  const identity: ExchangeFillIdentity | null = row.identity_json ? JSON.parse(row.identity_json) : null;
  const proof = identity ? provenFillIdentity(account, snapshot(row, identity)) : null;
  const bound = account.exchange === 'paper' || row.account_fingerprint === fillAccountFingerprint(account);
  return storedProofMatches(row, bound, proof, identity);
}
function storedProofMatches(row: FillRow, bound: boolean, proof: ReturnType<typeof provenFillIdentity>, identity: ExchangeFillIdentity | null): boolean {
  return row.identity_status === 'proven' && bound && proof?.key === row.remote_fill_key
    && isDeepStrictEqual(identity, proof.identity);
}
async function rowIdentityResolved(account: TradingAccount, row: FillRow): Promise<boolean> {
  try {
    if (storedIdentityProven(account, row)) return true;
    return row.identity_status === 'legacy_unresolved' && account.exchange === 'paper' && await originalPaperProves(row);
  } catch { return false; /* Malformed original identity is uncertainty, never absence. */ }
}
/** Every caller receives a defined count. Legacy data is never silently interpreted as zero uncertainty. */
export async function unresolvedFillIdentityCount(account: TradingAccount): Promise<number> {
  const rows = await getDatabase().all<FillRow[]>(`${SELECT_FILLS} WHERE fills.account_id=? ORDER BY fills.id`, [account.id]);
  let unresolved = 0;
  for (const row of rows) {
    if (!await rowIdentityResolved(account, row)) unresolved += 1;
  }
  return unresolved;
}
