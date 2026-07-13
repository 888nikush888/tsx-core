"use client"

import { useState, useEffect } from "react"
import { RefreshCw, AlertCircle, Inbox, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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

interface IncomingMessage {
  id: number;
  chat_id: string;
  message_id: number;
  sender: string;
  text: string;
  type: string;
  status: 'received' | 'filtered' | 'duplicate' | 'processed' | 'failed';
  created_at: number;
}

export function MessagesTab() {
  const [messages, setMessages] = useState<IncomingMessage[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchMessages = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const response = await fetch(`${API_BASE}/api/incoming-messages`)
      if (!response.ok) throw new Error("Konnte Nachrichten nicht laden.")
      const data = await response.json()
      setMessages(data.messages || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    fetchMessages()
    const interval = setInterval(fetchMessages, 5000)
    return () => clearInterval(interval)
  }, [])

  const getStatusBadge = (status: IncomingMessage['status']) => {
    switch (status) {
      case 'received':
        return <Badge variant="outline" className="border-gray-500 text-gray-500 dark:border-gray-400 dark:text-gray-400 bg-gray-500/10">Abgefangen</Badge>
      case 'filtered':
        return <Badge variant="outline" className="border-amber-500 text-amber-500 bg-amber-500/10">Gefiltert</Badge>
      case 'duplicate':
        return <Badge variant="outline" className="border-yellow-500 text-yellow-500 bg-yellow-500/10">Duplikat</Badge>
      case 'processed':
        return <Badge variant="outline" className="border-emerald-500 text-emerald-500 bg-emerald-500/10">Weitergeleitet</Badge>
      case 'failed':
        return <Badge variant="outline" className="border-rose-500 text-rose-500 bg-rose-500/10">Fehler</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div>
          <CardTitle>Abgefangene Nachrichten</CardTitle>
          <CardDescription>
            Verlauf aller abgefangenen Eingangsnachrichten und deren Routing-Status (Aktualisiert alle 5s)
          </CardDescription>
        </div>
        <Button onClick={fetchMessages} variant="outline" size="icon" disabled={isLoading}>
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
                <TableHead className="w-[100px]">Zeit</TableHead>
                <TableHead className="w-[180px]">Quelle (Alias / ID)</TableHead>
                <TableHead className="w-[100px]">Typ</TableHead>
                <TableHead className="w-[140px]">Status</TableHead>
                <TableHead>Inhalt (Auszug)</TableHead>
                <TableHead className="w-[50px] text-right">Aktion</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center gap-2">
                      <Inbox className="h-8 w-8 text-muted-foreground/50" />
                      {isLoading ? "Lade Nachrichten..." : "Noch keine Nachrichten erfasst."}
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                messages.map((msg) => {
                  const date = new Date(msg.created_at)
                  const timeStr = date.toLocaleTimeString("de-DE", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                  
                  return (
                    <TableRow key={msg.id} className="hover:bg-muted/30 transition-colors">
                      <TableCell className="font-mono text-xs">{timeStr}</TableCell>
                      <TableCell className="font-medium text-xs truncate max-w-[180px]" title={msg.chat_id}>
                        {msg.sender}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="capitalize text-[10px] px-1.5 py-0.5">
                          {msg.type}
                        </Badge>
                      </TableCell>
                      <TableCell>{getStatusBadge(msg.status)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-md truncate" title={msg.text}>
                        {msg.text || <span className="italic text-muted-foreground/50">Kein Textinhalt</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 active:scale-90 transition-all"
                          onClick={async (e) => {
                            e.stopPropagation()
                            if (window.confirm("Diese Nachricht wirklich aus dem Verlauf löschen?")) {
                              try {
                                const res = await fetch(`${API_BASE}/api/incoming-messages?id=${msg.id}`, { method: 'DELETE' })
                                if (res.ok) {
                                  fetchMessages()
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
