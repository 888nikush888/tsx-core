import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardPage } from "@/templates/DashboardPage";
import { useDemo } from "@/adapter/demo-kontext";
import { num, pct } from "@/lib/format";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";

const verlauf = [
  { tag: "Mo", wert: 10120 }, { tag: "Di", wert: 10340 }, { tag: "Mi", wert: 10280 },
  { tag: "Do", wert: 10410 }, { tag: "Fr", wert: 10390 }, { tag: "Sa", wert: 10250 },
];

export function UebersichtSeite() {
  const { szenario, demoKonto } = useDemo();
  if (szenario === "laedt") {
    return <DashboardPage titel="Uebersicht"><div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div><Skeleton className="h-64" /></DashboardPage>;
  }
  const leer = szenario === "leer";
  return (
    <DashboardPage titel="Uebersicht" beschreibung={demoKonto === "paper-1" ? "Paper-Labor · Beispieldaten" : "Live-Testkonto (Demo) · Beispieldaten"}
      kennzahlen={leer ? [] : [
        { label: "Kontostand", wert: `${num(10250.40)} USDC`, sub: "Paper-Labor" },
        { label: "Offene Positionen", wert: num(2, 0), sub: "BTC-PERP, ETH-PERP" },
        { label: "Tagesergebnis", wert: pct(0.0118), sub: "simuliert" },
        { label: "Handlungsbedarf", wert: num(2, 0), sub: "1 Warnung, 1 Fehler (simuliert)" },
      ]}>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Kontoverlauf (simuliert)</CardTitle></CardHeader><CardContent>
          <ChartContainer config={{ wert: { label: "Kontostand", color: "var(--chart-1)" } }} className="h-56 w-full">
            <LineChart data={leer ? [] : verlauf} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="tag" /><YAxis width={60} />
              <ChartTooltip content={<ChartTooltipContent />} /><Line type="monotone" dataKey="wert" stroke="var(--chart-5)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ChartContainer>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Handlungsbedarf</CardTitle></CardHeader><CardContent>
          <ul className="flex flex-col gap-2 text-sm">
            <li>Hebelgrenze bei ETH-PERP fast erreicht – <a className="underline" href="#/risiko/limits">Limits pruefen</a>.</li>
            <li>Alarmversand meldet Fehler – <a className="underline" href="#/betrieb/logs">Diagnose oeffnen</a>.</li>
            <li>Freigabe prop-41 wartet – <a className="underline" href="#/signale/mcp">Freigaben oeffnen</a>.</li>
          </ul>
        </CardContent></Card>
      </div>
    </DashboardPage>
  );
}
