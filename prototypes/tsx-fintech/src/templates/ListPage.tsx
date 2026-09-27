import type { ReactNode } from "react";

export function ListPage({ titel, beschreibung, aktionen, children }: { titel: string; beschreibung?: string; aktionen?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1"><h1 className="text-xl font-semibold">{titel}</h1>{beschreibung ? <p className="text-sm text-muted-foreground">{beschreibung}</p> : null}</div>
        {aktionen}
      </div>
      {children}
    </div>
  );
}
