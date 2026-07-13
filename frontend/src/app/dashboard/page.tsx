import { useState, useEffect } from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { ChartAreaInteractive } from "./components/chart-area-interactive"
import { SectionCards } from "./components/section-cards"
import { useSearchParams } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Play, Square, Save } from "lucide-react"

import { ChannelsTab } from "./components/channels-tab"
import { OptionsTab } from "./components/options-tab"
import { FiltersTab } from "./components/filters-tab"
import { ParserTab } from "./components/parser-tab"
import { LogsTab } from "./components/logs-tab"
import { SystemTab } from "./components/system-tab"
import { MessagesTab } from "./components/messages-tab"
import { SignalsTab } from "./components/signals-tab"
import { apiFetch } from "@/lib/api"

const API_BASE = window.location.origin

export default function Page() {
  const [searchParams] = useSearchParams()
  const tab = searchParams.get("tab") || "dashboard"

  const [isRunning, setIsRunning] = useState(false)
  const [connectionState, setConnectionState] = useState("disconnected")
  const [totalForwardedCount, setTotalForwardedCount] = useState(0)
  const [processedSinceRestart, setProcessedSinceRestart] = useState(0)
  const [forwardingEnabled, setForwardingEnabled] = useState(true)
  const [forwardXmlToTarget, setForwardXmlToTarget] = useState(false)
  const [uptime, setUptime] = useState("0h 0m")
  const [queue, setQueue] = useState({ running: 0, queued: 0, maxConcurrency: 2, paused: false })
  const [config, setConfig] = useState<any>(null)
  const [openRouterApiKeyConfigured, setOpenRouterApiKeyConfigured] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [metricsHistory, setMetricsHistory] = useState<any[]>([])

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await apiFetch(`${API_BASE}/api/status`)
        if (!response.ok) throw new Error(`Status request failed with ${response.status}`)
        const data = await response.json()
        setIsRunning(data.isRunning)
        setConnectionState(data.connectionState)
        setTotalForwardedCount(data.totalForwardedCount || 0)
        setProcessedSinceRestart(data.processedSinceRestart || 0)
        setForwardingEnabled(data.forwardingEnabled ?? true)
        setForwardXmlToTarget(data.forwardXmlToTarget ?? false)
        setQueue(data.queue || { running: 0, queued: 0, maxConcurrency: 2, paused: false })
        
        if (data.startTime) {
          const start = new Date(data.startTime)
          const now = new Date()
          const diffMs = now.getTime() - start.getTime()
          const hours = Math.floor(diffMs / (1000 * 60 * 60))
          const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
          setUptime(`${hours}h ${minutes}m`)
        } else {
          setUptime("Offline")
        }
      } catch (error) {
        console.error("Error fetching status:", error)
        setConnectionState("error")
      }
    }

    const fetchMetricsHistory = async () => {
      try {
        const response = await apiFetch(`${API_BASE}/api/metrics-history`)
        if (!response.ok) throw new Error(`Metrics request failed with ${response.status}`)
        const data = await response.json()
        if (data && data.history) {
          setMetricsHistory(data.history)
        }
      } catch (error) {
        console.error("Error fetching metrics history:", error)
      }
    }

    const fetchConfig = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/api/config`)
        if (!res.ok) throw new Error(`Config request failed with ${res.status}`)
        const data = await res.json()
        setConfig(data)

        const statusRes = await apiFetch(`${API_BASE}/api/status`)
        if (!statusRes.ok) throw new Error(`Status request failed with ${statusRes.status}`)
        const statusData = await statusRes.json()
        setOpenRouterApiKeyConfigured(statusData.openRouterApiKeyConfigured || false)
      } catch (e) {
        console.error("Error fetching config:", e)
      }
    }

    fetchStatus()
    fetchMetricsHistory()
    fetchConfig()
    
    const statusInterval = setInterval(fetchStatus, 3000)
    const metricsInterval = setInterval(fetchMetricsHistory, 5000)
    
    return () => {
      clearInterval(statusInterval)
      clearInterval(metricsInterval)
    }
  }, [])

  const saveConfig = async () => {
    setIsSaving(true);
    
    // Clean up empty lines from config arrays before saving
    const cleanedConfig = {
      ...config,
      sourceChannels: (config.sourceChannels || []).map((s: string) => s.trim()).filter((s: string) => s.length > 0),
      filters: config.filters ? {
        ...config.filters,
        blockedKeywords: (config.filters.blockedKeywords || []).map((s: string) => s.trim()).filter((s: string) => s.length > 0),
        allowedTypes: (config.filters.allowedTypes || []).map((s: string) => s.trim()).filter((s: string) => s.length > 0),
        regexPatterns: (config.filters.regexPatterns || []).map((s: string) => s.trim()).filter((s: string) => s.length > 0),
      } : undefined
    };

    try {
      const configResponse = await apiFetch(`${API_BASE}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cleanedConfig)
      })
      const configResult = await configResponse.json()
      if (!configResponse.ok) {
        throw new Error(configResult.error || "Configuration could not be saved.")
      }
      if (configResult.queue) {
        setQueue(configResult.queue)
      }

      // Sync state back with cleaned values
      setConfig(cleanedConfig);

      alert("Configuration saved successfully!")
    } catch (e) {
      console.error("Error saving config:", e)
      alert("Failed to save configuration.")
    } finally {
      setIsSaving(false)
    }
  }

  const handleStartStop = async () => {
    try {
      const response = await apiFetch(`${API_BASE}/api/control`, {
        method: "POST", 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ action: isRunning ? 'stop' : 'start' }) 
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error(payload.error || `Control request failed with ${response.status}`)
      }
    } catch (error) {
      console.error("Failed to toggle forwarder", error)
    }
  }

  const isConfigTab = ["channels", "options", "filters", "parser"].includes(tab)

  let content = null
  if (tab === "dashboard") {
    content = (
      <>
        <div className="flex items-center justify-between px-4 lg:px-6">
          <h2 className="text-2xl font-bold tracking-tight">System Status</h2>
          <Button 
            onClick={handleStartStop} 
            className={`font-medium transition-all active:scale-[0.97] duration-150 shadow-md ${
              isRunning 
                ? "bg-red-600 hover:bg-red-500 text-white dark:bg-red-500 dark:hover:bg-red-400" 
                : "bg-primary hover:bg-primary/90 text-primary-foreground"
            }`}
          >
            {isRunning ? (
              <><Square className="mr-2 h-4 w-4 fill-white" /> Stop Forwarder</>
            ) : (
              <><Play className="mr-2 h-4 w-4 fill-current" /> Start Forwarder</>
            )}
          </Button>
        </div>
        <div className="@container/main px-4 lg:px-6 space-y-6">
          <SectionCards 
            isRunning={isRunning} 
            connectionState={connectionState} 
            totalForwardedCount={totalForwardedCount}
            processedSinceRestart={processedSinceRestart}
            parserEnabled={config?.xmlParsing?.enabled ?? true}
            forwardingEnabled={forwardingEnabled}
            forwardXmlToTarget={forwardXmlToTarget}
            uptime={uptime}
            queue={queue}
          />
          <ChartAreaInteractive data={metricsHistory} />
        </div>
      </>
    )
  } else {
    content = (
      <div className="px-4 lg:px-6 space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              {tab === "channels" && "Kanalverwaltung"}
              {tab === "options" && "Optionen"}
              {tab === "filters" && "Filter & Reguläre Ausdrücke"}
              {tab === "parser" && "KI-Parser (OpenAI)"}
              {tab === "logs" && "System Logs"}
              {tab === "system" && "System & Backup"}
              {tab === "messages" && "Nachrichten-Verlauf"}
              {tab === "signals" && "Signale-Datenbank"}
            </h2>
            <p className="text-muted-foreground mt-1">
              {tab === "channels" && "Manage your Telegram API credentials and channel routing."}
              {tab === "options" && "Configure how messages are copied and forwarded."}
              {tab === "filters" && "Set up strict keyword and regex matching rules."}
              {tab === "parser" && "Instruct the AI to parse unstructured text into XML."}
              {tab === "logs" && "Live terminal output from the backend daemon."}
              {tab === "system" && "Export data and reset the application."}
              {tab === "messages" && "Review history of intercepted incoming messages."}
              {tab === "signals" && "Browse successfully extracted signals in database."}
            </p>
          </div>
          
          {isConfigTab && (
            <Button onClick={saveConfig} disabled={isSaving} size="lg" className="w-full md:w-auto">
              <Save className="mr-2 h-4 w-4" />
              {isSaving ? "Saving..." : "Save Configuration"}
            </Button>
          )}
        </div>

        <div className={`pb-10 mx-auto md:mx-0 w-full ${tab === "logs" || tab === "messages" || tab === "signals" ? "max-w-none" : "max-w-5xl"}`}>
          {tab === "channels" && <ChannelsTab config={config} setConfig={setConfig} />}
          {tab === "options" && <OptionsTab config={config} setConfig={setConfig} />}
          {tab === "filters" && <FiltersTab config={config} setConfig={setConfig} />}
          {tab === "parser" && <ParserTab config={config} setConfig={setConfig} openRouterApiKeyConfigured={openRouterApiKeyConfigured} />}
          {tab === "logs" && <LogsTab config={config} />}
          {tab === "system" && <SystemTab config={config} />}
          {tab === "messages" && <MessagesTab />}
          {tab === "signals" && <SignalsTab config={config} />}
        </div>
      </div>
    )
  }

  return (
    <BaseLayout>
      {content}
    </BaseLayout>
  )
}
