import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Logo } from "@/components/logo"

describe("TSX Core branding", () => {
  it("renders the supplied logo asset with an accessible product name", () => {
    const { container } = render(<Logo variant="full" size={40} />)

    expect(screen.getByRole("img", { name: "TSX Core" })).toBeTruthy()
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/brand/tsx-core-logo.png")
    expect(screen.getByText("CORE")).toBeTruthy()
  })
})
