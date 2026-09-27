import { describe, expect, it } from "vitest";
import { passt } from "@/lib/router";

describe("Mini-Router", () => {
  it("erkennt statische Routen", () => {
    expect(passt("/trading/konten", "/trading/konten")).toEqual({});
  });
  it("extrahiert Parameter", () => {
    expect(passt("/trading/konten/:id", "/trading/konten/paper-1")).toEqual({ id: "paper-1" });
  });
  it("lehnt unpassende Pfade ab", () => {
    expect(passt("/trading/konten/:id", "/trading/orders")).toBeNull();
    expect(passt("/risiko/limits", "/risiko/konten")).toBeNull();
  });
});
