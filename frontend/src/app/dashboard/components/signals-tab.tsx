"use client"

import * as React from "react"
import { useState, useEffect } from "react"
import { RefreshCw, FileCode, AlertCircle, Inbox, ChevronDown, ChevronRight, Copy, Check, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const API_BASE = window.location.origin

interface ProcessedSignal {
  id: string;
  chat_id: string;
  message_id: number;
  xml_content: string;
  normalized_content: string;
  created_at: number;
}

export function SignalsTab({ config }: { config?: any }) {
  const [signals, setSignals] = useState<ProcessedSignal[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const fetchSignals = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(`${API_BASE}/api/processed-signals`)
      if (!response.ok) throw new Error("Konnte Signale nicht laden.")
      const data = await response.json()
      setSignals(data.signals || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchSignals()
    const interval = setInterval(fetchSignals, 5000)
    return () => clearInterval(interval)
  }, [])

  const toggleExpand = (id: string) => {
    const next = new Set(expandedIds)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setExpandedIds(next)
  }

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (err) {
      console.error("Failed to copy text:", err)
    }
  }

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div>
          <CardTitle>Signale-Datenbank</CardTitle>
          <CardDescription>
            Archiv aller erfolgreich extrahierten XML-Signale aus der SQLite-Datenbank (Aktualisiert alle 5s)
          </CardDescription>
        </div>
        <Button onClick={fetchSignals} variant="outline" size="icon" disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent>
        {error && (
          <div className="flex items-center gap-2 p-4 text-red-500 bg-red-500/10 rounded-lg mb-4 text-sm">
            <AlertCircle className="h-4 w-4" />
            <span>Fehler: {error}</span>
          </div>
        )}

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[50px]"></TableHead>
                <TableHead className="w-[100px]">Zeit</TableHead>
                <TableHead className="w-[240px]">Quelle (Alias / ID)</TableHead>
                <TableHead className="w-[120px]">Nachricht ID</TableHead>
                <TableHead>Signal-ID (Key)</TableHead>
                <TableHead className="w-[50px] text-right">Aktion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {signals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Inbox className="h-8 w-8 text-muted-foreground/50" />
                      {isLoading ? "Lade Signale..." : "Noch keine Signale erfasst."}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                signals.map((sig) => {
                  const isExpanded = expandedIds.has(sig.id)
                  const date = new Date(sig.created_at)
                  const timeStr = date.toLocaleTimeString("de-DE", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  }) + " " + date.toLocaleDateString("de-DE", {
                    day: "2-digit",
                    month: "2-digit"
                  })

                  const alias = config?.sourceAliases?.[sig.chat_id]
                  const sourceDisplayText = alias ? `${alias} (${sig.chat_id})` : sig.chat_id

                  return (
                    <React.Fragment key={sig.id}>
                      <TableRow 
                        onClick={() => toggleExpand(sig.id)} 
                        className="cursor-pointer hover:bg-muted/30 transition-colors"
                      >
                        <TableCell className="text-center p-2">
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 mx-auto text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 mx-auto text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{timeStr}</TableCell>
                        <TableCell className="text-xs truncate max-w-[240px]" title={sig.chat_id}>
                          {sourceDisplayText}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{sig.message_id}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {sig.id}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 active:scale-90 transition-all"
                            onClick={async (e) => {
                              e.stopPropagation()
                              if (window.confirm("Dieses Signal wirklich aus der Datenbank löschen?")) {
                                try {
                                  const res = await fetch(`${API_BASE}/api/processed-signals?id=${sig.id}`, { method: 'DELETE' })
                                  if (res.ok) {
                                    fetchSignals()
                                  } else {
                                    alert("Fehler beim Löschen.")
                                  }
                                } catch (err) {
                                  console.error(err)
                                }
                              }
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </TableCell>
                      </TableRow>
                      {isExpanded && (
                        <TableRow className="bg-muted/10 hover:bg-muted/10">
                          <TableCell colSpan={6} className="p-4">
                            <div className="flex flex-col gap-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                                  <FileCode className="h-4 w-4" /> Extrahierter XML Inhalt
                                </span>
                                <Button 
                                  variant="outline" 
                                  size="sm" 
                                  className="h-8 gap-1.5"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleCopy(sig.id, sig.xml_content)
                                  }}
                                >
                                  {copiedId === sig.id ? (
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
                              </div>
                              <pre className="p-4 bg-muted/50 dark:bg-muted/30 border rounded-lg font-mono text-xs overflow-x-auto whitespace-pre select-all text-emerald-600 dark:text-emerald-400">
                                {sig.xml_content}
                              </pre>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
