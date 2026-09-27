import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AutosaveField } from "@/components/autosave-field";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { DataTable } from "@/components/datatable";
import { DashboardPage } from "@/templates/DashboardPage";
import { DetailPage } from "@/templates/DetailPage";
import { ListPage } from "@/templates/ListPage";
import { SettingsPage } from "@/templates/SettingsPage";
import { useState } from "react";
import { dt, time } from "@/lib/format";
import { backups, jobs, logs, riskLimits } from "@/data/fixtures";

export function RisikoSeite() {
  return <DashboardPage titel="Limits & Exposition" beschreibung="Risikogrenzen und Auslastung (Beispieldaten)."
    kennzahlen={[
      { label: "Tagesminus", wert: "-0,4 %", sub: "Grenze -2,0 %" },
      { label: "Auslastung", wert: "2 von 3", sub: "Positionen" },
      { label: "Hebel max.", wert: "3x", sub: "Warnung bei ETH-PERP" },
    ]}>
    <Card><CardHeader><CardTitle>Grenzen</CardTitle></CardHeader><CardContent>
      <ul className="flex flex-col gap-2 text-sm">{riskLimits.map((r) => (
        <li key={r.name} className="flex items-center gap-2"><Badge variant={r.zustand === "ok" ? "secondary" : "destructive"}>{r.zustand}</Badge>{r.name} · <span className="tabular-nums">{r.wert}</span></li>))}
      </ul>
    </CardContent></Card>
  </DashboardPage>;
}

export function KontorisikoSeite() {
  return <DetailPage pfad={[{ label: "Limits & Exposition", route: "/risiko/limits" }]} titel="Kontorisiko & Historie"
    eigenschaften={[
      { label: "Konto", wert: "Paper-Labor (Demo)" },
      { label: "Schlimmster Tag", wert: "-1,1 % (simuliert)" },
      { label: "Trefferquote", wert: "58 % (simuliert)" },
    ]}
    verlauf={[{ zeit: "26.09.2026", text: "Grenzpruefung bestanden (simuliert)." }]} />;
}

export function AdaptivSeite() {
  return <SettingsPage titel="Adaptive Policen" beschreibung="Selbstanpassende Regeln mit Entwurf und Freigabe (Beispieldaten)." zustand="eingegeben"
    gruppen={[
      { titel: "Niveau", kinder: (<div className="grid max-w-xl grid-cols-1 gap-3">
        <AutosaveField label="Startniveau" pfad="strategy.adaptive.startingTier" startwert="2" hilfe="1–5." />
      </div>) },
      { titel: "Freigabe", beschreibung: "Aenderungen werden erst nach Genehmigung wirksam (simuliert).", kinder: (
        <p className="text-sm text-muted-foreground">Entwurf Rev. 4 wartet auf Freigabe. <a className="underline" href="#/signale/mcp">Zu den Freigaben</a>.</p>) },
    ]} />;
}

export function ZustandSeite() {
  return <DashboardPage titel="Zustand" beschreibung="Dienste und Hintergrundarbeit (Beispieldaten)."
    kennzahlen={[
      { label: "Dienste ok", wert: "5 von 6", sub: "Alarmversand stoert" },
      { label: "Letztes Backup", wert: "06:00", sub: "geprueft (simuliert)" },
      { label: "Revision", wert: "7", sub: "Konfiguration" },
    ]}>
    <Card><CardHeader><CardTitle>Auffaelligkeiten</CardTitle></CardHeader><CardContent>
      <p className="text-sm">Alarmversand meldet Fehler seit 16:28 (simuliert). <a className="underline" href="#/betrieb/logs">Logs oeffnen</a>.</p>
    </CardContent></Card>
  </DashboardPage>;
}

export function JobsSeite() {
  const spalten: ColumnDef<(typeof jobs)[number]>[] = [
    { accessorKey: "name", header: "Auftrag" },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant={c.getValue<string>() === "ok" ? "secondary" : c.getValue<string>() === "laeuft" ? "default" : "destructive"}>{c.getValue<string>()}</Badge> },
    { accessorKey: "last", header: "Zuletzt", cell: (c) => dt(c.getValue<string>()) },
  ];
  return <ListPage titel="Wartungsauftraege" beschreibung="Geplante Hintergrundarbeit (Beispieldaten).">
    <DataTable spalten={spalten} daten={jobs} leerText="Keine Auftraege." />
  </ListPage>;
}

export function LogsSeite() {
  const spalten: ColumnDef<(typeof logs)[number]>[] = [
    { accessorKey: "zeit", header: "Zeit", cell: (c) => time(c.getValue<string>()) },
    { accessorKey: "ebene", header: "Ebene", cell: (c) => <Badge variant={c.getValue<string>() === "fehler" ? "destructive" : "secondary"}>{c.getValue<string>()}</Badge> },
    { accessorKey: "quelle", header: "Quelle" },
    { accessorKey: "text", header: "Text" },
  ];
  return <ListPage titel="Diagnose & Logs" beschreibung="Ereignisprotokoll (Beispieldaten).">
    <DataTable spalten={spalten} daten={logs} suchPlatzhalter="Logs filtern …" leerText="Keine Eintraege." />
  </ListPage>;
}

export function BackupsSeite() {
  const spalten: ColumnDef<(typeof backups)[number]>[] = [
    { accessorKey: "id", header: "ID" }, { accessorKey: "ziel", header: "Ziel" },
    { accessorKey: "zeit", header: "Zeit", cell: (c) => dt(c.getValue<string>()) },
    { accessorKey: "groesse", header: "Groesse" },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
  ];
  return <ListPage titel="Backups" beschreibung="Sicherungskopien mit Pruefstand (Beispieldaten)."
    aktionen={<><Button size="sm" variant="outline">Backup pruefen (Demo)</Button><Button size="sm">Backup erstellen (Demo)</Button></>}>
    <DataTable spalten={spalten} daten={backups} leerText="Keine Backups." />
  </ListPage>;
}

export function RecoverySeite() {
  const [offen, setOffen] = useState(false);
  return <> <DetailPage pfad={[{ label: "Backups", route: "/betrieb/backups" }]} titel="Recovery"
    aktionen={<Button variant="destructive" size="sm" onClick={() => setOffen(true)}>Wiederherstellen (Demo)</Button>}
    eigenschaften={[
      { label: "Quelle", wert: "B2 Tresor, Stand 06:00 (simuliert)" },
      { label: "Umfang", wert: "Konfiguration + Daten (simuliert)" },
    ]}
    zusammenfassung={<Card><CardHeader><CardTitle>Ablauf (simuliert)</CardTitle></CardHeader><CardContent>
      <p className="text-sm">Wiederherstellung erfordert Bestaetigung und wirkt nur auf Beispieldaten.</p>
    </CardContent></Card>} />
    <ConfirmationDialog offen={offen} titel="Wirklich wiederherstellen?" beschreibung="Nur Beispieldaten betroffen. Echte Daten bleiben unberuehrt."
      bestaetigen="Wiederherstellen (Demo)" onSchliessen={() => setOffen(false)} onBestaetigen={() => setOffen(false)} />
  </>;
}

export function DeploymentSeite() {
  return <DetailPage pfad={[{ label: "Zustand", route: "/betrieb/zustand" }]} titel="Deployment"
    eigenschaften={[
      { label: "Abbild", wert: "tsx-core:demo (simuliert)" },
      { label: "Kennung", wert: "demo-build-001" },
      { label: "Ports", wert: "127.0.0.1:4173 (Vorschau)" },
    ]} />;
}
