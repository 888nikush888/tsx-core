import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  const apiFetch = vi.fn()
  const jsonRequest = vi.fn(async (url: string, init?: RequestInit) => {
    const res = await apiFetch(url, init)
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(payload.error || `Anfrage fehlgeschlagen (${res.status}).`)
    return payload
  })
  return { apiFetch, jsonRequest }
});
const flow = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  viewport: { x: 10, y: 20, zoom: 0.5 },
}));
vi.mock("@/lib/api", () => api);
vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children, ...props }: { children?: ReactNode }) => {
    flow.props = props;
    return <div data-testid="workflow-canvas">{children}</div>;
  },
  Background: () => null,
  Controls: () => <button type="button" aria-label="Fit View" />,
  MiniMap: () => null,
  Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Position: { Left: "left", Right: "right" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  BackgroundVariant: { Dots: "dots" },
  getViewportForBounds: vi.fn(() => flow.viewport),
  applyEdgeChanges: (_changes: unknown, edges: unknown) => edges,
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
}));

import {
  workflowImpactDescription,
  workflowResourceSummary,
  WorkflowBuilder,
} from "@/app/workflow/workflow-builder";

async function openBuilderWorkspace() {
  fireEvent.click(await screen.findByRole("tab", { name: "Builder" }));
  await waitFor(() => expect(screen.getByTestId("workflow-canvas")).toBeVisible());
}

describe("workflow builder resilience", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    flow.props = null;
  });

  it("summarizes sizing leverage as default and maximum with legacy fallback", () => {
    const base = {
      id: "sizing-v1", resourceId: "sizing", version: 1, kind: "sizing", name: "Sizing", description: "",
      status: "published", configuration: { riskPerTradePercent: "5", maxAdaptiveRiskPercent: "10", defaultLeverage: 3, maxLeverage: 10 },
      configurationSha256: "a".repeat(64), createdAt: 1, publishedAt: 1,
    } as any;
    expect(workflowResourceSummary(base, null)).toContain("Hebel 3×/10×");
    expect(workflowResourceSummary({ ...base, configuration: { ...base.configuration, defaultLeverage: undefined } }, null))
      .toContain("Hebel 10×/10×");
  });

  it("stays visible when an older or partially unavailable API omits optional collections", async () => {
    api.apiFetch.mockResolvedValue(
      new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<WorkflowBuilder />);
    await waitFor(() =>
      expect(
        screen.getByRole("main", { name: "TSX Core Workflow Builder" }),
      ).toBeVisible(),
    );
    expect(screen.getByRole("tab", { name: "Dashboard" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await openBuilderWorkspace();
    expect(screen.getByTestId("workflow-canvas")).toBeVisible();
    expect(screen.getByText("Noch keine aktive Revision")).toBeVisible();
  });

  it("describes every server-reported destructive workflow impact", () => {
    const impact = {
      changed: [{ channelId: "-1001", accountId: "account-1" }],
      removed: [],
      destructive: true,
      confirmation: "ACTIVATE WORKFLOW IMPACT",
    };
    expect(workflowImpactDescription(impact)).toContain("1 Pfad(e) werden geändert");
    expect(workflowImpactDescription(impact)).toContain("-1001 → account-1");
  });

  it("provides initial dimensions so nodes remain renderable before browser measurement callbacks", async () => {
    api.apiFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload =
        url === "/api/workflow"
          ? {
              workflow: {
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
                  ],
                  edges: [],
                },
                compiled: { paths: [], warnings: [] },
              },
              resources: [
                {
                  id: "channel-v1",
                  resourceId: "channel",
                  version: 1,
                  kind: "channel",
                  name: "Test channel",
                  status: "published",
                  configuration: { channelId: "-1001" },
                },
              ],
            }
          : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(<WorkflowBuilder />);
    await openBuilderWorkspace();
    await waitFor(() => expect(flow.props).not.toBeNull());
    const nodes = flow.props?.nodes as Array<Record<string, unknown>>;
    const header = nodes.find((node) => node.id === "__column_channel");
    const workflowNode = nodes.find((node) => node.id === "node-channel");
    expect(header).toMatchObject({ initialWidth: 276, initialHeight: 27 });
    expect(workflowNode).toMatchObject({
      initialWidth: 276,
      initialHeight: 112,
      handles: [
        {
          type: "source",
          position: "right",
          x: 270,
          y: 50,
          width: 12,
          height: 12,
        },
      ],
    });
  });

  it("keeps only React Flow's single fit-view control", async () => {
    api.apiFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const payload =
        String(input) === "/api/workflow"
          ? {
              workflow: {
                id: "revision-1",
                revision: 1,
                createdAt: 1,
                graph: {
                  schemaVersion: 1,
                  nodes: [
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
              },
              resources: [
                {
                  id: "account-v1",
                  resourceId: "account",
                  version: 1,
                  kind: "account",
                  name: "Remote account",
                  status: "published",
                  configuration: { accountId: "account-1" },
                },
              ],
            }
          : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(<WorkflowBuilder />);
    await openBuilderWorkspace();
    await waitFor(() => expect(flow.props).not.toBeNull());
    expect(
      screen.queryByRole("button", {
        name: "Alle Bausteine im Canvas anzeigen",
      }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fit View" })).toHaveLength(1);
  });

  it("guides a connection from a source block to only valid later targets", async () => {
    const graph = {
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
    };
    const workflow = {
      id: "revision-1",
      revision: 1,
      createdAt: 1,
      graph,
      compiled: { paths: [], warnings: [] },
    };
    api.apiFetch.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const requestedGraph =
        url === "/api/workflow/mutate" && typeof init?.body === "string"
          ? JSON.parse(init.body).graph
          : null;
      const payload =
        url === "/api/workflow"
          ? {
              workflow,
              resources: [
                {
                  id: "channel-v1",
                  resourceId: "channel",
                  version: 1,
                  kind: "channel",
                  name: "Test channel",
                  status: "published",
                  configuration: { channelId: "-1001" },
                },
                {
                  id: "output-v1",
                  resourceId: "output",
                  version: 1,
                  kind: "output",
                  name: "Test output",
                  status: "published",
                  configuration: { mode: "audit_only" },
                },
              ],
            }
          : url === "/api/workflow/impact"
            ? { impact: { destructive: false, changed: [], removed: [] } }
            : url === "/api/workflow/mutate"
              ? {
                  workflow: {
                    ...workflow,
                    id: "revision-2",
                    revision: 2,
                    graph: requestedGraph,
                  },
                }
              : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      },
    );

    render(<WorkflowBuilder />);
    await openBuilderWorkspace();
    await waitFor(() => expect(flow.props).not.toBeNull());
    if (!flow.props) throw new Error("React Flow props were not captured.");
    const source = (flow.props.nodes as Array<any>).find(
      (node) => node.id === "node-channel",
    );
    if (!source) throw new Error("Connection source was not rendered.");
    act(() => source.data.onStartConnection("node-channel"));

    await waitFor(() => {
      const nodes = flow.props?.nodes as Array<any>;
      expect(
        nodes.find((node) => node.id === "node-channel").data.connectionState,
      ).toBe("source");
      expect(
        nodes.find((node) => node.id === "node-output").data.connectionState,
      ).toBe("target");
    });
    expect(
      screen.getByText("Wähle rechts im Canvas oder hier ein gültiges Ziel."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Test output/ }));
    expect(
      await screen.findByRole("heading", { name: /Test channel.*Test output/ }),
    ).toBeVisible();
    expect(
      screen.queryByText("Alle Kanäle weiterleiten"),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.apiFetch).toHaveBeenCalledWith(
        "/api/workflow/mutate",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("creates a channel-scoped ordered fallback edge between account blocks", async () => {
    const graph = {
      schemaVersion: 1,
      nodes: [
        {
          id: "node-channel",
          kind: "channel",
          resourceVersionId: "channel-v1",
          position: { x: 0, y: 0 },
        },
        {
          id: "node-primary",
          kind: "account",
          resourceVersionId: "account-primary-v1",
          position: { x: 0, y: 0 },
        },
        {
          id: "node-fallback",
          kind: "account",
          resourceVersionId: "account-fallback-v1",
          position: { x: 0, y: 180 },
        },
      ],
      edges: [
        {
          id: "edge-primary",
          source: "node-channel",
          target: "node-primary",
          channelNodeIds: ["node-channel"],
        },
      ],
    };
    const workflow = {
      id: "revision-1",
      revision: 1,
      createdAt: 1,
      graph,
      compiled: { paths: [], warnings: [] },
    };
    api.apiFetch.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const requestedGraph =
          url === "/api/workflow/mutate" && typeof init?.body === "string"
            ? JSON.parse(init.body).graph
            : null;
        const payload =
          url === "/api/workflow"
            ? {
                workflow,
                resources: [
                  {
                    id: "channel-v1",
                    resourceId: "channel",
                    version: 1,
                    kind: "channel",
                    name: "Kanal A",
                    status: "published",
                    configuration: { channelId: "-1001" },
                  },
                  {
                    id: "account-primary-v1",
                    resourceId: "account-primary",
                    version: 1,
                    kind: "account",
                    name: "Kraken zuerst",
                    status: "published",
                    configuration: { accountId: "account-primary" },
                  },
                  {
                    id: "account-fallback-v1",
                    resourceId: "account-fallback",
                    version: 1,
                    kind: "account",
                    name: "Hyperliquid danach",
                    status: "published",
                    configuration: { accountId: "account-fallback" },
                  },
                ],
              }
            : url === "/api/workflow/impact"
              ? { impact: { destructive: false, changed: [], removed: [] } }
              : url === "/api/workflow/mutate"
                ? {
                    workflow: {
                      ...workflow,
                      id: "revision-2",
                      revision: 2,
                      graph: requestedGraph,
                    },
                  }
                : {};
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    render(<WorkflowBuilder />);
    await openBuilderWorkspace();
    await waitFor(() => expect(flow.props).not.toBeNull());
    if (!flow.props) throw new Error("React Flow props were not captured.");
    const primary = (flow.props.nodes as Array<any>).find(
      (node) => node.id === "node-primary",
    );
    act(() => primary.data.onStartConnection("node-primary", "account_fallback"));

    await waitFor(() => {
      const nodes = flow.props?.nodes as Array<any>;
      expect(
        nodes.find((node) => node.id === "node-fallback").data.connectionState,
      ).toBe("target");
    });
    expect(
      screen.getByText("Wähle das nächste Konto der exklusiven Fallback-Reihenfolge."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Hyperliquid danach/ }));
    expect(await screen.findByRole("heading", { name: "Kraken zuerst → Hyperliquid danach" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /Empfohlen/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Fallback übernehmen" }));

    await waitFor(() =>
      expect(api.apiFetch).toHaveBeenCalledWith(
        "/api/workflow/mutate",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const mutateCall = api.apiFetch.mock.calls.find(
      ([url]) => url === "/api/workflow/mutate",
    );
    if (!mutateCall) throw new Error("Workflow mutation was not submitted.");
    const submitted = JSON.parse((mutateCall[1] as RequestInit).body as string).graph;
    const submittedRequest = JSON.parse((mutateCall[1] as RequestInit).body as string);
    expect(submittedRequest.historyLabel).toBe("Fallback-Verbindung aktiviert");
    expect(submittedRequest.historyMode).toBeUndefined();
    expect(submitted.schemaVersion).toBe(3);
    expect(submitted.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edge-primary",
          kind: "flow",
        }),
        expect.objectContaining({
          source: "node-primary",
          target: "node-fallback",
          kind: "account_fallback",
          channelNodeIds: ["node-channel"],
          fallbackOn: [
            "SYMBOL_UNAVAILABLE",
            "MAX_CONCURRENT_POSITIONS",
            "SYMBOL_ALREADY_OWNED",
          ],
        }),
      ]),
    );
  });
});
