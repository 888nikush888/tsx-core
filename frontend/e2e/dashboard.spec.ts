import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const TOKEN = "a".repeat(32);
const secretState = { configured: false, editable: true, source: "missing" };

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockDashboardApi(
  page: Page,
  firstRun = false,
  workflowResources: Array<Record<string, unknown>> = [],
  workflow: Record<string, unknown> | null = null,
) {
  let currentWorkflow = workflow;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/bootstrap/status") {
      await json(route, {
        required: firstRun,
        available: true,
        localSessionAvailable: !firstRun,
      });
      return;
    }
    if (url.pathname === "/api/bootstrap") {
      await json(
        route,
        { token: TOKEN, recoveryLocation: "secrets/dashboard_admin_token" },
        201,
      );
      return;
    }
    if (url.pathname === "/api/local-session") {
      await json(
        route,
        {
          token: TOKEN,
          role: "admin",
          localStartup: true,
          generatedAdminToken: firstRun,
          expiresInSeconds: firstRun ? undefined : 43_200,
        },
        201,
      );
      return;
    }
    const authorized = request.headers().authorization === `Bearer ${TOKEN}`;
    if (url.pathname === "/api/status" && !authorized) {
      await json(route, { error: "Authentication required." }, 401);
      return;
    }
    if (!authorized) {
      await json(route, { error: "Authentication required." }, 401);
      return;
    }
    if (url.pathname === "/api/status") {
      await json(route, {
        isRunning: false,
        connectionState: "disconnected",
        totalForwardedCount: 0,
        processedSinceRestart: 0,
        forwardingEnabled: true,
        forwardXmlToTarget: false,
        queue: { running: 0, queued: 0, maxConcurrency: 2, paused: false },
        telegramLogin: { state: "idle" },
      });
      return;
    }
    if (url.pathname === "/api/workflow") {
      await json(route, {
        workflow: currentWorkflow,
        resources: workflowResources,
      });
      return;
    }
    if (url.pathname === "/api/workflow/impact") {
      await json(route, {
        impact: {
          destructive: false,
          changed: [],
          removed: [],
          confirmation: null,
        },
      });
      return;
    }
    if (url.pathname === "/api/workflow/mutate") {
      const body = request.postDataJSON() as { graph: Record<string, unknown> };
      const previous = currentWorkflow as Record<string, any> | null;
      currentWorkflow = {
        ...(previous || {}),
        id: `revision-${Number(previous?.revision || 0) + 1}`,
        revision: Number(previous?.revision || 0) + 1,
        createdAt: Date.now(),
        graph: body.graph,
        compiled: previous?.compiled || { paths: [], warnings: [] },
      };
      await json(route, { workflow: currentWorkflow });
      return;
    }
    if (url.pathname === "/api/trading") {
      await json(route, {
        overview: {
          runtime: {
            executionEnabled: false,
            liveTradingEnabled: false,
            killSwitchActive: false,
            killSwitchReason: null,
          },
          accountCount: 0,
          enabledRouteCount: 0,
          openPositionCount: 0,
          pendingIntentCount: 0,
          unknownOrderCount: 0,
          latestReconciliationAt: null,
        },
        accounts: [],
        strategies: [],
        signalSchemas: [],
        signalContracts: [],
        intents: [],
        activity: { positions: [], riskEvents: [], reconciliations: [] },
        exchangeStreams: [],
      });
      return;
    }
    if (url.pathname === "/api/exchanges/catalog") {
      await json(route, {
        implementation: {
          library: "ccxt",
          version: "4.5.75",
          streaming: "ccxt-pro",
          orderAuthority: "rest",
        },
        exchanges: [],
      });
      return;
    }
    if (url.pathname === "/api/config") {
      await json(route, {
        apiId: 0,
        sourceChannels: [],
        targetChannel: "",
        xmlParsing: { enabled: false },
      });
      return;
    }
    if (url.pathname === "/api/secrets") {
      await json(route, {
        secrets: {
          telegramApiHash: secretState,
          openRouterApiKey: secretState,
          dashboardAdminToken: {
            configured: true,
            editable: true,
            source: "managed",
          },
          dashboardViewerToken: secretState,
          auditWebhookToken: secretState,
          backupOffsiteToken: secretState,
          backupEncryptionKey: secretState,
        },
      });
      return;
    }
    if (url.pathname === "/api/recovery") {
      await json(route, { active: false });
      return;
    }
    if (url.pathname === "/api/metrics-history") {
      await json(route, { history: [] });
      return;
    }
    await json(route, {});
  });
}

test("local startup unlocks the responsive workflow builder without a bearer prompt or WCAG A/AA violations", async ({
  page,
}) => {
  await mockDashboardApi(page);
  await page.goto("/");

  await expect(
    page.getByRole("main", { name: "TSX Core Workflow Builder" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Baustein$/ })).toBeVisible();
  await expect(page.getByLabel("Bearer token")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  const overflowingElements = await page
    .locator("body *")
    .evaluateAll((elements) => {
      const viewportWidth = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth <= viewportWidth) return [];
      return elements
        .filter(
          (element) =>
            element.getBoundingClientRect().right > viewportWidth + 1,
        )
        .slice(0, 10)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: element.getAttribute("class"),
          text: element.textContent?.trim().slice(0, 80),
          right: Math.round(element.getBoundingClientRect().right),
          viewportWidth,
        }));
    });
  expect(overflowingElements).toEqual([]);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("first local startup visibly generates and displays the administrator recovery token", async ({
  page,
}) => {
  await mockDashboardApi(page, true);
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Secure your dashboard" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create secure dashboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Save your recovery token" }),
  ).toBeVisible();
  await expect(page.getByTestId("recovery-token")).toHaveText(TOKEN);
  await expect(page.getByLabel("Bearer token")).toHaveCount(0);
});

test("the block library offers published resources for reuse and a separate create action", async ({
  page,
}) => {
  await mockDashboardApi(page, false, [
    {
      id: "channel-v1",
      resourceId: "channel-logical",
      version: 1,
      kind: "channel",
      name: "VIP Coinsignals",
      description: "Bestehender Kanal",
      status: "published",
      configuration: { channelId: "-1002417439383" },
      configurationSha256: "a".repeat(64),
      createdAt: 1,
      publishedAt: 1,
    },
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: /Baustein$/ }).click();
  await page.getByRole("button", { name: /Telegram-Kanal/ }).click();
  await expect(
    page.getByRole("button", { name: /Neuen Baustein erstellen/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /VIP Coinsignals/ }),
  ).toContainText("Version 1");
});

test("workflow nodes and connections render when resize callbacks are unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    class SilentResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: SilentResizeObserver,
    });
  });
  const resources = [
    {
      id: "channel-v1",
      resourceId: "channel",
      version: 1,
      kind: "channel",
      name: "Test channel",
      description: "",
      status: "published",
      configuration: { channelId: "-1001" },
      configurationSha256: "a".repeat(64),
      createdAt: 1,
      publishedAt: 1,
    },
    {
      id: "output-v1",
      resourceId: "output",
      version: 1,
      kind: "output",
      name: "Test output",
      description: "",
      status: "published",
      configuration: { mode: "audit_only" },
      configurationSha256: "b".repeat(64),
      createdAt: 1,
      publishedAt: 1,
    },
  ];
  const workflow = {
    id: "revision-1",
    revision: 1,
    createdAt: 1,
    graph: {
      schemaVersion: 1,
      nodes: [
        {
          id: "node-channel",
          kind: "channel",
          resourceVersionId: "channel-v1",
          position: { x: 0, y: 0 },
        },
        {
          id: "node-output",
          kind: "output",
          resourceVersionId: "output-v1",
          position: { x: 0, y: 0 },
        },
      ],
      edges: [{ id: "edge-1", source: "node-channel", target: "node-output" }],
    },
    compiled: {
      paths: [
        {
          id: "path-1",
          enabled: true,
          nodeIds: ["node-channel", "node-output"],
        },
      ],
      warnings: [],
    },
  };
  await mockDashboardApi(page, false, resources, workflow);
  await page.goto("/");

  await expect(page.locator(".workflow-node")).toHaveCount(2);
  await expect(page.locator(".workflow-node").first()).toBeVisible();
  await expect(page.locator(".workflow-node").last()).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(".react-flow__edge-path")).toHaveAttribute(
    "d",
    /\S+/,
  );
});

test("connections can be created from a clear block action and deleted from the selected arrow", async ({
  page,
}) => {
  const resources = [
    {
      id: "channel-v1",
      resourceId: "channel",
      version: 1,
      kind: "channel",
      name: "Connection source",
      description: "",
      status: "published",
      configuration: { channelId: "-1001" },
      configurationSha256: "a".repeat(64),
      createdAt: 1,
      publishedAt: 1,
    },
    {
      id: "output-v1",
      resourceId: "output",
      version: 1,
      kind: "output",
      name: "Connection target",
      description: "",
      status: "published",
      configuration: { mode: "audit_only" },
      configurationSha256: "b".repeat(64),
      createdAt: 1,
      publishedAt: 1,
    },
  ];
  const workflow = {
    id: "revision-1",
    revision: 1,
    createdAt: 1,
    graph: {
      schemaVersion: 1,
      nodes: [
        {
          id: "node-channel",
          kind: "channel",
          resourceVersionId: "channel-v1",
          position: { x: 0, y: 0 },
        },
        {
          id: "node-output",
          kind: "output",
          resourceVersionId: "output-v1",
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    },
    compiled: { paths: [], warnings: [] },
  };
  await mockDashboardApi(page, false, resources, workflow);
  await page.goto("/");

  await page
    .getByRole("button", { name: "Verbindung ab Connection source erstellen" })
    .click();
  await expect(
    page.getByText("Wähle rechts im Canvas oder hier ein gültiges Ziel."),
  ).toBeVisible();
  await expect(
    page.locator('.react-flow__node[data-id="node-channel"] .workflow-node'),
  ).toHaveClass(/connection-source/);
  await expect(
    page.locator('.react-flow__node[data-id="node-output"] .workflow-node'),
  ).toHaveClass(/connection-target/);

  await page
    .locator(".connection-target-list")
    .getByRole("button", { name: /Connection target/ })
    .click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  const toolbar = page.getByRole("toolbar", {
    name: "Verbindung von Connection source zu Connection target",
  });
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole("button", { name: "Verbindung löschen" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
});

test("builder dialogs expose names, trap keyboard focus and close without accessibility violations", async ({
  page,
}) => {
  await mockDashboardApi(page);
  await page.goto("/");

  const blockButton = page.getByRole("button", { name: /Baustein$/ });
  await blockButton.click();
  const library = page.getByRole("dialog", {
    name: "Was soll der Workflow als Nächstes können?",
  });
  await expect(library).toBeVisible();
  expect(
    await library.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() =>
      library.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include(".kind-picker")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(library).toBeHidden();
  await expect(blockButton).toBeFocused();

  const simulationButton = page.getByRole("button", { name: "Simulieren" });
  await simulationButton.click();
  const simulation = page.getByRole("dialog", {
    name: "Signal durch aktive Revision schicken",
  });
  await expect(simulation).toBeVisible();
  expect(
    await simulation.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() =>
      simulation.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    )
    .toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include(".simulation-modal")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(simulation).toBeHidden();
  await expect(simulationButton).toBeFocused();

  const operationsButton = page.getByRole("button", { name: "Betrieb" });
  await operationsButton.click();
  const operations = page.getByRole("dialog", { name: "Live" });
  await expect(operations).toBeVisible();
  expect(
    await operations.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() =>
      operations.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    )
    .toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include(".operations-panel")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(operations).toBeHidden();
  await expect(operationsButton).toBeFocused();
});
