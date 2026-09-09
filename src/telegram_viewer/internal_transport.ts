const TLS_PROTOCOL = 'https:';
const CLEARTEXT_PROTOCOL = 'http:';

function parsedServiceEndpoint(configured: string | undefined, variableName: string): URL {
  if (!configured?.trim()) throw new Error(`${variableName} must be configured.`);
  try {
    return new URL(configured);
  } catch {
    throw new Error(`${variableName} is invalid.`);
  }
}

function assertNoEndpointCredentials(endpoint: URL, variableName: string): void {
  if (endpoint.username || endpoint.password) {
    throw new Error(`${variableName} must not contain embedded credentials.`);
  }
}

function assertTrustedCleartextEndpoint(
  endpoint: URL, variableName: string, trustedCleartextHosts: readonly string[],
): void {
  if (endpoint.protocol !== CLEARTEXT_PROTOCOL) {
    throw new Error(`${variableName} protocol must be HTTPS or trusted internal HTTP.`);
  }
  const trustedHosts = new Set(trustedCleartextHosts.map(host => host.toLowerCase()));
  if (!trustedHosts.has(endpoint.hostname.toLowerCase())) {
    throw new Error(`${variableName} cleartext transport requires a trusted internal host.`);
  }
}

export function requireTrustedServiceUrl(
  configured: string | undefined,
  variableName: string,
  trustedCleartextHosts: readonly string[],
): string {
  const endpoint = parsedServiceEndpoint(configured, variableName);
  assertNoEndpointCredentials(endpoint, variableName);
  if (endpoint.protocol === TLS_PROTOCOL) return endpoint.toString();
  assertTrustedCleartextEndpoint(endpoint, variableName, trustedCleartextHosts);
  return endpoint.toString();
}
