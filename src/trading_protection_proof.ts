import { getTradingAccount, getTradingIntent } from './trading_repository.js';
import { assertCandidateNeverSent } from './trading_entry_candidate.js';
import { collectAccountSafetyEvidence, type ReconciledAccountEvidence } from './trading_safety_repository.js';
import { evaluateTradingSafety } from './trading_safety_proof.js';
import { assertProtectionObservationFresh, type ProtectionReceipt } from './trading_protection_projection.js';
import { protectionSourceDigest, protectionScopes } from './trading_protection_sources.js';
import type { ProtectionObservation } from './trading_protection_observation.js';
import type { TradingPlan } from './trading_types.js';

export class ProtectionProofRejectedError extends Error {
  readonly code = 'POSITION_PROTECTION_UNPROVED';
  constructor(readonly receipt: ProtectionReceipt) {
    super(`Position protection rejected: ${receipt.proofs.flatMap(proof => proof.reasons.map(reason => reason.code)).join(', ')}`);
    this.name = 'ProtectionProofRejectedError';
  }
}

/** Called only after independent risk-reducing actions and a stable fresh observation, inside the commit transaction. */
export async function collectProtectionReceipt(
  reconciled: ReconciledAccountEvidence, observation: ProtectionObservation,
): Promise<ProtectionReceipt> {
  assertProtectionObservationFresh(observation);
  const current = await getTradingAccount(reconciled.account.id);
  if (!current) throw new Error('PROTECTION_ACCOUNT_MISSING');
  const evidence = await collectAccountSafetyEvidence({ current, reconciled, epoch: observation.epoch,
    requestedAt: observation.requestedAt, runtimeCurrent: true });
  const receipt: ProtectionReceipt = { version: 1, observation, sourceDigest: '', proofs: [], noDuty: [], commit: null };
  for (const { intentId } of await protectionScopes(current.id)) {
    const intent = await getTradingIntent(intentId);
    try {
      // This shared durable proof rejects ACK-bearing preparations and every old/in-flight dispatch. No witness here.
      receipt.noDuty.push(await assertCandidateNeverSent(current, intentId, (intent?.plan as TradingPlan | null) ?? null));
    } catch {
      receipt.proofs.push(evaluateTradingSafety(evidence, 'positionProtected', intentId));
    }
  }
  receipt.sourceDigest = await protectionSourceDigest(current.id);
  if (receipt.proofs.some(proof => !proof.safe)) throw new ProtectionProofRejectedError(receipt);
  return receipt;
}
