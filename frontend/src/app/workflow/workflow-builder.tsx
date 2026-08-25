import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type OnNodeDrag,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  Activity,
  AlertTriangle,
  Check,
  FlaskConical,
  Link2,
  Maximize2,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ThemeToggle } from "@/components/theme-toggle";
import { OperationsPanel } from "./operations-panel";
import { RouteOverview } from "./route-overview";
import { ResourceEditor } from "./resource-editor";
import {
  COLUMN_GAP,
  KIND_META,
  WORKFLOW_KINDS,
  type ExchangeCatalog,
  type TradingSnapshot,
  type WorkflowGraph,
  type WorkflowKind,
  type WorkflowResource,
  type WorkflowSnapshot,
} from "./types";
import {
  ColumnHeaderNode,
  WorkflowNode,
  type WorkflowNodeData,
} from "./workflow-node";
import { WorkflowEdge, type WorkflowEdgeData } from "./workflow-edge";
import { buildWorkflowRouteTopology } from "./workflow-routes";

const nodeTypes = { workflow: WorkflowNode, columnHeader: ColumnHeaderNode };
const edgeTypes = { workflow: WorkflowEdge };
const EMPTY_GRAPH: WorkflowGraph = { schemaVersion: 1, nodes: [], edges: [] };
const WORKFLOW_NODE_DIMENSIONS = { width: 276, height: 112 } as const;
const COLUMN_HEADER_DIMENSIONS = { width: 276, height: 27 } as const;
const WORKFLOW_HANDLE_SIZE = 12;

function workflowHandles(kind: WorkflowKind): NonNullable<Node["handles"]> {
  const edgeOffset = WORKFLOW_HANDLE_SIZE / 2;
  const centerY = (WORKFLOW_NODE_DIMENSIONS.height - WORKFLOW_HANDLE_SIZE) / 2;
  const handles: NonNullable<Node["handles"]> = [];
  if (kind !== "channel") {
    handles.push({
      type: "target",
      position: Position.Left,
      x: -edgeOffset,
      y: centerY,
      width: WORKFLOW_HANDLE_SIZE,
      height: WORKFLOW_HANDLE_SIZE,
    });
  }
  if (kind !== "output") {
    handles.push({
      type: "source",
      position: Position.Right,
      x: WORKFLOW_NODE_DIMENSIONS.width - edgeOffset,
      y: centerY,
      width: WORKFLOW_HANDLE_SIZE,
      height: WORKFLOW_HANDLE_SIZE,
    });
  }
  return handles;
}

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      payload.error || `Anfrage fehlgeschlagen (${response.status}).`,
    );
  return payload;
}

function summary(
  resource: WorkflowResource,
  trading: TradingSnapshot | null,
): string {
  const value: any = resource.configuration;
  if (resource.kind === "account") {
    const account = trading?.accounts.find(
      (item) => item.id === value.accountId,
    );
    return account
      ? `${account.exchange} · ${account.mode} · max ${account.maxConcurrentPositions}`
      : String(value.accountId);
  }
  const summaries: Partial<Record<WorkflowKind, () => string>> = {
    channel: () => String(value.channelId),
    content_filter: () => `${value.allowedTypes?.length || 0} Inhaltstypen`,
    keyword_filter: () =>
      `${value.allowedKeywords?.length || 0} erlaubt · ${value.blockedKeywords?.length || 0} blockiert`,
    regex: () =>
      `${value.patterns?.length || 0} Muster · ${value.mode === "any" ? "eines" : "alle"}`,
    parser: () =>
      `${Math.round(Number(value.timeoutMs || 0) / 1000)} s · ${value.templateName}`,
    schema: () =>
      trading?.signalSchemas.find((item) => item.id === value.schemaId)?.name ||
      String(value.schemaId),
    contract: () => String(value.contractVersionId),
    dedupe: () =>
      value.enabled === false
        ? "deaktiviert"
        : `${value.cooldownHours} h Cooldown`,
    strategy: () =>
      trading?.strategies.find((item) => item.id === value.strategyVersionId)
        ?.name || String(value.strategyVersionId),
    sizing: () =>
      `${value.riskPerTradePercent}% Basis · ${value.maxAdaptiveRiskPercent}% max · ${value.maxLeverage}×`,
    adaptive_risk: () =>
      value.enabled === false
        ? "deaktiviert"
        : `${value.mode} · ${value.tiers?.length || 0} Stufen`,
    output: () =>
      ({
        telegram_xml: "Telegram XML",
        telegram_original: "Telegram Original",
        none: "Keine Ausgabe",
        audit_only: "Audit & Journal",
      })[String(value.mode)] || "Audit & Journal",
  };
  return summaries[resource.kind]?.() || resource.name;
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function impactText(impact: any): string {
  const lines = [
    `${impact.changed?.length || 0} Pfad(e) werden geändert.`,
    `${impact.removed?.length || 0} Pfad(e) werden entfernt.`,
  ];
  for (const path of [
    ...(impact.changed || []),
    ...(impact.removed || []),
  ].slice(0, 10)) {
    lines.push(`• ${path.channelId} → ${path.accountId}`);
  }
  return `${lines.join("\n")}\n\nDiese Änderung sofort als aktive Revision übernehmen?`;
}

export function confirmWorkflowImpact(impact: any): string | null {
  const required =
    typeof impact?.confirmation === "string" ? impact.confirmation : "";
  if (!required) return null;
  const entered = window.prompt(
    `${impactText(impact)}\n\nZur Bestätigung exakt eingeben:\n${required}`,
  );
  return entered === required ? required : null;
}

function workflowSnapshot(payload: any): WorkflowSnapshot {
  const resources = Array.isArray(payload?.resources) ? payload.resources : [];
  const candidate = payload?.workflow;
  const graph = candidate?.graph;
  const compiled = candidate?.compiled;
  const validWorkflow =
    candidate &&
    graph &&
    Array.isArray(graph.nodes) &&
    Array.isArray(graph.edges) &&
    compiled &&
    Array.isArray(compiled.paths) &&
    Array.isArray(compiled.warnings);
  return { workflow: validWorkflow ? candidate : null, resources };
}

function tradingSnapshot(payload: any): TradingSnapshot | null {
  const valid =
    payload?.overview?.runtime &&
    Array.isArray(payload.accounts) &&
    Array.isArray(payload.strategies) &&
    Array.isArray(payload.signalSchemas) &&
    Array.isArray(payload.signalContracts) &&
    Array.isArray(payload.intents) &&
    Array.isArray(payload?.activity?.positions) &&
    Array.isArray(payload?.activity?.riskEvents) &&
    Array.isArray(payload?.activity?.reconciliations);
  return valid ? payload : null;
}

function exchangeCatalog(payload: any): ExchangeCatalog | null {
  return payload?.implementation && Array.isArray(payload.exchanges)
    ? payload
    : null;
}

export function WorkflowBuilder() {
  const [snapshot, setSnapshot] = useState<WorkflowSnapshot>({
    workflow: null,
    resources: [],
  });
  const [trading, setTrading] = useState<TradingSnapshot | null>(null);
  const [catalog, setCatalog] = useState<ExchangeCatalog | null>(null);
  const [systemStatus, setSystemStatus] = useState<Record<string, any> | null>(
    null,
  );
  const [graph, setGraph] = useState<WorkflowGraph>(EMPTY_GRAPH);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "ok" | "warning" | "error";
    text: string;
  } | null>(null);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [editorNodeId, setEditorNodeId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<WorkflowKind | null>(null);
  const [kindPickerOpen, setKindPickerOpen] = useState(false);
  const [libraryKind, setLibraryKind] = useState<WorkflowKind | null>(null);
  const [simulationOpen, setSimulationOpen] = useState(false);
  const [simulation, setSimulation] = useState({
    channelId: "",
    contentType: "text",
    text: "",
  });
  const [simulationResult, setSimulationResult] = useState<any>(null);
  const [search, setSearch] = useState("");
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(
    null,
  );
  const [connectionSearch, setConnectionSearch] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [routeOverviewOpen, setRouteOverviewOpen] = useState(false);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const simulationTriggerRef = useRef<HTMLButtonElement>(null);
  const operationsTriggerRef = useRef<HTMLButtonElement>(null);
  const routeTriggerRef = useRef<HTMLButtonElement>(null);
  const reactFlowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const closeLibrary = useCallback(() => {
    setKindPickerOpen(false);
    setLibraryKind(null);
    window.setTimeout(() => libraryTriggerRef.current?.focus(), 0);
  }, []);
  const closeSimulation = useCallback(() => {
    setSimulationOpen(false);
    window.setTimeout(() => simulationTriggerRef.current?.focus(), 0);
  }, []);
  const closeOperations = useCallback(() => {
    setOperationsOpen(false);
    window.setTimeout(() => operationsTriggerRef.current?.focus(), 0);
  }, []);
  const changeRouteOverview = useCallback((open: boolean) => {
    setRouteOverviewOpen(open);
    if (!open)
      window.setTimeout(() => routeTriggerRef.current?.focus(), 0);
  }, []);
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const revealNode = useCallback((node: WorkflowGraph["nodes"][number]) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void reactFlowRef.current?.setCenter(
          KIND_META[node.kind].order * COLUMN_GAP +
            WORKFLOW_NODE_DIMENSIONS.width / 2,
          node.position.y + WORKFLOW_NODE_DIMENSIONS.height / 2,
          { zoom: 0.88, duration: 420 },
        );
      });
    });
  }, []);

  const showAllNodes = useCallback(() => {
    if (graphRef.current.nodes.length === 0) return;
    setSearch("");
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void reactFlowRef.current?.fitView({
          nodes: graphRef.current.nodes.map((node) => ({ id: node.id })),
          padding: 0.12,
          minZoom: 0.18,
          maxZoom: 0.88,
          duration: 420,
        });
      });
    });
  }, []);

  const load = useCallback(async () => {
    const [workflowPayload, tradingPayload, statusPayload, catalogPayload] =
      await Promise.all([
        jsonRequest("/api/workflow"),
        jsonRequest("/api/trading"),
        jsonRequest("/api/status"),
        jsonRequest("/api/exchanges/catalog"),
      ]);
    const nextSnapshot = workflowSnapshot(workflowPayload);
    setSnapshot(nextSnapshot);
    setTrading(tradingSnapshot(tradingPayload));
    setSystemStatus(
      statusPayload && typeof statusPayload === "object" ? statusPayload : null,
    );
    setCatalog(exchangeCatalog(catalogPayload));
    setGraph(structuredClone(nextSnapshot.workflow?.graph || EMPTY_GRAPH));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load().catch((error) => {
      setLoading(false);
      setNotice({ tone: "error", text: error.message });
    });
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.all([
        jsonRequest("/api/trading"),
        jsonRequest("/api/status"),
      ])
        .then(([tradingPayload, statusPayload]) => {
          setTrading(tradingSnapshot(tradingPayload));
          setSystemStatus(
            statusPayload && typeof statusPayload === "object"
              ? statusPayload
              : null,
          );
        })
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const resourceById = useMemo(
    () =>
      new Map(snapshot.resources.map((resource) => [resource.id, resource])),
    [snapshot.resources],
  );
  const routeTopology = useMemo(
    () =>
      buildWorkflowRouteTopology(
        snapshot.workflow?.compiled.paths || [],
        graph,
        snapshot.resources,
        trading?.accounts || [],
        trading?.strategies || [],
      ),
    [
      graph,
      snapshot.resources,
      snapshot.workflow?.compiled.paths,
      trading?.accounts,
      trading?.strategies,
    ],
  );
  const selectedRoute = useMemo(
    () =>
      routeTopology.routes.find((route) => route.id === selectedPathId) || null,
    [routeTopology.routes, selectedPathId],
  );

  useEffect(() => {
    if (selectedPathId && !selectedRoute) setSelectedPathId(null);
  }, [selectedPathId, selectedRoute]);
  const publishedLibrary = useMemo(() => {
    const latest = new Map<string, WorkflowResource>();
    for (const resource of snapshot.resources) {
      if (resource.status !== "published") continue;
      const current = latest.get(resource.resourceId);
      if (!current || current.version < resource.version)
        latest.set(resource.resourceId, resource);
    }
    return [...latest.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "de-DE"),
    );
  }, [snapshot.resources]);
  const openEditor = useCallback(
    (nodeId: string) => setEditorNodeId(nodeId),
    [],
  );
  const executableNodeIds = useMemo(
    () =>
      new Set(
        snapshot.workflow?.compiled.paths
          .filter((path) => path.enabled)
          .flatMap((path) => path.nodeIds) || [],
      ),
    [snapshot.workflow],
  );

  const activateGraph = useCallback(
    async (candidate: WorkflowGraph, successMessage: string) => {
      setSaving(true);
      setNotice(null);
      try {
        const impactPayload = await jsonRequest("/api/workflow/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseRevisionId: snapshot.workflow?.id ?? null,
            graph: candidate,
          }),
        });
        const impact = impactPayload.impact;
        let confirmation: string | null = null;
        if (impact.destructive) {
          confirmation = confirmWorkflowImpact(impact);
          if (!confirmation) return false;
        }
        const payload = await jsonRequest("/api/workflow/mutate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseRevisionId: snapshot.workflow?.id ?? null,
            graph: candidate,
            confirmation,
          }),
        });
        setSnapshot((previous) => ({
          ...previous,
          workflow: payload.workflow,
        }));
        setGraph(structuredClone(payload.workflow.graph));
        setNotice({
          tone: impact.destructive ? "warning" : "ok",
          text: `${successMessage} · Revision ${payload.workflow.revision} ist aktiv.`,
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotice({
          tone: "error",
          text:
            message === "WORKFLOW_REVISION_CONFLICT"
              ? "Der Workflow wurde parallel geändert. Der aktuelle Stand wird neu geladen."
              : message,
        });
        if (message.includes("WORKFLOW_REVISION_CONFLICT")) await load();
        return false;
      } finally {
        setSaving(false);
      }
    },
    [load, snapshot.workflow?.id],
  );

  const cancelConnection = useCallback(() => {
    setConnectionSourceId(null);
    setConnectionSearch("");
  }, []);

  const connectNodes = useCallback(
    async (sourceId: string, targetId: string) => {
      const source = graphRef.current.nodes.find(
        (node) => node.id === sourceId,
      );
      const target = graphRef.current.nodes.find(
        (node) => node.id === targetId,
      );
      if (
        !source ||
        !target ||
        KIND_META[source.kind].order >= KIND_META[target.kind].order
      ) {
        setNotice({
          tone: "error",
          text: "Das Ziel muss rechts vom Ausgangsbaustein in einer späteren Verarbeitungsspalte liegen.",
        });
        return false;
      }
      if (
        graphRef.current.edges.some(
          (edge) => edge.source === source.id && edge.target === target.id,
        )
      ) {
        setNotice({
          tone: "warning",
          text: "Diese Verbindung besteht bereits.",
        });
        cancelConnection();
        return false;
      }
      const candidate = structuredClone(graphRef.current);
      const edgeId = newId("edge");
      candidate.edges.push({
        id: edgeId,
        source: source.id,
        target: target.id,
      });
      const activated = await activateGraph(candidate, "Verbindung aktiviert");
      if (activated) setSelectedEdgeId(edgeId);
      cancelConnection();
      return activated;
    },
    [activateGraph, cancelConnection],
  );

  const removeEdge = useCallback(
    async (edgeId: string) => {
      const candidate = structuredClone(graphRef.current);
      candidate.edges = candidate.edges.filter((edge) => edge.id !== edgeId);
      if (candidate.edges.length === graphRef.current.edges.length)
        return false;
      const activated = await activateGraph(candidate, "Verbindung entfernt");
      if (activated) setSelectedEdgeId(null);
      return activated;
    },
    [activateGraph],
  );

  const startConnection = useCallback((nodeId: string) => {
    setSelectedEdgeId(null);
    setConnectionSearch("");
    setConnectionSourceId(nodeId);
    setNotice(null);
  }, []);

  const completeConnection = useCallback(
    (targetId: string) => {
      if (connectionSourceId) void connectNodes(connectionSourceId, targetId);
    },
    [connectNodes, connectionSourceId],
  );

  const connectionSource = connectionSourceId
    ? graph.nodes.find((node) => node.id === connectionSourceId) || null
    : null;
  const connectionTargets = useMemo(() => {
    if (!connectionSource) return [];
    const query = connectionSearch.trim().toLocaleLowerCase("de-DE");
    return graph.nodes
      .filter(
        (node) =>
          KIND_META[node.kind].order > KIND_META[connectionSource.kind].order,
      )
      .filter(
        (node) =>
          !graph.edges.some(
            (edge) =>
              edge.source === connectionSource.id && edge.target === node.id,
          ),
      )
      .map((node) => {
        const resource = resourceById.get(node.resourceVersionId);
        return {
          node,
          name: resource?.name || "Fehlende Ressource",
          description: resource
            ? summary(resource, trading)
            : node.resourceVersionId,
        };
      })
      .filter(
        (item) =>
          !query ||
          `${item.name} ${item.description} ${KIND_META[item.node.kind].label}`
            .toLocaleLowerCase("de-DE")
            .includes(query),
      )
      .sort(
        (left, right) =>
          KIND_META[left.node.kind].order - KIND_META[right.node.kind].order ||
          left.name.localeCompare(right.name, "de-DE"),
      );
  }, [
    connectionSearch,
    connectionSource,
    graph.edges,
    graph.nodes,
    resourceById,
    trading,
  ]);

  const displayNodes = useMemo<Node[]>(() => {
    const headers: Node[] = WORKFLOW_KINDS.map((kind) => ({
      id: `__column_${kind}`,
      type: "columnHeader",
      draggable: false,
      selectable: false,
      position: { x: KIND_META[kind].order * COLUMN_GAP, y: -185 },
      data: { kind },
      initialWidth: COLUMN_HEADER_DIMENSIONS.width,
      initialHeight: COLUMN_HEADER_DIMENSIONS.height,
      style: { width: COLUMN_HEADER_DIMENSIONS.width, zIndex: -1 },
    }));
    const query = search.trim().toLocaleLowerCase("de-DE");
    const nodes: Node[] = graph.nodes.map((node) => {
      const resource = resourceById.get(node.resourceVersionId);
      const warning = snapshot.workflow?.compiled.warnings.find((item) =>
        item.includes(node.id),
      );
      const visible =
        !query ||
        `${resource?.name || ""} ${KIND_META[node.kind].label} ${resource ? summary(resource, trading) : ""}`
          .toLocaleLowerCase("de-DE")
          .includes(query);
      const sourceOrder = connectionSource
        ? KIND_META[connectionSource.kind].order
        : -1;
      const isExistingTarget = connectionSource
        ? graph.edges.some(
            (edge) =>
              edge.source === connectionSource.id && edge.target === node.id,
          )
        : false;
      const connectionState: WorkflowNodeData["connectionState"] =
        !connectionSource
          ? "idle"
          : node.id === connectionSource.id
            ? "source"
            : KIND_META[node.kind].order > sourceOrder && !isExistingTarget
              ? "target"
              : "blocked";
      const routeUsage = routeTopology.nodeUsage.get(node.id) || {
        pathCount: 0,
        channelCount: 0,
        accountCount: 0,
        resourceInstanceCount: 1,
        routeIds: [],
      };
      return {
        id: node.id,
        type: "workflow",
        position: {
          x: KIND_META[node.kind].order * COLUMN_GAP,
          y: node.position.y,
        },
        hidden: !visible,
        data: {
          kind: node.kind,
          name: resource?.name || "Fehlende Ressource",
          summary: resource
            ? summary(resource, trading)
            : node.resourceVersionId,
          version: resource?.version || 0,
          enabled: executableNodeIds.has(node.id),
          warning,
          incomingConnections: graph.edges.filter(
            (edge) => edge.target === node.id,
          ).length,
          outgoingConnections: graph.edges.filter(
            (edge) => edge.source === node.id,
          ).length,
          routeUsage,
          pathFocusState: !selectedPathId
            ? "idle"
            : routeUsage.routeIds.includes(selectedPathId)
              ? "active"
              : "dimmed",
          connectionState,
          onEdit: openEditor,
          onStartConnection: startConnection,
          onCompleteConnection: completeConnection,
          onCancelConnection: cancelConnection,
        } satisfies WorkflowNodeData,
        initialWidth: WORKFLOW_NODE_DIMENSIONS.width,
        initialHeight: WORKFLOW_NODE_DIMENSIONS.height,
        handles: workflowHandles(node.kind),
        style: { width: WORKFLOW_NODE_DIMENSIONS.width },
      };
    });
    return [...headers, ...nodes];
  }, [
    cancelConnection,
    completeConnection,
    connectionSource,
    executableNodeIds,
    graph.edges,
    graph.nodes,
    openEditor,
    resourceById,
    routeTopology.nodeUsage,
    search,
    selectedPathId,
    snapshot.workflow?.compiled.warnings,
    startConnection,
    trading,
  ]);

  const displayEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const routeUsage = routeTopology.edgeUsage.get(edge.id) || {
          pathCount: 0,
          channelCount: 0,
          accountCount: 0,
          resourceInstanceCount: 1,
          routeIds: [],
        };
        return {
          ...edge,
          type: "workflow",
          selected: edge.id === selectedEdgeId,
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
          data: {
            routeUsage,
            pathFocusState: !selectedPathId
              ? "idle"
              : routeUsage.routeIds.includes(selectedPathId)
                ? "active"
                : "dimmed",
          } satisfies WorkflowEdgeData,
        };
      }),
    [graph.edges, routeTopology.edgeUsage, selectedEdgeId, selectedPathId],
  );
  const noSearchResults = Boolean(
    search.trim() &&
      graph.nodes.length > 0 &&
      !displayNodes.some(
        (node) => !node.id.startsWith("__column_") && !node.hidden,
      ),
  );

  const selectedConnection = useMemo(() => {
    const edge = graph.edges.find((item) => item.id === selectedEdgeId);
    if (!edge) return null;
    const source = graph.nodes.find((node) => node.id === edge.source);
    const target = graph.nodes.find((node) => node.id === edge.target);
    return {
      edge,
      sourceName: source
        ? resourceById.get(source.resourceVersionId)?.name ||
          "Unbekannte Quelle"
        : "Unbekannte Quelle",
      targetName: target
        ? resourceById.get(target.resourceVersionId)?.name || "Unbekanntes Ziel"
        : "Unbekanntes Ziel",
    };
  }, [graph.edges, graph.nodes, resourceById, selectedEdgeId]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const relevant = changes.filter(
      (change) => !("id" in change) || !change.id.startsWith("__column_"),
    );
    if (relevant.length === 0) return;
    const currentNodes: Node[] = graphRef.current.nodes.map((node) => ({
      id: node.id,
      position: node.position,
      data: {},
    }));
    const updated = applyNodeChanges(relevant, currentNodes);
    const positions = new Map(updated.map((node) => [node.id, node.position]));
    setGraph((previous) => ({
      ...previous,
      nodes: previous.nodes.map((node) => ({
        ...node,
        position: positions.get(node.id) || node.position,
      })),
    }));
  }, []);

  const persistPosition: OnNodeDrag = useCallback(
    (_event, node) => {
      if (node.id.startsWith("__column_")) return;
      const candidate = structuredClone(graphRef.current);
      const target = candidate.nodes.find((item) => item.id === node.id);
      if (!target) return;
      target.position = {
        x: KIND_META[target.kind].order * COLUMN_GAP,
        y: Math.round(node.position.y / 10) * 10,
      };
      setGraph(candidate);
      void activateGraph(candidate, "Position gespeichert");
    },
    [activateGraph],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target)
        void connectNodes(connection.source, connection.target);
    },
    [connectNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removedIds = new Set(
        changes
          .filter((change) => change.type === "remove")
          .map((change) => change.id),
      );
      if (removedIds.size === 0) return;
      const candidate = structuredClone(graphRef.current);
      candidate.edges = candidate.edges.filter(
        (edge) => !removedIds.has(edge.id),
      );
      void activateGraph(
        candidate,
        removedIds.size === 1
          ? "Verbindung entfernt"
          : `${removedIds.size} Verbindungen entfernt`,
      ).then((activated) => {
        if (activated) setSelectedEdgeId(null);
      });
    },
    [activateGraph],
  );

  const isValidConnection = useCallback((connection: Edge | Connection) => {
    const source = graphRef.current.nodes.find(
      (node) => node.id === connection.source,
    );
    const target = graphRef.current.nodes.find(
      (node) => node.id === connection.target,
    );
    return Boolean(
      source &&
      target &&
      KIND_META[source.kind].order < KIND_META[target.kind].order &&
      !graphRef.current.edges.some(
        (edge) => edge.source === source.id && edge.target === target.id,
      ),
    );
  }, []);

  const selectedNode = editorNodeId
    ? graph.nodes.find((node) => node.id === editorNodeId) || null
    : null;
  const selectedResource = selectedNode
    ? resourceById.get(selectedNode.resourceVersionId) || null
    : null;
  const editorKind = newKind || selectedNode?.kind || "channel";

  const saveResource = async (value: {
    name: string;
    description: string;
    configuration: Record<string, unknown>;
  }) => {
    const base = selectedResource;
    const draftPayload = await jsonRequest("/api/workflow/resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(base ? { resourceId: base.resourceId } : {}),
        kind: editorKind,
        name: value.name,
        description: value.description,
        configuration: value.configuration,
      }),
    });
    const publishPayload = await jsonRequest(
      "/api/workflow/resources/publish",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: draftPayload.resource.id }),
      },
    );
    const resource = publishPayload.resource as WorkflowResource;
    const candidate = structuredClone(graphRef.current);
    let addedNode: WorkflowGraph["nodes"][number] | null = null;
    if (selectedNode) {
      const node = candidate.nodes.find((item) => item.id === selectedNode.id)!;
      node.resourceVersionId = resource.id;
    } else {
      const sameColumn = candidate.nodes.filter(
        (item) => item.kind === editorKind,
      );
      addedNode = {
        id: newId("node"),
        kind: editorKind,
        resourceVersionId: resource.id,
        position: {
          x: KIND_META[editorKind].order * COLUMN_GAP,
          y: sameColumn.length * 150,
        },
      };
      candidate.nodes.push(addedNode);
    }
    const activated = await activateGraph(
      candidate,
      base ? `${value.name} aktualisiert` : `${value.name} hinzugefügt`,
    );
    if (activated) {
      setSnapshot((previous) => ({
        ...previous,
        resources: [...previous.resources, resource],
      }));
      if (addedNode) {
        setSearch("");
        revealNode(addedNode);
      }
    } else await load();
    return activated;
  };

  const addExistingResource = async (resource: WorkflowResource) => {
    const candidate = structuredClone(graphRef.current);
    const sameColumn = candidate.nodes.filter(
      (item) => item.kind === resource.kind,
    );
    const addedNode: WorkflowGraph["nodes"][number] = {
      id: newId("node"),
      kind: resource.kind,
      resourceVersionId: resource.id,
      position: {
        x: KIND_META[resource.kind].order * COLUMN_GAP,
        y: sameColumn.length * 150,
      },
    };
    candidate.nodes.push(addedNode);
    const activated = await activateGraph(
      candidate,
      `${resource.name} wiederverwendet`,
    );
    if (activated) {
      setKindPickerOpen(false);
      setLibraryKind(null);
      setSearch("");
      revealNode(addedNode);
    }
  };

  const deleteNode = async () => {
    if (!selectedNode) return;
    const candidate = structuredClone(graphRef.current);
    candidate.nodes = candidate.nodes.filter(
      (node) => node.id !== selectedNode.id,
    );
    candidate.edges = candidate.edges.filter(
      (edge) =>
        edge.source !== selectedNode.id && edge.target !== selectedNode.id,
    );
    const activated = await activateGraph(candidate, "Baustein entfernt");
    if (activated) setEditorNodeId(null);
  };

  const configureAccount = async (accountId: string, maximum: number) => {
    await jsonRequest("/api/trading/accounts/configuration", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: accountId, maxConcurrentPositions: maximum }),
    });
    const refreshed = await jsonRequest("/api/trading");
    setTrading(tradingSnapshot(refreshed));
  };

  const runSimulation = async () => {
    try {
      const payload = await jsonRequest("/api/workflow/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(simulation),
      });
      setSimulationResult(payload.result);
    } catch (error) {
      setSimulationResult({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (loading)
    return (
      <div className="builder-loading">
        <Workflow size={28} />
        <span>Lade aktive Workflow-Revision…</span>
      </div>
    );

  return (
    <main className="workflow-shell" aria-label="TSX Core Workflow Builder">
      <header className="workflow-topbar">
        <div className="workflow-brand">
          <div className="workflow-mark">
            <Workflow size={21} />
          </div>
          <div>
            <span>TSX Core</span>
            <strong>Execution Workflow</strong>
          </div>
        </div>
        <div className="workflow-health">
          <Badge
            variant="outline"
            className={
              systemStatus?.connectionState === "connected"
                ? "status-healthy"
                : ""
            }
          >
            <i />
            Telegram {systemStatus?.connectionState || "offline"}
          </Badge>
          <Badge
            variant="outline"
            className={
              trading?.overview.runtime.executionEnabled ? "status-healthy" : ""
            }
          >
            <i />
            Execution{" "}
            {trading?.overview.runtime.executionEnabled ? "aktiv" : "pausiert"}
          </Badge>
          <Badge
            variant={
              trading?.overview.runtime.killSwitchActive
                ? "destructive"
                : "outline"
            }
            className={
              trading?.overview.runtime.killSwitchActive ? "" : "status-healthy"
            }
          >
            <ShieldCheck />
            {trading?.overview.runtime.killSwitchActive
              ? "global gesperrt"
              : "Schutz bereit"}
          </Badge>
        </div>
        <div className="workflow-actions">
          <div className="builder-search">
            <Search />
            <Input
              aria-label="Bausteine durchsuchen"
              placeholder="Baustein suchen"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <ThemeToggle />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={showAllNodes}
            disabled={graph.nodes.length === 0}
            aria-label="Alle Bausteine im Canvas anzeigen"
          >
            <Maximize2 data-icon="inline-start" /> Alles anzeigen
          </Button>
          <Button
            ref={routeTriggerRef}
            type="button"
            variant={selectedPathId ? "secondary" : "outline"}
            size="sm"
            onClick={() => setRouteOverviewOpen(true)}
            aria-label={`Pfade anzeigen (${routeTopology.routes.length})`}
          >
            <RouteIcon data-icon="inline-start" /> Pfade
            <span className="action-count">{routeTopology.routes.length}</span>
          </Button>
          <Button
            ref={simulationTriggerRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSimulationOpen(true)}
          >
            <FlaskConical data-icon="inline-start" /> Simulieren
          </Button>
          <Button
            ref={operationsTriggerRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOperationsOpen(true)}
          >
            <Activity data-icon="inline-start" /> Betrieb
          </Button>
          <Button
            ref={libraryTriggerRef}
            type="button"
            size="sm"
            onClick={() => {
              setLibraryKind(null);
              setKindPickerOpen(true);
            }}
          >
            <Plus data-icon="inline-start" /> Baustein
          </Button>
        </div>
      </header>
      <section className="workflow-statusbar" aria-label="Workflow-Status">
        <a className="workflow-status-skip" href="#workflow-canvas">
          Statusleiste überspringen
        </a>
        <div>
          <strong>Revision {snapshot.workflow?.revision ?? 0}</strong>
          <span>
            {snapshot.workflow
              ? `aktiv seit ${new Date(snapshot.workflow.createdAt).toLocaleString("de-DE")}`
              : "Noch keine aktive Revision"}
          </span>
        </div>
        <div>
          <strong>{snapshot.workflow?.compiled.paths.length ?? 0} Pfade</strong>
          <span>
            {snapshot.workflow?.compiled.paths.filter((path) => path.enabled)
              .length ?? 0}{" "}
            ausführbar
          </span>
        </div>
        <div>
          <strong>{graph.nodes.length} Bausteine</strong>
          <span>{graph.edges.length} Verbindungen</span>
        </div>
        <div className="save-indicator">
          {saving ? (
            <>
              <RefreshCw size={14} className="spin" /> validiere & aktiviere
            </>
          ) : (
            <>
              <Save size={14} /> alle Änderungen gespeichert
            </>
          )}
        </div>
      </section>
      {notice && (
        <div className={`builder-notice ${notice.tone}`}>
          <span>
            {notice.tone === "ok" ? (
              <Check size={16} />
            ) : (
              <AlertTriangle size={16} />
            )}
          </span>
          <p>{notice.text}</p>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setNotice(null)}
            aria-label="Hinweis schließen"
          >
            <X />
          </Button>
        </div>
      )}
      <div id="workflow-canvas" className="workflow-canvas">
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onInit={(instance) => {
            reactFlowRef.current = instance;
            const firstNode = [...graphRef.current.nodes].sort(
              (left, right) =>
                KIND_META[left.kind].order - KIND_META[right.kind].order ||
                left.position.y - right.position.y,
            )[0];
            if (firstNode) revealNode(firstNode);
          }}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={(_event, params) => {
            if (params.handleType === "source" && params.nodeId)
              startConnection(params.nodeId);
          }}
          isValidConnection={isValidConnection}
          onNodeDragStop={persistPosition}
          onNodeClick={
            ((_event, node) => {
              if (node.id.startsWith("__column_")) return;
              if (connectionSourceId) completeConnection(node.id);
              else setEditorNodeId(node.id);
            }) as NodeMouseHandler
          }
          onEdgeClick={(event, edge) => {
            event.stopPropagation();
            setSelectedEdgeId(edge.id);
            cancelConnection();
          }}
          onPaneClick={() => {
            setSelectedEdgeId(null);
            cancelConnection();
          }}
          deleteKeyCode={["Backspace", "Delete"]}
          minZoom={0.18}
          maxZoom={1.5}
          defaultViewport={{ x: 24, y: 210, zoom: 0.88 }}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            type: "workflow",
            markerEnd: { type: MarkerType.ArrowClosed },
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="rgba(148,163,184,.16)"
          />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap
            position="bottom-right"
            pannable
            zoomable
            nodeColor={(node) =>
              node.id.startsWith("__column_")
                ? "transparent"
                : KIND_META[(node.data as any).kind]?.color || "#64748b"
            }
            maskColor="var(--minimap-mask)"
          />
          {noSearchResults && (
            <Panel position="top-center" className="canvas-empty-panel">
              <Card>
                <CardContent>
                  <span>
                    <strong>Keine passenden Bausteine</strong>
                    <small>
                      Die Suche blendet derzeit alle Canvas-Bausteine aus.
                    </small>
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={showAllNodes}
                  >
                    Suche löschen und alles anzeigen
                  </Button>
                </CardContent>
              </Card>
            </Panel>
          )}
          {selectedRoute && (
            <Panel position="top-right" className="route-focus-panel">
              <Card>
                <CardContent>
                  <RouteIcon aria-hidden="true" />
                  <span>
                    <small>Pfadfokus</small>
                    <strong>
                      {selectedRoute.channelName} → {selectedRoute.accountName}
                    </strong>
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedPathId(null)}
                  >
                    Alle zeigen
                  </Button>
                </CardContent>
              </Card>
            </Panel>
          )}
          {connectionSource && (
            <Panel position="top-left" className="connection-panel">
              <Card>
                <CardHeader>
                  <div>
                    <Badge variant="secondary">
                      <Link2 /> Verbindung erstellen
                    </Badge>
                    <CardTitle>
                      {resourceById.get(connectionSource.resourceVersionId)
                        ?.name || "Baustein"}
                    </CardTitle>
                    <CardDescription>
                      Wähle rechts im Canvas oder hier ein gültiges Ziel.
                    </CardDescription>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={cancelConnection}
                    aria-label="Verbindung abbrechen"
                  >
                    <X />
                  </Button>
                </CardHeader>
                <CardContent>
                  <Input
                    aria-label="Verbindungsziele durchsuchen"
                    placeholder="Ziel suchen …"
                    value={connectionSearch}
                    onChange={(event) =>
                      setConnectionSearch(event.target.value)
                    }
                  />
                  <div className="connection-target-list">
                    {connectionTargets.slice(0, 24).map((item) => (
                      <Button
                        key={item.node.id}
                        type="button"
                        variant="ghost"
                        onClick={() => completeConnection(item.node.id)}
                      >
                        <span
                          style={
                            {
                              "--node-accent": KIND_META[item.node.kind].color,
                            } as CSSProperties
                          }
                        />
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {KIND_META[item.node.kind].label} ·{" "}
                            {item.description}
                          </small>
                        </span>
                      </Button>
                    ))}
                    {connectionTargets.length === 0 && (
                      <p>Keine passenden, noch unverbundenen Ziele gefunden.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Panel>
          )}
          {selectedConnection && (
            <Panel position="bottom-center" className="edge-inspector-panel">
              <Card
                role="toolbar"
                aria-label={`Verbindung von ${selectedConnection.sourceName} zu ${selectedConnection.targetName}`}
              >
                <CardContent>
                  <Link2 aria-hidden="true" />
                  <span>
                    <strong>{selectedConnection.sourceName}</strong>
                    <small>verbunden mit</small>
                    <strong>{selectedConnection.targetName}</strong>
                  </span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    onClick={() => void removeEdge(selectedConnection.edge.id)}
                  >
                    <Trash2 data-icon="inline-start" /> Verbindung löschen
                  </Button>
                </CardContent>
              </Card>
            </Panel>
          )}
        </ReactFlow>
      </div>

      <ResourceEditor
        open={Boolean(editorNodeId || newKind)}
        kind={editorKind}
        resource={selectedResource}
        trading={trading}
        onClose={() => {
          setEditorNodeId(null);
          setNewKind(null);
        }}
        onSave={saveResource}
        onDeleteNode={selectedNode ? deleteNode : undefined}
        onConfigureAccount={configureAccount}
      />
      <Dialog
        open={kindPickerOpen}
        onOpenChange={(open) => {
          if (!open) closeLibrary();
        }}
      >
        <DialogContent
          className="kind-picker sm:max-w-3xl"
          closeLabel="Baustein-Bibliothek schließen"
        >
          <DialogHeader>
            <Badge variant="secondary">Baustein-Bibliothek</Badge>
            <DialogTitle>
              {libraryKind
                ? KIND_META[libraryKind].label
                : "Was soll der Workflow als Nächstes können?"}
            </DialogTitle>
            <DialogDescription>
              Erstelle einen neuen Baustein oder verwende eine bereits
              veröffentlichte Version.
            </DialogDescription>
          </DialogHeader>
          {!libraryKind ? (
            <div className="kind-grid">
              {WORKFLOW_KINDS.map((kind) => {
                const available = publishedLibrary.filter(
                  (resource) => resource.kind === kind,
                ).length;
                return (
                  <Button
                    type="button"
                    variant="outline"
                    key={kind}
                    style={
                      {
                        "--node-accent": KIND_META[kind].color,
                      } as CSSProperties
                    }
                    onClick={() => setLibraryKind(kind)}
                  >
                    <i />
                    <span>
                      <strong>{KIND_META[kind].label}</strong>
                      <small>
                        {available
                          ? `${available} veröffentlichte Bausteine`
                          : "Noch kein gespeicherter Baustein"}
                      </small>
                    </span>
                  </Button>
                );
              })}
            </div>
          ) : (
            <div className="resource-library">
              <Button
                type="button"
                variant="ghost"
                className="library-back"
                onClick={() => setLibraryKind(null)}
              >
                ← Alle Bausteinarten
              </Button>
              <Button
                type="button"
                variant="outline"
                className="library-new"
                style={
                  {
                    "--node-accent": KIND_META[libraryKind].color,
                  } as CSSProperties
                }
                onClick={() => {
                  setKindPickerOpen(false);
                  setNewKind(libraryKind);
                  setLibraryKind(null);
                }}
              >
                <Plus />
                <span>
                  <strong>Neuen Baustein erstellen</strong>
                  <small>
                    Mit einer neuen unveränderlichen Version beginnen
                  </small>
                </span>
              </Button>
              {publishedLibrary
                .filter((resource) => resource.kind === libraryKind)
                .map((resource) => (
                  <Button
                    type="button"
                    variant="outline"
                    key={resource.id}
                    className="library-existing"
                    style={
                      {
                        "--node-accent": KIND_META[libraryKind].color,
                      } as CSSProperties
                    }
                    onClick={() => void addExistingResource(resource)}
                  >
                    <i />
                    <span>
                      <strong>{resource.name}</strong>
                      <small>
                        Version {resource.version}
                        {resource.description
                          ? ` · ${resource.description}`
                          : ""}
                      </small>
                    </span>
                  </Button>
                ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={simulationOpen}
        onOpenChange={(open) => {
          if (!open) closeSimulation();
        }}
      >
        <DialogContent
          className="simulation-modal sm:max-w-xl"
          closeLabel="Simulation schließen"
        >
          <DialogHeader>
            <Badge variant="secondary">Trockenlauf</Badge>
            <DialogTitle>Signal durch aktive Revision schicken</DialogTitle>
            <DialogDescription>
              Die Simulation führt keine Order aus. Sie zeigt, welche Pfade das
              Signal passieren würde.
            </DialogDescription>
          </DialogHeader>
          <div className="simulation-fields">
            <Label>
              Kanal-ID
              <Input
                autoFocus
                value={simulation.channelId}
                onChange={(event) =>
                  setSimulation({
                    ...simulation,
                    channelId: event.target.value,
                  })
                }
              />
            </Label>
            <Label>
              Inhaltstyp
              <NativeSelect
                className="w-full"
                value={simulation.contentType}
                onChange={(event) =>
                  setSimulation({
                    ...simulation,
                    contentType: event.target.value,
                  })
                }
              >
                <option value="text">Text</option>
                <option value="photo">Foto mit Caption</option>
                <option value="video">Video mit Caption</option>
                <option value="document">Dokument</option>
              </NativeSelect>
            </Label>
            <Label>
              Beispielnachricht
              <Textarea
                value={simulation.text}
                onChange={(event) =>
                  setSimulation({ ...simulation, text: event.target.value })
                }
              />
            </Label>
            <Button type="button" onClick={runSimulation}>
              <FlaskConical data-icon="inline-start" /> Pfade prüfen
            </Button>
          </div>
          {simulationResult && (
            <div className="simulation-result" aria-live="polite">
              {simulationResult.error ? (
                <div className="builder-error" role="alert">
                  {simulationResult.error}
                </div>
              ) : (
                <>
                  {simulationResult.paths?.map((path: any) => (
                    <div
                      key={path.id}
                      className={
                        path.allowed && path.enabled ? "pass" : "blocked"
                      }
                    >
                      <span>
                        {path.allowed && path.enabled ? "PASS" : "BLOCK"}
                      </span>
                      <strong>{path.accountId}</strong>
                      <small>
                        {path.reason ||
                          (path.enabled
                            ? "Filter erfüllt"
                            : "Konto nicht bereit")}
                      </small>
                    </div>
                  ))}
                  {simulationResult.paths?.length === 0 && <EmptySimulation />}
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <OperationsPanel
        open={operationsOpen}
        trading={trading}
        catalog={catalog}
        systemStatus={systemStatus}
        onClose={closeOperations}
        onRefresh={load}
      />
      <RouteOverview
        open={routeOverviewOpen}
        topology={routeTopology}
        selectedPathId={selectedPathId}
        onOpenChange={changeRouteOverview}
        onFocusPath={setSelectedPathId}
      />
    </main>
  );
}

function EmptySimulation() {
  return (
    <div className="operations-empty">
      Für diesen Kanal existiert kein vollständiger Pfad.
    </div>
  );
}
