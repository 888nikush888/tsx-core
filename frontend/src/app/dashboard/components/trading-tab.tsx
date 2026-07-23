import { cloneElement, isValidElement, useCallback, useId, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle, Ban, CheckCircle2, RefreshCw, Save, ShieldAlert, Trash2 } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useSerializedPolling } from "@/hooks/use-serialized-polling"

const API_BASE = window.location.origin
const DEFAULT_CONFIGURATION = {
  schemaVersion: 1,
  allowedSignalSchemas: ["standard", "cryptodanielvip", "loma"],
  allowedSymbols: [],
  allowedSides: ["LONG", "SHORT"],
  entry: { orderType: "limit", rangePrice: "midpoint", postOnly: false, timeoutSeconds: 10 },
  sizing: { riskPerTradePercent: "1", maxPositionNotional: "1000", maxLeverage: 3 },
  exits: {
    targetAllocationMode: "manual",
    targetAllocationsPercent: ["50", "50"],
    stopLossMode: "configured",
    moveStopToBreakEvenAfterTarget: 1,
    trailingStopPercent: null,
    closeRemainderAtLastTarget: true,
  },
  safety: { maxConcurrentPositions: 1, maxDailyLoss: "100", maxSlippagePercent: "0.5", entryOrderTtlSeconds: 900, requireProtectiveStop: true },
}

type Workspace = "overview" | "strategies" | "routing" | "accounts" | "paper" | "activity"
type Snapshot = any

function time(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString("de-DE") : "–"
}

function statusTone(status: string) {
  if (["ready", "open", "filled", "completed", "succeeded", "published"].includes(status)) return "default"
  if (["critical", "error", "failed", "unknown", "emergency", "mismatch"].includes(status)) return "destructive"
  return "secondary"
}

async function mutate(path: string, body: unknown, method = "POST", extraHeaders: Record<string, string> = {}) {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Trading-Anfrage fehlgeschlagen (${response.status}).`)
  return payload.result
}

function Metric({ label, value, detail }: Readonly<{ label: string; value: string | number; detail?: string }>) {
  return <Card><CardHeader className="pb-2"><CardDescription>{label}</CardDescription><CardTitle className="text-3xl">{value}</CardTitle></CardHeader>{detail && <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>}</Card>
}

export function TradingTab({ config }: Readonly<{ config: any }>) {
  const [data, setData] = useState<Snapshot | null>(null)
  const [workspace, setWorkspace] = useState<Workspace>("overview")
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")

  const refresh = useCallback(async (quiet = false, signal?: AbortSignal) => {
    if (!quiet) setBusy("refresh")
    try {
      const response = await apiFetch(`${API_BASE}/api/trading`, { signal })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Trading-Daten konnten nicht geladen werden.")
      setData(payload)
    } catch (error) {
      if (signal?.aborted) return
      setMessage(error instanceof Error ? error.message : "Trading-Daten konnten nicht geladen werden.")
    } finally {
      if (!quiet) setBusy("")
    }
  }, [])

  useSerializedPolling((signal) => refresh(true, signal), 3_000)

  const run = async (name: string, operation: () => Promise<unknown>, success: string) => {
    setBusy(name); setMessage("")
    try { await operation(); setMessage(success); await refresh(true); return true }
    catch (error) { setMessage(error instanceof Error ? error.message : "Aktion fehlgeschlagen."); return false }
    finally { setBusy("") }
  }

  if (!data) return <Card><CardContent className="flex min-h-64 items-center justify-center text-muted-foreground">Trading-Control-Plane wird geladen…</CardContent></Card>

  const nav: Array<[Workspace, string]> = [
    ["overview", "Betrieb"], ["strategies", "Strategien"], ["routing", "Kanal-Routing"],
    ["accounts", "Börsenkonten"], ["paper", "Paper-Märkte"], ["activity", "Trades & Risiko"],
  ]
  return <div className="space-y-5">
    <div className="flex flex-wrap gap-2">
      {nav.map(([id, label]) => <Button key={id} variant={workspace === id ? "default" : "outline"} size="sm" aria-pressed={workspace === id} onClick={() => setWorkspace(id)}>{label}</Button>)}
      <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={busy === "refresh"}><RefreshCw className="mr-2 h-4 w-4" />Aktualisieren</Button>
    </div>
    {message && <div role="status" className={`rounded-md border p-3 text-sm ${/fehl|refused|error|ungültig|nicht/i.test(message) ? "border-destructive/50 bg-destructive/5 text-destructive" : "border-primary/30 bg-primary/5"}`}>{message}</div>}
    {workspace === "overview" && <Overview data={data} busy={busy} run={run} />}
    {workspace === "strategies" && <Strategies data={data} busy={busy} run={run} />}
    {workspace === "routing" && <Routing data={data} config={config} busy={busy} run={run} />}
    {workspace === "accounts" && <Accounts data={data} busy={busy} run={run} />}
    {workspace === "paper" && <Paper data={data} busy={busy} run={run} />}
    {workspace === "activity" && <Activity data={data} busy={busy} run={run} />}
  </div>
}

function Overview({ data, busy, run }: any) {
  const runtime = data.overview.runtime
  const [livePhrase, setLivePhrase] = useState("")
  const [killReason, setKillReason] = useState("Operator stop")
  const [flattenPhrase, setFlattenPhrase] = useState("")
  return <div className="space-y-5">
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <Metric label="Offene Positionen" value={data.overview.openPositionCount} />
      <Metric label="Aktive Kanal-Routen" value={data.overview.enabledRouteCount} />
      <Metric label="Laufende Intents" value={data.overview.pendingIntentCount} />
      <Metric label="Unklare Orders" value={data.overview.unknownOrderCount} />
      <Metric label="Letzter Abgleich" value={time(data.overview.latestReconciliationAt)} />
    </div>
    {(runtime.killSwitchActive || data.overview.unknownOrderCount > 0) && <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-destructive"><div className="flex items-center gap-2 font-semibold"><ShieldAlert className="h-5 w-5" />Trading fail-closed</div><p className="mt-1 text-sm">{runtime.killSwitchReason || `${data.overview.unknownOrderCount} Order(s) mit unbekanntem Ausgang.`}</p></div>}
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>Ausführung</CardTitle><CardDescription>Neue Signale werden nur bei aktivierter Ausführung verarbeitet. Live bleibt separat gesperrt.</CardDescription></CardHeader><CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-3"><div><div className="font-medium">Automatische Ausführung</div><div className="text-xs text-muted-foreground">Kein Approval pro Trade; Strategie und Risikolimits entscheiden.</div></div><Switch checked={runtime.executionEnabled} disabled={Boolean(busy) || runtime.killSwitchActive} onCheckedChange={(enabled) => void run("execution", () => mutate("/api/trading/runtime", { action: "execution", enabled }), enabled ? "Ausführung aktiviert." : "Ausführung deaktiviert.")} /></div>
        <div className="space-y-2 rounded-md border p-3"><div className="flex items-center justify-between"><div><div className="font-medium">Live Trading</div><div className="text-xs text-muted-foreground">Eine einmalige explizite Freigabe für Echtgeldkonten.</div></div><Badge variant={runtime.liveTradingEnabled ? "default" : "secondary"}>{runtime.liveTradingEnabled ? "AKTIV" : "AUS"}</Badge></div>
          {!runtime.liveTradingEnabled ? <><Label htmlFor="live-confirm">Zum Aktivieren exakt „{data.confirmations.live}“ eingeben</Label><div className="flex gap-2"><Input id="live-confirm" value={livePhrase} onChange={(event) => setLivePhrase(event.target.value)} autoComplete="off" /><Button disabled={Boolean(busy) || livePhrase !== data.confirmations.live} onClick={() => void run("live", () => mutate("/api/trading/runtime", { action: "live", enabled: true, confirmation: livePhrase }), "Live Trading freigegeben.")}>Live freigeben</Button></div></> : <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("live-off", () => mutate("/api/trading/runtime", { action: "live", enabled: false }), "Live Trading deaktiviert.")}>Live sofort deaktivieren</Button>}
        </div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Notfallsteuerung</CardTitle><CardDescription>Stoppt neue Entries. Managed Positions können zusätzlich exchange-seitig reduce-only geschlossen werden.</CardDescription></CardHeader><CardContent className="space-y-4">
        {!runtime.killSwitchActive ? <div className="space-y-2"><Label htmlFor="kill-reason">Begründung</Label><Input id="kill-reason" value={killReason} onChange={(event) => setKillReason(event.target.value)} /><Button variant="destructive" disabled={Boolean(busy) || !killReason.trim()} onClick={() => void run("kill", () => mutate("/api/trading/runtime", { action: "kill-switch", active: true, reason: killReason }), "Kill-Switch aktiviert.")}><Ban className="mr-2 h-4 w-4" />Kill-Switch aktivieren</Button></div> : <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("unkill", () => mutate("/api/trading/runtime", { action: "kill-switch", active: false }), "Reconciliation erfolgreich; Kill-Switch aufgehoben.")}>Abgleichen und Sperre aufheben</Button>}
        <div className="space-y-2 border-t pt-4"><Label htmlFor="flatten-confirm">Zum Schließen aller managed Positionen exakt „{data.confirmations.emergencyFlatten}“ eingeben</Label><Input id="flatten-confirm" value={flattenPhrase} onChange={(event) => setFlattenPhrase(event.target.value)} autoComplete="off" /><Button variant="destructive" disabled={Boolean(busy) || flattenPhrase !== data.confirmations.emergencyFlatten} onClick={() => void run("flatten", () => mutate("/api/trading/emergency-flatten", { confirmation: flattenPhrase }), "Managed Positionen wurden geschlossen.")}><AlertTriangle className="mr-2 h-4 w-4" />Notfall-Flatten</Button></div>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("reconcile", () => mutate("/api/trading/reconcile", {}), "Alle aktivierten Konten abgeglichen.")}>Jetzt reconciliieren</Button><Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("cancel", () => mutate("/api/trading/cancel-entries", {}), "Offene Entry-Orders storniert.")}>Offene Entries stornieren</Button></div>
      </CardContent></Card>
    </div>
  </div>
}

function Strategies({ data, busy, run }: any) {
  const [selected, setSelected] = useState("")
  const current = data.strategies.find((item: any) => item.id === selected)
  const [draft, setDraft] = useState<any>({ name: "", description: "", configuration: structuredClone(DEFAULT_CONFIGURATION), strategyId: undefined })
  const selectStrategy = (strategy: any) => {
    setSelected(strategy.id)
    setDraft({ name: strategy.name, description: strategy.description, configuration: structuredClone(strategy.configuration), strategyId: strategy.strategyId })
  }
  const cfg = draft.configuration
  const targetAllocationMode = cfg.exits.targetAllocationMode ?? "manual"
  const stopLossMode = cfg.exits.stopLossMode ?? "configured"
  const patch = (section: string, field: string, value: unknown) => setDraft((old: any) => ({ ...old, configuration: { ...old.configuration, [section]: { ...old.configuration[section], [field]: value } } }))
  const toggle = (field: "allowedSignalSchemas" | "allowedSides", value: string) => setDraft((old: any) => { const list = old.configuration[field]; return { ...old, configuration: { ...old.configuration, [field]: list.includes(value) ? list.filter((item: string) => item !== value) : [...list, value] } } })
  const newStrategy = () => { setSelected(""); setDraft({ name: "Neue Strategie", description: "", configuration: structuredClone(DEFAULT_CONFIGURATION), strategyId: undefined }) }
  const newVersion = () => { if (!current) return; setSelected(""); setDraft({ name: current.name, description: current.description, configuration: structuredClone(current.configuration), strategyId: current.strategyId }) }
  const save = () => run("save-strategy", () => mutate(current?.status === "draft" ? "/api/trading/strategies/update" : "/api/trading/strategies", current?.status === "draft" ? { id: current.id, ...draft } : draft), "Strategieentwurf gespeichert.")
  const remove = async () => {
    if (!current || !window.confirm(`Strategie "${current.name} v${current.version}" endgültig löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return
    const removed = await run(
      "delete-strategy",
      () => mutate(
        "/api/trading/strategies",
        { id: current.id },
        "DELETE",
        { "X-Destructive-Confirmation": "delete-trading-strategy" },
      ),
      "Strategieversion endgültig gelöscht.",
    )
    if (removed) newStrategy()
  }
  return <div className="grid gap-5 xl:grid-cols-[320px_1fr]">
    <Card><CardHeader><CardTitle>Versionen</CardTitle><CardDescription>Publizierte Versionen sind unveränderlich und werden fest an Kanäle gebunden.</CardDescription></CardHeader><CardContent className="space-y-2"><Button className="w-full" onClick={newStrategy}>Neue Strategie</Button>{data.strategies.map((strategy: any) => <button type="button" key={strategy.id} onClick={() => selectStrategy(strategy)} className={`w-full rounded-md border p-3 text-left ${selected === strategy.id ? "border-primary bg-primary/5" : ""}`}><div className="flex justify-between gap-2"><span className="font-medium">{strategy.name} v{strategy.version}</span><Badge variant={statusTone(strategy.status) as any}>{strategy.status}</Badge></div><div className="mt-1 truncate text-xs text-muted-foreground">SHA {strategy.configurationSha256.slice(0, 12)}…</div></button>)}</CardContent></Card>
    <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><div><CardTitle>Strategie-Editor</CardTitle><CardDescription>Alle Größen sind harte, validierte Verträge. Prozentwerte als Dezimalzahl.</CardDescription></div>{current?.status === "published" && <Button variant="outline" onClick={newVersion}>Neue Version aus v{current.version}</Button>}</div></CardHeader><CardContent className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2"><Field label="Name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Beschreibung"><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field></div>
      <div className="grid gap-4 md:grid-cols-2"><Field label="Erlaubte Signal-Schemas"><div className="flex flex-wrap gap-2">{["standard", "cryptodanielvip", "loma"].map(value => <Button key={value} type="button" size="sm" variant={cfg.allowedSignalSchemas.includes(value) ? "default" : "outline"} onClick={() => toggle("allowedSignalSchemas", value)}>{value}</Button>)}</div></Field><Field label="Erlaubte Richtungen"><div className="flex gap-2">{["LONG", "SHORT"].map(value => <Button key={value} type="button" size="sm" variant={cfg.allowedSides.includes(value) ? "default" : "outline"} onClick={() => toggle("allowedSides", value)}>{value}</Button>)}</div></Field></div>
      <Field label="Erlaubte Symbole (Komma; leer = alle validen Symbole)"><Input value={cfg.allowedSymbols.join(", ")} onChange={(e) => setDraft((old: any) => ({ ...old, configuration: { ...old.configuration, allowedSymbols: e.target.value.split(",").map(v => v.trim().toUpperCase()).filter(Boolean) } }))} placeholder="BTC, ETH" /></Field>
      <Section title="Entry"><div className="grid gap-4 md:grid-cols-4"><SelectField label="Ordertyp" value={cfg.entry.orderType} options={["limit", "market"]} onChange={v => patch("entry", "orderType", v)} /><SelectField label="Range-Preis" value={cfg.entry.rangePrice} options={["near", "midpoint", "far"]} onChange={v => patch("entry", "rangePrice", v)} /><NumberField label="Timeout (s)" value={cfg.entry.timeoutSeconds} onChange={v => patch("entry", "timeoutSeconds", Number(v))} /><SwitchField label="Post-only" checked={cfg.entry.postOnly} onChange={v => patch("entry", "postOnly", v)} /></div></Section>
      <Section title="Sizing"><div className="grid gap-4 md:grid-cols-3"><NumberField label="Risiko / Trade (%)" value={cfg.sizing.riskPerTradePercent} onChange={v => patch("sizing", "riskPerTradePercent", v)} /><NumberField label="Max. Notional" value={cfg.sizing.maxPositionNotional} onChange={v => patch("sizing", "maxPositionNotional", v)} /><NumberField label="Max. Leverage" value={cfg.sizing.maxLeverage} onChange={v => patch("sizing", "maxLeverage", Number(v))} /></div></Section>
      <Section title="Take Profit & Stop"><div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <SwitchField label="Adaptive TP-Staffelung (Halbierungsregel)" checked={targetAllocationMode === "adaptive_halving"} onChange={enabled => patch("exits", "targetAllocationMode", enabled ? "adaptive_halving" : "manual")} />
          <SwitchField label="Adaptives SL-Nachziehen nach TP-Stufen" checked={stopLossMode === "adaptive_targets"} onChange={enabled => patch("exits", "stopLossMode", enabled ? "adaptive_targets" : "configured")} />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {targetAllocationMode === "manual"
            ? <Field label="TP-Allokationen (%) – Summe exakt 100"><Input value={cfg.exits.targetAllocationsPercent.join(", ")} onChange={e => patch("exits", "targetAllocationsPercent", e.target.value.split(",").map(v => v.trim()).filter(Boolean))} /></Field>
            : <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">Jeder TP bis zum vorletzten schließt die Hälfte des verbleibenden Volumens. Der letzte TP schließt den Rest; die Staffel passt sich automatisch an die TP-Anzahl des Signals an.</div>}
          {stopLossMode === "configured"
            ? <div className="grid gap-4 sm:grid-cols-2"><NumberField label="Break-even nach Target (leer = aus)" value={cfg.exits.moveStopToBreakEvenAfterTarget ?? ""} onChange={v => patch("exits", "moveStopToBreakEvenAfterTarget", v === "" ? null : Number(v))} /><NumberField label="Trailing Stop % (leer = aus)" value={cfg.exits.trailingStopPercent ?? ""} onChange={v => patch("exits", "trailingStopPercent", v === "" ? null : v)} /></div>
            : <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">Nach TP1 und TP2 wird der SL auf Break-even gesetzt; danach folgt er TP1, TP2 usw. Der SL wird nie zurückgesetzt, und nach dem letzten TP ist keine Anpassung mehr nötig.</div>}
        </div>
        <div className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-primary" />Der letzte TP schließt den vollständigen Rest zwingend.</div>
      </div></Section>
      <Section title="Harte Sicherheitslimits"><div className="grid gap-4 md:grid-cols-4"><NumberField label="Max. Positionen" value={cfg.safety.maxConcurrentPositions} onChange={v => patch("safety", "maxConcurrentPositions", Number(v))} /><NumberField label="Max. Tagesverlust" value={cfg.safety.maxDailyLoss} onChange={v => patch("safety", "maxDailyLoss", v)} /><NumberField label="Max. Slippage %" value={cfg.safety.maxSlippagePercent} onChange={v => patch("safety", "maxSlippagePercent", v)} /><NumberField label="Entry TTL (s)" value={cfg.safety.entryOrderTtlSeconds} onChange={v => patch("safety", "entryOrderTtlSeconds", Number(v))} /></div><div className="mt-3 flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-primary" />Protective Stop ist zwingend und kann nicht deaktiviert werden.</div></Section>
      {current && <p className="text-xs text-muted-foreground">Nur unbenutzte Versionen sind löschbar. Kanalrouten müssen vorher entfernt werden; Trade-Historie bleibt unveränderlich.</p>}
      <div className="flex flex-wrap gap-2"><Button onClick={() => void save()} disabled={Boolean(busy) || current?.status === "published" || current?.status === "archived"}><Save className="mr-2 h-4 w-4" />Entwurf speichern</Button>{current?.status === "draft" && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("publish", () => mutate("/api/trading/strategies/publish", { id: current.id }), "Strategieversion publiziert.")}>Publizieren</Button>}{current?.status === "published" && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("archive", () => mutate("/api/trading/strategies/archive", { id: current.id }), "Strategieversion archiviert.")}>Archivieren</Button>}{current && <Button variant="destructive" disabled={Boolean(busy)} onClick={() => void remove()}><Trash2 className="mr-2 h-4 w-4" />Strategie löschen</Button>}</div>
    </CardContent></Card>
  </div>
}

function Routing({ data, config, busy, run }: any) {
  const channels = useMemo(() => {
    const source = Array.isArray(config?.sourceChannels) ? config.sourceChannels : []
    return source.map((channel: any) => ({ id: String(channel?.id ?? channel?.channelId ?? channel), name: String(channel?.name ?? channel?.title ?? channel?.id ?? channel) }))
  }, [config])
  const [form, setForm] = useState({ channelId: "", strategyVersionId: "", accountId: "", enabled: true })
  const published = data.strategies.filter((strategy: any) => strategy.status === "published")
  const accounts = data.accounts.filter((account: any) => account.status === "ready" && account.enabled)
  return <div className="space-y-5"><Card><CardHeader><CardTitle>Kanal → Strategie → Konto</CardTitle><CardDescription>Jeder Kanal besitzt exakt eine aktive Strategieversion. Andere Kanäle laufen parallel und unabhängig.</CardDescription></CardHeader><CardContent className="grid gap-4 md:grid-cols-4">
    <Field label="Telegram-Kanal"><Input list="trading-channels" value={form.channelId} onChange={e => setForm({ ...form, channelId: e.target.value })} placeholder="Kanal-ID" /><datalist id="trading-channels">{channels.map((channel: any) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</datalist></Field>
    <SelectField label="Publizierte Strategie" value={form.strategyVersionId} options={published.map((s: any) => ({ value: s.id, label: `${s.name} v${s.version}` }))} onChange={value => setForm({ ...form, strategyVersionId: value })} />
    <SelectField label="Ausführungskonto" value={form.accountId} options={accounts.map((a: any) => ({ value: a.id, label: `${a.name} · ${a.exchange}/${a.mode}` }))} onChange={value => setForm({ ...form, accountId: value })} />
    <div className="flex items-end gap-3"><Switch checked={form.enabled} onCheckedChange={enabled => setForm({ ...form, enabled })} /><Button disabled={Boolean(busy) || !form.channelId || !form.strategyVersionId || !form.accountId} onClick={() => void run("route", () => mutate("/api/trading/routes", form), "Kanalroute gespeichert.")}>Route speichern</Button></div>
  </CardContent></Card>
  <Card><CardHeader><CardTitle>Aktive Zuordnungen</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Kanal</TableHead><TableHead>Strategie</TableHead><TableHead>Konto</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{data.routes.map((route: any) => { const strategy = data.strategies.find((s: any) => s.id === route.strategyVersionId); const account = data.accounts.find((a: any) => a.id === route.accountId); return <TableRow key={route.channelId}><TableCell>{channels.find((c: any) => c.id === route.channelId)?.name || route.channelId}</TableCell><TableCell>{strategy ? `${strategy.name} v${strategy.version}` : route.strategyVersionId}</TableCell><TableCell>{account?.name || route.accountId}</TableCell><TableCell><Badge variant={route.enabled ? "default" : "secondary"}>{route.enabled ? "aktiv" : "aus"}</Badge></TableCell><TableCell><Button size="icon" variant="ghost" disabled={Boolean(busy)} onClick={() => void run("delete-route", () => mutate("/api/trading/routes", { channelId: route.channelId }, "DELETE"), "Route entfernt.")}><Trash2 className="h-4 w-4" /></Button></TableCell></TableRow> })}</TableBody></Table></CardContent></Card></div>
}

function Accounts({ data, busy, run }: any) {
  const [form, setForm] = useState<any>({ name: "", exchange: "hyperliquid", mode: "testnet", privateKey: "", walletAddress: "", apiKey: "", apiSecret: "" })
  const [replaceId, setReplaceId] = useState("")
  const credentials = form.exchange === "hyperliquid" ? { privateKey: form.privateKey, walletAddress: form.walletAddress } : { apiKey: form.apiKey, apiSecret: form.apiSecret }
  const clearSecrets = () => setForm((old: any) => ({ ...old, privateKey: "", walletAddress: "", apiKey: "", apiSecret: "" }))
  const save = async () => { await run("account", () => mutate(replaceId ? "/api/trading/accounts/credentials" : "/api/trading/accounts", replaceId ? { id: replaceId, credentials } : { name: form.name, exchange: form.exchange, mode: form.exchange === "paper" ? "paper" : form.mode, credentials }), replaceId ? "Zugangsdaten ersetzt und verifiziert." : "Konto angelegt und verifiziert."); clearSecrets(); setReplaceId("") }
  return <div className="space-y-5"><Card><CardHeader><CardTitle>{replaceId ? "Exchange-Keys ersetzen" : "Börsenkonto hinzufügen"}</CardTitle><CardDescription>Keys werden write-only gespeichert. Der Browser erhält weder Secret noch Private Key zurück.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="grid gap-4 md:grid-cols-3"><Field label="Name"><Input value={form.name} disabled={Boolean(replaceId)} onChange={e => setForm({ ...form, name: e.target.value })} /></Field><SelectField label="Exchange" value={form.exchange} options={["hyperliquid", "bybit", "paper"]} disabled={Boolean(replaceId)} onChange={exchange => setForm({ ...form, exchange, mode: exchange === "paper" ? "paper" : "testnet" })} /><SelectField label="Modus" value={form.mode} options={form.exchange === "paper" ? ["paper"] : ["testnet", "live"]} disabled={Boolean(replaceId)} onChange={mode => setForm({ ...form, mode })} /></div>
    {form.exchange === "hyperliquid" && <div className="grid gap-4 md:grid-cols-2"><Field label="API Wallet Private Key"><Input type="password" value={form.privateKey} autoComplete="new-password" onChange={e => setForm({ ...form, privateKey: e.target.value })} /></Field><Field label="Master Wallet Address"><Input value={form.walletAddress} autoComplete="off" onChange={e => setForm({ ...form, walletAddress: e.target.value })} /></Field></div>}
    {form.exchange === "bybit" && <div className="grid gap-4 md:grid-cols-2"><Field label="API Key"><Input type="password" value={form.apiKey} autoComplete="new-password" onChange={e => setForm({ ...form, apiKey: e.target.value })} /></Field><Field label="API Secret"><Input type="password" value={form.apiSecret} autoComplete="new-password" onChange={e => setForm({ ...form, apiSecret: e.target.value })} /></Field></div>}
    <div className="flex gap-2"><Button disabled={Boolean(busy) || (!replaceId && !form.name)} onClick={() => void save()}>{replaceId ? "Keys ersetzen & prüfen" : "Konto anlegen & prüfen"}</Button>{replaceId && <Button variant="outline" onClick={() => { setReplaceId(""); clearSecrets() }}>Abbrechen</Button>}</div>
  </CardContent></Card>
  <div className="grid gap-4 lg:grid-cols-2">{data.accounts.map((account: any) => <Card key={account.id}><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle>{account.name}</CardTitle><CardDescription>{account.exchange} · {account.mode} · {account.id}</CardDescription></div><Badge variant={statusTone(account.status) as any}>{account.status}</Badge></div></CardHeader><CardContent className="space-y-3"><div className="grid grid-cols-2 gap-2 text-sm"><span className="text-muted-foreground">Keys</span><span>{account.credentials.configured ? `konfiguriert · ${time(account.credentials.updatedAt)}` : "fehlen"}</span><span className="text-muted-foreground">Verifiziert</span><span>{time(account.lastVerifiedAt)}</span>{account.lastError && <><span className="text-destructive">Fehler</span><span className="text-destructive">{account.lastError}</span></>}</div><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={Boolean(busy) || account.exchange === "paper"} onClick={() => void run("verify", () => mutate("/api/trading/accounts/verify", { id: account.id }), "Konto verifiziert.")}>Verifizieren</Button>{account.exchange !== "paper" && <Button size="sm" variant="outline" onClick={() => { setReplaceId(account.id); setForm({ ...form, name: account.name, exchange: account.exchange, mode: account.mode, privateKey: "", walletAddress: "", apiKey: "", apiSecret: "" }) }}>Keys ersetzen</Button>}<div className="flex items-center gap-2 rounded-md border px-2"><span className="text-xs">Aktiv</span><Switch checked={account.enabled} disabled={Boolean(busy)} onCheckedChange={enabled => void run("account-state", () => mutate("/api/trading/accounts/state", { id: account.id, enabled }), enabled ? "Konto aktiviert." : "Konto deaktiviert und offene Entries storniert.")} /></div>{account.id !== "paper-default" && <Button size="sm" variant="destructive" disabled={Boolean(busy)} onClick={() => { if (window.confirm("Konto nur löschen, wenn sicher keine Route, Historie oder Exchange-Exposure besteht?")) void run("delete-account", () => mutate("/api/trading/accounts", { id: account.id }, "DELETE"), "Konto sicher gelöscht.") }}><Trash2 className="mr-2 h-4 w-4" />Löschen</Button>}</div></CardContent></Card>)}</div></div>
}

function Paper({ data, busy, run }: any) {
  const accounts = data.accounts.filter((account: any) => account.exchange === "paper")
  const [form, setForm] = useState<any>({ accountId: accounts[0]?.id || "", equity: "10000", availableBalance: "10000", symbol: "BTC", markPrice: "60000", priceTick: "0.1", quantityStep: "0.001", minimumQuantity: "0.001", minimumNotional: "10", maxLeverage: 20 })
  const save = () => run("paper", () => mutate("/api/trading/paper", { accountId: form.accountId, equity: form.equity, availableBalance: form.availableBalance, market: { symbol: form.symbol, markPrice: form.markPrice, priceTick: form.priceTick, quantityStep: form.quantityStep, minimumQuantity: form.minimumQuantity, minimumNotional: form.minimumNotional, maxLeverage: Number(form.maxLeverage) } }), "Paper-Konto und Markt aktualisiert; offene Paper-Orders wurden deterministisch ausgewertet.")
  return <div className="space-y-5"><Card><CardHeader><CardTitle>Paper Exchange</CardTitle><CardDescription>Reproduzierbare lokale Börsensimulation für Strategie- und Signaltests.</CardDescription></CardHeader><CardContent className="space-y-5"><div className="grid gap-4 md:grid-cols-3"><SelectField label="Paper-Konto" value={form.accountId} options={accounts.map((a: any) => ({ value: a.id, label: a.name }))} onChange={accountId => setForm({ ...form, accountId })} /><NumberField label="Equity" value={form.equity} onChange={equity => setForm({ ...form, equity })} /><NumberField label="Verfügbar" value={form.availableBalance} onChange={availableBalance => setForm({ ...form, availableBalance })} /></div><div className="grid gap-4 md:grid-cols-4"><Field label="Symbol"><Input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase() })} /></Field><NumberField label="Mark Price" value={form.markPrice} onChange={markPrice => setForm({ ...form, markPrice })} /><NumberField label="Price Tick" value={form.priceTick} onChange={priceTick => setForm({ ...form, priceTick })} /><NumberField label="Quantity Step" value={form.quantityStep} onChange={quantityStep => setForm({ ...form, quantityStep })} /><NumberField label="Min. Quantity" value={form.minimumQuantity} onChange={minimumQuantity => setForm({ ...form, minimumQuantity })} /><NumberField label="Min. Notional" value={form.minimumNotional} onChange={minimumNotional => setForm({ ...form, minimumNotional })} /><NumberField label="Max. Leverage" value={form.maxLeverage} onChange={maxLeverage => setForm({ ...form, maxLeverage: Number(maxLeverage) })} /></div><Button disabled={Boolean(busy) || !form.accountId} onClick={() => void save()}><Save className="mr-2 h-4 w-4" />Paper-Status speichern</Button></CardContent></Card>
    <Card><CardHeader><CardTitle>Konfigurierte Märkte</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Konto</TableHead><TableHead>Symbol</TableHead><TableHead>Mark</TableHead><TableHead>Tick / Step</TableHead><TableHead>Minimum</TableHead><TableHead>Leverage</TableHead></TableRow></TableHeader><TableBody>{data.activity.paperMarkets.map((market: any) => <TableRow key={`${market.accountId}-${market.symbol}`}><TableCell>{market.accountId}</TableCell><TableCell>{market.symbol}</TableCell><TableCell>{market.markPrice}</TableCell><TableCell>{market.priceTick} / {market.quantityStep}</TableCell><TableCell>{market.minimumQuantity} / {market.minimumNotional}</TableCell><TableCell>{market.maxLeverage}×</TableCell></TableRow>)}</TableBody></Table></CardContent></Card></div>
}

function Activity({ data, busy, run }: any) {
  const activePositions = data.activity.positions.filter((position: any) => position.status !== "closed")
  return <div className="space-y-5"><Card><CardHeader><CardTitle>Managed Positionen</CardTitle><CardDescription>Position, Strategie und Ursprungskanal bleiben bis zum vollständigen Exit verknüpft.</CardDescription></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Symbol</TableHead><TableHead>Seite</TableHead><TableHead>Menge</TableHead><TableHead>Entry / Stop</TableHead><TableHead>Kanal</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{activePositions.map((position: any) => <TableRow key={position.id}><TableCell>{position.symbol}</TableCell><TableCell>{position.side}</TableCell><TableCell>{position.quantity}</TableCell><TableCell>{position.averageEntryPrice || "–"} / {position.stopPrice}</TableCell><TableCell>{position.channelId}</TableCell><TableCell><Badge variant={statusTone(position.status) as any}>{position.status}</Badge></TableCell></TableRow>)}</TableBody></Table></CardContent></Card>
  <Card><CardHeader><CardTitle>Orders & Fills</CardTitle></CardHeader><CardContent className="space-y-5"><Table><TableHeader><TableRow><TableHead>Zeit</TableHead><TableHead>Rolle</TableHead><TableHead>Seite</TableHead><TableHead>Menge</TableHead><TableHead>Preis / Trigger</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>{data.activity.orders.slice(0, 100).map((order: any) => <TableRow key={order.id}><TableCell>{time(order.updatedAt)}</TableCell><TableCell>{order.role}</TableCell><TableCell>{order.side}</TableCell><TableCell>{order.filledQuantity} / {order.quantity}</TableCell><TableCell>{order.price || "–"} / {order.triggerPrice || "–"}</TableCell><TableCell><Badge variant={statusTone(order.status) as any}>{order.status}</Badge></TableCell></TableRow>)}</TableBody></Table><div className="text-sm text-muted-foreground">{data.activity.fills.length} persistierte Fill(s); Rohantworten und Secrets werden bewusst nicht im Browser angezeigt.</div></CardContent></Card>
  <Card><CardHeader><CardTitle>Risk Events & Reconciliation</CardTitle></CardHeader><CardContent><Table><TableHeader><TableRow><TableHead>Zeit</TableHead><TableHead>Schwere</TableHead><TableHead>Code</TableHead><TableHead>Details</TableHead><TableHead>Konto</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>{data.activity.riskEvents.map((event: any) => <TableRow key={event.id}><TableCell>{time(event.createdAt)}</TableCell><TableCell><Badge variant={statusTone(event.severity) as any}>{event.severity}</Badge></TableCell><TableCell>{event.code}</TableCell><TableCell>{riskEventDetail(event)}</TableCell><TableCell>{event.accountId || "–"}</TableCell><TableCell>{event.acknowledgedAt ? `bestätigt ${time(event.acknowledgedAt)}` : "offen"}</TableCell><TableCell>{!event.acknowledgedAt && <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void run("ack-risk", () => mutate("/api/trading/risk/acknowledge", { id: event.id }), "Risk Event bestätigt.")}>Bestätigen</Button>}</TableCell></TableRow>)}</TableBody></Table><div className="mt-5 flex flex-wrap gap-2">{data.activity.reconciliations.slice(0, 10).map((item: any) => <Badge key={item.id} variant={statusTone(item.status) as any}>{item.accountId}: {item.status} · {time(item.completedAt)}</Badge>)}</div></CardContent></Card></div>
}

function riskEventDetail(event: any) {
  if (event.code !== "STOP_LOSS_MOVED") return event.details?.message || "–"
  const reference = event.details?.referenceTargetIndex
  const reason = reference
    ? `TP${reference}`
    : event.details?.reason === "trailing_stop" ? "Trailing Stop" : "Break-even"
  return `${event.details?.fromTrigger || "–"} → ${event.details?.toTrigger || "–"} · ${reason}`
}

function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  const generatedId = useId()
  if (!isValidElement<{ id?: string }>(children) || children.type === 'div') {
    const labelId = `${generatedId}-label`
    const groupedChildren = isValidElement(children)
      ? cloneElement(children, { 'aria-labelledby': labelId } as Record<string, unknown>)
      : children
    return <div className="space-y-2"><span id={labelId} className="text-sm font-medium">{label}</span>{groupedChildren}</div>
  }
  const control = isValidElement<{ id?: string }>(children)
    ? cloneElement(children, { id: children.props.id || generatedId })
    : children
  const controlId = isValidElement<{ id?: string }>(control) ? control.props.id : generatedId
  return <div className="space-y-2"><Label htmlFor={controlId}>{label}</Label>{control}</div>
}
function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) { return <div className="rounded-lg border p-4"><h3 className="mb-4 font-semibold">{title}</h3>{children}</div> }
function NumberField({ label, value, onChange }: Readonly<{ label: string; value: string | number; onChange: (value: string) => void }>) { return <Field label={label}><Input type="number" step="any" value={value} onChange={e => onChange(e.target.value)} /></Field> }
function SwitchField({ label, checked, onChange }: Readonly<{ label: string; checked: boolean; onChange: (value: boolean) => void }>) { const id = useId(); return <div className="flex h-full items-end gap-3 pb-2"><Switch id={id} checked={checked} onCheckedChange={onChange} /><Label htmlFor={id}>{label}</Label></div> }
function SelectField({ label, value, options, onChange, disabled = false }: Readonly<{ label: string; value: string; options: Array<string | { value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }>) { const id = useId(); return <div className="space-y-2"><Label htmlFor={id}>{label}</Label><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger id={id}><SelectValue placeholder="Auswählen" /></SelectTrigger><SelectContent>{options.map(option => { const item = typeof option === "string" ? { value: option, label: option } : option; return <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem> })}</SelectContent></Select></div> }
