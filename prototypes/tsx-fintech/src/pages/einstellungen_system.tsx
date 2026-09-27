import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AutosaveField } from "@/components/autosave-field";
import { DataTable } from "@/components/datatable";
import { DetailPage } from "@/templates/DetailPage";
import { ListPage } from "@/templates/ListPage";
import { SettingsPage } from "@/templates/SettingsPage";
import { catalogParams } from "@/data/fixtures";
import { useDemo } from "@/adapter/demo-kontext";
import { demoFeldStatus, useSchreibrecht } from "@/lib/szenario";
import type { ColumnDef } from "@tanstack/react-table";

export function KatalogSeite() {
  const [filter, setFilter] = useState("");
  const daten = catalogParams.filter((p) => !filter || p.label.toLowerCase().includes(filter.toLowerCase()) || p.path.includes(filter));
  const spalten: ColumnDef<(typeof catalogParams)[number]>[] = [
    { accessorKey: "label", header: "Parameter" },
    { accessorKey: "path", header: "Technischer Name", cell: (c) => <code className="text-xs">{c.getValue<string>()}</code> },
    { accessorKey: "typ", header: "Typ" },
    { accessorKey: "bereich", header: "Bereich" },
    { accessorKey: "art", header: "Aenderungsart", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
  ];
  return <ListPage titel="Parameterkatalog" beschreibung="Alle 315 inventarisierten Parameter, Auszug mit 8 Beispielen (Beispieldaten).">
    <div className="flex max-w-sm flex-col gap-1.5"><Label htmlFor="katalog-suche">Katalog durchsuchen</Label>
      <Input id="katalog-suche" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Deutsch oder technischer Name …" /></div>
    <DataTable spalten={spalten} daten={daten} leerText="Keine Treffer." />
    <p className="text-xs text-muted-foreground">Vollstaendige 315-Eintrags-Matrix: docs/frontend-rebuild/parameter-coverage.json.</p>
  </ListPage>;
}

export function ZugriffSeite() {
  const { szenario: szenarioZ } = useDemo();
  const demoZ = demoFeldStatus(szenarioZ);
  const { darf: darfZ, grund: grundZ } = useSchreibrecht();
  return <SettingsPage titel="Zugriff & Secrets" beschreibung="Anmeldedaten sind write-only (Beispieldaten, Platzhalter ohne Wert)." zustand="gespeichert"
    gruppen={[
      { titel: "Boersenzugang", beschreibung: "Status und Ersetzen, kein Klartext-Readback.", kinder: (
        <div className="grid max-w-xl grid-cols-1 gap-3">
          <p className="text-sm">Status: <Badge variant="secondary">hinterlegt (simuliert)</Badge></p>
          <AutosaveField demoStatus={demoZ} label="API-Schluessel ersetzen" pfad="secrets.exchangeCredentials" startwert="" hilfe="Leer lassen behaelt den Stand. Platzhalter werden nie zurueckgeschrieben." />
          <div><Button size="sm" variant="outline" disabled={!darfZ} title={grundZ}>Rotieren (Demo)</Button></div>
        </div>) },
      { titel: "Telegram", kinder: (<div className="grid max-w-xl grid-cols-1 gap-3">
        <p className="text-sm">Bot-Token: <Badge variant="secondary">hinterlegt (simuliert)</Badge></p>
      </div>) },
    ]} />;
}

export function SystemSeite() {
  const { szenario: szenarioS } = useDemo();
  const demoS = demoFeldStatus(szenarioS);
  return <SettingsPage titel="System" beschreibung="Uebergreifende Schalter (Beispieldaten)." zustand="gespeichert"
    gruppen={[{ titel: "Betrieb", kinder: (<div className="grid max-w-xl grid-cols-1 gap-3">
      <AutosaveField demoStatus={demoS} label="Betriebsmodus" pfad="runtime.enterpriseMode" startwert="aktiv" />
      <AutosaveField demoStatus={demoS} label="Basis-URL" pfad="deployment.hostPorts" startwert="127.0.0.1:4173" />
    </div>) }]} />;
}

export function AnmeldungSeite({ gehen }: { gehen: (z: string) => void }) {
  return <DetailPage pfad={[]} titel="Anmeldung"
    zusammenfassung={<Card className="max-w-md"><CardHeader><CardTitle>Anmelden (Demo)</CardTitle>
      <CardDescription>Keine echten Zugangsdaten verwenden.</CardDescription></CardHeader><CardContent>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5"><Label htmlFor="demo-benutzer">Benutzer</Label><Input id="demo-benutzer" defaultValue="demo" /></div>
        <div><Button onClick={() => gehen("/uebersicht")}>Anmelden (Demo)</Button></div>
      </div>
    </CardContent></Card>} />;
}

export function OnboardingSeite({ gehen }: { gehen: (z: string) => void }) {
  return <DetailPage pfad={[]} titel="Erste Schritte"
    zusammenfassung={<Card className="max-w-xl"><CardHeader><CardTitle>Bootstrap (simuliert)</CardTitle></CardHeader><CardContent>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>Beispielkonto waehlen (bereits gesetzt: Paper-Labor).</li>
        <li>Parameterkatalog pruefen.</li>
        <li>Ersten Workflow ansehen.</li>
      </ol>
      <div className="mt-3"><Button onClick={() => gehen("/uebersicht")}>Fertig (Demo)</Button></div>
    </CardContent></Card>} />;
}

export function KeineBerechtigungSeite() {
  return <DetailPage pfad={[]} titel="Fehlende Berechtigung"
    zusammenfassung={<Card className="max-w-xl"><CardHeader><CardTitle>Nicht erlaubt</CardTitle></CardHeader><CardContent>
      <p className="text-sm">Die Demorolle „Lesend“ darf diese Aktion nicht ausfuehren. Rollenwechsel oben in der Kopfzeile (nur Vorschau).</p>
    </CardContent></Card>} />;
}

export function NichtGefundenSeite({ gehen }: { gehen: (z: string) => void }) {
  return <DetailPage pfad={[]} titel="Seite nicht gefunden"
    zusammenfassung={<Card className="max-w-xl"><CardHeader><CardTitle>404</CardTitle></CardHeader><CardContent>
      <p className="text-sm">Diese Adresse gibt es in der Vorschau nicht.</p>
      <div className="mt-3"><Button variant="outline" onClick={() => gehen("/uebersicht")}>Zur Uebersicht</Button></div>
    </CardContent></Card>} />;
}
