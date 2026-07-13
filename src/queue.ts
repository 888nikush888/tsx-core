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
  public running: number;
  public queue: QueueItem[];
  public paused: boolean;

  constructor(maxConcurrency = 2, timeoutMs = 60000) {
    this.maxConcurrency = maxConcurrency;
    this.timeoutMs = timeoutMs;
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
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this.next();
    });
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

  /**
   * Applies queue limits without dropping queued work. When concurrency is raised,
   * newly available workers begin processing immediately.
   */
  public updateSettings(maxConcurrency: number, timeoutMs: number): void {
    this.maxConcurrency = Math.max(1, Math.floor(maxConcurrency));
    this.timeoutMs = Math.max(0, Math.floor(timeoutMs));

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
    const signal = controller.signal;

    let completed = false;
    let timeoutId: NodeJS.Timeout | null = null;

    if (this.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          this.running--;
          controller.abort();
          reject(new Error(`Task timed out after ${this.timeoutMs}ms`));
          this.next();
        }
      }, this.timeoutMs);
    }

    Promise.resolve(taskFn(signal))
      .then((val) => {
        if (!completed) {
          completed = true;
          if (timeoutId) clearTimeout(timeoutId);
          resolve(val);
          this.running--;
          this.next();
        }
      })
      .catch((err) => {
        if (!completed) {
          completed = true;
          if (timeoutId) clearTimeout(timeoutId);
          reject(err);
          this.running--;
          this.next();
        }
      });
  }
}
