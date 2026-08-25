import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import type { CSSProperties } from "react";
import type { WorkflowRouteUsage } from "./workflow-routes";

export type WorkflowEdgeData = {
  routeUsage: WorkflowRouteUsage;
  pathFocusState: "idle" | "active" | "dimmed";
};

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
  const [path, labelX, labelY] = getSmoothStepPath({
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
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={32}
        className={`workflow-edge-path ${selected ? "is-selected" : ""} path-${focusState} ${shared ? "is-shared" : ""}`}
      />
      {shared && focusState !== "dimmed" && (
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
            {usage?.pathCount} Pfade
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
