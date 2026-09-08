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
  tradingAccounts: Array<Record<string, unknown>> = [],
) {
  let currentWorkflow = workflow;
  let revisionSequence = Number(currentWorkflow?.revision || 0);
  type HistoryEntry = { workflow: Record<string, any> | null; label: string };
  const undo: HistoryEntry[] = [];
  const redo: HistoryEntry[] = [];
  let pendingResource: Record<string, any> | null = null;
  let graphDraft: any = null;
  const historyStatus = () => ({
    limit: 5,
    undoCount: undo.length,
    redoCount: redo.length,
    canUndo: undo.length > 0,
    canRedo: redo.length > 0,
    undoLabel: undo.at(-1)?.label ?? null,
    redoLabel: redo.at(-1)?.label ?? null,
  });
  const copyWorkflow = (value: Record<string, unknown> | null) => value ? structuredClone(value) : null;
  const pushHistory = (stack: HistoryEntry[], entry: HistoryEntry) => {
    stack.push(entry);
    if (stack.length > 5) stack.shift();
  };
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/bootstrap/status") {
      await json(route, {
        required: firstRun,
        available: true,
        localSessionAvailable: !firstRun,
        bootstrapProofRequired: firstRun,
      });
      return;
    }
    if (url.pathname === "/api/bootstrap") {
      if (firstRun) expect(request.postDataJSON()).toEqual({ bootstrapProof: "b".repeat(64) });
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
    if (url.pathname === "/api/workflow/drafts") {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        if (body.baseVersion !== (graphDraft?.version ?? null)) { await json(route, { error: 'VERSION_CONFLICT' }, 409); return; }
        graphDraft = { ...body, version: (graphDraft?.version ?? 0) + 1, updatedAt: Date.now(), expired: false };
      }
      await json(route, { draft: graphDraft }); return;
    }
    if (url.pathname === "/api/workflow/objects") {
      const resource = workflowResources.find(item => item.id === url.searchParams.get('id')) ?? pendingResource;
      await json(route, { resource, publication: { publicationHash: 'browser-publication-hash', dependency: null } }); return;
    }
    if (url.pathname === "/api/workflow/history") {
      await json(route, historyStatus());
      return;
    }
    if (url.pathname === "/api/workflow/history/impact") {
      await json(route, {
        impact: { destructive: false, changed: [], removed: [], confirmation: null },
      });
      return;
    }
    if (url.pathname === "/api/workflow/history/apply") {
      const body = request.postDataJSON() as { direction: "undo" | "redo" };
      const source = body.direction === "undo" ? undo : redo;
      const destination = body.direction === "undo" ? redo : undo;
      const target = source.pop();
      if (!target) {
        await json(route, { error: `WORKFLOW_HISTORY_${body.direction.toUpperCase()}_EMPTY` }, 409);
        return;
      }
      pushHistory(destination, { workflow: copyWorkflow(currentWorkflow), label: target.label });
      revisionSequence += 1;
      currentWorkflow = target.workflow
        ? {
            ...copyWorkflow(target.workflow),
            id: `revision-${revisionSequence}`,
            revision: revisionSequence,
            createdAt: Date.now(),
          }
        : {
            id: `revision-${revisionSequence}`,
            revision: revisionSequence,
            createdAt: Date.now(),
            graph: { schemaVersion: 1, nodes: [], edges: [] },
            compiled: { paths: [], warnings: [] },
          };
      await json(route, { workflow: currentWorkflow, history: historyStatus() });
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
      const body = request.postDataJSON() as { graph: Record<string, unknown>; historyLabel?: string };
      const previous = currentWorkflow as Record<string, any> | null;
      pushHistory(undo, {
        workflow: copyWorkflow(previous),
        label: body.historyLabel || "Workflow geändert",
      });
      redo.length = 0;
      revisionSequence += 1;
      currentWorkflow = {
        ...(previous || {}),
        id: `revision-${revisionSequence}`,
        revision: revisionSequence,
        createdAt: Date.now(),
        graph: body.graph,
        compiled: previous?.compiled || { paths: [], warnings: [] },
      };
      graphDraft = { ...graphDraft, baseRevisionId: currentWorkflow.id };
      await json(route, { workflow: currentWorkflow, history: historyStatus(), draft: graphDraft });
      return;
    }
    if (url.pathname === "/api/workflow/resources" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, any>;
      const versions = workflowResources.filter((item) => item.resourceId === body.resourceId);
      const version = Math.max(0, ...versions.map((item) => Number(item.version || 0))) + 1;
      const resourceId = body.resourceId || `resource-${body.kind}`;
      pendingResource = {
        id: `${resourceId}-v${version}`,
        resourceId,
        version,
        kind: body.kind,
        name: body.name,
        description: body.description || "",
        status: "draft",
        configuration: body.configuration,
        configurationSha256: "c".repeat(64),
        createdAt: Date.now(),
        publishedAt: null,
      };
      workflowResources.push(pendingResource);
      await json(route, { resource: pendingResource }, 201);
      return;
    }
    if (url.pathname === "/api/workflow/resources/publish") {
      if (!pendingResource) {
        await json(route, { error: "No pending resource." }, 409);
        return;
      }
      pendingResource = { ...pendingResource, status: "published", publishedAt: Date.now() };
      const index = workflowResources.findIndex(item => item.id === pendingResource!.id);
      workflowResources[index] = pendingResource;
      await json(route, { resource: pendingResource });
      pendingResource = null;
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
          accountCount: tradingAccounts.length,
          enabledRouteCount: 0,
          openPositionCount: 0,
          pendingIntentCount: 0,
          unknownOrderCount: 0,
          latestReconciliationAt: null,
        },
        accounts: tradingAccounts,
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
        exchanges: [
          {
            id: "paper", name: "Paper Trading", status: "certified", reason: null,
            provider: "paper", ccxt: null, markets: { linearSwap: true },
            credentialFields: [], modes: ["paper"], capabilities: {},
          },
          {
            id: "bybit", name: "Bybit", status: "certified", reason: null,
            provider: "ccxt", ccxt: { rest: true, pro: true }, markets: { linearSwap: null },
            credentialFields: [
              { id: "apiKey", label: "API Key", required: true, secret: true },
              { id: "secret", label: "API Secret", required: true, secret: true },
            ],
            modes: ["testnet", "live"], capabilities: {},
          },
          {
            id: "okx", name: "OKX", status: "candidate", reason: null,
            provider: "ccxt", ccxt: { rest: true, pro: true }, markets: { linearSwap: true },
            credentialFields: [], modes: [], capabilities: {},
          },
          {
            id: "binance", name: "Binance", status: "discovered", reason: null,
            provider: "ccxt", ccxt: { rest: true, pro: true }, markets: { linearSwap: null },
            credentialFields: [], modes: [], capabilities: {},
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/exchanges/probe") {
      const exchange = JSON.parse(request.postData() || "{}").exchange;
      await json(route, {
        id: exchange, name: String(exchange).toUpperCase(), status: "candidate", reason: null,
        provider: "ccxt", ccxt: { rest: true, pro: true }, markets: { linearSwap: true },
        credentialFields: [], modes: [], capabilities: {},
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
      await json(route, { active: false, serverInstanceId: "browser-instance", session: { role: "admin", actorId: "browser-admin" } });
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
  await page.getByRole("navigation", { name: "Hauptbereiche" }).getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page.locator(".workflow-canvas")).toBeVisible();
  await page.locator(".workflow-canvas").scrollIntoViewIfNeeded();
}

test("local startup opens seven operator areas and the builder retains light/dark accessibility", async ({ page }, testInfo) => {
  await mockDashboardApi(page); await page.goto("/");
  await expect(page).toHaveURL(/cockpit$/); await expect(page.getByLabel("Bearer token")).toHaveCount(0);
  const navigation = page.getByRole("navigation", { name: "Hauptbereiche" });
  await expect(navigation.getByRole("link")).toHaveCount(7);
  expect(await navigation.getByRole("link").allTextContents()).toEqual(["Cockpit", "Trading", "Workflows", "Signale & Versand", "Risiko & Analyse", "Integrationen", "Betrieb & Sicherheit"]);
  await expect(navigation.getByRole("link", { name: "Cockpit", exact: true })).toHaveAttribute("aria-current", "page");
  await openBuilderWorkspace(page);
  await expect(page.getByRole("main", { name: "TSX Core Workflow Builder" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Baustein$/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const mode of ["Hellen Modus aktivieren", "Dunklen Modus aktivieren"]) {
    await page.mouse.move(1, 1);
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))); });
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.getByRole("banner").getByRole("button", { name: mode }).click();
  }
  await page.screenshot({ path: testInfo.outputPath('ui-next-builder.png'), fullPage: true });
  await page.getByRole("banner").getByRole("button", { name: "Hellen Modus aktivieren" }).click(); await page.reload();
  await expect(page.locator("html")).toHaveClass(/light/);
});

test("mobile operator navigation and account actions remain readable and fit the screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockDashboardApi(page, false, [], null, [{ id: "paper-mobile", name: "Paper Mobil", exchange: "paper", mode: "paper", status: "ready", enabled: true, maxConcurrentPositions: 8, killSwitchActive: false, lastReconciledAt: Date.now(), lastError: null }]);
  await page.goto("/");
  const mainNavigation = page.getByRole("navigation", { name: "Hauptbereiche" });
  await expect(mainNavigation.getByRole("link")).toHaveCount(7);
  expect(await mainNavigation.evaluate(navigation => {
    const outer = navigation.getBoundingClientRect();
    return navigation.scrollWidth <= navigation.clientWidth + 1 && [...navigation.querySelectorAll("a")].every(link => {
      const bounds = link.getBoundingClientRect(); return bounds.height >= 40 && bounds.left >= outer.left - 1 && bounds.right <= outer.right + 1;
    });
  })).toBe(true);
  await mainNavigation.getByRole("link", { name: "Trading", exact: true }).click();
  const operations = page.getByRole("region", { name: "Trading" });
  await expect(operations.getByText("Paper Mobil", { exact: true })).toBeVisible();
  const accountActions = operations.locator(".account-actions button"); expect(await accountActions.count()).toBeGreaterThan(0);
  expect(await accountActions.evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().height >= 40 && Number.parseFloat(getComputedStyle(button).fontSize) >= 11))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('ui-next-accounts-mobile.png'), fullPage: true });
});

test("first local startup visibly generates and displays the administrator recovery token", async ({
  page,
}) => {
  await mockDashboardApi(page, true);
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Secure your dashboard" }),
  ).toBeVisible();
  await page.getByLabel("One-time bootstrap proof").fill("b".repeat(64));
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
  await expect(
    page.getByRole("button", { name: "VIP Coinsignals dauerhaft archivieren" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "VIP Coinsignals endgültig löschen" }),
  ).toBeVisible();
});

test("parser, schema, contract and strategy are authored directly in their blocks", async ({
  page,
}) => {
  await mockDashboardApi(page);
  await page.goto("/");
  await openBuilderWorkspace(page);

  const openNew = async (kindName: string) => {
    await page.getByRole("button", { name: /Baustein$/ }).click();
    await page.getByRole("button", { name: kindName }).click();
    await page.getByRole("button", { name: /Neuen Baustein erstellen/ }).click();
  };

  await openNew("KI-Parser");
  await expect(page.getByLabel("Parser-Prompt")).toBeVisible();
  await expect(page.getByText("Prompt-Vorlage")).toHaveCount(0);
  await page.getByRole("button", { name: "Abbrechen" }).click();

  await openNew("Signal-Schema");
  await expect(page.getByLabel("Schema-ID")).toBeVisible();
  await expect(page.getByLabel("Parser-Schema")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Parserquelle aus Builder" }),
  ).toContainText("noch kein KI-Parser vorhanden");
  await expect(page.getByLabel("Richtungspfad")).toBeVisible();
  await expect(page.getByLabel("Paarpfad")).toBeVisible();
  await expect(page.getByLabel("Stop-Loss-Pfad")).toBeVisible();
  await page.getByRole("button", { name: "Abbrechen" }).click();

  await openNew("Signal-Vertrag");
  await expect(page.getByLabel("Vertrags-ID")).toBeVisible();
  await expect(page.getByLabel("Maximal Targets")).toBeVisible();
  await page.getByRole("button", { name: "Abbrechen" }).click();

  await openNew("Strategie");
  await expect(page.getByLabel("Standard-Hebel")).toBeVisible();
  await expect(page.getByLabel("Max. Slippage (%)")).toBeVisible();
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

  await expect(page.getByRole("banner").getByRole("img", { name: "TSX Core" })).toBeVisible();
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
  await expect(page.locator("html")).not.toHaveClass(/(?:^|\s)dark(?:\s|$)/);
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
  await moveSecondChannelUp.click();
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
      fallbackOn: ["SYMBOL_UNAVAILABLE", "MAX_CONCURRENT_POSITIONS", "SYMBOL_ALREADY_OWNED"],
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
      fallbackOn: [],
      nodeIds: ["c1", "parser", "a1", "a2"],
    },
  ];
  await mockDashboardApi(page, false, resources, {
    id: "revision-fallback",
    revision: 4,
    createdAt: 1,
    graph: {
      schemaVersion: 3,
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
          fallbackOn: ["SYMBOL_UNAVAILABLE", "MAX_CONCURRENT_POSITIONS", "SYMBOL_ALREADY_OWNED"],
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
          { pathId: "path-primary", accountId: "kraken", accountNodeId: "a1", rank: 0, enabled: true, fallbackOn: ["SYMBOL_UNAVAILABLE", "MAX_CONCURRENT_POSITIONS", "SYMBOL_ALREADY_OWNED"] },
          { pathId: "path-fallback", accountId: "hyper", accountNodeId: "a2", rank: 1, enabled: true, fallbackOn: [] },
        ],
      }],
      warnings: [],
    },
  });
  await page.goto("/");
  await openBuilderWorkspace(page);

  await page.getByRole("button", { name: "Pfade anzeigen (1)" }).click();
  const routeDialog = page.getByRole("dialog", { name: "Kanäle, Verarbeitung und Börsen" });
  await expect(routeDialog.getByText("Exklusive Reihenfolge: 1. Kraken zuerst (Paar · Voll · Belegt) · 2. Hyperliquid danach")).toBeVisible();
  await routeDialog.getByRole("button", { name: "Dialog schließen" }).click();
  const fallbackEdge = page.locator('.react-flow__edge[data-id="fallback-a1-a2"]');
  await expect(fallbackEdge.locator(".workflow-edge-path.is-account-fallback")).toHaveCount(1);
  await fallbackEdge.dispatchEvent("click");
  await expect(page.getByRole("dialog").getByText("Fallback-Reihenfolge", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("Nächstes Fallback für Kanal A")).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/Wechsel bei: Paar · Voll · Belegt/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Routing bearbeiten" }).click();
  await expect(page.getByRole("checkbox", { name: "Kanal A" })).toBeChecked();
  await page.getByRole("button", { name: "Routing übernehmen" }).click();
  await expect(page.getByRole("radio", { name: /Empfohlen/ })).toBeChecked();
  await page.getByRole("radio", { name: /Nur Handelspaar/ }).check();
  await page.getByRole("button", { name: "Fallback übernehmen" }).click();
  await expect(page.locator(".workflow-fallback-edge-label")).toHaveText("Paar");
  await page.getByRole("dialog").getByRole("button", { name: "Dialog schließen" }).click();
  await page.getByRole("button", { name: "Gespeicherten Graph aktivieren" }).click();
  await page.getByRole("button", { name: /„Graph aktiviert“ rückgängig machen/ }).click();
  await expect(page.locator(".workflow-fallback-edge-label")).toHaveText("Paar · Voll · Belegt");
  await page.getByRole("button", { name: /„Graph aktiviert“ wiederholen/ }).click();
  await expect(page.locator(".workflow-fallback-edge-label")).toHaveText("Paar");
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
  await expect(page.locator(".builder-notice")).toContainText("Graphentwurf 1 gespeichert");
  const connectionDialog = page.getByRole("dialog", {
    name: "Connection source → Connection target",
  });
  await expect(connectionDialog).toBeVisible();
  await connectionDialog.getByRole("button", { name: "Dialog schließen" }).click();
  await page.getByRole("button", { name: "Gespeicherten Graph aktivieren" }).click();
  await expect(page.locator(".builder-notice")).toContainText("Revision 2 ist aktiv");
  await page.getByRole("button", { name: /„Graph aktiviert“ rückgängig machen/ }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".builder-notice")).toContainText("Revision 3 aktiviert");
  await page.getByRole("button", { name: /„Graph aktiviert“ wiederholen/ }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  await expect(page.locator(".builder-notice")).toContainText("Revision 4 aktiviert");
  await page.locator(".react-flow__edge").dispatchEvent("click");
  await expect(connectionDialog).toBeVisible();
  await connectionDialog
    .getByRole("button", { name: "Verbindung löschen" })
    .click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(0);
  await expect(page.locator(".workflow-node")).toHaveCount(2);
});

test("sizing resource history restores exact default leverage versions", async ({ page }) => {
  const resources = [{
    id: "sizing-v1",
    resourceId: "sizing",
    version: 1,
    kind: "sizing",
    name: "Sizing",
    description: "Versioned sizing",
    status: "published",
    configuration: {
      positionSizingMode: "equity_percent_margin",
      riskPerTradePercent: "5",
      maxAdaptiveRiskPercent: "10",
      maxPositionNotional: "1000000",
      defaultLeverage: 3,
      maxLeverage: 50,
    },
    configurationSha256: "a".repeat(64),
    createdAt: 1,
    publishedAt: 1,
  }];
  const workflow = {
    id: "revision-1",
    revision: 1,
    createdAt: 1,
    graph: {
      schemaVersion: 1,
      nodes: [{
        id: "node-sizing",
        kind: "sizing",
        resourceVersionId: "sizing-v1",
        position: { x: 0, y: 0 },
      }],
      edges: [],
    },
    compiled: { paths: [], warnings: [] },
  };
  await mockDashboardApi(page, false, resources, workflow);
  await page.goto("/");
  await openBuilderWorkspace(page);
  const sizingNode = page.locator('.react-flow__node[data-id="node-sizing"]');
  await expect(sizingNode).toContainText("Hebel 3×/50×");
  await sizingNode.dispatchEvent("click");
  const editor = page.getByRole("dialog", { name: "Baustein bearbeiten" });
  await editor.getByLabel("Standard-Hebel").fill("7");
  await editor.getByRole("button", { name: "Ressourcen- und Graphentwurf speichern" }).click();
  await expect(sizingNode).toContainText("Hebel 7×/50×");
  await expect(page.locator(".builder-notice")).toContainText("Graphentwurf 1 gespeichert");
  await page.getByRole("button", { name: "Referenzierte Entwurfsversionen publizieren" }).click();
  await page.getByRole("button", { name: "Versionen publizieren", exact: true }).click();
  await page.getByRole("button", { name: "Gespeicherten Graph aktivieren" }).click();
  await expect(page.locator(".builder-notice")).toContainText("Revision 2 ist aktiv");
  await page.getByRole("button", { name: /„Graph aktiviert“ rückgängig machen/ }).click();
  await expect(sizingNode).toContainText("Hebel 3×/50×");
  await expect(page.locator(".builder-notice")).toContainText("Revision 3 aktiviert");
  await page.getByRole("button", { name: /„Graph aktiviert“ wiederholen/ }).click();
  await expect(sizingNode).toContainText("Hebel 7×/50×");
  await expect(page.locator(".builder-notice")).toContainText("Revision 4 aktiviert");
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

  const operationsButton = page.getByRole("link", { name: "Trading", exact: true });
  await operationsButton.click();
  const operations = page.getByRole("region", { name: "Trading" });
  await expect(operations).toBeVisible();
  await expect(operations.getByRole("heading", { name: "Zertifiziert" })).toBeVisible();
  await expect(operations.getByText("Bybit")).toBeVisible();
  await expect(operations.getByText("OKX")).toBeVisible();
  await expect(operations.getByText("Binance")).toBeVisible();
  await operations.getByRole("button", { name: "Öffentlich testen" }).first().click();
  await expect(operations.getByText(/Kompatibilitätstest abgeschlossen/)).toBeVisible();
  await operations.getByRole("button", { name: "Konto", exact: true }).click();
  await operations.getByLabel("Name").fill("Ungespeicherter Entwurf");
  await operations.getByRole("button", { name: "Abbrechen" }).click();
  await operations.getByRole("button", { name: "Konto", exact: true }).click();
  await expect(operations.getByLabel("Name")).toHaveValue("");
  await operations.getByRole("button", { name: "Abbrechen" }).click();
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-label="Trading"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(operations).toBeHidden();
});

test("reduced motion and keyboard navigation remain usable across operator areas", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" }); await mockDashboardApi(page); await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Hauptbereiche" });
  await navigation.getByRole("link", { name: "Cockpit", exact: true }).focus(); await page.keyboard.press("Tab");
  await expect(navigation.getByRole("link", { name: "Trading", exact: true })).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/trading\/accounts$/);
  expect(await navigation.getByRole("link", { name: "Workflows", exact: true }).evaluate(element => getComputedStyle(element).transitionDuration)).toBe("0s");
});


test("evidence and change-review tables retain keyboard scrolling", async ({ page }) => {
  await mockDashboardApi(page);
  await page.route("**/api/workflow/objects?**", async route => {
    const id = new URL(route.request().url()).searchParams.get("id");
    if (id) {
      await json(route, {
        resource: { id, resourceId: "keyboard-resource", name: "Keyboard evidence", kind: "parser", version: 1, status: "published", configuration: { limit: 0, enabled: false } },
        activePaths: [], observedAt: Date.now(), effect: "Read-only keyboard evidence fixture",
      });
      return;
    }
    await json(route, {
      entries: [{ id: "keyboard-version", resourceId: "keyboard-resource", name: "Keyboard evidence", kind: "parser", version: 1, status: "published", createdAt: Date.now() }],
      hasMore: false, observedAt: Date.now(),
    });
  });
  for (const [path, label] of [
    ["/workflows/resources", "Tabellenbereich: Ressourcenbibliothek"],
    ["/workflows/resources/keyboard-resource/versions/keyboard-version", "Gespeicherte Parameter dieser Quelle: Tabelleninhalt"],
  ]) {
    await page.goto(path);
    const region = page.getByRole("region", { name: label });
    await expect(region).toBeVisible();
    // Force a wide table in this fixture to exercise overflow even on desktop viewports.
    await region.locator("table").evaluate(table => { table.style.minWidth = "2400px"; });
    expect(await region.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    await region.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(region).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  }
});
