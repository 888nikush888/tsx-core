import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useConfirmationDialog } from "@/components/confirmation-dialog";

function Harness() {
  const [result, setResult] = useState("pending");
  const { confirm, confirmationDialog } = useConfirmationDialog();
  return (
    <>
      <button type="button" onClick={() => void confirm({
        title: "Konto entfernen",
        description: "Historie bleibt erhalten.",
        confirmationText: "KONTO ENTFERNEN",
        confirmLabel: "Entfernen",
        destructive: true,
      }).then((value) => setResult(value || "cancelled"))}>Öffnen</button>
      <output>{result}</output>
      {confirmationDialog}
    </>
  );
}

describe("shared confirmation dialog", () => {
  it("keeps destructive actions disabled until the exact phrase is entered", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const submit = screen.getByRole("button", { name: "Entfernen" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Zur Bestätigung exakt/), { target: { value: "falsch" } });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Zur Bestätigung exakt/), { target: { value: "KONTO ENTFERNEN" } });
    fireEvent.click(submit);
    expect(await screen.findByText("KONTO ENTFERNEN")).toBeInTheDocument();
  });
});
