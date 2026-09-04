import { promises as fs } from 'node:fs';
import path from 'node:path';
import { acquireProcessLock } from '../../src/process_lock.js';
import { checkCrashLoopFiles } from '../../src/crash_guard.js';

const directory = path.resolve(process.argv[2]);
const mode = process.argv[3];
const forever = () => new Promise(() => {});
const keepAlive = setInterval(() => {}, 1000);

try {
  const owner = await acquireProcessLock(path.join(directory, '.process_active'));
  if (mode === 'hold') {
    process.send({ state: 'owned' });
  } else {
    const rename = fs.rename;
    const writeFile = fs.writeFile;
    if (mode === 'counter-paused') {
      fs.rename = async (source, target) => {
        if (target === path.join(directory, '.crash_counter')) {
          process.send({ state: 'counter-paused' });
          await forever();
        }
        return rename(source, target);
      };
    }
    if (mode === 'block-paused') {
      fs.writeFile = async (...args) => {
        const result = await writeFile(...args);
        if (args[0] === path.join(directory, '.crash_blocked')) {
          process.send({ state: 'block-paused' });
          await forever();
        }
        return result;
      };
    }
    await checkCrashLoopFiles(directory, owner, 123001);
    throw new Error('Fixture unexpectedly passed its requested hard-crash boundary.');
  }
} catch (error) {
  clearInterval(keepAlive);
  process.send({ state: 'rejected', name: error.name, message: error.message }, () => process.disconnect());
  process.exitCode = 1;
}
