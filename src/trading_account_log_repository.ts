import { getDatabase, withDatabaseTransaction } from './db.js';
import { accountLogDigest, accountLogSource, assertSkippedAccountLogUnchanged, validateAccountLogCheckpoint, validateAccountLogProgress,
  type AccountLogCheckpoint, type AccountLogPageReceipt, type AccountLogProgress, type StoredAccountLogReceipt } from './trading_account_log_contract.js';
import type { TradingAccount } from './trading_types.js';

async function assertBinding(account: TradingAccount, checkpoint: Pick<AccountLogCheckpoint, 'accountFingerprint' | 'credentialGeneration'>): Promise<void> {
  const current = await getDatabase().get<{ external_account_id: string; credential_generation: string }>(
    'SELECT external_account_id, credential_generation FROM trading_accounts WHERE id = ?', [account.id]);
  if (!current || checkpoint.accountFingerprint !== current.external_account_id || checkpoint.credentialGeneration !== current.credential_generation
    || checkpoint.accountFingerprint !== account.externalAccountId || checkpoint.credentialGeneration !== account.credentialGeneration) {
    throw new Error('Account-log identity/credential binding changed.');
  }
}
async function requiredSince(accountId: string, today: number): Promise<number> {
  const row = await getDatabase().get<{ since: number | null }>(
    'SELECT MIN(created_at) AS since FROM trading_trade_intents WHERE account_id = ?', [accountId]);
  return Math.min(today, row?.since ?? today);
}
export async function storedAccountLogCheckpoint(account: TradingAccount): Promise<AccountLogCheckpoint | null> {
  const source = accountLogSource(account.exchange);
  if (!source) return null;
  const row = await getDatabase().get<{ payload_json: string }>(`SELECT payload_json FROM trading_account_log_checkpoints
    WHERE account_id=? AND account_fingerprint=? AND namespace=?`, [account.id, account.externalAccountId, source.namespace]);
  if (!row) return null;
  const checkpoint = validateAccountLogCheckpoint(JSON.parse(row.payload_json));
  await assertBinding(account, checkpoint);
  return checkpoint;
}
export async function accountLogCheckpoint(account: TradingAccount): Promise<AccountLogCheckpoint | null> {
  const source = accountLogSource(account.exchange);
  if (!source || !account.externalAccountId || !account.credentialGeneration) return null;
  return withDatabaseTransaction(async () => {
    const now = Date.now(), today = new Date(now).setUTCHours(0, 0, 0, 0);
    const since = await requiredSince(account.id, today);
    const row = await getDatabase().get<{ payload_json: string }>(`SELECT payload_json FROM trading_account_log_checkpoints
      WHERE account_id = ? AND account_fingerprint = ? AND namespace = ?`, [account.id, account.externalAccountId, source.namespace]);
    const initial: AccountLogCheckpoint = { version: 1, ...source, accountFingerprint: account.externalAccountId!, credentialGeneration: account.credentialGeneration!,
      revision: 0, requiredSince: since, windowSince: since, windowUntil: null, cursor: null, scannedThrough: null,
      nextReadAt: 0, lastServedAt: 0, providerAccountUid: null, reason: null };
    const previous = row ? validateAccountLogCheckpoint(JSON.parse(row.payload_json)) : null;
    await assertBinding(account, initial);
    if (previous && previous.requiredSince <= since && previous.credentialGeneration === account.credentialGeneration) return previous;
    const checkpoint = previous ? { ...initial, requiredSince: Math.min(since, previous.requiredSince),
      windowSince: Math.min(since, previous.requiredSince), revision: previous.revision + 1 } : initial;
    await getDatabase().run(`INSERT INTO trading_account_log_checkpoints
      (account_id, account_fingerprint, namespace, revision, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, account_fingerprint, namespace) DO UPDATE SET revision=excluded.revision,
        payload_json=excluded.payload_json, updated_at=excluded.updated_at`,
    [account.id, account.externalAccountId, source.namespace, checkpoint.revision, JSON.stringify(checkpoint), now]);
    return checkpoint;
  });
}

function assertContinuation(previous: AccountLogCheckpoint, progress: AccountLogProgress): void {
  const next = progress.checkpoint;
  if (previous.revision !== progress.baseRevision) throw new Error('Account-log revision is stale.');
  assertSkippedAccountLogUnchanged(previous, progress);
  if (next.requiredSince !== previous.requiredSince || next.namespace !== previous.namespace || next.filterHash !== previous.filterHash
    || (next.scannedThrough ?? 0) < (previous.scannedThrough ?? 0)) throw new Error('Account-log continuation changed its original source.');
  assertReceiptChain(previous, progress);
}
function assertReceiptChain(previous: AccountLogCheckpoint, progress: AccountLogProgress): void {
  const next = progress.checkpoint;
  if (progress.receipts.length === 0) {
    assertUnchanged(previous, next, ['cursor', 'windowSince', 'windowUntil', 'scannedThrough', 'audit', 'providerAccountUid']);
    return;
  }
  if (progress.receipts.length !== 1) throw new Error('Account-log producer returned more than one page per turn.');
  const receipt = progress.receipts[0]!;
  const audit = receipt.lane === 'audit';
  const current = audit ? previous.audit ?? { windowSince: previous.requiredSince, windowUntil: null, cursor: null, completedAt: 0 } : previous;
  if (receipt.cursor !== current.cursor || receipt.since !== current.windowSince
    || (current.windowUntil !== null && receipt.until !== current.windowUntil)) throw new Error('Account-log receipt lost its pinned request.');
  if (previous.providerAccountUid !== null && receipt.providerAccountUid !== previous.providerAccountUid) throw new Error('Account-log provider UID changed.');
  if (next.providerAccountUid !== receipt.providerAccountUid) throw new Error('Account-log provider UID differs from its source.');
  if (audit) assertAuditContinuation(previous, next, receipt);
  else assertForwardContinuation(previous, next, receipt);
}
function assertUnchanged(previous: AccountLogCheckpoint, next: AccountLogCheckpoint, fields: Array<keyof AccountLogCheckpoint>): void {
  if (fields.some(field => JSON.stringify(next[field]) !== JSON.stringify(previous[field]))) throw new Error('Account-log progress skipped an unread page.');
}
function assertForwardContinuation(previous: AccountLogCheckpoint, next: AccountLogCheckpoint, receipt: AccountLogPageReceipt): void {
  const day = 86400000;
  const since = receipt.exhausted ? Math.max(previous.requiredSince,
    receipt.until >= receipt.completedAt - 1000 ? Math.floor(receipt.until / day) * day - day : receipt.until - 1000) : receipt.since;
  const through = receipt.exhausted ? Math.max(previous.scannedThrough ?? 0, receipt.until) : previous.scannedThrough;
  if (next.windowSince !== since || next.windowUntil !== (receipt.exhausted ? null : receipt.until)
    || next.cursor !== receipt.nextCursor || next.scannedThrough !== through) throw new Error('Account-log traversal advanced without its durable page/EOF.');
  assertUnchanged(previous, next, ['audit']);
}
function assertAuditContinuation(previous: AccountLogCheckpoint, next: AccountLogCheckpoint, receipt: AccountLogPageReceipt): void {
  const today = Math.floor(receipt.completedAt / 86400000) * 86400000;
  if (previous.revision % 2 !== 1 || previous.requiredSince >= today || (previous.scannedThrough ?? 0) < today) throw new Error('Historical audit was not eligible.');
  const since = receipt.exhausted ? (receipt.until >= today ? previous.requiredSince : Math.max(previous.requiredSince, receipt.until - 1000)) : receipt.since;
  const expected = { windowSince: since, windowUntil: receipt.exhausted ? null : receipt.until,
    cursor: receipt.nextCursor, completedAt: receipt.exhausted ? receipt.completedAt : previous.audit?.completedAt ?? 0 };
  if (JSON.stringify(next.audit) !== JSON.stringify(expected)) throw new Error('Historical audit lost its durable page/EOF.');
  assertUnchanged(previous, next, ['cursor', 'windowSince', 'windowUntil', 'scannedThrough']);
}

async function insertReceipt(account: TradingAccount, receipt: AccountLogPageReceipt, revision: number): Promise<void> {
  const id = accountLogDigest([account.id, revision, receipt]);
  const database = getDatabase();
  await database.run(`INSERT INTO trading_account_log_receipts
    (id,account_id,account_fingerprint,credential_generation,namespace,base_revision,payload_json,recorded_at)
    VALUES (?,?,?,?,?,?,?,?)`, [id, account.id, receipt.accountFingerprint, receipt.credentialGeneration,
    receipt.namespace, revision, JSON.stringify(receipt), Date.now()]);
  for (const [ordinal, record] of receipt.records.entries()) await database.run(
    'INSERT INTO trading_account_log_records (receipt_id,ordinal,payload_json) VALUES (?,?,?)', [id, ordinal, JSON.stringify(record)]);
  for (const consumer of receipt.namespace.startsWith('bybit_') ? ['money', 'scope'] : ['money']) await database.run(
    "INSERT INTO trading_account_log_consumers (receipt_id,consumer,status,updated_at) VALUES (?,?,'pending',?)", [id, consumer, Date.now()]);
}

/** Durable raw occurrences and independent consumer work precede producer cursor advancement. */
export async function persistAccountLogProgress(account: TradingAccount, value: AccountLogProgress): Promise<void> {
  const progress = validateAccountLogProgress(value);
  await withDatabaseTransaction(async () => {
    const next = progress.checkpoint;
    await assertBinding(account, next);
    const row = await getDatabase().get<{ payload_json: string }>(`SELECT payload_json FROM trading_account_log_checkpoints
      WHERE account_id=? AND account_fingerprint=? AND namespace=?`, [account.id, next.accountFingerprint, next.namespace]);
    if (!row) throw new Error('Account-log requested checkpoint is missing.');
    assertContinuation(validateAccountLogCheckpoint(JSON.parse(row.payload_json)), progress);
    if (progress.readSkipped !== undefined) return;
    for (const receipt of progress.receipts) await insertReceipt(account, receipt, progress.baseRevision);
    const updated = await getDatabase().run(`UPDATE trading_account_log_checkpoints SET revision=?,payload_json=?,updated_at=?
      WHERE account_id=? AND account_fingerprint=? AND namespace=? AND revision=?`,
    [next.revision, JSON.stringify(next), Date.now(), account.id, next.accountFingerprint, next.namespace, progress.baseRevision]);
    if (updated.changes !== 1) throw new Error('Account-log checkpoint revision changed.');
  });
}

export async function pendingAccountLogReceipts(accountId: string, consumer: string, limit = 100): Promise<StoredAccountLogReceipt[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Account-log consumer batch exceeds its bound.');
  const rows = await getDatabase().all<Array<{ id: string; sequence: number; account_id: string; payload_json: string }>>(`
    SELECT receipt.id,receipt.sequence,receipt.account_id,receipt.payload_json FROM trading_account_log_receipts receipt
      JOIN trading_account_log_consumers work ON work.receipt_id=receipt.id
    WHERE receipt.account_id=? AND work.consumer=? AND work.status <> 'complete'
    ORDER BY work.updated_at,receipt.sequence LIMIT ?`, [accountId, consumer, limit]);
  return rows.map(row => ({ id: row.id, sequence: row.sequence, accountId: row.account_id, receipt: JSON.parse(row.payload_json) }));
}
export async function setAccountLogConsumerResult(receiptId: string, consumer: string, status: 'complete' | 'unresolved', result: object): Promise<void> {
  const payload = JSON.stringify(result);
  if (Buffer.byteLength(payload) > 32768) throw new Error('Account-log consumer result exceeds its evidence budget.');
  await getDatabase().run(`UPDATE trading_account_log_consumers SET status=?,result_json=?,updated_at=?
    WHERE receipt_id=? AND consumer=?`, [status, payload, Date.now(), receiptId, consumer]);
}
