import {
  BaseEdge,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from "@xyflow/react";
import type { WorkflowRouteUsage } from "./workflow-routes";

export type WorkflowEdgeData = {
  routeUsage: WorkflowRouteUsage;
  pathFocusState: "idle" | "active" | "dimmed";
  channelNames?: string[];
  kind: "flow" | "account_fallback";
};

export function isAlignedWorkflowEdge(sourceY: number, targetY: number) {
  return Math.abs(sourceY - targetY) < 0.5;
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
  const [path] = isAlignedWorkflowEdge(sourceY, targetY)
    ? getStraightPath({ sourceX, sourceY, targetX, targetY })
    : getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        borderRadius: 12,
        offset: 28,
      });

  const shared = (usage?.pathCount || 0) > 1;
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      interactionWidth={32}
      className={`workflow-edge-path ${edge?.kind === "account_fallback" ? "is-account-fallback" : ""} ${selected ? "is-selected" : ""} path-${focusState} ${shared ? "is-shared" : ""}`}
    />
  );
}
