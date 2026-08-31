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

import {
  historyNavigationNotice,
  upsertFlowConnection,
  workflowSelectionsAfterHistory,
  WorkflowBuilder,
} from "@/app/workflow/workflow-builder";

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

function submittedBody(url: string) {
  const call = api.apiFetch.mock.calls.find(([candidate]) => candidate === url);
  if (!call) throw new Error(`Expected request was not submitted: ${url}`);
  return JSON.parse(String((call[1] as RequestInit).body));
}

function installApi(options?: { historyFails?: boolean; applyConflict?: boolean }) {
  let workflowLoads = 0;
  let pendingResource: Record<string, unknown> | null = null;
  api.apiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/workflow") {
      workflowLoads += 1;
      return response({ workflow, resources });
    }
    if (url === "/api/workflow/resources" && init?.method === "DELETE") {
      return response({ success: true, result: { deleted: 1 } });
    }
    if (url === "/api/workflow/resources" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      pendingResource = {
        id: `${body.resourceId || "new-resource"}-v2`,
        resourceId: body.resourceId || "new-resource",
        version: 2,
        kind: body.kind,
        name: body.name,
        description: body.description,
        status: "draft",
        configuration: body.configuration,
      };
      return response({ resource: pendingResource }, 201);
    }
    if (url === "/api/workflow/resources/publish") {
      pendingResource = { ...pendingResource, status: "published" };
      return response({ resource: pendingResource });
    }
    if (url === "/api/workflow/impact") {
      return response({ impact: { destructive: false, changed: [], removed: [], confirmation: null } });
    }
    if (url === "/api/workflow/mutate") {
      const body = JSON.parse(String(init?.body));
      return response({
        workflow: { ...workflow, id: "revision-2", revision: 2, graph: body.graph },
        history,
      }, 201);
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

  it("formats history navigation notices outside the navigation callback", () => {
    expect(historyNavigationNotice("Sizing V2 aktivieren", "undo", 3)).toBe(
      "„Sizing V2 aktivieren“ rückgängig gemacht. Stand wurde als Revision 3 aktiviert.",
    );
    expect(historyNavigationNotice(null, "redo", 4)).toBe(
      "Stand wiederholt. Stand wurde als Revision 4 aktiviert.",
    );
  });

  it("preserves valid selections and removes every stale graph, path and connection reference", () => {
    expect(workflowSelectionsAfterHistory({
      selectedEdgeId: "edge-1",
      editorNodeId: "node-channel",
      selectedPathId: "path-1",
      connectionSourceId: "node-channel",
      connectionDraft: { sourceId: "node-channel", targetId: "node-output", kind: "flow" },
    }, graph, workflow.compiled.paths)).toEqual({
      selectedEdgeId: "edge-1",
      editorNodeId: "node-channel",
      selectedPathId: "path-1",
      connectionSourceId: "node-channel",
      connectionDraft: { sourceId: "node-channel", targetId: "node-output", kind: "flow" },
    });
    expect(workflowSelectionsAfterHistory({
      selectedEdgeId: "missing-edge",
      editorNodeId: "missing-node",
      selectedPathId: "missing-path",
      connectionSourceId: "missing-node",
      connectionDraft: { edgeId: "missing-edge", sourceId: "missing-node", targetId: "node-output", kind: "flow" },
    }, graph, workflow.compiled.paths)).toEqual({
      selectedEdgeId: null,
      editorNodeId: null,
      selectedPathId: null,
      connectionSourceId: null,
      connectionDraft: null,
    });
  });

  it("upserts flow connections while replacing or removing their channel scope", () => {
    const versionedGraph = {
      ...graph,
      schemaVersion: 3 as const,
      edges: [{
        ...graph.edges[0],
        kind: "flow" as const,
        channelNodeIds: ["node-channel"],
      }],
    };
    const updated = upsertFlowConnection(versionedGraph, {
      edgeId: "edge-1",
      sourceId: "node-channel",
      targetId: "node-output",
      kind: "flow",
    }, undefined, () => "unused");
    expect(updated?.edgeId).toBe("edge-1");
    expect(updated?.graph.edges[0]).not.toHaveProperty("channelNodeIds");

    const created = upsertFlowConnection(versionedGraph, {
      sourceId: "node-channel",
      targetId: "node-output",
      kind: "flow",
    }, ["node-channel"], () => "edge-2");
    expect(created?.edgeId).toBe("edge-2");
    expect(created?.graph.edges.at(-1)).toMatchObject({
      id: "edge-2",
      kind: "flow",
      channelNodeIds: ["node-channel"],
    });

    expect(upsertFlowConnection(versionedGraph, {
      edgeId: "missing-edge",
      sourceId: "node-channel",
      targetId: "node-output",
      kind: "flow",
    }, [], () => "unused")).toBeNull();
  });

  it("loads history independently and keeps the builder usable when only history fails", async () => {
    installApi({ historyFails: true });
    render(<WorkflowBuilder />);
    expect(screen.queryByRole("button", { name: /rückgängig/ })).not.toBeInTheDocument();
    await openBuilder();
    expect(screen.getByRole("button", { name: "Nichts rückgängig zu machen – 0 von 5" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Nichts zu wiederholen – 0 von 5" })).toBeDisabled();
    expect(screen.getByTestId("workflow-canvas")).toBeVisible();
  });

  it("permanently deletes an unused resource family only after explicit UI confirmation", async () => {
    installApi();
    render(<WorkflowBuilder />);
    await openBuilder();
    fireEvent.click(screen.getByRole("button", { name: /Baustein$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Telegram-Kanal/ }));
    fireEvent.click(screen.getByRole("button", { name: "VIP endgültig löschen" }));
    expect(screen.getByText(/keine historische oder aktive Workflowrevision/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ja, endgültig löschen" }));
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/workflow/resources",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "X-Destructive-Confirmation": "delete-workflow-resource-permanently",
        }),
      }),
    ));
    const deletion = api.apiFetch.mock.calls.find(([url, init]) =>
      url === "/api/workflow/resources" && (init as RequestInit)?.method === "DELETE");
    expect(JSON.parse(String((deletion?.[1] as RequestInit).body))).toEqual({
      resourceId: "channel",
      operation: "delete",
    });
    expect(await screen.findByText("VIP wurde endgültig gelöscht.")).toBeVisible();
  });

  it("refreshes the trading snapshot after a resource version is saved and activated", async () => {
    installApi();
    render(<WorkflowBuilder />);
    await openBuilder();
    if (!flow.props) throw new Error("React Flow props unavailable.");
    const channel = (flow.props.nodes as Array<any>).find((item) => item.id === "node-channel");
    act(() => flow.props?.onNodeClick({}, channel));
    fireEvent.change(await screen.findByLabelText(/Telegram-Kanal-ID/), {
      target: { value: "-1002" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Version speichern & aktivieren" }));
    await waitFor(() => {
      expect(api.apiFetch.mock.calls.filter(([url]) => url === "/api/trading")).toHaveLength(2);
    });
    expect(await screen.findByText(/Revision 2 ist aktiv/)).toBeVisible();
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
    const body = submittedBody("/api/workflow/history/apply");
    expect(body).toEqual({ direction: "undo", baseRevisionId: "revision-1", confirmation: null });
    expect(await screen.findByText(/Stand wurde als Revision 2 aktiviert/)).toBeVisible();
    expect(screen.getByText("0 Bausteine")).toBeVisible();
  });

  it("supports redo shortcuts but preserves native undo in editors and dialogs", async () => {
    installApi();
    render(<WorkflowBuilder />);
    await openBuilder();
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
    fireEvent.click(screen.getByRole("button", { name: "Baustein-Editor schließen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/workflow/history/impact", expect.objectContaining({ method: "POST" }),
    ));
    expect(submittedBody("/api/workflow/history/impact").direction).toBe("redo");
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/workflow/history/apply", expect.objectContaining({ method: "POST" }),
    ));
    api.apiFetch.mockClear();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/workflow/history/impact", expect.objectContaining({ method: "POST" }),
    ));
    expect(submittedBody("/api/workflow/history/impact").direction).toBe("redo");
  });

  it.each([
    ["Ctrl+Z", { ctrlKey: true }],
    ["Cmd+Z", { metaKey: true }],
  ])("maps %s to undo", async (_label, modifier) => {
    installApi();
    render(<WorkflowBuilder />);
    await openBuilder();
    fireEvent.keyDown(window, { key: "z", ...modifier });
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/workflow/history/impact", expect.objectContaining({ method: "POST" }),
    ));
    expect(submittedBody("/api/workflow/history/impact").direction).toBe("undo");
  });

  it("disables both history controls while an impact request is pending", async () => {
    let resolveImpact!: (value: Response) => void;
    const pendingImpact = new Promise<Response>((resolve) => { resolveImpact = resolve; });
    installApi();
    api.apiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/workflow/history/impact") return pendingImpact;
      if (url === "/api/workflow") return response({ workflow, resources });
      if (url === "/api/workflow/history") return response(history);
      if (["/api/trading", "/api/status", "/api/exchanges/catalog"].includes(url)) return response({});
      if (url === "/api/workflow/history/apply") {
        return response({ workflow, history });
      }
      return response({ request: init });
    });
    render(<WorkflowBuilder />);
    await openBuilder();
    fireEvent.click(screen.getByRole("button", { name: /rückgängig/ }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /rückgängig/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /wiederholen/ })).toBeDisabled();
    });
    resolveImpact(response({ impact: { destructive: false, changed: [], removed: [], confirmation: null } }));
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith(
      "/api/workflow/history/apply", expect.objectContaining({ method: "POST" }),
    ));
  });

  it("cleans stale selections after history navigation and reloads workflow plus history on conflict", async () => {
    const workflowLoads = installApi();
    render(<WorkflowBuilder />);
    await openBuilder();
    if (!flow.props) throw new Error("React Flow props unavailable.");
    const source = (flow.props.nodes as Array<any>).find((item) => item.id === "node-channel");
    act(() => source.data.onStartConnection("node-channel"));
    expect(await screen.findByText(/Wähle rechts im Canvas/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /rückgängig/ }));
    await waitFor(() => expect(screen.queryByText(/Wähle rechts im Canvas/)).not.toBeInTheDocument());

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
