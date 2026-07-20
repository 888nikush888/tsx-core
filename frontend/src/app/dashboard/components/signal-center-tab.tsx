import { useEffect } from "react"
import { BrainCircuit, FileCode, Filter, Inbox, LayoutDashboard, ListTree, Save, Settings2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChannelsTab } from "./channels-tab"
import { FiltersTab } from "./filters-tab"
import { MessagesTab } from "./messages-tab"
import { OptionsTab } from "./options-tab"
import { ParserTab } from "./parser-tab"
import { SignalsTab } from "./signals-tab"

export type SignalWorkspace = "overview" | "messages" | "signals" | "channels" | "processing" | "filters" | "parser"

const WORKSPACES: Array<{ id: SignalWorkspace; label: string; icon: typeof LayoutDashboard }> = [
  { id: "overview", label: "Betrieb", icon: LayoutDashboard },
  { id: "messages", label: "Nachrichten", icon: Inbox },
  { id: "signals", label: "Signale", icon: FileCode },
  { id: "channels", label: "Kanäle", icon: ListTree },
  { id: "processing", label: "Verarbeitung", icon: Settings2 },
  { id: "filters", label: "Filter", icon: Filter },
  { id: "parser", label: "KI-Parser", icon: BrainCircuit },
]

const CONFIG_WORKSPACES = new Set<SignalWorkspace>(["channels", "processing", "filters", "parser"])

export function normalizeSignalWorkspace(value: string | null | undefined): SignalWorkspace {
  return WORKSPACES.some((workspace) => workspace.id === value) ? value as SignalWorkspace : "overview"
}

function Metric({ label, value, detail }: { label: string; value: string | number; detail: string }) {
  return <Card><CardHeader className="pb-2"><CardDescription>{label}</CardDescription><CardTitle className="text-3xl">{value}</CardTitle></CardHeader><CardContent className="text-xs text-muted-foreground">{detail}</CardContent></Card>
}

function Overview({ config, secretStatus }: { config: any; secretStatus: any }) {
  const sources = Array.isArray(config?.sourceChannels) ? config.sourceChannels.length : 0
  const parserEnabled = Boolean(config?.xmlParsing?.enabled)
  const parserReady = !parserEnabled || Boolean(secretStatus?.openRouterApiKey?.configured)
  const routeReady = sources > 0 && Boolean(config?.targetChannel)
  const filterCount = [
    ...(config?.filters?.blockedKeywords || []),
    ...(config?.filters?.regexPatterns || []),
  ].filter((value) => String(value).trim()).length

  return <div className="space-y-5">
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Metric label="Quellkanäle" value={sources} detail="Parallel überwachte Telegram-Kanäle" />
      <Metric label="Ziel-Routing" value={routeReady ? "bereit" : "offen"} detail="Quelle und Ziel vollständig konfiguriert" />
      <Metric label="KI-Parser" value={parserEnabled ? (parserReady ? "bereit" : "Key fehlt") : "aus"} detail="Parser und OpenRouter-Zugang" />
      <Metric label="Globale Filter" value={filterCount} detail="Keywords und reguläre Ausdrücke" />
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Signal-Pipeline</CardTitle><CardDescription>Alle signalbezogenen Einstellungen und Nachweise sind in diesem Control Center gebündelt.</CardDescription></CardHeader><CardContent className="space-y-3 text-sm">
        <StatusRow label="Kanal-Routing" ready={routeReady} />
        <StatusRow label="KI-Parser-Zugang" ready={parserReady} />
        <StatusRow label="Duplikat-Schutz" ready={Boolean(config?.dupeBlocker?.enabled)} optional />
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Arbeitsbereiche</CardTitle><CardDescription>Verlauf und Konfiguration bleiben getrennt, sind aber ohne Sidebar-Sprünge erreichbar.</CardDescription></CardHeader><CardContent className="grid gap-2 text-sm sm:grid-cols-2">
        <WorkspaceHint title="Nachrichten" text="Rohverlauf und Routing-Status" />
        <WorkspaceHint title="Signale" text="Extrahierte XML-Signale" />
        <WorkspaceHint title="Kanäle & Verarbeitung" text="Telegram, Ziel und Queue" />
        <WorkspaceHint title="Filter & KI-Parser" text="Grenzprüfung, Templates und Modelle" />
      </CardContent></Card>
    </div>
  </div>
}

function StatusRow({ label, ready, optional = false }: { label: string; ready: boolean; optional?: boolean }) {
  return <div className="flex items-center justify-between rounded-md border p-3"><span>{label}</span><Badge variant={ready ? "default" : "secondary"}>{ready ? "bereit" : optional ? "optional / aus" : "offen"}</Badge></div>
}

function WorkspaceHint({ title, text }: { title: string; text: string }) {
  return <div className="rounded-md border p-3"><div className="font-medium">{title}</div><div className="mt-1 text-xs text-muted-foreground">{text}</div></div>
}

export function SignalCenterTab({
  config,
  setConfig,
  secretStatus,
  secretDraft,
  setSecretDraft,
  telegramLogin,
  setTelegramLogin,
  workspace,
  onWorkspaceChange,
  onSave,
  isSaving,
}: {
  config: any
  setConfig: (value: any) => void
  secretStatus: any
  secretDraft: { telegramApiHash: string; openRouterApiKey: string }
  setSecretDraft: (update: (current: { telegramApiHash: string; openRouterApiKey: string }) => { telegramApiHash: string; openRouterApiKey: string }) => void
  telegramLogin: any
  setTelegramLogin: (value: any) => void
  workspace: SignalWorkspace
  onWorkspaceChange: (workspace: SignalWorkspace) => void
  onSave: () => Promise<void>
  isSaving: boolean
}) {
  useEffect(() => {
    if (!WORKSPACES.some((item) => item.id === workspace)) onWorkspaceChange("overview")
  }, [onWorkspaceChange, workspace])

  if (!config) return <Card><CardContent className="flex min-h-64 items-center justify-center text-muted-foreground">Signal-Control-Plane wird geladen…</CardContent></Card>

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center gap-2">
      {WORKSPACES.map(({ id, label, icon: Icon }) => <Button key={id} variant={workspace === id ? "default" : "outline"} size="sm" onClick={() => onWorkspaceChange(id)}><Icon className="mr-2 h-4 w-4" />{label}</Button>)}
      {CONFIG_WORKSPACES.has(workspace) && <Button size="sm" className="ml-auto" onClick={() => void onSave()} disabled={isSaving}><Save className="mr-2 h-4 w-4" />{isSaving ? "Speichert…" : "Konfiguration speichern"}</Button>}
    </div>
    {workspace === "overview" && <Overview config={config} secretStatus={secretStatus} />}
    {workspace === "messages" && <MessagesTab />}
    {workspace === "signals" && <SignalsTab config={config} />}
    {workspace === "channels" && <ChannelsTab config={config} setConfig={setConfig} secretStatus={secretStatus.telegramApiHash} secretValue={secretDraft.telegramApiHash} setSecretValue={(value: string) => setSecretDraft((current) => ({ ...current, telegramApiHash: value }))} telegramLogin={telegramLogin} setTelegramLogin={setTelegramLogin} />}
    {workspace === "processing" && <OptionsTab config={config} setConfig={setConfig} />}
    {workspace === "filters" && <FiltersTab config={config} setConfig={setConfig} />}
    {workspace === "parser" && <ParserTab config={config} setConfig={setConfig} secretStatus={secretStatus.openRouterApiKey} secretValue={secretDraft.openRouterApiKey} setSecretValue={(value: string) => setSecretDraft((current) => ({ ...current, openRouterApiKey: value }))} />}
  </div>
}
