import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { KeyRound, Route } from "lucide-react"
import { apiFetch } from "@/lib/api"

export function ChannelsTab({
  config,
  setConfig,
  secretStatus,
  secretValue,
  setSecretValue,
  telegramLogin,
  setTelegramLogin,
}: any) {
  const [loginValue, setLoginValue] = useState("")
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [loginSubmitting, setLoginSubmitting] = useState(false)
  const [loginError, setLoginError] = useState("")
  if (!config) return null;

  const submitTelegramLogin = async () => {
    setLoginSubmitting(true)
    setLoginError("")
    try {
      const body = telegramLogin.prompt?.kind === "name"
        ? { firstName, lastName }
        : { value: loginValue }
      const response = await apiFetch("/api/telegram-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || "Telegram login response was rejected.")
      setTelegramLogin(result.telegramLogin)
      setLoginValue("")
      setFirstName("")
      setLastName("")
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Telegram login failed.")
    } finally {
      setLoginSubmitting(false)
    }
  }

  const secretLabel = secretStatus?.configured
    ? secretStatus.source === "external" ? "Managed by the deployment environment" : "Stored securely"
    : "Required before first connection"

  return (
    <div className="space-y-6">
      
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <CardTitle>API Credentials</CardTitle>
          </div>
          <CardDescription>
            Enter your Telegram app credentials. Secret values are write-only and stored outside the configuration file.
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
              onChange={(e) => setConfig({ ...config, apiId: Number.parseInt(e.target.value, 10) || 0 })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="apiHash">API Hash · {secretLabel}</Label>
            <Input
              id="apiHash"
              type="password"
              autoComplete="off"
              placeholder={secretStatus?.configured ? "Leave blank to keep the saved value" : "32-character API hash"}
              value={secretValue}
              disabled={secretStatus?.editable === false}
              onChange={(event) => setSecretValue(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">The current value is never returned to the browser. Use Save Configuration to apply a replacement.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Telegram account login</CardTitle>
          <CardDescription>Start the forwarder, then complete any Telegram verification request here. Codes and passwords remain only in memory for the active request.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border p-3 text-sm">
            Status: <span className="font-medium">{telegramLogin?.state || "idle"}</span>
          </div>
          {telegramLogin?.state === "waiting" && telegramLogin.prompt?.kind === "otherDeviceConfirmation" && (
            <div className="space-y-3">
              <p className="text-sm">{telegramLogin.prompt.hint}</p>
              <Button asChild><a href={telegramLogin.prompt.link}>Open Telegram confirmation</a></Button>
            </div>
          )}
          {telegramLogin?.state === "waiting" && telegramLogin.prompt?.kind !== "otherDeviceConfirmation" && (
            <div className="space-y-3">
              <Label>{telegramLogin.prompt.label}{telegramLogin.prompt.retry ? " · previous value was rejected" : ""}</Label>
              {telegramLogin.prompt.kind === "name" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input placeholder="First name" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
                  <Input placeholder="Last name (optional)" value={lastName} onChange={(event) => setLastName(event.target.value)} />
                </div>
              ) : (
                <Input
                  type={telegramLogin.prompt.kind === "password" ? "password" : "text"}
                  autoComplete="off"
                  placeholder={telegramLogin.prompt.hint || telegramLogin.prompt.label}
                  value={loginValue}
                  onChange={(event) => setLoginValue(event.target.value)}
                />
              )}
              <Button disabled={loginSubmitting} onClick={submitTelegramLogin}>
                {loginSubmitting ? "Submitting…" : "Continue Telegram login"}
              </Button>
            </div>
          )}
          {(loginError || telegramLogin?.error) && <p role="alert" className="text-sm text-destructive">{loginError || telegramLogin.error}</p>}
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
                        const newAliases = { ...config.sourceAliases };
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
