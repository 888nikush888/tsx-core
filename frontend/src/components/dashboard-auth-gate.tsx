import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Logo } from '@/components/logo'
import { apiFetch, clearDashboardToken, getDashboardToken, onDashboardAuthRequired, setDashboardToken } from '@/lib/api'

type AuthState = 'checking' | 'bootstrap' | 'recovery' | 'locked' | 'authenticated'

interface AccessInspection {
  state: AuthState
  recoveryToken?: string
  error?: string
}

interface BootstrapInspection {
  required?: boolean
  available?: boolean
  localSessionAvailable?: boolean
  recoveryBootstrap?: boolean
}

async function createLocalSession(): Promise<AccessInspection | null> {
  const response = await apiFetch('/api/local-session', { method: 'POST' })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || typeof payload.token !== 'string') {
    if (response.status === 403 || response.status === 409) return null
    throw new Error(payload.error || 'Local dashboard access could not be initialized.')
  }
  setDashboardToken(payload.token)
  if (payload.generatedAdminToken === true) {
    return { state: 'recovery', recoveryToken: payload.token }
  }
  return { state: 'authenticated' }
}

async function inspectConfiguredAccess(bootstrap: BootstrapInspection): Promise<AccessInspection> {
  if (getDashboardToken()) {
    const response = await apiFetch('/api/status')
    if (response.ok) return { state: 'authenticated' }
    clearDashboardToken()
  }
  const proxyIdentityResponse = await apiFetch('/api/status')
  if (proxyIdentityResponse.ok) return { state: 'authenticated' }
  if (bootstrap.localSessionAvailable) {
    const localSession = await createLocalSession()
    if (localSession) return localSession
  }
  return {
    state: 'locked',
    error: 'Für den Remote-Zugriff ist ein gültiger Bearer-Token oder eine konfigurierte Identität erforderlich.',
  }
}

async function inspectFirstAccess(bootstrap: BootstrapInspection): Promise<AccessInspection> {
  if (bootstrap.localSessionAvailable || bootstrap.recoveryBootstrap) {
    const localSession = await createLocalSession()
    if (localSession) return localSession
  }
  return {
    state: bootstrap.available ? 'bootstrap' : 'locked',
    error: bootstrap.available ? '' : 'Managed secret storage is unavailable on the server.',
  }
}

async function inspectDashboardAccess(): Promise<AccessInspection> {
  const bootstrapResponse = await apiFetch('/api/bootstrap/status')
  const bootstrap: BootstrapInspection & { error?: string } = await bootstrapResponse.json().catch(() => ({}))
  if (!bootstrapResponse.ok) throw new Error(bootstrap.error || 'Could not inspect dashboard setup.')
  return bootstrap.required
    ? inspectFirstAccess(bootstrap)
    : inspectConfiguredAccess(bootstrap)
}

export function DashboardAuthGate({ children }: Readonly<{ children: ReactNode }>) {
  const [state, setState] = useState<AuthState>('checking')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [recoveryToken, setRecoveryToken] = useState('')

  const brand = <Logo variant="full" size={46} className="mb-3" />

  const validateStoredToken = async () => {
    try {
      const inspection = await inspectDashboardAccess()
      setRecoveryToken(inspection.recoveryToken || '')
      setError(inspection.error || '')
      setState(inspection.state)
    } catch (authError) {
      clearDashboardToken()
      setError(authError instanceof Error ? authError.message : 'Authentication failed.')
      setState('locked')
    }
  }

  useEffect(() => {
    validateStoredToken()
    return onDashboardAuthRequired(() => {
      clearDashboardToken()
      setState('locked')
    })
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setDashboardToken(token)
    try {
      const response = await apiFetch('/api/status')
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Authentication failed.')
      setToken('')
      setState('authenticated')
    } catch (authError) {
      clearDashboardToken()
      setError(authError instanceof Error ? authError.message : 'Authentication failed.')
    } finally {
      setSubmitting(false)
    }
  }

  const bootstrapDashboard = async () => {
    setSubmitting(true)
    setError('')
    try {
      const response = await apiFetch('/api/bootstrap', { method: 'POST' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok || typeof payload.token !== 'string') {
        throw new Error(payload.error || 'Dashboard setup failed.')
      }
      setDashboardToken(payload.token)
      setRecoveryToken(payload.token)
      setState('recovery')
    } catch (bootstrapError) {
      setError(bootstrapError instanceof Error ? bootstrapError.message : 'Dashboard setup failed.')
    } finally {
      setSubmitting(false)
    }
  }

  if (state === 'checking') {
    return <div className="min-h-screen grid place-items-center text-sm text-muted-foreground">Checking dashboard access…</div>
  }

  if (state === 'bootstrap') {
    return (
      <main className="min-h-screen grid place-items-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            {brand}
            <CardTitle role="heading" aria-level={1}>Secure your dashboard</CardTitle>
            <CardDescription>Create the first administrator access token. It is generated by the server and stored in Docker's persistent secret volume.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">No Telegram or AI credentials are needed before this step.</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" disabled={submitting} onClick={bootstrapDashboard}>
              {submitting ? 'Securing dashboard…' : 'Create secure dashboard'}
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (state === 'recovery') {
    return (
      <main className="min-h-screen grid place-items-center bg-background p-6">
        <Card className="w-full max-w-xl">
          <CardHeader>
            {brand}
            <CardTitle role="heading" aria-level={1}>Save your recovery token</CardTitle>
            <CardDescription>This token is shown once. Docker also keeps it in the persistent secret volume and this browser keeps it only for the current session.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="break-all rounded-md border bg-muted p-3 font-mono text-sm" data-testid="recovery-token">{recoveryToken}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="outline" onClick={() => navigator.clipboard.writeText(recoveryToken)}>Copy token</Button>
              <Button onClick={() => { setRecoveryToken(''); setState('authenticated') }}>I saved it — continue</Button>
            </div>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (state === 'locked') {
    return (
      <main className="min-h-screen grid place-items-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            {brand}
            <CardTitle role="heading" aria-level={1}>Dashboard authentication</CardTitle>
            <CardDescription>Enter a local dashboard token or an OIDC access token. An authenticated reverse proxy can grant access without storing a token in the browser.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-2">
                <Label htmlFor="dashboard-token">Bearer token</Label>
                <Input id="dashboard-token" type="password" autoComplete="off" minLength={32} required value={token} onChange={(event) => setToken(event.target.value)} />
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <Button className="w-full" disabled={submitting || token.trim().length < 32} type="submit">
                {submitting ? 'Authenticating…' : 'Unlock dashboard'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    )
  }

  return children
}
