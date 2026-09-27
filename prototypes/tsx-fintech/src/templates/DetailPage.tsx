import type { ReactNode } from "react";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DetailPage({ pfad, titel, zusammenfassung, eigenschaften, verlauf, aktionen }: {
  pfad: { label: string; route: string }[]; titel: string; zusammenfassung?: ReactNode;
  eigenschaften?: { label: string; wert: string }[]; verlauf?: { zeit: string; text: string }[]; aktionen?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb><BreadcrumbList>
        {pfad.map((p) => (<span key={p.route} className="flex items-center gap-1.5"><BreadcrumbItem><BreadcrumbLink href={"#" + p.route}>{p.label}</BreadcrumbLink></BreadcrumbItem><BreadcrumbSeparator /></span>))}
        <BreadcrumbItem><BreadcrumbPage>{titel}</BreadcrumbPage></BreadcrumbItem>
      </BreadcrumbList></Breadcrumb>
      <div className="flex flex-wrap items-end gap-2"><h1 className="flex-1 text-xl font-semibold">{titel}</h1>{aktionen}</div>
      {zusammenfassung}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {eigenschaften ? (<Card><CardHeader><CardTitle>Eigenschaften</CardTitle></CardHeader><CardContent>
          <dl className="grid grid-cols-[160px_1fr] gap-x-3 gap-y-2 text-sm">
            {eigenschaften.map((e) => (<div key={e.label} className="contents"><dt className="text-muted-foreground">{e.label}</dt><dd className="tabular-nums">{e.wert}</dd></div>))}
          </dl></CardContent></Card>) : null}
        {verlauf ? (<Card><CardHeader><CardTitle>Verlauf</CardTitle></CardHeader><CardContent>
          <ul className="flex flex-col gap-2 text-sm">{verlauf.map((v, i) => <li key={i}><span className="text-muted-foreground">{v.zeit}</span> – {v.text}</li>)}</ul></CardContent></Card>) : null}
      </div>
    </div>
  );
}
