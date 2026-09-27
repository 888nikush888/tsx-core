import { describe, expect, it } from "vitest";
import { accounts, graphEdges, graphNodes, intents, orders, positions, proposals } from "@/data/fixtures";

describe("Fixtures", () => {
  it("konten sind konsistent referenziert", () => {
    const ids = new Set(accounts.map((k) => k.id));
    for (const p of positions) expect(ids.has(p.accountId)).toBe(true);
    for (const o of orders) expect(ids.has(o.accountId)).toBe(true);
  });
  it("graph ist verbunden", () => {
    const knoten = new Set(graphNodes.map((n) => n.id));
    for (const e of graphEdges) {
      expect(knoten.has(e.from)).toBe(true);
      expect(knoten.has(e.to)).toBe(true);
    }
  });
  it("statuswerte sind aus der erlaubten Menge", () => {
    for (const i of intents) expect(["wartend", "beobachtet", "abgeschlossen", "blockiert"]).toContain(i.status);
    for (const p of proposals) expect(["wartend", "genehmigt", "abgelehnt"]).toContain(p.status);
  });
});
