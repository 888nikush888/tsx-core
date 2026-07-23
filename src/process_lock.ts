import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

interface LockPayload {
  pid: number;
  startedAt: string;
  token: string;
}

export interface ProcessLock {
  path: string;
  release: () => Promise<void>;
}

export class ProcessLockActiveError extends Error {
  constructor(lockPath: string, pid: number) {
    super(`Process lock '${lockPath}' is already active (pid ${pid}).`);
    this.name = 'ProcessLockActiveError';
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

async function reapStaleLock(lockPath: string): Promise<void> {
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  await fs.rename(lockPath, stalePath);
  await fs.rm(stalePath, { force: true });
}

/** Acquires a filesystem lock, reaping only locks whose PID is definitely gone. */
export async function acquireProcessLock(lockPath: string): Promise<ProcessLock> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString(), token: randomUUID() };

  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(payload), 'utf8');
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        release: async () => {
          let existing: LockPayload;
          try {
            existing = await readPayload(lockPath);
          } catch (error: any) {
            if (error?.code === 'ENOENT') return;
            throw error;
          }
          if (existing.token !== payload.token) {
            throw new Error(`Process lock '${lockPath}' ownership changed; refusing to remove another process lock.`);
          }
          await fs.unlink(lockPath);
        }
      };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readPayload(lockPath);
      if (processIsActive(existing.pid)) throw new ProcessLockActiveError(lockPath, existing.pid);
      try {
        await reapStaleLock(lockPath);
      } catch (reapError: any) {
        if (reapError?.code !== 'ENOENT') throw reapError;
      }
    }
  }
}
