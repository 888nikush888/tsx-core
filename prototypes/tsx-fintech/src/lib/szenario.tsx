import { useDemo } from "@/adapter/demo-kontext";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState } from "react";

// Einheitliche Szenario-Hinweise fuer alle Seiten (werden in den Templates gerendert).
// Bei Demorolle "lesend" erscheint der Berechtigungshinweis zusaetzlich zum Szenario.
export function SzenarioHinweis() {
  const { szenario, rolle } = useDemo();
  const [konfliktGeloest, setKonfliktGeloest] = useState(false);
  const teile: React.ReactNode[] = [];
  if (szenario === "offline") {
    teile.push(<Alert key="sz"><AlertTitle>Verbindung unterbrochen (simuliert)</AlertTitle>
      <AlertDescription>Aenderungen warten in der Schlange und werden nach Reconnect abgeglichen. Keine Formulardaten gehen verloren.</AlertDescription></Alert>);
  } else if (szenario === "konflikt" && !konfliktGeloest) {
    teile.push(<Alert key="sz"><AlertTitle>Konflikt: serverseitige Aenderung (simuliert)</AlertTitle>
      <AlertDescription>
        <span className="block">Eigener Wert: 3 Positionen · Server: 2 Positionen. Keine automatische Ueberschreibung kritischer Werte.</span>
        <span className="mt-2 flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setKonfliktGeloest(true)}>Eigene behalten (Demo)</Button>
          <Button size="sm" variant="outline" onClick={() => setKonfliktGeloest(true)}>Server uebernehmen (Demo)</Button>
        </span>
      </AlertDescription></Alert>);
  } else if (szenario === "freigabe") {
    teile.push(<Alert key="sz"><AlertTitle>Ausstehende Freigabe (simuliert)</AlertTitle>
      <AlertDescription>Ein Entwurf wartet auf Genehmigung und ist noch nicht wirksam. <a className="underline" href="#/signale/mcp">Zu den Freigaben</a>.</AlertDescription></Alert>);
  } else if (szenario === "gespeichert") {
    teile.push(<Alert key="sz"><AlertTitle>Gespeichert (simuliert)</AlertTitle>
      <AlertDescription>Alle Aenderungen bestaetigt, Readback geprueft. „Wirksam“ erfordert zusaetzlich den Apply-Nachweis.</AlertDescription></Alert>);
  } else if (szenario === "ausstehend") {
    teile.push(<Alert key="sz"><AlertTitle>Ausstehende Aenderung (simuliert)</AlertTitle>
      <AlertDescription>Noch nicht gespeicherte Eingaben liegen vor. Beim Verlassen der Seite bleibt der Hinweis sichtbar.</AlertDescription></Alert>);
  } else if (szenario === "validierung") {
    teile.push(<Alert key="sz"><AlertTitle>Validierungsfehler (simuliert)</AlertTitle>
      <AlertDescription>2 Felder enthalten ungueltige Werte und werden nicht gespeichert.</AlertDescription></Alert>);
  } else if (szenario === "gefahr") {
    teile.push(<Alert key="sz"><AlertTitle>Gefaehrliche Aktion (simuliert)</AlertTitle>
      <AlertDescription>Kritische Befehle wirken nur auf Beispieldaten und erfordern immer eine Bestaetigung mit Wirkungsvorschau.</AlertDescription></Alert>);
  } else if (szenario === "berechtigung") {
    teile.push(<Alert key="sz"><AlertTitle>Fehlende Berechtigung (simuliert)</AlertTitle>
      <AlertDescription>Schreibende Aktionen sind gesperrt. Lesen bleibt moeglich.</AlertDescription></Alert>);
  }
  if (rolle === "lesend") {
    teile.push(<Alert key="rolle"><AlertTitle>Demorolle: Lesend (simuliert)</AlertTitle>
      <AlertDescription>Schreibende Aktionen sind mit dieser Demorolle gesperrt.</AlertDescription></Alert>);
  }
  if (teile.length === 0) return null;
  return <>{teile}</>;
}

// Laedt-Zustand: Skeletons statt Inhalt.
export function LadePlatzhalter() {
  return (
    <div className="flex flex-col gap-3" aria-label="Laedt">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24" />
      <Skeleton className="h-64" />
    </div>
  );
}

// Listen-Daten je Szenario: leer => [], sonst voll.
export function useSzenarioDaten<T>(voll: T[]): T[] {
  const { szenario } = useDemo();
  if (szenario === "leer") return [];
  return voll;
}

// Schreibrecht: Admin-Rolle UND kein Berechtigungs-Szenario.
export function useSchreibrecht(): { darf: boolean; grund?: string } {
  const { rolle, szenario } = useDemo();
  if (rolle !== "admin") return { darf: false, grund: "Fehlende Berechtigung: Demorolle Lesend (simuliert)" };
  if (szenario === "berechtigung") return { darf: false, grund: "Fehlende Berechtigung (Szenario, simuliert)" };
  return { darf: true };
}

// Feld-Demostatus aus Szenario ableiten (fuer Settings-Seiten).
export function demoFeldStatus(s: string): "ungueltig" | "konflikt" | "offline" | undefined {
  if (s === "validierung") return "ungueltig";
  if (s === "konflikt") return "konflikt";
  if (s === "offline") return "offline";
  return undefined;
}
