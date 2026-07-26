import { useMemo, useState, type ReactNode } from "react"
import { Save, Trash2 } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const API_BASE = window.location.origin

async function mutate(path: string, body: unknown, method = "POST") {
  const response = await apiFetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Risikopolice-Anfrage fehlgeschlagen (${response.status}).`)
  return payload.result
}

const DEFAULT_POLICY = {
  channelId: "",
  mode: "fixed",
  tiers: [{ riskPercent: "0.5" }, { riskPercent: "0.75" }, { riskPercent: "1" }],
  currentTier: 2,
  lookbackWeeks: 4,
  minimumClosedTrades: 10,
  lossThresholdPercent: "1",
  profitThresholdPercent: "1",
  weakChannelAction: "reduce",
  weakWeeksBeforeBlock: 3,
  manuallyBlocked: false,
  lockedTier: null,
}

function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>
}

function SelectField({ label, value, options, onChange }: Readonly<{
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}>) {
  return <Field label={label}><Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
}

export function ChannelRiskManager({ data, channels, busy, run }: Readonly<{
  data: any
  channels: Array<{ id: string; name: string }>
  busy: string
  run: any
}>) {
  const policies = Array.isArray(data.channelRiskPolicies) ? data.channelRiskPolicies : []
  const evaluations = Array.isArray(data.channelRiskEvaluations) ? data.channelRiskEvaluations : []
  const [form, setForm] = useState<any>({ ...DEFAULT_POLICY })
  const channelOptions = useMemo(() => {
    const known = new Map(channels.map(channel => [channel.id, channel.name]))
    for (const route of data.routes || []) if (!known.has(route.channelId)) known.set(route.channelId, route.channelId)
    return [...known.entries()].map(([value, label]) => ({ value, label }))
  }, [channels, data.routes])
  const selectPolicy = (channelId: string) => {
    const policy = policies.find((item: any) => item.channelId === channelId)
    setForm(policy ? structuredClone(policy) : { ...structuredClone(DEFAULT_POLICY), channelId })
  }
  const save = () => run(
    "channel-risk",
    () => mutate("/api/trading/channel-risk", {
      ...form,
      tiers: form.tiers,
      currentTier: Number(form.currentTier),
      lookbackWeeks: Number(form.lookbackWeeks),
      minimumClosedTrades: Number(form.minimumClosedTrades),
      weakWeeksBeforeBlock: Number(form.weakWeeksBeforeBlock),
      lockedTier: form.lockedTier === "" || form.lockedTier === null ? null : Number(form.lockedTier),
    }),
    "Kanalbezogene Risikopolice gespeichert.",
  )
  const remove = () => {
    if (!form.channelId || !window.confirm("Risikopolice entfernen und auf das feste Strategierisiko zurückfallen?")) return
    void run("delete-channel-risk", () => mutate("/api/trading/channel-risk", { channelId: form.channelId }, "DELETE"), "Risikopolice entfernt.")
  }
  const tierText = form.tiers.map((tier: any) => tier.riskPercent).join(", ")
  const setTierText = (value: string) => {
    const tiers = value.split(",").map(item => item.trim()).filter(Boolean).map(riskPercent => ({ riskPercent }))
    setForm({ ...form, tiers, currentTier: Math.min(Number(form.currentTier), Math.max(0, tiers.length - 1)) })
  }
  const selectedPolicy = policies.find((policy: any) => policy.channelId === form.channelId)

  return <Card>
    <CardHeader><CardTitle>Dynamisches Kanalrisiko</CardTitle><CardDescription>Jeder Kanal kann fest, beobachtend oder automatisch bewertet werden. Strategieobergrenze, Signal-Cap und globale Sicherheitsgates bleiben zwingend.</CardDescription></CardHeader>
    <CardContent className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
        <SelectField label="Telegram-Kanal" value={form.channelId} options={channelOptions} onChange={selectPolicy} />
        <SelectField label="Modus" value={form.mode} options={[
          { value: "fixed", label: "Fest" },
          { value: "shadow", label: "Schattenbetrieb" },
          { value: "automatic", label: "Automatisch" },
        ]} onChange={mode => setForm({ ...form, mode })} />
        <Field label="Risikostufen (%)"><Input value={tierText} onChange={event => setTierText(event.target.value)} placeholder="0.5, 0.75, 1" /></Field>
        <Field label="Aktuelle Stufe"><Input type="number" min={0} max={Math.max(0, form.tiers.length - 1)} value={form.currentTier} onChange={event => setForm({ ...form, currentTier: Number(event.target.value) })} /></Field>
        <Field label="Stufe sperren"><Input type="number" min={0} max={Math.max(0, form.tiers.length - 1)} value={form.lockedTier ?? ""} placeholder="frei" onChange={event => setForm({ ...form, lockedTier: event.target.value })} /></Field>
        <Field label="Auswertungswochen"><Input type="number" min={1} max={12} value={form.lookbackWeeks} onChange={event => setForm({ ...form, lookbackWeeks: Number(event.target.value) })} /></Field>
        <Field label="Mindest-Trades"><Input type="number" min={1} max={1000} value={form.minimumClosedTrades} onChange={event => setForm({ ...form, minimumClosedTrades: Number(event.target.value) })} /></Field>
        <Field label="Verlustschwelle (%)"><Input type="number" step="any" value={form.lossThresholdPercent} onChange={event => setForm({ ...form, lossThresholdPercent: event.target.value })} /></Field>
        <Field label="Gewinnschwelle (%)"><Input type="number" step="any" value={form.profitThresholdPercent} onChange={event => setForm({ ...form, profitThresholdPercent: event.target.value })} /></Field>
        <SelectField label="Bei anhaltender Schwäche" value={form.weakChannelAction} options={[
          { value: "none", label: "Nur Staffel anwenden" },
          { value: "reduce", label: "Risiko reduzieren" },
          { value: "block", label: "Kanal blockieren" },
        ]} onChange={weakChannelAction => setForm({ ...form, weakChannelAction })} />
        <Field label="Schwache Bewertungen bis Sperre"><Input type="number" min={1} max={52} value={form.weakWeeksBeforeBlock} onChange={event => setForm({ ...form, weakWeeksBeforeBlock: Number(event.target.value) })} /></Field>
        <label className="flex items-end gap-3 pb-2"><Switch checked={form.manuallyBlocked} onCheckedChange={manuallyBlocked => setForm({ ...form, manuallyBlocked })} /><span className="text-sm font-medium">Manuell blockiert</span></label>
      </div>
      {selectedPolicy && <div className="flex flex-wrap gap-2 text-sm"><Badge variant="outline">Policy v{selectedPolicy.policyVersion}</Badge><Badge variant="outline">Stufe {selectedPolicy.currentTier}</Badge><Badge variant={selectedPolicy.blocked ? "destructive" : "secondary"}>{selectedPolicy.blocked ? selectedPolicy.blockReason || "blockiert" : "freigegeben"}</Badge></div>}
      <div className="flex gap-2"><Button disabled={Boolean(busy) || !form.channelId || form.tiers.length === 0} onClick={() => void save()}><Save className="mr-2 h-4 w-4" />Police speichern</Button>{selectedPolicy && <Button variant="destructive" disabled={Boolean(busy)} onClick={remove}><Trash2 className="mr-2 h-4 w-4" />Entfernen</Button>}</div>
      <Table><TableHeader><TableRow><TableHead>Zeitraum</TableHead><TableHead>Kanal</TableHead><TableHead>Trades</TableHead><TableHead>PnL / Return</TableHead><TableHead>Stufe</TableHead><TableHead>Entscheidung</TableHead></TableRow></TableHeader><TableBody>{evaluations.slice(0, 20).map((evaluation: any) => <TableRow key={evaluation.id}><TableCell>{new Date(evaluation.weekStartedAt).toLocaleDateString("de-DE")} – {new Date(evaluation.weekEndedAt).toLocaleDateString("de-DE")}</TableCell><TableCell>{evaluation.channelId}</TableCell><TableCell>{evaluation.closedTrades} ({evaluation.wins}/{evaluation.losses})</TableCell><TableCell>{evaluation.realizedPnl} / {evaluation.returnPercent}%</TableCell><TableCell>{evaluation.previousTier} → {evaluation.appliedTier}</TableCell><TableCell><Badge variant="outline">{evaluation.action}</Badge><div className="mt-1 max-w-md text-xs text-muted-foreground">{evaluation.reason}</div></TableCell></TableRow>)}</TableBody></Table>
    </CardContent>
  </Card>
}
