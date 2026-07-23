interface DeliveryOutcome {
  destinationMessageId?: string;
  error?: Error;
  expiresAt: number;
}

interface DeliveryWaiter {
  resolve: (destinationMessageId: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ConfirmedDelivery {
  destinationMessageIds: string[];
}

export class TelegramDeliveryTracker {
  private readonly waiters = new Map<string, DeliveryWaiter>();
  private readonly recentOutcomes = new Map<string, DeliveryOutcome>();

  constructor(
    private readonly confirmationTimeoutMs = 30_000,
    private readonly outcomeTtlMs = 5 * 60_000,
    private readonly maxCachedOutcomes = 1000
  ) {
    if (!Number.isSafeInteger(confirmationTimeoutMs) || confirmationTimeoutMs < 1) {
      throw new Error('confirmationTimeoutMs must be a positive safe integer.');
    }
  }

  public handleUpdate(update: any): boolean {
    if (update?._ === 'updateMessageSendSucceeded') {
      const oldMessageId = String(update.old_message_id);
      const destinationMessageId = String(update.message?.id ?? update.old_message_id);
      this.publish(oldMessageId, { destinationMessageId, expiresAt: Date.now() + this.outcomeTtlMs });
      return true;
    }

    if (update?._ === 'updateMessageSendFailed') {
      const oldMessageId = String(update.old_message_id);
      const detail = update.error?.message || update.message?.sending_state?.error?.message || 'Telegram send failed.';
      this.publish(oldMessageId, {
        error: new Error(`Telegram delivery failed for local message ${oldMessageId}: ${detail}`),
        expiresAt: Date.now() + this.outcomeTtlMs
      });
      return true;
    }

    return false;
  }

  public async waitForResult(result: any, signal?: AbortSignal): Promise<ConfirmedDelivery> {
    let messages: any[] = [];
    if (Array.isArray(result?.messages)) messages = result.messages;
    else if (result?.id !== undefined) messages = [result];
    if (messages.length === 0) {
      throw new Error('Telegram send returned no destination messages to confirm.');
    }

    const destinationMessageIds = await Promise.all(messages.map(async (message: any) => {
      if (message?.id === undefined || message?.id === null) {
        throw new Error('Telegram send returned a message without an id.');
      }

      const sendingState = message.sending_state;
      if (!sendingState) return String(message.id);
      if (sendingState._ === 'messageSendingStateFailed') {
        const detail = sendingState.error?.message || 'Telegram reported a failed sending state.';
        throw new Error(detail);
      }
      return this.waitForMessage(String(message.id), signal);
    }));

    return { destinationMessageIds };
  }

  public close(reason = 'Delivery tracker closed.'): void {
    for (const [messageId, waiter] of this.waiters) {
      this.cleanupWaiter(messageId, waiter);
      waiter.reject(new Error(reason));
    }
    this.recentOutcomes.clear();
  }

  private publish(oldMessageId: string, outcome: DeliveryOutcome): void {
    this.pruneOutcomes();
    const waiter = this.waiters.get(oldMessageId);
    if (waiter) {
      this.cleanupWaiter(oldMessageId, waiter);
      if (outcome.error) waiter.reject(outcome.error);
      else waiter.resolve(outcome.destinationMessageId!);
      return;
    }

    this.recentOutcomes.set(oldMessageId, outcome);
    while (this.recentOutcomes.size > this.maxCachedOutcomes) {
      const oldestKey = this.recentOutcomes.keys().next().value;
      if (oldestKey === undefined) break;
      this.recentOutcomes.delete(oldestKey);
    }
  }

  private waitForMessage(oldMessageId: string, signal?: AbortSignal): Promise<string> {
    this.pruneOutcomes();
    const cached = this.recentOutcomes.get(oldMessageId);
    if (cached) {
      this.recentOutcomes.delete(oldMessageId);
      return cached.error ? Promise.reject(cached.error) : Promise.resolve(cached.destinationMessageId!);
    }
    if (signal?.aborted) return Promise.reject(new Error('Delivery confirmation aborted.'));
    if (this.waiters.has(oldMessageId)) {
      return Promise.reject(new Error(`A delivery confirmation waiter already exists for ${oldMessageId}.`));
    }

    return new Promise<string>((resolve, reject) => {
      const waiter: DeliveryWaiter = {
        resolve,
        reject,
        signal,
        timer: setTimeout(() => {
          this.cleanupWaiter(oldMessageId, waiter);
          reject(new Error(`Telegram delivery confirmation timed out after ${this.confirmationTimeoutMs}ms.`));
        }, this.confirmationTimeoutMs)
      };
      if (signal) {
        waiter.onAbort = () => {
          this.cleanupWaiter(oldMessageId, waiter);
          reject(new Error('Delivery confirmation aborted.'));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.set(oldMessageId, waiter);
    });
  }

  private cleanupWaiter(messageId: string, waiter: DeliveryWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    this.waiters.delete(messageId);
  }

  private pruneOutcomes(): void {
    const now = Date.now();
    for (const [messageId, outcome] of this.recentOutcomes) {
      if (outcome.expiresAt <= now) this.recentOutcomes.delete(messageId);
    }
  }
}
