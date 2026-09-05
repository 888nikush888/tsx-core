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
function object(value: unknown): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}; }
function parse(value: string | null): Record<string, any> { return value === null ? {} : object(JSON.parse(value)); }
function codePointOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
function snapshot(row: FillRow, identity?: ExchangeFillIdentity): ExchangeFill {
  return { exchangeFillId: row.exchange_fill_id, exchangeOrderId: row.exchange_order_id!, clientOrderId: row.client_order_id,
    symbol: row.symbol, providerSymbol: row.order_provider_symbol ?? undefined, price: row.price, quantity: row.quantity,
    fee: row.fee, feeAsset: row.fee_asset, filledAt: row.filled_at, raw: JSON.parse(row.raw_json), identity };
}

function legacyIdentity(account: TradingAccount, row: FillRow): ExchangeFillIdentity | null {
  const raw = parse(row.raw_json), info = object(raw.info);
  if (!row.order_provider_symbol || raw.symbol !== row.order_provider_symbol) return null;
  const base = { version: 1 as const, providerSymbol: row.order_provider_symbol, providerFillId: row.exchange_fill_id, scopeTimestamp: null };
  if (account.exchange === 'bybit') {
    const metadata = parse(row.accounting_json);
    if (metadata.source !== 'ccxt-market-v1' || metadata.linear !== true || metadata.quantityUnit !== 'base'
      || metadata.providerSymbol !== row.order_provider_symbol || !bybitPerpetualSymbol(row.order_provider_symbol, metadata.settlementAsset)) return null;
    return { ...base, profile: 'bybit_execution_v1', marketNamespace: 'linear', providerMarketId: info.symbol };
  }
  if (account.exchange === 'hyperliquid') return { ...base, profile: 'hyperliquid_user_fill_v1', marketNamespace: 'perpetual',
    providerMarketId: info.coin, scopeTimestamp: info.time };
  if (account.exchange === 'krakenfutures' && info.identitySource === 'kraken_history_execution_v3') {
    return { ...base, profile: 'kraken_history_execution_v3', marketNamespace: 'futures', providerMarketId: info.tradeable };
  }
  return null;
}

function bybitPerpetualSymbol(symbol: string, settlementAsset: unknown): boolean {
  // Pinned CCXT4.5.75: spot has no ':'; futures/options always append an expiry suffix.
  // This classifies the exact ORIGINAL unified symbol. It never manufactures the native market ID.
  const match = /^([A-Z0-9]+)\/(USDT|USDC):(USDT|USDC)$/.exec(symbol);
  return !!match && match[2] === match[3] && match[3] === settlementAsset;
}

function ackMatches(value: unknown, row: FillRow): boolean {
  const ack = object(value);
  return ack.clientOrderId === row.client_order_id && ack.exchangeOrderId === row.exchange_order_id
    && ack.providerSymbol === row.order_provider_symbol;
}
function legMatches(value: unknown, row: FillRow): boolean {
  const leg = object(value);
  return leg.accountId === row.account_id && leg.clientOrderId === row.client_order_id && leg.symbol === row.symbol
    && leg.role === row.role && leg.side === row.side && leg.orderType === row.order_type && leg.reduceOnly === (row.reduce_only === 1)
    && leg.price === row.order_price && leg.triggerPrice === row.trigger_price && compareDecimal(leg.quantity, row.order_quantity) === 0;
}
interface OriginalOperation { kind: string; request_json: string; request_hash: string; evidence_json: string | null;
  expected_orders_json: string; credential_generation: string | null; logical_key: string; generation: number }
function operationProves(operation: OriginalOperation, row: FillRow, direct: boolean): boolean {
  if (!operation.credential_generation || !Number.isSafeInteger(operation.generation) || operation.generation < 1
    || digest(operation.request_json) !== operation.request_hash) return false;
  const request = JSON.parse(operation.request_json);
  const legs = operation.kind === 'protected_entry' ? [request.entry, request.protectiveStop] : [request];
  const expected = JSON.parse(operation.expected_orders_json);
  if (!Array.isArray(expected) || expected.length !== legs.length || legs.filter(leg => legMatches(leg, row)).length !== 1) return false;
  const ids = legs.map(leg => leg.clientOrderId).sort(codePointOrder);
  if (new Set(ids).size !== ids.length
    || !isDeepStrictEqual(expected.map(item => item.client_order_id).sort(codePointOrder), ids)
    || operation.logical_key !== digest(JSON.stringify([operation.kind, row.intent_id, ids]))) return false;
  return originalAcknowledgement(operation.evidence_json, row, direct);
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function originalAcknowledgement(payload: string | null, row: FillRow, direct: boolean): boolean {
  if (payload === null) return direct;
  const envelope = JSON.parse(payload);
  const ack = Array.isArray(envelope) ? envelope : envelope?.source === 'authoritative_order_snapshot' ? envelope.orders : null;
  if (!Array.isArray(ack)) return false;
  const matches = ack.filter(item => item.clientOrderId === row.client_order_id);
  return matches.length === 1 && ackMatches(matches[0], row);
}
async function originalJournalProves(account: TradingAccount, row: FillRow): Promise<boolean> {
  const operations = await getDatabase().all<OriginalOperation[]>(`SELECT * FROM trading_operations WHERE account_id=? AND intent_id=?
    AND account_fingerprint=? AND phase IN ('dispatching','acknowledged','unresolved','resolved') AND kind IN ('submit','protected_entry')
    AND EXISTS(SELECT 1 FROM json_each(expected_orders_json) leg WHERE json_extract(leg.value,'$.client_order_id')=?)`,
  [account.id, row.intent_id, row.account_fingerprint, row.client_order_id]);
  if (operations.length !== 1) return false;
  const response = parse(row.response_json);
  const direct = response.id === row.exchange_order_id && response.clientOrderId === row.client_order_id && response.symbol === row.order_provider_symbol;
  return operationProves(operations[0]!, row, direct);
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
  if (!row.account_fingerprint || row.account_fingerprint !== fillAccountFingerprint(account)) return null;
  const identity = legacyIdentity(account, row);
  if (!identity) return null;
  const proof = provenFillIdentity(account, snapshot(row, identity));
  return proof && await originalJournalProves(account, row) ? proof : null;
}

/** Additive metadata only. Invalid originals are not repaired using current credentials or an incoming candidate. */
export async function bindLegacyFillIdentity(account: TradingAccount, fillId: string): Promise<boolean> {
  return withDatabaseTransaction(async () => {
    const row = await getDatabase().get<FillRow>(`${SELECT_FILLS} WHERE fills.id=? AND fills.account_id=?`, [fillId, account.id]);
    if (!row || row.identity_status !== 'legacy_unresolved' || row.remote_fill_key !== null) return false;
    let proof: ReturnType<typeof provenFillIdentity>;
    try { proof = await legacyProof(account, row); } catch { return false; }
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

async function nextBackfillRows(accountId: string, cursor: BackfillCursor | undefined): Promise<BackfillCursor[]> {
  const condition = cursor ? ' AND (filled_at>? OR (filled_at=? AND id>?))' : '';
  const parameters = cursor ? [accountId, cursor.filled_at, cursor.filled_at, cursor.id] : [accountId];
  return getDatabase().all<BackfillCursor[]>(`SELECT id,filled_at FROM trading_fills
    WHERE account_id=? AND identity_status='legacy_unresolved'${condition} ORDER BY filled_at,id LIMIT ${BACKFILL_ATTEMPTS}`, parameters);
}

/** At most 500 examined rows, with fair keyset rotation; restart conservatively starts a new pass. */
export async function backfillAccountFillIdentities(account: TradingAccount): Promise<void> {
  await withDatabaseTransaction(async () => {
    const database = getDatabase();
    let cursors = backfillCursors.get(database);
    if (!cursors) { cursors = new Map(); backfillCursors.set(database, cursors); }
    let rows = await nextBackfillRows(account.id, cursors.get(account.id));
    if (!rows.length && cursors.has(account.id)) rows = await nextBackfillRows(account.id, undefined);
    for (const row of rows) await bindLegacyFillIdentity(account, row.id);
    if (rows.length === BACKFILL_ATTEMPTS) cursors.set(account.id, rows[rows.length - 1]!);
    else cursors.delete(account.id);
  });
}

/** Every caller receives a defined count. Legacy data is never silently interpreted as zero uncertainty. */
export async function unresolvedFillIdentityCount(account: TradingAccount): Promise<number> {
  const rows = await getDatabase().all<FillRow[]>(`${SELECT_FILLS} WHERE fills.account_id=? ORDER BY fills.id`, [account.id]);
  let unresolved = 0;
  for (const row of rows) {
    try {
      const proof = row.identity_json ? provenFillIdentity(account, snapshot(row, JSON.parse(row.identity_json))) : null;
      const bound = account.exchange === 'paper' || row.account_fingerprint === fillAccountFingerprint(account);
      if (row.identity_status === 'proven' && bound && proof?.key === row.remote_fill_key
        && isDeepStrictEqual(JSON.parse(row.identity_json!), proof.identity)) continue;
      if (row.identity_status === 'legacy_unresolved' && account.exchange === 'paper' && await originalPaperProves(row)) continue;
    } catch { /* Malformed original identity is uncertainty, never absence. */ }
    unresolved += 1;
  }
  return unresolved;
}
