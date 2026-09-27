import { useCallback, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ReactFlow, applyNodeChanges, applyEdgeChanges, type Edge, type Node, type NodeChange, type EdgeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/datatable";
import { BuilderPage } from "@/templates/BuilderPage";
import { DetailPage } from "@/templates/DetailPage";
import { ListPage } from "@/templates/ListPage";
import { useSchreibrecht, useSzenarioDaten } from "@/lib/szenario";
import { graphEdges, graphNodes, workflows, type DemoWorkflow } from "@/data/fixtures";

export function WorkflowsSeite({ gehen }: { gehen: (z: string) => void }) {
  const { darf, grund } = useSchreibrecht();
  const daten = useSzenarioDaten(workflows);
  const spalten: ColumnDef<DemoWorkflow>[] = [
    { accessorKey: "name", header: "Name", cell: (c) => <a className="underline" href="#/automationen/builder" onClick={(e) => { e.preventDefault(); gehen("/automationen/builder"); }}>{c.getValue<string>()}</a> },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
    { accessorKey: "revision", header: "Revision", cell: (c) => <span className="tabular-nums">{c.getValue<number>()}</span> },
  ];
  return <ListPage titel="Workflows" beschreibung="Automationsablaeufe (Beispieldaten)." aktionen={<Button size="sm" disabled={!darf} title={grund}>Neuer Workflow (Demo)</Button>}>
    <DataTable spalten={spalten} daten={daten} suchPlatzhalter="Workflows filtern …" leerText="Keine Workflows." />
  </ListPage>;
}

const startKnoten: Node[] = graphNodes.map((n) => ({ id: n.id, position: { x: n.x, y: n.y }, data: { label: `${n.kind}: ${n.label}` } }));
const startKanten: Edge[] = graphEdges.map((e) => ({ id: e.id, source: e.from, target: e.to }));

export function BuilderSeite() {
  const { darf: darfB, grund: grundB } = useSchreibrecht();
  const [knoten, setKnoten] = useState<Node[]>(startKnoten);
  const [kanten, setKanten] = useState<Edge[]>(startKanten);
  const [auswahl, setAuswahl] = useState<string | null>(null);
  const [entwurf, setEntwurf] = useState("Liquiditaet > 500.000");
  const onNodesChange = useCallback((c: NodeChange[]) => setKnoten((k) => applyNodeChanges(c, k)), []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => setKanten((k) => applyEdgeChanges(c, k)), []);
  const knotenInfo = graphNodes.find((n) => n.id === auswahl);
  return <BuilderPage titel="Workflow-Builder" beschreibung="Trendfolge Standard · Revision 12 (Entwurf, Beispieldaten)."
    werkzeuge={<><Button size="sm" variant="outline">Validieren (Demo)</Button><Button size="sm" variant="outline">Testlauf (Demo)</Button><Button size="sm" disabled={!darfB} title={grundB}>Veroeffentlichen (Demo)</Button></>}
    canvas={<ReactFlow nodes={knoten} edges={kanten} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onNodeClick={(_, n) => setAuswahl(n.id)} fitView attributionPosition="bottom-right" />}
    eigenschaften={knotenInfo ? (
      <div className="flex flex-col gap-2 text-sm">
        <p className="font-semibold">{knotenInfo.kind}: {knotenInfo.label}</p>
        <div><Label htmlFor="knoten-regel">Regel (Entwurf)</Label>
          <Input id="knoten-regel" value={entwurf} onChange={(e) => setEntwurf(e.target.value)} /></div>
        <p className="text-xs text-muted-foreground">Entwurf, noch nicht wirksam. Veroeffentlichung bleibt ein eigener Schritt.</p>
      </div>
    ) : undefined} />;
}

export function PfadeSeite() {
  const allePfade = [
    { pfad: "Signal → Filter", status: "aktiv", faelle: 128 },
    { pfad: "Filter → Risiko", status: "aktiv", faelle: 96 },
    { pfad: "Risiko → Order", status: "pausiert", faelle: 12 },
  ];
  const zeilen = useSzenarioDaten(allePfade);
  const spalten: ColumnDef<(typeof zeilen)[number]>[] = [
    { accessorKey: "pfad", header: "Pfad" },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
    { accessorKey: "faelle", header: "Faelle", cell: (c) => <span className="tabular-nums">{c.getValue<number>()}</span> },
  ];
  return <ListPage titel="Pfadliste" beschreibung="Ausfuehrungspfade der Workflows (Beispieldaten).">
    <DataTable spalten={spalten} daten={zeilen} leerText="Keine Pfade." />
  </ListPage>;
}

export function RessourcenSeite() {
  const { darf: darfR, grund: grundR } = useSchreibrecht();
  const alleZeilen = [
    { name: "trend-kanaele", art: "Kanal", version: 4 },
    { name: "stoppwort-filter", art: "Filter", version: 2 },
    { name: "liquiditaet-pattern", art: "Regex", version: 7 },
  ];
  const zeilen = useSzenarioDaten(alleZeilen);
  const spalten: ColumnDef<(typeof zeilen)[number]>[] = [
    { accessorKey: "name", header: "Name" }, { accessorKey: "art", header: "Art" },
    { accessorKey: "version", header: "Version", cell: (c) => <span className="tabular-nums">{c.getValue<number>()}</span> },
  ];
  return <ListPage titel="Bibliothek" beschreibung="Wiederverwendbare Ressourcen (Beispieldaten)." aktionen={<Button size="sm" disabled={!darfR} title={grundR}>Neue Ressource (Demo)</Button>}>
    <DataTable spalten={spalten} daten={zeilen} suchPlatzhalter="Ressourcen filtern …" leerText="Keine Ressourcen." />
  </ListPage>;
}

export function ModelleSeite() {
  return <DetailPage pfad={[{ label: "Automationen", route: "/automationen/workflows" }]} titel="Strategien & Modelle"
    eigenschaften={[
      { label: "Aktives Modell", wert: "Trend v3 (Demo)" },
      { label: "Trainingsstand", wert: "26.09.2026 (simuliert)" },
      { label: "Guete", wert: "0,71 (simuliert)" },
    ]}
    verlauf={[{ zeit: "24.09.2026", text: "Modell v3 freigegeben (simuliert)." }]} />;
}

export function RevisionenSeite() {
  const alleRevisionen = [
    { rev: 12, stand: "aktiv", zeit: "24.09.2026, 18:00" },
    { rev: 11, stand: "archiviert", zeit: "20.09.2026, 09:12" },
    { rev: 10, stand: "archiviert", zeit: "18.09.2026, 21:40" },
  ];
  const zeilen = useSzenarioDaten(alleRevisionen);
  const spalten: ColumnDef<(typeof zeilen)[number]>[] = [
    { accessorKey: "rev", header: "Revision", cell: (c) => <span className="tabular-nums">{c.getValue<number>()}</span> },
    { accessorKey: "stand", header: "Stand", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
    { accessorKey: "zeit", header: "Zeit" },
  ];
  return <ListPage titel="Revisionen" beschreibung="Versionierte Staende (Beispieldaten).">
    <DataTable spalten={spalten} daten={zeilen} leerText="Keine Revisionen." />
  </ListPage>;
}

export function TestsSeite() {
  const [tab, setTab] = useState("faelle");
  return <ListPage titel="Testlabor" beschreibung="Prueffaelle fuer Workflows (Beispieldaten).">
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList><TabsTrigger value="faelle">Faelle</TabsTrigger><TabsTrigger value="laeufe">Laeufe</TabsTrigger></TabsList>
      <TabsContent value="faelle"><Card><CardHeader><CardTitle>14 Faelle</CardTitle></CardHeader><CardContent><p className="text-sm">Alle bestanden (simuliert).</p></CardContent></Card></TabsContent>
      <TabsContent value="laeufe"><Card><CardHeader><CardTitle>Letzte Laeufe</CardTitle></CardHeader><CardContent><p className="text-sm">3 Laeufe, 0 Fehler (simuliert).</p></CardContent></Card></TabsContent>
    </Tabs>
  </ListPage>;
}
