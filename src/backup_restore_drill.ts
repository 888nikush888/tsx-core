import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { boundedBackupManifestBytes, type BackupRestoreDrillProof } from './backup_evidence.js';

function localPath(value: string): string {
  if (/^[\\/]{2}/.test(value)) throw new Error('Restore drills do not accept UNC/network paths.');
  return path.resolve(value);
}

async function manifestHash(artifact: string): Promise<string> {
  const destination = path.join(artifact, 'manifest.json');
  return createHash('sha256').update(await boundedBackupManifestBytes(destination)).digest('hex');
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, TEMP: path.dirname(root), TMP: path.dirname(root), TMPDIR: path.dirname(root), HOME: root, USERPROFILE: root,
    CONFIG_PATH: path.join(root, 'config.json'), FORWARDER_DB_PATH: path.join(root, 'forwarder.db'),
    RUNTIME_SETTINGS_PATH: path.join(root, 'runtime-settings.json'), TEMPLATES_DIR: path.join(root, 'templates') };
}

function workerArguments(artifact: string, root: string, nonce: string, expected: string): string[] {
  const extension = path.extname(fileURLToPath(import.meta.url));
  const worker = fileURLToPath(new URL(`./backup_restore_drill_worker${extension}`, import.meta.url));
  // Never inherit NODE_OPTIONS, arbitrary preload hooks, or a debugger port.
  const loader = extension === '.ts' ? ['--import', import.meta.resolve('tsx')] : [];
  return [...loader, worker, artifact, root, nonce, expected];
}

async function runWorker(artifact: string, root: string, nonce: string, expected: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, workerArguments(artifact, root, nonce, expected), {
      cwd: root, env: isolatedEnvironment(root), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let diagnostic = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('Isolated restore drill timed out.'); child.kill('SIGKILL'); }, 30_000);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      output += chunk;
      if (output.length > 16_384) { failure = new Error('Restore drill exceeded its result bound.'); child.kill('SIGKILL'); }
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`Isolated restore drill failed: ${diagnostic.trim() || `exit ${code}`}`)); return; }
      try { resolve(JSON.parse(output)); } catch (error) { reject(new Error('Restore drill did not return a valid receipt.', { cause: error })); }
    });
  });
}

function receipt(value: any, nonce: string, hash: string, started: number): BackupRestoreDrillProof {
  const proof = value?.proof;
  if (value?.nonce !== nonce || proof?.artifactSha256 !== hash || proof?.runtimeDisabled !== true
    || typeof proof.artifactCreatedAt !== 'string' || !Number.isFinite(Date.parse(proof.artifactCreatedAt))
    || proof.isolation !== 'temporary-child-network-apis-disabled' || proof.osSandbox !== false
    || !Number.isSafeInteger(proof.performedAt) || proof.performedAt < started || proof.performedAt > Date.now()) {
    throw new Error('Restore drill receipt does not match the performed isolated operation.');
  }
  return proof;
}

async function removeDrillDirectory(root: string, temporary: string): Promise<void> {
  if (path.dirname(root) !== temporary || !path.basename(root).startsWith('tsx-restore-drill-')) throw new Error('Restore drill cleanup scope changed.');
  await fs.rm(root, { recursive: true, force: true });
}

/** Explicit local rehearsal only. API denial is test isolation, not an OS security sandbox. */
export async function runIsolatedBackupRestoreDrill(artifactPath: string): Promise<BackupRestoreDrillProof> {
  const artifact = localPath(artifactPath);
  const expected = await manifestHash(artifact);
  const temporary = localPath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'tsx-restore-drill-'));
  const destination = path.join(root, 'restored');
  const nonce = randomUUID();
  const started = Date.now();
  try {
    await fs.mkdir(destination, { mode: 0o700 });
    const result = await runWorker(artifact, destination, nonce, expected);
    if (await manifestHash(artifact) !== expected) throw new Error('Backup artifact changed during the restore drill.');
    return receipt(result, nonce, expected, started);
  } finally {
    await removeDrillDirectory(root, temporary);
  }
}
