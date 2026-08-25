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

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
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
  Controls: () => null,
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
  confirmWorkflowImpact,
  WorkflowBuilder,
} from "@/app/workflow/workflow-builder";

describe("workflow builder resilience", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    flow.props = null;
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
    expect(screen.getByTestId("workflow-canvas")).toBeVisible();
    expect(screen.getByText("Noch keine aktive Revision")).toBeVisible();
  });

  it("requires the exact server-issued phrase for destructive workflow activation", () => {
    const prompt = vi.spyOn(window, "prompt");
    const impact = {
      changed: [{ channelId: "-1001", accountId: "account-1" }],
      removed: [],
      destructive: true,
      confirmation: "ACTIVATE WORKFLOW IMPACT",
    };
    prompt.mockReturnValue("yes");
    expect(confirmWorkflowImpact(impact)).toBeNull();
    prompt.mockReturnValue("ACTIVATE WORKFLOW IMPACT");
    expect(confirmWorkflowImpact(impact)).toBe("ACTIVATE WORKFLOW IMPACT");
    expect(prompt).toHaveBeenLastCalledWith(
      expect.stringContaining("Zur Bestätigung exakt eingeben"),
    );
    prompt.mockRestore();
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

  it("can recover a panned-away canvas by fitting every workflow node", async () => {
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
    await waitFor(() => expect(flow.props).not.toBeNull());
    const canvas = screen.getByTestId("workflow-canvas").parentElement;
    if (!canvas) throw new Error("Workflow canvas wrapper is missing.");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1200,
      bottom: 700,
      left: 0,
      width: 1200,
      height: 700,
      toJSON: () => ({}),
    });
    const getNodesBounds = vi.fn(() => ({
      x: 3476,
      y: 0,
      width: 276,
      height: 112,
    }));
    const setViewport = vi.fn();
    const setCenter = vi.fn();
    const initialize = flow.props?.onInit as
      | ((instance: unknown) => void)
      | undefined;
    if (!initialize) throw new Error("React Flow initialization is missing.");
    act(() => {
      initialize({
        getNodesBounds,
        setViewport,
        setCenter,
      });
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Alle Bausteine im Canvas anzeigen",
      }),
    );

    await waitFor(() =>
      expect(setViewport).toHaveBeenCalledWith(flow.viewport, {
        duration: 420,
      }),
    );
    expect(getNodesBounds).toHaveBeenCalledWith(["node-account"]);
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
    api.apiFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
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
                    graph: {
                      ...graph,
                      edges: [
                        {
                          id: "edge-new",
                          source: "node-channel",
                          target: "node-output",
                        },
                      ],
                    },
                  },
                }
              : {};
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    render(<WorkflowBuilder />);
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
    await waitFor(() =>
      expect(api.apiFetch).toHaveBeenCalledWith(
        "/api/workflow/mutate",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
