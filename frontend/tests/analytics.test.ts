import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Google Tag Manager initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    document.head.replaceChildren();
    document.body.replaceChildren();
    window.dataLayer = [];
  });
  afterEach(() => vi.unstubAllEnvs());

  async function initialize(id: string, production = true) {
    vi.stubEnv("VITE_GTM_ID", id);
    vi.stubEnv("PROD", production);
    const { initGTM } = await import("../src/utils/analytics");
    initGTM();
  }

  it("loads the fixed Google endpoint and preserves existing data-layer events without inline code", async () => {
    window.dataLayer.push({ event: "existing" });
    await initialize("GTM-ABC1234");
    const script = document.head.querySelector("script");
    if (!script) throw new Error("Expected the configured GTM script.");
    expect(script.src).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234");
    expect(script.async).toBe(true);
    expect(script.textContent).toBe("");
    expect(window.dataLayer).toEqual([{ event: "existing" }, { event: "gtm.js", "gtm.start": expect.any(Number) }]);
    const iframe = document.body.querySelector("noscript iframe");
    if (!iframe) throw new Error("Expected the GTM fallback frame.");
    expect(iframe.getAttribute("src")).toBe("https://www.googletagmanager.com/ns.html?id=GTM-ABC1234");
  });

  it.each(["", "GTM-X');alert(1);//", 'GTM-X"><img src=x onerror=alert(1)>', "https://example.com", "GTM-X&evil=1"])(
    "rejects invalid and injection-bearing identifiers: %s", async id => {
      await initialize(id);
      expect(document.querySelector("script, iframe, img, noscript")).toBeNull();
      expect(window.dataLayer).toEqual([]);
    },
  );

  it("does not load analytics outside production", async () => {
    await initialize("GTM-ABC1234", false);
    expect(document.querySelector("script, noscript")).toBeNull();
    expect(window.dataLayer).toEqual([]);
  });
});
