import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface Kennzahl { label: string; wert: string; sub?: string; zustand?: "ok" | "warnung" | "fehler" }

export function DashboardPage({ titel, beschreibung, kennzahlen, children }: { titel: string; beschreibung?: string; kennzahlen?: Kennzahl[]; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div><h1 className="text-xl font-semibold">{titel}</h1>{beschreibung ? <p className="text-sm text-muted-foreground">{beschreibung}</p> : null}</div>
      {kennzahlen ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {kennzahlen.map((k) => (
            <Card key={k.label}><CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">{k.label}</CardTitle></CardHeader>
              <CardContent><p className="text-xl font-semibold tabular-nums">{k.wert}</p>{k.sub ? <p className="text-xs text-muted-foreground">{k.sub}</p> : null}</CardContent></Card>
          ))}
        </div>
      ) : null}
      {children}
    </div>
  );
}
