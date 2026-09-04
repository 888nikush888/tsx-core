import type { Database } from 'sqlite';
import { promises as fs } from 'node:fs';

export const RESTORE_ELIGIBILITY_SCOPE = 'artifact-local-integrated-restore' as const;

/** Read at most the manifest limit plus one byte, including a concurrent growth case. */
export async function boundedBackupManifestBytes(destination: string): Promise<Buffer> {
  const maximum = 64 * 1024;
  const entry = await fs.lstat(destination);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Backup manifest must be a regular file, not a symbolic link.');
  if (entry.size > maximum) throw new Error('Backup manifest exceeds 64 KiB.');
  const handle = await fs.open(destination, 'r');
  try {
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('Backup manifest exceeds 64 KiB.');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

export interface RestoreEligibility {
  status: 'eligible' | 'blocked' | 'unknown';
  scope: typeof RESTORE_ELIGIBILITY_SCOPE;
  checkedAt: number;
  reasons: string[];
}

export interface BackupProof {
  verifiedAt: number;
  artifactSha256: string;
  artifactCreatedAt: string;
}

export interface BackupOffsiteProof extends BackupProof {
  objectName: string;
  encryptedObjectSha256: string;
}

export interface BackupRestoreDrillProof {
  performedAt: number;
  artifactSha256: string;
  artifactCreatedAt: string;
  isolation: 'temporary-child-network-apis-disabled';
  osSandbox: false;
  runtimeDisabled: true;
}

/** Later receipts never rewrite the immutable artifact or its SHA identity. */
export interface BackupCreationEvidence {
  version: 1;
  integrityVerified: { verifiedAt: number };
  configurationCoherent: { verifiedAt: number } | null;
  offsiteVerified: null;
  restoreEligibility: RestoreEligibility;
  restoreDrill: null;
}

export interface BackupVerificationEvidence {
  artifactSha256: string;
  artifactCreatedAt: string;
  integrityVerified: BackupProof;
  configurationCoherent: BackupProof | null;
  configurationCoherenceReason: string | null;
  offsiteVerified: BackupOffsiteProof | null;
  restoreEligibility: RestoreEligibility & { artifactSha256: string };
  restoreDrill: BackupRestoreDrillProof | null;
}

const OBLIGATIONS = [
  ['intents', "SELECT COUNT(*) AS count FROM trading_trade_intents WHERE status IS NULL OR status NOT IN ('completed', 'blocked', 'failed')"],
  ['positions', "SELECT COUNT(*) AS count FROM trading_positions WHERE status IS NULL OR status <> 'closed' OR quantity IS NULL OR quantity <> '0'"],
  ['orders', "SELECT COUNT(*) AS count FROM trading_orders WHERE status IS NULL OR status NOT IN ('filled', 'cancelled', 'rejected')"],
  ['operations', "SELECT COUNT(*) AS count FROM trading_operations WHERE phase IS NULL OR phase NOT IN ('resolved', 'abandoned')"],
  ['remote-evidence', "SELECT COUNT(*) AS count FROM trading_remote_evidence WHERE classification IS NULL OR classification NOT IN ('managed', 'external')"],
] as const;

/** This is a local artifact gate, never evidence of the current exchange state. */
export async function assessRestoreEligibility(database: Database, now = Date.now()): Promise<RestoreEligibility> {
  const blocked: string[] = [];
  const unknown: string[] = [];
  for (const [source, query] of OBLIGATIONS) {
    try {
      const result = await database.get<{ count: number }>(query);
      if (!result || !Number.isSafeInteger(result.count) || result.count < 0) unknown.push(`${source}: count is unavailable or invalid`);
      else if (result.count > 0) blocked.push(`${source}: ${result.count} unresolved local obligation(s)`);
    } catch { unknown.push(`${source}: required source could not be read`); }
  }
  return {
    status: blocked.length ? 'blocked' : unknown.length ? 'unknown' : 'eligible',
    scope: RESTORE_ELIGIBILITY_SCOPE,
    checkedAt: now,
    reasons: [...blocked, ...unknown],
  };
}

export function requireRestoreEligibility(eligibility: RestoreEligibility): void {
  if (eligibility.status !== 'eligible') {
    throw new Error(`Restore refused because the backup captures unresolved trading exposure or incomplete evidence `
      + `(${eligibility.status}: ${eligibility.reasons.join('; ')}).`);
  }
}

function timestamp(candidate: number): boolean { return Number.isSafeInteger(candidate) && candidate > 0; }

function validEligibility(eligibility: RestoreEligibility): boolean {
  return ['eligible', 'blocked', 'unknown'].includes(eligibility?.status)
    && eligibility.scope === RESTORE_ELIGIBILITY_SCOPE && timestamp(eligibility.checkedAt)
    && Array.isArray(eligibility.reasons) && eligibility.reasons.length <= 10
    && eligibility.reasons.every(reason => typeof reason === 'string' && reason.length > 0 && reason.length <= 240);
}

export function validateBackupCreationEvidence(value: BackupCreationEvidence): void {
  if (value?.version !== 1 || !timestamp(value.integrityVerified?.verifiedAt)
    || (value.configurationCoherent !== null && !timestamp(value.configurationCoherent?.verifiedAt))
    || value.offsiteVerified !== null || value.restoreDrill !== null
    || !validEligibility(value.restoreEligibility)) {
    throw new Error('Backup creation evidence is malformed or claims an unperformed off-site verification/drill.');
  }
}

/** Backup prerequisite only: roles, confirmation, current target safety and lease remain mandatory. */
export function hasCurrentRestorableBackup(backup: any, now = Date.now()): boolean {
  if (backup?.healthy !== true) return false;
  const sha = backup.integrityVerified?.artifactSha256;
  if (!/^[a-f0-9]{64}$/.test(sha || '')) return false;
  const fresh = (at: number) => timestamp(at) && at <= now && now - at <= 30 * 60_000;
  if (!fresh(Date.parse(backup.integrityVerified.artifactCreatedAt))) return false;
  const proofs = [backup.integrityVerified, backup.configurationCoherent];
  const eligibility = backup.restoreEligibility;
  return proofs.every(proof => proof?.artifactSha256 === sha && fresh(proof.verifiedAt)
      && proof.artifactCreatedAt === backup.integrityVerified.artifactCreatedAt)
    && eligibility?.status === 'eligible' && eligibility.scope === RESTORE_ELIGIBILITY_SCOPE
    && eligibility.artifactSha256 === sha && fresh(eligibility.checkedAt)
    && Array.isArray(eligibility.reasons) && eligibility.reasons.length === 0;
}
