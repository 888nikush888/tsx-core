import http from 'node:http';
import { constantTimeStringEqual } from '../secure_compare.js';

type TokenProvider = string | (() => string | Promise<string>);

function send(response: http.ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(payload));
}

async function expectedToken(provider: TokenProvider): Promise<string> {
  return typeof provider === 'function' ? await provider() : provider;
}

const HEALTH_PATHS: ReadonlySet<string> = new Set(['/healthz', '/health']);
const READINESS_PATHS: ReadonlySet<string> = new Set(['/readyz', '/ready']);

function serveHealthProbe(response: http.ServerResponse, status: Record<string, unknown>): void {
  send(response, status.healthy === false ? 503 : 200, { healthy: status.healthy !== false });
}

function serveReadinessProbe(response: http.ServerResponse, status: Record<string, unknown>): void {
  send(response, status.ready === true ? 200 : 503, { ready: status.ready === true });
}

function viewerRequestPathname(request: http.IncomingMessage): string {
  return new URL(request.url || '/', 'https://viewer.local').pathname;
}

async function serveViewerStatus(
  response: http.ServerResponse,
  status: Record<string, unknown>,
  serviceToken: TokenProvider,
  authorization: unknown,
): Promise<void> {
  const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(String(authorization || ''));
  const expected = await expectedToken(serviceToken);
  if (!constantTimeStringEqual(expected, match?.[1])) {
    response.setHeader('WWW-Authenticate', 'Bearer realm="tsx-telegram-viewer"');
    send(response, 401, { error: 'Authentication required.' });
    return;
  }
  send(response, 200, status);
}

export function startTelegramViewerHealthServer(options: {
  host?: string;
  port?: number;
  serviceToken: TokenProvider;
  status: () => Record<string, unknown>;
}): http.Server {
  const server = http.createServer((request, response) => {
    (async () => {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        send(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const pathname = viewerRequestPathname(request);
      const status = options.status();
      if (HEALTH_PATHS.has(pathname)) {
        serveHealthProbe(response, status);
        return;
      }
      if (READINESS_PATHS.has(pathname)) {
        serveReadinessProbe(response, status);
        return;
      }
      if (pathname === '/status') {
        await serveViewerStatus(response, status, options.serviceToken, request.headers.authorization);
        return;
      }
      send(response, 404, { error: 'Not found.' });
    })().catch(() => send(response, 500, { error: 'Viewer health request failed.' }));
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.listen(options.port ?? 8081, options.host ?? '127.0.0.1');
  return server;
}
