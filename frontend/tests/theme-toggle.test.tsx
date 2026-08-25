import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";

describe("theme toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    document.documentElement.className = "";
  });

  afterEach(() => cleanup());

  it("switches to a persistent light theme and back to dark", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="test-theme">
        <ThemeToggle />
      </ThemeProvider>,
    );

    expect(document.documentElement).toHaveClass("dark");
    fireEvent.click(
      screen.getByRole("button", { name: "Hellen Modus aktivieren" }),
    );
    expect(document.documentElement).toHaveClass("light");
    expect(localStorage.getItem("test-theme")).toBe("light");

    fireEvent.click(
      screen.getByRole("button", { name: "Dunklen Modus aktivieren" }),
    );
    expect(document.documentElement).toHaveClass("dark");
    expect(localStorage.getItem("test-theme")).toBe("dark");
  });
});
