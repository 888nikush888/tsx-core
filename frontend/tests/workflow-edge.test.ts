import { describe, expect, it } from "vitest";
import { isAlignedWorkflowEdge } from "@/app/workflow/workflow-edge";

describe("workflow edge geometry", () => {
  it("uses straight geometry for blocks on the same grid row", () => {
    expect(isAlignedWorkflowEdge(150, 150)).toBe(true);
    expect(isAlignedWorkflowEdge(150, 150.49)).toBe(true);
    expect(isAlignedWorkflowEdge(150, 300)).toBe(false);
  });
});
