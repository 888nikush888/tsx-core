import { addDecimal, addSignedDecimal, compareDecimal, decimal, multiplyExactSignedDecimal, signedDecimal, subtractDecimal } from './trading_decimal.js';
import { validateFillAccounting } from './trading_accounting_contract.js';
import { moneyValueFromDecimal, type MoneyValue } from './trading_money_value.js';
import type { ExchangeFillAccounting, TradingSide } from './trading_types.js';

export const RISK_EVIDENCE_TTL_MS = 60_000;
export interface RiskEntryRemainder {
  id: string; generation: number; status: string; quantity: string; filledQuantity: string | null;
  /** Actual original normal limit or immutable IOC boundary, never the pre-cap market reference. */
  price: string | null; operationUnresolved: boolean;
}
export interface RiskReservationInput {
  side: TradingSide; ownedQuantity: string; averageEntryPrice: string | null; markPrice: string | null;
  stopPrice: string; reportingCurrency: string; market: ExchangeFillAccounting | null;
  entries: RiskEntryRemainder[]; protectionProven: boolean;
}
export interface RiskReservationAmounts {
  status: 'complete' | 'unresolved'; reason: string | null; reportingCurrency: string;
  ownedQuantity: string | null; pendingQuantity: string | null; markToStopRisk: string | null;
  pendingEntryRisk: string | null; actualFillToStopRisk: string | null; additionalRisk: string | null;
  markToStopRiskValue: MoneyValue | null; pendingEntryRiskValue: MoneyValue | null;
  actualFillToStopRiskValue: MoneyValue | null; additionalRiskValue: MoneyValue | null;
}

function lossToStop(side: TradingSide, reference: string | null, stop: string, quantity: string): string {
  if (quantity === '0') return '0';
  if (reference === null) throw new Error('Risk price is unproven.');
  const price = decimal(reference, { positive: true });
  const adverse = side === 'LONG' ? compareDecimal(price, stop) > 0 : compareDecimal(stop, price) > 0;
  if (!adverse) return '0';
  const distance = side === 'LONG' ? subtractDecimal(price, stop) : subtractDecimal(stop, price);
  return multiplyExactSignedDecimal(distance, quantity);
}

function remainingEntry(entry: RiskEntryRemainder): string {
  if (entry.operationUnresolved) throw new Error('Entry operation remains unresolved.');
  if (entry.filledQuantity === null) throw new Error('Entry executed quantity remains unproven.');
  const remaining = subtractDecimal(decimal(entry.quantity, { positive: true }), decimal(entry.filledQuantity));
  if (entry.status === 'filled' && remaining !== '0') throw new Error('Filled entry still has an unexplained residual.');
  if (['filled', 'cancelled', 'rejected'].includes(entry.status)) return '0';
  if (!['created', 'submitting', 'open', 'partially_filled', 'cancel_pending', 'unknown'].includes(entry.status)) {
    throw new Error('Entry lifecycle is unproven.');
  }
  return remaining;
}

function provedReservation(input: RiskReservationInput): RiskReservationAmounts {
  if (!['LONG', 'SHORT'].includes(input.side)) throw new Error('Risk side is invalid.');
  const market = validateFillAccounting(input.market);
  if (market.settlementAsset !== input.reportingCurrency) throw new Error('Risk settlement conversion is unproven.');
  if (!input.protectionProven) throw new Error('Risk stop coverage is unproven.');
  const ownedQuantity = decimal(input.ownedQuantity);
  const stop = decimal(input.stopPrice, { positive: true });
  let pendingQuantity = '0'; let pendingEntryRisk = '0';
  for (const entry of input.entries) {
    const quantity = remainingEntry(entry);
    pendingQuantity = addDecimal(pendingQuantity, quantity);
    pendingEntryRisk = addDecimal(pendingEntryRisk, lossToStop(input.side, entry.price, stop, quantity));
  }
  const markToStopRisk = lossToStop(input.side, input.markPrice, stop, ownedQuantity);
  const actualFillToStopRisk = lossToStop(input.side, input.averageEntryPrice, stop, ownedQuantity);
  const additionalRisk = addDecimal(markToStopRisk, pendingEntryRisk);
  return { status: 'complete', reason: null, reportingCurrency: input.reportingCurrency, ownedQuantity, pendingQuantity,
    markToStopRisk, pendingEntryRisk, actualFillToStopRisk, additionalRisk,
    markToStopRiskValue: moneyValueFromDecimal(markToStopRisk), pendingEntryRiskValue: moneyValueFromDecimal(pendingEntryRisk),
    actualFillToStopRiskValue: moneyValueFromDecimal(actualFillToStopRisk), additionalRiskValue: moneyValueFromDecimal(additionalRisk) };
}

export function unresolvedRiskAmounts(reportingCurrency: string, error: unknown): RiskReservationAmounts {
  return { status: 'unresolved', reason: error instanceof Error ? error.message : 'Risk evidence is unresolved.',
    reportingCurrency, ownedQuantity: null, pendingQuantity: null, markToStopRisk: null, pendingEntryRisk: null,
    actualFillToStopRisk: null, additionalRisk: null, markToStopRiskValue: null, pendingEntryRiskValue: null,
    actualFillToStopRiskValue: null, additionalRiskValue: null };
}

/** Uncertainty blocks admission, never silently frees a commitment or prevents an existing stop. */
export function calculateRiskReservation(input: RiskReservationInput): RiskReservationAmounts {
  try { return provedReservation(input); }
  catch (error) {
    return unresolvedRiskAmounts(input.reportingCurrency, error);
  }
}

export function calculateDailyRisk(input: { budget: string; ledgerPnl: string; unrealizedPnl: string; existingCommitment: string; candidateCommitment: string }) {
  const budget = decimal(input.budget);
  const dayPnl = addSignedDecimal(signedDecimal(input.ledgerPnl), signedDecimal(input.unrealizedPnl));
  const consumedLoss = dayPnl.startsWith('-') ? dayPnl.slice(1) : '0';
  const existingCommitment = decimal(input.existingCommitment);
  const candidateCommitment = decimal(input.candidateCommitment);
  const totalCommitment = addDecimal(addDecimal(consumedLoss, existingCommitment), candidateCommitment);
  return { dayPnl, consumedLoss, existingCommitment, candidateCommitment, totalCommitment, budget,
    allowed: compareDecimal(totalCommitment, budget) <= 0 };
}

export function assertRiskFresh(proof: { observedAt: number; expiresAt: number; utcDay: number }, now = Date.now()): void {
  if (![proof.observedAt, proof.expiresAt, proof.utcDay, now].every(Number.isSafeInteger)
    || proof.observedAt < 0 || proof.expiresAt <= proof.observedAt
    || proof.observedAt > now + 1000 || now >= proof.expiresAt || proof.expiresAt > proof.observedAt + RISK_EVIDENCE_TTL_MS
    || proof.utcDay !== new Date(now).setUTCHours(0, 0, 0, 0)) throw new Error('Risk evidence is stale, in the future or belongs to another UTC day.');
}
