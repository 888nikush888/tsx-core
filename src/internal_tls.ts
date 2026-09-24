import { createPrivateKey, X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';

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
  }
}

function pemFromEnvironment(name: TlsFileName): Buffer {
  const configured = configuredTlsPath(name)?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error(`${name} must name an absolute TLS file.`);
  const file = path.resolve(configured);
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || realpathSync.native(file) !== file) {
    throw new Error(`${name} must name a regular, bounded TLS file.`);
  }
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_PEM_BYTES
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${name} must name a regular, bounded TLS file.`);
    }
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(descriptor, content, offset, content.length - offset, null);
      if (count === 0) throw new Error(`${name} changed while reading the TLS file.`);
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) {
      throw new Error(`${name} changed while reading the TLS file.`);
    }
    const after = fstatSync(descriptor);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${name} changed while reading the TLS file.`);
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
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
