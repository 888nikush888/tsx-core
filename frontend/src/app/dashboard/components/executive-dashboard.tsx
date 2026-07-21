import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Bot,
  BriefcaseBusiness, CheckCircle2, CircleDollarSign, Clock3, DatabaseBackup,
  Gauge, Layers3, Play, RefreshCw, Route, ShieldCheck, Square, TrendingUp,
  WalletCards, Wifi, WifiOff,
} from "lucide-react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { apiFetch } from "@/lib/api"
import { useSerializedPolling } from "@/hooks/use-serialized-polling"
import { ChartAreaInteractive, type MetricPoint } from "./chart-area-interactive"
import {
  buildDashboardViewModel,
  type AccountAnalyticsView,
  type DashboardDataInput,
  type DashboardViewModel,
  type DashboardWindow,
  type WindowAnalyticsView,
} from "./executive-dashboard-model"

const API_BASE = window.location.origin
const WINDOWS: Array<{ value: DashboardWindow; label: string; short: string }> = [
  { value: "24h", label: "Letzte 24 Stunden", short: "24h" },
  { value: "7d", label: "Letzte 7 Tage", short: "7 Tage" },
  { value: "30d", label: "Letzte 30 Tage", short: "30 Tage" },
  { value: "all", label: "Gesamter Datenbestand", short: "Gesamt" },
]

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

const performanceConfig = { pnl: { label: "Realisierter PnL", color: "var(--chart-1)" } } satisfies ChartConfig
const capitalConfig = {
  equity: { label: "Equity", color: "var(--chart-1)" },
  available: { label: "Verfügbar", color: "var(--chart-3)" },
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

function percent(value: number | null): string {
  return value === null ? "–" : `${number(value, 1)} %`
}

function dateTime(value: number | null | undefined): string {
  if (!value) return "Noch nicht verfügbar"
  return new Date(value).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function statusStyle(tone: "good" | "warning" | "bad" | "neutral"): string {
  if (tone === "good") return "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
  if (tone === "warning") return "border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400"
  if (tone === "bad") return "border-destructive/20 bg-destructive/10 text-destructive"
  return "border-border bg-muted/40 text-muted-foreground"
}

function pnlTone(value: number): "neutral" | "positive" | "negative" {
  return value > 0 ? "positive" : value < 0 ? "negative" : "neutral"
}

function modeLabel(account: { exchange: string; mode: string }): string {
  if (account.exchange === "paper") return "Paper"
  return account.mode === "live" ? "Mainnet" : "Testnet"
}

function feeSummary(fees: Record<string, number>): string {
  const entries = Object.entries(fees).filter(([, value]) => value !== 0)
  if (entries.length === 0) return "0"
  return entries.map(([asset, value]) => `${number(value, 4)} ${asset}`).join(" · ")
}

function HealthBadge({ value, good = "Healthy", bad = "Störung" }: { value: boolean | null; good?: string; bad?: string }) {
  const tone = value === true ? "good" : value === false ? "bad" : "neutral"
  return <Badge variant="outline" className={statusStyle(tone)}>{value === null ? "Nicht verfügbar" : value ? good : bad}</Badge>
}

function MetricCard({ label, value, detail, icon, tone = "neutral" }: {
  label: string; value: string; detail: string; icon: ReactNode; tone?: "neutral" | "positive" | "negative"
}) {
  return <Card className="overflow-hidden transition-colors hover:border-primary/30"><CardContent className="p-5">
    <div className="flex items-start justify-between gap-4"><div className="min-w-0"><p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</p><p className={`mt-2 truncate text-2xl font-semibold tabular-nums ${tone === "positive" ? "text-emerald-600 dark:text-emerald-400" : tone === "negative" ? "text-destructive" : ""}`}>{value}</p></div><div className="rounded-lg border bg-muted/40 p-2.5 text-primary">{icon}</div></div>
    <p className="mt-4 text-xs leading-5 text-muted-foreground">{detail}</p>
  </CardContent></Card>
}

function StatusRow({ icon, label, detail, state }: { icon: ReactNode; label: string; detail: string; state: boolean | null }) {
  return <div className="flex items-center gap-3 py-3"><div className={`rounded-md border p-2 ${state === true ? statusStyle("good") : state === false ? statusStyle("bad") : statusStyle("neutral")}`}>{icon}</div><div className="min-w-0 flex-1"><p className="text-sm font-medium">{label}</p><p className="truncate text-xs text-muted-foreground">{detail}</p></div><HealthBadge value={state} good="Bereit" bad="Prüfen" /></div>
}

async function getJson(path: string, signal?: AbortSignal): Promise<any> {
  const response = await apiFetch(`${API_BASE}${path}`, { signal })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response.json()
}

function PeriodOverview({ windows, selected, onSelect }: { windows: Record<DashboardWindow, WindowAnalyticsView>; selected: DashboardWindow; onSelect: (window: DashboardWindow) => void }) {
  return <section className="space-y-3"><div><h2 className="text-lg font-semibold">Performance nach Zeitraum</h2><p className="text-xs text-muted-foreground">Alle Zeiträume bleiben gleichzeitig sichtbar; der aktive Zeitraum steuert sämtliche Detailkarten.</p></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {WINDOWS.map(item => { const value = windows[item.value]; return <button key={item.value} type="button" onClick={() => onSelect(item.value)} className={`rounded-xl border p-4 text-left transition-colors hover:border-primary/40 ${selected === item.value ? "border-primary bg-primary/5 ring-1 ring-primary/20" : "bg-card"}`}>
      <div className="flex items-center justify-between"><span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{item.short}</span><span className={`h-2 w-2 rounded-full ${value.realizedPnl > 0 ? "bg-emerald-500" : value.realizedPnl < 0 ? "bg-destructive" : "bg-muted-foreground/40"}`} /></div>
      <p className={`mt-2 text-2xl font-semibold tabular-nums ${value.realizedPnl > 0 ? "text-emerald-600 dark:text-emerald-400" : value.realizedPnl < 0 ? "text-destructive" : ""}`}>{signed(value.realizedPnl)}</p>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs"><div><p className="text-muted-foreground">Trades</p><p className="font-medium tabular-nums">{value.closedTrades}</p></div><div><p className="text-muted-foreground">Win Rate</p><p className="font-medium tabular-nums">{percent(value.winRatePercent)}</p></div><div><p className="text-muted-foreground">Volumen</p><p className="font-medium tabular-nums">{compact(value.volume)}</p></div></div>
    </button> })}
  </div></section>
}

function AccountMatrix({ accounts, window }: { accounts: AccountAnalyticsView[]; window: DashboardWindow }) {
  return <Card className="min-w-0"><CardHeader><CardTitle>Exchange- & Account-Matrix</CardTitle><CardDescription>Paper, Hyperliquid und Bybit gemeinsam – mit echtem Kontosnapshot und separatem Drill-down je Konto.</CardDescription></CardHeader><CardContent className="min-w-0 overflow-x-auto"><Table><TableHeader><TableRow>
    <TableHead>Konto</TableHead><TableHead>Umgebung</TableHead><TableHead>Equity</TableHead><TableHead>Verfügbar</TableHead><TableHead>Margin</TableHead><TableHead>Unrealisiert</TableHead><TableHead>PnL</TableHead><TableHead>Trades</TableHead><TableHead>Win Rate</TableHead><TableHead>Volumen</TableHead><TableHead>Gebühren</TableHead><TableHead>Snapshot</TableHead>
  </TableRow></TableHeader><TableBody>{accounts.map(account => { const metrics = account.windows[window]; return <TableRow key={account.accountId}>
    <TableCell><div className="min-w-36"><p className="font-medium">{account.name}</p><p className="text-xs text-muted-foreground">{account.exchange} · {account.reportingCurrency}</p>{account.error && <p className="mt-1 max-w-48 text-xs text-destructive">{account.error}</p>}</div></TableCell>
    <TableCell><Badge variant="outline" className={statusStyle(account.error ? "bad" : account.enabled ? "good" : "neutral")}>{modeLabel(account)}</Badge></TableCell>
    <TableCell className="font-medium tabular-nums">{account.equity === null ? "–" : number(account.equity, 2)}</TableCell><TableCell className="tabular-nums">{account.availableBalance === null ? "–" : number(account.availableBalance, 2)}</TableCell><TableCell className="tabular-nums">{account.marginUsed === null ? "–" : number(account.marginUsed, 2)}</TableCell>
    <TableCell className={`tabular-nums ${(account.unrealizedPnl || 0) > 0 ? "text-emerald-600 dark:text-emerald-400" : (account.unrealizedPnl || 0) < 0 ? "text-destructive" : ""}`}>{account.unrealizedPnl === null ? "–" : signed(account.unrealizedPnl)}</TableCell>
    <TableCell className={`font-medium tabular-nums ${metrics.realizedPnl > 0 ? "text-emerald-600 dark:text-emerald-400" : metrics.realizedPnl < 0 ? "text-destructive" : ""}`}>{signed(metrics.realizedPnl)}</TableCell><TableCell className="tabular-nums">{metrics.closedTrades}</TableCell><TableCell className="tabular-nums">{percent(metrics.winRatePercent)}</TableCell><TableCell className="tabular-nums">{number(metrics.volume, 2)}</TableCell><TableCell className="min-w-32 text-xs tabular-nums">{feeSummary(metrics.fees)}</TableCell><TableCell className="min-w-32 text-xs text-muted-foreground">{account.error ? "Fehler" : dateTime(account.observedAt)}</TableCell>
  </TableRow> })}{accounts.length === 0 && <TableRow><TableCell colSpan={12} className="h-24 text-center text-muted-foreground">Für diesen Filter sind keine Trading-Konten vorhanden.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
}

function CapitalChart({ accounts }: { accounts: AccountAnalyticsView[] }) {
  const data = accounts.filter(account => account.equity !== null).map(account => ({ name: account.name, equity: account.equity || 0, available: account.availableBalance || 0 }))
  return <Card><CardHeader><CardTitle>Kapitalverteilung</CardTitle><CardDescription>Equity und freie Mittel pro angebundenem Konto.</CardDescription></CardHeader><CardContent>{data.length > 0 ? <ChartContainer config={capitalConfig} className="h-[280px] w-full aspect-auto"><BarChart data={data}><CartesianGrid vertical={false} /><XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={8} /><YAxis tickLine={false} axisLine={false} tickFormatter={value => compact(Number(value))} width={55} /><ChartTooltip content={<ChartTooltipContent indicator="dot" />} /><Bar dataKey="equity" fill="var(--color-equity)" radius={[4, 4, 0, 0]} /><Bar dataKey="available" fill="var(--color-available)" radius={[4, 4, 0, 0]} /></BarChart></ChartContainer> : <EmptyState title="Keine Kontosnapshots" detail="Verifiziere ein Trading-Konto und aktualisiere anschließend das Dashboard." />}</CardContent></Card>
}

function PerformanceChart({ model }: { model: DashboardViewModel }) {
  return <Card><CardHeader><CardTitle>Kumulative Managed Performance</CardTitle><CardDescription>Persistierter realisierter PnL der letzten 200 sichtbaren Positionen im aktiven Account-Filter.</CardDescription></CardHeader><CardContent>{model.performance.length > 0 ? <ChartContainer config={performanceConfig} className="h-[280px] w-full aspect-auto"><AreaChart data={model.performance} margin={{ left: 4, right: 12 }}><defs><linearGradient id="fillPnl" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-pnl)" stopOpacity={0.35} /><stop offset="95%" stopColor="var(--color-pnl)" stopOpacity={0.03} /></linearGradient></defs><CartesianGrid vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} /><YAxis tickLine={false} axisLine={false} tickFormatter={value => compact(Number(value))} width={55} /><ReferenceLine y={0} stroke="var(--border)" /><ChartTooltip content={<ChartTooltipContent indicator="dot" />} /><Area dataKey="pnl" type="monotone" fill="url(#fillPnl)" stroke="var(--color-pnl)" strokeWidth={2} /></AreaChart></ChartContainer> : <EmptyState title="Noch keine realisierten Trades" detail="Die Performance-Kurve entsteht automatisch aus geschlossenen Managed Positionen." />}</CardContent></Card>
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="flex h-[280px] flex-col items-center justify-center rounded-lg border border-dashed text-center"><TrendingUp className="mb-3 h-8 w-8 text-muted-foreground" /><p className="font-medium">{title}</p><p className="mt-1 max-w-sm text-sm text-muted-foreground">{detail}</p></div>
}

function OperationalReadiness({ model, routingHealthy, uptime, connectionState }: { model: DashboardViewModel; routingHealthy: boolean; uptime: string; connectionState: string }) {
  const tradingHealthy = !model.trading.killSwitchActive && model.trading.unknownOrderCount === 0 && model.trading.criticalRiskEvents === 0
  return <Card><CardHeader><CardTitle>Operational Readiness</CardTitle><CardDescription>Kontrollpunkte für sicheren Routing- und Trading-Betrieb.</CardDescription></CardHeader><CardContent className="divide-y"><StatusRow icon={routingHealthy ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />} label="Routing & Telegram" detail={`${connectionState} · Uptime ${uptime}`} state={routingHealthy} /><StatusRow icon={<ShieldCheck className="h-4 w-4" />} label="Trading Safety" detail={`${model.trading.unknownOrderCount} unknown Orders · ${model.trading.criticalRiskEvents} kritische Events`} state={tradingHealthy} /><StatusRow icon={<DatabaseBackup className="h-4 w-4" />} label="Backup" detail={dateTime(model.operations.backupLastSuccessAt)} state={model.operations.backupHealthy} /><StatusRow icon={<Layers3 className="h-4 w-4" />} label="Retention" detail={dateTime(model.operations.retentionLastSuccessAt)} state={model.operations.retentionHealthy} /><StatusRow icon={<Activity className="h-4 w-4" />} label="Audit Trail" detail={model.operations.auditRemoteRequired ? `Remote · ${dateTime(model.operations.auditLastRemoteSuccessAt)}` : "Lokale Audit-Kette"} state={model.operations.auditHealthy} /></CardContent></Card>
}

function DetailedStatistics({ model, window, onNavigate }: { model: DashboardViewModel; window: DashboardWindow; onNavigate: (tab: string) => void }) {
  const trading = model.windows[window]
  const signals = model.signalWindows[window]
  const completionRate = trading.intents > 0 ? trading.completedIntents / trading.intents * 100 : null
  return <div className="grid gap-4 lg:grid-cols-3">
    <Card><CardHeader><div className="flex items-start justify-between"><div><CardTitle>Signal Analytics</CardTitle><CardDescription>{WINDOWS.find(item => item.value === window)?.label}</CardDescription></div><Bot className="h-5 w-5 text-primary" /></div></CardHeader><CardContent className="space-y-4"><StatLine label="Nachrichten" value={number(signals.messages)} /><StatLine label="Verarbeitet" value={`${number(signals.processed)} · ${percent(signals.processingRatePercent)}`} /><StatLine label="Extrahierte Signale" value={`${number(signals.signals)} · ${percent(signals.extractionRatePercent)}`} /><div className="grid grid-cols-3 gap-2 rounded-lg border bg-muted/20 p-3 text-center"><MiniStat label="Gefiltert" value={signals.filtered} /><MiniStat label="Duplikate" value={signals.duplicates} /><MiniStat label="Fehler" value={signals.failed} bad={signals.failed > 0} /></div><Button variant="ghost" className="w-full justify-between" onClick={() => onNavigate("signals")}>Signal Control Center<ArrowRight className="h-4 w-4" /></Button></CardContent></Card>
    <Card><CardHeader><div className="flex items-start justify-between"><div><CardTitle>Execution Quality</CardTitle><CardDescription>Intents, Fills und Kosten im aktiven Zeitraum.</CardDescription></div><Gauge className="h-5 w-5 text-primary" /></div></CardHeader><CardContent className="space-y-4"><StatLine label="Intents" value={number(trading.intents)} /><StatLine label="Abgeschlossen" value={`${number(trading.completedIntents)} · ${percent(completionRate)}`} /><StatLine label="Blockiert/Fehler" value={number(trading.rejectedIntents)} bad={trading.rejectedIntents > 0} /><StatLine label="Fills" value={number(trading.fills)} /><StatLine label="Gebühren" value={feeSummary(trading.fees)} /><StatLine label="Risk Events" value={`${trading.riskEvents} · ${trading.criticalRiskEvents} kritisch`} bad={trading.criticalRiskEvents > 0} /></CardContent></Card>
    <Card><CardHeader><div className="flex items-start justify-between"><div><CardTitle>Trading Controls</CardTitle><CardDescription>Globale Execution- und Sicherheits-Gates.</CardDescription></div><TrendingUp className="h-5 w-5 text-primary" /></div></CardHeader><CardContent className="space-y-4"><div className="grid grid-cols-2 gap-3"><MetricBox label="Offene Positionen" value={model.trading.openPositionCount} /><MetricBox label="Aktive Routen" value={model.trading.enabledRouteCount} /><MetricBox label="Pending Intents" value={model.trading.pendingIntentCount} /><MetricBox label="Konten" value={model.trading.accountCount} /></div><div className="flex flex-wrap gap-2"><Badge variant="outline" className={statusStyle(model.trading.executionEnabled ? "good" : "neutral")}>Execution {model.trading.executionEnabled ? "an" : "aus"}</Badge><Badge variant="outline" className={statusStyle(model.trading.liveTradingEnabled ? "warning" : "neutral")}>Live {model.trading.liveTradingEnabled ? "an" : "aus"}</Badge><Badge variant="outline" className={statusStyle(model.trading.killSwitchActive ? "bad" : "good")}>Kill Switch {model.trading.killSwitchActive ? "aktiv" : "frei"}</Badge></div><p className="text-xs text-muted-foreground">Letzte Reconciliation: {dateTime(model.trading.latestReconciliationAt)}</p><Button variant="ghost" className="w-full justify-between" onClick={() => onNavigate("trading")}>Trading Control Center<ArrowRight className="h-4 w-4" /></Button></CardContent></Card>
  </div>
}

function StatLine({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) { return <div className="flex items-center justify-between border-b pb-3 text-sm"><span className="text-muted-foreground">{label}</span><span className={`font-semibold tabular-nums ${bad ? "text-destructive" : ""}`}>{value}</span></div> }
function MiniStat({ label, value, bad = false }: { label: string; value: number; bad?: boolean }) { return <div><p className={`text-lg font-semibold tabular-nums ${bad ? "text-destructive" : ""}`}>{value}</p><p className="text-[11px] text-muted-foreground">{label}</p></div> }
function MetricBox({ label, value }: { label: string; value: number }) { return <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p></div> }

function PositionsAndRisk({ model }: { model: DashboardViewModel }) {
  return <div className="grid gap-4 xl:grid-cols-2"><Card><CardHeader><CardTitle>Offene Managed Positionen</CardTitle><CardDescription>Strategiegebundene Positionen im aktiven Account-Filter.</CardDescription></CardHeader><CardContent className="space-y-3">{model.activePositions.length === 0 && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">Keine offenen Managed Positionen.</div>}{model.activePositions.map((position: any) => <div key={position.id} className="flex items-center gap-3 rounded-lg border p-3"><div className={`rounded-md border px-2 py-1 text-xs font-semibold ${position.side === "LONG" ? statusStyle("good") : statusStyle("bad")}`}>{position.side}</div><div className="min-w-0 flex-1"><p className="font-medium">{position.symbol}</p><p className="truncate text-xs text-muted-foreground">{position.channelId} · {position.accountId}</p></div><div className="text-right"><p className="text-sm font-medium tabular-nums">{position.quantity}</p><p className="text-xs text-muted-foreground">Entry {position.averageEntryPrice || "–"} · Stop {position.stopPrice || "–"}</p></div></div>)}</CardContent></Card>
    <Card><CardHeader><CardTitle>Risk & Exception Feed</CardTitle><CardDescription>Aktuelle Trading-Abweichungen und Bestätigungsstatus.</CardDescription></CardHeader><CardContent>{model.recentRiskEvents.length === 0 ? <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />Keine Risk Events im sichtbaren Fenster.</div> : <div className="divide-y">{model.recentRiskEvents.map((event: any) => <div key={event.id} className="flex items-start gap-3 py-3"><AlertTriangle className={`mt-0.5 h-4 w-4 ${event.severity === "critical" ? "text-destructive" : "text-amber-500"}`} /><div className="min-w-0 flex-1"><p className="text-sm font-medium">{event.code}</p><p className="text-xs text-muted-foreground">{event.accountId || "Systemweit"} · {dateTime(event.createdAt)}</p></div><Badge variant="outline" className={event.acknowledgedAt ? statusStyle("neutral") : statusStyle(event.severity === "critical" ? "bad" : "warning")}>{event.acknowledgedAt ? "Bestätigt" : "Offen"}</Badge></div>)}</div>}</CardContent></Card></div>
}

function ProgramActivity({ props, outboxCount }: { props: ExecutiveDashboardProps; outboxCount: number }) {
  return <Card><CardHeader><CardTitle>Program Activity</CardTitle><CardDescription>Laufzeit-, Queue- und Routing-Kennzahlen.</CardDescription></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><ActivityBox icon={<Clock3 className="h-5 w-5" />} label="Service Uptime" value={props.uptime} /><ActivityBox icon={<Route className="h-5 w-5" />} label="Weitergeleitet gesamt" value={number(props.totalForwardedCount)} /><ActivityBox icon={<Activity className="h-5 w-5" />} label="Seit Neustart" value={number(props.processedSinceRestart)} /><ActivityBox icon={<Layers3 className="h-5 w-5" />} label="Queue" value={`${props.queue.running} aktiv · ${props.queue.queued} wartend`} /><div className="flex flex-wrap gap-2 sm:col-span-2 xl:col-span-4"><Badge variant="outline" className={statusStyle(props.parserEnabled ? "good" : "neutral")}>KI-Parser {props.parserEnabled ? "aktiv" : "aus"}</Badge><Badge variant="outline" className={statusStyle(props.forwardingEnabled ? "good" : "neutral")}>Weiterleitung {props.forwardingEnabled ? "aktiv" : "aus"}</Badge><Badge variant="outline">{props.forwardXmlToTarget ? "XML-Zielmodus" : "Original-Zielmodus"}</Badge><Badge variant="outline">Outbox offen: {outboxCount}</Badge></div></CardContent></Card>
}

function ActivityBox({ icon, label, value }: { icon: ReactNode; label: string; value: string }) { return <div className="rounded-lg border p-4"><div className="mb-3 text-primary">{icon}</div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold tabular-nums">{value}</p></div> }

export function ExecutiveDashboard(props: ExecutiveDashboardProps) {
  const [data, setData] = useState<DashboardDataInput>({ messages: [], signals: [], outbox: [] })
  const [timeWindow, setTimeWindow] = useState<DashboardWindow>("24h")
  const [scope, setScope] = useState("all")
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMessage, setRefreshMessage] = useState("Daten werden geladen")
  const mounted = useRef(true)
  const refreshInFlight = useRef<Promise<void> | null>(null)
  const firstRefresh = useRef(true)

  const refresh = useCallback(async (forcePortfolio = false, signal?: AbortSignal) => {
    if (refreshInFlight.current) {
      if (!forcePortfolio) return
      await refreshInFlight.current
    }
    const operation = (async () => {
      if (mounted.current) { setRefreshing(true); setRefreshMessage(forcePortfolio ? "Exchange-Konten werden live aktualisiert …" : "Dashboard wird aktualisiert …") }
      const endpoints = [
        ["trading", "/api/trading"], ["operations", "/api/operations"],
        ["signalAnalytics", "/api/dashboard-analytics"],
        ["portfolio", `/api/trading/portfolio${forcePortfolio ? "?refresh=true" : ""}`],
        ["outbox", "/api/outbox?status=pending,preparing,sending,failed,unknown"],
      ] as const
      const results = await Promise.allSettled(endpoints.map(([, path]) => getJson(path, signal)))
      if (signal?.aborted) return
      const next: DashboardDataInput = {}
      const failures: string[] = []
      results.forEach((result, index) => {
        const [name] = endpoints[index]
        if (result.status === "rejected") { failures.push(name); return }
        const payload = result.value
        if (name === "trading") next.trading = payload
        if (name === "operations") next.operations = payload.operations || {}
        if (name === "signalAnalytics") next.signalAnalytics = payload.analytics || {}
        if (name === "portfolio") next.portfolio = payload
        if (name === "outbox") next.outbox = payload.tasks || []
      })
      if (!mounted.current) return
      const accountErrors = Array.isArray(next.portfolio?.accounts) ? next.portfolio.accounts.filter((account: any) => account.error).length : 0
      const updatedAt = Date.now()
      setData(current => ({ ...current, ...next }))
      setLastUpdated(updatedAt)
      setRefreshMessage(failures.length > 0 ? `Teilweise veraltet: ${failures.join(", ")}` : accountErrors > 0 ? `Aktualisiert · ${accountErrors} Konto/Konten nicht erreichbar` : `Vollständig aktualisiert · ${dateTime(updatedAt)}`)
      setRefreshing(false)
    })()
    refreshInFlight.current = operation
    try { await operation } finally { refreshInFlight.current = null }
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useSerializedPolling((signal) => {
    const forcePortfolio = firstRefresh.current
    firstRefresh.current = false
    return refresh(forcePortfolio, signal)
  }, 10_000)

  const rawAccounts = useMemo(
    () => Array.isArray(data.portfolio?.accounts) ? data.portfolio.accounts : [],
    [data.portfolio?.accounts],
  )
  const selectedIds = useMemo(() => {
    if (scope === "all") return undefined
    if (scope.startsWith("exchange:")) return rawAccounts.filter((account: any) => account.exchange === scope.slice(9)).map((account: any) => String(account.accountId))
    return [scope]
  }, [rawAccounts, scope])
  const model = useMemo(() => buildDashboardViewModel(data, selectedIds), [data, selectedIds])
  const current = model.windows[timeWindow]
  const routingHealthy = props.isRunning && props.connectionState === "connected" && !props.queue.paused
  const tradingHealthy = !model.trading.killSwitchActive && model.trading.unknownOrderCount === 0 && model.trading.criticalRiskEvents === 0
  const criticalIssues = [model.trading.killSwitchActive, model.trading.unknownOrderCount > 0, model.trading.criticalRiskEvents > 0, model.operations.backupHealthy === false, model.operations.auditHealthy === false].filter(Boolean).length
  const scopeOptions = [
    { value: "all", label: "Alle Konten zusammen" },
    ...["hyperliquid", "bybit", "paper"].filter(exchange => rawAccounts.some((account: any) => account.exchange === exchange)).map(exchange => ({ value: `exchange:${exchange}`, label: `${exchange === "paper" ? "Paper" : exchange[0].toUpperCase() + exchange.slice(1)} gesamt` })),
    ...rawAccounts.map((account: any) => ({ value: String(account.accountId), label: `${account.name} · ${account.exchange}/${account.mode === "live" ? "mainnet" : account.mode}` })),
  ]
  const periodLabel = WINDOWS.find(item => item.value === timeWindow)?.short || timeWindow
  const returnPercent = model.finance.nominalEquity > 0 ? current.realizedPnl / model.finance.nominalEquity * 100 : null

  return <div className="space-y-6 px-4 pb-10 lg:px-6">
    <section className="relative overflow-hidden rounded-xl border bg-card p-5 shadow-sm md:p-6"><div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 bg-gradient-to-l from-primary/10 to-transparent" /><div className="relative space-y-5"><div className="flex flex-col gap-5 2xl:flex-row 2xl:items-center 2xl:justify-between"><div><div className="mb-2 flex flex-wrap items-center gap-2"><Badge variant="outline" className={statusStyle(criticalIssues > 0 ? "bad" : routingHealthy && tradingHealthy ? "good" : "warning")}>{criticalIssues > 0 ? `${criticalIssues} kritische Hinweise` : routingHealthy && tradingHealthy ? "System operativ" : "System eingeschränkt"}</Badge><span className="text-xs text-muted-foreground">Live Portfolio · {dateTime(model.finance.observedAt)}</span></div><h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Executive Trading & Operations</h1><p className="mt-2 max-w-3xl text-sm text-muted-foreground">Vollständige Finanz-, Exchange-, Trading-, Signal- und Betriebsanalyse mit gemeinsamem sowie kontoindividuellem Drill-down.</p></div><div className="flex flex-wrap items-center gap-2"><div className="mr-1 text-right text-xs text-muted-foreground"><div>{refreshMessage}</div><div>Lokale Daten 10s · Exchange-Snapshots 60s oder manuell</div></div><Button variant="outline" onClick={() => void refresh(true)} disabled={refreshing}><RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />{refreshing ? "Aktualisiere …" : "Alles aktualisieren"}</Button><Button onClick={() => void props.onToggleRouting()} disabled={!props.isRunning && !props.routingConfigReady} className={props.isRunning ? "bg-red-600 text-white hover:bg-red-500" : ""}>{props.isRunning ? <><Square className="mr-2 h-4 w-4 fill-current" />Routing stoppen</> : <><Play className="mr-2 h-4 w-4 fill-current" />Routing starten</>}</Button></div></div>
      <div className="flex flex-col gap-3 border-t pt-4 lg:flex-row lg:items-center lg:justify-between"><ToggleGroup type="single" value={timeWindow} onValueChange={value => value && setTimeWindow(value as DashboardWindow)} variant="outline" className="justify-start">{WINDOWS.map(item => <ToggleGroupItem key={item.value} value={item.value}>{item.short}</ToggleGroupItem>)}</ToggleGroup><Select value={scope} onValueChange={setScope}><SelectTrigger className="w-full lg:w-[320px]" aria-label="Portfolio-Filter"><SelectValue /></SelectTrigger><SelectContent>{scopeOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>
    </div></section>

    {!props.setupComplete && <Card className="border-primary/30 bg-primary/5"><CardContent className="p-5"><div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between"><div><p className="font-semibold">Inbetriebnahme · {props.setupSteps.filter(step => step.complete).length}/{props.setupSteps.length} abgeschlossen</p><div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">{props.setupSteps.map(step => <span key={step.label} className="flex items-center gap-1.5">{step.complete ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <span className="h-4 w-4 rounded-full border" />}{step.label}</span>)}</div></div><Button variant="outline" onClick={() => props.onNavigate("signals")}>Setup öffnen<ArrowRight className="ml-2 h-4 w-4" /></Button></div></CardContent></Card>}

    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-lg font-semibold">Finanzübersicht · {periodLabel}</h2><p className="text-xs text-muted-foreground">Gesamtsicht = nominale Addition von Bybit-USD, Hyperliquid-USDC und Paper-Quote; keine FX- oder Stablecoin-Paritätsgarantie.</p></div><div className="flex flex-wrap gap-2"><Badge variant="outline">Scope: {scopeOptions.find(option => option.value === scope)?.label}</Badge><Badge variant="outline">Währungen: {model.finance.reportingCurrencies.join(" + ") || "–"}</Badge>{model.finance.accountErrors > 0 && <Badge variant="outline" className={statusStyle("bad")}>{model.finance.accountErrors} Konto-Fehler</Badge>}</div></div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6"><MetricCard label="Nominale Equity" value={number(model.finance.nominalEquity, 2)} detail={`${number(model.finance.exchangeEquity, 2)} Exchange · ${number(model.finance.paperEquity, 2)} Paper`} icon={<WalletCards className="h-5 w-5" />} /><MetricCard label="Verfügbar" value={number(model.finance.availableBalance, 2)} detail={`${number(model.finance.utilizationPercent, 1)} % Kapital gebunden`} icon={<CircleDollarSign className="h-5 w-5" />} /><MetricCard label={`Realisierter PnL · ${periodLabel}`} value={signed(current.realizedPnl)} detail={`Nominale Rendite ${percent(returnPercent)}`} icon={current.realizedPnl >= 0 ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />} tone={pnlTone(current.realizedPnl)} /><MetricCard label="Unrealisierter PnL" value={signed(model.finance.unrealizedPnl)} detail="Live aus offiziellen Exchange-Kontosnapshots" icon={<TrendingUp className="h-5 w-5" />} tone={pnlTone(model.finance.unrealizedPnl)} /><MetricCard label={`Volumen · ${periodLabel}`} value={number(current.volume, 2)} detail={`${current.fills} Fills · ${current.closedTrades} geschlossene Trades`} icon={<BriefcaseBusiness className="h-5 w-5" />} /><MetricCard label="Margin Used" value={number(model.finance.marginUsed, 2)} detail={`Profit Factor ${current.profitFactor === null ? "–" : Number.isFinite(current.profitFactor) ? number(current.profitFactor, 2) : "∞"}`} icon={<Gauge className="h-5 w-5" />} /></div>

    <PeriodOverview windows={model.windows} selected={timeWindow} onSelect={setTimeWindow} />
    <AccountMatrix accounts={model.accounts} window={timeWindow} />
    <div className="grid gap-4 xl:grid-cols-2"><CapitalChart accounts={model.accounts} /><PerformanceChart model={model} /></div>
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0 xl:grid-cols-[minmax(0,1.7fr)_minmax(340px,0.8fr)]"><ChartAreaInteractive data={props.metricsHistory} /><OperationalReadiness model={model} routingHealthy={routingHealthy} uptime={props.uptime} connectionState={props.connectionState} /></div>
    <DetailedStatistics model={model} window={timeWindow} onNavigate={props.onNavigate} />
    <PositionsAndRisk model={model} />
    <ProgramActivity props={props} outboxCount={data.outbox?.length || 0} />
    <p className="text-center text-xs text-muted-foreground">Letzte vollständige Dashboard-Aktualisierung: {dateTime(lastUpdated)} · Equity/UPL/Margin stammen live von offiziellen Exchange-APIs; historische PnL- und Statistikwerte aus der lokalen Managed-Trade-Historie.</p>
  </div>
}
