import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Logo } from "@/components/logo"

describe("ERB Asset Management branding", () => {
  it("renders the supplied logo asset with an accessible product name", () => {
    const { container } = render(<Logo variant="full" size={40} />)

    expect(screen.getByRole("img", { name: "ERB Asset Management" })).toBeTruthy()
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/brand/erb-asset-management.png")
  })
})
