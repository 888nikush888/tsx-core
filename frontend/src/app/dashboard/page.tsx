import { useState, useEffect } from "react"
import { BaseLayout } from "@/components/layouts/base-layout"
import { ChartAreaInteractive } from "./components/chart-area-interactive"
import { SectionCards } from "./components/section-cards"
import { useSearchParams } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Play, Square } from "lucide-react"

import { LogsTab } from "./components/logs-tab"
import { SystemTab } from "./components/system-tab"
import { normalizeSignalWorkspace, SignalCenterTab, type SignalWorkspace } from "./components/signal-center-tab"
import { TradingTab } from "./components/trading-tab"
import { apiFetch } from "@/lib/api"

const API_BASE = window.location.origin

type SecretState = { configured: boolean; editable: boolean; source: 'managed' | 'external' | 'missing' }
type SecretStatus = {
  telegramApiHash: SecretState
  openRouterApiKey: SecretState
  dashboardAdminToken: SecretState
  dashboardViewerToken: SecretState
  auditWebhookToken: SecretState
  backupOffsiteToken: SecretState
  backupEncryptionKey: SecretState
}
type TelegramLoginState = {
  state: 'idle' | 'authenticating' | 'waiting' | 'completed' | 'failed'
  prompt?: { kind: string; label: string; hint?: string; retry?: boolean; link?: string }
  error?: string
}

const MISSING_SECRET: SecretState = { configured: false, editable: true, source: 'missing' }
const SIGNAL_CENTER_TABS = new Set(["signals", "messages", "channels", "options", "filters", "parser"])
const LEGACY_SIGNAL_WORKSPACES: Record<string, SignalWorkspace> = {
  messages: "messages",
  channels: "channels",
  options: "processing",
  filters: "filters",
  parser: "parser",
}

export default function Page() {
  const [searchParams, setSearchParams] = useSearchParams()
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
  const [secretStatus, setSecretStatus] = useState<SecretStatus>({
    telegramApiHash: MISSING_SECRET,
    openRouterApiKey: MISSING_SECRET,
    dashboardAdminToken: MISSING_SECRET,
    dashboardViewerToken: MISSING_SECRET,
    auditWebhookToken: MISSING_SECRET,
    backupOffsiteToken: MISSING_SECRET,
    backupEncryptionKey: MISSING_SECRET,
  })
  const [secretDraft, setSecretDraft] = useState({ telegramApiHash: '', openRouterApiKey: '' })
  const [telegramLogin, setTelegramLogin] = useState<TelegramLoginState>({ state: 'idle' })
  const [isSaving, setIsSaving] = useState(false)
  const [metricsHistory, setMetricsHistory] = useState<any[]>([])
  const isSignalCenter = SIGNAL_CENTER_TABS.has(tab)
  const signalWorkspace = normalizeSignalWorkspace(
    tab === "signals" ? searchParams.get("workspace") : LEGACY_SIGNAL_WORKSPACES[tab],
  )

  const selectSignalWorkspace = (workspace: SignalWorkspace) => {
    const next = new URLSearchParams(searchParams)
    next.set("tab", "signals")
    if (workspace === "overview") next.delete("workspace")
    else next.set("workspace", workspace)
    setSearchParams(next)
  }

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
        setTelegramLogin(data.telegramLogin || { state: 'idle' })
        
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

        const secretsRes = await apiFetch(`${API_BASE}/api/secrets`)
        if (!secretsRes.ok) throw new Error(`Secret status request failed with ${secretsRes.status}`)
        const secretData = await secretsRes.json()
        setSecretStatus(secretData.secrets)
      } catch (e) {
        console.error("Error fetching config:", e)
      }
    }

    const redirectRecoveryToSystem = async () => {
      try {
        const response = await apiFetch(`${API_BASE}/api/recovery`)
        const recovery = await response.json().catch(() => ({}))
        if (!recovery.active || tab === "system") return
        const next = new URLSearchParams(searchParams)
        next.set("tab", "system")
        setSearchParams(next)
      } catch (error) {
        console.error("Error checking recovery mode:", error)
      }
    }

    fetchStatus()
    fetchMetricsHistory()
    fetchConfig()
    redirectRecoveryToSystem()
    
    const statusInterval = setInterval(fetchStatus, 3000)
    const metricsInterval = setInterval(fetchMetricsHistory, 5000)
    
    return () => {
      clearInterval(statusInterval)
      clearInterval(metricsInterval)
    }
  }, [searchParams, setSearchParams, tab])

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
      const secrets = Object.fromEntries(
        Object.entries(secretDraft).filter(([, value]) => value.trim().length > 0)
      )
      if (Object.keys(secrets).length > 0) {
        const secretResponse = await apiFetch(`${API_BASE}/api/secrets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(secrets),
        })
        const secretResult = await secretResponse.json().catch(() => ({}))
        if (!secretResponse.ok) throw new Error(secretResult.error || 'Secrets could not be saved.')
        setSecretStatus(secretResult.secrets)
        setSecretDraft({ telegramApiHash: '', openRouterApiKey: '' })
      }
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
      alert(e instanceof Error ? e.message : "Failed to save configuration.")
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

  const setupSteps = [
    { label: "Telegram API ID and API hash", complete: Boolean(config?.apiId > 0 && secretStatus.telegramApiHash.configured) },
    { label: "At least one source and a target channel", complete: Boolean(config?.sourceChannels?.length > 0 && config?.targetChannel) },
    { label: "OpenRouter key or AI parser disabled", complete: Boolean(!config?.xmlParsing?.enabled || secretStatus.openRouterApiKey.configured) },
    { label: "Telegram account authenticated", complete: Boolean(isRunning || telegramLogin.state === "completed") },
  ]
  const routingConfigReady = setupSteps.slice(0, 3).every((step) => step.complete)
  const setupComplete = setupSteps.every((step) => step.complete)

  let content = null
  if (tab === "dashboard") {
    content = (
      <>
        <div className="flex items-center justify-between px-4 lg:px-6">
          <h2 className="text-2xl font-bold tracking-tight">System Status</h2>
          <Button 
            onClick={handleStartStop} 
            disabled={!isRunning && !routingConfigReady}
            title={!isRunning && !routingConfigReady ? "Complete and save the setup first" : undefined}
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
          {!setupComplete && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
              <h3 className="font-semibold">First-run setup · {setupSteps.filter((step) => step.complete).length}/{setupSteps.length} complete</h3>
              <ul className="mt-2 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
                {setupSteps.map((step) => <li key={step.label}>{step.complete ? "✓" : "○"} {step.label}</li>)}
              </ul>
              <p className="mt-3 text-sm">Configure credentials and routing under Channels, save, then start the forwarder to complete Telegram login in the browser.</p>
            </div>
          )}
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
              {isSignalCenter && "Signal Control Center"}
              {tab === "logs" && "System Logs"}
              {tab === "system" && "System & Backup"}
              {tab === "trading" && "Trading Control Center"}
            </h2>
            <p className="text-muted-foreground mt-1">
              {isSignalCenter && "Nachrichten, extrahierte Signale, Kanäle, Verarbeitung, Filter und KI-Parser an einem Ort."}
              {tab === "logs" && "Live terminal output from the backend daemon."}
              {tab === "system" && "Export data and reset the application."}
              {tab === "trading" && "Strategien, Kanal-Routing, Börsenkonten, Positionen und Risikosteuerung an einem Ort."}
            </p>
          </div>
        </div>

        <div className={`pb-10 mx-auto md:mx-0 w-full ${tab === "logs" || isSignalCenter || tab === "trading" ? "max-w-none" : "max-w-5xl"}`}>
          {isSignalCenter && <SignalCenterTab
            config={config}
            setConfig={setConfig}
            secretStatus={secretStatus}
            secretDraft={secretDraft}
            setSecretDraft={setSecretDraft}
            telegramLogin={telegramLogin}
            setTelegramLogin={setTelegramLogin}
            workspace={signalWorkspace}
            onWorkspaceChange={selectSignalWorkspace}
            onSave={saveConfig}
            isSaving={isSaving}
          />}
          {tab === "logs" && <LogsTab config={config} />}
          {tab === "system" && <SystemTab config={config} secretStatus={secretStatus} onSecretStatusChange={setSecretStatus} />}
          {tab === "trading" && <TradingTab config={config} />}
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
