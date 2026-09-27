import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DataTable } from "@/components/datatable";
import { DashboardPage } from "@/templates/DashboardPage";
import { DetailPage } from "@/templates/DetailPage";
import { ListPage } from "@/templates/ListPage";
import { useDemo } from "@/adapter/demo-kontext";
import { dt, eur, num } from "@/lib/format";
import { accounts, intents, orders, positions, type DemoAccount, type DemoIntent, type DemoOrder, type DemoPosition } from "@/data/fixtures";

function useSzenarioDaten<T>(voll: T[]): T[] {
  const { szenario } = useDemo();
  if (szenario === "leer") return [];
  return voll;
}

export function KontenSeite({ gehen }: { gehen: (z: string) => void }) {
  const daten = useSzenarioDaten(accounts);
  const spalten: ColumnDef<DemoAccount>[] = [
    { accessorKey: "name", header: "Name", cell: (c) => <a className="underline" href={`#/trading/konten/${c.row.original.id}`} onClick={(e) => { e.preventDefault(); gehen(`/trading/konten/${c.row.original.id}`); }}>{c.getValue<string>()}</a> },
    { accessorKey: "exchange", header: "Boerse" },
    { accessorKey: "mode", header: "Modus", cell: (c) => <Badge variant={c.getValue<string>() === "paper" ? "secondary" : "destructive"}>{c.getValue<string>() === "paper" ? "Paper" : "Live"}</Badge> },
    { accessorKey: "equity", header: "Stand", cell: (c) => <span className="tabular-nums">{eur(c.getValue<number>())}</span> },
    { accessorKey: "enabled", header: "Status", cell: (c) => (c.getValue<boolean>() ? "bereit" : "gesperrt") },
  ];
  return <ListPage titel="Konten" beschreibung="Handelskonten im Ueberblick (Beispieldaten)." aktionen={<Button size="sm">Neues Konto (Demo)</Button>}>
    <DataTable spalten={spalten} daten={daten} suchPlatzhalter="Konten filtern …" leerText="Keine Konten vorhanden." />
  </ListPage>;
}

export function KontoDetailSeite({ id, gehen }: { id: string; gehen: (z: string) => void }) {
  const konto = accounts.find((k) => k.id === id) ?? accounts[0];
  const pos = positions.filter((p) => p.accountId === konto.id);
  void gehen;
  return <DetailPage pfad={[{ label: "Konten", route: "/trading/konten" }]} titel={konto.name}
    eigenschaften={[
      { label: "Technischer Name", wert: konto.id },
      { label: "Boerse", wert: konto.exchange },
      { label: "Modus", wert: konto.mode },
      { label: "Stand", wert: `${eur(konto.equity)} ${konto.currency}` },
      { label: "Zustandsversion", wert: String(konto.stateVersion) },
    ]}
    verlauf={[{ zeit: "26.09.2026, 14:02", text: "Beispiel-Order ord-101 angelegt (simuliert)." }]}
    zusammenfassung={<Card><CardHeader><CardTitle>Positionen ({pos.length})</CardTitle></CardHeader><CardContent>
      <ul className="flex flex-col gap-1 text-sm">{pos.map((p) => <li key={p.id}>{p.symbol} · {p.side} · {num(p.size, 3)} · P/L {eur(p.pnl)}</li>)}</ul>
    </CardContent></Card>} />;
}

export function PositionenSeite() {
  const daten = useSzenarioDaten(positions);
  const spalten: ColumnDef<DemoPosition>[] = [
    { accessorKey: "symbol", header: "Symbol" },
    { accessorKey: "side", header: "Seite" },
    { accessorKey: "size", header: "Menge", cell: (c) => <span className="tabular-nums">{num(c.getValue<number>(), 3)}</span> },
    { accessorKey: "mark", header: "Marktpreis", cell: (c) => <span className="tabular-nums">{num(c.getValue<number>(), 1)}</span> },
    { accessorKey: "pnl", header: "P/L", cell: (c) => <span className="tabular-nums">{eur(c.getValue<number>())}</span> },
    { accessorKey: "leverage", header: "Hebel", cell: (c) => `${c.getValue<number>()}x` },
  ];
  return <ListPage titel="Positionen" beschreibung="Offene Positionen (Beispieldaten).">
    <DataTable spalten={spalten} daten={daten} suchPlatzhalter="Positionen filtern …" leerText="Keine offenen Positionen." />
  </ListPage>;
}

export function OrdersSeite() {
  const { rolle } = useDemo();
  const [storno, setStorno] = useState<DemoOrder | null>(null);
  const daten = useSzenarioDaten(orders);
  const spalten: ColumnDef<DemoOrder>[] = [
    { accessorKey: "id", header: "ID" },
    { accessorKey: "symbol", header: "Symbol" },
    { accessorKey: "side", header: "Seite" },
    { accessorKey: "type", header: "Typ" },
    { accessorKey: "qty", header: "Menge", cell: (c) => <span className="tabular-nums">{num(c.getValue<number>(), 3)}</span> },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
    { id: "aktion", header: "Aktion", cell: (c) => (
      <Button variant="outline" size="sm" disabled={rolle !== "admin" || c.row.original.status === "ausgefuehrt"}
        title={rolle !== "admin" ? "Fehlende Berechtigung (Demo)" : undefined}
        onClick={() => setStorno(c.row.original)}>Stornieren (Demo)</Button>) },
  ];
  return <ListPage titel="Orders" beschreibung="Orderliste mit Bestaetigungsablauf (Beispieldaten).">
    <DataTable spalten={spalten} daten={daten} suchPlatzhalter="Orders filtern …" leerText="Keine Orders." />
    <ConfirmationDialog offen={storno !== null} titel="Order stornieren?" beschreibung={`Order ${storno?.id ?? ""} wird nur in den Beispieldaten storniert.`}
      bestaetigen="Stornieren (Demo)" onSchliessen={() => setStorno(null)} onBestaetigen={() => setStorno(null)} />
  </ListPage>;
}

export function AusfuehrungenSeite() {
  const daten = useSzenarioDaten(orders.filter((o) => o.status === "ausgefuehrt"));
  const spalten: ColumnDef<DemoOrder>[] = [
    { accessorKey: "id", header: "ID" }, { accessorKey: "symbol", header: "Symbol" },
    { accessorKey: "qty", header: "Menge", cell: (c) => <span className="tabular-nums">{num(c.getValue<number>(), 3)}</span> },
    { accessorKey: "created", header: "Zeit", cell: (c) => dt(c.getValue<string>()) },
  ];
  return <ListPage titel="Ausfuehrungen" beschreibung="Abgeschlossene Ausfuehrungen (Beispieldaten).">
    <DataTable spalten={spalten} daten={daten} leerText="Keine Ausfuehrungen." />
  </ListPage>;
}

export function JournalSeite() {
  const daten = useSzenarioDaten(intents);
  const spalten: ColumnDef<DemoIntent>[] = [
    { accessorKey: "id", header: "ID" }, { accessorKey: "quelle", header: "Quelle" },
    { accessorKey: "symbol", header: "Symbol" }, { accessorKey: "seite", header: "Seite" },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
    { accessorKey: "notiz", header: "Notiz" },
  ];
  return <ListPage titel="Journal & Intents" beschreibung="Handelsabsichten mit Pruefnotizen (Beispieldaten).">
    <DataTable spalten={spalten} daten={daten} suchPlatzhalter="Intents filtern …" leerText="Keine Intents." />
  </ListPage>;
}

export function PaperSeite() {
  return <DashboardPage titel="Paper-Labor" beschreibung="Gefahrloses Testen mit Spielgeld (Beispieldaten)."
    kennzahlen={[
      { label: "Spielkapital", wert: eur(10250.40), sub: "USDC" },
      { label: "Offene Positionen", wert: "2", sub: "simuliert" },
      { label: "Auszahlbar", wert: eur(9800.00), sub: "simuliert" },
    ]}>
    <Card><CardHeader><CardTitle>Hinweis</CardTitle></CardHeader><CardContent>
      <p className="text-sm">Orders im Paper-Labor beeinflussen nur lokale Beispieldaten und niemals echte Konten.</p>
    </CardContent></Card>
  </DashboardPage>;
}
