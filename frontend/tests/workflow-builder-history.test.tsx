import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  const apiFetch = vi.fn();
  const jsonRequest = vi.fn(async (url: string, init?: RequestInit) => {
    const response = await apiFetch(url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Anfrage fehlgeschlagen (${response.status}).`);
    return payload;
  });
  return { apiFetch, jsonRequest };
});
const flow = vi.hoisted(() => ({ props: null as Record<string, any> | null }));

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
  getViewportForBounds: vi.fn(),
  applyEdgeChanges: (_changes: unknown, edges: unknown) => edges,
  applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
}));

import { WorkflowBuilder } from "@/app/workflow/workflow-builder";

const graph = {
  schemaVersion: 1,
  nodes: [
    { id: "node-channel", kind: "channel", resourceVersionId: "channel-v1", position: { x: 0, y: 0 } },
    { id: "node-output", kind: "output", resourceVersionId: "output-v1", position: { x: 0, y: 0 } },
  ],
  edges: [{ id: "edge-1", source: "node-channel", target: "node-output" }],
};
const resources = [
  { id: "channel-v1", resourceId: "channel", version: 1, kind: "channel", name: "VIP", description: "", status: "published", configuration: { channelId: "-1001" } },
  { id: "output-v1", resourceId: "output", version: 1, kind: "output", name: "Ausgabe", description: "", status: "published", configuration: { mode: "audit_only" } },
];
const workflow = {
  id: "revision-1",
  revision: 1,
  createdAt: 1,
  graph,
  compiled: {
    paths: [{ id: "path-1", pathKey: "path-1", channelId: "-1001", accountId: "paper", strategyVersionId: "strategy", enabled: true, nodeIds: ["node-channel", "node-output"] }],
    warnings: [],
  },
};
const history = {
  limit: 5,
  undoCount: 1,
  redoCount: 1,
  canUndo: true,
  canRedo: true,
  undoLabel: "Verbindung entfernt",
  redoLabel: "Baustein verschoben",
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function installApi(options?: { historyFails?: boolean; applyConflict?: boolean }) {
  let workflowLoads = 0;
  api.apiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/workflow") {
      workflowLoads += 1;
      return response({ workflow, resources });
    }
    if (url === "/api/workflow/history") {
      if (options?.historyFails) return response({ error: "history unavailable" }, 503);
      return response(history);
    }
    if (["/api/trading", "/api/status", "/api/exchanges/catalog"].includes(url)) return response({});
    if (url === "/api/workflow/history/impact") {
      return response({ impact: { destructive: false, changed: [], removed: [], confirmation: null } });
    }
    if (url === "/api/workflow/history/apply") {
      if (options?.applyConflict) return response({ error: "WORKFLOW_REVISION_CONFLICT" }, 409);
      const direction = JSON.parse(String(init?.body)).direction;
      return response({
        workflow: {
          ...workflow,
          id: direction === "undo" ? "revision-2" : "revision-3",
          revision: direction === "undo" ? 2 : 3,
          graph: { schemaVersion: 1, nodes: [], edges: [] },
          compiled: { paths: [], warnings: [] },
        },
        history: { ...history, undoCount: 0, redoCount: 1, canUndo: false, redoLabel: "Verbindung entfernt" },
      });
    }
    return response({});
  });
  return () => workflowLoads;
}

async function openBuilder() {
  fireEvent.click(await screen.findByRole("tab", { name: "Builder" }));
  await waitFor(() => expect(screen.getByTestId("workflow-canvas")).toBeVisible());
}

describe("workflow builder history", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    flow.props = null;
  });

  it("loads history independently and keeps the builder usable when only history fails", async () => {
    installApi({ historyFails: true });
    render(<WorkflowBuilder />);
    await openBuilder();
    expect(screen.getByRole("button", { name: /Zurück/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Vorwärts/ })).toBeDisabled();
    expect(screen.getByTestId("workflow-canvas")).toBeVisible();
  });

  it("shows bounded counts, labels and executes undo without accepting a target revision", async () => {
    installApi();
    render(<WorkflowBuilder />);
    await openBuilder();
    const undo = screen.getByRole("button", { name: "„Verbindung entfernt“ rückgängig machen – 1 von 5" });
    const redo = screen.getByRole("button", { name: "„Baustein verschoben“ wiederholen – 1 von 5" });
    expect(undo).toHaveAttribute("title", "„Verbindung entfernt“ rückgängig machen – 1 von 5");
    expect(redo).toHaveAttribute("title", "„Baustein verschoben“ wiederholen – 1 von 5");
    fireEvent.click(undo);
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/workflow/history/apply", expect.objectContaining({ method: "POST" }),
    ));
    const applyCall = api.apiFetch.mock.calls.find(([url]) => url === "/api/workflow/history/apply");
    const body = JSON.parse(String((applyCall?.[1] as RequestInit).body));
    expect(body).toEqual({ direction: "undo", baseRevisionId: "revision-1", confirmation: null });
    expect(await screen.findByText(/Stand wurde als Revision 2 aktiviert/)).toBeVisible();
    expect(screen.getByText("0 Bausteine")).toBeVisible();
  });

  it("supports redo shortcuts but preserves native undo in editors and dialogs", async () => {
    installApi();
    render(<WorkflowBuilder />);
    await openBuilder();
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/workflow/history/impact", expect.objectContaining({ method: "POST" }),
    ));
    expect(JSON.parse(String((api.apiFetch.mock.calls.find(([url]) => url === "/api/workflow/history/impact")?.[1] as RequestInit).body)).direction).toBe("redo");

    api.apiFetch.mockClear();
    const search = screen.getByLabelText("Bausteine durchsuchen");
    fireEvent.keyDown(search, { key: "z", ctrlKey: true });
    expect(api.apiFetch).not.toHaveBeenCalledWith("/api/workflow/history/impact", expect.anything());

    if (!flow.props) throw new Error("React Flow props unavailable.");
    const node = (flow.props.nodes as Array<any>).find((item) => item.id === "node-channel");
    act(() => flow.props?.onNodeClick({}, node));
    await screen.findByRole("dialog");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "z", ctrlKey: true });
    expect(api.apiFetch).not.toHaveBeenCalledWith("/api/workflow/history/impact", expect.anything());
  });

  it("cleans stale selections after history navigation and reloads workflow plus history on conflict", async () => {
    const workflowLoads = installApi();
    render(<WorkflowBuilder />);
    await openBuilder();
    if (!flow.props) throw new Error("React Flow props unavailable.");
    act(() => flow.props?.onEdgeClick({ stopPropagation: vi.fn() }, { id: "edge-1" }));
    expect(await screen.findByRole("dialog", { name: /Verbindung/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /rückgängig/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Verbindung/ })).not.toBeInTheDocument());

    cleanup();
    vi.clearAllMocks();
    flow.props = null;
    const conflictingWorkflowLoads = installApi({ applyConflict: true });
    render(<WorkflowBuilder />);
    await openBuilder();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(conflictingWorkflowLoads()).toBeGreaterThan(1));
    expect(api.apiFetch.mock.calls.filter(([url]) => url === "/api/workflow/history").length).toBeGreaterThan(1);
    expect(await screen.findByText(/parallel geändert/)).toBeVisible();
    expect(workflowLoads()).toBeGreaterThan(0);
  });
});
