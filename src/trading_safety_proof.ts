import { createHash } from 'node:crypto';
import { compareDecimal, decimal } from './trading_decimal.js';
import { entryCommitmentReason, TERMINAL_ORDER_STATES } from './trading_entry_commitment.js';
import { protectiveStopCoverage, requiredStopQuantity, type ProtectionNeed, type ProtectionOrder } from './trading_protection.js';
import type { OwnershipProof } from './trading_ownership.js';
import type { ExchangeAcquisitionEvidence } from './trading_types.js';
import { fillCoverageReason } from './exchange_history_coverage.js';

export type SafetyPurpose = 'entryAdmission' | 'entriesDrained' | 'positionProtected' | 'tradeClosed' | 'accountRelease';
export interface SafetyBinding {
  accountId: string; accountVersion: number; runtimeEpoch: string;
  accountFingerprint: string | null; credentialGeneration: string | null;
}
export interface SafetyOrder extends ProtectionOrder { remoteConfirmed: boolean }
export interface SafetyPosition {
  need: ProtectionNeed; ownership: OwnershipProof | null; remoteMatches: boolean;
  /** A local quantity projection can lag a newly observed closing fill; it is not the ownership ledger. */
  projectionMatches?: boolean;
}
export interface SafetyOperation { id: string; intentId: string; phase: string; hasEntry: boolean }
export interface HistoricalTradeSafety {
  intentId: string; accountId: string; hasEntryHistory: boolean;
  ownership: OwnershipProof | null; closedProjectionQuantity: string | null;
}
export interface CandidateExemption {
  intentId: string; planHash: string | null; operationId: string | null; generation: number | null; requestHash: string | null;
  noSendBasis: 'empty_pending' | 'local_prepared' | 'current_dispatch_fence'; noSendEvidenceHash: string;
}
export interface SafetyEvidence {
  binding: SafetyBinding; identityVerified: boolean; stateCurrent: boolean; accountReady: boolean; entryAllowed: boolean;
  acquisition?: ExchangeAcquisitionEvidence; minimumAcquisitionStart: number; requiredSince: number; now: number;
  orders: SafetyOrder[]; positions: SafetyPosition[]; operations: SafetyOperation[];
  unresolvedEvidence: number; fillIdentityUnresolved: number; foreignOrders: number; foreignPositions: number;
  blockingIncidents: string[]; reviewRequiredIntents: string[]; balanceVerified: boolean;
  historyExchange?: string;
  runtimeCurrent?: boolean;
  /** Closed/position-less trades are checked against their own ledger, never a later same-symbol position. */
  historicalTrades?: HistoricalTradeSafety[];
  candidateExemption?: CandidateExemption;
}
export interface SafetyReason { code: string; intentId?: string; orderId?: string }
export interface TradingSafetyProof {
  version: 1; purpose: SafetyPurpose; binding: SafetyBinding; intentId: string | null;
  safe: boolean; reasons: SafetyReason[]; evaluatedAt: number; acquisitionStartedAt: number | null;
  acquisitionCompletedAt: number | null; evidenceHash: string;
  candidateExemption?: CandidateExemption;
}

export class TradingSafetyProofError extends Error {
  readonly code = 'SAFETY_PROOF_REJECTED';
  constructor(readonly proof: TradingSafetyProof) {
    super(`Safety proof ${proof.purpose} rejected: ${[...new Set(proof.reasons.map(reason => reason.code))].join(', ')}`);
    this.name = 'TradingSafetyProofError';
  }
}

const FRESHNESS_MS = 30_000;
const terminal = (status: string) => (TERMINAL_ORDER_STATES as readonly string[]).includes(status);
const pending = (operation: SafetyOperation) => !['resolved', 'abandoned'].includes(operation.phase);

function acquisitionReasons(input: SafetyEvidence): SafetyReason[] {
  const acquisition = input.acquisition;
  if (!acquisition) return [{ code: 'ACQUISITION_MISSING' }];
  const reasons: SafetyReason[] = [];
  if (acquisition.version !== 1 || !Number.isSafeInteger(acquisition.startedAt) || !Number.isSafeInteger(acquisition.completedAt)
    || acquisition.startedAt < input.minimumAcquisitionStart || acquisition.completedAt < acquisition.startedAt
    || acquisition.completedAt > input.now || input.now - acquisition.startedAt > FRESHNESS_MS) {
    reasons.push({ code: 'ACQUISITION_NOT_FRESH' });
  }
  for (const source of ['orders', 'positions', 'fills'] as const) {
    const sources = acquisition.sources.filter(item => item.source === source);
    if (sources.length === 0 || sources.some(item => item.completeness !== 'complete')) {
      reasons.push({ code: `SOURCE_${source.toUpperCase()}_INCOMPLETE` });
    }
    if (sources.some(item => item.startedAt < acquisition.startedAt || item.completedAt > acquisition.completedAt
      || item.completedAt < item.startedAt)) reasons.push({ code: 'SOURCE_WINDOW_INVALID' });
    if (source === 'fills' && sources.some(item => item.since === null || item.since > input.requiredSince)) {
      reasons.push({ code: 'FILL_BASELINE_UNPROVED' });
    }
  }
  return [...reasons, ...historicalCoverageReasons(input)];
}

function historicalCoverageReasons(input: SafetyEvidence): SafetyReason[] {
  if (!input.historyExchange || !input.acquisition) return [];
  const reason = fillCoverageReason(input.historyExchange, input.acquisition, input.requiredSince);
  return reason ? [{ code: reason }] : [];
}

function orderQuantityValid(order: SafetyOrder): boolean {
  try {
    if (order.filledQuantity === null) return false;
    const quantity = decimal(order.quantity, { positive: true });
    const filled = decimal(order.filledQuantity);
    return compareDecimal(filled, quantity) <= 0 && (order.status !== 'filled' || compareDecimal(filled, quantity) === 0);
  } catch { return false; }
}

function commitmentReasons(orders: SafetyOrder[], operations: SafetyOperation[], allExits: boolean): SafetyReason[] {
  const reasons: SafetyReason[] = [];
  for (const order of orders) {
    const uncertain = operations.some(operation => operation.intentId === order.intentId && operation.hasEntry && pending(operation));
    const code = order.role === 'entry' ? entryCommitmentReason(order.status, uncertain)
      : allExits && !terminal(order.status) ? 'EXIT_SIBLING_NOT_TERMINAL' : null;
    if (code) reasons.push({ code, intentId: order.intentId, orderId: order.clientOrderId ?? undefined });
  }
  return reasons;
}

function positionReasons(position: SafetyPosition, orders: SafetyOrder[], closed: boolean): SafetyReason[] {
  const intentId = position.need.intentId;
  if (!position.ownership) return [{ code: 'OWNED_QUANTITY_UNPROVED', intentId }];
  if (!position.remoteMatches) return [{ code: 'REMOTE_OWNERSHIP_MISMATCH', intentId }];
  if (closed) return position.ownership.netQuantity === '0' ? [] : [{ code: 'OWNED_POSITION_NOT_FLAT', intentId }];
  if (position.projectionMatches === false) return [{ code: 'POSITION_PROJECTION_MISMATCH', intentId }];
  try {
    const own = orders.filter(order => order.intentId === intentId);
    const need = { ...position.need,
      quantity: requiredStopQuantity(position.ownership.netQuantity, own.filter(order => order.role === 'entry')) };
    if (need.quantity === '0') return [];
    const covered = own.some(order => order.remoteConfirmed && protectiveStopCoverage(order, need).protected);
    return covered ? [] : [{ code: 'POSITION_NOT_PROTECTED', intentId }];
  } catch { return [{ code: 'PROTECTION_QUANTITY_UNPROVED', intentId }]; }
}

function admissionReasons(input: SafetyEvidence, purpose: SafetyPurpose): SafetyReason[] {
  if (!['entryAdmission', 'accountRelease'].includes(purpose)) return [];
  const reasons: SafetyReason[] = [];
  if (!input.accountReady) reasons.push({ code: 'ACCOUNT_NOT_VERIFIED_READY' });
  if (!input.balanceVerified) reasons.push({ code: 'ACCOUNT_BALANCE_UNPROVED' });
  if (purpose === 'entryAdmission' && !input.entryAllowed) reasons.push({ code: 'ENTRY_ADMISSION_DISABLED' });
  for (const _incident of input.blockingIncidents) reasons.push({ code: 'BLOCKING_ACCOUNT_INCIDENT' });
  for (const intentId of input.reviewRequiredIntents) reasons.push({ code: 'TRADE_REVIEW_REQUIRED', intentId });
  reasons.push(...historicalTradeReasons(input));
  return reasons;
}

function historicalTradeReasons(input: SafetyEvidence): SafetyReason[] {
  const reasons: SafetyReason[] = [];
  for (const trade of input.historicalTrades ?? []) {
    const context = { intentId: trade.intentId };
    if (trade.accountId !== input.binding.accountId) reasons.push({ code: 'HISTORICAL_ACCOUNT_MISMATCH', ...context });
    if (!trade.hasEntryHistory) reasons.push({ code: 'HISTORICAL_ENTRY_MISSING', ...context });
    if (!trade.ownership) reasons.push({ code: 'HISTORICAL_OWNERSHIP_UNPROVED', ...context });
    else if (trade.ownership.netQuantity !== '0') reasons.push({ code: 'HISTORICAL_TRADE_NOT_FLAT', ...context });
    if (trade.closedProjectionQuantity !== null && trade.closedProjectionQuantity !== '0') {
      reasons.push({ code: 'CLOSED_POSITION_NOT_ZERO', ...context });
    }
  }
  return reasons;
}

function scopeEvidence(input: SafetyEvidence, intentId?: string) {
  return { orders: input.orders.filter(order => intentId === undefined || order.intentId === intentId),
    operations: input.operations.filter(operation => intentId === undefined || operation.intentId === intentId),
    positions: input.positions.filter(position => intentId === undefined || position.need.intentId === intentId) };
}

function remoteReasons(input: SafetyEvidence): SafetyReason[] {
  const reasons: SafetyReason[] = [];
  if (!input.identityVerified) reasons.push({ code: 'ACCOUNT_IDENTITY_UNPROVED' });
  if (!input.stateCurrent) reasons.push({ code: 'ACCOUNT_STATE_CHANGED' });
  if (input.runtimeCurrent === false) reasons.push({ code: 'RUNTIME_GENERATION_CHANGED' });
  if (input.unresolvedEvidence > 0) reasons.push({ code: 'REMOTE_EVENTS_UNRESOLVED' });
  if (!Number.isSafeInteger(input.fillIdentityUnresolved) || input.fillIdentityUnresolved !== 0) reasons.push({ code: 'FILL_IDENTITY_UNPROVEN' });
  if (input.foreignOrders > 0) reasons.push({ code: 'FOREIGN_ORDER_PRESENT' });
  if (input.foreignPositions > 0) reasons.push({ code: 'FOREIGN_POSITION_PRESENT' });
  return reasons;
}

function localOrderReasons(order: SafetyOrder, accountId: string): SafetyReason[] {
  const reasons: SafetyReason[] = [];
  const context = { intentId: order.intentId, orderId: order.clientOrderId ?? undefined };
  if (order.accountId !== accountId) reasons.push({ code: 'ORDER_ACCOUNT_MISMATCH', ...context });
  if (!orderQuantityValid(order)) reasons.push({ code: 'ORDER_QUANTITY_UNPROVED', ...context });
  if (['submitting', 'unknown', 'cancel_pending'].includes(order.status)) reasons.push({ code: 'ORDER_OUTCOME_UNRESOLVED', ...context });
  if (!terminal(order.status) && order.status !== 'created' && !order.remoteConfirmed) {
    reasons.push({ code: 'ACTIVE_ORDER_NOT_OBSERVED', ...context });
  }
  return reasons;
}

function purposeReasons(input: SafetyEvidence, scope: ReturnType<typeof scopeEvidence>, purpose: SafetyPurpose, intentId?: string): SafetyReason[] {
  const { orders, operations, positions } = scope;
  const reasons: SafetyReason[] = [];
  if (['tradeClosed', 'positionProtected'].includes(purpose) && (!intentId || positions.length !== 1)) {
    reasons.push({ code: 'TRADE_SCOPE_UNPROVED' });
  }
  if ((purpose === 'tradeClosed' || (purpose === 'entriesDrained' && intentId)) && !orders.some(order => order.role === 'entry')) {
    reasons.push({ code: 'ENTRY_HISTORY_MISSING' });
  }
  for (const position of positions) {
    if (position.need.accountId !== input.binding.accountId) reasons.push({ code: 'POSITION_ACCOUNT_MISMATCH', intentId: position.need.intentId });
  }
  if (purpose !== 'positionProtected' && operations.some(pending)) reasons.push({ code: 'EXCHANGE_OPERATION_UNRESOLVED' });
  if (['entriesDrained', 'accountRelease', 'tradeClosed'].includes(purpose)) {
    reasons.push(...commitmentReasons(orders, operations, purpose === 'tradeClosed'));
  }
  if (purpose !== 'entriesDrained') {
    for (const position of positions) reasons.push(...positionReasons(position, orders, purpose === 'tradeClosed'));
  }
  return reasons;
}

/** No side effects and no inferred terminal/ownership state. Only the evidence collector may construct production inputs. */
export function evaluateTradingSafety(input: SafetyEvidence, purpose: SafetyPurpose, intentId?: string): TradingSafetyProof {
  const scope = scopeEvidence(input, intentId);
  const reasons = [...acquisitionReasons(input), ...remoteReasons(input), ...purposeReasons(input, scope, purpose, intentId),
    ...scope.orders.flatMap(order => localOrderReasons(order, input.binding.accountId)), ...admissionReasons(input, purpose)];
  const unique = [...new Map(reasons.map(reason => [JSON.stringify(reason), reason])).values()];
  return { version: 1, purpose, intentId: intentId ?? null, binding: { ...input.binding }, safe: unique.length === 0, reasons: unique,
    evaluatedAt: input.now, acquisitionStartedAt: input.acquisition?.startedAt ?? null, acquisitionCompletedAt: input.acquisition?.completedAt ?? null,
    ...(input.candidateExemption ? { candidateExemption: structuredClone(input.candidateExemption) } : {}),
    evidenceHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
}

export function assertTradingSafety(proof: TradingSafetyProof): void {
  if (!proof.safe) throw new TradingSafetyProofError(proof);
}
