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
function identityBinding(row: Record<string, unknown>): void {
  for (const key of ['accountFingerprint', 'credentialGeneration', 'evidenceHash']) {
    if (typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/.test(row[key] as string)) throw new Error('Invalid account-mode binding/hash.');
  }
}

function identityUid(row: Record<string, unknown>): void {
  for (const key of ['providerAccountUid', 'parentAccountUid']) {
    if (typeof row[key] !== 'string' || !/^(0|[1-9]\d{0,31})$/.test(row[key] as string)) throw new Error('Invalid authenticated account UID.');
  }
}

function identityRole(row: Record<string, unknown>): void {
  if (row.providerAccountUid === '0' || row.parentAccountUid === row.providerAccountUid
    || typeof row.isMaster !== 'boolean' || row.isMaster !== (row.parentAccountUid === '0')) throw new Error('Account UID role mismatch.');
}

function identity(row: Record<string, unknown>): void {
  identityBinding(row);
  identityUid(row);
  identityRole(row);
}

function observationFieldSet(row: Record<string, unknown>): void {
  if (Object.keys(row).length !== FIELDS.length || FIELDS.some(field => !(field in row))) throw new Error('Invalid account-mode profile/schema.');
}

function observationProfile(row: Record<string, unknown>): void {
  if (row.version !== 1 || row.profile !== 'bybit_uta_v1') throw new Error('Invalid account-mode profile/schema.');
}

function observationMargin(row: Record<string, unknown>): void {
  if (typeof row.unifiedMarginStatus !== 'number') throw new Error('Invalid account-mode profile/schema.');
  if (![1, 3, 4, 5, 6].includes(Number(row.unifiedMarginStatus))) throw new Error('Invalid account-mode profile/schema.');
}

function observationSchema(row: Record<string, unknown>): void {
  observationFieldSet(row);
  observationProfile(row);
  observationMargin(row);
}

function observationTimes(row: Record<string, unknown>): void {
  for (const key of ['accountUpdatedAt', 'startedAt', 'completedAt']) {
    if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) throw new Error('Invalid account-mode time.');
  }
}

function observationWindow(row: Record<string, unknown>): void {
  if (Number(row.startedAt) > Number(row.completedAt)
    || Number(row.completedAt) - Number(row.startedAt) > 30_000) throw new Error('Invalid account-mode interval/digest.');
}

function observationFreshness(row: Record<string, unknown>): void {
  if (Number(row.completedAt) > Date.now() + 1000
    || Number(row.accountUpdatedAt) > Number(row.completedAt) + 30_000) throw new Error('Invalid account-mode interval/digest.');
}

function observationDigest(row: Record<string, unknown>): void {
  if (accountModeDigest(row) !== row.evidenceHash) throw new Error('Invalid account-mode interval/digest.');
}

function observationInterval(row: Record<string, unknown>): void {
  observationWindow(row);
  observationFreshness(row);
  observationDigest(row);
}
export function validateAccountModeObservation(value: unknown): BybitAccountModeObservation {
  const row = object(value);
  observationSchema(row);
  identity(row);
  observationTimes(row);
  observationInterval(row);
  return structuredClone(row) as unknown as BybitAccountModeObservation;
}
function progressFieldCount(row: Record<string, unknown>): void {
  if (Object.keys(row).length !== 3) throw new Error('Invalid account-mode read progress.');
}

function progressCalls(row: Record<string, unknown>): void {
  if (!Number.isInteger(row.calls) || Number(row.calls) < 0 || Number(row.calls) > 2) throw new Error('Invalid account-mode read progress.');
}

function progressReason(row: Record<string, unknown>): void {
  if (![null, 'budget_exhausted', 'transient', 'unsupported'].includes(row.reason as AccountModeProgress['reason'])) throw new Error('Invalid account-mode read progress.');
}

function progressShape(row: Record<string, unknown>): void {
  progressFieldCount(row);
  progressCalls(row);
  progressReason(row);
}

function observedEvidence(row: Record<string, unknown>, observation: BybitAccountModeObservation, acquisition: { startedAt: number; completedAt: number }): void {
  if (row.calls !== 2 || row.reason !== null) throw new Error('Account-mode progress has no bound read evidence.');
  if (observation.startedAt < acquisition.startedAt) throw new Error('Account-mode progress has no bound read evidence.');
  if (observation.completedAt > acquisition.completedAt) throw new Error('Account-mode progress has no bound read evidence.');
}

function unobservedEvidence(row: Record<string, unknown>): void {
  if (row.reason === null) throw new Error('Account-mode progress has no bound read evidence.');
}

function progressEvidence(row: Record<string, unknown>, observation: BybitAccountModeObservation | null, acquisition: { startedAt: number; completedAt: number }): void {
  if (observation) observedEvidence(row, observation, acquisition);
  else unobservedEvidence(row);
}
export function validateAccountModeProgress(value: unknown, acquisition: { startedAt: number; completedAt: number }): AccountModeProgress {
  const row = object(value);
  progressShape(row);
  const observation = row.observation === null ? null : validateAccountModeObservation(row.observation);
  progressEvidence(row, observation, acquisition);
  return { calls: Number(row.calls), observation, reason: row.reason as AccountModeProgress['reason'] };
}

export function assertAccountModeResponse(requested: boolean | undefined, progress: AccountModeProgress | undefined,
  expected: { accountFingerprint: string | null; credentialGeneration: string | null }): void {
  if (Boolean(requested) !== Boolean(progress)) throw new Error('Account-mode response does not match its request.');
  const observation = progress?.observation;
  if (observation && (observation.accountFingerprint !== expected.accountFingerprint
    || observation.credentialGeneration !== expected.credentialGeneration)) throw new Error('Account-mode response binding changed.');
}
