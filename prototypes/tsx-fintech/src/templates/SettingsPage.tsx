import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { SaveState } from "@/adapter/memory";

const STATE_LABEL: Record<SaveState, string> = { ruhig: "Gespeichert", eingegeben: "Eingegeben", speichert: "Wird gespeichert", gespeichert: "Gespeichert", ungueltig: "Ungueltig", konflikt: "Konflikt", offline: "Offline wartend" };

export function SettingsPage({ titel, beschreibung, zustand, gruppen }: { titel: string; beschreibung?: string; zustand?: SaveState; gruppen: { titel: string; beschreibung?: string; kinder: ReactNode }[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1"><h1 className="text-xl font-semibold">{titel}</h1>{beschreibung ? <p className="text-sm text-muted-foreground">{beschreibung}</p> : null}</div>
        {zustand ? <Badge variant={zustand === "ungueltig" || zustand === "konflikt" ? "destructive" : "secondary"}>{STATE_LABEL[zustand]}</Badge> : null}
      </div>
      {gruppen.map((g) => (
        <Card key={g.titel}><CardHeader><CardTitle>{g.titel}</CardTitle>{g.beschreibung ? <CardDescription>{g.beschreibung}</CardDescription> : null}</CardHeader>
          <CardContent>{g.kinder}</CardContent></Card>
      ))}
    </div>
  );
}
