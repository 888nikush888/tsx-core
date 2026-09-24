import { createPrivateKey, X509Certificate } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';

const MAX_PEM_BYTES = 64 * 1024;

function pemFromEnvironment(name: string): Buffer {
  const configured = process.env[name]?.trim();
  if (!configured || !path.isAbsolute(configured)) throw new Error(`${name} must name an absolute TLS file.`);
  const file = path.resolve(configured);
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > MAX_PEM_BYTES
    || realpathSync.native(file) !== file) {
    throw new Error(`${name} must name a regular, bounded TLS file.`);
  }
  return readFileSync(file);
}

export function internalTlsServerOptions(certName: string, keyName: string): https.ServerOptions {
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
