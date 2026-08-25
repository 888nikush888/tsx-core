import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowConnectionDialog } from "@/app/workflow/workflow-connection-dialog";

afterEach(cleanup);

describe("workflow connection routing dialog", () => {
  it("keeps all-channel routing as the default", () => {
    const onSave = vi.fn();
    render(
      <WorkflowConnectionDialog
        open
        sourceName="Gemeinsamer Parser"
        targetName="Strategie A"
        channels={[
          { id: "channel-a", name: "Kanal A" },
          { id: "channel-b", name: "Kanal B" },
        ]}
        saving={false}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Routing übernehmen" }));
    expect(onSave).toHaveBeenCalledWith(undefined);
  });

  it("requires and returns an explicit channel selection", () => {
    const onSave = vi.fn();
    render(
      <WorkflowConnectionDialog
        open
        sourceName="Gemeinsamer Parser"
        targetName="Strategie B"
        channels={[
          { id: "channel-a", name: "Kanal A" },
          { id: "channel-b", name: "Kanal B" },
        ]}
        saving={false}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Nur ausgewählte Kanäle"));
    const save = screen.getByRole("button", {
      name: "Routing übernehmen",
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Kanal B" }));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(["channel-b"]);
  });
});
