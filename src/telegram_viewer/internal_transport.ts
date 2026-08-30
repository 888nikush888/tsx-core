const TLS_PROTOCOL = 'https:';
const CLEARTEXT_PROTOCOL = 'http:';

export function requireTrustedServiceUrl(
  configured: string | undefined,
  variableName: string,
  trustedCleartextHosts: readonly string[],
): string {
  if (!configured?.trim()) throw new Error(`${variableName} must be configured.`);

  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    throw new Error(`${variableName} is invalid.`);
  }

  if (endpoint.username || endpoint.password) {
    throw new Error(`${variableName} must not contain embedded credentials.`);
  }
  if (endpoint.protocol === TLS_PROTOCOL) return endpoint.toString();
  if (endpoint.protocol !== CLEARTEXT_PROTOCOL) {
    throw new Error(`${variableName} protocol must be HTTPS or trusted internal HTTP.`);
  }

  const trustedHosts = new Set(trustedCleartextHosts.map(host => host.toLowerCase()));
  if (!trustedHosts.has(endpoint.hostname.toLowerCase())) {
    throw new Error(`${variableName} cleartext transport requires a trusted internal host.`);
  }
  return endpoint.toString();
}
