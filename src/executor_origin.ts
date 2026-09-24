const INTERNAL_EXECUTOR_HOSTS = new Set([
  '127.0.0.1',
  '[::1]',
  '::1',
  'exchange-executor',
  'localhost',
]);

const DEFAULT_EXECUTOR_ORIGIN = 'https://exchange-executor:8090';

function assertPlainInternalHttpsShape(parsed: URL): void {
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('EXCHANGE_EXECUTOR_URL must be a plain internal HTTPS origin.');
  }
}

function assertNoOriginCredentials(parsed: URL): void {
  if (parsed.username || parsed.password) {
    throw new Error('EXCHANGE_EXECUTOR_URL must be a plain internal HTTPS origin.');
  }
}

export function internalExecutorOrigin(value?: string): string {
  const parsed = new URL(value?.trim() || DEFAULT_EXECUTOR_ORIGIN);
  assertPlainInternalHttpsShape(parsed);
  assertNoOriginCredentials(parsed);
  if (!INTERNAL_EXECUTOR_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('EXCHANGE_EXECUTOR_URL must use an approved internal executor host.');
  }
  if (parsed.hostname.toLowerCase() === 'exchange-executor' && parsed.port !== '8090') {
    throw new Error('EXCHANGE_EXECUTOR_URL must use the dedicated executor port.');
  }
  return parsed.origin;
}
