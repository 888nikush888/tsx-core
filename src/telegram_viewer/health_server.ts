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

export function startTelegramViewerHealthServer(options: {
  host?: string;
  port?: number;
  serviceToken: TokenProvider;
  status: () => Record<string, unknown>;
}): http.Server {
  const server = http.createServer((request, response) => {
    void (async () => {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        send(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const pathname = new URL(request.url || '/', 'http://viewer.local').pathname;
      const status = options.status();
      if (pathname === '/healthz' || pathname === '/health') {
        send(response, status.healthy === false ? 503 : 200, { healthy: status.healthy !== false });
        return;
      }
      if (pathname === '/readyz' || pathname === '/ready') {
        send(response, status.ready === true ? 200 : 503, { ready: status.ready === true });
        return;
      }
      if (pathname === '/status') {
        const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(String(request.headers.authorization || ''));
        const expected = await expectedToken(options.serviceToken);
        if (!constantTimeStringEqual(expected, match?.[1])) {
          response.setHeader('WWW-Authenticate', 'Bearer realm="tsx-telegram-viewer"');
          send(response, 401, { error: 'Authentication required.' });
          return;
        }
        send(response, 200, status);
        return;
      }
      send(response, 404, { error: 'Not found.' });
    })().catch(() => send(response, 500, { error: 'Viewer health request failed.' }));
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.listen(options.port ?? 8081, options.host ?? '0.0.0.0');
  return server;
}
