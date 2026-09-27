import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { speichern, type SaveState } from "@/adapter/memory";

export function AutosaveField({ label, pfad, startwert, hilfe, onZustand, demoStatus }: {
  label: string; pfad: string; startwert: string; hilfe?: string; onZustand?: (s: SaveState) => void; demoStatus?: SaveState }) {
  if (demoStatus) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={pfad}>{label}</Label>
        <Input id={pfad} defaultValue={startwert} aria-invalid={demoStatus === "ungueltig"} data-invalid={demoStatus === "ungueltig" ? true : undefined} />
        <p className="text-xs text-muted-foreground" role="status">
          {demoStatus === "ungueltig" ? "Ungueltig: Wert darf nicht leer sein (simuliert)." :
           demoStatus === "konflikt" ? "Konflikt: Serverseitige Aenderung pruefen (simuliert)." :
           demoStatus === "offline" ? "Offline: wartet in der Schlange (simuliert)." : ""}
        </p>
      </div>
    );
  }
  const [wert, setWert] = useState(startwert);
  const [zustand, setZustand] = useState<SaveState>("ruhig");
  const [rev, setRev] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  function melden(s: SaveState) { setZustand(s); onZustand?.(s); }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  function aendern(v: string) {
    setWert(v); melden("eingegeben");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (!v.trim()) { melden("ungueltig"); return; }
      melden("speichert");
      void speichern({ [pfad]: v }).then((r) => {
        if (r.konflikt) { melden("konflikt"); return; }
        if (!r.ok) { melden("offline"); return; }
        setRev(r.revision); melden("gespeichert");
      });
    }, 650);
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={pfad}>{label}</Label>
      <Input id={pfad} value={wert} onChange={(e) => aendern(e.target.value)}
        aria-invalid={zustand === "ungueltig"} data-invalid={zustand === "ungueltig" ? true : undefined} />
      <p className="text-xs text-muted-foreground" role="status">
        {hilfe} {zustand === "speichert" ? "· Wird gespeichert …" : zustand === "gespeichert" ? `· Gespeichert${rev ? ` (Rev. ${rev})` : ""}` :
        zustand === "ungueltig" ? "· Ungueltig: Wert darf nicht leer sein." :
        zustand === "konflikt" ? "· Konflikt: Serverseitige Aenderung pruefen." :
        zustand === "offline" ? "· Offline: wartet in der Schlange." : ""}
      </p>
    </div>
  );
}
