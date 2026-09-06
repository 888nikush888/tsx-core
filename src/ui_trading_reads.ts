import { createHash } from 'node:crypto';
import { getDatabase } from './db.js';
import { maskPII } from './logger.js';
import { decodeUiCursor, encodeUiCursor, filterFingerprint } from './ui_cursor.js';
import { readProtectionProjection } from './trading_protection_projection.js';
import { loadOwnershipProof, TradingOwnershipError } from './trading_ownership.js';
import { TRADING_ACCOUNT_STATUSES, TRADING_ORDER_STATUSES } from './ui_contracts.js';

const LISTS = {
  'risk-events': { table: 'trading_risk_events', clock: 'created_at', account: 'account_id', intent: 'intent_id',
    fields: "id, account_id AS accountId, intent_id AS intentId, code, severity, acknowledged_at AS acknowledgedAt, CASE WHEN acknowledged_at IS NULL THEN 'unacknowledged' ELSE 'acknowledged' END AS status",
    states: ['unacknowledged', 'acknowledged'] },
  accounts: { table: 'trading_accounts', clock: 'created_at', account: 'id', intent: null,
    fields: 'id, name, exchange, mode, status, enabled, max_concurrent_positions AS maxConcurrentPositions, retired_at AS retiredAt',
    states: TRADING_ACCOUNT_STATUSES },
  positions: { table: 'trading_positions', clock: '0', account: 'account_id', intent: 'intent_id',
    fields: 'id, account_id AS accountId, intent_id AS intentId, symbol, side, status, quantity, average_entry_price AS averageEntryPrice, stop_price AS stopPrice, opened_at AS openedAt, closed_at AS closedAt, updated_at AS updatedAt',
    states: ['opening', 'open', 'closing', 'closed', 'emergency'] },
  orders: { table: 'trading_orders', clock: 'created_at', account: 'account_id', intent: 'intent_id',
    fields: 'id, account_id AS accountId, intent_id AS intentId, role, side, order_type AS orderType, status, quantity, filled_quantity AS filledQuantity, price, trigger_price AS triggerPrice, reduce_only AS reduceOnly, entry_drain_requested_at AS cancelRequestedAt, entry_drain_attempted_at AS cancelAttemptedAt, last_error AS reason, updated_at AS updatedAt',
    states: TRADING_ORDER_STATUSES },
  operations: { table: 'trading_operations', clock: 'created_at', account: 'account_id', intent: 'intent_id',
    fields: 'id, account_id AS accountId, intent_id AS intentId, kind, generation, request_hash AS requestHash, phase AS status, last_error AS reason, updated_at AS updatedAt',
    states: ['prepared', 'dispatching', 'acknowledged', 'unresolved', 'resolved', 'abandoned'] },
  incidents: { table: 'trading_account_incidents', clock: 'first_seen_at', account: 'account_id', intent: null,
    fields: 'id, account_id AS accountId, category, severity, message AS reason, status, occurrence_count AS occurrences, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, resolved_at AS resolvedAt',
    states: ['open', 'resolved'] },
  reconciliations: { table: 'trading_reconciliation_runs', clock: 'started_at', account: 'account_id', intent: null,
    fields: 'id, account_id AS accountId, status, last_error AS reason, started_at AS startedAt, completed_at AS completedAt',
    states: ['running', 'succeeded', 'failed', 'mismatch'] },
} as const;
export type UiTradingList = keyof typeof LISTS;

export function uiObjectId(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\r\n\0]/.test(value)) throw new Error('Invalid object identifier.');
  return value;
}

function activeAccountFilter(kind: UiTradingList, query: URLSearchParams) {
  const value = query.get('activeOnly');
  if (value !== null && (kind !== 'accounts' || !['true', 'false'].includes(value))) throw new Error('Invalid active account filter.');
  return value === 'true';
}
function tradingFilters(kind: UiTradingList, query: URLSearchParams) {
  const definition = LISTS[kind];
  if (!Object.hasOwn(LISTS, kind)) throw new Error('Unsupported trading list.');
  const status = query.get('status') || '';
  const accountId = query.get('accountId') ? uiObjectId(query.get('accountId')) : '';
  const intentId = query.get('intentId') ? uiObjectId(query.get('intentId'), 64) : '';
  const objectId = query.get('objectId') ? uiObjectId(query.get('objectId')) : '';
  const activeOnly = activeAccountFilter(kind, query);
  const limit = Number(query.get('limit') || 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (intentId && !definition.intent)
    || (status && !(definition.states as readonly string[]).includes(status))) throw new Error('Invalid trading filters.');
  return { status, accountId, intentId, objectId, activeOnly, limit };
}

export async function uiTradingPage(kind: UiTradingList, query: URLSearchParams) {
  const { status, accountId, intentId, objectId, activeOnly, limit } = tradingFilters(kind, query);
  const definition = LISTS[kind];
  const filter = filterFingerprint({ kind, accountId, intentId, objectId, status, activeOnly, limit });
  const cursor = decodeUiCursor(query.get('cursor'), filter);
  const observedAt = cursor?.observedAt ?? Date.now();
  const where = [`(${definition.clock}) <= ?`]; const values: unknown[] = [observedAt];
  if (activeOnly) where.push('retired_at IS NULL');
  if (accountId) { where.push(`${definition.account} = ?`); values.push(accountId); }
  if (objectId) { where.push('id = ?'); values.push(objectId); }
  if (intentId) { where.push(`${definition.intent} = ?`); values.push(intentId); }
  if (status) { where.push(`${kind === 'operations' ? 'phase' : kind === 'risk-events' ? "CASE WHEN acknowledged_at IS NULL THEN 'unacknowledged' ELSE 'acknowledged' END" : 'status'} = ?`); values.push(status); }
  if (cursor) { where.push(`((${definition.clock}) < ? OR ((${definition.clock}) = ? AND id < ?))`); values.push(cursor.createdAt, cursor.createdAt, cursor.id); }
  const rows = await getDatabase().all(`SELECT ${definition.fields}, (${definition.clock}) AS cursorTime FROM ${definition.table} WHERE ${where.join(' AND ')} ORDER BY cursorTime DESC, id DESC LIMIT ?`, [...values, limit + 1]);
  const entries = rows.slice(0, limit).map(({ cursorTime: _clock, ...row }) => ({ ...row, ...(row.reason ? { reason: maskPII(row.reason).slice(0, 2000) } : {}) }));
  const last = rows[Math.min(limit, rows.length) - 1];
  return { contractVersion: 1, entries, observedAt, hasMore: rows.length > limit, states: definition.states,
    snapshotContext: kind === 'positions' ? 'Stable ID order; current position membership on each page.' : 'Creation cutoff; current status on each page.',
    nextCursor: rows.length > limit && last ? encodeUiCursor({ version: 1, filter, observedAt, createdAt: last.cursorTime, id: String(last.id) }) : null };
}

function redactedProof(projection: Awaited<ReturnType<typeof readProtectionProjection>>[number]) {
  const proof = projection.proof;
  return { ...projection, proof: proof ? { ...proof, binding: { ...proof.binding, accountFingerprint: proof.binding.accountFingerprint ? '[redacted]' : null } } : null };
}

function publicOwnershipFailure(error: unknown): string {
  const reasons: Record<string, string> = {
    ORDER_SEMANTICS: 'Original order direction or reduce-only evidence is inconsistent.',
    UNMAPPED_FILL: 'An original fill has no managed order.',
    ORDER_OVERFILLED: 'Original fills exceed the order quantity.',
    CUMULATIVE_EXECUTION_MISMATCH: 'Original fills and cumulative execution disagree.',
    EXITS_EXCEED_ENTRIES: 'Original exits exceed original entries.',
  };
  return error instanceof TradingOwnershipError && Object.hasOwn(reasons, error.code)
    ? reasons[error.code] : 'Ownership proof is unavailable. Inspect the original orders and fills, then retry.';
}

export async function uiTradeSafety(intentId: string, accountId: string) {
  const [projections, position, operations] = await Promise.all([
    readProtectionProjection({ accountId, intentId }),
    getDatabase().get('SELECT side, quantity, stop_price AS stopPrice, updated_at AS updatedAt FROM trading_positions WHERE intent_id = ?', [intentId]),
    uiTradingPage('operations', new URLSearchParams({ intentId, limit: '100' })),
  ]);
  let ownership = null; let ownershipReason: string | null = null;
  const hasEntry = await getDatabase().get("SELECT id FROM trading_orders WHERE intent_id = ? AND role = 'entry' LIMIT 1", [intentId]);
  if (position && hasEntry) {
    try { ownership = await loadOwnershipProof(intentId, position.side); }
    catch (error) { ownershipReason = publicOwnershipFailure(error); }
  } else ownershipReason = 'No position with original entry evidence.';
  return { observedAt: Date.now(), source: 'Current protection projection and original fill ledger',
    protection: projections[0] ? redactedProof(projections[0]) : null, ownership, ownershipReason, position, operations };
}

export async function uiAccountDetail(id: string) {
  uiObjectId(id);
  const database = getDatabase();
  const account = await database.get(`SELECT id, name, exchange, mode, status, enabled, max_concurrent_positions AS maxConcurrentPositions,
    kill_switch_active AS killSwitchActive, kill_switch_reason AS killSwitchReason, credential_generation AS credentialGeneration,
    external_account_id AS externalAccountId, state_version AS stateVersion, last_verified_at AS lastVerifiedAt, last_error AS reason, created_at AS createdAt, updated_at AS updatedAt
    FROM trading_accounts WHERE id = ?`, [id]);
  if (!account) return null;
  const identityHash = account.externalAccountId ? createHash('sha256').update(account.externalAccountId).digest('hex').slice(0, 16) : null;
  delete account.externalAccountId;
  const [stream, reconciliation, capacity, paths, protection] = await Promise.all([
    database.get(`SELECT status, cursor, gap_count AS gapCount, last_event_at AS lastEventAt, last_poll_at AS lastPollAt, last_error AS reason, updated_at AS updatedAt FROM trading_exchange_stream_state WHERE account_id = ?`, [id]),
    database.get(`SELECT id, status, started_at AS startedAt, completed_at AS completedAt, last_error AS reason FROM trading_reconciliation_runs WHERE account_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`, [id]),
    database.get(`SELECT COUNT(*) AS openPositions FROM trading_positions WHERE account_id = ? AND status <> 'closed'`, [id]),
    database.all(`SELECT path.id, path.channel_id AS channelId, path.workflow_revision_id AS workflowRevisionId, path.enabled FROM workflow_execution_paths AS path JOIN workflow_revisions AS revision ON revision.id = path.workflow_revision_id WHERE path.account_id = ? AND revision.status = 'active' ORDER BY path.id LIMIT 101`, [id]),
    readProtectionProjection({ accountId: id }),
  ]);
  return { contractVersion: 1, observedAt: Date.now(), redacted: true,
    account: { ...account, enabled: account.enabled === 1, killSwitchActive: account.killSwitchActive === 1, identityFingerprint: identityHash, reason: account.reason ? maskPII(account.reason) : null },
    stream: stream ? { ...stream, reason: stream.reason ? maskPII(stream.reason) : null } : null,
    reconciliation: reconciliation ? { ...reconciliation, reason: reconciliation.reason ? maskPII(reconciliation.reason) : null } : null,
    capacity, paths: paths.slice(0, 100), protection: protection.slice(0, 100).map(redactedProof),
    hasMore: { paths: paths.length > 100, protection: protection.length > 100 } };
}
