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
})
