import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { valueText } from "@/shared/value-text";
import { listEntries } from "@/shared/list-entries";
import { ChangeReview } from "@/shared/components/change-review";
import { EvidenceTable } from "@/shared/components/evidence";
import { RuntimeParameters } from "@/features/operations/runtime-parameters";
import { WorkflowConnectionDialog } from "@/app/workflow/workflow-connection-dialog";
import { WorkflowFallbackPolicyDialog } from "@/app/workflow/workflow-fallback-policy-dialog";
import { FALLBACK_REASON_ORDER, FALLBACK_REASON_PRESENTATION } from "@/app/workflow/workflow-fallback-policy";

afterEach(cleanup);

function EvidenceItem({ text }: Readonly<{ text: string }>) {
  const [expanded, setExpanded] = useState(false);
  return <li><button onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{text}</button></li>;
}
function EvidenceList({ items }: Readonly<{ items: string[] }>) {
  return <ul>{listEntries(items, item => item).map(({ item, key }) => <EvidenceItem key={key} text={item} />)}</ul>;
}

describe("operator UI semantic boundaries", () => {
  it("preserves explicit scalar values and readable structured evidence", () => {
    expect([undefined, null, "", 0, false, true, "0", 10n].map(valueText)).toEqual(["undefined", "null", "", "0", "false", "true", "0", "10"]);
    expect(valueText({ limit: 0, enabled: false, names: [] })).toBe('{"limit":0,"enabled":false,"names":[]}');
    expect(valueText(["a", "b"])).toBe('["a","b"]');
  });

  it("displays unfamiliar runtime object values without hiding zero or false", () => {
    render(<RuntimeParameters value={{ future: { limit: 0, enabled: false }, count: 0, enabled: false, absent: null, empty: "" }} onChange={vi.fn()} payload={{ parameters: [] }} readOnly />);
    fireEvent.click(screen.getByText(/Unbekannte Serverfelder/));
    expect(screen.getByText('future: {"limit":0,"enabled":false}')).toBeInTheDocument();
    expect(screen.getByText("count: 0")).toBeInTheDocument();
    expect(screen.getByText("enabled: nein")).toBeInTheDocument();
    expect(screen.getByText("absent: null")).toBeInTheDocument();
    expect(screen.getByText("empty: leer")).toBeInTheDocument();
  });

  it("keeps every duplicate and preserves item state across evidence reordering", () => {
    const { rerender } = render(<EvidenceList items={["Alpha", "Beta", "Alpha"]} />);
    expect(screen.getAllByRole("button", { name: "Alpha" })).toHaveLength(2);
    const beta = screen.getByRole("button", { name: "Beta" });
    fireEvent.click(beta);
    rerender(<EvidenceList items={["Beta", "Alpha", "Alpha"]} />);
    expect(screen.getByRole("button", { name: "Beta" })).toBe(beta);
    expect(beta).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: "Alpha" })).toHaveLength(2);
  });

  it("retains a named keyboard focus target around both scrollable evidence tables", () => {
    render(<><ChangeReview before={{ limit: 0 }} after={{ limit: 1 }} /><EvidenceTable caption="Kontobelege" rows={[{ id: "account", enabled: false }]} columns={[["enabled", "Freigabe"]]} /></>);
    for (const name of ["Inhaltliche Änderungen: Tabelleninhalt", "Tabellenbereich: Kontobelege"]) {
      const region = screen.getByRole("region", { name });
      expect(region).toHaveAttribute("tabindex", "0");
      expect(region).toHaveClass("overflow-x-auto");
      region.focus();
      expect(region).toHaveFocus();
    }
  });

  it("names connection radios from their visible nested labels and activates label clicks", () => {
    render(<WorkflowConnectionDialog open sourceName="Parser" targetName="Konto" channels={[]} saving={false} onClose={vi.fn()} onSave={vi.fn()} />);
    const all = screen.getByRole("radio", { name: /Alle Kanäle weiterleiten Gilt automatisch/ });
    const selected = screen.getByRole("radio", { name: /Nur ausgewählte Kanäle Die Verbindung/ });
    expect(all).toBeChecked();
    fireEvent.click(screen.getByText("Nur ausgewählte Kanäle"));
    expect(selected).toBeChecked();
    fireEvent.click(screen.getByText("Alle Kanäle weiterleiten"));
    expect(all).toBeChecked();
  });

  it("names every fallback preset and reason from the visible text", () => {
    render(<WorkflowFallbackPolicyDialog open mode="create" sourceName="Erstes Konto" targetName="Zweites Konto" saving={false} onClose={vi.fn()} onSave={vi.fn()} />);
    for (const title of ["Nur Handelspaar", "Empfohlen", "Benutzerdefiniert"]) {
      const radio = screen.getByRole("radio", { name: new RegExp(`^${title} `) });
      fireEvent.click(screen.getByText(title, { exact: true }));
      expect(radio).toBeChecked();
    }
    for (const reason of FALLBACK_REASON_ORDER) {
      const { title, description } = FALLBACK_REASON_PRESENTATION[reason];
      const input = screen.getByRole("checkbox", { name: `${title} ${description}` });
      const wasChecked = (input as HTMLInputElement).checked;
      fireEvent.click(screen.getByText(title, { exact: true }));
      expect(input).toHaveProperty("checked", !wasChecked);
    }
  });
});
