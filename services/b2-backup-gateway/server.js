import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { S3Client } from '@aws-sdk/client-s3';
import { createGateway, validateTemporaryRoot } from './gateway.js';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

const endpoint = required('B2_S3_ENDPOINT');
if (!/^https:\/\/s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(endpoint)) {
  throw new Error('B2_S3_ENDPOINT must be a regional Backblaze HTTPS endpoint.');
}
const region = required('B2_S3_REGION');
if (endpoint !== `https://s3.${region}.backblazeb2.com`) throw new Error('B2 endpoint and region disagree.');
const port = Number(process.env.BACKUP_GATEWAY_PORT || '8443');
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BACKUP_GATEWAY_PORT.');
const tempRoot = required('BACKUP_GATEWAY_TEMP_DIR');
await validateTemporaryRoot(tempRoot);

const client = new S3Client({
  region, endpoint, forcePathStyle: true, maxAttempts: 1,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: required('B2_APPLICATION_KEY_ID'),
    secretAccessKey: required('B2_APPLICATION_KEY')
  }
});
const handler = createGateway({
  client,
  bucket: required('B2_BUCKET'),
  prefix: process.env.B2_OBJECT_PREFIX || 'tsx-core/',
  bearerToken: required('BACKUP_OFFSITE_TOKEN'),
  tempRoot,
  maxObjectBytes: Number(process.env.BACKUP_GATEWAY_MAX_OBJECT_BYTES || '5000000000'),
  maxTemporaryBytes: Number(process.env.BACKUP_GATEWAY_TEMP_BUDGET_BYTES || '5000000000'),
  maxConcurrentOperations: Number(process.env.BACKUP_GATEWAY_MAX_CONCURRENT || '2')
});
const tls = {
  key: await readFile(required('BACKUP_GATEWAY_TLS_KEY_FILE')),
  cert: await readFile(required('BACKUP_GATEWAY_TLS_CERT_FILE')),
  minVersion: 'TLSv1.2'
};
https.createServer(tls, (request, response) => {
  handler(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(502).end();
    else response.destroy();
  });
}).listen(port, process.env.BACKUP_GATEWAY_BIND || '127.0.0.1');
