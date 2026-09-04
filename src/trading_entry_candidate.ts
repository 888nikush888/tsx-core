import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDatabase } from './db.js';
import { originalPlanJournalMatches, type OriginalPlanOperation } from './trading_plan_identity.js';
import { currentDispatchIdentity, hasUndispatchedPlanProof, type TradingDispatchWitness } from './trading_recovery.js';
import { getTradingIntent } from './trading_repository.js';
import { TradingRiskError } from './trading_risk.js';
import type { TradingAccount, TradingPlan } from './trading_types.js';
import type { CandidateExemption } from './trading_safety_proof.js';

type CandidateOperation = OriginalPlanOperation;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function reject(): never {
  throw new TradingRiskError('ENTRY_SAFETY_UNPROVEN', 'CANDIDATE_NO_DISPATCH_UNPROVED: the entry preparation is not demonstrably unsent.');
}

async function hasNoCandidateState(intentId: string): Promise<boolean> {
  const row = await getDatabase().get<{ count: number }>(
    `SELECT (SELECT COUNT(*) FROM trading_orders WHERE intent_id = ?) +
       (SELECT COUNT(*) FROM trading_positions WHERE intent_id = ?) +
       (SELECT COUNT(*) FROM trading_operations WHERE intent_id = ?) AS count`, [intentId, intentId, intentId]);
  return row?.count === 0;
}

async function candidateJournal(account: TradingAccount, intentId: string, plan: TradingPlan, witness?: TradingDispatchWitness): Promise<CandidateOperation[]> {
  const operations = await getDatabase().all<CandidateOperation[]>('SELECT * FROM trading_operations WHERE intent_id = ?', [intentId]);
  if (!await originalPlanJournalMatches(account, intentId, plan, operations)) reject();
  if (witness && !journalMatchesWitness(operations, witness)) reject();
  return operations;
}

function journalMatchesWitness(operations: CandidateOperation[], witness: TradingDispatchWitness): boolean {
  const dispatch = currentDispatchIdentity(witness);
  const operation = operations[0];
  return dispatch !== null && operations.length === 1 && operation!.id === dispatch.operationId && operation!.phase === 'dispatching'
    && operation!.account_id === dispatch.accountId && operation!.request_hash === dispatch.requestHash
    && operation!.account_fingerprint === dispatch.accountFingerprint && operation!.credential_generation === dispatch.credentialGeneration;
}

async function exemptionEvidence(intentId: string, plan: TradingPlan | null, operations: CandidateOperation[], witness?: TradingDispatchWitness): Promise<CandidateExemption> {
  const orders = await getDatabase().all('SELECT * FROM trading_orders WHERE intent_id = ? ORDER BY id', [intentId]);
  const positions = await getDatabase().all('SELECT * FROM trading_positions WHERE intent_id = ? ORDER BY id', [intentId]);
  const intent = await getTradingIntent(intentId);
  return { intentId, planHash: plan ? hash(JSON.stringify(plan)) : null, operationId: operations[0]?.id ?? null,
    generation: operations[0]?.generation ?? null, requestHash: operations[0]?.request_hash ?? null,
    noSendBasis: witness ? 'current_dispatch_fence' : plan ? 'local_prepared' : 'empty_pending',
    noSendEvidenceHash: hash(JSON.stringify({ intent, orders, positions, operations, fills: [] })) };
}

/** The writer's live, nonserializable witness is needed for its final fence. Old in-flight writes are never exempted. */
export async function assertCandidateNeverSent(account: TradingAccount, intentId: string, plan: TradingPlan | null, witness?: TradingDispatchWitness): Promise<CandidateExemption> {
  if (witness && !currentDispatchIdentity(witness)) reject();
  const intent = await getTradingIntent(intentId);
  if (!intent || intent.accountId !== account.id || intent.exchange !== account.exchange || intent.mode !== account.mode
    || !isDeepStrictEqual(intent.plan, plan)) reject();
  if (!plan) {
    if (intent.status !== 'pending' || witness || !await hasNoCandidateState(intentId)) reject();
    return exemptionEvidence(intentId, null, []);
  }
  try {
    if (!await hasUndispatchedPlanProof(intent, false, witness)) reject();
    const operations = await candidateJournal(account, intentId, plan, witness);
    return exemptionEvidence(intentId, plan, operations, witness);
  } catch { reject(); }
}
