import { assertCandidateNeverSent } from './trading_entry_candidate.js';
import { getTradingAccount, getTradingRuntimeState } from './trading_repository.js';
import { TradingRiskError } from './trading_risk.js';
import { collectAccountReleaseEvidence, type ReleaseEvidenceRequest } from './trading_safety_repository.js';
import { evaluateTradingSafety, type TradingSafetyProof } from './trading_safety_proof.js';
import type { TradingPlan } from './trading_types.js';
import type { TradingDispatchWitness } from './trading_recovery.js';

export type EntrySafetyObservation = Omit<ReleaseEvidenceRequest, 'current' | 'runtimeCurrent'>;

/** Account-wide admission. Exempting the current never-sent candidate must not narrow proof of other trades. */
export async function proveEntrySafety(
  observation: EntrySafetyObservation, intentId: string, plan: TradingPlan | null, witness?: TradingDispatchWitness,
): Promise<TradingSafetyProof> {
  const current = await getTradingAccount(observation.reconciled.account.id);
  if (!current) throw new TradingRiskError('ENTRY_SAFETY_UNPROVEN', 'ACCOUNT_MISSING');
  const candidateExemption = await assertCandidateNeverSent(current, intentId, plan, witness);
  const evidence = await collectAccountReleaseEvidence({ ...observation, current });
  evidence.identityVerified = evidence.identityVerified && current.credentialRef === observation.verificationAccount.credentialRef
    && current.capabilities?.executionProfileHash === observation.verificationAccount.capabilities?.executionProfileHash;
  const runtime = await getTradingRuntimeState();
  evidence.entryAllowed = runtime.executionEnabled && !runtime.killSwitchActive && !current.killSwitchActive
    && (current.mode !== 'live' || runtime.liveTradingEnabled);
  evidence.orders = evidence.orders.filter(order => order.intentId !== intentId);
  evidence.positions = evidence.positions.filter(position => position.need.intentId !== intentId);
  evidence.operations = evidence.operations.filter(operation => operation.intentId !== intentId);
  evidence.reviewRequiredIntents = evidence.reviewRequiredIntents.filter(id => id !== intentId);
  evidence.historicalTrades = evidence.historicalTrades?.filter(trade => trade.intentId !== intentId);
  // A never-opened candidate is not ownership of a same-symbol remote position.
  evidence.foreignPositions = observation.reconciled.remote.positions.filter(remote =>
    !evidence.positions.some(position => position.need.symbol === remote.symbol && position.remoteMatches)).length;
  evidence.candidateExemption = candidateExemption;
  const proof = evaluateTradingSafety(evidence, 'entryAdmission');
  if (!proof.safe) throw new TradingRiskError('ENTRY_SAFETY_UNPROVEN', `Entry safety rejected: ${proof.reasons.map(reason => reason.code).join(', ')}`);
  return proof;
}

/** Repeated synchronously immediately before send, after the final DB read fence. */
export function assertEntrySafetyFresh(proof: TradingSafetyProof): void {
  const now = Date.now();
  if (!proof.safe || proof.purpose !== 'entryAdmission' || proof.acquisitionStartedAt === null
    || proof.acquisitionCompletedAt === null || proof.evaluatedAt > now || proof.acquisitionCompletedAt > now
    || now - proof.acquisitionStartedAt > 30_000) {
    throw new TradingRiskError('ENTRY_SAFETY_UNPROVEN', 'ACQUISITION_NOT_FRESH: admission evidence expired before dispatch.');
  }
}
