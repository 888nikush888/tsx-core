import { TradingRiskError } from './trading_risk.js';

function entryRequest(endpoint: string, payload: Record<string, any>): Record<string, any> | null {
  const request = endpoint === '/v1/submit-protected-entry' ? payload.entry : endpoint === '/v1/submit-order' ? payload.request : null;
  return request && request.reduceOnly !== true ? request : null;
}

/** Capture before any await. A changed caller object cannot extend the journaled deadline. */
export function captureEntryDeadline(endpoint: string, payload: Record<string, any>): { expiresAt: number | null; assertCurrent(): void } {
  const original = entryRequest(endpoint, payload);
  if (!original) return { expiresAt: null, assertCurrent() {} };
  const expiresAt: unknown = original.entryExpiresAt;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new TradingRiskError('ENTRY_DEADLINE_UNPROVEN', 'ENTRY_DEADLINE_UNPROVEN: original entry deadline is required.');
  }
  const fence = {
    expiresAt,
    assertCurrent(): void {
      const current = entryRequest(endpoint, payload);
      if (current !== original || current.entryExpiresAt !== expiresAt) {
        throw new TradingRiskError('ENTRY_DEADLINE_CHANGED', 'ENTRY_DEADLINE_CHANGED: original entry deadline changed while awaiting dispatch.');
      }
      if (Date.now() >= expiresAt) {
        throw new TradingRiskError('ENTRY_INTENT_EXPIRED', 'ENTRY_INTENT_EXPIRED: original signal deadline expired before entry dispatch.');
      }
    },
  };
  fence.assertCurrent();
  return fence;
}
