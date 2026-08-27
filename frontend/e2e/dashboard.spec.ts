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
        backup: { healthy: true, lastSuccessAt: Date.now() },
        mcp: { mode: "inactive", updatedAt: Date.now(), updatedBy: "system" },
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

async function openBuilderWorkspace(page: Page) {
  await page.getByRole("tab", { name: "Builder" }).click();
  await expect(page.locator(".workflow-canvas")).toBeVisible();
}

test("local startup unlocks the responsive workflow builder without a bearer prompt or WCAG A/AA violations", async ({
  page,
}) => {
  await mockDashboardApi(page);
  await page.goto("/");

  await expect(
    page.getByRole("main", { name: "TSX Core Workflow Builder" }),
  ).toBeVisible();
  await expect(page.getByLabel("Bearer token")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Hauptbereiche" }),
  ).toBeVisible();
  expect(
    await page
      .getByRole("navigation", { name: "Hauptbereiche" })
      .getByRole("tab")
      .allTextContents(),
  ).toEqual(["Dashboard", "Builder", "Analytics", "Betrieb"]);
  await expect(page.getByRole("tab", { name: "Dashboard" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    await page.locator(".workflow-statusbar").evaluate((statusbar) => {
      if (window.innerWidth <= 720) {
        return (
          statusbar.scrollWidth >= statusbar.clientWidth &&
          [...statusbar.children]
            .filter((child): child is HTMLElement => child instanceof HTMLElement)
            .every(
              (child) =>
                child.offsetLeft + child.offsetWidth <= statusbar.scrollWidth + 1,
            )
        );
      }
      const tools = statusbar.querySelector<HTMLElement>(
        ".workflow-status-tools",
      );
      if (!tools) return false;
      const toolsLeft = tools.getBoundingClientRect().left;
      const statusFits = [...statusbar.children]
        .filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            !child.classList.contains("workflow-status-tools") &&
            !child.classList.contains("workflow-status-skip") &&
            getComputedStyle(child).display !== "none",
        )
        .every(
          (metric) =>
            metric.getBoundingClientRect().right <= toolsLeft + 1 &&
            metric.scrollWidth <= metric.clientWidth + 1,
        );
      const toolsBox = tools.getBoundingClientRect();
      const toolsFit = [...tools.children]
        .filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            getComputedStyle(child).display !== "none",
        )
        .every((child) => {
          const box = child.getBoundingClientRect();
          return box.left >= toolsBox.left - 1 && box.right <= toolsBox.right + 1;
        });
      return statusFits && toolsFit;
    }),
  ).toBe(true);
  await openBuilderWorkspace(page);
  await expect(page.getByRole("button", { name: /Baustein$/ })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
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

  await page
    .getByRole("button", { name: "Hellen Modus aktivieren" })
    .click();
  await expect(page.locator("html")).toHaveClass(/light/);
  await page.waitForTimeout(250);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(
    page.getByRole("button", { name: "Dunklen Modus aktivieren" }),
  ).toBeVisible();
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
  await openBuilderWorkspace(page);
  await page.getByRole("button", { name: /Baustein$/ }).click();
  await page.getByRole("button", { name: /Telegram-Kanal/ }).click();
  await expect(
    page.getByRole("button", { name: /Neuen Baustein erstellen/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /VIP Coinsignals Version 1/ }),
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
  await openBuilderWorkspace(page);

  await expect(page.locator(".workflow-brand").getByRole("img", { name: "TSX Core" })).toBeVisible();
  await expect(page.locator(".workflow-node")).toHaveCount(2);
  await expect(page.locator(".workflow-node").first()).toBeVisible();
  await expect(page.locator(".workflow-node").last()).toBeVisible();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(".react-flow__edge-path")).toHaveAttribute(
    "d",
    /\S+/,
  );

  await page.getByRole("button", { name: /Baustein$/ }).click();
  await page.getByRole("button", { name: /Telegram-Kanal/ }).click();
  const library = page.getByRole("dialog", { name: "Telegram-Kanal" });
  await expect(library.getByText(/Bereits im Canvas/)).toBeVisible();
  await library.getByRole("button", { name: /Test channel/ }).first().click();
  await expect(page.locator(".workflow-node")).toHaveCount(2);
  await expect(
    page.getByText(/entspricht funktional bereits einem Baustein im Canvas/),
  ).toBeVisible();
});

test("shared processing and account branches are explicit in the route matrix and canvas focus", async ({
  page,
}) => {
  const makeResource = (
    id: string,
    kind: string,
    name: string,
    configuration: Record<string, unknown>,
  ) => ({
    id,
    resourceId: id,
    version: 1,
    kind,
    name,
    description: "",
    status: "published",
    configuration,
    configurationSha256: id.padEnd(64, "a").slice(0, 64),
    createdAt: 1,
    publishedAt: 1,
  });
  const resources = [
    makeResource("channel-a", "channel", "Kanal A", { channelId: "-1001" }),
    makeResource("channel-b", "channel", "Kanal B", { channelId: "-1002" }),
    makeResource("parser", "parser", "Gemeinsamer Parser", {
      timeoutMs: 30_000,
      templateName: "shared",
    }),
    makeResource("account-a", "account", "Konto A", { accountId: "kraken" }),
    makeResource("account-b", "account", "Konto B", { accountId: "hyper" }),
  ];
  const nodes = [
    { id: "c1", kind: "channel", resourceVersionId: "channel-a", position: { x: 0, y: 0 } },
    { id: "c2", kind: "channel", resourceVersionId: "channel-b", position: { x: 0, y: 150 } },
    { id: "parser", kind: "parser", resourceVersionId: "parser", position: { x: 0, y: 70 } },
    { id: "a1", kind: "account", resourceVersionId: "account-a", position: { x: 0, y: 0 } },
    { id: "a2", kind: "account", resourceVersionId: "account-b", position: { x: 0, y: 150 } },
  ];
  const paths = [
    { id: "c1-a1", channelId: "-1001", accountId: "kraken", strategyVersionId: "s", enabled: true, nodeIds: ["c1", "parser", "a1"] },
    { id: "c1-a2", channelId: "-1001", accountId: "hyper", strategyVersionId: "s", enabled: true, nodeIds: ["c1", "parser", "a2"] },
    { id: "c2-a1", channelId: "-1002", accountId: "kraken", strategyVersionId: "s", enabled: true, nodeIds: ["c2", "parser", "a1"] },
    { id: "c2-a2", channelId: "-1002", accountId: "hyper", strategyVersionId: "s", enabled: true, nodeIds: ["c2", "parser", "a2"] },
  ];
  await mockDashboardApi(page, false, resources, {
    id: "revision-routing",
    revision: 3,
    createdAt: 1,
    graph: {
      schemaVersion: 1,
      nodes,
      edges: [
        { id: "c1-parser", source: "c1", target: "parser" },
        { id: "c2-parser", source: "c2", target: "parser" },
        { id: "parser-a1", source: "parser", target: "a1" },
        { id: "parser-a2", source: "parser", target: "a2" },
      ],
    },
    compiled: { paths, warnings: [] },
  });
  await page.goto("/");
  await openBuilderWorkspace(page);

  await page
    .getByRole("button", { name: "Hellen Modus aktivieren" })
    .click();
  await page.waitForTimeout(250);
  expect(
    (
      await new AxeBuilder({ page })
        .include(".workflow-canvas")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(page.getByText("2 Kanäle", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("2 Konten", { exact: true }).first()).toBeVisible();
  const firstChannel = page.locator('.react-flow__node[data-id="c1"]');
  const secondChannel = page.locator('.react-flow__node[data-id="c2"]');
  const firstBefore = await firstChannel.boundingBox();
  const secondBefore = await secondChannel.boundingBox();
  expect(firstBefore?.y).toBeLessThan(secondBefore?.y || 0);
  await secondChannel.locator(".workflow-node").hover();
  const moveSecondChannelUp = page.getByRole("button", {
    name: "Kanal B nach oben verschieben",
  });
  await expect(moveSecondChannelUp).toBeVisible();
  await moveSecondChannelUp.click({ force: true });
  await expect
    .poll(async () =>
      ((await secondChannel.boundingBox())?.y || 0) <
      ((await firstChannel.boundingBox())?.y || 0),
    )
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "Kanal A mit der Maus verschieben" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Pfade anzeigen (4)" }).click();
  const overview = page.getByRole("dialog", {
    name: "Kanäle, Verarbeitung und Börsen",
  });
  await expect(overview).toBeVisible();
  await expect(
    overview.getByText("Vollständige Verteilung: 2 Kanäle × 2 Konten"),
  ).toBeVisible();
  await expect(
    overview.getByRole("button", { name: /hervorheben/ }),
  ).toHaveCount(4);
  await overview.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  expect(
    (
      await new AxeBuilder({ page })
        .include(".route-overview-panel")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await overview
    .getByRole("button", { name: "Kanal A auf Konto A hervorheben" })
    .click();

  await expect(overview).toBeHidden();
  await expect(page.getByText("Kanal A → Konto A")).toBeVisible();
  await expect(page.locator(".workflow-node.path-active")).toHaveCount(3);
  await expect(page.locator(".workflow-node.path-dimmed")).toHaveCount(2);
});

test("ordered account fallback is one exclusive route with a dedicated arrow and inspector", async ({
  page,
}) => {
  const resource = (
    id: string,
    kind: string,
    name: string,
    configuration: Record<string, unknown>,
  ) => ({
    id,
    resourceId: id,
    version: 1,
    kind,
    name,
    description: "",
    status: "published",
    configuration,
    configurationSha256: id.padEnd(64, "a").slice(0, 64),
    createdAt: 1,
    publishedAt: 1,
  });
  const resources = [
    resource("channel-a", "channel", "Kanal A", { channelId: "-1001" }),
    resource("parser", "parser", "Parser A", { timeoutMs: 120_000, templateName: "default" }),
    resource("account-a", "account", "Kraken zuerst", { accountId: "kraken" }),
    resource("account-b", "account", "Hyperliquid danach", { accountId: "hyper" }),
  ];
  const paths = [
    {
      id: "path-primary",
      routeGroupKey: "fallback-group-a",
      fallbackRank: 0,
      channelId: "-1001",
      accountId: "kraken",
      strategyVersionId: "strategy-a",
      enabled: true,
      nodeIds: ["c1", "parser", "a1"],
    },
    {
      id: "path-fallback",
      routeGroupKey: "fallback-group-a",
      fallbackRank: 1,
      channelId: "-1001",
      accountId: "hyper",
      strategyVersionId: "strategy-a",
      enabled: true,
      nodeIds: ["c1", "parser", "a1", "a2"],
    },
  ];
  await mockDashboardApi(page, false, resources, {
    id: "revision-fallback",
    revision: 4,
    createdAt: 1,
    graph: {
      schemaVersion: 2,
      nodes: [
        { id: "c1", kind: "channel", resourceVersionId: "channel-a", position: { x: 0, y: 0 } },
        { id: "parser", kind: "parser", resourceVersionId: "parser", position: { x: 0, y: 0 } },
        { id: "a1", kind: "account", resourceVersionId: "account-a", position: { x: 0, y: 0 } },
        { id: "a2", kind: "account", resourceVersionId: "account-b", position: { x: 0, y: 150 } },
      ],
      edges: [
        { id: "c1-parser", kind: "flow", source: "c1", target: "parser" },
        { id: "parser-a1", kind: "flow", source: "parser", target: "a1" },
        {
          id: "fallback-a1-a2",
          kind: "account_fallback",
          source: "a1",
          target: "a2",
          channelNodeIds: ["c1"],
        },
      ],
    },
    compiled: {
      paths,
      routeGroups: [{
        key: "fallback-group-a",
        channelId: "-1001",
        channelNodeId: "c1",
        primaryPathId: "path-primary",
        candidates: [
          { pathId: "path-primary", accountId: "kraken", accountNodeId: "a1", rank: 0, enabled: true },
          { pathId: "path-fallback", accountId: "hyper", accountNodeId: "a2", rank: 1, enabled: true },
        ],
      }],
      warnings: [],
    },
  });
  await page.goto("/");
  await openBuilderWorkspace(page);

  await page.getByRole("button", { name: "Pfade anzeigen (1)" }).click();
  const routeDialog = page.getByRole("dialog", { name: "Kanäle, Verarbeitung und Börsen" });
  await expect(routeDialog.getByText("Exklusive Reihenfolge: 1. Kraken zuerst · 2. Hyperliquid danach")).toBeVisible();
  await routeDialog.getByRole("button", { name: "Dialog schließen" }).click();
  const fallbackEdge = page.locator('.react-flow__edge[data-id="fallback-a1-a2"]');
  await expect(fallbackEdge.locator(".workflow-edge-path.is-account-fallback")).toHaveCount(1);
  await fallbackEdge.dispatchEvent("click");
  await expect(page.getByRole("dialog").getByText("Fallback-Reihenfolge", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Nächstes Fallback für Kanal A")).toBeVisible();
});

test("a late-column block is brought into view and the canvas can always be reframed", async ({
  page,
}) => {
  const resources = [
    {
      id: "channel-v1",
      resourceId: "channel",
      version: 1,
      kind: "channel",
      name: "First channel",
      description: "",
      status: "published",
      configuration: { channelId: "-1001" },
      configurationSha256: "b".repeat(64),
      createdAt: 1,
      publishedAt: 1,
    },
    {
      id: "account-v1",
      resourceId: "account",
      version: 1,
      kind: "account",
      name: "Far-away account",
      description: "",
      status: "published",
      configuration: { accountId: "account-1" },
      configurationSha256: "a".repeat(64),
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
          id: "node-account",
          kind: "account",
          resourceVersionId: "account-v1",
          position: { x: 3476, y: 0 },
        },
      ],
      edges: [],
    },
    compiled: { paths: [], warnings: [] },
  };
  await mockDashboardApi(page, false, resources, workflow);
  await page.goto("/");
  await openBuilderWorkspace(page);

  const firstNode = page.locator(
    '.react-flow__node[data-id="node-channel"]',
  );
  const lastNode = page.locator('.react-flow__node[data-id="node-account"]');
  await expect(firstNode).toBeVisible();
  await expect
    .poll(async () => {
      const box = await firstNode.boundingBox();
      return Boolean(
        box &&
          box.x < page.viewportSize()!.width &&
          box.x + box.width > 0 &&
          box.y < page.viewportSize()!.height &&
          box.y + box.height > 0,
      );
    })
    .toBe(true);

  await expect(
    page.getByRole("button", { name: "Alle Bausteine im Canvas anzeigen" }),
  ).toHaveCount(0);
  await expect(page.getByText("Execution Workflow")).toHaveCount(0);
  await expect(page.getByText("Visueller Builder")).toHaveCount(0);
  if ((page.viewportSize()?.width || 0) > 1380) {
    await expect(page.getByLabel("Bausteine durchsuchen")).toBeVisible();
  } else {
    await expect(page.getByLabel("Bausteine durchsuchen")).toBeHidden();
  }
  await expect(page.getByText("Alle Verbindungen lösen")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fit View" })).toHaveCount(1);
  const viewport = page.locator(".react-flow__viewport");
  const deterministicViewport = await viewport.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await viewport.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let remainingFrames = 6;
        const observeFrame = () => {
          remainingFrames -= 1;
          if (remainingFrames === 0) resolve();
          else requestAnimationFrame(observeFrame);
        };
        requestAnimationFrame(observeFrame);
      }),
  );
  expect(
    await viewport.evaluate((element) => getComputedStyle(element).transform),
  ).toBe(deterministicViewport);
  await page.getByRole("button", { name: "Fit View" }).click();
  await expect
    .poll(async () => {
      const boxes = await Promise.all([
        firstNode.boundingBox(),
        lastNode.boundingBox(),
      ]);
      return boxes.every(
        (box) =>
          box &&
          box.x < page.viewportSize()!.width &&
          box.x + box.width > 0 &&
          box.y < page.viewportSize()!.height &&
          box.y + box.height > 0,
      );
    })
    .toBe(true);
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
  await openBuilderWorkspace(page);

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
  const connectionDialog = page.getByRole("dialog", {
    name: "Connection source → Connection target",
  });
  await expect(connectionDialog).toBeVisible();
  await connectionDialog
    .getByRole("button", { name: "Verbindung löschen" })
    .click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".workflow-node")).toHaveCount(2);
});

test("builder dialogs expose names, trap keyboard focus and close without accessibility violations", async ({
  page,
}) => {
  await mockDashboardApi(page);
  await page.goto("/");
  await openBuilderWorkspace(page);

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

  const operationsButton = page.getByRole("tab", { name: "Betrieb" });
  await operationsButton.click();
  const operations = page.getByRole("region", { name: "Betrieb" });
  await expect(operations).toBeVisible();
  await operations.getByRole("button", { name: "Konto" }).click();
  await operations.getByLabel("Name").fill("Ungespeicherter Entwurf");
  await operations.getByRole("button", { name: "Abbrechen" }).click();
  await operations.getByRole("button", { name: "Konto" }).click();
  await expect(operations.getByLabel("Name")).toHaveValue("");
  await operations.getByRole("button", { name: "Abbrechen" }).click();
  expect(
    (
      await new AxeBuilder({ page })
        .include(".operations-workspace")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("tab", { name: "Builder" }).click();
  await expect(operations).toBeHidden();
});

test("reduced motion disables navigation transitions and keyboard navigation remains usable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDashboardApi(page);
  await page.goto("/");

  const dashboardTab = page.getByRole("tab", { name: "Dashboard" });
  await dashboardTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Builder" })).toBeFocused();
  const underlineTransition = await page
    .getByRole("tab", { name: "Builder" })
    .evaluate((element) => getComputedStyle(element, "::after").transitionDuration);
  expect(underlineTransition).toBe("0s");
});
