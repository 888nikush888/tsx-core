import { useEffect, useMemo, useState } from "react"
import { Bot, CheckCircle2, Copy, KeyRound, Plus, RefreshCw, Save, Trash2, XCircle } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { useSerializedPolling } from "@/hooks/use-serialized-polling"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

const API_BASE = window.location.origin

type Agent = {
  id: string
  name: string
  tokenPrefix: string
  permissions: string[]
  eventSubscriptions: string[]
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastSeenAt: number | null
}

type Session = {
  id: string
  agentId: string
  clientName: string
  clientVersion: string
  connectedAt: number
  lastSeenAt: number
  disconnectedAt: number | null
}

type Action = {
  id: string
  agentId: string
  agentName: string
  toolName: string
  permission: string
  outcome: string
  error: string | null
  completedAt: number
  durationMs: number
}

type Proposal = {
  id: string
  agentId: string
  agentName: string
  action: string
  status: string
  requestedAt: number
  expiresAt: number
  preflight: {
    requiresApproval: boolean
    allowed: boolean
    blockers: string[]
    impact: string[]
    checkedAt: number
  }
  error: string | null
}

type Snapshot = {
  agents: Agent[]
  sessions: Session[]
  actions: Action[]
  proposals: Proposal[]
  permissions: string[]
  eventTypes: string[]
  endpoint: string | null
}

const EMPTY: Snapshot = {
  agents: [],
  sessions: [],
  actions: [],
  proposals: [],
  permissions: [],
  eventTypes: [],
  endpoint: null,
}

const PERMISSION_LABELS: Record<string, string> = {
  "system.read": "Systemstatus lesen",
  "contracts.read": "Verträge lesen",
  "positions.read": "Positionen lesen",
  "signals.read": "Signale lesen",
  "risk.read": "Risiko lesen",
  "strategies.read": "Strategien lesen",
  "routes.read": "Kanal-Routen lesen",
  "analytics.read": "Analytics lesen",
  "journal.read": "Trade Journal lesen",
  "contracts.write": "Verträge ändern",
  "risk.write": "Risiko ändern",
  "strategies.write": "Strategien ändern",
  "routes.write": "Kanal-Routen ändern",
  "trading.reconcile": "Börsenabgleich starten",
  "trading.cancel_entries": "Entry-Orders stornieren",
  "trading.kill_switch": "Kill-Switch steuern",
  "trading.flatten": "Positionen glattstellen",
}

const EVENT_LABELS: Record<string, string> = {
  signal_received: "Signal empfangen",
  signal_validated: "Signal validiert",
  intent_created: "Trade-Intent erstellt",
  submit_started: "Orderübermittlung gestartet",
  exchange_ack: "Börse bestätigt",
  first_fill: "Erster Fill",
  fully_filled: "Vollständig ausgeführt",
  position_closed: "Position geschlossen",
  kill_switch_activated: "Kill-Switch ausgelöst",
  contract_changed: "Vertrag geändert",
  risk_policy_changed: "Risikopolice geändert",
}

function formattedDate(value: number | null): string {
  return value ? new Date(value).toLocaleString("de-DE") : "Noch nie"
}

function agentConnectionLabel(connected: boolean, enabled: boolean): string {
  if (connected) return "verbunden"
  return enabled ? "bereit" : "deaktiviert"
}

function sessionConnectionLabel(connected: boolean, disconnectedAt: number | null): string {
  if (connected) return "verbunden"
  return disconnectedAt ? "beendet" : "inaktiv"
}

function ToggleGrid({ values, selected, labels, onChange }: Readonly<{
  values: string[]
  selected: string[]
  labels: Record<string, string>
  onChange: (next: string[]) => void
}>) {
  const selectedSet = new Set(selected)
  return <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
    {values.map(value => <label key={value} className="flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2">
      <span><span className="block text-sm font-medium">{labels[value] || value}</span><span className="block font-mono text-[11px] text-muted-foreground">{value}</span></span>
      <Switch
        checked={selectedSet.has(value)}
        onCheckedChange={(checked) => onChange(checked
          ? [...selected, value]
          : selected.filter(item => item !== value))}
      />
    </label>)}
  </div>
}

export function McpAgentsTab() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const [selectedId, setSelectedId] = useState("")
  const [form, setForm] = useState({ name: "", permissions: [] as string[], eventSubscriptions: [] as string[], enabled: true })
  const [issuedToken, setIssuedToken] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState("")

  const refresh = async (signal?: AbortSignal) => {
    const response = await apiFetch(`${API_BASE}/api/mcp`, { signal })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || "MCP-Status konnte nicht geladen werden.")
    setSnapshot({ ...EMPTY, ...payload, proposals: payload.proposals || [] })
  }

  useSerializedPolling(async signal => {
    try {
      await refresh(signal)
    } catch (error) {
      if (!signal.aborted) setMessage(error instanceof Error ? error.message : "MCP-Status konnte nicht geladen werden.")
    }
  }, 3_000)

  const selected = useMemo(
    () => snapshot.agents.find(agent => agent.id === selectedId) || null,
    [selectedId, snapshot.agents],
  )

  useEffect(() => {
    if (!selected) return
    setForm({
      name: selected.name,
      permissions: [...selected.permissions],
      eventSubscriptions: [...selected.eventSubscriptions],
      enabled: selected.enabled,
    })
  }, [selected])

  const startNew = () => {
    setSelectedId("")
    setIssuedToken("")
    setMessage("")
    setForm({
      name: "",
      permissions: ["system.read", "contracts.read", "positions.read", "signals.read", "risk.read", "strategies.read", "routes.read", "analytics.read", "journal.read"],
      eventSubscriptions: ["signal_received", "exchange_ack", "first_fill", "position_closed", "kill_switch_activated"],
      enabled: true,
    })
  }

  const execute = async (action: string, operation: () => Promise<any>, success: string) => {
    setBusy(action)
    setMessage("")
    try {
      const result = await operation()
      setMessage(success)
      await refresh()
      return result
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MCP-Aktion fehlgeschlagen.")
      return null
    } finally {
      setBusy("")
    }
  }

  const request = async (
    path: string,
    body: unknown,
    headers?: Record<string, string>,
    method = "POST",
  ) => {
    const response = await apiFetch(`${API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error || `MCP-Anfrage fehlgeschlagen (${response.status}).`)
    return payload
  }

  const save = async () => {
    if (!form.name.trim()) return
    if (!selected) {
      const result = await execute("create", () => request("/api/mcp/agents", form), "Agent erstellt. Token jetzt sicher hinterlegen.")
      if (result?.token) {
        setIssuedToken(result.token)
        setSelectedId(result.agent.id)
      }
      return
    }
    await execute(
      "update",
      () => request("/api/mcp/agents/update", { id: selected.id, ...form }),
      form.enabled ? "Agent und dauerhafte Berechtigungen gespeichert." : "Agent deaktiviert und Sitzungen widerrufen.",
    )
  }

  const rotate = async () => {
    if (!selected || !window.confirm(`Token für „${selected.name}“ rotieren? Der bisherige Token und aktive Sitzungen werden sofort ungültig.`)) return
    const result = await execute(
      "rotate",
      () => request("/api/mcp/agents/rotate", { id: selected.id }, { "X-Destructive-Confirmation": "rotate-mcp-agent-token" }),
      "Token rotiert. Ersatz-Token jetzt sicher hinterlegen.",
    )
    if (result?.token) setIssuedToken(result.token)
  }

  const remove = async () => {
    if (!selected || !window.confirm(`MCP-Agent „${selected.name}“ endgültig löschen? Token, Rechte und aktive Sitzungen werden sofort widerrufen; die anonymisierte Audit-Historie bleibt erhalten.`)) return
    const result = await execute(
      "delete",
      () => request(
        "/api/mcp/agents",
        { id: selected.id },
        { "X-Destructive-Confirmation": "delete-mcp-agent" },
        "DELETE",
      ),
      "Agent gelöscht. Token, Rechte und aktive Sitzungen wurden widerrufen.",
    )
    if (result?.deleted) {
      setSelectedId("")
      setIssuedToken("")
      setForm({ name: "", permissions: [], eventSubscriptions: [], enabled: true })
    }
  }

  const copyToken = async () => {
    if (!issuedToken) return
    await navigator.clipboard.writeText(issuedToken)
    setMessage("Token in die Zwischenablage kopiert.")
  }

  const approveProposal = async (proposal: Proposal) => {
    if (!window.confirm(`MCP-Antrag „${proposal.action}“ von ${proposal.agentName} nach erneuter Preflight-Prüfung freigeben?`)) return
    await execute(
      `approve-${proposal.id}`,
      () => request(
        "/api/mcp/proposals/approve",
        { id: proposal.id },
        { "X-Destructive-Confirmation": "approve-mcp-proposal" },
      ),
      "MCP-Antrag freigegeben und zur kontrollierten Ausführung eingeplant.",
    )
  }

  const rejectProposal = async (proposal: Proposal) => {
    const reason = window.prompt("Ablehnungsgrund", "Vom Operator abgelehnt.")
    if (reason === null) return
    await execute(
      `reject-${proposal.id}`,
      () => request("/api/mcp/proposals/reject", { id: proposal.id, reason }),
      "MCP-Antrag abgelehnt.",
    )
  }

  const activeSessions = snapshot.sessions.filter(session =>
    session.disconnectedAt === null && Date.now() - session.lastSeenAt < 15_000)

  return <div className="space-y-6">
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" />MCP-Agenten</CardTitle><CardDescription>Dauerhafte Berechtigungen pro Agent, jederzeit änderbar oder vollständig widerrufbar. Geheimnisse werden nie gespeichert oder erneut angezeigt.</CardDescription></div>
          <Button variant="outline" onClick={startNew}><Plus className="mr-2 h-4 w-4" />Neuer Agent</Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border p-3 text-sm">
          <span className="text-muted-foreground">MCP-Endpunkt</span>
          <div className="mt-1 break-all font-mono">{snapshot.endpoint || "Nicht veröffentlicht – MCP_ENDPOINT_URL konfigurieren."}</div>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {snapshot.agents.map(agent => {
            const connected = activeSessions.some(session => session.agentId === agent.id)
            const connectionLabel = agentConnectionLabel(connected, agent.enabled)
            return <button
              type="button"
              key={agent.id}
              onClick={() => { setSelectedId(agent.id); setIssuedToken(""); setMessage("") }}
              className={`rounded-md border p-4 text-left transition-colors ${selectedId === agent.id ? "bg-foreground text-background" : "hover:bg-muted"}`}
            >
              <div className="flex items-center justify-between gap-2"><strong>{agent.name}</strong><span className="flex items-center gap-2 text-xs"><span className={`h-2 w-2 rounded-full ${connected ? "bg-current" : "border border-current"}`} />{connectionLabel}</span></div>
              <div className="mt-2 font-mono text-xs opacity-70">{agent.tokenPrefix}…</div>
              <div className="mt-1 text-xs opacity-70">{agent.permissions.length} Rechte · zuletzt {formattedDate(agent.lastSeenAt)}</div>
            </button>
          })}
          {snapshot.agents.length === 0 && <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">Noch kein Agent eingerichtet.</div>}
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>{selected ? `Agent bearbeiten · ${selected.name}` : "Agent anlegen"}</CardTitle><CardDescription>Schreib- und Notfallrechte nur gezielt vergeben. Änderungen gelten für alle neuen und aktiven Aufrufe.</CardDescription></CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <div className="space-y-2"><Label htmlFor="mcp-agent-name">Name</Label><Input id="mcp-agent-name" maxLength={80} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} placeholder="z. B. Codex Operator" /></div>
          <label className="flex h-10 items-center gap-3 rounded-md border px-3"><Switch checked={form.enabled} onCheckedChange={enabled => setForm({ ...form, enabled })} /><span className="text-sm font-medium">Agent aktiv</span></label>
        </div>
        <div className="space-y-2"><Label>Berechtigungen</Label><ToggleGrid values={snapshot.permissions} selected={form.permissions} labels={PERMISSION_LABELS} onChange={permissions => setForm({ ...form, permissions })} /></div>
        <div className="space-y-2"><Label>Aktive Ereignis-Benachrichtigungen</Label><ToggleGrid values={snapshot.eventTypes} selected={form.eventSubscriptions} labels={EVENT_LABELS} onChange={eventSubscriptions => setForm({ ...form, eventSubscriptions })} /></div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={Boolean(busy) || !form.name.trim()} onClick={() => void save()}><Save className="mr-2 h-4 w-4" />{selected ? "Änderungen speichern" : "Agent erstellen"}</Button>
          {selected && <Button variant="outline" disabled={Boolean(busy)} onClick={() => void rotate()}><KeyRound className="mr-2 h-4 w-4" />Token rotieren</Button>}
          {selected && <Button variant="destructive" disabled={Boolean(busy)} onClick={() => void remove()}><Trash2 className="mr-2 h-4 w-4" />Agent löschen</Button>}
          <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw className="mr-2 h-4 w-4" />Aktualisieren</Button>
        </div>
        {issuedToken && <div className="space-y-2 rounded-md border p-4">
          <div><strong>Einmal sichtbarer Agenten-Token</strong><p className="text-sm text-muted-foreground">Jetzt in den Secret Store des Agenten kopieren. TSX Core speichert ausschließlich den Hash.</p></div>
          <div className="flex gap-2"><Textarea readOnly value={issuedToken} className="min-h-20 font-mono text-xs" /><Button variant="outline" onClick={() => void copyToken()} aria-label="Token kopieren"><Copy className="h-4 w-4" /></Button></div>
        </div>}
        {message && <output className="block rounded-md border px-3 py-2 text-sm">{message}</output>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Freigabewarteschlange</CardTitle><CardDescription>Veröffentlichungen, Löschungen, Routing-, Risiko- und Kill-Switch-Freigaben werden erst nach erneuter Prüfung und menschlicher Bestätigung ausgeführt.</CardDescription></CardHeader>
      <CardContent><Table><TableHeader><TableRow><TableHead>Zeit</TableHead><TableHead>Agent / Aktion</TableHead><TableHead>Auswirkung</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader><TableBody>
        {snapshot.proposals.slice(0, 100).map(proposal => <TableRow key={proposal.id}>
          <TableCell>{formattedDate(proposal.requestedAt)}<div className="text-xs text-muted-foreground">bis {formattedDate(proposal.expiresAt)}</div></TableCell>
          <TableCell>{proposal.agentName}<div className="font-mono text-xs text-muted-foreground">{proposal.action}</div></TableCell>
          <TableCell className="max-w-xl"><ul className="space-y-1 text-xs">{proposal.preflight.impact.map(item => <li key={item}>{item}</li>)}</ul>{proposal.error && <div className="mt-1 text-xs text-destructive">{proposal.error}</div>}</TableCell>
          <TableCell><Badge variant={proposal.status === "pending" ? "secondary" : proposal.status === "failed" || proposal.status === "rejected" ? "destructive" : "outline"}>{proposal.status}</Badge></TableCell>
          <TableCell>{proposal.status === "pending" && <div className="flex gap-1"><Button size="sm" disabled={Boolean(busy)} onClick={() => void approveProposal(proposal)}><CheckCircle2 className="mr-1 h-4 w-4" />Freigeben</Button><Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void rejectProposal(proposal)}><XCircle className="mr-1 h-4 w-4" />Ablehnen</Button></div>}</TableCell>
        </TableRow>)}
        {snapshot.proposals.length === 0 && <TableRow><TableCell colSpan={5} className="text-muted-foreground">Keine MCP-Anträge vorhanden.</TableCell></TableRow>}
      </TableBody></Table></CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Verbundene Agenten</CardTitle><CardDescription>Aktive MCP-Sitzungen und zuletzt beobachtete Clients.</CardDescription></CardHeader>
      <CardContent><Table><TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Client</TableHead><TableHead>Verbunden seit</TableHead><TableHead>Zuletzt aktiv</TableHead><TableHead>Status</TableHead></TableRow></TableHeader><TableBody>
        {snapshot.sessions.slice(0, 100).map(session => {
          const agent = snapshot.agents.find(item => item.id === session.agentId)
          const connected = activeSessions.some(item => item.id === session.id)
          const connectionLabel = sessionConnectionLabel(connected, session.disconnectedAt)
          return <TableRow key={session.id}><TableCell>{agent?.name || session.agentId}</TableCell><TableCell>{session.clientName} <span className="text-muted-foreground">{session.clientVersion}</span></TableCell><TableCell>{formattedDate(session.connectedAt)}</TableCell><TableCell>{formattedDate(session.lastSeenAt)}</TableCell><TableCell><Badge variant="outline">{connectionLabel}</Badge></TableCell></TableRow>
        })}
        {snapshot.sessions.length === 0 && <TableRow><TableCell colSpan={5} className="text-muted-foreground">Keine Sitzungen vorhanden.</TableCell></TableRow>}
      </TableBody></Table></CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Agenten-Aktionen</CardTitle><CardDescription>Nachvollziehbare Tool-Aufrufe; schreibende Aktionen erscheinen zusätzlich in der unveränderlichen Audit-Kette.</CardDescription></CardHeader>
      <CardContent><Table><TableHeader><TableRow><TableHead>Zeit</TableHead><TableHead>Agent</TableHead><TableHead>Tool / Recht</TableHead><TableHead>Ergebnis</TableHead><TableHead>Dauer</TableHead></TableRow></TableHeader><TableBody>
        {snapshot.actions.slice(0, 100).map(action => <TableRow key={action.id}><TableCell>{formattedDate(action.completedAt)}</TableCell><TableCell>{action.agentName}</TableCell><TableCell><span className="font-mono text-xs">{action.toolName}</span><div className="text-xs text-muted-foreground">{action.permission}</div></TableCell><TableCell><Badge variant="outline">{action.outcome}</Badge>{action.error && <div className="mt-1 max-w-xl text-xs text-muted-foreground">{action.error}</div>}</TableCell><TableCell>{action.durationMs} ms</TableCell></TableRow>)}
        {snapshot.actions.length === 0 && <TableRow><TableCell colSpan={5} className="text-muted-foreground">Noch keine Agenten-Aktionen.</TableCell></TableRow>}
      </TableBody></Table></CardContent>
    </Card>
  </div>
}
