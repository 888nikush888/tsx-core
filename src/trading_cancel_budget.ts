import { AsyncLocalStorage } from 'node:async_hooks';

export const MAX_CANCEL_ATTEMPTS = 5;
export const CANCEL_RETRY_MS = 10_000;
export class CancelBudgetExhaustedError extends Error {
  constructor() { super('Shared account cancellation budget exhausted.'); this.name = 'CancelBudgetExhaustedError'; }
}
interface Owner { readonly accountId: string }
interface Budget { accountId: string; remaining: number; active: boolean }
export interface CancelAttemptPermit { readonly accountId: string; readonly clientOrderId: string }
const current = new AsyncLocalStorage<Budget>();
const budgets = new WeakMap<Owner, Budget>();
const permits = new WeakMap<CancelAttemptPermit, { budget: Budget; used: boolean }>();

/** Explicit nested owners reactivate their own existing budget, never the innermost account's budget. */
export async function withCancelBudget<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
  const existing = budgets.get(owner);
  if (existing) {
    if (!existing.active) throw new Error('Cancel budget owner context expired.');
    return current.run(existing, operation);
  }
  const budget = { accountId: owner.accountId, remaining: MAX_CANCEL_ATTEMPTS, active: true };
  budgets.set(owner, budget);
  try { return await current.run(budget, operation); }
  finally { budget.active = false; }
}

/** An unresolvable entry obligation still consumes a fair scheduling attempt, as before. */
export function claimCancelAttempt(accountId: string, clientOrderId: string): CancelAttemptPermit {
  const budget = current.getStore();
  if (!budget?.active || budget.accountId !== accountId) throw new Error('Cancellation lacks its live account context.');
  if (budget.remaining <= 0) throw new CancelBudgetExhaustedError();
  budget.remaining -= 1;
  const permit = Object.freeze({ accountId, clientOrderId });
  permits.set(permit, { budget, used: false });
  return permit;
}

export function consumeCancelAttempt(permit: CancelAttemptPermit, accountId: string, clientOrderId: string): void {
  const record = permits.get(permit);
  if (!record || record.used || !record.budget.active || current.getStore() !== record.budget
    || permit.accountId !== accountId || permit.clientOrderId !== clientOrderId) throw new Error('Cancel permit is invalid, consumed or expired.');
  record.used = true;
}
