import { useCallback, useMemo, useState, type ReactNode } from "react"
import { Activity, BarChart3, Calculator, Clock3, RefreshCw, TrendingDown, TrendingUp } from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiFetch } from "@/lib/api"
import { useSerializedPolling } from "@/hooks/use-serialized-polling"

const API_BASE = window.location.origin
const FUNNEL_EVENTS = [
  ["signal_received", "Empfangen"],
  ["signal_validated", "Validiert"],
  ["intent_created", "Intent"],
  ["submit_started", "Submit"],
  ["exchange_ack", "Exchange ACK"],
  ["first_fill", "Erster Fill"],
  ["fully_filled", "Vollständig"],
] as const

function number(value: unknown, digits = 2): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return "–"
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(parsed)
}

function percent(value: unknown): string {
  return value === null || value === undefined ? "–" : `${number(value, 1)} %`
}

export function formatAnalyticsDuration(value: unknown): string {
  if (value === null || value === undefined || value === "") return "–"
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return "–"
  if (parsed < 1_000) return `${Math.round(parsed)} ms`
  return `${number(parsed / 1_000, 2)} s`
}

export function buildExecutionFunnel(funnel: Record<string, unknown> | null | undefined) {
  return FUNNEL_EVENTS.map(([id, label]) => ({ id, label, count: Number(funnel?.[id] || 0) }))
}

export function calculateExpectation(simulation: {
  winRate: string
  averageWinR: string
  averageLossR: string
  riskPercent: string
  trades: string
}) {
  const winRate = Math.min(100, Math.max(0, Number(simulation.winRate) || 0)) / 100
  const averageWinR = Math.max(0, Number(simulation.averageWinR) || 0)
  const averageLossR = Math.max(0, Number(simulation.averageLossR) || 0)
  const riskPercent = Math.max(0, Number(simulation.riskPercent) || 0)
  const trades = Math.max(0, Math.floor(Number(simulation.trades) || 0))
  const expectancyR = winRate * averageWinR - (1 - winRate) * averageLossR
  return {
    expectancyR,
    expectancyPercent: expectancyR * riskPercent,
    projectedPercent: expectancyR * riskPercent * trades,
    breakEvenWinRate: averageWinR + averageLossR > 0 ? averageLossR / (averageWinR + averageLossR) * 100 : 0,
  }
}

function dateTime(value: unknown): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toLocaleString("de-DE") : "–"
}

function Metric({ label, value, detail, icon }: Readonly<{
  label: string
  value: string
  detail: string
  icon: ReactNode
}>) {
  return <Card><CardContent className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p></div><div className="rounded-md border p-2">{icon}</div></div><p className="mt-3 text-xs text-muted-foreground">{detail}</p></CardContent></Card>
}

function ChartFrame({ title, description, children }: Readonly<{
  title: string
  description: string
  children: ReactNode
}>) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent className="h-[320px]">{children}</CardContent></Card>
}

export function AnalyticsTab() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [simulation, setSimulation] = useState({
    winRate: "50",
    averageWinR: "1.5",
    averageLossR: "1",
    riskPercent: "1",
    trades: "100",
  })

  const refresh = useCallback(async (quiet = false, signal?: AbortSignal) => {
    if (!quiet) setBusy(true)
    try {
      const response = await apiFetch(`${API_BASE}/api/trading`, { signal })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Analytics konnten nicht geladen werden.")
      setData(payload)
      setError("")
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Analytics konnten nicht geladen werden.")
    } finally {
      if (!quiet) setBusy(false)
    }
  }, [])

  useSerializedPolling(signal => refresh(true, signal), 10_000)

  const equity = useMemo(() => (data?.channelAnalytics?.equity || []).map((point: any) => ({
    ...point,
    label: new Date(point.observedAt).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
  })), [data])
  const channels = data?.channelAnalytics?.channels || []
  const exchanges = data?.channelAnalytics?.exchanges || []
  const execution = data?.executionAnalytics || { funnel: {}, latencyMs: {} }
  const totalPnl = channels.reduce((sum: number, channel: any) => sum + Number(channel.realizedPnl || 0), 0)
  const totalTrades = channels.reduce((sum: number, channel: any) => sum + Number(channel.closedTrades || 0), 0)
  const peakDrawdown = equity.reduce((peak: number, point: any) => Math.max(peak, Number(point.drawdownPercent || 0)), 0)
  const funnelData = buildExecutionFunnel(execution.funnel)
  const sim = useMemo(() => calculateExpectation(simulation), [simulation])

  if (!data) return <Card><CardContent className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">{error || "Analytics werden geladen …"}</CardContent></Card>

  return <div className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-xl font-semibold">Trading Analytics</h2><p className="text-sm text-muted-foreground">Historische Leistung, Kanalqualität, Ausführung und Risikosimulation außerhalb des Live-Cockpits.</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void refresh()}><RefreshCw className={`mr-2 h-4 w-4 ${busy ? "animate-spin" : ""}`} />Aktualisieren</Button>
    </div>
    {error && <div className="rounded-md border p-3 text-sm">{error}</div>}
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Realisierter PnL" value={number(totalPnl)} detail="90-Tage-Sicht über alle Signalquellen" icon={<TrendingUp className="h-5 w-5" />} />
      <Metric label="Geschlossene Trades" value={String(totalTrades)} detail={`${channels.length} bewertete Signalquellen`} icon={<Activity className="h-5 w-5" />} />
      <Metric label="Max. Drawdown" value={percent(peakDrawdown)} detail="Aus persistierten Equity-Snapshots" icon={<TrendingDown className="h-5 w-5" />} />
      <Metric label="Signal → Submit p95" value={formatAnalyticsDuration(execution.latencyMs?.signalToSubmit?.p95)} detail={`${execution.latencyMs?.signalToSubmit?.count || 0} vollständige Messungen`} icon={<Clock3 className="h-5 w-5" />} />
    </div>

    <div className="grid gap-4 xl:grid-cols-2">
      <ChartFrame title="Equity-Kurve" description="Persistierte Kontosnapshots; getrennte Konten bleiben über die Legende unterscheidbar.">
        <ResponsiveContainer width="100%" height="100%"><LineChart data={equity}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="label" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} width={70} /><Tooltip /><Line dataKey="equity" name="Equity" type="monotone" stroke="var(--foreground)" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer>
      </ChartFrame>
      <ChartFrame title="Drawdown-Verlauf" description="Abstand zum bisherigen Equity-Hoch in Prozent.">
        <ResponsiveContainer width="100%" height="100%"><AreaChart data={equity}><CartesianGrid vertical={false} stroke="var(--border)" /><XAxis dataKey="label" tickLine={false} axisLine={false} /><YAxis tickLine={false} axisLine={false} width={55} /><Tooltip /><Area dataKey="drawdownPercent" name="Drawdown %" type="monotone" stroke="var(--foreground)" fill="var(--muted)" /></AreaChart></ResponsiveContainer>
      </ChartFrame>
    </div>

    <Card><CardHeader><CardTitle>Kanal-Ranking</CardTitle><CardDescription>Trefferquote, Payoff, Slippage und PnL-Beitrag je Telegram-Quelle.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>#</TableHead><TableHead>Kanal</TableHead><TableHead>Trades</TableHead><TableHead>W / L</TableHead><TableHead>Win Rate</TableHead><TableHead>Payoff</TableHead><TableHead>PnL</TableHead><TableHead>Entry-Slippage</TableHead><TableHead>Intents</TableHead></TableRow></TableHeader><TableBody>{channels.map((channel: any, index: number) => <TableRow key={channel.id}><TableCell>{index + 1}</TableCell><TableCell className="font-medium">{data.configuredChannels?.find((item: any) => item.id === channel.id)?.name || channel.id}</TableCell><TableCell>{channel.closedTrades}</TableCell><TableCell>{channel.wins} / {channel.losses}</TableCell><TableCell>{percent(channel.winRatePercent)}</TableCell><TableCell>{number(channel.payoffRatio)}</TableCell><TableCell className="font-medium">{number(channel.realizedPnl)}</TableCell><TableCell>{channel.averageEntrySlippageBps === null ? "–" : `${number(channel.averageEntrySlippageBps)} bps`}</TableCell><TableCell>{channel.completedIntents} / {channel.intents}</TableCell></TableRow>)}{channels.length === 0 && <TableRow><TableCell colSpan={9} className="h-24 text-center text-muted-foreground">Noch keine geschlossenen Trades vorhanden.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>

    <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>Exchange-Ausführung</CardTitle><CardDescription>Vergleich von Durchsatz und gewichteter Entry-Slippage je Anbindung.</CardDescription></CardHeader><CardContent className="space-y-4">{exchanges.map((exchange: any) => <div key={exchange.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-b pb-3"><div><p className="font-medium">{exchange.id}</p><p className="text-xs text-muted-foreground">{exchange.completedIntents} abgeschlossen · {exchange.rejectedIntents} abgelehnt/fehlgeschlagen</p></div><Badge variant="outline">{exchange.averageEntrySlippageBps === null ? "keine Fills" : `${number(exchange.averageEntrySlippageBps)} bps`}</Badge><span className="text-sm tabular-nums">{exchange.intents} Intents</span></div>)}{exchanges.length === 0 && <p className="text-sm text-muted-foreground">Noch keine Exchange-Ausführungen vorhanden.</p>}</CardContent></Card>
      <Card><CardHeader><CardTitle>Wochenbewertungen</CardTitle><CardDescription>Nachvollziehbare Entscheidungen des adaptiven Kanalrisikos.</CardDescription></CardHeader><CardContent className="max-h-80 space-y-3 overflow-auto">{(data.channelRiskEvaluations || []).slice(0, 20).map((item: any) => <div key={item.id} className="flex items-start justify-between gap-3 border-b pb-3"><div><p className="font-medium">{item.channelId} · {item.action}</p><p className="text-xs text-muted-foreground">{item.reason}</p></div><div className="text-right text-xs tabular-nums"><p>{number(item.realizedPnl)} PnL</p><p className="text-muted-foreground">Stufe {item.previousTier} → {item.appliedTier}</p></div></div>)}{(data.channelRiskEvaluations || []).length === 0 && <p className="text-sm text-muted-foreground">Noch keine abgeschlossene Wochenbewertung.</p>}</CardContent></Card>
    </div>

    <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <ChartFrame title="Execution-Funnel" description="Messpunkte entlang der vollständigen Signal- und Orderkette.">
        <ResponsiveContainer width="100%" height="100%"><BarChart data={funnelData} layout="vertical"><CartesianGrid horizontal={false} stroke="var(--border)" /><XAxis type="number" tickLine={false} axisLine={false} /><YAxis type="category" dataKey="label" width={100} tickLine={false} axisLine={false} /><Tooltip /><Bar dataKey="count" name="Ereignisse" fill="var(--foreground)" radius={[0, 3, 3, 0]} /></BarChart></ResponsiveContainer>
      </ChartFrame>
      <Card><CardHeader><CardTitle>Latenz-Quantile</CardTitle><CardDescription>End-to-end vom Telegram-Signal bis Submit beziehungsweise erstem Fill.</CardDescription></CardHeader><CardContent className="space-y-5">{[
        ["Signal → Submit", execution.latencyMs?.signalToSubmit],
        ["Signal → erster Fill", execution.latencyMs?.signalToFirstFill],
      ].map(([label, values]: any) => <div key={label} className="rounded-md border p-4"><div className="flex items-center justify-between"><p className="font-medium">{label}</p><Badge variant="outline">{values?.count || 0} Samples</Badge></div><div className="mt-4 grid grid-cols-3 gap-3 text-center"><div><p className="text-xs text-muted-foreground">p50</p><p className="font-semibold tabular-nums">{formatAnalyticsDuration(values?.p50)}</p></div><div><p className="text-xs text-muted-foreground">p95</p><p className="font-semibold tabular-nums">{formatAnalyticsDuration(values?.p95)}</p></div><div><p className="text-xs text-muted-foreground">p99</p><p className="font-semibold tabular-nums">{formatAnalyticsDuration(values?.p99)}</p></div></div></div>)}</CardContent></Card>
    </div>

    <Card><CardHeader><CardTitle>Erwartungswert-Rechner</CardTitle><CardDescription>Deterministische R-Multiple-Simulation; keine Prognose und keine Umgehung der konfigurierten Risikolimits.</CardDescription></CardHeader><CardContent className="grid gap-6 xl:grid-cols-[1fr_0.8fr]"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">{[
      ["winRate", "Trefferquote (%)"],
      ["averageWinR", "Ø Gewinn (R)"],
      ["averageLossR", "Ø Verlust (R)"],
      ["riskPercent", "Risiko / Trade (%)"],
      ["trades", "Trades"],
    ].map(([key, label]) => <div key={key} className="space-y-2"><Label htmlFor={`simulation-${key}`}>{label}</Label><Input id={`simulation-${key}`} type="number" step="any" value={(simulation as any)[key]} onChange={event => setSimulation({ ...simulation, [key]: event.target.value })} /></div>)}</div><div className="grid grid-cols-2 gap-3"><div className="rounded-md border p-4"><Calculator className="mb-3 h-5 w-5" /><p className="text-xs text-muted-foreground">Erwartungswert / Trade</p><p className="mt-1 text-xl font-semibold">{number(sim.expectancyR, 3)} R · {number(sim.expectancyPercent, 3)} %</p></div><div className="rounded-md border p-4"><BarChart3 className="mb-3 h-5 w-5" /><p className="text-xs text-muted-foreground">Linear über Zeitraum</p><p className="mt-1 text-xl font-semibold">{number(sim.projectedPercent, 2)} %</p><p className="mt-1 text-xs text-muted-foreground">Break-even Win Rate {number(sim.breakEvenWinRate, 1)} %</p></div></div></CardContent></Card>

    <p className="text-center text-xs text-muted-foreground">Generiert: {dateTime(data.channelAnalytics?.generatedAt)} · Analysedaten bleiben getrennt vom operativen Live-Cockpit.</p>
  </div>
}
