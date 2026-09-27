import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ConfirmationDialog({ offen, titel, beschreibung, bestaetigen = "Bestaetigen", onSchliessen, onBestaetigen }: {
  offen: boolean; titel: string; beschreibung: string; bestaetigen?: string; onSchliessen: () => void; onBestaetigen: () => void }) {
  return (
    <Dialog open={offen} onOpenChange={(o) => { if (!o) onSchliessen(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{titel}</DialogTitle><DialogDescription>{beschreibung}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onSchliessen}>Abbrechen</Button>
          <Button variant="destructive" onClick={onBestaetigen}>{bestaetigen}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
