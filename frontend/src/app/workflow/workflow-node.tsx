import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";
import {
  Bot,
  Braces,
  ArrowDown,
  ArrowUp,
  CircleDollarSign,
  CopyCheck,
  FileCheck2,
  Filter,
  GitBranch,
  GitMerge,
  Landmark,
  Layers3,
  Link2,
  MessageCircle,
  Route,
  ShieldCheck,
  SlidersHorizontal,
  TextSearch,
  Webhook,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { KIND_META, type WorkflowKind } from "./types";
import type { WorkflowRouteUsage } from "./workflow-routes";

const ICONS = {
  channel: MessageCircle,
  content_filter: Filter,
  keyword_filter: TextSearch,
  regex: Braces,
  parser: Bot,
  schema: FileCheck2,
  contract: ShieldCheck,
  dedupe: CopyCheck,
  strategy: SlidersHorizontal,
  sizing: CircleDollarSign,
  adaptive_risk: Route,
  account: Landmark,
  output: Webhook,
} satisfies Record<WorkflowKind, typeof MessageCircle>;

export type WorkflowNodeData = {
  kind: WorkflowKind;
  name: string;
  summary: string;
  version: number;
  enabled: boolean;
  warning?: string;
  incomingConnections: number;
  outgoingConnections: number;
  routeUsage: WorkflowRouteUsage;
  pathFocusState: "idle" | "active" | "dimmed";
  connectionState: "idle" | "source" | "target" | "blocked";
  onEdit: (nodeId: string) => void;
  onStartConnection: (nodeId: string, kind?: "flow" | "account_fallback") => void;
  onCompleteConnection: (nodeId: string) => void;
  onCancelConnection: () => void;
  onMove: (nodeId: string, direction: "up" | "down") => void;
};

function NodeOrderControls({ id, name, onMove }: Readonly<{ id: string; name: string; onMove: (nodeId: string, direction: "up" | "down") => void }>) {
  return (
      <div className="workflow-node-order-controls nopan">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="nodrag"
          aria-label={`${name} nach oben verschieben`}
          onClick={(event) => {
            event.stopPropagation();
            onMove(id, "up");
          }}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="nodrag"
          aria-label={`${name} nach unten verschieben`}
          onClick={(event) => {
            event.stopPropagation();
            onMove(id, "down");
          }}
        >
          <ArrowDown />
        </Button>
      </div>
  );
}

function NodeTargetHandles({ kind, connectionState }: Readonly<{ kind: WorkflowKind; connectionState: WorkflowNodeData["connectionState"] }>) {
  return (
    <>
      {kind !== "channel" && (
        <Handle
          id="flow-target"
          type="target"
          position={Position.Left}
          className={`workflow-handle is-target ${connectionState === "target" ? "is-ready" : ""}`}
          isConnectable={connectionState !== "blocked"}
        />
      )}
      {kind === "account" && (
        <Handle
          id="fallback-target"
          type="target"
          position={Position.Top}
          className={`workflow-handle is-target is-fallback ${connectionState === "target" ? "is-ready" : ""}`}
          isConnectable={connectionState !== "blocked"}
        />
      )}
    </>
  );
}

function NodeRoutingBadges({ routeUsage }: Readonly<{ routeUsage: WorkflowRouteUsage }>) {
  return (
          <span className="workflow-node-routing">
            {routeUsage.channelCount > 1 && (
              <span title={`${routeUsage.channelCount} Kanäle laufen hier zusammen`}>
                <GitMerge /> {routeUsage.channelCount} Kanäle
              </span>
            )}
            {routeUsage.accountCount > 1 && (
              <span title={`Dieser Baustein führt zu ${routeUsage.accountCount} Konten`}>
                <GitBranch /> {routeUsage.accountCount} Konten
              </span>
            )}
            {routeUsage.channelCount <= 1 &&
              routeUsage.accountCount <= 1 &&
              routeUsage.pathCount > 0 && (
                <span title="Kompilierter Ausführungspfad">
                  <Route /> {routeUsage.pathCount}{" "}
                  {routeUsage.pathCount === 1 ? "Pfad" : "Pfade"}
                </span>
              )}
            {routeUsage.resourceInstanceCount > 1 && (
              <span
                title={`Altbestand: derselbe Baustein ist ${routeUsage.resourceInstanceCount}-mal platziert und sollte zusammengeführt werden`}
              >
                <Layers3 /> Doppelt ×{routeUsage.resourceInstanceCount}
              </span>
            )}
          </span>
  );
}

function NodeMainButton({ id, node, meta, Icon, connectionMode }: Readonly<{
  id: string; node: WorkflowNodeData; meta: (typeof KIND_META)[WorkflowKind]; Icon: (typeof ICONS)[WorkflowKind]; connectionMode: boolean;
}>) {
  return (
      <button
        type="button"
        className="workflow-node-main nodrag"
        onClick={(event) => {
          event.stopPropagation();
          if (node.connectionState === "target") node.onCompleteConnection(id);
          else if (!connectionMode) node.onEdit(id);
        }}
        aria-label={
          node.connectionState === "target"
            ? `${node.name} als Verbindungsziel auswählen`
            : `${meta.label} ${node.name} bearbeiten`
        }
      >
        <span className="workflow-node-icon">
          <Icon size={17} strokeWidth={1.8} />
        </span>
        <span className="workflow-node-body">
          <span className="workflow-node-eyebrow">{meta.label}</span>
          <span className="workflow-node-title">{node.name}</span>
          <span className="workflow-node-summary">
            {node.connectionState === "target"
              ? "Hier verbinden"
              : node.summary}
          </span>
      <NodeRoutingBadges routeUsage={node.routeUsage} />
        </span>
        <span className="workflow-node-meta">
          <Badge variant="outline">v{node.version}</Badge>
          {(node.incomingConnections > 0 || node.outgoingConnections > 0) && (
            <span
              aria-label={`${node.incomingConnections} eingehende und ${node.outgoingConnections} ausgehende Verbindungen`}
            >
              {node.incomingConnections}·{node.outgoingConnections}
            </span>
          )}
        </span>
      </button>
  );
}

function NodeSourceControls({ id, name, kind, connectionState, onCancelConnection, onStartConnection }: Readonly<{
  id: string; name: string; kind: WorkflowKind; connectionState: WorkflowNodeData["connectionState"];
  onCancelConnection: () => void; onStartConnection: (nodeId: string, kind?: "flow" | "account_fallback") => void;
}>) {
  return (
    <>
          <Handle
            id="flow-source"
            type="source"
            position={Position.Right}
            className="workflow-handle is-source"
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant={
                    connectionState === "source" ? "secondary" : "outline"
                  }
                  size="icon-xs"
                  className="workflow-connect-button nodrag nopan"
                  aria-label={
                    connectionState === "source"
                      ? "Verbindungsauswahl schließen"
                      : `Verbindung ab ${name} erstellen`
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    if (connectionState === "source")
                      onCancelConnection();
                    else onStartConnection(id);
                  }}
                />
              }
            >
              {connectionState === "source" ? <X /> : <Link2 />}
            </TooltipTrigger>
            <TooltipContent side="right">
              {connectionState === "source"
                ? "Abbrechen"
                : "Weiter verbinden"}
            </TooltipContent>
          </Tooltip>
          {kind === "account" && (
            <>
              <Handle
                id="fallback-source"
                type="source"
                position={Position.Bottom}
                className="workflow-handle is-source is-fallback"
              />
              <Tooltip>
                <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={connectionState === "source" ? "secondary" : "outline"}
                    size="icon-xs"
                    className="workflow-connect-button workflow-fallback-connect-button nodrag nopan"
                    aria-label={`Fallback-Konto nach ${name} festlegen`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (connectionState === "source") onCancelConnection();
                      else onStartConnection(id, "account_fallback");
                    }}
                  />
                }
                >
                  <GitBranch />
                </TooltipTrigger>
                <TooltipContent side="bottom">Nächstes Fallback-Konto</TooltipContent>
              </Tooltip>
            </>
          )}
    </>
  );
}

export function WorkflowNode({ id, data, selected }: NodeProps) {
  const node = data as WorkflowNodeData;
  const meta = KIND_META[node.kind];
  const Icon = ICONS[node.kind];
  const connectionMode = node.connectionState !== "idle";
  return (
    <Card
      size="sm"
      className={`workflow-node ${selected ? "is-selected" : ""} ${node.enabled ? "" : "is-inert"} connection-${node.connectionState} path-${node.pathFocusState}`}
      style={{ "--node-accent": meta.color } as CSSProperties}
      data-connection-state={node.connectionState}
      data-path-state={node.pathFocusState}
    >
      <NodeOrderControls id={id} name={node.name} onMove={node.onMove} />
      <NodeTargetHandles kind={node.kind} connectionState={node.connectionState} />
      <NodeMainButton id={id} node={node} meta={meta} Icon={Icon} connectionMode={connectionMode} />
      {node.warning && (
        <span className="workflow-node-warning" title={node.warning}>
          !
        </span>
      )}
      {node.kind !== "output" && <NodeSourceControls id={id} name={node.name} kind={node.kind} connectionState={node.connectionState} onCancelConnection={node.onCancelConnection} onStartConnection={node.onStartConnection} />}
    </Card>
  );
}

export function ColumnHeaderNode({ data }: NodeProps) {
  const node = data as { kind: WorkflowKind };
  const meta = KIND_META[node.kind];
  return (
    <div
      className="workflow-column-header"
      style={{ "--node-accent": meta.color } as CSSProperties}
    >
      <span>{String(meta.order + 1).padStart(2, "0")}</span>
      <strong>{meta.short}</strong>
    </div>
  );
}
