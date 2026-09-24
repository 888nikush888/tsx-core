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

export function requireTrustedServiceUrl(
  configured: string | undefined,
  variableName: string,
  trustedHosts: readonly string[],
): string {
  const endpoint = parsedServiceEndpoint(configured, variableName);
  assertNoEndpointCredentials(endpoint, variableName);
  if (endpoint.protocol !== 'https:' || endpoint.search || endpoint.hash) {
    throw new Error(`${variableName} must use HTTPS without query or fragment.`);
  }
  if (!new Set(trustedHosts.map(host => host.toLowerCase())).has(endpoint.hostname.toLowerCase())) {
    throw new Error(`${variableName} must use an approved internal host.`);
  }
  return endpoint.toString();
}
