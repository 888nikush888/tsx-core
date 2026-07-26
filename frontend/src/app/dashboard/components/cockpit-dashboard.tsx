import { useCallback, useMemo, useState, type ReactNode } from "react"
import {
  Activity,
  Ban,
  Bot,
  CircleDot,
  Radio,
  RefreshCw,
  Shield,
  Square,
  WalletCards,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { apiFetch } from "@/lib/api"
import { useSerializedPolling } from "@/hooks/use-serialized-polling"
import type { MetricPoint } from "./chart-area-interactive"

const API_BASE = window.location.origin

type SetupStep = { label: string; complete: boolean }
type QueueState = { running: number; queued: number; maxConcurrency: number; paused: boolean }

interface CockpitDashboardProps {
  readonly isRunning: boolean
  readonly connectionState: string
  readonly totalForwardedCount: number
  readonly processedSinceRestart: number
  readonly forwardingEnabled: boolean
  readonly forwardXmlToTarget: boolean
  readonly uptime: string
  readonly queue: QueueState
  readonly parserEnabled: boolean
  readonly setupSteps: SetupStep[]
  readonly setupComplete: boolean
  readonly routingConfigReady: boolean
  readonly metricsHistory: MetricPoint[]
  readonly onToggleRouting: () => void | Promise<void>
  readonly onNavigate: (tab: string) => void
}

async function request(path: string, init?: RequestInit): Promise<any> {
  const response = await apiFetch(`${API_BASE}${path}`, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Anfrage fehlgeschlagen (${response.status}).`)
  return payload
}

function time(value: unknown): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toLocaleString("de-DE") : "–"
}

function value(input: unknown, suffix = ""): string {
  const parsed = Number(input)
  if (!Number.isFinite(parsed)) return "–"
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(parsed)}${suffix}`
}

function StatusLine({ label, detail, active, icon }: Readonly<{
  label: string
  detail: string
  active: boolean
  icon: ReactNode
}>) {
  return <div className="flex items-center gap-3 border-b py-3 last:border-b-0"><div className="rounded-md border p-2">{icon}</div><div className="min-w-0 flex-1"><p className="text-sm font-medium">{label}</p><p className="truncate text-xs text-muted-foreground">{detail}</p></div><Badge variant={active ? "default" : "outline"}><span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current" />{active ? "aktiv" : "inaktiv"}</Badge></div>
}

function Metric({ label, value: metricValue, detail }: Readonly<{ label: string; value: string; detail: string }>) {
  return <Card><CardContent className="p-5"><p className="text-xs uppercase tracking-[0.14em] text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{metricValue}</p><p className="mt-2 text-xs text-muted-foreground">{detail}</p></CardContent></Card>
}

function signalSummary(xml: string): { action: string; pair: string } {
  const action = /<action>([^<]+)<\/action>/i.exec(xml)?.[1]?.trim() || "–"
  const pair = /<pair>([^<]+)<\/pair>/i.exec(xml)?.[1]?.trim() || "–"
  return { action, pair }
}

export function CockpitDashboard(props: Readonly<CockpitDashboardProps>) {
  const [trading, setTrading] = useState<any>(null)
  const [portfolio, setPortfolio] = useState<any>({ accounts: [] })
  const [signals, setSignals] = useState<any[]>([])
  const [access, setAccess] = useState<any>(null)
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")
  const [flattenPhrase, setFlattenPhrase] = useState("")

  const refresh = useCallback(async (quiet = false, signal?: AbortSignal) => {
    if (!quiet) setBusy("refresh")
    const results = await Promise.allSettled([
      request("/api/trading", { signal }),
      request("/api/trading/portfolio", { signal }),
      request("/api/processed-signals", { signal }),
      request("/api/access", { signal }),
    ])
    if (signal?.aborted) return
    if (results[0].status === "fulfilled") setTrading(results[0].value)
    if (results[1].status === "fulfilled") setPortfolio(results[1].value)
    if (results[2].status === "fulfilled") setSignals(results[2].value.signals || [])
    if (results[3].status === "fulfilled") setAccess(results[3].value)
    const failed = results.filter(result => result.status === "rejected")
    setMessage(failed.length > 0 ? `${failed.length} Cockpit-Datenquelle(n) sind vorübergehend nicht erreichbar.` : "")
    if (!quiet) setBusy("")
  }, [])

  useSerializedPolling(signal => refresh(true, signal), 5_000)

  const run = async (name: string, path: string, body: unknown, success: string) => {
    setBusy(name)
    setMessage("")
    try {
      await request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      setMessage(success)
      await refresh(true)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Aktion fehlgeschlagen.")
    } finally {
      setBusy("")
    }
  }

  const activePositions = (trading?.activity?.positions || []).filter((position: any) => position.status !== "closed")
  const runtime = trading?.overview?.runtime || {}
  const portfolioMap = useMemo(() => new Map(
    (portfolio.accounts || []).map((account: any) => [account.accountId, account]),
  ), [portfolio.accounts])
  const aggregateUpl = (portfolio.accounts || []).reduce((sum: number, account: any) => sum + Number(account.unrealizedPnl || 0), 0)
  const aggregateEquity = (portfolio.accounts || []).reduce((sum: number, account: any) => sum + Number(account.equity || 0), 0)
  const recentSignals = signals.slice(0, 12)
  const operational = props.isRunning && props.connectionState !== "disconnected" && !runtime.killSwitchActive

  return <div className="space-y-5 px-4 pb-10 lg:px-6">
    <section className="flex flex-col gap-4 rounded-lg border p-5 lg:flex-row lg:items-center lg:justify-between">
      <div><div className="mb-2 flex items-center gap-2"><Badge variant={operational ? "default" : "outline"}><CircleDot className="mr-1.5 h-3 w-3" />{operational ? "System operativ" : "Eingeschränkter Betrieb"}</Badge><span className="text-xs text-muted-foreground">Letzter Abgleich {time(trading?.overview?.latestReconciliationAt)}</span></div><h1 className="text-2xl font-semibold tracking-tight">Live-Cockpit</h1><p className="mt-1 text-sm text-muted-foreground">Nur der aktuelle Handelsbetrieb, aktive Exponierung und sofortige Operator-Aktionen.</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw className={`mr-2 h-4 w-4 ${busy === "refresh" ? "animate-spin" : ""}`} />Aktualisieren</Button><Button variant="outline" disabled={!props.isRunning && !props.routingConfigReady} onClick={() => void props.onToggleRouting()}>{props.isRunning ? <><Square className="mr-2 h-4 w-4" />Routing stoppen</> : <><Radio className="mr-2 h-4 w-4" />Routing starten</>}</Button><Button onClick={() => props.onNavigate("analytics")}><Activity className="mr-2 h-4 w-4" />Analytics</Button></div>
    </section>

    {message && <output className="block rounded-md border p-3 text-sm">{message}</output>}
    {!props.setupComplete && <Card><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="font-medium">Inbetriebnahme {props.setupSteps.filter(step => step.complete).length}/{props.setupSteps.length}</p><p className="text-xs text-muted-foreground">Fehlende Grundkonfiguration hält das System fail-closed.</p></div><Button variant="outline" onClick={() => props.onNavigate("signals")}>Setup öffnen</Button></CardContent></Card>}

    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Offene Positionen" value={String(activePositions.length)} detail={`${trading?.overview?.pendingIntentCount || 0} laufende Intents`} />
      <Metric label="Nominale Equity" value={value(aggregateEquity)} detail="USD / USDC / Paper-Quote ohne FX-Zusicherung" />
      <Metric label="Unrealisierter PnL" value={value(aggregateUpl)} detail="Aktueller Kontosnapshot der angebundenen Exchanges" />
      <Metric label="Signalfluss" value={String(props.processedSinceRestart)} detail={`${props.totalForwardedCount} gesamt · Queue ${props.queue.running}/${props.queue.queued}`} />
    </div>

    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[0.8fr_1.2fr]">
      <Card><CardHeader><CardTitle>System & Sicherheit</CardTitle><CardDescription>Entscheidende Live-Gates auf einen Blick.</CardDescription></CardHeader><CardContent>
        <StatusLine label="Telegram & Routing" detail={`${props.connectionState} · Uptime ${props.uptime}`} active={props.isRunning && props.forwardingEnabled} icon={<Radio className="h-4 w-4" />} />
        <StatusLine label="Execution Engine" detail={`${trading?.overview?.enabledRouteCount || 0} aktive Kanalrouten`} active={Boolean(runtime.executionEnabled)} icon={<Bot className="h-4 w-4" />} />
        <StatusLine label="Handelsmodus" detail={runtime.liveTradingEnabled ? "Live-Konten freigegeben" : "Paper/Testnet oder Live gesperrt"} active={Boolean(runtime.liveTradingEnabled)} icon={<WalletCards className="h-4 w-4" />} />
        <StatusLine label="Kill-Switch" detail={runtime.killSwitchReason || "Keine globale Handelssperre"} active={Boolean(runtime.killSwitchActive)} icon={<Shield className="h-4 w-4" />} />
        <StatusLine label="Remote-Zugriff" detail={access?.identity ? `${access.identity.name || access.identity.login} · ${access.role}` : "Kein Tailscale-Serve-Identitätskontext"} active={Boolean(access?.remoteAccess?.connected)} icon={<Radio className="h-4 w-4" />} />
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Aktive Positionen</CardTitle><CardDescription>Managed Exposure mit kontoaktuellem UPL-Kontext.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Symbol</TableHead><TableHead>Seite</TableHead><TableHead>Menge</TableHead><TableHead>Entry / Stop</TableHead><TableHead>Kanal</TableHead><TableHead>Konto-UPL</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{activePositions.map((position: any) => { const account: any = portfolioMap.get(position.accountId); return <TableRow key={position.id}><TableCell className="font-medium">{position.symbol}</TableCell><TableCell><Badge variant="outline">{position.side}</Badge></TableCell><TableCell>{position.quantity}</TableCell><TableCell>{position.averageEntryPrice || "–"} / {position.stopPrice || "–"}</TableCell><TableCell>{position.channelId}</TableCell><TableCell>{value(account?.unrealizedPnl)}</TableCell><TableCell>{position.status}</TableCell></TableRow>})}{activePositions.length === 0 && <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">Keine aktive managed Position.</TableCell></TableRow>}</TableBody></Table></CardContent></Card>
    </div>

    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <Card><CardHeader><CardTitle>Live-Signal-Stream</CardTitle><CardDescription>Die zuletzt extrahierten und persistierten Telegram-Signale.</CardDescription></CardHeader><CardContent className="space-y-2">{recentSignals.map(signal => { const summary = signalSummary(signal.xml_content || ""); return <div key={signal.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b py-2"><Badge variant="outline">{summary.action}</Badge><div className="min-w-0"><p className="font-medium">{summary.pair}</p><p className="truncate text-xs text-muted-foreground">{signal.chat_id} · Nachricht {signal.message_id}</p></div><time className="text-xs text-muted-foreground">{time(signal.created_at)}</time></div>})}{recentSignals.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Noch keine verarbeiteten Signale.</p>}</CardContent></Card>

      <Card><CardHeader><CardTitle>Notfall-Schnellaktionen</CardTitle><CardDescription>Explizite, auditierte Eingriffe in den laufenden Betrieb.</CardDescription></CardHeader><CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2"><Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("reconcile", "/api/trading/reconcile", {}, "Exchange-Abgleich abgeschlossen.")}>Mit Börsen abgleichen</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("cancel", "/api/trading/cancel-entries", {}, "Offene Entry-Orders storniert.")}>Offene Orders stornieren</Button></div>
        {!runtime.killSwitchActive ? <Button className="w-full" variant="outline" disabled={Boolean(busy)} onClick={() => void run("kill", "/api/trading/runtime", { action: "kill-switch", active: true, reason: "Cockpit emergency stop" }, "Kill-Switch aktiviert.")}><Ban className="mr-2 h-4 w-4" />Kill-Switch aktivieren</Button> : <Button className="w-full" variant="outline" disabled={Boolean(busy)} onClick={() => void run("unkill", "/api/trading/runtime", { action: "kill-switch", active: false }, "Abgleich erfolgreich; Kill-Switch aufgehoben.")}>Abgleichen und Sperre aufheben</Button>}
        <div className="space-y-2 border-t pt-4"><Label htmlFor="cockpit-flatten">Zum Schließen aller managed Positionen exakt „{trading?.confirmations?.emergencyFlatten || "FLATTEN ALL MANAGED POSITIONS"}“ eingeben</Label><Input id="cockpit-flatten" value={flattenPhrase} onChange={event => setFlattenPhrase(event.target.value)} autoComplete="off" /><Button className="w-full" disabled={Boolean(busy) || flattenPhrase !== trading?.confirmations?.emergencyFlatten} onClick={() => void run("flatten", "/api/trading/emergency-flatten", { confirmation: flattenPhrase }, "Alle managed Positionen wurden geschlossen.")}>Alle Positionen schließen</Button></div>
      </CardContent></Card>
    </div>
  </div>
}
