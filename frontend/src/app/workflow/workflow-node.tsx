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
      <div className="workflow-node-order-controls nopan">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="nodrag"
          aria-label={`${node.name} nach oben verschieben`}
          onClick={(event) => {
            event.stopPropagation();
            node.onMove(id, "up");
          }}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="nodrag"
          aria-label={`${node.name} nach unten verschieben`}
          onClick={(event) => {
            event.stopPropagation();
            node.onMove(id, "down");
          }}
        >
          <ArrowDown />
        </Button>
      </div>
      {node.kind !== "channel" && (
        <Handle
          id="flow-target"
          type="target"
          position={Position.Left}
          className={`workflow-handle is-target ${node.connectionState === "target" ? "is-ready" : ""}`}
          isConnectable={node.connectionState !== "blocked"}
        />
      )}
      {node.kind === "account" && (
        <Handle
          id="fallback-target"
          type="target"
          position={Position.Top}
          className={`workflow-handle is-target is-fallback ${node.connectionState === "target" ? "is-ready" : ""}`}
          isConnectable={node.connectionState !== "blocked"}
        />
      )}
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
          <span className="workflow-node-routing">
            {node.routeUsage.channelCount > 1 && (
              <span title={`${node.routeUsage.channelCount} Kanäle laufen hier zusammen`}>
                <GitMerge /> {node.routeUsage.channelCount} Kanäle
              </span>
            )}
            {node.routeUsage.accountCount > 1 && (
              <span title={`Dieser Baustein führt zu ${node.routeUsage.accountCount} Konten`}>
                <GitBranch /> {node.routeUsage.accountCount} Konten
              </span>
            )}
            {node.routeUsage.channelCount <= 1 &&
              node.routeUsage.accountCount <= 1 &&
              node.routeUsage.pathCount > 0 && (
                <span title="Kompilierter Ausführungspfad">
                  <Route /> {node.routeUsage.pathCount}{" "}
                  {node.routeUsage.pathCount === 1 ? "Pfad" : "Pfade"}
                </span>
              )}
            {node.routeUsage.resourceInstanceCount > 1 && (
              <span
                title={`Altbestand: derselbe Baustein ist ${node.routeUsage.resourceInstanceCount}-mal platziert und sollte zusammengeführt werden`}
              >
                <Layers3 /> Doppelt ×{node.routeUsage.resourceInstanceCount}
              </span>
            )}
          </span>
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
      {node.warning && (
        <span className="workflow-node-warning" title={node.warning}>
          !
        </span>
      )}
      {node.kind !== "output" && (
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
                    node.connectionState === "source" ? "secondary" : "outline"
                  }
                  size="icon-xs"
                  className="workflow-connect-button nodrag nopan"
                  aria-label={
                    node.connectionState === "source"
                      ? "Verbindungsauswahl schließen"
                      : `Verbindung ab ${node.name} erstellen`
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    if (node.connectionState === "source")
                      node.onCancelConnection();
                    else node.onStartConnection(id);
                  }}
                />
              }
            >
              {node.connectionState === "source" ? <X /> : <Link2 />}
            </TooltipTrigger>
            <TooltipContent side="right">
              {node.connectionState === "source"
                ? "Abbrechen"
                : "Weiter verbinden"}
            </TooltipContent>
          </Tooltip>
          {node.kind === "account" && (
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
                    variant={node.connectionState === "source" ? "secondary" : "outline"}
                    size="icon-xs"
                    className="workflow-connect-button workflow-fallback-connect-button nodrag nopan"
                    aria-label={`Fallback-Konto nach ${node.name} festlegen`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (node.connectionState === "source") node.onCancelConnection();
                      else node.onStartConnection(id, "account_fallback");
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
      )}
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
