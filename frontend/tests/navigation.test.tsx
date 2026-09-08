import "@testing-library/jest-dom/vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  Link,
  NavigationProvider,
  useLocation,
  useSearchParams,
} from "@/lib/navigation"

function NavigationProbe() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  return (
    <>
      <output>{`${location.pathname}${location.search}`}</output>
      <Link to="/dashboard?tab=logs">Open logs</Link>
      <button
        type="button"
        onClick={() => {
          const next = new URLSearchParams(searchParams)
          next.set("tab", "analytics")
          setSearchParams(next)
        }}
      >
        Open analytics
      </button>
    </>
  )
}

describe("dashboard navigation", () => {
  beforeEach(() => window.history.replaceState({}, "", "/core/"))
  afterEach(() => cleanup())

  it("keeps basename-aware links and search-parameter navigation inside the dashboard", () => {
    render(<NavigationProvider basename="/core"><NavigationProbe /></NavigationProvider>)

    expect(screen.getByRole("link", { name: "Open logs" })).toHaveAttribute("href", "/core/dashboard?tab=logs")
    fireEvent.click(screen.getByRole("link", { name: "Open logs" }))
    expect(screen.getByText("/dashboard?tab=logs")).toBeInTheDocument()
    expect(window.location.pathname).toBe("/core/dashboard")

    fireEvent.click(screen.getByRole("button", { name: "Open analytics" }))
    expect(screen.getByText("/dashboard?tab=analytics")).toBeInTheDocument()
  })

  it("tracks browser back and forward state changes", () => {
    window.history.replaceState({}, "", "/core/dashboard?tab=logs")
    render(<NavigationProvider basename="/core"><NavigationProbe /></NavigationProvider>)

    act(() => {
      window.history.replaceState({}, "", "/core/dashboard?tab=system")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })

    expect(screen.getByText("/dashboard?tab=system")).toBeInTheDocument()
  })

  it.each(["//outside.example/path", "///outside.example/path"])(
    "preserves the dashboard origin when an absolute same-origin URL has pathname %s", (pathname) => {
      const origin = window.location.origin
      const to = `${origin}${pathname}?tab=logs`
      render(<NavigationProvider>
        <Link to={to} target="_blank">Open separate tab</Link>
        <Link to={to}>Open current tab</Link>
      </NavigationProvider>)

      const separate = screen.getByRole("link", { name: "Open separate tab" })
      const href = separate.getAttribute("href")
      expect(href).toBe(to)
      expect(new URL(String(href), origin).origin).toBe(origin)
      expect(new URL(String(href), origin).pathname).toBe(pathname)

      fireEvent.click(screen.getByRole("link", { name: "Open current tab" }))
      expect(window.location.origin).toBe(origin)
      expect(window.location.pathname).toBe(pathname)
      expect(window.location.search).toBe("?tab=logs")
    },
  )
})
