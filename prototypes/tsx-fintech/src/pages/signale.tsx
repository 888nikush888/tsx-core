import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AutosaveField } from "@/components/autosave-field";
import { DataTable } from "@/components/datatable";
import { DetailPage } from "@/templates/DetailPage";
import { ListPage } from "@/templates/ListPage";
import { SettingsPage } from "@/templates/SettingsPage";
import { useDemo } from "@/adapter/demo-kontext";
import { demoFeldStatus, useSchreibrecht, useSzenarioDaten } from "@/lib/szenario";
import { dt, pct } from "@/lib/format";
import { proposals, signals, type DemoProposal, type DemoSignal } from "@/data/fixtures";

export function EingangSeite() {
  const daten = useSzenarioDaten(signals);
  const spalten: ColumnDef<DemoSignal>[] = [
    { accessorKey: "kanal", header: "Kanal" },
    { accessorKey: "text", header: "Nachricht" },
    { accessorKey: "zeit", header: "Zeit", cell: (c) => dt(c.getValue<string>()) },
    { accessorKey: "vertrauen", header: "Vertrauen", cell: (c) => <span className="tabular-nums">{pct(c.getValue<number>())}</span> },
  ];
  return <ListPage titel="Eingang & Alben" beschreibung="Eingehende Nachrichten (Beispieldaten).">
    <DataTable spalten={spalten} daten={daten} suchPlatzhalter="Nachrichten filtern …" leerText="Keine Nachrichten." />
  </ListPage>;
}

export function ParserSeite() {
  const zeilen = signals.map((s) => ({ id: s.id, parser: s.parser, symbol: "BTC-PERP", vertrauen: s.vertrauen, status: "uebernommen" }));
  const spalten: ColumnDef<(typeof zeilen)[number]>[] = [
    { accessorKey: "id", header: "Signal" }, { accessorKey: "parser", header: "Parser" },
    { accessorKey: "symbol", header: "Symbol" },
    { accessorKey: "vertrauen", header: "Vertrauen", cell: (c) => <span className="tabular-nums">{pct(c.getValue<number>())}</span> },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
  ];
  return <ListPage titel="Parserergebnisse" beschreibung="Auswertungsergebnisse (Beispieldaten).">
    <DataTable spalten={spalten} daten={zeilen} leerText="Keine Ergebnisse." />
  </ListPage>;
}

export function OutboxSeite() {
  const zeilen = [
    { id: "out-1", empfaenger: "#trend", text: "Tagesbericht", status: "versandt", zeit: "26.09.2026, 18:00" },
    { id: "out-2", empfaenger: "#news", text: "Warnung Hebel", status: "wartend", zeit: "26.09.2026, 16:31" },
  ];
  const spalten: ColumnDef<(typeof zeilen)[number]>[] = [
    { accessorKey: "id", header: "ID" }, { accessorKey: "empfaenger", header: "Empfaenger" },
    { accessorKey: "text", header: "Text" },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant="secondary">{c.getValue<string>()}</Badge> },
  ];
  return <ListPage titel="Outbox" beschreibung="Ausgehende Nachrichten (Beispieldaten).">
    <DataTable spalten={spalten} daten={zeilen} leerText="Outbox leer." />
  </ListPage>;
}

export function TelegramSeite() {
  return <DetailPage pfad={[{ label: "Signale", route: "/signale/eingang" }]} titel="Telegram & Queue"
    eigenschaften={[
      { label: "Anbindung", wert: "verbunden (simuliert)" },
      { label: "Warteschlange", wert: "2 Nachrichten (simuliert)" },
      { label: "Letzter Abruf", wert: "26.09.2026, 16:31" },
    ]}
    verlauf={[{ zeit: "16:31", text: "2 Nachrichten uebernommen (simuliert)." }]} />;
}

export function KiTestSeite() {
  const [antwort, setAntwort] = useState<string | null>(null);
  return <DetailPage pfad={[{ label: "Signale", route: "/signale/eingang" }]} titel="KI-Test"
    zusammenfassung={<Card><CardHeader><CardTitle>Testanfrage (simuliert)</CardTitle></CardHeader><CardContent>
      <div className="flex flex-col gap-2">
        <p className="text-sm">Frage an das Modell senden – Antwort kommt aus Fixtures, kein echter KI-Dienst.</p>
        <div><Button size="sm" onClick={() => setAntwort("Zusammenfassung: 2 Signale, Tendenz neutral (simuliert).")}>Anfrage senden (Demo)</Button></div>
        {antwort ? <p className="text-sm" role="status">{antwort}</p> : null}
      </div>
    </CardContent></Card>} />;
}

export function McpSeite({ gehen }: { gehen: (z: string) => void }) {
  const { darf: darfM, grund: grundM } = useSchreibrecht();
  const [liste, setListe] = useState(proposals);
  const datenM = useSzenarioDaten(liste);
  const spalten: ColumnDef<DemoProposal>[] = [
    { accessorKey: "id", header: "ID", cell: (c) => <a className="underline" href={`#/signale/mcp/vorschlag/${c.row.original.id}`} onClick={(e) => { e.preventDefault(); gehen(`/signale/mcp/vorschlag/${c.row.original.id}`); }}>{c.getValue<string>()}</a> },
    { accessorKey: "agent", header: "Agent" },
    { accessorKey: "aktion", header: "Aktion" },
    { accessorKey: "status", header: "Status", cell: (c) => <Badge variant={c.getValue<string>() === "wartend" ? "default" : "secondary"}>{c.getValue<string>()}</Badge> },
    { id: "freigabe", header: "Freigabe", cell: (c) => c.row.original.status === "wartend" ? (
      <span className="flex gap-1">
        <Button size="sm" variant="outline" disabled={!darfM} title={grundM} onClick={() => setListe((l) => l.map((p) => p.id === c.row.original.id ? { ...p, status: "genehmigt" } : p))}>Genehmigen (Demo)</Button>
        <Button size="sm" variant="outline" disabled={!darfM} title={grundM} onClick={() => setListe((l) => l.map((p) => p.id === c.row.original.id ? { ...p, status: "abgelehnt" } : p))}>Ablehnen (Demo)</Button>
      </span>) : null },
  ];
  return <ListPage titel="MCP & Freigaben" beschreibung="Agentenvorschlaege pruefen (Beispieldaten, nur Demo-Wirkung).">
    <DataTable spalten={spalten} daten={datenM} suchPlatzhalter="Vorschlaege filtern …" leerText="Keine Vorschlaege." />
  </ListPage>;
}

export function McpDetailSeite({ id }: { id: string }) {
  const p = proposals.find((v) => v.id === id) ?? proposals[0];
  return <DetailPage pfad={[{ label: "MCP & Freigaben", route: "/signale/mcp" }]} titel={`Vorschlag ${p.id}`}
    eigenschaften={[
      { label: "Agent", wert: p.agent }, { label: "Aktion", wert: p.aktion },
      { label: "Status", wert: p.status }, { label: "Erstellt", wert: dt(p.created) },
    ]}
    zusammenfassung={<Card><CardHeader><CardTitle>Wirkungsvorschau (simuliert)</CardTitle></CardHeader><CardContent><p className="text-sm">{p.detail}</p></CardContent></Card>} />;
}

export function ViewerSeite() {
  const { szenario } = useDemo();
  const demo = demoFeldStatus(szenario);
  return <SettingsPage titel="Telegram Viewer" beschreibung="Lesender Nachrichtenzugang (Beispieldaten)."
    zustand="gespeichert"
    gruppen={[
      { titel: "Zugang", beschreibung: "Wer darf lesen.", kinder: (
        <div className="grid max-w-xl grid-cols-1 gap-3">
          <AutosaveField demoStatus={demo} label="Zugelassene Nutzer-IDs" pfad="viewer.allowedUserIds" startwert="123456, 789012" hilfe="Kommagetrennt." />
        </div>) },
      { titel: "Darstellung", kinder: (
        <div className="grid max-w-xl grid-cols-1 gap-3">
          <AutosaveField demoStatus={demo} label="Zeitzone" pfad="viewer.timezone" startwert="Europe/Berlin" />
          <AutosaveField demoStatus={demo} label="Abrufintervall (ms)" pfad="viewer.eventPollingIntervalMs" startwert="5000" />
        </div>) },
    ]} />;
}
