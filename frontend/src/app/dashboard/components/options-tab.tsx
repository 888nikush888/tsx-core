import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ShieldAlert, Zap, Settings2 } from "lucide-react"

export function OptionsTab({ config, setConfig }: any) {
  if (!config || !config.forwardOptions) return null;

  const handleOptionChange = (key: string, value: any) => {
    setConfig({
      ...config,
      forwardOptions: {
        ...config.forwardOptions,
        [key]: value
      }
    })
  }

  const handleDupeChange = (key: string, value: any) => {
    setConfig({
      ...config,
      dupeBlocker: {
        ...(config.dupeBlocker || {}),
        [key]: value
      }
    })
  }

  return (
    <div className="space-y-6">
      
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Forwarding Behavior</CardTitle>
          </div>
          <CardDescription>
            Configure how messages look and behave when they arrive in the target channel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm">
            <div className="space-y-0.5">
              <Label className="text-base">Forward to Target</Label>
              <p className="text-sm text-muted-foreground">Master switch for forwarding messages</p>
            </div>
            <Switch 
              checked={config.forwardOptions.forwardToTarget ?? true} 
              onCheckedChange={(c) => handleOptionChange("forwardToTarget", c)} 
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm">
            <div className="space-y-0.5">
              <Label className="text-base">Send as Copy</Label>
              <p className="text-sm text-muted-foreground">Sends messages as fresh copies rather than native Telegram forwards. Hides the original sender.</p>
            </div>
            <Switch 
              checked={config.forwardOptions.sendCopy ?? false} 
              onCheckedChange={(c) => handleOptionChange("sendCopy", c)} 
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm">
            <div className="space-y-0.5">
              <Label className="text-base">Remove Caption</Label>
              <p className="text-sm text-muted-foreground">Strips captions from media messages (images, videos).</p>
            </div>
            <Switch 
              checked={config.forwardOptions.removeCaption ?? false} 
              onCheckedChange={(c) => handleOptionChange("removeCaption", c)} 
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Performance & Queueing</CardTitle>
          </div>
          <CardDescription>
            Fine-tune the async worker queue to avoid Telegram Rate Limits.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="maxConcurrency">Max Concurrency</Label>
            <Input 
              id="maxConcurrency" 
              type="number" 
              min={1}
              max={100}
              value={config.forwardOptions.maxConcurrency ?? 2} 
              onChange={(e) => handleOptionChange("maxConcurrency", parseInt(e.target.value) || 1)} 
            />
            <p className="text-sm text-muted-foreground">How many messages to process simultaneously.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="queueTimeoutSeconds">Queue Timeout (Seconds)</Label>
            <Input 
              id="queueTimeoutSeconds" 
              type="number" 
              min={0}
              max={86400}
              value={config.forwardOptions.queueTimeoutSeconds ?? 60} 
              onChange={(e) => handleOptionChange("queueTimeoutSeconds", parseInt(e.target.value) || 60)} 
            />
            <p className="text-sm text-muted-foreground">Max time a message can sit in the processing queue.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Duplicate Blocker</CardTitle>
          </div>
          <CardDescription>
            Protects your target channel from repeated identical signals and spam.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm">
            <div className="space-y-0.5">
              <Label className="text-base">Enable Duplicate Blocker</Label>
              <p className="text-sm text-muted-foreground">Hashes incoming messages and drops identical ones.</p>
            </div>
            <Switch 
              checked={config.dupeBlocker?.enabled || false} 
              onCheckedChange={(c) => handleDupeChange("enabled", c)} 
            />
          </div>

          {config.dupeBlocker?.enabled && (
            <div className="space-y-2 pt-2">
              <Label htmlFor="cooldownHours">Cooldown Period (Hours)</Label>
              <Input 
                id="cooldownHours" 
                type="number" 
                className="max-w-[200px]"
                min={0}
                value={config.dupeBlocker.cooldownHours ?? 24} 
                onChange={(e) => handleDupeChange("cooldownHours", parseFloat(e.target.value) || 0)} 
              />
              <p className="text-sm text-muted-foreground">Time before a duplicate message is allowed again.</p>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}
