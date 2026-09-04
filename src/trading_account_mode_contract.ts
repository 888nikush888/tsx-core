import { createHash } from 'node:crypto';

export interface BybitAccountModeObservation {
  version: 1; profile: 'bybit_uta_v1'; accountFingerprint: string; credentialGeneration: string;
  providerAccountUid: string; parentAccountUid: string; isMaster: boolean;
  unifiedMarginStatus: 1 | 3 | 4 | 5 | 6; accountUpdatedAt: number;
  startedAt: number; completedAt: number; evidenceHash: string;
}
export interface AccountModeProgress {
  calls: number; observation: BybitAccountModeObservation | null;
  reason: null | 'budget_exhausted' | 'transient' | 'unsupported';
}
const FIELDS = ['version', 'profile', 'accountFingerprint', 'credentialGeneration', 'providerAccountUid', 'parentAccountUid',
  'isMaster', 'unifiedMarginStatus', 'accountUpdatedAt', 'startedAt', 'completedAt', 'evidenceHash'];

export function accountModeDigest(value: object): string {
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'evidenceHash').sort(([a], [b]) => a < b ? -1 : Number(a > b))))).digest('hex');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid account-mode observation.');
  return value as Record<string, unknown>;
}
function identity(row: Record<string, unknown>): void {
  for (const key of ['accountFingerprint', 'credentialGeneration', 'evidenceHash']) {
    if (typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/.test(row[key])) throw new Error('Invalid account-mode binding/hash.');
  }
  for (const key of ['providerAccountUid', 'parentAccountUid']) {
    if (typeof row[key] !== 'string' || !/^(0|[1-9][0-9]{0,31})$/.test(row[key])) throw new Error('Invalid authenticated account UID.');
  }
  if (row.providerAccountUid === '0' || row.parentAccountUid === row.providerAccountUid
    || typeof row.isMaster !== 'boolean' || row.isMaster !== (row.parentAccountUid === '0')) throw new Error('Account UID role mismatch.');
}
export function validateAccountModeObservation(value: unknown): BybitAccountModeObservation {
  const row = object(value);
  if (Object.keys(row).length !== FIELDS.length || FIELDS.some(field => !(field in row))
    || row.version !== 1 || row.profile !== 'bybit_uta_v1' || ![1, 3, 4, 5, 6].includes(Number(row.unifiedMarginStatus))
    || typeof row.unifiedMarginStatus !== 'number') throw new Error('Invalid account-mode profile/schema.');
  identity(row);
  for (const key of ['accountUpdatedAt', 'startedAt', 'completedAt']) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) throw new Error('Invalid account-mode time.');
  }
  if (Number(row.startedAt) > Number(row.completedAt) || Number(row.completedAt) - Number(row.startedAt) > 30_000
    || Number(row.completedAt) > Date.now() + 1000 || Number(row.accountUpdatedAt) > Number(row.completedAt) + 30_000
    || accountModeDigest(row) !== row.evidenceHash) throw new Error('Invalid account-mode interval/digest.');
  return structuredClone(row) as unknown as BybitAccountModeObservation;
}
export function validateAccountModeProgress(value: unknown, acquisition: { startedAt: number; completedAt: number }): AccountModeProgress {
  const row = object(value);
  if (Object.keys(row).length !== 3 || !Number.isInteger(row.calls) || Number(row.calls) < 0 || Number(row.calls) > 2
    || ![null, 'budget_exhausted', 'transient', 'unsupported'].includes(row.reason as AccountModeProgress['reason'])) throw new Error('Invalid account-mode read progress.');
  const observation = row.observation === null ? null : validateAccountModeObservation(row.observation);
  if (observation ? row.calls !== 2 || row.reason !== null || observation.startedAt < acquisition.startedAt
    || observation.completedAt > acquisition.completedAt : row.reason === null) throw new Error('Account-mode progress has no bound read evidence.');
  return { calls: Number(row.calls), observation, reason: row.reason as AccountModeProgress['reason'] };
}

export function assertAccountModeResponse(requested: boolean | undefined, progress: AccountModeProgress | undefined,
  expected: { accountFingerprint: string | null; credentialGeneration: string | null }): void {
  if (Boolean(requested) !== Boolean(progress)) throw new Error('Account-mode response does not match its request.');
  const observation = progress?.observation;
  if (observation && (observation.accountFingerprint !== expected.accountFingerprint
    || observation.credentialGeneration !== expected.credentialGeneration)) throw new Error('Account-mode response binding changed.');
}
