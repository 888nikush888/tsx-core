import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { HandleProps, NodeProps } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowNode, type WorkflowNodeData } from "@/app/workflow/workflow-node";

// React Flow owns handle registration and geometry. Keep the real node and UI
// controls, exposing only the handle contract passed to that external canvas.
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  Handle: ({ id, type, position, className, isConnectable = true }: HandleProps) => (
    <span data-testid={id} data-handle-type={type} data-position={position}
      data-connectable={String(isConnectable)} className={className} />
  ),
}));

afterEach(cleanup);

function nodeData(overrides: Partial<WorkflowNodeData> = {}): WorkflowNodeData {
  return {
    kind: "parser", name: "Signal lesen", summary: "Nachrichten analysieren", version: 7,
    enabled: true, incomingConnections: 0, outgoingConnections: 0,
    routeUsage: { pathCount: 0, channelCount: 0, accountCount: 0, resourceInstanceCount: 1, routeIds: [] },
    pathFocusState: "idle", connectionState: "idle", onEdit: vi.fn(),
    onStartConnection: vi.fn(), onCompleteConnection: vi.fn(), onCancelConnection: vi.fn(), onMove: vi.fn(),
    ...overrides,
  };
}

function nodeProps(data: WorkflowNodeData, selected = false): NodeProps {
  return { id: "parser-7", data, selected, type: "workflow", dragging: false,
    isConnectable: true, draggable: true, selectable: true, deletable: true,
    zIndex: 0, positionAbsoluteX: 0, positionAbsoluteY: 0 };
}

function mountNode(data = nodeData(), selected = false) {
  const onCanvasClick = vi.fn();
  const result = render(<div onClick={onCanvasClick}><WorkflowNode {...nodeProps(data, selected)} /></div>);
  return { ...result, data, onCanvasClick };
}

describe("workflow node interactions", () => {
  it("edits and reorders the identified node without activating the surrounding canvas", () => {
    const { data, onCanvasClick } = mountNode();
    expect(screen.getByText("Nachrichten analysieren")).toBeVisible();
    expect(screen.getByText("v7")).toBeVisible();
    expect(screen.queryByLabelText(/eingehende und/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "KI-Parser Signal lesen bearbeiten" }));
    fireEvent.click(screen.getByRole("button", { name: "Signal lesen nach oben verschieben" }));
    fireEvent.click(screen.getByRole("button", { name: "Signal lesen nach unten verschieben" }));
    expect(data.onEdit).toHaveBeenCalledExactlyOnceWith("parser-7");
    expect(vi.mocked(data.onMove).mock.calls).toEqual([["parser-7", "up"], ["parser-7", "down"]]);
    expect(onCanvasClick).not.toHaveBeenCalled();
  });

  it("offers an accessible destination and completes the pending connection instead of editing", () => {
    const { data, onCanvasClick } = mountNode(nodeData({ kind: "account", connectionState: "target" }));
    expect(screen.getByText("Hier verbinden")).toBeVisible();
    expect(screen.queryByText("Nachrichten analysieren")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Signal lesen als Verbindungsziel auswählen" }));
    expect(data.onCompleteConnection).toHaveBeenCalledExactlyOnceWith("parser-7");
    expect(data.onEdit).not.toHaveBeenCalled();
    expect(onCanvasClick).not.toHaveBeenCalled();
    for (const handle of ["flow-target", "fallback-target"]) {
      expect(screen.getByTestId(handle)).toHaveClass("is-ready");
      expect(screen.getByTestId(handle)).toHaveAttribute("data-connectable", "true");
    }
  });

  it.each(["source", "blocked"] as const)("does not edit a %s node during connection selection", (connectionState) => {
    const { data, container } = mountNode(nodeData({ connectionState }));
    fireEvent.click(screen.getByRole("button", { name: "KI-Parser Signal lesen bearbeiten" }));
    expect(data.onEdit).not.toHaveBeenCalled();
    expect(data.onCompleteConnection).not.toHaveBeenCalled();
    expect(container.querySelector(".workflow-node")).toHaveAttribute("data-connection-state", connectionState);
    expect(screen.getByTestId("flow-target")).toHaveAttribute("data-connectable", String(connectionState !== "blocked"));
    expect(screen.getByTestId("flow-target")).not.toHaveClass("is-ready");
  });

  it("starts normal and fallback connections from an account without selecting the canvas", () => {
    const { data, onCanvasClick } = mountNode(nodeData({ kind: "account" }));
    fireEvent.click(screen.getByRole("button", { name: "Verbindung ab Signal lesen erstellen" }));
    fireEvent.click(screen.getByRole("button", { name: "Fallback-Konto nach Signal lesen festlegen" }));
    expect(vi.mocked(data.onStartConnection).mock.calls).toEqual([["parser-7"], ["parser-7", "account_fallback"]]);
    expect(data.onCancelConnection).not.toHaveBeenCalled();
    expect(onCanvasClick).not.toHaveBeenCalled();
    expect(screen.getByTestId("fallback-target")).toHaveAttribute("data-position", "top");
    expect(screen.getByTestId("fallback-source")).toHaveAttribute("data-position", "bottom");
  });

  it("cancels connection selection through either source control", () => {
    const { data, onCanvasClick } = mountNode(nodeData({ kind: "account", connectionState: "source" }));
    fireEvent.click(screen.getByRole("button", { name: "Verbindungsauswahl schließen" }));
    fireEvent.click(screen.getByRole("button", { name: "Fallback-Konto nach Signal lesen festlegen" }));
    expect(data.onCancelConnection).toHaveBeenCalledTimes(2);
    expect(data.onStartConnection).not.toHaveBeenCalled();
    expect(onCanvasClick).not.toHaveBeenCalled();
  });

  it("prevents both incoming account handle types from accepting blocked connections", () => {
    mountNode(nodeData({ kind: "account", connectionState: "blocked" }));
    for (const handle of ["flow-target", "fallback-target"]) {
      expect(screen.getByTestId(handle)).toHaveAttribute("data-connectable", "false");
      expect(screen.getByTestId(handle)).not.toHaveClass("is-ready");
    }
  });

  it("exposes only outbound handles for channels and only inbound handles for outputs", () => {
    const { rerender } = mountNode(nodeData({ kind: "channel" }));
    expect(screen.queryByTestId("flow-target")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fallback-target")).not.toBeInTheDocument();
    expect(screen.queryByTestId("fallback-source")).not.toBeInTheDocument();
    expect(screen.getByTestId("flow-source")).toHaveAttribute("data-position", "right");
    rerender(<WorkflowNode {...nodeProps(nodeData({ kind: "output" }))} />);
    expect(screen.getByTestId("flow-target")).toHaveAttribute("data-position", "left");
    expect(screen.queryByTestId("flow-source")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verbindung ab/ })).not.toBeInTheDocument();
  });
});

describe("workflow node status and routing", () => {
  it("renders selected, disabled and focused state together with warning and connection counts", () => {
    const { container } = mountNode(nodeData({ enabled: false, pathFocusState: "active",
      warning: "Konto fehlt", incomingConnections: 2, outgoingConnections: 3 }), true);
    const card = container.querySelector(".workflow-node");
    expect(card).toHaveClass("is-selected", "is-inert", "path-active", "connection-idle");
    expect(card).toHaveAttribute("data-path-state", "active");
    expect(screen.getByTitle("Konto fehlt")).toHaveTextContent("!");
    expect(screen.getByLabelText("2 eingehende und 3 ausgehende Verbindungen")).toHaveTextContent("2·3");
  });

  it("keeps outgoing-only counts visible and hides an absent warning on an enabled dimmed node", () => {
    const { container } = mountNode(nodeData({ outgoingConnections: 1, pathFocusState: "dimmed" }));
    expect(screen.getByLabelText("0 eingehende und 1 ausgehende Verbindungen")).toHaveTextContent("0·1");
    expect(container.querySelector(".workflow-node")).toHaveClass("path-dimmed");
    expect(container.querySelector(".workflow-node")).not.toHaveClass("is-selected", "is-inert");
    expect(container.querySelector(".workflow-node-warning")).toBeNull();
  });

  it.each([0, 1, 3])("displays the correct path badge for %i compiled paths", (pathCount) => {
    const data = nodeData();
    data.routeUsage = { ...data.routeUsage, channelCount: 1, accountCount: 1, pathCount };
    mountNode(data);
    if (pathCount === 0) expect(screen.queryByTitle("Kompilierter Ausführungspfad")).not.toBeInTheDocument();
    else expect(screen.getByTitle("Kompilierter Ausführungspfad")).toHaveTextContent(pathCount === 1 ? "1 Pfad" : "3 Pfade");
    expect(screen.queryByText(/Kanäle|Konten|Doppelt/)).not.toBeInTheDocument();
  });

  it.each([[2, 1], [1, 3], [2, 3]])("shows convergence and branching instead of path counts for %i channels and %i accounts", (channelCount, accountCount) => {
    const data = nodeData();
    data.routeUsage = { ...data.routeUsage, channelCount, accountCount, pathCount: 6, resourceInstanceCount: 2 };
    mountNode(data);
    expect(screen.queryByTitle("Kompilierter Ausführungspfad")).not.toBeInTheDocument();
    if (channelCount > 1) expect(screen.getByTitle("2 Kanäle laufen hier zusammen")).toHaveTextContent("2 Kanäle");
    else expect(screen.queryByText(/Kanäle/)).not.toBeInTheDocument();
    if (accountCount > 1) expect(screen.getByTitle("Dieser Baustein führt zu 3 Konten")).toHaveTextContent("3 Konten");
    else expect(screen.queryByText(/Konten/)).not.toBeInTheDocument();
    expect(screen.getByTitle("Altbestand: derselbe Baustein ist 2-mal platziert und sollte zusammengeführt werden")).toHaveTextContent("Doppelt ×2");
  });
});
