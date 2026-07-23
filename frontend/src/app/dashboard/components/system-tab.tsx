import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertTriangle, DatabaseBackup, Download, KeyRound, ShieldCheck } from "lucide-react"
import { apiFetch, clearDashboardToken, setDashboardToken } from "@/lib/api"

const API_BASE = window.location.origin

export function SystemTab({ config, secretStatus, onSecretStatusChange }: any) {
  const [operations, setOperations] = useState<any>({})
  const [issuedToken, setIssuedToken] = useState<{ role: string; token: string } | null>(null)
  const [busyAction, setBusyAction] = useState("")
  const [message, setMessage] = useState("")
  const [runtimeSettings, setRuntimeSettings] = useState<any>(null)
  const [recovery, setRecovery] = useState<{ active: boolean; issues: Array<{ component: string; name?: string; reason: string }> }>({ active: false, issues: [] })
  const [restartRequired, setRestartRequired] = useState(false)
  const [backups, setBackups] = useState<string[]>([])
  const [selectedBackup, setSelectedBackup] = useState("")
  const [offsiteObjectName, setOffsiteObjectName] = useState("")
  const [enterpriseSecrets, setEnterpriseSecrets] = useState({
    auditWebhookToken: "",
    alertRelayToken: "",
    alertWebhookToken: "",
    backupOffsiteToken: "",
    backupEncryptionKey: "",
  })

  const refreshOperations = async () => {
    const response = await apiFetch(`${API_BASE}/api/operations`)
    if (response.ok) setOperations((await response.json()).operations || {})
  }

  const refreshSecrets = async () => {
    const response = await apiFetch(`${API_BASE}/api/secrets`)
    if (response.ok) onSecretStatusChange?.((await response.json()).secrets)
  }

  const refreshRuntimeSettings = async () => {
    const response = await apiFetch(`${API_BASE}/api/runtime-settings`)
    if (response.ok) setRuntimeSettings((await response.json()).settings)
  }

  const refreshRecovery = async () => {
    const response = await apiFetch(`${API_BASE}/api/recovery`)
    if (response.ok) setRecovery(await response.json())
  }

  const refreshBackups = async () => {
    const response = await apiFetch(`${API_BASE}/api/backups`)
    if (!response.ok) return
    const names = (await response.json()).backups || []
    setBackups(names)
    setSelectedBackup((current) => current && names.includes(current) ? current : (names[0] || ""))
  }

  useEffect(() => {
    void refreshOperations()
    void refreshRuntimeSettings()
    void refreshRecovery()
    void refreshBackups()
  }, [])

  const updateRuntimeSetting = (name: string, value: unknown) => {
    setRuntimeSettings((current: any) => ({ ...current, [name]: value }))
  }

  const toggleEnterpriseMode = (enabled: boolean) => {
    setRuntimeSettings((current: any) => ({
      ...current,
      enterpriseMode: enabled,
      dashboardAuthMode: enabled ? "oidc" : current.dashboardAuthMode,
      dashboardLocalTrust: enabled ? false : current.dashboardLocalTrust,
      auditRemoteRequired: enabled ? true : current.auditRemoteRequired,
      backupOffsiteRequired: enabled ? true : current.backupOffsiteRequired,
    }))
  }

  const saveRuntimeSettings = async () => {
    if (!runtimeSettings) return
    setBusyAction("runtime-settings")
    setMessage("")
    try {
      const response = await apiFetch(`${API_BASE}/api/runtime-settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runtimeSettings),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Runtime-Einstellungen konnten nicht gespeichert werden.")
      setRuntimeSettings(payload.settings)
      setRestartRequired(true)
      setMessage("Runtime-Einstellungen gespeichert. Neustart erforderlich.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Runtime-Einstellungen konnten nicht gespeichert werden.")
    } finally {
      setBusyAction("")
    }
  }

  const restartService = async () => {
    if (!window.confirm("Dienst jetzt kontrolliert neu starten und gespeicherte Runtime-Einstellungen aktivieren?")) return
    setBusyAction("restart")
    try {
      const response = await apiFetch(`${API_BASE}/api/restart`, {
        method: "POST",
        headers: { "X-Destructive-Confirmation": "restart-service" },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Neustart konnte nicht ausgelöst werden.")
      clearDashboardToken()
      setMessage("Container startet neu…")
      setTimeout(() => { window.location.href = "/" }, 2500)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Neustart konnte nicht ausgelöst werden.")
      setBusyAction("")
    }
  }

  const generateAccessToken = async (role: "admin" | "viewer") => {
    if (role === "admin" && !window.confirm("Admin-Key wirklich rotieren? Alle bisher ausgegebenen Admin-Keys werden sofort ungültig.")) return
    setBusyAction(`token-${role}`)
    setMessage("")
    try {
      const response = await apiFetch(`${API_BASE}/api/access-tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || typeof payload.token !== "string") throw new Error(payload.error || "Key konnte nicht erzeugt werden.")
      if (role === "admin") setDashboardToken(payload.token)
      setIssuedToken({ role, token: payload.token })
      await refreshSecrets()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Key-Erzeugung fehlgeschlagen.")
    } finally {
      setBusyAction("")
    }
  }

  const disableViewerToken = async () => {
    if (!window.confirm("Read-only Viewer-Key wirklich deaktivieren?")) return
    setBusyAction("disable-viewer")
    try {
      const response = await apiFetch(`${API_BASE}/api/access-tokens/viewer`, {
        method: "DELETE",
        headers: { "X-Destructive-Confirmation": "disable-viewer-token" },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Viewer-Key konnte nicht deaktiviert werden.")
      setIssuedToken(null)
      await refreshSecrets()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Viewer-Key konnte nicht deaktiviert werden.")
    } finally {
      setBusyAction("")
    }
  }

  const saveEnterpriseSecrets = async () => {
    const updates = Object.fromEntries(Object.entries(enterpriseSecrets).filter(([, value]) => value.trim()))
    if (Object.keys(updates).length === 0) return
    setBusyAction("enterprise-secrets")
    try {
      const response = await apiFetch(`${API_BASE}/api/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Enterprise-Secrets konnten nicht gespeichert werden.")
      onSecretStatusChange?.(payload.secrets)
      setEnterpriseSecrets({ auditWebhookToken: "", alertRelayToken: "", alertWebhookToken: "", backupOffsiteToken: "", backupEncryptionKey: "" })
      setMessage("Enterprise-Secrets sicher gespeichert.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enterprise-Secrets konnten nicht gespeichert werden.")
    } finally {
      setBusyAction("")
    }
  }

  const runBackup = async () => {
    setBusyAction("backup")
    try {
      const response = await apiFetch(`${API_BASE}/api/operations/backup`, { method: "POST" })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Backup fehlgeschlagen.")
      setMessage(`Backup verifiziert: ${payload.artifact}`)
      await refreshOperations()
      await refreshBackups()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backup fehlgeschlagen.")
    } finally {
      setBusyAction("")
    }
  }

  const verifySelectedBackup = async () => {
    if (!selectedBackup) return
    setBusyAction("verify-backup")
    try {
      const response = await apiFetch(`${API_BASE}/api/backups/verify?name=${encodeURIComponent(selectedBackup)}`)
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Backup-Verifikation fehlgeschlagen.")
      const included = Array.isArray(payload.manifest?.recovery?.includedState) ? payload.manifest.recovery.includedState.join(", ") : "Datenbank und nicht geheime Konfiguration"
      const excluded = Array.isArray(payload.manifest?.recovery?.excludedState) ? payload.manifest.recovery.excludedState.join(", ") : "Secrets und TDLib-Sitzung"
      setMessage(`Backup ${selectedBackup} verifiziert. Enthalten: ${included}. Separat erneut bereitzustellen: ${excluded}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backup-Verifikation fehlgeschlagen.")
    } finally {
      setBusyAction("")
    }
  }

  const restoreSelectedBackup = async () => {
    if (!selectedBackup || window.prompt(`Backup ${selectedBackup} stellt Datenbank, nicht geheime Konfiguration, Runtime-Einstellungen und Templates wieder her und startet den Container neu. Secrets und TDLib-Sitzung werden bewusst nicht importiert. RESTORE eingeben:`) !== "RESTORE") return
    setBusyAction("restore-backup")
    try {
      const response = await apiFetch(`${API_BASE}/api/backups/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Destructive-Confirmation": "restore-backup" },
        body: JSON.stringify({ name: selectedBackup }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Backup-Restore fehlgeschlagen.")
      clearDashboardToken()
      setMessage("Backup wiederhergestellt. Container startet neu…")
      setTimeout(() => { window.location.href = "/" }, 2500)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backup-Restore fehlgeschlagen.")
      setBusyAction("")
    }
  }

  const recoverOffsiteBackup = async () => {
    const objectName = offsiteObjectName.trim()
    if (!objectName || window.prompt(`Off-site-Objekt ${objectName} herunterladen, entschlüsseln und vollständig verifizieren. RECOVER eingeben:`) !== "RECOVER") return
    setBusyAction("recover-offsite")
    try {
      const response = await apiFetch(`${API_BASE}/api/backups/recover-offsite`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Destructive-Confirmation": "recover-offsite-backup" },
        body: JSON.stringify({ objectName }),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Off-site-Backup konnte nicht wiederhergestellt werden.")
      setMessage(`Off-site-Backup verifiziert und lokal bereitgestellt: ${payload.artifactName}`)
      setOffsiteObjectName("")
      await refreshBackups()
      setSelectedBackup(payload.artifactName)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Off-site-Backup konnte nicht wiederhergestellt werden.")
    } finally {
      setBusyAction("")
    }
  }

  const replayAudit = async () => {
    if (!window.confirm("Lokale Audit-Kette vollständig an den konfigurierten Remote-Empfänger übertragen?")) return
    setBusyAction("audit")
    try {
      const response = await apiFetch(`${API_BASE}/api/operations/audit-replay`, {
        method: "POST",
        headers: { "X-Destructive-Confirmation": "replay-audit" },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || "Audit-Replay fehlgeschlagen.")
      setMessage(`${payload.replayed} Audit-Einträge übertragen.`)
      await refreshOperations()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Audit-Replay fehlgeschlagen.")
    } finally {
      setBusyAction("")
    }
  }
  
  const handleFactoryReset = async () => {
    if (window.prompt("TOTAL RESET löscht Konfiguration, Secrets, API-Keys, Templates, Telegram-Sitzung, Datenbank, Signale, Logs, Audit-Kette und lokale Backups. Durch Löschen des Backup-Schlüssels werden verbleibende Off-site-Objekte kryptografisch unbrauchbar. Zum Bestätigen RESET eingeben:") === "RESET") {
      try {
        const response = await apiFetch(`${API_BASE}/api/factory-reset`, {
          method: "POST",
          headers: { 'X-Destructive-Confirmation': 'factory-reset' }
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || `Factory reset failed with ${response.status}`)
        clearDashboardToken()
        setMessage("Factory Reset abgeschlossen. Container startet neu…")
        setTimeout(() => { window.location.href = "/" }, 2500)
      } catch (e) {
        console.error("Factory reset failed", e)
        setMessage(e instanceof Error ? e.message : "Factory reset failed.")
      }
    }
  }

  const handleClearDatabase = async () => {
    if (window.confirm("Betriebsdaten endgültig leeren? Das Routing wird sicher gestoppt. Nachrichten, unreferenzierte Signale und Queue-Daten werden gelöscht; Trading-Historie, Strategien, Konten und trade-verknüpfte Signale bleiben erhalten.")) {
      setBusyAction("clear-database")
      setMessage("")
      try {
        const res = await apiFetch(`${API_BASE}/api/clear-database`, {
          method: "POST",
          headers: { 'X-Destructive-Confirmation': 'clear-database' }
        })
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(payload.error || `Datenbank konnte nicht geleert werden (${res.status}).`)
        const cleared = payload.cleared || {}
        const retained = Number(cleared.retainedTradingSignals || 0)
        setMessage(
          `Betriebsdaten geleert: ${Number(cleared.deletedIncomingMessages || 0)} Nachrichten, `
          + `${Number(cleared.deletedSignals || 0)} unreferenzierte Signale und `
          + `${Number(cleared.deletedPendingTasks || 0)} Queue-Einträge entfernt. `
          + (retained > 0 ? `${retained} trade-verknüpfte Signale bleiben für Audit und Recovery erhalten. ` : "")
          + "Routing bleibt gestoppt.",
        )
      } catch (e) {
        console.error("Clear database failed", e)
        setMessage(e instanceof Error ? e.message : "Datenbank konnte nicht geleert werden.")
      } finally {
        setBusyAction("")
      }
    }
  }

  const exportConfig = async () => {
    try {
      const bundle = {
        _exportVersion: 2,
        _exportedAt: new Date().toISOString(),
        config
      }

      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(bundle, null, 2))
      const downloadAnchorNode = document.createElement('a')
      downloadAnchorNode.setAttribute("href", dataStr)
      downloadAnchorNode.setAttribute("download", `tsx_core_backup_${new Date().toISOString().slice(0, 10)}.json`)
      document.body.appendChild(downloadAnchorNode)
      downloadAnchorNode.click()
      downloadAnchorNode.remove()
    } catch (e) {
      console.error("Export failed", e)
      alert("Export failed.")
    }
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const content = await file.text()
      const bundle = JSON.parse(content)

      if (!bundle.config) {
        throw new Error('Invalid backup file. Missing "config" section.')
      }

      if (window.confirm("WARNING: This will overwrite your current configuration. Continue?")) {
        const res = await apiFetch(`${API_BASE}/api/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bundle)
        })

        if (res.ok) {
          alert("Configuration imported successfully! Reloading...")
          window.location.reload()
        } else {
          const data = await res.json()
          alert("Import failed: " + data.error)
        }
      }
    } catch (err: any) {
      alert("Failed to parse import file: " + err.message)
    } finally {
      e.target.value = ''
    }
  }

  return (
    <div className="space-y-6">
      {message && <output className="block rounded-lg border bg-muted/40 p-3 text-sm">{message}</output>}
      {recovery.active && (
        <Card className="border-destructive/60">
          <CardHeader>
            <div className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive" /><CardTitle>Geschützter Reparaturmodus aktiv</CardTitle></div>
            <CardDescription>Routing, Backups und sonstige Steuerungsaktionen bleiben deaktiviert. Korrigiere die markierte Konfiguration, Managed Secrets bzw. Runtime-Einstellungen und starte den Container danach kontrolliert neu.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {recovery.issues.map((issue, index) => <p key={`${issue.component}-${issue.name || index}`}>{issue.name ? `${issue.name}: ` : ''}{issue.reason}</p>)}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" /><CardTitle>API- und Bearer-Keys</CardTitle></div>
          <CardDescription>Keys serverseitig erzeugen oder rotieren. Jeder neue Bearer-Key wird genau einmal angezeigt.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Button onClick={() => generateAccessToken("admin")} disabled={Boolean(busyAction)}>Neuen Admin-Key erzeugen</Button>
            <Button variant="outline" onClick={() => generateAccessToken("viewer")} disabled={Boolean(busyAction)}>Neuen Viewer-Key erzeugen</Button>
            <Button variant="outline" onClick={disableViewerToken} disabled={Boolean(busyAction) || !secretStatus?.dashboardViewerToken?.configured}>Viewer-Key deaktivieren</Button>
          </div>
          {issuedToken && (
            <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-4">
              <p className="text-sm font-medium">{issuedToken.role === "admin" ? "Admin" : "Viewer"}-Key · nur einmal sichtbar</p>
              <div className="break-all font-mono text-xs">{issuedToken.token}</div>
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(issuedToken.token)}>Kopieren</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><CardTitle>Enterprise-Secrets</CardTitle></div>
          <CardDescription>Write-only Zugangsdaten für Remote-Audit und verschlüsselte Off-site-Backups.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {Object.entries(enterpriseSecrets).map(([name, value]) => (
            <div className="space-y-2" key={name}>
              <Label htmlFor={name}>{name} · {secretStatus?.[name]?.configured ? "gespeichert" : "nicht konfiguriert"}</Label>
              <Input id={name} type="password" autoComplete="off" value={value} placeholder={secretStatus?.[name]?.configured ? "Leer lassen, um vorhandenen Wert zu behalten" : "Secret eingeben"} onChange={(event) => setEnterpriseSecrets((current) => ({ ...current, [name]: event.target.value }))} disabled={secretStatus?.[name]?.editable === false} />
              {name === "backupEncryptionKey" && secretStatus?.[name]?.configured && <p className="text-xs text-muted-foreground">Unveränderlich: Eine Rotation würde bestehende Off-site-Backups unlesbar machen. Nur ein vollständiger Factory Reset verwirft diese Backup-Generation.</p>}
            </div>
          ))}
          <Button onClick={saveEnterpriseSecrets} disabled={Boolean(busyAction) || !Object.values(enterpriseSecrets).some((value) => value.trim())}>Enterprise-Secrets speichern</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" /><CardTitle>Vollständige Runtime- und Enterprise-Konfiguration</CardTitle></div>
          <CardDescription>Diese Werte ersetzen die frühere `.env`-Konfiguration. Änderungen werden atomar gespeichert und erst nach einem kontrollierten Container-Neustart aktiv.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!runtimeSettings ? <p className="text-sm text-muted-foreground">Runtime-Einstellungen werden geladen…</p> : <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["enterpriseMode", "Enterprise-Modus"],
                ["dashboardLocalTrust", "Integrierter lokaler Start"],
                ["auditRemoteRequired", "Remote-Audit verpflichtend"],
                ["backupOffsiteRequired", "Off-site-Backup verpflichtend"],
                ["jsonLogging", "JSON-Logging"],
              ].map(([name, label]) => (
                <label key={name} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                  <input type="checkbox" checked={Boolean(runtimeSettings[name])} onChange={(event) => name === "enterpriseMode" ? toggleEnterpriseMode(event.target.checked) : updateRuntimeSetting(name, event.target.checked)} />
                  {label}
                </label>
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="dashboardAuthMode">Dashboard-Authentifizierung</Label>
                <select id="dashboardAuthMode" className="h-9 w-full rounded-md border bg-background px-3 text-sm" value={runtimeSettings.dashboardAuthMode} onChange={(event) => updateRuntimeSetting("dashboardAuthMode", event.target.value)}>
                  <option value="token">Lokale Bearer-Keys</option>
                  <option value="oidc">OIDC</option>
                </select>
              </div>
              {[
                ["dashboardAllowedOrigin", "Erlaubte externe Dashboard-Origin"],
                ["oidcIssuer", "OIDC Issuer"],
                ["oidcAudience", "OIDC Audience"],
                ["oidcJwksUrl", "OIDC JWKS URL"],
                ["oidcAdminRole", "OIDC Admin-Rolle"],
                ["oidcViewerRole", "OIDC Viewer-Rolle"],
                ["oidcRoleClaim", "OIDC Rollen-Claim"],
                ["auditWebhookUrl", "Remote Audit Webhook URL"],
                ["alertWebhookUrl", "Incident Alert Webhook URL"],
                ["backupOffsiteUrlTemplate", "Off-site Backup URL mit {artifact}"],
              ].map(([name, label]) => (
                <div className="space-y-2" key={name}>
                  <Label htmlFor={name}>{label}</Label>
                  <Input id={name} value={runtimeSettings[name] ?? ""} onChange={(event) => updateRuntimeSetting(name, event.target.value)} />
                </div>
              ))}
            </div>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[
                ["oidcMaxTokenAgeSeconds", "OIDC Token-Alter (Sek.)"],
                ["auditWebhookTimeoutMs", "Audit Timeout (ms)"],
                ["alertWebhookTimeoutMs", "Alert Timeout (ms)"],
                ["auditLocalMaxBytes", "Lokales Audit-Limit (Bytes)"],
                ["backupOffsiteTimeoutMs", "Off-site Timeout (ms)"],
                ["backupOffsiteMaxRecoveryBytes", "Max. Off-site-Recovery-Gr\u00f6\u00dfe (Bytes)"],
                ["backupOffsiteRetentionDays", "Best\u00e4tigte Off-site-Retention (Tage)"],
                ["backupIntervalMs", "Backup-Intervall (ms)"],
                ["backupRetentionCount", "Backup-Anzahl"],
                ["dataRetentionDays", "Daten-Retention (Tage)"],
                ["dataRetentionIntervalMs", "Retention-Lauf (ms)"],
                ["dataRetentionBatchSize", "Retention Batch-Größe"],
                ["dataMinFreeBytes", "Minimal freier Speicher (Bytes)"],
                ["deliveryConfirmTimeoutMs", "Zustellbestätigung Timeout (ms)"],
                ["shutdownGraceMs", "Shutdown-Frist (ms)"],
              ].map(([name, label]) => (
                <div className="space-y-2" key={name}>
                  <Label htmlFor={name}>{label}</Label>
                  <Input id={name} type="number" value={runtimeSettings[name]} onChange={(event) => updateRuntimeSetting(name, Number(event.target.value))} />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <Button onClick={saveRuntimeSettings} disabled={Boolean(busyAction)}>Runtime-Einstellungen speichern</Button>
              <Button variant={restartRequired ? "default" : "outline"} onClick={restartService} disabled={Boolean(busyAction)}>Container kontrolliert neu starten</Button>
            </div>
          </>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2"><DatabaseBackup className="h-5 w-5 text-primary" /><CardTitle>Enterprise Operations</CardTitle></div>
          <CardDescription>Backup-, Retention- und Audit-Zustand prüfen und kontrollierte Aktionen starten.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">{JSON.stringify(operations, null, 2)}</pre>
          <div className="flex flex-wrap gap-3">
            <Button onClick={runBackup} disabled={Boolean(busyAction)}>Verifiziertes Backup jetzt erstellen</Button>
            <Button variant="outline" onClick={replayAudit} disabled={Boolean(busyAction)}>Remote Audit erneut übertragen</Button>
            <Button variant="outline" onClick={refreshOperations} disabled={Boolean(busyAction)}>Status aktualisieren</Button>
          </div>
          <div className="grid gap-3 rounded-md border p-4 md:grid-cols-[1fr_auto_auto]">
            <select className="h-9 rounded-md border bg-background px-3 text-sm" value={selectedBackup} onChange={(event) => setSelectedBackup(event.target.value)}>
              <option value="">Kein Backup vorhanden</option>
              {backups.map((name) => <option value={name} key={name}>{name}</option>)}
            </select>
            <Button variant="outline" onClick={verifySelectedBackup} disabled={Boolean(busyAction) || !selectedBackup}>Backup verifizieren</Button>
            <Button variant="destructive" onClick={restoreSelectedBackup} disabled={Boolean(busyAction) || !selectedBackup}>Backup wiederherstellen</Button>
          </div>
          <div className="grid gap-3 rounded-md border p-4 md:grid-cols-[1fr_auto]">
            <Input value={offsiteObjectName} onChange={(event) => setOffsiteObjectName(event.target.value)} placeholder="backup-2026-...tgfb aus Audit/Backup-Status" />
            <Button variant="outline" onClick={recoverOffsiteBackup} disabled={Boolean(busyAction) || !offsiteObjectName.trim()}>Off-site-Backup abrufen</Button>
            <p className="text-xs text-muted-foreground md:col-span-2">Lädt das verschlüsselte Objekt vom konfigurierten Off-site-Ziel, prüft AES-GCM, Remote-Checksumme, Manifest und SQLite-Integrität und stellt es anschließend in der lokalen Backup-Liste bereit.</p>
          </div>
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Download className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Konfiguration exportieren/importieren</CardTitle>
          </div>
          <CardDescription>
            Nicht geheime Routing-Konfiguration als JSON übertragen. Vollständige Datenbank-Backups und Restore befinden sich unter Enterprise Operations.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted/50 rounded-lg border p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
              <h4 className="font-medium text-sm">Konfiguration herunterladen</h4>
              <p className="text-sm text-muted-foreground">Keep a secure backup of your configuration.</p>
            </div>
            <Button variant="outline" onClick={exportConfig}>
              Export Configuration
            </Button>
          </div>

          <div className="bg-muted/50 rounded-lg border p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
              <h4 className="font-medium text-sm">Konfiguration importieren</h4>
              <p className="text-sm text-muted-foreground">Upload a previously exported JSON backup.</p>
            </div>
            <div>
              <input 
                type="file" 
                accept=".json" 
                id="import-file" 
                className="hidden" 
                onChange={handleImport}
              />
              <Button variant="outline" onClick={() => document.getElementById('import-file')?.click()}>
                Import Configuration
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/30 shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <CardTitle>Danger Zone</CardTitle>
          </div>
          <CardDescription>
            Destructive actions that cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted/50 rounded-lg border p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
              <h4 className="font-medium text-sm text-destructive">Factory Reset</h4>
              <p className="text-sm text-muted-foreground">Stoppt den Dienst und löscht den gesamten lokal verwalteten Zustand einschließlich Konfiguration, Secrets/Bearer-Keys, Templates, Telegram-Sitzung, Datenbank, Signalen, Logs, Audit-Kette und lokalen Backups. Der gelöschte Verschlüsselungsschlüssel bewirkt Crypto-Erasure verbleibender Off-site-Objekte.</p>
            </div>
            <Button variant="outline" className="text-destructive border-destructive hover:bg-destructive/10" onClick={handleFactoryReset}>
              Perform Factory Reset
            </Button>
          </div>

          <div className="bg-muted/50 rounded-lg border p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
              <h4 className="font-medium text-sm text-destructive">Betriebsdaten leeren</h4>
              <p className="text-sm text-muted-foreground">Stoppt das Routing und löscht Nachrichten, unreferenzierte XML-Signale und Queue-Daten atomar. Trading-Historie, Strategien, Konten und zugehörige Signale bleiben erhalten.</p>
            </div>
            <Button variant="outline" className="text-destructive border-destructive hover:bg-destructive/10" disabled={Boolean(busyAction)} onClick={handleClearDatabase}>
              Betriebsdaten leeren
            </Button>
          </div>
        </CardContent>
      </Card>

    </div>
  )
}
