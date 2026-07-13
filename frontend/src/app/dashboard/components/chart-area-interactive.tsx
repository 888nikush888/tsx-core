"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"

export const description = "An interactive real-time performance chart"

export interface MetricPoint {
  timestamp: string;
  internetSpeed: number;
  latency: number;
  processedCount: number;
  processedDelta: number;
  queueRunning: number;
  queueQueued: number;
  cpuUsage: number;
  memoryUsage: number;
}

const chartConfig = {
  internetSpeed: {
    label: "Bandbreite (Mbps)",
    color: "hsl(142.1 76.2% 36.3%)", // emerald green
  },
  latency: {
    label: "Ping / Latenz (ms)",
    color: "hsl(217.2 91.2% 59.8%)", // blue
  },
  processedDelta: {
    label: "Weitergeleitet",
    color: "hsl(262.1 83.3% 57.8%)", // purple
  },
  queueQueued: {
    label: "Warteschlange (Tasks)",
    color: "hsl(47.9 95.8% 51.2%)", // yellow
  },
  cpuUsage: {
    label: "CPU (%)",
    color: "hsl(24.6 95% 53.1%)", // orange
  },
  memoryUsage: {
    label: "RAM (MB)",
    color: "hsl(326.3 83.6% 50.2%)", // pink
  }
} satisfies ChartConfig

export function ChartAreaInteractive({ data = [] }: { data?: MetricPoint[] }) {
  const [category, setCategory] = React.useState<'network' | 'activity' | 'system'>('network')
  const [timeWindow, setTimeWindow] = React.useState<'10m' | '5m' | '1m'>('10m')

  const filteredData = React.useMemo(() => {
    if (!data || data.length === 0) return []
    let sliceCount = 120 // 10 minutes (120 points at 5s interval)
    if (timeWindow === '5m') {
      sliceCount = 60 // 5 minutes
    } else if (timeWindow === '1m') {
      sliceCount = 12 // 1 minute
    }
    return data.slice(-sliceCount)
  }, [data, timeWindow])

  const getTitle = () => {
    switch (category) {
      case 'network':
        return 'Verbindungsleistung'
      case 'activity':
        return 'Routing-Aktivität'
      case 'system':
        return 'System-Ressourcen'
    }
  }

  const getDescription = () => {
    switch (category) {
      case 'network':
        return 'Live-Geschwindigkeit und Server-Antwortzeit'
      case 'activity':
        return 'Nachrichten-Weiterleitungen und Queue-Tasks'
      case 'system':
        return 'CPU-Auslastung und RAM-Belegung des Daemons'
    }
  }

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{getTitle()}</CardTitle>
        <CardDescription>
          {getDescription()} — Aktualisiert alle 5s
        </CardDescription>
        <CardAction className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            type="single"
            value={category}
            onValueChange={(val) => {
              if (val) setCategory(val as any)
            }}
            variant="outline"
            className="flex items-center space-x-1 *:data-[slot=toggle-group-item]:!px-3"
          >
            <ToggleGroupItem value="network">Netzwerk</ToggleGroupItem>
            <ToggleGroupItem value="activity">Aktivität</ToggleGroupItem>
            <ToggleGroupItem value="system">Ressourcen</ToggleGroupItem>
          </ToggleGroup>

          <Select value={timeWindow} onValueChange={(val) => setTimeWindow(val as any)}>
            <SelectTrigger
              className="flex w-32"
              size="sm"
              aria-label="Zeitspanne"
            >
              <SelectValue placeholder="Zeitspanne" />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectItem value="10m" className="rounded-lg">
                Letzte 10 Min
              </SelectItem>
              <SelectItem value="5m" className="rounded-lg">
                Letzte 5 Min
              </SelectItem>
              <SelectItem value="1m" className="rounded-lg">
                Letzte 1 Min
              </SelectItem>
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[250px] w-full"
        >
          <AreaChart data={filteredData}>
            <defs>
              <linearGradient id="fillLatency" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-latency)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-latency)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillSpeed" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-internetSpeed)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-internetSpeed)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillProcessed" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-processedDelta)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-processedDelta)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillQueue" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-queueQueued)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-queueQueued)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillCpu" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-cpuUsage)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-cpuUsage)"
                  stopOpacity={0.1}
                />
              </linearGradient>
              <linearGradient id="fillMemory" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-memoryUsage)"
                  stopOpacity={0.8}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-memoryUsage)"
                  stopOpacity={0.1}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={48}
              tickFormatter={(value) => {
                try {
                  const date = new Date(value)
                  return date.toLocaleTimeString("de-DE", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                } catch {
                  return value
                }
              }}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => {
                    try {
                      return new Date(value as string | number | Date).toLocaleTimeString("de-DE", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })
                    } catch {
                      return String(value)
                    }
                  }}
                  indicator="dot"
                />
              }
            />
            {category === 'network' && (
              <>
                <Area
                  dataKey="latency"
                  type="monotone"
                  fill="url(#fillLatency)"
                  stroke="var(--color-latency)"
                  strokeWidth={2}
                  name="latency"
                />
                <Area
                  dataKey="internetSpeed"
                  type="monotone"
                  fill="url(#fillSpeed)"
                  stroke="var(--color-internetSpeed)"
                  strokeWidth={2}
                  name="internetSpeed"
                />
              </>
            )}
            {category === 'activity' && (
              <>
                <Area
                  dataKey="queueQueued"
                  type="monotone"
                  fill="url(#fillQueue)"
                  stroke="var(--color-queueQueued)"
                  strokeWidth={2}
                  name="queueQueued"
                />
                <Area
                  dataKey="processedDelta"
                  type="monotone"
                  fill="url(#fillProcessed)"
                  stroke="var(--color-processedDelta)"
                  strokeWidth={2}
                  name="processedDelta"
                />
              </>
            )}
            {category === 'system' && (
              <>
                <Area
                  dataKey="memoryUsage"
                  type="monotone"
                  fill="url(#fillMemory)"
                  stroke="var(--color-memoryUsage)"
                  strokeWidth={2}
                  name="memoryUsage"
                />
                <Area
                  dataKey="cpuUsage"
                  type="monotone"
                  fill="url(#fillCpu)"
                  stroke="var(--color-cpuUsage)"
                  strokeWidth={2}
                  name="cpuUsage"
                />
              </>
            )}
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
