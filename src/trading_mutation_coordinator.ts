import { withCancelBudget } from './trading_cancel_budget.js';

export interface TradingMutationContext {
  readonly accountId: string;
}

export class EntryAdmissionRevokedError extends Error {
  readonly code = 'ENTRY_ADMISSION_REVOKED';
  readonly sideEffects = false;
  constructor() {
    super('Entry admission invalidated by an operator fence.');
    this.name = 'EntryAdmissionRevokedError';
  }
}

/** One owner per account; nested operations must explicitly pass their live owner context. */
export class TradingMutationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly contexts = new WeakSet<TradingMutationContext>();
  private readonly accountEpochs = new Map<string, number>();
  private globalEpoch = 0;
  private readonly entryHolds = new Map<symbol, string | undefined>();

  entryEpoch(accountId: string): string {
    return `${this.globalEpoch}:${this.accountEpochs.get(accountId) ?? 0}`;
  }

  /** Synchronous invalidation: a prepared entry cannot overtake an operator stop. */
  fenceEntries(accountId?: string): void {
    if (accountId === undefined) this.globalEpoch += 1;
    else this.accountEpochs.set(accountId, (this.accountEpochs.get(accountId) ?? 0) + 1);
  }

  /** Hold admission until a stop intent is durable; multiple concurrent holders cannot release each other. */
  holdEntries(accountId?: string): () => void {
    this.fenceEntries(accountId);
    const token = Symbol('entry-hold');
    this.entryHolds.set(token, accountId);
    return () => { this.entryHolds.delete(token); };
  }

  assertContext(context: TradingMutationContext, accountId = context.accountId): void {
    if (!this.contexts.has(context) || context.accountId !== accountId) {
      throw new Error('Trading mutation context is invalid, expired or belongs to another account.');
    }
  }

  /** Control-plane authorization may release a pre-existing startup admission hold. */
  assertEpoch(context: TradingMutationContext, epoch: string): void {
    this.assertContext(context);
    if (this.entryEpoch(context.accountId) !== epoch) throw new EntryAdmissionRevokedError();
  }

  assertEntryEpoch(context: TradingMutationContext, epoch: string): void {
    this.assertEpoch(context, epoch);
    const held = [...this.entryHolds.values()].some(accountId => accountId === undefined || accountId === context.accountId);
    if (held) throw new EntryAdmissionRevokedError();
  }

  async run<T>(
    accountId: string,
    operation: (context: TradingMutationContext) => Promise<T>,
    context?: TradingMutationContext,
  ): Promise<T> {
    if (!accountId) throw new Error('Trading mutation requires an account identifier.');
    if (context) {
      this.assertContext(context, accountId);
      return withCancelBudget(context, () => operation(context));
    }
    const previous = this.tails.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(accountId, tail);
    await previous;
    const owner = Object.freeze({ accountId });
    this.contexts.add(owner);
    try {
      return await withCancelBudget(owner, () => operation(owner));
    } finally {
      this.contexts.delete(owner);
      release();
      if (this.tails.get(accountId) === tail) this.tails.delete(accountId);
    }
  }
}
