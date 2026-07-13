import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { KeyRound, Route } from "lucide-react"

export function ChannelsTab({ config, setConfig }: any) {
  if (!config) return null;

  return (
    <div className="space-y-6">
      
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <CardTitle>API Credentials</CardTitle>
          </div>
          <CardDescription>
            Your Telegram API ID and Hash. You can obtain these from my.telegram.org.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="apiId">API ID</Label>
            <Input 
              id="apiId" 
              type="number" 
              placeholder="e.g. 1234567"
              value={config.apiId || ''} 
              onChange={(e) => setConfig({ ...config, apiId: parseInt(e.target.value) || 0 })} 
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="apiHash">API Hash</Label>
            <Input 
              id="apiHash" 
              placeholder="e.g. abc123def456..."
              value={config.apiHash || ''} 
              onChange={(e) => setConfig({ ...config, apiHash: e.target.value })} 
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Route className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Routing Setup</CardTitle>
          </div>
          <CardDescription>
            Define where messages come from and where they should be forwarded.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="targetChannel">Target Channel</Label>
            <Input 
              id="targetChannel" 
              placeholder="-1001234567890 or @MyTargetChannel" 
              value={config.targetChannel || ''} 
              onChange={(e) => setConfig({ ...config, targetChannel: e.target.value })} 
            />
            <p className="text-sm text-muted-foreground">The master channel where all matching messages will be forwarded to.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sourceChannels">Source Channels (One per line)</Label>
            <Textarea 
              id="sourceChannels" 
              rows={6}
              className="font-mono text-sm"
              placeholder="-100987654321&#10;@SomeSourceChannel"
              value={(config.sourceChannels || []).join('\n')}
              onChange={(e) => setConfig({ 
                ...config, 
                sourceChannels: e.target.value.split('\n').map(s => s.trim()) 
              })} 
            />
            <p className="text-sm text-muted-foreground">Messages from these channels will be intercepted and checked against your filters.</p>
          </div>

          {(config.sourceChannels || []).length > 0 && (
            <div className="space-y-3 pt-4 border-t">
              <Label>Source Channel Nicknames (Aliases)</Label>
              <p className="text-sm text-muted-foreground">Assign optional nicknames to your channels for easier identification in logs.</p>
              <div className="space-y-2">
                {(config.sourceChannels || []).map((ch: string, idx: number) => (
                  <div key={`${ch}-${idx}`} className="flex items-center gap-3">
                    <div className="w-1/3 truncate font-mono text-sm px-3 py-2 bg-muted rounded-md border">
                      {ch}
                    </div>
                    <Input
                      className="w-2/3"
                      placeholder="e.g. VIP Signals Group"
                      value={config.sourceAliases?.[ch] || ''}
                      onChange={(e) => {
                        const newAliases = { ...(config.sourceAliases || {}) };
                        if (e.target.value.trim() === '') {
                          delete newAliases[ch];
                        } else {
                          newAliases[ch] = e.target.value;
                        }
                        setConfig({ ...config, sourceAliases: newAliases });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  )
}
