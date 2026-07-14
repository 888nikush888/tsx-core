import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

interface CrashCounter {
  count: number;
  lastCrash: number;
}

interface CrashGuardPaths {
  activeFile: string;
  counterFile: string;
  blockFile: string;
}

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 1_000;

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
    await fs.stat(filePath);
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readCounter(filePath: string, label: string): Promise<CrashCounter | null> {
  try {
    return validCounter(JSON.parse(await fs.readFile(filePath, 'utf8')));
  } catch (error: any) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${label} cannot be read safely: ${error.message}`, { cause: error });
  }
}

async function writeCrashBlock(blockFile: string, counter: CrashCounter): Promise<void> {
  await fs.writeFile(blockFile, JSON.stringify(counter), { encoding: 'utf8', flag: 'wx' });
}

async function writeCounter(counterFile: string, counter: CrashCounter): Promise<void> {
  const temporaryFile = `${counterFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryFile, JSON.stringify(counter), { encoding: 'utf8', flag: 'wx' });
  try {
    await fs.rename(temporaryFile, counterFile);
  } finally {
    await fs.rm(temporaryFile, { force: true });
  }
}

async function acquireCrashGuardLock(lockFile: string): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return await fs.open(lockFile, 'wx');
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Crash-guard lock '${lockFile}' is still held; startup is blocked to protect state integrity.`, { cause: error });
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
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
  now = Date.now(),
  maximumCrashes = 3,
  windowMs = 5 * 60_000
): Promise<CrashCounter> {
  validateCrashGuardOptions(now, maximumCrashes, windowMs);
  await fs.mkdir(stateDirectory, { recursive: true });
  const paths = {
    activeFile: path.join(stateDirectory, '.routing_active'),
    counterFile: path.join(stateDirectory, '.crash_counter'),
    blockFile: path.join(stateDirectory, '.crash_blocked')
  };
  const lockFile = path.join(stateDirectory, '.crash_guard.lock');
  const lock = await acquireCrashGuardLock(lockFile);
  try {
    return await checkCrashLoopState(paths, now, maximumCrashes, windowMs);
  } finally {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}
