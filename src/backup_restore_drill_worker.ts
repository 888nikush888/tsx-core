import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

function deny(): never { throw new Error('Network and subprocess APIs are disabled in the isolated restore drill.'); }

function denyExternalWork(): void {
  const denyPromisified = Object.assign(deny, { __promisify__: deny });
  net.Socket.prototype.connect = deny;
  net.Server.prototype.listen = deny;
  net.connect = deny; net.createConnection = deny;
  tls.connect = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  dgram.createSocket = deny; dns.lookup = denyPromisified; dns.resolve = denyPromisified;
  dns.promises.lookup = deny; dns.promises.resolve = deny;
  childProcess.spawn = deny; childProcess.spawnSync = deny; childProcess.exec = denyPromisified;
  childProcess.execSync = deny; childProcess.execFile = denyPromisified; childProcess.execFileSync = deny; childProcess.fork = deny;
  globalThis.fetch = deny;
  (globalThis as any).WebSocket = deny;
  syncBuiltinESMExports();
  for (const action of [() => net.connect(1, '127.0.0.1'), () => globalThis.fetch('http://127.0.0.1:1'),
    () => dns.lookup('localhost', () => {}), () => childProcess.spawn(process.execPath, ['--version'])]) {
    let blocked = false;
    try { action(); } catch (error) { blocked = error instanceof Error && error.message.includes('APIs are disabled'); }
    if (!blocked) throw new Error('Restore drill API isolation self-check failed.');
  }
}

async function checkRestoredFiles(root: string, artifact: string, files: Record<string, { sha256: string }>): Promise<void> {
  for (const [member, expected] of Object.entries(files)) {
    if (member === 'forwarder.db') continue; // DB is intentionally changed to disable execution.
    const bytes = await fs.readFile(path.join(root, member));
    if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new Error('Restored drill resource differs from the verified artifact.');
  }
  // No secret/session material is loaded or re-provisioned, and no entry point is imported.
  if (path.resolve(root) === path.resolve(artifact)) throw new Error('Restore drill must never target its source artifact.');
}

async function perform(): Promise<void> {
  denyExternalWork();
  const [artifact, directory, nonce, expected] = process.argv.slice(2);
  if (!directory || /^[\\/]{2}/.test(directory) || path.basename(directory) !== 'restored'
    || !path.basename(path.dirname(directory)).startsWith('tsx-restore-drill-')) throw new Error('Invalid local drill scope.');
  const root = await fs.realpath(directory);
  if (root !== directory || (await fs.readdir(root)).length !== 0) throw new Error('Restore drill requires its own empty real temporary directory.');
  const { inspectBackupArtifact, restoreBackupArtifact, verifyBackupArtifact, verifySqliteDatabase } = await import('./backup.js');
  const { requireRestoreEligibility } = await import('./backup_evidence.js');
  const { acquireProcessLock } = await import('./process_lock.js');
  const { beginMcpOfflineMaintenance } = await import('./mcp_maintenance.js');
  const { reenrollConfigurationGeneration } = await import('./backup_generation.js');
  const evidence = await inspectBackupArtifact(artifact);
  if (evidence.artifactSha256 !== expected) throw new Error('Drill artifact SHA changed before restore.');
  requireRestoreEligibility(evidence.restoreEligibility);
  const sources = { databasePath: path.join(root, 'forwarder.db'), configurationPath: path.join(root, 'config.json'),
    runtimeSettingsPath: path.join(root, 'runtime-settings.json'), templatesDirectory: path.join(root, 'templates') };
  const owner = await acquireProcessLock(path.join(root, '.process_active'));
  let lease;
  try {
    lease = await beginMcpOfflineMaintenance('isolated restore drill', sources.databasePath, owner);
    await lease.waitForQuiescence();
    await restoreBackupArtifact(artifact, sources.databasePath, sources.configurationPath, root, {
      maintenanceLease: lease, runtimeSettingsPath: sources.runtimeSettingsPath, templatesDirectory: sources.templatesDirectory,
    });
    await lease.release();
    lease = await beginMcpOfflineMaintenance('isolated restored generation', sources.databasePath, owner);
    await lease.waitForQuiescence();
    await reenrollConfigurationGeneration(sources, owner, lease);
    await verifySqliteDatabase(sources.databasePath);
    const manifest = await verifyBackupArtifact(artifact);
    await checkRestoredFiles(root, artifact, manifest.files);
    await verifyDisabledRuntime(sources.databasePath);
    process.stdout.write(`${JSON.stringify({ nonce, proof: { performedAt: Date.now(), artifactSha256: expected, artifactCreatedAt: evidence.artifactCreatedAt,
      isolation: 'temporary-child-network-apis-disabled', osSandbox: false, runtimeDisabled: true } })}\n`);
  } finally { try { await lease?.release(); } finally { await owner.release(); } }
}

async function verifyDisabledRuntime(databasePath: string): Promise<void> {
  const { open } = await import('sqlite');
  const { default: sqlite3 } = await import('sqlite3');
  // This private drill file is never opened by the application/runtime or any other process.
  const database = await open({ filename: databasePath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try {
    const state = await database.get('SELECT execution_enabled, live_trading_enabled, kill_switch_active FROM trading_runtime_state WHERE singleton_id = 1');
    if (state?.execution_enabled !== 0 || state?.live_trading_enabled !== 0 || state?.kill_switch_active !== 1) throw new Error('Restored drill runtime was not disabled.');
  } finally { await database.close(); }
}

try { await perform(); }
catch (error) { console.error(error instanceof Error ? error.message : 'Isolated restore drill failed.'); process.exitCode = 1; }
