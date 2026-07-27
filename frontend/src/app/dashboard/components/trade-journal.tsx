import { useEffect, useMemo, useState } from "react"
import { Download, RefreshCw, Save } from "lucide-react"
import { apiFetch } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

const API_BASE = window.location.origin

type JournalEntry = {
  intentId: string
  createdAt: number
  channelId: string
  accountId: string
  accountName: string
  exchange: string
  mode: string
  symbol: string
  side: string
  status: string
  strategy: { name: string; version: number }
  signal: { schemaProfileId: string | null; contractVersionId: string | null }
  position: { realizedPnl?: string; openedAt?: number | null; closedAt?: number | null } | null
  fills: unknown[]
  fees: Record<string, string>
  review: {
    notes: string
    tags: string[]
    rating: number | null
    reviewed: boolean
    updatedAt: number | null
  }
}

type Filters = {
  accountId: string
  channelId: string
  symbol: string
  status: string
  reviewed: string
}

type JournalDashboardData = {
  accounts: Array<{ id: string; name: string }>
  configuredChannels?: Array<{ id: string | number }>
}

function date(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString("de-DE") : "–"
}

function queryString(filters: Filters): string {
  const query = new URLSearchParams({ limit: "200" })
  for (const [key, value] of Object.entries(filters)) {
    if (value && value !== "all") query.set(key, value)
  }
  return query.toString()
}

function downloadName(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") || ""
  return /filename="([^"]+)"/.exec(disposition)?.[1] || fallback
}

async function journalRequest(filters: Filters): Promise<JournalEntry[]> {
  const response = await apiFetch(`${API_BASE}/api/trading/journal?${queryString(filters)}`)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || "Trade Journal konnte nicht geladen werden.")
  return payload.entries || []
}

export function TradeJournal({ data }: Readonly<{ data: JournalDashboardData }>) {
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [filters, setFilters] = useState<Filters>({
    accountId: "all",
    channelId: "all",
    symbol: "",
    status: "all",
    reviewed: "all",
  })
  const [review, setReview] = useState({ notes: "", tags: "", rating: "none", reviewed: false })
  const [busy, setBusy] = useState("")
  const [message, setMessage] = useState("")
  const selected = useMemo(
    () => entries.find(entry => entry.intentId === selectedId) || null,
    [entries, selectedId],
  )

  const load = async () => {
    setBusy("load")
    setMessage("")
    try {
      const next = await journalRequest(filters)
      setEntries(next)
      if (selectedId && !next.some(entry => entry.intentId === selectedId)) setSelectedId("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Trade Journal konnte nicht geladen werden.")
    } finally {
      setBusy("")
    }
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void journalRequest(filters).then(setEntries).catch(error => {
        setMessage(error instanceof Error ? error.message : "Trade Journal konnte nicht geladen werden.")
      })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [filters])

  useEffect(() => {
    if (!selected) return
    setReview({
      notes: selected.review.notes,
      tags: selected.review.tags.join(", "),
      rating: selected.review.rating === null ? "none" : String(selected.review.rating),
      reviewed: selected.review.reviewed,
    })
  }, [selected])

  const save = async () => {
    if (!selected) return
    setBusy("save")
    setMessage("")
    try {
      const response = await apiFetch(`${API_BASE}/api/trading/journal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intentId: selected.intentId,
          notes: review.notes,
          tags: review.tags.split(",").map(tag => tag.trim()).filter(Boolean),
          rating: review.rating === "none" ? null : Number(review.rating),
          reviewed: review.reviewed,
        }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Journal-Review konnte nicht gespeichert werden.")
      setMessage("Journal-Review gespeichert.")
      setEntries(await journalRequest(filters))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Journal-Review konnte nicht gespeichert werden.")
    } finally {
      setBusy("")
    }
  }

  const download = async (format: "json" | "csv") => {
    setBusy(`export-${format}`)
    setMessage("")
    try {
      const query = new URLSearchParams(queryString(filters))
      query.set("format", format)
      const response = await apiFetch(`${API_BASE}/api/trading/journal/export?${query}`)
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error || "Journal-Export fehlgeschlagen.")
      }
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = downloadName(response, `tsx-core-trade-journal.${format}`)
      anchor.click()
      URL.revokeObjectURL(url)
      setMessage(`${format.toUpperCase()}-Export erstellt. Telegram-PII wurde redigiert.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Journal-Export fehlgeschlagen.")
    } finally {
      setBusy("")
    }
  }

  const channels = [...new Set([
    ...(data.configuredChannels || []).map(channel => String(channel.id)),
    ...entries.map(entry => entry.channelId),
  ])].sort()

  return <div className="space-y-5">
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle>Trade Journal</CardTitle><CardDescription>Trade-Historie mit Strategie-, Vertrags-, Ausführungs- und Review-Provenienz.</CardDescription></div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => void download("csv")}><Download className="mr-2 h-4 w-4" />CSV</Button>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => void download("json")}><Download className="mr-2 h-4 w-4" />JSON</Button>
            <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void load()}><RefreshCw className="mr-2 h-4 w-4" />Aktualisieren</Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <FilterSelect label="Konto" value={filters.accountId} onChange={accountId => setFilters({ ...filters, accountId })} options={[
            { value: "all", label: "Alle Konten" },
            ...data.accounts.map(account => ({ value: account.id, label: account.name })),
          ]} />
          <FilterSelect label="Kanal" value={filters.channelId} onChange={channelId => setFilters({ ...filters, channelId })} options={[
            { value: "all", label: "Alle Kanäle" },
            ...channels.map(channel => ({ value: channel, label: channel })),
          ]} />
          <div className="space-y-2"><Label htmlFor="journal-symbol">USD-Paar</Label><Input id="journal-symbol" value={filters.symbol} placeholder="BTCUSDT" onChange={event => setFilters({ ...filters, symbol: event.target.value.toUpperCase() })} onKeyDown={event => { if (event.key === "Enter") void load() }} /></div>
          <FilterSelect label="Status" value={filters.status} onChange={status => setFilters({ ...filters, status })} options={["all", "pending", "planned", "submitting", "monitoring", "completed", "blocked", "failed", "unknown"].map(value => ({ value, label: value === "all" ? "Alle Status" : value }))} />
          <FilterSelect label="Review" value={filters.reviewed} onChange={reviewed => setFilters({ ...filters, reviewed })} options={[
            { value: "all", label: "Alle Reviews" },
            { value: "true", label: "Geprüft" },
            { value: "false", label: "Offen" },
          ]} />
        </div>
        {message && <output className="block rounded-md border px-3 py-2 text-sm">{message}</output>}
      </CardContent>
    </Card>

    <Card>
      <CardHeader><CardTitle>Trades</CardTitle><CardDescription>{entries.length} Einträge im aktuellen Filter.</CardDescription></CardHeader>
      <CardContent className="overflow-x-auto">
        <Table><TableHeader><TableRow><TableHead>Zeit</TableHead><TableHead>Paar</TableHead><TableHead>Quelle</TableHead><TableHead>Strategie / Vertrag</TableHead><TableHead>PnL / Gebühren</TableHead><TableHead>Status</TableHead><TableHead>Review</TableHead></TableRow></TableHeader>
          <TableBody>
            {entries.map(entry => <TableRow key={entry.intentId} className="cursor-pointer" onClick={() => setSelectedId(entry.intentId)} data-state={selectedId === entry.intentId ? "selected" : undefined}>
              <TableCell>{date(entry.createdAt)}</TableCell>
              <TableCell><strong>{entry.symbol}</strong><div className="text-xs text-muted-foreground">{entry.side} · {entry.exchange}/{entry.mode}</div></TableCell>
              <TableCell>{entry.channelId}<div className="text-xs text-muted-foreground">{entry.accountName}</div></TableCell>
              <TableCell>{entry.strategy.name} v{entry.strategy.version}<div className="font-mono text-xs text-muted-foreground">{entry.signal.schemaProfileId || "–"} · {entry.signal.contractVersionId || "–"}</div></TableCell>
              <TableCell>{entry.position?.realizedPnl || "0"}<div className="text-xs text-muted-foreground">{Object.entries(entry.fees).map(([asset, value]) => `${value} ${asset}`).join(", ") || "keine Gebühren"}</div></TableCell>
              <TableCell><Badge variant="outline">{entry.status}</Badge></TableCell>
              <TableCell><Badge variant={entry.review.reviewed ? "default" : "secondary"}>{entry.review.reviewed ? "geprüft" : "offen"}</Badge></TableCell>
            </TableRow>)}
            {entries.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">Keine Trades für diesen Filter.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </CardContent>
    </Card>

    {selected && <Card>
      <CardHeader><CardTitle>Review · {selected.symbol}</CardTitle><CardDescription>{selected.intentId} · {selected.fills.length} Fill(s) · {date(selected.position?.openedAt)} bis {date(selected.position?.closedAt)}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2"><Label htmlFor="journal-notes">Notizen und Learnings</Label><Textarea id="journal-notes" maxLength={10000} className="min-h-36" value={review.notes} onChange={event => setReview({ ...review, notes: event.target.value })} /></div>
        <div className="grid gap-4 md:grid-cols-[1fr_12rem_auto] md:items-end">
          <div className="space-y-2"><Label htmlFor="journal-tags">Tags, kommagetrennt</Label><Input id="journal-tags" value={review.tags} onChange={event => setReview({ ...review, tags: event.target.value })} placeholder="breakout, news, sauber" /></div>
          <FilterSelect label="Bewertung" value={review.rating} onChange={rating => setReview({ ...review, rating })} options={[
            { value: "none", label: "Ohne Bewertung" },
            ...[1, 2, 3, 4, 5].map(value => ({ value: String(value), label: `${value} / 5` })),
          ]} />
          <label className="flex h-10 items-center gap-3 rounded-md border px-3"><Switch checked={review.reviewed} onCheckedChange={reviewed => setReview({ ...review, reviewed })} /><span className="text-sm">Review abgeschlossen</span></label>
        </div>
        <Button disabled={Boolean(busy)} onClick={() => void save()}><Save className="mr-2 h-4 w-4" />Review speichern</Button>
      </CardContent>
    </Card>}
  </div>
}

function FilterSelect({ label, value, onChange, options }: Readonly<{
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}>) {
  return <div className="space-y-2"><Label>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>
}
