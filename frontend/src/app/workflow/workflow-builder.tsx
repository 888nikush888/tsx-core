import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  getViewportForBounds,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  AlertTriangle,
  BarChart3,
  Check,
  FlaskConical,
  Gauge,
  Link2,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  Save,
  Search,
  ServerCog,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";
import { OperationsWorkspace } from "./operations-panel";
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
import { WorkflowConnectionDialog } from "./workflow-connection-dialog";
import { buildWorkflowRouteTopology } from "./workflow-routes";
import {
  consolidateWorkflowResources,
  channelNodesReachingSource,
  latestPublishedResources,
  moveWorkflowNode,
  normalizeWorkflowGrid,
  placedNodesByResourceIdentity,
  resourceBehaviorKey,
} from "./workflow-graph";

const nodeTypes = { workflow: WorkflowNode, columnHeader: ColumnHeaderNode };
const edgeTypes = { workflow: WorkflowEdge };
const EMPTY_GRAPH: WorkflowGraph = { schemaVersion: 1, nodes: [], edges: [] };
const WORKFLOW_NODE_DIMENSIONS = { width: 276, height: 112 } as const;
const COLUMN_HEADER_DIMENSIONS = { width: 276, height: 27 } as const;
const WORKFLOW_HANDLE_SIZE = 12;
const WORKFLOW_MIN_ZOOM = 0.05;

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
    schema: () => {
      const schema = trading?.signalSchemas.find(
        (item) => item.id === value.schemaId,
      );
      return schema
        ? `${schema.name} · ${schema.templateName}`
        : String(value.schemaId);
    },
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

type BuilderNoticeValue = {
  tone: "ok" | "warning" | "error";
  text: string;
};

type WorkflowWorkspace = "builder" | "dashboard" | "analytics" | "operations";

function operationalWorkspaceView(workspace: WorkflowWorkspace) {
  switch (workspace) {
    case "dashboard":
      return {
        ariaLabel: "Dashboard",
        initialTab: "overview" as const,
        availableTabs: ["overview"] as Array<"overview">,
      };
    case "analytics":
      return {
        ariaLabel: "Analytics",
        initialTab: "analytics" as const,
        availableTabs: ["analytics"] as Array<"analytics">,
      };
    default:
      return {
        ariaLabel: "Betrieb",
        initialTab: "accounts" as const,
        availableTabs: [
          "accounts",
          "journal",
          "logs",
          "backups",
          "mcp",
          "system",
        ] as Array<"accounts" | "journal" | "logs" | "backups" | "mcp" | "system">,
      };
  }
}

function selectedGraphNode(graph: WorkflowGraph, nodeId: string | null) {
  return nodeId ? graph.nodes.find((node) => node.id === nodeId) || null : null;
}

function resourceForNode(
  node: WorkflowGraph["nodes"][number] | null,
  resources: Map<string, WorkflowResource>,
) {
  return node ? resources.get(node.resourceVersionId) || null : null;
}

function connectionScopeDescription(selectedConnection: {
  channelNames?: string[];
} | null): string {
  return selectedConnection?.channelNames?.length
    ? `Nur für ${selectedConnection.channelNames.join(", ")}`
    : "Für alle Ursprungskanäle dieses Pfads.";
}

function SimulationResult({ result }: Readonly<{ result: any }>) {
  if (result.error) {
    return <div className="builder-error" role="alert">{result.error}</div>;
  }
  return (
    <>
      {result.paths?.map((path: any) => {
        const passed = path.allowed && path.enabled;
        const reason = path.reason || (path.enabled ? "Filter erfüllt" : "Konto nicht bereit");
        return (
          <div key={path.id} className={passed ? "pass" : "blocked"}>
            <span>{passed ? "PASS" : "BLOCK"}</span>
            <strong>{path.accountId}</strong>
            <small>{reason}</small>
          </div>
        );
      })}
      {result.paths?.length === 0 && <EmptySimulation />}
    </>
  );
}

const WORKSPACES: Array<{
  id: WorkflowWorkspace;
  label: string;
  icon: typeof RouteIcon;
}> = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "builder", label: "Builder", icon: RouteIcon },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "operations", label: "Betrieb", icon: ServerCog },
];

function WorkflowTopbar({
  systemStatus,
  trading,
}: Readonly<{
  systemStatus: Record<string, any> | null;
  trading: TradingSnapshot | null;
}>) {
  const executionEnabled = trading?.overview.runtime.executionEnabled === true;
  const killSwitchActive = trading?.overview.runtime.killSwitchActive === true;
  return (
    <header className="workflow-topbar">
      <div className="workflow-brand">
        <Logo variant="full" size={34} className="workflow-brand-logo" />
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
          className={executionEnabled ? "status-healthy" : ""}
        >
          <i />
          Execution {executionEnabled ? "aktiv" : "pausiert"}
        </Badge>
        <Badge
          variant={killSwitchActive ? "destructive" : "outline"}
          className={killSwitchActive ? "" : "status-healthy"}
        >
          <ShieldCheck />
          {killSwitchActive ? "global gesperrt" : "Schutz bereit"}
        </Badge>
      </div>
      <div className="workflow-actions">
        <ThemeToggle />
      </div>
    </header>
  );
}

function WorkflowNavigation({
  activeWorkspace,
  onChange,
}: Readonly<{
  activeWorkspace: WorkflowWorkspace;
  onChange: (workspace: WorkflowWorkspace) => void;
}>) {
  return (
    <nav className="workflow-navigation" aria-label="Hauptbereiche">
      <Tabs
        value={activeWorkspace}
        onValueChange={(value) => onChange(value as WorkflowWorkspace)}
      >
        <TabsList variant="line" className="workflow-navigation-list">
          {WORKSPACES.map((workspace) => {
            const Icon = workspace.icon;
            return (
              <TabsTrigger key={workspace.id} value={workspace.id}>
                <Icon />
                {workspace.label}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
    </nav>
  );
}

function WorkflowStatusbar({
  snapshot,
  graph,
  saving,
  search,
  selectedPathId,
  routeCount,
  onSearch,
  onRoutes,
  onSimulation,
  onLibrary,
  routeTriggerRef,
  simulationTriggerRef,
  libraryTriggerRef,
}: Readonly<{
  snapshot: WorkflowSnapshot;
  graph: WorkflowGraph;
  saving: boolean;
  search: string;
  selectedPathId: string | null;
  routeCount: number;
  onSearch: (value: string) => void;
  onRoutes: () => void;
  onSimulation: () => void;
  onLibrary: () => void;
  routeTriggerRef: RefObject<HTMLButtonElement | null>;
  simulationTriggerRef: RefObject<HTMLButtonElement | null>;
  libraryTriggerRef: RefObject<HTMLButtonElement | null>;
}>) {
  const enabledPaths =
    snapshot.workflow?.compiled.paths.filter((path) => path.enabled).length || 0;
  return (
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
        <span>{enabledPaths} ausführbar</span>
      </div>
      <div>
        <strong>{graph.nodes.length} Bausteine</strong>
        <span>{graph.edges.length} Verbindungen</span>
      </div>
      <div className="workflow-status-tools">
        <Button
          ref={routeTriggerRef}
          type="button"
          variant={selectedPathId ? "secondary" : "outline"}
          size="sm"
          onClick={onRoutes}
          aria-label={`Pfade anzeigen (${routeCount})`}
        >
          <RouteIcon data-icon="inline-start" /> Pfade
          <span className="action-count">{routeCount}</span>
        </Button>
        <Button
          ref={simulationTriggerRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={onSimulation}
        >
          <FlaskConical data-icon="inline-start" /> Simulieren
        </Button>
        <Button
          ref={libraryTriggerRef}
          type="button"
          size="sm"
          onClick={onLibrary}
        >
          <Plus data-icon="inline-start" /> Baustein
        </Button>
        <div className="builder-search">
          <Search />
          <Input
            aria-label="Bausteine durchsuchen"
            placeholder="Baustein suchen"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
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
      </div>
    </section>
  );
}

function WorkspaceStatusbar({
  workspace,
  onRefresh,
  trading,
  systemStatus,
  refreshing,
  lastUpdated,
}: Readonly<{
  workspace: Exclude<WorkflowWorkspace, "builder">;
  onRefresh: () => Promise<void>;
  trading: TradingSnapshot | null;
  systemStatus: Record<string, any> | null;
  refreshing: boolean;
  lastUpdated: number | null;
}>) {
  const copy = {
    dashboard: {
      title: "Dashboard",
      description: "Live-Gates, Runtime und Systemzustand auf einen Blick.",
    },
    analytics: {
      title: "Analytics",
      description: "Kanal-, Pfad- und Handelsperformance auswerten.",
    },
    operations: {
      title: "Betrieb",
      description: "Konten, Journal, Logs, Backups, MCP und System verwalten.",
    },
  }[workspace];
  const runtime = trading?.overview.runtime;
  const openIncidents = (trading?.accountIncidents || []).filter(
    (incident) => incident.status === "open",
  );
  const dashboardCockpit = [
    {
      label: "Telegram",
      value: systemStatus?.connectionState || "offline",
      healthy: systemStatus?.connectionState === "connected",
    },
    {
      label: "Execution",
      value: runtime?.executionEnabled ? "aktiv" : "pausiert",
      healthy: runtime?.executionEnabled === true,
    },
    {
      label: "Schutz",
      value: runtime?.killSwitchActive
        ? runtime.killSwitchReason || "global gesperrt"
        : openIncidents.length
          ? `${openIncidents.length} Incident(s)`
          : "bereit",
      healthy: runtime?.killSwitchActive !== true && openIncidents.length === 0,
    },
  ];
  const operationsCockpit = [
    {
      label: "System",
      value: systemStatus?.state || systemStatus?.status || "erreichbar",
      healthy: !systemStatus?.error,
    },
    {
      label: "Letzte Sicherung",
      value: systemStatus?.operations?.backup?.lastSuccessAt
        ? new Date(systemStatus.operations.backup.lastSuccessAt).toLocaleString("de-DE")
        : "Status in Backups",
      healthy: systemStatus?.operations?.backup?.healthy === true,
    },
    {
      label: "MCP",
      value: systemStatus?.mcp?.mode || "inaktiv",
      healthy: systemStatus?.mcp?.mode === "active",
    },
    {
      label: "Incidents",
      value: openIncidents.length ? String(openIncidents.length) : "keine",
      healthy: openIncidents.length === 0,
    },
  ];
  const items = workspace === "dashboard"
    ? dashboardCockpit
    : workspace === "operations"
      ? operationsCockpit
      : [];
  return (
    <section className="workflow-statusbar workspace-statusbar">
      <div>
        <strong>{copy.title}</strong>
        <span>{copy.description}</span>
      </div>
      {items.map((item) => (
        <div className="workspace-status-item" key={item.label}>
          <span className={`status-dot ${item.healthy ? "healthy" : "muted"}`} />
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
      <div className="workflow-status-tools">
        <span className="workspace-last-updated">
          {lastUpdated
            ? `zuletzt aktualisiert ${new Date(lastUpdated).toLocaleTimeString("de-DE")}`
            : "noch nicht aktualisiert"}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void onRefresh()}
        >
          <RefreshCw className={refreshing ? "spin" : ""} data-icon="inline-start" /> Aktualisieren
        </Button>
      </div>
    </section>
  );
}

function BuilderNotice({
  notice,
  onClose,
}: Readonly<{ notice: BuilderNoticeValue; onClose: () => void }>) {
  return (
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
        onClick={onClose}
        aria-label="Hinweis schließen"
      >
        <X />
      </Button>
    </div>
  );
}

function DuplicateResourceNotice({
  removedNodeCount,
  saving,
  onConsolidate,
}: Readonly<{
  removedNodeCount: number;
  saving: boolean;
  onConsolidate: () => void;
}>) {
  if (removedNodeCount === 0) return null;
  return (
    <div className="builder-notice warning duplicate-resource-notice">
      <span>
        <AlertTriangle size={16} />
      </span>
      <p>
        <strong>{removedNodeCount} verhaltensidentische Dublette(n) gefunden.</strong>{" "}
        Typ und vollständige Konfiguration sind identisch. Eine gemeinsame
        Instanz genügt für alle Verbindungen.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={saving}
        onClick={onConsolidate}
      >
        Jetzt sicher zusammenführen
      </Button>
    </div>
  );
}

function ResourceLibraryDialog({
  open,
  selectedKind,
  resources,
  placedResources,
  archiveTarget,
  onClose,
  onSelectKind,
  onCreate,
  onAdd,
  onSelectArchive,
  onArchive,
}: Readonly<{
  open: boolean;
  selectedKind: WorkflowKind | null;
  resources: WorkflowResource[];
  placedResources: Map<string, WorkflowGraph["nodes"][number]>;
  archiveTarget: WorkflowResource | null;
  onClose: () => void;
  onSelectKind: (kind: WorkflowKind | null) => void;
  onCreate: (kind: WorkflowKind) => void;
  onAdd: (resource: WorkflowResource) => void;
  onSelectArchive: (resource: WorkflowResource | null) => void;
  onArchive: (resource: WorkflowResource) => void;
}>) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="kind-picker sm:max-w-3xl"
        closeLabel="Baustein-Bibliothek schließen"
      >
        <DialogHeader>
          <Badge variant="secondary">Baustein-Bibliothek</Badge>
          <DialogTitle>
            {selectedKind
              ? KIND_META[selectedKind].label
              : "Was soll der Workflow als Nächstes können?"}
          </DialogTitle>
          <DialogDescription>
            Jeder gespeicherte Baustein steht höchstens einmal im Canvas.
            Zusätzliche Kombinationen entstehen über mehrere Verbindungen.
          </DialogDescription>
        </DialogHeader>
        {!selectedKind ? (
          <div className="kind-grid">
            {WORKFLOW_KINDS.map((kind) => {
              const available = resources.filter(
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
                  onClick={() => onSelectKind(kind)}
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
              onClick={() => onSelectKind(null)}
            >
              ← Alle Bausteinarten
            </Button>
            <Button
              type="button"
              variant="outline"
              className="library-new"
              style={
                {
                  "--node-accent": KIND_META[selectedKind].color,
                } as CSSProperties
              }
              onClick={() => onCreate(selectedKind)}
            >
              <Plus />
              <span>
                <strong>Neuen Baustein erstellen</strong>
                <small>Mit einer neuen unveränderlichen Version beginnen</small>
              </span>
            </Button>
            {archiveTarget && (
              <Alert
                variant="destructive"
                className="library-delete-confirmation"
              >
                <AlertTriangle />
                <AlertDescription>
                  <strong>„{archiveTarget.name}“ dauerhaft archivieren?</strong>
                  <p>
                    Falls der Baustein im Canvas steht, werden auch seine
                    aktiven Verbindungen entfernt. Frühere Revisionen bleiben
                    für Audit und Wiederherstellung erhalten.
                  </p>
                  <span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onSelectArchive(null)}
                    >
                      Abbrechen
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => onArchive(archiveTarget)}
                    >
                      Ja, dauerhaft archivieren
                    </Button>
                  </span>
                </AlertDescription>
              </Alert>
            )}
            {resources
              .filter((resource) => resource.kind === selectedKind)
              .map((resource) => {
                const placed = placedResources.get(
                  resourceBehaviorKey(resource),
                );
                return (
                  <div
                    key={resource.resourceId}
                    className={`library-existing ${placed ? "is-placed" : ""}`}
                    style={
                      {
                        "--node-accent": KIND_META[selectedKind].color,
                      } as CSSProperties
                    }
                  >
                    <button
                      type="button"
                      className="library-resource-main"
                      onClick={() => onAdd(resource)}
                    >
                      <i />
                      <span>
                        <strong>{resource.name}</strong>
                        <small>
                          {placed
                            ? "Bereits im Canvas · dort anzeigen"
                            : `Version ${resource.version}`}
                          {resource.description
                            ? ` · ${resource.description}`
                            : ""}
                        </small>
                      </span>
                      {placed && <Check aria-label="Bereits platziert" />}
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="library-resource-delete"
                      aria-label={`${resource.name} dauerhaft archivieren`}
                      onClick={() => onSelectArchive(resource)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type WorkflowConnectionDraft = {
  edgeId?: string;
  sourceId: string;
  targetId: string;
};

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
  const [notice, setNotice] = useState<BuilderNoticeValue | null>(null);
  const [activeWorkspace, setActiveWorkspace] =
    useState<WorkflowWorkspace>("dashboard");
  const [editorNodeId, setEditorNodeId] = useState<string | null>(null);
  const [newKind, setNewKind] = useState<WorkflowKind | null>(null);
  const [kindPickerOpen, setKindPickerOpen] = useState(false);
  const [libraryKind, setLibraryKind] = useState<WorkflowKind | null>(null);
  const [libraryArchiveTarget, setLibraryArchiveTarget] =
    useState<WorkflowResource | null>(null);
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
  const [connectionDraft, setConnectionDraft] =
    useState<WorkflowConnectionDraft | null>(null);
  const [routeOverviewOpen, setRouteOverviewOpen] = useState(false);
  const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
  const libraryTriggerRef = useRef<HTMLButtonElement>(null);
  const simulationTriggerRef = useRef<HTMLButtonElement>(null);
  const routeTriggerRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const reactFlowRef = useRef<ReactFlowInstance<Node, Edge> | null>(null);
  const fitViewPendingRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const operationalRefreshRef = useRef(false);
  const operationalRefreshQueuedRef = useRef(false);
  const closeLibrary = useCallback(() => {
    setKindPickerOpen(false);
    setLibraryKind(null);
    setLibraryArchiveTarget(null);
    window.setTimeout(() => libraryTriggerRef.current?.focus(), 0);
  }, []);
  const closeSimulation = useCallback(() => {
    setSimulationOpen(false);
    window.setTimeout(() => simulationTriggerRef.current?.focus(), 0);
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
      void reactFlowRef.current?.setCenter(
        KIND_META[node.kind].order * COLUMN_GAP +
          WORKFLOW_NODE_DIMENSIONS.width / 2,
        node.position.y + WORKFLOW_NODE_DIMENSIONS.height / 2,
        {
          zoom: 0.88,
          duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? 0
            : 160,
        },
      );
    });
  }, []);

  const showAllNodes = useCallback(() => {
    if (graphRef.current.nodes.length === 0 || fitViewPendingRef.current) return;
    fitViewPendingRef.current = true;
    setSearch("");
    window.requestAnimationFrame(() => {
      try {
        const instance = reactFlowRef.current;
        const canvas = canvasRef.current;
        if (!instance || !canvas) return;
        const { width, height } = canvas.getBoundingClientRect();
        if (width <= 0 || height <= 0) return;
        const bounds = instance.getNodesBounds(
          graphRef.current.nodes.map((node) => node.id),
        );
        const viewport = getViewportForBounds(
          bounds,
          width,
          height,
          WORKFLOW_MIN_ZOOM,
          0.88,
          0.12,
        );
        void instance.setViewport(viewport, {
          duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? 0
            : 160,
        });
      } finally {
        fitViewPendingRef.current = false;
      }
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
    setGraph(normalizeWorkflowGrid(nextSnapshot.workflow?.graph || EMPTY_GRAPH));
    setLastUpdated(Date.now());
    setLoading(false);
  }, []);

  const refreshOperationalState = useCallback(async () => {
    if (operationalRefreshRef.current) {
      operationalRefreshQueuedRef.current = true;
      return;
    }
    operationalRefreshRef.current = true;
    setRefreshing(true);
    try {
      const [tradingPayload, statusPayload, operationsPayload] = await Promise.all([
        jsonRequest("/api/trading"),
        jsonRequest("/api/status"),
        activeWorkspace === "operations"
          ? jsonRequest("/api/operations")
          : Promise.resolve(null),
      ]);
      setTrading(tradingSnapshot(tradingPayload));
      setSystemStatus(
        statusPayload && typeof statusPayload === "object"
          ? {
              ...statusPayload,
              ...(operationsPayload?.operations
                ? { operations: operationsPayload.operations }
                : {}),
            }
          : null,
      );
      setLastUpdated(Date.now());
    } finally {
      operationalRefreshRef.current = false;
      setRefreshing(false);
      if (operationalRefreshQueuedRef.current) {
        operationalRefreshQueuedRef.current = false;
        void refreshOperationalState();
      }
    }
  }, [activeWorkspace]);

  useEffect(() => {
    if (activeWorkspace !== "builder") {
      void refreshOperationalState().catch(() => undefined);
    }
  }, [activeWorkspace, refreshOperationalState]);

  useEffect(() => {
    void load().catch((error) => {
      setLoading(false);
      setNotice({ tone: "error", text: error.message });
    });
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (activeWorkspace !== "builder") {
        void refreshOperationalState().catch(() => undefined);
      }
    }, activeWorkspace === "operations" ? 3000 : 5000);
    return () => window.clearInterval(timer);
  }, [activeWorkspace, refreshOperationalState]);

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
  const publishedLibrary = useMemo(
    () => latestPublishedResources(snapshot.resources),
    [snapshot.resources],
  );
  const placedResources = useMemo(
    () => placedNodesByResourceIdentity(graph, snapshot.resources),
    [graph, snapshot.resources],
  );
  const duplicateSummary = useMemo(
    () => consolidateWorkflowResources(graph, snapshot.resources),
    [graph, snapshot.resources],
  );
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
        return;
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
        return;
      }
      const upstreamChannels = channelNodesReachingSource(
        graphRef.current,
        source.id,
      );
      if (upstreamChannels.length <= 1) {
        const candidate = structuredClone(graphRef.current);
        const edgeId = newId("edge");
        candidate.edges.push({
          id: edgeId,
          source: source.id,
          target: target.id,
          ...(upstreamChannels.length === 1
            ? { channelNodeIds: [upstreamChannels[0]] }
            : {}),
        });
        const activated = await activateGraph(candidate, "Verbindung aktiviert");
        if (activated) setSelectedEdgeId(edgeId);
        cancelConnection();
        return;
      }
      setConnectionDraft({ sourceId: source.id, targetId: target.id });
      cancelConnection();
    },
    [activateGraph, cancelConnection],
  );

  const saveConnectionRouting = useCallback(
    async (channelNodeIds?: string[]) => {
      if (!connectionDraft) return;
      const candidate = structuredClone(graphRef.current);
      let edgeId = connectionDraft.edgeId;
      if (edgeId) {
        const edge = candidate.edges.find((item) => item.id === edgeId);
        if (!edge) return;
        if (channelNodeIds) edge.channelNodeIds = [...channelNodeIds];
        else delete edge.channelNodeIds;
      } else {
        edgeId = newId("edge");
        candidate.edges.push({
          id: edgeId,
          source: connectionDraft.sourceId,
          target: connectionDraft.targetId,
          ...(channelNodeIds ? { channelNodeIds: [...channelNodeIds] } : {}),
        });
      }
      const activated = await activateGraph(
        candidate,
        connectionDraft.edgeId
          ? "Routing der Verbindung aktualisiert"
          : "Verbindung aktiviert",
      );
      if (activated) {
        setSelectedEdgeId(edgeId);
        setConnectionDraft(null);
      }
    },
    [activateGraph, connectionDraft],
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

  const connectionSource = selectedGraphNode(graph, connectionSourceId);
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

  const moveNode = useCallback(
    (nodeId: string, direction: "up" | "down") => {
      const candidate = moveWorkflowNode(graphRef.current, nodeId, direction);
      if (!candidate) {
        setNotice({
          tone: "warning",
          text:
            direction === "up"
              ? "Der Baustein steht in dieser Spalte bereits ganz oben."
              : "Der Baustein steht in dieser Spalte bereits ganz unten.",
        });
        return;
      }
      setGraph(candidate);
      void activateGraph(
        candidate,
        direction === "up"
          ? "Baustein nach oben verschoben"
          : "Baustein nach unten verschoben",
      );
    },
    [activateGraph],
  );

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
        draggable: false,
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
          onMove: moveNode,
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
    moveNode,
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
            channelNames: edge.channelNodeIds?.map((channelNodeId) => {
              const channelNode = graph.nodes.find(
                (node) => node.id === channelNodeId,
              );
              return channelNode
                ? resourceById.get(channelNode.resourceVersionId)?.name ||
                    channelNodeId
                : channelNodeId;
            }),
            pathFocusState: !selectedPathId
              ? "idle"
              : routeUsage.routeIds.includes(selectedPathId)
                ? "active"
                : "dimmed",
          } satisfies WorkflowEdgeData,
        };
      }),
    [
      graph.edges,
      graph.nodes,
      resourceById,
      routeTopology.edgeUsage,
      selectedEdgeId,
      selectedPathId,
    ],
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
    const upstreamChannels = channelNodesReachingSource(graph, edge.source);
    return {
      edge,
      sourceName: source
        ? resourceById.get(source.resourceVersionId)?.name ||
          "Unbekannte Quelle"
        : "Unbekannte Quelle",
      targetName: target
        ? resourceById.get(target.resourceVersionId)?.name || "Unbekanntes Ziel"
        : "Unbekanntes Ziel",
      channelNames: edge.channelNodeIds?.map((channelNodeId) => {
        const channelNode = graph.nodes.find(
          (node) => node.id === channelNodeId,
        );
        return channelNode
          ? resourceById.get(channelNode.resourceVersionId)?.name ||
              channelNodeId
          : channelNodeId;
      }),
      canEditScope: upstreamChannels.length > 1,
    };
  }, [graph, resourceById, selectedEdgeId]);

  const connectionDialog = useMemo(() => {
    if (!connectionDraft) return null;
    const source = graph.nodes.find(
      (node) => node.id === connectionDraft.sourceId,
    );
    const target = graph.nodes.find(
      (node) => node.id === connectionDraft.targetId,
    );
    const existing = connectionDraft.edgeId
      ? graph.edges.find((edge) => edge.id === connectionDraft.edgeId)
      : undefined;
    const channels = channelNodesReachingSource(
      graph,
      connectionDraft.sourceId,
    ).map((channelNodeId) => {
      const channelNode = graph.nodes.find((node) => node.id === channelNodeId);
      return {
        id: channelNodeId,
        name: channelNode
          ? resourceById.get(channelNode.resourceVersionId)?.name ||
            channelNodeId
          : channelNodeId,
      };
    });
    return {
      sourceName: source
        ? resourceById.get(source.resourceVersionId)?.name || "Quelle"
        : "Quelle",
      targetName: target
        ? resourceById.get(target.resourceVersionId)?.name || "Ziel"
        : "Ziel",
      channels,
      initialChannelNodeIds: existing?.channelNodeIds,
    };
  }, [connectionDraft, graph, resourceById]);

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

  const selectedNode = selectedGraphNode(graph, editorNodeId);
  const selectedResource = resourceForNode(selectedNode, resourceById);
  const editorKind = newKind || selectedNode?.kind || "channel";
  const operationalView = operationalWorkspaceView(activeWorkspace);

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
    const existing = placedResources.get(resourceBehaviorKey(resource));
    if (existing) {
      setKindPickerOpen(false);
      setLibraryKind(null);
      setLibraryArchiveTarget(null);
      setSearch("");
      setNotice({
        tone: "warning",
        text: `${resource.name} entspricht funktional bereits einem Baustein im Canvas. Für weitere Kombinationen verbindest du diesen mit mehreren Pfeilen.`,
      });
      revealNode(existing);
      return;
    }
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

  const archiveResourceFamily = async (resource: WorkflowResource) => {
    const familyNodeIds = new Set(
      graphRef.current.nodes
        .filter(
          (node) =>
            resourceById.get(node.resourceVersionId)?.resourceId ===
            resource.resourceId,
        )
        .map((node) => node.id),
    );
    if (familyNodeIds.size > 0) {
      const candidate = structuredClone(graphRef.current);
      candidate.nodes = candidate.nodes.filter(
        (node) => !familyNodeIds.has(node.id),
      );
      candidate.edges = candidate.edges.filter(
        (edge) =>
          !familyNodeIds.has(edge.source) && !familyNodeIds.has(edge.target),
      );
      const activated = await activateGraph(
        candidate,
        `${resource.name} aus dem aktiven Canvas entfernt`,
      );
      if (!activated) throw new Error("Die Archivierung wurde abgebrochen.");
    }
    await jsonRequest("/api/workflow/resources", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-Destructive-Confirmation": "delete-workflow-resource",
      },
      body: JSON.stringify({ resourceId: resource.resourceId }),
    });
    setEditorNodeId(null);
    setLibraryArchiveTarget(null);
    await load();
    setNotice({
      tone: "ok",
      text: `${resource.name} wurde dauerhaft aus der aktiven Bibliothek archiviert. Alte Revisionen bleiben prüfbar.`,
    });
  };

  const consolidateDuplicates = async () => {
    if (duplicateSummary.removedNodeCount === 0) return;
    const activated = await activateGraph(
      duplicateSummary.graph,
      `${duplicateSummary.removedNodeCount} verhaltensidentische Bausteine zusammengeführt`,
    );
    if (activated) {
      const archiveFailures: string[] = [];
      for (const resourceId of duplicateSummary.redundantResourceIds) {
        try {
          await jsonRequest("/api/workflow/resources", {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
              "X-Destructive-Confirmation": "delete-workflow-resource",
            },
            body: JSON.stringify({ resourceId }),
          });
        } catch {
          archiveFailures.push(resourceId);
        }
      }
      setEditorNodeId(null);
      setSearch("");
      await load();
      if (archiveFailures.length > 0) {
        setNotice({
          tone: "warning",
          text: `${archiveFailures.length} nicht mehr verwendete Dubletten konnten nicht archiviert werden. Der aktive Canvas ist bereits eindeutig; die verbliebenen Einträge bleiben in der Bibliothek verborgen.`,
        });
      }
      window.setTimeout(showAllNodes, 0);
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
        <Logo variant="mark" size={32} />
        <span>Lade aktive Workflow-Revision…</span>
      </div>
    );

  return (
    <main className="workflow-shell" aria-label="TSX Core Workflow Builder">
      <WorkflowTopbar
        systemStatus={systemStatus}
        trading={trading}
      />
      <WorkflowNavigation
        activeWorkspace={activeWorkspace}
        onChange={setActiveWorkspace}
      />
      {activeWorkspace === "builder" ? (
        <WorkflowStatusbar
          snapshot={snapshot}
          graph={graph}
          saving={saving}
          search={search}
          selectedPathId={selectedPathId}
          routeCount={routeTopology.routes.length}
          onSearch={setSearch}
          onRoutes={() => setRouteOverviewOpen(true)}
          onSimulation={() => setSimulationOpen(true)}
          onLibrary={() => {
            setLibraryKind(null);
            setKindPickerOpen(true);
          }}
          routeTriggerRef={routeTriggerRef}
          simulationTriggerRef={simulationTriggerRef}
          libraryTriggerRef={libraryTriggerRef}
        />
      ) : (
        <WorkspaceStatusbar
          workspace={activeWorkspace}
          onRefresh={refreshOperationalState}
          trading={trading}
          systemStatus={systemStatus}
          refreshing={refreshing}
          lastUpdated={lastUpdated}
        />
      )}
      {activeWorkspace === "builder" ? (
        <>
          {notice && (
            <BuilderNotice notice={notice} onClose={() => setNotice(null)} />
          )}
          <DuplicateResourceNotice
            removedNodeCount={duplicateSummary.removedNodeCount}
            saving={saving}
            onConsolidate={() => void consolidateDuplicates()}
          />
          <div ref={canvasRef} id="workflow-canvas" className="workflow-canvas">
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={(instance) => {
            reactFlowRef.current = instance;
          }}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onConnectStart={(_event, params) => {
            if (params.handleType === "source" && params.nodeId)
              startConnection(params.nodeId);
          }}
          isValidConnection={isValidConnection}
          nodesDraggable={false}
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
          minZoom={WORKFLOW_MIN_ZOOM}
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
          <Controls
            position="bottom-left"
            showInteractive={false}
            onFitView={showAllNodes}
          />
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
            </ReactFlow>
          </div>
        </>
      ) : (
        <OperationsWorkspace
          trading={trading}
          catalog={catalog}
          systemStatus={systemStatus}
          onRefresh={refreshOperationalState}
          ariaLabel={operationalView.ariaLabel}
          initialTab={operationalView.initialTab}
          availableTabs={operationalView.availableTabs}
        />
      )}

      <WorkflowConnectionDialog
        open={Boolean(connectionDialog)}
        sourceName={connectionDialog?.sourceName || "Quelle"}
        targetName={connectionDialog?.targetName || "Ziel"}
        channels={connectionDialog?.channels || []}
        initialChannelNodeIds={connectionDialog?.initialChannelNodeIds}
        saving={saving}
        onClose={() => setConnectionDraft(null)}
        onSave={(channelNodeIds) =>
          void saveConnectionRouting(channelNodeIds)
        }
      />
      <Dialog
        open={Boolean(selectedConnection)}
        onOpenChange={(open) => !open && setSelectedEdgeId(null)}
      >
        <DialogContent className="workflow-connection-inspector sm:max-w-lg">
          <DialogHeader>
            <Badge variant="secondary"><Link2 /> Verbindung</Badge>
            <DialogTitle>
              {selectedConnection?.sourceName} → {selectedConnection?.targetName}
            </DialogTitle>
            <DialogDescription>
              {connectionScopeDescription(selectedConnection)}
            </DialogDescription>
          </DialogHeader>
          <div className="workflow-connection-inspector-actions">
            {selectedConnection?.canEditScope && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (!selectedConnection) return;
                  setConnectionDraft({
                    edgeId: selectedConnection.edge.id,
                    sourceId: selectedConnection.edge.source,
                    targetId: selectedConnection.edge.target,
                  });
                  setSelectedEdgeId(null);
                }}
              >
                Routing bearbeiten
              </Button>
            )}
            <Button
              type="button"
              variant="destructive"
              onClick={() =>
                selectedConnection && void removeEdge(selectedConnection.edge.id)
              }
            >
              <Trash2 data-icon="inline-start" /> Verbindung löschen
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
        onArchiveResource={
          selectedResource
            ? () => archiveResourceFamily(selectedResource)
            : undefined
        }
        onConfigureAccount={configureAccount}
      />
      <ResourceLibraryDialog
        open={kindPickerOpen}
        selectedKind={libraryKind}
        resources={publishedLibrary}
        placedResources={placedResources}
        archiveTarget={libraryArchiveTarget}
        onClose={closeLibrary}
        onSelectKind={setLibraryKind}
        onCreate={(kind) => {
          setKindPickerOpen(false);
          setNewKind(kind);
          setLibraryKind(null);
        }}
        onAdd={(resource) => void addExistingResource(resource)}
        onSelectArchive={setLibraryArchiveTarget}
        onArchive={(resource) =>
          void archiveResourceFamily(resource).catch((error) => {
            setNotice({
              tone: "error",
              text: error instanceof Error ? error.message : String(error),
            });
          })
        }
      />
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
              <SimulationResult result={simulationResult} />
            </div>
          )}
        </DialogContent>
      </Dialog>
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
