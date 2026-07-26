import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, Copy, Pause, Play, RefreshCw, Search, Terminal, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { apiFetch } from "@/lib/api"
import { useSerializedPolling } from "@/hooks/use-serialized-polling"

const API_BASE = window.location.origin
const MAX_CLIENT_LINES = 20_000
const ROW_HEIGHT = 24
const VIEWPORT_HEIGHT = 600
const OVERSCAN = 20

interface LogEntry {
  cursor: number
  line: string
}

interface ParsedLine {
  timestamp: string
  level: string
  message: string
}

export function parseConsoleLine(line: string): ParsedLine {
  let remaining = line.trimStart()
  let timestamp = ""
  if (/^\[\d{1,2}:\d{2}:\d{2}(?:\s[AP]M)?\]/i.test(remaining)) {
    const end = remaining.indexOf("]") + 1
    timestamp = remaining.slice(0, end)
    remaining = remaining.slice(end).trimStart()
  }
  let level = ""
  if (remaining.startsWith("[")) {
    const end = remaining.indexOf("]")
    const candidate = end < 0 ? "" : remaining.slice(0, end + 1)
    if (/^\[[A-Z -]+\]$/i.test(candidate)) {
      level = candidate
      remaining = remaining.slice(candidate.length).trimStart()
    }
  }
  return { timestamp, level, message: remaining }
}

function aliasLine(line: string, aliases: Record<string, unknown> | undefined): string {
  let result = line
  for (const [channelId, alias] of Object.entries(aliases || {})) {
    result = result.replaceAll(channelId, `${String(alias)} (${channelId})`)
  }
  return result
}

export function LogsTab({ config }: Readonly<{ config?: any }>) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [query, setQuery] = useState("")
  const [regexMode, setRegexMode] = useState(false)
  const [copied, setCopied] = useState(false)
  const [scrollTop, setScrollTop] = useState(0)
  const [dropped, setDropped] = useState(false)
  const cursorRef = useRef(0)
  const viewportRef = useRef<HTMLDivElement>(null)

  const fetchLogs = useCallback(async (signal?: AbortSignal) => {
    if (paused) return
    try {
      const response = await apiFetch(`${API_BASE}/api/logs?after=${cursorRef.current}&limit=2000`, { signal })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || `Log-Stream fehlgeschlagen (${response.status}).`)
      const incoming: LogEntry[] = Array.isArray(payload.entries)
        ? payload.entries
        : (payload.logs || []).map((line: string, index: number) => ({ cursor: cursorRef.current + index + 1, line }))
      if (incoming.length > 0) {
        setLogs(previous => [...previous, ...incoming].slice(-MAX_CLIENT_LINES))
      }
      cursorRef.current = Number(payload.nextCursor || incoming.at(-1)?.cursor || cursorRef.current)
      if (payload.dropped) setDropped(true)
    } catch (cause) {
      if (!signal?.aborted) console.error("Log-Stream konnte nicht aktualisiert werden.", cause)
    }
  }, [paused])

  useSerializedPolling(signal => fetchLogs(signal), 750, !paused)

  const matcher = useMemo(() => {
    if (!query) return { test: () => true, error: "" }
    if (!regexMode) {
      const normalized = query.toLocaleLowerCase("de-DE")
      return { test: (line: string) => line.toLocaleLowerCase("de-DE").includes(normalized), error: "" }
    }
    try {
      const expression = new RegExp(query, "iu")
      return { test: (line: string) => expression.test(line), error: "" }
    } catch (cause) {
      return { test: () => false, error: cause instanceof Error ? cause.message : "Ungültiger regulärer Ausdruck." }
    }
  }, [query, regexMode])

  const visibleLogs = useMemo(
    () => logs
      .map(entry => ({ ...entry, line: aliasLine(entry.line, config?.sourceAliases) }))
      .filter(entry => matcher.test(entry.line)),
    [config?.sourceAliases, logs, matcher],
  )
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2
  const end = Math.min(visibleLogs.length, start + visibleCount)
  const windowed = visibleLogs.slice(start, end)

  useEffect(() => {
    if (paused || query || !viewportRef.current) return
    viewportRef.current.scrollTop = viewportRef.current.scrollHeight
  }, [logs, paused, query])

  const copy = async () => {
    await navigator.clipboard.writeText(visibleLogs.map(entry => entry.line).join("\n"))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2_000)
  }

  const clearLocal = () => {
    setLogs([])
    setDropped(false)
    setScrollTop(0)
  }

  return <Card className="w-full overflow-hidden">
    <CardHeader className="gap-4 border-b">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div><CardTitle className="flex items-center gap-2"><Terminal className="h-5 w-5" />System-Konsole</CardTitle><CardDescription>Kontinuierlicher, cursorbasierter Live-Stream. Keine Level werden ausgeblendet oder aus ihrem Ablauf gerissen.</CardDescription></div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={visibleLogs.length === 0} onClick={() => void copy()}>{copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}{copied ? "Kopiert" : "Sichtbares kopieren"}</Button>
          <Button variant="outline" size="sm" onClick={clearLocal}><Trash2 className="mr-2 h-4 w-4" />Lokal leeren</Button>
          <Button variant="outline" size="sm" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play className="mr-2 h-4 w-4" /> : <Pause className="mr-2 h-4 w-4" />}{paused ? "Fortsetzen" : "Pausieren"}</Button>
          <Button variant="outline" size="icon" disabled={paused} aria-label="Logs aktualisieren" onClick={() => void fetchLogs()}><RefreshCw className="h-4 w-4" /></Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Logs durchsuchen" className="pl-9 font-mono" value={query} onChange={event => setQuery(event.target.value)} placeholder={regexMode ? "Regulärer Ausdruck …" : "Text, Symbol, Modul oder Fehlermeldung …"} /></div>
        <Button variant={regexMode ? "default" : "outline"} aria-pressed={regexMode} onClick={() => setRegexMode(value => !value)}>Regex</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{visibleLogs.length.toLocaleString("de-DE")} sichtbar · {logs.length.toLocaleString("de-DE")} im lokalen Puffer · Cursor {cursorRef.current}</span>{paused && <BadgeLike>Stream pausiert</BadgeLike>}{matcher.error && <span role="alert">Regex: {matcher.error}</span>}{dropped && <span role="alert">Der Serverpuffer wurde zwischenzeitlich überschrieben; der Stream setzt an der ältesten verfügbaren Zeile fort.</span>}</div>
    </CardHeader>
    <CardContent className="p-0">
      <div
        ref={viewportRef}
        role="log"
        aria-label="System-Logs"
        aria-live="off"
        onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        className="relative h-[600px] overflow-auto bg-black font-mono text-xs text-zinc-200"
      >
        {visibleLogs.length === 0 ? <div className="flex h-full items-center justify-center text-zinc-500">{logs.length === 0 ? "Warte auf Log-Einträge …" : "Keine Treffer im vollständigen Stream."}</div> : <div style={{ height: visibleLogs.length * ROW_HEIGHT, position: "relative" }}>{windowed.map((entry, offset) => {
          const parsed = parseConsoleLine(entry.line)
          const row = start + offset
          return <div key={entry.cursor} className="absolute left-0 right-0 grid grid-cols-[4rem_auto_auto_minmax(0,1fr)] items-baseline gap-2 border-b border-white/5 px-3 hover:bg-white/5" style={{ height: ROW_HEIGHT, transform: `translateY(${row * ROW_HEIGHT}px)` }}>
            <span className="select-none text-right text-zinc-600">{entry.cursor}</span>
            <span className="whitespace-nowrap text-zinc-500">{parsed.timestamp}</span>
            <span className="whitespace-nowrap font-semibold text-zinc-300">{parsed.level}</span>
            <span className="truncate whitespace-pre" title={parsed.message}>{parsed.message}</span>
          </div>
        })}</div>}
      </div>
    </CardContent>
  </Card>
}

function BadgeLike({ children }: Readonly<{ children: string }>) {
  return <span className="rounded-md border px-2 py-0.5 text-foreground">{children}</span>
}
