import { promises as fs } from 'fs';
import path from 'path';

interface CrashCounter {
  count: number;
  lastCrash: number;
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

export async function checkCrashLoopFiles(
  stateDirectory: string,
  now = Date.now(),
  maximumCrashes = 3,
  windowMs = 5 * 60_000
): Promise<CrashCounter> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Crash-guard timestamp is invalid.');
  if (!Number.isSafeInteger(maximumCrashes) || maximumCrashes < 2) throw new Error('maximumCrashes must be at least 2.');
  if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) throw new Error('Crash-guard window must be at least one second.');
  await fs.mkdir(stateDirectory, { recursive: true });
  const activeFile = path.join(stateDirectory, '.routing_active');
  const counterFile = path.join(stateDirectory, '.crash_counter');
  const blockFile = path.join(stateDirectory, '.crash_blocked');

  try {
    const block = validCounter(JSON.parse(await fs.readFile(blockFile, 'utf8')));
    throw new CrashLoopBlockedError(Math.max(block.count, maximumCrashes), blockFile);
  } catch (error: any) {
    if (error instanceof CrashLoopBlockedError) throw error;
    if (error.code !== 'ENOENT') {
      throw new Error(`Crash-loop block file cannot be read safely: ${error.message}`, { cause: error });
    }
  }

  const routingWasActive = await fs.stat(activeFile).then(() => true).catch((error: any) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!routingWasActive) {
    const reset = { count: 0, lastCrash: 0 };
    await fs.writeFile(counterFile, JSON.stringify(reset), 'utf8');
    return reset;
  }

  let previous: CrashCounter = { count: 0, lastCrash: 0 };
  try {
    previous = validCounter(JSON.parse(await fs.readFile(counterFile, 'utf8')));
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Crash counter cannot be read safely: ${error.message}`, { cause: error });
    }
  }
  const counter = {
    count: now - previous.lastCrash < windowMs ? previous.count + 1 : 1,
    lastCrash: now
  };
  await fs.writeFile(counterFile, JSON.stringify(counter), 'utf8');
  if (counter.count >= maximumCrashes) {
    await fs.writeFile(blockFile, JSON.stringify(counter), { encoding: 'utf8', flag: 'wx' }).catch((error: any) => {
      if (error.code !== 'EEXIST') throw error;
    });
    throw new CrashLoopBlockedError(counter.count, blockFile);
  }
  return counter;
}
