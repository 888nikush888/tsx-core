"use client"

import { useEffect, useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Terminal, RefreshCw, Pause, Play, Trash2, Copy, Check } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { apiFetch } from "@/lib/api"

const API_BASE = window.location.origin

export function LogsTab({ config }: any) {
  const [logs, setLogs] = useState<string[]>([])
  const [isPaused, setIsPaused] = useState(false)
  const [filter, setFilter] = useState<'all' | 'info' | 'success' | 'warn' | 'error'>('all')
  const [copied, setCopied] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const fetchLogs = async () => {
    if (isPaused) return;
    try {
      const res = await apiFetch(`${API_BASE}/api/logs`)
      const data = await res.json()
      setLogs(data.logs || [])
    } catch (e) {
      console.error("Failed to fetch logs", e)
    }
  }

  useEffect(() => {
    fetchLogs()
    const interval = setInterval(fetchLogs, 3000)
    return () => clearInterval(interval)
  }, [isPaused])

  useEffect(() => {
    if (bottomRef.current && !isPaused) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" })
    }
  }, [logs, isPaused, filter])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(logs.join("\n"))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error("Failed to copy logs:", err)
    }
  }

  const handleClearLocal = () => {
    setLogs([])
  }

  const parseLogLine = (line: string) => {
    // Formats source channel IDs with aliases first
    let displayLine = line
    if (config && config.sourceAliases) {
      Object.entries(config.sourceAliases).forEach(([chId, alias]: any) => {
        displayLine = displayLine.replaceAll(chId, `${alias} (${chId})`)
      })
    }

    // Match optional timestamp e.g. [13:22:25] and optional level e.g. [INFO]
    const regex = /^(\[\d{2}:\d{2}:\d{2}\])?\s*(\[[A-Z\s\-]+\])?(.*)$/i
    const match = displayLine.match(regex)
    
    if (match) {
      const timestamp = match[1] || ""
      const rawLevel = match[2] || ""
      const message = match[3] || ""
      
      const level = rawLevel.toUpperCase()
      let levelColor = "text-zinc-400"
      
      if (level.includes("SUCCESS")) {
        levelColor = "text-emerald-500 dark:text-emerald-400 font-semibold"
      } else if (level.includes("INFO")) {
        levelColor = "text-sky-500 dark:text-sky-400"
      } else if (level.includes("WARN")) {
        levelColor = "text-amber-500 dark:text-amber-400 font-medium"
      } else if (level.includes("ERROR") || level.includes("FATAL")) {
        levelColor = "text-rose-500 dark:text-rose-400 font-semibold"
      } else if (level.includes("TDLIB") || level.includes("STATUS")) {
        levelColor = "text-violet-500 dark:text-violet-400"
      }
      
      return {
        timestamp,
        levelText: rawLevel,
        levelColor,
        message,
        isParsed: true
      }
    }
    
    return {
      timestamp: "",
      levelText: "",
      levelColor: "",
      message: displayLine,
      isParsed: false
    }
  }

  const filteredLogs = logs.filter(log => {
    if (filter === 'all') return true
    const upper = log.toUpperCase()
    if (filter === 'info') return upper.includes('[INFO]')
    if (filter === 'success') return upper.includes('[SUCCESS]')
    if (filter === 'warn') return upper.includes('[WARN]')
    if (filter === 'error') return upper.includes('[ERROR]') || upper.includes('[FATAL]')
    return true
  })

  return (
    <Card className="w-full shadow-lg border-zinc-200 dark:border-zinc-800">
      <CardHeader className="flex flex-col md:flex-row items-start md:items-center justify-between pb-4 space-y-4 md:space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-muted-foreground" />
            <span>System-Terminal</span>
          </CardTitle>
          <CardDescription>
            Live-Ausgabe des Hintergrund-Daemons und Routing-Meldungen (Aktualisiert alle 3s)
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          {/* Filter buttons */}
          <div className="flex bg-muted/60 p-0.5 rounded-lg border text-xs font-medium mr-2">
            <button 
              onClick={() => setFilter('all')} 
              className={`px-2.5 py-1 rounded-md transition-colors ${filter === 'all' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Alle
            </button>
            <button 
              onClick={() => setFilter('success')} 
              className={`px-2.5 py-1 rounded-md transition-colors ${filter === 'success' ? 'bg-background text-emerald-600 dark:text-emerald-400 shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Erfolge
            </button>
            <button 
              onClick={() => setFilter('info')} 
              className={`px-2.5 py-1 rounded-md transition-colors ${filter === 'info' ? 'bg-background text-sky-600 dark:text-sky-400 shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Info
            </button>
            <button 
              onClick={() => setFilter('warn')} 
              className={`px-2.5 py-1 rounded-md transition-colors ${filter === 'warn' ? 'bg-background text-amber-600 dark:text-amber-400 shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Warn
            </button>
            <button 
              onClick={() => setFilter('error')} 
              className={`px-2.5 py-1 rounded-md transition-colors ${filter === 'error' ? 'bg-background text-rose-600 dark:text-rose-400 shadow-xs' : 'text-muted-foreground hover:text-foreground'}`}
            >
              Fehler
            </button>
          </div>

          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleCopy} 
            className="gap-1.5 h-8 text-xs active:scale-95 transition-all"
            disabled={logs.length === 0}
          >
            {copied ? (
              <>
                <Check className="h-3.5 w-3.5 text-emerald-500" />
                <span>Kopiert</span>
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                <span>Kopieren</span>
              </>
            )}
          </Button>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleClearLocal} 
            className="gap-1.5 h-8 text-xs active:scale-95 transition-all"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>Leeren</span>
          </Button>
          <Button 
            variant="outline" 
            size="icon" 
            className={`h-8 w-8 active:scale-95 transition-all ${isPaused ? "border-amber-500/50 text-amber-500 hover:bg-amber-500/10" : ""}`}
            onClick={() => setIsPaused(!isPaused)}
            title={isPaused ? "Auto-Scroll fortsetzen" : "Auto-Scroll pausieren"}
          >
            {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
          <Button 
            variant="outline" 
            size="icon" 
            className="h-8 w-8 active:scale-95 transition-all"
            onClick={fetchLogs}
            disabled={isPaused}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardHeader>
      
      <CardContent className="p-0">
        <div className="bg-zinc-950 dark:bg-zinc-950/80 border-t border-zinc-200 dark:border-zinc-800 text-zinc-300 p-4 h-[550px] overflow-y-auto font-mono text-xs leading-relaxed select-text">
          {filteredLogs.length === 0 ? (
            <div className="flex h-full items-center justify-center text-zinc-500 italic select-none">
              {logs.length === 0 ? "Warte auf eingehende Logs..." : "Keine Einträge für den ausgewählten Filter."}
            </div>
          ) : (
            filteredLogs.map((log, idx) => {
              const { timestamp, levelText, levelColor, message, isParsed } = parseLogLine(log)
              
              return (
                <div key={idx} className="flex py-0.5 hover:bg-zinc-900/40 px-1.5 rounded-sm transition-colors group">
                  <span className="w-8 shrink-0 text-zinc-600 select-none text-[10px] pr-2 text-right border-r border-zinc-800 mr-3">
                    {idx + 1}
                  </span>
                  
                  {isParsed ? (
                    <div className="flex flex-wrap gap-x-1.5 items-baseline">
                      {timestamp && (
                        <span className="text-zinc-500 select-none font-mono">
                          {timestamp}
                        </span>
                      )}
                      {levelText && (
                        <span className={`${levelColor} select-none`}>
                          {levelText}
                        </span>
                      )}
                      <span className="text-zinc-200 whitespace-pre-wrap break-all">
                        {message}
                      </span>
                    </div>
                  ) : (
                    <span className="text-zinc-200 whitespace-pre-wrap break-all">
                      {message}
                    </span>
                  )}
                </div>
              )
            })
          )}
          <div ref={bottomRef} />
        </div>
      </CardContent>
    </Card>
  )
}
