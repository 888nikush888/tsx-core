import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for asynchronous log write.');
}

const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-logger-'));
const previousLogDirectory = process.env.LOG_DIR;
const previousJsonLogging = process.env.JSON_LOGGING;
const originalLog = console.log;
const originalError = console.error;

try {
  const directory = path.join(root, 'logs');
  process.env.LOG_DIR = directory;
  const logger = await import(`../src/logger.js?file-test=${Date.now()}`);
  await writeFile(path.join(root, 'placeholder'), 'x');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(directory, { recursive: true }));
  await writeFile(path.join(directory, '2000-01-01.log'), 'expired');
  await writeFile(path.join(directory, 'keep.txt'), 'not a log');
  await logger.initFileLogger();
  await assert.rejects(access(path.join(directory, '2000-01-01.log')));
  await access(path.join(directory, 'keep.txt'));

  const output = [];
  console.log = value => output.push(String(value));
  process.env.JSON_LOGGING = 'true';
  logger.clearLogHistory();
  for (let index = 0; index < 35; index++) {
    logger.addLog(`[WARN] event ${index} for +49 170 1234567`, {
      correlation_id: `event-${index}`,
      invalid_key_with_more_than_sixty_four_characters_xxxxxxxxxxxxxxxxxxxxxxxxx: 'drop',
      omitted: undefined,
      active: true,
      optional: null,
    });
  }
  const files = (await readdir(directory)).filter(file => file.endsWith('.log'));
  assert.equal(files.length, 1);
  await waitFor(async () => (await readFile(path.join(directory, files[0]), 'utf8')).includes('event 34'));
  const persisted = await readFile(path.join(directory, files[0]), 'utf8');
  assert.equal(persisted.includes('+49 170'), false, 'Persistent logs must mask phone numbers');
  assert.equal(output.length, 35);
  assert.equal(JSON.parse(output[0]).level, 'WARN');
  const history = logger.getLogHistory();
  assert.equal(history.length, 35);
  assert.equal(history.some(line => line.includes('event 0 ')), true);
  assert.equal(history.at(-1).includes('event 34'), true);
  history.length = 0;
  assert.equal(logger.getLogHistory().length, 35, 'History getter must return a defensive copy');
  const firstPage = logger.getLogEntries(0, 10);
  assert.equal(firstPage.entries.length, 10);
  assert.equal(firstPage.entries.at(-1).line.includes('event 34'), true);
  assert.equal(logger.getLogEntries(firstPage.nextCursor, 10).entries.length, 0);
  logger.clearLogHistory();
  assert.deepEqual(logger.getLogHistory(), []);

  const levels = [
    ['[FATAL] x', 'FATAL'],
    ['[FEHLER] x', 'ERROR'],
    ['[DEBUG] x', 'DEBUG'],
    ['plain', 'INFO'],
  ];
  for (const [message, expected] of levels) {
    assert.equal(logger.buildStructuredLogEntry(new Date().toISOString(), message).level, expected);
  }
  assert.equal(logger.maskPII(42), 42);

  const blocked = path.join(root, 'blocked');
  await writeFile(blocked, 'not a directory');
  process.env.LOG_DIR = blocked;
  const initializationErrors = [];
  console.error = value => initializationErrors.push(String(value));
  const failingLogger = await import(`../src/logger.js?failure-test=${Date.now()}`);
  await failingLogger.initFileLogger();
  assert.equal(initializationErrors.some(line => line.includes('initialization failed')), true);
  failingLogger.addLog('[INFO] memory logging remains available');

  console.log('File logger retention and persistence tests passed.');
} finally {
  console.log = originalLog;
  console.error = originalError;
  if (previousLogDirectory === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = previousLogDirectory;
  if (previousJsonLogging === undefined) delete process.env.JSON_LOGGING;
  else process.env.JSON_LOGGING = previousJsonLogging;
  await rm(root, { recursive: true, force: true });
}
