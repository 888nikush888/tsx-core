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

export type WorkflowConnectionChannel = { id: string; name: string };

type WorkflowConnectionDialogProps = {
  open: boolean;
  sourceName: string;
  targetName: string;
  channels: WorkflowConnectionChannel[];
  initialChannelNodeIds?: string[];
  saving: boolean;
  onClose: () => void;
  onSave: (channelNodeIds?: string[]) => void;
};

export function WorkflowConnectionDialog({
  open,
  sourceName,
  targetName,
  channels,
  initialChannelNodeIds,
  saving,
  onClose,
  onSave,
}: Readonly<WorkflowConnectionDialogProps>) {
  const [mode, setMode] = useState<"all" | "selected">("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setMode(initialChannelNodeIds ? "selected" : "all");
    setSelectedIds(initialChannelNodeIds || []);
  }, [initialChannelNodeIds, open]);

  const toggleChannel = (channelId: string) => {
    setSelectedIds((current) =>
      current.includes(channelId)
        ? current.filter((id) => id !== channelId)
        : [...current, channelId].sort((left, right) =>
            left.localeCompare(right),
          ),
    );
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="workflow-connection-dialog sm:max-w-xl">
        <DialogHeader>
          <Badge variant="secondary">Routing festlegen</Badge>
          <DialogTitle>
            {sourceName} → {targetName}
          </DialogTitle>
          <DialogDescription>
            Bestimme, welche Ursprungskanäle diese Verbindung benutzen dürfen.
            Die Auswahl bleibt auch hinter gemeinsam genutzten Bausteinen erhalten.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="workflow-connection-modes">
          <legend>Weiterleitung</legend>
          <label>
            <input
              type="radio"
              name="workflow-connection-mode"
              checked={mode === "all"}
              onChange={() => setMode("all")}
            />
            <span>
              <strong>Alle Kanäle weiterleiten</strong>
              <small>
                Gilt automatisch auch für später hinzugefügte Kanäle, die diesen
                Baustein erreichen.
              </small>
            </span>
          </label>
          <label>
            <input
              type="radio"
              name="workflow-connection-mode"
              checked={mode === "selected"}
              onChange={() => setMode("selected")}
            />
            <span>
              <strong>Nur ausgewählte Kanäle</strong>
              <small>Die Verbindung wird auf feste Ursprungskanäle begrenzt.</small>
            </span>
          </label>
        </fieldset>

        {mode === "selected" && (
          <fieldset className="workflow-connection-channels">
            <legend>Ursprungskanäle auswählen</legend>
            {channels.map((channel) => (
              <label key={channel.id}>
                <input
                  type="checkbox"
                  checked={selectedIds.includes(channel.id)}
                  onChange={() => toggleChannel(channel.id)}
                />
                <span>{channel.name}</span>
              </label>
            ))}
            {channels.length === 0 && (
              <p>
                Dieser Ausgang wird aktuell von keinem Kanal erreicht. Verwende
                „Alle Kanäle“, bis ein vollständiger Zufluss besteht.
              </p>
            )}
          </fieldset>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            type="button"
            disabled={
              saving ||
              (mode === "selected" &&
                (selectedIds.length === 0 || channels.length === 0))
            }
            onClick={() =>
              onSave(mode === "selected" ? selectedIds : undefined)
            }
          >
            Routing übernehmen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
