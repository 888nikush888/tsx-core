import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bot,
  BriefcaseBusiness,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  DatabaseBackup,
  Gauge,
  Layers3,
  Play,
  RefreshCw,
  Route,
  ShieldCheck,
  Square,
  TrendingUp,
  WalletCards,
  Wifi,
  WifiOff,
} from "lucide-react"
import { Area, AreaChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { apiFetch } from "@/lib/api"
import { ChartAreaInteractive, type MetricPoint } from "./chart-area-interactive"
import { buildDashboardViewModel, type DashboardDataInput } from "./executive-dashboard-model"

const API_BASE = window.location.origin

type SetupStep = { label: string; complete: boolean }
type QueueState = { running: number; queued: number; maxConcurrency: number; paused: boolean }

interface ExecutiveDashboardProps {
  isRunning: boolean
  connectionState: string
  totalForwardedCount: number
  processedSinceRestart: number
  forwardingEnabled: boolean
  forwardXmlToTarget: boolean
  uptime: string
  queue: QueueState
  parserEnabled: boolean
  setupSteps: SetupStep[]
  setupComplete: boolean
  routingConfigReady: boolean
  metricsHistory: MetricPoint[]
  onToggleRouting: () => void | Promise<void>
  onNavigate: (tab: string) => void
}

const performanceConfig = {
  pnl: { label: "Realisierter PnL", color: "var(--chart-1)" },
} satisfies ChartConfig

function number(value: number, digits = 0): string {
  return new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
}

function compact(value: number): string {
  return new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 2 }).format(value)
}

function signed(value: number): string {
  return `${value > 0 ? "+" : ""}${number(value, 2)}`
}

function dateTime(value: number | null | undefined): string {
  if (!value) return "Noch nicht verfügbar"
  return new Date(value).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function statusStyle(tone: "good" | "warning" | "bad" | "neutral"): string {
  if (tone === "good") return "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
  if (tone === "warning") return "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400"
  if (tone === "bad") return "border-destructive/20 bg-destructive/10 text-destructive"
  return "border-border bg-muted/40 text-muted-foreground"
}

function HealthBadge({ value, good = "Healthy", bad = "Störung" }: { value: boolean | null; good?: string; bad?: string }) {
  const tone = value === true ? "good" : value === false ? "bad" : "neutral"
  return <Badge variant="outline" className={statusStyle(tone)}>{value === null ? "Nicht verfügbar" : value ? good : bad}</Badge>
}

function MetricCard({
  label,
  value,
  detail,
  icon,
  tone = "neutral",
}: {
  label: string
  value: string
  detail: string
  icon: ReactNode
  tone?: "neutral" | "positive" | "negative"
}) {
  return (
    <Card className="overflow-hidden transition-colors hover:border-primary/30">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
            <p className={`mt-2 truncate text-2xl font-semibold tabular-nums ${tone === "positive" ? "text-emerald-600 dark:text-emerald-400" : tone === "negative" ? "text-destructive" : ""}`}>{value}</p>
          </div>
          <div className="rounded-lg border bg-muted/40 p-2.5 text-primary">{icon}</div>
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function StatusRow({ icon, label, detail, state }: { icon: ReactNode; label: string; detail: string; state: boolean | null }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className={`rounded-md border p-2 ${state === true ? statusStyle("good") : state === false ? statusStyle("bad") : statusStyle("neutral")}`}>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <HealthBadge value={state} good="Bereit" bad="Prüfen" />
    </div>
  )
}

async function getJson(path: string): Promise<any> {
  const response = await apiFetch(`${API_BASE}${path}`)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.json()
}

export function ExecutiveDashboard(props: ExecutiveDashboardProps) {
  const [data, setData] = useState<DashboardDataInput>({ messages: [], signals: [], outbox: [] })
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [dataWarning, setDataWarning] = useState("")
  const mounted = useRef(true)
  const refreshInFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    const endpoints = [
      ["trading", "/api/trading"],
      ["operations", "/api/operations"],
      ["messages", "/api/incoming-messages"],
      ["signals", "/api/processed-signals"],
      ["outbox", "/api/outbox?status=pending,preparing,sending,failed,unknown"],
    ] as const
    const results = await Promise.allSettled(endpoints.map(([, path]) => getJson(path)))
    const next: DashboardDataInput = {}
    const failures: string[] = []
    results.forEach((result, index) => {
      const [name] = endpoints[index]
      if (result.status === "rejected") {
        failures.push(name)
        return
      }
      const payload = result.value
      if (name === "trading") next.trading = payload
      if (name === "operations") next.operations = payload.operations || {}
      if (name === "messages") next.messages = payload.messages || []
      if (name === "signals") next.signals = payload.signals || []
      if (name === "outbox") next.outbox = payload.tasks || []
    })
    if (mounted.current) {
      setData((current) => ({ ...current, ...next }))
      setDataWarning(failures.length > 0 ? `Teilweise veraltet: ${failures.join(", ")}` : "")
      setLastUpdated(Date.now())
      setRefreshing(false)
    }
    refreshInFlight.current = false
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const interval = window.setInterval(() => void refresh(), 10_000)
    return () => {
      mounted.current = false
      window.clearInterval(interval)
    }
  }, [refresh])

  const model = useMemo(() => buildDashboardViewModel(data), [data])
  const routingHealthy = props.isRunning && props.connectionState === "connected" && !props.queue.paused
  const tradingHealthy = !model.trading.killSwitchActive
    && model.trading.unknownOrderCount === 0
    && model.trading.criticalRiskEvents === 0
  const dataHealthy = !dataWarning && Boolean(lastUpdated)
  const operationalChecks = [
    routingHealthy,
    tradingHealthy,
    model.operations.backupHealthy,
    model.operations.retentionHealthy,
    model.operations.auditHealthy,
    dataHealthy,
  ]
  const knownChecks = operationalChecks.filter((value) => value !== null)
  const passedChecks = knownChecks.filter(Boolean).length
  const criticalIssues = [
    model.trading.killSwitchActive,
    model.trading.unknownOrderCount > 0,
    model.trading.criticalRiskEvents > 0,
    model.operations.backupHealthy === false,
    model.operations.auditHealthy === false,
  ].filter(Boolean).length
  const paperPnlTone = model.finance.paperRealizedPnl > 0 ? "positive" : model.finance.paperRealizedPnl < 0 ? "negative" : "neutral"
  const feeLabel = model.finance.mixedFeeAssets
    ? "Mehrere Assets"
    : `${number(model.finance.feeTotal, 4)}${model.finance.feeAsset ? ` ${model.finance.feeAsset}` : ""}`

  return (
    <div className="space-y-6 px-4 pb-10 lg:px-6">
      <section className="relative overflow-hidden rounded-xl border bg-card p-5 shadow-sm md:p-6">
        <div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-primary/10 to-transparent" />
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={statusStyle(criticalIssues > 0 ? "bad" : routingHealthy ? "good" : "warning")}>
                {criticalIssues > 0 ? `${criticalIssues} kritische Hinweise` : routingHealthy ? "System operativ" : "System eingeschränkt"}
              </Badge>
              <span className="text-xs text-muted-foreground">{passedChecks}/{knownChecks.length} bekannte Checks grün</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Executive Operations Dashboard</h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Finanzen, Trading, Signalfluss und Plattformzustand in einer belastbaren Echtzeitansicht.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-1 text-right text-xs text-muted-foreground">
              <div>{dataWarning || (lastUpdated ? `Live · ${dateTime(lastUpdated)}` : "Daten werden geladen")}</div>
              <div>Automatische Aktualisierung alle 10 Sekunden</div>
            </div>
            <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={refreshing} aria-label="Dashboard aktualisieren">
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
            <Button
              onClick={() => void props.onToggleRouting()}
              disabled={!props.isRunning && !props.routingConfigReady}
              className={props.isRunning ? "bg-red-600 text-white hover:bg-red-500" : ""}
            >
              {props.isRunning ? <><Square className="mr-2 h-4 w-4 fill-current" />Routing stoppen</> : <><Play className="mr-2 h-4 w-4 fill-current" />Routing starten</>}
            </Button>
          </div>
        </div>
      </section>

      {!props.setupComplete && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-semibold">Inbetriebnahme · {props.setupSteps.filter((step) => step.complete).length}/{props.setupSteps.length} abgeschlossen</p>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
                  {props.setupSteps.map((step) => <span key={step.label} className="flex items-center gap-1.5">{step.complete ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <span className="h-4 w-4 rounded-full border" />}{step.label}</span>)}
                </div>
              </div>
              <Button variant="outline" onClick={() => props.onNavigate("signals")}>Setup öffnen<ArrowRight className="ml-2 h-4 w-4" /></Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Finanzübersicht</h2>
          <p className="text-xs text-muted-foreground">Paper-Werte sind klar von Live-Börsenkonten getrennt; es findet keine Währungsumrechnung statt.</p>
        </div>
        <Badge variant="outline">Quelle: persistierte Trading-Daten</Badge>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Paper Equity" value={number(model.finance.paperEquity, 2)} detail={`${number(model.finance.paperUtilizationPercent, 1)} % gebunden · konfigurierte Quote-Einheiten`} icon={<WalletCards className="h-5 w-5" />} />
        <MetricCard label="Verfügbares Kapital" value={number(model.finance.paperAvailable, 2)} detail="Sofort verfügbar im integrierten Paper Exchange" icon={<CircleDollarSign className="h-5 w-5" />} />
        <MetricCard label="Realisierter Paper-PnL" value={signed(model.finance.paperRealizedPnl)} detail={`${model.trading.closedPositionCount} geschlossene Managed Positionen`} icon={model.finance.paperRealizedPnl >= 0 ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />} tone={paperPnlTone} />
        <MetricCard label="Offenes Notional" value={compact(model.finance.openNotional)} detail={`Risiko bis Stop ca. ${number(model.finance.openRisk, 2)} · Anzeige aus Entry/Stop`} icon={<BriefcaseBusiness className="h-5 w-5" />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,0.8fr)]">
        <ChartAreaInteractive data={props.metricsHistory} />
        <Card>
          <CardHeader>
            <CardTitle>Operational Readiness</CardTitle>
            <CardDescription>Die wichtigsten Kontrollpunkte für einen sicheren Betrieb.</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            <StatusRow icon={routingHealthy ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />} label="Routing & Telegram" detail={`${props.connectionState} · Uptime ${props.uptime}`} state={routingHealthy} />
            <StatusRow icon={<ShieldCheck className="h-4 w-4" />} label="Trading Safety" detail={`${model.trading.unknownOrderCount} unknown Orders · ${model.trading.criticalRiskEvents} kritische Events`} state={tradingHealthy} />
            <StatusRow icon={<DatabaseBackup className="h-4 w-4" />} label="Backup" detail={dateTime(model.operations.backupLastSuccessAt)} state={model.operations.backupHealthy} />
            <StatusRow icon={<Layers3 className="h-4 w-4" />} label="Retention" detail={dateTime(model.operations.retentionLastSuccessAt)} state={model.operations.retentionHealthy} />
            <StatusRow icon={<Activity className="h-4 w-4" />} label="Audit Trail" detail={model.operations.auditRemoteRequired ? `Remote · ${dateTime(model.operations.auditLastRemoteSuccessAt)}` : "Lokale Audit-Kette"} state={model.operations.auditHealthy} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3"><div><CardTitle>Signal-Funnel</CardTitle><CardDescription>Gleitendes Fenster der letzten 100 Datensätze.</CardDescription></div><Bot className="h-5 w-5 text-primary" /></div>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              ["Nachrichten erfasst", model.signals.sampleSize, 100],
              ["Verarbeitet", model.signals.processedCount, model.signals.sampleSize],
              ["Signale extrahiert", model.signals.extractedCount, model.signals.sampleSize],
            ].map(([label, value, maximum]) => {
              const percent = Number(maximum) > 0 ? Math.min(100, Number(value) / Number(maximum) * 100) : 0
              return <div key={String(label)}><div className="mb-1.5 flex justify-between text-sm"><span>{label}</span><span className="font-medium tabular-nums">{value}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div></div>
            })}
            <div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/20 p-3 text-center">
              <div><p className="text-lg font-semibold tabular-nums">{model.signals.filteredCount}</p><p className="text-[11px] text-muted-foreground">Gefiltert</p></div>
              <div><p className="text-lg font-semibold tabular-nums">{model.signals.duplicateCount}</p><p className="text-[11px] text-muted-foreground">Duplikate</p></div>
              <div><p className={`text-lg font-semibold tabular-nums ${model.signals.failedCount ? "text-destructive" : ""}`}>{model.signals.failedCount}</p><p className="text-[11px] text-muted-foreground">Fehler</p></div>
            </div>
            <Button variant="ghost" className="w-full justify-between" onClick={() => props.onNavigate("signals")}>Signal Control Center<ArrowRight className="h-4 w-4" /></Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3"><div><CardTitle>Trading Pulse</CardTitle><CardDescription>Execution, Routen und Managed Trades.</CardDescription></div><TrendingUp className="h-5 w-5 text-primary" /></div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Managed Win Rate</p><p className="mt-1 text-xl font-semibold tabular-nums">{model.trading.winRatePercent === null ? "–" : `${number(model.trading.winRatePercent, 1)} %`}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Paper Profit Factor</p><p className="mt-1 text-xl font-semibold tabular-nums">{model.trading.profitFactor === null ? "–" : Number.isFinite(model.trading.profitFactor) ? number(model.trading.profitFactor, 2) : "∞"}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Offene Positionen</p><p className="mt-1 text-xl font-semibold tabular-nums">{model.trading.openPositionCount}</p></div>
              <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Aktive Routen</p><p className="mt-1 text-xl font-semibold tabular-nums">{model.trading.enabledRouteCount}</p></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className={statusStyle(model.trading.executionEnabled ? "good" : "neutral")}>Execution {model.trading.executionEnabled ? "an" : "aus"}</Badge>
              <Badge variant="outline" className={statusStyle(model.trading.liveTradingEnabled ? "warning" : "neutral")}>Live {model.trading.liveTradingEnabled ? "an" : "aus"}</Badge>
              <Badge variant="outline" className={statusStyle(model.trading.killSwitchActive ? "bad" : "good")}>Kill Switch {model.trading.killSwitchActive ? "aktiv" : "frei"}</Badge>
            </div>
            <div className="text-xs text-muted-foreground">Letzte Reconciliation: {dateTime(model.trading.latestReconciliationAt)}</div>
            <Button variant="ghost" className="w-full justify-between" onClick={() => props.onNavigate("trading")}>Trading Control Center<ArrowRight className="h-4 w-4" /></Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3"><div><CardTitle>Execution Statistics</CardTitle><CardDescription>Persistierte Intents, Fills und Gebühren.</CardDescription></div><Gauge className="h-5 w-5 text-primary" /></div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between border-b pb-3"><span className="text-sm text-muted-foreground">Intents abgeschlossen</span><span className="font-semibold tabular-nums">{model.trading.completedIntentCount}</span></div>
            <div className="flex items-center justify-between border-b pb-3"><span className="text-sm text-muted-foreground">Intents offen</span><span className="font-semibold tabular-nums">{model.trading.pendingIntentCount}</span></div>
            <div className="flex items-center justify-between border-b pb-3"><span className="text-sm text-muted-foreground">Blockiert/Fehler</span><span className={model.trading.blockedIntentCount ? "font-semibold text-destructive" : "font-semibold"}>{model.trading.blockedIntentCount}</span></div>
            <div className="flex items-center justify-between border-b pb-3"><span className="text-sm text-muted-foreground">Persistierte Fills</span><span className="font-semibold tabular-nums">{data.trading?.activity?.fills?.length || 0}</span></div>
            <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Gebühren (Fenster)</span><span className="font-semibold tabular-nums">{feeLabel}</span></div>
            <p className="text-xs leading-5 text-muted-foreground">Gebühren verschiedener Assets werden nicht ohne Wechselkurs zusammengeführt.</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.7fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Paper Performance</CardTitle>
            <CardDescription>Kumulierte realisierte Ergebnisse geschlossener Paper-Positionen; Live-PnL bleibt bewusst getrennt.</CardDescription>
          </CardHeader>
          <CardContent>
            {model.performance.length > 0 ? (
              <ChartContainer config={performanceConfig} className="h-[250px] w-full">
                <AreaChart data={model.performance} margin={{ left: 4, right: 12 }}>
                  <defs><linearGradient id="fillPnl" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-pnl)" stopOpacity={0.35} /><stop offset="95%" stopColor="var(--color-pnl)" stopOpacity={0.03} /></linearGradient></defs>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} tickFormatter={(value) => compact(Number(value))} width={54} />
                  <ReferenceLine y={0} stroke="var(--border)" />
                  <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
                  <Area dataKey="pnl" type="monotone" fill="url(#fillPnl)" stroke="var(--color-pnl)" strokeWidth={2} />
                </AreaChart>
              </ChartContainer>
            ) : <div className="flex h-[250px] flex-col items-center justify-center rounded-lg border border-dashed text-center"><TrendingUp className="mb-3 h-8 w-8 text-muted-foreground" /><p className="font-medium">Noch keine geschlossenen Paper-Trades</p><p className="mt-1 max-w-sm text-sm text-muted-foreground">Die belastbare Performance-Kurve entsteht automatisch mit dem ersten realisierten Ergebnis.</p></div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Portfolio Snapshot</CardTitle><CardDescription>Aktuelle Managed Positionen.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {model.activePositions.length === 0 && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Keine offenen Managed Positionen.</div>}
            {model.activePositions.map((position: any) => (
              <div key={position.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className={`rounded-md px-2 py-1 text-xs font-semibold ${position.side === "LONG" ? statusStyle("good") : statusStyle("bad")}`}>{position.side}</div>
                <div className="min-w-0 flex-1"><p className="font-medium">{position.symbol}</p><p className="truncate text-xs text-muted-foreground">{position.channelId} · {position.accountId}</p></div>
                <div className="text-right"><p className="text-sm font-medium tabular-nums">{position.quantity}</p><p className="text-xs text-muted-foreground">@ {position.averageEntryPrice || "–"}</p></div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Risk & Exception Feed</CardTitle><CardDescription>Unmittelbar sichtbare Trading-Abweichungen und Bestätigungsstatus.</CardDescription></CardHeader>
          <CardContent>
            {model.recentRiskEvents.length === 0 ? <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />Keine Risk Events im aktuellen Fenster.</div> : (
              <div className="divide-y">{model.recentRiskEvents.map((event: any) => <div key={event.id} className="flex items-start gap-3 py-3"><AlertTriangle className={`mt-0.5 h-4 w-4 ${event.severity === "critical" ? "text-destructive" : "text-amber-500"}`} /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{event.code}</p><p className="text-xs text-muted-foreground">{event.accountId || "Systemweit"} · {dateTime(event.createdAt)}</p></div><Badge variant="outline" className={event.acknowledgedAt ? statusStyle("neutral") : statusStyle(event.severity === "critical" ? "bad" : "warning")}>{event.acknowledgedAt ? "Bestätigt" : "Offen"}</Badge></div>)}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Program Activity</CardTitle><CardDescription>Kompakter Überblick über Laufzeit, Queue und Datenfluss.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-4"><Clock3 className="mb-3 h-5 w-5 text-primary" /><p className="text-xs text-muted-foreground">Service Uptime</p><p className="mt-1 text-xl font-semibold">{props.uptime}</p></div>
            <div className="rounded-lg border p-4"><Route className="mb-3 h-5 w-5 text-primary" /><p className="text-xs text-muted-foreground">Weitergeleitet gesamt</p><p className="mt-1 text-xl font-semibold tabular-nums">{number(props.totalForwardedCount)}</p></div>
            <div className="rounded-lg border p-4"><Activity className="mb-3 h-5 w-5 text-primary" /><p className="text-xs text-muted-foreground">Seit Neustart verarbeitet</p><p className="mt-1 text-xl font-semibold tabular-nums">{number(props.processedSinceRestart)}</p></div>
            <div className="rounded-lg border p-4"><Layers3 className="mb-3 h-5 w-5 text-primary" /><p className="text-xs text-muted-foreground">Queue</p><p className="mt-1 text-xl font-semibold tabular-nums">{props.queue.running} aktiv · {props.queue.queued} wartend</p></div>
            <div className="sm:col-span-2 flex flex-wrap gap-2 pt-1">
              <Badge variant="outline" className={statusStyle(props.parserEnabled ? "good" : "neutral")}>KI-Parser {props.parserEnabled ? "aktiv" : "aus"}</Badge>
              <Badge variant="outline" className={statusStyle(props.forwardingEnabled ? "good" : "neutral")}>Weiterleitung {props.forwardingEnabled ? "aktiv" : "aus"}</Badge>
              <Badge variant="outline">{props.forwardXmlToTarget ? "XML-Zielmodus" : "Original-Zielmodus"}</Badge>
              <Badge variant="outline">Outbox offen: {data.outbox?.length || 0}</Badge>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
