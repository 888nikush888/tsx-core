import type { ReactNode } from "react";
import { useDemo } from "@/adapter/demo-kontext";
import { LadePlatzhalter, SzenarioHinweis } from "@/lib/szenario";

export function ListPage({ titel, beschreibung, aktionen, children }: { titel: string; beschreibung?: string; aktionen?: ReactNode; children: ReactNode }) {
  const { szenario } = useDemo();
  if (szenario === "laedt") {
    return <div className="flex flex-col gap-4"><div><h1 className="text-xl font-semibold">{titel}</h1></div><LadePlatzhalter /></div>;
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1"><h1 className="text-xl font-semibold">{titel}</h1>{beschreibung ? <p className="text-sm text-muted-foreground">{beschreibung}</p> : null}</div>
        {aktionen}
      </div>
      <SzenarioHinweis />
      {children}
    </div>
  );
}
