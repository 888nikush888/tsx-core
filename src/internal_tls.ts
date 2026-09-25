import { createPrivateKey, X509Certificate } from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import { readBoundedTlsFile } from './bounded_tls_file.js';

const MAX_PEM_BYTES = 64 * 1024;

type TlsFileName =
  | 'DASHBOARD_TLS_CERT_FILE' | 'DASHBOARD_TLS_KEY_FILE'
  | 'METRICS_TLS_CERT_FILE' | 'METRICS_TLS_KEY_FILE'
  | 'ALERT_RELAY_TLS_CERT_FILE' | 'ALERT_RELAY_TLS_KEY_FILE'
  | 'TELEGRAM_VIEWER_TLS_CERT_FILE' | 'TELEGRAM_VIEWER_TLS_KEY_FILE';

function configuredTlsPath(name: TlsFileName): string | undefined {
  switch (name) {
    case 'DASHBOARD_TLS_CERT_FILE': return process.env.DASHBOARD_TLS_CERT_FILE;
    case 'DASHBOARD_TLS_KEY_FILE': return process.env.DASHBOARD_TLS_KEY_FILE;
    case 'METRICS_TLS_CERT_FILE': return process.env.METRICS_TLS_CERT_FILE;
    case 'METRICS_TLS_KEY_FILE': return process.env.METRICS_TLS_KEY_FILE;
    case 'ALERT_RELAY_TLS_CERT_FILE': return process.env.ALERT_RELAY_TLS_CERT_FILE;
    case 'ALERT_RELAY_TLS_KEY_FILE': return process.env.ALERT_RELAY_TLS_KEY_FILE;
    case 'TELEGRAM_VIEWER_TLS_CERT_FILE': return process.env.TELEGRAM_VIEWER_TLS_CERT_FILE;
    case 'TELEGRAM_VIEWER_TLS_KEY_FILE': return process.env.TELEGRAM_VIEWER_TLS_KEY_FILE;
    default: throw new Error('Unsupported internal TLS file name.');
  }
}

function pemFromEnvironment(name: TlsFileName): Buffer {
  const configured = configuredTlsPath(name)?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error(`${name} must name an absolute TLS file.`);
  const file = path.resolve(configured);
  return readBoundedTlsFile(file, MAX_PEM_BYTES, `${name} must name a regular, bounded TLS file.`);
}

export function internalTlsServerOptions(certName: TlsFileName, keyName: TlsFileName): https.ServerOptions {
  const cert = pemFromEnvironment(certName);
  const key = pemFromEnvironment(keyName);
  const certificate = new X509Certificate(cert);
  const now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error(`${certName} is not currently valid.`);
  }
  if (!certificate.checkPrivateKey(createPrivateKey(key))) {
    throw new Error(`${certName} and ${keyName} do not match.`);
  }
  const options: https.ServerOptions = { cert, key, minVersion: 'TLSv1.2' };
  tls.createSecureContext(options);
  return options;
}
