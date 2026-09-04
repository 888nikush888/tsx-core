import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export type AccountLogRecord = Record<string, string | null>;
export interface AccountLogCheckpoint {
  version: 1; namespace: string; filterHash: string; accountFingerprint: string; credentialGeneration: string;
  revision: number; requiredSince: number; windowSince: number; windowUntil: number | null;
  cursor: string | null; scannedThrough: number | null; nextReadAt: number; lastServedAt: number;
  providerAccountUid: string | null; reason: string | null;
  audit?: AccountLogAudit;
}
export interface AccountLogAudit { windowSince: number; windowUntil: number | null; cursor: string | null; completedAt: number }
export interface AccountLogPageReceipt {
  version: 1; namespace: string; filterHash: string; accountFingerprint: string; credentialGeneration: string;
  since: number; until: number; cursor: string | null; nextCursor: string | null;
  startedAt: number; completedAt: number; providerResponseAt: number | null; providerAccountUid: string | null;
  exhausted: boolean; records: AccountLogRecord[];
  lane?: 'forward' | 'audit';
}
export interface AccountLogProgress {
  readSkipped?: 'budget_exhausted' | 'transient' | 'unsupported' | 'invalid_evidence';
  baseRevision: number; calls: number; checkpoint: AccountLogCheckpoint; receipts: AccountLogPageReceipt[];
}
export interface StoredAccountLogReceipt { id: string; sequence: number; accountId: string; receipt: AccountLogPageReceipt }
export interface FundingObservationProof {
  version: 1; status: 'observed' | 'incomplete'; namespace: string; accountFingerprint: string; credentialGeneration: string;
  since: number; through: number; revisionHash: string; reportingCurrency: string | null; amount: string | null;
  /** Exact/bounded monetary value; precision never substitutes for durable source authority. */
  value?: import('./trading_money_value.js').MoneyValue | null;
  sourceScope: 'source_account'; finality: 'provider_as_observed'; delivery: 'may_be_delayed'; reason: string | null;
}

const SPECS: Record<string, [string, object]> = {
  bybit: ['bybit_uta_transaction_log_scope_v1', { accountType: 'UNIFIED' }],
  hyperliquid: ['hyperliquid_user_funding_v1', { type: 'userFunding' }],
  krakenfutures: ['kraken_account_log_v3', { version: 'v3', sort: 'asc' }],
};
export const ACCOUNT_LOG_FIELDS: Record<string, string> = {
  bybit_uta_transaction_log_scope_v1: 'id transactionTime type subType transSubType category symbol side currency funding cashFlow change fee tradeId orderId orderLinkId qty size tradePrice feeRate bonusChange cashBalance',
  hyperliquid_user_funding_v1: 'hash time coin type usdc szi fundingRate nSamples',
  kraken_account_log_v3: 'id date asset collateral contract info booking_uid margin_account execution fee realized_funding realized_pnl old_balance new_balance funding_rate mark_price trade_price exchange_rate exchange_rate_from conversion_fee conversion_spread_percentage liquidation_fee',
};
export function accountLogDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function accountLogSource(exchange: string): { namespace: string; filterHash: string } | null {
  const spec = SPECS[exchange];
  return spec ? { namespace: spec[0], filterHash: accountLogDigest(spec[1]) } : null;
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid account-log object.');
  return value as Record<string, any>;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('Invalid account-log timestamp/revision.');
  return Number(value);
}
function token(value: unknown, nullable = false, maximum = 4096): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value || value.length > maximum || /[\x00-\x1f]/.test(value)) throw new Error('Invalid account-log token.');
  return value;
}
function binding(row: Record<string, any>) {
  const spec = Object.values(SPECS).find(([namespace]) => namespace === row.namespace);
  if (row.version !== 1 || !spec || row.filterHash !== accountLogDigest(spec[1])) throw new Error('Account-log source/filter is not allowlisted.');
  for (const field of ['accountFingerprint', 'credentialGeneration']) {
    if (typeof row[field] !== 'string' || !/^[a-f0-9]{64}$/.test(row[field])) throw new Error('Account-log binding is unverified.');
  }
  return { version: 1 as const, namespace: row.namespace as string, filterHash: row.filterHash as string,
    accountFingerprint: row.accountFingerprint as string, credentialGeneration: row.credentialGeneration as string };
}
export function validateAccountLogCheckpoint(value: unknown): AccountLogCheckpoint {
  const row = object(value);
  const result: AccountLogCheckpoint = { ...binding(row), revision: integer(row.revision), requiredSince: integer(row.requiredSince),
    windowSince: integer(row.windowSince), windowUntil: row.windowUntil === null ? null : integer(row.windowUntil),
    cursor: token(row.cursor, true), scannedThrough: row.scannedThrough === null ? null : integer(row.scannedThrough),
    nextReadAt: integer(row.nextReadAt), lastServedAt: integer(row.lastServedAt),
    providerAccountUid: token(row.providerAccountUid, true, 256), reason: token(row.reason, true, 80) };
  if (result.windowSince < result.requiredSince || (result.cursor !== null && result.windowUntil === null)) throw new Error('Account-log checkpoint lost its window.');
  if (result.windowUntil !== null) window(result.windowSince, result.windowUntil);
  if (result.windowSince > Date.now() + 1000 || (result.scannedThrough ?? 0) > Date.now() + 1000) throw new Error('Account-log checkpoint is in the future.');
  if (row.audit !== undefined) result.audit = validateAudit(row.audit, result.requiredSince);
  if (Buffer.byteLength(JSON.stringify(result)) >= 8192) throw new Error('Account-log checkpoint exceeds its storage budget.');
  return result;
}
function validateAudit(value: unknown, requiredSince: number): AccountLogAudit {
  const row = object(value);
  const result = { windowSince: integer(row.windowSince), windowUntil: row.windowUntil === null ? null : integer(row.windowUntil),
    cursor: token(row.cursor, true), completedAt: integer(row.completedAt) };
  if (result.windowSince < requiredSince || result.windowSince > Date.now() + 1000
    || (result.cursor !== null && result.windowUntil === null)) throw new Error('Historical audit lost its original obligation.');
  if (result.windowUntil !== null) window(result.windowSince, result.windowUntil);
  return result;
}
function window(since: number, until: number): void {
  if (until < since || until - since > 7 * 86400000 || until > Date.now() + 1000) throw new Error('Invalid pinned account-log window.');
}
function record(value: unknown, namespace: string): AccountLogRecord {
  const row = object(value);
  const allowed = ACCOUNT_LOG_FIELDS[namespace]!.split(' ');
  const result: AccountLogRecord = {};
  for (const [field, item] of Object.entries(row)) {
    if (!allowed.includes(field)) throw new Error('Unallowlisted account-log economic field.');
    if (item !== null && (typeof item !== 'string' || item.length > 256 || /[\x00-\x1f]/.test(item))) throw new Error('Invalid account-log economics.');
    result[field] = item as string | null;
  }
  return result;
}
export function validateAccountLogReceipt(value: unknown): AccountLogPageReceipt {
  const row = object(value);
  const bound = binding(row);
  if (typeof row.exhausted !== 'boolean' || !Array.isArray(row.records) || row.records.length > 5000) throw new Error('Invalid account-log collection/EOF.');
  const result: AccountLogPageReceipt = { ...bound, since: integer(row.since), until: integer(row.until),
    cursor: token(row.cursor, true), nextCursor: token(row.nextCursor, true), startedAt: integer(row.startedAt), completedAt: integer(row.completedAt),
    providerResponseAt: row.providerResponseAt === null ? null : integer(row.providerResponseAt),
    providerAccountUid: token(row.providerAccountUid, true, 256), exhausted: row.exhausted,
    records: row.records.map((item: unknown) => record(item, bound.namespace)) };
  window(result.since, result.until);
  if (row.lane !== undefined) {
    if (row.lane !== 'forward' && row.lane !== 'audit') throw new Error('Invalid account-log producer lane.');
    result.lane = row.lane;
  }
  if (result.completedAt < result.startedAt || result.until > result.completedAt + 1000
    || (result.exhausted && result.nextCursor !== null)) throw new Error('Invalid account-log source observation.');
  return result;
}
export function validateAccountLogProgress(value: unknown): AccountLogProgress {
  const row = object(value);
  const checkpoint = validateAccountLogCheckpoint(row.checkpoint);
  const baseRevision = integer(row.baseRevision), calls = integer(row.calls);
  if (row.readSkipped !== undefined) return skippedLogProgress(row, checkpoint, baseRevision, calls);
  if (checkpoint.revision !== baseRevision + 1 || calls > 5 || !Array.isArray(row.receipts) || row.receipts.length > calls) throw new Error('Invalid account-log progress revision/budget.');
  const receipts = row.receipts.map(validateAccountLogReceipt);
  if (receipts.some((item: AccountLogPageReceipt) => item.namespace !== checkpoint.namespace || item.filterHash !== checkpoint.filterHash
    || item.accountFingerprint !== checkpoint.accountFingerprint || item.credentialGeneration !== checkpoint.credentialGeneration)) throw new Error('Account-log progress changed its source binding.');
  return { baseRevision, calls, checkpoint, receipts };
}
function skippedLogProgress(row: Record<string, any>, checkpoint: AccountLogCheckpoint, baseRevision: number, calls: number): AccountLogProgress {
  if (!['budget_exhausted', 'transient', 'unsupported', 'invalid_evidence'].includes(row.readSkipped)
    || checkpoint.revision !== baseRevision || calls !== 0 || !Array.isArray(row.receipts) || row.receipts.length !== 0) {
    throw new Error('Invalid skipped account-log read.');
  }
  return { baseRevision, calls, checkpoint, receipts: [], readSkipped: row.readSkipped };
}
export function assertSkippedAccountLogUnchanged(previous: AccountLogCheckpoint, progress: AccountLogProgress): void {
  if (progress.readSkipped !== undefined && !isDeepStrictEqual(previous, progress.checkpoint)) {
    throw new Error('Skipped account-log read changed its original checkpoint.');
  }
}
export function accountLogAcquisitionFields(result: Record<string, any>): { accountLogs?: AccountLogProgress; targetedCalls?: number } {
  if (['accountLogs', 'accountMode', 'recoverySchedule', 'fxEvidence'].every(field => result[field] === undefined)) return {};
  const accountLogs = result.accountLogs === undefined ? undefined : validateAccountLogProgress(result.accountLogs);
  if (accountLogs?.readSkipped !== undefined && result.recoverySchedule === undefined) throw new Error('Skipped account-log reads require an explicit schedule.');
  const targetedCalls = integer(result.targetedCalls);
  assertSharedBudget(result, targetedCalls, accountLogs?.calls ?? 0);
  for (const receipt of accountLogs?.receipts ?? []) {
    if (receipt.startedAt < result.startedAt || receipt.completedAt > result.completedAt) throw new Error('Account-log receipt is outside acquisition.');
  }
  return { ...(accountLogs ? { accountLogs } : {}), targetedCalls };
}
function assertSharedBudget(result: Record<string, any>, targetedCalls: number, logCalls: number): void {
  const historyCalls = (result.history ?? []).reduce((sum: number, progress: { pages: number }) => sum + progress.pages, 0);
  const modeCalls = integer(result.accountMode?.calls ?? 0);
  const fxCalls = integer(result.fxEvidence?.calls ?? 0);
  if (!Number.isSafeInteger(historyCalls) || !Number.isSafeInteger(modeCalls)
    || targetedCalls + historyCalls + modeCalls + logCalls + fxCalls > 5) throw new Error('Shared history request exceeded five additional calls.');
}
export function assertAccountLogResponse(request: AccountLogCheckpoint | undefined, progress: AccountLogProgress | undefined): void {
  if (request === undefined && progress === undefined) return;
  if (!request || !progress || request.revision !== progress.baseRevision
    || request.namespace !== progress.checkpoint.namespace || request.filterHash !== progress.checkpoint.filterHash
    || request.accountFingerprint !== progress.checkpoint.accountFingerprint
    || request.credentialGeneration !== progress.checkpoint.credentialGeneration) throw new Error('Account-log response does not match the requested source revision.');
  assertSkippedAccountLogUnchanged(request, progress);
}
