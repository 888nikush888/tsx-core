import { useEffect, useRef } from "react"

type PollTask = (signal: AbortSignal) => Promise<void>

/**
 * Runs one request at a time, schedules the next run only after completion,
 * pauses in background tabs, and aborts in-flight work on unmount/visibility
 * changes. The callback ref stays current without resetting the timer.
 */
export function useSerializedPolling(task: PollTask, intervalMs: number, enabled = true) {
  const taskRef = useRef(task)
  taskRef.current = task

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let running = false
    let timer: number | undefined
    let controller: AbortController | undefined
    const pageVisible = () => document.visibilityState !== "hidden"

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    }
    const schedule = (delay: number) => {
      clearTimer()
      if (!disposed) timer = window.setTimeout(() => void run(), delay)
    }
    const run = async () => {
      if (disposed || running || !pageVisible()) return
      running = true
      controller = new AbortController()
      try {
        await taskRef.current(controller.signal)
      } catch (error) {
        if (!controller.signal.aborted) console.error("Polling request failed", error)
      } finally {
        running = false
        controller = undefined
        if (!disposed && pageVisible()) schedule(intervalMs)
      }
    }
    const onVisibilityChange = () => {
      clearTimer()
      if (!pageVisible()) controller?.abort()
      else schedule(0)
    }

    document.addEventListener("visibilitychange", onVisibilityChange)
    schedule(0)
    return () => {
      disposed = true
      clearTimer()
      controller?.abort()
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [enabled, intervalMs])
}
