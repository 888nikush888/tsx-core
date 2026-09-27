import { DemoAnbieter } from "@/adapter/demo-kontext";
import { passt, useRoute } from "@/lib/router";
import { TsxAppShell } from "@/shell/TsxAppShell";
import { UebersichtSeite } from "@/pages/uebersicht";
import { AusfuehrungenSeite, JournalSeite, KontenSeite, KontoDetailSeite, OrdersSeite, PaperSeite, PositionenSeite } from "@/pages/trading";
import { BuilderSeite, ModelleSeite, PfadeSeite, RessourcenSeite, RevisionenSeite, TestsSeite, WorkflowsSeite } from "@/pages/automationen";
import { EingangSeite, KiTestSeite, McpDetailSeite, McpSeite, OutboxSeite, ParserSeite, TelegramSeite, ViewerSeite } from "@/pages/signale";
import { AdaptivSeite, BackupsSeite, DeploymentSeite, JobsSeite, KontorisikoSeite, LogsSeite, RecoverySeite, RisikoSeite, ZustandSeite } from "@/pages/risiko_betrieb";
import { AnmeldungSeite, KeineBerechtigungSeite, KatalogSeite, NichtGefundenSeite, OnboardingSeite, SystemSeite, ZugriffSeite } from "@/pages/einstellungen_system";
import { KomponentenSeite } from "@/pages/preview-komponenten";

function Inhalt({ pfad, gehen }: { pfad: string; gehen: (z: string) => void }) {
  const route = (r: string) => passt(r, pfad);
  let p: Record<string, string> | null;
  if (pfad === "/" || pfad === "/uebersicht") return <UebersichtSeite />;
  if (pfad === "/trading/konten") return <KontenSeite gehen={gehen} />;
  if ((p = route("/trading/konten/:id"))) return <KontoDetailSeite id={p["id"]} gehen={gehen} />;
  if (pfad === "/trading/positionen") return <PositionenSeite />;
  if (pfad === "/trading/orders") return <OrdersSeite />;
  if (pfad === "/trading/ausfuehrungen") return <AusfuehrungenSeite />;
  if (pfad === "/trading/journal") return <JournalSeite />;
  if (pfad === "/trading/paper") return <PaperSeite />;
  if (pfad === "/automationen/workflows") return <WorkflowsSeite gehen={gehen} />;
  if (pfad === "/automationen/builder") return <BuilderSeite />;
  if (pfad === "/automationen/pfade") return <PfadeSeite />;
  if (pfad === "/automationen/ressourcen") return <RessourcenSeite />;
  if (pfad === "/automationen/modelle") return <ModelleSeite />;
  if (pfad === "/automationen/revisionen") return <RevisionenSeite />;
  if (pfad === "/automationen/tests") return <TestsSeite />;
  if (pfad === "/signale/eingang") return <EingangSeite />;
  if (pfad === "/signale/parser") return <ParserSeite />;
  if (pfad === "/signale/outbox") return <OutboxSeite />;
  if (pfad === "/signale/telegram") return <TelegramSeite />;
  if (pfad === "/signale/ki-test") return <KiTestSeite />;
  if (pfad === "/signale/mcp") return <McpSeite gehen={gehen} />;
  if ((p = route("/signale/mcp/vorschlag/:id"))) return <McpDetailSeite id={p["id"]} />;
  if (pfad === "/signale/viewer") return <ViewerSeite />;
  if (pfad === "/risiko/limits") return <RisikoSeite />;
  if (pfad === "/risiko/konten") return <KontorisikoSeite />;
  if (pfad === "/risiko/adaptiv") return <AdaptivSeite />;
  if (pfad === "/betrieb/zustand") return <ZustandSeite />;
  if (pfad === "/betrieb/jobs") return <JobsSeite />;
  if (pfad === "/betrieb/logs") return <LogsSeite />;
  if (pfad === "/betrieb/backups") return <BackupsSeite />;
  if (pfad === "/betrieb/recovery") return <RecoverySeite />;
  if (pfad === "/betrieb/deployment") return <DeploymentSeite />;
  if (pfad === "/einstellungen/katalog") return <KatalogSeite />;
  if (pfad === "/einstellungen/zugriff") return <ZugriffSeite />;
  if (pfad === "/einstellungen/system") return <SystemSeite />;
  if (pfad === "/anmeldung") return <AnmeldungSeite gehen={gehen} />;
  if (pfad === "/onboarding") return <OnboardingSeite gehen={gehen} />;
  if (pfad === "/keine-berechtigung") return <KeineBerechtigungSeite />;
  if (pfad === "/preview/components") return <KomponentenSeite />;
  return <NichtGefundenSeite gehen={gehen} />;
}

export function App() {
  const [pfad, gehen] = useRoute();
  const ohneShell = pfad === "/anmeldung" || pfad === "/onboarding";
  return (
    <DemoAnbieter>
      {ohneShell ? <main className="mx-auto w-full max-w-7xl px-4 py-6"><Inhalt pfad={pfad} gehen={gehen} /></main>
        : <TsxAppShell pfad={pfad} gehen={gehen}><Inhalt pfad={pfad} gehen={gehen} /></TsxAppShell>}
    </DemoAnbieter>
  );
}
