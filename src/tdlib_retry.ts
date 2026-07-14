export interface TdlibInvoker {
  invoke(query: unknown): Promise<any>;
}

export interface TdlibRetryOptions {
  maxAttempts?: number;
  maxFloodWaitSeconds?: number;
  signal?: AbortSignal | null;
  logger?: (message: string) => void;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('TDLib operation aborted.');
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) throw abortError(signal);
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryLimits(options: TdlibRetryOptions): { maxAttempts: number; maxFloodWaitSeconds: number } {
  const maxAttempts = options.maxAttempts ?? 3;
  const maxFloodWaitSeconds = options.maxFloodWaitSeconds ?? 60;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('TDLib maxAttempts must be between 1 and 10.');
  }
  if (
    !Number.isSafeInteger(maxFloodWaitSeconds) ||
    maxFloodWaitSeconds < 0 ||
    maxFloodWaitSeconds > 3_600
  ) {
    throw new Error('TDLib maxFloodWaitSeconds must be between 0 and 3600.');
  }
  return { maxAttempts, maxFloodWaitSeconds };
}

function floodWaitSeconds(error: unknown, maximum: number): number {
  const message = String((error as any)?.message || error);
  const match = /FLOOD_WAIT_(\d+)/.exec(message);
  if (!match) throw error;
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds > maximum) {
    throw new Error(
      `Telegram FLOOD_WAIT_${match[1]} exceeds the configured ${maximum}s safety limit.`,
      { cause: error }
    );
  }
  return seconds;
}

export async function invokeWithFloodWaitRetry(
  client: TdlibInvoker,
  query: unknown,
  options: TdlibRetryOptions = {}
): Promise<any> {
  const { maxAttempts, maxFloodWaitSeconds } = retryLimits(options);
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError(options.signal);
    try {
      return await client.invoke(query);
    } catch (error) {
      lastError = error;
      const waitSeconds = floodWaitSeconds(error, maxFloodWaitSeconds);
      if (attempt === maxAttempts) break;
      options.logger?.(
        `[WARN] Telegram rate limit: waiting ${waitSeconds}s before attempt ${attempt + 1}/${maxAttempts}.`
      );
      await abortableDelay(waitSeconds * 1_000, options.signal);
    }
  }
  throw new Error(`TDLib operation failed after ${maxAttempts} rate-limit attempts.`, { cause: lastError });
}
