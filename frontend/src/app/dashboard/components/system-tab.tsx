import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertTriangle, Download } from "lucide-react"
import { apiFetch } from "@/lib/api"

const API_BASE = window.location.origin

export function SystemTab({ config }: any) {
  
  const handleFactoryReset = async () => {
    if (window.confirm("ARE YOU SURE? This will permanently delete your configuration and restart the forwarder.")) {
      try {
        const response = await apiFetch(`${API_BASE}/api/factory-reset`, {
          method: "POST",
          headers: { 'X-Destructive-Confirmation': 'factory-reset' }
        })
        if (!response.ok) throw new Error(`Factory reset failed with ${response.status}`)
        window.location.href = "/" // Reload the entire page to reflect reset
      } catch (e) {
        console.error("Factory reset failed", e)
      }
    }
  }

  const handleClearDatabase = async () => {
    if (window.confirm("Bist du sicher? Dadurch werden alle abgefangenen Nachrichten, gesendeten Signale und Cache-Daten dauerhaft aus der Datenbank gelöscht. Dies kann nicht rückgängig gemacht werden!")) {
      try {
        const res = await apiFetch(`${API_BASE}/api/clear-database`, {
          method: "POST",
          headers: { 'X-Destructive-Confirmation': 'clear-database' }
        })
        if (res.ok) {
          alert("Datenbank erfolgreich geleert!")
          window.location.reload()
        } else {
          alert("Fehler beim Leeren der Datenbank.")
        }
      } catch (e) {
        console.error("Clear database failed", e)
        alert("Fehler beim Leeren der Datenbank.")
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
      downloadAnchorNode.setAttribute("download", `cb2_backup_${new Date().toISOString().slice(0, 10)}.json`)
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

    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const content = event.target?.result as string
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
      }
      
      // Reset input
      if (e.target) {
        e.target.value = ''
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="space-y-6">
      
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Download className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Backup & Restore</CardTitle>
          </div>
          <CardDescription>
            Export your current configuration to a file, or restore from a previous backup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted/50 rounded-lg border p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
              <h4 className="font-medium text-sm">Download Backup</h4>
              <p className="text-sm text-muted-foreground">Keep a secure backup of your configuration.</p>
            </div>
            <Button variant="outline" onClick={exportConfig}>
              Export Configuration
            </Button>
          </div>

          <div className="bg-muted/50 rounded-lg border p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
              <h4 className="font-medium text-sm">Restore from Backup</h4>
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
              <p className="text-sm text-muted-foreground">Completely erases your current configuration and restores the default blank state.</p>
            </div>
            <Button variant="outline" className="text-destructive border-destructive hover:bg-destructive/10" onClick={handleFactoryReset}>
              Perform Factory Reset
            </Button>
          </div>

          <div className="bg-muted/50 rounded-lg border p-4 flex flex-col sm:flex-row justify-between items-center gap-4">
            <div>
              <h4 className="font-medium text-sm text-destructive">Datenbank leeren</h4>
              <p className="text-sm text-muted-foreground">Löscht alle erfassten Nachrichten, extrahierten XML-Signale und Queue-Daten unwiderruflich aus der SQLite-Datenbank.</p>
            </div>
            <Button variant="outline" className="text-destructive border-destructive hover:bg-destructive/10" onClick={handleClearDatabase}>
              Datenbank leeren
            </Button>
          </div>
        </CardContent>
      </Card>

    </div>
  )
}
