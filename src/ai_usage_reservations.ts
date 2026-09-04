/** Reservation identity is part of the public provider-attempt contract. */
export { reserveAiUsage, commitAiUsage, type AiUsageReservation } from './db.js';

export class AiUsageSettlementError extends Error {
  constructor(readonly reservationId: string, readonly allowance: number, readonly actualTokens: number | null, cause: unknown) {
    super(`AI usage settlement requires reconciliation: reservation=${reservationId}, allowance=${allowance}, actual=${actualTokens ?? 'unknown'}.`, { cause });
    this.name = 'AiUsageSettlementError';
  }
}

export async function settleAiUsage(
  budget: { commit(id: string, allowance: number, actualTokens: number | null): Promise<void> },
  reservationId: string, allowance: number, actualTokens: number | null,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await budget.commit(reservationId, allowance, actualTokens);
      return;
    } catch (error) {
      failure = error;
    }
  }
  throw new AiUsageSettlementError(reservationId, allowance, actualTokens, failure);
}
