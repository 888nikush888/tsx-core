const TOKEN_KEY = 'forwarder-dashboard-token'
const AUTH_REQUIRED_EVENT = 'forwarder-dashboard-auth-required'

export function getDashboardToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) || ''
}

export function setDashboardToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim())
}

export function clearDashboardToken(): void {
  sessionStorage.removeItem(TOKEN_KEY)
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = getDashboardToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const method = (init.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('X-Requested-With', 'forwarder-dashboard')
  }

  const response = await fetch(input, { ...init, headers })
  if (response.status === 401 || response.status === 503) {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
  }
  return response
}

export function onDashboardAuthRequired(listener: () => void): () => void {
  window.addEventListener(AUTH_REQUIRED_EVENT, listener)
  return () => window.removeEventListener(AUTH_REQUIRED_EVENT, listener)
}
