import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from "@xyflow/react";
import type { CSSProperties } from "react";
import type { WorkflowRouteUsage } from "./workflow-routes";

export type WorkflowEdgeData = {
  routeUsage: WorkflowRouteUsage;
  pathFocusState: "idle" | "active" | "dimmed";
  channelNames?: string[];
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
        offset: 28,
      });

  const shared = (usage?.pathCount || 0) > 1;
  const scoped = Boolean(edge?.channelNames);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={32}
        className={`workflow-edge-path ${selected ? "is-selected" : ""} path-${focusState} ${shared ? "is-shared" : ""}`}
      />
      {(shared || scoped) && focusState !== "dimmed" && (
        <EdgeLabelRenderer>
          <div
            className="workflow-edge-label"
            style={
              {
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              } as CSSProperties
            }
            aria-hidden="true"
          >
            {scoped
              ? `${edge?.channelNames?.length || 0} Kanäle`
              : `${usage?.pathCount} Pfade`}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
