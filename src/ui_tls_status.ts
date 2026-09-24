import { createHash, X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

const MAX_CERTIFICATE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 1200;
const PROBE_CACHE_MS = 5000;
const MIN_CA_VALIDITY_MS = 60 * 60 * 1000;

type CertificateDetails = { fingerprint256: string; subjectAltName: string | null; expiresAt: string };
type FileState = 'available' | 'not_configured' | 'not_visible' | 'missing' | 'invalid' | 'expired' | 'not_yet_valid' | 'expiring_soon';
type ActiveState = 'observed' | 'unreachable' | 'untrusted' | 'not_checked';
type ActiveObservation = { state: ActiveState; certificate: CertificateDetails | null; checkedAt: number | null };
type ProbeCacheEntry = { identity: string; expiresAt: number; pending: boolean; promise: Promise<ActiveObservation> };
const probeCache = new Map<string, ProbeCacheEntry>();
type CertificateEnvironment = 'DASHBOARD_TLS_CERT_FILE' | 'METRICS_TLS_CERT_FILE'
  | 'ALERT_RELAY_TLS_CERT_FILE' | 'TELEGRAM_VIEWER_TLS_CERT_FILE' | 'EXECUTOR_TLS_CERT_FILE';
type CertificateFileEnvironment = CertificateEnvironment | 'NODE_EXTRA_CA_CERTS';

type Endpoint = {
  id: string;
  label: string;
  certificateEnvironment: CertificateEnvironment;
  localFile: boolean;
  host?: string;
  port?: number;
};

const ENDPOINTS: readonly Endpoint[] = [
  { id: 'dashboard', label: 'Dashboard', certificateEnvironment: 'DASHBOARD_TLS_CERT_FILE', localFile: true },
  { id: 'metrics', label: 'Messwerte', certificateEnvironment: 'METRICS_TLS_CERT_FILE', localFile: true, host: '127.0.0.1', port: 9100 },
  { id: 'alert-relay', label: 'Alarmweiterleitung', certificateEnvironment: 'ALERT_RELAY_TLS_CERT_FILE', localFile: false, host: 'alert-relay', port: 9095 },
  { id: 'telegram-viewer', label: 'Viewer-Status', certificateEnvironment: 'TELEGRAM_VIEWER_TLS_CERT_FILE', localFile: false, host: 'telegram-viewer', port: 8081 },
  { id: 'exchange-executor', label: 'Exchange Executor', certificateEnvironment: 'EXECUTOR_TLS_CERT_FILE', localFile: false, host: 'exchange-executor', port: 8090 },
];

function configuredCertificateFile(environmentName: CertificateFileEnvironment): string | undefined {
  switch (environmentName) {
    case 'DASHBOARD_TLS_CERT_FILE': return process.env.DASHBOARD_TLS_CERT_FILE;
    case 'METRICS_TLS_CERT_FILE': return process.env.METRICS_TLS_CERT_FILE;
    case 'ALERT_RELAY_TLS_CERT_FILE': return process.env.ALERT_RELAY_TLS_CERT_FILE;
    case 'TELEGRAM_VIEWER_TLS_CERT_FILE': return process.env.TELEGRAM_VIEWER_TLS_CERT_FILE;
    case 'EXECUTOR_TLS_CERT_FILE': return process.env.EXECUTOR_TLS_CERT_FILE;
    case 'NODE_EXTRA_CA_CERTS': return process.env.NODE_EXTRA_CA_CERTS;
  }
}

function readFixedCertificateFile(environmentName: CertificateFileEnvironment): Buffer {
  const configured = configuredCertificateFile(environmentName)?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error('not_configured');
  const file = path.resolve(configured);
  let metadata;
  try { metadata = lstatSync(file); }
  catch { throw new Error('missing'); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_CERTIFICATE_BYTES
    || realpathSync.native(file) !== file) throw new Error('invalid');
  return readFileSync(file);
}

function details(certificate: X509Certificate): CertificateDetails {
  const expiry = Date.parse(certificate.validTo);
  if (!Number.isFinite(expiry)) throw new Error('invalid');
  return {
    fingerprint256: certificate.fingerprint256,
    subjectAltName: certificate.subjectAltName?.slice(0, 2048) || null,
    expiresAt: new Date(expiry).toISOString(),
  };
}

function inspectedFile(environmentName: CertificateEnvironment, absentState: FileState, expectAuthority = false) {
  if (!configuredCertificateFile(environmentName)) return { state: absentState, certificate: null };
  try {
    const certificate = new X509Certificate(readFixedCertificateFile(environmentName));
    if (certificate.ca !== expectAuthority) throw new Error('invalid');
    const inspection = details(certificate);
    const now = Date.now();
    const state = Date.parse(inspection.expiresAt) <= now ? 'expired'
      : Date.parse(certificate.validFrom) > now ? 'not_yet_valid' : 'available';
    return { state, certificate: inspection };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    return { state: reason === 'missing' ? 'missing' : reason === 'not_configured' ? 'not_configured' : 'invalid', certificate: null };
  }
}

function parseCaBundle(pem: Buffer): X509Certificate[] {
  const content = pem.toString('utf8');
  if (content.includes('PRIVATE KEY')) throw new Error('invalid');
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const blocks = [...content.matchAll(pattern)];
  if (blocks.length < 1 || blocks.length > 10 || content.replace(pattern, '').trim()) throw new Error('invalid');
  const parsed = blocks.map(block => new X509Certificate(block[0]));
  if (parsed.some(certificate => !certificate.ca)) throw new Error('invalid');
  return parsed;
}

function caValidity(parsed: X509Certificate[], certificates: CertificateDetails[]): FileState {
  const now = Date.now();
  const starts = parsed.map(certificate => Date.parse(certificate.validFrom));
  const expiries = certificates.map(certificate => Date.parse(certificate.expiresAt));
  if (starts.some(value => !Number.isFinite(value))) return 'invalid';
  if (expiries.some(value => value <= now)) return 'expired';
  if (starts.some(value => value > now)) return 'not_yet_valid';
  if (expiries.some(value => value <= now + MIN_CA_VALIDITY_MS)) return 'expiring_soon';
  return 'available';
}

function trustAnchor() {
  const environmentName = 'NODE_EXTRA_CA_CERTS';
  if (!configuredCertificateFile(environmentName)) return { state: 'not_configured', certificates: [], earliestExpiryAt: null, pem: null };
  try {
    const pem = readFixedCertificateFile(environmentName);
    const parsed = parseCaBundle(pem);
    const certificates = parsed.map(details);
    const state = caValidity(parsed, certificates);
    const earliestExpiryAt = new Date(Math.min(...certificates.map(certificate => Date.parse(certificate.expiresAt)))).toISOString();
    return { state, certificates, earliestExpiryAt, pem: state === 'available' ? pem : null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    return { state: reason === 'missing' ? 'missing' : reason === 'not_configured' ? 'not_configured' : 'invalid',
      certificates: [], earliestExpiryAt: null, pem: null };
  }
}

function probe(host: string, port: number, ca: Buffer): Promise<ActiveObservation> {
  return new Promise(resolve => {
    let settled = false;
    let socket: tls.TLSSocket;
    const finish = (state: ActiveState, certificate: CertificateDetails | null = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ state, certificate, checkedAt: Date.now() });
    };
    try {
      socket = tls.connect({ host, port, ca, rejectUnauthorized: true,
        servername: host === '127.0.0.1' ? undefined : host,
        checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(host, certificate),
      });
    } catch { resolve({ state: 'untrusted', certificate: null, checkedAt: Date.now() }); return; }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => { finish('unreachable'); });
    socket.once('error', error => {
      finish(/CERT|TLS|SSL|VERIFY|SIGNATURE/.test((error as NodeJS.ErrnoException).code || '')
        ? 'untrusted' : 'unreachable');
    });
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerX509Certificate();
        finish(peer ? 'observed' : 'untrusted', peer ? details(peer) : null);
      } catch { finish('untrusted'); }
    });
  });
}

function cachedProbe(endpointId: string, host: string, port: number, ca: Buffer): Promise<ActiveObservation> {
  const identity = `${host}:${port}:${createHash('sha256').update(ca).digest('hex')}`;
  const previous = probeCache.get(endpointId);
  if (previous?.identity === identity && (previous.pending || previous.expiresAt > Date.now())) return previous.promise;
  if (previous?.pending) return Promise.resolve({ state: 'not_checked', certificate: null, checkedAt: null });
  const entry: ProbeCacheEntry = { identity, expiresAt: 0, pending: true, promise: probe(host, port, ca) };
  entry.promise = entry.promise.catch(() => ({ state: 'unreachable' as const, certificate: null, checkedAt: Date.now() }))
    .then(observation => { entry.pending = false; entry.expiresAt = Date.now() + PROBE_CACHE_MS; return observation; });
  probeCache.set(endpointId, entry);
  return entry.promise;
}

function metricsPort() {
  const configured = process.env.METRICS_PORT;
  const number = configured === undefined ? 9100 : Number(configured);
  return Number.isInteger(number) && number >= 1 && number <= 65535 ? number : null;
}

/** Fixed allowlist only. This read never returns certificate material, key material or configured file paths. */
export async function uiTlsStatus(activeDashboardCertificate?: Buffer) {
  const ca = trustAnchor();
  const endpoints = await Promise.all(ENDPOINTS.map(async endpoint => {
    const file = inspectedFile(endpoint.certificateEnvironment, endpoint.localFile ? 'not_configured' : 'not_visible');
    let active: ActiveObservation = { state: 'not_checked', certificate: null, checkedAt: null };
    if (endpoint.id === 'dashboard' && activeDashboardCertificate) {
      try { active = { state: 'observed', certificate: details(new X509Certificate(activeDashboardCertificate)), checkedAt: Date.now() }; }
      catch { active = { state: 'not_checked', certificate: null, checkedAt: null }; }
    } else if (endpoint.host && ca.pem) {
      const port = endpoint.id === 'metrics' ? metricsPort() : endpoint.port;
      if (port) active = await cachedProbe(endpoint.id, endpoint.host, port, ca.pem);
    }
    return {
      id: endpoint.id, label: endpoint.label, file,
      active,
      activeMatchesFile: active.certificate && file.certificate
        ? active.certificate.fingerprint256 === file.certificate.fingerprint256 : null,
    };
  }));
  return {
    trustAnchor: { state: ca.state, certificates: ca.certificates, earliestExpiryAt: ca.earliestExpiryAt },
    endpoints,
    interpretation: 'Aktiv bedeutet TLS-Handshake dieser Anfrage oder einen höchstens fünf Sekunden gecachten, CA-verifizierten Kurztest. Nicht erreichbare Dienste und im Dashboard-Container nicht sichtbare Dateien bleiben unbekannt. Ein Dateifingerabdruck beweist keinen aktiven Listener.',
  };
}
