import { describe, expect, it } from "vitest";
import { getSmoothStepPath, Position, type EdgeProps } from "@xyflow/react";
import { isAlignedWorkflowEdge, WorkflowEdge } from "@/app/workflow/workflow-edge";

describe("workflow edge geometry", () => {
  it("uses straight geometry for blocks on the same grid row", () => {
    expect(isAlignedWorkflowEdge(150, 150)).toBe(true);
    expect(isAlignedWorkflowEdge(150, 150.49)).toBe(true);
    expect(isAlignedWorkflowEdge(150, 300)).toBe(false);
  });
  it.each([["", 24], ["A", 32], ["😀", 32], ["\uDC00", 24]] as const)("preserves the curve for ID %j", (id, offset) => {
    const props: EdgeProps = {
      id, source: "source", target: "target", sourceX: 0, sourceY: 10,
      targetX: 20, targetY: 100, sourcePosition: Position.Right, targetPosition: Position.Left,
    };
    const edge = WorkflowEdge(props);
    const [expectedPath] = getSmoothStepPath({ ...props, borderRadius: 12, offset });
    expect(edge.props.children[0].props.path).toBe(expectedPath);
  });
});
