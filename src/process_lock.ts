import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constantTimeStringEqual } from './secure_compare.js';

interface LockPayload {
  pid: number;
  startedAt: string;
  token: string;
}

export interface ProcessLock {
  readonly path: string;
  release: () => Promise<void>;
}

interface ProcessOwnership {
  path: string;
  payload: LockPayload;
  released: boolean;
  tail: Promise<void>;
}

const issuedOwnership = new WeakMap<ProcessLock, ProcessOwnership>();

function ownershipOf(owner: ProcessLock): ProcessOwnership {
  const ownership = issuedOwnership.get(owner);
  if (!ownership) throw new Error('Process-lock ownership capability is missing or foreign; startup is blocked.');
  if (ownership.released) throw new Error('Process-lock ownership capability was released; startup is blocked.');
  return ownership;
}

/** Verifies a real issued capability, the current token, and optionally the exact counter scope. */
export async function assertProcessLockOwner(owner: ProcessLock, stateDirectory?: string): Promise<void> {
  const ownership = ownershipOf(owner);
  if (stateDirectory !== undefined) {
    const directory = await fs.realpath(path.resolve(stateDirectory));
    if (ownership.path !== path.join(directory, '.process_active')) {
      throw new Error('Crash-guard state directory and process-lock ownership have different realpath scopes; startup is blocked. No counter migration was performed.');
    }
  }
  const metadata = await fs.lstat(ownership.path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Process-lock ownership path is not a regular, non-symlink file.');
  const existing = await readPayload(ownership.path);
  if (existing.pid !== process.pid || existing.startedAt !== ownership.payload.startedAt
    || !constantTimeStringEqual(existing.token, ownership.payload.token)) {
    throw new Error('Process-lock ownership changed; refusing access to another process scope.');
  }
}

async function ownershipTurn<T>(owner: ProcessLock, action: () => Promise<T>): Promise<T> {
  const ownership = ownershipOf(owner);
  const attempt = ownership.tail.then(action);
  ownership.tail = attempt.then(() => undefined, () => undefined);
  return attempt;
}

/** Counter operations and owner release share one queue; a released owner cannot authorize later work. */
export async function withProcessLockOwner<T>(owner: ProcessLock, stateDirectory: string, action: (directory: string) => Promise<T>): Promise<T> {
  return ownershipTurn(owner, async () => {
    const directory = await fs.realpath(path.resolve(stateDirectory));
    await assertProcessLockOwner(owner, directory);
    try {
      return await action(directory);
    } finally {
      await assertProcessLockOwner(owner, directory);
    }
  });
}

export class ProcessLockActiveError extends Error {
  constructor(lockPath: string, pid: number) {
    super(`Process lock '${lockPath}' is already active (pid ${pid}).`);
    this.name = 'ProcessLockActiveError';
  }
}

export class ProcessLockRecoveryRequiredError extends Error {
  constructor(lockPath: string, pid: number) {
    super(`Process lock '${lockPath}' belongs to absent pid ${pid}. Exclusive stale-lock removal cannot be proved atomically; startup is blocked and the file is preserved. Stop all participants and review recovery of this exact lock file; do not remove crash counters or crash blocks.`);
    this.name = 'ProcessLockRecoveryRequiredError';
  }
}

function isValidPayload(value: unknown): value is LockPayload {
  return Boolean(
    value && typeof value === 'object'
    && Number.isSafeInteger((value as LockPayload).pid) && (value as LockPayload).pid > 0
    && typeof (value as LockPayload).startedAt === 'string'
    && typeof (value as LockPayload).token === 'string' && (value as LockPayload).token.length >= 16
  );
}

async function readPayload(lockPath: string): Promise<LockPayload> {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    if (!isValidPayload(parsed)) throw new Error('invalid lock payload');
    return parsed;
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw error;
    throw new Error(`Process lock '${lockPath}' cannot be interpreted safely; refusing startup.`, { cause: error });
  }
}

function processIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
  let existing: LockPayload;
  try {
    existing = await readPayload(lockPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!constantTimeStringEqual(token, existing.token)) {
    throw new Error(`Process lock '${lockPath}' ownership changed; refusing to remove another process lock.`);
  }
  await fs.unlink(lockPath);
}

async function createProcessLock(lockPath: string, payload: LockPayload): Promise<ProcessLock> {
  const handle = await fs.open(lockPath, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(payload), 'utf8');
  } finally {
    await handle.close();
  }
  const owner: ProcessLock = Object.freeze({
    path: lockPath,
    release: async () => {
      const ownership = issuedOwnership.get(owner)!;
      if (ownership.released) return;
      await ownershipTurn(owner, async () => {
        if (ownership.released) return;
        await assertProcessLockOwner(owner);
        await releaseOwnedLock(lockPath, payload.token);
        ownership.released = true;
      });
    },
  });
  issuedOwnership.set(owner, { path: lockPath, payload, released: false, tail: Promise.resolve() });
  return owner;
}

async function handleLockCollision(lockPath: string, error: any): Promise<void> {
  if (error?.code !== 'EEXIST') throw error;
  const existing = await readPayload(lockPath);
  if (processIsActive(existing.pid)) throw new ProcessLockActiveError(lockPath, existing.pid);
  // A read-then-rename/unlink would race a second starter and could delete its
  // newly acquired live lock. File age or PID reuse heuristics cannot fix that.
  throw new ProcessLockRecoveryRequiredError(lockPath, existing.pid);
}

/** Acquires a filesystem lock; stale or ambiguous owners require explicit reviewed recovery. */
export async function acquireProcessLock(lockPath: string): Promise<ProcessLock> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  lockPath = path.join(await fs.realpath(path.dirname(path.resolve(lockPath))), path.basename(lockPath));
  const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() };

  try {
    return await createProcessLock(lockPath, payload);
  } catch (error: any) {
    await handleLockCollision(lockPath, error);
    throw error;
  }
}
