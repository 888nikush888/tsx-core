import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { withProcessLockOwner, type ProcessLock } from './process_lock.js';

interface CrashCounter {
  count: number;
  lastCrash: number;
}

interface CrashGuardPaths {
  activeFile: string;
  counterFile: string;
  blockFile: string;
}

export class CrashLoopBlockedError extends Error {
  constructor(public readonly count: number, public readonly blockFile: string) {
    super(`Crash-loop guard blocked automatic routing after ${count} rapid crashes. Remove '${blockFile}' and '.routing_active' only after correcting the cause.`);
    this.name = 'CrashLoopBlockedError';
  }
}

function validCounter(value: any): CrashCounter {
  const count = Number(value?.count);
  const lastCrash = Number(value?.lastCrash);
  return {
    count: Number.isSafeInteger(count) && count >= 0 ? count : 0,
    lastCrash: Number.isSafeInteger(lastCrash) && lastCrash >= 0 ? lastCrash : 0
  };
}

function validateCrashGuardOptions(now: number, maximumCrashes: number, windowMs: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Crash-guard timestamp is invalid.');
  if (!Number.isSafeInteger(maximumCrashes) || maximumCrashes < 2) {
    throw new Error('maximumCrashes must be at least 2.');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) {
    throw new Error('Crash-guard window must be at least one second.');
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readCounter(filePath: string, label: string): Promise<CrashCounter | null> {
  try {
    await assertRegularFile(filePath);
    return validCounter(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error: any) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${label} cannot be read safely: ${error.message}`, { cause: error });
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  const metadata = await fs.lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Crash-guard path '${filePath}' is not a regular, non-symlink file.`);
}

async function writeCrashBlock(blockFile: string, counter: CrashCounter): Promise<void> {
  await fs.writeFile(blockFile, JSON.stringify(counter), { encoding: 'utf8', flag: 'wx' });
}

async function writeCounter(counterFile: string, counter: CrashCounter): Promise<void> {
  if (await pathExists(counterFile)) await assertRegularFile(counterFile);
  const temporaryFile = `${counterFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(counter), { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporaryFile, counterFile);
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }
}

async function checkCrashLoopState(
  paths: CrashGuardPaths,
  now: number,
  maximumCrashes: number,
  windowMs: number
): Promise<CrashCounter> {
  const block = await readCounter(paths.blockFile, 'Crash-loop block file');
  if (block) {
    throw new CrashLoopBlockedError(Math.max(block.count, maximumCrashes), paths.blockFile);
  }
  const routingWasActive = await pathExists(paths.activeFile);
  if (routingWasActive) await assertRegularFile(paths.activeFile);
  if (!routingWasActive) {
    const reset = { count: 0, lastCrash: 0 };
    await writeCounter(paths.counterFile, reset);
    return reset;
  }

  const previous = (await readCounter(paths.counterFile, 'Crash counter')) ?? { count: 0, lastCrash: 0 };
  const counter = {
    count: now - previous.lastCrash < windowMs ? previous.count + 1 : 1,
    lastCrash: now
  };
  await writeCounter(paths.counterFile, counter);
  if (counter.count >= maximumCrashes) {
    await writeCrashBlock(paths.blockFile, counter);
    throw new CrashLoopBlockedError(counter.count, paths.blockFile);
  }
  return counter;
}

export async function checkCrashLoopFiles(
  stateDirectory: string,
  owner: ProcessLock,
  now = Date.now(),
  maximumCrashes = 3,
  windowMs = 5 * 60_000
): Promise<CrashCounter> {
  validateCrashGuardOptions(now, maximumCrashes, windowMs);
  return withProcessLockOwner(owner, stateDirectory, async directory => {
    const legacyLock = path.join(directory, '.crash_guard.lock');
    if (await pathExists(legacyLock)) {
      throw new Error(`Legacy crash-guard lock '${legacyLock}' requires explicit offline version-transition review; startup is blocked to protect state integrity. The lock, crash counter and crash block were not removed.`);
    }
    return checkCrashLoopState({ activeFile: path.join(directory, '.routing_active'),
      counterFile: path.join(directory, '.crash_counter'), blockFile: path.join(directory, '.crash_blocked') }, now, maximumCrashes, windowMs);
  });
}
