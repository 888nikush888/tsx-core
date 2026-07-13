import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  readConfig,
  readConfigSync,
  writeConfig,
  writeConfigSync
} from '../src/config.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'forwarder-config-'));

try {
  const syncPath = path.join(root, 'sync.json');
  const syncConfig = structuredClone(DEFAULT_CONFIG);
  syncConfig.apiId = 12345;
  syncConfig.apiHash = 'must-not-be-persisted';
  writeConfigSync(syncConfig, syncPath);

  const savedSync = JSON.parse(await readFile(syncPath, 'utf8'));
  assert.equal(savedSync.apiId, 12345);
  assert.equal(savedSync.apiHash, undefined);
  assert.equal(readConfigSync(syncPath).apiId, 12345);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);

  const asyncPath = path.join(root, 'async.json');
  const asyncConfig = structuredClone(DEFAULT_CONFIG);
  asyncConfig.targetChannel = '@valid_target';
  await writeConfig(asyncConfig, asyncPath);
  assert.equal((await readConfig(asyncPath)).targetChannel, '@valid_target');

  const missingPath = path.join(root, 'created-on-read.json');
  assert.deepEqual(readConfigSync(missingPath).sourceChannels, []);
  assert.equal(JSON.parse(await readFile(missingPath, 'utf8')).apiId, 0);

  const malformedPath = path.join(root, 'malformed.json');
  await writeFile(malformedPath, '{not-json', 'utf8');
  assert.throws(() => readConfigSync(malformedPath), /Failed to read configuration/);
  assert.equal(await readFile(malformedPath, 'utf8'), '{not-json');

  const unwritablePath = path.join(root, 'missing-directory', 'config.json');
  assert.throws(() => writeConfigSync(DEFAULT_CONFIG, unwritablePath));
  await assert.rejects(() => writeConfig(DEFAULT_CONFIG, unwritablePath));

  console.log('ALL ATOMIC CONFIGURATION TESTS PASSED!');
} finally {
  await rm(root, { recursive: true, force: true });
}
