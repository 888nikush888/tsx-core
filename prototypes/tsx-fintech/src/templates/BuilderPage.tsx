import type { ReactNode } from "react";

export function BuilderPage({ titel, beschreibung, werkzeuge, canvas, eigenschaften }: {
  titel: string; beschreibung?: string; werkzeuge?: ReactNode; canvas: ReactNode; eigenschaften?: ReactNode }) {
  return (
    <div className="flex h-[calc(100vh-220px)] min-h-[480px] flex-col gap-3">
      <div><h1 className="text-xl font-semibold">{titel}</h1>{beschreibung ? <p className="text-sm text-muted-foreground">{beschreibung}</p> : null}</div>
      {werkzeuge ? <div className="flex flex-wrap gap-2">{werkzeuge}</div> : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_300px]">
        <div className="min-h-[320px] overflow-hidden rounded-lg border">{canvas}</div>
        <div className="overflow-auto rounded-lg border p-3">{eigenschaften ?? <p className="text-sm text-muted-foreground">Knoten auswaehlen, um Eigenschaften zu sehen.</p>}</div>
      </div>
    </div>
  );
}
