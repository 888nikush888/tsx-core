const TOKEN_KEY = "forwarder-dashboard-token";
const AUTH_REQUIRED_EVENT = "forwarder-dashboard-auth-required";

export function getDashboardToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export function setDashboardToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearDashboardToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  // Normalize once before adding credentials; fetch must consume this same destination.
  const request = new Request(
    typeof input === "string" ? new URL(input, document.baseURI).href : input,
    init,
  );
  const target = new URL(request.url);
  if (target.origin !== window.location.origin || target.username || target.password) {
    throw new Error("API requests are restricted to this dashboard.");
  }
  const headers = new Headers(request.headers);
  const token = getDashboardToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Requested-With", "forwarder-dashboard");
  }

  const response = await fetch(request, { headers, redirect: "error" });
  // An old in-flight read must not invalidate a newly rotated credential.
  if (response.status === 401 && token === getDashboardToken()) {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
  }
  return response;
}

export async function jsonRequest(url: string, init?: RequestInit) {
  const response = await apiFetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(response.status, payload.error || `Anfrage fehlgeschlagen (${response.status}).`, payload.requestId);
  return payload;
}

export class ApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  constructor(status: number, message: string, requestId?: string) {
    super(message);
    this.status = status;
    this.requestId = requestId;
  }
}

/** A confirmed write remains successful when the following observation fails. Never retries writes. */
export async function mutateAndObserve<T>(
  operation: () => Promise<T>,
  accepted: (result: T) => void,
  observe: () => Promise<unknown>,
): Promise<{ result: T; refreshError: string | null }> {
  const result = await operation();
  accepted(result);
  try {
    await observe();
    return { result, refreshError: null };
  } catch (error) {
    return { result, refreshError: error instanceof Error ? error.message : String(error) };
  }
}

export function onDashboardAuthRequired(listener: () => void): () => void {
  window.addEventListener(AUTH_REQUIRED_EVENT, listener);
  return () => window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
}
