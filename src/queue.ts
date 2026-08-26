/**
 * A concurrency queue designed to limit the number of parallel asynchronous operations.
 * Defaults to a maximum concurrency of 2.
 */
interface QueueItem {
  taskFn: (signal: AbortSignal) => Promise<any>;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

export class ConcurrencyQueue {
  public maxConcurrency: number;
  public timeoutMs: number;
  /** Maximum number of tasks waiting in memory; running tasks are not counted. */
  public maxPending: number;
  public running: number;
  public queue: QueueItem[];
  public paused: boolean;
  private readonly activeControllers = new Set<AbortController>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(maxConcurrency = 2, timeoutMs = 60000, maxPending = Number.POSITIVE_INFINITY) {
    this.maxConcurrency = maxConcurrency;
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
    this.running = 0;
    this.queue = [];
    this.paused = false;
  }

  /**
   * Adds an asynchronous task to the queue.
   * @param taskFn A function returning a Promise.
   * @returns Resolves when the task executes and finishes.
   */
  public add<T>(taskFn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (typeof taskFn !== 'function') {
      return Promise.reject(new TypeError('Task must be a function returning a Promise.'));
    }
    if (this.isAtCapacity) {
      return Promise.reject(new QueueCapacityError(this.maxPending));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this.next();
    });
  }

  public get isAtCapacity(): boolean {
    return this.queue.length >= this.maxPending;
  }

  public get availableCapacity(): number {
    return Number.isFinite(this.maxPending)
      ? Math.max(0, this.maxPending - this.queue.length)
      : Number.MAX_SAFE_INTEGER;
  }

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // Trigger task execution
    for (let i = 0; i < this.maxConcurrency; i++) {
      this.next();
    }
  }

  public clear(): void {
    // Reject all pending items in the queue
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item) {
        item.reject(new Error('Queue was cleared.'));
      }
    }
  }

  public abortRunning(reason = 'Queue task aborted.'): void {
    for (const controller of this.activeControllers) {
      controller.abort(new Error(reason));
    }
  }

  public waitForIdle(timeoutMs = 30_000): Promise<boolean> {
    if (this.running === 0) return Promise.resolve(true);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new Error('Queue drain timeout must be a non-negative safe integer.'));
    }
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (drained: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(drained);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.idleWaiters.add(onIdle);
      if (this.running === 0) onIdle();
    });
  }

  /**
   * Applies queue limits without dropping queued work. When concurrency is raised,
   * newly available workers begin processing immediately.
   */
  public updateSettings(maxConcurrency: number, timeoutMs: number): void {
    this.maxConcurrency = Number.isFinite(maxConcurrency) && maxConcurrency >= 1
      ? Math.floor(maxConcurrency)
      : this.maxConcurrency;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? Math.floor(timeoutMs)
      : this.timeoutMs;

    if (!this.paused) {
      for (let i = this.running; i < this.maxConcurrency; i++) {
        this.next();
      }
    }
  }

  private next(): void {
    if (this.paused) {
      return;
    }
    if (this.running >= this.maxConcurrency) {
      return;
    }
    if (this.queue.length === 0) {
      return;
    }

    const item = this.queue.shift();
    if (!item) return;

    const { taskFn, resolve, reject } = item;
    this.running++;

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const signal = controller.signal;

    let callerSettled = false;
    let timeoutId: NodeJS.Timeout | null = null;
    const taskTimeoutMs = this.timeoutMs;

    if (taskTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!callerSettled) {
          callerSettled = true;
          controller.abort();
          reject(new Error(`Task timed out after ${taskTimeoutMs}ms`));
        }
      }, taskTimeoutMs);
    }

    const releaseSlot = () => {
      if (timeoutId) clearTimeout(timeoutId);
      this.activeControllers.delete(controller);
      this.running--;
      if (this.running === 0) {
        for (const waiter of this.idleWaiters) waiter();
        this.idleWaiters.clear();
      }
      this.next();
    };

    Promise.resolve()
      .then(() => taskFn(signal))
      .then((val) => {
        releaseSlot();
        if (!callerSettled) {
          callerSettled = true;
          resolve(val);
        }
      }, (err) => {
        releaseSlot();
        if (!callerSettled) {
          callerSettled = true;
          reject(err);
        }
      });
  }
}

export class QueueCapacityError extends Error {
  constructor(maxPending: number) {
    super(`Queue pending-task capacity of ${maxPending} has been reached.`);
    this.name = 'QueueCapacityError';
  }
}
