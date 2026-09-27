import { beforeEach, describe, expect, it } from "vitest";
import { aktuelleRevision, conflictBeimNaechstenSpeichern, setOffline, speichern } from "@/adapter/memory";

describe("In-Memory-Adapter", () => {
  beforeEach(() => { setOffline(false); });
  it("speichert mit neuer Revision", async () => {
    const vor = aktuelleRevision();
    const r = await speichern({ a: 1 }, 1);
    expect(r.ok).toBe(true);
    expect(r.revision).toBe(vor + 1);
    expect(r.wirksam).toBe(true);
  });
  it("meldet Konflikt genau einmal", async () => {
    conflictBeimNaechstenSpeichern();
    const r1 = await speichern({ a: 1 }, 1);
    expect(r1.konflikt).toBe(true);
    const r2 = await speichern({ a: 1 }, 1);
    expect(r2.ok).toBe(true);
  });
  it("stellt sich offline tot", async () => {
    setOffline(true);
    const r = await speichern({ a: 1 }, 1);
    expect(r.ok).toBe(false);
  });
});
