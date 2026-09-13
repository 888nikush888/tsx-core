const INTERNAL_EXECUTOR_HOSTS = new Set([
  '127.0.0.1',
  '[::1]',
  '::1',
  'exchange-executor',
  'localhost',
]);

const DEFAULT_EXECUTOR_ORIGIN = 'http://exchange-executor:8090'; // NOSONAR: HTTP is restricted below to loopback or the private Compose service name.

function assertPlainInternalHttpShape(parsed: URL): void {
  if (parsed.protocol !== 'http:' || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('EXCHANGE_EXECUTOR_URL must be a plain internal HTTP origin.');
  }
}

function assertNoOriginCredentials(parsed: URL): void {
  if (parsed.username || parsed.password) {
    throw new Error('EXCHANGE_EXECUTOR_URL must be a plain internal HTTP origin.');
  }
}

export function internalExecutorOrigin(value?: string): string {
  const parsed = new URL(value?.trim() || DEFAULT_EXECUTOR_ORIGIN);
  assertPlainInternalHttpShape(parsed);
  assertNoOriginCredentials(parsed);
  if (!INTERNAL_EXECUTOR_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('EXCHANGE_EXECUTOR_URL must use an approved internal executor host.');
  }
  return parsed.origin;
}
