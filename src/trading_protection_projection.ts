import { getDatabase, withDatabaseTransaction } from './db.js';
import { assertProtectionObservationCurrent, protectionObservationCurrent, retireProtectionReceipt, type ProtectionObservation } from './trading_protection_observation.js';
import { protectionAccountSource, protectionScopes, protectionSourceDigest } from './trading_protection_sources.js';
import type { CandidateExemption, TradingSafetyProof } from './trading_safety_proof.js';

export interface ProtectionReceipt {
  version: 1; observation: ProtectionObservation; sourceDigest: string;
  proofs: TradingSafetyProof[]; noDuty: CandidateExemption[];
  commit: { accountVersion: number; at: number } | null;
}
export interface ProtectionProjection {
  accountId: string; intentId: string; protected: boolean; reason: string | null;
  proof: TradingSafetyProof | null; noDuty: CandidateExemption | null;
}

export function assertProtectionObservationFresh(observation: ProtectionObservation): void {
  const now = Date.now();
  assertProtectionObservationCurrent(observation);
  if (observation.requestedAt > now || now - observation.requestedAt > 30_000) throw new Error('ACQUISITION_NOT_FRESH');
}

async function currentReceipt(accountId: string): Promise<ProtectionReceipt | null> {
  const receipt = await validatedReceipt(accountId);
  if (!receipt) retireProtectionReceipt(accountId);
  return receipt;
}

async function validatedReceipt(accountId: string): Promise<ProtectionReceipt | null> {
  const row = await getDatabase().get<{ status: string; local_snapshot_json: string | null }>(
    `SELECT status, local_snapshot_json FROM trading_reconciliation_runs WHERE account_id = ?
     ORDER BY completed_at DESC, started_at DESC, rowid DESC LIMIT 1`, [accountId]);
  if (row?.status !== 'succeeded' || !row.local_snapshot_json) return null;
  try {
    const receipt = JSON.parse(row.local_snapshot_json) as ProtectionReceipt;
    if (receipt.version !== 1 || receipt.observation.accountId !== accountId || !receipt.commit
      || !protectionObservationCurrent(receipt.observation, row.local_snapshot_json)) return null;
    assertProtectionObservationFresh(receipt.observation);
    const account = await protectionAccountSource(accountId);
    if (account.version !== receipt.commit.accountVersion || account.version !== receipt.observation.accountVersion + 1
      || receipt.sourceDigest !== await protectionSourceDigest(accountId)) return null;
    // An epoch can change synchronously while asynchronous DB reads are in progress.
    assertProtectionObservationFresh(receipt.observation);
    return receipt;
  } catch { return null; }
}

/** The same original verdict used by reconciliation, with invalidation only; never a second stop predicate. */
export async function readProtectionProjection(): Promise<ProtectionProjection[]> {
  return withDatabaseTransaction(async () => {
    const scopes = await projectionScopes();
    const accounts = new Map<string, ProtectionReceipt | null>();
    for (const scope of scopes) {
      if (!accounts.has(scope.accountId)) accounts.set(scope.accountId, await currentReceipt(scope.accountId));
    }
    // Account A may be fenced while an asynchronous source read for account B completes.
    for (const [accountId, receipt] of accounts) {
      if (!receipt) continue;
      try { assertProtectionObservationFresh(receipt.observation); }
      catch { accounts.set(accountId, null); retireProtectionReceipt(accountId); }
    }
    return scopes.map(scope => projectScope(scope, accounts.get(scope.accountId) ?? null));
  });
}

async function projectionScopes(): Promise<Array<{ accountId: string; intentId: string }>> {
  const scopes = await protectionScopes();
  const rows = await getDatabase().all<Array<{ account_id: string; local_snapshot_json: string }>>(
    `SELECT account_id, local_snapshot_json FROM trading_reconciliation_runs WHERE local_snapshot_json IS NOT NULL
     ORDER BY completed_at DESC, started_at DESC, rowid DESC`);
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.account_id)) continue;
    try {
      const receipt = JSON.parse(row.local_snapshot_json) as ProtectionReceipt;
      if (receipt.version !== 1 || !Array.isArray(receipt.proofs) || !Array.isArray(receipt.noDuty)) continue;
      seen.add(row.account_id);
      for (const item of [...receipt.proofs, ...receipt.noDuty]) {
        if (typeof item.intentId === 'string') scopes.push({ accountId: row.account_id, intentId: item.intentId });
      }
    } catch { /* A malformed new row cannot erase older known obligations. */ }
  }
  return [...new Map(scopes.map(scope => [JSON.stringify(scope), scope])).values()];
}

function projectScope(scope: { accountId: string; intentId: string }, receipt: ProtectionReceipt | null): ProtectionProjection {
  const proof = receipt?.proofs.find(item => item.intentId === scope.intentId) ?? null;
  const noDuty = receipt?.noDuty.find(item => item.intentId === scope.intentId) ?? null;
  const protectedPosition = proof?.safe === true || noDuty !== null;
  return { ...scope, protected: protectedPosition,
    reason: receipt ? proof?.reasons[0]?.code ?? (protectedPosition ? null : 'PROTECTION_SCOPE_UNPROVED') : 'PROTECTION_RECEIPT_NOT_CURRENT',
    proof, noDuty };
}

export async function countUnprovedProtection(): Promise<number> {
  return (await readProtectionProjection()).filter(row => !row.protected).length;
}
