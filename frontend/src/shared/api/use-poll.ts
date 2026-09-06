import { useEffect, useRef } from "react";

/** Sequential reads with cancellation, stale-response isolation and bounded backoff. */
export function usePoll<T>(
  read: (signal: AbortSignal) => Promise<T>,
  accept: (value: T) => void,
  reject: (error: Error) => void,
  intervalMs = 5_000,
  refreshKey?: number | string,
) {
  const callbacks = useRef({ accept, reject });
  callbacks.current = { accept, reject };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    let running = false;
    let refreshRequested = false;
    const poll = async () => {
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        const result = await read(controller.signal);
        if (!controller.signal.aborted) callbacks.current.accept(result);
        failures = 0;
      } catch (error) {
        if (!controller.signal.aborted) callbacks.current.reject(error instanceof Error ? error : new Error(String(error)));
        failures += 1;
      }
      running = false;
      if (!controller.signal.aborted) {
        timer = setTimeout(poll, refreshRequested ? 0 : Math.min(60_000, intervalMs * 2 ** Math.min(failures, 4)) * (document.hidden ? 2 : 1));
        refreshRequested = false;
      }
    };
    const visible = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      if (running) refreshRequested = true;
      else void poll();
    };
    document.addEventListener('visibilitychange', visible);
    void poll();
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [read, intervalMs, refreshKey]);
}
