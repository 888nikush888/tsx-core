import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { apiFetch, clearDashboardToken, getDashboardToken, onDashboardAuthRequired, setDashboardToken } from '@/lib/api'

type AuthState = 'checking' | 'locked' | 'authenticated'

export function DashboardAuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('checking')
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const validateStoredToken = async () => {
    if (!getDashboardToken()) {
      setState('locked')
      return
    }
    try {
      const response = await apiFetch('/api/status')
      if (!response.ok) throw new Error(response.status === 503 ? 'Dashboard authentication is not configured on the server.' : 'The saved token is no longer valid.')
      setState('authenticated')
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

  if (state === 'checking') {
    return <div className="min-h-screen grid place-items-center text-sm text-muted-foreground">Checking dashboard access…</div>
  }

  if (state === 'locked') {
    return (
      <main className="min-h-screen grid place-items-center bg-background p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Dashboard authentication</CardTitle>
            <CardDescription>Enter the administrator or read-only bearer token configured on the server.</CardDescription>
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
