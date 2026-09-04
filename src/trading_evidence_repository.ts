import { createHash, randomUUID } from 'node:crypto';
import { getDatabase, withDatabaseTransaction } from './db.js';
import { compareDecimal, signedDecimal } from './trading_decimal.js';
import { validateAcquisitionEvidence } from './exchange_contract_validation.js';
import { persistHistoryProgress } from './trading_history_repository.js';
import { provesManagedHistory } from './trading_history_evidence.js';
import { captureFillAccounting } from './trading_fill_accounting.js';
import { captureFillQuantityEvidence } from './trading_fill_quantity_repository.js';
import { captureFxReceipts } from './trading_fx_repository.js';
import { assertScheduledAcquisition, completeScheduledRecovery } from './trading_recovery_schedule_repository.js';
import { persistAccountLogProgress } from './trading_account_log_repository.js';
import { persistAccountModeObservation } from './trading_account_mode.js';
import { projectAccountLogScope } from './trading_account_scope.js';
import { provenFillIdentity, fillAccountFingerprint } from './trading_fill_identity.js';
import { backfillAccountFillIdentities, bindLegacyFillIdentity } from './trading_fill_identity_repository.js';
import type { ExchangeAcquisitionEvidence, ExchangeFill, ExchangeUnresolvedEvent, TradingAccount } from './trading_types.js';

/** Store query provenance only after all received economic events have been durably ingested. */
export async function recordAcquisitionEvidence(account: TradingAccount, evidence: ExchangeAcquisitionEvidence): Promise<void> {
  const clean = validateAcquisitionEvidence(evidence);
  await withDatabaseTransaction(async () => {
    if (clean.recoverySchedule) await assertScheduledAcquisition(account, clean);
    if (clean.fxEvidence) await captureFxReceipts(account, clean.fxEvidence.receipts, clean);
    if (clean.accountLogs) await persistAccountLogProgress(account, clean.accountLogs);
    if (clean.accountMode) await persistAccountModeObservation(account, clean.accountMode, clean);
    await backfillAccountFillIdentities(account);
    await persistHistoryProgress(account, clean.history ?? []);
    const acquisitionId = randomUUID();
    await getDatabase().run(
      `INSERT INTO trading_acquisition_evidence (id, account_id, account_fingerprint, payload_json, started_at, completed_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [acquisitionId, account.id, account.externalAccountId, JSON.stringify(clean), clean.startedAt, clean.completedAt, Date.now()],
    );
    for (const checked of clean.checkedOrders) {
      if (checked.status === 'budget_exhausted' || checked.status === 'transient') continue;
      await getDatabase().run(
        `UPDATE trading_orders SET last_recovery_attempt_at = MAX(COALESCE(last_recovery_attempt_at, 0), ?)
         WHERE account_id = ? AND client_order_id = ?`, [clean.completedAt, account.id, checked.clientOrderId],
      );
    }
    await projectAccountLogScope(account);
    if (clean.recoverySchedule) await completeScheduledRecovery(account, acquisitionId);
  });
}

const EVIDENCE_FIELDS = [
  'exchangeFillId', 'exchangeOrderId', 'clientOrderId', 'symbol', 'providerSymbol', 'side', 'type',
  'price', 'quantity', 'cost', 'fee', 'feeAsset', 'feeRate', 'filledAt', 'status', 'filledQuantity',
  'triggerPrice', 'reduceOnly', 'averagePrice',
  'providerEventId', 'providerTimestamp', 'eventType', 'eventOrderField', 'providerReportedQuantity',
  'fillIdentityProfile', 'fillMarketNamespace', 'fillProviderMarketId', 'fillScopeTimestamp',
  'providerParentOrderLinkId', 'providerParentMarketId', 'providerParentStopType',
] as const;

/** Only normalized economic fields cross this boundary; never raw info/headers/credentials. */
export function economicEvidence(value: object): ExchangeUnresolvedEvent['evidence'] {
  const record = value as Record<string, unknown>;
  const result: ExchangeUnresolvedEvent['evidence'] = {};
  for (const field of EVIDENCE_FIELDS) {
    const item = record[field];
    if (item === undefined) continue;
    if (item === null) result[field] = null;
    else if (typeof item === 'boolean') result[field] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) result[field] = item;
    else if (typeof item === 'string' && item.length <= 256) result[field] = item;
    else throw new Error('Remote economic evidence exceeds its safe field boundary.');
  }
  return result;
}

function evidenceIdentity(account: TradingAccount, event: ExchangeUnresolvedEvent, hash: string): string {
  if (event.kind === 'fill' && event.evidence.fillIdentityProfile) return JSON.stringify(['fill-v1', account.exchange,
    fillAccountFingerprint(account), event.evidence.fillIdentityProfile, event.evidence.fillMarketNamespace,
    event.evidence.fillProviderMarketId, event.providerId, event.evidence.fillScopeTimestamp]);
  return JSON.stringify(['v2', account.exchange, account.externalAccountId, event.kind, event.providerSymbol,
    event.providerId || ['unidentified', event.source, hash]]);
}

export function fillEvidence(fill: ExchangeFill, reason: string): ExchangeUnresolvedEvent {
  return { kind: 'fill', source: 'fetchMyTrades', reason, providerId: fill.exchangeFillId,
    providerSymbol: fill.providerSymbol ?? fill.symbol ?? null, evidence: economicEvidence({ ...fill, ...(fill.identity ? {
      fillIdentityProfile: fill.identity.profile, fillMarketNamespace: fill.identity.marketNamespace,
      fillProviderMarketId: fill.identity.providerMarketId, fillScopeTimestamp: fill.identity.scopeTimestamp,
    } : {}) }) };
}

export async function recordRemoteEvidence(account: TradingAccount, event: ExchangeUnresolvedEvent): Promise<void> {
  const payload = JSON.stringify(economicEvidence(event.evidence));
  const hash = createHash('sha256').update(payload).digest('hex');
  const key = evidenceIdentity(account, event, hash);
  const now = Date.now();
  await withDatabaseTransaction(async () => {
    const database = getDatabase();
    const conflict = event.kind === 'fill' && await database.get(
      'SELECT id FROM trading_remote_evidence WHERE account_id = ? AND identity_key = ? AND content_hash <> ? LIMIT 1',
      [account.id, key, hash],
    );
    await database.run(
      `INSERT INTO trading_remote_evidence (
        id, account_id, provider, kind, source, provider_id, provider_symbol, identity_key, content_hash,
        payload_json, reason, classification, first_seen_at, last_seen_at, account_fingerprint, occurrence_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(account_id, identity_key, content_hash) DO UPDATE SET
        last_seen_at = excluded.last_seen_at, occurrence_count = occurrence_count + 1`,
      [randomUUID(), account.id, account.exchange, event.kind, event.source, event.providerId, event.providerSymbol,
        key, hash, payload, event.reason.slice(0, 256), conflict ? 'conflict' : 'unresolved', now, now, account.externalAccountId],
    );
    if (conflict) await database.run(
      "UPDATE trading_remote_evidence SET classification = 'conflict' WHERE account_id = ? AND identity_key = ?",
      [account.id, key],
    );
  });
}

export async function unresolvedEvidenceCount(accountId: string): Promise<number> {
  const row = await getDatabase().get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM trading_remote_evidence WHERE account_id = ? AND classification IN ('unresolved', 'conflict')", [accountId],
  );
  return Number(row?.count || 0);
}

/** Later exact order/fill evidence can classify earlier history, never a user acknowledgement alone. */
export async function resolveManagedHistoricalEvidence(accountId: string): Promise<void> {
  const rows = await getDatabase().all<Array<{ id: string; payload_json: string; provider_symbol: string | null }>>(
    `SELECT evidence.id, evidence.payload_json, evidence.provider_symbol FROM trading_remote_evidence AS evidence
     WHERE evidence.account_id = ? AND evidence.kind = 'order' AND evidence.reason = 'historical_order_event'
       AND evidence.classification = 'unresolved' AND EXISTS (
         SELECT 1 FROM trading_orders AS orders WHERE orders.account_id = evidence.account_id
           AND orders.exchange_order_id = json_extract(evidence.payload_json, '$.exchangeOrderId')
           AND orders.provider_symbol = evidence.provider_symbol)
     ORDER BY evidence.first_seen_at, evidence.id LIMIT 500`, [accountId],
  );
  for (const row of rows) {
    if (await provesManagedHistory(accountId, JSON.parse(row.payload_json), row.provider_symbol)) await getDatabase().run(
      "UPDATE trading_remote_evidence SET classification = 'managed' WHERE id = ? AND classification = 'unresolved'", [row.id],
    );
  }
}

interface FillOrder {
  id: string; intent_id: string; role: string; status: string;
  exchange_order_id: string | null; provider_symbol: string | null; symbol: string;
}
interface FillResult { order: FillOrder | null; inserted: boolean; fillId?: string; remoteFillKey?: string }

function matchesOrder(order: FillOrder | undefined, fill: ExchangeFill): order is FillOrder {
  return Boolean(order && order.exchange_order_id === fill.exchangeOrderId
    && (!fill.symbol || fill.symbol === order.symbol)
    && (!order.provider_symbol || fill.providerSymbol === order.provider_symbol));
}

function sameFill(row: any, order: FillOrder, fill: ExchangeFill): boolean {
  return row.order_id === order.id && compareDecimal(row.price, fill.price) === 0
    && compareDecimal(row.quantity, fill.quantity) === 0 && signedDecimal(row.fee) === signedDecimal(fill.fee)
    && row.fee_asset === fill.feeAsset && Number(row.filled_at) === fill.filledAt
    && (row.provider_symbol == null || row.provider_symbol === fill.providerSymbol);
}

async function assertFillAccount(account: TradingAccount): Promise<void> {
  const current = await getDatabase().get<{ exchange: string; mode: string; external_account_id: string | null }>(
    'SELECT exchange,mode,external_account_id FROM trading_accounts WHERE id=?', [account.id]);
  if (!current || current.exchange !== account.exchange || current.mode !== account.mode
    || (account.exchange !== 'paper' && current.external_account_id !== account.externalAccountId)) throw new Error('FILL_ACCOUNT_IDENTITY_CHANGED');
}

async function markProvenFill(account: TradingAccount, fill: ExchangeFill): Promise<void> {
  const event = fillEvidence(fill, 'correlated_fill');
  const payload = JSON.stringify(event.evidence);
  const hash = createHash('sha256').update(payload).digest('hex');
  const candidates = await getDatabase().all<Array<{ id: string; payload_json: string }>>(
    "SELECT id, payload_json FROM trading_remote_evidence WHERE account_id = ? AND identity_key = ? AND classification = 'unresolved'",
    [account.id, evidenceIdentity(account, event, hash)],
  );
  for (const candidate of candidates) {
    if (evidenceMatchesProvenFill(JSON.parse(candidate.payload_json), fill)) await getDatabase().run(
      "UPDATE trading_remote_evidence SET classification = 'managed' WHERE id = ? AND classification = 'unresolved'", [candidate.id],
    );
  }
}

function evidenceMatchesProvenFill(evidence: any, fill: ExchangeFill): boolean {
  const fields: Array<keyof ExchangeFill> = ['exchangeFillId', 'exchangeOrderId', 'price', 'quantity', 'fee', 'feeAsset', 'filledAt'];
  return fields.every(field => evidence[field] === fill[field])
    && (evidence.clientOrderId === null || evidence.clientOrderId === fill.clientOrderId);
}

/** A reused provider fill ID with changed economics is a conflict, never INSERT OR IGNORE. */
export async function persistCorrelatedFill(account: TradingAccount, fill: ExchangeFill, read?: ExchangeAcquisitionEvidence): Promise<FillResult> {
  const proof = provenFillIdentity(account, fill);
  if (proof) fill = { ...fill, identity: proof.identity };
  return withDatabaseTransaction(async () => {
    const database = getDatabase();
    await assertFillAccount(account);
    const order = await database.get<FillOrder>(
      `SELECT orders.*, intent.symbol FROM trading_orders AS orders JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id
       WHERE orders.account_id = ? AND orders.client_order_id = ?`, [account.id, fill.clientOrderId],
    );
    if (!matchesOrder(order, fill)) {
      await recordRemoteEvidence(account, fillEvidence(fill, 'unmapped_fill'));
      return { order: null, inserted: false };
    }
    if (!proof) {
      await recordRemoteEvidence(account, fillEvidence(fill, 'fill_identity_unproven'));
      return { order: null, inserted: false };
    }
    let existing = await database.get<any>('SELECT * FROM trading_fills WHERE account_id = ? AND remote_fill_key = ?', [account.id, proof.key]);
    if (!existing) {
      const legacy = await resolveLegacyFill(account, order, fill, proof);
      if (legacy.blocked) return { order: null, inserted: false };
      existing = legacy.existing;
    }
    if (existing && !sameFill(existing, order, fill)) {
      await recordFillConflict(account, existing, fill);
      return { order: null, inserted: false };
    }
    const fillId = existing?.id ?? randomUUID();
    if (!existing) await database.run(
      `INSERT INTO trading_fills (id, order_id, account_id, exchange_fill_id, price, quantity, fee, fee_asset, filled_at, raw_json,
        provider_symbol,remote_fill_key,identity_status,identity_json,account_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proven', ?, ?)`,
      [fillId, order.id, account.id, fill.exchangeFillId, fill.price, fill.quantity, fill.fee, fill.feeAsset, fill.filledAt, JSON.stringify(fill.raw),
        proof.identity.providerSymbol, proof.key, JSON.stringify(proof.identity), fillAccountFingerprint(account)],
    );
    await markProvenFill(account, fill);
    await captureFillAccounting(account, fill, fillId);
    await captureFillQuantityEvidence(account, fill, fillId, !existing, read);
    return { order, inserted: !existing, fillId, remoteFillKey: proof.key };
  });
}

async function resolveLegacyFill(account: TradingAccount, order: FillOrder, fill: ExchangeFill,
  proof: NonNullable<ReturnType<typeof provenFillIdentity>>): Promise<{ blocked: boolean; existing?: any }> {
  const candidates = await getDatabase().all<any[]>(`SELECT * FROM trading_fills WHERE account_id=? AND remote_fill_key IS NULL
    AND (exchange_fill_id=? OR (?='krakenfutures' AND order_id=?))`, [account.id, fill.exchangeFillId, account.exchange, order.id]);
  if (!candidates.length) return { blocked: false };
  if (account.exchange !== 'paper') {
    for (const candidate of candidates) {
      if (!await bindLegacyFillIdentity(account, candidate.id)) {
        await recordRemoteEvidence(account, fillEvidence(fill, 'legacy_fill_identity_unproven'));
        return { blocked: true };
      }
    }
    const existing = await getDatabase().get('SELECT * FROM trading_fills WHERE account_id=? AND remote_fill_key=?', [account.id, proof.key]);
    return { blocked: false, existing };
  }
  // Simulator identity is scoped by its own order/market. No Kraken recent-fill/execution alias is documented.
  if (account.exchange === 'paper' && account.mode === 'paper' && candidates.length === 1 && sameFill(candidates[0], order, fill)) {
    const existing = candidates[0];
    await getDatabase().run(`UPDATE trading_fills SET provider_symbol=?,remote_fill_key=?,identity_json=?,identity_status='proven'
      WHERE id=? AND remote_fill_key IS NULL`, [proof.identity.providerSymbol, proof.key, JSON.stringify(proof.identity), existing.id]);
    return { blocked: false, existing };
  }
  await recordRemoteEvidence(account, fillEvidence(fill, 'legacy_fill_identity_unproven'));
  return { blocked: true };
}

async function recordFillConflict(account: TradingAccount, existing: any, incoming: ExchangeFill): Promise<void> {
  const original = await getDatabase().get<any>(
    `SELECT orders.client_order_id, orders.exchange_order_id, orders.provider_symbol, intent.symbol
     FROM trading_orders AS orders JOIN trading_trade_intents AS intent ON intent.id = orders.intent_id WHERE orders.id = ?`, [existing.order_id],
  );
  await recordRemoteEvidence(account, fillEvidence({
    ...incoming, clientOrderId: original.client_order_id, exchangeOrderId: original.exchange_order_id,
    symbol: original.symbol, providerSymbol: original.provider_symbol ?? undefined,
    price: existing.price, quantity: existing.quantity, fee: existing.fee, feeAsset: existing.fee_asset,
    filledAt: Number(existing.filled_at), raw: {}, identity: existing.identity_json ? JSON.parse(existing.identity_json) : undefined,
  }, 'conflicting_fill'));
  await recordRemoteEvidence(account, fillEvidence(incoming, 'conflicting_fill'));
  await getDatabase().run("UPDATE trading_fills SET identity_status='conflict',accounting_conflict=1 WHERE id=?", [existing.id]);
  await getDatabase().run(
    "UPDATE trading_remote_evidence SET classification = 'conflict' WHERE account_id = ? AND kind = 'fill' AND identity_key = ?",
    [account.id, existing.remote_fill_key],
  );
}
