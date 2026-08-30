import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from "@xyflow/react";
import type { WorkflowRouteUsage } from "./workflow-routes";
import type { WorkflowFallbackReason } from "./types";
import { fallbackPolicyShortLabel } from "./workflow-fallback-policy";

export type WorkflowEdgeData = {
  routeUsage: WorkflowRouteUsage;
  pathFocusState: "idle" | "active" | "dimmed";
  channelNames?: string[];
  kind: "flow" | "account_fallback";
  fallbackOn?: WorkflowFallbackReason[];
};

export function isAlignedWorkflowEdge(sourceY: number, targetY: number) {
  return Math.abs(sourceY - targetY) < 0.5;
}

function stableCurveOffset(id: string): number {
  const hash = [...id].reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 0);
  return 24 + (hash % 4) * 8;
}

export function WorkflowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps) {
  const edge = data as WorkflowEdgeData | undefined;
  const usage = edge?.routeUsage;
  const focusState = edge?.pathFocusState || "idle";
  const [path, labelX, labelY] = isAlignedWorkflowEdge(sourceY, targetY)
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 12,
        offset: stableCurveOffset(id),
      });

  const shared = (usage?.pathCount || 0) > 1;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={32}
        className={`workflow-edge-path ${edge?.kind === "account_fallback" ? "is-account-fallback" : ""} ${selected ? "is-selected" : ""} path-${focusState} ${shared ? "is-shared" : ""}`}
      />
      {edge?.kind === "account_fallback" && (
        <EdgeLabelRenderer>
          <span
            className="workflow-fallback-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={`Fallback bei: ${fallbackPolicyShortLabel(edge.fallbackOn)}`}
          >
            {fallbackPolicyShortLabel(edge.fallbackOn)}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
