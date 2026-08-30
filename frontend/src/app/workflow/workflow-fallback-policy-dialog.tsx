import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { WorkflowFallbackReason } from "./types";
import {
  FALLBACK_REASON_ORDER,
  FALLBACK_REASON_PRESENTATION,
  PAIR_ONLY_FALLBACK_POLICY,
  RECOMMENDED_FALLBACK_POLICY,
  fallbackPolicyPreset,
  normalizeWorkflowFallbackPolicy,
  type WorkflowFallbackPolicyPreset,
} from "./workflow-fallback-policy";

type WorkflowFallbackPolicyDialogProps = {
  open: boolean;
  mode: "create" | "edit";
  sourceName: string;
  targetName: string;
  initialFallbackOn?: WorkflowFallbackReason[];
  saving: boolean;
  onClose: () => void;
  onSave: (fallbackOn: WorkflowFallbackReason[], applyToChain: boolean) => void;
};

export function WorkflowFallbackPolicyDialog({
  open,
  mode,
  sourceName,
  targetName,
  initialFallbackOn,
  saving,
  onClose,
  onSave,
}: Readonly<WorkflowFallbackPolicyDialogProps>) {
  const [preset, setPreset] = useState<WorkflowFallbackPolicyPreset>("recommended");
  const [selected, setSelected] = useState<WorkflowFallbackReason[]>(RECOMMENDED_FALLBACK_POLICY);
  const [applyToChain, setApplyToChain] = useState(false);

  useEffect(() => {
    if (!open) return;
    const policy = mode === "create"
      ? [...RECOMMENDED_FALLBACK_POLICY]
      : normalizeWorkflowFallbackPolicy(initialFallbackOn, "legacy");
    setSelected(policy);
    setPreset(fallbackPolicyPreset(policy));
    setApplyToChain(false);
  }, [initialFallbackOn, mode, open]);

  const choosePreset = (next: WorkflowFallbackPolicyPreset) => {
    setPreset(next);
    if (next === "pair_only") setSelected([...PAIR_ONLY_FALLBACK_POLICY]);
    if (next === "recommended") setSelected([...RECOMMENDED_FALLBACK_POLICY]);
  };
  const toggleReason = (reason: WorkflowFallbackReason) => {
    const next = selected.includes(reason)
      ? selected.filter((candidate) => candidate !== reason)
      : [...selected, reason];
    setSelected(normalizeWorkflowFallbackPolicy(next));
    setPreset("custom");
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="workflow-connection-dialog sm:max-w-xl">
        <DialogHeader>
          <Badge variant="secondary">Fallback-Regel</Badge>
          <DialogTitle>{sourceName} → {targetName}</DialogTitle>
          <DialogDescription>
            Bestimme ausschließlich die sicheren Gründe, bei denen TSX Core vor der Kontenauswahl zum nächsten Konto wechseln darf.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="workflow-connection-modes">
          <legend>Voreinstellung</legend>
          <label><input type="radio" name="fallback-preset" checked={preset === "pair_only"}
            onChange={() => choosePreset("pair_only")} /><span><strong>Nur Handelspaar</strong><small>Kompatibles Verhalten bestehender Ketten.</small></span></label>
          <label><input type="radio" name="fallback-preset" checked={preset === "recommended"}
            onChange={() => choosePreset("recommended")} /><span><strong>Empfohlen</strong><small>Paar, volles Konto und bereits belegtes Symbol.</small></span></label>
          <label><input type="radio" name="fallback-preset" checked={preset === "custom"}
            onChange={() => setPreset("custom")} /><span><strong>Benutzerdefiniert</strong><small>Wähle die erlaubten Gründe einzeln.</small></span></label>
        </fieldset>

        <fieldset className="workflow-connection-channels">
          <legend>Erlaubte Wechselgründe</legend>
          {FALLBACK_REASON_ORDER.map((reason) => (
            <label key={reason}>
              <input type="checkbox" checked={selected.includes(reason)} onChange={() => toggleReason(reason)} />
              <span><strong>{FALLBACK_REASON_PRESENTATION[reason].title}</strong><small>{FALLBACK_REASON_PRESENTATION[reason].description}</small></span>
            </label>
          ))}
        </fieldset>

        <section className="operations-card critical-dashboard-alert">
          <strong>Harte Sicherheitsgrenzen bleiben gesperrt</strong>
          <p>Kill-Switch, Tagesverlust, kritische Risiken, ungeklärte Orders, technische Fehler und unbekannte Orderausgänge werden nicht übersprungen.</p>
        </section>

        <label className="builder-toggle">
          <input type="checkbox" aria-label="Auf gesamte Kette anwenden" checked={applyToChain}
            onChange={(event) => setApplyToChain(event.target.checked)} />
          <span aria-hidden="true" /> Dieselbe Policy auf die gesamte Kette anwenden
        </label>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button type="button" disabled={saving || selected.length === 0}
            onClick={() => onSave(normalizeWorkflowFallbackPolicy(selected), applyToChain)}>
            Fallback übernehmen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
