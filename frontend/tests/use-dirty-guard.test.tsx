import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDirtyGuard } from "@/shared/forms/use-dirty-guard";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function attemptUnload() {
  const event = new Event("beforeunload", { cancelable: true });
  const legacyAssignment = vi.fn();
  // JSDOM exposes Event's boolean returnValue; capture the browser's legacy string assignment explicitly.
  Object.defineProperty(event, "returnValue", { configurable: true, set: legacyAssignment });
  const preventDefault = vi.spyOn(event, "preventDefault");
  const allowed = window.dispatchEvent(event);
  return { event, legacyAssignment, preventDefault, allowed };
}

function attemptNavigation() {
  const event = new Event("tsx:navigation-check", { cancelable: true });
  const allowed = window.dispatchEvent(event);
  return { event, allowed };
}

describe("unsaved-change navigation guard", () => {
  it("allows unload and in-app navigation while the form is clean", () => {
    renderHook(() => useDirtyGuard(false));
    const unload = attemptUnload();
    expect(unload.allowed).toBe(true);
    expect(unload.event.defaultPrevented).toBe(false);
    expect(unload.preventDefault).not.toHaveBeenCalled();
    expect(unload.legacyAssignment).not.toHaveBeenCalled();
    const navigation = attemptNavigation();
    expect(navigation.allowed).toBe(true);
    expect(navigation.event.defaultPrevented).toBe(false);
  });

  it("requests the modern unload prompt and also assigns the legacy browser fallback", () => {
    renderHook(() => useDirtyGuard(true));
    const unload = attemptUnload();
    expect(unload.allowed).toBe(false);
    expect(unload.event.defaultPrevented).toBe(true);
    expect(unload.preventDefault).toHaveBeenCalledTimes(1);
    expect(unload.legacyAssignment).toHaveBeenCalledExactlyOnceWith("");
  });

  it("cancels the in-app navigation check while changes are unsaved", () => {
    renderHook(() => useDirtyGuard(true));
    const navigation = attemptNavigation();
    expect(navigation.allowed).toBe(false);
    expect(navigation.event.defaultPrevented).toBe(true);
  });

  it("removes the installed listeners after saving and reinstates the guard for later edits", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const removeListener = vi.spyOn(window, "removeEventListener");
    const { rerender } = renderHook(({ dirty }) => useDirtyGuard(dirty), { initialProps: { dirty: true } });
    const listeners = addListener.mock.calls.filter(([type]) => type === "beforeunload" || type === "tsx:navigation-check");
    expect(listeners).toHaveLength(2);
    rerender({ dirty: false });
    for (const [type, listener] of listeners) expect(removeListener).toHaveBeenCalledWith(type, listener);
    const unload = attemptUnload();
    expect(unload.allowed).toBe(true);
    expect(unload.legacyAssignment).not.toHaveBeenCalled();
    expect(attemptNavigation().allowed).toBe(true);
    rerender({ dirty: true });
    expect(attemptUnload().allowed).toBe(false);
    expect(attemptNavigation().allowed).toBe(false);
  });

  it("removes its own listeners on unmount and leaves unrelated navigation observers intact", () => {
    const unrelatedObserver = vi.fn();
    window.addEventListener("tsx:navigation-check", unrelatedObserver);
    try {
      const addListener = vi.spyOn(window, "addEventListener");
      const removeListener = vi.spyOn(window, "removeEventListener");
      const { unmount } = renderHook(() => useDirtyGuard(true));
      const listeners = addListener.mock.calls.filter(([type]) => type === "beforeunload" || type === "tsx:navigation-check");
      expect(listeners).toHaveLength(2);
      unmount();
      for (const [type, listener] of listeners) expect(removeListener).toHaveBeenCalledWith(type, listener);
      const unload = attemptUnload();
      expect(unload.allowed).toBe(true);
      expect(unload.legacyAssignment).not.toHaveBeenCalled();
      expect(attemptNavigation().allowed).toBe(true);
      expect(unrelatedObserver).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("tsx:navigation-check", unrelatedObserver);
    }
  });
});
