import { TrendingUp, Activity, CheckCircle, AlertCircle, Clock, Send, ListOrdered, PauseCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

export function SectionCards({ 
  isRunning, 
  connectionState, 
  totalForwardedCount, 
  processedSinceRestart, 
  parserEnabled,
  uptime, 
  queue, 
  forwardingEnabled, 
  forwardXmlToTarget 
}: any) {
  const queueState = queue || { running: 0, queued: 0, maxConcurrency: 2, paused: false }
  
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      
      {/* Card 1: Processed Since Restart */}
      <Card className="@container/card hover:border-primary/30 transition-colors">
        <CardHeader>
          <CardDescription>Verarbeitet seit Neustart</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {(processedSinceRestart || 0).toLocaleString()}
          </CardTitle>
          <CardAction>
            <Badge 
              variant="outline" 
              className={isRunning && parserEnabled
                ? "bg-emerald-500/10 text-emerald-800 border-emerald-500/20 dark:text-emerald-300"
                : "bg-red-500/10 text-red-800 border-red-500/20 dark:text-red-300"}
            >
              <TrendingUp className="mr-1 size-3" />
              {isRunning ? (parserEnabled ? "Aktiv" : "Parser aus") : "Inaktiv"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Im aktuellen Lauf verarbeitet <Send className="size-4" />
          </div>
          <div className="text-muted-foreground">
            Verarbeitung seit dem Start des Service-Prozesses
          </div>
        </CardFooter>
      </Card>

      {/* Card 2: Queue */}
      <Card className="@container/card hover:border-primary/30 transition-colors">
        <CardHeader>
          <CardDescription>Queue</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {queueState.queued}
          </CardTitle>
          <CardAction>
            <Badge 
              variant="outline" 
              className={queueState.paused 
                ? "bg-amber-500/10 text-amber-800 border-amber-500/20 dark:text-amber-300"
                : "bg-emerald-500/10 text-emerald-800 border-emerald-500/20 dark:text-emerald-300"}
            >
              {queueState.paused ? <PauseCircle className="mr-1 size-3" /> : <ListOrdered className="mr-1 size-3" />}
              {queueState.paused ? "Pausiert" : "Wartend"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {queueState.running} von {queueState.maxConcurrency} werden verarbeitet <Activity className="size-4" />
          </div>
          <div className="text-muted-foreground">
            Nachrichten in der Weiterleitungswarteschlange
          </div>
        </CardFooter>
      </Card>
      
      {/* Card 3: Daemon State */}
      <Card className="@container/card hover:border-primary/30 transition-colors">
        <CardHeader>
          <CardDescription>Daemon State</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {isRunning ? "Running" : "Stopped"}
          </CardTitle>
          <CardAction>
            <Badge 
              variant="outline" 
              className={isRunning 
                ? "bg-emerald-500/10 text-emerald-800 border-emerald-500/20 dark:text-emerald-300"
                : "bg-red-500/10 text-red-800 border-red-500/20 dark:text-red-300"}
            >
              <Activity className="mr-1 size-3" />
              {isRunning ? "Online" : "Offline"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Service process <Activity className="size-4" />
          </div>
          <div className="text-muted-foreground">
            Core routing daemon
          </div>
        </CardFooter>
      </Card>
      
      {/* Card 4: Connection State */}
      <Card className="@container/card hover:border-primary/30 transition-colors">
        <CardHeader>
          <CardDescription>Telegram Client</CardDescription>
          <CardTitle className="text-xl font-semibold tabular-nums @[250px]/card:text-2xl capitalize">
            {connectionState}
          </CardTitle>
          <CardAction>
            <Badge 
              variant="outline" 
              className={connectionState === 'connected' 
                ? "bg-emerald-500/10 text-emerald-800 border-emerald-500/20 dark:text-emerald-300"
                : "bg-red-500/10 text-red-800 border-red-500/20 dark:text-red-300"}
            >
              {connectionState === 'connected' ? <CheckCircle className="mr-1 size-3" /> : <AlertCircle className="mr-1 size-3" />}
              {connectionState === 'connected' ? "Bereit" : "Fehler"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            MTProto Connection <CheckCircle className="size-4" />
          </div>
          <div className="text-muted-foreground">Session token validity</div>
        </CardFooter>
      </Card>
      
      {/* Card 5: Uptime */}
      <Card className="@container/card hover:border-primary/30 transition-colors">
        <CardHeader>
          <CardDescription>System Uptime</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {uptime}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <Clock className="mr-1 size-3" />
              Live
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            Continuous operation <Clock className="size-4" />
          </div>
          <div className="text-muted-foreground">Since last restart</div>
        </CardFooter>
      </Card>

      {/* Card 6: Total Forwarded */}
      <Card className="@container/card hover:border-primary/30 transition-colors">
        <CardHeader>
          <CardDescription>Erfolgreich weitergeleitet</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {totalForwardedCount.toLocaleString()}
          </CardTitle>
          <CardAction>
            <Badge 
              variant="outline" 
              className={forwardingEnabled
                ? "bg-emerald-500/10 text-emerald-800 border-emerald-500/20 dark:text-emerald-300"
                : "bg-red-500/10 text-red-800 border-red-500/20 dark:text-red-300"}
            >
              <TrendingUp className="mr-1 size-3" />
              {forwardingEnabled ? (forwardXmlToTarget ? "XML-Modus" : "Aktiv") : "Deaktiviert"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex gap-2 font-medium">
            {forwardingEnabled
              ? (forwardXmlToTarget ? "XML an den Zielkanal gesendet" : "An den Zielkanal gesendet")
              : "Keine Weiterleitung aktiviert"} <Send className="size-4" />
          </div>
          <div className="text-muted-foreground">
            {forwardingEnabled
              ? "Gesamtzahl erfolgreicher Weiterleitungen"
              : "Signale werden nur lokal verarbeitet und gespeichert"}
          </div>
        </CardFooter>
      </Card>

    </div>
  )
}
